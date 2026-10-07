// node --test scripts/lib/spec-template.test.js
// Template canônico de spec (templates/spec.md.template): regras do validador para spec
// versionada, compatibilidade com spec legada, cópia do template pelo /fetch-ticket
// (scripts/lib/spec-template.js init) e registro de spec_template_version no state.json.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const specTemplate = require('./spec-template');
const { validateSpec } = require('./spec-validator');

const TEMPLATE = fs.readFileSync(specTemplate.TEMPLATE_PATH, 'utf8');
const VALIDATOR_CLI = path.join(__dirname, 'spec-validator.js');
const TEMPLATE_CLI = path.join(__dirname, 'spec-template.js');
const tmpRoot = fs.mkdtempSync(path.join(process.env.CLAUDE_JOB_DIR ? path.join(process.env.CLAUDE_JOB_DIR, 'tmp') : os.tmpdir(), 'spec-template-'));

const FILLED_SPEC = `---
spec_template_version: 1
ticket: 43999
---
# Ticket #43999 — Reenvio de NF pela API

## Contexto
A transportadora não consegue reenviar a NF rejeitada pela SEFAZ: hoje abre chamado e o
suporte reenvia manualmente (~30 chamados/mês).

## Objetivo
A transportadora reenvia a NF rejeitada pela API, sem abrir chamado.

## Escopo
**Inclui:**
- Reenvio de NF rejeitada pela API pública.

**Não inclui:**
- Reenvio de NF cancelada.

## Critérios de Aceite
- AC-01: Ao chamar o reenvio de uma NF rejeitada, o status muda para "Em processamento" em até 5s.
- AC-02: Ao chamar o reenvio de uma NF autorizada, a API responde 422 com a mensagem "NF já autorizada".

## Restrições
- Não alterar o contrato do endpoint de consulta de NF.
`;

const LEGACY_SPEC = `## Problema
${'Texto descritivo suficiente para passar do limite mínimo de caracteres exigido pela validação. '.repeat(3)}

## Solução
Adicionar busca por descrição igual à Zona de Transporte.

## Critérios de Aceite
- AC-01: Busca por descrição retorna rotas com match parcial.
- AC-02: Filtros por oid continuam funcionando.

## Restrições
- Nenhuma.

## Arquivos Afetados
- Montagem de Carga

## Dependências
- Nenhuma
`;

// Seção do template (cabeçalho + comentário) exatamente como sai da cópia.
function templateSection(heading) {
    const m = new RegExp(`## ${heading}\\n(<!--[\\s\\S]*?-->)`).exec(TEMPLATE);
    assert.ok(m, `template sem a seção ${heading}`);
    return m[1];
}

const codes = r => r.errors.map(e => e.code);

function tmpDir(name) {
    const d = path.join(tmpRoot, name);
    fs.mkdirSync(d, { recursive: true });
    return d;
}

