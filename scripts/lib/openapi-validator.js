// Confere o contrato OpenAPI da task (memory/runs/<task-id>/openapi-contract.yaml,
// gerado pelo nó Plan quando a task cria/altera endpoint REST) contra o Resource
// JAX-RS implementado. Usado pelo nó Review (.claude/commands/review.md): cada
// divergência de severidade FAIL vira um item [FAIL] no review-result.md.
//
// É heurística de propósito (v1, ~80% dos casos): parser de YAML só do subconjunto
// que um contrato OpenAPI escrito por agente usa (mapas/listas em bloco, escalares,
// flow simples `[a, b]`/`{a: 1}`, block scalar `|`/`>`; sem âncora/alias/tag) e
// regex sobre o Java — nada de AST. O contrato também é gerado por agente e pode ter
// imprecisões: ele é âncora, não verdade absoluta. Por isso só é FAIL o que é
// objetivo (endpoint ausente, campo do contrato ausente no DTO, status retornado que
// o contrato não declara); o resto é WARN.
//
// Resolução do DTO do request body, em ordem:
//   1. `x-java-dto: NomeDaClasse` no requestBody, no schema ou no component referenciado;
//   2. tipo do parâmetro de corpo do método (o sem @PathParam/@QueryParam/...), se não
//      for String/Map/JsonObject (List<X> vira X);
//   3. `X.class` no corpo do método (idioma do projeto: `Json.fromJson(json, X.class)`);
//   4. nome do `$ref` (#/components/schemas/X).
// A classe é procurada nos .java passados na linha de comando e depois pelo nome de
// arquivo sob o `src/main/java` do Resource (ou `--root <dir>`).
//
// Uso como CLI:
//   node scripts/lib/openapi-validator.js <openapi-contract.yaml> <Resource.java|dir> [Outro.java ...] [--root <dir>] [--md]
//   Saída: JSON { contract, resources, endpoints, divergences, summary } (ou, com --md,
//   uma linha `- [FAIL]/[WARN] ...` por divergência, pronta pro review-result.md).
//   exit 0 = sem FAIL, 1 = há FAIL, 2 = uso incorreto/arquivo inexistente/YAML inválido.

const fs = require('fs');
const path = require('path');

const HTTP_METHODS = ['get', 'post', 'put', 'delete', 'patch', 'head', 'options'];

// ---------------------------------------------------------------------------
// YAML (subconjunto)

function stripYamlComment(line) {
    let quote = null;
    for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (quote) {
            if (c === quote) {
                if (quote === "'" && line[i + 1] === "'") { i++; continue; }
                quote = null;
            } else if (c === '\\' && quote === '"') i++;
        } else if (c === '"' || c === "'") {
            // Aspa só abre string no começo de um escalar (senão é apóstrofo: "it's").
            if (i === 0 || /[\s:,[{-]/.test(line[i - 1])) quote = c;
        } else if (c === '#' && (i === 0 || /\s/.test(line[i - 1]))) {
            return line.slice(0, i);
        }
    }
    return line;
}

function yamlLines(text) {
    return text.replace(/\r\n?/g, '\n').replace(/\t/g, '  ').split('\n').map((raw, idx) => {
        const noComment = stripYamlComment(raw).replace(/\s+$/, '');
        return { indent: noComment.length - noComment.trimStart().length, text: noComment.trim(), raw, line: idx + 1 };
    });
}

// Separa `chave: valor` no primeiro `:` fora de aspas/colchetes seguido de espaço ou fim.
function splitKey(text) {
    let quote = null;
    let depth = 0;
    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (quote) { if (c === quote) quote = null; else if (c === '\\' && quote === '"') i++; continue; }
        if ((c === '"' || c === "'") && (i === 0 || /[\s[{,]/.test(text[i - 1]))) { quote = c; continue; }
        if (c === '[' || c === '{') depth++;
        else if (c === ']' || c === '}') depth--;
        else if (c === ':' && depth === 0 && (i + 1 === text.length || /\s/.test(text[i + 1]))) {
            return { key: unquote(text.slice(0, i).trim()), value: text.slice(i + 1).trim() };
        }
    }
    return null;
}

function unquote(s) {
    if (s.length >= 2 && s[0] === '"' && s[s.length - 1] === '"') {
        try { return JSON.parse(s); } catch { return s.slice(1, -1); }
    }
    if (s.length >= 2 && s[0] === "'" && s[s.length - 1] === "'") return s.slice(1, -1).replace(/''/g, "'");
    return s;
}

function scalar(s) {
    if (s === '' || s === '~' || s === 'null' || s === 'Null' || s === 'NULL') return null;
    if (s[0] === '"' || s[0] === "'") return unquote(s);
    if (s[0] === '[' || s[0] === '{') return parseFlow(s);
    if (/^(true|True|TRUE)$/.test(s)) return true;
    if (/^(false|False|FALSE)$/.test(s)) return false;
    if (/^[-+]?\d+$/.test(s)) return Number(s);
    if (/^[-+]?(\d+\.\d*|\.\d+|\d+)([eE][-+]?\d+)?$/.test(s)) return Number(s);
    return s;
}

function parseFlow(src) {
    let i = 0;
    const ws = () => { while (i < src.length && /\s/.test(src[i])) i++; };
    function value() {
        ws();
        const c = src[i];
        if (c === '[') {
            i++;
            const arr = [];
            ws();
            if (src[i] === ']') { i++; return arr; }
            for (;;) {
                arr.push(value());
                ws();
                if (src[i] === ',') { i++; ws(); if (src[i] === ']') { i++; return arr; } continue; }
                if (src[i] === ']') { i++; return arr; }
                throw new Error(`flow YAML inválido: ${src}`);
            }
        }
        if (c === '{') {
            i++;
            const obj = {};
            ws();
            if (src[i] === '}') { i++; return obj; }
            for (;;) {
                const k = token(true);
                ws();
                let v = null;
                if (src[i] === ':') { i++; v = value(); }
                obj[String(k)] = v;
                ws();
                if (src[i] === ',') { i++; ws(); if (src[i] === '}') { i++; return obj; } continue; }
                if (src[i] === '}') { i++; return obj; }
                throw new Error(`flow YAML inválido: ${src}`);
            }
        }
        return token(false);
    }
    function token(isKey) {
        ws();
        const c = src[i];
        if (c === '"' || c === "'") {
            const start = i++;
            while (i < src.length && src[i] !== c) { if (c === '"' && src[i] === '\\') i++; i++; }
            i++;
            return unquote(src.slice(start, i));
        }
        const start = i;
        while (i < src.length && !(isKey ? /[:,}\]]/ : /[,}\]]/).test(src[i])) i++;
        const raw = src.slice(start, i).trim();
        return isKey ? raw : scalar(raw);
    }
    const out = value();
    return out;
}

