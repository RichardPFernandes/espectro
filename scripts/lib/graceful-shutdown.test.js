// node --test scripts/lib/graceful-shutdown.test.js
// Shutdown graceful (SIGTERM) + --health-check do watcher: unidade (GracefulShutdown,
// computeHealth) e ponta a ponta com o watcher de verdade num processo filho, contra
// um REPO_PATH sintético, Redmine falso (HTTP local) e `claude` falso no PATH.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { EventEmitter } = require('events');
const { spawn, spawnSync } = require('child_process');
const { GracefulShutdown, markTaskInterrupted, resolveGracefulTimeoutMs, interruptionNote } = require('./graceful-shutdown');
const { computeHealth } = require('./watcher-health');

const TMP_ROOT = process.env.CLAUDE_JOB_DIR ? path.join(process.env.CLAUDE_JOB_DIR, 'tmp') : os.tmpdir();
const WATCHER = path.join(__dirname, '..', 'readmine-watcher.js');
const mkTmp = prefix => fs.mkdtempSync(path.join(TMP_ROOT, prefix));
const silent = { log() {}, warn() {}, error() {} };

function seedTask(runsDir, taskId, state) {
    const dir = path.join(runsDir, taskId);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ task_id: taskId, history: [], started_at: new Date().toISOString(), ...state }, null, 2));
    return dir;
}
const readJson = f => JSON.parse(fs.readFileSync(f, 'utf8'));

class FakeChild extends EventEmitter {
    constructor({ exitOnTerm = true } = {}) { super(); this.exitCode = null; this.signalCode = null; this.signals = []; this.exitOnTerm = exitOnTerm; }
    kill(sig) {
        this.signals.push(sig);
        if (sig === 'SIGKILL' || this.exitOnTerm) setImmediate(() => { this.signalCode = sig; this.emit('exit', null, sig); });
    }
}

// ------------------------------------------------------------------ unidade
test('resolveGracefulTimeoutMs: padrão 10000, env válido, env inválido cai no padrão', () => {
    assert.strictEqual(resolveGracefulTimeoutMs({}), 10000);
    assert.strictEqual(resolveGracefulTimeoutMs({ GRACEFUL_TIMEOUT_MS: '2500' }), 2500);
    const warn = console.warn; console.warn = () => {};
    try { assert.strictEqual(resolveGracefulTimeoutMs({ GRACEFUL_TIMEOUT_MS: 'abc' }), 10000); } finally { console.warn = warn; }
});

test('markTaskInterrupted: grava status/interruptedAt/activeNodeAtInterruption + evento; respeita lease de outro despacho', () => {
    const runs = mkTmp('gs-mark-');
    const dir = seedTask(runs, '1-a', { node: 'review', status: 'running', node_started_at: 'L1', agent_pid: 123 });
    assert.strictEqual(markTaskInterrupted(dir, { node: 'review', at: '2026-09-24T00:00:00.000Z', leaseStartedAt: 'OUTRO' }), false);
    assert.strictEqual(readJson(path.join(dir, 'state.json')).status, 'running');
    assert.strictEqual(markTaskInterrupted(dir, { node: 'review', at: '2026-09-24T00:00:00.000Z', leaseStartedAt: 'L1' }), true);
    const st = readJson(path.join(dir, 'state.json'));
    assert.strictEqual(st.status, 'interrupted');
    assert.strictEqual(st.interruptedAt, '2026-09-24T00:00:00.000Z');
    assert.strictEqual(st.activeNodeAtInterruption, 'review');
    assert.strictEqual(st.agent_pid, undefined);
    assert.strictEqual(st.events.at(-1).type, 'interrupted');
    assert.strictEqual(markTaskInterrupted(path.join(runs, 'sumiu'), { node: 'x', at: 'y' }), false);
});

