// Harness PRI-69: cenários que a suíte isolada da PRI-61 pulou por dependerem de filhos
// destacados, do HOME/conta real ou de SIGTERM com agente vivo. Tudo com processo real
// (watcher, agente, mvn/java falsos) numa sandbox por cenário — ver README.md.
//
//   node --test scripts/harness/pri-69/pri-69.e2e.test.js            (alvo = este checkout)
//   node scripts/harness/pri-69/run.js [--target=candidate|source|<raiz>]
//
// Asserções sempre sobre valor explícito: timeout de espera lança (nunca vira PASS),
// tokens/contagens comparados com o número esperado exato, e todo cenário termina
// exigindo zero processo da sandbox vivo e zero conexão de rede fora do loopback.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { createSandbox, waitFor, readJson, pidAlive } = require('./sandbox');

const TARGET_ROOT = path.resolve(process.env.PRI69_TARGET_ROOT || path.join(__dirname, '..', '..', '..'));
const ARTIFACTS = path.resolve(process.env.PRI69_ARTIFACTS || path.join(os.tmpdir(), `pri69-artifacts-${process.pid}`));
const KEEP = process.env.PRI69_KEEP === '1';
const HOUR = 60 * 60 * 1000;
const target = name => require(path.join(TARGET_ROOT, 'scripts', name));

fs.mkdirSync(ARTIFACTS, { recursive: true });

async function scenario(name, fn) {
    const sb = await createSandbox(name, { targetRoot: TARGET_ROOT, artifactsRoot: ARTIFACTS });
    let error = null;
    try {
        await fn(sb);
        await sb.waitNoLiveProcesses('fim do cenário');
        assert.deepStrictEqual(sb.netBlocked(), [], 'nenhuma conexão fora do loopback');
    } catch (e) {
        error = e;
    }
    const leftovers = await sb.close({ keep: KEEP || !!error });
    fs.writeFileSync(path.join(sb.artifacts, 'result.json'), JSON.stringify({
        scenario: name, target_root: TARGET_ROOT, result: error ? 'FAIL' : 'PASS',
        error: error ? String(error.stack || error) : null, leftovers, sandbox_kept: (KEEP || !!error) ? sb.root : null,
    }, null, 2) + '\n');
    if (error) throw error;
    assert.deepStrictEqual(leftovers, [], 'nenhum processo sobrando ao fechar a sandbox');
}

function deadPid() {
    const r = spawnSync('/usr/bin/true');
    assert.ok(r.pid > 0 && !pidAlive(r.pid));
    return r.pid;
}

const events = s => (Array.isArray(s.events) ? s.events : []);
const ago = ms => new Date(Date.now() - ms).toISOString();

const FILLER = 'Texto descritivo suficiente para passar do limite mínimo de caracteres exigido pela validação. '.repeat(3);
const spec = (id, extraAc = '') => `# Spec ${id}

## Problema
${FILLER}Hoje o filtro de transportadora lista todas as transportadoras cadastradas.

## Solução
${FILLER}Filtrar pela lista do resultado atual.

## Critérios de Aceite
- AC-01: Filtro de transportadora lista somente transportadoras presentes no resultado da tela.
- AC-02: Novo filtro de operação de transporte com o mesmo comportamento dinâmico.
${extraAc}
## Restrições
- Não alterar o contrato do endpoint de Zona de Transporte.
`;
const changedSpec = id => spec(id, '- AC-03: Exportação em CSV respeita os mesmos filtros.\n');

// Spec no memory/spec do consumidor (o worktree enxerga pelo link de memory/spec) e
// spec_hash do Plan gravado na task.
function seedSpecTask(sb, id, slug, state) {
    const rel = `memory/spec/${id}-spec.md`;
    fs.writeFileSync(path.join(sb.repo, rel), spec(id));
    const task = sb.seedTask(id, slug, { spec_path: rel, spec_hash: sb.specHash(spec(id)), ...state }, {
        'plan.md': `# Plano\n\n## Referência da Spec\n- Spec: ${rel}\n- ACs: AC-01, AC-02\n`,
        'handoff.md': `# Handoff\n\n## Referência da Spec\n- Spec: ${rel}\n- ACs: AC-01, AC-02\n- Plan: memory/runs/${id}-${slug}/plan.md\n`,
        'context.md': '# Contexto\n',
    });
    return { ...task, specFile: path.join(sb.repo, rel) };
}

// Estado depois de um tick só de fechamento de custo: --ticket=<id inexistente> filtra
// despacho, órfãos e rotação, mas finalizePendingCostRuns roda antes do filtro (achado da
// PRI-61/62), igual a qualquer tick.
const COST_ONLY = ['--ticket=1'];

// ── (a) startup: órfão redespachado no MESMO nó; commit órfão só escala ─────────────

