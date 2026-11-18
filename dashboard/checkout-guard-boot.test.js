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
const { spawnSync } = require('node:child_process');

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

function dirtyRepo() {
    const origin = path.join(base, 'origin.git');
    const root = path.join(base, 'work');
    sh(base, 'init', '--quiet', '--bare', '--initial-branch=main', origin);
    sh(base, 'init', '--quiet', '--initial-branch=main', root);
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
