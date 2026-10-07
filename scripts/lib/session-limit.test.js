// node --test scripts/lib/session-limit.test.js
// looksLikeSessionLimit (scripts/readmine-watcher.js) — detecta estouro de janela de
// contexto/tokens da PRÓPRIA sessão no stderr do agente, distinto de
// looksUnavailable (indisponibilidade do provedor: rate limit, 401/429, quota).
// Requerer o watcher direto funciona (a main loop fica atrás de
// `require.main === module`), mas ele precisa de REPO_PATH pra montar caminhos —
// mesmo requisito de scripts/lib/node-dispatcher.js (ensureRepoPath).
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

process.env.REPO_PATH = process.env.REPO_PATH || path.resolve(__dirname, '..', '..');
const { looksLikeSessionLimit, looksUnavailable } = require('../readmine-watcher');

test('looksLikeSessionLimit reconhece as 4 assinaturas de estouro de contexto/tokens', () => {
    assert.strictEqual(looksLikeSessionLimit('Error: context window exceeded for this request'), true);
    assert.strictEqual(looksLikeSessionLimit('max_tokens exceeded'), true);
    assert.strictEqual(looksLikeSessionLimit('token limit reached mid-response'), true);
    assert.strictEqual(looksLikeSessionLimit('session limit hit — aborting'), true);
    assert.strictEqual(looksLikeSessionLimit('CONTEXT WINDOW OVERFLOW'), true, 'case-insensitive');
});

test('looksLikeSessionLimit não bate com texto de build/teste normal', () => {
    assert.strictEqual(looksLikeSessionLimit('BUILD SUCCESS'), false);
    assert.strictEqual(looksLikeSessionLimit('14:19:15,429 INFO [Quarkus] started'), false);
    assert.strictEqual(looksLikeSessionLimit(''), false);
});

test('looksLikeSessionLimit e looksUnavailable são independentes (mesmo com texto sobreposto)', () => {
    // "session limit" está nas duas listas de propósito (ver comentário em
    // SESSION_LIMIT_SIGNATURES) — a checagem nova tem precedência no dispatchTicket,
    // mas as duas funções continuam batendo esse texto individualmente.
    assert.strictEqual(looksLikeSessionLimit('session limit reached'), true);
    assert.strictEqual(looksUnavailable('session limit reached'), true);
    // 401/429/quota são só de looksUnavailable — não são estouro de contexto.
    assert.strictEqual(looksLikeSessionLimit('429 too many requests'), false);
    assert.strictEqual(looksUnavailable('429 too many requests'), true);
});
