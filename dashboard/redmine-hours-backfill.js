// Job de backfill de horas Redmine M&O no dashboard: dry-run/apply com progresso
// polled via GET. Um job por processo (dashboard). Não grava secret no status.
//
// Rotas montadas por createDashboard (server.js):
//   GET  /api/redmine-hours-backfill/status
//   POST /api/redmine-hours-backfill/start   { dryRun?, limit?, ticket?, tickets?, fillEvenIfSpent?, confirmApply? }
//   POST /api/redmine-hours-backfill/cancel  (marca cancelamento; o loop para no próximo item)

'use strict';

const fs = require('fs');
const path = require('path');
const { createRedmineFetch } = require('../scripts/lib/redmine-fetch');
const { runBackfill, DEFAULT_ACTIVITY_ID } = require('../scripts/lib/redmine-hours-sync');

const MAX_EVENTS = 80;

function emptyJob() {
    return {
        id: null,
        state: 'idle', // idle | running | done | error | cancelled
        dryRun: true,
        startedAt: null,
        finishedAt: null,
        phase: null,
        message: 'Nenhum backfill rodou ainda.',
        index: 0,
        total: 0,
        actionable: 0,
        counts: { would_create: 0, created: 0, skip: 0, error: 0 },
        hoursWouldSync: 0,
        summary: null,
        events: [],
        error: null,
        options: null,
    };
}

