// fetch pro Redmine com throttle + retry com backoff. Mesma assinatura e mesmo retorno
// do fetch global (Response) — os call sites continuam checando res.ok como antes; só
// ganham resiliência a falha transiente e deixam de mandar burst pro Redmine do M&O.
//
// - Throttle: intervalo mínimo entre o INÍCIO de duas chamadas no mesmo processo
//   (REDMINE_MIN_INTERVAL_MS, padrão 500). A vaga é reservada de forma síncrona, então
//   chamadas concorrentes também saem espaçadas. Cada tentativa de retry passa por ele.
// - Retry: 429/503/504 e erro de rede transiente (ver isTransientError em ../retry.js),
//   até REDMINE_RETRY_MAX_ATTEMPTS (padrão 3), backoff a partir de
//   REDMINE_RETRY_BASE_DELAY_MS (padrão 1000). 401/403/404/422 voltam na hora, sem retry.
// - Método não-GET (PUT com notes, ex.) só repete quando o Redmine seguramente NÃO
//   processou (429, 503, ENOTFOUND). Timeout/ECONNRESET/504 podem ter gravado o
//   comentário — repetir duplicaria a nota no ticket.
// - signal do chamador (AbortSignal.timeout) é prazo total: se já estourou, não repete.
// - Esgotadas as tentativas numa resposta HTTP, devolve a última Response (não lança) —
//   o call site trata !res.ok exatamente como antes.
//
// Env lida a cada chamada, não no require: o watcher faz os requires antes do
// loadDotEnv().

const { withRetry, isTransientError } = require('../retry');

const SAFE_TO_REPEAT_NON_IDEMPOTENT = new Set([429, 503, 'ENOTFOUND']);
const NO_RETRY_LOG = new Set([401, 403]);

function intEnv(env, name, def, min) {
    const raw = env[name];
    if (raw === undefined || String(raw).trim() === '') return def;
    const n = Number(raw);
    return Number.isFinite(n) && n >= min ? Math.floor(n) : def;
}

function settings(env) {
    return {
        maxAttempts: intEnv(env, 'REDMINE_RETRY_MAX_ATTEMPTS', 3, 1),
        baseDelayMs: intEnv(env, 'REDMINE_RETRY_BASE_DELAY_MS', 1000, 0),
        minIntervalMs: intEnv(env, 'REDMINE_MIN_INTERVAL_MS', 500, 0),
    };
}

function describe(url, method) {
    let p = String(url);
    try { const u = new URL(p); p = u.pathname + u.search; } catch { /* relativa */ }
    return `${method} ${p}`;
}

function retryAfterMs(res) {
    const h = res.headers?.get?.('retry-after');
    if (!h) return 0;
    const s = Number(h);
    if (Number.isFinite(s)) return s * 1000;
    const at = Date.parse(h);
    return Number.isFinite(at) ? Math.max(0, at - Date.now()) : 0;
}

function createRedmineFetch({
    fetch: fetchImpl = (...a) => globalThis.fetch(...a),
    env = process.env,
    log = console.warn,
    sleep = ms => new Promise(r => setTimeout(r, ms)),
    now = () => Date.now(),
} = {}) {
    let nextSlot = 0;

    async function throttle(label, minIntervalMs) {
        const t = now();
        const slot = Math.max(t, nextSlot);
        nextSlot = slot + minIntervalMs;
        const wait = slot - t;
        if (wait > 0) {
            log(`[redmine-throttle] aguardando ${wait}ms antes de ${label} (intervalo mínimo ${minIntervalMs}ms)`);
            await sleep(wait);
        }
    }

    return async function redmineFetch(url, init = {}) {
        const cfg = settings(env);
        const method = String(init.method || 'GET').toUpperCase();
        const idempotent = method === 'GET' || method === 'HEAD';
        const label = describe(url, method);

        let discarded = null;
        try {
            return await withRetry(async () => {
                // Resposta transiente da tentativa anterior: descarta o corpo pra liberar o socket.
                if (discarded) { try { await discarded.body?.cancel?.(); } catch { /* já consumido */ } discarded = null; }
                await throttle(label, cfg.minIntervalMs);
                const res = await fetchImpl(url, init);
                if (res.ok || !isTransientError({ statusCode: res.status })) {
                    if (NO_RETRY_LOG.has(res.status)) log(`[redmine] ${label}: HTTP ${res.status} — erro de autenticação, sem retry.`);
                    return res;
                }
                const err = new Error(`${label}: HTTP ${res.status}`);
                err.statusCode = res.status;
                err.response = res;
                err.retryAfterMs = retryAfterMs(res);
                discarded = res;
                throw err;
            }, {
                maxAttempts: cfg.maxAttempts,
                baseDelayMs: cfg.baseDelayMs,
                log,
                sleep,
                minDelayFor: err => err.retryAfterMs || 0,
                retryOn: err => {
                    if (init.signal?.aborted) return false;
                    if (!isTransientError(err)) return false;
                    if (idempotent) return true;
                    return SAFE_TO_REPEAT_NON_IDEMPOTENT.has(err.statusCode ?? err.code ?? err.cause?.code);
                },
            });
        } catch (err) {
            // Tentativas esgotadas (ou retry vetado) numa resposta HTTP: devolve a Response
            // como o fetch puro devolveria.
            if (err && err.response) return err.response;
            throw err;
        }
    };
}

// Instância padrão: um único throttle por processo pra todo mundo que chama o Redmine.
const redmineFetch = createRedmineFetch();

module.exports = { redmineFetch, createRedmineFetch, settings };
