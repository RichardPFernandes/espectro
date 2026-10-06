// node --test scripts/lib/human-input.test.js
// Canal humano→agente (dashboard → human-input.md → watcher) contra um REPO_PATH
// sintético, fetch stubado e um binário `claude` falso no PATH.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(process.env.CLAUDE_JOB_DIR ? path.join(process.env.CLAUDE_JOB_DIR, 'tmp') : os.tmpdir(), 'human-input-'));
const repo = path.join(tmp, 'app-back');
const binDir = path.join(tmp, 'bin');
const claudeCalls = path.join(tmp, 'claude-calls.log');
fs.mkdirSync(repo, { recursive: true });
fs.mkdirSync(binDir);
// Intérprete de mensagem (claude -p --json-schema): responde o que interpFile tiver; sem arquivo, falha.
const interpFile = path.join(tmp, 'interp.json');
fs.writeFileSync(path.join(binDir, 'claude'), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${claudeCalls}'\n` +
    `case "$*" in *--json-schema*) [ -f '${interpFile}' ] && cat '${interpFile}' && exit 0; exit 1;; esac\n`, { mode: 0o755 });
fs.writeFileSync(path.join(binDir, 'osascript'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
process.env.REPO_PATH = repo;
// Portão de build pré-implement roda mvn de verdade — coberto em build-validator.test.js.
process.env.SKIP_PRE_BUILD_VALIDATION = 'true';
process.env.REDMINE_URL = 'http://redmine.test';
process.env.REDMINE_API_KEY = 'k';
process.env.PATH = `${binDir}:${process.env.PATH}`;
global.fetch = async () => ({ ok: true, status: 204, json: async () => ({}) });

const watcher = require('../readmine-watcher');

function seed(id, node, status = 'in_progress') {
    const taskId = `${id}-teste`;
    const dir = path.join(repo, '.claude', 'worktrees', String(id), 'memory', 'runs', taskId);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({
        task_id: taskId, node, history: ['fetch_ticket', 'plan'], status, started_at: new Date().toISOString(),
    }));
    fs.writeFileSync(path.join(dir, 'context.md'), '# Contexto\n');
    return { taskId, dir };
}

function ticket(id) {
    return {
        id, subject: `Ticket ${id}`, description: '', status: { name: 'Em Desenvolvimento' }, tracker: { name: 'Melhoria' },
        custom_fields: [{ name: 'Branch Liberação', value: 'Dev - Local' }], updated_on: new Date().toISOString(),
    };
}

async function waitForClaudeCall(pattern) {
    for (let i = 0; i < 50; i++) {
        if (fs.existsSync(claudeCalls) && pattern.test(fs.readFileSync(claudeCalls, 'utf8'))) return true;
        await new Promise(r => setTimeout(r, 50));
    }
    return false;
}

test('checkHumanInput: sem arquivo não faz nada', () => {
    const { dir } = seed(91000, 'implement');
    assert.strictEqual(watcher.checkHumanInput(dir), null);
    assert.strictEqual(fs.readFileSync(path.join(dir, 'context.md'), 'utf8'), '# Contexto\n');
});

test('checkHumanInput: injeta no context.md, registra em state.json e move pra processado', () => {
    const { dir } = seed(91001, 'implement');
    fs.writeFileSync(path.join(dir, 'human-input.md'), '## Human input — X\n\nuse a tabela nova\n');
    const content = watcher.checkHumanInput(dir);
    assert.match(content, /use a tabela nova/);
    assert.match(fs.readFileSync(path.join(dir, 'context.md'), 'utf8'), /\n---\n## Human input — X\n\nuse a tabela nova\n---\n$/);
    const state = JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'));
    assert.strictEqual(state.human_inputs.length, 1);
    assert.match(state.human_inputs[0].content, /use a tabela nova/);
    assert.strictEqual(state.node, 'implement', 'não mexe no resto do state');
    assert.ok(!fs.existsSync(path.join(dir, 'human-input.md')));
    assert.match(fs.readFileSync(path.join(dir, 'human-input.processed.md'), 'utf8'), /use a tabela nova/);

    // Segunda mensagem: acumula, não sobrescreve o processado.
    fs.writeFileSync(path.join(dir, 'human-input.md'), 'outra\n');
    watcher.checkHumanInput(dir);
    const again = JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'));
    assert.strictEqual(again.human_inputs.length, 2);
    const processed = fs.readFileSync(path.join(dir, 'human-input.processed.md'), 'utf8');
    assert.ok(processed.includes('use a tabela nova') && processed.includes('outra'));
});

test('checkHumanInput: recupera sobra de crash (*.processing)', () => {
    const { dir } = seed(91002, 'implement');
    fs.writeFileSync(path.join(dir, 'human-input.123.processing'), 'sobrou do crash\n');
    assert.match(watcher.checkHumanInput(dir), /sobrou do crash/);
    assert.ok(!fs.readdirSync(dir).some(f => f.endsWith('.processing')));
});

test('dispatchTicket: mensagem pendente é consumida entre nós e vai no prompt do próximo segmento', async () => {
    const { dir, taskId } = seed(91003, 'review');
    fs.writeFileSync(path.join(dir, 'human-input.md'), '## Human input — Y\n\nrevise o índice do filtro\n');
    const result = await watcher.dispatchTicket(ticket(91003));
    assert.strictEqual(result.action, 'dispatched');
    assert.ok(!fs.existsSync(path.join(dir, 'human-input.md')));
    assert.match(fs.readFileSync(path.join(dir, 'context.md'), 'utf8'), /revise o índice do filtro/);
    assert.ok(await waitForClaudeCall(new RegExp(`/review ${taskId}[\\s\\S]*revise o índice do filtro`)));
});

function setInterp(structured) {
    if (!structured) return fs.rmSync(interpFile, { force: true });
    fs.writeFileSync(interpFile, JSON.stringify({ type: 'result', is_error: false, total_cost_usd: 0.01, structured_output: {
        intent: 'resume', node: 'test', confidence: 0.95, understood: 'liberou o disco, pode seguir', instructions: '', question: '', ...structured,
    } }));
}
const interpCalls = () => (fs.existsSync(claudeCalls) ? fs.readFileSync(claudeCalls, 'utf8').split('\n').filter(l => l.includes('--json-schema')).length : 0);
const readState = dir => JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'));

test('dispatchTicket: task bloqueada sem intérprete disponível não consome (fica pro próximo despacho)', async () => {
    setInterp(null);
    const { dir } = seed(91004, 'implement', 'blocked');
    fs.writeFileSync(path.join(dir, 'human-input.md'), 'espera\n');
    const result = await watcher.dispatchTicket(ticket(91004));
    assert.strictEqual(result.reason, 'status_blocked');
    assert.ok(fs.existsSync(path.join(dir, 'human-input.md')));
    assert.strictEqual(readState(dir).human_input_interpretations, undefined, 'falha do intérprete não grava decisão');
});

test('dispatchTicket: task bloqueada sem mensagem nem chama o intérprete', async () => {
    setInterp({});
    const before = interpCalls();
    const { dir } = seed(91005, 'test', 'blocked');
    const result = await watcher.dispatchTicket(ticket(91005));
    assert.strictEqual(result.reason, 'status_blocked');
    assert.strictEqual(interpCalls(), before);
    assert.strictEqual(readState(dir).status, 'blocked');
});

test('dispatchTicket: mensagem clara destrava, consome e vai no prompt com o que foi entendido', async () => {
    setInterp({ instructions: 'rode a suíte completa' });
    const { dir, taskId } = seed(91006, 'test', 'blocked');
    const s = readState(dir); s.blocked_reason = 'disco cheio'; fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify(s));
    fs.writeFileSync(path.join(dir, '.watcher-notified.json'), JSON.stringify({ signature: 'test:blocked' }));
    fs.writeFileSync(path.join(dir, 'human-input.md'), '## Human input — Z\n\nliberado espaço, pode seguir\n');
    const result = await watcher.dispatchTicket(ticket(91006));
    assert.strictEqual(result.action, 'dispatched');
    const state = readState(dir);
    assert.strictEqual(state.blocked_reason, undefined);
    assert.strictEqual(state.unblocked.blocked_reason, 'disco cheio');
    assert.strictEqual(state.human_input_interpretations.at(-1).action, 'resume');
    assert.ok(state.events.some(e => e.type === 'human_input_interpreted'), 'evento preservado depois dos portões');
    assert.ok(!fs.existsSync(path.join(dir, 'human-input.md')), 'consumida no despacho');
    assert.ok(!fs.existsSync(path.join(dir, '.watcher-notified.json')), 'novo bloqueio volta a notificar');
    assert.ok(await waitForClaudeCall(new RegExp(`/test ${taskId}[\\s\\S]*liberado espaço[\\s\\S]*O orquestrador entendeu: liberou o disco[\\s\\S]*rode a suíte completa`)));
});

test('dispatchTicket: mensagem pode retomar em outro nó', async () => {
    setInterp({ node: 'verify', understood: 'aceita a suíte focada e segue pro verify' });
    const { dir, taskId } = seed(91007, 'test', 'blocked');
    fs.writeFileSync(path.join(dir, 'human-input.md'), 'aceito a suíte focada, segue\n');
    const result = await watcher.dispatchTicket(ticket(91007));
    assert.strictEqual(result.action, 'dispatched');
    assert.strictEqual(readState(dir).unblocked.from_node, 'test');
    assert.ok(await waitForClaudeCall(new RegExp(`/verify ${taskId}`)));
});

test('dispatchTicket: mensagem ambígua não destrava, não consome e não é reinterpretada no tick seguinte', async () => {
    setInterp({ intent: 'unclear', confidence: 0.4, understood: 'quer continuar, mas não disse como', question: 'Rodo o /test de novo ou sigo pro /verify?' });
    const { dir } = seed(91008, 'test', 'blocked');
    fs.writeFileSync(path.join(dir, 'human-input.md'), 'ok\n');
    const before = interpCalls();
    const first = await watcher.dispatchTicket(ticket(91008));
    assert.strictEqual(first.reason, 'status_blocked');
    const state = readState(dir);
    assert.strictEqual(state.status, 'blocked');
    assert.strictEqual(state.human_input_interpretations.at(-1).action, 'ask');
    assert.match(state.human_input_interpretations.at(-1).reply, /Rodo o \/test de novo ou sigo pro \/verify\?/);
    assert.ok(fs.existsSync(path.join(dir, 'human-input.md')), 'mensagem continua na fila');

    await watcher.dispatchTicket(ticket(91008));
    assert.strictEqual(interpCalls(), before + 1, 'mesma mensagem não chama o intérprete de novo');

    // Resposta nova: interpretada junto com a anterior e com a pergunta feita.
    fs.appendFileSync(path.join(dir, 'human-input.md'), 'roda o test de novo\n');
    setInterp({ understood: 'rodar o /test de novo' });
    const third = await watcher.dispatchTicket(ticket(91008));
    assert.strictEqual(third.action, 'dispatched');
    const calls = fs.readFileSync(claudeCalls, 'utf8');
    assert.match(calls, /Pergunta feita ao desenvolvedor: Rodo o \/test de novo ou sigo pro \/verify\?/);
});

test('dispatchTicket: "pode seguir" com confiança baixa pede confirmação em vez de retomar', async () => {
    setInterp({ confidence: 0.5 });
    const { dir } = seed(91009, 'test', 'blocked');
    fs.writeFileSync(path.join(dir, 'human-input.md'), 'acho que dá\n');
    const result = await watcher.dispatchTicket(ticket(91009));
    assert.strictEqual(result.reason, 'status_blocked');
    assert.match(readState(dir).human_input_interpretations.at(-1).reply, /Confirma que é pra retomar em \/test\?/);
});

test('dispatchTicket: task escalated também destrava pela mensagem e zera o retry do nó que escalou', async () => {
    // review e não plan: plan passa pelo portão de spec, que o run sintético não satisfaz.
    setInterp({ node: 'review', understood: 'revisar de novo depois do ajuste' });
    const { dir, taskId } = seed(91010, 'verify', 'escalated');
    const s = readState(dir); s.retries = { verify: 2, review: 1 }; fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify(s));
    fs.writeFileSync(path.join(dir, 'human-input.md'), 'pode numerar os critérios e ajustar ao padrão novo do workflow\n');
    const result = await watcher.dispatchTicket(ticket(91010));
    assert.strictEqual(result.action, 'dispatched');
    const state = readState(dir);
    assert.deepStrictEqual(state.retries, { verify: 0, review: 1 });
    assert.deepStrictEqual(state.unblocked.retries_before, { verify: 2 });
    assert.strictEqual(state.unblocked.from_status, 'escalated');
    assert.ok(await waitForClaudeCall(new RegExp(`/review ${taskId}[\\s\\S]*A task estava "escalated" no nó "verify"`)));
    assert.match(fs.readFileSync(claudeCalls, 'utf8'), /status "escalated" no nó "verify"/, 'intérprete sabe que é escalada');
});

