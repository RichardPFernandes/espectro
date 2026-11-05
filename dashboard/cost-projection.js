'use strict';
// Read model only. No transcript reads, writes, new prices or historical rebinding.
const fs = require('node:fs');
const path = require('node:path');
const { projectUsageCost, PRICING_SHA256 } = require('../scripts/lib/cost-tracking');

const COUNTERS = ['messages', 'input_tokens', 'output_tokens', 'cache_read_tokens',
    'cache_write_5m_tokens', 'cache_write_1h_tokens', 'cache_write_ttl_unknown_tokens'];
const AGGREGATES = ['input_tokens', 'output_tokens', 'cache_read_input_tokens',
    'cache_creation_input_tokens', 'cost_usd', 'duration_ms', 'loop_count', 'runs',
    'retries', 'runs_without_tokens', 'runs_without_cost'];
const number = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
const id = value => typeof value === 'string' && /^[a-zA-Z0-9_<\[\]][a-zA-Z0-9_.:<\[\]> -]{0,199}$/.test(value) ? value : 'UNKNOWN';
// subtask_key S2 usa barra (ex. abcdef012345/0-2); paths_decl relativos sem absolute/private.
const subtaskKey = value => typeof value === 'string' && /^[a-zA-Z0-9_<\[\].:\/-]{1,120}$/.test(value) ? value : 'UNKNOWN';
const relPath = value => typeof value === 'string' && value.length > 0 && value.length <= 400
    && !value.includes('\0') && !/^[\\\/]|^[A-Za-z]:[\\\/]|^\.\.(?:\/|$)/.test(value)
    && !value.includes('/dom06/') && !value.includes('/private/') ? value : null;
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value) ? value : 'UNKNOWN';
const list = value => Array.isArray(value) ? value : [];
const numeric = (value, fields) => Object.fromEntries(fields.filter(k => Object.hasOwn(value || {}, k)).map(k => [k, number(value[k])]));

function pricingSource(value) {
    if (typeof value !== 'string' || value.length > 2000) return 'UNKNOWN';
    // URLs are source citations; filesystem paths and multiline content are not.
    const withoutUrls = value.replace(/https?:\/\/[^\s,;]+/g, '');
    return /[\/\\\r\n]/.test(withoutUrls) ? 'UNKNOWN' : value;
}

function startOf(attempt, { run, ticketId } = {}) {
    const ref = attempt?.admission?.attempt_ref;
    const attemptId = attempt?.admission?.attempt_id;
    // Resolve only in the exact selected root. An archived/main copy must not
    // silently bind to the current worktree for the same ticket.
    if (!run || ref?.runs_root !== `${run.root?.label}/memory/runs` || ref.runs_root !== `worktree:${ticketId}/memory/runs`) return 'UNKNOWN';
    if (typeof attemptId !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(attemptId)) return 'UNKNOWN';
    if (![`${run.taskId}/dom06/attempts/${attemptId}.json`, `_dom06/dom06/attempts/${attemptId}.json`].includes(ref.path)) return 'UNKNOWN';
    try {
        const root = fs.realpathSync(run.root.dir);
        const file = path.join(root, ref.path);
        if (fs.realpathSync(file) !== file || fs.statSync(file).size > 4 * 1024 * 1024) return 'UNKNOWN';
        const source = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (source.attempt_id !== attemptId || source.node !== attempt.admission.admitted_node || source.started !== true) return 'UNKNOWN';
        return typeof source.admitted_at === 'string' && /^\d{4}-\d\d-\d\dT/.test(source.admitted_at) && Number.isFinite(Date.parse(source.admitted_at))
            ? new Date(source.admitted_at).toISOString() : 'UNKNOWN';
    } catch { return 'UNKNOWN'; }
}

function usageOf(row) {
    const result = {
        model: id(row?.model), role: id(row?.role), speed: id(row?.speed), price_tier: id(row?.price_tier),
        pricing_sha256: hash(row?.pricing_sha256), role_provenance: id(row?.role_provenance),
        role_conflicted_messages: number(row?.role_conflicted_messages),
        ...Object.fromEntries(COUNTERS.map(k => [k, number(row?.[k])])),
    };
    // The existing projector requires the matching table and complete counters.
    // Null counters are not zero, even if the known components could be priced.
    const complete = COUNTERS.filter(k => k !== 'messages').every(k => result[k] !== null);
    const speedObserved = ['standard', 'fast'].includes(result.speed);
    result.cost_usd = complete && speedObserved ? projectUsageCost(result) : null;
    result.cost_status = !complete ? 'NOT_OBSERVED' : !speedObserved ? 'DIMENSION_NOT_OBSERVED'
        : result.pricing_sha256 !== PRICING_SHA256 ? 'PRICING_UNAVAILABLE'
        : result.cost_usd === null ? 'UNPRICED' : 'PRICED';
    return result;
}

