// node --test scripts/invalidate-concurrency.test.js
// Dependency Invalidation sob concorrência (scripts/invalidate.js): R1–R7. Determinístico —
// a intercalação entre o nó em execução e a SPEC_CHANGE é forçada passo a passo (cópia do
// state lida "antes", escrita "depois"; spy na escrita da spec), sem sleep nem timing.
// Repo sintético, libs e CLIs reais, nenhum Redmine/agente.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const inv = require('./invalidate');
const sa = require('./lib/spec-authority');
const sc = require('./lib/spec-change');

const SPEC = `---
spec_template_version: 1
ticket: 43700
---
# Ticket #43700 — Desconto por volume

## Objetivo
Transportadora vê o desconto aplicado.

## Critérios de Aceite
- AC-01: Fretes com mais de 10 volumes recebem 5% de desconto.
- AC-02: O relatório exibe o desconto aplicado por frete.

## Restrições
- Não alterar o contrato do endpoint de cotação.
`;
const ADD_AC03 = {
    type: 'SPEC_CHANGE', description: 'Adicionar critério de exportação CSV', rationale: 'PO pediu na daily',
    previous_behavior: 'sem exportação', proposed_behavior: 'exportação CSV com a coluna de desconto',
    ac_changes: [{ action: 'add', text: 'Exportação CSV inclui a coluna de desconto.' }],
};
const RULE_ONLY = {
    type: 'SPEC_CHANGE', description: 'Muda a regra de negócio de arredondamento', rationale: 'fiscal pediu',
    previous_behavior: 'arredonda para cima', proposed_behavior: 'arredonda para o par mais próximo',
};

const sandbox = fs.mkdtempSync(path.join(process.env.CLAUDE_JOB_DIR ? path.join(process.env.CLAUDE_JOB_DIR, 'tmp') : os.tmpdir(), 'invalidate-race-'));
const readJson = f => JSON.parse(fs.readFileSync(f, 'utf8'));
const stateOf = dir => readJson(path.join(dir, 'state.json'));
const writeState = (dir, s) => fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify(s, null, 2));
const cli = (script, args) => spawnSync(process.execPath, [path.join(__dirname, script), ...args], { encoding: 'utf8' });
let seq = 0;

/** /fetch-ticket (init) + /plan (baseline sela v1) + plan.md/handoff.md. */
function seedRun({ root = path.join(sandbox, `repo-${++seq}`), taskId = `43700-r-${++seq}` } = {}) {
    const dir = path.join(root, 'memory', 'runs', taskId);
    fs.mkdirSync(dir, { recursive: true });
    fs.mkdirSync(path.join(root, 'memory', 'spec'), { recursive: true });
    const specFile = path.join(root, 'memory', 'spec', '43700-spec.md');
    if (!fs.existsSync(specFile)) fs.writeFileSync(specFile, SPEC);
    writeState(dir, {
        task_id: taskId, node: 'plan', history: ['fetch_ticket'], status: 'in_progress', started_at: '2026-10-01T10:00:00.000Z',
        redmine_ticket: { id: 43700, subject: 'Desconto', tracker: 'Melhoria', base_branch: 'development' },
    });
    assert.strictEqual(cli('lib/spec-version.js', ['init', dir]).status, 0);
    assert.strictEqual(cli('lib/spec-authority.js', ['baseline', dir]).status, 0);
    fs.writeFileSync(path.join(dir, 'plan.md'), '# Plano\n\nACs: AC-01, AC-02\n\n## Plano de execução\n1. Desconto. Critérios: AC-01, AC-02\n');
    fs.writeFileSync(path.join(dir, 'handoff.md'), '# Handoff\n\n- Spec: memory/spec/43700-spec.md\n- ACs: AC-01, AC-02\n');
    return { root, taskId, dir, specFile };
}

/** O run A propõe e aprova a SPEC_CHANGE (o watcher faria o mesmo ao ler "aprovado"). */
function approve(a, decision, at = new Date().toISOString()) {
    const st = stateOf(a.dir);
    Object.assign(st, { node: 'implement', status: 'in_progress' });
    writeState(a.dir, st);
    assert.strictEqual(sc.recordDecision(a.dir, decision).paused, true);
    const out = sc.approveSpecChange(a.dir, { by: 'po.fulano', at });
    assert.ok(out.ok, out.error);
    return out;
}

