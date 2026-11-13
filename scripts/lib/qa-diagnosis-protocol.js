'use strict';
// PRI-181 c2b-2-protocol (SPEC-c2b-2-protocol r5.1, `d9c90435…3338`; SDD B v3 §4.3, §4.3.1, §5, §7).
//
// Protocolo do Diagnosis Record sobre a camada de modelo da c2b-1, no caminho determinístico:
//   reserva (job, token, lease) → produção fora de lock (staging) → localização por K+token →
//   commit numa única seção crítica com admissão (a)–(g) → reconciliador de órfãos → republicação.
//
// Sem estruturas novas (regra 4): o índice token → run vive só em memória durante o tick. O
// chamador (watcher) injeta raízes, listagens, relógio e a costura de clones; nada aqui faz
// require do watcher. Toda escrita de state passa pelo state-writer (INV-2), um L_run por vez,
// e nunca há produção, varredura ou I/O remoto com lock (INV-13). O protocolo nunca grava
// updated_at nem campo de controle do run (QRD-AC-10). Nada é apagado nem renomeado (decisão 2).
//
// Desfecho tipado { ok, code }; exceção só para bug. O veredito { result, reason } de
// verifyCurrentVersion é tratado como veredito.

const realFs = require('fs');
const path = require('path');
const crypto = require('crypto');
const model = require('./qa-diagnosis-model');
const store = require('./qa-diagnosis-store');

const LEASE_MS = 15 * 60 * 1000; // Q4
const BACKOFF_MS = 15 * 60 * 1000; // Q4: contado do último qa_diagnosis_failed da chave
const MAX_RELOCATE = 3;
const STAGING_DIR = '.qa-diagnosis-staging';
// Q3: republicação automática só para motivos transitórios.
const AUTO_FAILED = ['SOURCE_UNAVAILABLE', 'TIMEOUT', 'FENCED', 'INTERNAL'];
// 9.1: falhas transitórias da promoção que abrem a carência (promotion_deferred).
const PROMOTION_TRANSIENT = ['SEAL_FAILED', 'UNKNOWN_IO', 'ANOMALY', 'LOCK_TIMEOUT', 'WRITE_FAILED'];
// Eventos de spec que não mudam spec_hash; qualquer outro spec* depois do primeiro elo quebra a cadeia.
const SPEC_EVENTS_NEUTRAL = ['spec_version_error', 'spec_version_unchanged', 'spec_drift', 'spec_change_proposed', 'spec_change_rejected'];

// Pontos de parada para os testes de crash (AC-07): chamados com o contexto, nunca em produção.
const _testHooks = {
    afterReserve: null, // K1
    duringStagingWrite: null, // K2 (recebe { fd, bytes })
    afterStaging: null, // K3
    afterLink: null, // K4 (dentro do mutator, depois do link e antes do write)
    afterWrite: null, // K5 (depois do write, com o lock ainda na mão)
    produce: null, // erro de produção injetado (AC-02)
    beforeReread: null, // releitura do passo 2 (AC-07b E07c)
};

// ── Utilidades ───────────────────────────────────────────────────────────────────

const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const vName = n => `v${String(n).padStart(3, '0')}`;
const sha12 = hex => String(hex || '').slice(0, 12);

function defaults(opts = {}) {
    // state-writer e cas são injetados pelo chamador (lib/ não sobe para scripts/: no-lib-upward).
    if (!opts.stateWriter || !opts.cas) throw new Error('qa-diagnosis-protocol: stateWriter e cas são injetados pelo chamador');
    return {
        fs: opts.fs || realFs,
        stateWriter: opts.stateWriter,
        cas: opts.cas,
        now: opts.now || (() => Date.now()),
        clonesOf: opts.clonesOf || (() => 1), // DB-16b ponto 5 (c2b-3); padrão 1 = limite declarado, não fail-closed
        discoveryRoots: opts.discoveryRoots || (() => []),
        locationRoots: opts.locationRoots || (() => []),
        onlyTicket: opts.onlyTicket || null,
        log: opts.log || (() => {}),
        counters: opts.counters || { stateReads: 0, scanReads: 0 },
        token: opts.token || (() => `det-${crypto.randomUUID()}`),
    };
}

const iso = ms => new Date(ms).toISOString();

/** Ticket do K pela gramática da SDD (ns:ISSUE:…). */
function ticketOfKey(key) {
    const m = /^[a-z][a-z0-9-]{0,31}:([1-9][0-9]{0,9}):/.exec(String(key));
    return m ? Number(m[1]) : null;
}

function ticketOfRunName(name) {
    const m = /^(\d+)-/.exec(String(name));
    return m ? Number(m[1]) : null;
}

// Allowlist de forma do detail (14.5): só chave, vNNN, motivo e 12 hex de sha. Nunca texto de nota.
const DETAIL_PART_RE = /^[A-Za-z0-9_:.()-]{1,64}$/;
function mkDetail(key, ...parts) {
    const all = [key, ...parts.filter(p => p !== null && p !== undefined && p !== '')].map(String);
    for (const p of all) if (!DETAIL_PART_RE.test(p)) throw new Error(`qa-diagnosis-protocol: detail fora da allowlist (${p.length} chars)`);
    return all.join(' ');
}
const DETAIL_RE = /^[a-z][a-z0-9-]{0,31}:[1-9][0-9]{0,9}:[jt][0-9A-Za-z:.-]+( [A-Za-z0-9_:.()-]{1,64}){0,6}$/;

/** Evento com a forma dos eventos do watcher (14.5), no mesmo write da mutação (14.6). */
function pushEvent(draft, type, detail, nowMs) {
    const ts = iso(nowMs);
    if (!Array.isArray(draft.events)) draft.events = [];
    draft.events.push({ type, node: draft.node || 'implement', ts, at: ts, detail });
}

const hasEvent = (state, type, detail) => Array.isArray(state.events)
    && state.events.some(e => e && e.type === type && e.detail === detail);

const keyEvents = (state, type, key) => (Array.isArray(state.events) ? state.events : [])
    .filter(e => e && e.type === type && typeof e.detail === 'string' && (e.detail === key || e.detail.startsWith(`${key} `)));

function lastFailedMs(state, key) {
    const evs = keyEvents(state, 'qa_diagnosis_failed', key);
    const last = evs[evs.length - 1];
    const t = last ? Date.parse(last.ts) : NaN;
    return Number.isFinite(t) ? t : null;
}

function entriesOf(state, key) {
    const out = [];
    const list = state && Array.isArray(state.qa_rejections) ? state.qa_rejections : [];
    list.forEach((e, i) => { if (e && e.rejection_key === key) out.push({ entry: e, idx: i }); });
    return out;
}

/** Entrada única de K no draft; mais de uma no mesmo run = conflito (sem escrita). */
function uniqueEntry(state, key) {
    const list = entriesOf(state, key);
    if (list.length !== 1) return { code: list.length ? 'SUBJECT_CONFLICT' : 'NO_ENTRY' };
    return { entry: list[0].entry, idx: list[0].idx };
}

function statOrNull(fs, p) {
    try { return fs.lstatSync(p); } catch { return null; }
}

function sameInode(a, b) { return !!a && !!b && a.dev === b.dev && a.ino === b.ino; }

function versionFile(runDir, key, n) {
    const sl = store.slug(key);
    return sl.ok ? path.join(runDir, store.STORE_DIR, sl.slug, store.versionFileName(n)) : null;
}

function stagingFile(root, token, n) {
    return path.join(root, STAGING_DIR, token, store.versionFileName(n));
}

// ── Vínculo e (g) (premissa 12; §3.4, §4.3.1 (g), INV-8 v3) ───────────────────

/** Snapshot = cópia literal do binding da entrada (§4.2 v3; leitura 14.12, quatro chaves). */
function snapshotFromBinding(binding) {
    if (!isObj(binding)) return { execution_id: null, spec_hash: null, spec_version: null, reason: 'unknown' };
    const pick = k => (Object.prototype.hasOwnProperty.call(binding, k) ? binding[k] : null);
    return { execution_id: pick('execution_id'), spec_hash: pick('spec_hash'), spec_version: pick('spec_version'), reason: pick('reason') ?? 'unknown' };
}

