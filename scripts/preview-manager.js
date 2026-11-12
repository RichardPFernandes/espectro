// Preview de ambiente de um ticket a partir do dashboard (dashboard/server.js >
// /api/preview/:ticketId/*): builda mo-entity → app-core → app-back (só os que têm
// worktree próprio; os outros vêm do ~/.m2) e sobe app-back (Quarkus, :8081) e
// app-front (grunt serve, :9100) como filhos controlados. Mesmo padrão do
// watcher-manager.js: spawn + ringbuffer + EventEmitter pro SSE.
//
// Só um preview por vez (porta fixa): start() de outro ticket com um ativo → 409.
//
// Processos: cada filho sobe com detached:true (grupo próprio) e é morto por
// kill(-pid) — mata o grupo que ESTE módulo criou (mvn + o java dele, npm + grunt), e
// nada mais. Nunca procura processo por nome/porta: o app-back do checkout principal
// (:8080) e o grunt dele ficam intocados. Nada é gravado em disco (nem PID).
//
// app-front: o Gruntfile do repo fixa a porta 9000 e o proxy /api e /portal/api em
// localhost:8080 (o back principal). Em vez de mexer no repo do front, o grunt serve
// roda via scripts/preview-gruntfile.js, que carrega o Gruntfile original e troca
// porta e proxy pro back do preview.
//
// Fonte do código (start({ source })):
//   - 'worktree' (padrão): .claude/worktrees/<id> e os worktrees irmãos do ticket;
//   - 'commit': um commit da branch do ticket (origin/<id>, senão a local <id>) do
//     app-back — o último se start() não receber `commit` — e a ponta da mesma branch
//     no app-front. O código sai com `git archive` numa pasta temporária: só lê objetos,
//     sem checkout, worktree, índice ou HEAD nos repos locais. Serve pro ticket cujo
//     worktree o watcher já removeu e pra voltar a um commit anterior do ticket.
//
// Ambiente local intocado: portas próprias (8081/9100, não as 8080/9000 do ambiente de
// sempre); todo mvn do preview grava num repositório Maven só dele (PREVIEW_M2_REPO) e lê
// o ~/.m2 como somente leitura (maven.repo.local.tail, Maven 3.9+) — o `install` de
// mo-entity/app-core nunca troca o SNAPSHOT que o checkout principal usa; libs vindas
// de branch também saem por `git archive`. Nos repos locais o preview só faz
// `git fetch` (refs remotas).
//
// Secrets: toda linha passa pelo mesmo redator do watcher-manager (env + .env do repo)
// acrescido das senhas do application-<profile>.properties do worktree.
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn, execFile, execFileSync } = require('child_process');
const { EventEmitter } = require('events');
const { pipeline: streamPipeline } = require('stream');
const { createRedactor, levelOf } = require('./watcher-manager');
const { resolveJavaHome } = require('./lib/build-validator');