function parseYaml(text) {
    const trimmed = text.trim();
    if (trimmed.startsWith('{')) return JSON.parse(trimmed);
    const lines = yamlLines(text);
    let i = 0;
    const skip = () => { while (i < lines.length && (lines[i].text === '' || lines[i].text === '---')) i++; };

    function blockScalar(indicator, parentIndent) {
        const folded = indicator[0] === '>';
        const keep = indicator.includes('+');
        const strip = indicator.includes('-');
        const body = [];
        let blockIndent = null;
        while (i < lines.length) {
            const l = lines[i];
            const rawIndent = l.raw.length - l.raw.trimStart().length;
            if (l.raw.trim() !== '' && rawIndent <= parentIndent) break;
            if (l.raw.trim() !== '' && blockIndent === null) blockIndent = rawIndent;
            body.push(l.raw.trim() === '' ? '' : l.raw.slice(blockIndent ?? rawIndent).replace(/\s+$/, ''));
            i++;
        }
        let out = folded ? body.join('\n').replace(/([^\n])\n(?=[^\n])/g, '$1 ') : body.join('\n');
        if (!keep) out = out.replace(/\n+$/, '');
        return strip ? out : `${out}\n`;
    }

    function inlineValue(value, indent) {
        if (/^[|>][-+]?\d*$/.test(value)) return blockScalar(value, indent);
        if ((value[0] === '[' || value[0] === '{') && !balanced(value)) {
            let joined = value;
            while (i < lines.length && !balanced(joined)) joined += ` ${lines[i++].text}`;
            return parseFlow(joined);
        }
        return scalar(value);
    }

    function nested(parentIndent) {
        skip();
        if (i >= lines.length) return null;
        const next = lines[i];
        if (next.indent > parentIndent) return block(next.indent);
        // Lista no mesmo indent da chave (`tags:\n- a`) também é filha dela.
        if (next.indent === parentIndent && /^-(\s|$)/.test(next.text)) return sequence(parentIndent);
        return null;
    }

    function block(indent) {
        skip();
        if (i >= lines.length) return null;
        return /^-(\s|$)/.test(lines[i].text) ? sequence(indent) : mapping(indent);
    }

    function mapping(indent) {
        const obj = {};
        for (;;) {
            skip();
            if (i >= lines.length) return obj;
            const l = lines[i];
            if (l.indent < indent) return obj;
            if (l.indent > indent) throw new Error(`YAML: indentação inesperada na linha ${l.line}`);
            if (/^-(\s|$)/.test(l.text)) return obj;
            const kv = splitKey(l.text);
            if (!kv) throw new Error(`YAML: esperado "chave: valor" na linha ${l.line}: ${l.text}`);
            i++;
            obj[String(kv.key)] = kv.value === '' ? nested(indent) : inlineValue(kv.value, indent);
        }
    }

    function sequence(indent) {
        const arr = [];
        for (;;) {
            skip();
            if (i >= lines.length) return arr;
            const l = lines[i];
            if (l.indent !== indent || !/^-(\s|$)/.test(l.text)) return arr;
            const rest = l.text.replace(/^-\s*/, '');
            if (rest === '') { i++; arr.push(nested(indent)); continue; }
            if (rest[0] !== '"' && rest[0] !== "'" && rest[0] !== '[' && rest[0] !== '{' && splitKey(rest)) {
                // `- chave: valor` abre um mapa cujo indent é a coluna depois do "- ".
                const col = indent + (l.text.length - rest.length);
                lines[i] = { ...l, indent: col, text: rest };
                arr.push(mapping(col));
                continue;
            }
            i++;
            arr.push(inlineValue(rest, indent));
        }
    }

    skip();
    const doc = i < lines.length ? block(lines[i].indent) : null;
    skip();
    if (i < lines.length) throw new Error(`YAML: conteúdo não interpretado a partir da linha ${lines[i].line}`);
    return doc;
}

function balanced(s) {
    let depth = 0;
    let quote = null;
    for (let i = 0; i < s.length; i++) {
        const c = s[i];
        if (quote) { if (c === quote) quote = null; continue; }
        if (c === '"' || c === "'") quote = c;
        else if (c === '[' || c === '{') depth++;
        else if (c === ']' || c === '}') depth--;
    }
    return depth <= 0;
}

// ---------------------------------------------------------------------------
// Contrato

