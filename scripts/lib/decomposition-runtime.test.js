// node --test scripts/lib/decomposition-runtime.test.js
// PRI-311 (PRI-287 S5.2a): ligações da Run decomposta — AC-36 a AC-45 do adendo
// tasks/pri-287-s5/SPEC-s5.2.md v2.1. Attempts injetados (sem despacho de subtarefa), repositórios
// git sintéticos, nada externo.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const dom06 = require('./dom06-attempt');
const nodeLease = require('./node-lease');
const rt = require('./decomposition-runtime');
const signals = require('./agent-exit-signals');
const policyLoader = require('./model-routing-policy');
const costTracking = require('./cost-tracking');

const tmpRoot = fs.realpathSync(fs.mkdtempSync(path.join(process.env.CLAUDE_JOB_DIR ? path.join(process.env.CLAUDE_JOB_DIR, 'tmp') : os.tmpdir(), 'deco-rt-')));
test.after(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));

const GIT_ENV = {
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_AUTHOR_NAME: 'm', GIT_AUTHOR_EMAIL: 'm@example.invalid', GIT_COMMITTER_NAME: 'm', GIT_COMMITTER_EMAIL: 'm@example.invalid',
};
const env = { PATH: process.env.PATH, ...GIT_ENV };
const git = (cwd, ...args) => execFileSync('git', args, { cwd, env, encoding: 'utf8' }).trim();
const write = (dir, rel, text) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), text); };

const PV = 'a'.repeat(64);
const PV2 = 'b'.repeat(64);
const K1 = `${PV.slice(0, 12)}/1-1`;
const K2 = `${PV.slice(0, 12)}/2-2`;

let n = 0;
function gitRepo(dir) {
    fs.mkdirSync(dir, { recursive: true });
    git(dir, 'init', '-q', '-b', 'main');
    write(dir, '.gitignore', 'memory/runs/\n.env*\n');
    write(dir, 'src/a.js', 'module.exports = 1;\n');
    git(dir, 'add', '.');
    git(dir, 'commit', '-q', '-m', 'base');
}

// Checkout principal (chave e manifestos) + worktree do ticket com a Run em memory/runs/<task>.
function fixture({ status = 'running', planVersion = PV } = {}) {
    const base = path.join(tmpRoot, `f${n++}`);
    const checkout = path.join(base, 'checkout');
    const worktree = path.join(base, 'wt');
    gitRepo(checkout);
    gitRepo(worktree);
    const task = `1-t${n}`;
    const runDir = path.join(worktree, 'memory', 'runs', task);
    fs.mkdirSync(runDir, { recursive: true });
    const startedAt = '2026-11-09T10:00:00.000Z';
    fs.writeFileSync(path.join(runDir, 'state.json'), JSON.stringify({
        task_id: task, node: 'implement', history: [], retries: {}, status, node_started_at: startedAt,
        decomposition: { plan_version: planVersion },
    }));
    return { checkout, worktree, task, runDir, startedAt };
}

const DISPATCH = { node: 'implement', ticketId: 1, baseBranch: 'main' };

function dispatchSub(f, key = K1, extra = {}) {
    return rt.prepareRoleDispatch({
        runDir: f.runDir, checkoutRoot: f.checkout, task: f.task, worktree: f.worktree,
        decomposition: { role: 'subtask', plan_version: PV, subtask_key: key, ...extra.decomposition },
        scopePaths: ['src'], watchGlobs: ['.env*'], state: extra.state || {}, dispatch: DISPATCH, env,
    });
}

function leaseFor(f, r) {
    return {
        dir: f.runDir, startedAt: f.startedAt, node: 'implement',
        dom06AttemptFile: r.admission.attemptFile, dom06AttemptId: r.admission.attempt.attempt_id,
        dom06Role: r.admission.attempt.role, dom06ManifestsDir: rt.manifestPaths(f.checkout).manifestsDir, task: f.task,
    };
}

const viaWrapper = (lease, code) => execFileSync(process.execPath, [path.join(__dirname, 'node-lease.js'), 'release', JSON.stringify(lease), String(code)], { encoding: 'utf8', env });

// O caminho --follow de verdade: as funções exportadas do watcher (releaseLease no exit,
// closeRoleAttempt depois do drained), não uma cópia (C-O-05).
let watcherMod = null;
function watcher() {
    if (!watcherMod) {
        if (!process.env.REPO_PATH) process.env.REPO_PATH = path.resolve(__dirname, '..', '..');
        watcherMod = require('../readmine-watcher');
    }
    return watcherMod;
}
function viaFollow(lease, code, { output = '', stderr = '' } = {}) {
    const w = watcher();
    const releaseCtx = w.releaseLease(lease, code);
    return w.closeRoleAttempt(lease, code, releaseCtx, output, stderr);
}

