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
  // Design Espectro: estado = glifo + cor, sempre pelas classes compartilhadas
  // .pill.<estado> de theme.css — nunca inventar cor nova pra badge de status.
  function statusOf(pr) {
    if (pr.state === 'MERGED') return { key: 'merged', label: 'MERGEADO', tone: 'done', glyph: '✓' };
    if (pr.state === 'DECLINED') return { key: 'declined', label: 'Recusado', tone: 'failed', glyph: '✕' };
    if (pr.state === 'OPEN') {
      if (pr.hasConflicts === true) return { key: 'conflict', label: 'CONFLITO', tone: 'failed', glyph: '✕' };
      const anyApproved = (pr.reviewers || []).some(r => r.approved);
      if (!anyApproved) return { key: 'waiting', label: 'AGUARDANDO', tone: 'waiting', glyph: '‖' };
      return { key: 'open', label: 'ABERTO', tone: 'running', glyph: '◐' };
    }
    return { key: 'unknown', label: pr.state || '?', tone: 'queued', glyph: '○' };
  }

  // Ícone de PR por estado (artboard PullRequests): forma muda junto com a cor.
  const circ = (x, y, r) => `M${x - r} ${y}a${r} ${r} 0 1 0 ${2 * r} 0a${r} ${r} 0 1 0 ${-2 * r} 0`;
  const ICON_BASE = circ(6, 6, 2.5) + circ(6, 18, 2.5);
  const ICONS = {
    open: ICON_BASE + circ(18, 18, 2.5) + 'M6 8.5v7M18 15.5V9a3 3 0 0 0-3-3h-4M13 3l-3 3 3 3',
    merged: ICON_BASE + circ(18, 12, 2.5) + 'M6 8.5v7M8 7.5c2 3 4.5 4.5 7.5 4.5',
    declined: ICON_BASE + 'M6 8.5v7M15.5 13.5l5 5M20.5 13.5l-5 5',
  };
  const iconOf = key => ICONS[key] || ICONS.open;

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

  // Linha de PR no formato do artboard: ícone de estado, "#id · repo" + idade em
  // mono, título (link pro Bitbucket), branch origem → destino em mono, estado,
  // revisores e vínculo ao ticket/run de origem; ações à direita.
  function row(pr) {
    const status = statusOf(pr);
    const conflictTitle = status.key === 'conflict' && pr.conflictFiles?.length
      ? ` title="Conflito em:\n${esc(pr.conflictFiles.join('\n'))}"` : '';
    const ticket = pr.linkedRun?.ticketId && pr.linkedRun?.ticketUrl
      ? `<a class="badge-link" href="${esc(pr.linkedRun.ticketUrl)}" target="_blank" rel="noopener noreferrer">#${esc(String(pr.linkedRun.ticketId))}</a>`
      : pr.linkedRun?.ticketId
        ? `<span class="muted" title="Redmine não configurado">#${esc(String(pr.linkedRun.ticketId))}</span>`
        : (pr.linkedRun?.taskId ? `<span class="muted" title="${esc(pr.linkedRun.taskId)}">sem ticket</span>` : '<span class="muted">—</span>');
    const run = pr.linkedRun?.taskId ? `<span class="prs-run mono" title="Run de origem">run ${esc(pr.linkedRun.taskId)}</span>` : '';
    const revs = pr.reviewers || [];
    const approvedN = revs.filter(r => r.approved).length;
    const reviewers = revs.length
      ? `<span class="prs-avatars">${revs.map(r => `<span class="rev-avatar ${r.approved ? 'approved' : 'pending'}" title="${esc(r.displayName)}${r.approved ? ' — aprovado' : ' — pendente'}">${esc(initials(r.displayName))}</span>`).join('')}</span>
         <span class="prs-revcount num${approvedN && approvedN === revs.length ? ' all' : ''}">${approvedN} de ${revs.length} aprovações</span>`
      : '<span class="muted">Sem reviewers</span>';
    const busy = st.busy.has(keyOf(pr));
    const canApprove = pr.canApprove && pr.state === 'OPEN';
    const age = ago(pr.updatedOn);
    const conflictLine = status.key === 'conflict' && pr.conflictFiles?.length
      ? `<p class="prs-conflict"><span aria-hidden="true">✕</span> Conflito em: <span class="mono">${esc(pr.conflictFiles.join(', '))}</span></p>` : '';
    return `<li class="prs-row" data-state="${esc(status.key)}">
      <svg class="prs-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${iconOf(status.key)}"/></svg>
      <div class="prs-main">
        <div class="prs-meta mono"><span>#${esc(String(pr.id))}</span>${pr.repo ? `<span class="prs-repo">· ${esc(pr.repo)}</span>` : ''}
          <span class="prs-age"${when(pr.updatedOn) ? ` title="${esc(when(pr.updatedOn))}"` : ''}><span class="sr-only">Atualizado </span>${age ? esc(age) : '—'}</span></div>
        <a class="prs-title" href="${esc(pr.url)}" target="_blank" rel="noopener noreferrer">${esc(pr.title)}</a>
        <div class="prs-branch mono"><code>${esc(pr.sourceBranch || '?')}</code><span aria-hidden="true">→</span><span class="sr-only">para</span><code>${esc(pr.targetBranch || '?')}</code></div>
        <div class="prs-facts">
          <span class="pill ${status.tone}"${conflictTitle}><span aria-hidden="true">${status.glyph}</span>${esc(status.label)}</span>
          <span class="pr-reviewers">${reviewers}</span>
          <span class="prs-link"><span class="prs-k">Ticket</span> ${ticket}${run}</span>
        </div>
        ${conflictLine}
      </div>
      <div class="pr-actions">
        ${canApprove ? `<button class="btn" type="button" data-pr-approve="${esc(keyOf(pr))}" ${busy ? 'disabled aria-busy="true"' : ''}>${busy ? 'Aprovando…' : 'Aprovar'}</button>` : ''}
        <a class="btn" href="${esc(pr.url)}/diff" target="_blank" rel="noopener noreferrer">Ver diff</a>
      </div>
    </li>`;
  }

  function skeleton() {
    return `<p class="source-note" role="status">Carregando…</p>
      <ul class="prs-list prs-skel" aria-hidden="true">${[62, 48, 70, 54].map(w =>
        `<li class="prs-row"><span class="prs-sk prs-sk-icon"></span><div class="prs-main"><span class="prs-sk" style="width:24%"></span><span class="prs-sk prs-sk-title" style="width:${w}%"></span><span class="prs-sk" style="width:36%"></span></div></li>`).join('')}</ul>`;
  }

  function render() {
    if (!st.loadedOnce && !st.loading) load();
    const all = st.data?.prs || [];
    const count = fn => all.filter(fn).length;
    const head = `<div class="vhead"><h2>PRs</h2>
      <p>Seus PRs abertos e os 20 mergeados mais recentes${st.data?.repos?.length ? ` em ${esc(st.data.repos.join(', '))}` : ''}, com vínculo ao ticket/run de origem quando existir.</p>
      <div class="vtools"><div class="seg" role="group" aria-label="Filtro">${FILTERS.map(([k, label, fn]) =>
        `<button type="button" data-pr-filter="${k}" aria-pressed="${st.filter === k}">${esc(label)}${st.data ? ` <span class="num">${count(fn)}</span>` : ''}</button>`).join('')}</div>
        <button class="btn" type="button" data-pr-reload ${st.loading ? 'disabled aria-busy="true"' : ''}>${st.loading ? 'Carregando…' : '↻ Atualizar'}</button>
      </div></div>`;
    const wrap = body => `<div class="prs-screen">${head}${body}</div>`;
    if (st.error) return wrap(`<div class="prs-error" role="alert"><span class="prs-error-glyph" aria-hidden="true">✕</span><p class="fold-msg warn">Não deu para consultar o Bitbucket: ${esc(st.error)}</p></div>`);
    if (!st.data) return wrap(skeleton());
    const warn = (st.data.warnings || []).length ? `<p class="fold-msg warn prs-warn"><span aria-hidden="true">‖</span> Repos não consultados: ${esc(st.data.warnings.join('; '))}</p>` : '';
    const source = `<p class="source-note prs-source">fonte: Bitbucket · GET /api/prs${st.data.fetched_at ? ` · consultado ${esc(ago(st.data.fetched_at))}` : ''} · conflito: git merge-tree local</p>`;
    const filterFn = (FILTERS.find(([k]) => k === st.filter) || FILTERS[0])[2];
    const prs = all.filter(filterFn).sort((a, b) => (Date.parse(b.updatedOn) || 0) - (Date.parse(a.updatedOn) || 0));
    if (!prs.length) return wrap(`${warn}<div class="vempty">Nenhum PR com esse filtro.</div>${source}`);
    return wrap(`${warn}<ul class="prs-list" aria-label="Pull requests">${prs.map(row).join('')}</ul>${source}`);
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

  window.PrsView = { render, load };
  window.Views?.refresh();
})();
