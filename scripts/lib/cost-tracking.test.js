// node --test scripts/lib/cost-tracking.test.js
// Unidade de scripts/lib/cost-tracking.js + integração com o watcher: REPO_PATH e HOME
// sintéticos (nenhum transcript real do ~/.claude é lido) e um binário `claude` falso
// no PATH que escreve um transcript na sessão recebida via --session-id e avança o
// state.json, como um nó de verdade faria.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ct = require('./cost-tracking');

const tokens = (input, output) => ({
    input_tokens: input, output_tokens: output, cache_read_input_tokens: null, cache_creation_input_tokens: null,
});

test('mergeRun: retry soma no nó e conta em loop_count', () => {
    let c = ct.mergeRun(null, { node: 'plan', agent: 'claude', alsoCovers: ['fetch_ticket'], metrics: { ...tokens(100, 10), duration_ms: 1000 } });
    c = ct.mergeRun(c, { node: 'implement', agent: 'claude', metrics: { ...tokens(200, 20), duration_ms: 2000 } });
    c = ct.mergeRun(c, { node: 'implement', agent: 'claude', metrics: { ...tokens(300, 30), duration_ms: 3000 } });
    assert.deepStrictEqual(
        Object.fromEntries(Object.entries(c.nodes.implement).filter(([key]) => key !== 'attempts')),
        { agent: 'claude', input_tokens: 500, output_tokens: 50, cost_usd: null, duration_ms: 5000, runs: 2, retries: 1, runs_without_tokens: 0, runs_without_cost: 2 },
    );
    assert.deepStrictEqual(c.nodes.plan.also_covers, ['fetch_ticket']);
    assert.deepStrictEqual(c.totals, { input_tokens: 600, output_tokens: 60, cost_usd: null, duration_ms: 6000, loop_count: 1 });
});

test('mergeRun: token ausente é null (nunca 0); soma parcial é sinalizada', () => {
    let c = ct.mergeRun(null, { node: 'test', agent: 'codex', metrics: { ...tokens(null, null), duration_ms: 500 } });
    assert.strictEqual(c.nodes.test.input_tokens, null);
    assert.strictEqual(c.nodes.test.output_tokens, null);
    assert.strictEqual(c.nodes.test.duration_ms, 500);
    assert.strictEqual(c.totals.input_tokens, null);
    assert.ok(!('cache_read_input_tokens' in c.nodes.test));

    c = ct.mergeRun(c, { node: 'test', agent: 'codex', metrics: { ...tokens(40, 4), duration_ms: 500 } });
    assert.strictEqual(c.nodes.test.input_tokens, 40);
    assert.strictEqual(c.nodes.test.runs_without_tokens, 1);
});

