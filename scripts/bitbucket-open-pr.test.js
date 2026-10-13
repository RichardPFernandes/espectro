// node --test scripts/bitbucket-open-pr.test.js
// bitbucket-open-pr.sh contra um Bitbucket falso (BITBUCKET_API_BASE). O
// script roda com REPO_PATH num dir temporário sem .env: o .env real (token de
// verdade) não pode entrar no teste. Só transporte falso, em loopback.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { execFile } = require('child_process');

const WS = 'ws';
const REPO = 'app-front';
const ME = 'acc-eu';
const tmpBase = process.env.CLAUDE_JOB_DIR ? path.join(process.env.CLAUDE_JOB_DIR, 'tmp') : os.tmpdir();
const tmp = fs.mkdtempSync(path.join(tmpBase, 'open-pr-'));
fs.mkdirSync(path.join(tmp, 'scripts'));
const script = path.join(tmp, 'scripts', 'bitbucket-open-pr.sh');
fs.copyFileSync(path.join(__dirname, 'bitbucket-open-pr.sh'), script);
fs.chmodSync(script, 0o755);
// O gate e o CLI reais operam apenas nesta fixture; sem bypass de autorização.
fs.cpSync(path.join(__dirname, 'lib'), path.join(tmp, 'scripts', 'lib'), { recursive: true });
const dom06 = require('./lib/dom06-attempt');

// Comportamento do Bitbucket falso, trocado por teste.
let fake;
const posts = [];
const listGets = [];
const hits = [];
const page = (users, next) => ({ values: users.map(([account_id, display_name]) => ({ reviewer_type: 'repository', user: { account_id, display_name } })), next });

const server = http.createServer((req, res) => {
    hits.push(req.method);
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
        const u = new URL(req.url, 'http://x');
        const send = (status, obj) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
        if (u.pathname === '/2.0/user') {
            if (fake.userStatus) return send(fake.userStatus, { error: { message: 'nope' } });
            return fake.user ? send(200, { account_id: fake.user }) : send(403, { error: { message: 'lack scopes' } });
        }
        if (u.pathname === `/2.0/repositories/${WS}/${REPO}/effective-default-reviewers`) {
            if (fake.reviewersStatus) return send(fake.reviewersStatus, { error: { message: 'nope' } });
            const pages = fake.pages && fake.pages.length ? fake.pages : [[]];
            const i = Number(u.searchParams.get('page') || 0);
            const next = i + 1 < pages.length ? `${base()}/repositories/${WS}/${REPO}/effective-default-reviewers?page=${i + 1}` : undefined;
            return send(200, page(pages[i], next));
        }
        if (u.pathname === `/2.0/repositories/${WS}/${REPO}/pullrequests` && req.method === 'GET') {
            listGets.push(u.searchParams.get('q'));
            if (fake.prListStatus) return send(fake.prListStatus, { error: { message: 'nope' } });
            const q = u.searchParams.get('q') || '';
            const values = (fake.openPrs || []).filter(pr =>
                q.includes(`source.branch.name="${pr.source}"`) &&
                q.includes(`destination.branch.name="${pr.destination}"`) &&
                q.includes('state="OPEN"')
            ).map(pr => ({
                id: pr.id,
                state: 'OPEN',
                source: { branch: { name: pr.source } },
                destination: { branch: { name: pr.destination } },
                links: { html: { href: pr.href } },
            }));
            return send(200, { values });
        }
        if (u.pathname === `/2.0/repositories/${WS}/${REPO}/pullrequests` && req.method === 'POST') {
            const payload = JSON.parse(body);
            posts.push(payload);
            if (payload.reviewers.some(r => r.account_id === ME)) {
                return send(400, { type: 'error', error: { message: 'Eu Mesmo is the author and cannot be included as a reviewer.', fields: { reviewers: ['Eu Mesmo is the author and cannot be included as a reviewer.'] } } });
            }
            const names = { 'acc-ana': 'Ana', 'acc-beto': 'Beto', 'acc-caio': 'Caio', [ME]: 'Eu Mesmo' };
            return send(201, { id: 42, links: { html: { href: `https://bitbucket.org/${WS}/${REPO}/pull-requests/42` } }, reviewers: payload.reviewers.map(r => ({ display_name: names[r.account_id] })) });
        }
        send(404, {});
    });
});
const base = () => `http://127.0.0.1:${server.address().port}/2.0`;

