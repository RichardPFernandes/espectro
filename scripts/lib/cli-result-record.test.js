// node --test scripts/lib/cli-result-record.test.js
// PRI-381 (F1.5, AC-04/AC-05): gravação do custo da CLI no run. startCostRun guarda
// cli_result_json, log_offset e prompt_hashes só com WATCHER_CLI_RESULT_JSON=on;
// finishCostRun lê o JSON (saída do --follow ou log a partir do offset) e a versão do
// transcript; o cost_tracking ganha cost.cli_usd, cli_version, prompt_hashes,
// cli_cost_usd e runs_without_cli_cost. REPO_PATH e HOME descartáveis; nenhum agente roda.
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-result-record-'));
const repo = path.join(root, 'app-back');
const home = path.join(root, 'home');
fs.mkdirSync(repo, { recursive: true });
fs.mkdirSync(path.join(home, '.claude', 'projects'), { recursive: true });
process.env.REPO_PATH = repo;
process.env.HOME = home;
process.env.DASHBOARD_PREFS_FILE = path.join(root, 'prefs.json');
delete process.env.WATCHER_CLAUDE_CONFIG_DIR;
delete process.env.WATCHER_CLI_RESULT_JSON;
global.fetch = async () => { throw new Error('fetch não deveria ser chamado neste teste'); };

const watcher = require('../readmine-watcher');
const ct = require('./cost-tracking');

test.after(() => fs.rmSync(root, { recursive: true, force: true }));

const PRISMA_ROOT = path.resolve(__dirname, '..', '..');
const sha = file => crypto.createHash('sha256').update(fs.readFileSync(path.join(PRISMA_ROOT, '.claude', 'commands', file))).digest('hex');
const write = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
const logPath = id => path.join(repo, 'memory', 'runs', `${id}.log`);
const stateOf = dir => JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'));

function setup(id) {
    const dir = path.join(repo, '.claude', 'worktrees', String(id), 'memory', 'runs', `${id}-x`);
    write(path.join(dir, 'state.json'), JSON.stringify({ task_id: `${id}-x`, node: 'plan', history: [], status: 'in_progress',
        started_at: '2026-11-18T10:00:00.000Z', updated_at: '2026-11-18T10:00:00.000Z' }));
    return dir;
}

function transcript(sid, version = '2.5.1') {
    const lines = [
        { type: 'user', version, timestamp: '2026-11-18T10:00:00.000Z', message: { role: 'user', content: 'oi' } },
        { type: 'assistant', version, timestamp: '2026-11-18T10:00:01.000Z',
            message: { id: `m-${sid}`, model: 'claude-sonnet-5', usage: { input_tokens: 100, cache_read_input_tokens: 900, output_tokens: 100 } } },
    ];
    write(path.join(home, '.claude', 'projects', 'p', `${sid}.jsonl`), lines.map(l => JSON.stringify(l)).join('\n') + '\n');
}

const resultLine = (sid, cost) => JSON.stringify({ type: 'result', subtype: 'success', is_error: false, session_id: sid,
    total_cost_usd: cost, num_turns: 3, usage: { input_tokens: 100, output_tokens: 100 }, modelUsage: {}, result: 'ok' });
// Linha como o spawnAgent grava no log do ticket: `<ISO> [claude] <texto>`.
const logLine = text => `2026-11-18T10:00:02.000Z [claude] ${text}\n`;

function validateSchema(state) {
    const Ajv = require('ajv');
    const ajv = new Ajv({ allErrors: true, strict: false });
    try { require('ajv-formats')(ajv); } catch { /* opcional */ }
    const validate = ajv.compile(JSON.parse(fs.readFileSync(path.join(PRISMA_ROOT, '.graph', 'schemas', 'state.schema.json'))));
    assert.equal(validate(state), true, JSON.stringify(validate.errors));
    assert.strictEqual(require('../validate-state').validateState(state).valid, true);
}

