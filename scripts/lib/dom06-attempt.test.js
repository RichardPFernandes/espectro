// node --test scripts/lib/dom06-attempt.test.js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const dom06 = require('./dom06-attempt');

const tmpBase = process.env.CLAUDE_JOB_DIR ? path.join(process.env.CLAUDE_JOB_DIR, 'tmp') : os.tmpdir();

function runDir() {
    return fs.mkdtempSync(path.join(tmpBase, 'dom06-attempt-'));
}

const snapshot = { ticket_id: 41948, node: 'implement', base_branch: 'development', spec_hash: 'hash-v1' };
const admitted = { status: 'ADMITTED', owner: 'dom06', snapshot };

test('AC1: Attempt só começa depois de ADMITTED; DENIED e UNKNOWN não despacham e não são PASS', () => {
    const dir = runDir();
    let spawned = 0;
    const spawn = () => { spawned += 1; };

    const ok = dom06.spawnIfAdmitted(dom06.beginAttempt(dir, {
        node: 'implement', admission: admitted, obligations: [{ id: 'execute_node' }],
    }), spawn);
    assert.strictEqual(ok.dispatch, true);
    assert.strictEqual(ok.spawned, true);
    assert.strictEqual(spawned, 1);
    assert.ok(fs.existsSync(ok.attemptFile));
    const onDisk = dom06.readAttempt(ok.attemptFile);
    assert.strictEqual(onDisk.started, true);
    assert.strictEqual(onDisk.admitted_at, onDisk.created_at);

    for (const status of ['DENIED', 'UNKNOWN', null]) {
        const decision = dom06.spawnIfAdmitted(dom06.beginAttempt(dir, {
            node: 'implement',
            admission: status ? { status, owner: 'dom06', snapshot } : null,
        }), spawn);
        assert.strictEqual(decision.dispatch, false, status || 'ausente');
        assert.strictEqual(decision.spawned, false);
        const summary = dom06.summarize(dom06.readAttempt(decision.attemptFile));
        assert.notStrictEqual(summary.verdict, 'PASS');
        assert.strictEqual(summary.pass, false);
        assert.strictEqual(summary.started, false);
    }
    assert.strictEqual(spawned, 1, 'DENIED/UNKNOWN não incrementam o despacho');
});

test('AC1: hold DENIED ou JSON inválido não despacha o nó', () => {
    const dir = runDir();
    fs.mkdirSync(path.join(dir, 'dom06'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'dom06', 'hold.json'), JSON.stringify({ status: 'DENIED' }));
    const denied = dom06.prepareDispatch({ runDir: dir, node: 'plan', ticketId: 1, baseBranch: 'development', specHash: 'abc' });
    assert.strictEqual(denied.dispatch, false);
    assert.notStrictEqual(dom06.summarize(denied.attempt).verdict, 'PASS');

    fs.writeFileSync(path.join(dir, 'dom06', 'hold.json'), '{');
    const unknown = dom06.prepareDispatch({ runDir: dir, node: 'plan', ticketId: 1, baseBranch: 'development', specHash: 'abc' });
    assert.strictEqual(unknown.dispatch, false);
    assert.strictEqual(dom06.summarize(unknown.attempt).verdict, 'UNKNOWN');
    assert.strictEqual(dom06.summarize(unknown.attempt).pending_count, null);
});

