// node --test scripts/lib/node-lease.test.js
// Lease de nó em execução + recuperação de nó órfão: unidade de node-lease.js e
// integração com o watcher (dispatchTicket/recoverOrphanedNodes) contra um REPO_PATH
// sintético, fetch stubado e um binário `claude` falso no PATH.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(process.env.CLAUDE_JOB_DIR ? path.join(process.env.CLAUDE_JOB_DIR, 'tmp') : os.tmpdir(), 'node-lease-'));
const repo = path.join(tmp, 'app-back');
const binDir = path.join(tmp, 'bin');
const claudeCalls = path.join(tmp, 'claude-calls.log');
fs.mkdirSync(repo, { recursive: true });
fs.mkdirSync(binDir);
fs.writeFileSync(path.join(binDir, 'claude'), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${claudeCalls}'\n`, { mode: 0o755 });
fs.writeFileSync(path.join(binDir, 'osascript'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
process.env.REPO_PATH = repo;
// Portão do plano (runPlanGate) fora do escopo: estes seeds não têm handoff.md — threshold 0 aprova qualquer plano.
process.env.PLAN_SCORE_THRESHOLD = '0';
// Portão de build pré-implement roda mvn de verdade — coberto em build-validator.test.js.
process.env.SKIP_PRE_BUILD_VALIDATION = 'true';
process.env.REDMINE_URL = 'http://redmine.test';
process.env.REDMINE_API_KEY = 'k';
process.env.PATH = `${binDir}:${process.env.PATH}`;
delete process.env.NODE_TIMEOUT_MS;
global.fetch = async () => ({ ok: true, status: 204, json: async () => ({}) });

const lease = require('./node-lease');
const watcher = require('../readmine-watcher');
const stateWriter = require('../state-writer');
const { validateState } = require('../validate-state');

const HOUR = 60 * 60 * 1000;
const dead = () => false;

function seed(id, node, extra = {}) {
    const taskId = `${id}-teste`;
    const dir = path.join(repo, '.claude', 'worktrees', String(id), 'memory', 'runs', taskId);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({
        task_id: taskId, node, history: ['fetch_ticket', 'plan'], status: 'in_progress',
        started_at: new Date().toISOString(), retries: { review: 1 }, ...extra,
    }));
    fs.writeFileSync(path.join(dir, 'context.md'), '# Contexto\n');
    return { taskId, dir, runsDir: path.dirname(dir) };
}

const read = dir => JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'));
const ago = ms => new Date(Date.now() - ms).toISOString();

function ticket(id) {
    return {
        id, subject: `Ticket ${id}`, description: '', status: { name: 'Em Desenvolvimento' }, tracker: { name: 'Melhoria' },
        custom_fields: [{ name: 'Branch Liberação', value: 'Dev - Local' }], updated_on: new Date().toISOString(),
    };
}

async function waitFor(fn) {
    for (let i = 0; i < 100; i++) {
        if (fn()) return true;
        await new Promise(r => setTimeout(r, 50));
    }
    return false;
}

const claudeCalled = re => fs.existsSync(claudeCalls) && re.test(fs.readFileSync(claudeCalls, 'utf8'));

// --- unidade -------------------------------------------------------------------

test('resolveNodeTimeoutMs: padrão 60 min, env válida sobrescreve, inválida cai no padrão', () => {
    assert.strictEqual(lease.resolveNodeTimeoutMs({}), HOUR);
    assert.strictEqual(lease.DEFAULT_NODE_TIMEOUT_MS, HOUR);
    assert.strictEqual(lease.resolveNodeTimeoutMs({ NODE_TIMEOUT_MS: '1800000' }), 1800000);
    assert.strictEqual(lease.resolveNodeTimeoutMs({ NODE_TIMEOUT_MS: 'abc' }), HOUR);
    assert.strictEqual(lease.resolveNodeTimeoutMs({ NODE_TIMEOUT_MS: '0' }), HOUR);
});

test('isOrphan: só running + node_started_at + passou do timeout + agente morto', () => {
    const base = { status: 'running', node_started_at: ago(2 * HOUR), node_timeout_ms: HOUR };
    assert.strictEqual(lease.isOrphan(base, { isAlive: dead }), true);
    assert.strictEqual(lease.isOrphan({ ...base, node_started_at: ago(HOUR - 60000) }, { isAlive: dead }), false);
    assert.strictEqual(lease.isOrphan({ ...base, status: 'in_progress' }, { isAlive: dead }), false);
    assert.strictEqual(lease.isOrphan({ ...base, node_started_at: undefined }, { isAlive: dead }), false);
    assert.strictEqual(lease.isOrphan({ ...base, agent_pid: 123 }, { isAlive: () => true }), false, 'agente vivo nunca é órfão');
    // Timeout gravado no state é o que vale (auditável), não o default do processo.
    assert.strictEqual(lease.isOrphan({ ...base, node_timeout_ms: 3 * HOUR }, { isAlive: dead }), false);
    assert.strictEqual(lease.isOrphan({ ...base, node_timeout_ms: undefined }, { isAlive: dead, defaultTimeoutMs: HOUR }), true);
});

test('orphanReason: pid gravado e morto é órfão na hora, sem esperar o timeout; vivo segura mesmo passado o prazo', () => {
    const fresh = { status: 'running', node_started_at: ago(5 * 60000), node_timeout_ms: HOUR };
    assert.strictEqual(lease.orphanReason({ ...fresh, agent_pid: 123 }, { isAlive: dead }), 'agent_dead');
    assert.strictEqual(lease.orphanReason({ ...fresh, agent_pid: 123 }, { isAlive: () => true }), null);
    assert.strictEqual(lease.orphanReason(fresh, { isAlive: dead }), null, 'sem pid, dentro do prazo: espera');
    const old = { ...fresh, node_started_at: ago(3 * HOUR) };
    assert.strictEqual(lease.orphanReason(old, { isAlive: dead }), 'timeout');
    assert.strictEqual(lease.orphanReason({ ...old, agent_pid: 123 }, { isAlive: () => true }), null);
});

test('describeRunning: mostra início, tempo decorrido, limite e se o pid está vivo', () => {
    const now = Date.parse('2026-09-25T17:33:00Z');
    const s = { node_started_at: '2026-09-25T17:03:00.000Z', node_timeout_ms: HOUR, agent_pid: 95430 };
    assert.strictEqual(lease.describeRunning(s, { now, isAlive: () => true }),
        'desde 2026-09-25T17:03:00.000Z (30 min de 60 min, pid 95430 vivo)');
    assert.match(lease.describeRunning(s, { now, isAlive: dead }), /pid 95430 MORTO/);
    assert.match(lease.describeRunning({ node_started_at: s.node_started_at }, { now }), /\(30 min, sem pid gravado\)/);
});

test('agentAlive: pid inexistente é morto; pid vivo com outro início (reciclado) também — identidade, não o texto do comando', () => {
    assert.strictEqual(lease.agentAlive(undefined), false);
    assert.strictEqual(lease.agentAlive(2 ** 22 + 12345), false);
    assert.strictEqual(lease.agentAlive(2 ** 22 + 12345, { agent_started_at: new Date().toISOString() }), false);
    const mine = require('./process-identity').processStartIso(process.pid);
    assert.strictEqual(lease.agentAlive(process.pid, { agent_started_at: mine }), true, 'mesmo processo, mesmo início: vivo (não é claude e não importa)');
    assert.strictEqual(lease.agentAlive(process.pid, { agent_started_at: '2020-01-01T00:00:00.000Z' }), false, 'pid reciclado');
});

test('clearFetchDispatch: remove só o marcador deste despacho e preserva o resto do gate', () => {
    const gatePath = path.join(tmp, '99100-spec-gate.json');
    const at = new Date().toISOString();
    fs.writeFileSync(gatePath, JSON.stringify({ ticket_id: 99100, status: 'valid', fetch_dispatch: { started_at: at, timeout_ms: HOUR } }));
    assert.strictEqual(lease.clearFetchDispatch(gatePath, ago(1000)), false, 'outro despacho: não mexe');
    assert.ok(JSON.parse(fs.readFileSync(gatePath, 'utf8')).fetch_dispatch);
    assert.strictEqual(lease.clearFetchDispatch(gatePath, at), true);
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(gatePath, 'utf8')), { ticket_id: 99100, status: 'valid' });
    assert.strictEqual(lease.clearFetchDispatch(path.join(tmp, 'nao-existe.json'), at), false);
    assert.strictEqual(lease.clearFetchDispatch(undefined, at), false);
});

