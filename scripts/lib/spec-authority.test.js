// node --test scripts/lib/spec-authority.test.js
// SPEC = WHAT | PLAN = HOW: conformidade do Verify (Spec → Plan → Handoff → evidência)
// e proteção contra drift (spec_hash) — unidade + CLI + integração com o watcher
// (runSpecDriftGate via dispatchTicket) num REPO_PATH sintético, fetch stubado (nenhum
// Redmine real) e um `claude` falso no PATH (nenhum agente real).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const sa = require('./spec-authority');

const FILLER = 'Texto descritivo suficiente para passar do limite mínimo de caracteres exigido pela validação. ';
const SPEC_PATH = 'memory/spec/43646-spec.md';
const TASK_ID = '43646-filtro';

const SPEC = `# Spec 43646

## Problema
${FILLER}Hoje o filtro de transportadora lista todas as transportadoras cadastradas.

## Solução
${FILLER}Filtrar pela lista do resultado atual.

## Critérios de Aceite
- AC-01: Filtro de transportadora lista somente transportadoras presentes no resultado da tela.
- AC-02: Novo filtro de operação de transporte com o mesmo comportamento dinâmico.
- AC-03: Paginação da Torre de Controle continua funcionando sem regressão.

## Restrições
- Não alterar o contrato do endpoint de Zona de Transporte.
`;

const PLAN = `# Plano — ${TASK_ID}

## Referência da Spec
- Spec: ${SPEC_PATH}
- ACs: AC-01, AC-02, AC-03

## Plano de execução
1. Filtrar transportadoras pelo resultado atual.
   - Arquivo: \`app-core/src/main/java/TorreService.java\`
   - Critérios: AC-01
   - Verificação: teste unitário novo.
2. Criar filtro de operação dinâmico.
   - Arquivo: \`app-core/src/main/java/TorreService.java\`
   - Critérios: AC-02
   - Verificação: teste unitário novo.
3. Rodar a suíte de paginação existente.
   - Arquivo: \`app-core/src/test/java/TorreServiceTest.java\`
   - Critérios: AC-03
   - Verificação: mvn test verde.

## Cobertura dos ACs
- AC-01 → passo 1 — filtro aplicado no service.
- AC-02 → passo 2 — mesmo mecanismo do AC-01.
- AC-03 → passo 3 — regressão coberta pela suíte.
`;

const HANDOFF = `# Handoff — ${TASK_ID}

## Referência da Spec
- Spec: ${SPEC_PATH}
- ACs: AC-01, AC-02, AC-03
- Plan: memory/runs/${TASK_ID}/plan.md

## Próximo passo
Verify.
`;

const EVIDENCE = `# Evidências
- AC-01 | PASS | \`TorreServiceTest#filtraTransportadoras\` — mvn verde
- AC-02 | PASS | \`TorreServiceTest#filtroOperacao\` — mvn verde
- AC-03 | PASS | \`TorreServiceTest#paginacao\` — mvn verde
`;

// Relatório surefire real (formato do maven-surefire 3) que a matriz cita como artifact.
const REPORT_REL = 'target/surefire-reports/TEST-br.com.mosistemas.TorreServiceTest.xml';
const SUREFIRE = `<?xml version="1.0" encoding="UTF-8"?>
<testsuite name="br.com.mosistemas.TorreServiceTest" tests="3" errors="0" skipped="0" failures="0">
  <testcase name="filtraTransportadoras" classname="br.com.mosistemas.TorreServiceTest" time="0.01"/>
  <testcase name="filtroOperacao" classname="br.com.mosistemas.TorreServiceTest" time="0.01"/>
  <testcase name="paginacao" classname="br.com.mosistemas.TorreServiceTest" time="0.01"/>
</testsuite>
`;
const testEv = (method, extra = {}) => ({ description: `TorreServiceTest#${method}`, type: 'automated-test', artifact: REPORT_REL, result: 'PASS', ...extra });
function matrix(over = {}, specContent = SPEC) {
    const coverage = {
        'AC-01': { status: 'PASS', evidence: [testEv('filtraTransportadoras')] },
        'AC-02': { status: 'PASS', evidence: [testEv('filtroOperacao')] },
        'AC-03': { status: 'PASS', evidence: [testEv('paginacao', { type: 'regression-test' })] },
        ...over,
    };
    for (const k of Object.keys(coverage)) if (coverage[k] === undefined) delete coverage[k];
    return JSON.stringify({ schema_version: 1, run_id: TASK_ID, generated_at: '2026-09-30T12:00:00.000Z', spec_hash: sa.specHash(specContent), coverage }, null, 2);
}

const codes = r => r.failures.map(f => f.code);

