const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const {
    hoursFromDurationMs,
    hoursMarker,
    markerOfComments,
    buildTimeEntryPayload,
    collectCandidates,
    findExistingMarker,
    syncCandidateHours,
    syncRunHoursLive,
    runsDirOf,
    runBackfill,
} = require('./redmine-hours-sync');
const { createRedmineFetch } = require('./redmine-fetch');

function tmpRuns() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'horas-bf-'));
    const runs = path.join(root, 'memory', 'runs');
    const archive = path.join(runs, '_archive');
    fs.mkdirSync(archive, { recursive: true });
    return { root, runs, archive };
}

function writeRun(archive, taskId, state, { cost = null } = {}) {
    const dir = path.join(archive, taskId);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify(state, null, 2));
    if (cost) {
        const ticketId = state.redmine_ticket.id;
        fs.writeFileSync(
            path.join(path.dirname(archive), `${ticketId}-cost.json`),
            JSON.stringify(cost, null, 2),
        );
    }
    return dir;
}

test('hoursFromDurationMs faz ceil em múltiplos de 0.5h', () => {
    assert.strictEqual(hoursFromDurationMs(3_600_000), 1); // 1h exato
    assert.strictEqual(hoursFromDurationMs(1_800_000), 0.5); // 30min exato
    assert.strictEqual(hoursFromDurationMs(1_000), 0.5); // qualquer >0 → 0.5
    assert.strictEqual(hoursFromDurationMs(1_800_001), 1); // 30min+ε → 1h
    assert.strictEqual(hoursFromDurationMs(3_600_001), 1.5); // 1h+ε → 1.5h
    assert.strictEqual(hoursFromDurationMs(0), null);
    assert.strictEqual(hoursFromDurationMs(null), null);
});

test('marcador de idempotência é estável e parseável', () => {
    assert.strictEqual(hoursMarker('43703-frete'), '[prisma-hours:43703-frete]');
    assert.strictEqual(markerOfComments('x [prisma-hours:43703-frete] y'), '43703-frete');
    assert.strictEqual(markerOfComments('sem marcador'), null);
});

test('buildTimeEntryPayload monta o corpo Redmine', () => {
    const p = buildTimeEntryPayload({
        issueId: 43703,
        hours: 1.06,
        spentOn: '2026-10-02',
        comments: 'teste [prisma-hours:43703-x]',
        activityId: 9,
    });
    assert.deepStrictEqual(p, {
        time_entry: {
            issue_id: 43703,
            hours: 1.06,
            spent_on: '2026-10-02',
            activity_id: 9,
            comments: 'teste [prisma-hours:43703-x]',
        },
    });
});

test('buildCandidate usa state.cost_tracking e cai pro cost.json', () => {
    const { runs, archive } = tmpRuns();
    writeRun(archive, '43703-com-state', {
        status: 'fully_merged',
        updated_at: '2026-10-02T12:00:00.000Z',
        redmine_ticket: { id: 43703 },
        cost_tracking: { totals: { duration_ms: 3_600_000 } },
    });
    writeRun(archive, '43704-so-ledger', {
        status: 'committed',
        updated_at: '2026-10-03T12:00:00.000Z',
        redmine_ticket: { id: 43704 },
    }, {
        cost: {
            ticket_id: 43704,
            tasks: {
                '43704-so-ledger': { totals: { duration_ms: 7_200_000 }, nodes: {} },
            },
        },
    });
    writeRun(archive, '43705-sem-horas', {
        status: 'committed',
        redmine_ticket: { id: 43705 },
    });
    writeRun(archive, '2026-09-21-sdd-docs-por-classe', {
        status: 'committed',
        // sem redmine_ticket — não pode virar ticket #2026
    });

    const list = collectCandidates(runs, { includeActive: false });
    const byId = Object.fromEntries(list.filter(c => c.ok).map(c => [c.taskId, c]));
    assert.strictEqual(byId['43703-com-state'].hours, 1);
    assert.strictEqual(byId['43703-com-state'].source, 'state.cost_tracking');
    assert.strictEqual(byId['43704-so-ledger'].hours, 2);
    assert.strictEqual(byId['43704-so-ledger'].source, 'cost.json');
    assert.strictEqual(byId['43705-sem-horas'].hours, 0.5);
    assert.strictEqual(byId['43705-sem-horas'].source, 'presumed_min');
    assert.ok(list.some(c => c.taskId === '2026-09-21-sdd-docs-por-classe' && c.reason === 'no_ticket'));
});

