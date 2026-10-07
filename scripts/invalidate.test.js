// node --test scripts/invalidate.test.js
// Dependency Invalidation (scripts/invalidate.js): os 10 casos obrigatórios da task +
// unidade do resolver, os 3 casos de run em andamento, propagação para runs irmãos,
// replay, legado e credenciais. Repo sintético (<root>/memory/spec + memory/runs), libs
// e CLIs reais (spec-version, spec-authority, spec-change, review-result,
// acceptance-evidence, cycle-replayer), nenhum Redmine/agente.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const inv = require('./invalidate');
const sa = require('./lib/spec-authority');
const sc = require('./lib/spec-change');
const rr = require('./lib/review-result');
const ae = require('./lib/acceptance-evidence');
const replayer = require('./lib/cycle-replayer');
const sv = require('./lib/spec-version');
const sh = require('./lib/spec-hash');
const { validateState } = require('./validate-state');

const SECRET_TOKEN = 'ATATT-test-token-should-never-leak-789';
const SECRET_KEY = 'redmine-key-should-never-leak-012';
const ENV = { ...process.env, BITBUCKET_API_TOKEN: SECRET_TOKEN, REDMINE_API_KEY: SECRET_KEY };

const SPEC = `---
spec_template_version: 1
ticket: 43700
---
# Ticket #43700 — Desconto por volume

## Contexto
Hoje o relatório de fretes não mostra o desconto por volume.

## Objetivo
Transportadora vê o desconto aplicado.

## Critérios de Aceite
- AC-01: Fretes com mais de 10 volumes recebem 5% de desconto.
- AC-02: O relatório exibe o desconto aplicado por frete.

## Restrições
- Não alterar o contrato do endpoint de cotação.
`;

// SPEC_CHANGE que mexe no HASH_SCOPE (AC novo) e uma que não mexe (só Histórico).
const ADD_AC03 = {
    type: 'SPEC_CHANGE', description: 'Adicionar critério de exportação CSV', rationale: 'PO pediu na daily',
    previous_behavior: 'sem exportação', proposed_behavior: 'exportação CSV com a coluna de desconto',
    ac_changes: [{ action: 'add', text: 'Exportação CSV inclui a coluna de desconto.' }],
};
const RULE_ONLY = {
    type: 'SPEC_CHANGE', description: 'Muda a regra de negócio de arredondamento', rationale: 'fiscal pediu',
    previous_behavior: 'arredonda para cima', proposed_behavior: 'arredonda para o par mais próximo',
};

const sandbox = fs.mkdtempSync(path.join(process.env.CLAUDE_JOB_DIR ? path.join(process.env.CLAUDE_JOB_DIR, 'tmp') : os.tmpdir(), 'invalidate-'));
const readJson = f => JSON.parse(fs.readFileSync(f, 'utf8'));
const stateOf = dir => readJson(path.join(dir, 'state.json'));
const writeState = (dir, s) => fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify(s, null, 2));
const cli = (script, args) => spawnSync(process.execPath, [path.join(__dirname, script), ...args], { encoding: 'utf8', env: ENV });
let seq = 0;

/**
 * fetch-ticket (init) → /plan (baseline sela v1) → implement (portão de drift) → review
 * (record) → test (finalize) → verify (--write): todos os artefatos VALID na v1.
 */
function seedRun({ root = path.join(sandbox, `repo-${++seq}`), taskId = `43700-desconto-${++seq}`, downstream = true } = {}) {
    const dir = path.join(root, 'memory', 'runs', taskId);
    fs.mkdirSync(dir, { recursive: true });
    fs.mkdirSync(path.join(root, 'memory', 'spec'), { recursive: true });
    const specFile = path.join(root, 'memory', 'spec', '43700-spec.md');
    if (!fs.existsSync(specFile)) fs.writeFileSync(specFile, SPEC);
    writeState(dir, {
        task_id: taskId, node: 'plan', history: ['fetch_ticket'], status: 'in_progress',
        started_at: '2026-10-01T10:00:00.000Z', ac_ids: [],
        redmine_ticket: { id: 43700, subject: 'Desconto por volume', tracker: 'Melhoria', base_branch: 'development' },
    });
    assert.strictEqual(cli('lib/spec-version.js', ['init', dir]).status, 0);
    const base = cli('lib/spec-authority.js', ['baseline', dir]);
    assert.strictEqual(base.status, 0, base.stderr);
    const prLine = /Spec: .*spec_hash=\w+/.exec(base.stdout)?.[0] || '';
    fs.writeFileSync(path.join(dir, 'plan.md'), `# Plano\n\n${prLine}\nACs: AC-01, AC-02\n\n## Plano de execução\n1. Desconto. Critérios: AC-01, AC-02\n`);
    fs.writeFileSync(path.join(dir, 'handoff.md'), '# Handoff\n\n- Spec: memory/spec/43700-spec.md\n- ACs: AC-01, AC-02\n');
    const r = { root, taskId, dir, specFile };
    if (downstream) produceDownstream(r);
    return r;
}

