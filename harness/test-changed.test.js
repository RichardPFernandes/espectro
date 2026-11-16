'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { selectTests, resolveBase } = require('./test-changed');
const { withRecipeEnv, missingInstalls, ROOT } = require('./recipe');

const present = (...files) => rel => files.includes(rel);

test('teste alterado entra; arquivo alterado puxa o vizinho de mesmo nome base', () => {
    const suites = selectTests(
        ['scripts/lib/retry-x.test.js', 'scripts/notify.js', 'dashboard/server.js', 'harness/run-tests.js'],
        present('scripts/lib/retry-x.test.js', 'scripts/notify.test.js', 'dashboard/server.test.js', 'harness/run-tests.test.js'));
    assert.deepEqual(suites, {
        scripts: ['harness/run-tests.test.js', 'scripts/lib/retry-x.test.js', 'scripts/notify.test.js'],
        dashboard: ['dashboard/server.test.js'],
    });
});

test('sem vizinho, apagado, sem extensão ou em node_modules: fica de fora; sem duplicar', () => {
    const suites = selectTests(
        ['README.md', 'LICENSE', 'scripts/apagado.test.js', 'scripts/a.js', 'scripts/a.test.js', 'scripts/node_modules/x/y.test.js'],
        present('scripts/a.test.js', 'scripts/node_modules/x/y.test.js'));
    assert.deepEqual(suites, { scripts: ['scripts/a.test.js'], dashboard: [] });
});

test('base: pedida tem que ser commit; "-opção" é recusada sem virar opção do git', () => {
    assert.equal(resolveBase('HEAD'), 'HEAD');
    for (const bad of ['--output=/tmp/x', '-h', 'nao-existe']) assert.throws(() => resolveBase(bad), /não é um commit/, bad);
});

test('base padrão: main, depois origin/main; sem nenhuma, erro que diz como buscar', () => {
    assert.equal(resolveBase(undefined, () => true), 'main');
    assert.equal(resolveBase(undefined, ref => ref === 'origin/main'), 'origin/main');
    assert.throws(() => resolveBase(undefined, () => false), /git fetch origin main/);
});

test('ambiente da receita: só roots, PATH da CI, HOME, TMPDIR e loopback; scratch removido', () => {
    let home;
    assert.throws(() => withRecipeEnv(env => {
        home = env.HOME;
        assert.ok(fs.statSync(home).isDirectory());
        assert.deepEqual(Object.keys(env).sort(), ['HOME', 'NODE_OPTIONS', 'PATH', 'PRISMA_ROOT', 'REPO_PATH', 'TMPDIR']);
        assert.deepEqual([env.PRISMA_ROOT, env.REPO_PATH], [ROOT, ROOT]);
        assert.match(env.PATH, /:\/usr\/bin:\/bin:\/usr\/sbin:\/sbin$/);
        assert.match(env.NODE_OPTIONS, /^--require=.*harness\/loopback-only\.cjs$/);
        throw new Error('falha simulada');
    }), /falha simulada/);
    assert.equal(fs.existsSync(home), false, 'scratch removido mesmo em falha');
});

test('pacote sem node_modules é apontado antes de rodar a suíte', () => {
    assert.deepEqual(missingInstalls('/r', p => p === '/r/scripts/node_modules'), ['dashboard']);
});
