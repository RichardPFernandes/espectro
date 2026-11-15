'use strict';
// PRI-274 c2b-4 — validação das seções de conteúdo da versão (SDD B v3 §6.1–6.4).
//
// JavaScript puro, sem ajv e sem I/O (como a c2b-1): a condição (e) do §4.3.1 não pode
// passar por falta de validador. Cada seção é validada por uma função própria; as seções
// Seção ausente é válida: o protocolo da c2b-2 produz versão só com cabeçalho.
//
// `isCalendarIso` vem injetado pelo model, que importa este módulo (evita ciclo).

const taxonomy = require('./qa-diagnosis-taxonomy');
const rules = require('./qa-diagnosis-rules');

const HEX64_RE = /^[0-9a-f]{64}$/;

// §6.1
const TRUST_CLASSES = Object.freeze(['TRUSTED_SYSTEM', 'UNTRUSTED_EXTERNAL_TEXT', 'AGENT_DERIVED', 'HUMAN']);
const SOURCE_KINDS = Object.freeze(['redmine_transition', 'redmine_note', 'spec', 'acs', 'ac_provenance',
    'spec_changelog', 'run_events', 'authorization_history', 'handed_back_qa', 'git', 'test_result',
    'transcript_index', 'attachment']);
const SOURCE_KEYS = ['id', 'kind', 'locator', 'sha256', 'version_binding', 'trust', 'admitted',
    'admission_rule', 'captured_at'];
const MISSING_KEYS = ['what', 'why_needed', 'blocks'];
// INV-5/6: texto de origem externa nunca é fonte de sistema, então nunca sustenta FACT.
const NEVER_TRUSTED_KINDS = Object.freeze(['redmine_note', 'attachment']);

// §6.2: type×basis em correspondência um para um; FACT ⇔ SYSTEM_PREDICATE (QRD-AC-11, DB-04).
const ASSERTION_TYPES = Object.freeze(['FACT', 'REPORT', 'HYPOTHESIS', 'ADJUDICATION']);
const BASIS_TYPE = Object.freeze({
    SYSTEM_PREDICATE: 'FACT', REPORTED: 'REPORT', AGENT_INFERENCE: 'HYPOTHESIS', HUMAN_ADJUDICATED: 'ADJUDICATION' });
const ASSERTION_KEYS = ['id', 'type', 'basis', 'predicate_ref', 'evidence_ids', 'contradicted_by', 'statement_ref'];
const PRED_REF_RE = /^pred:[a-z][a-z0-9_]*@[0-9][0-9A-Za-z.\-]*$/;

// §6.3: status da causa e escala ordinal de support (nunca acima de MODERATE, sem número, sem soma a 100%).
const CAUSE_STATUSES = Object.freeze(['HYPOTHESES', 'UNKNOWN', 'HUMAN_CONFIRMED']);
const CAUSE_KEYS = ['status', 'hypotheses'];
const HYPOTHESIS_KEYS = ['id', 'category', 'support', 'assertion_ids'];

// §6.4: vocabulários fechados. Mapeamento a mecanismos (PRI-180 etc.) só em D: aqui `route_hint` é só dica.
const RECOMMENDATION_ACTIONS = Object.freeze(['fix_code', 'clarify_requirement', 'investigate', 'request_effect',
    'validate_and_handback', 'dispute_rejection', 'none']);
const ROUTE_HINTS = Object.freeze(['retry', 'PRI-180:db_migration', 'PRI-180:handback_qa', 'human_interaction', 'none']);
// Sem campo de autorização, token, confiança numérica ou despacho: chaves fechadas (INV-1).
const RECOMMENDATION_KEYS = ['action', 'rationale_ref', 'depends_on_missing', 'human_gate_required', 'route_hint'];

// platform_signals[]: forma da SPEC Q1 (delta a registrar na SDD). Separados de `cause` (QRD-AC-08).
const PLATFORM_SIGNAL_KINDS = Object.freeze(['preparation_blocked', 'spec_missing']);
const PLATFORM_SIGNAL_KEYS = ['id', 'kind', 'evidence_ids', 'admitted'];

