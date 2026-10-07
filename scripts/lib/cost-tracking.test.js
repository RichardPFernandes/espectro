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
        { ...c.nodes.implement },
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
const s = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
delete s.cost_tracking; // agente que regrava state.json sem o campo — watcher tem que restaurar
s.node = process.env.FAKE_NEXT_NODE;
fs.writeFileSync(stateFile, JSON.stringify(s));
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
        { ...c.nodes.commit },
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
