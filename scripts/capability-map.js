#!/usr/bin/env node
'use strict';
// Mapa de capacidades: a fonte é o cabeçalho de cada docs/capacidades/<id>.md. Não há
// índice separado. Página de entrada: docs/capacidades/README.md.
//
//   node scripts/capability-map.js --of scripts/cas.js    → imprime "estado" e sai 0
//
// Sai 1 quando o arquivo não tem exatamente uma capacidade dona; 2 em erro de uso ou de
// cabeçalho. O cabeçalho é um subconjunto de YAML lido aqui mesmo (o repo não tem
// biblioteca de YAML): texto simples, lista em linha ([a, b]) ou lista em bloco ("- a").
// Qualquer outra forma é erro. Um padrão de `modulos` é um caminho exato ou um prefixo
// terminado em "*"; não há precedência entre padrões.
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const CAPABILITIES_DIR = path.join(ROOT, 'docs', 'capacidades');
const USAGE = 'uso: node scripts/capability-map.js --of <caminho>';

const TEXT_FIELDS = ['id', 'tipo', 'resumo', 'situacao', 'spec'];
const LIST_FIELDS = ['flags', 'modulos'];
const ENUMS = {
    tipo: ['base', 'capacidade', 'fluxo'],
    situacao: ['ligada', 'parcial', 'desligada', 'sem-chamador'],
    spec: ['sem-spec', 'rascunho', 'viva'],
};

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
        const line = lines[index].replace(/(^|\s+)#.*$/, '');
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

function parseHeader(text) {
    const fields = readFields(text);
    for (const field of [...TEXT_FIELDS, ...LIST_FIELDS]) {
        if (!(field in fields)) fail(`campo ausente: ${field}`);
        if (fields[field] === null) fail(`campo vazio: ${field}`);
    }
    for (const field of TEXT_FIELDS) {
        if (typeof fields[field] !== 'string') fail(`${field} deve ser um texto, não uma lista`);
    }
    for (const field of LIST_FIELDS) {
        if (!Array.isArray(fields[field])) fail(`${field} deve ser uma lista ([a, b] ou itens com "- ")`);
    }
    for (const [field, allowed] of Object.entries(ENUMS)) {
        if (!allowed.includes(fields[field])) fail(`${field}: "${fields[field]}" não é aceito; use um de: ${allowed.join(', ')}`);
    }
    if (!/^[a-z][a-z0-9-]*$/.test(fields.id)) fail(`id: "${fields.id}" deve ter só minúsculas, dígitos e hífen`);
    for (const pattern of fields.modulos) {
        if (pattern.slice(0, -1).includes('*')) fail(`modulos: "${pattern}" só aceita "*" no fim (caminho exato ou prefixo)`);
    }
    return Object.fromEntries([...TEXT_FIELDS, ...LIST_FIELDS].map(field => [field, fields[field]]));
}

// Uma capacidade por docs/capacidades/<id>.md, em ordem de id. O README é a página de entrada.
function readCapabilities(dir) {
    const names = fs.readdirSync(dir).filter(name => name.endsWith('.md') && name !== 'README.md').sort();
    return names.map(name => {
        const file = path.join(dir, name);
        let header;
        try {
            header = parseHeader(fs.readFileSync(file, 'utf8'));
        } catch (error) {
            throw new Error(`${file}: ${error.message}`, { cause: error });
        }
        if (`${header.id}.md` !== name) throw new Error(`${file}: id "${header.id}" difere do nome do arquivo`);
        return header;
    });
}

function matches(pattern, file) {
    return pattern.endsWith('*') ? file.startsWith(pattern.slice(0, -1)) : file === pattern;
}

function ownersOf(capabilities, file) {
    return capabilities.filter(capability => capability.modulos.some(pattern => matches(pattern, file))).map(capability => capability.id);
}

function main([command, target]) {
    if (command !== '--of' || !target) {
        console.error(USAGE);
        return 2;
    }
    const file = path.relative(ROOT, path.resolve(target)).split(path.sep).join('/');
    let owners;
    try {
        owners = ownersOf(readCapabilities(CAPABILITIES_DIR), file);
    } catch (error) {
        console.error(error.message);
        return 2;
    }
    if (owners.length === 1) {
        console.log(owners[0]);
        return 0;
    }
    console.error(owners.length ? `${file}: mais de uma capacidade dona (${owners.join(', ')})` : `${file}: sem capacidade dona`);
    return 1;
}

module.exports = { parseHeader, readCapabilities, matches, ownersOf };
if (require.main === module) process.exitCode = main(process.argv.slice(2));
