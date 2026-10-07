// node --test state-concurrency.test.js
// Transições concorrentes de state.json (scripts/state-writer.js + scripts/cas.js,
// docs/concurrency-map.md): os cenários 1–9 de concorrência, state_version só em campo
// crítico, auditoria sem dado sensível e as varreduras estáticas "um só writer" (AC-03)
// e "comparação CAS só no cas.js" (AC-02). O cenário 10 (dashboard) fica em
// dashboard/state-version-api.test.js.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const sw = require('./state-writer');
const cas = require('./cas');
const sa = require('./lib/spec-authority');
const sc = require('./lib/spec-change');
const nodeLease = require('./lib/node-lease');

delete process.env.STATE_CONFLICTS_LOG; // o log vai para <root>/logs do layout de teste
delete process.env.STATE_EXECUTION_ID;

const SW_CLI = path.join(__dirname, 'state-writer.js');
const SC_CLI = path.join(__dirname, 'lib', 'spec-change.js');
const sandbox = fs.mkdtempSync(path.join(process.env.CLAUDE_JOB_DIR ? path.join(process.env.CLAUDE_JOB_DIR, 'tmp') : os.tmpdir(), 'state-concurrency-'));
let seq = 0;

/** Run sintético em <root>/memory/runs/<task>/ (layout real: o log cai em <root>/logs). */
function seedRun(state = {}) {
    const root = path.join(sandbox, `repo-${++seq}`);
    const taskId = `90${String(seq).padStart(3, '0')}-concorrencia`;
    const dir = path.join(root, 'memory', 'runs', taskId);
    const written = sw.init(dir, {
        task_id: taskId, node: 'review', history: ['plan', 'implement'], status: 'in_progress',
        started_at: '2026-10-01T10:00:00.000Z', ...state,
    });
    return { root, taskId, dir, state: written };
}
const readState = dir => JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'));
const rawState = dir => fs.readFileSync(path.join(dir, 'state.json'), 'utf8');
function conflicts(root) {
    const file = path.join(root, 'logs', cas.LOG_FILE);
    return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) : [];
}
function cli(args, env = {}) {
    const childEnv = { ...process.env, ...env };
    for (const [k, v] of Object.entries(env)) if (v === undefined) delete childEnv[k];
    return spawnSync(process.execPath, [SW_CLI, ...args], { encoding: 'utf8', env: childEnv });
}

// ── state_version (AC-01) ────────────────────────────────────────────────────────

test('state_version: +1 por campo crítico alterado; campos secundários nunca incrementam', () => {
    const { dir, state } = seedRun();
    assert.strictEqual(state.state_version, 1);
    const secondary = [
        s => { s.updated_at = '2026-10-01T10:05:00.000Z'; },
        s => { s.events = [{ type: 'node_start', ts: 'x' }]; },
        s => { s.node_started_at = '2026-10-01T10:06:00.000Z'; s.node_timeout_ms = 1000; s.agent_pid = 123; },
        s => { s.cost_tracking = { totals: { loop_count: 1 } }; },
        s => { s.human_inputs = [{ content: 'oi' }]; s.pr_status = 'open'; },
        s => { s.retries = { review: 0 }; }, // zero = sem retry: igual a ausente
    ];
    for (const m of secondary) assert.strictEqual(sw.update(dir, m).state_version, 1);

    const critical = [
        s => { s.node = 'test'; },
        s => { s.status = 'running'; },
        s => { s.execution_id = sw.newExecutionId(); },
        s => { s.spec_hash = 'a'.repeat(64); },
        s => { s.spec = { version: 1, hash: 'b'.repeat(64), hash_scope: 'contract', path: 'x', status: 'sealed' }; },
        s => { s.spec.version = 2; },
        s => { s.artifact_validity = { plan: { validity: { status: 'VALID' } } }; },
        s => { s.artifact_validity.plan.validity.status = 'STALE'; },
        s => { s.retries = { review: 1 }; },
    ];
    let v = 1;
    for (const m of critical) assert.strictEqual(sw.update(dir, m).state_version, ++v);
    // Vários campos críticos numa escrita só = uma transição = +1.
    assert.strictEqual(sw.update(dir, s => { s.node = 'verify'; s.status = 'in_progress'; }).state_version, v + 1);
    assert.deepStrictEqual(sw.CRITICAL_FIELDS, [
        'node', 'status', 'execution_id', 'spec_hash', 'spec.hash', 'spec.version',
        'artifact_validity.plan.validity.status', 'artifact_validity.implement.validity.status',
        'artifact_validity.review.validity.status', 'artifact_validity.evidence.validity.status',
        'artifact_validity.verify.validity.status', 'retries',
    ]);
});

test('edição fora do state-writer em campo crítico conta como versão nova — CAS antigo falha', () => {
    const { dir, root } = seedRun();
    const before = cas.snapshotOf(readState(dir));
    const s = readState(dir);
    s.node = 'implement'; // agente/humano editando o arquivo direto, sem bump
    fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify(s, null, 2));
    assert.strictEqual(cas.effectiveVersion(readState(dir)), before.expected_state_version + 1);
    assert.throws(() => cas.transact({ runDir: dir, operation: 'node_transition', expected_state_version: before.expected_state_version, expected_node: 'implement' }, d => { d.node = 'review'; }),
        e => e.code === cas.STATE_CONFLICT);
    assert.ok(conflicts(root).some(c => c.event === 'STATE_CONFLICT' && c.operation === 'node_transition'));
});

// ── 1. Dupla aprovação de SPEC_CHANGE ────────────────────────────────────────────

const FILLER = 'Texto descritivo suficiente para passar do limite mínimo de caracteres exigido pela validação. ';
const SPEC = `# Spec 90100

## Problema
${FILLER}Hoje o relatório de fretes não mostra o desconto por volume.

## Solução
${FILLER}Calcular o desconto por volume no serviço de frete.

## Critérios de Aceite
- AC-01: Fretes com mais de 10 volumes recebem 5% de desconto.
- AC-02: O relatório exibe o desconto aplicado por frete.

## Restrições
- Não alterar o contrato do endpoint de cotação.
`;

