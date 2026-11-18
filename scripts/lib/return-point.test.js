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

// O runner padrão (runGit sem env injetado) herda process.env: a config global e a de
// sistema do git ficam fora também para ele.
process.env.GIT_CONFIG_GLOBAL = '/dev/null';
process.env.GIT_CONFIG_NOSYSTEM = '1';

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
    // logs/*.jsonl ignorado como no .gitignore do repo (**/logs/**/*.jsonl): o log do mark
    // não suja a árvore para o back.
    fs.writeFileSync(path.join(seed, '.gitignore'), 'ignorado.log\n**/logs/**/*.jsonl\n');
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

test('checkTree repassa timeoutMs ao git; sem ele fica o prazo padrão do runner', () => {
    const root = cloneOnMain();
    const seen = [];
    const spy = (args, opts) => { seen.push(opts.timeout); return git(args, opts); };
    assert.equal(checkTree({ root, git: spy }).ok, true);
    assert.ok(seen.length > 0);
    assert.deepEqual([...new Set(seen)], [undefined]);
    seen.length = 0;
    assert.equal(checkTree({ root, git: spy, timeoutMs: 3000 }).ok, true);
    assert.ok(seen.length > 0);
    assert.deepEqual([...new Set(seen)], [3000]);
});

test('checkTree com o git travado no status: o prazo curto vence e a recusa fica fechada', () => {
    const root = cloneOnMain();
    const bin = tmp();
    const realGit = spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim();
    fs.writeFileSync(path.join(bin, 'git'), `#!/bin/sh\ncase " $* " in *" status "*) exec sleep 6;; esac\nexec "${realGit}" "$@"\n`, { mode: 0o755 });
    // A primeira execução de um script recém-gravado é lenta no macOS: aquece fora do prazo.
    assert.equal(spawnSync(path.join(bin, 'git'), ['--version']).status, 0);
    const slowGit = (args, opts) => runGit(args, { ...opts, env: { ...GIT_ENV, PATH: `${bin}:${GIT_ENV.PATH}` } });
    const t0 = Date.now();
    const r = checkTree({ root, git: slowGit, timeoutMs: 1000 });
    assert.ok(Date.now() - t0 < 4000, `levou ${Date.now() - t0} ms`);
    assert.equal(r.ok, false);
    assert.ok(r.reasons.includes('dirty'), JSON.stringify(r.reasons));
});

test('guardEnabled: 1, true e sim ligam; o resto desliga', () => {
    for (const v of ['1', 'true', 'sim', 'TRUE', ' Sim ']) assert.equal(guardEnabled({ PRISMA_CHECKOUT_GUARD: v }), true, v);
    for (const v of [undefined, '', '0', 'false', 'não', 'yes', 'on', '2']) assert.equal(guardEnabled({ PRISMA_CHECKOUT_GUARD: v }), false, String(v));
    assert.equal(guardEnabled({}), false);
});

