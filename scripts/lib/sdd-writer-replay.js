'use strict';
// Writer SDD (PRI-266) — caminho R (W-R): reconhecimento somente leitura por
// op_id + command_sha256 (RRC-SDD-002 §4.2 R1–R4; contrato PRI-231 C-19, C-20; R4-03).
// Não depende de Decision não consumida nem da geração; não cria transição.
// NÃO herda a idempotência do CAS de runs da plataforma (U-02; PRI-264): mesmo id com conteúdo
// diferente é conflito, e a retenção é o log inteiro, sem expurgo.

const { logPath } = require('./sdd-writer-command');
const { parseLog } = require('./sdd-writer-log');

// U-002-4 aberto: sem modelo de direito de leitura, a divulgação é negada a todos.
const U0024_READ_MODEL_DECIDED = false;

/**
 * Reconhecimento interno (usado pelo W-P para decidir as próprias ações).
 * `auditState` vem da C-22 (recalculado pelo chamador). Nunca escreve.
 * → {kind:'REPLAY', entry} | {kind:'CONFLICT', entry} | {kind:'NOT_FOUND'}
 *   | {kind:'BLOCKED', state} (UNKNOWN/VIOLATION) | {kind:'UNVERIFIABLE'}
 */
function recognize({ tree, slug, opId, commandSha256, auditState }) {
    if (auditState === 'UNVERIFIABLE') return { kind: 'UNVERIFIABLE' };
    if (auditState !== 'OK') return { kind: 'BLOCKED', state: auditState };
    const parsed = parseLog(tree.read(logPath(slug)));
    if (parsed.status === 'ABSENT') return { kind: 'NOT_FOUND' };
    if (parsed.status !== 'OK') return { kind: 'BLOCKED', state: 'UNKNOWN' };
    const entry = parsed.entries.find(e => e.op_id === opId);
    if (!entry) return { kind: 'NOT_FOUND' };
    // @guard C20-HASH
    if (entry.command_sha256 !== commandSha256) return { kind: 'CONFLICT', entry };
    // @end C20-HASH
    return { kind: 'REPLAY', entry };
}

/**
 * Resposta ao solicitante (PHI-03): só com direito atual de leitura e modelo decidido.
 * Enquanto a U-002-4 estiver aberta, é NOT_AVAILABLE para tudo, inclusive op_id
 * inexistente, conflito, capability UNKNOWN/VIOLATION ou UNVERIFIABLE (C-19, R4-03).
 */
function disclose(recognition, { readerHasCurrentRight = false } = {}) {
    if (!U0024_READ_MODEL_DECIDED || readerHasCurrentRight !== true) return { response: 'NOT_AVAILABLE' };
    if (recognition.kind === 'REPLAY') return { response: 'REPLAY', result: recognition.entry.result, result_generation: recognition.entry.result_generation };
    if (recognition.kind === 'CONFLICT') return { response: 'CONFLICT' };
    return { response: 'NOT_AVAILABLE' };
}

function replay(args, opts) {
    return disclose(recognize(args), opts);
}

module.exports = { recognize, disclose, replay, U0024_READ_MODEL_DECIDED };