function seedSpecChange() {
    const run = seedRun({ node: 'implement', redmine_ticket: { id: 90100 }, spec_path: 'memory/spec/90100-spec.md', spec_hash: sa.specHash(SPEC) });
    fs.mkdirSync(path.join(run.root, 'memory', 'spec'), { recursive: true });
    run.specFile = path.join(run.root, 'memory', 'spec', '90100-spec.md');
    fs.writeFileSync(run.specFile, SPEC);
    fs.writeFileSync(path.join(run.dir, 'handoff.md'), '# Handoff\n');
    fs.writeFileSync(path.join(run.dir, 'plan.md'), '# Plano\n\n1. Desconto. Critérios: AC-01, AC-02\n');
    const input = path.join(run.dir, 'decision.json');
    fs.writeFileSync(input, JSON.stringify({
        type: 'SPEC_CHANGE', description: 'Substituir AC-01: desconto a partir de 20 volumes', rationale: 'Regra comercial nova',
        ac_affected: ['AC-01'], previous_behavior: 'Desconto acima de 10 volumes', proposed_behavior: 'Desconto acima de 20 volumes',
        ac_changes: [{ action: 'replace', ac: 'AC-01', text: 'Fretes com mais de 20 volumes recebem 5% de desconto.' }],
        timestamp: '2026-10-01T11:00:00.000Z',
    }));
    const rec = spawnSync(process.execPath, [SC_CLI, 'record', run.dir, `--input=${input}`], { encoding: 'utf8' });
    assert.strictEqual(readState(run.dir).status, sc.PENDING_STATUS, rec.stderr);
    return run;
}

test('1. dupla aprovação de SPEC_CHANGE: a segunda devolve already_processed e não altera o state', () => {
    const { dir } = seedSpecChange();
    // Dois aprovadores leram o MESMO estado pendente (mesma tela / mesmo tick).
    const pending = readState(dir);
    const expect = { ...cas.snapshotOf(pending), operation_id: `${pending.spec_change_pending.id}@${pending.task_id}` };
    const first = sc.approveSpecChange(dir, { by: 'Ana', at: '2026-10-01T12:00:00.000Z', expect });
    assert.ok(first.ok, first.error);
    assert.strictEqual(readState(dir).node, 'plan');
    const after = rawState(dir);
    const audit = fs.readFileSync(path.join(dir, sc.AUDIT_FILE), 'utf8');

    const second = sc.approveSpecChange(dir, { by: 'Bia', at: '2026-10-01T12:00:05.000Z', expect });
    assert.deepStrictEqual(second, { ok: true, status: 'already_processed', operation_id: expect.operation_id });
    assert.strictEqual(rawState(dir), after, 'state.json idêntico byte a byte');
    assert.strictEqual(fs.readFileSync(path.join(dir, sc.AUDIT_FILE), 'utf8'), audit, 'audit não ganha segunda aprovação');
    const ops = readState(dir).processed_operations;
    assert.strictEqual(ops.length, 1);
    assert.deepStrictEqual([ops[0].operation_id, ops[0].type], [expect.operation_id, 'SPEC_CHANGE_APPROVAL']);
});

// ── 2. Replay + watcher ──────────────────────────────────────────────────────────

test('2. replay + watcher simultâneos: replay — execution_id novo vence; watcher com o antigo leva SESSION_CONFLICT', () => {
    const { dir, root, state } = seedRun({ node: 'test' });
    const oldExecution = state.execution_id;
    // Watcher despachou o nó antes: lease com o execution_id da execução antiga.
    const lease = nodeLease.acquireNode(dir, { node: 'test', timeoutMs: 60_000 });
    assert.strictEqual(lease.executionId, oldExecution);

    // Replay assume o run (operação replay: CAS de versão + nó + execution_id), com
    // execução nova — o mesmo que o run de replay ganha no init.
    const snap = cas.snapshotOf(readState(dir));
    const replayExecution = sw.newExecutionId();
    const taken = cas.transact({ runDir: dir, operation: 'replay', actor: 'replay', ...snap }, s => {
        s.execution_id = replayExecution; s.status = 'in_progress';
    });
    assert.strictEqual(taken.status, 'applied');

    // O watcher termina o despacho antigo: release recusado, nada gravado.
    const beforeRelease = rawState(dir);
    assert.strictEqual(nodeLease.releaseNode(lease), false);
    assert.strictEqual(rawState(dir), beforeRelease);
    // O agente da sessão antiga tenta persistir a transição: SESSION_CONFLICT (exit 3).
    const stale = cli(['transition', dir, '--from=test', '--to=verify'], { STATE_EXECUTION_ID: oldExecution });
    assert.strictEqual(stale.status, 3, stale.stderr);
    assert.strictEqual(JSON.parse(stale.stderr).code, cas.SESSION_CONFLICT);
    assert.strictEqual(readState(dir).node, 'test');

    // O replay persiste o resultado com o execution_id dele.
    const ok = cli(['transition', dir, '--from=test', '--to=verify'], { STATE_EXECUTION_ID: replayExecution });
    assert.strictEqual(ok.status, 0, ok.stderr);
    assert.strictEqual(readState(dir).node, 'verify');
    const sessions = conflicts(root).filter(c => c.event === cas.SESSION_CONFLICT);
    assert.deepStrictEqual(sessions.map(c => c.operation).sort(), ['lease_release', 'node_transition']);
});

test('2b. run de replay nasce com execution_id próprio — init: sessão com o id do original é recusada', () => {
    const original = seedRun({ node: 'commit', status: 'committed' });
    const replayDir = path.join(path.dirname(original.dir), `${original.taskId}-replay-1`);
    const copied = { ...readState(original.dir), task_id: `${original.taskId}-replay-1`, node: 'test', status: 'in_progress' };
    const replay = sw.init(replayDir, copied);
    assert.notStrictEqual(replay.execution_id, original.state.execution_id);
    assert.deepStrictEqual(replay.processed_operations, []);
    assert.throws(() => cas.transact({ runDir: replayDir, operation: 'replay', ...cas.snapshotOf(replay), execution_id: original.state.execution_id }, () => {}),
        e => e.code === cas.SESSION_CONFLICT);
});