function withFlag(value, fn) {
    const before = process.env.WATCHER_CLI_RESULT_JSON;
    if (value === undefined) delete process.env.WATCHER_CLI_RESULT_JSON;
    else process.env.WATCHER_CLI_RESULT_JSON = value;
    try { return fn(); } finally {
        if (before === undefined) delete process.env.WATCHER_CLI_RESULT_JSON;
        else process.env.WATCHER_CLI_RESULT_JSON = before;
    }
}

const CLI_KEYS = /"(cli_result_json|log_offset|prompt_hashes|cli_usd|cli_version|cli_cost_usd|runs_without_cli_cost)"/;

test('flag desligada: run pendente e cost_tracking sem nenhum campo da CLI', () => {
    const id = 93801;
    const dir = setup(id);
    write(logPath(id), logLine(resultLine('off-1', 0.5)));
    const run = withFlag(undefined, () => watcher.startCostRun(id, { agent: 'claude', nodes: ['fetch_ticket', 'plan'], sessionId: 'off-1' }));
    assert.doesNotMatch(JSON.stringify(run), CLI_KEYS);
    assert.doesNotMatch(JSON.stringify(watcher.readCostLedger(id).pending), CLI_KEYS);
    transcript('off-1');
    fs.appendFileSync(logPath(id), logLine(resultLine('off-1', 0.5)));
    watcher.finishCostRun(id, 'off-1', run.started_at_ms + 10, { exitCode: 0, cliOutput: resultLine('off-1', 0.5) });
    const state = stateOf(dir);
    assert.doesNotMatch(JSON.stringify(state.cost_tracking), CLI_KEYS);
    validateSchema(state);
});

