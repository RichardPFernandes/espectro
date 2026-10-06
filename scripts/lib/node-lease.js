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
const { execFileSync } = require('child_process');
const stateWriter = require('../state-writer');
const cas = require('../cas');

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
        delete s.recovered_from_orphan;
    }, { operation: 'lease_acquire', actor: 'watcher' });
    if (!state) return null;
    return { dir, node, startedAt, timeoutMs, executionId: state.execution_id };
}

// Grava o pid do processo que roda o agente (em modo detached, o wrapper sh que
// também roda o release) — usado por agentAlive pra nunca declarar órfão um nó cujo
// agente ainda está vivo, mesmo passado o timeout.
function recordAgentPid(lease, pid) {
    if (!lease || !pid) return;
    stateWriter.update(lease.dir, s => {
        if (s.node_started_at !== lease.startedAt) return cas.SKIP;
        s.agent_pid = pid;
    }, { operation: 'lease_pid', actor: 'watcher' });
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
    if (!lease) return false;
    try {
        const written = stateWriter.update(lease.dir, s => {
            if (s.status !== 'running') return cas.SKIP;
            if (s.node_started_at && s.node_started_at !== lease.startedAt) return cas.SKIP;
            s.status = RELEASED_STATUS;
            delete s.agent_pid;
        }, {
            operation: 'lease_release', actor: 'watcher',
            expect: lease.executionId ? { execution_id: lease.executionId } : null,
        });
        return written != null;
    } catch (e) {
        if (!cas.isConflict(e)) throw e;
        console.warn(`[recovery] ${path.basename(lease.dir)}: ${e.message} — release ignorado.`);
        return false;
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

function agentAlive(pid) {
    if (!pid) return false;
    try {
        process.kill(pid, 0);
    } catch (e) {
        if (e.code !== 'EPERM') return false;
    }
    // pid existe — confirma que é mesmo o agente (pid reciclado depois de um reboot
    // não pode segurar a task em "running" pra sempre).
    try {
        return /claude/.test(execFileSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' }));
    } catch {
        return false;
    }
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
    if (state.agent_pid) return isAlive(state.agent_pid) ? null : 'agent_dead';
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
        ? `pid ${state.agent_pid} ${isAlive(state.agent_pid) ? 'vivo' : 'MORTO'}`
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
            state.recovered_from_orphan = { node, orphan_since: since, detected_at: at };
        }
        delete state.agent_pid;
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
    DEFAULT_NODE_TIMEOUT_MS, resolveNodeTimeoutMs,
    acquireNode, recordAgentPid, releaseNode, stampNewTask, clearFetchDispatch,
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
        if (arg.dir) {
            releaseNode(arg);
            if (code !== undefined) require('./node-events').recordNodeExit(arg, code);
        } else if (arg.runsDir) {
            const dir = stampNewTask(arg.runsDir, arg.prefix, arg);
            clearFetchDispatch(arg.gatePath, arg.startedAt);
            if (dir && code !== undefined) require('./node-events').recordNodeExit(arg, code, dir);
        }
    } catch (e) {
        console.error('[recovery] falha liberando lease:', e.message);
    }
}
