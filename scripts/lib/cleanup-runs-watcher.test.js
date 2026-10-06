// node --test scripts/lib/cleanup-runs-watcher.test.js
// Rotação de runs no watcher: roda no startup depois do scan de órfãos, some com
// DISABLE_AUTO_CLEANUP=true, e mostRecentArchivedCommit continua enxergando o ticket
// depois que o run saiu de _archive/ pra memory/archive/<YYYY-MM>/ (senão um ticket já
// entregue seria redespachado). REPO_PATH sintético com git; Redmine inalcançável.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, execFileSync } = require('child_process');

const tmp = fs.mkdtempSync(path.join(process.env.CLAUDE_JOB_DIR ? path.join(process.env.CLAUDE_JOB_DIR, 'tmp') : os.tmpdir(), 'cleanup-watcher-'));
const repo = path.join(tmp, 'app-back');
const runs = path.join(repo, 'memory', 'runs');
fs.mkdirSync(runs, { recursive: true });
execFileSync('git', ['-C', repo, 'init', '-q']);
const WATCHER = path.join(__dirname, '..', 'readmine-watcher.js');

function seed(dir, taskId, state) {
    fs.mkdirSync(path.join(dir, taskId), { recursive: true });
    fs.writeFileSync(path.join(dir, taskId, 'state.json'), JSON.stringify({
        task_id: taskId, node: 'commit', history: ['fetch_ticket', 'plan', 'implement', 'review', 'test', 'verify', 'commit'], ...state,
    }, null, 2));
}
const OLD = new Date(Date.now() - 45 * 24 * 60 * 60 * 1000).toISOString();
seed(runs, '96001-velho', { status: 'committed', updated_at: OLD });
seed(runs, '96002-rodando', { status: 'running', updated_at: OLD, node: 'implement', node_started_at: new Date().toISOString(), agent_pid: process.pid });

function startWatcher(extraEnv) {
    const env = {
        ...process.env, REPO_PATH: repo, REDMINE_URL: 'http://127.0.0.1:9', REDMINE_API_KEY: 'chave-teste',
        REDMINE_RETRY_MAX_ATTEMPTS: '1', REDMINE_MIN_INTERVAL_MS: '0', BITBUCKET_API_TOKEN: '', ...extraEnv,
    };
    if (!('DISABLE_AUTO_CLEANUP' in extraEnv)) delete env.DISABLE_AUTO_CLEANUP;
    const r = spawnSync(process.execPath, [WATCHER, '--dry-run'], { env, encoding: 'utf8', timeout: 60000 });
    return `${r.stdout}\n${r.stderr}`;
}

test('startup: cleanup roda depois do scan de órfãos e nunca pega run "running"', () => {
    const out = startWatcher({});
    assert.match(out, /\[cleanup\] \[dry-run\] Arquivado run 96001-velho \(status: committed, age: 45d\)/, out);
    assert.doesNotMatch(out, /Arquivado run 96002-rodando/);
    assert.match(out, /\[cleanup\] \[dry-run\] 1 runs arquivados, 0 screenshots removidos/);
});

test('DISABLE_AUTO_CLEANUP=true: watcher sobe sem limpeza nenhuma', () => {
    const out = startWatcher({ DISABLE_AUTO_CLEANUP: 'true' });
    assert.doesNotMatch(out, /\[cleanup\]/, out);
    assert.ok(fs.existsSync(path.join(runs, '96001-velho')));
});

test('mostRecentArchivedCommit enxerga memory/archive/<YYYY-MM>/ (inclusive cópia com sufixo)', () => {
    process.env.REPO_PATH = repo;
    process.env.REDMINE_URL = 'http://127.0.0.1:9';
    const watcher = require('../readmine-watcher');
    assert.strictEqual(watcher.mostRecentArchivedCommit(96100), null);
    const archive = path.join(repo, 'memory', 'archive');
    seed(path.join(archive, '2026-07'), '96100-entrega', { status: 'committed', updated_at: '2026-07-10T00:00:00.000Z' });
    seed(path.join(archive, '2026-08'), '96100-entrega__wt-96100', { status: 'committed', updated_at: '2026-08-15T00:00:00.000Z' });
    seed(path.join(archive, 'lixo'), '96100-fora-do-padrao', { status: 'committed', updated_at: '2026-09-20T00:00:00.000Z' });
    assert.strictEqual(watcher.mostRecentArchivedCommit(96100), Date.parse('2026-08-15T00:00:00.000Z'));
    assert.strictEqual(watcher.latestRunForTicket(96100), null, 'Recusa QA não fica esperando botão de run que o dashboard não lista');
});
