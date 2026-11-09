// "Lease" de nó em execução + recuperação de nó órfão (ver
// memory/decisions/2026-09-22-recuperacao-no-orfao-watcher.md).
//
// Antes de despachar um agente pra uma task ativa, o watcher grava em state.json
// status="running" + node_started_at + node_timeout_ms (+ agent_pid logo depois do
// spawn). Quando o agente sai, releaseNode devolve status pra "in_progress" — a não
// ser que o próprio comando tenha gravado outro status (blocked/escalated/committed/
// spec-invalid), que sempre prevalece. Os comandos (.claude/commands/*.md) nunca
// gravam "in_progress" ao terminar um nó com sucesso, então sem esse release a task
// ficaria "running" pra sempre.
//
// Se o watcher (ou a máquina) morre no meio, o release nunca roda e a task fica
// "running" sem ninguém trabalhando nela. recoverOrphans, chamado no
// startup do watcher (= todo tick, cron ou dashboard), detecta isso — na hora se o
// agent_pid gravado já morreu, ou por timeout se não há pid — e:
//   - nó comum: volta status pra "in_progress" (o tick seguinte redespacha o MESMO
//     state.node, sem voltar ao início do ciclo e sem mexer em retries);
//   - nó commit: NÃO redespacha (pode ter feito push/aberto PR antes de morrer) —
//     status="needs_human_review" + evento escalation.
// Sem dependência de env/REPO_PATH: roda também como CLI standalone (ver fim do
// arquivo), que é como o wrapper do modo detached (sem --follow) libera o lease.
const fs = require('fs');
const path = require('path');
const stateWriter = require('../state-writer');
const cas = require('../cas');
const processIdentity = require('./process-identity');

// 60 min, não os 30 sugeridos: medido nos agent_log reais (552 state.json, dedup por
// task_id), o p90 do intervalo entre despachos é 45 min em review/test e 60 em
// commit — 30 min daria falso positivo em nó vivo. Ver decision acima.
const DEFAULT_NODE_TIMEOUT_MS = 60 * 60 * 1000;
const RELEASED_STATUS = 'in_progress';

function resolveNodeTimeoutMs(env = process.env) {
    const raw = env.NODE_TIMEOUT_MS;
    if (raw === undefined || raw === '') return DEFAULT_NODE_TIMEOUT_MS;
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) {
        console.warn(`[recovery] NODE_TIMEOUT_MS inválido ("${raw}") — usando padrão ${DEFAULT_NODE_TIMEOUT_MS} ms.`);
        return DEFAULT_NODE_TIMEOUT_MS;
    }
    return Math.floor(n);
}

function statePath(dir) {
    return path.join(dir, 'state.json');
}

function readState(dir) {
    try {
        return JSON.parse(fs.readFileSync(statePath(dir), 'utf8'));
    } catch {
        return null;
    }
}

function writeState(dir, state, operation) {
    stateWriter.write(dir, state, { operation, actor: 'watcher' });
}

function appendEvent(state, event) {
    state.events = [...(state.events || []), event];
}

// Marca o nó como em execução. Devolve o lease ({ startedAt, timeoutMs, node }) pra
// quem despachou passar adiante até o release. Se a task vinha de uma recuperação de
// órfão, o marcador é consumido aqui (vira nota no prompt, ver recoveryNote).
function acquireNode(dir, { node, timeoutMs, now = new Date(), extra = null }) {
    const startedAt = now.toISOString();
    // execution_id: dono desta execução (scripts/cas.js). Run legado sem um ganha aqui.
    const state = stateWriter.update(dir, s => {
        // extra: campos gravados na mesma escrita do lease (ex.: execution_spec — a spec que
        // governa esta execução, scripts/invalidate.js).
        if (extra && typeof extra === 'object') Object.assign(s, extra);
        if (!s.execution_id) s.execution_id = stateWriter.newExecutionId();
        s.status = 'running';
        s.node_started_at = startedAt;
        s.node_timeout_ms = timeoutMs;
        delete s.agent_pid;
        delete s.agent_started_at;
        delete s.recovered_from_orphan;
    }, { operation: 'lease_acquire', actor: 'watcher' });
    if (!state) return null;
    return { dir, node, startedAt, timeoutMs, executionId: state.execution_id };
}