// ── 3. Resume + sessão antiga ────────────────────────────────────────────────────

test('3. resume + sessão antiga: a antiga leva SESSION_CONFLICT — logado; a retomada segue', () => {
    const { dir, root, state } = seedRun({ node: 'implement', status: 'session_limit', session_interrupted: true });
    const oldSession = state.execution_id;
    const screen = cas.snapshotOf(state); // o que o dashboard carregou
    const resumed = cas.transact({
        runDir: dir, operation: 'resume_session', actor: 'dashboard',
        expected_state_version: screen.expected_state_version, execution_id: screen.execution_id,
    }, s => ({ ...s, status: 'in_progress', session_interrupted: false, execution_id: sw.newExecutionId() }));
    const newSession = resumed.state.execution_id;
    assert.notStrictEqual(newSession, oldSession);

    const old = cli(['transition', dir, '--from=implement', '--to=review'], { STATE_EXECUTION_ID: oldSession });
    assert.strictEqual(old.status, 3);
    assert.strictEqual(readState(dir).node, 'implement');
    const entry = conflicts(root).find(c => c.event === cas.SESSION_CONFLICT);
    assert.strictEqual(entry.expected_execution_id, oldSession.slice(0, 8));
    assert.strictEqual(entry.actual_execution_id, newSession.slice(0, 8));

    const cur = cli(['transition', dir, '--from=implement', '--to=review'], { STATE_EXECUTION_ID: newSession });
    assert.strictEqual(cur.status, 0, cur.stderr);
    assert.strictEqual(readState(dir).node, 'review');

    // O mesmo clique de "Retomar" repetido com a tela velha: STATE_CONFLICT, nada muda.
    assert.throws(() => cas.transact({ runDir: dir, operation: 'resume_session', expected_state_version: screen.expected_state_version, execution_id: screen.execution_id }, () => {}),
        e => cas.isConflict(e));
});

// ── 4. Dois writes simultâneos (processos) ───────────────────────────────────────

const RACER = `
const fs = require('fs');
const cas = require(${JSON.stringify(path.join(__dirname, 'cas.js'))});
const [dir, go, to, version] = process.argv.slice(2);
const cell = new Int32Array(new SharedArrayBuffer(4));
while (!fs.existsSync(go)) Atomics.wait(cell, 0, 0, 1);
try {
    const r = cas.transact({ runDir: dir, operation: 'node_transition', actor: 'racer-' + to, expected_state_version: Number(version), expected_node: 'review' }, s => { s.node = to; });
    process.stdout.write(JSON.stringify({ to, status: r.status }));
} catch (e) {
    process.stdout.write(JSON.stringify({ to, code: e.code || e.message }));
}
`;

function race(dir, go, to, version, script) {
    return new Promise(resolve => {
        const child = spawn(process.execPath, [script, dir, go, to, String(version)], { stdio: ['ignore', 'pipe', 'inherit'] });
        let out = '';
        child.stdout.on('data', d => { out += d; });
        child.on('exit', () => resolve(JSON.parse(out)));
    });
}

test('4. dois writes simultâneos: exatamente um persiste, o outro leva STATE_CONFLICT; state.json sempre íntegro', async () => {
    const script = path.join(sandbox, 'racer.js');
    fs.writeFileSync(script, RACER);
    for (let round = 0; round < 5; round++) {
        const { dir } = seedRun();
        const version = readState(dir).state_version;
        const go = path.join(dir, `go-${round}`);
        const runs = [race(dir, go, 'test', version, script), race(dir, go, 'implement', version, script)];
        await new Promise(r => setTimeout(r, 150)); // os dois parados na barreira
        fs.writeFileSync(go, '');
        const results = await Promise.all(runs);
        const winners = results.filter(r => r.status === 'applied');
        const losers = results.filter(r => r.code === cas.STATE_CONFLICT);
        assert.strictEqual(winners.length, 1, JSON.stringify(results));
        assert.strictEqual(losers.length, 1, JSON.stringify(results));
        const final = readState(dir); // JSON.parse não lança: nunca meio arquivo
        assert.strictEqual(final.node, winners[0].to);
        assert.strictEqual(final.state_version, version + 1);
        assert.ok(!fs.readdirSync(dir).some(f => /\.tmp$|\.lock$/.test(f)), 'sem tmp/lock sobrando');
    }
});

// ── 5. state_version obsoleto ────────────────────────────────────────────────────

test('5. expected_state_version=17 com o atual em 19 → STATE_CONFLICT com expected/actual; nada aplicado', () => {
    const { dir, root } = seedRun();
    for (let i = 0; i < 18; i++) sw.update(dir, s => { s.status = i % 2 ? 'in_progress' : 'running'; });
    assert.strictEqual(readState(dir).state_version, 19);
    const before = rawState(dir);
    assert.throws(() => cas.transact({ runDir: dir, operation: 'node_transition', expected_state_version: 17, expected_node: 'review' }, s => { s.node = 'test'; }),
        e => e.code === cas.STATE_CONFLICT && e.conflicts.some(c => c.field === 'state_version' && c.expected === 17 && c.actual === 19));
    assert.strictEqual(rawState(dir), before);
    const entry = conflicts(root).at(-1);
    assert.deepStrictEqual(
        { event: entry.event, operation: entry.operation, expected: entry.expected_state_version, actual: entry.actual_state_version, en: entry.expected_node, an: entry.actual_node },
        { event: 'STATE_CONFLICT', operation: 'node_transition', expected: 17, actual: 19, en: 'review', an: 'review' });
});

// ── 6. spec_hash obsoleto ────────────────────────────────────────────────────────

