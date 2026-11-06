// Cliente do Jev (TypeSafe), núcleo 2 do roteamento em sombra (PRI-205 S3b, SPEC §B4/§B7).
//
// - Envia só o envelope (texto do passo, textos dos ACs e caminhos declarados; R-2), a
//   pergunta versionada (PROMPT, escolha entre C1–C5 mais risco; Q5) e o modelo. Nada
//   de código. Quem chama tem de ter passado o envelope pelo classifier-guard antes.
// - Destino de produção fixo (DESTINATION). A base só muda por parâmetro de função,
//   nos testes; nunca por env nem por config (AD-5).
// - A chave entra só no header Authorization. Nunca vai para o resultado, para log ou
//   para detalhe de erro: o resultado só traz códigos.
// - O desfecho diz se o pedido pode ter chegado (B7):
//     NOT_SENT  certo: falhou antes de o corpo inteiro ser escrito no socket;
//     FAILED    certo: houve resposta HTTP de erro (401/403 marcados em auth_rejected);
//     OK        certo: resposta 2xx; parse = OK ou OUT_OF_ENUM;
//     UNCERTAIN incerto: o corpo saiu e não houve resposta completa (timeout,
//               conexão caída). Quem chama nunca repete um UNCERTAIN.
// - O formato da API foi lido no plugin thinkdial (hooks/policy.ts, MIT), não na
//   documentação oficial: nada dele é copiado nem chamado.

const crypto = require('crypto');
const http = require('http');
const https = require('https');
const { execFile } = require('child_process');

const DESTINATION = 'https://api.typesafe.ai/v1/systemone';
const DESTINATION_ID = 'typesafe:/v1/systemone';
const ENDPOINT_PATH = '/v1/systemone';
const ENUM_VERSION = 'prisma-class-c1c5@1';
const CLIENT_VERSION = 'jev-client@1';
const CLASSES = ['C1', 'C2', 'C3', 'C4', 'C5'];
const DEFAULT_TIMEOUT_MS = 3000;
const MAX_RESPONSE_BYTES = 64 * 1024;
const SECURITY_BIN = '/usr/bin/security';

const PROMPT = Object.freeze({
    class: Object.freeze({
        type: 'choice',
        instructions: 'Which is the lowest complexity class that a coding agent can complete this implementation step at, with full quality? Judge only from the step text, the acceptance criteria and the declared file paths.',
        criteria: Object.freeze({
            C1: 'Trivial: a single documentation file, at most one acceptance criterion, no behaviour change.',
            C2: 'Simple: one or two files of local code or tests, at most one new file, at most two acceptance criteria, no shared code.',
            C3: 'Moderate: up to five files of local code, tests or docs, at most three acceptance criteria, within one service.',
            C4: 'Complex: more files or services, shared code, configuration or behaviour changes, unclear scope, or missing information.',
            C5: 'Critical: security, authentication, personal data, money, data migrations or repeated failed attempts.',
        }),
    }),
    risky: Object.freeze({
        type: 'noul',
        instructions: 'Carrying out this step would itself change production, move real money, or alter data that cannot be restored. Writing or testing code that deals with such things, without running it against the real system, does not count.',
    }),
});

function canonical(value) {
    if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
    if (value && typeof value === 'object') {
        return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
    }
    return JSON.stringify(value === undefined ? null : value);
}

function promptSha256() {
    return crypto.createHash('sha256').update(canonical(PROMPT)).digest('hex');
}

function requestTarget(baseUrl) {
    if (baseUrl == null) return DESTINATION;
    return `${String(baseUrl).replace(/\/+$/, '')}${ENDPOINT_PATH}`;
}

function confidenceOf(v) {
    return typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1 ? v : null;
}

function readAnswer(text) {
    let parsed;
    try {
        parsed = JSON.parse(text);
    } catch {
        return { parse: 'OUT_OF_ENUM', class: null, confidence: null, risky: null, model_reported: null };
    }
    const answers = parsed && typeof parsed === 'object' ? parsed.answers : null;
    const cls = answers && answers.class && typeof answers.class === 'object' ? answers.class : null;
    const model = parsed && typeof parsed.model === 'string' && parsed.model.trim() ? parsed.model : null;
    if (!cls || !CLASSES.includes(cls.choice)) {
        return { parse: 'OUT_OF_ENUM', class: null, confidence: null, risky: null, model_reported: model };
    }
    const risky = answers.risky && typeof answers.risky === 'object' ? confidenceOf(answers.risky.noul) : null;
    return { parse: 'OK', class: cls.choice, confidence: confidenceOf(cls.confidence), risky, model_reported: model };
}

/**
 * @param {{ envelope: { step_text: string, ac_texts: string[], declared_paths: string[] },
 *   model: string, credential?: string, timeoutMs?: number, baseUrl?: string }} input
 */
