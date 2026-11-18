'use strict';
// Conferência da árvore do ponto de retorno (F1.2, AC-02). Repositórios temporários com
// origem bare local; config global e de sistema do git fora, autor fixo.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { checkTree, guardEnabled, runGit, lastGreen, mark } = require('./return-point');

const GIT_ENV = {
    ...process.env,
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
    const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'return-point-')));
    dirs.push(d);
    return d;
}

function sh(cwd, ...args) {
    const r = spawnSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
    return r.stdout.trim();
}

// git injetado: o mesmo runner padrão, com o ambiente isolado do teste.
const git = (args, opts) => runGit(args, { ...opts, env: GIT_ENV });

// Clone de uma origem bare com dois commits na main, já com origin/main.
function cloneOnMain() {
    const base = tmp();
    const origin = path.join(base, 'origin.git');
    const seed = path.join(base, 'seed');
    const root = path.join(base, 'work');
    sh(base, 'init', '--quiet', '--bare', '--initial-branch=main', origin);
    sh(base, 'init', '--quiet', '--initial-branch=main', seed);
    fs.writeFileSync(path.join(seed, 'a.txt'), 'um\n');
    fs.writeFileSync(path.join(seed, '.gitignore'), 'ignorado.log\n');
    sh(seed, 'add', '.');
    sh(seed, 'commit', '--quiet', '-m', 'primeiro');
    fs.writeFileSync(path.join(seed, 'a.txt'), 'dois\n');
    sh(seed, 'commit', '--quiet', '-am', 'segundo');
    sh(seed, 'remote', 'add', 'origin', origin);
    sh(seed, 'push', '--quiet', 'origin', 'main');
    sh(base, 'clone', '--quiet', origin, root);
    return root;
}

test('árvore limpa na main passa', () => {
    const root = cloneOnMain();
    const r = checkTree({ root, git });
    assert.equal(r.ok, true);
    assert.deepEqual(r.reasons, []);
    assert.deepEqual(r.paths, []);
    assert.equal(r.head, sh(root, 'rev-parse', 'HEAD'));
});

test('runner padrão (sem git injetado) também confere a árvore limpa', () => {
    const root = cloneOnMain();
    const r = checkTree({ root });
    assert.equal(r.ok, true);
    assert.deepEqual(r.reasons, []);
});

test('arquivo rastreado modificado suja a árvore', () => {
    const root = cloneOnMain();
    fs.writeFileSync(path.join(root, 'a.txt'), 'mexido\n');
    const r = checkTree({ root, git });
    assert.equal(r.ok, false);
    assert.deepEqual(r.reasons, ['dirty']);
    assert.deepEqual(r.paths, ['a.txt']);
});

test('arquivo não rastreado suja a árvore', () => {
    const root = cloneOnMain();
    fs.writeFileSync(path.join(root, 'novo arquivo.txt'), 'x\n');
    const r = checkTree({ root, git });
    assert.equal(r.ok, false);
    assert.deepEqual(r.reasons, ['dirty']);
    assert.deepEqual(r.paths, ['novo arquivo.txt']);
});

test('arquivo ignorado não suja a árvore', () => {
    const root = cloneOnMain();
    fs.writeFileSync(path.join(root, 'ignorado.log'), 'x\n');
    const r = checkTree({ root, git });
    assert.equal(r.ok, true);
    assert.deepEqual(r.reasons, []);
});

test('branch com commit fora da main é recusada', () => {
    const root = cloneOnMain();
    sh(root, 'checkout', '--quiet', '-b', 'outra');
    fs.writeFileSync(path.join(root, 'b.txt'), 'b\n');
    sh(root, 'add', 'b.txt');
    sh(root, 'commit', '--quiet', '-m', 'fora da main');
    const r = checkTree({ root, git });
    assert.equal(r.ok, false);
    assert.deepEqual(r.reasons, ['off_main']);
    assert.deepEqual(r.paths, []);
});

test('HEAD destacado numa revisão antiga da main passa', () => {
    const root = cloneOnMain();
    sh(root, 'checkout', '--quiet', '--detach', 'HEAD~1');
    const r = checkTree({ root, git });
    assert.equal(r.ok, true);
    assert.deepEqual(r.reasons, []);
    assert.equal(r.head, sh(root, 'rev-parse', 'HEAD'));
});

