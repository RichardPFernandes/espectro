// node --test watcher-api.test.js
// /api/watcher/* contra um watcher falso (script sintético), sem o readmine-watcher.js real.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { createWatcherManager } = require('../scripts/watcher-manager');
const { createDashboard } = require('./server');

const tmpBase = process.env.CLAUDE_JOB_DIR ? path.join(process.env.CLAUDE_JOB_DIR, 'tmp') : os.tmpdir();
const tmp = fs.mkdtempSync(path.join(tmpBase, 'watcher-api-'));
fs.mkdirSync(path.join(tmp, 'memory', 'runs'), { recursive: true });
const script = path.join(tmp, 'fake-watcher.js');
fs.writeFileSync(script, `console.log('Polling Redmine... token ' + process.env.BITBUCKET_API_TOKEN);`);
process.env.BITBUCKET_API_TOKEN = 'api-test-token-secreto';

const watcherManager = createWatcherManager({
    script, cwd: tmp, pidFile: path.join(tmp, 'watcher.pid'), historyFile: null, envFile: null,
    intervalMs: 150, restartDelayMs: 50, stopGraceMs: 500,
});
const prefsFile = path.join(tmp, 'dashboard-prefs.json');
const dash = createDashboard({ memoryDir: path.join(tmp, 'memory', 'runs'), worktreesDir: path.join(tmp, 'wt'), watcherManager, prefsFile });
let base;

test.before(async () => {
    await new Promise(r => dash.server.listen(0, '127.0.0.1', r));
    base = `http://localhost:${dash.server.address().port}`;
    await dash.ready;
});
test.after(async () => {
    await watcherManager.stop();
    await dash.close();
    fs.rmSync(tmp, { recursive: true, force: true });
});

async function call(method, p, body) {
    const res = await fetch(base + p, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body && JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
}

// Lê eventos SSE até `done(events)` dar true.
function sse(p, done, ms = 5000) {
    return new Promise((resolve, reject) => {
        const events = [];
        const req = http.get(base + p, res => {
            assert.match(res.headers['content-type'], /^text\/event-stream/);
            let buf = '';
            res.setEncoding('utf8');
            res.on('data', chunk => {
                buf += chunk;
                let i;
                while ((i = buf.indexOf('\n\n')) !== -1) {
                    const raw = buf.slice(0, i); buf = buf.slice(i + 2);
                    const ev = { event: 'message', data: null };
                    for (const line of raw.split('\n')) {
                        if (line.startsWith('event: ')) ev.event = line.slice(7);
                        else if (line.startsWith('data: ')) ev.data = JSON.parse(line.slice(6));
                    }
                    if (ev.data) events.push(ev);
                }
                if (done(events)) { req.destroy(); clearTimeout(t); resolve(events); }
            });
        });
        req.on('error', e => { if (e.code !== 'ECONNRESET') reject(e); });
        const t = setTimeout(() => { req.destroy(); reject(new Error(`timeout SSE: ${JSON.stringify(events)}`)); }, ms);
    });
}

test('status começa parado — o server não inicia o watcher sozinho', async () => {
    const { status, body } = await call('GET', '/api/watcher/status');
    assert.strictEqual(status, 200);
    assert.strictEqual(body.running, false);
    assert.strictEqual(body.pid, null);
    assert.strictEqual(body.restarts, 0);
});

test('start → log chega por SSE (redigido) → stop', async () => {
    const started = await call('POST', '/api/watcher/start');
    assert.strictEqual(started.body.running, true);
    const events = await sse('/api/watcher/log-stream', evs => evs.filter(e => e.event === 'message' && /Polling/.test(e.data.text)).length >= 2);
    assert.strictEqual(events[0].event, 'hello');
    const line = events.find(e => /Polling/.test(e.data?.text));
    assert.strictEqual(line.data.text, 'Polling Redmine... token [REDACTED]');
    assert.ok(!JSON.stringify(events).includes('api-test-token-secreto'));

    const restarted = await call('POST', '/api/watcher/restart');
    assert.strictEqual(restarted.body.running, true);
    const stopped = await call('POST', '/api/watcher/stop');
    assert.strictEqual(stopped.body.running, false);
    assert.strictEqual(stopped.body.state, 'stopped');
});

test('nova conexão SSE recebe o buffer inteiro primeiro', async () => {
    const n = watcherManager.getLogBuffer().length;
    const events = await sse('/api/watcher/log-stream', evs => evs.filter(e => e.event === 'message').length >= n);
    const seqs = events.filter(e => e.event === 'message').map(e => e.data.seq);
    assert.deepStrictEqual(seqs, watcherManager.getLogBuffer().map(e => e.seq));
});

test('prefs de auto-start: default false, PUT valida e persiste', async () => {
    assert.deepStrictEqual((await call('GET', '/api/watcher/prefs')).body, { auto_start: false });
    assert.strictEqual((await call('PUT', '/api/watcher/prefs', { auto_start: 'sim' })).status, 400);
    assert.strictEqual((await call('PUT', '/api/watcher/prefs', { auto_start: true })).body.auto_start, true);
    assert.strictEqual(JSON.parse(fs.readFileSync(prefsFile, 'utf8')).auto_start, true);
    assert.strictEqual(dash.readPrefs().auto_start, true);
});

test('endpoints do watcher recusam Host/Origin de fora', async () => {
    const port = dash.server.address().port;
    for (const [method, p, headers] of [
        ['POST', '/api/watcher/start', { Host: 'evil.example' }],
        ['POST', '/api/watcher/stop', { Origin: 'http://evil.example' }],
        ['GET', '/api/watcher/log-stream', { Host: 'evil.example' }],
        ['GET', '/api/watcher/status', { Origin: 'http://evil.example' }],
    ]) {
        const status = await new Promise((resolve, reject) => {
            const req = http.request({ host: '127.0.0.1', port, method, path: p, headers }, res => { res.resume(); resolve(res.statusCode); });
            req.on('error', reject);
            req.end();
        });
        assert.strictEqual(status, 403, `${method} ${p}`);
    }
    assert.strictEqual(watcherManager.status().running, false);
});