function resolveRef(doc, schema, seen = new Set()) {
    if (!schema || typeof schema !== 'object' || typeof schema.$ref !== 'string') return schema;
    if (seen.has(schema.$ref)) return {};
    seen.add(schema.$ref);
    const m = /^#\/(.+)$/.exec(schema.$ref);
    if (!m) return {};
    let node = doc;
    for (const part of m[1].split('/')) node = node?.[part.replace(/~1/g, '/').replace(/~0/g, '~')];
    return resolveRef(doc, { ...(node || {}), 'x-ref-name': m[1].split('/').pop() }, seen);
}

// Propriedades de primeiro nível do schema (resolve $ref, allOf, array de objetos).
function schemaShape(doc, schema) {
    let s = resolveRef(doc, schema);
    if (!s || typeof s !== 'object') return null;
    let isArray = false;
    if (s.type === 'array' && s.items) { isArray = true; s = resolveRef(doc, s.items) || {}; }
    const properties = {};
    const required = new Set();
    const dtoHints = [];
    const refHints = [];
    const absorb = part => {
        const r = resolveRef(doc, part);
        if (!r || typeof r !== 'object') return;
        if (typeof r['x-java-dto'] === 'string' && r['x-java-dto']) dtoHints.push(r['x-java-dto']);
        if (typeof r['x-ref-name'] === 'string' && r['x-ref-name']) refHints.push(r['x-ref-name']);
        for (const [k, v] of Object.entries(r.properties || {})) properties[k] = resolveRef(doc, v) || {};
        for (const k of Array.isArray(r.required) ? r.required : []) required.add(String(k));
        for (const sub of Array.isArray(r.allOf) ? r.allOf : []) absorb(sub);
    };
    absorb(s);
    return {
        isArray,
        type: s.type || (Object.keys(properties).length ? 'object' : null),
        properties,
        required,
        javaDto: dtoHints[0] || null,
        refName: refHints[0] || null,
    };
}

function jsonSchemaOf(content) {
    if (!content || typeof content !== 'object') return null;
    const key = Object.keys(content).find(k => /json/i.test(k)) || Object.keys(content)[0];
    return key ? content[key]?.schema || null : null;
}

function contractOperations(doc) {
    if (!doc || typeof doc !== 'object' || !doc.paths || typeof doc.paths !== 'object') {
        throw new Error('contrato sem "paths"');
    }
    const ops = [];
    for (const [p, item] of Object.entries(doc.paths)) {
        if (!item || typeof item !== 'object') continue;
        for (const method of HTTP_METHODS) {
            const op = item[method];
            if (!op || typeof op !== 'object') continue;
            const body = resolveRef(doc, op.requestBody);
            const bodySchema = body ? jsonSchemaOf(body.content) : null;
            const bodyShape = bodySchema ? schemaShape(doc, bodySchema) : null;
            const responses = {};
            for (const [code, resp] of Object.entries(op.responses || {})) {
                const r = resolveRef(doc, resp) || {};
                responses[String(code)] = { schema: jsonSchemaOf(r.content), javaDto: r['x-java-dto'] || null };
            }
            ops.push({
                method: method.toUpperCase(),
                path: p,
                javaMethod: typeof op['x-java-method'] === 'string' ? op['x-java-method'] : null,
                requestBody: bodyShape ? { ...bodyShape, javaDto: body['x-java-dto'] || bodyShape.javaDto } : null,
                responses,
            });
        }
    }
    return ops;
}

// ---------------------------------------------------------------------------
// Java (regex + casamento de delimitadores; comentário vira espaço pra manter linhas)

function stripJavaComments(src) {
    let out = '';
    let i = 0;
    while (i < src.length) {
        const c = src[i];
        const n = src[i + 1];
        if (c === '/' && n === '/') {
            while (i < src.length && src[i] !== '\n') { out += ' '; i++; }
        } else if (c === '/' && n === '*') {
            out += '  '; i += 2;
            while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) { out += src[i] === '\n' ? '\n' : ' '; i++; }
            out += '  '; i += 2;
        } else if (c === '"' && src.startsWith('"""', i)) {
            const end = src.indexOf('"""', i + 3);
            const stop = end < 0 ? src.length : end + 3;
            out += src.slice(i, stop); i = stop;
        } else if (c === '"' || c === "'") {
            const start = i++;
            while (i < src.length && src[i] !== c && src[i] !== '\n') { if (src[i] === '\\') i++; i++; }
            i++;
            out += src.slice(start, i);
        } else { out += c; i++; }
    }
    return out;
}

function matchClose(text, openIdx) {
    const open = text[openIdx];
    const close = { '(': ')', '{': '}', '<': '>', '[': ']' }[open];
    let depth = 0;
    for (let i = openIdx; i < text.length; i++) {
        const c = text[i];
        if (c === '"' || c === "'") {
            const q = c;
            i++;
            while (i < text.length && text[i] !== q) { if (text[i] === '\\') i++; i++; }
            continue;
        }
        if (c === open) depth++;
        else if (c === close && --depth === 0) return i;
    }
    return -1;
}

function lineAt(text, idx) {
    let n = 1;
    for (let i = 0; i < idx && i < text.length; i++) if (text[i] === '\n') n++;
    return n;
}

function splitTopLevel(text, sep = ',') {
    const parts = [];
    let depth = 0;
    let cur = '';
    let quote = null;
    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (quote) { cur += c; if (c === '\\') { cur += text[++i] ?? ''; } else if (c === quote) quote = null; continue; }
        if (c === '"' || c === "'") { quote = c; cur += c; continue; }
        if ('<([{'.includes(c)) depth++;
        else if ('>)]}'.includes(c)) depth--;
        if (c === sep && depth === 0) { parts.push(cur); cur = ''; } else cur += c;
    }
    if (cur.trim()) parts.push(cur);
    return parts.map(p => p.trim()).filter(Boolean);
}

