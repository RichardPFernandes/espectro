// node --test scripts/lib/dispatch-reservation.test.js
// PRI-218: reserva atômica por ticket no despacho. Unidade da reserva e do marcador
// fetch_dispatch + e2e com os dois chamadores reais em processos distintos: o watcher
// (CLI, tick com --ticket) e o dispatchNode que o dashboard chama ("▶ Disparar").
// O watcher é parado DENTRO do check-then-act (antes de gravar o marcador) por um
// preload que segura o writeFileSync do gate — a janela exata do bug. REPO_PATH
// sintético no tmp, Redmine falso em loopback e `claude` falso que só registra a
// chamada e fica vivo até o teste liberar.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn, spawnSync } = require('child_process');

const reservation = require('./dispatch-reservation');
const watcherLock = require('./watcher-lock');
const nodeLease = require('./node-lease');

const TMP_ROOT = process.env.CLAUDE_JOB_DIR ? path.join(process.env.CLAUDE_JOB_DIR, 'tmp') : os.tmpdir();
const WATCHER = path.join(__dirname, '..', 'readmine-watcher.js');
const DISPATCHER = path.join(__dirname, 'node-dispatcher.js');
const DOM06 = path.join(__dirname, 'dom06-attempt.js');
const mkTmp = prefix => fs.mkdtempSync(path.join(TMP_ROOT, prefix));
const deadPid = () => spawnSync(process.execPath, ['-e', '']).pid;

async function waitFor(cond, ms = 15000, what = 'condição') {
    const until = Date.now() + ms;
    while (!cond()) {
        if (Date.now() > until) throw new Error(`timeout esperando ${what}`);
        await new Promise(r => setTimeout(r, 25));
    }
}

