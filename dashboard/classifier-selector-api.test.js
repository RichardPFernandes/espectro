// node --test classifier-selector-api.test.js
// PRI-205 S3b T12: API do seletor "Só policy" × "Policy + Jev" (SPEC §B11, AC-19).
// GET mostra o estado e as opções com o código de recusa previsto; POST passa pelo
// aprovador autenticado e pelo writer governado (classifier-selection). Consumidor
// sintético; aprovadores em diretório temporário injetado por código.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { createDashboard } = require('./server');
const approvers = require('../scripts/lib/approvers');
const prismaConfig = require('../scripts/lib/prisma-config');
const selection = require('../scripts/lib/classifier-selection');

const APPROVER_PW = 'senha-aprovador-SELETOR-77';
const CRED = { approver: 'richard', approver_password: APPROVER_PW };
const tmpBase = process.env.CLAUDE_JOB_DIR ? path.join(process.env.CLAUDE_JOB_DIR, 'tmp') : os.tmpdir();
const tmp = fs.mkdtempSync(path.join(tmpBase, 'classifier-selector-api-'));
const repo = path.join(tmp, 'app-back');
const runs = path.join(repo, 'memory', 'runs');
fs.mkdirSync(path.join(repo, '.claude'), { recursive: true });
fs.mkdirSync(runs, { recursive: true });

// Roteamento ON com a p1 sintética (cheap_rule): sem registro, vale a policy.
const policy = {
    id: 'routing-sintetica', version: 'p-test-1', mode: 'ROUTED', classifier: { provider: 'cheap_rule' },
    class_to_tier: {
        C1: { tier: 'T1', effort: 'baixo' }, C2: { tier: 'T2', effort: 'médio' }, C3: { tier: 'T3', effort: 'alto' },
        C4: { tier: 'T3', effort: 'alto' }, C5: { tier: 'T3', effort: 'máximo' },
    },
    tiers: { T1: { models: ['m-t1'] }, T2: { models: ['m-t2'] }, T3: { models: ['m-t3'] } },
    default_route: { model_id: 'm-t3', effort: 'alto' },
    effort_map: { baixo: 'low', 'médio': 'medium', alto: 'high', 'máximo': 'max' },
};
const policyBytes = Buffer.from(JSON.stringify(policy));
fs.writeFileSync(path.join(repo, '.claude', 'routing-policy.json'), policyBytes);
fs.writeFileSync(path.join(repo, '.claude', 'model-routing.json'), JSON.stringify({
    mode: 'ON',
    policy_ref: { id: policy.id, version: policy.version, sha256: crypto.createHash('sha256').update(policyBytes).digest('hex'), path: '.claude/routing-policy.json' },
    classifier_credential: { keychain: 'prisma-jev-typesafe', account: 'typesafe' },
}));

const CONFIG = path.join(tmp, 'config-prisma');
prismaConfig.writeSecureJson('approvers.json', { richard: approvers.hashPassword(APPROVER_PW) }, { dir: CONFIG });

let dash, base;
const logs = [];
const orig = { log: console.log, warn: console.warn, error: console.error };
test.before(async () => {
    for (const k of ['log', 'warn', 'error']) console[k] = (...a) => { logs.push(a.join(' ')); };
    dash = createDashboard({ env: { ...process.env }, repoRoot: repo, memoryDir: runs, worktreesDir: path.join(tmp, 'wt'), prefsFile: path.join(tmp, 'prefs.json'), prismaConfigDir: CONFIG });
    await new Promise(r => dash.server.listen(0, '127.0.0.1', r));
    base = `http://localhost:${dash.server.address().port}`;
    await dash.ready;
});
test.after(async () => {
    Object.assign(console, orig);
    await dash.close();
    fs.rmSync(tmp, { recursive: true, force: true });
});

const responses = [];
const get = async p => { const r = await fetch(base + p); const t = await r.text(); responses.push(t); return { status: r.status, body: JSON.parse(t) }; };
const post = async (p, body = {}) => {
    const r = await fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const t = await r.text();
    responses.push(t);
    return { status: r.status, body: JSON.parse(t) };
};
test.after(() => {
    assert.ok(!responses.join('\n').includes(APPROVER_PW), 'senha do aprovador vazou em resposta');
    assert.ok(!logs.join('\n').includes(APPROVER_PW), 'senha do aprovador vazou no log');
});

test('GET sem registro: versão 0, origem POLICY, opções com o código de recusa previsto (AC-19)', async () => {
    const { status, body } = await get('/api/routing/classifier');
    assert.strictEqual(status, 200);
    assert.strictEqual(body.project, 'app-back');
    assert.strictEqual(body.routing_mode, 'ON');
    assert.deepStrictEqual(body.current, { version: 0, choice: null, provider: 'cheap_rule', mode: null, source: 'POLICY', by: null, at: null, reason: null });
    assert.deepStrictEqual(body.options[0], { choice: 'policy_only', allowed: true, refusal: null, detail: null });
    assert.deepStrictEqual(body.options[1].modes.shadow, { allowed: false, refusal: 'CLASSIFIER_SCOPE_NOT_AUTHORIZED', detail: 'AUTHORITY_REF_ABSENT' });
    assert.deepStrictEqual(body.history, []);
    assert.strictEqual(body.registry_git_ignored, false);
});

test('POST sem aprovador: autoria = usuário local do sistema; approver no corpo é ignorado (Q14 revista pelo Richard)', async () => {
    const r = await post('/api/routing/classifier', { choice: 'policy_only', expected_version: 0, operation_id: 'op-sel-actor-1', reason: 'x', approver: 'intruso' });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.current.by, os.userInfo().username || 'dashboard-local');
    assert.notStrictEqual(r.body.current.by, 'intruso');
});

