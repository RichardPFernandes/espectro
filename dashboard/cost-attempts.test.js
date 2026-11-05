'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { WebSocket } = require('ws');
const cost = require('../scripts/lib/cost-tracking');
const { projectCostTracking } = require('./cost-projection');
const UI = require('./public/cost-attempts');
const { createDashboard } = require('./server');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cost-attempts-'));
const repo = path.join(tmp, 'consumer');
const mainRuns = path.join(repo, 'memory', 'runs');
const worktreesDir = path.join(repo, '.claude', 'worktrees');
fs.mkdirSync(mainRuns, { recursive: true });
const clone = value => JSON.parse(JSON.stringify(value));
const line = (messageId, model, usage) => JSON.stringify({ type: 'assistant', message: { id: messageId, model, usage } });
const main = line('a', 'claude-sonnet-5-5', {
    input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 30, cache_creation_input_tokens: 90,
    cache_creation: { ephemeral_5m_input_tokens: 40, ephemeral_1h_input_tokens: 50 },
});
const sub = line('b', 'claude-haiku-4-5', { input_tokens: 10, output_tokens: 1, speed: 'fast' });
const metrics = cost.sumClaudeUsage([{ role: 'main', content: main }, { role: 'subagent', content: sub }]);
assert.equal(metrics.cost_usd, 0.000733);
const started = '2026-10-20T12:00:00.000Z';

function add(ct, node, id, cause = 'dispatch', agent = 'claude', m = metrics, taskId = '96002-multi') {
    return cost.mergeRun(ct, { node, agent, metrics: m, alsoCovers: node === 'plan' ? ['fetch_ticket'] : [],
        run: { admission: { attempt_id: id, admitted_node: node === 'plan' ? 'fetch_ticket' : node,
            attempt_ref: { runs_root: `worktree:${taskId.split('-')[0]}/memory/runs`,
                path: `${node === 'plan' ? '_dom06' : taskId}/dom06/attempts/${id}.json` } },
        cause, account: { source: 'dashboard', label: 'team' } }, outcome: { exitCode: 0, attemptResult: 'COMPLETED' } });
}

function seed(taskId, ct, worktree = false) {
    const root = worktree ? path.join(worktreesDir, taskId.split('-')[0], 'memory', 'runs') : mainRuns;
    const dir = path.join(root, taskId);
    fs.mkdirSync(dir, { recursive: true });
    const state = { task_id: taskId, ticket_id: Number(taskId.split('-')[0]), node: 'commit', status: 'committed',
        history: ['plan', 'implement', 'commit'], started_at: started, updated_at: started, cost_tracking: ct };
    fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify(state));
    for (const node of Object.values(ct.nodes)) for (const a of node.attempts || []) {
        const file = path.join(root, a.admission.attempt_ref.path);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, JSON.stringify({ attempt_id: a.admission.attempt_id, node: a.admission.admitted_node,
            started: true, admitted_at: started, transcript: 'DO-NOT-EXPOSE-ATTEMPT-CONTENT' }));
    }
    return { root, dir, state };
}

