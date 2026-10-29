// Sincronização de horas Redmine a partir de cost_tracking dos runs.
// Usada pelo one-shot de backfill (scripts/backfill-redmine-hours.js) e pelo
// caminho live do /commit (scripts/sync-redmine-hours-live.js → syncRunHoursLive).
// Os dois compartilham o marcador [prisma-hours:<taskId>] — sem duplicar entry.
//
// Fonte das horas: duration_ms de state.cost_tracking.totals (preferido) ou
// memory/runs/<ticket>-cost.json → tasks[<taskId>].totals.duration_ms.
// Destino: time entry Redmine (activity padrão = Desenvolvimento), comentário
// com marcador [prisma-hours:<taskId>] pra não duplicar.

'use strict';

const fs = require('fs');
const path = require('path');

const MARKER_PREFIX = '[prisma-hours:';
const DEFAULT_ACTIVITY_ID = 9; // "Desenvolvimento" no Redmine M&O
const DEFAULT_MIN_HOURS = 0.01;

function hoursMarker(taskId) {
    return `${MARKER_PREFIX}${taskId}]`;
}

function markerOfComments(comments) {
    if (!comments) return null;
    const m = String(comments).match(/\[prisma-hours:([^\]]+)\]/);
    return m ? m[1] : null;
}

function hoursFromDurationMs(durationMs, { minHours = DEFAULT_MIN_HOURS, decimals = 2 } = {}) {
    if (durationMs == null || !Number.isFinite(durationMs) || durationMs <= 0) return null;
    const raw = durationMs / 3_600_000;
    const factor = 10 ** decimals;
    const rounded = Math.round(raw * factor) / factor;
    if (rounded <= 0) return minHours;
    return Math.max(rounded, minHours);
}

function ticketIdOf(taskId) {
    const m = String(taskId || '').match(/^(\d{4,6})(?:-|$)/);
    return m ? Number(m[1]) : null;
}

function readJsonSafe(file) {
    try {
        return { ok: true, value: JSON.parse(fs.readFileSync(file, 'utf8')) };
    } catch (err) {
        if (err && (err.code === 'ENOENT' || err.name === 'SyntaxError')) {
            return { ok: false, error: err.message };
        }
        throw err;
    }
}

function durationFromState(state) {
    const totals = state?.cost_tracking?.totals;
    const ms = totals?.duration_ms;
    return Number.isFinite(ms) && ms > 0 ? ms : null;
}

function durationFromCostLedger(runsDir, ticketId, taskId) {
    if (!ticketId || !taskId) return null;
    const costPath = path.join(runsDir, `${ticketId}-cost.json`);
    const read = readJsonSafe(costPath);
    if (!read.ok) return null;
    const task = read.value?.tasks?.[taskId];
    const ms = task?.totals?.duration_ms;
    if (Number.isFinite(ms) && ms > 0) return ms;
    const nodes = task?.nodes || {};
    let sum = 0;
    for (const n of Object.values(nodes)) sum += Number(n?.duration_ms) || 0;
    return sum > 0 ? sum : null;
}

function spentOnFromState(state) {
    const candidates = [
        state?.committed_at,
        state?.updated_at,
        state?.node_started_at,
        state?.started_at,
    ];
    for (const raw of candidates) {
        if (!raw) continue;
        const t = Date.parse(raw);
        if (!Number.isNaN(t)) return new Date(t).toISOString().slice(0, 10);
    }
    return new Date().toISOString().slice(0, 10);
}

function buildTimeEntryPayload({
    issueId,
    hours,
    spentOn,
    comments,
    activityId = DEFAULT_ACTIVITY_ID,
    userId = null,
}) {
    const entry = {
        issue_id: Number(issueId),
        hours: Number(hours),
        spent_on: spentOn,
        activity_id: Number(activityId),
        comments: String(comments),
    };
    if (userId != null) entry.user_id = Number(userId);
    return { time_entry: entry };
}

