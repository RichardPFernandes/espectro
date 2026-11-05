'use strict';
// PRI-181 C2/C3 — Diagnosis Record.
//
// RR-03=A: NÃO é Context Record. Owner lógico DOM-04 (RR-02=B).
// C3: findings[] via predicados determinísticos (DB-04); sem conteúdo corporativo.

const SCHEMA_VERSION = 'qa-diagnosis-record/v1';

/**
 * Monta Diagnosis Record a partir da identidade C1 (+ metadados / findings C3).
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
    const findings = Array.isArray(meta.findings) ? meta.findings : [];
    const findingsStatus = meta.findings_status
        || (findings.length ? 'EVALUATED' : 'UNKNOWN');
    return {
        schema_version: SCHEMA_VERSION,
        kind: 'diagnosis_record',
        // RR-03=A: não é Context Record
        is_context_record: false,
        context_snapshot_id: meta.context_snapshot_id ?? null,
        context_binding: meta.context_binding || 'UNKNOWN',
        context_binding_note: meta.context_binding_note
            || 'Ponte imutável a Context Record permanece UNKNOWN até attempt/snapshot explícito.',
        rejection_key: key,
        identity_quality: identity.identity_quality ?? 'UNKNOWN',
        transition_journal_id: identity.transition_journal_id ?? null,
        ticket_id: meta.ticket_id ?? null,
        note_journal_id: identity.note_journal_id ?? identity.journal_id ?? null,
        rejected_at: identity.rejected_at ?? null,
        evidence_refs: Array.isArray(meta.evidence_refs) ? meta.evidence_refs : [],
        findings,
        findings_status: findingsStatus,
        findings_note: meta.findings_note
            || (findings.length
                ? 'Findings por predicados de sistema (DB-04); sem nível causal automático.'
                : 'Sem findings avaliados.'),
        taxonomy_version: meta.taxonomy_version || null,
        status: meta.status || 'staged',
        authority: false,
        logical_owner: 'DOM-04',
        created_at: at,
        published_at: null,
        corporate_content_included: meta.corporate_content_included === true,
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
