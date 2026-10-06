// node --test scripts/lib/spec-validator.test.js
// Unidade do validador + integração com o watcher (dispatchTicket) usando um
// REPO_PATH sintético, fetch stubado (nenhum Redmine real) e um binário `claude`
// falso no PATH (nenhum agente real).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
    validateSpec, upsertContextWarnings, formatRedmineComment, CONTEXT_BEGIN, CONTEXT_END,
} = require('./spec-validator');

const FILLER = 'Texto descritivo suficiente para passar do limite mínimo de caracteres exigido pela validação. ';

const FULL_SPEC = `## Problema
${FILLER}Hoje o filtro de rota não busca por descrição.

## Solução
${FILLER}Adicionar busca por descrição igual à Zona de Transporte.

## Critérios de Aceite
- AC-01: Busca por descrição retorna rotas com match parcial.
- AC-02: Filtros por oid continuam funcionando.

## Restrições
- Não alterar o contrato do endpoint de Zona.

## Arquivos Afetados
- Montagem de Carga > filtros

## Dependências
- Nenhuma
`;

const NO_CRITERIA_SPEC = `## Problema
${FILLER}

## Solução
${FILLER}
`;

const NO_RESTRICTIONS_SPEC = `### Contexto
${FILLER}

### Solução esperada
${FILLER}

### Critérios de Aceite (QA)
- AC-01: Primeiro critério verificável.
- AC-02: Segundo critério verificável.
`;

// ---------------------------------------------------------------------------------
// Unidade

test('spec completa é válida, sem erros nem avisos', () => {
    const r = validateSpec(FULL_SPEC);
    assert.deepStrictEqual(r, { valid: true, errors: [], warnings: [], missingSections: [], acIds: ['AC-01', 'AC-02'], pendingClarification: [], templateVersion: null });
});

test('sem Critérios de Aceite é inválida com erro MISSING_SECTION', () => {
    const r = validateSpec(NO_CRITERIA_SPEC);
    assert.strictEqual(r.valid, false);
    const err = r.errors.find(e => e.code === 'MISSING_SECTION');
    assert.ok(err && err.section.includes('Critérios de Aceite'));
    assert.ok(!r.errors.some(e => e.code === 'INSUFFICIENT_ACCEPTANCE_CRITERIA'));
});

test('Critérios de Aceite com só 1 item é inválida', () => {
    const r = validateSpec(FULL_SPEC.replace('- AC-02: Filtros por oid continuam funcionando.\n', ''));
    assert.strictEqual(r.valid, false);
    assert.deepStrictEqual(r.errors.map(e => e.code), ['INSUFFICIENT_ACCEPTANCE_CRITERIA']);
});

test('aceita itens com "*" e rejeita linha horizontal "---" como item', () => {
    const star = FULL_SPEC.replace(/^- (AC-0[12])/gm, '* $1');
    assert.strictEqual(validateSpec(star).valid, true);
    const hr = FULL_SPEC.replace('- AC-02: Filtros por oid continuam funcionando.', '---');
    assert.strictEqual(validateSpec(hr).valid, false);
});

test('aceita lista numerada (1. / 1)) como itens de Critérios de Aceite', () => {
    const numbered = FULL_SPEC.replace('- AC-01: Busca', '1. AC-01: Busca').replace('- AC-02: Filtros', '2) AC-02: Filtros');
    assert.strictEqual(validateSpec(numbered).valid, true);
});

test('sem Problema nem Contexto, ou sem Solução, é inválida', () => {
    const noProblem = validateSpec(FULL_SPEC.replace('## Problema', '## Descrição'));
    assert.ok(noProblem.errors.some(e => e.code === 'MISSING_SECTION' && e.section.includes('Problema')));
    const noSolution = validateSpec(FULL_SPEC.replace('## Solução', '## Ideia'));
    assert.ok(noSolution.errors.some(e => e.code === 'MISSING_SECTION' && e.section.includes('Solução')));
});

