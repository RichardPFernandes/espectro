'use strict';
// Read model: agrega would_route (PRI-223 S3) dos Attempts em cost_tracking.
// Só leitura — não altera despacho, policy nem argv (S4 fora).
//
// Faixas (policy s3-shadow): T1=leve, T2=médio, T3=Opus.
// Economia potencial vs Opus-only: hipótese documentada com razões de preço
// Haiku/Sonnet vs Opus (input) na tabela scripts/lib/model-pricing.json —
// NÃO é desembolso real nem Authorization para S4.

const TIER_FAIXA = Object.freeze({ T1: 'leve', T2: 'medio', T3: 'opus' });
const FAIXA_LABEL = Object.freeze({ leve: 'leve', medio: 'médio', opus: 'Opus' });
// Razões aproximadas vs Opus (input USD/MTok: Haiku≈1, Sonnet≈3, Opus≈5).
const COST_RATIO_VS_OPUS = Object.freeze({ T1: 0.2, T2: 0.6, T3: 1.0 });
const DEFAULT_RECENT = 40;
const MAX_RECENT = 200;

const id = value => (typeof value === 'string' && value.length > 0 && value.length <= 200 ? value : 'UNKNOWN');
const number = value => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null);

function faixaOf(tier) {
    return TIER_FAIXA[tier] || null;
}

function emptyCounts() {
    return { leve: 0, medio: 0, opus: 0, unknown: 0 };
}

/**
 * Extrai decisões sombra de um cost_tracking bruto (state.json).
 * @param {object|null} costTracking
 * @param {{ taskId?: string, ticketId?: number|null, updatedAt?: string|null }} ctx
 */
function collectFromCostTracking(costTracking, ctx = {}) {
    const out = [];
    if (!costTracking || typeof costTracking !== 'object' || !costTracking.nodes) return out;
    for (const [nodeKey, node] of Object.entries(costTracking.nodes)) {
        if (!node || !Array.isArray(node.attempts)) continue;
        for (const attempt of node.attempts) {
            const wr = attempt?.would_route;
            if (!wr || wr === 'UNAVAILABLE' || typeof wr !== 'object') continue;
            const attemptCost = number(attempt?.cost?.usd);
            const decisions = Array.isArray(wr.decisions) ? wr.decisions : [];
            const share = attemptCost != null && decisions.length > 0
                ? attemptCost / decisions.length
                : null;
            const base = {
                task_id: id(ctx.taskId),
                ticket_id: Number.isFinite(ctx.ticketId) ? ctx.ticketId : null,
                node: id(nodeKey),
                attempt_id: id(attempt?.admission?.attempt_id),
                observed_at: typeof attempt?.started_at === 'string' ? attempt.started_at
                    : (typeof ctx.updatedAt === 'string' ? ctx.updatedAt : null),
                shadow_status: id(wr.status),
                cause: wr.cause == null ? null : id(wr.cause),
                policy_version: wr.policy_version == null ? null : id(String(wr.policy_version)),
                classifier_provider: id(wr.classifier_ref?.provider || 'UNKNOWN'),
                applied: wr.applied === true, // deve permanecer false em S3
                attempt_cost_usd: attemptCost,
            };
            if (!decisions.length) {
                out.push({
                    ...base,
                    kind: 'no_decision',
                    subtask_key: null,
                    class: null,
                    tier: null,
                    faixa: null,
                    rule: null,
                    leaves_opus_tier: false,
                    would_model: null,
                    share_cost_usd: null,
                    potential_cost_usd: null,
                    potential_savings_usd: null,
                });
                continue;
            }
            for (const d of decisions) {
                const tier = id(d.tier);
                const faixa = faixaOf(tier);
                const ratio = COST_RATIO_VS_OPUS[tier];
                const potential = share != null && ratio != null ? share * ratio : null;
                const savings = share != null && potential != null ? share - potential : null;
                out.push({
                    ...base,
                    kind: 'decision',
                    subtask_key: id(d.subtask_key),
                    class: id(d.class),
                    tier,
                    faixa,
                    rule: id(d.rule),
                    leaves_opus_tier: d.leaves_opus_tier === true,
                    would_model: id(d.would_model),
                    share_cost_usd: share,
                    potential_cost_usd: potential,
                    potential_savings_usd: savings,
                });
            }
        }
    }
    return out;
}

/**
 * @param {Array<{ taskId: string, ticketId?: number|null, updatedAt?: string|null, cost_tracking?: object|null }>} runs
 * @param {{ recentLimit?: number }} [opts]
 */