function produceDownstream(r, { acs = ['AC-01', 'AC-02'] } = {}) {
    // implement: portão de drift do nó carimba o spec_hash com que ele roda
    let st = stateOf(r.dir);
    st.node = 'implement';
    assert.strictEqual(sa.enforceSpecIntegrity(st, { root: r.root, taskId: r.taskId, node: 'implement' }).proceed, true);
    writeState(r.dir, st);
    recordReview(r, acs);
    writeMatrix(r, acs);
    const fin = cli('lib/acceptance-evidence.js', ['finalize', r.dir]);
    assert.strictEqual(fin.status, 0, fin.stderr + fin.stdout);
    st = stateOf(r.dir);
    st.node = 'verify';
    writeState(r.dir, st);
    cli('lib/spec-authority.js', ['verify', r.dir, '--write']); // carimba o verify (veredito não importa aqui)
}

function recordReview(r, acs) {
    const ctx = rr.loadContext(r.dir);
    const t = rr.template(ctx);
    t.spec_compliance.acs = acs.map(id => ({ id, result: 'PASS', evidence: 'src/main/java/Frete.java:10' }));
    for (const k of Object.keys(t.spec_compliance.checks)) t.spec_compliance.checks[k] = { result: 'PASS', note: 'conferido no diff' };
    t.divergences = [];
    t.engineering.items = t.engineering.items.map(i => ({ n: i.n, result: 'PASS', note: 'conferido no diff' }));
    t.engineering.findings = [];
    const { errors, result } = rr.evaluate(t, { activeAcs: ctx.activeAcs, knownAcs: ctx.knownAcs, specApplies: ctx.specApplies, decisions: ctx.decisions.valid, implementDecisions: ctx.implementDecisions });
    assert.deepStrictEqual(errors, []);
    return rr.record(r.dir, ctx, result);
}

function writeMatrix(r, acs) {
    fs.writeFileSync(path.join(r.dir, 'acceptance-evidence.json'), JSON.stringify({
        schema_version: 1, run_id: r.taskId,
        coverage: Object.fromEntries(acs.map(id => [id, { status: 'PASS', evidence: [{ description: `verificação manual de ${id}`, type: 'manual', result: 'PASS' }] }])),
    }, null, 2));
}

function proposeAndApprove(r, decision, { at = new Date().toISOString() } = {}) {
    const st = stateOf(r.dir);
    st.node = 'implement';
    st.status = 'in_progress';
    writeState(r.dir, st);
    const rec = sc.recordDecision(r.dir, decision);
    assert.deepStrictEqual(rec.errors, []);
    assert.strictEqual(rec.paused, true);
    const out = sc.approveSpecChange(r.dir, { by: 'po.fulano', at });
    assert.ok(out.ok, out.error);
    return out;
}

const statuses = st => Object.fromEntries(inv.PHASES.map(p => [p, st.artifact_validity?.[p]?.validity?.status]));
const ALL_VALID = Object.fromEntries(inv.PHASES.map(p => [p, 'VALID']));
const ALL_STALE = Object.fromEntries(inv.PHASES.map(p => [p, 'STALE']));

// ── Unidade ──────────────────────────────────────────────────────────────────────

test('classify: única comparação — igual/prefixo = VALID, diferente = STALE, sem hash = UNKNOWN', () => {
    const h = 'a'.repeat(64);
    assert.strictEqual(inv.classify(h, h), 'VALID');
    assert.strictEqual(inv.classify(h.slice(0, 12), h), 'VALID', 'artefato com hash abreviado');
    assert.strictEqual(inv.classify(h, 'b'.repeat(64)), 'STALE');
    assert.strictEqual(inv.classify(null, h), 'UNKNOWN');
    assert.strictEqual(inv.classify(h, null), 'UNKNOWN');
    assert.strictEqual(inv.classify('abc', h), 'UNKNOWN', 'prefixo curto demais não prova nada');
});

test('stampProduced: só artefato novo volta a VALID; refresh nunca promove STALE', () => {
    const st = { task_id: '1-x', node: 'plan', history: [], status: 'in_progress', spec_hash: 'a'.repeat(64) };
    inv.stampProduced(st, 'evidence', { specHash: 'a'.repeat(64) });
    assert.strictEqual(st.artifact_validity.evidence.validity.status, 'VALID');
    st.spec_hash = 'b'.repeat(64); // spec mudou (rebaseline)
    assert.strictEqual(inv.refresh(st), true);
    assert.strictEqual(st.artifact_validity.evidence.validity.status, 'STALE');
    st.spec_hash = 'a'.repeat(64); // voltou: STALE é pegajoso, nada ressuscita
    inv.refresh(st);
    assert.strictEqual(st.artifact_validity.evidence.validity.status, 'STALE');
    inv.stampProduced(st, 'evidence', { specHash: 'a'.repeat(64) });
    assert.strictEqual(st.artifact_validity.evidence.validity.status, 'VALID');
});

