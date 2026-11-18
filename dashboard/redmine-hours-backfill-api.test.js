// node --test redmine-hours-backfill-api.test.js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createDashboard } = require('./server');
const { createHoursBackfillJob } = require('./redmine-hours-backfill');

const tmpBase = process.env.CLAUDE_JOB_DIR ? path.join(process.env.CLAUDE_JOB_DIR, 'tmp') : os.tmpdir();
const tmp = fs.mkdtempSync(path.join(tmpBase, 'hours-bf-api-'));
fs.mkdirSync(path.join(tmp, 'memory', 'runs'), { recursive: true });

const watcherManager = {
    status: () => ({ state: 'stopped', running: false }),
    start: async () => ({}), stop: async () => ({}), restart: async () => ({}),
    getLogBuffer: () => [], onLine: () => () => {},
};

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

async function waitFor(fn, { timeoutMs = 3000 } = {}) {
    const t0 = Date.now();
    for (;;) {
        const v = await fn();
        if (v) return v;
        if (Date.now() - t0 > timeoutMs) throw new Error('timeout aguardando condição');
        await delay(40);
    }
}

test('POST start dry-run: 202, progresso até done, status espelha summary', async (t) => {
    let progressCalls = 0;
    const runBackfillFn = async ({ onProgress, dryRun }) => {
        assert.strictEqual(dryRun, true);
        onProgress?.({ phase: 'scan', action: 'scanning', message: 'Coletando…' });
        await delay(30);
        onProgress?.({ phase: 'scan_done', action: 'scan_done', total: 2, actionable: 1, message: '2 runs' });
        onProgress?.({
            phase: 'sync', action: 'would_create', taskId: '43703-x', ticketId: 43703,
            hours: 1.5, index: 1, total: 2,
        });
        progressCalls += 1;
        await delay(20);
        onProgress?.({
            phase: 'sync', action: 'skip', taskId: '43704-y', ticketId: 43704,
            reason: 'no_duration', index: 2, total: 2,
        });
        return {
            summary: { dryRun: true, total: 2, actionable: 1, skipped: 1, errors: 0, hoursWouldSync: 1.5 },
            results: [
                { action: 'would_create', hours: 1.5 },
                { action: 'skip', reason: 'no_duration' },
            ],
        };
    };

    const dash = createDashboard({
        env: { REDMINE_URL: 'https://redmine.example', REDMINE_API_KEY: 'k' },
        memoryDir: path.join(tmp, 'memory', 'runs'),
        worktreesDir: path.join(tmp, 'wt'),
        watcherManager,
        prefsFile: path.join(tmp, 'prefs.json'),
        healthCheck: async () => ({}),
        runHoursBackfill: runBackfillFn,
        hoursBackfillFetch: async () => ({ ok: true, status: 200, json: async () => ({ time_entries: [] }), text: async () => '' }),
    });
    t.after(async () => { await dash.close(); });
    await new Promise(r => dash.server.listen(0, '127.0.0.1', r));
    await dash.ready;
    const base = `http://127.0.0.1:${dash.server.address().port}`;

    const idle = await (await fetch(`${base}/api/redmine-hours-backfill/status`)).json();
    assert.strictEqual(idle.state, 'idle');

    const start = await fetch(`${base}/api/redmine-hours-backfill/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dryRun: true, limit: 5 }),
    });
    assert.strictEqual(start.status, 202);
    const started = await start.json();
    assert.strictEqual(started.state, 'running');
    assert.strictEqual(started.dryRun, true);

    const done = await waitFor(async () => {
        const s = await (await fetch(`${base}/api/redmine-hours-backfill/status`)).json();
        return s.state === 'done' ? s : null;
    });
    assert.ok(progressCalls >= 1);
    assert.strictEqual(done.summary.actionable, 1);
    assert.strictEqual(done.hoursWouldSync, 1.5);
    assert.ok(done.events.some(e => e.action === 'would_create'));
});

test('apply sem confirmApply: 400; segundo start em running: 409', async (t) => {
    let release;
    const gate = new Promise(r => { release = r; });
    const runBackfillFn = async ({ onProgress }) => {
        onProgress?.({ phase: 'scan', action: 'scanning', message: '…' });
        await gate;
        return { summary: { dryRun: false, total: 0, actionable: 0, skipped: 0, errors: 0, hoursWouldSync: 0 }, results: [] };
    };
    const dash = createDashboard({
        env: { REDMINE_URL: 'https://redmine.example', REDMINE_API_KEY: 'k' },
        memoryDir: path.join(tmp, 'memory', 'runs-b'),
        worktreesDir: path.join(tmp, 'wt-b'),
        watcherManager,
        prefsFile: path.join(tmp, 'prefs-b.json'),
        healthCheck: async () => ({}),
        runHoursBackfill: runBackfillFn,
    });
    fs.mkdirSync(path.join(tmp, 'memory', 'runs-b'), { recursive: true });
    t.after(async () => { release(); await dash.close(); });
    await new Promise(r => dash.server.listen(0, '127.0.0.1', r));
    await dash.ready;
    const base = `http://127.0.0.1:${dash.server.address().port}`;

    const bad = await fetch(`${base}/api/redmine-hours-backfill/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dryRun: false }),
    });
    assert.strictEqual(bad.status, 400);

    const a = await fetch(`${base}/api/redmine-hours-backfill/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dryRun: true }),
    });
    assert.strictEqual(a.status, 202);
    const b = await fetch(`${base}/api/redmine-hours-backfill/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dryRun: true }),
    });
    assert.strictEqual(b.status, 409);
    release();
    await waitFor(async () => {
        const s = await (await fetch(`${base}/api/redmine-hours-backfill/status`)).json();
        return s.state === 'done' ? s : null;
    });
});

test('createHoursBackfillJob exige Redmine configurado', async () => {
    const job = createHoursBackfillJob({
        runsDir: path.join(tmp, 'memory', 'runs'),
        env: {},
        runBackfillFn: async () => ({ summary: {}, results: [] }),
    });
    await assert.rejects(() => job.start({ dryRun: true }), /REDMINE_URL/);
});
