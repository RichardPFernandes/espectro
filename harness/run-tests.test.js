'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { resolveRoots, childEnv } = require('./run-tests');
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
