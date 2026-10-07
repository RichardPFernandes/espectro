// node --test scripts/effect-authority.test.js
// PRI-66: efeitos externos do /commit (PR no Bitbucket, nota/status no Redmine) sob
// credencial revogada no meio do ciclo e repetição do mesmo efeito. Só transportes
// falsos: Bitbucket falso em loopback (BITBUCKET_API_BASE) e fetch injetado no
// redmine-fetch. Não existe seam de admissão DOM06/autoridade por Attempt nesta
// revisão. PRI-71 faz o bitbucket-open-pr.sh cumprir o contrato que antes era
// `# TODO`: 401/403 antes do POST não tenta o efeito, e repetir a abertura
// reutiliza o PR OPEN em vez de criar outro.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { execFile } = require('child_process');
const { createRedmineFetch } = require('./lib/redmine-fetch');

const WS = 'ws';
const REPO = 'app-front';
const TOKEN = 'tok-fake-pri66';
const tmpBase = process.env.CLAUDE_JOB_DIR ? path.join(process.env.CLAUDE_JOB_DIR, 'tmp') : os.tmpdir();
const tmp = fs.mkdtempSync(path.join(tmpBase, 'effect-authority-'));
fs.mkdirSync(path.join(tmp, 'scripts'));
const script = path.join(tmp, 'scripts', 'bitbucket-open-pr.sh');
fs.copyFileSync(path.join(__dirname, 'bitbucket-open-pr.sh'), script);
fs.chmodSync(script, 0o755);

// Bitbucket falso: `revoked` faz toda chamada autenticada responder 401 a partir dali;
// `revokeAfterReviewers` revoga logo depois do GET de reviewers (meio do ciclo).
let fake;
const calls = [];
const prs = [];

const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
        const u = new URL(req.url, 'http://x');
        calls.push(`${req.method} ${u.pathname}`);
        const send = (status, obj) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
        if (fake.revoked) return send(fake.revokedStatus || 401, { type: 'error', error: { message: 'Token is invalid, expired, or not supported for this endpoint.' } });
        if (u.pathname === `/2.0/repositories/${WS}/${REPO}/effective-default-reviewers`) {
            if (fake.revokeAfterReviewers) fake.revoked = true;
            return send(200, { values: [] });
        }
        if (u.pathname === `/2.0/repositories/${WS}/${REPO}/pullrequests` && req.method === 'GET') {
            const q = u.searchParams.get('q') || '';
            const values = prs.filter(pr =>
                q.includes(`source.branch.name="${pr.source}"`) &&
                q.includes(`destination.branch.name="${pr.destination}"`) &&
                q.includes('state="OPEN"')
            ).map(pr => ({
                id: pr.id,
                state: 'OPEN',
                source: { branch: { name: pr.source } },
                destination: { branch: { name: pr.destination } },
                links: { html: { href: `https://bitbucket.org/${WS}/${REPO}/pull-requests/${pr.id}` } },
            }));
            return send(200, { values });
        }
        if (u.pathname === `/2.0/repositories/${WS}/${REPO}/pullrequests` && req.method === 'POST') {
            const payload = JSON.parse(body);
            const id = prs.length + 1;
            prs.push({ id, source: payload.source.branch.name, destination: payload.destination.branch.name });
            return send(201, { id, links: { html: { href: `https://bitbucket.org/${WS}/${REPO}/pull-requests/${id}` } }, reviewers: [] });
        }
        send(404, {});
    });
});
const base = () => `http://127.0.0.1:${server.address().port}/2.0`;

function openPr() {
    return new Promise(resolve => {
        const child = execFile('bash', [script, REPO, '41948', 'development', 'Melhoria #41948'], {
            env: { PATH: process.env.PATH, HOME: process.env.HOME, BITBUCKET_WORKSPACE: WS, BITBUCKET_API_TOKEN: TOKEN, BITBUCKET_API_BASE: base(), BITBUCKET_ACCOUNT_ID: 'acc-eu', REPO_PATH: tmp },
        }, (err, stdout, stderr) => resolve({ code: err ? err.code : 0, stdout, stderr }));
        child.stdin.end('descrição');
    });
}

const posts = () => calls.filter(c => c.endsWith('/pullrequests') && c.startsWith('POST')).length;

test.before(() => new Promise(r => server.listen(0, '127.0.0.1', r)));
test.after(() => { server.close(); fs.rmSync(tmp, { recursive: true, force: true }); });
test.beforeEach(() => { calls.length = 0; prs.length = 0; });

test('Bitbucket: credencial revogada antes do ciclo => erro explícito, nenhum POST, sem PR e sem vazar token', async () => {
    fake = { revoked: true };
    const r = await openPr();
    assert.strictEqual(r.code, 1);
    assert.match(r.stderr, /ERROR: HTTP 401/);
    assert.strictEqual(r.stdout.trim(), '', 'nenhuma URL de PR em stdout');
    assert.strictEqual(posts(), 0, '401 antes do POST não tenta criar o PR');
    assert.strictEqual(prs.length, 0);
    assert.ok(!r.stderr.includes(TOKEN) && !r.stdout.includes(TOKEN));
});

