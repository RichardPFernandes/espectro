// node --test scripts/lib/transcript-writer.test.js
// Unidade de scripts/lib/transcript-writer.js + integração com o watcher: REPO_PATH e
// HOME sintéticos (nenhum transcript real do ~/.claude é lido) e um `claude` falso no
// PATH que escreve um transcript JSONL na sessão do --session-id, avança state.json e
// sai com o exit code de FAKE_EXIT — como um nó de verdade (ou um que quebrou).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');

const tw = require('./transcript-writer');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'transcript-writer-'));
test.after(() => fs.rmSync(root, { recursive: true, force: true }));

function newTaskDir(name, state = {}) {
    const dir = path.join(root, 'unit', name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ task_id: name, node: 'plan', status: 'in_progress', ...state }));
    return dir;
}

const meta = status => ({
    model: 'claude-opus-5-5', startedAt: '2026-09-29T10:00:00.000Z', finishedAt: '2026-09-29T10:01:00.000Z',
    tokenUsage: { input_tokens: 10, output_tokens: 5 }, status,
});

test('writeTranscript: cria transcripts/, grava <node>-<attempt>.json e espelha no state.json', async () => {
    const dir = newTaskDir('t-basico', { cost_tracking: { nodes: {} } });
    const entry = await tw.writeTranscript('t-basico', 'plan', 1,
        [{ role: 'user', content: 'oi', timestamp: '2026-09-29T10:00:00.000Z' }, { role: 'assistant', content: 'olá', timestamp: '2026-09-29T10:00:01.000Z' }],
        meta('success'), { taskDir: dir });

    assert.strictEqual(entry.path, 'transcripts/plan-1.json');
    assert.match(fs.readFileSync(path.join(dir, 'transcripts', '.gitignore'), 'utf8'), /^\*$/m, 'nunca versionado');
    const doc = tw.readTranscriptFile(path.join(dir, entry.path));
    assert.strictEqual(doc.metadata.status, 'success');
    assert.strictEqual(doc.metadata.model, 'claude-opus-5-5');
    assert.deepStrictEqual(doc.conversation[1], { role: 'assistant', content: 'olá', timestamp: '2026-09-29T10:00:01.000Z' });

    const state = JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'));
    assert.strictEqual(state.transcripts.length, 1);
    assert.deepStrictEqual(
        (({ nodeId, attempt, path: p, sizeBytes, status, tokenUsage }) => ({ nodeId, attempt, path: p, sizeBytes, status, tokenUsage }))(state.transcripts[0]),
        { nodeId: 'plan', attempt: 1, path: 'transcripts/plan-1.json', sizeBytes: fs.statSync(path.join(dir, entry.path)).size, status: 'success', tokenUsage: { input_tokens: 10, output_tokens: 5 } },
    );
    assert.strictEqual(state.transcripts_total, 1);
    assert.strictEqual(state.transcripts_size_bytes, entry.sizeBytes);
    assert.deepStrictEqual(state.cost_tracking, { nodes: {} }, 'demais campos preservados');
});

test('writeTranscript: attempt null = próxima tentativa; status inválido vira failed; sanitize aplicado', () => {
    const dir = newTaskDir('t-attempt');
    tw.writeTranscriptSync('t-attempt', 'implement', null, [], meta('success'), { taskDir: dir });
    const second = tw.writeTranscriptSync('t-attempt', 'implement', null,
        [{ role: 'tool', content: 'token=SEGREDO123' }], meta('???'), { taskDir: dir, sanitize: s => s.replace('SEGREDO123', '[REDACTED]') });
    assert.strictEqual(second.attempt, 2);
    assert.strictEqual(second.status, 'failed');
    const doc = tw.readTranscriptFile(path.join(dir, 'transcripts', 'implement-2.json'));
    assert.strictEqual(doc.conversation[0].content, 'token=[REDACTED]');
    assert.strictEqual(doc.conversation[0].timestamp, null);
    assert.strictEqual(tw.readIndex(dir).length, 2);
});