test('sumClaudeUsage: dedupe por message.id, soma cache no input, último timestamp', () => {
    const usage = { input_tokens: 2, cache_creation_input_tokens: 100, cache_read_input_tokens: 1000, output_tokens: 50 };
    const main = [
        { type: 'user', timestamp: '2026-09-22T10:00:00.000Z' },
        { type: 'assistant', timestamp: '2026-09-22T10:00:01.000Z', message: { id: 'm1', usage } },
        { type: 'assistant', timestamp: '2026-09-22T10:00:02.000Z', message: { id: 'm1', usage } },
        'linha quebrada {',
    ].map(l => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n');
    const sub = JSON.stringify({ type: 'assistant', timestamp: '2026-09-22T10:00:05.000Z', message: { id: 's1', usage: { input_tokens: 10, output_tokens: 5 } } });
    const r = ct.sumClaudeUsage([main, sub]);
    assert.strictEqual(r.input_tokens, 1102 + 10);
    assert.strictEqual(r.output_tokens, 55);
    assert.strictEqual(r.cache_read_input_tokens, 1000);
    assert.strictEqual(r.cache_creation_input_tokens, 100);
    assert.strictEqual(r.last_timestamp_ms, Date.parse('2026-09-22T10:00:05.000Z'));

    const empty = ct.sumClaudeUsage([JSON.stringify({ type: 'user', timestamp: '2026-09-22T10:00:00.000Z' })]);
    assert.strictEqual(empty.input_tokens, null);
    assert.strictEqual(empty.output_tokens, null);
});

test('custo US$: preço por modelo da mensagem, cache por TTL, fast mode, modelo sem preço => null', () => {
    const line = (id, model, usage) => JSON.stringify({ type: 'assistant', timestamp: '2026-09-22T10:00:00.000Z', message: { id, model, usage } });
    // opus-5-5: 1M entrada ($4) + 1M saída ($20) + 1M leitura ($0,20) + 1M escrita 5m ($5) + 1M escrita 1h ($8)
    const opus = line('a', 'claude-opus-5-5[1m]', {
        input_tokens: 1e6, output_tokens: 1e6, cache_read_input_tokens: 1e6, cache_creation_input_tokens: 2e6,
        cache_creation: { ephemeral_5m_input_tokens: 1e6, ephemeral_1h_input_tokens: 1e6 },
    });
    const haikuFast = line('b', 'claude-haiku-4-5', { input_tokens: 1e6, output_tokens: 0, speed: 'fast' }); // $1 × 2
    const synthetic = line('c', '<synthetic>', { input_tokens: 0, output_tokens: 0 });
    const r = ct.sumClaudeUsage([[opus, haikuFast, synthetic].join('\n')]);
    assert.strictEqual(r.cost_usd, 39.2);
    assert.deepStrictEqual(r.models.sort(), ['claude-haiku-4-5', 'claude-opus-5-5[1m]']);

    const unknown = ct.sumClaudeUsage([[opus, line('d', 'claude-opus-4-5', { input_tokens: 10, output_tokens: 1 })].join('\n')]);
    assert.strictEqual(unknown.cost_usd, null, 'modelo sem preço não é chutado');
    assert.deepStrictEqual(unknown.unpriced_models, ['claude-opus-4-5']);
    assert.strictEqual(unknown.input_tokens, 4e6 + 10, 'tokens continuam contados');

    let c = ct.mergeRun(null, { node: 'review', agent: 'claude', metrics: { ...tokens(10, 1), cost_usd: 0.5, duration_ms: 1 } });
    c = ct.mergeRun(c, { node: 'review', agent: 'claude', metrics: { ...tokens(10, 1), cost_usd: null, duration_ms: 1 } });
    assert.strictEqual(c.nodes.review.cost_usd, 0.5);
    assert.strictEqual(c.nodes.review.runs_without_cost, 1);
    assert.strictEqual(c.totals.cost_usd, 0.5);
});

test('PRI-233 T7: Attempt roteado grava RoutingDecision, par pedido e origem; sem routing fica AS-IS', () => {
    const decision = {
        node: 'implement', selection_source: 'RULES', subagent: 'UNENFORCED', effort_router_plugin: 'NOT_LOADED',
        chosen: { model_id: 'm-t2', effort: 'médio', cli_effort: 'medium', tier: 'T2' },
    };
    const routed = ct.mergeRun(null, { node: 'implement', agent: 'claude', run: { routing_decision: decision, effort_router_plugin: 'LOADED' }, metrics: { ...tokens(1, 1), duration_ms: 1 } });
    const a = routed.nodes.implement.attempts[0];
    assert.strictEqual(a.effort_router_plugin, 'NOT_LOADED', 'o estado provado pela decisão vence o lido da conta');
    assert.deepStrictEqual(a.routing_decision, decision);
    assert.deepStrictEqual(a.requested, { model: 'm-t2', effort: 'medium' });
    assert.strictEqual(a.selection_source, 'RULES');
    const plain = ct.mergeRun(null, { node: 'implement', agent: 'claude', metrics: { ...tokens(1, 1), duration_ms: 1 } }).nodes.implement.attempts[0];
    assert.deepStrictEqual([plain.routing_decision, plain.selection_source, plain.requested],
        ['UNAVAILABLE', 'DEFAULT_INHERITED', { model: 'UNAVAILABLE', effort: 'UNAVAILABLE' }]);
});

test('parseCodexResultTokens: números, "não disponível" e seção ausente', () => {
    const md = (body) => `# Resultado Codex — test — 1-x\n\n## Learnings\nnenhum\n## Tokens\n${body}\n## Outra\ninput_tokens: 999\n`;
    assert.deepStrictEqual(ct.parseCodexResultTokens(md('input_tokens: 12.345\noutput_tokens: 678')), { input_tokens: 12345, output_tokens: 678 });
    assert.deepStrictEqual(ct.parseCodexResultTokens(md('input_tokens: não disponível\noutput_tokens: não disponível')), { input_tokens: null, output_tokens: null });
    assert.deepStrictEqual(ct.parseCodexResultTokens('# sem seção'), { input_tokens: null, output_tokens: null });
});

// ---------------------------------------------------------------------------------
// Integração com o watcher.

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cost-tracking-'));
const repo = path.join(root, 'app-back');
const home = path.join(root, 'home');
const binDir = path.join(root, 'bin');
fs.mkdirSync(repo, { recursive: true });
fs.mkdirSync(binDir, { recursive: true });
fs.mkdirSync(path.join(home, '.claude', 'projects'), { recursive: true });

// `claude` falso: acha o --session-id, escreve um transcript com usage fixo (in=1000
// incl. cache, out=100) e avança state.json.node pro valor de FAKE_NEXT_NODE.
fs.writeFileSync(path.join(binDir, 'claude'), `#!/usr/bin/env node
const fs = require('fs'), path = require('path');
const sid = process.argv[process.argv.indexOf('--session-id') + 1];
const dir = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(process.env.HOME, '.claude'), 'projects', 'fake-project');
fs.mkdirSync(dir, { recursive: true });
const now = new Date().toISOString();
fs.writeFileSync(path.join(dir, sid + '.jsonl'), JSON.stringify({ type: 'assistant', timestamp: now,
  message: { id: 'msg-' + sid, model: 'claude-sonnet-5', usage: { input_tokens: 100, cache_read_input_tokens: 900, output_tokens: 100 } } }) + '\\n');
const stateFile = process.env.FAKE_STATE_FILE;
fs.mkdirSync(path.dirname(stateFile), { recursive: true });
const s = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8'))
    : { task_id: path.basename(path.dirname(stateFile)), node: 'plan', history: ['fetch_ticket'], status: 'in_progress', started_at: now };
delete s.cost_tracking; // agente que regrava state.json sem o campo — watcher tem que restaurar
s.node = process.env.FAKE_NEXT_NODE;
// Publica de uma vez: o teste e o watcher podem ler durante a escrita do agente.
const staged = stateFile + '.' + process.pid + '.' + sid + '.tmp';
fs.writeFileSync(staged, JSON.stringify(s));
fs.renameSync(staged, stateFile);
`, { mode: 0o755 });

process.env.REPO_PATH = repo;
// Portão de build pré-implement roda mvn de verdade — coberto em build-validator.test.js.
process.env.SKIP_PRE_BUILD_VALIDATION = 'true';
process.env.HOME = home;
// Conta do Claude: sem prefs do dashboard real (que pode ter ~/.claude-personal) — cada teste escolhe.
const prefsFile = path.join(root, 'dashboard-prefs.json');
process.env.DASHBOARD_PREFS_FILE = prefsFile;
delete process.env.WATCHER_CLAUDE_CONFIG_DIR;
process.env.PATH = `${binDir}:${process.env.PATH}`;
global.fetch = async () => { throw new Error('fetch não deveria ser chamado neste teste'); };

const watcher = require('../readmine-watcher');

const TICKET_ID = 90001;
const TASK_ID = `${TICKET_ID}-custo`;
const taskDir = path.join(repo, '.claude', 'worktrees', String(TICKET_ID), 'memory', 'runs', TASK_ID);
const ticket = {
    id: TICKET_ID, subject: 'teste custo', status: { name: 'Em Desenvolvimento' }, tracker: { name: 'Melhoria' },
    custom_fields: [{ name: 'Branch Liberação', value: 'Dev - Local' }],
};

function writeState(node) {
    fs.mkdirSync(taskDir, { recursive: true });
    fs.writeFileSync(path.join(taskDir, 'state.json'), JSON.stringify({
        task_id: TASK_ID, node, history: [], status: 'in_progress', started_at: '2026-09-22T10:00:00.000Z', updated_at: '2026-09-22T10:00:00.000Z',
    }));
}

async function waitFor(cond, ms = 5000) {
    const until = Date.now() + ms;
    while (!cond()) {
        if (Date.now() > until) throw new Error('timeout esperando condição');
        await new Promise(r => setTimeout(r, 25));
    }
}

test('watcher: despacho sem --follow grava pendente, fecha no tick seguinte e restaura cost_tracking', async () => {
    writeState('implement');
    process.env.FAKE_STATE_FILE = path.join(taskDir, 'state.json');

    // implement -> review -> implement (reprovado) -> review: loop real.
    const sequence = [['implement', 'review'], ['review', 'implement'], ['implement', 'review'], ['review', 'test']];
    for (const [expected, next] of sequence) {
        process.env.FAKE_NEXT_NODE = next;
        const res = await watcher.dispatchTicket(ticket);
        assert.strictEqual(res.node, expected);
        const pending = watcher.readCostLedger(TICKET_ID).pending;
        assert.strictEqual(pending.length, 1);
        assert.ok(pending[0].pid, 'pid registrado no modo fire-and-forget');
        const ref = pending[0].admission.attempt_ref;
        assert.strictEqual(ref.path, `${TASK_ID}/dom06/attempts/${pending[0].admission.attempt_id}.json`);
        const admitted = JSON.parse(fs.readFileSync(path.join(path.dirname(taskDir), ref.path), 'utf8'));
        assert.strictEqual(admitted.attempt_id, pending[0].admission.attempt_id);
        assert.strictEqual(pending[0].admission.admitted_node, expected);
        await waitFor(() => JSON.parse(fs.readFileSync(process.env.FAKE_STATE_FILE, 'utf8')).node === next);
        await waitFor(() => { try { process.kill(pending[0].pid, 0); return false; } catch { return true; } });
        const updatedBefore = JSON.parse(fs.readFileSync(process.env.FAKE_STATE_FILE, 'utf8')).updated_at;
        watcher.finalizePendingCostRuns();
        assert.strictEqual(watcher.readCostLedger(TICKET_ID).pending.length, 0);
        assert.strictEqual(
            JSON.parse(fs.readFileSync(process.env.FAKE_STATE_FILE, 'utf8')).updated_at, updatedBefore,
            'métrica não pode mexer em updated_at',
        );
    }

    const state = JSON.parse(fs.readFileSync(process.env.FAKE_STATE_FILE, 'utf8'));
    assert.strictEqual(state.node, 'test');
    const c = state.cost_tracking;
    assert.strictEqual(c.nodes.implement.runs, 2);
    assert.strictEqual(c.nodes.implement.input_tokens, 2000);
    assert.strictEqual(c.nodes.implement.output_tokens, 200);
    assert.strictEqual(c.nodes.implement.cache_read_input_tokens, 1800);
    assert.strictEqual(c.nodes.review.retries, 1);
    assert.strictEqual(c.totals.loop_count, 2);
    assert.strictEqual(c.totals.input_tokens, 4000);
    // sonnet-5 por run: 100×$2 + 900×$0,20 + 100×$10 por MTok = $0,00138; 4 runs.
    assert.strictEqual(c.nodes.implement.cost_usd, 0.00276);
    assert.strictEqual(c.totals.cost_usd, 0.00552);
    assert.deepStrictEqual(c.nodes.implement.models, ['claude-sonnet-5']);
    assert.ok(c.pricing_source);
    assert.strictEqual(c.nodes.implement.attempts.length, 2);
    const attempt = c.nodes.implement.attempts[0];
    assert.strictEqual(attempt.attributed_node, 'implement');
    assert.strictEqual(attempt.selection_source, 'DEFAULT_INHERITED');
    assert.deepStrictEqual(attempt.requested, { model: 'UNAVAILABLE', effort: 'UNAVAILABLE' });
    assert.strictEqual(attempt.observed.usage[0].input_tokens, 100);
    assert.strictEqual(attempt.observed.usage[0].cache_read_tokens, 900);
    assert.strictEqual(attempt.first_turn.cache_read_tokens, 900);
    assert.strictEqual(attempt.cost.pricing_sha256, ct.PRICING_SHA256);
    assert.strictEqual(attempt.cost.usd, 0.00138);
    assert.strictEqual(require('../validate-state').validateState(state).valid, true);
    for (const n of ['implement', 'review']) assert.ok(Number.isInteger(c.nodes[n].duration_ms) && c.nodes[n].duration_ms >= 0);
});

test('watcher: run do /commit cai na task arquivada; sem transcript => tokens null, duração preenchida', () => {
    const archived = path.join(repo, '.claude', 'worktrees', String(TICKET_ID), 'memory', 'runs', '_archive', TASK_ID);
    fs.mkdirSync(path.dirname(archived), { recursive: true });
    fs.renameSync(taskDir, archived);

    const run = watcher.startCostRun(TICKET_ID, { agent: 'claude', nodes: ['commit'], sessionId: 'sessao-sem-transcript' });
    watcher.finishCostRun(TICKET_ID, 'sessao-sem-transcript', run.started_at_ms + 1234);

    const c = JSON.parse(fs.readFileSync(path.join(archived, 'state.json'), 'utf8')).cost_tracking;
    assert.deepStrictEqual(
        Object.fromEntries(Object.entries(c.nodes.commit).filter(([key]) => key !== 'attempts')),
        { agent: 'claude', input_tokens: null, output_tokens: null, cost_usd: null, duration_ms: 1234, runs: 1, retries: 0, runs_without_tokens: 1 },
    );
    assert.strictEqual(c.totals.input_tokens, 4000, 'null de um nó não apaga o total dos outros');
    assert.strictEqual(c.nodes.implement.runs, 2);
});

test('watcher: codex lê "## Tokens" de codex-result-<node>.md', () => {
    const TID = 90002;
    const dir = path.join(repo, '.claude', 'worktrees', String(TID), 'memory', 'runs', `${TID}-x`);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ task_id: `${TID}-x`, node: 'verify', history: [], status: 'in_progress', started_at: '2026-09-22T10:00:00.000Z' }));
    fs.writeFileSync(path.join(dir, 'codex-result-test.md'), '## Tokens\ninput_tokens: 321\noutput_tokens: não disponível\n');
    const run = watcher.startCostRun(TID, { agent: 'codex', nodes: ['test'], sessionId: 'codex-1' });
    watcher.finishCostRun(TID, 'codex-1', run.started_at_ms + 10);
    const n = JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8')).cost_tracking.nodes.test;
    assert.strictEqual(n.agent, 'codex');
    assert.strictEqual(n.input_tokens, 321);
    assert.strictEqual(n.output_tokens, null);
    assert.strictEqual(n.duration_ms, 10);
    const a = n.attempts[0];
    assert.strictEqual(a.provider, 'openai');
    assert.strictEqual(a.cost.usd, null);
    assert.strictEqual(a.observed.usage[0].input_tokens, 321);
    for (const key of ['cache_read_tokens', 'cache_write_5m_tokens', 'cache_write_1h_tokens', 'cache_write_ttl_unknown_tokens']) assert.strictEqual(a.observed.usage[0][key], null);
    assert.strictEqual(a.observed.usage[0].model, 'UNKNOWN');
    assert.strictEqual(a.observed.effort, 'UNKNOWN');
    assert.strictEqual(a.admission.attempt_id, 'UNKNOWN');
    assert.strictEqual(a.admission.reason, 'NO_REAL_ATTEMPT');
});