test('6. SPEC_CHANGE approval com expected_spec_hash divergente → STATE_CONFLICT; spec e state intactos', () => {
    const { dir, root, specFile } = seedSpecChange();
    const pending = readState(dir);
    const before = rawState(dir);
    const out = sc.approveSpecChange(dir, {
        by: 'Ana', expect: { ...cas.snapshotOf(pending), expected_spec_hash: 'f'.repeat(64), operation_id: `${pending.spec_change_pending.id}@${pending.task_id}` },
    });
    assert.strictEqual(out.ok, false);
    assert.strictEqual(out.code, cas.STATE_CONFLICT);
    assert.ok(out.conflicts.some(c => c.field === 'spec_hash'));
    assert.strictEqual(rawState(dir), before);
    assert.strictEqual(fs.readFileSync(specFile, 'utf8'), SPEC);
    const entry = conflicts(root).at(-1);
    assert.strictEqual(entry.operation, 'spec_change_approval');
    assert.strictEqual(entry.expected_spec_hash, 'ffffffff');
    assert.strictEqual(entry.actual_spec_hash.length, 8, 'spec_hash só com 8 chars no log');
});

// ── 7. Processo interrompido durante o write ─────────────────────────────────────

test('7. processo morto entre o fsync do tmp e o rename: state.json íntegro, tmp órfão descartado na inicialização', () => {
    const { dir } = seedRun();
    const before = rawState(dir);
    const crasher = path.join(sandbox, 'crasher.js');
    fs.writeFileSync(crasher, `
        const sw = require(${JSON.stringify(SW_CLI)});
        sw._testHooks.beforeRename = () => process.kill(process.pid, 'SIGKILL');
        sw.update(process.argv[2], s => { s.node = 'test'; });
    `);
    const r = spawnSync(process.execPath, [crasher, dir]);
    assert.strictEqual(r.signal, 'SIGKILL');
    assert.strictEqual(rawState(dir), before, 'state.json continua o anterior');
    const orphans = fs.readdirSync(dir).filter(f => /^state\.json\.\d+\.\d+\.tmp$/.test(f));
    assert.strictEqual(orphans.length, 1);
    assert.ok(fs.existsSync(path.join(dir, 'state.json.lock')), 'lock do processo morto ficou');
    fs.writeFileSync(path.join(dir, 'state.tmp'), '{"node":"lixo"'); // nome antigo/estrangeiro

    const removed = sw.cleanupOrphans(sw.runDirsOf(path.dirname(dir)));
    assert.deepStrictEqual(removed.map(f => path.basename(f)).sort(), [...orphans, 'state.json.lock', 'state.tmp'].sort());
    assert.strictEqual(rawState(dir), before, 'tmp nunca aplicado como estado');
    // Escrita seguinte não fica presa no lock do morto.
    assert.strictEqual(sw.update(dir, s => { s.node = 'test'; }).node, 'test');
});

test('7b. tmp de escrita em andamento de processo vivo não é apagado pelo cleanup', () => {
    const { dir } = seedRun();
    const live = path.join(dir, `state.json.${process.ppid}.1.tmp`);
    fs.writeFileSync(live, '{}');
    assert.deepStrictEqual(sw.cleanupOrphans([dir]), []);
    assert.ok(fs.existsSync(live));
});

// ── 8. Campo não crítico (heartbeat) ─────────────────────────────────────────────

test('8. heartbeat/eventos não incrementam state_version nem geram conflito falso', () => {
    const { dir, root } = seedRun();
    const screen = cas.snapshotOf(readState(dir));
    for (let i = 0; i < 5; i++) {
        sw.update(dir, s => { s.updated_at = new Date(Date.now() + i).toISOString(); s.events = [...(s.events || []), { type: 'heartbeat', ts: String(i) }]; });
    }
    assert.strictEqual(readState(dir).state_version, screen.expected_state_version);
    const r = cas.transact({ runDir: dir, operation: 'node_transition', expected_state_version: screen.expected_state_version, expected_node: 'review' }, s => { s.node = 'test'; });
    assert.strictEqual(r.status, 'applied');
    assert.strictEqual(readState(dir).events.length, 5, 'eventos preservados');
    assert.strictEqual(conflicts(root).length, 0);
});

test('8b. escrita de sistema com leitura-base: campo secundário de outro processo é preservado; crítico de outro, recusado', () => {
    const { dir } = seedRun();
    const base = readState(dir);
    const mine = structuredClone(base);
    mine.events = [{ type: 'mine' }];
    sw.update(dir, s => { s.events = [{ type: 'theirs' }]; s.cost_tracking = { x: 1 }; }); // outro processo, secundário
    sw.write(dir, mine, { base });
    const merged = readState(dir);
    assert.deepStrictEqual(merged.events.map(e => e.type), ['theirs', 'mine']);
    assert.deepStrictEqual(merged.cost_tracking, { x: 1 });

    const base2 = readState(dir);
    const mine2 = { ...structuredClone(base2), status: 'blocked' };
    sw.update(dir, s => { s.status = 'running'; }); // outro processo mexeu no MESMO campo crítico
    assert.throws(() => sw.write(dir, mine2, { base: base2 }), e => e.code === cas.STATE_CONFLICT);
    assert.strictEqual(readState(dir).status, 'running');
});

// ── 9. Retry do agente depois de STATE_CONFLICT ──────────────────────────────────