const sameVal = (a, b) => String(a) === String(b);

/**
 * Regra de cadeia do rebaseline do retry (§4.3.1 v3, RC-2 2.2 = a″): só não é stale se os
 * spec_baseline com origin "qa_retry" completos formam uma cadeia de vinc.spec_hash até
 * state.spec_hash, todos com a spec_version do vínculo (não nula), e nada mais muda spec depois
 * do primeiro elo. Hoje o retry não grava esses campos (dono c2b-3, R3): a cadeia não se prova.
 */
function retryChainProven(vinc, state) {
    if (vinc.spec_version === null || vinc.spec_version === undefined) return false;
    if (!vinc.spec_hash || !state.spec_hash) return false;
    const events = Array.isArray(state.events) ? state.events : [];
    const isLink = e => e && e.type === 'spec_baseline' && e.origin === 'qa_retry';
    const start = events.findIndex(e => isLink(e) && e.previous_spec_hash === vinc.spec_hash);
    if (start < 0) return false;
    let current = vinc.spec_hash;
    let lastLink = null;
    for (let i = start; i < events.length; i++) {
        const e = events[i];
        if (!e || typeof e.type !== 'string') continue;
        if (isLink(e)) {
            if (typeof e.previous_spec_hash !== 'string' || typeof e.new_spec_hash !== 'string'
                || e.spec_version === null || e.spec_version === undefined) return false;
            if (!sameVal(e.spec_version, vinc.spec_version) || e.previous_spec_hash !== current) return false;
            current = e.new_spec_hash;
            lastLink = e;
            continue;
        }
        if (!e.type.startsWith('spec')) continue;
        if (SPEC_EVENTS_NEUTRAL.includes(e.type)) continue;
        // Parte do elo: spec_version_rebaseline/sealed com o mesmo ts, adjacente e node qa_retry.
        const adjacent = (lastLink && events[i - 1] === lastLink) || (isLink(events[i + 1]) && events[i + 1].ts === e.ts);
        const sameTs = (lastLink && lastLink.ts === e.ts) || (isLink(events[i + 1]) && events[i + 1].ts === e.ts);
        if (['spec_version_rebaseline', 'spec_version_sealed'].includes(e.type) && e.node === 'qa_retry' && adjacent && sameTs) continue;
        return false; // /plan, SPEC_CHANGE, spec_baseline sem origin qa_retry depois do primeiro elo
    }
    return current === state.spec_hash;
}

/**
 * (g) campo a campo (RC-2 2.5): spec_hash e spec_version; execution_id não conta; campo nulo
 * não conta. → OK | STALE | STALE_PARTIAL | STALE_UNKNOWN.
 */
function compareBinding(vinc, state) {
    const v = vinc || {};
    const pairs = [[v.spec_hash, state.spec_hash], [v.spec_version, state.spec && isObj(state.spec) ? state.spec.version : null]];
    const counted = pairs.filter(([a, b]) => a !== null && a !== undefined && b !== null && b !== undefined);
    if (counted.length === 0) return 'STALE_UNKNOWN';
    const hashDiff = counted.includes(pairs[0]) && !sameVal(pairs[0][0], pairs[0][1]);
    const versionDiff = counted.includes(pairs[1]) && !sameVal(pairs[1][0], pairs[1][1]);
    if (versionDiff) return 'STALE';
    if (hashDiff) return retryChainProven(v, state) ? 'OK' : 'STALE';
    return counted.length === 1 ? 'STALE_PARTIAL' : 'OK';
}

/**
 * Vínculo da chave (premissa 12): job.snapshot; senão os bindings do cabeçalho da versão
 * corrente, só depois de verifyCurrentVersion OK; senão o binding da entrada; senão nulo.
 * Nunca o state atual.
 */
function bindingOf(runDir, key, entry, ctx) {
    const blk = entry.diagnosis;
    if (blk.job && isObj(blk.job.snapshot)) return blk.job.snapshot;
    if (blk.current_version > 0) {
        const verdict = store.verifyCurrentVersion(runDir, key, blk, { fs: ctx.fs });
        if (verdict.result === 'OK') {
            const r = store.readVersion(runDir, key, blk.current_version, { fs: ctx.fs });
            if (r.ok) {
                try {
                    const b = JSON.parse(r.bytes.toString('utf8')).bindings;
                    if (isObj(b)) return { execution_id: b.execution_id ?? null, spec_hash: b.spec_hash ?? null, spec_version: b.spec_version ?? null };
                } catch { /* cai para o binding da entrada */ }
            }
        }
    }
    return snapshotFromBinding(entry.binding);
}

/** stale_check só quando o resultado muda (§4.2 v3; CAS pelo rev, sem rev+1). */
function recordStaleCheck(draft, key, result, nowMs) {
    if (result !== 'STALE_UNKNOWN' && result !== 'STALE_PARTIAL') return false;
    const last = keyEvents(draft, 'qa_diagnosis_stale_check', key).pop();
    const detail = mkDetail(key, result);
    if (last && last.detail === detail) return false;
    pushEvent(draft, 'qa_diagnosis_stale_check', detail, nowMs);
    return true;
}

// ── Mutações do bloco (sempre dentro de um mutator do state-writer) ──────────────

/** Cercar = remover job, acrescentar T a fenced_tokens (rev+1 é do write). */
function fence(blk, token) {
    blk.job = null;
    if (token && !blk.fenced_tokens.includes(token)) blk.fenced_tokens.push(token);
}

function toFailed(draft, blk, key, reason, nowMs, ...detailParts) {
    blk.status = `failed:${reason}`;
    pushEvent(draft, 'qa_diagnosis_failed', mkDetail(key, reason, ...detailParts), nowMs);
}

function toStale(draft, blk, key, nowMs) {
    fence(blk, blk.job ? blk.job.token : null);
    blk.status = 'stale';
    pushEvent(draft, 'qa_diagnosis_stale', mkDetail(key), nowMs);
}

const pendingQuarantine = new Map(); // arquivo → último código de falha de quarentena (processo)

/**
 * Quarentena (premissa 8). Se falhar, a transição da linha vale mesmo assim; o evento
 * _quarantined só sai quando ela se completa, uma vez por arquivo (sha12 no detail).
 */
function quarantine(draft, runDir, key, token, file, motive, nowMs, ctx, vn = null) {
    const fs = ctx.fs;
    let bytesSha = null;
    try { bytesSha = model.sha256(fs.readFileSync(file)); } catch { /* sem bytes: só log */ }
    const r = store.quarantineExclusive(runDir, key, token, file, { fs });
    if (!r.ok) {
        const code = `${r.code}${r.errno ? `:${r.errno}` : ''}`;
        if (pendingQuarantine.get(file) !== code) ctx.log(`[qa-diagnosis] quarentena pendente (${code}) ${key}`);
        pendingQuarantine.set(file, code); // log só quando o código muda (9.3)
        return { ok: false, code: r.code };
    }
    pendingQuarantine.delete(file);
    const detail = mkDetail(key, vn, motive, sha12(bytesSha));
    if (!hasEvent(draft, 'qa_diagnosis_quarantined', detail)) {
        pushEvent(draft, 'qa_diagnosis_quarantined', detail, nowMs);
        return { ok: true, wrote: true };
    }
    return { ok: true, wrote: false };
}

// ── Elegibilidade e backoff (Q3, Q4) ─────────────────────────────────────────────

function isEligible(status) {
    if (status === 'pending') return true;
    const m = /^failed:([A-Z_]+)$/.exec(String(status));
    return !!m && AUTO_FAILED.includes(m[1]);
}

function inBackoff(state, key, status, nowMs) {
    if (!String(status).startsWith('failed:')) return false;
    const last = lastFailedMs(state, key);
    return last !== null && nowMs < last + BACKOFF_MS;
}

// ── Passo 1: reserva ─────────────────────────────────────────────────────────────