test('watcher: sem task dir o custo vai pra unattributed, não some', () => {
    const TID = 90003;
    const run = watcher.startCostRun(TID, { agent: 'claude', nodes: ['fetch_ticket', 'plan'], sessionId: 'pretask' });
    watcher.finishCostRun(TID, 'pretask', run.started_at_ms + 50);
    const ledger = watcher.readCostLedger(TID);
    assert.strictEqual(ledger.pending.length, 0);
    assert.strictEqual(ledger.unattributed.length, 1);
    assert.strictEqual(ledger.unattributed[0].duration_ms, 50);
});

test.after(() => fs.rmSync(root, { recursive: true, force: true }));

test('watcher: nó != commit sem task ativa não cai na task arquivada do ciclo anterior', () => {
    // TICKET_ID tem só a task arquivada (teste do /commit acima) — novo ciclo que trava no fetch_ticket.
    const run = watcher.startCostRun(TICKET_ID, { agent: 'claude', nodes: ['fetch_ticket', 'plan'], sessionId: 'novo-ciclo' });
    watcher.finishCostRun(TICKET_ID, 'novo-ciclo', run.started_at_ms + 5);
    const archived = path.join(repo, '.claude', 'worktrees', String(TICKET_ID), 'memory', 'runs', '_archive', TASK_ID, 'state.json');
    assert.ok(!JSON.parse(fs.readFileSync(archived, 'utf8')).cost_tracking.nodes.plan);
    assert.strictEqual(watcher.readCostLedger(TICKET_ID).unattributed.length, 1);
});

