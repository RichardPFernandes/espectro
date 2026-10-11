// Painel "Versão": revisão do Prisma em execução vs origin/main e troca do pin.
// O Prisma não conhece o consumidor: o bump e o reinício são comandos que o próprio
// consumidor declara (PRISMA_BUMP_COMMAND / PRISMA_RESTART_COMMAND). Sem o bump
// declarado, o painel é só leitura.
//
// "Em execução" é a revisão do boot deste processo, não o HEAD em disco: o bump move o
// checkout antes do reinício, e confundir os dois faria o painel mostrar código novo
// rodando quando ainda é o antigo.
const fs = require('fs');
const path = require('path');
const { execFile, spawn } = require('child_process');

const SHA_RE = /^[0-9a-f]{40}$/;
const FETCH_TTL_MS = 60 * 1000;
const MAX_COMMITS = 200;
const MAX_OUTPUT = 8000;
const BUMP_TIMEOUT_MS = 5 * 60 * 1000;

function run(file, args, { cwd, env, timeout = 15000 } = {}) {
    return new Promise(resolve => {
        execFile(file, args, { cwd, env, timeout, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
            resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout: String(stdout), stderr: String(stderr), timedOut: !!err?.killed });
        });
    });
}

// Bump em grupo de processos próprio: no timeout mata o grupo inteiro (git/npm filhos
// também) e só resolve no `close`, então o lock de update cobre a vida real do bump.
// Saída guardada só no fim (cauda), sem estourar buffer com log de npm ci.
function runGroup(file, args, { cwd, env, timeout = BUMP_TIMEOUT_MS } = {}) {
    return new Promise(done => {
        let out = '';
        let timedOut = false;
        let settled = false;
        const resolve = r => { if (!settled) { settled = true; done(r); } };
        const keep = chunk => { out = (out + chunk).slice(-MAX_OUTPUT * 2); };
        let child;
        try {
            child = spawn(file, args, { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
        } catch (e) {
            return resolve({ code: 1, stdout: '', stderr: e.message, timedOut: false });
        }
        child.stdout.on('data', keep);
        child.stderr.on('data', keep);
        const killGroup = sig => { try { process.kill(-child.pid, sig); } catch { /* já saiu */ } };
        const timer = setTimeout(() => {
            timedOut = true;
            killGroup('SIGTERM');
            setTimeout(() => killGroup('SIGKILL'), 5000).unref();
        }, timeout);
        // `close` não é garantido depois de `error`: resolve aqui também, sem prender o lock.
        child.on('error', e => { clearTimeout(timer); resolve({ code: 1, stdout: `${out}\n${e.message}`, stderr: '', timedOut }); });
        child.on('close', code => {
            clearTimeout(timer);
            resolve({ code: typeof code === 'number' ? code : 1, stdout: out, stderr: '', timedOut });
        });
    });
}

function tail(text) {
    return text.length > MAX_OUTPUT ? `…${text.slice(-MAX_OUTPUT)}` : text;
}

function createVersion({ prismaRoot, repoRoot, env, redact, watcherStatus, lockStatus, requestExit = null, exec = run, execBump = runGroup, spawnDetached = null, now = () => Date.now(), pid = process.pid }) {
    const bumpCommand = String(env.PRISMA_BUMP_COMMAND || '').trim();
    const restartCommand = String(env.PRISMA_RESTART_COMMAND || '').trim();
    const git = args => exec('git', ['-C', prismaRoot, ...args], { env });
    const startedAt = new Date(now()).toISOString();
    let fetched = null; // { at, error }
    let fetching = null; // fetch em voo compartilhado entre GETs
    let updating = false;
    let lastUpdate = null;

    async function commit(ref) {
        const r = await git(['log', '-1', '--format=%H%x09%cI%x09%s', ref]);
        if (r.code !== 0) return null;
        const [sha, date, ...subject] = r.stdout.trim().split('\t');
        return SHA_RE.test(sha) ? { sha, date, subject: subject.join('\t') } : null;
    }
    const boot = commit('HEAD');

    async function fetchMain(force) {
        // Durante o bump o fetch é dele: um fetch paralelo disputa o lock de refs.
        if (updating && fetched) return fetched;
        if (!force && fetched && now() - fetched.at < FETCH_TTL_MS) return fetched;
        if (!fetching) {
            fetching = git(['fetch', '--quiet', 'origin', 'main']).then(r => {
                fetched = { at: now(), error: r.code === 0 ? null : (r.timedOut ? 'git fetch excedeu o tempo' : 'git fetch falhou') };
                return fetched;
            }).finally(() => { fetching = null; });
        }
        return fetching;
    }

    // Motivo pelo qual não dá pra trocar agora (null = livre). Mesmas travas do bump do consumidor.
    function busyReason() {
        if (updating) return 'Atualização em andamento.';
        const w = watcherStatus();
        if (w?.running || (w?.state && w.state !== 'stopped')) return 'Loop do watcher ativo; pare o watcher antes de atualizar.';
        let lock;
        try { lock = lockStatus(); } catch { return 'Não foi possível conferir a trava do watcher.'; }
        if (lock?.lock_state === 'held') return 'Outro watcher detém a trava deste repositório.';
        if (lock?.agents?.length) return `Agente vivo (${lock.agents.map(a => a.task_id).join(', ')}); espere terminar.`;
        return null;
    }

    async function read({ force = false } = {}) {
        const current = await boot;
        if (!current) return { status: 'unavailable', message: 'PRISMA_ROOT não é um checkout git legível.' };
        const checkout = await commit('HEAD');
        const fetchState = await fetchMain(force);
        const latest = await commit('origin/main');
        let behind = [];
        let ahead = false;
        if (latest && latest.sha !== current.sha) {
            const log = await git(['log', `--max-count=${MAX_COMMITS}`, '--format=%H%x09%s', `${current.sha}..${latest.sha}`]);
            behind = log.code === 0 ? log.stdout.split('\n').filter(Boolean).map(line => {
                const [sha, ...subject] = line.split('\t');
                return { sha, subject: subject.join('\t') };
            }) : [];
            ahead = (await git(['merge-base', '--is-ancestor', latest.sha, current.sha])).code === 0;
        }
        const drift = !!checkout && checkout.sha !== current.sha;
        let reason = null;
        if (!bumpCommand) reason = 'Consumidor não declarou PRISMA_BUMP_COMMAND; painel somente leitura.';
        else if (drift) reason = `Checkout em disco (${checkout.sha.slice(0, 7)}) difere do código em execução; reinicie o dashboard antes de atualizar de novo.`;
        else if (!latest) reason = 'origin/main indisponível.';
        else if (latest.sha === current.sha) reason = 'Já está na origin/main.';
        else if (ahead) reason = 'A revisão em execução está à frente da origin/main.';
        else reason = busyReason();
        return redact({
            status: 'ok',
            pid,
            started_at: startedAt,
            current,
            checkout,
            drift,
            latest,
            behind,
            behind_truncated: behind.length === MAX_COMMITS,
            fetched_at: new Date(fetchState.at).toISOString(),
            fetch_error: fetchState.error,
            update: {
                configured: !!bumpCommand,
                enabled: reason === null,
                reason,
                restart: !!(restartCommand && requestExit),
            },
            last_update: lastUpdate,
        });
    }

    // Processo novo destacado que espera este sair (a porta fica livre) e sobe o dashboard.
    function scheduleRestart() {
        const logFile = path.join(repoRoot, 'dashboard', 'version-restart.log');
        const script = 'while kill -0 "$1" 2>/dev/null; do sleep 0.2; done; shift; exec /bin/sh -c "$1"';
        const doSpawn = spawnDetached || ((args, opts) => {
            const out = fs.openSync(logFile, 'a');
            try {
                const child = spawn('/bin/sh', args, { ...opts, detached: true, stdio: ['ignore', out, out] });
                child.on('error', e => console.error('[version] reinício falhou:', e.message));
                child.unref();
                return child;
            } finally { fs.closeSync(out); }
        });
        doSpawn(['-c', script, 'sh', String(pid), restartCommand], { cwd: repoRoot, env });
        return logFile;
    }

    async function update(target) {
        if (!bumpCommand) return { status: 409, body: { error: 'Consumidor não declarou PRISMA_BUMP_COMMAND.' } };
        if (typeof target !== 'string' || !SHA_RE.test(target)) return { status: 400, body: { error: 'target deve ser um SHA completo (40 hex).' } };
        const busy = busyReason();
        if (busy) return { status: 409, body: { error: busy } };
        updating = true;
        let restarting = false;
        try {
            const running = (await boot)?.sha || null;
            const before = (await commit('HEAD'))?.sha || null;
            if (before !== running) return { status: 409, body: { error: 'Checkout em disco difere do código em execução; reinicie o dashboard antes de atualizar.' } };
            if (before === target) return { status: 409, body: { error: 'Já está nessa revisão.' } };
            await (fetching || Promise.resolve());
            const f = await git(['fetch', '--quiet', 'origin', 'main']);
            fetched = { at: now(), error: f.code === 0 ? null : 'git fetch falhou' };
            if ((await git(['merge-base', '--is-ancestor', target, 'origin/main'])).code !== 0) {
                return { status: 409, body: { error: 'Revisão alvo não está na origin/main.' } };
            }
            // target já validado como hex: seguro interpolar como $1.
            const r = await execBump('/bin/sh', ['-c', `${bumpCommand} "$1"`, 'sh', target], {
                cwd: repoRoot, env: { ...env, PRISMA_DASHBOARD_PID: String(pid) }, timeout: BUMP_TIMEOUT_MS,
            });
            const after = (await commit('HEAD'))?.sha || null;
            const output = redact(tail(`${r.stdout}${r.stderr ? `\n${r.stderr}` : ''}`.trim()));
            const ok = r.code === 0 && after === target;
            let error = null;
            if (!ok) {
                const moved = after !== before ? ` PRISMA_ROOT já está em ${String(after).slice(0, 7)} e o pin do consumidor pode não ter acompanhado; rode o bump do consumidor à mão (para o alvo ou de volta para ${String(before).slice(0, 7)}) e reinicie o dashboard.` : '';
                error = (r.code === 0 ? 'Bump terminou mas PRISMA_ROOT não está no alvo; dashboard não reiniciado.'
                    : r.timedOut ? 'Bump excedeu o tempo e foi encerrado.' : `Bump falhou (exit ${r.code}).`) + moved;
            }
            lastUpdate = { at: new Date(now()).toISOString(), from: before, to: target, ok, exit_code: r.code, output, ...(error ? { error } : {}) };
            if (!ok) return { status: 500, body: { error, update: lastUpdate } };
            if (restartCommand && requestExit) {
                let log;
                try {
                    log = scheduleRestart();
                } catch (e) {
                    lastUpdate.warning = 'Pin atualizado, mas o reinício não pôde ser agendado; reinicie o dashboard à mão.';
                    return { status: 200, body: { ok: true, update: lastUpdate, restarting: false, restart_log: null } };
                }
                restarting = true; // segura o lock até o processo sair
                setTimeout(() => requestExit(), 300).unref?.();
                return { status: 200, body: { ok: true, update: lastUpdate, restarting: true, restart_log: log } };
            }
            return { status: 200, body: { ok: true, update: lastUpdate, restarting: false, restart_log: null } };
        } finally {
            if (!restarting) updating = false;
        }
    }

    return { read, update, isUpdating: () => updating };
}

module.exports = { createVersion, runGroup };
