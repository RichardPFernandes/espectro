// node --test scripts/validate-state.test.js
// Validação de state.json (scripts/validate-state.js) e o caminho state_corrupted do
// watcher, contra um REPO_PATH sintético, fetch stubado e um binário `claude` falso.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(process.env.CLAUDE_JOB_DIR ? path.join(process.env.CLAUDE_JOB_DIR, 'tmp') : os.tmpdir(), 'validate-state-'));
const repo = path.join(tmp, 'app-back');
const binDir = path.join(tmp, 'bin');
const claudeCalls = path.join(tmp, 'claude-calls.log');
fs.mkdirSync(repo, { recursive: true });
fs.mkdirSync(binDir);
fs.writeFileSync(path.join(binDir, 'claude'), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${claudeCalls}'\n`, { mode: 0o755 });
fs.writeFileSync(path.join(binDir, 'osascript'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
process.env.REPO_PATH = repo;
// Portão de build pré-implement roda mvn de verdade — coberto em build-validator.test.js.
process.env.SKIP_PRE_BUILD_VALIDATION = 'true';
process.env.REDMINE_URL = 'http://redmine.test';
process.env.REDMINE_API_KEY = 'k';
process.env.PATH = `${binDir}:${process.env.PATH}`;
const redmineCalls = [];
global.fetch = async (url, opts) => { redmineCalls.push({ url, body: opts?.body }); return { ok: true, status: 204, json: async () => ({}) }; };

const { validateState, readAndValidateState } = require('./validate-state');
const watcher = require('./readmine-watcher');

function validState(taskId, over = {}) {
    return { task_id: taskId, node: 'review', history: ['fetch_ticket', 'plan', 'implement'], status: 'in_progress', started_at: new Date().toISOString(), ...over };
}

function seedRaw(id, content) {
    const taskId = `${id}-teste`;
    const dir = path.join(repo, '.claude', 'worktrees', String(id), 'memory', 'runs', taskId);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'state.json'), content);
    fs.writeFileSync(path.join(dir, 'context.md'), '# Contexto\n');
    return { taskId, dir };
}

function ticket(id) {
    return {
        id, subject: `Ticket ${id}`, description: '', status: { name: 'Em Desenvolvimento' }, tracker: { name: 'Melhoria' },
        custom_fields: [{ name: 'Branch Liberação', value: 'Dev - Local' }], updated_on: new Date().toISOString(),
    };
}

function claudeCalledFor(taskId) {
    return fs.existsSync(claudeCalls) && fs.readFileSync(claudeCalls, 'utf8').includes(taskId);
}

async function waitForClaudeCall(taskId) {
    for (let i = 0; i < 50; i++) {
        if (claudeCalledFor(taskId)) return true;
        await new Promise(r => setTimeout(r, 50));
    }
    return false;
}

const readState = dir => JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'));

test('validateState: status numérico é inválido; state mínimo válido passa', () => {
    assert.deepStrictEqual(validateState(validState('1-x')), { valid: true });
    const bad = validateState(validState('1-x', { status: 123 }));
    assert.strictEqual(bad.valid, false);
    assert.ok(bad.errors.some(e => e.startsWith('/status')), bad.errors.join('; '));
    assert.strictEqual(validateState(validState('1-x', { status: 'qualquer' })).valid, false, 'fora do enum');
    const noTask = validState('1-x');
    delete noTask.task_id;
    assert.strictEqual(validateState(noTask).valid, false);
    assert.strictEqual(validateState([]).valid, false);
});

test('readAndValidateState: resolve pelo task-id no worktree; ausente e truncado viram not_found', () => {
    const { taskId } = seedRaw(92000, JSON.stringify(validState('92000-teste')));
    const ok = readAndValidateState(taskId);
    assert.strictEqual(ok.valid, true);
    assert.strictEqual(ok.state.task_id, taskId);

    assert.deepStrictEqual(
        (({ valid, state, errors, reason }) => ({ valid, state, errors, reason }))(readAndValidateState('92999-nao-existe')),
        { valid: false, state: null, errors: ['not_found'], reason: 'missing' });

    const trunc = seedRaw(92001, '{"task_id": "92001-teste", "node": "rev');
    const r = readAndValidateState(trunc.taskId);
    assert.strictEqual(r.valid, false);
    assert.strictEqual(r.state, null);
    assert.strictEqual(r.errors[0], 'not_found');
    assert.strictEqual(r.reason, 'parse_error');
});

test('dispatchTicket: status numérico => state_corrupted, sem redespachar, conteúdo preservado', async () => {
    const { dir, taskId } = seedRaw(92010, JSON.stringify(validState('92010-teste', { status: 123, scope: 'escopo original' })));
    const result = await watcher.dispatchTicket(ticket(92010));
    assert.strictEqual(result.action, 'skip');
    assert.strictEqual(result.reason, 'state_corrupted');
    const state = readState(dir);
    assert.strictEqual(state.status, 'state_corrupted');
    assert.strictEqual(state.state_error.previous_status, 123);
    assert.strictEqual(state.state_error.reason, 'schema');
    assert.strictEqual(state.scope, 'escopo original', 'resto do state preservado');
    assert.strictEqual(state.node, 'review', 'node intocado');
    const ev = state.events.at(-1);
    assert.strictEqual(ev.type, 'node_error');
    assert.match(ev.detail, /^state\.json inválido: /);
    assert.ok(!claudeCalledFor(taskId), 'nenhum agente despachado');
    assert.ok(redmineCalls.some(c => c.url.includes('/issues/92010.json') && /state_corrupted/.test(c.body)), 'escalou (comentário no Redmine)');

    // Próximo tick: continua sem redespachar, não reescreve nem renotifica.
    const before = fs.readFileSync(path.join(dir, 'state.json'), 'utf8');
    const notified = redmineCalls.length;
    const again = await watcher.dispatchTicket(ticket(92010));
    assert.match(again.reason, /state_corrupted/);
    assert.strictEqual(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'), before);
    assert.strictEqual(redmineCalls.length, notified);
    assert.ok(!claudeCalledFor(taskId));
});

test('dispatchTicket: JSON truncado => state_corrupted com backup, sem redespachar fetch_ticket', async () => {
    const original = '{"task_id": "92020-teste", "node": "implement", "hist';
    const { dir, taskId } = seedRaw(92020, original);
    const result = await watcher.dispatchTicket(ticket(92020));
    assert.strictEqual(result.reason, 'state_corrupted');
    assert.notStrictEqual(result.node, 'fetch_ticket');
    const state = readState(dir);
    assert.strictEqual(state.status, 'state_corrupted');
    assert.strictEqual(state.state_error.reason, 'parse_error');
    assert.strictEqual(state.events.at(-1).type, 'node_error');
    const backups = fs.readdirSync(dir).filter(f => f.startsWith('state.json.corrupted-'));
    assert.strictEqual(backups.length, 1);
    assert.strictEqual(fs.readFileSync(path.join(dir, backups[0]), 'utf8'), original);
    assert.ok(!claudeCalledFor(taskId) && !claudeCalledFor('/fetch-ticket 92020'));

    await watcher.dispatchTicket(ticket(92020));
    assert.strictEqual(fs.readdirSync(dir).filter(f => f.startsWith('state.json.corrupted-')).length, 1, 'idempotente');
});

test('dispatchTicket: state válido segue despachando exatamente como antes', async () => {
    const initial = validState('92030-teste');
    const { dir, taskId } = seedRaw(92030, JSON.stringify(initial));
    const result = await watcher.dispatchTicket(ticket(92030));
    assert.strictEqual(result.action, 'dispatched');
    assert.strictEqual(result.node, 'review');
    assert.ok(await waitForClaudeCall(`/review ${taskId}`));
    const after = readState(dir);
    assert.strictEqual(after.state_error, undefined);
    assert.notStrictEqual(after.status, 'state_corrupted');
});

test('corrupção de uma task não afeta outra', async () => {
    seedRaw(92040, 'não é json');
    const { taskId } = seedRaw(92041, JSON.stringify(validState('92041-teste')));
    assert.strictEqual((await watcher.dispatchTicket(ticket(92040))).reason, 'state_corrupted');
    assert.strictEqual((await watcher.dispatchTicket(ticket(92041))).action, 'dispatched');
    assert.ok(await waitForClaudeCall(`/review ${taskId}`));
});

test('findLocallyActiveTicketIds inclui task corrompida (pra ser reidratada e escalada)', () => {
    seedRaw(92050, JSON.stringify(validState('92050-teste', { status: 42 })));
    assert.ok(watcher.findLocallyActiveTicketIds().includes(92050));
});
