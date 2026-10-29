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
// Regra de negócio (Richard): duration → horas Redmine sempre sobe para o
// próximo múltiplo de 0,5 h (meio-hora / hora cheia). Qualquer duração > 0
// vira no mínimo 0,5 h. DEFAULT_STEP_HOURS = alias compat (#67).
const HOURS_STEP = 0.5;
const DEFAULT_STEP_HOURS = HOURS_STEP;
const DEFAULT_MIN_HOURS = HOURS_STEP;

function hoursMarker(taskId) {
    return `${MARKER_PREFIX}${taskId}]`;
}

function markerOfComments(comments) {
    if (!comments) return null;
    const m = String(comments).match(/\[prisma-hours:([^\]]+)\]/);
    return m ? m[1] : null;
}

// Ceil para o próximo múltiplo de `step`/`stepHours` (padrão 0,5 h).
// Ex.: 0.1→0.5, 0.6→1.0, 1.01→1.5; valores já no degrau ficam iguais.
function hoursFromDurationMs(durationMs, {
    minHours = DEFAULT_MIN_HOURS,
    step = HOURS_STEP,
    stepHours = null,
} = {}) {
    if (durationMs == null || !Number.isFinite(durationMs) || durationMs <= 0) return null;
    const stepVal = Number(stepHours != null ? stepHours : step);
    if (!Number.isFinite(stepVal) || stepVal <= 0) {
        throw new TypeError('hoursFromDurationMs: step/stepHours deve ser > 0');
    }
    const raw = durationMs / 3_600_000;
    // Epsilon evita que múltiplo exato (ex. 1.0h) suba um degrau por float.
    const units = raw / stepVal;
    const ceiled = Math.ceil(units - 1e-9) * stepVal;
    const normalized = Math.round(ceiled * 100) / 100;
    if (normalized <= 0) return minHours;
    return Math.max(normalized, Number(minHours) || 0);
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

// Soma duration_ms de um bloco cost_tracking / task do ledger (totals → nodes
// → attempts). Nunca inventa: só agrega o que já está gravado.
function durationMsFromCostBlock(block) {
    if (!block || typeof block !== 'object') return null;
    const total = block.totals?.duration_ms;
    if (Number.isFinite(total) && total > 0) return total;
    let sum = 0;
    for (const n of Object.values(block.nodes || {})) {
        if (!n || typeof n !== 'object') continue;
        if (Number.isFinite(n.duration_ms) && n.duration_ms > 0) {
            sum += n.duration_ms;
            continue;
        }
        for (const a of n.attempts || []) {
            const ms = Number(a?.duration_ms);
            if (Number.isFinite(ms) && ms > 0) sum += ms;
        }
    }
    return sum > 0 ? sum : null;
}

function durationFromState(state) {
    return durationMsFromCostBlock(state?.cost_tracking);
}

function readCostLedger(runsDir, ticketId) {
    if (!ticketId) return null;
    const read = readJsonSafe(path.join(runsDir, `${ticketId}-cost.json`));
    return read.ok ? read.value : null;
}

// Resolve a task no ledger sem inventar chave: exact → state.task_id → strip
// sufixo de colisão `__checkout` → maior prefixo com separador `-`/`__`
// (cópias timestampadas tipo task-2026-09-29T…). Não usa unattributed.
function findLedgerTask(ledger, taskId, stateTaskId = null) {
    const tasks = ledger?.tasks;
    if (!tasks || typeof tasks !== 'object') return null;

    const ids = [];
    for (const id of [taskId, stateTaskId]) {
        if (id && !ids.includes(String(id))) ids.push(String(id));
    }
    for (const id of ids) {
        if (tasks[id]) return { key: id, task: tasks[id] };
    }
    for (const id of ids) {
        const cut = id.indexOf('__');
        if (cut > 0) {
            const base = id.slice(0, cut);
            if (tasks[base]) return { key: base, task: tasks[base] };
        }
    }
    let best = null;
    for (const id of ids) {
        for (const key of Object.keys(tasks)) {
            if (!(id.startsWith(`${key}-`) || id.startsWith(`${key}__`))) continue;
            if (!best || key.length > best.key.length) best = { key, task: tasks[key] };
        }
    }
    return best;
}

function durationFromCostLedger(runsDir, ticketId, taskId, stateTaskId = null) {
    const ledger = readCostLedger(runsDir, ticketId);
    if (!ledger) return null;
    const hit = findLedgerTask(ledger, taskId, stateTaskId);
    if (!hit) return null;
    const ms = durationMsFromCostBlock(hit.task);
    if (ms == null) return null;
    return { ms, ledgerKey: hit.key };
}

// Wall-clock atribuível pelo agent_log (mesmo critério grosso do dashboard:
// started_at/primeiro at → último at). Sem Date.now — backfill não inventa
// "ainda rodando".
function durationFromAgentLog(state) {
    const log = (state?.agent_log || [])
        .map(a => ({ at: Date.parse(a?.at) }))
        .filter(a => !Number.isNaN(a.at))
        .sort((a, b) => a.at - b.at);
    if (!log.length) return null;
    const start = Date.parse(state?.started_at);
    const from = !Number.isNaN(start) ? start : log[0].at;
    const to = log[log.length - 1].at;
    if (!(to > from)) return null;
    return to - from;
}

// Último recurso: started_at → committed_at|updated_at (espelha runs-exporter).
function durationFromStateWallclock(state) {
    const start = Date.parse(state?.started_at);
    if (Number.isNaN(start)) return null;
    for (const raw of [state?.committed_at, state?.updated_at]) {
        const end = Date.parse(raw);
        if (!Number.isNaN(end) && end > start) return end - start;
    }
    return null;
}

// Cascata de fontes atribuíveis (sem inventar ticket nem duration).
// Devolve { ms, source } ou null — ausência cai pra presumed_complexity.
function resolveDurationMs(state, runsDir, ticketId, taskId) {
    const fromState = durationFromState(state);
    if (fromState != null) {
        return { ms: fromState, source: 'state.cost_tracking' };
    }

    const fromLedger = durationFromCostLedger(
        runsDir,
        ticketId,
        taskId,
        state?.task_id || null,
    );
    if (fromLedger != null) {
        const src = fromLedger.ledgerKey === String(taskId)
            ? 'cost.json'
            : `cost.json#${fromLedger.ledgerKey}`;
        return { ms: fromLedger.ms, source: src };
    }

    const fromLog = durationFromAgentLog(state);
    if (fromLog != null) {
        return { ms: fromLog, source: 'state.agent_log' };
    }

    const fromWall = durationFromStateWallclock(state);
    if (fromWall != null) {
        return { ms: fromWall, source: 'state.wallclock' };
    }

    return null;
}

// ---- Presunção por complexidade (Richard) ---------------------------------
// Sinais atribuíveis: journals/movimentos Redmine + PRs ligados no state.
// Escala (limiares documentados; ajustáveis com evidência de dry-run):
//   baixo  — moves ≤ 2 e prs = 0              → 0,5 h
//   médio  — prs = 1 ou 3 ≤ moves ≤ 8         → 1,0 h
//   alto   — prs ≥ 2 ou moves ≥ 9             → 1,5 h
//            +0,5 h por PR além do 2º
//            +0,5 h a cada bloco de 5 moves além de 9
// Sempre em degraus de 0,5. Duration real + ceil 0,5 prevalece (nunca
// substituir por presumido menor — na verdade duration real não passa por aqui).

function countPrsFromState(state) {
    const ids = new Set();
    const add = (v) => {
        if (v == null || v === '') return;
        if (typeof v === 'number' && Number.isFinite(v)) ids.add(String(v));
        else if (typeof v === 'string' && v.trim()) ids.add(v.trim());
    };
    if (state?.pr_id != null && state.pr_id !== '') add(state.pr_id);

    for (const bag of [state?.pull_request, state?.pull_requests]) {
        if (!bag || typeof bag !== 'object') continue;
        for (const v of Object.values(bag)) {
            if (typeof v === 'string') add(v);
            else if (v && typeof v === 'object') {
                add(v.pr_id ?? v.id ?? v.url ?? null);
            }
        }
    }
    // URL/branch GitHub no state (quando presente) conta como sinal de PR.
    const gh = state?.github_pr || state?.github?.pr || state?.github_pull_request;
    if (gh) {
        if (typeof gh === 'string') add(gh);
        else if (typeof gh === 'object') add(gh.url || gh.number || gh.id);
    }
    return ids.size;
}

// Journal "movimento": tem notes OU details (status/campos). Contagem bruta
// atribuível ao ticket — não filtra watcher (movimentos também são sinal).
function countJournalMoves(journals) {
    if (!Array.isArray(journals)) return 0;
    let n = 0;
    for (const j of journals) {
        const hasNotes = Boolean(j?.notes && String(j.notes).trim());
        const hasDetails = Array.isArray(j?.details) && j.details.length > 0;
        if (hasNotes || hasDetails) n += 1;
    }
    return n;
}

function presumedHoursFromComplexity({ moves = 0, prs = 0, step = HOURS_STEP } = {}) {
    const m = Math.max(0, Number(moves) || 0);
    const p = Math.max(0, Number(prs) || 0);
    let hours;
    if (p >= 2 || m >= 9) {
        hours = 1.5;
        if (p > 2) hours += step * (p - 2);
        if (m > 9) hours += step * Math.floor((m - 9) / 5);
    } else if (p === 1 || m >= 3) {
        hours = 1.0;
    } else {
        hours = 0.5;
    }
    const factor = 1 / step;
    return Math.round(hours * factor) / factor;
}

async function fetchIssueJournals(redmineFetch, { baseUrl, apiKey, issueId }) {
    const url = new URL(`/issues/${Number(issueId)}.json`, baseUrl);
    url.searchParams.set('include', 'journals');
    const res = await redmineFetch(url, {
        headers: { 'X-Redmine-API-Key': apiKey, Accept: 'application/json' },
    });
    if (!res.ok) {
        const body = await res.text().catch(() => '');
        const err = new Error(`GET issue #${issueId} journals: HTTP ${res.status}`);
        err.statusCode = res.status;
        err.body = body;
        throw err;
    }
    const json = await res.json();
    return json.issue?.journals || [];
}

// Recalcula hours de um candidato presumed_complexity com journals (cache por ticket).
async function enrichPresumedComplexity(candidate, {
    redmineFetch,
    baseUrl,
    apiKey,
    journalCache = null,
} = {}) {
    if (!candidate?.ok || candidate.source !== 'presumed_complexity') return candidate;
    if (!redmineFetch || !baseUrl || !apiKey) return candidate;

    const tid = Number(candidate.ticketId);
    let moves = candidate.complexity?.moves ?? 0;
    try {
        let journals;
        if (journalCache && journalCache.has(tid)) {
            journals = journalCache.get(tid);
        } else {
            journals = await fetchIssueJournals(redmineFetch, { baseUrl, apiKey, issueId: tid });
            if (journalCache) journalCache.set(tid, journals);
        }
        moves = countJournalMoves(journals);
    } catch {
        // Sem journals: mantém presunção só com PRs do state (já no candidate).
        return candidate;
    }

    const prs = candidate.complexity?.prs ?? 0;
    const hours = presumedHoursFromComplexity({ moves, prs });
    const spentOn = candidate.spentOn;
    const comments = [
        `Horas presumidas por complexidade (ceil 0,5h).`,
        `Sinais: moves=${moves}, prs=${prs} → ${hours}h.`,
        candidate.marker,
    ].join(' ');
    const payload = buildTimeEntryPayload({
        issueId: tid,
        hours,
        spentOn,
        comments,
    });
    return {
        ...candidate,
        hours,
        durationMs: hours * 3_600_000,
        reason: 'presumed_complexity',
        complexity: { moves, prs, hours },
        comments,
        payload,
    };
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

    const resolved = resolveDurationMs(state, runsDir, ticketId, entry.taskId);
    const marker = hoursMarker(entry.taskId);
    const spentOn = spentOnFromState(state);

    // Duration real → ceil 0,5h. Nunca substitui por presumido menor.
    // (#67 presumed_min fixo foi supersedido por presumed_complexity.)
    if (resolved) {
        const hours = hoursFromDurationMs(resolved.ms, { minHours });
        if (hours == null) {
            return { ok: false, taskId: entry.taskId, ticketId, action: 'skip', reason: 'hours_zero' };
        }
        const comments = [
            `Horas do ciclo Prisma (wall-clock; ceil 0,5h).`,
            `Fonte: ${resolved.source}; duration_ms=${resolved.ms}.`,
            marker,
        ].join(' ');
        return {
            ok: true,
            taskId: entry.taskId,
            ticketId: Number(ticketId),
            archived: entry.archived,
            status: state.status || null,
            durationMs: resolved.ms,
            hours,
            spentOn,
            source: resolved.source,
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

    // Sem duration: presume por complexidade (PRs no state; journals no enrich).
    // Só skip se sem ticket (já tratado acima).
    const prs = countPrsFromState(state);
    const hours = presumedHoursFromComplexity({ moves: 0, prs });
    const complexity = { moves: 0, prs, hours };
    const comments = [
        `Horas presumidas por complexidade (ceil 0,5h).`,
        `Sinais: moves=0 (journals pending), prs=${prs} → ${hours}h.`,
        marker,
    ].join(' ');
    return {
        ok: true,
        taskId: entry.taskId,
        ticketId: Number(ticketId),
        archived: entry.archived,
        status: state.status || null,
        durationMs: hours * 3_600_000,
        hours,
        spentOn,
        source: 'presumed_complexity',
        reason: 'presumed_complexity',
        complexity,
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
    journalCache = null,
} = {}) {
    if (!candidate?.ok) {
        return { ...candidate, dryRun };
    }

    // Enriquece presumidos com journals Redmine (moves) antes do GET spent/POST.
    const enriched = await enrichPresumedComplexity(candidate, {
        redmineFetch,
        baseUrl,
        apiKey,
        journalCache,
    });

    const payload = {
        ...enriched.payload,
        time_entry: {
            ...enriched.payload.time_entry,
            activity_id: Number(activityId),
        },
    };
    candidate = enriched;

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
            reason: candidate.reason || null,
            complexity: candidate.complexity || null,
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
            reason: candidate.reason || null,
            complexity: candidate.complexity || null,
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
// Soft-fail no Attempt do commit: NÃO usa redmineEffect / obrigação
// redmine_hours (MAJOR review #64). POST sempre via createTimeEntry direto
// (mesmo caminho do backfill). attemptFile/env são aceitos por compat da CLI
// e ignorados — 401/403 de horas não revoga o Attempt nem injeta obrigação.
async function syncRunHoursLive(runDir, {
    dryRun = false,
    redmineFetch,
    baseUrl,
    apiKey,
    fillEvenIfSpent = true,
    activityId = DEFAULT_ACTIVITY_ID,
    minHours = DEFAULT_MIN_HOURS,
    attemptFile: _attemptFile = null,
    env: _env = process.env,
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

    return syncCandidateHours(candidate, {
        dryRun,
        redmineFetch,
        baseUrl,
        apiKey,
        fillEvenIfSpent,
        activityId,
    });
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
    // Cache de journals por ticket (vários runs do mesmo # não re-GETam).
    const journalCache = new Map();

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
            journalCache,
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
    HOURS_STEP,
    DEFAULT_STEP_HOURS,
    hoursMarker,
    markerOfComments,
    hoursFromDurationMs,
    ticketIdOf,
    durationMsFromCostBlock,
    durationFromState,
    readCostLedger,
    findLedgerTask,
    durationFromCostLedger,
    durationFromAgentLog,
    durationFromStateWallclock,
    resolveDurationMs,
    countPrsFromState,
    countJournalMoves,
    presumedHoursFromComplexity,
    fetchIssueJournals,
    enrichPresumedComplexity,
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
