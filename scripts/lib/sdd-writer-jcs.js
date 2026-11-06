'use strict';
// Writer SDD (PRI-266, DS-09) — JCS (RFC 8785) e parser estrito I-JSON (RFC 7493).
// Contrato: RRC-SDD-002 §4.4 (sdd-cmd-v1) e §4.5 (log.json = JCS(array)).
// Sem dependências além do Node. Não decide nada: só serializa e lê bytes.

class JcsError extends Error {
    constructor(reason, message) {
        super(message || reason);
        this.name = 'JcsError';
        this.reason = reason;
    }
}

const fatalUtf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

function assertWellFormed(s) {
    for (let i = 0; i < s.length; i++) {
        const c = s.charCodeAt(i);
        if (c >= 0xd800 && c <= 0xdbff) {
            const n = s.charCodeAt(i + 1);
            if (!(n >= 0xdc00 && n <= 0xdfff)) throw new JcsError('LONE_SURROGATE', 'surrogate isolado');
            i++;
        } else if (c >= 0xdc00 && c <= 0xdfff) {
            throw new JcsError('LONE_SURROGATE', 'surrogate isolado');
        }
    }
}

// Serialização de número do JCS = Number.prototype.toString do ECMAScript (RFC 8785 §3.2.2.3).
function serializeNumber(n) {
    if (!Number.isFinite(n)) throw new JcsError('NUMBER', 'número não finito');
    if (Object.is(n, -0)) return '0';
    return String(n);
}

function serializeString(s) {
    assertWellFormed(s);
    // JSON.stringify emite exatamente o escape do JCS para strings bem formadas:
    // \b \t \n \f \r, \u00xx minúsculo para os demais controles, \" e \\.
    return JSON.stringify(s);
}

/** JCS(value) → string. Objetos ordenados por unidades UTF-16 das chaves (RFC 8785 §3.2.3). */
function canonicalize(value) {
    if (value === null) return 'null';
    switch (typeof value) {
        case 'boolean': return value ? 'true' : 'false';
        case 'number': return serializeNumber(value);
        case 'string': return serializeString(value);
        case 'object': {
            if (Array.isArray(value)) return '[' + value.map(canonicalize).join(',') + ']';
            const keys = Object.keys(value).sort();
            return '{' + keys.map(k => serializeString(k) + ':' + canonicalize(value[k])).join(',') + '}';
        }
        default: throw new JcsError('TYPE', `tipo não serializável: ${typeof value}`);
    }
}

function canonicalBytes(value) {
    return Buffer.from(canonicalize(value), 'utf8');
}

// Parser JSON estrito: gramática RFC 8259, sem chave duplicada, sem surrogate isolado,
// UTF-8 válido sem BOM. Devolve objetos com protótipo nulo para não herdar chaves.
function parseStrict(input) {
    let text;
    if (Buffer.isBuffer(input) || input instanceof Uint8Array) {
        if (input.length >= 3 && input[0] === 0xef && input[1] === 0xbb && input[2] === 0xbf) {
            throw new JcsError('BOM', 'BOM não admitido');
        }
        try { text = fatalUtf8.decode(input); } catch { throw new JcsError('UTF8', 'UTF-8 inválido'); }
    } else if (typeof input === 'string') {
        text = input;
    } else {
        throw new JcsError('TYPE', 'entrada deve ser Buffer ou string');
    }
    let i = 0;
    const err = (reason, msg) => new JcsError(reason, `${msg} (posição ${i})`);
    const ws = () => { while (i < text.length && (text[i] === ' ' || text[i] === '\t' || text[i] === '\n' || text[i] === '\r')) i++; };
    function value() {
        ws();
        const c = text[i];
        if (c === '{') return object();
        if (c === '[') return array();
        if (c === '"') return string();
        if (c === 't') return literal('true', true);
        if (c === 'f') return literal('false', false);
        if (c === 'n') return literal('null', null);
        if (c === '-' || (c >= '0' && c <= '9')) return number();
        throw err('SYNTAX', 'valor inesperado');
    }
    function literal(word, v) {
        if (text.slice(i, i + word.length) !== word) throw err('SYNTAX', 'literal inválido');
        i += word.length;
        return v;
    }
    function number() {
        const m = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(text.slice(i));
        if (!m) throw err('SYNTAX', 'número inválido');
        i += m[0].length;
        const n = Number(m[0]);
        if (!Number.isFinite(n)) throw err('NUMBER', 'número fora do intervalo');
        return n;
    }
    function string() {
        i++; // "
        let out = '';
        for (;;) {
            if (i >= text.length) throw err('SYNTAX', 'string sem fim');
            const c = text[i];
            if (c === '"') { i++; break; }
            if (c === '\\') {
                const e = text[i + 1];
                const map = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };
                if (e in map) { out += map[e]; i += 2; continue; }
                if (e === 'u') {
                    const hex = text.slice(i + 2, i + 6);
                    if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw err('SYNTAX', 'escape \\u inválido');
                    out += String.fromCharCode(parseInt(hex, 16));
                    i += 6;
                    continue;
                }
                throw err('SYNTAX', 'escape inválido');
            }
            if (c.charCodeAt(0) < 0x20) throw err('SYNTAX', 'caractere de controle em string');
            out += c;
            i++;
        }
        assertWellFormed(out);
        return out;
    }
    function array() {
        i++;
        const out = [];
        ws();
        if (text[i] === ']') { i++; return out; }
        for (;;) {
            out.push(value());
            ws();
            if (text[i] === ',') { i++; continue; }
            if (text[i] === ']') { i++; return out; }
            throw err('SYNTAX', 'esperado , ou ]');
        }
    }
    function object() {
        i++;
        const out = Object.create(null);
        ws();
        if (text[i] === '}') { i++; return out; }
        for (;;) {
            ws();
            if (text[i] !== '"') throw err('SYNTAX', 'chave esperada');
            const k = string();
            if (Object.prototype.hasOwnProperty.call(out, k)) throw err('DUPLICATE_KEY', `chave duplicada "${k}"`);
            ws();
            if (text[i] !== ':') throw err('SYNTAX', 'esperado :');
            i++;
            out[k] = value();
            ws();
            if (text[i] === ',') { i++; continue; }
            if (text[i] === '}') { i++; return out; }
            throw err('SYNTAX', 'esperado , ou }');
        }
    }
    const v = value();
    ws();
    if (i !== text.length) throw err('SYNTAX', 'conteúdo depois do valor');
    return v;
}

/** Bytes canônicos: JCS(parse(b)) === b, byte a byte (RRC-SDD-002 §4.4 "bytes congelados"). */
function parseCanonical(bytes) {
    const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
    const v = parseStrict(buf);
    if (!canonicalBytes(v).equals(buf)) throw new JcsError('NON_CANONICAL', 'bytes não canônicos (JCS(parse(b)) ≠ b)');
    return v;
}

module.exports = { JcsError, canonicalize, canonicalBytes, parseStrict, parseCanonical };
