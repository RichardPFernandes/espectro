'use strict';
// Ensaio de volta (F1.2, AC-04): a sequência inteira pela CLI, como processo filho, num
// repositório temporário com origem bare local. Marcar → avançar → sujar → back recusa →
// limpar → back volta → git tag -n e o log. Cada passo vira uma linha do relato, sempre
// impresso (t.diagnostic); o arquivo só é gravado com RETURN_POINT_ENSAIO_OUT definido.
// O relato troca o caminho do temp por <tmp>. PORT do filho é a do servidor falso, nunca a
// 3333; REPO_PATH e PRISMA_CHECKOUT_GUARD do ambiente não chegam ao filho.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { execFile, spawnSync } = require('node:child_process');

const CLI = path.join(__dirname, 'return-point.js');
const { REPO_PATH: _repo, PORT: _port, PRISMA_CHECKOUT_GUARD: _guard, RETURN_POINT_ENSAIO_OUT: OUT, ...BASE_ENV } = process.env;
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
const MAX_LINES = 20;

function sh(cwd, ...args) {
    const r = spawnSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
    return r.stdout.trim();
}

// Servidor falso em loopback; as rotas são mutáveis para "parar o watcher" entre os passos.
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
function cli(args, port) {
    return new Promise(resolve => {
        execFile(process.execPath, [CLI, ...args], { env: { ...GIT_ENV, PORT: String(port) }, encoding: 'utf8', timeout: 30000 }, (err, stdout, stderr) => {
            resolve({ code: err ? err.code : 0, stdout, stderr });
        });
    });
}

