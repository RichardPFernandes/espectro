// node --test lib/pr-open-cleanup.test.js
// Limpeza dos worktrees logo após o PR aberto (readmine-watcher.js >
// cleanupWorktreesAfterPrOpen): quando remove, quando adia, quando não toca — cleanup
// stubado, contra um REPO_PATH temporário (o cleanup real é testado em
// worktree-cleanup.test.js).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpBase = process.env.CLAUDE_JOB_DIR ? path.join(process.env.CLAUDE_JOB_DIR, 'tmp') : os.tmpdir();
const repo = fs.realpathSync(fs.mkdtempSync(path.join(tmpBase, 'pr-open-cleanup-')));
process.env.REPO_PATH = repo;
process.env.REDMINE_URL = 'http://127.0.0.1:9';
process.env.REDMINE_API_KEY = 'x';
const watcher = require('../readmine-watcher');

const runs = path.join(repo, 'memory', 'runs');
const wts = path.join(repo, '.claude', 'worktrees');
test.after(() => fs.rmSync(repo, { recursive: true, force: true }));

const OLD = '2026-09-29T10:00:00Z';
const NOW = Date.parse('2026-09-29T12:00:00Z');
const PR = { 'app-back': { url: 'https://bitbucket.org/ws/app-back/pull-requests/1', id: 1 }, 'app-core': { url: 'https://bitbucket.org/ws/app-core/pull-requests/2', id: 2 } };

function seed(ticket, taskId, extra = {}, { archived = true } = {}) {
    const dir = path.join(wts, ticket, 'memory', 'runs', ...(archived ? ['_archive'] : []), taskId);
    fs.mkdirSync(dir, { recursive: true });
    const state = { task_id: taskId, node: 'commit', history: ['commit'], status: 'committed', updated_at: OLD, pull_request: PR, redmine_ticket: { id: Number(ticket) }, ...extra };
    fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify(state, null, 2));
    fs.writeFileSync(path.join(dir, 'context.md'), '# ctx');
    return dir;
}
const read = dir => JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'));
// Stub do cleanup: apaga o worktree do app-back como o real faria e registra a chamada.
function stubCleanup(calls, result) {
    return async (id, opts) => {
        calls.push({ id, opts });
        const r = result ? result(id) : { removed: [path.join(wts, id)], kept: [], errors: [] };
        if (r.removed.includes(path.join(wts, id))) fs.rmSync(path.join(wts, id), { recursive: true, force: true });
        return r;
    };
}
const deps = (over = {}) => ({
    force: true, worktreesDir: wts, runsDir: runs, now: () => NOW,
    findActiveTask: () => null, pidAlive: () => false, previewRunning: async () => false,
    ...over,
});
const reset = () => { fs.rmSync(wts, { recursive: true, force: true }); fs.rmSync(runs, { recursive: true, force: true }); };

test('PR aberto: runs copiados pro checkout principal ANTES da remoção; carimbo + evento worktrees_removed; skipDirty ligado', async () => {
    reset();
    seed('7100', '7100-a');
    seed('7100', '7100-antigo', { status: 'fully_merged', worktrees_removed_on_pr_open_at: OLD });
    const calls = [];
    let sawCopy = false;
    const cleanup = stubCleanup(calls);
    const res = await watcher.cleanupWorktreesAfterPrOpen(deps({
        cleanupWorktrees: async (id, opts) => { sawCopy = fs.existsSync(path.join(runs, '_archive', '7100-a', 'context.md')); return cleanup(id, opts); },
    }));
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].id, '7100');
    assert.strictEqual(calls[0].opts.skipDirty, true);
    assert.ok(sawCopy, 'run copiado antes do cleanup');
    assert.ok(fs.existsSync(path.join(runs, '_archive', '7100-antigo', 'context.md')), 'todos os runs do worktree são preservados');
    const st = read(path.join(runs, '_archive', '7100-a'));
    assert.strictEqual(st.worktrees_removed_on_pr_open_at, new Date(NOW).toISOString());
    const ev = st.events.at(-1);
    assert.strictEqual(ev.type, 'worktrees_removed');
    assert.strictEqual(ev.node, 'commit');
    assert.strictEqual(ev.ts, ev.at);
    assert.match(ev.detail, /Branch local preservada/);
    assert.strictEqual(st.worktrees_cleanup_errors, undefined);
    assert.strictEqual(res[0].ticketId, '7100');
});

test('sem URL de PR (push/PR pulado por falta de credencial): worktree intacto, nada gravado', async () => {
    reset();
    const dir = seed('7101', '7101-a', { pull_request: undefined });
    seed('7101', '7101-b', { pull_request: { 'app-back': {} } });
    const calls = [];
    await watcher.cleanupWorktreesAfterPrOpen(deps({ cleanupWorktrees: stubCleanup(calls) }));
    assert.strictEqual(calls.length, 0);
    assert.ok(fs.existsSync(dir));
    assert.strictEqual(read(dir).worktrees_removed_on_pr_open_at, undefined);
    assert.ok(!fs.existsSync(path.join(runs, '_archive')), 'nada copiado');
});

