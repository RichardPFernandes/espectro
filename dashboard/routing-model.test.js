// node --test routing-model.test.js
// Lógica pura da tela Roteamento (public/routing-model.js, PRI-328): agregação da sombra S3 ×
// decisão real por nó, estados, abas, textos e mistura. Sem comparação nunca vira zero.
const test = require('node:test');
const assert = require('node:assert/strict');
const M = require('./public/routing-model.js');

const S = (cl, tier, n = 1) => ({ status: 'SHADOW', policy_version: 's3-p1', class: cl, tier, subtasks: n });
const R = (cl, tier, model) => ({ class: cl, tier, model_id: model });
const row = (task_id, node, comparison, shadow, real) => ({ task_id, node, attempt_id: 'x', shadow, real, comparison, quality_effect: 'NOT_MEASURED' });

const ROWS = [
    row('t1', 'review', 'SAME', S('C3', 'T3'), R('C3', 'T3', 'claude-opus-5-5')),
    row('t1', 'implement', 'REAL_HIGHER', S('C1', 'T1', 2), R('C3', 'T3', 'claude-opus-5-5')),
    row('t2', 'implement', 'SAME', S('C3', 'T3'), R('C3', 'T3', 'claude-opus-5-5')),
    row('t3', 'implement', 'UNKNOWN', 'UNAVAILABLE', R(null, 'T3', 'claude-opus-5-5')),
    row('t1', 'test', 'REAL_LOWER', S('C3', 'T3'), R('C2', 'T2', 'claude-sonnet-5-5')),
    row('t1', 'zeta', 'UNKNOWN', S('C1', 'T1'), 'UNAVAILABLE'),
    row('t1', 'plan', 'WHATEVER', S('C1', 'T1'), R('C1', 'T1', 'claude-sonnet-5-5')),
    { node: '', comparison: 'SAME' }, null, 'lixo',
];

test('aggregateNodes: um registro por nó, ordem do grafo e desconhecidos no fim; linhas inválidas ignoradas', () => {
    const nodes = M.aggregateNodes(ROWS);
    assert.deepEqual(nodes.map(n => n.node), ['plan', 'implement', 'review', 'test', 'zeta']);
    const impl = nodes.find(n => n.node === 'implement');
    assert.deepEqual(impl.counts, { SAME: 1, REAL_HIGHER: 1, REAL_LOWER: 0, UNKNOWN: 1 });
    assert.equal(impl.total, 3);
    assert.equal(impl.comparable, 2);
    assert.deepEqual(impl.realModels, ['claude-opus-5-5']);
    assert.deepEqual(impl.shadowTiers, ['T1 · C1', 'T3 · C3']);
    assert.equal(impl.divergent.length, 1);
    assert.equal(nodes.find(n => n.node === 'plan').counts.UNKNOWN, 1, 'comparação fora do contrato conta como sem comparação');
    assert.deepEqual(M.aggregateNodes(undefined), []);
});

test('statusOf: economia > atual mais barato > concorda; sem comparáveis = sem comparação (nunca "igual")', () => {
    const c = (SAME, REAL_HIGHER, REAL_LOWER, UNKNOWN = 0) => ({ SAME, REAL_HIGHER, REAL_LOWER, UNKNOWN });
    assert.equal(M.statusOf(c(3, 1, 1)), 'misto', 'divergência nos dois sentidos não vira economia');
    assert.equal(M.statusOf(c(3, 1, 0)), 'economia');
    assert.equal(M.statusOf(c(3, 0, 1)), 'barato');
    assert.equal(M.statusOf(c(3, 0, 0, 2)), 'igual');
    assert.equal(M.statusOf(c(0, 0, 0, 4)), 'sem');
    for (const k of Object.keys(M.STATUS)) assert.ok(M.STATUS[k].glyph && M.STATUS[k].label, `estado ${k} com glifo e texto`);
});

test('VIEWS: Todos · Economia · Atual certo (sem a aba Pedidos)', () => {
    assert.deepEqual(M.VIEWS.map(v => v[1]), ['Todos', 'Economia', 'Atual certo']);
    const nodes = M.aggregateNodes(ROWS);
    const pick = id => nodes.filter(M.VIEWS.find(v => v[0] === id)[2]).map(n => n.node);
    assert.deepEqual(pick('save'), ['implement']);
    assert.deepEqual(pick('ok'), ['review', 'test']);
    assert.equal(pick('all').length, 5);
});

