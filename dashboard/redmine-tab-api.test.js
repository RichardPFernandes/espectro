// node --test redmine-tab-api.test.js
// Aba "Redmine": GET /api/tickets (enriquecido com run/PR do state.json), GET
// /api/tickets/:id, GET /api/tickets/statuses, PUT /api/tickets/:id/status e POST
// /api/tickets/:id/note. Funções da lib injetadas — nunca bate no Redmine de verdade.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createDashboard } = require('./server');

const tmpBase = process.env.CLAUDE_JOB_DIR ? path.join(process.env.CLAUDE_JOB_DIR, 'tmp') : os.tmpdir();
const tmp = fs.mkdtempSync(path.join(tmpBase, 'redmine-tab-api-'));
const runs = path.join(tmp, 'memory', 'runs');
const KEY = 'chave-super-secreta-redmine-tab';

function writeRun(taskId, state) {
    fs.mkdirSync(path.join(runs, taskId), { recursive: true });
    fs.writeFileSync(path.join(runs, taskId, 'state.json'), JSON.stringify({ task_id: taskId, node: 'implement', history: ['plan'], status: 'in_progress', updated_at: '2026-09-28T10:00:00Z', ...state }, null, 2));
    fs.writeFileSync(path.join(runs, taskId, 'context.md'), '# Contexto\n');
}

const list = [
    { id: 43700, subject: 'Com run e PR', status: 'Em Desenvolvimento', priority: 'Urgente', updated_on: '2026-09-28T10:00:00Z' },
    { id: 43701, subject: 'Sem run', status: 'Novo', priority: 'Normal', updated_on: '2026-09-27T10:00:00Z' },
];
let listCalls = 0;
const calls = { status: [], note: [] };
let writeError = null;

let dash, base;
test.before(async () => {
    process.env.REDMINE_API_KEY = KEY;
    process.env.REDMINE_URL = 'http://redmine.test/';
    writeRun('43700-com-pr', { redmine_ticket: { id: 43700 }, pull_request: { 'app-back': { url: 'https://bitbucket.org/ws/app-back/pull-requests/12', id: 12 } } });
    dash = createDashboard({
        memoryDir: runs,
        worktreesDir: path.join(tmp, 'wt'),
        prefsFile: path.join(tmp, 'prefs.json'),
        fetchAssignedTickets: async () => { listCalls++; return list.map(t => ({ ...t })); },
        getTicketDetail: async id => {
            if (String(id) === '404') { const e = new Error('Redmine HTTP 404'); e.status = 404; throw e; }
            return { id: Number(id), subject: 'Detalhe', description: 'd', status: 'Em Desenvolvimento', status_id: 2, priority: 'Urgente', allowed_statuses: null,
                journals: [{ id: 1, user: 'QA', notes: '', created_on: null, details: [{ property: 'attr', name: 'status_id', old_value: '2', new_value: '7', old_label: 'Em Desenvolvimento', new_label: 'Recusada QA' }] }] };
        },
        listIssueStatuses: async () => [{ id: 2, name: 'Em Desenvolvimento', is_closed: false }],
        updateTicketStatus: async (id, statusId, note) => {
            if (writeError) throw writeError;
            if (!/^\d+$/.test(String(statusId ?? ''))) { const e = new Error('statusId inválido'); e.status = 400; throw e; }
            calls.status.push({ id, statusId, note }); return { ok: true };
        },
        addJournalNote: async (id, note) => { if (writeError) throw writeError; calls.note.push({ id, note }); return { ok: true }; },
        dispatchNode: async () => ({ action: 'dispatched' }),
    });
    await new Promise(r => dash.server.listen(0, '127.0.0.1', r));
    base = `http://localhost:${dash.server.address().port}`;
    await dash.ready;
    await new Promise(r => setTimeout(r, 200));
});
test.after(async () => {
    await dash.close();
    delete process.env.REDMINE_API_KEY;
    delete process.env.REDMINE_URL;
    fs.rmSync(tmp, { recursive: true, force: true });
});