test('Bitbucket: revogação no meio do ciclo (depois do GET de reviewers) => consulta de PR 401, sem POST', async () => {
    fake = { revokeAfterReviewers: true };
    const r = await openPr();
    assert.strictEqual(r.code, 1);
    assert.match(r.stderr, /ERROR: HTTP 401/);
    assert.strictEqual(posts(), 0);
    assert.strictEqual(prs.length, 0);
    assert.ok(calls.includes(`GET /2.0/repositories/${WS}/${REPO}/pullrequests`));
});

test('Bitbucket: 401 no GET de reviewers aborta antes do POST', async () => {
    fake = { revoked: true };
    const r = await openPr();
    assert.strictEqual(r.code, 1);
    assert.match(r.stderr, /ERROR: HTTP 401/);
    assert.doesNotMatch(r.stderr, /WARN: não deu pra buscar os default reviewers/);
    assert.deepStrictEqual(calls, [`GET /2.0/repositories/${WS}/${REPO}/effective-default-reviewers`]);
});

test('PRI-66 AC5: autoridade negada (401/403) no GET de reviewers bloqueia o efeito seguinte (nenhum POST)', async () => {
    fake = { revoked: true, revokedStatus: 403 };
    const r = await openPr();
    assert.strictEqual(r.code, 1);
    assert.match(r.stderr, /ERROR: HTTP 403/);
    assert.strictEqual(posts(), 0);
});

test('Bitbucket: repetir a abertura consulta PRs OPEN e não faz o segundo POST', async () => {
    fake = {};
    const a = await openPr();
    const b = await openPr();
    assert.strictEqual(a.code, 0, a.stderr);
    assert.strictEqual(b.code, 0, b.stderr);
    assert.strictEqual(posts(), 1);
    assert.ok(calls.filter(c => c.startsWith('GET') && c.endsWith('/pullrequests')).length >= 2);
    assert.strictEqual(b.stdout.trim(), a.stdout.trim());
});

test('PRI-66 AC4: repetir a abertura de PR para a mesma branch não cria segundo PR', async () => {
    fake = {};
    const a = await openPr();
    const b = await openPr();
    assert.strictEqual(a.code, 0, a.stderr);
    assert.strictEqual(b.code, 0, b.stderr);
    assert.strictEqual(prs.length, 1);
    assert.strictEqual(b.stdout.trim(), a.stdout.trim());
    assert.match(b.stdout, /pull-requests\/1/);
});

// ── Redmine ─────────────────────────────────────────────────────────────────────

function fakeRedmine() {
    const state = { revoked: false, calls: [], logs: [] };
    const fetch = async (url, init = {}) => {
        state.calls.push(`${init.method || 'GET'} ${new URL(url).pathname}`);
        const status = state.revoked ? 401 : 200;
        return new Response(JSON.stringify(state.revoked ? { errors: ['revoked'] } : { issue: { id: 41948 } }), { status });
    };
    const redmineFetch = createRedmineFetch({
        fetch,
        env: { REDMINE_RETRY_MAX_ATTEMPTS: '3', REDMINE_RETRY_BASE_DELAY_MS: '0', REDMINE_MIN_INTERVAL_MS: '0' },
        log: m => state.logs.push(m),
        sleep: async () => {},
    });
    return { state, redmineFetch };
}

test('Redmine: chave revogada entre o GET e o PUT da nota => 401 explícito, um PUT só, sem retry', async () => {
    const { state, redmineFetch } = fakeRedmine();
    const ok = await redmineFetch('http://redmine.invalid/issues/41948.json');
    assert.strictEqual(ok.status, 200);
    state.revoked = true;
    const put = await redmineFetch('http://redmine.invalid/issues/41948.json', { method: 'PUT', body: JSON.stringify({ issue: { notes: 'x', status_id: 20 } }) });
    assert.strictEqual(put.ok, false);
    assert.strictEqual(put.status, 401);
    assert.deepStrictEqual(state.calls, ['GET /issues/41948.json', 'PUT /issues/41948.json']);
    assert.ok(state.logs.some(l => /PUT \/issues\/41948\.json: HTTP 401 — erro de autenticação, sem retry/.test(l)));
});

test('Redmine: depois da revogação, GET idempotente também volta 401 na primeira tentativa (sem retry)', async () => {
    const { state, redmineFetch } = fakeRedmine();
    state.revoked = true;
    const r = await redmineFetch('http://redmine.invalid/issues/41948.json');
    assert.strictEqual(r.status, 401);
    assert.strictEqual(state.calls.length, 1);
});