// Grava a identidade do processo que roda o agente (em modo detached, o wrapper sh que
// também roda o release): agent_pid + agent_started_at (início do processo, lido logo
// depois do spawn) — usada por agentAlive pra nunca declarar órfão um nó cujo agente
// ainda está vivo, mesmo passado o timeout, sem depender de qual binário roda.
// Task nova (sem state.json ainda): a identidade vai pro marcador fetch_dispatch do gate.
function recordAgentPid(lease, pid, { startOf = processIdentity.processStartIso } = {}) {
    if (!lease || !pid) return;
    const startedAt = startOf(pid);
    if (!lease.dir) return stampFetchDispatchPid(lease.gatePath, lease.startedAt, pid, startedAt);
    try {
        stateWriter.update(lease.dir, s => {
            if (s.status !== 'running' || s.node_started_at !== lease.startedAt) return cas.SKIP;
            s.agent_pid = pid;
            if (startedAt) s.agent_started_at = startedAt;
            else delete s.agent_started_at;
        }, {
            operation: 'lease_pid', actor: 'watcher',
            expect: lease.executionId ? { execution_id: lease.executionId } : null,
        });
    } catch (e) {
        if (!cas.isConflict(e)) throw e;
        console.warn(`[recovery] ${path.basename(lease.dir)}: ${e.message} — registro de PID ignorado.`);
    }
}

// acquire/release não tocam updated_at: é o carimbo do que o AGENTE gravou (lido por
// findActiveTask, dashboard e cost-tracking) — o lease é efeito colateral do despacho.
// Devolve status pra "in_progress" se o agente saiu sem trocá-lo. Não mexe se:
// state.json sumiu (commit arquiva a pasta), o comando gravou outro status, ou o
// lease já é de outro despacho (node_started_at diferente). node_started_at ausente
// conta como "este lease" — o agente pode ter reescrito o state.json sem ele.
// node_started_at/node_timeout_ms ficam gravados (auditoria do último despacho).
// execution_id do lease diferente do disco = outra sessão assumiu o run no meio (resume,
// replay, QA retry): SESSION_CONFLICT, registrado em logs/state-conflicts.jsonl, e o
// release não grava nada.
function releaseNode(lease) {
    // PRI-310 (S5.1): delega ao release com motivo; mesmo efeito e mesmo booleano de antes
    // (true só quando gravou in_progress; conflito de sessão, status trocado, lease de outro
    // despacho, state ausente ou lease nulo → false).
    return releaseNodeWithReason(lease) === 'RELEASED';
}

// PRI-310 (S5.1, B3): o release devolvendo o MOTIVO em vez de booleano, para a saída de
// Attempt de subtarefa distinguir perda de claim de mudança legítima de status. releaseNode
// acima delega a esta função e mantém o booleano. Motivos:
// - RELEASED: gravou in_progress (o agente saiu sem trocar o status);
// - STATUS_CHANGED: o próprio comando gravou outro status (SPEC_CHANGE, autorização…);
// - LEASE_REPLACED: o state.json é de outro despacho (node_started_at diferente);
// - SESSION_CONFLICT: outra sessão assumiu o run (execution_id diferente);
// - STATE_MISSING: o state.json (ou a pasta) não existe;
// - NO_LEASE: lease ausente.
function releaseNodeWithReason(lease) {
    if (!lease) return 'NO_LEASE';
    let reason = 'STATE_MISSING';
    try {
        stateWriter.update(lease.dir, s => {
            if (s.status !== 'running') { reason = 'STATUS_CHANGED'; return cas.SKIP; }
            if (s.node_started_at && s.node_started_at !== lease.startedAt) { reason = 'LEASE_REPLACED'; return cas.SKIP; }
            reason = 'RELEASED';
            s.status = RELEASED_STATUS;
            delete s.agent_pid;
            delete s.agent_started_at;
        }, {
            operation: 'lease_release', actor: 'watcher',
            expect: lease.executionId ? { execution_id: lease.executionId } : null,
        });
        return reason;
    } catch (e) {
        if (!cas.isConflict(e)) throw e;
        console.warn(`[recovery] ${path.basename(lease.dir)}: ${e.message} — release ignorado.`);
        return 'SESSION_CONFLICT';
    }
}