test('9. agente: STATE_CONFLICT → relê, revalida, tenta uma vez; segunda falha aborta e loga', () => {
    // a) versão andou por outro motivo, o nó ainda é o mesmo: a re-tentativa aplica.
    const a = seedRun();
    const stale = readState(a.dir).state_version;
    sw.update(a.dir, s => { s.status = 'running'; });
    const revalidate = s => (s.node === 'review' ? { expected_state_version: cas.effectiveVersion(s) } : null);
    const ok = cas.transactWithRetry({ runDir: a.dir, operation: 'node_transition', actor: 'agent', expected_state_version: stale, expected_node: 'review' },
        s => { s.node = 'test'; }, { revalidate });
    assert.strictEqual(ok.status, 'applied');
    assert.strictEqual(readState(a.dir).node, 'test');
    assert.deepStrictEqual(conflicts(a.root).map(c => c.event), ['STATE_CONFLICT']);

    // b) a operação não faz mais sentido (outro processo já moveu o nó): aborta sem 2ª tentativa.
    const b = seedRun();
    const v = readState(b.dir).state_version;
    sw.update(b.dir, s => { s.node = 'implement'; });
    assert.throws(() => cas.transactWithRetry({ runDir: b.dir, operation: 'node_transition', actor: 'agent', expected_state_version: v, expected_node: 'review' },
        s => { s.node = 'test'; }, { revalidate }), e => e.code === cas.STATE_CONFLICT);
    assert.strictEqual(readState(b.dir).node, 'implement');
    assert.deepStrictEqual(conflicts(b.root).map(c => c.event), ['STATE_CONFLICT', 'STATE_CONFLICT_ABORTED']);

    // c) conflito de novo na re-tentativa: aborta (sem 3ª) e loga.
    const c = seedRun();
    const v0 = readState(c.dir).state_version;
    sw.update(c.dir, s => { s.status = 'running'; });
    let attempts = 0;
    assert.throws(() => cas.transactWithRetry({ runDir: c.dir, operation: 'agent_retry', actor: 'agent', expected_state_version: v0, expected_node: 'review' },
        s => { attempts++; s.node = 'implement'; }, {
            revalidate: s => {
                const next = { expected_state_version: cas.effectiveVersion(s) };
                sw.update(c.dir, d => { d.status = d.status === 'running' ? 'in_progress' : 'running'; }); // corrida de novo
                return next;
            },
        }), e => e.code === cas.STATE_CONFLICT);
    assert.strictEqual(attempts, 0, 'mutator nunca aplicado');
    assert.deepStrictEqual(conflicts(c.root).map(e => e.event), ['STATE_CONFLICT', 'STATE_CONFLICT', 'STATE_CONFLICT_ABORTED']);

    // CLI (o que os templates usam): --retry incrementa retries na mesma escrita.
    const d = seedRun();
    sw.update(d.dir, s => { s.status = 'running'; }); // versão andou entre a leitura do agente e a escrita
    const out = cli(['transition', d.dir, '--from=review', '--to=implement', '--retry', `--expected-version=${readState(d.dir).state_version - 1}`], { STATE_EXECUTION_ID: d.state.execution_id });
    assert.strictEqual(out.status, 0, out.stderr);
    assert.deepStrictEqual([readState(d.dir).node, readState(d.dir).retries], ['implement', { review: 1 }]);
});

test('CLI set: aceita --set campo=valor (documentado) e --set=campo=valor', () => {
    const { dir } = seedRun({ status: 'spec-change-rejected', node: 'implement' });
    const spaced = cli(['set', dir, '--set', 'status=in_progress', '--set', 'node=review']);
    assert.strictEqual(spaced.status, 0, spaced.stderr);
    assert.deepStrictEqual([readState(dir).status, readState(dir).node], ['in_progress', 'review']);
    const inline = cli(['set', dir, '--set=node=implement']);
    assert.strictEqual(inline.status, 0, inline.stderr);
    assert.strictEqual(readState(dir).node, 'implement');
    const missing = cli(['set', dir, '--set']);
    assert.notStrictEqual(missing.status, 0);
    assert.match(missing.stderr, /--set sem campo=valor/);
});

// ── Idempotência das operações humanas (AC-05) ───────────────────────────────────

test('operação humana com operation_id: segunda vez already_processed; init de ciclo zera processed_operations', () => {
    const { dir } = seedRun();
    const v = readState(dir).state_version;
    const opts = { runDir: dir, operation: 'qa_retry', expected_state_version: v, operation_id: 'b3c1a0d2-qa' };
    assert.strictEqual(cas.transact(opts, s => { s.node = 'implement'; }).status, 'applied');
    assert.deepStrictEqual(cas.transact(opts, s => { s.node = 'plan'; }), { status: 'already_processed', operation_id: 'b3c1a0d2-qa' });
    assert.strictEqual(readState(dir).node, 'implement');
    assert.strictEqual(readState(dir).processed_operations[0].type, 'QA_RETRY');
    const restarted = sw.init(dir, readState(dir));
    assert.deepStrictEqual(restarted.processed_operations, []);
    assert.throws(() => cas.transact({ runDir: dir, operation: 'qa_retry', expected_state_version: restarted.state_version }, () => {}), /exige operation_id/);
});

// ── Auditoria (AC-08) ────────────────────────────────────────────────────────────

test('logs/state-conflicts.jsonl: append-only e sem segredo, AC, dado de usuário ou hash completo', () => {
    const { dir, root } = seedRun({
        spec_hash: 'c'.repeat(64), human_inputs: [{ content: 'senha do cliente: hunter2' }],
        acceptance: 'AC-01: Fretes com mais de 10 volumes',
    });
    process.env.REDMINE_API_KEY_TEST_ONLY = 'segredo-que-nao-pode-vazar';
    for (let i = 0; i < 3; i++) {
        try { cas.transact({ runDir: dir, operation: 'spec_change_approval', expected_state_version: 99, expected_spec_hash: 'd'.repeat(64), operation_id: `op-${i}-xxxxxxxx` }, () => {}); } catch { /* esperado */ }
    }
    delete process.env.REDMINE_API_KEY_TEST_ONLY;
    const text = fs.readFileSync(path.join(root, 'logs', cas.LOG_FILE), 'utf8');
    assert.strictEqual(text.trim().split('\n').length, 3, 'uma linha por evento, nenhuma sobrescrita');
    for (const banned of ['hunter2', 'Fretes', 'segredo-que-nao-pode-vazar', 'c'.repeat(9), 'd'.repeat(9)]) assert.ok(!text.includes(banned), banned);
    for (const e of conflicts(root)) {
        assert.deepStrictEqual(Object.keys(e).filter(k => !['event', 'timestamp', 'operation', 'task_id', 'actor', 'pid', 'expected_state_version', 'actual_state_version',
            'expected_node', 'actual_node', 'expected_spec_hash', 'actual_spec_hash', 'expected_execution_id', 'actual_execution_id', 'operation_id', 'conflicting_fields', 'reason'].includes(k)), []);
    }
});

// ── Varreduras estáticas (AC-02, AC-03) ──────────────────────────────────────────

