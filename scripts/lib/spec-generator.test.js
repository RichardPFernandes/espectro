// node --test scripts/lib/spec-generator.test.js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const gen = require('./spec-generator');
const { validateSpec, stripComments } = require('./spec-validator');

const TMP_ROOT = process.env.CLAUDE_JOB_DIR ? path.join(process.env.CLAUDE_JOB_DIR, 'tmp') : os.tmpdir();

const PEDIDOS_ISSUE = {
    id: 90501,
    subject: 'Pedido não recalcula frete ao alterar item',
    category: { id: 7, name: 'Pedidos' },
    fixed_version: { id: 3, name: '2026.10 - Sprint 20' },
    estimated_hours: 8,
    assigned_to: { id: 1, name: 'Richard Fernandes' },
    description: [
        'Ao alterar a quantidade de um item do pedido, o frete não é recalculado e a',
        'tela continua mostrando o valor antigo até o usuário recarregar a página.',
        '',
        '### Solução esperada',
        'Recalcular o frete sempre que um item for alterado.',
        '',
        '### Critérios de aceite',
        '- Alterar quantidade recalcula o frete na hora',
        '- Remover item recalcula o frete na hora',
    ].join('\n'),
};

const clientFor = (issue, calls = []) => ({
    getIssue: async args => { calls.push(args); return { issue }; },
});

// ---------------------------------------------------------------------------------
// Unidade