function run(extraEnv = {}, branches = {}) {
    const source = branches.source || '41948';
    const dest = branches.dest || 'development';
    const { attemptFile } = dom06.beginAttempt(path.join(tmp, 'run'), {
        node: 'commit',
        admission: { status: 'ADMITTED', owner: 'dom06', snapshot: { ticket_id: 41948, node: 'commit', repo: REPO, source, destination: dest } },
        obligations: [{ id: 'pull_request', kind: 'external_effect' }],
    });
    return new Promise(resolve => {
        const child = execFile('bash', [script, REPO, source, dest, 'Melhoria #41948'], {
            env: { PATH: process.env.PATH, HOME: tmp, BITBUCKET_WORKSPACE: WS, BITBUCKET_API_TOKEN: 'tok-fake', BITBUCKET_API_BASE: base(), REPO_PATH: tmp, DOM06_ATTEMPT_FILE: attemptFile, ...extraEnv },
        }, (err, stdout, stderr) => resolve({ code: err ? err.code : 0, stdout, stderr, attempt: dom06.readAttempt(attemptFile) }));
        child.stdin.end('descrição');
    });
}

test.before(() => new Promise(r => server.listen(0, '127.0.0.1', r)));
test.after(() => { server.close(); fs.rmSync(tmp, { recursive: true, force: true }); });
test.beforeEach(() => { posts.length = 0; listGets.length = 0; hits.length = 0; });

test('DOM06: sem Attempt o gate recusa antes de qualquer request', async () => {
    fake = { pages: [[]] };
    const r = await run({ DOM06_ATTEMPT_FILE: '' });
    assert.notStrictEqual(r.code, 0);
    assert.match(r.stderr, /AUTHORITY_INVALID/);
    assert.strictEqual(posts.length, 0);
    assert.strictEqual(listGets.length, 0);
    assert.strictEqual(hits.length, 0);
});

test('DOM06: Attempt não admitido recusa antes de qualquer request', async () => {
    fake = { pages: [[]] };
    const { attemptFile } = dom06.beginAttempt(path.join(tmp, 'denied'), {
        node: 'commit', admission: { status: 'DENIED' },
    });
    const r = await run({ DOM06_ATTEMPT_FILE: attemptFile });
    assert.notStrictEqual(r.code, 0);
    assert.match(r.stderr, /AUTHORITY_INVALID/);
    assert.strictEqual(hits.length, 0);
});

test('BITBUCKET_ACCOUNT_ID: manda os default reviewers sem o autor, num POST só (com paginação)', async () => {
    fake = { pages: [[['acc-ana', 'Ana'], [ME, 'Eu Mesmo']], [['acc-beto', 'Beto']]] };
    const r = await run({ BITBUCKET_ACCOUNT_ID: ME });
    assert.strictEqual(r.code, 0, r.stderr);
    assert.strictEqual(posts.length, 1);
    assert.deepStrictEqual(posts[0].reviewers, [{ account_id: 'acc-ana' }, { account_id: 'acc-beto' }]);
    assert.strictEqual(posts[0].draft, true);
    assert.strictEqual(r.stdout.trim(), `https://bitbucket.org/${WS}/${REPO}/pull-requests/42`);
    assert.match(r.stderr, /Reviewers: Ana, Beto/);
    assert.deepStrictEqual(r.attempt.obligations, [{ id: 'pull_request', kind: 'external_effect', status: 'fulfilled' }]);
    assert.strictEqual(r.attempt.effects.length, 1);
    assert.strictEqual(r.attempt.effects[0].idempotency_key, 'pr:app-front:41948:development');
    assert.strictEqual(listGets[0], 'source.branch.name="41948" AND destination.branch.name="development" AND state="OPEN"');
});

test('/user com escopo: usa o account_id dele pra tirar o autor', async () => {
    fake = { user: ME, pages: [[[ME, 'Eu Mesmo'], ['acc-caio', 'Caio']]] };
    const r = await run();
    assert.strictEqual(r.code, 0, r.stderr);
    assert.deepStrictEqual(posts.map(p => p.reviewers), [[{ account_id: 'acc-caio' }]]);
});

test('GET /2.0/user com erro que não é 401/403 segue, e 400 do autor tenta de novo uma vez', async () => {
    fake = { userStatus: 500, pages: [[['acc-ana', 'Ana'], [ME, 'Eu Mesmo']]] };
    const r = await run();
    assert.strictEqual(r.code, 0, r.stderr);
    assert.strictEqual(posts.length, 2);
    assert.deepStrictEqual(posts[1].reviewers, [{ account_id: 'acc-ana' }]);
    assert.match(r.stderr, /Reviewers: Ana/);
});