const REPO = path.join(__dirname, '..');
function sources() {
    const out = [];
    const walk = d => {
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
            if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
            const p = path.join(d, e.name);
            if (e.isDirectory()) walk(p);
            else if (e.name.endsWith('.js') && !e.name.endsWith('.test.js')) out.push(p);
        }
    };
    walk(path.join(REPO, 'scripts'));
    walk(path.join(REPO, 'dashboard'));
    return out;
}

test('AC-03: só scripts/state-writer.js escreve state.json — nenhum writeFileSync/rename direto', () => {
    // Outros arquivos "state" que NÃO são o state.json do run.
    const allowed = [
        /memory-consolidator\.js:\d+: .*statePath/, // memory/consolidator-state.json
        /local-checkout\.js:\d+: .*stateFile/, // estado do checkout local (dashboard)
        /readmine-watcher\.js:\d+: .*STATE_FILE/, // log do watcher (saveWatcherLog)
    ];
    const hits = [];
    for (const file of sources()) {
        if (file === SW_CLI) continue;
        fs.readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
            const direct = /(writeFileSync|appendFileSync)\(\s*[^,]*(state\.json|statePath|stateFile|STATE_FILE|\bsf\b)/.test(line)
                || /(writeFileSync|appendFileSync)\(\s*path\.join\([^)]*state\.json/.test(line)
                || /renameSync\([^,]+,\s*[^)]*(state\.json|statePath|stateFile)/.test(line)
                || /writeJsonAtomic\([^,]*state\.json/.test(line);
            const at = `${path.relative(REPO, file)}:${i + 1}: ${line.trim()}`;
            if (direct && !allowed.some(re => re.test(at))) hits.push(at);
        });
    }
    assert.deepStrictEqual(hits, []);
});

test('AC-02: comparação de state_version / execution_id / expected_* só em scripts/cas.js', () => {
    const cmp = /(state_version|execution_id|expected_spec_hash|expectedVersion)\s*(===|!==|==|!=|<=|>=|<|>)(?!=)|(===|!==|<=|>=)\s*[\w.?]*\b(state_version|execution_id)\b/;
    const hits = [];
    for (const file of sources()) {
        if (file === path.join(__dirname, 'cas.js')) continue;
        if (file.includes(`${path.sep}public${path.sep}`)) continue; // dica visual do banner; a decisão é o CAS do servidor
        fs.readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
            if (cmp.test(line) && !/^\s*(\/\/|\*)/.test(line)) hits.push(`${path.relative(REPO, file)}:${i + 1}: ${line.trim()}`);
        });
    }
    assert.deepStrictEqual(hits, []);
});

// ── Regressões do /review (O1–O4) ────────────────────────────────────────────────

// Processo filho que disputa o lock N vezes. Dentro da seção crítica: cria o marcador
// "inside" com O_EXCL (falha = outro processo está dentro ao mesmo tempo), lê/incrementa
// um contador sem atomicidade própria e segura um pouco. Com exclusão mútua real, nunca
// há sobreposição e o contador fecha em N × processos.
const CONTENDER = `
const fs = require('fs');
const path = require('path');
const sw = require(${JSON.stringify(SW_CLI)});
const [dir, go, rounds, mode] = process.argv.slice(2);
const cell = new Int32Array(new SharedArrayBuffer(4));
const sleep = ms => Atomics.wait(cell, 0, 0, ms);
if (mode === 'slow-link') sw._testHooks.beforeLockLink = () => sleep(15); // janela larga antes do link
while (!fs.existsSync(go)) sleep(1);
let overlaps = 0;
for (let i = 0; i < Number(rounds); i++) {
    sw.withLock(dir, () => {
        const inside = path.join(dir, 'inside');
        try { fs.closeSync(fs.openSync(inside, 'wx')); } catch { overlaps++; }
        const counter = path.join(dir, 'counter');
        const n = Number(fs.existsSync(counter) ? fs.readFileSync(counter, 'utf8') : 0);
        sleep(2);
        fs.writeFileSync(counter, String(n + 1));
        try { fs.unlinkSync(inside); } catch { /* o outro apagou: sobreposição já contada */ }
    });
}
process.stdout.write(JSON.stringify({ overlaps }));
`;

function runContenders(dir, count, rounds, mode = '') {
    const script = path.join(sandbox, 'contender.js');
    fs.writeFileSync(script, CONTENDER);
    const go = path.join(dir, 'go');
    const children = Array.from({ length: count }, () => new Promise(resolve => {
        const c = spawn(process.execPath, [script, dir, go, String(rounds), mode], { stdio: ['ignore', 'pipe', 'pipe'] });
        let out = ''; let err = '';
        c.stdout.on('data', d => { out += d; });
        c.stderr.on('data', d => { err += d; });
        c.on('exit', code => resolve({ code, out, err }));
    }));
    setTimeout(() => fs.writeFileSync(go, ''), 200);
    return Promise.all(children);
}

test('O1. exclusão mútua do lock entre processos: nunca dois na seção crítica — janela antes do link alargada', async () => {
    const { dir } = seedRun();
    const results = await runContenders(dir, 4, 15, 'slow-link');
    for (const r of results) assert.strictEqual(r.code, 0, r.err);
    assert.strictEqual(results.reduce((a, r) => a + JSON.parse(r.out).overlaps, 0), 0, 'sobreposição na seção crítica');
    assert.strictEqual(fs.readFileSync(path.join(dir, 'counter'), 'utf8'), String(4 * 15), 'nenhuma atualização perdida');
    assert.ok(!fs.readdirSync(dir).some(f => /\.lock|\.tmp$/.test(f)), 'sem lock/tmp sobrando');
});

