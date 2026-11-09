// Ligações da Run decomposta no watcher e nos caminhos de saída (PRI-311 / PRI-287 S5.2a;
// adendo tasks/pri-287-s5/SPEC-s5.2.md v2.1, H0–H6). Sem engine novo: funções chamadas pelo
// despacho do watcher, por releaseLease (--follow) e pelo wrapper destacado
// (node-lease.js release). O DOM-06 (dom06-attempt.js) continua o escritor do Attempt e o
// state-writer o do state.json. Este módulo lê o workspace (workspace-manifest.js), decide, e
// só grava fora do state.json e do Attempt: os manifestos locais (fora do worktree) e, na
// varredura, apaga a chave e os manifestos da task sem Run (dono de exclusão, ownership.yaml).
//
// Regras:
// - H0: baseline no despacho de Attempt com `role`, no escopo da plan_version vigente. O
//   arquivo local (fora do worktree) guarda o escopo; o Attempt guarda só o resumo e
//   scope_hmac = HMAC(chave da Run, escopo canônico).
// - H1: exitContext monta { manifestPost, currentPlanVersion } com o escopo do baseline,
//   conferido pelo scope_hmac (SCOPE_TAMPERED). Limite declarado: a chave é legível pelo
//   agente, então isso pega alteração acidental, não adulteração deliberada.
// - H2: cauda do log do nó a partir de logOffset no modo destacado (best-effort).
// - H6: decisão da cadeia no despacho e do `blocked` a partir do acceptance gravado.
// - H5: varredura da chave/manifestos só quando a task não tem Run em nenhuma raiz.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const manifest = require('./workspace-manifest');
const dom06 = require('./dom06-attempt');

const KEYS_REL = path.join('memory', 'runs', '_dom06-keys');
const MANIFESTS_REL = path.join('memory', 'runs', '_dom06-manifests');

/** Diretórios do orquestrador no checkout principal (fora do cwd do agente). */
function manifestPaths(checkoutRoot) {
    const root = path.resolve(checkoutRoot);
    return { checkoutRoot: root, keysDir: path.join(root, KEYS_REL), manifestsDir: path.join(root, MANIFESTS_REL) };
}

/** Inverso de manifestPaths: só a partir do diretório de manifestos que vai no lease. */
function pathsFromManifestsDir(manifestsDir) {
    const abs = path.resolve(manifestsDir);
    if (!abs.endsWith(path.sep + MANIFESTS_REL)) return null;
    return manifestPaths(abs.slice(0, abs.length - MANIFESTS_REL.length - 1));
}

/** Worktree do ticket a partir do diretório da Run (<worktree>/memory/runs/<task>). */
function worktreeOfRunDir(runDir) {
    const abs = path.resolve(runDir);
    const runs = path.dirname(abs);
    if (path.basename(runs) !== 'runs' || path.basename(path.dirname(runs)) !== 'memory') return null;
    return path.dirname(path.dirname(runs));
}

function canonicalScope({ scopePaths = [], watchGlobs = [], limits = {} } = {}) {
    return JSON.stringify({
        scope_paths: [...new Set(scopePaths)].sort(),
        watch_globs: [...new Set(watchGlobs)].sort(),
        limits: { maxEntries: limits.maxEntries ?? null, maxBytes: limits.maxBytes ?? null },
    });
}

function scopeHmac(key, scope) {
    return crypto.createHmac('sha256', key).update(canonicalScope(scope)).digest('hex');
}

/**
 * H0, fase 1 (antes do Attempt): observa o baseline. Devolve o que entra no Attempt
 * (`workspace_baseline` = resumo, `scope_hmac`) e o que fica local (manifesto + escopo).
 */
function observeBaseline({ checkoutRoot, task, worktree, scopePaths = [], watchGlobs = [], limits = {}, env = process.env }) {
    const { keysDir } = manifestPaths(checkoutRoot);
    const scope = { scopePaths, watchGlobs, limits };
    const k = manifest.ensureKey({ keysDir, task, checkoutRoot, env });
    if (!k.ok) {
        const m = manifest.observe({ worktree, key: null, keyCause: k.cause });
        return { summary: manifest.summary(m), scope_hmac: null, local: null };
    }
    const m = manifest.observe({ worktree, key: k.key, scopePaths, watchGlobs, limits, env });
    return {
        summary: manifest.summary(m),
        scope_hmac: scopeHmac(k.key, scope),
        local: { ...m, scope: JSON.parse(canonicalScope(scope)) },
    };
}

