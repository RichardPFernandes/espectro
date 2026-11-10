// node --test version-api.test.js
// Painel Versão: GET /api/version e POST /api/version/update (dashboard/version.js),
// com um "Prisma" de mentira (repo git + origin bare) e um comando de bump do consumidor.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawn } = require('node:child_process');
const { createVersion, runGroup } = require('./version');

const tmpBase = process.env.CLAUDE_JOB_DIR ? path.join(process.env.CLAUDE_JOB_DIR, 'tmp') : os.tmpdir();
const tmp = fs.mkdtempSync(path.join(tmpBase, 'version-api-'));
const gitEnv = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { env: gitEnv, encoding: 'utf8' }).trim();

const origin = path.join(tmp, 'origin.git');
const seed = path.join(tmp, 'seed');
const prisma = path.join(tmp, 'prisma');
const consumer = path.join(tmp, 'consumer');
fs.mkdirSync(path.join(consumer, 'dashboard'), { recursive: true });
execFileSync('git', ['init', '--bare', '-b', 'main', origin]);
execFileSync('git', ['clone', '-q', origin, seed]);
git(seed, 'checkout', '-q', '-b', 'main');
const shas = [];
for (const msg of ['base', 'feat: um', 'fix: dois TOKEN=abc123segredo']) {
    fs.writeFileSync(path.join(seed, 'f.txt'), msg);
    git(seed, 'add', '.'); git(seed, 'commit', '-q', '-m', msg);
    shas.push(git(seed, 'rev-parse', 'HEAD'));
}
git(seed, 'push', '-q', 'origin', 'main');
execFileSync('git', ['clone', '-q', origin, prisma]);
git(prisma, 'checkout', '-q', '--detach', shas[0]);
// Commit fora da main (branch lateral).
git(seed, 'checkout', '-q', '-b', 'side', shas[0]);
fs.writeFileSync(path.join(seed, 'g.txt'), 'side'); git(seed, 'add', '.'); git(seed, 'commit', '-q', '-m', 'side');
const sideSha = git(seed, 'rev-parse', 'HEAD');
git(seed, 'push', '-q', 'origin', 'side');
git(prisma, 'fetch', '-q', 'origin', 'side');

const bumpLog = path.join(tmp, 'bump.log');
const bump = path.join(tmp, 'bump.sh');
fs.writeFileSync(bump, `#!/bin/sh
echo "$1 pid=$PRISMA_DASHBOARD_PID" >> ${JSON.stringify(bumpLog)}
[ -n "$FAIL_BUMP" ] && { echo "falhou TOKEN=abc123segredo" >&2; exit 7; }
git -C ${JSON.stringify(prisma)} checkout -q --detach "$1"
[ -n "$FAIL_AFTER_CHECKOUT" ] && { echo "npm ci falhou" >&2; exit 9; }
echo "Pin: ok"
`);
fs.chmodSync(bump, 0o755);
const noBump = path.join(tmp, 'nobump.sh');
fs.writeFileSync(noBump, '#!/bin/sh\necho "não fiz nada"\n'); fs.chmodSync(noBump, 0o755);

function make({ env = {}, watcher = { running: false, state: 'stopped' }, lock = { lock_state: 'free', agents: [] }, requestExit = null, spawnThrows = false } = {}) {
    const spawned = [];
    const exits = [];
    const v = createVersion({
        prismaRoot: prisma, repoRoot: consumer,
        env: { ...gitEnv, PRISMA_BUMP_COMMAND: bump, ...env },
        redact: x => JSON.parse(JSON.stringify(x).split('abc123segredo').join('***')),
        watcherStatus: () => watcher,
        lockStatus: () => lock,
        requestExit: requestExit === null ? null : () => exits.push(1),
        spawnDetached: (args, opts) => { if (spawnThrows) throw new Error('EACCES'); spawned.push({ args, opts }); },
    });
    return { v, spawned, exits };
}
const reset = () => { git(prisma, 'checkout', '-q', '--detach', shas[0]); fs.rmSync(bumpLog, { force: true }); };