// Run sintético: <root>/memory/spec/43646-spec.md + <root>/memory/runs/<task>/.
const sandbox = fs.mkdtempSync(path.join(process.env.CLAUDE_JOB_DIR ? path.join(process.env.CLAUDE_JOB_DIR, 'tmp') : os.tmpdir(), 'spec-authority-'));
// Raiz com o relatório surefire para as checagens puras (verifyConformance) acharem o artifact.
const fixtureRoot = path.join(sandbox, 'fixture-root');
fs.mkdirSync(path.join(fixtureRoot, path.dirname(REPORT_REL)), { recursive: true });
fs.writeFileSync(path.join(fixtureRoot, REPORT_REL), SUREFIRE);

function conformance(over = {}) {
    const state = { task_id: TASK_ID, ac_ids: ['AC-01', 'AC-02', 'AC-03'], spec_hash: sa.specHash(SPEC), started_at: '2026-10-02T00:00:00Z', ...over.state };
    const specContent = over.specContent ?? SPEC;
    return sa.verifyConformance({
        specContent, specPath: SPEC_PATH,
        planContent: over.planContent === undefined ? PLAN : over.planContent,
        handoffContent: over.handoffContent === undefined ? HANDOFF : over.handoffContent,
        evidenceContent: over.evidenceContent === undefined ? null : over.evidenceContent,
        acceptanceContent: over.acceptanceContent === undefined ? matrix({}, specContent) : over.acceptanceContent,
        root: fixtureRoot, runDir: path.join(fixtureRoot, 'memory', 'runs', TASK_ID),
        state, taskId: TASK_ID,
        drift: over.drift || { status: 'match', ok: true, reason: 'ok' },
    });
}