/** H0, fase 2 (depois do Attempt): grava o manifesto local do baseline com o escopo. */
function storeBaseline({ checkoutRoot, task, attemptId, observed, env = process.env }) {
    if (!observed || !observed.local) return null;
    const { manifestsDir } = manifestPaths(checkoutRoot);
    return manifest.storeManifest(manifestsDir, task, attemptId, 'baseline', observed.local, { checkoutRoot, env });
}

function readKey(keysDir, task) {
    try {
        const key = fs.readFileSync(manifest.keyPath(keysDir, task));
        return key.length >= 32 ? { ok: true, key } : { ok: false, cause: 'KEY_MISSING' };
    } catch {
        return { ok: false, cause: 'KEY_MISSING' };
    }
}

function unknown(cause) {
    return { completeness: 'UNKNOWN', cause, digest: null, counts: null };
}

/**
 * H1: contexto da saída de um Attempt com `role`. `planVersion` vem do mesmo snapshot do
 * release (node-lease.releaseNodeWithContext). Nunca lança; falha → post UNKNOWN com causa.
 * @returns {{ manifestPost: object, currentPlanVersion: string|null }}
 */
/**
 * Manifesto corrente no escopo do baseline daquele Attempt, conferido pelo scope_hmac.
 * `phase` = 'post' grava o arquivo local do post. Nunca lança.
 */
function observeInBaselineScope({ paths, task, attempt, worktree, phase = null, env = process.env }) {
    try {
        const base = manifest.readManifest(paths.manifestsDir, task, attempt.attempt_id, 'baseline');
        if (!base || !base.scope) return unknown('BASELINE_MISSING');
        // Só leitura da chave (nunca cria): chave apagada sob Run viva = KEY_MISSING, não uma
        // chave nova que mascararia a troca (fail-closed).
        const k = readKey(paths.keysDir, task);
        if (!k.ok) return unknown(k.cause);
        const scope = { scopePaths: base.scope.scope_paths || [], watchGlobs: base.scope.watch_globs || [], limits: base.scope.limits || {} };
        if (!attempt.scope_hmac || scopeHmac(k.key, scope) !== attempt.scope_hmac) return unknown('SCOPE_TAMPERED');
        const limits = {};
        if (Number.isSafeInteger(scope.limits.maxEntries)) limits.maxEntries = scope.limits.maxEntries;
        if (Number.isSafeInteger(scope.limits.maxBytes)) limits.maxBytes = scope.limits.maxBytes;
        const now = manifest.observe({ worktree, key: k.key, scopePaths: scope.scopePaths, watchGlobs: scope.watchGlobs, limits, env });
        if (phase === 'post') {
            try {
                manifest.storeManifest(paths.manifestsDir, task, attempt.attempt_id, 'post', { ...now, scope: base.scope }, { checkoutRoot: paths.checkoutRoot, env });
            } catch { /* o arquivo local é auxiliar; o resumo vai no Attempt */ }
        }
        return now;
    } catch {
        return unknown('MANIFEST_READ_FAILED');
    }
}

function exitContext({ lease, planVersion = null, env = process.env } = {}) {
    const currentPlanVersion = typeof planVersion === 'string' && planVersion ? planVersion : null;
    try {
        if (!lease || !lease.dom06ManifestsDir || !lease.task || !lease.dom06AttemptFile) {
            return { manifestPost: unknown('MANIFESTS_DIR_MISSING'), currentPlanVersion };
        }
        const paths = pathsFromManifestsDir(lease.dom06ManifestsDir);
        const worktree = worktreeOfRunDir(lease.dir);
        if (!paths || !worktree) return { manifestPost: unknown('EXIT_PATHS_INVALID'), currentPlanVersion };
        const attempt = dom06.readAttempt(lease.dom06AttemptFile);
        const post = observeInBaselineScope({ paths, task: lease.task, attempt, worktree, phase: 'post', env });
        return { manifestPost: post, currentPlanVersion };
    } catch {
        return { manifestPost: unknown('EXIT_CONTEXT_FAILED'), currentPlanVersion };
    }
}

