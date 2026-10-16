// node --test scripts/lib/dom06-dispatch-env.test.js
// PRI-94: prova end-to-end de que o nó commit despachado pelo watcher recebe
// DOM06_ATTEMPT_FILE e DOM06_AUTHORIZE_BIN nos modos follow e detached, que
// admissão DENIED/UNKNOWN não chega a invocar o agente e que os efeitos do /commit
// (push, PR, Redmine) rodam sob a autoridade desse Attempt.
// Cada despacho roda o watcher desta revisão (PRISMA_ROOT) num processo próprio,
// porque --follow é lido quando o módulo carrega. REPO_PATH é um consumidor
// sintético no tmp, e o `claude` do PATH é um stub que grava só presença, caminho e
// legibilidade de DOM06_ATTEMPT_FILE e presença de DOM06_AUTHORIZE_BIN. Só
// transportes locais: remote git bare no tmp, Bitbucket e Redmine falsos em
// loopback, token e chave falsos.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { execFile, execFileSync } = require('child_process');

const PRISMA_ROOT = path.resolve(__dirname, '..', '..');
const WATCHER = path.join(PRISMA_ROOT, 'scripts', 'readmine-watcher.js');
const dom06 = require('./dom06-attempt');

const tmp = fs.mkdtempSync(path.join(process.env.CLAUDE_JOB_DIR ? path.join(process.env.CLAUDE_JOB_DIR, 'tmp') : os.tmpdir(), 'dom06-dispatch-env-'));
const repo = path.join(tmp, 'app-back');
const binDir = path.join(tmp, 'bin');
const captures = path.join(tmp, 'captures');
const results = path.join(tmp, 'results');
const driver = path.join(tmp, 'driver.js');
for (const d of [repo, binDir, captures, results]) fs.mkdirSync(d, { recursive: true });

// Despacho de um ticket pelo watcher real. Fetch do watcher stubado (como em
// node-lease.test.js): os únicos requests de rede saem dos scripts de efeito.
fs.writeFileSync(driver, `
const fs = require('fs');
const [watcherPath, id, resultFile] = process.argv.slice(2).filter(a => a !== '--follow');
global.fetch = async () => ({ ok: true, status: 204, json: async () => ({}), text: async () => '' });
const watcher = require(watcherPath);
const ticket = {
    id: Number(id), subject: 'Ticket ' + id, description: '', status: { name: 'Em Desenvolvimento' },
    tracker: { name: 'Melhoria' }, custom_fields: [{ name: 'Branch Liberação', value: 'Dev - Local' }],
    updated_on: new Date().toISOString(),
};
watcher.dispatchTicket(ticket).then(
    r => { fs.writeFileSync(resultFile, JSON.stringify(r)); process.exit(0); },
    e => { fs.writeFileSync(resultFile, JSON.stringify({ error: e.message })); process.exit(1); },
);
`);

// Stub do agente. Grava a captura antes de tudo. Com PRI94_FLOW, segue os passos
// de efeito do commit.md com o ambiente herdado do despacho: o mesmo push duas
// vezes (com um commit novo no meio), o mesmo PR duas vezes e cada efeito Redmine
// duas vezes.
fs.writeFileSync(path.join(binDir, 'claude'), `#!${process.execPath}
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const file = process.env.DOM06_ATTEMPT_FILE;
let readable = false;
try { fs.accessSync(file, fs.constants.R_OK); readable = fs.statSync(file).isFile(); } catch {}
fs.writeFileSync(path.join(${JSON.stringify(captures)}, (process.env.PRI94_SCENARIO || 'sem-cenario') + '.json'), JSON.stringify({
    attempt_file_present: typeof file === 'string' && file !== '',
    attempt_file_path: file || null,
    attempt_file_readable: readable,
    authorize_bin_present: typeof process.env.DOM06_AUTHORIZE_BIN === 'string' && process.env.DOM06_AUTHORIZE_BIN !== '',
}));
const flow = process.env.PRI94_FLOW;
if (!flow) process.exit(0);
const root = process.env.PRISMA_ROOT;
const id = process.env.PRI94_TICKET;
const run = (cmd, args, input = '') => spawnSync(cmd, args, { input, stdio: ['pipe', 'inherit', 'inherit'] });
const push = () => run(root + '/scripts/git-push-effect.sh', ['push', '-u', 'origin', id]);
const pr = () => run(root + '/scripts/bitbucket-open-pr.sh', [process.env.PRI94_BB_REPO, id, 'development', 'Melhoria #' + id + ' - Ticket ' + id], 'descrição');
const redmine = (obligation, body) => run(process.execPath, [root + '/scripts/lib/dom06-attempt.js', 'redmine-effect',
    '--attempt', process.env.DOM06_ATTEMPT_FILE, '--obligation', obligation,
    '--url', process.env.REDMINE_URL + '/issues/' + id + '.json', '--method', 'PUT'], body);
push();
run('git', ['commit', '-q', '--allow-empty', '-m', 'depois do primeiro push']);
push();
pr();
pr();
for (const [obligation, body] of [['redmine_status', '{"issue":{"status_id":20}}'], ['redmine_notes', '{"issue":{"notes":"apontamentos"}}']]) {
    redmine(obligation, body);
    redmine(obligation, body);
}
`, { mode: 0o755 });
fs.writeFileSync(path.join(binDir, 'osascript'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });

