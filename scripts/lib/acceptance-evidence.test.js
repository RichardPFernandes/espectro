// node --test scripts/lib/acceptance-evidence.test.js
// Matriz de cobertura dos ACs (acceptance-evidence.json): o /test escreve, o /verify
// (spec-authority.js verify) confere contra os artefatos reais — runs sintéticos com
// spec, plano, handoff e relatório surefire no formato do maven-surefire 3.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ae = require('./acceptance-evidence');
const sa = require('./spec-authority');

const FILLER = 'Texto descritivo suficiente para passar do limite mínimo de caracteres exigido pela validação. ';
const SPEC_PATH = 'memory/spec/43646-spec.md';
const TASK_ID = '43646-resumo-remessa';
const REPORT = 'target/surefire-reports/TEST-br.com.mosistemas.ResumoServiceTest.xml';

const SPEC = `# Spec 43646

## Problema
${FILLER}O resumo mistura remessas e devoluções.

## Solução
${FILLER}Filtrar por tipo.

## Critérios de Aceite
- AC-01: Ao selecionar "Remessa", o resumo exibe só registros do tipo Remessa.
- AC-02: O filtro de unidade continua aplicado depois de trocar o tipo.
- AC-03: O destaque visual do tipo selecionado segue o padrão da tela.
`;

const PLAN = `# Plano — ${TASK_ID}

## Referência da Spec
- Spec: ${SPEC_PATH}
- ACs: AC-01, AC-02, AC-03

## Plano de execução
1. Filtrar o resumo por tipo.
   - Arquivo: \`src/main/java/br/com/mosistemas/ResumoService.java\`
   - Critérios: AC-01
   - Verificação: teste unitário.
2. Preservar o filtro de unidade.
   - Arquivo: \`src/main/java/br/com/mosistemas/FiltroUnidade.java\`
   - Critérios: AC-02
   - Verificação: teste de regressão.
3. Destacar o tipo selecionado.
   - Arquivo: \`app-front/src/resumo/resumo.html\`
   - Critérios: AC-03
   - Verificação: visual.

## Cobertura dos ACs
- AC-01 → passo 1 — filtro no service.
- AC-02 → passo 2 — estado do filtro mantido.
- AC-03 → passo 3 — classe CSS.
`;

const HANDOFF = `# Handoff — ${TASK_ID}

## Referência da Spec
- Spec: ${SPEC_PATH}
- ACs: AC-01, AC-02, AC-03
- Plan: memory/runs/${TASK_ID}/plan.md
`;

const surefire = (cases) => `<?xml version="1.0" encoding="UTF-8"?>
<testsuite name="br.com.mosistemas.ResumoServiceTest" tests="${cases.length}" errors="0" skipped="0" failures="0">
${cases.map(([cls, name, body]) => body
        ? `  <testcase name="${name}" classname="br.com.mosistemas.${cls}" time="0.01">\n    ${body}\n  </testcase>`
        : `  <testcase name="${name}" classname="br.com.mosistemas.${cls}" time="0.01"/>`).join('\n')}
</testsuite>
`;
const GREEN = surefire([
    ['ResumoServiceTest', 'filtraRemessa'],
    ['ResumoServiceTest', 'filtraRemessaSemDevolucao'],
    ['ResumoServiceTest$FiltroUnidadeTests', 'mantemFiltro'],
]);

const ev = (description, extra = {}) => ({ description, type: 'automated-test', artifact: REPORT, result: 'PASS', ...extra });
const MANUAL = {
    status: 'NOT_AUTOMATED',
    justification: 'Destaque é CSS do app-front; sem teste visual automatizado no projeto.',
    evidence: [{ description: 'validação visual necessária', type: 'manual', result: 'NOT_AUTOMATED', justification: 'Sem infraestrutura de teste visual (Selenium/Percy) no app-front.' }],
};
function coverage(over = {}) {
    const c = {
        'AC-01': { status: 'PASS', evidence: [ev('ResumoServiceTest#filtraRemessa')] },
        'AC-02': { status: 'PASS', evidence: [ev('FiltroUnidadeTests#mantemFiltro', { type: 'regression-test' })] },
        'AC-03': MANUAL,
        ...over,
    };
    for (const k of Object.keys(c)) if (c[k] === undefined) delete c[k];
    return c;
}
const matrix = (over = {}, spec = SPEC) => ({ schema_version: 1, run_id: TASK_ID, generated_at: '2026-09-30T12:00:00.000Z', spec_hash: sa.specHash(spec), coverage: coverage(over) });