test('acquire/release: running com node_started_at, release volta pra in_progress', () => {
    const { dir } = seed(92001, 'implement');
    const l = lease.acquireNode(dir, { node: 'implement', timeoutMs: HOUR });
    let s = read(dir);
    assert.strictEqual(s.status, 'running');
    assert.strictEqual(s.node_started_at, l.startedAt);
    assert.strictEqual(s.node_timeout_ms, HOUR);
    lease.recordAgentPid(l, 4242);
    assert.strictEqual(read(dir).agent_pid, 4242);
    assert.strictEqual(lease.releaseNode(l), true);
    s = read(dir);
    assert.strictEqual(s.status, 'in_progress');
    assert.strictEqual(s.node_started_at, l.startedAt, 'node_started_at fica pra auditoria');
    assert.strictEqual(s.agent_pid, undefined);
});

test('recordAgentPid tardio após release não restaura a identidade do agente', () => {
    const { dir } = seed(92011, 'implement');
    const l = lease.acquireNode(dir, { node: 'implement', timeoutMs: HOUR });
    assert.strictEqual(lease.releaseNode(l), true);

    lease.recordAgentPid(l, 4242, { startOf: () => '2026-10-26T20:00:00.000Z' });

    const s = read(dir);
    assert.strictEqual(s.status, 'in_progress');
    assert.strictEqual(s.agent_pid, undefined);
    assert.strictEqual(s.agent_started_at, undefined);
});

