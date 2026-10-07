// Replay de ciclo a partir de um nó (scripts/replay-cycle.js, botão "↩ Retomar a partir
// de" do dashboard). Ciclo que falha tarde (ex: no test) não precisa recomeçar do
// fetch_ticket: o replay reaproveita o que os nós anteriores já produziram e re-despacha
// só do nó pedido em diante.
//
// Modelo: o replay é um RUN NOVO (<task-id>-replay-<n>) no MESMO worktree do ticket —
// nunca reescreve o run original. Motivos:
//   - state.json original fica intacto (restrição da task); ao lado dele só entra
//     state-replay-<replay-task-id>.json, o registro do replay (snapshot do estado com
//     que ele nasceu) — é também o vínculo original → replay;
//   - o dashboard identifica run pelo nome do diretório, então "link pro run original"
//     só existe se o replay tiver id próprio;
//   - cost_tracking do replay nasce zerado: dá pra comparar o custo do replay com o do
//     ciclo inteiro.
// O diff do implement não é artefato de run: vive no working tree do worktree, que é o
// mesmo — por isso replay a partir do test não perde a implementação.
//
// Tudo que fala com o mundo (Redmine, despacho do agente, git) entra por hook — os
// testes rodam contra fixtures sintéticos sem watcher nem Redmine.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { readAndValidateState, validateState } = require('../validate-state');
const invalidate = require('../invalidate');
const cas = require('../cas');
const stateWriter = require('../state-writer');

// Ordem do grafo (.graph/graph.yaml) — fetch_ticket não é ponto de replay: re-buscar o
// ticket é começar do zero, que é justamente o que o replay evita.
const REPLAY_NODES = ['plan', 'implement', 'review', 'test', 'verify', 'commit'];

// Status em que o run parou de andar sozinho (terminal ou esperando humano) — só esses
// aceitam replay. in_progress/running: o watcher ainda está conduzindo o ciclo, e um
// replay por cima seria dois agentes no mesmo worktree. state_corrupted: não dá pra
// reconstruir estado a partir de um state.json em que ninguém confia.
const REPLAYABLE_STATUSES = new Set([
    'committed', 'fully_merged', 'completed',
    'blocked', 'escalated', 'needs_human_review',
    'spec-invalid', 'pre-build-failed', 'plan-escalation', 'churn-escalation',
]);

// Campos do state.json que pertencem a um nó: se o nó vai rodar de novo, o valor
// antigo é descartado (senão o portão/veredito do ciclo original vazaria pro replay).
const NODE_STATE_FIELDS = {
    plan: ['selected_context', 'scope', 'planScore', 'planAttempts', 'planFeedback', 'planScoreThreshold',
        'planSignature', 'planAccepted', 'planEscalationNotifiedAt'],
    implement: ['preBuildStatus', 'preBuildErrors', 'preBuildDurationMs', 'preBuildAt', 'preBuildFingerprint',
        'preBuildAccepted', 'preBuildSkipReason', 'preBuildJavaHome', 'churnReport', 'churnAccepted',
        'churnEscalationNotifiedAt'],
    review: ['review_verdict'],
    test: ['test_result'],
    verify: ['verify_verdict', 'risk_level', 'risk_reason'],
    commit: ['pull_request', 'pull_requests'],
};

// Campos de execução do ciclo original (lease, órfão, erro, custo) — nunca vão pro replay.
const RUNTIME_FIELDS = ['node_started_at', 'node_timeout_ms', 'agent_pid', 'recovered_from_orphan',
    'state_error', 'cost_tracking', 'spec_pending_approval', 'pending_invalidation'];

// Arquivos que um nó deixa no diretório do run. Convenção dos comandos: <nó>.md,
// <nó>-results.md, <nó>-*.json etc., mais codex-result-<nó>.md (legado do Codex) e os
// marcadores/pastas específicos abaixo.
const NODE_ARTIFACT_EXTRAS = {
    implement: [/^\.pre-build-notified\.json$/, /^\.churn[-.]/],
    verify: [/^screenshots$/],
};

// Nunca removidos: estado e contexto compartilhados entre nós. handoff.md é reescrito
// por cada nó pro seguinte — não dá pra voltar à versão de um nó anterior, então o
// prompt do replay avisa o agente que ele pode descrever nós que serão refeitos.
const PRESERVED = [/^state\.json$/, /^context\.md$/, /^handoff\.md$/, /^context\.pre-sumarizacao-.*\.md$/, /^human-input\.md$/];

