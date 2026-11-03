// node --test scripts/lib/plan-signals-watcher.test.js
// PRI-222: integração dos sinais com startCostRun/finishCostRun (S1) num repositório git
// sintético. REPO_PATH e HOME descartáveis; nenhum agente é executado.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-signals-'));
const repo = path.join(root, 'app-back');
const home = path.join(root, 'home');
fs.mkdirSync(repo, { recursive: true });
fs.mkdirSync(path.join(home, '.claude', 'projects'), { recursive: true });
process.env.REPO_PATH = repo;
process.env.HOME = home;
process.env.DASHBOARD_PREFS_FILE = path.join(root, 'prefs.json');
delete process.env.WATCHER_CLAUDE_CONFIG_DIR;
global.fetch = async () => { throw new Error('fetch não deveria ser chamado neste teste'); };

const watcher = require('../readmine-watcher');
const planSignals = require('./plan-signals');

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const wt = id => path.join(repo, '.claude', 'worktrees', String(id));
const write = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };

const SPEC = '## Critérios de Aceite\n- AC-01: lista.\n- AC-02: ordenação.\n';
const PLAN = '# Plano\n\n## Plano de execução\n' +
    '1. Ajustar serviço.\n   - Arquivo: `backend/svc-a/src/a.js`, `backend/svc-a/test/a.test.js`\n   - Critérios: AC-01\n   - Verificação: teste.\n' +
    '2. Documentar.\n   - Arquivo: `README.md`\n   - Critérios: AC-02\n   - Verificação: leitura.\n' +
    '3. Terceiro passo.\n   - Arquivo: `backend/svc-a/src/b.js`\n   - Critérios: AC-02\n   - Verificação: teste.\n';

function setup(id, { planText = PLAN, initGit = true } = {}) {
    const dir = path.join(wt(id), 'memory', 'runs', `${id}-x`);
    write(path.join(dir, 'state.json'), JSON.stringify({ task_id: `${id}-x`, node: 'implement', history: [], status: 'in_progress',
        started_at: '2026-09-22T10:00:00.000Z', updated_at: '2026-09-22T10:00:00.000Z' }));
    if (planText) write(path.join(dir, 'plan.md'), planText);
    write(path.join(wt(id), 'memory', 'spec', `${id}-spec.md`), SPEC);
    write(path.join(wt(id), 'backend/svc-a/src/a.js'), 'a\n');
    write(path.join(wt(id), 'README.md'), 'r\n');
    if (initGit) {
        git(wt(id), 'init', '-q', '-b', 'main');
        git(wt(id), 'config', 'user.email', 't@t'); git(wt(id), 'config', 'user.name', 't');
        git(wt(id), 'add', 'backend', 'README.md');
        git(wt(id), 'commit', '-q', '-m', 'base');
    }
    return { dir, ticket: { id, subject: 's', status: { name: 'Em Desenvolvimento' } } };
}

const stateOf = dir => JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'));
const attemptOf = (dir, node = 'implement') => stateOf(dir).cost_tracking.nodes[node].attempts.slice(-1)[0];

