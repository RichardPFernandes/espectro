// Tela "Este computador" (onboarding de parceiro): reconhece as ferramentas da máquina,
// grava a configuração mínima do consumidor e testa cada peça só com leitura.
//
// Onde cada escolha mora (nenhum arquivo novo, nenhum canal paralelo):
//   - pasta do projeto  → REPO_PATH no dashboard/.env do Prisma (lido no boot, antes de
//     resolver o consumidor). Vale depois de reiniciar. Se REPO_PATH veio do ambiente
//     (launcher do consumidor), a pasta fica travada: muda-se no launcher.
//   - Redmine/Bitbucket → .env da raiz do consumidor, as mesmas chaves que watcher e
//     dashboard já leem. Segredo nunca volta: a API só diz se está preenchido.
//   - conta do Claude   → claude_config_dir no dashboard-prefs.json do consumidor
//     (o mesmo seletor do painel Watcher).
//
// Nada aqui instala, faz login ou escreve em Redmine/Bitbucket/repositório. A verificação
// final lê: git do repo, GET /users/current no Redmine, GET do repo no Bitbucket e a
// sondagem mínima do Claude (gasta um pouco da cota, como o botão de uso do Watcher).
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const NODE_MIN_MAJOR = 20;
const FETCH_TIMEOUT_MS = 10000;
const TOOL_TIMEOUT_MS = 10000;
const SECRET_FIELDS = { redmineApiKey: 'REDMINE_API_KEY', bitbucketApiToken: 'BITBUCKET_API_TOKEN' };
const PLAIN_FIELDS = { redmineUrl: 'REDMINE_URL', bitbucketWorkspace: 'BITBUCKET_WORKSPACE', bitbucketRepoSlug: 'BITBUCKET_REPO_SLUG' };
const SLUG_RE = /^[A-Za-z0-9._-]{1,100}$/;
// Sem espaço, aspas ou # no começo: o loadDotEnv do servidor lê o valor cru.
const SECRET_RE = /^[^\s"'#][^\s"']{7,1023}$/;

function run(file, args, { cwd, timeout = TOOL_TIMEOUT_MS } = {}) {
    return new Promise(resolve => {
        execFile(file, args, { cwd, timeout, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
            resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout: String(stdout), stderr: String(stderr), missing: err?.code === 'ENOENT' });
        });
    });
}

const expandHome = p => p.replace(/^~(?=$|\/)/, os.homedir());
const realpath = p => { try { return fs.realpathSync(p); } catch { return null; } };