test('diretório sem git é not_git', () => {
    const root = tmp();
    const r = checkTree({ root, git });
    assert.equal(r.ok, false);
    assert.deepEqual(r.reasons, ['not_git']);
    assert.deepEqual(r.paths, []);
    assert.equal(r.head, null);
});

test('repositório sem origin/main é no_origin_main', () => {
    const root = tmp();
    sh(root, 'init', '--quiet', '--initial-branch=main');
    fs.writeFileSync(path.join(root, 'a.txt'), 'um\n');
    sh(root, 'add', '.');
    sh(root, 'commit', '--quiet', '-m', 'primeiro');
    const r = checkTree({ root, git });
    assert.equal(r.ok, false);
    assert.deepEqual(r.reasons, ['no_origin_main']);
});

test('mais de 10 caminhos sujos: lista corta em 10', () => {
    const root = cloneOnMain();
    for (let i = 0; i < 12; i++) fs.writeFileSync(path.join(root, `f${String(i).padStart(2, '0')}.txt`), 'x\n');
    const r = checkTree({ root, git });
    assert.equal(r.ok, false);
    assert.deepEqual(r.reasons, ['dirty']);
    assert.equal(r.paths.length, 10);
});

test('sujo e fora da main: os dois motivos', () => {
    const root = cloneOnMain();
    sh(root, 'checkout', '--quiet', '-b', 'outra');
    fs.writeFileSync(path.join(root, 'b.txt'), 'b\n');
    sh(root, 'add', 'b.txt');
    sh(root, 'commit', '--quiet', '-m', 'fora da main');
    fs.writeFileSync(path.join(root, 'c.txt'), 'c\n');
    const r = checkTree({ root, git });
    assert.equal(r.ok, false);
    assert.deepEqual(r.reasons, ['dirty', 'off_main']);
    assert.deepEqual(r.paths, ['c.txt']);
});

test('a conferência não mexe em refs', () => {
    const root = cloneOnMain();
    const before = sh(root, 'for-each-ref', '--format=%(refname) %(objectname)');
    checkTree({ root, git });
    assert.equal(sh(root, 'for-each-ref', '--format=%(refname) %(objectname)'), before);
});

test('guardEnabled: 1, true e sim ligam; o resto desliga', () => {
    for (const v of ['1', 'true', 'sim', 'TRUE', ' Sim ']) assert.equal(guardEnabled({ PRISMA_CHECKOUT_GUARD: v }), true, v);
    for (const v of [undefined, '', '0', 'false', 'não', 'yes', 'on', '2']) assert.equal(guardEnabled({ PRISMA_CHECKOUT_GUARD: v }), false, String(v));
    assert.equal(guardEnabled({}), false);
});

// Marca de último verde e log (F1.2, AC-03).
const at = iso => () => new Date(iso);
const readLog = root => fs.readFileSync(path.join(root, 'logs', 'return-point.jsonl'), 'utf8')
    .split('\n').filter(Boolean).map(l => JSON.parse(l));
const okHealth = async () => ({ ok: true, items: [{ name: 'dashboard', status: 'ok' }] });
const badHealth = () => ({ ok: false, items: [{ name: 'dashboard', status: 'falha' }] });

test('lastGreen sem tag verde devolve null', () => {
    const root = cloneOnMain();
    assert.equal(lastGreen({ root, git }), null);
});

test('mark com checagem que passa cria a tag anotada no HEAD e uma linha no log', async () => {
    const root = cloneOnMain();
    const head = sh(root, 'rev-parse', 'HEAD');
    const r = await mark({ root, git, health: okHealth, now: at('2026-11-18T09:05:07Z') });
    assert.equal(r.ok, true);
    assert.equal(r.tag, 'verde/20261118-090507');
    assert.equal(r.head, head);
    assert.deepEqual(r.items, [{ name: 'dashboard', status: 'ok' }]);
    assert.equal(sh(root, 'cat-file', '-t', 'refs/tags/verde/20261118-090507'), 'tag');
    assert.equal(sh(root, 'rev-parse', 'verde/20261118-090507^{commit}'), head);
    const note = JSON.parse(sh(root, 'tag', '-l', '--format=%(contents)', 'verde/20261118-090507'));
    assert.deepEqual(note, { at: '2026-11-18T09:05:07.000Z', head, ok: true, items: r.items });
    assert.deepEqual(readLog(root), [{ at: '2026-11-18T09:05:07.000Z', head, tag: 'verde/20261118-090507', ok: true, items: r.items }]);
    assert.equal(lastGreen({ root, git }), 'verde/20261118-090507');
});

