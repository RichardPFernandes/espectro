// node --test resume-session-api.test.js
// POST /api/runs/:taskId/resume-session — retomada manual de um run travado em
// status="session_limit" (estouro de contexto/tokens da sessão anterior, ver
// looksLikeSessionLimit em scripts/readmine-watcher.js). dispatchNode é injetado
// (fake) porque o mecanismo real spawna `claude` de verdade via
// scripts/lib/node-dispatcher.js — o mesmo padrão de options.qaRedmine em
// qa-retry-api.test.js, aqui via options.dispatchNode (ver dashboard/server.js
// linha ~203: `options.dispatchNode || dispatchNode`).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createDashboard } = require('./server');

const SECRET = 'redmine-chave-secreta-de-teste-456';
const tmpBase = process.env.CLAUDE_JOB_DIR ? path.join(process.env.CLAUDE_JOB_DIR, 'tmp') : os.tmpdir();
const tmp = fs.mkdtempSync(path.join(tmpBase, 'resume-session-'));
const runs = path.join(tmp, 'memory', 'runs');

function writeRun(taskId, state, context = '# Contexto\n\nciclo anterior\n') {
    fs.mkdirSync(path.join(runs, taskId), { recursive: true });
    fs.writeFileSync(path.join(runs, taskId, 'state.json'), JSON.stringify({
        task_id: taskId, node: 'implement', history: ['plan', 'implement'], status: 'session_limit',
        session_interrupted: true, interrupted_node: 'implement', interrupted_at: '2026-09-26T18:00:00Z',
        ...state,
    }, null, 2));
    if (context !== null) fs.writeFileSync(path.join(runs, taskId, 'context.md'), context);
}
const readRun = taskId => JSON.parse(fs.readFileSync(path.join(runs, taskId, 'state.json'), 'utf8'));
const readCtx = taskId => fs.readFileSync(path.join(runs, taskId, 'context.md'), 'utf8');

// Fila de respostas do dispatchNode fake — cada chamada consome a próxima (ou usa
// o default {action:'dispatched'} se a fila estiver vazia).
const dispatchCalls = [];
const dispatchQueue = [];
async function fakeDispatchNode(opts) {
    dispatchCalls.push(opts);
    const next = dispatchQueue.shift();
    if (next?.throw) throw next.throw;
    return next || { action: 'dispatched', node: opts.fallbackState?.node, segments: 1 };
}

const logs = [];
const orig = { log: console.log, warn: console.warn, error: console.error };
let dash, base;
test.before(async () => {
    for (const k of ['log', 'warn', 'error']) console[k] = (...a) => { logs.push(a.join(' ')); };
    process.env.REDMINE_API_KEY = SECRET;
    dash = createDashboard({
        memoryDir: runs, worktreesDir: path.join(tmp, 'wt'), prefsFile: path.join(tmp, 'prefs.json'),
        dispatchNode: fakeDispatchNode,
    });
    await new Promise(r => dash.server.listen(0, '127.0.0.1', r));
    base = `http://localhost:${dash.server.address().port}`;
    await dash.ready;
});
test.after(async () => {
    Object.assign(console, orig);
    await dash.close();
    delete process.env.REDMINE_API_KEY;
    fs.rmSync(tmp, { recursive: true, force: true });
});

const post = async p => {
    const res = await fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    const text = await res.text();
    return { status: res.status, text, body: JSON.parse(text) };
};

test('run não interrompido: 409, nada é redespachado', async () => {
    writeRun('60001-ok', { status: 'in_progress', session_interrupted: false, redmine_ticket: { id: 60001 } });
    const before = dispatchCalls.length;
    const r = await post('/api/runs/60001-ok/resume-session');
    assert.strictEqual(r.status, 409);
    assert.match(r.body.error, /não está interrompido/);
    assert.strictEqual(dispatchCalls.length, before);
});

test('session_interrupted ausente (state antigo, sem o campo): 409', async () => {
    writeRun('60002-sem-campo', {});
    const stateless = readRun('60002-sem-campo');
    delete stateless.session_interrupted;
    fs.writeFileSync(path.join(runs, '60002-sem-campo', 'state.json'), JSON.stringify(stateless, null, 2));
    const r = await post('/api/runs/60002-sem-campo/resume-session');
    assert.strictEqual(r.status, 409);
});

