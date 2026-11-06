'use strict';
// PRI-181 c2b-1-model (SPEC-c2b-1-model r3.1): modelo do Diagnosis Record da SDD B v2.
//
// - Gramática de chave (§3.1 EXACT, §3.4 DEGRADED) e de token, premissas 3 e 4.
// - Cabeçalho §6.7 de vNNN.json e validador da parte de cabeçalho de qa-diagnosis/0.1
//   (premissas 7.7 e 8). As seções de conteúdo §6.1–6.4 são opcionais e não validadas
//   até a c2b-4.
// - Bloco qa_rejections[i].diagnosis (§4.2), premissas 7.1–7.8.
//
// JavaScript puro, sem ajv: a condição (e) do §4.3.1 não pode passar por falta de validador.
// Sem I/O e sem escrita de state: quem grava é o state-writer (INV-2), na fatia dona.

const crypto = require('crypto');

const SCHEMA_ID = 'qa-diagnosis/0.1';

const NS = '[a-z][a-z0-9-]{0,31}';
const ISSUE = '[1-9][0-9]{0,9}';
const EXACT_RE = new RegExp(`^${NS}:${ISSUE}:j[1-9][0-9]{0,11}$`);
const DEGRADED_RE = new RegExp(`^${NS}:${ISSUE}:t(\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{3})?Z)$`);
const TOKEN_RE = /^[a-z0-9_-]{1,128}$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const HEX64_RE = /^[0-9a-f]{64}$/;

const PRODUCED_BY = ['deterministic', 'agent', 'human'];
// §5 (estados) e tabela do §5 (reasons) mais RUNNER_NOT_ADMITTED (§8.3); premissa 7.3.
const STATUSES = ['pending', 'collecting', 'proposed', 'reviewed', 'stale', 'superseded'];
const FAILED_REASONS = ['SOURCE_UNAVAILABLE', 'INTEGRITY', 'SCHEMA_INVALID', 'TIMEOUT',
    'BUDGET_EXCEEDED', 'FENCED', 'INTERNAL', 'RUNNER_NOT_ADMITTED'];
const OUTCOME_STATUSES = ['PENDING', 'QA_APPROVED', 'QA_REJECTED_AGAIN', 'HANDED_BACK_NO_CODE', 'WITHDRAWN', 'UNKNOWN'];
const OUTCOME_SOURCES = ['redmine_transition', 'handback', 'human_label']; // §6.6

// Ordem canônica do cabeçalho (§6.7); pr/commit em duas chaves (premissa 7.5).
const HEADER_KEYS = ['schema', 'rejection_key', 'version', 'parent_version', 'job_token', 'produced_by',
    'created_at', 'prisma_revision', 'consumer_ref', 'bindings', 'taxonomy_version', 'predicates_version',
    'rules_version', 'analyzer', 'inputs_digest', 'cost'];
const BINDING_KEYS = ['task_id', 'execution_id', 'dom06_attempt_ids', 'spec_hash', 'spec_version', 'pr', 'commit'];
const ANALYZER_KEYS = ['kind', 'runtime', 'model', 'effort', 'rubric_version', 'rubric_sha256',
    'context_pack_sha256', 'transcript_ref'];
// Seções de conteúdo da SDD (§6.1–6.4); forma definida pela c2b-4.
const CONTENT_KEYS = ['context', 'assertions', 'cause', 'recommendation', 'platform_signals'];

const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
// String vazia não é UNKNOWN: UNKNOWN é null (premissa 7.7). "" é recusado.
const isStrOrNull = v => v === null || (typeof v === 'string' && v.length > 0);
const isInt = (v, min) => Number.isSafeInteger(v) && v >= min;

/** ISO-8601 UTC com data e hora de calendário válidas (premissa 3): a releitura por Date reproduz o texto. */
function isCalendarIso(s) {
    if (typeof s !== 'string' || !ISO_RE.test(s)) return false;
    const d = new Date(s);
    if (Number.isNaN(d.getTime())) return false;
    const canon = s.length === 20 ? `${s.slice(0, 19)}.000Z` : s;
    return d.toISOString() === canon;
}

