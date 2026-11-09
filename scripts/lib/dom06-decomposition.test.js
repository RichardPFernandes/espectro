// node --test scripts/lib/dom06-decomposition.test.js
// PRI-310 (PRI-287 S5.1): flag reservada (AC-02, AC-03), identidade (AC-04) e contrato do
// DOM-06 para subtarefas (AC-05 a AC-11).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const dom06 = require('./dom06-attempt');
const mr = require('./model-routing');
const policyLoader = require('./model-routing-policy');
const nodeLease = require('./node-lease');
const decomposition = require('./subtask-decomposition');
const { RULES } = require('./config-validator');
const routingRule = root => RULES.find(r => r.id === 'routing-config').run({ root, contract: { rules: {} } });

const tmpRoot = fs.mkdtempSync(path.join(process.env.CLAUDE_JOB_DIR ? path.join(process.env.CLAUDE_JOB_DIR, 'tmp') : os.tmpdir(), 'dom06-dec-'));
test.after(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));
let n = 0;
const runDir = () => path.join(tmpRoot, `run${n++}`);

const PV = 'a'.repeat(64);
const PV2 = 'b'.repeat(64);
const K1 = `${PV.slice(0, 12)}/1-1`;
const K2 = `${PV.slice(0, 12)}/2-2`;
const ADMITTED = { status: 'ADMITTED', owner: 'dom06', snapshot: { ticket_id: 1, node: 'implement', base_branch: 'main' } };
const COMPLETE = d => ({ digest: d, counts: { head: 1 }, completeness: 'COMPLETE', cause: null });

function sub(dir, key, extra = {}) {
    return dom06.beginAttempt(dir, { node: 'implement', admission: ADMITTED, decomposition: { role: 'subtask', plan_version: PV, subtask_key: key, workspace_baseline: COMPLETE('d0'), ...extra } });
}
function integ(dir, extra = {}) {
    return dom06.beginAttempt(dir, { node: 'implement', admission: ADMITTED, decomposition: { role: 'integration', plan_version: PV, workspace_baseline: COMPLETE('d0'), ...extra } });
}
const accept = (b, post = 'd1') => dom06.closeOnExit({ attemptFile: b.attemptFile, attemptId: b.attempt.attempt_id, node: 'implement', code: 0, claim: 'RELEASED', manifestPost: COMPLETE(post), currentPlanVersion: PV });

// ---------------------------------------------------------------- flag (B1)

function consumer(cfg) {
    const root = path.join(tmpRoot, `c${n++}`);
    fs.mkdirSync(path.join(root, '.claude'), { recursive: true });
    const policy = {
        id: 'p', version: 'v1', mode: 'ROUTED', classifier: { provider: 'cheap_rule' },
        class_to_tier: { C1: { tier: 'T1', effort: 'baixo' }, C2: { tier: 'T2', effort: 'médio' }, C3: { tier: 'T2', effort: 'alto' }, C4: { tier: 'T3', effort: 'alto' }, C5: { tier: 'T3', effort: 'máximo' } },
        tiers: { T1: { models: ['m1'] }, T2: { models: ['m2'] }, T3: { models: ['m3'] } },
        default_route: { model_id: 'm3', effort: 'alto' },
        effort_map: { baixo: 'low', 'médio': 'medium', alto: 'high', 'máximo': 'max' },
    };
    const bytes = JSON.stringify(policy);
    fs.writeFileSync(path.join(root, '.claude', 'routing-policy.json'), bytes);
    const ref = { id: 'p', version: 'v1', sha256: crypto.createHash('sha256').update(bytes).digest('hex'), path: '.claude/routing-policy.json' };
    fs.writeFileSync(path.join(root, '.claude', 'model-routing.json'), JSON.stringify(typeof cfg === 'function' ? cfg(ref) : cfg));
    return root;
}

test('AC-02: mode OFF/ausente + decomposition qualquer → OFF, admissão inalterada, só aviso no check', () => {
    for (const cfg of [{ decomposition: 'on' }, { mode: 'OFF', decomposition: 'on' }, { mode: 'OFF', decomposition: 'lixo' }]) {
        const root = consumer(cfg);
        const r = policyLoader.readRoutingConfig(root);
        assert.deepStrictEqual([r.status, r.decomposition_ignored], ['OFF', true]);
        const check = routingRule(root);
        assert.strictEqual(check.passed, true);
        assert.match(check.message, /DECOMPOSITION_IGNORED_MODE_OFF/);
    }
    assert.deepStrictEqual(policyLoader.readRoutingConfig(consumer({ mode: 'OFF' })), { status: 'OFF', source: 'declared' }, 'sem a chave, o OFF é o de sempre');
});