// ------------------------------------------------------------------- unidade
test('reserve: segunda reserva do mesmo ticket é recusada (mesmo processo), outro ticket não; release libera', () => {
    const repo = mkTmp('dr-unit-');
    const a = reservation.reserve({ repoPath: repo, ticketId: 101 });
    assert.ok(a.acquired);
    assert.ok(fs.existsSync(a.path));
    const b = reservation.reserve({ repoPath: repo, ticketId: 101 });
    assert.strictEqual(b.acquired, false);
    assert.strictEqual(b.reason, 'held');
    assert.strictEqual(b.holder.pid, process.pid);
    assert.match(b.message, /#101: despacho já em andamento/);
    const other = reservation.reserve({ repoPath: repo, ticketId: 102 });
    assert.ok(other.acquired, 'reserva é por ticket');
    other.release();
    a.release();
    assert.ok(!fs.existsSync(a.path));
    const again = reservation.reserve({ repoPath: repo, ticketId: 101 });
    assert.ok(again.acquired);
    again.release();
});

test('reserve: dono morto (crash no meio do despacho) é retomado — sem reserva órfã', () => {
    const repo = mkTmp('dr-unit-');
    const lockPath = reservation.reservationPath(repo, 103);
    fs.writeFileSync(lockPath, JSON.stringify({ version: 1, role: 'dispatch', pid: deadPid(), started_at: new Date().toISOString(), token: 'velho', hostname: os.hostname() }));
    const r = reservation.reserve({ repoPath: repo, ticketId: 103 });
    assert.ok(r.acquired);
    assert.strictEqual(r.takeover, true);
    assert.strictEqual(r.previous.token, 'velho');
    r.release();
    assert.ok(!fs.existsSync(lockPath));
});

test('reservationPath: mesmo lugar da trava do watcher; trava do watcher não muda de caminho', () => {
    const repo = mkTmp('dr-unit-');
    assert.strictEqual(path.dirname(reservation.reservationPath(repo, 7)), path.dirname(watcherLock.lockPathFor(repo)));
    assert.match(watcherLock.lockPathFor(repo), /^\/tmp\/prisma-watcher-[0-9a-f]{16}\.lock$/);
    assert.match(reservation.reservationPath(repo, 7), /^\/tmp\/prisma-dispatch-7-[0-9a-f]{16}\.lock$/);
    fs.mkdirSync(path.join(repo, '.git'));
    assert.strictEqual(reservation.reservationPath(repo, 7), path.join(fs.realpathSync(repo), '.git', 'prisma-dispatch-7.lock'));
});

test('fetchDispatchLive: pid vivo segura; pid morto, dispatch_id sem pid e legado vencido liberam', () => {
    const now = Date.parse('2026-10-23T12:00:00.000Z');
    const at = '2026-10-23T11:59:00.000Z';
    const alive = () => true, dead = () => false;
    const gate = d => ({ ticket_id: 1, fetch_dispatch: { started_at: at, timeout_ms: 60_000 * 60, ...d } });
    assert.ok(nodeLease.fetchDispatchLive(gate({ dispatch_id: 'x', agent_pid: 42 }), { now, isAlive: alive }));
    assert.strictEqual(nodeLease.fetchDispatchLive(gate({ dispatch_id: 'x', agent_pid: 42 }), { now, isAlive: dead }), null);
    assert.strictEqual(nodeLease.fetchDispatchLive(gate({ dispatch_id: 'x' }), { now, isAlive: alive }), null, 'despachante morreu antes do spawn');
    assert.ok(nodeLease.fetchDispatchLive(gate({}), { now }), 'legado dentro do prazo');
    assert.strictEqual(nodeLease.fetchDispatchLive(gate({ timeout_ms: 1000 }), { now }), null, 'legado vencido');
    assert.strictEqual(nodeLease.fetchDispatchLive({ ticket_id: 1 }, { now }), null);
    assert.strictEqual(nodeLease.fetchDispatchLive(null, { now }), null);
});

test('recordAgentPid: task nova carimba o pid no marcador do MESMO despacho, e só nele', () => {
    const dir = mkTmp('dr-unit-');
    const gatePath = path.join(dir, '5-spec-gate.json');
    fs.writeFileSync(gatePath, JSON.stringify({ ticket_id: 5, status: 'valid', fetch_dispatch: { started_at: 'A', dispatch_id: 'd' } }));
    nodeLease.recordAgentPid({ runsDir: dir, gatePath, startedAt: 'B' }, 4242, { startOf: () => 'inicio' });
    assert.strictEqual(JSON.parse(fs.readFileSync(gatePath, 'utf8')).fetch_dispatch.agent_pid, undefined);
    nodeLease.recordAgentPid({ runsDir: dir, gatePath, startedAt: 'A' }, 4242, { startOf: () => 'inicio' });
    const g = JSON.parse(fs.readFileSync(gatePath, 'utf8'));
    assert.deepStrictEqual(g.fetch_dispatch, { started_at: 'A', dispatch_id: 'd', agent_pid: 4242, agent_started_at: 'inicio' });
    assert.strictEqual(g.status, 'valid');
});

// ---------------------------------------------------------------------- e2e
const DESCRIPTION = '# Spec\n\n## Problema\nDois agentes podem subir no mesmo ticket quando o watcher e o dashboard despacham juntos.\n\n## Solução\nReservar o ticket no ponto comum de despacho até o despacho ficar visível. Os dados sintéticos comprovam a exclusão sem depender de qualquer consumidor real.\n\n## Critérios de Aceite\n- AC-01: um único agente por ticket.\n- AC-02: reserva liberada em erro e crash.\n';

function issue(id) {
    return {
        id, subject: `Ticket ${id}`, description: DESCRIPTION, status: { name: 'Em Desenvolvimento' }, tracker: { name: 'Melhoria' },
        custom_fields: [{ name: 'Branch Liberação', value: 'Dev - Local' }], updated_on: new Date().toISOString(),
    };
}

function fakeRedmine(issues) {
    const server = http.createServer((req, res) => {
        req.resume();
        req.on('end', () => {
            const reply = obj => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
            if (req.method !== 'GET') { res.writeHead(204); return res.end(); }
            if (req.url.startsWith('/issues.json')) return reply({ issues, total_count: issues.length });
            const m = req.url.match(/^\/issues\/(\d+)\.json/);
            if (m) return reply({ issue: { ...(issues.find(i => i.id === Number(m[1])) || { id: Number(m[1]) }), journals: [] } });
            reply({});
        });
    });
    return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({ server, url: `http://127.0.0.1:${server.address().port}` })));
}

