// node --test scripts/lib/spec-version.test.js
// Versionamento formal da spec (spec_version + spec_hash contratual): os 10 casos
// obrigatórios da task + credenciais fora dos arquivos gerados. Repo sintético
// (<root>/memory/spec + <root>/memory/runs/<task>), CLIs reais, nenhum Redmine/agente.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const sv = require('./spec-version');
const sh = require('./spec-hash');
const sa = require('./spec-authority');
const sc = require('./spec-change');
const ae = require('./acceptance-evidence');
const kg = require('./knowledge-graph');
const { validateState } = require('../validate-state');

const LIB = __dirname;
const SECRET_TOKEN = 'ATATT-test-token-should-never-leak-123';
const SECRET_KEY = 'redmine-key-should-never-leak-456';
const ENV = { ...process.env, BITBUCKET_API_TOKEN: SECRET_TOKEN, REDMINE_API_KEY: SECRET_KEY };

// Spec como o /fetch-ticket cria (template, ACs ainda vazios)...
const TEMPLATE_SPEC = `---
spec_template_version: 1
ticket: 43700
---
# Ticket #43700 — Desconto por volume

## Contexto
Hoje o relatório de fretes não mostra o desconto por volume.

## Objetivo
<!-- O CRITÉRIO DE SUCESSO. -->

## Critérios de Aceite
<!-- Um critério verificável por linha. -->
`;
// ...e como fica depois que um humano preenche (antes do /plan).
const FILLED_SPEC = `---
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
- AC-03: Exportação CSV inclui a coluna de desconto.

## Restrições
- Não alterar o contrato do endpoint de cotação.
`;

const sandbox = fs.mkdtempSync(path.join(process.env.CLAUDE_JOB_DIR ? path.join(process.env.CLAUDE_JOB_DIR, 'tmp') : os.tmpdir(), 'spec-version-'));
const readJson = f => JSON.parse(fs.readFileSync(f, 'utf8'));
let seq = 0;

const cli = (script, args) => spawnSync(process.execPath, [path.join(LIB, script), ...args], { encoding: 'utf8', env: ENV });

/** Run como o /fetch-ticket deixa: state.json + spec do template, sem bloco spec ainda. */
function seedFetchedRun({ spec = TEMPLATE_SPEC, state = {} } = {}) {
    const root = path.join(sandbox, `repo-${++seq}`);
    const taskId = `43700-desconto-${seq}`;
    const dir = path.join(root, 'memory', 'runs', taskId);
    fs.mkdirSync(dir, { recursive: true });
    fs.mkdirSync(path.join(root, 'memory', 'spec'), { recursive: true });
    const specFile = path.join(root, 'memory', 'spec', '43700-spec.md');
    fs.writeFileSync(specFile, spec);
    fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({
        task_id: taskId, node: 'plan', history: ['fetch_ticket'], status: 'in_progress',
        started_at: '2026-10-01T10:00:00.000Z', ac_ids: [],
        redmine_ticket: { id: 43700, subject: 'Desconto por volume', tracker: 'Melhoria', base_branch: 'development' },
        ...state,
    }, null, 2));
    return { root, taskId, dir, specFile, changelog: path.join(root, 'memory', 'spec', '43700-spec-changelog.json') };
}

const stateOf = dir => readJson(path.join(dir, 'state.json'));

/** fetch-ticket (init) → humano preenche → /plan (baseline sela) → artefatos do Plan. */
function seedPlannedRun() {
    const r = seedFetchedRun();
    assert.strictEqual(cli('spec-version.js', ['init', r.dir]).status, 0);
    fs.writeFileSync(r.specFile, FILLED_SPEC);
    const out = cli('spec-authority.js', ['baseline', r.dir]);
    assert.strictEqual(out.status, 0, out.stderr);
    const st = stateOf(r.dir);
    fs.writeFileSync(path.join(r.dir, 'plan.md'), `# Plano\n\n${sv.prLine(st)}\nACs: AC-01, AC-02, AC-03\n\n## Plano de execução\n1. Desconto. Critérios: AC-01, AC-02, AC-03\n`);
    fs.writeFileSync(path.join(r.dir, 'handoff.md'), '# Handoff\n\n- Spec: memory/spec/43700-spec.md\n- ACs: AC-01, AC-02, AC-03\n');
    return { ...r, baselineOut: out.stdout };
}