test('findExistingMarker detecta time entry já sincronizada', () => {
    const entries = [
        { id: 1, hours: 2, comments: 'manual' },
        { id: 2, hours: 1, comments: 'Horas... [prisma-hours:43703-x]' },
    ];
    assert.strictEqual(findExistingMarker(entries, '43703-x').id, 2);
    assert.strictEqual(findExistingMarker(entries, 'outro'), null);
});

async function fakeRedmine({ entriesByIssue = {}, postStatus = 201 } = {}) {
    const posts = [];
    const server = http.createServer((req, res) => {
        const url = new URL(req.url, 'http://127.0.0.1');
        if (req.method === 'GET' && url.pathname === '/time_entries.json') {
            const issueId = url.searchParams.get('issue_id');
            const list = entriesByIssue[issueId] || [];
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ time_entries: list }));
            return;
        }
        if (req.method === 'POST' && url.pathname === '/time_entries.json') {
            let body = '';
            req.on('data', c => { body += c; });
            req.on('end', () => {
                posts.push(JSON.parse(body));
                res.writeHead(postStatus, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ time_entry: { id: 99, ...(JSON.parse(body).time_entry || {}) } }));
            });
            return;
        }
        res.writeHead(404);
        res.end('nope');
    });
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const fetchImpl = createRedmineFetch({
        env: { REDMINE_MIN_INTERVAL_MS: '0', REDMINE_RETRY_BASE_DELAY_MS: '5' },
        log: () => {},
    });
    return {
        baseUrl,
        posts,
        fetch: fetchImpl,
        close: () => new Promise(r => server.close(r)),
    };
}

test('syncCandidateHours dry-run: would_create sem POST', async t => {
    const rm = await fakeRedmine({ entriesByIssue: { 43703: [] } });
    t.after(rm.close);
    const c = {
        ok: true,
        taskId: '43703-x',
        ticketId: 43703,
        hours: 1.5,
        spentOn: '2026-10-02',
        source: 'state.cost_tracking',
        marker: hoursMarker('43703-x'),
        comments: `x ${hoursMarker('43703-x')}`,
        payload: buildTimeEntryPayload({
            issueId: 43703,
            hours: 1.5,
            spentOn: '2026-10-02',
            comments: `x ${hoursMarker('43703-x')}`,
        }),
    };
    const r = await syncCandidateHours(c, {
        dryRun: true,
        redmineFetch: rm.fetch,
        baseUrl: rm.baseUrl,
        apiKey: 'k',
    });
    assert.strictEqual(r.action, 'would_create');
    assert.strictEqual(rm.posts.length, 0);
});

test('syncCandidateHours apply cria entry; segunda vez already_synced', async t => {
    const rm = await fakeRedmine({ entriesByIssue: { 43703: [] } });
    t.after(rm.close);
    const c = {
        ok: true,
        taskId: '43703-x',
        ticketId: 43703,
        hours: 1.5,
        spentOn: '2026-10-02',
        source: 'state.cost_tracking',
        marker: hoursMarker('43703-x'),
        comments: `x ${hoursMarker('43703-x')}`,
        payload: buildTimeEntryPayload({
            issueId: 43703,
            hours: 1.5,
            spentOn: '2026-10-02',
            comments: `x ${hoursMarker('43703-x')}`,
        }),
    };

    const first = await syncCandidateHours(c, {
        dryRun: false,
        redmineFetch: rm.fetch,
        baseUrl: rm.baseUrl,
        apiKey: 'k',
    });
    assert.strictEqual(first.action, 'created');
    assert.strictEqual(rm.posts.length, 1);

    rm.posts.length = 0;
    // Simula que o GET agora devolve a entry criada
    const rm2 = await fakeRedmine({
        entriesByIssue: {
            43703: [{ id: 99, hours: 1.5, comments: c.comments }],
        },
    });
    t.after(rm2.close);
    const second = await syncCandidateHours(c, {
        dryRun: false,
        redmineFetch: rm2.fetch,
        baseUrl: rm2.baseUrl,
        apiKey: 'k',
    });
    assert.strictEqual(second.action, 'skip');
    assert.strictEqual(second.reason, 'already_synced');
    assert.strictEqual(rm2.posts.length, 0);
});

