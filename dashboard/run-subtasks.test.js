'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { subtasksOfCostTracking } = require('./run-subtasks');
const { projectCostTracking } = require('./cost-projection');
const UI = require('./public/run-subtasks');

test('subtasksOfCostTracking: decisões would_route por faixa', () => {
    const ct = {
        totals: { cost_usd: 1 },
        nodes: {
            implement: {
                attempts: [{
                    admission: { attempt_id: 'a1', admitted_node: 'implement' },
                    would_route: {
                        status: 'SHADOW',
                        applied: false,
                        classifier_ref: { provider: 'cheap_rule' },
                        decisions: [
                            { subtask_key: 'abcdef012345/0-0', class: 'C1', tier: 'T1', rule: 'R5', leaves_opus_tier: true, steps: [0] },
                            { subtask_key: 'abcdef012345/1-2', class: 'C4', tier: 'T3', rule: 'R4', leaves_opus_tier: false, steps: [1, 2] },
                        ],
                    },
                }],
            },
        },
    };
    const { rows, summary } = subtasksOfCostTracking(ct);
    assert.equal(summary.count, 2);
    assert.equal(summary.leaves_opus_tier, 1);
    assert.equal(summary.by_faixa.leve, 1);
    assert.equal(summary.by_faixa.opus, 1);
    assert.equal(rows[0].source, 'would_route');
    assert.equal(UI.chipHtml(ct).includes('2 subtarefas'), true);
    assert.match(UI.foldHtml(ct, { nodeLabels: { implement: 'Implementar' } }), /abcdef012345\/0-0/);
});

test('classificador off: mostra grupos signals sem faixa', () => {
    const ct = {
        totals: {},
        nodes: {
            implement: {
                attempts: [{
                    admission: { attempt_id: 'off', admitted_node: 'implement' },
                    signals: {
                        status: 'COMPLETE',
                        groups: [{
                            subtask_key: 'planver012345/0-1',
                            steps: [0, 1],
                            signals: { kind: 'docs', n_files: 1 },
                        }],
                    },
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
    };
    const { rows, summary } = subtasksOfCostTracking(ct);
    assert.equal(summary.count, 1);
    assert.equal(summary.no_decision, 1);
    assert.equal(rows[0].source, 'signals');
    assert.equal(rows[0].kind, 'docs');
    assert.equal(rows[0].faixa, null);
    assert.match(UI.foldHtml(ct), /sem decisão|planver012345/);
});

test('projectCostTracking preserva would_route/signals públicos e bloqueia paths privados', () => {
    const raw = {
        pricing_source: 'Anthropic test',
        totals: { cost_usd: 1, input_tokens: 1, output_tokens: 1, duration_ms: 1, loop_count: 0 },
        nodes: {
            implement: {
                agent: 'claude',
                attempts: [{
                    admission: {
                        attempt_id: 'x',
                        admitted_node: 'implement',
                        attempt_ref: { runs_root: 'main/memory/runs', path: 'x/dom06/attempts/x.json' },
                    },
                    account: { label: 'team' },
                    cost: { usd: 1, unpriced_models: [], pricing_source: 'Anthropic test', pricing_sha256: 'a'.repeat(64) },
                    observed: { usage: [], effort: 'UNKNOWN' },
                    role_attribution: { status: 'COMPLETE', conflicted_messages: 0 },
                    requested: { model: 'UNAVAILABLE', effort: 'UNAVAILABLE' },
                    routing_decision: 'UNAVAILABLE',
                    selection_source: 'DEFAULT_INHERITED',
                    cause: 'dispatch',
                    result: 'COMPLETED',
                    read_order: [{ file: '/private/secret.jsonl' }],
                    signals: {
                        status: 'COMPLETE',
                        groups: [{
                            subtask_key: 'abc123def456/0-0',
                            steps: [0],
                            signals: {
                                kind: 'docs',
                                n_files: 1,
                                paths_decl: ['docs/a.md', '/private/secret', 'ok/path.js'],
                            },
                        }],
                    },
                    would_route: {
                        status: 'SHADOW',
                        applied: false,
                        classifier_ref: { provider: 'cheap_rule' },
                        decisions: [{
                            subtask_key: 'abc123def456/0-0',
                            class: 'C1',
                            tier: 'T1',
                            rule: 'R5',
                            leaves_opus_tier: true,
                            steps: [0],
                            would_model: 'UNAVAILABLE',
                        }],
                    },
                }],
            },
        },
    };
    const projected = projectCostTracking(raw, {});
    const a = projected.nodes.implement.attempts[0];
    assert.equal(a.would_route.status, 'SHADOW');
    assert.equal(a.would_route.decisions[0].subtask_key, 'abc123def456/0-0');
    assert.equal(a.would_route.applied, false);
    assert.deepEqual(a.signals.groups[0].signals.paths_decl, ['docs/a.md', 'ok/path.js']);
    const serialized = JSON.stringify(projected);
    assert.ok(!serialized.includes('/private/'));
    assert.ok(!serialized.includes('read_order'));
    const { summary } = subtasksOfCostTracking(projected);
    assert.equal(summary.count, 1);
    assert.equal(summary.leaves_opus_tier, 1);
});

test('sem cost_tracking → vazio', () => {
    assert.equal(subtasksOfCostTracking(null).summary.count, 0);
    assert.equal(UI.chipHtml(null), '');
    assert.equal(UI.foldHtml(null), '');
});