// Nem copiados pro replay: registros de replay do próprio original, marcador de
// notificação (o replay tem que poder avisar de novo), sobras de escrita atômica,
// human-input em processamento e backups de state corrompido.
const NOT_CARRIED = [/^state-replay-.*\.json$/, /^\.watcher-notified\.json$/, /\.tmp$/, /^human-input\.\d+\.processing$/,
    /^state\.json\.corrupted-/, /^\.DS_Store$/];

class ReplayError extends Error {
    constructor(message, code = 'replay_invalid') {
        super(message);
        this.code = code;
    }
}

function assertNode(fromNode) {
    if (!REPLAY_NODES.includes(fromNode)) {
        throw new ReplayError(`nó inválido "${fromNode}" — válidos: ${REPLAY_NODES.join(', ')}`, 'invalid_node');
    }
}

function repoPathOf(opts = {}) {
    return opts.repoPath || process.env.REPO_PATH || process.cwd();
}

function ticketIdOf(taskId) {
    const m = String(taskId).match(/^(\d{4,6})-/);
    return m ? Number(m[1]) : null;
}

function rootTaskIdOf(taskId) {
    return String(taskId).replace(/-replay-\d+$/, '');
}

// De que nós é possível retomar este run: status parado + todos os nós anteriores ao
// escolhido já visitados (history). Reaproveitado pelo dashboard pra montar o dropdown.
function replayOptions(state) {
    if (!state || typeof state !== 'object') return { replayable: false, reason: 'state.json ausente ou inválido', nodes: [] };
    if (state.status === 'state_corrupted') return { replayable: false, reason: 'state.json marcado como corrompido', nodes: [] };
    const stopped = REPLAYABLE_STATUSES.has(state.status) || state.node === 'escalated';
    if (!stopped) {
        return { replayable: false, reason: `run ainda andando (status "${state.status}") — replay só em run parado`, nodes: [] };
    }
    const visited = new Set(Array.isArray(state.history) ? state.history : []);
    const nodes = REPLAY_NODES.filter((n, i) => REPLAY_NODES.slice(0, i).every(prev => visited.has(prev)));
    return nodes.length
        ? { replayable: true, reason: null, nodes }
        : { replayable: false, reason: 'history sem nenhum nó do ciclo', nodes: [] };
}

// history até o nó anterior ao de retomada (inclusive a última passada dele — num
// ciclo com loop review→implement, as rodadas anteriores continuam sendo história
// verdadeira). plan: até o fetch_ticket, se houver.
function historyBefore(history, fromNode) {
    const list = Array.isArray(history) ? history : [];
    const idx = REPLAY_NODES.indexOf(fromNode);
    const prev = idx === 0 ? 'fetch_ticket' : REPLAY_NODES[idx - 1];
    const cut = list.lastIndexOf(prev);
    return cut === -1 ? [] : list.slice(0, cut + 1);
}

// Estado com que o replay nasce: o do original, com history cortado antes do nó de
// retomada e sem nada que pertença aos nós que vão rodar de novo. Pura (sem I/O).
function reconstructState(original, fromNode, { replayTaskId, originalRun, now = new Date().toISOString() }) {
    assertNode(fromNode);
    const state = JSON.parse(JSON.stringify(original));
    const rerun = REPLAY_NODES.slice(REPLAY_NODES.indexOf(fromNode));
    const reset = [];
    for (const field of [...RUNTIME_FIELDS, ...rerun.flatMap(n => NODE_STATE_FIELDS[n])]) {
        if (field in state) { delete state[field]; reset.push(field); }
    }
    if (state.retries && typeof state.retries === 'object') {
        for (const n of rerun) delete state.retries[n];
    }
    if (typeof state.handoff_path === 'string') {
        state.handoff_path = state.handoff_path.replace(/memory\/runs\/(?:_archive\/)?[^/]+\//, `memory/runs/${replayTaskId}/`);
    }
    Object.assign(state, {
        task_id: replayTaskId,
        node: fromNode,
        status: 'in_progress',
        history: historyBefore(original.history, fromNode),
        started_at: now,
        updated_at: now,
        replayOf: { originalRun, fromNode, replayedAt: now },
        events: [{ type: 'replay', node: fromNode, at: now, detail: `replay de ${originalRun} a partir do nó ${fromNode}` }],
    });
    return { state, reset };
}

// Onde está o run: sempre no worktree do ticket (é lá que o watcher lê), ativo ou
// arquivado. Replay de run fora de worktree de ticket não existe — não há onde rodar.
function locateRun(taskId, opts = {}) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(String(taskId || ''))) {
        throw new ReplayError(`task-id inválido: "${taskId}"`, 'invalid_task');
    }
    const ticketId = ticketIdOf(taskId);
    if (!ticketId) throw new ReplayError(`task-id "${taskId}" não começa com número de ticket — replay só vale pra run do watcher`, 'invalid_task');
    const repoPath = repoPathOf(opts);
    const worktree = path.join(repoPath, '.claude', 'worktrees', String(ticketId));
    const runsDir = path.join(worktree, 'memory', 'runs');
    for (const [dir, archived] of [[path.join(runsDir, taskId), false], [path.join(runsDir, '_archive', taskId), true]]) {
        if (fs.existsSync(path.join(dir, 'state.json'))) return { taskId, ticketId, repoPath, worktree, runsDir, dir, archived };
    }
    throw new ReplayError(`memory/runs/${taskId}/state.json não encontrado no worktree do ticket #${ticketId} (${runsDir})`, 'not_found');
}

