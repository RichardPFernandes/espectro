// node --test lib/run-comparator.test.js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const cmp = require('./run-comparator');

const tmpBase = process.env.CLAUDE_JOB_DIR ? path.join(process.env.CLAUDE_JOB_DIR, 'tmp') : os.tmpdir();

const cost = (nodes, totals) => ({ nodes, ...(totals ? { totals } : {}) });
const node = (i, o, extra = {}) => ({ agent: 'claude', input_tokens: i, output_tokens: o, runs: 1, ...extra });

const FAILED = {
    task_id: '95001-x', status: 'escalated', node: 'escalated',
    history: ['fetch_ticket', 'plan', 'implement', 'review', 'test', 'implement', 'review', 'test'],
    retries: { test: 2 }, planScore: 55,
    test_result: { result: 'falhou', total: 40, failures: 3, errors: 0 },
    cost_tracking: cost({ plan: node(1000, 100), implement: node(3000, 300), review: node(1000, 100), test: node(4000, 400) },
        { input_tokens: 9000, output_tokens: 900, cost_usd: 4, duration_ms: 600000 }),
};
const COMMITTED = {
    task_id: '95001-x-replay-1', status: 'committed', node: 'commit',
    history: ['fetch_ticket', 'plan', 'implement', 'review', 'test', 'verify', 'commit'],
    retries: {}, planScore: 80,
    test_result: { result: 'passou', total: 42, failures: 0, errors: 0 },
    cost_tracking: cost({ plan: node(900, 100), implement: node(1500, 100), review: node(500, 50), test: node(1700, 150), verify: node(500, 50), commit: node(400, 50) },
        { input_tokens: 5500, output_tokens: 500, cost_usd: 2, duration_ms: 400000 }),
};

test('status diferente: B completo e A falhou => B-better, com resumo', () => {
    const r = cmp.compareRuns(FAILED, COMMITTED);
    assert.strictEqual(r.verdict, 'B-better');
    assert.match(r.verdictReason, /status/);
    assert.match(r.summary, /^Run B completou com sucesso em 39% menos tokens que Run A/);
    // inverso
    assert.strictEqual(cmp.compareRuns(COMMITTED, FAILED).verdict, 'A-better');
});

test('seções: tokenDiff por nó com delta %, nodeDiff, testResultsDiff, planScoreDiff', () => {
    const r = cmp.compareRuns(FAILED, COMMITTED);
    const impl = r.tokenDiff.nodes.find(n => n.node === 'implement');
    assert.deepStrictEqual([impl.a, impl.b, impl.delta, impl.deltaPct, impl.significant], [3300, 1600, -1700, -51.5, true]);
    assert.deepStrictEqual(r.tokenDiff.nodes.map(n => n.node), ['plan', 'implement', 'review', 'test', 'verify', 'commit']);
    const verify = r.tokenDiff.nodes.find(n => n.node === 'verify');
    assert.deepStrictEqual([verify.a, verify.deltaPct], ['N/A', 'N/A']);
    assert.deepStrictEqual(r.tokenDiff.total, { a: 9900, b: 6000, delta: -3900, deltaPct: -39.4, significant: true });

    assert.deepStrictEqual(r.nodeDiff.onlyInA, []);
    assert.deepStrictEqual(r.nodeDiff.onlyInB, ['verify', 'commit']);
    assert.deepStrictEqual(r.nodeDiff.executions.implement, { a: 2, b: 1 });

    assert.strictEqual(r.testResultsDiff.a.outcome, 'failed');
    assert.strictEqual(r.testResultsDiff.b.outcome, 'passed');
    assert.strictEqual(r.testResultsDiff.direction, 'fixed');

    assert.deepStrictEqual([r.planScoreDiff.a, r.planScoreDiff.b, r.planScoreDiff.delta], [55, 80, 25]);

    const status = r.metrics.find(m => m.key === 'status');
    assert.deepStrictEqual([status.a, status.b, status.better, status.significant], ['escalated', 'committed', 'B', true]);
    const tokens = r.metrics.find(m => m.key === 'tokens');
    assert.deepStrictEqual([tokens.better, tokens.significant], ['B', true]);
});

test('stateDiff: só o que mudou, objetos achatados, ausente = N/A, cost_tracking/events fora', () => {
    const a = { status: 'committed', same: 1, test_result: { result: 'passou', total: 10 }, events: [{ a: 1 }], cost_tracking: cost({}) };
    const b = { status: 'committed', same: 1, test_result: { result: 'passou', total: 12 }, extra: 'x', events: [] };
    const r = cmp.compareRuns(a, b);
    assert.deepStrictEqual(r.stateDiff, [
        { key: 'extra', a: 'N/A', b: 'x', change: 'added' },
        { key: 'test_result.total', a: 10, b: 12, change: 'changed' },
    ]);
});