test('mark com checagem que reprova não cria tag, grava a linha e devolve ok false', async () => {
    const root = cloneOnMain();
    const head = sh(root, 'rev-parse', 'HEAD');
    const r = await mark({ root, git, health: badHealth, now: at('2026-11-18T09:05:07Z') });
    assert.equal(r.ok, false);
    assert.equal(r.tag, null);
    assert.equal(sh(root, 'tag', '-l', 'verde/*'), '');
    assert.deepEqual(readLog(root), [{ at: '2026-11-18T09:05:07.000Z', head, tag: null, ok: false, items: r.items }]);
    assert.equal(lastGreen({ root, git }), null);
});

test('duas marcas seguidas: lastGreen devolve a segunda e o log tem duas linhas', async () => {
    const root = cloneOnMain();
    await mark({ root, git, health: okHealth, now: at('2026-11-18T09:05:07Z') });
    await mark({ root, git, health: okHealth, now: at('2026-11-18T09:05:08Z') });
    assert.equal(lastGreen({ root, git }), 'verde/20261118-090508');
    assert.deepEqual(readLog(root).map(l => l.tag), ['verde/20261118-090507', 'verde/20261118-090508']);
});

test('colisão de nome é erro e não sobrescreve a tag original', async () => {
    const root = cloneOnMain();
    await mark({ root, git, health: okHealth, now: at('2026-11-18T09:05:07Z') });
    const before = sh(root, 'rev-parse', 'refs/tags/verde/20261118-090507');
    sh(root, 'commit', '--quiet', '--allow-empty', '-m', 'terceiro');
    await assert.rejects(
        mark({ root, git, health: okHealth, now: at('2026-11-18T09:05:07Z') }),
        /verde\/20261118-090507/,
    );
    assert.equal(sh(root, 'rev-parse', 'refs/tags/verde/20261118-090507'), before);
});

