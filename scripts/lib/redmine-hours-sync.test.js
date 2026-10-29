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
    listTimeEntries,
    syncCandidateHours,
    syncRunHoursLive,
    runsDirOf,
    runBackfill,
    presumedHoursFromComplexity,
    countPrsFromState,
    countJournalMoves,
} = require('./redmine-hours-sync');
const { createRedmineFetch } = require('./redmine-fetch');

function tmpRuns() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'horas-bf-'));
    const runs = path.join(root, 'memory', 'runs');
    const archive = path.join(runs, '_archive');
    const rotated = path.join(root, 'memory', 'archive');
    fs.mkdirSync(archive, { recursive: true });
    fs.mkdirSync(rotated, { recursive: true });
    return { root, runs, archive, rotated };
}

function writeRun(parent, taskId, state, { cost = null, runsDir = null } = {}) {
    const dir = path.join(parent, taskId);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify(state, null, 2));
    if (cost) {
        const ticketId = state.redmine_ticket.id;
        // Ledger oficial vive em memory/runs/<ticket>-cost.json (não em archive/).
        let costDir = runsDir;
        if (!costDir) {
            if (path.basename(parent) === '_archive') costDir = path.dirname(parent);
            else if (path.basename(path.dirname(parent)) === 'archive') {
                costDir = path.join(path.dirname(path.dirname(parent)), 'runs');
            } else costDir = parent;
        }
        fs.mkdirSync(costDir, { recursive: true });
        fs.writeFileSync(
            path.join(costDir, `${ticketId}-cost.json`),
            JSON.stringify(cost, null, 2),
        );
    }
    return dir;
}

test('hoursFromDurationMs sobe para o próximo meio-hora / hora (ceil 0,5)', () => {
    // Exatos no degrau
    assert.strictEqual(hoursFromDurationMs(3_600_000), 1);       // 1.0h
    assert.strictEqual(hoursFromDurationMs(1_800_000), 0.5);     // 0.5h
    assert.strictEqual(hoursFromDurationMs(7_200_000), 2);       // 2.0h
    // Regra Richard: sempre ceil para múltiplo de 0,5
    assert.strictEqual(hoursFromDurationMs(360_000), 0.5);       // 0.1h → 0.5
    assert.strictEqual(hoursFromDurationMs(2_160_000), 1);       // 0.6h → 1.0
    assert.strictEqual(hoursFromDurationMs(3_636_000), 1.5);     // 1.01h → 1.5
    assert.strictEqual(hoursFromDurationMs(1_000), 0.5);         // residual → 0.5
    assert.strictEqual(hoursFromDurationMs(1_800_001), 1);       // 0.5h+ε → 1.0
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
    // Sem duration → presumed_complexity (piso 0,5; só no_ticket skipa)
    assert.ok(byId['43705-sem-horas']);
    assert.strictEqual(byId['43705-sem-horas'].source, 'presumed_complexity');
    assert.strictEqual(byId['43705-sem-horas'].reason, 'presumed_complexity');
    assert.strictEqual(byId['43705-sem-horas'].hours, 0.5);
    assert.ok(list.some(c => c.taskId === '2026-09-21-sdd-docs-por-classe' && c.reason === 'no_ticket'));
});

