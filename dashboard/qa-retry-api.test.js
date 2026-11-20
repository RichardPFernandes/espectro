// node --test qa-retry-api.test.js
// POST /api/runs/:taskId/retry-qa-rejection contra um Redmine falso, usando o
// scripts/lib/redmine-journal-fetcher.js de verdade (a chave passa pelo header real).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { createDashboard } = require('./server');

const KEY = 'redmine-chave-secreta-de-teste-123';
const tmpBase = process.env.CLAUDE_JOB_DIR ? path.join(process.env.CLAUDE_JOB_DIR, 'tmp') : os.tmpdir();
const tmp = fs.mkdtempSync(path.join(tmpBase, 'qa-retry-'));
const runs = path.join(tmp, 'memory', 'runs');

function writeRun(taskId, state, context = '# Contexto\n\nciclo anterior\n') {
    fs.mkdirSync(path.join(runs, taskId), { recursive: true });
    fs.writeFileSync(path.join(runs, taskId, 'state.json'), JSON.stringify({ task_id: taskId, node: 'commit', history: ['plan', 'implement', 'review', 'test', 'verify', 'commit'], status: 'committed', ...state }, null, 2));
    fs.writeFileSync(path.join(runs, taskId, 'context.md'), context);
}
const readRun = taskId => JSON.parse(fs.readFileSync(path.join(runs, taskId, 'state.json'), 'utf8'));
const readCtx = taskId => fs.readFileSync(path.join(runs, taskId, 'context.md'), 'utf8');
const signalOf = taskId => path.join(runs, taskId, 'retry-signal.json');

// Tickets do Redmine falso: id -> { status, journals, journalsFail, denyTransition }.
const issues = new Map();
const seen = [];
const STATUS = { 2: 'Em Desenvolvimento', 13: 'Recusa QA' };
const redmine = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
        seen.push({ method: req.method, url: req.url, key: req.headers['x-redmine-api-key'], body });
        const m = req.url.match(/^\/issues\/(\d+)\.json(\?include=journals)?$/);
        const issue = m && issues.get(Number(m[1]));
        if (!issue) { res.writeHead(404); return res.end('{}'); }
        if (req.method === 'PUT') {
            const sid = JSON.parse(body).issue?.status_id;
            if (!issue.denyTransition) issue.status = sid;
            res.writeHead(204); return res.end();
        }
        if (m[2] && issue.journalsFail) { res.writeHead(500); return res.end('{}'); }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ issue: {
            id: Number(m[1]), status: { id: issue.status, name: STATUS[issue.status] },
            ...(m[2] ? { journals: issue.journals || [] } : {}),
        } }));
    });
});

const logs = [];
const orig = { log: console.log, warn: console.warn, error: console.error };
let dash, base;
test.before(async () => {
    for (const k of ['log', 'warn', 'error']) console[k] = (...a) => { logs.push(a.join(' ')); };
    await new Promise(r => redmine.listen(0, '127.0.0.1', r));
    process.env.REDMINE_URL = `http://127.0.0.1:${redmine.address().port}`;
    process.env.REDMINE_API_KEY = KEY;
    dash = createDashboard({ memoryDir: runs, worktreesDir: path.join(tmp, 'wt'), prefsFile: path.join(tmp, 'prefs.json') });
    await new Promise(r => dash.server.listen(0, '127.0.0.1', r));
    base = `http://localhost:${dash.server.address().port}`;
    await dash.ready;
});
test.after(async () => {
    Object.assign(console, orig);
    await dash.close();
    redmine.close();
    delete process.env.REDMINE_URL;
    delete process.env.REDMINE_API_KEY;
    fs.rmSync(tmp, { recursive: true, force: true });
});

const post = async p => {
    const res = await fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    const text = await res.text();
    return { status: res.status, text, body: JSON.parse(text) };
};
// GET por id resolve direto no disco (a listagem depende do chokidar já ter visto a pasta).
const listed = async taskId => (await fetch(`${base}/api/runs/${taskId}`)).json();

test('ticket fora de Recusa QA: 400, sem botão e nada escrito', async () => {
    writeRun('50001-ok', { redmine_ticket: { id: 50001 }, ticket_status: 'Ag Teste' });
    issues.set(50001, { status: 2 });
    const r = await post('/api/runs/50001-ok/retry-qa-rejection');
    assert.strictEqual(r.status, 400);
    assert.match(r.body.error, /não está em Recusa QA/);
    assert.strictEqual((await listed('50001-ok')).qaRejected, false);
    assert.ok(!fs.existsSync(signalOf('50001-ok')));
    assert.strictEqual(readRun('50001-ok').status, 'committed');
});

