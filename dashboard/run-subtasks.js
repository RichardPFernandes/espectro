'use strict';
// Read model: subtarefas de um run a partir de cost_tracking (sinais S2 + would_route S3).
// Só leitura — não aplica S4 / não muda despacho. Usado pela UI Runs e testes.

const TIER_FAIXA = Object.freeze({ T1: 'leve', T2: 'medio', T3: 'opus' });
const FAIXA_LABEL = Object.freeze({ leve: 'leve', medio: 'médio', opus: 'Opus' });

const id = value => (typeof value === 'string' && value.length > 0 && value.length <= 200 ? value : null);
const subtaskKey = value => (typeof value === 'string' && /^[a-zA-Z0-9_<\[\].:\/-]{1,120}$/.test(value) ? value : null);

/**
 * Extrai subtarefas únicas de um cost_tracking (já projetado ou bruto).
 * Preferência: decisões would_route; senão grupos de signals (sem faixa).
 * @param {object|null} costTracking
 * @returns {{ rows: object[], summary: object }}
 */
function subtasksOfCostTracking(costTracking) {
    const byKey = new Map();
    let attempts_seen = 0;
    let with_would_route = 0;
    let no_decision = 0;

    if (!costTracking || typeof costTracking !== 'object' || !costTracking.nodes) {
        return emptyResult();
    }

    for (const [nodeKey, node] of Object.entries(costTracking.nodes)) {
        if (!node || !Array.isArray(node.attempts)) continue;
        for (const attempt of node.attempts) {
            attempts_seen += 1;
            const wr = attempt?.would_route;
            const signals = attempt?.signals;
            const groups = signals && typeof signals === 'object' && Array.isArray(signals.groups)
                ? signals.groups : [];

            if (wr && wr !== 'UNAVAILABLE' && typeof wr === 'object') {
                with_would_route += 1;
                const decisions = Array.isArray(wr.decisions) ? wr.decisions : [];
                if (!decisions.length) {
                    no_decision += 1;
                    for (const g of groups) upsertFromGroup(byKey, g, {
                        node: nodeKey,
                        attempt_id: attempt?.admission?.attempt_id,
                        shadow_status: wr.status || 'NO_DECISION',
                        cause: wr.cause || null,
                        classifier_provider: wr.classifier_ref?.provider || null,
                        applied: wr.applied === true,
                    });
                    continue;
                }
                for (const d of decisions) {
                    const key = subtaskKey(d.subtask_key) || 'UNKNOWN';
                    const tier = id(d.tier);
                    const faixa = tier && TIER_FAIXA[tier] ? TIER_FAIXA[tier] : null;
                    byKey.set(key, {
                        subtask_key: key,
                        steps: Array.isArray(d.steps) ? d.steps.filter(n => Number.isInteger(n)) : [],
                        class: id(d.class),
                        tier,
                        faixa,
                        faixa_label: faixa ? FAIXA_LABEL[faixa] : null,
                        rule: id(d.rule),
                        leaves_opus_tier: d.leaves_opus_tier === true,
                        would_model: id(d.would_model),
                        kind: null,
                        n_files: null,
                        node: id(nodeKey) || nodeKey,
                        attempt_id: id(attempt?.admission?.attempt_id),
                        shadow_status: id(wr.status) || 'SHADOW',
                        cause: wr.cause == null ? null : id(String(wr.cause)),
                        classifier_provider: id(wr.classifier_ref?.provider),
                        applied: wr.applied === true,
                        source: 'would_route',
                    });
                }
                continue;
            }

            // Sem would_route: ainda mostra grupos S2 se existirem.
            for (const g of groups) {
                upsertFromGroup(byKey, g, {
                    node: nodeKey,
                    attempt_id: attempt?.admission?.attempt_id,
                    shadow_status: null,
                    cause: null,
                    classifier_provider: null,
                    applied: false,
                });
            }
        }
    }

    const rows = [...byKey.values()].sort((a, b) => String(a.subtask_key).localeCompare(String(b.subtask_key)));
    const leaves = rows.filter(r => r.leaves_opus_tier).length;
    const by_faixa = { leve: 0, medio: 0, opus: 0, unknown: 0 };
    for (const r of rows) {
        if (r.faixa && Object.hasOwn(by_faixa, r.faixa)) by_faixa[r.faixa] += 1;
        else by_faixa.unknown += 1;
    }

    return {
        rows,
        summary: {
            count: rows.length,
            leaves_opus_tier: leaves,
            by_faixa,
            attempts_seen,
            with_would_route,
            no_decision,
            shadow_only: true,
            s4_enabled: false,
        },
    };
}

function upsertFromGroup(byKey, group, meta) {
    const key = subtaskKey(group?.subtask_key) || 'UNKNOWN';
    if (byKey.has(key) && byKey.get(key).source === 'would_route') return;
    const sig = group?.signals && typeof group.signals === 'object' ? group.signals : {};
    byKey.set(key, {
        subtask_key: key,
        steps: Array.isArray(group?.steps) ? group.steps.filter(n => Number.isInteger(n)) : [],
        class: null,
        tier: null,
        faixa: null,
        faixa_label: null,
        rule: null,
        leaves_opus_tier: false,
        would_model: null,
        kind: id(sig.kind),
        n_files: typeof sig.n_files === 'number' ? sig.n_files : null,
        node: id(meta.node) || meta.node,
        attempt_id: id(meta.attempt_id),
        shadow_status: meta.shadow_status,
        cause: meta.cause,
        classifier_provider: meta.classifier_provider,
        applied: meta.applied === true,
        source: 'signals',
    });
}

function emptyResult() {
    return {
        rows: [],
        summary: {
            count: 0,
            leaves_opus_tier: 0,
            by_faixa: { leve: 0, medio: 0, opus: 0, unknown: 0 },
            attempts_seen: 0,
            with_would_route: 0,
            no_decision: 0,
            shadow_only: true,
            s4_enabled: false,
        },
    };
}

module.exports = {
    TIER_FAIXA,
    FAIXA_LABEL,
    subtasksOfCostTracking,
};
