// node --test scripts/cleanup-runs.test.js
// Rotação de runs (scripts/cleanup-runs.js): política por status/idade, runs protegidos,
// screenshots, versionados no git, registro do dashboard, colisão e idempotência.
// Repo sintético com git de verdade (o script pergunta ao git o que é versionado).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { runCleanup, retentionFromEnv } = require('./cleanup-runs');

const tmpBase = process.env.CLAUDE_JOB_DIR ? path.join(process.env.CLAUDE_JOB_DIR, 'tmp') : os.tmpdir();
const NOW = Date.parse('2026-09-29T12:00:00Z');
const DAY = 24 * 60 * 60 * 1000;
const ago = days => new Date(NOW - days * DAY).toISOString();
const quiet = () => {};

function git(dir, ...args) {
    execFileSync('git', ['-C', dir, ...args], { stdio: 'ignore' });
}
function newRepo() {
    const repo = path.join(fs.mkdtempSync(path.join(tmpBase, 'cleanup-runs-')), 'app-back');
    fs.mkdirSync(path.join(repo, 'memory', 'runs'), { recursive: true });
    git(repo, 'init', '-q');
    return repo;
}
function seed(runsDir, taskId, state) {
    const dir = path.join(runsDir, taskId);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ task_id: taskId, node: 'commit', history: [], ...state }));
    fs.writeFileSync(path.join(dir, 'context.md'), '# ctx\n');
    return dir;
}
function shot(runDir, sub, name, daysOld) {
    const p = path.join(runDir, sub, name);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, 'png');
    const t = (NOW - daysOld * DAY) / 1000;
    fs.utimesSync(p, t, t);
    return p;
}
const run = (repo, extra = {}) => runCleanup({ repoRoot: repo, now: NOW, env: {}, log: quiet, ...extra });
const archived = (repo, month, name) => path.join(repo, 'memory', 'archive', month, name);

test('política: terminal > 30d e erro > 90d vão pra memory/archive/<YYYY-MM>/; o resto fica', () => {
    const repo = newRepo();
    const runs = path.join(repo, 'memory', 'runs');
    seed(runs, '1-velho', { status: 'committed', updated_at: ago(45) });
    seed(runs, '2-recente', { status: 'committed', updated_at: ago(10) });
    seed(runs, '3-merged', { status: 'fully_merged', updated_at: ago(31) });
    seed(runs, '4-cancelado', { status: 'cancelled', updated_at: ago(31) });
    seed(runs, '5-escalado-60', { status: 'escalated', updated_at: ago(60) });
    seed(runs, '6-escalado-100', { status: 'escalated', updated_at: ago(100) });
    seed(runs, '7-corrompido', { status: 'state_corrupted', updated_at: ago(95) });
    seed(runs, '8-rodando', { status: 'running', updated_at: ago(400) });
    seed(runs, '9-humano', { status: 'needs_human_review', updated_at: ago(400) });
    seed(runs, '10-andando', { status: 'in_progress', updated_at: ago(400) });
    seed(runs, '11-bloqueado', { status: 'blocked', updated_at: ago(400) });
    seed(runs, '12-sem-updated', { status: 'committed', node_started_at: ago(40) });
    seed(runs, '13-sem-data', { status: 'committed' });
    fs.mkdirSync(path.join(runs, '14-sem-state'));
    fs.mkdirSync(path.join(runs, '15-json-quebrado'));
    fs.writeFileSync(path.join(runs, '15-json-quebrado', 'state.json'), '{nope');

    const s = run(repo);
    const moved = s.archived.map(a => a.taskId).sort();
    assert.deepStrictEqual(moved, ['1-velho', '12-sem-updated', '3-merged', '4-cancelado', '6-escalado-100', '7-corrompido']);
    assert.ok(fs.existsSync(path.join(archived(repo, ago(45).slice(0, 7), '1-velho'), 'context.md')), 'pasta inteira movida');
    assert.ok(!fs.existsSync(path.join(runs, '1-velho')));
    for (const stays of ['2-recente', '5-escalado-60', '8-rodando', '9-humano', '10-andando', '11-bloqueado', '13-sem-data', '14-sem-state', '15-json-quebrado']) {
        assert.ok(fs.existsSync(path.join(runs, stays)), `${stays} deveria ficar em memory/runs`);
    }
    assert.deepStrictEqual(s.errors, []);
});

