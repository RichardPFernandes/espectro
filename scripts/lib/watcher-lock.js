// Trava de instância do watcher: um writer por REPO_PATH.
//
// Sem isto, nada impedia dois watchers no mesmo consumidor (a fonte do app-back e a
// candidata do Prisma, dois laços do dashboard, um tick de cron no meio de um laço):
// os dois decidiam despacho, recuperavam órfão e gravavam memory/runs ao mesmo tempo.
//
// Caminho: derivado do REPO_PATH (realpath), nunca do checkout do script — fonte e
// candidata, rodando de lugares diferentes, enxergam a mesma trava:
//   - <REPO_PATH>/.git/prisma-watcher.lock quando .git é diretório (checkout principal);
//   - /tmp/prisma-watcher-<sha256(REPO_PATH)[:16]>.lock caso contrário. /tmp fixo, não
//     os.tmpdir(): no macOS o TMPDIR muda entre shell, cron e launchd, e duas instâncias
//     com TMPDIR diferente não se veriam.
// Fora de memory/ de propósito: nem o --dry-run (que não trava) nem o DRY_RUN=true
// deixam arquivo de trava no que o /commit versiona.
//
// Dono = (pid, início do processo) (scripts/lib/process-identity.js). Trava cujo dono
// morreu (ou cujo pid foi reciclado) é velha e é retomada sem intervenção. Criação
// atômica: o conteúdo vai pra um tmp e entra no lugar por link(), que falha se a trava
// já existe — nunca há trava pela metade. A retomada roda sob um guarda (mkdir
// <trava>.takeover) pra dois retomadores não apagarem a trava nova um do outro.
//
// Laço do dashboard (scripts/watcher-manager.js): o laço segura a trava (role "loop")
// do start ao stop, e passa o token pro tick filho em WATCHER_LOCK_TOKEN. O tick com o
// token certo não pega trava nova: registra-se em `tick` (o laço morto com o tick vivo
// continua travando) e limpa o registro ao sair.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const processIdentity = require('./process-identity');

const LOCK_NAME = 'prisma-watcher.lock';
const TOKEN_ENV = 'WATCHER_LOCK_TOKEN';
const TAKEOVER_GUARD_STALE_MS = 30_000;
// Exit code do watcher recusado pela trava (EX_TEMPFAIL): outra instância está viva.
const EXIT_LOCKED = 75;

function realRepoPath(repoPath) {
    const abs = path.resolve(repoPath || process.cwd());
    try { return fs.realpathSync(abs); } catch { return abs; }
}

// `name` muda só o arquivo (a reserva de despacho por ticket usa o mesmo lugar e a
// mesma regra de .git/ ou /tmp — scripts/lib/dispatch-reservation.js).
function lockPathFor(repoPath, name = LOCK_NAME) {
    const real = realRepoPath(repoPath);
    const gitDir = path.join(real, '.git');
    try {
        if (fs.statSync(gitDir).isDirectory()) return path.join(gitDir, name);
    } catch { /* sem .git: cai no /tmp */ }
    const hash = crypto.createHash('sha256').update(real).digest('hex').slice(0, 16);
    return path.join('/tmp', `${name.replace(/\.lock$/, '')}-${hash}.lock`);
}

function readLock(lockPath) {
    let raw;
    try { raw = fs.readFileSync(lockPath, 'utf8'); } catch (e) {
        if (e.code === 'ENOENT') return { missing: true };
        return { corrupt: true, error: e.message };
    }
    try {
        const data = JSON.parse(raw);
        return data && typeof data === 'object' ? { data } : { corrupt: true };
    } catch {
        return { corrupt: true };
    }
}

function processAlive(entry, { startOf } = {}) {
    if (!entry?.pid) return false;
    if (entry.started_at) return processIdentity.sameProcess(entry.pid, entry.started_at, startOf ? { startOf } : undefined);
    return processIdentity.pidExists(entry.pid);
}

// A trava ainda tem dono vivo? Outra máquina (trava num disco compartilhado) não dá pra
// conferir: conta como viva — remova à mão se tiver certeza.
function holderAlive(data, opts = {}) {
    if (!data) return false;
    if (data.hostname && data.hostname !== os.hostname()) return true;
    return processAlive(data, opts) || processAlive(data.tick, opts);
}

function describeHolder(data) {
    if (!data) return 'dono desconhecido';
    const who = `${data.role || 'watcher'} pid ${data.pid}`;
    const tick = data.tick?.pid ? `, tick pid ${data.tick.pid}` : '';
    const script = data.script ? ` (${data.script})` : '';
    return `${who}${tick}${script}, desde ${data.acquired_at || '?'}`;
}

