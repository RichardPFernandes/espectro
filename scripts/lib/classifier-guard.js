// Verificador de conteúdo do envelope enviado ao Jev (PRI-205 S3b, SPEC §B5).
//
// R-7 (Richard, 2026-10-27, fail-closed; aceito como a verificação na Q7 em
// 2026-11-06): o envio só ocorre se este verificador não achar nada. Ele BLOQUEIA e
// nunca redige nem mascara (sanitizar não desclassifica, F19 D-F19-14), e nunca
// devolve o trecho encontrado, só a categoria e o campo.
//
// Limite declarado: não prova a ausência de dado de cliente ou pessoal
// (UNK-SEC-007 OPEN). Só reduz o risco nas categorias abaixo. Os falsos positivos
// são aceitos: um bloqueio só tira a opinião do Jev daquele grupo.
//
// Função pura: sem disco, relógio ou rede.

const GUARD_VERSION = 'classifier-guard@1';
const ENVELOPE_FIELDS = ['step_text', 'ac_texts', 'declared_paths'];

const TOKEN_PATTERNS = [
    /\b(?:sk|pk|rk)[-_](?:live|test|proj)?[-_]?[A-Za-z0-9]{16,}/,
    /\bgh[pousr]_[A-Za-z0-9]{20,}/,
    /\bgithub_pat_[A-Za-z0-9_]{20,}/,
    /\bglpat-[A-Za-z0-9_-]{16,}/,
    /\bxox[abprs]-[A-Za-z0-9-]{10,}/,
    /\bAIza[0-9A-Za-z_-]{30,}/,
    /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/,
    /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/i,
    /\beyJ[A-Za-z0-9_-]{5,}\.eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}/,
    /-----BEGIN [A-Z0-9 ]+-----/,
];

const ENTROPY_CANDIDATE = /[A-Za-z0-9+_=-]{32,}/g;

function shannon(s) {
    const counts = new Map();
    for (const ch of s) counts.set(ch, (counts.get(ch) || 0) + 1);
    let h = 0;
    for (const n of counts.values()) {
        const p = n / s.length;
        h -= p * Math.log2(p);
    }
    return h;
}

function highEntropy(text) {
    for (const m of text.match(ENTROPY_CANDIDATE) || []) {
        if (/[0-9]/.test(m) && /[A-Za-z]/.test(m) && shannon(m) >= 3.5) return true;
    }
    return false;
}

function digits(s) {
    return s.replace(/\D/g, '');
}

function cpfValid(raw) {
    const d = digits(raw);
    if (d.length !== 11 || /^(\d)\1{10}$/.test(d)) return false;
    const n = d.split('').map(Number);
    const dv = len => {
        const s = n.slice(0, len).reduce((acc, x, i) => acc + x * (len + 1 - i), 0);
        const r = (s * 10) % 11;
        return r === 10 ? 0 : r;
    };
    return dv(9) === n[9] && dv(10) === n[10];
}

