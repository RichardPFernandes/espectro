// node --test approval-idempotency-api.test.js
// O4 do /review da Task 76 (docs/concurrency-map.md, "Aprovação pelo dashboard"): a
// aprovação posta UM comentário no Redmine por operation_id, mesmo com pedidos
// simultâneos (reserva dentro do lock — cas.reserveOperation) e com tentativa anterior
// de resultado incerto (timeout/5xx/crash: confere o marcador no ticket antes de repostar).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { createDashboard } = require('./server');
const stateWriter = require('../scripts/state-writer');

const SECRET = 'redmine-chave-secreta-aprovacao-321';
const tmpBase = process.env.CLAUDE_JOB_DIR ? path.join(process.env.CLAUDE_JOB_DIR, 'tmp') : os.tmpdir();
const tmp = fs.mkdtempSync(path.join(tmpBase, 'approval-idem-'));
const runs = path.join(tmp, 'memory', 'runs');

// Redmine falso: PUT grava a nota (com atraso e status configuráveis), GET devolve os journals.
const journals = new Map(); // ticket -> [{ id, notes }]
const puts = [];
let putDelayMs = 0;
const putStatus = []; // fila: status da próxima resposta de PUT (padrão 200); 'drop' = derruba a conexão
const redmine = http.createServer((req, res) => {
    const m = req.url.match(/^\/issues\/(\d+)\.json/);
    const id = m && Number(m[1]);
    if (req.method === 'GET') {
        res.setHeader('Content-Type', 'application/json');
        return res.end(JSON.stringify({ issue: { id, journals: journals.get(id) || [] } }));
    }
    let body = '';
    req.on('data', d => { body += d; });
    req.on('end', () => setTimeout(() => {
        const status = putStatus.shift() ?? 200;
        const notes = JSON.parse(body).issue.notes;
        puts.push({ id, notes, status });
        if (status === 'drop') { journals.set(id, [...(journals.get(id) || []), { id: puts.length, notes }]); return req.socket.destroy(); }
        if (status < 400 || status >= 500) journals.set(id, [...(journals.get(id) || []), { id: puts.length, notes }]); // 5xx: gravou e falhou
        res.statusCode = status === 'drop' ? 500 : status;
        res.end('{}');
    }, putDelayMs));
});

function seed(taskId, ticket) {
    stateWriter.init(path.join(runs, taskId), {
        task_id: taskId, node: 'implement', history: ['plan'], status: 'spec-change-pending-approval', started_at: '2026-10-01T10:00:00Z',
        redmine_ticket: { id: ticket }, spec_hash: 'a'.repeat(64),
        spec_change_pending: { id: 'SC-001', posted_at: '2026-10-01T10:00:00Z', spec_hash: 'a'.repeat(64) },
    });
}
const stateOf = taskId => JSON.parse(fs.readFileSync(path.join(runs, taskId, 'state.json'), 'utf8'));

let dash, base;
const orig = { log: console.log, warn: console.warn, error: console.error };
test.before(async () => {
    for (const k of ['log', 'warn', 'error']) console[k] = () => {};
    await new Promise(r => redmine.listen(0, '127.0.0.1', r));
    process.env.REDMINE_URL = `http://127.0.0.1:${redmine.address().port}`;
    process.env.REDMINE_API_KEY = SECRET;
    process.env.STATE_CONFLICTS_LOG = path.join(tmp, 'logs', 'state-conflicts.jsonl');
    dash = createDashboard({ memoryDir: runs, worktreesDir: path.join(tmp, 'wt'), prefsFile: path.join(tmp, 'prefs.json') });
    await new Promise(r => dash.server.listen(0, '127.0.0.1', r));
    base = `http://localhost:${dash.server.address().port}`;
    await dash.ready;
});
test.after(async () => {
    Object.assign(console, orig);
    await dash.close();
    redmine.close();
    for (const k of ['REDMINE_URL', 'REDMINE_API_KEY', 'STATE_CONFLICTS_LOG']) delete process.env[k];
    fs.rmSync(tmp, { recursive: true, force: true });
});

async function approve(taskId, operationId) {
    const token = (await (await fetch(`${base}/api/runs/${taskId}`)).json()).casToken;
    const r = await fetch(`${base}/api/redmine/comment`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ taskId, action: 'approve', ...token, operation_id: operationId }),
    });
    return { status: r.status, body: await r.json() };
}
const putsFor = ticket => puts.filter(p => p.id === ticket);

