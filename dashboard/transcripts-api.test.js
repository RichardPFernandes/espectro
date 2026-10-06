// node --test transcripts-api.test.js
// GET /api/runs/:taskId/transcript/:nodeId — transcrição por nó gravada pelo watcher
// (scripts/lib/transcript-writer.js), fonte da aba "Transcrições" do detalhe do run.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tw = require('../scripts/lib/transcript-writer');

const tmpBase = process.env.CLAUDE_JOB_DIR ? path.join(process.env.CLAUDE_JOB_DIR, 'tmp') : os.tmpdir();
const tmp = fs.mkdtempSync(path.join(tmpBase, 'transcripts-api-'));
const mainRuns = path.join(tmp, 'memory', 'runs');
fs.mkdirSync(mainRuns, { recursive: true });

function seed(taskId, state) {
    const dir = path.join(mainRuns, taskId);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ task_id: taskId, history: [], ...state }));
    return dir;
}

const meta = status => ({ model: 'claude-opus-5-5', startedAt: '2026-09-29T10:00:00.000Z', finishedAt: '2026-09-29T10:02:00.000Z', tokenUsage: { input_tokens: 1, output_tokens: 2 }, status });

process.env.BITBUCKET_API_TOKEN = 'super-secreto-nao-pode-vazar';

const dir = seed('81001-transcricoes', { node: 'verify', status: 'in_progress', updated_at: '2026-09-29T10:00:00Z' });
tw.writeTranscriptSync('81001-transcricoes', 'implement', 1, [{ role: 'user', content: 'primeira', timestamp: '2026-09-29T10:00:00.000Z' }], meta('failed'), { taskDir: dir });
tw.writeTranscriptSync('81001-transcricoes', 'implement', 2,
    [{ role: 'assistant', content: 'vazou super-secreto-nao-pode-vazar', timestamp: '2026-09-29T10:01:00.000Z' }],
    meta('success'), { taskDir: dir, gzipThresholdBytes: 10 });

// Agente regravou state.json sem transcripts[] — endpoint cai no index.json.
const dirNoField = seed('81002-sem-campo', { node: 'review', status: 'in_progress', updated_at: '2026-09-29T10:00:00Z' });
tw.writeTranscriptSync('81002-sem-campo', 'review', 1, [{ role: 'assistant', content: 'ok', timestamp: null }], meta('success'), { taskDir: dirNoField });
const st = JSON.parse(fs.readFileSync(path.join(dirNoField, 'state.json'), 'utf8'));
delete st.transcripts;
fs.writeFileSync(path.join(dirNoField, 'state.json'), JSON.stringify(st));

// state.json adulterado apontando pra fora de transcripts/.
seed('81003-path-ruim', { node: 'plan', status: 'in_progress', transcripts: [{ nodeId: 'plan', attempt: 1, path: '../../../etc/passwd', sizeBytes: 1, status: 'success' }] });

const { createDashboard } = require('./server');
const dash = createDashboard({ memoryDir: mainRuns });
let base;

test.before(async () => {
    await new Promise(r => dash.server.listen(0, '127.0.0.1', r));
    base = `http://localhost:${dash.server.address().port}`;
    await dash.ready;
});
test.after(async () => {
    await dash.close();
    fs.rmSync(tmp, { recursive: true, force: true });
});

async function get(p) {
    const res = await fetch(base + p);
    return { status: res.status, body: await res.json() };
}

test('sem tentativa: devolve a última do nó (lê .json.gz) com secrets redigidos', async () => {
    const { status, body } = await get('/api/runs/81001-transcricoes/transcript/implement');
    assert.strictEqual(status, 200);
    assert.strictEqual(body.attempt, 2);
    assert.strictEqual(body.path, 'transcripts/implement-2.json.gz');
    assert.deepStrictEqual(body.attempts, [1, 2]);
    assert.strictEqual(body.metadata.status, 'success');
    assert.strictEqual(body.conversation[0].role, 'assistant');
    assert.ok(!body.conversation[0].content.includes('super-secreto-nao-pode-vazar'));
    assert.deepStrictEqual(body.metadata.tokenUsage, { input_tokens: 1, output_tokens: 2 });
});

test('tentativa específica via -N ou ?attempt=N; nó falho tem status failed', async () => {
    const a = await get('/api/runs/81001-transcricoes/transcript/implement-1');
    const b = await get('/api/runs/81001-transcricoes/transcript/implement?attempt=1');
    for (const r of [a, b]) {
        assert.strictEqual(r.status, 200);
        assert.strictEqual(r.body.attempt, 1);
        assert.strictEqual(r.body.metadata.status, 'failed');
        assert.deepStrictEqual(r.body.conversation, [{ role: 'user', content: 'primeira', timestamp: '2026-09-29T10:00:00.000Z' }]);
    }
});

test('detalhe do run expõe state.transcripts pra lista da aba', async () => {
    const { body } = await get('/api/runs/81001-transcricoes');
    assert.deepStrictEqual(body.state.transcripts.map(t => [t.nodeId, t.attempt, t.status]), [['implement', 1, 'failed'], ['implement', 2, 'success']]);
    assert.strictEqual(body.state.transcripts_total, 2);
});

test('fallback pro index.json quando state.json perdeu o campo', async () => {
    const { status, body } = await get('/api/runs/81002-sem-campo/transcript/review');
    assert.strictEqual(status, 200);
    assert.strictEqual(body.conversation[0].content, 'ok');
});

test('404 pra nó/tentativa sem transcrição; 400 pra nodeId ou path inválidos', async () => {
    assert.strictEqual((await get('/api/runs/81001-transcricoes/transcript/test')).status, 404);
    assert.strictEqual((await get('/api/runs/81001-transcricoes/transcript/implement-9')).status, 404);
    assert.strictEqual((await get('/api/runs/81001-transcricoes/transcript/..%2Fstate')).status, 400);
    assert.strictEqual((await get('/api/runs/81003-path-ruim/transcript/plan')).status, 400);
    assert.strictEqual((await get('/api/runs/99999-nao-existe/transcript/plan')).status, 404);
});