test('GracefulShutdown com ciclo ativo: marca task, grava runtime, comenta no Redmine, mata o agente e sai com 0', async () => {
    const proc = new EventEmitter();
    const child = new FakeChild();
    const notes = [], runtimes = [], marked = [];
    let exitCode;
    const st = { status: 'running', activeCycle: { ticketId: 42, taskId: '42-a', node: 'test', dir: '/x', leaseStartedAt: 'L', child }, nextPollAt: 'z' };
    const gs = new GracefulShutdown({
        timeoutMs: 1000, proc, log: silent, exit: c => { exitCode = c; },
        postNote: async (id, text) => { notes.push([id, text]); return true; },
        writeRuntime: s => runtimes.push(JSON.parse(JSON.stringify({ ...s, activeCycle: { ...s.activeCycle, child: undefined } }))),
        markTask: (dir, info) => { marked.push([dir, info]); return true; },
    }).register(st);
    proc.emit('SIGTERM');
    await gs.inProgress;
    assert.strictEqual(exitCode, 0);
    assert.deepStrictEqual(notes, [[42, interruptionNote('test')]]);
    assert.match(notes[0][1], /⚠️ Watcher interrompido via SIGTERM durante nó test\. Ciclo deve ser retomado manualmente\./);
    assert.strictEqual(marked[0][0], '/x');
    assert.strictEqual(marked[0][1].leaseStartedAt, 'L');
    assert.deepStrictEqual(child.signals, ['SIGTERM']);
    assert.strictEqual(runtimes[0].status, 'interrupted');
    assert.strictEqual(runtimes[0].activeNodeAtInterruption, 'test');
    assert.strictEqual(runtimes[0].lastCompletedCycle.status, 'interrupted');
    assert.strictEqual(runtimes[0].nextPollAt, null);
    assert.strictEqual(st.shuttingDown, true);
});

test('GracefulShutdown: nunca espera além do timeout (Redmine pendurado, agente ignora SIGTERM → SIGKILL)', async () => {
    const child = new FakeChild({ exitOnTerm: false });
    let exitCode;
    const st = { activeCycle: { ticketId: 1, taskId: '1-a', node: 'implement', dir: null, child } };
    const gs = new GracefulShutdown({ timeoutMs: 80, proc: new EventEmitter(), log: silent, exit: c => { exitCode = c; }, postNote: () => new Promise(() => {}) }).register(st);
    const t0 = Date.now();
    await gs.shutdown();
    const took = Date.now() - t0;
    assert.strictEqual(exitCode, 0);
    assert.ok(took >= 70 && took < 1000, `levou ${took} ms`);
    assert.deepStrictEqual(child.signals, ['SIGTERM', 'SIGKILL']);
});

test('GracefulShutdown sem ciclo ativo: sai na hora, sem comentar no Redmine', async () => {
    let exitCode, posted = false, wrote = 0;
    const gs = new GracefulShutdown({ timeoutMs: 10000, proc: new EventEmitter(), log: silent, exit: c => { exitCode = c; }, postNote: async () => { posted = true; }, writeRuntime: () => { wrote++; } })
        .register({ status: 'idle', activeCycle: null });
    const t0 = Date.now();
    await gs.shutdown();
    assert.ok(Date.now() - t0 < 100);
    assert.strictEqual(exitCode, 0);
    assert.strictEqual(posted, false);
    assert.strictEqual(wrote, 1);
});

test('computeHealth: sem runtime e sem nó rodando = idle saudável', () => {
    const runs = mkTmp('gs-h0-');
    const h = computeHealth({ runtimePath: path.join(runs, 'watcher-runtime.json'), runsDirs: [runs] });
    assert.deepStrictEqual([h.status, h.healthy, h.uptimeSeconds, h.activeCycle, h.lastCompletedCycle, h.nextPollAt], ['idle', true, 0, null, null, null]);
});

test('computeHealth: runtime ilegível = inconsistente', () => {
    const runs = mkTmp('gs-h1-');
    fs.writeFileSync(path.join(runs, 'watcher-runtime.json'), '{trunc');
    const h = computeHealth({ runtimePath: path.join(runs, 'watcher-runtime.json'), runsDirs: [runs] });
    assert.strictEqual(h.healthy, false);
    assert.match(h.issues[0], /ilegível/);
});