test('POST "Só policy" aplica; repetir o mesmo operation_id devolve already_processed; o GET mostra a versão nova', async () => {
    const body = { choice: 'policy_only', expected_version: 1, operation_id: 'op-sel-ok-0001', reason: 'só núcleo 1' };
    const ok = await post('/api/routing/classifier', body);
    assert.strictEqual(ok.status, 200);
    assert.deepStrictEqual([ok.body.ok, ok.body.status, ok.body.current.version, ok.body.current.choice, ok.body.current.provider, ok.body.current.by], [true, 'applied', 2, 'policy_only', 'off', os.userInfo().username || 'dashboard-local']);
    const again = await post('/api/routing/classifier', body);
    assert.deepStrictEqual([again.status, again.body.status, again.body.current.version], [200, 'already_processed', 2]);
    const state = await get('/api/routing/classifier');
    assert.deepStrictEqual([state.body.current.version, state.body.current.source, state.body.history.length], [2, 'SELECTION', 2]);
    assert.deepStrictEqual(Object.keys(state.body.history[0]).sort(), ['at', 'by', 'choice', 'mode', 'reason', 'version']);
});

test('POST recusas com código: 409 versão velha, 409 operation_id reaproveitado, 422 jev sem ref, 422 active, 400 pedido inválido', async () => {
    const cur = (await get('/api/routing/classifier')).body.current.version;
    const stale = await post('/api/routing/classifier', { choice: 'policy_only', expected_version: cur + 5, operation_id: 'op-sel-stale-1', reason: 'x' });
    assert.deepStrictEqual([stale.status, stale.body.ok, stale.body.code], [409, false, 'CLASSIFIER_VERSION_CONFLICT']);
    const reuse = await post('/api/routing/classifier', { choice: 'policy_only', expected_version: cur, operation_id: 'op-sel-ok-0001', reason: 'outro' });
    assert.deepStrictEqual([reuse.status, reuse.body.code], [409, 'CLASSIFIER_IDEMPOTENCY_MISMATCH']);
    const jev = await post('/api/routing/classifier', { choice: 'policy_jev', expected_version: cur, operation_id: 'op-sel-jev-01', reason: 'ligar sombra' });
    assert.deepStrictEqual([jev.status, jev.body.code, jev.body.detail], [422, 'CLASSIFIER_SCOPE_NOT_AUTHORIZED', 'AUTHORITY_REF_ABSENT']);
    const bad = await post('/api/routing/classifier', { choice: 'jev_sozinho', expected_version: cur, operation_id: 'op-sel-bad-01', reason: 'x' });
    assert.deepStrictEqual([bad.status, bad.body.code], [400, 'CLASSIFIER_REQUEST_INVALID']);
    assert.strictEqual(selection.readSelection(repo).version, cur, 'nenhuma recusa grava');
});

test('POST "Policy + Jev" ativo com Authority Ref válida → 422 NOT_CALIBRATED; sombra aplica', async () => {
    const bytes = Buffer.from(JSON.stringify({
        id: 'ref-api', issued_by: 'Richard Fernandes', issued_at: '2026-10-26', source: ['PRI-205 D20'],
        destination: 'typesafe:/v1/systemone',
        envelope: { allow: ['step_text', 'ac_text', 'declared_paths'], never: ['code', 'customer_data', 'personal_data', 'secrets', 'credentials'] },
        scope: { projects: ['app-back'] }, valid_from: '2026-10-26T00:00:00.000Z', revoked_at: null,
    }));
    fs.writeFileSync(path.join(repo, '.claude', 'classifier-authority.json'), bytes);
    const cfgPath = path.join(repo, '.claude', 'model-routing.json');
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    cfg.authority_ref = { id: 'ref-api', sha256: crypto.createHash('sha256').update(bytes).digest('hex'), path: '.claude/classifier-authority.json' };
    fs.writeFileSync(cfgPath, JSON.stringify(cfg));
    const state = (await get('/api/routing/classifier')).body;
    assert.deepStrictEqual(state.options[1].modes, {
        shadow: { allowed: true, refusal: null, detail: null },
        active: { allowed: false, refusal: 'CLASSIFIER_NOT_CALIBRATED', detail: null },
    });
    const cur = state.current.version;
    const active = await post('/api/routing/classifier', { choice: 'policy_jev', mode: 'active', expected_version: cur, operation_id: 'op-sel-act-01', reason: 'ativo' });
    assert.deepStrictEqual([active.status, active.body.code], [422, 'CLASSIFIER_NOT_CALIBRATED']);
    const shadow = await post('/api/routing/classifier', { choice: 'policy_jev', mode: 'shadow', expected_version: cur, operation_id: 'op-sel-sh-01', reason: 'sombra' });
    assert.deepStrictEqual([shadow.status, shadow.body.current.choice, shadow.body.current.provider, shadow.body.current.mode], [200, 'policy_jev', 'jev', 'shadow']);
});

test('GET com registro ilegível → origem INVALID com o motivo, nunca 500', async () => {
    const file = selection.registryPath(repo);
    const saved = fs.readFileSync(file, 'utf8');
    fs.writeFileSync(file, '{quebrado');
    try {
        const { status, body } = await get('/api/routing/classifier');
        assert.strictEqual(status, 200);
        assert.deepStrictEqual([body.current.source, body.current.reason, body.current.provider], ['INVALID', 'CLASSIFIER_SELECTION_INVALID', 'off']);
        const w = await post('/api/routing/classifier', { choice: 'policy_only', expected_version: 0, operation_id: 'op-sel-inv-01', reason: 'x' });
        assert.deepStrictEqual([w.status, w.body.code], [409, 'CLASSIFIER_SELECTION_INVALID']);
    } finally {
        fs.writeFileSync(file, saved);
    }
});