// Carimba node_started_at/node_timeout_ms numa task recém-criada pelo próprio agente
// (fetch_ticket cria o state.json durante o despacho, então não há o que marcar como
// running antes). Só preenche se ausente.
function stampNewTask(runsDir, prefix, { startedAt, timeoutMs }) {
    if (!fs.existsSync(runsDir)) return null;
    const since = Date.parse(startedAt);
    for (const d of fs.readdirSync(runsDir, { withFileTypes: true })) {
        if (!d.isDirectory() || !d.name.startsWith(prefix)) continue;
        const dir = path.join(runsDir, d.name);
        const state = readState(dir);
        if (!state || state.node_started_at) continue;
        const t = Date.parse(state.started_at || state.updated_at || 0);
        if (!(t >= since - 60_000)) continue; // task anterior a este despacho
        const written = stateWriter.update(dir, s => {
            if (s.node_started_at) return cas.SKIP;
            s.node_started_at = startedAt;
            s.node_timeout_ms = timeoutMs;
            // /fetch-ticket que gravou o state.json sem `state-writer.js init`: o ciclo
            // ganha o execution_id aqui.
            if (!s.execution_id) s.execution_id = stateWriter.newExecutionId();
        }, { operation: 'lease_stamp', actor: 'watcher' });
        if (!written) continue;
        return dir;
    }
    return null;
}

// Marcador de despacho do fetch_ticket no gate file (<runs>/<ticket>-spec-gate.json):
// o dashboard mostra o ticket como "rodando fetch_ticket" enquanto o state.json ainda
// não existe. Removido quando o agente sai — só se ainda for deste despacho.
function clearFetchDispatch(gatePath, startedAt) {
    if (!gatePath) return false;
    let gate;
    try { gate = JSON.parse(fs.readFileSync(gatePath, 'utf8')); } catch { return false; }
    if (!gate?.fetch_dispatch || gate.fetch_dispatch.started_at !== startedAt) return false;
    delete gate.fetch_dispatch;
    fs.writeFileSync(gatePath, JSON.stringify(gate, null, 2));
    return true;
}

function stampFetchDispatchPid(gatePath, startedAt, pid, agentStartedAt) {
    if (!gatePath) return false;
    let gate;
    try { gate = JSON.parse(fs.readFileSync(gatePath, 'utf8')); } catch { return false; }
    if (!gate?.fetch_dispatch || gate.fetch_dispatch.started_at !== startedAt) return false;
    gate.fetch_dispatch.agent_pid = pid;
    if (agentStartedAt) gate.fetch_dispatch.agent_started_at = agentStartedAt;
    fs.writeFileSync(gatePath, JSON.stringify(gate, null, 2));
    return true;
}

// O marcador fetch_dispatch ainda é um despacho vivo (PRI-218)? Só faz sentido para quem
// segura a reserva de despacho do ticket (scripts/lib/dispatch-reservation.js), porque o
// spawn carimba o pid antes de a reserva sair:
//   - com agent_pid: vivo enquanto o agente (wrapper sh ou claude) estiver vivo;
//   - com dispatch_id e sem agent_pid: o despachante morreu antes do spawn — órfão;
//   - legado (sem dispatch_id): vale o prazo, como no dashboard.
function fetchDispatchLive(gate, { now = Date.now(), defaultTimeoutMs = DEFAULT_NODE_TIMEOUT_MS, isAlive = agentAlive } = {}) {
    const d = gate?.fetch_dispatch;
    if (!d) return null;
    if (d.agent_pid) return isAlive(d.agent_pid, { agent_started_at: d.agent_started_at, node_started_at: d.started_at }) ? d : null;
    if (d.dispatch_id) return null;
    const at = Date.parse(d.started_at);
    if (!Number.isFinite(at)) return null;
    const timeout = Number(d.timeout_ms) > 0 ? Number(d.timeout_ms) : defaultTimeoutMs;
    return now - at <= timeout ? d : null;
}

// Lease legado (agent_pid sem agent_started_at): o agente nasce logo depois de
// node_started_at (entre o acquire e o spawn só rodam os carimbos de serviço/schema).
const LEGACY_SPAWN_WINDOW_MS = 15 * 60 * 1000;

// O agente do lease ainda está vivo? Identidade = (agent_pid, agent_started_at), nunca o
// texto do comando: codex, wrapper sh renomeado ou qualquer binário funcionam, e pid
// reciclado (outro processo, até outro claude) tem outro início e conta como morto.
// Lease legado, sem agent_started_at: vivo se o processo do pid começou dentro de
// [node_started_at, node_started_at + LEGACY_SPAWN_WINDOW_MS] — pid reciclado nasce
// depois da morte do agente, então só passa se o agente morreu e o pid voltou nessa janela.
// Sem state nenhum (chamada antiga só com pid): basta o processo existir.
// pid existente com início ilegível (ps falhou) = vivo: ver processIdentity.sameProcess.
function agentAlive(pid, state = null, { startOf = processIdentity.processStartMs, exists = processIdentity.pidExists } = {}) {
    if (!pid || !exists(pid)) return false;
    if (!state) return true;
    if (state.agent_started_at) return processIdentity.sameProcess(pid, state.agent_started_at, { startOf, exists });
    const started = startOf(pid);
    if (started == null) return true;
    const leaseAt = Date.parse(state.node_started_at);
    if (!Number.isFinite(leaseAt)) return true;
    return started >= leaseAt - processIdentity.START_TOLERANCE_MS && started <= leaseAt + LEGACY_SPAWN_WINDOW_MS;
}