/** Run B com um nó em execução, como o lease do watcher deixa (execution_spec = spec do despacho). */
function startNode(b, node) {
    const s = stateOf(b.dir);
    const active = inv.activeSpec(b.root, s, b.taskId);
    Object.assign(s, { node, status: 'running', node_started_at: '2026-10-01T11:59:00.000Z', execution_spec: inv.executionSpec(node, active) });
    writeState(b.dir, s);
    return s;
}

// ── R1 ───────────────────────────────────────────────────────────────────────────
test('R1. Plan lê state antigo → invalidation chega → Plan grava: pending_invalidation preservado e plano nunca VALID', () => {
    const a = seedRun();
    const b = seedRun({ root: a.root, taskId: '43700-b-r1' });
    startNode(b, 'plan');
    // T0: o CLI baseline do /plan em B lê o state.
    const inflight = stateOf(b.dir);
    // T1: SPEC_CHANGE aprovada em A grava a transição para B.
    const out = approve(a, ADD_AC03);
    assert.deepStrictEqual(out.propagated, [{ task: '43700-b-r1', case: 'plan_phase' }]);
    // T2: o plan de B persiste o resultado a partir da cópia lida em T0 (hash do disco = v2).
    sa.applyBaseline(inflight, { root: b.root, specPath: 'memory/spec/43700-spec.md', taskId: b.taskId });
    Object.assign(inflight, { node: 'implement', status: 'in_progress' });
    writeState(b.dir, inflight);
    // T3: a transição continua existindo...
    const disk = stateOf(b.dir);
    const pending = inv.pendingTransitions(disk, b.dir);
    assert.deepStrictEqual(pending.map(p => [p.transition_id, p.case]), [[`SC-001@${a.taskId}`, 'plan_phase']]);
    // ...e o plano produzido pela execução antiga não ficou VALID para a spec nova.
    assert.strictEqual(disk.artifact_validity.plan.validity.status, 'STALE');
    assert.strictEqual(inv.guardVerify(disk, null, { runDir: b.dir }).code, 'PENDING_SPEC_INVALIDATION');
    // Próximo despacho do watcher: aplica e replaneja.
    assert.strictEqual(inv.resolvePendingInvalidation(disk, { runDir: b.dir }).resolved, true);
    assert.strictEqual(disk.node, 'plan');
    assert.strictEqual(disk.artifact_validity.plan.validity.status, 'STALE');
    assert.strictEqual(disk.spec.version, 2);
});

// ── R2 ───────────────────────────────────────────────────────────────────────────
test('R2. Spec v2 escrita → Plan observa v2 → propagação: o run continua participante da transição e replaneja', () => {
    const a = seedRun();
    const b = seedRun({ root: a.root, taskId: '43700-b-r2' });
    startNode(b, 'plan');
    // Spy na escrita da spec: no instante em que a v2 chega ao disco, B já tem a transição.
    const realWrite = fs.writeFileSync;
    let atSpecWrite = null;
    fs.writeFileSync = function (file, ...rest) {
        if (path.resolve(String(file)) === path.resolve(a.specFile)) atSpecWrite = inv.readJournal(b.dir).map(e => e.transition_id);
        return realWrite.call(this, file, ...rest);
    };
    try { approve(a, ADD_AC03); } finally { fs.writeFileSync = realWrite; }
    assert.deepStrictEqual(atSpecWrite, [`SC-001@${a.taskId}`], 'transição registrada ANTES da spec nova ser gravada');
    // O plan de B observa a v2 (lê o disco depois da escrita) e carimba com o hash novo.
    const s = stateOf(b.dir);
    sa.applyBaseline(s, { root: b.root, specPath: 'memory/spec/43700-spec.md', taskId: b.taskId });
    assert.strictEqual(inv.classify(s.spec_hash, inv.activeSpec(b.root, s, b.taskId).hash), 'VALID', 'B observou o hash v2');
    assert.strictEqual(s.artifact_validity.plan.validity.status, 'STALE', 'observar v2 não é ter participado da transição');
    Object.assign(s, { node: 'implement', status: 'in_progress' });
    assert.strictEqual(inv.resolvePendingInvalidation(s, { runDir: b.dir }).resolved, true);
    assert.strictEqual(s.node, 'plan', 'replaneja');

    // E a propagação nunca pula um run só porque ele já tem o hash novo.
    const c = seedRun({ root: path.join(sandbox, `repo-r2c-${++seq}`), taskId: '43700-c-r2' });
    const sc2 = startNode(c, 'plan');
    const res = inv.propagateSpecChange({
        runsDir: path.dirname(c.dir), specPath: 'memory/spec/43700-spec.md', specRelFor: sa.specRelFor,
        oldSpec: { hash: 'a'.repeat(64), version: 1 }, newSpec: { hash: sc2.spec.hash, version: 2 },
        triggeredBy: 'SPEC_CHANGE SC-777', transitionId: 'SC-777@outro',
    });
    assert.deepStrictEqual(res, [{ task: '43700-c-r2', case: 'plan_phase' }]);
    assert.strictEqual(inv.pendingTransitions(stateOf(c.dir), c.dir).length, 1);
});