// YYYY-MM da rotação oficial (scripts/cleanup-runs.js → memory/archive/<mês>/).
const ROTATED_MONTH_RE = /^\d{4}-\d{2}$/;

function listSubdirs(dir) {
    let names = [];
    try {
        names = fs.readdirSync(dir);
    } catch {
        return [];
    }
    const out = [];
    for (const name of names) {
        if (name.startsWith('.')) continue;
        const abs = path.join(dir, name);
        try {
            if (!fs.statSync(abs).isDirectory()) continue;
        } catch {
            continue;
        }
        out.push({ name, abs });
    }
    return out;
}

// Varre memory/runs/ (ativos), memory/runs/_archive/ e a rotação
// memory/archive/<YYYY-MM>/ (irmã de runs/, via cleanup-runs.js). Sem a
// terceira árvore o one-shot omite ciclos já rotacionados.
function listRunDirs(runsDir, { includeArchive = true, includeActive = true } = {}) {
    const out = [];
    const pushDir = (abs, archived) => {
        const statePath = path.join(abs, 'state.json');
        if (!fs.existsSync(statePath)) return;
        out.push({
            taskId: path.basename(abs),
            dir: abs,
            archived,
            statePath,
        });
    };

    if (includeActive) {
        for (const { name, abs } of listSubdirs(runsDir)) {
            if (name === '_archive') continue;
            pushDir(abs, false);
        }
    }

    if (includeArchive) {
        for (const { abs } of listSubdirs(path.join(runsDir, '_archive'))) {
            pushDir(abs, true);
        }
        // memory/archive/<YYYY-MM>/<task>/ — mesma política de cleanup-runs /
        // run-comparator / cleanup-transcripts.
        const rotatedRoot = path.join(path.dirname(runsDir), 'archive');
        for (const { name: month, abs: monthDir } of listSubdirs(rotatedRoot)) {
            if (!ROTATED_MONTH_RE.test(month)) continue;
            for (const { abs } of listSubdirs(monthDir)) {
                pushDir(abs, true);
            }
        }
    }
    return out;
}

function buildCandidate(entry, runsDir, { minHours = DEFAULT_MIN_HOURS, since = null, ticketIds = null } = {}) {
    const read = readJsonSafe(entry.statePath);
    if (!read.ok) {
        return { ok: false, taskId: entry.taskId, action: 'skip', reason: `state_unreadable:${read.error}` };
    }
    const state = read.value;
    // Só confia em redmine_ticket.id — taskIds tipo "2026-09-21-..." casariam
    // o prefixo numérico e inventariam ticket #2026.
    const ticketId = state?.redmine_ticket?.id;
    if (!ticketId) {
        return { ok: false, taskId: entry.taskId, action: 'skip', reason: 'no_ticket' };
    }
    if (ticketIds && ticketIds.size && !ticketIds.has(Number(ticketId))) {
        return { ok: false, taskId: entry.taskId, ticketId, action: 'skip', reason: 'ticket_filter' };
    }
    if (since) {
        const t = Date.parse(state.updated_at || state.started_at || 0);
        if (!Number.isNaN(t) && t < since.getTime()) {
            return { ok: false, taskId: entry.taskId, ticketId, action: 'skip', reason: 'before_since' };
        }
    }

    let source = 'state.cost_tracking';
    let durationMs = durationFromState(state);
    if (durationMs == null) {
        durationMs = durationFromCostLedger(runsDir, ticketId, entry.taskId);
        source = 'cost.json';
    }
    if (durationMs == null) {
        return { ok: false, taskId: entry.taskId, ticketId, action: 'skip', reason: 'no_duration' };
    }

    const hours = hoursFromDurationMs(durationMs, { minHours });
    if (hours == null) {
        return { ok: false, taskId: entry.taskId, ticketId, action: 'skip', reason: 'hours_zero' };
    }

    const marker = hoursMarker(entry.taskId);
    const spentOn = spentOnFromState(state);
    const comments = [
        `Horas do ciclo Prisma (wall-clock cost_tracking).`,
        `Fonte: ${source}; duration_ms=${durationMs}.`,
        marker,
    ].join(' ');

    return {
        ok: true,
        taskId: entry.taskId,
        ticketId: Number(ticketId),
        archived: entry.archived,
        status: state.status || null,
        durationMs,
        hours,
        spentOn,
        source,
        marker,
        comments,
        payload: buildTimeEntryPayload({
            issueId: ticketId,
            hours,
            spentOn,
            comments,
        }),
    };
}

