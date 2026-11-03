// Aba "Grafo": Knowledge Graph de rastreabilidade (GET /api/graph, gravado pelo watcher
// e pelo /commit em memory/knowledge-graph.json). Lista navegável por ticket:
// ticket → spec → [arquivos] → PRs. Clicar num arquivo mostra todos os tickets que o
// tocaram; clicar no ticket recorta só ele. Script clássico carregado depois de
// views.js: usa os globais do principal (esc, ago, when, api, runs, ticketIdOfRun, $).
// Estilos em screens/graph.css (design Espectro: trilha por ticket, tipo de nó com glifo + cor).
(() => {
  const st = { data: null, loading: false, error: null, filter: { taskId: '', file: '' }, loadedFor: null };
  const FILES_OPEN = 12;
  const qs = f => new URLSearchParams(Object.entries(f).filter(([, v]) => v)).toString();

  async function load(filter = st.filter) {
    st.filter = { taskId: filter.taskId || '', file: filter.file || '' };
    st.loading = true; st.error = null;
    window.Views?.refresh();
    try {
      st.data = await api(`/api/graph${qs(st.filter) ? `?${qs(st.filter)}` : ''}`);
      st.loadedFor = qs(st.filter);
    } catch (e) { st.error = e.message; }
    st.loading = false;
    window.Views?.refresh();
  }

  // Número/TASK-/task-id → recorte por ticket; qualquer outra coisa é caminho de arquivo.
  function parseQuery(q) {
    q = q.trim();
    if (!q) return { taskId: '', file: '' };
    if (/^(TASK-)?\d{4,6}(-[\w-]+)?$/i.test(q) || /^#\d{4,6}$/.test(q)) return { taskId: q.replace(/^#/, ''), file: '' };
    return { taskId: '', file: q };
  }

  const repoOf = f => f.repo || 'app-back';
  const shortPath = id => id.replace(/^(?:app-front|app-core|mo-entity)\//, '').replace(/^src\/main\/java\/br\/com\/mosistemas\//, '…/').replace(/^src\/test\/java\/br\/com\/mosistemas\//, 'test …/');
  const prState = s => { const u = String(s || '').toUpperCase(); return ['OPEN', 'MERGED', 'DECLINED', 'SUPERSEDED'].includes(u) ? u : 'unknown'; };

  function runsOfTicket(ticketId) {
    if (typeof runs === 'undefined') return [];
    return [...runs.values()].filter(r => String(ticketIdOfRun(r) || '') === String(ticketId));
  }

  // Tipo de nó: glifo + cor (identidade). Estado de PR: glifo + cor de estado (screens/graph.css).
  const GLYPH = { spec: '§', file: '◇', pr: '⇄', run: '▶' };
  const PR_TONE = {
    MERGED: ['done', '✓'], OPEN: ['waiting', '‖'], DECLINED: ['failed', '✕'], SUPERSEDED: ['queued', '↷'], unknown: ['queued', ''],
  };
  const glyph = k => `<span class="kg-glyph kg-glyph-${k}" aria-hidden="true">${GLYPH[k]}</span>`;
  const colHead = (label, n) => `<h3 class="label kg-col-head"><span>${label}</span><span class="kg-col-n">${n}</span></h3>`;
  const arrow = '<span class="kg-arrow" aria-hidden="true">→</span>';

  function fileList(files) {
    if (!files.length) return '<p class="kg-none">Nenhum arquivo registrado ainda (o grafo ganha arquivos a partir do implement).</p>';
    const byRepo = new Map();
    for (const f of files) { const r = repoOf(f); if (!byRepo.has(r)) byRepo.set(r, []); byRepo.get(r).push(f); }
    const item = f => `<li><button type="button" class="kg-node kg-file ${f.lang === 'java' ? 'java' : ''}" data-kg-file="${esc(f.id)}" title="${esc(`${f.id} — ver todos os tickets que tocaram este arquivo`)}">${glyph('file')}<span class="kg-node-name">${esc(shortPath(f.id))}</span></button></li>`;
    return [...byRepo.entries()].map(([repo, fs]) => {
      fs.sort((a, b) => (b.lang === 'java') - (a.lang === 'java') || a.id.localeCompare(b.id));
      const head = `<span class="kg-repo">${esc(repo)}</span> <span class="kg-repo-n">${fs.length}</span>`;
      const list = `<ul class="kg-files">${fs.map(item).join('')}</ul>`;
      return fs.length > FILES_OPEN && !st.filter.file
        ? `<details class="kg-repo-group"><summary>${head}</summary>${list}</details>`
        : `<div class="kg-repo-group"><div class="kg-repo-head">${head}</div>${list}</div>`;
    }).join('');
  }

  function prNode(p) {
    const s = prState(p.status);
    const [tone, g] = PR_TONE[s];
    const pill = s === 'unknown'
      ? '<span class="pill queued kg-pr-state" title="Status desconhecido">?</span>'
      : `<span class="pill ${tone} kg-pr-state">${g ? `<span aria-hidden="true">${g}</span>` : ''}${esc(s)}</span>`;
    const inner = `${glyph('pr')}<span class="kg-node-name">${esc(`${p.repo || ''} #${p.number || ''}`)}</span>${pill}`;
    return p.url
      ? `<a class="kg-node kg-pr" href="${esc(p.url)}" target="_blank" rel="noopener noreferrer" title="${esc(p.id)}">${inner}</a>`
      : `<span class="kg-node kg-pr" title="${esc(p.id)}">${inner}</span>`;
  }

  function card(t) {
    const num = t.ticket_id || t.id.replace(/^TASK-/, '');
    const rs = runsOfTicket(num);
    const specs = t.specs.length
      ? t.specs.map(s => `<span class="kg-node kg-spec" title="${esc(s.id)}">${glyph('spec')}<span class="kg-node-name">${esc(s.id)}</span></span>`).join('')
      : '<p class="kg-none">Sem spec registrada</p>';
    const prs = t.prs.length ? t.prs.map(prNode).join('') : '<p class="kg-none">Nenhum PR</p>';
    const runsCol = rs.length ? `${arrow}<section class="kg-col kg-col-run" aria-label="Runs">${colHead('Runs', rs.length)}
        <div class="kg-nodes">${rs.map(r => `<span class="kg-node kg-run" role="button" tabindex="0" data-open="${esc(r.taskId)}" title="${esc(`Abrir o run ${r.taskId}`)}">${glyph('run')}<span class="kg-node-name">${esc(r.taskId.replace(/^\d{4,6}-/, ''))}</span></span>`).join('')}</div></section>` : '';
    return `<article class="panel kg-card">
      <header class="kg-card-head">
        <button type="button" class="kg-ticket" data-kg-ticket="${esc(num)}" title="Recortar o grafo neste ticket">#${esc(num)}</button>
        <span class="kg-card-title">${esc(t.title || t.id)}</span>
        ${t.redmine_url ? `<a class="kg-ext" href="${esc(t.redmine_url)}" target="_blank" rel="noopener noreferrer">Redmine ↗</a>` : ''}
      </header>
      <div class="kg-trail${rs.length ? ' has-runs' : ''}">
        <section class="kg-col kg-col-spec" aria-label="Spec">${colHead('Spec', t.specs.length)}<div class="kg-nodes">${specs}</div></section>
        ${arrow}
        <section class="kg-col kg-col-file" aria-label="Arquivos">${colHead('Arquivos', t.files.length)}<div class="kg-filebox">${fileList(t.files)}</div></section>
        ${arrow}
        <section class="kg-col kg-col-pr" aria-label="PRs">${colHead('PRs', t.prs.length)}<div class="kg-nodes">${prs}</div></section>
        ${runsCol}
      </div>
    </article>`;
  }

  const legend = `<ul class="kg-legend" aria-label="Legenda do grafo">
      <li><span class="kg-swatch ticket" aria-hidden="true">#</span>ticket</li>
      <li>${glyph('spec')}spec</li>
      <li>${glyph('file')}arquivo <span class="kg-legend-note">(.java em destaque)</span></li>
      <li>${glyph('pr')}pull request</li>
      <li>${glyph('run')}run</li>
      <li class="kg-legend-sep" aria-hidden="true"></li>
      <li><span class="kg-arrow" aria-hidden="true">→</span>relação registrada no grafo</li>
    </ul>`;

  function render() {
    if (st.loadedFor !== qs(st.filter) && !st.loading && !st.error) { load(); }
    const d = st.data;
    const f = st.filter;
    const q = f.taskId || f.file;
    const scope = f.file ? `Tickets que tocaram <code>${esc(f.file)}</code>` : f.taskId ? `Ticket ${esc(f.taskId)}` : 'Todos os tickets';
    const head = `<div class="kg-head">
      <div class="kg-title">
        <p class="label">Conhecimento · grafo</p>
        <h2 class="t-title">Grafo</h2>
        <p class="kg-lede">Rastreabilidade ticket → spec → arquivos → PR, lida de <code>memory/knowledge-graph.json</code>. O watcher atualiza a cada tick e o <code>/commit</code> ao abrir o PR. Clique num arquivo para ver todos os tickets que o tocaram.</p>
      </div>
      ${d?.updatedAt ? `<p class="kg-updated" title="${esc(when(d.updatedAt))}">grafo atualizado ${esc(ago(d.updatedAt))}</p>` : ''}
    </div>
    <form class="panel kg-tools" data-kg-form role="search">
      <div class="kg-search">
        <svg class="kg-search-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg>
        <input type="search" name="q" class="kg-q" value="${esc(q)}" placeholder="Nº do ticket ou caminho do arquivo (ex.: CalculoFreteService.java)" aria-label="Filtrar o grafo" autocomplete="off">
      </div>
      <button class="btn primary lg" type="submit">Filtrar</button>
      ${q ? '<button class="btn lg" type="button" data-kg-clear>Limpar</button>' : ''}
      <button class="btn lg" type="button" data-kg-reload ${st.loading ? 'disabled' : ''}>${st.loading ? 'Carregando…' : '↻ Atualizar'}</button>
    </form>`;
    const wrap = body => `<section class="kg">${head}${body}</section>`;
    if (st.error) return wrap(`<p class="kg-msg failed" role="alert"><span aria-hidden="true">✕</span> Não deu para ler o grafo: ${esc(st.error)}</p>`);
    if (!d) return wrap('<div class="panel empty">Carregando…</div>');
    if (!d.exists) return wrap('<div class="panel empty">Ainda não existe <code>memory/knowledge-graph.json</code>. Ele é criado no próximo tick do watcher ou pelo <code>/commit</code>.</div>');
    const nFiles = d.tickets.reduce((a, t) => a + t.files.length, 0);
    const nPrs = d.tickets.reduce((a, t) => a + t.prs.length, 0);
    const kpi = (label, n, hint) => `<div class="kpi"><span class="kpi-label">${label}</span><span class="kpi-value kg-kpi-value">${n}</span><span class="kpi-hint">${hint}</span></div>`;
    return wrap(`<div class="kg-summary">
        <p class="kg-scope">${scope}</p>
        <div class="kpis kg-kpis">
          ${kpi('Tickets', d.tickets.length, 'tickets no recorte')}
          ${kpi('Arquivos', nFiles, 'soma dos arquivos por ticket')}
          ${kpi('PRs', nPrs, 'soma dos PRs por ticket')}
        </div>
        <p class="source-note">Fonte: <code>memory/knowledge-graph.json</code> via <code>GET /api/graph</code>, no recorte acima.</p>
      </div>
      ${legend}
      <div class="kg-list">${d.tickets.map(card).join('') || '<div class="panel empty">Nada no grafo para esse filtro.</div>'}</div>`);
  }

  const view = $('view');
  view.addEventListener('submit', e => {
    if (!e.target.matches('[data-kg-form]')) return;
    e.preventDefault();
    load(parseQuery(new FormData(e.target).get('q') || ''));
  });
  view.addEventListener('click', e => {
    const fb = e.target.closest('[data-kg-file]');
    if (fb) { load({ file: fb.dataset.kgFile }); view.scrollTop = 0; return; }
    const tb = e.target.closest('[data-kg-ticket]');
    if (tb) { load({ taskId: tb.dataset.kgTicket }); view.scrollTop = 0; return; }
    if (e.target.closest('[data-kg-clear]')) { load({}); return; }
    if (e.target.closest('[data-kg-reload]')) load();
  });

  window.GraphView = { render, load };
  // Página aberta direto em #grafo: views.js já renderizou o placeholder antes de nós.
  window.Views?.refresh();
})();