test('computeHealth: watcher vivo conduzindo ciclo = running, uptime do laço e nextPollAt', () => {
    const runs = mkTmp('gs-h2-');
    const now = Date.parse('2026-09-24T12:00:00Z');
    fs.writeFileSync(path.join(runs, 'watcher-runtime.json'), JSON.stringify({
        pid: 99999, loopStartedAt: '2026-09-24T11:00:00Z', status: 'running',
        activeCycle: { ticketId: 7, taskId: '7-a', node: 'review', startedAt: '2026-09-24T11:59:00Z' },
        lastCompletedCycle: { taskId: '6-a', completedAt: '2026-09-24T11:30:00Z', status: 'completed' },
        nextPollAt: null,
    }));
    seedTask(runs, '7-a', { node: 'review', status: 'running', node_started_at: '2026-09-24T11:59:00Z', agent_pid: 5 });
    const h = computeHealth({ runtimePath: path.join(runs, 'watcher-runtime.json'), runsDirs: [runs], now, isWatcherAlive: () => true, isAgentAlive: () => true });
    assert.strictEqual(h.status, 'running');
    assert.strictEqual(h.healthy, true);
    assert.strictEqual(h.uptimeSeconds, 3600);
    assert.deepStrictEqual(h.activeCycle, { taskId: '7-a', node: 'review', startedAt: '2026-09-24T11:59:00Z', source: 'watcher' });
    assert.deepStrictEqual(h.lastCompletedCycle, { taskId: '6-a', completedAt: '2026-09-24T11:30:00Z', status: 'completed' });
});

test('computeHealth: entre ticks (processo saiu, próxima poll futura) = idle com uptime e nextPollAt', () => {
    const runs = mkTmp('gs-h3-');
    const now = Date.parse('2026-09-24T12:00:00Z');
    fs.writeFileSync(path.join(runs, 'watcher-runtime.json'), JSON.stringify({ pid: 99999, loopStartedAt: '2026-09-24T11:59:00Z', status: 'idle', activeCycle: null, nextPollAt: '2026-09-24T12:00:30Z' }));
    const h = computeHealth({ runtimePath: path.join(runs, 'watcher-runtime.json'), runsDirs: [runs], now, isWatcherAlive: () => false });
    assert.deepStrictEqual([h.status, h.healthy, h.uptimeSeconds, h.nextPollAt], ['idle', true, 60, '2026-09-24T12:00:30Z']);
    // Laço parado (poll vencida há muito): sem uptime nem próxima poll.
    const later = computeHealth({ runtimePath: path.join(runs, 'watcher-runtime.json'), runsDirs: [runs], now: now + 10 * 60000, isWatcherAlive: () => false });
    assert.deepStrictEqual([later.uptimeSeconds, later.nextPollAt], [0, null]);
});

test('computeHealth: watcher morto com ciclo ativo sem shutdown graceful = inconsistente; interrompido graceful = saudável', () => {
    const runs = mkTmp('gs-h4-');
    const rt = path.join(runs, 'watcher-runtime.json');
    const cycle = { ticketId: 7, taskId: '7-a', node: 'test', startedAt: '2026-09-24T11:59:00Z' };
    fs.writeFileSync(rt, JSON.stringify({ pid: 99999, status: 'running', activeCycle: cycle }));
    assert.strictEqual(computeHealth({ runtimePath: rt, runsDirs: [runs], isWatcherAlive: () => false }).healthy, false);
    fs.writeFileSync(rt, JSON.stringify({ pid: 99999, status: 'interrupted', activeCycle: cycle, interruptedAt: '2026-09-24T12:00:00Z', activeNodeAtInterruption: 'test', lastCompletedCycle: { taskId: '7-a', completedAt: '2026-09-24T12:00:00Z', status: 'interrupted' } }));
    const h = computeHealth({ runtimePath: rt, runsDirs: [runs], isWatcherAlive: () => false });
    assert.deepStrictEqual([h.healthy, h.status, h.lastCompletedCycle.status], [true, 'idle', 'interrupted']);
    assert.deepStrictEqual(h.lastInterruption, { interruptedAt: '2026-09-24T12:00:00Z', activeNodeAtInterruption: 'test' });
});