/**
 * H4: fecha o Attempt com papel deixado STARTED por um nó órfão (último por seq do nó), com
 * o manifesto corrente no escopo do baseline. `orphanReason` = 'agent_dead' | 'timeout'.
 * @returns {object|null} acceptance gravado, ou null se não havia Attempt com papel aberto
 */
function closeRoleOrphan({ runDir, node, task, checkoutRoot, orphanReason, env = process.env }) {
    const open = manifestedAttempts(runDir).filter(a => a.node === node);
    const last = open.length ? open[open.length - 1] : null;
    if (!last || last.result !== 'STARTED' || last.acceptance) return null;
    const worktree = worktreeOfRunDir(runDir);
    const manifestNow = worktree
        ? observeInBaselineScope({ paths: manifestPaths(checkoutRoot), task, attempt: last, worktree, env })
        : unknown('EXIT_PATHS_INVALID');
    return dom06.closeOrphan(path.join(runDir, 'dom06', 'attempts', `${last.attempt_id}.json`), { manifestNow, orphanReason });
}

/**
 * H2 (modo destacado, best-effort): texto do log do ticket a partir de `offset` (tamanho no
 * spawn). Espera o tamanho parar de mudar (o filtro sanitize-log escreve em processo
 * próprio) por no máximo `waitMs`. Falha → '' (causa indeterminada = AGENT_FAILURE).
 */
function readLogFrom(logPath, offset, { waitMs = 3000, stableMs = 300, maxBytes = 2 * 1024 * 1024 } = {}) {
    try {
        if (!logPath || !Number.isSafeInteger(offset) || offset < 0) return '';
        const sleep = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
        const deadline = Date.now() + waitMs;
        let last = fs.statSync(logPath).size;
        let stableSince = Date.now();
        while (Date.now() < deadline && Date.now() - stableSince < stableMs) {
            sleep(50);
            const size = fs.statSync(logPath).size;
            if (size !== last) { last = size; stableSince = Date.now(); }
        }
        if (last <= offset) return '';
        const start = Math.max(offset, last - maxBytes);
        const fd = fs.openSync(logPath, 'r');
        try {
            const buf = Buffer.alloc(last - start);
            fs.readSync(fd, buf, 0, buf.length, start);
            return buf.toString('utf8');
        } finally {
            fs.closeSync(fd);
        }
    } catch {
        return '';
    }
}

// ---------------------------------------------------------------------------------
// H6: cadeia no despacho e `blocked` a partir do acceptance

/** Attempts com papel da Run, por seq (o "imediatamente anterior" é o último daqui). */
function manifestedAttempts(runDir) {
    return dom06.listAttempts(runDir).filter(a => a.role && a.started).sort((a, b) => {
        const sa = Number.isInteger(a.seq) ? a.seq : 0;
        const sb = Number.isInteger(b.seq) ? b.seq : 0;
        return sa !== sb ? sa - sb : String(a.created_at).localeCompare(String(b.created_at));
    });
}

/**
 * Reancoragem pedida pelo estado da Run (B4): só as quatro da SPEC, sempre explícitas.
 * - RUN_START: nenhum Attempt manifestado antes;
 * - SCOPE_CHANGED: a plan_version vigente difere da do anterior (`old_scope_equal` vem de
 *   scopeChangedCheck, calculado pelo chamador no escopo antigo);
 * - HUMAN_UNBLOCK: marcador `unblocked` posterior ao anterior (by = registro);
 * - HUMAN_RESUME: retomada de session_limit (`resume_session`) ou aprovação de SPEC_CHANGE /
 *   autorização (`human_resume`) posterior ao anterior (by = registro).
 * @returns {object|null} anchor para chainCheck
 */
// Registros humanos de retomada que não passam pela regra do manifesto (B4 HUMAN_RESUME):
// retomada de session_limit pelo dashboard (`resumed_at`, operação resume_session) e
// aprovação de SPEC_CHANGE ou de autorização (eventos do state). Devolve o mais recente.
const RESUME_EVENTS = new Set(['spec_change_approved', 'authorization_approved', 'authorization_manual']);
function humanResumeRecord(state = {}) {
    const found = [];
    if (typeof state.resumed_at === 'string') found.push({ at: state.resumed_at, by: 'dashboard:resume-session' });
    for (const e of Array.isArray(state.events) ? state.events : []) {
        if (e && RESUME_EVENTS.has(e.type) && typeof e.at === 'string') found.push({ at: e.at, by: `human:${e.type}` });
    }
    found.sort((a, b) => a.at.localeCompare(b.at));
    return found.length ? found[found.length - 1] : null;
}