test('O4. pedidos simultâneos com o mesmo operation_id: UM comentário no Redmine', async () => {
    seed('70001-aprova', 70001);
    putDelayMs = 150; // o primeiro PUT ainda em voo quando os outros chegam
    try {
        const results = await Promise.all(Array.from({ length: 5 }, () => approve('70001-aprova', 'click-aaaa-0001')));
        assert.strictEqual(putsFor(70001).length, 1, 'side effect uma vez só');
        assert.deepStrictEqual(results.map(r => r.status).sort(), [200, 409, 409, 409, 409]);
        assert.ok(results.filter(r => r.status === 409).every(r => r.body.code === 'OPERATION_IN_PROGRESS'));
        assert.match(putsFor(70001)[0].notes, /\[op dashboard:click-aaaa-0001\]$/);
    } finally {
        putDelayMs = 0;
    }
    // Repetição depois do desfecho: already_processed, sem novo PUT.
    const again = await approve('70001-aprova', 'click-aaaa-0001');
    assert.deepStrictEqual([again.status, again.body.status], [200, 'already_processed']);
    assert.strictEqual(putsFor(70001).length, 1);
    const st = stateOf('70001-aprova');
    assert.ok(st.processed_operations.some(o => o.operation_id === 'dashboard:click-aaaa-0001'));
    assert.ok(!('pending_operations' in st));
});

test('O4. 5xx depois de gravar — crash durante o efeito: retry com o mesmo id confere o ticket e NÃO reposta', async () => {
    seed('70002-incerto', 70002);
    putStatus.push(503);
    const first = await approve('70002-incerto', 'click-bbbb-0002');
    assert.strictEqual(first.status, 502);
    assert.strictEqual(stateOf('70002-incerto').pending_operations[0].uncertain, true);
    const retry = await approve('70002-incerto', 'click-bbbb-0002');
    assert.deepStrictEqual([retry.status, retry.body.status], [200, 'already_processed']);
    assert.strictEqual(putsFor(70002).length, 1, 'nenhum comentário duplicado');
});

test('O4. conexão caída no meio do PUT — gravou: retry não duplica', async () => {
    seed('70005-caiu', 70005);
    putStatus.push('drop');
    assert.strictEqual((await approve('70005-caiu', 'click-eeee-0005')).status, 502);
    const retry = await approve('70005-caiu', 'click-eeee-0005');
    assert.strictEqual(retry.body.status, 'already_processed');
    assert.strictEqual(putsFor(70005).length, 1);
});

test('O4. 4xx — Redmine recusou, nada gravado: reserva liberada, retry posta normalmente', async () => {
    seed('70003-recusado', 70003);
    putStatus.push(422);
    assert.strictEqual((await approve('70003-recusado', 'click-cccc-0003')).status, 502);
    assert.ok(!('pending_operations' in stateOf('70003-recusado')));
    const retry = await approve('70003-recusado', 'click-cccc-0003');
    assert.strictEqual(retry.status, 200);
    assert.strictEqual(putsFor(70003).length, 2, '1ª recusada + a que valeu');
    assert.strictEqual(journals.get(70003).length, 1);
});

test('O4. dashboard morto antes do PUT — reserva vencida, nada no ticket: o próximo clique posta uma vez', async () => {
    seed('70004-morto', 70004);
    // Crash antes do efeito: a reserva ficou, ninguém postou.
    stateWriter.update(path.join(runs, '70004-morto'), s => {
        s.pending_operations = [{ operation_id: 'dashboard:click-dddd-0004', type: 'SPEC_CHANGE_APPROVAL', reserved_at: new Date(Date.now() - 10 * 60 * 1000).toISOString(), pid: 999999 }];
    });
    const r = await approve('70004-morto', 'click-dddd-0004');
    assert.strictEqual(r.status, 200);
    assert.strictEqual(putsFor(70004).length, 1);
    // Reserva viva (dono ainda no meio do PUT, dentro do TTL): espera, não reposta.
    seed('70006-vivo', 70006);
    stateWriter.update(path.join(runs, '70006-vivo'), s => {
        s.pending_operations = [{ operation_id: 'dashboard:click-ffff-0006', type: 'SPEC_CHANGE_APPROVAL', reserved_at: new Date().toISOString(), pid: process.pid }];
    });
    const busy = await approve('70006-vivo', 'click-ffff-0006');
    assert.deepStrictEqual([busy.status, busy.body.code], [409, 'OPERATION_IN_PROGRESS']);
    assert.strictEqual(putsFor(70006).length, 0);
});