test('AC-02: mode ON + valor fora do enum → ROUTING_CONFIG_INVALID (bloqueio do RC-5)', () => {
    const r = policyLoader.readRoutingConfig(consumer(ref => ({ mode: 'ON', policy_ref: ref, decomposition: 'sim' })));
    assert.deepStrictEqual([r.status, r.cause, r.detail], ['INVALID', 'ROUTING_CONFIG_INVALID', 'decomposition_invalid']);
});

test('AC-03: mode ON + "on" → DECOMPOSITION_RESERVED (fail-closed); "off" explícito → snapshot byte a byte igual ao de chave ausente', () => {
    const reserved = policyLoader.readRoutingConfig(consumer(ref => ({ mode: 'ON', policy_ref: ref, decomposition: 'on' })));
    assert.deepStrictEqual([reserved.status, reserved.cause], ['INVALID', 'DECOMPOSITION_RESERVED']);
    const absent = mr.buildRoutingSnapshot(policyLoader.readRoutingConfig(consumer(ref => ({ mode: 'ON', policy_ref: ref }))));
    const off = mr.buildRoutingSnapshot(policyLoader.readRoutingConfig(consumer(ref => ({ mode: 'ON', policy_ref: ref, decomposition: 'off' }))));
    assert.strictEqual(JSON.stringify(off), JSON.stringify(absent));
    assert.ok(!('decomposition' in off));
    // Só o harness monta um `loaded` com "on": o campo entra e muda o sha.
    const loaded = { ...policyLoader.readRoutingConfig(consumer(ref => ({ mode: 'ON', policy_ref: ref }))), decomposition: 'on' };
    const on = mr.buildRoutingSnapshot(loaded);
    assert.strictEqual(on.decomposition, 'on');
    assert.notStrictEqual(on.sha256, absent.sha256);
    assert.strictEqual(mr.snapshotIntegrity(on).ok, true);
});

// ---------------------------------------------------------------- identidade (AC-04)

const PLAN = (extra = '') => [
    '# Plano', '', '## Plano de execução', '',
    '1. Serviço.', '   - Arquivo: `src/A.java`', '   - Critérios: AC-01', '',
    '2. Docs.', '   - Arquivo: `docs/x.md`', '   - Critérios: AC-02', '',
    '3. Sem arquivo declarado.', '   - Critérios: AC-03', extra, '',
].join('\n');

test('AC-04: mesma entrada → mesmas chaves; replan → SUPERSEDED; passo sem Arquivo → grupo próprio UNKNOWN; intercalados → NOT_DECOMPOSABLE', () => {
    const a = decomposition.decomposePlan(PLAN());
    const b = decomposition.decomposePlan(PLAN());
    assert.strictEqual(a.status, 'DECOMPOSABLE');
    assert.deepStrictEqual(a, b);
    assert.deepStrictEqual(a.groups.map(g => g.subtask_key.split('/')[1]), ['1-1', '2-2', '3-3']);
    assert.strictEqual(a.groups[2].paths_decl, 'UNKNOWN');
    assert.deepStrictEqual(a.scope_paths, ['docs/x.md', 'src/A.java']);
    const replan = decomposition.decomposePlan(PLAN('   - Verificação: nova'));
    assert.notStrictEqual(replan.plan_version, a.plan_version);
    assert.deepStrictEqual(decomposition.superseded(a, replan).map(s => s.status), ['SUPERSEDED', 'SUPERSEDED', 'SUPERSEDED']);
    assert.deepStrictEqual(decomposition.superseded(a, b), []);
    const inter = decomposition.decomposePlan([
        '## Plano de execução', '',
        '1. A.', '   - Arquivo: `src/A.java`', '',
        '2. B.', '   - Arquivo: `src/B.java`', '',
        '3. A de novo.', '   - Arquivo: `src/A.java`', '',
    ].join('\n'));
    assert.deepStrictEqual([inter.status, inter.cause], ['NOT_DECOMPOSABLE', 'INTERLEAVED_GROUPS']);
    assert.deepStrictEqual(decomposition.decomposePlan('# sem plano').cause, 'PLAN_BLOCK_NOT_FOUND');
});