test('a leitura de PRISMA_CHECKOUT_GUARD tem a forma que o flag-registry reconhece', () => {
    const { flagShapedReads } = require('./flag-registry');
    const lines = fs.readFileSync(path.join(__dirname, 'return-point.js'), 'utf8').split('\n');
    assert.ok(flagShapedReads(lines).has('PRISMA_CHECKOUT_GUARD'));
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

test('lastGreen: a data de criação manda; o nome só desempata', () => {
    const root = cloneOnMain();
    const tagAt = (name, date, ref) => {
        const r = spawnSync('git', ['tag', '-a', '-m', 'teste', name, ref], { cwd: root, env: { ...GIT_ENV, GIT_COMMITTER_DATE: date }, encoding: 'utf8' });
        if (r.status !== 0) throw new Error(r.stderr);
    };
    tagAt('verde/zzz', '2026-01-01T00:00:00Z', 'HEAD~1'); // nome maior, criada antes
    tagAt('verde/20261118-090507', '2026-06-01T00:00:00Z', 'HEAD'); // nome menor, criada depois
    assert.equal(lastGreen({ root, git }), 'verde/20261118-090507');
});

test('mark grava a linha no log quando a checagem de saúde lança, e lança', async () => {
    const root = cloneOnMain();
    const head = sh(root, 'rev-parse', 'HEAD');
    const health = async () => { throw new Error('health: URL inválida; só loopback'); };
    await assert.rejects(mark({ root, git, health, now: at('2026-11-18T09:05:07Z') }), /URL inválida/);
    assert.equal(sh(root, 'tag', '-l', 'verde/*'), '');
    assert.deepEqual(readLog(root), [{ at: '2026-11-18T09:05:07.000Z', head, tag: null, ok: false, error: 'health_failed' }]);
});

test('mark grava a linha no log quando o git tag falha depois da saúde passar, e lança', async () => {
    const root = cloneOnMain();
    const head = sh(root, 'rev-parse', 'HEAD');
    const failTag = (args, opts) => (args[0] === 'tag' ? { status: 128, stdout: '', stderr: 'fatal: simulado' } : git(args, opts));
    await assert.rejects(mark({ root, git: failTag, health: okHealth, now: at('2026-11-18T09:05:07Z') }), /não criou a tag/);
    assert.equal(sh(root, 'tag', '-l', 'verde/*'), '');
    assert.deepEqual(readLog(root), [{ at: '2026-11-18T09:05:07.000Z', head, tag: null, ok: false, items: (await okHealth()).items, error: 'tag_failed' }]);
});

test('mark reprova sem tag, com linha no log, se o HEAD muda durante a checagem', async () => {
    const root = cloneOnMain();
    const head = sh(root, 'rev-parse', 'HEAD');
    const health = async () => { advance(root, 1); return okHealth(); };
    const r = await mark({ root, git, health, now: at('2026-11-18T09:05:07Z') });
    assert.equal(r.ok, false);
    assert.equal(r.tag, null);
    assert.equal(r.head, head);
    assert.equal(r.error, 'head_changed');
    assert.equal(sh(root, 'tag', '-l', 'verde/*'), '');
    assert.deepEqual(readLog(root), [{ at: '2026-11-18T09:05:07.000Z', head, tag: null, ok: false, items: r.items, error: 'head_changed' }]);
});

test('mark reprova sem tag se a saúde validou outro HEAD', async () => {
    const root = cloneOnMain();
    const health = async () => ({ ...(await okHealth()), head: 'f'.repeat(40) });
    const r = await mark({ root, git, health, now: at('2026-11-18T09:05:07Z') });
    assert.equal(r.ok, false);
    assert.equal(r.error, 'head_changed');
    assert.equal(sh(root, 'tag', '-l', 'verde/*'), '');
    assert.equal(readLog(root)[0].error, 'head_changed');
});

test('corrida de nome: a tag criada durante a checagem não é sobrescrita (nunca -f) e há linha no log', async () => {
    const root = cloneOnMain();
    const head = sh(root, 'rev-parse', 'HEAD');
    const previous = sh(root, 'rev-parse', 'HEAD~1');
    const name = 'verde/20261118-090507';
    const health = async () => { sh(root, 'tag', name, 'HEAD~1'); return okHealth(); };
    await assert.rejects(mark({ root, git, health, now: at('2026-11-18T09:05:07Z') }), /verde\/20261118-090507/);
    assert.equal(sh(root, 'rev-parse', `${name}^{commit}`), previous);
    assert.deepEqual(readLog(root), [{ at: '2026-11-18T09:05:07.000Z', head, tag: null, ok: false, items: (await okHealth()).items, error: 'tag_failed' }]);
});

test('mark recusa numa worktree ligada, sem rodar a saúde nem gravar nada', async () => {
    const root = cloneOnMain();
    const wt = path.join(path.dirname(root), 'ligada');
    sh(root, 'worktree', 'add', '--quiet', '--detach', wt);
    let called = false;
    const health = async () => { called = true; return okHealth(); };
    await assert.rejects(
        mark({ root: wt, git, health, now: at('2026-11-18T09:05:07Z') }),
        e => e.code === 'linked_worktree' && /rode no checkout principal/.test(e.message),
    );
    assert.equal(called, false);
    assert.equal(sh(root, 'tag', '-l', 'verde/*'), '');
    assert.ok(!fs.existsSync(path.join(wt, 'logs')));
    assert.ok(!fs.existsSync(path.join(root, 'logs')));
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

// A trava padrão é lida no repo do consumidor (`repo`); aqui o próprio clone faz esse papel.
test('health: tudo em ordem passa os quatro itens, com o fetch e a trava padrão', async () => {
    const root = cloneOnMain();
    const head = sh(root, 'rev-parse', 'HEAD');
    const r = await healthWith(root, { '/api/version': versionOk(head), '/api/watcher/status': watcherOk() }, { repo: root });
    assert.equal(r.ok, true);
    assert.deepEqual(r.items.map(i => [i.name, i.status]), [['arvore', 'pass'], ['dashboard', 'pass'], ['trava', 'pass'], ['tick', 'pass']]);
    assert.equal(r.head, head, 'a saúde devolve o HEAD que validou');
    assert.equal(byName(r).tick.reason, 'sem queda desde o start do laço');
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
    const r = await healthWith(root, { '/api/version': versionOk(head), '/api/watcher/status': watcherOk() }, { repo: root });
    assert.equal(byName(r).trava.status, 'fail');
});

test('health: sem repo do consumidor a trava reprova, com o motivo', async () => {
    const root = cloneOnMain();
    const head = sh(root, 'rev-parse', 'HEAD');
    const r = await healthWith(root, { '/api/version': versionOk(head), '/api/watcher/status': watcherOk() });
    assert.equal(byName(r).trava.status, 'fail');
    assert.equal(byName(r).trava.reason, 'repo do consumidor não informado (--repo ou REPO_PATH)');
    assert.equal(r.ok, false);
});

test('health: lockStatus nulo com repo reprova a trava como não conferida', async () => {
    const root = cloneOnMain();
    const head = sh(root, 'rev-parse', 'HEAD');
    const r = await healthWith(root, { '/api/version': versionOk(head), '/api/watcher/status': watcherOk() }, { repo: root, lockStatus: null });
    assert.equal(byName(r).trava.status, 'fail');
    assert.equal(byName(r).trava.reason, 'trava não conferida');
    assert.equal(r.ok, false);
});

// Repo do consumidor inválido (R1 da G3): sem .git, watcher-lock cairia numa trava em /tmp
// e diria "livre".
function invalidRepos() {
    const base = tmp();
    const file = path.join(base, 'arquivo');
    fs.writeFileSync(file, 'x\n');
    return { inexistente: path.join(base, 'nao-existe'), arquivo: file, 'sem .git': tmp() };
}

test('health: repo do consumidor inexistente, arquivo ou sem .git reprova a trava, sem caminho no motivo', async () => {
    const root = cloneOnMain();
    const head = sh(root, 'rev-parse', 'HEAD');
    for (const [label, repo] of Object.entries(invalidRepos())) {
        const r = await healthWith(root, { '/api/version': versionOk(head), '/api/watcher/status': watcherOk() }, { repo });
        assert.equal(r.ok, false, label);
        assert.equal(byName(r).trava.status, 'fail', label);
        assert.match(byName(r).trava.reason, /^repo do consumidor inválido/, label);
        assert.ok(!JSON.stringify(r).includes(repo) && !JSON.stringify(r).includes(os.tmpdir()), label);
    }
});

test('health: repo do consumidor com .git em arquivo (worktree) é válido', async () => {
    const root = cloneOnMain();
    const head = sh(root, 'rev-parse', 'HEAD');
    const repo = tmp();
    fs.writeFileSync(path.join(repo, '.git'), 'gitdir: /lugar/nenhum\n');
    const r = await healthWith(root, { '/api/version': versionOk(head), '/api/watcher/status': watcherOk() }, { repo });
    assert.equal(byName(r).trava.status, 'pass');
});

test('health: a trava padrão é lida no repo do consumidor, não na raiz', async () => {
    const root = cloneOnMain();
    const head = sh(root, 'rev-parse', 'HEAD');
    fs.writeFileSync(path.join(root, '.git', LOCK_NAME), 'não é json'); // raiz com trava ruim
    const repo = tmp();
    fs.mkdirSync(path.join(repo, '.git')); // consumidor com trava livre
    const r = await healthWith(root, { '/api/version': versionOk(head), '/api/watcher/status': watcherOk() }, { repo });
    assert.equal(byName(r).trava.status, 'pass');
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
    const r = await healthWith(root, { '/api/version': versionOk(head), '/api/watcher/status': watcherOk({ last_run }) }, { repo: root });
    assert.equal(byName(r).tick.status, 'pass');
    assert.equal(r.ok, true);
});

test('health: sem tick desde a subida fica desconhecido e não reprova', async () => {
    const root = cloneOnMain();
    const head = sh(root, 'rev-parse', 'HEAD');
    const r = await healthWith(root, { '/api/version': versionOk(head), '/api/watcher/status': watcherOk({ ticks: 0, running: false, state: 'stopped', phase: null }) }, { repo: root });
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
        const r = await health({ root, repo: root, baseUrl, fetch, git });
        assert.equal(r.ok, true, baseUrl);
    }
    const saved = process.env.PORT;
    process.env.PORT = '45678';
    try { await health({ root, fetch, git }); } finally { if (saved === undefined) delete process.env.PORT; else process.env.PORT = saved; }
    assert.deepEqual(calls.slice(-2), ['http://127.0.0.1:45678/api/version', 'http://127.0.0.1:45678/api/watcher/status']);
    assert.equal(calls.length, 6);
});

// Volta ao último verde (F1.2, AC-01). Trava e status do watcher injetados; nenhum dashboard real.
const { back } = require('./return-point');
const freeLock = () => ({ lock_state: 'free', lock: null, agents: [] });
const stopped = async () => ({ running: false, state: 'stopped' });
const quiet = { lockStatus: freeLock, watcherStatus: stopped };

// Avança n commits; `file` novo entra no índice antes do commit.
function advance(root, n, file = 'a.txt') {
    for (let i = 0; i < n; i++) {
        fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
        fs.writeFileSync(path.join(root, file), `avanço ${i} ${sh(root, 'rev-parse', 'HEAD')}\n`);
        sh(root, 'add', file);
        sh(root, 'commit', '--quiet', '-m', `avanço ${i}`);
    }
}

// Repo do consumidor: só um .git/ (a trava mora nele).
function consumerRepo() {
    const d = tmp();
    fs.mkdirSync(path.join(d, '.git'));
    return d;
}

// HEAD, branch atual e todas as refs: "nada mudou" é isto igual antes e depois.
function snapshot(root) {
    const sym = spawnSync('git', ['symbolic-ref', '-q', 'HEAD'], { cwd: root, env: GIT_ENV, encoding: 'utf8' });
    return { head: sh(root, 'rev-parse', 'HEAD'), branch: sym.stdout.trim(), refs: sh(root, 'for-each-ref', '--format=%(refname) %(objectname)') };
}

async function markedAndAdvanced() {
    const root = cloneOnMain();
    const green = sh(root, 'rev-parse', 'HEAD');
    const m = await mark({ root, git, health: okHealth, now: at('2026-11-18T09:05:07Z') });
    advance(root, 2);
    return { root, green, tag: m.tag };
}

async function assertRefused(root, opts, code) {
    const before = snapshot(root);
    const r = await back({ root, git, ...opts });
    assert.equal(r.ok, false);
    assert.ok(r.reasons.some(x => x.code === code), `esperava ${code}, veio ${JSON.stringify(r.reasons)}`);
    for (const x of r.reasons) assert.equal(typeof x.message, 'string');
    assert.deepEqual(snapshot(root), before);
    assert.equal(r.head, before.head);
    return r;
}

test('back leva o HEAD destacado ao último verde, sem mover branch nem tag', async () => {
    const { root, green, tag } = await markedAndAdvanced();
    const before = snapshot(root);
    assert.deepEqual(checkTree({ root, git }).reasons, ['off_main']); // fora da main não impede a volta
    const r = await back({ root, git, repo: consumerRepo(), ...quiet });
    assert.equal(r.ok, true);
    assert.equal(r.tag, tag);
    assert.equal(r.from, before.head);
    assert.equal(r.head, green);
    assert.equal(r.restart, true);
    assert.deepEqual(r.reasons, []);
    assert.deepEqual(r.warnings, []);
    const after = snapshot(root);
    assert.equal(after.head, green);
    assert.equal(after.branch, '', 'HEAD devia ficar destacado');
    assert.equal(after.refs, before.refs, 'branch ou tag mudou');
});

test('back --to escolhe outra tag verde, e uma nova volta parte de HEAD destacado', async () => {
    const root = cloneOnMain();
    const first = sh(root, 'rev-parse', 'HEAD');
    await mark({ root, git, health: okHealth, now: at('2026-11-18T09:05:07Z') });
    advance(root, 1);
    const second = sh(root, 'rev-parse', 'HEAD');
    await mark({ root, git, health: okHealth, now: at('2026-11-18T09:05:08Z') });
    advance(root, 1);
    const r1 = await back({ root, git, to: 'verde/20261118-090507', ...quiet });
    assert.equal(r1.ok, true);
    assert.equal(sh(root, 'rev-parse', 'HEAD'), first);
    const r2 = await back({ root, git, ...quiet });
    assert.equal(r2.ok, true);
    assert.equal(r2.tag, 'verde/20261118-090508');
    assert.equal(sh(root, 'rev-parse', 'HEAD'), second);
});

test('back avisa, sem recusar, quando os locks de dependência diferem', async () => {
    const root = cloneOnMain();
    const green = sh(root, 'rev-parse', 'HEAD');
    await mark({ root, git, health: okHealth, now: at('2026-11-18T09:05:07Z') });
    advance(root, 1, 'scripts/package-lock.json');
    advance(root, 1, 'dashboard/package-lock.json');
    const r = await back({ root, git, ...quiet });
    assert.equal(r.ok, true);
    assert.equal(sh(root, 'rev-parse', 'HEAD'), green);
    const w = r.warnings.find(x => x.code === 'deps_lock_changed');
    assert.ok(w, JSON.stringify(r.warnings));
    assert.deepEqual(w.paths.slice().sort(), ['dashboard/package-lock.json', 'scripts/package-lock.json']);
    assert.match(w.message, /package-lock\.json/);
});

test('back recusa sem tag verde', async () => {
    const root = cloneOnMain();
    await assertRefused(root, quiet, 'no_green');
});

test('back recusa --to fora de verde/* e --to inexistente', async () => {
    const { root } = await markedAndAdvanced();
    sh(root, 'tag', 'outra/20261118-090507', 'HEAD~1');
    await assertRefused(root, { ...quiet, to: 'outra/20261118-090507' }, 'to_invalid');
    await assertRefused(root, { ...quiet, to: '--orphan' }, 'to_invalid');
    await assertRefused(root, { ...quiet, to: 'verde/20000101-000000' }, 'to_missing');
});

test('back recusa árvore suja e devolve os caminhos', async () => {
    const { root } = await markedAndAdvanced();
    fs.writeFileSync(path.join(root, 'solto.txt'), 'x\n');
    const r = await assertRefused(root, quiet, 'dirty');
    assert.deepEqual(r.paths, ['solto.txt']);
});

test('back recusa trava com dono vivo', async () => {
    const { root } = await markedAndAdvanced();
    await assertRefused(root, { ...quiet, lockStatus: () => ({ lock_state: 'held', lock: { pid: 1 }, agents: [] }) }, 'lock_held');
});

test('back recusa agente destacado vivo', async () => {
    const { root } = await markedAndAdvanced();
    await assertRefused(root, { ...quiet, lockStatus: () => ({ lock_state: 'free', lock: null, agents: [{ pid: 1 }] }) }, 'agents_alive');
});

test('back recusa quando o status da trava lança', async () => {
    const { root } = await markedAndAdvanced();
    await assertRefused(root, { ...quiet, lockStatus: () => { throw new Error('EACCES'); } }, 'lock_unreadable');
});

test('back recusa arquivo de trava corrompido, pela trava padrão no repo do consumidor', async () => {
    const { root } = await markedAndAdvanced();
    const repo = consumerRepo();
    fs.writeFileSync(path.join(repo, '.git', LOCK_NAME), 'não é json');
    await assertRefused(root, { repo, watcherStatus: stopped }, 'lock_unreadable');
});

test('back recusa arquivo de trava sem permissão de leitura, pela trava padrão', { skip: process.getuid?.() === 0 && 'root lê qualquer arquivo' }, async () => {
    const { root } = await markedAndAdvanced();
    const repo = consumerRepo();
    const lockFile = path.join(repo, '.git', LOCK_NAME);
    fs.writeFileSync(lockFile, JSON.stringify({ version: 1, role: 'loop', pid: process.pid, hostname: os.hostname(), acquired_at: new Date().toISOString() }));
    fs.chmodSync(lockFile, 0o000);
    try {
        await assertRefused(root, { repo, watcherStatus: stopped }, 'lock_unreadable');
    } finally { fs.chmodSync(lockFile, 0o644); }
});

test('back recusa repo do consumidor inexistente, arquivo ou sem .git, sem caminho no resultado', async () => {
    const { root } = await markedAndAdvanced();
    for (const [label, repo] of Object.entries(invalidRepos())) {
        const r = await assertRefused(root, { repo, watcherStatus: stopped }, 'repo_invalid');
        assert.ok(!JSON.stringify(r).includes(repo), label);
    }
});

test('back recusa watcher rodando segundo o dashboard', async () => {
    const { root } = await markedAndAdvanced();
    await assertRefused(root, { ...quiet, watcherStatus: async () => ({ running: true, state: 'running' }) }, 'watcher_running');
    await assertRefused(root, { ...quiet, watcherStatus: async () => ({ running: false, state: 'stopping' }) }, 'watcher_running');
});

test('back recusa sem repo do consumidor, com o motivo', async () => {
    const { root } = await markedAndAdvanced();
    const r = await assertRefused(root, { watcherStatus: stopped }, 'no_repo');
    assert.equal(r.reasons.find(x => x.code === 'no_repo').message, 'repo do consumidor não informado (--repo ou REPO_PATH)');
});

test('back junta todos os motivos de recusa', async () => {
    const root = cloneOnMain();
    fs.writeFileSync(path.join(root, 'solto.txt'), 'x\n');
    const r = await assertRefused(root, { watcherStatus: async () => ({ running: true, state: 'running' }) }, 'no_green');
    assert.deepEqual(r.reasons.map(x => x.code), ['no_green', 'dirty', 'no_repo', 'watcher_running']);
});

test('back com o dashboard sem resposta confere só a trava', async () => {
    const { root, green } = await markedAndAdvanced();
    const r = await back({ root, git, lockStatus: freeLock, watcherStatus: async () => null });
    assert.equal(r.ok, true);
    assert.equal(sh(root, 'rev-parse', 'HEAD'), green);
});

test('back lê a trava padrão no repo do consumidor', async () => {
    const { root, green } = await markedAndAdvanced();
    const repo = tmp();
    fs.mkdirSync(path.join(repo, '.git'));
    fs.writeFileSync(path.join(repo, '.git', LOCK_NAME), JSON.stringify({ version: 1, role: 'loop', pid: process.pid, hostname: os.hostname(), acquired_at: new Date().toISOString() }));
    await assertRefused(root, { repo, watcherStatus: stopped }, 'lock_held');
    fs.unlinkSync(path.join(repo, '.git', LOCK_NAME));
    const r = await back({ root, git, repo, watcherStatus: stopped });
    assert.equal(r.ok, true);
    assert.equal(sh(root, 'rev-parse', 'HEAD'), green);
});

test('back não tem caminho absoluto no resultado', async () => {
    const { root } = await markedAndAdvanced();
    const repo = tmp();
    fs.mkdirSync(path.join(repo, '.git'));
    const raw = JSON.stringify(await back({ root, git, repo, watcherStatus: stopped }));
    assert.ok(!raw.includes(root) && !raw.includes(repo) && !raw.includes(os.tmpdir()), raw);
});
