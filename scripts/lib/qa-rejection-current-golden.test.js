'use strict';
// Caracterização de fd9f08e, não implementação/aceitação dos contratos C1+.
// lib/*.test.js já está na seleção explícita de scripts/package.json.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const fixture = require('../fixtures/qa-rejection/current.json');
const golden = require('../fixtures/qa-rejection/golden.json');
const corpus = require('../fixtures/qa-rejection/adversarial.json');
const { materialize } = require('../fixtures/qa-rejection/sentinel-tree.cjs');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pri221-golden-'));
const repo = path.join(tmp, 'consumer');
fs.mkdirSync(path.join(repo, '.claude'), { recursive: true });
fs.copyFileSync(path.resolve(__dirname, '../../.claude/spec-hash-config.json'), path.join(repo, '.claude/spec-hash-config.json'));
const envKeys = ['REPO_PATH', 'REDMINE_URL', 'REDMINE_API_KEY', 'REDMINE_MIN_INTERVAL_MS',
    'REDMINE_RETRY_BASE_DELAY_MS', 'REDMINE_RETRY_MAX_ATTEMPTS', 'WATCHER_RECUSA_QA_NOVO_CICLO', 'REDMINE_STATUS_EM_DESENVOLVIMENTO_ID'];
const savedEnv = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
Object.assign(process.env, {
    REPO_PATH: repo, REDMINE_URL: 'https://redmine.synthetic.invalid', REDMINE_API_KEY: 'synthetic-key-pri221',
    REDMINE_MIN_INTERVAL_MS: '0', REDMINE_RETRY_BASE_DELAY_MS: '0', REDMINE_RETRY_MAX_ATTEMPTS: '1',
    REDMINE_STATUS_EM_DESENVOLVIMENTO_ID: '2',
});
delete process.env.WATCHER_RECUSA_QA_NOVO_CICLO;

// Todos os caminhos HTTP passam pelo stub, inclusive a releitura de ticket no retry.
// Endpoint/método inesperado falha em vez de delegar ao fetch original.
const originalFetch = global.fetch;
let response = 'own';
let calls = [];
function ticket(id, updated = fixture.poll_updated_on) {
    return { id, subject: 'Formas geométricas sintéticas', description: '',
        status: { id: 13, name: 'Recusa QA' }, tracker: { name: 'Melhoria' }, updated_on: updated,
        custom_fields: [{ name: 'Branch Liberação', value: 'Dev - Local' }] };
}
async function fakeFetch(url, init = {}) {
    assert.equal(init.method || 'GET', 'GET', 'C0 nunca envia efeito remoto');
    const match = String(url).match(/^https:\/\/redmine\.synthetic\.invalid\/issues\/(\d+)\.json(\?include=journals)?$/);
    assert.ok(match, `endpoint inesperado: ${url}`);
    calls.push(String(url));
    if (!match[2]) return { ok: true, status: 200, json: async () => ({ issue: ticket(Number(match[1])) }) };
    const failure = fixture.transport[response];
    if (failure?.error) throw Object.assign(new Error(failure.error), { name: failure.name });
    if (failure?.status) return { ok: false, status: failure.status };
    assert.ok(fixture.journals[response], `resposta desconhecida: ${response}`);
    return { ok: true, status: 200, json: async () => ({ issue: { journals: fixture.journals[response] } }) };
}
global.fetch = fakeFetch;
const qa = require('./redmine-journal-fetcher');
const cycles = require('./qa-cycles');
const watcher = require('../readmine-watcher');
const read = dir => JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'));
let nextId = 990100;
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
function stableRejections(entries) {
    return entries.map(({ detected_at, ...entry }) => {
        assert.ok(Number.isFinite(Date.parse(detected_at)), 'detected_at real deve ser ISO legível');
        return entry;
    });
}
/** Oráculo C0: só campos legados (PRI-221). Campos C1 (rejection_key/…) ficam na suíte C1. */
function legacyRejection(obj) {
    if (!obj || typeof obj !== 'object') return obj;
    const { note, rejected_at, journal_id, retry_requested_at } = obj;
    return retry_requested_at !== undefined
        ? { note, rejected_at, journal_id, retry_requested_at }
        : { note, rejected_at, journal_id };
}
function legacyRejections(entries) {
    return stableRejections(entries).map(e => {
        const { note, rejected_at, journal_id, retry_requested_at, n, history_len, cost_baseline_usd, tokens_baseline } = e;
        const out = { n, note, rejected_at, journal_id, retry_requested_at };
        if (history_len !== undefined) out.history_len = history_len;
        if (cost_baseline_usd !== undefined) out.cost_baseline_usd = cost_baseline_usd;
        if (tokens_baseline !== undefined) out.tokens_baseline = tokens_baseline;
        return out;
    });
}