test('resolveDuration: nodes do state, prefixo no ledger, agent_log e wallclock', () => {
    const { runs, archive, rotated } = tmpRuns();

    // totals ausente/0, mas nodes têm duration_ms
    writeRun(archive, '43760-so-nodes', {
        status: 'committed',
        updated_at: '2026-10-01T12:00:00.000Z',
        redmine_ticket: { id: 43760 },
        cost_tracking: {
            totals: { duration_ms: 0 },
            nodes: {
                plan: { duration_ms: 900_000 },
                implement: { duration_ms: 900_000 },
            },
        },
    });

    // Cópia timestampada: ledger só tem a chave-base
    writeRun(archive, '43761-ciclo-2026-09-29T17-46-58-152Z', {
        status: 'fully_merged',
        task_id: '43761-ciclo',
        updated_at: '2026-09-29T18:00:00.000Z',
        redmine_ticket: { id: 43761 },
    }, {
        runsDir: runs,
        cost: {
            ticket_id: 43761,
            tasks: {
                '43761-ciclo': { totals: { duration_ms: 3_600_000 }, nodes: {} },
            },
        },
    });

    // Colisão de archive: sufixo __main
    writeRun(path.join(rotated, '2026-07'), '43762-old__main', {
        status: 'fully_merged',
        updated_at: '2026-07-10T12:00:00.000Z',
        redmine_ticket: { id: 43762 },
    }, {
        runsDir: runs,
        cost: {
            ticket_id: 43762,
            tasks: {
                '43762-old': { totals: { duration_ms: 1_800_000 }, nodes: {} },
            },
        },
    });

    // Sem cost_tracking/ledger — agent_log
    writeRun(archive, '43763-via-log', {
        status: 'committed',
        started_at: '2026-10-05T10:00:00.000Z',
        updated_at: '2026-10-05T12:00:00.000Z',
        redmine_ticket: { id: 43763 },
        agent_log: [
            { at: '2026-10-05T10:30:00.000Z', nodes: ['plan'] },
            { at: '2026-10-05T11:00:00.000Z', nodes: ['implement'] },
        ],
    });

    // Só wallclock started→updated
    writeRun(archive, '43764-wallclock', {
        status: 'committed',
        started_at: '2026-10-06T08:00:00.000Z',
        updated_at: '2026-10-06T09:30:00.000Z',
        redmine_ticket: { id: 43764 },
    });

    const list = collectCandidates(runs, { includeActive: false });
    const byId = Object.fromEntries(list.filter(c => c.ok).map(c => [c.taskId, c]));

    assert.strictEqual(byId['43760-so-nodes'].source, 'state.cost_tracking');
    assert.strictEqual(byId['43760-so-nodes'].hours, 0.5); // 0.5h exato

    assert.strictEqual(byId['43761-ciclo-2026-09-29T17-46-58-152Z'].source, 'cost.json#43761-ciclo');
    assert.strictEqual(byId['43761-ciclo-2026-09-29T17-46-58-152Z'].hours, 1);

    assert.strictEqual(byId['43762-old__main'].source, 'cost.json#43762-old');
    assert.strictEqual(byId['43762-old__main'].hours, 0.5);

    assert.strictEqual(byId['43763-via-log'].source, 'state.agent_log');
    assert.strictEqual(byId['43763-via-log'].hours, 1); // 1h exact

    assert.strictEqual(byId['43764-wallclock'].source, 'state.wallclock');
    assert.strictEqual(byId['43764-wallclock'].hours, 1.5); // 1.5h exact
});

test('findExistingMarker detecta time entry já sincronizada', () => {
    const entries = [
        { id: 1, hours: 2, comments: 'manual' },
        { id: 2, hours: 1, comments: 'Horas... [prisma-hours:43703-x]' },
    ];
    assert.strictEqual(findExistingMarker(entries, '43703-x').id, 2);
    assert.strictEqual(findExistingMarker(entries, 'outro'), null);
});

