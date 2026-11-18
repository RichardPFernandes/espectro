// node --test scripts/cas.test.js
// PRI-372 (F1.2, AC-05): onde o log de conflitos (logs/state-conflicts.jsonl) é gravado.
// O layout real do consumidor continua no checkout principal; run fora desse layout
// (os testes, que criam runs no TMPDIR) nunca grava no checkout de quem roda a suíte.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const cas = require('./cas');

const REPO = path.resolve(__dirname, '..');
const repoLog = path.join(REPO, 'logs', cas.LOG_FILE);
const snapshot = file => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null);

function withoutLogEnv(fn) {
    const saved = process.env.STATE_CONFLICTS_LOG;
    delete process.env.STATE_CONFLICTS_LOG;
    try { return fn(); } finally { if (saved !== undefined) process.env.STATE_CONFLICTS_LOG = saved; }
}

test('layout real: <root>/memory/runs/<task> grava em <root>/logs', () => withoutLogEnv(() => {
    const root = path.join(path.sep, 'srv', 'consumidor');
    assert.strictEqual(cas.logPath(path.join(root, 'memory', 'runs', '10015-x')), path.join(root, 'logs', cas.LOG_FILE));
}));

test('layout real: run num worktree <root>/.claude/worktrees/<id>/memory/runs/<task> grava em <root>/logs', () => withoutLogEnv(() => {
    const root = path.join(path.sep, 'srv', 'consumidor');
    const runDir = path.join(root, '.claude', 'worktrees', 'w1', 'memory', 'runs', '10015-x');
    assert.strictEqual(cas.logPath(runDir), path.join(root, 'logs', cas.LOG_FILE));
}));

test('STATE_CONFLICTS_LOG continua mandando no caminho', () => {
    const saved = process.env.STATE_CONFLICTS_LOG;
    process.env.STATE_CONFLICTS_LOG = path.join(path.sep, 'x', 'c.jsonl');
    try { assert.strictEqual(cas.logPath(path.join(path.sep, 'srv', 'memory', 'runs', 't')), path.join(path.sep, 'x', 'c.jsonl')); }
    finally { if (saved === undefined) delete process.env.STATE_CONFLICTS_LOG; else process.env.STATE_CONFLICTS_LOG = saved; }
});

test('caso do dom06 rodado de dentro de <tmp>/.claude/worktrees/x não grava em <tmp>/logs nem no logs/ do checkout', () => {
    const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cas-log-')));
    try {
        const cwd = path.join(base, '.claude', 'worktrees', 'x');
        const tmpdir = path.join(base, 'tmpdir');
        fs.mkdirSync(cwd, { recursive: true });
        fs.mkdirSync(tmpdir, { recursive: true });
        const before = snapshot(repoLog);
        // Sem STATE_CONFLICTS_LOG, REPO_PATH nem CLAUDE_JOB_DIR: o run do teste vive no TMPDIR.
        const r = spawnSync(process.execPath, [
            '--test', '--test-reporter=tap', '--test-name-pattern', 'releaseNodeWithReason distingue os motivos',
            path.join(__dirname, 'lib', 'dom06-decomposition.test.js'),
        ], { cwd, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: tmpdir } });
        assert.strictEqual(r.status, 0, `${r.stdout}\n${r.stderr}`);
        assert.match(r.stdout, /# pass 1/, 'o caso do SESSION_CONFLICT rodou');
        assert.ok(!fs.existsSync(path.join(base, 'logs')), `nada em ${path.join(base, 'logs')}`);
        assert.ok(!fs.existsSync(path.join(cwd, 'logs')), `nada em ${path.join(cwd, 'logs')}`);
        assert.strictEqual(snapshot(repoLog), before, `o ${repoLog} do checkout não muda`);
    } finally {
        fs.rmSync(base, { recursive: true, force: true });
    }
});

test('run fora do layout (no TMPDIR) grava o log ao lado do run, nunca no checkout', () => withoutLogEnv(() => {
    const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cas-log-')));
    try {
        assert.strictEqual(cas.logPath(path.join(base, 'run0')), path.join(base, 'logs', cas.LOG_FILE));
    } finally {
        fs.rmSync(base, { recursive: true, force: true });
    }
}));
