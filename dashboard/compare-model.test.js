// node --test compare-model.test.js
// Lógica da tela Comparar runs (public/compare-model.js, artboard RunCompare): Entradas, Nós do
// pipeline, primeira divergência, Custo e tokens e Evidências. A resposta vem do comparador real
// (scripts/lib/run-comparator.js), com states sintéticos (nenhum dado de consumidor).
const test = require('node:test');
const assert = require('node:assert/strict');
const M = require('./public/compare-model.js');
const { compareRuns } = require('../scripts/lib/run-comparator.js');

const ORDER = ['fetch_ticket', 'plan', 'implement', 'review', 'test', 'verify', 'commit'];
const at = provider => ({ provider });
const node = (models, extra = {}) => ({ agent: 'claude', input_tokens: 1000, output_tokens: 200, runs: 1, models, duration_ms: 60000, cost_usd: 0.1, attempts: [at('anthropic')], ...extra });
const ct = nodes => ({ nodes });

const A = {
    status: 'escalated', node: 'test', history: ['plan', 'implement', 'review', 'test', 'implement', 'test'],
    spec_path: 'memory/spec/app-218.md', spec_hash: 'sha256:9c41', planScore: 80, transcripts_total: 9,
    started_at: '2026-10-24T09:12:00Z', updated_at: '2026-10-24T10:04:00Z',
    test_result: { result: 'falhou', total: 19, failures: 4 },
    cost_tracking: ct({
        plan: node(['claude-sonnet-5-5'], { also_covers: ['fetch_ticket'] }),
        implement: node(['claude-sonnet-5-5'], { runs: 2, cost_usd: 0.58, duration_ms: 1120000 }),
        review: node(['claude-opus-5-5']),
        test: node(['claude-sonnet-5-5'], { runs: 2 }),
    }),
};
const B = {
    status: 'committed', node: 'commit', history: ['plan', 'implement', 'review', 'test', 'verify', 'commit'],
    spec_path: 'memory/spec/app-218.md', spec_hash: 'sha256:9c41', planScore: 82, transcripts_total: 7,
    started_at: '2026-10-27T16:14:00Z', updated_at: '2026-10-27T16:55:00Z',
    test_result: { result: 'passou', total: 19, failures: 0 },
    cost_tracking: ct({
        plan: node(['claude-sonnet-5-5'], { also_covers: ['fetch_ticket'] }),
        implement: node(['claude-opus-5-5'], { cost_usd: 0.74, duration_ms: 822000 }),
        review: node(['claude-opus-5-5']),
        test: node(['claude-sonnet-5-5']),
        verify: node(['claude-sonnet-5-5'], { cost_usd: null, runs_without_cost: 1 }),
        commit: node(['claude-haiku-5-5']),
    }),
};
const RES_A = { fetch_ticket: 'done', plan: 'done', implement: 'done', review: 'done', test: 'failed', verify: 'pending', commit: 'pending' };
const RES_B = { fetch_ticket: 'done', plan: 'done', implement: 'done', review: 'done', test: 'done', verify: 'done', commit: 'done' };

test('formatos do artboard: US$ com vírgula, mil tokens, min/s, nome do modelo', () => {
    assert.equal(M.usd(0.74), 'US$ 0,74');
    assert.deepEqual([M.tokens(330), M.tokens(1600), M.tokens(240400), M.tokens(1250000)], ['330', '1,6 mil', '240 mil', '1,3 mi']);
    assert.deepEqual([M.duration(42000), M.duration(822000), M.duration(4500000)], ['42 s', '13 min 42 s', '1 h 15 min']);
    assert.deepEqual([M.modelName('claude-opus-5-5'), M.modelName('gpt-5-codex')], ['Opus 5.5', 'gpt-5-codex']);
});

test('duração do run: started_at → updated_at; aberto conta até agora; sem data = null', () => {
    assert.equal(M.runDuration({ startedAt: '2026-10-24T09:12:00Z', updatedAt: '2026-10-24T10:04:00Z' }, false), '52 min');
    const now = Date.parse('2026-10-27T16:52:00Z');
    assert.equal(M.runDuration({ startedAt: '2026-10-27T16:14:00Z' }, true, now), '38 min até agora');
    assert.equal(M.runDuration({ startedAt: null }, false), null);
});