test('watcher: conta do Claude selecionada no dashboard (~/.claude-personal) — transcript é achado lá', async () => {
    const personal = path.join(home, '.claude-personal');
    fs.writeFileSync(prefsFile, JSON.stringify({ claude_config_dir: '~/.claude-personal' }));
    try {
        writeState('implement');
        process.env.FAKE_STATE_FILE = path.join(taskDir, 'state.json');
        process.env.FAKE_NEXT_NODE = 'review';
        const before = watcher.readCostLedger(TICKET_ID).tasks[TASK_ID]?.nodes?.implement?.runs || 0;
        await watcher.dispatchTicket(ticket);
        const [pending] = watcher.readCostLedger(TICKET_ID).pending;
        assert.strictEqual(pending.claude_config_dir, personal, 'conta gravada no run pendente');
        await waitFor(() => JSON.parse(fs.readFileSync(process.env.FAKE_STATE_FILE, 'utf8')).node === 'review');
        await waitFor(() => { try { process.kill(pending.pid, 0); return false; } catch { return true; } });
        assert.ok(fs.existsSync(path.join(personal, 'projects', 'fake-project', `${pending.session_id}.jsonl`)), 'agente gravou na conta selecionada');

        // Troca a conta antes de fechar: o run ainda acha o transcript pela conta gravada.
        fs.writeFileSync(prefsFile, JSON.stringify({ claude_config_dir: 'default' }));
        watcher.finalizePendingCostRuns();
        const impl = watcher.readCostLedger(TICKET_ID).tasks[TASK_ID].nodes.implement;
        assert.strictEqual(impl.runs, before + 1);
        assert.strictEqual(impl.runs_without_tokens || 0, 0, 'tokens medidos, não null');
        assert.ok(impl.input_tokens > 0);
    } finally {
        fs.rmSync(prefsFile, { force: true });
    }
});

// PRI-210: fixtures sintéticas, sem ler configuração/transcripts do usuário.
const usageLine = (id, model, usage) => JSON.stringify({ type: 'assistant', message: { id, model, usage } });
const micro = v => Math.round(v * 1e6) / 1e6;
function assertProjection(metrics) {
    const total = field => metrics.usage.reduce((n, row) => n + row[field], 0);
    assert.strictEqual(total('input_tokens') + total('cache_read_tokens') + total('cache_write_5m_tokens') + total('cache_write_1h_tokens') + total('cache_write_ttl_unknown_tokens'), metrics.input_tokens);
    assert.strictEqual(total('output_tokens'), metrics.output_tokens);
    assert.strictEqual(micro(metrics.usage.reduce((n, row) => n + ct.projectUsageCost(row), 0)), metrics.cost_usd);
}

test('PRI-210 MINOR-2: linha synthetic zerada projeta 0 sem mascarar preço ausente faturável', () => {
    const m = ct.sumClaudeUsage([
        usageLine('paid', 'claude-opus-5-5', { input_tokens: 100, output_tokens: 10 }),
        usageLine('local', '<synthetic>', { input_tokens: 0, output_tokens: 0 }),
    ].join('\n').split('\n'));
    assert.strictEqual(m.cost_usd, 0.0006);
    assert.deepStrictEqual(m.usage.map(row => [row.model, ct.projectUsageCost(row)]),
        [['claude-opus-5-5', 0.0006], ['<synthetic>', 0]]);
    const strictSum = m.usage.reduce((total, row) => {
        const cost = ct.projectUsageCost(row);
        return total === null || cost === null ? null : total + cost;
    }, 0);
    assert.strictEqual(strictSum, m.cost_usd);
    const unknown = ct.sumClaudeUsage([usageLine('unknown', 'claude-unknown', { input_tokens: 1 })]);
    assert.strictEqual(ct.projectUsageCost(unknown.usage[0]), null);
    const codex = ct.mergeRun(null, { node: 'test', agent: 'codex', metrics: { ...tokens(null, null) } });
    assert.strictEqual(ct.projectUsageCost(codex.nodes.test.attempts[0].observed.usage[0]), null);
});

