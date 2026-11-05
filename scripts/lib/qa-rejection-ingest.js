'use strict';
// PRI-181 C1 — ingestão idempotente de recusa QA (DB-01b / RR-04 / N-08 no caminho).
//
// Responsabilidades:
// - listar transições → 13 a partir dos journals já obtidos;
// - derivar rejection_key + identity_quality (qa-rejection-identity);
// - inserir em qa_rejections sem duplicar a mesma chave;
// - sob trava por rejection_key (mesma primitiva de watcher-lock), falhar fechado
//   se outro writer segura a chave (demonstração N-08 no caminho adotado).
//
// Fora do escopo C1: Diagnosis Record / store imutável (C2), coletor (C3),
// painel/piloto, RRC-003. Não inventa PASS global de N-08 para todos os callers.

const crypto = require('crypto');
const path = require('path');
const qaCycles = require('./qa-cycles');
const identity = require('./qa-rejection-identity');
const watcherLock = require('./watcher-lock');
const { redmineFetch } = require('./redmine-fetch');

const LOCK_ROLE = 'qa-rejection-ingest';

function lockNameForKey(rejectionKey) {
    const digest = crypto.createHash('sha256').update(String(rejectionKey)).digest('hex').slice(0, 16);
    return `prisma-qa-ingest-${digest}.lock`;
}

/** Adquire trava exclusiva da rejection_key. Caller deve release(). */
function acquireKeyLock(rejectionKey, { repoPath, lock = watcherLock, env = {}, role = LOCK_ROLE } = {}) {
    if (!rejectionKey) {
        return { acquired: false, reason: 'missing_key', message: 'rejection_key ausente — sem trava N-08' };
    }
    if (!repoPath) {
        return { acquired: false, reason: 'missing_repo', message: 'repoPath ausente — sem trava N-08' };
    }
    const lockPath = lock.lockPathFor(repoPath, lockNameForKey(rejectionKey));
    // env sem WATCHER_LOCK_TOKEN: nunca nested — exclusão real por chave (N-08).
    const res = lock.acquire({ repoPath, role, env, lockPath });
    if (!res.acquired) {
        return {
            acquired: false,
            reason: res.reason || 'held',
            message: res.message || `rejection_key sob trava concorrente: ${rejectionKey}`,
            path: lockPath,
            holder: res.holder || null,
        };
    }
    return {
        acquired: true,
        path: lockPath,
        nested: !!res.nested,
        release: res.release,
    };
}

function hasRejectionKey(entries, key) {
    if (!key || !Array.isArray(entries)) return false;
    return entries.some(e => e && e.rejection_key === key);
}

function statusNeedsFallback(qaRejection) {
    return !qaRejection || (qaRejection.rejection_key == null && qaRejection.identity_quality == null);
}

function findByKey(entries, key) {
    if (!key || !Array.isArray(entries)) return null;
    return entries.find(e => e && e.rejection_key === key) || null;
}

/**
 * Aplica identidades novas ao state (idempotente por rejection_key).
 * Não publica Diagnosis Record. Não chama Redmine.
 *
 * @returns {{
 *   changed: boolean,
 *   state: object,
 *   ingested: object[],
 *   skipped: object[],
 *   blocked: object[],
 *   n08: { demonstrated_path: true, global_pass: false }
 * }}
 */
