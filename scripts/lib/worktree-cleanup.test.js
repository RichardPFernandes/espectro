// node --test lib/worktree-cleanup.test.js
// cleanupWorktrees contra repos git reais em diretório temporário (app-back + um irmão
// com worktree embaixo do .claude/worktrees do app-back, como no projeto).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { execFileSync } = require('child_process');
const { cleanupWorktrees, stopPreviewViaDashboard } = require('./worktree-cleanup');

const tmpBase = process.env.CLAUDE_JOB_DIR ? path.join(process.env.CLAUDE_JOB_DIR, 'tmp') : os.tmpdir();
const quiet = { log() {}, warn() {}, error() {} };
const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

function initRepo(dir) {
    fs.mkdirSync(dir, { recursive: true });
    git(dir, 'init', '-q', '-b', 'main');
    fs.writeFileSync(path.join(dir, 'a.txt'), 'x');
    git(dir, 'add', '.');
    git(dir, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init');
}

function setup() {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(tmpBase, 'wt-cleanup-')));
    const back = path.join(root, 'app-back');
    const core = path.join(root, 'app-core');
    initRepo(back);
    initRepo(core);
    const wts = path.join(back, '.claude', 'worktrees');
    git(back, 'worktree', 'add', '-q', '-b', '6001', path.join(wts, '6001'));
    git(core, 'worktree', 'add', '-q', '-b', '6001', path.join(wts, '6001-app-core'));
    // Sujeira não commitada: --force tem que remover mesmo assim.
    fs.writeFileSync(path.join(wts, '6001', 'sujo.txt'), 'y');
    return { root, back, core, wts };
}