test('writeTranscript: acima do limiar grava .json.gz legível; limiar 0 nunca comprime', () => {
    const dir = newTaskDir('t-gzip');
    const big = [{ role: 'assistant', content: 'x'.repeat(5000), timestamp: null }];
    const gz = tw.writeTranscriptSync('t-gzip', 'review', 1, big, meta('failed'), { taskDir: dir, gzipThresholdBytes: 1000 });
    assert.strictEqual(gz.path, 'transcripts/review-1.json.gz');
    assert.strictEqual(gz.compressed, true);
    assert.ok(gz.sizeBytes < 5000);
    assert.doesNotThrow(() => zlib.gunzipSync(fs.readFileSync(path.join(dir, gz.path))));
    assert.strictEqual(tw.readTranscriptFile(path.join(dir, gz.path)).conversation[0].content.length, 5000);

    // Regravar a mesma tentativa sem compressão substitui a entrada e apaga o .gz.
    const plain = tw.writeTranscriptSync('t-gzip', 'review', 1, big, meta('failed'), { taskDir: dir, gzipThresholdBytes: 0 });
    assert.strictEqual(plain.path, 'transcripts/review-1.json');
    assert.ok(!fs.existsSync(path.join(dir, gz.path)));
    assert.strictEqual(tw.readIndex(dir).length, 1);

    assert.strictEqual(tw.gzipThresholdFromEnv({}), 100 * 1024);
    assert.strictEqual(tw.gzipThresholdFromEnv({ TRANSCRIPT_GZIP_THRESHOLD_BYTES: '0' }), 0);
    assert.strictEqual(tw.gzipThresholdFromEnv({ TRANSCRIPT_GZIP_THRESHOLD_BYTES: 'abc' }), 100 * 1024);
});

test('writeTranscript: rejeita nodeId/taskId com path traversal', async () => {
    const dir = newTaskDir('t-traversal');
    await assert.rejects(() => tw.writeTranscript('t-traversal', '../x', 1, [], meta('success'), { taskDir: dir }));
    await assert.rejects(() => tw.writeTranscript('t', 'plan', 1, [], meta('success'), {}), /taskDir/);
});

test('conversationFromClaudeJsonl: blocos viram {role, content, timestamp}; parcial é tolerado', () => {
    const main = [
        { type: 'user', timestamp: '2026-09-29T10:00:00.000Z', message: { role: 'user', content: 'Rode /plan' } },
        { type: 'assistant', timestamp: '2026-09-29T10:00:01.000Z', message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'preciso ler a spec' }] } },
        { type: 'assistant', timestamp: '2026-09-29T10:00:02.000Z', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Read', input: { file_path: 'a.java' } }] } },
        { type: 'user', timestamp: '2026-09-29T10:00:03.000Z', message: { role: 'user', content: [{ type: 'tool_result', is_error: true, content: [{ type: 'text', text: 'não existe' }] }] } },
        { type: 'attachment', timestamp: '2026-09-29T10:00:03.500Z' },
        { type: 'assistant', timestamp: '2026-09-29T10:00:06.000Z', isApiErrorMessage: true, message: { role: 'assistant', content: [{ type: 'text', text: 'API Error: 529' }] } },
    ].map(e => JSON.stringify(e)).join('\n') + '\n{"type":"assistant","timest'; // última linha truncada
    const sub = JSON.stringify({ type: 'assistant', timestamp: '2026-09-29T10:00:04.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'resultado do subagente' }] } });

    const r = tw.conversationFromClaudeJsonl([{ content: main, source: 'main' }, { content: sub, source: 'subagent:agent-1' }]);
    assert.strictEqual(r.skippedLines, 1);
    assert.strictEqual(r.apiError, true);
    assert.deepStrictEqual(r.conversation.map(m => [m.role, m.source]), [
        ['user', 'main'], ['assistant', 'main'], ['assistant', 'main'], ['tool', 'main'], ['assistant', 'subagent:agent-1'], ['assistant', 'main'],
    ]);
    assert.strictEqual(r.conversation[0].content, 'Rode /plan');
    assert.match(r.conversation[1].content, /^\[thinking\]\npreciso ler a spec/);
    assert.strictEqual(r.conversation[2].content, '[tool_use Read] {"file_path":"a.java"}');
    assert.strictEqual(r.conversation[3].content, '[tool_result ERRO] não existe');
    assert.strictEqual(r.conversation[5].apiError, true);

    assert.deepStrictEqual(tw.conversationFromClaudeJsonl([{ content: '', source: 'main' }]), { conversation: [], skippedLines: 0, apiError: false });
});

