// Aba "PRs": os PRs do dono do token no repo primário e nos irmãos (GET /api/prs), com
// status visual, vínculo a run/ticket, e aprovação inline (POST
// /api/prs/:id/approve). Mesmo padrão de patterns.js/graph.js: módulo IIFE
// carregado depois de views.js, cache local, plugado em VIEWS/RENDER de
// views.js via window.PrsView. Usa os globais de index.html/views.js: api(),
// esc(), ago(), when(), toast(), $().
(() => {
  const st = { data: null, loading: false, error: null, loadedOnce: false, filter: 'all', busy: new Set() };

  async function load() {
    st.loading = true; st.error = null;
    window.Views?.refresh();
    try {
      st.data = await api('/api/prs');
    } catch (e) {
      st.error = e.message;
    }
    st.loading = false; st.loadedOnce = true;
    window.Views?.refresh();
  }

  // OPEN sem reviewer que já aprovou => "aguardando review". Conflito
  // (hasConflicts === true) tem prioridade sobre os dois. A API do Bitbucket
  // não expõe conflito: o servidor calcula com git merge-tree local
  // (scripts/lib/pr-conflicts.js); null = não deu pra calcular.
  // Reaproveita as cores de .tk-status-* já usadas pro badge de status do
  // ticket Redmine (index.html) — nunca inventar cor nova pra badge de status.
  function statusOf(pr) {
    if (pr.state === 'MERGED') return { key: 'merged', label: 'MERGEADO', cls: 'tk-status-clear' };
    if (pr.state === 'DECLINED') return { key: 'declined', label: 'Recusado', cls: 'tk-status-idle' };
    if (pr.state === 'OPEN') {
      if (pr.hasConflicts === true) return { key: 'conflict', label: 'CONFLITO', cls: 'tk-status-risk' };
      const anyApproved = (pr.reviewers || []).some(r => r.approved);
      if (!anyApproved) return { key: 'waiting', label: 'AGUARDANDO', cls: 'tk-status-attention' };
      return { key: 'open', label: 'ABERTO', cls: 'tk-status-signal' };
    }
    return { key: 'unknown', label: pr.state || '?', cls: 'tk-status-idle' };
  }

  const FILTERS = [
    ['all', 'Todos', () => true],
    ['open', 'Abertos', p => p.state === 'OPEN'],
    ['merged', 'Mergeados', p => p.state === 'MERGED'],
    ['conflict', 'Conflito', p => statusOf(p).key === 'conflict'],
    ['waiting', 'Aguardando review', p => statusOf(p).key === 'waiting'],
  ];

  // Número de PR se repete entre repos irmãos: a chave é "<repo>#<id>".
  const keyOf = pr => `${pr.repo || ''}#${pr.id}`;

  function initials(name) {
    return String(name || '?').trim().split(/\s+/).slice(0, 2).map(w => w[0]?.toUpperCase() || '').join('') || '?';
  }

  async function approve(pr) {
    if (st.busy.has(keyOf(pr))) return;
    st.busy.add(keyOf(pr));
    window.Views?.refresh();
    try {
      await api(`/api/prs/${pr.id}/approve?repo=${encodeURIComponent(pr.repo || '')}`, { method: 'POST' });
      toast('PR aprovado ✓');
      await load();
    } catch (e) {
      toast(`Falha ao aprovar: ${e.message}`);
      st.busy.delete(keyOf(pr));
      window.Views?.refresh();
    }
  }

  function row(pr) {
    const status = statusOf(pr);
    const branch = `${pr.repo ? `<span class="muted">${esc(pr.repo)}</span> ` : ''}${esc(pr.sourceBranch || '?')} → ${esc(pr.targetBranch || '?')}`;
    const ticket = pr.linkedRun?.ticketId && pr.linkedRun?.ticketUrl
      ? `<a class="badge-link" href="${esc(pr.linkedRun.ticketUrl)}" target="_blank" rel="noopener noreferrer">#${esc(String(pr.linkedRun.ticketId))}</a>`
      : pr.linkedRun?.ticketId
        ? `<span class="muted" title="Redmine não configurado">#${esc(String(pr.linkedRun.ticketId))}</span>`
        : (pr.linkedRun?.taskId ? `<span class="muted" title="${esc(pr.linkedRun.taskId)}">sem ticket</span>` : '<span class="muted">—</span>');
    const reviewers = (pr.reviewers || []).length
      ? pr.reviewers.map(r => `<span class="rev-avatar ${r.approved ? 'approved' : 'pending'}" title="${esc(r.displayName)}${r.approved ? ' — aprovado' : ' — pendente'}">${esc(initials(r.displayName))}</span>`).join('')
      : '<span class="muted">Sem reviewers</span>';
    const busy = st.busy.has(keyOf(pr));
    const canApprove = pr.canApprove && pr.state === 'OPEN';
    return `<tr>
      <td><a href="${esc(pr.url)}" target="_blank" rel="noopener noreferrer">${esc(pr.title)}</a></td>
      <td class="mono">${branch}</td>
      <td>${ticket}</td>
      <td class="pr-reviewers">${reviewers}</td>
      <td><span class="tk-status ${status.cls}"${status.key === 'conflict' && pr.conflictFiles?.length ? ` title="Conflito em:\n${esc(pr.conflictFiles.join('\n'))}"` : ''}>${esc(status.label)}</span></td>
      <td>${esc(ago(pr.updatedOn))}</td>
      <td class="pr-actions">
        ${canApprove ? `<button class="ghost-btn" type="button" data-pr-approve="${esc(keyOf(pr))}" ${busy ? 'disabled' : ''}>${busy ? 'Aprovando…' : 'Aprovar'}</button>` : ''}
        <a href="${esc(pr.url)}/diff" target="_blank" rel="noopener noreferrer">Ver diff</a>
      </td>
    </tr>`;
  }

  function render() {
    if (!st.loadedOnce && !st.loading) load();
    const head = `<div class="vhead"><h2>PRs</h2>
      <p>Seus PRs abertos e os 20 mergeados mais recentes${st.data?.repos?.length ? ` em ${esc(st.data.repos.join(', '))}` : ''}, com vínculo ao ticket/run de origem quando existir.</p>
      <div class="vtools"><div class="seg-ctl" role="group" aria-label="Filtro">${FILTERS.map(([k, label]) =>
        `<button type="button" data-pr-filter="${k}" aria-pressed="${st.filter === k}">${esc(label)}</button>`).join('')}</div>
        <button class="ghost-btn" type="button" data-pr-reload ${st.loading ? 'disabled' : ''}>${st.loading ? 'Carregando…' : '↻ Atualizar'}</button>
      </div></div>`;
    if (st.error) return `${head}<p class="fold-msg warn">Não deu para consultar o Bitbucket: ${esc(st.error)}</p>`;
    if (!st.data) return `${head}<div class="vempty">Carregando…</div>`;
    const warn = (st.data.warnings || []).length ? `<p class="fold-msg warn">Repos não consultados: ${esc(st.data.warnings.join('; '))}</p>` : '';
    const filterFn = (FILTERS.find(([k]) => k === st.filter) || FILTERS[0])[2];
    const prs = st.data.prs.filter(filterFn).sort((a, b) => (Date.parse(b.updatedOn) || 0) - (Date.parse(a.updatedOn) || 0));
    if (!prs.length) return `${head}${warn}<div class="vempty">Nenhum PR com esse filtro.</div>`;
    return `${head}${warn}<table class="pr-table">
      <thead><tr><th>Título</th><th>Branch</th><th>Ticket</th><th>Reviewers</th><th>Status</th><th>Idade</th><th>Ações</th></tr></thead>
      <tbody>${prs.map(row).join('')}</tbody>
    </table>`;
  }

  const view = $('view');
  view.addEventListener('click', e => {
    if (e.target.closest('[data-pr-reload]')) { load(); return; }
    const f = e.target.closest('[data-pr-filter]');
    if (f) { st.filter = f.dataset.prFilter; window.Views?.refresh(); return; }
    const a = e.target.closest('[data-pr-approve]');
    if (a) {
      const pr = st.data?.prs.find(p => keyOf(p) === a.dataset.prApprove);
      if (pr) approve(pr);
    }
  });

  // Auto-refresh 60s, só com a aba "prs" ativa e a página visível (Page
  // Visibility API) — cancela nos dois casos, retoma quando voltam a valer.
  function tick() {
    if (!document.hidden && document.body.dataset.view === 'prs') load();
  }
  setInterval(tick, 60000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) tick(); });

  const style = document.createElement('style');
  style.textContent = `
    .pr-table { width: 100%; border-collapse: collapse; font-size: 13px; }
    .pr-table th, .pr-table td { padding: 8px 10px; border-bottom: 1px solid var(--line-soft); text-align: left; vertical-align: middle; }
    .pr-table .mono { font: 12px var(--mono); }
    .pr-reviewers { display: flex; gap: 4px; flex-wrap: wrap; }
    .rev-avatar { display: inline-flex; align-items: center; justify-content: center; width: 22px; height: 22px; border-radius: 50%; font-size: 10px; font-weight: 600; }
    .rev-avatar.approved { background: var(--clear-bg); color: var(--clear); }
    .rev-avatar.pending { background: var(--sunken); color: var(--muted); }
    .pr-actions { display: flex; gap: 8px; align-items: center; white-space: nowrap; }
    .badge-link { text-decoration: underline; }
  `;
  document.head.appendChild(style);

  window.PrsView = { render, load };
  window.Views?.refresh();
})();
