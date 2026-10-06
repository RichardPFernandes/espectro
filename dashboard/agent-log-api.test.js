// node --test agent-log-api.test.js
// /api/runs/:taskId/agent-log e /agent-log/stream — log do agente (claude -p) em
// tempo real. Distinto de /api/runs/:taskId/log (fim de context.md, já existente).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const tmpBase = process.env.CLAUDE_JOB_DIR ? path.join(process.env.CLAUDE_JOB_DIR, 'tmp') : os.tmpdir();
const tmp = fs.mkdtempSync(path.join(tmpBase, 'agent-log-api-'));
const mainRuns = path.join(tmp, 'memory', 'runs');
fs.mkdirSync(mainRuns, { recursive: true });

function seed(taskId, state) {
    const dir = path.join(mainRuns, taskId);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ task_id: taskId, history: [], ...state }));
    return dir;
}

// Task com ticket (prefixo numérico) — tem log real em memory/runs/<ticketId>.log.
seed('80001-com-log', { node: 'implement', status: 'running', updated_at: '2026-09-28T00:00:00Z' });
fs.writeFileSync(path.join(mainRuns, '80001.log'),
    '2026-09-28T00:00:00.000Z [watcher] iniciando nó implement\n' +
    '2026-09-28T00:00:00.100Z [claude] Lendo arquivos do escopo...\n');

// Task com ticket mas ainda sem nenhuma linha de log (agente não escreveu nada ainda).
seed('80002-sem-log-ainda', { node: 'plan', status: 'running', updated_at: '2026-09-28T00:00:00Z' });

// Task ad-hoc (sem ticket Redmine, task-id começa com data) — ticketIdOf() retorna null.
seed('2026-09-28-tarefa-ad-hoc', { node: 'implement', status: 'running', updated_at: '2026-09-28T00:00:00Z' });

process.env.BITBUCKET_API_TOKEN = 'super-secreto-nao-pode-vazar';
const { createDashboard } = require('./server');
const dash = createDashboard({
    memoryDir: mainRuns,
    agentLogPollMs: 30,
    agentLogStatusPollMs: 40,
    agentLogStreamTimeoutMs: 2000,
});
let base;

test.before(async () => {
    await new Promise(r => dash.server.listen(0, '127.0.0.1', r));
    base = `http://localhost:${dash.server.address().port}`;
    await dash.ready;
});
test.after(async () => {
    await dash.close();
    fs.rmSync(tmp, { recursive: true, force: true });
});

async function call(method, p) {
    const res = await fetch(base + p, { method });
    return { status: res.status, headers: res.headers, body: await res.text() };
}

// Lê eventos SSE (event + data) até `done(events)` dar true, ou até a conexão fechar.
function sse(p, done, ms = 3000) {
    return new Promise((resolve, reject) => {
        const events = [];
        const req = http.get(base + p, res => {
            assert.match(res.headers['content-type'], /^text\/event-stream/);
            let buf = '';
            res.setEncoding('utf8');
            res.on('data', chunk => {
                buf += chunk;
                let i;
                while ((i = buf.indexOf('\n\n')) !== -1) {
                    const block = buf.slice(0, i); buf = buf.slice(i + 2);
                    const type = (block.match(/^event: (.+)$/m) || [])[1] || 'message';
                    const data = (block.match(/^data: (.+)$/m) || [])[1];
                    if (data) events.push({ type, data: JSON.parse(data) });
                }
                if (done && done(events)) { clearTimeout(timer); req.destroy(); resolve(events); }
            });
            res.on('end', () => { clearTimeout(timer); resolve(events); });
        });
        const timer = setTimeout(() => { req.destroy(); reject(new Error(`SSE timeout: ${JSON.stringify(events)}`)); }, ms);
        req.on('error', e => { if (!req.destroyed) reject(e); });
    });
}

test('GET /agent-log: taskId inexistente → 404', async () => {
    const r = await call('GET', '/api/runs/nao-existe-123/agent-log');
    assert.strictEqual(r.status, 404);
});