// ── R3 ───────────────────────────────────────────────────────────────────────────
test('R3. Nó começa em v1 → spec muda para v2 → nó termina: artefato NÃO fica VALID(v2)', () => {
    const r = seedRun();
    // /test despachado sob v1 (execution_spec gravada no lease).
    const s = startNode(r, 'test');
    const v1 = s.execution_spec.spec_hash;
    // A spec vira v2 durante a execução e o state.spec acompanha (sem pendência no journal).
    const v2Content = SPEC.replace('- AC-02:', '- AC-03: Exportação CSV inclui a coluna de desconto.\n- AC-02:');
    fs.writeFileSync(r.specFile, v2Content);
    const v2 = sa.specHashFor(s, v2Content);
    assert.notStrictEqual(v1, v2);
    Object.assign(s.spec, { hash: v2, version: 2 });
    writeState(r.dir, s);
    // O /test termina: finalize hasheia o disco (v2) — execução v1 + spec v2 no fim ≠ VALID(v2).
    fs.writeFileSync(path.join(r.dir, 'acceptance-evidence.json'), JSON.stringify({
        schema_version: 1, run_id: r.taskId,
        coverage: Object.fromEntries(['AC-01', 'AC-02', 'AC-03'].map(id => [id, { status: 'PASS', evidence: [{ description: `manual ${id}`, type: 'manual', result: 'PASS' }] }])),
    }));
    cli('lib/acceptance-evidence.js', ['finalize', r.dir]);
    const after = stateOf(r.dir);
    assert.strictEqual(readJson(path.join(r.dir, 'acceptance-evidence.json')).spec_hash, v2, 'carimbou o hash do disco no fim');
    assert.strictEqual(after.artifact_validity.evidence.validity.status, 'STALE');
    assert.strictEqual(after.artifact_validity.evidence.execution_spec_hash, v1);
    assert.match(after.artifact_validity.evidence.stale_reason, /execução de test começou sob/);
    assert.strictEqual(readJson(path.join(r.dir, 'acceptance-evidence.json')).validity.status, 'STALE');
    assert.strictEqual(inv.guardVerify(after, readJson(path.join(r.dir, 'acceptance-evidence.json')), { runDir: r.dir }).ok, false);
});

