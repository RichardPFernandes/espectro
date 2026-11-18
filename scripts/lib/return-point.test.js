'use strict';
// Conferência da árvore do ponto de retorno (F1.2, AC-02). Repositórios temporários com
// origem bare local; config global e de sistema do git fora, autor fixo.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { checkTree, guardEnabled, runGit } = require('./return-point');

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
