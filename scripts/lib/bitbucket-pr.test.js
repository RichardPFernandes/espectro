// node --test scripts/lib/bitbucket-pr.test.js
// getCurrentUser/listPRs/getPRDetail/approvePR isolados (sem subir o dashboard),
// contra um Bitbucket falso simples (http.createServer). Mesmo estilo do teste
// de getPRStatus em scripts/lib/pr-status-poll.test.js.
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');

const { getCurrentUser, listPRs, getPRDetail, approvePR } = require('./bitbucket-pr');

const TOKEN = 'ATBB-token-fake-unitario';
const WORKSPACE = 'mosistemas';
const REPO = 'app-back';

// Sobe um Bitbucket falso e devolve { apiBase, seen, close }. `routes` é uma lista
// de { method, path (RegExp), handler(req, res, match) }.
async function fakeBitbucket(routes) {
    const seen = [];
    const srv = http.createServer((req, res) => {
        let body = '';
        req.on('data', c => { body += c; });
        req.on('end', () => {
            seen.push({ method: req.method, url: req.url, auth: req.headers.authorization, body });
            const u = new URL(req.url, 'http://x');
            for (const r of routes) {
                if (r.method !== req.method) continue;
                const m = u.pathname.match(r.path);
                if (!m) continue;
                return r.handler(req, res, m, u);
            }
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end('{}');
        });
    });
    await new Promise(resolve => srv.listen(0, '127.0.0.1', resolve));
    const apiBase = `http://127.0.0.1:${srv.address().port}/2.0`;
    return { apiBase, seen, close: () => new Promise(r => srv.close(r)) };
}

function json(res, status, body) {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
}

// Captura console.log/console.error durante uma chamada, pra garantir que nenhum
// dos métodos deste módulo loga nada (e, se logasse, que não vazaria o token).
async function captureConsole(fn) {
    const lines = [];
    const origLog = console.log, origErr = console.error;
    console.log = (...a) => lines.push(a.join(' '));
    console.error = (...a) => lines.push(a.join(' '));
    try {
        await fn();
    } finally {
        console.log = origLog;
        console.error = origErr;
    }
    return lines;
}

test('getCurrentUser: Bearer no header, devolve accountId/uuid/displayName normalizados', async () => {
    const bb = await fakeBitbucket([
        { method: 'GET', path: /^\/2\.0\/user$/, handler: (req, res) => json(res, 200, { account_id: 'acc-1', uuid: '{u}', display_name: 'Fulano' }) },
    ]);
    try {
        let u;
        const lines = await captureConsole(async () => {
            u = await getCurrentUser({ token: TOKEN, apiBase: bb.apiBase });
        });
        assert.deepStrictEqual(u, { accountId: 'acc-1', uuid: '{u}', displayName: 'Fulano' });
        assert.ok(bb.seen.every(s => s.auth === `Bearer ${TOKEN}` && !s.url.includes(TOKEN)));
        assert.strictEqual(lines.length, 0, 'getCurrentUser não loga nada');
    } finally {
        await bb.close();
    }
});

test('getCurrentUser: fallback pra nickname quando display_name ausente', async () => {
    const bb = await fakeBitbucket([
        { method: 'GET', path: /^\/2\.0\/user$/, handler: (req, res) => json(res, 200, { account_id: 'acc-2', uuid: '{u2}', nickname: 'fulaninho' }) },
    ]);
    try {
        const u = await getCurrentUser({ token: TOKEN, apiBase: bb.apiBase });
        assert.strictEqual(u.displayName, 'fulaninho');
    } finally {
        await bb.close();
    }
});