function projectSignals(value) {
    if (value === 'UNAVAILABLE') return 'UNAVAILABLE';
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    return {
        status: id(value.status),
        cause: value.cause == null ? null : id(String(value.cause)),
        plan_version: value.plan_version == null ? null : id(String(value.plan_version).slice(0, 64)),
        groups: list(value.groups).slice(0, 200).map(g => ({
            subtask_key: subtaskKey(g?.subtask_key),
            steps: list(g?.steps).filter(n => Number.isInteger(n) && n >= 0).slice(0, 100),
            signals: g?.signals && typeof g.signals === 'object' ? {
                kind: id(g.signals.kind),
                n_files: number(g.signals.n_files),
                n_new_files: number(g.signals.n_new_files),
                n_acs_step: number(g.signals.n_acs_step),
                code_local: typeof g.signals.code_local === 'boolean' ? g.signals.code_local : id(g.signals.code_local),
                sensitive_decl: typeof g.signals.sensitive_decl === 'boolean' ? g.signals.sensitive_decl : id(g.signals.sensitive_decl),
                schema_decl: typeof g.signals.schema_decl === 'boolean' ? g.signals.schema_decl : id(g.signals.schema_decl),
                // Paths relativos do plano (sem absolute / private / dom06).
                paths_decl: list(g.signals.paths_decl).map(relPath).filter(Boolean).slice(0, 80),
            } : null,
        })),
    };
}

function projectWouldRoute(value) {
    if (value === 'UNAVAILABLE') return 'UNAVAILABLE';
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    return {
        status: id(value.status),
        cause: value.cause == null ? null : id(String(value.cause)),
        detail: value.detail == null ? null : (typeof value.detail === 'string' && value.detail.length <= 400
            && !/[\/\\]/.test(value.detail.replace(/https?:\/\/[^\s]+/g, '')) ? value.detail : 'UNKNOWN'),
        policy_version: value.policy_version == null ? null : id(String(value.policy_version)),
        policy_hash: value.policy_hash == null ? null : hash(value.policy_hash),
        classifier_ref: { provider: id(value.classifier_ref?.provider) },
        applied: value.applied === true,
        decisions: list(value.decisions).slice(0, 200).map(d => ({
            subtask_key: subtaskKey(d?.subtask_key),
            steps: list(d?.steps).filter(n => Number.isInteger(n) && n >= 0).slice(0, 100),
            class: id(d?.class),
            tier: id(d?.tier),
            rule: id(d?.rule),
            leaves_opus_tier: d?.leaves_opus_tier === true,
            would_model: id(d?.would_model),
            selection_source: id(d?.selection_source),
        })),
    };
}

function attemptOf(value, context) {
    const a = value || {};
    return {
        admission: { attempt_id: id(a.admission?.attempt_id), admitted_node: id(a.admission?.admitted_node) },
        attributed_node: id(a.attributed_node), also_covers: list(a.also_covers).map(id),
        cause: id(a.cause), started_at: startOf(a, context), runtime: id(a.runtime), provider: id(a.provider),
        account: { label: typeof a.account?.label === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(a.account.label) ? a.account.label : 'UNKNOWN' },
        requested: { model: id(a.requested?.model), effort: id(a.requested?.effort) },
        routing_decision: id(a.routing_decision), selection_source: id(a.selection_source),
        observed: { usage: list(a.observed?.usage).map(usageOf), effort: id(a.observed?.effort) },
        role_attribution: { status: id(a.role_attribution?.status), conflicted_messages: number(a.role_attribution?.conflicted_messages) },
        cost: { usd: number(a.cost?.usd), unpriced_models: list(a.cost?.unpriced_models).map(id),
            pricing_source: pricingSource(a.cost?.pricing_source), pricing_sha256: hash(a.cost?.pricing_sha256),
            estimated: typeof a.cost?.estimated === 'boolean' ? a.cost.estimated : 'UNKNOWN' },
        duration_ms: number(a.duration_ms), exit: Number.isInteger(a.exit) ? a.exit : 'UNKNOWN', result: id(a.result),
        // PRI-222/223: subtarefas e decisão sombra — só campos públicos; applied permanece false em S3.
        signals: projectSignals(a.signals),
        would_route: projectWouldRoute(a.would_route),
    };
}

function projectCostTracking(value, context) {
    if (!value || typeof value !== 'object' || !value.nodes || !value.totals) return null;
    return {
        totals: numeric(value.totals, AGGREGATES), pricing_source: pricingSource(value.pricing_source),
        nodes: Object.fromEntries(Object.entries(value.nodes).filter(([key, node]) => id(key) === key && node && typeof node === 'object').map(([key, node]) => [key, {
            ...numeric(node, AGGREGATES), agent: id(node.agent), models: list(node.models).map(id),
            also_covers: list(node.also_covers).map(id),
            ...(Array.isArray(node.attempts) ? { attempts: node.attempts.map(a => attemptOf(a, context)) } : {}),
        }])),
    };
}

module.exports = { projectCostTracking, projectSignals, projectWouldRoute };
