// Retry genérico com exponential backoff + jitter. Só stdlib — sem dependência de
// cliente HTTP. Quem decide o que é "transiente" é o chamador (retryOn); o default
// isTransientError cobre o caso Redmine (ver scripts/lib/redmine-fetch.js).

const sleepMs = ms => new Promise(r => setTimeout(r, ms));

async function withRetry(fn, options = {}) {
    const {
        maxAttempts = 3,
        baseDelayMs = 1000,
        maxDelayMs = 30000,
        retryOn = () => true,
        // Espera mínima sugerida pelo erro (ex.: Retry-After de um 429), em ms.
        minDelayFor = () => 0,
        log = console.warn,
        sleep = sleepMs,
    } = options;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            return await fn(attempt);
        } catch (err) {
            if (attempt >= maxAttempts || !retryOn(err)) throw err;
            const backoff = Math.min(baseDelayMs * 2 ** (attempt - 1), maxDelayMs);
            const jitter = Math.random() * backoff * 0.2; // até +20%, evita retries sincronizados
            const delay = Math.round(Math.min(Math.max(backoff + jitter, minDelayFor(err) || 0), maxDelayMs));
            log(`[retry] Tentativa ${attempt}/${maxAttempts} falhou: ${err && err.message}. Aguardando ${delay}ms...`);
            await sleep(delay);
        }
    }
}

// Status HTTP / códigos de rede que valem retry. 401/403/404/422 NUNCA: são erro de
// auth ou de lógica — repetir só gera loop sem sentido.
const TRANSIENT_HTTP = new Set([429, 503, 504]);
const TRANSIENT_NET = new Set(['ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET']);

function isTransientError(err) {
    if (!err) return false;
    const status = Number(err.statusCode ?? err.status);
    if (Number.isInteger(status) && status > 0) return TRANSIENT_HTTP.has(status);
    // fetch (undici) embrulha o erro de rede: TypeError('fetch failed') com .cause.code.
    const code = err.code || err.cause?.code;
    if (code && TRANSIENT_NET.has(code)) return true;
    if (err.name === 'TimeoutError') return true;
    return /timeout/i.test(err.message || '');
}

module.exports = { withRetry, isTransientError, TRANSIENT_HTTP, TRANSIENT_NET };