// Consumidor sintético com o worktree do ticket já criado (ensureTicketWorktree só
// devolve o path) e a spec gravada — o despacho de task nova vai direto ao agente.
function sandbox(id) {
    const tmp = mkTmp('dr-e2e-');
    const repo = path.join(tmp, 'app-back');
    const bin = path.join(tmp, 'bin');
    const calls = path.join(tmp, 'claude-calls.log');
    const finish = path.join(tmp, 'finish');
    fs.mkdirSync(path.join(repo, '.claude', 'worktrees', String(id), 'memory', 'runs'), { recursive: true });
    fs.mkdirSync(path.join(repo, 'memory', 'spec'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'memory', 'spec', `${id}-spec.md`), DESCRIPTION);
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'claude'), `#!/bin/sh\necho "$$" >> ${JSON.stringify(calls)}\nwhile [ ! -f ${JSON.stringify(finish)} ]; do sleep 0.05; done\n`, { mode: 0o755 });
    fs.writeFileSync(path.join(bin, 'osascript'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    const gatePath = path.join(repo, 'memory', 'runs', `${id}-spec-gate.json`);
    const claudeCalls = () => (fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8').trim().split('\n').filter(Boolean).length : 0);
    const gate = () => { try { return JSON.parse(fs.readFileSync(gatePath, 'utf8')); } catch { return null; } };
    return { tmp, repo, bin, finish, gatePath, claudeCalls, gate };
}

function childEnv(sb, url) {
    return {
        ...process.env, REPO_PATH: sb.repo, REDMINE_URL: url, REDMINE_API_KEY: 'k', REDMINE_USER_ID: '1',
        PATH: `${sb.bin}:${process.env.PATH}`, SKIP_PRE_BUILD_VALIDATION: 'true',
        WATCHER_LOOP_STARTED_AT: new Date(Date.now() - 5000).toISOString(), WATCHER_TICK_INTERVAL_MS: '60000',
    };
}

function run(cmd, args, { cwd, env }) {
    const child = spawn(process.execPath, [...cmd, ...args], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { out += d; });
    const exited = new Promise(resolve => child.on('exit', (code, signal) => resolve({ code, signal })));
    return { child, exited, output: () => out };
}

// Watcher real (tick do CLI) parado no writeFileSync do marcador fetch_dispatch: já
// reservou e já viu "sem task, sem marcador", mas ainda não gravou nada visível.
function parkedWatcher(sb, url, id) {
    const parked = path.join(sb.tmp, 'parked');
    const go = path.join(sb.tmp, 'go');
    const preload = path.join(sb.tmp, 'park.cjs');
    fs.writeFileSync(preload, `
const fs = require('node:fs');
const write = fs.writeFileSync;
const nap = new Int32Array(new SharedArrayBuffer(4));
fs.writeFileSync = function (file, data, ...rest) {
    if (String(file).endsWith(${JSON.stringify(`${id}-spec-gate.json`)}) && String(data).includes('"fetch_dispatch"') && !fs.existsSync(${JSON.stringify(go)})) {
        write(${JSON.stringify(parked)}, String(process.pid));
        while (!fs.existsSync(${JSON.stringify(go)})) Atomics.wait(nap, 0, 0, 20);
    }
    return write.call(this, file, data, ...rest);
};
`);
    const w = run(['--require', preload, WATCHER], [`--ticket=${id}`], { cwd: sb.repo, env: childEnv(sb, url) });
    return { ...w, parked: () => fs.existsSync(parked), go: () => fs.writeFileSync(go, '') };
}

// Chamador do dashboard: a MESMA função do POST /api/runs/start (dispatchTicketNode →
// dispatchNode, follow:false), num processo próprio. `preload` opcional (falhas).
function dashboardDispatch(sb, url, id, preload = null) {
    const driver = path.join(sb.tmp, 'dashboard-driver.js');
    fs.writeFileSync(driver, `
const { dispatchNode } = require(${JSON.stringify(DISPATCHER)});
dispatchNode({ ticketId: ${id}, follow: false, repoPath: process.env.REPO_PATH }).then(
    r => { console.log('RESULT ' + JSON.stringify(r)); process.exit(0); },
    e => { console.log('ERROR ' + e.message); process.exit(1); },
);
`);
    const d = run([...(preload ? ['--require', preload] : []), driver], [], { cwd: sb.repo, env: childEnv(sb, url) });
    return d.exited.then(r => {
        const out = d.output();
        const m = out.match(/^RESULT (.*)$/m);
        return { ...r, out, result: m ? JSON.parse(m[1]) : null, error: (out.match(/^ERROR (.*)$/m) || [])[1] || null };
    });
}

// Em falha de assert o watcher parado (park.cjs) e o claude falso não podem ficar
// vivos: libera o park, mata o filho e sinaliza o finish do agente (PRI-218 A-04).
function cleanupE2e(sb, rm, w) {
    try { w?.go?.(); } catch { /* go já feito */ }
    try { w?.child?.kill('SIGKILL'); } catch { /* já saiu */ }
    try { fs.writeFileSync(sb.finish, ''); } catch { /* tmp sumiu */ }
    try { rm.server.close(); } catch { /* já fechado */ }
}

test('e2e: watcher e dashboard em processos distintos — um só agente; o segundo pula pela reserva e depois pelo marcador', async () => {
    const id = 92181;
    const sb = sandbox(id);
    const rm = await fakeRedmine([issue(id)]);
    try {
        const w = parkedWatcher(sb, rm.url, id);
        await waitFor(() => w.parked(), 20000, `watcher parado no marcador\n${w.output()}`);
        assert.ok(fs.existsSync(reservation.reservationPath(sb.repo, id)), 'watcher segura a reserva');
        assert.strictEqual(sb.gate()?.fetch_dispatch, undefined, 'nada visível ainda: é a janela do check-then-act');

        const during = await dashboardDispatch(sb, rm.url, id);
        assert.strictEqual(during.code, 0, during.out);
        assert.strictEqual(during.result.action, 'skip', during.out);
        assert.strictEqual(during.result.reason, 'despacho_reservado');
        assert.strictEqual(during.result.holderPid, w.child.pid);
        assert.strictEqual(sb.claudeCalls(), 0);

        w.go();
        const wr = await w.exited;
        assert.strictEqual(wr.code, 0, w.output());
        assert.match(w.output(), /"action":"dispatched","node":"fetch_ticket"/);
        await waitFor(() => sb.claudeCalls() === 1, 10000, 'agente do watcher');
        await waitFor(() => sb.gate()?.fetch_dispatch?.agent_pid, 10000, 'pid no marcador');
        assert.ok(!fs.existsSync(reservation.reservationPath(sb.repo, id)), 'reserva sai com o despacho visível');

        const after = await dashboardDispatch(sb, rm.url, id);
        assert.strictEqual(after.result.action, 'skip', after.out);
        assert.strictEqual(after.result.reason, 'fetch_em_execucao');
        assert.strictEqual(after.result.agentPid, sb.gate().fetch_dispatch.agent_pid);
        assert.strictEqual(sb.claudeCalls(), 1, 'nenhum segundo agente');

        fs.writeFileSync(sb.finish, '');
        await waitFor(() => sb.gate() && !sb.gate().fetch_dispatch, 10000, 'release do lease limpar o marcador');
    } finally {
        cleanupE2e(sb, rm, w);
    }
});

test('e2e: crash do watcher com a reserva na mão — o dashboard retoma e despacha uma vez', async () => {
    const id = 92182;
    const sb = sandbox(id);
    const rm = await fakeRedmine([issue(id)]);
    try {
        const w = parkedWatcher(sb, rm.url, id);
        await waitFor(() => w.parked(), 20000, `watcher parado no marcador\n${w.output()}`);
        w.child.kill('SIGKILL');
        await w.exited;
        const lockPath = reservation.reservationPath(sb.repo, id);
        assert.ok(fs.existsSync(lockPath), 'reserva ficou no disco com o dono morto');

        const r = await dashboardDispatch(sb, rm.url, id);
        assert.strictEqual(r.result?.action, 'dispatched', r.out);
        assert.match(r.out, /reserva de despachante morto retomada/);
        await waitFor(() => sb.claudeCalls() === 1, 10000, 'agente do dashboard');
        assert.ok(!fs.existsSync(lockPath));
    } finally {
        cleanupE2e(sb, rm, w);
    }
});

test('e2e: erro depois do marcador — reserva e marcador liberados; o próximo despacho segue', async () => {
    const id = 92183;
    const sb = sandbox(id);
    const rm = await fakeRedmine([issue(id)]);
    const failing = path.join(sb.tmp, 'dom06-falha.cjs');
    fs.writeFileSync(failing, `require(${JSON.stringify(DOM06)}).prepareDispatch = () => { throw new Error('falha sintética PRI-218'); };\n`);
    try {
        const bad = await dashboardDispatch(sb, rm.url, id, failing);
        assert.strictEqual(bad.code, 1, bad.out);
        assert.match(bad.error, /falha sintética PRI-218/);
        assert.ok(!fs.existsSync(reservation.reservationPath(sb.repo, id)), 'reserva liberada no erro');
        assert.ok(sb.gate(), 'gate gravado antes da falha');
        assert.strictEqual(sb.gate().fetch_dispatch, undefined, 'marcador do despacho que não chegou ao agente sai');
        assert.strictEqual(sb.claudeCalls(), 0);

        const ok = await dashboardDispatch(sb, rm.url, id);
        assert.strictEqual(ok.result?.action, 'dispatched', ok.out);
        await waitFor(() => sb.claudeCalls() === 1, 10000, 'agente');
    } finally {
        
  (sb, rm, null);
    }
});

test('e2e: falha ao gravar fetch_dispatch — spawn abortado (falha fechada A-01)', async () => {
    const id = 92184;
    const sb = sandbox(id);
    const rm = await fakeRedmine([issue(id)]);
    const failing = path.join(sb.tmp, 'gate-write-falha.cjs');
    fs.writeFileSync(failing, `
const fs = require('node:fs');
const write = fs.writeFileSync;
fs.writeFileSync = function (file, data, ...rest) {
    if (String(file).endsWith(${JSON.stringify(`${id}-spec-gate.json`)}) && String(data).includes('"fetch_dispatch"')) {
        throw new Error('falha sintética gravação fetch_dispatch PRI-218');
    }
    return write.call(this, file, data, ...rest);
};
`);
    try {
        const bad = await dashboardDispatch(sb, rm.url, id, failing);
        assert.strictEqual(bad.code, 1, bad.out);
        assert.match(bad.error || bad.out, /falha sintética gravação fetch_dispatch PRI-218/);
        assert.ok(!fs.existsSync(reservation.reservationPath(sb.repo, id)), 'reserva liberada sem spawn');
        assert.strictEqual(sb.claudeCalls(), 0, 'nenhum agente: falha fechada antes do spawn');
        assert.ok(!sb.gate()?.fetch_dispatch, 'marcador não ficou gravado');

        const ok = await dashboardDispatch(sb, rm.url, id);
        assert.strictEqual(ok.result?.action, 'dispatched', ok.out);
        await waitFor(() => sb.claudeCalls() === 1, 10000, 'agente após falha do marcador');
    } finally {
        cleanupE2e(sb, rm, null);
    }
});
