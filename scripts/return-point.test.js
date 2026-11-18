'use strict';
// CLI do ponto de retorno (F1.2, AC-01): roda como processo filho em repositórios temporários
// com origem bare local. PORT aponta para uma porta sem nada escutando ou para um servidor
// falso em loopback; nunca a 3333. REPO_PATH do ambiente não vaza para o filho.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { execFile, spawnSync } = require('node:child_process');
const { runGit, mark } = require('./lib/return-point');
const { LOCK_NAME } = require('./lib/watcher-lock');

const CLI = path.join(__dirname, 'return-point.js');
const { REPO_PATH: _repo, PORT: _port, ...BASE_ENV } = process.env;
const GIT_ENV = {
    ...BASE_ENV,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Teste',
    GIT_AUTHOR_EMAIL: 'teste@example.invalid',
    GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z',
    GIT_COMMITTER_NAME: 'Teste',
    GIT_COMMITTER_EMAIL: 'teste@example.invalid',
    GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z',
};

const dirs = [];
test.after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

function tmp() {
    const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'return-point-cli-')));
    dirs.push(d);
    return d;
}

function sh(cwd, ...args) {
    const r = spawnSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
    return r.stdout.trim();
}

const git = (args, opts) => runGit(args, { ...opts, env: GIT_ENV });
const okHealth = async () => ({ ok: true, items: [{ name: 'arvore', status: 'pass', reason: 'teste' }] });

// Clone de uma origem bare com dois commits na main; o log do mark é ignorado como no repo.
function cloneOnMain() {
    const base = tmp();
    const origin = path.join(base, 'origin.git');
    const seed = path.join(base, 'seed');
    const root = path.join(base, 'work');
    sh(base, 'init', '--quiet', '--bare', '--initial-branch=main', origin);
    sh(base, 'init', '--quiet', '--initial-branch=main', seed);
    fs.writeFileSync(path.join(seed, 'a.txt'), 'um\n');
    fs.writeFileSync(path.join(seed, '.gitignore'), '**/logs/**/*.jsonl\n');
    sh(seed, 'add', '.');
    sh(seed, 'commit', '--quiet', '-m', 'primeiro');
    fs.writeFileSync(path.join(seed, 'a.txt'), 'dois\n');
    sh(seed, 'commit', '--quiet', '-am', 'segundo');
    sh(seed, 'remote', 'add', 'origin', origin);
    sh(seed, 'push', '--quiet', 'origin', 'main');
    sh(base, 'clone', '--quiet', origin, root);
    return root;
}

function advance(root, n, file = 'a.txt') {
    for (let i = 0; i < n; i++) {
        fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
        fs.writeFileSync(path.join(root, file), `avanço ${i} ${sh(root, 'rev-parse', 'HEAD')}\n`);
        sh(root, 'add', file);
        sh(root, 'commit', '--quiet', '-m', `avanço ${i}`);
    }
}

// Repo do consumidor: só um .git/ (a trava mora nele). held = trava com dono vivo (este processo).
function consumerRepo({ held = false } = {}) {
    const d = tmp();
    fs.mkdirSync(path.join(d, '.git'));
    if (held) {
        fs.writeFileSync(path.join(d, '.git', LOCK_NAME), JSON.stringify({ version: 1, role: 'loop', pid: process.pid, hostname: os.hostname(), acquired_at: new Date().toISOString() }));
    }
    return d;
}

async function closedPort() {
    const s = http.createServer();
    await new Promise(r => s.listen(0, '127.0.0.1', r));
    const { port } = s.address();
    await new Promise(r => s.close(r));
    return port;
}

function fakeDashboard(routes) {
    const server = http.createServer((req, res) => {
        const r = routes[req.url];
        if (!r) { res.writeHead(404); return res.end(); }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(r));
    });
    return new Promise(resolve => server.listen(0, '127.0.0.1', () => {
        const close = () => new Promise(done => { server.closeAllConnections(); server.close(() => done()); });
        resolve({ port: server.address().port, close });
    }));
}

// Processo filho assíncrono: o servidor falso deste processo continua respondendo.
async function cli(args, { port, env = {} } = {}) {
    const p = port ?? await closedPort();
    return new Promise(resolve => {
        execFile(process.execPath, [CLI, ...args], { env: { ...GIT_ENV, PORT: String(p), ...env }, encoding: 'utf8', timeout: 30000 }, (err, stdout, stderr) => {
            resolve({ code: err ? err.code : 0, stdout, stderr });
        });
    });
}

async function markedAndAdvanced() {
    const root = cloneOnMain();
    const green = sh(root, 'rev-parse', 'HEAD');
    const m = await mark({ root, git, health: okHealth, now: () => new Date('2026-11-18T09:05:07Z') });
    advance(root, 2);
    return { root, green, tag: m.tag };
}