test('barWidths e splitText: frações do total; sem comparação explícita', () => {
    const nodes = M.aggregateNodes(ROWS);
    const impl = nodes.find(n => n.node === 'implement');
    assert.deepEqual(M.barWidths(impl), { same: '33.3%', cheaper: '33.3%', pricier: '0%' });
    assert.equal(M.splitText(impl), '1 de 2 divergem · 1 sem comparação');
    assert.equal(M.splitText(nodes.find(n => n.node === 'review')), 'sombra concorda em 1');
    assert.equal(M.splitText(nodes.find(n => n.node === 'zeta')), 'sem comparação em 1');
});

test('compareCards: modelo real e tier da sombra; sem dado diz "sem comparação", não zero', () => {
    const nodes = M.aggregateNodes(ROWS);
    const [today, shadow] = M.compareCards(nodes.find(n => n.node === 'implement'));
    assert.deepEqual(today, { k: 'Hoje roda', v: 'claude-opus-5-5', d: '1 de 2 a sombra escolheria igual' });
    assert.deepEqual(shadow, { k: 'A sombra rodaria', v: 'T1 · C1, T3 · C3', d: '1 com tier menor · 0 com tier maior' });
    const [t2, s2] = M.compareCards(nodes.find(n => n.node === 'zeta'));
    assert.equal(t2.v, 'sem decisão real');
    assert.match(t2.d, /^sem comparação/);
    assert.equal(s2.d, 'sem comparação');
    assert.doesNotMatch(`${t2.d} ${s2.d}`, /\b0\b/);
});

test('divergenceRow: real → sombra com rótulo em texto; nenhum custo inventado', () => {
    const cheaper = M.divergenceRow(ROWS[1]);
    assert.deepEqual(cheaper, { run: 't1', swap: 'T3 (claude-opus-5-5) → T1', d: 'sombra mais barata', kind: 'cheaper', why: 'Sombra C1 · T1 (s3-p1) · 2 subtarefa(s); real C3 · T3.' });
    const pricier = M.divergenceRow(ROWS[4]);
    assert.equal(pricier.d, 'sombra mais cara');
    assert.equal(pricier.kind, 'pricier');
    assert.doesNotMatch(JSON.stringify([cheaper, pricier]), /US\$/);
});

test('matches: nó, rótulo, modelo real e tier da sombra; vazio casa tudo', () => {
    const impl = M.aggregateNodes(ROWS).find(n => n.node === 'implement');
    assert.ok(M.matches(impl, '', 'Implementação'));
    assert.ok(M.matches(impl, 'IMPLE', 'x'));
    assert.ok(M.matches(impl, 'implementação', 'Implementação'));
    assert.ok(M.matches(impl, 'opus', 'x'));
    assert.ok(M.matches(impl, 't1 · c1', 'x'));
    assert.ok(!M.matches(impl, 'sonnet', 'x'));
});

test('mixRows: ordena por Attempts, "não roteado", custo nulo como "sem preço"', () => {
    const rows = M.mixRows({ by_requested: [
        { model: 'NOT_ROUTED', attempts: 1, unpriced_attempts: 1, cost_usd: null, share_attempts: 0.25 },
        { model: 'claude-opus-5-5', attempts: 3, unpriced_attempts: 0, cost_usd: 12.6, share_attempts: 0.75 },
    ] });
    assert.deepEqual(rows.map(r => r.name), ['claude-opus-5-5', 'não roteado']);
    assert.equal(rows[0].share, '75%');
    assert.equal(rows[0].w, '75%');
    assert.match(rows[0].cost, /^US\$ 12,60$/);
    assert.equal(rows[1].cost, 'sem preço');
    assert.equal(rows[1].unpriced, 1);
    assert.deepEqual(M.mixRows(null), []);
    const [odd] = M.mixRows({ by_requested: [{ model: 'x', attempts: 1, cost_usd: 'abc' }] });
    assert.equal(odd.share, 'sem medição');
    assert.equal(odd.cost, 'sem preço', 'custo não numérico nunca vira US$ NaN');
});