function collectCandidates(runsDir, opts = {}) {
    const {
        includeArchive = true,
        includeActive = false,
        minHours = DEFAULT_MIN_HOURS,
        since = null,
        ticketIds = null,
        limit = null,
    } = opts;

    const dirs = listRunDirs(runsDir, { includeArchive, includeActive });
    const out = [];
    for (const entry of dirs) {
        const c = buildCandidate(entry, runsDir, { minHours, since, ticketIds });
        if (!c.ok) {
            out.push(c);
            continue;
        }
        out.push(c);
        if (limit != null && out.filter(x => x.ok).length >= limit) break;
    }
    return out;
}

function findExistingMarker(entries, taskId) {
    const want = String(taskId);
    for (const e of entries || []) {
        const id = markerOfComments(e.comments);
        if (id === want) return e;
    }
    return null;
}

// Pagina GET /time_entries.json (limit=100) até esgotar total_count /
// página curta. Sem offset, marcador fora da 1ª página → risco de POST duplicado.
async function listTimeEntries(redmineFetch, { baseUrl, apiKey, issueId, pageLimit = 100 } = {}) {
    const all = [];
    let offset = 0;
    const limit = Math.max(1, Number(pageLimit) || 100);

    for (;;) {
        const url = new URL('/time_entries.json', baseUrl);
        url.searchParams.set('issue_id', String(issueId));
        url.searchParams.set('limit', String(limit));
        url.searchParams.set('offset', String(offset));
        const res = await redmineFetch(url, {
            headers: { 'X-Redmine-API-Key': apiKey, Accept: 'application/json' },
        });
        if (!res.ok) {
            const body = await res.text().catch(() => '');
            const err = new Error(`GET time_entries #${issueId}: HTTP ${res.status}`);
            err.statusCode = res.status;
            err.body = body;
            throw err;
        }
        const json = await res.json();
        const page = json.time_entries || [];
        all.push(...page);

        const total = Number(json.total_count);
        if (Number.isFinite(total) && all.length >= total) break;
        if (page.length < limit) break;
        offset += page.length;
        // Guarda contra loop se a API ignorar offset e repetir a mesma página.
        if (page.length === 0) break;
    }
    return all;
}

async function createTimeEntry(redmineFetch, { baseUrl, apiKey, payload }) {
    const url = new URL('/time_entries.json', baseUrl);
    const res = await redmineFetch(url, {
        method: 'POST',
        headers: {
            'X-Redmine-API-Key': apiKey,
            'Content-Type': 'application/json',
            Accept: 'application/json',
        },
        body: JSON.stringify(payload),
    });
    const text = await res.text().catch(() => '');
    if (!res.ok) {
        const err = new Error(`POST time_entries: HTTP ${res.status}`);
        err.statusCode = res.status;
        err.body = text;
        throw err;
    }
    try {
        return JSON.parse(text);
    } catch {
        return { raw: text };
    }
}