for (const name of Object.keys(golden.fetch)) {
    test(`C0 golden fetchLastRejectionNote: ${name}`, async () => {
        response = name;
        calls = [];
        const logs = [];
        assert.deepEqual(await qa.fetchLastRejectionNote(990001, {
            redmineUrl: process.env.REDMINE_URL, apiKey: process.env.REDMINE_API_KEY,
            fetch: fakeFetch, log: message => logs.push(message),
        }), golden.fetch[name]);
        assert.equal(calls.length, 1);
        assert.equal(logs.length, fixture.transport[name] ? 1 : 0);
        if (name === 'unauthorized') assert.match(logs[0], /HTTP 401/);
        if (name === 'timeout') assert.match(logs[0], /\(timeout\)/);
        assert.ok(logs.every(line => !line.includes(process.env.REDMINE_API_KEY)));
    });
}

test('C0 golden fetch: fonte recuperada volta a fornecer a nota', async () => {
    const opts = { redmineUrl: process.env.REDMINE_URL, apiKey: process.env.REDMINE_API_KEY, fetch: fakeFetch, log: () => {} };
    response = 'unavailable';
    assert.equal(await qa.fetchLastRejectionNote(990001, opts), null);
    response = 'own';
    assert.deepEqual(await qa.fetchLastRejectionNote(990001, opts), golden.fetch.own);
});

for (const name of Object.keys(golden.sync)) {
    test(`C0 golden syncQaRejection e qa-cycles: ${name}`, async () => {
        const { id, dir, state } = archived();
        response = name;
        calls = [];
        await watcher.syncQaRejection(ticket(id));
        const after = read(dir);
        assert.equal(calls.length, 1);
        assert.equal(after.ticket_status, 'Recusa QA');
        // Oráculo C0 nos campos legados de qa_rejection; C1 acrescenta rejection_key/….
        assert.deepEqual(legacyRejection(after.qa_rejection), golden.sync[name]);
        const pending = cycles.buildQaCycles(after, '').pending;
        assert.ok(pending, 'recusa pendente enquanto ticket_status é Recusa QA');
        assert.equal(pending.note, golden.sync[name].note);
        // pending pode espelhar a entrada do histórico (transition_journal_id C1);
        // o oráculo C0 de journal_id/rejected_at continua em qa_rejection.
        if (after.qa_rejection.transition_journal_id != null) {
            assert.ok(after.qa_rejections.some(e => e.transition_journal_id === after.qa_rejection.transition_journal_id));
            assert.ok(after.qa_rejections.every(e => e.rejection_key));
        } else {
            assert.deepEqual(legacyRejections(after.qa_rejections), [{ n: 1, ...golden.sync[name], retry_requested_at: null }]);
            assert.equal(after.qa_rejection.identity_quality, 'UNKNOWN');
        }
        for (const key of ['node', 'status', 'updated_at', 'execution_id', 'history', 'redmine_ticket']) assert.deepEqual(after[key], state[key]);
        for (const key of ['qa_retry_count', 'qa_ingest', 'pending_authorization']) assert.equal(after[key], undefined);

        // C1/DB-01b: mesma fixture de novo — sem transição nova, legado de qa_rejection estável.
        const beforeLegacy = legacyRejection(read(dir).qa_rejection);
        const beforeKeys = (read(dir).qa_rejections || []).map(e => e.rejection_key).filter(Boolean).sort();
        response = name;
        await watcher.syncQaRejection(ticket(id, '2026-01-02T13:00:00Z'));
        assert.equal(calls.length, 2);
        assert.deepEqual(legacyRejection(read(dir).qa_rejection), beforeLegacy);
        assert.deepEqual((read(dir).qa_rejections || []).map(e => e.rejection_key).filter(Boolean).sort(), beforeKeys);
    });
}