test('dispatchTicket: node "escalated" (formato antigo) interpreta a partir do último nó do history', async () => {
    setInterp({ intent: 'hold', understood: 'vai olhar depois' });
    const { dir } = seed(91011, 'escalated', 'escalated');
    fs.writeFileSync(path.join(dir, 'human-input.md'), 'deixa que eu vejo\n');
    const result = await watcher.dispatchTicket(ticket(91011));
    assert.strictEqual(result.reason, 'status_escalated');
    assert.strictEqual(readState(dir).human_input_interpretations.at(-1).from_node, 'plan');
});

function seedRejected(id) {
    const seeded = seed(id, 'implement', 'spec-change-rejected');
    const s = readState(seeded.dir);
    s.spec_change_rejected = { id: 'SC-001', rejector: 'Fulano', proposed_behavior: 'reprocessar registros Em Fila' };
    fs.writeFileSync(path.join(seeded.dir, 'state.json'), JSON.stringify(s));
    return seeded;
}

test('dispatchTicket: spec-change-rejected destrava pela mensagem e o intérprete recebe a proposta recusada', async () => {
    setInterp({ node: 'implement', understood: 'ignorar o ponto 2 e corrigir só o ponto 1' });
    const { dir } = seedRejected(91013);
    fs.writeFileSync(path.join(dir, 'human-input.md'), 'pode ignorar o segundo ponto e seguir com a correção do primeiro apenas\n');
    // O despacho em si para nos portões do /implement (plano/spec), que o run sintético não
    // satisfaz (o portão de plano ainda manda o run para re-plan): aqui só importa que a task
    // saiu da pausa retomando no implement.
    await watcher.dispatchTicket(ticket(91013));
    const state = readState(dir);
    assert.notStrictEqual(state.status, 'spec-change-rejected');
    assert.deepStrictEqual([state.unblocked.from_status, state.unblocked.from_node], ['spec-change-rejected', 'implement']);
    assert.deepStrictEqual([state.human_input_interpretations.at(-1).action, state.human_input_interpretations.at(-1).node], ['resume', 'implement']);
    assert.match(fs.readFileSync(claudeCalls, 'utf8'), /SPEC_CHANGE SC-001 e um humano a REJEITOU \(Fulano\)[\s\S]*reprocessar registros Em Fila/);
});