function applyIdentities(state, identities, {
    contextMd = '',
    at = new Date().toISOString(),
    repoPath = null,
    lock = watcherLock,
    acquireLock = acquireKeyLock,
    ticketFallbackRejectedAt = null,
    noteSource = null,
} = {}) {
    let entries;
    if (Array.isArray(state?.qa_rejections) && state.qa_rejections.length) {
        entries = state.qa_rejections.slice();
    } else if (state?.qa_rejection && (state.qa_rejection.rejected_at || state.qa_rejection.journal_id != null || state.qa_rejection.rejection_key)) {
        // Materializa histórico legado uma vez (sem inventar entrada vazia).
        entries = qaCycles.recordRejection(
            { ...state, qa_rejections: [] },
            contextMd,
            {
                note: state.qa_rejection.note ?? null,
                rejected_at: state.qa_rejection.rejected_at ?? null,
                journal_id: state.qa_rejection.journal_id ?? null,
                rejection_key: state.qa_rejection.rejection_key ?? null,
                identity_quality: state.qa_rejection.identity_quality ?? null,
                transition_journal_id: state.qa_rejection.transition_journal_id ?? null,
                at: state.qa_rejection.detected_at || at,
            }
        );
    } else {
        entries = [];
    }
    if (!Array.isArray(entries)) entries = [];

    const ingested = [];
    const skipped = [];
    const blocked = [];
    let changed = false;

    for (const idn of identities || []) {
        if (!idn?.rejection_key) {
            skipped.push({ reason: 'no_key', identity: idn });
            continue;
        }
        if (hasRejectionKey(entries, idn.rejection_key)) {
            skipped.push({ reason: 'idempotent', rejection_key: idn.rejection_key });
            continue;
        }

        const held = acquireLock(idn.rejection_key, { repoPath, lock });
        if (!held.acquired) {
            blocked.push({
                reason: 'n08_contention',
                rejection_key: idn.rejection_key,
                lock_reason: held.reason,
                message: held.message,
            });
            continue;
        }
        try {
            // Re-check sob trava (outro writer pode ter gravado entre o scan e o acquire).
            if (hasRejectionKey(entries, idn.rejection_key)) {
                skipped.push({ reason: 'idempotent_under_lock', rejection_key: idn.rejection_key });
                continue;
            }
            const nextEntries = qaCycles.recordRejection(
                { ...state, qa_rejections: entries },
                contextMd,
                {
                    note: idn.note ?? null,
                    rejected_at: idn.rejected_at ?? ticketFallbackRejectedAt,
                    journal_id: idn.note_journal_id ?? idn.transition_journal_id ?? null,
                    rejection_key: idn.rejection_key,
                    identity_quality: idn.identity_quality,
                    transition_journal_id: idn.transition_journal_id,
                    at,
                }
            );
            if (hasRejectionKey(nextEntries, idn.rejection_key) && nextEntries.length > entries.length) {
                entries = nextEntries;
                changed = true;
                ingested.push(idn);
            } else if (hasRejectionKey(nextEntries, idn.rejection_key)) {
                entries = nextEntries;
                skipped.push({ reason: 'idempotent_record', rejection_key: idn.rejection_key });
            } else {
                // Dedup legado por rejected_at (sem chave) — anexa com chave C1.
                entries = [...nextEntries, {
                    n: nextEntries.length + 1,
                    note: idn.note ?? null,
                    rejected_at: idn.rejected_at ?? ticketFallbackRejectedAt,
                    journal_id: idn.note_journal_id ?? idn.transition_journal_id ?? null,
                    rejection_key: idn.rejection_key,
                    identity_quality: idn.identity_quality,
                    transition_journal_id: idn.transition_journal_id,
                    detected_at: at,
                    retry_requested_at: null,
                }];
                changed = true;
                ingested.push(idn);
            }
        } finally {
            try { held.release(); } catch { /* release best-effort */ }
        }
    }

    // qa_rejection: campos legados (note/rejected_at/journal_id) = heurística C0
    // (noteSource + fallback do ticket); campos C1 = última transição → 13.
    const lastWithKey = [...entries].reverse().find(e => e?.rejection_key) || null;
    const latestIdn = (identities || []).filter(i => i?.rejection_key).slice(-1)[0] || null;
    let qaRejection = state?.qa_rejection ? { ...state.qa_rejection } : null;
    // Heurística C0: preferir nota do fetch; se ausente, preservar qa_rejection já
    // gravado (re-poll DB-01b não deve empurrar rejected_at pelo updated_on do ticket).
    const legacyNote = noteSource ? (noteSource.note ?? null) : (qaRejection?.note ?? null);
    const legacyJournalId = noteSource ? (noteSource.journal_id ?? null) : (qaRejection?.journal_id ?? null);
    const legacyRejectedAt = noteSource?.rejected_at
        || qaRejection?.rejected_at
        || ticketFallbackRejectedAt
        || null;

    if (latestIdn) {
        const nextRejection = {
            note: legacyNote,
            rejected_at: legacyRejectedAt,
            journal_id: legacyJournalId,
            rejection_key: latestIdn.rejection_key,
            identity_quality: latestIdn.identity_quality,
            transition_journal_id: latestIdn.transition_journal_id,
            ...(qaRejection?.retry_requested_at ? { retry_requested_at: qaRejection.retry_requested_at } : {}),
        };
        if (JSON.stringify(qaRejection) !== JSON.stringify(nextRejection)) {
            qaRejection = nextRejection;
            changed = true;
        }
    } else if (ticketFallbackRejectedAt && (statusNeedsFallback(qaRejection) || !qaRejection)) {
        qaRejection = {
            note: legacyNote,
            rejected_at: legacyRejectedAt || ticketFallbackRejectedAt,
            journal_id: legacyJournalId,
            rejection_key: null,
            identity_quality: identity.QUALITY.UNKNOWN,
            transition_journal_id: null,
            ...(qaRejection?.retry_requested_at ? { retry_requested_at: qaRejection.retry_requested_at } : {}),
        };
        // Espelha C0: uma entrada de histórico mesmo sem transition journal (UNKNOWN).
        if (!entries.length) {
            entries = qaCycles.recordRejection(
                { ...state, qa_rejections: [] },
                contextMd,
                { ...qaRejection, at }
            );
        }
        changed = true;
    } else if (qaRejection && qaRejection.identity_quality == null && lastWithKey) {
        qaRejection = {
            ...qaRejection,
            rejection_key: lastWithKey.rejection_key ?? null,
            identity_quality: lastWithKey.identity_quality ?? identity.QUALITY.UNKNOWN,
            transition_journal_id: lastWithKey.transition_journal_id ?? null,
        };
        changed = true;
    }

    const nextState = {
        ...state,
        qa_rejections: entries,
        ...(qaRejection ? { qa_rejection: qaRejection } : {}),
    };

    return {
        changed,
        state: nextState,
        ingested,
        skipped,
        blocked,
        n08: {
            demonstrated_path: true,
            global_pass: false,
            note: 'Exclusão demonstrada só no caminho ingest+lock por rejection_key; não certifica todos os callers.',
        },
    };
}

