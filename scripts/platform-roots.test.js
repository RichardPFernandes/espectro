const { describe, test } = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const repoRoot = path.resolve(__dirname, '..');
const scriptsDir = __dirname;
const dashboardDir = path.join(repoRoot, 'dashboard');

function sha256File(file) {
    return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function sourceJsFiles(dir) {
    const out = [];
    const walk = current => {
        for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
            if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === '.git') continue;
            const full = path.join(current, entry.name);
            if (entry.isDirectory()) walk(full);
            else if (entry.isFile() && entry.name.endsWith('.js')) out.push(full);
        }
    };
    walk(dir);
    return out.sort();
}

function runNode(args, cwd, env = process.env) {
    return spawnSync(process.execPath, args, { cwd, env, encoding: 'utf8', timeout: 180000 });
}

function tscJs(pkgDir) {
    return path.join(pkgDir, 'node_modules', 'typescript', 'lib', 'tsc.js');
}

function assertTsc(pkgDir, args) {
    const result = runNode([tscJs(pkgDir), ...args], pkgDir);
    assert.equal(result.status, 0, `${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
    return result;
}

function copyFile(rel) {
    return (destRoot) => {
        const dest = path.join(destRoot, rel);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.copyFileSync(path.join(repoRoot, rel), dest);
    };
}

function copyDir(src, dest) {
    fs.mkdirSync(dest, { recursive: true });
    for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
        const from = path.join(src, entry.name);
        const to = path.join(dest, entry.name);
        if (entry.isDirectory()) copyDir(from, to);
        else if (entry.isFile()) fs.copyFileSync(from, to);
    }
}

function linkCompiler(copyPkg, realPkg) {
    const destModules = path.join(copyPkg, 'node_modules');
    fs.mkdirSync(destModules, { recursive: true });
    fs.symlinkSync(path.join(realPkg, 'node_modules', 'typescript'), path.join(destModules, 'typescript'));
    fs.symlinkSync(path.join(realPkg, 'node_modules', '@types'), path.join(destModules, '@types'));
}

describe('fundação TS', { concurrency: false }, () => {
test('build CJS não sobrescreve .js fonte', () => {
    const before = new Map();
    for (const file of [...sourceJsFiles(scriptsDir), ...sourceJsFiles(dashboardDir)]) {
        before.set(file, sha256File(file));
    }
    assertTsc(scriptsDir, ['-b', '--pretty', 'false']);
    assertTsc(dashboardDir, ['-b', '--pretty', 'false']);
    for (const [file, hash] of before) assert.equal(sha256File(file), hash, file);

    const rootsJs = fs.readFileSync(path.join(scriptsDir, 'dist', 'platform', 'roots.js'), 'utf8');
    assert.match(rootsJs, /exports\./);
    assert.doesNotMatch(rootsJs, /^\s*import\s/m);
    assert.doesNotMatch(rootsJs, /^\s*export\s/m);
    const serverJs = fs.readFileSync(path.join(dashboardDir, 'dist', 'server', 'index.js'), 'utf8');
    assert.match(serverJs, /require\(["']\.\.\/\.\.\/\.\.\/scripts\/dist\/index\.js["']\)/);
    assert.equal(fs.existsSync(path.join(dashboardDir, 'dist', 'web', 'index.js')), true);
});

test('importar dist não executa nada', () => {
    const entries = [
        path.join(scriptsDir, 'dist', 'index.js'),
        path.join(scriptsDir, 'dist', 'platform', 'roots.js'),
        path.join(dashboardDir, 'dist', 'server', 'index.js'),
        path.join(dashboardDir, 'dist', 'web', 'index.js'),
    ];
    for (const entry of entries) {
        const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pri103-import-'));
        const result = runNode(['-e', `require(${JSON.stringify(entry)})`], cwd, {
            PATH: process.env.PATH,
            PRISMA_ROOT: '',
            REPO_PATH: '',
        });
        assert.equal(result.status, 0, `${entry}\n${result.stderr}`);
        assert.equal(result.stdout, '');
        assert.equal(result.stderr, '');
        assert.deepEqual(fs.readdirSync(cwd), []);
    }
});

test('raiz da plataforma difere do consumidor e o asset não segue o diretório do módulo', () => {
    const { resolvePlatformRoots, resolvePlatformAsset } = require('./dist/index.js');
    const platform = fs.mkdtempSync(path.join(os.tmpdir(), 'pri103-platform-'));
    const consumer = fs.mkdtempSync(path.join(os.tmpdir(), 'pri103-consumer-'));
    fs.mkdirSync(path.join(platform, 'scripts'), { recursive: true });
    fs.mkdirSync(path.join(platform, 'dashboard'), { recursive: true });
    fs.writeFileSync(path.join(platform, 'scripts', 'package.json'), JSON.stringify({ name: 'graph-scripts' }));
    fs.writeFileSync(path.join(platform, 'dashboard', 'package.json'), JSON.stringify({ name: 'graph-dashboard' }));
    const nested = path.join(platform, 'scripts', 'dist', 'platform');
    fs.mkdirSync(nested, { recursive: true });
    for (const root of [platform, consumer]) {
        const asset = path.join(root, '.graph', 'schemas', 'state.schema.json');
        fs.mkdirSync(path.dirname(asset), { recursive: true });
        fs.writeFileSync(asset, `{"side":"${path.basename(root)}"}\n`);
    }
    assert.equal(fs.existsSync(path.join(platform, '.git')), false);

    const roots = resolvePlatformRoots({ env: {}, moduleDir: nested, consumerRoot: consumer });
    assert.notEqual(roots.platformRoot, roots.consumerRoot);
    assert.equal(roots.platformRoot, fs.realpathSync(platform));
    assert.equal(roots.consumerRoot, fs.realpathSync(consumer));
    const resolved = resolvePlatformAsset(roots, '.graph', 'schemas', 'state.schema.json');
    assert.equal(fs.readFileSync(resolved, 'utf8'), `{"side":"${path.basename(platform)}"}\n`);

    const live = resolvePlatformRoots({ env: { PRISMA_ROOT: repoRoot }, consumerRoot: consumer });
    assert.notEqual(live.platformRoot, live.consumerRoot);
    const schema = resolvePlatformAsset(live, '.graph', 'schemas', 'state.schema.json');
    assert.equal(schema, path.join(live.platformRoot, '.graph', 'schemas', 'state.schema.json'));
    assert.equal(fs.existsSync(schema), true);
    assert.equal(schema.startsWith(live.consumerRoot), false);

    assert.throws(() => resolvePlatformRoots({ env: {}, moduleDir: nested }), /REPO_PATH/);
    assert.throws(() => resolvePlatformRoots({ env: { PRISMA_ROOT: consumer }, consumerRoot: platform }), /plataforma/);
    assert.throws(() => resolvePlatformAsset(roots, '..', 'outside.txt'), /\.\./);
    assert.throws(() => resolvePlatformAsset(roots, '/etc/passwd'), /relativo/);
});

test('checkJs é seletivo e erasableSyntaxOnly rejeita enum', () => {
    const listed = runNode([tscJs(scriptsDir), '-p', 'tsconfig.checkjs.json', '--listFilesOnly', '--pretty', 'false'], scriptsDir);
    assert.equal(listed.status, 0, listed.stdout + listed.stderr);
    const files = listed.stdout.split('\n');
    assert.equal(files.some(file => file.endsWith(`${path.sep}src${path.sep}platform${path.sep}marker.js`)), true);
    assert.equal(files.some(file => file.endsWith(`${path.sep}retry.js`)), false);
    assert.equal(files.some(file => file.endsWith(`${path.sep}server.js`)), false);

    const main = runNode([tscJs(scriptsDir), '-p', 'tsconfig.json', '--listFilesOnly', '--pretty', 'false'], scriptsDir);
    assert.equal(main.status, 0, main.stdout + main.stderr);
    const mainFiles = main.stdout.split('\n');
    assert.equal(mainFiles.some(file => file.endsWith(`${path.sep}src${path.sep}platform${path.sep}roots.ts`)), true);
    assert.equal(mainFiles.some(file => file.endsWith(`${path.sep}retry.js`)), false);
    assert.equal(mainFiles.some(file => file.endsWith(`${path.sep}readmine-watcher.js`)), false);

    const dash = runNode([tscJs(dashboardDir), '-p', 'tsconfig.checkjs.json', '--listFilesOnly', '--pretty', 'false'], dashboardDir);
    assert.equal(dash.status, 0, dash.stdout + dash.stderr);
    const dashFiles = dash.stdout.split('\n');
    assert.equal(dashFiles.some(file => file.endsWith(`${path.sep}src${path.sep}server${path.sep}marker.js`)), true);
    assert.equal(dashFiles.some(file => file.endsWith(`${path.sep}server.js`)), false);

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pri103-enum-'));
    fs.writeFileSync(path.join(dir, 'bad.ts'), 'export enum Direction { Up = 1 }\n');
    fs.writeFileSync(path.join(dir, 'tsconfig.json'), JSON.stringify({
        extends: path.join(repoRoot, 'tsconfig.base.json'),
        compilerOptions: { noEmit: true, declaration: false, composite: false, incremental: false, types: [] },
        files: ['bad.ts'],
    }));
    const bad = runNode([tscJs(scriptsDir), '-p', path.join(dir, 'tsconfig.json'), '--pretty', 'false'], dir);
    assert.notEqual(bad.status, 0);
    assert.match(`${bad.stdout}\n${bad.stderr}`, /erasableSyntaxOnly/);
});

test('build limpo em cópia isolada sem .git', () => {
    const copy = fs.mkdtempSync(path.join(os.tmpdir(), 'pri103-copy-'));
    assert.equal(fs.existsSync(path.join(copy, '.git')), false);
    for (const rel of [
        'tsconfig.base.json',
        'scripts/package.json',
        'scripts/tsconfig.json',
        'scripts/tsconfig.checkjs.json',
        'dashboard/package.json',
        'dashboard/tsconfig.json',
        'dashboard/tsconfig.server.json',
        'dashboard/tsconfig.web.json',
        'dashboard/tsconfig.checkjs.json',
    ]) copyFile(rel)(copy);
    copyDir(path.join(repoRoot, 'scripts', 'src'), path.join(copy, 'scripts', 'src'));
    copyDir(path.join(repoRoot, 'dashboard', 'src'), path.join(copy, 'dashboard', 'src'));
    linkCompiler(path.join(copy, 'scripts'), scriptsDir);
    linkCompiler(path.join(copy, 'dashboard'), dashboardDir);

    const scriptsBuild = runNode([tscJs(path.join(copy, 'scripts')), '-b', '--pretty', 'false'], path.join(copy, 'scripts'));
    assert.equal(scriptsBuild.status, 0, scriptsBuild.stdout + scriptsBuild.stderr);
    const dashBuild = runNode([tscJs(path.join(copy, 'dashboard')), '-b', '--pretty', 'false'], path.join(copy, 'dashboard'));
    assert.equal(dashBuild.status, 0, dashBuild.stdout + dashBuild.stderr);
    const check = runNode(
        [tscJs(path.join(copy, 'scripts')), '-p', 'tsconfig.checkjs.json', '--pretty', 'false', '--noEmit'],
        path.join(copy, 'scripts'),
    );
    assert.equal(check.status, 0, check.stdout + check.stderr);

    const consumer = fs.mkdtempSync(path.join(os.tmpdir(), 'pri103-copy-consumer-'));
    const assetDir = path.join(copy, '.graph', 'schemas');
    fs.mkdirSync(assetDir, { recursive: true });
    fs.writeFileSync(path.join(assetDir, 'state.schema.json'), '{"from":"copy"}\n');
    const { resolvePlatformRoots, resolvePlatformAsset } = require(path.join(copy, 'scripts', 'dist', 'index.js'));
    const roots = resolvePlatformRoots({
        env: {},
        moduleDir: path.join(copy, 'scripts', 'dist', 'platform'),
        consumerRoot: consumer,
    });
    assert.notEqual(roots.platformRoot, roots.consumerRoot);
    assert.equal(fs.readFileSync(resolvePlatformAsset(roots, '.graph', 'schemas', 'state.schema.json'), 'utf8'), '{"from":"copy"}\n');
    const serverEntry = path.join(copy, 'dashboard', 'dist', 'server', 'index.js');
    const imported = runNode(['-e', `require(${JSON.stringify(serverEntry)})`], copy, { PATH: process.env.PATH });
    assert.equal(imported.status, 0, imported.stderr);
    assert.equal(imported.stdout, '');
    assert.equal(fs.existsSync(path.join(copy, '.git')), false);
});
});