test('dispatchTicket: spec-change-rejected com mensagem que não autoriza seguir continua pausada', async () => {
    setInterp({ intent: 'hold', understood: 'quer a mudança recusada mesmo assim' });
    const { dir } = seedRejected(91014);
    fs.writeFileSync(path.join(dir, 'human-input.md'), 'faz o reprocessamento do Em Fila também\n');
    const result = await watcher.dispatchTicket(ticket(91014));
    assert.strictEqual(result.reason, 'spec_change_rejeitada');
    const state = readState(dir);
    assert.strictEqual(state.status, 'spec-change-rejected');
    assert.strictEqual(state.human_input_interpretations.at(-1).action, 'hold');
    assert.ok(fs.existsSync(path.join(dir, 'human-input.md')), 'mensagem fica na fila');
});

test('dispatchTicket: needs_human_review continua manual (nem chama o intérprete)', async () => {
    setInterp({});
    const before = interpCalls();
    const { dir } = seed(91012, 'commit', 'needs_human_review');
    fs.writeFileSync(path.join(dir, 'human-input.md'), 'pode seguir\n');
    const result = await watcher.dispatchTicket(ticket(91012));
    assert.strictEqual(result.reason, 'status_needs_human_review');
    assert.strictEqual(interpCalls(), before);
    assert.ok(fs.existsSync(path.join(dir, 'human-input.md')));
});
