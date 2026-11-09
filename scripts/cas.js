// Compare-and-set do state.json: o único lugar do codebase que compara o que o caller
// leu (state_version, node, spec_hash, execution_id) com o que está no disco agora.
// Mapa completo das operações protegidas: docs/concurrency-map.md.
//
//   const lock = cas.validateAndLock({ runDir, operation: 'node_transition',
//       expected_state_version: 17, expected_node: 'review' });
//   if (lock.status === 'already_processed') return lock;   // operação humana repetida
//   try { lock.commit({ ...lock.state, node: 'test' }); } finally { lock.release(); }
//
// ou, com try/finally embutido: cas.transact(options, draft => { draft.node = 'test'; }).
//
// Divergência → CASError (STATE_CONFLICT; SESSION_CONFLICT quando o execution_id não é
// mais o da sessão), nada é aplicado e o evento vai para logs/state-conflicts.jsonl
// (append-only, só números, nomes de nó e prefixos de 8 chars — nunca segredo, AC ou
// dado de usuário). Quem grava é scripts/state-writer.js; este módulo só valida.
const fs = require('fs');
const path = require('path');

const STATE_CONFLICT = 'STATE_CONFLICT';
const SESSION_CONFLICT = 'SESSION_CONFLICT';
const CONFLICT_ABORTED = 'STATE_CONFLICT_ABORTED';
const CONFLICT_MESSAGE = 'Este run mudou desde que a tela foi carregada. Atualize antes de executar esta ação.';
const LOG_FILE = 'state-conflicts.jsonl';

// Campos obrigatórios por tipo de operação (tabela do plan, docs/concurrency-map.md).
// Operação fora da tabela (ex.: lease_release) valida só o que vier.
const REQUIRED = {
    node_transition: ['expected_state_version', 'expected_node'],
    agent_retry: ['expected_state_version', 'expected_node'],
    replay: ['expected_state_version', 'expected_node', 'execution_id'],
    resume_session: ['expected_state_version', 'execution_id'],
    human_input: ['expected_state_version', 'operation_id'],
    spec_approval: ['expected_state_version', 'expected_spec_hash', 'operation_id'],
    spec_change_approval: ['expected_state_version', 'expected_spec_hash', 'operation_id'],
    commit: ['expected_state_version', 'expected_node', 'execution_id'],
    archive: ['expected_state_version', 'expected_node', 'execution_id'],
    qa_retry: ['expected_state_version', 'operation_id'],
    // Pedido de autorização (scripts/lib/authorization.js): aprovar/recusar/"já apliquei"
    // e devolver ao QA são só do dashboard, sempre com a versão da tela e o clique.
    authorization_decision: ['expected_state_version', 'operation_id'],
    qa_handback: ['expected_state_version', 'operation_id'],
};

// type gravado em processed_operations[] por operação humana.
const OPERATION_TYPES = {
    human_input: 'HUMAN_INPUT',
    spec_approval: 'SPEC_APPROVAL',
    spec_change_approval: 'SPEC_CHANGE_APPROVAL',
    qa_retry: 'QA_RETRY',
    authorization_decision: 'AUTHORIZATION_DECISION',
    qa_handback: 'QA_HANDBACK',
};

class CASError extends Error {
    constructor(code, { operation = null, conflicts = [], taskId = null, reason = null } = {}) {
        const fields = conflicts.map(c => `${c.field} (esperado ${short(c.field, c.expected)}, atual ${short(c.field, c.actual)})`).join(', ');
        super(`${code}: ${operation || 'operação'} recusada${reason ? ` — ${reason}` : ''}${fields ? ` — ${fields}` : ''}`);
        this.name = 'CASError';
        this.code = code;
        this.operation = operation;
        this.conflicts = conflicts;
        this.taskId = taskId;
    }
}

function isConflict(err) {
    return err instanceof CASError;
}

// Corpo HTTP do 409 (dashboard): mensagem fixa para o humano + campos divergentes.
function httpBody(err) {
    return {
        ok: false, code: err.code, error: CONFLICT_MESSAGE,
        conflicts: (err.conflicts || []).map(c => ({ field: c.field, expected: short(c.field, c.expected), actual: short(c.field, c.actual) })),
    };
}