const call = async (method, p, body) => {
    const res = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    return { status: res.status, text, body: JSON.parse(text) };
};

test('GET /api/tickets: enriquece com run vinculado, PR do state.json e link do Redmine', async () => {
    const r = await call('GET', '/api/tickets');
    assert.strictEqual(r.status, 200);
    const [a, b] = r.body;
    assert.strictEqual(a.linkedRun.taskId, '43700-com-pr');
    assert.strictEqual(a.prUrl, 'https://bitbucket.org/ws/app-back/pull-requests/12');
    assert.strictEqual(a.url, 'http://redmine.test/issues/43700');
    assert.strictEqual(b.linkedRun, null);
    assert.strictEqual(b.prUrl, null);
    assert.ok(!r.text.includes(KEY));
});

test('GET /api/tickets/statuses não cai na rota :id', async () => {
    const r = await call('GET', '/api/tickets/statuses');
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(r.body, [{ id: 2, name: 'Em Desenvolvimento', is_closed: false }]);
});

test('GET /api/tickets/:id: { ticket, journals, linkedRun, prUrl }', async () => {
    const r = await call('GET', '/api/tickets/43700');
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.ticket.id, 43700);
    assert.strictEqual(r.body.ticket.url, 'http://redmine.test/issues/43700');
    assert.strictEqual(r.body.ticket.journals, undefined);
    assert.strictEqual(r.body.journals[0].details[0].new_label, 'Recusada QA');
    assert.strictEqual(r.body.linkedRun.taskId, '43700-com-pr');
    assert.match(r.body.prUrl, /pull-requests\/12$/);
});

test('GET /api/tickets/:id: 404 do Redmine vira 404; id não numérico => 400', async () => {
    assert.strictEqual((await call('GET', '/api/tickets/404')).status, 404);
    assert.strictEqual((await call('GET', '/api/tickets/abc')).status, 400);
});

test('PUT /api/tickets/:id/status: repassa statusId/note e invalida o cache da lista', async () => {
    await call('GET', '/api/tickets');
    const before = listCalls;
    const r = await call('PUT', '/api/tickets/43700/status', { statusId: 7, note: 'recusado' });
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(r.body, { ok: true });
    assert.deepStrictEqual(calls.status.at(-1), { id: '43700', statusId: 7, note: 'recusado' });
    await call('GET', '/api/tickets');
    assert.strictEqual(listCalls, before + 1, 'lista deve ser rebuscada depois de escrever no Redmine');
});

test('PUT /api/tickets/:id/status: statusId inválido => 400', async () => {
    const r = await call('PUT', '/api/tickets/43700/status', { statusId: 'x' });
    assert.strictEqual(r.status, 400);
});

test('POST /api/tickets/:id/note: repassa a nota', async () => {
    const r = await call('POST', '/api/tickets/43701/note', { note: 'olá' });
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(calls.note.at(-1), { id: '43701', note: 'olá' });
});

test('escrita com erro do Redmine: status HTTP preservado e key nunca na resposta', async () => {
    writeError = Object.assign(new Error(`Redmine HTTP 422: Status is invalid (X-Redmine-API-Key: ${KEY})`), { status: 422 });
    try {
        const r1 = await call('PUT', '/api/tickets/43700/status', { statusId: 2 });
        assert.strictEqual(r1.status, 422);
        assert.ok(!r1.text.includes(KEY), r1.text);
        writeError = new Error(`rede caiu ${KEY}`);
        const r2 = await call('POST', '/api/tickets/43700/note', { note: 'x' });
        assert.strictEqual(r2.status, 502);
        assert.ok(!r2.text.includes(KEY), r2.text);
    } finally { writeError = null; }
});

test('rota de escrita recusa Origin externo (CSRF)', async () => {
    const res = await fetch(base + '/api/tickets/43700/note', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'http://evil.example' }, body: JSON.stringify({ note: 'x' }) });
    assert.strictEqual(res.status, 403);
});