// ---------------------------------------------------------------- contrato (B3)

test('Attempt sem decomposição fica byte a byte igual (sem campos novos)', () => {
    const b = dom06.beginAttempt(runDir(), { node: 'implement', admission: ADMITTED, obligations: dom06.obligationsFor('implement') });
    for (const f of ['role', 'subtask_key', 'plan_version', 'workspace', 'acceptance', 'parent_attempt_id']) assert.ok(!(f in b.attempt), f);
});

test('obrigações: subtarefa só execute_subtask; integração integrate + execute_node; papel inválido recusado', () => {
    const dir = runDir();
    assert.deepStrictEqual(sub(dir, K1).attempt.obligations, [{ id: `execute_subtask:${K1}`, kind: 'subtask_execution', status: 'pending' }]);
    assert.deepStrictEqual(integ(dir).attempt.obligations.map(o => o.id), [`integrate:${PV}`, 'execute_node']);
    assert.throws(() => dom06.beginAttempt(dir, { node: 'implement', admission: ADMITTED, decomposition: { role: 'outro', plan_version: PV } }), /DECOMPOSITION_ROLE_INVALID/);
    assert.throws(() => dom06.beginAttempt(dir, { node: 'implement', admission: ADMITTED, decomposition: { role: 'subtask', plan_version: PV } }), /SUBTASK_KEY_REQUIRED/);
});

test('AC-05: tabela de aceite linha a linha; exit 0 com post UNKNOWN não cumpre; summarize só PASS com aceite', () => {
    const base = { plan_version: PV, workspace: { baseline: COMPLETE('d0') } };
    const d = (code, claim, post, cur = PV) => dom06.decideAcceptance({ attempt: base, code, claim, post, currentPlanVersion: cur });
    const U = { completeness: 'UNKNOWN', digest: null };
    assert.deepStrictEqual([d(0, 'RELEASED', COMPLETE('d1')).accepted, d(0, 'RELEASED', COMPLETE('d1')).no_change], [true, false]);
    assert.deepStrictEqual([d(0, 'RELEASED', COMPLETE('d0')).accepted, d(0, 'RELEASED', COMPLETE('d0')).no_change], [true, true]);
    assert.deepStrictEqual([d(0, 'RELEASED', U).reason, d(0, 'RELEASED', U).block], ['POST_UNKNOWN', true]);
    assert.deepStrictEqual([d(0, 'STATUS_CHANGED', COMPLETE('d1')).reason, d(0, 'STATUS_CHANGED', COMPLETE('d1')).block], ['STATUS_CHANGED', false]);
    assert.deepStrictEqual([d(0, 'STATE_MISSING', COMPLETE('d1')).reason, d(0, 'STATE_MISSING', COMPLETE('d1')).block], ['STATE_MISSING', true]);
    assert.strictEqual(d(0, 'RELEASED', COMPLETE('d1'), null).reason, 'PLAN_VERSION_UNKNOWN');
    assert.strictEqual(d(0, null, COMPLETE('d1')).reason, 'CLAIM_UNKNOWN');
    assert.strictEqual(d(1, 'RELEASED', U).reason, 'MANIFEST_UNKNOWN');
    // Ordem (C-A-03): claim perdido e status trocado vêm antes da versão do plano.
    for (const c of ['LEASE_REPLACED', 'SESSION_CONFLICT']) {
        assert.deepStrictEqual([d(0, c, COMPLETE('d0')).reason, d(0, c, COMPLETE('d0')).block], ['CLAIM_LOST', false]);
        assert.deepStrictEqual([d(0, c, COMPLETE('d9')).reason, d(0, c, COMPLETE('d9')).block], ['CLAIM_LOST', true]);
    }
    assert.deepStrictEqual([d(0, 'STATUS_CHANGED', COMPLETE('d9'), null).reason, d(0, 'STATUS_CHANGED', COMPLETE('d9'), null).block], ['STATUS_CHANGED', false]);

    const dir = runDir();
    const b = sub(dir, K1);
    const r = dom06.closeOnExit({ attemptFile: b.attemptFile, attemptId: b.attempt.attempt_id, node: 'implement', code: 0, claim: 'RELEASED', manifestPost: U, currentPlanVersion: PV });
    assert.strictEqual(r.accepted, false);
    const after = dom06.readAttempt(b.attemptFile);
    assert.strictEqual(after.obligations[0].status, 'pending');
    assert.strictEqual(dom06.summarize(after).pass, false);
    const ok = sub(dir, K2);
    accept(ok);
    const okAfter = dom06.readAttempt(ok.attemptFile);
    assert.strictEqual(okAfter.obligations[0].status, 'fulfilled');
    assert.strictEqual(dom06.summarize(okAfter).pass, true);
    assert.deepStrictEqual(okAfter.workspace.post, COMPLETE('d1'));
    // Aceite é imutável: segunda chamada devolve o gravado.
    assert.strictEqual(accept(ok, 'outro').duplicate, true);
    assert.deepStrictEqual(dom06.readAttempt(ok.attemptFile).workspace.post, COMPLETE('d1'));
});

