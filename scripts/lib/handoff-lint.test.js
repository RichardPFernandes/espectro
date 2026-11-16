// node --test scripts/lib/handoff-lint.test.js
// PRI-353 T4 (AC4): handoff das fases em esforço alto. O lint só avisa (D7); a instrução
// no extraNote só existe com a flag ligada e só para nó em esforço alto na tabela.
const test = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { lintHandoff, handoffNote, HANDOFF_FIELDS } = require('./handoff-lint');

const TABLE = { plan: 'high', implement: 'high', review: 'high', test: 'medium', verify: 'medium', commit: 'low' };

const FULL = `# Plano — t-1

## Referência da Spec
- Spec: memory/spec/1-spec.md
- ACs: AC-01

## Plano de execução
1. Filtrar pelo resultado.
   - Arquivo: \`app/Service.java\`
   - Critérios: AC-01
   - Verificação: teste unitário.

## Decisões
- Filtrar no service e não na query, porque a tela já recebe a lista paginada.

## Cobertura dos ACs
- AC-01 → passo 1 — filtro.

## Riscos técnicos
- Perfil: G1 — muda leitura; capabilities afetadas: nenhuma
`;

test('plan.md completo: sem aviso', () => {
    const r = lintHandoff(FULL);
    assert.deepStrictEqual(r.missing, []);
    assert.strictEqual(r.ok, true);
    assert.deepStrictEqual(r.warnings, []);
});

test('os quatro campos do handoff são plano, decisões, riscos e arquivos afetados', () => {
    assert.deepStrictEqual(HANDOFF_FIELDS, ['plano', 'decisoes', 'riscos', 'arquivos']);
});

test('avisa cada campo ausente, sem lançar', () => {
    const cases = [
        ['plano', FULL.replace(/## Plano de execução[\s\S]*?## Decisões/, '## Decisões')],
        ['decisoes', FULL.replace(/## Decisões[\s\S]*?## Cobertura/, '## Cobertura')],
        ['riscos', FULL.replace(/## Riscos técnicos[\s\S]*$/, '')],
        ['arquivos', FULL.replace(/   - Arquivo: .*\n/, '')],
    ];
    for (const [field, content] of cases) {
        const r = lintHandoff(content);
        assert.ok(r.missing.includes(field), `${field} deveria faltar: ${JSON.stringify(r.missing)}`);
        assert.strictEqual(r.ok, false);
        assert.ok(r.warnings.some(w => w.includes(field === 'decisoes' ? 'Decisões' : '')), `aviso para ${field}`);
    }
});

test('seção presente mas vazia conta como ausente', () => {
    const r = lintHandoff(FULL.replace(/## Decisões\n- .*\n/, '## Decisões\n\n'));
    assert.deepStrictEqual(r.missing, ['decisoes']);
    const r2 = lintHandoff(FULL.replace(/## Riscos técnicos\n- .*\n/, '## Riscos técnicos\n'));
    assert.deepStrictEqual(r2.missing, ['riscos']);
});

test('arquivos afetados: seção própria também vale', () => {
    const noFileInSteps = FULL.replace(/   - Arquivo: .*\n/, '') + '\n## Arquivos afetados\n- `app/Service.java`\n';
    assert.deepStrictEqual(lintHandoff(noFileInSteps).missing, []);
});

test('conteúdo vazio ou inválido: os quatro campos faltam, nunca zero implícito', () => {
    for (const bad of ['', null, undefined, 42]) {
        const r = lintHandoff(bad);
        assert.deepStrictEqual(r.missing, HANDOFF_FIELDS);
        assert.strictEqual(r.ok, false);
    }
});

test('título com acento diferente ou caixa diferente ainda é reconhecido', () => {
    const r = lintHandoff(FULL.replace('## Decisões', '## DECISOES').replace('## Riscos técnicos', '## riscos tecnicos'));
    assert.deepStrictEqual(r.missing, []);
});

test('handoffNote: flag desligada → string vazia, sem ler tabela', () => {
    assert.strictEqual(handoffNote({ nodes: ['plan'], enabled: false, table: null }), '');
    assert.strictEqual(handoffNote({ nodes: ['plan'], enabled: false, table: TABLE }), '');
});

test('handoffNote: flag ligada e plan em esforço alto → manda gravar ## Decisões no plan.md', () => {
    const note = handoffNote({ nodes: ['plan'], enabled: true, table: TABLE, prismaRoot: '/p' });
    assert.match(note, /## Decisões/);
    assert.match(note, /plan\.md/);
    assert.match(note, /Riscos técnicos/);
    assert.match(note, /node \/p\/scripts\/lib\/handoff-lint\.js/);
    assert.match(note, /só avisa|apenas avisa|não bloqueia/i);
});

test('handoffNote: segmento fetch_ticket+plan também recebe; nó médio ou baixo não', () => {
    assert.match(handoffNote({ nodes: ['fetch_ticket', 'plan'], enabled: true, table: TABLE, prismaRoot: '/p' }), /## Decisões/);
    for (const node of ['test', 'verify', 'commit']) {
        assert.strictEqual(handoffNote({ nodes: [node], enabled: true, table: TABLE, prismaRoot: '/p' }), '', node);
    }
});

test('handoffNote: só plan/implement escrevem plan.md; review fica fora (usa review_results)', () => {
    assert.strictEqual(handoffNote({ nodes: ['review'], enabled: true, table: TABLE, prismaRoot: '/p' }), '');
});

test('handoffNote: flag ligada sem tabela é erro explícito, não nota silenciosa', () => {
    assert.throws(() => handoffNote({ nodes: ['plan'], enabled: true, table: null }), /PHASE_EFFORT_TABLE_REQUIRED/);
});

test('CLI: sempre sai 0 (só aviso) e imprime o que falta', () => {
    const dir = fs.mkdtempSync(path.join(process.env.CLAUDE_JOB_DIR ? path.join(process.env.CLAUDE_JOB_DIR, 'tmp') : os.tmpdir(), 'handoff-lint-'));
    const bad = path.join(dir, 'plan.md');
    fs.writeFileSync(bad, '# Plano\n\n## Plano de execução\n1. Fazer.\n');
    const out = execFileSync(process.execPath, [path.join(__dirname, 'handoff-lint.js'), bad], { encoding: 'utf8' });
    assert.match(out, /Decisões/);
    assert.match(out, /Riscos técnicos/);
    const good = path.join(dir, 'ok.md');
    fs.writeFileSync(good, FULL);
    assert.match(execFileSync(process.execPath, [path.join(__dirname, 'handoff-lint.js'), good], { encoding: 'utf8' }), /completo/i);
});

test('CLI: arquivo inexistente também sai 0 e avisa (nunca bloqueia)', () => {
    const out = execFileSync(process.execPath, [path.join(__dirname, 'handoff-lint.js'), '/nao/existe/plan.md'], { encoding: 'utf8' });
    assert.match(out, /não encontrado|nao encontrado/i);
});
