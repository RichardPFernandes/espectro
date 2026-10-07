// node --test scripts/consumer-seam.test.js
// Seams da PRI-60: a plataforma não assume irmãos, comando de teste nem taxonomia
// do app-back. O consumidor passa isso por options/env.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const { createLocalCheckout } = require('./local-checkout');
const { testCommandFor } = require('./lib/service-detector');
const { classifyModule } = require('./memory-consolidator');
const { createDashboard } = require('../dashboard/server');

function gitInit(dir) {
    fs.mkdirSync(dir, { recursive: true });
    const git = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
    git('init', '-q');
    git('config', 'user.email', 't@t');
    git('config', 'user.name', 't');
    fs.writeFileSync(path.join(dir, 'README'), 'x\n');
    git('add', 'README');
    git('commit', '-qm', 'base');
}

test('local-checkout sem irmãos configurados só enxerga o repo do consumidor', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pri60-checkout-'));
    gitInit(root);
    const lc = createLocalCheckout({
        repoRoot: root,
        repoName: 'consumidor',
        env: {},
        worktreesDir: path.join(root, '.claude', 'worktrees'),
        stateFile: path.join(root, 'local-checkout.json'),
    });
    const status = await lc.status('4242');
    assert.deepStrictEqual(status.repos.map(r => r.key), ['consumidor']);
    fs.rmSync(root, { recursive: true, force: true });
});

test('comando de teste e taxonomia ficam vazios sem config do consumidor', () => {
    assert.strictEqual(testCommandFor(['backend/ms-pedidos'], {}), null);
    assert.strictEqual(classifyModule('cálculo de frete do CT-e'), null);
});

test('dashboard com memoryDir não segue REPO_PATH de outro projeto', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pri60-dash-'));
    const runs = path.join(root, 'memory', 'runs');
    fs.mkdirSync(runs, { recursive: true });
    const other = fs.mkdtempSync(path.join(os.tmpdir(), 'pri60-other-'));
    const dash = createDashboard({
        memoryDir: runs,
        env: { REPO_PATH: other, WATCHER_SIBLING_REPOS: 'app-front,app-core,mo-entity' },
        worktreesDir: path.join(root, '.claude', 'worktrees'),
        prefsFile: path.join(root, 'prefs.json'),
    });
    try {
        assert.strictEqual(path.resolve(dash.memoryDir), path.resolve(runs));
        assert.strictEqual(path.resolve(dash.worktreesDir), path.resolve(root, '.claude', 'worktrees'));
    } finally {
        await dash.close();
        fs.rmSync(root, { recursive: true, force: true });
        fs.rmSync(other, { recursive: true, force: true });
    }
});
