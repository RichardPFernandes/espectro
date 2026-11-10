// Tela "Knowledge Graph" (chave grafo), no formato do artboard KnowledgeGraph do design Espectro:
// duas visões em abas — "Explorar" (vizinhança de um item em anéis, caminho entre dois itens, painel
// do item e ingestão) e "Rastreio SDD · ticket → PR" (lista por ticket: spec → arquivos → PRs → runs).
// Fonte única: GET /api/graph (memory/knowledge-graph.json, gravado pelo watcher e pelo /commit).
// Tipos com dado: ticket, spec, arquivo e PR; relações generated_spec, opened_pr e touched_file, todas
// registradas (nenhuma inferida). Tipo do artboard sem dado (ACs, runs no grafo, decisões, pessoas,
// relações inferidas, origem das relações, revisão) fica fora — lista "pendente" do relatório da onda 1.
//
// Dois modos, como prs.js: em Node exporta só a lógica pura (graph-ui.test.js); no navegador monta a
// tela e se pluga em views.js via window.GraphView. Usa os globais de index.html/views.js: api(), esc(),
// ago(), when(), runs, ticketIdOfRun(), $(). Estilos em screens/graph.css.
(root => {
  // ------------------------------------------------------------------ lógica pura
  // Tipo de nó = glifo + cor + forma (identidade nunca só pela cor). Espelha a tabela T do artboard;
  // spec e pull request vêm iguais, arquivo usa a forma de "módulo" e ticket a de "repositório".
  const T = {
    file: { n: 'Arquivo', g: '◇', cat: 'code', bg: 'var(--state-done-bg)', bc: 'var(--state-done)', tc: 'var(--state-done-fg)', r: '999px', bs: 'solid' },
    spec: { n: 'Spec', g: '§', cat: 'sdd', bg: 'var(--c-251c3d)', bc: 'var(--c-a98bff)', tc: 'var(--c-d2beff)', r: '4px', bs: 'solid' },
    pr: { n: 'Pull request', g: '⇄', cat: 'exec', bg: 'var(--c-1b2233)', bc: 'var(--c-7da4ff)', tc: 'var(--c-c4d6ff)', r: '6px', bs: 'solid' },
    ticket: { n: 'Ticket', g: '#', cat: 'ticket', bg: 'var(--state-running-bg)', bc: 'var(--accent)', tc: 'var(--state-running-fg)', r: '8px', bs: 'solid' },
  };
  // Chips "Mostrar": rótulo do artboard sem a parte que não tem dado (ACs, runs); Tickets fora do design.
  const CATS = [['code', 'Código', 'file'], ['sdd', 'Specs', 'spec'], ['exec', 'PRs', 'pr'], ['ticket', 'Tickets', 'ticket']];
  // Relação: rótulo no sentido da aresta e no inverso (lido a partir do destino).
  const REL = { generated_spec: ['gerou', 'gerado por'], opened_pr: ['abriu', 'aberto por'], touched_file: ['alterou', 'alterado por'] };
  const ORDER = ['gerou', 'gerado por', 'abriu', 'aberto por', 'alterou', 'alterado por'];
  const PR_LABEL = { OPEN: 'aberto', MERGED: 'mergeado', DECLINED: 'recusado', SUPERSEDED: 'substituído' };
  const prState = s => { const u = String(s || '').toUpperCase(); return ['OPEN', 'MERGED', 'DECLINED', 'SUPERSEDED'].includes(u) ? u : 'unknown'; };
  const baseName = id => String(id).split('/').pop();

  function entOf(id, n) {
    const t = T[n.type] ? n.type : null;
    if (!t) return null;
    if (t === 'ticket') {
      const num = n.ticket_id || String(id).replace(/^TASK-/, '');
      return { id, t, name: `#${num}`, sub: n.title || 'ticket', desc: n.title || '', num: String(num), raw: n };
    }
    if (t === 'spec') {
      const num = String(n.task_id || '').replace(/^TASK-/, '');
      return { id, t, name: baseName(id), sub: num ? `spec · #${num}` : 'spec', desc: id, num, raw: n };
    }
    if (t === 'file') {
      return { id, t, name: baseName(id), sub: `arquivo · ${n.repo || 'app-back'}`, desc: id, raw: n };
    }
    const s = prState(n.status);
    return { id, t, name: `${n.repo || ''} #${n.number || ''}`.trim(), sub: `PR · ${PR_LABEL[s] || 'estado desconhecido'}`, desc: n.url || id, raw: n };
  }

  // Índice: entidades com tipo conhecido e relações cujas pontas existem.
  function buildIndex(data) {
    const byId = {};
    const ents = [];
    for (const [id, n] of Object.entries(data?.nodes || {})) {
      const e = n && entOf(id, n);
      if (e) { byId[id] = e; ents.push(e); }
    }
    const rels = (data?.edges || []).filter(e => byId[e.from] && byId[e.to] && REL[e.rel]).map(e => ({ from: e.from, rel: e.rel, to: e.to, at: e.at || null }));
    const deg = {};
    for (const r of rels) { deg[r.from] = (deg[r.from] || 0) + 1; deg[r.to] = (deg[r.to] || 0) + 1; }
    const tickets = ents.filter(e => e.t === 'ticket').sort((a, b) => (Number(b.num) || 0) - (Number(a.num) || 0));
    return { byId, ents, rels, deg, tickets };
  }

  const relLabel = (r, fromId) => (r.from === fromId ? REL[r.rel][0] : REL[r.rel][1]);
  const visible = (idx, focus, cats) => id => id === focus || cats[T[idx.byId[id].t].cat] !== false;

  // Vizinhança em anéis: mesma geometria do artboard (canvas 880×700, centro 440×350, elipse 1,18).
  function ego(idx, focus, depth, cats, hov) {
    const vis = visible(idx, focus, cats);
    const rels = idx.rels.filter(r => vis(r.from) && vis(r.to));
    const adj = {};
    rels.forEach((r, i) => { (adj[r.from] = adj[r.from] || []).push([r.to, i]); (adj[r.to] = adj[r.to] || []).push([r.from, i]); });
    const CX = 440, CY = 350, KX = 1.18;
    const d2 = depth === 2;
    const R1 = d2 ? 150 : 210, R2 = 292;
    const seen = { [focus]: 1 };
    const ring1 = [];
    (adj[focus] || []).forEach(([o, i]) => { if (!seen[o]) { seen[o] = 1; ring1.push({ id: o, rel: rels[i], lab: relLabel(rels[i], focus) }); } });
    ring1.sort((a, b) => (ORDER.indexOf(a.lab) - ORDER.indexOf(b.lab)) || a.id.localeCompare(b.id));
    const r1 = ring1.slice(0, 14);
    const r1Hidden = ring1.length - r1.length;
    r1.forEach(x => { seen[x.id] = 1; });
    const n1 = r1.length;
    const pos = { [focus]: { x: CX, y: CY } };
    const box = { [focus]: [212, 60] };
    r1.forEach((x, i) => { const a = (-90 + i * 360 / Math.max(1, n1)) * Math.PI / 180; x.a = a; pos[x.id] = { x: CX + R1 * KX * Math.cos(a), y: CY + R1 * Math.sin(a) }; box[x.id] = [156, 44]; });
    const r2 = [];
    const moreOf = {};
    if (d2) {
      const PER = n1 > 9 ? 2 : 3, TOT = 18;
      r1.forEach(x => {
        const kids = [];
        (adj[x.id] || []).forEach(([o, i]) => { if (!seen[o] && kids.length < PER && r2.length + kids.length < TOT) { seen[o] = 1; kids.push({ id: o, rel: rels[i], parent: x.id }); } });
        const all = (adj[x.id] || []).filter(([o]) => o !== focus && !r1.some(y => y.id === o)).length;
        if (all > kids.length) moreOf[x.id] = all - kids.length;
        const sector = 360 / Math.max(1, n1);
        const spread = Math.min(sector * 0.86, 26 * kids.length);
        kids.forEach((k, j) => {
          const a = x.a + ((-spread / 2) + spread * (j + 0.5) / kids.length) * Math.PI / 180;
          pos[k.id] = { x: CX + R2 * KX * Math.cos(a), y: CY + R2 * Math.sin(a) }; box[k.id] = [140, 36];
          r2.push(k);
        });
      });
    } else {
      r1.forEach(x => { const all = (adj[x.id] || []).filter(([o]) => o !== focus).length; if (all) moreOf[x.id] = all; });
    }
    const h = hov && pos[hov] ? hov : null;
    const tree = r1.map(x => ({ r: x.rel, ring: 1 })).concat(r2.map(x => ({ r: x.rel, ring: 2 })));
    const hovNb = {};
    if (h) { hovNb[h] = 1; tree.forEach(t => { if (t.r.from === h) hovNb[t.r.to] = 1; if (t.r.to === h) hovNb[t.r.from] = 1; }); }
    const clip = (c, hw, hh, dx, dy) => { const ax = Math.abs(dx) || 1e-6, ay = Math.abs(dy) || 1e-6; const t = Math.min(hw / ax, hh / ay); return [c.x + dx * t, c.y + dy * t]; };
    const f1 = v => Number(v.toFixed(1));
    const edges = [], labels = [];
    tree.forEach(t => {
      const a = t.r.from, b = t.r.to;
      const A = pos[a], B = pos[b];
      if (!A || !B) return;
      const dx = B.x - A.x, dy = B.y - A.y;
      const p1 = clip(A, box[a][0] / 2 + 4, box[a][1] / 2 + 4, dx, dy);
      const p2 = clip(B, box[b][0] / 2 + 5, box[b][1] / 2 + 5, -dx, -dy);
      const L = Math.hypot(p2[0] - p1[0], p2[1] - p1[1]) || 1;
      const ux = (p2[0] - p1[0]) / L, uy = (p2[1] - p1[1]) / L;
      const bx = p2[0] - ux * 9, by = p2[1] - uy * 9, nx = -uy * 4.5, ny = ux * 4.5;
      const on = !!h && (a === h || b === h);
      edges.push({
        x1: f1(p1[0]), y1: f1(p1[1]), x2: f1(bx), y2: f1(by),
        head: `${f1(p2[0])},${f1(p2[1])} ${f1(bx + nx)},${f1(by + ny)} ${f1(bx - nx)},${f1(by - ny)}`,
        color: on ? 'var(--accent)' : (t.ring === 1 ? 'var(--c-6b7390)' : 'var(--c-4a5170)'),
        sw: on ? 2.2 : (t.ring === 1 ? 1.6 : 1.2), op: h ? (on ? 1 : 0.22) : (t.ring === 1 ? 0.95 : 0.7),
      });
      if (t.ring === 1 || on) {
        const k = t.ring === 1 ? 0.56 : 0.5;
        labels.push({ x: f1(A.x + dx * k), y: f1(A.y + dy * k), text: REL[t.r.rel][0], on, op: h && !on ? 0.25 : 1 });
      }
    });
    const mk = (id, ring) => {
      const e = idx.byId[id], P = pos[id], B = box[id];
      return { id, ring, e, left: f1(P.x - B[0] / 2), top: f1(P.y - B[1] / 2), w: B[0], h: B[1], dim: !!h && !hovNb[id], hov: h === id, more: moreOf[id] || 0 };
    };
    const nodes = r2.map(x => mk(x.id, 2)).concat(r1.map(x => mk(x.id, 1))).concat([mk(focus, 0)]);
    return {
      nodes, edges, labels, r1Hidden, showRing2: d2,
      ring1: { l: f1(CX - R1 * KX), t: f1(CY - R1), w: f1(2 * R1 * KX), h: 2 * R1 },
      ring2: { l: f1(CX - R2 * KX), t: f1(CY - R2), w: f1(2 * R2 * KX), h: 2 * R2 },
    };
  }

  // Menor caminho sem olhar a direção (BFS em todas as relações). [] = sem caminho.
  function shortestPath(idx, from, to) {
    if (!idx.byId[from] || !idx.byId[to] || from === to) return [];
    const und = {};
    idx.rels.forEach((r, i) => { (und[r.from] = und[r.from] || []).push([r.to, i]); (und[r.to] = und[r.to] || []).push([r.from, i]); });
    const prev = { [from]: null };
    let fr = [from];
    while (fr.length && prev[to] === undefined) {
      const nx = [];
      fr.forEach(x => (und[x] || []).forEach(([o, i]) => { if (prev[o] === undefined) { prev[o] = [x, i]; nx.push(o); } }));
      fr = nx;
    }
    if (prev[to] === undefined) return [];
    const chain = [];
    let c = to;
    while (c !== from) { const [p, i] = prev[c]; chain.unshift({ a: p, r: idx.rels[i], b: c }); c = p; }
    return chain;
  }

  // Relações do item em foco agrupadas pelo rótulo lido a partir dele, na ordem do artboard.
  function relGroups(idx, focus, cats) {
    const vis = visible(idx, focus, cats);
    const inc = idx.rels.filter(r => (r.from === focus || r.to === focus) && vis(r.from === focus ? r.to : r.from));
    const g = {};
    inc.forEach(r => { const other = r.from === focus ? r.to : r.from; const lab = relLabel(r, focus); (g[lab] = g[lab] || []).push(other); });
    const groups = Object.keys(g).sort((a, b) => ORDER.indexOf(a) - ORDER.indexOf(b))
      .map(lab => ({ title: lab.charAt(0).toUpperCase() + lab.slice(1), items: g[lab].sort((a, b) => a.localeCompare(b)) }));
    return { total: inc.length, groups, flat: groups.flatMap(x => x.items) };
  }

  // Busca do artboard: nome/sub/descrição contêm o termo; começa pelo nome primeiro, depois mais ligações.
  function search(idx, q, limit = 8) {
    const qq = String(q || '').trim().toLowerCase();
    if (!qq) return [];
    const starts = e => (e.name.toLowerCase().indexOf(qq) === 0 ? 0 : 1);
    return idx.ents.filter(e => `${e.name} ${e.sub} ${e.desc}`.toLowerCase().includes(qq))
      .sort((a, b) => (starts(a) - starts(b)) || ((idx.deg[b.id] || 0) - (idx.deg[a.id] || 0)) || a.id.localeCompare(b.id)).slice(0, limit);
  }

  // Eventos mais recentes do grafo (arestas pelo `at` da primeira vez em que foram vistas).
  function feed(idx, limit = 5) {
    const txt = r => {
      const a = idx.byId[r.from], b = idx.byId[r.to];
      if (r.rel === 'opened_pr') return `PR ${b.name} ligado a ${a.name}`;
      if (r.rel === 'generated_spec') return `spec ${b.name} gerada para ${a.name}`;
      return `${b.name} alterado por ${a.name}`;
    };
    return idx.rels.filter(r => Date.parse(r.at)).sort((x, y) => Date.parse(y.at) - Date.parse(x.at)).slice(0, limit)
      .map(r => ({ at: r.at, rel: r.rel, text: txt(r) }));
  }

  // "há 8 s" / "há 2 min" / "há 3 h" / "há 4 d": formato curto do feed do artboard (coluna de 64 px).
  function agoShort(iso, now = Date.now()) {
    const t = Date.parse(iso);
    if (!t) return '';
    const s = Math.max(0, Math.round((now - t) / 1000));
    if (s < 60) return `há ${s} s`;
    if (s < 3600) return `há ${Math.floor(s / 60)} min`;
    if (s < 86400) return `há ${Math.floor(s / 3600)} h`;
    return `há ${Math.floor(s / 86400)} d`;
  }

  const model = { T, CATS, REL, ORDER, prState, entOf, buildIndex, ego, shortestPath, relGroups, search, feed, agoShort };
  if (typeof module !== 'undefined' && module.exports) { module.exports = model; return; }

  // ------------------------------------------------------------------ navegador
  const st = {
    all: null, loadingAll: false, errorAll: null, loadedAll: false,
    sdd: null, loading: false, error: null, filter: { taskId: '', file: '' }, loadedFor: null,
    vtab: 'own', focus: null, hist: [], q: '', qOpen: false, qFocus: false, qSel: null,
    mode: 'ego', depth: 2, to: null, hov: null, kj: -1, zoom: 0.86, zoomAuto: true,
    cats: { code: true, sdd: true, exec: true, ticket: true }, scroll: 0, keyFocus: false, toast: '',
  };
  let idx = null, idxFor = null;
  const FILES_OPEN = 12;
  const qs = f => new URLSearchParams(Object.entries(f).filter(([, v]) => v)).toString();
  const refresh = () => window.Views?.refresh();
  const index = () => { if (st.all && idxFor !== st.all) { idx = buildIndex(st.all); idxFor = st.all; } return st.all ? idx : null; };

  async function loadAll() {
    st.loadingAll = true; st.errorAll = null; refresh();
    try { st.all = await api('/api/graph'); st.loadedAll = true; }
    catch (e) { st.errorAll = e.message; st.loadedAll = true; }
    st.loadingAll = false; refresh();
  }

  async function load(filter = st.filter) {
    st.filter = { taskId: filter.taskId || '', file: filter.file || '' };
    if (!qs(st.filter)) { st.loadedFor = ''; st.sdd = null; st.error = null; loadAll(); return; }
    st.loading = true; st.error = null; refresh();
    try { st.sdd = await api(`/api/graph?${qs(st.filter)}`); st.loadedFor = qs(st.filter); }
    catch (e) { st.error = e.message; }
    st.loading = false; refresh();
  }

  // Número/TASK-/task-id → recorte por ticket; qualquer outra coisa é caminho de arquivo.
  function parseQuery(q) {
    q = q.trim();
    if (!q) return { taskId: '', file: '' };
    if (/^(TASK-)?\d{4,6}(-[\w-]+)?$/i.test(q) || /^#\d{4,6}$/.test(q)) return { taskId: q.replace(/^#/, ''), file: '' };
    return { taskId: '', file: q };
  }

  function goTo(id) {
    st.hist = st.hist.filter(x => x !== id).concat([id]).slice(-7);
    st.focus = id; st.q = ''; st.qOpen = false; st.hov = null; st.kj = -1; st.toast = '';
    refresh();
  }

  // ---------------------------------------------------------------- Explorar
  const ty = e => T[e.t];
  const sty = o => Object.entries(o).map(([k, v]) => `${k}:${v}`).join(';');
  const glyphSpan = (e, extra = '') => `<span aria-hidden="true" class="kg-tg" style="color:${ty(e).tc}${extra}">${ty(e).g}</span>`;

  function focusSub(e) {
    if (e.t === 'ticket') return `Ticket · ${e.raw.title || ''}`.replace(/ · $/, '');
    return `${ty(e).n} · ${e.sub.replace(/^[^·]*·\s*/, '')}`;
  }

  function nodeHtml(n) {
    const e = n.e, Ty = ty(e), isF = n.ring === 0;
    const style = sty({
      left: `${n.left}px`, top: `${n.top}px`, width: `${n.w}px`, height: `${n.h}px`,
      border: `${isF ? '2px' : (n.ring === 1 ? '1.5px' : '1px')} ${Ty.bs} ${Ty.bc}`,
      'border-radius': isF && Ty.r === '999px' ? '30px' : Ty.r, background: Ty.bg,
      opacity: n.dim ? 0.38 : (n.ring === 2 ? 0.92 : 1),
      'box-shadow': isF ? `0 0 0 4px var(--ground), 0 0 0 6px ${Ty.bc}, 0 10px 30px rgba(0,0,0,0.35)` : (n.hov ? '0 0 0 3px var(--accent)' : 'none'),
    });
    const aria = `${Ty.n} ${e.name}${isF ? ', em foco' : ', explorar a partir daqui'}${n.more ? `, mais ${n.more} ligações` : ''}`;
    return `<button type="button" class="kgn" data-kg-go="${esc(e.id)}" data-kg-hov="${esc(e.id)}" aria-label="${esc(aria)}" aria-current="${isF}" style="${style}">
      <span aria-hidden="true" class="kgn-g" style="font-size:${isF ? 16 : 12}px;color:${Ty.tc}">${Ty.g}</span>
      <span class="kgn-txt"><span class="kgn-name" style="font-size:${isF ? 15 : (n.ring === 2 ? 11 : 12)}px">${esc(e.name)}</span>${n.ring < 2 ? `<span class="kgn-sub">${esc(isF ? focusSub(e) : e.sub)}</span>` : ''}</span>
      ${n.more ? `<span aria-hidden="true" class="kgn-more">+${n.more}</span>` : ''}
    </button>`;
  }

  function canvasHtml(g) {
    const z = st.zoom;
    const ring = (r, c) => `<div aria-hidden="true" class="kg-ring" style="left:${r.l}px;top:${r.t}px;width:${r.w}px;height:${r.h}px;border-color:var(${c})"></div>`;
    const edges = g.edges.map(e => `<svg aria-hidden="true" width="880" height="700" viewBox="0 0 880 700" class="kg-edge" style="opacity:${e.op}"><line x1="${e.x1}" y1="${e.y1}" x2="${e.x2}" y2="${e.y2}" stroke-linecap="round" style="stroke:${e.color};stroke-width:${e.sw}"></line><polygon points="${e.head}" style="fill:${e.color}"></polygon></svg>`).join('');
    const labels = g.labels.map(l => `<span aria-hidden="true" class="kg-elabel" style="left:${l.x}px;top:${l.y}px;border-color:${l.on ? 'var(--accent)' : 'var(--c-2a3045)'};color:${l.on ? 'var(--text)' : 'var(--text-secondary)'};opacity:${l.op}">${esc(l.text)}</span>`).join('');
    return `<div class="kg-canvas kg-grid" data-kg-box>
      <div class="kg-cv" style="width:${Math.round(880 * z)}px;height:${Math.round(700 * z)}px">
        <div class="kg-cv-in" style="transform:scale(${z})">
          ${ring(g.ring1, '--c-2a3045')}${g.showRing2 ? ring(g.ring2, '--c-1f2433') : ''}
          ${edges}${labels}${g.nodes.map(nodeHtml).join('')}
        </div>
      </div>
    </div>`;
  }

  function pathHtml(F) {
    const I = idx;
    const opts = I.ents.filter(e => e.id !== F.id)
      .sort((a, b) => (Object.keys(T).indexOf(a.t) - Object.keys(T).indexOf(b.t)) || a.name.localeCompare(b.name));
    const toId = st.to && I.byId[st.to] && st.to !== F.id ? st.to : opts[0]?.id;
    const chain = toId ? shortestPath(I, F.id, toId) : [];
    const step = e => { const Ty = ty(e); return `<li><button type="button" class="kgn kg-pstep" data-kg-go="${esc(e.id)}" style="${sty({ border: `2px ${Ty.bs} ${Ty.bc}`, 'border-radius': Ty.r === '999px' ? '26px' : Ty.r, background: Ty.bg })}">
        <span aria-hidden="true" style="color:${Ty.tc}">${Ty.g}</span><span class="kg-pstep-txt"><span class="kg-pstep-name">${esc(e.name)}</span><span class="kg-pstep-sub">${esc(e.sub)}</span></span></button></li>`; };
    const steps = chain.length ? [step(F)].concat(chain.flatMap(c => [
      `<li><span class="kg-plink"><span>${esc(REL[c.r.rel][0])}</span><span aria-hidden="true" class="kg-parrow">${c.r.from === c.a ? '———▶' : '◀———'}</span></span></li>`,
      step(I.byId[c.b]),
    ])).join('') : '';
    const note = chain.length ? `${chain.length} ${chain.length === 1 ? 'salto' : 'saltos'}` : '';
    return { chain, html: `<div class="kg-path">
        <div class="kg-path-head">
          <span>De <b class="kg-mono">${esc(F.name)}</b> até</span>
          <label class="kg-path-to"><span class="sr-only">Destino do caminho</span>
            <select data-kg-to>${opts.map(e => `<option value="${esc(e.id)}"${e.id === toId ? ' selected' : ''}>${esc(`${ty(e).g} ${e.name}`)}</option>`).join('')}</select>
          </label>
          <span class="kg-muted12">${note}</span>
        </div>
        ${chain.length ? '' : '<p class="kg-muted">Não há caminho entre os dois itens com as relações que o grafo conhece.</p>'}
        <ol aria-label="Caminho" class="kg-psteps">${steps}</ol>
        <p class="kg-fine">Menor caminho entre os dois itens, sem olhar a direção das relações. A seta mostra a direção de cada relação. Clique num item para explorar a partir dele.</p>
      </div>` };
  }

  function actionsOf(e) {
    const A = [];
    const sdd = (lbl, f) => `<button type="button" class="${A.length ? 'kg-act2' : 'kg-act'}" data-kg-sdd="${esc(JSON.stringify(f))}">${lbl}${A.length ? '' : '<span aria-hidden="true">→</span>'}</button>`;
    const ext = (lbl, url) => `<a class="${A.length ? 'kg-act2' : 'kg-act'}" href="${esc(url)}" target="_blank" rel="noopener noreferrer">${lbl}${A.length ? ' ↗' : '<span aria-hidden="true">↗</span>'}</a>`;
    if (e.t === 'ticket') {
      A.push(sdd('Ver no Rastreio SDD', { taskId: e.num }));
      if (e.raw.redmine_url) A.push(ext('Abrir no Redmine', e.raw.redmine_url));
    } else if (e.t === 'spec') {
      if (e.num) A.push(sdd('Ver no Rastreio SDD', { taskId: e.num }));
    } else if (e.t === 'file') {
      A.push(sdd('Ver tickets que tocaram', { file: e.id }));
    } else if (e.raw.url) {
      A.push(ext('Abrir o PR', e.raw.url));
    }
    return A.join('');
  }

  function factsOf(e) {
    const f = [];
    const n = e.raw;
    if (e.t === 'ticket' && n.tracker) f.push(['Tracker', n.tracker]);
    if (e.t === 'file') { f.push(['Fica em', n.repo || 'app-back']); if (n.lang) f.push(['Linguagem', n.lang]); }
    if (e.t === 'pr') { f.push(['Fica em', n.repo || '—']); f.push(['Estado', PR_LABEL[prState(n.status)] || 'desconhecido']); }
    if (e.t === 'spec' && n.spec_version != null) f.push(['Versão', String(n.spec_version)]);
    f.push(['Ligações', String(idx.deg[e.id] || 0)]);
    return f;
  }

  function asideHtml(F, rg) {
    const Ty = ty(F);
    const groups = rg.groups.map(g => `<div class="kg-rgroup">
        <span class="kg-muted12">${esc(g.title)} · ${g.items.length}</span>
        <div class="kg-rlist">${g.items.map(o => { const e = idx.byId[o]; const kj = rg.flat[st.kj] === o;
          return `<button type="button" class="kg-ritem hov${kj ? ' kj' : ''}" data-kg-go="${esc(o)}" data-kg-hov="${esc(o)}">${glyphSpan(e)}<span class="kg-ritem-txt"><span class="kg-ritem-name">${esc(e.name)}</span><span class="kg-ritem-sub">${esc(e.sub)}</span></span></button>`; }).join('')}</div>
      </div>`).join('');
    const facts = factsOf(F).map(([k, v]) => `<div class="kg-fact"><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join('');
    const acts = actionsOf(F);
    return `<aside aria-label="Detalhes do item" class="kg-aside">
      <div class="kg-aside-head">
        <span class="kg-aside-tags"><span class="kg-type" style="color:${Ty.tc};border-color:${Ty.bc};background:${Ty.bg}"><span aria-hidden="true">${Ty.g}</span>${Ty.n}</span></span>
        <h2 class="kg-aside-name">${esc(F.name)}</h2>
        <span class="kg-aside-sub">${esc(F.sub)}</span>
        ${F.desc && F.desc !== F.sub ? `<p class="kg-aside-desc">${esc(F.desc)}</p>` : ''}
      </div>
      <dl class="kg-facts">${facts}</dl>
      ${acts ? `<div class="kg-acts">${acts}</div>` : ''}
      <section aria-labelledby="kg-rel-h" class="kg-rels">
        <div class="kg-rels-head"><h3 id="kg-rel-h">Relações</h3><span class="kg-muted12">${rg.total} ${rg.total === 1 ? 'relação' : 'relações'}</span></div>
        ${rg.total ? groups : '<p class="kg-muted13">Nenhuma relação com os filtros atuais.</p>'}
      </section>
    </aside>`;
  }

  function searchHtml(I) {
    const res = search(I, st.q);
    const show = st.qOpen && st.q.trim().length > 0;
    const list = show ? `<div id="kg-res" role="listbox" aria-label="Resultados da busca" class="kg-res">
        ${res.length ? '' : '<span class="kg-res-none">Nada encontrado no grafo.</span>'}
        ${res.map((e, i) => { const Ty = ty(e); return `<button type="button" role="option" aria-selected="${i === 0}" class="opt kg-opt${i === 0 ? ' first' : ''}" data-kg-go="${esc(e.id)}">
          <span aria-hidden="true" class="kg-opt-g" style="border-color:${Ty.bc};background:${Ty.bg};color:${Ty.tc}">${Ty.g}</span>
          <span class="kg-opt-txt"><span class="kg-opt-name">${esc(e.name)}</span><span class="kg-opt-sub">${esc(`${Ty.n} · ${e.sub}`)}</span></span>
          <span class="kg-muted12">${I.deg[e.id] || 0} ligações</span></button>`; }).join('')}
      </div>` : '';
    return `<div class="kg-search">
        <label for="kg-q" class="sr-only">Buscar no grafo</label>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" class="kg-search-icon"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg>
        <input id="kg-q" type="search" autocomplete="off" role="combobox" aria-autocomplete="list" aria-controls="kg-res" aria-expanded="${show}" placeholder="Buscar ticket, spec, arquivo ou PR" value="${esc(st.q)}" data-kg-q class="kg-q">
        ${list}
      </div>`;
  }

  const seg = (label, on, attr) => `<button type="button" role="radio" class="kg-segb" aria-checked="${on}" ${attr}>${label}</button>`;

  function explorarHtml() {
    const I = index();
    const d = st.all;
    const updated = d?.updatedAt;
    const hdr = `<header class="kg-hdr">
        <div class="kg-hdr-txt">
          <span class="kg-eyebrow">Conhecimento · grafo</span>
          <h1 class="kg-h1">Knowledge Graph</h1>
          <p class="kg-desc">Tudo o que está ligado a um item: tickets, specs, arquivos e PRs.${I ? ` ${I.ents.length} itens · ${I.rels.length} relações.` : ''}</p>
        </div>
        ${updated ? `<div class="kg-pills"><span class="kg-pill" title="${esc(when(updated))}">captura ${esc(when(updated))}</span></div>` : ''}
      </header>
      ${updated ? `<div class="kg-liverow"><span class="kg-live" title="Última gravação de memory/knowledge-graph.json"><span aria-hidden="true">○</span>Último evento ${esc(agoShort(updated))}</span></div>` : ''}`;
    const wrap = body => `<main role="tabpanel" aria-labelledby="kg-vt-own" class="kg-main">${hdr}${body}</main>`;
    if (st.errorAll) return wrap(`<p class="kg-msg failed" role="alert"><span aria-hidden="true">✕</span> Não deu para ler o grafo: ${esc(st.errorAll)}</p>`);
    if (!d) return wrap('<div class="panel empty">Carregando…</div>');
    if (!d.exists) return wrap('<div class="panel empty">Ainda não existe <code>memory/knowledge-graph.json</code>. Ele é criado no próximo tick do watcher ou pelo <code>/commit</code>.</div>');
    if (!I.ents.length) return wrap('<div class="panel empty">O grafo ainda não tem itens.</div>');
    if (!st.focus || !I.byId[st.focus]) { st.focus = (I.tickets[0] || I.ents[0]).id; st.hist = [st.focus]; }
    const F = I.byId[st.focus];
    const rg = relGroups(I, F.id, st.cats);
    if (st.kj >= rg.flat.length) st.kj = -1;
    const counts = {};
    I.ents.forEach(e => { counts[T[e.t].cat] = (counts[T[e.t].cat] || 0) + 1; });
    const chips = CATS.map(([id, label, t]) => { const on = st.cats[id] !== false;
      return `<button type="button" class="chip kg-chip" aria-pressed="${on}" data-kg-cat="${id}"><span aria-hidden="true" class="kg-sw" style="border-color:${T[t].bc};background:${on ? T[t].bg : 'transparent'}"></span>${label}<span class="kg-chip-n">${counts[id] || 0}</span></button>`; }).join('');
    const filters = `<section aria-label="Busca e filtros" class="kg-filters">
        <div class="kg-frow">
          ${searchHtml(I)}
          <div role="radiogroup" aria-label="Modo" class="kg-segs">${seg('Vizinhança', st.mode === 'ego', 'data-kg-mode="ego"')}${seg('Caminho até…', st.mode === 'path', 'data-kg-mode="path"')}</div>
          <div role="radiogroup" aria-label="Profundidade" class="kg-segs">${seg('1 salto', st.depth === 1, 'data-kg-depth="1"')}${seg('2 saltos', st.depth === 2, 'data-kg-depth="2"')}</div>
        </div>
        <div class="kg-chips"><span class="kg-muted12">Mostrar</span>${chips}</div>
      </section>`;
    const hist = st.hist.filter(id => I.byId[id]);
    const trail = `<nav aria-label="Trilha da exploração" class="kg-trail-nav"><span class="kg-muted12 kg-trail-lbl">Trilha</span>${hist.map((id, i) => {
      const e = I.byId[id]; const last = i === hist.length - 1; const g = `<span aria-hidden="true" style="color:${ty(e).tc}">${ty(e).g}</span>`;
      return `<span class="kg-crumb">${last ? `<span aria-current="location" class="kg-crumb-cur">${g} ${esc(e.name)}</span>` : `<button type="button" class="kg-crumb-link" data-kg-go="${esc(id)}">${g} ${esc(e.name)}</button><span aria-hidden="true" class="kg-muted">›</span>`}</span>`; }).join('')}</nav>`;
    let graphTitle, graphNote, body, zoom = '';
    if (st.mode === 'ego') {
      const g = ego(I, F.id, st.depth, st.cats, st.hov);
      graphTitle = `Vizinhança de ${F.name}`;
      graphNote = `${g.nodes.length} itens à vista${g.r1Hidden > 0 ? ` · ${g.r1Hidden} vizinhos só no painel` : ''} · clique num item para centralizar`;
      body = canvasHtml(g);
      zoom = `<div role="group" aria-label="Zoom" class="kg-zoom">
          <button type="button" class="kg-segb" aria-label="Diminuir zoom" data-kg-zoom="-1">−</button>
          <span class="kg-zoom-pct">${Math.round(st.zoom * 100)}%</span>
          <button type="button" class="kg-segb" aria-label="Aumentar zoom" data-kg-zoom="1">+</button>
          <button type="button" class="kg-segb kg-zoom-fit" data-kg-zoom="fit">Ajustar</button>
        </div>`;
    } else {
      const p = pathHtml(F);
      graphTitle = 'Caminho entre dois itens';
      graphNote = p.chain.length ? `${p.chain.length} ${p.chain.length === 1 ? 'salto' : 'saltos'}` : 'sem caminho';
      body = p.html;
    }
    const legend = `<div class="kg-legend">${Object.keys(T).map(k => `<span class="kg-leg"><span aria-hidden="true" class="kg-leg-sw" style="border:2px ${T[k].bs} ${T[k].bc};background:${T[k].bg};border-radius:${T[k].r === '999px' ? '8px' : T[k].r}"></span>${T[k].n.toLowerCase()}</span>`).join('')}
        <span class="kg-leg"><span aria-hidden="true" class="kg-leg-line"></span>declarada ou observada</span></div>`;
    const evs = feed(I);
    const ing = `<div class="kg-bottom">
        <section aria-labelledby="kg-ing-h" class="kg-card2">
          <div class="kg-card2-head"><h2 id="kg-ing-h">Ingestão · ao vivo</h2></div>
          <ol class="kg-feed">${evs.map(e => `<li><span class="kg-feed-ago">${esc(agoShort(e.at))}</span><span aria-hidden="true" class="kg-feed-g">✓</span><span class="kg-feed-txt">${esc(e.text)}</span></li>`).join('') || '<li class="kg-muted13">Nenhum evento com data no grafo.</li>'}</ol>
          <p class="kg-fine">O watcher grava no grafo a cada tick e o <code>/commit</code> ao abrir o PR. Esta tela relê o grafo a cada minuto.</p>
        </section>
      </div>`;
    return wrap(`${filters}${trail}
      <div class="kg-body">
        <section aria-labelledby="kg-h" class="kg-graph">
          <div class="kg-ghead"><div class="kg-ghead-t"><h2 id="kg-h">${esc(graphTitle)}</h2><span class="kg-muted12">${esc(graphNote)}</span></div>${zoom}</div>
          ${body}
          ${legend}
        </section>
        ${asideHtml(F, rg)}
      </div>
      ${ing}
      <p class="kg-fine">Esta tela só lê. O grafo é montado pelo watcher e pelo <code>/commit</code> em <code>memory/knowledge-graph.json</code>, a partir do estado de cada run: ticket, spec, arquivos alterados e PRs. Todas as relações são registradas; nenhuma é inferida.</p>`);
  }

  // ---------------------------------------------------------------- Rastreio SDD
  const repoOf = f => f.repo || 'app-back';
  const shortPath = id => id.replace(/^(?:app-front|app-core|mo-entity)\//, '').replace(/^src\/main\/java\/br\/com\/mosistemas\//, '…/').replace(/^src\/test\/java\/br\/com\/mosistemas\//, 'test …/');

  function runsOfTicket(ticketId) {
    if (typeof runs === 'undefined') return [];
    return [...runs.values()].filter(r => String(ticketIdOfRun(r) || '') === String(ticketId));
  }

  const GLYPH = { spec: '§', file: '◇', pr: '⇄', run: '▶' };
  const PR_TONE = { MERGED: ['done', '✓'], OPEN: ['waiting', '‖'], DECLINED: ['failed', '✕'], SUPERSEDED: ['queued', '↷'], unknown: ['queued', ''] };
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

  const sddLegend = `<ul class="kg-legend kg-sdd-legend" aria-label="Legenda do rastreio">
      <li><span class="kg-swatch ticket" aria-hidden="true">#</span>ticket</li>
      <li>${glyph('spec')}spec</li>
      <li>${glyph('file')}arquivo <span class="kg-legend-note">(.java em destaque)</span></li>
      <li>${glyph('pr')}pull request</li>
      <li>${glyph('run')}run</li>
      <li class="kg-legend-sep" aria-hidden="true"></li>
      <li><span class="kg-arrow" aria-hidden="true">→</span>relação registrada no grafo</li>
    </ul>`;

  function sddHtml() {
    const f = st.filter;
    const filtered = !!qs(f);
    if (filtered && st.loadedFor !== qs(f) && !st.loading && !st.error) load();
    const d = filtered ? st.sdd : st.all;
    const busy = filtered ? st.loading : st.loadingAll;
    const err = filtered ? st.error : st.errorAll;
    const q = f.taskId || f.file;
    const scope = f.file ? `Tickets que tocaram <code>${esc(f.file)}</code>` : f.taskId ? `Ticket ${esc(f.taskId)}` : 'Todos os tickets';
    const head = `<div class="kg-sdd-head">
        <h2 class="kg-sdd-title">Rastreio SDD · ticket → PR</h2>
        <p class="kg-lede">Rastreabilidade ticket → spec → arquivos → PR, lida de <code>memory/knowledge-graph.json</code>. Clique num arquivo para ver todos os tickets que o tocaram.</p>
      </div>
      <form class="panel kg-tools" data-kg-form role="search">
        <div class="kg-search">
          <svg class="kg-search-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg>
          <input type="search" name="q" class="kg-q" value="${esc(q)}" placeholder="Nº do ticket ou caminho do arquivo (ex.: CalculoFreteService.java)" aria-label="Filtrar o rastreio" autocomplete="off">
        </div>
        <button class="btn primary lg" type="submit">Filtrar</button>
        ${q ? '<button class="btn lg" type="button" data-kg-clear>Limpar</button>' : ''}
        <button class="btn lg" type="button" data-kg-reload ${busy ? 'disabled' : ''}>${busy ? 'Carregando…' : '↻ Atualizar'}</button>
      </form>`;
    const wrap = body => `<div role="tabpanel" aria-labelledby="kg-vt-sdd" class="kg-sdd">${head}${body}</div>`;
    if (err) return wrap(`<p class="kg-msg failed" role="alert"><span aria-hidden="true">✕</span> Não deu para ler o grafo: ${esc(err)}</p>`);
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
      ${sddLegend}
      <div class="kg-list">${d.tickets.map(card).join('') || '<div class="panel empty">Nada no grafo para esse filtro.</div>'}</div>`);
  }

  // ---------------------------------------------------------------- tela
  const TABS = [['own', 'Explorar'], ['sdd', 'Rastreio SDD · ticket → PR']];

  function render() {
    if (!st.loadedAll && !st.loadingAll) loadAll();
    queueMicrotask(afterPaint);
    const tabs = `<div role="tablist" aria-label="Visões do Knowledge Graph" class="kg-vtabs">${TABS.map(([id, label]) =>
      `<button type="button" role="tab" id="kg-vt-${id}" class="kg-vtab" aria-selected="${st.vtab === id}" tabindex="${st.vtab === id ? 0 : -1}" data-kg-vtab="${id}">${label}</button>`).join('')}</div>`;
    const panel = st.vtab === 'own' ? explorarHtml() : sddHtml();
    const I = index();
    const F2 = I && st.focus ? I.byId[st.focus] : null;
    const cap = st.all?.updatedAt ? ` · captura de ${when(st.all.updatedAt)}` : '';
    const left = st.toast || `Knowledge Graph${cap}${F2 ? ` · foco ${F2.name}` : ''}`;
    const mid = I ? `${I.ents.length} itens · ${I.rels.length} relações` : '';
    return `<div class="kg-screen">
      <div class="kg-scroll" tabindex="0" data-kg-scroll aria-label="Knowledge Graph. J e K percorrem as relações do item em foco, Enter centraliza, Esc limpa o destaque ou volta na trilha, 1 e 2 trocam de visão.">
        ${tabs}${panel}
      </div>
      <footer class="kg-statusbar"><span role="status">${esc(left)}</span><span>${esc(mid)}</span><span class="kg-keys">J K relações · Enter centraliza · Esc volta · 1–2 visões · ⌘K comandos</span></footer>
    </div>`;
  }

  // views.js troca o HTML inteiro a cada evento: devolve rolagem, foco da busca e zoom ajustado.
  function afterPaint() {
    const view = $('view');
    const sc = view.querySelector('[data-kg-scroll]');
    if (sc) sc.scrollTop = st.scroll;
    if (st.qFocus) {
      const q = view.querySelector('[data-kg-q]');
      if (q && document.activeElement !== q) { q.focus(); if (st.qSel) q.setSelectionRange(...st.qSel); }
    } else if (st.keyFocus && sc && (document.activeElement === document.body || !document.activeElement)) sc.focus({ preventScroll: true });
    if (st.zoomAuto) fit();
  }

  function fit() {
    const box = $('view').querySelector('[data-kg-box]');
    if (!box) return;
    const w = box.clientWidth - 2;
    const z = Math.max(0.6, Math.min(1.2, Math.floor((w / 880) * 100) / 100));
    st.zoomAuto = false;
    if (isFinite(z) && z > 0 && z !== st.zoom) { st.zoom = z; refresh(); }
  }

  const view = $('view');
  view.addEventListener('scroll', e => { if (e.target.matches?.('[data-kg-scroll]')) st.scroll = e.target.scrollTop; }, true);
  view.addEventListener('submit', e => {
    if (!e.target.matches('[data-kg-form]')) return;
    e.preventDefault();
    load(parseQuery(new FormData(e.target).get('q') || ''));
  });
  view.addEventListener('input', e => {
    if (!e.target.matches('[data-kg-q]')) return;
    st.q = e.target.value; st.qOpen = true; st.qSel = [e.target.selectionStart, e.target.selectionEnd];
    refresh();
  });
  view.addEventListener('focusin', e => { if (e.target.matches?.('[data-kg-q]')) st.qFocus = true; });
  // Repaint troca o input sem mover o foco para outro elemento (relatedTarget nulo): o foco volta em
  // afterPaint. Tab ou clique em outro controle (relatedTarget) encerram a digitação.
  view.addEventListener('focusout', e => {
    if (e.target.matches?.('[data-kg-q]') && e.relatedTarget && !e.relatedTarget.matches('[data-kg-q]')) st.qFocus = false;
  });
  view.addEventListener('keydown', e => {
    if (!e.target.matches?.('[data-kg-q]')) return;
    if (e.key === 'Escape') { e.preventDefault(); st.qOpen = false; refresh(); }
    else if (e.key === 'Enter') { const r = search(index() || { ents: [] }, st.q); if (r.length) { e.preventDefault(); st.qFocus = false; goTo(r[0].id); } }
  });
  view.addEventListener('change', e => {
    if (e.target.matches('[data-kg-to]')) { st.to = e.target.value; refresh(); }
  });
  view.addEventListener('mouseover', e => {
    const n = e.target.closest?.('[data-kg-hov]');
    if (n && st.hov !== n.dataset.kgHov) { st.hov = n.dataset.kgHov; refresh(); }
  });
  view.addEventListener('mouseout', e => {
    const n = e.target.closest?.('[data-kg-hov]');
    if (n && !n.contains(e.relatedTarget) && st.hov) { st.hov = null; refresh(); }
  });
  view.addEventListener('click', e => {
    const t = e.target;
    if (!t.closest?.('.kg-screen')) return;
    // O repaint derruba o foco do botão clicado: afterPaint devolve o foco à área rolável (atalhos J/K/Esc).
    st.keyFocus = true;
    if (!t.closest('[data-kg-q]') && !t.closest('#kg-res') && st.qOpen) { st.qOpen = false; st.qFocus = false; }
    const go = t.closest('[data-kg-go]');
    if (go) { st.qFocus = false; goTo(go.dataset.kgGo); return; }
    const vt = t.closest('[data-kg-vtab]');
    if (vt) { st.vtab = vt.dataset.kgVtab; st.zoomAuto = true; refresh(); return; }
    const md = t.closest('[data-kg-mode]');
    if (md) { st.mode = md.dataset.kgMode; st.zoomAuto = true; refresh(); return; }
    const dp = t.closest('[data-kg-depth]');
    if (dp) { st.depth = Number(dp.dataset.kgDepth); st.mode = 'ego'; refresh(); return; }
    const ct = t.closest('[data-kg-cat]');
    if (ct) { const k = ct.dataset.kgCat; st.cats = { ...st.cats, [k]: st.cats[k] === false }; refresh(); return; }
    const zm = t.closest('[data-kg-zoom]');
    if (zm) {
      const v = zm.dataset.kgZoom;
      if (v === 'fit') { st.zoomAuto = true; st.zoom = 0; }
      else st.zoom = Math.max(0.5, Math.min(1.4, Math.round((st.zoom + 0.1 * Number(v)) * 100) / 100));
      refresh(); return;
    }
    const sd = t.closest('[data-kg-sdd]');
    if (sd) { st.vtab = 'sdd'; st.scroll = 0; load(JSON.parse(sd.dataset.kgSdd)); return; }
    const fb = t.closest('[data-kg-file]');
    if (fb) { st.scroll = 0; load({ file: fb.dataset.kgFile }); return; }
    const tb = t.closest('[data-kg-ticket]');
    if (tb) { st.scroll = 0; load({ taskId: tb.dataset.kgTicket }); return; }
    if (t.closest('[data-kg-clear]')) { load({}); return; }
    if (t.closest('[data-kg-reload]')) { if (qs(st.filter)) load(); else loadAll(); }
  });

  // Teclado do artboard, com o foco dentro da tela (fora de campos). Captura em window: o atalho
  // global 1–N (ux.js) trocaria de tela antes; aqui 1–2 trocam a visão.
  window.addEventListener('keydown', e => {
    if (document.body.dataset.view !== 'grafo' || !e.target.closest?.('.kg-scroll')) return;
    if (e.metaKey || e.ctrlKey || e.altKey || /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
    const k = e.key;
    st.keyFocus = true;
    if (k === '1' || k === '2') { e.preventDefault(); e.stopImmediatePropagation(); st.vtab = k === '1' ? 'own' : 'sdd'; st.zoomAuto = true; st.toast = ''; refresh(); return; }
    if (st.vtab !== 'own') return;
    const I = index();
    if (!I || !st.focus) return;
    const flat = relGroups(I, st.focus, st.cats).flat;
    if ((k === 'j' || k === 'k') && flat.length) {
      e.preventDefault();
      const cur = st.kj < 0 ? (k === 'j' ? -1 : flat.length) : st.kj;
      const n = Math.max(0, Math.min(flat.length - 1, cur + (k === 'j' ? 1 : -1)));
      st.kj = n; st.hov = flat[n];
      st.toast = `Relação ${n + 1} de ${flat.length}: ${I.byId[flat[n]].name}. Enter centraliza.`;
      refresh();
    } else if (k === 'Enter' && st.kj >= 0 && flat[st.kj] && e.target.matches('.kg-scroll')) {
      e.preventDefault(); goTo(flat[st.kj]);
    } else if (k === 'Escape') {
      e.preventDefault();
      if (st.hov || st.kj >= 0) { st.hov = null; st.kj = -1; st.toast = ''; refresh(); }
      else if (st.hist.length > 1) {
        st.hist = st.hist.slice(0, -1); st.focus = st.hist[st.hist.length - 1];
        st.toast = `Voltou para ${I.byId[st.focus]?.name || ''}.`; refresh();
      }
    }
  }, true);

  // Relê o grafo a cada 60 s com a tela aberta e a página visível (só GET).
  function tick() {
    if (document.hidden || document.body.dataset.view !== 'grafo') return;
    if (st.vtab === 'sdd' && qs(st.filter)) load(); else loadAll();
  }
  setInterval(tick, 60000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) tick(); });

  window.GraphView = { render, load };
  // Página aberta direto em #grafo: views.js já renderizou o placeholder antes de nós.
  window.Views?.refresh();
})(typeof window !== 'undefined' ? window : globalThis);