test('idempotente: task já carimbada ou não committed não dispara; segunda passada não chama de novo', async () => {
    reset();
    seed('7102', '7102-a', { worktrees_removed_on_pr_open_at: OLD });
    seed('7103', '7103-a', { status: 'in_progress' }, { archived: false });
    seed('7104', '7104-a');
    const calls = [];
    await watcher.cleanupWorktreesAfterPrOpen(deps({ cleanupWorktrees: stubCleanup(calls) }));
    await watcher.cleanupWorktreesAfterPrOpen(deps({ cleanupWorktrees: stubCleanup(calls) }));
    assert.deepStrictEqual(calls.map(c => c.id), ['7104']);
});

test('adia sem gravar: preview no ar, agente vivo, gravação recente ou outra task ativa', async () => {
    const cases = [
        ['preview', { previewRunning: async () => true }, {}],
        ['pid vivo', { pidAlive: pid => pid === 4242 }, { agent_pid: 4242 }],
        ['recente', {}, { updated_at: new Date(NOW - 30_000).toISOString() }],
        ['outra task', { findActiveTask: () => ({ taskId: '7105-recusa', state: { status: 'in_progress' } }) }, {}],
    ];
    for (const [label, over, extra] of cases) {
        reset();
        const dir = seed('7105', '7105-a', extra);
        const calls = [];
        const res = await watcher.cleanupWorktreesAfterPrOpen(deps({ cleanupWorktrees: stubCleanup(calls), ...over }));
        assert.strictEqual(calls.length, 0, label);
        assert.ok(res[0].deferred, label);
        assert.strictEqual(read(dir).worktrees_removed_on_pr_open_at, undefined, label);
    }
});

test('falha na remoção não lança: worktree do app-back ficou → cópias desfeitas, erro + evento gravados no próprio worktree', async () => {
    reset();
    const dir = seed('7106', '7106-a');
    const calls = [];
    const res = await watcher.cleanupWorktreesAfterPrOpen(deps({
        cleanupWorktrees: stubCleanup(calls, id => ({ removed: [], kept: [], errors: [{ path: path.join(wts, id), error: 'fatal: boom' }] })),
    }));
    assert.strictEqual(res[0].errors.length, 1);
    assert.ok(!fs.existsSync(path.join(runs, '_archive', '7106-a')), 'cópia desfeita — sem task duplicada');
    const st = read(dir);
    assert.ok(st.worktrees_removed_on_pr_open_at, 'uma tentativa por ciclo — o resto sai no pós-merge');
    assert.strictEqual(st.worktrees_cleanup_errors[0].error, 'fatal: boom');
    assert.strictEqual(st.events.at(-1).type, 'worktree_cleanup_failed');

    // Cleanup que lança também não derruba a varredura.
    reset();
    seed('7107', '7107-a');
    const r2 = await watcher.cleanupWorktreesAfterPrOpen(deps({ cleanupWorktrees: async () => { throw new Error('git sumiu'); } }));
    assert.match(r2[0].errors[0].error, /git sumiu/);
});

test('runs legados de OUTROS tickets versionados no worktree (branch da development): não disparam nem são copiados (#43746)', async () => {
    reset();
    const legacy = seed('7108', '43499-recusa-qa');           // committed + URL de PR, mas é de outro ticket
    seed('7108', '2026-09-21-remover-liquibase');                // task-id datado, idem
    const calls = [];
    const res = await watcher.cleanupWorktreesAfterPrOpen(deps({ cleanupWorktrees: stubCleanup(calls) }));
    assert.strictEqual(calls.length, 0, 'worktree do ticket recém-criado não é removido');
    assert.deepStrictEqual(res, []);
    assert.ok(fs.existsSync(legacy));
    assert.ok(!fs.existsSync(path.join(runs, '_archive')), 'nada copiado pro checkout principal');

    // Com o PR do próprio ticket aberto, remove e copia só os runs do ticket.
    seed('7108', '7108-a');
    await watcher.cleanupWorktreesAfterPrOpen(deps({ cleanupWorktrees: stubCleanup(calls) }));
    assert.strictEqual(calls.length, 1);
    assert.ok(fs.existsSync(path.join(runs, '_archive', '7108-a')));
    assert.ok(!fs.existsSync(path.join(runs, '_archive', '43499-recusa-qa')));
    assert.ok(!fs.existsSync(path.join(runs, '_archive', '2026-09-21-remover-liquibase')));
});

test('openedPrUrls: objeto por repo, URL solta legada, entrada plana; ignora entrada sem URL', () => {
    assert.deepStrictEqual(watcher.openedPrUrls(PR).length, 2);
    assert.deepStrictEqual(watcher.openedPrUrls({ 'app-back': 'https://x/pr/1', 'app-core': {} }), ['https://x/pr/1']);
    assert.deepStrictEqual(watcher.openedPrUrls('https://x/pr/3'), ['https://x/pr/3']);
    assert.deepStrictEqual(watcher.openedPrUrls({ url: 'https://x/pr/4', id: 4 }), ['https://x/pr/4']);
    assert.deepStrictEqual(watcher.openedPrUrls(undefined), []);
    assert.deepStrictEqual(watcher.openedPrUrls({ 'app-back': { url: '' } }), []);
});
