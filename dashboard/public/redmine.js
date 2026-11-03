// Aba "Redmine" (substitui "Meus Tickets"): tickets abertos atribuídos a você
// (GET /api/tickets — já com run e PR vinculados), painel lateral com descrição e
// journals (GET /api/tickets/:id) e ações diretas no Redmine: mudar status
// (PUT /api/tickets/:id/status), adicionar nota (POST /api/tickets/:id/note) e
// disparar run (POST /api/runs/start, mesma regra de 409 da aba antiga). Mesmo
// padrão de prs.js: IIFE carregado depois de views.js, plugado em VIEWS/RENDER via
// window.RedmineView. Usa os globais de index.html/views.js: esc(), ago(), when(),
// toast(), runs, refreshRuns(), retryQaRejection(), ticketStatusTone(), prefs,
// persist(), $().
(() => {
  const st = {
    list: [], at: 0, loading: false, error: null,
    filter: (prefs.redmine && prefs.redmine.filter) || 'all',
    starting: new Set(), // ids com "Disparar" em voo
    statuses: null, // GET /api/tickets/statuses (fallback do select sem allowed_statuses)
  };
  // Painel lateral: um ticket por vez.
  const dr = { id: null, data: null, loading: false, error: null, descOpen: false, busy: null, focusNote: false };

  // Duplica scripts/lib/redmine-journal-fetcher.js > isQaRejectedStatus (o front não
  // importa módulos Node) — só os 2 literais, mesma fonte de verdade.
  const isQaRejected = s => typeof s === 'string' && ['recusa qa', 'recusada qa'].includes(s.trim().toLowerCase());
  const isUrgent = p => /urgente|imediata/i.test(p || '');

  const FILTERS = [
    ['all', 'Todos', () => true],
    ['dev', 'Em Desenvolvimento', t => /em desenvolvimento/i.test(t.status || '')],
    ['qa-wait', 'Aguardando QA', t => /aguardando.*qa|qa.*aguardando/i.test(t.status || '')],
    ['qa-rej', 'Recusada QA', t => isQaRejected(t.status)],
    ['urgent', 'Urgente', t => isUrgent(t.priority)],
  ];

  // Prioridade (design Espectro): 3 barras de altura crescente + o nome do Redmine.
  // Urgente/Imediata = 3 barras em vermelho, Alta = 3 em âmbar, Normal = 2, Baixa = 1;
  // nome fora dessas faixas mostra só o texto (barras apagadas) — nunca chuta nível.
  function priorityBadge(p) {
    if (!p) return '<span class="muted">—</span>';
    const [lvl, tone] = isUrgent(p) ? [3, 'urgent'] : /alta/i.test(p) ? [3, 'high'] : /normal/i.test(p) ? [2, 'normal'] : /baixa/i.test(p) ? [1, 'normal'] : [0, 'normal'];
    return `<span class="rm-prio rm-prio-${tone}" data-level="${lvl}"><span class="rm-bars" aria-hidden="true"><i></i><i></i><i></i></span>${esc(p)}</span>`;
  }

  // Status do ticket: anel com preenchimento (forma) + cor + nome. O tom vem do mesmo
  // mapeamento global por regex (index.html > ticketStatusTone) usado no resto da UI.
  function statusBadge(s) {
    if (!s) return '<span class="muted">—</span>';
    const tone = typeof ticketStatusTone === 'function' ? ticketStatusTone(s) : 'idle';
    return `<span class="rm-status rm-st-${tone}"><span class="rm-ring" aria-hidden="true"></span>${esc(s)}</span>`;
  }

  // Run vinculado (linkedRun.kind/status vêm de deriveRunKind no server): glifo + cor
  // conforme as regras de estado do design. Sem dado = "Sem estado", nunca concluído.
  const RUN_WAITING = /needs_human|awaiting|pending-approval|authorization-pending|escalat|blocked|interrupted|spec-draft|spec-drift|spec-change-rejected/;
  function runState(run) {
    if (run.kind === 'failed') return ['failed', '✕', 'Falhou'];
    if (run.kind === 'completed') return ['done', '✓', 'Concluído'];
    if (run.kind === 'has_pr') return ['done', '✓', 'Com PR'];
    if (run.kind === 'active') return RUN_WAITING.test(run.status || '') ? ['waiting', '‖', 'Aguardando humano'] : ['running', '◐', 'Em execução'];
    return ['queued', '○', 'Sem estado'];
  }
  function runButton(run, extraClass) {
    const [tone, glyph, label] = runState(run);
    return `<button type="button" class="rm-run rm-run-${tone}${extraClass ? ` ${extraClass}` : ''}" data-rmact="run" data-run="${esc(run.taskId)}" title="Ver run ${esc(run.taskId)} · ${label}" aria-label="Ver run ${esc(run.taskId)} (${label})"><span aria-hidden="true">${glyph}</span><span class="rm-run-node">${esc(run.node || label)}</span></button>`;
  }

  const initials = name => String(name || 'Sistema').trim().split(/\s+/).slice(0, 2).map(w => w[0] || '').join('').toUpperCase() || '·';

  const render = () => window.Views?.refresh();

  async function load(force) {
    if (st.loading) return;
    if (!force && Date.now() - st.at < 25000) return;
    st.loading = true; render();
    try {
      const res = await fetch('/api/tickets');
      const body = await res.json().catch(() => ({}));
      if (res.ok) { st.list = Array.isArray(body) ? body : []; st.error = null; }
      else st.error = body.error || `HTTP ${res.status}`;
    } catch (e) { st.error = e.message; }
    st.at = Date.now(); st.loading = false;
    render();
  }

  // ------------------------------------------------------------------ disparar
  // Poll curto (2s, até 60s) depois de disparar: o run só existe quando o
  // fetch_ticket destacado cria o state.json — o POST não devolve runId.
  function pollForNewRun(ticketId) {
    const deadline = Date.now() + 60000;
    const iv = setInterval(async () => {
      await refreshRuns();
      const found = [...runs.values()].find(r => r.ticketId === ticketId);
      if (found) { clearInterval(iv); load(true); window.Views.openRun(found.taskId); return; }
      if (Date.now() > deadline) { clearInterval(iv); toast('Run ainda não apareceu — confira a aba Runs em instantes.'); }
    }, 2000);
  }

  async function start(ticketId) {
    if (st.starting.has(ticketId)) return;
    st.starting.add(ticketId); render(); renderDrawer();
    try {
      const res = await fetch('/api/runs/start', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ticketId }) });
      const body = await res.json().catch(() => ({}));
      if (res.status === 409) {
        toast('Run já ativa para este ticket', body.runId ? { label: 'Ver run', run: () => { closeDrawer(); window.Views.openRun(body.runId); } } : undefined);
      } else if (!res.ok) {
        toast(`Não foi possível disparar: ${body.error || `HTTP ${res.status}`}`);
      } else {
        toast('Run iniciada');
        pollForNewRun(ticketId);
      }
    } catch (e) {
      toast(`Não foi possível disparar: ${e.message}`);
    } finally {
      st.starting.delete(ticketId); render(); renderDrawer();
    }
  }

  // ------------------------------------------------------------------ tabela
  function row(t) {
    const rejected = isQaRejected(t.status);
    const busy = st.starting.has(t.id);
    const run = t.linkedRun;
    const qaRetry = rejected && run && run.kind !== 'completed';
    return `<tr class="${rejected ? 'qa-rejected' : ''}${dr.id === t.id ? ' rm-current' : ''}">
      <td class="c-id"><button type="button" class="rm-id" data-rmact="open" data-id="${t.id}" title="Abrir detalhes do ticket">#${t.id}</button></td>
      <td class="rm-subject"><span title="${esc(t.subject)}">${esc(t.subject)}</span></td>
      <td class="c-prio">${priorityBadge(t.priority)}</td>
      <td class="c-status">${statusBadge(t.status)}</td>
      <td class="c-run">${run ? runButton(run) : '<span class="muted">—</span>'}</td>
      <td class="c-pr">${t.prUrl ? `<a class="rm-pr" href="${esc(t.prUrl)}" target="_blank" rel="noopener noreferrer" title="Abrir PR no Bitbucket" aria-label="Abrir PR no Bitbucket">PR <span aria-hidden="true">↗</span></a>` : '<span class="muted">—</span>'}</td>
      <td class="c-upd" title="${esc(when(t.updated_on))}">${esc(ago(t.updated_on)) || '—'}</td>
      <td class="c-act"><div class="rm-actions">
        <button type="button" class="btn" data-rmact="start" data-id="${t.id}" ${busy ? 'disabled aria-busy="true"' : ''}>${busy ? 'Disparando…' : '▶ Disparar'}</button>
        <button type="button" class="btn" data-rmact="note" data-id="${t.id}">✎ Nota</button>
        ${qaRetry ? `<button type="button" class="qa-retry-btn" data-rmact="qaretry" data-run="${esc(run.taskId)}">🔄 Corrigir recusa QA</button>` : ''}
      </div></td>
    </tr>`;
  }

  // Lista vazia é ambígua: o server devolve [] tanto sem tickets quanto sem
  // REDMINE_URL/REDMINE_API_KEY ou com o Redmine fora (redmine-ticket-list.js). Por isso
  // as contagens viram "—" e o estado vazio diz que não confirma zero.
  function stateBlock() {
    if (!st.at) { // ainda sem nenhuma leitura: a aba dispara load() ao abrir
      const sk = [70, 52, 64, 46, 74, 58].map(w => `<div class="rm-skel-row"><i style="width:${w}%"></i><i></i></div>`).join('');
      return `<div class="rm-loading" role="status" aria-busy="true"><p>Carregando tickets do Redmine…</p><div class="rm-skel" aria-hidden="true">${sk}</div></div>`;
    }
    if (!st.list.length) {
      if (st.error) return '';
      return `<div class="rm-empty" role="status"><h3 class="t-heading">Nenhum ticket aberto atribuído a você</h3>
        <p>O Redmine devolveu lista vazia. O dashboard também recebe lista vazia quando REDMINE_URL/REDMINE_API_KEY não estão configurados ou a consulta falha, então isto não confirma zero tickets.</p></div>`;
    }
    return null;
  }

  function renderView() {
    const known = st.list.length > 0;
    const count = pred => (known ? st.list.filter(pred).length : '—');
    const chip = ([k, label, pred]) => `<button type="button" data-rmact="filter" data-filter="${k}" aria-pressed="${st.filter === k}">${label} <span class="num">${count(pred)}</span></button>`;
    const pred = (FILTERS.find(f => f[0] === st.filter) || FILTERS[0])[2];
    const items = st.list.filter(pred);
    const sync = st.loading ? 'atualizando…' : st.error ? 'última leitura falhou' : st.at ? `lido ${ago(new Date(st.at).toISOString())}` : 'ainda não lido';
    const err = st.error ? `<div class="rm-error" role="alert">
        <h3 class="t-heading"><span class="rm-glyph-failed" aria-hidden="true">✕</span>Não foi possível carregar os tickets</h3>
        <dl><dt>Causa</dt><dd>${esc(st.error)}</dd>${known ? '<dt>Preservado</dt><dd>A lista abaixo é a da última leitura que funcionou.</dd>' : ''}</dl>
        <div><button type="button" class="btn primary lg" data-rmact="refresh" ${st.loading ? 'disabled' : ''}>Tentar novamente</button></div>
      </div>` : '';
    const state = stateBlock();
    const body = state !== null ? state
      : items.length ? `<div class="rm-scroll"><table class="dtable rm-table"><thead><tr><th class="c-id">ID</th><th>Título</th><th class="c-prio">Prioridade</th><th class="c-status">Status</th><th class="c-run">Run</th><th class="c-pr">PR</th><th class="c-upd">Atualizado</th><th class="c-act">Ações</th></tr></thead>
        <tbody>${items.map(row).join('')}</tbody></table></div>`
        : `<div class="rm-empty rm-empty-filter" role="status"><p>Nenhum ticket com esse filtro.</p><button type="button" class="btn lg" data-rmact="filter" data-filter="all">Ver todos os tickets</button></div>`;
    return `<div class="rm-view">
      <header class="rm-head"><h2 class="t-title">Redmine</h2><p>Tickets abertos atribuídos a você, com o run e o PR vinculados. Clique no número para ver o histórico e mudar status ou comentar sem sair do dashboard.</p></header>
      <div class="rm-toolbar">
        <div class="seg rm-filters" role="group" aria-label="Filtro">${FILTERS.map(chip).join('')}</div>
        <span class="rm-sync" title="${st.at ? esc(when(new Date(st.at).toISOString())) : ''}">Redmine · ${sync}</span>
        <button class="btn" type="button" data-rmact="refresh" ${st.loading ? 'disabled' : ''}>${st.loading ? 'Atualizando…' : '↻ Atualizar'}</button>
      </div>
      ${err}
      ${body}
      <p class="source-note rm-source">Título, prioridade, status e data vêm do Redmine (tickets abertos atribuídos a você). Run e PR vêm do estado local dos runs do Prisma vinculados ao ticket.</p>
    </div>`;
  }

  // ------------------------------------------------------------------ painel lateral
  const shell = document.createElement('div');
  shell.innerHTML = `<div class="rm-backdrop" id="rmBackdrop" hidden></div>
    <aside class="log-drawer rm-drawer" id="rmDrawer" aria-label="Detalhes do ticket" aria-hidden="true">
      <div class="log-drawer-head"><h3 id="rmDrawerTitle">Ticket</h3>
        <button type="button" class="icon-btn" data-rmact="close" aria-label="Fechar painel" title="Fechar (Esc)">✕</button></div>
      <div class="rm-drawer-body" id="rmDrawerBody"></div>
    </aside>`;
  document.body.append(...shell.children);
  const drawer = $('rmDrawer');
  const backdrop = $('rmBackdrop');
  const isOpen = () => drawer.classList.contains('open');

  async function openDrawer(id, focusNote) {
    Object.assign(dr, { id, data: null, loading: true, error: null, descOpen: false, busy: null, focusNote: !!focusNote });
    drawer.classList.add('open'); drawer.setAttribute('aria-hidden', 'false'); backdrop.hidden = false;
    renderDrawer(); render();
    loadStatuses();
    try {
      const res = await fetch(`/api/tickets/${id}`);
      const body = await res.json().catch(() => ({}));
      if (dr.id !== id) return;
      if (res.ok) dr.data = body; else dr.error = body.error || `HTTP ${res.status}`;
    } catch (e) { if (dr.id === id) dr.error = e.message; }
    if (dr.id !== id) return;
    dr.loading = false;
    renderDrawer();
  }

  function closeDrawer() {
    if (!isOpen()) return;
    drawer.classList.remove('open'); drawer.setAttribute('aria-hidden', 'true'); backdrop.hidden = true;
    dr.id = null; dr.data = null;
    render();
  }

  async function loadStatuses() {
    if (st.statuses) return;
    try {
      const res = await fetch('/api/tickets/statuses');
      if (res.ok) { st.statuses = await res.json(); renderDrawer(); }
    } catch { /* sem lista global: o select usa allowed_statuses do ticket */ }
  }

  const FIELD_LABELS = {
    status_id: 'Status', assigned_to_id: 'Atribuído para', priority_id: 'Prioridade', done_ratio: '% Terminado',
    subject: 'Título', description: 'Descrição', tracker_id: 'Tipo', fixed_version_id: 'Versão', category_id: 'Categoria',
    start_date: 'Início', due_date: 'Data prevista', estimated_hours: 'Tempo estimado', parent_id: 'Tarefa pai', project_id: 'Projeto',
  };
  const short = v => { const s = String(v ?? ''); return s.length > 80 ? `${s.slice(0, 80)}…` : s; };
  function detailLine(d) {
    if (d.property === 'attachment') return d.new_value ? `Anexo adicionado: ${esc(d.new_value)}` : `Anexo removido: ${esc(d.old_value || '')}`;
    if (d.property === 'relation') return `Relação ${esc(d.name)}: ${d.new_value ? `#${esc(d.new_value)}` : `removida (#${esc(d.old_value || '')})`}`;
    const label = FIELD_LABELS[d.name] || (d.property === 'cf' ? `Campo personalizado ${esc(d.name)}` : esc(d.name));
    if (d.name === 'description') return `${label} alterada`;
    const from = d.old_label || d.old_value;
    const to = d.new_label || d.new_value;
    const val = v => (v == null || v === '' ? '<i>vazio</i>' : `<b>${esc(short(v))}</b>`);
    return `${label}: ${val(from)} → ${val(to)}`;
  }
  // "Sistema": sem nota e sem nenhum detail conhecido — omitido da timeline.
  const RELEVANT = new Set(['attr', 'cf', 'attachment', 'relation']);
  function journalItem(j) {
    const details = (j.details || []).filter(d => RELEVANT.has(d.property));
    if (!j.notes && !details.length) return '';
    const rejected = details.some(d => d.name === 'status_id' && isQaRejected(d.new_label));
    return `<li class="rm-journal${rejected ? ' rm-journal-rejected' : ''}">
      <span class="rm-avatar" aria-hidden="true">${esc(initials(j.user))}</span>
      <div class="rm-journal-main">
        <div class="rm-journal-head"><b>${esc(j.user || 'Sistema')}</b> <span class="muted" title="${esc(when(j.created_on))}">${esc(ago(j.created_on))}</span>
          ${rejected ? '<span class="qa-badge">⊘ RECUSADA QA</span>' : ''}${j.private_notes ? ' <span class="muted">(nota privada)</span>' : ''}</div>
        ${details.length ? `<ul class="rm-changes">${details.map(d => `<li class="${d.name === 'status_id' && isQaRejected(d.new_label) ? 'rm-change-rejected' : ''}">${detailLine(d)}</li>`).join('')}</ul>` : ''}
        ${j.notes ? `<div class="rm-note">${esc(j.notes)}</div>` : ''}
      </div>
    </li>`;
  }

  function renderDrawer() {
    if (!isOpen()) return;
    const body = $('rmDrawerBody');
    $('rmDrawerTitle').textContent = `#${dr.id}`;
    if (dr.loading) { body.innerHTML = '<div class="log-drawer-empty rm-dstate" role="status" aria-busy="true"><span class="rm-glyph-running" aria-hidden="true">◐</span> Carregando ticket…</div>'; return; }
    if (dr.error) { body.innerHTML = `<div class="log-drawer-empty rm-dstate rm-dstate-err" role="alert"><span class="rm-glyph-failed" aria-hidden="true">✕</span> Não foi possível carregar o ticket: ${esc(dr.error)}</div>`; return; }
    // Preserva o que o usuário já digitou/escolheu entre re-renders.
    const prevNote = $('rmNote')?.value ?? '';
    const prevStatus = $('rmStatus')?.value;
    const { ticket: t, journals, linkedRun, prUrl } = dr.data;
    const desc = t.description || '';
    const long = desc.length > 500;
    const options = (t.allowed_statuses && t.allowed_statuses.length ? t.allowed_statuses : st.statuses || [])
      .filter((s, i, a) => a.findIndex(x => x.id === s.id) === i);
    if (t.status_id != null && !options.some(s => s.id === t.status_id)) options.unshift({ id: t.status_id, name: t.status });
    const sel = prevStatus ?? String(t.status_id ?? '');
    const busy = dr.busy;
    const starting = st.starting.has(t.id);
    const items = (journals || []).map(journalItem).filter(Boolean).reverse();
    const facts = [
      ['Status', statusBadge(t.status)],
      ['Prioridade', priorityBadge(t.priority)],
      t.tracker && ['Tipo', esc(t.tracker)],
      t.assignee && ['Responsável', esc(t.assignee)],
      t.updated_on && ['Atualizado', `<span title="${esc(when(t.updated_on))}">${esc(ago(t.updated_on))}</span>`],
      ['Run', linkedRun ? `${runButton(linkedRun)} <span class="rm-mono rm-taskid">${esc(linkedRun.taskId)}</span>` : '<span class="muted">—</span>'],
    ].filter(Boolean);
    body.innerHTML = `
      <header class="rm-dhead">
        <h4>${esc(t.subject)}</h4>
        <div class="rm-links">
          ${t.url ? `<a class="btn" href="${esc(t.url)}" target="_blank" rel="noopener noreferrer">Redmine ↗</a>` : ''}
          ${prUrl ? `<a class="btn" href="${esc(prUrl)}" target="_blank" rel="noopener noreferrer">PR no Bitbucket ↗</a>` : ''}
        </div>
      </header>
      <dl class="rm-facts">${facts.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl>
      <section class="rm-sec" aria-labelledby="rmSecDesc"><h5 class="label" id="rmSecDesc">Descrição</h5>
        ${desc ? `<div class="rm-desc">${esc(dr.descOpen || !long ? desc : `${desc.slice(0, 500)}…`)}</div>
          ${long ? `<button type="button" class="link-btn" data-rmact="desc">${dr.descOpen ? 'ver menos' : 'ver mais'}</button>` : ''}` : '<p class="muted">Sem descrição.</p>'}
      </section>
      <section class="rm-sec" aria-labelledby="rmSecAct"><h5 class="label" id="rmSecAct">Ações rápidas</h5>
        <div class="rm-form">
          <label>Status <select id="rmStatus" ${busy ? 'disabled' : ''}>${options.map(s => `<option value="${s.id}" ${String(s.id) === sel ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</select></label>
          <label>Nota (opcional para status) <textarea id="rmNote" rows="4" maxlength="20000" placeholder="Comentário que vai para o histórico do ticket" ${busy ? 'disabled' : ''}>${esc(prevNote)}</textarea></label>
          <div class="rm-form-actions">
            <button type="button" class="btn primary lg" data-rmact="save" ${busy ? 'disabled' : ''}>${busy === 'save' ? 'Salvando…' : 'Salvar'}</button>
            <button type="button" class="btn lg" data-rmact="addnote" ${busy ? 'disabled' : ''}>${busy === 'note' ? 'Enviando…' : 'Adicionar nota'}</button>
            <button type="button" class="btn lg" data-rmact="start" data-id="${t.id}" ${starting ? 'disabled aria-busy="true"' : ''}>${starting ? 'Disparando…' : '▶ Disparar run'}</button>
          </div>
        </div>
      </section>
      <section class="rm-sec" aria-labelledby="rmSecHist"><h5 class="label" id="rmSecHist">Histórico no Redmine <span class="rm-count">(${items.length})</span></h5>
        ${items.length ? `<ol class="rm-timeline">${items.join('')}</ol>` : '<p class="muted">Nenhuma alteração ou nota registrada.</p>'}
      </section>
      <p class="source-note">Descrição, campos e histórico vêm do Redmine; o run vinculado vem do estado local do Prisma.</p>`;
    if (dr.focusNote) { dr.focusNote = false; $('rmNote')?.focus(); }
  }

  // Salvar status (com nota opcional) ou só nota: fecha o painel, toast, e atualiza a
  // linha localmente (status/atualizado) — o próximo refresh traz o resto do Redmine.
  async function submit(kind) {
    if (dr.busy || !dr.data) return;
    const id = dr.id;
    const note = $('rmNote').value.trim();
    const statusSel = $('rmStatus');
    const statusId = Number(statusSel?.value);
    if (kind === 'note' && !note) { toast('Escreva a nota antes de enviar.'); $('rmNote').focus(); return; }
    if (kind === 'save' && !statusId) { toast('Escolha um status.'); return; }
    dr.busy = kind; renderDrawer();
    try {
      const res = kind === 'save'
        ? await fetch(`/api/tickets/${id}/status`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ statusId, note }) })
        : await fetch(`/api/tickets/${id}/note`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ note }) });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      const t = st.list.find(x => x.id === id);
      if (t) {
        if (kind === 'save') t.status = statusSel.options[statusSel.selectedIndex]?.text || t.status;
        t.updated_on = new Date().toISOString();
      }
      closeDrawer();
      toast(kind === 'save' ? `Status do #${id} atualizado.` : `Nota adicionada ao #${id}.`);
    } catch (e) {
      if (dr.id === id) { dr.busy = null; renderDrawer(); }
      toast(`Não foi possível ${kind === 'save' ? 'salvar o status' : 'adicionar a nota'}: ${e.message}`);
    }
  }

  // ------------------------------------------------------------------ eventos
  function onAction(el) {
    const a = el.dataset.rmact;
    if (a === 'filter') { st.filter = el.dataset.filter; prefs.redmine = { filter: st.filter }; persist(); render(); }
    else if (a === 'refresh') load(true);
    else if (a === 'open') openDrawer(Number(el.dataset.id), false);
    else if (a === 'note') openDrawer(Number(el.dataset.id), true);
    else if (a === 'start') start(Number(el.dataset.id));
    else if (a === 'run') { closeDrawer(); window.Views.openRun(el.dataset.run); }
    else if (a === 'qaretry') retryQaRejection(el.dataset.run);
    else if (a === 'close') closeDrawer();
    else if (a === 'desc') { dr.descOpen = !dr.descOpen; renderDrawer(); }
    else if (a === 'save') submit('save');
    else if (a === 'addnote') submit('note');
  }
  $('view').addEventListener('click', e => { const el = e.target.closest('[data-rmact]'); if (el) onAction(el); });
  drawer.addEventListener('click', e => { const el = e.target.closest('[data-rmact]'); if (el) onAction(el); });
  backdrop.addEventListener('click', closeDrawer);
  // Captura: ESC fecha o painel antes dos atalhos globais (index.html/ux.js) reagirem.
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && isOpen()) { e.preventDefault(); e.stopImmediatePropagation(); closeDrawer(); }
  }, true);

  // Auto-refresh de 30s só com a aba "Redmine" aberta e a página visível.
  const onTab = () => window.Views?.current?.() === 'redmine';
  setInterval(() => { if (onTab() && !document.hidden) load(false); }, 30000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden && onTab()) load(false); });

  window.RedmineView = { render: renderView, load };
  if (onTab()) load(false);
})();
