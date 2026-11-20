// node --test prs-api.test.js
// GET /api/prs, GET /api/prs/:id, POST /api/prs/:id/approve contra um Bitbucket
// falso (mesmo padrão de pr-ready-api.test.js: http.createServer local +
// bitbucketApi apontando pra ele).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { createDashboard } = require('./server');

const TOKEN = 'ATBB-token-fake-de-teste-prs';
const WORKSPACE = 'ws';
const REPO = 'app-back';
const ME_ACCOUNT_ID = 'acc-eu-mesmo-123';
const FRONT = 'app-front';
// Repo irmão consultado junto com o primário; 'repo-sem-acesso' devolve 404
// no Bitbucket falso e tem que virar warning, não erro da aba inteira.
const configuredEnv = {
    BITBUCKET_WORKSPACE: WORKSPACE,
    BITBUCKET_REPO_SLUG: REPO,
    BITBUCKET_API_TOKEN: TOKEN,
    BITBUCKET_PR_REPOS: `${FRONT},repo-sem-acesso`,
    REDMINE_URL: 'https://redmine.example.com/',
};

const tmpBase = process.env.CLAUDE_JOB_DIR ? path.join(process.env.CLAUDE_JOB_DIR, 'tmp') : os.tmpdir();
const tmp = fs.mkdtempSync(path.join(tmpBase, 'prs-api-'));
const runs = path.join(tmp, 'memory', 'runs');

function writeRun(taskId, state) {
    fs.mkdirSync(path.join(runs, taskId), { recursive: true });
    fs.writeFileSync(path.join(runs, taskId, 'state.json'), JSON.stringify({ task_id: taskId, node: 'commit', history: [], status: 'committed', ...state }, null, 2));
}

// PR "6001-teste-prs" já existe em disco ANTES do dashboard subir: o índice
// PR->run (buildPrRunIndex) lê runsCache, que só é populado via cacheRoot()
// síncrono na criação do dashboard (ou via evento 'addDir' assíncrono do
// chokidar depois) — escrever antes evita depender de timing do watcher.
writeRun('6001-teste-prs', {
    pull_request: { 'app-back': { url: 'https://bitbucket.org/ws/app-back/pull-requests/501', id: 501 } },
});

// Lado de PR da antiga "Tickets e PRs" (PRI-326): PRs gravados nos runs que não vêm na lista
// do Bitbucket entram em /api/prs com o estado do state.json. MERGED do run é histórico: fica fora.
writeRun('6002-teste-superseded', {
    pull_request: {
        'app-back': { url: 'https://bitbucket.org/ws/app-back/pull-requests/601', id: 601, state: 'SUPERSEDED', last_checked_at: '2026-09-22T10:00:00.000Z' },
        'app-front': { url: 'https://bitbucket.org/ws/app-front/pull-requests/602', id: 602 },
    },
});
writeRun('6003-teste-merged-historico', {
    pull_request: { 'app-back': { url: 'https://bitbucket.org/ws/app-back/pull-requests/603', id: 603, state: 'MERGED' } },
});

const prBy = new Map(); // id -> raw PR (formato Bitbucket) usado no GET de detalhe/approve
const openList = [];
const mergedList = [];
const seen = [];

function rawPr({ id, state, draft = false, reviewers = [], participants = [], authorId = ME_ACCOUNT_ID }) {
    return {
        id, title: `PR ${id}`, state, draft,
        source: { branch: { name: `feature/${id}` } },
        destination: { branch: { name: 'development' } },
        author: { display_name: 'Autor de Teste', account_id: authorId },
        reviewers, participants,
        created_on: '2026-09-20T10:00:00.000Z',
        updated_on: '2026-09-21T10:00:00.000Z',
        links: { html: { href: `https://bitbucket.org/${WORKSPACE}/${REPO}/pull-requests/${id}` } },
        comment_count: 1, task_count: 0,
    };
}

const pr501 = rawPr({
    id: 501, state: 'OPEN',
    reviewers: [{ account_id: ME_ACCOUNT_ID, uuid: '{me}', display_name: 'Eu Mesmo' }],
    participants: [{ user: { account_id: ME_ACCOUNT_ID }, approved: false }],
});
const pr502 = rawPr({ id: 502, state: 'MERGED' });
const pr503Outro = rawPr({ id: 503, state: 'OPEN', authorId: 'acc-outra-pessoa' });
const front501 = { ...rawPr({ id: 501, state: 'OPEN' }), title: 'PR front 501' };
prBy.set(501, pr501);
prBy.set(502, pr502);
openList.push(pr501, pr503Outro);
mergedList.push(pr502);

