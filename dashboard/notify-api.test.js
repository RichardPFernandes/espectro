// node --test notify-api.test.js
// GET /api/notify/status e POST /api/notify/test (botão "Testar Notificação") contra um
// webhook HTTP local — a resposta traz o status HTTP e nunca a URL.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { createDashboard } = require('./server');

const tmpBase = process.env.CLAUDE_JOB_DIR ? path.join(process.env.CLAUDE_JOB_DIR, 'tmp') : os.tmpdir();
const tmp = fs.mkdtempSync(path.join(tmpBase, 'notify-api-'));
fs.mkdirSync(path.join(tmp, 'memory', 'runs'), { recursive: true });

const watcherManager = {
    status: () => ({ state: 'stopped', running: false }),
    start: async () => ({}), stop: async () => ({}), restart: async () => ({}),
    getLogBuffer: () => [], onLine: () => () => {},
};
const received = [];
let hookStatus = 200;
const hook = http.createServer((req, res) => {
    let b = ''; req.on('data', c => { b += c; }); req.on('end', () => { received.push(JSON.parse(b)); res.statusCode = hookStatus; res.end(); });
});
const prevEnv = process.env.NOTIFY_WEBHOOK_URL;
const dash = createDashboard({
    memoryDir: path.join(tmp, 'memory', 'runs'), worktreesDir: path.join(tmp, 'wt'), watcherManager,
    prefsFile: path.join(tmp, 'prefs.json'), healthCheck: async () => ({}),
});
let base, hookUrl;
test.before(async () => {
    await new Promise(r => hook.listen(0, '127.0.0.1', r));
    hookUrl = `http://127.0.0.1:${hook.address().port}/services/T0KEN-SECRETO`;
    await new Promise(r => dash.server.listen(0, '127.0.0.1', r));
    base = `http://localhost:${dash.server.address().port}`;
    await dash.ready;
});
test.after(async () => {
    if (prevEnv === undefined) delete process.env.NOTIFY_WEBHOOK_URL; else process.env.NOTIFY_WEBHOOK_URL = prevEnv;
    await dash.close(); hook.close(); fs.rmSync(tmp, { recursive: true, force: true });
});
const post = async () => { const r = await fetch(`${base}/api/notify/test`, { method: 'POST' }); return { status: r.status, body: await r.json() }; };

test('sem NOTIFY_WEBHOOK_URL: status desligado e teste não envia nada', async () => {
    delete process.env.NOTIFY_WEBHOOK_URL;
    const st = await (await fetch(`${base}/api/notify/status`)).json();
    assert.deepStrictEqual(st, { configured: false, host: null });
    const { status, body } = await post();
    assert.strictEqual(status, 200);
    assert.strictEqual(body.configured, false);
    assert.strictEqual(body.sent, false);
    assert.strictEqual(received.length, 0);
});

test('configurado: envia payload Slack dummy e devolve o HTTP, sem vazar a URL', async () => {
    process.env.NOTIFY_WEBHOOK_URL = hookUrl;
    hookStatus = 200;
    const st = await (await fetch(`${base}/api/notify/status`)).json();
    assert.strictEqual(st.configured, true);
    assert.strictEqual(st.host, new URL(hookUrl).host);
    const { body } = await post();
    assert.strictEqual(body.sent, true);
    assert.strictEqual(body.status, 200);
    assert.strictEqual(received.length, 1);
    assert.ok(Array.isArray(received[0].attachments));
    assert.ok(!JSON.stringify(body).includes('T0KEN') && !JSON.stringify(st).includes('T0KEN'));
});

test('webhook responde 500: 200 no dashboard com status 500 e sent=false', async () => {
    process.env.NOTIFY_WEBHOOK_URL = hookUrl;
    hookStatus = 500;
    const { status, body } = await post();
    assert.strictEqual(status, 200);
    assert.strictEqual(body.status, 500);
    assert.strictEqual(body.sent, false);
});