function approveChange(r, decision) {
    const st = stateOf(r.dir);
    st.node = 'implement';
    fs.writeFileSync(path.join(r.dir, 'state.json'), JSON.stringify(st, null, 2));
    const rec = sc.recordDecision(r.dir, decision);
    assert.deepStrictEqual(rec.errors, []);
    assert.strictEqual(rec.paused, true);
    return sc.approveSpecChange(r.dir, { by: 'po.fulano', at: '2026-10-01T12:00:00.000Z' });
}

const ADD_AC04 = {
    type: 'SPEC_CHANGE', description: 'Adicionar critério de desconto progressivo', rationale: 'PO pediu na daily',
    previous_behavior: 'desconto fixo de 5%', proposed_behavior: 'desconto progressivo acima de 50 volumes',
    ac_changes: [{ action: 'add', text: 'Fretes com mais de 50 volumes recebem 10% de desconto.' }],
};

// 1 ───────────────────────────────────────────────────────────────────────────────
test('1. spec nova: fetch-ticket grava spec v1 + hash do HASH_SCOPE; /plan sela v1 com o hash contratual da spec preenchida', () => {
    const r = seedFetchedRun();
    const out = cli('spec-version.js', ['init', r.dir]);
    assert.strictEqual(out.status, 0, out.stderr);
    const st = stateOf(r.dir);
    assert.strictEqual(st.spec.version, 1);
    assert.strictEqual(st.spec.hash, sh.contractHash(TEMPLATE_SPEC));
    assert.strictEqual(st.spec.hash_scope, 'contract_sections_v1');
    assert.strictEqual(st.spec.status, 'draft');
    assert.strictEqual(st.spec.path, 'memory/spec/43700-spec.md');
    assert.strictEqual(st.spec.id, '43700');
    assert.ok(!fs.existsSync(r.changelog), 'changelog só nasce na selagem');
    // init é idempotente
    assert.strictEqual(cli('spec-version.js', ['init', r.dir]).status, 0);
    assert.deepStrictEqual(stateOf(r.dir).spec, st.spec);

    // humano preenche ACs (autoria, não mudança) → /plan sela a v1
    fs.writeFileSync(r.specFile, FILLED_SPEC);
    const base = cli('spec-authority.js', ['baseline', r.dir]);
    assert.strictEqual(base.status, 0, base.stderr);
    assert.match(base.stdout, /spec v1 selada — declare no topo do plan\.md: Spec: memory\/spec\/43700-spec\.md · spec_version=1 · spec_hash=[0-9a-f]{12}/);
    const sealed = stateOf(r.dir);
    const hash = sh.contractHash(FILLED_SPEC);
    assert.strictEqual(sealed.spec.version, 1);
    assert.strictEqual(sealed.spec.status, 'active');
    assert.strictEqual(sealed.spec.hash, hash);
    assert.strictEqual(sealed.spec.initial_hash, sh.contractHash(TEMPLATE_SPEC));
    assert.strictEqual(sealed.spec_hash, hash, 'spec_hash do drift = mesmo algoritmo contratual');
    assert.strictEqual(sealed.spec_hash_scope, 'contract_sections_v1');
    assert.strictEqual(sealed.spec_hash_version, 1);
    const log = readJson(r.changelog);
    assert.strictEqual(log.spec_id, '43700');
    assert.deepStrictEqual(log.versions.map(v => [v.version, v.reason, v.approval_ref, v.diff_summary]), [[1, 'initial', null, null]]);
    assert.strictEqual(log.versions[0].hash, hash);
    // o mesmo hash por todas as portas de entrada (AC-02)
    assert.strictEqual(cli('spec-hash.js', [r.specFile]).stdout.trim(), hash);
    assert.strictEqual(cli('spec-authority.js', ['hash', r.specFile, `--run=${r.dir}`]).stdout.trim(), hash);
    assert.strictEqual(sa.specHashFor(sealed, FILLED_SPEC), hash);
});

