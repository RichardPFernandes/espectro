'use strict';
// Leitor do cabeçalho (front-matter) das páginas de docs: subconjunto de YAML lido aqui mesmo
// (o repo não tem biblioteca de YAML). Texto simples, lista em linha ([a, b]) ou em bloco
// ("- a"); qualquer outra forma é erro. Como em YAML, " #" começa um comentário.
function fail(message) {
    throw new Error(`cabeçalho: ${message}`);
}

// Texto simples: sem aspas, sem mapa, sem bloco e sem ": " no meio (deixaria de ser YAML).
function plainText(raw, where) {
    const value = raw.trim();
    if (!value || /^["'{[|>&*!]/.test(value) || /:(\s|$)/.test(value)) {
        fail(`${where}: forma não suportada (use texto simples, [a, b] ou lista com "- ")`);
    }
    return value;
}

function inlineList(raw, where) {
    if (!raw.endsWith(']')) fail(`${where}: lista em linha sem "]"`);
    const inner = raw.slice(1, -1).trim();
    return inner ? inner.split(',').map(item => plainText(item, where)) : [];
}

// Lê as linhas entre os dois "---" e devolve { campo: texto | lista }, sem validar campos.
function readFields(text) {
    const lines = text.split('\n').map(line => line.trimEnd());
    const end = lines.indexOf('---', 1);
    if (lines[0] !== '---' || end === -1) fail('o arquivo não começa com um bloco entre duas linhas "---"');

    const fields = {};
    let block = null;
    for (let index = 1; index < end; index += 1) {
        const where = `linha ${index + 1}`;
        const line = lines[index].replace(/(?:^|\s)#.*$/, '');
        if (!line.trim()) continue;

        const item = /^\s+-\s+(.+)$/.exec(line);
        if (item) {
            if (!block) fail(`${where}: item de lista fora de uma lista`);
            fields[block] = [...(fields[block] || []), plainText(item[1], where)];
            continue;
        }
        const pair = /^([a-z_]+):(?:\s+(.*))?$/.exec(line);
        if (!pair) fail(`${where}: forma não suportada (use "campo: valor")`);
        const [, key, raw = ''] = pair;
        if (key in fields) fail(`${where}: campo repetido: ${key}`);

        block = raw ? null : key;
        if (!raw) fields[key] = null;
        else fields[key] = raw.startsWith('[') ? inlineList(raw, where) : plainText(raw, where);
    }
    return fields;
}

module.exports = { fail, readFields };