test('o log não tem caminho absoluto nem grava fora da raiz', async () => {
    const root = cloneOnMain();
    const parent = path.dirname(root);
    const siblings = fs.readdirSync(parent).sort();
    await mark({ root, git, health: okHealth, now: at('2026-11-18T09:05:07Z') });
    await mark({ root, git, health: badHealth, now: at('2026-11-18T09:05:08Z') });
    const raw = fs.readFileSync(path.join(root, 'logs', 'return-point.jsonl'), 'utf8');
    assert.ok(!raw.includes(root), 'log cita a raiz');
    assert.ok(!raw.includes(os.tmpdir()), 'log cita o tmpdir');
    assert.ok(!/"\/(Users|home|private|tmp|var)\//.test(raw), 'log tem caminho absoluto');
    assert.deepEqual(fs.readdirSync(parent).sort(), siblings);
});

test('mark não publica a tag na origem', async () => {
    const root = cloneOnMain();
    await mark({ root, git, health: okHealth, now: at('2026-11-18T09:05:07Z') });
    assert.equal(sh(root, 'ls-remote', '--tags', 'origin'), '');
});

// Checagem de saúde (F1.2, AC-03). Servidor falso em loopback, porta 0; nunca o dashboard real.
const http = require('node:http');
const { health } = require('./return-point');
const { LOCK_NAME } = require('./watcher-lock');

const BOOT = '2026-11-18T08:00:00.000Z';
// Rotas do servidor falso: valor = { code, body } ou 'hang' (nunca responde).
function fakeDashboard(routes) {
    const server = http.createServer((req, res) => {
        const r = routes[req.url];
        if (r === 'hang') return;
        if (!r) { res.writeHead(404); return res.end(); }
        res.writeHead(r.code || 200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(r.body));
    });
    return new Promise(resolve => server.listen(0, '127.0.0.1', () => {
        const close = () => new Promise(done => { server.closeAllConnections(); server.close(() => done()); });
        resolve({ baseUrl: `http://127.0.0.1:${server.address().port}`, close });
    }));
}
const versionOk = head => ({ body: { status: 'ok', started_at: BOOT, current: { sha: head }, drift: false } });
const watcherOk = (extra = {}) => ({ body: { running: true, state: 'running', error: null, restarts: 0, ticks: 2, phase: 'idle', last_run: null, ...extra } });
const byName = r => Object.fromEntries(r.items.map(i => [i.name, i]));

async function healthWith(root, routes, extra = {}) {
    const srv = await fakeDashboard(routes);
    try { return await health({ root, baseUrl: srv.baseUrl, git, ...extra }); } finally { await srv.close(); }
}

test('health: tudo em ordem passa os quatro itens, com o fetch e a trava padrão', async () => {
    const root = cloneOnMain();
    const head = sh(root, 'rev-parse', 'HEAD');
    const r = await healthWith(root, { '/api/version': versionOk(head), '/api/watcher/status': watcherOk() });
    assert.equal(r.ok, true);
    assert.deepEqual(r.items.map(i => [i.name, i.status]), [['arvore', 'pass'], ['dashboard', 'pass'], ['trava', 'pass'], ['tick', 'pass']]);
    for (const i of r.items) assert.equal(typeof i.reason, 'string');
    const raw = JSON.stringify(r);
    assert.ok(!raw.includes(root) && !raw.includes(os.tmpdir()), 'itens citam caminho absoluto');
});

test('health: árvore suja reprova o item arvore', async () => {
    const root = cloneOnMain();
    const head = sh(root, 'rev-parse', 'HEAD');
    fs.writeFileSync(path.join(root, 'novo.txt'), 'x\n');
    const r = await healthWith(root, { '/api/version': versionOk(head), '/api/watcher/status': watcherOk() });
    assert.equal(r.ok, false);
    assert.equal(byName(r).arvore.status, 'fail');
    assert.match(byName(r).arvore.reason, /dirty/);
    assert.ok(!byName(r).arvore.reason.includes('novo.txt'), 'motivo cita caminho');
});

test('health: dashboard com SHA diferente do HEAD reprova', async () => {
    const root = cloneOnMain();
    const r = await healthWith(root, { '/api/version': versionOk('f'.repeat(40)), '/api/watcher/status': watcherOk() });
    assert.equal(r.ok, false);
    assert.equal(byName(r).dashboard.status, 'fail');
});

test('health: dashboard com drift reprova', async () => {
    const root = cloneOnMain();
    const head = sh(root, 'rev-parse', 'HEAD');
    const v = versionOk(head); v.body.drift = true;
    const r = await healthWith(root, { '/api/version': v, '/api/watcher/status': watcherOk() });
    assert.equal(byName(r).dashboard.status, 'fail');
});

test('health: /api/version com HTTP 500 reprova o dashboard', async () => {
    const root = cloneOnMain();
    const r = await healthWith(root, { '/api/version': { code: 500, body: { error: 'x' } }, '/api/watcher/status': watcherOk() });
    assert.equal(byName(r).dashboard.status, 'fail');
});

test('health: dashboard sem resposta reprova e o tick fica desconhecido', async () => {
    const root = cloneOnMain();
    const srv = await fakeDashboard({});
    await srv.close(); // porta fechada: conexão recusada
    const r = await health({ root, baseUrl: srv.baseUrl, git });
    assert.equal(r.ok, false);
    assert.equal(byName(r).dashboard.status, 'fail');
    assert.equal(byName(r).tick.status, 'desconhecido');
});

test('health: dashboard que não responde no prazo reprova', async () => {
    const root = cloneOnMain();
    const r = await healthWith(root, { '/api/version': 'hang', '/api/watcher/status': 'hang' }, { timeoutMs: 200 });
    assert.equal(byName(r).dashboard.status, 'fail');
    assert.equal(byName(r).tick.status, 'desconhecido');
});

test('health: trava ilegível (lockStatus lança) reprova', async () => {
    const root = cloneOnMain();
    const head = sh(root, 'rev-parse', 'HEAD');
    const lockStatus = () => { throw new Error('EACCES /algum/caminho'); };
    const r = await healthWith(root, { '/api/version': versionOk(head), '/api/watcher/status': watcherOk() }, { lockStatus });
    assert.equal(r.ok, false);
    assert.equal(byName(r).trava.status, 'fail');
    assert.ok(!byName(r).trava.reason.includes('/algum/caminho'), 'motivo cita caminho');
});

test('health: arquivo de trava corrompido reprova pela trava padrão', async () => {
    const root = cloneOnMain();
    const head = sh(root, 'rev-parse', 'HEAD');
    fs.writeFileSync(path.join(root, '.git', LOCK_NAME), 'não é json');
    const r = await healthWith(root, { '/api/version': versionOk(head), '/api/watcher/status': watcherOk() });
    assert.equal(byName(r).trava.status, 'fail');
});

test('health: tick com error reprova', async () => {
    const root = cloneOnMain();
    const head = sh(root, 'rev-parse', 'HEAD');
    const r = await healthWith(root, { '/api/version': versionOk(head), '/api/watcher/status': watcherOk({ error: 'restart_limit_reached', running: false, state: 'stopped' }) });
    assert.equal(r.ok, false);
    assert.equal(byName(r).tick.status, 'fail');
    assert.match(byName(r).tick.reason, /restart_limit_reached/);
});

test('health: tick que caiu desde a subida do laço (restarts > 0) reprova', async () => {
    const root = cloneOnMain();
    const head = sh(root, 'rev-parse', 'HEAD');
    const r = await healthWith(root, { '/api/version': versionOk(head), '/api/watcher/status': watcherOk({ restarts: 1 }) });
    assert.equal(byName(r).tick.status, 'fail');
});

test('health: last_run encerrado por limite de quedas depois da subida reprova', async () => {
    const root = cloneOnMain();
    const head = sh(root, 'rev-parse', 'HEAD');
    const last_run = { started_at: '2026-11-18T08:10:00.000Z', ended_at: '2026-11-18T08:20:00.000Z', uptime_ms: 600000, reason: 'restart_limit' };
    const r = await healthWith(root, { '/api/version': versionOk(head), '/api/watcher/status': watcherOk({ last_run }) });
    assert.equal(byName(r).tick.status, 'fail');
});

test('health: last_run com limite de quedas antes da subida não reprova', async () => {
    const root = cloneOnMain();
    const head = sh(root, 'rev-parse', 'HEAD');
    const last_run = { started_at: '2026-11-17T08:10:00.000Z', ended_at: '2026-11-17T08:20:00.000Z', uptime_ms: 600000, reason: 'restart_limit' };
    const r = await healthWith(root, { '/api/version': versionOk(head), '/api/watcher/status': watcherOk({ last_run }) });
    assert.equal(byName(r).tick.status, 'pass');
    assert.equal(r.ok, true);
});

test('health: sem tick desde a subida fica desconhecido e não reprova', async () => {
    const root = cloneOnMain();
    const head = sh(root, 'rev-parse', 'HEAD');
    const r = await healthWith(root, { '/api/version': versionOk(head), '/api/watcher/status': watcherOk({ ticks: 0, running: false, state: 'stopped', phase: null }) });
    assert.equal(byName(r).tick.status, 'desconhecido');
    assert.equal(r.ok, true);
});

test('health: primeiro tick ainda em curso fica desconhecido', async () => {
    const root = cloneOnMain();
    const head = sh(root, 'rev-parse', 'HEAD');
    const r = await healthWith(root, { '/api/version': versionOk(head), '/api/watcher/status': watcherOk({ ticks: 1, phase: 'tick' }) });
    assert.equal(byName(r).tick.status, 'desconhecido');
});

test('health: URL fora de loopback é recusada sem request', async () => {
    const root = cloneOnMain();
    const calls = [];
    const fetch = async url => { calls.push(url); throw new Error('não devia chamar'); };
    for (const baseUrl of ['http://example.com:3333', 'http://10.0.0.1:3333', 'http://127.0.0.1.example.com', 'file:///etc/passwd']) {
        await assert.rejects(health({ root, baseUrl, fetch, git }), /loopback/, baseUrl);
    }
    assert.deepEqual(calls, []);
});

test('health: localhost e ::1 são aceitos; URL padrão usa 127.0.0.1 e PORT', async () => {
    const root = cloneOnMain();
    const head = sh(root, 'rev-parse', 'HEAD');
    const calls = [];
    const fetch = async url => {
        calls.push(String(url));
        const body = String(url).endsWith('/api/version') ? versionOk(head).body : watcherOk().body;
        return { ok: true, status: 200, json: async () => body };
    };
    for (const baseUrl of ['http://localhost:4000', 'http://[::1]:4000']) {
        const r = await health({ root, baseUrl, fetch, git });
        assert.equal(r.ok, true, baseUrl);
    }
    const saved = process.env.PORT;
    process.env.PORT = '45678';
    try { await health({ root, fetch, git }); } finally { if (saved === undefined) delete process.env.PORT; else process.env.PORT = saved; }
    assert.deepEqual(calls.slice(-2), ['http://127.0.0.1:45678/api/version', 'http://127.0.0.1:45678/api/watcher/status']);
    assert.equal(calls.length, 6);
});