let seq = 0;
function seedRun(stateOver = {}, files = {}) {
    const root = path.join(sandbox, `r${++seq}`);
    const dir = path.join(root, 'memory', 'runs', TASK_ID);
    fs.mkdirSync(dir, { recursive: true });
    fs.mkdirSync(path.join(root, 'memory', 'spec'), { recursive: true });
    fs.writeFileSync(path.join(root, SPEC_PATH), files.spec ?? SPEC);
    fs.writeFileSync(path.join(dir, 'plan.md'), files.plan ?? PLAN);
    fs.writeFileSync(path.join(dir, 'handoff.md'), files.handoff ?? HANDOFF);
    if (files.evidence !== undefined) fs.writeFileSync(path.join(dir, 'ac-evidence.md'), files.evidence);
    if (files.acceptance !== null) fs.writeFileSync(path.join(dir, 'acceptance-evidence.json'), files.acceptance ?? matrix({}, files.spec ?? SPEC));
    fs.mkdirSync(path.join(root, path.dirname(REPORT_REL)), { recursive: true });
    fs.writeFileSync(path.join(root, REPORT_REL), files.report ?? SUREFIRE);
    fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({
        task_id: TASK_ID, node: 'verify', history: ['fetch_ticket', 'plan', 'implement', 'review', 'test'],
        status: 'in_progress', started_at: new Date().toISOString(), ac_ids: ['AC-01', 'AC-02', 'AC-03'],
        redmine_ticket: { id: 43646 }, ...stateOver,
    }, null, 2));
    return { root, dir, spec: path.join(root, SPEC_PATH) };
}
const readJson = f => JSON.parse(fs.readFileSync(f, 'utf8'));
const CLI = path.join(__dirname, 'spec-authority.js');
function cli(args) {
    try {
        return { code: 0, out: execFileSync('node', [CLI, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) };
    } catch (e) {
        return { code: e.status, out: `${e.stdout || ''}${e.stderr || ''}` };
    }
}

// ── Hash ─────────────────────────────────────────────────────────────────────────

test('hash: estável a CRLF/espaço no fim/comentário; ignora Decisões de Implementação e Contexto Histórico', () => {
    const h = sa.specHash(SPEC);
    assert.match(h, /^[0-9a-f]{64}$/);
    assert.strictEqual(sa.specHash(SPEC.replace(/\n/g, '\r\n')), h);
    assert.strictEqual(sa.specHash(SPEC.replace('## Solução', '## Solução   ')), h);
    assert.strictEqual(sa.specHash(SPEC + '\n<!-- nota -->\n'), h);
    const appended = SPEC + '\n## Contexto Histórico\n- arquivo X tem retrabalho\n\n## Decisões de Implementação\n\n### implement · 2026-09-30T10:00Z · 43646-filtro\n- **Decisão**: x\n- **Motivo**: y\n- **Impacto no spec**: Nenhum critério alterado\n';
    assert.strictEqual(sa.specHash(appended), h, 'APPEND do /implement e do spec-enricher não é drift');
    assert.notStrictEqual(sa.specHash(SPEC.replace('somente transportadoras', 'todas as transportadoras')), h);
    assert.notStrictEqual(sa.specHash(SPEC.replace('- Não alterar o contrato', '- Pode alterar o contrato')), h);
});

// ── Teste 1: consistente → PASS ──────────────────────────────────────────────────

test('1. Spec e Handoff consistentes → Verify PASS', () => {
    const r = conformance();
    assert.strictEqual(r.verdict, 'PASS', JSON.stringify(r.failures));
    assert.deepStrictEqual(r.acs, ['AC-01', 'AC-02', 'AC-03']);
    assert.deepStrictEqual(r.coverage.map(c => c.status), ['PASS', 'PASS', 'PASS']);
});

test('1b. CLI verify sobre um run consistente: exit 0, grava spec_conformance e spec-conformance.md', () => {
    const { dir } = seedRun({ spec_hash: sa.specHash(SPEC), spec_path: SPEC_PATH });
    const r = cli(['verify', dir, '--write']);
    assert.strictEqual(r.code, 0, r.out);
    assert.match(r.out, /Veredito: \*\*PASS\*\*/);
    const s = readJson(path.join(dir, 'state.json'));
    assert.strictEqual(s.spec_conformance.verdict, 'PASS');
    assert.ok(fs.existsSync(path.join(dir, 'spec-conformance.md')));
});

// ── Teste 2: handoff diverge → FAIL com motivo ───────────────────────────────────

test('2. Handoff diverge da Spec → Verify FAIL com motivo', () => {
    const rewritten = conformance({ handoffContent: HANDOFF + '\n## Critérios\n- AC-02: Filtro de operação estático, carregado uma vez.\n' });
    assert.strictEqual(rewritten.verdict, 'FAIL');
    const f = rewritten.failures.find(x => x.code === 'HANDOFF_AC_TEXT_DIVERGES');
    assert.ok(f, JSON.stringify(rewritten.failures));
    assert.match(f.message, /AC-02/);
    assert.match(f.message, /A spec vence/);

    const list = conformance({ handoffContent: HANDOFF.replace('- ACs: AC-01, AC-02, AC-03', '- ACs: AC-01, AC-02, AC-04') });
    assert.strictEqual(list.verdict, 'FAIL');
    const l = list.failures.find(x => x.code === 'HANDOFF_AC_LIST_DIVERGES');
    assert.match(l.message, /faltam AC-03/);
    assert.match(l.message, /sobram AC-04/);
    assert.ok(codes(list).includes('HANDOFF_UNKNOWN_AC'));

    const otherSpec = conformance({ handoffContent: HANDOFF.replace(`Spec: ${SPEC_PATH}`, 'Spec: memory/spec/99999-spec.md') });
    assert.ok(codes(otherSpec).includes('HANDOFF_SPEC_REF_DIVERGES'));
    const noRef = conformance({ handoffContent: '# Handoff\n\nsem referência\n' });
    assert.ok(codes(noRef).includes('HANDOFF_SPEC_REF_MISSING'));
    assert.ok(codes(noRef).includes('HANDOFF_AC_LIST_MISSING'));
});

test('2b. Cópia literal de AC no handoff é aviso (duplicação), não falha', () => {
    const r = conformance({ handoffContent: HANDOFF + '\n- AC-01: Filtro de transportadora lista somente transportadoras presentes no resultado da tela.\n' });
    assert.strictEqual(r.verdict, 'PASS', JSON.stringify(r.failures));
    assert.ok(r.warnings.some(w => w.code === 'HANDOFF_AC_TEXT_DUPLICATED'));
});

// ── Teste 3: Plan omite AC → FAIL ────────────────────────────────────────────────

test('3. Plan omite AC → Verify FAIL', () => {
    const plan = PLAN.replace('   - Critérios: AC-03\n', '').replace('- AC-03 → passo 3 — regressão coberta pela suíte.\n', '');
    const r = conformance({ planContent: plan });
    assert.strictEqual(r.verdict, 'FAIL');
    const f = r.failures.find(x => x.code === 'PLAN_OMITS_AC');
    assert.ok(f, JSON.stringify(r.failures));
    assert.match(f.message, /AC-03/);
    assert.strictEqual(r.failures.filter(x => x.code === 'PLAN_OMITS_AC').length, 1);
});

test('3b. A linha de referência "ACs:" não conta como cobertura; Plan que inventa AC reprova', () => {
    const onlyRef = PLAN.replace(/## Plano de execução[\s\S]*/, '## Plano de execução\n1. Fazer tudo.\n   - Arquivo: `x.java`\n   - Verificação: teste\n');
    assert.deepStrictEqual(codes(conformance({ planContent: onlyRef })).filter(c => c === 'PLAN_OMITS_AC').length, 3);
    const invented = PLAN.replace('- AC-03 → passo 3', '- AC-03 → passo 3\n- AC-04 → passo 3');
    assert.ok(codes(conformance({ planContent: invented })).includes('PLAN_UNKNOWN_AC'));
    assert.ok(codes(conformance({ planContent: null })).includes('PLAN_MISSING'));
});

test('Run legado (anterior à matriz): ac-evidence.md é evidence UNKNOWN (sem spec_hash) — Verify recusa; AC sem PASS, PASS vazio ou arquivo ausente → FAIL', () => {
    const legacy = (evidenceContent) => conformance({ evidenceContent, acceptanceContent: null, state: { started_at: '2026-09-20T00:00:00Z' } });
    const ok = legacy(EVIDENCE);
    // Dependency Invalidation (scripts/invalidate.js): legado sem versão nunca é VALID.
    assert.strictEqual(ok.verdict, 'FAIL');
    assert.deepStrictEqual(codes(ok), ['EVIDENCE_SPEC_UNKNOWN'], JSON.stringify(ok.failures));
    assert.match(ok.failures[0].message, /Evidence legada sem versão .*Execute novo ciclo\./);
    assert.ok(ok.warnings.some(w => w.code === 'LEGACY_AC_EVIDENCE_MD'));
    const missing = legacy(EVIDENCE.replace(/- AC-02.*\n/, ''));
    assert.ok(missing.failures.some(f => f.code === 'AC_WITHOUT_EVIDENCE' && /AC-02/.test(f.message)));
    const failing = legacy(EVIDENCE.replace('AC-03 | PASS', 'AC-03 | FAIL'));
    assert.ok(codes(failing).includes('AC_EVIDENCE_NOT_PASS'));
    const empty = legacy(EVIDENCE.replace(/AC-01 \| PASS \|.*/, 'AC-01 | PASS |'));
    assert.ok(codes(empty).includes('AC_WITHOUT_EVIDENCE'));
    assert.ok(codes(legacy(null)).includes('EVIDENCE_MISSING'));
    // Run novo: o markdown sozinho não basta — a matriz com artefato é obrigatória.
    const fresh = conformance({ evidenceContent: EVIDENCE, acceptanceContent: null });
    assert.ok(codes(fresh).includes('EVIDENCE_MISSING'), JSON.stringify(fresh.failures));
});

test('AC removido não é exigido no plano, no handoff nem na evidência', () => {
    const spec = SPEC.replace('- AC-03: Paginação', '- AC-03: (removido em 2026-09-30: fora do escopo) Paginação');
    const r = conformance({
        specContent: spec,
        planContent: PLAN.replace('   - Critérios: AC-03\n', '').replace('- AC-03 → passo 3 — regressão coberta pela suíte.\n', ''),
        handoffContent: HANDOFF.replace('AC-01, AC-02, AC-03', 'AC-01, AC-02'),
        acceptanceContent: matrix({ 'AC-03': undefined }, spec),
    });
    assert.strictEqual(r.verdict, 'PASS', JSON.stringify(r.failures));
    assert.deepStrictEqual(r.acs, ['AC-01', 'AC-02']);
});

test('Decisão de implementação que altera AC: FAIL sem SPEC_CHANGE aprovado; aviso com aprovação', () => {
    const spec = SPEC + `\n## Decisões de Implementação\n\n### implement · 2026-09-30T10:00Z · ${TASK_ID}\n- **Decisão**: filtro de operação estático\n- **Motivo**: performance\n- **Impacto no spec**: AC-02 ajustado — lista carregada uma vez\n\n### implement · 2026-09-29T10:00Z · 11111-outra\n- **Decisão**: x\n- **Motivo**: y\n- **Impacto no spec**: AC-01 ajustado\n\n### implement · 2026-09-30T11:00Z · ${TASK_ID}\n- **Decisão**: BigDecimal\n- **Motivo**: precisão\n- **Impacto no spec**: Nenhum critério alterado — resolve ambiguidade em AC-03\n`;
    const r = conformance({ specContent: spec });
    const changes = r.failures.filter(f => f.code === 'BEHAVIOR_CHANGE_WITHOUT_APPROVAL');
    assert.strictEqual(changes.length, 1, JSON.stringify(r.failures));
    assert.match(changes[0].message, /AC-02 ajustado/);
    const ok = conformance({ specContent: spec, drift: { status: 'approved', ok: true, reason: 'aprovado' } });
    assert.ok(!codes(ok).includes('BEHAVIOR_CHANGE_WITHOUT_APPROVAL'));
    assert.ok(ok.warnings.some(w => w.code === 'BEHAVIOR_CHANGE_APPROVED'));
});

test('Spec sem IDs: FAIL em run novo, aviso em run legado; task sem spec = N/A', () => {
    const noIds = SPEC.replace(/- AC-0\d: /g, '- ');
    assert.ok(codes(conformance({ specContent: noIds })).includes('SPEC_NO_AC_IDS'));
    const legacy = sa.verifyConformance({ specContent: noIds, specPath: SPEC_PATH, planContent: PLAN, handoffContent: HANDOFF, evidenceContent: EVIDENCE, state: { started_at: '2026-09-01T00:00:00Z' }, drift: { status: 'match', ok: true } });
    assert.strictEqual(legacy.verdict, 'PASS');
    assert.ok(legacy.warnings.some(w => w.code === 'LEGACY_NO_AC_IDS'));
    const none = sa.verifyConformance({ specContent: null, specPath: SPEC_PATH, state: {}, drift: { status: 'no_spec', ok: true } });
    assert.strictEqual(none.verdict, 'N/A');
});

test('Verify FAIL se a spec tiver drift não autorizado', () => {
    const { dir, spec } = seedRun({ spec_hash: sa.specHash(SPEC), spec_path: SPEC_PATH });
    fs.writeFileSync(spec, SPEC.replace('somente transportadoras', 'todas as transportadoras'));
    const r = sa.verifyRun(dir, readJson(path.join(dir, 'state.json')));
    assert.strictEqual(r.verdict, 'FAIL');
    assert.ok(codes(r).includes('SPEC_DRIFT'));
    assert.strictEqual(cli(['verify', dir]).code, 1);
});

// ── Testes 4, 5 e 6: drift ───────────────────────────────────────────────────────

const CHANGED = SPEC.replace('- AC-03: Paginação', '- AC-03: Paginação de 50 em 50');

test('4. Spec muda durante a execução → pipeline pausa (spec-drift + evento)', () => {
    const { root, dir, spec } = seedRun({ spec_hash: sa.specHash(SPEC), spec_path: SPEC_PATH, node: 'implement' });
    fs.writeFileSync(spec, CHANGED);
    const state = readJson(path.join(dir, 'state.json'));
    const out = sa.enforceSpecIntegrity(state, { root, taskId: TASK_ID, node: 'implement', now: '2026-09-30T12:00:00.000Z' });
    assert.strictEqual(out.proceed, false);
    assert.strictEqual(out.changed, true);
    assert.strictEqual(state.status, 'spec-drift');
    assert.strictEqual(state.spec_drift.node, 'implement');
    assert.strictEqual(state.spec_drift.expected_hash, sa.specHash(SPEC));
    assert.strictEqual(state.spec_drift.current_hash, sa.specHash(CHANGED));
    assert.strictEqual(state.events.at(-1).type, 'spec_drift');
    // Mesma versão no tick seguinte: continua pausado, sem evento duplicado.
    const again = sa.enforceSpecIntegrity(state, { root, taskId: TASK_ID, node: 'implement' });
    assert.strictEqual(again.proceed, false);
    assert.strictEqual(again.changed, false);
    assert.strictEqual(state.events.filter(e => e.type === 'spec_drift').length, 1);
    // Todos os nós guardados pausam; commit/fetch_ticket não são guardados.
    for (const node of ['review', 'test', 'verify']) {
        const s = readJson(path.join(dir, 'state.json'));
        assert.strictEqual(sa.enforceSpecIntegrity(s, { root, taskId: TASK_ID, node }).proceed, false, node);
    }
});

test('4b. Spec removida depois do Plan também é drift', () => {
    const { root, dir, spec } = seedRun({ spec_hash: sa.specHash(SPEC), spec_path: SPEC_PATH });
    fs.rmSync(spec);
    const state = readJson(path.join(dir, 'state.json'));
    const out = sa.enforceSpecIntegrity(state, { root, taskId: TASK_ID, node: 'test' });
    assert.strictEqual(out.proceed, false);
    assert.match(out.message, /não existe mais/);
});

test('5. Spec change aprovada (spec_change_approved + spec_change_hash correto) → pipeline continua', () => {
    const { root, dir, spec } = seedRun({ spec_hash: sa.specHash(SPEC), spec_path: SPEC_PATH });
    fs.writeFileSync(spec, CHANGED);
    // Pausa primeiro, depois o humano aprova: retoma com evento spec_change_accepted.
    const state = readJson(path.join(dir, 'state.json'));
    sa.enforceSpecIntegrity(state, { root, taskId: TASK_ID, node: 'review' });
    assert.strictEqual(state.status, 'spec-drift');
    Object.assign(state, { spec_change_approved: true, spec_change_hash: sa.specHash(CHANGED) });
    const out = sa.enforceSpecIntegrity(state, { root, taskId: TASK_ID, node: 'review' });
    assert.strictEqual(out.proceed, true);
    assert.strictEqual(state.status, 'in_progress');
    assert.strictEqual(state.spec_drift, undefined);
    assert.strictEqual(state.events.at(-1).type, 'spec_change_accepted');
    // Aprovação já no state antes da detecção: segue direto, sem pausar.
    const fresh = { ...readJson(path.join(dir, 'state.json')), spec_change_approved: true, spec_change_hash: sa.specHash(CHANGED) };
    const direct = sa.enforceSpecIntegrity(fresh, { root, taskId: TASK_ID, node: 'test' });
    assert.strictEqual(direct.proceed, true);
    assert.strictEqual(direct.result.status, 'approved');
    // CLI check: exit 0.
    fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify(fresh));
    assert.strictEqual(cli(['check', dir, '--node=verify', '--write']).code, 0);
});

test('6. Spec change não aprovada (campo ausente ou hash errado) → pausa com erro claro', () => {
    const cases = [
        [{}, /sem aprovação: state.json não tem spec_change_approved/],
        [{ spec_change_approved: false, spec_change_hash: sa.specHash(CHANGED) }, /spec_change_approved=false \(precisa ser true\)/],
        [{ spec_change_approved: true, spec_change_hash: '' }, /spec_change_hash está vazio/],
        [{ spec_change_approved: true }, /spec_change_hash está vazio/],
        [{ spec_change_approved: true, spec_change_hash: sa.specHash(SPEC + 'outra versão') }, /aprovação foi de outra versão da spec/],
    ];
    for (const [approval, re] of cases) {
        const { root, dir, spec } = seedRun({ spec_hash: sa.specHash(SPEC), spec_path: SPEC_PATH, ...approval });
        fs.writeFileSync(spec, CHANGED);
        const state = readJson(path.join(dir, 'state.json'));
        const out = sa.enforceSpecIntegrity(state, { root, taskId: TASK_ID, node: 'implement' });
        assert.strictEqual(out.proceed, false, JSON.stringify(approval));
        assert.match(out.message, re);
        assert.match(out.message, /mudou depois do Plan/);
        assert.strictEqual(state.status, 'spec-drift');
    }
    // CLI: exit 3, grava a pausa e explica como aprovar.
    const { dir, spec } = seedRun({ spec_hash: sa.specHash(SPEC), spec_path: SPEC_PATH });
    fs.writeFileSync(spec, CHANGED);
    const r = cli(['check', dir, '--node=implement', '--write']);
    assert.strictEqual(r.code, 3);
    assert.match(r.out, /SPEC DRIFT — pipeline pausado/);
    assert.match(r.out, new RegExp(`"spec_change_hash": "${sa.specHash(CHANGED)}"`));
    assert.strictEqual(readJson(path.join(dir, 'state.json')).status, 'spec-drift');
});

test('Aprovação vale só para a versão aprovada: nova edição pausa de novo', () => {
    const { root, dir, spec } = seedRun({ spec_hash: sa.specHash(SPEC), spec_path: SPEC_PATH, spec_change_approved: true, spec_change_hash: sa.specHash(CHANGED) });
    fs.writeFileSync(spec, CHANGED);
    const state = readJson(path.join(dir, 'state.json'));
    assert.strictEqual(sa.enforceSpecIntegrity(state, { root, taskId: TASK_ID, node: 'implement' }).proceed, true);
    fs.writeFileSync(spec, CHANGED + '\n- AC-04: novo critério\n');
    assert.strictEqual(sa.enforceSpecIntegrity(state, { root, taskId: TASK_ID, node: 'review' }).proceed, false);
});

test('Resolução: spec revertida retoma; voltar pro /plan retoma; baseline do CLI regrava o hash', () => {
    const { root, dir, spec } = seedRun({ spec_hash: sa.specHash(SPEC), spec_path: SPEC_PATH });
    fs.writeFileSync(spec, CHANGED);
    const state = readJson(path.join(dir, 'state.json'));
    sa.enforceSpecIntegrity(state, { root, taskId: TASK_ID, node: 'implement' });
    fs.writeFileSync(spec, SPEC);
    assert.strictEqual(sa.enforceSpecIntegrity(state, { root, taskId: TASK_ID, node: 'implement' }).proceed, true);
    assert.strictEqual(state.events.at(-1).type, 'spec_drift_resolved');

    fs.writeFileSync(spec, CHANGED);
    sa.enforceSpecIntegrity(state, { root, taskId: TASK_ID, node: 'implement' });
    assert.strictEqual(sa.enforceSpecIntegrity(state, { root, taskId: TASK_ID, node: 'plan' }).proceed, true);
    assert.strictEqual(state.status, 'in_progress');
    assert.strictEqual(state.events.at(-1).type, 'spec_drift_replan');

    fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ ...state, status: 'spec-drift' }));
    const r = cli(['baseline', dir]);
    assert.strictEqual(r.code, 0, r.out);
    const s = readJson(path.join(dir, 'state.json'));
    assert.strictEqual(s.spec_hash, sa.specHash(CHANGED));
    assert.strictEqual(s.spec_path, SPEC_PATH);
    assert.strictEqual(s.spec_hash_by, 'plan');
    assert.strictEqual(s.status, 'in_progress');
});

