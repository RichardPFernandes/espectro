#!/usr/bin/env node
// Único módulo autorizado a escrever memory/runs/<task-id>/state.json. Watcher,
// dashboard, libs e agentes (pela CLI no fim do arquivo) passam por aqui — nunca por
// fs.writeFileSync direto. Mapa de operações e garantias: docs/concurrency-map.md.
//
// Escrita atômica (fs nativo; macOS/APFS, tmp no MESMO diretório do state.json):
//   1. JSON.stringify  2. state.json.<pid>.<seq>.tmp (O_EXCL)  3. fsync do tmp
//   4. rename(tmp, state.json) — atômico no mesmo filesystem  5. fsync do diretório.
// Crash antes do 4: o state.json antigo continua íntegro e o tmp órfão é descartado no
// startup do watcher (cleanupOrphans) — nunca aplicado como estado válido.
//
// Lock por run (state.json.lock, publicado já com "pid ts" por link(2) — atômico e
// exclusivo —, reentrante no processo): ler → validar → gravar é uma seção crítica entre
// processos (watcher, dashboard, agentes, CLIs). Quebra de lock abandonado serializada
// por state.json.lock.break.
//
// state_version: incrementa SÓ quando um campo crítico (CRITICAL_FIELDS) muda — quem
// decide é o diff entre o disco e o estado novo, aqui dentro. Nenhum caller mexe nele.
// Validação de expectativas (CAS): scripts/cas.js.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const cas = require('./cas');

const STATE_FILE = 'state.json';
const LOCK_TIMEOUT_MS = 5000;
const LOCK_STALE_MS = 30_000;
const ORPHAN_TMP_MAX_AGE_MS = 10 * 60 * 1000;
const RENAME_RETRIES = 5; // EPERM/EBUSY: Windows com o arquivo aberto por outro processo
const PHASES = ['plan', 'implement', 'review', 'evidence', 'verify'];

// Campos que decidem despacho/contrato. Mudança em qualquer um = state_version + 1.
const CRITICAL_FIELDS = [
    'node', 'status', 'execution_id', 'spec_hash', 'spec.hash', 'spec.version',
    ...PHASES.map(p => `artifact_validity.${p}.validity.status`),
    'retries',
];

const sleepCell = new Int32Array(new SharedArrayBuffer(4));
function sleepSync(ms) {
    Atomics.wait(sleepCell, 0, 0, ms);
}

// Ganchos só para teste (state-concurrency.test.js): beforeRename roda entre o fsync do
// tmp e o rename; beforeLockLink antes de publicar o lock; insideBreak com o .break na mão.
const _testHooks = { beforeRename: null, beforeLockLink: null, insideBreak: null };

// ── Campos críticos ──────────────────────────────────────────────────────────────

function get(obj, dotted) {
    return dotted.split('.').reduce((o, k) => (o && typeof o === 'object' ? o[k] : undefined), obj);
}

// retries: {review: 0} e {} são o mesmo estado (zero = sem retry).
function normRetries(r) {
    if (!r || typeof r !== 'object' || Array.isArray(r)) return null;
    const keys = Object.keys(r).filter(k => Number(r[k]) > 0).sort();
    return keys.length ? keys.map(k => `${k}=${Number(r[k])}`).join(',') : null;
}

function criticalSnapshot(state) {
    const out = {};
    for (const f of CRITICAL_FIELDS) {
        const v = f === 'retries' ? normRetries(state?.retries) : get(state, f);
        out[f] = v === undefined ? null : v;
    }
    return out;
}

function criticalFingerprint(state) {
    return crypto.createHash('sha256').update(JSON.stringify(criticalSnapshot(state))).digest('hex').slice(0, 16);
}

function changedCriticalFields(a, b) {
    const sa = criticalSnapshot(a);
    const sb = criticalSnapshot(b);
    return CRITICAL_FIELDS.filter(f => JSON.stringify(sa[f]) !== JSON.stringify(sb[f]));
}

function newExecutionId() {
    return crypto.randomUUID();
}

// ── Caminhos e leitura ───────────────────────────────────────────────────────────