test('C0→C1: between_polls — lacuna C0 fechada; novas transições com status igual são ingeridas', async () => {
    // Caracterização histórica C0: sync não lia journals se status igual.
    // PRI-181 C1 (DB-01b) fecha a lacuna — oráculo novo; ver também qa-rejection-ingest.test.js.
    const { id, dir } = archived();
    response = 'own';
    await watcher.syncQaRejection(ticket(id));
    assert.deepEqual(legacyRejection(read(dir).qa_rejection), golden.sync.own);
    calls = [];
    response = 'between_polls';
    await watcher.syncQaRejection(ticket(id, '2026-01-02T14:00:00Z'));
    assert.equal(calls.length, 1);
    const after = read(dir);
    assert.equal(after.qa_rejections.length, 3, 'transições 102, 402 e 404');
    assert.equal(after.qa_rejection.transition_journal_id, 404);
    assert.equal(after.qa_rejection.rejection_key, `qa-rej:v1:t${id}:j404`);
});

for (const name of ['legacy_unique', 'legacy_ambiguous']) {
    test(`C0 golden ${name}: fetch/recordRejection legado; C1 promove identity_quality no sync`, async () => {
        const { id, dir, state } = archived(fixture.states.legacy);
        response = name;
        calls = [];
        await watcher.syncQaRejection(ticket(id));
        assert.equal(calls.length, 1, 'C1 relê journals mesmo com ticket_status já Recusa QA');
        const found = await qa.fetchLastRejectionNote(id, { fetch: fakeFetch });
        assert.deepEqual(found, golden.fetch[name]);
        assert.deepEqual(cycles.recordRejection(state, '', { ...found, at: fixture.poll_updated_on }), golden.legacy_record);
        const view = cycles.buildQaCycles(state, '');
        assert.deepEqual(view.cycles.map(c => [c.journal_id, c.reconstructed, c.cost_usd, c.tokens]), [[null, true, null, null]]);
        const after = read(dir);
        assert.ok(after.qa_rejection.rejection_key, 'C1 atribui rejection_key');
        assert.ok(['OK', 'DEGRADED', 'UNKNOWN'].includes(after.qa_rejection.identity_quality));
        assert.ok(after.qa_rejections.some(e => e.rejection_key), 'histórico ganha chave C1');
    });
}

test('C0 golden consumeQaRetrySignals: move run, preserva identidade, reabre implement e consome uma vez', async () => {
    const { id, taskId, dir } = archived(fixture.states.retry);
    const worktree = path.join(repo, '.claude/worktrees', String(id));
    fs.mkdirSync(worktree, { recursive: true }); // sem criar branch ou consultar remote
    fs.writeFileSync(path.join(dir, 'retry-signal.json'), '{"node":"implement"}');
    calls = [];
    assert.deepEqual(await watcher.consumeQaRetrySignals(), [id]);
    const target = path.join(worktree, 'memory/runs', taskId);
    const after = read(target);
    const note = watcher.qaRetryNote(taskId, 'implement');
    assert.deepEqual({
        node: after.node, status: after.status, qa_retry_count: after.qa_retry_count, execution_id: after.execution_id,
        signal_exists: fs.existsSync(path.join(target, 'retry-signal.json')), source_exists: fs.existsSync(dir),
        second_poll: await watcher.consumeQaRetrySignals(), note_once: /RETRY de Recusa QA/.test(note),
        note_twice: watcher.qaRetryNote(taskId, 'implement'),
    }, golden.retry);
    assert.equal(after.task_id, taskId);
    assert.equal(after.spec_hash, undefined, 'exceção legada sem spec preservada');
    for (const key of ['worktrees_removed_on_pr_open_at', 'churnReport', 'churnAccepted', 'churnEscalationNotifiedAt']) assert.equal(after[key], undefined);
    assert.equal(calls.length, 1, 'somente GET de ticket; nenhum efeito externo');
    assert.equal(fs.readFileSync(path.join(target, 'context.md'), 'utf8'), '# Contexto sintético\n');
});