test('computeHealth: nó running órfão ou com agente morto sem watcher = inconsistente; agente vivo = running', () => {
    const runs = mkTmp('gs-h5-');
    const rt = path.join(runs, 'watcher-runtime.json');
    const now = Date.parse('2026-09-24T12:00:00Z');
    seedTask(runs, '8-a', { node: 'implement', status: 'running', node_started_at: '2026-09-24T11:50:00Z', node_timeout_ms: 3600000, agent_pid: 11 });
    const alive = computeHealth({ runtimePath: rt, runsDirs: [runs], now, isAgentAlive: () => true });
    assert.deepStrictEqual([alive.status, alive.healthy, alive.activeCycle.source, alive.activeCycle.taskId], ['running', true, 'agent', '8-a']);
    const dead = computeHealth({ runtimePath: rt, runsDirs: [runs], now, isAgentAlive: () => false });
    assert.strictEqual(dead.healthy, false);
    assert.match(dead.issues[0], /agente \(PID 11\) morto/);
    // Sem agent_pid gravado, só o timeout decide.
    const noPid = mkTmp('gs-h5b-');
    seedTask(noPid, '8-b', { node: 'implement', status: 'running', node_started_at: '2026-09-24T11:50:00Z', node_timeout_ms: 3600000 });
    const orphan = computeHealth({ runtimePath: rt, runsDirs: [noPid], now: now + 2 * 3600000, isAgentAlive: () => false });
    assert.match(orphan.issues[0], /órfão/);
});

// ------------------------------------------------------------------ ponta a ponta
function fakeRedmine({ issues, delayListMs = 0 }) {
    const puts = [];
    const server = http.createServer((req, res) => {
        let body = '';
        req.on('data', c => { body += c; });
        req.on('end', () => {
            const reply = obj => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
            if (req.method === 'PUT') { puts.push({ url: req.url, body: JSON.parse(body || '{}') }); res.writeHead(204); return res.end(); }
            if (req.url.startsWith('/issues.json')) return setTimeout(() => reply({ issues }), delayListMs);
            const m = req.url.match(/^\/issues\/(\d+)\.json/);
            if (m) return reply({ issue: { ...(issues.find(i => i.id === Number(m[1])) || { id: Number(m[1]) }), journals: [] } });
            reply({});
        });
    });
    return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({ server, puts, url: `http://127.0.0.1:${server.address().port}` })));
}

