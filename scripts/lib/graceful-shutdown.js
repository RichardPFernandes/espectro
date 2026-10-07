// Encerramento graceful do readmine-watcher.js ao receber SIGTERM.
//
// Sem isto, SIGTERM (Stop/Restart do dashboard, `kill`, launchd) matava o processo na
// hora: a task cujo nó o watcher estava conduzindo ficava com status "running" no
// state.json até a recuperação de órfão por timeout (60 min, ver node-lease.js), o
// agente em --follow virava processo solto e o ticket não ganhava comentário nenhum.
//
// O watcher mantém um objeto de estado MUTÁVEL (watcherState, ver readmine-watcher.js >
// createWatcherState) e o passa pra register() uma vez; o handler lê o snapshot desse
// objeto no momento do sinal. Campos usados aqui:
//   activeCycle: null | { ticketId, taskId, node, startedAt, dir, child }
//     dir   = pasta da task (state.json); null no despacho fetch_ticket (task ainda não existe)
//     child = ChildProcess do agente em --follow (no modo detached o agente é dono do
//             próprio lease e sobrevive ao watcher, então o watcher nem registra ciclo
//             depois do spawn — ver readmine-watcher.js > endCycle)
//
// Com ciclo ativo, o handler, nesta ordem:
//   1. marca watcherState (status/interruptedAt/activeNodeAtInterruption) e o state.json
//      da task (status="interrupted" + os mesmos campos + evento) — escrita síncrona,
//      antes de qualquer await: se o processo morrer por SIGKILL logo depois, isso já
//      está em disco;
//   2. em paralelo: comentário no Redmine + SIGTERM no agente em andamento, esperando
//      os dois no máximo GRACEFUL_TIMEOUT_MS (padrão 10000) no total;
//   3. process.exit(0).
// Sem ciclo ativo (watcher entre ticks ou só consultando o Redmine): grava o runtime e
// sai com 0 na hora (< 1s).
//
// "interrupted" não é redespachado sozinho (dispatchTicket trata como intervenção
// humana): pra retomar, grave status="in_progress" no state.json da task.
const fs = require('fs');
const path = require('path');
const stateWriter = require('../state-writer');
const { SKIP } = require('../cas');

const DEFAULT_GRACEFUL_TIMEOUT_MS = 10000;

function resolveGracefulTimeoutMs(env = process.env) {
    const raw = env.GRACEFUL_TIMEOUT_MS;
    if (raw === undefined || raw === '') return DEFAULT_GRACEFUL_TIMEOUT_MS;
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0) {
        console.warn(`[shutdown] GRACEFUL_TIMEOUT_MS inválido ("${raw}") — usando padrão ${DEFAULT_GRACEFUL_TIMEOUT_MS} ms.`);
        return DEFAULT_GRACEFUL_TIMEOUT_MS;
    }
    return Math.floor(n);
}

function interruptionNote(node) {
    return `⚠️ Watcher interrompido via SIGTERM durante nó ${node || '?'}. Ciclo deve ser retomado manualmente.`;
}

// Marca o state.json da task como interrompido. Devolve true se gravou. Não mexe se o
// state.json sumiu (commit arquivou a pasta) ou já não é deste despacho
// (node_started_at de outro lease).
function markTaskInterrupted(dir, { node, at, leaseStartedAt = null }) {
    let written;
    try {
        written = stateWriter.update(dir, state => {
            if (leaseStartedAt && state.node_started_at && state.node_started_at !== leaseStartedAt) return SKIP;
            return markInterrupted(state, { node, at });
        }, { operation: 'shutdown_interrupt', actor: 'watcher' });
    } catch { return false; }
    return written != null;
}

function markInterrupted(state, { node, at }) {
    state.status = 'interrupted';
    state.interruptedAt = at;
    state.activeNodeAtInterruption = node;
    state.events = [...(Array.isArray(state.events) ? state.events : []), {
        type: 'interrupted', node, at,
        detail: 'Watcher recebeu SIGTERM durante o nó — ciclo não é redespachado sozinho; grave status="in_progress" pra retomar.',
    }];
    delete state.agent_pid;
    delete state.agent_started_at;
    return state;
}

