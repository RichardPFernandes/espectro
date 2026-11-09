'use strict';
// PRI-181 c2b-1-model (SPEC-c2b-1-model r3.1): AC-08 (flag ausente: watcher não chama os módulos
// novos nem C2/C3) e AC-09 no modo desligado. Os oráculos C0 (c0b) rodam sem edição em seus arquivos.
// QA_DIAGNOSTICO é constante de carga (readmine-watcher.js), então cada modo roda em seu próprio
// arquivo/processo. Fixtures sintéticas do C0 (PR #50); nada de consumidor.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const fixture = require('../fixtures/qa-rejection/current.json');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pri181-c2b1-flag-off-'));
const repo = path.join(tmp, 'consumer');
fs.mkdirSync(path.join(repo, '.claude'), { recursive: true });
fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
fs.copyFileSync(path.resolve(__dirname, '../../.claude/spec-hash-config.json'), path.join(repo, '.claude/spec-hash-config.json'));
const envKeys = ['REPO_PATH', 'REDMINE_URL', 'REDMINE_API_KEY', 'REDMINE_MIN_INTERVAL_MS',
    'REDMINE_RETRY_BASE_DELAY_MS', 'REDMINE_RETRY_MAX_ATTEMPTS', 'WATCHER_RECUSA_QA_NOVO_CICLO', 'WATCHER_QA_DIAGNOSTICO'];
const savedEnv = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
Object.assign(process.env, {
    REPO_PATH: repo, REDMINE_URL: 'https://redmine.synthetic.invalid', REDMINE_API_KEY: 'synthetic-key-c2b1',
    REDMINE_MIN_INTERVAL_MS: '0', REDMINE_RETRY_BASE_DELAY_MS: '0', REDMINE_RETRY_MAX_ATTEMPTS: '1',
});
delete process.env.WATCHER_RECUSA_QA_NOVO_CICLO;
delete process.env.WATCHER_QA_DIAGNOSTICO; // padrão: desligado

const originalFetch = global.fetch;
let response = 'own';
function ticket(id, status = 'Recusa QA', updated = fixture.poll_updated_on) {
    return { id, subject: 'Formas geométricas sintéticas', description: '', status: { id: status === 'Recusa QA' ? 13 : 2, name: status },
        tracker: { name: 'Melhoria' }, updated_on: updated, custom_fields: [{ name: 'Branch Liberação', value: 'Dev - Local' }] };
}
global.fetch = async url => {
    const match = String(url).match(/^https:\/\/redmine\.synthetic\.invalid\/issues\/(\d+)\.json(\?include=journals)?$/);
    assert.ok(match, `endpoint inesperado: ${url}`);
    if (!match[2]) return { ok: true, status: 200, json: async () => ({ issue: ticket(Number(match[1])) }) };
    return { ok: true, status: 200, json: async () => ({ issue: { journals: fixture.journals[response] } }) };
};

// Spies: módulos C2/C3 (publish/analyze) e c2b-1 (store/model) não podem ser chamados pelo watcher.
const spied = { publish: require('./qa-diagnosis-publish'), analyze: require('./qa-diagnosis-analyze'),
    store: require('./qa-diagnosis-store'), model: require('./qa-diagnosis-model') };
const touched = [];
for (const [mod, exp] of Object.entries(spied)) {
    for (const [name, fn] of Object.entries(exp)) {
        if (typeof fn !== 'function') continue;
        exp[name] = function spy(...args) { touched.push(`${mod}.${name}`); return fn.apply(this, args); };
    }
}
const watcher = require('../readmine-watcher');

const read = dir => JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'));
const raw = dir => fs.readFileSync(path.join(dir, 'state.json'), 'utf8');
let nextId = 990800;
function archived(extra = {}) {
    const id = ++nextId;
    const taskId = `${id}-synthetic`;
    const dir = path.join(repo, 'memory/runs/_archive', taskId);
    fs.mkdirSync(dir, { recursive: true });
    const state = { ...fixture.base_state, task_id: taskId, redmine_ticket: { id }, ...structuredClone(extra) };
    fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify(state));
    fs.writeFileSync(path.join(dir, 'context.md'), '# Contexto sintético\n');
    return { id, taskId, dir, state };
}
const CONTROL = s => ({ node: s.node, status: s.status, pending_authorization: s.pending_authorization, execution_id: s.execution_id });

test.after(() => {
    global.fetch = originalFetch;
    fs.rmSync(tmp, { recursive: true, force: true });
    for (const key of envKeys) {
        if (savedEnv[key] === undefined) delete process.env[key];
        else process.env[key] = savedEnv[key];
    }
});

test('modo: flag ausente = desligada neste processo', () => {
    assert.equal(watcher.QA_DIAGNOSTICO, false);
});

for (const name of ['own', 'none', 'bounce']) {
    test(`AC-08: Recusa QA (${name}) com a flag ausente não chama store/model nem publica`, async () => {
        const { id, dir, state } = archived();
        response = name; touched.length = 0;
        await watcher.syncQaRejection(ticket(id));
        const after = read(dir);
        assert.equal(after.ticket_status, 'Recusa QA');
        for (const marker of ['rejection_key', 'qa_diagnosis', '"diagnosis"', 'qa-rej:']) assert.ok(!raw(dir).includes(marker), marker);
        assert.deepEqual(touched, []);
        assert.equal(fs.existsSync(path.join(dir, 'qa-diagnosis')), false);
        assert.equal(fs.existsSync(path.join(repo, 'memory/qa-diagnosis')), false);
        assert.deepEqual(CONTROL(after), CONTROL(state), 'AC-09: node/status/pending_authorization intactos');
    });
}