test('O1. a race do review: lock recém-criado ainda sem conteúdo NUNCA é tratado como abandonado', () => {
    const { dir } = seedRun();
    const lock = path.join(dir, 'state.json.lock');
    // Exatamente o instante que o review reproduziu: o lock existe e está vazio (criado
    // por openSync('wx') e ainda não escrito). O código antigo lia pid 0 → "morto" → apagava.
    fs.closeSync(fs.openSync(lock, 'wx'));
    const t0 = Date.now();
    assert.throws(() => sw.acquireLock(path.join(dir, 'state.json'), { timeoutMs: 300 }), e => e.code === 'STATE_LOCK_TIMEOUT');
    assert.ok(Date.now() - t0 >= 300, 'esperou o dono em vez de quebrar o lock');
    assert.ok(fs.existsSync(lock), 'lock do outro processo intacto');
    assert.deepStrictEqual(sw.cleanupOrphans([dir]), [], 'startup também não quebra lock jovem ilegível');
    // Só abandonado de verdade (ilegível e mais velho que LOCK_STALE_MS) é retomado.
    const old = (Date.now() - sw.LOCK_STALE_MS - 1000) / 1000;
    fs.utimesSync(lock, old, old);
    const unlock = sw.acquireLock(path.join(dir, 'state.json'), { timeoutMs: 300 });
    assert.match(fs.readFileSync(lock, 'utf8'), new RegExp(`^${process.pid} \\d+`));
    unlock();
});

test('O1. lock publicado já com conteúdo: no instante em que existe, tem "pid ts" — link atômico, EEXIST se ocupado', () => {
    const { dir } = seedRun();
    const lock = path.join(dir, 'state.json.lock');
    const seen = [];
    sw._testHooks.beforeLockLink = p => {
        seen.push({ existed: fs.existsSync(p), tmp: fs.readdirSync(dir).filter(f => /^state\.json\.lock\.\d+\.\d+\.tmp$/.test(f)).map(f => fs.readFileSync(path.join(dir, f), 'utf8')) });
    };
    try {
        const unlock = sw.acquireLock(path.join(dir, 'state.json'));
        assert.match(fs.readFileSync(lock, 'utf8'), new RegExp(`^${process.pid} \\d+\\n$`));
        unlock();
    } finally {
        sw._testHooks.beforeLockLink = null;
    }
    assert.strictEqual(seen.length, 1);
    assert.strictEqual(seen[0].existed, false, 'antes do link o lock não existe (nada vazio visível)');
    assert.match(seen[0].tmp[0], new RegExp(`^${process.pid} \\d+\\n$`), 'conteúdo pronto antes de publicar');
    assert.ok(!fs.readdirSync(dir).some(f => f.startsWith('state.json.lock')), 'tmp do lock e lock removidos');
});

test('O1. dono vivo não perde o lock por idade; dono morto é retomado — quebra serializada', () => {
    const { dir } = seedRun();
    const lock = path.join(dir, 'state.json.lock');
    const alive = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 5000)']);
    try {
        fs.writeFileSync(lock, `${alive.pid} ${Date.now() - 10 * 60 * 1000}\n`); // velho, mas dono vivo
        assert.throws(() => sw.acquireLock(path.join(dir, 'state.json'), { timeoutMs: 200 }), e => e.code === 'STATE_LOCK_TIMEOUT');
        assert.ok(fs.existsSync(lock));
    } finally {
        alive.kill('SIGKILL');
    }
    const dead = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' }).stdout;
    fs.writeFileSync(lock, `${dead} ${Date.now()}\n`);
    const unlock = sw.acquireLock(path.join(dir, 'state.json'), { timeoutMs: 500 });
    unlock();
    assert.ok(!fs.existsSync(`${lock}.break`), 'lock de quebra liberado');
});

test('O2. update e releaseNode depois do archive: null/false, sem ENOENT nem log de falha', () => {
    const { dir } = seedRun({ node: 'commit' });
    const lease = nodeLease.acquireNode(dir, { node: 'commit', timeoutMs: 60_000 });
    const target = path.join(path.dirname(dir), '_archive', path.basename(dir));
    sw.archive(dir, target, { mutator: s => { s.status = 'committed'; } });
    assert.strictEqual(sw.update(dir, s => { s.events = [1]; }), null);
    const errors = [];
    const orig = console.error;
    console.error = (...a) => errors.push(a.join(' '));
    try {
        assert.strictEqual(nodeLease.releaseNode(lease), false);
        assert.strictEqual(require('./lib/node-events').appendEvent(dir, { type: 'node_end', node: 'commit' }), false);
    } finally {
        console.error = orig;
    }
    assert.ok(!errors.some(e => /ENOENT/.test(e)), errors.join('\n'));
    assert.ok(!fs.existsSync(dir), 'update não recria a pasta');
    assert.strictEqual(readState(target).status, 'committed');
});

test('O2. run arquivado ENQUANTO o update esperava o lock → null; outros erros de fs continuam propagando', async () => {
    const { dir } = seedRun();
    const target = path.join(path.dirname(dir), '_archive', path.basename(dir));
    const holder = path.join(sandbox, 'archiver.js');
    fs.writeFileSync(holder, `
        const fs = require('fs');
        const sw = require(${JSON.stringify(SW_CLI)});
        const cell = new Int32Array(new SharedArrayBuffer(4));
        sw.withLock(process.argv[2], () => {
            fs.writeFileSync(process.argv[4], '');                 // avisa: lock na mão
            Atomics.wait(cell, 0, 0, 300);                          // o update fica esperando
            fs.mkdirSync(require('path').dirname(process.argv[3]), { recursive: true });
            fs.renameSync(process.argv[2], process.argv[3]);        // archive com o lock
        });
    `);
    const ready = path.join(sandbox, `ready-${seq}`);
    const child = spawn(process.execPath, [holder, dir, target, ready]);
    while (!fs.existsSync(ready)) await new Promise(r => setTimeout(r, 5));
    assert.strictEqual(sw.update(dir, s => { s.node = 'test'; }), null);
    await new Promise(r => child.on('exit', r));
    assert.ok(!fs.existsSync(dir));
    assert.strictEqual(readState(target).node, 'review', 'o arquivado não foi tocado');

    // Erro real de filesystem (sem permissão de escrita no run) não vira null.
    const other = seedRun();
    fs.chmodSync(other.dir, 0o500);
    try {
        assert.throws(() => sw.update(other.dir, s => { s.node = 'test'; }), e => e.code === 'EACCES');
    } finally {
        fs.chmodSync(other.dir, 0o755);
    }
});

