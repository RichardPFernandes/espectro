// node --test compare-api.test.js
// GET /api/compare/:taskIdA/:taskIdB contra um repo sintético (run ativo no worktree do
// ticket, run no _archive do principal, registro de replay).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpBase = process.env.CLAUDE_JOB_DIR ? path.join(process.env.CLAUDE_JOB_DIR, 'tmp') : os.tmpdir();
const tmp = fs.mkdtempSync(path.join(tmpBase, 'compare-api-'));
const repo = path.join(tmp, 'app-back');
const mainRuns = path.join(repo, 'memory', 'runs');
const wt = id => path.join(repo, '.claude', 'worktrees', id, 'memory', 'runs');
fs.mkdirSync(mainRuns, { recursive: true });

function seed(runsDir, taskId, state, file = 'state.json') {
    const dir = path.join(runsDir, taskId);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, file), JSON.stringify({ task_id: taskId, updated_at: '2026-09-20T00:00:00Z', ...state }));
}
const ct = n => ({ nodes: { plan: { input_tokens: n, output_tokens: 0 } } });
seed(wt('95201'), '95201-falhou', { node: 'escalated', status: 'escalated', history: ['plan', 'implement', 'test'], cost_tracking: ct(1000) });
seed(wt('95201'), '95201-falhou', { node: 'commit', status: 'committed', history: ['plan'], cost_tracking: ct(500) }, 'state-replay-95201-falhou-replay-1.json');
seed(path.join(mainRuns, '_archive'), '95202-ok', { node: 'commit', status: 'committed', history: ['plan', 'implement', 'test', 'commit'], cost_tracking: ct(600) });
seed(wt('95203'), '95203-sem-campos', {});

const { createDashboard } = require('./server');
const dash = createDashboard({ memoryDir: mainRuns });
let base;

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

test('compara run ativo (worktree) com run arquivado: B-better', async () => {
    const r = await get('/api/compare/95201-falhou/95202-ok');
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(r.body.verdict, 'B-better');
    assert.ok(Array.isArray(r.body.stateDiff));
    assert.strictEqual(r.body.tokenDiff.total.deltaPct, -40);
    assert.deepStrictEqual(r.body.metrics.map(m => m.label).slice(0, 2), ['Status', 'Nó final']);
    assert.strictEqual(r.body.runA.source, 'worktree:95201');
    assert.strictEqual(r.body.runB.source, 'main/_archive');
});

test('aceita registro de replay (%2F) e run sem campos (N/A)', async () => {
    const r = await get(`/api/compare/95201-falhou/${encodeURIComponent('95201-falhou/state-replay-95201-falhou-replay-1.json')}`);
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(r.body.verdict, 'B-better');
    const n = await get('/api/compare/95203-sem-campos/95202-ok');
    assert.strictEqual(n.status, 200);
    assert.strictEqual(n.body.metrics.find(m => m.key === 'status').a, 'N/A');
    const empty = await get('/api/compare/95203-sem-campos/95203-sem-campos');
    assert.strictEqual(empty.status, 200);
    assert.strictEqual(empty.body.verdict, 'inconclusive');
    assert.deepStrictEqual(empty.body.metrics.find(m => m.key === 'cost_usd').complete, { a: false, b: false });
});

test('run inexistente = 404; ref inválida = 400', async () => {
    assert.strictEqual((await get('/api/compare/95201-falhou/nao-existe')).status, 404);
    assert.strictEqual((await get(`/api/compare/95201-falhou/${encodeURIComponent('95201-falhou/context.md')}`)).status, 400);
});