test('critério de aceite: category=Pedidos + estimated_hours=8 → módulo, microsserviço e granularidade', async () => {
    const calls = [];
    const draft = await gen.generateSpecDraft(90501, clientFor(PEDIDOS_ISSUE, calls));
    assert.deepStrictEqual(calls, [{ issueId: 90501, queryParams: {} }]);
    assert.match(draft.content, /## Módulo Afetado\n[\s\S]*- Categoria \(Redmine\): Pedidos\n- Microsserviços inferidos: `ms-pedidos`/);
    assert.match(draft.content, /## Versão Alvo \/ Restrições de Deploy\n[\s\S]*- Versão alvo: 2026\.10 - Sprint 20/);
    assert.match(draft.content, /- Estimativa \(Redmine\): 8h\n- Sugestão: 8h → 2 a 4 passos no plan/);
    assert.match(draft.content, /## Responsável\n[\s\S]*- Richard Fernandes/);
    assert.deepStrictEqual(draft.meta.microservices, ['ms-pedidos']);
    assert.strictEqual(draft.meta.planSteps, '2-4');
    assert.doesNotMatch(stripComments(draft.content), /\{\{[A-Z_]+\}\}/, 'nenhum placeholder de valor sobra');
});

test('frontmatter: draft: true e generated_from_ticket: true', async () => {
    const { content } = await gen.generateSpecDraft('90501', clientFor(PEDIDOS_ISSUE), { now: new Date('2026-09-29T12:00:00Z') });
    assert.ok(content.startsWith('---\n'));
    const fm = gen.parseFrontmatter(content);
    assert.strictEqual(fm.draft, true);
    assert.strictEqual(fm.generated_from_ticket, true);
    assert.strictEqual(fm.ticket, '90501');
    assert.strictEqual(fm.generated_at, '2026-09-29T12:00:00.000Z');
    assert.ok(gen.isDraftSpec(content));
    assert.ok(!gen.isDraftSpec(content.replace('draft: true', 'draft: false')));
    assert.ok(!gen.isDraftSpec(content.replace('draft: true\n', '')));
    assert.ok(!gen.isDraftSpec('# Spec sem frontmatter\ndraft: true\n'), 'draft fora do frontmatter não conta');
});

test('description: subseções vão para as seções do template; resto vira Problema', async () => {
    const { content } = await gen.generateSpecDraft(90501, clientFor(PEDIDOS_ISSUE));
    assert.match(content, /## Problema\n[\s\S]*Ao alterar a quantidade de um item/);
    assert.match(content, /## Solução\n[\s\S]*Recalcular o frete sempre que/);
    assert.match(content, /## Critérios de Aceite\n[\s\S]*- AC-01: Alterar quantidade recalcula[\s\S]*- AC-02: Remover item recalcula/);
    assert.doesNotMatch(content, /### Solução esperada/, 'cabeçalho original não duplica');
    assert.strictEqual(validateSpec(content).valid, true, 'rascunho completo passa no portão de spec');
});

test('sem Solução/Critérios na descrição: seções ficam vazias (nunca inventadas) e o portão aponta', async () => {
    const issue = { ...PEDIDOS_ISSUE, description: 'Tela de pedidos lenta.' };
    const { content } = await gen.generateSpecDraft(1, clientFor(issue));
    const v = validateSpec(content);
    assert.strictEqual(v.valid, false);
    assert.ok(v.missingSections.includes('solucao'));
    assert.ok(v.missingSections.includes('criterios_aceite'));
});

// Formato do template de ticket novo (#43746): títulos numerados e critérios em Gherkin.
const GHERKIN_ISSUE = {
    id: 90502,
    subject: 'Recálculo de OC em lote',
    description: [
        '# 1. Título da Demanda', '', 'Recálculo em lote', '',
        '# 2. Contexto / Problema', '', 'Hoje é OC por OC.', '',
        '# 4. Regras de Negócio', '', '- **RN01** – Nova opção na tela.', '',
        '# 5. Critérios de Aceite (BDD/Gherkin)', '',
        '```gherkin',
        'Funcionalidade: Recálculo em lote',
        '',
        'Cenário: Pesquisa sem filtro é bloqueada',
        '  Dado que o usuário informou apenas a Transportadora X',
        '  Quando ele clica em pesquisar',
        '  Então o sistema não executa a pesquisa',
        '',
        'Esquema do Cenário: Data inválida',
        '  Dado as datas <de> e <ate>',
        '  Então exibe erro',
        '  Exemplos:',
        '    | de | ate |',
        '    | 30/09 | 01/09 |',
        '```',
        '',
        '# 6. Impactos Técnicos', '', '- Tela de recálculo.',
    ].join('\r\n'),
};

test('description: título numerado ("5. Critérios de Aceite (BDD/Gherkin)") cai na seção certa', async () => {
    const { content } = await gen.generateSpecDraft(90502, clientFor(GHERKIN_ISSUE));
    assert.match(content, /## Problema\n[\s\S]*Hoje é OC por OC\./);
    assert.doesNotMatch(content, /# 2\. Contexto/, 'cabeçalho reconhecido não duplica');
    assert.doesNotMatch(content, /# 5\. Critérios/);
    assert.match(content, /\n### 4\. Regras de Negócio\n[\s\S]*RN01/, 'seção não reconhecida fica no Problema, com título rebaixado');
    assert.match(content, /\n### 1\. Título da Demanda\n/);
});

test('Gherkin: cada Cenário vira um AC com os passos em sub-itens; Solução segue faltando', async () => {
    const { content } = await gen.generateSpecDraft(90502, clientFor(GHERKIN_ISSUE));
    assert.match(content, /- AC-01: Pesquisa sem filtro é bloqueada\n {2}- Dado que o usuário informou apenas a Transportadora X\n {2}- Quando ele clica em pesquisar\n {2}- Então o sistema não executa a pesquisa\n- AC-02: Data inválida\n/);
    assert.match(content, /- Exemplos:\n {4}\| de \| ate \|\n {4}\| 30\/09 \| 01\/09 \|/);
    assert.doesNotMatch(content, /```/, 'cerca do bloco sai');
    assert.match(content, /Funcionalidade: Recálculo em lote\n- AC-01/, 'texto antes do 1º cenário fica, sem virar AC');
    const v = validateSpec(content);
    assert.deepStrictEqual(v.acIds, ['AC-01', 'AC-02']);
    assert.deepStrictEqual(v.missingSections, ['solucao'], 'critérios vêm do ticket; só a Solução fica pra IA');
});

test('gherkinToCriteria: seção já em lista ou sem cenário fica como veio', () => {
    const list = '- Alterar quantidade recalcula\n- Cenário: texto solto';
    assert.strictEqual(gen.gherkinToCriteria(list), list);
    assert.strictEqual(gen.gherkinToCriteria('Texto livre sem cenário.'), 'Texto livre sem cenário.');
    assert.strictEqual(gen.gherkinToCriteria(''), '');
    assert.strictEqual(gen.gherkinToCriteria('Scenario: A\n  Given x\nScenario: B\n  Then y'),
        '- A\n  - Given x\n- B\n  - Then y');
});

test('campos ausentes: "não informado" em vez de placeholder ou "undefined"', async () => {
    const { content, meta } = await gen.generateSpecDraft(2, clientFor({ id: 2, subject: 'X', description: '' }));
    assert.doesNotMatch(stripComments(content), /undefined|null|\{\{[A-Z_]+\}\}/);
    assert.match(content, /Categoria \(Redmine\): _não informado no ticket_/);
    assert.match(content, /Sugestão: sem estimativa no ticket/);
    assert.strictEqual(meta.planSteps, null);
});

test('inferMicroservices: slug sem acento, categoria composta, override e existência em backend/', () => {
    assert.deepStrictEqual(gen.inferMicroservices('Pedidos', { overrides: {} }).map(s => s.name), ['ms-pedidos']);
    assert.deepStrictEqual(gen.inferMicroservices('Expedição / Faturamento', { overrides: {} }).map(s => s.name), ['ms-expedicao', 'ms-faturamento']);
    assert.deepStrictEqual(gen.inferMicroservices('Pátio e Portaria', { overrides: {} }).map(s => s.name), ['ms-patio', 'ms-portaria']);
    assert.deepStrictEqual(gen.inferMicroservices('ms-router', { overrides: {} }).map(s => s.name), ['ms-router']);
    assert.deepStrictEqual(gen.inferMicroservices(null), []);

    const overrides = gen.categoryOverrides({ SPEC_CATEGORY_SERVICE_MAP: '{"Portaria": ["ms-patio", "ms-router"], "Notas Fiscais": "ms-nfe"}' });
    assert.deepStrictEqual(gen.inferMicroservices('Portaria', { overrides }).map(s => s.name), ['ms-patio', 'ms-router']);
    assert.deepStrictEqual(gen.inferMicroservices('Notas fiscais', { overrides }).map(s => s.name), ['ms-nfe']);
    assert.deepStrictEqual(gen.categoryOverrides({ SPEC_CATEGORY_SERVICE_MAP: '{quebrado' }), {}, 'JSON inválido é ignorado');

    const root = fs.mkdtempSync(path.join(TMP_ROOT, 'specgen-root-'));
    fs.mkdirSync(path.join(root, 'backend', 'ms-pedidos'), { recursive: true });
    assert.deepStrictEqual(gen.inferMicroservices('Pedidos / Notas', { overrides: {}, repoRoot: root }),
        [{ name: 'ms-pedidos', exists: true }, { name: 'ms-notas', exists: false }]);
});

test('suggestPlanGranularity: faixas por horas', () => {
    assert.strictEqual(gen.suggestPlanGranularity(null).steps, null);
    assert.strictEqual(gen.suggestPlanGranularity(0).steps, null);
    assert.strictEqual(gen.suggestPlanGranularity('abc').steps, null);
    assert.strictEqual(gen.suggestPlanGranularity(1.5).steps, '1');
    assert.strictEqual(gen.suggestPlanGranularity(8).steps, '2-4');
    assert.strictEqual(gen.suggestPlanGranularity(16).steps, '4-8');
    assert.strictEqual(gen.suggestPlanGranularity(40).steps, 'split');
});

test('unwrapIssue: resposta REST, issue direto e envelope de tool MCP', async () => {
    const mcpEnvelope = { content: [{ type: 'text', text: JSON.stringify({ issue: PEDIDOS_ISSUE }) }] };
    for (const resp of [{ issue: PEDIDOS_ISSUE }, PEDIDOS_ISSUE, mcpEnvelope]) {
        const { meta } = await gen.generateSpecDraft(90501, { getIssue: async () => resp });
        assert.strictEqual(meta.category, 'Pedidos');
    }
    await assert.rejects(gen.generateSpecDraft(1, { getIssue: async () => ({}) }), /não retornado/);
    await assert.rejects(gen.generateSpecDraft(1, {}), /getIssue/);
    await assert.rejects(gen.generateSpecDraft('x', clientFor(PEDIDOS_ISSUE)), /ticketId inválido/);
});

test('target_version aceito como alias de fixed_version', async () => {
    const issue = { ...PEDIDOS_ISSUE, fixed_version: undefined, target_version: { name: 'v9' } };
    assert.strictEqual((await gen.generateSpecDraft(1, clientFor(issue))).meta.targetVersion, 'v9');
});

test('createRestMcpClient: GET no Redmine com a key só no header', async () => {
    const seen = [];
    const client = gen.createRestMcpClient({
        baseUrl: 'http://r.test', apiKey: 'segredo',
        fetchImpl: async (url, opts) => { seen.push({ url, opts }); return { ok: true, json: async () => ({ issue: { id: 5 } }) }; },
    });
    assert.deepStrictEqual(await client.getIssue({ issueId: 5, queryParams: { include: ['journals'] } }), { issue: { id: 5 } });
    assert.strictEqual(seen[0].url, 'http://r.test/issues/5.json?include=journals');
    assert.strictEqual(seen[0].opts.headers['X-Redmine-API-Key'], 'segredo');
    const failing = gen.createRestMcpClient({ baseUrl: 'http://r.test', apiKey: 'segredo', fetchImpl: async () => ({ ok: false, status: 404 }) });
    await assert.rejects(failing.getIssue({ issueId: 5 }), err => /HTTP 404/.test(err.message) && !/segredo/.test(err.message));
});

test('templates/spec-template.md: placeholders pedidos e comentário de mapeamento por seção', () => {
    const tpl = fs.readFileSync(gen.DEFAULT_TEMPLATE_PATH, 'utf8');
    for (const p of ['{{REDMINE_CATEGORY}}', '{{TARGET_VERSION}}', '{{ESTIMATED_HOURS}}', '{{ASSIGNED_TO}}']) assert.ok(tpl.includes(p), p);
    assert.match(tpl, /<!-- Redmine: `category`/);
    assert.match(tpl, /<!-- Redmine: `fixed_version`/);
    assert.match(tpl, /<!-- Redmine: `estimated_hours`/);
    assert.match(tpl, /<!-- Redmine: `description`/);
    assert.match(tpl, /<!-- Redmine: `assigned_to`/);
});

// ---------------------------------------------------------------------------------
// Integração com o watcher

const tmp = fs.mkdtempSync(path.join(TMP_ROOT, 'spec-gen-'));
const repo = path.join(tmp, 'app-back');
const binDir = path.join(tmp, 'bin');
const claudeCalls = path.join(tmp, 'claude-calls.log');
fs.mkdirSync(path.join(repo, 'memory', 'spec'), { recursive: true });
fs.mkdirSync(binDir);
fs.writeFileSync(path.join(binDir, 'claude'), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${claudeCalls}'\n`, { mode: 0o755 });
process.env.REPO_PATH = repo;
process.env.SKIP_PRE_BUILD_VALIDATION = 'true';
process.env.REDMINE_URL = 'http://redmine.test';
process.env.REDMINE_API_KEY = 'chave-spec-gen';
process.env.PATH = `${binDir}:${process.env.PATH}`;
delete process.env.SPEC_DRAFT_AUTOGEN;
delete process.env.SPEC_DRAFT_LINK_BASE;
delete process.env.SPEC_CATEGORY_SERVICE_MAP;

const issues = {};
const redminePuts = [];
let failPuts = false;
global.fetch = async (url, opts = {}) => {
    const id = Number((/issues\/(\d+)\.json/.exec(url) || [])[1]);
    if (opts.method === 'PUT') {
        if (failPuts) return { ok: false, status: 500, json: async () => ({}) };
        redminePuts.push({ url, body: JSON.parse(opts.body) });
        return { ok: true, status: 204, json: async () => ({}) };
    }
    if (!issues[id]) return { ok: false, status: 404, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => ({ issue: { journals: [], ...issues[id] } }) };
};

const watcher = require('../readmine-watcher');

function ticket(issue) {
    issues[issue.id] = issue;
    return {
        ...issue, status: { name: 'Aprovada' }, tracker: { name: 'Melhoria' },
        custom_fields: [{ name: 'Branch Liberação', value: 'Dev - Local' }],
        updated_on: new Date().toISOString(),
    };
}
const specFile = id => path.join(repo, 'memory', 'spec', `${id}-spec.md`);
const putsFor = id => redminePuts.filter(p => p.url.endsWith(`/issues/${id}.json`));
const claudeCallCount = () => (fs.existsSync(claudeCalls) ? fs.readFileSync(claudeCalls, 'utf8').split('\n').filter(Boolean).length : 0);

test('watcher: ticket novo sem spec → grava rascunho draft, comenta no Redmine e NÃO inicia ciclo', async () => {
    const t = ticket({ ...PEDIDOS_ISSUE, id: 90601 });
    const r = await watcher.dispatchTicket(t);
    assert.strictEqual(r.action, 'skip');
    assert.strictEqual(r.reason, 'spec_draft_gerado');
    assert.strictEqual(r.specPath, 'memory/spec/90601-spec.md');
    assert.ok(!fs.existsSync(path.join(repo, '.claude', 'worktrees', '90601')), 'não cria worktree');
    assert.strictEqual(claudeCallCount(), 0, 'nenhum agente despachado');

    const content = fs.readFileSync(specFile(90601), 'utf8');
    assert.ok(gen.isDraftSpec(content));
    assert.ok(gen.isGeneratedSpec(content));
    assert.match(content, /Microsserviços inferidos: `ms-pedidos`/);
    assert.match(content, /8h → 2 a 4 passos/);

    assert.strictEqual(putsFor(90601).length, 1);
    const note = putsFor(90601)[0].body.issue.notes;
    assert.ok(note.startsWith(watcher.SPEC_DRAFT_COMMENT_PREFIX));
    assert.match(note, /Spec rascunho gerado automaticamente — revisar antes de iniciar ciclo/);
    assert.match(note, /memory\/spec\/90601-spec\.md/, 'comentário aponta para a spec gerada');
    assert.match(note, /Pedidos \(ms-pedidos — inferido\)/);
    assert.doesNotMatch(note, /chave-spec-gen/);
    assert.match(note, /\{\{collapse\(Ver spec gerada\)\n<pre>\n# Ticket #90601/, 'comentário traz o texto da spec');
    assert.match(note, /## Problema/);
    assert.doesNotMatch(note, /draft: true\ngenerated_from_ticket/, 'sem frontmatter');
    assert.doesNotMatch(note, /<!--/, 'sem comentários do template');

    // Gate file: é dele que o dashboard monta o run pré-task com o rascunho.
    const gateFile = watcher.readSpecGate(90601);
    assert.strictEqual(gateFile.status, 'spec-draft');
    assert.strictEqual(gateFile.spec_draft.spec_path, 'memory/spec/90601-spec.md');

    // Tick seguinte: continua bloqueado, sem novo comentário nem nova geração.
    const again = await watcher.dispatchTicket(t);
    assert.strictEqual(again.reason, 'spec_draft_aguardando_revisao');
    assert.strictEqual(putsFor(90601).length, 1);
    assert.strictEqual(fs.readFileSync(specFile(90601), 'utf8'), content, 'rascunho não é regravado');
    assert.strictEqual(claudeCallCount(), 0);
});

test('watcher: spec existente nunca é sobrescrita nem ganha comentário de rascunho', async () => {
    const existing = '# Spec escrita à mão\n\n## Problema\nalgo\n';
    fs.writeFileSync(specFile(90602), existing);
    const t = ticket({ ...PEDIDOS_ISSUE, id: 90602 });
    const r = await watcher.runSpecDraftGate(t);
    assert.deepStrictEqual(r, { block: false });
    assert.strictEqual(fs.readFileSync(specFile(90602), 'utf8'), existing);
    assert.strictEqual(putsFor(90602).length, 0);
});

test('watcher: spec pré-existente com draft: true bloqueia o ciclo', async () => {
    fs.writeFileSync(specFile(90603), '---\ndraft: true\n---\n# Spec\n');
    const r = await watcher.dispatchTicket(ticket({ ...PEDIDOS_ISSUE, id: 90603 }));
    assert.strictEqual(r.reason, 'spec_draft_aguardando_revisao');
    assert.strictEqual(claudeCallCount(), 0);
});

test('watcher: comentário que falhou é repostado no tick seguinte, uma vez só', async () => {
    const t = ticket({ ...PEDIDOS_ISSUE, id: 90604 });
    failPuts = true;
    try {
        assert.strictEqual((await watcher.dispatchTicket(t)).reason, 'spec_draft_gerado');
    } finally {
        failPuts = false;
    }
    assert.strictEqual(putsFor(90604).length, 0);
    assert.ok(fs.existsSync(specFile(90604)), 'rascunho gravado mesmo sem comentário');
    await watcher.dispatchTicket(t);
    await watcher.dispatchTicket(t);
    assert.strictEqual(putsFor(90604).length, 1);
    assert.match(putsFor(90604)[0].body.issue.notes, /memory\/spec\/90604-spec\.md/);
});

test('watcher: Redmine fora do ar na geração → não grava nada e segue bloqueado', async () => {
    const t = ticket({ ...PEDIDOS_ISSUE, id: 90605 });
    delete issues[90605]; // GET devolve 404
    const r = await watcher.dispatchTicket(t);
    assert.strictEqual(r.reason, 'spec_draft_falhou');
    assert.ok(!fs.existsSync(specFile(90605)));
    assert.strictEqual(putsFor(90605).length, 0);
    assert.strictEqual(claudeCallCount(), 0);
});

test('watcher: rascunho liberado (draft: false) → gate passa e o portão valida a spec revisada, não a descrição', async () => {
    const t = ticket({ ...PEDIDOS_ISSUE, id: 90606, description: 'curta' });
    assert.strictEqual((await watcher.runSpecDraftGate(t)).reason, 'spec_draft_gerado');
    // Humano revisa: completa a spec e libera.
    const reviewed = fs.readFileSync(specFile(90606), 'utf8')
        .replace('draft: true', 'draft: false')
        .replace('## Solução\n', '## Solução\nRecalcular o frete sempre que um item do pedido for alterado ou removido.\n')
        .replace('## Critérios de Aceite\n', '## Critérios de Aceite\n- Alterar quantidade recalcula\n- Remover item recalcula\n');
    fs.writeFileSync(specFile(90606), reviewed);

    assert.deepStrictEqual(await watcher.runSpecDraftGate(t), { block: false });
    const gate = await watcher.runTicketSpecGate(t);
    assert.strictEqual(gate.proceed, true, 'descrição "curta" reprovaria; a spec revisada passa');
    assert.match(gate.sourceLabel, /memory\/spec\/90606-spec\.md \(gerada do ticket #90606 e revisada\)/);
    assert.strictEqual(watcher.readSpecGate(90606).source, 'generated_spec');
});

test('watcher: comentário cita o caminho da spec e os campos do ticket usados', () => {
    // SPEC_DRAFT_LINK_BASE é lido no load do módulo; aqui fica sem (padrão), então o
    // comentário traz só o caminho no repo.
    const note = watcher.specDraftComment(1, { category: 'Pedidos', microservices: ['ms-pedidos'], targetVersion: 'v1', estimatedHours: 8 });
    assert.match(note, /Spec: @memory\/spec\/1-spec\.md@/);
    assert.match(note, /Versão prevista → Versão Alvo: v1/);
    assert.match(note, /Tempo estimado → granularidade do plan: 8h/);
    assert.match(note, /draft: false/);
    assert.doesNotMatch(note, /collapse/, 'sem conteúdo, sem bloco da spec');
});

test('watcher: comentário escapa HTML da spec e tira frontmatter/comentários', () => {
    const note = watcher.specDraftComment(1, {}, '---\ndraft: true\n---\n<!-- dica -->\n# T\n\n## Problema\nvalor <b> & cia\n');
    assert.match(note, /<pre>\n# T\n\n## Problema\nvalor &lt;b&gt; &amp; cia\n<\/pre>/);
    assert.doesNotMatch(note, /dica|draft: true\n---/);
});

// Ticket sem subseções Solução/Critérios: a IA (spec-repairer) sugere dentro do rascunho.
const VAGO_ISSUE = {
    id: 90701, subject: 'Frete da DT zerado ao salvar a Ordem de Carga',
    fixed_version: { id: 3, name: '3.50' }, estimated_hours: 4, assigned_to: { id: 1, name: 'Richard Fernandes' },
    description: 'Ao salvar a Ordem de Carga o valor de frete da DT filha é zerado, porque a ordem pai propaga o valor zerado em cascata para as DTs vinculadas.',
};
function fakeClaude(name, output) {
    const bin = path.join(binDir, name);
    fs.writeFileSync(bin, `#!/bin/sh\ncat > /dev/null\ncat <<'OUT'\n${output}\nOUT\n`, { mode: 0o755 });
    return bin;
}
async function withRepairBin(bin, fn) {
    const saved = process.env.SPEC_REPAIR_CLAUDE_BIN;
    process.env.SPEC_REPAIR_CLAUDE_BIN = bin;
    try { return await fn(); } finally {
        if (saved === undefined) delete process.env.SPEC_REPAIR_CLAUDE_BIN; else process.env.SPEC_REPAIR_CLAUDE_BIN = saved;
    }
}

test('watcher: rascunho sem Solução/Critérios ganha sugestão da IA, marcada e ainda draft', async () => {
    const bin = fakeClaude('claude-sugere', '## Solução\n\nPreservar o frete já gravado na DT ao salvar a ordem.\n\n## Critérios de Aceite\n\n- Salvar a ordem não zera o frete da DT\n- Recalcular a ordem mantém o frete da DT');
    const t = ticket(VAGO_ISSUE);
    const r = await withRepairBin(bin, () => watcher.dispatchTicket(t));
    assert.strictEqual(r.reason, 'spec_draft_gerado');

    const content = fs.readFileSync(specFile(90701), 'utf8');
    assert.ok(gen.isDraftSpec(content), 'segue draft: true — humano revisa');
    assert.strictEqual(gen.parseFrontmatter(content).ai_sections, 'criterios_aceite, solucao');
    assert.match(content, /## Solução\n[\s\S]*Preservar o frete já gravado/);
    assert.match(content, /- Salvar a ordem não zera o frete da DT/);
    assert.ok(validateSpec(content).valid, 'rascunho já passa no portão depois de liberado');

    const note = putsFor(90701)[0].body.issue.notes;
    assert.match(note, /Sugerido por IA \(não veio do ticket\), revise com atenção:\* Critérios de Aceite, Solução/);
    assert.match(note, /Preservar o frete já gravado/);
    assert.deepStrictEqual(watcher.readSpecGate(90701).spec_draft.ai_sections, ['criterios_aceite', 'solucao']);
});

test('watcher: IA sem resposta útil não põe placeholder no rascunho', async () => {
    const base = gen.buildSpecDraft({ ...VAGO_ISSUE, id: 90702 }, { template: fs.readFileSync(gen.DEFAULT_TEMPLATE_PATH, 'utf8') }).content;
    for (const [name, out] of [['claude-vazio', ''], ['claude-vago', `## Solução\n\n${require('./spec-repairer').PLACEHOLDER}\n\n## Critérios de Aceite\n\n- ${require('./spec-repairer').PLACEHOLDER}`]]) {
        const r = await withRepairBin(fakeClaude(name, out), () => watcher.fillSpecDraftGaps({ ...VAGO_ISSUE, id: 90702 }, base));
        assert.strictEqual(r.content, base, name);
        assert.deepStrictEqual(r.aiSections, [], name);
    }
});

test('watcher: Solução preenchida com um item "A definir" entra no rascunho (não é descartada inteira)', async () => {
    const P = require('./spec-repairer').PLACEHOLDER;
    const base = gen.buildSpecDraft({ ...VAGO_ISSUE, id: 90704 }, { template: fs.readFileSync(gen.DEFAULT_TEMPLATE_PATH, 'utf8') }).content;
    const out = `## Solução\n\nPreservar o frete já gravado na DT ao salvar a ordem.\n- Permissão: ${P}\n\n## Critérios de Aceite\n\n- ${P}`;
    const r = await withRepairBin(fakeClaude('claude-parcial', out), () => watcher.fillSpecDraftGaps({ ...VAGO_ISSUE, id: 90704 }, base));
    assert.deepStrictEqual(r.aiSections, ['solucao'], 'critérios só-placeholder ficam de fora');
    assert.match(r.content, /## Solução\n[\s\S]*Preservar o frete já gravado[\s\S]*- Permissão: A definir/);
});

test('watcher: "aprovado" no Redmine depois do comentário do rascunho libera a spec (draft: false)', async () => {
    const t = ticket({ ...VAGO_ISSUE, id: 90703 });
    await withRepairBin(fakeClaude('claude-vazio-2', ''), () => watcher.dispatchTicket(t));
    assert.ok(gen.isDraftSpec(fs.readFileSync(specFile(90703), 'utf8')));
    const draftNote = putsFor(90703)[0].body.issue.notes;
    assert.match(draftNote, /responda \*aprovado\* neste ticket/);

    // "aprovado" ANTES do comentário do rascunho não vale.
    issues[90703].journals = [
        { id: 1, notes: 'aprovado', user: { name: 'Fulano' }, created_on: '2026-09-30T10:00:00Z' },
        { id: 2, notes: draftNote, user: { name: 'Watcher' }, created_on: '2026-09-30T11:00:00Z' },
    ];
    assert.strictEqual((await watcher.runSpecDraftGate(t)).block, true);

    issues[90703].journals.push({ id: 3, notes: 'Aprovado, pode seguir', user: { name: 'Richard Fernandes' }, created_on: '2026-09-30T12:00:00Z' });
    assert.deepStrictEqual(await watcher.runSpecDraftGate(t), { block: false });
    const released = fs.readFileSync(specFile(90703), 'utf8');
    assert.ok(!gen.isDraftSpec(released));
    assert.strictEqual(gen.parseFrontmatter(released).approved_by, 'Richard Fernandes (Redmine, 2026-09-30T12:00:00Z)');
    assert.strictEqual(watcher.readSpecGate(90703).spec_draft_approved.by, 'Richard Fernandes (Redmine, 2026-09-30T12:00:00Z)');
});