// ── 1 ────────────────────────────────────────────────────────────────────────────
test('1. SPEC_CHANGE fora do HASH_SCOPE: versão e hash mantidos, mas INV-SPEC-CHANGE-REPLAN — artefatos STALE e node=plan', () => {
    // Decisão humana (rodada de correção do review): hash igual não prova que os artefatos
    // continuam válidos — applyToSpec grava a regra nova só no Histórico, fora do hash.
    const r = seedRun();
    const before = stateOf(r.dir);
    assert.deepStrictEqual(statuses(before), ALL_VALID);
    const hashBefore = before.spec.hash;
    const out = proposeAndApprove(r, RULE_ONLY);
    assert.strictEqual(out.specVersion.bumped, false, 'versão não incrementa (HASH_SCOPE inalterado)');
    const s = stateOf(r.dir);
    assert.strictEqual(s.spec.version, 1);
    assert.strictEqual(s.spec.hash, hashBefore, 'hash contratual igual');
    assert.match(fs.readFileSync(r.specFile, 'utf8'), /## Histórico de Mudanças[\s\S]*arredonda para o par mais próximo/, 'a regra nova está só no Histórico');
    assert.strictEqual(out.invalidation.case, 'idle');
    assert.strictEqual(s.node, 'plan', 'reentrada obrigatória pelo Plan');
    assert.deepStrictEqual(statuses(s), ALL_STALE, 'hash igual não mantém VALID');
    assert.deepStrictEqual(s.stale_artifacts, ['plan.md', 'handoff.md', 'acceptance-evidence.json']);
    const last = s.invalidations.at(-1);
    assert.deepStrictEqual([last.hash_scope_changed, last.cause, last.new_spec_version], [false, 'spec_change_approved', 1]);
    assert.match(s.artifact_validity.evidence.stale_reason, /INV-SPEC-CHANGE-REPLAN/);
    assert.strictEqual(readJson(path.join(r.dir, 'acceptance-evidence.json')).validity.status, 'STALE');
    const g = inv.guardVerify(s, readJson(path.join(r.dir, 'acceptance-evidence.json')), { runDir: r.dir });
    assert.strictEqual(g.code, 'EVIDENCE_SPEC_STALE');
    assert.match(g.message, /invalidada por SPEC_CHANGE aprovada/);
});

// ── 2 ────────────────────────────────────────────────────────────────────────────
test('2. SPEC_CHANGE no HASH_SCOPE: Plan, Implement, Review, evidence e Verify STALE; state.node=plan', () => {
    const r = seedRun();
    const evFile = path.join(r.dir, 'acceptance-evidence.json');
    const mtime = fs.statSync(evFile).mtimeMs;
    const out = proposeAndApprove(r, ADD_AC03);
    assert.strictEqual(out.invalidation.case, 'idle');
    assert.strictEqual(out.specVersion.version, 2);
    const s = stateOf(r.dir);
    assert.deepStrictEqual(statuses(s), ALL_STALE);
    for (const p of inv.PHASES) {
        assert.strictEqual(s.artifact_validity[p].validity.stale_since_version, 2, p);
        assert.strictEqual(s.artifact_validity[p].spec_version, 1, `${p} continua dizendo contra o que foi produzido`);
    }
    assert.strictEqual(s.node, 'plan');
    assert.strictEqual(s.status, 'in_progress');
    assert.deepStrictEqual(s.stale_artifacts, ['plan.md', 'handoff.md', 'acceptance-evidence.json']);
    assert.strictEqual(s.review_results.validity.status, 'STALE', 'espelho no review');
    assert.strictEqual(s.spec_conformance.validity.status, 'STALE', 'espelho no verify');
    const ev = readJson(evFile);
    assert.strictEqual(ev.validity.status, 'STALE', 'espelho na matriz');
    assert.ok(fs.statSync(evFile).mtimeMs <= mtime + 0.01 && fs.statSync(evFile).mtimeMs > mtime - 1, 'marcar não é regerar (mtime preservado)');
    const last = s.invalidations.at(-1);
    assert.deepStrictEqual([last.old_spec_version, last.new_spec_version, last.case, last.triggered_by], [1, 2, 'idle', 'SPEC_CHANGE SC-001']);
    assert.ok(s.events.some(e => e.type === 'artifacts_invalidated'));
    assert.ok(validateState(s).valid, JSON.stringify(validateState(s).errors));
    // Watcher: o /plan despachado recebe a nota da invalidação.
    assert.match(inv.promptNote(s), /v1 → v2, SPEC_CHANGE SC-001\).*STALE/);
});