test('schema incompleto (campos faltando, state vazio, state ilegível) não quebra — N/A', () => {
    for (const [a, b] of [[{ status: 'committed' }, {}], [{}, {}], [null, { status: 'escalated' }], [{ cost_tracking: 'lixo', history: 'x', retries: 3, test_result: 7 }, { cost_tracking: { nodes: { plan: 'x' } } }]]) {
        const r = cmp.compareRuns(a, b);
        assert.ok(['A-better', 'B-better', 'equivalent', 'inconclusive'].includes(r.verdict));
        assert.ok(Array.isArray(r.stateDiff));
        assert.ok(typeof r.summary === 'string');
    }
    const r = cmp.compareRuns({ status: 'committed' }, {});
    assert.strictEqual(r.tokenDiff.total.a, 'N/A');
    assert.strictEqual(r.metrics.find(m => m.key === 'tokens').a, 'N/A');
    assert.strictEqual(r.metrics.find(m => m.key === 'status').b, 'N/A');
    assert.strictEqual(r.testResultsDiff.a.outcome, 'N/A');
    assert.strictEqual(r.planScoreDiff, 'N/A');
    assert.match(r.summary, /tokens N\/A/);
    assert.strictEqual(r.verdict, 'A-better'); // sucesso vs status desconhecido
});

test('mesmo status e testes: tokens decidem acima de 20%, senão equivalent', () => {
    const base = { status: 'committed', test_result: 'passou' };
    const withTok = n => ({ ...base, cost_tracking: cost({ plan: node(n, 0) }) });
    assert.strictEqual(cmp.compareRuns(withTok(1000), withTok(900)).verdict, 'equivalent');
    assert.match(cmp.compareRuns(withTok(1000), withTok(900)).summary, /^Runs equivalentes/);
    assert.strictEqual(cmp.compareRuns(withTok(1000), withTok(500)).verdict, 'B-better');
    assert.strictEqual(cmp.compareRuns(withTok(1000), withTok(1500)).verdict, 'A-better');
    assert.strictEqual(cmp.compareRuns(base, base).verdict, 'equivalent');
});

test('testes desempatam quando o status empata', () => {
    const r = cmp.compareRuns({ status: 'escalated', test_result: 'passou' }, { status: 'escalated', test_result: 'FAILED: 3 testes' });
    assert.strictEqual(r.verdict, 'A-better');
    assert.strictEqual(r.testResultsDiff.direction, 'regressed');
});

test('testOutcome: texto, objeto, booleano, contadores', () => {
    assert.strictEqual(cmp.testOutcome('passou').outcome, 'passed');
    assert.strictEqual(cmp.testOutcome('falhou em 2').outcome, 'failed');
    assert.strictEqual(cmp.testOutcome({ passed: false }).outcome, 'failed');
    assert.strictEqual(cmp.testOutcome({ total: 5, failures: 0 }).outcome, 'passed');
    assert.strictEqual(cmp.testOutcome({ total: 5, failures: 1 }).outcome, 'failed');
    assert.strictEqual(cmp.testOutcome(undefined).outcome, 'N/A');
    assert.strictEqual(cmp.testOutcome('???').outcome, 'N/A');
});

test('testOutcome: resultado parcial (missing/PARTIAL) nunca vira passed', () => {
    const partial = cmp.testOutcome({ result: 'PARTIAL', total: 3, failures: 0, missing: 2 });
    assert.deepStrictEqual([partial.outcome, partial.partial, partial.missing], ['N/A', true, 2]);
    assert.match(partial.summary, /2 faltando/);
    assert.strictEqual(cmp.testOutcome({ total: 5, failures: 0, missing: 1 }).outcome, 'N/A');
    assert.strictEqual(cmp.testOutcome({ passed: true, missing: 1 }).outcome, 'N/A');
    assert.strictEqual(cmp.testOutcome('passou parcialmente').outcome, 'N/A');
    assert.strictEqual(cmp.testOutcome({ result: 'PARTIAL', total: 3, failures: 1, missing: 1 }).outcome, 'failed');
    assert.strictEqual(cmp.testOutcome({ total: 5, failures: 0, missing: 0 }).outcome, 'passed');
    assert.strictEqual(cmp.testOutcome({ total: 5, failures: 0 }).partial, false);
});

