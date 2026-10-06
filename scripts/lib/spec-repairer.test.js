// node --test scripts/lib/spec-repairer.test.js
// Unidade do auto-repair (geração, mescla, comentário) + integração com o watcher
// (runTicketSpecGate/runTaskSpecGate/dispatchTicket) com REPO_PATH sintético, Redmine
// falso (journals com id, como o real) e um binário `claude` falso no PATH.
const test = require('node:test');
// Conta do Claude do dashboard real (dashboard-prefs.json) não vaza pro env esperado do filho.
process.env.DASHBOARD_PREFS_FILE = require('path').join(require('os').tmpdir(), 'sem-dashboard-prefs.json');
delete process.env.WATCHER_CLAUDE_CONFIG_DIR;
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const repairer = require('./spec-repairer');
const { validateSpec, isApprovalNote, SPEC_REPAIR_COMMENT_PREFIX } = require('./spec-validator');

const FILLER = 'Texto descritivo suficiente para passar do limite mínimo de caracteres exigido pela validação. ';

const NO_SOLUTION_SPEC = `## Problema
${FILLER}Hoje o filtro de rota não busca por descrição.

## Critérios de Aceite
- Busca por descrição retorna rotas com match parcial.
- Filtros por oid continuam funcionando.
`;

const FULL_SPEC = `${NO_SOLUTION_SPEC}
## Solução
${FILLER}Adicionar busca por descrição igual à Zona de Transporte.
`;

const TICKET_DATA = {
    id: 1, subject: 'Filtro de rota por descrição', description: 'O filtro de rota precisa buscar por descrição.',
    tracker: { name: 'Melhoria' }, category: { name: 'Roteirização' },
    custom_fields: [{ name: 'Branch Liberação', value: 'Dev - Local' }, { name: 'Vazio', value: '' }],
};

// ---------------------------------------------------------------------------------
// Unidade