test('C0 golden consumeQaRetrySignals: destino ocupado mantém fonte, destino e sinal', async () => {
    const { id, taskId, dir } = archived(fixture.states.retry);
    const target = path.join(repo, '.claude/worktrees', String(id), 'memory/runs', taskId);
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(target, 'sentinel.txt'), 'destino sintético intocado');
    fs.writeFileSync(path.join(dir, 'retry-signal.json'), '{"node":"implement"}');
    const before = JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'));
    assert.deepEqual(await watcher.consumeQaRetrySignals(), []);
    const after = JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'));
    // PRI-184: grava qa_retry_blocked (campo + evento) sem alterar node/status/histórico do run.
    assert.equal(after.node, before.node);
    assert.equal(after.status, before.status);
    assert.deepEqual(after.history, before.history);
    assert.equal(after.qa_retry_blocked.reason, 'destino_ocupado');
    assert.equal((after.events || []).filter(e => e.type === 'qa_retry_blocked').length, 1);
    assert.equal(fs.readFileSync(path.join(target, 'sentinel.txt'), 'utf8'), 'destino sintético intocado');
    assert.ok(fs.existsSync(path.join(dir, 'retry-signal.json')));
});

test('C0: árvore adversarial reproduz sentinelas únicas, symlink real e arquivo acima do limite de teste', () => {
    const tree = fs.mkdtempSync(path.join(tmp, 'sentinels-'));
    materialize(tree);
    assert.equal(new Set(corpus.sentinels.map(item => item.marker)).size, corpus.sentinels.length);
    for (const item of corpus.sentinels) assert.ok(fs.readFileSync(path.join(tree, item.path), 'utf8').includes(item.marker));
    const link = path.join(tree, corpus.symlink.path);
    assert.ok(fs.lstatSync(link).isSymbolicLink());
    assert.equal(fs.realpathSync(link), path.join(tree, 'outside/link-target.txt'));
    const large = path.join(tree, corpus.sentinels.find(item => item.kind === 'large').path);
    assert.equal(fs.statSync(large).size, corpus.large_file_bytes);
    assert.ok(fs.statSync(large).size > corpus.test_limit_bytes);
    assert.doesNotThrow(() => JSON.parse(fs.readFileSync(path.join(tree, 'consumer/memory/runs/990999-other/state.json'), 'utf8')));
});

test('C0 golden corpus: contextBlock cita texto literalmente; não é barreira de injeção', () => {
    assert.deepEqual(corpus.injections.map(item => item.id), ['approval', 'sql', 'target', 'dotenv', 'false_fact', 'extra_json', 'watcher', 'tool_call']);
    for (const item of corpus.injections) {
        const at = fixture.poll_updated_on;
        const block = qa.contextBlock(item.note, at);
        assert.ok(block.includes(`> ${item.note}\n`));
        assert.deepEqual(cycles.parseContextRejections(block), [{ at, note: item.note }]);
    }
});

test.after(() => {
    global.fetch = originalFetch;
    for (const key of envKeys) {
        if (savedEnv[key] === undefined) delete process.env[key];
        else process.env[key] = savedEnv[key];
    }
    fs.rmSync(tmp, { recursive: true, force: true }); // apenas mkdtemp criado por este arquivo
});
