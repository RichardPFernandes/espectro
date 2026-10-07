// Sandbox de processo real da harness PRI-69 (ver README.md desta pasta).
//
// Cada cenário ganha um diretório temporário próprio com:
//   app-back/   consumidor sintético: repo git real (branch development) com origin num
//               bare local (file://), memory/, .claude/spec-hash-config.json do alvo e
//               dashboard/dashboard-prefs.json (seletor de conta).
//   home/       HOME falso (~/.claude e, quando o cenário pede, ~/.claude-personal).
//   bin/        PATH inteiro do watcher e dos agentes: claude/codex/mvn/java falsos,
//               symlinks de node/jq e nada mais além de /usr/bin:/bin:/usr/sbin:/sbin.
//   servidor HTTP em 127.0.0.1:<porta efêmera> fazendo Redmine (/redmine), Bitbucket
//               (/bitbucket/2.0) e dashboard (/api/preview, via PORT) — tudo gravado.
// O watcher roda como processo separado (`node <alvo>/scripts/readmine-watcher.js`), com
// env montado do zero (nada do ambiente de quem chama) e net-guard.js no preload.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn, execFileSync, spawnSync } = require('child_process');

const HARNESS_DIR = __dirname;
const SYSTEM_PATH = '/usr/bin:/bin:/usr/sbin:/sbin';

function git(cwd, args, extraEnv = {}) {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...gitEnv(), ...extraEnv } });
}

function gitEnv() {
    return {
        PATH: SYSTEM_PATH, HOME: os.tmpdir(), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_AUTHOR_NAME: 'harness', GIT_AUTHOR_EMAIL: 'harness@example.invalid',
        GIT_COMMITTER_NAME: 'harness', GIT_COMMITTER_EMAIL: 'harness@example.invalid', GIT_TERMINAL_PROMPT: '0',
    };
}

function writeJson(file, data) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
}