// KEY=valor do arquivo (mesma leitura do loadDotEnv do servidor, sem tocar no process.env).
function readEnvFile(file) {
    const out = {};
    let text = '';
    try { text = fs.readFileSync(file, 'utf8'); } catch { return out; }
    for (const raw of text.split('\n')) {
        const line = raw.trim().replace(/^export\s+/, '');
        if (!line || line.startsWith('#')) continue;
        const eq = line.indexOf('=');
        if (eq === -1) continue;
        let value = line.slice(eq + 1).trim();
        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
        else value = value.replace(/\s+#.*$/, '').replace(/^#.*$/, '').trim();
        if (value) out[line.slice(0, eq).trim()] = value;
    }
    return out;
}

// Troca a primeira linha de cada chave e acrescenta as que faltam; o resto do arquivo
// (comentários, outras chaves) fica como está. Arquivo novo nasce 0600.
function upsertEnvFile(file, updates) {
    const keys = Object.keys(updates);
    if (!keys.length) return;
    let lines = [];
    let mode = 0o600;
    try {
        lines = fs.readFileSync(file, 'utf8').split('\n');
        mode = fs.statSync(file).mode & 0o777;
    } catch { /* arquivo novo */ }
    const done = new Set();
    lines = lines.map(line => {
        const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
        if (!m || !keys.includes(m[1]) || done.has(m[1])) return line;
        done.add(m[1]);
        return `${m[1]}=${updates[m[1]]}`;
    });
    while (lines.length && lines[lines.length - 1] === '') lines.pop();
    for (const k of keys) if (!done.has(k)) lines.push(`${k}=${updates[k]}`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${lines.join('\n')}\n`, { mode });
    fs.renameSync(tmp, file);
}

function createOnboarding({
    repoRoot, prismaRoot, env, envFile, repoPathLocked = false, redact = x => x,
    listAccounts, probeUsage, validateConfig = null, onSaved = () => {},
    exec = run, fetchFn = globalThis.fetch, platform = process.platform, nodeVersion = process.version,
}) {
    const prefsFileOf = repo => path.join(repo, 'dashboard', 'dashboard-prefs.json');
    const readPrefs = repo => { try { return JSON.parse(fs.readFileSync(prefsFileOf(repo), 'utf8')); } catch { return {}; } };

    // ---------------------------------------------------------------- ferramentas
    const version = text => (/(\d+\.\d+(?:\.\d+)?)/.exec(text) || [])[1] || null;
    async function tools() {
        const [git, npm, claude, codex] = await Promise.all([
            exec('git', ['--version']), exec('npm', ['--version']), exec('claude', ['--version']), exec('codex', ['--version']),
        ]);
        const found = r => r.code === 0;
        const nodeMajor = Number((/^v?(\d+)/.exec(nodeVersion) || [])[1]);
        const accounts = listAccounts();
        const items = [
            found(git)
                ? { id: 'git', name: 'Git', role: 'Obrigatório', state: 'done', detail: `encontrado · ${version(git.stdout) || 'versão desconhecida'}` }
                : { id: 'git', name: 'Git', role: 'Obrigatório', state: 'waiting', detail: 'Não encontrado. Instale no terminal:',
                    ...(platform === 'darwin' ? { command: 'xcode-select --install' } : { hint: 'Instale pelo gerenciador de pacotes do sistema.' }) },
            nodeMajor >= NODE_MIN_MAJOR && found(npm)
                ? { id: 'node', name: 'Node.js e npm', role: 'Obrigatório', state: 'done', detail: `encontrado · ${nodeVersion} · npm ${version(npm.stdout) || '?'}` }
                : { id: 'node', name: 'Node.js e npm', role: 'Obrigatório', state: 'waiting',
                    detail: nodeMajor >= NODE_MIN_MAJOR ? 'npm não encontrado.' : `${nodeVersion} · exige ${NODE_MIN_MAJOR} ou mais.`,
                    hint: `Instale o Node ${NODE_MIN_MAJOR} ou mais (nodejs.org) e reinicie o Espectro.` },
            found(claude)
                ? { id: 'claude', name: 'Claude Code', role: 'Agente · obrigatório', state: 'done',
                    detail: `encontrado · ${version(claude.stdout) || 'versão desconhecida'} · ${accounts.length} conta${accounts.length === 1 ? '' : 's'} na máquina` }
                : { id: 'claude', name: 'Claude Code', role: 'Agente · obrigatório', state: 'waiting',
                    detail: 'Não encontrado. Instale e faça login no terminal:', command: 'npm install -g @anthropic-ai/claude-code && claude' },
            found(codex)
                ? { id: 'codex', name: 'Codex CLI', role: 'Agente · opcional', state: 'done', detail: `encontrado · ${version(codex.stdout) || '?'} · o watcher ainda despacha só Claude Code` }
                : { id: 'codex', name: 'Codex CLI', role: 'Agente · opcional', state: 'queued', detail: 'não encontrado' },
        ];
        const summary = { done: 0, optional: 0, waiting: 0 };
        for (const t of items) summary[t.state === 'queued' ? 'optional' : t.state] += 1;
        return { items, summary };
    }

    // ---------------------------------------------------------------- configuração
    async function repoInfo(input) {
        if (typeof input !== 'string' || !input.trim()) return { ok: false, reason: 'Informe a pasta do repositório.' };
        const abs = path.resolve(expandHome(input.trim()));
        const real = realpath(abs);
        if (!real || !fs.statSync(real).isDirectory()) return { ok: false, path: abs, reason: 'Pasta não encontrada.' };
        const top = await exec('git', ['-C', real, 'rev-parse', '--show-toplevel']);
        if (top.code !== 0) return { ok: false, path: abs, reason: 'Não é um repositório Git.' };
        const root = realpath(top.stdout.trim());
        if (prismaRoot && root === realpath(prismaRoot)) return { ok: false, path: abs, reason: 'Esta é a pasta do próprio Espectro; aponte para o repositório do projeto.' };
        if (root !== real) return { ok: false, path: abs, reason: `Aponte para a raiz do repositório: ${root}` };
        return { ok: true, path: abs };
    }

    // REPO_PATH gravado aqui e ainda não em uso (falta reiniciar).
    const pendingRepo = () => {
        if (repoPathLocked) return null;
        const v = readEnvFile(envFile).REPO_PATH;
        return v ? path.resolve(expandHome(v)) : null;
    };
    const targetRepo = () => pendingRepo() || repoRoot;
    const sameDir = (a, b) => (realpath(a) || path.resolve(a)) === (realpath(b) || path.resolve(b));

    // Valores efetivos no repo alvo: o .env dele; se é o repo em uso, o ambiente do processo completa.
    function effectiveValues(repo) {
        const file = readEnvFile(path.join(repo, '.env'));
        const live = sameDir(repo, repoRoot) ? env : {};
        const out = {};
        for (const key of [...Object.values(PLAIN_FIELDS), ...Object.values(SECRET_FIELDS)]) out[key] = file[key] || live[key] || '';
        return out;
    }

    function selectedAccount(repo) {
        const pref = readPrefs(repo).claude_config_dir;
        const accounts = listAccounts();
        const id = accounts.some(a => a.id === pref) ? pref : (accounts[0]?.id || null);
        return { accounts, id, dir: id && id !== 'default' ? accounts.find(a => a.id === id)?.dir || null : null };
    }

    async function readConfig() {
        const repo = targetRepo();
        const values = effectiveValues(repo);
        const account = selectedAccount(repo);
        const git = await repoInfo(repo);
        return {
            repo: {
                path: repo, active: repoRoot, locked: repoPathLocked,
                restartRequired: !sameDir(repo, repoRoot), git,
            },
            agent: { runtime: 'claude', accounts: account.accounts.map(({ id, label }) => ({ id, label })), account: account.id },
            redmine: { url: values.REDMINE_URL, apiKeySet: !!values.REDMINE_API_KEY },
            bitbucket: { workspace: values.BITBUCKET_WORKSPACE, repoSlug: values.BITBUCKET_REPO_SLUG, apiTokenSet: !!values.BITBUCKET_API_TOKEN },
            needsSetup: !git.ok || !values.REDMINE_URL || !values.REDMINE_API_KEY,
        };
    }

    async function saveConfig(body = {}) {
        const errors = {};
        const str = v => (typeof v === 'string' ? v.trim() : '');
        let repo = targetRepo();
        if ('repoPath' in body) {
            const info = await repoInfo(str(body.repoPath));
            if (!info.ok) errors.repoPath = info.reason;
            else if (repoPathLocked && !sameDir(info.path, repoRoot)) errors.repoPath = 'A pasta vem do launcher (REPO_PATH no ambiente); mude por lá.';
            else repo = info.path;
        }
        const accounts = listAccounts();
        if ('claudeAccount' in body && !accounts.some(a => a.id === body.claudeAccount)) errors.claudeAccount = 'Conta do Claude desconhecida nesta máquina.';
        const updates = {};
        const url = str(body.redmineUrl);
        if (url) {
            let parsed = null;
            try { parsed = new URL(url); } catch { /* inválida */ }
            if (!parsed || !/^https?:$/.test(parsed.protocol) || /[\s"']/.test(url)) errors.redmineUrl = 'Use o endereço completo, como https://redmine.suaempresa.com.';
            else updates.REDMINE_URL = url.replace(/\/+$/, '');
        }
        for (const field of ['bitbucketWorkspace', 'bitbucketRepoSlug']) {
            const v = str(body[field]);
            if (v && !SLUG_RE.test(v)) errors[field] = 'Só letras, números, ponto, hífen e sublinhado.';
            else if (v) updates[PLAIN_FIELDS[field]] = v;
        }
        // Segredo em branco = mantém o que já está salvo.
        for (const [field, key] of Object.entries(SECRET_FIELDS)) {
            const v = str(body[field]);
            if (v && !SECRET_RE.test(v)) errors[field] = 'Cole a chave inteira, sem espaços nem aspas.';
            else if (v) updates[key] = v;
        }
        if (Object.keys(errors).length) return { status: 400, body: { error: 'Revise os campos marcados.', errors } };

        if (!repoPathLocked) {
            const pending = readEnvFile(envFile).REPO_PATH;
            if (!pending ? !sameDir(repo, repoRoot) : !sameDir(pending, repo)) upsertEnvFile(envFile, { REPO_PATH: repo });
        }
        upsertEnvFile(path.join(repo, '.env'), updates);
        if ('claudeAccount' in body) {
            const prefsFile = prefsFileOf(repo);
            const prefs = { ...readPrefs(repo), claude_config_dir: body.claudeAccount };
            fs.mkdirSync(path.dirname(prefsFile), { recursive: true });
            fs.writeFileSync(prefsFile, JSON.stringify(prefs, null, 2));
        }
        if (sameDir(repo, repoRoot)) onSaved(updates);
        return { status: 200, body: await readConfig() };
    }

    // ---------------------------------------------------------------- verificação (só leitura)
    async function fetchStatus(url, headers) {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
        try {
            const res = await fetchFn(url, { headers, signal: ctrl.signal });
            return { status: res.status, body: await res.json().catch(() => null) };
        } catch (e) {
            return { status: 0, error: e.name === 'AbortError' ? `sem resposta em ${FETCH_TIMEOUT_MS / 1000} s` : 'sem conexão' };
        } finally { clearTimeout(timer); }
    }
    const httpFail = (r, what) => (r.status === 401 || r.status === 403 ? `${what} recusada (HTTP ${r.status})` : r.status ? `HTTP ${r.status}` : r.error);

    async function checkRepo(repo) {
        const info = await repoInfo(repo);
        if (!info.ok) return { state: 'failed', detail: info.reason };
        const [branch, status] = await Promise.all([
            exec('git', ['-C', repo, 'symbolic-ref', '--short', '-q', 'HEAD']),
            exec('git', ['-C', repo, 'status', '--porcelain']),
        ]);
        if (status.code !== 0) return { state: 'failed', detail: 'git status falhou' };
        const changes = status.stdout.split('\n').filter(Boolean).length;
        return { state: 'done', detail: `leitura ok · ${branch.code === 0 ? `branch ${branch.stdout.trim()}` : 'HEAD destacado'} · ${changes} alteraç${changes === 1 ? 'ão' : 'ões'} local${changes === 1 ? '' : 'is'}` };
    }

    async function checkAgent(repo) {
        const { id, dir } = selectedAccount(repo);
        const r = await probeUsage({ configDir: dir });
        if (!r?.ok) return { state: 'failed', detail: r?.error || 'sem resposta do Claude Code' };
        return { state: 'done', detail: `respondeu ao ensaio · conta ${id === 'default' ? 'padrão' : id}` };
    }

    async function checkRedmine(values) {
        if (!values.REDMINE_URL || !values.REDMINE_API_KEY) return { state: 'failed', detail: 'endereço ou chave não preenchidos' };
        const r = await fetchStatus(`${values.REDMINE_URL.replace(/\/+$/, '')}/users/current.json`, { 'X-Redmine-API-Key': values.REDMINE_API_KEY, Accept: 'application/json' });
        if (r.status !== 200) return { state: 'failed', detail: httpFail(r, 'chave') };
        const login = r.body?.user?.login;
        return { state: 'done', detail: login ? `conectado como ${login}` : 'conectado' };
    }

    async function checkBitbucket(values) {
        const { BITBUCKET_WORKSPACE: ws, BITBUCKET_REPO_SLUG: slug, BITBUCKET_API_TOKEN: token } = values;
        if (!token) return { state: 'queued', detail: 'não configurado · opcional (status dos PRs fica sem dados)' };
        if (!ws || !slug) return { state: 'failed', detail: 'token salvo, mas faltam workspace e repositório' };
        const r = await fetchStatus(`https://api.bitbucket.org/2.0/repositories/${encodeURIComponent(ws)}/${encodeURIComponent(slug)}`, { Authorization: `Bearer ${token}`, Accept: 'application/json' });
        return r.status === 200 ? { state: 'done', detail: `leu ${ws}/${slug}` } : { state: 'failed', detail: httpFail(r, 'token') };
    }

    async function checkProject(repo) {
        if (!sameDir(repo, repoRoot) || !validateConfig) return { state: 'queued', detail: 'reinicie o Espectro para validar a pasta nova' };
        try {
            const report = await validateConfig();
            const errors = (report.results || []).filter(r => !r.passed && r.severity === 'error').length;
            if (report.exitCode === 0) return { state: 'done', detail: 'contrato de configuração ok' };
            return { state: 'failed', detail: `${errors || 'há'} erro${errors === 1 ? '' : 's'} no contrato · veja Configuração no pé da navegação` };
        } catch (e) {
            return { state: 'failed', detail: e.message };
        }
    }

    async function check() {
        const repo = targetRepo();
        const values = effectiveValues(repo);
        const repoCheck = await checkRepo(repo);
        const results = await Promise.all([
            Promise.resolve(repoCheck),
            checkAgent(repo),
            checkRedmine(values),
            checkBitbucket(values),
            repoCheck.state === 'done' ? checkProject(repo) : { state: 'queued', detail: 'depende do repositório' },
        ]);
        const names = [['repo', 'Repositório'], ['agent', 'Agente · Claude Code'], ['redmine', 'Tracker · Redmine'], ['bitbucket', 'PRs · Bitbucket'], ['project', 'Configuração do projeto']];
        const items = names.map(([id, name], i) => ({ id, name, ...results[i] }));
        return redact({
            items,
            ready: items.every(i => i.state !== 'failed') && items.find(i => i.id === 'repo').state === 'done',
            restartRequired: !sameDir(repo, repoRoot),
            checkedAt: new Date().toISOString(),
        });
    }

    function mount(app) {
        const guard = fn => async (req, res) => {
            try { await fn(req, res); } catch (e) { res.status(500).json({ error: redact(`falha no onboarding: ${e.message}`) }); }
        };
        app.get('/api/onboarding/tools', guard(async (req, res) => res.json(redact(await tools()))));
        app.get('/api/onboarding/config', guard(async (req, res) => res.json(redact(await readConfig()))));
        app.get('/api/onboarding/repo', guard(async (req, res) => res.json(await repoInfo(String(req.query.path || '')))));
        app.put('/api/onboarding/config', guard(async (req, res) => {
            const r = await saveConfig(req.body || {});
            res.status(r.status).json(redact(r.body));
        }));
        app.post('/api/onboarding/check', guard(async (req, res) => res.json(await check())));
    }

    return { tools, repoInfo, readConfig, saveConfig, check, mount };
}

module.exports = { createOnboarding, readEnvFile, upsertEnvFile };