test('idempotente: segunda rodada não move nada nem dá erro', () => {
    const repo = newRepo();
    seed(path.join(repo, 'memory', 'runs'), '1-velho', { status: 'committed', updated_at: ago(45) });
    assert.strictEqual(run(repo).archived.length, 1);
    const again = run(repo);
    assert.strictEqual(again.archived.length, 0);
    assert.deepStrictEqual(again.errors, []);
});

test('_archive/ também rotaciona; arquivado pelo dashboard fica (Restaurar depende do caminho)', () => {
    const repo = newRepo();
    const arch = path.join(repo, 'memory', 'runs', '_archive');
    seed(arch, '20-commitado', { status: 'committed', updated_at: ago(40) });
    seed(arch, '21-pelo-dashboard', { status: 'committed', updated_at: ago(40) });
    fs.writeFileSync(path.join(arch, 'dashboard-archived.json'), JSON.stringify({ '21-pelo-dashboard': { archived_at: ago(35) } }));
    const s = run(repo);
    assert.deepStrictEqual(s.archived.map(a => a.taskId), ['20-commitado']);
    assert.ok(fs.existsSync(path.join(arch, '21-pelo-dashboard')));
    assert.ok(fs.existsSync(path.join(arch, 'dashboard-archived.json')));
});

test('worktree: run versionado no git fica; não versionado vai pro archive do checkout principal', () => {
    const repo = newRepo();
    const wt = path.join(repo, '.claude', 'worktrees', '43000');
    const wtRuns = path.join(wt, 'memory', 'runs');
    fs.mkdirSync(wtRuns, { recursive: true });
    git(wt, 'init', '-q');
    seed(wtRuns, '43000-versionado', { status: 'committed', updated_at: ago(60) });
    seed(path.join(wtRuns, '_archive'), '43000-versionado-arq', { status: 'committed', updated_at: ago(60) });
    git(wt, 'add', '-f', 'memory');
    git(wt, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'legado');
    seed(wtRuns, '43000-solto', { status: 'committed', updated_at: ago(60) });

    const s = run(repo);
    assert.deepStrictEqual(s.archived.map(a => a.taskId), ['43000-solto']);
    assert.strictEqual(s.skippedTracked, 2);
    assert.ok(fs.existsSync(archived(repo, ago(60).slice(0, 7), '43000-solto')));
    assert.ok(fs.existsSync(path.join(wtRuns, '43000-versionado')));
    assert.ok(!fs.existsSync(path.join(wt, 'memory', 'archive')), 'nada vai pro archive do worktree (é apagado no merge)');
});

test('checkout sem git: não mexe em nada dele', () => {
    const repo = newRepo();
    const wt = path.join(repo, '.claude', 'worktrees', '43001');
    const wtRuns = path.join(wt, 'memory', 'runs');
    // .git apontando pra lugar nenhum: `git ls-files` falha nesse checkout.
    fs.mkdirSync(wtRuns, { recursive: true });
    fs.writeFileSync(path.join(wt, '.git'), 'gitdir: /caminho/que/nao/existe\n');
    seed(wtRuns, '43001-x', { status: 'committed', updated_at: ago(60) });
    const s = run(repo);
    assert.strictEqual(s.archived.length, 0);
    assert.ok(fs.existsSync(path.join(wtRuns, '43001-x')));
});

test('mesmo task-id em dois checkouts: o segundo ganha sufixo, nada é sobrescrito', () => {
    const repo = newRepo();
    const wt = path.join(repo, '.claude', 'worktrees', '43002');
    fs.mkdirSync(path.join(wt, 'memory', 'runs'), { recursive: true });
    git(wt, 'init', '-q');
    seed(path.join(repo, 'memory', 'runs'), '43002-dup', { status: 'committed', updated_at: ago(40), marca: 'main' });
    seed(path.join(wt, 'memory', 'runs'), '43002-dup', { status: 'committed', updated_at: ago(40), marca: 'wt' });
    const s = run(repo);
    assert.strictEqual(s.archived.length, 2);
    const month = ago(40).slice(0, 7);
    const marca = name => JSON.parse(fs.readFileSync(path.join(archived(repo, month, name), 'state.json'), 'utf8')).marca;
    assert.strictEqual(marca('43002-dup'), 'main');
    assert.strictEqual(marca('43002-dup__wt-43002'), 'wt');
});

