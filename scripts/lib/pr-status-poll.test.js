// node --test scripts/lib/pr-status-poll.test.js
// Polling pós-abertura dos PRs (consistência cross-repo): parsing dos formatos reais
// de pull_request, ciclo completo contra memory/runs sintéticos (getStatus stubado),
// throttle/retry do startPrStatusPolling, check-pr-status.js contra um Bitbucket
// falso e o schema aceitando os campos novos.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const poll = require('./pr-status-poll');
const { getPRStatus } = require('../check-pr-status');
const { validateState } = require('../validate-state');

const tmpBase = process.env.CLAUDE_JOB_DIR ? path.join(process.env.CLAUDE_JOB_DIR, 'tmp') : os.tmpdir();
const T0 = '2026-09-20T10:00:00.000Z';
const NOW = new Date('2026-09-22T13:00:00.000Z');
const url = (repo, id) => `https://bitbucket.org/mosistemas/${repo}/pull-requests/${id}`;

function freshRepo() {
    const root = fs.mkdtempSync(path.join(tmpBase, 'pr-poll-'));
    const main = path.join(root, 'memory', 'runs');
    const wt = id => path.join(root, '.claude', 'worktrees', String(id), 'memory', 'runs');
    const roots = () => {
        const out = [{ dir: main }];
        const wtDir = path.join(root, '.claude', 'worktrees');
        if (fs.existsSync(wtDir)) for (const d of fs.readdirSync(wtDir)) out.push({ dir: wt(d), worktree: d });
        return out;
    };
    return { root, main, wt, roots };
}

function seed(runsDir, taskId, state, { archived = true } = {}) {
    const dir = path.join(runsDir, archived ? '_archive' : '', taskId);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({
        task_id: taskId, node: 'commit', history: ['plan', 'commit'], status: 'committed',
        started_at: T0, updated_at: T0, ...state,
    }, null, 2));
    return dir;
}

const read = dir => JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'));

function stubStatus(map) {
    const calls = [];
    const fn = async ({ workspace, repo, prId }) => {
        calls.push(`${workspace}/${repo}/${prId}`);
        const v = map[`${repo}#${prId}`];
        if (v instanceof Error) throw v;
        if (!v) throw Object.assign(new Error('Bitbucket API: 404'), { status: 404 });
        return { status: v, url: url(repo, prId) };
    };
    fn.calls = calls;
    return fn;
}

function capture() {
    const lines = [];
    const push = (...a) => lines.push(a.join(' '));
    return { lines, log: push, warn: push, error: push };
}

const cycle = (opts) => poll.runPrStatusCycle({ now: () => NOW, ...opts });

// ---------------------------------------------------------------------------------

test('listPrEntries entende os formatos reais de pull_request', () => {
    const e = poll.listPrEntries({
        'app-back': { url: url('app-back', 7658), id: 7658 },
        'app-front': url('app-front', 6082),
        'app-core': { pr_url: url('app-core', 3846), branch: '43386' },
        'mo-entity': { url: url('mo-entity', 1722), status: 'open' },
        'app-log': { branch: 'x', pushed: true, pr_url: null },
    });
    assert.deepStrictEqual(e.map(x => [x.key, x.workspace, x.repo, x.prId, x.status]), [
        ['app-back', 'mosistemas', 'app-back', 7658, null],
        ['app-front', 'mosistemas', 'app-front', 6082, null],
        ['app-core', 'mosistemas', 'app-core', 3846, null],
        ['mo-entity', 'mosistemas', 'mo-entity', 1722, 'OPEN'],
        ['app-log', null, 'app-log', null, null],
    ]);
    assert.strictEqual(poll.listPrEntries({ 'app-back': { pr_id: 42 } }, 'ws')[0].workspace, 'ws');
    assert.strictEqual(poll.listPrEntries({ 'app-back': { pr_id: 42 } }, 'ws')[0].prId, 42);
    // Formato plano legado (sem repo) e lixo: nada a consultar.
    assert.deepStrictEqual(poll.listPrEntries({ url: url('app-back', 1), id: 1 }), []);
    assert.deepStrictEqual(poll.listPrEntries(null), []);
    assert.deepStrictEqual(poll.listPrEntries('https://x'), []);
});