function readOriginalState(run) {
    const check = readAndValidateState(run.taskId, { dir: run.dir, silent: true });
    if (!check.valid) {
        throw new ReplayError(`memory/runs/${run.taskId}/state.json ilegível: ${check.errors.join('; ')}`, 'state_invalid');
    }
    return check.state;
}

function nextReplayTaskId(run) {
    const root = rootTaskIdOf(run.taskId);
    const re = new RegExp(`^${root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-replay-(\\d+)$`);
    let max = 0;
    for (const dir of [run.runsDir, path.join(run.runsDir, '_archive')]) {
        let names = [];
        try { names = fs.readdirSync(dir); } catch { continue; }
        for (const name of names) {
            const m = name.match(re);
            if (m) max = Math.max(max, Number(m[1]));
        }
    }
    return `${root}-replay-${max + 1}`;
}

// Estado reconstruído até o nó anterior ao de retomada. Valida que o state.json do
// original existe, é legível e está num status que aceita replay a partir desse nó.
function loadStateForReplay(taskId, fromNode, opts = {}) {
    assertNode(fromNode);
    const original = locateRun(taskId, opts);
    const originalState = readOriginalState(original);
    const options = replayOptions(originalState);
    if (!options.replayable) throw new ReplayError(`${taskId}: ${options.reason}`, 'not_replayable');
    if (!options.nodes.includes(fromNode)) {
        const missing = REPLAY_NODES.slice(0, REPLAY_NODES.indexOf(fromNode)).filter(n => !(originalState.history || []).includes(n));
        throw new ReplayError(`${taskId}: não dá pra retomar do "${fromNode}" — o ciclo original nunca passou por ${missing.join(', ')}`, 'not_replayable');
    }
    const replayTaskId = nextReplayTaskId(original);
    let built = reconstructState(originalState, fromNode, { replayTaskId, originalRun: taskId, now: opts.now });
    // Replay usa a Spec ATIVA, não a do run original (scripts/invalidate.js checkReplay):
    // spec mudou → tudo STALE e recomeça no plan; matriz STALE/legada → recomeça no test.
    // Evidence antiga nunca é reaproveitada como VALID.
    const spec = specCheckForReplay(original, originalState, built.state, fromNode, opts);
    if (spec.effectiveFrom !== fromNode) {
        built = reconstructState(originalState, spec.effectiveFrom, { replayTaskId, originalRun: taskId, now: opts.now });
        specCheckForReplay(original, originalState, built.state, fromNode, opts);
        built.state.replayOf.requestedFrom = fromNode;
    }
    if (spec.warnings.length || spec.evidence) {
        built.state.replayOf.specCheck = { active_spec_hash: spec.activeHash, active_spec_version: spec.activeVersion, evidence: spec.evidence, warnings: spec.warnings };
    }
    return { original, originalState, replayTaskId, state: built.state, reset: built.reset, specWarnings: spec.warnings };
}

// Aplica (muta `state`) a checagem da spec ativa; devolve o nó efetivo e os avisos.
function specCheckForReplay(original, originalState, state, fromNode, opts = {}) {
    let active = { hash: null, version: null };
    try { active = (opts.activeSpec || invalidate.activeSpec)(original.worktree, originalState, original.taskId); } catch { /* sem spec legível: nada a conferir */ }
    let evidenceData = null;
    try { evidenceData = JSON.parse(fs.readFileSync(path.join(original.dir, invalidate.EVIDENCE_FILE), 'utf8')); } catch { /* sem matriz */ }
    const out = invalidate.checkReplay(state, { activeHash: active.hash, activeVersion: active.version, evidenceData, fromNode, at: opts.now });
    return { ...out, activeHash: active.hash, activeVersion: active.version };
}