test('template: 7 seções na ordem, 4 obrigatórias + 3 opcionais, instruções inline e versão no frontmatter', () => {
    const headings = TEMPLATE.split('\n').filter(l => /^## /.test(l)).map(l => l.slice(3));
    assert.deepStrictEqual(headings, [
        'Contexto', 'Objetivo', 'Escopo', 'Critérios de Aceite', 'Dependências Técnicas', 'Restrições', 'Referências',
    ]);
    for (const h of headings) templateSection(h);
    assert.strictEqual(specTemplate.templateVersionOf(TEMPLATE), 1);
    assert.strictEqual(specTemplate.SPEC_TEMPLATE_VERSION, 1);
});

// 1
test('spec do template com todas as seções obrigatórias preenchidas → PASS', () => {
    const r = validateSpec(FILLED_SPEC, { acIds: 'require' });
    assert.deepStrictEqual(r.errors, []);
    assert.strictEqual(r.valid, true);
    assert.strictEqual(r.templateVersion, 1);
    assert.deepStrictEqual(r.acIds, ['AC-01', 'AC-02']);
    assert.deepStrictEqual(r.warnings, []);
});

// 2
test('## Critérios de Aceite só com o comentário do template → FAIL SECTION_NOT_FILLED', () => {
    const spec = FILLED_SPEC.replace(/## Critérios de Aceite\n[\s\S]*?\n\n## Restrições/,
        `## Critérios de Aceite\n${templateSection('Critérios de Aceite')}\n\n## Restrições`);
    const r = validateSpec(spec);
    assert.strictEqual(r.valid, false);
    const err = r.errors.find(e => e.code === 'SECTION_NOT_FILLED');
    assert.ok(err, JSON.stringify(r.errors));
    assert.strictEqual(err.section, '## Critérios de Aceite');
    assert.ok(codes(r).includes('TEMPLATE_COMMENTS_PRESENT'));
});

// 3
test('spec sem ## Objetivo → FAIL MISSING_REQUIRED_SECTION', () => {
    const spec = FILLED_SPEC.replace(/## Objetivo\n.*\n\n/, '');
    const r = validateSpec(spec);
    assert.strictEqual(r.valid, false);
    const err = r.errors.find(e => e.code === 'MISSING_REQUIRED_SECTION');
    assert.ok(err && err.section === '## Objetivo', JSON.stringify(r.errors));
});

test('cabeçalho fora do exato (### Objetivo, sem acento) → MISSING_REQUIRED_SECTION apontando o que achou', () => {
    let r = validateSpec(FILLED_SPEC.replace('## Objetivo', '### Objetivo'));
    assert.match(r.errors.find(e => e.section === '## Objetivo').message, /achei "### Objetivo"/);
    r = validateSpec(FILLED_SPEC.replace('## Critérios de Aceite', '## Criterios de aceite'));
    assert.ok(r.errors.some(e => e.code === 'MISSING_REQUIRED_SECTION' && e.section === '## Critérios de Aceite'));
});

// 4
test('spec sem nenhum AC no formato AC-NN: → FAIL NO_ACCEPTANCE_CRITERIA', () => {
    const spec = FILLED_SPEC.replace(/^- AC-0\d: /gm, '- ');
    const r = validateSpec(spec, { acIds: 'require' });
    assert.strictEqual(r.valid, false);
    assert.deepStrictEqual(codes(r), ['NO_ACCEPTANCE_CRITERIA']);
});

test('um AC basta (template não exige mínimo de 2); ID fora de sequência continua sendo erro', () => {
    const one = FILLED_SPEC.replace(/^- AC-02: .*\n/m, '');
    assert.strictEqual(validateSpec(one).valid, true);
    const gap = FILLED_SPEC.replace('- AC-02:', '- AC-03:');
    assert.ok(codes(validateSpec(gap)).some(c => c.startsWith('AC_')));
});

test('comentário de instrução do template esquecido numa seção preenchida → FAIL TEMPLATE_COMMENTS_PRESENT', () => {
    const spec = FILLED_SPEC.replace('## Objetivo\n', `## Objetivo\n${templateSection('Objetivo')}\n`);
    const r = validateSpec(spec);
    assert.deepStrictEqual(codes(r), ['TEMPLATE_COMMENTS_PRESENT']);
    assert.match(r.errors[0].message, /## Objetivo/);
    // Comentário do próprio autor (ou marcador do watcher) não é instrução do template.
    assert.strictEqual(validateSpec(FILLED_SPEC.replace('## Objetivo\n', '## Objetivo\n<!-- nota minha -->\n')).valid, true);
});

test('[PENDING_CLARIFICATION] num AC: validador aceita (aviso) e lista o AC como pendente', () => {
    const spec = FILLED_SPEC.replace('- AC-02: ', '- AC-02: [PENDING_CLARIFICATION] ');
    const r = validateSpec(spec, { acIds: 'require' });
    assert.strictEqual(r.valid, true);
    assert.deepStrictEqual(r.pendingClarification, ['AC-02']);
    assert.deepStrictEqual(r.warnings.map(w => w.code), ['PENDING_CLARIFICATION']);
    assert.deepStrictEqual(r.acIds, ['AC-01', 'AC-02']);
});

test('spec_template_version desconhecida → FAIL UNSUPPORTED_TEMPLATE_VERSION', () => {
    assert.deepStrictEqual(codes(validateSpec(FILLED_SPEC.replace('spec_template_version: 1', 'spec_template_version: 9'))), ['UNSUPPORTED_TEMPLATE_VERSION']);
    assert.deepStrictEqual(codes(validateSpec(FILLED_SPEC.replace('spec_template_version: 1', 'spec_template_version: um'))), ['UNSUPPORTED_TEMPLATE_VERSION']);
});

// 5
test('spec legada (sem spec_template_version) → WARNING, não FAIL', () => {
    const r = validateSpec(LEGACY_SPEC, { acIds: 'require', templateVersion: 'warn' });
    assert.strictEqual(r.valid, true);
    assert.strictEqual(r.templateVersion, null);
    assert.deepStrictEqual(r.warnings.map(w => w.code), ['SPEC_TEMPLATE_VERSION_MISSING']);
    // Padrão da função ('ignore'): descrição crua do Redmine nunca tem frontmatter.
    assert.deepStrictEqual(validateSpec(LEGACY_SPEC).warnings, []);

    const file = path.join(tmpDir('legacy'), 'spec.md');
    fs.writeFileSync(file, LEGACY_SPEC);
    const cli = spawnSync(process.execPath, [VALIDATOR_CLI, file], { encoding: 'utf8' });
    assert.strictEqual(cli.status, 0, cli.stdout + cli.stderr);
    assert.match(cli.stdout, /\[aviso\] Spec sem spec_template_version/);
});

// 6
test('fetch-ticket: spec criada do template com campos do Redmine e comentários HTML para o dev remover', () => {
    const description = '## Situação\nHoje o reenvio é manual ($& e $1 literais).\n\nh2. Detalhe textile';
    const spec = specTemplate.renderSpecFromTemplate({ ticketId: 43999, title: 'Reenvio de NF pela API', description });

    assert.match(spec, /^---\nspec_template_version: 1\nticket: 43999\n---/);
    assert.match(spec, /^# Ticket #43999 — Reenvio de NF pela API$/m);
    assert.ok(!/\{\{[A-Z_]+\}\}/.test(spec), 'nenhum placeholder sobrando');
    // Descrição no Contexto, com cabeçalhos rebaixados (não viram seção nova).
    assert.match(spec, /## Contexto\n<!--[\s\S]*?-->\n### Situação\nHoje o reenvio é manual \(\$& e \$1 literais\)\.\n\nh3\. Detalhe textile/);
    // Comentários do template todos presentes; ACs não preenchidos.
    for (const c of specTemplate.templateComments(TEMPLATE)) {
        assert.ok(specTemplate.templateComments(spec).has(c), `comentário sumiu: ${c.slice(0, 40)}`);
    }
    assert.ok(!/^- AC-\d+:/m.test(spec));

    const r = validateSpec(spec, { acIds: 'require' });
    assert.strictEqual(r.valid, false);
    assert.deepStrictEqual(r.errors.filter(e => e.code === 'SECTION_NOT_FILLED').map(e => e.section),
        ['## Objetivo', '## Escopo', '## Critérios de Aceite']);
    assert.ok(codes(r).includes('TEMPLATE_COMMENTS_PRESENT'));
});

test('fetch-ticket: descrição vazia no ticket deixa ## Contexto não preenchido', () => {
    const spec = specTemplate.renderSpecFromTemplate({ ticketId: 1, title: 'x', description: '' });
    assert.ok(validateSpec(spec).errors.some(e => e.code === 'SECTION_NOT_FILLED' && e.section === '## Contexto'));
});

test('fetch-ticket CLI: init grava a spec do template e nunca sobrescreve', () => {
    const dir = tmpDir('init');
    const out = path.join(dir, 'memory', 'spec', '43999-spec.md');
    const run = () => spawnSync(process.execPath, [TEMPLATE_CLI, 'init', '43999', '--title', "NF d'água", '--out', out],
        { input: 'Descrição do ticket.', encoding: 'utf8' });
    const first = run();
    assert.strictEqual(first.status, 0, first.stderr);
    const content = fs.readFileSync(out, 'utf8');
    assert.match(content, /^# Ticket #43999 — NF d'água$/m);
    assert.match(content, /## Contexto\n<!--[\s\S]*?-->\nDescrição do ticket\.\n/);

    fs.writeFileSync(out, 'spec revisada por humano');
    const second = run();
    assert.strictEqual(second.status, 1);
    assert.strictEqual(fs.readFileSync(out, 'utf8'), 'spec revisada por humano');
});

// 7
test('fetch-ticket: spec_template_version registrada no state.json (validador --state e record-version)', () => {
    const dir = tmpDir('state');
    const spec = path.join(dir, '43999-spec.md');
    const state = path.join(dir, 'state.json');
    fs.writeFileSync(spec, specTemplate.renderSpecFromTemplate({ ticketId: 43999, title: 'T', description: 'D' }));
    fs.writeFileSync(state, JSON.stringify({ task_id: '43999-t', node: 'plan', status: 'in_progress', ac_ids: [] }));

    // Spec recém-copiada é inválida (exit 1) — mas a versão é registrada mesmo assim.
    const cli = spawnSync(process.execPath, [VALIDATOR_CLI, '--state', state, spec], { encoding: 'utf8' });
    assert.strictEqual(cli.status, 1, cli.stdout + cli.stderr);
    const saved = JSON.parse(fs.readFileSync(state, 'utf8'));
    assert.strictEqual(saved.spec_template_version, 1);
    assert.strictEqual(saved.node, 'plan', 'resto do state preservado');

    // Spec legada não grava nada.
    const legacyState = path.join(dir, 'legacy-state.json');
    const legacySpec = path.join(dir, 'legacy-spec.md');
    fs.writeFileSync(legacyState, JSON.stringify({ task_id: 'x' }));
    fs.writeFileSync(legacySpec, LEGACY_SPEC);
    const rec = spawnSync(process.execPath, [TEMPLATE_CLI, 'record-version', legacySpec, legacyState], { encoding: 'utf8' });
    assert.strictEqual(rec.status, 0, rec.stderr);
    assert.ok(!('spec_template_version' in JSON.parse(fs.readFileSync(legacyState, 'utf8'))));

    // E o state com o campo continua válido no schema.
    const { validateState } = require('../validate-state');
    const base = { ...saved, task_id: '43999-t', history: ['fetch_ticket'], started_at: new Date().toISOString() };
    assert.deepStrictEqual(validateState(base), { valid: true });
    assert.strictEqual(validateState({ ...base, spec_template_version: 0 }).valid, false, 'schema tipa o campo');
});

test.after(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));