const bb = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
        seen.push({ method: req.method, url: req.url, auth: req.headers.authorization });
        const u = new URL(req.url, 'http://x');
        const p = u.pathname;

        if (p === '/2.0/user' && req.method === 'GET') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ account_id: ME_ACCOUNT_ID, uuid: '{me}', display_name: 'Eu Mesmo' }));
        }
        let lm = p.match(new RegExp(`^/2\\.0/repositories/${WORKSPACE}/(${REPO}|${FRONT})/pullrequests$`));
        if (lm && req.method === 'GET') {
            // Igual ao Bitbucket de verdade: com `q`, o state vem dentro dele.
            const q = u.searchParams.get('q') || '';
            const state = (q.match(/state="(\w+)"/) || [])[1] || u.searchParams.get('state');
            const author = (q.match(/author\.account_id="([^"]+)"/) || [])[1];
            const pool = lm[1] === FRONT ? [front501] : [...openList, ...mergedList];
            const values = pool.filter(pr => pr.state === state && (!author || pr.author.account_id === author));
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ values }));
        }
        let m = p.match(new RegExp(`^/2\\.0/repositories/${WORKSPACE}/${REPO}/pullrequests/(\\d+)/approve$`));
        if (m && req.method === 'POST') {
            // Delay de propósito: dá tempo da segunda chamada concorrente chegar
            // enquanto a primeira ainda está "em voo" (mesmo padrão do PUT em
            // pr-ready-api.test.js).
            return setTimeout(() => {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end('{}');
            }, 150);
        }
        m = p.match(new RegExp(`^/2\\.0/repositories/${WORKSPACE}/${REPO}/pullrequests/(\\d+)/diffstat$`));
        if (m && req.method === 'GET') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ values: [], next: null }));
        }
        m = p.match(new RegExp(`^/2\\.0/repositories/${WORKSPACE}/${REPO}/pullrequests/(\\d+)$`));
        if (m && req.method === 'GET') {
            const pr = prBy.get(Number(m[1]));
            if (!pr) { res.writeHead(404); return res.end('{}'); }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify(pr));
        }
        res.writeHead(404);
        res.end('{}');
    });
});

let dash, base;
async function startDashboard(env = configuredEnv) {
    if (dash) await dash.close();
    dash = createDashboard({
        env,
        memoryDir: runs,
        worktreesDir: path.join(tmp, 'wt'),
        prefsFile: path.join(tmp, 'prefs.json'),
        bitbucketApi: `http://127.0.0.1:${bb.address().port}/2.0`,
        // Sem git de verdade: o detector real é testado em scripts/lib/pr-conflicts.test.js.
        prConflictDetector: { detect: async pr => (pr.id === 501 && pr.repo === REPO ? { hasConflicts: true, conflictFiles: ['src/A.java'] } : { hasConflicts: false, conflictFiles: [] }) },
    });
    await new Promise(r => dash.server.listen(0, '127.0.0.1', r));
    base = `http://localhost:${dash.server.address().port}`;
    await dash.ready;
}
test.before(async () => {
    await new Promise(r => bb.listen(0, '127.0.0.1', r));
    await startDashboard();
});
test.after(async () => {
    await dash.close();
    await new Promise(r => bb.close(r));
    fs.rmSync(tmp, { recursive: true, force: true });
});

const get = async p => {
    const res = await fetch(base + p);
    const text = await res.text();
    return { status: res.status, text, body: JSON.parse(text) };
};
const post = async (p, body) => {
    const res = await fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
    const text = await res.text();
    return { status: res.status, text, body: JSON.parse(text) };
};

test('GET /api/prs sem BITBUCKET_API_TOKEN/WORKSPACE/REPO_SLUG configurado -> 503', async () => {
    await startDashboard({});
    try {
        const r = await get('/api/prs');
        assert.strictEqual(r.status, 503, r.text);
        assert.ok(typeof r.body.error === 'string' && r.body.error.length > 0);
        assert.ok(!r.text.includes(TOKEN));
    } finally {
        await startDashboard();
    }
});

