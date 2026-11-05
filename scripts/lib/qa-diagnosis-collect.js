'use strict';
// PRI-181 C3 — coletor de evidências (metadados de plataforma apenas).
//
// Não lê texto corporativo do ticket como instrução; não copia nota QA para
 // findings. Refs são ids/paths/campos de sistema. Fixtures de teste são sintéticas.

const path = require('path');
const layout = require('./qa-diagnosis-layout');

/**
 * Coleta pacote de evidência a partir do state do run + identidade C1.
 * @returns {{ evidence_refs: object[], signals: object, collected_at: string }}
 */
function collectEvidencePack({
    identity = null,
    state = null,
    ticketId = null,
    repoPath = null,
    taskId = null,
    at = new Date().toISOString(),
} = {}) {
    const signals = {
        has_rejection_key: !!(identity?.rejection_key || state?.qa_rejection?.rejection_key),
        rejection_key: identity?.rejection_key || state?.qa_rejection?.rejection_key || null,
        identity_quality: identity?.identity_quality || state?.qa_rejection?.identity_quality || null,
        transition_journal_id: identity?.transition_journal_id
            ?? state?.qa_rejection?.transition_journal_id
            ?? null,
        note_present: !!(identity?.note ?? state?.qa_rejection?.note),
        // Presença booleana apenas — sem citar o texto da nota
        note_journal_id: identity?.note_journal_id
            ?? identity?.journal_id
            ?? state?.qa_rejection?.journal_id
            ?? null,
        rejected_at: identity?.rejected_at || state?.qa_rejection?.rejected_at || null,
        ticket_status: state?.ticket_status || null,
        retry_requested: !!(state?.qa_rejection?.retry_requested_at),
        qa_rejections_count: Array.isArray(state?.qa_rejections) ? state.qa_rejections.length : 0,
        run_status: state?.status || null,
        run_node: state?.node || null,
        ticket_id: ticketId ?? state?.redmine_ticket?.id ?? null,
        task_id: taskId || state?.task_id || null,
        has_qa_diagnosis_pointer: !!(state?.qa_diagnosis?.rejection_key),
        diagnosis_findings_status: state?.qa_diagnosis?.findings_status || null,
    };

    if (signals.rejection_key && repoPath) {
        const p = layout.pathsFor(repoPath, signals.rejection_key);
        signals.authority_exists = layout.isAuthorityDir(p.authorityDir);
        signals.staging_exists = false;
        try {
            const fs = require('fs');
            signals.staging_exists = fs.existsSync(p.stagingDir);
        } catch { /* ignore */ }
    } else {
        signals.authority_exists = false;
        signals.staging_exists = false;
    }

    const evidence_refs = [];
    if (signals.rejection_key) {
        evidence_refs.push({
            type: 'rejection_key',
            id: signals.rejection_key,
            source: 'qa-rejection-identity',
        });
    }
    if (signals.transition_journal_id != null) {
        evidence_refs.push({
            type: 'transition_journal_id',
            id: String(signals.transition_journal_id),
            source: 'redmine_journal_meta',
        });
    }
    if (signals.ticket_id != null) {
        evidence_refs.push({
            type: 'ticket_id',
            id: String(signals.ticket_id),
            source: 'redmine_ticket_meta',
        });
    }
    if (signals.task_id) {
        evidence_refs.push({
            type: 'task_id',
            id: String(signals.task_id),
            source: 'run_state',
        });
    }
    if (repoPath && signals.rejection_key) {
        const p = layout.pathsFor(repoPath, signals.rejection_key);
        evidence_refs.push({
            type: 'store_authority_path',
            id: path.relative(path.resolve(repoPath), p.authorityDir),
            source: 'qa-diagnosis-layout',
        });
    }

    return {
        collected_at: at,
        taxonomy_scope: 'platform_metadata_only',
        evidence_refs,
        signals,
        // Explicit: sem corpo de nota / descrição / anexos
        corporate_content_included: false,
    };
}

module.exports = {
    collectEvidencePack,
};