test('Sem spec_hash: grava baseline (evento spec_baseline) e segue; task sem spec segue sem baseline', () => {
    const { root, dir } = seedRun({ history: ['plan'] });
    const state = readJson(path.join(dir, 'state.json'));
    const out = sa.enforceSpecIntegrity(state, { root, taskId: TASK_ID, node: 'implement' });
    assert.strictEqual(out.proceed, true);
    assert.strictEqual(state.spec_hash, sa.specHash(SPEC));
    assert.strictEqual(state.spec_hash_by, 'watcher');
    assert.strictEqual(state.events.at(-1).type, 'spec_baseline');

    const noSpec = seedRun({});
    fs.rmSync(path.join(noSpec.root, SPEC_PATH));
    const s2 = readJson(path.join(noSpec.dir, 'state.json'));
    assert.strictEqual(sa.enforceSpecIntegrity(s2, { root: noSpec.root, taskId: TASK_ID, node: 'test' }).proceed, true);
    assert.strictEqual(s2.spec_hash, undefined);
    assert.strictEqual(cli(['baseline', noSpec.dir]).code, 2);
});

test('state.json com os campos novos continua válido no schema (spec-drift, spec_hash, spec_conformance)', () => {
    const { validateState } = require('../validate-state');
    const schema = path.join(__dirname, '..', '..', '.graph', 'schemas', 'state.schema.json');
    const state = {
        task_id: TASK_ID, node: 'implement', status: 'spec-drift', history: ['plan'],
        spec_path: SPEC_PATH, spec_hash: sa.specHash(SPEC), spec_hash_at: '2026-09-30T12:00:00.000Z', spec_hash_by: 'plan',
        spec_change_approved: true, spec_change_hash: sa.specHash(CHANGED),
        spec_drift: { detected_at: '2026-09-30T12:00:00.000Z', node: 'implement', spec_path: SPEC_PATH, expected_hash: 'a', current_hash: null, reason: 'x' },
        spec_conformance: { verdict: 'FAIL', checked_at: '2026-09-30T12:00:00.000Z', spec_path: SPEC_PATH, failures: ['PLAN_OMITS_AC: x'], warnings: [] },
    };
    const r = validateState(state, schema);
    assert.ok(r.valid, JSON.stringify(r.errors));
});

