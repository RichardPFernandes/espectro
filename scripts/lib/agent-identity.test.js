// node --test scripts/lib/agent-identity.test.js
// Agente vivo por identidade (pid + início do processo), não pelo texto `claude` no
// comando (PRI-70): processos reais — agente codex sob o wrapper sh do modo detached,
// binário renomeado, pid "reciclado" por outro claude, lease legado — e o C4 da PRI-62
// (agente vivo segura o redespacho; morto, é recuperado no mesmo nó) pelo watcher.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const tmp = fs.mkdtempSync(path.join(process.env.CLAUDE_JOB_DIR ? path.join(process.env.CLAUDE_JOB_DIR, 'tmp') : os.tmpdir(), 'agent-identity-'));
const repo = path.join(tmp, 'app-back');
const binDir = path.join(tmp, 'bin');
const claudeCalls = path.join(tmp, 'claude-calls.log');
fs.mkdirSync(repo, { recursive: true });
fs.mkdirSync(binDir);
// claude falso: registra a chamada e sai (o despacho de verdade só precisa do argv).
fs.writeFileSync(path.join(binDir, 'claude'), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${claudeCalls}'\n`, { mode: 0o755 });
fs.writeFileSync(path.join(binDir, 'codex'), '#!/bin/sh\nsleep 30\n', { mode: 0o755 });
fs.writeFileSync(path.join(binDir, 'osascript'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
fs.writeFileSync(path.join(binDir, 'agente-renomeado'), '#!/bin/sh\nsleep 30\n', { mode: 0o755 });
// "outro claude" de longa duração: o nome do binário contém claude, mas não é o agente.
fs.writeFileSync(path.join(binDir, 'claude-outro'), '#!/bin/sh\nsleep 30\n', { mode: 0o755 });
process.env.REPO_PATH = repo;
process.env.PLAN_SCORE_THRESHOLD = '0';
process.env.SKIP_PRE_BUILD_VALIDATION = 'true';
process.env.REDMINE_URL = 'http://redmine.test';
process.env.REDMINE_API_KEY = 'k';
process.env.PATH = `${binDir}:${process.env.PATH}`;
delete process.env.NODE_TIMEOUT_MS;
global.fetch = async () => ({ ok: true, status: 204, json: async () => ({}) });

const identity = require('./process-identity');
const lease = require('./node-lease');
const watcher = require('../readmine-watcher');

const HOUR = 60 * 60 * 1000;
const NODE_LEASE_SCRIPT = path.join(__dirname, 'node-lease.js');
const children = [];

function seed(id, node, extra = {}, { mainCheckout = false } = {}) {
    const taskId = `${id}-teste`;
    const dir = mainCheckout
        ? path.join(repo, 'memory', 'runs', taskId)
        : path.join(repo, '.claude', 'worktrees', String(id), 'memory', 'runs', taskId);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({
        task_id: taskId, node, history: ['fetch_ticket', 'plan'], status: 'in_progress',
        started_at: new Date().toISOString(), retries: {}, ...extra,
    }));
    fs.writeFileSync(path.join(dir, 'context.md'), '# Contexto\n');
    return { taskId, dir, runsDir: path.dirname(dir) };
}
const read = dir => JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'));

function ticket(id) {
    return {
        id, subject: `Ticket ${id}`, description: '', status: { name: 'Em Desenvolvimento' }, tracker: { name: 'Melhoria' },
        custom_fields: [{ name: 'Branch Liberação', value: 'Dev - Local' }], updated_on: new Date().toISOString(),
    };
}

async function waitFor(fn, ms = 5000) {
    for (const end = Date.now() + ms; Date.now() < end;) {
        if (fn()) return true;
        await new Promise(r => setTimeout(r, 50));
    }
    return false;
}

function track(child) { children.push(child); return child; }

// Mesmo wrapper do spawnAgent detached (readmine-watcher.js): sh roda o agente e, quando
// ele sai, `node node-lease.js release`. O pid gravado é o do sh.
function spawnWrapped(bin, l, args = []) {
    return track(spawn('/bin/sh', ['-c', `n=$1; l=$2; a=$3; shift 3; ${bin} "$@"; c=$?; "$n" "$l" release "$a" "$c"; exit $c`,
        'sh', process.execPath, NODE_LEASE_SCRIPT, JSON.stringify(l), ...args], { detached: true, stdio: 'ignore', env: process.env }));
}

function killTree(child) {
    try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch {} }
}

async function exited(child) {
    if (child.exitCode !== null || child.signalCode !== null) return;
    await new Promise(r => child.once('exit', r));
}

const claudeCalled = re => fs.existsSync(claudeCalls) && re.test(fs.readFileSync(claudeCalls, 'utf8'));

// --- process-identity -------------------------------------------------------------

test('processStartMs: início do próprio processo; pid inexistente é null', () => {
    const ms = identity.processStartMs(process.pid);
    assert.ok(ms <= Date.now() && Date.now() - ms < 10 * 60 * 1000, `início plausível (${ms})`);
    assert.strictEqual(identity.processStartMs(2 ** 22 + 4242), null);
    assert.strictEqual(identity.processStartIso(0), null);
});

test('sameProcess: mesmo início bate; outro início não; ps ilegível com pid vivo conta como o mesmo', () => {
    const iso = identity.processStartIso(process.pid);
    assert.strictEqual(identity.sameProcess(process.pid, iso), true);
    assert.strictEqual(identity.sameProcess(process.pid, Date.parse(iso) + 60_000), false);
    assert.strictEqual(identity.sameProcess(2 ** 22 + 4242, iso), false, 'pid morto nunca é o mesmo');
    assert.strictEqual(identity.sameProcess(process.pid, iso, { startOf: () => null }), true, 'sem como provar que é outro: segura');
});

// --- agentAlive por identidade ----------------------------------------------------

// Run no checkout principal: no worktree o JSON do lease no argv do wrapper carrega
// ".claude/worktrees/..." e a regra antiga casava "claude" pelo caminho, não pelo binário.
test('agente codex sob o wrapper sh: vivo enquanto roda (o comando não tem "claude"); morto depois', async () => {
    const { dir } = seed(97001, 'review', {}, { mainCheckout: true });
    const l = lease.acquireNode(dir, { node: 'review', timeoutMs: HOUR });
    const child = spawnWrapped('codex', l);
    lease.recordAgentPid(l, child.pid);
    const s = read(dir);
    assert.strictEqual(s.agent_pid, child.pid);
    assert.ok(s.agent_started_at, 'identidade gravada junto do pid');
    const command = require('child_process').execFileSync('ps', ['-p', String(child.pid), '-o', 'command='], { encoding: 'utf8' });
    const agentCommand = command.replace(NODE_LEASE_SCRIPT, '<node-lease>').replace(JSON.stringify(l), '<lease>');
    assert.doesNotMatch(agentCommand, /claude/,
        'pré-condição: a regra antiga (texto claude) daria falso negativo aqui');
    assert.strictEqual(lease.agentAlive(child.pid, s), true);
    assert.strictEqual(lease.orphanReason(s), null, 'vivo: não é órfão');
    killTree(child);
    await exited(child);
    assert.ok(await waitFor(() => !identity.pidExists(child.pid)));
    assert.strictEqual(lease.agentAlive(child.pid, s), false);
    assert.strictEqual(lease.orphanReason(s), 'agent_dead');
});

test('binário renomeado (sem claude/codex no nome): identidade segura igual', async () => {
    const { dir } = seed(97002, 'test');
    const l = lease.acquireNode(dir, { node: 'test', timeoutMs: HOUR });
    const child = track(spawn(path.join(binDir, 'agente-renomeado'), [], { detached: true, stdio: 'ignore' }));
    lease.recordAgentPid(l, child.pid);
    assert.strictEqual(lease.orphanReason(read(dir)), null);
    killTree(child);
    await exited(child);
});

test('pid reciclado por OUTRO claude: início diferente do gravado = agente morto (a regra antiga diria vivo)', async () => {
    const outro = track(spawn(path.join(binDir, 'claude-outro'), [], { detached: true, stdio: 'ignore' }));
    assert.ok(await waitFor(() => identity.processStartMs(outro.pid) != null));
    assert.match(require('child_process').execFileSync('ps', ['-p', String(outro.pid), '-o', 'command='], { encoding: 'utf8' }), /claude/);
    // O agente original tinha este pid e começou 10 min antes; o pid voltou pra outro claude.
    const originalStart = new Date(identity.processStartMs(outro.pid) - 10 * 60_000).toISOString();
    const state = { status: 'running', node: 'review', node_started_at: originalStart, node_timeout_ms: HOUR, agent_pid: outro.pid, agent_started_at: originalStart };
    assert.strictEqual(lease.agentAlive(outro.pid, state), false);
    assert.strictEqual(lease.orphanReason(state), 'agent_dead');
    killTree(outro);
    await exited(outro);
});

test('lease legado (sem agent_started_at): vivo se o processo nasceu na janela do despacho; antes do lease ou muito depois, não', () => {
    const start = identity.processStartMs(process.pid);
    const legacy = at => ({ status: 'running', node: 'review', node_started_at: new Date(at).toISOString(), node_timeout_ms: HOUR, agent_pid: process.pid });
    assert.strictEqual(lease.agentAlive(process.pid, legacy(start - 1000)), true, 'nasceu logo depois do acquire');
    assert.strictEqual(lease.agentAlive(process.pid, legacy(start + 60_000)), false, 'processo mais velho que o lease não é o agente');
    assert.strictEqual(lease.agentAlive(process.pid, legacy(start - lease.LEGACY_SPAWN_WINDOW_MS - 60_000)), false, 'nasceu muito depois do despacho: pid reciclado');
    assert.strictEqual(lease.agentAlive(2 ** 22 + 4242, legacy(start)), false);
});

test('release/acquire/recuperação limpam agent_started_at junto do agent_pid', async () => {
    const { dir } = seed(97003, 'implement');
    const l = lease.acquireNode(dir, { node: 'implement', timeoutMs: HOUR });
    lease.recordAgentPid(l, process.pid);
    assert.ok(read(dir).agent_started_at);
    assert.strictEqual(lease.releaseNode(l), true);
    assert.strictEqual(read(dir).agent_started_at, undefined);
    const { validateState } = require('../validate-state');
    assert.deepStrictEqual(validateState({ task_id: 'x', node: 'review', history: [], status: 'running', agent_pid: 1, agent_started_at: new Date().toISOString() }), { valid: true });
});

// --- C4 da PRI-62 pelo watcher ------------------------------------------------------

test('C4: agente (codex, wrapper sh) vivo bloqueia redespacho; morto sem release, é recuperado no MESMO nó', async () => {
    const { dir, taskId } = seed(97101, 'review');
    const l = lease.acquireNode(dir, { node: 'review', timeoutMs: HOUR });
    const child = spawnWrapped('codex', l);
    lease.recordAgentPid(l, child.pid);

    assert.deepStrictEqual(watcher.recoverOrphanedNodes().filter(r => r.taskId === taskId), [], 'vivo: a recuperação não mexe');
    const skip = await watcher.dispatchTicket(ticket(97101));
    assert.strictEqual(skip.reason, 'no_em_execucao');
    assert.strictEqual(skip.agentPid, child.pid);
    assert.strictEqual(read(dir).status, 'running');

    // Morre sem rodar o release (SIGKILL no grupo: wrapper + codex).
    killTree(child);
    await exited(child);
    assert.ok(await waitFor(() => !identity.pidExists(child.pid)));
    assert.strictEqual(read(dir).status, 'running', 'sem release: o lease ficou');

    const rec = watcher.recoverOrphanedNodes().filter(r => r.taskId === taskId);
    assert.deepStrictEqual(rec.map(r => [r.node, r.action, r.reason]), [['review', 'redispatch', 'agent_dead']]);
    assert.strictEqual(read(dir).node, 'review');
    assert.strictEqual((await watcher.dispatchTicket(ticket(97101))).action, 'dispatched');
    assert.ok(await waitFor(() => claudeCalled(new RegExp(`/review ${taskId}.*RECUPERAÇÃO`))), 'redespacho do mesmo nó, com nota de recuperação');
});

test('C4: agente que sai sozinho libera pelo wrapper (sem órfão nem redespacho duplicado)', async () => {
    const { dir, taskId } = seed(97102, 'review');
    const l = lease.acquireNode(dir, { node: 'review', timeoutMs: HOUR });
    const child = spawnWrapped('true', l);
    lease.recordAgentPid(l, child.pid);
    await exited(child);
    assert.ok(await waitFor(() => read(dir).status === 'in_progress'), 'release do wrapper');
    assert.strictEqual(read(dir).agent_started_at, undefined);
    assert.deepStrictEqual(watcher.recoverOrphanedNodes().filter(r => r.taskId === taskId), []);
});

test.after(() => {
    for (const c of children) killTree(c);
    fs.rmSync(tmp, { recursive: true, force: true });
});
