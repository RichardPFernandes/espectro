// Aba "Grafo": Knowledge Graph de rastreabilidade (GET /api/graph, gravado pelo watcher
// e pelo /commit em memory/knowledge-graph.json). Lista navegável por ticket:
// ticket → spec → [arquivos] → PRs. Clicar num arquivo mostra todos os tickets que o
// tocaram; clicar no ticket recorta só ele. Script clássico carregado depois de
// views.js: usa os globais do principal (esc, ago, when, api, runs, ticketIdOfRun, $).
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

  function fileList(files) {
    if (!files.length) return '<span class="muted">Nenhum arquivo registrado ainda (o grafo ganha arquivos a partir do implement).</span>';
    const byRepo = new Map();
    for (const f of files) { const r = repoOf(f); if (!byRepo.has(r)) byRepo.set(r, []); byRepo.get(r).push(f); }
    const item = f => `<li><button type="button" class="kg-file ${f.lang === 'java' ? 'java' : ''}" data-kg-file="${esc(f.id)}" title="${esc(`${f.id} — ver todos os tickets que tocaram este arquivo`)}">${esc(shortPath(f.id))}</button></li>`;
    return [...byRepo.entries()].map(([repo, fs]) => {
      fs.sort((a, b) => (b.lang === 'java') - (a.lang === 'java') || a.id.localeCompare(b.id));
      const head = `<span class="kg-repo">${esc(repo)}</span> <span class="count">${fs.length}</span>`;
      const list = `<ul class="kg-files">${fs.map(item).join('')}</ul>`;
      return fs.length > FILES_OPEN && !st.filter.file
        ? `<details class="kg-repo-group"><summary>${head}</summary>${list}</details>`
        : `<div class="kg-repo-group">${head}${list}</div>`;
    }).join('');
  }

  function card(t) {
    const num = t.ticket_id || t.id.replace(/^TASK-/, '');
    const rs = runsOfTicket(num);
    const specs = t.specs.length ? t.specs.map(s => `<code>${esc(s.id)}</code>`).join(' ') : '<span class="muted">Sem spec registrada</span>';
    const prs = t.prs.length ? t.prs.map(p => {
      const s = prState(p.status);
      const inner = `<span class="pr-badge ${s}">${esc(s === 'unknown' ? '?' : s)}</span><span class="pr-id">${esc(`${p.repo || ''} #${p.number || ''}`)}</span>`;
      return p.url ? `<a class="pr-line" href="${esc(p.url)}" target="_blank" rel="noopener noreferrer" title="${esc(p.id)}">${inner}</a>` : `<span class="pr-line" title="${esc(p.id)}">${inner}</span>`;
    }).join('') : '<span class="muted">Nenhum PR</span>';
    return `<article class="tcard kg-card">
      <header><button type="button" class="tnum kg-ticket" data-kg-ticket="${esc(num)}" title="Recortar o grafo neste ticket">#${esc(num)}</button>
        <span class="tsubj">${esc(t.title || t.id)}</span>
        ${t.redmine_url ? `<a class="ext" href="${esc(t.redmine_url)}" target="_blank" rel="noopener noreferrer">Redmine ↗</a>` : ''}</header>
      <div class="tline"><span class="tlabel">Spec</span><div class="tvals">${specs}</div></div>
      <div class="tline"><span class="tlabel">Arquivos</span><div class="tvals kg-filebox">${fileList(t.files)}</div></div>
      <div class="tline"><span class="tlabel">PRs</span><div class="tvals prs">${prs}</div></div>
      ${rs.length ? `<div class="tline"><span class="tlabel">Runs</span><div class="tvals">${rs.map(r => `<span class="run-chip" role="button" tabindex="0" data-open="${esc(r.taskId)}">${esc(r.taskId.replace(/^\d{4,6}-/, ''))}</span>`).join('')}</div></div>` : ''}
    </article>`;
  }

  function render() {
    if (st.loadedFor !== qs(st.filter) && !st.loading && !st.error) { load(); }
    const d = st.data;
    const f = st.filter;
    const q = f.taskId || f.file;
    const scope = f.file ? `Tickets que tocaram <code>${esc(f.file)}</code>` : f.taskId ? `Ticket ${esc(f.taskId)}` : 'Todos os tickets';
    const head = `<div class="vhead"><h2>Grafo</h2>
      <p>Rastreabilidade ticket → spec → arquivos → PR, lida de <code>memory/knowledge-graph.json</code>. O watcher atualiza a cada tick e o <code>/commit</code> ao abrir o PR. Clique num arquivo para ver todos os tickets que o tocaram.</p>
      <form class="vtools kg-tools" data-kg-form>
        <input type="search" name="q" class="kg-q" value="${esc(q)}" placeholder="Nº do ticket ou caminho do arquivo (ex.: CalculoFreteService.java)" aria-label="Filtrar o grafo" autocomplete="off">
        <button class="ghost-btn" type="submit">Filtrar</button>
        ${q ? '<button class="ghost-btn" type="button" data-kg-clear>Limpar</button>' : ''}
        <button class="ghost-btn" type="button" data-kg-reload ${st.loading ? 'disabled' : ''}>${st.loading ? 'Carregando…' : '↻ Atualizar'}</button>
        ${d?.updatedAt ? `<span class="muted" title="${esc(when(d.updatedAt))}">grafo atualizado ${esc(ago(d.updatedAt))}</span>` : ''}
      </form></div>`;
    if (st.error) return `${head}<p class="fold-msg warn">Não deu para ler o grafo: ${esc(st.error)}</p>`;
    if (!d) return `${head}<div class="vempty">Carregando…</div>`;
    if (!d.exists) return `${head}<div class="vempty">Ainda não existe <code>memory/knowledge-graph.json</code>. Ele é criado no próximo tick do watcher ou pelo <code>/commit</code>.</div>`;
    const nFiles = d.tickets.reduce((a, t) => a + t.files.length, 0);
    const nPrs = d.tickets.reduce((a, t) => a + t.prs.length, 0);
    return `${head}<p class="kg-scope">${scope}: <b>${d.tickets.length}</b> ticket(s), <b>${nFiles}</b> arquivo(s), <b>${nPrs}</b> PR(s).</p>
      <div class="tgrid kg-grid">${d.tickets.map(card).join('') || '<div class="vempty">Nada no grafo para esse filtro.</div>'}</div>`;
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

  const style = document.createElement('style');
  style.textContent = `
    .kg-tools .kg-q { flex: 1 1 320px; min-width: 0; border: 1px solid var(--line); background: var(--surface); color: var(--ink); border-radius: 8px; padding: 6px 10px; font-size: 14px; }
    .kg-tools .kg-q:focus-visible { outline: 2px solid var(--signal); outline-offset: 1px; }
    .kg-scope { margin: 0 0 12px; color: var(--muted); font-size: 14px; }
    .kg-scope b { color: var(--ink); font-variant-numeric: tabular-nums; }
    .kg-scope code, .kg-card code, .vhead code { font: 12.5px var(--mono); background: var(--sunken); padding: 1px 4px; border-radius: 4px; overflow-wrap: anywhere; }
    .kg-ticket { border: 0; background: none; padding: 0; cursor: pointer; color: var(--ink); font: inherit; }
    .kg-ticket:hover { color: var(--signal); text-decoration: underline; }
    .kg-card header { display: flex; gap: 10px; align-items: baseline; flex-wrap: wrap; }
    .kg-card header .ext { margin-left: auto; font-size: 13px; }
    .kg-filebox { display: grid; gap: 8px; min-width: 0; }
    .kg-repo { font-weight: 600; font-size: 13px; color: var(--ink-2); }
    .kg-repo-group summary { cursor: pointer; }
    .kg-files { list-style: none; margin: 4px 0 0; padding: 0; display: grid; gap: 2px; }
    .kg-file { border: 0; background: none; padding: 2px 0; text-align: left; cursor: pointer; font: 12.5px/1.4 var(--mono); color: var(--muted); overflow-wrap: anywhere; }
    .kg-file.java { color: var(--ink-2); }
    .kg-file:hover { color: var(--signal); text-decoration: underline; }
  `;
  document.head.appendChild(style);

  window.GraphView = { render, load };
  // Página aberta direto em #grafo: views.js já renderizou o placeholder antes de nós.
  window.Views?.refresh();
})();