test('GET /2.0/user 401/403 interrompe sem POST', async () => {
    for (const status of [401, 403]) {
        posts.length = 0;
        listGets.length = 0;
        fake = { userStatus: status, pages: [[['acc-ana', 'Ana'], [ME, 'Eu Mesmo']]] };
        const r = await run();
        assert.notStrictEqual(r.code, 0, String(status));
        assert.match(r.stderr, new RegExp(`ERROR: HTTP ${status}`));
        assert.match(r.stderr, /PR não será criado/);
        assert.strictEqual(posts.length, 0, String(status));
        assert.strictEqual(listGets.length, 0, String(status));
        assert.ok(!r.stderr.includes('tok-fake') && !r.stdout.includes('tok-fake'));
    }
});

test('falha que não é 401/403 ao buscar os default reviewers não impede o PR: abre sem e avisa', async () => {
    fake = { reviewersStatus: 500 };
    const r = await run();
    assert.strictEqual(r.code, 0, r.stderr);
    assert.deepStrictEqual(posts[0].reviewers, []);
    assert.match(r.stderr, /WARN: não deu pra buscar os default reviewers/);
    assert.ok(!r.stderr.includes('tok-fake') && !r.stdout.includes('tok-fake'), 'token nunca aparece na saída');
});

test('401/403 ao buscar os default reviewers interrompe sem POST', async () => {
    for (const status of [401, 403]) {
        posts.length = 0;
        listGets.length = 0;
        fake = { reviewersStatus: status };
        const r = await run();
        assert.notStrictEqual(r.code, 0, String(status));
        assert.match(r.stderr, new RegExp(`ERROR: HTTP ${status}`));
        assert.match(r.stderr, /PR não será criado/);
        assert.strictEqual(posts.length, 0, String(status));
        assert.strictEqual(listGets.length, 0, String(status));
    }
});

test('PR OPEN da mesma origem e destino é reutilizado: URL na última linha, sem POST', async () => {
    const href = `https://bitbucket.org/${WS}/${REPO}/pull-requests/7`;
    fake = {
        pages: [[]],
        openPrs: [{ id: 7, source: '41948', destination: 'development', href }],
    };
    const r = await run({ BITBUCKET_ACCOUNT_ID: ME });
    assert.strictEqual(r.code, 0, r.stderr);
    assert.strictEqual(posts.length, 0);
    const lines = r.stdout.replace(/\s+$/, '').split('\n');
    assert.strictEqual(lines[lines.length - 1], href);
    assert.match(r.stderr, /já aberto/);
    assert.ok(!r.stderr.includes('tok-fake') && !r.stdout.includes('tok-fake'));
});

test('PR OPEN para outro destino não é reutilizado', async () => {
    fake = {
        pages: [[]],
        openPrs: [{ id: 8, source: '41948', destination: 'main', href: `https://bitbucket.org/${WS}/${REPO}/pull-requests/8` }],
    };
    const r = await run({ BITBUCKET_ACCOUNT_ID: ME });
    assert.strictEqual(r.code, 0, r.stderr);
    assert.strictEqual(posts.length, 1);
    assert.strictEqual(posts[0].destination.branch.name, 'development');
});

test('consulta de PR com branch especial usa q URL-encoded e state dentro do filtro', async () => {
    const source = 'feat/a b"c\\d';
    const dest = 'release/1.0';
    fake = { pages: [[]] };
    const r = await run({ BITBUCKET_ACCOUNT_ID: ME }, { source, dest });
    assert.strictEqual(r.code, 0, r.stderr);
    assert.strictEqual(posts.length, 1);
    assert.strictEqual(listGets[0], 'source.branch.name="feat/a b\\"c\\\\d" AND destination.branch.name="release/1.0" AND state="OPEN"');
    assert.strictEqual(posts[0].source.branch.name, source);
});

test('consulta de PR 401/403 interrompe sem POST', async () => {
    for (const status of [401, 403]) {
        posts.length = 0;
        listGets.length = 0;
        fake = { pages: [[]], prListStatus: status };
        const r = await run({ BITBUCKET_ACCOUNT_ID: ME });
        assert.notStrictEqual(r.code, 0, String(status));
        assert.match(r.stderr, new RegExp(`ERROR: HTTP ${status}`));
        assert.match(r.stderr, /PR não será criado/);
        assert.strictEqual(posts.length, 0, String(status));
        assert.strictEqual(listGets.length, 1, String(status));
    }
});

test('consulta de PR com erro que não é 401/403 também não segue para o POST', async () => {
    fake = { pages: [[]], prListStatus: 500 };
    const r = await run({ BITBUCKET_ACCOUNT_ID: ME });
    assert.strictEqual(r.code, 1, r.stderr);
    assert.match(r.stderr, /ERROR: HTTP 500/);
    assert.match(r.stderr, /PR não será criado/);
    assert.strictEqual(posts.length, 0);
    assert.strictEqual(listGets.length, 1);
});
