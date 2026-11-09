// node --test scripts/lib/plan-scorer.test.js
// Unidade do score do plano + integração com o watcher (runPlanGate via dispatchTicket)
// usando um REPO_PATH sintético, fetch stubado (nenhum Redmine real) e um binário
// `claude` falso no PATH (nenhum agente real) — mesmo arranjo do spec-validator.test.js.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { scorePlan, extractSteps, extractProhibitions, thresholdFrom, planSignature } = require('./plan-scorer');

const FILLER = 'Texto descritivo suficiente para passar do limite mínimo de caracteres exigido pela validação. ';

const SPEC = `## Problema
${FILLER}Hoje o filtro de transportadora lista todas as transportadoras cadastradas.

## Solução
${FILLER}Filtrar pela lista do resultado atual, igual à Programação de Carga.

## Critérios de Aceite
- Filtro de transportadora lista somente transportadoras presentes no resultado da tela.
- Novo filtro de operação de transporte com o mesmo comportamento dinâmico.
- Paginação da Torre de Controle continua funcionando sem regressão.

## Restrições
- Não alterar o contrato do endpoint de Zona de Transporte.
- Threshold configurável por projeto.

## Arquivos Afetados
- TorreControleViagensService.java

## Dependências
- Nenhuma.
`;

const GOOD_PLAN = `# Handoff

## Objetivo
Filtros dinâmicos na Torre de Controle.

## Plano de execução
1. Filtrar transportadoras pelo resultado atual da tela (AC1).
   - Arquivo: \`app-core/src/main/java/br/com/mo/torre/TorreControleViagensService.java\`
   - Verificação: teste unitário novo retorna só as transportadoras do resultado.
2. Adicionar filtro de operação de transporte com o mesmo comportamento dinâmico (AC2).
   - Arquivo: \`app-front/app/routes/track/torre-controle-viagens/torre-controle-viagens.html\`
   - Verificação: conferir no preview que o filtro lista só as operações da tela.
3. Rodar a suíte da Torre de Controle para garantir a paginação sem regressão (AC3).
   - Arquivo: TorreControleViagensServiceTest.java
   - Verificação: mvn test do módulo passa.
`;

const TWO_GENERIC_STEPS = `# Handoff

## Plano de execução
1. Ajustar o código.
2. Fazer os ajustes necessários.
`;

// ---------------------------------------------------------------------------------
// Unidade

test('plano com 2 steps genéricos fica abaixo de 60 e o feedback diz "steps insuficientes"', () => {
    const r = scorePlan(TWO_GENERIC_STEPS, SPEC, { threshold: 60 });
    assert.ok(r.score < 60, `score ${r.score}`);
    assert.strictEqual(r.passed, false);
    assert.strictEqual(r.steps, 2);
    assert.ok(r.feedback.some(f => /steps insuficientes/.test(f)), r.feedback.join('\n'));
    assert.ok(r.feedback.includes('Step 1 não especifica arquivo a modificar (ex: "Arquivo: app-core/src/.../Service.java").'));
    assert.ok(r.feedback.some(f => /^Step 2 não tem critério de verificação/.test(f)));
});

test('plano bem estruturado cobrindo os ACs tira 100 sem feedback', () => {
    const r = scorePlan(GOOD_PLAN, SPEC, { threshold: 60 });
    assert.deepStrictEqual(r.feedback, []);
    assert.strictEqual(r.score, 100);
    assert.strictEqual(r.passed, true);
    assert.strictEqual(r.criteria.length, 5);
    assert.ok(r.criteria.every(c => c.max === 20));
});

test('passo sem arquivo/verificação perde pontos proporcionais e é citado pelo número', () => {
    const plan = GOOD_PLAN.replace(
        /3\. Rodar a suíte[\s\S]*$/,
        '3. Revisar a paginação da Torre de Controle sem regressão (AC3).\n',
    );
    const r = scorePlan(plan, SPEC, { threshold: 60 });
    assert.ok(r.feedback.some(f => f.startsWith('Step 3 não especifica arquivo a modificar')));
    assert.ok(r.feedback.some(f => f.startsWith('Step 3 não tem critério de verificação')));
    assert.strictEqual(r.score, 100 - Math.round(20 / 3 * 2));
    assert.strictEqual(r.passed, true);
});

