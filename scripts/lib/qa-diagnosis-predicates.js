'use strict';
// PRI-181 C3 — predicados determinísticos (DB-04).
//
// FACT só quando o predicado é checagem de sistema sobre signals coletados.
// Sem classificar causa de código/ambiente automaticamente (isso fica UNKNOWN /
// WEAK sem prova). Sem nível causal automático.

const taxonomy = require('./qa-diagnosis-taxonomy');

const { CATEGORIES: C, CONFIDENCE: K, assertFactOnlyFromSystem } = taxonomy;

function finding({
    predicate_id,
    category,
    confidence,
    systemPredicate = false,
    summary,
    signal_keys = [],
    lens = null,
}) {
    assertFactOnlyFromSystem(confidence, { systemPredicate });
    return {
        predicate_id,
        category,
        confidence,
        system_predicate: systemPredicate === true,
        summary,
        signal_keys,
        lens, // lentes 28/10 mapeadas sem nova enum
        causal_level: null, // DB-04: sem nível causal automático
    };
}

/**
 * Avalia predicados de sistema sobre o pacote coletado.
 * @returns {{ findings: object[], findings_status: string, taxonomy_version: string }}
 */
function evaluatePredicates(pack) {
    const s = pack?.signals || {};
    const findings = [];

    if (s.has_rejection_key && s.rejection_key) {
        findings.push(finding({
            predicate_id: 'sys.has_rejection_key',
            category: C.IDENTITY,
            confidence: K.FACT,
            systemPredicate: true,
            summary: 'rejection_key presente (identidade C1).',
            signal_keys: ['has_rejection_key', 'rejection_key'],
        }));
    } else {
        findings.push(finding({
            predicate_id: 'sys.missing_rejection_key',
            category: C.IDENTITY,
            confidence: K.FACT,
            systemPredicate: true,
            summary: 'rejection_key ausente — identidade UNKNOWN.',
            signal_keys: ['has_rejection_key'],
            lens: 'information_absent',
        }));
    }

    if (s.identity_quality === 'OK') {
        findings.push(finding({
            predicate_id: 'sys.identity_quality_ok',
            category: C.IDENTITY,
            confidence: K.FACT,
            systemPredicate: true,
            summary: 'identity_quality=OK.',
            signal_keys: ['identity_quality'],
        }));
    } else if (s.identity_quality === 'DEGRADED') {
        findings.push(finding({
            predicate_id: 'sys.identity_quality_degraded',
            category: C.IDENTITY,
            confidence: K.FACT,
            systemPredicate: true,
            summary: 'identity_quality=DEGRADED (ex.: nota fora da transição).',
            signal_keys: ['identity_quality'],
        }));
    } else if (s.identity_quality === 'UNKNOWN' || s.identity_quality == null) {
        findings.push(finding({
            predicate_id: 'sys.identity_quality_unknown',
            category: C.IDENTITY,
            confidence: K.FACT,
            systemPredicate: true,
            summary: 'identity_quality=UNKNOWN ou ausente.',
            signal_keys: ['identity_quality'],
            lens: 'information_absent',
        }));
    }

    if (s.transition_journal_id != null) {
        findings.push(finding({
            predicate_id: 'sys.has_transition_journal',
            category: C.INGESTION,
            confidence: K.FACT,
            systemPredicate: true,
            summary: 'Journal de transição status→13 presente (DB-01).',
            signal_keys: ['transition_journal_id'],
        }));
    } else {
        findings.push(finding({
            predicate_id: 'sys.missing_transition_journal',
            category: C.INGESTION,
            confidence: K.FACT,
            systemPredicate: true,
            summary: 'Sem transition_journal_id.',
            signal_keys: ['transition_journal_id'],
            lens: 'information_absent',
        }));
    }

    findings.push(finding({
        predicate_id: s.note_present ? 'sys.note_present' : 'sys.note_absent',
        category: C.INGESTION,
        confidence: K.FACT,
        systemPredicate: true,
        summary: s.note_present
            ? 'Campo note preenchido (conteúdo não inspecionado pelo predicado).'
            : 'Campo note ausente/vazio.',
        signal_keys: ['note_present'],
        lens: s.note_present ? null : 'information_absent',
    }));

    if (s.retry_requested) {
        findings.push(finding({
            predicate_id: 'sys.retry_already_requested',
            category: C.INGESTION,
            confidence: K.FACT,
            systemPredicate: true,
            summary: 'retry_requested_at presente no qa_rejection.',
            signal_keys: ['retry_requested'],
        }));
    }

    // Sem prova de sistema sobre causa de código/ambiente/spec → UNKNOWN explícito
    // (não inventar FACT causal). Lente "indeterminate".
    findings.push(finding({
        predicate_id: 'sys.cause_indeterminate',
        category: C.INDETERMINATE,
        confidence: K.UNKNOWN,
        systemPredicate: true,
        summary: 'Causa da recusa indeterminada: predicados C3 não classificam código/spec/ambiente sem evidência de sistema adicional.',
        signal_keys: [],
        lens: 'information_absent',
    }));

    const hasFact = findings.some(f => f.confidence === K.FACT);
    const onlyUnknown = findings.every(f => f.confidence === K.UNKNOWN);
    let findings_status = 'EVALUATED';
    if (!findings.length) findings_status = 'UNKNOWN';
    else if (onlyUnknown) findings_status = 'UNKNOWN';
    else if (hasFact) findings_status = 'EVALUATED';

    return {
        findings,
        findings_status,
        taxonomy_version: taxonomy.TAXONOMY_VERSION,
        evaluated_at: new Date().toISOString(),
        causal_auto: false,
    };
}

module.exports = {
    evaluatePredicates,
    finding,
};
