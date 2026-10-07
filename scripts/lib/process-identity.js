// Identidade de processo = pid + instante de início do processo (`ps -o lstart=`).
// pid sozinho não identifica nada: o SO recicla pids (reboot, ou só tempo), e texto do
// comando (`ps -o command=`) muda com o binário (claude, codex, wrapper sh renomeado).
// O instante de início não muda durante a vida do processo e um pid reciclado nasce
// depois do dono anterior — então (pid, início) só bate com o mesmo processo.
//
// Usado pelo lease de nó (scripts/lib/node-lease.js, agente vivo) e pela trava de
// instância do watcher (scripts/lib/watcher-lock.js, watcher vivo).
const { execFileSync } = require('child_process');

// lstart tem resolução de 1 s; a folga cobre arredondamento entre duas leituras.
const START_TOLERANCE_MS = 2000;

function pidExists(pid) {
    const n = Number(pid);
    if (!Number.isInteger(n) || n <= 0) return false;
    try {
        process.kill(n, 0);
        return true;
    } catch (e) {
        return e.code === 'EPERM';
    }
}

// Início do processo em ms (epoch) ou null (processo não existe / ps indisponível).
// LC_ALL=C: lstart em inglês ("Wed Oct  7 14:06:31 2026", hora local), que o Date entende.
function processStartMs(pid) {
    if (!pidExists(pid)) return null;
    try {
        const out = execFileSync('ps', ['-p', String(Number(pid)), '-o', 'lstart='], {
            encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, LC_ALL: 'C', LANG: 'C' },
        }).trim();
        const ms = Date.parse(out);
        return Number.isFinite(ms) ? ms : null;
    } catch {
        return null;
    }
}

function processStartIso(pid) {
    const ms = processStartMs(pid);
    return ms == null ? null : new Date(ms).toISOString();
}

// O processo `pid` vivo agora é o mesmo que começou em `startedAt` (ISO ou ms)?
// pid existente com início ilegível (ps bloqueado num sandbox, por exemplo) conta como o
// mesmo: sem como provar que é outro, o erro barato é segurar (nó preso, trava visível),
// não liberar (dois agentes no mesmo worktree, dois watchers no mesmo repo).
function sameProcess(pid, startedAt, { startOf = processStartMs, exists = pidExists } = {}) {
    if (!exists(pid)) return false;
    const expected = typeof startedAt === 'number' ? startedAt : Date.parse(startedAt);
    const actual = startOf(pid);
    if (actual == null || !Number.isFinite(expected)) return true;
    return Math.abs(actual - expected) <= START_TOLERANCE_MS;
}

module.exports = { START_TOLERANCE_MS, pidExists, processStartMs, processStartIso, sameProcess };
