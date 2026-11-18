// node --test scripts/lib/cli-result-e2e.test.js
// PRI-381 (F1.5, AC-04/AC-05), ponta a ponta sintético: do fechamento do run ao weekly. Um despacho
// real com a flag ligada e SIMULATE desligado não é viável em teste, então o log do ticket e o
// transcript da sessão são fixtures sintéticas (nenhum dado de consumidor, ticket fictício).
// Caminho: startCostRun → log com o JSON da CLI → finishCostRun → state.json → buildReport/copyText.
// REPO_PATH e HOME descartáveis; nenhum agente roda.
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-result-e2e-'));
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
const W = require('../../dashboard/public/weekly-report');
const { projectCostTracking } = require('../../dashboard/cost-projection');

test.after(() => fs.rmSync(root, { recursive: true, force: true }));

const PRISMA_ROOT = path.resolve(__dirname, '..', '..');
const PLAN_HASH = crypto.createHash('sha256').update(fs.readFileSync(path.join(PRISMA_ROOT, '.claude', 'commands', 'plan.md'))).digest('hex');
const write = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
const CLI_KEYS = /"(cli_result_json|log_offset|prompt_hashes|cli_usd|cli_version|cli_cost_usd|runs_without_cli_cost)"/;

function withFlag(value, fn) {
    const before = process.env.WATCHER_CLI_RESULT_JSON;
    if (value === undefined) delete process.env.WATCHER_CLI_RESULT_JSON;
    else process.env.WATCHER_CLI_RESULT_JSON = value;
    try { return fn(); } finally {
        if (before === undefined) delete process.env.WATCHER_CLI_RESULT_JSON;
        else process.env.WATCHER_CLI_RESULT_JSON = before;
    }
}

// Despacho sintético do nó plan: worktree com state.json, log do ticket com a linha do JSON da CLI
// (como o spawnAgent grava: `<ISO> [claude] <texto>`) e transcript da sessão com `version`.
function dispatch(id, sid, flag, { cliUsd = 1.23, version = '2.5.1' } = {}) {
    const dir = path.join(repo, '.claude', 'worktrees', String(id), 'memory', 'runs', `${id}-x`);
    write(path.join(dir, 'state.json'), JSON.stringify({ task_id: `${id}-x`, node: 'plan', history: [], status: 'in_progress',
        started_at: '2026-11-18T10:00:00.000Z', updated_at: '2026-11-18T10:00:00.000Z' }));
    const log = path.join(repo, 'memory', 'runs', `${id}.log`);
    write(log, '2026-11-18T09:59:00.000Z [claude] texto de um despacho anterior\n');
    const run = withFlag(flag, () => watcher.startCostRun(id, { agent: 'claude', nodes: ['plan'], sessionId: sid }));
    const usage = { input_tokens: 200000, cache_read_input_tokens: 0, output_tokens: 20000 };
    const transcript = [
        { type: 'user', version, timestamp: '2026-11-18T10:00:00.000Z', message: { role: 'user', content: 'oi' } },
        { type: 'assistant', version, timestamp: '2026-11-18T10:00:01.000Z', message: { id: `m-${sid}`, model: 'claude-sonnet-5', usage } },
    ];
    write(path.join(home, '.claude', 'projects', 'p', `${sid}.jsonl`), transcript.map(l => JSON.stringify(l)).join('\n') + '\n');
    const result = JSON.stringify({ type: 'result', subtype: 'success', is_error: false, session_id: sid, total_cost_usd: cliUsd,
        num_turns: 3, usage: { input_tokens: 200000, output_tokens: 20000 }, modelUsage: {}, result: 'ok' });
    fs.appendFileSync(log, `2026-11-18T10:00:02.000Z [claude] ${result}\n`);
    watcher.finishCostRun(id, sid, run.started_at_ms + 10, { exitCode: 0 });
    return JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'));
}