// ── 3 ────────────────────────────────────────────────────────────────────────────
test('3. SPEC_CHANGE rejeitada: nenhum artefato invalidado, nenhuma mudança de validade no state.json', () => {
    const r = seedRun();
    const st = stateOf(r.dir);
    st.node = 'implement';
    writeState(r.dir, st);
    assert.strictEqual(sc.recordDecision(r.dir, ADD_AC03).paused, true);
    const before = stateOf(r.dir);
    const evidenceBefore = fs.readFileSync(path.join(r.dir, 'acceptance-evidence.json'), 'utf8');
    assert.ok(sc.rejectSpecChange(r.dir, { by: 'po.fulano', at: '2026-10-01T12:00:00.000Z' }).ok);
    const s = stateOf(r.dir);
    assert.deepStrictEqual(s.artifact_validity, before.artifact_validity);
    assert.deepStrictEqual(statuses(s), ALL_VALID);
    for (const k of ['invalidations', 'pending_invalidation', 'stale_artifacts', 'stale_since']) assert.strictEqual(s[k], undefined, k);
    assert.strictEqual(s.node, 'implement');
    assert.strictEqual(s.spec.version, 1);
    assert.strictEqual(fs.readFileSync(path.join(r.dir, 'acceptance-evidence.json'), 'utf8'), evidenceBefore);
});

// ── 4 ────────────────────────────────────────────────────────────────────────────
test('4. v1 → v2 → novo Plan: artefatos do novo ciclo VALID com o spec_hash da v2', () => {
    const r = seedRun();
    proposeAndApprove(r, ADD_AC03);
    const v2 = stateOf(r.dir).spec.hash;
    const base = cli('lib/spec-authority.js', ['baseline', r.dir]);
    assert.strictEqual(base.status, 0, base.stderr);
    let s = stateOf(r.dir);
    assert.strictEqual(s.artifact_validity.plan.validity.status, 'VALID');
    assert.strictEqual(s.artifact_validity.plan.spec_hash, v2);
    assert.strictEqual(s.artifact_validity.plan.spec_version, 2);
    assert.deepStrictEqual(s.artifact_validity.plan.validity, { status: 'VALID', stale_since_version: null, stale_acs: [] });
    for (const p of ['implement', 'review', 'evidence', 'verify']) assert.strictEqual(s.artifact_validity[p].validity.status, 'STALE', `${p} da v1 continua STALE`);
    // implement e review do ciclo novo
    s.node = 'implement';
    writeState(r.dir, s);
    assert.strictEqual(sa.enforceSpecIntegrity(s, { root: r.root, taskId: r.taskId, node: 'implement' }).proceed, true);
    writeState(r.dir, s);
    recordReview(r, ['AC-01', 'AC-02', 'AC-03']);
    s = stateOf(r.dir);
    for (const p of ['plan', 'implement', 'review']) {
        assert.strictEqual(s.artifact_validity[p].validity.status, 'VALID', p);
        assert.strictEqual(s.artifact_validity[p].spec_hash, v2, p);
    }
    assert.strictEqual(s.review_results.compliance_valid, true);
});

// ── 5 ────────────────────────────────────────────────────────────────────────────
test('5. Novo Test na v2 substitui o STALE: evidence antiga STALE, nova VALID com spec_hash da v2', () => {
    const r = seedRun();
    proposeAndApprove(r, ADD_AC03);
    const v2 = stateOf(r.dir).spec.hash;
    const evFile = path.join(r.dir, 'acceptance-evidence.json');
    const old = readJson(evFile);
    assert.strictEqual(old.validity.status, 'STALE');
    assert.notStrictEqual(old.spec_hash, v2);
    writeMatrix(r, ['AC-01', 'AC-02', 'AC-03']);
    const fin = cli('lib/acceptance-evidence.js', ['finalize', r.dir]);
    assert.strictEqual(fin.status, 0, fin.stderr);
    const fresh = readJson(evFile);
    assert.strictEqual(fresh.spec_hash, v2);
    assert.strictEqual(fresh.spec_version, 2);
    assert.deepStrictEqual(fresh.validity, { status: 'VALID', stale_since_version: null, stale_acs: [] });
    const s = stateOf(r.dir);
    assert.strictEqual(s.artifact_validity.evidence.validity.status, 'VALID');
    assert.strictEqual(s.artifact_validity.evidence.spec_hash, v2);
    assert.strictEqual(inv.guardVerify(s, fresh).ok, true);
});

// ── 6 ────────────────────────────────────────────────────────────────────────────
test('6. Verify recusa evidence STALE (spec_hash divergente): mensagem clara, ciclo não avança', () => {
    const r = seedRun();
    proposeAndApprove(r, ADD_AC03);
    const s = stateOf(r.dir);
    const ev = readJson(path.join(r.dir, 'acceptance-evidence.json'));
    const g = inv.guardVerify(s, ev);
    assert.strictEqual(g.ok, false);
    assert.strictEqual(g.code, 'EVIDENCE_SPEC_STALE');
    assert.strictEqual(g.message, 'Evidence produzida contra Spec v1, Spec atual é v2. Execute novo ciclo.');
    // Guard da fase (verify.md) e o verify determinístico reprovam com a mesma mensagem.
    const guard = cli('invalidate.js', ['guard', r.dir, '--phase=verify']);
    assert.strictEqual(guard.status, 1);
    assert.match(guard.stderr, /RECUSADA EVIDENCE_SPEC_STALE: Evidence produzida contra Spec v1, Spec atual é v2\. Execute novo ciclo\./);
    const result = sa.verifyRun(r.dir, s);
    assert.strictEqual(result.verdict, 'FAIL');
    assert.ok(result.failures.some(f => f.code === 'EVIDENCE_SPEC_STALE' && f.message === g.message), JSON.stringify(result.failures));
    const verify = cli('lib/spec-authority.js', ['verify', r.dir]);
    assert.strictEqual(verify.status, 1, 'exit 1 = Verify falha; o grafo não segue para o commit');
    // Mesmo com o hash igual, registro STALE (invalidado) nunca é aceito como VALID.
    const forged = { ...ev, spec_hash: s.spec.hash, spec_version: 2 };
    assert.strictEqual(inv.guardVerify(s, forged).code, 'EVIDENCE_SPEC_STALE');
});

