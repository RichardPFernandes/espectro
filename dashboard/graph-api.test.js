// node --test graph-api.test.js
// GET /api/graph: Knowledge Graph (memory/knowledge-graph.json) inteiro ou recortado por
// ?taskId= / ?file=, com a árvore ticket → spec → arquivos → PRs pronta pra aba Grafo.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpBase = process.env.CLAUDE_JOB_DIR ? path.join(process.env.CLAUDE_JOB_DIR, 'tmp') : os.tmpdir();
const tmp = fs.mkdtempSync(path.join(tmpBase, 'graph-api-'));
const repo = path.join(tmp, 'app-back');
const mainRuns = path.join(repo, 'memory', 'runs');
fs.mkdirSync(mainRuns, { recursive: true });
const graphPath = path.join(repo, 'memory', 'knowledge-graph.json');

process.env.BITBUCKET_API_TOKEN = 'segredo-que-nao-vaza';
const kg = require('../scripts/lib/knowledge-graph');
const { createDashboard } = require('./server');
const dash = createDashboard({ memoryDir: mainRuns });
let base;

const F1 = 'src/main/java/br/com/t/CalculoFreteService.java';
const F2 = 'src/main/java/br/com/t/Outro.java';

test.before(async () => {
    await new Promise(r => dash.server.listen(0, '127.0.0.1', r));
    base = `http://localhost:${dash.server.address().port}`;
    await dash.ready;
});
test.after(() => { dash.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

async function get(p) {
    const res = await fetch(base + p);
    return { status: res.status, body: await res.json() };
}

test('sem arquivo: exists=false e lista vazia', async () => {
    const { status, body } = await get('/api/graph');
    assert.strictEqual(status, 200);
    assert.strictEqual(body.exists, false);
    assert.deepStrictEqual(body.tickets, []);
});

test('árvore por ticket e filtros ?taskId= / ?file=', async () => {
    const facts = (ticket, files, pr) => kg.taskFacts({
        taskId: `${ticket}-x`,
        state: {
            redmine_ticket: { id: ticket, subject: `Ticket ${ticket}` },
            pull_request: { 'app-back': { url: `https://bitbucket.org/mo/app-back/pull-requests/${pr}`, status: 'OPEN' } },
        },
        files: files.map(p => ({ repo: 'app-back', path: p })),
    });
    kg.updateGraph(g => kg.mergeFacts(g, facts(90020, [F1], 7)) | kg.mergeFacts(g, facts(90021, [F1, F2], 8)), graphPath);

    const all = (await get('/api/graph')).body;
    assert.strictEqual(all.exists, true);
    assert.deepStrictEqual(all.tickets.map(t => t.id), ['TASK-90021', 'TASK-90020']);
    const t = all.tickets[0];
    assert.strictEqual(t.title, 'Ticket 90021');
    assert.deepStrictEqual(t.specs.map(s => s.id), ['memory/spec/90021-spec.md']);
    assert.deepStrictEqual(t.files.map(f => f.id).sort(), [F1, F2]);
    assert.strictEqual(t.files[0].type, 'file');
    assert.deepStrictEqual(t.prs.map(p => [p.id, p.status]), [['PR-app-back-8', 'open']]);

    const byTask = (await get('/api/graph?taskId=90020-qualquer-slug')).body;
    assert.deepStrictEqual(byTask.tickets.map(t => t.id), ['TASK-90020']);
    assert.strictEqual(byTask.filter.taskId, '90020-qualquer-slug');

    const byFile = (await get(`/api/graph?file=${encodeURIComponent(F2)}`)).body;
    assert.deepStrictEqual(byFile.tickets.map(t => t.id), ['TASK-90021']);
    const byName = (await get('/api/graph?file=CalculoFreteService.java')).body;
    assert.deepStrictEqual(byName.tickets.map(t => t.id).sort(), ['TASK-90020', 'TASK-90021']);

    const both = (await get(`/api/graph?taskId=TASK-90020&file=${encodeURIComponent(F2)}`)).body;
    assert.deepStrictEqual(both.tickets, []);
});

test('segredo do ambiente não sai pela API; arquivo malformado → 500 sem derrubar', async () => {
    kg.updateGraph(g => kg.mergeFacts(g, { nodes: { 'TASK-1': { type: 'ticket', title: 'token segredo-que-nao-vaza' } } }), graphPath);
    const { body } = await get('/api/graph?taskId=1');
    assert.doesNotMatch(JSON.stringify(body), /segredo-que-nao-vaza/);
    fs.writeFileSync(graphPath, '{ quebrado');
    const r = await get('/api/graph');
    assert.strictEqual(r.status, 500);
    assert.match(r.body.error, /ilegível/);
});
