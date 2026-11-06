'use strict';
// Writer SDD (PRI-266) — codec do log.json = JCS(array) e estado derivado.
// Fontes: RRC-SDD-002 §4.5 (bytes, log vazio), PR §5.1/§5.4 (estado derivado),
// RRC-SDD-003 §4.3 (INC, no-op, version_head), RRC-SDD-001 §4.2 (alias/tombstone),
// contrato PRI-231 r4 C-15 (append parcial), C-17 (ausência), C-22 (precedência r4).

const { canonicalBytes, parseStrict, JcsError } = require('./sdd-writer-jcs');
const { validateEntry, CommandError } = require('./sdd-writer-command');

// R4-N1: VIOLATION > UNKNOWN > UNVERIFIABLE > OK.
const RANK = { OK: 0, UNVERIFIABLE: 1, UNKNOWN: 2, VIOLATION: 3 };
const worst = (...states) => states.reduce((a, b) => (RANK[b] > RANK[a] ? b : a), 'OK');

/**
 * log.json → {status:'ABSENT'} | {status:'OK', entries} | {status:'UNKNOWN', reason}.
 * Bytes não canônicos, `[]`, entrada fora do schema ou geração fora de sequência → UNKNOWN.
 */
function parseLog(bytes) {
    if (bytes === null || bytes === undefined) return { status: 'ABSENT' };
    let arr;
    try {
        arr = parseStrict(bytes);
    } catch (e) {
        if (e instanceof JcsError) return { status: 'UNKNOWN', reason: `LOG_UNREADABLE:${e.reason}` };
        throw e;
    }
    // @guard LOG-CANON
    if (!canonicalBytes(arr).equals(Buffer.from(bytes))) return { status: 'UNKNOWN', reason: 'LOG_NON_CANONICAL' };
    // @end LOG-CANON
    if (!Array.isArray(arr)) return { status: 'UNKNOWN', reason: 'LOG_NOT_ARRAY' };
    if (arr.length === 0) return { status: 'UNKNOWN', reason: 'LOG_EMPTY_ARRAY' };
    const seen = new Set();
    for (let i = 0; i < arr.length; i++) {
        try { validateEntry(arr[i]); } catch (e) {
            if (e instanceof CommandError) return { status: 'UNKNOWN', reason: `ENTRY_${i + 1}_${e.reason}` };
            throw e;
        }
        if (arr[i].result_generation !== i + 1) return { status: 'UNKNOWN', reason: 'GENERATION_SEQUENCE' };
        if (seen.has(arr[i].op_id)) return { status: 'UNKNOWN', reason: 'DUPLICATE_OP_IN_LOG' };
        seen.add(arr[i].op_id);
    }
    return { status: 'OK', entries: arr };
}

/** Bytes do log depois do append de `entry` (RRC-SDD-002 §4.5). */
function appendBytes(oldBytes, entry) {
    const e = canonicalBytes(entry);
    if (oldBytes === null) return Buffer.concat([Buffer.from('['), e, Buffer.from(']')]);
    return Buffer.concat([oldBytes.subarray(0, oldBytes.length - 1), Buffer.from(','), e, Buffer.from(']')]);
}

/**
 * V-2: `new` é exatamente `old[:-1] + "," + JCS(e) + "]"` (ou `"[" + JCS(e) + "]"`).
 * → {ok:true, entry} | {ok:false, code:'VIOLATION'|'LOG_BYTES', reason}
 */