test('listPRs: monta a URL com state/pagelen e normaliza cada PR (reviewers x participants, draft, hasConflicts null)', async () => {
    const bb = await fakeBitbucket([
        {
            method: 'GET', path: new RegExp(`^/2\\.0/repositories/${WORKSPACE}/${REPO}/pullrequests$`),
            handler: (req, res, m, u) => {
                assert.strictEqual(u.searchParams.get('state'), 'OPEN');
                assert.strictEqual(u.searchParams.get('pagelen'), '7');
                json(res, 200, {
                    values: [{
                        id: 10, title: 'Ajuste X', state: 'OPEN', draft: true,
                        source: { branch: { name: 'feature/10' } },
                        destination: { branch: { name: 'development' } },
                        author: { display_name: 'Autora' },
                        reviewers: [
                            { account_id: 'rev-1', uuid: '{r1}', display_name: 'Revisor Um' },
                            { account_id: 'rev-2', uuid: '{r2}', nickname: 'revisor2' },
                        ],
                        participants: [{ user: { account_id: 'rev-1' }, approved: true }, { user: { account_id: 'rev-2' }, approved: false, state: 'changes_requested' }],
                        created_on: '2026-09-01T00:00:00.000Z',
                        updated_on: '2026-09-02T00:00:00.000Z',
                        links: { html: { href: 'https://bitbucket.org/ws/app-back/pull-requests/10' } },
                        comment_count: 3, task_count: 1,
                    }],
                });
            },
        },
    ]);
    try {
        const list = await listPRs({ workspace: WORKSPACE, repo: REPO, token: TOKEN, state: 'OPEN', limit: 7, apiBase: bb.apiBase });
        assert.strictEqual(list.length, 1);
        assert.deepStrictEqual(list[0], {
            id: 10, repo: REPO, title: 'Ajuste X',
            sourceBranch: 'feature/10', targetBranch: 'development',
            sourceCommit: null, targetCommit: null,
            state: 'OPEN', draft: true, author: 'Autora', authorAccountId: null,
            reviewers: [
                { accountId: 'rev-1', uuid: '{r1}', displayName: 'Revisor Um', approved: true, changesRequested: false },
                { accountId: 'rev-2', uuid: '{r2}', displayName: 'revisor2', approved: false, changesRequested: true },
            ],
            createdOn: '2026-09-01T00:00:00.000Z', updatedOn: '2026-09-02T00:00:00.000Z',
            url: 'https://bitbucket.org/ws/app-back/pull-requests/10',
            hasConflicts: null, commentCount: 3, taskCount: 1,
        });
        assert.ok(bb.seen.every(s => !s.url.includes(TOKEN)));
    } finally {
        await bb.close();
    }
});

test('listPRs: valores default (sem raw.participants/reviewers/comment_count) não quebram', async () => {
    const bb = await fakeBitbucket([
        {
            method: 'GET', path: new RegExp(`^/2\\.0/repositories/${WORKSPACE}/${REPO}/pullrequests$`),
            handler: (req, res) => json(res, 200, { values: [{ id: 11, state: 'MERGED' }] }),
        },
    ]);
    try {
        const list = await listPRs({ workspace: WORKSPACE, repo: REPO, token: TOKEN, apiBase: bb.apiBase });
        assert.strictEqual(list[0].reviewers.length, 0);
        assert.strictEqual(list[0].draft, false);
        assert.strictEqual(list[0].commentCount, null);
        assert.strictEqual(list[0].taskCount, null);
        assert.strictEqual(list[0].url, null);
    } finally {
        await bb.close();
    }
});

test('getPRDetail: segue o diffstat paginado (campo next) até esgotar, agrega filesChanged/linesAdded/linesRemoved', async () => {
    const prId = 42;
    let diffstatCalls = 0;
    const bb = await fakeBitbucket([
        {
            method: 'GET', path: new RegExp(`^/2\\.0/repositories/${WORKSPACE}/${REPO}/pullrequests/${prId}$`),
            handler: (req, res) => json(res, 200, {
                id: prId, title: 'PR grande', state: 'OPEN', draft: false,
                links: { html: { href: `https://bitbucket.org/ws/app-back/pull-requests/${prId}` } },
            }),
        },
        {
            method: 'GET', path: new RegExp(`^/2\\.0/repositories/${WORKSPACE}/${REPO}/pullrequests/${prId}/diffstat$`),
            handler: (req, res, m, u) => {
                diffstatCalls++;
                const page = u.searchParams.get('page');
                if (!page) {
                    // Página 1: `next` é a URL completa da página 2 (formato real do Bitbucket).
                    // Como a porta só é conhecida depois do listen(), referencia via getter.
                    return json(res, 200, {
                        values: [
                            { lines_added: 10, lines_removed: 2, status: 'modified', new: { path: 'src/A.java' }, old: { path: 'src/A.java' } },
                            { lines_added: 5, lines_removed: 0, status: 'added', new: { path: 'src/B.java' }, old: null },
                        ],
                        next: `http://127.0.0.1:${req.socket.localPort}/2.0/repositories/${WORKSPACE}/${REPO}/pullrequests/${prId}/diffstat?pagelen=100&page=2`,
                    });
                }
                // Última página: sem `next` -> encerra o loop.
                return json(res, 200, { values: [{ lines_added: 1, lines_removed: 1, status: 'removed', new: null, old: { path: 'src/C.java' } }], next: null });
            },
        },
    ]);
    try {
        const detail = await getPRDetail({ workspace: WORKSPACE, repo: REPO, prId, token: TOKEN, apiBase: bb.apiBase });
        assert.strictEqual(diffstatCalls, 2, 'segue o `next` até a página sem next');
        assert.deepStrictEqual(detail.diffStat, {
            filesChanged: 3, linesAdded: 16, linesRemoved: 3,
            files: [
                { path: 'src/A.java', added: 10, removed: 2, status: 'modified' },
                { path: 'src/B.java', added: 5, removed: 0, status: 'added' },
                { path: 'src/C.java', added: 1, removed: 1, status: 'removed' },
            ],
        });
        assert.strictEqual(detail.id, prId);
        assert.ok(bb.seen.every(s => !s.url.includes(TOKEN)));
    } finally {
        await bb.close();
    }
});

