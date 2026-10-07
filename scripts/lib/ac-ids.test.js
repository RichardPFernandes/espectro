// node --test scripts/lib/ac-ids.test.js
// IDs estáveis dos Critérios de Aceite (AC-XX): validação da spec (spec-validator),
// rastreabilidade no plano (plan-scorer), registro (ac-registry) e numeração (ac-ids).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const acIds = require('./ac-ids');
const { validateSpec, isLegacyAcRun } = require('./spec-validator');
const { scorePlan } = require('./plan-scorer');
const acRegistry = require('./ac-registry');

const FILLER = 'Texto descritivo suficiente para passar do limite mínimo de caracteres exigido pela validação. ';

function spec(criteria) {
    return `## Problema
${FILLER}Hoje o filtro de tipo mistura Remessa e Retorno.

## Solução
${FILLER}Filtrar pelo tipo selecionado.

## Critérios de Aceite
${criteria}

## Restrições
- Não alterar o contrato do endpoint de expedição.

## Arquivos Afetados
- ServiceFiltro.java

## Dependências
- Nenhuma
`;
}

const VALID = spec(`- AC-01: Ao selecionar "Remessa", devem ser exibidos somente registros do tipo Remessa.
- AC-02: O filtro existente por unidade deve continuar funcionando.
- AC-03: O filtro por local de expedição não deve sofrer regressão.`);

const LEGACY = spec(`- Ao selecionar "Remessa", exibe só Remessa.
- O filtro por unidade continua funcionando.`);

const codes = r => r.errors.map(e => e.code);

// ---------------------------------------------------------------------------------
// spec-validator

test('AC válido: formato, unicidade e sequência — válida e devolve os IDs', () => {
    for (const mode of ['optional', 'require', 'legacy']) {
        const r = validateSpec(VALID, { acIds: mode });
        assert.strictEqual(r.valid, true, `${mode}: ${JSON.stringify(r.errors)}`);
        assert.deepStrictEqual(r.acIds, ['AC-01', 'AC-02', 'AC-03']);
        assert.deepStrictEqual(r.warnings, []);
    }
});

test('variações aceitas: negrito, checkbox, travessão, lista numerada, AC-1 sem zero, sub-item de detalhe', () => {
    const r = validateSpec(spec(`1. **AC-1**: primeiro critério
2. [ ] AC-2 — segundo critério
   - detalhe do segundo (nota de correção, não é critério)
3. **AC-3:** terceiro`), { acIds: 'require' });
    assert.strictEqual(r.valid, true, JSON.stringify(r.errors));
    assert.deepStrictEqual(r.acIds, ['AC-1', 'AC-2', 'AC-3']);
});

test('AC duplicado → erro AC_ID_DUPLICATE', () => {
    const r = validateSpec(spec('- AC-01: um\n- AC-02: dois\n- AC-02: dois de novo'));
    assert.strictEqual(r.valid, false);
    assert.deepStrictEqual(codes(r), ['AC_ID_DUPLICATE']);
    assert.match(r.errors[0].message, /AC-02 duplicado/);
    // AC-1 e AC-01 são o mesmo número.
    assert.deepStrictEqual(codes(validateSpec(spec('- AC-01: um\n- AC-1: um de novo'))), ['AC_ID_DUPLICATE']);
});

test('AC fora do padrão ("A-1", "AC1", "ac-01", "AC 1", "AC_01", "AC-01 sem dois-pontos") → erro', () => {
    for (const bad of ['A-1: x', 'AC1: x', 'ac-01: x', 'AC 1 - x', 'AC_01: x', 'AC-01 x', 'CA-1: x']) {
        const r = validateSpec(spec(`- ${bad}\n- AC-02: dois`), { acIds: 'legacy' });
        assert.strictEqual(r.valid, false, bad);
        assert.ok(codes(r).includes('AC_ID_INVALID_FORMAT'), `${bad}: ${codes(r)}`);
    }
});

test('texto comum que começa com "A"/"AC..." não é confundido com ID', () => {
    const r = validateSpec(spec('- A 2ª via do boleto é emitida.\n- Acesso ao menu continua igual.\n- ACME 5 unidades.'), { acIds: 'legacy' });
    assert.strictEqual(r.valid, true);
    assert.deepStrictEqual(r.warnings.map(w => w.code), ['AC_IDS_MISSING_LEGACY']);
});