const strip = a => { const { decided_at: _d, ...rest } = a.acceptance; return rest; };
const resetRunning = f => {
    const s = JSON.parse(fs.readFileSync(path.join(f.runDir, 'state.json'), 'utf8'));
    fs.writeFileSync(path.join(f.runDir, 'state.json'), JSON.stringify({ ...s, status: 'running', node_started_at: f.startedAt }));
};

// ---------------------------------------------------------------- AC-44 (H0)

test('AC-44: baseline no despacho com papel — Attempt com resumo e scope_hmac, sem caminho; arquivo local com o escopo', () => {
    const f = fixture();
    const r = dispatchSub(f);
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.admission.dispatch, true);
    const a = dom06.readAttempt(r.admission.attemptFile);
    assert.strictEqual(a.workspace.baseline.completeness, 'COMPLETE');
    assert.match(a.workspace.baseline.digest, /^[0-9a-f]{64}$/);
    assert.match(a.scope_hmac, /^[0-9a-f]{64}$/);
    assert.deepStrictEqual(a.chain_anchor && a.chain_anchor.reason, 'RUN_START');
    const raw = fs.readFileSync(r.admission.attemptFile, 'utf8');
    for (const forbidden of ['src/a.js', '.env', f.worktree, f.checkout]) assert.ok(!raw.includes(forbidden), `Attempt não contém ${forbidden}`);
    const local = JSON.parse(fs.readFileSync(r.stored, 'utf8'));
    assert.deepStrictEqual(local.scope.scope_paths, ['src']);
    assert.ok(r.stored.startsWith(rt.manifestPaths(f.checkout).manifestsDir));
});

// ---------------------------------------------------------------- AC-36 (H1)

test('AC-36: mesmo acceptance pelo wrapper destacado e pelo caminho --follow; post no escopo do baseline', () => {
    const f = fixture();
    const r1 = dispatchSub(f, K1);
    write(f.worktree, 'src/b.js', 'novo');
    viaWrapper(leaseFor(f, r1), 0);
    resetRunning(f);
    const r2 = dispatchSub(f, K2);
    assert.strictEqual(r2.ok, true, 'cadeia: baseline do 2º = post do 1º');
    write(f.worktree, 'src/c.js', 'novo');
    viaFollow(leaseFor(f, r2), 0);
    const a1 = strip(dom06.readAttempt(r1.admission.attemptFile));
    const a2 = strip(dom06.readAttempt(r2.admission.attemptFile));
    assert.deepStrictEqual(a1, a2, 'mesmo resultado pelos dois caminhos');
    assert.strictEqual(a1.accepted, true);
    assert.strictEqual(dom06.readAttempt(r1.admission.attemptFile).obligations[0].status, 'fulfilled');
    assert.ok(fs.existsSync(path.join(rt.manifestPaths(f.checkout).manifestsDir, f.task, `${r1.admission.attempt.attempt_id}.post.json`)));
});

test('AC-36: adições do DOM-06 ao lease = papel, diretório de manifestos e task (sem chave nem escopo)', () => {
    const f = fixture();
    const r = dispatchSub(f);
    const lease = leaseFor(f, r);
    const added = ['dom06Role', 'dom06ManifestsDir', 'task'];
    const json = JSON.stringify(lease);
    assert.ok(!json.includes('scope'), 'sem escopo');
    const key = fs.readFileSync(manifestKey(f));
    assert.ok(!json.includes(key.toString('hex')) && !json.includes(key.toString('base64')), 'sem chave');
    for (const k of added) assert.ok(k in lease);
    // O watcher acrescenta só esses campos (attachDom06Lease).
    const src = fs.readFileSync(path.join(__dirname, '..', 'readmine-watcher.js'), 'utf8');
    const attach = src.slice(src.indexOf('function attachDom06Lease'), src.indexOf('function repoWorktrees'));
    const assigned = [...attach.matchAll(/lease\.(\w+) =/g)].map(m => m[1]).sort();
    assert.deepStrictEqual(assigned, ['dom06AttemptFile', 'dom06AttemptId', 'dom06ManifestsDir', 'dom06Role', 'node', 'task'].sort());
});
function manifestKey(f) { return path.join(rt.manifestPaths(f.checkout).keysDir, `${f.task}.key`); }

test('AC-36: baseline local alterado → SCOPE_TAMPERED; ausente → BASELINE_MISSING; não aceito e bloqueia', () => {
    const f = fixture();
    const r = dispatchSub(f);
    const local = JSON.parse(fs.readFileSync(r.stored, 'utf8'));
    local.scope.scope_paths = ['outro'];
    fs.writeFileSync(r.stored, JSON.stringify(local));
    viaFollow(leaseFor(f, r), 0);
    const a = dom06.readAttempt(r.admission.attemptFile);
    assert.strictEqual(a.workspace.post.cause, 'SCOPE_TAMPERED');
    assert.strictEqual(a.acceptance.reason, 'POST_UNKNOWN');
    assert.strictEqual(a.acceptance.block, true);
    resetRunning(f);
    const r2 = rt.prepareRoleDispatch({ runDir: f.runDir, checkoutRoot: f.checkout, task: f.task, worktree: f.worktree,
        decomposition: { role: 'subtask', plan_version: PV, subtask_key: K2 }, scopePaths: ['src'], state: { unblocked: { at: '2999-01-01T00:00:00.000Z', by: 'human_input' } }, dispatch: DISPATCH, env });
    fs.rmSync(r2.stored);
    viaFollow(leaseFor(f, r2), 0);
    assert.strictEqual(dom06.readAttempt(r2.admission.attemptFile).workspace.post.cause, 'BASELINE_MISSING');
});

