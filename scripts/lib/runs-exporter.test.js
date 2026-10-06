// node --test scripts/lib/runs-exporter.test.js
// Export agregado de memory/runs/ (scripts/export-runs.js) contra um repo sintético em
// tmpdir — nunca contra o memory/runs/ real do checkout.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { exportRuns, parseTestResults, contextMeta } = require('./runs-exporter');

function tmpRepo() {
    const base = process.env.CLAUDE_JOB_DIR ? path.join(process.env.CLAUDE_JOB_DIR, 'tmp') : os.tmpdir();
    return fs.mkdtempSync(path.join(base, 'runs-exporter-'));
}

function writeRun(repo, taskId, state, { archived = false, context, testResults } = {}) {
    const dir = path.join(repo, 'memory', 'runs', ...(archived ? ['_archive', taskId] : [taskId]));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify(state));
    if (context != null) fs.writeFileSync(path.join(dir, 'context.md'), context);
    if (testResults != null) fs.writeFileSync(path.join(dir, 'test-results.md'), testResults);
    return dir;
}

function baseState(overrides = {}) {
    return {
        task_id: overrides.task_id || 'x',
        node: 'commit',
        status: 'completed',
        history: ['plan', 'implement', 'review', 'test', 'verify', 'commit'],
        started_at: '2026-09-01T10:00:00Z',
        updated_at: '2026-09-01T12:00:00Z',
        ...overrides,
    };
}

test('exportRuns conta 20 runs reais como 20 entradas', async () => {
    const repo = tmpRepo();
    for (let i = 0; i < 20; i++) {
        writeRun(repo, `task-${i}`, baseState({ task_id: `task-${i}` }));
    }
    const { report, warnings } = await exportRuns({ repoPath: repo });
    assert.strictEqual(report.runs.length, 20);
    assert.strictEqual(report.summary.totalRuns, 20);
    assert.strictEqual(warnings.length, 0);
});

test('exportRuns inclui runs de _archive/ junto dos ativos', async () => {
    const repo = tmpRepo();
    writeRun(repo, 'ativo-1', baseState({ task_id: 'ativo-1' }));
    writeRun(repo, 'arquivado-1', baseState({ task_id: 'arquivado-1' }), { archived: true });
    const { report } = await exportRuns({ repoPath: repo });
    assert.strictEqual(report.runs.length, 2);
    const ids = report.runs.map(r => r.taskId).sort();
    assert.deepStrictEqual(ids, ['arquivado-1', 'ativo-1']);
    assert.strictEqual(report.runs.find(r => r.taskId === 'arquivado-1').archived, true);
    assert.strictEqual(report.runs.find(r => r.taskId === 'ativo-1').archived, false);
});

test('exportRuns pula state.json malformado com aviso, sem derrubar o export', async () => {
    const repo = tmpRepo();
    writeRun(repo, 'valido', baseState({ task_id: 'valido' }));
    const badDir = path.join(repo, 'memory', 'runs', 'quebrado');
    fs.mkdirSync(badDir, { recursive: true });
    fs.writeFileSync(path.join(badDir, 'state.json'), '{ isto não é json');

    const { report, warnings } = await exportRuns({ repoPath: repo });
    assert.strictEqual(report.runs.length, 1);
    assert.strictEqual(report.runs[0].taskId, 'valido');
    assert.strictEqual(warnings.length, 1);
    assert.match(warnings[0], /quebrado/);
});

test('summary.failuresByNode conta por nó de falha', async () => {
    const repo = tmpRepo();
    writeRun(repo, 'ok-1', baseState({ task_id: 'ok-1', status: 'completed' }));
    writeRun(repo, 'falha-review-1', baseState({ task_id: 'falha-review-1', status: 'escalated', node: 'review' }));
    writeRun(repo, 'falha-review-2', baseState({ task_id: 'falha-review-2', status: 'blocked', node: 'review' }));
    writeRun(repo, 'falha-test-1', baseState({ task_id: 'falha-test-1', status: 'needs_human_review', node: 'test' }));

    const { report } = await exportRuns({ repoPath: repo });
    assert.deepStrictEqual(report.summary.failuresByNode, { review: 2, test: 1 });
});

test('summary.successRate = completed / total', async () => {
    const repo = tmpRepo();
    writeRun(repo, 'a', baseState({ task_id: 'a', status: 'completed' }));
    writeRun(repo, 'b', baseState({ task_id: 'b', status: 'completed' }));
    writeRun(repo, 'c', baseState({ task_id: 'c', status: 'escalated', node: 'test' }));
    const { report } = await exportRuns({ repoPath: repo });
    assert.strictEqual(report.summary.successRate, 2 / 3);
});

test('avgTokensPerCycle vem da média de tokenUsage.totals (input+output)', async () => {
    const repo = tmpRepo();
    writeRun(repo, 'a', baseState({
        task_id: 'a',
        cost_tracking: { totals: { input_tokens: 100, output_tokens: 20, duration_ms: 1000 } },
    }));
    writeRun(repo, 'b', baseState({
        task_id: 'b',
        cost_tracking: { totals: { input_tokens: 300, output_tokens: 80, duration_ms: 2000 } },
    }));
    const { report } = await exportRuns({ repoPath: repo });
    // (100+20 + 300+80) / 2 = 250
    assert.strictEqual(report.summary.avgTokensPerCycle, 250);
    const a = report.runs.find(r => r.taskId === 'a');
    assert.strictEqual(a.tokenUsage.totals.inputTokens, 100);
    assert.strictEqual(a.durationMs, 1000);
});