function isNodeArtifact(name, node) {
    if (name === `codex-result-${node}.md`) return true;
    if (new RegExp(`^${node}([-_.].*)?$`).test(name)) return true;
    return (NODE_ARTIFACT_EXTRAS[node] || []).some(re => re.test(name));
}

// Divide as entradas de um diretório de run em removidas (artefato de um nó que vai
// rodar de novo) e mantidas. Pura sobre a lista de nomes.
function classifyArtifacts(names, fromNode) {
    assertNode(fromNode);
    const rerun = REPLAY_NODES.slice(REPLAY_NODES.indexOf(fromNode));
    const remove = [], keep = [];
    for (const name of [...names].sort()) {
        if (NOT_CARRIED.some(re => re.test(name))) continue;
        if (PRESERVED.some(re => re.test(name))) { keep.push(name); continue; }
        (rerun.some(n => isNodeArtifact(name, n)) ? remove : keep).push(name);
    }
    return { remove, keep };
}

// Remove do run de REPLAY os artefatos dos nós a re-executar (ex: from=test tira
// test-results.md e mantém plan.md). Recusa run sem replayOf: o original nunca perde
// arquivo por aqui. dryRun: só lista.
function cleanArtifactsFrom(taskId, fromNode, opts = {}) {
    assertNode(fromNode);
    const run = locateRun(taskId, opts);
    if (run.archived) throw new ReplayError(`${taskId} está arquivado — não limpo artefato de run arquivado`, 'not_replay');
    const state = readOriginalState(run);
    if (!state.replayOf && !opts.force) {
        throw new ReplayError(`${taskId} não é um replay (sem replayOf) — cleanArtifactsFrom só mexe em run de replay`, 'not_replay');
    }
    const { remove, keep } = classifyArtifacts(fs.readdirSync(run.dir), fromNode);
    if (!opts.dryRun) for (const name of remove) fs.rmSync(path.join(run.dir, name), { recursive: true, force: true });
    return { removed: remove, kept: keep, dir: run.dir };
}