test('remove worktree do app-back e do irmão (no repo dono); ausentes ignorados; preview parado antes', async () => {
    const { root, back, core, wts } = setup();
    const order = [];
    try {
        const r = await cleanupWorktrees('6001', {
            worktreesDir: wts, log: quiet,
            stopPreview: async id => { order.push(`stop:${id}`); assert.ok(fs.existsSync(path.join(wts, '6001')), 'worktree ainda existe ao parar o preview'); return { running: true, stopped: true }; },
            exec: (cmd, args) => { if (args.includes('remove')) order.push(`remove:${path.basename(args[args.length - 1])}`); return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); },
        });
        assert.deepStrictEqual(r.errors, []);
        assert.deepStrictEqual(r.removed.map(p => path.basename(p)).sort(), ['6001', '6001-app-core']);
        assert.strictEqual(r.previewStopped, true);
        assert.strictEqual(order[0], 'stop:6001');
        assert.ok(!fs.existsSync(path.join(wts, '6001')) && !fs.existsSync(path.join(wts, '6001-app-core')));
        assert.ok(!git(back, 'worktree', 'list').includes('6001'));
        assert.ok(!git(core, 'worktree', 'list').includes('6001'));
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('preview não confirmou a parada → nada removido, erro por worktree', async () => {
    const { root, wts } = setup();
    try {
        const r = await cleanupWorktrees('6001', {
            worktreesDir: wts, log: quiet,
            stopPreview: async () => { throw new Error('HTTP 500'); },
        });
        assert.deepStrictEqual(r.removed, []);
        assert.strictEqual(r.errors.length, 2);
        assert.ok(r.errors.every(e => /preview não parou: HTTP 500/.test(e.error)));
        assert.ok(fs.existsSync(path.join(wts, '6001')));
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('falha parcial: um removido, o outro no erro; sem worktree nenhum → vazio', async () => {
    const { root, wts } = setup();
    try {
        const r = await cleanupWorktrees('6001', {
            worktreesDir: wts, log: quiet, stopPreview: async () => ({ running: false }),
            exec: (cmd, args) => {
                if (args.includes('remove') && args[args.length - 1].endsWith('-app-core')) throw Object.assign(new Error('x'), { stderr: 'fatal: bloqueado\n' });
                return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
            },
        });
        assert.deepStrictEqual(r.removed.map(p => path.basename(p)), ['6001']);
        assert.deepStrictEqual(r.errors.map(e => [path.basename(e.path), e.error]), [['6001-app-core', 'fatal: bloqueado']]);

        let stopped = false;
        const none = await cleanupWorktrees('7002', { worktreesDir: wts, log: quiet, stopPreview: async () => { stopped = true; } });
        assert.deepStrictEqual(none, { removed: [], kept: [], errors: [], previewStopped: false });
        assert.strictEqual(stopped, false);
        const bad = await cleanupWorktrees('../x', { worktreesDir: wts, log: quiet });
        assert.strictEqual(bad.errors.length, 1);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('irmão em ../<repo>/.claude/worktrees/<id> é removido; diretório já apagado mas registrado é podado', async () => {
    const { root, back, core, wts } = setup();
    const front = path.join(root, 'app-front');
    initRepo(front);
    const coreWt = path.join(core, '.claude', 'worktrees', '6001');
    const frontWt = path.join(front, '.claude', 'worktrees', '6001');
    git(core, 'worktree', 'remove', '--force', path.join(wts, '6001-app-core'));
    git(core, 'worktree', 'add', '-q', '-b', '6001-b', coreWt);
    git(front, 'worktree', 'add', '-q', '-b', '6001', frontWt);
    fs.rmSync(frontWt, { recursive: true, force: true });   // sumiu sem `git worktree remove`
    try {
        assert.ok(git(front, 'worktree', 'list').includes('prunable'));
        const r = await cleanupWorktrees('6001', {
            worktreesDir: wts, siblingRepos: [core, front], log: quiet, stopPreview: async () => ({ running: false }),
        });
        assert.deepStrictEqual(r.errors, []);
        assert.deepStrictEqual(r.removed.sort(), [path.join(wts, '6001'), coreWt, frontWt].sort());
        assert.ok(!fs.existsSync(coreWt));
        for (const repo of [back, core, front]) assert.ok(!git(repo, 'worktree', 'list').includes('6001'), repo);

        // Só registro órfão (nenhum diretório): poda sem consultar o preview.
        const w2 = path.join(front, '.claude', 'worktrees', '6002');
        git(front, 'worktree', 'add', '-q', '-b', '6002', w2);
        fs.rmSync(w2, { recursive: true, force: true });
        let asked = false;
        const r2 = await cleanupWorktrees('6002', {
            worktreesDir: wts, siblingRepos: [core, front], log: quiet, stopPreview: async () => { asked = true; },
        });
        assert.deepStrictEqual(r2, { removed: [w2], kept: [], errors: [], previewStopped: false });
        assert.strictEqual(asked, false);
        assert.ok(!git(front, 'worktree', 'list').includes('6002'));
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('stopPreviewViaDashboard: idle não para; rodando chama POST stop; dashboard fora do ar = sem preview', async () => {
    const calls = [];
    let phase = 'running';
    const srv = http.createServer((req, res) => {
        calls.push(`${req.method} ${req.url}`);
        if (req.url.endsWith('/stop')) phase = 'idle';
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ phase }));
    });
    await new Promise(r => srv.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${srv.address().port}`;
    try {
        assert.deepStrictEqual(await stopPreviewViaDashboard('6001', { base }), { running: true, stopped: true });
        assert.deepStrictEqual(calls, ['GET /api/preview/6001/status', 'POST /api/preview/6001/stop']);
        assert.deepStrictEqual(await stopPreviewViaDashboard('6001', { base }), { running: false, stopped: false });
    } finally {
        srv.closeAllConnections();
        await new Promise(r => srv.close(r));
    }
    // Porta que ninguém escuta (servidor aberto e fechado sem conexão nenhuma).
    const dead = http.createServer();
    await new Promise(r => dead.listen(0, '127.0.0.1', r));
    const deadBase = `http://127.0.0.1:${dead.address().port}`;
    await new Promise(r => dead.close(r));
    assert.deepStrictEqual(await stopPreviewViaDashboard('6001', { base: deadBase }), { running: false, stopped: false });
});

test('skipDirty: mudança rastreada não commitada mantém o worktree; untracked não conta; branch local fica', async () => {
    const { root, back, core, wts } = setup();
    try {
        fs.writeFileSync(path.join(wts, '6001-app-core', 'a.txt'), 'mudou'); // rastreado
        const r = await cleanupWorktrees('6001', { worktreesDir: wts, log: quiet, skipDirty: true, stopPreview: async () => ({ stopped: false }) });
        assert.deepStrictEqual(r.errors, []);
        assert.deepStrictEqual(r.removed.map(p => path.basename(p)), ['6001'], 'só untracked (sujo.txt) → sai');
        assert.deepStrictEqual(r.kept.map(k => path.basename(k.path)), ['6001-app-core']);
        assert.ok(fs.existsSync(path.join(wts, '6001-app-core', 'a.txt')));
        assert.strictEqual(git(back, 'branch', '--list', '6001').trim(), '6001', 'branch local preservada');
        assert.ok(git(core, 'worktree', 'list').includes('6001-app-core'));
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});