// Run como o dashboard entrega ao weekly: o cost_tracking passa pela projeção pública do servidor
// (dashboard/server.js → projectCostTracking), como na API, antes do buildReport.
const asRun = (id, state) => ({ taskId: `${id}-x`, ticketId: id, updatedAt: '2026-11-18T10:00:03.000Z', kind: 'completed',
    status: 'committed', location: 'main', ticket: { tracker: 'Defeito' },
    state: { ...state, cost_tracking: projectCostTracking(state.cost_tracking) } });
const env = {
    nodes: [['plan', 'Plano']], isDone: r => r.kind === 'completed', needsYou: () => false, prsOf: () => [], prState: () => '',
    prUpdatedOn: () => null, ticketStatus: () => undefined, ticketLabel: r => `#${r.ticketId}`, titleText: r => `Ticket ${r.ticketId}`,
    statusLabel: r => r.status,
};
const line = (t, label) => (t.split('\n').find(l => l.startsWith(`${label}: `)) || '').slice(label.length + 2);

test('flag ligada: o custo do JSON da CLI chega ao weekly, com versão da CLI e hash do prompt', () => {
    const state = dispatch(93901, 'e2e-on', 'on', { cliUsd: 1.23, version: '2.5.1' });
    const ct = state.cost_tracking;
    const transcriptUsd = ct.totals.cost_usd;
    assert.ok(transcriptUsd > 0 && transcriptUsd !== 1.23, 'transcript precificado e diferente do JSON da CLI');
    assert.strictEqual(ct.totals.cli_cost_usd, 1.23);

    const M = W.buildReport([asRun(93901, state)], env, { win: 'all', now: Date.parse('2026-11-18T12:00:00Z') });
    assert.strictEqual(M.cur.cost, 1.23, 'o USD do run vem do JSON da CLI, não do transcript');
    assert.deepStrictEqual({ ...M.costSource, diff: Math.round(M.costSource.diff * 1e6) / 1e6 },
        { cli: 1, transcript: 0, none: 0, both: 1, diff: Math.round((1.23 - transcriptUsd) * 1e6) / 1e6 });
    assert.deepStrictEqual(M.config, { versions: ['2.5.1'], versionsUnknown: 0, hashes: [PLAN_HASH.slice(0, 8)], hashesUnknown: 0 });

    const t = W.copyText(M, '');
    assert.match(line(t, 'Fonte do custo'), /^JSON da CLI em 1 run, transcript em 0 runs; diferença CLI − transcript [+−]US\$ [\d.,]+ em 1 run com as duas fontes\.$/);
    assert.strictEqual(line(t, 'Versão da CLI (observada nos runs da janela)'), '2.5.1.');
    assert.strictEqual(line(t, 'Hash dos prompts (observado nos runs da janela)'), `${PLAN_HASH.slice(0, 8)}.`);
});

test('flag desligada: nada da CLI é gravado e o weekly segue no transcript, como antes da F1.5', () => {
    const state = dispatch(93902, 'e2e-off', undefined, { cliUsd: 1.23 });
    assert.doesNotMatch(JSON.stringify(state.cost_tracking), CLI_KEYS);
    const transcriptUsd = state.cost_tracking.totals.cost_usd;
    assert.ok(transcriptUsd > 0);

    const M = W.buildReport([asRun(93902, state)], env, { win: 'all', now: Date.parse('2026-11-18T12:00:00Z') });
    assert.strictEqual(M.cur.cost, Math.round(transcriptUsd * 100) / 100, 'o USD do run é o do transcript');
    assert.deepStrictEqual(M.costSource, { cli: 0, transcript: 1, none: 0, both: 0, diff: null });
    assert.deepStrictEqual(M.config, { versions: [], versionsUnknown: 1, hashes: [], hashesUnknown: 1 });

    const t = W.copyText(M, '');
    assert.strictEqual(line(t, 'Fonte do custo'), 'JSON da CLI em 0 runs, transcript em 1 run; diferença CLI − transcript desconhecida (nenhum run com as duas fontes).');
    assert.strictEqual(line(t, 'Versão da CLI (observada nos runs da janela)'), 'desconhecido.');
    assert.strictEqual(line(t, 'Hash dos prompts (observado nos runs da janela)'), 'desconhecido.');
});