// Golden capturado do mergeRun antes da F1.5 (commit 8c9609e): run sem cli_result_json
// e métricas sem campos da CLI produzem exatamente os mesmos bytes.
const GOLDEN = '{"nodes":{"implement":{"agent":"claude","input_tokens":2000,"output_tokens":200,"duration_ms":2000,"runs":2,"retries":1,"runs_without_tokens":0,"cache_read_input_tokens":1800,"cache_creation_input_tokens":0,"cost_usd":0.00138,"models":["claude-sonnet-5"],"attempts":[{"admission":{"attempt_id":"UNKNOWN","admitted_node":"UNKNOWN","attempt_ref":"UNKNOWN","reason":"NO_REAL_ATTEMPT"},"attributed_node":"implement","also_covers":[],"cause":"UNKNOWN","parent_attempt_id":"UNKNOWN","session_id":"s1","runtime":"claude","provider":"anthropic","account":{"source":"default","label":"default"},"requested":{"model":"UNAVAILABLE","effort":"UNAVAILABLE"},"effort_router_plugin":"UNKNOWN","first_turn":{"cache_read_tokens":900,"cache_write_5m_tokens":null,"cache_write_1h_tokens":null},"selection_source":"DEFAULT_INHERITED","routing_decision":"UNAVAILABLE","subtask":"UNAVAILABLE","workspace":"UNAVAILABLE","signals":"UNAVAILABLE","would_route":"UNAVAILABLE","observed":{"usage":[{"model":"claude-sonnet-5","role":"main","speed":"standard","price_tier":"flat","pricing_sha256":"<SHA>","messages":1,"input_tokens":100,"output_tokens":100,"cache_read_tokens":900,"cache_write_5m_tokens":0,"cache_write_1h_tokens":0,"cache_write_ttl_unknown_tokens":0,"role_provenance":"SELF_REPORTED","role_conflicted_messages":0}],"effort":"UNKNOWN"},"usage_provenance":"SELF_REPORTED","read_order":[{"role":"main","file_ref":"main"}],"dedup_conflicts":[],"role_attribution":{"status":"COMPLETE","conflicted_messages":0},"cost":{"usd":0.00138,"unpriced_models":[],"pricing_source":"<SRC>","pricing_sha256":"<SHA>","estimated":false},"duration_ms":1000,"wait_ms":"UNAVAILABLE","exit":0,"result":"UNKNOWN"},{"admission":{"attempt_id":"UNKNOWN","admitted_node":"UNKNOWN","attempt_ref":"UNKNOWN","reason":"NO_REAL_ATTEMPT"},"attributed_node":"implement","also_covers":[],"cause":"UNKNOWN","parent_attempt_id":"UNKNOWN","session_id":"s2","runtime":"claude","provider":"anthropic","account":{"source":"default","label":"default"},"requested":{"model":"UNAVAILABLE","effort":"UNAVAILABLE"},"effort_router_plugin":"UNKNOWN","first_turn":{"cache_read_tokens":900,"cache_write_5m_tokens":null,"cache_write_1h_tokens":null},"selection_source":"DEFAULT_INHERITED","routing_decision":"UNAVAILABLE","subtask":"UNAVAILABLE","workspace":"UNAVAILABLE","signals":"UNAVAILABLE","would_route":"UNAVAILABLE","observed":{"usage":[{"model":"claude-sonnet-5","role":"main","speed":"standard","price_tier":"flat","pricing_sha256":"<SHA>","messages":1,"input_tokens":100,"output_tokens":100,"cache_read_tokens":900,"cache_write_5m_tokens":0,"cache_write_1h_tokens":0,"cache_write_ttl_unknown_tokens":0,"role_provenance":"SELF_REPORTED","role_conflicted_messages":0}],"effort":"UNKNOWN"},"usage_provenance":"SELF_REPORTED","read_order":[{"role":"main","file_ref":"main"}],"dedup_conflicts":[],"role_attribution":{"status":"COMPLETE","conflicted_messages":0},"cost":{"usd":null,"unpriced_models":[],"pricing_source":"<SRC>","pricing_sha256":"<SHA>","estimated":false},"duration_ms":1000,"wait_ms":"UNAVAILABLE","exit":1,"result":"UNKNOWN"}],"runs_without_cost":1}},"totals":{"input_tokens":2000,"output_tokens":200,"cost_usd":0.00138,"duration_ms":2000,"loop_count":1},"pricing_source":"<SRC>"}';

test('flag desligada: mergeRun produz byte a byte o cost_tracking de antes da F1.5', () => {
    const line = JSON.stringify({ type: 'assistant', timestamp: '2026-11-18T10:00:00.000Z',
        message: { id: 'm1', model: 'claude-sonnet-5', usage: { input_tokens: 100, cache_read_input_tokens: 900, output_tokens: 100 } } });
    const m = { ...ct.sumClaudeUsage([line]), duration_ms: 1000 };
    const run = { session_id: 's1', account: { source: 'default', label: 'default' }, effort_router_plugin: 'UNKNOWN' };
    let c = ct.mergeRun(null, { node: 'implement', agent: 'claude', metrics: m, run, outcome: { exitCode: 0 } });
    c = ct.mergeRun(c, { node: 'implement', agent: 'claude', metrics: { ...m, cost_usd: null }, run: { ...run, session_id: 's2' }, outcome: { exitCode: 1 } });
    const bytes = JSON.stringify(c).split(ct.PRICING_SOURCE).join('<SRC>').split(ct.PRICING_SHA256).join('<SHA>');
    assert.strictEqual(bytes, GOLDEN);
});