// ── R4 ───────────────────────────────────────────────────────────────────────────
test('R4. pending_invalidation existe → Verify manual: BLOCK (e Commit também)', () => {
    const r = seedRun();
    const s = stateOf(r.dir);
    // Evidence VALID na spec atual — só a transição pendente deve bloquear.
    fs.writeFileSync(path.join(r.dir, 'acceptance-evidence.json'), JSON.stringify({
        schema_version: 1, run_id: r.taskId, generated_at: '2026-10-01T11:00:00.000Z', spec_hash: s.spec.hash, spec_version: 1,
        coverage: { 'AC-01': { status: 'PASS', evidence: [{ description: 'x', type: 'manual', result: 'PASS' }] } },
    }));
    inv.stampProduced(s, 'evidence', { specHash: s.spec.hash, specVersion: 1, runDir: r.dir });
    writeState(r.dir, s);
    assert.strictEqual(cli('invalidate.js', ['guard', r.dir, '--phase=verify']).status, 0, 'sem pendência, passa');
    inv.registerTransition(r.dir, { transition_id: 'SC-042@outro', cause: 'spec_change_approved', triggered_by: 'SPEC_CHANGE SC-042', new_spec_hash: 'f'.repeat(64), new_spec_version: 2, old_spec_hash: s.spec.hash, old_spec_version: 1, case: 'idle', phase: 'verify', registered_at: '2026-10-01T12:00:00.000Z' });
    const v = cli('invalidate.js', ['guard', r.dir, '--phase=verify']);
    assert.strictEqual(v.status, 1);
    assert.match(v.stderr, /RECUSADA PENDING_SPEC_INVALIDATION: Transição de contrato pendente \(SC-042@outro: spec v2\)/);
    assert.ok(sa.verifyRun(r.dir, stateOf(r.dir)).failures.some(f => f.code === 'PENDING_SPEC_INVALIDATION'));
    assert.strictEqual(cli('invalidate.js', ['guard', r.dir, '--phase=commit']).status, 1);
    // Mesmo com artifact_validity ainda VALID (não depende dele).
    assert.strictEqual(stateOf(r.dir).artifact_validity.evidence.validity.status, 'VALID');
});

// ── R5 / R6 ──────────────────────────────────────────────────────────────────────
test('R5. SPEC_CHANGE aprovada com hash igual → node=plan', () => {
    const r = seedRun();
    const hash = stateOf(r.dir).spec.hash;
    const out = approve(r, RULE_ONLY);
    const s = stateOf(r.dir);
    assert.strictEqual(s.spec.hash, hash);
    assert.strictEqual(out.specVersion.bumped, false);
    assert.strictEqual(s.node, 'plan');
    assert.strictEqual(s.invalidations.at(-1).hash_scope_changed, false);
    assert.strictEqual(s.artifact_validity.plan.validity.status, 'STALE');
});

test('R6. SPEC_CHANGE aprovada com hash diferente → node=plan', () => {
    const r = seedRun();
    const hash = stateOf(r.dir).spec.hash;
    const out = approve(r, ADD_AC03);
    const s = stateOf(r.dir);
    assert.notStrictEqual(s.spec.hash, hash);
    assert.strictEqual(out.specVersion.version, 2);
    assert.strictEqual(s.node, 'plan');
    assert.strictEqual(s.invalidations.at(-1).hash_scope_changed, true);
    assert.strictEqual(s.artifact_validity.plan.validity.status, 'STALE');
});

// ── R7 ───────────────────────────────────────────────────────────────────────────
test('R7. Run normal sem mudança de spec: artefato novo fica VALID normalmente', () => {
    const r = seedRun();
    for (const [node, phase] of [['implement', 'implement'], ['review', 'review'], ['test', 'evidence'], ['verify', 'verify']]) {
        const s = startNode(r, node);
        inv.stampProduced(s, phase, { specHash: s.spec.hash, specVersion: 1, runDir: r.dir });
        assert.strictEqual(s.artifact_validity[phase].validity.status, 'VALID', phase);
        assert.strictEqual(s.artifact_validity[phase].execution_spec_hash, s.spec.hash);
        Object.assign(s, { status: 'in_progress' });
        writeState(r.dir, s);
    }
    assert.strictEqual(stateOf(r.dir).artifact_validity.plan.validity.status, 'VALID');
    assert.strictEqual(inv.pendingTransitions(stateOf(r.dir), r.dir).length, 0);
    assert.strictEqual(inv.guardPending(stateOf(r.dir), r.dir), null);
});