test('repairSpec: gera só as seções pedidas, descarta extras e mantém ordem do template', async () => {
    let seen;
    const out = await repairer.repairSpec({
        specContent: NO_SOLUTION_SPEC, ticketData: TICKET_DATA, missingSections: ['solucao'],
        runClaude: async args => { seen = args; return { ok: true, output: '## Problema\nrepetido\n\n## Solução\n\nBuscar também por descrição.\n' }; },
    });
    assert.strictEqual(out, '## Solução\n\nBuscar também por descrição.');
    assert.match(seen.system, /Você é um assistente de especificação técnica/);
    assert.match(seen.system, /Não invente detalhes que não estejam no ticket/);
    assert.match(seen.system, /Seções a gerar: ## Solução/);
    assert.match(seen.prompt, /Título: Filtro de rota por descrição/);
    assert.match(seen.prompt, /Categoria: Roteirização/);
    assert.match(seen.prompt, /- Branch Liberação: Dev - Local/);
    assert.doesNotMatch(seen.prompt, /Vazio/);
    assert.strictEqual(seen.timeoutMs, repairer.DEFAULT_TIMEOUT_MS);
});

test('timeout: padrão 120s, SPEC_REPAIR_TIMEOUT_MS sobrescreve, inválido cai no padrão', async () => {
    assert.strictEqual(repairer.DEFAULT_TIMEOUT_MS, 120000);
    assert.strictEqual(repairer.resolveTimeoutMs({}), 120000);
    assert.strictEqual(repairer.resolveTimeoutMs({ SPEC_REPAIR_TIMEOUT_MS: '300000' }), 300000);
    assert.strictEqual(repairer.resolveTimeoutMs({ SPEC_REPAIR_TIMEOUT_MS: 'x' }), 120000);
    assert.strictEqual(repairer.resolveTimeoutMs({ SPEC_REPAIR_TIMEOUT_MS: '0' }), 120000);
    let seen = null;
    await repairer.repairSpec({
        specContent: '## Problema\nx\n', ticketData: { id: 1, subject: 'x' }, missingSections: ['solucao'],
        env: { SPEC_REPAIR_TIMEOUT_MS: '45000' },
        runClaude: async args => { seen = args; return { ok: false, reason: 'x' }; },
    });
    assert.strictEqual(seen.timeoutMs, 45000);
});

test('isPlaceholderOnly: só placeholder (com ou sem lista/comentário) vs. seção com um item a definir', () => {
    const P = repairer.PLACEHOLDER;
    assert.strictEqual(repairer.isPlaceholderOnly(`## Solução\n\n${P}`), true);
    assert.strictEqual(repairer.isPlaceholderOnly(`## Critérios de Aceite\n\n- ${P}\n- ${P}\n`), true);
    assert.strictEqual(repairer.isPlaceholderOnly(`## Solução\n\n${P}\n<!-- ticket vago -->`), true);
    assert.strictEqual(repairer.isPlaceholderOnly('## Solução\n'), true);
    assert.strictEqual(repairer.isPlaceholderOnly(`## Solução\n\nIncluir a opção X.\n- Permissão: ${P}`), false);
});

test('repairSpec: falha, exceção ou seção não gerada → placeholder (critérios como lista)', async () => {
    const reasons = [];
    const failed = await repairer.repairSpec({
        specContent: '', ticketData: TICKET_DATA, missingSections: ['criterios_aceite', 'Solução'],
        runClaude: async () => ({ ok: false, output: '', reason: 'exit 1' }), onFallback: r => reasons.push(r),
    });
    assert.strictEqual(failed, `## Solução\n\n${repairer.PLACEHOLDER}\n\n## Critérios de Aceite\n\n- ${repairer.PLACEHOLDER}`);
    assert.deepStrictEqual(reasons, ['exit 1']);
    const thrown = await repairer.repairSpec({
        specContent: '', ticketData: TICKET_DATA, missingSections: ['solucao'],
        runClaude: async () => { throw new Error('boom'); },
    });
    assert.match(thrown, /A definir — revisar com o responsável pelo ticket\./);
    const partial = await repairer.repairSpec({
        specContent: '', ticketData: TICKET_DATA, missingSections: ['solucao', 'problema_contexto'],
        runClaude: async () => ({ ok: true, output: '## Solução\nFazer X.' }),
    });
    assert.match(partial, /## Problema\n\nA definir/);
    assert.ok(partial.indexOf('## Problema') < partial.indexOf('## Solução'), 'ordem do template');
    assert.match(partial, /## Solução\n\nFazer X\./);
    assert.strictEqual(await repairer.repairSpec({ specContent: '', ticketData: {}, missingSections: ['xyz'] }), '');
});

test('runClaudeCli: estoura o timeout e mata o processo', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'repair-bin-'));
    const bin = path.join(dir, 'slow-claude');
    fs.writeFileSync(bin, '#!/bin/sh\ncat >/dev/null\nsleep 5\necho "## Solução"\n', { mode: 0o755 });
    const t0 = Date.now();
    const r = await repairer.runClaudeCli({ system: 's', prompt: 'p', timeoutMs: 300, bin });
    assert.strictEqual(r.ok, false);
    assert.match(r.reason, /timeout/);
    assert.ok(Date.now() - t0 < 3000);
    const out = await repairer.repairSpec({
        specContent: '', ticketData: TICKET_DATA, missingSections: ['solucao'], timeoutMs: 300,
        runClaude: args => repairer.runClaudeCli({ ...args, bin }),
    });
    assert.match(out, /## Solução\n\nA definir/);
    fs.rmSync(dir, { recursive: true, force: true });
});

test('secrets: fora do env do filho e redigidos do prompt e da resposta', async () => {
    const env = {
        PATH: '/bin', BITBUCKET_API_TOKEN: 'bb-secret-123456', REDMINE_API_KEY: 'rm-secret-123456',
        ANTHROPIC_API_KEY: 'sk-ant-keep', CLAUDECODE: '1', OTHER_SECRET: 'x',
    };
    const child = repairer.childEnv(env);
    assert.deepStrictEqual(Object.keys(child).sort(), ['ANTHROPIC_API_KEY', 'PATH']);
    let prompt;
    const out = await repairer.repairSpec({
        specContent: 'token bb-secret-123456 colado na spec', ticketData: { ...TICKET_DATA, description: 'chave rm-secret-123456' },
        missingSections: ['solucao'], env,
        runClaude: async a => { prompt = a.prompt; return { ok: true, output: '## Solução\nUsar rm-secret-123456.' }; },
    });
    assert.doesNotMatch(prompt, /bb-secret|rm-secret/);
    assert.match(prompt, /\[REDACTED\]/);
    assert.doesNotMatch(out, /rm-secret/);
});

test('mergeDraft: ausente é anexada, vazia é preenchida, critérios insuficientes são somados', () => {
    const draft = repairer.formatDraftFile({
        ticketId: 1,
        sectionsMd: '## Solução\n\nBuscar por descrição.\n\n## Critérios de Aceite\n\n- Critério novo A\n- Critério novo B',
    });
    const spec = `## Problema\n${FILLER}${FILLER}\n\n## Critérios de Aceite\n- Único critério\n\n## Restrições\n- Não mexer na Zona.\n`;
    const r = repairer.mergeDraft(spec, draft);
    assert.deepStrictEqual(r.merged.sort(), ['criterios_aceite', 'solucao']);
    assert.match(r.content, /- Único critério\n- Critério novo A\n- Critério novo B\n\n## Restrições/);
    assert.match(r.content, /## Solução\n\nBuscar por descrição\.\n$/);
    assert.ok(!r.content.includes('spec-repairer'), 'marcador do draft não vai pra spec');
    assert.strictEqual(validateSpec(r.content).valid, true);

    const empty = repairer.mergeDraft(`## Solução\n\n## Problema\n${FILLER}\n`, '## Solução\nFazer X.');
    assert.match(empty.content, /^## Solução\n\nFazer X\.\n\n## Problema/);
});

test('mergeDraft: seção preenchida pelo humano depois do draft não é sobrescrita', () => {
    const r = repairer.mergeDraft(FULL_SPEC, '## Solução\n\nSugestão da IA.');
    assert.deepStrictEqual(r.merged, []);
    assert.deepStrictEqual(r.skipped, ['solucao']);
    assert.strictEqual(r.content, FULL_SPEC);
});

test('comentário: prefixo, aviso de IA, diff, palavra de aprovação e caminho', () => {
    const msg = repairer.formatRepairComment({
        ticketId: 7, result: validateSpec(NO_SOLUTION_SPEC), sectionsMd: '## Solução\n\nFazer X.',
        specLocation: 'memory/spec/7-spec.md (worktree do ticket)', draftPath: 'memory/spec/7-spec.draft.md',
        keyword: 'aprovado', sourceLabel: 'memory/spec/7-spec.md',
    });
    assert.ok(msg.startsWith(SPEC_REPAIR_COMMENT_PREFIX));
    assert.match(msg, /escrito por IA/);
    assert.match(msg, /Revise antes de aprovar/);
    assert.match(msg, /```diff\n\+ ## Solução\n\+\n\+ Fazer X\.\n```/);
    assert.match(msg, /responda este comentário com 'aprovado'/);
    assert.match(msg, /atualize a spec em memory\/spec\/7-spec\.md/);
    assert.match(msg, /"aceito"/);
});

test('isApprovalNote: palavra no início, sem caixa; palavra configurável', () => {
    for (const t of ['aprovado', 'Aprovado!', '  APROVADO, pode mesclar']) assert.ok(isApprovalNote(t, 'aprovado'), t);
    for (const t of ['não aprovado', 'desaprovado', 'aprovados', '']) assert.ok(!isApprovalNote(t, 'aprovado'), t);
    assert.ok(isApprovalNote('LGTM', 'lgtm'));
    assert.ok(!isApprovalNote('aprovado', 'lgtm'));
});

// ---------------------------------------------------------------------------------
// Integração com o watcher

const tmp = fs.mkdtempSync(path.join(process.env.CLAUDE_JOB_DIR ? path.join(process.env.CLAUDE_JOB_DIR, 'tmp') : os.tmpdir(), 'spec-repair-'));
const repo = path.join(tmp, 'app-back');
const binDir = path.join(tmp, 'bin');
const claudeCalls = path.join(tmp, 'claude-calls.log');
const repairCalls = path.join(tmp, 'repair-calls.log');
const repairMode = path.join(tmp, 'repair-mode');
fs.mkdirSync(repo, { recursive: true });
fs.mkdirSync(binDir);
// Chamada do auto-repair = tem --system-prompt: responde conforme repair-mode (ok|fail).
// Qualquer outra = despacho de nó: só registra os argumentos.
fs.writeFileSync(path.join(binDir, 'claude'), `#!/bin/sh
case "$*" in
  *--system-prompt*)
    cat > /dev/null
    echo call >> '${repairCalls}'
    if [ "$(cat '${repairMode}' 2>/dev/null)" = fail ]; then exit 1; fi
    printf '## Problema\\nnão pedido\\n\\n## Solução\\n\\nSugestão da IA: buscar também por descrição.\\n'
    ;;
  *) printf '%s\\n' "$*" >> '${claudeCalls}' ;;
esac
`, { mode: 0o755 });
process.env.REPO_PATH = repo;
// Portão de build pré-implement roda mvn de verdade — coberto em build-validator.test.js.
process.env.SKIP_PRE_BUILD_VALIDATION = 'true';
process.env.REDMINE_URL = 'http://redmine.test';
process.env.REDMINE_API_KEY = 'k';
// Rascunho gerado dos campos do ticket (spec-generator) tem teste próprio em
// spec-generator.test.js — aqui o alvo é o portão da descrição.
process.env.SPEC_DRAFT_AUTOGEN = '0';
process.env.PATH = `${binDir}:${process.env.PATH}`;
delete process.env.SPEC_AUTO_REPAIR;
delete process.env.SPEC_APPROVAL_KEYWORD;

// Redmine falso com journals numerados (o comment_id do draft vem daqui).
const redminePuts = [];
const journals = {};
let nextJournalId = 1000;
function addJournal(id, notes, user = 'Richard', createdOn = new Date().toISOString()) {
    (journals[id] = journals[id] || []).push({ id: nextJournalId++, notes, user: { name: user }, created_on: createdOn });
}
global.fetch = async (url, opts = {}) => {
    const id = Number((/issues\/(\d+)\.json/.exec(url) || [])[1]);
    if (opts.method === 'PUT') {
        const body = JSON.parse(opts.body);
        redminePuts.push({ url, body });
        if (body.issue?.notes) addJournal(id, body.issue.notes, 'Watcher');
        return { ok: true, status: 204, json: async () => ({}) };
    }
    return { ok: true, status: 200, json: async () => ({ issue: { id, journals: journals[id] || [] } }) };
};

const watcher = require('../readmine-watcher');
const { readAndValidateState } = require('../validate-state');

function ticket(id, description) {
    return {
        id, subject: `Ticket ${id}`, description, status: { name: 'Aprovada' }, tracker: { name: 'Melhoria' },
        custom_fields: [{ name: 'Branch Liberação', value: 'Dev - Local' }],
        updated_on: new Date().toISOString(),
    };
}

function seedActiveTask(id, spec, status = 'in_progress') {
    const wt = path.join(repo, '.claude', 'worktrees', String(id));
    const taskId = `${id}-teste`;
    const dir = path.join(wt, 'memory', 'runs', taskId);
    fs.mkdirSync(dir, { recursive: true });
    fs.mkdirSync(path.join(wt, 'memory', 'spec'), { recursive: true });
    fs.writeFileSync(path.join(wt, 'memory', 'spec', `${id}-spec.md`), spec);
    fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({
        // Run legado fixo (antes dos IDs AC-XX, sem ac_ids): o assunto aqui é o auto-repair,
        // não os IDs — data fixa pra não depender do relógio (spec-validator isLegacyAcRun).
        task_id: taskId, node: 'plan', history: ['fetch_ticket'], status, started_at: '2026-09-01T00:00:00.000Z',
    }));
    return { taskId, dir, specPath: path.join(wt, 'memory', 'spec', `${id}-spec.md`) };
}

const readState = dir => JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'));
const draftPath = id => path.join(repo, 'memory', 'spec', `${id}-spec.draft.md`);
const repairCount = () => (fs.existsSync(repairCalls) ? fs.readFileSync(repairCalls, 'utf8').split('\n').filter(Boolean).length : 0);
const putsFor = id => redminePuts.filter(p => p.url.endsWith(`/issues/${id}.json`));

async function waitForClaudeCall(pattern) {
    for (let i = 0; i < 50; i++) {
        if (fs.existsSync(claudeCalls) && pattern.test(fs.readFileSync(claudeCalls, 'utf8'))) return true;
        await new Promise(r => setTimeout(r, 50));
    }
    return false;
}

test('ciclo novo sem ## Solução: gera draft, comenta no Redmine e pausa em spec-pending-approval', async () => {
    fs.writeFileSync(repairMode, 'ok');
    const t = ticket(91001, NO_SOLUTION_SPEC);
    const result = await watcher.dispatchTicket(t);
    assert.strictEqual(result.action, 'skip');
    assert.strictEqual(result.reason, 'spec_aguardando_aprovacao');
    assert.strictEqual(result.status, 'spec-pending-approval');
    assert.ok(!fs.existsSync(path.join(repo, '.claude', 'worktrees', '91001')), 'não cria worktree');
    assert.ok(!fs.existsSync(path.join(repo, 'memory', 'spec', '91001-spec.md')), 'não escreve spec sem aprovação');

    const draft = fs.readFileSync(draftPath(91001), 'utf8');
    assert.match(draft, /## Solução\n\nSugestão da IA/);
    assert.doesNotMatch(draft, /não pedido/, 'seção não pedida é descartada');
    assert.strictEqual(putsFor(91001).length, 1);
    const note = putsFor(91001)[0].body.issue.notes;
    assert.ok(note.startsWith(SPEC_REPAIR_COMMENT_PREFIX));
    assert.match(note, /'aprovado'/);
    assert.doesNotMatch(note, /"issue"|X-Redmine|\bk\b.*API/);

    const gate = watcher.readSpecGate(91001);
    assert.strictEqual(gate.status, 'spec-pending-approval');
    assert.strictEqual(gate.spec_pending_approval.comment_id, journals[91001][0].id);
    assert.strictEqual(gate.spec_pending_approval.draft_path, 'memory/spec/91001-spec.draft.md');
    assert.strictEqual(gate.spec_pending_approval.reminder_sent, false);
    assert.deepStrictEqual(gate.spec_pending_approval.missing_sections, ['solucao']);

    const calls = repairCount();
    assert.strictEqual((await watcher.dispatchTicket(t)).reason, 'spec_aguardando_aprovacao');
    assert.strictEqual(putsFor(91001).length, 1, 'sem novo comentário');
    assert.strictEqual(repairCount(), calls, 'sem nova geração');
});

test('ciclo novo: "aprovado" antes do draft não conta; depois dele mescla, apaga o draft e segue', async () => {
    fs.writeFileSync(repairMode, 'ok');
    addJournal(91002, 'aprovado', 'Alguém', new Date(Date.now() - 60000).toISOString());
    const t = ticket(91002, NO_SOLUTION_SPEC);
    assert.strictEqual((await watcher.runTicketSpecGate(t)).proceed, false);
    assert.strictEqual((await watcher.runTicketSpecGate(t)).proceed, false, 'aprovação anterior ao comentário é ignorada');

    addJournal(91002, 'não aprovado, falta detalhe');
    assert.strictEqual((await watcher.runTicketSpecGate(t)).proceed, false);

    addJournal(91002, 'Aprovado');
    const r = await watcher.runTicketSpecGate(t);
    assert.strictEqual(r.proceed, true);
    assert.strictEqual(r.result.valid, true);
    assert.match(r.approvedRepair.by, /Richard/);
    assert.deepStrictEqual(r.approvedRepair.merged, ['solucao']);
    const spec = fs.readFileSync(path.join(repo, 'memory', 'spec', '91002-spec.md'), 'utf8');
    assert.ok(spec.startsWith(NO_SOLUTION_SPEC.trimEnd()), 'conteúdo original preservado');
    assert.match(spec, /## Solução\n\nSugestão da IA/);
    assert.ok(!fs.existsSync(draftPath(91002)), 'draft apagado');
    const gate = watcher.readSpecGate(91002);
    assert.strictEqual(gate.status, 'valid');
    assert.strictEqual(gate.spec_pending_approval, undefined);
    assert.ok(gate.accepted_at && gate.spec_repair.approved_by);
    assert.strictEqual(putsFor(91002).length, 1, 'só o comentário do draft');
});

test('task em plan: grava spec-pending-approval no state.json (válido no schema) e retoma após "aprovado"', async () => {
    fs.writeFileSync(repairMode, 'ok');
    const { dir, taskId, specPath } = seedActiveTask(91003, NO_SOLUTION_SPEC);
    const r1 = await watcher.dispatchTicket(ticket(91003, FULL_SPEC));
    assert.strictEqual(r1.reason, 'spec_aguardando_aprovacao');
    const st = readState(dir);
    assert.strictEqual(st.status, 'spec-pending-approval');
    assert.strictEqual(st.spec_pending_approval.draft_path, 'memory/spec/91003-spec.draft.md');
    assert.ok(Number.isInteger(st.spec_pending_approval.comment_id));
    const check = readAndValidateState(taskId, { dir });
    assert.ok(check.valid, check.errors?.join('; '));
    assert.match(putsFor(91003)[0].body.issue.notes, /memory\/spec\/91003-spec\.md \(worktree do ticket\)/);
    assert.strictEqual(fs.readFileSync(specPath, 'utf8'), NO_SOLUTION_SPEC, 'spec intocada até aprovar');

    addJournal(91003, 'aprovado');
    const r2 = await watcher.dispatchTicket(ticket(91003, FULL_SPEC));
    assert.strictEqual(r2.action, 'dispatched');
    assert.match(fs.readFileSync(specPath, 'utf8'), /## Solução\n\nSugestão da IA/);
    assert.ok(!fs.existsSync(draftPath(91003)));
    assert.strictEqual(readState(dir).spec_pending_approval, undefined);
    assert.ok(await waitForClaudeCall(new RegExp(`/plan ${taskId}`)));
});

test('task: spec editada ainda inválida mantém pendência; editada válida segue sem comentário', async () => {
    fs.writeFileSync(repairMode, 'ok');
    const { dir, taskId, specPath } = seedActiveTask(91004, NO_SOLUTION_SPEC);
    await watcher.dispatchTicket(ticket(91004, FULL_SPEC));
    assert.strictEqual(readState(dir).status, 'spec-pending-approval');

    fs.writeFileSync(specPath, NO_SOLUTION_SPEC + '\nmais um detalhe qualquer\n');
    const r1 = await watcher.dispatchTicket(ticket(91004, FULL_SPEC));
    assert.strictEqual(r1.reason, 'spec_aguardando_aprovacao');
    assert.strictEqual(readState(dir).status, 'spec-pending-approval');
    assert.strictEqual(putsFor(91004).length, 1, 'sem comentário novo nem draft novo');

    fs.writeFileSync(specPath, FULL_SPEC);
    const r2 = await watcher.dispatchTicket(ticket(91004, FULL_SPEC));
    assert.strictEqual(r2.action, 'dispatched');
    assert.strictEqual(readState(dir).spec_pending_approval, undefined);
    assert.ok(!fs.existsSync(draftPath(91004)), 'draft obsoleto removido');
    assert.strictEqual(putsFor(91004).length, 1);
    assert.ok(await waitForClaudeCall(new RegExp(`/plan ${taskId}`)));
});

test('ticket vago / Claude falhou: draft com placeholder; aprovado segue mesmo com critérios pendentes', async () => {
    fs.writeFileSync(repairMode, 'fail');
    const vague = `## Problema\n${FILLER}${FILLER}${FILLER}\n`;
    const t = ticket(91005, vague);
    const r1 = await watcher.runTicketSpecGate(t);
    assert.strictEqual(r1.proceed, false);
    assert.ok(r1.pending);
    const draft = fs.readFileSync(draftPath(91005), 'utf8');
    assert.match(draft, /## Solução\n\nA definir — revisar com o responsável pelo ticket\./);
    assert.match(draft, /## Critérios de Aceite\n\n- A definir/);

    addJournal(91005, 'aprovado');
    const r2 = await watcher.runTicketSpecGate(t);
    assert.strictEqual(r2.proceed, true, 'aprovação vale como aceite do que sobrou');
    assert.strictEqual(r2.accepted, true);
    assert.deepStrictEqual(r2.result.errors.map(e => e.code), ['INSUFFICIENT_ACCEPTANCE_CRITERIA']);
    assert.strictEqual(watcher.readSpecGate(91005).status, 'accepted');
    const r3 = await watcher.runTicketSpecGate(t);
    assert.strictEqual(r3.proceed, true, 'não gera outro draft');
    assert.strictEqual(putsFor(91005).length, 1);
});

test('"aceito" depois do draft segue sem mesclar e apaga o draft', async () => {
    fs.writeFileSync(repairMode, 'ok');
    const t = ticket(91006, NO_SOLUTION_SPEC);
    await watcher.runTicketSpecGate(t);
    assert.ok(fs.existsSync(draftPath(91006)));
    addJournal(91006, 'aceito');
    const r = await watcher.runTicketSpecGate(t);
    assert.strictEqual(r.proceed, true);
    assert.strictEqual(r.approvedRepair, null);
    assert.ok(!fs.existsSync(draftPath(91006)));
    assert.ok(!fs.existsSync(path.join(repo, 'memory', 'spec', '91006-spec.md')));
    assert.strictEqual(watcher.readSpecGate(91006).status, 'accepted');
});

test('lembrete: uma vez só, depois de 48h sem resposta', async () => {
    fs.writeFileSync(repairMode, 'ok');
    const { dir } = seedActiveTask(91007, NO_SOLUTION_SPEC);
    await watcher.dispatchTicket(ticket(91007, FULL_SPEC));
    assert.strictEqual(putsFor(91007).length, 1);
    await watcher.dispatchTicket(ticket(91007, FULL_SPEC));
    assert.strictEqual(putsFor(91007).length, 1, 'antes de 48h, nada');

    const gate = watcher.readSpecGate(91007);
    gate.spec_pending_approval.posted_at = new Date(Date.now() - 49 * 3600 * 1000).toISOString();
    fs.writeFileSync(watcher.specGatePath(91007), JSON.stringify(gate));
    await watcher.dispatchTicket(ticket(91007, FULL_SPEC));
    assert.strictEqual(putsFor(91007).length, 2);
    assert.match(putsFor(91007)[1].body.issue.notes, /^\[Watcher\] Lembrete/);
    assert.strictEqual(readState(dir).spec_pending_approval.reminder_sent, true);
    await watcher.dispatchTicket(ticket(91007, FULL_SPEC));
    assert.strictEqual(putsFor(91007).length, 2, 'lembrete não se repete');
    assert.strictEqual(readState(dir).status, 'spec-pending-approval');
});

test('só TOO_SHORT (nenhuma seção pra gerar): cai no pedido de aceite antigo', async () => {
    const shortSpec = '## Problema\nx\n## Solução\ny\n## Critérios de Aceite\n- a\n- b\n';
    const calls = repairCount();
    const r = await watcher.runTicketSpecGate(ticket(91008, shortSpec));
    assert.strictEqual(r.proceed, false);
    assert.strictEqual(r.pending, null);
    assert.strictEqual(repairCount(), calls);
    assert.match(putsFor(91008)[0].body.issue.notes, /^\[Watcher\] Spec do ticket/);
});

test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