test('GET /agent-log: histórico completo, com linhas [watcher]/[claude]', async () => {
    const r = await call('GET', '/api/runs/80001-com-log/agent-log');
    assert.strictEqual(r.status, 200);
    assert.match(r.headers.get('content-type'), /^text\/plain/);
    assert.match(r.body, /\[watcher\] iniciando nó implement/);
    assert.match(r.body, /\[claude\] Lendo arquivos do escopo/);
});

test('GET /agent-log: task com ticket mas sem log ainda → 200 vazio (não erro)', async () => {
    const r = await call('GET', '/api/runs/80002-sem-log-ainda/agent-log');
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body, '');
});

test('GET /agent-log: task ad-hoc (sem ticket) → 200 com mensagem informativa, não erro', async () => {
    const r = await call('GET', '/api/runs/2026-09-28-tarefa-ad-hoc/agent-log');
    assert.strictEqual(r.status, 200);
    assert.match(r.body, /sem ticket Redmine/);
});

test('GET /agent-log: nenhum token do ambiente aparece na resposta (defesa em profundidade)', async () => {
    const dir = path.join(mainRuns, '80003-com-secret-vazando');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ task_id: '80003-com-secret-vazando', history: [], node: 'implement', status: 'running' }));
    // Simula um bug hipotético de sanitização upstream: garante que o /agent-log
    // (via redact()) ainda pega o secret antes de responder.
    fs.writeFileSync(path.join(mainRuns, '80003.log'), `2026-09-28T00:00:00Z [claude] token=${process.env.BITBUCKET_API_TOKEN}\n`);
    const r = await call('GET', '/api/runs/80003-com-secret-vazando/agent-log');
    assert.strictEqual(r.status, 200);
    assert.ok(!r.body.includes(process.env.BITBUCKET_API_TOKEN), 'token vazou na resposta');
    assert.match(r.body, /\*\*\*/);
});

test('SSE /agent-log/stream: envia histórico existente e depois linhas novas ao vivo', async () => {
    const logPath = path.join(mainRuns, '80001.log');
    const stream = sse('/api/runs/80001-com-log/agent-log/stream',
        evs => evs.some(e => e.data === '2026-09-28T00:00:01.000Z [claude] linha nova ao vivo'));
    await new Promise(r => setTimeout(r, 80)); // garante que o stream já mandou o histórico inicial
    fs.appendFileSync(logPath, '2026-09-28T00:00:01.000Z [claude] linha nova ao vivo\n');
    const events = await stream;
    const logs = events.filter(e => e.type === 'log').map(e => e.data);
    assert.ok(logs.some(l => l.includes('iniciando nó implement')), 'histórico inicial não chegou');
    assert.ok(logs.some(l => l.includes('linha nova ao vivo')), 'linha ao vivo não chegou');
});

test('SSE /agent-log/stream: fecha sozinho quando o run deixa de estar running', async () => {
    seed('80004-vai-terminar', { node: 'test', status: 'running', updated_at: '2026-09-28T00:00:00Z' });
    const dir = path.join(mainRuns, '80004-vai-terminar');
    const closePromise = sse('/api/runs/80004-vai-terminar/agent-log/stream', null, 2000);
    await new Promise(r => setTimeout(r, 60));
    fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ task_id: '80004-vai-terminar', history: ['plan', 'implement', 'review', 'test'], node: 'verify', status: 'committed' }));
    await closePromise; // resolve via 'end' do http quando res.end() é chamado no servidor
});

test('SSE /agent-log/stream: task ad-hoc manda mensagem informativa e fecha na hora', async () => {
    const events = await sse('/api/runs/2026-09-28-tarefa-ad-hoc/agent-log/stream', null, 2000);
    const logs = events.filter(e => e.type === 'log').map(e => e.data);
    assert.ok(logs.some(l => /sem ticket Redmine/.test(l)));
});