test('AC2: obrigação não cumprida aparece no resultado e ausência não vira zero', () => {
    const dir = runDir();
    const decision = dom06.beginAttempt(dir, {
        node: 'commit',
        admission: { ...admitted, snapshot: { ...snapshot, node: 'commit' } },
        obligations: dom06.obligationsFor('commit'),
    });
    dom06.recordEffect(decision.attemptFile, {
        obligation_id: 'push', idempotency_key: 'push:1', status: 'fulfilled', detail: 'ok',
    });
    const summary = dom06.summarize(dom06.readAttempt(decision.attemptFile));
    assert.strictEqual(summary.verdict, 'INCOMPLETE');
    assert.strictEqual(summary.pass, false);
    assert.deepStrictEqual(summary.pending.map(item => item.id).sort(), ['pull_request', 'redmine_notes', 'redmine_status']);
    assert.strictEqual(summary.pending_count, 3);
    assert.strictEqual(summary.obligations.length, 4);

    const missing = dom06.beginAttempt(dir, { node: 'implement', admission: admitted });
    const unknown = dom06.summarize(dom06.readAttempt(missing.attemptFile));
    assert.strictEqual(unknown.obligations, null);
    assert.strictEqual(unknown.pending_count, null);
    assert.notStrictEqual(unknown.pending_count, 0);
    assert.notStrictEqual(unknown.verdict, 'PASS');
});

test('AC3: retry, timeout e resume não fazem upgrade nem rebind de owner/snapshot', () => {
    const dir = runDir();
    const first = dom06.prepareDispatch({
        runDir: dir, node: 'implement', ticketId: 41948, baseBranch: 'development', specHash: 'hash-v1',
    });
    assert.strictEqual(first.dispatch, true);
    assert.strictEqual(first.attempt.owner, 'dom06');
    assert.strictEqual(first.attempt.snapshot.spec_hash, 'hash-v1');

    for (const cause of ['retry', 'timeout', 'resume']) {
        const next = dom06.prepareDispatch({
            runDir: dir, node: 'implement', ticketId: 41948, baseBranch: 'development', specHash: 'hash-v2', cause,
        });
        assert.strictEqual(next.dispatch, true, cause);
        assert.notStrictEqual(next.attempt.attempt_id, first.attempt.attempt_id);
        assert.strictEqual(next.attempt.owner, 'dom06');
        assert.strictEqual(next.attempt.snapshot.spec_hash, 'hash-v1');
        assert.strictEqual(next.attempt.rebind_refused.snapshot.spec_hash, 'hash-v2');
        assert.deepStrictEqual(dom06.readAttempt(next.attemptFile).snapshot, next.attempt.snapshot);
    }

    const state = {
        node: 'implement',
        retries: { implement: 1 },
        recovered_from_orphan: { node: 'implement', reason: 'timeout' },
    };
    assert.strictEqual(dom06.causeFromState(state), 'timeout');
    const fromState = dom06.prepareDispatch({
        runDir: dir, node: 'implement', ticketId: 41948, baseBranch: 'development', specHash: 'hash-v3', state,
    });
    assert.strictEqual(fromState.attempt.cause, 'timeout');
    assert.strictEqual(fromState.attempt.snapshot.spec_hash, 'hash-v1');
});

test('AC4: o mesmo efeito não corre duas vezes e sem autoridade não corre', async () => {
    const dir = runDir();
    const decision = dom06.beginAttempt(dir, {
        node: 'commit',
        admission: { ...admitted, snapshot: { ...snapshot, node: 'commit' } },
        obligations: dom06.obligationsFor('commit'),
    });
    let puts = 0;
    const perform = async () => { puts += 1; return { status: 200, ok: true, detail: 'nota-1' }; };
    const first = await dom06.applyExternalEffect(decision.attemptFile, {
        obligationId: 'redmine_notes', idempotencyKey: 'note:abc', perform,
    });
    const second = await dom06.applyExternalEffect(decision.attemptFile, {
        obligationId: 'redmine_notes', idempotencyKey: 'note:abc', perform,
    });
    assert.strictEqual(first.performed, true);
    assert.strictEqual(second.duplicate, true);
    assert.strictEqual(second.performed, false);
    assert.strictEqual(puts, 1);

    const blocked = dom06.beginAttempt(dir, { node: 'commit', admission: { status: 'DENIED' } });
    let ran = 0;
    const refused = await dom06.applyExternalEffect(blocked.attemptFile, {
        obligationId: 'pull_request', idempotencyKey: 'pr:1', perform: async () => { ran += 1; return { status: 201, ok: true }; },
    });
    assert.strictEqual(refused.ok, false);
    assert.strictEqual(refused.performed, false);
    assert.strictEqual(refused.retry, false);
    assert.strictEqual(ran, 0);
    assert.notStrictEqual(dom06.summarize(dom06.readAttempt(blocked.attemptFile)).verdict, 'PASS');
});

