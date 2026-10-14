// Controle do readmine-watcher.js a partir do dashboard (dashboard/server.js >
// /api/watcher/*): start/stop/restart/status + ringbuffer do stdout/stderr.
//
// O watcher, sem --follow, roda UM tick e sai com código 0 (foi feito pra cron). Então
// "watcher ativo" aqui é um laço: dispara um tick, e quando ele sai limpo agenda o
// próximo depois de WATCHER_TICK_INTERVAL_MS. Saída com código != 0 ou por sinal (sem
// ter sido pedido por stop()) é crash: espera 3s e dispara de novo, no máximo
// MAX_AUTO_RESTARTS vezes por hora — passou disso, o laço para e status.error vira
// "restart_limit_reached" até alguém dar start() manual.
//
// Nada de PM2/launchd: o filho é spawn() normal, não-detached, com o env inteiro do
// pai (o watcher ainda lê o .env do repo sozinho pro que faltar). Agentes que o tick
// despacha continuam detached como sempre — stop() não mexe neles.
//
// Secrets: toda linha do filho passa pelo sanitize-log.js (valores de
// BITBUCKET_API_TOKEN/REDMINE_API_KEY e de qualquer *_TOKEN/*_API_KEY/*_SECRET/
// *_PASSWORD do env do pai E do .env do repo, que o filho carrega sozinho) e por
// uma redação de `CHAVE=valor` antes de entrar no ringbuffer. Nada daqui é gravado em
// disco além do PID e do histórico de eventos (sem conteúdo de log).
const fs = require('fs');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const { EventEmitter } = require('events');
const sanitizeLog = require('./sanitize-log');
const watcherLock = require('./lib/watcher-lock');

