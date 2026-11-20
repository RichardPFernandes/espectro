// Manifesto do workspace (PRI-310 / PRI-287 S5.1, SDD B4; desenho v9 §3.5, D14).
//
// Identidade de conteúdo do worktree do ticket, só leitura, para decidir se um Attempt de
// subtarefa deixou mutação (UNK-AR-002 segue OPEN: o manifesto só impede retry sobre
// mutação não observada; não resolve a baseline nem escolhe restauração).
//
// Regras:
// - Só leitura: comandos git de leitura com GIT_OPTIONAL_LOCKS=0 (o `git status` não reescreve
//   o index). Nada de -w, stash, reset, checkout, add. A identidade do conteúdo é calculada
//   aqui, lendo os bytes (equivale a `git hash-object --no-filters`, sem gravar objeto).
// - Componentes: head, index, tracked, untracked, ignored_in_scope (§3.5). Fora, declarado:
//   memory/runs/** e ignorados fora dos pathspecs (paths_decl da plan_version + globs).
//   Diretórios vazios não são observados (o git não os versiona): limite declarado.
//   O índice entra como uma entrada agregada (digest do `ls-files -s -v`, com flags).
// - HMAC por Run: cada entrada vira HMAC-SHA256(chave, componente \0 caminho \0 modo \0 id).
//   A chave fica fora do worktree (REPO_PATH/memory/runs/_dom06-keys/<task>.key, 0600), e o
//   caminho precisa estar ignorado pelo git do checkout principal (check-ignore).
// - Para fora (Attempt, evidência) só sai summary(): digest, contagens e completeness.
//   Caminhos, ids de conteúdo e a chave nunca saem.
// - completeness UNKNOWN (contagens null) quando qualquer item falha: git com erro (sem nova
//   tentativa), arquivo ilegível, link para fora do worktree, submódulo com mudança, limite
//   excedido, conteúdo alterado entre duas leituras, chave ausente.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const COMPONENTS = ['head', 'index', 'tracked', 'untracked', 'ignored_in_scope'];
const DEFAULT_LIMITS = Object.freeze({ maxEntries: 20000, maxBytes: 256 * 1024 * 1024 });
const EXCLUDED_PREFIX = 'memory/runs/';
const KEY_BYTES = 32;

class ManifestUnknown extends Error {
    constructor(cause) { super(cause); this.cause_code = cause; }
}

// Variáveis que redirecionariam o git para outro repositório/índice: nunca herdadas.
const GIT_REDIRECT_ENV = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_COMMON_DIR', 'GIT_NAMESPACE'];
// Sem fsmonitor (daemon/socket em .git) e sem cache de untracked (gravaria no índice).
// Limite declarado: filtros clean do consumidor (ex.: git-lfs) ainda podem rodar no
// `git status` para arquivos "racy"; não há como desligar filtros genéricos por nome.
const SAFE_CONFIG = ['-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false'];

function safeEnv(env) {
    const out = { ...env, GIT_OPTIONAL_LOCKS: '0' };
    for (const k of GIT_REDIRECT_ENV) delete out[k];
    return out;
}

function gitRead(worktree, args, { env = process.env, gitBin = 'git' } = {}) {
    try {
        return execFileSync(gitBin, [...SAFE_CONFIG, ...args], {
            cwd: worktree,
            env: safeEnv(env),
            stdio: ['ignore', 'pipe', 'pipe'],
            maxBuffer: 512 * 1024 * 1024,
        });
    } catch {
        throw new ManifestUnknown('GIT_ERROR');
    }
}

// Ordem canônica por unidade de código, independente de locale (C-O-01): watcher e wrapper
// destacado podem rodar com LANG/LC_ALL diferentes.
const byCodeUnit = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const splitZ = buf => buf.toString('utf8').split('\0').filter(Boolean);
const excluded = p => p === EXCLUDED_PREFIX.slice(0, -1) || p.startsWith(EXCLUDED_PREFIX);