test('screenshots: > 14d apagados em browser*/ e screenshots/, novos ficam, run protegido intocado', () => {
    const repo = newRepo();
    const runs = path.join(repo, 'memory', 'runs');
    const ativo = seed(runs, '30-ativo', { status: 'in_progress', updated_at: ago(1) });
    const velho = shot(ativo, 'browser-test', 'a.png', 20);
    const aninhado = shot(ativo, 'browser/passo-1', 'b.png', 20);
    const novo = shot(ativo, 'browser-test', 'c.png', 3);
    const legado = shot(ativo, 'screenshots', 'd.png', 30);
    const fora = shot(ativo, 'outros', 'e.png', 30);
    const rodando = seed(runs, '31-rodando', { status: 'running', updated_at: ago(1) });
    const protegido = shot(rodando, 'browser-test', 'f.png', 30);

    const s = run(repo);
    assert.strictEqual(s.screenshotsRemoved, 3);
    for (const gone of [velho, aninhado, legado]) assert.ok(!fs.existsSync(gone), `${gone} deveria sumir`);
    for (const kept of [novo, fora, protegido]) assert.ok(fs.existsSync(kept), `${kept} deveria ficar`);
    assert.ok(!fs.existsSync(path.join(ativo, 'browser', 'passo-1')), 'subpasta vazia removida');
    assert.ok(fs.existsSync(path.join(ativo, 'state.json')));
});

test('--dry-run: só relata', () => {
    const repo = newRepo();
    const runs = path.join(repo, 'memory', 'runs');
    const dir = seed(runs, '40-velho', { status: 'committed', updated_at: ago(45) });
    const img = shot(dir, 'browser', 'x.png', 20);
    const lines = [];
    const s = run(repo, { dryRun: true, log: l => lines.push(l) });
    assert.strictEqual(s.archived.length, 1);
    assert.strictEqual(s.screenshotsRemoved, 1);
    assert.ok(fs.existsSync(dir) && fs.existsSync(img));
    assert.ok(!fs.existsSync(path.join(repo, 'memory', 'archive')));
    assert.ok(lines.some(l => /\[dry-run\] Arquivado run 40-velho \(status: committed, age: 45d\)/.test(l)), lines.join('\n'));
    assert.ok(lines.some(l => /1 runs arquivados, 1 screenshots removidos/.test(l)));
});

test('retenção via env; valor inválido cai no padrão', () => {
    assert.deepStrictEqual(retentionFromEnv({}), { runsDays: 30, errorDays: 90, screenshotsDays: 14 });
    const warn = console.warn;
    console.warn = quiet;
    try {
        assert.deepStrictEqual(
            retentionFromEnv({ RUNS_RETENTION_DAYS: '7', RUNS_ERROR_RETENTION_DAYS: 'abc', SCREENSHOTS_RETENTION_DAYS: '-1' }),
            { runsDays: 7, errorDays: 90, screenshotsDays: 14 });
    } finally { console.warn = warn; }
    const repo = newRepo();
    seed(path.join(repo, 'memory', 'runs'), '50-dez-dias', { status: 'committed', updated_at: ago(10) });
    assert.strictEqual(run(repo, { env: { RUNS_RETENTION_DAYS: '7' } }).archived.length, 1);
});

test('filter restringe aos task-ids pedidos (--ticket do watcher)', () => {
    const repo = newRepo();
    const runs = path.join(repo, 'memory', 'runs');
    seed(runs, '60-a', { status: 'committed', updated_at: ago(45) });
    seed(runs, '61-b', { status: 'committed', updated_at: ago(45) });
    const s = run(repo, { filter: id => id.startsWith('60-') });
    assert.deepStrictEqual(s.archived.map(a => a.taskId), ['60-a']);
    assert.ok(fs.existsSync(path.join(runs, '61-b')));
});