const LOG_LINES = 300;
const STOP_GRACE_MS = 8000;
const BACK_STARTUP_TIMEOUT_MS = 120000;
const FRONT_READY_FALLBACK_MS = 15000;
const TICKET_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SOURCES = ['worktree', 'commit'];
const SHA_RE = /^[0-9a-f]{7,40}$/;
const COMMITS_MAX = 30;
// Ref escolhida no painel (origin/<branch>): vai como argumento do git (sem shell), mas não
// pode começar com '-' (virar opção) nem ter '..'. Branch com '@{' ou espaço não passa.
const LIB_REF_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;
const LIB_REF_SCAN_MAX = 200;
const ACTIVE_PHASES = ['exporting', 'building-mo-entity', 'building-app-core', 'building-app-back', 'starting-back', 'starting-front', 'running', 'stopping'];
const BUILD_STEPS = [
    { key: 'mo-entity', dir: 'moEntity', phase: 'building-mo-entity', goal: 'install' },
    { key: 'app-core', dir: 'appCore', phase: 'building-app-core', goal: 'install' },
    { key: 'app-back', dir: 'back', phase: 'building-app-back', goal: 'package', label: 'build-back' },
];
// Quarkus: "... (powered by Quarkus x.y) started in 4.321s. Listening on: ..."
const QUARKUS_STARTED_RE = /\bstarted in [\d.,]+\s*s\b/i;
// grunt: o connect loga "Started connect web server on ..." quando sobe; o watch, logo
// depois, escreve "Waiting..." SEM \n — por isso casa no chunk cru, não por linha.
const GRUNT_READY_RE = /Started connect web server on|\bWaiting\.\.\./;
// Cor ANSI (grunt, Quarkus, mvn): sujaria o log do painel e os regex de pronto.
const ANSI_RE = /\x1b\[[0-9;?]*[A-Za-z]/g;
const PROP_SECRET_KEY_RE = /(password|senha|secret|token|api[-_.]?key|credential)/i;

function httpError(status, message) { return Object.assign(new Error(message), { status }); }

function portInUse(port, host = '127.0.0.1') {
    return new Promise(resolve => {
        const sock = net.connect({ port, host });
        const done = used => { sock.destroy(); resolve(used); };
        sock.setTimeout(1000, () => done(false));
        sock.once('connect', () => done(true));
        sock.once('error', () => done(false));
    });
}

// .properties é ISO-8859-1 (o application-local-dev.properties tem acento em latin1).
function readProperties(file) {
    const out = {};
    let text;
    try { text = fs.readFileSync(file, 'latin1'); } catch { return out; }
    for (const raw of text.split(/\r?\n/)) {
        const line = raw.trim();
        if (!line || line.startsWith('#') || line.startsWith('!')) continue;
        const m = line.match(/^([^=:\s]+)\s*[=:]\s*(.*)$/);
        if (m) out[m[1]] = m[2].trim();
    }
    return out;
}

// groupId/artifactId/version do próprio projeto (ignora <parent> e dependências).
function pomCoords(pom) {
    const own = String(pom || '').replace(/<parent>[\s\S]*?<\/parent>/, '').split(/<(?:dependencies|dependencyManagement|build|profiles|properties)>/)[0];
    const tag = t => (own.match(new RegExp(`<${t}>\\s*([^<\\s]+)\\s*</${t}>`)) || [])[1];
    const [g, a, v] = [tag('groupId'), tag('artifactId'), tag('version')];
    if (!g || !a || !v || /\$\{/.test(g + a + v) || [g, a, v].some(x => x.includes('..'))) return null;
    return { g, a, v };
}

function git(cwd, args, timeout = 120000) {
    return new Promise((resolve, reject) => {
        execFile('git', args, { cwd, timeout, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
            if (err) return reject(Object.assign(err, { message: String(stderr || err.message).trim().split('\n').pop() }));
            resolve(String(stdout));
        });
    });
}

// Commit → pasta comum via `git archive | tar -x`. Diferente de `git worktree add`, não
// registra nada no repo nem toca o working tree dele. onSpawn recebe [archive, tar] pro
// stop() poder matar a extração no meio.
const rmDir = dir => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
function exportCommit(repo, sha, dir, { archive: archiveCmd, onSpawn } = {}) {
    rmDir(dir);
    fs.mkdirSync(dir, { recursive: true });
    return new Promise((resolve, reject) => {
        const { cmd, args } = archiveCmd ? archiveCmd(sha) : { cmd: 'git', args: ['archive', '--format=tar', sha] };
        const archive = spawn(cmd, args, { cwd: repo, stdio: ['ignore', 'pipe', 'pipe'] });
        const tar = spawn('tar', ['-x', '-f', '-', '-C', dir], { stdio: ['pipe', 'ignore', 'pipe'] });
        onSpawn?.([archive, tar]);
        // pipeline: EPIPE no stdin do tar (tar morto pelo stop) não vira exceção sem dono.
        streamPipeline(archive.stdout, tar.stdin, () => {});
        let stderr = '', failed = null, pending = 2;
        for (const p of [archive, tar]) p.stderr.on('data', d => { stderr += d; });
        const done = who => code => {
            if (code !== 0 && !failed) failed = `${who} saiu com código ${code}${stderr.trim() ? `: ${stderr.trim().split('\n').pop()}` : ''}`;
            if (--pending === 0) failed ? reject(new Error(failed)) : resolve();
        };
        archive.on('close', done('git archive'));
        tar.on('close', done('tar'));
        archive.on('error', reject);
        tar.on('error', reject);
    });
}

const gitSync = (repo, args) => execFileSync('git', args, { cwd: repo, stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 }).toString().trim();

// Branch do ticket: origin/<id> (o que foi pro PR) antes da local. Refs completas porque
// `<id>` sozinho é ambíguo no app-back (refs/churn/<id>-*).
function ticketBranch(repo, ticketId) {
    if (!repo || !fs.existsSync(path.join(repo, '.git'))) return null;
    for (const [full, ref] of [[`refs/remotes/origin/${ticketId}`, `origin/${ticketId}`], [`refs/heads/${ticketId}`, ticketId]]) {
        try { return { ref, sha: gitSync(repo, ['rev-parse', '--verify', '--quiet', `${full}^{commit}`]) }; } catch {}
    }
    return null;
}

function createPreviewManager(options = {}) {
    const env = options.env || process.env;
    const repoRoot = path.resolve(options.repoRoot || env.REPO_PATH || process.cwd());
    const adapter = options.adapter || env.PREVIEW_ADAPTER || null;
    const configured = adapter === 'maven-quarkus-grunt';
    const requireAdapter = () => { if (!configured) throw httpError(400, 'preview não configurado para este projeto'); };
    const worktreesDir = options.worktreesDir || path.join(repoRoot, '.claude', 'worktrees');
    const envFile = options.envFile === undefined ? path.join(repoRoot, '.env') : options.envFile;
    const ports = {
        // Fora das 8080/9000 do ambiente local: preview e ambiente de sempre lado a lado.
        back: options.ports?.back ?? (Number(env.PREVIEW_BACK_PORT) || 8081),
        front: options.ports?.front ?? (Number(env.PREVIEW_FRONT_PORT) || 9100),
    };
    // Bancos que o painel oferece: "rótulo=profile" (application-<profile>.properties).
    // Lista explícita de propósito — vários profiles do repo apontam pra produção.
    const dbOptions = String(options.dbOptions || env.PREVIEW_DB_OPTIONS || '')
        .split(',').map(x => x.trim()).filter(Boolean)
        .map(x => { const [key, prof] = x.includes('=') ? x.split('=').map(y => y.trim()) : [x, x]; return { key, profile: prof }; })
        .filter(o => o.key && /^[A-Za-z0-9._-]+$/.test(o.profile));
    const defaultProfile = options.profile || env.PREVIEW_PROFILE || dbOptions[0]?.profile || null;
    // Sem PREVIEW_JAVA_HOME, o JAVA_HOME herdado só vale se atender o release do pom;
    // senão `java_home -v <release>` (mesma regra do portão de build). Achado no #43646:
    // dashboard subido de shell com JDK 17 → "release version 25 not supported".
    // JDK discovery happens only after an explicitly configured start.
    let javaHome = options.javaHome ?? env.PREVIEW_JAVA_HOME ?? '';
    let javaResolved = options.javaHome !== undefined || !!env.PREVIEW_JAVA_HOME;
    const mvnOffline = options.mvnOffline ?? /^(1|true|sim|yes)$/i.test(env.PREVIEW_MVN_OFFLINE || '');
    const startupTimeoutMs = options.startupTimeoutMs ?? BACK_STARTUP_TIMEOUT_MS;
    const frontReadyMs = options.frontReadyMs ?? FRONT_READY_FALLBACK_MS;
    const stopGraceMs = options.stopGraceMs ?? STOP_GRACE_MS;
    const checkPorts = options.checkPorts ?? true;
    // ~/.m2 do usuário: só leitura pro preview (tail). O que o preview instala ou baixa vai
    // pro previewM2.
    const m2Repo = options.m2Repo || path.join(os.homedir(), '.m2', 'repository');
    // `~/` vira o home: resolvido a partir do repoRoot criaria a pasta "~" dentro do checkout.
    const userPath = p => (p === '~' || p.startsWith('~/') ? path.join(os.homedir(), p.slice(1)) : path.resolve(repoRoot, p));
    const previewM2 = options.previewM2 || (env.PREVIEW_M2_REPO ? userPath(env.PREVIEW_M2_REPO) : path.join(os.homedir(), '.cache', 'prisma-preview', 'm2'));
    if (path.resolve(previewM2) === path.resolve(m2Repo)) throw new Error('PREVIEW_M2_REPO não pode ser o ~/.m2 do usuário');
    // Lib sem worktree do ticket: builda do repo irmão (../mo-entity, ../app-core) na
    // primeira branch remota cuja versão bate com a do back — origin/<ticket>, depois
    // PREVIEW_LIB_REFS — em vez de confiar no ~/.m2 (que um install local de checkout
    // velho sobrescreve sem aviso: #43646). PREVIEW_LIBS_FROM_BRANCH=false desliga.
    const configuredRepo = key => env[key] ? path.resolve(repoRoot, env[key]) : null;
    const libRepos = options.libRepos || {
        moEntity: configuredRepo('PREVIEW_MO_ENTITY_REPO'),
        appCore: configuredRepo('PREVIEW_APP_CORE_REPO'),
        front: configuredRepo('PREVIEW_FRONT_REPO'),
    };
    const libRefs = options.libRefs || (env.PREVIEW_LIB_REFS || '').split(',').map(r => r.trim()).filter(Boolean);
    const libsFromBranch = options.libsFromBranch ?? !/^(0|false|nao|não|no)$/i.test(env.PREVIEW_LIBS_FROM_BRANCH || '');
    const libTmpDir = options.libTmpDir || os.tmpdir();
    // Código extraído no modo commit: <libTmpDir>/preview-src-<id>/{<id>,<id>-app-front}.
    const srcDir = ticketId => path.join(libTmpDir, `preview-src-${ticketId}`);
    const gruntWrapper = options.gruntWrapper || path.join(__dirname, 'preview-gruntfile.js');
    // Porta ocupada (ex.: PREVIEW_BACK_PORT=8080 com o app-back principal de pé) é recusada
    // pelo portInUse do start.
    if (ports.back === ports.front) throw new Error(`PREVIEW_BACK_PORT e PREVIEW_FRONT_PORT não podem ser iguais (${ports.back})`);

    const events = new EventEmitter();
    events.setMaxListeners(0);
    const previews = new Map(); // ticketId → state
    let seq = 0;
    let propSecrets = {};
    // env do filho (não process.env): é o que ele enxerga e pode imprimir.
    const redact = createRedactor(envFile, () => propSecrets, env);

    // --------------------------------------------------------------- comandos
    // Sobrescrevível nos testes (options.commands[step] = wt => ({ cmd, args })).
    const configFile = profile => path.join('src', 'main', 'resources', `application-${profile}.properties`);
    const defaults = {
        build: (wt, step) => ({ cmd: 'mvn', args: [...(mvnOffline ? ['-o'] : []), 'clean', step.goal, '-DskipTests', '-q', `-Dmaven.repo.local=${previewM2}`, `-Dmaven.repo.local.tail=${m2Repo}`] }),
        back: (wt, profile) => ({
            cmd: javaHome ? path.join(javaHome, 'bin', 'java') : 'java',
            args: [
                // Sem -Dquarkus.config.locations: com ele o Quarkus ignora o -Dquarkus.http.port
                // e sobe na 8080 do application.properties (#43646). O profile já carrega o
                // application-<profile>.properties de dentro do jar.
                `-Dquarkus.profile=${profile}`,
                `-Dquarkus.http.port=${ports.back}`,
                '-jar', path.join('target', 'quarkus-app', 'quarkus-run.jar'),
            ],
        }),
        // Extração do modo commit (e das libs de branch); os testes trocam por um processo lento.
        archive: sha => ({ cmd: 'git', args: ['archive', '--format=tar', sha] }),
        // = `grunt serve` do worktree, sem depender de grunt-cli global (ver preview-gruntfile.js).
        front: () => ({ cmd: process.execPath, args: [gruntWrapper, 'serve'] }),
    };
    const commands = { ...defaults, ...options.commands };

    function childEnv(extra = {}) {
        const e = { ...env, ...extra };
        if (javaHome) { e.JAVA_HOME = javaHome; e.PATH = `${path.join(javaHome, 'bin')}${path.delimiter}${env.PATH || ''}`; }
        return e;
    }

    // --------------------------------------------------------------- estado
    function detectWorktrees(ticketId) {
        const at = suffix => {
            const p = path.join(worktreesDir, `${ticketId}${suffix}`);
            return fs.existsSync(p) ? p : null;
        };
        // O watcher cria o worktree de cada repo dentro dele: ../app-core/.claude/worktrees/<id>.
        const sibling = key => {
            const p = libRepos[key] && path.join(libRepos[key], '.claude', 'worktrees', ticketId);
            return p && fs.existsSync(p) ? p : null;
        };
        return {
            back: at(''),
            moEntity: at('-mo-entity') || sibling('moEntity'),
            appCore: at('-app-core') || sibling('appCore'),
            front: at('-app-front') || sibling('front'),
        };
    }

    function detectBranches(ticketId) {
        return { back: ticketBranch(repoRoot, ticketId), front: ticketBranch(libRepos.front, ticketId) };
    }

    function blank(ticketId) {
        return {
            ticketId, phase: 'idle', processes: { back: null, front: null }, current: null,
            ports: { ...ports }, logBuffer: [], startedAt: null, runningAt: null, error: null,
            errorPhase: null, steps: {}, worktrees: null, timers: new Set(), runToken: 0,
            libFallbacks: [], libRef: null, source: null, commit: null, refs: {},
        };
    }
    function get(ticketId) {
        if (!previews.has(ticketId)) previews.set(ticketId, blank(ticketId));
        return previews.get(ticketId);
    }
    function activePreview() {
        for (const s of previews.values()) if (ACTIVE_PHASES.includes(s.phase)) return s;
        return null;
    }

    function validId(ticketId) {
        if (typeof ticketId !== 'string' || !TICKET_ID_RE.test(ticketId) || ticketId.includes('..')) throw httpError(400, `ticket-id inválido: ${ticketId}`);
        return ticketId;
    }

    // --------------------------------------------------------------- log
    function push(s, source, text, level) {
        const clean = redact(String(text).replace(ANSI_RE, ''));
        const entry = { seq: ++seq, ts: new Date().toISOString(), level: level || levelOf('stdout', clean), source, text: `[${source}] ${clean}` };
        s.logBuffer.push(entry);
        if (s.logBuffer.length > LOG_LINES) s.logBuffer.splice(0, s.logBuffer.length - LOG_LINES);
        events.emit('log', s.ticketId, entry);
        return entry;
    }
    const note = (s, text, level = 'INFO') => push(s, 'preview', text, level);

    function lineReader(stream, onLine) {
        let pending = '';
        stream.setEncoding('utf8');
        stream.on('data', chunk => {
            pending += chunk;
            const lines = pending.split(/\r?\n/);
            pending = lines.pop();
            for (const l of lines) if (l.trim()) onLine(l);
            if (pending.length > 16384) { onLine(pending); pending = ''; }
        });
        stream.on('end', () => { if (pending.trim()) onLine(pending); pending = ''; });
    }

    function setPhase(s, phase) {
        s.phase = phase;
        events.emit('phase', s.ticketId, status(s.ticketId));
    }

    function fail(s, message) {
        if (s.phase === 'stopping' || s.phase === 'idle' || s.phase === 'error') return;
        s.errorPhase = s.phase;
        s.error = message;
        for (const [k, v] of Object.entries(s.steps)) if (v === 'running') s.steps[k] = 'error';
        note(s, `erro na fase ${s.errorPhase}: ${message}`, 'ERROR');
        clearTimers(s);
        setPhase(s, 'error');
        // Erro = nada rodando: derruba o que sobrou (ex: back de pé e front caiu).
        const token = s.runToken;
        killAll(s).then(() => { if (token === s.runToken && s.phase === 'error') setPhase(s, 'error'); });
    }

    function clearTimers(s) { for (const t of s.timers) clearTimeout(t); s.timers.clear(); }
    function later(s, ms, fn) {
        const t = setTimeout(() => { s.timers.delete(t); fn(); }, ms);
        t.unref?.();
        s.timers.add(t);
        return t;
    }

    // --------------------------------------------------------------- processos
    function run(s, source, { cmd, args }, cwd, extraEnv, onLine) {
        const proc = spawn(cmd, args, { cwd, env: childEnv(extraEnv), detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
        const where = path.relative(worktreesDir, cwd);
        note(s, `${source}: ${path.basename(cmd)} ${args.join(' ')} (cwd ${where.startsWith('..') ? cwd : where || '.'}, PID ${proc.pid ?? '?'})`);
        const handle = line => { push(s, source, line); onLine?.(line); };
        lineReader(proc.stdout, handle);
        lineReader(proc.stderr, line => { push(s, source, line, levelOf('stderr', line)); onLine?.(line); });
        return proc;
    }

    function exited(proc) { return !proc || proc.exitCode !== null || proc.signalCode !== null; }

    function killGroup(proc) {
        return new Promise(resolve => {
            if (exited(proc) || !proc.pid) return resolve();
            const signal = sig => { try { process.kill(-proc.pid, sig); } catch { try { proc.kill(sig); } catch {} } };
            const hard = setTimeout(() => signal('SIGKILL'), stopGraceMs);
            proc.once('exit', () => { clearTimeout(hard); resolve(); });
            signal('SIGTERM');
        });
    }

    // Só zera o slot se ainda for o mesmo processo: um retry logo após o erro já pode
    // ter posto processo novo ali.
    function killAll(s) {
        const { current } = s, { back, front } = s.processes;
        return Promise.all([current, back, front].filter(Boolean).map(killGroup)).then(() => {
            if (s.current === current) s.current = null;
            if (s.processes.back === back) s.processes.back = null;
            if (s.processes.front === front) s.processes.front = null;
        });
    }

    // Build: resolve true com exit 0; false com erro/stop (fail() já registrou).
    function build(s, token, step, cwd = s.worktrees[step.dir]) {
        return new Promise(resolve => {
            s.steps[step.key] = 'running'; // antes do setPhase: o evento leva o snapshot
            setPhase(s, step.phase);
            const source = step.label || step.key;
            let proc;
            try { proc = run(s, source, commands.build(cwd, step), cwd); } catch (e) { fail(s, `${source}: ${e.message}`); return resolve(false); }
            s.current = proc;
            proc.on('error', e => { if (token === s.runToken) fail(s, `${source}: ${e.code === 'ENOENT' ? `comando não encontrado (${proc.spawnfile})` : e.message}`); resolve(false); });
            proc.on('exit', (code, sig) => {
                if (s.current === proc) s.current = null;
                if (token !== s.runToken || s.phase === 'stopping') return resolve(false);
                if (code === 0) { s.steps[step.key] = 'done'; note(s, `${source}: build ok`); return resolve(true); }
                fail(s, `BUILD FAILURE em ${source} (${sig ? `sinal ${sig}` : `código ${code}`}) — ver log abaixo`);
                resolve(false);
            });
        });
    }

    function startBack(s, token) {
        return new Promise(resolve => {
            s.steps.back = 'running';
            setPhase(s, 'starting-back');
            const wt = s.worktrees.back;
            const profile = s.profile || defaultProfile;
            const cfg = path.join(wt, configFile(profile));
            if (!fs.existsSync(path.join(wt, 'target', 'quarkus-app', 'quarkus-run.jar'))) {
                fail(s, 'target/quarkus-app/quarkus-run.jar não existe após o build');
                return resolve(false);
            }
            // Igual ao run-tms-local.sh: SISTEMA/ambiente vêm do .properties do profile.
            const props = readProperties(cfg);
            propSecrets = Object.fromEntries(Object.entries(props)
                .filter(([k, v]) => PROP_SECRET_KEY_RE.test(k) && v)
                .map(([, v], i) => [`PREVIEW_PROP_${i}_SECRET`, v]));
            redact.reset();
            const extraEnv = { SISTEMA: props.sistema || '', ambiente: props.ambiente || '', ...(env.MS_ROUTER ? { MS_ROUTER: env.MS_ROUTER } : {}) };
            note(s, `app-back: banco ${s.db || '—'} (profile ${profile}, ${dbLabel(props) || 'sem jdbc.url'}), SISTEMA=${extraEnv.SISTEMA || '—'}, ambiente=${extraEnv.ambiente || '—'}, porta ${ports.back}`);
            let settled = false;
            const settle = ok => { if (!settled) { settled = true; resolve(ok); } };
            let proc;
            try {
                proc = run(s, 'app-back', commands.back(wt, profile), wt, extraEnv, line => {
                    const clean = line.replace(ANSI_RE, '');
                    if (settled || !QUARKUS_STARTED_RE.test(clean)) return;
                    // Porta errada = ocupando a de outro processo sem saber.
                    const port = Number((clean.match(/Listening on: \S+?:(\d+)/) || [])[1]);
                    if (port && port !== ports.back) { fail(s, `app-back subiu na porta ${port}, não na ${ports.back} pedida — derrubado`); return settle(false); }
                    s.steps.back = 'done'; settle(true);
                });
            } catch (e) { fail(s, `app-back: ${e.message}`); return resolve(false); }
            s.processes.back = proc;
            later(s, startupTimeoutMs, () => {
                if (settled || token !== s.runToken) return;
                fail(s, `app-back não logou "started in" em ${Math.round(startupTimeoutMs / 1000)}s`);
                settle(false);
            });
            proc.on('error', e => { if (token === s.runToken) fail(s, `app-back: ${e.message}`); settle(false); });
            proc.on('exit', (code, sig) => {
                if (s.processes.back === proc) s.processes.back = null;
                if (token !== s.runToken || s.phase === 'stopping' || s.phase === 'idle') return settle(false);
                fail(s, `app-back encerrou (${sig ? `sinal ${sig}` : `código ${code}`})`);
                settle(false);
            });
        });
    }

    // Worktree novo do front não tem node_modules/bower_components (gitignored, e o npm
    // install do grunt 0.4.5 é lento/quebradiço): linka os do checkout principal quando
    // package.json e bower.json são idênticos; senão avisa pra rodar npm/bower install.
    function linkFrontDeps(s, wt) {
        const main = libRepos.front;
        const missing = [];
        if (!main || path.resolve(main) === path.resolve(wt)) return missing;
        const same = f => { try { return fs.readFileSync(path.join(main, f), 'utf8') === fs.readFileSync(path.join(wt, f), 'utf8'); } catch { return false; } };
        for (const [dir, manifest] of [['node_modules', 'package.json'], ['bower_components', 'bower.json']]) {
            if (fs.existsSync(path.join(wt, dir)) || !fs.existsSync(path.join(main, dir))) continue;
            if (!same(manifest)) {
                missing.push(manifest);
                if (s.source !== 'commit') note(s, `app-front: sem ${dir} no worktree e ${manifest} difere do checkout principal — rode o install no worktree`, 'WARN');
                continue;
            }
            try { fs.symlinkSync(path.join(main, dir), path.join(wt, dir), 'dir'); note(s, `app-front: ${dir} linkado do checkout principal (${manifest} idêntico)`); } catch (e) { note(s, `app-front: não linkou ${dir} (${e.message})`, 'WARN'); }
        }
        return missing;
    }

    function startFront(s, token) {
        return new Promise(resolve => {
            s.steps.front = 'running';
            setPhase(s, 'starting-front');
            const wt = s.worktrees.front;
            let settled = false;
            const settle = ok => { if (!settled) { settled = true; if (ok) s.steps.front = 'done'; resolve(ok); } };
            let proc;
            try {
                proc = run(s, 'app-front', commands.front(wt), wt,
                    { PREVIEW_FRONT_DIR: wt, PREVIEW_BACK_PORT: String(ports.back), PREVIEW_FRONT_PORT: String(ports.front) });
            } catch (e) { fail(s, `app-front: ${e.message}`); return resolve(false); }
            let tail = '';
            proc.stdout.on('data', chunk => {
                if (settled) return;
                tail = (tail + String(chunk)).replace(ANSI_RE, '').slice(-200);
                if (GRUNT_READY_RE.test(tail)) settle(true);
            });
            s.processes.front = proc;
            // grunt serve não tem sinal forte de pronto: "Waiting..." ou, sem ele, 15s.
            later(s, frontReadyMs, () => { if (token === s.runToken && !settled) { note(s, `app-front: sem "Waiting..." em ${Math.round(frontReadyMs / 1000)}s — considerando no ar`, 'WARN'); settle(true); } });
            proc.on('error', e => { if (token === s.runToken) fail(s, `app-front: ${e.message}`); settle(false); });
            proc.on('exit', (code, sig) => {
                if (s.processes.front === proc) s.processes.front = null;
                if (token !== s.runToken || s.phase === 'stopping' || s.phase === 'idle') return settle(false);
                fail(s, `app-front encerrou (${sig ? `sinal ${sig}` : `código ${code}`})`);
                settle(false);
            });
        });
    }

    const willBuild = (step, wt) => !!wt[step.dir] ||
        (step.dir !== 'back' && libsFromBranch && !!libRepos[step.dir] && fs.existsSync(path.join(libRepos[step.dir], '.git')));

    // Lib sem worktree: true = instalada (ou já estava, mesmo commit); false = pipeline
    // abortado (fail/stop); null = segue com o ~/.m2 (sem repo/branch com a versão).
    async function buildLibFromBranch(s, token, step) {
        const repo = libRepos[step.dir];
        const libRef = s.libRef; // fixo neste start: um stop+start durante o fetch não pode trocá-lo
        const stale = () => token !== s.runToken;
        const fallback = (why, fixable = true) => {
            if (stale()) return false; // pipeline velho não escreve no estado do start novo
            s.steps[step.key] = 'skipped';
            s.libFallbacks.push({ key: step.key, dir: step.dir, why, fixable });
            // O repositório do preview vem antes do ~/.m2: uma cópia da mesma versão instalada
            // por outro preview esconderia a do ~/.m2 (e o "rode o install da lib" do painel).
            const shadow = need && libDir(repo, need);
            if (shadow && fs.existsSync(shadow)) { try { rmDir(shadow); note(s, `${step.key}: ${need} do repositório do preview apagado`); } catch {} }
            note(s, `${step.key}: ${why} — usando a versão do ~/.m2`, 'WARN');
            return null;
        };
        let need = null;
        try { need = pomCoords(fs.readFileSync(path.join(s.worktrees.back, 'pom.xml'), 'utf8'))?.v; } catch {}
        if (!libsFromBranch) return fallback('PREVIEW_LIBS_FROM_BRANCH=false', false);
        if (!repo || !fs.existsSync(path.join(repo, '.git'))) return fallback('sem worktree próprio nem repo irmão', false);
        if (!need) return fallback('versão do app-back não encontrada no pom', false);
        try { await git(repo, ['fetch', '--quiet', 'origin']); } catch (e) { if (!stale()) note(s, `${step.key}: git fetch falhou (${e.message}) — usando as refs remotas locais`, 'WARN'); }
        if (stale()) return false;
        let ref = null, coords = null;
        // Ref escolhida no painel vem primeiro; sem a versão do back nela, segue a ordem padrão.
        const candidates = [...(libRef ? [libRef] : []), `origin/${s.ticketId}`, ...libRefs];
        for (const r of candidates) {
            try { coords = pomCoords(await git(repo, ['show', `${r}:pom.xml`])); } catch { continue; }
            if (stale()) return false;
            if (coords?.v === need) { ref = r; break; }
            if (r === libRef) note(s, `${step.key}: ${r} tem a versão ${coords?.v ?? '?'}, não ${need} — tentando as refs padrão`, 'WARN');
        }
        if (stale()) return false;
        if (!ref) return fallback(`nenhuma branch (${candidates.join(', ')}) com a versão ${need}`);
        const sha = (await git(repo, ['rev-parse', ref])).trim();
        const dir = path.join(previewM2, ...coords.g.split('.'), coords.a, coords.v);
        const jar = path.join(dir, `${coords.a}-${coords.v}.jar`);
        const marker = path.join(dir, '.preview-build.json');
        const jarMtime = () => { try { return fs.statSync(jar).mtimeMs; } catch { return null; } };
        try {
            const m = JSON.parse(fs.readFileSync(marker, 'utf8'));
            // mtime diferente = outro install sobrescreveu depois do nosso.
            if (!libRef && m.sha === sha && m.jarMtimeMs === jarMtime()) {
                s.steps[step.key] = 'done';
                note(s, `${step.key}: repositório do preview já tem ${coords.v} de ${ref} (${sha.slice(0, 10)}) — build pulado`);
                return true;
            }
        } catch {}
        const wt = path.join(libTmpDir, `preview-${step.key}-${s.ticketId}`);
        try { await extract(s, repo, sha, wt); } catch (e) { if (!stale()) fail(s, `${step.key}: git archive ${ref} falhou (${e.message})`); return false; }
        note(s, `${step.key}: sem worktree próprio — buildando ${ref} (${sha.slice(0, 10)}, versão ${coords.v})`);
        try {
            if (token !== s.runToken) return false;
            const ok = await build(s, token, { ...step, label: `${step.key}@${ref}` }, wt);
            if (ok) { try { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(marker, JSON.stringify({ sha, ref, jarMtimeMs: jarMtime(), at: new Date().toISOString() })); } catch {} }
            return ok;
        } finally {
            try { rmDir(wt); } catch {}
        }
    }

    // exportCommit com o comando do preview; o archive fica em s.current (pids.build) pro stop
    // matá-lo — o tar termina sozinho quando a entrada fecha.
    async function extract(s, repo, sha, dir) {
        let archive = null;
        try { await exportCommit(repo, sha, dir, { archive: commands.archive, onSpawn: ([a]) => { archive = a; s.current = a; } }); } finally {
            if (s.current === archive) s.current = null;
        }
    }

    // Modo commit: extrai o commit escolhido do app-back e a ponta da branch do ticket no
    // app-front. Nos repos, só o fetch escreve — e só em refs/remotes/origin/<id>.
    async function exportSources(s, token) {
        setPhase(s, 'exporting');
        const stale = () => token !== s.runToken;
        const fetchTicket = async (repo, label) => {
            try { await git(repo, ['fetch', '--quiet', 'origin', `+refs/heads/${s.ticketId}:refs/remotes/origin/${s.ticketId}`], 30000); } catch (e) { if (!stale()) note(s, `${label}: git fetch origin ${s.ticketId} falhou (${e.message}) — usando as refs locais`, 'WARN'); }
        };
        rmDir(srcDir(s.ticketId));
        const out = async (dir, repo, label, hit) => {
            const dest = path.join(srcDir(s.ticketId), dir === 'back' ? s.ticketId : `${s.ticketId}-app-front`);
            try { await extract(s, repo, hit.sha, dest); } catch (e) { if (!stale()) fail(s, `${label}: git archive ${hit.sha.slice(0, 10)} falhou (${e.message})`); return false; }
            if (stale()) return false;
            s.worktrees[dir] = dest;
            s.refs[dir] = hit;
            note(s, `${label}: ${hit.ref} @ ${hit.sha.slice(0, 10)} extraído em ${dest} — repo local intocado`);
            return true;
        };
        // O commit do back foi validado no start(); o fetch só traz o que mudou no remoto.
        await fetchTicket(repoRoot, 'app-back');
        if (stale() || !(await out('back', repoRoot, 'app-back', s.commit))) return false;
        const front = libRepos.front;
        if (front && fs.existsSync(path.join(front, '.git'))) {
            await fetchTicket(front, 'app-front');
            if (stale()) return false;
            const hit = ticketBranch(front, s.ticketId);
            if (!hit) { s.steps.front = 'skipped'; note(s, `app-front: sem branch ${s.ticketId} — front fica de fora`); }
            else if (!(await out('front', front, 'app-front', hit))) return false;
            else s.steps.front = 'pending';
        }
        if (!fs.existsSync(path.join(s.worktrees.back, configFile(s.profile)))) { fail(s, `application-${s.profile}.properties não existe no commit ${s.commit.sha.slice(0, 10)}`); return false; }
        return true;
    }

    async function pipeline(s, token) {
        const alive = () => token === s.runToken && ACTIVE_PHASES.includes(s.phase) && s.phase !== 'stopping';
        if (s.source === 'commit' && (!(await exportSources(s, token)) || !alive())) return;
        if (checkPorts) {
            const busy = [];
            if (await portInUse(ports.back)) busy.push(`back :${ports.back}`);
            if (s.worktrees.front && await portInUse(ports.front)) busy.push(`front :${ports.front}`);
            if (!alive()) return;
            if (busy.length) return fail(s, `porta em uso (${busy.join(', ')}) — libere-a ou ajuste PREVIEW_BACK_PORT/PREVIEW_FRONT_PORT`);
        }
        for (const step of BUILD_STEPS) {
            if (!s.worktrees[step.dir]) {
                // Síncrono quando não há repo: o back começa a buildar ainda dentro do start().
                if (!willBuild(step, s.worktrees)) { note(s, `${step.key}: sem worktree próprio — usando a versão do ~/.m2`); continue; }
                const r = await buildLibFromBranch(s, token, step).catch(e => { fail(s, `${step.key}: ${e.message}`); return false; });
                if (r === false || !alive()) return;
                continue;
            }
            if (!(await build(s, token, step)) || !alive()) return;
        }
        if (!(await startBack(s, token)) || !alive()) return;
        if (s.worktrees.front) {
            const missing = linkFrontDeps(s, s.worktrees.front);
            // Modo commit: a pasta é temporária, não dá pra instalar nela — o back sobe sozinho.
            if (s.source === 'commit' && missing.length) {
                s.worktrees.front = null;
                s.steps.front = 'skipped';
                note(s, `app-front: ${missing.join(' e ')} do commit difere do checkout principal — front fica de fora`, 'WARN');
            } else if (!(await startFront(s, token)) || !alive()) return;
        }
        s.runningAt = Date.now();
        note(s, `preview no ar — back http://localhost:${ports.back}${s.worktrees.front ? ` · front http://localhost:${ports.front}` : ''}`);
        setPhase(s, 'running');
    }

    // --------------------------------------------------------------- API
    // host/banco do jdbc.url (sem usuário/senha) pro painel e pro log.
    function dbLabel(props) {
        const m = String(props['quarkus.datasource.jdbc.url'] || '').match(/\/\/([^/?;]+)\/?([^?;]*)/);
        return m ? `${m[1]}/${m[2]}` : null;
    }
    function dbChoices(backWt) {
        return dbOptions.map(o => {
            const file = backWt && path.join(backWt, configFile(o.profile));
            const exists = !!file && fs.existsSync(file);
            const props = exists ? readProperties(file) : {};
            return { key: o.key, profile: o.profile, exists, db: dbLabel(props), sistema: props.sistema || null, ambiente: props.ambiente || null };
        });
    }
    // backDir: worktree do back; no modo commit, o checkout principal (os .properties do
    // commit só existem depois do export, que confere o profile de novo).
    function resolveDb(backDir, db) {
        const choices = dbChoices(backDir);
        const pick = db == null || db === '' ? (choices.find(c => c.profile === defaultProfile) || choices[0] || { key: null, profile: defaultProfile, exists: true })
            : choices.find(c => c.key === db);
        if (!pick) throw httpError(400, `banco inválido: ${db} (opções: ${choices.map(c => c.key).join(', ') || 'nenhuma — defina PREVIEW_DB_OPTIONS'})`);
        if (!pick.exists && fs.existsSync(path.join(backDir, 'src', 'main', 'resources'))) throw httpError(400, `application-${pick.profile}.properties não existe no app-back`);
        return pick;
    }

    function validLibRef(ref) {
        if (ref == null || ref === '') return null;
        // Só refs remotas: HEAD/branch local/sha buildariam um checkout possivelmente sujo do repo irmão.
        if (typeof ref !== 'string' || !ref.startsWith('origin/') || !LIB_REF_RE.test(ref) || ref.includes('..') || ref.endsWith('.lock')) throw httpError(400, `ref inválida (use origin/<branch>): ${String(ref).slice(0, 80)}`);
        return ref;
    }

    // Commit do modo commit: tem de estar na branch do ticket do app-back (o painel lista
    // de lá). Sem `commit`, a ponta da branch.
    function resolveCommit(ticketId, commit) {
        const given = commit != null && commit !== '';
        // Formato antes de qualquer git: o valor vai como argumento (sem shell) e não pode virar opção.
        if (given && (typeof commit !== 'string' || !SHA_RE.test(commit))) throw httpError(400, `commit inválido (use o SHA em hexadecimal): ${String(commit).slice(0, 80)}`);
        const branch = ticketBranch(repoRoot, ticketId);
        if (!branch) throw httpError(404, `branch ${ticketId} do app-back não encontrada (nem origin/${ticketId})`);
        if (!given) return branch;
        let sha;
        try { sha = gitSync(repoRoot, ['rev-parse', '--verify', '--quiet', `${commit}^{commit}`]); } catch { throw httpError(400, `commit ${commit} não existe no app-back`); }
        try { gitSync(repoRoot, ['merge-base', '--is-ancestor', sha, branch.sha]); } catch { throw httpError(400, `commit ${commit.slice(0, 10)} não está na branch ${branch.ref}`); }
        return { ref: branch.ref, sha };
    }

    // Últimos commits da branch do ticket no app-back (o mais novo primeiro) pro painel.
    async function listCommits(ticketId) {
        validId(ticketId);
        requireAdapter();
        // Back e front: o painel mostra a ponta do front que vai subir junto.
        await Promise.all([repoRoot, libRepos.front].filter(r => r && fs.existsSync(path.join(r, '.git'))).map(r =>
            git(r, ['fetch', '--quiet', 'origin', `+refs/heads/${ticketId}:refs/remotes/origin/${ticketId}`], 30000).catch(() => {})));
        const branch = ticketBranch(repoRoot, ticketId);
        if (!branch) throw httpError(404, `branch ${ticketId} do app-back não encontrada (nem origin/${ticketId})`);
        const raw = await git(repoRoot, ['log', `--max-count=${COMMITS_MAX}`, '--format=%H%x1f%cI%x1f%s', branch.sha]);
        const commits = raw.split('\n').filter(Boolean).map(l => { const [sha, date, subject] = l.split('\x1f'); return { sha, date, subject }; });
        return { ref: branch.ref, sha: branch.sha, commits, front: ticketBranch(libRepos.front, ticketId) };
    }

    function start(ticketId, opts = {}) {
        validId(ticketId);
        const libRef = validLibRef(opts.libRef);
        requireAdapter();
        if (!defaultProfile) throw httpError(400, 'profile do preview não configurado');
        const other = activePreview();
        if (other && other.ticketId !== ticketId) throw httpError(409, `Preview do ticket ${other.ticketId} ainda está rodando — pare-o antes de iniciar um novo`);
        if (other) throw httpError(409, `Preview do ticket ${ticketId} já está em andamento (fase ${other.phase})`);
        const source = opts.source == null || opts.source === '' ? 'worktree' : opts.source;
        if (!SOURCES.includes(source)) throw httpError(400, `fonte inválida: ${String(source).slice(0, 40)} (opções: ${SOURCES.join(', ')})`);
        const byCommit = source === 'commit';
        // Modo commit: nada de worktree; mo-entity/app-core caem no buildLibFromBranch.
        const worktrees = byCommit ? { back: null, moEntity: null, appCore: null, front: null } : detectWorktrees(ticketId);
        if (!byCommit && !worktrees.back) throw httpError(404, `worktree do app-back não encontrado para ticket ${ticketId}`);
        const commit = byCommit ? resolveCommit(ticketId, opts.commit) : null;
        const frontBranch = byCommit ? ticketBranch(libRepos.front, ticketId) : null;
        const pick = resolveDb(byCommit ? repoRoot : worktrees.back, opts.db);
        if (!javaResolved) {
            javaHome = resolveJavaHome(repoRoot, { ...env, PRE_BUILD_JAVA_HOME: '' }).javaHome || '';
            javaResolved = true;
        }

        const s = get(ticketId);
        clearTimers(s);
        Object.assign(s, {
            worktrees, db: pick.key, profile: pick.profile, logBuffer: [], error: null, errorPhase: null, startedAt: Date.now(), runningAt: null,
            libFallbacks: [], libRef, source, commit, refs: {},
            steps: Object.fromEntries([
                ...BUILD_STEPS.map(b => [b.key, (byCommit && b.dir === 'back') || willBuild(b, worktrees) ? 'pending' : 'skipped']),
                ['back', 'pending'], ['front', (byCommit ? frontBranch : worktrees.front) ? 'pending' : 'skipped'],
            ]),
        });
        const token = ++s.runToken;
        redact.reset();
        const first = byCommit ? 'exporting' : BUILD_STEPS.find(b => willBuild(b, worktrees)).phase;
        note(s, byCommit
            ? `preview iniciado — commit: back ${commit.ref} @ ${commit.sha.slice(0, 10)} | front ${frontBranch ? `${frontBranch.ref} (ponta)` : '–'}`
            : `preview iniciado — worktrees: ${Object.entries(worktrees).map(([k, v]) => `${k} ${v ? '✓' : '–'}`).join(' | ')}`);
        if (libRef) note(s, `libs sem worktree: reconstruindo a partir de ${libRef} (cache do repositório do preview ignorado)`);
        setPhase(s, first);
        pipeline(s, token).catch(e => fail(s, e.message));
        return status(ticketId);
    }

    async function stop(ticketId) {
        validId(ticketId);
        const s = previews.get(ticketId);
        if (!s || s.phase === 'idle') return status(ticketId);
        s.runToken++; // invalida o pipeline em andamento
        clearTimers(s);
        const was = s.phase;
        setPhase(s, 'stopping');
        await killAll(s);
        if (s.source === 'commit') { try { rmDir(srcDir(ticketId)); } catch (e) { note(s, `não apagou ${srcDir(ticketId)} (${e.message})`, 'WARN'); } }
        s.startedAt = null;
        s.runningAt = null;
        s.error = null;
        s.errorPhase = null;
        s.steps = {};
        note(s, `preview parado${was === 'error' ? ' (após erro)' : ''}`);
        setPhase(s, 'idle');
        return status(ticketId);
    }

    function status(ticketId) {
        validId(ticketId);
        const s = previews.get(ticketId) || blank(ticketId);
        const active = activePreview();
        return {
            ticketId,
            configured,
            phase: s.phase,
            ports: { ...s.ports },
            startedAt: s.startedAt ? new Date(s.startedAt).toISOString() : null,
            runningAt: s.runningAt ? new Date(s.runningAt).toISOString() : null,
            error: s.error,
            errorPhase: s.errorPhase,
            steps: { ...s.steps },
            pids: { back: s.processes.back?.pid ?? null, front: s.processes.front?.pid ?? null, build: s.current?.pid ?? null },
            // Detecção sempre fresca: o painel mostra o que existe agora, mesmo idle.
            worktrees: Object.fromEntries(Object.entries(detectWorktrees(ticketId)).map(([k, v]) => [k, !!v])),
            branches: Object.fromEntries(Object.entries(detectBranches(ticketId)).map(([k, v]) => [k, v?.ref ?? null])),
            source: s.source,
            // Commits que estão no ar (ou subindo) no modo commit.
            refs: Object.fromEntries(Object.entries(s.refs || {}).map(([k, v]) => [k, { ref: v.ref, sha: v.sha }])),
            commit: s.commit ? { ref: s.commit.ref, sha: s.commit.sha } : null,
            activeTicket: active ? active.ticketId : null,
            db: s.db ?? null,
            profile: s.profile ?? null,
            // Libs que caíram no ~/.m2 neste start; com erro no build do back, o snapshot de lá
            // pode estar fora de sincronia com o código do ticket (assinatura que mudou, etc.).
            libFallback: s.libFallbacks.map(f => ({ ...f })),
            libRef: s.libRef ?? null,
            dbOptions: dbChoices(detectWorktrees(ticketId).back || repoRoot),
        };
    }

    // Cache do build do ticket: target/ dos worktrees (+ .tmp do grunt no front), o código
    // extraído no modo commit e, pra mo-entity/app-core com worktree próprio, o que o
    // `mvn install` do preview gravou no repositório Maven do preview (nunca no ~/.m2).
    // Pasta da lib (groupId/artifactId do pom do repo irmão) numa versão, no repositório do preview.
    function libDir(repo, version) {
        let c = null;
        try { c = pomCoords(fs.readFileSync(path.join(repo, 'pom.xml'), 'utf8')); } catch {}
        return c && !String(version).includes('..') ? path.join(previewM2, ...c.g.split('.'), c.a, version) : null;
    }

    function artifactDir(pomDir) {
        let pom = '';
        try { pom = fs.readFileSync(path.join(pomDir, 'pom.xml'), 'utf8'); } catch { return null; }
        const c = pomCoords(pom);
        return c && path.join(previewM2, ...c.g.split('.'), c.a, c.v);
    }

    function clean(ticketId) {
        validId(ticketId);
        requireAdapter();
        const s = get(ticketId);
        if (ACTIVE_PHASES.includes(s.phase)) throw httpError(409, `Preview do ticket ${ticketId} está em andamento (fase ${s.phase}) — pare-o antes de limpar o cache`);
        const wt = detectWorktrees(ticketId);
        const targets = [];
        for (const dir of [wt.back, wt.moEntity, wt.appCore]) if (dir) targets.push(path.join(dir, 'target'));
        if (wt.front) targets.push(path.join(wt.front, '.tmp'));
        targets.push(srcDir(ticketId));
        for (const dir of [wt.moEntity, wt.appCore]) { const a = dir && artifactDir(dir); if (a) targets.push(a); }
        const removed = [];
        for (const t of targets) {
            if (!fs.existsSync(t)) continue;
            fs.rmSync(t, { recursive: true, force: true });
            removed.push(t);
            const rel = path.relative(worktreesDir, t);
            note(s, `cache removido: ${t.startsWith(previewM2) ? `repositório do preview/${path.relative(previewM2, t)}` : rel.startsWith('..') ? t : rel}`);
        }
        if (!removed.length) note(s, 'cache: nada a remover');
        return { ...status(ticketId), removed };
    }

    // Refs remotas de mo-entity/app-core cuja versão (pom.xml) bate com a do app-back do
    // ticket: o que o painel oferece em "Reconstruir libs". Mais recentes primeiro.
    async function listLibRefs(ticketId) {
        validId(ticketId);
        requireAdapter();
        // Modo commit: o código extraído (fica até o stop) é o que falhou no build.
        const s = previews.get(ticketId);
        const wt = s?.source === 'commit' && s.worktrees?.back ? s.worktrees : detectWorktrees(ticketId);
        if (!wt.back) throw httpError(404, `worktree do app-back não encontrado para ticket ${ticketId}`);
        let need = null;
        try { need = pomCoords(fs.readFileSync(path.join(wt.back, 'pom.xml'), 'utf8'))?.v; } catch {}
        const out = { need, libs: [] };
        if (!need) return out;
        for (const step of BUILD_STEPS.filter(b => b.dir !== 'back')) {
            const repo = libRepos[step.dir];
            if (wt[step.dir] || !libsFromBranch || !repo || !fs.existsSync(path.join(repo, '.git'))) continue;
            try { await git(repo, ['fetch', '--quiet', 'origin']); } catch {}
            let names = [];
            try {
                names = (await git(repo, ['for-each-ref', '--sort=-committerdate', `--count=${LIB_REF_SCAN_MAX}`, '--format=%(refname:short)', 'refs/remotes/origin']))
                    .split('\n').map(x => x.trim()).filter(x => x && x !== 'origin' && !x.endsWith('/HEAD') && LIB_REF_RE.test(x) && !x.includes('..'));
            } catch {}
            const refs = [];
            for (let i = 0; i < names.length; i += 16) {
                const batch = names.slice(i, i + 16);
                const vs = await Promise.all(batch.map(r => git(repo, ['show', `${r}:pom.xml`], 15000).then(x => pomCoords(x)?.v).catch(() => null)));
                batch.forEach((r, j) => { if (vs[j] === need) refs.push(r); });
            }
            out.libs.push({ key: step.key, refs });
        }
        return out;
    }

    function getLogBuffer(ticketId) {
        validId(ticketId);
        return (previews.get(ticketId)?.logBuffer || []).slice();
    }

    function on(type, fn) { events.on(type, fn); return () => events.off(type, fn); }

    async function stopAll() {
        await Promise.all([...previews.values()].filter(s => s.phase !== 'idle').map(s => stop(s.ticketId)));
    }
    // process 'exit' é síncrono: só dá pra mandar o SIGTERM pros grupos.
    function killSync() {
        for (const s of previews.values()) {
            clearTimers(s);
            for (const p of [s.current, s.processes.back, s.processes.front]) {
                if (!exited(p)) { try { process.kill(-p.pid, 'SIGTERM'); } catch { try { p.kill('SIGTERM'); } catch {} } }
            }
        }
    }

    return { start, stop, clean, status, listLibRefs, listCommits, getLogBuffer, on, stopAll, killSync, ports, worktreesDir, previewM2 };
}

let singleton = null;
function instance() {
    if (!singleton) {
        singleton = createPreviewManager();
        process.once('exit', () => singleton.killSync());
    }
    return singleton;
}

module.exports = {
    start: (id, opts) => instance().start(id, opts),
    stop: id => instance().stop(id),
    clean: id => instance().clean(id),
    status: id => instance().status(id),
    getLogBuffer: id => instance().getLogBuffer(id),
    createPreviewManager,
    readProperties,
    LOG_LINES,
    TICKET_ID_RE,
};