test('AC-36 (O-02): plan_version vem do mesmo snapshot do release; redecompor depois não muda a versão usada', () => {
    const f = fixture();
    const r = dispatchSub(f);
    const lease = leaseFor(f, r);
    const ctx = nodeLease.releaseNodeWithContext(lease);
    assert.deepStrictEqual(ctx, { reason: 'RELEASED', plan_version: PV });
    // O tick seguinte redecompõe (replan) antes do fechamento adiado.
    const s = JSON.parse(fs.readFileSync(path.join(f.runDir, 'state.json'), 'utf8'));
    fs.writeFileSync(path.join(f.runDir, 'state.json'), JSON.stringify({ ...s, decomposition: { plan_version: PV2 } }));
    const { manifestPost, currentPlanVersion } = rt.exitContext({ lease, planVersion: ctx.plan_version, env });
    const d = dom06.closeOnExit({ attemptFile: lease.dom06AttemptFile, attemptId: lease.dom06AttemptId, node: 'implement', code: 0, claim: ctx.reason, manifestPost, currentPlanVersion });
    assert.strictEqual(d.accepted, true, 'a versão do release, não a relida');
    // Versão já superada no release → PLAN_SUPERSEDED.
    resetRunning(f);
    const r2 = rt.prepareRoleDispatch({ runDir: f.runDir, checkoutRoot: f.checkout, task: f.task, worktree: f.worktree,
        decomposition: { role: 'subtask', plan_version: PV, subtask_key: K2 }, scopePaths: ['src'], dispatch: DISPATCH, env });
    viaFollow(leaseFor(f, r2), 0);
    assert.strictEqual(dom06.readAttempt(r2.admission.attemptFile).acceptance.reason, 'PLAN_SUPERSEDED');
    // releaseNodeWithReason continua devolvendo string (AC-09 da S5.1).
    assert.strictEqual(typeof nodeLease.releaseNodeWithReason(null), 'string');
});