test('linha "Arquivo:" ilegível perde o crédito de arquivo e o feedback explica; anotação entre crases com caminho legível não perde', () => {
    const mk = arquivo => `## Plano de execução\n1. Passo um\n   - Arquivo: ${arquivo}\n   - Verificação: teste passa.\n` +
        '2. Passo dois\n   - Arquivo: `src/b/B.java`\n   - Verificação: teste passa.\n3. Passo três\n   - Arquivo: `src/c/C.java`\n   - Verificação: teste passa.\n';
    const files = r => r.criteria.find(c => c.key === 'steps_files').points;
    const ok = scorePlan(mk('`src/a/A.java` (novo, `@ApplicationScoped`)'), '', { threshold: 60 });
    assert.strictEqual(files(ok), 20);
    assert.ok(!ok.feedback.some(f => /legível/.test(f)));
    for (const bad of ['`src/.../A.java`', '`@ApplicationScoped`', '`src/a/`']) {
        const r = scorePlan(mk(bad), '', { threshold: 60 });
        assert.ok(Math.abs(files(r) - 20 * 2 / 3) < 0.05, bad);
        assert.ok(r.feedback.some(f => /^Step 1: a linha "Arquivo:" não tem uma lista legível/.test(f)), bad);
        assert.ok(!r.feedback.some(f => /Step 1 não especifica arquivo/.test(f)), 'não duplica o aviso');
    }
});

test('mais de 10 passos também reprova o critério de quantidade', () => {
    const steps = Array.from({ length: 11 }, (_, i) => `${i + 1}. Passo ${i + 1} em \`a/b${i}.js\`. Verificação: teste ${i} passa.`).join('\n');
    const r = scorePlan(`## Plano de execução\n${steps}\n`, '', { threshold: 60 });
    assert.strictEqual(r.criteria.find(c => c.key === 'steps_count').points, 0);
    assert.ok(r.feedback.some(f => /acima do máximo de 10/.test(f)));
});