test('PRI-210 MINOR-4: preço inválido fica UNKNOWN; JSON ausente ou inválido não impede require', () => {
    const crypto = require('crypto');
    const base = ct.pricingSnapshot();
    const table = JSON.parse(base.json);
    delete table.models['claude-opus-5-5'].cache_write_1h;
    table.models['claude-haiku-5-5'].tiers[0].max_prompt_tokens = 200000;
    table.models['claude-haiku-5-5'].tiers[1].max_prompt_tokens = 100000;
    const json = JSON.stringify(table);
    const pinned = { json, sha256: crypto.createHash('sha256').update(json).digest('hex') };
    const missingRate = ct.sumClaudeUsage([usageLine('opus', 'claude-opus-5-5', { input_tokens: 1 })], pinned);
    assert.strictEqual(missingRate.cost_usd, null);
    assert.strictEqual(missingRate.usage[0].price_tier, 'UNKNOWN');
    assert.deepStrictEqual(missingRate.unpriced_models, ['claude-opus-5-5']);
    assert.strictEqual(ct.projectUsageCost(missingRate.usage[0], pinned), null);
    const invalidTier = ct.sumClaudeUsage([usageLine('haiku', 'claude-haiku-5-5', { input_tokens: 1 })], pinned);
    assert.strictEqual(invalidTier.cost_usd, null);
    assert.strictEqual(invalidTier.usage[0].price_tier, 'UNKNOWN');
    const stillValid = ct.sumClaudeUsage([usageLine('sonnet', 'claude-sonnet-5', { input_tokens: 1 })], pinned);
    assert.strictEqual(stillValid.cost_usd, 0.000002);

    const { spawnSync } = require('child_process');
    for (const mode of ['missing', 'malformed']) {
        const source = `const fs=require('fs'), read=fs.readFileSync; fs.readFileSync=function(file,...args) { if (String(file).endsWith('model-pricing.json')) { if (${JSON.stringify(mode)}==='missing') throw new Error('ENOENT'); return Buffer.from('{invalid'); } return read.call(fs,file,...args); }; const c=require(${JSON.stringify(path.join(__dirname, 'cost-tracking.js'))}); const m=c.sumClaudeUsage([JSON.stringify({type:'assistant',message:{id:'x',model:'claude-opus-5-5',usage:{input_tokens:1}}})]); if(m.cost_usd!==null || m.usage[0].price_tier!=='UNKNOWN' || c.projectUsageCost(m.usage[0])!==null) process.exit(1);`;
        const child = spawnSync(process.execPath, ['-e', source], { encoding: 'utf8' });
        assert.strictEqual(child.status, 0, `${mode}: ${child.stderr}`);
    }
});

test('PRI-210: empate de ponto flutuante da projeção admite meio microdólar sem alterar legado', () => {
    // Caso determinístico 336 da comparação com 699a28d: a ordem dos grupos
    // difere da ordem das mensagens, logo o arredondamento no empate pode divergir.
    const legacyModels = [
        'claude-fable-5-1', 'claude-mythos-5-1', 'claude-fable-5', 'claude-mythos-5',
        'claude-opus-5-5', 'claude-opus-5', 'claude-opus-4-8', 'claude-opus-4-7',
        'claude-opus-4-6', 'claude-sonnet-5', 'claude-sonnet-4-6', 'claude-haiku-4-5',
        'claude-unknown', '<synthetic>',
    ];
    let seed = 210;
    const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed; };
    let files;
    for (let i = 0; i <= 336; i++) {
        files = [[], [], []];
        for (let j = 0; j < 15; j++) {
            const creation = random() % 50000;
            const usage = {
                input_tokens: random() % 20000, output_tokens: random() % 5000,
                cache_read_input_tokens: random() % 200000, cache_creation_input_tokens: creation,
            };
            if (j % 3 === 0) usage.cache_creation = { ephemeral_5m_input_tokens: Math.floor(creation / 2), ephemeral_1h_input_tokens: creation - Math.floor(creation / 2) };
            if (j % 3 === 1) usage.cache_creation = { ephemeral_1h_input_tokens: Math.floor(creation / 3) };
            if (j % 2 === 0) usage.speed = 'fast';
            files[j % 3].push(usageLine(`id-${j % 8}`, legacyModels[random() % legacyModels.length], usage));
        }
    }
    const metrics = ct.sumClaudeUsage(files.map(lines => lines.join('\n')));
    const projection = metrics.usage.reduce((sum, row) => sum + ct.projectUsageCost(row), 0);
    assert.strictEqual(metrics.cost_usd, 2.638316, 'agregado legado continua exato');
    assert.strictEqual(micro(projection), 2.638315, 'empate demonstra o desvio de 1 microdólar');
    assert.ok(Math.abs(projection - metrics.cost_usd) <= 0.000000500001,
        'valor bruto projetado fica dentro de meio microdólar + tolerância numérica');
});

test('PRI-210 v9: casos A/B distinguem faixas e reproduzem o custo exato', () => {
    const measure = inputs => ct.sumClaudeUsage([{ role: 'main', content: inputs.map((n, i) => usageLine(String(i), 'claude-haiku-5-5', { input_tokens: n, output_tokens: 1 })).join('\n') }]);
    const a = measure([75000, 75000]), b = measure([25000, 125000]);
    assert.strictEqual(a.cost_usd, 0.015001);
    assert.strictEqual(b.cost_usd, 0.065003);
    assert.strictEqual(a.usage.length, 1);
    assert.strictEqual(a.usage[0].messages, 2);
    assert.deepStrictEqual(b.usage.map(row => row.price_tier), ['prompt_lte_100000', 'prompt_gt_100000']);
    for (const m of [a, b]) {
        assertProjection(m);
        for (const row of m.usage) assert.strictEqual(row.pricing_sha256, ct.PRICING_SHA256);
    }
    assert.strictEqual(ct.projectUsageCost({ ...a.usage[0], pricing_sha256: '0'.repeat(64) }), null, 'histórico não usa tabela latest');
});