// Por que o nó é órfão: "agent_dead" (agent_pid gravado e o processo já saiu — o
// release não rodou, não adianta esperar o timeout), "timeout" (sem pid gravado,
// running + node_started_at + idade > node_timeout_ms) ou null (não é órfão). Agente
// vivo nunca é órfão — no modo cron cada tick é um "startup", e um nó lento declarado
// órfão viraria dois agentes no mesmo worktree. agent_pid é o wrapper sh (detached,
// que só sai depois do release) ou o próprio claude (--follow, release no exit).
function orphanReason(state, { now = Date.now(), defaultTimeoutMs = DEFAULT_NODE_TIMEOUT_MS, isAlive = agentAlive } = {}) {
    if (!state || state.status !== 'running' || !state.node_started_at) return null;
    const started = Date.parse(state.node_started_at);
    if (!Number.isFinite(started)) return null;
    if (state.agent_pid) return isAlive(state.agent_pid, state) ? null : 'agent_dead';
    const timeoutMs = Number(state.node_timeout_ms) > 0 ? Number(state.node_timeout_ms) : defaultTimeoutMs;
    return now - started > timeoutMs ? 'timeout' : null;
}

function isOrphan(state, opts) {
    return orphanReason(state, opts) !== null;
}

// Uma linha pro log de "nó em execução": pid, se está vivo e há quanto tempo roda.
function describeRunning(state, { now = Date.now(), isAlive = agentAlive } = {}) {
    const started = Date.parse(state?.node_started_at);
    const elapsed = Number.isFinite(started) ? `${Math.round((now - started) / 60000)} min` : '?';
    const timeoutMs = Number(state?.node_timeout_ms);
    const limit = timeoutMs > 0 ? ` de ${Math.round(timeoutMs / 60000)} min` : '';
    const pid = state?.agent_pid
        ? `pid ${state.agent_pid} ${isAlive(state.agent_pid, state) ? 'vivo' : 'MORTO'}`
        : 'sem pid gravado';
    return `desde ${state?.node_started_at || '?'} (${elapsed}${limit}, ${pid})`;
}

// Todas as pastas de task (não arquivadas) sob cada runsDir.
function listTaskDirs(runsDirs) {
    const out = [];
    for (const runsDir of runsDirs) {
        if (!fs.existsSync(runsDir)) continue;
        for (const d of fs.readdirSync(runsDir, { withFileTypes: true })) {
            if (!d.isDirectory() || d.name.startsWith('_')) continue;
            const dir = path.join(runsDir, d.name);
            if (fs.existsSync(statePath(dir))) out.push(dir);
        }
    }
    return out;
}

