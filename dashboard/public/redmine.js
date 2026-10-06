// Aba "Redmine" (substitui "Meus Tickets"): tickets abertos atribuídos a você
// (GET /api/tickets — já com run e PR vinculados), painel lateral com descrição e
// journals (GET /api/tickets/:id) e ações diretas no Redmine: mudar status
// (PUT /api/tickets/:id/status), adicionar nota (POST /api/tickets/:id/note) e
// disparar run (POST /api/runs/start, mesma regra de 409 da aba antiga). Mesmo
// padrão de prs.js: IIFE carregado depois de views.js, plugado em VIEWS/RENDER via
// window.RedmineView. Usa os globais de index.html/views.js: esc(), ago(), when(),
// toast(), runs, refreshRuns(), retryQaRejection(), ticketStatusBadge(), prefs,
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

  // Prioridade: Urgente/Imediata vermelho, Alta laranja, Normal azul, Baixa cinza —
  // reaproveita os tons de .tk-status-* (nunca inventar cor nova pra badge).
  function priorityBadge(p) {
    if (!p) return '<span class="muted">—</span>';
    const tone = isUrgent(p) ? 'risk' : /alta/i.test(p) ? 'attention' : /normal/i.test(p) ? 'signal' : 'idle';
    return `<span class="tk-status tk-status-${tone}">${esc(p)}</span>`;
  }

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
  const ICON_LINK = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7"/><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"/></svg>';

  function row(t) {
    const rejected = isQaRejected(t.status);
    const busy = st.starting.has(t.id);
    const run = t.linkedRun;
    const qaRetry = rejected && run && run.kind !== 'completed';
    return `<tr class="${rejected ? 'qa-rejected' : ''}${dr.id === t.id ? ' rm-current' : ''}">
      <td><button type="button" class="run-link" data-rmact="open" data-id="${t.id}" title="Abrir detalhes do ticket">#${t.id}</button></td>
      <td class="rm-subject"><span title="${esc(t.subject)}">${esc(t.subject)}</span></td>
      <td>${priorityBadge(t.priority)}</td>
      <td>${t.status ? ticketStatusBadge(t.status) : '<span class="muted">—</span>'}</td>
      <td>${run ? `<button type="button" class="rm-icon" data-rmact="run" data-run="${esc(run.taskId)}" title="Ver run ${esc(run.taskId)}" aria-label="Ver run ${esc(run.taskId)}">${ICON_LINK}</button>` : '<span class="muted">—</span>'}</td>
      <td>${t.prUrl ? `<a class="rm-icon" href="${esc(t.prUrl)}" target="_blank" rel="noopener noreferrer" title="Abrir PR no Bitbucket" aria-label="Abrir PR no Bitbucket">${ICON_LINK}</a>` : '<span class="muted">—</span>'}</td>
      <td title="${esc(when(t.updated_on))}">${esc(ago(t.updated_on)) || '—'}</td>
      <td class="mt-actions">
        <button type="button" class="ghost-btn" data-rmact="start" data-id="${t.id}" ${busy ? 'disabled aria-busy="true"' : ''}>${busy ? 'Disparando…' : '▶ Disparar'}</button>
        <button type="button" class="ghost-btn" data-rmact="note" data-id="${t.id}">✎ Nota</button>
        ${qaRetry ? `<button type="button" class="qa-retry-btn" data-rmact="qaretry" data-run="${esc(run.taskId)}">🔄 Corrigir recusa QA</button>` : ''}
      </td>
    </tr>`;
  }

  function renderView() {
    const count = pred => st.list.filter(pred).length;
    const chip = ([k, label, pred]) => `<button type="button" data-rmact="filter" data-filter="${k}" aria-pressed="${st.filter === k}">${label} <span class="count">${count(pred)}</span></button>`;
    const pred = (FILTERS.find(f => f[0] === st.filter) || FILTERS[0])[2];
    const items = st.list.filter(pred);
    const empty = st.loading && !st.at ? 'Carregando tickets do Redmine…' : 'Nenhum ticket com esse filtro.';
    return `<div class="vhead"><h2>Redmine</h2><p>Tickets abertos atribuídos a você, com o run e o PR vinculados. Clique no número para ver o histórico e mudar status ou comentar sem sair do dashboard.</p>
        <div class="vtools"><div class="seg-ctl" role="group" aria-label="Filtro">${FILTERS.map(chip).join('')}</div>
          <button class="ghost-btn" type="button" data-rmact="refresh" ${st.loading ? 'disabled' : ''}>${st.loading ? 'Atualizando…' : '↻ Atualizar'}</button></div>
        ${st.error ? `<p class="fold-msg warn">Não foi possível carregar os tickets: ${esc(st.error)}</p>` : ''}</div>
      <div class="rm-scroll"><table class="mt-table rm-table"><thead><tr><th>ID</th><th>Título</th><th>Prioridade</th><th>Status</th><th>Run</th><th>PR</th><th>Atualizado</th><th>Ações</th></tr></thead>
        <tbody>${items.map(row).join('') || `<tr><td colspan="8" class="vempty">${empty}</td></tr>`}</tbody></table></div>`;
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
      <div class="rm-journal-head"><b>${esc(j.user || 'Sistema')}</b> <span class="muted" title="${esc(when(j.created_on))}">${esc(ago(j.created_on))}</span>
        ${rejected ? '<span class="qa-badge">⊘ RECUSADA QA</span>' : ''}${j.private_notes ? ' <span class="muted">(nota privada)</span>' : ''}</div>
      ${details.length ? `<ul class="rm-changes">${details.map(d => `<li class="${d.name === 'status_id' && isQaRejected(d.new_label) ? 'rm-change-rejected' : ''}">${detailLine(d)}</li>`).join('')}</ul>` : ''}
      ${j.notes ? `<div class="rm-note">${esc(j.notes)}</div>` : ''}
    </li>`;
  }

  function renderDrawer() {
    if (!isOpen()) return;
    const body = $('rmDrawerBody');
    $('rmDrawerTitle').textContent = `#${dr.id}`;
    if (dr.loading) { body.innerHTML = '<div class="log-drawer-empty">Carregando ticket…</div>'; return; }
    if (dr.error) { body.innerHTML = `<div class="log-drawer-empty">Não foi possível carregar o ticket: ${esc(dr.error)}</div>`; return; }
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
    body.innerHTML = `
      <header class="rm-dhead">
        <h4>${esc(t.subject)}</h4>
        <div class="rm-badges">${priorityBadge(t.priority)} ${t.status ? ticketStatusBadge(t.status) : ''}</div>
        <div class="rm-links">
          ${t.url ? `<a class="ext" href="${esc(t.url)}" target="_blank" rel="noopener noreferrer">Redmine ↗</a>` : ''}
          ${prUrl ? `<a class="ext" href="${esc(prUrl)}" target="_blank" rel="noopener noreferrer">PR no Bitbucket ↗</a>` : ''}
          ${linkedRun ? `<button type="button" class="run-link" data-rmact="run" data-run="${esc(linkedRun.taskId)}">Run ${esc(linkedRun.taskId)}</button>` : ''}
        </div>
        <div class="rm-meta muted">${[t.tracker, t.assignee && `Com ${t.assignee}`, t.updated_on && `atualizado ${ago(t.updated_on)}`].filter(Boolean).map(esc).join(' · ')}</div>
      </header>
      <section class="rm-sec"><h5>Descrição</h5>
        ${desc ? `<div class="rm-desc">${esc(dr.descOpen || !long ? desc : `${desc.slice(0, 500)}…`)}</div>
          ${long ? `<button type="button" class="link-btn" data-rmact="desc">${dr.descOpen ? 'ver menos' : 'ver mais'}</button>` : ''}` : '<p class="muted">Sem descrição.</p>'}
      </section>
      <section class="rm-sec"><h5>Ações rápidas</h5>
        <div class="rm-form">
          <label>Status <select id="rmStatus" ${busy ? 'disabled' : ''}>${options.map(s => `<option value="${s.id}" ${String(s.id) === sel ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</select></label>
          <label>Nota (opcional para status) <textarea id="rmNote" rows="4" maxlength="20000" placeholder="Comentário que vai para o histórico do ticket" ${busy ? 'disabled' : ''}>${esc(prevNote)}</textarea></label>
          <div class="rm-form-actions">
            <button type="button" class="send" data-rmact="save" ${busy ? 'disabled' : ''}>${busy === 'save' ? 'Salvando…' : 'Salvar'}</button>
            <button type="button" class="ghost-btn" data-rmact="addnote" ${busy ? 'disabled' : ''}>${busy === 'note' ? 'Enviando…' : 'Adicionar nota'}</button>
            <button type="button" class="ghost-btn" data-rmact="start" data-id="${t.id}" ${starting ? 'disabled aria-busy="true"' : ''}>${starting ? 'Disparando…' : '▶ Disparar run'}</button>
          </div>
        </div>
      </section>
      <section class="rm-sec"><h5>Histórico <span class="muted">(${items.length})</span></h5>
        ${items.length ? `<ol class="rm-timeline">${items.join('')}</ol>` : '<p class="muted">Nenhuma alteração ou nota registrada.</p>'}
      </section>`;
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