// 2 ───────────────────────────────────────────────────────────────────────────────
test('2. leitura: state.json contém bloco "spec" válido no schema e show devolve os dados do dashboard', () => {
    const r = seedPlannedRun();
    const st = stateOf(r.dir);
    const v = validateState(st);
    assert.ok(v.valid, JSON.stringify(v.errors));
    assert.ok(sv.isVersioned(st));
    assert.strictEqual(sv.readSpecBlock(st).version, 1);
    const show = cli('spec-version.js', ['show', r.dir, '--json']);
    assert.strictEqual(show.status, 0, show.stderr);
    const d = JSON.parse(show.stdout);
    assert.strictEqual(d.label, `SPEC v1 | hash: ${st.spec.hash.slice(0, 12)}… | Status: ACTIVE`);
    assert.strictEqual(d.history_label, 'v1');
    // run arquivado (memory/runs/_archive/<id>) acha o changelog em memory/spec do mesmo checkout
    const archived = path.join(r.root, 'memory', 'runs', '_archive', r.taskId);
    fs.mkdirSync(path.dirname(archived), { recursive: true });
    fs.cpSync(r.dir, archived, { recursive: true });
    assert.strictEqual(JSON.parse(cli('spec-version.js', ['show', archived, '--json']).stdout).history_label, 'v1');
    // bloco inválido no schema é apontado
    assert.ok(!validateState({ ...st, spec: { ...st.spec, version: 0 } }).valid);
});

// 3 ───────────────────────────────────────────────────────────────────────────────
test('3. alteração fora do HASH_SCOPE (comentário, espaço, contexto): hash NÃO muda, versão NÃO incrementa, sem drift', () => {
    const r = seedPlannedRun();
    const before = stateOf(r.dir);
    const logBefore = fs.readFileSync(r.changelog, 'utf8');
    fs.writeFileSync(r.specFile, FILLED_SPEC
        .replace('- AC-01:', '<!-- conferir com o PO -->\n- AC-01:  ')
        .replace('Hoje o relatório de fretes não mostra o desconto por volume.', 'Contexto reescrito: o relatório não mostra desconto.\n\n\n'));
    const st = stateOf(r.dir);
    const gate = sa.enforceSpecIntegrity(st, { root: r.root, taskId: r.taskId, node: 'implement' });
    assert.strictEqual(gate.proceed, true);
    assert.strictEqual(gate.result.status, 'match');
    assert.strictEqual(st.spec.version, 1);
    assert.strictEqual(st.spec.hash, before.spec.hash);
    assert.strictEqual(fs.readFileSync(r.changelog, 'utf8'), logBefore);
    // novo baseline (replan) com a mesma spec contratual: nada no changelog
    assert.strictEqual(cli('spec-authority.js', ['baseline', r.dir]).status, 0);
    assert.strictEqual(fs.readFileSync(r.changelog, 'utf8'), logBefore);
    assert.strictEqual(stateOf(r.dir).spec.version, 1);
});

