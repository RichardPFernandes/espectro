// node --test patterns-api.test.js
// GET /api/patterns: memory/patterns.md (gerado por scripts/memory-consolidator.js)
// + metadata de memory/consolidator-state.json, pra aba "Padrões" do dashboard.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpBase = process.env.CLAUDE_JOB_DIR ? path.join(process.env.CLAUDE_JOB_DIR, 'tmp') : os.tmpdir();
const tmp = fs.mkdtempSync(path.join(tmpBase, 'patterns-api-'));
const repo = path.join(tmp, 'app-back');
const mainRuns = path.join(repo, 'memory', 'runs');
fs.mkdirSync(mainRuns, { recursive: true });
const patternsPath = path.join(repo, 'memory', 'patterns.md');
const consolidatorStatePath = path.join(repo, 'memory', 'consolidator-state.json');

process.env.BITBUCKET_API_TOKEN = 'segredo-que-nao-vaza';
const { createDashboard } = require('./server');
const dash = createDashboard({ memoryDir: mainRuns, patternsPath, consolidatorStatePath });
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

test('sem memory/patterns.md: exists=false, content/updatedAt null', async () => {
    const { status, body } = await get('/api/patterns');
    assert.strictEqual(status, 200);
    assert.strictEqual(body.exists, false);
    assert.strictEqual(body.content, null);
    assert.strictEqual(body.updatedAt, null);
    assert.strictEqual(body.totalConsolidations, 0);
});

test('com patterns.md + consolidator-state.json: devolve conteúdo e metadata', async () => {
    fs.writeFileSync(patternsPath, '# Padrões Identificados\n\n## Padrões de Falha no Review\n- **X**: ocorreu em 1/2 runs\n');
    fs.writeFileSync(consolidatorStatePath, JSON.stringify({
        completed_runs_at_last_run: 20, last_run_at: '2026-09-26T12:00:00Z', total_consolidations: 2,
    }));
    const { status, body } = await get('/api/patterns');
    assert.strictEqual(status, 200);
    assert.strictEqual(body.exists, true);
    assert.match(body.content, /## Padrões de Falha no Review/);
    assert.strictEqual(body.lastConsolidationAt, '2026-09-26T12:00:00Z');
    assert.strictEqual(body.totalConsolidations, 2);
    assert.strictEqual(body.completedRunsAtLastRun, 20);
    assert.ok(Date.parse(body.updatedAt));
});

test('segredo do ambiente não sai pela API mesmo se aparecer no arquivo', async () => {
    fs.writeFileSync(patternsPath, '# Padrões\n- nota com segredo-que-nao-vaza dentro por acidente\n');
    const { body } = await get('/api/patterns');
    assert.doesNotMatch(JSON.stringify(body), /segredo-que-nao-vaza/);
});

test('consolidator-state.json ausente: metadata em null/0, sem erro', async () => {
    fs.rmSync(consolidatorStatePath, { force: true });
    const { status, body } = await get('/api/patterns');
    assert.strictEqual(status, 200);
    assert.strictEqual(body.lastConsolidationAt, null);
    assert.strictEqual(body.totalConsolidations, 0);
    assert.strictEqual(body.completedRunsAtLastRun, null);
});