// ── 7 ────────────────────────────────────────────────────────────────────────────
function seedReplayable({ evidenceSpecHash } = {}) {
    const repoPath = path.join(sandbox, `replay-repo-${++seq}`);
    const worktree = path.join(repoPath, '.claude', 'worktrees', '43700');
    const r = seedRun({ root: worktree, taskId: `43700-replay-src-${seq}` });
    const st = stateOf(r.dir);
    Object.assign(st, { status: 'committed', node: 'commit', history: ['fetch_ticket', 'plan', 'implement', 'review', 'test', 'verify', 'commit'] });
    writeState(r.dir, st);
    if (evidenceSpecHash !== undefined) {
        const ev = readJson(path.join(r.dir, 'acceptance-evidence.json'));
        if (evidenceSpecHash === null) { delete ev.spec_hash; delete ev.validity; } else ev.spec_hash = evidenceSpecHash;
        fs.writeFileSync(path.join(r.dir, 'acceptance-evidence.json'), JSON.stringify(ev, null, 2));
        delete st.artifact_validity.evidence;
        writeState(r.dir, st);
    }
    return { ...r, repoPath, worktree };
}

test('7. Replay com evidence antiga: evidence marcada STALE, nova evidence produzida — a antiga não é ressuscitada', async () => {
    const r = seedReplayable();
    const originalEvidence = fs.readFileSync(path.join(r.dir, 'acceptance-evidence.json'), 'utf8');
    const originalState = fs.readFileSync(path.join(r.dir, 'state.json'), 'utf8');
    // SPEC_CHANGE aprovada depois do ciclo original: spec ativa mudou no worktree (v2 no changelog).
    const v2Spec = SPEC.replace('- AC-02:', '- AC-03: Exportação CSV inclui a coluna de desconto.\n- AC-02:');
    fs.writeFileSync(r.specFile, v2Spec);
    const block = stateOf(r.dir).spec;
    const appended = sv.appendVersion(r.worktree, block.changelog_path, {
        version: 2, hash: sh.contractHash(v2Spec, { scope: block.hash_scope }), hash_scope: block.hash_scope, created_at: '2026-10-02T08:00:00.000Z',
        created_by: 'spec-change-approval', run_id: 'outro-run', reason: 'SPEC_CHANGE SC-001', approval_ref: 'spec-change-audit.json#entry-2',
        spec_change_id: 'SC-001', diff_summary: 'AC-03 adicionado', fingerprint: sh.fingerprint(v2Spec, { scope: block.hash_scope }),
    }, { spec_id: block.id, spec_path: block.path });
    assert.ok(appended.ok, appended.error);
    const opts = { repoPath: r.repoPath, worktreeRegistered: () => true, now: '2026-10-02T09:00:00.000Z' };
    const plan = replayer.planReplay(r.taskId, 'verify', opts);
    assert.strictEqual(plan.fromNode, 'plan', 'replay usa a spec ATIVA: recomeça no plan');
    assert.ok(plan.warnings.some(w => /Spec ativa .* diferente da do run original/.test(w)), plan.warnings.join(' | '));
    const { state } = replayer.loadStateForReplay(r.taskId, 'verify', opts);
    assert.strictEqual(state.replayOf.requestedFrom, 'verify');
    assert.strictEqual(state.artifact_validity.evidence.validity.status, 'STALE');
    const out = await replayer.replayFrom(r.taskId, 'verify', state, opts);
    assert.strictEqual(out.fromNode, 'plan');
    assert.ok(out.nodesToRun.includes('test'), 'o test roda de novo: evidence nova');
    const replayed = stateOf(out.replayDir);
    assert.strictEqual(replayed.node, 'plan');
    assert.strictEqual(replayed.artifact_validity.evidence.validity.status, 'STALE');
    assert.strictEqual(replayed.spec.hash, sh.contractHash(v2Spec, { scope: block.hash_scope }), 'state.spec do replay acompanha a spec ativa');
    assert.strictEqual(replayed.spec.version, 2);
    assert.strictEqual(replayed.artifact_validity.evidence.validity.stale_since_version, 2);
    assert.ok(out.warnings.some(w => /Spec ativa \(v2\) diferente da do run original \(v1\)/.test(w)), out.warnings.join(' | '));
    assert.deepStrictEqual(replayed.stale_artifacts, ['plan.md', 'handoff.md', 'acceptance-evidence.json']);
    const copy = readJson(path.join(out.replayDir, 'acceptance-evidence.json'));
    assert.strictEqual(copy.validity.status, 'STALE', 'a cópia no replay é marcada');
    assert.strictEqual(inv.guardVerify(replayed, copy).ok, false, 'Verify do replay nunca a aceita');
    // Original intocado (nunca reescrito).
    assert.strictEqual(fs.readFileSync(path.join(r.dir, 'acceptance-evidence.json'), 'utf8'), originalEvidence);
    assert.strictEqual(fs.readFileSync(path.join(r.dir, 'state.json'), 'utf8'), originalState);
    // Evidence nova do replay (test na spec ativa) é a única VALID.
    writeMatrix({ ...r, dir: out.replayDir, taskId: out.replayTaskId }, ['AC-01', 'AC-02', 'AC-03']);
    const rs = stateOf(out.replayDir);
    sa.applyBaseline(rs, { root: r.worktree, specPath: 'memory/spec/43700-spec.md', taskId: out.replayTaskId });
    writeState(out.replayDir, rs);
    assert.strictEqual(cli('lib/acceptance-evidence.js', ['finalize', out.replayDir]).status, 0);
    assert.strictEqual(stateOf(out.replayDir).artifact_validity.evidence.validity.status, 'VALID');
});