const legacy = { pricing_source: 'Anthropic legacy', nodes: { plan: { agent: 'claude', runs: 1, retries: 0,
    input_tokens: 123, output_tokens: 4, duration_ms: 1000, cost_usd: 0.004321 } },
totals: { input_tokens: 123, output_tokens: 4, duration_ms: 1000, cost_usd: 0.004321, loop_count: 0 } };
seed('96001-legacy', legacy);
let multi = add(null, 'plan', 'initial-a');
multi = add(multi, 'implement', 'common-a');
multi = add(multi, 'implement', 'retry-b', 'retry');
multi = add(multi, 'commit', 'commit-a');
// Synthetic extra fields must not travel with the public cost subtree.
multi.nodes.plan.attempts[0].read_order = [{ role: 'main', file: '/private/transcript.jsonl' }];
multi.nodes.plan.attempts[0].transcript = 'DO-NOT-EXPOSE-TRANSCRIPT';
// Subtarefas sombra (PRI-223): viajam no read model público sem paths privados.
multi.nodes.implement.attempts[0].signals = {
    status: 'COMPLETE',
    groups: [{
        subtask_key: 'planhash00001/0-0',
        steps: [0],
        signals: { kind: 'docs', n_files: 1, paths_decl: ['README.md', '/private/nope'] },
    }],
};
multi.nodes.implement.attempts[0].would_route = {
    status: 'SHADOW',
    applied: false,
    classifier_ref: { provider: 'cheap_rule' },
    decisions: [{
        subtask_key: 'planhash00001/0-0',
        class: 'C1',
        tier: 'T1',
        rule: 'R5',
        leaves_opus_tier: true,
        steps: [0],
        would_model: 'UNAVAILABLE',
    }],
};
const multiSeed = seed('96002-multi', multi, true);
const unknownMetrics = cost.sumClaudeUsage([{ role: 'main', content: main + '\n' + line('unknown', 'future-model', { input_tokens: 12, output_tokens: 3 }) }]);
seed('96003-unpriced', add(null, 'review', 'unpriced-a', 'dispatch', 'claude', unknownMetrics, '96003-unpriced'));
seed('96004-codex', add(null, 'test', 'codex-a', 'dispatch', 'codex', { input_tokens: 200, output_tokens: 9, cost_usd: null }, '96004-codex'));
const oldHash = add(null, 'review', 'old-hash', 'dispatch', 'claude', metrics, '96005-hash');
oldHash.nodes.review.attempts[0].cost.pricing_sha256 = 'f'.repeat(64);
for (const u of oldHash.nodes.review.attempts[0].observed.usage) u.pricing_sha256 = 'f'.repeat(64);
seed('96005-hash', oldHash);
const duplicate = line('same-id', 'claude-sonnet-5-5', { input_tokens: 100, output_tokens: 1 });
const conflictMetrics = cost.sumClaudeUsage([{ role: 'main', content: duplicate }, { role: 'subagent', content: duplicate }]);
seed('96006-conflict', add(null, 'review', 'conflict-a', 'dispatch', 'claude', conflictMetrics, '96006-conflict'));
const partial = add(clone(legacy), 'plan', 'new-a', 'dispatch', 'claude', metrics, '96007-partial');
seed('96007-partial', partial);

