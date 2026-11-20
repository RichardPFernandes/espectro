// routing-model.js — lógica pura da tela Roteamento (artboard ModelRouting, PRI-328).
// Agrega por nó as linhas de GET /api/routing > shadow_vs_real.rows (sombra S3 × decisão
// real, por Attempt) no formato da lista e do "Hoje contra a sombra". Não calcula classe,
// não resolve modelo e não estima custo: só conta o que o servidor já comparou (tier).
// Sem comparação aparece como "sem comparação", nunca como zero ou "igual".
// Script clássico (window.RoutingModel) e módulo CommonJS (testes).
(root => {
  // Ordem do grafo; nó fora da lista vai para o fim, em ordem alfabética.
  const NODE_ORDER = ['fetch_ticket', 'plan', 'implement', 'review', 'test', 'verify', 'commit'];
  const KINDS = ['SAME', 'REAL_HIGHER', 'REAL_LOWER', 'UNKNOWN'];
  const isObj = v => v != null && typeof v === 'object' && !Array.isArray(v);

  // Estado do nó (glifo + texto; a cor fica no CSS pela chave k).
  //   misto:    a sombra escolheria tier menor em uns Attempts e maior em outros.
  //   economia: em algum Attempt a sombra escolheria tier menor e em nenhum maior.
  //   igual:    todos os comparáveis com o mesmo tier.
  //   barato:   a sombra só escolheria tier maior (o atual já é o mais barato).
  //   sem:      nenhum Attempt comparável.
  const STATUS = {
    economia: { k: 'waiting', glyph: '‖', label: 'sombra mais barata' },
    misto: { k: 'waiting', glyph: '‖', label: 'sombra diverge nos dois sentidos' },
    igual: { k: 'done', glyph: '✓', label: 'sombra concorda' },
    barato: { k: 'done', glyph: '✓', label: 'atual mais barato' },
    sem: { k: 'queued', glyph: '?', label: 'sem comparação' },
  };
  function statusOf(c) {
    const comparable = c.SAME + c.REAL_HIGHER + c.REAL_LOWER;
    if (!comparable) return 'sem';
    if (c.REAL_HIGHER && c.REAL_LOWER) return 'misto';
    if (c.REAL_HIGHER) return 'economia';
    if (c.REAL_LOWER) return 'barato';
    return 'igual';
  }

  // Abas do artboard que têm dado: "Pedidos" fica fora (não há pedido de mudança de policy).
  const VIEWS = [
    ['all', 'Todos', () => true],
    ['save', 'Economia', n => n.status === 'economia' || n.status === 'misto'],
    ['ok', 'Atual certo', n => n.status === 'igual' || n.status === 'barato'],
  ];

  const top = list => {
    const n = new Map();
    for (const v of list) if (v) n.set(v, (n.get(v) || 0) + 1);
    return [...n.entries()].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0]))).map(e => e[0]);
  };
  const shadowLabel = s => (isObj(s) && s.tier ? `${s.tier}${s.class ? ` · ${s.class}` : ''}` : null);
  const realLabel = r => (isObj(r) && (r.model_id || r.tier) ? (r.model_id && r.model_id !== 'UNKNOWN' ? r.model_id : r.tier) : null);

  /** Um registro por nó, na ordem do grafo. */
  function aggregateNodes(rows) {
    const by = new Map();
    for (const r of Array.isArray(rows) ? rows : []) {
      if (!isObj(r) || typeof r.node !== 'string' || !r.node) continue;
      if (!by.has(r.node)) by.set(r.node, []);
      by.get(r.node).push(r);
    }
    const rank = k => { const i = NODE_ORDER.indexOf(k); return i < 0 ? NODE_ORDER.length : i; };
    return [...by.keys()].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b)).map(node => {
      const list = by.get(node);
      const counts = Object.fromEntries(KINDS.map(k => [k, 0]));
      for (const r of list) counts[KINDS.includes(r.comparison) ? r.comparison : 'UNKNOWN'] += 1;
      const status = statusOf(counts);
      return {
        node,
        total: list.length,
        counts,
        comparable: counts.SAME + counts.REAL_HIGHER + counts.REAL_LOWER,
        status,
        realModels: top(list.map(r => realLabel(r.real))),
        shadowTiers: top(list.map(r => shadowLabel(r.shadow))),
        // Onde a sombra divergiu: só os comparáveis com tier diferente.
        divergent: list.filter(r => r.comparison === 'REAL_HIGHER' || r.comparison === 'REAL_LOWER'),
        rows: list,
      };
    });
  }

  // Barra de 3 cores (larguras em % do total do nó; o resto, sem comparação, fica sem cor).
  function barWidths(n) {
    const pct = v => (n.total ? `${Math.round((v / n.total) * 1000) / 10}%` : '0%');
    return { same: pct(n.counts.SAME), cheaper: pct(n.counts.REAL_HIGHER), pricier: pct(n.counts.REAL_LOWER) };
  }

  function splitText(n) {
    if (!n.comparable) return `sem comparação em ${n.total}`;
    const div = n.counts.REAL_HIGHER + n.counts.REAL_LOWER;
    const base = div ? `${div} de ${n.comparable} divergem` : `sombra concorda em ${n.comparable}`;
    const unk = n.total - n.comparable;
    return unk ? `${base} · ${unk} sem comparação` : base;
  }

  /** Cards "Hoje contra a sombra" do nó. */
  function compareCards(n) {
    const today = {
      k: 'Hoje roda',
      v: n.realModels.length ? n.realModels.join(', ') : 'sem decisão real',
      d: n.comparable ? `${n.counts.SAME} de ${n.comparable} a sombra escolheria igual` : 'sem comparação: nenhum Attempt com sombra e decisão real',
    };
    const shadow = {
      k: 'A sombra rodaria',
      v: n.shadowTiers.length ? n.shadowTiers.join(', ') : 'sem decisão da sombra',
      d: n.comparable
        ? `${n.counts.REAL_HIGHER} com tier menor · ${n.counts.REAL_LOWER} com tier maior`
        : 'sem comparação',
    };
    return [today, shadow];
  }

  /** Linha de "Onde a sombra divergiu". */
  function divergenceRow(r) {
    const cheaper = r.comparison === 'REAL_HIGHER';
    const real = isObj(r.real) ? `${r.real.tier || '?'}${r.real.model_id && r.real.model_id !== 'UNKNOWN' ? ` (${r.real.model_id})` : ''}` : '?';
    const sh = isObj(r.shadow) ? (r.shadow.tier || '?') : '?';
    const why = isObj(r.shadow)
      ? `Sombra ${r.shadow.class || '?'} · ${r.shadow.tier || '?'}${r.shadow.policy_version ? ` (${r.shadow.policy_version})` : ''}${Number.isInteger(r.shadow.subtasks) ? ` · ${r.shadow.subtasks} subtarefa(s)` : ''}; real ${(isObj(r.real) && r.real.class) || '?'} · ${(isObj(r.real) && r.real.tier) || '?'}.`
      : '';
    return {
      run: r.task_id || '?',
      swap: `${real} → ${sh}`,
      d: cheaper ? 'sombra mais barata' : 'sombra mais cara',
      kind: cheaper ? 'cheaper' : 'pricier',
      why,
    };
  }

  function matches(n, q, label) {
    const s = String(q || '').trim().toLowerCase();
    if (!s) return true;
    return [n.node, label, ...n.realModels, ...n.shadowTiers].join(' ').toLowerCase().includes(s);
  }

  /** Mistura de modelos (GET /api/routing > mix): custo nulo nunca vira zero. */
  function mixRows(mix) {
    const list = isObj(mix) && Array.isArray(mix.by_requested) ? mix.by_requested : [];
    return list.slice().sort((a, b) => (b.attempts || 0) - (a.attempts || 0)).map(g => ({
      name: g.model === 'NOT_ROUTED' ? 'não roteado' : String(g.model),
      share: Number.isFinite(g.share_attempts) ? `${Math.round(g.share_attempts * 100)}%` : 'sem medição',
      w: Number.isFinite(g.share_attempts) ? `${Math.round(g.share_attempts * 1000) / 10}%` : '0%',
      cost: !Number.isFinite(g.cost_usd) ? 'sem preço' : `US$ ${Number(g.cost_usd).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
      unpriced: Number.isInteger(g.unpriced_attempts) ? g.unpriced_attempts : 0,
      attempts: g.attempts,
    }));
  }

  const api = { NODE_ORDER, STATUS, VIEWS, aggregateNodes, statusOf, barWidths, splitText, compareCards, divergenceRow, matches, mixRows };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.RoutingModel = api;
})(typeof window !== 'undefined' ? window : globalThis);