test('syncCandidateHours pula ticket que já tem spent (sem --fill-even-if-spent)', async t => {
    const rm = await fakeRedmine({
        entriesByIssue: {
            43703: [{ id: 1, hours: 3, comments: 'apontamento manual' }],
        },
    });
    t.after(rm.close);
    const c = {
        ok: true,
        taskId: '43703-x',
        ticketId: 43703,
        hours: 1.5,
        spentOn: '2026-10-02',
        source: 'state.cost_tracking',
        marker: hoursMarker('43703-x'),
        comments: `x ${hoursMarker('43703-x')}`,
        payload: buildTimeEntryPayload({
            issueId: 43703,
            hours: 1.5,
            spentOn: '2026-10-02',
            comments: `x ${hoursMarker('43703-x')}`,
        }),
    };
    const r = await syncCandidateHours(c, {
        dryRun: false,
        redmineFetch: rm.fetch,
        baseUrl: rm.baseUrl,
        apiKey: 'k',
        fillEvenIfSpent: false,
    });
    assert.strictEqual(r.action, 'skip');
    assert.strictEqual(r.reason, 'issue_already_has_spent');
    assert.strictEqual(rm.posts.length, 0);
});

test('syncRunHoursLive (hot path): cria com spent prévio; sem duration presume 0.5h', async t => {
    const { runs, archive } = tmpRuns();
    const withHours = writeRun(archive, '43720-live', {
        status: 'committed',
        updated_at: '2026-10-20T12:00:00.000Z',
        redmine_ticket: { id: 43720 },
        cost_tracking: { totals: { duration_ms: 3_600_000 } },
    });
    const noHours = writeRun(archive, '43721-live-sem', {
        status: 'committed',
        redmine_ticket: { id: 43721 },
    });
    assert.strictEqual(runsDirOf(withHours), runs);

    const rm = await fakeRedmine({
        entriesByIssue: {
            43720: [{ id: 1, hours: 2, comments: 'apontamento manual' }],
            43721: [],
        },
    });
    t.after(rm.close);

    const created = await syncRunHoursLive(withHours, {
        dryRun: false,
        redmineFetch: rm.fetch,
        baseUrl: rm.baseUrl,
        apiKey: 'k',
        // default fillEvenIfSpent=true no live
    });
    assert.strictEqual(created.action, 'created');
    assert.strictEqual(created.hours, 1);
    assert.strictEqual(rm.posts.length, 1);

    const presumed = await syncRunHoursLive(noHours, {
        dryRun: false,
        redmineFetch: rm.fetch,
        baseUrl: rm.baseUrl,
        apiKey: 'k',
    });
    assert.strictEqual(presumed.action, 'created');
    assert.strictEqual(presumed.hours, 0.5);
    assert.strictEqual(presumed.source, 'presumed_min');
    assert.strictEqual(rm.posts.length, 2);
});

