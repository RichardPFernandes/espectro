// node --test state-version-api.test.js
// Cenário 10 da proteção de concorrência (docs/concurrency-map.md): o dashboard detecta
// que o run mudou ANTES do clique (GET /api/state/version + public/state-version.js) e,
// se a ação já foi enviada com a tela velha, responde 409 STATE_CONFLICT com a mensagem
// fixa — nunca 500 genérico. O resto dos cenários fica em scripts/state-concurrency.test.js.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createDashboard } = require('./server');
const StateVersion = require('./public/state-version');
const stateWriter = require('../scripts/state-writer');
const cas = require('../scripts/cas');

const SECRET = 'redmine-chave-secreta-state-version-789';
const tmpBase = process.env.CLAUDE_JOB_DIR ? path.join(process.env.CLAUDE_JOB_DIR, 'tmp') : os.tmpdir();
const tmp = fs.mkdtempSync(path.join(tmpBase, 'state-version-'));
const runs = path.join(tmp, 'memory', 'runs');

function seed(taskId, state) {
    return stateWriter.init(path.join(runs, taskId), {
        task_id: taskId, node: 'implement', history: ['plan'], status: 'in_progress', started_at: '2026-10-01T10:00:00Z', ...state,
    });
}
const runDir = taskId => path.join(runs, taskId);
const raw = taskId => fs.readFileSync(path.join(runDir(taskId), 'state.json'), 'utf8');

const dispatchCalls = [];
const logs = [];
const orig = { log: console.log, warn: console.warn, error: console.error };
let dash, base;
test.before(async () => {
    for (const k of ['log', 'warn', 'error']) console[k] = (...a) => { logs.push(a.join(' ')); };
    process.env.STATE_CONFLICTS_LOG = path.join(tmp, 'logs', 'state-conflicts.jsonl');
    process.env.REDMINE_API_KEY = SECRET;
    process.env.REDMINE_URL = 'http://127.0.0.1:9'; // nunca alcançado: o CAS recusa antes
    dash = createDashboard({
        memoryDir: runs, worktreesDir: path.join(tmp, 'wt'), prefsFile: path.join(tmp, 'prefs.json'),
        dispatchNode: async opts => { dispatchCalls.push(opts); return { action: 'dispatched' }; },
    });
    await new Promise(r => dash.server.listen(0, '127.0.0.1', r));
    base = `http://localhost:${dash.server.address().port}`;
    await dash.ready;
});
test.after(async () => {
    Object.assign(console, orig);
    await dash.close();
    for (const k of ['STATE_CONFLICTS_LOG', 'REDMINE_API_KEY', 'REDMINE_URL']) delete process.env[k];
    fs.rmSync(tmp, { recursive: true, force: true });
});

const getJson = async p => { const r = await fetch(base + p); return { status: r.status, body: await r.json() }; };
const post = async (p, body) => {
    const r = await fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const text = await r.text();
    return { status: r.status, text, body: JSON.parse(text) };
};

test('GET /api/state/version: só { state_version, node, execution_id }; id inválido 400, ausente 404', async () => {
    const s = seed('60001-versao', { pull_request: { 'app-back': { url: 'https://x' } }, human_inputs: [{ content: SECRET }] });
    const r = await getJson('/api/state/version?taskId=60001-versao');
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(r.body, { state_version: s.state_version, node: 'implement', execution_id: s.execution_id });
    assert.ok(!JSON.stringify(r.body).includes(SECRET));
    assert.strictEqual((await getJson('/api/state/version?taskId=../x')).status, 400);
    assert.strictEqual((await getJson('/api/state/version?taskId=69999-nao-existe')).status, 404);
});

test('10. polling detecta state_version desatualizado antes do clique — e não acusa campo secundário', async () => {
    seed('60002-polling');
    const loaded = (await getJson('/api/runs/60002-polling')).body; // o que a tela carregou
    assert.ok(Number.isInteger(loaded.stateVersion));
    assert.strictEqual(loaded.casToken.expected_state_version, loaded.stateVersion);

    const seen = [];
    const timers = { setInterval: () => 1, clearInterval: () => {} }; // checagens disparadas à mão
    const poller = StateVersion.createPoller({
        fetchVersion: async id => (await getJson(`/api/state/version?taskId=${id}`)).body,
        current: () => loaded, onChange: stale => seen.push(stale), timers,
    });
    poller.start();
    assert.strictEqual(await poller.check(), false);

    stateWriter.update(runDir('60002-polling'), s => { s.updated_at = new Date().toISOString(); s.events = [{ type: 'heartbeat' }]; });
    assert.strictEqual(await poller.check(), false, 'heartbeat não deixa a tela velha');

    stateWriter.update(runDir('60002-polling'), s => { s.node = 'review'; }); // watcher/agente avançou
    assert.strictEqual(await poller.check(), true, 'banner antes do clique');
    assert.deepStrictEqual(seen, [false, false, true]);
    poller.stop();
    assert.strictEqual(StateVersion.INTERVAL_MS, 5000);
});