function contentId(worktree, rel, budget) {
    const abs = path.join(worktree, rel);
    let st;
    try {
        st = fs.lstatSync(abs);
    } catch (e) {
        if (e && e.code === 'ENOENT') return { mode: 'absent', id: 'absent' };
        throw new ManifestUnknown('UNREADABLE');
    }
    if (st.isSymbolicLink()) {
        let target;
        try { target = fs.readlinkSync(abs); } catch { throw new ManifestUnknown('UNREADABLE'); }
        // Dentro ou fora decidido só por realpath (C-A-07): alvo inexistente usa o realpath do
        // diretório pai mais o nome, para que uma cadeia de links não escape pelo caminho léxico.
        const root = fs.realpathSync(worktree);
        const resolved = path.resolve(path.dirname(abs), target);
        let real;
        try {
            real = fs.realpathSync(resolved);
        } catch {
            // Link pendente (alvo ainda não existe, ex.: antes do build): sobe até o ancestral
            // mais próximo que existe, aplica realpath nele e anexa o resto (R2-C-O-01).
            let base = path.dirname(resolved);
            const rest = [path.basename(resolved)];
            while (!fs.existsSync(base) && path.dirname(base) !== base) { rest.unshift(path.basename(base)); base = path.dirname(base); }
            try { real = path.join(fs.realpathSync(base), ...rest); } catch { throw new ManifestUnknown('UNREADABLE'); }
        }
        if (real !== root && !real.startsWith(root + path.sep)) throw new ManifestUnknown('SYMLINK_OUTSIDE_WORKTREE');
        return { mode: 'link', id: crypto.createHash('sha256').update(`link\0${target}`).digest('hex') };
    }
    // Diretório untracked listado pelo git = repositório aninhado (ou submódulo não
    // registrado): mudanças dentro dele seriam invisíveis → UNKNOWN (C-O-09).
    if (st.isDirectory()) throw new ManifestUnknown('NESTED_REPOSITORY');
    if (!st.isFile()) throw new ManifestUnknown('UNREADABLE');
    budget.bytes += st.size;
    if (budget.bytes > budget.maxBytes) throw new ManifestUnknown('LIMIT_EXCEEDED');
    let bytes;
    try { bytes = fs.readFileSync(abs); } catch { throw new ManifestUnknown('UNREADABLE'); }
    const mode = (st.mode & 0o111) ? '100755' : '100644';
    return { mode, id: crypto.createHash('sha256').update(bytes).digest('hex') };
}

function hmacEntry(key, component, rel, mode, id) {
    return crypto.createHmac('sha256', key).update(`${component}\0${rel}\0${mode}\0${id}`).digest('hex');
}

// porcelain v2 -z: '1 XY sub mH mI mW hH hI path', '2 XY sub mH mI mW hH hI Xs path\0orig',
// 'u XY sub m1 m2 m3 mW h1 h2 h3 path'. sub = 'N...' (não submódulo) ou 'S<c><m><u>'.
function parseStatus(buf) {
    const tokens = buf.toString('utf8').split('\0');
    const out = [];
    for (let i = 0; i < tokens.length; i++) {
        const t = tokens[i];
        if (!t) continue;
        const kind = t[0];
        if (kind !== '1' && kind !== '2' && kind !== 'u') continue;
        const parts = t.split(' ');
        const fields = kind === '1' ? 8 : kind === '2' ? 9 : 10;
        const rel = parts.slice(fields).join(' ');
        const sub = parts[2];
        if (sub && sub[0] === 'S' && sub !== 'S...') throw new ManifestUnknown('SUBMODULE_CHANGED');
        out.push(rel);
        if (kind === '2') { if (tokens[i + 1]) out.push(tokens[i + 1]); i++; }
    }
    return out;
}

function globPathspec(g) {
    return `:(glob)${g}`;
}