function anchorFor({ previous, state = {}, planVersion = null, oldScopeEqual = null }) {
    if (!previous) return { reason: 'RUN_START' };
    const prevAt = String(previous.acceptance?.decided_at || previous.created_at || '');
    const later = at => typeof at === 'string' && at > prevAt;
    // Ato humano posterior ao anterior vale primeiro: é continuação autorizada e registrada.
    const resume = humanResumeRecord(state);
    if (resume && later(resume.at)) return { reason: 'HUMAN_RESUME', by: resume.by };
    const unblocked = state.unblocked;
    if (unblocked && later(unblocked.at)) return { reason: 'HUMAN_UNBLOCK', by: unblocked.by ?? null };
    if (planVersion && previous.plan_version && previous.plan_version !== planVersion) {
        return { reason: 'SCOPE_CHANGED', old_scope_equal: oldScopeEqual === true };
    }
    return null;
}

/**
 * Cadeia do despacho (H6): baseline do novo Attempt contra o post do imediatamente anterior.
 * @returns {{ ok: boolean, reason: string, anchor: object|null, previous_attempt_id: string|null }}
 */
function dispatchChain({ runDir, baseline, state = {}, planVersion = null, oldScopeEqual = null, at = new Date().toISOString() }) {
    const list = manifestedAttempts(runDir);
    const previous = list.length ? list[list.length - 1] : null;
    const anchor = anchorFor({ previous, state, planVersion, oldScopeEqual });
    const previousPost = previous ? (previous.workspace && previous.workspace.post) || null : null;
    // Anterior sem post gravado (saída não fechada) = UNKNOWN, nunca início de cadeia.
    const post = previous && !previousPost ? { completeness: 'UNKNOWN', digest: null } : previousPost;
    const r = manifest.chainCheck({ previousPost: post, baseline, anchor, at });
    return { ...r, previous_attempt_id: previous ? previous.attempt_id : null };
}

/**
 * `blocked` pendente a partir do acceptance (H6). Só com a Run em in_progress (nunca
 * sobrescreve session_limit nem status gravado pelo comando) e só uma vez por Attempt
 * (`decomposition_block_applied`), para o desbloqueio humano não ser desfeito no tick seguinte.
 * @returns {{ attempt_id: string, reason: string, node: string }|null}
 */
function pendingBlock(runDir, state) {
    if (!state || state.status !== 'in_progress') return null;
    const list = manifestedAttempts(runDir);
    const last = list.length ? list[list.length - 1] : null;
    if (!last || !last.acceptance || last.acceptance.block !== true) return null;
    if (state.decomposition_block_applied && state.decomposition_block_applied.attempt_id === last.attempt_id) return null;
    // Ato humano posterior ao aceite (retomada de session_limit, aprovação, desbloqueio)
    // prevalece: a próxima cadeia reancora por HUMAN_RESUME/HUMAN_UNBLOCK (C-O-01/C-A-01).
    const decided = String(last.acceptance.decided_at || '');
    const resume = humanResumeRecord(state);
    if (resume && resume.at > decided) return null;
    if (state.unblocked && typeof state.unblocked.at === 'string' && state.unblocked.at > decided) return null;
    return { attempt_id: last.attempt_id, reason: last.acceptance.reason || 'UNKNOWN', node: last.node };
}

/**
 * H0 + H6 no despacho de um Attempt com papel (chamado pelo watcher na Run decomposta):
 * observa o baseline no escopo da plan_version vigente, confere a cadeia contra o Attempt
 * manifestado imediatamente anterior (com a reancoragem que o estado pedir) e só então
 * cria o Attempt pelo DOM-06 (prepareDispatch) e grava o manifesto local do baseline.
 * Cadeia quebrada → nenhum Attempt; o chamador aplica `blocked` (writer existente).
 * @returns {{ ok: false, reason: string, baseline: object } |
 *   { ok: true, admission: object, baseline: object, anchor: object|null, stored: string|null }}
 */