// ── Leitura dos campos comparados ────────────────────────────────────────────────

function writer() {
    return require('./state-writer'); // lazy: state-writer importa este módulo
}

/** spec_hash vigente do run: o baseline do /plan, ou o do bloco spec versionado. */
function specHashOf(state) {
    return state?.spec_hash ?? state?.spec?.hash ?? null;
}

/**
 * Versão do estado no disco. Edição fora do state-writer (agente com Edit, humano) que
 * mude campo crítico deixa o critical_fingerprint velho: conta como +1, para que um CAS
 * feito contra a leitura anterior a essa edição falhe.
 */
function effectiveVersion(state) {
    if (!state || typeof state !== 'object') return 0;
    const v = Number.isInteger(state.state_version) ? state.state_version : 0;
    const fp = state.critical_fingerprint;
    return typeof fp === 'string' && fp !== writer().criticalFingerprint(state) ? v + 1 : v;
}

function isProcessed(state, operationId) {
    if (operationId == null) return false;
    const list = Array.isArray(state?.processed_operations) ? state.processed_operations : [];
    return list.some(o => o && o.operation_id === operationId);
}

function same(a, b) {
    return (a ?? null) === (b ?? null);
}

// Contador de versão de um registro fora do state.json (PRI-205 S3b: seleção do
// classificador, memory/routing/classifier-selection.json). Mesma regra do resto do
// arquivo: a comparação do que o caller leu com o que está no disco mora só aqui (AC-02).
function isCounter(v) {
    return Number.isInteger(v) && v >= 0;
}

/** @returns {{ ok: true } | { ok: false, code: 'INVALID'|'CONFLICT', expected: any, actual: any }} */
function compareCounter(expected, actual) {
    if (!isCounter(expected)) return { ok: false, code: 'INVALID', expected, actual };
    return expected === actual ? { ok: true } : { ok: false, code: 'CONFLICT', expected, actual };
}

/**
 * Compara as expectativas com o estado atual. Pura (não loga, não lança).
 * @returns {{ code: string|null, conflicts: Array<{field, expected, actual}>, alreadyProcessed: boolean }}
 */
function compare(options, current) {
    const required = REQUIRED[options.operation] || [];
    const missing = required.filter(k => options[k] === undefined);
    if (missing.length) throw new TypeError(`cas: a operação ${options.operation} exige ${missing.join(', ')}`);

    // Idempotência primeiro: a 2ª aprovação do mesmo change_id não é conflito, é repetição.
    if (options.operation_id != null && isProcessed(current, options.operation_id)) {
        return { code: null, conflicts: [], alreadyProcessed: true };
    }
    if (options.execution_id !== undefined && !same(options.execution_id, current?.execution_id)) {
        return {
            code: SESSION_CONFLICT, alreadyProcessed: false,
            conflicts: [{ field: 'execution_id', expected: options.execution_id ?? null, actual: current?.execution_id ?? null }],
        };
    }
    const conflicts = [];
    if (options.expected_state_version !== undefined) {
        const actual = current ? effectiveVersion(current) : null;
        if (options.expected_state_version !== actual) conflicts.push({ field: 'state_version', expected: options.expected_state_version, actual });
    }
    if (options.expected_node !== undefined && !same(options.expected_node, current?.node)) {
        conflicts.push({ field: 'node', expected: options.expected_node, actual: current?.node ?? null });
    }
    if (options.expected_spec_hash !== undefined && !same(options.expected_spec_hash, specHashOf(current))) {
        conflicts.push({ field: 'spec_hash', expected: options.expected_spec_hash, actual: specHashOf(current) });
    }
    if (!current && !conflicts.length) conflicts.push({ field: 'state_version', expected: options.expected_state_version ?? null, actual: null });
    return { code: conflicts.length ? STATE_CONFLICT : null, conflicts, alreadyProcessed: false };
}

/**
 * Valida (sem lock — validateAndLock é quem segura o lock). Conflito → loga e lança.
 * @returns {{status: 'ok'} | {status: 'already_processed', operation_id: string}}
 */