/** Chave admitida pelo store: só EXACT ou DEGRADED da SDD. `qa-rej:v1` é recusada (premissa 3). */
function isValidKey(key) {
    if (typeof key !== 'string') return false;
    if (EXACT_RE.test(key)) return true;
    const m = DEGRADED_RE.exec(key);
    return !!m && isCalendarIso(m[1]);
}

const isValidToken = t => typeof t === 'string' && TOKEN_RE.test(t);

function sha256(bytes) {
    return crypto.createHash('sha256').update(bytes).digest('hex');
}

const UNKNOWN_COST = () => ({ usd: null, tokens: null, status: 'UNKNOWN' });

// Chaves do contrato em ordem (ausente → null); chaves extras seguem para o validador recusar.
function pick(src, keys) {
    const out = {};
    for (const k of keys) out[k] = src && Object.prototype.hasOwnProperty.call(src, k) ? src[k] : null;
    for (const k of Object.keys(isObj(src) ? src : {})) if (!keys.includes(k)) out[k] = src[k];
    return out;
}

/**
 * Monta o objeto de versão em ordem canônica. Nunca inventa valor plausível: campo ausente
 * fica null (= UNKNOWN). O resultado só vale depois de validateVersion.
 */
function buildVersion(fields = {}, content = {}) {
    const out = {};
    for (const k of HEADER_KEYS) {
        if (k === 'schema') out.schema = SCHEMA_ID;
        else if (k === 'bindings') out.bindings = pick(fields.bindings, BINDING_KEYS);
        else if (k === 'analyzer') out.analyzer = pick(fields.analyzer, ANALYZER_KEYS);
        else if (k === 'cost') out.cost = fields.cost === undefined ? UNKNOWN_COST() : fields.cost;
        else out[k] = Object.prototype.hasOwnProperty.call(fields, k) ? fields[k] : null;
    }
    for (const k of CONTENT_KEYS) if (content && content[k] !== undefined) out[k] = content[k];
    // Chaves fora do contrato não são descartadas em silêncio: seguem no objeto para o
    // validateVersion recusar (ex.: findings/authority do C2/C3).
    for (const src of [fields, content]) {
        for (const k of Object.keys(src || {})) {
            if (!HEADER_KEYS.includes(k) && !CONTENT_KEYS.includes(k) && !Object.prototype.hasOwnProperty.call(out, k)) out[k] = src[k];
        }
    }
    return out;
}

function canonical(value) {
    if (Array.isArray(value)) return value.map(canonical);
    if (isObj(value)) {
        const out = {};
        for (const k of Object.keys(value).sort()) out[k] = canonical(value[k]);
        return out;
    }
    return value;
}

/**
 * Serialização determinística: topo na ordem canônica, chaves fora do contrato depois (em ordem
 * alfabética, para o validador recusar os bytes), objetos internos com chaves ordenadas, LF final.
 */
function serialize(version) {
    const top = {};
    const extra = Object.keys(version).filter(k => !HEADER_KEYS.includes(k) && !CONTENT_KEYS.includes(k)).sort();
    for (const k of [...HEADER_KEYS, ...CONTENT_KEYS, ...extra]) {
        if (Object.prototype.hasOwnProperty.call(version, k)) top[k] = canonical(version[k]);
    }
    return Buffer.from(`${JSON.stringify(top, null, 2)}\n`, 'utf8');
}

function closedKeys(obj, allowed, where, errors) {
    for (const k of Object.keys(obj)) if (!allowed.includes(k)) errors.push(`${where}: chave não admitida ${k}`);
    for (const k of allowed) if (!Object.prototype.hasOwnProperty.call(obj, k)) errors.push(`${where}: falta ${k}`);
}