/**
 * Reserva sob o lock do run (premissa 3). readRev = rev lido antes do lock. Desfechos:
 * RESERVED | STALE | SLOT_OCCUPIED | RESERVE_CAS | BUSY | NOT_ELIGIBLE | BACKOFF |
 * BLOCK_INVALID | INVALID_KEY | RUNNING | NO_ENTRY | SUBJECT_CONFLICT | BINDING_INVALID | GONE.
 */
function reserve(runDir, key, readRev, opts = {}) {
    const ctx = defaults(opts);
    const nowMs = ctx.now();
    let out = null;
    ctx.stateWriter.update(runDir, (draft) => {
        if (draft.status === 'running') { out = { ok: false, code: 'RUNNING' }; return ctx.cas.SKIP; }
        if (!model.isValidKey(key)) { out = { ok: false, code: 'INVALID_KEY' }; return ctx.cas.SKIP; }
        const u = uniqueEntry(draft, key);
        if (!u.entry) { out = { ok: false, code: u.code }; return ctx.cas.SKIP; }
        const blk = u.entry.diagnosis;
        if (!model.validateBlock(blk).ok) { out = { ok: false, code: 'BLOCK_INVALID' }; return ctx.cas.SKIP; }
        if (blk.rev !== readRev) { out = { ok: false, code: 'RESERVE_CAS' }; return ctx.cas.SKIP; }
        if (blk.job !== null || blk.blocked !== null) { out = { ok: false, code: 'BUSY' }; return ctx.cas.SKIP; }
        if (!isEligible(blk.status)) { out = { ok: false, code: 'NOT_ELIGIBLE' }; return ctx.cas.SKIP; }
        if (inBackoff(draft, key, blk.status, nowMs)) { out = { ok: false, code: 'BACKOFF' }; return ctx.cas.SKIP; }
        // (g) no mesmo lock, antes de reservar (AR2-01): a reserva nunca religa ao estado atual.
        const g = compareBinding(bindingOf(runDir, key, u.entry, ctx), draft);
        if (g === 'STALE') {
            toStale(draft, blk, key, nowMs);
            blk.rev += 1;
            out = { ok: false, code: 'STALE' };
            return draft;
        }
        const n = blk.current_version + 1;
        // Premissa 10: v<current+1> já existe → SLOT_OCCUPIED visível, uma vez por (K, N), sem rev+1.
        if (statOrNull(ctx.fs, versionFile(runDir, key, n))) {
            const detail = mkDetail(key, 'slot', vName(n), '(sem', 'arquivo', 'novo)');
            out = { ok: false, code: 'SLOT_OCCUPIED' };
            if (hasEvent(draft, 'qa_diagnosis_quarantined', detail)) return ctx.cas.SKIP;
            pushEvent(draft, 'qa_diagnosis_quarantined', detail, nowMs);
            return draft;
        }
        const snapshot = snapshotFromBinding(u.entry.binding);
        const job = {
            token: ctx.token(), kind: 'deterministic', target_version: n, parent_version: n - 1,
            snapshot, runner_binding: null, lease_until: iso(nowMs + LEASE_MS),
        };
        if (!model.validateJob(job).ok) { out = { ok: false, code: 'BINDING_INVALID' }; return ctx.cas.SKIP; }
        recordStaleCheck(draft, key, g, nowMs);
        blk.job = job;
        blk.status = 'collecting';
        blk.rev += 1;
        if (!model.validateBlock(blk).ok) { out = { ok: false, code: 'INTERNAL' }; return ctx.cas.SKIP; }
        pushEvent(draft, 'qa_diagnosis_reserved', mkDetail(key, vName(n)), nowMs);
        out = { ok: true, code: 'RESERVED', job: structuredClone(job), taskId: draft.task_id || null };
        return draft;
    }, { operation: 'qa_diagnosis_reserve', actor: 'watcher' });
    return out || { ok: false, code: 'GONE' };
}

// ── Passo 2: produção fora de lock ──────────────────────────────────────────────

/** Cabeçalho §6.7 (premissa 5); null onde a origem não tem o dado. Sem seções (c2b-4). */
function buildDeterministicVersion(key, job, taskId, nowMs) {
    return model.buildVersion({
        rejection_key: key, version: job.target_version, parent_version: job.parent_version,
        job_token: job.token, produced_by: 'deterministic', created_at: iso(nowMs),
        prisma_revision: null, consumer_ref: null,
        bindings: {
            task_id: taskId, execution_id: job.snapshot.execution_id, dom06_attempt_ids: null,
            spec_hash: job.snapshot.spec_hash, spec_version: job.snapshot.spec_version, pr: null, commit: null,
        },
        taxonomy_version: null, predicates_version: null, rules_version: null,
        analyzer: { kind: 'deterministic', runtime: 'node' }, inputs_digest: null,
    }, {});
}

/**
 * Staging em <raiz do run>/.qa-diagnosis-staging/<T>/vNNN.json: mkdir exclusivo do último nível,
 * wx, fsync do arquivo e do diretório, nunca reaberto para escrita. Releitura do sha (E07c).
 */
function produceDeterministic(runDir, key, job, taskId, opts = {}) {
    const ctx = defaults(opts);
    const fs = ctx.fs;
    if (typeof taskId !== 'string' || taskId.length === 0) return { ok: false, code: 'NO_TASK_ID' };
    if (_testHooks.produce) _testHooks.produce({ runDir, key, job });
    const bytes = model.serialize(buildDeterministicVersion(key, job, taskId, ctx.now()));
    const expected = model.sha256(bytes);
    const root = path.dirname(runDir);
    const base = path.join(root, STAGING_DIR);
    const dir = path.join(base, job.token);
    const file = path.join(dir, store.versionFileName(job.target_version));
    try { fs.mkdirSync(base); } catch (e) { if (e.code !== 'EEXIST') throw e; }
    const bst = fs.lstatSync(base);
    if (bst.isSymbolicLink() || !bst.isDirectory()) return { ok: false, code: 'SYMLINK_OR_NOT_DIR' };
    fs.mkdirSync(dir); // exclusivo: EEXIST é bug (token novo por reserva)
    const fd = fs.openSync(file, 'wx', 0o644);
    try {
        if (_testHooks.duringStagingWrite) _testHooks.duringStagingWrite({ fd, bytes, file });
        fs.writeSync(fd, bytes, 0, bytes.length, 0);
        fs.fsyncSync(fd);
    } finally {
        fs.closeSync(fd);
    }
    try { const dfd = fs.openSync(dir, 'r'); try { fs.fsyncSync(dfd); } finally { fs.closeSync(dfd); } } catch { /* fsync de dir não suportado */ }
    if (_testHooks.beforeReread) _testHooks.beforeReread({ file });
    const reread = model.sha256(fs.readFileSync(file));
    return { ok: true, code: reread === expected ? 'PRODUCED' : 'STAGING_SHA', file, sha256: expected, root };
}

// ── Passo 3: localização por K + token (D-14) ───────────────────────────────────

/** Runs do ticket de K nas raízes de localização (premissa 2), lidos sem lock. */
function locationRuns(key, ctx) {
    const ticket = ticketOfKey(key);
    if (ticket === null) return [];
    const seen = new Set();
    const out = [];
    for (const root of ctx.locationRoots(ticket)) {
        let names;
        try { names = ctx.fs.readdirSync(root, { withFileTypes: true }); } catch { continue; }
        for (const d of names) {
            if (!d.isDirectory() || ticketOfRunName(d.name) !== ticket) continue;
            const dir = path.resolve(root, d.name);
            if (seen.has(dir)) continue;
            seen.add(dir);
            out.push(dir);
        }
    }
    return out;
}

function isLocationRun(dir, key, ctx) {
    const ticket = ticketOfKey(key);
    if (ticket === null || ticketOfRunName(path.basename(dir)) !== ticket) return false;
    const parent = path.resolve(path.dirname(dir));
    return ctx.locationRoots(ticket).some(r => path.resolve(r) === parent);
}

function readState(dir, ctx) {
    ctx.counters.stateReads = (ctx.counters.stateReads || 0) + 1;
    try { return JSON.parse(ctx.fs.readFileSync(path.join(dir, 'state.json'), 'utf8')); } catch { return null; }
}

