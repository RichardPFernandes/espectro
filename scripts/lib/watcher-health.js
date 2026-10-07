// Health-check do readmine-watcher.js (`node scripts/readmine-watcher.js --health-check`).
// Só lê — não grava nada, não chama Redmine, não mexe em lease.
//
// Fontes:
//   - <runs>/watcher-runtime.json — gravado pelo watcher (writeWatcherRuntime) no início
//     e no fim de cada tick, ao abrir/fechar um ciclo e no shutdown graceful: pid,
//     loopStartedAt (início do laço do dashboard — WATCHER_LOOP_STARTED_AT — ou do
//     processo), activeCycle, lastCompletedCycle, nextPollAt.
//   - state.json das tasks (checkout principal + worktrees): um nó com lease "running"
//     cujo agente está vivo também conta como ciclo ativo (no modo normal, sem
//     --follow, o agente roda destacado e o processo do watcher já saiu).
//
// Inconsistências (healthy=false, exit code 1):
//   - runtime ilegível;
//   - runtime com ciclo ativo e o processo do watcher morto sem ter passado pelo
//     shutdown graceful (SIGKILL/crash);
//   - nó "running" órfão por timeout (node-lease.orphanReason: sem agent_pid e passou de node_timeout_ms);
//   - nó "running" com agent_pid morto e nenhum watcher vivo pra liberar o lease.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const nodeLease = require('./node-lease');

const RUNTIME_FILE = 'watcher-runtime.json';
// nextPollAt vencido há mais que isto, sem watcher vivo = laço parado.
const LOOP_GRACE_MS = 60 * 1000;

function watcherPidAlive(pid) {
    if (!pid) return false;
    try { process.kill(pid, 0); } catch (e) { if (e.code !== 'EPERM') return false; }
    try {
        return /readmine-watcher/.test(execFileSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }));
    } catch { return false; }
}

function readRuntime(file) {
    let raw;
    try { raw = fs.readFileSync(file, 'utf8'); } catch { return { runtime: null }; }
    try {
        const runtime = JSON.parse(raw);
        if (!runtime || typeof runtime !== 'object' || Array.isArray(runtime)) return { runtime: null, error: 'conteúdo não é um objeto' };
        return { runtime };
    } catch (e) {
        return { runtime: null, error: e.message };
    }
}

// Pastas de task (não arquivadas) com state.json sob cada runsDir.
function listTaskDirs(runsDirs) {
    const out = [];
    for (const runsDir of runsDirs) {
        let entries;
        try { entries = fs.readdirSync(runsDir, { withFileTypes: true }); } catch { continue; }
        for (const d of entries) {
            if (!d.isDirectory() || d.name.startsWith('_')) continue;
            const dir = path.join(runsDir, d.name);
            if (fs.existsSync(path.join(dir, 'state.json'))) out.push(dir);
        }
    }
    return out;
}

function readState(dir) {
    try { return JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8')); } catch { return null; }
}

const pickCycle = c => c ? { taskId: c.taskId || null, node: c.node || null, startedAt: c.startedAt || null } : null;

function computeHealth({
    runtimePath, runsDirs = [], now = Date.now(),
    isWatcherAlive = watcherPidAlive, isAgentAlive = nodeLease.agentAlive,
    defaultTimeoutMs = nodeLease.DEFAULT_NODE_TIMEOUT_MS,
} = {}) {
    const issues = [];
    const { runtime: rt, error } = readRuntime(runtimePath);
    if (error) issues.push(`watcher-runtime.json ilegível: ${error}`);

    const watcherAlive = !!(rt && rt.pid && rt.pid !== process.pid && isWatcherAlive(rt.pid));

    let activeCycle = null;
    if (rt?.activeCycle) {
        if (watcherAlive) activeCycle = { ...pickCycle(rt.activeCycle), source: 'watcher' };
        else if (rt.status !== 'interrupted') {
            issues.push(`watcher (PID ${rt.pid}) morreu com ciclo ativo (${rt.activeCycle.taskId || `#${rt.activeCycle.ticketId}`}, nó ${rt.activeCycle.node}) sem shutdown graceful`);
        }
    }

    for (const dir of listTaskDirs(runsDirs)) {
        const state = readState(dir);
        if (!state || state.status !== 'running') continue;
        const taskId = state.task_id || path.basename(dir);
        const orphan = nodeLease.orphanReason(state, { now, defaultTimeoutMs, isAlive: isAgentAlive });
        if (orphan === 'timeout') {
            issues.push(`${taskId}: nó ${state.node} "running" órfão desde ${state.node_started_at} (passou de node_timeout_ms sem agente registrado)`);
            continue;
        }
        if (orphan === 'agent_dead' && !watcherAlive) {
            issues.push(`${taskId}: nó ${state.node} "running" com agente (PID ${state.agent_pid}) morto e nenhum watcher vivo pra liberar o lease`);
            continue;
        }
        if (activeCycle?.taskId === taskId) continue;
        const cycle = { taskId, node: state.node || null, startedAt: state.node_started_at || null, source: 'agent' };
        // Mais de um nó rodando: mostra o mais recente.
        if (!activeCycle || (activeCycle.source === 'agent' && Date.parse(cycle.startedAt) > Date.parse(activeCycle.startedAt))) activeCycle = cycle;
    }

    const nextPollMs = Date.parse(rt?.nextPollAt);
    const loopAlive = watcherAlive || (Number.isFinite(nextPollMs) && nextPollMs >= now - LOOP_GRACE_MS);
    const loopStartedMs = Date.parse(rt?.loopStartedAt || rt?.startedAt);
    const uptimeSeconds = loopAlive && Number.isFinite(loopStartedMs) ? Math.max(0, Math.floor((now - loopStartedMs) / 1000)) : 0;

    const last = rt?.lastCompletedCycle;
    const out = {
        status: activeCycle ? 'running' : 'idle',
        uptimeSeconds,
        activeCycle,
        lastCompletedCycle: last ? { taskId: last.taskId || null, completedAt: last.completedAt || null, status: last.status || null, ...(last.node ? { node: last.node } : {}) } : null,
        nextPollAt: loopAlive && Number.isFinite(nextPollMs) ? rt.nextPollAt : null,
        healthy: issues.length === 0,
        issues,
        watcherPid: watcherAlive ? rt.pid : null,
        checkedAt: new Date(now).toISOString(),
    };
    if (rt?.status === 'interrupted' && rt.interruptedAt) {
        out.lastInterruption = { interruptedAt: rt.interruptedAt, activeNodeAtInterruption: rt.activeNodeAtInterruption || null };
    }
    return out;
}

module.exports = { computeHealth, readRuntime, watcherPidAlive, RUNTIME_FILE, LOOP_GRACE_MS };
