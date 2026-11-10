// node --test run-list-model.test.js
// Contas da tela Runs (artboards Main e RunDetail): indicadores de 7 dias, custo por nó, ordenação,
// meta das etapas, trechos da linha do tempo e abas do detalhe. Sem medição = null, nunca 0.
const test = require('node:test');
const assert = require('node:assert/strict');
const M = require('./public/run-list-model.js');

const DAY = 86400000;
const NOW = Date.parse('2026-11-09T12:00:00Z');
const iso = t => new Date(t).toISOString();
const cost = (nodes, loops = 0) => {
    const n = {}, t = { input_tokens: 0, output_tokens: 0, duration_ms: 0, cost_usd: 0, loop_count: loops };
    for (const [k, usd, tin, tout, ms] of nodes) {
        n[k] = { runs: 1, retries: 0, input_tokens: tin, output_tokens: tout, duration_ms: ms, cost_usd: usd };
        t.input_tokens += tin; t.output_tokens += tout; t.duration_ms += ms; t.cost_usd += usd;
    }
    return { nodes: n, totals: t };
};
const run = (id, ageDays, over = {}, state = {}) => ({
    taskId: id, status: 'running', kind: 'active', node: 'implement', updatedAt: iso(NOW - ageDays * DAY),
    ...over, state: { started_at: iso(NOW - ageDays * DAY), ...state },
});

test('kpis: média de custo, mediana de tokens e retrabalho dos últimos 7 dias; sem medição = null', () => {
    const runs = [
        run('a', 1, {}, { cost_tracking: cost([['plan', 1, 100, 10, 1000]]), retries: { review: 1 } }),
        run('b', 2, {}, { cost_tracking: cost([['plan', 3, 300, 30, 1000]]), retries: {} }),
        run('c', 3, {}, {}), // sem cost_tracking e sem retries: fora das contas, não vira 0
        run('old', 9, {}, { cost_tracking: cost([['plan', 1, 100, 10, 1000]]), retries: {} }),
    ];
    const k = M.kpis(runs, NOW);
    assert.equal(k.runs7, 3);
    assert.equal(k.cost7, 4);
    assert.equal(k.cost.value, 2);
    assert.equal(k.cost.n, 2);
    assert.equal(k.tokens.value, (110 + 330) / 2);
    assert.equal(k.rework.value, 0.5);
    // 7 dias anteriores: só "old" (US$ 1) → +100%.
    assert.equal(k.cost.delta, 1);
    assert.equal(k.cost.series.length, 3);

    const none = M.kpis([run('x', 1)], NOW);
    assert.equal(none.cost.value, null);
    assert.equal(none.tokens.value, null);
    assert.equal(none.rework.value, null);
    assert.equal(none.cost7, null);
    assert.deepEqual(none.cost.series, []);
});

test('filtros dos kcards: acima da média, consumindo tokens agora, com retrabalho', () => {
    const a = run('a', 1, { status: 'needs_human_review' }, { cost_tracking: cost([['plan', 1, 1, 1, 1]]), retries: { review: 2 } });
    const b = run('b', 1, {}, { cost_tracking: cost([['plan', 3, 1, 1, 1]]) });
    const k = M.kpis([a, b], NOW);
    assert.equal(M.kfMatch('cost', b, k), true);
    assert.equal(M.kfMatch('cost', a, k), false);
    assert.equal(M.kfMatch('tokens', b, k), true);
    assert.equal(M.kfMatch('tokens', a, k), false);
    assert.equal(M.kfMatch('rework', a, k), true);
    assert.equal(M.kfMatch('rework', b, k), false);
    assert.equal(M.kfMatch('desconhecido', a, k), true);
});

test('nodeCost: % por nó nos 7 dias e os dois nós mais caros; nada medido = null', () => {
    const nc = M.nodeCost([
        run('a', 1, {}, { cost_tracking: cost([['plan', 1, 0, 0, 0], ['implement', 3, 0, 0, 0]]) }),
        run('old', 10, {}, { cost_tracking: cost([['commit', 50, 0, 0, 0]]) }),
    ], NOW);
    assert.equal(nc.total, 4);
    assert.equal(nc.rows.find(x => x.node === 'implement').share, 75);
    assert.equal(nc.rows.find(x => x.node === 'commit').share, 0);
    assert.deepEqual(nc.top, ['implement', 'plan']);
    assert.equal(M.nodeCost([run('x', 1)], NOW), null);
});