const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const isStr = v => typeof v === 'string' && v.length > 0;
// String vazia não é UNKNOWN: UNKNOWN é null (premissa 7.7 da c2b-1).
const isStrOrNull = v => v === null || isStr(v);

function closedKeys(obj, allowed, where, errors) {
    for (const k of Object.keys(obj)) if (!allowed.includes(k)) errors.push(`${where}: chave não admitida ${k}`);
    for (const k of allowed) if (!Object.prototype.hasOwnProperty.call(obj, k)) errors.push(`${where}: falta ${k}`);
}

function validateSource(s, i, h, errors) {
    const where = `context.sources[${i}]`;
    if (!isObj(s)) { errors.push(`${where}: não é objeto`); return; }
    const before = errors.length;
    closedKeys(s, SOURCE_KEYS, where, errors);
    if (errors.length > before) return;
    if (!isStr(s.id)) errors.push(`${where}.id`);
    if (!SOURCE_KINDS.includes(s.kind)) errors.push(`${where}.kind`);
    if (!isStr(s.locator)) errors.push(`${where}.locator`);
    if (!(s.sha256 === null || (typeof s.sha256 === 'string' && HEX64_RE.test(s.sha256)))) errors.push(`${where}.sha256`);
    if (!isStrOrNull(s.version_binding)) errors.push(`${where}.version_binding`);
    if (!TRUST_CLASSES.includes(s.trust)) errors.push(`${where}.trust`);
    else if (NEVER_TRUSTED_KINDS.includes(s.kind) && s.trust === 'TRUSTED_SYSTEM') errors.push(`${where}.trust: ${s.kind} não é TRUSTED_SYSTEM`);
    if (typeof s.admitted !== 'boolean') errors.push(`${where}.admitted`);
    if (!isStrOrNull(s.admission_rule)) errors.push(`${where}.admission_rule`);
    else if (s.admitted === true && s.admission_rule === null) errors.push(`${where}.admission_rule: fonte admitida exige regra`);
    if (!h.isCalendarIso(s.captured_at)) errors.push(`${where}.captured_at`);
}

function validateMissingItem(m, i, errors) {
    const where = `context.missing[${i}]`;
    if (!isObj(m)) { errors.push(`${where}: não é objeto`); return; }
    const before = errors.length;
    closedKeys(m, MISSING_KEYS, where, errors);
    if (errors.length > before) return;
    if (!isStr(m.what)) errors.push(`${where}.what`);
    if (!isStr(m.why_needed)) errors.push(`${where}.why_needed`);
    if (!(Array.isArray(m.blocks) && m.blocks.every(isStr))) errors.push(`${where}.blocks`);
}

/** §6.1: context = { sources[], missing[] }. missing[] bloqueia só a ação dependente. */
function validateContext(ctx, h, errors) {
    if (!isObj(ctx)) { errors.push('context: não é objeto'); return; }
    const before = errors.length;
    closedKeys(ctx, ['sources', 'missing'], 'context', errors);
    if (errors.length > before) return;
    if (!Array.isArray(ctx.sources)) errors.push('context.sources: não é array');
    else {
        ctx.sources.forEach((s, i) => validateSource(s, i, h, errors));
        const ids = ctx.sources.filter(isObj).map(s => s.id).filter(isStr);
        if (new Set(ids).size !== ids.length) errors.push('context.sources: id duplicado');
    }
    if (!Array.isArray(ctx.missing)) errors.push('context.missing: não é array');
    else ctx.missing.forEach((m, i) => validateMissingItem(m, i, errors));
}

function isStrArray(v) { return Array.isArray(v) && v.every(isStr); }