async function fetchIssueJournals(issueId, opts = {}) {
    const url = (opts.redmineUrl ?? process.env.REDMINE_URL ?? '').replace(/\/+$/, '');
    const key = opts.apiKey ?? process.env.REDMINE_API_KEY ?? '';
    const fetchFn = opts.fetch || redmineFetch;
    const log = opts.log || console.warn;
    if (!url || !key || !/^\d+$/.test(String(issueId ?? ''))) return null;
    try {
        const res = await fetchFn(`${url}/issues/${issueId}.json?include=journals`, {
            headers: { 'X-Redmine-API-Key': key, Accept: 'application/json' },
            signal: AbortSignal.timeout(opts.timeoutMs || 15000),
        });
        if (!res.ok) {
            log(`[qa-rejection-ingest] #${issueId}: journals HTTP ${res.status}`);
            return null;
        }
        const data = await res.json();
        return Array.isArray(data?.issue?.journals) ? data.issue.journals : [];
    } catch (e) {
        const msg = e?.name === 'TimeoutError' ? 'timeout' : (e?.message || 'erro');
        log(`[qa-rejection-ingest] #${issueId}: falha buscando journals (${msg})`);
        return null;
    }
}

/**
 * Ingestão C1 a partir de journals + nota heurística (DB-01b: chama mesmo com status igual).
 */
function ingestFromJournals({
    ticketId,
    journals,
    state,
    contextMd = '',
    noteSource = null,
    at = new Date().toISOString(),
    repoPath = null,
    ticketFallbackRejectedAt = null,
    lock = watcherLock,
    acquireLock = acquireKeyLock,
} = {}) {
    const identities = identity.buildIdentitiesFromJournals(ticketId, journals || [], {
        noteSourceForLatest: noteSource,
    });
    return applyIdentities(state, identities, {
        contextMd, at, repoPath, lock, acquireLock, ticketFallbackRejectedAt,
        noteSource,
    });
}

module.exports = {
    LOCK_ROLE,
    lockNameForKey,
    acquireKeyLock,
    hasRejectionKey,
    findByKey,
    applyIdentities,
    fetchIssueJournals,
    ingestFromJournals,
};