function classify({ envelope, model, credential, timeoutMs = DEFAULT_TIMEOUT_MS, baseUrl } = {}) {
    const empty = { class: null, confidence: null, risky: null, model_reported: null, parse: null, http_status: null, auth_rejected: false };
    const started = Date.now();
    const done = (fields) => ({ ...empty, ...fields, latency_ms: Date.now() - started });

    if (typeof credential !== 'string' || !credential.trim()) {
        return Promise.resolve(done({ outcome: 'NOT_SENT', certain: true, detail: 'CREDENTIAL_UNAVAILABLE' }));
    }
    const state = {
        step_text: envelope && envelope.step_text,
        ac_texts: envelope && envelope.ac_texts,
        declared_paths: envelope && envelope.declared_paths,
    };
    const body = JSON.stringify({ model, state, questions: PROMPT });
    const url = new URL(requestTarget(baseUrl));
    const transport = url.protocol === 'https:' ? https : http;

    return new Promise(resolve => {
        let settled = false;
        let connected = false;
        let written = false;
        const finish = result => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve(done(result));
        };
        const lost = detail => (connected && written
            ? { outcome: 'UNCERTAIN', certain: false, detail }
            : { outcome: 'NOT_SENT', certain: true, detail });

        let req;
        try {
            req = transport.request(url, {
                method: 'POST',
                agent: false, // sem reuso: o "connect" de cada pedido é observável
                headers: {
                    'content-type': 'application/json',
                    'content-length': Buffer.byteLength(body),
                    authorization: `Bearer ${credential}`,
                },
            });
        } catch {
            // Ex.: rede recusada pelo controle loopback dos testes. Nada saiu.
            resolve(done({ outcome: 'NOT_SENT', certain: true, detail: 'REQUEST_NOT_CREATED' }));
            return;
        }
        const timer = setTimeout(() => {
            finish(lost('TIMEOUT'));
            req.destroy();
        }, timeoutMs);

        req.on('socket', socket => {
            if (!socket.connecting) connected = true;
            socket.once('connect', () => { connected = true; });
            socket.once('secureConnect', () => { connected = true; });
        });
        req.on('finish', () => { written = true; });
        req.on('error', err => finish(lost(err && err.code ? String(err.code) : 'REQUEST_ERROR')));
        req.on('response', res => {
            const status = res.statusCode;
            const chunks = [];
            let size = 0;
            let tooBig = false;
            res.on('data', c => {
                size += c.length;
                if (size > MAX_RESPONSE_BYTES) { tooBig = true; res.destroy(); return; }
                chunks.push(c);
            });
            res.on('aborted', () => finish({ outcome: 'UNCERTAIN', certain: false, detail: 'RESPONSE_ABORTED', http_status: status }));
            res.on('error', () => {
                if (tooBig) finish({ outcome: 'OK', certain: true, detail: 'RESPONSE_TOO_LARGE', http_status: status, parse: 'OUT_OF_ENUM' });
                else finish({ outcome: 'UNCERTAIN', certain: false, detail: 'RESPONSE_ABORTED', http_status: status });
            });
            res.on('close', () => {
                if (tooBig) finish({ outcome: 'OK', certain: true, detail: 'RESPONSE_TOO_LARGE', http_status: status, parse: 'OUT_OF_ENUM' });
                else if (!res.complete) finish({ outcome: 'UNCERTAIN', certain: false, detail: 'RESPONSE_ABORTED', http_status: status });
            });
            res.on('end', () => {
                if (status >= 200 && status < 300) {
                    finish({ outcome: 'OK', certain: true, detail: null, http_status: status, ...readAnswer(Buffer.concat(chunks).toString('utf8')) });
                } else {
                    finish({ outcome: 'FAILED', certain: true, detail: `HTTP_${status}`, http_status: status, auth_rejected: status === 401 || status === 403 });
                }
            });
        });
        req.end(body);
    });
}

/**
 * Lê a chave do Keychain pelo nome do item (AD-4). O valor só existe em memória.
 * @param {{ keychain: string, account: string }} ref
 * @returns {Promise<{ ok: true, value: string } | { ok: false, reason: 'CREDENTIAL_UNAVAILABLE' }>}
 */
function readKeychainCredential(ref, { execFileImpl = execFile, timeoutMs = 5000 } = {}) {
    const unavailable = { ok: false, reason: 'CREDENTIAL_UNAVAILABLE' };
    const valid = s => typeof s === 'string' && /^[A-Za-z0-9._-]+$/.test(s);
    if (!ref || !valid(ref.keychain) || !valid(ref.account)) return Promise.resolve(unavailable);
    return new Promise(resolve => {
        execFileImpl(SECURITY_BIN, ['find-generic-password', '-s', ref.keychain, '-a', ref.account, '-w'],
            { shell: false, timeout: timeoutMs, windowsHide: true }, (err, stdout) => {
                const value = String(stdout || '').replace(/\r?\n$/, '');
                if (err || !value.trim()) resolve(unavailable);
                else resolve({ ok: true, value });
            });
    });
}

module.exports = {
    classify,
    readKeychainCredential,
    requestTarget,
    promptSha256,
    PROMPT,
    DESTINATION,
    DESTINATION_ID,
    ENUM_VERSION,
    CLIENT_VERSION,
    DEFAULT_TIMEOUT_MS,
    CLASSES,
};