test('recordAgentPid de uma execução antiga não grava na execução atual', () => {
    const { dir } = seed(92012, 'implement');
    const l = lease.acquireNode(dir, { node: 'implement', timeoutMs: HOUR });
    const currentExecutionId = stateWriter.newExecutionId();
    stateWriter.update(dir, s => { s.execution_id = currentExecutionId; }, {
        operation: 'test_execution_takeover', actor: 'test',
    });

    lease.recordAgentPid(l, 4242, { startOf: () => '2026-10-26T20:00:00.000Z' });

    const s = read(dir);
    assert.strictEqual(s.status, 'running');
    assert.strictEqual(s.execution_id, currentExecutionId);
    assert.strictEqual(s.agent_pid, undefined);
    assert.strictEqual(s.agent_started_at, undefined);
});

test('release não sobrescreve status gravado pelo comando nem lease de outro despacho', () => {
    const { dir } = seed(92002, 'implement');
    const l = lease.acquireNode(dir, { node: 'implement', timeoutMs: HOUR });
    fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ ...read(dir), status: 'blocked' }));
    assert.strictEqual(lease.releaseNode(l), false);
    assert.strictEqual(read(dir).status, 'blocked');

    const l2 = lease.acquireNode(dir, { node: 'implement', timeoutMs: HOUR, now: new Date(Date.now() + 1000) });
    assert.strictEqual(lease.releaseNode(l), false, 'lease antigo não libera o novo');
    assert.strictEqual(read(dir).status, 'running');
    assert.strictEqual(lease.releaseNode(l2), true);
});

test('recoverOrphans: nó comum órfão volta pra in_progress com evento node_error, sem mexer em retries', () => {
    const { dir, runsDir } = seed(92003, 'test', { status: 'running', node_started_at: ago(2 * HOUR), node_timeout_ms: HOUR, agent_pid: 99999 });
    const res = lease.recoverOrphans([runsDir], { isAlive: dead });
    assert.deepStrictEqual(res.map(r => [r.node, r.action, r.reason]), [['test', 'redispatch', 'agent_dead']]);
    const s = read(dir);
    assert.strictEqual(s.status, 'in_progress');
    assert.strictEqual(s.node, 'test', 'não volta ao início do ciclo');
    assert.deepStrictEqual(s.retries, { review: 1 });
    assert.strictEqual(s.agent_pid, undefined);
    assert.strictEqual(s.events.at(-1).type, 'node_error');
    assert.strictEqual(s.events.at(-1).detail, 'Nó órfão detectado pelo watcher (agente (pid 99999) saiu sem liberar o nó) — redespachando');
    assert.strictEqual(s.recovered_from_orphan.node, 'test');
    assert.match(lease.recoveryNote(s), /RECUPERAÇÃO/);
});