test('bucketOf e sortRuns: urgência, custo (sem medição no fim) e recentes', () => {
    const f = run('f', 3, { status: 'failed', kind: 'failed' });
    const w = run('w', 2, { status: 'needs_human_review' }, { cost_tracking: cost([['plan', 2, 0, 0, 0]]) });
    const g = run('g', 1, {}, { cost_tracking: cost([['plan', 5, 0, 0, 0]]) });
    const d = run('d', 0, { status: 'committed', kind: 'completed' });
    assert.deepEqual([f, w, g, d].map(M.bucketOf), ['need', 'need', 'run', 'done']);
    assert.equal(M.bucketOf(run('p', 1, { status: 'pending' })), 'other');
    assert.deepEqual(M.sortRuns([d, g, w, f], 'urg').map(r => r.taskId), ['f', 'w', 'g', 'd']);
    assert.deepEqual(M.sortRuns([f, w, g, d], 'cost').map(r => r.taskId), ['g', 'w', 'd', 'f']);
    assert.deepEqual(M.sortRuns([f, w, g, d], 'recent').map(r => r.taskId), ['d', 'g', 'w', 'f']);
});

test('nodeMeta e attempts: duração · custo do nó e tentativa extra; nó sem medição fica vazio', () => {
    const r = run('a', 1, {}, { cost_tracking: cost([['plan', 0.16, 40, 4, 250000]]), retries: { plan: 1 } });
    assert.equal(M.nodeMeta(r, 'plan'), '4:10 · US$ 0,16 · tentativa 2');
    assert.equal(M.nodeMeta(r, 'review'), '');
    const at = M.attempts(r);
    assert.deepEqual(at.map(x => [x.node, x.tokens, x.usd]), [['plan', 44, 0.16]]);
    assert.deepEqual(M.attempts(run('x', 1)), []);
    assert.equal(M.totalsOf(run('x', 1)).usd, null);
});

test('segments e activity: trechos por fase a partir do agent_log; run ativo tem cauda até agora', () => {
    const start = NOW - 3 * 3600e3;
    const r = run('a', 0, { status: 'needs_human_review', updatedAt: iso(NOW - 3600e3) }, {
        started_at: iso(start),
        agent_log: [{ at: iso(start + 3600e3), nodes: ['fetch_ticket', 'plan'], note: 'plano pronto' }, { at: iso(start + 2 * 3600e3), nodes: ['implement'] }],
    });
    const s = M.segments(r, NOW);
    assert.deepEqual(s.segs.map(x => [x.node, x.phase]), [['fetch_ticket', 0], ['plan', 0], ['implement', 1]]);
    assert.equal(s.segs[1].to - s.segs[1].from, 1800e3);
    assert.deepEqual(s.tail, { from: start + 2 * 3600e3, to: NOW, blocked: true });
    const act = M.activity(r);
    assert.deepEqual(act.map(a => a.note), ['', 'plano pronto']);
    assert.deepEqual(act[0].nodes, ['implement']);
});

test('detailTabs: 6 grupos numerados só com as abas que têm dado; J/K e 1–6', () => {
    const all = M.detailTabs({ tasks: true, api: true, replay: true, events: true, transcripts: true, cost: true });
    assert.deepEqual(all.map(g => [g.n, g.label]), [[1, 'Resumo'], [2, 'Spec e plano'], [3, 'Execução'], [4, 'Testes e entrega'], [5, 'Conversa e contexto'], [6, 'Custos']]);
    const few = M.detailTabs({});
    assert.deepEqual(few.map(g => g.key), ['summary', 'exec', 'tests', 'talk']);
    assert.deepEqual(few.find(g => g.key === 'exec').tabs.map(t => t.id), ['log']);
    assert.equal(few.find(g => g.key === 'talk').n, 4);
    assert.equal(M.stepTab(few, 'summary', 1), 'log');
    assert.equal(M.stepTab(few, 'summary', -1), 'summary');
    assert.equal(M.stepTab(few, 'context', 1), 'context');
    assert.equal(M.groupTab(few, 3), 'env');
    assert.equal(M.groupTab(few, 6), null);
    assert.equal(M.validTab(few, 'costs'), 'summary');
    assert.equal(M.validTab(all, 'costs'), 'costs');
});

test('nodeCost marca nó sem medição; windowStat sem base anterior não inventa delta; retrabalho soma loops', () => {
    const nc = M.nodeCost([run('a', 1, {}, { cost_tracking: cost([['plan', 1, 0, 0, 0], ['review', 0, 0, 0, 0]]) })], NOW);
    assert.equal(nc.rows.find(x => x.node === 'plan').measured, true);
    assert.equal(nc.rows.find(x => x.node === 'review').measured, true); // medido 0 ≠ sem medição
    assert.equal(nc.rows.find(x => x.node === 'commit').measured, false);
    const k = M.kpis([
        run('a', 1, {}, { cost_tracking: cost([['plan', 1, 0, 0, 0]], 2), retries: { review: 1 } }),
        run('b', 9, {}, { cost_tracking: cost([['plan', 0, 0, 0, 0]]) }),
    ], NOW);
    assert.equal(k.cost.delta, null); // período anterior custou 0: sem base para %
    assert.equal(k.rework.value, 3);
    assert.equal(M.kfMatch('rework', run('c', 1, {}, { cost_tracking: cost([['plan', 1, 0, 0, 0]], 1) }), k), true);
});
