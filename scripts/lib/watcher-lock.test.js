// node --test scripts/lib/watcher-lock.test.js
// Trava de instância (PRI-70): um writer por REPO_PATH. O segundo não grava e sai
// com exit 75; trava de processo morto é retomada; --dry-run não cria arquivo de trava.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFileSync } = require('child_process');

const lock = require('./watcher-lock');
const { createWatcherManager } = require('../watcher-manager');

const tmp = fs.mkdtempSync(path.join(process.env.CLAUDE_JOB_DIR ? path.join(process.env.CLAUDE_JOB_DIR, 'tmp') : os.tmpdir(), 'watcher-lock-'));
const WATCHER = path.join(__dirname, '..', 'readmine-watcher.js');
const children = [];

function gitRepo(name) {
    const repo = path.join(tmp, name);
    fs.mkdirSync(repo, { recursive: true });
    execFileSync('git', ['init', '-q', repo]);
    fs.mkdirSync(path.join(repo, 'memory', 'runs'), { recursive: true });
    return repo;
}

function filesUnder(dir) {
    const out = [];
    const walk = d => {
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
            const p = path.join(d, e.name);
            if (e.isDirectory()) walk(p);
            else out.push(p);
        }
    };
    walk(dir);
    return out.sort();
}

function track(child) { children.push(child); return child; }

function childEnv(repo, extra = {}) {
    return {
        PATH: process.env.PATH, HOME: process.env.HOME || '', USER: process.env.USER || '',
        LANG: 'C', LC_ALL: 'C', TMPDIR: process.env.TMPDIR || '/tmp',
        REPO_PATH: repo, REDMINE_URL: 'http://127.0.0.1:9', REDMINE_API_KEY: 'k',
        PLAN_SCORE_THRESHOLD: '0', SKIP_PRE_BUILD_VALIDATION: 'true',
        ...extra,
    };
}

function runNode(args, env, { timeoutMs = 25000, until } = {}) {
    return new Promise(resolve => {
        const child = track(spawn(process.execPath, args, { env, cwd: tmp, stdio: ['ignore', 'pipe', 'pipe'] }));
        let out = '';
        let done = false;
        const finish = (code, signal) => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            resolve({ code, signal, out });
        };
        const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, timeoutMs);
        const onData = buf => {
            out += buf.toString();
            if (until && until(out)) { try { child.kill('SIGKILL'); } catch {} }
        };
        child.stdout.on('data', onData);
        child.stderr.on('data', onData);
        child.on('close', finish);
        child.on('error', e => finish(null, e.message));
    });
}

test('caminho deriva do REPO_PATH, nunca de memory/ nem do checkout do script', () => {
    const repo = gitRepo('git-dir');
    const lockPath = lock.lockPathFor(repo);
    assert.strictEqual(lockPath, path.join(fs.realpathSync(repo), '.git', 'prisma-watcher.lock'));
    assert.ok(!lockPath.includes(`${path.sep}memory${path.sep}`));

    const link = path.join(tmp, 'git-dir-link');
    fs.symlinkSync(repo, link);
    assert.strictEqual(lock.lockPathFor(link), lockPath, 'fonte e candidata com o mesmo realpath se enxergam');

    const fileGit = path.join(tmp, 'git-file');
    fs.mkdirSync(fileGit);
    fs.writeFileSync(path.join(fileGit, '.git'), 'gitdir: /tmp/fora\n');
    const tmpLock = lock.lockPathFor(fileGit);
    assert.match(tmpLock, /^\/tmp\/prisma-watcher-[0-9a-f]{16}\.lock$/);
    assert.ok(!tmpLock.includes(`${path.sep}memory${path.sep}`));
});

