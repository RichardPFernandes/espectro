// node --test scripts/probes/plan-cache-probe.test.js
// Só as partes puras do probe da PRI-315 (nenhuma chamada ao provider).
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const { probeArgv, toolOutcome, denyVerdict, stats, parseArgs } = require('./plan-cache-probe');

const PRISMA_ROOT = path.resolve(__dirname, '..', '..');
const fixed = argv => argv.slice(argv.indexOf('--permission-mode'));

test('argv do probe = trecho fixo do despacho do plan (mesmo golden do watcher)', () => {
    assert.deepStrictEqual(fixed(probeArgv({ prompt: 'x', nodes: ['plan'], denySettings: false, sessionId: 's' })), [
        '--permission-mode', 'acceptEdits', '--allowedTools', 'mcp__redmine__*,Read,Edit,Write,Bash,Grep,Glob',
        '--disallowedTools', 'Agent,Task', '--add-dir', PRISMA_ROOT,
    ]);
    assert.deepStrictEqual(fixed(probeArgv({ prompt: 'x', nodes: ['plan'], denySettings: true, sessionId: 's' })), [
        '--permission-mode', 'acceptEdits', '--allowedTools', 'mcp__redmine__*,Read,Edit,Write,Bash,Grep,Glob',
        '--settings', '{"permissions":{"deny":["Agent","Task"]}}', '--add-dir', PRISMA_ROOT,
    ]);
    // Aquecimento: argv de nó sem bloqueio — mesma lista de ferramentas que o braço B.
    assert.deepStrictEqual(fixed(probeArgv({ prompt: 'x', nodes: ['review'], denySettings: false, sessionId: 's' })), [
        '--permission-mode', 'acceptEdits', '--allowedTools', 'mcp__redmine__*,Read,Edit,Write,Bash,Grep,Glob',
        '--add-dir', PRISMA_ROOT,
    ]);
});

test('toolOutcome conta tool_use de Agent/Task, recusas e transcripts de subagente', () => {
    const lines = [
        { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Agent' }] } },
        { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', is_error: true, content: 'Permission to use Agent has been denied.' }] } },
        { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't2', name: 'Task' }] } },
        { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't2', is_error: true, content: [{ type: 'text', text: 'denied' }] }] } },
    ].map(l => JSON.stringify(l)).join('\n');
    const o = toolOutcome({ contents: [{ content: lines }], files: ['main.jsonl'] });
    assert.strictEqual(o.subagent_tool_uses, 2);
    assert.strictEqual(o.subagent_transcripts, 0);
    assert.ok(o.subagent_results.every(r => r.is_error && r.permission_denied));
    assert.strictEqual(toolOutcome({ contents: [{ content: lines }], files: ['main', 'sub'] }).subagent_transcripts, 1);
    assert.strictEqual(denyVerdict({ files: ['main'] }, o), 'REFUSED');
    assert.strictEqual(denyVerdict({ files: ['main', 'sub'] }, { ...o, subagent_transcripts: 1 }), 'SUBAGENT_OPENED');
});

test('denyVerdict: sem transcript ou sem tentativa nunca vira aprovação', () => {
    const none = { subagent_tool_uses: 0, subagent_results: [], subagent_transcripts: 0 };
    assert.strictEqual(denyVerdict({ files: [] }, none), 'NO_TRANSCRIPT');
    assert.strictEqual(denyVerdict({ files: ['main'] }, none), 'NOT_ATTEMPTED');
    assert.strictEqual(denyVerdict({ files: ['main'] }, { subagent_tool_uses: 1, subagent_results: [{ is_error: false }], subagent_transcripts: 0 }), 'SUBAGENT_OPENED');
    assert.strictEqual(denyVerdict({ files: ['main'] }, { subagent_tool_uses: 2, subagent_results: [{ is_error: true }], subagent_transcripts: 0 }), 'INCONCLUSIVE');
    // Erro que não é de permissão (ex.: input inválido) não prova a recusa.
    assert.strictEqual(denyVerdict({ files: ['main'] }, { subagent_tool_uses: 1, subagent_results: [{ is_error: true, permission_denied: false }], subagent_transcripts: 0 }), 'INCONCLUSIVE');
});

test('stats ignora null; parseArgs valida modo e --out', () => {
    assert.deepStrictEqual(stats([3, null, 1, 2]), { n: 3, median: 2, min: 1, max: 3 });
    assert.deepStrictEqual(stats([null]), { n: 0, median: null, min: null, max: null });
    assert.throws(() => parseArgs(['x', '--out', 'd']), /modo/);
    assert.throws(() => parseArgs(['measure']), /--out/);
    assert.strictEqual(parseArgs(['measure', '--n', '2', '--out', 'd']).n, 2);
});
