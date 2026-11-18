'use strict';
// Ponto de retorno do consumidor (F1.2, PRI-379): conferência da árvore do checkout.
// Árvore válida = sem sujeira (rastreado modificado ou não rastreado; ignorado não conta)
// e HEAD alcançável pela origin/main local. Só leitura: sem fetch, sem mexer em refs, sem
// lock opcional do índice. O git é injetável, no estilo de dashboard/version.js.
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const MAX_PATHS = 10;
const ORIGIN_MAIN = 'refs/remotes/origin/main';
const TAG_PREFIX = 'verde/';
const LOG_FILE = path.join('logs', 'return-point.jsonl');
// Prazo curto de cada git do guard (subida e tick rodam no event loop do dashboard); a CLI
// fica com o padrão do runGit.
const GUARD_GIT_TIMEOUT_MS = 3000;

// Roda `git <args>` em cwd, sem shell. Falha ao iniciar (git ausente) vira status null.
function runGit(args, { cwd, env = process.env, timeout = 15000 } = {}) {
    const r = spawnSync('git', args, { cwd, env, timeout, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
    return { status: r.error ? null : r.status, stdout: r.stdout || '', stderr: r.stderr || (r.error ? r.error.message : '') };
}

// `status --porcelain -z`: "XY caminho\0"; renomeado/copiado traz a origem como entrada extra.
function dirtyPaths(stdout) {
    const entries = stdout.split('\0');
    const paths = [];
    for (let i = 0; i < entries.length; i++) {
        const e = entries[i];
        if (!e) continue;
        paths.push(e.slice(3));
        if (e[0] === 'R' || e[0] === 'C') i++;
    }
    return paths;
}

// timeoutMs: prazo de cada git (o guard usa GUARD_GIT_TIMEOUT_MS). Git que estoura o prazo
// sai com status null e conta como falha: a recusa continua fechada.
function checkTree({ root, git = runGit, timeoutMs }) {
    const opts = timeoutMs ? { cwd: root, timeout: timeoutMs } : { cwd: root };
    const run = args => git(args, opts);
    if (run(['rev-parse', '--is-inside-work-tree']).status !== 0) {
        return { ok: false, reasons: ['not_git'], paths: [], head: null };
    }
    const headR = run(['rev-parse', '--verify', '--quiet', 'HEAD^{commit}']);
    const head = headR.status === 0 ? headR.stdout.trim() || null : null;
    const reasons = [];

    const status = run(['--no-optional-locks', 'status', '--porcelain', '-z', '--untracked-files=normal']);
    const all = status.status === 0 ? dirtyPaths(status.stdout) : [];
    if (status.status !== 0 || all.length) reasons.push('dirty');

    if (run(['rev-parse', '--verify', '--quiet', `${ORIGIN_MAIN}^{commit}`]).status !== 0) {
        reasons.push('no_origin_main');
    } else if (!head || run(['merge-base', '--is-ancestor', head, ORIGIN_MAIN]).status !== 0) {
        reasons.push('off_main');
    }

    return { ok: reasons.length === 0, reasons, paths: all.slice(0, MAX_PATHS), head };
}

// PRISMA_CHECKOUT_GUARD: 1, true ou sim (sem diferenciar maiúsculas) liga; o resto desliga.
// A forma da leitura é a que o scripts/lib/flag-registry reconhece.
function guardEnabled(env = process.env) {
    return /^(1|true|sim)$/i.test(String(env.PRISMA_CHECKOUT_GUARD ?? '').trim());
}

// Último verde: a tag verde/* mais recente. A data de criação desempata pelo nome, que
// carrega a hora UTC e é ordenável (no git, a última --sort é a chave primária).
function lastGreen({ root, git = runGit }) {
    const r = git(['for-each-ref', '--sort=-refname', '--sort=-creatordate', '--count=1', '--format=%(refname:strip=2)', `refs/tags/${TAG_PREFIX}`], { cwd: root });
    if (r.status !== 0) return null;
    return r.stdout.trim() || null;
}

const pad = n => String(n).padStart(2, '0');
function tagName(d) {
    return `${TAG_PREFIX}${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}-${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`;
}

const realpathOr = p => { try { return fs.realpathSync(p); } catch { return p; } };
const refused = (code, message) => Object.assign(new Error(message), { code });

// Worktree ligada: o git-dir é .git/worktrees/<nome> do repositório comum, e a tag iria para
// o checkout principal (o vivo, no consumidor).
function linkedWorktree(run, root) {
    const r = run(['rev-parse', '--git-dir', '--git-common-dir']);
    if (r.status !== 0) return false;
    const [gitDir, commonDir] = r.stdout.trim().split('\n').map(p => realpathOr(path.resolve(root, p)));
    return !!commonDir && gitDir !== commonDir;
}

function appendLog(root, line) {
    const logPath = path.join(root, LOG_FILE);
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.appendFileSync(logPath, JSON.stringify(line) + '\n');
}

// Roda a checagem de saúde; se passar, cria a tag anotada no HEAD com o resultado.
// Depois que a checagem roda, toda saída acrescenta uma linha no log da raiz: aprovada,
// reprovada, ou com `error` (health_failed: a checagem lançou; head_changed: o HEAD mudou
// durante a checagem; tag_failed: o git tag falhou). Só SHA, tag, hora, itens, resultado e
// código: nada de caminho. Antes da checagem, worktree ligada e tag já existente recusam sem
// log. Tag existente é erro (nunca -f); nada é publicado.
async function mark({ root, health, now = () => new Date(), git = runGit }) {
    const run = args => git(args, { cwd: root });
    if (linkedWorktree(run, root)) {
        throw refused('linked_worktree', 'mark: rode no checkout principal (numa worktree ligada a tag iria para o repositório comum)');
    }
    const readHead = () => {
        const r = run(['rev-parse', '--verify', '--quiet', 'HEAD^{commit}']);
        return r.status === 0 ? r.stdout.trim() : '';
    };
    const head = readHead();
    if (!head) throw new Error('mark: HEAD não resolvido');
    const date = now();
    const name = tagName(date);
    if (run(['rev-parse', '--verify', '--quiet', `refs/tags/${name}`]).status === 0) {
        throw new Error(`mark: a tag ${name} já existe`);
    }
    const at = date.toISOString();

    let result;
    try { result = await health(); } catch (e) {
        appendLog(root, { at, head, tag: null, ok: false, error: 'health_failed' });
        throw e;
    }
    const items = Array.isArray(result?.items) ? result.items : [];
    // A saúde devolve o HEAD que validou (tree.head); a tag vai no HEAD lido antes dela.
    if ((result?.head !== undefined && result.head !== head) || readHead() !== head) {
        appendLog(root, { at, head, tag: null, ok: false, items, error: 'head_changed' });
        return { ok: false, tag: null, head, items, error: 'head_changed' };
    }

    const ok = result?.ok === true;
    let tag = null;
    if (ok) {
        const t = run(['tag', '-a', '--cleanup=verbatim', '-m', JSON.stringify({ at, head, ok, items }), name, head]);
        if (t.status !== 0) {
            appendLog(root, { at, head, tag: null, ok: false, items, error: 'tag_failed' });
            throw refused('tag_failed', `mark: não criou a tag ${name}: ${t.stderr.trim()}`);
        }
        tag = name;
    }
    appendLog(root, { at, head, tag, ok, items });
    return { ok, tag, head, items };
}

// ---------------------------------------------------------------- checagem de saúde
// Quatro itens, cada um pass|fail|desconhecido com motivo curto e sem caminho; ok = nenhum
// fail. Só GET em loopback (outra URL é erro antes de qualquer request), com prazo curto.
const LOOPBACK = new Set(['127.0.0.1', '[::1]', 'localhost']);
const HEALTH_TIMEOUT_MS = 2000;
const CODE_RE = /^[a-z0-9_]{1,40}$/;

function loopbackUrl(baseUrl) {
    let u;
    try { u = new URL(baseUrl); } catch { throw new Error('health: URL inválida; só loopback'); }
    if (u.protocol !== 'http:' || !LOOPBACK.has(u.hostname)) throw new Error('health: URL recusada; só loopback (127.0.0.1, ::1, localhost)');
    return u.origin;
}

// GET JSON; qualquer falha (recusa, prazo, HTTP != 2xx, corpo inválido) vira { error }.
async function getJson(fetchFn, url, timeoutMs) {
    try {
        const res = await fetchFn(url, { signal: AbortSignal.timeout(timeoutMs) });
        if (!res.ok) return { error: `HTTP ${res.status}` };
        return { body: await res.json() };
    } catch (e) {
        return { error: e?.name === 'TimeoutError' ? 'sem resposta no prazo' : 'sem resposta' };
    }
}

function treeItem(t) {
    return { name: 'arvore', status: t.ok ? 'pass' : 'fail', reason: t.ok ? 'limpa e na main' : t.reasons.join(',') };
}

function dashboardItem(v, head) {
    const fail = reason => ({ name: 'dashboard', status: 'fail', reason });
    if (v.error) return fail(v.error);
    const b = v.body;
    if (!b || b.status !== 'ok' || !b.current?.sha) return fail('versão indisponível');
    if (!head || b.current.sha !== head) return fail('SHA em execução difere do HEAD');
    if (b.drift !== false) return fail('drift entre execução e disco');
    return { name: 'dashboard', status: 'pass', reason: 'em execução no HEAD, sem drift' };
}

// A trava do watcher e os agentes moram no repo do consumidor (REPO_PATH), não na raiz do
// Prisma.
const NO_REPO = 'repo do consumidor não informado (--repo ou REPO_PATH)';

// Repo do consumidor válido = diretório existente com .git (diretório ou arquivo). Sem isso,
// watcher-lock.status cai numa trava em /tmp e diria "livre". Motivo curto, sem caminho.
function repoProblem(repo) {
    let st;
    try { st = fs.statSync(repo); } catch { return 'não existe'; }
    if (!st.isDirectory()) return 'não é diretório';
    if (!fs.existsSync(path.join(repo, '.git'))) return 'sem .git';
    return null;
}

// Um critério só para a saúde e o back. Devolve { st } com a trava legível, ou { code, reason }.
// Legível = status() não lança e a trava está livre, viva ou velha com conteúdo; arquivo
// corrompido ou sem permissão de leitura aparece como stale sem lock (watcher-lock.readLock)
// e não é legível. lockStatus injetado vale (chamado com o repo); null com repo = não
// conferida. Sem repo do consumidor, a trava não é conferida (a SPEC exige a trava legível).
function readConsumerLock(repo, lockStatus) {
    if (repo) {
        const why = repoProblem(repo);
        if (why) return { code: 'repo_invalid', reason: `repo do consumidor inválido (${why})` };
    }
    const status = lockStatus !== undefined ? lockStatus : repo ? r => require('./watcher-lock').status(r) : null;
    if (!status) return repo ? { code: 'lock_unchecked', reason: 'trava não conferida' } : { code: 'no_repo', reason: NO_REPO };
    let st;
    try { st = status(repo); } catch { return { code: 'lock_unreadable', reason: 'status da trava ilegível' }; }
    const s = st?.lock_state;
    if (s === 'free' || ((s === 'held' || s === 'stale') && st.lock && typeof st.lock === 'object')) return { st };
    return { code: 'lock_unreadable', reason: s === 'stale' ? 'arquivo da trava corrompido ou sem permissão' : 'estado da trava desconhecido' };
}

function lockItem(repo, lockStatus) {
    const r = readConsumerLock(repo, lockStatus);
    if (!r.st) return { name: 'trava', status: 'fail', reason: r.reason };
    return { name: 'trava', status: 'pass', reason: `legível (${r.st.lock_state})` };
}

// Subida = boot do dashboard (/api/version started_at; o watcher-manager nasce com ele, e
// `ticks` conta desde então). Queda = `error` do laço, `restarts` (crash desde o start do
// laço; zera a cada start) ou `last_run` encerrado por restart_limit depois da subida. Sem
// tick concluído desde a subida: desconhecido.
function tickItem(w, bootAt) {
    const item = (status, reason) => ({ name: 'tick', status, reason });
    if (w.error || !w.body || typeof w.body !== 'object') return item('desconhecido', 'status do watcher indisponível');
    const b = w.body;
    if (b.error != null) return item('fail', `erro ${CODE_RE.test(String(b.error)) ? b.error : 'do laço'}`);
    if (Number(b.restarts) > 0) return item('fail', `${Number(b.restarts)} queda(s) desde o start do laço`);
    const lr = b.last_run;
    if (lr?.reason === 'restart_limit') {
        const boot = Date.parse(bootAt);
        const ended = Date.parse(lr.ended_at);
        if (!Number.isFinite(boot) || !Number.isFinite(ended) || ended >= boot) return item('fail', 'laço parou por limite de quedas desde a subida');
    }
    const done = (Number.isInteger(b.ticks) ? b.ticks : 0) - (b.phase === 'tick' ? 1 : 0);
    if (done <= 0) return item('desconhecido', 'sem tick concluído desde a subida');
    return item('pass', 'sem queda desde o start do laço');
}

const defaultBaseUrl = () => `http://127.0.0.1:${process.env.PORT || 3333}`;

async function health({ root, repo, baseUrl, fetch: fetchFn = globalThis.fetch, lockStatus, git = runGit, timeoutMs = HEALTH_TIMEOUT_MS } = {}) {
    const origin = loopbackUrl(baseUrl ?? defaultBaseUrl());
    const tree = checkTree({ root, git });
    const version = await getJson(fetchFn, `${origin}/api/version`, timeoutMs);
    const watcher = await getJson(fetchFn, `${origin}/api/watcher/status`, timeoutMs);
    const items = [
        treeItem(tree),
        dashboardItem(version, tree.head),
        lockItem(repo, lockStatus),
        tickItem(watcher, version.body?.started_at),
    ];
    return { ok: items.every(i => i.status !== 'fail'), items, head: tree.head };
}

// ---------------------------------------------------------------- volta ao último verde
// Recusa (sem mudar nada, com todos os motivos) se não há alvo verde, a árvore está suja,
// o repo do consumidor falta ou é inválido, a trava tem dono vivo ou não se lê (mesmo
// critério da saúde), há agente vivo ou o laço do watcher está ativo no dashboard (sem
// resposta dele, vale só a trava). Senão, HEAD destacado na tag. Nunca stash, reset, clean,
// nem mover branch ou tag. Fora da main não impede: depois de uma volta o HEAD fica
// destacado, e uma nova volta tem de seguir possível.
const DEP_LOCKS = ['scripts/package-lock.json', 'dashboard/package-lock.json'];
const GREEN_RE = /^verde\/[0-9A-Za-z._-]+$/;

// Mesmo critério do painel Versão (dashboard/version.js): laço ativo = running ou estado != stopped.
const watcherActive = w => !!(w && (w.running || (w.state && w.state !== 'stopped')));

async function defaultWatcherStatus() {
    const r = await getJson(globalThis.fetch, `${loopbackUrl(defaultBaseUrl())}/api/watcher/status`, HEALTH_TIMEOUT_MS);
    return r.error ? null : r.body;
}

async function back({ root, to, repo, lockStatus, watcherStatus = defaultWatcherStatus, git = runGit } = {}) {
    const run = args => git(args, { cwd: root });
    const reasons = [];
    const refuse = (code, message) => reasons.push({ code, message });

    let tag = null;
    if (to != null) {
        if (!GREEN_RE.test(String(to))) refuse('to_invalid', `--to ${to} não é uma tag verde/*`);
        else if (run(['rev-parse', '--verify', '--quiet', `refs/tags/${to}^{commit}`]).status !== 0) refuse('to_missing', `a tag ${to} não existe`);
        else tag = to;
    } else {
        tag = lastGreen({ root, git });
        if (!tag) refuse('no_green', 'não há tag verde/*; rode mark antes');
    }

    const tree = checkTree({ root, git });
    if (tree.reasons.includes('not_git')) refuse('not_git', 'a raiz não é um repositório git');
    if (tree.reasons.includes('dirty')) refuse('dirty', 'árvore suja (arquivo modificado ou não rastreado)');

    const lock = readConsumerLock(repo, lockStatus);
    if (!lock.st) {
        const hint = { lock_unreadable: `não foi possível ler a trava do watcher: ${lock.reason}`, repo_invalid: `${lock.reason}; confira --repo ou REPO_PATH` };
        refuse(lock.code, hint[lock.code] || lock.reason);
    } else {
        if (lock.st.lock_state === 'held') refuse('lock_held', 'a trava do watcher tem dono vivo; pare o watcher antes');
        const n = Array.isArray(lock.st.agents) ? lock.st.agents.length : 0;
        if (n > 0) refuse('agents_alive', `${n} agente(s) destacado(s) vivo(s) no consumidor; espere terminarem`);
    }

    let w = null;
    try { w = await watcherStatus(); } catch { w = null; }
    if (watcherActive(w)) refuse('watcher_running', 'o laço do watcher está ativo no dashboard; pare o watcher antes');

    const from = tree.head;
    const result = { ok: false, tag, from, head: from, reasons, paths: tree.paths, warnings: [], restart: false };
    if (reasons.length) return result;

    const d = run(['diff', '--name-only', '-z', from, `refs/tags/${tag}`, '--', ...DEP_LOCKS]);
    if (d.status !== 0) {
        result.warnings.push({ code: 'deps_lock_unknown', paths: [], message: 'não foi possível comparar os locks de dependência' });
    } else {
        const changed = d.stdout.split('\0').filter(Boolean);
        if (changed.length) {
            result.warnings.push({ code: 'deps_lock_changed', paths: changed, message: `${changed.join(', ')} difere(m) entre o HEAD de antes e ${tag}: as dependências mudaram; reinstale antes de reiniciar o dashboard` });
        }
    }

    const sw = run(['switch', '--quiet', '--detach', `refs/tags/${tag}`]);
    const after = run(['rev-parse', '--verify', '--quiet', 'HEAD^{commit}']);
    result.head = after.status === 0 ? after.stdout.trim() : null;
    if (sw.status !== 0) {
        reasons.push({ code: 'switch_failed', message: 'git switch --detach falhou' });
        return result;
    }
    return { ...result, ok: true, restart: result.head !== from };
}

module.exports = { checkTree, guardEnabled, runGit, lastGreen, mark, health, back, MAX_PATHS, GUARD_GIT_TIMEOUT_MS };