test('7b. Replay de verify com a mesma spec mas matriz de outra versão: STALE e recomeça no test', () => {
    const r = seedReplayable({ evidenceSpecHash: 'f'.repeat(64) });
    const plan = replayer.planReplay(r.taskId, 'verify', { repoPath: r.repoPath, worktreeRegistered: () => true });
    assert.strictEqual(plan.fromNode, 'test');
    assert.strictEqual(plan.state.artifact_validity.evidence.validity.status, 'STALE');
    assert.ok(plan.warnings.some(w => /STALE; o replay recomeça no test/.test(w)));
});

// ── 8 ────────────────────────────────────────────────────────────────────────────
test('8. Run legado sem spec_hash: UNKNOWN; Verify recusa com aviso; dashboard "legado sem versão"; nada reescrito', () => {
    // Run legado: sem bloco spec, sem artifact_validity, review e matriz sem spec_hash.
    const legacyState = {
        task_id: '43700-legado', node: 'verify', history: ['plan', 'implement', 'review', 'test'], status: 'in_progress',
        started_at: '2026-09-20T00:00:00Z', spec_hash: 'c'.repeat(64),
        review_results: { verdict: 'PASS', failure_origin: null, spec_compliance: {}, engineering: {} },
    };
    const legacyMatrix = { schema_version: 1, run_id: '43700-legado', generated_at: '2026-09-20T00:00:00Z', coverage: { 'AC-01': { status: 'PASS', evidence: [] } } };
    const d = inv.describe(legacyState, { evidenceData: legacyMatrix });
    assert.strictEqual(d.phases.evidence.status, 'UNKNOWN');
    assert.strictEqual(d.phases.evidence.label, 'legado sem versão');
    assert.strictEqual(d.phases.evidence.badge, null, 'nem ⚠ STALE nem ✓ VALID');
    assert.strictEqual(d.phases.review.status, 'UNKNOWN');
    assert.strictEqual(d.nodes.test, 'UNKNOWN');
    assert.deepStrictEqual(d.acs, [{ ac: 'AC-01', test_status: 'PASS', validity: 'UNKNOWN', message: 'legado sem versão' }]);
    const g = inv.guardVerify(legacyState, legacyMatrix);
    assert.strictEqual(g.ok, false);
    assert.strictEqual(g.code, 'EVIDENCE_SPEC_UNKNOWN');
    assert.match(g.message, /Evidence legada sem versão .*Execute novo ciclo\./);
    // Review: alerta "legado sem versão", não bloqueia.
    const rv = inv.guardReview({ ...legacyState, spec_hash: undefined });
    assert.strictEqual(rv.status, 'UNKNOWN');
    assert.strictEqual(rv.compliance_valid, false);
    assert.match(rv.alert, /legado sem versão/);

    // Num run de verdade: matriz legada no disco nunca é reescrita para ganhar hash.
    const r = seedRun();
    const st = stateOf(r.dir);
    delete st.artifact_validity;
    writeState(r.dir, st);
    const legacyRaw = JSON.stringify(legacyMatrix, null, 2);
    fs.writeFileSync(path.join(r.dir, 'acceptance-evidence.json'), legacyRaw);
    assert.strictEqual(inv.syncEvidenceFile(r.dir, st), false);
    const res = inv.applySpecChange(st, { newSpec: { hash: 'd'.repeat(64), version: 2 }, evidenceData: legacyMatrix });
    assert.strictEqual(res.case, 'idle');
    inv.syncEvidenceFile(r.dir, st);
    assert.strictEqual(fs.readFileSync(path.join(r.dir, 'acceptance-evidence.json'), 'utf8'), legacyRaw, 'sem reescrita retroativa');
    const verdict = sa.verifyRun(r.dir, stateOf(r.dir));
    assert.ok(verdict.failures.some(f => f.code === 'EVIDENCE_SPEC_UNKNOWN'), JSON.stringify(verdict.failures));
});

