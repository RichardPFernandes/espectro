'use strict';
// PRI-274 c2b-4 — predicados determinísticos pred/0.1 (SDD B v3 §6.2, INV-6, DB-04).
//
// Cada predicado vira uma assertion FACT com basis SYSTEM_PREDICATE e predicate_ref
// `pred:<id>@<ver>`, e só sobre fonte TRUSTED_SYSTEM: com outra classe de confiança nada
// é emitido. Predicado não classifica causa nem categoria (INV-4); a causa é da seção
// `cause` e fica UNKNOWN sem evidência de sistema compatível.

const PREDICATES_VERSION = 'pred/0.1';
const PREDICATE_VER = '0.1';
const TRUSTED = 'TRUSTED_SYSTEM';
const PRED_ID_RE = /^[a-z][a-z0-9_]*$/;

const rules = require('./qa-diagnosis-rules');

// Registro pred/0.1 (G3 I1): FACT só cita predicado deste conjunto. `EMITTED` é o que
// evaluatePredicates produz hoje; `RULE_REFERENCED` são os ids que rules/0.1 usa e que
// ainda não têm produtor (reservados para o produtor determinístico; G3 S3).
const EMITTED = Object.freeze(['has_rejection_key', 'missing_rejection_key', 'identity_quality_ok',
    'identity_quality_degraded', 'identity_quality_unknown', 'has_transition_journal',
    'missing_transition_journal', 'note_present', 'note_absent', 'retry_already_requested']);
const RULE_REFERENCED = Object.freeze([...new Set([...Object.values(rules.COMPATIBLE), ...Object.values(rules.CONTRARY)].flat())]);
const PREDICATE_IDS = Object.freeze([...EMITTED, ...RULE_REFERENCED]);

function systemOnly(code, message) {
    const err = new Error(message);
    err.code = code;
    return err;
}

/** Monta uma assertion FACT. Recusa qualquer fonte que não seja TRUSTED_SYSTEM. */
function factAssertion({ id, predicate_id, trust, evidence_ids = [], statement_ref }) {
    if (typeof statement_ref !== 'string' || statement_ref === '') {
        throw systemOnly('FACT_REQUIRES_STATEMENT_REF', 'statement_ref é obrigatório (o validador recusa FACT sem ele)');
    }
    if (trust !== TRUSTED || typeof predicate_id !== 'string' || !PRED_ID_RE.test(predicate_id)) {
        throw systemOnly('FACT_REQUIRES_SYSTEM_PREDICATE', 'DB-04: FACT só por predicado de sistema sobre fonte TRUSTED_SYSTEM');
    }
    return {
        id,
        type: 'FACT',
        basis: 'SYSTEM_PREDICATE',
        predicate_ref: `pred:${predicate_id}@${PREDICATE_VER}`,
        evidence_ids: [...evidence_ids],
        contradicted_by: [],
        statement_ref,
    };
}

/**
 * Avalia predicados de sistema sobre os signals de um pack.
 * @param {{ trust?: string, signals?: object }} pack
 * @returns {{ assertions: object[], predicates_version: string, causal_auto: false }}
 */
function evaluatePredicates(pack) {
    const out = { assertions: [], predicates_version: PREDICATES_VERSION, causal_auto: false };
    if (pack?.trust !== TRUSTED) return out;
    const s = pack.signals || {};
    const trust = pack.trust;
    const emit = (predicate_id, signal_keys) => out.assertions.push(factAssertion({
        id: `a-${predicate_id}`,
        predicate_id,
        trust,
        statement_ref: `signals:${signal_keys.join(',')}`,
    }));

    if (s.has_rejection_key && s.rejection_key) emit('has_rejection_key', ['has_rejection_key', 'rejection_key']);
    else emit('missing_rejection_key', ['has_rejection_key']);

    if (s.identity_quality === 'OK') emit('identity_quality_ok', ['identity_quality']);
    else if (s.identity_quality === 'DEGRADED') emit('identity_quality_degraded', ['identity_quality']);
    else if (s.identity_quality === 'UNKNOWN' || s.identity_quality == null) emit('identity_quality_unknown', ['identity_quality']);

    if (s.transition_journal_id != null) emit('has_transition_journal', ['transition_journal_id']);
    else emit('missing_transition_journal', ['transition_journal_id']);

    // Presença apenas; o conteúdo da nota nunca é inspecionado pelo predicado (INV-5).
    emit(s.note_present ? 'note_present' : 'note_absent', ['note_present']);

    if (s.retry_requested) emit('retry_already_requested', ['retry_requested']);

    return out;
}

module.exports = {
    PREDICATES_VERSION,
    PREDICATE_VER,
    PREDICATE_IDS,
    evaluatePredicates,
    factAssertion,
};
