// Reserva de despacho por ticket (PRI-218): um despachante por ticket por vez, entre
// processos.
//
// O watcher (tick → dispatchTicket) e o dashboard ("▶ Disparar", retomadas, replay →
// node-dispatcher.dispatchNode → dispatchTicket) rodam em processos diferentes e fazem
// o mesmo check-then-act: "não há task ativa nem despacho visível" → cria worktree,
// marcador e agente. Sem reserva, os dois passavam pela verificação antes de existir
// state.json ou marcador e subiam dois agentes no mesmo ticket. A reserva cobre o
// dispatchTicket inteiro: da primeira leitura até o despacho estar visível em disco
// (state.json running, ou gate.fetch_dispatch com o pid do agente).
//
// Mesma primitiva da trava de instância (scripts/lib/watcher-lock.js): arquivo criado
// por link() exclusivo, dono = (pid, início do processo), retomada sob guarda quando o
// dono morreu. O lease é a vida do processo que reservou: crash no meio do despacho
// não deixa reserva órfã — o próximo despachante vê o dono morto e retoma. Mesmo
// lugar da trava do watcher (.git/ do REPO_PATH ou /tmp), fora de memory/.
const watcherLock = require('./watcher-lock');

const reservationPath = (repoPath, ticketId) => watcherLock.lockPathFor(repoPath, `prisma-dispatch-${ticketId}.lock`);

// { acquired: true, path, release() } ou { acquired: false, path, holder, reason, message }.
// Também recusa um segundo despacho do mesmo ticket no MESMO processo (o dono está vivo).
function reserve({ repoPath, ticketId, role = 'dispatch', ...opts }) {
    const lockPath = reservationPath(repoPath, ticketId);
    const res = watcherLock.acquire({ ...opts, repoPath, role, env: {}, lockPath });
    if (res.acquired) return { acquired: true, path: lockPath, takeover: res.takeover, previous: res.previous || null, release: res.release };
    const message = res.reason === 'takeover_in_progress'
        ? `ticket #${ticketId}: outro despachante está retomando a reserva ${lockPath} agora`
        : `ticket #${ticketId}: despacho já em andamento (${watcherLock.describeHolder(res.holder)}) — reserva ${lockPath}`;
    return { acquired: false, path: lockPath, holder: res.holder, reason: res.reason, message };
}

module.exports = { reservationPath, reserve };