// Bitbucket (/2.0) e Redmine (/redmine) falsos. O repo REVOKED_REPO responde 401 a
// tudo, como credencial revogada no meio do ciclo.
const WS = 'ws';
const REVOKED_REPO = 'app-back-revogado';
const REDMINE_KEY = 'chave-falsa-pri94';
const calls = [];
const prs = [];
const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
        const u = new URL(req.url, 'http://x');
        calls.push({ method: req.method, path: u.pathname, body });
        const send = (status, obj) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
        // Redmine real: sem X-Redmine-API-Key (ou com chave errada) responde 401.
        if (u.pathname.startsWith('/redmine/') && req.headers['x-redmine-api-key'] !== REDMINE_KEY) return send(401, {});
        if (u.pathname.startsWith('/redmine/issues/') && req.method === 'PUT') return send(200, {});
        const m = u.pathname.match(/^\/2\.0\/repositories\/([^/]+)\/([^/]+)\/(.+)$/);
        if (!m || m[1] !== WS) return send(404, {});
        const [, , slug, rest] = m;
        if (slug === REVOKED_REPO) return send(401, { type: 'error', error: { message: 'Token is invalid, expired, or not supported for this endpoint.' } });
        if (rest === 'effective-default-reviewers') return send(200, { values: [] });
        if (rest === 'pullrequests' && req.method === 'GET') {
            const q = u.searchParams.get('q') || '';
            const values = prs.filter(pr => pr.slug === slug && q.includes(`source.branch.name="${pr.source}"`) && q.includes('state="OPEN"'))
                .map(pr => ({ id: pr.id, state: 'OPEN', source: { branch: { name: pr.source } }, destination: { branch: { name: pr.destination } },
                    links: { html: { href: `https://bitbucket.invalid/${WS}/${slug}/pull-requests/${pr.id}` } } }));
            return send(200, { values });
        }
        if (rest === 'pullrequests' && req.method === 'POST') {
            const payload = JSON.parse(body);
            const id = prs.length + 1;
            prs.push({ id, slug, source: payload.source.branch.name, destination: payload.destination.branch.name });
            return send(201, { id, links: { html: { href: `https://bitbucket.invalid/${WS}/${slug}/pull-requests/${id}` } }, reviewers: [] });
        }
        send(404, {});
    });
});
const origin = () => `http://127.0.0.1:${server.address().port}`;

const GIT_ENV = {
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_AUTHOR_NAME: 'pri94', GIT_AUTHOR_EMAIL: 'pri94@example.invalid',
    GIT_COMMITTER_NAME: 'pri94', GIT_COMMITTER_EMAIL: 'pri94@example.invalid',
};
const git = (cwd, ...args) => execFileSync('git', args, { cwd, env: { PATH: process.env.PATH, ...GIT_ENV }, encoding: 'utf8' }).trim();

// Run do ticket no worktree sintético. O worktree é um repo git com origin num bare
// local, e o primeiro commit já existe (o /commit real chega com o commit feito).
function seed(id, { hold = null } = {}) {
    const taskId = `${id}-teste`;
    const worktree = path.join(repo, '.claude', 'worktrees', String(id));
    const dir = path.join(worktree, 'memory', 'runs', taskId);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({
        task_id: taskId, node: 'commit', history: ['fetch_ticket', 'plan', 'implement', 'review', 'test', 'verify'],
        status: 'in_progress', started_at: new Date().toISOString(), retries: {},
    }));
    fs.writeFileSync(path.join(dir, 'context.md'), '# Contexto\n');
    if (hold) {
        fs.mkdirSync(path.join(dir, 'dom06'), { recursive: true });
        fs.writeFileSync(path.join(dir, 'dom06', 'hold.json'), JSON.stringify(hold));
    }
    const remote = path.join(tmp, 'remotes', `${id}.git`);
    fs.mkdirSync(remote, { recursive: true });
    git(remote, 'init', '-q', '--bare');
    git(worktree, 'init', '-q', '-b', String(id));
    git(worktree, 'remote', 'add', 'origin', remote);
    git(worktree, 'commit', '-q', '--allow-empty', '-m', `Melhoria #${id}`);
    return { taskId, dir, worktree, remote };
}

