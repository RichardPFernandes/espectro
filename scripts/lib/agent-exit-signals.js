// Sinais de saída do agente (texto da saída), extraídos do watcher sem mudança de texto nem
// de assinatura (PRI-311 / S5.2a, H2), para o wrapper destacado (node-lease.js release) e o
// DOM-06 usarem a mesma classificação do --follow.
//
// UNAVAILABLE_SIGNATURES: o CLAUDE (não a tarefa) está indisponível agora — limite de
// conta/uso, erro de autenticação. Encontrado ao vivo validando o orquestrador (ticket
// #43425). `\b429\b` isolado foi removido depois de um falso positivo real ("14:19:15,429",
// milissegundos num log de build do Quarkus): todo padrão aqui precisa de contexto textual
// específico o bastante para não colidir com números soltos em log de build/teste.
//
// SESSION_LIMIT_SIGNATURES: estouro de janela de contexto/tokens da PRÓPRIA sessão. "session
// limit" aparece nas duas listas de propósito — texto igual, ação diferente — e esta lista
// tem precedência (ver dispatchTicket no watcher).

const UNAVAILABLE_SIGNATURES = [
    /session limit/i, /usage limit/i, /rate limit exceeded/i, /quota exceeded/i,
    /401 unauthorized/i, /missing bearer/i, /429 too many requests/i,
];
function looksUnavailable(output) {
    return UNAVAILABLE_SIGNATURES.some(re => re.test(output));
}

const SESSION_LIMIT_SIGNATURES = [
    /context window/i, /max_tokens/i, /token limit/i, /session limit/i,
];
function looksLikeSessionLimit(stderrText) {
    return SESSION_LIMIT_SIGNATURES.some(re => re.test(stderrText));
}

/**
 * Causa operacional de uma saída com erro (PRI-311, H2). Mesma precedência do watcher:
 * session_limit (stderr) antes de indisponibilidade (saída). exit 0 → null.
 * Sem texto para inspecionar → AGENT_FAILURE (conta no teto; lado conservador).
 * @returns {'SESSION_LIMIT'|'PROVIDER_UNAVAILABLE'|'AGENT_FAILURE'|null}
 */
function operationalCause({ code, output = '', stderr = '' } = {}) {
    if (code !== null && code !== undefined && code !== '' && Number(code) === 0) return null;
    if (stderr && looksLikeSessionLimit(stderr)) return 'SESSION_LIMIT';
    if (output && looksUnavailable(output)) return 'PROVIDER_UNAVAILABLE';
    return 'AGENT_FAILURE';
}

module.exports = {
    UNAVAILABLE_SIGNATURES, SESSION_LIMIT_SIGNATURES,
    looksUnavailable, looksLikeSessionLimit, operationalCause,
};