/**
 * Localizador ativo; senão, de recusa (OP-01). Recência é ignorada.
 * → { ok, code: 'ACTIVE', dir } | { ok, code: 'FENCED', dir } | SUBJECT_CONFLICT | FENCED_CONFLICT | LOST.
 */
function locate(key, token, opts = {}) {
    const ctx = defaults(opts);
    const active = [];
    const fenced = [];
    for (const dir of locationRuns(key, ctx)) {
        const st = readState(dir, ctx);
        if (!st) continue;
        for (const { entry } of entriesOf(st, key)) {
            const blk = entry.diagnosis;
            if (!isObj(blk)) continue;
            if (isObj(blk.job) && blk.job.token === token) active.push(dir);
            else if (Array.isArray(blk.fenced_tokens) && blk.fenced_tokens.includes(token)) fenced.push(dir);
        }
    }
    if (active.length === 1) return { ok: true, code: 'ACTIVE', dir: active[0] };
    if (active.length > 1) return { ok: false, code: 'SUBJECT_CONFLICT' }; // DB-16b ponto 1 (c2b-3): sem escrita
    if (fenced.length === 1) return { ok: true, code: 'FENCED', dir: fenced[0] };
    if (fenced.length > 1) return { ok: false, code: 'FENCED_CONFLICT' }; // DB-16b ponto 2 (c2b-3): nada
    return { ok: false, code: 'LOST' };
}
const locateActive = locate;
const locateFenced = locate;

/** Quarentena pelo localizador de recusa: late_token uma vez (idempotente pelo inode). */
function quarantineLate(dir, key, token, file, opts = {}) {
    const ctx = defaults(opts);
    let out = null;
    ctx.stateWriter.update(dir, (draft) => {
        const u = uniqueEntry(draft, key);
        if (!u.entry || !isObj(u.entry.diagnosis) || !u.entry.diagnosis.fenced_tokens?.includes(token)) {
            out = { ok: false, code: 'NOT_FENCED' };
            return ctx.cas.SKIP;
        }
        if (stagingTreated(dir, key, file, ctx)) { out = { ok: true, code: 'ALREADY' }; return ctx.cas.SKIP; }
        const n = /v(\d+)\.json$/.exec(file);
        const q = quarantine(draft, dir, key, token, file, 'late_token', ctx.now(), ctx, n ? vName(Number(n[1])) : null);
        out = { ok: q.ok, code: q.ok ? 'QUARANTINED' : q.code };
        return q.wrote ? draft : ctx.cas.SKIP;
    }, { operation: 'qa_diagnosis_quarantine', actor: 'watcher' });
    return out || { ok: false, code: 'GONE' };
}

/** Critério de «já tratado» (OP3-05, OP4-04): qualquer 0444 regular na quarentena com o mesmo inode. */
function stagingTreated(runDir, key, file, ctx) {
    const st = statOrNull(ctx.fs, file);
    const sl = store.slug(key);
    if (!st || !sl.ok) return false;
    const qdir = path.join(runDir, store.STORE_DIR, sl.slug, store.QUARANTINE_DIR);
    let names;
    try { names = ctx.fs.readdirSync(qdir); } catch { return false; }
    return names.some(n => {
        const q = statOrNull(ctx.fs, path.join(qdir, n));
        return q && q.isFile() && !q.isSymbolicLink() && (q.mode & 0o777) === store.SEALED_MODE && sameInode(q, st);
    });
}

// ── Passo 4: commit (uma seção crítica; desfecho vem do mutator) ─────────────────

function promotionDeferredEvent(state, key, token, n) {
    return keyEvents(state, 'qa_diagnosis_promotion_deferred', key).find(e => e.detail === mkDetail(key, vName(n), 'promotion_deferred', token.slice(0, 12)));
}

/**
 * Admissão §4.3.1 (a)–(g) e link, dentro do mutator. Devolve { code, write }. Ordem da
 * precedência (premissa 8): no-op, (b), (g), (c), (d)/(e)/(f), store.
 */
function admitAndLink(draft, runDir, key, token, file, ctx) {
    const fs = ctx.fs;
    const nowMs = ctx.now();
    const u = uniqueEntry(draft, key);
    if (!u.entry) return { code: u.code === 'SUBJECT_CONFLICT' ? 'SUBJECT_CONFLICT' : 'RELOCATE', write: false };
    const blk = u.entry.diagnosis;
    if (!model.validateBlock(blk).ok) return { code: 'BLOCK_INVALID', write: false };
    const stagingSt = statOrNull(fs, file);
    const job = blk.job;
    if (!job || job.token !== token) {
        // No-op: staging já ligado a uma versão registrada (corrida reconciliador × produtor).
        if (stagingSt && blk.versions.some(v => sameInode(statOrNull(fs, versionFile(runDir, key, v.v)), stagingSt))) return { code: 'NOOP', write: false };
        // (b) token cercado → localizador de recusa.
        if (blk.fenced_tokens.includes(token)) return { code: 'FENCED_TOKEN', write: false };
        return { code: 'RELOCATE', write: false };
    }
    const n = job.target_version;
    const vnFile = versionFile(runDir, key, n);
    const vnSt = statOrNull(fs, vnFile);
    const vnSameInode = sameInode(vnSt, stagingSt);
    // (f) status ≠ collecting com job T (bug): cercar sem mudar status. Regra de status da premissa 8
    // (só collecting com o job T muda de status) vem antes da (g) para esse caso.
    if (blk.status !== 'collecting') {
        fence(blk, token);
        blk.rev += 1;
        if (stagingSt) quarantine(draft, runDir, key, token, file, 'bug_status', nowMs, ctx, vName(n));
        return { code: 'FENCED_BUG', write: true };
    }
    // (g) spec mudou → stale, com precedência sobre a (c).
    const g = compareBinding(job.snapshot, draft);
    if (g === 'STALE') {
        toStale(draft, blk, key, nowMs);
        blk.rev += 1;
        if (stagingSt) quarantine(draft, runDir, key, token, vnSameInode ? vnFile : file, 'stale', nowMs, ctx, vName(n));
        return { code: 'STALE', write: true };
    }
    // (c) na admissão do link (§4.3.1 (c) v3; RC-1 (b)).
    if (vnSameInode) {
        const deferred = promotionDeferredEvent(draft, key, token, n);
        if (deferred && nowMs >= Date.parse(deferred.ts) + LEASE_MS) {
            fence(blk, token);
            toFailed(draft, blk, key, 'FENCED', nowMs, vName(n), 'promotion_deferred');
            blk.rev += 1;
            quarantine(draft, runDir, key, token, vnFile, 'promotion_deferred', nowMs, ctx, vName(n));
            return { code: 'FENCED_PROMOTION', write: true };
        }
    } else if (nowMs >= Date.parse(job.lease_until)) {
        fence(blk, token);
        toFailed(draft, blk, key, 'FENCED', nowMs, 'lease');
        blk.rev += 1;
        if (stagingSt) quarantine(draft, runDir, key, token, file, 'lease', nowMs, ctx, vName(n));
        return { code: 'FENCED_LEASE', write: true };
    }
    // (d) parent/target incoerentes.
    if (n !== blk.current_version + 1 || job.parent_version !== blk.current_version) {
        fence(blk, token);
        toFailed(draft, blk, key, 'INTERNAL', nowMs, 'parent_target');
        blk.rev += 1;
        if (stagingSt) quarantine(draft, runDir, key, token, file, 'parent_target', nowMs, ctx, vName(n));
        return { code: 'INTERNAL', write: true };
    }
    if (!stagingSt) return { code: 'SRC_MISSING', write: false };
    // (e) igual no commit e no reconciliador (E07b): bytes que serão ligados.
    let bytes;
    try { bytes = fs.readFileSync(file); } catch { return { code: 'UNKNOWN_IO', write: false }; }
    let parsed;
    try { parsed = JSON.parse(bytes.toString('utf8')); } catch {
        // Staging que não abre com job ativo e lease válido = produtor interrompido (9.3): no-op.
        return { code: 'PRODUCER_INTERRUPTED', write: false };
    }
    if (!model.validateVersion(parsed).ok || parsed.rejection_key !== key || parsed.version !== n
        || parsed.parent_version !== n - 1 || parsed.job_token !== token) {
        fence(blk, token);
        toFailed(draft, blk, key, 'SCHEMA_INVALID', nowMs, vName(n));
        blk.rev += 1;
        quarantine(draft, runDir, key, token, vnSameInode ? vnFile : file, 'schema_invalid', nowMs, ctx, vName(n));
        return { code: 'SCHEMA_INVALID', write: true };
    }
    const sha = model.sha256(bytes);
    if (stagingSt.dev !== (statOrNull(fs, runDir) || {}).dev) {
        fence(blk, token);
        toFailed(draft, blk, key, 'FENCED', nowMs, 'cross_device');
        blk.rev += 1;
        return { code: 'CROSS_DEVICE', write: true };
    }
    // Link: só aqui, dentro da seção crítica, depois da admissão (invariante da prova por inode).
    const r = store.createVersionExclusive(runDir, key, n, file, { fs });
    if (r.ok) {
        const dest = statOrNull(fs, r.file);
        if (!sameInode(dest, stagingSt)) return conflict(draft, blk, runDir, key, token, file, n, nowMs, ctx);
        if (_testHooks.afterLink) _testHooks.afterLink({ runDir, key, token, n });
        blk.versions.push({ v: n, sha256: sha, produced_by: 'deterministic', at: iso(nowMs) });
        blk.current_version = n;
        blk.current_sha256 = sha;
        blk.status = 'proposed';
        blk.job = null;
        blk.rev += 1;
        recordStaleCheck(draft, key, g, nowMs);
        if (!model.validateBlock(blk).ok) return { code: 'INTERNAL_BLOCK', write: false };
        pushEvent(draft, 'qa_diagnosis_proposed', mkDetail(key, vName(n), sha12(sha)), nowMs);
        return { code: r.code === 'CREATED' ? 'PROPOSED' : 'PROPOSED_IDEMPOTENT', write: true, sha256: sha, n };
    }
    if (r.code === 'CONFLICT') return conflict(draft, blk, runDir, key, token, file, n, nowMs, ctx);
    if (r.code === 'SRC_INVALID' || r.code === 'INVALID_VERSION') {
        fence(blk, token);
        toFailed(draft, blk, key, 'SCHEMA_INVALID', nowMs, vName(n));
        blk.rev += 1;
        quarantine(draft, runDir, key, token, file, 'schema_invalid', nowMs, ctx, vName(n));
        return { code: 'SCHEMA_INVALID', write: true };
    }
    if (r.code === 'CROSS_DEVICE' || r.code === 'LINK_REFUSED') {
        fence(blk, token);
        toFailed(draft, blk, key, 'FENCED', nowMs, r.code === 'CROSS_DEVICE' ? 'cross_device' : 'link_refused');
        blk.rev += 1;
        if (r.code === 'LINK_REFUSED') quarantine(draft, runDir, key, token, file, 'link_refused', nowMs, ctx, vName(n));
        return { code: r.code, write: true };
    }
    // SEAL_FAILED, ANOMALY, UNKNOWN_IO, SRC_*: nada no write do commit; reconciliador ou lease.
    return { code: r.code, write: false };
}

