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

module.exports = { projectCostTracking };
