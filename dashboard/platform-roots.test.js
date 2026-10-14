const { describe, test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const dashboardDir = __dirname;
const repoRoot = path.resolve(dashboardDir, '..');

function runNode(args, cwd, env = process.env) {
    return spawnSync(process.execPath, args, { cwd, env, encoding: 'utf8', timeout: 180000 });
}

describe('fundação TS do dashboard', { concurrency: false }, () => {
test('o dist do dashboard importa sem executar e separa as raízes', () => {
    const tsc = path.join(dashboardDir, 'node_modules', 'typescript', 'lib', 'tsc.js');
    const build = runNode([tsc, '-b', '--pretty', 'false'], dashboardDir);
    assert.equal(build.status, 0, `${build.stdout}\n${build.stderr}`);

    for (const entry of ['dist/server/index.js', 'dist/web/index.js']) {
        const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pri103-dash-import-'));
        const result = runNode(['-e', `require(${JSON.stringify(path.join(dashboardDir, entry))})`], cwd, {
            PATH: process.env.PATH,
            PRISMA_ROOT: '',
            REPO_PATH: '',
        });
        assert.equal(result.status, 0, `${entry}\n${result.stderr}`);
        assert.equal(result.stdout, '');
        assert.equal(result.stderr, '');
        assert.deepEqual(fs.readdirSync(cwd), []);
    }

    const { resolvePlatformRoots, resolvePlatformAsset } = require('./dist/server/index.js');
    const consumer = fs.mkdtempSync(path.join(os.tmpdir(), 'pri103-dash-consumer-'));
    const roots = resolvePlatformRoots({
        env: { PRISMA_ROOT: repoRoot },
        moduleDir: path.join(dashboardDir, 'dist', 'server'),
        consumerRoot: consumer,
    });
    assert.notEqual(roots.platformRoot, roots.consumerRoot);
    const schema = resolvePlatformAsset(roots, '.graph', 'schemas', 'state.schema.json');
    assert.equal(schema.startsWith(roots.platformRoot), true);
    assert.equal(schema.startsWith(roots.consumerRoot), false);
    assert.equal(fs.existsSync(schema), true);
    assert.equal(require('./dist/web/index.js').DASHBOARD_WEB_PROJECT, 'dashboard-web');
});
});