const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const attempts = dir => dom06.listAttempts(dir);
const captureOf = scenario => {
    const file = path.join(captures, `${scenario}.json`);
    return fs.existsSync(file) ? readJson(file) : null;
};
const remoteHead = (remote, id) => {
    try { return git(remote, 'rev-parse', `refs/heads/${id}`); } catch { return null; }
};

async function waitFor(fn, tries = 300) {
    for (let i = 0; i < tries; i++) {
        if (fn()) return true;
        await new Promise(r => setTimeout(r, 100));
    }
    return false;
}

function dispatch(id, { scenario, follow, flow = null, bbRepo = 'app-back' }) {
    const resultFile = path.join(results, `${scenario}.json`);
    const env = {
        PATH: `${binDir}:${process.env.PATH}`,
        ...(process.env.TMPDIR ? { TMPDIR: process.env.TMPDIR } : {}),
        ...(process.env.LANG ? { LANG: process.env.LANG } : {}),
        ...GIT_ENV,
        REPO_PATH: repo,
        // Portões fora do escopo, como em node-lease.test.js.
        PLAN_SCORE_THRESHOLD: '0',
        SKIP_PRE_BUILD_VALIDATION: 'true',
        REDMINE_URL: `${origin()}/redmine`,
        REDMINE_API_KEY: REDMINE_KEY,
        REDMINE_RETRY_MAX_ATTEMPTS: '1',
        REDMINE_MIN_INTERVAL_MS: '0',
        BITBUCKET_WORKSPACE: WS,
        BITBUCKET_API_TOKEN: 'token-falso-pri94',
        BITBUCKET_API_BASE: `${origin()}/2.0`,
        BITBUCKET_ACCOUNT_ID: 'acc-pri94',
        PRI94_SCENARIO: scenario,
        PRI94_TICKET: String(id),
        PRI94_BB_REPO: bbRepo,
        ...(flow ? { PRI94_FLOW: flow } : {}),
    };
    const args = [driver, WATCHER, String(id), resultFile, ...(follow ? ['--follow'] : [])];
    return new Promise(resolve => {
        execFile(process.execPath, args, { cwd: repo, env, timeout: 120000 }, (err, stdout, stderr) => {
            const result = fs.existsSync(resultFile) ? readJson(resultFile) : null;
            resolve({ code: err ? err.code : 0, result, output: `${stdout}\n${stderr}` });
        });
    });
}

const sanitize = value => JSON.parse(JSON.stringify(value).split(tmp).join('<tmp>'));

function assertAdmittedCapture(t, scenario, dir) {
    const capture = captureOf(scenario);
    assert.ok(capture, `${scenario}: o stub do claude não foi invocado`);
    t.diagnostic(`captura ${scenario}: ${JSON.stringify(sanitize(capture))}`);
    const [attempt] = attempts(dir);
    assert.strictEqual(attempts(dir).length, 1);
    assert.strictEqual(attempt.node, 'commit');
    assert.strictEqual(attempt.started, true);
    assert.deepStrictEqual(capture, {
        attempt_file_present: true,
        attempt_file_path: path.join(dir, 'dom06', 'attempts', `${attempt.attempt_id}.json`),
        attempt_file_readable: true,
        authorize_bin_present: true,
    });
    assert.ok(capture.attempt_file_path.startsWith(repo + path.sep), 'Attempt mora no consumidor sintético (REPO_PATH)');
}

// Efeitos de um Attempt admitido: um push só (o commit feito depois do primeiro
// push não chega ao remote), um POST de PR e um PUT por obrigação do Redmine.
function assertEffectsOnce(id, { dir, worktree, remote }, first) {
    assert.strictEqual(remoteHead(remote, id), first, 'o remote ficou no commit do primeiro push');
    assert.notStrictEqual(git(worktree, 'rev-parse', 'HEAD'), first, 'o segundo push tinha um commit novo para levar');
    const posts = calls.filter(c => c.method === 'POST' && c.path === `/2.0/repositories/${WS}/app-back/pullrequests`
        && JSON.parse(c.body).source.branch.name === String(id));
    assert.strictEqual(posts.length, 1);
    const puts = calls.filter(c => c.method === 'PUT' && c.path === `/redmine/issues/${id}.json`).map(c => c.body);
    assert.deepStrictEqual(puts, ['{"issue":{"status_id":20}}', '{"issue":{"notes":"apontamentos"}}']);
    const summary = dom06.summarize(attempts(dir)[0]);
    assert.deepStrictEqual(summary.obligations.map(o => [o.id, o.status]), [
        ['push', 'fulfilled'], ['pull_request', 'fulfilled'], ['redmine_status', 'fulfilled'], ['redmine_notes', 'fulfilled'],
    ]);
    assert.strictEqual(summary.verdict, 'PASS');
}