// MAJOR-1 / MAJOR-2 (#64): horas soft-fail — attemptFile não injeta obrigação
// redmine_hours nem revoga o Attempt em 401; already_synced não depende de effect.
test('syncRunHoursLive com attemptFile: POST direto; Attempt intacto em create/skip/401', async t => {
    const dom06 = require('./dom06-attempt');
    const { archive } = tmpRuns();
    const runDir = writeRun(archive, '43730-attempt', {
        status: 'committed',
        updated_at: '2026-10-28T12:00:00.000Z',
        redmine_ticket: { id: 43730 },
        cost_tracking: { totals: { duration_ms: 3_600_000 } },
    });

    const attemptRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'horas-attempt-'));
    t.after(() => fs.rmSync(attemptRoot, { recursive: true, force: true }));
    const decision = dom06.beginAttempt(attemptRoot, {
        node: 'commit',
        admission: {
            status: 'ADMITTED',
            owner: 'dom06',
            snapshot: { ticket_id: 43730, node: 'commit', base_branch: 'main', spec_hash: 'h1' },
        },
        obligations: dom06.obligationsFor('commit'),
    });
    for (const id of ['push', 'pull_request', 'redmine_status', 'redmine_notes']) {
        dom06.recordEffect(decision.attemptFile, {
            obligation_id: id,
            idempotency_key: `${id}:1`,
            status: 'fulfilled',
        });
    }
    assert.strictEqual(dom06.summarize(dom06.readAttempt(decision.attemptFile)).verdict, 'PASS');
    const obligationIdsBefore = dom06.readAttempt(decision.attemptFile).obligations.map(o => o.id).sort();

    const rmOk = await fakeRedmine({ entriesByIssue: { 43730: [] } });
    t.after(rmOk.close);
    const created = await syncRunHoursLive(runDir, {
        dryRun: false,
        redmineFetch: rmOk.fetch,
        baseUrl: rmOk.baseUrl,
        apiKey: 'k',
        attemptFile: decision.attemptFile,
    });
    assert.strictEqual(created.action, 'created');
    assert.strictEqual(rmOk.posts.length, 1);
    assert.notStrictEqual(created.via, 'dom06_redmine_effect');

    let after = dom06.readAttempt(decision.attemptFile);
    assert.strictEqual(after.authority, 'valid');
    assert.strictEqual(dom06.summarize(after).verdict, 'PASS');
    assert.deepStrictEqual(after.obligations.map(o => o.id).sort(), obligationIdsBefore);
    assert.ok(!after.obligations.some(o => o.id === 'redmine_hours'));

    const rmSkip = await fakeRedmine({
        entriesByIssue: {
            43730: [{ id: 99, hours: 1, comments: `x ${hoursMarker('43730-attempt')}` }],
        },
    });
    t.after(rmSkip.close);
    const skipped = await syncRunHoursLive(runDir, {
        dryRun: false,
        redmineFetch: rmSkip.fetch,
        baseUrl: rmSkip.baseUrl,
        apiKey: 'k',
        attemptFile: decision.attemptFile,
    });
    assert.strictEqual(skipped.action, 'skip');
    assert.strictEqual(skipped.reason, 'already_synced');
    after = dom06.readAttempt(decision.attemptFile);
    assert.strictEqual(dom06.summarize(after).verdict, 'PASS');
    assert.ok(!after.obligations.some(o => o.id === 'redmine_hours'));

    const rm401 = await fakeRedmine({ entriesByIssue: { 43730: [] }, postStatus: 401 });
    t.after(rm401.close);
    const failed = await syncRunHoursLive(runDir, {
        dryRun: false,
        redmineFetch: rm401.fetch,
        baseUrl: rm401.baseUrl,
        apiKey: 'k',
        attemptFile: decision.attemptFile,
    });
    assert.strictEqual(failed.action, 'error');
    assert.strictEqual(failed.statusCode, 401);
    assert.ok(String(failed.reason).includes('create_failed'));
    assert.ok(!String(failed.reason).includes('AUTHORITY'));
    after = dom06.readAttempt(decision.attemptFile);
    assert.strictEqual(after.authority, 'valid', '401 de horas não revoga Attempt');
    assert.strictEqual(dom06.summarize(after).verdict, 'PASS');
    assert.ok(!after.obligations.some(o => o.id === 'redmine_hours'));
});

test('runBackfill integra coleta + dry-run', async t => {
    const { runs, archive } = tmpRuns();
    writeRun(archive, '43710-a', {
        status: 'fully_merged',
        updated_at: '2026-10-10T12:00:00.000Z',
        redmine_ticket: { id: 43710 },
        cost_tracking: { totals: { duration_ms: 3_600_000 } },
    });
    const rm = await fakeRedmine({ entriesByIssue: { 43710: [] } });
    t.after(rm.close);

    const { summary, results } = await runBackfill({
        runsDir: runs,
        dryRun: true,
        redmineFetch: rm.fetch,
        baseUrl: rm.baseUrl,
        apiKey: 'k',
        includeActive: false,
    });
    assert.strictEqual(summary.dryRun, true);
    assert.strictEqual(summary.actionable, 1);
    assert.strictEqual(results.find(r => r.taskId === '43710-a').action, 'would_create');
    assert.strictEqual(rm.posts.length, 0);
});
