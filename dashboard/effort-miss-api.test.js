// node --test effort-miss-api.test.js
// GET /api/effort-misses: leitura read-only do registro effort_miss (PRI-353, AC6).
// Sem registro = UNKNOWN, nunca zero. Segredo no texto não vaza.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpBase = process.env.CLAUDE_JOB_DIR ? path.join(process.env.CLAUDE_JOB_DIR, 'tmp') : os.tmpdir();
const tmp = fs.mkdtempSync(path.join(tmpBase, 'effort-miss-api-'));
const repo = path.join(tmp, 'app-back');
const mainRuns = path.join(repo, 'memory', 'runs');
fs.mkdirSync(mainRuns, { recursive: true });

process.env.BITBUCKET_API_TOKEN = 'token-que-nao-vaza-123';
const { createDashboard } = require('./server');

function seed(taskId, extra = {}) {
    const dir = path.join(mainRuns, taskId);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({
        task_id: taskId, node: 'verify', status: 'in_progress', history: ['plan'],
        started_at: '2026-11-14T10:00:00.000Z', updated_at: '2026-11-14T11:00:00.000Z', ...extra,
    }));
    return dir;
}
const rec = (id, phase, would, what = 'teste não cobria o AC-03') => ({
    id, phase, effort: 'medium', what_missed: what, would_high_catch: would, class: 'cobertura-de-ac',
    evidence_ref: 'review_results[0]', recorded_by: 'review', recorded_at: '2026-11-14T22:00:00.000Z',
});

let dash, base;
async function start() {
    dash = createDashboard({ memoryDir: mainRuns });
    await new Promise(r => dash.server.listen(0, '127.0.0.1', r));
    base = `http://localhost:${dash.server.address().port}`;
    await dash.ready;
}
test.after(() => { dash?.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

test('sem nenhuma run com registro: 200, status UNKNOWN, total null (nunca 0)', async () => {
    seed('90001-sem-registro');
    seed('90002-lista-vazia', { effort_misses: [] });
    await start();
    const res = await fetch(`${base}/api/effort-misses`);
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.status, 'UNKNOWN');
    assert.strictEqual(body.total, null);
    assert.deepStrictEqual(body.runs, []);
});

test('com registros: lista só as runs que têm, conta por fase e redige segredo', async () => {
    seed('90003-com-registro', { effort_misses: [
        rec('em-1', 'test', 'yes'),
        rec('em-2', 'verify', 'unknown', 'vazou BITBUCKET token-que-nao-vaza-123 no log'),
    ] });
    // a cache de runs do dashboard pode demorar a ver a pasta nova: reinicia o servidor do teste
    dash.close();
    await start();
    const res = await fetch(`${base}/api/effort-misses`);
    const body = await res.json();
    assert.strictEqual(body.status, 'RECORDED');
    assert.strictEqual(body.total, 2);
    assert.deepStrictEqual(body.runs.map(r => r.taskId), ['90003-com-registro']);
    assert.deepStrictEqual(body.by_phase.test, { yes: 1, no: 0, unknown: 0 });
    assert.deepStrictEqual(body.by_phase.verify, { yes: 0, no: 0, unknown: 1 });
    assert.ok(!JSON.stringify(body).includes('token-que-nao-vaza-123'));
});

test('endpoint é só leitura: POST/PUT/DELETE não existem', async () => {
    for (const method of ['POST', 'PUT', 'DELETE']) {
        const res = await fetch(`${base}/api/effort-misses`, { method });
        assert.ok([404, 405].includes(res.status), `${method} → ${res.status}`);
    }
});

test('leitor por processo quebrado: 502 com status UNKNOWN, sem vazar caminho e sem zero', async () => {
    const broken = createDashboard({ memoryDir: mainRuns, effortMissReadScript: path.join(tmp, 'nao-existe.js') });
    await new Promise(r => broken.server.listen(0, '127.0.0.1', r));
    try {
        await broken.ready;
        const res = await fetch(`http://localhost:${broken.server.address().port}/api/effort-misses`);
        assert.strictEqual(res.status, 502);
        const body = await res.json();
        assert.strictEqual(body.status, 'UNKNOWN');
        assert.strictEqual(body.total, null);
        assert.ok(!JSON.stringify(body).includes(tmp));
    } finally { broken.close(); }
});

test('o dashboard não importa scripts/lib/effort-miss (fronteira G3)', () => {
    const src = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
    assert.doesNotMatch(src, /require\([^)]*effort-miss/);
});
