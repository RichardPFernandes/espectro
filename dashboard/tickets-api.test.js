// node --test tickets-api.test.js
// GET /api/tickets/mine (cache 30s) e POST /api/runs/start (409 com run ativa,
// 200 sem run — dispatchNode injetado, nunca bate no Redmine/spawna claude de verdade).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createDashboard } = require('./server');

const tmpBase = process.env.CLAUDE_JOB_DIR ? path.join(process.env.CLAUDE_JOB_DIR, 'tmp') : os.tmpdir();
const tmp = fs.mkdtempSync(path.join(tmpBase, 'tickets-api-'));
const runs = path.join(tmp, 'memory', 'runs');
fs.mkdirSync(runs, { recursive: true });

function writeRun(taskId, state) {
    fs.mkdirSync(path.join(runs, taskId), { recursive: true });
    fs.writeFileSync(path.join(runs, taskId, 'state.json'), JSON.stringify({ task_id: taskId, node: 'implement', history: ['plan'], status: 'in_progress', ...state }, null, 2));
    fs.writeFileSync(path.join(runs, taskId, 'context.md'), '# Contexto\n');
}

let fetchCalls = 0;
let fetchResult = [{ id: 43666, subject: 'Painel de tickets', status: 'Novo', priority: 'Alta', updated_on: '2026-09-26T10:00:00Z' }];
const fakeFetchAssignedTickets = async () => { fetchCalls++; return fetchResult; };

let dispatchCalls = [];
let dispatchResult = { action: 'dispatched', node: 'fetch_ticket' };
let dispatchError = null;
const fakeDispatchNode = async (args) => {
    dispatchCalls.push(args);
    if (dispatchError) throw dispatchError;
    return dispatchResult;
};

const REDMINE_KEY = 'chave-super-secreta-xyz';

let dash, base;
test.before(async () => {
    // redact() (server.js) só escrutina valores presentes em process.env no momento
    // do createDashboard — precisa estar setada antes, como qa-retry-api.test.js faz.
    process.env.REDMINE_API_KEY = REDMINE_KEY;
    dash = createDashboard({
        memoryDir: runs,
        worktreesDir: path.join(tmp, 'wt'),
        prefsFile: path.join(tmp, 'prefs.json'),
        fetchAssignedTickets: fakeFetchAssignedTickets,
        dispatchNode: fakeDispatchNode,
    });
    await new Promise(r => dash.server.listen(0, '127.0.0.1', r));
    base = `http://localhost:${dash.server.address().port}`;
    await dash.ready;
});
test.after(async () => {
    await dash.close();
    delete process.env.REDMINE_API_KEY;
    fs.rmSync(tmp, { recursive: true, force: true });
});

const get = async p => { const res = await fetch(base + p); return { status: res.status, body: await res.json() }; };
const post = async (p, body) => {
    const res = await fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}) });
    return { status: res.status, body: await res.json() };
};
const eventually = async (fn, timeoutMs = 3000) => {
    const deadline = Date.now() + timeoutMs;
    do {
        if (await fn()) return true;
        await new Promise(r => setTimeout(r, 50));
    } while (Date.now() < deadline);
    return false;
};

test('GET /api/tickets/mine: devolve a lista e cacheia por 30s', async () => {
    fetchCalls = 0;
    const r1 = await get('/api/tickets/mine');
    assert.strictEqual(r1.status, 200);
    assert.deepStrictEqual(r1.body, fetchResult);
    const r2 = await get('/api/tickets/mine');
    assert.deepStrictEqual(r2.body, fetchResult);
    assert.strictEqual(fetchCalls, 1, 'segunda chamada dentro de 30s não deve bater na fonte de novo');
});

test('POST /api/runs/start: ticketId inválido => 400', async () => {
    const r = await post('/api/runs/start', { ticketId: 'abc' });
    assert.strictEqual(r.status, 400);
});

test('POST /api/runs/start: run ativa para o ticket => 409 com runId, sem chamar dispatchNode', async () => {
    writeRun('43590-em-andamento', { redmine_ticket: { id: 43590 } });
    dispatchCalls = [];
    assert.ok(await eventually(async () => (await get('/api/runs')).body.some(run => run.taskId === '43590-em-andamento')),
        'chokidar não publicou a run ativa em 3s');
    const r = await post('/api/runs/start', { ticketId: '43590' });
    assert.strictEqual(r.status, 409);
    assert.strictEqual(r.body.runId, '43590-em-andamento');
    assert.strictEqual(dispatchCalls.length, 0);
});

test('POST /api/runs/start: sem run ativa => dispara e devolve pending (sem runId ainda)', async () => {
    dispatchCalls = [];
    dispatchResult = { action: 'dispatched', node: 'fetch_ticket' };
    const r = await post('/api/runs/start', { ticketId: '99999' });
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(r.body, { ok: true, ticketId: 99999, runId: null, pending: true });
    assert.strictEqual(dispatchCalls.length, 1);
    assert.strictEqual(dispatchCalls[0].ticketId, 99999);
    assert.strictEqual(dispatchCalls[0].follow, false);
});

test('POST /api/runs/start: dispatchNode devolve skip com motivo conhecido => 422 com mensagem amigável', async () => {
    dispatchResult = { action: 'skip', reason: 'spec_aguardando_aceite' };
    const r = await post('/api/runs/start', { ticketId: '11111' });
    assert.strictEqual(r.status, 422);
    assert.match(r.body.error, /precisa ser aceita no Redmine/);
});

test('POST /api/runs/start: skip de recusa QA com run anterior => 409 reaproveitando o taskId', async () => {
    dispatchResult = { action: 'skip', reason: 'recusa_qa_aguardando_retry', taskId: '22222-antigo' };
    const r = await post('/api/runs/start', { ticketId: '22222' });
    assert.strictEqual(r.status, 409);
    assert.strictEqual(r.body.runId, '22222-antigo');
});

test('POST /api/runs/start: dispatchNode lança (Redmine fora do ar) => 502, sem vazar a key na mensagem', async () => {
    dispatchError = new Error(`fetch falhou usando ${REDMINE_KEY}`);
    try {
        const r = await post('/api/runs/start', { ticketId: '33333' });
        assert.strictEqual(r.status, 502);
        assert.ok(!r.body.error.includes(REDMINE_KEY), r.body.error);
    } finally {
        dispatchError = null;
    }
});
