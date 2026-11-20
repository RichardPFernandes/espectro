// Decisão sombra would_route (PRI-205 S3 / PRI-223), núcleo 1.
// Classificadora = extrato v9 §4.4 (R1–R8) em docs/s3-design-extract.md.
// Resolução §4.7 só em sombra: grava classe/tier/regra; NÃO aplica --model/esforço (S4).
//
// Predicados rework / rework_repetido: §4.3 não veio no extrato. Binding aos proxies S2
// já gravados (plan-signals): rework := ticket_rework || rework_count > 0;
// rework_repetido := rework_count >= 2. Sem inventar lista nova de globs.
//
// Nota humana (Richard, 05/11/2026): no planejamento, errar pra cima (qualidade);
// Sonnet só se bem simples — preferência de calibração, NÃO reescreve R1–R8.

const crypto = require('crypto');
const policyLoader = require('./model-routing-policy');

const UNKNOWN = 'UNKNOWN';
const NO_DECISION = 'NO_DECISION';
const SHADOW = 'SHADOW';
const UNAVAILABLE = 'UNAVAILABLE';

const CLASS_RANK = Object.freeze({ C1: 1, C2: 2, C3: 3, C4: 4, C5: 5 });

function classifierRef(provider) {
    return { provider: provider || 'off' };
}

function maxClass(a, b) {
    if (!a) return b;
    if (!b) return a;
    return CLASS_RANK[a] >= CLASS_RANK[b] ? a : b;
}

function isUnknown(v) {
    return v === UNKNOWN || v === undefined;
}

/** Proxies S2 ↔ predicados §4.4 (sem §4.3 no extrato). */
function reworkFrom(signals) {
    return Boolean(signals.ticket_rework) || Number(signals.rework_count) > 0;
}

function reworkRepetidoFrom(signals) {
    return Number(signals.rework_count) >= 2;
}

/**
 * Sinais exigidos pelas regras que podem produzir C1–C3 (R5–R7) + sensitive_decl.
 * R3: se algum for UNKNOWN → C4.
 */
function hasUnknownRequiredForC123(s) {
    if (isUnknown(s.sensitive_decl)) return true;
    if (isUnknown(s.n_files) || isUnknown(s.kind) || isUnknown(s.n_acs_step)) return true;
    if (isUnknown(s.n_new_files) || isUnknown(s.code_local)) return true;
    return false;
}

/**
 * Classificadora total §4.4 — primeira regra que casa.
 * @param {object} signals sinais prospectivos S2 de um grupo
 * @returns {{ class: string, rule: string }}
 */
function classifyByRules(signals) {
    const s = signals || {};

    // R1
    if (s.sensitive_decl === true) return { class: 'C5', rule: 'R1' };

    // R2
    if (reworkRepetidoFrom(s) || (s.schema_decl === true && s.schema_risk_seen === 'high')) {
        return { class: 'C5', rule: 'R2' };
    }

    // R3
    if (hasUnknownRequiredForC123(s)) return { class: 'C4', rule: 'R3' };

    // R4
    if (
        s.schema_decl === true
        || s.kind === 'behavior'
        || s.kind === 'config'
        || (typeof s.n_files === 'number' && s.n_files > 5)
        || (typeof s.n_services_decl === 'number' && s.n_services_decl >= 2)
        || reworkFrom(s)
    ) {
        return { class: 'C4', rule: 'R4' };
    }

    // R5
    if (s.n_files === 1 && s.kind === 'docs' && s.n_acs_step <= 1) {
        return { class: 'C1', rule: 'R5' };
    }

    // R6
    if (
        s.n_files <= 2
        && (s.kind === 'test' || s.code_local === true)
        && s.n_new_files <= 1
        && s.n_acs_step <= 2
    ) {
        return { class: 'C2', rule: 'R6' };
    }

    // R7
    if (
        s.n_files <= 5
        && (s.kind === 'test' || s.kind === 'docs' || s.code_local === true)
        && s.n_acs_step <= 3
    ) {
        return { class: 'C3', rule: 'R7' };
    }

    // R8
    return { class: 'C4', rule: 'R8' };
}

/**
 * Classe final = max(calculada, proposta do Plan). Plan só sobe (D4).
 * @param {object} signals
 * @param {string|null|undefined} planProposedClass
 */
function classifySubtask(signals, planProposedClass = null) {
    let calculated;
    let rule;
    let selection_source = 'RULES';
    try {
        const hit = classifyByRules(signals);
        calculated = hit.class;
        rule = hit.rule;
    } catch (e) {
        // §4.7 passo 4: exceção → C4 conservador
        calculated = 'C4';
        rule = 'R3';
        selection_source = 'CONSERVATIVE_DEFAULT';
    }

    const planClass = planProposedClass && CLASS_RANK[planProposedClass] ? planProposedClass : null;
    const finalClass = maxClass(calculated, planClass);
    return {
        class: finalClass,
        rule,
        class_calculated: calculated,
        plan_class: planClass,
        selection_source: planClass && CLASS_RANK[planClass] > CLASS_RANK[calculated]
            ? 'PLAN_RAISED'
            : selection_source,
    };
}