test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

test('AC-01: GET mostra revisão em execução, origin/main e commits entre elas, saneados', async () => {
    reset();
    const r = await make().v.read({ force: true });
    assert.equal(r.status, 'ok');
    assert.equal(r.current.sha, shas[0]); assert.equal(r.latest.sha, shas[2]);
    assert.deepEqual(r.behind.map(c => c.sha), [shas[2], shas[1]]);
    assert.ok(r.behind.every(c => !Number.isNaN(Date.parse(c.date))), "behind[].date é a data ISO do commit (coluna quando da tela Sistema)");
    assert.ok(!JSON.stringify(r).includes('abc123segredo'));
    assert.equal(r.fetch_error, null);
    assert.deepEqual(r.update, { configured: true, enabled: true, reason: null, restart: false });
});

test('AC-02: sem PRISMA_BUMP_COMMAND o painel é só leitura', async () => {
    reset();
    const { v } = make({ env: { PRISMA_BUMP_COMMAND: '' } });
    const r = await v.read();
    assert.equal(r.update.enabled, false); assert.match(r.update.reason, /PRISMA_BUMP_COMMAND/);
    const u = await v.update(shas[2]);
    assert.equal(u.status, 409); assert.ok(!fs.existsSync(bumpLog));
});

test('AC-02: restart só aparece com PRISMA_RESTART_COMMAND e requestExit', async () => {
    reset();
    assert.equal((await make({ env: { PRISMA_RESTART_COMMAND: 'x' } }).v.read()).update.restart, false);
    assert.equal((await make({ env: { PRISMA_RESTART_COMMAND: 'x' }, requestExit: true }).v.read()).update.restart, true);
});

test('AC-03: recusa com loop ativo, trava de outro watcher, agente vivo e alvo fora da main', async () => {
    reset();
    const cases = [
        [{ watcher: { running: true, state: 'running' } }, /Loop do watcher/],
        [{ watcher: { running: false, state: 'stopping' } }, /Loop do watcher/],
        [{ lock: { lock_state: 'held', agents: [] } }, /trava/],
        [{ lock: { lock_state: 'free', agents: [{ task_id: '43999-x' }] } }, /43999-x/],
    ];
    for (const [opts, re] of cases) {
        const { v } = make(opts);
        const r = await v.read();
        assert.equal(r.update.enabled, false); assert.match(r.update.reason, re);
        const u = await v.update(shas[2]);
        assert.equal(u.status, 409); assert.match(u.body.error, re);
    }
    const outside = await make().v.update(sideSha);
    assert.equal(outside.status, 409); assert.match(outside.body.error, /origin\/main/);
    assert.equal((await make().v.update('main')).status, 400);
    assert.equal((await make().v.update(`${shas[2].slice(0, 39)}"`)).status, 400);
    assert.ok(!fs.existsSync(bumpLog), 'nenhum bump executado');
    assert.equal(git(prisma, 'rev-parse', 'HEAD'), shas[0]);
});

test('AC-03: nunca dois updates ao mesmo tempo', async () => {
    reset();
    const { v } = make();
    const [a, b] = await Promise.all([v.update(shas[2]), v.update(shas[2])]);
    assert.deepEqual([a.status, b.status].sort(), [200, 409]);
    assert.equal(fs.readFileSync(bumpLog, 'utf8').trim().split('\n').length, 1);
});

test('AC-04: com tudo livre roda o bump com o alvo, sem reiniciar quando não há restart', async () => {
    reset();
    const { v, spawned, exits } = make();
    const u = await v.update(shas[1]);
    assert.equal(u.status, 200); assert.equal(u.body.restarting, false);
    assert.equal(git(prisma, 'rev-parse', 'HEAD'), shas[1]);
    assert.match(fs.readFileSync(bumpLog, 'utf8'), new RegExp(`^${shas[1]} pid=${process.pid}`));
    assert.match(u.body.update.output, /Pin: ok/);
    assert.equal(spawned.length, 0); assert.equal(exits.length, 0);
    const after = await v.read();
    assert.equal(after.current.sha, shas[0], 'em execução continua sendo a revisão do boot');
    assert.equal(after.checkout.sha, shas[1]); assert.equal(after.drift, true);
    assert.equal(after.update.enabled, false); assert.match(after.update.reason, /reinicie/);
    assert.equal(after.last_update.ok, true);
    const again = await v.update(shas[2]);
    assert.equal(again.status, 409, 'checkout divergente bloqueia novo bump até reiniciar');
});

