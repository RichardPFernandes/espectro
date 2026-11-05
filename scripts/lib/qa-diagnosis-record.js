'use strict';
// PRI-181 C2 — Diagnosis Record (casca estrutural; sem predicados C3).
//
// RR-03=A: NÃO é Context Record. Ponte de contexto fica UNKNOWN até binding
// explícito (C3+/attempt). Owner lógico DOM-04 (RR-02=B) — este módulo só monta
 // o artefato; publicação é qa-diagnosis-publish.js.
//
// C3 (coletor/predicados) NÃO autorizado — findings[] permanece vazio / UNKNOWN.

const SCHEMA_VERSION = 'qa-diagnosis-record/v1';

/**
 * Monta Diagnosis Record a partir da identidade C1 (+ metadados de publicação).
 * @param {object} identity — rejection_key, identity_quality, transition_journal_id, …
 * @param {object} [meta]
 */
function buildDiagnosisRecord(identity, meta = {}) {
    const key = identity?.rejection_key ?? null;
    if (!key) {
        const err = new Error('Diagnosis Record exige rejection_key (C1)');
        err.code = 'MISSING_REJECTION_KEY';
        throw err;
    }
    const at = meta.published_at || meta.at || new Date().toISOString();
    return {
        schema_version: SCHEMA_VERSION,
        kind: 'diagnosis_record',
        // RR-03=A: não é Context Record
        is_context_record: false,
        context_snapshot_id: null,
        context_binding: 'UNKNOWN',
        context_binding_note: 'Ponte imutável a Context Record fica UNKNOWN até C3+/attempt; C2 só publica casca.',
        rejection_key: key,
        identity_quality: identity.identity_quality ?? 'UNKNOWN',
        transition_journal_id: identity.transition_journal_id ?? null,
        ticket_id: meta.ticket_id ?? null,
        note_journal_id: identity.note_journal_id ?? identity.journal_id ?? null,
        rejected_at: identity.rejected_at ?? null,
        evidence_refs: Array.isArray(meta.evidence_refs) ? meta.evidence_refs : [],
        // C3 não autorizado: sem predicados FACT
        findings: [],
        findings_status: 'UNKNOWN',
        findings_note: 'Coletor/predicados (C3) não autorizado nesta fatia.',
        taxonomy_version: null,
        status: meta.status || 'staged',
        authority: false,
        logical_owner: 'DOM-04',
        created_at: at,
        published_at: null,
    };
}

function markPublished(record, { published_at = new Date().toISOString(), authority_path = null } = {}) {
    return {
        ...record,
        status: 'published',
        authority: true,
        published_at,
        authority_path: authority_path ?? record.authority_path ?? null,
    };
}

function markStaged(record) {
    return {
        ...record,
        status: 'staged',
        authority: false,
        published_at: null,
    };
}

module.exports = {
    SCHEMA_VERSION,
    buildDiagnosisRecord,
    markPublished,
    markStaged,
};
