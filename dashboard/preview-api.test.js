// node --test preview-api.test.js
// /api/preview/* contra um preview-manager com comandos falsos (node -e), sem mvn/java/grunt.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { createPreviewManager } = require('../scripts/preview-manager');
const { createDashboard } = require('./server');

const tmpBase = process.env.CLAUDE_JOB_DIR ? path.join(process.env.CLAUDE_JOB_DIR, 'tmp') : os.tmpdir();
const tmp = fs.mkdtempSync(path.join(tmpBase, 'preview-api-'));
fs.mkdirSync(path.join(tmp, 'memory', 'runs'), { recursive: true });
const wt = path.join(tmp, 'wt');
for (const d of ['4242/target/quarkus-app', '4242-app-front', '7777']) fs.mkdirSync(path.join(wt, d), { recursive: true });
fs.writeFileSync(path.join(wt, '4242/target/quarkus-app/quarkus-run.jar'), '');
fs.mkdirSync(path.join(wt, '7777/target/quarkus-app'), { recursive: true });
fs.writeFileSync(path.join(wt, '7777/target/quarkus-app/quarkus-run.jar'), '');

const node = code => ({ cmd: process.execPath, args: ['-e', code] });
const stay = 'setInterval(() => {}, 1000); process.on("SIGTERM", () => process.exit(0));';
const previewManager = createPreviewManager({
    repoRoot: tmp, adapter: 'maven-quarkus-grunt', profile: 'fixture', javaHome: '', worktreesDir: wt, envFile: null, checkPorts: false, stopGraceMs: 500, startupTimeoutMs: 5000, frontReadyMs: 5000,
    libRepos: {}, // nunca os ../mo-entity e ../app-core reais
    ports: { back: 8081, front: 9000 },
    commands: {
        build: () => node('console.log("[INFO] BUILD SUCCESS")'),
        back: () => node(`setTimeout(() => console.log("tms on JVM (powered by Quarkus) started in 0.4s. Listening on: http://0.0.0.0:8081"), 150); ${stay}`),
        front: () => node(`console.log("Waiting..."); ${stay}`),
    },
});
const dash = createDashboard({ memoryDir: path.join(tmp, 'memory', 'runs'), worktreesDir: wt, previewManager, prefsFile: path.join(tmp, 'prefs.json') });
let base;

test.before(async () => {
    await new Promise(r => dash.server.listen(0, '127.0.0.1', r));
    base = `http://localhost:${dash.server.address().port}`;
    await dash.ready;
});
test.after(async () => {
    await dash.close();
    fs.rmSync(tmp, { recursive: true, force: true });
});

async function call(method, p) {
    const res = await fetch(base + p, { method });
    return { status: res.status, body: await res.json() };
}

// Lê eventos SSE (event + data) até `done(events)` dar true.
function sse(p, done, ms = 8000) {
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
                    const block = buf.slice(0, i); buf = buf.slice(i + 2);
                    const type = (block.match(/^event: (.+)$/m) || [])[1] || 'message';
                    const data = (block.match(/^data: (.+)$/m) || [])[1];
                    if (data) events.push({ type, data: JSON.parse(data) });
                }
                if (done(events)) { clearTimeout(timer); req.destroy(); resolve(events); }
            });
        });
        const timer = setTimeout(() => { req.destroy(); reject(new Error(`SSE timeout: ${JSON.stringify(events.map(e => e.type === 'phase' ? e.data.phase : e.type))}`)); }, ms);
        req.on('error', e => { if (!req.destroyed) reject(e); });
    });
}

test('status idle traz worktrees detectados; sem worktree do back: start 404', async () => {
    const st = await call('GET', '/api/preview/4242/status');
    assert.strictEqual(st.status, 200);
    assert.strictEqual(st.body.phase, 'idle');
    assert.deepStrictEqual(st.body.worktrees, { back: true, moEntity: false, appCore: false, front: true });
    assert.deepStrictEqual(st.body.ports, { back: 8081, front: 9000 });

    const none = await call('POST', '/api/preview/1234/start');
    assert.strictEqual(none.status, 404);
    assert.strictEqual(none.body.error, 'worktree do app-back não encontrado para ticket 1234');
    assert.strictEqual((await call('GET', '/api/preview/1234/status')).body.worktrees.back, false);
});

test('ticket-id inválido → 400; Host de fora → 403', async () => {
    assert.strictEqual((await call('POST', '/api/preview/..%2F..%2Fetc/start')).status, 400);
    const res = await new Promise(resolve => http.request(`${base}/api/preview/4242/status`, { headers: { Host: 'evil.example.com' } }, resolve).end());
    assert.strictEqual(res.statusCode, 403);
    res.resume();
});

test('start 202 → SSE com log prefixado e fases até running → 409 pra outro ticket → stop 200 idle', async () => {
    const stream = sse('/api/preview/4242/log-stream', evs => evs.some(e => e.type === 'phase' && e.data.phase === 'running'));
    await new Promise(r => setTimeout(r, 100));
    const started = await call('POST', '/api/preview/4242/start');
    assert.strictEqual(started.status, 202);
    assert.strictEqual(started.body.phase, 'building-app-back');

    const events = await stream;
    const phases = events.filter(e => e.type === 'phase').map(e => e.data.phase);
    assert.deepStrictEqual([...new Set(phases)], ['idle', 'building-app-back', 'starting-back', 'starting-front', 'running']);
    const logs = events.filter(e => e.type === 'log').map(e => e.data.text);
    assert.ok(logs.includes('[build-back] [INFO] BUILD SUCCESS'), logs.join('\n'));
    assert.ok(logs.some(l => /^\[app-back\] .*started in 0\.4s/.test(l)));
    assert.ok(logs.includes('[app-front] Waiting...'));

    const conflict = await call('POST', '/api/preview/7777/start');
    assert.strictEqual(conflict.status, 409);
    assert.strictEqual(conflict.body.error, 'Preview do ticket 4242 ainda está rodando — pare-o antes de iniciar um novo');

    const st = await call('GET', '/api/preview/4242/status');
    assert.strictEqual(st.body.phase, 'running');
    assert.ok(st.body.runningAt);

    // Reconectar recebe o buffer inteiro + a fase atual.
    const replay = await sse('/api/preview/4242/log-stream', evs => evs.some(e => e.type === 'phase'));
    assert.ok(replay.filter(e => e.type === 'log').length >= logs.length);
    assert.strictEqual(replay.find(e => e.type === 'phase').data.phase, 'running');

    const stopped = await call('POST', '/api/preview/4242/stop');
    assert.strictEqual(stopped.status, 200);
    assert.strictEqual(stopped.body.phase, 'idle');
    assert.strictEqual((await call('GET', '/api/preview/7777/status')).body.activeTicket, null);
});