function readJson(file) {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function readJsonl(file) {
    if (!fs.existsSync(file)) return [];
    return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
}

function pidAlive(pid) {
    try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

function resolveOnPath(name) {
    const found = (spawnSync('which', [name], { encoding: 'utf8' }).stdout || '').trim();
    if (found && fs.existsSync(found)) return found;
    for (const dir of ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin']) {
        const candidate = path.join(dir, name);
        if (fs.existsSync(candidate)) return candidate;
    }
    return null;
}

async function waitFor(what, fn, timeoutMs = 15000, everyMs = 50) {
    const until = Date.now() + timeoutMs;
    for (;;) {
        const v = await fn();
        if (v) return v;
        if (Date.now() > until) throw new Error(`timeout (${timeoutMs} ms) esperando: ${what}`);
        await new Promise(r => setTimeout(r, everyMs));
    }
}

// ── Servidor falso (Redmine + Bitbucket + dashboard) ────────────────────────────────

function startFakeServer(sb) {
    const requests = [];
    let prSeq = 0;
    const server = http.createServer((req, res) => {
        let body = '';
        req.on('data', c => { body += c; });
        req.on('end', () => {
            const url = new URL(req.url, 'http://127.0.0.1');
            const entry = { at: new Date().toISOString(), method: req.method, path: url.pathname, query: url.search, body: body ? safeJson(body) : null };
            requests.push(entry);
            fs.appendFileSync(sb.requestsFile, JSON.stringify(entry) + '\n');
            const send = (status, data) => {
                res.writeHead(status, { 'Content-Type': 'application/json' });
                res.end(data === undefined ? '' : JSON.stringify(data));
            };
            const p = url.pathname;
            if (p.startsWith('/redmine/')) return redmine(sb, req.method, p.slice('/redmine'.length), url, entry.body, send);
            if (p.startsWith('/bitbucket/2.0/')) {
                const rest = p.slice('/bitbucket/2.0'.length);
                if (req.method === 'GET' && /effective-default-reviewers/.test(rest)) return send(200, { values: [] });
                if (req.method === 'GET' && rest === '/user') return send(200, { account_id: 'harness-bot' });
                const pr = /^\/repositories\/([^/]+)\/([^/]+)\/pullrequests$/.exec(rest);
                if (req.method === 'POST' && pr) {
                    const id = ++prSeq;
                    return send(201, { id, title: entry.body?.title, draft: entry.body?.draft, links: { html: { href: `http://127.0.0.1:${sb.port}/bitbucket/${pr[1]}/${pr[2]}/pull-requests/${id}` } } });
                }
                const one = /^\/repositories\/[^/]+\/[^/]+\/pullrequests\/(\d+)$/.exec(rest);
                if (req.method === 'GET' && one) return send(200, { id: Number(one[1]), state: 'OPEN', draft: true });
                return send(404, { error: 'harness: rota Bitbucket não simulada' });
            }
            if (p.startsWith('/api/preview/')) return send(200, { running: false });
            return send(404, { error: 'harness: rota não simulada' });
        });
    });
    return new Promise(resolve => server.listen(0, '127.0.0.1', () => {
        sb.port = server.address().port;
        sb.server = server;
        sb.requests = requests;
        resolve();
    }));
}

function safeJson(s) { try { return JSON.parse(s); } catch { return s; } }

function redmine(sb, method, p, url, body, send) {
    const one = /^\/issues\/(\d+)\.json$/.exec(p);
    if (method === 'GET' && p === '/issues.json') {
        const wanted = (url.searchParams.get('status_id') || '').split('|').map(Number).filter(Boolean);
        const issues = Object.values(sb.tickets).filter(t => !wanted.length || wanted.includes(t.status.id)).map(t => ({ ...t }));
        return send(200, { issues, total_count: issues.length });
    }
    if (one) {
        const t = sb.tickets[Number(one[1])];
        if (!t) return send(404, { errors: ['not found'] });
        if (method === 'GET') return send(200, { issue: { ...t } });
        if (method === 'PUT') {
            const issue = body?.issue || {};
            const now = new Date().toISOString();
            if (issue.notes) t.journals.push({ id: t.journals.length + 1, notes: issue.notes, created_on: now, user: { id: 1, name: 'harness-watcher' }, details: [] });
            if (issue.status_id) t.status = { id: issue.status_id, name: STATUS_NAMES[issue.status_id] || `status ${issue.status_id}` };
            t.updated_on = now;
            return send(204);
        }
    }
    return send(404, { errors: ['harness: rota Redmine não simulada'] });
}

const STATUS_NAMES = { 11: 'Aprovada', 13: 'Recusa QA', 2: 'Em Desenvolvimento', 20: 'Ag Merge' };

// ── Sandbox ─────────────────────────────────────────────────────────────────────────

async function createSandbox(name, { targetRoot, artifactsRoot }) {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `pri69-${name}-`)));
    const sb = {
        name, root, targetRoot, scriptsDir: path.join(targetRoot, 'scripts'),
        repo: path.join(root, 'app-back'), home: path.join(root, 'home'), bin: path.join(root, 'bin'),
        artifacts: path.join(artifactsRoot, name),
        tickets: {}, watcherRuns: [], seq: 0,
    };
    fs.mkdirSync(sb.artifacts, { recursive: true });
    sb.requestsFile = path.join(sb.artifacts, 'fake-server-requests.jsonl');
    sb.callsFile = path.join(sb.artifacts, 'agent-calls.jsonl');
    sb.netLog = path.join(sb.artifacts, 'net-guard-blocked.jsonl');
    sb.pidsDir = path.join(root, 'pids');
    sb.scenarioFile = path.join(root, 'scenario.json');
    sb.bbEnvFile = path.join(root, 'bitbucket-env.json');
    for (const f of [sb.requestsFile, sb.callsFile, sb.netLog]) fs.writeFileSync(f, '');

    // HOME e contas
    fs.mkdirSync(path.join(sb.home, '.claude', 'projects'), { recursive: true });

    // bin: único PATH extra
    fs.mkdirSync(sb.bin);
    fs.symlinkSync(process.execPath, path.join(sb.bin, 'node'));
    const shebang = `#!${process.execPath}\n`;
    const agent = fs.readFileSync(path.join(HARNESS_DIR, 'fake-agent.js'), 'utf8').replace(/^'use strict';/m, '');
    fs.writeFileSync(path.join(sb.bin, 'claude'), `${shebang}'use strict';\n${agent}`, { mode: 0o755 });
    fs.writeFileSync(path.join(sb.bin, 'codex'), `#!/bin/sh\nprintf '%s\\n' '{"event":"codex_called"}' >> '${sb.callsFile}'\nexit 1\n`, { mode: 0o755 });
    const tool = fs.readFileSync(path.join(HARNESS_DIR, 'fake-tool.js'), 'utf8').replace(/^'use strict';/m, '');
    for (const t of ['mvn', 'java']) fs.writeFileSync(path.join(sb.bin, t), `${shebang}'use strict';\n${tool}`, { mode: 0o755 });
    fs.writeFileSync(path.join(sb.bin, 'osascript'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    const jq = resolveOnPath('jq');
    if (!jq) throw new Error('jq não encontrado no PATH — bitbucket-open-pr.sh precisa dele');
    fs.symlinkSync(jq, path.join(sb.bin, 'jq'));

    // Consumidor: repo git real + origin bare local
    fs.mkdirSync(sb.repo);
    git(sb.repo, ['init', '-q', '-b', 'development']);
    fs.writeFileSync(path.join(sb.repo, 'README.md'), '# consumidor sintético da harness PRI-69\n');
    fs.writeFileSync(path.join(sb.repo, '.gitignore'), 'memory/\n.claude/worktrees/\ndashboard/\n.graph/ac-registry.json\n');
    const hashCfg = path.join(targetRoot, '.claude', 'spec-hash-config.json');
    if (fs.existsSync(hashCfg)) {
        fs.mkdirSync(path.join(sb.repo, '.claude'), { recursive: true });
        fs.copyFileSync(hashCfg, path.join(sb.repo, '.claude', 'spec-hash-config.json'));
    }
    git(sb.repo, ['add', '-A']);
    git(sb.repo, ['commit', '-q', '-m', 'base']);
    const origin = path.join(root, 'origin.git');
    git(root, ['init', '-q', '--bare', origin]);
    git(sb.repo, ['remote', 'add', 'origin', `file://${origin}`]);
    git(sb.repo, ['push', '-q', 'origin', 'development']);
    git(sb.repo, ['fetch', '-q', 'origin']);
    fs.mkdirSync(path.join(sb.repo, 'memory', 'runs'), { recursive: true });
    fs.mkdirSync(path.join(sb.repo, 'memory', 'spec'), { recursive: true });

    await startFakeServer(sb);
    writeJson(sb.bbEnvFile, {
        BITBUCKET_WORKSPACE: 'harness-ws', BITBUCKET_API_TOKEN: 'harness-bb-token-0000000000000000',
        BITBUCKET_API_BASE: `http://127.0.0.1:${sb.port}/bitbucket/2.0`, BITBUCKET_ACCOUNT_ID: 'harness-bot',
    });
    setScenario(sb, {});
    return Object.assign(sb, api(sb));
}

function setScenario(sb, scenario) {
    writeJson(sb.scenarioFile, scenario);
}

function api(sb) {
    return {
        setScenario: scenario => setScenario(sb, scenario),

        addTicket(id, over = {}) {
            sb.tickets[id] = {
                id, subject: `Ticket harness ${id}`, description: over.description || '',
                status: { id: 2, name: 'Em Desenvolvimento' }, tracker: { id: 2, name: 'Melhoria' },
                project: { id: 1, name: 'Harness' }, assigned_to: { id: 1, name: 'harness' },
                custom_fields: [{ id: 99, name: 'Branch Liberação', value: 'Dev - Local' }],
                updated_on: '2026-10-01T10:00:00.000Z', journals: [], ...over,
            };
            return sb.tickets[id];
        },

        // Worktree git real do ticket, com memory/ ligada como o watcher faz
        // (linkLocalMemory): spec/ compartilhada, runs/ própria.
        addWorktree(id) {
            const wt = path.join(sb.repo, '.claude', 'worktrees', String(id));
            git(sb.repo, ['worktree', 'add', '-q', wt, '-b', String(id), 'origin/development']);
            fs.mkdirSync(path.join(wt, 'memory', 'runs'), { recursive: true });
            for (const n of fs.readdirSync(path.join(sb.repo, 'memory'))) {
                if (n !== 'runs') fs.symlinkSync(path.join(sb.repo, 'memory', n), path.join(wt, 'memory', n));
            }
            return wt;
        },

        // Task semeada pelo state-writer do alvo (init: execution_id + state_version).
        seedTask(id, slug, state, files = {}) {
            const wt = fs.existsSync(path.join(sb.repo, '.claude', 'worktrees', String(id)))
                ? path.join(sb.repo, '.claude', 'worktrees', String(id)) : sb.addWorktree(id);
            const taskId = `${id}-${slug}`;
            const dir = path.join(wt, 'memory', 'runs', taskId);
            fs.mkdirSync(dir, { recursive: true });
            for (const [f, content] of Object.entries(files)) fs.writeFileSync(path.join(dir, f), content);
            const sw = require(path.join(sb.scriptsDir, 'state-writer.js'));
            sw.init(dir, {
                task_id: taskId, history: [], started_at: new Date().toISOString(), updated_at: new Date().toISOString(),
                redmine_ticket: { id, subject: sb.tickets[id]?.subject, base_branch: 'development' }, ...state,
            });
            return { taskId, dir, wt, stateFile: path.join(dir, 'state.json') };
        },

        state(dir) { return readJson(path.join(dir, 'state.json')); },

        snapshot(label, file) {
            const out = path.join(sb.artifacts, `${String(++sb.seq).padStart(2, '0')}-${label}`);
            if (fs.existsSync(file)) fs.copyFileSync(file, out);
            else fs.writeFileSync(out, `(ausente: ${path.relative(sb.root, file)})\n`);
            return out;
        },

        note(label, data) {
            writeJson(path.join(sb.artifacts, `${String(++sb.seq).padStart(2, '0')}-${label}.json`), data);
        },

        env(extra = {}) {
            return {
                ...gitEnv(),
                HOME: sb.home, PATH: `${sb.bin}:${SYSTEM_PATH}`, TMPDIR: path.join(sb.root, 'tmp') + '/', LANG: 'en_US.UTF-8',
                USER: 'harness', SHELL: '/bin/sh',
                REPO_PATH: sb.repo, REDMINE_URL: `http://127.0.0.1:${sb.port}/redmine`, REDMINE_API_KEY: 'harness-redmine-key-000000000000',
                PORT: String(sb.port), DASHBOARD_PREFS_FILE: path.join(sb.repo, 'dashboard', 'dashboard-prefs.json'),
                SKIP_PRE_BUILD_VALIDATION: 'true', PLAN_SCORE_THRESHOLD: '0', SPEC_AUTO_REPAIR: '0', SPEC_DRAFT_AUTOGEN: '0',
                DISABLE_AUTO_CLEANUP: 'true', REDMINE_MIN_INTERVAL_MS: '0', REDMINE_RETRY_MAX_ATTEMPTS: '1',
                GRACEFUL_TIMEOUT_MS: '8000',
                NODE_OPTIONS: `--require ${path.join(HARNESS_DIR, 'net-guard.js')}`,
                HARNESS_NET_LOG: sb.netLog, HARNESS_CALLS: sb.callsFile, HARNESS_SCENARIO: sb.scenarioFile,
                HARNESS_RELEASE: path.join(sb.root, 'agent-release'),
                HARNESS_SCRIPTS: sb.scriptsDir, HARNESS_PIDS: sb.pidsDir, HARNESS_BB_ENV: sb.bbEnvFile,
                ...extra,
            };
        },

        // Processo watcher real. Devolve { child, done } — done resolve com
        // { code, signal, stdout, stderr, logFile, ms }.
        startWatcher(label, args = [], { env = {} } = {}) {
            fs.mkdirSync(path.join(sb.root, 'tmp'), { recursive: true });
            const fullEnv = Object.fromEntries(Object.entries(sb.env(env)).filter(([, v]) => v !== undefined));
            const t0 = Date.now();
            const child = spawn(process.execPath, [path.join(sb.scriptsDir, 'readmine-watcher.js'), ...args], {
                cwd: sb.repo, env: fullEnv, stdio: ['ignore', 'pipe', 'pipe'],
            });
            let stdout = '', stderr = '';
            child.stdout.on('data', d => { stdout += d; });
            child.stderr.on('data', d => { stderr += d; });
            const logFile = path.join(sb.artifacts, `watcher-${String(++sb.seq).padStart(2, '0')}-${label}.log`);
            const done = new Promise(resolve => child.on('exit', (code, signal) => {
                const ms = Date.now() - t0;
                fs.writeFileSync(logFile, `# ${label}: node readmine-watcher.js ${args.join(' ')}\n# pid=${child.pid} exit=${code} signal=${signal} ms=${ms}\n## stdout\n${stdout}\n## stderr\n${stderr}`);
                resolve({ code, signal, stdout, stderr, logFile, ms, pid: child.pid });
            }));
            sb.watcherRuns.push(child);
            return { child, done };
        },

        async tick(label, args = [], opts = {}) {
            const { done } = sb.startWatcher(label, args, opts);
            const ms = opts.timeoutMs || 60000;
            let timer;
            const timeout = new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`watcher "${label}" não saiu em ${ms} ms`)), ms); });
            try { return await Promise.race([done, timeout]); } finally { clearTimeout(timer); }
        },

        // CLI do alvo (scripts/<script>) com o env da sandbox — é por aqui que o "humano"
        // e as ações manuais do runbook mexem no run (state-writer set, invalidate apply).
        cli(label, script, args = [], { input } = {}) {
            const env = Object.fromEntries(Object.entries(sb.env()).filter(([, v]) => v !== undefined));
            const r = spawnSync(process.execPath, [path.join(sb.scriptsDir, script), ...args], { cwd: sb.repo, env, encoding: 'utf8', input });
            fs.writeFileSync(path.join(sb.artifacts, `cli-${String(++sb.seq).padStart(2, '0')}-${label}.log`),
                `# node ${script} ${args.join(' ')}\n# exit=${r.status}\n## stdout\n${r.stdout}\n## stderr\n${r.stderr}`);
            return { code: r.status, stdout: r.stdout, stderr: r.stderr };
        },

        specHash(text) {
            const env = Object.fromEntries(Object.entries(sb.env()).filter(([, v]) => v !== undefined));
            const code = `process.stdout.write(require(${JSON.stringify(path.join(sb.scriptsDir, 'lib', 'spec-authority.js'))}).specHash(require('fs').readFileSync(0, 'utf8')))`;
            const r = spawnSync(process.execPath, ['-e', code], { cwd: sb.repo, env, encoding: 'utf8', input: text });
            if (r.status !== 0 || !/^[0-9a-f]{64}$/.test(r.stdout)) throw new Error(`specHash falhou: ${r.stderr}`);
            return r.stdout;
        },

        costLedger(ticketId) {
            const f = path.join(sb.repo, 'memory', 'runs', `${ticketId}-cost.json`);
            return fs.existsSync(f) ? readJson(f) : null;
        },

        calls(filter = {}) {
            return readJsonl(sb.callsFile).filter(c => Object.entries(filter).every(([k, v]) => c[k] === v));
        },

        tools() { return readJsonl(path.join(sb.pidsDir, 'tools.jsonl')); },

        // Processos vivos da sandbox: tudo que tem o caminho da sandbox no argv (agente,
        // mvn, java, filtro sanitize-log e o wrapper sh destacado) + os watchers.
        liveProcesses() {
            const out = spawnSync('ps', ['-axo', 'pid=,ppid=,pgid=,command='], { encoding: 'utf8' }).stdout || '';
            const watcherPids = new Set(sb.watcherRuns.map(c => c.pid));
            const parsed = out.split('\n').map(l => l.trim()).filter(Boolean).map(l => {
                const [pid, ppid, pgid, ...cmd] = l.split(/\s+/);
                return { pid: Number(pid), ppid: Number(ppid), pgid: Number(pgid), command: cmd.join(' ') };
            });
            const byPid = new Map(parsed.map(p => [p.pid, p]));
            const rows = parsed.filter(p => p.pid !== process.pid && (p.command.includes(sb.root) || (watcherPids.has(p.pid) && pidAlive(p.pid))));
            // Com alguém visível no ps, não varre o disco. Quando o ps zera, lsof confirma
            // o filtro sanitize-log.js (detached): ele não tem o caminho da sandbox no argv,
            // só o fd do log. Indexador do sistema que enxerga o diretório fica de fora.
            if (rows.length === 0) {
                const lsof = spawnSync('lsof', ['-t', '+D', sb.root], { encoding: 'utf8', timeout: 8000 });
                for (const pid of (lsof.stdout || '').split('\n').map(Number).filter(n => n > 0 && n !== process.pid)) {
                    const cmd = byPid.get(pid)?.command || '';
                    if (!/sanitize-log|node-lease|bitbucket-open-pr/.test(cmd)) continue;
                    rows.push(byPid.get(pid) || { pid, ppid: 0, pgid: 0, command: cmd });
                }
            }
            return rows;
        },

        async waitNoLiveProcesses(what, timeoutMs = 15000) {
            return waitFor(`${what}: nenhum processo da sandbox vivo`, () => sb.liveProcesses().length === 0 || null, timeoutMs, 100)
                .catch(e => { e.message += `\nvivos: ${JSON.stringify(sb.liveProcesses())}`; throw e; });
        },

        redminePuts(ticketId) {
            return sb.requests.filter(r => r.method === 'PUT' && r.path === `/redmine/issues/${ticketId}.json`);
        },

        bitbucketPrPosts() {
            return sb.requests.filter(r => r.method === 'POST' && /^\/bitbucket\/2\.0\/repositories\/[^/]+\/[^/]+\/pullrequests$/.test(r.path));
        },

        netBlocked() { return readJsonl(sb.netLog); },

        async close({ keep = false } = {}) {
            const leftovers = sb.liveProcesses();
            for (const p of leftovers) { try { process.kill(p.pid, 'SIGKILL'); } catch {} }
            await new Promise(r => sb.server.close(r));
            if (!keep) fs.rmSync(sb.root, { recursive: true, force: true });
            return leftovers;
        },
    };
}

module.exports = { createSandbox, waitFor, readJson, readJsonl, writeJson, pidAlive, git };