test('recoverOrphans: commit órfão escala (needs_human_review + escalation), não redespacha', () => {
    const { dir, runsDir } = seed(92004, 'commit', { status: 'running', node_started_at: ago(2 * HOUR), node_timeout_ms: HOUR });
    const res = lease.recoverOrphans([runsDir], { isAlive: dead });
    assert.deepStrictEqual(res.map(r => r.action), ['escalated']);
    const s = read(dir);
    assert.strictEqual(s.status, 'needs_human_review');
    assert.strictEqual(s.events.at(-1).type, 'escalation');
    assert.strictEqual(s.recovered_from_orphan, undefined);
});

test('recoverOrphans: running dentro do prazo, dry-run e filtro não gravam nada', () => {
    const fresh = seed(92005, 'review', { status: 'running', node_started_at: ago(10 * 60000), node_timeout_ms: HOUR });
    assert.deepStrictEqual(lease.recoverOrphans([fresh.runsDir], { isAlive: dead }), []);
    assert.strictEqual(read(fresh.dir).status, 'running');

    const old = seed(92006, 'review', { status: 'running', node_started_at: ago(2 * HOUR), node_timeout_ms: HOUR });
    assert.strictEqual(lease.recoverOrphans([old.runsDir], { isAlive: dead, dryRun: true }).length, 1);
    assert.strictEqual(read(old.dir).status, 'running');
    assert.strictEqual(lease.recoverOrphans([old.runsDir], { isAlive: dead, filter: () => false }).length, 0);
    assert.strictEqual(read(old.dir).status, 'running');
});

test('recoverOrphans: agente morto dentro do prazo é recuperado já, não depois de 60 min', () => {
    const { dir, runsDir } = seed(92007, 'test', { status: 'running', node_started_at: ago(10 * 60000), node_timeout_ms: HOUR, agent_pid: 4242 });
    assert.deepStrictEqual(lease.recoverOrphans([runsDir], { isAlive: () => true }), [], 'vivo: não mexe');
    assert.strictEqual(read(dir).status, 'running');
    const res = lease.recoverOrphans([runsDir], { isAlive: dead });
    assert.deepStrictEqual(res.map(r => [r.action, r.reason]), [['redispatch', 'agent_dead']]);
    assert.strictEqual(read(dir).status, 'in_progress');
});

test('schema aceita os campos/status novos (running, needs_human_review, events)', () => {
    const s = {
        task_id: 'x-1', node: 'commit', history: [], status: 'running',
        node_started_at: new Date().toISOString(), node_timeout_ms: HOUR, agent_pid: 1,
        events: [{ type: 'escalation', node: 'commit', at: new Date().toISOString(), detail: 'd' }],
        recovered_from_orphan: { node: 'test', orphan_since: ago(HOUR), detected_at: new Date().toISOString() },
    };
    assert.deepStrictEqual(validateState(s), { valid: true });
    assert.deepStrictEqual(validateState({ ...s, status: 'needs_human_review' }), { valid: true });
});

// --- integração com o watcher --------------------------------------------------

test('dispatchTicket: grava node_started_at/node_timeout_ms/running e o wrapper libera quando o claude sai', async () => {
    const { dir, taskId } = seed(92101, 'implement');
    const result = await watcher.dispatchTicket(ticket(92101));
    assert.strictEqual(result.action, 'dispatched');
    const s = read(dir);
    assert.ok(s.node_started_at, 'node_started_at presente depois do despacho');
    assert.strictEqual(s.node_timeout_ms, watcher.NODE_TIMEOUT_MS);
    assert.ok(await waitFor(() => claudeCalled(new RegExp(`/implement ${taskId}`))));
    assert.ok(await waitFor(() => read(dir).status === 'in_progress'), 'release do wrapper devolve pra in_progress');
    assert.strictEqual(read(dir).node_started_at, s.node_started_at);
    // A CLI de release grava em duas etapas: releaseNode (in_progress) e só depois
    // fulfillOnExit (Attempt). Ver in_progress não garante o Attempt já cumprido.
    const executeNodeStatus = () => {
        const attemptDir = path.join(dir, 'dom06', 'attempts');
        const attemptName = fs.readdirSync(attemptDir).find(name => name.endsWith('.json'));
        const attempt = JSON.parse(fs.readFileSync(path.join(attemptDir, attemptName), 'utf8'));
        return attempt.obligations.find(item => item.id === 'execute_node').status;
    };
    await waitFor(() => executeNodeStatus() === 'fulfilled');
    assert.strictEqual(executeNodeStatus(), 'fulfilled', 'fulfillOnExit do wrapper não cumpriu execute_node no Attempt em 5 s após o release');
});