test('AC5: 401 no meio do ciclo revoga e o efeito seguinte não executa nem conta como PASS', async () => {
    const dir = runDir();
    const decision = dom06.beginAttempt(dir, {
        node: 'commit',
        admission: { ...admitted, snapshot: { ...snapshot, node: 'commit' } },
        obligations: dom06.obligationsFor('commit'),
    });
    let calls = 0;
    const perform = async () => { calls += 1; return { status: 401, ok: false, detail: 'revoked' }; };
    const first = await dom06.applyExternalEffect(decision.attemptFile, {
        obligationId: 'pull_request', idempotencyKey: 'pr:1', perform,
    });
    const second = await dom06.applyExternalEffect(decision.attemptFile, {
        obligationId: 'redmine_status', idempotencyKey: 'status:1', perform,
    });
    assert.strictEqual(first.error, 'AUTHORITY_REVOKED');
    assert.strictEqual(first.retry, false);
    assert.strictEqual(first.performed, true);
    assert.strictEqual(second.error, 'AUTHORITY_REVOKED');
    assert.strictEqual(second.performed, false);
    assert.strictEqual(second.retry, false);
    assert.strictEqual(calls, 1);
    const summary = dom06.summarize(dom06.readAttempt(decision.attemptFile));
    assert.notStrictEqual(summary.verdict, 'PASS');
    assert.ok(summary.pending.some(item => item.id === 'redmine_status'));
    assert.ok(summary.pending_count > 0);

    const again = dom06.prepareDispatch({
        runDir: dir, node: 'commit', ticketId: 41948, baseBranch: 'development', specHash: 'hash-v1', cause: 'retry',
    });
    assert.strictEqual(again.dispatch, false);
    assert.notStrictEqual(dom06.summarize(again.attempt).verdict, 'PASS');
});

test('snapshot sem spec_hash fica null e retry não preenche com hash novo', () => {
    const dir = runDir();
    const fetch = dom06.prepareDispatch({
        runDir: dir, node: 'fetch_ticket', ticketId: 7, baseBranch: 'development', specHash: null,
    });
    assert.strictEqual(fetch.dispatch, true);
    assert.strictEqual(fetch.attempt.snapshot.spec_hash, null);

    const plan = dom06.prepareDispatch({
        runDir: dir, node: 'plan', ticketId: 7, baseBranch: 'development', specHash: null,
    });
    assert.strictEqual(plan.dispatch, true);
    assert.strictEqual(plan.attempt.snapshot.spec_hash, null);
    const retry = dom06.prepareDispatch({
        runDir: dir, node: 'plan', ticketId: 7, baseBranch: 'development', specHash: 'hash-depois', cause: 'retry',
    });
    assert.strictEqual(retry.attempt.snapshot.spec_hash, null);
    assert.strictEqual(retry.attempt.rebind_refused.snapshot.spec_hash, 'hash-depois');

    const noBase = dom06.prepareDispatch({
        runDir: dir, node: 'plan', ticketId: 7, baseBranch: null, specHash: 'abc',
    });
    assert.strictEqual(noBase.dispatch, false);
    assert.strictEqual(dom06.summarize(noBase.attempt).verdict, 'UNKNOWN');
});

