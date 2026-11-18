#!/usr/bin/env node
'use strict';
// Mapa de capacidades: a fonte é o cabeçalho de cada docs/capacidades/<id>.md. Não há
// índice separado. Página de entrada: docs/capacidades/README.md.
//
//   node scripts/capability-map.js --of scripts/cas.js    → imprime "estado" e sai 0
//   node scripts/capability-map.js --check                → confere o mapa, a tabela e os links
//   node scripts/capability-map.js --write                → regenera a tabela do README
//
// --of sai 1 quando o arquivo não tem exatamente uma capacidade dona. --check lista cada
// problema com o arquivo e o comando que confere a correção, fecha com a contagem e sai 1
// se houver problema. Os três comandos saem 2 em erro de uso ou de cabeçalho. O cabeçalho é
// um subconjunto de YAML lido aqui mesmo (o repo não tem biblioteca de YAML): texto simples,
// lista em linha ([a, b]) ou lista em bloco ("- a"). Qualquer outra forma é erro, e campo
// fora dos nove conhecidos também (dois são opcionais: depende_de e adrs, ausentes = []). Como em YAML, " #" começa um comentário: o texto depois
// dele some. Um padrão de `modulos` é um caminho exato ou um prefixo terminado em "*"; não há
// precedência entre padrões. Os links conferidos são os inline, [t](alvo): link por
// referência ([t]: alvo) e HTML (<a href>) não são conferidos.
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const CAPABILITIES_PATH = 'docs/capacidades';
const CLI = 'node scripts/capability-map.js';
const README_PATH = `${CAPABILITIES_PATH}/README.md`;
const TABLE_BEGIN = '<!-- capacidades:inicio -->';
const TABLE_END = '<!-- capacidades:fim -->';
const USAGE = `uso: ${CLI} --check | --write | --of <caminho>`;

// O que precisa de capacidade dona: o código dos dois pacotes e tudo o que define os nós e
// o grafo. Teste segue o vizinho; fixture e .gitkeep não são código. Só `*.test.js` é teste,
// como na receita (harness/run-tests.js): um `*.test.mjs` novo precisaria de dona.
const CODE_ROOTS = ['scripts/', 'dashboard/'];
const CODE_EXTENSIONS = ['.js', '.mjs', '.cjs', '.sh'];
const WHOLE_ROOTS = ['.claude/commands/', '.graph/'];
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'coverage']);

const TEXT_FIELDS = ['id', 'tipo', 'resumo', 'situacao', 'spec'];
const LIST_FIELDS = ['flags', 'modulos'];
// Opcionais: ausentes valem []. Cada item segue o padrão do campo (só o formato; a existência
// do ID não é conferida aqui).
const OPTIONAL_LIST_FIELDS = {
    depende_de: /^[a-z][a-z0-9-]*$/,
    adrs: /^ADR-\d{4}$/,
};
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