test('PRI-210 v9: fronteira de faixa inclui cache read e todos os TTLs de escrita', () => {
    for (const [usage, tier] of [
        [{ input_tokens: 100000 }, 'prompt_lte_100000'],
        [{ input_tokens: 100001 }, 'prompt_gt_100000'],
        [{ input_tokens: 10000, cache_read_input_tokens: 90000 }, 'prompt_lte_100000'],
        [{ input_tokens: 10000, cache_read_input_tokens: 90001 }, 'prompt_gt_100000'],
        [{ input_tokens: 10000, cache_read_input_tokens: 80000, cache_creation_input_tokens: 10001, cache_creation: { ephemeral_5m_input_tokens: 5000, ephemeral_1h_input_tokens: 5001 } }, 'prompt_gt_100000'],
    ]) {
        const m = ct.sumClaudeUsage([usageLine('boundary', 'claude-haiku-5-5', usage)]);
        assert.strictEqual(m.usage[0].price_tier, tier);
        assertProjection(m);
    }
    const m = ct.sumClaudeUsage([usageLine('cache', 'claude-sonnet-5-5', { cache_read_input_tokens: 1e6 })]);
    assert.strictEqual(m.cost_usd, 0.10);
    assert.strictEqual(m.usage[0].price_tier, 'flat');
    assert.strictEqual(ct.priceFor('claude-opus-5-5').price_tier, 'flat');
    assert.strictEqual(ct.messageCostUsd('claude-opus-5-5', { input_tokens: 1e6 }), 4);
});

test('PRI-210: multimodelo, TTL misto/ausente, fast misto e deduplicação reproduzem agregados', () => {
    const content = [
        usageLine('one', 'claude-opus-5-5', { input_tokens: 100, output_tokens: 2, cache_creation_input_tokens: 300, cache_creation: { ephemeral_5m_input_tokens: 100, ephemeral_1h_input_tokens: 200 } }),
        usageLine('two', 'claude-opus-5-5', { input_tokens: 80, output_tokens: 3, speed: 'fast', cache_creation_input_tokens: 50 }),
        usageLine('two', 'claude-opus-5-5', { input_tokens: 90, output_tokens: 4, speed: 'fast', cache_creation_input_tokens: 60 }),
        usageLine('three', 'claude-sonnet-5-5', { input_tokens: 80, output_tokens: 5, cache_read_input_tokens: 99 }),
    ].join('\n');
    const sub = usageLine('sub', 'claude-haiku-5-5', { input_tokens: 120000, output_tokens: 8 });
    const m = ct.sumClaudeUsage([{ role: 'main', content }, { role: 'subagent', file_ref: 'worker.jsonl', content: sub }]);
    assertProjection(m);
    assert.deepStrictEqual(m.usage.map(r => [r.model, r.role, r.speed]), [
        ['claude-opus-5-5', 'main', 'standard'], ['claude-opus-5-5', 'main', 'fast'],
        ['claude-sonnet-5-5', 'main', 'standard'], ['claude-haiku-5-5', 'subagent', 'standard'],
    ]);
    assert.strictEqual(m.usage[1].cache_write_ttl_unknown_tokens, 60);
    assert.strictEqual(m.cost_estimated, true);
    assert.deepStrictEqual(m.first_turn, { cache_read_tokens: null, cache_write_5m_tokens: 100, cache_write_1h_tokens: 200 });
    const node = ct.mergeRun(null, { node: 'review', agent: 'claude', metrics: m }).nodes.review;
    assert.strictEqual(node.input_tokens, m.input_tokens);
    assert.deepStrictEqual(node.attempts[0].observed.usage, m.usage);
    assert.strictEqual(node.attempts[0].cost.estimated, true);
});

test('PRI-210 R3-01: readdirSync b,a mantém último a, input 10 e registra divergência', t => {
    const projects = path.join(root, 'r3-projects'), project = path.join(projects, 'p');
    const subDir = path.join(project, 'session', 'subagents');
    fs.mkdirSync(subDir, { recursive: true });
    fs.writeFileSync(path.join(project, 'session.jsonl'), '');
    fs.writeFileSync(path.join(subDir, 'a.jsonl'), usageLine('same', 'claude-opus-5-5', { input_tokens: 10 }));
    fs.writeFileSync(path.join(subDir, 'b.jsonl'), usageLine('same', 'claude-opus-5-5', { input_tokens: 100 }));
    const readdir = fs.readdirSync;
    t.mock.method(fs, 'readdirSync', function(dir, ...args) { return dir === subDir ? ['b.jsonl', 'a.jsonl'] : readdir.call(fs, dir, ...args); });
    const files = ct.findClaudeTranscripts('session', projects);
    const m = ct.sumClaudeUsage(files.map((file, i) => ({ role: i === 0 ? 'main' : 'subagent', file_ref: i === 0 ? 'main' : path.basename(file), content: fs.readFileSync(file, 'utf8') })));
    assert.strictEqual(m.input_tokens, 10);
    assert.strictEqual(m.cost_usd, 0.00004);
    assert.deepStrictEqual(m.read_order.map(r => r.file_ref), ['main', 'b.jsonl', 'a.jsonl']);
    assert.strictEqual(m.dedup_conflicts.length, 1);
    assert.strictEqual(m.dedup_conflicts[0].usage_diverged, true);
    assert.strictEqual(m.role_attribution.status, 'COMPLETE');
    assertProjection(m);
});

test('PRI-210 DV02: vencedor subagent, input 100 e USD 0,0004; atribuição parcial', () => {
    const m = ct.sumClaudeUsage([
        { role: 'main', content: usageLine('same-id', 'claude-opus-5-5', { input_tokens: 10 }) },
        { role: 'subagent', content: usageLine('same-id', 'claude-opus-5-5', { input_tokens: 100 }) },
    ]);
    assert.strictEqual(m.input_tokens, 100);
    assert.strictEqual(m.cost_usd, 0.0004);
    assert.strictEqual(m.dedup_conflicts[0].winner_role, 'subagent');
    assert.strictEqual(m.dedup_conflicts[0].usage_diverged, true);
    assert.strictEqual(m.usage[0].role_provenance, 'CONFLICTED');
    assert.deepStrictEqual(m.role_attribution, { status: 'PARTIAL', conflicted_messages: 1 });
    assert.strictEqual(m.usage[0].role_conflicted_messages, 1);
    assertProjection(m);
    assert.ok(!JSON.stringify(m).includes('same-id'), 'id de mensagem só sai como hash');
});