function validate(options, current, { runDir = options.runDir } = {}) {
    const res = compare(options, current);
    if (res.alreadyProcessed) return { status: 'already_processed', operation_id: options.operation_id };
    if (!res.code) return { status: 'ok' };
    const err = new CASError(res.code, { operation: options.operation, conflicts: res.conflicts, taskId: taskIdOf(runDir) });
    logConflict(conflictEntry(err, options, current), { runDir });
    throw err;
}

/**
 * Escrita de objeto inteiro (state-writer.write) feita a partir de uma leitura antiga:
 * se o disco andou (state_version maior) e o objeto novo diverge dele em campo crítico,
 * gravar desfaria a transição de outro processo → STATE_CONFLICT. Divergência só em
 * campo secundário passa (heartbeat, eventos, custo: sem conflito falso).
 */
function assertFreshBase(next, current, { runDir = null, operation = 'write', actor = null } = {}) {
    if (!current || !next) return;
    const base = Number.isInteger(next.state_version) ? next.state_version : 0;
    const disk = Number.isInteger(current.state_version) ? current.state_version : 0;
    if (base >= disk) return;
    const fields = writer().changedCriticalFields(current, next);
    if (!fields.length) return;
    const snap = writer().criticalSnapshot;
    const a = snap(current);
    const b = snap(next);
    const conflicts = [{ field: 'state_version', expected: base, actual: disk },
        ...fields.map(f => ({ field: f, expected: b[f] ?? null, actual: a[f] ?? null }))];
    const err = new CASError(STATE_CONFLICT, { operation, conflicts, taskId: taskIdOf(runDir), reason: 'escrita baseada em leitura obsoleta' });
    logConflict(conflictEntry(err, { operation, actor, expected_state_version: base, expected_node: next.node }, current), { runDir });
    throw err;
}

/**
 * Escrita de sistema com a leitura-base conhecida (state-writer.write com `base`): o
 * disco andou desde a base. Conflito real = campo crítico que OUTRO processo mudou
 * (atual ≠ base) e com o qual este escritor discorda (novo ≠ atual). Campo crítico que
 * só este escritor mudou, ou que os dois deixaram igual, não é conflito: o writer
 * reaplica o delta sobre o disco fresco (a re-tentativa única da política de sistema).
 */
function assertRebasable(base, next, current, { runDir = null, operation = 'write', actor = null } = {}) {
    if (!current) return;
    const snap = writer().criticalSnapshot;
    const b = snap(base);
    const n = snap(next);
    const c = snap(current);
    const eq = (x, y) => JSON.stringify(x) === JSON.stringify(y);
    const fields = Object.keys(c).filter(f => !eq(c[f], b[f]) && !eq(n[f], c[f]));
    if (!fields.length) return;
    const conflicts = [{ field: 'state_version', expected: effectiveVersion(base), actual: effectiveVersion(current) },
        ...fields.map(f => ({ field: f, expected: n[f] ?? null, actual: c[f] ?? null }))];
    const err = new CASError(STATE_CONFLICT, { operation, conflicts, taskId: taskIdOf(runDir), reason: 'outro processo mudou o mesmo campo crítico' });
    logConflict(conflictEntry(err, { operation, actor, expected_state_version: effectiveVersion(base), expected_node: next.node }, current), { runDir });
    throw err;
}

/**
 * Escrita com base (state-writer.write) num run que não existe mais: foi arquivado ou
 * movido depois da leitura. Gravar recriaria a pasta em memory/runs — o escritor está
 * obsoleto por definição (a base tinha state_version; o disco não tem nada).
 */
function runGoneConflict(base, { runDir = null, operation = 'write', actor = null } = {}) {
    const expected = effectiveVersion(base);
    const err = new CASError(STATE_CONFLICT, {
        operation, taskId: taskIdOf(runDir), reason: 'run arquivado/movido depois da leitura — escrita obsoleta recusada',
        conflicts: [{ field: 'state_version', expected, actual: null }],
    });
    logConflict(conflictEntry(err, { operation, actor, expected_state_version: expected }, null), { runDir });
    return err;
}

// ── Lock + validação + escrita ───────────────────────────────────────────────────