function parseHeader(text) {
    const fields = readFields(text);
    for (const field of Object.keys(fields)) {
        if (![...TEXT_FIELDS, ...LIST_FIELDS, ...Object.keys(OPTIONAL_LIST_FIELDS)].includes(field)) fail(`campo desconhecido: ${field}`);
    }
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
    for (const [field, pattern] of Object.entries(OPTIONAL_LIST_FIELDS)) {
        if (!(field in fields)) {
            fields[field] = [];
            continue;
        }
        if (fields[field] === null) fail(`campo vazio: ${field}`);
        if (!Array.isArray(fields[field])) fail(`${field} deve ser uma lista ([a, b] ou itens com "- ")`);
        for (const item of fields[field]) {
            if (!pattern.test(item)) fail(`${field}: "${item}" fora do formato ${pattern.source}`);
        }
    }
    return Object.fromEntries([...TEXT_FIELDS, ...LIST_FIELDS, ...Object.keys(OPTIONAL_LIST_FIELDS)].map(field => [field, fields[field]]));
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

function owns(capability, file) {
    return capability.modulos.some(pattern => matches(pattern, file));
}

function ownersOf(capabilities, file) {
    return capabilities.filter(capability => owns(capability, file)).map(capability => capability.id);
}

function isCovered(file) {
    const parts = file.split('/');
    const name = parts.at(-1);
    if (name === '.gitkeep' || name.endsWith('.test.js') || parts.includes('fixtures')) return false;
    if (WHOLE_ROOTS.some(root => file.startsWith(root))) return true;
    return CODE_ROOTS.some(root => file.startsWith(root)) && CODE_EXTENSIONS.includes(path.extname(name));
}

function walk(root, rel = '') {
    return fs.readdirSync(path.join(root, rel), { withFileTypes: true }).flatMap(entry => {
        const child = rel ? `${rel}/${entry.name}` : entry.name;
        if (entry.isDirectory()) return SKIP_DIRS.has(entry.name) ? [] : walk(root, child);
        return entry.isFile() ? [child] : [];
    });
}

// Mesma listagem da receita de testes (harness/run-tests.js): com git, os versionados mais
// os novos não ignorados; sem git (export), o disco, pulando SKIP_DIRS. Só o disco pula
// essas pastas: com git, vale o que o git lista, igual à receita.
function listFiles(root) {
    if (!fs.existsSync(path.join(root, '.git'))) return walk(root).sort();
    const args = ['-C', root, 'ls-files', '-z', '--cached', '--others', '--exclude-standard'];
    const git = spawnSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    if (git.status !== 0) throw new Error(`git ls-files falhou: ${(git.stderr || git.error?.message || '').trim()}`);
    return [...new Set(git.stdout.split('\0'))].filter(rel => rel && fs.existsSync(path.join(root, rel))).sort();
}

// Nomes (identificadores) que aparecem no código de uma capacidade. A flag conta quando é
// um deles por inteiro: SPEC_X dentro de SPEC_X_MAX não conta.
function namesInCode(root, files) {
    return new Set(files.flatMap(file => fs.readFileSync(path.join(root, file), 'utf8').split(/[^A-Za-z0-9_]+/)));
}

// Confere o mapa de um repo e devolve { total, problems: [{ rule, message }] }. `total` é
// quantos arquivos precisam de dona. Cada mensagem cita o arquivo e o comando que confere.
function checkMap(root) {
    const capabilities = readCapabilities(path.join(root, CAPABILITIES_PATH));
    const files = listFiles(root);
    const covered = files.filter(isCovered);
    const problems = [];
    const add = (rule, message) => problems.push({ rule, message });

    for (const file of covered) {
        const owners = ownersOf(capabilities, file);
        const confirm = `confira: ${CLI} --of ${file}`;
        if (!owners.length) {
            add('sem-dona', `${file}: sem capacidade dona. Inclua o caminho em "modulos" de um ${CAPABILITIES_PATH}/<id>.md e ${confirm}`);
        } else if (owners.length > 1) {
            add('mais-de-uma-dona', `${file}: mais de uma capacidade dona (${owners.join(', ')}). Deixe o caminho em "modulos" de uma só e ${confirm}`);
        }
    }
    for (const capability of capabilities) {
        const doc = `${CAPABILITIES_PATH}/${capability.id}.md`;
        const confirm = `confira: ${CLI} --check`;
        for (const pattern of capability.modulos) {
            if (files.some(file => matches(pattern, file))) continue;
            add('padrao-sem-arquivo', `${doc}: o padrão "${pattern}" não casa com nenhum arquivo. Corrija ou tire o padrão e ${confirm}`);
        }
        if (!capability.flags.length) continue;
        const names = namesInCode(root, covered.filter(file => owns(capability, file)));
        for (const flag of capability.flags) {
            if (names.has(flag)) continue;
            const fix = 'Tire a flag do cabeçalho ou inclua em "modulos" o arquivo que a lê';
            add('flag-fora-do-codigo', `${doc}: a flag ${flag} não aparece no código da capacidade. ${fix}, e ${confirm}`);
        }
    }
    return { total: covered.length, problems };
}

function summary({ total, problems }) {
    if (!problems.length) return `mapa de capacidades: ${total} arquivos, cada um com uma capacidade dona`;
    const count = rule => problems.filter(problem => problem.rule === rule).length;
    return [
        `mapa de capacidades: faltam ${count('sem-dona')} de ${total} arquivos (sem capacidade dona)`,
        `com mais de uma dona: ${count('mais-de-uma-dona')}`,
        `padrões sem arquivo: ${count('padrao-sem-arquivo')}`,
        `flags fora do código: ${count('flag-fora-do-codigo')}`,
    ].join('; ');
}

// Tabela do README: uma linha por capacidade, montada só do cabeçalho.
function renderTable(capabilities) {
    const cell = text => text.replace(/\|/g, '\\|');
    return [
        '| Capacidade | Tipo | Situação | Spec | O que faz |',
        '| -- | -- | -- | -- | -- |',
        ...capabilities.map(c => `| [${c.id}](${c.id}.md) | ${c.tipo} | ${c.situacao} | ${c.spec} | ${cell(c.resumo)} |`),
    ].join('\n');
}

// Troca só o que está entre os marcadores; o resto do README fica byte a byte.
function applyTable(text, table) {
    const begin = text.indexOf(TABLE_BEGIN);
    const end = text.indexOf(TABLE_END);
    if (begin === -1 || end === -1 || end < begin) {
        throw new Error(`${README_PATH}: faltam os marcadores ${TABLE_BEGIN} e ${TABLE_END}, nesta ordem`);
    }
    return `${text.slice(0, begin + TABLE_BEGIN.length)}\n${table}\n${text.slice(end)}`;
}

function expectedReadme(root) {
    const capabilities = readCapabilities(path.join(root, CAPABILITIES_PATH));
    const file = path.join(root, README_PATH);
    const current = fs.readFileSync(file, 'utf8');
    return { file, current, next: applyTable(current, renderTable(capabilities)) };
}

// Devolve a mensagem de tabela defasada, ou null quando o README está em dia.
function checkTable(root) {
    const { current, next } = expectedReadme(root);
    if (current === next) return null;
    return `${README_PATH}: a tabela de capacidades está defasada dos cabeçalhos. Rode ${CLI} --write e inclua o README no commit`;
}

// Reescreve a tabela; devolve true se o README mudou.
function writeTable(root) {
    const { file, current, next } = expectedReadme(root);
    if (current === next) return false;
    fs.writeFileSync(file, next);
    return true;
}

// Links relativos das páginas de docs/capacidades. Confere inline `[t](alvo)` e `![t](alvo)`,
// fora de bloco de código e de código em linha. Externo (esquema:), mailto e âncora pura não
// são conferidos; #âncora e ?query de link local são tirados antes de olhar o arquivo. Link
// com "/" inicial parte da raiz do repo; "%20" e afins são decodificados. Devolve uma mensagem
// por link quebrado.
const LINK = /!?\[[^[\]]*\]\(\s*(<[^>]*>|[^\s)]+)(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)/g;

function linksIn(text) {
    let fenced = false;
    const found = [];
    for (const line of text.split('\n')) {
        if (/^\s*(```|~~~)/.test(line)) {
            fenced = !fenced;
            continue;
        }
        if (fenced) continue;
        for (const match of line.replace(/`[^`]*`/g, '').matchAll(LINK)) {
            found.push(match[1].replace(/^<|>$/g, ''));
        }
    }
    return found;
}

// "%20" no link é o espaço do nome do arquivo. Escape malformado fica como está e, sem arquivo
// com esse nome, vira link quebrado.
function decodeLink(target) {
    try {
        return decodeURI(target);
    } catch {
        return target;
    }
}

function checkLinks(root) {
    const dir = path.join(root, CAPABILITIES_PATH);
    const problems = [];
    for (const name of fs.readdirSync(dir).filter(file => file.endsWith('.md')).sort()) {
        const doc = `${CAPABILITIES_PATH}/${name}`;
        for (const link of linksIn(fs.readFileSync(path.join(dir, name), 'utf8'))) {
            if (link.startsWith('#') || /^[a-z][a-z0-9+.-]*:/i.test(link)) continue;
            const target = decodeLink(link.replace(/[#?].*$/, ''));
            const file = target.startsWith('/') ? path.join(root, target) : path.resolve(dir, target);
            const inside = path.relative(root, file);
            if (inside === '..' || inside.startsWith(`..${path.sep}`) || path.isAbsolute(inside)) {
                problems.push(`${doc}: o link "${link}" aponta para fora do repositório. Use um caminho dentro dele ou tire o link`);
                continue;
            }
            if (!target || fs.existsSync(file)) continue;
            problems.push(`${doc}: o link "${link}" não aponta para um arquivo que existe. Corrija o caminho ou tire o link`);
        }
    }
    return problems;
}

function runCheck() {
    const report = checkMap(ROOT);
    for (const { message } of report.problems) console.error(message);
    const stale = checkTable(ROOT);
    if (stale) console.error(stale);
    const broken = checkLinks(ROOT);
    for (const message of broken) console.error(message);
    console.log(summary(report));
    return report.problems.length || stale || broken.length ? 1 : 0;
}

function runWrite() {
    console.log(writeTable(ROOT) ? `${README_PATH}: tabela atualizada` : `${README_PATH}: tabela já estava em dia`);
    return 0;
}

function runOf(target) {
    const file = path.relative(ROOT, path.resolve(target)).split(path.sep).join('/');
    const owners = ownersOf(readCapabilities(path.join(ROOT, CAPABILITIES_PATH)), file);
    if (owners.length === 1) {
        console.log(owners[0]);
        return 0;
    }
    console.error(owners.length ? `${file}: mais de uma capacidade dona (${owners.join(', ')})` : `${file}: sem capacidade dona`);
    return 1;
}

function main(args) {
    const [command, target] = args;
    try {
        if (command === '--check' && args.length === 1) return runCheck();
        if (command === '--write' && args.length === 1) return runWrite();
        if (command === '--of' && args.length === 2 && target) return runOf(target);
    } catch (error) {
        console.error(error.message);
        return 2;
    }
    console.error(USAGE);
    return 2;
}

module.exports = {
    parseHeader, readFields, readCapabilities, matches, ownersOf, isCovered, checkMap, summary, renderTable, applyTable, checkTable, writeTable, checkLinks,
};
if (require.main === module) process.exitCode = main(process.argv.slice(2));