/** Aceita o diretório do run ou o caminho do state.json. */
function statePath(dirOrFile) {
    const p = String(dirOrFile);
    return path.basename(p) === STATE_FILE ? p : path.join(p, STATE_FILE);
}

const PARSE_RETRIES = 5;

/**
 * Estado do disco, ou null (ausente/ilegível). JSON truncado costuma ser um escritor
 * fora do state-writer no meio de um writeFileSync (trunca, depois escreve): re-tenta
 * algumas vezes antes de concluir que está ilegível.
 */
function readFile(file) {
    for (let i = 0; ; i++) {
        let raw;
        try { raw = fs.readFileSync(file, 'utf8'); } catch { return null; }
        try {
            const s = JSON.parse(raw);
            return s && typeof s === 'object' && !Array.isArray(s) ? s : null;
        } catch {
            if (i >= PARSE_RETRIES) return null;
            sleepSync(10);
        }
    }
}

function read(dirOrFile) {
    return readFile(statePath(dirOrFile));
}

// Identidade do arquivo lido: escritor fora do lock (agente com Edit, humano) muda o
// token entre a leitura e o rename — a escrita é refeita sobre o disco novo.
function tokenOf(file) {
    try {
        const st = fs.statSync(file, { bigint: true });
        return `${st.ino}:${st.size}:${st.mtimeNs}`;
    } catch {
        return 'missing';
    }
}

function readWithToken(file) {
    const token = tokenOf(file);
    return { state: readFile(file), token };
}

const EXTERNAL_WRITE = 'STATE_EXTERNAL_WRITE';
const EXTERNAL_RETRIES = 3;

function externalWriteError(file) {
    const err = new Error(`state-writer: ${file} alterado fora do state-writer durante a escrita`);
    err.code = EXTERNAL_WRITE;
    return err;
}

// Refaz `attempt` (ler → calcular → gravar) quando um escritor fora do lock mexeu no
// arquivo no meio. Esgotou: propaga o erro.
function retryExternal(attempt) {
    for (let i = 1; ; i++) {
        try { return attempt(); } catch (e) {
            if (e.code !== EXTERNAL_WRITE || i >= EXTERNAL_RETRIES) throw e;
        }
    }
}

// ── Lock ─────────────────────────────────────────────────────────────────────────

const held = new Map(); // lockPath -> profundidade (reentrância no mesmo processo)