test('(a) startup: órfão recuperado e redespachado no MESMO nó; commit órfão só escala (needs_human_review, sem redespacho)', async () => {
    await scenario('a-startup-orfao', async sb => {
        sb.addTicket(92201);
        sb.addTicket(92202);
        const orphan = sb.seedTask(92201, 'orfao', {
            node: 'verify', status: 'running', history: ['fetch_ticket', 'plan', 'implement', 'review', 'test'],
            node_started_at: ago(3 * HOUR), node_timeout_ms: HOUR, agent_pid: deadPid(),
        });
        const commit = sb.seedTask(92202, 'commit-orfao', {
            node: 'commit', status: 'running', history: ['fetch_ticket', 'plan', 'implement', 'review', 'test', 'verify'],
            node_started_at: ago(3 * HOUR), node_timeout_ms: HOUR,
        });
        const before = { orphan: sb.state(orphan.dir), commit: sb.state(commit.dir) };
        sb.snapshot('orfao-state-antes.json', orphan.stateFile);
        sb.snapshot('commit-state-antes.json', commit.stateFile);
        sb.setScenario({ nodes: { verify: { workMs: 300 } } });

        const t1 = await sb.tick('startup');
        assert.strictEqual(t1.code, 0, t1.stderr);
        await waitFor('agente do /verify saiu', () => sb.calls({ event: 'exit', node: 'verify' }).length === 1);
        await sb.waitNoLiveProcesses('wrapper do /verify');
        sb.snapshot('orfao-state-depois.json', orphan.stateFile);
        sb.snapshot('commit-state-depois.json', commit.stateFile);

        const o = sb.state(orphan.dir);
        assert.strictEqual(o.node, 'verify', 'mesmo nó, sem voltar ao início do ciclo');
        assert.strictEqual(o.status, 'in_progress', 'wrapper liberou o lease');
        assert.strictEqual(o.execution_id, before.orphan.execution_id);
        assert.deepStrictEqual(o.history, before.orphan.history);
        assert.strictEqual(o.recovered_from_orphan, undefined, 'marcador consumido no redespacho');
        const recov = events(o).find(e => e.type === 'node_error' && /órfão/.test(e.detail));
        assert.ok(recov, 'evento node_error da recuperação');
        assert.ok(events(o).some(e => e.type === 'node_start' && e.node === 'verify' && /redespacho após nó órfão/.test(e.detail)));
        const verifyCalls = sb.calls({ event: 'start', node: 'verify' });
        assert.strictEqual(verifyCalls.length, 1);
        assert.strictEqual(verifyCalls[0].task_arg, orphan.taskId);
        assert.strictEqual(verifyCalls[0].recovery_note, true, 'prompt leva a nota RECUPERAÇÃO');
        assert.strictEqual(verifyCalls[0].state_execution_id, before.orphan.execution_id);

        const c = sb.state(commit.dir);
        assert.strictEqual(c.status, 'needs_human_review');
        assert.strictEqual(c.node, 'commit');
        assert.ok(events(c).some(e => e.type === 'escalation' && e.node === 'commit'));
        assert.strictEqual(sb.calls({ event: 'start', node: 'commit' }).length, 0, 'commit órfão não é redespachado');

        // Tick seguinte (só o ticket do commit): continua parado, nenhum agente.
        const t2 = await sb.tick('tick-2-commit', ['--ticket=92202']);
        assert.strictEqual(t2.code, 0, t2.stderr);
        assert.match(t2.stdout, /status_needs_human_review/);
        assert.strictEqual(sb.state(commit.dir).status, 'needs_human_review');
        assert.strictEqual(sb.calls({ event: 'start', node: 'commit' }).length, 0);
        sb.note('resumo', { verify_calls: verifyCalls, commit_calls: 0, orphan_events: events(o).map(e => e.type), commit_events: events(c).map(e => e.type) });
    });
});

// Número medido: igual ao esperado e maior que zero. Timeout de waitFor já lança;
// null/undefined/0 não passam por aqui.
function assertMeasured(actual, expected, label) {
    assert.strictEqual(actual, expected, `${label}: obtido ${JSON.stringify(actual)}, esperado ${expected}`);
    assert.strictEqual(typeof actual, 'number', label);
    assert.ok(Number.isFinite(actual) && actual > 0, `${label} precisa ser > 0`);
}

// Mesma conta de scripts/lib/cost-tracking.js para claude-sonnet-5 (US$/MTok).
function sonnetUsd(input, cacheRead, output) {
    return Math.round(((input * 2) + (cacheRead * 0.2) + (output * 10)) / 1e6 * 1e6) / 1e6;
}

function usageLine(sessionId, { input, cacheRead, output, at }) {
    return JSON.stringify({
        type: 'assistant', timestamp: at, sessionId,
        message: {
            id: `msg-${sessionId}`, model: 'claude-sonnet-5', role: 'assistant',
            content: [{ type: 'text', text: 'harness' }],
            usage: { input_tokens: input, cache_read_input_tokens: cacheRead, output_tokens: output },
        },
    }) + '\n';
}