test('GET /api/prs: shape (prs, linkedRuns, currentUser) e linkedRun do PR com run correspondente', async () => {
    const r = await get('/api/prs');
    assert.strictEqual(r.status, 200, r.text);
    assert.ok(Array.isArray(r.body.prs));
    assert.strictEqual(r.body.prs.filter(p => p.source !== 'run').length, 3, JSON.stringify(r.body.prs));
    assert.ok(r.body.linkedRuns && typeof r.body.linkedRuns === 'object');
    assert.deepStrictEqual(r.body.currentUser, { displayName: 'Eu Mesmo' });

    const open = r.body.prs.find(p => p.id === 501 && p.repo === REPO);
    assert.ok(open, JSON.stringify(r.body.prs));
    assert.strictEqual(open.state, 'OPEN');
    assert.deepStrictEqual(open.linkedRun, {
        taskId: '6001-teste-prs',
        ticketId: 6001,
        ticketUrl: 'https://redmine.example.com/issues/6001',
    });
    assert.strictEqual(open.canApprove, true, 'dono do token é reviewer designado e ainda não aprovou');
    assert.deepStrictEqual(r.body.linkedRuns[`${REPO}#501`], open.linkedRun);

    const merged = r.body.prs.find(p => p.id === 502);
    assert.ok(merged);
    assert.strictEqual(merged.state, 'MERGED');
    assert.strictEqual(merged.linkedRun, null, 'PR sem state.json correspondente não tem linkedRun');
    assert.strictEqual(merged.canApprove, false, 'PR já MERGED não pode ser aprovado');
    assert.ok(!(`${REPO}#502` in r.body.linkedRuns));

    assert.ok(!r.text.includes(TOKEN), 'token nunca aparece na resposta');
    assert.ok(seen.every(s => !s.url.includes(TOKEN)));
    assert.ok(seen.some(s => s.auth === `Bearer ${TOKEN}`), 'token só no header Authorization');
});

test('GET /api/prs/:id com id não-numérico -> 400', async () => {
    const r = await get('/api/prs/abc');
    assert.strictEqual(r.status, 400, r.text);
    assert.ok(typeof r.body.error === 'string');
    assert.ok(!r.text.includes(TOKEN));
});

test('GET /api/prs/:id com PR inexistente no Bitbucket -> 404', async () => {
    const r = await get('/api/prs/9999');
    assert.strictEqual(r.status, 404, r.text);
    assert.ok(typeof r.body.error === 'string');
    assert.ok(!r.text.includes(TOKEN));
});

test('GET /api/prs/:id: detalhe de um PR existente inclui diffStat e linkedRun', async () => {
    const r = await get('/api/prs/501');
    assert.strictEqual(r.status, 200, r.text);
    assert.strictEqual(r.body.id, 501);
    assert.deepStrictEqual(r.body.diffStat, { filesChanged: 0, linesAdded: 0, linesRemoved: 0, files: [] });
    assert.deepStrictEqual(r.body.linkedRun, { taskId: '6001-teste-prs', ticketId: 6001, ticketUrl: 'https://redmine.example.com/issues/6001' });
    assert.ok(!r.text.includes(TOKEN));
});

test('POST /api/prs/:id/approve: sucesso -> {approved:true}', async () => {
    const r = await post('/api/prs/501/approve');
    assert.strictEqual(r.status, 200, r.text);
    assert.deepStrictEqual(r.body, { approved: true });
    assert.ok(!r.text.includes(TOKEN));
});

test('POST /api/prs/:id/approve: id não-numérico -> 400', async () => {
    const r = await post('/api/prs/abc/approve');
    assert.strictEqual(r.status, 400, r.text);
    assert.ok(!r.text.includes(TOKEN));
});

test('POST /api/prs/:id/approve: duas chamadas concorrentes -> a segunda recebe 409 (prApproveInFlight)', async () => {
    const [a, b] = await Promise.all([
        post('/api/prs/777/approve'),
        new Promise(r => setTimeout(r, 20)).then(() => post('/api/prs/777/approve')),
    ]);
    assert.strictEqual(a.status, 200, a.text);
    assert.deepStrictEqual(a.body, { approved: true });
    assert.strictEqual(b.status, 409, b.text);
    assert.ok(!a.text.includes(TOKEN) && !b.text.includes(TOKEN));

    // Depois que a primeira terminou, o guard foi liberado: uma nova chamada
    // pro mesmo id funciona de novo.
    const c = await post('/api/prs/777/approve');
    assert.strictEqual(c.status, 200, c.text);
});