function observeOnce(worktree, { key, scopePaths, watchGlobs, limits, env }) {
    const entries = [];
    const budget = { bytes: 0, maxBytes: limits.maxBytes };
    const push = (component, rel, mode, id) => {
        if (excluded(rel)) return;
        entries.push({ component, path: rel, id: hmacEntry(key, component, rel, mode, id) });
        if (entries.length > limits.maxEntries) throw new ManifestUnknown('LIMIT_EXCEEDED');
    };

    const head = gitRead(worktree, ['rev-parse', 'HEAD'], { env }).toString('utf8').trim();
    push('head', '', '', head);

    // Índice como UMA entrada agregada (C-A-08): o digest do `ls-files -s -v` inteiro (modo,
    // blob, estágio, caminho e flags). Repositório grande não estoura o limite de entradas.
    // Flags assume-unchanged (minúscula) e skip-worktree (S) escondem edições do `git status`:
    // o conteúdo atual desses caminhos entra no componente tracked (C-O-09).
    const indexRaw = gitRead(worktree, ['ls-files', '-s', '-v', '-z'], { env });
    push('index', '', '', crypto.createHash('sha256').update(indexRaw).digest('hex'));
    const hidden = [];
    for (const line of splitZ(indexRaw)) {
        const tag = line[0];
        const rel = line.slice(line.indexOf('\t') + 1);
        // skip-worktree só conta se o arquivo existe no disco: em checkout sparse, os milhares
        // de caminhos fora do sparse não viram entradas (R2-C-O-03).
        if (tag === 'S' ? fs.existsSync(path.join(worktree, rel)) : (tag >= 'a' && tag <= 'z')) hidden.push(rel);
    }

    const status = gitRead(worktree, ['status', '--porcelain=v2', '-z', '--untracked-files=no', '--ignore-submodules=none'], { env });
    for (const rel of [...new Set([...parseStatus(status), ...hidden])].sort(byCodeUnit)) {
        if (excluded(rel)) continue;
        const c = contentId(worktree, rel, budget);
        push('tracked', rel, c.mode, c.id);
    }

    for (const rel of splitZ(gitRead(worktree, ['ls-files', '--others', '--exclude-standard', '-z'], { env })).sort(byCodeUnit)) {
        if (excluded(rel)) continue;
        const c = contentId(worktree, rel, budget);
        push('untracked', rel, c.mode, c.id);
    }

    const specs = [...new Set([...(scopePaths || []), ...(watchGlobs || []).map(globPathspec)])];
    if (specs.length) {
        const ignored = gitRead(worktree, ['ls-files', '--others', '--ignored', '--exclude-standard', '-z', '--', ...specs], { env });
        for (const rel of splitZ(ignored).sort(byCodeUnit)) {
            if (excluded(rel)) continue;
            const c = contentId(worktree, rel, budget);
            push('ignored_in_scope', rel, c.mode, c.id);
        }
    }

    entries.sort((a, b) => (a.component === b.component ? byCodeUnit(a.path, b.path) : COMPONENTS.indexOf(a.component) - COMPONENTS.indexOf(b.component)));
    const digest = crypto.createHash('sha256').update(entries.map(e => e.id).join('\n')).digest('hex');
    const counts = Object.fromEntries(COMPONENTS.map(c => [c, entries.filter(e => e.component === c).length]));
    return { completeness: 'COMPLETE', cause: null, digest, counts, entries };
}

function unknown(cause) {
    return { completeness: 'UNKNOWN', cause, digest: null, counts: null, entries: null };
}

/**
 * Manifesto completo (local). Lê duas vezes; digests diferentes = conteúdo mudou durante a
 * leitura → UNKNOWN. Nunca lança.
 * @param {{ worktree: string, key: Buffer|null, keyCause?: string|null, scopePaths?: string[], watchGlobs?: string[],
 *   limits?: { maxEntries?: number, maxBytes?: number }, env?: object }} opts
 */
function observe({ worktree, key, keyCause = null, scopePaths = [], watchGlobs = [], limits = {}, env = process.env } = {}) {
    // Sem chave: a causa do ensureKey (ex.: KEY_PATH_NOT_IGNORED) é preservada no resumo.
    if (!Buffer.isBuffer(key) || key.length < KEY_BYTES) return unknown(keyCause || 'KEY_MISSING');
    const lim = { ...DEFAULT_LIMITS, ...limits };
    try {
        const first = observeOnce(worktree, { key, scopePaths, watchGlobs, limits: lim, env });
        const second = observeOnce(worktree, { key, scopePaths, watchGlobs, limits: lim, env });
        if (first.digest !== second.digest) return unknown('CHANGED_DURING_READ');
        return second;
    } catch (e) {
        return unknown(e instanceof ManifestUnknown ? e.cause_code : 'UNREADABLE');
    }
}

/** O único resumo que sai do manifesto: digest, contagens, completeness, causa. */
function summary(m) {
    if (!m || m.completeness !== 'COMPLETE' || typeof m.digest !== 'string') {
        return { digest: null, counts: null, completeness: 'UNKNOWN', cause: (m && m.cause) || 'UNKNOWN' };
    }
    return { digest: m.digest, counts: { ...m.counts }, completeness: 'COMPLETE', cause: null };
}