test('findInconsistency: só MERGED + DECLINED entre repos irmãos', () => {
    assert.strictEqual(
        poll.findInconsistency({ 'app-back': 'DECLINED', 'app-front': 'MERGED' }),
        'PR inconsistência cross-repo: app-front MERGED mas app-back DECLINED');
    assert.strictEqual(poll.findInconsistency({ 'app-back': 'OPEN', 'app-front': 'MERGED' }), null);
    assert.strictEqual(poll.findInconsistency({ 'app-back': 'DECLINED' }), null, 'repo único nunca é inconsistente');
    assert.strictEqual(poll.findInconsistency({}), null);
});

test('resolvePollIntervalMs: padrão 600000, env válida sobrescreve', () => {
    assert.strictEqual(poll.resolvePollIntervalMs({}), 600000);
    assert.strictEqual(poll.resolvePollIntervalMs({ PR_STATUS_POLL_INTERVAL_MS: '5000' }), 5000);
    assert.strictEqual(poll.resolvePollIntervalMs({ PR_STATUS_POLL_INTERVAL_MS: 'abc' }), 600000);
    assert.strictEqual(poll.resolvePollIntervalMs({ PR_STATUS_POLL_INTERVAL_MS: '0' }), 600000);
});

test('sem task committed: ciclo vazio não é erro', async () => {
    const r = freshRepo();
    const getStatus = stubStatus({});
    const out = capture();
    const s = await cycle({ roots: r.roots, getStatus, log: out });
    assert.strictEqual(s.tasks, 0);
    assert.strictEqual(s.errors, 0);
    assert.strictEqual(getStatus.calls.length, 0);
    // Diretório de runs inexistente também não quebra.
    assert.strictEqual((await cycle({ roots: [{ dir: path.join(r.root, 'nao-existe') }], getStatus, log: out })).tasks, 0);
});

test('atualiza status/last_checked_at por repo, loga a linha e não mexe em updated_at', async () => {
    const r = freshRepo();
    const dir = seed(r.wt(93001), '93001-monitor', {
        pull_request: {
            'app-back': { url: url('app-back', 7001), id: 7001 },
            'app-front': url('app-front', 6001),
        },
    });
    seed(r.wt(93002), '93002-andando', { status: 'in_progress', pull_request: { 'app-back': url('app-back', 7002) } }, { archived: false });
    const getStatus = stubStatus({ 'app-back#7001': 'OPEN', 'app-front#6001': 'MERGED', 'app-back#7002': 'MERGED' });
    const out = capture();

    const s = await cycle({ roots: r.roots, getStatus, log: out });
    assert.strictEqual(s.tasks, 1, 'só a committed entra no polling');
    assert.deepStrictEqual(getStatus.calls.sort(), ['mosistemas/app-back/7001', 'mosistemas/app-front/6001']);

    const st = read(dir);
    assert.strictEqual(st.status, 'committed');
    assert.strictEqual(st.updated_at, T0, 'updated_at intocado (mostRecentArchivedCommit depende dele)');
    assert.deepStrictEqual(st.pull_request['app-back'], { url: url('app-back', 7001), id: 7001, status: 'OPEN', last_checked_at: NOW.toISOString() });
    assert.deepStrictEqual(st.pull_request['app-front'], { url: url('app-front', 6001), pr_id: 6001, status: 'MERGED', last_checked_at: NOW.toISOString() });
    assert.ok(out.lines.includes('[pr-check] Task 93001-monitor: app-back=OPEN, app-front=MERGED'), out.lines.join('\n'));
    assert.ok(!st.events, 'OPEN + MERGED não é inconsistência');
    assert.ok(validateState(st).valid, JSON.stringify(validateState(st).errors));

    // Próximo ciclo: PR do back mergeado → ambos MERGED → fully_merged, e sai do polling.
    const getStatus2 = stubStatus({ 'app-back#7001': 'MERGED', 'app-front#6001': 'MERGED' });
    const s2 = await cycle({ roots: r.roots, getStatus: getStatus2, log: out });
    assert.deepStrictEqual(s2.fullyMerged, ['93001-monitor']);
    const st2 = read(dir);
    assert.strictEqual(st2.pull_request['app-back'].status, 'MERGED');
    assert.strictEqual(st2.status, 'fully_merged');
    assert.strictEqual(st2.events.at(-1).type, 'fully_merged');
    assert.ok(validateState(st2).valid, JSON.stringify(validateState(st2).errors));

    const getStatus3 = stubStatus({});
    assert.strictEqual((await cycle({ roots: r.roots, getStatus: getStatus3, log: out })).tasks, 0);
    assert.strictEqual(getStatus3.calls.length, 0, 'fully_merged não recebe mais polling');
});