/**
 * Pega o lock do state.json do run, relê o disco e valida. Devolve:
 *   { status: 'already_processed', operation_id }  (lock já liberado), ou
 *   { status: 'locked', state, commit(next, {record}), release() }.
 * Conflito: libera o lock, loga e lança CASError. O caller SEMPRE chama release().
 */
function validateAndLock(options) {
    const sw = writer();
    const { runDir } = options;
    if (!runDir) throw new TypeError('cas.validateAndLock: runDir obrigatório');
    const file = sw.statePath(runDir);
    const unlock = sw.acquireLock(file);
    let released = false;
    const release = () => { if (!released) { released = true; unlock(); } };
    try {
        const { state: current, token } = sw.readWithToken(file);
        const res = validate(options, current, { runDir });
        if (res.status === 'already_processed') { release(); return res; }
        return {
            status: 'locked',
            state: current ? structuredClone(current) : null,
            current,
            commit(next, { record = true } = {}) {
                if (released) throw new Error('cas: commit depois do release');
                if (record && options.operation_id != null) markProcessed(next, options);
                try {
                    return sw.writeLocked(file, next, current, { token });
                } catch (e) {
                    if (e.code !== sw.EXTERNAL_WRITE) throw e;
                    // Escritor fora do lock mexeu no state.json depois da validação.
                    const err = new CASError(STATE_CONFLICT, { operation: options.operation, taskId: taskIdOf(runDir), reason: 'state.json alterado fora do state-writer durante a operação', conflicts: [{ field: 'state_version', expected: effectiveVersion(current), actual: effectiveVersion(sw.readFile(file)) }] });
                    logConflict(conflictEntry(err, options, sw.readFile(file)), { runDir });
                    throw err;
                }
            },
            release,
        };
    } catch (e) {
        release();
        throw e;
    }
}

function markProcessed(next, options) {
    const list = Array.isArray(next.processed_operations) ? next.processed_operations : [];
    if (list.some(o => o && o.operation_id === options.operation_id)) return;
    next.processed_operations = [...list, {
        operation_id: options.operation_id,
        type: OPERATION_TYPES[options.operation] || String(options.operation || 'OPERATION').toUpperCase(),
        processed_at: new Date().toISOString(),
    }];
}

const SKIP = Symbol('cas.skip');

/**
 * validateAndLock + mutator + commit + release. O mutator recebe uma cópia do estado
 * fresco (pode mutar e não devolver nada, devolver um objeto novo, ou cas.SKIP).
 * @returns {{status: 'applied', state} | {status: 'already_processed', operation_id} | {status: 'skipped'}}
 */
function transact(options, mutator) {
    const lock = validateAndLock(options);
    if (lock.status === 'already_processed') return lock;
    try {
        const draft = lock.state ? structuredClone(lock.state) : {};
        const out = mutator(draft, lock.current);
        if (out === SKIP) return { status: 'skipped' };
        const next = out && typeof out === 'object' ? out : draft;
        return { status: 'applied', state: lock.commit(next) };
    } finally {
        lock.release();
    }
}

// ── Operação humana com efeito externo (reserva em duas fases) ───────────────────
//
// O efeito (ex.: comentário no Redmine) é assíncrono e não cabe dentro do lock. A
// decisão de consumir o operation_id, sim: reserveOperation valida (CAS + idempotência)
// e grava a reserva em pending_operations[] na MESMA seção crítica — de N pedidos
// simultâneos com o mesmo operation_id, um reserva e os outros veem in_progress.
// finishOperation registra o desfecho: done → processed_operations[]; failed (o efeito
// certamente não aconteceu) → reserva removida; uncertain (pode ter acontecido) →
// reserva marcada, retomável na hora. Reserva retomada (uncertain, ou vencida por crash
// do dono) volta com reclaimed: true — o caller confere o efeito externo antes de
// repetir. pending_operations é campo secundário: não mexe em state_version.

const RESERVATION_TTL_MS = 120_000;

function pendingOf(state) {
    return Array.isArray(state?.pending_operations) ? state.pending_operations.filter(r => r && r.operation_id) : [];
}

/**
 * @returns {{status: 'already_processed'} | {status: 'in_progress', reservation} |
 *           {status: 'reserved', reclaimed: boolean, previous: object|null}}
 */
