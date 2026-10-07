// node --test scripts/lib/qa-retry-watcher.test.js
// Recusa QA no watcher: detecção no polling (ticket_status + qa_rejection no run mais
// recente, inclusive arquivado), ticket com run anterior não abre ciclo novo, e o
// retry-signal.json do dashboard traz o run de volta pro worktree com node=implement.
// REPO_PATH sintético, fetch stubado (Redmine falso), worktree já existente (sem git).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(process.env.CLAUDE_JOB_DIR ? path.join(process.env.CLAUDE_JOB_DIR, 'tmp') : os.tmpdir(), 'qa-retry-watcher-'));
const repo = path.join(tmp, 'app-back');
fs.mkdirSync(repo, { recursive: true });
process.env.REPO_PATH = repo;
process.env.REDMINE_URL = 'http://redmine.test';
process.env.REDMINE_API_KEY = 'chave-watcher-teste';
delete process.env.WATCHER_RECUSA_QA_NOVO_CICLO;

const calls = [];
const statusName = { 13: 'Recusa QA', 2: 'Em Desenvolvimento' };
global.fetch = async (url) => {
    calls.push(String(url));
    const m = String(url).match(/\/issues\/(\d+)\.json(\?include=journals)?$/);
    const id = m && Number(m[1]);
    const body = m && m[2]
        ? { issue: { id, journals: [
            { id: 70, created_on: '2026-09-24T09:00:00Z', notes: '', details: [{ name: 'status_id', new_value: '13' }] },
            { id: 71, created_on: '2026-09-24T09:05:00Z', notes: 'Botão salvar não grava UF', details: [] },
        ] } }
        : { issue: ticket(id, 2) };
    return { ok: true, status: 200, json: async () => body };
};

const watcher = require('../readmine-watcher');

function ticket(id, statusId) {
    return {
        id, subject: `Ticket ${id}`, description: '', status: { id: statusId, name: statusName[statusId] }, tracker: { name: 'Melhoria' },
        custom_fields: [{ name: 'Branch Liberação', value: 'Dev - Local' }], updated_on: new Date().toISOString(),
    };
}
const UPDATED = '2026-09-20T10:00:00.000Z';
function archived(id, extra = {}) {
    const taskId = `${id}-entrega`;
    const dir = path.join(repo, 'memory', 'runs', '_archive', taskId);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({
        task_id: taskId, node: 'commit', history: ['fetch_ticket', 'plan', 'implement', 'review', 'test', 'verify', 'commit'],
        status: 'committed', started_at: UPDATED, updated_at: UPDATED, redmine_ticket: { id }, ...extra,
    }, null, 2));
    fs.writeFileSync(path.join(dir, 'context.md'), '# Contexto\n');
    return { taskId, dir };
}
const read = dir => JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'));

test('syncQaRejection: grava ticket_status + qa_rejection no run arquivado, sem mexer em updated_at', async () => {
    const { dir } = archived(92001);
    await watcher.syncQaRejection(ticket(92001, 13));
    const st = read(dir);
    assert.strictEqual(st.ticket_status, 'Recusa QA');
    assert.deepStrictEqual(st.qa_rejection, { note: 'Botão salvar não grava UF', rejected_at: '2026-09-24T09:00:00Z', journal_id: 71 });
    assert.strictEqual(st.updated_at, UPDATED);
    assert.strictEqual(st.status, 'committed');

    // Mesmo status no tick seguinte: nem busca journals de novo.
    const before = calls.length;
    await watcher.syncQaRejection(ticket(92001, 13));
    assert.strictEqual(calls.length, before);
});

test('dispatchTicket: Recusa QA com run anterior espera o botão, não abre fetch_ticket', async () => {
    archived(92002);
    const out = await watcher.dispatchTicket(ticket(92002, 13));
    assert.deepStrictEqual(out, { action: 'skip', reason: 'recusa_qa_aguardando_retry', taskId: '92002-entrega' });
    assert.ok(!fs.existsSync(path.join(repo, '.claude', 'worktrees', '92002')), 'nenhum worktree criado');
});

test('consumeQaRetrySignals: traz o run do _archive pro worktree, implement a despachar, sinal removido', async () => {
    const { taskId, dir } = archived(92003, { node: 'implement', status: 'in_progress', qa_retry_count: 1 });
    fs.writeFileSync(path.join(dir, 'retry-signal.json'), JSON.stringify({ node: 'implement' }));
    fs.mkdirSync(path.join(repo, '.claude', 'worktrees', '92003'), { recursive: true }); // worktree já existe

    const ids = await watcher.consumeQaRetrySignals();
    assert.deepStrictEqual(ids, [92003]);
    const target = path.join(repo, '.claude', 'worktrees', '92003', 'memory', 'runs', taskId);
    assert.ok(!fs.existsSync(dir), 'saiu do _archive');
    assert.ok(!fs.existsSync(path.join(target, 'retry-signal.json')), 'sinal consumido');
    const st = read(target);
    assert.strictEqual(st.node, 'implement');
    assert.strictEqual(st.status, 'in_progress');
    assert.strictEqual(st.task_id, taskId, 'mesmo task-id, sem run novo');
    assert.strictEqual(watcher.findActiveTask(92003).taskId, taskId);
    assert.match(watcher.qaRetryNote(taskId, 'implement'), /RETRY de Recusa QA/);
    assert.strictEqual(watcher.qaRetryNote(taskId, 'implement'), '', 'nota só no primeiro despacho');

    // Sem sinal: nada a fazer.
    assert.deepStrictEqual(await watcher.consumeQaRetrySignals(), []);
});

test('consumeQaRetrySignals: destino ocupado mantém o sinal e não sobrescreve', async () => {
    const { taskId, dir } = archived(92004, { node: 'implement', status: 'in_progress' });
    fs.writeFileSync(path.join(dir, 'retry-signal.json'), '{"node":"implement"}');
    const target = path.join(repo, '.claude', 'worktrees', '92004', 'memory', 'runs', taskId);
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(target, 'marker'), 'x');
    assert.deepStrictEqual(await watcher.consumeQaRetrySignals(), []);
    assert.ok(fs.existsSync(path.join(dir, 'retry-signal.json')));
    assert.ok(fs.existsSync(path.join(target, 'marker')));
});

test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
