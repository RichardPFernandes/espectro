'use strict';
// PRI-274 c2b-4 — validação das seções de conteúdo da versão (SDD B v3 §6.1–6.4).
//
// JavaScript puro, sem ajv e sem I/O (como a c2b-1): a condição (e) do §4.3.1 não pode
// passar por falta de validador. Cada seção é validada por uma função própria; as seções
// ainda não cobertas pela fatia (assertions, cause, recommendation, platform_signals) não
// são tocadas aqui. Seção ausente é válida: o protocolo da c2b-2 produz versão só com cabeçalho.
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

/**
 * Valida as seções de conteúdo presentes em `version`.
 * @param {object} version
 * @param {{ isCalendarIso: (s: any) => boolean }} h
 * @returns {{ ok: boolean, errors: string[] }}
 */
function validateContent(version, h) {
    const errors = [];
    if (isObj(version) && Object.prototype.hasOwnProperty.call(version, 'context')) validateContext(version.context, h, errors);
    return { ok: errors.length === 0, errors };
}

module.exports = { TRUST_CLASSES, SOURCE_KINDS, SOURCE_KEYS, MISSING_KEYS, validateContent };
