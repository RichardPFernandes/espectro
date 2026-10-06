// node --test replay-api.test.js
// "↩ Retomar a partir de": campo replay do resumo do run e POST /api/runs/:taskId/replay,
// contra um repo sintético. O runner (scripts/replay-cycle.js) é stubado — exceto num
// caso, que roda o script de verdade até a validação do worktree (sem despachar nada).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpBase = process.env.CLAUDE_JOB_DIR ? path.join(process.env.CLAUDE_JOB_DIR, 'tmp') : os.tmpdir();
const tmp = fs.mkdtempSync(path.join(tmpBase, 'replay-api-'));
const repo = path.join(tmp, 'app-back');
const mainRuns = path.join(repo, 'memory', 'runs');
const wt = id => path.join(repo, '.claude', 'worktrees', id, 'memory', 'runs');
fs.mkdirSync(mainRuns, { recursive: true });

function seed(runsDir, taskId, state) {
    const dir = path.join(runsDir, taskId);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ task_id: taskId, updated_at: '2026-09-20T00:00:00Z', ...state }));
    return dir;
}
const H = ['fetch_ticket', 'plan', 'implement', 'review', 'test'];
seed(wt('95001'), '95001-falhou-no-test', { node: 'test', status: 'escalated', history: H });
seed(wt('95002'), '95002-andando', { node: 'review', status: 'in_progress', history: H.slice(0, 3) });
seed(wt('95001'), '95001-falhou-no-test-replay-1', {
    node: 'verify', status: 'in_progress', history: [...H.slice(0, 4), 'test'], updated_at: '2026-09-21T00:00:00Z',
    replayOf: { originalRun: '95001-falhou-no-test', fromNode: 'test', replayedAt: '2026-09-21T00:00:00Z' },
});

const calls = [];
let nextResult = null;
const { createDashboard } = require('./server');
const dash = createDashboard({
    memoryDir: mainRuns,
    replayRunner: async args => {
        calls.push(args);
        return nextResult || { ok: true, replayTaskId: '95001-falhou-no-test-replay-2', fromNode: args[3], nodesToRun: ['test', 'verify', 'commit'], removed: ['test-results.md'], redmine: true, dispatch: { action: 'dispatched' }, warnings: [] };
    },
});
let base;

test.before(async () => {
    await new Promise(r => dash.server.listen(0, '127.0.0.1', r));
    base = `http://localhost:${dash.server.address().port}`;
    await dash.ready;
});
test.after(() => dash.close());

async function get(p) {
    const res = await fetch(base + p);
    return { status: res.status, body: await res.json() };
}
async function post(p, body) {
    const res = await fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
}

test('resumo do run: replay com os nós retomáveis; replayOf no state do replay', async () => {
    const { body } = await get('/api/runs');
    const failed = body.find(r => r.taskId === '95001-falhou-no-test');
    assert.deepStrictEqual(failed.replay, { replayable: true, reason: null, nodes: ['plan', 'implement', 'review', 'test', 'verify'] });
    const moving = body.find(r => r.taskId === '95002-andando');
    assert.strictEqual(moving.replay.replayable, false);
    const replay = body.find(r => r.taskId === '95001-falhou-no-test-replay-1');
    assert.strictEqual(replay.state.replayOf.originalRun, '95001-falhou-no-test');
    assert.strictEqual(replay.replay.replayable, false, 'replay andando não oferece retomar');
});

test('POST /replay: valida fromNode, status e nós anteriores antes de chamar o script', async () => {
    assert.strictEqual((await post('/api/runs/95001-falhou-no-test/replay', { fromNode: 'deploy' })).status, 400);
    assert.strictEqual((await post('/api/runs/95001-falhou-no-test/replay', {})).status, 400);
    const moving = await post('/api/runs/95002-andando/replay', { fromNode: 'review' });
    assert.strictEqual(moving.status, 409);
    assert.match(moving.body.error, /andando/);
    const tooFar = await post('/api/runs/95001-falhou-no-test/replay', { fromNode: 'commit' });
    assert.strictEqual(tooFar.status, 409);
    assert.strictEqual((await post('/api/runs/nao-existe/replay', { fromNode: 'test' })).status, 404);
    assert.strictEqual(calls.length, 0);
});

test('POST /replay: invoca replay-cycle.js com --task/--from e devolve o run novo', async () => {
    const res = await post('/api/runs/95001-falhou-no-test/replay', { fromNode: 'test' });
    assert.strictEqual(res.status, 201);
    const args = calls.pop();
    assert.deepStrictEqual(args.slice(0, 4), ['--task', '95001-falhou-no-test', '--from', 'test']);
    // CAS do run original (scripts/cas.js): versão/nó/execution_id que a tela carregou.
    assert.deepStrictEqual(args.filter(a => a.startsWith('--expected') || a === '--execution-id'), ['--expected-version', '--expected-node', '--execution-id']);
    assert.strictEqual(res.body.replayTaskId, '95001-falhou-no-test-replay-2');
    assert.strictEqual(res.body.dispatched, true);
    assert.deepStrictEqual(res.body.nodesToRun, ['test', 'verify', 'commit']);
});

test('POST /replay: recusa do script vira 409 com a mensagem dele', async () => {
    nextResult = { ok: false, error: 'worktree do ciclo original não existe mais', code: 'worktree_missing' };
    try {
        const res = await post('/api/runs/95001-falhou-no-test/replay', { fromNode: 'review' });
        assert.strictEqual(res.status, 409);
        assert.strictEqual(res.body.code, 'worktree_missing');
        assert.match(res.body.error, /worktree/);
    } finally {
        nextResult = null;
    }
});

test('runner padrão: roda scripts/replay-cycle.js de verdade (recusa: worktree fora do git)', async () => {
    const prev = process.env.REPO_PATH;
    process.env.REPO_PATH = repo; // herdado pelo execFile do runner padrão
    const real = createDashboard({ memoryDir: mainRuns });
    await new Promise(r => real.server.listen(0, '127.0.0.1', r));
    try {
        await real.ready;
        const res = await fetch(`http://localhost:${real.server.address().port}/api/runs/95001-falhou-no-test/replay`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fromNode: 'test' }),
        });
        const body = await res.json();
        assert.strictEqual(res.status, 409, JSON.stringify(body));
        assert.strictEqual(body.code, 'worktree_missing');
        assert.ok(!fs.existsSync(path.join(wt('95001'), '95001-falhou-no-test-replay-2')), 'nada criado');
    } finally {
        real.close();
        if (prev === undefined) delete process.env.REPO_PATH; else process.env.REPO_PATH = prev;
    }
});