function prepareRoleDispatch({ runDir, checkoutRoot, task, worktree, decomposition, scopePaths = [], watchGlobs = [], limits = {},
    state = {}, dispatch = {}, env = process.env, at = new Date().toISOString() }) {
    const observed = observeBaseline({ checkoutRoot, task, worktree, scopePaths, watchGlobs, limits, env });
    const list = manifestedAttempts(runDir);
    const previous = list.length ? list[list.length - 1] : null;
    let oldScopeEqual = null;
    if (previous && previous.plan_version && decomposition.plan_version && previous.plan_version !== decomposition.plan_version) {
        // SCOPE_CHANGED: manifesto corrente no escopo ANTIGO (o do baseline do anterior) igual
        // ao último post → pode reancorar no escopo novo.
        const now = observeInBaselineScope({ paths: manifestPaths(checkoutRoot), task, attempt: previous, worktree, env });
        const prevPost = previous.workspace && previous.workspace.post;
        oldScopeEqual = Boolean(prevPost && prevPost.completeness === 'COMPLETE' && now.completeness === 'COMPLETE' && prevPost.digest === now.digest);
    }
    const chain = dispatchChain({ runDir, baseline: observed.summary, state, planVersion: decomposition.plan_version, oldScopeEqual, at });
    if (!chain.ok) return { ok: false, reason: chain.reason, baseline: observed.summary };
    const admission = dom06.prepareDispatch({
        ...dispatch,
        runDir,
        decomposition: { ...decomposition, workspace_baseline: observed.summary, scope_hmac: observed.scope_hmac, chain_anchor: chain.anchor },
    });
    let stored = null;
    let storeError = null;
    if (admission.dispatch) {
        // Falha ao gravar o baseline local não derruba o despacho: a saída verá BASELINE_MISSING
        // (post UNKNOWN → não aceito, blocked), fail-closed (C-O-06).
        try { stored = storeBaseline({ checkoutRoot, task, attemptId: admission.attempt.attempt_id, observed, env }); } catch (e) { storeError = e.message; }
    }
    return { ok: true, admission, baseline: observed.summary, anchor: chain.anchor, stored, store_error: storeError };
}

// ---------------------------------------------------------------------------------
// H5: varredura de chave e manifestos

/**
 * A task tem diretório de Run em algum `memory/runs` (ou no `_archive` dele)? Rotação para
 * memory/archive/ não conta (não revive Run: consumeQaRetrySignals só olha runs e _archive).
 */
function taskHasRun(task, runsDirs) {
    for (const runs of runsDirs) {
        for (const base of [runs, path.join(runs, '_archive')]) {
            if (fs.existsSync(path.join(base, task))) return true;
        }
    }
    return false;
}

/**
 * Apaga chave e manifestos das tasks sem Run em nenhuma raiz. Idempotente. `filter` =
 * taskScopeFilter do watcher (task fora do escopo nunca é tocada).
 * @returns {string[]} tasks varridas
 */
function sweepKeys({ checkoutRoot, runsDirs, filter = null }) {
    const { keysDir, manifestsDir } = manifestPaths(checkoutRoot);
    const tasks = new Set();
    try {
        for (const f of fs.readdirSync(keysDir)) if (f.endsWith('.key')) tasks.add(f.slice(0, -4));
    } catch { /* sem chaves */ }
    try {
        for (const d of fs.readdirSync(manifestsDir, { withFileTypes: true })) if (d.isDirectory()) tasks.add(d.name);
    } catch { /* sem manifestos */ }
    const swept = [];
    for (const task of tasks) {
        if (!/^[A-Za-z0-9._-]+$/.test(task)) continue;
        if (filter && !filter(task)) continue;
        if (taskHasRun(task, runsDirs)) continue;
        manifest.destroyKey({ keysDir, task });
        fs.rmSync(path.join(manifestsDir, task), { recursive: true, force: true });
        swept.push(task);
    }
    return swept;
}

module.exports = {
    manifestPaths, pathsFromManifestsDir, worktreeOfRunDir, canonicalScope, scopeHmac,
    observeBaseline, storeBaseline, observeInBaselineScope, exitContext, closeRoleOrphan, readLogFrom,
    manifestedAttempts, humanResumeRecord, anchorFor, dispatchChain, prepareRoleDispatch, pendingBlock,
    taskHasRun, sweepKeys,
};