test('sem prova suficiente => inconclusive, nunca equivalent', () => {
    for (const [a, b] of [[{}, {}], [null, null], [{ status: 'running' }, {}]]) {
        const r = cmp.compareRuns(a, b);
        assert.strictEqual(r.verdict, 'inconclusive');
        assert.match(r.verdictReason, /status ausente/);
        assert.match(r.summary, /^Comparação inconclusiva/);
    }
    const partial = { status: 'committed', test_result: { result: 'PARTIAL', total: 3, failures: 0, missing: 2 } };
    const r = cmp.compareRuns(partial, partial);
    assert.strictEqual(r.verdict, 'inconclusive');
    assert.match(r.verdictReason, /testes parciais em A e B/);
    const partialTok = { status: 'committed', test_result: 'passou', cost_tracking: cost({ plan: node(1000, 100, { runs_without_tokens: 1 }) }) };
    const full = { status: 'committed', test_result: 'passou', cost_tracking: cost({ plan: node(1000, 100) }) };
    assert.strictEqual(cmp.compareRuns(full, partialTok).verdict, 'inconclusive');
    assert.match(cmp.compareRuns(full, partialTok).verdictReason, /tokens parciais em B/);
    // prova num lado continua decidindo
    assert.strictEqual(cmp.compareRuns({ status: 'committed' }, {}).verdict, 'A-better');
    assert.strictEqual(cmp.compareRuns(full, full).verdict, 'equivalent');
});

test('custo parcial: metric cost_usd leva complete/missing por lado', () => {
    const partialCost = cost({ test: node(20, 2, { cost_usd: 0.5, runs: 2, runs_without_cost: 1 }) }, { input_tokens: 20, output_tokens: 2, cost_usd: 0.5 });
    const fullCost = cost({ test: node(20, 2, { cost_usd: 0.7 }) }, { input_tokens: 20, output_tokens: 2, cost_usd: 0.7 });
    const r = cmp.compareRuns({ status: 'committed', cost_tracking: partialCost }, { status: 'committed', cost_tracking: fullCost });
    const m = r.metrics.find(x => x.key === 'cost_usd');
    assert.deepStrictEqual([m.a, m.b], [0.5, 0.7]);
    assert.deepStrictEqual(m.complete, { a: false, b: true });
    assert.deepStrictEqual(m.missing, { a: 1, b: 0 });
    const none = cmp.compareRuns({ status: 'committed' }, { status: 'committed' }).metrics.find(x => x.key === 'cost_usd');
    assert.deepStrictEqual([none.a, none.complete, none.missing], ['N/A', { a: false, b: false }, { a: null, b: null }]);
});

test('parseRunRef: task-id, replay file e refs inválidas', () => {
    assert.deepStrictEqual(cmp.parseRunRef('task-42'), { ref: 'task-42', taskId: 'task-42', file: 'state.json' });
    assert.deepStrictEqual(cmp.parseRunRef('task-42/state-replay-1234.json'), { ref: 'task-42/state-replay-1234.json', taskId: 'task-42', file: 'state-replay-1234.json' });
    for (const bad of ['../etc', 'task-42/../../x.json', 'task-42/context.md', '_archive', '', 'a/b/c']) {
        assert.throws(() => cmp.parseRunRef(bad), e => e.code === 'invalid_ref', bad);
    }
});