test('O3. A lê, B arquiva, A escreve com a base antiga: STATE_CONFLICT e o run NÃO reaparece em memory/runs', () => {
    const { dir, root } = seedRun();
    const read = readState(dir);                                       // 1. processo A lê
    const target = path.join(path.dirname(dir), '_archive', path.basename(dir));
    sw.archive(dir, target, { expect: { expected_state_version: read.state_version, expected_node: read.node, execution_id: read.execution_id } }); // 2. B arquiva
    const mine = { ...structuredClone(read), events: [{ type: 'late' }] };
    assert.throws(() => sw.write(dir, mine, { base: read }), e => e.code === cas.STATE_CONFLICT);          // 3. A escreve com base
    assert.throws(() => sw.write(dir, { ...read, node: 'test' }), e => e.code === cas.STATE_CONFLICT);   //    ...ou objeto inteiro lido
    assert.ok(!fs.existsSync(dir), '4. run não ressuscita');
    assert.strictEqual(fs.readdirSync(path.dirname(dir)).filter(n => !n.startsWith('_')).length, 0);
    assert.ok(!('events' in readState(target)));
    const gone = conflicts(root).filter(c => c.actual_state_version === null);
    assert.strictEqual(gone.length, 2, 'as duas escritas obsoletas logadas');
    assert.deepStrictEqual([gone[0].event, gone[0].expected_state_version], ['STATE_CONFLICT', read.state_version]);

    // Criação legítima continua: init() e write() de objeto novo (sem state_version).
    const fresh = path.join(path.dirname(dir), '90999-novo');
    assert.strictEqual(sw.write(fresh, { task_id: '90999-novo', node: 'plan', history: [], status: 'in_progress' }).state_version, 1);
    assert.ok(sw.init(path.join(path.dirname(dir), '90998-novo'), { task_id: '90998-novo', node: 'plan', history: [], status: 'in_progress' }).execution_id);
});

test('O3. escritor do watcher — readBases com run arquivado no meio: recusa sem recriar', () => {
    const { dir } = seedRun();
    const s = readState(dir);
    fs.renameSync(dir, path.join(path.dirname(dir), `${path.basename(dir)}-movido`));
    assert.throws(() => sw.write(dir, { ...s, status: 'blocked' }, { base: s, operation: 'watcher_write', actor: 'watcher' }), e => cas.isConflict(e));
    assert.ok(!fs.existsSync(dir));
});

// N processos com o MESMO operation_id ao mesmo tempo: só um reserva (decisão dentro do lock).
const RESERVER = `
const fs = require('fs');
const cas = require(${JSON.stringify(path.join(__dirname, 'cas.js'))});
const [dir, go, version, hash] = process.argv.slice(2);
const cell = new Int32Array(new SharedArrayBuffer(4));
while (!fs.existsSync(go)) Atomics.wait(cell, 0, 0, 1);
const r = cas.reserveOperation({ runDir: dir, operation: 'spec_change_approval', actor: 'dash-' + process.pid,
    expected_state_version: Number(version), expected_spec_hash: hash === '-' ? null : hash, operation_id: 'dashboard:same-click-0001' });
process.stdout.write(r.status);
`;

test('O4. reserva do operation_id é exclusiva entre processos: 1 reserved, demais in_progress; done → already_processed', async () => {
    const { dir } = seedRun({ spec_hash: 'e'.repeat(64) });
    const script = path.join(sandbox, 'reserver.js');
    fs.writeFileSync(script, RESERVER);
    const go = path.join(dir, 'go-reserve');
    const v = String(readState(dir).state_version);
    const runs = Array.from({ length: 6 }, () => new Promise(resolve => {
        const c = spawn(process.execPath, [script, dir, go, v, 'e'.repeat(64)], { stdio: ['ignore', 'pipe', 'inherit'] });
        let out = '';
        c.stdout.on('data', d => { out += d; });
        c.on('exit', () => resolve(out));
    }));
    setTimeout(() => fs.writeFileSync(go, ''), 200);
    const statuses = (await Promise.all(runs)).sort();
    assert.deepStrictEqual(statuses, ['in_progress', 'in_progress', 'in_progress', 'in_progress', 'in_progress', 'reserved']);
    assert.strictEqual(readState(dir).state_version, Number(v), 'reserva é campo secundário');
    assert.strictEqual(readState(dir).pending_operations.length, 1);

    const ctx = { runDir: dir, operation: 'spec_change_approval', operation_id: 'dashboard:same-click-0001' };
    cas.finishOperation(ctx, 'done');
    assert.ok(!('pending_operations' in readState(dir)));
    const again = cas.reserveOperation({ ...ctx, expected_state_version: Number(v), expected_spec_hash: 'e'.repeat(64) });
    assert.strictEqual(again.status, 'already_processed');
});

test('O4. desfechos da reserva: failed libera nova tentativa; uncertain e reserva vencida voltam como reclaimed', () => {
    const { dir } = seedRun();
    const base = () => ({ runDir: dir, operation: 'spec_approval', expected_state_version: readState(dir).state_version, expected_spec_hash: null, operation_id: 'dashboard:op-xyz-0001' });
    assert.deepStrictEqual(cas.reserveOperation(base()), { status: 'reserved', reclaimed: false, previous: null });
    assert.strictEqual(cas.reserveOperation(base()).status, 'in_progress');
    cas.finishOperation(base(), 'failed');                                          // 4xx: certamente não gravou
    assert.strictEqual(cas.reserveOperation(base()).reclaimed, false);
    cas.finishOperation(base(), 'uncertain');                                       // timeout/5xx: pode ter gravado
    const r = cas.reserveOperation(base());
    assert.deepStrictEqual([r.status, r.reclaimed, r.previous.uncertain], ['reserved', true, true]);
    const later = Date.now() + cas.RESERVATION_TTL_MS + 1000;                       // dono morreu no meio
    const stale = cas.reserveOperation(base(), { now: later });
    assert.deepStrictEqual([stale.status, stale.reclaimed], ['reserved', true]);
});
