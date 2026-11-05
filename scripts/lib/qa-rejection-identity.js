'use strict';
// PRI-181 C1 — identidade da recusa QA (DB-01 / DB-11).
//
// A identidade canônica é o journal de transição status_id → 13 (Recusa QA),
// não a nota heurística nem a devolução 8→2. Este módulo é puro: recebe journals
// já obtidos; não fala com Redmine nem grava state.
//
// rejection_key (formato C1, estabilidade local até o SDD host fixar outro):
//   qa-rej:v1:t{ticketId}:j{transitionJournalId}
// identity_quality: OK | DEGRADED | UNKNOWN
//
// Não declara N-08 PASS global nem publica Diagnosis Record (C2).

const { QA_REJECTED_STATUS_ID } = require('./redmine-journal-fetcher');

const KEY_PREFIX = 'qa-rej:v1';
const QUALITY = Object.freeze({ OK: 'OK', DEGRADED: 'DEGRADED', UNKNOWN: 'UNKNOWN' });

function isTransitionToRejected(journal) {
    return (journal?.details || []).some(
        d => d.name === 'status_id' && Number(d.new_value) === QA_REJECTED_STATUS_ID
    );
}

/** Journals de transição → 13, em ordem cronológica (id crescente quando empate). */
function listTransitionJournals(journals) {
    if (!Array.isArray(journals)) return [];
    return journals
        .filter(isTransitionToRejected)
        .slice()
        .sort((a, b) => {
            const ta = Date.parse(a.created_on || '') || 0;
            const tb = Date.parse(b.created_on || '') || 0;
            if (ta !== tb) return ta - tb;
            return Number(a.id) - Number(b.id);
        });
}

function rejectionKey(ticketId, transitionJournalId) {
    if (ticketId == null || transitionJournalId == null) return null;
    const t = String(ticketId).trim();
    const j = String(transitionJournalId).trim();
    if (!/^\d+$/.test(t) || !/^\d+$/.test(j)) return null;
    return `${KEY_PREFIX}:t${t}:j${j}`;
}

function parseRejectionKey(key) {
    if (typeof key !== 'string') return null;
    const m = key.match(/^qa-rej:v1:t(\d+):j(\d+)$/);
    if (!m) return null;
    return { ticket_id: Number(m[1]), transition_journal_id: Number(m[2]) };
}

/**
 * Identidade de uma transição → 13.
 * @param {object} opts
 * @param {number|string} opts.ticketId
 * @param {object} opts.transitionJournal — journal com status_id → 13
 * @param {object|null} [opts.noteSource] — resultado de fetchLastRejectionNote (pode ser outro journal)
 * @param {object[]} [opts.allTransitions] — todas as transições do ticket (para ambiguidade temporal)
 */
function buildIdentity({ ticketId, transitionJournal, noteSource = null, allTransitions = null } = {}) {
    if (!transitionJournal || transitionJournal.id == null) {
        return {
            rejection_key: null,
            identity_quality: QUALITY.UNKNOWN,
            transition_journal_id: null,
            rejected_at: noteSource?.rejected_at ?? null,
            note: noteSource?.note ?? null,
            note_journal_id: noteSource?.journal_id ?? null,
            reason: 'missing_transition_journal',
        };
    }

    const transitionId = Number(transitionJournal.id);
    const key = rejectionKey(ticketId, transitionId);
    const rejectedAt = transitionJournal.created_on || noteSource?.rejected_at || null;
    const noteJournalId = noteSource?.journal_id != null ? Number(noteSource.journal_id) : null;
    const noteOnTransition = noteJournalId != null && noteJournalId === transitionId;

    const siblings = Array.isArray(allTransitions) ? allTransitions : [transitionJournal];
    const sameInstant = siblings.filter(j =>
        j.id !== transitionJournal.id
        && j.created_on
        && transitionJournal.created_on
        && j.created_on === transitionJournal.created_on
    );

    let quality = QUALITY.OK;
    let reason = 'transition_journal';
    if (!key) {
        quality = QUALITY.UNKNOWN;
        reason = 'invalid_key_inputs';
    } else if (sameInstant.length > 0) {
        // Duas transições no mesmo segundo: chave ainda é o journal_id (DB-01),
        // mas a qualidade degrada — fixtures legacy_ambiguous.
        quality = QUALITY.DEGRADED;
        reason = 'ambiguous_same_instant';
    } else if (noteSource && noteJournalId != null && !noteOnTransition) {
        // Nota veio de bounce/heurística (ex. 8→2), não do journal → 13 (DB-11 lacuna).
        quality = QUALITY.DEGRADED;
        reason = 'note_not_on_transition';
    }

    return {
        rejection_key: key,
        identity_quality: quality,
        transition_journal_id: transitionId,
        rejected_at: rejectedAt,
        note: noteSource?.note ?? null,
        note_journal_id: noteJournalId,
        reason,
    };
}

/**
 * Monta identidades para todas as transições → 13 do lote de journals.
 * noteByTransition: Map/object opcional transitionId → noteSource.
 */
function buildIdentitiesFromJournals(ticketId, journals, { noteSourceForLatest = null } = {}) {
    const transitions = listTransitionJournals(journals);
    const latestTransition = transitions[transitions.length - 1] || null;
    return transitions.map(tj => {
        const noteSource = latestTransition && tj.id === latestTransition.id
            ? noteSourceForLatest
            : null;
        return buildIdentity({
            ticketId,
            transitionJournal: tj,
            noteSource,
            allTransitions: transitions,
        });
    });
}

module.exports = {
    KEY_PREFIX,
    QUALITY,
    isTransitionToRejected,
    listTransitionJournals,
    rejectionKey,
    parseRejectionKey,
    buildIdentity,
    buildIdentitiesFromJournals,
};
