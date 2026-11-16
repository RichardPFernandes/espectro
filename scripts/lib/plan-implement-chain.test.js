// node --test scripts/lib/plan-implement-chain.test.js
// PRI-354 (AC2, AC3): elegibilidade do segmento [plan, implement], comandos com o plan-scorer
// entre /plan e /implement, nós que de fato rodaram e fechamento do Attempt do implement.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const chain = require('./plan-implement-chain');

const base = {
    enabled: true, node: 'plan', state: { node: 'plan', history: ['fetch_ticket'] },
    routed: false, decomposed: false, preBuildSkipped: true, specExists: true,
};

test('chainEligibility: todas as condições valem → elegível', () => {
    assert.deepStrictEqual(chain.chainEligibility(base), { eligible: true, reason: null });
});

test('chainEligibility: cada condição faltando recusa com o motivo', () => {
    const cases = [
        [{ enabled: false }, 'FLAG_OFF'],
        [{ node: 'implement' }, 'NOT_PLAN'],
        [{ state: { node: 'plan', history: ['fetch_ticket', 'plan', 'implement', 'review'] } }, 'IMPLEMENT_IN_HISTORY'],
        [{ routed: true }, 'ROUTED'],
        [{ decomposed: true }, 'DECOMPOSED'],
        [{ preBuildSkipped: false }, 'PRE_BUILD_ACTIVE'],
        [{ specExists: false }, 'SPEC_MISSING'],
    ];
    for (const [patch, reason] of cases) {
        assert.deepStrictEqual(chain.chainEligibility({ ...base, ...patch }), { eligible: false, reason }, reason);
    }
});

test('chainEligibility: flag desligada vem antes de qualquer outra leitura', () => {
    assert.deepStrictEqual(chain.chainEligibility({ enabled: false }), { eligible: false, reason: 'FLAG_OFF' });
});

test('chainCommands: /plan, plan-scorer e /implement, nesta ordem', () => {
    const cmds = chain.chainCommands({ taskId: '42-x', ticketId: 42, prismaRoot: '/p' });
    assert.deepStrictEqual(cmds, [
        '/plan 42-x',
        'node "/p/scripts/lib/plan-scorer.js" memory/runs/42-x/plan.md memory/spec/42-spec.md',
        '/implement 42-x',
    ]);
});