// ---------------------------------------------------------------------------------
// Integração com o watcher (despacho sem --follow + fechamento no tick seguinte).

const repo = path.join(root, 'app-back');
const home = path.join(root, 'home');
const binDir = path.join(root, 'bin');
fs.mkdirSync(repo, { recursive: true });
fs.mkdirSync(binDir, { recursive: true });
fs.mkdirSync(path.join(home, '.claude', 'projects'), { recursive: true });

fs.writeFileSync(path.join(binDir, 'claude'), `#!/usr/bin/env node
const fs = require('fs'), path = require('path');
const sid = process.argv[process.argv.indexOf('--session-id') + 1];
const dir = path.join(process.env.HOME, '.claude', 'projects', 'fake-project');
fs.mkdirSync(dir, { recursive: true });
const now = new Date().toISOString();
const lines = [
  { type: 'user', timestamp: now, message: { role: 'user', content: 'despacho do orquestrador' } },
  { type: 'assistant', timestamp: now, message: { id: 'm-' + sid, role: 'assistant', model: 'claude-sonnet-5',
    usage: { input_tokens: 10, output_tokens: 20 }, content: [{ type: 'text', text: 'feito no nó ' + process.env.FAKE_NEXT_NODE }] } },
];
fs.writeFileSync(path.join(dir, sid + '.jsonl'), lines.map(l => JSON.stringify(l)).join('\\n') + '\\n');
const stateFile = process.env.FAKE_STATE_FILE;
const s = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
delete s.transcripts; // agente que regrava state.json sem o campo — watcher tem que restaurar
if (process.env.FAKE_EXIT === '0') s.node = process.env.FAKE_NEXT_NODE;
fs.writeFileSync(stateFile, JSON.stringify(s));
process.exit(Number(process.env.FAKE_EXIT));
`, { mode: 0o755 });

process.env.REPO_PATH = repo;
process.env.SKIP_PRE_BUILD_VALIDATION = 'true';
process.env.HOME = home;
process.env.PATH = `${binDir}:${process.env.PATH}`;
global.fetch = async () => { throw new Error('fetch não deveria ser chamado neste teste'); };

const watcher = require('../readmine-watcher');

const TICKET_ID = 91001;
const TASK_ID = `${TICKET_ID}-transcricao`;
const taskDir = path.join(repo, '.claude', 'worktrees', String(TICKET_ID), 'memory', 'runs', TASK_ID);
const ticket = {
    id: TICKET_ID, subject: 'teste transcrição', status: { name: 'Em Desenvolvimento' }, tracker: { name: 'Melhoria' },
    custom_fields: [{ name: 'Branch Liberação', value: 'Dev - Local' }],
};

async function waitFor(cond, ms = 10000) {
    const until = Date.now() + ms;
    while (!cond()) {
        if (Date.now() > until) throw new Error('timeout esperando condição');
        await new Promise(r => setTimeout(r, 25));
    }
}

const readState = () => JSON.parse(fs.readFileSync(path.join(taskDir, 'state.json'), 'utf8'));