// 4 ───────────────────────────────────────────────────────────────────────────────
test('4. SPEC_CHANGE aprovada que altera o HASH_SCOPE: v1 → v2, entrada nova no changelog com approval_ref e diff_summary', () => {
    const r = seedPlannedRun();
    const v1 = stateOf(r.dir).spec;
    const out = approveChange(r, ADD_AC04);
    assert.strictEqual(out.ok, true, out.error);
    assert.strictEqual(out.specVersion.bumped, true);
    const st = stateOf(r.dir);
    const newHash = sh.contractHash(fs.readFileSync(r.specFile, 'utf8'));
    assert.strictEqual(st.spec.version, 2);
    assert.strictEqual(st.spec.hash, newHash);
    assert.strictEqual(st.spec_hash, newHash);
    assert.strictEqual(st.spec_hash_version, 2);
    assert.deepStrictEqual(st.spec.last_change, { spec_change_id: 'SC-001', approval_ref: 'spec-change-audit.json#entry-2', from_version: 1, at: '2026-10-01T12:00:00.000Z' });
    const audit = readJson(path.join(r.dir, sc.AUDIT_FILE));
    assert.strictEqual(audit.entries[1].event, 'approved', 'entry-2 do audit é a aprovação');
    assert.strictEqual(audit.entries[0].spec_version, 1, 'a proposta registra a versão sobre a qual foi feita');
    const log = readJson(r.changelog);
    assert.strictEqual(log.versions.length, 2);
    const e2 = log.versions[1];
    assert.strictEqual(e2.version, 2);
    assert.strictEqual(e2.hash, newHash);
    assert.match(e2.reason, /^SPEC_CHANGE SC-001: desconto progressivo/);
    assert.strictEqual(e2.approval_ref, 'spec-change-audit.json#entry-2');
    assert.strictEqual(e2.spec_change_id, 'SC-001');
    assert.strictEqual(e2.approved_by, 'po.fulano');
    assert.strictEqual(e2.diff_summary, 'AC-04 adicionado');
    assert.notStrictEqual(e2.hash, v1.hash);
    assert.ok(validateState(st).valid, JSON.stringify(validateState(st).errors));
    const d = sv.describe(st, { root: r.root });
    assert.strictEqual(d.history_label, 'v1 → SPEC_CHANGE SC-001 → v2');
    assert.strictEqual(d.status, 'ACTIVE');
});

test('4b. SPEC_CHANGE aprovada que NÃO altera o HASH_SCOPE (só Histórico de Mudanças): versão mantida, changelog intacto', () => {
    const r = seedPlannedRun();
    const logBefore = fs.readFileSync(r.changelog, 'utf8');
    const out = approveChange(r, {
        type: 'SPEC_CHANGE', description: 'Muda a regra de negócio de arredondamento', rationale: 'fiscal pediu',
        previous_behavior: 'arredonda para cima', proposed_behavior: 'arredonda para o par mais próximo',
    });
    assert.strictEqual(out.ok, true);
    assert.strictEqual(out.specVersion.bumped, false);
    assert.strictEqual(out.specVersion.reason, 'hash_scope_unchanged');
    assert.ok(fs.readFileSync(r.specFile, 'utf8').includes('## Histórico de Mudanças'), 'a spec ganhou o histórico...');
    assert.strictEqual(stateOf(r.dir).spec.version, 1, '...mas o contrato hasheado é o mesmo');
    assert.strictEqual(fs.readFileSync(r.changelog, 'utf8'), logBefore);
    assert.ok(stateOf(r.dir).events.some(e => e.type === 'spec_version_unchanged'));
});

// 5 ───────────────────────────────────────────────────────────────────────────────
test('5. SPEC_CHANGE rejeitada: versão permanece v1, nenhuma entrada no changelog', () => {
    const r = seedPlannedRun();
    const logBefore = fs.readFileSync(r.changelog, 'utf8');
    const specBefore = fs.readFileSync(r.specFile, 'utf8');
    const st0 = stateOf(r.dir);
    st0.node = 'implement';
    fs.writeFileSync(path.join(r.dir, 'state.json'), JSON.stringify(st0, null, 2));
    assert.strictEqual(sc.recordDecision(r.dir, ADD_AC04).paused, true);
    const out = cli('spec-change.js', ['reject', r.dir, '--by=po.fulano', '--reason=fora do escopo']);
    assert.strictEqual(out.status, 0, out.stderr);
    const st = stateOf(r.dir);
    assert.strictEqual(st.status, sc.REJECTED_STATUS);
    assert.strictEqual(st.spec.version, 1);
    assert.strictEqual(st.spec.hash, st0.spec.hash);
    assert.strictEqual(fs.readFileSync(r.changelog, 'utf8'), logBefore);
    assert.strictEqual(fs.readFileSync(r.specFile, 'utf8'), specBefore);
    assert.strictEqual(sv.describe(st, { root: r.root }).status, 'CHANGE_REJECTED');
});