function defaultWorktreeRegistered(repoPath, worktree) {
    try {
        const out = execFileSync('git', ['-C', repoPath, 'worktree', 'list', '--porcelain'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
        const real = fs.realpathSync(worktree);
        return out.split('\n').some(l => l.startsWith('worktree ') && (() => {
            try { return fs.realpathSync(l.slice('worktree '.length)) === real; } catch { return false; }
        })());
    } catch {
        return false;
    }
}

// O worktree do ciclo original tem que existir de verdade (diretório + registrado no
// git): o replay depende do diff do implement que está lá.
function assertWorktree(run, opts = {}) {
    if (!fs.existsSync(run.worktree)) {
        throw new ReplayError(`worktree do ciclo original não existe mais: ${run.worktree}`, 'worktree_missing');
    }
    const registered = (opts.worktreeRegistered || defaultWorktreeRegistered)(run.repoPath, run.worktree);
    if (!registered) {
        throw new ReplayError(`${run.worktree} existe mas não está registrado em \`git worktree list\` — rode \`git worktree prune\` e confira`, 'worktree_missing');
    }
}

// Outra task do mesmo ticket andando no worktree = replay criaria dois ciclos
// concorrentes no mesmo working tree.
function assertNoActiveCycle(run) {
    const prefix = `${run.ticketId}-`;
    let names = [];
    try { names = fs.readdirSync(run.runsDir, { withFileTypes: true }); } catch { return; }
    for (const d of names) {
        if (!d.isDirectory() || !d.name.startsWith(prefix) || d.name === run.taskId) continue;
        const check = readAndValidateState(d.name, { dir: path.join(run.runsDir, d.name), silent: true });
        const status = check.state?.status;
        if (status === 'in_progress' || status === 'running') {
            throw new ReplayError(`ticket #${run.ticketId} já tem ciclo andando (${d.name}, status "${status}") — espere terminar ou arquive antes do replay`, 'active_cycle');
        }
    }
}

// Tudo o que o dry-run mostra, sem escrever nada.
function planReplay(taskId, fromNode, opts = {}) {
    const loaded = loadStateForReplay(taskId, fromNode, opts);
    const { original } = loaded;
    const warnings = [...loaded.specWarnings];
    fromNode = loaded.state.node; // nó efetivo (a spec ativa pode recuar o replay)
    try { assertWorktree(original, opts); } catch (e) { warnings.push(e.message); }
    try { assertNoActiveCycle(original); } catch (e) { warnings.push(e.message); }
    // commit sempre está entre os nós refeitos (é o último do grafo).
    if (loaded.originalState.pull_request) {
        warnings.push('o ciclo original já abriu PR — o /commit do replay roda de novo (confira se não duplica o PR)');
    }
    const { remove, keep } = classifyArtifacts(fs.readdirSync(original.dir), fromNode);
    const idx = REPLAY_NODES.indexOf(fromNode);
    return {
        originalRun: taskId,
        originalDir: original.dir,
        originalArchived: original.archived,
        replayTaskId: loaded.replayTaskId,
        replayDir: path.join(original.runsDir, loaded.replayTaskId),
        worktree: original.worktree,
        fromNode,
        nodesToRun: REPLAY_NODES.slice(idx),
        nodesKept: REPLAY_NODES.slice(0, idx),
        artifactsToRemove: remove,
        artifactsKept: keep,
        stateFieldsReset: loaded.reset,
        historyKept: loaded.state.history,
        warnings,
        state: loaded.state,
    };
}

function copyRunDir(src, dst) {
    fs.mkdirSync(dst);
    for (const d of fs.readdirSync(src, { withFileTypes: true })) {
        // state.json nasce pelo state-writer; lock/tmp do state-writer nunca são copiados.
        if (d.name === 'state.json' || /^state\.json\..*(lock|tmp)$/.test(d.name) || NOT_CARRIED.some(re => re.test(d.name))) continue;
        fs.cpSync(path.join(src, d.name), path.join(dst, d.name), { recursive: true });
    }
}

function writeJsonAtomic(file, value) {
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
    fs.renameSync(tmp, file);
}

function replayNote(originalRun, fromNode, replayTaskId) {
    return `[Watcher] Replay iniciado a partir do nó ${fromNode} — ciclo original: ${originalRun} ` +
        `(novo run: ${replayTaskId}; nós anteriores a ${fromNode} reaproveitados, não re-executados).`;
}

// Cria o run de replay e re-despacha o ciclo a partir de fromNode. `state` = o estado
// reconstruído por loadStateForReplay (state.task_id já é o id do replay).
// Hooks (opts): postNote(ticketId, text) e dispatch({ ticketId, taskId, state }) —
// falha em qualquer um dos dois não desfaz o replay: o run já está in_progress e o
// próximo tick do watcher o despacha normalmente.
async function replayFrom(taskId, fromNode, state, opts = {}) {
    assertNode(fromNode);
    if (!state?.replayOf || state.replayOf.originalRun !== taskId || (state.node !== fromNode && state.replayOf.requestedFrom !== fromNode)) {
        throw new ReplayError('estado de replay inconsistente — gere com loadStateForReplay(taskId, fromNode)', 'invalid_state');
    }
    fromNode = state.node; // nó efetivo: a spec ativa pode ter recuado o replay (plan/test)
    const original = locateRun(taskId, opts);
    const originalState = readOriginalState(original); // ainda legível (pode ter mudado desde o load)
    assertWorktree(original, opts);
    assertNoActiveCycle(original);
    const check = validateState(state);
    if (!check.valid) throw new ReplayError(`estado de replay fora do schema: ${check.errors.join('; ')}`, 'invalid_state');

    const replayTaskId = state.task_id;
    const replayDir = path.join(original.runsDir, replayTaskId);
    if (fs.existsSync(replayDir)) throw new ReplayError(`${replayDir} já existe — replay duplicado?`, 'replay_exists');

    // CAS no run original (scripts/cas.js, operação replay): o que o dashboard carregou
    // (opts.expect) ou, sem isso, o que acabou de ser lido. Lock segurado até o run novo
    // existir — ninguém avança o original no meio da cópia.
    const { expected_state_version, expected_node, execution_id } = cas.expectations(cas.snapshotOf(originalState), opts.expect);
    let lock;
    try {
        lock = cas.validateAndLock({
            runDir: original.dir, operation: 'replay', actor: opts.actor || 'replay',
            expected_state_version, expected_node, execution_id,
        });
    } catch (e) {
        if (cas.isConflict(e)) throw new ReplayError(e.message, e.code);
        throw e;
    }
    try {
        copyRunDir(original.dir, replayDir);
    } catch (e) {
        lock.release();
        throw e;
    }
    let cleaned;
    try {
        // Artefatos copiados agora: stale_since depois da cópia, senão refreshStale os
        // trataria como regerados (mtime da cópia > stale_since).
        if (Array.isArray(state.stale_artifacts) && state.stale_artifacts.length) state.stale_since = new Date().toISOString();
        // Run novo = execução nova: execution_id próprio, processed_operations zerado.
        Object.assign(state, stateWriter.init(replayDir, state));
        invalidate.syncEvidenceFile(replayDir, state); // cópia da matriz STALE marcada; a do original fica intacta
        cleaned = cleanArtifactsFrom(replayTaskId, fromNode, opts);
        // Registro do replay ao lado do state.json original (que não é tocado).
        writeJsonAtomic(path.join(original.dir, `state-replay-${replayTaskId}.json`), state);
    } catch (e) {
        fs.rmSync(replayDir, { recursive: true, force: true });
        throw e;
    } finally {
        lock.release();
    }

    const warnings = [...(state.replayOf?.specCheck?.warnings || [])];
    let redmine = false;
    if (opts.postNote) {
        try {
            redmine = (await opts.postNote(original.ticketId, replayNote(taskId, fromNode, replayTaskId))) !== false;
            if (!redmine) warnings.push('comentário no Redmine não foi postado (ver log)');
        } catch (e) {
            warnings.push(`falha comentando no Redmine: ${e.message}`);
        }
    }
    let dispatch = null;
    if (opts.dispatch) {
        try {
            dispatch = await opts.dispatch({ ticketId: original.ticketId, taskId: replayTaskId, state });
        } catch (e) {
            warnings.push(`falha no despacho (o próximo tick do watcher retoma): ${e.message}`);
        }
    }
    return {
        ok: true,
        originalRun: taskId,
        replayTaskId,
        replayDir,
        worktree: original.worktree,
        fromNode,
        nodesToRun: REPLAY_NODES.slice(REPLAY_NODES.indexOf(fromNode)),
        removed: cleaned.removed,
        redmine,
        dispatch,
        warnings,
    };
}

// Nota pro prompt de todo nó despachado num run de replay (dispatchTicket do watcher):
// context.md/handoff.md vieram do ciclo original e podem descrever resultado de nós
// que agora vão rodar de novo — o agente não pode tomar aquilo como já feito.
function replayPromptNote(state) {
    const r = state?.replayOf;
    if (!r?.originalRun || !REPLAY_NODES.includes(r.fromNode)) return '';
    const rerun = REPLAY_NODES.slice(REPLAY_NODES.indexOf(r.fromNode));
    return ` Este run é um REPLAY de ${r.originalRun} retomado a partir do nó ${r.fromNode}: os nós anteriores ` +
        `(${REPLAY_NODES.slice(0, REPLAY_NODES.indexOf(r.fromNode)).join(', ') || 'nenhum'}) foram reaproveitados do ciclo ` +
        `original e a implementação dele já está no working tree. context.md e handoff.md foram copiados do original e ` +
        `podem registrar resultados de ${rerun.join('/')} daquele ciclo — trate-os como histórico, refaça esses nós de ` +
        'verdade e não conclua nada só porque o texto antigo diz que passou.';
}

// true se este run foi substituído por um replay que ainda existe — o watcher deixa de
// tratá-lo como task ativa do ticket (senão, quando o replay fosse arquivado pelo
// /commit, o original parado voltaria a ser "a task ativa" e a notificar bloqueio).
function supersededBy(dir) {
    let names = [];
    try { names = fs.readdirSync(dir); } catch { return null; }
    const runsDir = path.basename(path.dirname(dir)) === '_archive' ? path.dirname(path.dirname(dir)) : path.dirname(dir);
    for (const name of names) {
        const m = name.match(/^state-replay-(.+)\.json$/);
        if (!m) continue;
        if (fs.existsSync(path.join(runsDir, m[1])) || fs.existsSync(path.join(runsDir, '_archive', m[1]))) return m[1];
    }
    return null;
}

module.exports = {
    REPLAY_NODES, REPLAYABLE_STATUSES, NODE_STATE_FIELDS, ReplayError,
    replayOptions, historyBefore, reconstructState, classifyArtifacts,
    locateRun, loadStateForReplay, cleanArtifactsFrom, planReplay, replayFrom, replayNote, replayPromptNote, supersededBy,
};