function reserveOperation(options, { ttlMs = RESERVATION_TTL_MS, now: fixedNow = null } = {}) {
    if (options.operation_id == null) throw new TypeError('cas.reserveOperation: operation_id obrigatório');
    const lock = validateAndLock(options);
    if (lock.status === 'already_processed') return lock;
    try {
        // Relógio lido COM o lock na mão: lido antes da espera, a reserva de quem entrou
        // primeiro pareceria do futuro (idade negativa) e seria retomada — duas reservas.
        const now = fixedNow ?? Date.now();
        const list = pendingOf(lock.state);
        const prev = list.find(r => r.operation_id === options.operation_id) || null;
        const age = prev ? now - Date.parse(prev.reserved_at) : Infinity;
        if (prev && !prev.uncertain && age < ttlMs) return { status: 'in_progress', reservation: prev };
        const next = lock.state;
        next.pending_operations = [...list.filter(r => r !== prev), {
            operation_id: options.operation_id,
            type: OPERATION_TYPES[options.operation] || String(options.operation || 'OPERATION').toUpperCase(),
            reserved_at: new Date(now).toISOString(), pid: process.pid,
        }];
        lock.commit(next, { record: false });
        return { status: 'reserved', reclaimed: !!prev, previous: prev };
    } finally {
        lock.release();
    }
}

/**
 * Desfecho de uma reserva. Sem CAS de versão (a decisão foi tomada na reserva; o run
 * pode ter andado durante o efeito). Run arquivado → null.
 * @param {'done'|'failed'|'uncertain'} outcome
 */
function finishOperation({ runDir, operation, operation_id, actor = null }, outcome) {
    if (!['done', 'failed', 'uncertain'].includes(outcome)) throw new TypeError(`cas.finishOperation: desfecho inválido ${outcome}`);
    return writer().update(runDir, s => {
        const list = pendingOf(s);
        const mine = list.find(r => r.operation_id === operation_id);
        if (outcome === 'done') {
            markProcessed(s, { operation, operation_id });
            s.pending_operations = list.filter(r => r !== mine);
        } else if (!mine) {
            return SKIP;
        } else if (outcome === 'failed') {
            s.pending_operations = list.filter(r => r !== mine);
        } else {
            mine.uncertain = true;
            mine.uncertain_at = new Date().toISOString();
            s.pending_operations = list;
        }
        if (!s.pending_operations.length) delete s.pending_operations;
    }, { operation: `${operation}_finish`, actor });
}

/**
 * Política de retry das operações do agente/sistema: STATE_CONFLICT → relê, pergunta a
 * `revalidate(fresh)` se a operação ainda faz sentido (devolve as expectativas novas ou
 * null) e tenta UMA vez. Segunda falha, ou operação que não faz mais sentido → aborta,
 * loga STATE_CONFLICT_ABORTED e relança. SESSION_CONFLICT nunca é re-tentado (a sessão
 * perdeu a posse). Operação humana não usa isto — devolve 409 para o dashboard.
 */
function transactWithRetry(options, mutator, { revalidate }) {
    try {
        return transact(options, mutator);
    } catch (e) {
        if (!isConflict(e) || e.code !== STATE_CONFLICT) throw e;
        const fresh = writer().read(options.runDir);
        const again = fresh ? revalidate(fresh) : null;
        if (!again) {
            logConflict(abortEntry(options, 'a operação não faz mais sentido no estado atual'), { runDir: options.runDir });
            throw e;
        }
        try {
            return transact({ ...options, ...again }, mutator);
        } catch (e2) {
            if (isConflict(e2)) logConflict(abortEntry(options, 'conflito de novo na re-tentativa'), { runDir: options.runDir });
            throw e2;
        }
    }
}

/**
 * Expectativas de uma operação: as do caller (`overrides`, só as informadas) por cima das
 * do estado lido agora (`snapshot`). Chave ausente/undefined em `overrides` = usa a lida.
 */
function expectations(snapshot, overrides = null) {
    const out = { ...snapshot };
    for (const [k, v] of Object.entries(overrides || {})) if (v !== undefined) out[k] = v;
    return out;
}