// 6 ───────────────────────────────────────────────────────────────────────────────
test('6. hash divergente mid-run: drift sem aprovação pausa (Task 65); artefato de outra versão é alertado como SPEC_CHANGE_MID_RUN', () => {
    const r = seedPlannedRun();
    // a) contrato editado sem SPEC_CHANGE → spec-drift (portão da Task 65) + alerta no stamp
    fs.writeFileSync(r.specFile, FILLED_SPEC.replace('5% de desconto', '7% de desconto'));
    const st = stateOf(r.dir);
    const gate = sa.enforceSpecIntegrity(st, { root: r.root, taskId: r.taskId, node: 'review' });
    assert.strictEqual(gate.proceed, false);
    assert.strictEqual(st.status, 'spec-drift');
    const current = sh.contractHash(fs.readFileSync(r.specFile, 'utf8'));
    const stamp = sv.stampFor(st, current);
    assert.strictEqual(stamp.mismatch, true);
    assert.strictEqual(stamp.spec_version, null, 'versão desconhecida para conteúdo fora da versão vigente — nunca inventada');
    assert.match(stamp.message, /^SPEC_CHANGE mid-run/);
    assert.strictEqual(sv.describe(st, { root: r.root }).status, 'DRIFT');

    // b) humano aprova o drift manualmente (spec_change_approved + hash) → SPEC_CHANGE aprovada → v2
    st.spec_change_approved = true;
    st.spec_change_hash = current;
    const resumed = sa.enforceSpecIntegrity(st, { root: r.root, taskId: r.taskId, node: 'review' });
    assert.strictEqual(resumed.proceed, true);
    assert.strictEqual(st.spec.version, 2);
    // Dependency Invalidation: o Plan da v1 não vale para a v2 → STALE e volta ao /plan.
    assert.strictEqual(st.node, 'plan');
    assert.strictEqual(st.artifact_validity.plan.validity.status, 'STALE');
    assert.strictEqual(st.artifact_validity.plan.validity.stale_since_version, 2);
    const log = readJson(r.changelog);
    assert.strictEqual(log.versions[1].approval_ref, `state.json#spec_change_hash=${current.slice(0, 12)}`);
    assert.strictEqual(log.versions[1].diff_summary, 'AC-01 reformulado');
    // idempotente: próximo tick não incrementa de novo
    sa.enforceSpecIntegrity(st, { root: r.root, taskId: r.taskId, node: 'test' });
    assert.strictEqual(st.spec.version, 2);
    assert.strictEqual(readJson(r.changelog).versions.length, 2);

    // c) Review gravado na v1 chega ao Verify com a spec na v2 → alerta, não silencia
    st.review_results = { verdict: 'PASS', spec_hash: sh.contractHash(FILLED_SPEC), spec_version: 1 };
    const check = sv.checkArtifacts({ state: st, currentHash: current, planContent: fs.readFileSync(path.join(r.dir, 'plan.md'), 'utf8') });
    const codes = check.warnings.map(w => w.code);
    // plan.md já está em stale_artifacts (invalidação) — STALE_ARTIFACTS reprova; não duplica o alerta.
    assert.ok(codes.filter(c => c === 'SPEC_CHANGE_MID_RUN').length >= 1, codes.join(','));
    assert.ok(check.warnings.some(w => /review .* spec v1 .* atual é v2/.test(w.message)));
    // matriz gravada na v1 reprova no Verify
    const m = ae.checkMatrix({ raw: JSON.stringify({ run_id: 'x', generated_at: '2026-10-01T00:00:00Z', spec_hash: current, spec_version: 1, coverage: {} }), activeAcs: [], specHash: current, specVersion: 2 });
    assert.ok(m.failures.some(f => f.code === 'EVIDENCE_SPEC_VERSION_MISMATCH'));
});