// Escaneia e trata os órfãos. Devolve [{ taskId, dir, node, since, action }], com
// action = "redispatch" | "escalated". dryRun: só loga/devolve, não grava nada.
function recoverOrphans(runsDirs, { now = new Date(), defaultTimeoutMs, isAlive, dryRun = false, filter } = {}) {
    const results = [];
    for (const dir of listTaskDirs(runsDirs)) {
        const state = readState(dir);
        const taskId = state?.task_id || path.basename(dir);
        if (filter && !filter(taskId)) continue;
        if (state?.status === 'running' && !state.node_started_at) {
            console.warn(`[recovery] Task ${taskId}: status "running" sem node_started_at — não dá pra decidir se é órfão, verifique manualmente.`);
            continue;
        }
        const reason = orphanReason(state, { now: now.getTime(), defaultTimeoutMs, isAlive });
        if (!reason) continue;

        const node = state.node;
        const since = state.node_started_at;
        const at = now.toISOString();
        const cause = reason === 'agent_dead'
            ? `agente (pid ${state.agent_pid}) saiu sem liberar o nó`
            : 'passou do timeout sem agente registrado';
        if (node === 'commit') {
            console.warn(`[recovery] Task ${taskId}: commit órfão (${cause}) — verificação manual necessária antes de redespachar`);
            results.push({ taskId, dir, node, since, action: 'escalated', reason });
            if (dryRun) continue;
            appendEvent(state, {
                type: 'escalation', node, at,
                detail: `Commit órfão detectado pelo watcher (iniciado em ${since}; ${cause}) — pode ter feito push/aberto PR antes de morrer. ` +
                    'Confira branch remota/PRs; pra retomar, grave status="in_progress" no state.json.',
            });
            state.status = 'needs_human_review';
        } else {
            console.warn(`[recovery] Task ${taskId}: nó ${node} órfão desde ${since} (${cause}) — redespachando`);
            results.push({ taskId, dir, node, since, action: 'redispatch', reason });
            if (dryRun) continue;
            appendEvent(state, {
                type: 'node_error', node, at,
                detail: `Nó órfão detectado pelo watcher (${cause}) — redespachando`,
            });
            state.status = RELEASED_STATUS;
            state.recovered_from_orphan = { node, orphan_since: since, detected_at: at, reason };
        }
        delete state.agent_pid;
        delete state.agent_started_at;
        state.updated_at = at;
        try {
            writeState(dir, state, 'orphan_recovery');
        } catch (e) {
            if (!cas.isConflict(e)) throw e;
            console.warn(`[recovery] Task ${taskId}: ${e.message} — o run mudou durante a recuperação, fica pro próximo startup.`);
        }
    }
    return results;
}

// Nota extra pro prompt do redespacho de um nó recuperado (null se não é o caso).
function recoveryNote(state) {
    const r = state?.recovered_from_orphan;
    if (!r || r.node !== state.node) return '';
    return (
        ` RECUPERAÇÃO: o despacho anterior deste nó (iniciado em ${r.orphan_since}) foi interrompido ` +
        `sem terminar (watcher/agente morreu). Pode haver trabalho parcial no worktree — confira ` +
        `git status/diff antes de recomeçar. Isto é recuperação, não falha do nó: não incremente ` +
        `state.json.retries por causa dela.`
    );
}

module.exports = {
    DEFAULT_NODE_TIMEOUT_MS, LEGACY_SPAWN_WINDOW_MS, resolveNodeTimeoutMs,
    acquireNode, recordAgentPid, releaseNode, releaseNodeWithReason, stampNewTask, clearFetchDispatch, fetchDispatchLive,
    agentAlive, orphanReason, isOrphan, describeRunning, recoverOrphans, recoveryNote,
};

// CLI: `node node-lease.js release '<json>'` — chamado pelo wrapper sh do modo
// detached quando o `claude` sai. json = lease ({dir, startedAt, ...}) ou
// {runsDir, prefix, startedAt, timeoutMs} pra carimbar task nova (fetch_ticket).
if (require.main === module) {
    // exit code do agente (opcional): passado pelo wrapper sh do modo detached, vira
    // os eventos de saída do nó em state.json.events (ver lib/node-events.js).
    const [cmd, raw, rawCode] = process.argv.slice(2);
    if (cmd !== 'release' || !raw) {
        console.error("Uso: node scripts/lib/node-lease.js release '<json>' [exit code]");
        process.exit(2);
    }
    try {
        const arg = JSON.parse(raw);
        const code = rawCode === undefined || rawCode === '' ? undefined : Number(rawCode);
        let claim = null;
        if (arg.dir) {
            claim = releaseNodeWithReason(arg);
            if (code !== undefined) require('./node-events').recordNodeExit(arg, code);
        } else if (arg.runsDir) {
            const dir = stampNewTask(arg.runsDir, arg.prefix, arg);
            clearFetchDispatch(arg.gatePath, arg.startedAt);
            if (dir && code !== undefined) require('./node-events').recordNodeExit(arg, code, dir);
        }
        if (code !== undefined) {
            // PRI-310 (S5.1): saída única do DOM-06. Attempt sem `role` delega ao
            // fulfillOnExit de sempre; Attempt de subtarefa/integração decide o aceite.
            require('./dom06-attempt').closeOnExit({
                attemptFile: arg.dom06AttemptFile,
                attemptId: arg.dom06AttemptId,
                node: arg.node || (Array.isArray(arg.nodes) ? arg.nodes[0] : null),
                code,
                claim,
            });
        }
    } catch (e) {
        console.error('[recovery] falha liberando lease:', e.message);
    }
}
