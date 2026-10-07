// node --test scripts/lib/cycle-replayer.test.js
// Replay de ciclo (scripts/lib/cycle-replayer.js + scripts/replay-cycle.js) contra um
// REPO_PATH sintético, fetch stubado e um binário `claude` falso no PATH — o despacho
// de ponta a ponta passa pelo dispatchTicket de verdade do watcher.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const tmp = fs.mkdtempSync(path.join(process.env.CLAUDE_JOB_DIR ? path.join(process.env.CLAUDE_JOB_DIR, 'tmp') : os.tmpdir(), 'cycle-replayer-'));
const repo = path.join(tmp, 'app-back');
const binDir = path.join(tmp, 'bin');
const claudeCalls = path.join(tmp, 'claude-calls.log');
fs.mkdirSync(repo, { recursive: true });
fs.mkdirSync(binDir);
fs.writeFileSync(path.join(binDir, 'claude'), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${claudeCalls}'\n`, { mode: 0o755 });
fs.writeFileSync(path.join(binDir, 'osascript'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
process.env.REPO_PATH = repo;
process.env.SKIP_PRE_BUILD_VALIDATION = 'true';
process.env.REDMINE_URL = 'http://redmine.test';
process.env.REDMINE_API_KEY = 'k';
process.env.PATH = `${binDir}:${process.env.PATH}`;
const redmineCalls = [];
global.fetch = async (url, init = {}) => {
    redmineCalls.push({ url: String(url), method: init.method || 'GET', body: init.body ? JSON.parse(init.body) : null });
    // GET do ticket sem issue: o node-dispatcher cai no redmine_ticket do state.json.
    return { ok: true, status: 204, json: async () => ({}) };
};

const replayer = require('./cycle-replayer');
const dispatcher = require('./node-dispatcher');
const watcher = require('../readmine-watcher');

const registered = { worktreeRegistered: () => true };
const FULL_HISTORY = ['fetch_ticket', 'plan', 'implement', 'review', 'test'];

function runsDirOf(id) {
    return path.join(repo, '.claude', 'worktrees', String(id), 'memory', 'runs');
}

// Ciclo que falhou no test (test reprovou 2x e escalou): plan/implement/review válidos.
function seedFailedAtTest(id, name = 'task-42', extra = {}) {
    const taskId = `${id}-${name}`;
    const dir = path.join(runsDirOf(id), taskId);
    fs.mkdirSync(path.join(dir, 'screenshots'), { recursive: true });
    const state = {
        task_id: taskId, node: 'test', status: 'escalated',
        history: FULL_HISTORY,
        retries: { review: 1, test: 2 },
        started_at: '2026-09-20T10:00:00Z', updated_at: '2026-09-20T12:00:00Z',
        current_agent: 'claude',
        selected_context: ['memory/spec/x.md'], scope: 'escopo do plan',
        planScore: 88, review_verdict: 'aprovado', test_result: 'falhou',
        node_started_at: '2026-09-20T11:00:00Z', node_timeout_ms: 1000, agent_pid: 123,
        cost_tracking: { nodes: {}, totals: { loop_count: 3 } },
        handoff_path: `memory/runs/${taskId}/handoff.md`,
        redmine_ticket: { id, subject: `Ticket ${id}`, tracker: 'Melhoria', base_branch: 'development' },
        ...extra,
    };
    fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify(state, null, 2));
    const files = {
        'context.md': '# Contexto\nplan, implement, review, test falhou\n',
        'handoff.md': '# Handoff para o verify\n',
        'plan.md': 'plano\n',
        'codex-result-implement.md': 'impl\n',
        'review.md': 'aprovado\n',
        'test-results.md': 'FALHOU\n',
        'codex-result-test.md': 'falhou\n',
        'verify-checklist.md': 'nunca chegou aqui mas se tivesse\n',
        '.watcher-notified.json': '{}',
        'screenshots/tela.png': 'png',
    };
    for (const [f, c] of Object.entries(files)) fs.writeFileSync(path.join(dir, f), c);
    return { taskId, dir, state };
}

function snapshotDir(dir) {
    const out = {};
    for (const f of fs.readdirSync(dir, { recursive: true })) {
        const p = path.join(dir, f);
        if (fs.statSync(p).isFile()) out[f] = fs.readFileSync(p, 'utf8');
    }
    return out;
}

async function waitForClaudeCall(pattern) {
    for (let i = 0; i < 60; i++) {
        if (fs.existsSync(claudeCalls) && pattern.test(fs.readFileSync(claudeCalls, 'utf8'))) return true;
        await new Promise(r => setTimeout(r, 50));
    }
    return false;
}

test('replayOptions: só run parado, e só nós cujos anteriores já rodaram', () => {
    assert.strictEqual(replayer.replayOptions({ status: 'running', node: 'test', history: FULL_HISTORY }).replayable, false);
    assert.strictEqual(replayer.replayOptions({ status: 'in_progress', node: 'test', history: FULL_HISTORY }).replayable, false);
    assert.strictEqual(replayer.replayOptions({ status: 'state_corrupted', node: 'test', history: FULL_HISTORY }).replayable, false);
    const opt = replayer.replayOptions({ status: 'escalated', node: 'test', history: FULL_HISTORY });
    assert.deepStrictEqual(opt.nodes, ['plan', 'implement', 'review', 'test', 'verify']);
    const committed = replayer.replayOptions({ status: 'committed', node: 'commit', history: [...FULL_HISTORY, 'verify', 'commit'] });
    assert.ok(committed.nodes.includes('commit'));
    assert.deepStrictEqual(replayer.replayOptions({ status: 'blocked', node: 'implement', history: ['fetch_ticket', 'plan'] }).nodes,
        ['plan', 'implement']);
});

test('historyBefore: corta na última passada do nó anterior (loops continuam na história)', () => {
    const h = ['fetch_ticket', 'plan', 'implement', 'review', 'implement', 'review', 'test', 'implement', 'review', 'test', 'verify'];
    assert.deepStrictEqual(replayer.historyBefore(h, 'test'), h.slice(0, 9));
    assert.deepStrictEqual(replayer.historyBefore(h, 'verify'), h.slice(0, 10));
    assert.deepStrictEqual(replayer.historyBefore(h, 'plan'), ['fetch_ticket']);
    assert.deepStrictEqual(replayer.historyBefore(['plan'], 'plan'), []);
});

test('reconstructState: zera campos dos nós refeitos e de execução, preserva os anteriores', () => {
    const { state: original } = seedFailedAtTest(90010);
    const { state, reset } = replayer.reconstructState(original, 'test', {
        replayTaskId: '90010-task-42-replay-1', originalRun: '90010-task-42', now: '2026-09-24T10:00:00.000Z',
    });
    assert.strictEqual(state.task_id, '90010-task-42-replay-1');
    assert.strictEqual(state.node, 'test');
    assert.strictEqual(state.status, 'in_progress');
    assert.deepStrictEqual(state.history, ['fetch_ticket', 'plan', 'implement', 'review']);
    assert.deepStrictEqual(state.replayOf, { originalRun: '90010-task-42', fromNode: 'test', replayedAt: '2026-09-24T10:00:00.000Z' });
    assert.deepStrictEqual(state.retries, { review: 1 });
    for (const f of ['test_result', 'node_started_at', 'node_timeout_ms', 'agent_pid', 'cost_tracking']) {
        assert.ok(!(f in state), `${f} deveria ter sido zerado`);
        assert.ok(reset.includes(f));
    }
    assert.strictEqual(state.review_verdict, 'aprovado', 'veredito do review (não refeito) fica');
    assert.strictEqual(state.planScore, 88);
    assert.strictEqual(state.handoff_path, 'memory/runs/90010-task-42-replay-1/handoff.md');
    assert.strictEqual(state.events[0].type, 'replay');
    assert.strictEqual(original.test_result, 'falhou', 'não muta o original');
    const { validateState } = require('../validate-state');
    assert.deepStrictEqual(validateState(state).errors || [], []);
});

test('classifyArtifacts: from=test tira artefatos de test/verify/commit e mantém plan/implement/review', () => {
    const names = ['state.json', 'context.md', 'handoff.md', 'plan.md', 'codex-result-implement.md', 'review.md',
        'test-results.md', 'codex-result-test.md', 'verify-checklist.md', 'screenshots', 'commit.md',
        '.watcher-notified.json', 'state-replay-x.json', 'human-input.md', '.pre-build-notified.json'];
    const { remove, keep } = replayer.classifyArtifacts(names, 'test');
    assert.deepStrictEqual(remove, ['codex-result-test.md', 'commit.md', 'screenshots', 'test-results.md', 'verify-checklist.md']);
    assert.ok(keep.includes('plan.md') && keep.includes('codex-result-implement.md') && keep.includes('review.md'));
    assert.ok(keep.includes('context.md') && keep.includes('handoff.md') && keep.includes('state.json'));
    assert.ok(!keep.includes('.watcher-notified.json') && !keep.includes('state-replay-x.json'), 'marcadores não vão pro replay');
    assert.ok(replayer.classifyArtifacts(names, 'implement').remove.includes('.pre-build-notified.json'));
});

test('loadStateForReplay: valida existência/legibilidade do state.json e o nó pedido', () => {
    assert.throws(() => replayer.loadStateForReplay('90011-inexistente', 'test'), e => e.code === 'not_found');
    assert.throws(() => replayer.loadStateForReplay('sem-ticket', 'test'), e => e.code === 'invalid_task');
    const { taskId, dir } = seedFailedAtTest(90011);
    assert.throws(() => replayer.loadStateForReplay(taskId, 'deploy'), e => e.code === 'invalid_node');
    assert.throws(() => replayer.loadStateForReplay(taskId, 'commit'), /nunca passou por verify/);
    fs.writeFileSync(path.join(dir, 'state.json'), '{ quebrado');
    assert.throws(() => replayer.loadStateForReplay(taskId, 'test'), e => e.code === 'state_invalid');
});

test('planReplay (dry-run): lista nós e artefatos sem escrever nada', () => {
    const { taskId, dir } = seedFailedAtTest(90012);
    const before = snapshotDir(dir);
    const plan = replayer.planReplay(taskId, 'test', registered);
    assert.deepStrictEqual(plan.nodesToRun, ['test', 'verify', 'commit']);
    assert.deepStrictEqual(plan.nodesKept, ['plan', 'implement', 'review']);
    assert.deepStrictEqual(plan.artifactsToRemove, ['codex-result-test.md', 'screenshots', 'test-results.md', 'verify-checklist.md']);
    assert.ok(plan.artifactsKept.includes('plan.md'));
    assert.strictEqual(plan.replayTaskId, `${taskId}-replay-1`);
    assert.deepStrictEqual(plan.warnings, []);
    assert.deepStrictEqual(snapshotDir(dir), before);
    assert.deepStrictEqual(fs.readdirSync(runsDirOf(90012)), [taskId], 'nenhum run novo');
});

test('replayFrom: cria run de replay, preserva o original, comenta no Redmine e despacha', async () => {
    const { taskId, dir } = seedFailedAtTest(90013);
    const originalState = fs.readFileSync(path.join(dir, 'state.json'), 'utf8');
    const before = snapshotDir(dir);
    const notes = [], dispatched = [];
    const { state } = replayer.loadStateForReplay(taskId, 'test');
    const result = await replayer.replayFrom(taskId, 'test', state, {
        ...registered,
        postNote: async (id, text) => { notes.push({ id, text }); return true; },
        dispatch: async args => { dispatched.push(args); return { action: 'dispatched', node: args.state.node }; },
    });
    const rid = `${taskId}-replay-1`;
    assert.strictEqual(result.replayTaskId, rid);
    assert.deepStrictEqual(result.nodesToRun, ['test', 'verify', 'commit']);
    assert.deepStrictEqual(result.removed, ['codex-result-test.md', 'screenshots', 'test-results.md', 'verify-checklist.md']);

    // Original: state.json byte a byte igual; só ganhou o registro do replay.
    assert.strictEqual(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'), originalState);
    const after = snapshotDir(dir);
    const record = `state-replay-${rid}.json`;
    assert.deepStrictEqual(Object.keys(after).filter(f => !(f in before)), [record]);
    for (const f of Object.keys(before)) assert.strictEqual(after[f], before[f], `${f} do original mudou`);
    assert.strictEqual(JSON.parse(after[record]).replayOf.originalRun, taskId);

    // Replay: state com replayOf; artefatos dos nós refeitos fora, anteriores dentro.
    const rdir = path.join(runsDirOf(90013), rid);
    const rstate = JSON.parse(fs.readFileSync(path.join(rdir, 'state.json'), 'utf8'));
    assert.deepStrictEqual(Object.keys(rstate.replayOf).sort(), ['fromNode', 'originalRun', 'replayedAt']);
    assert.strictEqual(rstate.replayOf.originalRun, taskId);
    assert.strictEqual(rstate.replayOf.fromNode, 'test');
    const rfiles = fs.readdirSync(rdir).sort();
    assert.deepStrictEqual(rfiles, ['codex-result-implement.md', 'context.md', 'handoff.md', 'plan.md', 'review.md', 'state.json']);

    assert.deepStrictEqual(notes, [{ id: 90013, text: replayer.replayNote(taskId, 'test', rid) }]);
    assert.match(notes[0].text, new RegExp(`Replay iniciado a partir do nó test — ciclo original: ${taskId}`));
    assert.strictEqual(dispatched.length, 1);
    assert.strictEqual(dispatched[0].ticketId, 90013);
    assert.strictEqual(result.redmine, true);

    // Original superado pelo replay; replay sumindo = original volta a valer.
    assert.strictEqual(replayer.supersededBy(dir), rid);
    // Segundo replay (do original ou do replay): numeração continua a partir da raiz.
    rstate.status = 'escalated';
    fs.writeFileSync(path.join(rdir, 'state.json'), JSON.stringify(rstate));
    assert.strictEqual(replayer.loadStateForReplay(rid, 'test').replayTaskId, `${taskId}-replay-2`);
    assert.strictEqual(replayer.loadStateForReplay(taskId, 'review').replayTaskId, `${taskId}-replay-2`);
    fs.rmSync(rdir, { recursive: true });
    assert.strictEqual(replayer.supersededBy(dir), null);
});

test('replayFrom: falha no Redmine/despacho não desfaz o replay (vira aviso)', async () => {
    const { taskId } = seedFailedAtTest(90014);
    const { state } = replayer.loadStateForReplay(taskId, 'verify');
    const result = await replayer.replayFrom(taskId, 'verify', state, {
        ...registered,
        postNote: async () => { throw new Error('redmine fora'); },
        dispatch: async () => { throw new Error('claude fora'); },
    });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.warnings.length, 2);
    assert.ok(fs.existsSync(path.join(result.replayDir, 'state.json')));
});

test('replayFrom: recusa sem worktree, com worktree órfão ou com ciclo andando no ticket', async () => {
    const a = seedFailedAtTest(90015);
    const { state } = replayer.loadStateForReplay(a.taskId, 'test');
    await assert.rejects(replayer.replayFrom(a.taskId, 'test', state, { worktreeRegistered: () => false }),
        e => e.code === 'worktree_missing');
    // Outra task do mesmo ticket in_progress.
    const busy = path.join(runsDirOf(90015), '90015-outra');
    fs.mkdirSync(busy);
    fs.writeFileSync(path.join(busy, 'state.json'), JSON.stringify({ task_id: '90015-outra', node: 'plan', status: 'in_progress', history: [] }));
    await assert.rejects(replayer.replayFrom(a.taskId, 'test', state, registered), e => e.code === 'active_cycle');
    assert.ok(!fs.existsSync(path.join(runsDirOf(90015), `${a.taskId}-replay-1`)), 'nada criado quando recusa');
    // Estado que não bate com o pedido.
    await assert.rejects(replayer.replayFrom(a.taskId, 'verify', state, registered), e => e.code === 'invalid_state');
    // Worktree apagado.
    const b = seedFailedAtTest(90016);
    const { state: sb } = replayer.loadStateForReplay(b.taskId, 'test');
    const wt = path.join(repo, '.claude', 'worktrees', '90016');
    fs.renameSync(wt, `${wt}-x`);
    try {
        await assert.rejects(replayer.replayFrom(b.taskId, 'test', sb, registered), /não encontrado|não existe/);
    } finally {
        fs.renameSync(`${wt}-x`, wt);
    }
});

test('cleanArtifactsFrom: nunca mexe em run que não é replay', () => {
    const { taskId, dir } = seedFailedAtTest(90017);
    assert.throws(() => replayer.cleanArtifactsFrom(taskId, 'test'), e => e.code === 'not_replay');
    assert.ok(fs.existsSync(path.join(dir, 'test-results.md')));
});

test('run original arquivado (_archive) também pode ser retomado', async () => {
    const { taskId, dir } = seedFailedAtTest(90018, 'task-42', { status: 'committed', node: 'commit', history: [...FULL_HISTORY, 'verify', 'commit'] });
    const archived = path.join(runsDirOf(90018), '_archive', taskId);
    fs.mkdirSync(path.dirname(archived), { recursive: true });
    fs.renameSync(dir, archived);
    const { state } = replayer.loadStateForReplay(taskId, 'verify');
    const result = await replayer.replayFrom(taskId, 'verify', state, registered);
    assert.strictEqual(path.dirname(result.replayDir), runsDirOf(90018));
    assert.ok(fs.existsSync(path.join(archived, `state-replay-${result.replayTaskId}.json`)));
    assert.strictEqual(replayer.supersededBy(archived), result.replayTaskId);
});

test('watcher.findActiveTask: original superado não volta a ser a task ativa quando o replay é arquivado', async () => {
    const { taskId } = seedFailedAtTest(90019);
    const { state } = replayer.loadStateForReplay(taskId, 'test');
    const result = await replayer.replayFrom(taskId, 'test', state, registered);
    assert.strictEqual(watcher.findActiveTask(90019).taskId, result.replayTaskId);
    fs.mkdirSync(path.join(runsDirOf(90019), '_archive'), { recursive: true });
    fs.renameSync(result.replayDir, path.join(runsDirOf(90019), '_archive', result.replayTaskId));
    assert.strictEqual(watcher.findActiveTask(90019), null);
});

test('ponta a ponta: replay de task-42 from=test despacha test → verify → commit no run de replay, sem plan/implement', async () => {
    const { taskId } = seedFailedAtTest(90020);
    fs.rmSync(claudeCalls, { force: true });
    const { state } = replayer.loadStateForReplay(taskId, 'test');
    const result = await replayer.replayFrom(taskId, 'test', state, {
        ...registered,
        postNote: dispatcher.postNote,
        dispatch: ({ ticketId }) => dispatcher.dispatchNode({ ticketId, fallbackState: state, follow: false }),
    });
    const rid = result.replayTaskId;
    assert.strictEqual(result.dispatch.action, 'dispatched');
    assert.strictEqual(result.dispatch.node, 'test');
    assert.ok(await waitForClaudeCall(new RegExp(`/test ${rid}[\\s\\S]*REPLAY de ${taskId}`)), 'prompt do /test com a nota de replay');
    const put = redmineCalls.find(c => c.method === 'PUT' && c.url.endsWith('/issues/90020.json'));
    assert.match(put.body.issue.notes, new RegExp(`^\\[Watcher\\] Replay iniciado a partir do nó test — ciclo original: ${taskId}`));

    // Simula o agente avançando o grafo (test passou, verify passou) — o watcher segue no replay.
    const rstatePath = path.join(result.replayDir, 'state.json');
    for (const [done, next] of [['test', 'verify'], ['verify', 'commit']]) {
        await new Promise(r => setTimeout(r, 300)); // o release do lease (wrapper sh) devolve running → in_progress
        const s = JSON.parse(fs.readFileSync(rstatePath, 'utf8'));
        Object.assign(s, { node: next, status: 'in_progress', history: [...s.history, done], updated_at: new Date().toISOString() });
        fs.writeFileSync(rstatePath, JSON.stringify(s, null, 2));
        const r = await dispatcher.dispatchNode({ ticketId: 90020, fallbackState: state, follow: false });
        assert.strictEqual(r.action, 'dispatched');
        assert.strictEqual(r.taskId, rid);
        assert.ok(await waitForClaudeCall(new RegExp(`/${next} ${rid}`)));
    }
    const calls = fs.readFileSync(claudeCalls, 'utf8');
    assert.doesNotMatch(calls, /\/(plan|implement|review|fetch-ticket) /, 'nós anteriores ao test não rodam de novo');
    assert.doesNotMatch(calls, new RegExp(`/\\w+ ${taskId}(\\s|$)`), 'nada despachado no run original');
});

test('CLI: --dry-run --json, uso incorreto e nó inválido', () => {
    const { taskId, dir } = seedFailedAtTest(90021);
    const cli = path.join(__dirname, '..', 'replay-cycle.js');
    const env = { ...process.env, REPO_PATH: repo };
    const before = snapshotDir(dir);
    const dry = spawnSync(process.execPath, [cli, '--task', taskId, '--from', 'test', '--dry-run', '--json'], { env, encoding: 'utf8' });
    assert.strictEqual(dry.status, 0, dry.stderr);
    const plan = JSON.parse(dry.stdout);
    assert.deepStrictEqual(plan.nodesToRun, ['test', 'verify', 'commit']);
    assert.ok(plan.artifactsToRemove.includes('test-results.md'));
    assert.deepStrictEqual(snapshotDir(dir), before);

    const human = spawnSync(process.execPath, [cli, `--task=${taskId}`, '--from=test', '--dry-run'], { env, encoding: 'utf8' });
    assert.strictEqual(human.status, 0, human.stderr);
    assert.match(human.stdout, /nós re-executados:\s+test → verify → commit/);
    assert.match(human.stdout, /- test-results\.md/);

    assert.strictEqual(spawnSync(process.execPath, [cli, '--task', taskId], { env, encoding: 'utf8' }).status, 2);
    const bad = spawnSync(process.execPath, [cli, '--task', taskId, '--from', 'deploy', '--json'], { env, encoding: 'utf8' });
    assert.strictEqual(bad.status, 1);
    assert.strictEqual(JSON.parse(bad.stdout).code, 'invalid_node');
});