test('AC com texto vazio → erro AC_EMPTY_TEXT', () => {
    const r = validateSpec(spec('- AC-01:\n- AC-02: dois\n- **AC-03**:'));
    assert.deepStrictEqual(codes(r), ['AC_EMPTY_TEXT', 'AC_EMPTY_TEXT']);
    assert.match(r.errors[0].message, /AC-01 está sem texto/);
});

test('sequência: lacuna, começo fora de AC-01 e ordem trocada → erro', () => {
    assert.deepStrictEqual(codes(validateSpec(spec('- AC-01: um\n- AC-03: três'))), ['AC_ID_SEQUENCE_GAP']);
    assert.match(validateSpec(spec('- AC-02: um\n- AC-03: dois')).errors[0].message, /falta\(m\) AC-01/);
    assert.deepStrictEqual(codes(validateSpec(spec('- AC-02: dois\n- AC-01: um'))), ['AC_ID_OUT_OF_ORDER']);
});

test('seção com IDs: critério sem ID no meio → erro AC_ID_MISSING', () => {
    assert.deepStrictEqual(codes(validateSpec(spec('- AC-01: um\n- dois sem id'))), ['AC_ID_MISSING']);
});

test('mínimo de critérios conta critério com ID, não sub-item', () => {
    const r = validateSpec(spec('- AC-01: único\n  - detalhe\n  - outro detalhe'));
    assert.deepStrictEqual(codes(r), ['INSUFFICIENT_ACCEPTANCE_CRITERIA']);
});

test('critério "(removido em ...)" mantém a sequência mas sai dos IDs aplicáveis', () => {
    const r = validateSpec(spec('- AC-01: um\n- AC-02: (removido em 2026-09-30: fora de escopo) dois\n- AC-03: três'), { acIds: 'require' });
    assert.strictEqual(r.valid, true);
    assert.deepStrictEqual(r.acIds, ['AC-01', 'AC-03']);
});

test('spec antiga sem IDs: aviso em modo legacy (não erro); erro em require; nada em optional', () => {
    const legacy = validateSpec(LEGACY, { acIds: 'legacy' });
    assert.strictEqual(legacy.valid, true);
    assert.deepStrictEqual(legacy.warnings.map(w => w.code), ['AC_IDS_MISSING_LEGACY']);
    assert.deepStrictEqual(legacy.acIds, []);

    const required = validateSpec(LEGACY, { acIds: 'require' });
    assert.strictEqual(required.valid, false);
    assert.deepStrictEqual(codes(required), ['AC_IDS_MISSING']);
    assert.deepStrictEqual(required.missingSections, [], 'falta de ID não é seção faltando (auto-repair não dispara)');

    const optional = validateSpec(LEGACY);
    assert.strictEqual(optional.valid, true);
    assert.deepStrictEqual(optional.warnings, []);
});

test('validador nunca altera a spec e recusa política desconhecida', () => {
    const src = spec('- AC-01: um\n- AC-01: dois');
    const copy = String(src);
    validateSpec(src, { acIds: 'require' });
    assert.strictEqual(src, copy);
    assert.throws(() => validateSpec(VALID, { acIds: 'strict' }), /acIds inválido/);
});

test('isLegacyAcRun: run com ac_ids é novo; sem ac_ids, decide por started_at', () => {
    assert.strictEqual(isLegacyAcRun({ ac_ids: [], started_at: '2026-01-01T00:00:00Z' }), false);
    assert.strictEqual(isLegacyAcRun({ started_at: '2026-09-01T00:00:00Z' }), true);
    assert.strictEqual(isLegacyAcRun({ started_at: '2026-10-02T00:00:00Z' }), false);
    assert.strictEqual(isLegacyAcRun({}), true, 'sem data = histórico');
    assert.strictEqual(isLegacyAcRun(null), true);
});

