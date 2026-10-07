// Visões extras do dashboard (abas): Quadro, Tabela, Linha do tempo, Métricas,
// Tickets e PRs, Grafo (esta em graph.js). Script clássico carregado depois do principal: usa os globais de lá
// (runs, NODES, NODE_LABEL, STATUS, esc, ago, when, titleOf, isHidden, isDone,
// needsYou, visibleRuns, extractPrs, prBadge, prState, ticketIdOfRun, ticketCache,
// prCache, apiStatus, select, setGroupOpen, GROUPS, prefs, persist, $,
// ticketStatusBadge, retryQaRejection, refreshRuns, toast).
(() => {
  const VIEWS = [
    ['runs', 'Runs'], ['quadro', 'Quadro'], ['tabela', 'Tabela'],
    ['timeline', 'Linha do tempo'], ['metricas', 'Métricas'], ['tickets', 'Tickets e PRs'],
    ['redmine', 'Redmine'], ['grafo', 'Grafo'], ['padroes', 'Padrões'], ['prs', 'PRs'],
  ];
  // Etapas agrupadas em 4 fases pra linha do tempo: 7 tons de um matiz não ficam
  // distinguíveis (validado), 4 ficam. O nome exato da etapa vai no tooltip.
  const PHASES = [
    { key: 'prep', label: 'Preparação', nodes: ['fetch_ticket', 'plan'] },
    { key: 'build', label: 'Construção', nodes: ['implement'] },
    { key: 'check', label: 'Validação', nodes: ['review', 'test', 'verify'] },
    { key: 'ship', label: 'Entrega', nodes: ['commit'] },
  ];
  const phaseOf = node => PHASES.findIndex(p => p.nodes.includes(node));
  const DAY = 86400000;

  // "Meus Tickets" virou "Redmine" (redmine.js): hash/pref antigos caem na aba nova.
  const alias = v => (v === 'my-tickets' ? 'redmine' : v);
  let view = VIEWS.some(([k]) => k === alias(location.hash.slice(1))) ? alias(location.hash.slice(1))
    : location.hash.startsWith('#run/') ? 'runs' : (VIEWS.some(([k]) => k === alias(prefs.view)) ? alias(prefs.view) : 'runs');
  const table = Object.assign({ sort: 'updated', dir: -1, status: 'all', node: 'all', pr: 'all', hidden: false }, prefs.table || {});
  const tl = Object.assign({ range: 30 }, prefs.timeline || {});
  const tk = Object.assign({ filter: 'all' }, prefs.tickets || {});
  let bulk = { running: false, done: 0, total: 0 };

  // ------------------------------------------------------------------ helpers
  const shownRuns = (includeHidden = false) => visibleRuns().filter(r => includeHidden || !isHidden(r));
  const ticketOf = r => { const t = titleOf(r); return { num: t.num, text: t.text, id: ticketIdOfRun(r) }; };
  const statusLabel = r => STATUS[r.status] || r.status;
  const lamp = r => `<span class="lamp ${esc(r.status)}" title="${esc(statusLabel(r))}"></span>`;
  const stageOf = r => {
    if (r.status === 'committed' || isDone(r)) return 'done';
    if (NODES.some(([k]) => k === r.node)) return r.node;
    const h = (r.state?.history || []).filter(n => NODES.some(([k]) => k === n));
    return h.length ? h[h.length - 1] : 'fetch_ticket';
  };
  const retriesOf = r => Object.values(r.state?.retries || {}).reduce((a, b) => a + (Number(b) || 0), 0);
  const msgsOf = r => (r.state?.human_inputs || []).length;
  // Tokens totais (entrada + saída) de state.json.cost_tracking; null = sem medição
  // (run anterior ao rastreamento de custo, ou agente não reportou) — nunca 0.
  const usdOf = r => costOf(r)?.totals.cost_usd ?? null;
  const moneyTip = usd => (usd == null ? '' : `${fmtUsd(usd)}${fx?.rate ? ` · ${fmtBrl(usd)}` : ''}`);
  const tokensOf = r => {
    const t = costOf(r)?.totals;
    if (!t || (t.input_tokens == null && t.output_tokens == null)) return null;
    return (t.input_tokens || 0) + (t.output_tokens || 0);
  };
  function dur(ms) {
    if (!(ms >= 0)) return '—';
    const m = ms / 60000;
    if (m < 1) return '< 1 min';
    if (m < 60) return `${Math.round(m)} min`;
    const h = m / 60;
    if (h < 24) return `${h < 10 ? h.toFixed(1).replace('.', ',') : Math.round(h)} h`;
    const d = h / 24;
    return `${d < 10 ? d.toFixed(1).replace('.', ',') : Math.round(d)} d`;
  }
  const prsOf = r => extractPrs(r.state?.pull_request);
  const openAttr = r => `data-open="${esc(r.taskId)}"`;

  function openRun(taskId) {
    const r = runs.get(taskId);
    if (r) {
      const g = GROUPS.find(x => (x.hidden ? isHidden(r) : !isHidden(r) && x.match(r)));
      if (g) setGroupOpen(g.key, true);
    }
    setView('runs');
    select(taskId);
  }

  // ------------------------------------------------------------------ tabs
  function renderTabs() {
    $('tabs').innerHTML = VIEWS.map(([k, label]) =>
      `<button type="button" role="tab" data-view="${k}" aria-selected="${k === view}">${label}</button>`).join('');
    $('tabs').querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }
  function setView(v) {
    view = v; prefs.view = v; persist();
    const want = v === 'runs' ? (selected ? `#run/${encodeURIComponent(selected)}` : '') : `#${v}`;
    if (location.hash !== want) history.replaceState(null, '', want || location.pathname);
    document.body.dataset.view = v;
    renderTabs();
    refresh();
    if (v === 'tickets' && !bulk.running && !bulk.loadedOnce) loadAll(false);
    if (v === 'redmine') window.RedmineView?.load(false);
  }
  $('tabs').addEventListener('click', e => { const b = e.target.closest('[data-view]'); if (b) setView(b.dataset.view); });
  window.addEventListener('hashchange', () => { const v = alias(location.hash.slice(1)) || 'runs'; if (VIEWS.some(([k]) => k === v)) setView(v); });
  // #run/<id> é tratado em ux.js.

  $('view').addEventListener('click', e => {
    if (e.target.closest('a')) return;
    const o = e.target.closest('[data-open]');
    if (o) { openRun(o.dataset.open); return; }
    const act = e.target.closest('[data-vact]');
    if (act) handleAction(act.dataset.vact, act);
  });
  $('view').addEventListener('keydown', e => {
    const o = e.target.closest('[data-open]');
    if (o && e.target === o && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); openRun(o.dataset.open); }
  });
  $('view').addEventListener('change', e => {
    const el = e.target;
    if (el.dataset.tfilter) { table[el.dataset.tfilter] = el.type === 'checkbox' ? el.checked : el.value; prefs.table = table; persist(); refresh(); }
  });

  function handleAction(a, el) {
    if (a === 'sort') {
      const k = el.dataset.key;
      table.dir = table.sort === k ? -table.dir : (k === 'updated' || k === 'started' ? -1 : 1);
      table.sort = k; prefs.table = table; persist(); refresh();
    } else if (a === 'range') { tl.range = Number(el.dataset.range); prefs.timeline = tl; persist(); refresh(); }
    else if (a === 'tkfilter') { tk.filter = el.dataset.filter; prefs.tickets = tk; persist(); refresh(); }
    else if (a === 'loadall') loadAll(true);
    else if (a === 'toggledone') { prefs.boardDone = !prefs.boardDone; persist(); refresh(); }
  }

  // ------------------------------------------------------------------ tooltip
  const tip = document.createElement('div');
  tip.className = 'viz-tip'; tip.setAttribute('role', 'tooltip');
  document.body.appendChild(tip);
  function showTip(el, x, y) {
    // data-tip="${esc(html)}": o esc é escape de atributo — dataset.tip já volta como o
    // HTML original (com <strong>), por isso innerHTML aqui. Não tirar o esc de quem monta.
    tip.innerHTML = el.dataset.tip; tip.classList.add('show');
    const r = tip.getBoundingClientRect();
    const left = Math.min(Math.max(8, x + 14), innerWidth - r.width - 8);
    const top = y - r.height - 12 < 8 ? y + 18 : y - r.height - 12;
    tip.style.transform = `translate(${left}px, ${top}px)`;
  }
  $('view').addEventListener('mousemove', e => {
    const el = e.target.closest('[data-tip]');
    if (el) showTip(el, e.clientX, e.clientY); else tip.classList.remove('show');
  });
  $('view').addEventListener('mouseleave', () => tip.classList.remove('show'));
  $('view').addEventListener('focusin', e => {
    const el = e.target.closest('[data-tip]');
    if (el) { const b = el.getBoundingClientRect(); showTip(el, b.left + b.width / 2, b.top); }
  });
  $('view').addEventListener('focusout', () => tip.classList.remove('show'));

  // ------------------------------------------------------------------ Quadro
  function renderBoard() {
    const list = shownRuns();
    const cols = [...NODES.map(([k, label]) => ({ key: k, label })), { key: 'done', label: 'Concluído' }];
    const by = Object.fromEntries(cols.map(c => [c.key, []]));
    for (const r of list) by[stageOf(r)].push(r);
    for (const k in by) by[k].sort((a, b) => (needsYou(b) - needsYou(a)) || (Date.parse(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0));
    const showDone = !!prefs.boardDone;
    const card = r => {
      const t = ticketOf(r);
      const prs = prsOf(r);
      const retries = retriesOf(r);
      return `<div class="bcard ${needsYou(r) ? 'attn' : ''}" role="button" tabindex="0" ${openAttr(r)}>
        <div class="bcard-top">${lamp(r)}<span class="bnum">${esc(t.num || '')}</span><span class="bwhen">${esc(ago(r.updatedAt))}</span></div>
        <div class="btitle">${esc(t.text)}</div>
        <div class="bmeta">
          <span>${esc(statusLabel(r))}</span>
          ${retries ? `<span title="Tentativas extras">↻ ${retries}</span>` : ''}
          ${r.pendingHumanInput ? '<span class="mail">✉ na fila</span>' : ''}
          ${prs.slice(0, 2).map(p => prBadge(r.taskId, p)).join('')}${prs.length > 2 ? `<span class="pr-more">+${prs.length - 2}</span>` : ''}
        </div>
      </div>`;
    };
    return `<div class="vhead"><h2>Quadro por etapa</h2><p>Cada run fica na etapa que vai rodar em seguida. Os parados esperando você têm borda amarela e vêm primeiro.</p>
      <div class="vtools"><button class="ghost-btn" type="button" data-vact="toggledone">${showDone ? 'Esconder concluídos' : `Mostrar concluídos (${by.done.length})`}</button></div></div>
      <div class="board">${cols.filter(c => c.key !== 'done' || showDone).map(c => `
        <section class="bcol" aria-label="${esc(c.label)}">
          <header><span>${esc(c.label)}</span><span class="count">${by[c.key].length}</span></header>
          <div class="bcol-body">${by[c.key].map(card).join('') || '<div class="bempty">Nenhum run</div>'}</div>
        </section>`).join('')}
      </div>`;
  }

  // ------------------------------------------------------------------ Tabela
  const TABLE_COLS = [
    ['ticket', 'Ticket'], ['subject', 'Assunto'], ['stage', 'Etapa'], ['status', 'Status'], ['pr', 'PR'],
    ['retries', 'Tentativas'], ['tokens', 'Tokens'], ['cost', 'Custo'], ['msgs', 'Mensagens'], ['started', 'Iniciado'], ['updated', 'Atualizado'],
  ];
  const STAGE_ORDER = [...NODES.map(([k]) => k), 'done'];
  const STATUS_ORDER = ['needs_human_review', 'awaiting_approval', 'failed', 'running', 'pending', 'unknown', 'committed'];
  function sortValue(r, k) {
    switch (k) {
      case 'ticket': return ticketOf(r).id || 0;
      case 'subject': return ticketOf(r).text.toLowerCase();
      case 'stage': return STAGE_ORDER.indexOf(stageOf(r));
      case 'status': return STATUS_ORDER.indexOf(r.status);
      case 'pr': return prsOf(r).length;
      case 'retries': return retriesOf(r);
      case 'tokens': return tokensOf(r) ?? -1;
      case 'cost': return usdOf(r) ?? -1;
      case 'msgs': return msgsOf(r) + (r.pendingHumanInput ? 0.5 : 0);
      case 'started': return Date.parse(r.state?.started_at) || 0;
      default: return Date.parse(r.updatedAt) || 0;
    }
  }
  function statusGroup(r) {
    if (isDone(r)) return 'done';
    if (needsYou(r)) return 'attention';
    return r.status === 'running' ? 'running' : 'other';
  }
  function renderTable() {
    let list = shownRuns(table.hidden);
    if (table.status !== 'all') list = list.filter(r => statusGroup(r) === table.status);
    if (table.node !== 'all') list = list.filter(r => stageOf(r) === table.node);
    if (table.pr !== 'all') list = list.filter(r => (prsOf(r).length > 0) === (table.pr === 'with'));
    list.sort((a, b) => {
      const va = sortValue(a, table.sort), vb = sortValue(b, table.sort);
      return (va < vb ? -1 : va > vb ? 1 : 0) * table.dir || (Date.parse(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0);
    });
    const opt = (v, cur, label) => `<option value="${v}" ${v === cur ? 'selected' : ''}>${label}</option>`;
    const head = TABLE_COLS.map(([k, label]) => {
      const sorted = table.sort === k;
      return `<th aria-sort="${sorted ? (table.dir > 0 ? 'ascending' : 'descending') : 'none'}">
        <button type="button" data-vact="sort" data-key="${k}">${label}<span class="sort-ind">${sorted ? (table.dir > 0 ? '↑' : '↓') : ''}</span></button></th>`;
    }).join('');
    const rows = list.map(r => {
      const t = ticketOf(r);
      const prs = prsOf(r);
      const stage = stageOf(r);
      return `<tr ${openAttr(r)} tabindex="0" class="${isHidden(r) ? 'hidden-run' : ''}">
        <td class="num">${esc(t.num || '—')}</td>
        <td class="subj"><span>${esc(t.text)}</span><small>${esc(r.taskId)}</small>${svcChips(r) ? `<span class="svcs">${svcChips(r, { max: 3 })}</span>` : ''}</td>
        <td>${esc(stage === 'done' ? 'Concluído' : NODE_LABEL[stage] || stage)}</td>
        <td><span class="tstatus">${lamp(r)}${esc(statusLabel(r))}</span></td>
        <td class="prs">${prs.map(p => prBadge(r.taskId, p)).join(' ') || '<span class="muted">—</span>'}</td>
        <td class="n">${retriesOf(r) || '<span class="muted">0</span>'}</td>
        <td class="n" ${costOf(r) ? `title="${esc(`${fmtMs(costOf(r).totals.duration_ms)} medidos · ${costOf(r).totals.loop_count} reexecução(ões)`)}"` : ''}>${tokensOf(r) == null ? '<span class="muted">—</span>' : esc(fmtTok(tokensOf(r)))}</td>
        <td class="n">${usdOf(r) == null ? '<span class="muted">—</span>' : `${esc(fmtUsd(usdOf(r)))}${fx?.rate ? `<small class="brl">${esc(fmtBrl(usdOf(r)))}</small>` : ''}`}</td>
        <td class="n">${msgsOf(r) || '<span class="muted">0</span>'}${r.pendingHumanInput ? ' <span class="mail">+ fila</span>' : ''}</td>
        <td class="d">${esc(when(r.state?.started_at) || '—')}</td>
        <td class="d">${esc(ago(r.updatedAt) || '—')}</td>
      </tr>`;
    }).join('');
    return `<div class="vhead"><h2>Tabela</h2><p>Clique no cabeçalho para ordenar e na linha para abrir o run. A busca do topo também filtra aqui.</p>
      <div class="vtools filters">
        <label>Status <select data-tfilter="status">${opt('all', table.status, 'Todos')}${opt('attention', table.status, 'Precisa de você')}${opt('running', table.status, 'Em andamento')}${opt('other', table.status, 'Planejados e outros')}${opt('done', table.status, 'Concluídos')}</select></label>
        <label>Etapa <select data-tfilter="node">${opt('all', table.node, 'Todas')}${NODES.map(([k, l]) => opt(k, table.node, l)).join('')}${opt('done', table.node, 'Concluído')}</select></label>
        <label>PR <select data-tfilter="pr">${opt('all', table.pr, 'Todos')}${opt('with', table.pr, 'Com PR')}${opt('without', table.pr, 'Sem PR')}</select></label>
        <label class="chk"><input type="checkbox" data-tfilter="hidden" ${table.hidden ? 'checked' : ''}> Incluir removidos da lista</label>
        <span class="muted">${list.length} run${list.length === 1 ? '' : 's'}</span>
      </div></div>
      <div class="table-wrap"><table class="runs-table"><thead><tr>${head}</tr></thead><tbody>${rows ||
        `<tr><td colspan="${TABLE_COLS.length}" class="empty-row">Nenhum run com esses filtros.</td></tr>`}</tbody></table></div>`;
  }

  // ------------------------------------------------------------------ Linha do tempo
  // Segmentos a partir de agent_log: o trecho entre um despacho e o seguinte é
  // atribuído às etapas que o despacho seguinte registrou (divididas por igual).
  function segmentsOf(r) {
    const s = r.state || {};
    const log = (s.agent_log || []).filter(a => Date.parse(a.at)).sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
    const start = Date.parse(s.started_at) || (log[0] && Date.parse(log[0].at)) || Date.parse(r.updatedAt);
    const segs = [];
    let prev = start;
    for (const a of log) {
      const at = Date.parse(a.at);
      const nodes = (a.nodes || []).filter(n => NODES.some(([k]) => k === n));
      if (!nodes.length) { prev = Math.max(prev, at); continue; }
      const span = Math.max(0, at - prev) / nodes.length;
      nodes.forEach((n, i) => segs.push({ node: n, from: prev + span * i, to: prev + span * (i + 1), note: a.note }));
      prev = Math.max(prev, at);
    }
    const active = !isDone(r) && r.status !== 'committed';
    const end = active ? Date.now() : Math.max(prev, Date.parse(r.updatedAt) || prev);
    return { start, segs, tail: active ? { from: prev, to: end, blocked: needsYou(r) } : null, end };
  }

  function renderTimeline() {
    const list = shownRuns().map(r => ({ r, ...segmentsOf(r) })).filter(x => x.start);
    const now = Date.now();
    const maxEnd = Math.max(now, ...list.map(x => x.end));
    const minStart = tl.range ? maxEnd - tl.range * DAY : Math.min(...list.map(x => x.start));
    const inRange = list.filter(x => x.end >= minStart).sort((a, b) => b.start - a.start);
    const span = Math.max(maxEnd - minStart, DAY);
    const pct = t => ((Math.min(Math.max(t, minStart), maxEnd) - minStart) / span) * 100;
    const days = Math.ceil(span / DAY);
    const step = days <= 10 ? 1 : days <= 35 ? 5 : days <= 120 ? 15 : 30;
    const ticks = [];
    const d0 = new Date(minStart); d0.setHours(0, 0, 0, 0);
    for (let t = d0.getTime() + DAY, i = 0; t < maxEnd; t += DAY, i++) {
      if (i % step === 0) ticks.push(t);
    }
    const fmtDay = t => new Date(t).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
    const lanes = inRange.map(({ r, segs, tail }) => {
      const t = ticketOf(r);
      const bars = segs.filter(s => s.to >= minStart).map(s => {
        const ph = phaseOf(s.node);
        const left = pct(s.from), width = Math.max(pct(s.to) - left, 0.6);
        const txt = `<strong>${esc(t.num)} ${esc(NODE_LABEL[s.node])}</strong><br>${esc(when(new Date(s.from).toISOString()))} → ${esc(when(new Date(s.to).toISOString()))}<br>${esc(dur(s.to - s.from))} · fase ${esc(PHASES[ph].label)}`;
        return `<span class="tl-seg ph${ph}" style="left:${left}%;width:${width}%" data-tip="${esc(txt)}" tabindex="0" aria-label="${esc(`${NODE_LABEL[s.node]}, ${dur(s.to - s.from)}`)}"></span>`;
      }).join('');
      const tailHtml = tail && tail.to > minStart ? (() => {
        const left = pct(tail.from), width = Math.max(pct(tail.to) - left, 0.6);
        const label = tail.blocked ? 'Parado esperando você'
          : r.status === 'pending' ? 'Planejado, ainda sem execução' : `Aguardando ${NODE_LABEL[r.node] || 'próximo passo'}`;
        return `<span class="tl-seg tail ${tail.blocked ? 'blocked' : ''}" style="left:${left}%;width:${width}%" tabindex="0"
          data-tip="${esc(`<strong>${esc(t.num)} ${esc(label)}</strong><br>há ${esc(dur(tail.to - tail.from))}`)}" aria-label="${esc(label)}"></span>`;
      })() : '';
      return `<div class="lane">
        <div class="lane-label" role="button" tabindex="0" ${openAttr(r)}>${lamp(r)}<span><b>${esc(t.num || '')}</b> ${esc(t.text)}</span></div>
        <div class="lane-track">${tailHtml}${bars}</div>
      </div>`;
    }).join('');
    const rangeBtn = (n, label) => `<button type="button" data-vact="range" data-range="${n}" aria-pressed="${tl.range === n}">${label}</button>`;
    return `<div class="vhead"><h2>Linha do tempo</h2><p>Uma faixa por run. Cada trecho é o tempo até o agente registrar uma etapa (pelo agent_log); a faixa tracejada é quanto tempo o run está esperando agora.</p>
      <div class="vtools"><div class="seg-ctl" role="group" aria-label="Período">${rangeBtn(7, '7 dias')}${rangeBtn(30, '30 dias')}${rangeBtn(0, 'Tudo')}</div>
        <div class="legend">${PHASES.map((p, i) => `<span><i class="sw ph${i}"></i>${p.label} <small>(${p.nodes.map(n => NODE_LABEL[n]).join(', ')})</small></span>`).join('')}
          <span><i class="sw tail"></i>Esperando</span><span><i class="sw tail blocked"></i>Parado esperando você</span></div></div></div>
      ${inRange.length ? `<div class="timeline">
        <div class="lane axis"><div class="lane-label"></div><div class="lane-track">${ticks.map(t => `<span class="tick" style="left:${pct(t)}%">${fmtDay(t)}</span>`).join('')}<span class="tick now" style="left:${pct(now)}%">agora</span></div></div>
        <div class="lanes">${lanes}</div></div>` : '<div class="vempty">Nenhum run com atividade nesse período.</div>'}`;
  }

  // ------------------------------------------------------------------ Métricas
  function median(xs) {
    if (!xs.length) return null;
    const s = [...xs].sort((a, b) => a - b), m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  }
  function barChart(rows, { fmt = v => String(v), unit = '', empty = 'Sem dados.' } = {}) {
    const max = Math.max(...rows.map(r => r.value), 0);
    if (!max) return `<p class="muted">${empty}</p>`;
    return `<div class="bars">${rows.map(r => `
      <div class="bar-row" tabindex="0" data-tip="${esc(r.tip || `<strong>${esc(r.label)}</strong><br>${esc(fmt(r.value))}${unit}`)}">
        <span class="bar-label">${esc(r.label)}</span>
        <span class="bar-track"><span class="bar ${r.cls || ''}" style="width:${r.value ? Math.max((r.value / max) * 100, 1.5) : 0}%"></span></span>
        <span class="bar-val">${r.value ? esc(fmt(r.value)) : '<span class="muted">0</span>'}</span>
      </div>`).join('')}</div>`;
  }
  function renderMetrics() {
    const list = shownRuns();
    const count = f => list.filter(f).length;
    const tiles = [
      ['Precisa de você', count(r => !isDone(r) && needsYou(r)), 'attn'],
      ['Em andamento', count(r => !isDone(r) && !needsYou(r) && r.status === 'running'), ''],
      ['Planejados e outros', count(r => !isDone(r) && !needsYou(r) && r.status !== 'running'), ''],
      ['Concluídos', count(isDone), ''],
      ['PRs', list.reduce((a, r) => a + prsOf(r).length, 0), ''],
      ['Mensagens ao agente', list.reduce((a, r) => a + msgsOf(r), 0), ''],
    ];
    const active = list.filter(r => !isDone(r));
    const byStage = NODES.map(([k, label]) => ({ label, value: active.filter(r => stageOf(r) === k).length }));
    // Tempo por etapa: run com cost_tracking usa a duração MEDIDA pelo watcher
    // (duration_ms / runs = média por passagem); runs antigos seguem estimados pelo
    // agent_log. O custo de fetch_ticket fica dentro de plan (mesmo despacho).
    const durations = Object.fromEntries(NODES.map(([k]) => [k, []]));
    const measured = Object.fromEntries(NODES.map(([k]) => [k, 0]));
    for (const r of list) {
      const c = costOf(r);
      if (c) {
        for (const [k, n] of Object.entries(c.nodes)) {
          if (!durations[k] || !(n.duration_ms >= 0)) continue;
          const runsN = Math.max(n.runs || 1, 1);
          for (let i = 0; i < runsN; i++) durations[k].push(n.duration_ms / runsN);
          measured[k] += runsN;
        }
      } else {
        for (const s of segmentsOf(r).segs) durations[s.node].push(s.to - s.from);
      }
    }
    const timeRows = NODES.map(([k, label]) => {
      const m = median(durations[k]);
      const src = measured[k] ? ` (${measured[k]} medida(s) pelo watcher)` : '';
      return { label, value: m || 0, tip: `<strong>${esc(label)}</strong><br>mediana ${esc(dur(m))} em ${durations[k].length} passagem(ns)${esc(src)}` };
    });
    // Tokens: só runs com cost_tracking. Por etapa = soma; por tipo de ticket = média
    // por run (é o que responde "que tipo de ticket custa mais").
    const costed = list.filter(r => tokensOf(r) != null);
    const nodeTok = n => (n.input_tokens == null && n.output_tokens == null) ? 0 : (n.input_tokens || 0) + (n.output_tokens || 0);
    const tokenRows = NODES.map(([k, label]) => {
      let sum = 0, inp = 0, out = 0, runsN = 0, silent = 0;
      for (const r of costed) {
        const n = costOf(r).nodes[k];
        if (!n) continue;
        sum += nodeTok(n); inp += n.input_tokens || 0; out += n.output_tokens || 0; runsN += n.runs || 1;
        silent += n.runs_without_tokens || 0;
      }
      const silentTxt = silent ? `<br>${silent} execução(ões) sem tokens reportados (não contam como 0)` : '';
      return { label, value: sum, tip: `<strong>${esc(label)}</strong><br>${esc(fmtTok(inp))} entrada · ${esc(fmtTok(out))} saída<br>${runsN} execução(ões)${silentTxt}` };
    });
    const byTracker = new Map();
    for (const r of costed) {
      const key = r.ticket?.tracker || 'Sem tipo';
      const g = byTracker.get(key) || { tok: 0, ms: 0, loops: 0, n: 0 };
      const t = costOf(r).totals;
      g.tok += tokensOf(r); g.ms += t.duration_ms || 0; g.loops += t.loop_count || 0; g.n += 1;
      byTracker.set(key, g);
    }
    const trackerRows = [...byTracker.entries()].sort((a, b) => b[1].tok / b[1].n - a[1].tok / a[1].n).map(([label, g]) => ({
      label, value: Math.round(g.tok / g.n),
      tip: `<strong>${esc(label)}</strong><br>média ${esc(fmtTok(Math.round(g.tok / g.n)))} tokens · ${esc(dur(g.ms / g.n))} por run<br>${g.n} run(s) · ${g.loops} reexecução(ões) no total`,
    }));
    const totalTok = costed.reduce((a, r) => a + tokensOf(r), 0);
    const priced = list.filter(r => usdOf(r) != null);
    const totalUsd = priced.reduce((a, r) => a + usdOf(r), 0);
    const usdRows = NODES.map(([k, label]) => {
      let usd = 0, runsN = 0;
      for (const r of priced) { const n = costOf(r).nodes[k]; if (n?.cost_usd != null) { usd += n.cost_usd; runsN += n.runs || 1; } }
      return { label, value: usd, tip: `<strong>${esc(label)}</strong><br>${esc(moneyTip(usd))}<br>${runsN} execução(ões)` };
    });
    const usdByTracker = new Map();
    for (const r of priced) {
      const key = r.ticket?.tracker || 'Sem tipo';
      const g = usdByTracker.get(key) || { usd: 0, n: 0, loops: 0 };
      g.usd += usdOf(r); g.n += 1; g.loops += costOf(r).totals.loop_count || 0;
      usdByTracker.set(key, g);
    }
    const usdTrackerRows = [...usdByTracker.entries()].sort((a, b) => b[1].usd / b[1].n - a[1].usd / a[1].n).map(([label, g]) => ({
      label, value: g.usd / g.n,
      tip: `<strong>${esc(label)}</strong><br>média ${esc(moneyTip(g.usd / g.n))} por run<br>${g.n} run(s) · total ${esc(moneyTip(g.usd))} · ${g.loops} reexecução(ões)`,
    }));
    const totalLoops = list.reduce((a, r) => a + (costOf(r)?.totals.loop_count || 0), 0);
    const retryRows = NODES.map(([k, label]) => ({ label, value: list.reduce((a, r) => a + (Number(r.state?.retries?.[k]) || 0), 0) }));
    const prStates = { OPEN: 0, MERGED: 0, DECLINED: 0, SUPERSEDED: 0, '': 0 };
    for (const r of list) for (const p of prsOf(r)) prStates[prState(r.taskId, p) || ''] += 1;
    const prRows = [['OPEN', 'Abertos'], ['MERGED', 'Mergeados'], ['DECLINED', 'Recusados'], ['SUPERSEDED', 'Substituídos'], ['', 'Estado desconhecido']]
      .map(([k, label]) => ({ label: k ? `${label} (${k})` : label, value: prStates[k], cls: `st-${k || 'unknown'}` }));
    const liveKnown = list.some(r => prCache.get(r.taskId)?.data);
    return `<div class="vhead"><h2>Métricas</h2><p>Números dos runs visíveis (a busca do topo filtra). Tempos vêm da medição do watcher quando o run tem cost_tracking; senão, são estimados pelos horários do agent_log.</p></div>
      <div class="tiles">${[...tiles, ...(costed.length ? [
        [`Tokens (${costed.length} run${costed.length > 1 ? 's' : ''} medido${costed.length > 1 ? 's' : ''})`, fmtTok(totalTok), ''],
        ...(priced.length ? [[`Custo estimado${fx?.rate ? ` · ${esc(fmtBrl(totalUsd))}` : ''}`, esc(fmtUsd(totalUsd)), '']] : []),
        ['Reexecuções de etapa', totalLoops, ''],
      ] : [])].map(([l, v, c]) => `<div class="tile ${c}"><span class="tv">${v}</span><span class="tl">${l}</span></div>`).join('')}</div>
      <div class="charts">
        <section class="chart"><h3>Runs ativos por etapa</h3><p class="csub">Onde os runs em aberto estão agora.</p>${barChart(byStage, { fmt: v => `${v} run${v > 1 ? 's' : ''}` })}</section>
        <section class="chart"><h3>Tempo por etapa</h3><p class="csub">Mediana de cada passagem pela etapa.</p>${barChart(timeRows, { fmt: dur, empty: 'Nenhum agent_log com horários ainda.' })}</section>
        <section class="chart"><h3>Tokens por etapa</h3><p class="csub">Soma de entrada + saída medida pelo watcher (state.json.cost_tracking). Plan inclui o fetch_ticket.</p>${barChart(tokenRows, { fmt: fmtTok, empty: 'Nenhum run com custo medido ainda.' })}</section>
        <section class="chart"><h3>Custo por etapa</h3><p class="csub">US$ a preço de API por modelo (equivalente, se for assinatura).${fx?.rate ? ` Em R$ no tooltip — ${esc(fxNote())}` : ''}</p>${barChart(usdRows, { fmt: fmtUsd, empty: 'Nenhum run com custo em US$ ainda.' })}</section>
        <section class="chart"><h3>Custo por tipo de ticket</h3><p class="csub">${priced.length ? 'Média em US$ por run, por tipo do Redmine.' : 'Média de tokens por run, por tipo do Redmine (sem custo em US$ ainda).'}</p>${priced.length
          ? barChart(usdTrackerRows, { fmt: fmtUsd })
          : barChart(trackerRows, { fmt: fmtTok, empty: 'Nenhum run com custo medido ainda.' })}</section>
        <section class="chart"><h3>Retrabalho</h3><p class="csub">Tentativas extras registradas em state.json.retries.</p>${barChart(retryRows, { fmt: v => `${v} tentativa${v > 1 ? 's' : ''}`, empty: 'Nenhuma tentativa extra registrada.' })}</section>
        <section class="chart"><h3>Pull requests por estado</h3><p class="csub">${liveKnown ? 'Estado do Bitbucket onde já foi consultado; senão, o gravado no state.json.' : 'Estado gravado no state.json. Consulte o Bitbucket para o estado real.'}</p>
          ${barChart(prRows, { fmt: v => `${v} PR${v > 1 ? 's' : ''}`, empty: 'Nenhum PR registrado.' })}
          <button class="ghost-btn" type="button" data-vact="loadall" ${bulk.running ? 'disabled' : ''}>${bulk.running ? `Consultando… ${bulk.done}/${bulk.total}` : '↻ Consultar Redmine e Bitbucket'}</button></section>
      </div>`;
  }

  // ------------------------------------------------------------------ Tickets e PRs
  // Busca em lote (sob demanda: ao abrir a visão ou no botão), 4 por vez, reaproveitando
  // os mesmos caches e endpoints do painel do run.
  async function pool(tasks, n) {
    let i = 0;
    await Promise.all(Array.from({ length: Math.min(n, tasks.length) }, async () => {
      while (i < tasks.length) { const t = tasks[i++]; await t(); bulk.done++; refresh(); }
    }));
  }
  async function loadAll(force) {
    if (bulk.running) return;
    // Sem runs ainda (página aberta direto em #tickets, antes do /api/runs chegar):
    // não marca como carregado — refresh() tenta de novo quando os runs chegarem.
    if (!runs.size) return;
    const list = shownRuns();
    const byTicket = new Map();
    for (const r of list) { const id = ticketIdOfRun(r); if (id && !byTicket.has(id)) byTicket.set(id, r.taskId); }
    const tasks = [];
    for (const taskId of byTicket.values()) {
      if (!force && ticketCache.get(taskId)?.data) continue;
      tasks.push(async () => {
        try {
          const res = await apiStatus(`/api/runs/${encodeURIComponent(taskId)}/ticket`);
          if (res.ok) ticketCache.set(taskId, { data: res.body });
          else ticketErrors.set(taskId, res.status);
        } catch { ticketErrors.set(taskId, 0); }
      });
    }
    for (const r of list) {
      if (!prsOf(r).length) continue;
      const c = prCache.get(r.taskId);
      if (!force && c?.data && Date.now() - c.at < 60000) continue;
      tasks.push(async () => {
        try {
          const res = await apiStatus(`/api/runs/${encodeURIComponent(r.taskId)}/pr`);
          if (res.ok) prCache.set(r.taskId, { data: res.body, at: Date.now() });
          else prErrors.set(r.taskId, res.status);
        } catch { prErrors.set(r.taskId, 0); }
      });
    }
    bulk = { running: true, done: 0, total: tasks.length, loadedOnce: true };
    refresh();
    // finally: erro inesperado no lote não pode deixar o botão "Atualizar" travado.
    try {
      await pool(tasks, 4);
    } finally {
      bulk.running = false;
      renderSidebar();
      refresh();
    }
  }
  const ticketErrors = new Map();
  const prErrors = new Map();
  const CLOSED_RE = /conclu|encerr|fechad|closed|rejeit|cancel/i;

  function ticketFor(runsOfTicket) {
    for (const r of runsOfTicket) { const c = ticketCache.get(r.taskId); if (c?.data) return c.data; }
    return null;
  }
  function livePrs(r) {
    const live = prCache.get(r.taskId)?.data?.prs;
    return prsOf(r).map(p => {
      const l = live?.find(x => x.id === p.id && (!p.repo || x.repo === p.repo));
      return { ...p, state: (l?.state || p.state || '').toUpperCase(), title: l?.title, approvals: l?.participants || [], created_on: l?.created_on, error: l?.error };
    });
  }
  function alertsFor(ticket, rs, prs) {
    const out = [];
    // Run sem state.json legível (unknown) não conta como ativo nem como concluído.
    const known = rs.filter(r => r.status !== 'unknown');
    const anyActive = known.some(r => !isDone(r));
    const allDone = known.length > 0 && known.every(r => isDone(r));
    if (ticket && CLOSED_RE.test(ticket.status || '') && anyActive) out.push(`Ticket está “${ticket.status}” no Redmine, mas há run ativo.`);
    for (const p of prs) {
      if (p.state === 'DECLINED' && allDone) out.push(`PR ${p.repo || ''} #${p.id} foi recusado no Bitbucket, mas o run está concluído.`);
      if (p.state === 'DECLINED' && anyActive) out.push(`PR ${p.repo || ''} #${p.id} foi recusado no Bitbucket.`);
      if (p.state === 'OPEN' && !p.approvals.length && p.created_on && Date.now() - Date.parse(p.created_on) > 7 * DAY) {
        out.push(`PR ${p.repo || ''} #${p.id} está aberto há ${dur(Date.now() - Date.parse(p.created_on))} sem aprovação.`);
      }
    }
    if (ticket && prs.length && prs.every(p => p.state === 'MERGED') && !CLOSED_RE.test(ticket.status || '') && allDone) {
      out.push(`Todos os PRs estão mergeados; o ticket segue “${ticket.status}”.`);
    }
    return out;
  }
  function renderTickets() {
    const list = shownRuns();
    const groups = new Map();
    for (const r of list) {
      const id = ticketIdOfRun(r) || 'sem';
      if (!groups.has(id)) groups.set(id, []);
      groups.get(id).push(r);
    }
    let items = [...groups.entries()].map(([id, rs]) => {
      const ticket = id === 'sem' ? null : ticketFor(rs);
      const prs = rs.flatMap(r => livePrs(r).map(p => ({ ...p, taskId: r.taskId })));
      const seen = new Set();
      const uniq = prs.filter(p => { const k = `${p.repo}#${p.id || p.url}`; if (seen.has(k)) return false; seen.add(k); return true; });
      const alerts = id === 'sem' ? [] : alertsFor(ticket, rs, uniq);
      const errCode = rs.map(r => ticketErrors.get(r.taskId)).find(x => x !== undefined);
      return { id, rs, ticket, prs: uniq, alerts, errCode, latest: Math.max(...rs.map(r => Date.parse(r.updatedAt) || 0)) };
    });
    const counts = {
      all: items.length, alert: items.filter(i => i.alerts.length).length,
      open: items.filter(i => i.prs.some(p => p.state === 'OPEN')).length, nopr: items.filter(i => !i.prs.length).length,
    };
    if (tk.filter === 'alert') items = items.filter(i => i.alerts.length);
    if (tk.filter === 'open') items = items.filter(i => i.prs.some(p => p.state === 'OPEN'));
    if (tk.filter === 'nopr') items = items.filter(i => !i.prs.length);
    items.sort((a, b) => (a.id === 'sem') - (b.id === 'sem') || (b.alerts.length > 0) - (a.alerts.length > 0)
      || (b.rs.some(needsYou) - a.rs.some(needsYou)) || b.latest - a.latest);
    const chip = (k, label) => `<button type="button" data-vact="tkfilter" data-filter="${k}" aria-pressed="${tk.filter === k}">${label} <span class="count">${counts[k]}</span></button>`;
    const config = [...ticketErrors.values(), ...prErrors.values()].includes(503);
    const card = i => {
      const t = i.ticket;
      const first = i.rs[0];
      const title = t?.subject || ticketOf(first).text;
      const redmine = i.id === 'sem' ? '<span class="muted">Runs sem número de ticket</span>'
        : t ? `${ticketStatusBadge(t.status) || '<span class="muted">—</span>'}<span>${esc(t.assigned_to || 'sem responsável')}</span>
               ${t.done_ratio != null ? `<span>${t.done_ratio}%<span class="progress"><i style="width:${Math.max(0, Math.min(100, t.done_ratio))}%"></i></span></span>` : ''}
               ${t.estimated_hours != null ? `<span>${String(t.estimated_hours).replace('.', ',')} h estimadas</span>` : ''}
               <a class="ext" href="${esc(t.url)}" target="_blank" rel="noopener noreferrer">Redmine ↗</a>`
          : i.errCode === 503 ? '<span class="muted">Redmine não configurado</span>'
            : i.errCode !== undefined ? '<span class="muted">Ticket não encontrado ou Redmine indisponível</span>'
              : `<span class="muted">${bulk.running ? 'Consultando o Redmine…' : 'Ainda não consultado'}</span>`;
      const prs = i.prs.length ? i.prs.map(p => {
        const st = ['OPEN', 'MERGED', 'DECLINED', 'SUPERSEDED'].includes(p.state) ? p.state : '';
        const label = `${p.repo || 'PR'}${p.id ? ` #${p.id}` : ''}`;
        const inner = `<span class="pr-badge ${st || 'unknown'}">${esc(st || '?')}</span><span class="pr-id">${esc(label)}</span>${p.approvals.length ? `<span class="approved">✓ ${p.approvals.length}</span>` : ''}`;
        const tipText = [p.title, p.approvals.length ? `Aprovado por ${p.approvals.join(', ')}` : '', p.error || ''].filter(Boolean).join(' — ');
        return p.url ? `<a class="pr-line" href="${esc(p.url)}" target="_blank" rel="noopener noreferrer" title="${esc(tipText)}">${inner}</a>`
          : `<span class="pr-line" title="${esc(tipText)}">${inner}</span>`;
      }).join('') : '<span class="muted">Nenhum PR</span>';
      const runsHtml = i.rs.map(r => `<span class="run-chip" role="button" tabindex="0" ${openAttr(r)}>${lamp(r)}${esc(r.taskId.replace(/^\d{4,6}-/, ''))}
        <small>${esc(stageOf(r) === 'done' ? 'concluído' : NODE_LABEL[stageOf(r)] || '')}</small></span>`).join('');
      return `<article class="tcard ${i.alerts.length ? 'has-alert' : ''}">
        <header><span class="tnum">${i.id === 'sem' ? '—' : `#${esc(i.id)}`}</span><span class="tsubj">${esc(i.id === 'sem' ? 'Sem ticket' : title)}</span></header>
        <div class="tline"><span class="tlabel">Redmine</span><div class="tvals">${redmine}</div></div>
        <div class="tline"><span class="tlabel">Bitbucket</span><div class="tvals prs">${prs}</div></div>
        <div class="tline"><span class="tlabel">Runs</span><div class="tvals">${runsHtml}</div></div>
        ${i.alerts.length ? `<ul class="talerts">${i.alerts.map(a => `<li>${esc(a)}</li>`).join('')}</ul>` : ''}
      </article>`;
    };
    return `<div class="vhead"><h2>Tickets e PRs</h2><p>Um cartão por ticket do Redmine, com os PRs do Bitbucket e os runs do agente. Alertas apontam quando os três não batem.</p>
      <div class="vtools"><div class="seg-ctl" role="group" aria-label="Filtro">${chip('all', 'Todos')}${chip('alert', 'Com alerta')}${chip('open', 'PR aberto')}${chip('nopr', 'Sem PR')}</div>
        <button class="ghost-btn" type="button" data-vact="loadall" ${bulk.running ? 'disabled' : ''}>${bulk.running ? `Consultando… ${bulk.done}/${bulk.total}` : '↻ Atualizar Redmine e Bitbucket'}</button></div>
      ${config ? '<p class="fold-msg warn">Redmine ou Bitbucket não configurado — defina REDMINE_URL/REDMINE_API_KEY e BITBUCKET_API_TOKEN.</p>' : ''}</div>
      <div class="tgrid">${items.map(card).join('') || '<div class="vempty">Nenhum ticket com esse filtro.</div>'}</div>`;
  }

  // ------------------------------------------------------------------ render
  const RENDER = {
    quadro: renderBoard, tabela: renderTable, timeline: renderTimeline, metricas: renderMetrics, tickets: renderTickets,
    // graph.js/patterns.js/prs.js/redmine.js (carregados depois) montam as abas —
    // ver window.GraphView/PatternsView/PrsView/RedmineView.
    grafo: () => (window.GraphView ? window.GraphView.render() : '<div class="vempty">Carregando…</div>'),
    padroes: () => (window.PatternsView ? window.PatternsView.render() : '<div class="vempty">Carregando…</div>'),
    prs: () => (window.PrsView ? window.PrsView.render() : '<div class="vempty">Carregando…</div>'),
    redmine: () => (window.RedmineView ? window.RedmineView.render() : '<div class="vempty">Carregando…</div>'),
  };
  let pending = false;
  function refresh() {
    if (view === 'tickets' && runs.size && !bulk.running && !bulk.loadedOnce) loadAll(false);
    if (view === 'runs' || pending) return;
    pending = true;
    requestAnimationFrame(() => {
      pending = false;
      if (view === 'runs') return;
      const el = $('view');
      const keepY = el.scrollTop;
      const focusKey = document.activeElement?.dataset?.tfilter;
      el.innerHTML = RENDER[view]();
      el.scrollTop = keepY;
      if (focusKey) el.querySelector(`[data-tfilter="${focusKey}"]`)?.focus();
    });
  }

  window.Views = { refresh, openRun, setView, loadAll, current: () => view };
  renderTabs();
  document.body.dataset.view = view;
  if (view !== 'runs') setView(view);
})();