const ANNOTATION_RE = /@[\w.]+(\s*\((?:[^()"]|"(?:[^"\\]|\\.)*"|\([^()]*\))*\))?/g;
const NAME_ANNOTATION_RE = /@(?:[\w.]*\.)?(?:SerializedName|JsonProperty|JsonbProperty)\s*\(\s*(?:value\s*=\s*)?"([^"]*)"/;

// "Tipo nome" (com anotações/modificadores) -> { name, type, jsonName }
function parseDeclaration(decl) {
    const jsonName = (NAME_ANNOTATION_RE.exec(decl) || [])[1] || null;
    const annotations = decl.match(ANNOTATION_RE) || [];
    let rest = decl.replace(ANNOTATION_RE, ' ').replace(/\s+/g, ' ').trim();
    const modifiers = new Set();
    for (;;) {
        const m = /^(public|private|protected|static|final|transient|volatile)\s+/.exec(rest);
        if (!m) break;
        modifiers.add(m[1]);
        rest = rest.slice(m[0].length);
    }
    const m = /^(.+?)\s*\b([A-Za-z_$][\w$]*)$/.exec(rest);
    if (!m) return null;
    return { type: m[1].replace(/\s+/g, ' ').trim(), name: m[2], jsonName, modifiers, annotations };
}

function classPathOf(text) {
    const cls = /\b(?:class|interface)\s+\w+/.exec(text);
    const head = cls ? text.slice(0, cls.index) : text;
    const matches = [...head.matchAll(/@Path\s*\(\s*(?:value\s*=\s*)?"([^"]*)"\s*\)/g)];
    return matches.length ? matches[matches.length - 1][1] : '';
}

const HTTP_ANNOTATION_RE = /@(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)\b(?!\s*\()/g;

function javaEndpoints(file, rawText) {
    const text = stripJavaComments(rawText);
    const classPath = classPathOf(text);
    const endpoints = [];
    for (const m of text.matchAll(HTTP_ANNOTATION_RE)) {
        // Bloco de anotações: do fim do membro anterior até a assinatura do método.
        const before = text.slice(0, m.index);
        const blockStart = Math.max(before.lastIndexOf(';'), before.lastIndexOf('}'), before.lastIndexOf('{')) + 1;
        const sig = /\b([A-Za-z_$][\w$]*)\s*\(/g;
        sig.lastIndex = m.index + m[0].length;
        let s;
        let paramsOpen = -1;
        let name = null;
        while ((s = sig.exec(text))) {
            // Pula argumentos de anotação (@Path("x"), @Produces(...)) até achar o método.
            if (/@[\w.]*$/.test(text.slice(Math.max(0, s.index - 200), s.index))) {
                const close = matchClose(text, s.index + s[0].length - 1);
                sig.lastIndex = close + 1;
                continue;
            }
            name = s[1];
            paramsOpen = s.index + s[0].length - 1;
            break;
        }
        if (paramsOpen < 0) continue;
        const paramsClose = matchClose(text, paramsOpen);
        const bodyOpen = text.indexOf('{', paramsClose);
        const semi = text.indexOf(';', paramsClose);
        const hasBody = bodyOpen >= 0 && (semi < 0 || bodyOpen < semi);
        const bodyClose = hasBody ? matchClose(text, bodyOpen) : -1;
        const header = text.slice(blockStart, paramsOpen);
        const methodPath = (/@Path\s*\(\s*(?:value\s*=\s*)?"([^"]*)"\s*\)/.exec(header) || [])[1] || '';
        const params = splitTopLevel(text.slice(paramsOpen + 1, paramsClose)).map(p => ({
            raw: p,
            source: (/@(PathParam|QueryParam|HeaderParam|FormParam|CookieParam|MatrixParam|BeanParam|Context|FormDataParam|Suspended)\b/.exec(p) || [])[1] || 'body',
            ...parseDeclaration(p),
        }));
        endpoints.push({
            file,
            method: m[1],
            name,
            path: joinPath(classPath, methodPath),
            line: lineAt(text, m.index),
            params,
            body: hasBody && bodyClose > 0 ? text.slice(bodyOpen, bodyClose + 1) : '',
            bodyLine: hasBody ? lineAt(text, bodyOpen) : null,
        });
    }
    return endpoints;
}

function joinPath(...parts) {
    return `/${parts.map(p => String(p || '').replace(/^\/+|\/+$/g, '')).filter(Boolean).join('/')}`;
}

// `{id: [0-9]+}` -> `{id}`; tira barras duplicadas/finais.
function normalizePath(p) {
    const out = String(p || '').replace(/\{\s*([\w.-]+)\s*:[^}]*\}/g, '{$1}').replace(/\/+/g, '/').replace(/\/$/, '');
    return out.startsWith('/') ? out : `/${out}`;
}

function pathShape(p) {
    return normalizePath(p).replace(/\{[^}]*\}/g, '{}');
}

// O contrato pode trazer o prefixo da aplicação (/api/v1/...), o @Path não: casa por sufixo.
function pathsMatch(contractPath, javaPath) {
    const c = pathShape(contractPath);
    const j = pathShape(javaPath);
    // j começa com "/", então endsWith já garante fronteira de segmento.
    return c === j || (j !== '/' && c.endsWith(j));
}

const STATUS_ENUM = {
    OK: 200, CREATED: 201, ACCEPTED: 202, NO_CONTENT: 204, RESET_CONTENT: 205, PARTIAL_CONTENT: 206,
    MOVED_PERMANENTLY: 301, FOUND: 302, SEE_OTHER: 303, NOT_MODIFIED: 304, TEMPORARY_REDIRECT: 307,
    BAD_REQUEST: 400, UNAUTHORIZED: 401, PAYMENT_REQUIRED: 402, FORBIDDEN: 403, NOT_FOUND: 404,
    METHOD_NOT_ALLOWED: 405, NOT_ACCEPTABLE: 406, REQUEST_TIMEOUT: 408, CONFLICT: 409, GONE: 410,
    PRECONDITION_FAILED: 412, REQUEST_ENTITY_TOO_LARGE: 413, UNSUPPORTED_MEDIA_TYPE: 415,
    UNPROCESSABLE_ENTITY: 422, TOO_MANY_REQUESTS: 429,
    INTERNAL_SERVER_ERROR: 500, NOT_IMPLEMENTED: 501, BAD_GATEWAY: 502, SERVICE_UNAVAILABLE: 503, GATEWAY_TIMEOUT: 504,
};

// br.com.mosistemas.utils...ResponseFactory (mo-utils) — o helper que o projeto mais usa.
function responseFactoryStatuses() {
    const file = process.env.OPENAPI_RESPONSE_FACTORY_FILE;
    if (!file) return {};
    return JSON.parse(fs.readFileSync(path.resolve(process.env.REPO_PATH || process.cwd(), file), 'utf8'));
}

const RESPONSE_BUILDERS = { ok: 200, created: 201, accepted: 202, noContent: 204, notModified: 304, serverError: 500 };

const EXCEPTIONS = {
    BadRequestException: 400, NotAuthorizedException: 401, ForbiddenException: 403, NotFoundException: 404,
    NotAllowedException: 405, NotAcceptableException: 406, NotSupportedException: 415,
    InternalServerErrorException: 500, ServiceUnavailableException: 503,
};

function statusToken(tok) {
    const t = tok.trim();
    if (/^\d{3}$/.test(t)) return Number(t);
    const m = /(?:^|\.)Status\.([A-Z_]+)(?:\.getStatusCode\(\))?$/.exec(t);
    if (m && STATUS_ENUM[m[1]]) return STATUS_ENUM[m[1]];
    const code = /^HttpStatus\.(?:SC_)?([A-Z_]+)$/.exec(t) || /^HttpServletResponse\.SC_([A-Z_]+)$/.exec(t);
    if (code && STATUS_ENUM[code[1]]) return STATUS_ENUM[code[1]];
    return null;
}

function javaStatuses(body, bodyLine) {
    const RESPONSE_FACTORY = responseFactoryStatuses();
    const codes = new Map();
    const dynamic = [];
    const add = (code, idx) => { if (!codes.has(code)) codes.set(code, bodyLine + lineAt(body, idx) - 1); };
    for (const m of body.matchAll(/\bResponse\s*\.\s*status\s*\(/g)) {
        const open = m.index + m[0].length - 1;
        const arg = splitTopLevel(body.slice(open + 1, matchClose(body, open)))[0] || '';
        const code = statusToken(arg);
        if (code) add(code, m.index); else dynamic.push({ expr: arg, line: bodyLine + lineAt(body, m.index) - 1 });
    }
    for (const m of body.matchAll(/\bResponse\s*\.\s*(ok|created|accepted|noContent|notModified|serverError)\s*\(/g)) add(RESPONSE_BUILDERS[m[1]], m.index);
    for (const m of body.matchAll(/\bResponseFactory\s*\.\s*(\w+)\s*\(/g)) {
        if (RESPONSE_FACTORY[m[1]]) add(RESPONSE_FACTORY[m[1]], m.index);
    }
    for (const m of body.matchAll(/\bthrow\s+new\s+(\w+)\s*\(/g)) {
        if (EXCEPTIONS[m[1]]) { add(EXCEPTIONS[m[1]], m.index); continue; }
        if (m[1] === 'WebApplicationException') {
            const open = m.index + m[0].length - 1;
            const args = splitTopLevel(body.slice(open + 1, matchClose(body, open)));
            const code = args.length ? statusToken(args[args.length - 1]) : null;
            if (code) add(code, m.index); else dynamic.push({ expr: m[0], line: bodyLine + lineAt(body, m.index) - 1 });
        }
    }
    return { codes, dynamic };
}

// ---------------------------------------------------------------------------
// DTO

const JAVA_CATEGORY = [
    [/^(String|CharSequence|char|Character|UUID|ObjectId)$/, 'string'],
    [/^(LocalDate|LocalDateTime|LocalTime|OffsetDateTime|ZonedDateTime|Instant|Date|Calendar|Timestamp)$/, 'date'],
    [/^(int|Integer|long|Long|short|Short|byte|Byte|BigInteger|AtomicInteger|AtomicLong)$/, 'integer'],
    [/^(double|Double|float|Float|BigDecimal|Number)$/, 'number'],
    [/^(boolean|Boolean)$/, 'boolean'],
    [/^(List|Set|Collection|ArrayList|LinkedList|HashSet|TreeSet|LinkedHashSet|Iterable|JsonArray)$/, 'array'],
    [/^(Map|HashMap|LinkedHashMap|TreeMap|JsonObject|JsonNode|ObjectNode)$/, 'map'],
];

function javaCategory(type) {
    const t = String(type || '').replace(/\s+/g, '');
    if (/\[\]$/.test(t)) return 'array';
    const base = t.replace(/<.*$/, '').split('.').pop();
    for (const [re, cat] of JAVA_CATEGORY) if (re.test(base)) return cat;
    return 'unknown';
}

function schemaAccepts(schemaType, cat) {
    if (!schemaType || cat === 'unknown') return true;
    switch (schemaType) {
        case 'string': return cat === 'string' || cat === 'date';
        case 'integer': return cat === 'integer';
        case 'number': return cat === 'integer' || cat === 'number';
        case 'boolean': return cat === 'boolean';
        case 'array': return cat === 'array';
        case 'object': return cat === 'map';
        default: return true;
    }
}

function findTypeDeclaration(text, name) {
    const re = new RegExp(`\\b(class|record|interface|enum)\\s+${name}\\b`, 'g');
    const m = re.exec(text);
    return m ? { kind: m[1], index: m.index, end: m.index + m[0].length } : null;
}

function dtoFieldsFromSource(rawText, name) {
    const text = stripJavaComments(rawText);
    const decl = findTypeDeclaration(text, name);
    if (!decl || decl.kind === 'enum' || decl.kind === 'interface') return null;
    const fields = [];
    let superName = null;
    let cursor = decl.end;
    if (text[cursor] === '<' || /^\s*</.test(text.slice(cursor))) {
        const lt = text.indexOf('<', cursor);
        cursor = matchClose(text, lt) + 1;
    }
    if (decl.kind === 'record') {
        const open = text.indexOf('(', cursor);
        const close = matchClose(text, open);
        for (const p of splitTopLevel(text.slice(open + 1, close))) {
            const d = parseDeclaration(p);
            if (d) fields.push({ name: d.name, jsonName: d.jsonName || d.name, type: d.type, line: lineAt(text, open) });
        }
        return { fields, superName: null };
    }
    const bodyOpen = text.indexOf('{', cursor);
    const header = text.slice(cursor, bodyOpen);
    superName = (/\bextends\s+([\w.]+)/.exec(header) || [])[1]?.split('.').pop() || null;
    const bodyClose = matchClose(text, bodyOpen);
    // Declarações no nível 0 do corpo: blocos {…} (métodos, classes internas,
    // inicializadores) são pulados; o que termina em ';' e não é chamada é campo.
    let segStart = bodyOpen + 1;
    for (let i = bodyOpen + 1; i < bodyClose; i++) {
        const c = text[i];
        if (c === '"' || c === "'") { const q = c; i++; while (i < bodyClose && text[i] !== q) { if (text[i] === '\\') i++; i++; } continue; }
        if (c === '(') { i = matchClose(text, i); continue; }
        if (c === '{') {
            const segment = text.slice(segStart, i);
            // `= { ... }` (inicializador de array) faz parte do campo; o resto é bloco.
            if (/=\s*$/.test(segment)) { i = matchClose(text, i); continue; }
            i = matchClose(text, i);
            segStart = i + 1;
            continue;
        }
        if (c === ';') {
            const segment = text.slice(segStart, i).trim();
            const lineNo = lineAt(text, segStart + (text.slice(segStart, i).length - text.slice(segStart, i).trimStart().length));
            segStart = i + 1;
            const beforeInit = splitTopLevel(segment, '=')[0] || '';
            if (!beforeInit || /\(\s*$/.test(beforeInit) || /^(import|package|return)\b/.test(beforeInit)) continue;
            const withoutAnn = beforeInit.replace(ANNOTATION_RE, ' ');
            if (/[()]/.test(withoutAnn)) continue; // declaração de método abstrato
            const d = parseDeclaration(beforeInit);
            if (!d || d.modifiers.has('static') || d.modifiers.has('transient')) continue;
            if (/@(?:[\w.]*\.)?(JsonIgnore|Expose\s*\(\s*serialize\s*=\s*false)/.test(beforeInit)) continue;
            fields.push({ name: d.name, jsonName: d.jsonName || d.name, type: d.type, line: lineNo });
        }
    }
    return { fields, superName };
}

function sourceRootOf(file) {
    const abs = path.resolve(file);
    const marker = `${path.sep}src${path.sep}main${path.sep}java${path.sep}`;
    const idx = abs.indexOf(marker);
    return idx >= 0 ? abs.slice(0, idx + marker.length - 1) : path.dirname(abs);
}

function createClassLocator(explicitFiles, roots) {
    const index = new Map();
    let indexed = false;
    const walk = dir => {
        let entries;
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
        for (const e of entries) {
            if (e.name === 'node_modules' || e.name === 'target' || e.name.startsWith('.')) continue;
            const full = path.join(dir, e.name);
            if (e.isDirectory()) walk(full);
            else if (e.name.endsWith('.java')) {
                const base = e.name.slice(0, -5);
                if (!index.has(base)) index.set(base, []);
                index.get(base).push(full);
            }
        }
    };
    const cache = new Map();
    return function locate(name, preferDir) {
        if (cache.has(name)) return cache.get(name);
        let found = null;
        for (const f of explicitFiles) {
            const text = readCached(f);
            if (text && findTypeDeclaration(stripJavaComments(text), name)) { found = f; break; }
        }
        if (!found) {
            if (!indexed) { for (const r of roots) walk(r); indexed = true; }
            const candidates = index.get(name) || [];
            // Homônimo em pacotes diferentes: prefere o mais perto do Resource.
            found = candidates.sort((a, b) => commonPrefix(b, preferDir) - commonPrefix(a, preferDir))[0] || null;
        }
        cache.set(name, found);
        return found;
    };
}

function commonPrefix(a, b) {
    let i = 0;
    while (i < a.length && i < (b || '').length && a[i] === b[i]) i++;
    return i;
}

const fileCache = new Map();
function readCached(file) {
    if (!fileCache.has(file)) {
        try { fileCache.set(file, fs.readFileSync(file, 'utf8')); } catch { fileCache.set(file, null); }
    }
    return fileCache.get(file);
}

function dtoFields(locate, name, preferDir, depth = 0) {
    const file = locate(name, preferDir);
    if (!file) return null;
    const parsed = dtoFieldsFromSource(readCached(file), name);
    if (!parsed) return null;
    let fields = parsed.fields.map(f => ({ ...f, file }));
    if (parsed.superName && depth < 4) {
        const parent = dtoFields(locate, parsed.superName, preferDir, depth + 1);
        if (parent) fields = [...parent.fields, ...fields];
    }
    return { file, fields };
}

const NOT_A_DTO = /^(String|Object|Map|HashMap|JsonObject|JsonNode|JsonElement|InputStream|byte\[\]|Response|void|MultipartFormDataInput|FormDataMultiPart)$/;

function innerType(type) {
    const t = String(type || '').replace(/\s+/g, '');
    const generic = /^(?:[\w.]*\.)?(?:List|Set|Collection|ArrayList|Iterable)<(.+)>$/.exec(t);
    const base = (generic ? generic[1] : t.replace(/\[\]$/, '')).replace(/<.*$/, '');
    return base.split('.').pop();
}

function dtoCandidates(op, ep) {
    const out = [];
    const push = (name, how) => { if (name && !NOT_A_DTO.test(name) && !out.some(c => c.name === name)) out.push({ name, how }); };
    push(op.requestBody?.javaDto, 'x-java-dto');
    const bodyParam = ep.params.find(p => p.source === 'body' && p.type);
    if (bodyParam) push(innerType(bodyParam.type), `parâmetro ${bodyParam.name}`);
    for (const m of ep.body.matchAll(/\b([A-Z][\w$]*)\s*\.\s*class\b/g)) push(m[1], `${m[1]}.class no método`);
    push(op.requestBody?.refName, '$ref');
    return out;
}

// ---------------------------------------------------------------------------
// Validação

function validate({ contractText, contractFile = null, javaFiles, roots = null }) {
    const doc = parseYaml(contractText);
    const ops = contractOperations(doc);
    const resources = [];
    const endpoints = [];
    for (const f of javaFiles) {
        const text = readCached(f);
        if (text == null) continue;
        const eps = javaEndpoints(f, text);
        if (eps.length) { resources.push(f); endpoints.push(...eps); }
    }
    const locate = createClassLocator(javaFiles, roots || [...new Set(javaFiles.map(sourceRootOf))]);
    const divergences = [];
    const report = [];
    const add = (severity, type, op, detail, extra = {}) => divergences.push({
        severity, type, method: op.method, path: op.path, detail, ...extra,
    });

    for (const op of ops) {
        const candidates = endpoints.filter(ep => ep.method === op.method && pathsMatch(op.path, ep.path));
        const ep = (op.javaMethod && candidates.find(c => c.name === op.javaMethod)) || candidates[0];
        if (!ep) {
            const sameName = op.javaMethod && endpoints.find(e => e.name === op.javaMethod);
            add('FAIL', 'endpoint_not_found', op, sameName
                ? `método ${op.javaMethod} existe mas é ${sameName.method} ${sameName.path}, não ${op.method} ${op.path}`
                : `nenhum método @${op.method} com @Path casando ${op.path} nos Resources analisados`,
            sameName ? { file: sameName.file, line: sameName.line } : {});
            report.push({ method: op.method, path: op.path, found: false });
            continue;
        }
        const where = { file: ep.file, line: ep.line, javaMethod: ep.name };
        const entry = { method: op.method, path: op.path, found: true, ...where, javaPath: ep.path, dto: null, statuses: [] };
        report.push(entry);

        const cNames = (normalizePath(op.path).match(/\{([^}]+)\}/g) || []);
        const jNames = (normalizePath(ep.path).match(/\{([^}]+)\}/g) || []);
        const jSuffix = cNames.slice(cNames.length - jNames.length);
        jNames.forEach((n, idx) => {
            if (jSuffix[idx] !== n) add('WARN', 'path_param_name', op, `parâmetro de path ${jSuffix[idx]} no contrato é ${n} no @Path`, where);
        });

        // Request body x DTO
        const rb = op.requestBody;
        if (rb && Object.keys(rb.properties).length) {
            let dto = null;
            let how = null;
            for (const c of dtoCandidates(op, ep)) {
                dto = dtoFields(locate, c.name, path.dirname(path.resolve(ep.file)));
                if (dto) { how = c; break; }
            }
            if (!dto) {
                add('WARN', 'dto_not_found', op, 'request body com schema no contrato, mas o DTO não foi localizado '
                    + '(defina x-java-dto no requestBody do contrato ou passe o .java do DTO na linha de comando)', where);
            } else {
                entry.dto = { name: how.name, resolvedBy: how.how, file: dto.file, fields: dto.fields.map(f => f.jsonName) };
                const byJson = new Map(dto.fields.map(f => [f.jsonName, f]));
                for (const [prop, schema] of Object.entries(rb.properties)) {
                    const field = byJson.get(prop);
                    if (!field) {
                        add('FAIL', 'missing_field', op, `campo "${prop}"${rb.required.has(prop) ? ' (required)' : ''} do contrato ausente no DTO ${how.name}`,
                            { file: dto.file, field: prop, dto: how.name });
                        continue;
                    }
                    const cat = javaCategory(field.type);
                    if (!schemaAccepts(schema.type, cat)) {
                        add('WARN', 'type_mismatch', op, `campo "${prop}": contrato ${schema.type}, DTO ${field.type}`,
                            { file: field.file, line: field.line, field: prop, dto: how.name });
                    }
                }
                for (const f of dto.fields) {
                    if (!(f.jsonName in rb.properties)) {
                        add('WARN', 'extra_field', op, `campo "${f.jsonName}" do DTO ${how.name} não está no contrato`,
                            { file: f.file, line: f.line, field: f.jsonName, dto: how.name });
                    }
                }
            }
        }

        // Response 2xx com x-java-dto explícito: mesma checagem de campos.
        for (const [code, resp] of Object.entries(op.responses)) {
            const shape = resp.schema ? schemaShape(doc, resp.schema) : null;
            const name = resp.javaDto || shape?.javaDto;
            if (!/^2/.test(code) || !name || !shape || !Object.keys(shape.properties).length) continue;
            const dto = dtoFields(locate, name, path.dirname(path.resolve(ep.file)));
            if (!dto) { add('WARN', 'dto_not_found', op, `DTO de resposta ${name} (${code}) não localizado`, where); continue; }
            const names = new Set(dto.fields.map(f => f.jsonName));
            for (const prop of Object.keys(shape.properties)) {
                if (!names.has(prop)) add('FAIL', 'missing_response_field', op, `campo "${prop}" da resposta ${code} ausente no DTO ${name}`, { file: dto.file, field: prop, dto: name });
            }
        }

        // Status codes
        const { codes, dynamic } = javaStatuses(ep.body, ep.bodyLine || ep.line);
        entry.statuses = [...codes.keys()].sort();
        const declared = Object.keys(op.responses);
        const hasDefault = declared.includes('default');
        const declaredCovers = code => declared.includes(String(code)) || declared.some(d => /^[1-5]XX$/i.test(d) && d[0] === String(code)[0]);
        if (!hasDefault) {
            for (const [code, line] of codes) {
                if (!declaredCovers(code)) {
                    add('FAIL', 'status_not_in_contract', op, `método retorna ${code}, que o contrato não declara (declarados: ${declared.join(', ') || 'nenhum'})`,
                        { file: ep.file, line, status: code });
                }
            }
        }
        for (const d of dynamic) {
            add('WARN', 'dynamic_status', op, `status calculado em tempo de execução (${d.expr}) — conferir manualmente`, { file: ep.file, line: d.line });
        }
        const success = declared.filter(d => /^2\d\d$/.test(d)).map(Number);
        const codeSuccess = [...codes.keys()].filter(c => c >= 200 && c < 300);
        if (success.length && !codeSuccess.length && !dynamic.length && codes.size) {
            add('FAIL', 'success_status_missing', op, `contrato declara ${success.join('/')} mas o método não retorna nenhum 2xx explícito`, where);
        } else if (!codes.size && !dynamic.length) {
            add('WARN', 'no_status_detected', op, 'nenhum status explícito encontrado no corpo do método (delegação a outro método?) — conferir manualmente', where);
        }
        for (const code of success) {
            if (codeSuccess.length && !codes.has(code) && !dynamic.length) {
                add('WARN', 'declared_status_unused', op, `contrato declara ${code} mas o método não o retorna explicitamente`, where);
            }
        }
        for (const d of declared) {
            // 500 vem do ExceptionMapper/servidor; os demais 4xx/5xx do contrato que o
            // método não produz explicitamente podem vir de validação central — WARN.
            if (!/^[45]\d\d$/.test(d) || d === '500' || codes.has(Number(d))) continue;
            add('WARN', 'declared_status_unused', op, `contrato declara ${d} mas o método não o retorna explicitamente`, where);
        }
    }

    const fail = divergences.filter(d => d.severity === 'FAIL').length;
    return {
        contract: contractFile,
        resources,
        endpoints: report,
        divergences,
        summary: { operations: ops.length, fail, warn: divergences.length - fail, passed: fail === 0 },
    };
}

function toMarkdown(result, baseDir = process.cwd()) {
    if (!result.divergences.length) return `- [PASS] contrato OpenAPI: ${result.summary.operations} operação(ões) conferida(s), sem divergências`;
    return result.divergences.map(d => {
        const loc = d.file ? ` (${path.relative(baseDir, path.resolve(d.file))}${d.line ? `:${d.line}` : ''})` : '';
        return `- [${d.severity}] OpenAPI ${d.method} ${d.path} — ${d.type}: ${d.detail}${loc}`;
    }).join('\n');
}

function collectJava(target) {
    let st;
    try { st = fs.statSync(target); } catch { return null; }
    if (st.isFile()) return [target];
    const out = [];
    const walk = dir => {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
            if (e.name === 'node_modules' || e.name === 'target' || e.name.startsWith('.')) continue;
            const full = path.join(dir, e.name);
            if (e.isDirectory()) walk(full); else if (e.name.endsWith('.java')) out.push(full);
        }
    };
    walk(target);
    return out;
}

module.exports = {
    validate, toMarkdown, parseYaml, contractOperations, javaEndpoints, javaStatuses,
    dtoFieldsFromSource, pathsMatch, normalizePath, stripJavaComments,
};

if (require.main === module) {
    const args = process.argv.slice(2);
    const rootIdx = args.indexOf('--root');
    const roots = rootIdx >= 0 ? [args[rootIdx + 1]] : null;
    const positional = args.filter((a, idx) => !a.startsWith('--') && !(rootIdx >= 0 && idx === rootIdx + 1));
    const [contractFile, ...targets] = positional;
    const usage = 'Uso: node scripts/lib/openapi-validator.js <openapi-contract.yaml> <Resource.java|dir> [Outro.java ...] [--root <dir>] [--md]';
    if (!contractFile || !targets.length || !fs.existsSync(contractFile)) {
        console.error(usage);
        process.exit(2);
    }
    const javaFiles = [];
    for (const t of targets) {
        const files = collectJava(t);
        if (!files) { console.error(`arquivo não encontrado: ${t}\n${usage}`); process.exit(2); }
        javaFiles.push(...files);
    }
    let result;
    try {
        result = validate({ contractText: fs.readFileSync(contractFile, 'utf8'), contractFile, javaFiles, roots });
    } catch (e) {
        console.log(JSON.stringify({ contract: contractFile, error: e.message }, null, 2));
        process.exit(2);
    }
    console.log(args.includes('--md') ? toMarkdown(result) : JSON.stringify(result, null, 2));
    process.exit(result.summary.passed ? 0 : 1);
}
