// node --test scripts/lib/agent-log.test.js
// logRun/logPathFor (scripts/readmine-watcher.js) — linha [watcher] gravada no
// mesmo arquivo por onde passa a saída [claude] do agente (memory/runs/<ticketId>.log),
// consumido pelo dashboard (GET /api/runs/:taskId/agent-log[/stream]).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.REPO_PATH = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-log-repo-'));
const { logRun, logPathFor } = require('../readmine-watcher');

test('logRun grava linha [watcher] com timestamp ISO em memory/runs/<ticketId>.log', () => {
    const ticketId = '999999';
    logRun(ticketId, '[watcher]', 'iniciando nó plan');
    const content = fs.readFileSync(logPathFor(ticketId), 'utf8');
    assert.match(content, /^\d{4}-\d{2}-\d{2}T[\d:.]+Z \[watcher\] iniciando nó plan\n$/);
});

test('logRun acrescenta (append) sem apagar linhas anteriores', () => {
    const ticketId = '999998';
    logRun(ticketId, '[watcher]', 'primeira linha');
    logRun(ticketId, '[claude]', 'segunda linha');
    const lines = fs.readFileSync(logPathFor(ticketId), 'utf8').trim().split('\n');
    assert.strictEqual(lines.length, 2);
    assert.match(lines[0], /\[watcher\] primeira linha$/);
    assert.match(lines[1], /\[claude\] segunda linha$/);
});

test('logPathFor cria o diretório memory/runs se ainda não existir', () => {
    const runsDir = path.join(process.env.REPO_PATH, 'memory', 'runs');
    fs.rmSync(runsDir, { recursive: true, force: true });
    assert.ok(!fs.existsSync(runsDir));
    logPathFor('999997');
    assert.ok(fs.existsSync(runsDir));
});