function conflict(draft, blk, runDir, key, token, file, n, nowMs, ctx) {
    fence(blk, token);
    toFailed(draft, blk, key, 'FENCED', nowMs, 'conflict', vName(n));
    blk.rev += 1;
    quarantine(draft, runDir, key, token, file, 'conflict', nowMs, ctx, vName(n));
    return { code: 'CONFLICT', write: true };
}

/**
 * Commit (premissa 7): uma chamada stateWriter.update por tentativa; RELOCATE volta à
 * localização no máximo MAX_RELOCATE vezes. Qualquer outro desfecho volta na hora.
 */
function commit(key, token, file, located, opts = {}) {
    const ctx = defaults(opts);
    let dir = located && located.dir;
    for (let hop = 0; hop < MAX_RELOCATE && dir; hop++) {
        let out = null;
        try {
            ctx.stateWriter.update(dir, (draft) => {
                if (draft.status === 'running') { out = { code: 'RUNNING', write: false }; return ctx.cas.SKIP; }
                out = admitAndLink(draft, dir, key, token, file, ctx);
                return out.write ? draft : ctx.cas.SKIP;
            }, { operation: 'qa_diagnosis_commit', actor: 'watcher' });
            if (out && out.write && _testHooks.afterWrite) _testHooks.afterWrite({ dir, key, token });
        } catch (e) {
            ctx.log(`[qa-diagnosis] commit ${key}: ${e.code || e.message}`);
            return { ok: false, code: e.code === 'STATE_LOCK_TIMEOUT' ? 'LOCK_TIMEOUT' : 'WRITE_FAILED' };
        }
        if (out && out.code !== 'RELOCATE') {
            if (out.code === 'FENCED_TOKEN') return quarantineLate(dir, key, token, file, opts);
            return { ok: out.code === 'PROPOSED' || out.code === 'PROPOSED_IDEMPOTENT', code: out.code, dir, n: out.n, sha256: out.sha256 };
        }
        const loc = locate(key, token, opts);
        if (loc.code === 'FENCED') return quarantineLate(loc.dir, key, token, file, opts);
        if (!loc.ok) return { ok: false, code: loc.code };
        dir = loc.dir;
    }
    return { ok: false, code: 'LOST' };
}

// ── Falhas de produção (premissa 8) e releitura do passo 2 (premissa 5) ─────────

/** failJob: token confere → (g) primeiro (stale); senão cercar e failed:<reason>. Staging fica. */
function failJob(dir, key, token, reason, opts = {}) {
    const ctx = defaults(opts);
    const nowMs = ctx.now();
    let out = null;
    ctx.stateWriter.update(dir, (draft) => {
        const u = uniqueEntry(draft, key);
        const blk = u.entry && u.entry.diagnosis;
        if (!blk || !model.validateBlock(blk).ok || !blk.job || blk.job.token !== token) { out = { ok: false, code: 'TOKEN_MISMATCH' }; return ctx.cas.SKIP; }
        if (blk.status === 'collecting' && compareBinding(blk.job.snapshot, draft) === 'STALE') {
            toStale(draft, blk, key, nowMs);
            out = { ok: true, code: 'STALE' };
        } else {
            fence(blk, token);
            if (blk.status === 'collecting') toFailed(draft, blk, key, reason, nowMs, 'producer');
            out = { ok: true, code: `FAILED_${reason}` };
        }
        blk.rev += 1;
        return draft;
    }, { operation: 'qa_diagnosis_fail', actor: 'watcher' });
    return out || { ok: false, code: 'GONE' };
}

/**
 * Divergência na releitura do passo 2 (E07c), sob o lock: (g) primeiro; token ausente ou
 * cercado → só quarentena; collecting → failed:INTEGRITY; proposed/reviewed → status mantido.
 */
function verifyFailJob(dir, key, token, file, opts = {}) {
    const ctx = defaults(opts);
    const nowMs = ctx.now();
    let out = null;
    ctx.stateWriter.update(dir, (draft) => {
        const u = uniqueEntry(draft, key);
        const blk = u.entry && u.entry.diagnosis;
        if (!blk || !model.validateBlock(blk).ok) { out = { ok: false, code: 'BLOCK_INVALID' }; return ctx.cas.SKIP; }
        if (!blk.job || blk.job.token !== token) {
            if (blk.fenced_tokens.includes(token)) {
                const q = quarantine(draft, dir, key, token, file, 'staging_sha', nowMs, ctx);
                out = { ok: true, code: 'QUARANTINE_ONLY' };
                return q.wrote ? draft : ctx.cas.SKIP;
            }
            out = { ok: false, code: 'TOKEN_ABSENT' };
            return ctx.cas.SKIP;
        }
        if (ctx.clonesOf(key) > 1) { out = { ok: false, code: 'CLONES' }; return ctx.cas.SKIP; } // DB-16b ponto 5: cerco §4.3.2 (c2b-3)
        if (blk.status === 'collecting' && compareBinding(blk.job.snapshot, draft) === 'STALE') {
            toStale(draft, blk, key, nowMs);
            out = { ok: true, code: 'STALE' };
        } else if (blk.status === 'collecting') {
            fence(blk, token);
            toFailed(draft, blk, key, 'INTEGRITY', nowMs, 'INTEGRITY:staging_sha');
            out = { ok: true, code: 'FAILED_INTEGRITY' };
        } else {
            fence(blk, token);
            out = { ok: true, code: 'FENCED_KEEP_STATUS' };
        }
        blk.rev += 1;
        quarantine(draft, dir, key, token, file, 'staging_sha', nowMs, ctx);
        return draft;
    }, { operation: 'qa_diagnosis_verify_fail', actor: 'watcher' });
    return out || { ok: false, code: 'GONE' };
}