function validateSchema(state) {
    const Ajv = require('ajv');
    const ajv = new Ajv({ allErrors: true, strict: false });
    try { require('ajv-formats')(ajv); } catch { /* opcional */ }
    const validate = ajv.compile(JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', '.graph', 'schemas', 'state.schema.json'))));
    assert.equal(validate(state), true, JSON.stringify(validate.errors));
}

test('implement: sinais prospectivos no início, retrospectivos no fim, junto do Attempt da S1', () => {
    const id = 91001;
    const { dir, ticket } = setup(id);
    const run = watcher.startCostRun(id, { agent: 'claude', nodes: ['implement'], sessionId: 's1',
        signalContext: { ticket, worktreePath: wt(id), base: 'main' } });
    const pro = run.signals_prospective;
    assert.strictEqual(pro.status, 'COMPLETE');
    assert.strictEqual(pro.plan_steps, 3);
    assert.deepStrictEqual(pro.groups.map(g => g.steps), [[1], [2], [3]]);
    const g1 = pro.groups[0].signals;
    assert.deepStrictEqual([g1.n_files, g1.n_new_files, g1.kind, g1.n_services_decl, g1.schema_decl, g1.sensitive_decl, g1.n_acs_step],
        [2, 1, 'code', 1, false, false, 1], 'a.test.js ainda não existe: 1 arquivo novo');
    assert.strictEqual(pro.groups[1].signals.kind, 'docs');

    // O agente "trabalha": edita declarado, cria declarado novo e toca arquivo não declarado.
    write(path.join(wt(id), 'backend/svc-a/src/a.js'), 'a\nb\nc\n');
    write(path.join(wt(id), 'backend/svc-a/test/a.test.js'), 't1\nt2\n');
    write(path.join(wt(id), 'scripts/extra.js'), 'x\n');
    write(path.join(dir, 'review.md'), 'artefato de fluxo\n');

    watcher.finishCostRun(id, 's1', run.started_at_ms + 10, { exitCode: 0 });
    const a = attemptOf(dir);
    assert.strictEqual(a.signals.plan_version, pro.plan_version);
    assert.deepStrictEqual(a.signals.groups, pro.groups);
    assert.deepStrictEqual(a.signals.retrospective, {
        status: 'COMPLETE', files_touched: 3, files_declared: 4, undeclared_files: 1, scope_violation: true,
        affected_services: ['backend/svc-a'], full_suite: false, schema_changes_detected: false, schema_risk_level: null,
        diff_lines_added: 2 + 2 + 1, diff_lines_removed: 0, risk_level_seen: 'UNKNOWN', tokens_vs_p90: 'UNAVAILABLE',
    });
    // Campos da S1 intactos.
    assert.strictEqual(a.attributed_node, 'implement');
    assert.strictEqual(a.exit, 0);
    assert.ok(!JSON.stringify(a.signals).includes(wt(id)), 'nenhum caminho absoluto do worktree no registro');
    validateSchema(stateOf(dir));
});

test('implement com schema e serviço tocados: affected_services e schema_risk_level reais', () => {
    const id = 91002;
    const plan = PLAN.replace('`backend/svc-a/src/b.js`', '`backend/svc-a/src/main/resources/db/migration/V2__x.sql`');
    const { dir, ticket } = setup(id, { planText: plan });
    const run = watcher.startCostRun(id, { agent: 'claude', nodes: ['implement'], sessionId: 's2',
        signalContext: { ticket, worktreePath: wt(id), base: 'main' } });
    assert.strictEqual(run.signals_prospective.groups[2].signals.schema_decl, true);
    write(path.join(wt(id), 'backend/svc-a/src/main/resources/db/migration/V2__x.sql'), 'CREATE TABLE t (id INT);\n');
    write(path.join(wt(id), 'backend/svc-a/src/a.js'), 'a2\n');
    watcher.finishCostRun(id, 's2', run.started_at_ms + 1);
    const r = attemptOf(dir).signals.retrospective;
    assert.deepStrictEqual([r.affected_services, r.full_suite, r.schema_changes_detected, r.schema_risk_level],
        [['backend/svc-a'], false, true, 'low']);
});

test('falha de coleta prospectiva (plano ausente) => UNKNOWN com causa; Attempt e custo gravados normalmente', () => {
    const id = 91003;
    const { dir, ticket } = setup(id, { planText: null });
    const run = watcher.startCostRun(id, { agent: 'claude', nodes: ['implement'], sessionId: 's3',
        signalContext: { ticket, worktreePath: wt(id), base: 'main' } });
    assert.ok(run, 'despacho segue');
    assert.deepStrictEqual([run.signals_prospective.status, run.signals_prospective.cause], ['UNKNOWN', 'PLAN_BLOCK_NOT_FOUND']);
    watcher.finishCostRun(id, 's3', run.started_at_ms + 7, { exitCode: 0 });
    const a = attemptOf(dir);
    assert.strictEqual(a.duration_ms, 7);
    assert.strictEqual(stateOf(dir).cost_tracking.nodes.implement.runs, 1);
    assert.strictEqual(a.signals.retrospective.scope_violation, 'UNKNOWN');
    assert.strictEqual(a.signals.retrospective.undeclared_files, 'UNKNOWN');
    validateSchema(stateOf(dir));
});

test('exceção na coleta prospectiva não propaga: startCostRun devolve run com UNKNOWN/COLLECTION_FAILED', () => {
    const id = 91004;
    const { dir, ticket } = setup(id);
    const original = planSignals.buildProspective;
    planSignals.buildProspective = () => { throw new Error('boom'); };
    let run;
    try {
        run = watcher.startCostRun(id, { agent: 'claude', nodes: ['implement'], sessionId: 's4',
            signalContext: { ticket, worktreePath: wt(id), base: 'main' } });
    } finally { planSignals.buildProspective = original; }
    assert.ok(run);
    assert.deepStrictEqual([run.signals_prospective.status, run.signals_prospective.cause], ['UNKNOWN', 'COLLECTION_FAILED']);
    watcher.finishCostRun(id, 's4', run.started_at_ms + 3);
    assert.strictEqual(stateOf(dir).cost_tracking.nodes.implement.runs, 1);
});

test('exceção na coleta retrospectiva não propaga: Attempt gravado com retrospective UNKNOWN', () => {
    const id = 91005;
    const { dir, ticket } = setup(id);
    const run = watcher.startCostRun(id, { agent: 'claude', nodes: ['implement'], sessionId: 's5',
        signalContext: { ticket, worktreePath: wt(id), base: 'main' } });
    const original = planSignals.retrospectiveSignals;
    planSignals.retrospectiveSignals = () => { throw new Error('boom'); };
    try { watcher.finishCostRun(id, 's5', run.started_at_ms + 4); } finally { planSignals.retrospectiveSignals = original; }
    const a = attemptOf(dir);
    assert.deepStrictEqual(a.signals.retrospective, { status: 'UNKNOWN', cause: 'COLLECTION_FAILED' });
    assert.strictEqual(a.duration_ms, 4);
    validateSchema(stateOf(dir));
});

test('worktree sem git: retrospectivo PARTIAL com UNKNOWN por campo (nunca 0)', () => {
    const id = 91006;
    const { dir, ticket } = setup(id, { initGit: false });
    const run = watcher.startCostRun(id, { agent: 'claude', nodes: ['implement'], sessionId: 's6',
        signalContext: { ticket, worktreePath: wt(id), base: 'main' } });
    watcher.finishCostRun(id, 's6', run.started_at_ms + 1);
    const r = attemptOf(dir).signals.retrospective;
    assert.strictEqual(r.status, 'PARTIAL');
    for (const k of ['files_touched', 'scope_violation', 'affected_services', 'schema_changes_detected', 'diff_lines_added']) assert.strictEqual(r[k], 'UNKNOWN', k);
});

test('nó que não é implement (ou Codex): signals = UNAVAILABLE e nada de contexto no pendente', () => {
    const id = 91007;
    const { dir, ticket } = setup(id);
    const run = watcher.startCostRun(id, { agent: 'claude', nodes: ['review'], sessionId: 's7',
        signalContext: { ticket, worktreePath: wt(id), base: 'main' } });
    assert.ok(!('signals_prospective' in run) && !('signal_ctx' in run));
    const codex = watcher.startCostRun(id, { agent: 'codex', nodes: ['implement'], sessionId: 's7c', signalContext: { ticket, worktreePath: wt(id) } });
    assert.ok(!('signals_prospective' in codex));
    watcher.finishCostRun(id, 's7', run.started_at_ms + 1);
    assert.strictEqual(attemptOf(dir, 'review').signals, 'UNAVAILABLE');
    watcher.finishCostRun(id, 's7c', codex.started_at_ms + 1);
    assert.strictEqual(attemptOf(dir, 'implement').signals, 'UNAVAILABLE');
});

test('sem signalContext (chamadores antigos): implement registra UNKNOWN/NO_SIGNAL_CONTEXT, sem lançar', () => {
    const id = 91008;
    const { dir } = setup(id);
    const run = watcher.startCostRun(id, { agent: 'claude', nodes: ['implement'], sessionId: 's8' });
    assert.strictEqual(run.signals_prospective.cause, 'NO_SIGNAL_CONTEXT');
    watcher.finishCostRun(id, 's8', run.started_at_ms + 1);
    const a = attemptOf(dir);
    assert.strictEqual(a.signals.status, 'UNKNOWN');
    assert.deepStrictEqual(a.signals.retrospective, { status: 'UNKNOWN', cause: 'NO_SIGNAL_CONTEXT' });
});

test('dry-run: nenhuma linha gravada (S1 preservada)', () => {
    const source = `process.argv.push('--dry-run'); const w = require(${JSON.stringify(path.join(__dirname, '..', 'readmine-watcher'))});
        const r = w.startCostRun(91009, {agent:'claude',nodes:['implement'],sessionId:'dry',signalContext:{ticket:{id:91009},worktreePath:'/nao/existe'}});
        if (r !== null || require('fs').existsSync(w.costLedgerPath(91009))) process.exit(1);`;
    execFileSync(process.execPath, ['-e', source], { env: { ...process.env, REPO_PATH: repo, HOME: home } });
});

test.after(() => fs.rmSync(root, { recursive: true, force: true }));