function pidAlive(pid) {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    if (pid === process.pid) return true;
    try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

function lockOwner(lockPath) {
    let raw;
    try { raw = fs.readFileSync(lockPath, 'utf8').trim(); } catch { return null; }
    const [pid, at] = raw.split(/\s+/);
    const owner = { pid: Number(pid), at: Number(at), raw };
    // Vazio/corrompido: só de versão antiga (openSync + write) ou edição manual — o lock
    // de agora nasce com conteúdo (publishLockFile).
    if (!Number.isInteger(owner.pid) || owner.pid <= 0 || !Number.isFinite(owner.at)) owner.unknown = true;
    return owner;
}

let lockSeq = 0;

/**
 * Cria `lockPath` já com "pid ts": escreve num tmp exclusivo, fsync e publica com
 * link(2) — atômico e EEXIST se o lock existir (como O_EXCL), mas sem o instante em que
 * o lock existe vazio (openSync('wx') + write deixava outro processo ler pid 0 e quebrar
 * o lock do dono vivo). Devolve false se o lock já existe.
 */
function publishLockFile(lockPath) {
    const tmp = `${lockPath}.${process.pid}.${++lockSeq}.tmp`;
    const fd = fs.openSync(tmp, 'wx', 0o644);
    try {
        try { fs.writeSync(fd, `${process.pid} ${Date.now()}\n`); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
        if (_testHooks.beforeLockLink) _testHooks.beforeLockLink(lockPath);
        fs.linkSync(tmp, lockPath);
        return true;
    } catch (e) {
        if (e.code === 'EEXIST') return false;
        throw e;
    } finally {
        try { fs.unlinkSync(tmp); } catch { /* já removido */ }
    }
}

// Lock abandonado: dono morto (ou este processo, fora de `held`: cópia de pasta de run
// que levou o lock junto). Dono vivo nunca perde o lock por idade — um processo lento que
// voltasse gravaria junto com o novo dono; STATE_LOCK_TIMEOUT diz quem segura.
// Conteúdo ilegível (versão antiga/edição manual): abandonado só pelo mtime.
function isStale(owner, lockPath, now) {
    if (owner.unknown) {
        try { return now - fs.statSync(lockPath).mtimeMs > LOCK_STALE_MS; } catch { return false; }
    }
    return owner.pid === process.pid ? !held.has(lockPath) : !pidAlive(owner.pid);
}

/**
 * Remove o lock se abandonado. Reler + unlink não é atômico: dois processos quebrando o
 * mesmo lock morto podiam apagar o lock novo que o primeiro acabou de criar. Por isso a
 * quebra é serializada por `<lock>.break` (mesma criação por link): dentro dele, o lock
 * de dono morto só muda por outra quebra — que está esperando —, então reler e apagar é
 * seguro. O próprio .break só fica órfão se o processo morrer no meio de uma quebra
 * (microssegundos); é descartado depois de LOCK_STALE_MS com dono morto.
 */
function breakIfStale(lockPath, now = Date.now()) {
    const owner = lockOwner(lockPath);
    if (!owner || !isStale(owner, lockPath, now)) return false;
    const breaker = `${lockPath}.break`;
    if (!publishLockFile(breaker)) {
        const b = lockOwner(breaker);
        if (b && (b.unknown || !pidAlive(b.pid)) && isOld(breaker, now) && lockOwner(breaker)?.raw === b.raw) {
            try { fs.unlinkSync(breaker); } catch { /* sumiu */ }
        }
        return false; // outro processo está quebrando; a próxima volta do acquire reavalia
    }
    try {
        if (_testHooks.insideBreak) _testHooks.insideBreak(lockPath);
        const again = lockOwner(lockPath);
        if (!again || again.raw !== owner.raw || !isStale(again, lockPath, Date.now())) return false;
        try { fs.unlinkSync(lockPath); return true; } catch { return false; }
    } finally {
        try { fs.unlinkSync(breaker); } catch { /* sumiu */ }
    }
}

function isOld(file, now) {
    try { return now - fs.statSync(file).mtimeMs > LOCK_STALE_MS; } catch { return false; }
}

/** Run movido/arquivado enquanto esperava o lock (a pasta não existe mais). */
const RUN_GONE = 'STATE_RUN_GONE';
function runGoneError(file) {
    const err = new Error(`state-writer: run de ${file} não existe mais (arquivado/movido)`);
    err.code = RUN_GONE;
    return err;
}

/** Pega o lock do state.json (bloqueante, até LOCK_TIMEOUT_MS). Devolve o unlock. */
function acquireLock(file, { timeoutMs = LOCK_TIMEOUT_MS } = {}) {
    const lockPath = `${file}.lock`;
    if (held.has(lockPath)) {
        held.set(lockPath, held.get(lockPath) + 1);
        return () => releaseLock(lockPath);
    }
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        let created;
        try {
            created = publishLockFile(lockPath);
        } catch (e) {
            // ENOENT só com a pasta do run ausente (archive renomeou enquanto esperávamos).
            if (e.code === 'ENOENT' && !fs.existsSync(path.dirname(lockPath))) throw runGoneError(file);
            throw e;
        }
        if (created) {
            held.set(lockPath, 1);
            return () => releaseLock(lockPath);
        }
        if (breakIfStale(lockPath)) continue;
        if (Date.now() > deadline) {
            const owner = lockOwner(lockPath);
            const who = owner && !owner.unknown ? ` (pid ${owner.pid}, há ${Math.round((Date.now() - owner.at) / 1000)}s)` : '';
            const err = new Error(`state-writer: lock de ${file} ocupado há mais de ${timeoutMs}ms${who}`);
            err.code = 'STATE_LOCK_TIMEOUT';
            throw err;
        }
        sleepSync(5 + Math.floor(Math.random() * 15));
    }
}

function releaseLock(lockPath) {
    const depth = held.get(lockPath);
    if (!depth) return;
    if (depth > 1) { held.set(lockPath, depth - 1); return; }
    held.delete(lockPath);
    try { fs.unlinkSync(lockPath); } catch { /* run movido/apagado com o lock dentro */ }
}

function withLock(dirOrFile, fn) {
    const unlock = acquireLock(statePath(dirOrFile));
    try { return fn(); } finally { unlock(); }
}

// ── Escrita atômica ──────────────────────────────────────────────────────────────

let seq = 0;

function renameWithRetry(from, to) {
    for (let i = 0; ; i++) {
        try { return fs.renameSync(from, to); } catch (e) {
            if (!['EPERM', 'EBUSY', 'EACCES'].includes(e.code) || i >= RENAME_RETRIES) throw e;
            sleepSync(10 * (i + 1));
        }
    }
}

function fsyncDir(dir) {
    let fd = null;
    try { fd = fs.openSync(dir, 'r'); fs.fsyncSync(fd); } catch { /* Windows: diretório não abre — best effort */ } finally {
        if (fd != null) try { fs.closeSync(fd); } catch { /* idem */ }
    }
}

function atomicWriteFile(file, content, { verify = null } = {}) {
    const tmp = `${file}.${process.pid}.${++seq}.tmp`;
    const fd = fs.openSync(tmp, 'wx', 0o644);
    try {
        fs.writeSync(fd, content);
        fs.fsyncSync(fd);
    } catch (e) {
        try { fs.closeSync(fd); } catch { /* já fechado */ }
        try { fs.unlinkSync(tmp); } catch { /* sem tmp */ }
        throw e;
    }
    fs.closeSync(fd);
    try {
        if (_testHooks.beforeRename) _testHooks.beforeRename(tmp);
        if (verify && !verify()) throw externalWriteError(file);
        renameWithRetry(tmp, file);
    } catch (e) {
        try { fs.unlinkSync(tmp); } catch { /* sem tmp */ }
        throw e;
    }
    fsyncDir(path.dirname(file));
}

/**
 * Grava `next` sobre `current` (o que estava no disco, lido DENTRO do lock). Calcula
 * state_version e critical_fingerprint e reflete os dois no objeto do caller (que pode
 * continuar usando-o como base de escritas seguintes). Só chamado com o lock na mão.
 */
function writeLocked(file, next, current, { token = null } = {}) {
    if (!next || typeof next !== 'object' || Array.isArray(next)) throw new TypeError('state-writer: estado precisa ser um objeto');
    // Edição externa pendente já conta na versão efetiva do disco; esta escrita a normaliza.
    const version = current ? cas.effectiveVersion(current) + (changedCriticalFields(current, next).length ? 1 : 0) : 1;
    const out = { ...next, state_version: Math.max(version, 1) };
    out.critical_fingerprint = criticalFingerprint(out);
    atomicWriteFile(file, JSON.stringify(out, null, 2), { verify: token ? () => tokenOf(file) === token : null });
    // Só depois do rename: re-tentativa não pode ver a versão de uma escrita descartada.
    next.state_version = out.state_version;
    next.critical_fingerprint = out.critical_fingerprint;
    return next;
}

// ── Merge de 3 vias (escrita de sistema com leitura-base conhecida) ──────────────

function isPlain(v) {
    return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function deepEqual(a, b) {
    if (a === b) return true;
    if (Array.isArray(a)) return Array.isArray(b) && a.length === b.length && a.every((x, i) => deepEqual(x, b[i]));
    if (isPlain(a)) {
        if (!isPlain(b)) return false;
        const ka = Object.keys(a).filter(k => a[k] !== undefined);
        const kb = Object.keys(b).filter(k => b[k] !== undefined);
        return ka.length === kb.length && ka.every(k => deepEqual(a[k], b[k]));
    }
    return false;
}

function isPrefix(prefix, arr) {
    return prefix.length <= arr.length && prefix.every((x, i) => deepEqual(x, arr[i]));
}

/**
 * Reaplica o que `mine` mudou desde `base` sobre `current` (o disco agora). Objetos:
 * por chave; listas que só cresceram dos dois lados (events, human_inputs...): o que o
 * disco ganhou + o que este escritor acrescentou; resto mudado dos dois lados: `mine`
 * (só campo secundário chega aqui — crítico divergente já foi recusado).
 */
function merge3(base, mine, current) {
    if (deepEqual(mine, base)) return structuredClone(current);
    if (deepEqual(current, base)) return structuredClone(mine);
    if (isPlain(base) && isPlain(mine) && isPlain(current)) {
        const out = {};
        for (const k of new Set([...Object.keys(current), ...Object.keys(mine)])) {
            const v = merge3(base[k], mine[k], current[k]);
            if (v !== undefined) out[k] = v;
        }
        return out;
    }
    // Campo que a base não tinha conta como vazio ({} / []) dos dois lados.
    if (base === undefined && isPlain(mine) && isPlain(current)) return merge3({}, mine, current);
    const b = base === undefined && Array.isArray(mine) && Array.isArray(current) ? [] : base;
    if (Array.isArray(b) && Array.isArray(mine) && Array.isArray(current) && isPrefix(b, mine) && isPrefix(b, current)) {
        return [...structuredClone(current), ...structuredClone(mine.slice(b.length))];
    }
    return mine === undefined ? undefined : structuredClone(mine);
}

/**
 * Grava o estado inteiro.
 *   - `base` (o estado como o caller o leu): disco igual à base → grava; disco andou →
 *     cas.assertRebasable recusa se outro processo mudou um campo crítico de que este
 *     escritor discorda; senão reaplica só o delta deste escritor sobre o disco fresco
 *     (merge3) e reflete o resultado no objeto do caller.
 *   - sem `base`: `next` com state_version menor que o do disco e divergente dele em
 *     campo crítico → STATE_CONFLICT (cas.assertFreshBase).
 *   - `expect`: validação CAS explícita (cas.compare) no mesmo lock.
 *   - `base` (ou `next` com state_version, isto é, lido de um run) e o run sumiu
 *     (arquivado/movido depois da leitura): STATE_CONFLICT (cas.runGoneConflict), sem
 *     recriar a pasta — escritor obsoleto não ressuscita run. Run novo nasce por init()
 *     ou write() de objeto sem state_version.
 */
function write(dirOrFile, next, { operation = 'write', actor = null, expect = null, force = false, base = null } = {}) {
    const file = statePath(dirOrFile);
    const runDir = path.dirname(file);
    const ctx = { runDir, operation, actor };
    // Objeto que veio do disco (base, ou state_version gravada) para uma pasta que não
    // existe mais = escritor obsoleto de run arquivado: recusa em vez de recriar.
    const stale = !force && (base || Number.isInteger(next?.state_version)) ? (base || next) : null;
    if (stale) {
        if (!fs.existsSync(runDir)) throw cas.runGoneConflict(stale, ctx);
    } else {
        fs.mkdirSync(runDir, { recursive: true });
    }
    const mine = base ? structuredClone(next) : null; // o que o caller quer, antes de qualquer merge
    let unlock;
    try {
        unlock = acquireLock(file);
    } catch (e) {
        if (e.code === RUN_GONE && stale) throw cas.runGoneConflict(stale, ctx);
        throw e;
    }
    try { return retryExternal(() => {
        const { state: current, token } = readWithToken(file);
        let toWrite = next;
        if (expect) cas.validate({ operation, actor, runDir, ...expect }, current);
        else if (base && !current && !force) throw cas.runGoneConflict(base, ctx);
        else if (force || !current) { /* sem base a comparar */ } else if (base) {
            if (!deepEqual(base, current)) { // disco andou desde a leitura (qualquer campo)
                cas.assertRebasable(base, mine, current, { runDir, operation, actor });
                toWrite = merge3(base, mine, current);
                for (const k of Object.keys(next)) if (!(k in toWrite)) delete next[k];
                Object.assign(next, toWrite);
                toWrite = next;
            }
        } else {
            cas.assertFreshBase(next, current, { runDir, operation, actor });
        }
        return writeLocked(file, toWrite, current, { token });
    }); } finally { unlock(); }
}

/**
 * Read-modify-write dentro do lock, sobre o disco fresco (sem base obsoleta possível).
 * `mutator(draft, current)` muta o draft, devolve um objeto novo ou cas.SKIP. Estado
 * ausente/ilegível → null sem gravar (a não ser com create: true). Run arquivado/movido
 * (antes ou enquanto esperava o lock — o /commit arquiva a pasta) também → null: é o
 * "nada a fazer" que release de lease e afins esperam. Outros erros de fs propagam.
 */
function update(dirOrFile, mutator, { operation = 'update', actor = null, expect = null, create = false } = {}) {
    const file = statePath(dirOrFile);
    if (!create && !fs.existsSync(path.dirname(file))) return null;
    let unlock;
    try {
        unlock = acquireLock(file);
    } catch (e) {
        if (e.code === RUN_GONE && !create) return null;
        throw e;
    }
    try { return retryExternal(() => {
        const { state: current, token } = readWithToken(file);
        if (!current && !create) return null;
        if (expect) cas.validate({ operation, actor, runDir: path.dirname(file), ...expect }, current);
        const draft = current ? structuredClone(current) : {};
        const out = mutator(draft, current);
        if (out === cas.SKIP) return null;
        return writeLocked(file, out && typeof out === 'object' ? out : draft, current, { token });
    }); } finally { unlock(); }
}

/**
 * Início de ciclo (/fetch-ticket, dry-run, replay): execution_id novo e
 * processed_operations zerado — operações humanas não acumulam entre ciclos.
 */
function init(dirOrFile, initial, { executionId = newExecutionId() } = {}) {
    const file = statePath(dirOrFile);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    return withLock(file, () => {
        const current = readFile(file);
        const next = { ...initial, execution_id: executionId, processed_operations: [] };
        delete next.state_version;
        delete next.critical_fingerprint;
        return writeLocked(file, next, current);
    });
}

/**
 * Move o run para `target` (arquivamento) com o lock na mão: valida (CAS, se `expect`),
 * grava o estado final (`mutator` opcional) e renomeia a pasta — ninguém grava no run
 * entre a validação e o rename.
 */
function archive(dir, target, { expect = null, operation = 'archive', actor = null, mutator = null } = {}) {
    const file = statePath(dir);
    const unlock = acquireLock(file);
    const lockPath = `${file}.lock`;
    let moved = false;
    try {
        const current = readFile(file);
        if (expect) cas.validate({ operation, actor, runDir: dir, ...expect }, current);
        if (mutator && current) {
            const draft = structuredClone(current);
            const out = mutator(draft, current);
            if (out !== cas.SKIP) writeLocked(file, out && typeof out === 'object' ? out : draft, current);
        }
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.renameSync(dir, target);
        moved = true;
        return { from: dir, to: target, state: readFile(statePath(target)) };
    } finally {
        if (moved) {
            held.delete(lockPath);
            try { fs.unlinkSync(`${statePath(target)}.lock`); } catch { /* sem lock */ }
        } else {
            unlock();
        }
    }
}

// ── Órfãos (startup do orquestrador) ─────────────────────────────────────────────

const TMP_RE = /^state(?:\.json\.(\d+)(?:\.\d+)?)?\.tmp$/;
// tmp de criação de lock (publishLockFile) de processo que morreu antes do link/unlink.
const LOCK_TMP_RE = /^state\.json\.lock(?:\.break)?\.(\d+)\.\d+\.tmp$/;

/**
 * Descarta state.json.<pid>.<seq>.tmp / state.tmp / state.json.lock.<pid>.<seq>.tmp de
 * crash anterior (dono morto ou velho demais) e locks abandonados. Nunca aplica o tmp como estado.
 * @param {string[]} runDirs diretórios de run
 * @returns {string[]} arquivos removidos
 */
function cleanupOrphans(runDirs, { now = Date.now() } = {}) {
    const removed = [];
    for (const dir of runDirs) {
        let names;
        try { names = fs.readdirSync(dir); } catch { continue; }
        for (const name of names) {
            const full = path.join(dir, name);
            const m = TMP_RE.exec(name) || LOCK_TMP_RE.exec(name);
            if (m) {
                const pid = m[1] ? Number(m[1]) : null;
                let age = Infinity;
                try { age = now - fs.statSync(full).mtimeMs; } catch { continue; }
                if (pid && pid !== process.pid && pidAlive(pid) && age < ORPHAN_TMP_MAX_AGE_MS) continue;
                if (pid === process.pid) continue;
                try { fs.unlinkSync(full); removed.push(full); } catch { /* sumiu */ }
            } else if (name === `${STATE_FILE}.lock` && breakIfStale(full, now)) {
                removed.push(full);
            } else if (name === `${STATE_FILE}.lock.break`) {
                const b = lockOwner(full);
                if (b && (b.unknown || !pidAlive(b.pid)) && isOld(full, now)) try { fs.unlinkSync(full); removed.push(full); } catch { /* sumiu */ }
            }
        }
    }
    return removed;
}

/** Runs de uma raiz memory/runs: <raiz>/<task> e <raiz>/_archive/<task>. */
function runDirsOf(runsRoot) {
    const out = [];
    const scan = d => {
        try {
            for (const e of fs.readdirSync(d, { withFileTypes: true })) {
                if (!e.isDirectory() || e.name.startsWith('.')) continue;
                if (e.name === '_archive') scan(path.join(d, e.name));
                else out.push(path.join(d, e.name));
            }
        } catch { /* raiz ausente */ }
    };
    scan(runsRoot);
    return out;
}

module.exports = {
    STATE_FILE, CRITICAL_FIELDS, PHASES, LOCK_TIMEOUT_MS, LOCK_STALE_MS, ORPHAN_TMP_MAX_AGE_MS, _testHooks,
    criticalSnapshot, criticalFingerprint, changedCriticalFields, newExecutionId,
    EXTERNAL_WRITE, RUN_GONE, statePath, readFile, read, readWithToken, tokenOf, acquireLock, withLock, atomicWriteFile, writeLocked, merge3,
    write, update, init, archive, cleanupOrphans, runDirsOf,
};

// ── CLI (agentes nos nós, humanos) ───────────────────────────────────────────────
//
//   node scripts/state-writer.js version    <run>
//   node scripts/state-writer.js init       <run> --input=<state.json novo>
//   node scripts/state-writer.js set        <run> (--input=<patch.json> | --set campo=valor ...)
//   node scripts/state-writer.js transition <run> --from=<nó> --to=<nó> [--retry] [--status=<s>]
//                                           [--operation=node_transition|agent_retry|commit]
//   node scripts/state-writer.js archive    <run> --to=<pasta destino> [--status=committed]
//   node scripts/state-writer.js cleanup    <memory/runs>...
//
// Comuns: --expected-version=N (padrão: a versão lida agora), --execution-id=<id>
// (padrão: $STATE_EXECUTION_ID, que o watcher passa ao agente que despachou).
// Conflito → exit 3 com o JSON do erro; nada é gravado.

function parseArgs(argv) {
    const out = { _: [], set: [] };
    for (let i = 0; i < argv.length; i++) {
        const m = /^--([^=]+)(?:=(.*))?$/.exec(argv[i]);
        if (!m) { out._.push(argv[i]); continue; }
        if (m[1] !== 'set') { out[m[1]] = m[2] === undefined ? true : m[2]; continue; }
        // --set=campo=valor e --set campo=valor (a forma documentada no cabeçalho).
        if (m[2] !== undefined) { out.set.push(m[2]); continue; }
        if (i + 1 >= argv.length || argv[i + 1].startsWith('--')) throw new Error('--set sem campo=valor');
        out.set.push(argv[++i]);
    }
    return out;
}

function parseValue(raw) {
    try { return JSON.parse(raw); } catch { return raw; }
}

function setDotted(obj, dotted, value) {
    const keys = dotted.split('.');
    let o = obj;
    for (const k of keys.slice(0, -1)) {
        if (!o[k] || typeof o[k] !== 'object' || Array.isArray(o[k])) o[k] = {};
        o = o[k];
    }
    o[keys.at(-1)] = value;
}

// --expected-version / --execution-id (ou $STATE_EXECUTION_ID) por cima da leitura de agora.
function cliExpectations(args, fresh, { withExecution = false } = {}) {
    const snap = cas.snapshotOf(fresh);
    const out = cas.expectations({ expected_state_version: snap.expected_state_version, ...(withExecution ? { execution_id: snap.execution_id } : {}) }, {
        expected_state_version: args['expected-version'] !== undefined ? Number(args['expected-version']) : undefined,
        execution_id: (args['execution-id'] ?? process.env.STATE_EXECUTION_ID) || undefined,
    });
    return out;
}

function transitionCli(runDir, args) {
    const from = args.from;
    const to = args.to;
    if (!from || !to) throw new Error('transition exige --from e --to');
    const operation = args.operation || (args.retry ? 'agent_retry' : 'node_transition');
    const fresh = read(runDir);
    if (!fresh) throw new Error(`${runDir}: state.json ausente ou ilegível`);
    // commit exige execution_id (cas.REQUIRED): sem o da sessão, o da leitura de agora.
    const base = { runDir, operation, actor: 'agent', expected_node: from, ...cliExpectations(args, fresh, { withExecution: operation === 'commit' }) };
    const mutate = draft => {
        draft.node = to;
        if (args.status) draft.status = args.status;
        if (args.retry) draft.retries = { ...(draft.retries || {}), [from]: (Number(draft.retries?.[from]) || 0) + 1 };
        draft.updated_at = new Date().toISOString();
    };
    // Política do agente: relê, confere que a transição ainda faz sentido (o nó ainda é
    // o --from e a sessão ainda é a dona) e tenta uma vez.
    return cas.transactWithRetry(base, mutate, {
        revalidate: s => (s.node === from ? { expected_state_version: cas.effectiveVersion(s) } : null),
    });
}

function main(argv) {
    const args = parseArgs(argv);
    const [cmd, ...rest] = args._;
    const out = obj => console.log(JSON.stringify(obj, null, 2));
    switch (cmd) {
        case 'version': {
            const s = read(rest[0]);
            if (!s) throw new Error(`${rest[0]}: state.json ausente ou ilegível`);
            return out({ state_version: cas.effectiveVersion(s), node: s.node ?? null, execution_id: s.execution_id ?? null });
        }
        case 'init': {
            if (!args.input) throw new Error('init exige --input=<arquivo>');
            const s = init(rest[0], JSON.parse(fs.readFileSync(args.input, 'utf8')));
            return out({ state_version: s.state_version, execution_id: s.execution_id });
        }
        case 'set': {
            const patch = args.input ? JSON.parse(fs.readFileSync(args.input, 'utf8')) : {};
            for (const kv of args.set) {
                const i = kv.indexOf('=');
                if (i < 1) throw new Error(`--set inválido: ${kv}`);
                setDotted(patch, kv.slice(0, i), parseValue(kv.slice(i + 1)));
            }
            const fresh = read(rest[0]);
            if (!fresh) throw new Error(`${rest[0]}: state.json ausente ou ilegível`);
            const s = update(rest[0], draft => {
                for (const [k, v] of Object.entries(patch)) draft[k] = v;
            }, { operation: args.operation || 'set', actor: 'agent', expect: cliExpectations(args, fresh) });
            return out({ state_version: s.state_version });
        }
        case 'transition': {
            const r = transitionCli(rest[0], args);
            return out({ status: r.status, state_version: r.state?.state_version ?? null, node: r.state?.node ?? null });
        }
        case 'archive': {
            if (!args.to) throw new Error('archive exige --to=<pasta destino>');
            const fresh = read(rest[0]);
            if (!fresh) throw new Error(`${rest[0]}: state.json ausente ou ilegível`);
            const expect = {
                ...cliExpectations(args, fresh, { withExecution: true }), expected_node: args['expected-node'] || fresh.node || null,
            };
            const r = archive(rest[0], args.to, {
                expect, actor: 'agent',
                mutator: args.status ? d => { d.status = args.status; d.updated_at = new Date().toISOString(); } : null,
            });
            return out({ to: r.to, state_version: r.state?.state_version ?? null });
        }
        case 'cleanup': {
            const removed = cleanupOrphans(rest.flatMap(runDirsOf));
            return out({ removed });
        }
        default:
            throw new Error('uso: state-writer.js version|init|set|transition|archive|cleanup <run> [opções] (ver cabeçalho da CLI)');
    }
}

if (require.main === module) {
    try {
        main(process.argv.slice(2));
    } catch (e) {
        if (cas.isConflict(e)) {
            console.error(JSON.stringify({ code: e.code, error: e.message, conflicts: e.conflicts }));
            process.exit(3);
        }
        console.error(`[state-writer] ${e.message}`);
        process.exit(1);
    }
}