// 7 ───────────────────────────────────────────────────────────────────────────────
test('7. run legado (sem bloco "spec"): nada quebra — hash legado, sem versão, degradação graciosa', () => {
    const r = seedFetchedRun({ spec: FILLED_SPEC, state: { node: 'implement', history: ['fetch_ticket', 'plan'] } });
    let st = stateOf(r.dir);
    assert.strictEqual(sv.readSpecBlock(st), null);
    for (const garbage of [null, 'v1', 7, [], { version: 'x' }, { version: 1 }]) assert.strictEqual(sv.readSpecBlock({ spec: garbage }), null);
    // baseline legado: algoritmo antigo, sem changelog, sem spec_hash_version
    const base = cli('spec-authority.js', ['baseline', r.dir]);
    assert.strictEqual(base.status, 0, base.stderr);
    assert.match(base.stdout, /run legado/);
    st = stateOf(r.dir);
    assert.strictEqual(st.spec_hash, sa.specHash(FILLED_SPEC));
    assert.strictEqual(st.spec_hash_scope, 'legacy_normative');
    assert.strictEqual(st.spec_hash_version, undefined);
    assert.strictEqual(st.spec, undefined);
    assert.ok(!fs.existsSync(r.changelog));
    // gate, stamp, artefatos, commit, PR, dashboard, knowledge graph: tudo degrada
    assert.strictEqual(sa.enforceSpecIntegrity(st, { root: r.root, taskId: r.taskId, node: 'review' }).proceed, true);
    assert.deepStrictEqual(sv.stampFor(st, st.spec_hash), { spec_version: null, spec_hash: st.spec_hash, mismatch: false, message: null });
    assert.deepStrictEqual(sv.checkArtifacts({ state: st, currentHash: st.spec_hash, planContent: '# x' }), { artifacts: [], warnings: [], failures: [] });
    assert.strictEqual(sv.commitMessage(st, '43700 - Desconto por volume'), '43700 - Desconto por volume');
    assert.strictEqual(sv.prLine(st), null);
    assert.strictEqual(sv.describe(st, { root: r.root }).status, 'UNVERSIONED');
    assert.strictEqual(cli('spec-version.js', ['show', r.dir]).status, 1);
    assert.strictEqual(cli('spec-version.js', ['commit-message', r.dir, '43700 - X']).stdout.trim(), '43700 - X');
    const facts = kg.taskFacts({ taskId: r.taskId, state: { ...st, pull_request: { 'app-back': { url: 'https://bitbucket.org/w/app-back/pull-requests/9' } } } });
    assert.strictEqual(facts.nodes['PR-app-back-9'].spec_version, null);
    // Verify num run legado roda sem erro de versão
    fs.writeFileSync(path.join(r.dir, 'plan.md'), '# Plano\n\n## Plano de execução\n1. Critérios: AC-01, AC-02, AC-03\n');
    fs.writeFileSync(path.join(r.dir, 'handoff.md'), '- Spec: memory/spec/43700-spec.md\n- ACs: AC-01, AC-02, AC-03\n');
    const res = sa.verifyRun(r.dir, st);
    assert.ok(!res.failures.some(f => /VERSION|MID_RUN/.test(f.code)));
    assert.strictEqual(res.spec_version, null);
    assert.ok(validateState(st).valid);
    // acceptance-evidence finalize legado: spec_version null, hash legado
    fs.writeFileSync(path.join(r.dir, ae.FILE), JSON.stringify({ coverage: {} }));
    cli('acceptance-evidence.js', ['finalize', r.dir]);
    const m = readJson(path.join(r.dir, ae.FILE));
    assert.strictEqual(m.spec_version, null);
    assert.strictEqual(m.spec_hash, sa.specHash(FILLED_SPEC));
});