// ── Integração com o watcher ─────────────────────────────────────────────────────

const tmp = fs.mkdtempSync(path.join(sandbox, 'watcher-'));
const repo = path.join(tmp, 'app-back');
const binDir = path.join(tmp, 'bin');
const claudeCalls = path.join(tmp, 'claude-calls.log');
fs.mkdirSync(repo, { recursive: true });
fs.mkdirSync(binDir);
fs.writeFileSync(path.join(binDir, 'claude'), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${claudeCalls}'\n`, { mode: 0o755 });
process.env.REPO_PATH = repo;
process.env.REDMINE_URL = 'http://redmine.test';
process.env.REDMINE_API_KEY = 'k';
process.env.SPEC_AUTO_REPAIR = '0';
process.env.SKIP_PRE_BUILD_VALIDATION = 'true';
process.env.PATH = `${binDir}:${process.env.PATH}`;

const redminePuts = [];
global.fetch = async (url, opts = {}) => {
    const id = Number((/issues\/(\d+)\.json/.exec(url) || [])[1]);
    if (opts.method === 'PUT') redminePuts.push({ url, body: JSON.parse(opts.body) });
    return { ok: true, status: 200, json: async () => ({ issue: { id, journals: [] } }) };
};

const watcher = require('../readmine-watcher');

function ticket(id) {
    return {
        id, subject: `Ticket ${id}`, description: SPEC, status: { name: 'Aprovada' }, tracker: { name: 'Melhoria' },
        custom_fields: [{ name: 'Branch Liberação', value: 'Dev - Local' }], updated_on: new Date().toISOString(),
    };
}

// Task pronta pro /review (fora dos portões de plano/build/churn), spec_hash do Plan.
function seedReviewTask(id, stateOver = {}) {
    const wt = path.join(repo, '.claude', 'worktrees', String(id));
    const taskId = `${id}-teste`;
    const dir = path.join(wt, 'memory', 'runs', taskId);
    const specRel = `memory/spec/${id}-spec.md`;
    fs.mkdirSync(dir, { recursive: true });
    fs.mkdirSync(path.join(wt, 'memory', 'spec'), { recursive: true });
    fs.writeFileSync(path.join(wt, specRel), SPEC);
    fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({
        task_id: taskId, node: 'review', history: ['fetch_ticket', 'plan', 'implement'], status: 'in_progress',
        started_at: new Date().toISOString(), redmine_ticket: { id },
        spec_path: specRel, spec_hash: sa.specHash(SPEC), ...stateOver,
    }));
    return { taskId, dir, spec: path.join(wt, specRel) };
}