function splitAppend(oldBytes, newBytes) {
    if (newBytes === null) return { ok: false, code: 'VIOLATION', reason: 'LOG_REMOVED' };
    const parsedNew = parseLog(newBytes);
    if (parsedNew.status !== 'OK') return { ok: false, code: 'LOG_BYTES', reason: parsedNew.reason };
    if (oldBytes === null) {
        // Defesa em profundidade: sem esta linha, V-8/V-9 ainda recusam (sem sabotagem isolável).
        if (parsedNew.entries.length !== 1) return { ok: false, code: 'LOG_BYTES', reason: 'FIRST_APPEND_NOT_SINGLE' };
        return { ok: true, entry: parsedNew.entries[parsedNew.entries.length - 1], entries: parsedNew.entries };
    }
    const parsedOld = parseLog(oldBytes);
    if (parsedOld.status !== 'OK') return { ok: false, code: 'LOG_BYTES', reason: `OLD_${parsedOld.reason}` };
    // @guard APPEND-PREFIX
    const head = oldBytes.subarray(0, oldBytes.length - 1);
    if (newBytes.length <= oldBytes.length || !newBytes.subarray(0, head.length).equals(head)) {
        return { ok: false, code: 'VIOLATION', reason: 'PREFIX_NOT_PRESERVED' };
    }
    // @end APPEND-PREFIX
    // @guard APPEND-ONE
    if (parsedNew.entries.length !== parsedOld.entries.length + 1) {
        return { ok: false, code: 'LOG_BYTES', reason: 'NOT_EXACTLY_ONE_ENTRY' };
    }
    const expect = appendBytes(oldBytes, parsedNew.entries[parsedNew.entries.length - 1]);
    if (!expect.equals(newBytes)) return { ok: false, code: 'LOG_BYTES', reason: 'NOT_A_PURE_APPEND' };
    // @end APPEND-ONE
    return { ok: true, entry: parsedNew.entries[parsedNew.entries.length - 1], entries: parsedNew.entries };
}

/**
 * C-17: log ausente só é geração 0 sem âncora e sem histórico do arquivo.
 * → 'OK' | 'VIOLATION'
 */
function absenceVerdict({ hasAnchors, everInHistory }) {
    // @guard ABSENCE
    if (hasAnchors || everInHistory) return 'VIOLATION';
    // @end ABSENCE
    return 'OK';
}

// ---------------- estado derivado e transições ----------------

const emptyState = () => ({
    generation: 0, active: null, version_head: null, versions: {}, archived: false,
    aliases: { vigentes: [], retired: [], unknown: false },
});

const sameActive = (a, b) => (a === null && b === null)
    || (a !== null && b !== null && a.cap_version === b.cap_version && a.cap_hash === b.cap_hash);
const aliasKey = a => `${a.kind}\u0000${a.value}`;

function clone(s) { return JSON.parse(JSON.stringify(s)); }

/**
 * Aplica `command` ao estado (V-8 pré-condições → STALE; coerência → DERIVED).
 * `editResolver(edit_sha256)` → {add:[{kind,value}], retire:[{kind,value}]} | null.
 * → {ok:true, next, result} | {ok:false, code, reason}
 */