test('PRI-214 MINOR-3: CONFLICTED não contamina grupo limpo do mesmo modelo/papel', () => {
    const clean = usageLine('clean-only', 'claude-opus-5-5', { input_tokens: 50, output_tokens: 2 });
    const conflictMain = usageLine('shared', 'claude-opus-5-5', { input_tokens: 10 });
    const conflictSub = usageLine('shared', 'claude-opus-5-5', { input_tokens: 100 });
    const m = ct.sumClaudeUsage([
        { role: 'main', content: [clean, conflictMain].join('\n') },
        { role: 'subagent', content: conflictSub },
    ]);
    const byProvenance = Object.fromEntries(m.usage.map(r => [r.role_provenance, r]));
    assert.ok(byProvenance.SELF_REPORTED, 'mensagem limpa permanece SELF_REPORTED');
    assert.ok(byProvenance.CONFLICTED, 'mensagem conflitante fica em grupo CONFLICTED');
    assert.strictEqual(byProvenance.SELF_REPORTED.role, 'main');
    assert.strictEqual(byProvenance.SELF_REPORTED.input_tokens, 50);
    assert.strictEqual(byProvenance.SELF_REPORTED.role_conflicted_messages, 0);
    assert.strictEqual(byProvenance.CONFLICTED.role, 'subagent');
    assert.strictEqual(byProvenance.CONFLICTED.role_conflicted_messages, 1);
    assert.deepStrictEqual(m.role_attribution, { status: 'PARTIAL', conflicted_messages: 1 });
    assertProjection(m);
});

test('PRI-210: modelo sem preço mantém fato bruto e cost.usd null, nunca zero', () => {
    const m = ct.sumClaudeUsage([usageLine('missing', 'claude-unknown', { input_tokens: 10 })]);
    const a = ct.mergeRun(null, { node: 'test', agent: 'claude', metrics: m }).nodes.test.attempts[0];
    assert.strictEqual(m.usage[0].price_tier, 'UNKNOWN');
    assert.strictEqual(ct.projectUsageCost(m.usage[0]), null);
    assert.strictEqual(a.cost.usd, null);
    assert.deepStrictEqual(a.cost.unpriced_models, ['claude-unknown']);
    assert.strictEqual(a.observed.usage[0].input_tokens, 10);
});

test('PRI-210: referência fora da raiz é UNKNOWN com causa, sem reconstruir template', () => {
    const file = path.join(root, 'outside.json');
    fs.writeFileSync(file, '{}');
    const result = ct.admissionForCost({ attempt: { started: true, attempt_id: 'real', node: 'commit', cause: 'retry' }, attemptFile: file }, 1, path.join(root, 'runs'));
    assert.strictEqual(result.admission.attempt_ref, 'UNKNOWN');
    assert.strictEqual(result.admission.reason, 'INVALID_ATTEMPT_REF');
    assert.strictEqual(result.cause, 'retry');
});

test('PRI-210: despacho Commit passa a admissão real sem depender do lease', async () => {
    const TID = 90010, task = `${TID}-commit`;
    const dir = path.join(repo, '.claude', 'worktrees', String(TID), 'memory', 'runs', task);
    fs.mkdirSync(dir, { recursive: true });
    const stateFile = path.join(dir, 'state.json');
    fs.writeFileSync(stateFile, JSON.stringify({ task_id: task, node: 'commit', history: ['plan','implement','review','test','verify'], status: 'in_progress' }));
    process.env.FAKE_STATE_FILE = stateFile;
    process.env.FAKE_NEXT_NODE = 'commit';
    const dispatched = await watcher.dispatchTicket({ ...ticket, id: TID });
    assert.strictEqual(dispatched.action, 'dispatched');
    const [run] = watcher.readCostLedger(TID).pending;
    assert.notStrictEqual(run.admission.attempt_id, 'UNKNOWN');
    assert.strictEqual(run.admission.admitted_node, 'commit');
    const ref = run.admission.attempt_ref;
    const actual = path.join(path.dirname(dir), ref.path);
    assert.strictEqual(actual, path.join(dir, 'dom06', 'attempts', `${run.admission.attempt_id}.json`));
    assert.strictEqual(JSON.parse(fs.readFileSync(actual)).attempt_id, run.admission.attempt_id);
    await waitFor(() => { try { process.kill(run.pid, 0); return false; } catch { return true; } });
    watcher.finishCostRun(TID, run.session_id);
    const a = JSON.parse(fs.readFileSync(stateFile)).cost_tracking.nodes.commit.attempts[0];
    assert.strictEqual(a.admission.attempt_id, run.admission.attempt_id);
    assert.strictEqual(a.result, JSON.parse(fs.readFileSync(actual)).result);
});

test('PRI-210: despacho inicial correlaciona fetch_ticket a plan usando arquivo real', async () => {
    const TID = 90011, task = `${TID}-initial`;
    const runs = path.join(repo, '.claude', 'worktrees', String(TID), 'memory', 'runs');
    fs.mkdirSync(runs, { recursive: true });
    const description = '# Spec\n\n## Problema\nO custo não tem identidade da admissão e deve ficar rastreável.\n\n## Solução\nRegistrar fatos por Attempt preservando o despacho existente. Os dados sintéticos comprovam a referência exata e não dependem de dados ou configurações de qualquer consumidor.\n\n## Critérios de Aceite\n- AC-01: correlacionar o Attempt real.\n- AC-02: preservar agregados.\n';
    const specDir = path.join(repo, 'memory', 'spec');
    fs.mkdirSync(specDir, { recursive: true });
    fs.writeFileSync(path.join(specDir, `${TID}-spec.md`), description);
    process.env.FAKE_STATE_FILE = path.join(runs, task, 'state.json');
    process.env.FAKE_NEXT_NODE = 'implement';
    const result = await watcher.dispatchTicket({ ...ticket, id: TID, description });
    assert.strictEqual(result.action, 'dispatched');
    const [run] = watcher.readCostLedger(TID).pending;
    assert.strictEqual(run.admission.admitted_node, 'fetch_ticket');
    assert.strictEqual(run.admission.attempt_ref.path, `_dom06/dom06/attempts/${run.admission.attempt_id}.json`);
    const actual = path.join(runs, run.admission.attempt_ref.path);
    assert.strictEqual(JSON.parse(fs.readFileSync(actual)).attempt_id, run.admission.attempt_id);
    await waitFor(() => { try { process.kill(run.pid, 0); return false; } catch { return true; } });
    watcher.finishCostRun(TID, run.session_id);
    const a = JSON.parse(fs.readFileSync(process.env.FAKE_STATE_FILE)).cost_tracking.nodes.plan.attempts[0];
    assert.strictEqual(a.attributed_node, 'plan');
    assert.deepStrictEqual(a.also_covers, ['fetch_ticket']);
    assert.strictEqual(a.admission.attempt_id, run.admission.attempt_id);
});