// ── stale (premissa 12) e superseded (premissa 13) ──────────────────────────────

const NON_TERMINAL = s => s === 'collecting' || s === 'proposed' || s === 'reviewed'
    || (String(s).startsWith('failed:') && s !== 'failed:INTEGRITY');

/** Passada de stale sobre os blocos não terminais de um run (exceto failed:INTEGRITY). */
function applyStale(dir, opts = {}) {
    const ctx = defaults(opts);
    const nowMs = ctx.now();
    const results = [];
    ctx.stateWriter.update(dir, (draft) => {
        if (draft.status === 'running') return ctx.cas.SKIP;
        let write = false;
        for (const entry of Array.isArray(draft.qa_rejections) ? draft.qa_rejections : []) {
            const blk = entry && entry.diagnosis;
            if (!blk || !model.isValidKey(entry.rejection_key) || !model.validateBlock(blk).ok) continue;
            if (!NON_TERMINAL(blk.status)) continue;
            const key = entry.rejection_key;
            // Premissa 2 (AR2-03): run fora das raízes de localização do ticket de K nunca é subject.
            if (!isLocationRun(dir, key, ctx)) continue;
            // DB-16b ponto 7 (c2b-3): stale por clone; sem clones(K), cada run avalia o próprio bloco.
            const g = compareBinding(bindingOf(dir, key, entry, ctx), draft);
            if (g === 'STALE') {
                toStale(draft, blk, key, nowMs);
                blk.rev += 1;
                write = true;
            } else if (recordStaleCheck(draft, key, g, nowMs)) write = true;
            results.push({ key, result: g });
        }
        return write ? draft : ctx.cas.SKIP;
    }, { operation: 'qa_diagnosis_stale', actor: 'watcher' });
    return results;
}

/**
 * superseded (§5 v3; QRD-AC-04), função pura para o write atômico da ingestão (c1b). Precedência
 * do outcome (RC-6 (b)); confirmed_cause nunca é apagado. → { code } e muta o draft.
 */
function applySuperseded(draft, key, { newKey = null, at } = {}) {
    const u = uniqueEntry(draft, key);
    if (!u.entry) return { ok: false, code: u.code };
    const blk = u.entry.diagnosis;
    if (!model.validateBlock(blk).ok) return { ok: false, code: 'BLOCK_INVALID' };
    if (blk.status === 'superseded') return { ok: true, code: 'IDEMPOTENT' };
    if (!model.isCalendarIso(at)) return { ok: false, code: 'INVALID_AT' }; // relógio do chamador (c1b), sem Date() implícito
    const atIso = at;
    fence(blk, blk.job ? blk.job.token : null);
    blk.status = 'superseded';
    const o = blk.outcome;
    let detail;
    if (o.source === 'human_label' || ['QA_APPROVED', 'WITHDRAWN', 'QA_REJECTED_AGAIN'].includes(o.status)) {
        detail = mkDetail(key, `outcome_kept:${o.status}`);
    } else {
        blk.outcome = { ...o, status: 'QA_REJECTED_AGAIN', source: 'redmine_transition', evidence_ref: newKey || null, at: atIso, confirmed_cause: o.confirmed_cause };
        detail = mkDetail(key);
    }
    blk.rev += 1;
    pushEvent(draft, 'qa_diagnosis_superseded', detail, Date.parse(atIso));
    return { ok: true, code: 'SUPERSEDED' };
}

// ── Varredura (uma passada por tick; índice token → run em memória) ─────────────

function listRunDirs(root, ctx) {
    let names;
    try { names = ctx.fs.readdirSync(root, { withFileTypes: true }); } catch { return []; }
    return names.filter(d => d.isDirectory() && !d.name.startsWith('_') && !d.name.startsWith('.') && ticketOfRunName(d.name) !== null)
        .map(d => path.resolve(root, d.name));
}

function scan(ctx) {
    const roots = [...new Set(ctx.discoveryRoots().map(r => path.resolve(r)))];
    const runs = [];
    const index = new Map(); // token → [{ dir, key, kind }]
    const add = (t, rec) => { if (!index.has(t)) index.set(t, []); index.get(t).push(rec); };
    const seen = new Set();
    let outside = 0;
    for (const root of roots) {
        for (const dir of listRunDirs(root, ctx)) {
            if (seen.has(dir)) continue;
            seen.add(dir);
            if (ctx.onlyTicket && ticketOfRunName(path.basename(dir)) !== ctx.onlyTicket) continue;
            ctx.counters.scanReads = (ctx.counters.scanReads || 0) + 1;
            const state = readState(dir, ctx);
            if (!state || state.status === 'running') continue; // o agente regrava o state ao sair do nó
            const entries = (Array.isArray(state.qa_rejections) ? state.qa_rejections : [])
                .map((e, idx) => ({ e, idx }))
                .filter(({ e }) => e && isObj(e.diagnosis) && model.isValidKey(e.rejection_key));
            if (!entries.length) continue;
            const inside = entries.filter(({ e }) => isLocationRun(dir, e.rejection_key, ctx));
            if (inside.length < entries.length) outside += entries.length - inside.length;
            if (!inside.length) continue; // nenhuma chave admitida: o run não entra no driver nem no reconciliador
            runs.push({ dir, root, state, entries: inside });
            for (const { e } of inside) {
                const blk = e.diagnosis;
                if (isObj(blk.job) && model.isValidToken(blk.job.token)) add(blk.job.token, { dir, key: e.rejection_key, kind: 'active' });
                for (const t of Array.isArray(blk.fenced_tokens) ? blk.fenced_tokens : []) add(t, { dir, key: e.rejection_key, kind: 'fenced' });
            }
        }
    }
    if (outside) ctx.log(`[qa-diagnosis] ${outside} entrada(s) fora das raízes de localização: sem escrita`);
    const stagings = [];
    for (const root of roots) {
        const base = path.join(root, STAGING_DIR);
        let tokens;
        try { tokens = ctx.fs.readdirSync(base, { withFileTypes: true }); } catch { continue; }
        for (const t of tokens) {
            if (!t.isDirectory() || !model.isValidToken(t.name)) continue;
            let files;
            try { files = ctx.fs.readdirSync(path.join(base, t.name)); } catch { continue; }
            for (const f of files) {
                const p = store.parseVersionFileName(f);
                if (!p || !p.v) continue;
                const file = path.join(base, t.name, f);
                const st = statOrNull(ctx.fs, file);
                if (st && st.isFile() && !st.isSymbolicLink()) stagings.push({ token: t.name, n: p.v, file, st, root });
            }
        }
    }
    return { runs, index, stagings, roots };
}

/** Staging de T em todas as raízes de descoberta (o run pode ter sido arquivado depois do link). */
function findStaging(scanned, token, n) {
    return scanned.stagings.find(s => s.token === token && s.n === n) || null;
}

// ── Reconciliador (premissa 9) ───────────────────────────────────────────────────