function validateAssertion(a, i, sourceById, assertionIds, errors) {
    const where = `assertions[${i}]`;
    if (!isObj(a)) { errors.push(`${where}: não é objeto`); return; }
    const before = errors.length;
    closedKeys(a, ASSERTION_KEYS, where, errors);
    if (errors.length > before) return;
    if (!isStr(a.id)) errors.push(`${where}.id`);
    if (!ASSERTION_TYPES.includes(a.type)) errors.push(`${where}.type`);
    const basisKnown = Object.prototype.hasOwnProperty.call(BASIS_TYPE, a.basis);
    if (!basisKnown) errors.push(`${where}.basis`);
    // Só a basis decide o type: nenhum texto, nota ou agente declara FACT por conta própria.
    else if (ASSERTION_TYPES.includes(a.type) && BASIS_TYPE[a.basis] !== a.type) {
        errors.push(`${where}: ${a.type} não corresponde à basis ${a.basis}`);
    }
    if (a.basis === 'SYSTEM_PREDICATE') {
        if (!(typeof a.predicate_ref === 'string' && PRED_REF_RE.test(a.predicate_ref))) errors.push(`${where}.predicate_ref: esperado pred:<id>@<ver>`);
    } else if (a.predicate_ref !== null) errors.push(`${where}.predicate_ref: só SYSTEM_PREDICATE carrega predicado`);
    if (!isStr(a.statement_ref)) errors.push(`${where}.statement_ref`);
    if (!isStrArray(a.contradicted_by)) errors.push(`${where}.contradicted_by`);
    else for (const c of a.contradicted_by) {
        if (c === a.id) errors.push(`${where}.contradicted_by: contradiz a si mesma`);
        else if (!assertionIds.has(c)) errors.push(`${where}.contradicted_by: ${c} não existe em assertions[]`);
    }
    if (!isStrArray(a.evidence_ids)) { errors.push(`${where}.evidence_ids`); return; }
    for (const e of a.evidence_ids) if (!sourceById.has(e)) errors.push(`${where}.evidence_ids: ${e} não existe em context.sources[]`);
    if (a.type === 'FACT' && a.basis === 'SYSTEM_PREDICATE') {
        if (a.evidence_ids.length === 0) errors.push(`${where}: FACT exige evidência`);
        for (const e of a.evidence_ids) {
            const src = sourceById.get(e);
            if (src && !(src.trust === 'TRUSTED_SYSTEM' && src.admitted === true)) {
                errors.push(`${where}: FACT só sobre fonte TRUSTED_SYSTEM admitida (${e})`);
            }
        }
    }
}

/** §6.2: assertions[]. A evidência é resolvida contra context.sources[] da mesma versão. */
function validateAssertions(list, ctx, errors) {
    if (!Array.isArray(list)) { errors.push('assertions: não é array'); return; }
    const sourceById = sourceMap(ctx);
    const ids = list.filter(isObj).map(a => a.id).filter(isStr);
    if (new Set(ids).size !== ids.length) errors.push('assertions: id duplicado');
    const assertionIds = new Set(ids);
    list.forEach((a, i) => validateAssertion(a, i, sourceById, assertionIds, errors));
}

/** FACT contrário à categoria: predicado contrário na versão, ou suporte contradito por outro FACT. */
function contraryFact(category, supportIds, byId) {
    for (const a of byId.values()) if (a.type === 'FACT' && rules.isContrary(category, a.predicate_ref)) return a.id;
    for (const id of supportIds) {
        const a = byId.get(id);
        if (a && a.type === 'FACT' && Array.isArray(a.contradicted_by) && a.contradicted_by.some(c => byId.get(c)?.type === 'FACT')) return id;
    }
    return null;
}