test('AC-06: agregação só com todas as chaves e a integração depois delas; idempotente na Run', async () => {
    const dir = runDir();
    accept(sub(dir, K1));
    let r = dom06.aggregateImplement(dir, PV, [K1, K2]);
    assert.deepStrictEqual(r.pending, [K2, `integrate:${PV}`]);
    assert.ok(dom06.listAttempts(dir).every(a => !(a.effects || []).some(e => String(e.idempotency_key).startsWith('aggregate:'))), 'nada gravado');
    await new Promise(res => setTimeout(res, 5));
    accept(sub(dir, K2));
    await new Promise(res => setTimeout(res, 5));
    const i1 = integ(dir);
    accept(i1);
    r = dom06.aggregateImplement(dir, PV, [K1, K2]);
    assert.deepStrictEqual([r.ok, r.duplicate], [true, false]);
    assert.strictEqual(dom06.readAttempt(i1.attemptFile).obligations.find(o => o.id === 'execute_node').status, 'fulfilled');
    // Segunda integração aceita: execute_node não é cumprida de novo.
    await new Promise(res => setTimeout(res, 5));
    const i2 = integ(dir);
    accept(i2);
    assert.strictEqual(dom06.aggregateImplement(dir, PV, [K1, K2]).duplicate, true);
    assert.strictEqual(dom06.readAttempt(i2.attemptFile).obligations.find(o => o.id === 'execute_node').status, 'pending');
    const count = dom06.listAttempts(dir).flatMap(a => a.effects || []).filter(e => String(e.idempotency_key).startsWith(`aggregate:${PV}:`)).length;
    assert.strictEqual(count, 1);
});

test('AC-06: rework aceito depois da integração exige nova integração; rework ALL entra na agregação', async () => {
    const dir = runDir();
    accept(sub(dir, K1));
    await new Promise(res => setTimeout(res, 5));
    accept(integ(dir));
    await new Promise(res => setTimeout(res, 5));
    const all = sub(dir, decomposition.allKey(PV), { rework: true });
    assert.deepStrictEqual(dom06.aggregateImplement(dir, PV, [K1]).pending, [decomposition.allKey(PV), `integrate:${PV}`]);
    accept(all);
    assert.deepStrictEqual(dom06.aggregateImplement(dir, PV, [K1]).pending, [`integrate:${PV}`], 'integração anterior ao rework não vale');
    await new Promise(res => setTimeout(res, 5));
    accept(integ(dir));
    assert.strictEqual(dom06.aggregateImplement(dir, PV, [K1]).ok, true);
});