test('flag ligada, sem --follow: JSON do log a partir do offset, versão do transcript e hashes dos templates', () => {
    const id = 93802;
    const dir = setup(id);
    write(logPath(id), logLine('texto de despacho anterior'));
    const offset = fs.statSync(logPath(id)).size;
    const run = withFlag('on', () => watcher.startCostRun(id, { agent: 'claude', nodes: ['fetch_ticket', 'plan'], sessionId: 'on-1' }));
    assert.strictEqual(run.cli_result_json, true);
    assert.strictEqual(run.log_offset, offset);
    const hashes = { fetch_ticket: sha('fetch-ticket.md'), plan: sha('plan.md') };
    assert.deepStrictEqual(run.prompt_hashes, hashes);
    assert.deepStrictEqual(watcher.readCostLedger(id).pending[0].prompt_hashes, hashes);

    transcript('on-1', '2.5.1');
    fs.appendFileSync(logPath(id), logLine(resultLine('outra-sessao', 9.99)) + logLine(resultLine('on-1', 0.0123)));
    withFlag(undefined, () => watcher.finishCostRun(id, 'on-1', run.started_at_ms + 10, { exitCode: 0 }));

    const state = stateOf(dir);
    const node = state.cost_tracking.nodes.plan;
    const attempt = node.attempts[0];
    assert.strictEqual(attempt.cost.cli_usd, 0.0123);
    assert.strictEqual(attempt.cost.usd, 0.00138, 'cost.usd segue sendo o do transcript');
    assert.strictEqual(attempt.cli_version, '2.5.1');
    assert.deepStrictEqual(attempt.prompt_hashes, hashes);
    assert.strictEqual(node.cli_cost_usd, 0.0123);
    assert.strictEqual(node.runs_without_cli_cost, 0);
    assert.strictEqual(state.cost_tracking.totals.cli_cost_usd, 0.0123);
    assert.strictEqual(state.cost_tracking.totals.runs_without_cli_cost, 0);
    assert.strictEqual(state.cost_tracking.totals.cost_usd, 0.00138);
    validateSchema(state);
});

test('flag ligada, run decomposta: hash do template /implement-step que a run leu, não do implement.md', () => {
    const id = 93805;
    setup(id);
    const run = withFlag('on', () => watcher.startCostRun(id, { agent: 'claude', nodes: ['implement'],
        commands: [`/implement-step ${id}-x 0-1`], sessionId: 'on-step' }));
    assert.deepStrictEqual(run.prompt_hashes, { 'implement-step': sha('implement-step.md') });
    assert.deepStrictEqual(watcher.readCostLedger(id).pending[0].prompt_hashes, { 'implement-step': sha('implement-step.md') });
});

test('flag ligada, com --follow: JSON vem da saída do processo', () => {
    const id = 93803;
    const dir = setup(id);
    const run = withFlag('on', () => watcher.startCostRun(id, { agent: 'claude', nodes: ['plan'], sessionId: 'on-2' }));
    assert.strictEqual(run.log_offset, 0, 'log ainda inexistente: offset 0');
    transcript('on-2', '2.6.0');
    watcher.finishCostRun(id, 'on-2', run.started_at_ms + 10, { exitCode: 0, cliOutput: resultLine('on-2', 0.25) + '\n' });
    const attempt = stateOf(dir).cost_tracking.nodes.plan.attempts[0];
    assert.strictEqual(attempt.cost.cli_usd, 0.25);
    assert.strictEqual(attempt.cli_version, '2.6.0');
    validateSchema(stateOf(dir));
});

test('flag ligada, com --follow: saída do processo sem o objeto result cai para o log a partir do offset', () => {
    const id = 93806;
    const dir = setup(id);
    write(logPath(id), logLine('texto de despacho anterior'));
    const run = withFlag('on', () => watcher.startCostRun(id, { agent: 'claude', nodes: ['plan'], sessionId: 'on-5' }));
    transcript('on-5', '2.6.1');
    fs.appendFileSync(logPath(id), logLine(resultLine('on-5', 0.75)));
    watcher.finishCostRun(id, 'on-5', run.started_at_ms + 10, { exitCode: 0, cliOutput: 'saída sem o JSON da CLI\n' });
    const attempt = stateOf(dir).cost_tracking.nodes.plan.attempts[0];
    assert.strictEqual(attempt.cost.cli_usd, 0.75);
    assert.strictEqual(attempt.cli_version, '2.6.1');
    validateSchema(stateOf(dir));
});