function cnpjValid(raw) {
    const d = digits(raw);
    if (d.length !== 14 || /^(\d)\1{13}$/.test(d)) return false;
    const n = d.split('').map(Number);
    const W1 = [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
    const W2 = [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
    const dv = w => {
        const r = w.reduce((acc, x, i) => acc + x * n[i], 0) % 11;
        return r < 2 ? 0 : 11 - r;
    };
    return dv(W1) === n[12] && dv(W2) === n[13];
}

function luhnValid(raw) {
    const d = digits(raw);
    if (d.length < 13 || d.length > 19) return false;
    let sum = 0;
    for (let i = 0; i < d.length; i += 1) {
        let x = Number(d[d.length - 1 - i]);
        if (i % 2 === 1) { x *= 2; if (x > 9) x -= 9; }
        sum += x;
    }
    return sum % 10 === 0;
}

function ibanValid(raw) {
    const s = raw.toUpperCase();
    const rearranged = s.slice(4) + s.slice(0, 4);
    let rem = 0;
    for (const ch of rearranged) {
        const v = /[A-Z]/.test(ch) ? String(ch.charCodeAt(0) - 55) : ch;
        for (const c of v) rem = (rem * 10 + Number(c)) % 97;
    }
    return rem === 1;
}

function ipv4Public(text) {
    for (const m of text.matchAll(/\b(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\b/g)) {
        const octets = m.slice(1, 5).map(Number);
        if (octets.some(o => o > 255)) continue;
        if (octets[0] === 127 || octets.every(o => o === 0)) continue;
        return true;
    }
    return false;
}

function ipv6Public(text) {
    const re = /(?<![0-9A-Za-z:])(?:[0-9a-f]{0,4}:){2,7}[0-9a-f]{0,4}(?![0-9A-Za-z:])/gi;
    for (const m of text.matchAll(re)) {
        const v = m[0];
        const groups = v.split(':');
        // Só conta como IPv6 com "::" ou 8 grupos: evita horas (10:30:00).
        if (!v.includes('::') && groups.length !== 8) continue;
        if (!groups.some(g => g !== '')) continue;
        if (v === '::1' || v === '::') continue;
        return true;
    }
    return false;
}

const CHECKS = [
    ['secret_token', t => TOKEN_PATTERNS.some(re => re.test(t)) || highEntropy(t)],
    ['url_credentials', t => /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]+@/i.test(t)],
    ['connection_string', t => /\bjdbc:[a-z0-9]+:/i.test(t)
        || /\b(?:postgres(?:ql)?|mysql|mariadb|mongodb(?:\+srv)?|redis|rediss|amqps?|mssql|sqlserver|oracle):\/\//i.test(t)
        || /\b(?:Server|Data Source|Host)=[^;\s]+;[^\n]*\b(?:Password|Pwd)=/i.test(t)],
    ['credential_assignment', t => /\b(?:password|passwd|pwd|senha|secret|api[_-]?key|access[_-]?key|token)\s*[:=]\s*["']?[^\s"']{3,}/i.test(t)],
    ['email', t => /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/.test(t)],
    ['cpf', t => [...t.matchAll(/\b\d{3}\.\d{3}\.\d{3}-\d{2}\b|\b\d{11}\b/g)].some(m => cpfValid(m[0]))],
    ['cnpj', t => [...t.matchAll(/\b\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2}\b|\b\d{14}\b/g)].some(m => cnpjValid(m[0]))],
    ['phone_br', t => /\+55\s?\(?\d{2}\)?\s?9?\d{4}[-\s]?\d{4}\b/.test(t) || /\(\d{2}\)\s?9?\d{4}-?\d{4}\b/.test(t)],
    ['ip_address', t => ipv4Public(t) || ipv6Public(t)],
    ['payment_card', t => [...t.matchAll(/\b(?:\d[ -]?){12,18}\d\b/g)].some(m => luhnValid(m[0]))],
    ['iban', t => [...t.matchAll(/\b[A-Z]{2}\d{2}[A-Z0-9]{11,30}\b/g)].some(m => ibanValid(m[0]))],
];

/** Categorias achadas num texto, sem o trecho. */
function scanText(text) {
    const found = [];
    for (const [category, check] of CHECKS) if (check(text)) found.push(category);
    return found;
}

function isStringArray(v) {
    return Array.isArray(v) && v.every(x => typeof x === 'string');
}

/**
 * @param {{ step_text: string, ac_texts: string[], declared_paths: string[] }} envelope
 * @returns {{ ok: true } | { ok: false, categories: string[], fields: string[] }}
 */
function checkEnvelope(envelope) {
    const block = (categories, fields = []) => ({ ok: false, categories, fields });
    if (envelope == null || typeof envelope !== 'object' || Array.isArray(envelope)) return block(['malformed']);
    if (Object.keys(envelope).some(k => !ENVELOPE_FIELDS.includes(k))) return block(['unexpected_field']);
    if (typeof envelope.step_text !== 'string' || !isStringArray(envelope.ac_texts) || !isStringArray(envelope.declared_paths)) {
        return block(['malformed']);
    }
    const categories = new Set();
    const fields = new Set();
    const texts = {
        step_text: [envelope.step_text],
        ac_texts: envelope.ac_texts,
        declared_paths: envelope.declared_paths,
    };
    for (const field of ENVELOPE_FIELDS) {
        for (const text of texts[field]) {
            const hits = scanText(text);
            if (hits.length) fields.add(field);
            for (const h of hits) categories.add(h);
        }
    }
    if (!categories.size) return { ok: true };
    return block([...categories].sort(), ENVELOPE_FIELDS.filter(f => fields.has(f)));
}

module.exports = { checkEnvelope, GUARD_VERSION, ENVELOPE_FIELDS };