test('getPRDetail: diffstat de página única (sem next) não entra em loop', async () => {
    const prId = 43;
    let diffstatCalls = 0;
    const bb = await fakeBitbucket([
        {
            method: 'GET', path: new RegExp(`^/2\\.0/repositories/${WORKSPACE}/${REPO}/pullrequests/${prId}$`),
            handler: (req, res) => json(res, 200, { id: prId, state: 'OPEN' }),
        },
        {
            method: 'GET', path: new RegExp(`^/2\\.0/repositories/${WORKSPACE}/${REPO}/pullrequests/${prId}/diffstat$`),
            handler: (req, res) => { diffstatCalls++; json(res, 200, { values: [], next: null }); },
        },
    ]);
    try {
        const detail = await getPRDetail({ workspace: WORKSPACE, repo: REPO, prId, token: TOKEN, apiBase: bb.apiBase });
        assert.strictEqual(diffstatCalls, 1);
        assert.deepStrictEqual(detail.diffStat, { filesChanged: 0, linesAdded: 0, linesRemoved: 0, files: [] });
    } finally {
        await bb.close();
    }
});

test('approvePR: POST .../approve com Bearer no header, devolve {approved:true} independente do corpo da API', async () => {
    const prId = 501;
    const bb = await fakeBitbucket([
        {
            method: 'POST', path: new RegExp(`^/2\\.0/repositories/${WORKSPACE}/${REPO}/pullrequests/${prId}/approve$`),
            handler: (req, res) => json(res, 200, { approved: true, user: { account_id: 'acc-1' } }),
        },
    ]);
    try {
        const result = await approvePR({ workspace: WORKSPACE, repo: REPO, prId, token: TOKEN, apiBase: bb.apiBase });
        assert.deepStrictEqual(result, { approved: true });
        assert.strictEqual(bb.seen.length, 1);
        assert.strictEqual(bb.seen[0].method, 'POST');
        assert.strictEqual(bb.seen[0].auth, `Bearer ${TOKEN}`);
        assert.ok(!bb.seen[0].url.includes(TOKEN));
    } finally {
        await bb.close();
    }
});

test('erro HTTP (404/500): lança com status e mensagem sem o token; nada é logado no console', async () => {
    const bb = await fakeBitbucket([
        { method: 'GET', path: /^\/2\.0\/user$/, handler: (req, res) => json(res, 404, { error: 'not found' }) },
        {
            method: 'GET', path: new RegExp(`^/2\\.0/repositories/${WORKSPACE}/${REPO}/pullrequests/900$`),
            handler: (req, res) => { res.writeHead(500); res.end('boom'); },
        },
    ]);
    try {
        const lines = await captureConsole(async () => {
            await assert.rejects(
                getCurrentUser({ token: TOKEN, apiBase: bb.apiBase }),
                e => e.status === 404 && e.message === 'Bitbucket API: 404' && !e.message.includes(TOKEN),
            );
            await assert.rejects(
                getPRDetail({ workspace: WORKSPACE, repo: REPO, prId: 900, token: TOKEN, apiBase: bb.apiBase }),
                e => e.status === 500 && !e.message.includes(TOKEN),
            );
        });
        assert.strictEqual(lines.length, 0, 'este módulo não loga nada por conta própria');
    } finally {
        await bb.close();
    }
});

test('timeoutMs: requisição que nunca responde aborta e rejeita (sem travar o teste)', async () => {
    const srv = http.createServer((req) => { /* nunca responde de propósito */ req.resume(); });
    await new Promise(r => srv.listen(0, '127.0.0.1', r));
    const apiBase = `http://127.0.0.1:${srv.address().port}/2.0`;
    try {
        await assert.rejects(getCurrentUser({ token: TOKEN, apiBase, timeoutMs: 50 }));
    } finally {
        await new Promise(r => srv.close(r));
    }
});