/** Evento promotion_deferred uma vez por (T, N), em write separado só de evento, sem rev+1. */
function deferPromotion(dir, key, token, n, opts) {
    const ctx = defaults(opts);
    if (ctx.clonesOf(key) > 1) return { ok: false, code: 'CLONES' }; // DB-16b ponto 5 (c2b-3): não grava
    let out = null;
    try {
        ctx.stateWriter.update(dir, (draft) => {
            if (draft.status === 'running') { out = { ok: false, code: 'RUNNING' }; return ctx.cas.SKIP; } // OI2-03
            const u = uniqueEntry(draft, key);
            const blk = u.entry && u.entry.diagnosis;
            if (!blk || !blk.job || blk.job.token !== token) { out = { ok: false, code: 'TOKEN_MISMATCH' }; return ctx.cas.SKIP; }
            if (promotionDeferredEvent(draft, key, token, n)) { out = { ok: true, code: 'ALREADY' }; return ctx.cas.SKIP; }
            pushEvent(draft, 'qa_diagnosis_promotion_deferred', mkDetail(key, vName(n), 'promotion_deferred', token.slice(0, 12)), ctx.now());
            out = { ok: true, code: 'DEFERRED' };
            return draft;
        }, { operation: 'qa_diagnosis_promotion_deferred', actor: 'watcher' });
    } catch (e) {
        return { ok: false, code: 'WRITE_FAILED' }; // gravado no primeiro write bem-sucedido de um tick seguinte
    }
    return out || { ok: false, code: 'GONE' };
}

/** 9.1 órfão versionado: promove com prova por inode; senão quarentena e status pela tabela. */
function reconcileOrphans(scanned, ctx, opts, report) {
    for (const run of scanned.runs) {
        try {
            for (const { e } of run.entries) {
                const key = e.rejection_key;
                const blk = e.diagnosis;
                if (!model.validateBlock(blk).ok) continue;
                const lv = store.listVersions(run.dir, key, { fs: ctx.fs });
                if (!lv.ok) continue;
                for (const { v: n, file: vnFile } of lv.versions.filter(x => x.v > blk.current_version)) {
                    const job = blk.job;
                    let header = null;
                    try { header = JSON.parse(ctx.fs.readFileSync(vnFile, 'utf8')); } catch { /* cabeçalho ilegível */ }
                    const staging = job ? findStaging(scanned, job.token, n) : null;
                    const vnSt = statOrNull(ctx.fs, vnFile);
                    const provable = job && job.target_version === n && header && header.job_token === job.token
                        && staging && sameInode(staging.st, vnSt) && !blk.fenced_tokens.includes(job.token);
                    if (provable) {
                        const r = commit(key, job.token, staging.file, { dir: run.dir }, opts);
                        report.push({ step: '9.1', key, n, code: r.code });
                        if (r.ok) continue;
                        // Qualquer promoção não concluída abre a carência (AI1-02: sem evento, o vencimento
                        // nunca cercaria). deferPromotion não grava se o job T já foi cercado pela tabela.
                        const d = deferPromotion(run.dir, key, job.token, n, opts);
                        report.push({ step: '9.1-carencia', key, n, code: d.code, cause: r.code, transient: PROMOTION_TRANSIENT.includes(r.code) });
                        continue;
                    }
                    // Não promovível: (e)/(d)/CONFLICT com job T em collecting; os demais status ficam iguais.
                    orphanNotPromotable(run.dir, key, n, vnFile, header, staging, ctx, report);
                }
            }
        } catch (e) {
            ctx.log(`[qa-diagnosis] reconcileOrphans ${path.basename(run.dir)}: ${e.code || e.message}`); // um run não aborta a fase (OI1-07)
        }
    }
}

function orphanNotPromotable(dir, key, n, vnFile, header, staging, ctx, report) {
    const nowMs = ctx.now();
    const qToken = header && model.isValidToken(header.job_token) ? header.job_token : `orphan-${vName(n)}`;
    let code = 'ORPHAN_QUARANTINE';
    ctx.stateWriter.update(dir, (draft) => {
        const u = uniqueEntry(draft, key);
        const blk = u.entry && u.entry.diagnosis;
        if (!blk || !model.validateBlock(blk).ok || n <= blk.current_version) { code = 'SKIP'; return ctx.cas.SKIP; }
        let write = false;
        const job = blk.job;
        if (job && blk.status === 'collecting' && job.target_version === n) {
            const g = compareBinding(job.snapshot, draft);
            const headerOk = header && model.validateVersion(header).ok && header.rejection_key === key
                && header.version === n && header.parent_version === n - 1 && header.job_token === job.token;
            if (g === 'STALE') { toStale(draft, blk, key, nowMs); code = 'STALE'; } else if (!headerOk) {
                fence(blk, job.token); toFailed(draft, blk, key, 'SCHEMA_INVALID', nowMs, vName(n)); code = 'SCHEMA_INVALID';
            } else if (job.parent_version !== blk.current_version) {
                fence(blk, job.token); toFailed(draft, blk, key, 'INTERNAL', nowMs, 'parent_target'); code = 'INTERNAL';
            } else if (staging && !sameInode(staging.st, statOrNull(ctx.fs, vnFile))) {
                fence(blk, job.token); toFailed(draft, blk, key, 'FENCED', nowMs, 'conflict', vName(n)); code = 'CONFLICT';
            } else code = 'ORPHAN_WAIT'; // sem prova (staging não achado): o lease decide (9.2)
            if (code !== 'ORPHAN_WAIT') { blk.rev += 1; write = true; }
        }
        if (code === 'ORPHAN_WAIT') return ctx.cas.SKIP;
        const q = quarantine(draft, dir, key, qToken, vnFile, 'orphan', nowMs, ctx, vName(n));
        return write || q.wrote ? draft : ctx.cas.SKIP;
    }, { operation: 'qa_diagnosis_orphan', actor: 'watcher' });
    report.push({ step: '9.1-orfao', key, n, code });
}

/** 9.2 lease vencido (depois da 9.1). vN de mesmo inode → carência; (g) → stale; senão FENCED lease. */
function reconcileLeases(scanned, ctx, report) {
    const nowMs = ctx.now();
    for (const run of scanned.runs) {
        try {
            for (const { e } of run.entries) {
                const key = e.rejection_key;
                const blk = e.diagnosis;
                if (!blk || blk.status !== 'collecting' || !isObj(blk.job) || nowMs < Date.parse(blk.job.lease_until)) continue;
                const token = blk.job.token;
                const n = blk.job.target_version;
                const staging = findStaging(scanned, token, n);
                const vnSt = statOrNull(ctx.fs, versionFile(run.dir, key, n));
                let code = null;
                ctx.stateWriter.update(run.dir, (draft) => {
                    const u = uniqueEntry(draft, key);
                    const b = u.entry && u.entry.diagnosis;
                    if (!b || !model.validateBlock(b).ok || b.status !== 'collecting' || !b.job || b.job.token !== token) return ctx.cas.SKIP;
                    // Mesma precedência da premissa 8: (g) antes da (c) e da carência (OI1-03).
                    if (compareBinding(b.job.snapshot, draft) === 'STALE') {
                        toStale(draft, b, key, ctx.now());
                        b.rev += 1;
                        code = 'STALE';
                        return draft;
                    }
                    if (staging && sameInode(staging.st, vnSt)) {
                        // Carência da 9.1: só o vencimento dela cerca (FENCED promotion_deferred).
                        const d = promotionDeferredEvent(draft, key, token, n);
                        if (!d || ctx.now() < Date.parse(d.ts) + LEASE_MS) { code = 'GRACE'; return ctx.cas.SKIP; }
                        fence(b, token);
                        toFailed(draft, b, key, 'FENCED', ctx.now(), vName(n), 'promotion_deferred');
                        b.rev += 1;
                        quarantine(draft, run.dir, key, token, versionFile(run.dir, key, n), 'promotion_deferred', ctx.now(), ctx, vName(n));
                        code = 'FENCED_PROMOTION';
                        return draft;
                    }
                    fence(b, token);
                    toFailed(draft, b, key, 'FENCED', ctx.now(), 'lease');
                    code = 'FENCED_LEASE';
                    b.rev += 1;
                    return draft;
                }, { operation: 'qa_diagnosis_lease', actor: 'watcher' });
                if (code) report.push({ step: '9.2', key, code });
            }
        } catch (e) {
            ctx.log(`[qa-diagnosis] reconcileLeases ${path.basename(run.dir)}: ${e.code || e.message}`); // um run não aborta a fase (OI1-07)
        }
    }
}