test('ação com a tela velha → 409 STATE_CONFLICT com a mensagem fixa; nada aplicado, nada despachado', async () => {
    seed('60003-resume', { status: 'session_limit', session_interrupted: true, issue_id: 60003 });
    const screen = (await getJson('/api/runs/60003-resume')).body.casToken;
    stateWriter.update(runDir('60003-resume'), s => { s.retries = { review: 1 }; }); // mudou depois da tela
    const before = raw('60003-resume');
    const r = await post('/api/runs/60003-resume/resume-session', { ...screen, operation_id: StateVersion.newOperationId() });
    assert.strictEqual(r.status, 409, r.text);
    assert.strictEqual(r.body.code, cas.STATE_CONFLICT);
    assert.strictEqual(r.body.error, StateVersion.MESSAGE);
    assert.ok(StateVersion.isConflict(r.status, r.body));
    assert.strictEqual(raw('60003-resume'), before);
    assert.strictEqual(dispatchCalls.length, 0);

    // Tela atualizada: a retomada passa e o execution_id gira (sessão antiga perde a posse).
    const fresh = (await getJson('/api/runs/60003-resume')).body.casToken;
    const ok = await post('/api/runs/60003-resume/resume-session', { ...fresh, operation_id: StateVersion.newOperationId() });
    assert.strictEqual(ok.status, 200, ok.text);
    const after = JSON.parse(raw('60003-resume'));
    assert.strictEqual(after.status, 'in_progress');
    assert.notStrictEqual(after.execution_id, fresh.execution_id);
    assert.strictEqual(dispatchCalls.length, 1);
});

test('archive com execution_id de outra sessão → 409 SESSION_CONFLICT; com a tela atual, arquiva', async () => {
    const s = seed('60004-arquivar', { status: 'committed', node: 'commit' });
    const screen = (await getJson('/api/runs/60004-arquivar')).body.casToken;
    const stale = await post('/api/runs/60004-arquivar/archive', { ...screen, execution_id: 'outra-sessao-0000', force: true });
    assert.strictEqual(stale.status, 409, stale.text);
    assert.strictEqual(stale.body.code, cas.SESSION_CONFLICT);
    assert.strictEqual(stale.body.error, StateVersion.MESSAGE);
    assert.ok(fs.existsSync(runDir('60004-arquivar')), 'não moveu');
    const ok = await post('/api/runs/60004-arquivar/archive', { ...screen, force: true });
    assert.strictEqual(ok.status, 200, ok.text);
    const archived = path.join(runs, '_archive', '60004-arquivar');
    assert.strictEqual(JSON.parse(fs.readFileSync(path.join(archived, 'state.json'), 'utf8')).execution_id, s.execution_id);
    assert.ok(!fs.readdirSync(archived).some(f => /\.lock$|\.tmp$/.test(f)), 'lock não vai junto');
});

test('aprovação de SPEC_CHANGE com spec_hash velho → 409 antes de postar no Redmine', async () => {
    seed('60005-spec', {
        status: 'spec-change-pending-approval', redmine_ticket: { id: 60005 }, spec_hash: 'a'.repeat(64),
        spec_change_pending: { id: 'SC-001', posted_at: '2026-10-01T10:00:00Z', spec_hash: 'a'.repeat(64) },
    });
    const screen = (await getJson('/api/runs/60005-spec')).body.casToken;
    stateWriter.update(runDir('60005-spec'), s => { s.spec_hash = 'b'.repeat(64); }); // spec mudou depois da tela
    const r = await post('/api/redmine/comment', { taskId: '60005-spec', action: 'approve', ...screen, operation_id: StateVersion.newOperationId() });
    assert.strictEqual(r.status, 409, r.text);
    assert.strictEqual(r.body.code, cas.STATE_CONFLICT);
    assert.ok(r.body.conflicts.some(c => c.field === 'spec_hash' && c.expected === 'aaaaaaaa'), 'hash só com 8 chars na resposta');
    assert.ok(!r.text.includes('a'.repeat(9)) && !r.text.includes(SECRET));
    const log = fs.readFileSync(process.env.STATE_CONFLICTS_LOG, 'utf8');
    assert.ok(!log.includes(SECRET) && !log.includes('b'.repeat(9)));
});