test('passo que contraria uma proibição da spec é apontado; passo que a respeita não', () => {
    const breaking = GOOD_PLAN.replace('1. Filtrar transportadoras', '1. Alterar o contrato do endpoint de Zona e filtrar transportadoras');
    const r = scorePlan(breaking, SPEC, { threshold: 60 });
    assert.strictEqual(r.criteria.find(c => c.key === 'no_contradiction').points, 0);
    assert.ok(r.feedback.some(f => /^Step 1 parece contradizer a restrição do spec: "Não alterar o contrato do endpoint de Zona/.test(f)), r.feedback.join('\n'));

    const respecting = GOOD_PLAN.replace('1. Filtrar transportadoras', '1. Sem mexer no contrato do endpoint de Zona, filtrar transportadoras');
    assert.strictEqual(scorePlan(respecting, SPEC).criteria.find(c => c.key === 'no_contradiction').points, 20);
    // Restrição afirmativa ("Threshold configurável") não vira proibição.
    assert.deepStrictEqual(extractProhibitions(SPEC).map(p => p.text), ['Não alterar o contrato do endpoint de Zona de Transporte.']);
});

test('AC não endereçado por nenhum passo aparece no feedback com o número do critério', () => {
    const plan = GOOD_PLAN.replace(/2\. Adicionar filtro[\s\S]*?(?=3\.)/, '').replace('3. Rodar', '2. Rodar');
    const r = scorePlan(plan, SPEC, { threshold: 60 });
    assert.ok(r.feedback.some(f => /^Critério de aceite 2 não é endereçado por nenhum step: "Novo filtro de operação/.test(f)), r.feedback.join('\n'));
    assert.ok(!r.feedback.some(f => /^Critério de aceite [13]\b/.test(f)));
});

test('sem a seção do plano, usa "Trabalho pendente"; sem nenhum dos dois, 0 passos', () => {
    assert.strictEqual(extractSteps('## Trabalho pendente\n- a\n- b\n').steps.length, 2);
    assert.strictEqual(extractSteps('## Passos\n1. um\n   - Arquivo: x.js\n2. dois\n').steps[0], 'um\n- Arquivo: x.js');
    const r = scorePlan('# Handoff\n\nTexto corrido sem lista.', SPEC);
    assert.strictEqual(r.steps, 0);
    assert.ok(r.feedback[0].includes('falta a seção "## Plano de execução"'));
});

test('PLAN_SCORE_THRESHOLD configura o mínimo; valor inválido cai no padrão 60', () => {
    assert.strictEqual(thresholdFrom({}), 60);
    assert.strictEqual(thresholdFrom({ PLAN_SCORE_THRESHOLD: '75' }), 75);
    assert.strictEqual(thresholdFrom({ PLAN_SCORE_THRESHOLD: 'abc' }), 60);
    assert.strictEqual(thresholdFrom({ PLAN_SCORE_THRESHOLD: '150' }), 60);
    assert.strictEqual(scorePlan(GOOD_PLAN, SPEC, { threshold: 101 }).passed, false);
    assert.notStrictEqual(planSignature(GOOD_PLAN), planSignature(TWO_GENERIC_STEPS));
});

// ---------------------------------------------------------------------------------
// Integração com o watcher

const tmp = fs.mkdtempSync(path.join(process.env.CLAUDE_JOB_DIR ? path.join(process.env.CLAUDE_JOB_DIR, 'tmp') : os.tmpdir(), 'plan-gate-'));
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
// O portão de build (mvn compile) roda depois deste — fora do escopo destes testes.
process.env.SKIP_PRE_BUILD_VALIDATION = 'true';
delete process.env.PLAN_SCORE_THRESHOLD;
process.env.PATH = `${binDir}:${process.env.PATH}`;

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

function ticket(id) {
    return {
        id, subject: `Ticket ${id}`, description: SPEC, status: { name: 'Aprovada' }, tracker: { name: 'Melhoria' },
        custom_fields: [{ name: 'Branch Liberação', value: 'Dev - Local' }],
        updated_on: new Date().toISOString(),
    };
}

// Task que acabou de sair do /plan: node=implement, último item do history = plan.
function seedPlannedTask(id, handoff) {
    const wt = path.join(repo, '.claude', 'worktrees', String(id));
    const taskId = `${id}-teste`;
    const dir = path.join(wt, 'memory', 'runs', taskId);
    fs.mkdirSync(dir, { recursive: true });
    fs.mkdirSync(path.join(wt, 'memory', 'spec'), { recursive: true });
    fs.writeFileSync(path.join(wt, 'memory', 'spec', `${id}-spec.md`), SPEC);
    fs.writeFileSync(path.join(dir, 'handoff.md'), handoff);
    fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({
        task_id: taskId, node: 'implement', history: ['fetch_ticket', 'plan'], status: 'in_progress',
        // Run legado fixo (spec SPEC sem IDs AC-XX): o re-plan volta pelo portão de spec,
        // que num run novo exigiria IDs — data fixa pra não depender do relógio.
        started_at: '2026-09-01T00:00:00.000Z',
    }));
    return { taskId, dir };
}

const readState = dir => JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'));

async function waitForStatus(dir, status) {
    for (let i = 0; i < 100; i++) {
        if (readState(dir).status === status) return status;
        await new Promise(r => setTimeout(r, 50));
    }
    return readState(dir).status;
}

async function waitForClaudeCall(pattern) {
    for (let i = 0; i < 50; i++) {
        if (fs.existsSync(claudeCalls) && pattern.test(fs.readFileSync(claudeCalls, 'utf8'))) return true;
        await new Promise(r => setTimeout(r, 50));
    }
    return false;
}

const claudeLog = () => (fs.existsSync(claudeCalls) ? fs.readFileSync(claudeCalls, 'utf8') : '');

// O claude falso não reescreve nada: simula o /plan terminando com o mesmo plano ruim.
function finishPlan(dir) {
    const s = readState(dir);
    s.node = 'implement';
    s.history = [...s.history, 'plan'];
    fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify(s));
}

test('plano com score >= 60: implement despachado normalmente, score gravado no state.json', async () => {
    const { dir, taskId } = seedPlannedTask(91001, GOOD_PLAN);
    const result = await watcher.dispatchTicket(ticket(91001));
    assert.strictEqual(result.action, 'dispatched');
    assert.strictEqual(result.node, 'implement');
    assert.ok(await waitForClaudeCall(new RegExp(`/implement ${taskId}`)));
    await waitForStatus(dir, 'in_progress');
    const s = readState(dir);
    assert.strictEqual(s.planScore, 100);
    assert.strictEqual(s.planAttempts, 0);
    assert.deepStrictEqual(s.planFeedback, []);
    assert.strictEqual(s.planScoreThreshold, 60);
});

test('2 steps genéricos: re-plan com feedback; após 2 re-plans → plan-escalation + Redmine; "aceito" destrava', async () => {
    redminePuts.length = 0;
    const { dir, taskId } = seedPlannedTask(91002, TWO_GENERIC_STEPS);

    // 1º score ruim → re-plan 1/2 com o feedback no prompt do /plan.
    let result = await watcher.dispatchTicket(ticket(91002));
    assert.strictEqual(result.action, 'dispatched');
    assert.strictEqual(result.node, 'plan');
    assert.ok(await waitForClaudeCall(new RegExp(`/plan ${taskId}[\\s\\S]*RE-PLAN 1/2[\\s\\S]*steps insuficientes`)), claudeLog());
    // Contexto pré-montado (scripts/lib/prompt-context.js) no prompt + plan sem subagente.
    assert.match(claudeLog(), /CONTEXTO PRÉ-MONTADO PELO ORQUESTRADOR \(nó plan\)/);
    assert.match(claudeLog(), /--disallowedTools Agent,Task/);
    await waitForStatus(dir, 'in_progress');
    let s = readState(dir);
    assert.strictEqual(s.planAttempts, 1);
    assert.ok(s.planScore < 60);
    assert.ok(s.planFeedback.some(f => /steps insuficientes/.test(f)));
    assert.strictEqual(s.node, 'plan');
    assert.ok(s.events.some(e => e.type === 'plan_replan'));

    // 2º score ruim → re-plan 2/2.
    finishPlan(dir);
    result = await watcher.dispatchTicket(ticket(91002));
    assert.strictEqual(result.node, 'plan');
    assert.ok(await waitForClaudeCall(/RE-PLAN 2\/2/));
    await waitForStatus(dir, 'in_progress');
    assert.strictEqual(readState(dir).planAttempts, 2);
    assert.strictEqual(redminePuts.length, 0, 're-plan não comenta no Redmine');

    // 3º score ruim → sem novo re-plan: plan-escalation e pedido de revisão no Redmine.
    finishPlan(dir);
    const callsBefore = claudeLog();
    result = await watcher.dispatchTicket(ticket(91002));
    assert.strictEqual(result.action, 'skip');
    assert.strictEqual(result.reason, 'plan_escalation');
    s = readState(dir);
    assert.strictEqual(s.status, 'plan-escalation');
    assert.strictEqual(s.planAttempts, 2);
    assert.ok(s.planEscalationNotifiedAt);
    assert.strictEqual(redminePuts.length, 1);
    assert.match(redminePuts[0].url, /issues\/91002\.json$/);
    assert.ok(redminePuts[0].body.issue.notes.startsWith(watcher.PLAN_GATE_COMMENT_PREFIX));
    assert.match(redminePuts[0].body.issue.notes, /steps insuficientes/);
    assert.match(redminePuts[0].body.issue.notes, /"aceito"/);
    assert.strictEqual(claudeLog(), callsBefore, 'nenhum agente despachado na escalada');

    // Tick seguinte sem resposta: continua parado, sem comentário repetido.
    result = await watcher.dispatchTicket(ticket(91002));
    assert.strictEqual(result.reason, 'plan_escalation');
    assert.strictEqual(redminePuts.length, 1);

    // Humano responde "aceito" → segue pro implement com o plano como está.
    addJournal(91002, 'Aceito, pode seguir com este plano.');
    result = await watcher.dispatchTicket(ticket(91002));
    assert.strictEqual(result.action, 'dispatched');
    assert.strictEqual(result.node, 'implement');
    assert.ok(await waitForClaudeCall(new RegExp(`/implement ${taskId}`)));
    await waitForStatus(dir, 'in_progress');
    s = readState(dir);
    assert.strictEqual(s.planAccepted.signature, s.planSignature);
    assert.match(s.planAccepted.by, /Richard/);
});

test('plan-escalation: plano editado que passa no score destrava sem aceite', async () => {
    const { dir, taskId } = seedPlannedTask(91003, TWO_GENERIC_STEPS);
    const s = readState(dir);
    Object.assign(s, { status: 'plan-escalation', node: 'plan', planAttempts: 2, planEscalationNotifiedAt: new Date().toISOString() });
    fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify(s));
    assert.strictEqual((await watcher.dispatchTicket(ticket(91003))).reason, 'plan_escalation');

    fs.writeFileSync(path.join(dir, 'handoff.md'), GOOD_PLAN);
    const result = await watcher.dispatchTicket(ticket(91003));
    assert.strictEqual(result.node, 'implement');
    assert.ok(await waitForClaudeCall(new RegExp(`/implement ${taskId}`)));
    assert.strictEqual(readState(dir).planScore, 100);
});

test('state.json com os campos do portão passa no schema', () => {
    const { validateState } = require('../validate-state');
    const r = validateState({
        task_id: 'x', node: 'plan', history: ['plan'], status: 'plan-escalation', started_at: new Date().toISOString(),
        planScore: 40, planAttempts: 2, planFeedback: ['Step 1 não especifica arquivo a modificar'],
    });
    assert.ok(r.valid, JSON.stringify(r.errors));
});