test('segundo acquire é recusado com mensagem; processo morto e pid reciclado são retomados', () => {
    const repo = gitRepo('acquire');
    const first = lock.acquire({ repoPath: repo, role: 'watcher', env: {} });
    assert.strictEqual(first.acquired, true);
    assert.strictEqual(first.takeover, false);
    const second = lock.acquire({ repoPath: repo, role: 'watcher', env: {} });
    assert.strictEqual(second.acquired, false);
    assert.match(second.message, /outro watcher já roda neste REPO_PATH/);
    assert.match(second.message, /prisma-watcher\.lock/);
    assert.strictEqual(first.release(), true);

    const deadPid = 2 ** 22 + 4242;
    fs.writeFileSync(first.path, `${JSON.stringify({
        pid: deadPid, started_at: new Date().toISOString(), token: 'velha', hostname: os.hostname(), role: 'watcher',
    })}\n`);
    const taken = lock.acquire({ repoPath: repo, role: 'watcher', env: {} });
    assert.strictEqual(taken.acquired, true);
    assert.strictEqual(taken.takeover, true, 'trava de processo morto é retomada');
    taken.release();

    const recycled = lock.acquire({ repoPath: repo, role: 'watcher', env: {} });
    const data = lock.readLock(recycled.path).data;
    data.started_at = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    fs.writeFileSync(recycled.path, `${JSON.stringify(data)}\n`);
    const again = lock.acquire({ repoPath: repo, role: 'watcher', env: {} });
    assert.strictEqual(again.takeover, true, 'pid reciclado (outro início) não segura a trava');
    again.release();

    fs.writeFileSync(first.path, `${JSON.stringify({
        pid: deadPid, started_at: new Date(0).toISOString(), token: 'outra-maquina', hostname: 'host-que-nao-e-este', role: 'watcher',
    })}\n`);
    const remote = lock.acquire({ repoPath: repo, role: 'watcher', env: {} });
    assert.strictEqual(remote.acquired, false, 'trava de outro host conta como viva');
    fs.unlinkSync(first.path);
});

test('tick filho entra com o token do laço e, ao sair, não solta a trava do laço', () => {
    const repo = gitRepo('nested');
    const loop = lock.acquire({ repoPath: repo, role: 'loop', env: {} });
    const tick = lock.acquire({
        repoPath: repo, role: 'watcher', pid: process.pid,
        env: { [lock.TOKEN_ENV]: loop.holder.token },
    });
    assert.strictEqual(tick.acquired, true);
    assert.strictEqual(tick.nested, true);
    assert.strictEqual(lock.readLock(loop.path).data.tick.pid, process.pid);
    const outsider = lock.acquire({ repoPath: repo, role: 'watcher', env: {} });
    assert.strictEqual(outsider.acquired, false);
    assert.strictEqual(tick.release(), true);
    assert.strictEqual(lock.readLock(loop.path).data.tick, undefined);
    assert.strictEqual(lock.holderAlive(lock.readLock(loop.path).data), true);
    assert.strictEqual(loop.release(), true);
    assert.strictEqual(lock.readLock(loop.path).missing, true);
});

test('laço do dashboard segura a trava entre ticks; o segundo laço não dispara tick', async () => {
    const repo = gitRepo('loop');
    const marker = path.join(repo, 'ticks.log');
    const script = path.join(tmp, 'fake-tick.js');
    fs.writeFileSync(script, `require('fs').appendFileSync(${JSON.stringify(marker)}, 'tick\\n');`);
    const opts = {
        script, repoRoot: repo, cwd: repo, envFile: null, historyFile: null,
        pidFile: path.join(repo, 'watcher.pid'), intervalMs: 60000, stopGraceMs: 400,
    };
    const first = createWatcherManager(opts);
    const st = await first.start();
    assert.strictEqual(st.running, true);
    assert.strictEqual(st.error, null);
    await new Promise(r => setTimeout(r, 200));
    assert.strictEqual(fs.readFileSync(marker, 'utf8'), 'tick\n');
    assert.strictEqual(lock.holderAlive(lock.readLock(lock.lockPathFor(repo)).data), true, 'entre ticks a trava continua');

    const second = createWatcherManager({ ...opts, pidFile: path.join(repo, 'watcher-2.pid') });
    const refused = await second.start();
    assert.strictEqual(refused.running, false);
    assert.strictEqual(refused.error, 'lock_held');
    assert.match(second.getLogBuffer().map(e => e.text).join('\n'), /outro watcher já roda neste REPO_PATH/);
    assert.strictEqual(fs.readFileSync(marker, 'utf8'), 'tick\n', 'o segundo laço não rodou tick');

    await first.stop();
    assert.strictEqual(lock.readLock(lock.lockPathFor(repo)).missing, true);
});