// ── R8 (achado do review rodada 2) ───────────────────────────────────────────────
for (const [label, decision] of [['hash diferente', ADD_AC03], ['hash igual (INV)', RULE_ONLY]]) {
    test(`R8. Nó manual (sem lease) começa em v1 → SPEC_CHANGE aplicada a ele como ocioso → nó termina: nunca VALID (${label})`, () => {
        const a = seedRun();
        const b = seedRun({ root: a.root, taskId: `43700-b-r8-${++seq}` });
        // /test rodado à mão: status in_progress (sem lease); o portão de drift do nó grava
        // a execution_spec no início (T0).
        const t0 = new Date(Date.now() - 60_000).toISOString();
        const s = stateOf(b.dir);
        s.node = 'test';
        assert.strictEqual(sa.enforceSpecIntegrity(s, { root: b.root, taskId: b.taskId, node: 'test', now: t0 }).proceed, true);
        writeState(b.dir, s);
        assert.deepStrictEqual([stateOf(b.dir).execution_spec.node, stateOf(b.dir).execution_spec.started_at], ['test', t0]);
        // T1: a aprovação em A trata B como ocioso (status in_progress) e aplica na hora.
        const out = approve(a, decision);
        assert.deepStrictEqual(out.propagated.map(p => p.case), ['idle']);
        const mid = stateOf(b.dir);
        assert.strictEqual(mid.execution_spec?.started_at, t0, 'a invalidação não apaga a execution_spec do nó em curso');
        // T2: o /test manual termina e carimba a matriz (hash do disco no fim).
        fs.writeFileSync(path.join(b.dir, 'acceptance-evidence.json'), JSON.stringify({
            schema_version: 1, run_id: b.taskId,
            coverage: Object.fromEntries(sa.specAcs(fs.readFileSync(b.specFile, 'utf8')).acs.filter(x => x.active).map(x => [x.id, { status: 'PASS', evidence: [{ description: `manual ${x.id}`, type: 'manual', result: 'PASS' }] }])),
        }));
        cli('lib/acceptance-evidence.js', ['finalize', b.dir]);
        const end = stateOf(b.dir);
        assert.strictEqual(end.artifact_validity.evidence.validity.status, 'STALE');
        // hash diferente: pega também a regra execution_spec ≠ spec no fim; hash igual: só a
        // regra "começou antes da última invalidação" (o achado do review) segura.
        assert.match(end.artifact_validity.evidence.stale_reason, decision === RULE_ONLY ? /antes da última invalidação/ : /começou sob v1|antes da última invalidação/);
        const g = cli('invalidate.js', ['guard', b.dir, '--phase=verify']);
        assert.strictEqual(g.status, 1, 'o Verify não aceita');
        // O plano novo (despacho/execução depois da invalidação) volta a VALID normalmente.
        const fresh = stateOf(b.dir);
        assert.strictEqual(sa.enforceSpecIntegrity(fresh, { root: b.root, taskId: b.taskId, node: 'plan' }).proceed, true);
    });
}

test('R8b. /plan manual começa em v1 (invalidate.js begin) → SPEC_CHANGE aplicada como ocioso → baseline: plano nunca VALID', () => {
    const a = seedRun();
    const b = seedRun({ root: a.root, taskId: '43700-b-r8b' });
    const s0 = stateOf(b.dir);
    Object.assign(s0, { node: 'plan', status: 'in_progress' });
    writeState(b.dir, s0);
    const begin = cli('invalidate.js', ['begin', b.dir, '--node=plan']);
    assert.strictEqual(begin.status, 0, begin.stderr);
    approve(a, ADD_AC03, new Date(Date.now() + 1000).toISOString());
    const s = stateOf(b.dir);
    assert.strictEqual(s.execution_spec.node, 'plan');
    sa.applyBaseline(s, { root: b.root, specPath: 'memory/spec/43700-spec.md', taskId: b.taskId });
    assert.strictEqual(s.artifact_validity.plan.validity.status, 'STALE');
    assert.match(s.artifact_validity.plan.stale_reason, /começou sob v1|antes da última invalidação/);
});

test.after(() => fs.rmSync(sandbox, { recursive: true, force: true }));