const PRISMA_ROOT = path.resolve(__dirname, '..');
const LOG_LINES = 200;
const STOP_GRACE_MS = 5000;
const RESTART_DELAY_MS = 3000;
const MAX_AUTO_RESTARTS = 3;
const RESTART_WINDOW_MS = 60 * 60 * 1000;
const HISTORY_MAX = 200;
// `CHAVE=valor` / `CHAVE: valor` com nome de secret — pega secret que não está no env
// (ex: token lido de outro arquivo e impresso por engano).
const INLINE_SECRET_RE = /\b([A-Z0-9_]*(?:_TOKEN|_API_KEY|_SECRET|_PASSWORD)\s*[=:]\s*)(["']?)[^\s"']+\2/g;
const HEADER_SECRET_RE = /((?:X-Redmine-API-Key|Authorization)\s*[:=]\s*(?:Bearer\s+|Basic\s+)?)(["']?)[^\s"',}]+\2/gi;

function parseEnvFile(file) {
    const out = {};
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch { return out; }
    for (const raw of text.split('\n')) {
        const line = raw.trim();
        if (!line || line.startsWith('#')) continue;
        const eq = line.indexOf('=');
        if (eq === -1) continue;
        let value = line.slice(eq + 1).trim();
        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
        if (value) out[line.slice(0, eq).trim()] = value;
    }
    return out;
}

// sanitize-log.js (valores de secrets do env + do .env) + redação de `CHAVE=valor` e
// de header de auth. `extra` = mais pares nome→valor tratados como secret (o
// preview-manager passa as senhas do .properties do Quarkus). Construído no primeiro
// uso; reset() força reler (o .env pode ter mudado).
function createRedactor(envFile, extra = () => ({}), env = process.env) {
    let sanitize = null;
    function redact(text) {
        if (!sanitize) {
            const entries = [
                ...Object.entries(envFile ? parseEnvFile(envFile) : {}),
                ...Object.entries(extra()),
                ...Object.entries(env),
            ];
            // Preserve every known value, including same-name values from different
            // sources. Synthetic keys keep the secret suffix recognized by sanitizer.
            const envForSecrets = Object.fromEntries(entries.map(([key, value], index) => [`REDACTOR_${index}_${key}${key === 'NOTIFY_WEBHOOK_URL' ? '_SECRET' : ''}`, value]));
            sanitize = sanitizeLog.buildSanitizer(envForSecrets, { onWarning: () => {} });
        }
        return sanitize(text).replace(INLINE_SECRET_RE, `$1${sanitizeLog.REDACTED}`).replace(HEADER_SECRET_RE, `$1${sanitizeLog.REDACTED}`);
    }
    redact.reset = () => { sanitize = null; };
    return redact;
}

function levelOf(stream, text) {
    if (stream === 'stderr') return /\b(erro|error|falha|fail|exception|fatal)/i.test(text) ? 'ERROR' : 'WARN';
    if (/\[(warn|aviso)\]|\bwarn(ing)?\b/i.test(text)) return 'WARN';
    return 'INFO';
}

function isAlive(pid) {
    try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

function createWatcherManager(options = {}) {
    const repoRoot = path.resolve(options.repoRoot || options.cwd || options.env?.REPO_PATH || process.env.REPO_PATH || process.cwd());
    const script = options.script || path.join(PRISMA_ROOT, 'scripts', 'readmine-watcher.js');
    const args = options.args || [];
    const cwd = options.cwd || repoRoot;
    const pidFile = options.pidFile || path.join(repoRoot, 'dashboard', 'watcher.pid');
    const historyFile = options.historyFile === undefined ? path.join(repoRoot, 'dashboard', 'watcher-history.json') : options.historyFile;
    const intervalMs = options.intervalMs ?? (Number(process.env.WATCHER_TICK_INTERVAL_MS) || 60000);
    const restartDelayMs = options.restartDelayMs ?? RESTART_DELAY_MS;
    // O watcher tem shutdown graceful (scripts/lib/graceful-shutdown.js) que pode levar
    // até GRACEFUL_TIMEOUT_MS esperando Redmine/agente — o SIGKILL só vem depois disso.
    const gracefulMs = require('./lib/graceful-shutdown').resolveGracefulTimeoutMs();
    const stopGraceMs = options.stopGraceMs ?? Math.max(STOP_GRACE_MS, gracefulMs + 2000);
    const envFile = options.envFile === undefined ? path.join(repoRoot, '.env') : options.envFile;

    const events = new EventEmitter();
    events.setMaxListeners(0);
    const buffer = [];
    let seq = 0;
    // Construído no primeiro uso (não no require): o server.js carrega o .env
    // depois de require()-ar este módulo.
    const redact = createRedactor(envFile, () => options.env || {});

    let child = null;
    let state = 'stopped'; // stopped | starting | running | restarting | stopping
    let error = null;
    let startedAt = null;
    let tickStartedAt = null;
    let nextTickAt = null;
    let timer = null;
    let restarts = 0;
    let restartTimes = [];
    let ticks = 0;
    let stopPromise = null;
    // Trava de instância (scripts/lib/watcher-lock.js) segurada pelo laço do start ao
    // stop: entre ticks não há processo do watcher, e sem isto outro laço/cron entraria.
    let loopLock = null;
    let orphanPid = detectOrphan();
    function releaseLoopLock() { if (loopLock) { try { loopLock.release(); } catch {} loopLock = null; } }

    // --------------------------------------------------------------- log
    function push(level, text, source = 'watcher') {
        const entry = { seq: ++seq, ts: new Date().toISOString(), level, source, text: redact(String(text)) };
        buffer.push(entry);
        if (buffer.length > LOG_LINES) buffer.splice(0, buffer.length - LOG_LINES);
        events.emit('line', entry);
        return entry;
    }
    const note = (text, level = 'INFO') => push(level, text, 'manager');

    function lineReader(stream, name) {
        let pending = '';
        stream.setEncoding('utf8');
        stream.on('data', chunk => {
            pending += chunk;
            const lines = pending.split(/\r?\n/);
            pending = lines.pop();
            for (const l of lines) if (l.trim()) push(levelOf(name, l), l);
            // Linha gigante sem \n não segura memória indefinidamente.
            if (pending.length > 16384) { push(levelOf(name, pending), pending); pending = ''; }
        });
        stream.on('end', () => { if (pending.trim()) push(levelOf(name, pending), pending); pending = ''; });
    }

    // --------------------------------------------------------------- pid / histórico
    function writePid(pid) { try { fs.mkdirSync(path.dirname(pidFile), { recursive: true }); fs.writeFileSync(pidFile, `${pid}\n`); } catch (e) { note(`falha gravando ${path.basename(pidFile)}: ${e.message}`, 'WARN'); } }
    function clearPid() { try { fs.unlinkSync(pidFile); } catch {} }
    function detectOrphan() {
        let pid;
        try { pid = Number(fs.readFileSync(pidFile, 'utf8').trim()); } catch { return null; }
        if (!pid || !isAlive(pid) || !looksLikeWatcher(pid)) { clearPid(); return null; }
        return pid;
    }
    function looksLikeWatcher(pid) {
        try {
            const cmd = execFileSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
            return cmd.includes(path.basename(script));
        } catch { return false; }
    }

    function readHistory() {
        if (!historyFile) return [];
        try { const h = JSON.parse(fs.readFileSync(historyFile, 'utf8')); return Array.isArray(h) ? h : []; } catch { return []; }
    }
    function record(type, extra = {}) {
        if (!historyFile) return;
        const h = readHistory();
        h.push({ type, at: new Date().toISOString(), ...extra });
        try { fs.mkdirSync(path.dirname(historyFile), { recursive: true }); fs.writeFileSync(historyFile, JSON.stringify(h.slice(-HISTORY_MAX), null, 2)); } catch {}
    }
    // Última execução encerrada: do start mais recente com fim até esse fim.
    function lastRun() {
        const h = readHistory();
        for (let i = h.length - 1; i >= 0; i--) {
            const end = h[i];
            if (end.type !== 'stop' && end.type !== 'restart_limit') continue;
            for (let j = i - 1; j >= 0; j--) {
                if (h[j].type === 'start') {
                    return { started_at: h[j].at, ended_at: end.at, uptime_ms: Date.parse(end.at) - Date.parse(h[j].at), reason: end.type };
                }
            }
            return null;
        }
        return null;
    }

    // --------------------------------------------------------------- ciclo
    function spawnTick() {
        timer = null;
        nextTickAt = null;
        let proc;
        try {
            // WATCHER_LOOP_STARTED_AT/WATCHER_TICK_INTERVAL_MS: o watcher grava uptime e
            // próxima poll no watcher-runtime.json (lido pelo --health-check).
            const env = { ...process.env, ...options.env, REPO_PATH: repoRoot, PRISMA_ROOT, WATCHER_LOOP_STARTED_AT: new Date(startedAt || Date.now()).toISOString(), WATCHER_TICK_INTERVAL_MS: String(intervalMs) };
            if (loopLock) env[watcherLock.TOKEN_ENV] = loopLock.holder.token;
            else delete env[watcherLock.TOKEN_ENV];
            proc = spawn(process.execPath, [script, ...args], { cwd, env, detached: false, stdio: ['ignore', 'pipe', 'pipe'] });
        } catch (e) {
            note(`falha iniciando o watcher: ${e.message}`, 'ERROR');
            return onCrash(null, null);
        }
        child = proc;
        ticks++;
        tickStartedAt = Date.now();
        if (proc.pid) writePid(proc.pid);
        lineReader(proc.stdout, 'stdout');
        lineReader(proc.stderr, 'stderr');
        proc.on('error', e => note(`erro no processo do watcher: ${e.message}`, 'ERROR'));
        proc.on('exit', (code, signal) => {
            if (child !== proc) return;
            child = null;
            tickStartedAt = null;
            clearPid();
            if (state === 'stopping' || state === 'stopped') return;
            if (code === 0) {
                state = 'running';
                nextTickAt = Date.now() + intervalMs;
                timer = setTimeout(spawnTick, intervalMs);
                timer.unref?.();
            } else {
                onCrash(code, signal);
            }
        });
    }

    function onCrash(code, signal) {
        const how = signal ? `sinal ${signal}` : `código ${code}`;
        const now = Date.now();
        restartTimes = restartTimes.filter(t => now - t < RESTART_WINDOW_MS);
        record('crash', { code, signal });
        if (restartTimes.length >= MAX_AUTO_RESTARTS) {
            state = 'stopped';
            error = 'restart_limit_reached';
            startedAt = null;
            releaseLoopLock();
            note(`watcher morreu (${how}) — limite de ${MAX_AUTO_RESTARTS} reinícios automáticos por hora atingido; não reinicio mais. Verifique o log e use Start.`, 'ERROR');
            record('restart_limit');
            return;
        }
        restartTimes.push(now);
        restarts++;
        state = 'restarting';
        note(`watcher morreu (${how}) — reiniciando automaticamente em ${Math.round(restartDelayMs / 1000)}s... tentativa ${restartTimes.length}/${MAX_AUTO_RESTARTS}`, 'WARN');
        nextTickAt = now + restartDelayMs;
        timer = setTimeout(() => { if (state === 'restarting') { state = 'running'; spawnTick(); } }, restartDelayMs);
        timer.unref?.();
    }

    function killGracefully(proc) {
        return new Promise(resolve => {
            if (!proc || proc.exitCode !== null || proc.signalCode !== null) return resolve();
            const hard = setTimeout(() => {
                note(`watcher não saiu em ${stopGraceMs / 1000}s após SIGTERM — enviando SIGKILL`, 'WARN');
                try { proc.kill('SIGKILL'); } catch {}
            }, stopGraceMs);
            proc.once('exit', () => { clearTimeout(hard); resolve(); });
            try { proc.kill('SIGTERM'); } catch { clearTimeout(hard); resolve(); }
        });
    }

    async function killOrphan(pid) {
        note(`encerrando watcher órfão de uma execução anterior do dashboard (PID ${pid})`, 'WARN');
        try { process.kill(pid, 'SIGTERM'); } catch {}
        for (const end = Date.now() + stopGraceMs; Date.now() < end && isAlive(pid);) await new Promise(r => setTimeout(r, 100));
        if (isAlive(pid)) { try { process.kill(pid, 'SIGKILL'); } catch {} }
        clearPid();
    }

    // --------------------------------------------------------------- API
    async function start({ reason = 'manual' } = {}) {
        if (stopPromise) await stopPromise;
        if (state !== 'stopped') return status();
        // Claim antes do killOrphan. Sem isto o estado segue 'stopped' enquanto o
        // órfão morre, e um POST /api/version/update no mesmo instante passa no
        // busyReason e move o pin com o Start já em curso.
        state = 'starting';
        try {
            if (orphanPid) { const pid = orphanPid; orphanPid = null; if (isAlive(pid)) await killOrphan(pid); }
            if (state !== 'starting') return status();
            if (options.lock !== false) {
                const res = watcherLock.acquire({ repoPath: repoRoot, role: 'loop', env: {} });
                if (!res.acquired) {
                    error = 'lock_held';
                    state = 'stopped';
                    note(`watcher não iniciado: ${res.message}. Pare a outra instância (confira com \`node scripts/lib/watcher-lock.js status --repo=${repoRoot}\`).`, 'ERROR');
                    return status();
                }
                if (res.takeover) note(`trava velha retomada (${watcherLock.describeHolder(res.previous)} não está mais vivo)`, 'WARN');
                loopLock = res;
            }
            redact.reset(); // relê os secrets: o .env pode ter mudado desde o último start
            error = null;
            restarts = 0;
            restartTimes = [];
            startedAt = Date.now();
            state = 'running';
            note(`watcher iniciado (${reason}) — um tick a cada ${Math.round(intervalMs / 1000)}s`);
            record('start', { reason });
            spawnTick();
            return status();
        } finally {
            if (state === 'starting') state = 'stopped';
        }
    }

    function stop({ reason = 'manual' } = {}) {
        if (stopPromise) return stopPromise;
        if (state === 'stopped') {
            // stop() depois do limite de reinícios só limpa o aviso.
            if (error) { error = null; }
            return Promise.resolve(status());
        }
        state = 'stopping';
        if (timer) { clearTimeout(timer); timer = null; }
        nextTickAt = null;
        const proc = child;
        stopPromise = killGracefully(proc).then(() => {
            child = null;
            tickStartedAt = null;
            clearPid();
            releaseLoopLock();
            state = 'stopped';
            startedAt = null;
            stopPromise = null;
            note(`watcher parado (${reason})`);
            record('stop', { reason });
            return status();
        });
        return stopPromise;
    }

    async function restart() {
        await stop({ reason: 'restart' });
        return start({ reason: 'restart' });
    }

    function status() {
        const now = Date.now();
        return {
            running: state === 'running' || state === 'restarting',
            state,
            // Entre ticks não há processo: pid null com running=true é o normal.
            pid: child?.pid ?? null,
            uptime_ms: startedAt ? now - startedAt : null,
            restarts,
            restarts_last_hour: restartTimes.filter(t => now - t < RESTART_WINDOW_MS).length,
            max_restarts_per_hour: MAX_AUTO_RESTARTS,
            error,
            phase: child ? 'tick' : (state === 'running' || state === 'restarting') ? 'idle' : null,
            tick_started_at: tickStartedAt ? new Date(tickStartedAt).toISOString() : null,
            next_tick_at: nextTickAt ? new Date(nextTickAt).toISOString() : null,
            interval_ms: intervalMs,
            ticks,
            orphan_pid: orphanPid && isAlive(orphanPid) ? orphanPid : null,
            last_run: lastRun(),
        };
    }

    function getLogBuffer() { return buffer.slice(); }

    // Sem isto, derrubar o server.js com o watcher no meio de um tick deixava o filho
    // órfão (detached:false não mata o filho sozinho fora de Ctrl+C no terminal).
    function killSync() {
        if (timer) clearTimeout(timer);
        if (child) { try { child.kill('SIGTERM'); } catch {} clearPid(); }
        releaseLoopLock();
    }

    if (orphanPid) note(`watcher órfão detectado (PID ${orphanPid}, de uma execução anterior do dashboard) — será encerrado no próximo Start`, 'WARN');

    function onLine(fn) { events.on('line', fn); return () => events.off('line', fn); }

    return { start, stop, restart, status, getLogBuffer, onLine, events, killSync };
}

let singleton = null;
function instance() {
    if (!singleton) {
        singleton = createWatcherManager();
        process.once('exit', () => singleton.killSync());
    }
    return singleton;
}

module.exports = {
    start: opts => instance().start(opts),
    stop: opts => instance().stop(opts),
    restart: () => instance().restart(),
    status: () => instance().status(),
    getLogBuffer: () => instance().getLogBuffer(),
    onLine: fn => instance().onLine(fn),
    createWatcherManager,
    createRedactor,
    parseEnvFile,
    levelOf,
    isAlive,
    MAX_AUTO_RESTARTS,
    LOG_LINES,
};