function aggregateWouldRoute(runs, opts = {}) {
    const recentLimit = Math.min(MAX_RECENT, Math.max(1, Number(opts.recentLimit) || DEFAULT_RECENT));
    const rows = [];
    for (const run of runs || []) {
        rows.push(...collectFromCostTracking(run.cost_tracking, {
            taskId: run.taskId,
            ticketId: run.ticketId,
            updatedAt: run.updatedAt,
        }));
    }

    const by_faixa = emptyCounts();
    let decisions = 0;
    let leaves_opus = 0;
    let stays_opus = 0;
    let no_decision = 0;
    let applied_true = 0; // anomalia se > 0 em S3
    let savingsSum = 0;
    let savingsKnown = 0;
    let opusOnlyKnown = 0;
    let opusOnlySum = 0;
    const causes = Object.create(null);

    for (const row of rows) {
        if (row.applied) applied_true += 1;
        if (row.kind === 'no_decision') {
            no_decision += 1;
            if (row.cause) causes[row.cause] = (causes[row.cause] || 0) + 1;
            continue;
        }
        decisions += 1;
        if (row.faixa && Object.hasOwn(by_faixa, row.faixa)) by_faixa[row.faixa] += 1;
        else by_faixa.unknown += 1;
        if (row.leaves_opus_tier) leaves_opus += 1;
        else if (row.tier === 'T3') stays_opus += 1;
        if (row.share_cost_usd != null) {
            opusOnlySum += row.share_cost_usd;
            opusOnlyKnown += 1;
        }
        if (row.potential_savings_usd != null) {
            savingsSum += row.potential_savings_usd;
            savingsKnown += 1;
        }
    }

    const recent = rows
        .filter(r => r.kind === 'decision')
        .sort((a, b) => (Date.parse(b.observed_at) || 0) - (Date.parse(a.observed_at) || 0))
        .slice(0, recentLimit)
        .map(r => ({
            task_id: r.task_id,
            ticket_id: r.ticket_id,
            node: r.node,
            attempt_id: r.attempt_id,
            observed_at: r.observed_at,
            subtask_key: r.subtask_key,
            class: r.class,
            tier: r.tier,
            faixa: r.faixa,
            faixa_label: r.faixa ? FAIXA_LABEL[r.faixa] : 'UNKNOWN',
            rule: r.rule,
            leaves_opus_tier: r.leaves_opus_tier,
            would_model: r.would_model,
            share_cost_usd: r.share_cost_usd,
            potential_savings_usd: r.potential_savings_usd,
            policy_version: r.policy_version,
            classifier_provider: r.classifier_provider,
        }));

    return {
        status: 'ok',
        shadow_only: true,
        s4_enabled: false,
        note: 'Medição em sombra (would_route). Despacho continua AS-IS; S4 não ligado.',
        pricing_hypothesis: {
            description: 'Economia potencial vs Opus-only usa razões aproximadas de preço de input (Haiku/Sonnet/Opus).',
            cost_ratio_vs_opus: { ...COST_RATIO_VS_OPUS },
            faixa: { ...FAIXA_LABEL },
            source: 'scripts/lib/model-pricing.json (aproximação; modelos na policy ainda UNAVAILABLE)',
        },
        counts: {
            attempts_with_would_route: new Set(rows.map(r => `${r.task_id}:${r.attempt_id}`)).size,
            decisions,
            no_decision,
            leaves_opus_tier: leaves_opus,
            stays_opus_tier: stays_opus,
            by_faixa,
            applied_true_anomaly: applied_true,
            causes,
        },
        savings_vs_opus_only: {
            // null quando não há custo observado atribuível — nunca inventar 0.
            opus_only_usd: opusOnlyKnown > 0 ? opusOnlySum : null,
            // Gasto hipotético se a faixa sombra tivesse sido usada (share × razão).
            potential_usd: savingsKnown > 0 ? (opusOnlySum - savingsSum) : null,
            potential_savings_usd: savingsKnown > 0 ? savingsSum : null,
            decisions_with_priced_share: savingsKnown,
            decisions_with_opus_only_share: opusOnlyKnown,
            unknown_when: savingsKnown === 0
                ? 'Sem custo observado nos Attempts com would_route, ou classificador sem decisões.'
                : null,
        },
        recent,
    };
}

function buildWouldRouteMetrics(runs, opts) {
    return aggregateWouldRoute(runs, opts);
}

module.exports = {
    TIER_FAIXA,
    FAIXA_LABEL,
    COST_RATIO_VS_OPUS,
    collectFromCostTracking,
    aggregateWouldRoute,
    buildWouldRouteMetrics,
};