// ── 9 ────────────────────────────────────────────────────────────────────────────
test('9. Run em andamento (implement) quando a SPEC_CHANGE chega: transição no journal; invalidação ao fim do nó', () => {
    // Run A propõe e aprova a SPEC_CHANGE; run B (mesma spec, mesmo checkout) está com o
    // implement rodando.
    const a = seedRun();
    const b = seedRun({ root: a.root, taskId: '43700-paralelo' });
    const sb = stateOf(b.dir);
    Object.assign(sb, { node: 'implement', status: 'running', node_started_at: '2026-10-01T11:59:00.000Z' });
    writeState(b.dir, sb);
    const bBefore = fs.readFileSync(path.join(b.dir, 'state.json'), 'utf8');
    const out = proposeAndApprove(a, ADD_AC03);
    assert.deepStrictEqual(out.propagated, [{ task: '43700-paralelo', case: 'active_phase' }]);
    assert.strictEqual(fs.readFileSync(path.join(b.dir, 'state.json'), 'utf8'), bBefore, 'state.json do nó em execução não é tocado (o nó o sobrescreveria)');
    let s = stateOf(b.dir);
    assert.strictEqual(s.status, 'running', 'o nó não é interrompido');
    const pending = inv.pendingTransitions(s, b.dir);
    assert.deepStrictEqual(pending.map(p => [p.transition_id, p.case, p.phase, p.new_spec_version]), [[`SC-001@${a.taskId}`, 'active_phase', 'implement', 2]]);
    assert.strictEqual(inv.guardVerify(s, null, { runDir: b.dir }).code, 'PENDING_SPEC_INVALIDATION', 'fail-closed enquanto pendente');
    assert.strictEqual(inv.resolvePendingInvalidation(s, { runDir: b.dir }).resolved, false, 'ainda rodando');
    // O agente termina (lease liberado, comando gravou o próximo nó).
    Object.assign(s, { status: 'in_progress', node: 'review' });
    const res = inv.resolvePendingInvalidation(s, { runDir: b.dir, at: '2026-10-01T12:30:00.000Z' });
    assert.deepStrictEqual([res.resolved, res.case], [true, 'active_phase']);
    assert.deepStrictEqual(statuses(s), ALL_STALE);
    assert.strictEqual(s.node, 'plan');
    assert.strictEqual(s.spec.version, 2, 'state.spec sincronizado com a v2 na resolução');
    assert.strictEqual(inv.pendingTransitions(s, b.dir).length, 0, 'consumida por transition_id');
    assert.ok(fs.existsSync(path.join(b.dir, inv.JOURNAL_FILE)), 'journal append-only continua lá');
    assert.ok(validateState(s).valid, JSON.stringify(validateState(s).errors));
    assert.strictEqual(sa.enforceSpecIntegrity(s, { root: b.root, taskId: b.taskId, node: 'plan' }).proceed, true);
});

test('9b. Caso C — plan rodando: transição registrada; o plano em produção sai STALE e a task replaneja', () => {
    const r = seedRun({ downstream: false });
    const s = stateOf(r.dir);
    Object.assign(s, { status: 'running', node: 'plan', execution_spec: inv.executionSpec('plan', { hash: s.spec.hash, version: 1 }) });
    const v1 = s.spec.hash;
    const res = inv.applySpecChange(s, { newSpec: { hash: 'e'.repeat(64), version: 2 }, triggeredBy: 'SPEC_CHANGE SC-009', transitionId: 'SC-009@x', runDir: r.dir, at: '2026-10-01T12:00:00.000Z' });
    assert.deepStrictEqual([res.case, res.deferred], ['plan_phase', true]);
    // O plan em execução termina e carimba (leu a v1): pendência → STALE, nunca VALID.
    inv.stampProduced(s, 'plan', { specHash: v1, at: '2026-10-01T12:05:00.000Z', runDir: r.dir });
    assert.strictEqual(s.artifact_validity.plan.validity.status, 'STALE');
    assert.match(s.artifact_validity.plan.stale_reason, /transição de contrato pendente/);
    Object.assign(s, { status: 'in_progress', node: 'implement' });
    inv.resolvePendingInvalidation(s, { runDir: r.dir, at: '2026-10-01T12:06:00.000Z' });
    assert.strictEqual(s.artifact_validity.plan.validity.status, 'STALE');
    assert.strictEqual(s.node, 'plan', 'novo ciclo de Plan contra a v2');
});

test('9c. Caso 1 — nenhum run em andamento: invalida já e node=plan (CLI apply)', () => {
    const r = seedRun();
    const out = cli('invalidate.js', ['apply', r.dir, `--new-hash=${'9'.repeat(64)}`, '--new-version=2', '--by=manual']);
    assert.strictEqual(out.status, 0, out.stderr);
    assert.match(out.stdout, /caso idle .*node=plan/);
    const s = stateOf(r.dir);
    assert.deepStrictEqual(statuses(s), ALL_STALE);
    assert.strictEqual(s.node, 'plan');
});