async function waitFor(pred) {
    for (let i = 0; i < 100; i++) { if (pred()) return true; await new Promise(r => setTimeout(r, 50)); }
    return false;
}
const claudeLog = () => (fs.existsSync(claudeCalls) ? fs.readFileSync(claudeCalls, 'utf8') : '');

test('watcher: spec igual à do Plan → review despachado', async () => {
    const { taskId, dir } = seedReviewTask(92001);
    const r = await watcher.dispatchTicket(ticket(92001));
    assert.strictEqual(r.action, 'dispatched');
    assert.strictEqual(r.node, 'review');
    assert.ok(await waitFor(() => new RegExp(`/review ${taskId}`).test(claudeLog())), claudeLog());
    await waitFor(() => readJson(path.join(dir, 'state.json')).status === 'in_progress');
});

test('watcher: spec mudou sem aprovação → não despacha, status spec-drift, um comentário no Redmine por versão', async () => {
    redminePuts.length = 0;
    const { taskId, dir, spec } = seedReviewTask(92002);
    fs.writeFileSync(spec, CHANGED);
    const r = await watcher.dispatchTicket(ticket(92002));
    assert.strictEqual(r.action, 'skip');
    assert.strictEqual(r.reason, 'spec_drift');
    assert.match(r.detail, /sem aprovação/);
    const s = readJson(path.join(dir, 'state.json'));
    assert.strictEqual(s.status, 'spec-drift');
    assert.strictEqual(s.spec_drift.notified_hash, sa.specHash(CHANGED));
    assert.ok(s.events.some(e => e.type === 'spec_drift'));
    assert.ok(!new RegExp(`/review ${taskId}`).test(claudeLog()));
    assert.strictEqual(redminePuts.length, 1);
    assert.match(redminePuts[0].body.issue.notes, new RegExp(watcher.SPEC_DRIFT_COMMENT_PREFIX.replace(/[[\]]/g, '\\$&')));
    assert.match(redminePuts[0].body.issue.notes, /spec_change_approved/);

    // Tick seguinte, mesma versão: continua parado, sem comentário repetido.
    const again = await watcher.dispatchTicket(ticket(92002));
    assert.strictEqual(again.reason, 'spec_drift');
    assert.strictEqual(redminePuts.length, 1);
});