test('MERGED + DECLINED: evento escalation uma vez só, alerta logado a cada ciclo', async () => {
    const r = freshRepo();
    const dir = seed(r.wt(93003), '93003-inconsistente', {
        pull_request: { 'app-back': { url: url('app-back', 7003) }, 'app-front': { url: url('app-front', 6003) } },
        events: [{ type: 'node_error', node: 'test', at: T0, detail: 'antigo' }],
    });
    const getStatus = stubStatus({ 'app-back#7003': 'DECLINED', 'app-front#6003': 'MERGED' });
    const out = capture();
    const detail = 'PR inconsistência cross-repo: app-front MERGED mas app-back DECLINED';

    const s = await cycle({ roots: r.roots, getStatus, log: out });
    assert.deepStrictEqual(s.inconsistencies, [{ taskId: '93003-inconsistente', detail }]);
    await cycle({ roots: r.roots, getStatus, log: out });

    const st = read(dir);
    assert.strictEqual(st.status, 'committed', 'inconsistente não vira fully_merged');
    assert.strictEqual(st.events.length, 2, 'evento antigo preservado + 1 escalation (sem duplicar no 2º ciclo)');
    assert.deepStrictEqual(st.events[1], { type: 'escalation', node: 'commit', at: NOW.toISOString(), detail });
    assert.strictEqual(out.lines.filter(l => l.includes('ALERTA') && l.includes(detail)).length, 2);
    assert.ok(validateState(st).valid, JSON.stringify(validateState(st).errors));
});

test('repo único: registra status, sem checagem de consistência; MERGED → fully_merged', async () => {
    const r = freshRepo();
    const declined = seed(r.main, '2026-09-21-so-back', { pull_request: { 'app-back': url('app-back', 7666) } });
    const merged = seed(r.main, '2026-09-21-so-back-2', { pull_request: { 'app-back': url('app-back', 7667) } });
    const s = await cycle({ roots: r.roots, getStatus: stubStatus({ 'app-back#7666': 'DECLINED', 'app-back#7667': 'MERGED' }), log: capture() });
    assert.deepStrictEqual(s.inconsistencies, []);
    assert.strictEqual(read(declined).pull_request['app-back'].status, 'DECLINED');
    assert.strictEqual(read(declined).status, 'committed');
    assert.ok(!read(declined).events);
    assert.strictEqual(read(merged).status, 'fully_merged');
});

test('erro na consulta: mantém status anterior, loga, e as outras tasks seguem', async () => {
    const r = freshRepo();
    const dir = seed(r.wt(93004), '93004-erro', {
        pull_request: {
            'app-back': { url: url('app-back', 7004), status: 'OPEN', last_checked_at: T0 },
            'app-front': { url: url('app-front', 6004) },
        },
    });
    const other = seed(r.wt(93005), '93005-ok', { pull_request: { 'app-back': url('app-back', 7005) } });
    const out = capture();
    const s = await cycle({
        roots: r.roots, log: out,
        getStatus: stubStatus({ 'app-back#7004': new Error('Bitbucket API: 503'), 'app-front#6004': 'MERGED', 'app-back#7005': 'OPEN' }),
    });
    assert.strictEqual(s.errors, 1);
    const st = read(dir);
    assert.deepStrictEqual(st.pull_request['app-back'], { url: url('app-back', 7004), status: 'OPEN', last_checked_at: T0 });
    assert.strictEqual(st.pull_request['app-front'].status, 'MERGED');
    assert.strictEqual(st.status, 'committed', 'um repo sem confirmação impede fully_merged');
    assert.strictEqual(read(other).pull_request['app-back'].status, 'OPEN');
    assert.ok(out.lines.some(l => l.includes('falha consultando app-back#7004') && l.includes('503')));
});