function waitExit(child) {
    if (!child || child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
    return new Promise(resolve => {
        child.once('exit', resolve);
        child.once('error', resolve);
    });
}

class GracefulShutdown {
    // postNote(ticketId, text) => Promise; writeRuntime(watcherState) => void (síncrono);
    // markTask(dir, {node, at, leaseStartedAt}) => bool; exit(code). Tudo injetável pra teste.
    constructor({
        timeoutMs = resolveGracefulTimeoutMs(),
        postNote = async () => false,
        writeRuntime = () => {},
        markTask = markTaskInterrupted,
        log = console,
        exit = code => process.exit(code),
        proc = process,
        now = () => new Date(),
    } = {}) {
        Object.assign(this, { timeoutMs, postNote, writeRuntime, markTask, log, exit, proc, now });
        this.state = null;
        this.inProgress = null;
        this.onSignal = () => {
            // Segundo SIGTERM durante o shutdown: quem mandou quer que acabe já.
            if (this.inProgress) { this.log.warn('[shutdown] SIGTERM repetido — saindo sem esperar.'); this.exit(0); return; }
            this.shutdown('SIGTERM');
        };
    }

    register(watcherState) {
        this.state = watcherState;
        this.proc.on('SIGTERM', this.onSignal);
        return this;
    }

    unregister() {
        this.proc.removeListener('SIGTERM', this.onSignal);
    }

    shutdown(signal = 'SIGTERM') {
        if (this.inProgress) return this.inProgress;
        this.inProgress = this._run(signal);
        return this.inProgress;
    }

    async _run(signal) {
        const st = this.state || {};
        st.shuttingDown = true;
        const cycle = st.activeCycle || null;
        this.log.log(`Graceful shutdown iniciado (${signal})${cycle ? ` — ciclo ativo: ${cycle.taskId || `#${cycle.ticketId}`}, nó ${cycle.node}` : ' — nenhum ciclo ativo'}`);

        // Teto duro: nada abaixo pode segurar o processo além do timeout.
        let hard = null;
        const deadline = new Promise(resolve => { hard = setTimeout(() => resolve('timeout'), this.timeoutMs); });

        const at = this.now().toISOString();
        if (cycle) {
            st.status = 'interrupted';
            st.interruptedAt = at;
            st.activeNodeAtInterruption = cycle.node;
            st.lastCompletedCycle = { taskId: cycle.taskId || null, ticketId: cycle.ticketId, node: cycle.node, completedAt: at, status: 'interrupted' };
            if (cycle.dir) {
                try {
                    if (this.markTask(cycle.dir, { node: cycle.node, at, leaseStartedAt: cycle.leaseStartedAt || null })) {
                        this.log.log(`[shutdown] ${cycle.taskId}: state.json marcado como interrupted (nó ${cycle.node}).`);
                    }
                } catch (e) {
                    this.log.error(`[shutdown] falha marcando ${cycle.taskId} como interrupted:`, e.message);
                }
            }
        }
        st.nextPollAt = null;
        try { this.writeRuntime(st); } catch (e) { this.log.error('[shutdown] falha gravando runtime do watcher:', e.message); }

        if (cycle) {
            const work = [];
            if (cycle.ticketId) {
                work.push(Promise.resolve()
                    .then(() => this.postNote(cycle.ticketId, interruptionNote(cycle.node)))
                    .catch(e => this.log.error(`[shutdown] falha comentando no Redmine #${cycle.ticketId}:`, e.message)));
            }
            if (cycle.child) {
                try { cycle.child.kill('SIGTERM'); } catch {}
                work.push(waitExit(cycle.child));
            }
            const outcome = await Promise.race([Promise.allSettled(work).then(() => 'done'), deadline]);
            if (outcome === 'timeout') {
                this.log.warn(`[shutdown] timeout de ${this.timeoutMs} ms esperando Redmine/agente — saindo assim mesmo.`);
                if (cycle.child && cycle.child.exitCode === null && cycle.child.signalCode === null) {
                    try { cycle.child.kill('SIGKILL'); } catch {}
                }
            }
        }
        clearTimeout(hard);
        this.log.log('Graceful shutdown concluído — saindo com código 0.');
        this.exit(0);
    }
}

module.exports = { GracefulShutdown, resolveGracefulTimeoutMs, markTaskInterrupted, interruptionNote, DEFAULT_GRACEFUL_TIMEOUT_MS };