test('só localhost', async () => {
    const res = await fetch(base + '/api/prs', { headers: { Origin: 'http://evil.example' } });
    assert.strictEqual(res.status, 403);
});

test('GET /api/prs: preenche hasConflicts/conflictFiles só nos PRs abertos (detector local)', async () => {
    const { status, body } = await get('/api/prs');
    assert.strictEqual(status, 200);
    const open = body.prs.find(p => p.id === 501 && p.repo === REPO);
    const merged = body.prs.find(p => p.id === 502);
    assert.strictEqual(open.hasConflicts, true);
    assert.deepStrictEqual(open.conflictFiles, ['src/A.java']);
    assert.strictEqual(merged.hasConflicts, null);
});

test('GET /api/prs: só PRs do dono do token, do repo primário e dos irmãos; repo inacessível vira warning', async () => {
    const { status, body } = await get('/api/prs');
    assert.strictEqual(status, 200);
    assert.ok(!body.prs.some(p => p.id === 503), 'PR de outra pessoa não aparece');
    const front = body.prs.find(p => p.repo === FRONT && p.id === 501);
    assert.ok(front, 'PR do repo irmão aparece, mesmo com número igual ao do primário');
    assert.strictEqual(front.hasConflicts, false);
    assert.strictEqual(front.linkedRun, null, 'vínculo ao run é por repo#id');
    assert.deepStrictEqual(body.repos, [REPO, FRONT, 'repo-sem-acesso']);
    assert.strictEqual(body.warnings.length, 1);
    assert.match(body.warnings[0], /^repo-sem-acesso:/);
});

test('GET /api/prs: BITBUCKET_ACCOUNT_ID tem precedência sobre /user', async () => {
    await startDashboard({ ...configuredEnv, BITBUCKET_ACCOUNT_ID: 'acc-outra-pessoa' });
    try {
        const { status, body } = await get('/api/prs');
        assert.strictEqual(status, 200);
        assert.deepStrictEqual(body.prs.filter(p => p.source !== 'run').map(p => p.id), [503]);
    } finally {
        await startDashboard();
    }
});

test('POST /api/prs/:id/approve: repo fora da lista configurada -> 400', async () => {
    const r = await post('/api/prs/501/approve?repo=outro-repo');
    assert.strictEqual(r.status, 400, r.text);
});

test('GET /api/prs: PR só do run (fora da lista do Bitbucket) entra com o estado do state.json; vazio = desconhecido; MERGED do run fica fora', async () => {
    const r = await get('/api/prs');
    assert.strictEqual(r.status, 200, r.text);
    const fromRuns = r.body.prs.filter(p => p.source === 'run');
    assert.deepStrictEqual(fromRuns.map(p => `${p.repo}#${p.id}`).sort(), ['app-back#601', 'app-front#602']);
    const sup = fromRuns.find(p => p.id === 601);
    assert.strictEqual(sup.state, 'SUPERSEDED');
    assert.strictEqual(sup.stateCheckedAt, '2026-09-22T10:00:00.000Z');
    assert.strictEqual(sup.canApprove, false, 'PR só do run nunca oferece aprovação');
    assert.strictEqual(sup.reviewers, null, 'revisores não consultados: null, nunca lista vazia');
    assert.strictEqual(sup.hasConflicts, null);
    assert.deepStrictEqual(sup.linkedRun, { taskId: '6002-teste-superseded', ticketId: 6002, ticketUrl: 'https://redmine.example.com/issues/6002' });
    const unk = fromRuns.find(p => p.id === 602);
    assert.strictEqual(unk.state, null, 'sem estado no state.json: desconhecido');
    assert.ok(!r.body.prs.some(p => p.id === 603), 'MERGED registrado só no run é histórico');
    assert.ok(!r.body.prs.some(p => p.source === 'run' && p.id === 501 && p.repo === REPO), 'PR que já veio do Bitbucket não duplica');
    assert.ok(`app-back#601` in r.body.linkedRuns);
});
