// node --test pr-ready-api.test.js
// POST /api/pr/:ticketId/ready contra um Bitbucket falso (GET + PUT do PR).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { createDashboard } = require('./server');

const TOKEN = 'ATATT-segredo-de-teste';
const tmpBase = process.env.CLAUDE_JOB_DIR ? path.join(process.env.CLAUDE_JOB_DIR, 'tmp') : os.tmpdir();
const tmp = fs.mkdtempSync(path.join(tmpBase, 'pr-ready-'));
const runs = path.join(tmp, 'memory', 'runs');

function writeRun(taskId, state) {
    fs.mkdirSync(path.join(runs, taskId), { recursive: true });
    fs.writeFileSync(path.join(runs, taskId, 'state.json'), JSON.stringify({ task_id: taskId, node: 'commit', history: [], status: 'committed', ...state }, null, 2));
}
const readRun = taskId => JSON.parse(fs.readFileSync(path.join(runs, taskId, 'state.json'), 'utf8'));

// PRs do Bitbucket falso: "<repo>#<id>" → { draft, state }. PUT lento de propósito
// pra dar tempo do segundo clique chegar durante a chamada.
const prs = new Map();
const seen = [];
const bb = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
        seen.push({ method: req.method, url: req.url, auth: req.headers.authorization, body });
        const m = req.url.match(/^\/2\.0\/repositories\/ws\/([^/]+)\/pullrequests\/(\d+)$/);
        const pr = m && prs.get(`${m[1]}#${m[2]}`);
        if (!pr) { res.writeHead(404); return res.end('{}'); }
        if (pr.fail) { res.writeHead(500); return res.end('{}'); }
        const reply = () => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ id: Number(m[2]), title: `PR ${m[2]}`, state: pr.state, draft: pr.draft, links: { html: { href: `https://bitbucket.org/ws/${m[1]}/pull-requests/${m[2]}` } } }));
        };
        if (req.method === 'PUT') {
            const payload = JSON.parse(body);
            if (!payload.title) { res.writeHead(400); return res.end('{}'); }
            pr.draft = payload.draft;
            return setTimeout(reply, 150);
        }
        reply();
    });
});

let dash, base;
test.before(async () => {
    process.env.BITBUCKET_API_TOKEN = TOKEN;
    await new Promise(r => bb.listen(0, '127.0.0.1', r));
    dash = createDashboard({ memoryDir: runs, worktreesDir: path.join(tmp, 'wt'), prefsFile: path.join(tmp, 'prefs.json'), bitbucketApi: `http://127.0.0.1:${bb.address().port}/2.0` });
    await new Promise(r => dash.server.listen(0, '127.0.0.1', r));
    base = `http://localhost:${dash.server.address().port}`;
    await dash.ready;
});
test.after(async () => {
    await dash.close();
    bb.close();
    delete process.env.BITBUCKET_API_TOKEN;
    fs.rmSync(tmp, { recursive: true, force: true });
});

const post = async (p, body) => {
    const res = await fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
    const text = await res.text();
    return { status: res.status, text, body: JSON.parse(text) };
};

test('tira todos os PRs da task de Draft e grava pr_status "ready"; token só no header', async () => {
    writeRun('5001-ajuste', {
        pr_status: 'draft',
        pull_request: {
            'app-back': { url: 'https://bitbucket.org/ws/app-back/pull-requests/11' },
            'app-front': { url: 'https://bitbucket.org/ws/app-front/pull-requests/22' },
        },
    });
    prs.set('app-back#11', { draft: true, state: 'OPEN' });
    prs.set('app-front#22', { draft: true, state: 'OPEN' });
    const r = await post('/api/pr/5001/ready', { taskId: '5001-ajuste' });
    assert.strictEqual(r.status, 200, r.text);
    assert.deepStrictEqual(r.body, { ok: true });
    assert.ok(!r.text.includes(TOKEN));
    assert.strictEqual(prs.get('app-back#11').draft, false);
    assert.strictEqual(prs.get('app-front#22').draft, false);
    const st = readRun('5001-ajuste');
    assert.strictEqual(st.pr_status, 'ready');
    assert.strictEqual(st.pr_id, 11);
    assert.strictEqual(st.pull_request['app-front'].draft, false);
    const puts = seen.filter(s => s.method === 'PUT');
    assert.ok(puts.length === 2 && puts.every(s => JSON.parse(s.body).draft === false && JSON.parse(s.body).title));
    assert.ok(seen.every(s => s.auth === `Bearer ${TOKEN}` && !s.url.includes(TOKEN)));
});

test('sem taskId no body: resolve pelo número do ticket', async () => {
    writeRun('5002-outra', { pr_status: 'draft', pull_request: { 'app-back': { url: 'https://bitbucket.org/ws/app-back/pull-requests/33' } } });
    prs.set('app-back#33', { draft: true, state: 'OPEN' });
    const r = await post('/api/pr/5002/ready');
    assert.strictEqual(r.status, 200, r.text);
    assert.strictEqual(readRun('5002-outra').pr_status, 'ready');
});

test('falha parcial: 502 com o repo que falhou, pr_status continua "draft"', async () => {
    writeRun('5003-parcial', {
        pr_status: 'draft',
        pull_request: {
            'app-back': { url: 'https://bitbucket.org/ws/app-back/pull-requests/44' },
            'app-core': { url: 'https://bitbucket.org/ws/app-core/pull-requests/55' },
        },
    });
    prs.set('app-back#44', { draft: true, state: 'OPEN' });
    prs.set('app-core#55', { draft: true, state: 'OPEN', fail: true });
    const r = await post('/api/pr/5003/ready', { taskId: '5003-parcial' });
    assert.strictEqual(r.status, 502);
    assert.match(r.body.error, /app-core#55/);
    assert.ok(!r.text.includes(TOKEN));
    const st = readRun('5003-parcial');
    assert.strictEqual(st.pr_status, 'draft');
    assert.strictEqual(st.pull_request['app-back'].draft, false);
});

test('segundo clique durante a chamada → 409; sem PR → 422; mergeado → 409; ticket inexistente → 404', async () => {
    writeRun('5004-duplo', { pr_status: 'draft', pull_request: { 'app-back': { url: 'https://bitbucket.org/ws/app-back/pull-requests/66' } } });
    prs.set('app-back#66', { draft: true, state: 'OPEN' });
    const [a, b] = await Promise.all([
        post('/api/pr/5004/ready', { taskId: '5004-duplo' }),
        new Promise(r => setTimeout(r, 60)).then(() => post('/api/pr/5004/ready', { taskId: '5004-duplo' })),
    ]);
    assert.strictEqual(a.status, 200, a.text);
    assert.strictEqual(b.status, 409);

    writeRun('5005-sempr', {});
    assert.strictEqual((await post('/api/pr/5005/ready', { taskId: '5005-sempr' })).status, 422);
    writeRun('5006-merged', { pr_status: 'merged', pull_request: { 'app-back': { url: 'https://bitbucket.org/ws/app-back/pull-requests/77' } } });
    assert.strictEqual((await post('/api/pr/5006/ready', { taskId: '5006-merged' })).status, 409);
    assert.strictEqual((await post('/api/pr/9999/ready')).status, 404);
});

test('só localhost', async () => {
    const res = await fetch(base + '/api/pr/5001/ready', { method: 'POST', headers: { Origin: 'http://evil.example' } });
    assert.strictEqual(res.status, 403);
});
