// node --test scripts/bitbucket-open-pr.test.js
// bitbucket-open-pr.sh contra um Bitbucket falso (BITBUCKET_API_BASE). O
// script roda de uma cópia num dir temporário: ele carrega ../.env relativo a
// si mesmo, e o .env real (token de verdade) não pode entrar no teste.
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

// Comportamento do Bitbucket falso, trocado por teste.
let fake;
const posts = [];
const page = (users, next) => ({ values: users.map(([account_id, display_name]) => ({ reviewer_type: 'repository', user: { account_id, display_name } })), next });

const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
        const u = new URL(req.url, 'http://x');
        const send = (status, obj) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
        if (u.pathname === '/2.0/user') return fake.user ? send(200, { account_id: fake.user }) : send(403, { error: { message: 'lack scopes' } });
        if (u.pathname === `/2.0/repositories/${WS}/${REPO}/effective-default-reviewers`) {
            if (fake.reviewersStatus) return send(fake.reviewersStatus, { error: { message: 'nope' } });
            const pages = fake.pages;
            const i = Number(u.searchParams.get('page') || 0);
            const next = i + 1 < pages.length ? `${base()}/repositories/${WS}/${REPO}/effective-default-reviewers?page=${i + 1}` : undefined;
            return send(200, page(pages[i], next));
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

function run(extraEnv = {}) {
    return new Promise(resolve => {
        const child = execFile('bash', [script, REPO, '41948', 'development', 'Melhoria #41948'], {
            env: { PATH: process.env.PATH, HOME: process.env.HOME, BITBUCKET_WORKSPACE: WS, BITBUCKET_API_TOKEN: 'tok-fake', BITBUCKET_API_BASE: base(), ...extraEnv },
        }, (err, stdout, stderr) => resolve({ code: err ? err.code : 0, stdout, stderr }));
        child.stdin.end('descrição');
    });
}

test.before(() => new Promise(r => server.listen(0, '127.0.0.1', r)));
test.after(() => { server.close(); fs.rmSync(tmp, { recursive: true, force: true }); });
test.beforeEach(() => { posts.length = 0; });

test('BITBUCKET_ACCOUNT_ID: manda os default reviewers sem o autor, num POST só (com paginação)', async () => {
    fake = { pages: [[['acc-ana', 'Ana'], [ME, 'Eu Mesmo']], [['acc-beto', 'Beto']]] };
    const r = await run({ BITBUCKET_ACCOUNT_ID: ME });
    assert.strictEqual(r.code, 0, r.stderr);
    assert.strictEqual(posts.length, 1);
    assert.deepStrictEqual(posts[0].reviewers, [{ account_id: 'acc-ana' }, { account_id: 'acc-beto' }]);
    assert.strictEqual(posts[0].draft, true);
    assert.strictEqual(r.stdout.trim(), `https://bitbucket.org/${WS}/${REPO}/pull-requests/42`);
    assert.match(r.stderr, /Reviewers: Ana, Beto/);
});

test('/user com escopo: usa o account_id dele pra tirar o autor', async () => {
    fake = { user: ME, pages: [[[ME, 'Eu Mesmo'], ['acc-caio', 'Caio']]] };
    const r = await run();
    assert.strictEqual(r.code, 0, r.stderr);
    assert.deepStrictEqual(posts.map(p => p.reviewers), [[{ account_id: 'acc-caio' }]]);
});

test('sem identidade (/user 403): 400 "is the author" => tira o citado e tenta de novo uma vez', async () => {
    fake = { pages: [[['acc-ana', 'Ana'], [ME, 'Eu Mesmo']]] };
    const r = await run();
    assert.strictEqual(r.code, 0, r.stderr);
    assert.strictEqual(posts.length, 2);
    assert.deepStrictEqual(posts[1].reviewers, [{ account_id: 'acc-ana' }]);
    assert.match(r.stderr, /Reviewers: Ana/);
});

test('falha ao buscar os default reviewers não impede o PR: abre sem e avisa', async () => {
    fake = { reviewersStatus: 403 };
    const r = await run();
    assert.strictEqual(r.code, 0, r.stderr);
    assert.deepStrictEqual(posts[0].reviewers, []);
    assert.match(r.stderr, /WARN: não deu pra buscar os default reviewers/);
    assert.ok(!r.stderr.includes('tok-fake') && !r.stdout.includes('tok-fake'), 'token nunca aparece na saída');
});