test('status: árvore limpa sem verde sai com 0 e diz que não há verde', async () => {
    const root = cloneOnMain();
    const r = await cli(['status', '--root', root]);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /limpa/);
    assert.match(r.stdout, /último verde:\s+nenhum/);
});

test('status --json: árvore e último verde, sem caminho absoluto', async () => {
    const { root, tag } = await markedAndAdvanced();
    sh(root, 'push', '--quiet', 'origin', 'HEAD:main');
    sh(root, 'fetch', '--quiet', 'origin');
    const r = await cli(['status', '--root', root, '--json']);
    assert.equal(r.code, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.deepEqual(out, { tree: { ok: true, reasons: [], paths: [], head: sh(root, 'rev-parse', 'HEAD') }, last_green: tag });
    assert.ok(!r.stdout.includes(root) && !r.stdout.includes(os.tmpdir()));
});

test('status: árvore suja sai com 1 e lista o caminho', async () => {
    const root = cloneOnMain();
    fs.writeFileSync(path.join(root, 'solto.txt'), 'x\n');
    const r = await cli(['status', `--root=${root}`]);
    assert.equal(r.code, 1);
    assert.match(r.stdout, /suja/);
    assert.match(r.stdout, /solto\.txt/);
});

test('mark: dashboard sem resposta reprova, sai com 1 e não cria tag', async () => {
    const root = cloneOnMain();
    const r = await cli(['mark', '--root', root, '--repo', consumerRepo()]);
    assert.equal(r.code, 1);
    assert.match(r.stdout, /dashboard/);
    assert.equal(sh(root, 'tag', '-l', 'verde/*'), '');
    const log = fs.readFileSync(path.join(root, 'logs', 'return-point.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
    assert.equal(log.length, 1);
    assert.equal(log[0].ok, false);
});

test('mark: com o dashboard falso em ordem cria a tag e sai com 0', async () => {
    const root = cloneOnMain();
    const head = sh(root, 'rev-parse', 'HEAD');
    const srv = await fakeDashboard({
        '/api/version': { status: 'ok', started_at: '2026-11-18T08:00:00.000Z', current: { sha: head }, drift: false },
        '/api/watcher/status': { running: true, state: 'running', error: null, restarts: 0, ticks: 2, phase: 'idle', last_run: null },
    });
    let r;
    try { r = await cli(['mark', '--root', root, '--repo', consumerRepo(), '--json'], { port: srv.port }); } finally { await srv.close(); }
    assert.equal(r.code, 0, r.stdout + r.stderr);
    const out = JSON.parse(r.stdout);
    assert.equal(out.ok, true);
    assert.match(out.tag, /^verde\/\d{8}-\d{6}$/);
    assert.equal(sh(root, 'rev-parse', `${out.tag}^{commit}`), head);
    assert.ok(!r.stdout.includes(root) && !r.stdout.includes(os.tmpdir()));
});

test('mark: sem --repo nem REPO_PATH a trava reprova, sai com 1 e não cria tag', async () => {
    const root = cloneOnMain();
    const head = sh(root, 'rev-parse', 'HEAD');
    const srv = await fakeDashboard({
        '/api/version': { status: 'ok', started_at: '2026-11-18T08:00:00.000Z', current: { sha: head }, drift: false },
        '/api/watcher/status': { running: true, state: 'running', error: null, restarts: 0, ticks: 2, phase: 'idle', last_run: null },
    });
    let r;
    try { r = await cli(['mark', '--root', root, '--json'], { port: srv.port }); } finally { await srv.close(); }
    assert.equal(r.code, 1, r.stdout + r.stderr);
    const out = JSON.parse(r.stdout);
    assert.equal(out.ok, false);
    const trava = out.items.find(i => i.name === 'trava');
    assert.equal(trava.status, 'fail');
    assert.match(trava.reason, /repo do consumidor não informado \(--repo ou REPO_PATH\)/);
    assert.equal(sh(root, 'tag', '-l', 'verde/*'), '');
    const log = fs.readFileSync(path.join(root, 'logs', 'return-point.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
    assert.equal(log.length, 1);
    assert.equal(log[0].ok, false);
});

test('back: volta ao último verde, sai com 0 e diz para reiniciar o dashboard', async () => {
    const { root, green, tag } = await markedAndAdvanced();
    const r = await cli(['back', '--root', root, '--repo', consumerRepo()]);
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.equal(sh(root, 'rev-parse', 'HEAD'), green);
    assert.ok(r.stdout.includes(tag));
    assert.match(r.stdout, /reinici/i);
});

test('back --to escolhe outra tag verde', async () => {
    const root = cloneOnMain();
    const first = sh(root, 'rev-parse', 'HEAD');
    await mark({ root, git, health: okHealth, now: () => new Date('2026-11-18T09:05:07Z') });
    advance(root, 1);
    await mark({ root, git, health: okHealth, now: () => new Date('2026-11-18T09:05:08Z') });
    advance(root, 1);
    const r = await cli(['back', '--root', root, '--repo', consumerRepo(), '--to', 'verde/20261118-090507']);
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.equal(sh(root, 'rev-parse', 'HEAD'), first);
});

test('back: lock de dependência diferente gera aviso e a volta acontece', async () => {
    const root = cloneOnMain();
    const green = sh(root, 'rev-parse', 'HEAD');
    await mark({ root, git, health: okHealth, now: () => new Date('2026-11-18T09:05:07Z') });
    advance(root, 1, 'scripts/package-lock.json');
    const r = await cli(['back', '--root', root, '--repo', consumerRepo()]);
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.equal(sh(root, 'rev-parse', 'HEAD'), green);
    assert.match(r.stdout, /aviso:.*scripts\/package-lock\.json/);
});

async function refusedViaCli(root, args, opts, pattern) {
    const before = sh(root, 'rev-parse', 'HEAD');
    const branch = sh(root, 'symbolic-ref', '-q', 'HEAD');
    const r = await cli(['back', '--root', root, ...args], opts);
    assert.equal(r.code, 1, r.stdout + r.stderr);
    assert.match(r.stdout + r.stderr, pattern);
    assert.equal(sh(root, 'rev-parse', 'HEAD'), before);
    assert.equal(sh(root, 'symbolic-ref', '-q', 'HEAD'), branch);
    return r;
}

test('back: sem tag verde sai com 1 e HEAD igual', async () => {
    const root = cloneOnMain();
    await refusedViaCli(root, ['--repo', consumerRepo()], {}, /verde/);
});

test('back: --to fora de verde/* sai com 1 e HEAD igual', async () => {
    const { root } = await markedAndAdvanced();
    await refusedViaCli(root, ['--repo', consumerRepo(), '--to', 'main'], {}, /verde/);
});

test('back: árvore suja sai com 1, HEAD igual, e cita o caminho', async () => {
    const { root } = await markedAndAdvanced();
    fs.writeFileSync(path.join(root, 'solto.txt'), 'x\n');
    await refusedViaCli(root, ['--repo', consumerRepo()], {}, /solto\.txt/);
});

test('back: trava viva no repo do consumidor sai com 1 e HEAD igual', async () => {
    const { root } = await markedAndAdvanced();
    await refusedViaCli(root, ['--repo', consumerRepo({ held: true })], {}, /trava/);
});

test('back: sem --repo nem REPO_PATH recusa com o motivo', async () => {
    const { root } = await markedAndAdvanced();
    await refusedViaCli(root, [], {}, /repo do consumidor não informado \(--repo ou REPO_PATH\)/);
});

test('back: REPO_PATH no ambiente vale como --repo', async () => {
    const { root } = await markedAndAdvanced();
    await refusedViaCli(root, [], { env: { REPO_PATH: consumerRepo({ held: true }) } }, /trava/);
});

test('back: watcher rodando segundo o dashboard sai com 1 e HEAD igual', async () => {
    const { root } = await markedAndAdvanced();
    const srv = await fakeDashboard({ '/api/watcher/status': { running: true, state: 'running' } });
    try {
        await refusedViaCli(root, ['--repo', consumerRepo()], { port: srv.port }, /watcher/);
    } finally { await srv.close(); }
});

test('back --json: objeto da volta, sem caminho absoluto', async () => {
    const { root, green, tag } = await markedAndAdvanced();
    const repo = consumerRepo();
    const r = await cli(['back', '--root', root, '--repo', repo, '--json']);
    assert.equal(r.code, 0, r.stdout + r.stderr);
    const out = JSON.parse(r.stdout);
    assert.equal(out.ok, true);
    assert.equal(out.tag, tag);
    assert.equal(out.head, green);
    assert.ok(!r.stdout.includes(root) && !r.stdout.includes(repo) && !r.stdout.includes(os.tmpdir()));
});

test('uso errado sai com 2 sem tocar no repositório', async () => {
    const root = cloneOnMain();
    const before = sh(root, 'rev-parse', 'HEAD');
    const cases = [
        [],
        ['voltar', '--root', root],
        ['status', '--root'],
        ['status', '--root', root, '--talvez'],
        ['status', '--root', root, '--to', 'verde/20261118-090507'],
        ['back', '--root', root, '--to'],
        ['back', `--root=`],
    ];
    for (const args of cases) {
        const r = await cli(args);
        assert.equal(r.code, 2, `${JSON.stringify(args)}: ${r.stdout}${r.stderr}`);
        assert.match(r.stderr, /Uso:/);
    }
    assert.equal(sh(root, 'rev-parse', 'HEAD'), before);
    assert.ok(!fs.existsSync(path.join(root, 'logs')));
});