// 8 ───────────────────────────────────────────────────────────────────────────────
test('8. acceptance-evidence.json registra spec_version e spec_hash corretos (e o Verify confere)', () => {
    const r = seedPlannedRun();
    fs.writeFileSync(path.join(r.dir, ae.FILE), JSON.stringify({
        coverage: Object.fromEntries(['AC-01', 'AC-02', 'AC-03'].map(id => [id, {
            status: 'NOT_AUTOMATED', justification: 'validação visual no preview do ambiente',
            evidence: [{ type: 'manual', description: 'conferência manual', result: 'NOT_AUTOMATED', justification: 'validação visual no preview do ambiente' }],
        }])),
    }));
    const out = cli('acceptance-evidence.js', ['finalize', r.dir]);
    assert.strictEqual(out.status, 0, out.stderr);
    assert.match(out.stdout, /spec v1/);
    const m = readJson(path.join(r.dir, ae.FILE));
    assert.strictEqual(m.spec_version, 1);
    assert.strictEqual(m.spec_hash, stateOf(r.dir).spec.hash);
    assert.strictEqual(m.spec_hash_scope, 'contract_sections_v1');
    assert.deepStrictEqual(ae.validateSchema(m), []);
    // Verify grava versão/hash no spec_conformance e no bloco verification
    const v = cli('spec-authority.js', ['verify', r.dir, '--write']);
    const st = stateOf(r.dir);
    assert.strictEqual(st.spec_conformance.spec_version, 1, v.stdout);
    assert.strictEqual(st.spec_conformance.spec_hash, st.spec.hash);
    assert.strictEqual(readJson(path.join(r.dir, ae.FILE)).verification.spec_version, 1);
    assert.ok(!st.spec_conformance.failures.some(f => /VERSION|MID_RUN/.test(f)), st.spec_conformance.failures.join('\n'));
    assert.ok(!st.spec_conformance.warnings.some(w => /MID_RUN|PLAN_SPEC_VERSION_MISSING/.test(w)), st.spec_conformance.warnings.join('\n'));
    assert.match(fs.readFileSync(path.join(r.dir, 'spec-conformance.md'), 'utf8'), /spec_version=1 · spec_hash=/);
});

// 9 ───────────────────────────────────────────────────────────────────────────────
test('9. commit message contém a spec_version correta; PR leva a linha de metadados e o KG o dado da aresta PR→SpecVersion', () => {
    const r = seedPlannedRun();
    const msg = cli('spec-version.js', ['commit-message', r.dir, '43700 - Desconto por volume']);
    assert.strictEqual(msg.stdout.trim(), '43700 - Desconto por volume [spec_version=1]');
    assert.strictEqual(approveChange(r, ADD_AC04).specVersion.version, 2);
    const st = stateOf(r.dir);
    assert.strictEqual(sv.commitMessage(st, '43700 - Desconto por volume'), '43700 - Desconto por volume [spec_version=2]');
    assert.strictEqual(sv.commitMessage(st, '43700 - Desconto por volume [spec_version=1]'), '43700 - Desconto por volume [spec_version=2]', 'tag antiga é trocada, nunca duplicada');
    assert.strictEqual(cli('spec-version.js', ['pr-line', r.dir]).stdout.trim(), `Spec: memory/spec/43700-spec.md · spec_version=2 · spec_hash=${st.spec.hash.slice(0, 12)}`);
    // rascunho (não selado) não leva tag
    const draft = seedFetchedRun();
    cli('spec-version.js', ['init', draft.dir]);
    assert.strictEqual(sv.commitMessage(stateOf(draft.dir), '43700 - X'), '43700 - X');
    // knowledge graph: PR com a versão gravada pelo /commit
    const facts = kg.taskFacts({ taskId: r.taskId, state: { ...st, pull_request: { 'app-back': { url: 'https://bitbucket.org/w/app-back/pull-requests/77', ...sv.prSpecRef(st) } } } });
    assert.deepStrictEqual(
        (({ spec_id, spec_version, spec_hash }) => ({ spec_id, spec_version, spec_hash }))(facts.nodes['PR-app-back-77']),
        { spec_id: '43700', spec_version: 2, spec_hash: st.spec.hash });
    assert.strictEqual(facts.nodes['memory/spec/43700-spec.md'].spec_version, 2);
});