test('watcher: ciclo de 4 nós gera 4 transcrições; nó que falhou fica status failed', async () => {
    fs.mkdirSync(taskDir, { recursive: true });
    fs.writeFileSync(path.join(taskDir, 'state.json'), JSON.stringify({
        task_id: TASK_ID, node: 'implement', history: [], status: 'in_progress', started_at: '2026-09-29T10:00:00.000Z', updated_at: '2026-09-29T10:00:00.000Z',
    }));
    process.env.FAKE_STATE_FILE = path.join(taskDir, 'state.json');

    const sequence = [['implement', 'review', '0'], ['review', 'test', '0'], ['test', 'verify', '0'], ['verify', 'commit', '1']];
    for (const [expected, next, exit] of sequence) {
        process.env.FAKE_NEXT_NODE = next;
        process.env.FAKE_EXIT = exit;
        const res = await watcher.dispatchTicket(ticket);
        assert.strictEqual(res.node, expected);
        const [pending] = watcher.readCostLedger(TICKET_ID).pending;
        await waitFor(() => { try { process.kill(pending.pid, 0); return false; } catch { return true; } });
        // Saída registrada pelo wrapper (release do lease) antes do fechamento.
        await waitFor(() => (readState().events || []).some(e => e.node === expected && ['node_end', 'node_error'].includes(e.type)));
        watcher.finalizePendingCostRuns();
    }

    const files = fs.readdirSync(path.join(taskDir, 'transcripts')).filter(f => !['index.json', '.gitignore'].includes(f)).sort();
    assert.deepStrictEqual(files, ['implement-1.json', 'review-1.json', 'test-1.json', 'verify-1.json']);

    const state = readState();
    assert.strictEqual(state.transcripts_total, 4);
    assert.deepStrictEqual(state.transcripts.map(t => [t.nodeId, t.status]),
        [['implement', 'success'], ['review', 'success'], ['test', 'success'], ['verify', 'failed']]);
    for (const t of state.transcripts) {
        assert.strictEqual(t.sizeBytes, fs.statSync(path.join(taskDir, t.path)).size);
        assert.strictEqual(t.tokenUsage.output_tokens, 20);
    }
    assert.strictEqual(state.transcripts_size_bytes, state.transcripts.reduce((a, t) => a + t.sizeBytes, 0));

    const failed = tw.readTranscriptFile(path.join(taskDir, 'transcripts', 'verify-1.json'));
    assert.strictEqual(failed.metadata.status, 'failed');
    assert.strictEqual(failed.metadata.agent, 'claude');
    assert.deepStrictEqual(failed.metadata.models, ['claude-sonnet-5']);
    assert.deepStrictEqual(failed.conversation.map(m => m.role), ['user', 'assistant']);
    assert.strictEqual(failed.conversation[1].content, 'feito no nó commit');
});

test('watcher: exceção no writer é logada e não derruba o fechamento do custo', () => {
    const original = tw.writeTranscriptSync;
    tw.writeTranscriptSync = () => { throw new Error('disco cheio'); };
    const errors = [];
    const origErr = console.error;
    console.error = (...a) => errors.push(a.join(' '));
    try {
        const run = watcher.startCostRun(TICKET_ID, { agent: 'claude', nodes: ['commit'], sessionId: 'sem-transcript' });
        assert.doesNotThrow(() => watcher.finishCostRun(TICKET_ID, 'sem-transcript', run.started_at_ms + 10, { exitCode: 0 }));
    } finally {
        tw.writeTranscriptSync = original;
        console.error = origErr;
    }
    assert.ok(errors.some(e => e.includes('[transcript]') && e.includes('disco cheio')));
    assert.strictEqual(readState().cost_tracking.nodes.commit.runs, 1, 'custo fechado mesmo com o writer quebrado');
});

test('transcriptStatus: exit code, eventos do nó e erro de API', () => {
    const run = { started_at_ms: Date.parse('2026-09-29T10:00:00.000Z') };
    const ev = (type, ts = '2026-09-29T10:00:05.000Z', node = 'test') => ({ type, node, ts });
    assert.strictEqual(watcher.transcriptStatus(run, 'test', { events: [ev('node_end')] }, {}, false), 'success');
    assert.strictEqual(watcher.transcriptStatus(run, 'test', { events: [ev('node_end'), ev('escalation')] }, {}, false), 'failed');
    assert.strictEqual(watcher.transcriptStatus(run, 'test', { events: [ev('node_error', '2026-09-28T10:00:00.000Z')] }, {}, false), 'failed', 'sem evidência deste despacho');
    assert.strictEqual(watcher.transcriptStatus(run, 'test', { events: [ev('node_end')] }, {}, true), 'failed');
    assert.strictEqual(watcher.transcriptStatus(run, 'test', null, { exitCode: 0 }, false), 'success');
    assert.strictEqual(watcher.transcriptStatus(run, 'test', null, { exitCode: 2 }, false), 'failed');
});