async function syncCandidateHours(candidate, {
    dryRun = true,
    redmineFetch,
    baseUrl,
    apiKey,
    fillEvenIfSpent = false,
    activityId = DEFAULT_ACTIVITY_ID,
    // Map issueId → horas já contabilizadas neste batch (would_create/created).
    // Dry-run não POSTa; sem isto o 2º run do mesmo ticket também seria
    // would_create, enquanto o apply grava 1 e skipa o resto via spent.
    batchSpentByIssue = null,
} = {}) {
    if (!candidate?.ok) {
        return { ...candidate, dryRun };
    }

    const payload = {
        ...candidate.payload,
        time_entry: {
            ...candidate.payload.time_entry,
            activity_id: Number(activityId),
        },
    };

    let existing = [];
    try {
        existing = await listTimeEntries(redmineFetch, { baseUrl, apiKey, issueId: candidate.ticketId });
    } catch (err) {
        return {
            ok: false,
            taskId: candidate.taskId,
            ticketId: candidate.ticketId,
            action: 'error',
            reason: `list_failed:${err.message}`,
            statusCode: err.statusCode || null,
            dryRun,
        };
    }

    const prior = findExistingMarker(existing, candidate.taskId);
    if (prior) {
        return {
            ok: true,
            taskId: candidate.taskId,
            ticketId: candidate.ticketId,
            hours: candidate.hours,
            action: 'skip',
            reason: 'already_synced',
            existingEntryId: prior.id,
            dryRun,
        };
    }

    const remoteSpent = existing.reduce((acc, e) => acc + (Number(e.hours) || 0), 0);
    const batchSpent = batchSpentByIssue
        ? Number(batchSpentByIssue.get(Number(candidate.ticketId)) || 0)
        : 0;
    const spentSum = remoteSpent + batchSpent;
    if (!fillEvenIfSpent && spentSum > 0) {
        return {
            ok: true,
            taskId: candidate.taskId,
            ticketId: candidate.ticketId,
            hours: candidate.hours,
            action: 'skip',
            reason: 'issue_already_has_spent',
            spentSum,
            dryRun,
        };
    }

    if (dryRun) {
        if (batchSpentByIssue) {
            const tid = Number(candidate.ticketId);
            batchSpentByIssue.set(tid, batchSpent + (Number(candidate.hours) || 0));
        }
        return {
            ok: true,
            taskId: candidate.taskId,
            ticketId: candidate.ticketId,
            hours: candidate.hours,
            spentOn: candidate.spentOn,
            source: candidate.source,
            action: 'would_create',
            payload,
            dryRun: true,
        };
    }

    try {
        const created = await createTimeEntry(redmineFetch, { baseUrl, apiKey, payload });
        if (batchSpentByIssue) {
            const tid = Number(candidate.ticketId);
            batchSpentByIssue.set(tid, batchSpent + (Number(candidate.hours) || 0));
        }
        return {
            ok: true,
            taskId: candidate.taskId,
            ticketId: candidate.ticketId,
            hours: candidate.hours,
            spentOn: candidate.spentOn,
            source: candidate.source,
            action: 'created',
            entryId: created?.time_entry?.id ?? null,
            dryRun: false,
        };
    } catch (err) {
        return {
            ok: false,
            taskId: candidate.taskId,
            ticketId: candidate.ticketId,
            hours: candidate.hours,
            action: 'error',
            reason: `create_failed:${err.message}`,
            statusCode: err.statusCode || null,
            body: err.body || null,
            dryRun: false,
        };
    }
}

// Dado um run dir (ativo ou em _archive/), devolve o memory/runs pai.
function runsDirOf(runDir) {
    const abs = path.resolve(runDir);
    const parent = path.dirname(abs);
    if (path.basename(parent) === '_archive') return path.dirname(parent);
    return parent;
}

function entryFromRunDir(runDir) {
    const abs = path.resolve(runDir);
    const parent = path.dirname(abs);
    return {
        taskId: path.basename(abs),
        dir: abs,
        archived: path.basename(parent) === '_archive',
        statePath: path.join(abs, 'state.json'),
    };
}

