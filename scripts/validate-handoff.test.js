// node --test scripts/validate-handoff.test.js
// Validação do Agent Handoff Contract (scripts/validate-handoff.js), versões 1.0 e 1.1.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { validate, validateFile, extractYaml } = require('./validate-handoff.js');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'validate-handoff-'));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const codes = (r) => r.map((x) => `${x.level}:${x.code}`);
const errors = (r) => r.filter((x) => x.level === 'ERROR').map((x) => x.code);

const v10 = () => ({
    handoff_version: '1.0',
    task: { id: 'PRI-94', objective: 'Provar e2e com stub', specification_ref: 'PRI-94' },
    execution: { agent: 'implementer', status: 'COMPLETED', summary: 'Teste novo', branch: 'feat/x', commit: null },
    artifacts: [{ path: 'scripts/a.test.js', action: 'CREATED', description: 'teste' }],
    decisions: { approved: [], proposed: [] },
    validation: { executed: [{ command: 'node --test scripts/a.test.js', result: 'PASSED', evidence: 'run.log' }], not_executed: [] },
    open_issues: [],
    next: { recommended_agent: 'reviewer', action: 'Revisar', prerequisites: [] },
    context_refs: [],
});
const v11 = () => ({
    ...v10(),
    handoff_version: '1.1',
    task: { ...v10().task, acceptance_criteria: ['AC1', 'AC2'] },
    routing: { from: 'Implementador', to: 'Revisor', runtime: 'claude', fallback_reason: null },
    risk: { level: 'MEDIUM', signals: [], classified_by: 'Coordenador' },
    facts: ['git diff --exit-code HEAD rc=0'],
    assumptions: [],
    usage: { duration: '90s', retries: 0, tokens: 'UNKNOWN' },
});

test('v1.0 completo é válido (compatibilidade)', () => {
    assert.deepStrictEqual(errors(validate(v10())), []);
});

test('v1.1 completo é válido', () => {
    assert.deepStrictEqual(codes(validate(v11())), []);
});

test('o template do repositório é estruturalmente reconhecido, mas reprova por estar vazio', () => {
    const { results } = validateFile(path.join(__dirname, '..', 'templates', 'handoff.yaml.template'));
    const e = errors(results);
    assert.ok(e.includes('TASK_ID_PLACEHOLDER'), e.join());
    assert.ok(e.includes('STATUS'), e.join());
    assert.ok(!e.includes('YAML_PARSE') && !e.includes('NO_YAML'), e.join());
});

test('PASSED sem evidência reprova (regra 7)', () => {
    const d = v10(); d.validation.executed[0].evidence = '';
    assert.ok(errors(validate(d)).includes('PASSED_WITHOUT_EVIDENCE'));
});

test('COMPLETED com falha inesperada e sem open_issues reprova', () => {
    const d = v10(); d.validation.executed[0].result = 'FAILED';
    assert.ok(errors(validate(d)).includes('COMPLETED_WITH_FAILURE'));
});

test('falha inesperada documentada em open_issues vira WARN', () => {
    const d = v10(); d.validation.executed[0].result = 'FAILED'; d.open_issues = ['flake conhecido da PRI-93'];
    const r = validate(d);
    assert.deepStrictEqual(errors(r), []);
    assert.ok(codes(r).includes('WARN:COMPLETED_WITH_KNOWN_FAILURE'));
});

test('injeção de falha com expected: FAILED não conta como falha', () => {
    const d = v10();
    d.validation.executed.push({ command: 'teste contra código sabotado (F1)', result: 'FAILED', expected: 'FAILED', evidence: 'f1.tap' });
    assert.deepStrictEqual(codes(validate(d)), []);
    d.validation.executed[1].result = 'PASSED';
    assert.ok(errors(validate(d)).includes('COMPLETED_WITH_FAILURE'), 'sabotagem que passa é falha inesperada');
});