function putTranscript(accountDir, sessionId, line) {
    const dir = path.join(accountDir, 'projects', 'harness-project');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${sessionId}.jsonl`);
    fs.writeFileSync(file, line);
    return file;
}

function writeLedger(sb, ticketId, pending) {
    const file = path.join(sb.repo, 'memory', 'runs', `${ticketId}-cost.json`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ ticket_id: ticketId, pending, tasks: {}, unattributed: [] }, null, 2) + '\n');
    return file;
}

function unusedPid() {
    let pid = 2100000000;
    while (pid > 1000 && pidAlive(pid)) pid -= 997;
    assert.strictEqual(pidAlive(pid), false, 'pid de custo precisa estar morto');
    return pid;
}

function archiveTask(sb, task) {
    const to = path.join(task.wt, 'memory', 'runs', '_archive', task.taskId);
    const r = sb.cli('arquivar', 'state-writer.js', ['archive', task.dir, `--to=${to}`, '--status=committed', '--expected-node=commit']);
    assert.strictEqual(r.code, 0, `${r.stderr}\n${r.stdout}`);
    return to;
}

// SIGTERM no watcher com --follow enquanto o /implement (e mvn/java) ainda trabalham.
async function interruptImplement(sb, id) {
    sb.addTicket(id);
    const task = sb.seedTask(id, 'implement', {
        node: 'implement', status: 'in_progress', history: ['fetch_ticket', 'plan', 'implement'],
    });
    const executionId = sb.state(task.dir).execution_id;
    assert.ok(executionId, 'execution_id nasce no seed');
    sb.snapshot('state-antes.json', task.stateFile);
    sb.setScenario({ nodes: { implement: { build: true, workMs: 120000 } } });
    const { child, done } = sb.startWatcher('sigterm', ['--follow', `--ticket=${id}`]);
    await waitFor('implement com mvn e java vivos', () => {
        const tools = sb.tools();
        const st = sb.state(task.dir);
        return st.status === 'running' && st.node === 'implement' && st.agent_pid
            && tools.some(t => t.tool === 'mvn' && t.event === 'start')
            && tools.some(t => t.tool === 'java' && t.event === 'start');
    }, 20000);
    assert.strictEqual(sb.state(task.dir).execution_id, executionId);
    process.kill(child.pid, 'SIGTERM');
    const result = await Promise.race([
        done,
        new Promise((_, reject) => setTimeout(() => reject(new Error('shutdown não terminou em 20s')), 20000)),
    ]);
    assert.strictEqual(result.code, 0, result.stderr);
    assert.strictEqual(result.signal, null);
    assert.match(result.stdout, /Graceful shutdown concluído/);
    await waitFor('agente, mvn e java mortos', () => {
        const pids = [...new Set([...sb.tools().map(t => t.pid), ...sb.calls({ event: 'start' }).map(c => c.pid)])];
        return pids.length >= 3 && pids.every(pid => !pidAlive(pid));
    }, 10000);
    return { task, executionId, result };
}

function assertInterrupted(sb, task, executionId) {
    const after = sb.state(task.dir);
    assert.strictEqual(after.status, 'interrupted');
    assert.strictEqual(after.activeNodeAtInterruption, 'implement');
    assert.strictEqual(typeof after.interruptedAt, 'string');
    assert.ok(after.interruptedAt.length > 0);
    assert.strictEqual(after.node, 'implement', 'não volta ao início do ciclo');
    assert.strictEqual(after.execution_id, executionId);
    assert.strictEqual(sb.calls({ event: 'sigterm', node: 'implement' }).length, 1);
    assert.strictEqual(sb.tools().filter(t => t.tool === 'mvn' && t.event === 'sigterm').length, 1);
    assert.strictEqual(sb.tools().filter(t => t.tool === 'java' && t.event === 'sigterm').length, 1);
    assert.strictEqual(sb.calls({ event: 'start', node: 'fetch_ticket' }).length, 0);
    assert.strictEqual(sb.calls({ event: 'start', node: 'plan' }).length, 0);
    const id = task.taskId.split('-')[0];
    const puts = sb.redminePuts(Number(id));
    assert.strictEqual(puts.length, 1, JSON.stringify(puts));
    assert.match(puts[0].body.issue.notes, /SIGTERM durante nó implement/);
    assert.strictEqual(sb.tickets[id].journals.length, 1);
    sb.snapshot('state-interrupted.json', task.stateFile);
    sb.note('resumo', {
        status: after.status, activeNodeAtInterruption: after.activeNodeAtInterruption,
        execution_id: after.execution_id, redmine_notes: puts.length,
        tool_sigterms: sb.tools().filter(t => t.event === 'sigterm').map(t => t.tool),
    });
    return after;
}

// ── (b) aprovação de SPEC_CHANGE → artefatos STALE e /plan ──────────────────────

test('(b) aprovação de SPEC_CHANGE deixa artefatos STALE e despacha o /plan', async () => {
    await scenario('b-spec-change-stale', async sb => {
        const id = 92210;
        sb.addTicket(id);
        const task = seedSpecTask(sb, id, 'spec', {
            node: 'review', status: 'in_progress', history: ['fetch_ticket', 'plan', 'implement'],
        });
        fs.writeFileSync(task.specFile, changedSpec(id));
        sb.setScenario({ nodes: { review: { workMs: 200 }, plan: { workMs: 80 } } });

        const drift = await sb.tick('drift', [`--ticket=${id}`]);
        assert.strictEqual(drift.code, 0, drift.stderr);
        const drifted = sb.state(task.dir);
        assert.strictEqual(drifted.status, 'spec-drift');
        assert.strictEqual(sb.calls({ event: 'start' }).length, 0, 'drift não despacha agente');
        sb.snapshot('state-drift.json', task.stateFile);

        const hash = sb.specHash(fs.readFileSync(task.specFile, 'utf8'));
        assert.notStrictEqual(hash, drifted.spec_hash);
        const patch = path.join(sb.root, 'aprovacao.json');
        fs.writeFileSync(patch, JSON.stringify({ spec_change_approved: true, spec_change_hash: hash }));
        const approved = sb.cli('aprovar', 'state-writer.js', ['set', task.dir, `--input=${patch}`]);
        assert.strictEqual(approved.code, 0, approved.stderr);

        const plan = await sb.tick('plan', [`--ticket=${id}`]);
        assert.strictEqual(plan.code, 0, plan.stderr);
        await waitFor('agente do /plan saiu', () => sb.calls({ event: 'exit', node: 'plan' }).length === 1);
        await sb.waitNoLiveProcesses('wrapper do /plan');
        const after = sb.state(task.dir);
        sb.snapshot('state-depois.json', task.stateFile);
        assert.strictEqual(after.node, 'plan');
        assert.strictEqual(after.artifact_validity.plan.validity.status, 'STALE');
        assert.strictEqual(after.artifact_validity.review.validity.status, 'STALE');
        assert.strictEqual(after.artifact_validity.evidence.validity.status, 'STALE');
        assert.ok(events(after).some(e => e.type === 'artifacts_invalidated'));
        assert.ok(events(after).some(e => e.type === 'spec_change_accepted'));
        assert.strictEqual(sb.calls({ event: 'start', node: 'plan' }).length, 1);
        assert.strictEqual(sb.calls({ event: 'start', node: 'review' }).length, 0);
        assert.strictEqual(after.execution_id, drifted.execution_id);
        sb.note('resumo', {
            node: after.node,
            plan: after.artifact_validity.plan.validity.status,
            evidence: after.artifact_validity.evidence.validity.status,
        });
    });
});

// ── (c) pending_invalidation não interrompe o nó; invalida quando ele termina ───

test('(c) pending_invalidation não interrompe nó em execução e invalida quando termina', { timeout: 90000 }, async () => {
    await scenario('c-pending-invalidation', async sb => {
        const id = 92211;
        sb.addTicket(id);
        const task = seedSpecTask(sb, id, 'inv', {
            node: 'review', status: 'in_progress', history: ['fetch_ticket', 'plan', 'implement'],
        });
        const seeded = sb.state(task.dir);
        sb.setScenario({ nodes: { review: { hold: true, workMs: 30 }, plan: { workMs: 40 } } });

        const started = await sb.tick('despacha-review', [`--ticket=${id}`]);
        assert.strictEqual(started.code, 0, started.stderr);
        await waitFor('review em execução', () => {
            const st = sb.state(task.dir);
            return st.status === 'running' && st.agent_pid && pidAlive(st.agent_pid);
        }, 20000);
        const running = sb.state(task.dir);
        assert.strictEqual(running.node, 'review');
        sb.snapshot('state-rodando.json', task.stateFile);

        const pending = {
            triggered_by: 'SPEC_CHANGE SC-001', new_spec_version: 2, new_spec_hash: 'b'.repeat(64),
            old_spec_hash: seeded.spec_hash, old_spec_version: 1,
            case: 'active_phase', phase: 'review', registered_at: new Date().toISOString(),
        };
        const patch = path.join(sb.root, 'pending.json');
        fs.writeFileSync(patch, JSON.stringify({ pending_invalidation: pending }));
        const set = sb.cli('pendente', 'state-writer.js', ['set', task.dir, `--input=${patch}`]);
        assert.strictEqual(set.code, 0, set.stderr);

        const busy = await sb.tick('ainda-rodando', [`--ticket=${id}`]);
        assert.strictEqual(busy.code, 0, busy.stderr);
        assert.match(busy.stdout, /no_em_execucao/);
        const mid = sb.state(task.dir);
        assert.strictEqual(mid.status, 'running');
        assert.strictEqual(mid.node, 'review');
        assert.strictEqual(mid.node_started_at, running.node_started_at);
        assert.strictEqual(mid.agent_pid, running.agent_pid);
        assert.ok(pidAlive(mid.agent_pid), 'o tick não matou o agente');
        assert.deepStrictEqual(mid.pending_invalidation, pending);
        assert.strictEqual(sb.calls({ event: 'start', node: 'plan' }).length, 0);
        assert.strictEqual(sb.calls({ event: 'start', node: 'review' }).length, 1);
        sb.snapshot('state-nao-interrompido.json', task.stateFile);

        fs.writeFileSync(path.join(sb.root, 'agent-release'), 'solta\n');
        await waitFor('review terminou', () => sb.calls({ event: 'exit', node: 'review' }).length === 1);
        await sb.waitNoLiveProcesses('wrapper do review');
        const released = sb.state(task.dir);
        assert.strictEqual(released.status, 'in_progress');
        assert.strictEqual(released.node, 'review', 'o agente não avançou o nó');
        assert.deepStrictEqual(released.pending_invalidation, pending, 'sair do nó ainda não invalida');

        const afterTick = await sb.tick('aplica', [`--ticket=${id}`]);
        assert.strictEqual(afterTick.code, 0, afterTick.stderr);
        await waitFor('agente do /plan saiu', () => sb.calls({ event: 'exit', node: 'plan' }).length === 1);
        const after = sb.state(task.dir);
        sb.snapshot('state-invalidado.json', task.stateFile);
        assert.strictEqual(after.pending_invalidation, undefined);
        assert.strictEqual(after.node, 'plan');
        assert.strictEqual(after.artifact_validity.plan.validity.status, 'STALE');
        assert.strictEqual(after.artifact_validity.evidence.validity.status, 'STALE');
        assert.strictEqual(after.invalidations.at(-1).case, 'active_phase');
        assert.ok(events(after).some(e => e.type === 'invalidation_resolved'));
        assert.strictEqual(sb.calls({ event: 'start', node: 'review' }).length, 1);
        assert.strictEqual(sb.calls({ event: 'start', node: 'plan' }).length, 1);
        assert.strictEqual(sb.calls({ event: 'start', node: 'test' }).length, 0);
        sb.note('resumo', { node: after.node, evidence: after.artifact_validity.evidence.validity.status });
    });
});

// ── (d)(e)(f)(g) custo: o fechamento é o tick seguinte, sem despachar ───────────

test('(d) run do /commit cai na task arquivada', async () => {
    await scenario('d-custo-commit-arquivado', async sb => {
        const id = 92220;
        sb.addTicket(id);
        const task = sb.seedTask(id, 'custo', {
            node: 'commit', status: 'in_progress', history: ['fetch_ticket', 'plan', 'implement', 'review', 'test', 'verify'],
        });
        const archived = archiveTask(sb, task);
        const sessionId = 'commit-sessao-d';
        const started = Date.now() - 10000;
        const at = new Date(started + 1500).toISOString();
        putTranscript(path.join(sb.home, '.claude'), sessionId, usageLine(sessionId, { input: 40, cacheRead: 60, output: 80, at }));
        writeLedger(sb, id, [{
            session_id: sessionId, agent: 'claude', nodes: ['commit'], started_at_ms: started, pid: unusedPid(),
            claude_config_dir: path.join(sb.home, '.claude'),
        }]);
        sb.snapshot('state-arquivado-antes.json', path.join(archived, 'state.json'));

        const tick = await sb.tick('fecha-custo', COST_ONLY);
        assert.strictEqual(tick.code, 0, tick.stderr);
        const state = readJson(path.join(archived, 'state.json'));
        const ledger = sb.costLedger(id);
        sb.snapshot('state-arquivado-depois.json', path.join(archived, 'state.json'));
        sb.snapshot('ledger.json', path.join(sb.repo, 'memory', 'runs', `${id}-cost.json`));
        assert.strictEqual(ledger.pending.length, 0);
        assert.strictEqual(ledger.unattributed.length, 0, 'commit não vai para unattributed');
        const commit = state.cost_tracking.nodes.commit;
        assert.strictEqual(commit.agent, 'claude');
        assertMeasured(commit.input_tokens, 100, 'input do /commit');
        assertMeasured(commit.output_tokens, 80, 'output do /commit');
        assertMeasured(commit.cache_read_input_tokens, 60, 'cache do /commit');
        assertMeasured(commit.duration_ms, 1500, 'duração do /commit');
        assertMeasured(commit.cost_usd, sonnetUsd(40, 60, 80), 'custo do /commit');
        assert.strictEqual(commit.runs, 1);
        assert.strictEqual(commit.runs_without_tokens || 0, 0);
        sb.note('resumo', { input_tokens: commit.input_tokens, output_tokens: commit.output_tokens, duration_ms: commit.duration_ms, cost_usd: commit.cost_usd });
    });
});

test('(e) codex lê ## Tokens de codex-result-<node>.md', async () => {
    await scenario('e-custo-codex-tokens', async sb => {
        const id = 92221;
        sb.addTicket(id);
        const task = sb.seedTask(id, 'codex', { node: 'verify', status: 'in_progress', history: ['fetch_ticket', 'plan', 'implement', 'review', 'test'] });
        fs.writeFileSync(path.join(task.dir, 'codex-result-test.md'), [
            '# Resultado Codex',
            '',
            '## Learnings',
            'nenhum',
            '## Tokens',
            'input_tokens: 321',
            'output_tokens: 654',
            '## Outra',
            'input_tokens: 999',
            '',
        ].join('\n'));
        const started = Date.now() - 5000;
        writeLedger(sb, id, [{ session_id: 'codex-1', agent: 'codex', nodes: ['test'], started_at_ms: started, pid: unusedPid() }]);

        const tick = await sb.tick('fecha-custo', COST_ONLY);
        assert.strictEqual(tick.code, 0, tick.stderr);
        const node = sb.state(task.dir).cost_tracking.nodes.test;
        sb.snapshot('state-depois.json', task.stateFile);
        assert.strictEqual(node.agent, 'codex');
        assertMeasured(node.input_tokens, 321, 'input lido de ## Tokens');
        assertMeasured(node.output_tokens, 654, 'output lido de ## Tokens');
        assert.notStrictEqual(node.input_tokens, 999, 'a seção seguinte não entra');
        assert.strictEqual(typeof node.duration_ms, 'number');
        assert.ok(node.duration_ms > 0, 'duração do codex > 0');
        assert.strictEqual(sb.costLedger(id).pending.length, 0);
        assert.strictEqual(sb.calls({ event: 'start' }).length, 0, 'este tick só fecha custo');
        sb.note('resumo', { input_tokens: node.input_tokens, output_tokens: node.output_tokens, duration_ms: node.duration_ms });
    });
});

test('(f) sem task dir, o custo vai para unattributed', async () => {
    await scenario('f-custo-unattributed', async sb => {
        const id = 92222;
        const sessionId = 'pretask-f';
        const started = Date.now() - 8000;
        const at = new Date(started + 800).toISOString();
        putTranscript(path.join(sb.home, '.claude'), sessionId, usageLine(sessionId, { input: 17, cacheRead: 23, output: 29, at }));
        writeLedger(sb, id, [{
            session_id: sessionId, agent: 'claude', nodes: ['fetch_ticket', 'plan'], started_at_ms: started, pid: unusedPid(),
            claude_config_dir: path.join(sb.home, '.claude'),
        }]);
        assert.strictEqual(fs.existsSync(path.join(sb.repo, '.claude', 'worktrees', String(id))), false, 'sem task dir');

        const tick = await sb.tick('fecha-custo', COST_ONLY);
        assert.strictEqual(tick.code, 0, tick.stderr);
        const ledger = sb.costLedger(id);
        sb.snapshot('ledger.json', path.join(sb.repo, 'memory', 'runs', `${id}-cost.json`));
        assert.strictEqual(ledger.pending.length, 0);
        assert.strictEqual(Object.keys(ledger.tasks).length, 0);
        assert.strictEqual(ledger.unattributed.length, 1);
        const row = ledger.unattributed[0];
        assert.strictEqual(row.node, 'plan');
        assertMeasured(row.input_tokens, 40, 'input unattributed');
        assertMeasured(row.output_tokens, 29, 'output unattributed');
        assertMeasured(row.duration_ms, 800, 'duração unattributed');
        assertMeasured(row.cost_usd, sonnetUsd(17, 23, 29), 'custo unattributed');
        sb.note('resumo', { node: row.node, input_tokens: row.input_tokens, output_tokens: row.output_tokens, duration_ms: row.duration_ms });
    });
});

test('(g) nó diferente de commit, sem task ativa, não cai na task arquivada anterior', async () => {
    await scenario('g-custo-nao-cai-no-archive', async sb => {
        const id = 92223;
        sb.addTicket(id);
        const task = sb.seedTask(id, 'anterior', {
            node: 'commit', status: 'in_progress', history: ['fetch_ticket', 'plan', 'implement', 'review', 'test', 'verify'],
        });
        const archived = archiveTask(sb, task);
        const before = readJson(path.join(archived, 'state.json'));
        assert.strictEqual(before.cost_tracking, undefined);
        const sessionId = 'novo-ciclo-g';
        const started = Date.now() - 6000;
        const at = new Date(started + 400).toISOString();
        putTranscript(path.join(sb.home, '.claude'), sessionId, usageLine(sessionId, { input: 4, cacheRead: 6, output: 8, at }));
        writeLedger(sb, id, [{
            session_id: sessionId, agent: 'claude', nodes: ['fetch_ticket', 'plan'], started_at_ms: started, pid: unusedPid(),
            claude_config_dir: path.join(sb.home, '.claude'),
        }]);

        const tick = await sb.tick('fecha-custo', COST_ONLY);
        assert.strictEqual(tick.code, 0, tick.stderr);
        const state = readJson(path.join(archived, 'state.json'));
        const ledger = sb.costLedger(id);
        sb.snapshot('state-arquivado.json', path.join(archived, 'state.json'));
        sb.snapshot('ledger.json', path.join(sb.repo, 'memory', 'runs', `${id}-cost.json`));
        assert.strictEqual(state.cost_tracking, undefined, 'o ciclo arquivado não recebe o nó plan');
        assert.strictEqual(ledger.tasks[task.taskId], undefined);
        assert.strictEqual(ledger.unattributed.length, 1);
        assert.strictEqual(ledger.unattributed[0].node, 'plan');
        assertMeasured(ledger.unattributed[0].input_tokens, 10, 'input do ciclo novo');
        assertMeasured(ledger.unattributed[0].output_tokens, 8, 'output do ciclo novo');
        assertMeasured(ledger.unattributed[0].duration_ms, 400, 'duração do ciclo novo');
        sb.note('resumo', { archived_cost: state.cost_tracking ?? null, unattributed_node: ledger.unattributed[0].node, input_tokens: ledger.unattributed[0].input_tokens });
    });
});

test('(h) conta Claude selecionada no dashboard (~/.claude-personal) é a usada no despacho e no custo', { timeout: 60000 }, async () => {
    await scenario('h-conta-claude-personal', async sb => {
        const id = 92230;
        const personal = path.join(sb.home, '.claude-personal');
        fs.mkdirSync(path.join(sb.repo, 'dashboard'), { recursive: true });
        fs.mkdirSync(personal, { recursive: true });
        fs.writeFileSync(path.join(sb.repo, 'dashboard', 'dashboard-prefs.json'), JSON.stringify({ claude_config_dir: '~/.claude-personal' }));
        sb.addTicket(id);
        const task = sb.seedTask(id, 'conta', {
            node: 'review', status: 'in_progress', history: ['fetch_ticket', 'plan', 'implement'],
        });
        sb.setScenario({ nodes: { review: { workMs: 150 } } });

        const dispatched = await sb.tick('despacho', [`--ticket=${id}`]);
        assert.strictEqual(dispatched.code, 0, dispatched.stderr);
        await waitFor('review saiu', () => sb.calls({ event: 'exit', node: 'review' }).length === 1);
        const start = sb.calls({ event: 'start', node: 'review' });
        assert.strictEqual(start.length, 1);
        assert.strictEqual(start[0].claude_config_dir, personal, 'CLAUDE_CONFIG_DIR do despacho é a conta do dashboard');
        const pending = sb.costLedger(id).pending;
        assert.strictEqual(pending.length, 1);
        assert.strictEqual(pending[0].claude_config_dir, personal);
        const sessionId = pending[0].session_id;
        assert.ok(sessionId);
        const realFile = path.join(personal, 'projects', 'harness-project', `${sessionId}.jsonl`);
        assert.ok(fs.existsSync(realFile), 'transcript gravado na conta selecionada');
        const decoy = putTranscript(path.join(sb.home, '.claude'), sessionId, usageLine(sessionId, {
            input: 1, cacheRead: 0, output: 1, at: new Date().toISOString(),
        }));
        assert.ok(fs.existsSync(decoy), 'decoy na conta padrão, para o custo não poder cair nela');
        await sb.waitNoLiveProcesses('agente');

        const closed = await sb.tick('fecha-custo', COST_ONLY);
        assert.strictEqual(closed.code, 0, closed.stderr);
        const review = sb.state(task.dir).cost_tracking.nodes.review;
        sb.snapshot('state-depois.json', task.stateFile);
        assert.strictEqual(sb.costLedger(id).pending.length, 0);
        assertMeasured(review.input_tokens, 1000, 'input da conta personal (100+900), não do decoy');
        assertMeasured(review.output_tokens, 100, 'output da conta personal');
        assertMeasured(review.cache_read_input_tokens, 900, 'cache da conta personal');
        assertMeasured(review.cost_usd, sonnetUsd(100, 900, 100), 'custo da conta personal');
        assert.notStrictEqual(review.input_tokens, 1);
        assert.strictEqual(review.runs_without_tokens || 0, 0);
        assert.strictEqual(review.runs, 1);
        sb.note('resumo', {
            claude_config_dir: start[0].claude_config_dir,
            input_tokens: review.input_tokens, output_tokens: review.output_tokens, cost_usd: review.cost_usd,
            transcript: realFile,
        });
    });
});

// ── (i) sanitizador no filho destacado, sem --follow ────────────────────────────

test('(i) token impresso por filho sem --follow sai [REDACTED] no log', { timeout: 60000 }, async () => {
    await scenario('i-sanitizador-sem-follow', async sb => {
        const id = 92231;
        const secret = 'harness-redmine-key-000000000000';
        sb.addTicket(id);
        sb.seedTask(id, 'log', { node: 'review', status: 'in_progress', history: ['fetch_ticket', 'plan', 'implement'] });
        sb.setScenario({ nodes: { review: { printEnv: ['REDMINE_API_KEY'], workMs: 40 } } });

        const tick = await sb.tick('sem-follow', [`--ticket=${id}`]);
        assert.strictEqual(tick.code, 0, tick.stderr);
        const logPath = path.join(sb.repo, 'memory', 'runs', `${id}.log`);
        await waitFor('log com o token já redigido', () => {
            if (!fs.existsSync(logPath)) return false;
            const text = fs.readFileSync(logPath, 'utf8');
            return text.includes('[REDACTED]') && !text.includes(secret);
        }, 15000);
        await sb.waitNoLiveProcesses('filtro do log');
        const log = fs.readFileSync(logPath, 'utf8');
        sb.snapshot('ticket-log.txt', logPath);
        const printed = sb.calls({ event: 'printed', node: 'review' });
        assert.strictEqual(printed.length, 1);
        assert.strictEqual(printed[0].lengths[0], secret.length);
        assert.ok(printed[0].lengths[0] >= 8, 'o valor impresso não era vazio');
        assert.ok(!log.includes(secret), 'o segredo não pode aparecer no log');
        assert.ok((log.match(/\[REDACTED\]/g) || []).length >= 2, 'stdout e stderr redigidos');
        assert.match(log, /\[claude\] out \[REDACTED\]/);
        assert.match(log, /\[claude\] err \[REDACTED\]/);
        sb.note('resumo', { redacted: (log.match(/\[REDACTED\]/g) || []).length, secret_length: printed[0].lengths[0], log: logPath });
    });
});

// ── interrupção e retomada ──────────────────────────────────────────────────────

test('SIGTERM durante /implement: state interrupted, agente e filhos morrem, nota única', { timeout: 60000 }, async () => {
    await scenario('interrupt-implement', async sb => {
        const { task, executionId } = await interruptImplement(sb, 92240);
        assertInterrupted(sb, task, executionId);
        assert.strictEqual(sb.calls({ event: 'start', node: 'implement' }).length, 1);
        assert.deepStrictEqual(sb.bitbucketPrPosts(), []);
    });
});

test('retomada do run interrupted segue do /implement com o mesmo execution_id, termina o ciclo e abre 1 PR', { timeout: 120000 }, async () => {
    await scenario('resume-implement', async sb => {
        const id = 92241;
        const { task, executionId } = await interruptImplement(sb, id);
        assertInterrupted(sb, task, executionId);

        const human = sb.cli('retomar', 'state-writer.js', ['set', task.dir, '--set=status=in_progress']);
        assert.strictEqual(human.code, 0, `${human.stderr}\n${human.stdout}`);
        const resumed = sb.state(task.dir);
        assert.strictEqual(resumed.status, 'in_progress');
        assert.strictEqual(resumed.node, 'implement');
        assert.strictEqual(resumed.execution_id, executionId);
        assert.strictEqual(resumed.activeNodeAtInterruption, 'implement');
        sb.snapshot('state-retomado.json', task.stateFile);

        sb.setScenario({
            nodes: {
                implement: [{ build: true, workMs: 120000 }, { workMs: 40, transition: 'review' }],
                review: { workMs: 40, transition: 'test' },
                test: { workMs: 40, transition: 'verify' },
                verify: { workMs: 40, transition: 'commit' },
                commit: { workMs: 40, openPr: true, archive: 'committed' },
            },
        });
        const follow = await sb.tick('ciclo', ['--follow', `--ticket=${id}`], { timeoutMs: 90000 });
        assert.strictEqual(follow.code, 0, follow.stderr);

        const starts = sb.calls({ event: 'start' });
        const nodes = starts.map(c => c.node);
        assert.deepStrictEqual(nodes.filter(n => n === 'fetch_ticket'), []);
        assert.deepStrictEqual(nodes.filter(n => n === 'plan'), []);
        assert.deepStrictEqual(nodes.filter(n => n === 'implement'), ['implement', 'implement']);
        assert.ok(nodes.includes('review') && nodes.includes('test') && nodes.includes('verify') && nodes.includes('commit'));
        for (const call of starts) assert.strictEqual(call.state_execution_id, executionId, `${call.node} mudou o execution_id`);

        const archived = path.join(task.wt, 'memory', 'runs', '_archive', task.taskId, 'state.json');
        assert.ok(fs.existsSync(archived), 'o /commit arquivou o run');
        const finalState = readJson(archived);
        sb.snapshot('state-committed.json', archived);
        assert.strictEqual(finalState.status, 'committed');
        assert.strictEqual(finalState.execution_id, executionId);
        assert.strictEqual(finalState.activeNodeAtInterruption, 'implement');
        assert.strictEqual(typeof finalState.pull_request['app-back'].url, 'string');
        assert.ok(finalState.pull_request['app-back'].url.includes('/pull-requests/'));
        assert.strictEqual(sb.bitbucketPrPosts().length, 1);
        const sigtermNotes = sb.redminePuts(id).filter(p => /SIGTERM durante nó implement/.test(p.body?.issue?.notes || ''));
        assert.strictEqual(sigtermNotes.length, 1, 'a nota da interrupção continua única');
        sb.note('resumo', {
            nodes, execution_id: finalState.execution_id, prs: sb.bitbucketPrPosts().length,
            pr: finalState.pull_request['app-back'].url, sigterm_notes: sigtermNotes.length,
        });
    });
});