test('watcher: aprovação gravada no state.json → artefatos da versão anterior STALE e despacha o /plan (não o review)', async () => {
    const { taskId, dir, spec } = seedReviewTask(92003);
    fs.writeFileSync(spec, CHANGED);
    assert.strictEqual((await watcher.dispatchTicket(ticket(92003))).reason, 'spec_drift');
    const s = readJson(path.join(dir, 'state.json'));
    fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ ...s, spec_change_approved: true, spec_change_hash: sa.specHash(CHANGED) }));
    const r = await watcher.dispatchTicket(ticket(92003));
    assert.strictEqual(r.action, 'dispatched', JSON.stringify(r));
    assert.strictEqual(r.node, 'plan', JSON.stringify(r));
    assert.ok(await waitFor(() => new RegExp(`/plan ${taskId}`).test(claudeLog())), claudeLog());
    assert.ok(!new RegExp(`/review ${taskId}`).test(claudeLog()), 'review do plano antigo não roda');
    await waitFor(() => readJson(path.join(dir, 'state.json')).status === 'in_progress');
    const after = readJson(path.join(dir, 'state.json'));
    assert.ok(after.events.some(e => e.type === 'spec_change_accepted'));
    assert.ok(after.events.some(e => e.type === 'artifacts_invalidated'));
    assert.strictEqual(after.artifact_validity.plan.validity.status, 'STALE');
    assert.strictEqual(after.spec_drift, undefined);
});