test('tokenUsage cai pro fallback memory/runs/<ticket>-cost.json quando state.json não tem cost_tracking', async () => {
    const repo = tmpRepo();
    writeRun(repo, '43578-alguma-task', baseState({ task_id: '43578-alguma-task' }));
    fs.writeFileSync(path.join(repo, 'memory', 'runs', '43578-cost.json'), JSON.stringify({
        tasks: { '43578-alguma-task': { totals: { input_tokens: 500, output_tokens: 50, duration_ms: 3000 } } },
    }));
    const { report } = await exportRuns({ repoPath: repo });
    const run = report.runs[0];
    assert.strictEqual(run.tokenUsage.totals.inputTokens, 500);
    assert.strictEqual(run.tokenUsage.totals.outputTokens, 50);
});

test('nunca inclui conteúdo de context.md — só metadados', async () => {
    const repo = tmpRepo();
    writeRun(repo, 'a', baseState({ task_id: 'a' }), {
        context: '## Ticket\nsegredo-nao-pode-vazar\n\n## Diagnóstico\ntexto\n\n## Critérios de aceite\nmais texto\n',
    });
    const { report } = await exportRuns({ repoPath: repo });
    const json = JSON.stringify(report);
    assert.ok(!json.includes('segredo-nao-pode-vazar'));
    const meta = report.runs[0].contextMeta;
    assert.deepStrictEqual(meta.sections, ['Ticket', 'Diagnóstico', 'Critérios de aceite']);
    assert.ok(meta.sizeBytes > 0);
    assert.ok(meta.wordCount > 0);
});

test('testResult lê passed/failed/total de test-results.md', async () => {
    const repo = tmpRepo();
    writeRun(repo, 'a', baseState({ task_id: 'a' }), { testResults: 'Passed: 12\nFailed: 3\nTotal: 15\n' });
    writeRun(repo, 'b', baseState({ task_id: 'b' })); // sem test-results.md
    const { report } = await exportRuns({ repoPath: repo });
    const a = report.runs.find(r => r.taskId === 'a');
    const b = report.runs.find(r => r.taskId === 'b');
    assert.deepStrictEqual(a.testResult, { passed: 12, failed: 3, total: 15 });
    assert.strictEqual(b.testResult, null);
});

test('parseTestResults deriva total quando ausente', () => {
    assert.deepStrictEqual(parseTestResults('passou: 4\nfalhou: 1'), { passed: 4, failed: 1, total: 5 });
    assert.strictEqual(parseTestResults('nada relevante aqui'), null);
});

test('contextMeta retorna null quando context.md não existe', () => {
    const repo = tmpRepo();
    const dir = path.join(repo, 'sem-context');
    fs.mkdirSync(dir, { recursive: true });
    assert.strictEqual(contextMeta(dir), null);
});

test('--since filtra por started_at', async () => {
    const repo = tmpRepo();
    writeRun(repo, 'antigo', baseState({ task_id: 'antigo', started_at: '2026-01-01T00:00:00Z' }));
    writeRun(repo, 'recente', baseState({ task_id: 'recente', started_at: '2026-09-20T00:00:00Z' }));
    const { report } = await exportRuns({ repoPath: repo, since: '2026-06-01' });
    assert.deepStrictEqual(report.runs.map(r => r.taskId), ['recente']);
});

test('--since inválido lança erro claro', async () => {
    const repo = tmpRepo();
    await assert.rejects(() => exportRuns({ repoPath: repo, since: 'not-a-date' }), /--since inválido/);
});

test('--incremental só exporta runs modificados desde o cursor, e grava o cursor novo', async () => {
    const repo = tmpRepo();
    const cursorPath = path.join(repo, 'memory', '.runs-export-cursor.json');
    writeRun(repo, 'ja-exportado', baseState({ task_id: 'ja-exportado' }));

    const first = await exportRuns({ repoPath: repo, incremental: true, cursorPath });
    assert.strictEqual(first.report.runs.length, 1);
    assert.ok(fs.existsSync(cursorPath));

    await new Promise(r => setTimeout(r, 20));
    writeRun(repo, 'novo-depois-do-cursor', baseState({ task_id: 'novo-depois-do-cursor' }));

    const second = await exportRuns({ repoPath: repo, incremental: true, cursorPath });
    assert.deepStrictEqual(second.report.runs.map(r => r.taskId), ['novo-depois-do-cursor']);
});

test('replayOf é propagado do state.json quando presente', async () => {
    const repo = tmpRepo();
    const replayOf = { originalRun: 'orig-1', fromNode: 'test', replayedAt: '2026-09-01T00:00:00Z' };
    writeRun(repo, 'orig-1-replay-1', baseState({ task_id: 'orig-1-replay-1', replayOf }));
    const { report } = await exportRuns({ repoPath: repo });
    assert.deepStrictEqual(report.runs[0].replayOf, replayOf);
});