test('PRI-210: falha na coleta não altera despacho nem resultado do nó', async t => {
    const TID = 90012, dir = path.join(repo, '.claude', 'worktrees', String(TID), 'memory', 'runs', `${TID}-failure`);
    fs.mkdirSync(dir, { recursive: true });
    const stateFile = path.join(dir, 'state.json');
    fs.writeFileSync(stateFile, JSON.stringify({ task_id: `${TID}-failure`, node: 'implement', history: [], status: 'in_progress' }));
    process.env.FAKE_STATE_FILE = stateFile;
    process.env.FAKE_NEXT_NODE = 'review';
    const result = await watcher.dispatchTicket({ ...ticket, id: TID });
    assert.strictEqual(result.action, 'dispatched');
    const [run] = watcher.readCostLedger(TID).pending;
    await waitFor(() => { try { process.kill(run.pid, 0); return false; } catch { return true; } });
    const before = fs.readFileSync(stateFile, 'utf8');
    const read = fs.readFileSync;
    t.mock.method(fs, 'readFileSync', function(file, ...args) { if (String(file).endsWith('.jsonl')) throw new Error('falha de coleta sintética'); return read.call(fs, file, ...args); });
    assert.doesNotThrow(() => watcher.finishCostRun(TID, run.session_id));
    assert.strictEqual(fs.readFileSync(stateFile, 'utf8'), before);
    assert.strictEqual(JSON.parse(before).node, 'review');
    assert.strictEqual(watcher.readCostLedger(TID).pending.length, 1, 'falha não se transforma em métrica zero');
});

test('PRI-210: --dry-run não cria ledger ou linha de Attempt', () => {
    const { spawnSync } = require('child_process');
    const source = `process.argv.push('--dry-run'); const w = require(${JSON.stringify(path.join(__dirname, '..', 'readmine-watcher'))}); const r = w.startCostRun(90020, {agent:'claude',nodes:['test'],sessionId:'dry'}); w.finishCostRun(90020,'dry'); if(r!==null || require('fs').existsSync(w.costLedgerPath(90020))) process.exit(1);`;
    const result = spawnSync(process.execPath, ['-e', source], { env: { ...process.env, REPO_PATH: repo, HOME: home }, encoding: 'utf8' });
    assert.strictEqual(result.status, 0, result.stderr);
});

test('PRI-210: schema aceita estado legado e novo e rejeita hash, contador e rótulo inválidos', () => {
    const Ajv = require('ajv');
    const schema = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', '.graph', 'schemas', 'state.schema.json')));
    const ajv = new Ajv({ allErrors: true, strict: false });
    require('ajv-formats')(ajv);
    const validate = ajv.compile(schema);
    const legacy = { task_id: 'schema-synthetic', node: 'test', history: ['plan'], status: 'in_progress', cost_tracking: { nodes: { test: { agent: 'claude', input_tokens: 1, output_tokens: 1, cost_usd: 0.001, cache_read_input_tokens: 1, cache_creation_input_tokens: 1, models: ['claude-opus-5-5'], runs_without_cost: 0 } }, totals: { cost_usd: 0.001 }, pricing_source: 'legacy' } };
    assert.equal(validate(legacy), true, JSON.stringify(validate.errors));
    const metrics = ct.sumClaudeUsage([usageLine('schema', 'claude-haiku-5-5', { input_tokens: 125000, output_tokens: 1 })]);
    const state = { ...legacy, cost_tracking: ct.mergeRun(null, { node: 'test', agent: 'claude', metrics }) };
    assert.equal(validate(state), true, JSON.stringify(validate.errors));
    for (const mutate of [
        a => { a.observed.usage[0].pricing_sha256 = 'invalid'; },
        a => { a.observed.usage[0].input_tokens = -1; },
        a => { a.account.label = '/home/account'; },
    ]) {
        const bad = JSON.parse(JSON.stringify(state));
        mutate(bad.cost_tracking.nodes.test.attempts[0]);
        assert.equal(validate(bad), false, 'schema deve rejeitar valor inválido');
    }
});

test('PRI-210 v9: pin de preços preserva limites do despacho após mudança de tabela', () => {
    const snapshot = ct.pricingSnapshot();
    const table = JSON.parse(snapshot.json);
    table.models['claude-haiku-5-5'].tiers[0].max_prompt_tokens = 200000;
    const json = JSON.stringify(table);
    const pinned = { json, sha256: require('crypto').createHash('sha256').update(json).digest('hex') };
    const input = [usageLine('pin', 'claude-haiku-5-5', { input_tokens: 125000, output_tokens: 1 })];
    const m = ct.sumClaudeUsage(input, pinned);
    assert.equal(m.usage[0].price_tier, 'prompt_lte_100000', 'id da faixa vem da tabela, não é calculado pelo nome');
    assert.equal(m.usage[0].pricing_sha256, pinned.sha256);
    assert.equal(m.cost_usd, 0.012501);
    assert.equal(ct.projectUsageCost(m.usage[0]), null, 'tabela atual não reinterpreta o pin');
    assert.equal(micro(ct.projectUsageCost(m.usage[0], pinned)), m.cost_usd);
    assert.equal(ct.sumClaudeUsage(input).usage[0].price_tier, 'prompt_gt_100000');
    assert.throws(() => ct.sumClaudeUsage(input, { ...pinned, sha256: snapshot.sha256 }), /PRICING_SNAPSHOT_HASH_MISMATCH/);
});


test('state-writer: leitura parcial de agente externo é repetida antes de concluir o estado', t => {
    const writer = require('../state-writer');
    const dir = path.join(repo, 'memory', 'runs', '90016-torn-read');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'state.json');
    const state = { task_id: '90016-torn-read', node: 'review', status: 'in_progress' };
    fs.writeFileSync(file, JSON.stringify(state));
    const read = fs.readFileSync;
    let attempts = 0;
    t.mock.method(fs, 'readFileSync', function(candidate, ...args) {
        if (candidate === file && ++attempts <= 2) return '{"task_id":';
        return read.call(this, candidate, ...args);
    });
    assert.deepStrictEqual(writer.read(dir), state);
    assert.strictEqual(attempts, 3, 'não retorna null nem aceita JSON truncado nas duas primeiras leituras');
});
