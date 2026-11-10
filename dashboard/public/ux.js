// Usabilidade: visão geral (tela inicial), paleta ⌘K, ajuda de atalhos, link direto
// por run (#run/<taskId>), teclas 1–6 para as abas e notificação do sistema opcional.
// Script clássico carregado por último; usa os globais do script principal e window.Views.
(() => {
  const IS_MAC = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
  const MOD = IS_MAC ? '⌘' : 'Ctrl';
  const VIEW_KEYS = [['runs', 'Runs'], ['quadro', 'Quadro'], ['tabela', 'Tabela'], ['timeline', 'Linha do tempo'], ['metricas', 'Relatório semanal'], ['tickets', 'Tickets e PRs']];
  const norm = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  const currentView = () => document.body.dataset.view || 'runs';
  // Resposta do watcher à sua mensagem (state.human_input_interpretations) vence a nota do
  // agente quando é mais recente e não destravou a task: é a pergunta que está esperando você.
  const lastNote = r => {
    const agent = [...(r.state?.agent_log || [])].reverse().find(a => a.note);
    const reply = (r.state?.human_input_interpretations || []).at(-1);
    if (reply?.reply && reply.action !== 'resume' && (!agent || (Date.parse(reply.at) || 0) >= (Date.parse(agent.at) || 0))) return `Watcher: ${reply.reply}`;
    return agent?.note || '';
  };
  const stageText = r => r.status === 'committed' ? 'Concluído'
    : r.node === 'escalated' ? 'Escalado para você'
      : r.node ? `${r.status === 'running' ? 'Próximo' : 'Parado em'}: ${NODE_LABEL[r.node] || r.node}` : STATUS[r.status] || '';

  // ------------------------------------------------------------------ link direto
  function route(taskId) {
    if (currentView() !== 'runs') return;
    const want = taskId ? `#run/${encodeURIComponent(taskId)}` : '';
    if (location.hash !== want) history.replaceState(null, '', want || location.pathname);
  }
  function runFromHash() {
    const m = location.hash.match(/^#run\/(.+)$/);
    return m ? decodeURIComponent(m[1]) : null;
  }
  // Na carga: o run do link vira a seleção preferida (setRuns abre quando os runs chegarem).
  const linked = runFromHash();
  if (linked) { prefs.selected = linked; persist(); }
  window.addEventListener('hashchange', () => {
    const id = runFromHash();
    if (id && id !== selected) Views.openRun(id);
  });

  // ------------------------------------------------------------------ visão geral
  function overview() {
    const list = [...runs.values()].filter(r => !isHidden(r));
    if (!runs.size) {
      return `<div class="overview"><header class="ov-head"><h1>Visão geral</h1>
        <p>Carregando runs… Quando o watcher pegar um ticket, ele aparece aqui sozinho.</p></header></div>`;
    }
    const attn = list.filter(r => !isDone(r) && needsYou(r)).sort((a, b) => (Date.parse(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0));
    const moving = list.filter(r => !isDone(r) && !needsYou(r) && r.status === 'running').sort((a, b) => (Date.parse(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0));
    const planned = list.filter(r => !isDone(r) && !needsYou(r) && r.status !== 'running').length;
    const done = list.filter(isDone).length;

    const events = [];
    for (const r of list) {
      for (const a of r.state?.agent_log || []) {
        if (!Date.parse(a.at)) continue;
        const nodes = (a.nodes || []).map(n => NODE_LABEL[n] || n);
        events.push({ at: a.at, r, text: nodes.length ? `Agente rodou ${nodes.join(' e ')}` : 'Agente registrou uma nota', note: a.note });
      }
      for (const h of r.state?.human_inputs || []) {
        if (Date.parse(h.timestamp)) events.push({ at: h.timestamp, r, text: 'O agente leu sua mensagem', note: String(h.content || '').replace(/^## Human input — \S+\s*/gm, '').trim(), human: true });
      }
      for (const i of r.state?.human_input_interpretations || []) {
        if (Date.parse(i.at)) events.push({ at: i.at, r, text: i.action === 'resume' ? 'O watcher entendeu sua mensagem e retomou o run' : 'O watcher não retomou: precisa de uma resposta sua', note: i.reply, human: true });
      }
    }
    events.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));

    const headline = attn.length
      ? `${attn.length} run${attn.length > 1 ? 's estão parados' : ' está parado'} esperando uma resposta sua.`
      : moving.length ? 'Nada esperando por você. Os runs em andamento seguem sozinhos.' : 'Nada esperando por você agora.';
    const titleHtml = r => { const t = titleOf(r); return `${t.num ? `<span class="ov-num">${esc(t.num)}</span> ` : ''}${esc(t.text)}`; };

    const attnHtml = attn.map(r => {
      const note = lastNote(r);
      return `<article class="ov-card">
        <div class="ov-card-top">${stateGlyph(r.status)}<span class="ov-stage">${esc(stageText(r))}</span>
          <span class="ov-when" title="${esc(when(r.updatedAt))}">${esc(ago(r.updatedAt))}</span></div>
        <h3>${titleHtml(r)}</h3>
        ${note ? `<p class="ov-note">${esc(note)}</p>` : '<p class="ov-note muted">O agente não deixou nota explicando o bloqueio. Veja o contexto do run.</p>'}
        <div class="ov-actions">
          <button class="send" type="button" data-ov-reply="${esc(r.taskId)}">Responder ao agente</button>
          <button class="ghost-btn" type="button" data-ov-open="${esc(r.taskId)}">Abrir run</button>
        </div>
      </article>`;
    }).join('');

    const feed = events.slice(0, 12).map(e => `
      <li><button type="button" class="ov-feed-item" data-ov-open="${esc(e.r.taskId)}">
        <span class="ov-dot ${e.human ? 'human' : ''}"></span>
        <span class="ov-feed-main"><span class="ov-feed-text">${esc(e.text)}</span><span class="ov-feed-run">${titleHtml(e.r)}</span>
          ${e.note ? `<span class="ov-feed-note">${esc(e.note)}</span>` : ''}</span>
        <span class="ov-when" title="${esc(when(e.at))}">${esc(ago(e.at))}</span>
      </button></li>`).join('');

    const movingHtml = moving.map(r => `
      <li><button type="button" class="ov-row" data-ov-open="${esc(r.taskId)}">
        <span class="ov-row-main"><span class="ov-row-title">${titleHtml(r)}</span>
          <span class="ov-row-sub">${miniRail(r)}<span>${esc(stageText(r))}</span></span></span>
        <span class="ov-when" title="${esc(when(r.updatedAt))}">${esc(ago(r.updatedAt))}</span>
      </button></li>`).join('');

    return `<div class="overview">
      <header class="ov-head">
        <h1>Visão geral</h1>
        <p>${esc(headline)}</p>
        <div class="kpis ov-counts" role="list" aria-label="Runs por estado">
          <div class="kpi ${attn.length ? 'attn' : ''}" role="listitem"><span class="kpi-label"><span class="g-dot waiting" aria-hidden="true"></span>Precisam de você</span><span class="kpi-value">${attn.length}</span></div>
          <div class="kpi" role="listitem"><span class="kpi-label"><span class="g-dot running" aria-hidden="true"></span>Em andamento</span><span class="kpi-value">${moving.length}</span></div>
          <div class="kpi" role="listitem"><span class="kpi-label"><span class="g-dot queued" aria-hidden="true"></span>Planejados e outros</span><span class="kpi-value">${planned}</span></div>
          <div class="kpi" role="listitem"><span class="kpi-label"><span class="g-dot done" aria-hidden="true"></span>Concluídos</span><span class="kpi-value">${done}</span></div>
        </div>
        <p class="source-note">Fonte: state.json de cada run em memory/runs, sem os removidos da lista.</p>
      </header>
      ${attn.length ? `<section class="ov-section"><h2>Precisa de você</h2><div class="ov-cards">${attnHtml}</div></section>` : ''}
      <div class="ov-grid">
        <section class="ov-section ov-panel"><h2>Atividade recente</h2>
          ${feed ? `<ul class="ov-feed">${feed}</ul>` : '<p class="muted">Nenhuma atividade registrada ainda.</p>'}</section>
        <section class="ov-section ov-panel"><h2>Em andamento</h2>
          ${movingHtml ? `<ul class="ov-list">${movingHtml}</ul>` : '<p class="muted">Nenhum run andando agora.</p>'}</section>
      </div>
      <p class="ov-tips"><kbd>${MOD} K</kbd> vai para qualquer run, ticket ou visão. <kbd>?</kbd> mostra todos os atalhos.</p>
    </div>`;
  }

  $('detail').addEventListener('click', e => {
    const reply = e.target.closest('[data-ov-reply]');
    if (reply) {
      Views.openRun(reply.dataset.ovReply);
      requestAnimationFrame(() => { const ta = $('message'); if (ta && !ta.disabled) { ta.focus(); ta.scrollIntoView({ block: 'center', behavior: 'smooth' }); } });
      return;
    }
    const open = e.target.closest('[data-ov-open]');
    if (open) Views.openRun(open.dataset.ovOpen);
  });

  // ------------------------------------------------------------------ overlays
  const layer = document.createElement('div');
  layer.className = 'overlay';
  layer.hidden = true;
  document.body.appendChild(layer);
  let overlayKind = null, lastFocus = null;
  function openOverlay(kind, html) {
    lastFocus = document.activeElement;
    overlayKind = kind;
    layer.innerHTML = `<div class="ov-backdrop" data-close></div>${html}`;
    layer.hidden = false;
  }
  function closeOverlay() {
    if (layer.hidden) return;
    layer.hidden = true; layer.innerHTML = ''; overlayKind = null;
    lastFocus?.focus?.();
  }
  layer.addEventListener('click', e => { if (e.target.closest('[data-close]')) closeOverlay(); });

  // ------------------------------------------------------------------ paleta ⌘K
  let palItems = [], palIndex = 0;
  function paletteEntries() {
    const out = [];
    for (const r of runs.values()) {
      const t = titleOf(r);
      out.push({
        group: 'Runs', label: `${t.num ? `${t.num} ` : ''}${t.text}`, sub: `${STATUS[r.status] || r.status}${isHidden(r) ? ' (removido da lista)' : ''} · ${stageText(r)}`,
        lamp: r.status, keywords: `${r.taskId} ${t.num} ${t.text}`, run: () => Views.openRun(r.taskId),
        rank: needsYou(r) ? 0 : isDone(r) ? 2 : 1,
      });
    }
    out.sort((a, b) => a.rank - b.rank);
    for (const [k, label] of VIEW_KEYS) out.push({ group: 'Visões', label: `Ir para ${label}`, sub: `tecla ${VIEW_KEYS.findIndex(v => v[0] === k) + 1}`, run: () => Views.setView(k) });
    const act = (label, sub, run) => out.push({ group: 'Ações', label, sub, run });
    act('Alternar tema claro/escuro', '', () => $('theme').click());
    act('Recolher todos os grupos', 'lista lateral', () => { Views.setView('runs'); GROUPS.forEach(g => setGroupOpen(g.key, false)); renderSidebar(); });
    act('Expandir todos os grupos', 'lista lateral', () => { Views.setView('runs'); GROUPS.forEach(g => setGroupOpen(g.key, true)); renderSidebar(); });
    act('Selecionar vários runs', 'para remover da lista', () => { Views.setView('runs'); setSelecting(true); });
    act('Consultar Redmine e Bitbucket', 'abre Tickets e PRs', () => Views.setView('tickets'));
    act(prefs.notify ? 'Desativar notificações' : 'Ativar notificações do sistema', 'quando um run parar esperando você', toggleNotify);
    act('Voltar para a visão geral', 'fecha o run aberto', () => { Views.setView('runs'); selected = null; prefs.selected = null; persist(); route(null); renderSidebar(); renderDetail(); });
    act('Atalhos de teclado', 'tecla ?', () => setTimeout(openHelp));
    return out;
  }
  function openPalette() {
    openOverlay('palette', `<div class="palette" role="dialog" aria-modal="true" aria-label="Ir para">
      <div class="pal-input"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true"><circle cx="11" cy="11" r="7" stroke="currentColor" stroke-width="2"/><path d="m20 20-3.5-3.5" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
        <input id="palQ" type="text" placeholder="Buscar run, ticket, visão ou ação" autocomplete="off" role="combobox" aria-expanded="true" aria-controls="palList"></div>
      <ul id="palList" class="pal-list" role="listbox"></ul>
      <div class="pal-foot"><span><kbd>↑</kbd><kbd>↓</kbd> navegar</span><span><kbd>↵</kbd> abrir</span><span><kbd>esc</kbd> fechar</span></div>
    </div>`);
    const q = $('palQ');
    q.addEventListener('input', () => { palIndex = 0; renderPalette(); });
    q.addEventListener('keydown', e => {
      if (e.key === 'ArrowDown') { e.preventDefault(); palIndex = Math.min(palIndex + 1, palItems.length - 1); renderPalette(true); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); palIndex = Math.max(palIndex - 1, 0); renderPalette(true); }
      else if (e.key === 'Enter') { e.preventDefault(); runPal(palIndex); }
    });
    $('palList').addEventListener('click', e => { const li = e.target.closest('[data-i]'); if (li) runPal(Number(li.dataset.i)); });
    $('palList').addEventListener('mousemove', e => {
      const li = e.target.closest('[data-i]');
      if (li && Number(li.dataset.i) !== palIndex) { palIndex = Number(li.dataset.i); renderPalette(true, false); }
    });
    palIndex = 0; renderPalette();
    q.focus();
  }
  function renderPalette(keepList, scroll = true) {
    const q = norm($('palQ')?.value).split(/\s+/).filter(Boolean);
    const all = paletteEntries();
    palItems = (q.length ? all.filter(it => { const hay = norm(`${it.label} ${it.sub} ${it.keywords || ''} ${it.group}`); return q.every(t => hay.includes(t)); }) : all).slice(0, 60);
    let html = '', group = null;
    palItems.forEach((it, i) => {
      if (it.group !== group) { group = it.group; html += `<li class="pal-group" role="presentation">${esc(group)}</li>`; }
      html += `<li role="option" data-i="${i}" aria-selected="${i === palIndex}" class="pal-item">
        ${it.lamp ? stateGlyph(it.lamp) : '<span class="pal-icon"></span>'}
        <span class="pal-label">${esc(it.label)}</span><span class="pal-sub">${esc(it.sub || '')}</span></li>`;
    });
    $('palList').innerHTML = html || '<li class="pal-empty">Nada encontrado. Tente o número do ticket.</li>';
    if (scroll) $('palList').querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  }
  function runPal(i) {
    const it = palItems[i];
    if (!it) return;
    closeOverlay();
    it.run();
  }

  // ------------------------------------------------------------------ ajuda de atalhos
  function openHelp() {
    const row = (keys, what) => `<tr><td>${keys.map(k => `<kbd>${k}</kbd>`).join(' ')}</td><td>${what}</td></tr>`;
    openOverlay('help', `<div class="help" role="dialog" aria-modal="true" aria-labelledby="helpTitle">
      <header><h2 id="helpTitle">Atalhos de teclado</h2><button class="icon-btn" type="button" data-close aria-label="Fechar">✕</button></header>
      <table>
        ${row([MOD, 'K'], 'Ir para qualquer run, ticket, visão ou ação')}
        ${row(['/'], 'Filtrar a lista e as visões')}
        ${row(['1', '…', '6'], 'Trocar de aba (Runs, Quadro, Tabela, Linha do tempo, Relatório semanal, Tickets e PRs)')}
        ${row(['↑', '↓'], 'Trocar de run na lista (também j e k)')}
        ${row([MOD, '↵'], 'Enviar a mensagem ao agente')}
        ${row([MOD, 'clique'], 'Começar a selecionar vários runs')}
        ${row(['Shift', 'clique'], 'Selecionar um intervalo de runs')}
        ${row(['Delete'], 'Remover os runs selecionados da lista')}
        ${row(['Esc'], 'Fechar janela, limpar a busca ou cancelar a seleção')}
        ${row(['?'], 'Mostrar esta ajuda')}
      </table></div>`);
    layer.querySelector('.help button').focus();
  }

  // ------------------------------------------------------------------ notificações
  async function toggleNotify() {
    if (prefs.notify) { prefs.notify = false; persist(); syncBell(); toast('Notificações desativadas.'); return; }
    if (!('Notification' in window)) { toast('Este navegador não suporta notificações.'); return; }
    const perm = Notification.permission === 'granted' ? 'granted' : await Notification.requestPermission();
    if (perm !== 'granted') { toast('O navegador bloqueou as notificações. Libere nas configurações do site.'); return; }
    prefs.notify = true; persist(); syncBell();
    toast('Pronto: você recebe um aviso do sistema quando um run parar esperando você.');
  }
  function notifyNeedsYou(r) {
    if (!prefs.notify || !('Notification' in window) || Notification.permission !== 'granted' || !document.hidden) return;
    const t = titleOf(r);
    const n = new Notification(`${t.num || r.taskId} precisa de você`, { body: `${t.text}\n${lastNote(r).slice(0, 140)}`, tag: r.taskId });
    n.onclick = () => { window.focus(); Views.openRun(r.taskId); n.close(); };
  }
  function syncBell() {
    const b = $('bell');
    if (!b) return;
    b.setAttribute('aria-pressed', !!prefs.notify);
    b.title = prefs.notify ? 'Notificações ativas: clique para desativar' : 'Avisar quando um run parar esperando você';
  }

  // ------------------------------------------------------------------ topbar
  const right = document.querySelector('.topbar-right');
  right.insertAdjacentHTML('afterbegin', `
    <button id="cmdk" class="cmd-btn" type="button" title="Ir para… (${MOD} K)"><span>Ir para…</span><kbd>${MOD} K</kbd></button>`);
  $('theme').insertAdjacentHTML('beforebegin', `
    <button id="bell" class="icon-btn" type="button" aria-pressed="false" aria-label="Notificações">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M6 16V11a6 6 0 1 1 12 0v5l1.5 2h-15L6 16Z" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><path d="M10 20a2 2 0 0 0 4 0" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
    </button>
    <button id="helpBtn" class="icon-btn" type="button" title="Atalhos de teclado (?)" aria-label="Atalhos de teclado">?</button>`);
  $('cmdk').addEventListener('click', openPalette);
  $('bell').addEventListener('click', toggleNotify);
  $('helpBtn').addEventListener('click', openHelp);
  syncBell();

  // ------------------------------------------------------------------ teclado global
  document.addEventListener('keydown', e => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      overlayKind === 'palette' ? closeOverlay() : openPalette();
      return;
    }
    if (!layer.hidden) {
      if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); closeOverlay(); }
      return;
    }
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName);
    if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === '?') { e.preventDefault(); openHelp(); return; }
    const n = Number(e.key);
    // Tela com abas próprias nos dígitos (data-local-digits, ex.: Roteamento) trata 1–N ela mesma.
    if (document.activeElement?.closest?.('[data-local-digits]')) return;
    if (n >= 1 && n <= VIEW_KEYS.length && !selecting) { e.preventDefault(); Views.setView(VIEW_KEYS[n - 1][0]); }
  }, true);

  window.UX = { overview, route, notifyNeedsYou, openPalette, openHelp };
  if (!selected) renderDetail();
})();