/** Expectativas atuais de um estado (o que a tela/sessão "carregou"). */
function snapshotOf(state) {
    return {
        expected_state_version: effectiveVersion(state),
        expected_node: state?.node ?? null,
        expected_spec_hash: specHashOf(state),
        execution_id: state?.execution_id ?? null,
    };
}

// ── Auditoria (logs/state-conflicts.jsonl) ───────────────────────────────────────

function taskIdOf(runDir) {
    return runDir ? path.basename(path.resolve(String(runDir).replace(/[\\/]state\.json$/, ''))) : null;
}

/**
 * Checkout principal dono do run: <root>/memory/runs/<task> ou
 * <root>/.claude/worktrees/<id>/memory/runs/<task> → <root>. Fora desse layout, a raiz
 * deste repositório.
 */
function mainRootOf(runDir) {
    const abs = path.resolve(String(runDir || '.'));
    const marker = `${path.sep}memory${path.sep}runs`;
    const i = abs.indexOf(marker);
    let root = i === -1 ? (process.env.REPO_PATH || process.cwd()) : abs.slice(0, i);
    const wt = root.indexOf(`${path.sep}.claude${path.sep}worktrees${path.sep}`);
    if (wt !== -1) root = root.slice(0, wt);
    return root;
}

function logPath(runDir) {
    return process.env.STATE_CONFLICTS_LOG || path.join(mainRootOf(runDir), 'logs', LOG_FILE);
}

function short(field, v) {
    if (v == null) return null;
    if (field === 'spec_hash' || field === 'execution_id' || /hash/.test(field)) return String(v).slice(0, 8);
    return v;
}

// Só campos conhecidos: nunca o estado inteiro (ACs, notas, human_inputs ficam de fora).
function conflictEntry(err, options, current) {
    const entry = {
        event: err.code, timestamp: new Date().toISOString(), operation: options.operation || err.operation || null,
        task_id: err.taskId, actor: options.actor || null, pid: process.pid,
    };
    if (options.expected_state_version !== undefined) {
        entry.expected_state_version = options.expected_state_version;
        entry.actual_state_version = current ? effectiveVersion(current) : null;
    }
    if (options.expected_node !== undefined) {
        entry.expected_node = options.expected_node ?? null;
        entry.actual_node = current?.node ?? null;
    }
    if (options.expected_spec_hash !== undefined) {
        entry.expected_spec_hash = short('spec_hash', options.expected_spec_hash);
        entry.actual_spec_hash = short('spec_hash', specHashOf(current));
    }
    if (options.execution_id !== undefined) {
        entry.expected_execution_id = short('execution_id', options.execution_id);
        entry.actual_execution_id = short('execution_id', current?.execution_id);
    }
    if (options.operation_id != null) entry.operation_id = String(options.operation_id).slice(0, 64);
    entry.conflicting_fields = err.conflicts.map(c => c.field);
    return entry;
}

function abortEntry(options, reason) {
    return {
        event: CONFLICT_ABORTED, timestamp: new Date().toISOString(), operation: options.operation || null,
        task_id: taskIdOf(options.runDir), actor: options.actor || null, pid: process.pid, reason,
    };
}

/** Append-only (O_APPEND, uma linha por evento). Falha de log nunca derruba a operação. */
function logConflict(entry, { runDir = null } = {}) {
    try {
        const file = logPath(runDir);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.appendFileSync(file, `${JSON.stringify(entry)}\n`, { flag: 'a' });
    } catch (e) {
        console.error(`[cas] falha gravando ${LOG_FILE}: ${e.message}`);
    }
    return entry;
}

module.exports = {
    STATE_CONFLICT, SESSION_CONFLICT, CONFLICT_ABORTED, CONFLICT_MESSAGE, LOG_FILE, REQUIRED, OPERATION_TYPES, SKIP,
    CASError, isConflict, httpBody,
    specHashOf, effectiveVersion, isProcessed, compare, validate, assertFreshBase, assertRebasable,
    isCounter, compareCounter,
    validateAndLock, transact, transactWithRetry, snapshotOf, expectations,
    runGoneConflict, reserveOperation, finishOperation, RESERVATION_TTL_MS,
    logConflict, logPath, mainRootOf, taskIdOf,
};