test('mesma spec: primeira divergência é o nó implement (modelo e tentativas); fetch_ticket coberto pelo plan', () => {
    const d = compareRuns(A, B);
    const m = M.build(d, { order: ORDER, resultsA: RES_A, resultsB: RES_B });
    assert.deepEqual(m.inputs.map(r => [r.key, r.cmp.kind]), [['spec', 'eq'], ['prov', 'eq']]);
    assert.equal(m.div.kind, 'node');
    assert.equal(m.div.firstKey, 'node-implement');
    assert.equal(m.div.title, 'Primeira divergência: nó implement');
    assert.match(m.div.body, /tentativas 2 → 1; modelo Sonnet 5\.5 → Opus 5\.5/);
    const fetch = m.nodes.find(n => n.node === 'fetch_ticket');
    assert.equal(fetch.cmp.kind, 'eq');
    assert.equal(fetch.sides[0].label, 'concluído');
    const impl = m.nodes.find(n => n.node === 'implement');
    assert.equal(impl.sides[1].model, 'Opus 5.5');
    assert.equal(impl.sides[1].modelDiff, true);
    assert.equal(impl.sides[1].line, '13 min 42 s · 1 tentativa · US$ 0,74 · 1,2 mil tokens');
    assert.equal(m.nodes.find(n => n.node === 'plan').sides[0].note, 'score do plano 80');
    // verify só em B: A "não executou", B com custo sem medição e o motivo
    const verify = m.nodes.find(n => n.node === 'verify');
    assert.equal(verify.sides[0].label, 'não executou');
    assert.equal(verify.sides[0].line, 'sem attempts');
    assert.match(verify.sides[1].line, /custo sem medição/);
    assert.equal(verify.sides[1].note, 'custo sem medição: 1 execução sem custo calculável');
    assert.deepEqual(verify.what, ['tentativas 0 → 1']);
    assert.equal(m.diffText, '4 diferenças estruturais'); // implement, test, verify, commit
});

test('spec diferente vem antes dos nós; sem spec_hash em um lado = N/A, não entra na conta', () => {
    const d = compareRuns(A, { ...B, spec_path: 'memory/spec/app-221.md', spec_hash: 'sha256:41d0' });
    const m = M.build(d, { order: ORDER });
    assert.equal(m.div.kind, 'input');
    assert.equal(m.div.title, 'Primeira divergência: spec e spec_hash');
    assert.match(m.div.body, /^Antes de qualquer nó rodar, os runs executaram specs diferentes \(app-218\.md e app-221\.md\)\./);
    assert.match(m.div.node, /^Primeiro nó que diverge: implement/);
    const d2 = compareRuns(A, { ...B, spec_hash: undefined });
    const spec = M.inputRows(d2.facts)[0];
    assert.equal(spec.cmp.kind, 'na');
    assert.equal(spec.bSub, 'N/A · spec_hash não gravado neste run');
    assert.match(M.build(d2, { order: ORDER }).div.body, /1 campo de entrada está como N\/A e não entra na conta\.$/);
});

test('run fora da lista: resultado por nó N/A (não conta como divergência)', () => {
    const d = compareRuns(A, A);
    const m = M.build(d, { order: ORDER, resultsA: RES_A, resultsB: null });
    assert.equal(m.diffs, 0);
    assert.equal(m.div.kind, 'none');
    assert.equal(m.nodes.find(n => n.node === 'test').sides[1].label, 'N/A');
});

test('provider diferente aparece em Entradas; nenhum provider gravado = N/A com motivo', () => {
    const openai = JSON.parse(JSON.stringify(B));
    openai.cost_tracking.nodes.review.attempts = [at('openai')];
    const rows = M.inputRows(compareRuns(A, openai).facts);
    assert.deepEqual([rows[1].a, rows[1].b, rows[1].cmp.kind], ['anthropic', 'anthropic · openai', 'ne']);
    const none = M.inputRows(compareRuns({ status: 'committed' }, {}).facts)[1];
    assert.deepEqual([none.a, none.aSub, none.cmp.kind], ['N/A', 'N/A · nenhuma tentativa com provider gravado', 'na']);
});