function validateHypothesis(hp, i, byId, version, errors) {
    const where = `cause.hypotheses[${i}]`;
    if (!isObj(hp)) { errors.push(`${where}: não é objeto`); return; }
    const before = errors.length;
    closedKeys(hp, HYPOTHESIS_KEYS, where, errors);
    if (errors.length > before) return;
    if (!isStr(hp.id)) errors.push(`${where}.id`);
    if (!taxonomy.isCategory(hp.category)) errors.push(`${where}.category: fora de ${taxonomy.TAXONOMY_ID}`);
    const supportOk = Object.prototype.hasOwnProperty.call(taxonomy.SUPPORT, hp.support);
    if (!supportOk) errors.push(`${where}.support: esperado MODERATE, WEAK ou UNKNOWN`);
    if (!isStrArray(hp.assertion_ids)) { errors.push(`${where}.assertion_ids`); return; }
    if (new Set(hp.assertion_ids).size !== hp.assertion_ids.length) errors.push(`${where}.assertion_ids: repetida`);
    const refs = [];
    for (const id of hp.assertion_ids) {
        const a = byId.get(id);
        if (a) refs.push(a); else errors.push(`${where}.assertion_ids: ${id} não existe em assertions[]`);
    }
    if (!taxonomy.isCategory(hp.category) || !supportOk || refs.length !== hp.assertion_ids.length) return;
    if (hp.support === 'UNKNOWN') return;
    const contra = contraryFact(hp.category, hp.assertion_ids, byId);
    if (contra) errors.push(`${where}.support: ${hp.support} com FACT contrário (${contra}); só UNKNOWN`);
    if (hp.support === 'WEAK') {
        if (!refs.some(a => a.type === 'REPORT' || a.type === 'HYPOTHESIS')) errors.push(`${where}.support: WEAK exige relato ou hipótese`);
        return;
    }
    // MODERATE: ≥1 FACT que rules/0.1 declara compatível com a categoria; versão precisa declarar a regra.
    if (!refs.some(a => a.type === 'FACT' && rules.isCompatible(hp.category, a.predicate_ref))) {
        errors.push(`${where}.support: MODERATE exige FACT compatível com ${hp.category} em ${rules.RULES_VERSION}`);
    }
    if (version.rules_version !== rules.RULES_VERSION) errors.push(`${where}.support: MODERATE exige rules_version ${rules.RULES_VERSION}`);
}

/** §6.3: cause = { status, hypotheses[] }. UNKNOWN não tem categoria; confirmação humana é da c5. */
function validateCause(cause, version, errors) {
    if (!isObj(cause)) { errors.push('cause: não é objeto'); return; }
    const before = errors.length;
    closedKeys(cause, CAUSE_KEYS, 'cause', errors);
    if (errors.length > before) return;
    if (!CAUSE_STATUSES.includes(cause.status)) errors.push('cause.status');
    if (!Array.isArray(cause.hypotheses)) { errors.push('cause.hypotheses: não é array'); return; }
    if (cause.status === 'UNKNOWN' && cause.hypotheses.length > 0) errors.push('cause: UNKNOWN não carrega hipótese nem categoria');
    if (cause.status === 'HYPOTHESES' && cause.hypotheses.length === 0) errors.push('cause: HYPOTHESES exige ao menos uma hipótese');
    if (cause.status === 'HUMAN_CONFIRMED') {
        if (version.produced_by !== 'human') errors.push('cause: HUMAN_CONFIRMED só em versão produced_by human');
        if (cause.hypotheses.length === 0) errors.push('cause: HUMAN_CONFIRMED exige a hipótese confirmada');
    }
    const byId = new Map();
    if (Array.isArray(version.assertions)) for (const a of version.assertions) if (isObj(a) && isStr(a.id)) byId.set(a.id, a);
    cause.hypotheses.forEach((hp, i) => validateHypothesis(hp, i, byId, version, errors));
    const ids = cause.hypotheses.filter(isObj).map(h => h.id).filter(isStr);
    if (new Set(ids).size !== ids.length) errors.push('cause.hypotheses: id duplicado');
    const cats = cause.hypotheses.filter(isObj).map(h => h.category).filter(taxonomy.isCategory);
    if (new Set(cats).size !== cats.length) errors.push('cause.hypotheses: categoria duplicada');
}

function sourceMap(ctx) {
    const m = new Map();
    if (isObj(ctx) && Array.isArray(ctx.sources)) for (const s of ctx.sources) if (isObj(s) && isStr(s.id)) m.set(s.id, s);
    return m;
}

/** §6.4: recommendation. `human_gate_required` é o literal true; nada aqui concede autorização. */
function validateRecommendation(r, ctx, errors) {
    if (!isObj(r)) { errors.push('recommendation: não é objeto'); return; }
    const before = errors.length;
    closedKeys(r, RECOMMENDATION_KEYS, 'recommendation', errors);
    if (errors.length > before) return;
    if (!RECOMMENDATION_ACTIONS.includes(r.action)) errors.push('recommendation.action: fora do vocabulário da §6.4');
    if (!isStr(r.rationale_ref)) errors.push('recommendation.rationale_ref');
    if (r.human_gate_required !== true) errors.push('recommendation.human_gate_required: deve ser o literal true');
    if (!ROUTE_HINTS.includes(r.route_hint)) errors.push('recommendation.route_hint: fora do vocabulário da §6.4');
    if (!isStrArray(r.depends_on_missing)) { errors.push('recommendation.depends_on_missing'); return; }
    if (new Set(r.depends_on_missing).size !== r.depends_on_missing.length) errors.push('recommendation.depends_on_missing: repetida');
    // O que a recomendação diz depender precisa estar declarado como faltante na mesma versão.
    const declared = new Set();
    if (isObj(ctx) && Array.isArray(ctx.missing)) for (const m of ctx.missing) if (isObj(m) && isStr(m.what)) declared.add(m.what);
    for (const w of r.depends_on_missing) if (!declared.has(w)) errors.push(`recommendation.depends_on_missing: ${w} não existe em context.missing[]`);
}