let lastLostCount = 0; // log agregado só quando muda (processo)

/** 9.3 staging sem commit: localiza por T pelo índice; ativo → commit; cercado → quarentena. */
function reconcileStagings(scanned, ctx, opts, report) {
    let lost = 0;
    for (const s of scanned.stagings) {
        const recs = scanned.index.get(s.token) || [];
        const active = recs.filter(r => r.kind === 'active');
        const fenced = recs.filter(r => r.kind === 'fenced');
        if (active.length === 1) {
            const run = scanned.runs.find(r => r.dir === active[0].dir);
            const blk = run && run.entries.find(x => x.e.rejection_key === active[0].key)?.e.diagnosis;
            if (!blk || ctx.now() >= Date.parse(blk.job.lease_until) || blk.job.target_version !== s.n) continue; // 9.2 decide
            if (statOrNull(ctx.fs, versionFile(active[0].dir, active[0].key, s.n))) continue; // vN existe: 9.1 decide
            const r = commit(active[0].key, s.token, s.file, { dir: active[0].dir }, opts);
            report.push({ step: '9.3', key: active[0].key, code: r.code });
            continue;
        }
        if (active.length > 1) continue; // SUBJECT_CONFLICT: sem escrita (c2b-3)
        if (fenced.length === 1) {
            if (stagingTreated(fenced[0].dir, fenced[0].key, s.file, ctx)) continue;
            const r = quarantineLate(fenced[0].dir, fenced[0].key, s.token, s.file, opts);
            report.push({ step: '9.3-cercado', key: fenced[0].key, code: r.code });
            continue;
        }
        if (fenced.length > 1) continue;
        if (s.st.nlink >= 2) continue; // commitado (o commit tira o token do state)
        lost += 1;
    }
    if (lost !== lastLostCount) ctx.log(`[qa-diagnosis] stagings sem subject (LOST): ${lost}`);
    lastLostCount = lost;
    return lost;
}

/** 9.5 integridade: proposed/reviewed com versão → failed:INTEGRITY, sem republicação (§7 v3). */
function reconcileIntegrity(scanned, ctx, report) {
    for (const run of scanned.runs) {
        try {
            const targets = run.entries.filter(({ e }) => ['proposed', 'reviewed'].includes(e.diagnosis.status) && e.diagnosis.current_version > 0);
            if (!targets.length) continue;
            ctx.stateWriter.update(run.dir, (draft) => {
                let write = false;
                for (const { e } of targets) {
                    const u = uniqueEntry(draft, e.rejection_key);
                    const blk = u.entry && u.entry.diagnosis;
                    if (!blk || !['proposed', 'reviewed'].includes(blk.status) || !model.validateBlock(blk).ok) continue;
                    const verdict = store.verifyCurrentVersion(run.dir, e.rejection_key, blk, { fs: ctx.fs });
                    if (verdict.result !== 'INTEGRITY') continue; // UNKNOWN e NO_VERSION não transitam
                    fence(blk, blk.job ? blk.job.token : null);
                    toFailed(draft, blk, e.rejection_key, 'INTEGRITY', ctx.now(), `INTEGRITY:${verdict.reason}`);
                    blk.rev += 1;
                    write = true;
                    report.push({ step: '9.5', key: e.rejection_key, code: `INTEGRITY:${verdict.reason}` });
                }
                return write ? draft : ctx.cas.SKIP;
            }, { operation: 'qa_diagnosis_integrity', actor: 'watcher' });
        } catch (e) {
            ctx.log(`[qa-diagnosis] reconcileIntegrity ${path.basename(run.dir)}: ${e.code || e.message}`); // um run não aborta a fase (OI1-07)
        }
    }
}

function reconcile(scanned, opts = {}) {
    const ctx = defaults(opts);
    const report = [];
    const guard = (fn) => { try { fn(); } catch (e) { ctx.log(`[qa-diagnosis] reconciliador: ${e.code || e.message}`); } };
    guard(() => reconcileOrphans(scanned, ctx, opts, report));
    guard(() => reconcileLeases(scanned, ctx, report));
    guard(() => reconcileStagings(scanned, ctx, opts, report));
    guard(() => reconcileIntegrity(scanned, ctx, report));
    return report;
}

// ── Driver (premissa 11) ─────────────────────────────────────────────────────────

/** Uma chave por vez: reserva → produz → localiza → commit. */
function publishKey(dir, key, readRev, opts = {}) {
    const ctx = defaults(opts);
    const res = reserve(dir, key, readRev, opts);
    if (!res.ok) return res;
    const job = res.job;
    if (_testHooks.afterReserve) _testHooks.afterReserve({ dir, key, job });
    if (!res.taskId) return failJob(dir, key, job.token, 'INTERNAL', opts);
    let prod;
    try {
        prod = produceDeterministic(dir, key, job, res.taskId, opts);
    } catch (e) {
        const reason = ['SOURCE_UNAVAILABLE', 'TIMEOUT', 'INTERNAL'].includes(e.reason) ? e.reason : 'INTERNAL';
        return failJob(dir, key, job.token, reason, opts);
    }
    if (!prod.ok) return failJob(dir, key, job.token, 'INTERNAL', opts);
    if (prod.code === 'STAGING_SHA') return verifyFailJob(dir, key, job.token, prod.file, opts);
    if (_testHooks.afterStaging) _testHooks.afterStaging({ dir, key, job, file: prod.file });
    const loc = locate(key, job.token, opts);
    if (loc.code === 'FENCED') return quarantineLate(loc.dir, key, job.token, prod.file, opts);
    if (!loc.ok) return loc;
    return commit(key, job.token, prod.file, loc, opts);
}

function drive(scanned, opts = {}) {
    const ctx = defaults(opts);
    const report = [];
    for (const run of scanned.runs) {
        // Passada de stale antes de reservar, inclusive proposed/reviewed sem job (OP3-04).
        try { applyStale(run.dir, opts); } catch (e) { ctx.log(`[qa-diagnosis] stale ${path.basename(run.dir)}: ${e.code || e.message}`); }
        const fresh = readState(run.dir, ctx);
        if (!fresh || fresh.status === 'running') continue;
        for (const { e } of run.entries) {
            const key = e.rejection_key;
            const cur = uniqueEntry(fresh, key);
            const blk = cur.entry && cur.entry.diagnosis;
            if (!blk || !model.validateBlock(blk).ok || blk.job !== null || !isEligible(blk.status)) continue;
            if (inBackoff(fresh, key, blk.status, ctx.now())) continue;
            try {
                report.push({ key, ...publishKey(run.dir, key, blk.rev, opts) });
            } catch (err) {
                ctx.log(`[qa-diagnosis] driver ${key}: ${err.code || err.message}`);
            }
        }
    }
    return report;
}

/**
 * Passo de tick (premissa 1): reconciliador antes do driver. Erros não saem do passo.
 * DRY_RUN/SIMULATE são decididos pelo chamador (no-op lá).
 */
function tick(opts = {}) {
    const ctx = defaults(opts);
    const out = { reconcile: [], drive: [] };
    try {
        const scanned = scan(ctx);
        out.reconcile = reconcile(scanned, { ...opts, counters: ctx.counters });
        out.drive = drive(scanned, { ...opts, counters: ctx.counters });
    } catch (e) {
        ctx.log(`[qa-diagnosis] passo falhou (tick segue): ${e.code || e.message}`);
        out.error = e.code || e.message;
    }
    return out;
}

module.exports = {
    LEASE_MS, BACKOFF_MS, MAX_RELOCATE, STAGING_DIR, AUTO_FAILED, DETAIL_RE, _testHooks,
    ticketOfKey, snapshotFromBinding, compareBinding, retryChainProven, bindingOf, mkDetail,
    reserve, produceDeterministic, buildDeterministicVersion, locate, locateActive, locateFenced, quarantineLate,
    commit, failJob, verifyFailJob, applyStale, applySuperseded, scan, reconcile, drive, publishKey, tick,
    isEligible, stagingTreated,
};