/** Comparação local: caminhos alterados (só para o arquivo local e o aviso por contagem). */
function compare(a, b) {
    if (!a || !b || a.completeness !== 'COMPLETE' || b.completeness !== 'COMPLETE') return { comparable: false, equal: false, changed: null };
    const key = e => `${e.component}\0${e.path}`;
    const ma = new Map(a.entries.map(e => [key(e), e.id]));
    const mb = new Map(b.entries.map(e => [key(e), e.id]));
    const changed = new Set();
    for (const [k, id] of ma) if (mb.get(k) !== id) changed.add(k.split('\0')[1]);
    for (const k of mb.keys()) if (!ma.has(k)) changed.add(k.split('\0')[1]);
    return { comparable: true, equal: a.digest === b.digest, changed: [...changed].sort() };
}

// ---------------------------------------------------------------------------------
// Chave por Run e armazenamento local (fora do worktree)

function keyPath(keysDir, task) {
    if (!/^[A-Za-z0-9._-]+$/.test(String(task))) throw new Error('MANIFEST_TASK_INVALID');
    return path.join(keysDir, `${task}.key`);
}

function isIgnored(checkoutRoot, file, { env = process.env } = {}) {
    try {
        // Sem --no-index (C-A-06): um caminho rastreado nunca conta como ignorado.
        execFileSync('git', ['check-ignore', '-q', file], { cwd: checkoutRoot, env: safeEnv(env), stdio: 'ignore' });
        return true;
    } catch {
        return false;
    }
}

/**
 * Chave da Run: lê a existente ou cria (32 bytes, 0600). Antes de criar, o caminho precisa
 * estar ignorado pelo git do checkout principal; senão nada é gravado.
 * @returns {{ ok: true, key: Buffer } | { ok: false, cause: string }}
 */
function ensureKey({ keysDir, task, checkoutRoot, env = process.env }) {
    const file = keyPath(keysDir, task);
    if (!isIgnored(checkoutRoot, file, { env })) return { ok: false, cause: 'KEY_PATH_NOT_IGNORED' };
    const readExisting = () => {
        const key = fs.readFileSync(file);
        return key.length >= KEY_BYTES ? { ok: true, key } : { ok: false, cause: 'KEY_MISSING' };
    };
    try {
        if (fs.existsSync(file)) return readExisting();
        fs.mkdirSync(keysDir, { recursive: true, mode: 0o700 });
        // Escrita completa num temporário 0600 e publicação exclusiva por link (C-O-10): nunca
        // fica chave truncada no caminho final; quem perde a corrida lê a do vencedor.
        const key = crypto.randomBytes(KEY_BYTES);
        const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
        fs.writeFileSync(tmp, key, { mode: 0o600, flag: 'wx' });
        try {
            fs.linkSync(tmp, file);
            return { ok: true, key };
        } catch (e) {
            if (e && e.code === 'EEXIST') return readExisting();
            throw e;
        } finally {
            fs.rmSync(tmp, { force: true });
        }
    } catch {
        return { ok: false, cause: 'KEY_MISSING' };
    }
}

/** Apaga a chave da Run (arquivamento). Sem a chave, manifestos antigos ficam incomparáveis. */
function destroyKey({ keysDir, task }) {
    fs.rmSync(keyPath(keysDir, task), { force: true });
}

const SAFE_ID = /^[A-Za-z0-9._-]+$/;

/**
 * Grava o manifesto completo (com caminhos) só em diretório ignorado pelo git do checkout
 * principal (C-A-06); senão não grava nada e devolve null.
 */