function createHoursBackfillJob({
    runsDir,
    env = process.env,
    runBackfillFn = runBackfill,
    redmineFetch = null,
    persistPath = null,
} = {}) {
    let job = emptyJob();
    let cancelRequested = false;
    let seq = 0;

    function snapshot() {
        return JSON.parse(JSON.stringify(job));
    }

    function persist() {
        if (!persistPath) return;
        try {
            fs.mkdirSync(path.dirname(persistPath), { recursive: true });
            fs.writeFileSync(persistPath, JSON.stringify(snapshot(), null, 2));
        } catch { /* best-effort */ }
    }

    function pushEvent(ev) {
        const row = {
            ts: new Date().toISOString(),
            action: ev.action || null,
            taskId: ev.taskId || null,
            ticketId: ev.ticketId != null ? ev.ticketId : null,
            hours: ev.hours != null ? ev.hours : null,
            reason: ev.reason || null,
            message: ev.message || null,
            phase: ev.phase || null,
            index: ev.index != null ? ev.index : null,
            total: ev.total != null ? ev.total : null,
        };
        job.events.push(row);
        if (job.events.length > MAX_EVENTS) job.events.splice(0, job.events.length - MAX_EVENTS);
    }

    function applyProgress(ev) {
        if (ev.phase) job.phase = ev.phase;
        if (ev.message) job.message = ev.message;
        if (ev.total != null) job.total = ev.total;
        if (ev.actionable != null) job.actionable = ev.actionable;
        if (ev.index != null) job.index = ev.index;
        if (ev.action === 'would_create' || ev.action === 'created' || ev.action === 'skip' || ev.action === 'error') {
            job.counts[ev.action] = (job.counts[ev.action] || 0) + 1;
            if ((ev.action === 'would_create' || ev.action === 'created') && ev.hours != null) {
                job.hoursWouldSync = Number((job.hoursWouldSync + Number(ev.hours)).toFixed(2));
            }
            const bits = [
                ev.action,
                ev.taskId || '',
                ev.ticketId != null ? `#${ev.ticketId}` : '',
                ev.hours != null ? `${ev.hours}h` : '',
                ev.reason ? `(${ev.reason})` : '',
            ].filter(Boolean);
            job.message = bits.join(' ');
        }
        pushEvent(ev);
    }

    function loadLast() {
        if (!persistPath || !fs.existsSync(persistPath)) return;
        try {
            const prev = JSON.parse(fs.readFileSync(persistPath, 'utf8'));
            if (prev && prev.state && prev.state !== 'running') job = { ...emptyJob(), ...prev, events: prev.events || [] };
        } catch { /* ignore */ }
    }
    loadLast();

    async function start(opts = {}) {
        if (job.state === 'running') {
            const err = new Error('já há um backfill em andamento');
            err.statusCode = 409;
            throw err;
        }

        const dryRun = opts.dryRun !== false && opts.apply !== true;
        if (!dryRun && opts.confirmApply !== true) {
            const err = new Error('para --apply, envie confirmApply: true');
            err.statusCode = 400;
            throw err;
        }

        const baseUrl = env.REDMINE_URL;
        const apiKey = env.REDMINE_API_KEY;
        if (!baseUrl || !apiKey) {
            const err = new Error('REDMINE_URL e REDMINE_API_KEY são obrigatórios no .env');
            err.statusCode = 503;
            throw err;
        }

        const tickets = [];
        if (opts.ticket != null) tickets.push(Number(opts.ticket));
        if (Array.isArray(opts.tickets)) {
            for (const t of opts.tickets) tickets.push(Number(t));
        }
        if (tickets.some(n => !Number.isFinite(n) || n <= 0)) {
            const err = new Error('ticket inválido');
            err.statusCode = 400;
            throw err;
        }

        let limit = null;
        if (opts.limit != null && opts.limit !== '') {
            limit = Number(opts.limit);
            if (!Number.isFinite(limit) || limit < 1) {
                const err = new Error('limit inválido');
                err.statusCode = 400;
                throw err;
            }
        }

        cancelRequested = false;
        seq += 1;
        job = {
            ...emptyJob(),
            id: `bf-${Date.now()}-${seq}`,
            state: 'running',
            dryRun,
            startedAt: new Date().toISOString(),
            message: dryRun ? 'Dry-run iniciado…' : 'APPLY iniciado…',
            phase: 'starting',
            options: {
                dryRun,
                limit,
                tickets: tickets.length ? tickets : null,
                fillEvenIfSpent: !!opts.fillEvenIfSpent,
                includeActive: !!opts.includeActive,
            },
        };
        persist();

        const fetchImpl = redmineFetch || createRedmineFetch({
            env: { ...env, REDMINE_MIN_INTERVAL_MS: env.REDMINE_MIN_INTERVAL_MS || '500' },
            log: () => {},
        });

        // Não await no caller — job roda em background.
        setImmediate(async () => {
            try {
                const { summary, results } = await runBackfillFn({
                    runsDir,
                    dryRun,
                    redmineFetch: fetchImpl,
                    baseUrl,
                    apiKey,
                    includeArchive: true,
                    includeActive: !!opts.includeActive,
                    limit,
                    ticketIds: tickets.length ? new Set(tickets) : null,
                    fillEvenIfSpent: !!opts.fillEvenIfSpent,
                    activityId: DEFAULT_ACTIVITY_ID,
                    onProgress: (ev) => {
                        if (cancelRequested) {
                            const stop = new Error('cancelado');
                            stop.code = 'CANCELLED';
                            throw stop;
                        }
                        applyProgress(ev);
                        persist();
                    },
                });
                if (cancelRequested) {
                    job.state = 'cancelled';
                    job.message = 'Cancelado pelo usuário.';
                } else {
                    job.state = 'done';
                    job.summary = summary;
                    job.message = dryRun
                        ? `Dry-run ok: ${summary.actionable} actionable · ${summary.hoursWouldSync}h`
                        : `Apply ok: ${summary.actionable} gravados/candidatos · ${summary.hoursWouldSync}h`;
                    job.phase = 'done';
                    // Reconta a partir do summary (fonte de verdade).
                    job.counts = {
                        would_create: results.filter(r => r.action === 'would_create').length,
                        created: results.filter(r => r.action === 'created').length,
                        skip: results.filter(r => r.action === 'skip' || (r.ok === false && r.reason && r.reason !== 'create_failed')).length,
                        error: summary.errors,
                    };
                    job.hoursWouldSync = summary.hoursWouldSync;
                    job.total = summary.total;
                    job.index = summary.total;
                }
            } catch (err) {
                if (err && err.code === 'CANCELLED') {
                    job.state = 'cancelled';
                    job.message = 'Cancelado pelo usuário.';
                } else {
                    job.state = 'error';
                    job.error = err.message || String(err);
                    job.message = `Erro: ${job.error}`;
                }
            } finally {
                job.finishedAt = new Date().toISOString();
                if (job.phase !== 'done' && job.state === 'done') job.phase = 'done';
                persist();
            }
        });

        return snapshot();
    }

    function cancel() {
        if (job.state !== 'running') {
            const err = new Error('nenhum backfill em andamento');
            err.statusCode = 409;
            throw err;
        }
        cancelRequested = true;
        job.message = 'Cancelamento solicitado…';
        persist();
        return snapshot();
    }

    function mount(app) {
        app.get('/api/redmine-hours-backfill/status', (req, res) => res.json(snapshot()));
        app.post('/api/redmine-hours-backfill/start', async (req, res) => {
            try {
                const st = await start(req.body || {});
                res.status(202).json(st);
            } catch (e) {
                res.status(e.statusCode || 500).json({ error: e.message });
            }
        });
        app.post('/api/redmine-hours-backfill/cancel', (req, res) => {
            try {
                res.json(cancel());
            } catch (e) {
                res.status(e.statusCode || 500).json({ error: e.message });
            }
        });
    }

    return { mount, start, cancel, status: snapshot, _job: () => job };
}

module.exports = { createHoursBackfillJob, emptyJob };