test('loadRun: acha em memory/runs, _archive, worktree do ticket e memory/archive; replay file; read-only', () => {
    const repo = fs.mkdtempSync(path.join(tmpBase, 'run-comparator-'));
    const seed = (dir, file, state) => { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, file), typeof state === 'string' ? state : JSON.stringify(state)); };
    const runs = path.join(repo, 'memory', 'runs');
    seed(path.join(runs, 'task-42'), 'state.json', { status: 'escalated', updated_at: '2026-09-01T00:00:00Z' });
    seed(path.join(runs, 'task-42'), 'state-replay-task-42-replay-1.json', { status: 'in_progress', task_id: 'task-42-replay-1' });
    seed(path.join(runs, '_archive', 'task-43'), 'state.json', { status: 'committed' });
    seed(path.join(repo, 'memory', 'archive', '2026-08', 'task-44'), 'state.json', { status: 'committed' });
    // cópia legada no main + cópia autoritativa no worktree do ticket
    seed(path.join(runs, '95010-x'), 'state.json', { status: 'in_progress', updated_at: '2026-09-30T00:00:00Z' });
    seed(path.join(repo, '.claude', 'worktrees', '95010', 'memory', 'runs', '95010-x'), 'state.json', { status: 'committed', updated_at: '2026-09-01T00:00:00Z' });
    seed(path.join(runs, 'task-bad'), 'state.json', '{ quebrado');
    // custo só no <ticket>-cost.json
    seed(path.join(runs, '95011-y'), 'state.json', { status: 'committed' });
    seed(runs, '95011-cost.json', { tasks: { '95011-y': cost({ plan: node(10, 5) }) } });

    const snapshot = () => {
        const out = {};
        const walk = d => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); e.isDirectory() ? walk(p) : (out[p] = fs.statSync(p).mtimeMs + ':' + fs.readFileSync(p, 'utf8')); } };
        walk(repo);
        return out;
    };
    const before = snapshot();

    const opts = { repoPath: repo };
    assert.strictEqual(cmp.loadRun('task-42', opts).state.status, 'escalated');
    const rep = cmp.loadRun('task-42/state-replay-task-42-replay-1.json', opts);
    assert.strictEqual(rep.state.status, 'in_progress');
    assert.strictEqual(rep.ref, 'task-42/state-replay-task-42-replay-1.json');
    assert.strictEqual(cmp.loadRun('task-43', opts).source, 'main/_archive');
    assert.strictEqual(cmp.loadRun('task-44', opts).source, 'archive/2026-08');
    const own = cmp.loadRun('95010-x', opts);
    assert.deepStrictEqual([own.state.status, own.source], ['committed', 'worktree:95010']);
    const bad = cmp.loadRun('task-bad', opts);
    assert.strictEqual(bad.state, null);
    assert.match(bad.readError, /malformado/);
    const withCost = cmp.loadRun('95011-y', opts);
    assert.strictEqual(withCost.costSource, '95011-cost.json');
    assert.strictEqual(cmp.compareRuns(bad, withCost).tokenDiff.total.b, 15);
    assert.throws(() => cmp.loadRun('nao-existe', opts), e => e.code === 'not_found');

    assert.deepStrictEqual(snapshot(), before, 'nenhum arquivo foi criado/alterado');
    fs.rmSync(repo, { recursive: true, force: true });
});

test('facts e nodeDiff.detail: entradas, provider, modelos, custo e duração por nó (tela Comparar runs)', () => {
    const at = provider => ({ provider });
    const A = {
        status: 'committed', history: ['plan', 'implement', 'implement'], spec_path: 'memory/spec/x.md', spec_hash: 'sha256:aa',
        planScore: 82, transcripts_total: 3, started_at: '2026-11-01T10:00:00Z', updated_at: '2026-11-01T10:40:00Z',
        cost_tracking: cost({
            plan: node(100, 10, { models: ['claude-sonnet-5-5'], duration_ms: 4000, cost_usd: 0.1, attempts: [at('anthropic')] }),
            implement: node(300, 30, { runs: 2, models: ['claude-opus-5-5'], duration_ms: 9000, cost_usd: null, runs_without_cost: 1, attempts: [at('anthropic'), at('UNKNOWN')] }),
        }),
    };
    const B = { status: 'escalated', history: ['plan'], cost_tracking: cost({ plan: node(null, null, { runs_without_tokens: 1, attempts: [at('openai')] }) }) };
    const r = cmp.compareRuns(A, B);
    assert.deepStrictEqual(r.facts.a, { specPath: 'memory/spec/x.md', specHash: 'sha256:aa', providers: ['anthropic'], planScore: 82, transcripts: 3,
        startedAt: '2026-11-01T10:00:00Z', updatedAt: '2026-11-01T10:40:00Z' });
    assert.deepStrictEqual(r.facts.b, { specPath: null, specHash: null, providers: ['openai'], planScore: null, transcripts: null, startedAt: null, updatedAt: null });
    const impl = r.nodeDiff.detail.implement;
    assert.deepStrictEqual(impl.a, { coveredBy: null, executions: 2, models: ['claude-opus-5-5'], providers: ['anthropic'], durationMs: 9000, costUsd: null,
        tokens: 330, runsWithoutCost: 1, runsWithoutTokens: 0, tracked: true });
    assert.strictEqual(impl.b, null, 'nó que não executou em B = null');
    const plan = r.nodeDiff.detail.plan.b;
    assert.deepStrictEqual([plan.tokens, plan.costUsd, plan.runsWithoutTokens, plan.models], [null, null, 1, []]);
    // history sem cost_tracking: executou, mas sem medição (tracked: false, tudo null)
    const h = cmp.compareRuns({ history: ['plan'] }, {}).nodeDiff.detail.plan.a;
    assert.deepStrictEqual([h.executions, h.tracked, h.costUsd, h.durationMs], [1, false, null, null]);
    // also_covers: fetch_ticket rodou dentro do plan
    const cov = cmp.compareRuns({ cost_tracking: cost({ plan: node(1, 1, { also_covers: ['fetch_ticket'] }) }) }, {}).nodeDiff.detail.fetch_ticket.a;
    assert.deepStrictEqual([cov.executions, cov.tracked, cov.coveredBy], [1, false, 'plan']);
});
