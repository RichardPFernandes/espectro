// Preview de ambiente de um worktree a partir do dashboard (dashboard/server.js >
// /api/preview/:ticketId/*): builda mo-entity → app-core → app-back (só os que têm
// worktree próprio; os outros vêm do ~/.m2) e sobe app-back (Quarkus, :8081) e
// app-front (grunt serve, :9000) como filhos controlados. Mesmo padrão do
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
// Secrets: toda linha passa pelo mesmo redator do watcher-manager (env + .env do repo)
// acrescido das senhas do application-<profile>.properties do worktree.
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn, execFile } = require('child_process');
const { EventEmitter } = require('events');
const { createRedactor, levelOf } = require('./watcher-manager');
const { resolveJavaHome } = require('./lib/build-validator');

const LOG_LINES = 300;
const STOP_GRACE_MS = 8000;
const BACK_STARTUP_TIMEOUT_MS = 120000;
const FRONT_READY_FALLBACK_MS = 15000;
const TICKET_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
// Ref escolhida no painel (origin/<branch>): vai como argumento do git (sem shell), mas não
// pode começar com '-' (virar opção) nem ter '..'. Branch com '@{' ou espaço não passa.
const LIB_REF_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;
const LIB_REF_SCAN_MAX = 200;
const ACTIVE_PHASES = ['building-mo-entity', 'building-app-core', 'building-app-back', 'starting-back', 'starting-front', 'running', 'stopping'];
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