test('CLI do spec-validator: padrão exige IDs; --legacy só avisa', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-cli-'));
    const file = path.join(dir, 'x-spec.md');
    fs.writeFileSync(file, LEGACY);
    const cli = path.join(__dirname, 'spec-validator.js');
    assert.throws(() => execFileSync('node', [cli, file], { stdio: 'pipe' }), e => e.status === 1);
    const out = execFileSync('node', [cli, file, '--legacy'], { encoding: 'utf8' });
    assert.match(out, /Spec válida[\s\S]*\[aviso\].*sem IDs AC-XX/);
    fs.rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------------
// ac-ids: numeração (entrada de ciclo novo)

test('numberCriteriaText numera sem mudar o texto; assignAcIds continua do maior ID', () => {
    assert.strictEqual(acIds.numberCriteriaText('- um\n- dois\n  - detalhe\n1. três'),
        '- AC-01: um\n- AC-02: dois\n  - detalhe\n1. AC-03: três');
    assert.deepStrictEqual(acIds.assignAcIds(['- AC-01: a', '- AC-02: b', '- novo']).lines,
        ['- AC-01: a', '- AC-02: b', '- AC-03: novo']);
    const blocked = acIds.assignAcIds(['- AC1: a', '- b']);
    assert.deepStrictEqual(blocked.lines, ['- AC1: a', '- b'], 'ID malformado: não mexe');
    assert.deepStrictEqual(blocked.blocked, ['AC1']);
});

test('CLI ac-ids number --write numera só a seção de critérios e preserva o resto', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-number-'));
    const file = path.join(dir, 'x-spec.md');
    const src = LEGACY.replace('## Critérios de Aceite\n', '## Critérios de Aceite\n<!-- comentário\n- não é item -->\n');
    fs.writeFileSync(file, src);
    const out = execFileSync('node', [path.join(__dirname, 'ac-ids.js'), 'number', file, '--write'], { encoding: 'utf8' });
    assert.match(out, /AC-01, AC-02/);
    const after = fs.readFileSync(file, 'utf8');
    assert.strictEqual(after, src
        .replace('- Ao selecionar', '- AC-01: Ao selecionar')
        .replace('- O filtro por unidade', '- AC-02: O filtro por unidade'));
    assert.strictEqual(validateSpec(after, { acIds: 'require' }).valid, true);
    fs.rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------------
// plan-scorer

const plan = steps => `# Handoff\n\n## Plano de execução\n${steps}\n`;
const GOOD = plan(`1. Alterar filtro do serviço para o tipo selecionado.
   - Arquivo: \`app-core/src/main/java/br/com/mo/ServiceFiltro.java\`
   - Critérios: AC-01, AC-02
   - Verificação: verificar que seleção de Remessa retorna só Remessa
2. Preservar o filtro por local de expedição.
   - Arquivo: \`app-core/src/main/java/br/com/mo/ServiceFiltro.java\`
   - Critérios: AC-03
   - Verificação: teste do filtro por local continua passando
3. Escrever testes do filtro.
   - Arquivo: ServiceFiltroTest.java
   - Verificação: mvn test passa`);

test('plano com todos os ACs citados por ID: 100, sem feedback de AC', () => {
    const r = scorePlan(GOOD, VALID, { threshold: 60 });
    assert.strictEqual(r.score, 100, JSON.stringify(r.feedback));
    assert.strictEqual(r.acTrace.mode, 'ids');
    assert.deepStrictEqual(r.acTrace.uncovered, []);
    assert.deepStrictEqual(r.acTrace.unknownRefs, []);
    assert.deepStrictEqual(r.acTrace.visibleWithoutAc, []);
});

test('plan sem cobertura de um AC → plan-scorer reporta', () => {
    const r = scorePlan(GOOD.replace('   - Critérios: AC-03\n', ''), VALID, { threshold: 60 });
    assert.deepStrictEqual(r.acTrace.uncovered, ['AC-03']);
    assert.ok(r.feedback.some(f => /^AC-03 não é endereçado por nenhum step/.test(f)), r.feedback.join('\n'));
    assert.ok(r.score < 100);
});

test('plan referenciando AC inexistente → plan-scorer reporta', () => {
    const r = scorePlan(GOOD.replace('Critérios: AC-03', 'Critérios: AC-03, AC-07'), VALID, { threshold: 60 });
    assert.deepStrictEqual(r.acTrace.unknownRefs, [{ step: 2, id: 'AC-07' }]);
    assert.ok(r.feedback.some(f => /Step 2 referencia AC-07, que não existe na Spec/.test(f)), r.feedback.join('\n'));
    assert.ok(r.score < 100);
});

test('passo que muda comportamento visível sem AC → reportado; passo só de teste não', () => {
    const extra = GOOD.replace('3. Escrever testes do filtro.', `3. Adicionar ordenação por data na listagem da tela.
   - Arquivo: \`app-front/app/routes/expedicao/lista.html\`
   - Verificação: conferir no preview
4. Escrever testes do filtro.`);
    const r = scorePlan(extra, VALID, { threshold: 60 });
    assert.deepStrictEqual(r.acTrace.visibleWithoutAc, [3]);
    assert.ok(r.feedback.some(f => /Step 3 muda comportamento visível/.test(f)));
});

test('AC "(removido em ...)" não precisa de passo, e citá-lo não é referência inexistente', () => {
    const s = spec('- AC-01: um filtro\n- AC-02: (removido em 2026-09-30: fora de escopo) dois\n- AC-03: três filtro');
    const r = scorePlan(GOOD.replace('Critérios: AC-01, AC-02', 'Critérios: AC-01'), s, { threshold: 60 });
    assert.deepStrictEqual(r.acTrace.uncovered, []);
    assert.deepStrictEqual(r.acTrace.unknownRefs, []);
});

test('spec antiga sem IDs: plan-scorer segue na heurística de antes (modo legacy)', () => {
    const r = scorePlan(GOOD, LEGACY, { threshold: 60 });
    assert.strictEqual(r.acTrace.mode, 'legacy');
    assert.ok(!r.feedback.some(f => /não existe na Spec|comportamento visível/.test(f)));
});

// ---------------------------------------------------------------------------------
// ac-registry

test('registro v2: só ticket_id/spec_hash/ac_ids — sem texto do critério', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-reg-'));
    const registryPath = path.join(dir, 'ac-registry.json');
    const acs = acRegistry.extractACs(VALID, '43646');
    assert.deepStrictEqual(acs.acIds, ['AC-01', 'AC-02', 'AC-03']);
    acRegistry.updateRegistry('43646', acs, { registryPath, specContent: VALID });
    const entry = JSON.parse(fs.readFileSync(registryPath, 'utf8')).tasks['43646'];
    assert.strictEqual(entry.ticket_id, '43646');
    assert.strictEqual(entry.spec_hash, acRegistry.specHash(VALID));
    assert.deepStrictEqual(entry.ac_ids, ['AC-01', 'AC-02', 'AC-03']);
    assert.ok(!('criteria' in entry) && !('legacy' in entry), 'texto fica só na spec');
    fs.rmSync(dir, { recursive: true, force: true });
});

test('registro: entrada v1 da mesma spec não é reescrita; spec legada vira entrada legacy', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-reg-v1-'));
    const registryPath = path.join(dir, 'ac-registry.json');
    const crit = acRegistry.extractACs(LEGACY, '1').criteria;
    const v1 = { version: 1, updatedAt: null, tasks: { 1: { criteria: crit, specHash: acRegistry.specHash(LEGACY), indexedAt: 'x' } } };
    fs.writeFileSync(registryPath, JSON.stringify(v1));
    const r = acRegistry.updateRegistry('1', acRegistry.extractACs(LEGACY, '1'), { registryPath, specContent: LEGACY });
    assert.strictEqual(r.changed, false);
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(registryPath, 'utf8')), v1);

    acRegistry.updateRegistry('2', acRegistry.extractACs(LEGACY, '2'), { registryPath, specContent: LEGACY });
    const e2 = JSON.parse(fs.readFileSync(registryPath, 'utf8')).tasks['2'];
    assert.strictEqual(e2.legacy, true);
    assert.deepStrictEqual(e2.ac_ids, []);
    assert.deepStrictEqual(e2.criteria, crit);
    fs.rmSync(dir, { recursive: true, force: true });
});