test('retomada bem-sucedida: state.json vira session_interrupted:false, resume_count incrementa, dispatchNode chamado com o ticketId certo, context.md ganha a nota de recuperação', async () => {
    writeRun('60003-retoma', { redmine_ticket: { id: 60003 }, resume_count: 1 });
    const r = await post('/api/runs/60003-retoma/resume-session');
    assert.strictEqual(r.status, 200, r.text);
    assert.deepStrictEqual({ ok: r.body.ok, node: r.body.node, resumeCount: r.body.resumeCount }, { ok: true, node: 'implement', resumeCount: 2 });

    const st = readRun('60003-retoma');
    assert.strictEqual(st.session_interrupted, false);
    assert.strictEqual(st.status, 'in_progress');
    assert.strictEqual(st.resume_count, 2);
    assert.ok(st.resumed_at);

    const call = dispatchCalls.at(-1);
    assert.strictEqual(call.ticketId, 60003);
    assert.strictEqual(call.follow, false);

    const ctx = readCtx('60003-retoma');
    assert.ok(ctx.startsWith('# Contexto\n\nciclo anterior\n'), 'contexto anterior preservado');
    assert.match(ctx, /Retomada de sessão interrompida/);
    assert.match(ctx, /Nó anterior: implement/);
    assert.match(ctx, /retomada nº 2\/3/);
});

test('4ª retomada (resume_count já em 3): 429, nada é escrito nem redespachado', async () => {
    writeRun('60004-limite', { redmine_ticket: { id: 60004 }, resume_count: 3 });
    const before = dispatchCalls.length;
    const r = await post('/api/runs/60004-limite/resume-session');
    assert.strictEqual(r.status, 429);
    assert.match(r.body.error, /limite de 3 retomadas atingido/);
    assert.strictEqual(dispatchCalls.length, before, 'não chamou dispatchNode');
    const st = readRun('60004-limite');
    assert.strictEqual(st.session_interrupted, true, 'state.json não foi tocado');
    assert.strictEqual(st.resume_count, 3);
});

test('task ad-hoc sem ticket Redmine: 409 com mensagem específica', async () => {
    writeRun('2026-09-20-tarefa-adhoc', { redmine_ticket: undefined });
    const r = await post('/api/runs/2026-09-20-tarefa-adhoc/resume-session');
    assert.strictEqual(r.status, 409);
    assert.match(r.body.error, /sem ticket do Redmine/);
});

test('context.md ausente: retoma só com state.json e loga aviso (não quebra)', async () => {
    writeRun('60005-sem-contexto', { redmine_ticket: { id: 60005 } }, null);
    assert.ok(!fs.existsSync(path.join(runs, '60005-sem-contexto', 'context.md')));
    const r = await post('/api/runs/60005-sem-contexto/resume-session');
    assert.strictEqual(r.status, 200, r.text);
    assert.ok(!fs.existsSync(path.join(runs, '60005-sem-contexto', 'context.md')), 'não cria o arquivo à toa');
    assert.ok(logs.some(l => l.includes('context.md ausente')));
});

test('dispatchNode não conseguiu redespachar (gate/skip): 502, mas o state já ficou retomado', async () => {
    dispatchQueue.push({ action: 'skip', reason: 'pre-build-failed' });
    writeRun('60006-gate', { redmine_ticket: { id: 60006 } });
    const r = await post('/api/runs/60006-gate/resume-session');
    assert.strictEqual(r.status, 502);
    assert.match(r.body.error, /pre-build-failed/);
});

test('REDMINE_API_KEY nunca aparece em resposta, state, context ou log mesmo quando o dispatchNode falha', async () => {
    dispatchQueue.push({ throw: new Error(`Redmine: ${SECRET} inválida`) });
    writeRun('60007-segredo', { redmine_ticket: { id: 60007 } });
    const r = await post('/api/runs/60007-segredo/resume-session');
    assert.strictEqual(r.status, 502);
    const everything = [r.text, JSON.stringify(await (await fetch(`${base}/api/runs`)).json()),
        ...['60003-retoma', '60006-gate', '60007-segredo'].flatMap(t => [readCtx(t), JSON.stringify(readRun(t))]),
        ...logs].join('\n');
    assert.ok(!everything.includes(SECRET));
});