test('AC-04: com restart, agenda processo destacado que espera este sair e depois encerra', async () => {
    reset();
    const { v, spawned, exits } = make({ env: { PRISMA_RESTART_COMMAND: 'bash start.sh dashboard' }, requestExit: true });
    const u = await v.update(shas[2]);
    assert.equal(u.status, 200); assert.equal(u.body.restarting, true);
    assert.equal(spawned.length, 1);
    const { args, opts } = spawned[0];
    assert.equal(args[0], '-c'); assert.match(args[1], /kill -0/);
    assert.equal(args[3], String(process.pid)); assert.equal(args[4], 'bash start.sh dashboard');
    assert.equal(opts.cwd, consumer);
    await new Promise(r => setTimeout(r, 400));
    assert.equal(exits.length, 1, 'requestExit chamado depois do spawn');
    const again = await v.update(shas[2]);
    assert.equal(again.status, 409, 'segura a atualização até o processo sair');
});

test('AC-05: bump com falha não reinicia; erro e saída saneada voltam', async () => {
    reset();
    const { v, spawned, exits } = make({ env: { FAIL_BUMP: '1', PRISMA_RESTART_COMMAND: 'x' }, requestExit: true });
    const u = await v.update(shas[2]);
    assert.equal(u.status, 500); assert.match(u.body.error, /exit 7/);
    assert.ok(!JSON.stringify(u.body).includes('abc123segredo'));
    assert.equal(spawned.length, 0); assert.equal(exits.length, 0);
    assert.equal(git(prisma, 'rev-parse', 'HEAD'), shas[0]);
    const r = await v.read();
    assert.equal(r.last_update.ok, false); assert.equal(r.update.enabled, true, 'pode tentar de novo');
});

test('AC-05: falha depois do checkout avisa que PRISMA_ROOT já mudou', async () => {
    reset();
    const { v, spawned } = make({ env: { FAIL_AFTER_CHECKOUT: '1', PRISMA_RESTART_COMMAND: 'x' }, requestExit: true });
    const u = await v.update(shas[2]);
    assert.equal(u.status, 500); assert.match(u.body.error, /exit 9/);
    assert.match(u.body.error, new RegExp(`PRISMA_ROOT já está em ${shas[2].slice(0, 7)}`));
    assert.equal(spawned.length, 0);
});

test('AC-04: reinício que não pode ser agendado não trava o painel', async () => {
    reset();
    const { v, exits } = make({ env: { PRISMA_RESTART_COMMAND: 'x' }, requestExit: true, spawnThrows: true });
    const u = await v.update(shas[2]);
    assert.equal(u.status, 200); assert.equal(u.body.restarting, false); assert.match(u.body.update.warning, /à mão/);
    assert.equal(v.isUpdating(), false);
    await new Promise(r => setTimeout(r, 400));
    assert.equal(exits.length, 0);
});

test('AC-03: timeout do bump mata o grupo inteiro (filhos inclusive) antes de liberar', async () => {
    const pidFile = path.join(tmp, 'child.pid');
    const r = await runGroup('/bin/sh', ['-c', `sleep 30 & echo $! > ${JSON.stringify(pidFile)}; wait`], { cwd: tmp, env: process.env, timeout: 300 });
    assert.equal(r.timedOut, true);
    const child = Number(fs.readFileSync(pidFile, 'utf8'));
    await new Promise(res => setTimeout(res, 200));
    assert.throws(() => process.kill(child, 0), 'sleep filho não pode sobreviver');
});