function applyCommand(state, command, { editResolver = null, strictEdit = true } = {}) {
    const p = command.approved_payload;
    // @guard V-8-GEN
    if (command.expected_generation !== state.generation) return { ok: false, code: 'STALE', reason: 'EXPECTED_GENERATION' };
    // @end V-8-GEN
    const next = clone(state);
    next.generation = state.generation + 1;
    let result;
    switch (command.op) {
        case 'INC': {
            const head = state.version_head;
            const baseOk = head === null
                ? p.base_version === null && p.base_hash === null
                : p.base_version === head.cap_version && p.base_hash === head.cap_hash;
            if (!baseOk) return { ok: false, code: 'STALE', reason: 'INC_BASE' };
            if (head !== null && p.target_hash === head.cap_hash) {
                if (p.target_version !== head.cap_version) return { ok: false, code: 'DERIVED', reason: 'NOOP_TARGET_VERSION' };
                next.version_head = { cap_version: head.cap_version, cap_hash: head.cap_hash, spec_sha256: p.target_spec_sha256 };
                result = 'inc_no_contract_change';
            } else {
                const want = (head ? head.cap_version : 0) + 1;
                if (p.target_version !== want) return { ok: false, code: 'DERIVED', reason: 'TARGET_VERSION' };
                next.versions[String(want)] = { cap_hash: p.target_hash, spec_sha256: p.target_spec_sha256 };
                next.version_head = { cap_version: want, cap_hash: p.target_hash, spec_sha256: p.target_spec_sha256 };
                result = 'inc_version_created';
            }
            break;
        }
        case 'ACTIVATE':
        case 'REACTIVATE': {
            if (!sameActive(p.expected_active, state.active)) return { ok: false, code: 'STALE', reason: 'EXPECTED_ACTIVE' };
            if (command.op === 'REACTIVATE' && state.active === null) return { ok: false, code: 'STALE', reason: 'REACTIVATE_WITHOUT_ACTIVE' };
            const v = state.versions[String(p.target_version)];
            if (!v || v.cap_hash !== p.target_hash) return { ok: false, code: 'STALE', reason: 'TARGET_NOT_A_VERSION' };
            next.active = { cap_version: p.target_version, cap_hash: p.target_hash };
            result = command.op === 'ACTIVATE' ? 'activated' : 'reactivated';
            break;
        }
        case 'ARCHIVE': {
            if (!sameActive(p.expected_active, state.active)) return { ok: false, code: 'STALE', reason: 'EXPECTED_ACTIVE' };
            next.active = null;
            next.archived = true;
            result = 'archived';
            break;
        }
        case 'EDIT_ALIASES_SOURCES': {
            const edit = editResolver ? editResolver(p.edit_sha256) : null;
            if (!edit) {
                if (strictEdit) return { ok: false, code: 'DERIVED', reason: 'EDIT_BYTES_UNRESOLVED' };
                next.aliases.unknown = true;
                result = 'aliases_sources_edited';
                break;
            }
            const vig = new Map(next.aliases.vigentes.map(a => [aliasKey(a), a]));
            const retiredKeys = new Set(next.aliases.retired.map(aliasKey));
            for (const a of edit.retire || []) {
                if (!vig.has(aliasKey(a))) return { ok: false, code: 'DERIVED', reason: 'RETIRE_NOT_VIGENTE' };
                vig.delete(aliasKey(a));
                next.aliases.retired.push({ kind: a.kind, value: a.value });
            }
            for (const a of edit.add || []) {
                if (retiredKeys.has(aliasKey(a)) || next.aliases.retired.some(r => aliasKey(r) === aliasKey(a))) {
                    return { ok: false, code: 'ALIAS', reason: 'RETIRED_ALIAS_NEVER_REACTIVATED' };
                }
                if (vig.has(aliasKey(a))) return { ok: false, code: 'DERIVED', reason: 'ALIAS_ALREADY_VIGENTE' };
                vig.set(aliasKey(a), { kind: a.kind, value: a.value });
            }
            next.aliases.vigentes = [...vig.values()].sort((x, y) => (aliasKey(x) < aliasKey(y) ? -1 : 1));
            result = 'aliases_sources_edited';
            break;
        }
        default:
            return { ok: false, code: 'COMMAND', reason: 'OP' };
    }
    return { ok: true, next, result };
}

/** Estado derivado de um log já parseado. Entrada incoerente → {ok:false}. */
function deriveState(entries, { editResolver = null, strictEdit = false } = {}) {
    let s = emptyState();
    for (const e of entries) {
        const r = applyCommand(s, e.command, { editResolver, strictEdit });
        if (!r.ok) return { ok: false, code: r.code, reason: `${e.op_id}:${r.reason}` };
        if (r.result !== e.result || e.result_generation !== r.next.generation) return { ok: false, code: 'DERIVED', reason: `${e.op_id}:RESULT` };
        s = r.next;
    }
    return { ok: true, state: s };
}

module.exports = {
    RANK, worst, parseLog, appendBytes, splitAppend, absenceVerdict,
    emptyState, applyCommand, deriveState, sameActive, aliasKey,
};
