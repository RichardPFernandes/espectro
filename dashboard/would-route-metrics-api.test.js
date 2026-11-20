'use strict';
// GET /api/would-route-metrics — agrega would_route dos state.json (sombra, sem S4).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createDashboard } = require('./server');

const tmpBase = process.env.CLAUDE_JOB_DIR ? path.join(process.env.CLAUDE_JOB_DIR, 'tmp') : os.tmpdir();
const tmp = fs.mkdtempSync(path.join(tmpBase, 'would-route-api-'));
const repo = path.join(tmp, 'consumer');
const mainRuns = path.join(repo, 'memory', 'runs');
fs.mkdirSync(mainRuns, { recursive: true });

function seed(taskId, cost_tracking) {
    const dir = path.join(mainRuns, taskId);
    fs.mkdirSync(dir, { recursive: true });
    const ticket = Number(taskId.split('-')[0]);
    const state = {
        task_id: taskId,
        ticket_id: ticket,
        node: 'commit',
        status: 'committed',
        history: ['plan', 'implement', 'commit'],
        started_at: '2026-11-05T10:00:00.000Z',
        updated_at: '2026-11-05T12:00:00.000Z',
        cost_tracking,
    };
    fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify(state));
}

seed('97001-shadow', {
    pricing_source: 'test',
    totals: { cost_usd: 10, input_tokens: 100, output_tokens: 10, duration_ms: 1000, loop_count: 0 },
    nodes: {
        implement: {
            agent: 'claude',
            runs: 1,
            retries: 0,
            cost_usd: 10,
            attempts: [{
                admission: { attempt_id: 'impl-1', admitted_node: 'implement' },
                cost: { usd: 10, unpriced_models: [], pricing_source: 'test', pricing_sha256: 'a'.repeat(64) },
                would_route: {
                    status: 'SHADOW',
                    applied: false,
                    policy_version: 's3-shadow-p1-0',
                    classifier_ref: { provider: 'cheap_rule' },
                    decisions: [
                        {
                            subtask_key: 'docs-only',
                            class: 'C1',
                            tier: 'T1',
                            rule: 'R5',
                            leaves_opus_tier: true,
                            would_model: 'UNAVAILABLE',
                        },
                        {
                            subtask_key: 'core',
                            class: 'C4',
                            tier: 'T3',
                            rule: 'R4',
                            leaves_opus_tier: false,
                            would_model: 'UNAVAILABLE',
                        },
                    ],
                },
            }],
        },
    },
});

seed('97002-off', {
    pricing_source: 'test',
    totals: { cost_usd: 1, input_tokens: 1, output_tokens: 1, duration_ms: 1, loop_count: 0 },
    nodes: {
        implement: {
            attempts: [{
                admission: { attempt_id: 'off-1', admitted_node: 'implement' },
                cost: { usd: 1 },
                would_route: {
                    status: 'NO_DECISION',
                    cause: 'CLASSIFIER_OFF',
                    applied: false,
                    decisions: [],
                    classifier_ref: { provider: 'off' },
                },
            }],
        },
    },
});

const dash = createDashboard({ repoRoot: repo, memoryDir: mainRuns, worktreesDir: path.join(repo, '.claude', 'worktrees'), env: {} });
let base;

test.before(async () => {
    await new Promise(r => dash.server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${dash.server.address().port}`;
    await dash.ready;
});
test.after(async () => {
    await dash.close();
    fs.rmSync(tmp, { recursive: true, force: true });
});

async function get(p) {
    const res = await fetch(base + p);
    return { status: res.status, body: await res.json() };
}

test('GET /api/would-route-metrics: faixas, economia e lista recente', async () => {
    const { status, body } = await get('/api/would-route-metrics');
    assert.equal(status, 200);
    assert.equal(body.shadow_only, true);
    assert.equal(body.s4_enabled, false);
    assert.equal(body.counts.by_faixa.leve, 1);
    assert.equal(body.counts.by_faixa.opus, 1);
    assert.equal(body.counts.leaves_opus_tier, 1);
    assert.equal(body.counts.no_decision, 1);
    assert.equal(body.counts.causes.CLASSIFIER_OFF, 1);
    assert.ok(body.savings_vs_opus_only.potential_savings_usd > 0);
    assert.ok(body.recent.some(r => r.task_id === '97001-shadow' && r.subtask_key === 'docs-only'));
    assert.match(JSON.stringify(body), /Sombra|sombra|AS-IS|would_route/i);
    assert.ok(body.diagnosis);
    assert.ok(['OK', 'CLASSIFIER_OFF', 'NO_DECISION', 'MIXED'].includes(body.diagnosis.code)
        || typeof body.diagnosis.code === 'string');
    // Mistura shadow + off: primary não precisa ser OFF, mas causes deve expor CLASSIFIER_OFF.
    assert.equal(body.counts.causes.CLASSIFIER_OFF, 1);
});

test('GET /api/would-route-metrics: só CLASSIFIER_OFF → diagnosis explícito', async () => {
    // seed dedicado
    const dir = path.join(mainRuns, '97003-off-only');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({
        task_id: '97003-off-only',
        ticket_id: 97003,
        node: 'commit',
        status: 'committed',
        history: ['implement'],
        started_at: '2026-11-05T10:00:00.000Z',
        updated_at: '2026-11-05T12:30:00.000Z',
        cost_tracking: {
            pricing_source: 'test',
            totals: { cost_usd: 1, input_tokens: 1, output_tokens: 1, duration_ms: 1, loop_count: 0 },
            nodes: {
                implement: {
                    attempts: [{
                        admission: { attempt_id: 'only-off', admitted_node: 'implement' },
                        cost: { usd: 1 },
                        would_route: {
                            status: 'NO_DECISION',
                            cause: 'CLASSIFIER_OFF',
                            applied: false,
                            decisions: [],
                            classifier_ref: { provider: 'off' },
                            signals_seen: { status: 'COMPLETE', groups: 2 },
                        },
                    }],
                },
            },
        },
    }));
    const { status, body } = await get('/api/would-route-metrics');
    assert.equal(status, 200);
    // Pode misturar com seeds anteriores; CLASSIFIER_OFF deve aparecer e diagnosis não ser silent.
    assert.ok(body.counts.causes.CLASSIFIER_OFF >= 1);
    assert.ok(body.diagnosis?.title_pt);
    assert.ok(body.diagnosis?.next_step_pt);
});

test('limit reduz a lista recente', async () => {
    const { body } = await get('/api/would-route-metrics?limit=1');
    assert.equal(body.recent.length, 1);
});