const dash = createDashboard({ repoRoot: repo, memoryDir: mainRuns, worktreesDir, env: {} });
let base;
test.before(async () => {
    await new Promise(resolve => dash.server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${dash.server.address().port}`;
    await dash.ready;
});
test.after(async () => { await dash.close(); fs.rmSync(tmp, { recursive: true, force: true }); });
async function get(taskId) {
    const response = await fetch(`${base}/api/runs/${taskId}`);
    assert.equal(response.status, 200);
    return response.json();
}

test('API: legacy aggregates are preserved, without fabricated Attempts', async () => {
    const r = await get('96001-legacy');
    assert.deepEqual(r.state.cost_tracking.totals, legacy.totals);
    assert.equal(r.state.cost_tracking.nodes.plan.cost_usd, 0.004321);
    assert.equal(r.state.cost_tracking.nodes.plan.attempts, undefined);
    assert.equal(UI.render(r.state.cost_tracking), '');
});

test('API: all admission paths, retry cause, model/role/TTL/fast and recorded totals', async () => {
    const before = fs.readFileSync(path.join(multiSeed.dir, 'state.json'), 'utf8');
    const r = await get('96002-multi');
    const c = r.state.cost_tracking;
    assert.deepEqual(c.totals, multi.totals);
    assert.equal(c.totals.cost_usd, 0.002932);
    for (const [node, n] of Object.entries(c.nodes)) {
        assert.equal(n.cost_usd, multi.nodes[node].cost_usd);
        for (const a of n.attempts) {
            assert.equal(a.started_at, started);
            assert.equal(a.result, 'COMPLETED');
            const rows = a.observed.usage;
            assert.deepEqual(rows.map(u => [u.model, u.role, u.speed]), [
                ['claude-sonnet-5-5', 'main', 'standard'], ['claude-haiku-4-5', 'subagent', 'fast'],
            ]);
            assert.ok(Math.abs(rows.reduce((sum, u) => sum + u.cost_usd, 0) - a.cost.usd) <= 0.000000500001);
            assert.deepEqual(['input_tokens', 'cache_read_tokens', 'cache_write_5m_tokens', 'cache_write_1h_tokens'].map(k => rows[0][k]), [100, 30, 40, 50]);
            assert.equal(rows[1].cost_usd, 0.00003);
            assert.equal(a.requested.model, 'UNAVAILABLE');
            assert.equal(a.routing_decision, 'UNAVAILABLE');
        }
    }
    assert.equal(c.nodes.implement.attempts[1].cause, 'retry');
    const wr = c.nodes.implement.attempts[0].would_route;
    assert.equal(wr.status, 'SHADOW');
    assert.equal(wr.applied, false);
    assert.equal(wr.decisions[0].subtask_key, 'planhash00001/0-0');
    assert.equal(wr.decisions[0].leaves_opus_tier, true);
    assert.deepEqual(c.nodes.implement.attempts[0].signals.groups[0].signals.paths_decl, ['README.md']);
    assert.equal(fs.readFileSync(path.join(multiSeed.dir, 'state.json'), 'utf8'), before, 'reads never write authoritative state');
});

test('API: unpriced model preserves null; Codex keeps null counters and UNKNOWN model', async () => {
    const unknown = (await get('96003-unpriced')).state.cost_tracking.nodes.review.attempts[0];
    assert.equal(unknown.cost.usd, null);
    assert.deepEqual(unknown.cost.unpriced_models, ['future-model']);
    assert.equal(unknown.observed.usage.find(u => u.model === 'future-model').cost_usd, null);
    const codex = (await get('96004-codex')).state.cost_tracking.nodes.test.attempts[0];
    const u = codex.observed.usage[0];
    assert.equal(u.model, 'UNKNOWN');
    assert.equal(u.input_tokens, 200);
    assert.equal(u.cache_read_tokens, null);
    assert.equal(u.messages, null);
    assert.equal(u.cost_usd, null);
    assert.equal(codex.cost.usd, null);
});

test('API: table hash mismatch never reprices history or changes stored cost', async () => {
    const c = (await get('96005-hash')).state.cost_tracking;
    assert.equal(c.nodes.review.cost_usd, 0.000733);
    const a = c.nodes.review.attempts[0];
    assert.equal(a.cost.usd, 0.000733);
    assert.ok(a.observed.usage.every(u => u.cost_usd === null && u.cost_status === 'PRICING_UNAVAILABLE'));
});

test('API: dedup conflicts retain partial role attribution; mixed legacy/new does not replace totals', async () => {
    const c = (await get('96006-conflict')).state.cost_tracking;
    const a = c.nodes.review.attempts[0];
    assert.equal(a.role_attribution.status, 'PARTIAL');
    assert.equal(a.role_attribution.conflicted_messages, 1);
    assert.equal(a.observed.usage[0].role_provenance, 'CONFLICTED');
    const mixed = (await get('96007-partial')).state.cost_tracking;
    assert.equal(mixed.nodes.plan.attempts.length, 1);
    assert.equal(mixed.nodes.plan.runs, 2);
    assert.equal(mixed.totals.cost_usd, 0.005054);
});

test('API and WebSocket: only public cost fields, no paths or transcript content', async () => {
    const assertPublic = c => {
        const serialized = JSON.stringify(c);
        for (const forbidden of ['attempt_ref', 'read_order', 'session_id', 'transcript', 'DO-NOT-EXPOSE', '/dom06/', '/private/']) assert.ok(!serialized.includes(forbidden), forbidden);
        assert.deepEqual(c.nodes.plan.attempts[0].account, { label: 'team' });
        assert.match(c.nodes.plan.attempts[0].cost.pricing_source, /captura 2026-10-20/);
        assert.equal(c.nodes.plan.attempts[0].cost.pricing_sha256, cost.PRICING_SHA256);
    };
    assertPublic((await get('96002-multi')).state.cost_tracking);
    const socket = new WebSocket(base.replace('http:', 'ws:'));
    try {
        const hello = await new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('WebSocket hello timeout')), 4000);
            socket.once('error', error => { clearTimeout(timer); reject(error); });
            socket.once('message', bytes => { clearTimeout(timer); resolve(JSON.parse(bytes)); });
        });
        assertPublic(hello.runs.find(r => r.taskId === '96002-multi').state.cost_tracking);
        const update = new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('WebSocket state_update timeout')), 4000);
            socket.on('message', bytes => { const msg = JSON.parse(bytes); if (msg.type === 'state_update' && msg.taskId === '96002-multi') { clearTimeout(timer); resolve(msg); } });
        });
        fs.writeFileSync(path.join(multiSeed.dir, 'state.json'), JSON.stringify({ ...multiSeed.state, updated_at: '2026-10-20T12:01:00.000Z' }));
        const message = await update;
        assertPublic(message.state.cost_tracking);
        assertPublic(message.run.state.cost_tracking);
    } finally { socket.terminate(); }
});

test('projection: exact source only; missing, mismatched, traversal and symlink start stays UNKNOWN', () => {
    const context = { run: { taskId: '96002-multi', root: { dir: multiSeed.root, label: 'worktree:96002' } }, ticketId: 96002 };
    const start = c => projectCostTracking(c, context).nodes.plan.attempts[0].started_at;
    assert.equal(start(multi), started);
    for (const mutate of [
        a => { a.admission.attempt_ref.runs_root = 'worktree:96003/memory/runs'; },
        a => { a.admission.attempt_ref.path = '../secret.json'; },
        a => { a.admission.attempt_ref.path = '/etc/passwd'; },
        a => { a.admission.attempt_id = 'missing'; a.admission.attempt_ref.path = '_dom06/dom06/attempts/missing.json'; },
        a => { a.admission.admitted_node = 'commit'; },
    ]) {
        const c = clone(multi); mutate(c.nodes.plan.attempts[0]); assert.equal(start(c), 'UNKNOWN');
    }
    assert.equal(projectCostTracking(multi, { ...context, run: { ...context.run, root: { ...context.run.root, label: 'main' } } }).nodes.plan.attempts[0].started_at, 'UNKNOWN');
    const file = path.join(multiSeed.root, '_dom06/dom06/attempts/initial-a.json');
    const saved = fs.readFileSync(file);
    const outside = path.join(tmp, 'outside-attempt.json');
    fs.writeFileSync(outside, saved);
    fs.unlinkSync(file); fs.symlinkSync(outside, file);
    try { assert.equal(start(multi), 'UNKNOWN'); } finally { fs.unlinkSync(file); fs.writeFileSync(file, saved); }
});

test('projection: rejects filesystem labels and unrecognized payloads without mutation', () => {
    const c = clone(multi);
    const a = c.nodes.plan.attempts[0];
    a.account.label = '/Users/private/account';
    a.requested.model = '/private/model';
    a.cost.pricing_source = '/private/prices.json';
    a.observed.usage[0].content = 'DO-NOT-EXPOSE';
    a.observed.usage[0].cache_read_tokens = null;
    const before = JSON.stringify(c);
    const projected = projectCostTracking(c);
    assert.equal(JSON.stringify(c), before);
    const publicAttempt = projected.nodes.plan.attempts[0];
    assert.equal(publicAttempt.account.label, 'UNKNOWN');
    assert.equal(publicAttempt.requested.model, 'UNKNOWN');
    assert.equal(publicAttempt.cost.pricing_source, 'UNKNOWN');
    assert.equal(publicAttempt.observed.usage[0].cost_usd, null);
    assert.ok(!JSON.stringify(projected).includes('DO-NOT-EXPOSE'));
});

test('projection: UNKNOWN speed never inherits the standard-mode price', () => {
    const c = clone(multi);
    c.nodes.plan.attempts[0].observed.usage[0].speed = 'UNKNOWN';
    const projected = projectCostTracking(c);
    const row = projected.nodes.plan.attempts[0].observed.usage[0];
    assert.equal(row.cost_usd, null);
    assert.equal(row.cost_status, 'DIMENSION_NOT_OBSERVED');
    assert.equal(projected.nodes.plan.attempts[0].cost.usd, metrics.cost_usd, 'recorded cost remains authoritative');
    assert.match(UI.render(projected), /sem preço<br><small>modo não observado/);
});

test('render: multimodel, unknowns, provenance, cache and unpriced/null counters', async () => {
    const html = UI.render((await get('96002-multi')).state.cost_tracking, { plan: 'Plano' });
    for (const text of ['Attempts por nó', 'initial-a', 'retry-b', started, 'COMPLETED', 'principal', 'subagente', 'fast', 'Cache read', 'Cache write 5 min', 'Cache write 1 h', 'TTL não observado', 'UNAVAILABLE', cost.PRICING_SHA256, '2026-10-20']) assert.ok(html.includes(text), text);
    const unknown = UI.render((await get('96003-unpriced')).state.cost_tracking);
    assert.match(unknown, /Modelos sem preço: future-model/);
    assert.match(unknown, /sem preço/);
    const codex = UI.render((await get('96004-codex')).state.cost_tracking);
    assert.match(codex, /não observado/);
    assert.match(codex, /UNKNOWN/);
    assert.doesNotMatch(codex, /US\$ 0/);
    assert.match(UI.render((await get('96005-hash')).state.cost_tracking), /tabela histórica indisponível/);
    assert.match(UI.render((await get('96006-conflict')).state.cost_tracking), /CONFLICTED \(atribuição parcial\)/);
    assert.match(UI.render((await get('96007-partial')).state.cost_tracking), /Detalhamento disponível para 1 de 2 despachos/);
});

test('render: zero remains observed; HTML is escaped and no actions are introduced', () => {
    assert.equal(UI.money(null), 'sem preço');
    assert.equal(UI.money(0), 'US$ 0,00');
    assert.equal(UI.tokens(null), 'não observado');
    assert.equal(UI.tokens(0), '0');
    assert.equal(UI.money(0.0000005), 'US$ 0,0000005');
    const c = projectCostTracking(multi);
    c.nodes.plan.attempts[0].account.label = '<img src=x onerror=alert(1)>';
    const html = UI.render(c, { plan: '<script>alert(1)</script>' });
    assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
    assert.match(html, /&lt;script&gt;/);
    assert.doesNotMatch(html, /<(script|img|button|form|input)\b|\son\w+="/);
    assert.equal(UI.render({ nodes: { plan: { attempts: [] } } }), '');
});

test('integrated cost fold: old aggregates, exact money and new Attempts without front-end pricing', async () => {
    const source = fs.readFileSync(path.join(__dirname, 'public/index.html'), 'utf8');
    const fold = source.slice(source.indexOf('function costFoldHtml(r)'), source.indexOf('// ---------------------------------------------------------------- Recusas QA'));
    const ctx = vm.createContext({ window: { CostAttempts: UI }, openFolds: new Set(),
        costOf: r => r.state.cost_tracking, esc: s => String(s ?? '').replace(/</g, '&lt;'),
        NODES: [['plan', 'Plano'], ['implement', 'Implementação'], ['commit', 'Commit']], NODE_LABEL: { plan: 'Plano' },
        ICON: { chev: '' }, fx: null, fmtMs: n => `${n ?? 0} ms`, fmtTok: UI.tokens, fmtBrl: () => '', fxNote: () => '' });
    vm.runInContext(fold, ctx);
    const old = ctx.costFoldHtml(await get('96001-legacy'));
    assert.match(old, /US\$ 0,004321/);
    assert.doesNotMatch(old, /Attempts por nó/);
    const r = await get('96002-multi');
    const html = ctx.costFoldHtml(r);
    assert.match(html, /US\$ 0,002932/);
    assert.match(html, /Attempts por nó/);
    assert.ok(source.indexOf('src="cost-attempts.js"') < source.indexOf('function costFoldHtml(r)'));
});
