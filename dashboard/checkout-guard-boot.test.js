'use strict';
// Guard do checkout na subida do dashboard (F1.2, PRI-379, AC-02). O servidor roda como
// processo filho com PRISMA_ROOT num repositório temporário sujo (origem bare local,
// config global e de sistema do git fora, autor fixo) e a flag ligada: sai com 2 antes
// de abrir a porta. Nunca o checkout vivo nem o dashboard real; a porta é livre, nunca 3333.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const GIT_ENV = {
    GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Teste', GIT_AUTHOR_EMAIL: 'teste@example.invalid', GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z',
    GIT_COMMITTER_NAME: 'Teste', GIT_COMMITTER_EMAIL: 'teste@example.invalid', GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z',
};

const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'checkout-guard-boot-')));
test.after(() => fs.rmSync(base, { recursive: true, force: true }));

function sh(cwd, ...args) {
    const r = spawnSync('git', args, { cwd, env: { ...process.env, ...GIT_ENV }, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
}

function dirtyRepo(dir = base) {
    const origin = path.join(dir, 'origin.git');
    const root = path.join(dir, 'work');
    sh(dir, 'init', '--quiet', '--bare', '--initial-branch=main', origin);
    sh(dir, 'init', '--quiet', '--initial-branch=main', root);
    fs.writeFileSync(path.join(root, 'a.txt'), 'um\n');
    sh(root, 'add', 'a.txt');
    sh(root, 'commit', '--quiet', '-m', 'um');
    sh(root, 'remote', 'add', 'origin', origin);
    sh(root, 'push', '--quiet', 'origin', 'main');
    sh(root, 'fetch', '--quiet', 'origin');
    fs.writeFileSync(path.join(root, 'solto.txt'), 'sujo\n');
    return root;
}

function freePort() {
    return new Promise((resolve, reject) => {
        const srv = net.createServer();
        srv.once('error', reject);
        srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
    });
}

function portOpen(port) {
    return new Promise(resolve => {
        const sock = net.connect({ port, host: '127.0.0.1' });
        sock.once('connect', () => { sock.destroy(); resolve(true); });
        sock.once('error', () => resolve(false));
    });
}

test('flag ligada e árvore suja: o dashboard sai com 2, cita o motivo e não abre a porta', async () => {
    const root = dirtyRepo();
    const consumer = fs.mkdtempSync(path.join(base, 'consumer-'));
    const home = fs.mkdtempSync(path.join(base, 'home-'));
    let port = await freePort();
    if (port === 3333) port = await freePort();
    assert.notEqual(port, 3333);
    // spawnSync mata só o filho que criou, se ele não sair sozinho (RED: o servidor subiria).
    const r = spawnSync(process.execPath, [path.join(__dirname, 'server.js')], {
        cwd: consumer,
        env: {
            PATH: process.env.PATH,
            HOME: home,
            TMPDIR: process.env.TMPDIR || os.tmpdir(),
            NODE_OPTIONS: process.env.NODE_OPTIONS || '',
            ...GIT_ENV,
            PRISMA_ROOT: root,
            REPO_PATH: consumer,
            PRISMA_CHECKOUT_GUARD: '1',
            PORT: String(port),
            HOST: '127.0.0.1',
        },
        encoding: 'utf8',
        timeout: 20000,
        killSignal: 'SIGKILL',
    });
    assert.equal(r.status, 2, `status ${r.status} sinal ${r.signal}\n${r.stdout}\n${r.stderr}`);
    assert.match(r.stderr, /dirty/);
    assert.match(r.stderr, /solto\.txt/);
    assert.doesNotMatch(r.stdout, /\[dashboard\] http:\/\//);
    assert.equal(await portOpen(port), false);
});

// AC-06 na subida: sem a flag, nenhum git do guard roda. Um shim de `git` no início do PATH
// registra cwd e argumentos e repassa ao git real. O servidor sobe numa porta livre e é
// encerrado pelo PID que este teste criou.
test('flag ausente: a subida não roda nenhum git do guard e abre a porta (AC-06)', async () => {
    const dir = fs.mkdtempSync(path.join(base, 'ac06-'));
    const root = dirtyRepo(dir);
    const consumer = fs.mkdtempSync(path.join(dir, 'consumer-'));
    const home = fs.mkdtempSync(path.join(dir, 'home-'));
    const memory = fs.mkdtempSync(path.join(dir, 'memory-'));
    const realGit = spawnSync('/bin/sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim();
    assert.ok(realGit, 'git real não encontrado');
    const shimDir = fs.mkdtempSync(path.join(dir, 'shim-'));
    const log = path.join(shimDir, 'calls.log');
    fs.writeFileSync(path.join(shimDir, 'git'), `#!/bin/sh\nprintf '%s\\t%s\\n' "$(pwd -P)" "$*" >> '${log}'\nexec '${realGit}' "$@"\n`, { mode: 0o755 });
    const PATH = `${shimDir}${path.delimiter}${process.env.PATH}`;
    // O shim está no caminho e registra: confere antes de subir o servidor.
    assert.equal(spawnSync('git', ['--version'], { cwd: dir, env: { PATH }, encoding: 'utf8' }).status, 0);
    assert.match(fs.readFileSync(log, 'utf8'), /\t--version\n/);
    fs.writeFileSync(log, '');

    let port = await freePort();
    if (port === 3333) port = await freePort();
    assert.notEqual(port, 3333);
    const child = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
        cwd: consumer,
        env: {
            PATH,
            HOME: home,
            TMPDIR: process.env.TMPDIR || os.tmpdir(),
            NODE_OPTIONS: process.env.NODE_OPTIONS || '',
            ...GIT_ENV,
            PRISMA_ROOT: root,
            REPO_PATH: consumer,
            MEMORY_DIR: memory,
            PORT: String(port),
            HOST: '127.0.0.1',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { err += d; });
    try {
        await new Promise((resolve, reject) => {
            const t = setTimeout(() => reject(new Error(`sem listen em 20s\n${out}\n${err}`)), 20000);
            child.stdout.on('data', () => { if (out.includes(`[dashboard] http://localhost:${port}`)) { clearTimeout(t); resolve(); } });
            child.once('exit', (code, sig) => { clearTimeout(t); reject(new Error(`saiu antes do listen: ${code} ${sig}\n${out}\n${err}`)); });
        });
        assert.equal(await portOpen(port), true);
    } finally {
        if (child.exitCode === null && child.signalCode === null) {
            const exited = new Promise(resolve => child.once('exit', resolve));
            process.kill(child.pid, 'SIGTERM');
            const t = setTimeout(() => { try { process.kill(child.pid, 'SIGKILL'); } catch {} }, 5000);
            await exited;
            clearTimeout(t);
        }
    }
    const calls = fs.readFileSync(log, 'utf8');
    assert.doesNotMatch(calls, /status --porcelain/, calls);
    assert.doesNotMatch(calls, /merge-base --is-ancestor/, calls);
});
