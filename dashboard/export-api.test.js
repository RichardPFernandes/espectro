// node --test export-api.test.js
// GET /api/export: relatório JSON agregado de memory/runs/ (scripts/lib/runs-exporter.js),
// exposto com Content-Disposition: attachment pro botão "⬇ Exportar Relatório" do header.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpBase = process.env.CLAUDE_JOB_DIR ? path.join(process.env.CLAUDE_JOB_DIR, 'tmp') : os.tmpdir();
const tmp = fs.mkdtempSync(path.join(tmpBase, 'export-api-'));
const repo = path.join(tmp, 'app-back');
const mainRuns = path.join(repo, 'memory', 'runs');
fs.mkdirSync(mainRuns, { recursive: true });

function writeRun(taskId, state) {
    const dir = path.join(mainRuns, taskId);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify(state));
}

writeRun('43000-exemplo', {
    task_id: '43000-exemplo', node: 'commit', status: 'completed',
    history: ['plan', 'implement', 'review', 'test', 'verify', 'commit'],
    started_at: '2026-09-01T10:00:00Z', updated_at: '2026-09-01T12:00:00Z',
});

const { createDashboard } = require('./server');
const dash = createDashboard({ memoryDir: mainRuns });
let base;

test.before(async () => {
    await new Promise(r => dash.server.listen(0, '127.0.0.1', r));
    base = `http://localhost:${dash.server.address().port}`;
    await dash.ready;
});
test.after(() => { dash.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

test('GET /api/export devolve o relatório com Content-Disposition: attachment', async () => {
    const res = await fetch(base + '/api/export');
    assert.strictEqual(res.status, 200);
    assert.match(res.headers.get('content-disposition') || '', /^attachment; filename="runs-report-\d{4}-\d{2}-\d{2}\.json"$/);
    assert.match(res.headers.get('content-type') || '', /application\/json/);
    const body = await res.json();
    assert.strictEqual(body.version, 1);
    assert.strictEqual(body.summary.totalRuns, 1);
    assert.strictEqual(body.runs[0].taskId, '43000-exemplo');
});

test('GET /api/export?pretty=1 indenta o JSON', async () => {
    const res = await fetch(base + '/api/export?pretty=1');
    const text = await res.text();
    assert.ok(text.startsWith('{\n    '));
});

test('GET /api/export?since= filtra por data', async () => {
    const res = await fetch(base + '/api/export?since=2030-01-01');
    const body = await res.json();
    assert.strictEqual(body.summary.totalRuns, 0);
});