test('AC-07: latestBound com intercalação A → B → A(retry) → integração', async () => {
    const dir = runDir();
    const a1 = sub(dir, K1);
    await new Promise(res => setTimeout(res, 3));
    const b1 = sub(dir, K2);
    await new Promise(res => setTimeout(res, 3));
    const a2 = dom06.prepareDispatch({ runDir: dir, node: 'implement', ticketId: 1, baseBranch: 'main', cause: 'retry', decomposition: { role: 'subtask', plan_version: PV, subtask_key: K1, workspace_baseline: COMPLETE('d0') } });
    assert.strictEqual(a2.attempt.parent_attempt_id, a1.attempt.attempt_id, 'retry de A encadeia A, não B');
    await new Promise(res => setTimeout(res, 3));
    const i1 = integ(dir);
    const b2 = dom06.prepareDispatch({ runDir: dir, node: 'implement', ticketId: 1, baseBranch: 'main', cause: 'retry', decomposition: { role: 'subtask', plan_version: PV, subtask_key: K2 } });
    assert.strictEqual(b2.attempt.parent_attempt_id, b1.attempt.attempt_id);
    assert.deepStrictEqual(b2.attempt.obligations.map(o => o.id), [`execute_subtask:${K2}`]);
    const i2 = dom06.prepareDispatch({ runDir: dir, node: 'implement', ticketId: 1, baseBranch: 'main', cause: 'retry', decomposition: { role: 'integration', plan_version: PV } });
    assert.strictEqual(i2.attempt.parent_attempt_id, i1.attempt.attempt_id, 'retry da integração nunca pega subtarefa');
    // Implement não decomposto (sem decomposition) nunca pega Attempt com papel.
    const asis = dom06.prepareDispatch({ runDir: dir, node: 'implement', ticketId: 1, baseBranch: 'main', state: { node: 'implement', retries: { implement: 1 } } });
    assert.strictEqual(asis.attempt.cause, 'retry');
    assert.ok(!('parent_attempt_id' in asis.attempt));
    assert.deepStrictEqual(asis.attempt.obligations.map(o => o.id), ['execute_node']);
});

test('AC-08: resultado tardio — sem mutação só registra; com mutação bloqueia; obrigação nunca cumprida', () => {
    const dir = runDir();
    for (const [post, block] of [['d0', false], ['d9', true]]) {
        const b = sub(dir, K1);
        const r = dom06.closeOnExit({ attemptFile: b.attemptFile, attemptId: b.attempt.attempt_id, node: 'implement', code: 0, claim: 'RELEASED', manifestPost: COMPLETE(post), currentPlanVersion: PV2 });
        assert.deepStrictEqual([r.accepted, r.reason, r.block], [false, 'PLAN_SUPERSEDED', block]);
        assert.strictEqual(dom06.readAttempt(b.attemptFile).obligations[0].status, 'pending');
    }
});

test('AC-09: releaseNodeWithReason distingue os motivos; releaseNode continua booleano', () => {
    const dir = runDir();
    fs.mkdirSync(dir, { recursive: true });
    const put = s => fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ task_id: 't', node: 'implement', history: [], retries: {}, ...s }));
    const lease = { dir, startedAt: '2026-11-09T10:00:00.000Z' };
    put({ status: 'running', node_started_at: lease.startedAt });
    assert.strictEqual(nodeLease.releaseNodeWithReason(lease), 'RELEASED');
    put({ status: 'spec-change-pending-approval', node_started_at: lease.startedAt });
    assert.strictEqual(nodeLease.releaseNodeWithReason(lease), 'STATUS_CHANGED');
    put({ status: 'running', node_started_at: '2026-11-09T11:00:00.000Z' });
    assert.strictEqual(nodeLease.releaseNodeWithReason(lease), 'LEASE_REPLACED');
    put({ status: 'running', node_started_at: lease.startedAt, execution_id: 'outra-sessao' });
    assert.strictEqual(nodeLease.releaseNodeWithReason({ ...lease, executionId: 'minha-sessao' }), 'SESSION_CONFLICT');
    assert.strictEqual(nodeLease.releaseNodeWithReason({ dir: path.join(tmpRoot, 'sumiu'), startedAt: 'x' }), 'STATE_MISSING');
    put({ status: 'running', node_started_at: lease.startedAt });
    assert.strictEqual(nodeLease.releaseNode(lease), true);
    assert.strictEqual(nodeLease.releaseNode(lease), false);
});

