// node --test watcher-health-api.test.js
// GET /api/watcher/health com health-check injetado (o real é coberto em
// scripts/lib/graceful-shutdown.test.js) e watcher manager falso.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createDashboard } = require('./server');

const tmpBase = process.env.CLAUDE_JOB_DIR ? path.join(process.env.CLAUDE_JOB_DIR, 'tmp') : os.tmpdir();
const tmp = fs.mkdtempSync(path.join(tmpBase, 'watcher-health-api-'));
fs.mkdirSync(path.join(tmp, 'memory', 'runs'), { recursive: true });

let mgrState = 'running';
let health = null;
let fail = null;
const watcherManager = {
    status: () => ({ state: mgrState, running: mgrState === 'running' }),
    start: async () => ({}), stop: async () => ({}), restart: async () => ({}),
    getLogBuffer: () => [], onLine: () => () => {},
};
const dash = createDashboard({
    memoryDir: path.join(tmp, 'memory', 'runs'), worktreesDir: path.join(tmp, 'wt'), watcherManager,
    prefsFile: path.join(tmp, 'prefs.json'),
    healthCheck: async () => { if (fail) throw fail; return JSON.parse(JSON.stringify(health)); },
});
let base;
test.before(async () => {
    await new Promise(r => dash.server.listen(0, '127.0.0.1', r));
    base = `http://localhost:${dash.server.address().port}`;
    await dash.ready;
});
test.after(async () => { await dash.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

const get = async () => { const r = await fetch(`${base}/api/watcher/health`); return { status: r.status, body: await r.json() }; };
const sample = extra => ({
    status: 'idle', uptimeSeconds: 120, activeCycle: null,
    lastCompletedCycle: { taskId: '1-a', completedAt: '2026-09-24T12:00:00Z', status: 'dispatched' },
    nextPollAt: '2026-09-24T12:01:00Z', healthy: true, issues: [], watcherPid: null, ...extra,
});

test('devolve o JSON do health-check com os campos do contrato', async () => {
    mgrState = 'running'; health = sample(); fail = null;
    const { status, body } = await get();
    assert.strictEqual(status, 200);
    for (const k of ['status', 'uptimeSeconds', 'activeCycle', 'lastCompletedCycle', 'nextPollAt']) assert.ok(k in body, `sem ${k}`);
    assert.strictEqual(body.nextPollAt, '2026-09-24T12:01:00Z');
    assert.strictEqual(body.uptimeSeconds, 120);
    assert.deepStrictEqual(body.manager, { state: 'running', running: true });
});

test('inconsistente continua 200 com healthy=false e issues', async () => {
    mgrState = 'running'; health = sample({ healthy: false, issues: ['x: órfão'] }); fail = null;
    const { status, body } = await get();
    assert.strictEqual(status, 200);
    assert.strictEqual(body.healthy, false);
    assert.deepStrictEqual(body.issues, ['x: órfão']);
});

test('laço do dashboard parado e nenhum watcher vivo: sem próxima poll nem uptime', async () => {
    mgrState = 'stopped'; health = sample(); fail = null;
    const { body } = await get();
    assert.strictEqual(body.nextPollAt, null);
    assert.strictEqual(body.uptimeSeconds, 0);
    assert.strictEqual(body.status, 'stopped');
    assert.strictEqual(body.healthy, true);
    assert.deepStrictEqual(body.issues, []);
});

test('laço parado com agente destacado ainda rodando: stopped, healthy=false e issue', async () => {
    mgrState = 'stopped'; fail = null;
    health = sample({ status: 'running', activeCycle: { taskId: '43590-a', node: 'implement', startedAt: '2026-09-24T12:00:00Z', source: 'agent' } });
    const { body } = await get();
    assert.strictEqual(body.status, 'stopped');
    assert.strictEqual(body.healthy, false);
    assert.match(body.issues[0], /laço do watcher parado com 43590-a \(implement\)/);
    assert.deepStrictEqual(body.activeCycle.source, 'agent');
});

test('laço rodando com agente destacado: mantém running/healthy', async () => {
    mgrState = 'running'; fail = null;
    health = sample({ status: 'running', activeCycle: { taskId: '43590-a', node: 'implement', source: 'agent' } });
    const { body } = await get();
    assert.deepStrictEqual([body.status, body.healthy, body.issues], ['running', true, []]);
});

test('health-check que falha vira 500 com mensagem', async () => {
    fail = new Error('boom');
    const { status, body } = await get();
    assert.strictEqual(status, 500);
    assert.match(body.error, /boom/);
    fail = null;
});
