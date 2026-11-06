'use strict';
// Writer SDD (PRI-266) — porta de Decision (contrato PRI-231 C-18; D-231-4 A).
//   resolveDecision(decision_ref, at_commit) → { state, approving, command_sha256,
//     authorized_op_id | request_id, approver_id, approver_current_right, record_digest }
// Só leitura. Qualquer campo indeterminado → recusa. Exceção/timeout da porta = falha
// de obtenção (UNVERIFIABLE, transitória); resposta obtida e negativa = FAIL definitivo.
// Adaptador produtivo: UNKNOWN (fonte PHI não conforme; U-002-9). Aqui só existe o
// adaptador de TESTE, e ele nunca lê a árvore candidata do PR (M-02): só `at_commit`.

const { RE_HEX64, RE_ID } = require('./sdd-writer-command');

class DecisionPortError extends Error {
    constructor(message) { super(message); this.name = 'DecisionPortError'; }
}

const STATES = ['DECIDED', 'EXPIRED', 'SUPERSEDED', 'UNKNOWN'];

/** Normaliza/valida a resposta da porta. Campo ausente ou indeterminado → {valid:false}. */
function checkRecord(r) {
    if (!r || typeof r !== 'object') return { valid: false, reason: 'NO_RECORD' };
    if (!STATES.includes(r.state)) return { valid: false, reason: 'STATE_INDETERMINATE' };
    if (typeof r.approving !== 'boolean') return { valid: false, reason: 'APPROVING_INDETERMINATE' };
    if (typeof r.command_sha256 !== 'string' || !RE_HEX64.test(r.command_sha256)) return { valid: false, reason: 'HASH_INDETERMINATE' };
    const hasOp = typeof r.authorized_op_id === 'string' && RE_ID.test(r.authorized_op_id);
    const hasReq = typeof r.request_id === 'string' && RE_ID.test(r.request_id);
    if (hasOp === hasReq) return { valid: false, reason: 'OP_BINDING_INDETERMINATE' };
    if (typeof r.approver_id !== 'string' || !RE_ID.test(r.approver_id)) return { valid: false, reason: 'APPROVER_INDETERMINATE' };
    if (![true, false, 'UNKNOWN'].includes(r.approver_current_right)) return { valid: false, reason: 'RIGHT_INDETERMINATE' };
    if (typeof r.record_digest !== 'string' || !RE_HEX64.test(r.record_digest)) return { valid: false, reason: 'DIGEST_INDETERMINATE' };
    return { valid: true };
}

/**
 * Adaptador SÓ DE TESTE. `records`: { [decision_ref]: record | (atCommit) => record }.
 * `fail`: { [decision_ref]: 'throw' } simula exceção/timeout. `calls` registra as consultas.
 */
function createTestDecisionPort(records = {}, { fail = {} } = {}) {
    const calls = [];
    return {
        calls,
        async resolveDecision(ref, atCommit) {
            calls.push({ ref, atCommit });
            if (fail[ref] === 'throw' || fail['*'] === 'throw') throw new DecisionPortError(`porta indisponível para ${ref}`);
            const r = records[ref];
            if (r === undefined) return { state: 'UNKNOWN' };
            return typeof r === 'function' ? r(atCommit) : r;
        },
    };
}

/**
 * Adaptador SÓ DE TESTE lido de objetos Git em `at_commit` (para o caso M-02): registros em
 * `<dir>/<decision_ref>.json`. Ler `at_commit` = base nunca enxerga o que o PR adiciona.
 */
function createTreeDecisionPort(git, dir) {
    const calls = [];
    return {
        calls,
        async resolveDecision(ref, atCommit) {
            calls.push({ ref, atCommit });
            const bytes = git.readBlob(atCommit, `${dir}/${ref.replace(/[^A-Za-z0-9._-]/g, '_')}.json`);
            if (bytes === null) return { state: 'UNKNOWN' };
            return JSON.parse(bytes.toString('utf8'));
        },
    };
}

module.exports = { checkRecord, createTestDecisionPort, createTreeDecisionPort, DecisionPortError, STATES };