test('flag ligada, JSON ausente: cli_usd null (nunca zero) e runs_without_cli_cost sobe', () => {
    const id = 93804;
    const dir = setup(id);
    // Linha da mesma sessão antes do offset não conta: é de antes do despacho.
    write(logPath(id), logLine(resultLine('on-3', 7)));
    const r1 = withFlag('on', () => watcher.startCostRun(id, { agent: 'claude', nodes: ['plan'], sessionId: 'on-3' }));
    transcript('on-3');
    fs.appendFileSync(logPath(id), logLine('{"type":"result", ilegível'));
    watcher.finishCostRun(id, 'on-3', r1.started_at_ms + 10, { exitCode: 1 });
    let state = stateOf(dir);
    assert.strictEqual(state.cost_tracking.nodes.plan.attempts[0].cost.cli_usd, null);
    assert.strictEqual(state.cost_tracking.nodes.plan.cli_cost_usd, null);
    assert.strictEqual(state.cost_tracking.nodes.plan.runs_without_cli_cost, 1);
    assert.strictEqual(state.cost_tracking.totals.cli_cost_usd, null);
    assert.strictEqual(state.cost_tracking.totals.runs_without_cli_cost, 1);
    validateSchema(state);

    // Segundo run do mesmo nó com o JSON: soma o que tem e mantém a contagem do que faltou.
    const r2 = withFlag('on', () => watcher.startCostRun(id, { agent: 'claude', nodes: ['plan'], sessionId: 'on-4' }));
    transcript('on-4');
    fs.appendFileSync(logPath(id), logLine(resultLine('on-4', 0.5)));
    watcher.finishCostRun(id, 'on-4', r2.started_at_ms + 10, { exitCode: 0 });
    state = stateOf(dir);
    assert.strictEqual(state.cost_tracking.nodes.plan.cli_cost_usd, 0.5);
    assert.strictEqual(state.cost_tracking.nodes.plan.runs_without_cli_cost, 1);
    assert.strictEqual(state.cost_tracking.totals.cli_cost_usd, 0.5);
    assert.strictEqual(state.cost_tracking.totals.runs_without_cli_cost, 1);
    validateSchema(state);
});

test('nó com runs de antes da flag: esses runs contam como sem custo da CLI', () => {
    const m = { input_tokens: 10, output_tokens: 1, cost_usd: 0.001, duration_ms: 5 };
    let c = ct.mergeRun(null, { node: 'review', agent: 'claude', metrics: m, run: { session_id: 'a' } });
    c = ct.mergeRun(c, { node: 'implement', agent: 'claude', metrics: m, run: { session_id: 'b' } });
    c = ct.mergeRun(c, { node: 'review', agent: 'claude', metrics: { ...m, cli_cost_usd: 0.002, cli_version: '2.5.1' },
        run: { session_id: 'c', cli_result_json: true, prompt_hashes: { review: 'UNKNOWN' } } });
    assert.strictEqual(c.nodes.review.cli_cost_usd, 0.002);
    assert.strictEqual(c.nodes.review.runs_without_cli_cost, 1, 'o run de antes da flag não tem custo da CLI');
    assert.strictEqual(c.nodes.implement.cli_cost_usd, undefined, 'nó só com runs de antes da flag fica como antes');
    assert.strictEqual(c.totals.cli_cost_usd, 0.002);
    assert.strictEqual(c.totals.runs_without_cli_cost, 2, 'o run do implement também falta');
    const attempt = c.nodes.review.attempts[1];
    assert.deepStrictEqual([attempt.cost.cli_usd, attempt.cli_version, attempt.prompt_hashes], [0.002, '2.5.1', { review: 'UNKNOWN' }]);
    assert.strictEqual('cli_usd' in c.nodes.review.attempts[0].cost, false);
});