const sandbox = fs.mkdtempSync(path.join(process.env.CLAUDE_JOB_DIR ? path.join(process.env.CLAUDE_JOB_DIR, 'tmp') : os.tmpdir(), 'acceptance-evidence-'));
let seq = 0;
function seedRun({ acceptance = matrix(), report = GREEN, spec = SPEC } = {}) {
    const root = path.join(sandbox, `r${++seq}`);
    const dir = path.join(root, 'memory', 'runs', TASK_ID);
    fs.mkdirSync(dir, { recursive: true });
    fs.mkdirSync(path.join(root, 'memory', 'spec'), { recursive: true });
    fs.writeFileSync(path.join(root, SPEC_PATH), spec);
    fs.writeFileSync(path.join(dir, 'plan.md'), PLAN);
    fs.writeFileSync(path.join(dir, 'handoff.md'), HANDOFF);
    if (acceptance) fs.writeFileSync(path.join(dir, ae.FILE), typeof acceptance === 'string' ? acceptance : JSON.stringify(acceptance, null, 2));
    if (report) {
        fs.mkdirSync(path.join(root, path.dirname(REPORT)), { recursive: true });
        fs.writeFileSync(path.join(root, REPORT), report);
    }
    fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({
        task_id: TASK_ID, node: 'verify', status: 'in_progress', started_at: '2026-10-02T09:00:00Z',
        ac_ids: ['AC-01', 'AC-02', 'AC-03'], redmine_ticket: { id: 43646 },
        spec_path: SPEC_PATH, spec_hash: sa.specHash(SPEC),
    }, null, 2));
    return { root, dir };
}
const readJson = f => JSON.parse(fs.readFileSync(f, 'utf8'));
function run(script, args) {
    try {
        return { code: 0, out: execFileSync('node', [path.join(__dirname, script), ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) };
    } catch (e) {
        return { code: e.status, out: `${e.stdout || ''}${e.stderr || ''}` };
    }
}
const verify = dir => run('spec-authority.js', ['verify', dir, '--write']);
const verifyJson = dir => JSON.parse(run('spec-authority.js', ['verify', dir, '--json']).out);
const codes = r => r.failures.map(f => f.code);

// ── Testes obrigatórios ─────────────────────────────────────────────────────────

test('AC sem evidência → Verify FAIL', () => {
    const { dir } = seedRun({ acceptance: matrix({ 'AC-02': undefined }) });
    const r = verify(dir);
    assert.strictEqual(r.code, 1, r.out);
    assert.match(r.out, /\[FAIL\] AC_WITHOUT_EVIDENCE: AC-02 não está em acceptance-evidence\.json/);
    const s = readJson(path.join(dir, 'state.json'));
    assert.strictEqual(s.spec_conformance.verdict, 'FAIL');
    assert.strictEqual(s.spec_conformance.acceptance.verified['AC-02'], 'MISSING');

    // Sem matriz nenhuma (run novo): também FAIL.
    const none = seedRun({ acceptance: null });
    assert.match(verify(none.dir).out, /EVIDENCE_MISSING/);
});

test('AC PASS com artifact existente → Verify PASS (e grava o elo VERIFY na matriz)', () => {
    const { dir } = seedRun();
    const r = verify(dir);
    assert.strictEqual(r.code, 0, r.out);
    assert.match(r.out, /Veredito: \*\*PASS\*\*/);
    const m = readJson(path.join(dir, ae.FILE));
    assert.strictEqual(m.verification.verdict, 'PASS');
    assert.deepStrictEqual(m.verification.results['AC-01'], { verdict: 'PASS', problems: [] });
    assert.strictEqual(m.verification.spec_hash, sa.specHash(SPEC));
    assert.deepStrictEqual(ae.validateSchema(m), [], 'matriz com verification continua válida no schema');
});

test('AC FAIL → Verify propaga FAIL', () => {
    const report = surefire([
        ['ResumoServiceTest', 'filtraRemessa', '<failure message="expected: &lt;1&gt; but was: &lt;2&gt;" type="org.opentest4j.AssertionFailedError"/>'],
        ['ResumoServiceTest$FiltroUnidadeTests', 'mantemFiltro'],
    ]);
    const { dir } = seedRun({ report, acceptance: matrix({ 'AC-01': { status: 'FAIL', evidence: [ev('ResumoServiceTest#filtraRemessa', { result: 'FAIL' })] } }) });
    const r = verifyJson(dir);
    assert.strictEqual(r.verdict, 'FAIL');
    assert.ok(codes(r).includes('AC_EVIDENCE_FAIL'), JSON.stringify(r.failures));
    assert.strictEqual(r.acceptance.results['AC-01'].verdict, 'FAIL');
    assert.ok(!codes(r).includes('RESULT_MISMATCH'), 'FAIL relatado bate com o relatório');
});

test('AC manual (NOT_AUTOMATED) → registrado com justificativa, não reprova', () => {
    const { dir } = seedRun();
    const r = verify(dir);
    assert.strictEqual(r.code, 0, r.out);
    assert.match(r.out, /\[WARN\] AC_NOT_AUTOMATED: AC-03 NOT_AUTOMATED — requer validação humana: Destaque é CSS/);
    assert.match(r.out, /## Validação humana pendente \(NOT_AUTOMATED\)/);
    const s = readJson(path.join(dir, 'state.json'));
    assert.strictEqual(s.spec_conformance.acceptance.verified['AC-03'], 'NOT_AUTOMATED');
    assert.deepStrictEqual(s.spec_conformance.acceptance.not_automated, ['AC-03']);

    // Sem justificativa (no AC ou na evidência) reprova.
    const bare = seedRun({ acceptance: matrix({ 'AC-03': { status: 'NOT_AUTOMATED', evidence: [{ description: 'visual', type: 'manual', result: 'NOT_AUTOMATED' }] } }) });
    const f = verifyJson(bare.dir);
    assert.strictEqual(f.verdict, 'FAIL');
    assert.ok(codes(f).includes('AC_NOT_AUTOMATED_WITHOUT_JUSTIFICATION'), JSON.stringify(f.failures));
    assert.ok(codes(f).includes('EVIDENCE_WITHOUT_JUSTIFICATION'));
});

test('Evidência apontando para arquivo inexistente → Verify rejeita', () => {
    const { dir } = seedRun({ acceptance: matrix({ 'AC-01': { status: 'PASS', evidence: [ev('ResumoServiceTest#filtraRemessa', { artifact: 'target/surefire-reports/TEST-NaoExiste.xml' })] } }) });
    const r = verifyJson(dir);
    assert.strictEqual(r.verdict, 'FAIL');
    const f = r.failures.find(x => x.code === 'ARTIFACT_NOT_FOUND');
    assert.ok(f, JSON.stringify(r.failures));
    assert.match(f.message, /TEST-NaoExiste\.xml/);
    assert.strictEqual(r.acceptance.results['AC-01'].verdict, 'FAIL', 'PASS relatado não sobrevive a artifact inexistente');

    // Teste automatizado sem artifact nenhum também não passa.
    const noArt = seedRun({ acceptance: matrix({ 'AC-01': { status: 'PASS', evidence: [ev('ResumoServiceTest#filtraRemessa', { artifact: undefined })] } }) });
    assert.ok(codes(verifyJson(noArt.dir)).includes('ARTIFACT_MISSING'));
});

test('Múltiplas evidências para o mesmo AC → todas agrupadas sob o mesmo ID', () => {
    const multi = { status: 'PASS', evidence: [
        ev('ResumoServiceTest#filtraRemessa'),
        ev('ResumoServiceTest#filtraRemessaSemDevolucao', { type: 'regression-test' }),
        { description: 'mvn -q compile', type: 'build', artifact: `memory/runs/${TASK_ID}/evidence/build.log`, result: 'PASS' },
    ] };
    const { dir } = seedRun({ acceptance: matrix({ 'AC-01': multi }) });
    fs.mkdirSync(path.join(dir, 'evidence'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'evidence', 'build.log'), '[INFO] Compiling 3 source files\n[INFO] BUILD SUCCESS\n');
    const r = verifyJson(dir);
    assert.strictEqual(r.verdict, 'PASS', JSON.stringify(r.failures));
    const row = r.coverage.find(c => c.id === 'AC-01');
    assert.strictEqual(r.coverage.filter(c => c.id === 'AC-01').length, 1);
    assert.match(row.evidence, /filtraRemessa \[automated-test.*filtraRemessaSemDevolucao \[regression-test.*mvn -q compile \[build/);

    const md = run('acceptance-evidence.js', ['render', dir, '--write']).out;
    assert.strictEqual((md.match(/\*\*AC-01\*\*/g) || []).length, 1, 'ID aparece uma vez; evidências extras em linhas de continuação');
    assert.strictEqual(md.split('\n').filter(l => /^\|  \|/.test(l)).length, 2);
    assert.ok(fs.existsSync(path.join(dir, 'ac-evidence.md')));

    // O mesmo AC duas vezes como chave é rejeitado (JSON.parse engoliria a primeira).
    const dupRaw = JSON.stringify(matrix(), null, 2).replace('"AC-02": {', '"AC-01": { "status": "PASS", "evidence": [] },\n    "AC-02": {');
    const dup = seedRun({ acceptance: dupRaw });
    assert.ok(codes(verifyJson(dup.dir)).includes('EVIDENCE_DUPLICATE_AC'));
});

test('AC novo na Spec depois do Test rodar → Verify detecta AC sem cobertura', () => {
    const { root, dir } = seedRun();
    const grown = SPEC.replace('## Critérios de Aceite\n', '## Critérios de Aceite\n') + '- AC-04: O total do resumo considera só o tipo selecionado.\n';
    const specFile = path.join(root, SPEC_PATH);
    fs.writeFileSync(specFile, grown.replace(/(- AC-03:.*\n)\n?/, '$1'));
    // Mudança aprovada por humano (sem aprovação o drift já reprovaria antes).
    const st = readJson(path.join(dir, 'state.json'));
    Object.assign(st, { spec_change_approved: true, spec_change_hash: sa.specHash(fs.readFileSync(specFile, 'utf8')) });
    fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify(st, null, 2));
    fs.writeFileSync(path.join(dir, 'plan.md'), PLAN.replace('- AC-03 → passo 3', '- AC-04 → passo 1 — total filtrado.\n- AC-03 → passo 3'));
    fs.writeFileSync(path.join(dir, 'handoff.md'), HANDOFF.replace('AC-01, AC-02, AC-03', 'AC-01, AC-02, AC-03, AC-04'));

    const r = verifyJson(dir);
    assert.strictEqual(r.verdict, 'FAIL');
    assert.ok(r.failures.some(f => f.code === 'AC_WITHOUT_EVIDENCE' && /AC-04/.test(f.message)), JSON.stringify(r.failures));
    assert.ok(codes(r).includes('EVIDENCE_SPEC_STALE'), 'matriz gerada sobre a versão anterior da spec');
    assert.strictEqual(r.acceptance.results['AC-04'].verdict, 'MISSING');
});

// ── Não confiar no relato do subagente ──────────────────────────────────────────

test('PASS relatado com o teste falhando/ignorado no relatório → RESULT_MISMATCH / TEST_SKIPPED', () => {
    const report = surefire([
        ['ResumoServiceTest', 'filtraRemessa', '<error message="NPE" type="java.lang.NullPointerException"/>'],
        ['ResumoServiceTest$FiltroUnidadeTests', 'mantemFiltro', '<skipped message="@Disabled"/>'],
    ]);
    const r = verifyJson(seedRun({ report }).dir);
    assert.strictEqual(r.verdict, 'FAIL');
    assert.ok(r.failures.some(f => f.code === 'RESULT_MISMATCH' && /AC-01/.test(f.message) && /registra FAIL/.test(f.message)), JSON.stringify(r.failures));
    assert.ok(r.failures.some(f => f.code === 'TEST_SKIPPED' && /AC-02/.test(f.message)));
});

test('Teste alegado que não está no relatório → TEST_NOT_EXECUTED; sem Classe#metodo → TEST_NOT_IDENTIFIED', () => {
    const ghost = seedRun({ acceptance: matrix({ 'AC-01': { status: 'PASS', evidence: [ev('ResumoServiceTest#testeQueNuncaExistiu')] } }) });
    assert.ok(verifyJson(ghost.dir).failures.some(f => f.code === 'TEST_NOT_EXECUTED' && /testeQueNuncaExistiu/.test(f.message)));
    const vague = seedRun({ acceptance: matrix({ 'AC-01': { status: 'PASS', evidence: [ev('testes do resumo passaram')] } }) });
    assert.ok(codes(verifyJson(vague.dir)).includes('TEST_NOT_IDENTIFIED'));
});

test('Diretório de relatórios como artifact, nested class e parametrizado são encontrados', () => {
    const report = surefire([
        ['ResumoServiceTest', 'filtraRemessa(String)[1]'],
        ['ResumoServiceTest', 'filtraRemessa(String)[2]'],
        ['ResumoServiceTest$FiltroUnidadeTests', 'mantemFiltro'],
    ]);
    const acc = matrix({ 'AC-01': { status: 'PASS', evidence: [ev('ResumoServiceTest#filtraRemessa', { artifact: 'target/surefire-reports/' })] } });
    const r = verifyJson(seedRun({ report, acceptance: acc }).dir);
    assert.strictEqual(r.verdict, 'PASS', JSON.stringify(r.failures));
});

test('Status do AC incoerente com as evidências, BLOCKED e not-applicable', () => {
    const { dir } = seedRun({ acceptance: matrix({
        'AC-01': { status: 'PASS', evidence: [ev('ResumoServiceTest#filtraRemessa'), { description: 'integração com API Farmasi', type: 'integration-test', result: 'BLOCKED', justification: 'Sandbox da API Farmasi fora do ar desde 29/09.' }], justification: 'API externa indisponível.' },
        'AC-02': { status: 'NOT_AUTOMATED', evidence: [ev('FiltroUnidadeTests#mantemFiltro')], justification: 'qualquer coisa aqui' },
        'AC-03': { status: 'PASS', evidence: [{ description: 'não há front nesta task', type: 'not-applicable', result: 'PASS', justification: 'Mudança só de back-end, sem tela.' }] },
    }) });
    const r = verifyJson(dir);
    assert.ok(r.failures.some(f => f.code === 'AC_STATUS_INCONSISTENT' && /AC-01 declarado PASS.*agregam BLOCKED/.test(f.message)), JSON.stringify(r.failures));
    assert.ok(r.failures.some(f => f.code === 'AC_BLOCKED' && /AC-01/.test(f.message)));
    assert.ok(r.failures.some(f => f.code === 'AC_STATUS_INCONSISTENT' && /AC-02/.test(f.message)));
    assert.ok(r.failures.some(f => f.code === 'AC_ONLY_NOT_APPLICABLE' && /AC-03/.test(f.message)));
});

test('Build: "BUILD FAILURE" no log contradiz PASS; linha âncora fora do arquivo é rejeitada', () => {
    const { dir } = seedRun({ acceptance: matrix({ 'AC-01': { status: 'PASS', evidence: [
        ev('ResumoServiceTest#filtraRemessa'),
        { description: 'mvn compile', type: 'build', artifact: `memory/runs/${TASK_ID}/evidence/build.log#L2`, result: 'PASS' },
        { description: 'checkstyle', type: 'static-analysis', artifact: `memory/runs/${TASK_ID}/evidence/build.log:99`, result: 'PASS' },
    ] } }) });
    fs.mkdirSync(path.join(dir, 'evidence'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'evidence', 'build.log'), '[ERROR] cannot find symbol\n[INFO] BUILD FAILURE\n');
    const r = verifyJson(dir);
    assert.ok(r.failures.some(f => f.code === 'RESULT_MISMATCH' && /BUILD FAILURE/.test(f.message)), JSON.stringify(r.failures));
    assert.ok(r.failures.some(f => f.code === 'ARTIFACT_NOT_FOUND' && /linha 99/.test(f.message)));
});

// ── Schema, finalize, trace, scan ───────────────────────────────────────────────

test('Schema: matriz válida passa; campos obrigatórios e enums são cobrados', () => {
    assert.deepStrictEqual(ae.validateSchema(matrix()), []);
    const bad = matrix({ 'AC-01': { status: 'OK', evidence: [{ description: 'x', type: 'unit', result: 'PASS' }] } });
    delete bad.spec_hash;
    const errs = ae.validateSchema(bad);
    assert.ok(errs.some(e => /spec_hash/.test(e)), errs.join('\n'));
    assert.ok(errs.some(e => /coverage\.AC-01\.status/.test(e)));
    assert.ok(errs.some(e => /coverage\.AC-01\.evidence\[0\]\.type/.test(e)));
    assert.ok(ae.validateSchema({ ...matrix(), coverage: { 'AC-1': coverage()['AC-01'] } }).some(e => /AC-1/.test(e)));
    const r = verifyJson(seedRun({ acceptance: '{ não é json' }).dir);
    assert.ok(codes(r).includes('EVIDENCE_INVALID'));
});

test('finalize carimba run_id/spec_hash/summary e liga AC → passos/arquivos do plano; trace mostra a cadeia', () => {
    const draft = { coverage: coverage() }; // o /test escreve só a cobertura
    const { dir } = seedRun({ acceptance: draft });
    const f = run('acceptance-evidence.js', ['finalize', dir]);
    assert.strictEqual(f.code, 0, f.out);
    const m = readJson(path.join(dir, ae.FILE));
    assert.strictEqual(m.run_id, TASK_ID);
    assert.strictEqual(m.ticket_id, '43646');
    assert.strictEqual(m.spec_hash, sa.specHash(SPEC));
    assert.strictEqual(m.spec_path, SPEC_PATH);
    assert.deepStrictEqual(m.coverage['AC-02'].plan_steps, [2]);
    assert.deepStrictEqual(m.coverage['AC-02'].implementation, ['src/main/java/br/com/mosistemas/FiltroUnidade.java']);
    assert.deepStrictEqual(m.summary, {
        total: 3, by_status: { PASS: 2, NOT_AUTOMATED: 1 }, by_evidence_type: { 'automated-test': 1, 'regression-test': 1, manual: 1 },
        automated: 2, automated_pct: 66.7, not_automated: ['AC-03'], failed: [], blocked: [],
    });
    assert.deepStrictEqual(ae.validateSchema(m), []);

    assert.strictEqual(verify(dir).code, 0);
    const t = run('acceptance-evidence.js', ['trace', dir, 'AC-02']);
    assert.strictEqual(t.code, 0, t.out);
    assert.match(t.out, /^SPEC +memory\/spec\/43646-spec\.md: AC-02 — O filtro de unidade continua aplicado/m);
    assert.match(t.out, /^PLAN +passo 2: Preservar o filtro de unidade\./m);
    assert.match(t.out, /^IMPLEMENTATION +src\/main\/java\/br\/com\/mosistemas\/FiltroUnidade\.java/m);
    assert.match(t.out, /^TEST +PASS — FiltroUnidadeTests#mantemFiltro \[regression-test\] PASS \(target\/surefire-reports\//m);
    assert.match(t.out, /^VERIFY +PASS \(/m);

    // finalize avisa (exit 1) quando falta AC ativo da spec na matriz.
    const partial = seedRun({ acceptance: { coverage: coverage({ 'AC-03': undefined }) } });
    const p = run('acceptance-evidence.js', ['finalize', partial.dir]);
    assert.strictEqual(p.code, 1);
    assert.match(p.out, /fora da matriz: AC-03/);
});

test('scan lista os testcases executados (para o /test montar test/artifact sem adivinhar)', () => {
    const { root } = seedRun();
    const r = run('acceptance-evidence.js', ['scan', path.join(root, 'target/surefire-reports')]);
    assert.strictEqual(r.code, 0, r.out);
    assert.match(r.out, /PASS +ResumoServiceTest#filtraRemessa /);
    assert.match(r.out, /PASS +ResumoServiceTest\$FiltroUnidadeTests#mantemFiltro /);
});