test('exit 0 cumpre execute_node; commit, código diferente de 0 e repetição não duplicam', () => {
    const dir = runDir();
    const decision = dom06.beginAttempt(dir, {
        node: 'implement', admission: admitted, obligations: [{ id: 'execute_node' }],
    });
    assert.strictEqual(dom06.fulfillOnExit({
        attemptFile: decision.attemptFile, attemptId: decision.attempt.attempt_id, node: 'implement', code: null,
    }), false);
    assert.strictEqual(dom06.fulfillOnExit({
        attemptFile: decision.attemptFile, attemptId: decision.attempt.attempt_id, node: 'implement', code: 0,
    }), true);
    assert.strictEqual(dom06.fulfillOnExit({
        attemptFile: decision.attemptFile, attemptId: decision.attempt.attempt_id, node: 'implement', code: 0,
    }), true);
    const attempt = dom06.readAttempt(decision.attemptFile);
    assert.strictEqual(attempt.obligations.find(item => item.id === 'execute_node').status, 'fulfilled');
    assert.strictEqual(attempt.effects.length, 1);
    const commit = dom06.beginAttempt(dir, {
        node: 'commit',
        admission: { ...admitted, snapshot: { ...snapshot, node: 'commit' } },
        obligations: dom06.obligationsFor('commit'),
    });
    assert.strictEqual(dom06.fulfillOnExit({
        attemptFile: commit.attemptFile, attemptId: commit.attempt.attempt_id, node: 'commit', code: 0,
    }), false);
    assert.ok(dom06.readAttempt(commit.attemptFile).obligations.every(item => item.status === 'pending'));
});

// Regressão (#43511, #43782, #43812, #43819): o redmine-effect mandava o PUT sem
// X-Redmine-API-Key, o Redmine respondia 401 e o Attempt era revogado — nenhum
// /commit movia o ticket pra "Ag Merge". O Redmine falso aqui exige a chave.
test('redmine-effect manda X-Redmine-API-Key do ambiente; sem chave não chama nem revoga', async () => {
    const http = require('http');
    const { execFile } = require('child_process');
    const KEY = 'chave-falsa-redmine-effect';
    const seen = [];
    const server = http.createServer((req, res) => {
        let body = '';
        req.on('data', c => { body += c; });
        req.on('end', () => {
            seen.push({ method: req.method, url: req.url, key: req.headers['x-redmine-api-key'] || null, body });
            res.writeHead(req.headers['x-redmine-api-key'] === KEY ? 204 : 401);
            res.end();
        });
    });
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${server.address().port}/issues/1.json`;
    const cli = (attemptFile, env) => new Promise(resolve => {
        const child = execFile(process.execPath, [path.join(__dirname, 'dom06-attempt.js'), 'redmine-effect',
            '--attempt', attemptFile, '--obligation', 'redmine_status', '--url', url, '--method', 'PUT'],
        { env: { PATH: process.env.PATH, REDMINE_RETRY_MAX_ATTEMPTS: '1', REDMINE_MIN_INTERVAL_MS: '0', ...env } },
        (err, stdout, stderr) => resolve({ code: err ? err.code : 0, stdout, stderr }));
        child.stdin.end('{"issue":{"status_id":20}}');
    });
    const begin = () => dom06.beginAttempt(runDir(), {
        node: 'commit',
        admission: { ...admitted, snapshot: { ...snapshot, node: 'commit' } },
        obligations: dom06.obligationsFor('commit'),
    }).attemptFile;
    try {
        const semChave = begin();
        const r1 = await cli(semChave, {});
        assert.strictEqual(r1.code, 1, r1.stderr);
        assert.match(r1.stderr, /REDMINE_API_KEY ausente/);
        assert.strictEqual(seen.length, 0, 'sem chave o Redmine não é chamado');
        assert.notStrictEqual(dom06.readAttempt(semChave).authority, 'revoked');

        const comChave = begin();
        const r2 = await cli(comChave, { REDMINE_API_KEY: KEY });
        assert.strictEqual(r2.code, 0, r2.stderr);
        assert.strictEqual(r2.stdout.trim(), 'OK');
        assert.deepStrictEqual(seen.map(s => [s.method, s.key, s.body]), [['PUT', KEY, '{"issue":{"status_id":20}}']]);
        const summary = dom06.summarize(dom06.readAttempt(comChave));
        assert.strictEqual(summary.obligations.find(o => o.id === 'redmine_status').status, 'fulfilled');
        assert.notStrictEqual(dom06.readAttempt(comChave).authority, 'revoked');
    } finally {
        server.close();
    }
});