test('chainNote: manda parar sem /implement quando o scorer sai diferente de 0', () => {
    const note = chain.chainNote({ taskId: '42-x', ticketId: 42, prismaRoot: '/p' });
    assert.match(note, /plan-scorer\.js" memory\/runs\/42-x\/plan\.md memory\/spec\/42-spec\.md/);
    assert.match(note, /NÃO rode o \/implement/);
    assert.match(note, /sem subagente/i);
});

test('implementRan / planDone: histórico inteiro e state.node (G3 MAJOR 1: re-plan sem plan duplicado)', () => {
    const lease = { chain: { historyBase: 2 } };
    // re-plan: histórico já terminava em plan; o agente gravou só implement
    assert.strictEqual(chain.implementRan(lease, { node: 'review', history: ['fetch_ticket', 'plan', 'implement'] }), true);
    assert.strictEqual(chain.planDone(lease, { node: 'review', history: ['fetch_ticket', 'plan', 'implement'] }), true);
    // plan concluiu (gravou node=implement), implement não rodou
    assert.strictEqual(chain.implementRan(lease, { node: 'implement', history: ['fetch_ticket', 'plan'] }), false);
    assert.strictEqual(chain.planDone(lease, { node: 'implement', history: ['fetch_ticket', 'plan'] }), true);
    // plan não concluiu
    assert.strictEqual(chain.planDone(lease, { node: 'plan', history: ['fetch_ticket', 'plan'] }), false);
    assert.strictEqual(chain.planDone(lease, null), false);
});

test('ownsState: claim perdido ou node_started_at de outro despacho = sem posse (G3 MAJOR 3)', () => {
    const lease = { startedAt: 'T1', chain: {} };
    assert.strictEqual(chain.ownsState(lease, { node_started_at: 'T1' }), true);
    assert.strictEqual(chain.ownsState(lease, {}), true);
    assert.strictEqual(chain.ownsState(lease, { node_started_at: 'T2' }), false);
    for (const claim of ['LEASE_REPLACED', 'SESSION_CONFLICT', 'STATE_MISSING', 'CLAIM_UNKNOWN']) {
        assert.strictEqual(chain.ownsState(lease, { node_started_at: 'T1' }, claim), false, claim);
    }
    assert.strictEqual(chain.ownsState(lease, { node_started_at: 'T1' }, 'RELEASED'), true);
    assert.strictEqual(chain.ownsState(lease, null), false);
});

test('exitNodes: lease sem chain devolve os nós de sempre; com chain, os que rodaram', () => {
    assert.deepStrictEqual(chain.exitNodes({ node: 'review' }, {}), ['review']);
    assert.deepStrictEqual(chain.exitNodes({ nodes: ['fetch_ticket', 'plan'] }, {}), ['fetch_ticket', 'plan']);
    const lease = { node: 'plan', nodes: ['plan', 'implement'], chain: { historyBase: 2 } };
    assert.deepStrictEqual(chain.exitNodes(lease, { node: 'implement', history: ['fetch_ticket', 'plan'] }, 0), ['plan']);
    assert.deepStrictEqual(chain.exitNodes(lease, { node: 'review', history: ['fetch_ticket', 'plan', 'implement'] }, 0), ['plan', 'implement']);
    // G3 MAJOR 2: plan concluído e saída com erro → o erro é do implement
    assert.deepStrictEqual(chain.exitNodes(lease, { node: 'implement', history: ['fetch_ticket', 'plan'] }, 143), ['plan', 'implement']);
    assert.deepStrictEqual(chain.exitNodes(lease, { node: 'plan', history: ['fetch_ticket', 'plan'] }, 1), ['plan']);
});

test('retriesBeforeFor: usa o retry do último nó que rodou', () => {
    const lease = { retriesBefore: 9, chain: { historyBase: 0, retriesBefore: { plan: 1, implement: 2 } } };
    assert.strictEqual(chain.retriesBeforeFor(lease, ['plan']), 1);
    assert.strictEqual(chain.retriesBeforeFor(lease, ['plan', 'implement']), 2);
    assert.strictEqual(chain.retriesBeforeFor({ retriesBefore: 3 }, ['review']), 3);
});

test('planExitCode: plan concluído fecha com 0 mesmo se a sessão caiu depois; sem posse, código de sempre', () => {
    const lease = { startedAt: 'T1', chain: { historyBase: 2 } };
    const done = { node_started_at: 'T1', node: 'implement', history: ['fetch_ticket', 'plan'] };
    assert.strictEqual(chain.planExitCode(lease, 0, done), 0);
    assert.strictEqual(chain.planExitCode(lease, 143, done), 0);
    assert.strictEqual(chain.planExitCode(lease, 1, { node_started_at: 'T1', node: 'plan', history: ['fetch_ticket', 'plan'] }), 1);
    assert.strictEqual(chain.planExitCode(lease, 143, { ...done, node_started_at: 'T2' }), 143);
    assert.strictEqual(chain.planExitCode(lease, 143, done, { claim: 'LEASE_REPLACED' }), 143);
    // sem saída final (destacado em voo) não decide; com sinal em --follow, decide
    assert.strictEqual(chain.planExitCode(lease, undefined, done), undefined);
    assert.strictEqual(chain.planExitCode(lease, null, done, { signalled: true }), 0);
    assert.strictEqual(chain.planExitCode({}, 1, {}), 1);
});

function fakeDom06() {
    const calls = [];
    return {
        calls,
        closeOnExit: args => { calls.push(['close', args]); return true; },
        revoke: (file, opts) => { calls.push(['revoke', file, opts]); return {}; },
    };
}
const implLease = () => ({ startedAt: 'T1', chain: { historyBase: 2, implementAttemptFile: '/a/impl.json', implementAttemptId: 'impl' } });
const st = (node, history, extra = {}) => ({ node_started_at: 'T1', node, history, ...extra });
const PASS = () => ({ passed: true, score: 80 });

test('closeImplementAttempt: implement rodou e o plano passa no scorer → fecha pelo código de saída', () => {
    const d = fakeDom06();
    assert.strictEqual(chain.closeImplementAttempt(implLease(), 0, st('review', ['fetch_ticket', 'plan', 'implement']), d, { planGate: PASS }), 'CLOSED');
    assert.deepStrictEqual(d.calls, [['close', { attemptFile: '/a/impl.json', attemptId: 'impl', node: 'implement', code: 0 }]]);
});

test('closeImplementAttempt: cada desfecho sem prova revoga com o motivo próprio, nunca conta como PASS', () => {
    const cases = [
        ['plan concluído, código 0, sem implement', 0, st('implement', ['fetch_ticket', 'plan']), {}, 'CHAIN_STOPPED_AFTER_PLAN'],
        ['plan concluído, implement caiu (143)', 143, st('implement', ['fetch_ticket', 'plan']), {}, 'CHAIN_IMPLEMENT_NOT_CONFIRMED'],
        ['plan concluído, sinal em --follow', null, st('implement', ['fetch_ticket', 'plan']), { signalled: true }, 'CHAIN_IMPLEMENT_NOT_CONFIRMED'],
        ['plan não concluído', 1, st('plan', ['fetch_ticket', 'plan']), {}, 'CHAIN_PLAN_NOT_DONE'],
        ['state de outro despacho', 0, st('review', ['fetch_ticket', 'plan', 'implement'], { node_started_at: 'T2' }), {}, 'CHAIN_CLAIM_LOST'],
        ['claim perdido', 0, st('review', ['fetch_ticket', 'plan', 'implement']), { claim: 'SESSION_CONFLICT' }, 'CHAIN_CLAIM_LOST'],
        ['state ilegível', 0, null, {}, 'CHAIN_STATE_UNREADABLE'],
        ['implement rodou, plano reprovado no scorer', 0, st('review', ['fetch_ticket', 'plan', 'implement']), { planGate: () => ({ passed: false, score: 20 }) }, 'CHAIN_PLAN_GATE_FAILED'],
        ['implement rodou, plano ilegível', 0, st('review', ['fetch_ticket', 'plan', 'implement']), { planGate: () => null }, 'CHAIN_PLAN_GATE_UNKNOWN'],
    ];
    for (const [label, code, state, opts, reason] of cases) {
        const d = fakeDom06();
        assert.strictEqual(chain.closeImplementAttempt(implLease(), code, state, d, { planGate: PASS, ...opts }), 'REVOKED', label);
        assert.deepStrictEqual(d.calls, [['revoke', '/a/impl.json', { reason }]], label);
    }
});

test('closeImplementAttempt: sem saída final (destacado em voo) não decide nada; sem chain, no-op', () => {
    const d = fakeDom06();
    assert.strictEqual(chain.closeImplementAttempt(implLease(), undefined, st('implement', ['fetch_ticket', 'plan']), d), 'PENDING');
    assert.strictEqual(chain.closeImplementAttempt({}, 0, {}, d), null);
    assert.strictEqual(d.calls.length, 0);
});

test('chainCommands: caminho do scorer entre aspas (PRISMA_ROOT com espaço)', () => {
    assert.match(chain.chainCommands({ taskId: '1-x', ticketId: 1, prismaRoot: '/a b' })[1], /^node "\/a b\/scripts\/lib\/plan-scorer\.js" /);
});

test('closeChainOnExit: lê o state.json do lease e fecha o Attempt do implement (Attempt real em disco)', () => {
    const dom06 = require('./dom06-attempt');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'chain-close-'));
    const decision = dom06.prepareDispatch({ runDir: tmp, node: 'implement', ticketId: 42, baseBranch: 'main', specHash: null });
    assert.strictEqual(decision.dispatch, true);
    fs.writeFileSync(path.join(tmp, 'state.json'), JSON.stringify({ node: 'implement', history: ['fetch_ticket', 'plan'] }));
    const lease = { dir: tmp, chain: { historyBase: 1, implementAttemptFile: decision.attemptFile, implementAttemptId: decision.attempt.attempt_id } };
    assert.strictEqual(chain.closeChainOnExit(lease, 0), 'REVOKED');
    const after = JSON.parse(fs.readFileSync(decision.attemptFile, 'utf8'));
    assert.strictEqual(after.authority, 'revoked');
    assert.strictEqual(after.revoke_reason, 'CHAIN_STOPPED_AFTER_PLAN');
    assert.ok(after.obligations.every(o => o.status !== 'fulfilled'));
});