function writeAtomically(lockPath, data, { exclusive }) {
    const tmp = `${lockPath}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o644 });
    try {
        if (exclusive) fs.linkSync(tmp, lockPath);
        else fs.renameSync(tmp, lockPath);
    } finally {
        try { fs.unlinkSync(tmp); } catch { /* rename já consumiu */ }
    }
}

function withTakeoverGuard(lockPath, fn) {
    const guard = `${lockPath}.takeover`;
    for (let attempt = 0; attempt < 2; attempt++) {
        try {
            fs.mkdirSync(guard);
        } catch (e) {
            if (e.code !== 'EEXIST') throw e;
            // Guarda de quem morreu no meio da retomada (janela de milissegundos).
            let age = 0;
            try { age = Date.now() - fs.statSync(guard).mtimeMs; } catch { continue; }
            if (age > TAKEOVER_GUARD_STALE_MS) { try { fs.rmdirSync(guard); } catch { /* outro removeu */ } continue; }
            return { busy: true };
        }
        try { return { value: fn() }; } finally { try { fs.rmdirSync(guard); } catch { /* já removido */ } }
    }
    return { busy: true };
}

function newHolder({ role, repoPath, pid, startOf }) {
    return {
        version: 1,
        role,
        pid,
        started_at: (startOf ? startOf(pid) : processIdentity.processStartIso(pid)) || null,
        token: crypto.randomUUID(),
        hostname: os.hostname(),
        repo_path: realRepoPath(repoPath),
        script: process.argv[1] ? path.resolve(process.argv[1]) : null,
        argv: process.argv.slice(2),
        acquired_at: new Date().toISOString(),
    };
}

// Adquire a trava de REPO_PATH. Devolve
//   { acquired: true, path, holder, nested, takeover, release() }  ou
//   { acquired: false, path, holder, reason, message }.
// opts.env[WATCHER_LOCK_TOKEN] igual ao token da trava viva = tick filho do laço (nested).
// opts.lockPath: outra trava com a mesma criação/retomada (ver lockPathFor).
function acquire({ repoPath, role = 'watcher', env = process.env, pid = process.pid, startOf, startOfMs, lockPath = lockPathFor(repoPath) } = {}) {
    const aliveOpts = startOfMs ? { startOf: startOfMs } : {};
    const token = env?.[TOKEN_ENV];

    if (token) {
        const cur = readLock(lockPath);
        if (cur.data?.token === token && holderAlive(cur.data, aliveOpts)) {
            const tick = { pid, started_at: (startOf ? startOf(pid) : processIdentity.processStartIso(pid)) || null };
            writeAtomically(lockPath, { ...cur.data, tick }, { exclusive: false });
            return {
                acquired: true, nested: true, takeover: false, path: lockPath, holder: cur.data,
                release: () => releaseNested(lockPath, token, pid),
            };
        }
    }

    const holder = newHolder({ role, repoPath, pid, startOf });
    const ok = (takeover, previous = null) => ({
        acquired: true, nested: false, takeover, previous, path: lockPath, holder,
        release: () => release(lockPath, holder.token),
    });
    try {
        writeAtomically(lockPath, holder, { exclusive: true });
        return ok(false);
    } catch (e) {
        if (e.code !== 'EEXIST') throw e;
    }

    const cur = readLock(lockPath);
    if (cur.data && holderAlive(cur.data, aliveOpts)) return refused(lockPath, cur.data, 'held');
    const res = withTakeoverGuard(lockPath, () => {
        const again = readLock(lockPath);
        if (again.data && holderAlive(again.data, aliveOpts)) return { held: again.data };
        try { fs.unlinkSync(lockPath); } catch (e) { if (e.code !== 'ENOENT') throw e; }
        try {
            writeAtomically(lockPath, holder, { exclusive: true });
        } catch (e) {
            // Alguém criou pelo caminho rápido (sem guarda) entre o unlink e o link.
            if (e.code !== 'EEXIST') throw e;
            return { held: readLock(lockPath).data || null };
        }
        return { taken: again.data || null };
    });
    if (res.busy) return refused(lockPath, cur.data, 'takeover_in_progress');
    if (res.value.held) return refused(lockPath, res.value.held, 'held');
    return ok(true, res.value.taken);
}

function refused(lockPath, data, reason) {
    const message = reason === 'takeover_in_progress'
        ? `outra instância está retomando a trava ${lockPath} agora`
        : `outro watcher já roda neste REPO_PATH (${describeHolder(data)}) — trava ${lockPath}`;
    return { acquired: false, path: lockPath, holder: data || null, reason, message };
}

function release(lockPath, token) {
    const cur = readLock(lockPath);
    if (cur.data?.token !== token) return false;
    try { fs.unlinkSync(lockPath); return true; } catch { return false; }
}

function releaseNested(lockPath, token, pid) {
    const cur = readLock(lockPath);
    if (cur.data?.token !== token || cur.data.tick?.pid !== pid) return false;
    const { tick, ...rest } = cur.data;
    try { writeAtomically(lockPath, rest, { exclusive: false }); return true; } catch { return false; }
}

// Ponto único do readmine-watcher.js: adquire, libera no exit do processo e, se outra
// instância está viva, explica e devolve false (o chamador sai sem gravar nada).
function acquireForProcess({ repoPath, role, env = process.env, log = console } = {}) {
    const res = acquire({ repoPath, role, env });
    if (!res.acquired) {
        log.error(`[lock] ${res.message}. Nada foi gravado; saindo (exit ${EXIT_LOCKED}). ` +
            `Confira com: node ${path.relative(process.cwd(), __filename) || __filename} status --repo=${realRepoPath(repoPath)}`);
        process.exitCode = EXIT_LOCKED;
        return false;
    }
    if (res.takeover) {
        log.warn(`[lock] trava velha retomada (${describeHolder(res.previous)} não está mais vivo) — ${res.path}`);
    }
    process.once('exit', () => { try { res.release(); } catch { /* exit não pode lançar */ } });
    return true;
}

// ----------------------------------------------------------------- status (runbook)
// Agentes destacados vivos nos runs do consumidor (checkout principal + worktrees de
// ticket) e o node-lease.js que o wrapper deles vai chamar no fim (é por ele que se sabe
// se um checkout do Prisma ainda é necessário).
function liveAgents(repoPath, { isAlive } = {}) {
    const nodeLease = require('./node-lease');
    const real = realRepoPath(repoPath);
    const roots = [path.join(real, 'memory', 'runs')];
    const wtDir = path.join(real, '.claude', 'worktrees');
    try {
        for (const d of fs.readdirSync(wtDir, { withFileTypes: true })) {
            if (d.isDirectory()) roots.push(path.join(wtDir, d.name, 'memory', 'runs'));
        }
    } catch { /* sem worktrees */ }
    const alive = isAlive || nodeLease.agentAlive;
    const out = [];
    for (const runsDir of roots) {
        let entries;
        try { entries = fs.readdirSync(runsDir, { withFileTypes: true }); } catch { continue; }
        for (const d of entries) {
            if (!d.isDirectory() || d.name.startsWith('_')) continue;
            let state;
            try { state = JSON.parse(fs.readFileSync(path.join(runsDir, d.name, 'state.json'), 'utf8')); } catch { continue; }
            if (state?.status !== 'running' || !state.agent_pid || !alive(state.agent_pid, state)) continue;
            out.push({
                task_id: state.task_id || d.name, node: state.node, pid: state.agent_pid,
                agent_started_at: state.agent_started_at || null,
                release_script: releaseScriptOf(state.agent_pid),
            });
        }
    }
    return out;
}

function releaseScriptOf(pid) {
    try {
        const cmd = require('child_process').execFileSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
        const m = cmd.match(/(\S*node-lease\.js)/);
        return m ? m[1] : null;
    } catch {
        return null;
    }
}

function status(repoPath, opts = {}) {
    const lockPath = lockPathFor(repoPath);
    const cur = readLock(lockPath);
    const held = !!cur.data && holderAlive(cur.data);
    return {
        repo_path: realRepoPath(repoPath),
        lock_path: lockPath,
        lock: cur.data || null,
        lock_state: cur.missing ? 'free' : held ? 'held' : 'stale',
        agents: liveAgents(repoPath, opts),
    };
}

module.exports = {
    LOCK_NAME, TOKEN_ENV, EXIT_LOCKED,
    lockPathFor, readLock, holderAlive, describeHolder, acquire, acquireForProcess, release, status, liveAgents,
};

// CLI: `node scripts/lib/watcher-lock.js status [--repo=PATH] [--json]`
// exit 0 = nenhum watcher vivo e nenhum agente destacado vivo; 1 = algum dos dois.
if (require.main === module) {
    const args = process.argv.slice(2);
    if (args[0] !== 'status') {
        console.error('Uso: node scripts/lib/watcher-lock.js status [--repo=<REPO_PATH>] [--json]');
        process.exit(2);
    }
    const repoArg = args.find(a => a.startsWith('--repo='));
    const repo = repoArg ? repoArg.slice('--repo='.length) : (process.env.REPO_PATH || process.cwd());
    const st = status(repo);
    if (args.includes('--json')) {
        console.log(JSON.stringify(st, null, 2));
    } else {
        console.log(`REPO_PATH: ${st.repo_path}`);
        console.log(`trava:     ${st.lock_path}`);
        console.log(st.lock_state === 'held' ? `watcher:   VIVO — ${describeHolder(st.lock)}`
            : st.lock_state === 'stale' ? `watcher:   nenhum vivo (trava velha de ${describeHolder(st.lock)}, retomada no próximo tick)`
                : 'watcher:   nenhum vivo (sem trava)');
        if (!st.agents.length) console.log('agentes:   nenhum agente destacado vivo');
        for (const a of st.agents) {
            console.log(`agente:    ${a.task_id} nó ${a.node} pid ${a.pid}${a.release_script ? ` — libera o lease com ${a.release_script}` : ''}`);
        }
    }
    process.exit(st.lock_state === 'held' || st.agents.length ? 1 : 0);
}