test('dispatchTicket: running dentro do prazo não redespacha; needs_human_review também não', async () => {
    const since = ago(60000);
    seed(92102, 'review', { status: 'running', node_started_at: since, node_timeout_ms: HOUR, agent_pid: 4343 });
    const skip = await watcher.dispatchTicket(ticket(92102));
    assert.strictEqual(skip.reason, 'no_em_execucao');
    assert.strictEqual(skip.agentPid, 4343, 'o skip diz qual agente segura o nó');
    assert.strictEqual(skip.since, since);
    seed(92103, 'commit', { status: 'needs_human_review' });
    assert.strictEqual((await watcher.dispatchTicket(ticket(92103))).reason, 'status_needs_human_review');
});

test('startup: órfão é recuperado e redespachado no MESMO nó, com nota de recuperação; commit órfão só escala', async () => {
    const orphan = seed(92201, 'verify', { status: 'running', node_started_at: ago(3 * HOUR), node_timeout_ms: HOUR, agent_pid: 2 ** 22 + 777 });
    const commit = seed(92202, 'commit', { status: 'running', node_started_at: ago(3 * HOUR), node_timeout_ms: HOUR });
    const res = watcher.recoverOrphanedNodes();
    const byTask = Object.fromEntries(res.map(r => [r.taskId, r.action]));
    assert.strictEqual(byTask[orphan.taskId], 'redispatch');
    assert.strictEqual(byTask[commit.taskId], 'escalated');
    assert.ok(watcher.findLocallyActiveTicketIds().includes(92201), 'tick reidrata o ticket recuperado');

    assert.strictEqual((await watcher.dispatchTicket(ticket(92201))).action, 'dispatched');
    assert.ok(await waitFor(() => claudeCalled(new RegExp(`/verify ${orphan.taskId}.*RECUPERAÇÃO`))));
    // O wrapper detached ainda roda `node-lease.js release` depois que o claude sai: releaseNode
    // (state.json → in_progress), recordNodeExit (state.json, eventos) e por último fulfillOnExit
    // (mkdir + rename do Attempt em dom06/attempts). Esperar o Attempt `fulfilled` cobre a cadeia
    // inteira; sem isso, o test.after apaga o diretório do run enquanto o release ainda escreve
    // nele (ENOTEMPTY intermitente). Mesmo padrão do teste 92101.
    assert.ok(await waitFor(() => read(orphan.dir).status === 'in_progress'), 'release do wrapper do redespacho recuperado devolve pra in_progress');
    const executeNodeStatus = () => {
        const attemptDir = path.join(orphan.dir, 'dom06', 'attempts');
        if (!fs.existsSync(attemptDir)) return null;
        const attemptName = fs.readdirSync(attemptDir).find(name => name.endsWith('.json'));
        if (!attemptName) return null;
        const attempt = JSON.parse(fs.readFileSync(path.join(attemptDir, attemptName), 'utf8'));
        return attempt.obligations.find(item => item.id === 'execute_node').status;
    };
    assert.ok(await waitFor(() => executeNodeStatus() === 'fulfilled'), 'fulfillOnExit do wrapper não cumpriu execute_node no Attempt do redespacho recuperado em 5 s após o release');
    assert.strictEqual(read(orphan.dir).recovered_from_orphan, undefined, 'marcador consumido no redespacho');

    assert.strictEqual((await watcher.dispatchTicket(ticket(92202))).reason, 'status_needs_human_review');
    assert.ok(!claudeCalled(new RegExp(`/commit ${commit.taskId}`)));
});

// O wrapper destacado do último despacho pode ainda estar gravando o state (release +
// eventos) quando o hook roda; sem retry o rm falhava com ENOTEMPTY sob carga (PRI-233).
test.after(() => fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }));