// 10 ──────────────────────────────────────────────────────────────────────────────
test('10. spec-changelog.json nunca sobrescreve entradas anteriores', () => {
    const r = seedPlannedRun();
    const v1Entry = JSON.stringify(readJson(r.changelog).versions[0]);
    approveChange(r, ADD_AC04);
    const log = readJson(r.changelog);
    assert.strictEqual(JSON.stringify(log.versions[0]), v1Entry, 'v1 intacta depois da v2');
    const rel = 'memory/spec/43700-spec-changelog.json';
    const entry = { version: 2, hash: 'a'.repeat(64), hash_scope: 'contract_sections_v1', created_at: '2026-10-01T13:00:00Z', reason: 'x', approval_ref: null, diff_summary: null };
    assert.match(sv.appendVersion(r.root, rel, entry).error, /versão 2 já registrada/);
    assert.match(sv.appendVersion(r.root, rel, { ...entry, version: 5 }).error, /fora de sequência \(esperada 3\)/);
    assert.match(sv.appendVersion(r.root, rel, { ...entry, version: 3, hash: 'zz' }).error, /hash inválido/);
    assert.deepStrictEqual(readJson(r.changelog), log, 'recusas não tocam o arquivo');
    // rebaseline (Recusa QA: nota de correção do /commit) acrescenta sem mexer em versions[]
    const st = stateOf(r.dir);
    const corrected = fs.readFileSync(r.specFile, 'utf8').replace('- AC-02: O relatório exibe o desconto aplicado por frete.', '- AC-02: O relatório exibe o desconto aplicado por frete.\n  - Nota de correção (2026-10-02): vale também para o PDF.');
    fs.writeFileSync(r.specFile, corrected);
    sa.applyBaseline(st, { root: r.root, specPath: 'memory/spec/43700-spec.md', by: 'qa_retry', taskId: r.taskId });
    const after = readJson(r.changelog);
    assert.deepStrictEqual(after.versions, log.versions);
    assert.strictEqual(after.rebaselines.length, 1);
    assert.strictEqual(after.rebaselines[0].version, 2);
    assert.strictEqual(after.rebaselines[0].diff_summary, 'AC-02 reformulado');
    assert.strictEqual(st.spec.version, 2, 'nota de correção não é SPEC_CHANGE: versão mantida');
    assert.strictEqual(st.spec.hash, sh.contractHash(corrected));
    // JSON corrompido nunca é sobrescrito
    fs.writeFileSync(r.changelog, '{ quebrado');
    const bad = sv.bump(st, { root: r.root, newContent: corrected.replace('10%', '12%'), reason: 'x', approvalRef: 'y', by: 't' });
    assert.strictEqual(bad.bumped, false);
    assert.match(bad.error, /JSON inválido/);
    assert.strictEqual(fs.readFileSync(r.changelog, 'utf8'), '{ quebrado');
    assert.strictEqual(st.spec.version, 2);
});

// AC-10 ───────────────────────────────────────────────────────────────────────────
test('AC-10: nenhuma credencial do ambiente em arquivo gerado nem na saída das CLIs', () => {
    const r = seedPlannedRun();
    const outputs = [r.baselineOut];
    outputs.push(cli('spec-version.js', ['show', r.dir]).stdout, cli('spec-version.js', ['changelog', r.dir]).stdout);
    approveChange(r, ADD_AC04);
    const walk = d => fs.readdirSync(d, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]);
    for (const f of walk(r.root)) {
        const c = fs.readFileSync(f, 'utf8');
        assert.ok(!c.includes(SECRET_TOKEN) && !c.includes(SECRET_KEY), `credencial em ${path.relative(r.root, f)}`);
    }
    for (const o of outputs) assert.ok(!o.includes(SECRET_TOKEN) && !o.includes(SECRET_KEY));
});