test('Recusa QA: injeta a nota, move o ticket, aponta pro implement e deixa o sinal', async () => {
    writeRun('50002-recusa', { redmine_ticket: { id: 50002 }, ticket_status: 'Recusa QA' });
    issues.set(50002, { status: 13, journals: [
        { id: 900, created_on: '2026-09-24T10:00:00Z', notes: 'nota antiga', details: [] },
        { id: 901, created_on: '2026-09-24T11:00:00Z', notes: '', details: [{ property: 'attr', name: 'status_id', old_value: '9', new_value: '13' }] },
        { id: 902, created_on: '2026-09-24T11:01:00Z', notes: 'Filtro por UF não funciona\nlinha 2', details: [] },
        { id: 903, created_on: '2026-09-24T11:02:00Z', notes: '[Watcher] comentário automático', details: [] },
    ] });
    const before = await listed('50002-recusa');
    assert.strictEqual(before.qaRejected, true);
    assert.strictEqual(before.ticketStatus, 'Recusa QA');

    const r = await post('/api/runs/50002-recusa/retry-qa-rejection');
    assert.strictEqual(r.status, 200, r.text);
    assert.deepStrictEqual({ ok: r.body.ok, note: r.body.note, n: r.body.qa_retry_count }, { ok: true, note: 'Filtro por UF não funciona\nlinha 2', n: 1 });

    const ctx = readCtx('50002-recusa');
    assert.ok(ctx.startsWith('# Contexto\n\nciclo anterior\n'), 'contexto anterior preservado');
    assert.match(ctx, /## Recusa QA — Correção Solicitada \(\d{4}-\d{2}-\d{2}T[^)]+\)\n\nO time de QA recusou a entrega com a seguinte nota:\n\n> Filtro por UF não funciona\n> linha 2\n\n---\n\*\*Instrução para este retry\*\*/);

    const st = readRun('50002-recusa');
    assert.strictEqual(st.node, 'implement');
    assert.strictEqual(st.status, 'in_progress');
    assert.strictEqual(st.ticket_status, 'Em Desenvolvimento');
    assert.strictEqual(st.qa_retry_count, 1);
    assert.deepStrictEqual({ ...st.qa_rejection, retry_requested_at: undefined },
        { note: 'Filtro por UF não funciona\nlinha 2', rejected_at: '2026-09-24T11:00:00Z', journal_id: 902, retry_requested_at: undefined });
    assert.strictEqual(JSON.parse(fs.readFileSync(signalOf('50002-recusa'), 'utf8')).node, 'implement');

    const put = seen.find(s => s.method === 'PUT' && s.url === '/issues/50002.json');
    assert.deepStrictEqual(JSON.parse(put.body), { issue: { status_id: 2 } });
    assert.strictEqual(put.key, KEY);
    assert.strictEqual(issues.get(50002).status, 2);

    const after = await listed('50002-recusa');
    assert.strictEqual(after.qaRejected, false);
    assert.strictEqual(after.qaRetryPending, true);

    // Segundo clique: o ticket já saiu de Recusa QA.
    assert.strictEqual((await post('/api/runs/50002-recusa/retry-qa-rejection')).status, 400);
});

test('journals fora do ar: retry segue com "(sem nota registrada)" e conta o 2º retry', async () => {
    writeRun('50003-semnota', { redmine_ticket: { id: 50003 }, ticket_status: 'Recusada QA', qa_retry_count: 1 });
    issues.set(50003, { status: 13, journalsFail: true });
    const r = await post('/api/runs/50003-semnota/retry-qa-rejection');
    assert.strictEqual(r.status, 200, r.text);
    assert.strictEqual(r.body.note, null);
    assert.match(readCtx('50003-semnota'), /> \(sem nota registrada\)/);
    const st = readRun('50003-semnota');
    assert.strictEqual(st.qa_retry_count, 2);
    assert.strictEqual(st.qa_rejection.note, null);
    assert.strictEqual((await listed('50003-semnota')).qaRetryCount, 2);
});

test('qa_rejections: uma entrada por retry com custo base; run antigo herda a recusa do context.md; qaCycles separa os ciclos', async () => {
    const oldBlock = '\n\n## Recusa QA — Correção Solicitada (2026-09-20T10:00:00.000Z)\n\nO time de QA recusou a entrega com a seguinte nota:\n\n> primeira recusa\n\n---\n**Instrução**\n';
    writeRun('50006-historico', {
        redmine_ticket: { id: 50006 }, ticket_status: 'Recusa QA', qa_retry_count: 1,
        started_at: '2026-09-18T09:00:00Z',
        cost_tracking: { nodes: {}, totals: { input_tokens: 1000, output_tokens: 200, cost_usd: 4.5 } },
        agent_log: [
            { nodes: ['implement'], agent: 'claude', at: '2026-09-18T10:00:00Z', note: 'ciclo principal' },
            { nodes: ['implement'], agent: 'claude', at: '2026-09-20T11:00:00Z', note: 'retry 1' },
            { nodes: ['commit'], agent: 'claude', at: '2026-09-20T12:00:00Z', note: 'commit retry 1' },
        ],
    }, '# Contexto\n' + oldBlock);
    issues.set(50006, { status: 13, journals: [{ id: 77, created_on: '2026-09-25T10:00:00Z', notes: 'segunda recusa', details: [] }] });
    const r = await post('/api/runs/50006-historico/retry-qa-rejection');
    assert.strictEqual(r.status, 200, r.text);
    const hist = readRun('50006-historico').qa_rejections;
    assert.strictEqual(hist.length, 2);
    assert.deepStrictEqual({ n: hist[0].n, note: hist[0].note, at: hist[0].retry_requested_at }, { n: 1, note: 'primeira recusa', at: '2026-09-20T10:00:00.000Z' });
    assert.deepStrictEqual({ n: hist[1].n, note: hist[1].note, j: hist[1].journal_id, usd: hist[1].cost_baseline_usd, tok: hist[1].tokens_baseline },
        { n: 2, note: 'segunda recusa', j: 77, usd: 4.5, tok: 1200 });

    const q = (await listed('50006-historico')).qaCycles;
    assert.strictEqual(q.main.steps, 1);
    assert.deepStrictEqual(q.cycles.map(c => [c.n, c.situation, c.steps.length]), [[1, 'committed', 2], [2, 'running', 0]]);
    assert.strictEqual(q.cycles[1].cost_usd, 0);
    assert.strictEqual(q.pending, null);
});

test('Redmine não aplica a troca de status: 502 e nada local é escrito', async () => {
    writeRun('50004-workflow', { redmine_ticket: { id: 50004 }, ticket_status: 'Recusa QA' });
    issues.set(50004, { status: 13, denyTransition: true, journals: [{ id: 1, created_on: '2026-09-24T10:00:00Z', notes: 'bug', details: [] }] });
    const r = await post('/api/runs/50004-workflow/retry-qa-rejection');
    assert.strictEqual(r.status, 502);
    assert.match(r.body.error, /não aplicou a troca de status/);
    assert.strictEqual(readCtx('50004-workflow'), '# Contexto\n\nciclo anterior\n');
    assert.strictEqual(readRun('50004-workflow').status, 'committed');
    assert.ok(!fs.existsSync(signalOf('50004-workflow')));
});

test('REDMINE_API_KEY nunca aparece em resposta, state, context ou log', async () => {
    writeRun('50005-segredo', { redmine_ticket: { id: 50005 }, ticket_status: 'Recusa QA' });
    issues.set(50005, { status: 13, journals: [{ id: 7, created_on: '2026-09-24T10:00:00Z', notes: 'x', details: [] }] });
    const r = await post('/api/runs/50005-segredo/retry-qa-rejection');
    assert.strictEqual(r.status, 200);
    const everything = [r.text, JSON.stringify(await (await fetch(`${base}/api/runs`)).json()),
        ...['50002-recusa', '50003-semnota', '50004-workflow', '50005-segredo'].flatMap(t => [readCtx(t), JSON.stringify(readRun(t))]),
        ...logs].join('\n');
    assert.ok(!everything.includes(KEY));
});

test('PRI-184: summarize expõe qaRetryBlocked quando o sinal está parado', async () => {
    const at = '2026-10-29T12:00:00.000Z';
    writeRun('50007-blocked', {
        redmine_ticket: { id: 50007 },
        ticket_status: 'Em Desenvolvimento',
        node: 'implement',
        status: 'in_progress',
        qa_retry_count: 1,
        qa_retry_blocked: { reason: 'destino_ocupado', at },
    });
    fs.writeFileSync(signalOf('50007-blocked'), JSON.stringify({ node: 'implement' }));
    const listedRun = await listed('50007-blocked');
    assert.strictEqual(listedRun.qaRetryPending, true);
    assert.deepStrictEqual(listedRun.qaRetryBlocked, { reason: 'destino_ocupado', at });

    writeRun('50008-limpo', {
        redmine_ticket: { id: 50008 },
        ticket_status: 'Em Desenvolvimento',
        node: 'implement',
        status: 'in_progress',
        qa_retry_count: 1,
    });
    const clean = await listed('50008-limpo');
    assert.strictEqual(clean.qaRetryBlocked, null);
    assert.strictEqual(clean.qaRetryPending, false);
});