test('AC-05: bump que sai 0 sem mover PRISMA_ROOT é falha e não reinicia', async () => {
    reset();
    const { v, spawned } = make({ env: { PRISMA_BUMP_COMMAND: noBump, PRISMA_RESTART_COMMAND: 'x' }, requestExit: true });
    const u = await v.update(shas[2]);
    assert.equal(u.status, 500); assert.match(u.body.error, /não reiniciado/);
    assert.equal(spawned.length, 0);
});

test('dashboard: raiz de versão padrão permanece a plataforma quando não há override', async () => {
    const { createDashboard } = require('./server');
    const seen = [];
    const dash = createDashboard({
        repoRoot: consumer,
        env: { ...gitEnv, PRISMA_BUMP_COMMAND: '' },
        watcherManager: { status: () => ({ running: false, state: 'stopped' }), stop: async () => {} },
        versionExec: async (file, args, options) => {
            seen.push({ file, args, env: options.env });
            return { code: 0, stdout: `${shas[0]}\t2026-10-22T00:00:00Z\tfixture`, stderr: '' };
        },
    });
    try {
        assert.equal(seen.length, 1, 'boot consulta HEAD pelo executor existente');
        assert.equal(seen[0].file, 'git');
        assert.deepEqual(seen[0].args, ['-C', path.resolve(__dirname, '..'), 'log', '-1', '--format=%H%x09%cI%x09%s', 'HEAD']);
        assert.equal(seen[0].env.PRISMA_ROOT, path.resolve(__dirname, '..'));
    } finally { await dash.close(); }
});

test('rotas montadas no dashboard: GET /api/version e POST /api/version/update', async () => {
    reset();
    for (const name of ['dash', 'dash2']) fs.mkdirSync(path.join(tmp, name, 'memory', 'runs'), { recursive: true });
    const { createDashboard } = require('./server');
    const dash = createDashboard({
        memoryDir: path.join(tmp, 'dash', 'memory', 'runs'),
        env: { ...gitEnv, PRISMA_BUMP_COMMAND: '' },
        watcherManager: { status: () => ({ running: false, state: 'stopped' }), stop: async () => {} },
        versionPrismaRoot: prisma,
        versionLockStatus: () => ({ lock_state: 'free', agents: [] }),
    });
    const slow = path.join(tmp, 'slow.sh');
    fs.writeFileSync(slow, `#!/bin/sh\n[ "$PRISMA_ROOT" = ${JSON.stringify(prisma)} ] || exit 8\nsleep 2\nexit 3\n`); fs.chmodSync(slow, 0o755);
    const busyDash = createDashboard({
        memoryDir: path.join(tmp, 'dash2', 'memory', 'runs'),
        env: { ...gitEnv, PRISMA_BUMP_COMMAND: slow },
        watcherManager: { status: () => ({ running: false, state: 'stopped' }), start: async () => ({ started: true }), stop: async () => {} },
        versionPrismaRoot: prisma,
        versionLockStatus: () => ({ lock_state: 'free', agents: [] }),
    });
    try {
        await new Promise(resolve => dash.server.listen(0, '127.0.0.1', resolve));
        const base = `http://localhost:${dash.server.address().port}`;
        const r = await (await fetch(`${base}/api/version`)).json();
        assert.equal(r.status, 'ok'); assert.equal(r.update.configured, false);
        assert.equal(r.current.sha, shas[0]); assert.equal(r.latest.sha, shas[2]);
        const u = await fetch(`${base}/api/version/update`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ target: shas[2] }) });
        assert.equal(u.status, 409);
        // Bump lento de verdade (alvo na origin/main, ≠ HEAD): Start do watcher recusa até terminar.
        await new Promise(resolve => busyDash.server.listen(0, '127.0.0.1', resolve));
        const b = `http://localhost:${busyDash.server.address().port}`;
        const target = shas[2];
        const pending = fetch(`${b}/api/version/update`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ target }) });
        let start;
        for (let i = 0; i < 40; i++) {
            await new Promise(r => setTimeout(r, 100));
            start = await fetch(`${b}/api/watcher/start`, { method: 'POST' });
            if (start.status === 409) break;
        }
        assert.equal(start.status, 409); assert.match((await start.json()).error, /Atualização de versão/);
        const done = await pending;
        assert.equal(done.status, 500, 'slow.sh sai 3');
        assert.match((await done.json()).error, /exit 3/, 'bump recebeu o mesmo PRISMA_ROOT sintético usado pelo Git');
        assert.equal((await fetch(`${b}/api/watcher/start`, { method: 'POST' })).status, 200, 'liberado depois do bump');
    } finally { await dash.close(); await busyDash.close(); }
});