// ── 10 ───────────────────────────────────────────────────────────────────────────
test('10. stale_acs[] presente e vazio na v1 em todos os blocos validity — schema já aceita AC-IDs', () => {
    const r = seedRun();
    proposeAndApprove(r, ADD_AC03);
    const s = stateOf(r.dir);
    const blocks = [
        ...inv.PHASES.map(p => s.artifact_validity[p].validity), s.review_results.validity, s.spec_conformance.validity,
        readJson(path.join(r.dir, 'acceptance-evidence.json')).validity,
    ];
    for (const v of blocks) assert.deepStrictEqual(Object.keys(v).sort(), ['stale_acs', 'stale_since_version', 'status']), assert.deepStrictEqual(v.stale_acs, []);
    assert.deepStrictEqual(s.invalidations.at(-1).stale_acs, []);
    // Granularidade futura: AC-IDs no mesmo campo, sem migração de schema.
    s.artifact_validity.evidence.validity.stale_acs = ['AC-03'];
    assert.ok(validateState(s).valid, JSON.stringify(validateState(s).errors));
    s.artifact_validity.evidence.validity.stale_acs = ['nao-e-ac'];
    assert.strictEqual(validateState(s).valid, false);
    const ev = readJson(path.join(r.dir, 'acceptance-evidence.json'));
    assert.deepStrictEqual(ae.validateSchema(ev), []);
});

// ── Review / centralização / credenciais ─────────────────────────────────────────

test('Review alerta implement STALE sem bloquear; o alerta chega ao Verify', () => {
    const r = seedRun();
    const s = stateOf(r.dir);
    // implement feito na v1 e envelhecido (refresh/invalidação gravam o status; a fase só lê)
    s.artifact_validity.implement.spec_hash = 'f'.repeat(64);
    s.artifact_validity.implement.spec_version = 1;
    s.artifact_validity.implement.validity = inv.validityBlock('STALE', { staleSinceVersion: 2 });
    s.spec.version = 2;
    writeState(r.dir, s);
    const g = inv.guardReview(s);
    assert.strictEqual(g.status, 'STALE');
    assert.strictEqual(g.alert, 'Implement produzido contra Spec v1. Compliance avaliada pode não refletir Spec v2.');
    const guard = cli('invalidate.js', ['guard', r.dir, '--phase=review']);
    assert.strictEqual(guard.status, 0, 'não bloqueia');
    assert.match(guard.stdout, /ALERTA \(STALE\): Implement produzido contra Spec v1/);
    const review = recordReview(r, ['AC-01', 'AC-02']);
    assert.strictEqual(review.verdict, 'PASS', 'Review segue');
    assert.strictEqual(review.compliance_valid, false);
    assert.strictEqual(review.implement_validity.status, 'STALE');
    assert.ok(sa.verifyRun(r.dir, stateOf(r.dir)).warnings.some(w => w.code === 'REVIEW_COMPLIANCE_NOT_VALID'));
});

test('Centralização: templates das fases não comparam hash — chamam scripts/invalidate.js', () => {
    const dir = path.join(__dirname, '..', '.claude', 'commands');
    for (const f of ['plan.md', 'implement.md', 'review.md', 'test.md', 'verify.md', 'commit.md', 'fetch-ticket.md']) {
        const t = fs.readFileSync(path.join(dir, f), 'utf8');
        assert.ok(!/spec_hash\s*(!==?|==)/.test(t), `${f} compara spec_hash por conta própria`);
    }
    assert.match(fs.readFileSync(path.join(dir, 'verify.md'), 'utf8'), /scripts\/invalidate\.js guard memory\/runs\/\$ARGUMENTS --phase=verify/);
    assert.match(fs.readFileSync(path.join(dir, 'review.md'), 'utf8'), /scripts\/invalidate\.js guard memory\/runs\/\$ARGUMENTS --phase=review/);
});

test('Credenciais: nada de BITBUCKET_API_TOKEN/REDMINE_API_KEY em state, matriz, saída de CLI ou dados do dashboard', () => {
    const r = seedRun();
    proposeAndApprove(r, ADD_AC03);
    const outputs = [
        cli('invalidate.js', ['status', r.dir, '--json']).stdout,
        cli('invalidate.js', ['guard', r.dir, '--phase=verify']).stderr,
        cli('invalidate.js', ['resolve', r.dir]).stdout,
        JSON.stringify(inv.describe(stateOf(r.dir), { evidenceData: inv.readEvidence(r.dir) })),
        fs.readFileSync(path.join(r.dir, 'state.json'), 'utf8'),
        fs.readFileSync(path.join(r.dir, 'acceptance-evidence.json'), 'utf8'),
    ].join('\n');
    assert.ok(!outputs.includes(SECRET_TOKEN));
    assert.ok(!outputs.includes(SECRET_KEY));
});

test.after(() => fs.rmSync(sandbox, { recursive: true, force: true }));
