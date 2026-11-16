'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { resolveRoots, childEnv, SUITES, findTestFiles, listTestFiles, readExclusions, discover } = require('./run-tests');
const root = path.resolve(__dirname, '..');
const ASSETS = ['.claude/spec-hash-config.json', '.claude/config-contract.json', 'scripts/fixtures/ticket-example.json'];

test('roots: ausentes e relativos são recusados antes de executar testes', () => {
    for (const env of [{}, { REPO_PATH: '.' }, { REPO_PATH: root, PRISMA_ROOT: '..' }]) {
        assert.throws(() => resolveRoots(env), /raiz absoluta explícita/);
    }
    const r = spawnSync(process.execPath, [path.join(__dirname, 'run-tests.js'), 'scripts', 'inexistente.test.js'], {
        cwd: path.join(root, 'scripts'), env: {}, encoding: 'utf8',
    });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /REPO_PATH.*absoluta explícita/);
    assert.doesNotMatch(r.stdout, /TAP version/);
    assert.throws(() => resolveRoots({ REPO_PATH: path.join(root, 'nao-existe-pri92'), PRISMA_ROOT: root }), /REPO_PATH não existe/);
});

test('roots: versão diferente do harness é recusada', () => {
    assert.throws(() => resolveRoots({ REPO_PATH: root, PRISMA_ROOT: __dirname }), /esta versão do harness/);
});

test('roots explícitos resolvem assets sem depender do cwd do pacote', () => {
    const roots = resolveRoots({ REPO_PATH: root, PRISMA_ROOT: root });
    assert.equal(roots.REPO_PATH, roots.PRISMA_ROOT);
});

test('roots distintos e asset ausente: diagnóstico claro, sem fallback', t => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'pri92-roots-'));
    t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
    const env = { REPO_PATH: repo, PRISMA_ROOT: root };
    assert.throws(() => resolveRoots(env), /asset de teste ausente em REPO_PATH/);
    for (const rel of ASSETS) {
        fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
        fs.copyFileSync(path.join(root, rel), path.join(repo, rel));
    }
    assert.notEqual(resolveRoots(env).REPO_PATH, resolveRoots(env).PRISMA_ROOT);
});

test('env do filho: só allowlist + roots; integração e credenciais do operador não vazam', () => {
    const env = childEnv({
        PATH: '/bin', HOME: '/h', NODE_OPTIONS: '--require=/p.cjs', REPO_PATH: '/x', NODE_TEST_CONTEXT: 'child',
        WATCHER_MAIN_REPO_NAME: 'app-back', WATCHER_SIBLING_REPOS: 'app-core', BITBUCKET_API_TOKEN: 's', npm_config_cache: '/c',
    }, { REPO_PATH: '/repo', PRISMA_ROOT: '/prisma' });
    assert.deepStrictEqual(env, { PATH: '/bin', HOME: '/h', NODE_OPTIONS: '--require=/p.cjs', REPO_PATH: '/repo', PRISMA_ROOT: '/prisma' });
});

// Roda o runner de verdade contra arquivos .test.js sintéticos (fora do repo) e um
// REPO_PATH temporário com os assets: prova TAP, exit code, cwd e env do filho.
function runnerFixture(t) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pri92-runner-'));
    t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
    const repo = path.join(tmp, 'repo');
    for (const rel of ASSETS) {
        fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
        fs.copyFileSync(path.join(root, rel), path.join(repo, rel));
    }
    const write = (name, body) => {
        const file = path.join(tmp, name);
        fs.writeFileSync(file, `'use strict';\nconst test = require('node:test');\n${body}\n`);
        return file;
    };
    const run = file => spawnSync(process.execPath, [path.join(__dirname, 'run-tests.js'), 'scripts', file], {
        cwd: tmp, encoding: 'utf8', timeout: 60000,
        env: {
            PATH: process.env.PATH, HOME: tmp, TMPDIR: tmp, REPO_PATH: repo, PRISMA_ROOT: root,
            WATCHER_MAIN_REPO_NAME: 'vazou', BITBUCKET_API_TOKEN: 'segredo-pri92', PRI92_SENTINELA: '1',
        },
    });
    return { tmp, repo, write, run };
}

test('runner: teste que passa → TAP, exit 0, cwd = REPO_PATH real e env isolado', t => {
    const { tmp, repo, write, run } = runnerFixture(t);
    const probe = path.join(tmp, 'probe.json');
    const file = write('passa.test.js', `test('passa', () => {
    require('node:fs').writeFileSync(${JSON.stringify(probe)}, JSON.stringify({ cwd: process.cwd(), env: process.env }));
});`);
    const r = run(file);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^TAP version 13$/m);
    assert.match(r.stdout, /^ok 1 - passa$/m);
    assert.match(r.stdout, /^# fail 0$/m);
    const seen = JSON.parse(fs.readFileSync(probe, 'utf8'));
    const real = fs.realpathSync(repo);
    assert.equal(seen.cwd, real);
    assert.equal(seen.env.REPO_PATH, real);
    assert.equal(seen.env.PRISMA_ROOT, fs.realpathSync(root));
    assert.equal(seen.env.HOME, tmp);
    for (const leaked of ['WATCHER_MAIN_REPO_NAME', 'BITBUCKET_API_TOKEN', 'PRI92_SENTINELA']) {
        assert.ok(!(leaked in seen.env), `${leaked} vazou para o teste`);
    }
});