test('entrada sem número de PR: não consulta, não quebra, bloqueia fully_merged', async () => {
    const r = freshRepo();
    const dir = seed(r.wt(93006), '93006-sem-id', {
        pull_request: { 'app-back': url('app-back', 7006), 'app-front': { branch: '93006', pushed: true, pr_url: null } },
    });
    const getStatus = stubStatus({ 'app-back#7006': 'MERGED' });
    const out = capture();
    await cycle({ roots: r.roots, getStatus, log: out });
    assert.deepStrictEqual(getStatus.calls, ['mosistemas/app-back/7006']);
    assert.strictEqual(read(dir).status, 'committed');
    assert.ok(out.lines.some(l => l.includes('app-front sem número de PR')));
    assert.ok(out.lines.includes('[pr-check] Task 93006-sem-id: app-back=MERGED, app-front=UNKNOWN'));
});

test('cópias do mesmo task-id: vale a do worktree do ticket; PR repetido é consultado 1x por ciclo', async () => {
    const r = freshRepo();
    const pr = { 'app-back': url('app-back', 7669), 'app-front': url('app-front', 6090) };
    // Cópia velha "committed" no checkout principal; a do worktree já está fully_merged.
    const stale = seed(r.main, '93007-copia', { pull_request: pr, updated_at: '2026-09-21T00:00:00.000Z' });
    seed(r.wt(93007), '93007-copia', { pull_request: pr, status: 'fully_merged' });
    // Duas tasks diferentes reaproveitando os mesmos PRs.
    const a = seed(r.wt(93008), '93008-a', { pull_request: pr });
    const b = seed(r.wt(93008), '93008-b', { pull_request: pr });
    const getStatus = stubStatus({ 'app-back#7669': 'OPEN', 'app-front#6090': 'OPEN' });
    const s = await cycle({ roots: r.roots, getStatus, log: capture() });
    assert.strictEqual(s.tasks, 2);
    assert.strictEqual(getStatus.calls.length, 2, 'cache por ciclo');
    assert.strictEqual(read(a).pull_request['app-back'].status, 'OPEN');
    assert.strictEqual(read(b).pull_request['app-front'].status, 'OPEN');
    assert.strictEqual(typeof read(stale).pull_request['app-back'], 'string', 'cópia não-canônica intocada');
});

