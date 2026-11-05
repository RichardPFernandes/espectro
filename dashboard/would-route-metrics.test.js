'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
    collectFromCostTracking,
    buildWouldRouteMetrics,
    COST_RATIO_VS_OPUS,
} = require('./would-route-metrics');

function attempt({ id, cost, would_route, started_at = '2026-11-05T12:00:00.000Z' }) {
    return {
        admission: { attempt_id: id, admitted_node: 'implement' },
        cost: { usd: cost },
        started_at,
        would_route,
    };
}

function shadowDecision(overrides = {}) {
    return {
        subtask_key: 'step-1',
        class: 'C1',
        tier: 'T1',
        rule: 'R5',
        leaves_opus_tier: true,
        would_model: 'UNAVAILABLE',
        ...overrides,
    };
}

test('collectFromCostTracking ignora UNAVAILABLE e sem would_route', () => {
    const rows = collectFromCostTracking({
        nodes: {
            implement: {
                attempts: [
                    attempt({ id: 'a', cost: 1, would_route: 'UNAVAILABLE' }),
                    attempt({ id: 'b', cost: 1, would_route: null }),
                ],
            },
        },
    }, { taskId: '1-x' });
    assert.equal(rows.length, 0);
});

test('contagem por faixa leve/médio/Opus e leaves_opus', () => {
    const ct = {
        totals: {},
        nodes: {
            implement: {
                attempts: [
                    attempt({
                        id: 'a1',
                        cost: 10,
                        would_route: {
                            status: 'SHADOW',
                            applied: false,
                            classifier_ref: { provider: 'cheap_rule' },
                            decisions: [
                                shadowDecision({ subtask_key: 'docs', class: 'C1', tier: 'T1', rule: 'R5' }),
                                shadowDecision({ subtask_key: 'test', class: 'C2', tier: 'T2', rule: 'R6', leaves_opus_tier: true }),
                                shadowDecision({
                                    subtask_key: 'core', class: 'C4', tier: 'T3', rule: 'R4', leaves_opus_tier: false,
                                }),
                            ],
                        },
                    }),
                ],
            },
        },
    };
    const agg = buildWouldRouteMetrics([{ taskId: '100-a', ticketId: 100, cost_tracking: ct }]);
    assert.equal(agg.shadow_only, true);
    assert.equal(agg.s4_enabled, false);
    assert.equal(agg.counts.decisions, 3);
    assert.equal(agg.counts.by_faixa.leve, 1);
    assert.equal(agg.counts.by_faixa.medio, 1);
    assert.equal(agg.counts.by_faixa.opus, 1);
    assert.equal(agg.counts.leaves_opus_tier, 2);
    assert.equal(agg.counts.stays_opus_tier, 1);
    assert.equal(agg.recent.length, 3);
});

test('economia potencial vs Opus-only usa razões de preço; null sem custo', () => {
    const withCost = {
        totals: {},
        nodes: {
            implement: {
                attempts: [
                    attempt({
                        id: 'priced',
                        cost: 10,
                        would_route: {
                            status: 'SHADOW',
                            applied: false,
                            classifier_ref: { provider: 'cheap_rule' },
                            decisions: [
                                shadowDecision({ tier: 'T1' }), // share 5, save 5*(1-0.2)=4
                                shadowDecision({ tier: 'T2', class: 'C2', rule: 'R6' }), // share 5, save 5*0.4=2
                            ],
                        },
                    }),
                ],
            },
        },
    };
    const priced = buildWouldRouteMetrics([{ taskId: 't', cost_tracking: withCost }]);
    assert.equal(priced.savings_vs_opus_only.opus_only_usd, 10);
    const expectedSave = 5 * (1 - COST_RATIO_VS_OPUS.T1) + 5 * (1 - COST_RATIO_VS_OPUS.T2);
    assert.equal(priced.savings_vs_opus_only.potential_savings_usd, expectedSave);
    assert.equal(priced.savings_vs_opus_only.potential_usd, 10 - expectedSave);

    const noCost = buildWouldRouteMetrics([{
        taskId: 'u',
        cost_tracking: {
            nodes: {
                implement: {
                    attempts: [
                        attempt({
                            id: 'x',
                            cost: null,
                            would_route: {
                                status: 'SHADOW',
                                applied: false,
                                decisions: [shadowDecision()],
                            },
                        }),
                    ],
                },
            },
        },
    }]);
    assert.equal(noCost.savings_vs_opus_only.potential_savings_usd, null);
    assert.match(noCost.savings_vs_opus_only.unknown_when, /Sem custo/);
});

test('classificador off → no_decision; applied=true conta anomalia', () => {
    const ct = {
        nodes: {
            implement: {
                attempts: [
                    attempt({
                        id: 'off',
                        cost: 1,
                        would_route: {
                            status: 'NO_DECISION',
                            cause: 'CLASSIFIER_OFF',
                            applied: false,
                            decisions: [],
                            classifier_ref: { provider: 'off' },
                        },
                    }),
                    attempt({
                        id: 'bad',
                        cost: 1,
                        would_route: {
                            status: 'SHADOW',
                            applied: true,
                            decisions: [shadowDecision()],
                            classifier_ref: { provider: 'cheap_rule' },
                        },
                    }),
                ],
            },
        },
    };
    const agg = buildWouldRouteMetrics([{ taskId: 'z', cost_tracking: ct }]);
    assert.equal(agg.counts.no_decision, 1);
    assert.equal(agg.counts.causes.CLASSIFIER_OFF, 1);
    assert.equal(agg.counts.applied_true_anomaly, 1);
    assert.equal(agg.counts.decisions, 1);
});