function isUnknownCost(c) {
    return isObj(c) && Object.keys(c).length === 3 && c.usd === null && c.tokens === null && c.status === 'UNKNOWN';
}

/** Validador da parte de cabeçalho de qa-diagnosis/0.1 (premissas 7.7 e 8). */
function validateVersion(v) {
    const errors = [];
    if (!isObj(v)) return { ok: false, errors: ['versão não é objeto'] };
    for (const k of Object.keys(v)) {
        if (!HEADER_KEYS.includes(k) && !CONTENT_KEYS.includes(k)) errors.push(`chave de topo não admitida: ${k}`);
    }
    for (const k of HEADER_KEYS) if (!Object.prototype.hasOwnProperty.call(v, k)) errors.push(`falta ${k}`);
    if (errors.length) return { ok: false, errors };

    if (v.schema !== SCHEMA_ID) errors.push('schema');
    if (!isValidKey(v.rejection_key)) errors.push('rejection_key');
    if (!isInt(v.version, 1)) errors.push('version');
    if (!(Number.isSafeInteger(v.parent_version) && v.parent_version === v.version - 1)) errors.push('parent_version');
    if (!isValidToken(v.job_token)) errors.push('job_token');
    if (!PRODUCED_BY.includes(v.produced_by)) errors.push('produced_by');
    if (!isCalendarIso(v.created_at)) errors.push('created_at');
    if (!isStrOrNull(v.prisma_revision)) errors.push('prisma_revision');
    if (!isStrOrNull(v.consumer_ref)) errors.push('consumer_ref');

    const b = v.bindings;
    if (!isObj(b)) errors.push('bindings');
    else {
        closedKeys(b, BINDING_KEYS, 'bindings', errors);
        if (!(typeof b.task_id === 'string' && b.task_id.length > 0)) errors.push('bindings.task_id');
        for (const k of ['execution_id', 'spec_hash', 'pr', 'commit']) if (!isStrOrNull(b[k])) errors.push(`bindings.${k}`);
        if (!(b.spec_version === null || isInt(b.spec_version, 0) || (typeof b.spec_version === 'string' && b.spec_version.length > 0))) errors.push('bindings.spec_version');
        if (!(b.dom06_attempt_ids === null || (Array.isArray(b.dom06_attempt_ids) && b.dom06_attempt_ids.every(x => typeof x === 'string' && x.length > 0)))) errors.push('bindings.dom06_attempt_ids');
    }
    for (const k of ['taxonomy_version', 'predicates_version', 'rules_version']) if (!isStrOrNull(v[k])) errors.push(k);

    const a = v.analyzer;
    if (!isObj(a)) errors.push('analyzer');
    else {
        closedKeys(a, ANALYZER_KEYS, 'analyzer', errors);
        for (const k of ['kind', 'runtime']) if (!(typeof a[k] === 'string' && a[k].length > 0)) errors.push(`analyzer.${k}`);
        for (const k of ANALYZER_KEYS.slice(2)) if (!isStrOrNull(a[k])) errors.push(`analyzer.${k}`);
    }
    if (!(v.inputs_digest === null || (typeof v.inputs_digest === 'string' && HEX64_RE.test(v.inputs_digest)))) errors.push('inputs_digest');
    if (!isUnknownCost(v.cost)) errors.push('cost'); // premissa 7.6: só UNKNOWN; nunca zero inventado
    return errors.length ? { ok: false, errors } : { ok: true };
}

/** Bloco inicial (premissas 7.1, 7.2 e 7.8). Quem o grava é a c1b, no write atômico da chave. */
function initialDiagnosisBlock() {
    return {
        rev: 0,
        status: 'pending',
        current_version: 0,
        current_sha256: null,
        versions: [],
        job: null,
        review: null,
        review_history: [],
        outcome: { status: 'PENDING', source: null, evidence_ref: null, at: null, confirmed_cause: null },
        applied_ops: [],
        cost: UNKNOWN_COST(),
        fenced_tokens: [],
        blocked: null,
    };
}

