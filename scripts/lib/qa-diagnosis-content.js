'use strict';
// PRI-274 c2b-4 — validação das seções de conteúdo da versão (SDD B v3 §6.1–6.4).
//
// JavaScript puro, sem ajv e sem I/O (como a c2b-1): a condição (e) do §4.3.1 não pode
// passar por falta de validador. Cada seção é validada por uma função própria; as seções
// ainda não cobertas pela fatia (cause, recommendation, platform_signals) não são tocadas aqui. Seção ausente é válida: o protocolo da c2b-2 produz versão só com cabeçalho.
//
// `isCalendarIso` vem injetado pelo model, que importa este módulo (evita ciclo).

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
    const sourceById = new Map();
    if (isObj(ctx) && Array.isArray(ctx.sources)) for (const s of ctx.sources) if (isObj(s) && isStr(s.id)) sourceById.set(s.id, s);
    const ids = list.filter(isObj).map(a => a.id).filter(isStr);
    if (new Set(ids).size !== ids.length) errors.push('assertions: id duplicado');
    const assertionIds = new Set(ids);
    list.forEach((a, i) => validateAssertion(a, i, sourceById, assertionIds, errors));
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
    return { ok: errors.length === 0, errors };
}

module.exports = { TRUST_CLASSES, SOURCE_KINDS, SOURCE_KEYS, MISSING_KEYS,
    ASSERTION_TYPES, BASIS_TYPE, ASSERTION_KEYS, validateContent };
