// compare-model.js — lógica da tela Comparar runs (artboard RunCompare), sem DOM: linhas de
// Entradas, Nós do pipeline, Custo e tokens e Evidências, a primeira divergência e a contagem.
// Entra a resposta de GET /api/compare (scripts/lib/run-comparator.js) mais o resultado por nó
// da projeção do dashboard (run.nodes: done/running/failed/pending), que o comparador não tem.
// Regra de dado: o que não foi medido fica "sem medição" (valor) ou N/A com motivo (comparação),
// nunca 0. Script clássico (window.CompareModel) e módulo CommonJS (testes).
(root => {
  const NA = 'N/A';
  const SEM = 'sem medição';
  // Estados de comparação: = igual, ≠ difere, ? N/A (com motivo). Glifo + rótulo, nunca só a cor.
  const EQ = { kind: 'eq', glyph: '=', label: 'igual' };
  const NE = { kind: 'ne', glyph: '≠', label: 'difere' };
  const UNK = { kind: 'na', glyph: '?', label: 'N/A' };
  // Resultado do nó (projeção run.nodes) nos rótulos do artboard.
  const RES = {
    done: { tone: 'done', glyph: '✓', label: 'concluído' },
    failed: { tone: 'failed', glyph: '✕', label: 'falhou' },
    running: { tone: 'running', glyph: '◐', label: 'executando' },
    pending: { tone: 'queued', glyph: '○', label: 'pendente' },
    none: { tone: 'queued', glyph: '○', label: 'não executou' },
    unknown: { tone: 'queued', glyph: '?', label: 'N/A' },
  };

  const isNum = v => typeof v === 'number' && Number.isFinite(v);
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

  // ------------------------------------------------------------------ formatação (pt-BR do artboard)
  const usd = n => `US$ ${n.toFixed(2).replace('.', ',')}`;
  function tokens(n) {
    if (n < 1000) return String(n);
    if (n < 1e6) { const k = n / 1000; return `${k < 10 ? (Math.round(k * 10) / 10).toString().replace('.', ',') : Math.round(k)} mil`; }
    return `${(Math.round(n / 1e5) / 10).toString().replace('.', ',')} mi`;
  }
  function duration(ms) {
    const s = Math.round(ms / 1000);
    if (s < 60) return `${s} s`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m} min ${String(s % 60).padStart(2, '0')} s`;
    return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')} min`;
  }
  // claude-opus-5-5 → Opus 5.5 (como no artboard); outro id fica como veio.
  const modelName = id => {
    const m = /^claude-([a-z]+)-(\d+)-(\d+)/i.exec(id);
    return m ? `${m[1][0].toUpperCase()}${m[1].slice(1)} ${m[2]}.${m[3]}` : id;
  };
  const basename = p => String(p).split(/[\\/]/).pop();
  const sameSet = (x, y) => x.length === y.length && x.every(v => y.includes(v));

  // Duração do run de ponta a ponta: started_at → updated_at do state.json; aberto conta até agora.
  function runDuration(facts, open, now = Date.now()) {
    const a = Date.parse(facts?.startedAt || '');
    const b = open ? now : Date.parse(facts?.updatedAt || '');
    if (!Number.isFinite(a) || !Number.isFinite(b) || b < a) return null;
    const m = Math.round((b - a) / 60000);
    const txt = m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')} min`;
    return open ? `${txt} até agora` : txt;
  }

  // ------------------------------------------------------------------ Entradas do run
  function inputRows(facts) {
    const A = facts?.a || {}, B = facts?.b || {};
    const hashKnown = Boolean(A.specHash && B.specHash);
    const pathsKnown = Boolean(A.specPath && B.specPath);
    const pathsDiffer = pathsKnown && basename(A.specPath) !== basename(B.specPath);
    const specKind = hashKnown ? (A.specHash === B.specHash ? EQ : NE) : pathsDiffer ? NE : UNK;
    const specSub = f => f.specHash || 'N/A · spec_hash não gravado neste run';
    const spec = {
      key: 'spec', label: 'Spec e spec_hash', cmp: specKind,
      a: A.specPath ? basename(A.specPath) : NA, b: B.specPath ? basename(B.specPath) : NA, aSub: specSub(A), bSub: specSub(B),
      why: pathsDiffer ? `os runs executaram specs diferentes (${basename(A.specPath)} e ${basename(B.specPath)})`
        : 'a spec mudou de conteúdo entre os runs (spec_hash diferente)',
    };
    const pa = A.providers || [], pb = B.providers || [];
    const provKind = pa.length && pb.length ? (sameSet(pa, pb) ? EQ : NE) : UNK;
    const provSub = list => (list.length ? '' : 'N/A · nenhuma tentativa com provider gravado');
    const prov = {
      key: 'prov', label: 'Provider', cmp: provKind,
      a: pa.length ? pa.join(' · ') : NA, b: pb.length ? pb.join(' · ') : NA, aSub: provSub(pa), bSub: provSub(pb),
      why: `o provider mudou (${pa.join(' · ')} → ${pb.join(' · ')})`,
    };
    return [spec, prov];
  }

  // ------------------------------------------------------------------ Nós do pipeline
  function resultOf(detail, projection, node) {
    if (!detail) return RES.none;
    if (!projection) return RES.unknown; // run fora da lista atual: sem a projeção por nó
    const k = projection[node];
    return typeof k === 'string' && Object.hasOwn(RES, k) ? RES[k] : RES.unknown;
  }

  function nodeSide(detail, res, other, { node, planScore }) {
    if (!detail) return { ...res, model: '', line: 'sem attempts', note: '', modelDiff: false };
    // Rodou na sessão de outro nó: custo, tokens, duração e modelo estão lá, não "sem medição".
    if (detail.coveredBy) {
      return { ...res, model: '', modelDiff: false, line: plural(detail.executions, 'tentativa', 'tentativas'),
        note: `rodou na sessão do ${detail.coveredBy}: modelo, custo, tokens e duração contados lá` };
    }
    const models = detail.models.map(modelName);
    const otherModels = other ? other.models.map(modelName) : [];
    const cost = isNum(detail.costUsd) ? usd(detail.costUsd) : `custo ${SEM}`;
    const tok = isNum(detail.tokens) ? `${tokens(detail.tokens)} tokens` : `tokens ${SEM}`;
    const dur = isNum(detail.durationMs) ? duration(detail.durationMs) : `duração ${SEM}`;
    const notes = [];
    if (node === 'plan' && isNum(planScore)) notes.push(`score do plano ${planScore}`);
    if (!detail.tracked) notes.push('custo, tokens e duração sem medição: nó sem cost_tracking');
    else {
      if (detail.runsWithoutCost) notes.push(`${isNum(detail.costUsd) ? 'custo parcial' : 'custo sem medição'}: ${plural(detail.runsWithoutCost, 'execução sem custo calculável', 'execuções sem custo calculável')}`);
      if (detail.runsWithoutTokens) notes.push(`${isNum(detail.tokens) ? 'tokens parciais' : 'tokens sem medição'}: ${plural(detail.runsWithoutTokens, 'execução sem usage', 'execuções sem usage')}`);
    }
    return {
      ...res,
      model: models.length ? models.join(', ') : `modelo ${SEM}`,
      modelKnown: models.length > 0,
      modelDiff: models.length > 0 && otherModels.length > 0 && !sameSet(models, otherModels),
      line: `${dur} · ${plural(detail.executions, 'tentativa', 'tentativas')} · ${cost} · ${tok}`,
      note: notes.join(' · '),
    };
  }

  // Ordem do workflow (order) mais qualquer nó extra que um dos runs executou.
  function nodeRows(nodeDiff, { order = [], resultsA = null, resultsB = null, facts = {} } = {}) {
    const detail = nodeDiff?.detail || {};
    const keys = [...order, ...Object.keys(detail).filter(k => !order.includes(k))];
    return keys.map(node => {
      const da = detail[node]?.a || null, db = detail[node]?.b || null;
      const ra = resultOf(da, resultsA, node), rb = resultOf(db, resultsB, node);
      const what = [];
      if (da || db) {
        const ea = da ? da.executions : 0, eb = db ? db.executions : 0;
        if (ea !== eb) what.push(`tentativas ${ea} → ${eb}`);
        const ma = da ? da.models.map(modelName) : [], mb = db ? db.models.map(modelName) : [];
        if (ma.length && mb.length && !sameSet(ma, mb)) what.push(`modelo ${ma.join(', ')} → ${mb.join(', ')}`);
        const pa = da ? da.providers : [], pb = db ? db.providers : [];
        if (pa.length && pb.length && !sameSet(pa, pb)) what.push(`provider ${pa.join(', ')} → ${pb.join(', ')}`);
        // "não executou" já aparece como tentativas 0 → N: resultado só conta com os dois lados executados.
        // "pendente" num nó que já executou (retry, ou fetch_ticket dentro do plan) não é resultado: não conta.
        const settled = r => r !== RES.unknown && r !== RES.pending;
        if (da && db && settled(ra) && settled(rb) && ra !== rb) what.push(`resultado ${ra.label} → ${rb.label}`);
      }
      return {
        key: `node-${node}`, node, what, cmp: what.length ? NE : EQ,
        sides: [nodeSide(da, ra, db, { node, planScore: facts.a?.planScore }), nodeSide(db, rb, da, { node, planScore: facts.b?.planScore })],
      };
    });
  }

  // ------------------------------------------------------------------ Primeira divergência
  function divergence(inputs, nodes) {
    const firstInput = inputs.find(r => r.cmp === NE);
    const firstNode = nodes.find(n => n.cmp === NE);
    const unknown = inputs.filter(r => r.cmp === UNK).length;
    const tail = unknown ? ` ${unknown} ${unknown === 1 ? 'campo de entrada está' : 'campos de entrada estão'} como N/A e não ${unknown === 1 ? 'entra' : 'entram'} na conta.` : '';
    let d;
    if (firstInput) {
      d = {
        kind: 'input', firstKey: firstInput.key, title: `Primeira divergência: ${firstInput.label.toLowerCase()}`,
        body: `Antes de qualquer nó rodar, ${firstInput.why}.`,
        node: firstNode ? `Primeiro nó que diverge: ${firstNode.node} (${firstNode.what.join('; ')}). Os nós anteriores tiveram o mesmo modelo, tentativas e resultado.`
          : 'Nenhum nó diverge em modelo, tentativas ou resultado.',
      };
    } else if (firstNode) {
      d = {
        kind: 'node', firstKey: firstNode.key, title: `Primeira divergência: nó ${firstNode.node}`,
        body: `Spec e provider não divergem. O primeiro nó que diverge é ${firstNode.node}: ${firstNode.what.join('; ')}.`, node: '',
      };
    } else {
      d = {
        kind: 'none', firstKey: null, title: 'Nenhuma divergência estrutural',
        body: 'Mesma spec, mesmo provider, e cada nó com o mesmo modelo, tentativas e resultado. As diferenças restantes estão só em duração e custo.', node: '',
      };
    }
    d.body += tail;
    d.firstNodeKey = firstNode ? firstNode.key : null;
    d.glyph = d.kind === 'none' ? '=' : '≠';
    return d;
  }

  // ------------------------------------------------------------------ Custo e tokens
  function deltaOf(m, fmt, comparable = true) {
    if (!comparable || !m || typeof m.delta !== 'number') return { d: NA, tone: 'muted' };
    if (Math.abs(m.delta) < 1e-9) return { d: '0', tone: 'muted' };
    return { d: `${m.delta > 0 ? '+' : '−'}${fmt(Math.abs(m.delta))}`, tone: m.better === 'B' ? 'better' : m.better === 'A' ? 'worse' : 'muted' };
  }
  function costRows(data, { openA = false, openB = false } = {}) {
    const by = k => (data.metrics || []).find(m => m.key === k);
    const val = (v, fmt) => (isNum(v) ? fmt(v) : SEM);
    const live = open => (open ? ' · run ainda aberto' : '');
    const detail = data.nodeDiff?.detail || {};
    const tokMiss = side => Object.values(detail).reduce((t, d) => t + (d[side]?.runsWithoutTokens || 0), 0);
    const cost = by('cost_usd') || {};
    const costSub = side => {
      if (!isNum(cost[side])) return 'sem cost_tracking';
      const miss = cost.missing?.[side] || 0;
      return miss ? `parcial: ${plural(miss, 'execução sem custo', 'execuções sem custo')}` : 'todas as execuções com custo';
    };
    const tok = by('tokens') || {};
    const tokSub = side => {
      if (!isNum(tok[side])) return 'sem cost_tracking';
      const miss = tokMiss(side);
      return miss ? `parcial: ${plural(miss, 'execução sem usage', 'execuções sem usage')}` : 'todas as execuções com usage';
    };
    // Run aberto: custo e tokens ainda crescem, então B − A fica N/A (mesma regra da Duração).
    const closed = !openA && !openB;
    const costComparable = closed && cost.complete?.a !== false && cost.complete?.b !== false;
    const tokComparable = closed && !tokMiss('a') && !tokMiss('b');
    const att = by('history_len') || {}, dur = by('duration_ms') || {};
    return [
      { key: 'cost', label: 'Custo total', a: val(cost.a, usd), b: val(cost.b, usd), aSub: costSub('a') + live(openA), bSub: costSub('b') + live(openB), ...deltaOf(cost, usd, costComparable) },
      { key: 'tokens', label: 'Tokens', a: val(tok.a, tokens), b: val(tok.b, tokens), aSub: tokSub('a'), bSub: tokSub('b'), ...deltaOf(tok, tokens, tokComparable) },
      { key: 'attempts', label: 'Attempts', a: val(att.a, String), b: val(att.b, String), aSub: 'soma dos nós (history)', bSub: 'soma dos nós (history)', ...deltaOf(att, String) },
      { key: 'duration', label: 'Duração', a: val(dur.a, duration), b: val(dur.b, duration), aSub: 'soma dos agentes', bSub: 'soma dos agentes', ...deltaOf(dur, duration, closed) },
    ];
  }

  // ------------------------------------------------------------------ Evidências
  const EVS = { ok: { tone: 'done', glyph: '✓', label: 'gravada' }, partial: { tone: 'waiting', glyph: '◐', label: 'parcial' },
    missing: { tone: 'muted', glyph: '○', label: 'ausente' }, na: { tone: 'muted', glyph: '?', label: 'N/A' } };
  function evidenceRows(data) {
    const tr = data.testResultsDiff || {};
    const test = t => {
      if (!t || (t.outcome === NA && t.summary === NA)) return { ...EVS.na, note: 'test_result não gravado no state.json' };
      return { ...(t.partial ? EVS.partial : EVS.ok), note: String(t.summary) };
    };
    const trans = n => {
      if (!isNum(n)) return { ...EVS.na, note: 'transcripts_total não gravado no state.json' };
      return n ? { ...EVS.ok, note: plural(n, 'sessão gravada', 'sessões gravadas') } : { ...EVS.missing, note: 'nenhuma sessão gravada' };
    };
    const row = (key, label, a, b) => {
      const cmp = a.label === 'N/A' || b.label === 'N/A' ? UNK : a.label === b.label ? EQ : NE;
      return { key, label, sides: [a, b], cmp, stLabel: cmp === EQ ? 'mesmo estado' : cmp === NE ? 'estado difere' : 'N/A em um lado' };
    };
    return [
      row('tests', 'Relatório de testes', test(tr.a), test(tr.b)),
      row('trans', 'Transcrições', trans(data.facts?.a?.transcripts), trans(data.facts?.b?.transcripts)),
    ];
  }

  // ------------------------------------------------------------------ modelo da tela
  // only: "Só diferenças" esconde as linhas iguais (a contagem e a divergência usam todas).
  function build(data, { order = [], resultsA = null, resultsB = null, openA = false, openB = false, only = false } = {}) {
    const inputsAll = inputRows(data.facts);
    const nodesAll = nodeRows(data.nodeDiff, { order, resultsA, resultsB, facts: data.facts || {} });
    const div = divergence(inputsAll, nodesAll);
    const n = inputsAll.filter(r => r.cmp === NE).length + nodesAll.filter(r => r.cmp === NE).length;
    const keep = r => !only || r.cmp !== EQ;
    return {
      div,
      diffs: n,
      diffText: `${n} ${n === 1 ? 'diferença estrutural' : 'diferenças estruturais'}`,
      inputs: inputsAll.filter(keep),
      nodes: nodesAll.filter(keep),
      costs: costRows(data, { openA, openB }),
      evs: evidenceRows(data).filter(keep),
    };
  }

  const api = { NA, SEM, EQ, NE, UNK, RES, usd, tokens, duration, modelName, runDuration, inputRows, nodeRows, divergence, costRows, evidenceRows, build };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.CompareModel = api;
})(typeof window !== 'undefined' ? window : globalThis);