test('FAILED sem evidência também reprova', () => {
    const d = v10(); d.validation.executed[0] = { command: 'x', result: 'FAILED', evidence: '' }; d.open_issues = ['x'];
    assert.ok(errors(validate(d)).includes('RESULT_WITHOUT_EVIDENCE'));
});

test('NEEDS_HUMAN e BLOCKED exigem open_issues', () => {
    for (const s of ['NEEDS_HUMAN', 'BLOCKED']) {
        const d = v10(); d.execution.status = s;
        assert.ok(errors(validate(d)).includes('BLOCKER_UNDESCRIBED'), s);
        d.open_issues = ['decisão sobre X'];
        assert.ok(!errors(validate(d)).includes('BLOCKER_UNDESCRIBED'), s);
    }
});

test('status e versão fora do enum reprovam', () => {
    const d = v10(); d.execution.status = 'DONE'; d.handoff_version = '2.0';
    const e = errors(validate(d));
    assert.ok(e.includes('STATUS') && e.includes('VERSION'), e.join());
});

test('v1.1 exige routing e risk; HIGH/MAX exigem signals', () => {
    const d = v11(); delete d.routing; delete d.risk;
    assert.ok(errors(validate(d)).includes('ROUTING_MISSING'));
    assert.ok(errors(validate(d)).includes('RISK_MISSING'));
    const h = v11(); h.risk.level = 'HIGH';
    assert.ok(errors(validate(h)).includes('RISK_SIGNALS'));
    h.risk.signals = ['migração de schema'];
    assert.deepStrictEqual(errors(validate(h)), []);
});

test('v1.1: runtime inválido e usage inventado reprovam', () => {
    const d = v11(); d.routing.runtime = 'gpt'; d.usage.tokens = 'uns 20 mil';
    const e = errors(validate(d));
    assert.ok(e.includes('ROUTING_RUNTIME') && e.includes('USAGE_VALUE'), e.join());
});

test('v1.0 não é obrigado a ter campos da 1.1', () => {
    const d = v10();
    assert.ok(!errors(validate(d)).some((c) => c.startsWith('ROUTING') || c.startsWith('RISK')));
});

test('.md em prosa sem bloco yaml é NO_YAML (exit 2)', () => {
    const f = path.join(tmp, 'prosa.md');
    fs.writeFileSync(f, '# Handoff\n\nTudo certo, testes passaram.\n');
    const r = validateFile(f);
    assert.strictEqual(r.code, 2);
    assert.ok(errors(r.results).includes('NO_YAML'));
});

test('.md com bloco yaml é extraído e validado', () => {
    const body = fs.readFileSync(path.join(__dirname, '..', 'templates', 'handoff.yaml.template'), 'utf8')
        .replace('"PRI-XXX"', '"PRI-94"');
    const md = `# Handoff\n\nTexto livre.\n\n\`\`\`yaml\n${body}\`\`\`\n`;
    assert.ok(extractYaml(md, 'x.md').includes('PRI-94'));
});

test('credencial no arquivo reprova sem ecoar o valor', () => {
    const f = path.join(tmp, 'segredo.yaml');
    const fake = 'ATATT' + 'x'.repeat(30);
    fs.writeFileSync(f, `handoff_version: "1.0"\ntask:\n  id: "PRI-1"\n  objective: "o"\n  note: "${fake}"\n`);
    const r = validateFile(f);
    assert.ok(errors(r.results).includes('SECRET'));
    assert.ok(!JSON.stringify(r.results).includes(fake));
});

test('--check-paths acusa artefato e evidência inexistentes', () => {
    const d = v10();
    const e = errors(validate(d, { checkPaths: true, baseDir: tmp }));
    assert.ok(e.includes('ARTIFACT_NOT_FOUND') && e.includes('EVIDENCE_NOT_FOUND'), e.join());
    fs.mkdirSync(path.join(tmp, 'scripts'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'scripts', 'a.test.js'), '');
    fs.writeFileSync(path.join(tmp, 'run.log'), 'ok');
    assert.deepStrictEqual(errors(validate(d, { checkPaths: true, baseDir: tmp })), []);
});
