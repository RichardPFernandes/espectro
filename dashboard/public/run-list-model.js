// run-list-model.js — contas da tela Runs no design Espectro (artboards Main e RunDetail), sem DOM.
// Lê só o read model de /api/runs (status, kind, node, nodes, updatedAt, state). Todo número diz
// a fonte; sem medição devolve null (a tela escreve "sem medição"), nunca 0 inventado.
// Script clássico (window.RunListModel) e módulo CommonJS (run-list-model.test.js).
(root => {
  'use strict';
  const DAY = 86400000;
  const NODE_KEYS = ['fetch_ticket', 'plan', 'implement', 'review', 'test', 'verify', 'commit'];
  // Mesmas 4 fases da Linha do tempo: 7 tons de um matiz não se distinguem, 4 sim.
  const PHASES = [['fetch_ticket', 'plan'], ['implement'], ['review', 'test', 'verify'], ['commit']];
  const phaseOf = node => PHASES.findIndex(p => p.includes(node));

  const isDone = r => r.kind === 'completed' || r.kind === 'has_pr';
  const needsYou = r => r.status === 'needs_human_review' || r.status === 'failed' || r.status === 'awaiting_approval';
  // Filtro por estado do cabeçalho (Todas · Precisa de você · Em andamento · Concluídas).
  function bucketOf(r) {
    if (isDone(r)) return 'done';
    if (needsYou(r)) return 'need';
    return r.status === 'running' ? 'run' : 'other';
  }

  const costOf = r => { const c = r?.state?.cost_tracking; return c && c.nodes && c.totals ? c : null; };
  // Totais medidos pelo watcher (cost_tracking.totals). Cada campo ausente vira null.
  function totalsOf(r) {
    const t = costOf(r)?.totals;
    if (!t) return { usd: null, tokens: null, ms: null, loops: null };
    const tokens = t.input_tokens == null && t.output_tokens == null ? null : (t.input_tokens || 0) + (t.output_tokens || 0);
    return { usd: typeof t.cost_usd === 'number' ? t.cost_usd : null, tokens, ms: typeof t.duration_ms === 'number' ? t.duration_ms : null,
      loops: typeof t.loop_count === 'number' ? t.loop_count : null };
  }
  const retriesOf = r => Object.values(r?.state?.retries || {}).reduce((a, b) => a + (Number(b) || 0), 0);
  // Retrabalho do run: tentativas extras + loops. Sem nenhum dos dois campos gravados = sem medição.
  function reworkOf(r) {
    const hasRetries = !!(r?.state && 'retries' in r.state), loops = totalsOf(r).loops;
    if (!hasRetries && loops == null) return null;
    return retriesOf(r) + (loops || 0);
  }
  const startOf = r => Date.parse(r?.state?.started_at) || Date.parse(r?.updatedAt) || null;

  const median = xs => {
    if (!xs.length) return null;
    const s = [...xs].sort((a, b) => a - b), m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  };
  const mean = xs => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

  // Série diária de 14 dias (dia sem run medido fica fora, não vira 0) e comparação dos últimos 7
  // dias com os 7 anteriores. pick(r) devolve o número do run ou null (sem medição).
  function windowStat(runs, now, pick, agg) {
    const days = Array.from({ length: 14 }, () => []);
    const last = [], prev = [];
    for (const r of runs) {
      const at = startOf(r), v = pick(r);
      if (at == null || v == null) continue;
      const age = Math.floor((now - at) / DAY);
      if (age < 0 || age >= 14) continue;
      days[13 - age].push(v);
      (age < 7 ? last : prev).push(v);
    }
    const value = agg(last);
    const before = agg(prev);
    const delta = value != null && before ? (value - before) / before : null;
    return { value, delta, series: days.filter(d => d.length).map(agg), n: last.length };
  }

  // Indicadores dos últimos 7 dias (kcards do Main). Tempo até PR fica fora: o app não grava
  // quando o PR abriu.
  function kpis(runs, now = Date.now()) {
    const recent = runs.filter(r => { const at = startOf(r); return at != null && now - at < 7 * DAY && now - at >= 0; });
    const usds = recent.map(r => totalsOf(r).usd).filter(v => v != null);
    return {
      runs7: recent.length,
      cost7: usds.length ? usds.reduce((a, b) => a + b, 0) : null,
      cost: windowStat(runs, now, r => totalsOf(r).usd, mean),
      tokens: windowStat(runs, now, r => totalsOf(r).tokens, median),
      // Retrabalho só conta run que já tem state.retries gravado (sem o campo = sem medição).
      // Mesma regra do filtro do card: novas tentativas (state.retries) + loops (cost_tracking.totals.loop_count).
      rework: windowStat(runs, now, reworkOf, mean),
    };
  }

  // Filtros dos kcards (clicar no card filtra a lista, como no artboard).
  const KF = {
    cost: (r, k) => k.cost.value != null && (totalsOf(r).usd ?? -1) > k.cost.value,
    tokens: r => r.status === 'running',
    rework: r => (reworkOf(r) || 0) > 0,
  };
  const kfMatch = (key, r, k) => (KF[key] ? KF[key](r, k) : true);

  // Custo por nó nos últimos 7 dias, em % do total medido. Sem medição: null.
  function nodeCost(runs, now = Date.now()) {
    const sum = Object.fromEntries(NODE_KEYS.map(k => [k, 0]));
    const measured = new Set();
    let total = 0;
    for (const r of runs) {
      const at = startOf(r), c = costOf(r);
      if (!c || at == null || now - at >= 7 * DAY || now - at < 0) continue;
      for (const k of NODE_KEYS) {
        const v = c.nodes[k]?.cost_usd;
        if (typeof v === 'number') measured.add(k);
        if (typeof v === 'number' && v > 0) { sum[k] += v; total += v; }
      }
    }
    if (!(total > 0)) return null;
    // measured: o nó teve custo gravado em algum run da janela (sem isso a tela escreve "sem medição", não 0%).
    const rows = NODE_KEYS.map(k => ({ node: k, usd: sum[k], share: Math.round((sum[k] / total) * 100), measured: measured.has(k) }));
    const top = [...rows].sort((a, b) => b.usd - a.usd).filter(x => x.usd > 0).slice(0, 2).map(x => x.node);
    return { total, rows, top };
  }

  // Ordenação da lista: Urgência (falhou, espera você, rodando, resto; depois mais recente),
  // Custo (maior primeiro, sem medição no fim) e Recentes.
  const URG = { failed: 0, needs_human_review: 1, awaiting_approval: 1, running: 2 };
  const recent = (a, b) => (Date.parse(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0);
  function sortRuns(list, mode = 'urg') {
    const out = [...list];
    if (mode === 'cost') return out.sort((a, b) => ((totalsOf(b).usd ?? -1) - (totalsOf(a).usd ?? -1)) || recent(a, b));
    if (mode === 'recent') return out.sort(recent);
    return out.sort((a, b) => ((URG[a.status] ?? 3) - (URG[b.status] ?? 3)) || recent(a, b));
  }

  // Meta da etapa no pipeline: "4:10 · US$ 0,16" do cost_tracking e tentativas extras.
  const mmss = ms => { const s = Math.round(ms / 1000); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
  const money = v => `US$ ${v.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: v > 0 && v < 0.01 ? 4 : 2 })}`;
  function nodeMeta(r, key) {
    const n = costOf(r)?.nodes?.[key];
    const parts = [];
    if (typeof n?.duration_ms === 'number') parts.push(mmss(n.duration_ms));
    if (typeof n?.cost_usd === 'number') parts.push(money(n.cost_usd));
    const extra = Number(r?.state?.retries?.[key]) || 0;
    if (extra) parts.push(`tentativa ${extra + 1}`);
    return parts.join(' · ');
  }

  // Tentativas do agente (painel da run selecionada e aba Custos): uma linha por nó medido.
  function attempts(r) {
    const c = costOf(r);
    if (!c) return [];
    return NODE_KEYS.filter(k => c.nodes[k]).map(k => {
      const n = c.nodes[k];
      const tokens = n.input_tokens == null && n.output_tokens == null ? null : (n.input_tokens || 0) + (n.output_tokens || 0);
      return { node: k, runs: typeof n.runs === 'number' ? n.runs : null, retries: typeof n.retries === 'number' ? n.retries : null,
        tokens, usd: typeof n.cost_usd === 'number' ? n.cost_usd : null, ms: typeof n.duration_ms === 'number' ? n.duration_ms : null };
    });
  }

  // Trechos por etapa a partir de agent_log: o tempo entre um despacho e o seguinte vai para as
  // etapas que o seguinte registrou (divididas por igual). Mesma conta da Linha do tempo.
  function segments(r, now = Date.now()) {
    const s = r.state || {};
    const log = (s.agent_log || []).filter(a => Date.parse(a.at)).sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
    const start = Date.parse(s.started_at) || (log[0] && Date.parse(log[0].at)) || Date.parse(r.updatedAt) || null;
    const segs = [];
    let prev = start;
    for (const a of log) {
      const at = Date.parse(a.at);
      const nodes = (a.nodes || []).filter(n => NODE_KEYS.includes(n));
      if (!nodes.length) { prev = Math.max(prev, at); continue; }
      const span = Math.max(0, at - prev) / nodes.length;
      nodes.forEach((n, i) => segs.push({ node: n, phase: phaseOf(n), from: prev + span * i, to: prev + span * (i + 1), note: a.note }));
      prev = Math.max(prev, at);
    }
    const active = !isDone(r) && r.status !== 'committed';
    const end = active ? now : Math.max(prev || 0, Date.parse(r.updatedAt) || prev || 0);
    return { start, segs, tail: active && start != null ? { from: prev, to: end, blocked: needsYou(r) } : null, end };
  }

  // Atividade recente: as últimas notas do agent_log, mais nova primeiro.
  function activity(r, max = 3) {
    return (r?.state?.agent_log || []).filter(a => Date.parse(a.at) && (a.note || (a.nodes || []).length))
      .sort((a, b) => Date.parse(b.at) - Date.parse(a.at)).slice(0, max)
      .map(a => ({ at: a.at, nodes: (a.nodes || []).filter(n => NODE_KEYS.includes(n)), note: a.note || '' }));
  }

  // Abas do detalhe da run (RunDetail): 6 grupos; só entra a aba que tem dado no app.
  // has: { tasks, api, replay, events, transcripts, cost } — o resto sempre existe ou fica fora.
  const TAB_DEFS = {
    summary: 'Resumo', tasks: 'Tasks', api: 'Contrato API', log: 'Log do agente', timeline: 'Timeline', replay: 'Replay',
    env: 'Ambiente & PRs', chat: 'Conversa', context: 'Contexto', transcripts: 'Transcrições', costs: 'Custos',
  };
  const GROUPS = [
    ['summary', 'Resumo', ['summary']], ['spec', 'Spec e plano', ['tasks', 'api']], ['exec', 'Execução', ['log', 'timeline', 'replay']],
    ['tests', 'Testes e entrega', ['env']], ['talk', 'Conversa e contexto', ['chat', 'context', 'transcripts']], ['costs', 'Custos', ['costs']],
  ];
  const OPTIONAL = { tasks: 'tasks', api: 'api', replay: 'replay', timeline: 'events', transcripts: 'transcripts', costs: 'cost' };
  function detailTabs(has = {}) {
    let n = 0;
    return GROUPS.map(([key, label, ids]) => ({ key, label, tabs: ids.filter(id => !OPTIONAL[id] || has[OPTIONAL[id]]).map(id => ({ id, label: TAB_DEFS[id] })) }))
      .filter(g => g.tabs.length).map(g => ({ ...g, n: ++n }));
  }
  // Próxima aba para J/K (sem dar a volta) e primeira aba do grupo N (atalhos 1–6).
  function stepTab(groups, cur, dir) {
    const flat = groups.flatMap(g => g.tabs.map(t => t.id));
    const i = flat.indexOf(cur);
    return flat[Math.max(0, Math.min(flat.length - 1, (i < 0 ? 0 : i + dir)))] || 'summary';
  }
  const groupTab = (groups, n) => groups.find(g => g.n === n)?.tabs[0]?.id || null;
  const validTab = (groups, id) => (groups.some(g => g.tabs.some(t => t.id === id)) ? id : 'summary');

  const api = { NODE_KEYS, PHASES, phaseOf, isDone, needsYou, bucketOf, totalsOf, retriesOf, median, kpis, kfMatch, nodeCost,
    sortRuns, nodeMeta, mmss, money, attempts, segments, activity, detailTabs, stepTab, groupTab, validTab };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.RunListModel = api;
})(typeof window !== 'undefined' ? window : globalThis);