test('AC-09: closeOnExit dá o mesmo resultado pelo wrapper destacado (node-lease.js release) e chamado direto', () => {
    const viaCli = (attemptFile, attemptId, lease, code) => execFileSync(process.execPath, [
        path.join(__dirname, 'node-lease.js'), 'release', JSON.stringify({ ...lease, dom06AttemptFile: attemptFile, dom06AttemptId: attemptId, node: 'implement' }), String(code),
    ], { encoding: 'utf8', env: { PATH: process.env.PATH } });
    const strip = a => { const { decided_at: _d, ...rest } = a.acceptance; return rest; };
    // Attempt com papel: sem versão vigente nos dois caminhos (S5.1) → não aceito, bloqueia.
    const dir1 = runDir();
    fs.mkdirSync(dir1, { recursive: true });
    fs.writeFileSync(path.join(dir1, 'state.json'), JSON.stringify({ task_id: 't', node: 'implement', history: [], retries: {}, status: 'running', node_started_at: 'L' }));
    const b1 = sub(dir1, K1);
    viaCli(b1.attemptFile, b1.attempt.attempt_id, { dir: dir1, startedAt: 'L' }, 0);
    const b2 = sub(dir1, K2);
    dom06.closeOnExit({ attemptFile: b2.attemptFile, attemptId: b2.attempt.attempt_id, node: 'implement', code: 0, claim: 'RELEASED' });
    const r1 = strip(dom06.readAttempt(b1.attemptFile));
    const r2 = strip(dom06.readAttempt(b2.attemptFile));
    assert.deepStrictEqual(r1, r2, 'mesmo resultado pelos dois caminhos');
    assert.strictEqual(r1.reason, 'PLAN_VERSION_UNKNOWN', 'S5.1: sem versão vigente nos dois caminhos (fail-closed; S5.2 liga o post)');
    // Attempt AS-IS (sem papel): exit 0 cumpre execute_node como sempre, pelos dois caminhos.
    const asis = dom06.beginAttempt(dir1, { node: 'review', admission: ADMITTED, obligations: dom06.obligationsFor('review') });
    viaCli(asis.attemptFile, asis.attempt.attempt_id, { dir: dir1, startedAt: 'L' }, 0);
    assert.strictEqual(dom06.readAttempt(asis.attemptFile).obligations[0].status, 'fulfilled');
    const asis2 = dom06.beginAttempt(dir1, { node: 'review', admission: ADMITTED, obligations: dom06.obligationsFor('review') });
    assert.strictEqual(dom06.closeOnExit({ attemptFile: asis2.attemptFile, attemptId: asis2.attempt.attempt_id, node: 'review', code: 0, claim: null }), true);
    assert.ok(!('acceptance' in dom06.readAttempt(asis2.attemptFile)));
    // O watcher (--follow) usa a mesma saída única.
    const watcherSrc = fs.readFileSync(path.join(__dirname, '..', 'readmine-watcher.js'), 'utf8');
    assert.match(watcherSrc, /claim = nodeLease\.releaseNodeWithReason\(lease\)/);
    assert.match(watcherSrc, /dom06\.closeOnExit\(\{[\s\S]{0,300}claim,/);
});

test('gate: closeOnExit cumpre execute_node por exit 0 e grava o post; post UNKNOWN não muda o veredito', () => {
    const dir = runDir();
    const g = dom06.beginAttempt(dir, { node: 'test', admission: ADMITTED, obligations: dom06.obligationsFor('test'), decomposition: { role: 'gate', workspace_baseline: COMPLETE('d1') } });
    const r = dom06.closeOnExit({ attemptFile: g.attemptFile, attemptId: g.attempt.attempt_id, node: 'test', code: 0, claim: 'RELEASED' });
    assert.deepStrictEqual(r, { gate: true, fulfilled: true });
    const after = dom06.readAttempt(g.attemptFile);
    assert.strictEqual(after.obligations[0].status, 'fulfilled');
    assert.strictEqual(after.workspace.post.completeness, 'UNKNOWN');
});

test('AC-10: órfão fechado UNCERTAIN, manifesto corrente comparado ao baseline, sem cumprir obrigação', () => {
    const dir = runDir();
    const same = sub(dir, K1);
    assert.deepStrictEqual([dom06.closeOrphan(same.attemptFile, { manifestNow: COMPLETE('d0') }).block, dom06.readAttempt(same.attemptFile).result], [false, 'UNCERTAIN']);
    const mut = sub(dir, K2);
    const r = dom06.closeOrphan(mut.attemptFile, { manifestNow: COMPLETE('d5') });
    assert.deepStrictEqual([r.reason, r.block], ['ORPHAN_UNCERTAIN', true]);
    assert.strictEqual(dom06.readAttempt(mut.attemptFile).obligations[0].status, 'pending');
});

test('AC-11: nenhum Attempt com causa escalation, nem com decomposição', () => {
    assert.throws(() => dom06.beginAttempt(runDir(), { node: 'implement', cause: 'escalation', admission: ADMITTED, decomposition: { role: 'subtask', plan_version: PV, subtask_key: K1 } }), /ESCALATION_CAUSE_RESERVED/);
    assert.throws(() => dom06.prepareDispatch({ runDir: runDir(), node: 'implement', ticketId: 1, baseBranch: 'main', cause: 'escalation', decomposition: { role: 'subtask', plan_version: PV, subtask_key: K1 } }), /ESCALATION_CAUSE_RESERVED/);
});

test('C-A-01: agregação por visita — rework depois da agregação exige nova integração e nova agregação', () => {
    const dir = runDir();
    accept(sub(dir, K1));
    const i1 = integ(dir);
    accept(i1);
    assert.deepStrictEqual([dom06.aggregateImplement(dir, PV, [K1]).ok, dom06.aggregateImplement(dir, PV, [K1]).duplicate], [true, true]);
    // Review reprova: rework de K1 na mesma plan_version.
    const rw = sub(dir, K1, { rework: true });
    assert.deepStrictEqual(dom06.aggregateImplement(dir, PV, [K1]).pending, [K1, `integrate:${PV}`], 'agregação velha não vale');
    accept(rw);
    assert.deepStrictEqual(dom06.aggregateImplement(dir, PV, [K1]).pending, [`integrate:${PV}`]);
    const i2 = integ(dir);
    accept(i2);
    const r = dom06.aggregateImplement(dir, PV, [K1]);
    assert.deepStrictEqual([r.ok, r.duplicate, r.attempt_id], [true, false, i2.attempt.attempt_id]);
});

test('C-O-04: ordem por seq monotônico, não por created_at (empate de ms não favorece a integração)', () => {
    const dir = runDir();
    accept(sub(dir, K1));
    const i1 = integ(dir);
    accept(i1);
    const rw = sub(dir, K1, { rework: true });
    accept(rw);
    // Força o mesmo created_at nos três: só o seq decide.
    for (const f of [i1.attemptFile, rw.attemptFile]) {
        const a = JSON.parse(fs.readFileSync(f, 'utf8'));
        a.created_at = '2026-11-09T12:00:00.000Z';
        fs.writeFileSync(f, JSON.stringify(a));
    }
    assert.ok(dom06.readAttempt(rw.attemptFile).seq > dom06.readAttempt(i1.attemptFile).seq);
    assert.deepStrictEqual(dom06.aggregateImplement(dir, PV, [K1]).pending, [`integrate:${PV}`]);
});

test('AC-20 (C-A-02): teto — 2ª falha operacional sem mutação da mesma chave bloqueia; vale para o órfão', () => {
    const dir = runDir();
    const a1 = sub(dir, K1);
    const f1 = dom06.closeOnExit({ attemptFile: a1.attemptFile, attemptId: a1.attempt.attempt_id, node: 'implement', code: 1, claim: 'RELEASED', manifestPost: COMPLETE('d0'), currentPlanVersion: PV });
    assert.deepStrictEqual([f1.reason, f1.retry_allowed, f1.block], ['OPERATIONAL_FAILURE', true, false]);
    const a2 = dom06.prepareDispatch({ runDir: dir, node: 'implement', ticketId: 1, baseBranch: 'main', cause: 'retry', decomposition: { role: 'subtask', plan_version: PV, subtask_key: K1, workspace_baseline: COMPLETE('d0') } });
    const f2 = dom06.closeOnExit({ attemptFile: a2.attemptFile, attemptId: a2.attempt.attempt_id, node: 'implement', code: 1, claim: 'RELEASED', manifestPost: COMPLETE('d0'), currentPlanVersion: PV });
    assert.deepStrictEqual([f2.reason, f2.retry_allowed, f2.block], ['RETRY_CEILING', false, true]);
    // Órfão sem mutação permite um retry; a falha do retry bate no teto.
    const o1 = sub(dir, K2);
    assert.strictEqual(dom06.closeOrphan(o1.attemptFile, { manifestNow: COMPLETE('d0') }).retry_allowed, true);
    const o2 = dom06.prepareDispatch({ runDir: dir, node: 'implement', ticketId: 1, baseBranch: 'main', cause: 'retry', decomposition: { role: 'subtask', plan_version: PV, subtask_key: K2, workspace_baseline: COMPLETE('d0') } });
    assert.strictEqual(o2.attempt.parent_attempt_id, o1.attempt.attempt_id);
    const f3 = dom06.closeOnExit({ attemptFile: o2.attemptFile, attemptId: o2.attempt.attempt_id, node: 'implement', code: 1, claim: 'RELEASED', manifestPost: COMPLETE('d0'), currentPlanVersion: PV });
    assert.strictEqual(f3.reason, 'RETRY_CEILING');
});

test('C-O-03: aceite gravado sem a obrigação (queda no meio) é completado na chamada seguinte', () => {
    const dir = runDir();
    const b = sub(dir, K1);
    const a = JSON.parse(fs.readFileSync(b.attemptFile, 'utf8'));
    a.acceptance = { accepted: true, reason: null, block: false, no_change: false, retry_allowed: false, claim: 'RELEASED', exit_code: 0, decided_at: 'x' };
    fs.writeFileSync(b.attemptFile, JSON.stringify(a));
    assert.strictEqual(dom06.readAttempt(b.attemptFile).obligations[0].status, 'pending');
    assert.strictEqual(accept(b).duplicate, true);
    assert.strictEqual(dom06.readAttempt(b.attemptFile).obligations[0].status, 'fulfilled');
});

test('C-O-05/C-O-06: órfão não iniciado não é tocado; decomposition null = caminho AS-IS', () => {
    const dir = runDir();
    const denied = dom06.beginAttempt(dir, { node: 'implement', admission: { status: 'DENIED' }, decomposition: { role: 'subtask', plan_version: PV, subtask_key: K1 } });
    assert.strictEqual(dom06.closeOrphan(denied.attemptFile, { manifestNow: COMPLETE('d0') }), null);
    assert.strictEqual(dom06.readAttempt(denied.attemptFile).result, 'DENIED');
    const asis = dom06.beginAttempt(dir, { node: 'implement', admission: ADMITTED, obligations: dom06.obligationsFor('implement'), decomposition: null });
    assert.ok(!('role' in asis.attempt));
    const p = dom06.prepareDispatch({ runDir: dir, node: 'implement', ticketId: 1, baseBranch: 'main', state: { node: 'implement', retries: { implement: 1 } }, decomposition: null });
    assert.deepStrictEqual([p.attempt.cause, 'role' in p.attempt], ['retry', false]);
});

test('AC-19: chain_anchor é gravado no Attempt (reason, by, at)', () => {
    const anchor = { reason: 'HUMAN_UNBLOCK', by: 'human_input', at: '2026-11-09T12:00:00.000Z' };
    const b = sub(runDir(), K1, { chain_anchor: anchor });
    assert.deepStrictEqual(dom06.readAttempt(b.attemptFile).chain_anchor, anchor);
});

test('R2-C-O-02: teto pela linhagem — nova tentativa por timeout também bate no teto', () => {
    const dir = runDir();
    const a1 = sub(dir, K1);
    dom06.closeOnExit({ attemptFile: a1.attemptFile, attemptId: a1.attempt.attempt_id, node: 'implement', code: 1, claim: 'RELEASED', manifestPost: COMPLETE('d0'), currentPlanVersion: PV });
    const a2 = dom06.prepareDispatch({ runDir: dir, node: 'implement', ticketId: 1, baseBranch: 'main', cause: 'timeout', decomposition: { role: 'subtask', plan_version: PV, subtask_key: K1, workspace_baseline: COMPLETE('d0') } });
    assert.strictEqual(a2.attempt.parent_attempt_id, a1.attempt.attempt_id);
    const r = dom06.closeOnExit({ attemptFile: a2.attemptFile, attemptId: a2.attempt.attempt_id, node: 'implement', code: 1, claim: 'RELEASED', manifestPost: COMPLETE('d0'), currentPlanVersion: PV });
    assert.strictEqual(r.reason, 'RETRY_CEILING');
});