// Hot path (/commit): sincroniza horas de UM run. fillEvenIfSpent=true por
// padrão — o marcador [prisma-hours:task] evita duplicata; spent prévio de
// humanos/outros ciclos não deve silenciar o apontamento deste ciclo.
// Com attemptFile, o POST passa por DOM06 redmine-effect (obrigação
// redmine_hours); sem attempt, usa createTimeEntry direto (mesma API).
async function syncRunHoursLive(runDir, {
    dryRun = false,
    redmineFetch,
    baseUrl,
    apiKey,
    fillEvenIfSpent = true,
    activityId = DEFAULT_ACTIVITY_ID,
    minHours = DEFAULT_MIN_HOURS,
    attemptFile = null,
    env = process.env,
} = {}) {
    if (!runDir) {
        return { ok: false, action: 'skip', reason: 'no_run_dir', dryRun };
    }
    const entry = entryFromRunDir(runDir);
    if (!fs.existsSync(entry.statePath)) {
        return { ok: false, taskId: entry.taskId, action: 'skip', reason: 'no_state', dryRun };
    }
    const runsDir = runsDirOf(runDir);
    const candidate = buildCandidate(entry, runsDir, { minHours });
    if (!candidate.ok) {
        return { ...candidate, dryRun };
    }

    // Sem Attempt: mesmo caminho do backfill (GET + POST via redmineFetch).
    if (!attemptFile) {
        return syncCandidateHours(candidate, {
            dryRun,
            redmineFetch,
            baseUrl,
            apiKey,
            fillEvenIfSpent,
            activityId,
        });
    }

    // Com Attempt: idempotência + listagem iguais; create via redmine-effect.
    const payload = {
        ...candidate.payload,
        time_entry: {
            ...candidate.payload.time_entry,
            activity_id: Number(activityId),
        },
    };

    let existing = [];
    try {
        existing = await listTimeEntries(redmineFetch, { baseUrl, apiKey, issueId: candidate.ticketId });
    } catch (err) {
        return {
            ok: false,
            taskId: candidate.taskId,
            ticketId: candidate.ticketId,
            action: 'error',
            reason: `list_failed:${err.message}`,
            statusCode: err.statusCode || null,
            dryRun,
        };
    }

    const prior = findExistingMarker(existing, candidate.taskId);
    if (prior) {
        return {
            ok: true,
            taskId: candidate.taskId,
            ticketId: candidate.ticketId,
            hours: candidate.hours,
            action: 'skip',
            reason: 'already_synced',
            existingEntryId: prior.id,
            dryRun,
        };
    }

    const spentSum = existing.reduce((acc, e) => acc + (Number(e.hours) || 0), 0);
    if (!fillEvenIfSpent && spentSum > 0) {
        return {
            ok: true,
            taskId: candidate.taskId,
            ticketId: candidate.ticketId,
            hours: candidate.hours,
            action: 'skip',
            reason: 'issue_already_has_spent',
            spentSum,
            dryRun,
        };
    }

    if (dryRun) {
        return {
            ok: true,
            taskId: candidate.taskId,
            ticketId: candidate.ticketId,
            hours: candidate.hours,
            spentOn: candidate.spentOn,
            source: candidate.source,
            action: 'would_create',
            payload,
            dryRun: true,
        };
    }

    const { redmineEffect } = require('./dom06-attempt');
    const url = new URL('/time_entries.json', baseUrl).href;
    // Não passa redmineFetch como fetchImpl: redmineEffect monta o próprio
    // createRedmineFetch a partir do env (e, em testes, um fetch cru).
    const effect = await redmineEffect(attemptFile, {
        url,
        method: 'POST',
        body: JSON.stringify(payload),
        obligationId: 'redmine_hours',
        // Marcador estável por task — DUPLICATE se o /commit repetir o passo.
        idempotencyKey: hoursMarker(candidate.taskId),
        env,
    });

    if (effect.error === 'REDMINE_API_KEY_MISSING') {
        return {
            ok: false,
            taskId: candidate.taskId,
            ticketId: candidate.ticketId,
            hours: candidate.hours,
            action: 'error',
            reason: 'REDMINE_API_KEY_MISSING',
            dryRun: false,
        };
    }
    if (effect.duplicate) {
        return {
            ok: true,
            taskId: candidate.taskId,
            ticketId: candidate.ticketId,
            hours: candidate.hours,
            action: 'skip',
            reason: 'already_synced',
            dryRun: false,
            via: 'dom06_duplicate',
        };
    }
    if (!effect.ok) {
        return {
            ok: false,
            taskId: candidate.taskId,
            ticketId: candidate.ticketId,
            hours: candidate.hours,
            action: 'error',
            reason: `dom06:${effect.error}`,
            statusCode: effect.status || null,
            dryRun: false,
        };
    }
    return {
        ok: true,
        taskId: candidate.taskId,
        ticketId: candidate.ticketId,
        hours: candidate.hours,
        spentOn: candidate.spentOn,
        source: candidate.source,
        action: 'created',
        dryRun: false,
        via: 'dom06_redmine_effect',
    };
}