test('ensaio de volta em repositório temporário: marcar, avançar, sujar, recusar, limpar, voltar', async t => {
    const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'return-point-ensaio-')));
    const tmpRoots = [...new Set([base, fs.realpathSync(os.tmpdir()), os.tmpdir()])];
    const clean = s => tmpRoots.reduce((acc, p) => acc.split(p).join('<tmp>'), String(s));
    const relato = [];
    let steps = 0;
    const record = (title, command, code, output) => {
        const lines = String(output).trim().split('\n').filter(Boolean);
        const shown = lines.length > MAX_LINES ? [...lines.slice(0, MAX_LINES), `... (${lines.length - MAX_LINES} linha(s) a mais)`] : lines;
        relato.push(`## ${steps++}. ${title}`, `$ ${command}`, `exit: ${code}`, ...shown.map(l => `  ${l}`), '');
    };
    const rel = p => `<tmp>/${path.relative(base, p)}`;

    const origin = path.join(base, 'origin.git');
    const seed = path.join(base, 'seed');
    const root = path.join(base, 'work');
    const consumer = path.join(base, 'consumidor');
    const routes = {};
    const srv = await fakeDashboard(routes);

    const run = async (title, args) => {
        const r = await cli(args, srv.port);
        record(title, `node scripts/return-point.js ${args.map(a => (a.startsWith(base) ? rel(a) : a)).join(' ')}`, r.code, r.stdout + r.stderr);
        return r;
    };
    const gitStep = (title, cwd, ...args) => {
        const out = sh(cwd, ...args);
        record(title, `git ${args.join(' ')}`, 0, out);
        return out;
    };

    try {
        // Preparo: origem bare com dois commits na main, clone de trabalho e repo do consumidor
        // com a trava livre (só um .git/ vazio).
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
        fs.mkdirSync(path.join(consumer, '.git'), { recursive: true });
        const green = sh(root, 'rev-parse', 'HEAD');
        record('preparo: origem bare, clone na main, consumidor com trava livre', 'git rev-parse HEAD', 0, green);

        // 1. Marcar: dashboard falso em ordem (HEAD servido = HEAD, sem drift, tick concluído).
        routes['/api/version'] = { status: 'ok', started_at: '2026-11-18T08:00:00.000Z', current: { sha: green }, drift: false };
        routes['/api/watcher/status'] = { running: true, state: 'running', error: null, restarts: 0, ticks: 2, phase: 'idle', last_run: null };
        const m = await run('marcar (saúde com dashboard falso em ordem)', ['mark', '--root', root, '--repo', consumer]);
        assert.equal(m.code, 0, m.stdout + m.stderr);
        const tag = sh(root, 'tag', '-l', 'verde/*');
        assert.match(tag, /^verde\/\d{8}-\d{6}$/);
        assert.equal(sh(root, 'rev-parse', `${tag}^{commit}`), green);
        assert.ok(m.stdout.includes(`marca: ${tag} criada no ${green.slice(0, 7)}`), m.stdout);

        // 2. Avançar dois commits e empurrar para a origem local (HEAD fica na origin/main).
        for (let i = 0; i < 2; i++) {
            fs.writeFileSync(path.join(root, 'a.txt'), `avanço ${i}\n`);
            sh(root, 'add', 'a.txt');
            sh(root, 'commit', '--quiet', '-m', `avanço ${i}`);
        }
        sh(root, 'push', '--quiet', 'origin', 'HEAD:main');
        const advanced = gitStep('avançar dois commits e empurrar para a origem local', root, 'log', '--oneline', `${tag}..HEAD`);
        assert.equal(advanced.split('\n').length, 2);
        const head = sh(root, 'rev-parse', 'HEAD');
        assert.notEqual(head, green);
        assert.equal(sh(root, 'rev-parse', 'origin/main'), head);

        // 3. Sujar com um arquivo não rastreado.
        fs.writeFileSync(path.join(root, 'solto.txt'), 'x\n');
        const dirty = gitStep('sujar (arquivo não rastreado)', root, 'status', '--short');
        assert.match(dirty, /\?\? solto\.txt/);

        // 4. Parar o watcher no dashboard falso: daqui em diante o laço não está ativo.
        routes['/api/watcher/status'] = { running: false, state: 'stopped', error: null, restarts: 0, ticks: 2, phase: 'idle', last_run: null };
        record('parar o watcher (dashboard falso responde running: false, state: stopped)', `GET /api/watcher/status`, 0, JSON.stringify(routes['/api/watcher/status']));

        // 5. back recusa: árvore suja; HEAD e branch iguais.
        const refused = await run('back com a árvore suja (recusa)', ['back', '--root', root, '--repo', consumer]);
        assert.equal(refused.code, 1, refused.stdout + refused.stderr);
        assert.match(refused.stdout, /back recusado; nada mudou/);
        assert.match(refused.stdout, /solto\.txt/);
        assert.equal(sh(root, 'rev-parse', 'HEAD'), head);
        assert.equal(sh(root, 'symbolic-ref', '-q', 'HEAD'), 'refs/heads/main');

        // 6. Limpar: apaga só o arquivo solto (nunca clean, reset ou stash).
        fs.rmSync(path.join(root, 'solto.txt'));
        const cleaned = gitStep('limpar (apagar o arquivo solto)', root, 'status', '--short');
        assert.equal(cleaned, '');
        assert.equal(sh(root, 'rev-parse', 'HEAD'), head);

        // 7. back volta: HEAD = tag, destacado.
        const back = await run('back com a árvore limpa (volta)', ['back', '--root', root, '--repo', consumer]);
        assert.equal(back.code, 0, back.stdout + back.stderr);
        assert.ok(back.stdout.includes(`HEAD destacado em ${tag} (${green.slice(0, 7)}); antes em ${head.slice(0, 7)}.`), back.stdout);
        assert.match(back.stdout, /Reinicie o dashboard/);
        assert.equal(sh(root, 'rev-parse', 'HEAD'), green);
        assert.equal(spawnSync('git', ['symbolic-ref', '-q', 'HEAD'], { cwd: root, env: GIT_ENV }).status, 1);
        assert.equal(sh(root, 'rev-parse', 'main'), head);

        // 8. git tag -n: a tag verde segue onde estava.
        const tags = gitStep('git tag -n', root, 'tag', '-n');
        assert.ok(tags.startsWith(tag), tags);
        assert.equal(sh(root, 'rev-parse', `${tag}^{commit}`), green);

        // 9. Log do mark: uma linha, aprovada, com a tag e o HEAD marcado.
        const logText = fs.readFileSync(path.join(root, 'logs', 'return-point.jsonl'), 'utf8');
        record('conteúdo de logs/return-point.jsonl', 'cat logs/return-point.jsonl', 0, logText);
        const log = logText.trim().split('\n').map(l => JSON.parse(l));
        assert.equal(log.length, 1);
        assert.equal(log[0].ok, true);
        assert.equal(log[0].tag, tag);
        assert.equal(log[0].head, green);
    } finally {
        await srv.close();
        const text = clean(relato.join('\n'));
        for (const line of text.split('\n')) t.diagnostic(line);
        if (OUT) fs.writeFileSync(OUT, text);
        fs.rmSync(base, { recursive: true, force: true });
    }
});