function isValidStatus(s) {
    if (STATUSES.includes(s)) return true;
    const m = /^failed:([A-Z_]+)$/.exec(String(s));
    return !!m && FAILED_REASONS.includes(m[1]);
}

const BLOCK_KEYS = ['rev', 'status', 'current_version', 'current_sha256', 'versions', 'job', 'review',
    'review_history', 'outcome', 'applied_ops', 'cost', 'fenced_tokens', 'blocked'];

/**
 * Validação estrita do bloco; falha fechada só para a operação de diagnóstico (premissa 6).
 * Chaves além das do §4.2 são toleradas: a SDD prevê campos de outras fatias no mesmo bloco
 * (ex.: bypassed, §4.4), e a fatia dona os valida quando os introduz.
 */
function validateBlock(blk) {
    const errors = [];
    if (!isObj(blk)) return { ok: false, errors: ['bloco não é objeto'] };
    for (const k of BLOCK_KEYS) if (!Object.prototype.hasOwnProperty.call(blk, k)) errors.push(`falta ${k}`);
    if (errors.length) return { ok: false, errors };

    if (!isInt(blk.rev, 0)) errors.push('rev');
    if (!isValidStatus(blk.status)) errors.push('status');
    if (!isInt(blk.current_version, 0)) errors.push('current_version');
    if (!Array.isArray(blk.versions)) errors.push('versions');
    else {
        blk.versions.forEach((e, i) => {
            if (!isObj(e) || e.v !== i + 1 || typeof e.sha256 !== 'string' || !HEX64_RE.test(e.sha256)
                || !PRODUCED_BY.includes(e.produced_by) || !isCalendarIso(e.at)) errors.push(`versions[${i}]`);
        });
        if (blk.current_version !== blk.versions.length) errors.push('current_version != versions.length');
        const last = blk.versions[blk.versions.length - 1];
        const expected = last && typeof last.sha256 === 'string' ? last.sha256 : null;
        if (blk.current_sha256 !== expected) errors.push('current_sha256');
    }
    if (!(blk.job === null || isObj(blk.job))) errors.push('job');
    if (!(blk.review === null || isObj(blk.review))) errors.push('review');
    if (!Array.isArray(blk.review_history)) errors.push('review_history');
    const o = blk.outcome;
    if (!isObj(o) || !OUTCOME_STATUSES.includes(o.status)
        || !['source', 'evidence_ref', 'at', 'confirmed_cause'].every(k => Object.prototype.hasOwnProperty.call(o, k))
        || !(o.source === null || OUTCOME_SOURCES.includes(o.source))) errors.push('outcome');
    if (!Array.isArray(blk.applied_ops)) errors.push('applied_ops');
    if (!isUnknownCost(blk.cost)) errors.push('cost');
    const ft = blk.fenced_tokens;
    if (!Array.isArray(ft) || !ft.every(isValidToken) || new Set(ft).size !== ft.length) errors.push('fenced_tokens');
    const bl = blk.blocked;
    if (!(bl === null || (isObj(bl) && bl.reason === 'DUPLICATE_SUBJECT' && Array.isArray(bl.clones)
        && bl.clones.every(c => typeof c === 'string' && c.length > 0) && isCalendarIso(bl.detected_at)))) errors.push('blocked');
    return errors.length ? { ok: false, errors } : { ok: true };
}

module.exports = {
    SCHEMA_ID, HEADER_KEYS, BINDING_KEYS, ANALYZER_KEYS, CONTENT_KEYS,
    PRODUCED_BY, STATUSES, FAILED_REASONS, OUTCOME_STATUSES, OUTCOME_SOURCES, TOKEN_RE,
    isCalendarIso, isValidKey, isValidToken, sha256,
    buildVersion, buildVersionHeader: buildVersion, serialize, validateVersion,
    initialDiagnosisBlock, validateBlock, isValidStatus,
};