async function runBackfill({
    runsDir,
    dryRun = true,
    redmineFetch,
    baseUrl,
    apiKey,
    includeArchive = true,
    includeActive = false,
    minHours = DEFAULT_MIN_HOURS,
    since = null,
    ticketIds = null,
    limit = null,
    fillEvenIfSpent = false,
    activityId = DEFAULT_ACTIVITY_ID,
    onProgress = null,
} = {}) {
    if (onProgress) onProgress({ phase: 'scan', action: 'scanning', message: 'Coletando runs…' });

    const candidates = collectCandidates(runsDir, {
        includeArchive,
        includeActive,
        minHours,
        since,
        ticketIds,
        limit,
    });

    const actionable = candidates.filter(c => c.ok);
    if (onProgress) {
        onProgress({
            phase: 'scan_done',
            action: 'scan_done',
            message: `${candidates.length} runs lidos · ${actionable.length} com horas`,
            total: candidates.length,
            actionable: actionable.length,
        });
    }

    // Acumula spent que este batch criaria/criou — dry-run e apply com o
    // mesmo critério "uma entry por ticket" (sem --fill-even-if-spent).
    const batchSpentByIssue = new Map();

    const results = [];
    let i = 0;
    for (const c of candidates) {
        i += 1;
        if (!c.ok) {
            const skip = { ...c, dryRun, phase: 'sync', index: i, total: candidates.length };
            results.push(skip);
            if (onProgress) onProgress(skip);
            continue;
        }
        const r = await syncCandidateHours(c, {
            dryRun,
            redmineFetch,
            baseUrl,
            apiKey,
            fillEvenIfSpent,
            activityId,
            batchSpentByIssue,
        });
        const row = { ...r, phase: 'sync', index: i, total: candidates.length };
        results.push(row);
        if (onProgress) onProgress(row);
    }

    const summary = {
        dryRun,
        total: results.length,
        actionable: results.filter(r => r.action === 'would_create' || r.action === 'created').length,
        skipped: results.filter(r => r.action === 'skip').length,
        errors: results.filter(r => r.action === 'error' || (r.ok === false && r.action !== 'skip')).length,
        hoursWouldSync: Number(
            results
                .filter(r => r.action === 'would_create' || r.action === 'created')
                .reduce((acc, r) => acc + (Number(r.hours) || 0), 0)
                .toFixed(2),
        ),
    };

    return { summary, results };
}

module.exports = {
    MARKER_PREFIX,
    DEFAULT_ACTIVITY_ID,
    DEFAULT_MIN_HOURS,
    hoursMarker,
    markerOfComments,
    hoursFromDurationMs,
    ticketIdOf,
    durationFromState,
    durationFromCostLedger,
    spentOnFromState,
    buildTimeEntryPayload,
    listRunDirs,
    buildCandidate,
    collectCandidates,
    findExistingMarker,
    listTimeEntries,
    createTimeEntry,
    syncCandidateHours,
    runsDirOf,
    entryFromRunDir,
    syncRunHoursLive,
    runBackfill,
};