test('AC-36: watcher fecha Attempt com papel só depois do drained; Attempt sem papel pelo caminho de sempre', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'readmine-watcher.js'), 'utf8');
    assert.match(src, /const releaseCtx = releaseLease\(lease, code\);\s*drained\.then\(\(\) => \{\s*closeRoleAttempt\(lease, code, releaseCtx, output, stderrBuffer\);/);
    assert.match(src, /if \(lease\.dom06Role\) return \{ claim, planVersion \};/);
    // Wrapper destacado: offset do log gravado no spawn, só para Attempt com papel.
    assert.match(src, /if \(lease && lease\.dom06Role\) \{\s*lease\.logPath = logPath;/);
});

// ---------------------------------------------------------------- AC-37 (H2)

test('AC-37: indisponibilidade e session_limit sem mutação não consomem o teto; com mutação bloqueiam', () => {
    const f = fixture();
    const r1 = dispatchSub(f);
    viaFollow(leaseFor(f, r1), 1, { output: 'Error: rate limit exceeded' });
    const a1 = dom06.readAttempt(r1.admission.attemptFile).acceptance;
    assert.strictEqual(a1.reason, 'OPERATIONAL_FAILURE_EXEMPT');
    assert.strictEqual(a1.operational_cause, 'PROVIDER_UNAVAILABLE');
    assert.strictEqual(a1.block, false);
    // Nova tentativa da mesma chave (filha da isenta) falha de novo sem mutação: ainda é o 1º
    // retry que conta, não o teto.
    resetRunning(f);
    const r2 = dispatchSub(f, K1, { decomposition: { parent_attempt_id: r1.admission.attempt.attempt_id } });
    viaFollow(leaseFor(f, r2), 1, { stderr: 'context window exceeded' });
    assert.strictEqual(dom06.readAttempt(r2.admission.attemptFile).acceptance.reason, 'OPERATIONAL_FAILURE_EXEMPT');
    resetRunning(f);
    const r3 = dispatchSub(f, K1, { decomposition: { parent_attempt_id: r2.admission.attempt.attempt_id } });
    viaFollow(leaseFor(f, r3), 1, { output: 'boom' });
    const a3 = dom06.readAttempt(r3.admission.attemptFile).acceptance;
    assert.strictEqual(a3.reason, 'OPERATIONAL_FAILURE', 'pai isento não conta no teto');
    assert.strictEqual(a3.operational_cause, 'AGENT_FAILURE');
    // Indisponibilidade com mutação → blocked, qualquer que seja a causa (O-04).
    resetRunning(f);
    const r4 = dispatchSub(f, K2);
    write(f.worktree, 'src/parcial.js', 'x');
    viaFollow(leaseFor(f, r4), 1, { output: 'rate limit exceeded' });
    const a4 = dom06.readAttempt(r4.admission.attemptFile).acceptance;
    assert.strictEqual(a4.reason, 'PARTIAL_MUTATION');
    assert.strictEqual(a4.block, true);
});

test('AC-37 (R2-O-03): Attempt reancorado por HUMAN_RESUME recomeça a contagem do teto', () => {
    const base = { workspace: { baseline: { completeness: 'COMPLETE', digest: 'd' } }, plan_version: PV, parent_attempt_id: 'p' };
    const post = { completeness: 'COMPLETE', digest: 'd' };
    const parent = { retry_allowed: true };
    const ceil = dom06.decideAcceptance({ attempt: base, code: 1, claim: 'RELEASED', post, currentPlanVersion: PV, parentAcceptance: parent });
    assert.strictEqual(ceil.reason, 'RETRY_CEILING');
    const resumed = dom06.decideAcceptance({ attempt: { ...base, chain_anchor: { reason: 'HUMAN_RESUME', by: 'x' } }, code: 1, claim: 'RELEASED', post, currentPlanVersion: PV, parentAcceptance: parent });
    assert.strictEqual(resumed.reason, 'OPERATIONAL_FAILURE');
});

test('AC-37: modo destacado lê o log só a partir do offset; texto anterior não isenta; indeterminado = AGENT_FAILURE', () => {
    const log = path.join(tmpRoot, `log${n++}.log`);
    fs.writeFileSync(log, 'despacho anterior: rate limit exceeded\n');
    const offset = fs.statSync(log).size;
    fs.appendFileSync(log, 'falha comum do agente\n');
    const tail = rt.readLogFrom(log, offset, { waitMs: 400, stableMs: 100 });
    assert.ok(!tail.includes('rate limit'));
    assert.strictEqual(signals.operationalCause({ code: 1, output: tail, stderr: tail }), 'AGENT_FAILURE');
    fs.appendFileSync(log, '429 Too Many Requests\n');
    assert.strictEqual(signals.operationalCause({ code: 1, output: rt.readLogFrom(log, offset, { waitMs: 400, stableMs: 100 }) }), 'PROVIDER_UNAVAILABLE');
    assert.strictEqual(rt.readLogFrom('/nao/existe', 0, { waitMs: 50 }), '');
    assert.strictEqual(signals.operationalCause({ code: 1 }), 'AGENT_FAILURE');
    assert.strictEqual(signals.operationalCause({ code: 0, output: 'rate limit exceeded' }), null);
});

test('AC-37: wrapper destacado usa a cauda do log a partir do offset', () => {
    const f = fixture();
    const r = dispatchSub(f);
    const log = path.join(tmpRoot, `log${n++}.log`);
    fs.writeFileSync(log, 'antes\n');
    const lease = { ...leaseFor(f, r), logPath: log, logOffset: fs.statSync(log).size };
    fs.appendFileSync(log, 'Error: usage limit reached\n');
    viaWrapper(lease, 1);
    const a = dom06.readAttempt(r.admission.attemptFile).acceptance;
    assert.strictEqual(a.operational_cause, 'PROVIDER_UNAVAILABLE');
    assert.strictEqual(a.reason, 'OPERATIONAL_FAILURE_EXEMPT');
});

// ---------------------------------------------------------------- AC-38 (H3)

function routedPolicy(extra = {}) {
    return {
        id: 'p', version: 'v1', mode: 'ROUTED', classifier: { provider: 'cheap_rule' },
        class_to_tier: { C1: { tier: 'T1', effort: 'baixo' }, C2: { tier: 'T2', effort: 'médio' }, C3: { tier: 'T2', effort: 'alto' }, C4: { tier: 'T3', effort: 'alto' }, C5: { tier: 'T3', effort: 'máximo' } },
        tiers: { T1: { models: ['m1'] }, T2: { models: ['m2'] }, T3: { models: ['m3'] } },
        default_route: { model_id: 'm3', effort: 'alto' },
        effort_map: { baixo: 'low', 'médio': 'medium', alto: 'high', 'máximo': 'max' },
        ...extra,
    };
}

test('AC-38: seções ausentes → padrões; forma válida aceita; papel inexistente no projeto não é erro', () => {
    assert.strictEqual(policyLoader.validateRoutedPolicy(routedPolicy()).ok, true);
    assert.deepStrictEqual(policyLoader.decompositionSections(routedPolicy()), {
        subagent_roles: null, manifest_limits: { maxEntries: 20000, maxBytes: 268435456 }, workspace_watch_globs: [],
    });
    const full = routedPolicy({
        subagent_roles: { default: { model_id: 'm3', effort: 'alto' }, 'papel-que-o-projeto-nao-tem': { model_id: 'm3', effort: 'UNKNOWN', effort_ref: 'U1' } },
        manifest_limits: { max_entries: 10, max_bytes: 100 },
        workspace_watch_globs: ['.env', '.env.*'],
    });
    assert.strictEqual(policyLoader.validateRoutedPolicy(full).ok, true);
    assert.deepStrictEqual(policyLoader.decompositionSections(full).manifest_limits, { maxEntries: 10, maxBytes: 100 });
});

test('AC-38: forma inválida com mode ON → policy inválida (recusa RC-5); model_id irreal recusado', () => {
    const bad = [
        { subagent_roles: { default: { model_id: 'UNAVAILABLE', effort: 'alto' } } },
        { subagent_roles: { default: { model_id: 'm3', effort: 'turbo' } } },
        { subagent_roles: { default: { model_id: 'm3', effort: 'UNKNOWN' } } },
        { subagent_roles: { 'Papel Inválido': { model_id: 'm3', effort: 'alto' } } },
        { subagent_roles: {} },
        { manifest_limits: { max_entries: 0, max_bytes: 1 } },
        { workspace_watch_globs: ['../fora'] },
        { workspace_watch_globs: ['/abs'] },
    ];
    for (const extra of bad) {
        const r = policyLoader.validateRoutedPolicy(routedPolicy(extra));
        assert.strictEqual(r.ok, false, JSON.stringify(extra));
        assert.strictEqual(r.cause, 'POLICY_INVALID');
    }
});

test('AC-38: projeto OFF não lê a policy (seções inválidas não mudam nada)', () => {
    const root = path.join(tmpRoot, `off${n++}`);
    fs.mkdirSync(path.join(root, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(root, '.claude', 'routing-policy.json'), JSON.stringify(routedPolicy({ manifest_limits: 'lixo' })));
    fs.writeFileSync(path.join(root, '.claude', 'model-routing.json'), JSON.stringify({ mode: 'OFF' }));
    assert.strictEqual(policyLoader.readRoutingConfig(root).status, 'OFF');
});

// ---------------------------------------------------------------- AC-39 (H4)

test('AC-39: órfão com papel — agent_dead sem mutação → 1 retry; com mutação → blocked; timeout → blocked; sempre UNCERTAIN', () => {
    const cases = [
        { reason: 'agent_dead', mutate: false, block: false, retry: true },
        { reason: 'agent_dead', mutate: true, block: true, retry: false },
        { reason: 'timeout', mutate: false, block: true, retry: false },
    ];
    for (const c of cases) {
        const f = fixture();
        const r = dispatchSub(f);
        if (c.mutate) write(f.worktree, 'src/parcial.js', 'x');
        const acc = rt.closeRoleOrphan({ runDir: f.runDir, node: 'implement', task: f.task, checkoutRoot: f.checkout, orphanReason: c.reason, env });
        const a = dom06.readAttempt(r.admission.attemptFile);
        assert.strictEqual(a.result, 'UNCERTAIN', JSON.stringify(c));
        assert.strictEqual(acc.block, c.block, JSON.stringify(c));
        assert.strictEqual(acc.retry_allowed, c.retry, JSON.stringify(c));
        assert.strictEqual(acc.orphan_reason, c.reason);
        assert.strictEqual(a.obligations[0].status, 'pending', 'nunca cumpre obrigação');
    }
});

test('AC-39: órfão agent_dead com post UNKNOWN (baseline local adulterado) → blocked', () => {
    const f = fixture();
    const r = dispatchSub(f);
    const local = JSON.parse(fs.readFileSync(r.stored, 'utf8'));
    local.scope.scope_paths = ['outro'];
    fs.writeFileSync(r.stored, JSON.stringify(local));
    const acc = rt.closeRoleOrphan({ runDir: f.runDir, node: 'implement', task: f.task, checkoutRoot: f.checkout, orphanReason: 'agent_dead', env });
    assert.deepStrictEqual([acc.block, acc.retry_allowed], [true, false]);
    assert.strictEqual(dom06.readAttempt(r.admission.attemptFile).workspace.post.cause, 'SCOPE_TAMPERED');
});

test('C-O-02: em --follow, saída sem código (sinal) fecha como falha; falha no release → CLAIM_UNKNOWN', () => {
    const f = fixture();
    const r = dispatchSub(f);
    viaFollow(leaseFor(f, r), null);
    const a = dom06.readAttempt(r.admission.attemptFile).acceptance;
    assert.strictEqual(a.exit_code, null);
    assert.strictEqual(a.operational_cause, 'AGENT_FAILURE');
    assert.strictEqual(a.accepted, false);
    resetRunning(f);
    const r2 = rt.prepareRoleDispatch({ runDir: f.runDir, checkoutRoot: f.checkout, task: f.task, worktree: f.worktree,
        decomposition: { role: 'subtask', plan_version: PV, subtask_key: K2 }, scopePaths: ['src'], dispatch: DISPATCH, env });
    watcher().closeRoleAttempt(leaseFor(f, r2), 0, null);
    const a2 = dom06.readAttempt(r2.admission.attemptFile).acceptance;
    assert.deepStrictEqual([a2.reason, a2.block], ['CLAIM_UNKNOWN', true]);
    // Destacado ainda em voo (code null sem signalled) continua pendente.
    const r3 = dom06.beginAttempt(f.runDir, { node: 'implement', admission: { status: 'ADMITTED', owner: 'dom06', snapshot: { ticket_id: 1 } },
        decomposition: { role: 'subtask', plan_version: PV, subtask_key: K1 } });
    assert.deepStrictEqual(dom06.closeOnExit({ attemptFile: r3.attemptFile, attemptId: r3.attempt.attempt_id, node: 'implement', code: null }), { pending: true });
});

test('AC-39: recoverOrphans chama onOrphan só para nó comum; sem Attempt com papel nada muda', () => {
    const f = fixture();
    const s = JSON.parse(fs.readFileSync(path.join(f.runDir, 'state.json'), 'utf8'));
    fs.writeFileSync(path.join(f.runDir, 'state.json'), JSON.stringify({ ...s, node_timeout_ms: 1, node_started_at: '2020-01-01T00:00:00.000Z' }));
    const seen = [];
    const res = nodeLease.recoverOrphans([path.join(f.worktree, 'memory', 'runs')], { onOrphan: (dir, st, reason) => seen.push({ dir, node: st.node, reason }) });
    assert.strictEqual(res.length, 1);
    assert.deepStrictEqual(seen, [{ dir: f.runDir, node: 'implement', reason: 'timeout' }]);
    assert.strictEqual(rt.closeRoleOrphan({ runDir: f.runDir, node: 'implement', task: f.task, checkoutRoot: f.checkout, orphanReason: 'timeout', env }), null);
    // O watcher passa o callback.
    const src = fs.readFileSync(path.join(__dirname, '..', 'readmine-watcher.js'), 'utf8');
    assert.match(src, /onOrphan: \(dir, state, reason\) => decompositionRuntime\.closeRoleOrphan\(/);
});

// ---------------------------------------------------------------- AC-40 (H5)

test('AC-40: chave mantida com Run no _archive; apagada sem Run em nenhuma raiz; idempotente; filtro respeitado', () => {
    const f = fixture();
    dispatchSub(f);
    const { keysDir, manifestsDir } = rt.manifestPaths(f.checkout);
    assert.ok(fs.existsSync(manifestKey(f)));
    const roots = [path.join(f.checkout, 'memory', 'runs'), path.join(f.worktree, 'memory', 'runs')];
    assert.deepStrictEqual(rt.sweepKeys({ checkoutRoot: f.checkout, runsDirs: roots }), [], 'Run viva: nada');
    const archived = path.join(f.checkout, 'memory', 'runs', '_archive', f.task);
    fs.mkdirSync(path.dirname(archived), { recursive: true });
    fs.renameSync(f.runDir, archived);
    assert.deepStrictEqual(rt.sweepKeys({ checkoutRoot: f.checkout, runsDirs: roots }), [], 'Run no _archive (Recusa QA revive): mantém');
    fs.rmSync(archived, { recursive: true });
    assert.deepStrictEqual(rt.sweepKeys({ checkoutRoot: f.checkout, runsDirs: roots, filter: () => false }), [], 'fora do escopo: intocada');
    assert.deepStrictEqual(rt.sweepKeys({ checkoutRoot: f.checkout, runsDirs: roots }), [f.task]);
    assert.ok(!fs.existsSync(path.join(keysDir, `${f.task}.key`)));
    assert.ok(!fs.existsSync(path.join(manifestsDir, f.task)));
    assert.deepStrictEqual(rt.sweepKeys({ checkoutRoot: f.checkout, runsDirs: roots }), [], 'idempotente');
});

test('AC-40: chave apagada sob Run viva → KEY_MISSING → não aceito e bloqueia (fail-closed)', () => {
    const f = fixture();
    const r = dispatchSub(f);
    fs.rmSync(manifestKey(f));
    viaFollow(leaseFor(f, r), 0);
    const a = dom06.readAttempt(r.admission.attemptFile);
    assert.strictEqual(a.workspace.post.cause, 'KEY_MISSING');
    assert.strictEqual(a.acceptance.block, true);
    assert.ok(!fs.existsSync(manifestKey(f)), 'a saída nunca recria a chave');
});

test('AC-40: Run revivida (worktree novo) → cadeia quebrada → blocked até HUMAN_UNBLOCK (Q14 a)', () => {
    const f = fixture();
    const r1 = dispatchSub(f);
    viaFollow(leaseFor(f, r1), 0);
    write(f.worktree, 'src/a.js', 'worktree recriado pela Recusa QA\n');
    const blocked = dispatchSub(f, K2);
    assert.strictEqual(blocked.ok, false);
    assert.strictEqual(blocked.reason, 'CHANGED_BETWEEN_ATTEMPTS');
    const later = new Date(Date.now() + 60_000).toISOString();
    const resumed = dispatchSub(f, K2, { state: { unblocked: { at: later, by: 'human_input' } } });
    assert.strictEqual(resumed.ok, true);
    assert.deepStrictEqual({ reason: resumed.anchor.reason, by: resumed.anchor.by }, { reason: 'HUMAN_UNBLOCK', by: 'human_input' });
});

// ---------------------------------------------------------------- AC-42 / AC-43 (H6)

test('AC-42: blocked pendente só com in_progress, uma vez por Attempt; nunca sobre session_limit ou status do comando', () => {
    const f = fixture();
    const r = dispatchSub(f);
    write(f.worktree, 'src/parcial.js', 'x');
    viaFollow(leaseFor(f, r), 1);
    const state = JSON.parse(fs.readFileSync(path.join(f.runDir, 'state.json'), 'utf8'));
    assert.strictEqual(state.status, 'in_progress');
    const p = rt.pendingBlock(f.runDir, state);
    assert.deepStrictEqual(p, { attempt_id: r.admission.attempt.attempt_id, reason: 'PARTIAL_MUTATION', node: 'implement' });
    assert.strictEqual(rt.pendingBlock(f.runDir, { ...state, status: 'session_limit' }), null);
    assert.strictEqual(rt.pendingBlock(f.runDir, { ...state, status: 'spec-change-pending-approval' }), null);
    assert.strictEqual(rt.pendingBlock(f.runDir, { ...state, decomposition_block_applied: { attempt_id: p.attempt_id } }), null, 'desbloqueio humano não é desfeito');
    // C-O-01: retomada de session_limit pelo dashboard (resumed_at) depois do aceite → sem blocked.
    const later = new Date(Date.now() + 60_000).toISOString();
    assert.strictEqual(rt.pendingBlock(f.runDir, { ...state, resumed_at: later }), null, 'retomada humana prevalece');
    assert.strictEqual(rt.pendingBlock(f.runDir, { ...state, unblocked: { at: later, by: 'human_input' } }), null);
    assert.ok(rt.pendingBlock(f.runDir, { ...state, resumed_at: '2000-01-01T00:00:00.000Z' }), 'retomada anterior ao aceite não vale');
    const src = fs.readFileSync(path.join(__dirname, '..', 'readmine-watcher.js'), 'utf8');
    assert.match(src, /if \(!DRY_RUN && status === 'in_progress'\) \{\s*const pending = decompositionRuntime\.pendingBlock\(dir, state\);/);
    const writer = src.slice(src.indexOf('async function applyDecompositionBlock'), src.indexOf('// Ticket novo: o fetch_ticket recusado'));
    assert.match(writer, /writeTaskState\(dir, state, 'decomposition_blocked'\)/);
    assert.match(writer, /await notifyBlocked\(ticket, taskId, node, 'blocked', dir, state, note\)/);
    assert.match(writer, /decomposition_block_applied = \{ attempt_id: pending\.attempt_id/);
});

test('AC-43: cadeia no despacho — igual segue; mudança fora de Attempt bloqueia; reancoragens gravadas', () => {
    const f = fixture();
    const r1 = dispatchSub(f);
    assert.strictEqual(r1.anchor.reason, 'RUN_START');
    viaFollow(leaseFor(f, r1), 0);
    resetRunning(f);
    const r2 = dispatchSub(f, K2);
    assert.strictEqual(r2.ok, true);
    assert.strictEqual(r2.anchor, null, 'encadeado, sem reancoragem');
    viaFollow(leaseFor(f, r2), 0);
    resetRunning(f);
    write(f.worktree, 'src/fora.js', 'alguém mexeu');
    const r3 = dispatchSub(f, K1);
    assert.deepStrictEqual([r3.ok, r3.reason], [false, 'CHANGED_BETWEEN_ATTEMPTS']);
    // HUMAN_RESUME: retomada de session_limit pelo dashboard (resumed_at) posterior ao anterior.
    const later = new Date(Date.now() + 60_000).toISOString();
    const r4 = dispatchSub(f, K1, { state: { resumed_at: later } });
    assert.deepStrictEqual([r4.ok, r4.anchor.reason, r4.anchor.by], [true, 'HUMAN_RESUME', 'dashboard:resume-session']);
    assert.strictEqual(dom06.readAttempt(r4.admission.attemptFile).chain_anchor.reason, 'HUMAN_RESUME');
});

test('AC-43: SCOPE_CHANGED — replan sem mudança no escopo antigo reancora; com mudança bloqueia', () => {
    const f = fixture();
    const r1 = dispatchSub(f);
    viaFollow(leaseFor(f, r1), 0);
    resetRunning(f);
    const replan = key => rt.prepareRoleDispatch({ runDir: f.runDir, checkoutRoot: f.checkout, task: f.task, worktree: f.worktree,
        decomposition: { role: 'subtask', plan_version: PV2, subtask_key: key }, scopePaths: ['lib'], dispatch: DISPATCH, env });
    const ok = replan(`${PV2.slice(0, 12)}/1-1`);
    assert.deepStrictEqual([ok.ok, ok.anchor && ok.anchor.reason], [true, 'SCOPE_CHANGED']);
    viaFollow(leaseFor(f, ok), 0);
    resetRunning(f);
    // Mudança no escopo antigo (src) entre Attempts, com novo replan.
    const f2 = fixture();
    const a = dispatchSub(f2);
    viaFollow(leaseFor(f2, a), 0);
    resetRunning(f2);
    write(f2.worktree, 'src/mudou.js', 'x');
    const bad = rt.prepareRoleDispatch({ runDir: f2.runDir, checkoutRoot: f2.checkout, task: f2.task, worktree: f2.worktree,
        decomposition: { role: 'subtask', plan_version: PV2, subtask_key: `${PV2.slice(0, 12)}/1-1` }, scopePaths: ['lib'], dispatch: DISPATCH, env });
    assert.deepStrictEqual([bad.ok, bad.reason], [false, 'SCOPE_CHANGED_WITH_MUTATION']);
});

test('AC-43: anterior sem post (saída não fechada) = UNKNOWN, nunca início de cadeia', () => {
    const f = fixture();
    dispatchSub(f);
    const r2 = dispatchSub(f, K2);
    assert.deepStrictEqual([r2.ok, r2.reason], [false, 'PREVIOUS_POST_UNKNOWN']);
});

// ---------------------------------------------------------------- AC-45 (passo 0b)

test('AC-45: papel do subagente por meta.json + tool_use; divergência → CONFLICTED; sem meta → UNKNOWN', () => {
    const main = [
        { type: 'assistant', message: { model: 'opus', content: [{ type: 'tool_use', id: 'tu1', name: 'Agent', input: { subagent_type: 'test-writer' } }] } },
        { type: 'assistant', message: { model: 'opus', content: [{ type: 'tool_use', id: 'tu2', name: 'Agent', input: { subagent_type: 'security-reviewer' } }] } },
    ].map(o => JSON.stringify(o)).join('\n');
    const sub = model => [{ type: 'user', message: { content: 'x' } }, { type: 'assistant', message: { model, content: [] } }].map(o => JSON.stringify(o)).join('\n');
    const out = costTracking.subagentRoleAttribution({ main, subagents: [
        { file_ref: 'agent-1.jsonl', content: sub('sonnet'), meta: { agentType: 'test-writer', toolUseId: 'tu1' } },
        { file_ref: 'agent-2.jsonl', content: sub('haiku'), meta: { agentType: 'test-writer', toolUseId: 'tu2' } },
        { file_ref: 'agent-3.jsonl', content: sub('haiku'), meta: { agentType: 'Explore' } },
        { file_ref: 'agent-4.jsonl', content: sub('haiku'), meta: null },
    ] });
    assert.deepStrictEqual(out, [
        { file_ref: 'agent-1.jsonl', role: 'test-writer', provenance: 'META+TOOL_USE', models: ['sonnet'] },
        { file_ref: 'agent-2.jsonl', role: null, provenance: 'CONFLICTED', models: ['haiku'] },
        { file_ref: 'agent-3.jsonl', role: 'Explore', provenance: 'META', models: ['haiku'] },
        { file_ref: 'agent-4.jsonl', role: null, provenance: 'UNKNOWN', models: ['haiku'] },
    ]);
});

test('AC-45: agregados legados, usage[] e read_order de sumClaudeUsage não mudam', () => {
    const files = [
        { role: 'main', file_ref: 'main', content: JSON.stringify({ type: 'assistant', timestamp: '2026-11-09T10:00:00Z', message: { id: 'm1', model: 'claude-opus-4-1', usage: { input_tokens: 10, output_tokens: 5 } } }) },
        { role: 'subagent', file_ref: 'agent-1.jsonl', content: JSON.stringify({ type: 'assistant', timestamp: '2026-11-09T10:00:01Z', message: { id: 'm2', model: 'claude-sonnet-4-5', usage: { input_tokens: 3, output_tokens: 2 } } }) },
    ];
    const golden = path.join(__dirname, '..', 'fixtures', 'cost-usage-golden-pri311.json');
    const got = costTracking.sumClaudeUsage(files);
    const shape = { input_tokens: got.input_tokens, output_tokens: got.output_tokens, models: got.models, usage: got.usage, read_order: got.read_order };
    // O golden foi gerado em cc72b55 (antes desta fatia) com a mesma entrada.
    assert.deepStrictEqual(shape, JSON.parse(fs.readFileSync(golden, 'utf8')));
});
