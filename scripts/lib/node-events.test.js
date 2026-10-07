// node --test scripts/lib/node-events.test.js
// Log estruturado de eventos por nó (state.json.events): unidade de node-events.js e
// integração com o watcher (dispatchTicket, modo detached — release pelo wrapper sh)
// contra um REPO_PATH sintético e um `claude` falso que anda o grafo como os comandos
// reais fariam (incluindo um review reprovado uma vez).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(process.env.CLAUDE_JOB_DIR ? path.join(process.env.CLAUDE_JOB_DIR, 'tmp') : os.tmpdir(), 'node-events-'));
const repo = path.join(tmp, 'app-back');
const binDir = path.join(tmp, 'bin');
fs.mkdirSync(repo, { recursive: true });
fs.mkdirSync(binDir);
// `claude` falso: acha "/<nó> <task-id>" no prompt e grava no state.json o que o
// comando real gravaria. Task-id com "boom" sai 1; com "max" escala no review.
fs.writeFileSync(path.join(binDir, 'claude'), `#!${process.execPath}
const fs = require('fs'), path = require('path');
const m = process.argv.slice(2).join(' ').match(/\\/(implement|review|test|verify) ([\\w-]+)/);
if (!m) process.exit(0);
const [, node, taskId] = m;
if (taskId.includes('boom')) process.exit(1);
const file = path.join(process.cwd(), 'memory', 'runs', taskId, 'state.json');
const s = JSON.parse(fs.readFileSync(file, 'utf8'));
s.retries = s.retries || {};
s.history = [...(s.history || []), node];
if (node === 'implement') s.node = 'review';
if (node === 'review') {
    if (taskId.includes('max')) { s.retries.review = 3; s.status = 'escalated'; }
    else if (!s.retries.review) { s.retries.review = 1; s.node = 'implement'; }
    else s.node = 'test';
}
if (node === 'test') s.node = 'verify';
if (node === 'verify') { s.risk_level = 'low'; s.node = 'commit'; }
fs.writeFileSync(file, JSON.stringify(s, null, 2));
`, { mode: 0o755 });
fs.writeFileSync(path.join(binDir, 'osascript'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
process.env.REPO_PATH = repo;
process.env.PLAN_SCORE_THRESHOLD = '0';
process.env.SKIP_PRE_BUILD_VALIDATION = 'true';
process.env.REDMINE_URL = 'http://redmine.test';
process.env.REDMINE_API_KEY = 'k';
process.env.PATH = `${binDir}:${process.env.PATH}`;
delete process.env.NODE_TIMEOUT_MS;
global.fetch = async () => ({ ok: true, status: 204, json: async () => ({}) });

const events = require('./node-events');
const watcher = require('../readmine-watcher');
const { validateState } = require('../validate-state');

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const read = dir => JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'));

function seed(id, node, suffix = 'teste', extra = {}) {
    const taskId = `${id}-${suffix}`;
    const dir = path.join(repo, '.claude', 'worktrees', String(id), 'memory', 'runs', taskId);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({
        task_id: taskId, node, history: ['fetch_ticket', 'plan'], status: 'in_progress',
        started_at: new Date().toISOString(), ...extra,
    }));
    fs.writeFileSync(path.join(dir, 'context.md'), '# Contexto\n');
    return { taskId, dir };
}

function ticket(id) {
    return {
        id, subject: `Ticket ${id}`, description: '', status: { name: 'Em Desenvolvimento' }, tracker: { name: 'Melhoria' },
        custom_fields: [{ name: 'Branch Liberação', value: 'Dev - Local' }], updated_on: new Date().toISOString(),
    };
}

async function waitFor(fn) {
    for (let i = 0; i < 200; i++) {
        try {
            if (fn()) return true;
        } catch { /* state.json no meio de uma escrita do agente falso — tenta de novo */ }
        await new Promise(r => setTimeout(r, 50));
    }
    return false;
}

// Despacha e espera o agente sair (release do wrapper grava o evento de saída).
async function runNode(id, dir) {
    const before = (read(dir).events || []).length;
    const result = await watcher.dispatchTicket(ticket(id));
    assert.strictEqual(result.action, 'dispatched', JSON.stringify(result));
    assert.ok(await waitFor(() => {
        const s = read(dir);
        return s.status !== 'running' && (s.events || []).slice(before).some(e => e.type === 'node_end' || e.type === 'node_error');
    }), `nó ${result.node} não terminou`);
    return result.node;
}

// --- unidade -------------------------------------------------------------------

test('exitEvents: exit != 0 → node_error com exit_code', () => {
    const [e] = events.exitEvents({ nodes: ['implement'], state: {}, code: 1 });
    assert.strictEqual(e.type, 'node_error');
    assert.strictEqual(e.exit_code, 1);
    assert.match(e.detail, /exit code 1 .*handoff\.md/);
    assert.strictEqual(events.exitEvents({ nodes: ['test'], state: {}, code: null })[0].exit_code, null);
});

test('exitEvents: review reprovado → node_end + node_retry "retry 1/3 — voltando para implement"', () => {
    const evs = events.exitEvents({ nodes: ['review'], state: { node: 'implement', retries: { review: 1 } }, code: 0, retriesBefore: 0 });
    assert.deepStrictEqual(evs.map(e => e.type), ['node_end', 'node_retry']);
    assert.strictEqual(evs[1].detail, 'Review reprovado (retry 1/3) — voltando para implement');
});

test('exitEvents: max_retries → escalation; verify → risk_level no detail; blocked → checkpoint', () => {
    const esc = events.exitEvents({ nodes: ['review'], state: { node: 'review', status: 'escalated', retries: { review: 3 } }, code: 0, retriesBefore: 2 });
    assert.deepStrictEqual(esc.map(e => e.type), ['node_end', 'escalation']);
    assert.match(esc[1].detail, /^max_retries atingido em review \(3\/3\) — escalando para humano$/);
    const [end] = events.exitEvents({ nodes: ['verify'], state: { node: 'commit', risk_level: 'low' }, code: 0 });
    assert.strictEqual(end.detail, 'Nó verify concluído — risk_level: low, node: commit');
    const blk = events.exitEvents({ nodes: ['implement'], state: { node: 'implement', status: 'blocked' }, code: 0 });
    assert.strictEqual(blk.at(-1).type, 'checkpoint');
});

test('appendEvent: inicializa events=[] em state.json antigo, é append-only e grava ts ISO 8601', () => {
    const { dir } = seed(93001, 'implement');
    assert.ok(events.appendEvent(dir, { type: 'node_start', node: 'implement', agent: 'claude', detail: 'a' }));
    assert.ok(events.appendEvent(dir, { type: 'node_end', node: 'implement', agent: 'claude', detail: 'b', exit_code: 0 }));
    const s = read(dir);
    assert.deepStrictEqual(s.events.map(e => e.type), ['node_start', 'node_end']);
    assert.match(s.events[0].ts, ISO);
    assert.strictEqual(s.events[0].at, s.events[0].ts);
    assert.ok(!('exit_code' in s.events[0]), 'exit_code só em node_end/node_error');
    assert.strictEqual(s.events[1].exit_code, 0);
    assert.strictEqual(validateState(s).valid, true, JSON.stringify(validateState(s)));
});

test('appendEvent: erro (state.json ausente/inválido) é logado e não lança', () => {
    const errs = [];
    const orig = console.error;
    console.error = (...a) => errs.push(a.join(' '));
    try {
        assert.strictEqual(events.appendEvent(path.join(tmp, 'nao-existe'), { type: 'node_start' }), false);
        const dir = path.join(tmp, 'corrompido');
        fs.mkdirSync(dir);
        fs.writeFileSync(path.join(dir, 'state.json'), '{nope');
        assert.strictEqual(events.appendEvent(dir, { type: 'node_start' }), false);
        assert.strictEqual(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'), '{nope', 'não reescreve state.json que não conseguiu ler');
        assert.strictEqual(events.recordNodeExit({ dir: path.join(tmp, 'nao-existe'), node: 'review' }, 0), false);
    } finally {
        console.error = orig;
    }
    assert.ok(errs.some(e => e.includes('[events]')));
});

test('schema: evento só com `at` (legado) continua válido; sem ts nem at é rejeitado', () => {
    const base = { task_id: 't', node: 'review', history: [], status: 'in_progress' };
    assert.strictEqual(validateState({ ...base, events: [{ type: 'replay', at: new Date().toISOString() }] }).valid, true);
    assert.strictEqual(validateState({ ...base, events: [{ type: 'node_start' }] }).valid, false);
});

// --- integração ------------------------------------------------------------------

test('ciclo completo com review reprovado uma vez: node_start/node_end por nó + node_retry', async () => {
    const id = 93101;
    const { dir } = seed(id, 'implement');
    const ran = [];
    while (read(dir).node !== 'commit') {
        assert.ok(ran.length < 10, `ciclo não convergiu: ${ran.join(' → ')}`);
        ran.push(await runNode(id, dir));
    }
    assert.deepStrictEqual(ran, ['implement', 'review', 'implement', 'review', 'test', 'verify']);

    const evs = read(dir).events;
    for (const e of evs) assert.match(e.ts, ISO, JSON.stringify(e));
    const of = type => evs.filter(e => e.type === type).map(e => e.node);
    assert.deepStrictEqual(of('node_start'), ran);
    assert.deepStrictEqual(of('node_end'), ran);
    assert.deepStrictEqual(of('node_retry'), ['review']);
    const retry = evs.find(e => e.type === 'node_retry');
    assert.strictEqual(retry.detail, 'Review reprovado (retry 1/3) — voltando para implement');
    assert.ok(evs.filter(e => e.type === 'node_end').every(e => e.exit_code === 0 && e.agent === 'claude'));
    assert.ok(!evs.some(e => e.type === 'node_start' && 'exit_code' in e));
    assert.strictEqual(evs.at(-1).detail, 'Nó verify concluído — risk_level: low, node: commit');
    assert.strictEqual(validateState(read(dir)).valid, true);
});

test('dispatchTicket: exit code != 0 → node_error com exit_code; review no max_retries → escalation', async () => {
    const boom = seed(93201, 'implement', 'boom');
    await runNode(93201, boom.dir);
    const err = read(boom.dir).events.at(-1);
    assert.strictEqual(err.type, 'node_error');
    assert.strictEqual(err.exit_code, 1);
    assert.strictEqual(read(boom.dir).status, 'in_progress', 'fluxo do release inalterado');

    const max = seed(93202, 'review', 'max', { retries: { review: 2 } });
    await runNode(93202, max.dir);
    const s = read(max.dir);
    assert.deepStrictEqual(s.events.map(e => e.type), ['node_start', 'node_end', 'escalation']);
    assert.match(s.events.at(-1).detail, /max_retries atingido em review/);
    assert.strictEqual(s.status, 'escalated');
});

test('checkpoint de NEVER_AUTO_DISPATCH: gravado uma vez por pausa, não a cada tick', async () => {
    const id = 93301;
    const { dir } = seed(id, 'commit', 'teste', { risk_level: 'high' });
    watcher.NEVER_AUTO_DISPATCH.add('commit');
    try {
        for (let i = 0; i < 3; i++) assert.strictEqual((await watcher.dispatchTicket(ticket(id))).reason, 'aguardando_commit_humano');
    } finally {
        watcher.NEVER_AUTO_DISPATCH.delete('commit');
    }
    const evs = read(dir).events;
    assert.strictEqual(evs.length, 1);
    assert.strictEqual(evs[0].type, 'checkpoint');
    assert.strictEqual(evs[0].detail, 'Pausado para aprovação humana antes de commit — risk_level: high');
});