test.before(() => new Promise(r => server.listen(0, '127.0.0.1', r)));
test.after(() => { server.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

test('AC3+AC5 follow: commit admitido recebe as duas variáveis; push, PR e Redmine uma vez só', async t => {
    const id = 94101;
    const run = seed(id);
    const first = git(run.worktree, 'rev-parse', 'HEAD');
    const r = await dispatch(id, { scenario: 'follow-admitido', follow: true, flow: 'commit' });
    assert.strictEqual(r.result?.action, 'dispatched', r.output);
    assertAdmittedCapture(t, 'follow-admitido', run.dir);
    assertEffectsOnce(id, run, first);
});

test('AC3+AC5 detached: commit admitido recebe as duas variáveis; push, PR e Redmine uma vez só', async t => {
    const id = 94102;
    const run = seed(id);
    const first = git(run.worktree, 'rev-parse', 'HEAD');
    const r = await dispatch(id, { scenario: 'detached-admitido', follow: false, flow: 'commit' });
    assert.strictEqual(r.result?.action, 'dispatched', r.output);
    // O watcher solta o agente: o fim é o release do wrapper sh (status sai de running).
    const done = await waitFor(() => readJson(path.join(run.dir, 'state.json')).status !== 'running');
    const log = path.join(repo, 'memory', 'runs', `${id}.log`);
    assert.ok(done, `o agente detached não terminou: ${fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : 'sem log'}`);
    assertAdmittedCapture(t, 'detached-admitido', run.dir);
    assertEffectsOnce(id, run, first);
});

test('AC5: 401 do Bitbucket revoga o Attempt; o PR repetido e o Redmine não chegam a fazer request', async t => {
    const id = 94103;
    const run = seed(id);
    const first = git(run.worktree, 'rev-parse', 'HEAD');
    const r = await dispatch(id, { scenario: 'follow-revogado', follow: true, flow: 'commit', bbRepo: REVOKED_REPO });
    assert.strictEqual(r.result?.action, 'dispatched', r.output);
    assertAdmittedCapture(t, 'follow-revogado', run.dir);
    assert.strictEqual(remoteHead(run.remote, id), first, 'só o primeiro push, anterior à revogação, chegou ao remote');
    const bb = calls.filter(c => c.path.startsWith(`/2.0/repositories/${WS}/${REVOKED_REPO}/`));
    assert.deepStrictEqual(bb.map(c => `${c.method} ${c.path}`), [`GET /2.0/repositories/${WS}/${REVOKED_REPO}/effective-default-reviewers`]);
    assert.deepStrictEqual(calls.filter(c => c.path === `/redmine/issues/${id}.json`), []);
    const attempt = attempts(run.dir)[0];
    assert.strictEqual(attempt.authority, 'revoked');
    assert.strictEqual(attempt.revoke_reason, 'http_401');
    assert.notStrictEqual(dom06.summarize(attempt).verdict, 'PASS');
});

for (const follow of [true, false]) {
    for (const status of ['DENIED', 'UNKNOWN']) {
        const mode = follow ? 'follow' : 'detached';
        test(`AC4 ${mode}: admissão ${status} não invoca o stub e não despacha`, async () => {
            const id = 94200 + (follow ? 0 : 10) + (status === 'DENIED' ? 1 : 2);
            const scenario = `${mode}-${status.toLowerCase()}`;
            const run = seed(id, { hold: { status } });
            const r = await dispatch(id, { scenario, follow, flow: 'commit' });
            assert.deepStrictEqual(
                [r.result?.action, r.result?.reason, r.result?.admission],
                ['skip', `dom06_${status.toLowerCase()}`, status], r.output);
            assert.strictEqual(captureOf(scenario), null, 'o stub do claude não pode ter rodado');
            const all = attempts(run.dir);
            assert.deepStrictEqual(all.map(a => [a.node, a.started, a.result]), [['commit', false, status]]);
            assert.strictEqual(readJson(path.join(run.dir, 'state.json')).status, 'in_progress');
            assert.strictEqual(remoteHead(run.remote, id), null);
            assert.deepStrictEqual(calls.filter(c => c.path.includes(`/${id}`) || c.body.includes(`"${id}"`)), []);
        });
    }
}

test('o stub só rodou nos despachos admitidos', () => {
    assert.deepStrictEqual(fs.readdirSync(captures).sort(), ['detached-admitido.json', 'follow-admitido.json', 'follow-revogado.json']);
});
