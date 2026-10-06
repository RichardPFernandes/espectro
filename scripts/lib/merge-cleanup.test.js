// node --test lib/merge-cleanup.test.js
// Pós-merge do watcher (onTaskFullyMerged): cleanup dos worktrees, state.json e
// comentário no Redmine — cleanup/Redmine stubados, contra um REPO_PATH temporário.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpBase = process.env.CLAUDE_JOB_DIR ? path.join(process.env.CLAUDE_JOB_DIR, 'tmp') : os.tmpdir();
const repo = fs.realpathSync(fs.mkdtempSync(path.join(tmpBase, 'merge-cleanup-')));
process.env.REPO_PATH = repo;
process.env.REDMINE_URL = 'http://127.0.0.1:9';
process.env.REDMINE_API_KEY = 'x';
const watcher = require('../readmine-watcher');

const runs = path.join(repo, 'memory', 'runs');
const wts = path.join(repo, '.claude', 'worktrees');
test.after(() => fs.rmSync(repo, { recursive: true, force: true }));

function seed(dir, taskId, extra = {}) {
    fs.mkdirSync(dir, { recursive: true });
    const state = { task_id: taskId, node: 'commit', history: ['commit'], status: 'fully_merged', pr_status: 'merged', redmine_ticket: { id: Number(taskId.split('-')[0]) }, ...extra };
    fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify(state, null, 2));
    fs.writeFileSync(path.join(dir, 'context.md'), '# ctx');
    return state;
}
const read = dir => JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'));
const deps = (over = {}) => {
    const notes = [];
    return {
        notes,
        worktreesDir: wts, runsDir: runs, findActiveTask: () => null,
        postNote: async (id, text) => { notes.push({ id, text }); return true; },
        ...over,
    };
};

test('run morando no worktree: copiado pro checkout principal antes do cleanup; grava merged + worktrees_cleaned_at; comenta ✅', async () => {
    const dir = path.join(wts, '6300', 'memory', 'runs', '_archive', '6300-x');
    const state = seed(dir, '6300-x');
    let sawCopy = false;
    const d = deps({
        cleanupWorktrees: async id => {
            sawCopy = fs.existsSync(path.join(runs, '_archive', '6300-x', 'context.md'));
            fs.rmSync(path.join(wts, id), { recursive: true, force: true });
            return { removed: [path.join(wts, id)], errors: [], previewStopped: true };
        },
    });
    const r = await watcher.onTaskFullyMerged({ taskId: '6300-x', dir, state }, d);
    assert.strictEqual(r.removed.length, 1);
    assert.ok(sawCopy, 'run copiado antes de remover o worktree');
    const st = read(path.join(runs, '_archive', '6300-x'));
    assert.strictEqual(st.pr_status, 'merged');
    assert.match(st.worktrees_cleaned_at, /^\d{4}-\d{2}-\d{2}T/);
    assert.strictEqual(st.worktrees_cleanup_errors, undefined);
    assert.deepStrictEqual(d.notes, [{ id: '6300', text: '✅ PR mergeado. Worktrees do ticket removidos automaticamente.' }]);
});

test('falha parcial: erros no state.json e comentário pedindo remoção manual', async () => {
    const dir = path.join(runs, '_archive', '6301-y');
    const state = seed(dir, '6301-y');
    const d = deps({
        cleanupWorktrees: async () => ({
            removed: [path.join(wts, '6301')],
            errors: [{ path: path.join(wts, '6301-app-front'), error: 'fatal: locked' }],
        }),
    });
    await watcher.onTaskFullyMerged({ taskId: '6301-y', dir, state }, d);
    const st = read(dir);
    assert.deepStrictEqual(st.worktrees_cleanup_errors, [{ path: path.join(wts, '6301-app-front'), error: 'fatal: locked' }]);
    assert.ok(st.worktrees_cleaned_at, 'parte removida: carimba o horário');
    assert.strictEqual(d.notes.length, 1);
    assert.match(d.notes[0].text, /falhou em parte/);
    assert.match(d.notes[0].text, /Removidos: \.claude\/worktrees\/6301\n/);
    assert.match(d.notes[0].text, /- \.claude\/worktrees\/6301-app-front: fatal: locked/);
});

test('não remove: outra task do ticket ativa, já limpo, ou sem ticket numérico; nada a remover não comenta', async () => {
    let calls = 0;
    const cleanup = async () => { calls++; return { removed: [], errors: [] }; };
    const dir = path.join(runs, '_archive', '6302-z');
    const state = seed(dir, '6302-z');

    const active = deps({ cleanupWorktrees: cleanup, findActiveTask: () => ({ taskId: '6302-recusa', state: { status: 'in_progress' } }) });
    assert.strictEqual(await watcher.onTaskFullyMerged({ taskId: '6302-z', dir, state }, active), null);
    assert.strictEqual(await watcher.onTaskFullyMerged({ taskId: '6302-z', dir, state: { ...state, worktrees_cleaned_at: '2026-09-24T00:00:00Z' } }, deps({ cleanupWorktrees: cleanup })), null);
    assert.strictEqual(await watcher.onTaskFullyMerged({ taskId: '2026-09-19-tooling', dir, state: { ...state, redmine_ticket: null } }, deps({ cleanupWorktrees: cleanup })), null);
    assert.strictEqual(calls, 0);

    const d = deps({ cleanupWorktrees: cleanup });
    await watcher.onTaskFullyMerged({ taskId: '6302-z', dir, state }, d);
    assert.strictEqual(calls, 1);
    assert.deepStrictEqual(d.notes, []);
    assert.ok(read(dir).worktrees_cleaned_at);
});
