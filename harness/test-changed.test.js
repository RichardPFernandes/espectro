'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { selectTests } = require('./test-changed');
const { recipeEnv, ROOT } = require('./recipe');

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

test('ambiente da receita: só roots, PATH, HOME, TMPDIR e o preload de loopback', () => {
    const env = recipeEnv(ROOT);
    assert.deepEqual(Object.keys(env).sort(), ['HOME', 'NODE_OPTIONS', 'PATH', 'PRISMA_ROOT', 'REPO_PATH', 'TMPDIR']);
    assert.equal(env.PRISMA_ROOT, ROOT);
    assert.equal(env.REPO_PATH, ROOT);
    assert.match(env.NODE_OPTIONS, /^--require=.*harness\/loopback-only\.cjs$/);
});