function signalsHash(signals) {
    return crypto.createHash('sha256').update(JSON.stringify(signals || null)).digest('hex');
}

function decisionForGroup(group, policy) {
    const signals = group.signals || {};
    const classified = classifySubtask(signals, group.plan_class || null);
    const tierRow = policy.class_to_tier[classified.class];
    const tier = tierRow.tier;
    const models = policy.tiers[tier]?.models || [UNAVAILABLE];
    const would_model = models[0] || UNAVAILABLE;
    // U1 não resolvido: esforço pedido permanece UNAVAILABLE; hipótese só na sombra.
    return {
        subtask_key: group.subtask_key || UNAVAILABLE,
        steps: Array.isArray(group.steps) ? group.steps : [],
        class: classified.class,
        class_calculated: classified.class_calculated,
        plan_class: classified.plan_class,
        tier,
        rule: classified.rule,
        effort_hypothesis: tierRow.effort,
        requested_effort: UNAVAILABLE,
        would_model,
        selection_source: classified.selection_source,
        signals_sha256: signalsHash(signals),
        // Preferência humana de calibração (não é regra R*): leve ≠ Opus quando tier < T3.
        leaves_opus_tier: tier === 'T1' || tier === 'T2',
    };
}

function emptyShadow(cause, detail, loaded) {
    return {
        status: NO_DECISION,
        cause,
        detail: detail || null,
        policy_version: loaded?.policy_version || null,
        policy_hash: loaded?.policy_hash || null,
        classifier_ref: classifierRef(loaded?.policy?.classifier?.provider || 'off'),
        decisions: [],
        applied: false,
        planning_bias: {
            prefer_quality_on_doubt: true,
            sonnet_only_if_very_simple: true,
            source: 'human_note_2026-11-05',
            alters_r1_r8: false,
        },
    };
}

/**
 * Decisão sombra a partir da policy + sinais S2 (groups).
 * @param {{ loaded?: object, signals?: object|null, planClasses?: Record<string,string> }} input
 */
function shadowDecide(input = {}) {
    const loaded = input.loaded || policyLoader.loadPolicy();

    if (loaded.status === 'MISSING') {
        return emptyShadow('POLICY_MISSING', loaded.detail || null, loaded);
    }
    if (loaded.status === 'INVALID') {
        return emptyShadow('POLICY_INVALID', loaded.detail || null, loaded);
    }

    const provider = loaded.policy.classifier.provider;
    const bias = {
        prefer_quality_on_doubt: true,
        sonnet_only_if_very_simple: true,
        source: 'human_note_2026-11-05',
        alters_r1_r8: false,
    };

    if (provider === 'off') {
        return {
            status: NO_DECISION,
            cause: 'CLASSIFIER_OFF',
            detail: null,
            policy_version: loaded.policy_version,
            policy_hash: loaded.policy_hash,
            classifier_ref: classifierRef('off'),
            decisions: [],
            applied: false,
            planning_bias: bias,
            signals_seen: input.signals && typeof input.signals === 'object'
                ? {
                    status: input.signals.status || UNAVAILABLE,
                    groups: Array.isArray(input.signals.groups) ? input.signals.groups.length : 0,
                }
                : { status: UNAVAILABLE, groups: 0 },
        };
    }

    if (provider !== 'cheap_rule') {
        return emptyShadow('CLASSIFIER_UNSUPPORTED', `provider=${provider}`, loaded);
    }

    const groups = Array.isArray(input.signals?.groups) ? input.signals.groups : [];
    const planClasses = input.planClasses || {};
    const decisions = groups.map(g => {
        const withPlan = {
            ...g,
            plan_class: g.plan_class || planClasses[g.subtask_key] || null,
        };
        return decisionForGroup(withPlan, loaded.policy);
    });

    return {
        status: SHADOW,
        cause: null,
        detail: null,
        policy_version: loaded.policy_version,
        policy_hash: loaded.policy_hash,
        classifier_ref: classifierRef('cheap_rule'),
        decisions,
        applied: false,
        planning_bias: bias,
        // Agregado para medir “sai do Opus” sem aplicar despacho.
        aggregate: {
            subtasks: decisions.length,
            leaves_opus_tier: decisions.filter(d => d.leaves_opus_tier).length,
            stays_t3: decisions.filter(d => d.tier === 'T3').length,
        },
    };
}

/** Fronteira: would_route nunca entra no argv do despacho. */
function assertDispatchUnchanged(asIsArgv, shadowSideArgv) {
    const a = JSON.stringify(asIsArgv);
    const b = JSON.stringify(shadowSideArgv);
    if (a !== b) {
        const err = new Error('WOULD_ROUTE_MUST_NOT_CHANGE_ARGV');
        err.asIs = asIsArgv;
        err.withShadow = shadowSideArgv;
        throw err;
    }
    return true;
}

module.exports = {
    UNKNOWN,
    NO_DECISION,
    SHADOW,
    UNAVAILABLE,
    CLASS_RANK,
    classifyByRules,
    classifySubtask,
    maxClass,
    shadowDecide,
    classifierRef,
    assertDispatchUnchanged,
    reworkFrom,
    reworkRepetidoFrom,
};