test('watcher: aprovação com hash errado → continua pausado', async () => {
    const { dir, spec } = seedReviewTask(92004, { spec_change_approved: true, spec_change_hash: sa.specHash(SPEC) });
    fs.writeFileSync(spec, CHANGED);
    const r = await watcher.dispatchTicket(ticket(92004));
    assert.strictEqual(r.reason, 'spec_drift');
    assert.match(r.detail, /outra versão da spec/);
    assert.strictEqual(readJson(path.join(dir, 'state.json')).status, 'spec-drift');
});

test('watcher (Dependency Invalidation): pending_invalidation não interrompe o nó; ao fim dele, invalida e despacha o /plan', async () => {
    const pending = {
        triggered_by: 'SPEC_CHANGE SC-001', new_spec_version: 2, new_spec_hash: 'b'.repeat(64), old_spec_hash: sa.specHash(SPEC), old_spec_version: 1,
        case: 'active_phase', phase: 'review', registered_at: new Date().toISOString(),
    };
    const { taskId, dir } = seedReviewTask(92010, { status: 'running', node_started_at: new Date().toISOString(), pending_invalidation: pending });
    // Nó ainda rodando: nada muda, nada é despachado.
    const busy = await watcher.dispatchTicket(ticket(92010));
    assert.strictEqual(busy.reason, 'no_em_execucao');
    assert.deepStrictEqual(readJson(path.join(dir, 'state.json')).pending_invalidation, pending);
    // O review terminou (lease liberado; o comando gravou node=test).
    const s = readJson(path.join(dir, 'state.json'));
    fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ ...s, status: 'in_progress', node: 'test' }));
    const r = await watcher.dispatchTicket(ticket(92010));
    assert.strictEqual(r.action, 'dispatched', JSON.stringify(r));
    assert.strictEqual(r.node, 'plan');
    assert.ok(await waitFor(() => new RegExp(`/plan ${taskId}`).test(claudeLog())), claudeLog());
    assert.ok(!new RegExp(`/test ${taskId}`).test(claudeLog()), 'o test não roda sobre artefatos da versão anterior');
    const after = readJson(path.join(dir, 'state.json'));
    assert.strictEqual(after.pending_invalidation, undefined);
    assert.strictEqual(after.artifact_validity.evidence.validity.status, 'STALE');
    assert.strictEqual(after.invalidations.at(-1).case, 'active_phase');
    assert.ok(after.events.some(e => e.type === 'invalidation_resolved'));
});