async function fakeRedmine({
    entriesByIssue = {},
    journalsByIssue = {},
    postStatus = 201,
    mutableEntries = false,
} = {}) {
    const posts = [];
    const gets = [];
    // Cópia mutável por issue (apply multi-run precisa ver spent após POST).
    const store = {};
    for (const [k, v] of Object.entries(entriesByIssue)) {
        store[k] = (v || []).map(e => ({ ...e }));
    }
    let nextId = 100;

    const server = http.createServer((req, res) => {
        const url = new URL(req.url, 'http://127.0.0.1');
        const issueMatch = url.pathname.match(/^\/issues\/(\d+)\.json$/);
        if (req.method === 'GET' && issueMatch) {
            const issueId = issueMatch[1];
            gets.push({ kind: 'issue', issueId, include: url.searchParams.get('include') });
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                issue: {
                    id: Number(issueId),
                    journals: journalsByIssue[issueId] || journalsByIssue[Number(issueId)] || [],
                },
            }));
            return;
        }
        if (req.method === 'GET' && url.pathname === '/time_entries.json') {
            const issueId = url.searchParams.get('issue_id');
            const limit = Math.max(1, Number(url.searchParams.get('limit') || 100));
            const offset = Math.max(0, Number(url.searchParams.get('offset') || 0));
            const list = store[issueId] || [];
            gets.push({ issueId, limit, offset });
            const page = list.slice(offset, offset + limit);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                time_entries: page,
                total_count: list.length,
                offset,
                limit,
            }));
            return;
        }
        if (req.method === 'POST' && url.pathname === '/time_entries.json') {
            let body = '';
            req.on('data', c => { body += c; });
            req.on('end', () => {
                const parsed = JSON.parse(body);
                posts.push(parsed);
                const entry = { id: nextId++, ...(parsed.time_entry || {}) };
                if (mutableEntries) {
                    const issueId = String(entry.issue_id);
                    if (!store[issueId]) store[issueId] = [];
                    store[issueId].push({
                        id: entry.id,
                        hours: entry.hours,
                        comments: entry.comments,
                    });
                }
                res.writeHead(postStatus, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ time_entry: entry }));
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
        gets,
        store,
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

test('syncRunHoursLive (hot path): cria mesmo com spent prévio; presume sem duração', async t => {
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
        pull_request: { 'app-back': { url: 'https://github.com/org/app-back/pull/9', pr_id: 9 } },
    });
    assert.strictEqual(runsDirOf(withHours), runs);

    const rm = await fakeRedmine({
        entriesByIssue: {
            43720: [{ id: 1, hours: 2, comments: 'apontamento manual' }],
            43721: [],
        },
        journalsByIssue: {
            43721: [
                { notes: 'ok', details: [] },
                { notes: 'qa', details: [{ name: 'status_id' }] },
                { notes: 'go', details: [] },
            ],
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
    assert.strictEqual(presumed.source, 'presumed_complexity');
    assert.strictEqual(presumed.reason, 'presumed_complexity');
    // 1 PR + 3 moves → médio 1.0h
    assert.strictEqual(presumed.hours, 1);
});

test('presumedHoursFromComplexity: escala baixo/médio/alto em degraus 0,5', () => {
    assert.strictEqual(presumedHoursFromComplexity({ moves: 0, prs: 0 }), 0.5);
    assert.strictEqual(presumedHoursFromComplexity({ moves: 2, prs: 0 }), 0.5);
    assert.strictEqual(presumedHoursFromComplexity({ moves: 3, prs: 0 }), 1);
    assert.strictEqual(presumedHoursFromComplexity({ moves: 0, prs: 1 }), 1);
    assert.strictEqual(presumedHoursFromComplexity({ moves: 9, prs: 0 }), 1.5);
    assert.strictEqual(presumedHoursFromComplexity({ moves: 0, prs: 2 }), 1.5);
    assert.strictEqual(presumedHoursFromComplexity({ moves: 9, prs: 3 }), 2); // 1.5 + 0.5
    assert.strictEqual(presumedHoursFromComplexity({ moves: 14, prs: 2 }), 2); // 1.5 + 0.5 (5 moves)

    assert.strictEqual(countPrsFromState({
        pull_request: { a: { pr_id: 1 }, b: 'https://github.com/x/y/pull/2' },
        pr_id: 1,
    }), 2);
    assert.strictEqual(countJournalMoves([
        { notes: 'a', details: [] },
        { notes: '', details: [{ name: 'status_id' }] },
        { notes: '  ', details: [] },
    ]), 2);
});

test('runBackfill presumed_complexity enriquece com journals; duration real não baixa', async t => {
    const { runs, archive } = tmpRuns();
    writeRun(archive, '43770-presume', {
        status: 'committed',
        redmine_ticket: { id: 43770 },
    });
    writeRun(archive, '43771-real-curto', {
        status: 'committed',
        redmine_ticket: { id: 43771 },
        // 0.1h real → ceil 0.5; presumido alto não substitui pra cima nem pra baixo aqui
        // (duration real prevalece)
        cost_tracking: { totals: { duration_ms: 360_000 } },
        pull_request: {
            a: { pr_id: 10 },
            b: { pr_id: 11 },
            c: { pr_id: 12 },
        },
    });

    const rm = await fakeRedmine({
        entriesByIssue: { 43770: [], 43771: [] },
        journalsByIssue: {
            43770: Array.from({ length: 10 }, (_, i) => ({ notes: `n${i}`, details: [] })),
        },
    });
    t.after(rm.close);

    const { results } = await runBackfill({
        runsDir: runs,
        dryRun: true,
        redmineFetch: rm.fetch,
        baseUrl: rm.baseUrl,
        apiKey: 'k',
        includeActive: false,
    });
    const presume = results.find(r => r.taskId === '43770-presume');
    const real = results.find(r => r.taskId === '43771-real-curto');
    assert.strictEqual(presume.action, 'would_create');
    assert.strictEqual(presume.reason, 'presumed_complexity');
    assert.strictEqual(presume.hours, 1.5); // alto por moves≥9
    assert.strictEqual(real.source, 'state.cost_tracking');
    assert.strictEqual(real.hours, 0.5); // ceil(0.1)=0.5 — não sobe pelos 3 PRs
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

test('collectCandidates inclui memory/archive/<YYYY-MM>/ (rotação cleanup-runs)', () => {
    const { runs, archive, rotated } = tmpRuns();
    writeRun(archive, '43730-ainda-em-_archive', {
        status: 'fully_merged',
        updated_at: '2026-09-01T12:00:00.000Z',
        redmine_ticket: { id: 43730 },
        cost_tracking: { totals: { duration_ms: 3_600_000 } },
    });
    const monthDir = path.join(rotated, '2026-07');
    writeRun(monthDir, '43731-rotacionado', {
        status: 'fully_merged',
        updated_at: '2026-07-15T12:00:00.000Z',
        redmine_ticket: { id: 43731 },
        cost_tracking: { totals: { duration_ms: 7_200_000 } },
    });
    // Pasta que não casa YYYY-MM — ignorada.
    writeRun(path.join(rotated, 'not-a-month'), '43732-lixo', {
        status: 'fully_merged',
        redmine_ticket: { id: 43732 },
        cost_tracking: { totals: { duration_ms: 3_600_000 } },
    });

    const list = collectCandidates(runs, { includeActive: false });
    const byId = Object.fromEntries(list.filter(c => c.ok).map(c => [c.taskId, c]));
    assert.ok(byId['43730-ainda-em-_archive'], 'ainda vê _archive');
    assert.ok(byId['43731-rotacionado'], 'vê memory/archive/YYYY-MM');
    assert.strictEqual(byId['43731-rotacionado'].hours, 2);
    assert.ok(!byId['43732-lixo'], 'ignora mês inválido');
});

test('runBackfill dry-run = apply em vários runs do mesmo ticket (sem fillEvenIfSpent)', async t => {
    const { runs, archive } = tmpRuns();
    writeRun(archive, '43740-ciclo-a', {
        status: 'fully_merged',
        updated_at: '2026-10-01T12:00:00.000Z',
        redmine_ticket: { id: 43740 },
        cost_tracking: { totals: { duration_ms: 3_600_000 } },
    });
    writeRun(archive, '43740-ciclo-b', {
        status: 'fully_merged',
        updated_at: '2026-10-02T12:00:00.000Z',
        redmine_ticket: { id: 43740 },
        cost_tracking: { totals: { duration_ms: 7_200_000 } },
    });

    const rmDry = await fakeRedmine({ entriesByIssue: { 43740: [] } });
    t.after(rmDry.close);
    const dry = await runBackfill({
        runsDir: runs,
        dryRun: true,
        redmineFetch: rmDry.fetch,
        baseUrl: rmDry.baseUrl,
        apiKey: 'k',
        includeActive: false,
        fillEvenIfSpent: false,
    });

    const rmApply = await fakeRedmine({ entriesByIssue: { 43740: [] }, mutableEntries: true });
    t.after(rmApply.close);
    const apply = await runBackfill({
        runsDir: runs,
        dryRun: false,
        redmineFetch: rmApply.fetch,
        baseUrl: rmApply.baseUrl,
        apiKey: 'k',
        includeActive: false,
        fillEvenIfSpent: false,
    });

    const dryActions = dry.results.filter(r => r.ok).map(r => `${r.taskId}:${r.action}:${r.reason || ''}`);
    const applyActions = apply.results.filter(r => r.ok).map(r => `${r.taskId}:${r.action}:${r.reason || ''}`);
    // Mesma ordem de candidatos → 1 actionable + 1 skip spent; totais iguais.
    assert.strictEqual(dry.summary.actionable, 1);
    assert.strictEqual(apply.summary.actionable, 1);
    assert.strictEqual(dry.summary.hoursWouldSync, apply.summary.hoursWouldSync);
    assert.strictEqual(dry.summary.skipped, apply.summary.skipped);
    assert.ok(dry.results.some(r => r.action === 'would_create'));
    assert.ok(dry.results.some(r => r.action === 'skip' && r.reason === 'issue_already_has_spent'));
    assert.ok(apply.results.some(r => r.action === 'created'));
    assert.ok(apply.results.some(r => r.action === 'skip' && r.reason === 'issue_already_has_spent'));
    assert.strictEqual(rmApply.posts.length, 1);
    assert.strictEqual(rmDry.posts.length, 0);
    // Ações espelhadas (would_create ↔ created).
    assert.deepStrictEqual(
        dryActions.map(s => s.replace('would_create', 'created')),
        applyActions,
    );
});

test('listTimeEntries pagina além de limit=100 (marcador na 2ª página)', async t => {
    const firstPage = [];
    for (let i = 0; i < 100; i++) {
        firstPage.push({ id: i + 1, hours: 0.1, comments: `manual-${i}` });
    }
    firstPage.push({
        id: 101,
        hours: 1.5,
        comments: `Horas... ${hoursMarker('43750-deep')}`,
    });
    const rm = await fakeRedmine({ entriesByIssue: { 43750: firstPage } });
    t.after(rm.close);

    const entries = await listTimeEntries(rm.fetch, {
        baseUrl: rm.baseUrl,
        apiKey: 'k',
        issueId: 43750,
        pageLimit: 100,
    });
    assert.strictEqual(entries.length, 101);
    assert.ok(rm.gets.length >= 2, 'fez pelo menos 2 GETs');
    assert.strictEqual(rm.gets[0].offset, 0);
    assert.strictEqual(rm.gets[1].offset, 100);
    assert.ok(findExistingMarker(entries, '43750-deep'));

    // sync também enxerga o marcador fora da 1ª página → already_synced, sem POST.
    const c = {
        ok: true,
        taskId: '43750-deep',
        ticketId: 43750,
        hours: 1.5,
        spentOn: '2026-10-02',
        source: 'state.cost_tracking',
        marker: hoursMarker('43750-deep'),
        comments: `x ${hoursMarker('43750-deep')}`,
        payload: buildTimeEntryPayload({
            issueId: 43750,
            hours: 1.5,
            spentOn: '2026-10-02',
            comments: `x ${hoursMarker('43750-deep')}`,
        }),
    };
    const r = await syncCandidateHours(c, {
        dryRun: false,
        redmineFetch: rm.fetch,
        baseUrl: rm.baseUrl,
        apiKey: 'k',
        fillEvenIfSpent: true,
    });
    assert.strictEqual(r.action, 'skip');
    assert.strictEqual(r.reason, 'already_synced');
    assert.strictEqual(rm.posts.length, 0);
});