test('Custo e tokens: sem medição nunca vira 0; custo parcial deixa B − A em N/A; menor custo = melhor', () => {
    const d = compareRuns(A, B);
    const [cost, tok, att, dur] = M.costRows(d);
    assert.equal(cost.bSub, 'parcial: 1 execução sem custo');
    assert.equal(cost.d, 'N/A');
    assert.equal(tok.a, '4,8 mil'); // 4 nós × 1.200 tokens
    assert.equal(att.a, '6');
    assert.equal(att.d, '0');
    assert.equal(dur.aSub, 'soma dos agentes');
    const empty = M.costRows(compareRuns({ status: 'committed' }, { status: 'committed' }));
    assert.deepEqual(empty.map(r => [r.a, r.d]), [['sem medição', 'N/A'], ['sem medição', 'N/A'], ['sem medição', 'N/A'], ['sem medição', 'N/A']]);
    const cheap = M.costRows(compareRuns({ cost_tracking: ct({ plan: node([], { cost_usd: 1 }) }) }, { cost_tracking: ct({ plan: node([], { cost_usd: 0.4 }) }) }))[0];
    assert.deepEqual([cheap.d, cheap.tone], ['−US$ 0,60', 'better']);
    assert.match(M.costRows(d, { openB: true })[0].bSub, /run ainda aberto$/);
});

test('Evidências: testes e transcrições; ausente no state = N/A com motivo; "Só diferenças" esconde iguais', () => {
    const d = compareRuns(A, B);
    const [tests, trans] = M.evidenceRows(d);
    assert.deepEqual(tests.sides.map(s => s.label), ['gravada', 'gravada']);
    assert.match(tests.sides[0].note, /^falhou \(19 testes, 4 falhas\)$/);
    assert.equal(tests.stLabel, 'mesmo estado');
    assert.deepEqual(trans.sides.map(s => s.note), ['9 sessões gravadas', '7 sessões gravadas']);
    const none = M.evidenceRows(compareRuns({ status: 'x' }, B));
    assert.deepEqual([none[0].sides[0].label, none[0].sides[0].note, none[0].stLabel], ['N/A', 'test_result não gravado no state.json', 'N/A em um lado']);
    const only = M.build(d, { order: ORDER, resultsA: RES_A, resultsB: RES_B, only: true });
    assert.deepEqual(only.inputs, []);
    assert.deepEqual(only.nodes.map(n => n.node), ['implement', 'test', 'verify', 'commit']);
    assert.equal(only.diffs, 4, 'a contagem usa todas as linhas');
});

test('nó coberto por outro (fetch_ticket no plan) diz onde está o custo; "pendente" de nó executado não diverge', () => {
    const d = compareRuns(A, B);
    const m = M.build(d, { order: ORDER, resultsA: { ...RES_A, fetch_ticket: 'pending' }, resultsB: RES_B });
    const fetch = m.nodes.find(n => n.node === 'fetch_ticket');
    assert.equal(fetch.sides[0].note, 'rodou na sessão do plan: modelo, custo, tokens e duração contados lá');
    assert.equal(fetch.sides[0].label, 'pendente');
    assert.equal(fetch.cmp.kind, 'eq');
});

test('run aberto: B − A de custo, tokens e duração fica N/A; status "constructor" não quebra a projeção', () => {
    const rows = M.costRows(compareRuns({ cost_tracking: ct({ plan: node([]) }) }, { cost_tracking: ct({ plan: node([], { cost_usd: 0.3 }) }) }), { openA: true });
    assert.deepEqual(rows.filter(r => r.key !== 'attempts').map(r => r.d), ['N/A', 'N/A', 'N/A']);
    const m = M.nodeRows(compareRuns(A, A).nodeDiff, { order: ORDER, resultsA: { plan: 'constructor' }, resultsB: { plan: '__proto__' } });
    assert.equal(m.find(n => n.node === 'plan').sides[0].label, 'N/A');
});