function storeManifest(manifestsDir, task, attemptId, phase, manifest, { checkoutRoot, env = process.env } = {}) {
    if (phase !== 'baseline' && phase !== 'post') throw new Error('MANIFEST_PHASE_INVALID');
    if (!SAFE_ID.test(String(task)) || !SAFE_ID.test(String(attemptId))) throw new Error('MANIFEST_ID_INVALID');
    const dir = path.join(manifestsDir, String(task));
    const file = path.join(dir, `${attemptId}.${phase}.json`);
    if (!checkoutRoot || !isIgnored(checkoutRoot, file, { env })) return null;
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(manifest)}\n`, { mode: 0o600 });
    fs.renameSync(tmp, file);
    return file;
}

function readManifest(manifestsDir, task, attemptId, phase) {
    if (!SAFE_ID.test(String(task)) || !SAFE_ID.test(String(attemptId)) || (phase !== 'baseline' && phase !== 'post')) return null;
    try {
        return JSON.parse(fs.readFileSync(path.join(manifestsDir, String(task), `${attemptId}.${phase}.json`), 'utf8'));
    } catch {
        return null;
    }
}

/**
 * SCOPE_CHANGED (replan): recalcula o manifesto corrente no escopo ANTIGO e compara com o
 * último post. Igual → pode reancorar no escopo novo; diferente/UNKNOWN → não reancora.
 */
function scopeChangedCheck({ worktree, key, previousPost, oldScopePaths = [], watchGlobs = [], limits, env = process.env }) {
    const now = summary(observe({ worktree, key, scopePaths: oldScopePaths, watchGlobs, limits, env }));
    const equal = Boolean(previousPost && previousPost.completeness === 'COMPLETE' && now.completeness === 'COMPLETE' && previousPost.digest === now.digest);
    return { old_scope_equal: equal, now };
}

// ---------------------------------------------------------------------------------
// Encadeamento (B4): baseline de todo Attempt manifestado == post do imediatamente anterior,
// salvo as reancoragens, sempre explícitas e registradas.

const ANCHORS = new Set(['RUN_START', 'SCOPE_CHANGED', 'HUMAN_UNBLOCK', 'HUMAN_RESUME']);

/**
 * @param {{ previousPost: object|null, baseline: object, anchor?: { reason: string, by?: string|null,
 *   old_scope_equal?: boolean } | null }} input  (previousPost/baseline = summary())
 * @returns {{ ok: boolean, reason: string, anchor: object|null }}
 */
function chainCheck({ previousPost, baseline, anchor = null, at = new Date().toISOString() }) {
    if (anchor) {
        if (!ANCHORS.has(anchor.reason)) return { ok: false, reason: 'ANCHOR_INVALID', anchor: null };
        if (baseline?.completeness !== 'COMPLETE') return { ok: false, reason: 'BASELINE_UNKNOWN', anchor: null };
        if (anchor.reason === 'RUN_START') {
            return previousPost == null
                ? { ok: true, reason: 'RUN_START', anchor: { reason: 'RUN_START', by: null, at } }
                : { ok: false, reason: 'RUN_START_WITH_PREVIOUS', anchor: null };
        }
        if (anchor.reason === 'SCOPE_CHANGED') {
            return anchor.old_scope_equal === true
                ? { ok: true, reason: 'SCOPE_CHANGED', anchor: { reason: 'SCOPE_CHANGED', by: null, at } }
                : { ok: false, reason: 'SCOPE_CHANGED_WITH_MUTATION', anchor: null };
        }
        // HUMAN_UNBLOCK / HUMAN_RESUME: só com o humano registrado.
        if (typeof anchor.by !== 'string' || !anchor.by.trim()) return { ok: false, reason: 'ANCHOR_WITHOUT_HUMAN', anchor: null };
        return { ok: true, reason: anchor.reason, anchor: { reason: anchor.reason, by: anchor.by.trim(), at } };
    }
    if (previousPost == null) return { ok: false, reason: 'PREVIOUS_POST_ABSENT', anchor: null };
    if (previousPost.completeness !== 'COMPLETE') return { ok: false, reason: 'PREVIOUS_POST_UNKNOWN', anchor: null };
    if (baseline?.completeness !== 'COMPLETE') return { ok: false, reason: 'BASELINE_UNKNOWN', anchor: null };
    if (previousPost.digest !== baseline.digest) return { ok: false, reason: 'CHANGED_BETWEEN_ATTEMPTS', anchor: null };
    return { ok: true, reason: 'CHAINED', anchor: null };
}

module.exports = {
    COMPONENTS,
    DEFAULT_LIMITS,
    ANCHORS,
    observe,
    summary,
    compare,
    chainCheck,
    ensureKey,
    destroyKey,
    keyPath,
    storeManifest,
    readManifest,
    scopeChangedCheck,
    _parseStatus: parseStatus,
};