function validatePlatformSignal(s, i, sourceById, errors) {
    const where = `platform_signals[${i}]`;
    if (!isObj(s)) { errors.push(`${where}: não é objeto`); return; }
    const before = errors.length;
    closedKeys(s, PLATFORM_SIGNAL_KEYS, where, errors);
    if (errors.length > before) return;
    if (!isStr(s.id)) errors.push(`${where}.id`);
    if (!PLATFORM_SIGNAL_KINDS.includes(s.kind)) errors.push(`${where}.kind: esperado ${PLATFORM_SIGNAL_KINDS.join(' ou ')}`);
    if (typeof s.admitted !== 'boolean') errors.push(`${where}.admitted`);
    if (!isStrArray(s.evidence_ids)) { errors.push(`${where}.evidence_ids`); return; }
    for (const e of s.evidence_ids) {
        const src = sourceById.get(e);
        if (!src) errors.push(`${where}.evidence_ids: ${e} não existe em context.sources[]`);
        // INV-5/6: sinal admitido não se apoia em texto externo nem em fonte não admitida.
        else if (s.admitted === true && !(src.trust === 'TRUSTED_SYSTEM' && src.admitted === true)) {
            errors.push(`${where}: sinal admitido só sobre fonte TRUSTED_SYSTEM admitida (${e})`);
        }
    }
}

/** platform_signals[]: preparação bloqueada e spec ausente, fora de `cause`. Lista vazia é válida. */
function validatePlatformSignals(list, ctx, errors) {
    if (!Array.isArray(list)) { errors.push('platform_signals: não é array'); return; }
    const sourceById = sourceMap(ctx);
    const ids = list.filter(isObj).map(s => s.id).filter(isStr);
    if (new Set(ids).size !== ids.length) errors.push('platform_signals: id duplicado');
    list.forEach((s, i) => validatePlatformSignal(s, i, sourceById, errors));
}

/**
 * Valida as seções de conteúdo presentes em `version`.
 * @param {object} version
 * @param {{ isCalendarIso: (s: any) => boolean }} h
 * @returns {{ ok: boolean, errors: string[] }}
 */
function validateContent(version, h) {
    const errors = [];
    if (isObj(version) && Object.prototype.hasOwnProperty.call(version, 'context')) validateContext(version.context, h, errors);
    if (isObj(version) && Object.prototype.hasOwnProperty.call(version, 'assertions')) validateAssertions(version.assertions, version.context, errors);
    if (isObj(version) && Object.prototype.hasOwnProperty.call(version, 'cause')) validateCause(version.cause, version, errors);
    if (isObj(version) && Object.prototype.hasOwnProperty.call(version, 'recommendation')) validateRecommendation(version.recommendation, version.context, errors);
    if (isObj(version) && Object.prototype.hasOwnProperty.call(version, 'platform_signals')) validatePlatformSignals(version.platform_signals, version.context, errors);
    return { ok: errors.length === 0, errors };
}

module.exports = { TRUST_CLASSES, SOURCE_KINDS, SOURCE_KEYS, MISSING_KEYS,
    ASSERTION_TYPES, BASIS_TYPE, ASSERTION_KEYS, CAUSE_STATUSES, CAUSE_KEYS, HYPOTHESIS_KEYS,
    RECOMMENDATION_ACTIONS, ROUTE_HINTS, RECOMMENDATION_KEYS, PLATFORM_SIGNAL_KINDS, PLATFORM_SIGNAL_KEYS, validateContent };
