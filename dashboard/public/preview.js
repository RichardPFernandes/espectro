// Painel "Preview de Ambiente" no detalhe do run (scripts/preview-manager.js via
// /api/preview/:ticketId/*): builda os worktrees do ticket e sobe app-back (:8081) +
// app-front (:9000). Script clássico carregado depois do principal; usa os globais
// runs, selected, esc, api, toast, nearBottom, ticketIdOfRun e $.
//
// renderDetail() reescreve #detail com innerHTML a cada atualização do run, então o
// painel se remonta via MutationObserver; estado (status, log, fold aberto) vive aqui.
(() => {
  const MAX_LINES = 300;
  const BUILDING = ['building-mo-entity', 'building-app-core', 'building-app-back', 'starting-back', 'starting-front'];
  const CHIPS = [
    ['mo-entity', 'mo-entity', s => s['mo-entity']],
    ['app-core', 'app-core', s => s['app-core']],
    // Build e start do back num chip só: "app-back" pronto = Quarkus de pé.
    ['app-back', 'app-back', s => s['app-back'] === 'error' || s.back === 'error' ? 'error'
      : s.back === 'done' ? 'done' : s['app-back'] === 'running' || s.back === 'running' || s['app-back'] === 'done' ? 'running' : s['app-back']],
    ['front', 'front', s => s.front],
  ];
  const MARK = { done: '✓', running: '⟳', error: '✗', skipped: '–', pending: '–' };

  let key = null;          // ticket-id do preview do run aberto
  let st = null;           // último status (GET /status ou evento SSE phase)
  let busy = null;         // 'start' | 'stop' enquanto a chamada não volta
  let loadError = null;    // falha do GET /status antes de ter qualquer status
  let es = null;
  let lines = [];
  let lastSeq = 0;
  let instance = null;
  let showLog = true;      // toggle do log no estado running
  // Banco escolhido no select (rótulo de PREVIEW_DB_OPTIONS); lembrado por navegador.
  let dbChoice = null;
  try { dbChoice = localStorage.getItem('preview.db'); } catch {}
  // Status do PR (state.json.pr_status): override local até o state_update chegar.
  const prLocal = new Map(); // taskId → 'ready'
  let prBusy = false;
  let prError = null;
  const openKeys = new Set();
  // "Usar na minha máquina" (GET/POST /api/local-checkout*): { active, repos } e a ação em curso.
  let lc = null;
  let lcBusy = null;       // 'use' | 'restore'
  let lcError = null;      // último erro (conflito do git é longo demais pro toast)

  // Worktree do app-back = .claude/worktrees/<id>; run lido de um worktree usa o nome
  // dele (inclui os sem número de ticket), senão o ticket-id. location vem como
  // "worktree:<nome>" ou, em run arquivado, "worktree:<nome> (_archive)".
  function previewKey(r) {
    const wt = (r.location?.match(/^worktree:(\S+)/) || [])[1] || null;
    if (wt) return wt.replace(/-(mo-entity|app-core|app-front)$/, '');
    const tid = ticketIdOfRun(r);
    return tid ? String(tid) : r.taskId;
  }

  function dur(ms) {
    if (!(ms >= 0)) return '';
    const s = Math.floor(ms / 1000), m = Math.floor(s / 60), h = Math.floor(m / 60);
    if (h) return `${h}h ${String(m % 60).padStart(2, '0')}m`;
    return m ? `${m}m ${String(s % 60).padStart(2, '0')}s` : `${s}s`;
  }
  const hhmmss = iso => new Date(iso).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

  // ------------------------------------------------------------------ dados
  async function refresh() {
    if (!key) return;
    const k = key;
    try {
      const s = await api(`/api/preview/${encodeURIComponent(k)}/status`);
      if (k === key) { st = s; loadError = null; }
    } catch (e) {
      if (k === key) loadError = e.message;
    }
    try {
      const l = await api(`/api/local-checkout?ticket=${encodeURIComponent(k)}`);
      if (k === key) lc = l;
    } catch { /* sem a seção "minha máquina"; o preview segue */ }
    paint();
  }

  function connect() {
    es?.close();
    lines = []; lastSeq = 0;
    if (!key) return;
    const k = key;
    es = new EventSource(`/api/preview/${encodeURIComponent(k)}/log-stream`);
    es.addEventListener('hello', ev => {
      let h; try { h = JSON.parse(ev.data); } catch { return; }
      if (instance && h.instance !== instance) { lines = []; lastSeq = 0; renderLog(); }
      instance = h.instance;
    });
    es.addEventListener('log', ev => {
      let e; try { e = JSON.parse(ev.data); } catch { return; }
      if (k !== key || e.seq <= lastSeq) return;
      // Start novo zera o buffer no servidor: a primeira linha dele é "preview iniciado".
      if (/^\[preview\] preview iniciado/.test(e.text)) lines = [];
      lastSeq = e.seq;
      lines.push(e);
      if (lines.length > MAX_LINES) lines.splice(0, lines.length - MAX_LINES);
      appendLine(e);
    });
    es.addEventListener('phase', ev => {
      let s; try { s = JSON.parse(ev.data); } catch { return; }
      if (k !== key) return;
      const was = st?.phase;
      st = s;
      paint();
      if (was && was !== 'running' && s.phase === 'running') toast(`Preview ${k} no ar — back :${s.ports.back}`);
    });
  }

  async function act(action) {
    if (!key) return;
    const k = key;
    if (action === 'clean' && !confirm(`Apagar o cache do build de ${k}?\n\n• target/ dos worktrees (e .tmp do front)\n• mo-entity/app-core instalados no ~/.m2 pelo preview — o checkout principal volta a baixar do repositório remoto`)) return;
    busy = action; paint();
    try {
      const opts = { method: 'POST' };
      if (action === 'start') {
        const db = selectedDb();
        opts.headers = { 'Content-Type': 'application/json' };
        opts.body = JSON.stringify({ db: db?.key ?? null });
      }
      const s = await api(`/api/preview/${encodeURIComponent(k)}/${action}`, opts);
      if (k === key) st = s;
      if (action === 'start') { showLog = true; openKeys.add(k); }
      if (action === 'clean') toast(s.removed?.length ? `Cache de ${k} limpo (${s.removed.length} diretório${s.removed.length > 1 ? 's' : ''})` : `Nada a limpar em ${k}`);
    } catch (e) {
      toast(e.message);
    } finally {
      busy = null;
      refresh();
    }
  }

  async function markReady() {
    const r = runs.get(selected);
    if (!r || !key || prBusy) return;
    const taskId = r.taskId;
    prBusy = true; prError = null; paint();
    try {
      await api(`/api/pr/${encodeURIComponent(key)}/ready`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ taskId }),
      });
      prLocal.set(taskId, 'ready');
    } catch (e) {
      if (runs.get(selected)?.taskId === taskId) prError = e.message;
    } finally {
      prBusy = false;
      paint();
    }
  }

  async function localCheckout(action) {
    if (!key || lcBusy) return;
    const k = key;
    if (action === 'use') {
      const repos = (lc?.repos || []).filter(r => r.available);
      const msg = `Colocar os checkouts principais no commit do ticket ${k}?\n\n`
        + repos.map(r => `• ${r.key} → ${r.sha.slice(0, 10)}${r.dirty ? ' (worktree com alteração não commitada: ela NÃO vem)' : ''}`).join('\n')
        + '\n\nFica em detached HEAD; suas alterações locais vão junto. Os arquivos versionados do projeto também passam a ser os do ticket até você clicar em "Voltar às branches".';
      if (!confirm(msg)) return;
    }
    lcBusy = action; lcError = null; paint();
    try {
      const path = action === 'use' ? `/api/local-checkout/${encodeURIComponent(k)}/use` : '/api/local-checkout/restore';
      // fetch direto (não api()): no 409 o corpo traz rollbackErrors, que o api() descarta.
      const res = await fetch(path, { method: 'POST' });
      const r = await res.json().catch(() => ({}));
      if (!res.ok) {
        const extra = r.rollbackErrors?.length ? ` · NÃO VOLTOU: ${r.rollbackErrors.join(' · ')} — use "Voltar às branches"` : '';
        throw new Error((r.error || `HTTP ${res.status}`) + extra);
      }
      if (action === 'use') toast([`Checkouts no ticket ${k} — pode subir o ambiente`, ...(r.warnings || [])].join(' · '));
      else {
        const bad = (r.results || []).filter(x => !x.ok);
        toast(bad.length ? `Voltou em parte: ${bad.map(x => `${x.key}: ${x.message}`).join(' · ')}` : 'Checkouts de volta às branches anteriores');
      }
    } catch (e) {
      lcError = e.message;
      toast(e.message);
    } finally {
      lcBusy = null;
      refresh();
    }
  }

  // ------------------------------------------------------------------ UI
  function lcHtml() {
    if (!lc) return '';
    const a = lc.active;
    const avail = (lc.repos || []).filter(r => r.available);
    const refs = a ? Object.entries(a.repos || {}).map(([k, r]) => `${esc(k)} → ${esc(r.previous.ref.slice(0, r.previous.type === 'branch' ? 80 : 10))}`).join(', ') : '';
    const here = a && a.ticket === key;
    const useBtn = `<button type="button" class="ghost-btn" data-lcact="use" ${lcBusy || !avail.length ? 'disabled' : ''} title="${avail.length ? `Checkouts principais (${esc(avail.map(r => r.key).join(', '))}) no commit do worktree do ticket` : 'nenhum worktree do ticket'}">${lcBusy === 'use' ? 'Trocando…' : here ? '💻 Atualizar pro último commit' : '💻 Usar na minha máquina'}</button>`;
    return `
      <div class="pv-actions pv-lc" role="group" aria-label="Checkouts da minha máquina">
        ${useBtn}
        ${a ? `<button type="button" class="ghost-btn" data-lcact="restore" ${lcBusy ? 'disabled' : ''} title="Volta cada repo pra: ${refs}">${lcBusy === 'restore' ? 'Voltando…' : '↩ Voltar às branches'}</button>` : ''}
        ${lcError ? `<p class="fold-msg err" role="alert" style="flex-basis:100%;margin:0">${esc(lcError)}</p>` : ''}
        <span class="pv-meta">${a ? `${here ? '🟢' : '⚠'} checkouts principais no ticket <b>${esc(a.ticket)}</b> (${esc(Object.keys(a.repos || {}).join(', '))})` : 'checkouts principais nas suas branches'}</span>
      </div>`;
  }

  // Badge acima dos botões de preview. Sem pr_status (PR ainda não aberto) = nada.
  function prHtml() {
    const r = runs.get(selected);
    const server = r?.state?.pr_status || null;
    const local = r && prLocal.get(r.taskId);
    const status = server === 'merged' ? 'merged' : local || server;
    if (!['draft', 'ready', 'merged'].includes(status)) return '';
    const badge = {
      draft: '<span class="pr-badge draft">● Draft</span>',
      ready: '<span class="pr-badge ready">● Ready for review</span>',
      merged: '<span class="pr-badge merged">✓ Mergeado</span>',
    }[status];
    const cleaned = r.state?.worktrees_cleaned_at;
    const extra = status === 'draft'
      ? `<button type="button" class="ghost-btn" data-prready ${prBusy ? 'disabled aria-busy="true"' : ''}>${prBusy ? 'Marcando…' : 'Marcar como pronto →'}</button>`
      : status === 'merged'
        ? `<span class="pv-meta">${cleaned ? 'Worktrees removidos' : r.state?.worktrees_cleanup_errors?.length ? 'Worktrees: remoção manual pendente' : 'Removendo worktrees…'}</span>`
        : '';
    return `
      <div class="pr-status" role="group" aria-label="Status do PR">
        <span class="pr-status-label">Status do PR</span>${badge}${extra}
      </div>
      ${prError && status === 'draft' ? `<p class="fold-msg err" role="alert">Não foi possível marcar como pronto: ${esc(prError)}</p>` : ''}`;
  }

  function lineHtml(e) {
    return `<span class="pv-${e.level.toLowerCase()}${e.source === 'preview' ? ' pv-mgr' : ''}">${hhmmss(e.ts)} ${esc(e.text)}\n</span>`;
  }
  function logEl() { return document.getElementById('pvLog'); }
  function renderLog() {
    const el = logEl();
    if (!el) return;
    el.innerHTML = lines.length ? lines.map(lineHtml).join('') : '<span class="pv-empty">Sem linhas de log ainda.</span>';
    el.scrollTop = el.scrollHeight;
  }
  function appendLine(e) {
    const el = logEl();
    if (!el) return;
    const stick = nearBottom(el);
    el.querySelector('.pv-empty')?.remove();
    el.insertAdjacentHTML('beforeend', lineHtml(e));
    while (el.childElementCount > MAX_LINES) el.firstElementChild.remove();
    if (stick) el.scrollTop = el.scrollHeight;
  }

  function summary() {
    if (st?.configured === false) return 'não configurado';
    const p = st?.phase;
    if (busy === 'start') return '<span class="pv-dot warn"></span>Iniciando…';
    if (busy === 'stop' || p === 'stopping') return '<span class="pv-dot warn"></span>Parando…';
    if (p === 'running') return `<span class="pv-dot on"></span>Rodando :${st.ports.back}`;
    if (BUILDING.includes(p)) return '<span class="pv-dot warn"></span>Construindo…';
    if (p === 'error') return '<span class="pv-dot off"></span>Erro';
    if (!st && loadError) return '<span class="pv-dot off"></span>indisponível';
    return st && !st.worktrees?.back ? 'sem worktree' : 'parado';
  }

  function detected(w) {
    const one = (label, ok) => `<span class="${ok ? 'pv-ok' : 'pv-no'}">${label} ${ok ? '✓' : '–'}</span>`;
    return `Worktrees detectados: ${one('back', w.back)} | ${one('app-core', w.appCore)} | ${one('mo-entity', w.moEntity)} | ${one('front', w.front)}`;
  }
  function chips(steps) {
    return CHIPS.map(([, label, f]) => { const v = f(steps || {}) || 'pending'; return `<span class="pv-chip ${v}">${label} ${MARK[v] || '–'}</span>`; }).join('');
  }
  const logBox = () => '<pre class="pv-log" id="pvLog" tabindex="0" aria-label="Log do preview" aria-live="off"></pre>';
  const btn = (act, label, extra = '') => `<button type="button" class="ghost-btn" data-pvact="${act}" ${busy ? 'disabled' : ''} ${extra}>${label}</button>`;

  // Escolha válida (existe no worktree); senão a do último start, senão a primeira.
  function selectedDb() {
    const opts = (st?.dbOptions || []).filter(o => o.exists);
    return opts.find(o => o.key === dbChoice) || opts.find(o => o.key === st?.db) || opts[0] || null;
  }
  const dbText = o => `${o.key}${o.db ? ` — ${o.db}` : ''}${o.sistema ? ` (${o.sistema})` : ''}`;
  function dbSelect() {
    const opts = st?.dbOptions || [];
    if (!opts.length) return '';
    const cur = selectedDb();
    return `<label class="pv-meta pv-db">Banco
      <select data-pvdb ${busy ? 'disabled' : ''}>${opts.map(o => `<option value="${esc(o.key)}" ${o === cur ? 'selected' : ''} ${o.exists ? '' : 'disabled'}>${esc(dbText(o))}${o.exists ? '' : ' — sem .properties'}</option>`).join('')}</select></label>`;
  }
  function runningDb() {
    const o = (st?.dbOptions || []).find(x => x.key === st?.db);
    return o ? `<span class="pv-meta">banco: ${esc(dbText(o))}</span>` : '';
  }

  function bodyHtml() {
    if (!st && loadError) return `<p class="fold-msg err">Não foi possível consultar o preview de <code>${esc(key)}</code>: ${esc(loadError)}</p>
      <div class="pv-actions"><button type="button" class="ghost-btn" data-pvretry>↻ Tentar de novo</button></div>`;
    if (!st) return '<p class="fold-msg">Verificando worktrees…</p>';
    if (st.configured === false) return '<p class="fold-msg">Preview não configurado para este projeto.</p>';
    const p = st.phase;
    const w = st.worktrees || {};
    const other = st.activeTicket && st.activeTicket !== key
      ? `<p class="fold-msg warn">Preview do ticket ${esc(st.activeTicket)} está rodando — pare-o antes de iniciar este.</p>` : '';
    if (p === 'running') {
      const front = st.steps?.front && st.steps.front !== 'skipped';
      return `
        <p class="pv-state">🟢 Rodando — back :${st.ports.back}${front ? `  front :${st.ports.front}` : ''}</p>
        <div class="pv-actions">
          <a class="ghost-btn" href="http://localhost:${st.ports.back}" target="_blank" rel="noopener">Abrir :${st.ports.back}</a>
          ${front ? `<a class="ghost-btn" href="http://localhost:${st.ports.front}" target="_blank" rel="noopener">Abrir :${st.ports.front}</a>` : ''}
          ${runningDb()}
          <span class="pv-meta">uptime: <span id="pvUptime">${dur(Date.now() - Date.parse(st.runningAt))}</span></span>
          <button type="button" class="link-btn" data-pvlog>${showLog ? 'Ocultar log' : 'Mostrar log'}</button>
        </div>
        ${showLog ? logBox() : ''}
        <div class="pv-actions">${btn('stop', '■ Parar Preview')}</div>`;
    }
    if (BUILDING.includes(p) || p === 'stopping') {
      return `
        <p class="pv-state">🔨 Construindo... ${chips(st.steps)}</p>
        ${logBox()}
        <div class="pv-actions">${btn('stop', '■ Parar')}</div>`;
    }
    if (p === 'error') {
      return `
        <p class="pv-state err">🔴 Erro na fase: ${esc(st.errorPhase || '—')}</p>
        <p class="pv-msg">Mensagem: ${esc(st.error || '—')}</p>
        ${logBox()}
        ${other}
        <div class="pv-actions">${dbSelect()} ${btn('start', '↺ Tentar novamente', w.back ? '' : 'disabled title="worktree não encontrado"')} ${btn('stop', '■ Parar')} ${btn('clean', '🧹 Limpar cache', 'title="Apaga target/ dos worktrees e o que o preview instalou no ~/.m2"')}</div>`;
    }
    const noWt = !w.back;
    return `
      <div class="pv-actions">
        ${dbSelect()}
        <button type="button" class="ghost-btn pv-start" data-pvact="start" ${busy || noWt ? 'disabled' : ''} ${noWt ? `title="worktree não encontrado (.claude/worktrees/${esc(key)})"` : ''}>▶ Iniciar Preview</button>
        ${btn('clean', '🧹 Limpar cache', noWt ? 'disabled' : 'title="Apaga target/ dos worktrees e o que o preview instalou no ~/.m2"')}
        <span class="pv-meta">${detected(w)}</span>
      </div>
      ${noWt ? `<p class="fold-msg">worktree não encontrado: <code>.claude/worktrees/${esc(key)}</code></p>` : ''}
      ${other}
      ${lines.length ? `<details class="pv-last"><summary>Log do último preview</summary>${logBox()}</details>` : ''}`;
  }

  function paint() {
    const fold = document.getElementById('foldPreview');
    if (!fold) return;
    const body = fold.querySelector('.fold-body');
    const el = logEl();
    const keepScroll = el && !nearBottom(el) ? el.scrollTop : null;
    fold.querySelector('#pvSum').innerHTML = summary();
    body.innerHTML = prHtml() + bodyHtml() + lcHtml();
    renderLog();
    if (keepScroll !== null && logEl()) logEl().scrollTop = keepScroll;
  }

  function mount() {
    const r = runs.get(selected);
    const hero = document.querySelector('#detail section.hero');
    if (!r || !hero || document.getElementById('foldPreview')) return;
    const k = previewKey(r);
    if (k !== key) { key = k; st = null; loadError = null; showLog = true; prError = null; lc = null; lcError = null; connect(); refresh(); }
    // Aberto sozinho enquanto há preview deste ticket em andamento.
    const open = openKeys.has(k) || (st && st.phase !== 'idle');
    hero.insertAdjacentHTML('beforeend', `
      <div class="folds pv-folds"><details class="fold" id="foldPreview" ${open ? 'open' : ''}>
        <summary>▶ Preview de Ambiente <span class="sum-right" id="pvSum"></span></summary>
        <div class="fold-body"></div>
      </details></div>`);
    const fold = document.getElementById('foldPreview');
    fold.addEventListener('change', e => {
      const sel = e.target.closest('[data-pvdb]');
      if (!sel) return;
      dbChoice = sel.value;
      try { localStorage.setItem('preview.db', dbChoice); } catch {}
    });
    fold.addEventListener('toggle', () => { if (fold.open) openKeys.add(key); else openKeys.delete(key); });
    fold.addEventListener('click', e => {
      const a = e.target.closest('[data-pvact]');
      if (a && !a.disabled) return act(a.dataset.pvact);
      const l = e.target.closest('[data-lcact]');
      if (l && !l.disabled) return localCheckout(l.dataset.lcact);
      const pr = e.target.closest('[data-prready]');
      if (pr && !pr.disabled) return markReady();
      if (e.target.closest('[data-pvlog]')) { showLog = !showLog; paint(); }
      if (e.target.closest('[data-pvretry]')) { loadError = null; paint(); refresh(); }
    });
    paint();
  }

  const detail = $('detail');
  new MutationObserver(() => {
    if (!runs.get(selected)) { if (key) { es?.close(); es = null; key = null; st = null; } return; }
    mount();
  }).observe(detail, { childList: true });
  mount();

  setInterval(() => {
    const el = document.getElementById('pvUptime');
    if (el && st?.runningAt) el.textContent = dur(Date.now() - Date.parse(st.runningAt));
  }, 1000);
  // O SSE cobre as mudanças de fase; isto só pega worktree criado/removido com o painel aberto.
  setInterval(() => { if (!document.hidden && key && (!st || st.phase === 'idle')) refresh(); }, 10000);

  const style = document.createElement('style');
  style.textContent = `
    .pv-folds { margin-top: 10px; }
    .pv-lc { border-top: 1px solid var(--line-soft); padding-top: 10px; }
    .pv-db { display: inline-flex; align-items: center; gap: 6px; }
    .pv-db select { font: inherit; max-width: 100%; }
    #pvSum { display: inline-flex; align-items: center; gap: 6px; }
    .pv-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--idle); display: inline-block; }
    .pv-dot.on { background: var(--clear); box-shadow: 0 0 0 3px var(--clear-bg); }
    .pv-dot.off { background: var(--stop); box-shadow: 0 0 0 3px var(--stop-bg); }
    .pv-dot.warn { background: var(--attention); box-shadow: 0 0 0 3px var(--attention-bg); }
    #foldPreview .fold-body { display: grid; gap: 10px; }
    .pv-actions { display: flex; align-items: center; gap: 8px 12px; flex-wrap: wrap; }
    .pv-actions a.ghost-btn { text-decoration: none; }
    .pv-actions .ghost-btn:disabled { opacity: .45; cursor: default; }
    .pv-meta { font-size: 13px; color: var(--muted); font-variant-numeric: tabular-nums; }
    .pv-ok { color: var(--ink-2); } .pv-no { color: var(--faint); }
    .pv-state { margin: 0; font-weight: 600; display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
    .pv-state.err { color: var(--stop); }
    .pv-msg { margin: 0; font-size: 13.5px; color: var(--ink-2); overflow-wrap: anywhere; }
    .pv-chip { font: 12px var(--mono); font-weight: 500; border: 1px solid var(--line); border-radius: 6px; padding: 1px 7px; color: var(--muted); }
    .pv-chip.done { color: var(--clear); border-color: var(--clear); }
    .pv-chip.running { color: var(--attention); border-color: var(--attention); }
    .pv-chip.error { color: var(--stop); border-color: var(--stop); }
    .pv-chip.skipped { color: var(--faint); border-style: dashed; }
    /* ~20 linhas visíveis; o resto do ringbuffer (300) rola. */
    .pv-log { margin: 0; max-height: calc(20 * 12px * 1.55 + 16px); overflow: auto; background: var(--sunken); border: 1px solid var(--line-soft); border-radius: 8px; padding: 8px 10px; font: 12px/1.55 var(--mono); color: var(--ink-2); white-space: pre-wrap; overflow-wrap: anywhere; }
    .pv-log .pv-warn { color: var(--attention); }
    .pv-log .pv-error { color: var(--stop); }
    .pv-log .pv-mgr { font-weight: 600; color: var(--signal); }
    .pv-log .pv-mgr.pv-error { color: var(--stop); }
    .pv-log .pv-empty { color: var(--faint); }
    .pr-status { display: flex; align-items: center; gap: 8px 12px; flex-wrap: wrap; padding: 8px 10px; border: 1px solid var(--line-soft); border-radius: 8px; }
    .pr-status-label { font-size: 13px; color: var(--muted); }
    .pr-badge { font-size: 13px; font-weight: 600; border-radius: 999px; padding: 1px 9px; border: 1px solid currentColor; }
    .pr-badge.draft { color: var(--attention); background: var(--attention-bg); }
    .pr-badge.ready { color: var(--signal); background: var(--signal-soft); }
    .pr-badge.merged { color: var(--clear); background: var(--clear-bg); }
    .pr-status .ghost-btn:disabled { opacity: .45; cursor: default; }
    .pv-last > summary { cursor: pointer; font-size: 13px; color: var(--muted); margin-bottom: 6px; }
  `;
  document.head.appendChild(style);
  window.PreviewPanel = { refresh, key: () => key };
})();