test('trava velha: o laço retoma e sobe', async () => {
    const repo = gitRepo('stale-loop');
    const lockPath = lock.lockPathFor(repo);
    fs.writeFileSync(lockPath, `${JSON.stringify({
        pid: 2 ** 22 + 7, started_at: new Date().toISOString(), token: 'morta', hostname: os.hostname(), role: 'loop',
    })}\n`);
    const script = path.join(tmp, 'fake-stale.js');
    const marker = path.join(repo, 'stale.log');
    fs.writeFileSync(script, `require('fs').writeFileSync(${JSON.stringify(marker)}, 'ok');`);
    const m = createWatcherManager({
        script, repoRoot: repo, cwd: repo, envFile: null, historyFile: null,
        pidFile: path.join(repo, 'watcher.pid'), intervalMs: 60000, stopGraceMs: 400,
    });
    const st = await m.start();
    assert.strictEqual(st.running, true);
    assert.match(m.getLogBuffer().map(e => e.text).join('\n'), /trava velha retomada/);
    await new Promise(r => setTimeout(r, 200));
    assert.strictEqual(fs.readFileSync(marker, 'utf8'), 'ok');
    await m.stop();
});

test('segundo watcher real não grava nada e sai 75; --ticket igual; --dry-run não cria trava', { timeout: 90000 }, async () => {
    const repo = gitRepo('real');
    const holderJs = path.join(tmp, 'holder.js');
    fs.writeFileSync(holderJs, `
        const lock = require(${JSON.stringify(path.join(__dirname, 'watcher-lock.js'))});
        const res = lock.acquire({ repoPath: process.argv[2], role: 'watcher' });
        if (!res.acquired) { console.error(res.message); process.exit(1); }
        console.log('HELD');
        setInterval(() => {}, 1000);
    `);
    const holder = track(spawn(process.execPath, [holderJs, repo], { stdio: ['ignore', 'pipe', 'pipe'] }));
    let held = '';
    holder.stdout.on('data', d => { held += d; });
    holder.stderr.on('data', d => { held += d; });
    for (const end = Date.now() + 5000; Date.now() < end && !held.includes('HELD');) {
        await new Promise(r => setTimeout(r, 30));
    }
    assert.match(held, /HELD/, 'holder não adquiriu a trava');

    const before = filesUnder(repo);
    const refused = await runNode([WATCHER], childEnv(repo));
    assert.strictEqual(refused.code, lock.EXIT_LOCKED);
    assert.match(refused.out, /\[lock\] outro watcher já roda neste REPO_PATH/);
    assert.match(refused.out, /Nada foi gravado/);
    assert.deepStrictEqual(filesUnder(repo), before, 'tick recusado não cria nem altera arquivo');

    const beforeTicket = filesUnder(repo);
    const refusedTicket = await runNode([WATCHER, '--ticket=43210'], childEnv(repo));
    assert.strictEqual(refusedTicket.code, lock.EXIT_LOCKED);
    assert.match(refusedTicket.out, /Nada foi gravado/);
    assert.deepStrictEqual(filesUnder(repo), beforeTicket);

    holder.kill('SIGKILL');
    await new Promise(r => holder.once('exit', r));
    const resumed = await runNode([WATCHER], childEnv(repo), {
        until: text => /trava velha retomada|AVISO: binário|\[custo\]|\[qa-retry\]|ECONNREFUSED|fetch failed|Polling/.test(text),
    });
    assert.notStrictEqual(resumed.code, lock.EXIT_LOCKED);
    assert.match(resumed.out, /trava velha retomada/);
    assert.doesNotMatch(resumed.out, /outro watcher já roda neste REPO_PATH/);

    const dry = gitRepo('dry');
    const dryRun = await runNode([WATCHER, '--dry-run'], childEnv(dry), {
        until: text => /AVISO: binário|\[dry-run\]|\[custo\]|\[qa-retry\]|ECONNREFUSED|fetch failed|Polling/.test(text),
    });
    assert.notStrictEqual(dryRun.code, lock.EXIT_LOCKED);
    assert.doesNotMatch(dryRun.out, /\[lock\]/);
    assert.ok(!filesUnder(dry).some(f => path.basename(f) === 'prisma-watcher.lock'));
    assert.ok(!fs.existsSync(lock.lockPathFor(dry)), '--dry-run não cria a trava');
    assert.ok(!fs.existsSync(path.join(dry, 'memory', 'prisma-watcher.lock')));
});

test.after(() => {
    for (const c of children) { try { c.kill('SIGKILL'); } catch {} }
    fs.rmSync(tmp, { recursive: true, force: true });
});