test('dryRun consulta mas não grava; filter restringe as tasks', async () => {
    const r = freshRepo();
    const dir = seed(r.wt(93009), '93009-dry', { pull_request: { 'app-back': url('app-back', 7009) } });
    seed(r.wt(93010), '93010-fora', { pull_request: { 'app-back': url('app-back', 7010) } });
    const before = fs.readFileSync(path.join(dir, 'state.json'), 'utf8');
    const getStatus = stubStatus({ 'app-back#7009': 'MERGED', 'app-back#7010': 'MERGED' });
    const s = await cycle({ roots: r.roots, getStatus, log: capture(), dryRun: true, filter: id => id.startsWith('93009-') });
    assert.strictEqual(s.tasks, 1);
    assert.deepStrictEqual(s.fullyMerged, ['93009-dry']);
    assert.strictEqual(s.written, 0);
    assert.strictEqual(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'), before);
});

test('startPrStatusPolling: sem token desliga; marcador recente segura; force e withRetry', async () => {
    const r = freshRepo();
    seed(r.wt(93011), '93011-bg', { pull_request: { 'app-back': url('app-back', 7011) } });
    const marker = path.join(r.root, 'pr-status-poll.json');
    const out = capture();

    const off = stubStatus({ 'app-back#7011': 'OPEN' });
    const p0 = poll.startPrStatusPolling({ token: '', roots: r.roots, getStatus: off, log: out });
    assert.strictEqual(await p0.settle(), null);
    assert.strictEqual(off.calls.length, 0);
    assert.ok(out.lines.some(l => l.includes('BITBUCKET_API_TOKEN ausente')));

    // Primeiro start: sem marcador → roda já (em background), grava o marcador.
    let retried = 0;
    const withRetry = fn => { retried++; return fn(); };
    const tokens = [];
    const getStatus = async args => { tokens.push(args.token); return { status: 'OPEN', url: 'u' }; };
    const p1 = poll.startPrStatusPolling({ token: 'tok', intervalMs: 600000, markerPath: marker, roots: r.roots, getStatus, withRetry, now: () => NOW, log: out });
    const s1 = await p1.settle();
    p1.stop();
    assert.strictEqual(s1.tasks, 1);
    assert.strictEqual(retried, 1, 'cada consulta passa por withRetry');
    assert.deepStrictEqual(tokens, ['tok'], 'token repassado pro getStatus');
    assert.strictEqual(JSON.parse(fs.readFileSync(marker, 'utf8')).last_run_at, NOW.toISOString());

    // Segundo start 1 min depois: dentro do intervalo → não roda.
    const later = () => new Date(NOW.getTime() + 60000);
    const p2 = poll.startPrStatusPolling({ token: 'tok', intervalMs: 600000, markerPath: marker, roots: r.roots, getStatus, withRetry, now: later, log: out });
    assert.strictEqual(await p2.settle(), null);
    p2.stop();
    assert.strictEqual(retried, 1);

    // force ignora o marcador (--pr-status-only).
    const p3 = poll.startPrStatusPolling({ token: 'tok', intervalMs: 600000, markerPath: marker, force: true, roots: r.roots, getStatus, withRetry, now: later, log: out });
    assert.strictEqual((await p3.settle()).tasks, 1);
    p3.stop();
});

test('startPrStatusPolling: setInterval dispara ciclos periódicos sem empilhar', async t => {
    t.mock.timers.enable({ apis: ['setInterval'] });
    const r = freshRepo();
    seed(r.wt(93012), '93012-tick', { pull_request: { 'app-back': url('app-back', 7012) } });
    let calls = 0;
    let release;
    const getStatus = () => {
        calls++;
        return new Promise(resolve => { release = () => resolve({ status: 'OPEN' }); });
    };
    const p = poll.startPrStatusPolling({ token: 't', intervalMs: 20, roots: r.roots, getStatus, log: capture() });
    try {
        for (let expected = 1; expected <= 3; expected++) {
            assert.strictEqual(calls, expected, 'um ciclo inicial e novos ciclos pelo intervalo');
            t.mock.timers.tick(100);
            assert.strictEqual(calls, expected, 'intervalos não empilham consultas enquanto o ciclo está pendente');
            release();
            await p.settle();
            if (expected < 3) t.mock.timers.tick(20);
        }
    } finally { p.stop(); }
    t.mock.timers.tick(100);
    assert.strictEqual(calls, 3, 'stop cancela os ciclos periódicos');
});

test('getPRStatus: Bearer no header, devolve state + link html; erro HTTP lança com status', async () => {
    const seen = [];
    const srv = http.createServer((req, res) => {
        seen.push({ url: req.url, auth: req.headers.authorization });
        if (req.url === '/2.0/repositories/ws/app-back/pullrequests/42') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ id: 42, state: 'MERGED', links: { html: { href: 'https://bitbucket.org/ws/app-back/pull-requests/42' } } }));
        }
        res.writeHead(404); res.end('{}');
    });
    await new Promise(res => srv.listen(0, '127.0.0.1', res));
    const apiBase = `http://127.0.0.1:${srv.address().port}/2.0`;
    try {
        assert.deepStrictEqual(await getPRStatus({ workspace: 'ws', repo: 'app-back', prId: 42, token: 'segredo', apiBase }),
            { status: 'MERGED', url: 'https://bitbucket.org/ws/app-back/pull-requests/42', draft: false });
        await assert.rejects(getPRStatus({ workspace: 'ws', repo: 'app-back', prId: 99, token: 'segredo', apiBase }),
            e => e.status === 404 && e.message === 'Bitbucket API: 404' && !e.message.includes('segredo'));
        assert.ok(seen.every(s => s.auth === 'Bearer segredo' && !s.url.includes('segredo')));
    } finally {
        srv.close();
    }
});

test('schema: fully_merged e status/last_checked_at/pr_id por PR são válidos; status fora da enum não', () => {
    const base = { task_id: 't', node: 'commit', history: [], started_at: T0 };
    const ok = validateState({ ...base, status: 'fully_merged', pull_request: {
        'app-back': { url: url('app-back', 42), pr_id: 42, status: 'OPEN', last_checked_at: NOW.toISOString() },
        'app-front': { url: url('app-front', 7), pr_id: 7, status: 'MERGED', last_checked_at: NOW.toISOString() },
        'mo-entity': { url: url('mo-entity', 1), status: 'open' },
    } });
    assert.ok(ok.valid, JSON.stringify(ok.errors));
    assert.ok(!validateState({ ...base, status: 'committed', pull_request: { 'app-back': { url: 'u', status: 'WHATEVER' } } }).valid);
});