function createPreviewManager(options = {}) {
    const env = options.env || process.env;
    const repoRoot = path.resolve(options.repoRoot || env.REPO_PATH || process.cwd());
    const adapter = options.adapter || env.PREVIEW_ADAPTER || null;
    const configured = adapter === 'maven-quarkus-grunt';
    const requireAdapter = () => { if (!configured) throw httpError(400, 'preview não configurado para este projeto'); };
    const worktreesDir = options.worktreesDir || path.join(repoRoot, '.claude', 'worktrees');
    const envFile = options.envFile === undefined ? path.join(repoRoot, '.env') : options.envFile;
    const ports = {
        back: options.ports?.back ?? (Number(env.PREVIEW_BACK_PORT) || 8080),
        front: options.ports?.front ?? (Number(env.PREVIEW_FRONT_PORT) || 9000),
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
    const m2Repo = options.m2Repo || path.join(os.homedir(), '.m2', 'repository');
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
    const gruntWrapper = options.gruntWrapper || path.join(__dirname, 'preview-gruntfile.js');
    // 8080 é permitido (é a porta que o front espera); o portInUse do start recusa se o
    // app-back principal estiver de pé nela.
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
        build: (wt, step) => ({ cmd: 'mvn', args: [...(mvnOffline ? ['-o'] : []), 'clean', step.goal, '-DskipTests', '-q'] }),
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

    function blank(ticketId) {
        return {
            ticketId, phase: 'idle', processes: { back: null, front: null }, current: null,
            ports: { ...ports }, logBuffer: [], startedAt: null, runningAt: null, error: null,
            errorPhase: null, steps: {}, worktrees: null, timers: new Set(), runToken: 0,
            libFallbacks: [], libRef: null,
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
        note(s, `${source}: ${path.basename(cmd)} ${args.join(' ')} (cwd ${path.relative(worktreesDir, cwd) || '.'}, PID ${proc.pid ?? '?'})`);
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
        if (!main || path.resolve(main) === path.resolve(wt)) return;
        const same = f => { try { return fs.readFileSync(path.join(main, f), 'utf8') === fs.readFileSync(path.join(wt, f), 'utf8'); } catch { return false; } };
        for (const [dir, manifest] of [['node_modules', 'package.json'], ['bower_components', 'bower.json']]) {
            if (fs.existsSync(path.join(wt, dir)) || !fs.existsSync(path.join(main, dir))) continue;
            if (!same(manifest)) { note(s, `app-front: sem ${dir} no worktree e ${manifest} difere do checkout principal — rode o install no worktree`, 'WARN'); continue; }
            try { fs.symlinkSync(path.join(main, dir), path.join(wt, dir), 'dir'); note(s, `app-front: ${dir} linkado do checkout principal (${manifest} idêntico)`); } catch (e) { note(s, `app-front: não linkou ${dir} (${e.message})`, 'WARN'); }
        }
    }

    function startFront(s, token) {
        return new Promise(resolve => {
            s.steps.front = 'running';
            setPhase(s, 'starting-front');
            const wt = s.worktrees.front;
            linkFrontDeps(s, wt);
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
            note(s, `${step.key}: ${why} — usando a versão do ~/.m2`, 'WARN');
            return null;
        };
        if (!libsFromBranch) return fallback('PREVIEW_LIBS_FROM_BRANCH=false', false);
        if (!repo || !fs.existsSync(path.join(repo, '.git'))) return fallback('sem worktree próprio nem repo irmão', false);
        let need = null;
        try { need = pomCoords(fs.readFileSync(path.join(s.worktrees.back, 'pom.xml'), 'utf8'))?.v; } catch {}
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
        const dir = path.join(m2Repo, ...coords.g.split('.'), coords.a, coords.v);
        const jar = path.join(dir, `${coords.a}-${coords.v}.jar`);
        const marker = path.join(dir, '.preview-build.json');
        const jarMtime = () => { try { return fs.statSync(jar).mtimeMs; } catch { return null; } };
        try {
            const m = JSON.parse(fs.readFileSync(marker, 'utf8'));
            // mtime diferente = outro install sobrescreveu depois do nosso.
            if (!libRef && m.sha === sha && m.jarMtimeMs === jarMtime()) {
                s.steps[step.key] = 'done';
                note(s, `${step.key}: ~/.m2 já tem ${coords.v} de ${ref} (${sha.slice(0, 10)}) — build pulado`);
                return true;
            }
        } catch {}
        const wt = path.join(libTmpDir, `preview-${step.key}-${s.ticketId}`);
        await git(repo, ['worktree', 'remove', '--force', wt]).catch(() => {});
        fs.rmSync(wt, { recursive: true, force: true });
        try { await git(repo, ['worktree', 'add', '--detach', '--quiet', wt, sha]); } catch (e) { fail(s, `${step.key}: git worktree add ${ref} falhou (${e.message})`); return false; }
        note(s, `${step.key}: sem worktree próprio — buildando ${ref} (${sha.slice(0, 10)}, versão ${coords.v})`);
        try {
            if (token !== s.runToken) return false;
            const ok = await build(s, token, { ...step, label: `${step.key}@${ref}` }, wt);
            if (ok) { try { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(marker, JSON.stringify({ sha, ref, jarMtimeMs: jarMtime(), at: new Date().toISOString() })); } catch {} }
            return ok;
        } finally {
            await git(repo, ['worktree', 'remove', '--force', wt]).catch(() => fs.rmSync(wt, { recursive: true, force: true }));
        }
    }

    async function pipeline(s, token) {
        const alive = () => token === s.runToken && ACTIVE_PHASES.includes(s.phase) && s.phase !== 'stopping';
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
        if (s.worktrees.front && (!(await startFront(s, token)) || !alive())) return;
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
    function resolveDb(worktrees, db) {
        const choices = dbChoices(worktrees.back);
        const pick = db == null || db === '' ? (choices.find(c => c.profile === defaultProfile) || choices[0] || { key: null, profile: defaultProfile, exists: true })
            : choices.find(c => c.key === db);
        if (!pick) throw httpError(400, `banco inválido: ${db} (opções: ${choices.map(c => c.key).join(', ') || 'nenhuma — defina PREVIEW_DB_OPTIONS'})`);
        if (!pick.exists && fs.existsSync(path.join(worktrees.back, 'src', 'main', 'resources'))) throw httpError(400, `application-${pick.profile}.properties não existe no worktree do app-back`);
        return pick;
    }

    function validLibRef(ref) {
        if (ref == null || ref === '') return null;
        // Só refs remotas: HEAD/branch local/sha buildariam um checkout possivelmente sujo do repo irmão.
        if (typeof ref !== 'string' || !ref.startsWith('origin/') || !LIB_REF_RE.test(ref) || ref.includes('..') || ref.endsWith('.lock')) throw httpError(400, `ref inválida (use origin/<branch>): ${String(ref).slice(0, 80)}`);
        return ref;
    }

    function start(ticketId, opts = {}) {
        validId(ticketId);
        const libRef = validLibRef(opts.libRef);
        requireAdapter();
        if (!defaultProfile) throw httpError(400, 'profile do preview não configurado');
        const other = activePreview();
        if (other && other.ticketId !== ticketId) throw httpError(409, `Preview do ticket ${other.ticketId} ainda está rodando — pare-o antes de iniciar um novo`);
        if (other) throw httpError(409, `Preview do ticket ${ticketId} já está em andamento (fase ${other.phase})`);
        const worktrees = detectWorktrees(ticketId);
        if (!worktrees.back) throw httpError(404, `worktree do app-back não encontrado para ticket ${ticketId}`);
        const pick = resolveDb(worktrees, opts.db);
        if (!javaResolved) {
            javaHome = resolveJavaHome(repoRoot, { ...env, PRE_BUILD_JAVA_HOME: '' }).javaHome || '';
            javaResolved = true;
        }

        const s = get(ticketId);
        clearTimers(s);
        Object.assign(s, {
            worktrees, db: pick.key, profile: pick.profile, logBuffer: [], error: null, errorPhase: null, startedAt: Date.now(), runningAt: null,
            libFallbacks: [], libRef,
            steps: Object.fromEntries([
                ...BUILD_STEPS.map(b => [b.key, willBuild(b, worktrees) ? 'pending' : 'skipped']),
                ['back', 'pending'], ['front', worktrees.front ? 'pending' : 'skipped'],
            ]),
        });
        const token = ++s.runToken;
        redact.reset();
        const first = BUILD_STEPS.find(b => willBuild(b, worktrees));
        if (libRef) note(s, `libs sem worktree: reconstruindo a partir de ${libRef} (cache do ~/.m2 ignorado)`);
        note(s, `preview iniciado — worktrees: ${Object.entries(worktrees).map(([k, v]) => `${k} ${v ? '✓' : '–'}`).join(' | ')}`);
        setPhase(s, first.phase);
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
            activeTicket: active ? active.ticketId : null,
            db: s.db ?? null,
            profile: s.profile ?? null,
            // Libs que caíram no ~/.m2 neste start; com erro no build do back, o snapshot de lá
            // pode estar fora de sincronia com o código do ticket (assinatura que mudou, etc.).
            libFallback: s.libFallbacks.map(f => ({ ...f })),
            libRef: s.libRef ?? null,
            dbOptions: dbChoices(detectWorktrees(ticketId).back),
        };
    }

    // Cache do build do ticket: target/ dos worktrees (+ .tmp do grunt no front) e, pra
    // mo-entity/app-core com worktree próprio, o que o `mvn install` do preview gravou
    // no ~/.m2 — que é compartilhado: sem apagar, o checkout principal segue usando o
    // SNAPSHOT do ticket. O próximo build baixa do repositório remoto ou pede install.
    function artifactDir(pomDir) {
        let pom = '';
        try { pom = fs.readFileSync(path.join(pomDir, 'pom.xml'), 'utf8'); } catch { return null; }
        const c = pomCoords(pom);
        return c && path.join(m2Repo, ...c.g.split('.'), c.a, c.v);
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
        for (const dir of [wt.moEntity, wt.appCore]) { const a = dir && artifactDir(dir); if (a) targets.push(a); }
        const removed = [];
        for (const t of targets) {
            if (!fs.existsSync(t)) continue;
            fs.rmSync(t, { recursive: true, force: true });
            removed.push(t);
            note(s, `cache removido: ${t.startsWith(m2Repo) ? `~/.m2/${path.relative(m2Repo, t)}` : path.relative(worktreesDir, t)}`);
        }
        if (!removed.length) note(s, 'cache: nada a remover');
        return { ...status(ticketId), removed };
    }

    // Refs remotas de mo-entity/app-core cuja versão (pom.xml) bate com a do app-back do
    // ticket: o que o painel oferece em "Reconstruir libs". Mais recentes primeiro.
    async function listLibRefs(ticketId) {
        validId(ticketId);
        requireAdapter();
        const wt = detectWorktrees(ticketId);
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
                if (!exited(p)) { try { process.kill(-p.pid, 'SIGTERM'); } catch {} }
            }
        }
    }

    return { start, stop, clean, status, listLibRefs, getLogBuffer, on, stopAll, killSync, ports, worktreesDir };
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