test('corrida Start/Atualizar com watcher órfão: update recusa enquanto o Start encerra o órfão', async () => {
    const { createWatcherManager } = require('../scripts/watcher-manager');
    const { createDashboard } = require('./server');
    const dir = path.join(tmp, 'orphan-race');
    fs.mkdirSync(dir, { recursive: true });
    const script = path.join(dir, 'orphan-watcher.js');
    const pidFile = path.join(dir, 'watcher.pid');
    const bumpLog = path.join(dir, 'bump.log');
    const readyFile = path.join(dir, 'ready');
    fs.writeFileSync(script, `process.on('SIGTERM', () => {});\nrequire('fs').writeFileSync(${JSON.stringify(readyFile)}, 'ready');\nsetInterval(() => {}, 1000);\n`);
    const bump = path.join(dir, 'bump.sh');
    fs.writeFileSync(bump, `#!/bin/sh\necho bump >> ${JSON.stringify(bumpLog)}\n`);
    fs.chmodSync(bump, 0o755);
    let orphan, watcherManager, dash, pending;
    try {
        orphan = spawn(process.execPath, [script], { stdio: 'ignore' });
        for (let i = 0; i < 50 && !fs.existsSync(readyFile); i++) await new Promise(r => setTimeout(r, 20));
        assert.equal(fs.existsSync(readyFile), true, 'handler de SIGTERM instalado antes do Start');
        fs.writeFileSync(pidFile, `${orphan.pid}\n`);
        watcherManager = createWatcherManager({
            repoRoot: dir, cwd: dir, script, pidFile, historyFile: null, lock: false,
            envFile: path.join(dir, 'missing.env'), stopGraceMs: 2000, intervalMs: 60000,
        });
        dash = createDashboard({
            memoryDir: path.join(dir, 'memory', 'runs'),
            env: { ...process.env, PRISMA_BUMP_COMMAND: bump },
            watcherManager,
            versionPrismaRoot: prisma,
            versionLockStatus: () => ({ lock_state: 'free', agents: [] }),
        });
        assert.equal(watcherManager.status().orphan_pid, orphan.pid);
        assert.equal(watcherManager.status().state, 'stopped');
        await new Promise(resolve => dash.server.listen(0, '127.0.0.1', resolve));
        const base = `http://127.0.0.1:${dash.server.address().port}`;
        pending = fetch(`${base}/api/watcher/start`, { method: 'POST' });
        let sawStarting = false;
        for (let i = 0; i < 50 && !sawStarting; i++) {
            if (watcherManager.status().state === 'starting') sawStarting = true;
            else await new Promise(r => setTimeout(r, 20));
        }
        assert.equal(sawStarting, true, 'Start permanece em starting durante o killOrphan');
        assert.equal(process.kill(orphan.pid, 0), true, 'órfão ainda vivo na janela');
        const update = await fetch(`${base}/api/version/update`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ target: 'a'.repeat(40) }),
        });
        assert.equal(update.status, 409);
        assert.match((await update.json()).error, /Loop do watcher/);
        assert.equal(fs.existsSync(bumpLog), false, 'bump não corre na janela do órfão');
        const started = await pending;
        assert.equal(started.status, 200);
        assert.equal((await started.json()).state, 'running');
    } finally {
        if (pending) await pending.catch(() => {});
        if (watcherManager) await watcherManager.stop();
        if (orphan) { try { process.kill(orphan.pid, 'SIGKILL'); } catch { /* já saiu */ } }
        if (dash) await dash.close();
    }
});