test('pr_status acompanha o draft do Bitbucket: algum Draft → "draft", nenhum → "ready"; pr_id do app-back', async t => {
    // pr_id vem do repo principal: fixa a identidade da fixture, não a do checkout.
    const savedMain = process.env.WATCHER_MAIN_REPO_NAME;
    process.env.WATCHER_MAIN_REPO_NAME = 'app-back';
    t.after(() => {
        if (savedMain === undefined) delete process.env.WATCHER_MAIN_REPO_NAME;
        else process.env.WATCHER_MAIN_REPO_NAME = savedMain;
    });
    const r = freshRepo();
    const both = { 'app-front': url('app-front', 81), 'app-back': url('app-back', 80) };
    const dir = seed(r.main, '6100-draft', { pull_request: both });
    const drafts = { 'app-back#80': true, 'app-front#81': false };
    const getStatus = async ({ repo, prId }) => ({ status: 'OPEN', url: url(repo, prId), draft: drafts[`${repo}#${prId}`] });
    await cycle({ roots: r.roots, getStatus, log: capture() });
    assert.strictEqual(read(dir).pr_status, 'draft');
    assert.strictEqual(read(dir).pr_id, 80);
    assert.strictEqual(read(dir).pull_request['app-front'].draft, false);
    drafts['app-back#80'] = false; // alguém tirou de Draft direto no Bitbucket
    await cycle({ roots: r.roots, getStatus, log: capture() });
    assert.strictEqual(read(dir).pr_status, 'ready');
    // getStatus sem `draft` (stub antigo / API sem o campo): pr_status não é inventado.
    const legacy = seed(r.main, '6101-legado', { pull_request: { 'app-back': url('app-back', 82) } });
    await cycle({ roots: r.roots, getStatus: stubStatus({ 'app-back#80': 'OPEN', 'app-front#81': 'OPEN', 'app-back#82': 'OPEN' }), log: capture() });
    assert.strictEqual(read(legacy).pr_status, undefined);
});

test('fully_merged: pr_status "merged" gravado ANTES do onFullyMerged; erro no hook não derruba o ciclo; dryRun não chama', async () => {
    const r = freshRepo();
    const dir = seed(r.main, '6200-merge', { pr_status: 'ready', pull_request: { 'app-back': url('app-back', 90) } });
    const open = seed(r.main, '6201-aberto', { pull_request: { 'app-back': url('app-back', 91) } });
    const getStatus = stubStatus({ 'app-back#90': 'MERGED', 'app-back#91': 'OPEN' });

    const dry = [];
    await cycle({ roots: r.roots, getStatus, log: capture(), dryRun: true, onFullyMerged: t => dry.push(t) });
    assert.deepStrictEqual(dry, []);

    const seen = [];
    const log = capture();
    const s = await cycle({
        roots: r.roots, getStatus, log,
        onFullyMerged: async t => { seen.push({ taskId: t.taskId, onDisk: read(t.dir), passed: t.state.pr_status }); throw new Error('boom'); },
    });
    assert.deepStrictEqual(s.fullyMerged, ['6200-merge']);
    assert.strictEqual(seen.length, 1);
    assert.strictEqual(seen[0].onDisk.status, 'fully_merged');
    assert.strictEqual(seen[0].onDisk.pr_status, 'merged');
    assert.strictEqual(seen[0].passed, 'merged');
    assert.ok(log.lines.some(l => /6200-merge: pós-merge falhou: boom/.test(l)));
    assert.strictEqual(read(open).status, 'committed');
    assert.strictEqual(read(dir).status, 'fully_merged');
});

test('schema: pr_status/pr_id/worktrees_cleaned_at/worktrees_cleanup_errors', () => {
    const base = { task_id: 't', node: 'commit', history: [], started_at: T0, status: 'fully_merged' };
    for (const extra of [
        { pr_status: 'draft', pr_id: '' },
        { pr_status: 'ready', pr_id: 42 },
        { pr_status: 'merged', pr_id: '42', worktrees_cleaned_at: NOW.toISOString(), worktrees_cleanup_errors: [{ path: '/x', error: 'e' }] },
        { pr_status: null, worktrees_cleaned_at: null },
    ]) {
        const v = validateState({ ...base, ...extra });
        assert.ok(v.valid, `${JSON.stringify(extra)}: ${JSON.stringify(v.errors)}`);
    }
    assert.ok(!validateState({ ...base, pr_status: 'open' }).valid);
    assert.ok(!validateState({ ...base, worktrees_cleaned_at: 123 }).valid);
});
