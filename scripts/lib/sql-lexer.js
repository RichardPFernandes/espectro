// Tokenizer SQL (PostgreSQL) do db-effect (PRI-180). Não interpreta SQL: só separa
// código de literal/comentário com as regras do lexer do Postgres, para que as
// checagens de "só leitura" e de "sem controle de transação" olhem o que de fato
// executa. A revisão de segurança mostrou que regex sobre o texto inteiro erra
// (`SELECT '/*'; COMMIT; ...; SELECT '*/'`, `E'\''`, `\!` no meio da linha).
//
// Reconhece: '...' (com ''), E'...' (com \' e \\), U&'...', B'...', X'...',
// $tag$...$tag$ (tag vazia ou identificador; $1 é parâmetro), "..." (com ""),
// U&"...", -- até o fim da linha e /* */ ANINHADO. Literal ou comentário sem fim =
// erro (nada executa). `\` fora de literal = erro (meta-comando do psql).
//
// Saída: statements[] (split nos `;` de nível de código) com tokens
//   { type: 'word' | 'string' | 'dollar' | 'ident' | 'punct' | 'param', value, upper? }
// comentários descartados.

class SqlLexError extends Error {
    constructor(message) { super(message); this.name = 'SqlLexError'; }
}

const WORD_START = /[A-Za-z_\u0080-￿]/;
const WORD_CHAR = /[A-Za-z0-9_$\u0080-￿]/;

function readQuoted(sql, i, quote, { backslashEscapes = false } = {}) {
    // i aponta para a aspa de abertura; devolve [conteúdo, índice após o fechamento].
    let j = i + 1;
    let out = '';
    for (;;) {
        if (j >= sql.length) throw new SqlLexError(`literal ${quote}...${quote} sem fechamento`);
        const c = sql[j];
        if (backslashEscapes && c === '\\') {
            if (j + 1 >= sql.length) throw new SqlLexError('escape \\ no fim de E-string');
            out += c + sql[j + 1];
            j += 2;
            continue;
        }
        if (c === quote) {
            if (sql[j + 1] === quote) { out += quote; j += 2; continue; }
            return [out, j + 1];
        }
        out += c;
        j += 1;
    }
}

/** @returns {{ statements: Array<{ tokens, text }> }} @throws SqlLexError */
function tokenize(sql) {
    const src = String(sql ?? '');
    const statements = [];
    let tokens = [];
    let start = 0;
    const flush = end => {
        const text = src.slice(start, end).trim();
        if (tokens.length) statements.push({ tokens, text });
        tokens = [];
    };
    let i = 0;
    while (i < src.length) {
        const c = src[i];
        const n = src[i + 1];
        if (/\s/.test(c)) { i += 1; continue; }
        if (c === '-' && n === '-') {
            const e = src.indexOf('\n', i);
            i = e === -1 ? src.length : e + 1;
            continue;
        }
        if (c === '/' && n === '*') {
            let depth = 1;
            let j = i + 2;
            while (depth > 0) {
                if (j >= src.length) throw new SqlLexError('comentário /* sem fechamento');
                if (src[j] === '/' && src[j + 1] === '*') { depth += 1; j += 2; } else if (src[j] === '*' && src[j + 1] === '/') { depth -= 1; j += 2; } else j += 1;
            }
            i = j;
            continue;
        }
        if (c === '\\') throw new SqlLexError('barra invertida fora de literal (meta-comando do psql) não é permitida');
        if (c === "'") {
            const [v, j] = readQuoted(src, i, "'");
            tokens.push({ type: 'string', value: v });
            i = j;
            continue;
        }
        if (c === '"') {
            const [v, j] = readQuoted(src, i, '"');
            tokens.push({ type: 'ident', value: v, upper: v.toUpperCase() });
            i = j;
            continue;
        }
        if (c === '$') {
            const m = /^\$([A-Za-z_\u0080-￿][A-Za-z0-9_\u0080-￿]*)?\$/.exec(src.slice(i));
            if (m) {
                const tag = m[0];
                const end = src.indexOf(tag, i + tag.length);
                if (end === -1) throw new SqlLexError(`dollar-quote ${tag} sem fechamento`);
                tokens.push({ type: 'dollar', value: src.slice(i + tag.length, end), tag });
                i = end + tag.length;
                continue;
            }
            const p = /^\$\d+/.exec(src.slice(i));
            if (p) { tokens.push({ type: 'param', value: p[0] }); i += p[0].length; continue; }
            throw new SqlLexError('$ solto fora de literal');
        }
        if (WORD_START.test(c)) {
            let j = i + 1;
            while (j < src.length && WORD_CHAR.test(src[j])) j += 1;
            const word = src.slice(i, j);
            const up = word.toUpperCase();
            // Prefixos de literal: E'...', B'...', X'...', N'...', U&'...', U&"..."
            if (src[j] === "'" && ['E', 'B', 'X', 'N'].includes(up)) {
                const [v, k] = readQuoted(src, j, "'", { backslashEscapes: up === 'E' });
                tokens.push({ type: 'string', value: v, prefix: up });
                i = k;
                continue;
            }
            if (up === 'U' && src[j] === '&' && (src[j + 1] === "'" || src[j + 1] === '"')) {
                const q = src[j + 1];
                const [v, k] = readQuoted(src, j + 1, q);
                tokens.push(q === "'" ? { type: 'string', value: v, prefix: 'U&' } : { type: 'ident', value: v, upper: v.toUpperCase() });
                i = k;
                continue;
            }
            tokens.push({ type: 'word', value: word, upper: up });
            i = j;
            continue;
        }
        if (c === ';') { i += 1; flush(i); start = i; continue; }
        tokens.push({ type: 'punct', value: c });
        i += 1;
    }
    flush(src.length);
    return { statements };
}

/** Palavras de código (fora de literal), em maiúsculas. */
function words(statement) {
    return statement.tokens.filter(t => t.type === 'word').map(t => t.upper);
}

module.exports = { tokenize, words, SqlLexError };