test('seção obrigatória vazia é erro EMPTY_SECTION', () => {
    const r = validateSpec(FULL_SPEC.replace(/## Solução\n.*\n/, '## Solução\n\n'));
    assert.ok(r.errors.some(e => e.code === 'EMPTY_SECTION' && e.section.includes('Solução')));
});

test('spec com 200 caracteres ou menos (sem cabeçalhos) é inválida', () => {
    const short = '## Problema\nCurto.\n## Solução\nCurta.\n## Critérios de Aceite\n- a\n- b\n';
    const r = validateSpec(short);
    assert.deepStrictEqual(r.errors.map(e => e.code), ['TOO_SHORT']);
    // Cabeçalhos longos não contam pro tamanho.
    const longHeadings = short.replace('## Problema', '## Problema ' + 'x'.repeat(300));
    assert.ok(validateSpec(longHeadings).errors.some(e => e.code === 'TOO_SHORT'));
});

test('cabeçalhos tolerantes: ###, caixa, acento, singular, sufixo, Textile, CRLF', () => {
    assert.strictEqual(validateSpec(NO_RESTRICTIONS_SPEC).valid, true);
    const variants = FULL_SPEC
        .replace('## Problema', '## PROBLEMA')
        .replace('## Solução', '## Solucao proposta')
        .replace('## Critérios de Aceite', '## Critério de aceite')
        .replace(/\n/g, '\r\n');
    assert.strictEqual(validateSpec(variants).valid, true);
    const textile = FULL_SPEC.replace(/^## /gm, 'h2. ');
    assert.strictEqual(validateSpec(textile).valid, true);
});

test('template sem preencher (só comentários) não passa', () => {
    const tpl = fs.readFileSync(path.join(__dirname, '..', '..', '.claude', 'worktrees', 'spec-gate', 'templates', 'spec-template.md'), 'utf8');
    const r = validateSpec(tpl);
    assert.strictEqual(r.valid, false);
    assert.deepStrictEqual(r.errors.map(e => e.code).sort(), ['EMPTY_SECTION', 'EMPTY_SECTION', 'INSUFFICIENT_ACCEPTANCE_CRITERIA', 'TOO_SHORT']);
    assert.deepStrictEqual(r.warnings, []);
}, { skip: !fs.existsSync(path.join(__dirname, '..', '..', '.claude', 'worktrees', 'spec-gate', 'templates', 'spec-template.md')) && 'template fora deste checkout' });

test('sem Restrições/Arquivos/Dependências: válida com 3 warnings', () => {
    const r = validateSpec(NO_RESTRICTIONS_SPEC);
    assert.strictEqual(r.valid, true);
    assert.deepStrictEqual(r.warnings.map(w => w.section), ['## Restrições', '## Arquivos Afetados', '## Dependências']);
});

test('upsertContextWarnings insere, é idempotente, atualiza e remove', () => {
    const r = validateSpec(NO_RESTRICTIONS_SPEC);
    const once = upsertContextWarnings('# Diagnóstico\n\ntexto\n', r, { sourceLabel: 'x' });
    assert.ok(once.startsWith('# Diagnóstico\n\ntexto\n\n' + CONTEXT_BEGIN));
    assert.strictEqual(upsertContextWarnings(once, r, { sourceLabel: 'x' }), once);
    const fewer = { ...r, warnings: r.warnings.slice(0, 1) };
    const updated = upsertContextWarnings(once, fewer, { sourceLabel: 'x' });
    assert.ok(!updated.includes('Dependências') && updated.includes('Restrições'));
    assert.strictEqual((updated.match(new RegExp(CONTEXT_END, 'g')) || []).length, 1);
    const removed = upsertContextWarnings(once, { valid: true, errors: [], warnings: [] }, { sourceLabel: 'x' });
    assert.ok(!removed.includes(CONTEXT_BEGIN) && removed.includes('texto'));
    assert.strictEqual(upsertContextWarnings('', { warnings: [] }, { sourceLabel: 'x' }), '');
});

test('comentário do Redmine lista problema, dica e link do template', () => {
    const r = validateSpec(NO_CRITERIA_SPEC);
    const msg = formatRedmineComment(r, { ticketId: 1, sourceLabel: 'descrição', fixInstruction: 'Edite.', templateUrl: 'https://t/spec-template.md' });
    assert.match(msg, /Seção obrigatória ausente: ## Critérios de Aceite\./);
    assert.match(msg, /no mínimo 2 critérios/);
    assert.match(msg, /https:\/\/t\/spec-template\.md/);
    assert.match(msg, /\*\*Recomendações:\*\*/);
    assert.match(msg, /responda este ticket com um comentário começando por "aceito"/);
    assert.match(msg, /^\[Watcher\] Spec do ticket #1/);
});

test('isAcceptanceNote: aceita "aceito"/"ok" no início, recusa "não aceito" e menção no meio', () => {
    const { isAcceptanceNote } = require('./spec-validator');
    for (const t of ['aceito', 'Aceito, pode seguir', '  OK', 'de acordo', 'Pode seguir assim']) assert.ok(isAcceptanceNote(t), t);
    for (const t of ['não aceito', 'Não, falta o critério — depois eu aceito', '', 'okay?']) assert.ok(!isAcceptanceNote(t), t);
});

// ---------------------------------------------------------------------------------
// Integração com o watcher

const tmp = fs.mkdtempSync(path.join(process.env.CLAUDE_JOB_DIR ? path.join(process.env.CLAUDE_JOB_DIR, 'tmp') : os.tmpdir(), 'spec-gate-'));
const repo = path.join(tmp, 'app-back');
const binDir = path.join(tmp, 'bin');
const claudeCalls = path.join(tmp, 'claude-calls.log');
fs.mkdirSync(repo, { recursive: true });
fs.mkdirSync(binDir);
fs.writeFileSync(path.join(binDir, 'claude'), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${claudeCalls}'\n`, { mode: 0o755 });
process.env.REPO_PATH = repo;
// Portão de build pré-implement roda mvn de verdade — coberto em build-validator.test.js.
process.env.SKIP_PRE_BUILD_VALIDATION = 'true';
process.env.REDMINE_URL = 'http://redmine.test';
process.env.REDMINE_API_KEY = 'k';
// Rascunho gerado dos campos do ticket (spec-generator) tem teste próprio em
// spec-generator.test.js — aqui o alvo é o portão da descrição.
process.env.SPEC_DRAFT_AUTOGEN = '0';
// Estes testes cobrem o pedido de aceite puro; o auto-repair tem os seus em spec-repairer.test.js.
process.env.SPEC_AUTO_REPAIR = '0';
process.env.PATH = `${binDir}:${process.env.PATH}`;

// Redmine falso: guarda os comentários (PUT notes) por ticket e devolve como journals
// no GET ?include=journals — assim o teste "responde aceito" como um usuário faria.
const redminePuts = [];
const journals = {};
function addJournal(id, notes, user = 'Richard') {
    (journals[id] = journals[id] || []).push({ notes, user: { name: user }, created_on: new Date().toISOString() });
}
global.fetch = async (url, opts = {}) => {
    const id = Number((/issues\/(\d+)\.json/.exec(url) || [])[1]);
    if (opts.method === 'PUT') {
        const body = JSON.parse(opts.body);
        redminePuts.push({ url, body });
        if (body.issue?.notes) addJournal(id, body.issue.notes);
    }
    return { ok: true, status: 200, json: async () => ({ issue: { id, journals: journals[id] || [] } }) };
};

const watcher = require('../readmine-watcher');

function ticket(id, description) {
    return {
        id, subject: `Ticket ${id}`, description, status: { name: 'Aprovada' }, tracker: { name: 'Melhoria' },
        custom_fields: [{ name: 'Branch Liberação', value: 'Dev - Local' }],
        updated_on: new Date().toISOString(),
    };
}

// Task ativa no worktree sintético, parada em node=plan (fetch_ticket já rodou).
function seedActiveTask(id, spec, status = 'in_progress', stateExtra = {}) {
    const wt = path.join(repo, '.claude', 'worktrees', String(id));
    const taskId = `${id}-teste`;
    const dir = path.join(wt, 'memory', 'runs', taskId);
    fs.mkdirSync(dir, { recursive: true });
    fs.mkdirSync(path.join(wt, 'memory', 'spec'), { recursive: true });
    fs.writeFileSync(path.join(wt, 'memory', 'spec', `${id}-spec.md`), spec);
    fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({
        // ac_ids presente = run no formato novo (spec com AC-XX exigida), independente da data.
        task_id: taskId, node: 'plan', history: ['fetch_ticket'], status, started_at: new Date().toISOString(), ac_ids: [],
        ...stateExtra,
    }));
    return { taskId, dir, specPath: path.join(wt, 'memory', 'spec', `${id}-spec.md`) };
}

// Depois do despacho o state fica "running" (lease do nó, ver node-lease.js) até o
// claude falso sair e o wrapper liberar — espera o status final em vez de ler no meio.
async function waitForStatus(dir, status) {
    for (let i = 0; i < 100; i++) {
        if (JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8')).status === status) return status;
        await new Promise(r => setTimeout(r, 50));
    }
    return JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8')).status;
}

async function waitForClaudeCall(pattern) {
    for (let i = 0; i < 50; i++) {
        if (fs.existsSync(claudeCalls) && pattern.test(fs.readFileSync(claudeCalls, 'utf8'))) return true;
        await new Promise(r => setTimeout(r, 50));
    }
    return false;
}

test('ciclo novo: ticket sem Critérios de Aceite pausa antes de qualquer agente e pede aceite no Redmine uma vez', async () => {
    redminePuts.length = 0;
    const t = ticket(90001, NO_CRITERIA_SPEC);
    const result = await watcher.dispatchTicket(t);
    assert.strictEqual(result.action, 'skip');
    assert.strictEqual(result.status, 'spec-invalid');
    assert.ok(result.errors.includes('MISSING_SECTION'));
    assert.ok(!fs.existsSync(path.join(repo, '.claude', 'worktrees', '90001')), 'não pode criar worktree');
    assert.strictEqual(redminePuts.length, 1);
    assert.match(redminePuts[0].url, /issues\/90001\.json$/);
    assert.match(redminePuts[0].body.issue.notes, /Critérios de Aceite/);
    assert.match(redminePuts[0].body.issue.notes, /spec-template\.md/);
    assert.strictEqual(watcher.readSpecGate(90001).status, 'spec-invalid');

    await watcher.dispatchTicket(t);
    assert.strictEqual(redminePuts.length, 1, 'mesmo problema, sem novo comentário');
    const edited = ticket(90001, NO_CRITERIA_SPEC + '\n## Critérios de Aceite\n- só um\n');
    await watcher.dispatchTicket(edited);
    assert.strictEqual(redminePuts.length, 2, 'spec editada mas ainda inválida → novo comentário');
});

test('ciclo novo: descrição válida passa no portão (com avisos registrados)', async () => {
    const r = await watcher.runTicketSpecGate(ticket(90002, NO_RESTRICTIONS_SPEC));
    assert.strictEqual(r.result.valid, true);
    assert.strictEqual(r.proceed, true);
    const gate = watcher.readSpecGate(90002);
    assert.strictEqual(gate.status, 'valid');
    assert.strictEqual(gate.warnings.length, 3);
});

test('task em plan: spec sem Critérios grava state.status=spec-invalid, comenta e não despacha', async () => {
    redminePuts.length = 0;
    const { dir } = seedActiveTask(90003, NO_CRITERIA_SPEC);
    const result = await watcher.dispatchTicket(ticket(90003, FULL_SPEC));
    assert.strictEqual(result.reason, 'spec_aguardando_aceite');
    assert.strictEqual(JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8')).status, 'spec-invalid');
    assert.strictEqual(redminePuts.length, 1);
    assert.match(redminePuts[0].body.issue.notes, /memory\/spec\/90003-spec\.md/);
    assert.ok(!(fs.existsSync(claudeCalls) && /90003/.test(fs.readFileSync(claudeCalls, 'utf8'))));
});

test('task em plan: spec sem Restrições gera aviso no context.md e segue pro /plan', async () => {
    const { dir, taskId } = seedActiveTask(90004, NO_RESTRICTIONS_SPEC);
    const result = await watcher.dispatchTicket(ticket(90004, FULL_SPEC));
    assert.strictEqual(result.action, 'dispatched');
    const ctx = fs.readFileSync(path.join(dir, 'context.md'), 'utf8');
    assert.ok(ctx.includes(CONTEXT_BEGIN) && ctx.includes('## Restrições'));
    assert.strictEqual(await waitForStatus(dir, 'in_progress'), 'in_progress');
    assert.ok(await waitForClaudeCall(new RegExp(`/plan ${taskId}`)));
});

test('task em plan: spec completa avança normalmente pro /plan sem aviso', async () => {
    const { dir, taskId } = seedActiveTask(90005, FULL_SPEC);
    const result = await watcher.dispatchTicket(ticket(90005, FULL_SPEC));
    assert.strictEqual(result.action, 'dispatched');
    assert.strictEqual(result.node, 'plan');
    assert.ok(!fs.existsSync(path.join(dir, 'context.md')));
    assert.ok(await waitForClaudeCall(new RegExp(`/plan ${taskId}`)));
});

test('task spec-invalid: depois que a spec é corrigida volta pra in_progress e despacha', async () => {
    const { dir, taskId, specPath } = seedActiveTask(90006, NO_CRITERIA_SPEC, 'spec-invalid');
    assert.strictEqual((await watcher.dispatchTicket(ticket(90006, FULL_SPEC))).reason, 'spec_aguardando_aceite');
    fs.writeFileSync(specPath, FULL_SPEC);
    const result = await watcher.dispatchTicket(ticket(90006, FULL_SPEC));
    assert.strictEqual(result.action, 'dispatched');
    assert.strictEqual(await waitForStatus(dir, 'in_progress'), 'in_progress');
    assert.ok(await waitForClaudeCall(new RegExp(`/plan ${taskId}`)));
    assert.ok(watcher.findLocallyActiveTicketIds().includes(90006));
});

test('aceite: resposta "aceito" no Redmine destrava task spec-invalid sem preencher nada', async () => {
    redminePuts.length = 0;
    const { dir, taskId } = seedActiveTask(90007, NO_CRITERIA_SPEC);
    addJournal(90007, 'aceito', 'Alguém que comentou ANTES do pedido');
    assert.strictEqual((await watcher.dispatchTicket(ticket(90007, FULL_SPEC))).reason, 'spec_aguardando_aceite',
        'aceite anterior ao pedido do watcher não conta');
    assert.strictEqual(redminePuts.length, 1);

    addJournal(90007, 'não aceito, vou completar');
    assert.strictEqual((await watcher.dispatchTicket(ticket(90007, FULL_SPEC))).reason, 'spec_aguardando_aceite');

    addJournal(90007, 'Aceito, pode seguir assim');
    const result = await watcher.dispatchTicket(ticket(90007, FULL_SPEC));
    assert.strictEqual(result.action, 'dispatched');
    assert.strictEqual(redminePuts.length, 1, 'nenhum comentário novo depois do aceite');
    const gate = watcher.readSpecGate(90007);
    assert.ok(gate.accepted_at && /Richard/.test(gate.accepted_by));
    const ctx = fs.readFileSync(path.join(dir, 'context.md'), 'utf8');
    assert.match(ctx, /ACEITE explícito/);
    assert.match(ctx, /Critérios de Aceite/, 'pendência aceita vai como aviso');
    assert.strictEqual(await waitForStatus(dir, 'in_progress'), 'in_progress');
    assert.ok(await waitForClaudeCall(new RegExp(`/plan ${taskId}`)));
});

test('aceite: vale pro ticket — ciclo novo com spec incompleta já aceita segue sem perguntar de novo', async () => {
    redminePuts.length = 0;
    const r1 = await watcher.runTicketSpecGate(ticket(90008, NO_CRITERIA_SPEC));
    assert.strictEqual(r1.proceed, false);
    addJournal(90008, 'ok');
    const r2 = await watcher.runTicketSpecGate(ticket(90008, NO_CRITERIA_SPEC));
    assert.strictEqual(r2.proceed, true);
    assert.strictEqual(r2.accepted, true);
    assert.strictEqual(watcher.readSpecGate(90008).status, 'accepted');
    const r3 = await watcher.runTicketSpecGate(ticket(90008, NO_CRITERIA_SPEC + '\nmais texto'));
    assert.strictEqual(r3.proceed, true, 'aceite não é pedido de novo se a spec mudar');
    assert.strictEqual(redminePuts.length, 1);
});

test('resposta com a spec num comentário (caso #43584) completa a spec e segue sem aceite', async () => {
    redminePuts.length = 0;
    const desc = 'Favor adicionar o filtro default de unidade logada nas telas abaixo.\r\n\r\nTelas:\r\n- Torre de Controle de Viagens\r\n- Torre de Separação';
    addJournal(90009, '## Problema\r\nComentário do QA ANTES do pedido não conta como resposta, mesmo com cabeçalho.');
    const r1 = await watcher.runTicketSpecGate(ticket(90009, desc));
    assert.strictEqual(r1.proceed, false);
    assert.strictEqual(redminePuts.length, 1);

    addJournal(90009, '## Problema\r\n\r\nOs cards não estão recebendo o filtro da unidade, apenas o grid\r\n\r\n# Solução\r\n\r\n' +
        'Passar o parametro da unidade default também para o card.\r\n\r\n## Critérios de Aceite\r\n\r\n' +
        '- Os cards começaram a filtrar a partir da unidade\r\n- Os cards estar de acordo com que está sendo apresentado');
    const r2 = await watcher.runTicketSpecGate(ticket(90009, desc));
    assert.strictEqual(r2.proceed, true);
    assert.strictEqual(r2.accepted, false, 'completou, não precisou de aceite');
    assert.match(r2.completedBy, /Richard/);
    assert.strictEqual(watcher.readSpecGate(90009).status, 'valid');
    assert.strictEqual(redminePuts.length, 1, 'sem novo comentário');
});

// IDs AC-XX no portão da task (runTaskSpecGate): run novo exige, run legado só avisa,
// e state.json guarda só os IDs.
const LEGACY_CRITERIA_SPEC = FULL_SPEC.replace(/^- AC-0\d: /gm, '- ');
const readStateOf = dir => JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'));

test('task em plan, run novo: spec sem IDs AC-XX vira spec-invalid (AC_IDS_MISSING) e não despacha', async () => {
    const { dir, specPath } = seedActiveTask(90101, LEGACY_CRITERIA_SPEC);
    const result = await watcher.dispatchTicket(ticket(90101, FULL_SPEC));
    assert.strictEqual(result.reason, 'spec_aguardando_aceite');
    assert.deepStrictEqual(result.errors, ['AC_IDS_MISSING']);
    assert.strictEqual(readStateOf(dir).status, 'spec-invalid');
    assert.strictEqual(fs.readFileSync(specPath, 'utf8'), LEGACY_CRITERIA_SPEC, 'spec não é alterada');
});

test('task em plan, run legado: spec sem IDs segue com aviso no context.md, sem ac_ids', async () => {
    const { dir, taskId } = seedActiveTask(90102, LEGACY_CRITERIA_SPEC, 'in_progress', { ac_ids: undefined, started_at: '2026-09-01T00:00:00.000Z' });
    const result = await watcher.dispatchTicket(ticket(90102, FULL_SPEC));
    assert.strictEqual(result.action, 'dispatched');
    assert.match(fs.readFileSync(path.join(dir, 'context.md'), 'utf8'), /sem IDs AC-XX/);
    assert.ok(await waitForClaudeCall(new RegExp(`/plan ${taskId}`)));
    assert.ok(!('ac_ids' in readStateOf(dir)));
});

test('task em plan: spec com IDs válidos grava state.ac_ids só com os IDs', async () => {
    const { dir, taskId } = seedActiveTask(90103, FULL_SPEC);
    const result = await watcher.dispatchTicket(ticket(90103, FULL_SPEC));
    assert.strictEqual(result.action, 'dispatched');
    assert.ok(await waitForClaudeCall(new RegExp(`/plan ${taskId}`)));
    assert.deepStrictEqual(readStateOf(dir).ac_ids, ['AC-01', 'AC-02']);
});

// Template versionado (templates/spec.md.template) no portão da task.
const V1_SPEC = `---
spec_template_version: 1
ticket: 90201
---
# Ticket #90201 — Reenvio de NF

## Contexto
Hoje o reenvio de NF rejeitada é manual, via chamado ao suporte.

## Objetivo
A transportadora reenvia a NF rejeitada pela API, sem abrir chamado.

## Escopo
- Inclui: reenvio de NF rejeitada.
- Não inclui: NF cancelada.

## Critérios de Aceite
- AC-01: Ao reenviar uma NF rejeitada, o status muda para "Em processamento".
- AC-02: [PENDING_CLARIFICATION] Limite de reenvios por NF — aguardando PO.
`;

test('task em plan, spec do template com [PENDING_CLARIFICATION]: /plan pausado, "aceito" não libera, sem marcador segue', async () => {
    redminePuts.length = 0;
    const { dir, taskId, specPath } = seedActiveTask(90201, V1_SPEC);
    const r1 = await watcher.dispatchTicket(ticket(90201, FULL_SPEC));
    assert.strictEqual(r1.reason, 'spec_pending_clarification');
    assert.deepStrictEqual(r1.pendingClarification, ['AC-02']);
    assert.strictEqual(readStateOf(dir).status, 'spec-invalid');
    assert.strictEqual(redminePuts.length, 1);
    assert.match(redminePuts[0].body.issue.notes, /^\[Watcher\] Spec com critério pendente de esclarecimento/);
    assert.match(redminePuts[0].body.issue.notes, /AC-02/);

    addJournal(90201, 'aceito');
    const r2 = await watcher.dispatchTicket(ticket(90201, FULL_SPEC));
    assert.strictEqual(r2.reason, 'spec_pending_clarification', 'aceite não libera critério pendente');
    assert.strictEqual(redminePuts.length, 1, 'mesma spec, sem novo comentário');
    assert.ok(!(fs.existsSync(claudeCalls) && /90201/.test(fs.readFileSync(claudeCalls, 'utf8'))));

    fs.writeFileSync(specPath, V1_SPEC.replace('[PENDING_CLARIFICATION] Limite de reenvios por NF — aguardando PO.', 'Uma NF aceita no máximo 3 reenvios por dia.'));
    const r3 = await watcher.dispatchTicket(ticket(90201, FULL_SPEC));
    assert.strictEqual(r3.action, 'dispatched');
    assert.ok(await waitForClaudeCall(new RegExp(`/plan ${taskId}`)));
    const state = readStateOf(dir);
    assert.deepStrictEqual(state.ac_ids, ['AC-01', 'AC-02']);
    assert.strictEqual(state.spec_template_version, 1);
});

test('task em plan, spec do template recém-copiada (não preenchida): spec-invalid com SECTION_NOT_FILLED', async () => {
    const specTemplate = require('./spec-template');
    const spec = specTemplate.renderSpecFromTemplate({ ticketId: 90202, title: 'T', description: 'Descrição do ticket.' });
    const { dir } = seedActiveTask(90202, spec);
    const r = await watcher.dispatchTicket(ticket(90202, FULL_SPEC));
    assert.strictEqual(r.reason, 'spec_aguardando_aceite');
    assert.ok(r.errors.includes('SECTION_NOT_FILLED') && r.errors.includes('TEMPLATE_COMMENTS_PRESENT'), r.errors.join());
    assert.strictEqual(readStateOf(dir).status, 'spec-invalid');
});

test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