test('runner: teste que falha → TAP com not ok e exit 1', t => {
    const { write, run } = runnerFixture(t);
    const r = run(write('falha.test.js', "test('falha', () => { throw new Error('esperado'); });"));
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stdout, /^TAP version 13$/m);
    assert.match(r.stdout, /^not ok 1 - falha$/m);
    assert.match(r.stdout, /^# fail 1$/m);
});

test('descoberta: acha *.test.js em qualquer nível; pula node_modules, build e checkout aninhado', t => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'f02-descoberta-'));
    t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
    for (const rel of ['scripts/a.test.js', 'scripts/lib/deep/b.test.js', 'dashboard/c.test.js', 'provenance/d.test.js',
        'scripts/a.js', 'scripts/e.test.mjs', 'scripts/node_modules/x/f.test.js', 'dashboard/dist/g.test.js',
        'worktrees/outro/.git', 'worktrees/outro/scripts/h.test.js']) {
        fs.mkdirSync(path.dirname(path.join(tmp, rel)), { recursive: true });
        fs.writeFileSync(path.join(tmp, rel), '');
    }
    assert.deepStrictEqual(findTestFiles(tmp), ['dashboard/c.test.js', 'provenance/d.test.js', 'scripts/a.test.js', 'scripts/lib/deep/b.test.js']);
    const excl = new Map([['provenance/d.test.js', 'motivo']]);
    assert.deepStrictEqual(discover(tmp, 'scripts', excl), { files: ['scripts/a.test.js', 'scripts/lib/deep/b.test.js'], excluded: ['provenance/d.test.js'] });
    assert.deepStrictEqual(discover(tmp, 'dashboard', excl), { files: ['dashboard/c.test.js'], excluded: [] });
});

test('receita: todo *.test.js versionado roda em uma suíte ou está na lista de exclusões com motivo', t => {
    if (!fs.existsSync(path.join(root, '.git'))) return t.skip('export sem .git: comparação com os arquivos versionados não feita');
    const git = spawnSync('git', ['-C', root, 'ls-files', '-z', '--', '*.test.js'], { encoding: 'utf8' });
    assert.equal(git.status, 0, `há .git e o git falhou: ${git.stderr || git.error}`);
    const tracked = git.stdout.split('\0').filter(rel => rel && fs.existsSync(path.join(root, rel)));
    assert.ok(tracked.length > 0, 'git ls-files não devolveu nenhum *.test.js');
    const exclusions = readExclusions();
    const ran = SUITES.flatMap(suite => discover(root, suite, exclusions).files);
    assert.equal(new Set(ran).size, ran.length, 'arquivo em mais de uma suíte');
    assert.deepStrictEqual(tracked.filter(rel => !ran.includes(rel) && !exclusions.has(rel)), [], 'arquivo de teste que a receita não roda');
    // Exclusão é exceção visível: aponta para arquivo que existe; se sumiu, sai da lista.
    assert.deepStrictEqual([...exclusions.keys()].filter(rel => !tracked.includes(rel)), [], 'exclusão sem arquivo versionado');
    // Os dois pacotes entregam a descoberta ao harness: nenhuma lista à mão no npm test.
    for (const suite of SUITES) {
        const pkg = JSON.parse(fs.readFileSync(path.join(root, suite, 'package.json'), 'utf8'));
        assert.equal(pkg.scripts.test, `node ../harness/run-tests.js ${suite}`);
    }
});

test('exclusões: entrada sem motivo é recusada', t => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'f02-exclusoes-'));
    t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
    const file = path.join(tmp, 'x.json');
    const read = excluir => { fs.writeFileSync(file, JSON.stringify({ excluir })); return readExclusions(file); };
    assert.throws(() => read([{ arquivo: 'a.test.js', motivo: ' ' }]), /sem arquivo ou motivo/);
    assert.throws(() => read([{ arquivo: 'a.test.js', motivo: 'x' }, { arquivo: 'a.test.js', motivo: 'y' }]), /duplicada/);
    assert.throws(() => read([{ arquivo: 'harness/run-tests.test.js', motivo: 'x' }]), /harness não pode/);
});

test('descoberta com git: versionados e novos não ignorados; ignorado não roda; git quebrado é erro', t => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'f02-git-'));
    t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
    for (const [rel, body] of [['.gitignore', 'memory/runs/\n'], ['scripts/a.test.js', ''], ['scripts/novo.test.js', ''], ['memory/runs/1/c.test.js', '']]) {
        fs.mkdirSync(path.dirname(path.join(tmp, rel)), { recursive: true });
        fs.writeFileSync(path.join(tmp, rel), body);
    }
    const git = (...args) => assert.equal(spawnSync('git', ['-C', tmp, ...args], { encoding: 'utf8' }).status, 0, args.join(' '));
    git('init', '-q'); git('add', '.gitignore', 'scripts/a.test.js');
    assert.deepStrictEqual(listTestFiles(tmp), ['scripts/a.test.js', 'scripts/novo.test.js']);
    fs.writeFileSync(path.join(tmp, '.git', 'HEAD'), 'quebrado');
    assert.throws(() => listTestFiles(tmp), /git ls-files falhou/);
});