function sandbox() {
    const tmp = mkTmp('gs-e2e-');
    const repo = path.join(tmp, 'app-back');
    const bin = path.join(tmp, 'bin');
    fs.mkdirSync(path.join(repo, 'memory', 'runs'), { recursive: true });
    fs.mkdirSync(bin);
    // `claude` falso: fica "trabalhando" até ser morto.
    fs.writeFileSync(path.join(bin, 'claude'), '#!/bin/sh\nexec sleep 30\n', { mode: 0o755 });
    fs.writeFileSync(path.join(bin, 'osascript'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    return { tmp, repo, bin };
}

function startWatcher({ repo, bin, url, args }) {
    const env = {
        ...process.env, REPO_PATH: repo, REDMINE_URL: url, REDMINE_API_KEY: 'k',
        PATH: `${bin}:${process.env.PATH}`, SKIP_PRE_BUILD_VALIDATION: 'true', GRACEFUL_TIMEOUT_MS: '3000',
        WATCHER_LOOP_STARTED_AT: new Date(Date.now() - 5000).toISOString(), WATCHER_TICK_INTERVAL_MS: '60000',
    };
    const child = spawn(process.execPath, [WATCHER, ...args], { cwd: repo, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { out += d; });
    const exited = new Promise(resolve => child.on('exit', (code, signal) => resolve({ code, signal, at: Date.now() })));
    return { child, exited, output: () => out };
}

async function waitFor(fn, ms = 10000) {
    const end = Date.now() + ms;
    for (;;) {
        try { const v = fn(); if (v) return v; } catch {}
        if (Date.now() > end) throw new Error('timeout esperando condição');
        await new Promise(r => setTimeout(r, 50));
    }
}

test('e2e: SIGTERM durante ciclo (--follow) → state.json interrupted, comentário no Redmine, exit 0; health-check depois é JSON válido', async () => {
    const { repo, bin } = sandbox();
    const runs = path.join(repo, '.claude', 'worktrees', '777', 'memory', 'runs');
    const dir = seedTask(runs, '777-teste', { node: 'review', status: 'in_progress', history: ['fetch_ticket', 'plan', 'implement'] });
    const ticket = { id: 777, subject: 'Teste', status: { name: 'Aprovada' }, tracker: { name: 'Problema' }, custom_fields: [{ name: 'Branch Liberação', value: 'Dev - Local' }] };
    const rm = await fakeRedmine({ issues: [ticket] });
    try {
        const w = startWatcher({ repo, bin, url: rm.url, args: ['--follow', '--ticket=777'] });
        const runtimeFile = path.join(repo, 'memory', 'runs', 'watcher-runtime.json');
        await waitFor(() => readJson(path.join(dir, 'state.json')).agent_pid && readJson(runtimeFile).activeCycle?.taskId === '777-teste');
        const t0 = Date.now();
        w.child.kill('SIGTERM');
        const { code, at } = await w.exited;
        assert.strictEqual(code, 0, w.output());
        assert.ok(at - t0 < 3500, `shutdown levou ${at - t0} ms`);
        assert.match(w.output(), /Graceful shutdown iniciado/);

        const st = readJson(path.join(dir, 'state.json'));
        assert.strictEqual(st.status, 'interrupted');
        assert.strictEqual(st.activeNodeAtInterruption, 'review');
        assert.ok(Number.isFinite(Date.parse(st.interruptedAt)));

        const note = rm.puts.find(p => p.url === '/issues/777.json');
        assert.ok(note, 'sem comentário no Redmine');
        assert.strictEqual(note.body.issue.notes, '⚠️ Watcher interrompido via SIGTERM durante nó review. Ciclo deve ser retomado manualmente.');

        const rt = readJson(runtimeFile);
        assert.strictEqual(rt.status, 'interrupted');
        assert.strictEqual(rt.lastCompletedCycle.status, 'interrupted');

        const hc = spawnSync(process.execPath, [WATCHER, '--health-check'], { cwd: repo, env: { ...process.env, REPO_PATH: repo, REDMINE_URL: rm.url, REDMINE_API_KEY: 'k' }, encoding: 'utf8' });
        assert.strictEqual(hc.status, 0, hc.stderr);
        const h = JSON.parse(hc.stdout);
        for (const k of ['status', 'uptimeSeconds', 'activeCycle', 'lastCompletedCycle', 'nextPollAt']) assert.ok(k in h, `sem ${k}`);
        assert.strictEqual(h.status, 'idle');
        assert.deepStrictEqual(h.lastCompletedCycle, { taskId: '777-teste', completedAt: rt.lastCompletedCycle.completedAt, status: 'interrupted', node: 'review' });
        // --health-check não grava nada.
        assert.deepStrictEqual(readJson(runtimeFile), rt);

        // Próximo tick não redespacha a task interrompida.
        const again = startWatcher({ repo, bin, url: rm.url, args: ['--ticket=777'] });
        const r2 = await again.exited;
        assert.strictEqual(r2.code, 0);
        assert.match(again.output(), /status_interrupted/);
        assert.strictEqual(readJson(path.join(dir, 'state.json')).status, 'interrupted');
    } finally {
        rm.server.close();
    }
});

test('e2e: watcher idle (sem ciclo, esperando o Redmine) recebe SIGTERM → sai em < 1s com exit 0', async () => {
    const { repo, bin } = sandbox();
    const rm = await fakeRedmine({ issues: [], delayListMs: 8000 });
    try {
        const w = startWatcher({ repo, bin, url: rm.url, args: [] });
        const runtimeFile = path.join(repo, 'memory', 'runs', 'watcher-runtime.json');
        await waitFor(() => readJson(runtimeFile).pid === w.child.pid);
        const t0 = Date.now();
        w.child.kill('SIGTERM');
        const { code, at } = await w.exited;
        assert.strictEqual(code, 0, w.output());
        assert.ok(at - t0 < 1000, `levou ${at - t0} ms`);
        assert.strictEqual(rm.puts.length, 0);
        assert.strictEqual(readJson(runtimeFile).status, 'idle');
    } finally {
        rm.server.closeAllConnections?.();
        rm.server.close();
    }
});
