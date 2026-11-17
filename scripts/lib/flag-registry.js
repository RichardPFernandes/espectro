'use strict';
// PRI-377 (F1.1): confere o registro de flags (docs/flags.md) contra o código.
//
// Ferramenta offline: não é lida por nenhuma Run. O scanner de leituras de ambiente é o
// da regra `env-documented` do config-validator; aqui só se acrescenta (a) a tabela e
// (b) o reconhecimento de leitura com forma de flag. Não há segundo scanner.
//
// O que uma flag é aqui: variável de ambiente ou chave de arquivo que liga, desliga ou
// escolhe um comportamento. Caminho, porta, limite, URL e credencial são configuração e
// ficam só no .env.example.

const fs = require('fs');
const path = require('path');
const { loadContract, ENV_READ_RES, scanFiles, envReadsInCode } = require('./config-validator');

const REGISTRY_REL = 'docs/flags.md';

const COLUMNS = [
    'Flag', 'Onde', 'Padrão', 'Issue', 'Consumidor',
    'Ligar quando', 'Desligar ou remover quando', 'Decidir até', 'Item desligado',
];
const KEY = {
    'Flag': 'flag', 'Onde': 'onde', 'Padrão': 'padrao', 'Issue': 'issue', 'Consumidor': 'consumidor',
    'Ligar quando': 'ligar', 'Desligar ou remover quando': 'desligar', 'Decidir até': 'decidirAte', 'Item desligado': 'desligado',
};

// Formas de booleano que o código usa: /^(1|true|sim)$/i, === 'on', !== '0', || 'off'.
const GATE_RES = [
    /\/\^\((?:1|0)\|[^)]*\)\$\//,
    /(?:===|!==|==|!=)\s*['"](?:1|0|true|false|on|off)['"]/,
    /\|\|\s*['"](?:on|off)['"]/,
    /\[\s*['"](?:on|off)['"][^\]]*\]\.includes\(/,
];
// `const flag = env.NOME;` guarda a leitura num alias que só é comparado mais adiante.
const ALIAS_RE = /^\s*(?:const|let|var)\s+(\w+)\s*=\s*(?:process\.)?\w*[eE]nv\.([A-Z][A-Z0-9_]{2,})\s*;?\s*(?:\/\/.*)?$/;

const cells = line => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim().replace(/^`(.*)`$/, '$1'));

function parseFlagRegistry(markdown) {
    const lines = String(markdown || '').split('\n');
    const start = lines.findIndex((l, i) => /^\|\s*`?Flag`?\s*\|/.test(l) && /^\|[\s|:-]+\|?\s*$/.test(lines[i + 1] || ''));
    if (start < 0) return { rows: [], errors: ['nenhuma tabela de flags encontrada (primeira coluna "Flag")'] };
    const header = cells(lines[start]);
    if (header.join('|') !== COLUMNS.join('|')) {
        return { rows: [], errors: [`cabeçalho da tabela diferente do esperado: ${COLUMNS.join(' | ')}`] };
    }
    const rows = [];
    const errors = [];
    for (let i = start + 2; i < lines.length && lines[i].trim().startsWith('|'); i++) {
        const c = cells(lines[i]);
        if (c.length !== COLUMNS.length) { errors.push(`linha ${i + 1}: ${c.length} colunas, esperado ${COLUMNS.length}`); continue; }
        const row = { line: i + 1 };
        COLUMNS.forEach((name, j) => { row[KEY[name]] = c[j]; });
        rows.push(row);
    }
    return { rows, errors };
}

// Nomes de variável lidos com forma de flag (comentário não conta): leitura e comparação de
// booleano na mesma linha, ou leitura atribuída a um alias que é comparado depois no arquivo.
// Seletor de valor (PREVIEW_ADAPTER) e leitura fora do scanner entram só à mão na tabela.
function flagShapedReads(lines) {
    const out = new Set();
    const aliases = new Map(); // identificador -> variável
    for (const line of lines) {
        if (/^\s*(\/\/|\*)/.test(line)) continue;
        const a = ALIAS_RE.exec(line);
        if (a) aliases.set(a[1], a[2]);
    }
    for (const line of lines) {
        if (/^\s*(\/\/|\*)/.test(line) || !GATE_RES.some(g => g.test(line))) continue;
        for (const re of ENV_READ_RES) {
            re.lastIndex = 0;
            let m;
            while ((m = re.exec(line))) out.add(m[1]);
        }
        for (const [id, name] of aliases) if (new RegExp(`\\b${id}\\b`).test(line)) out.add(name);
    }
    return out;
}

function validDate(s) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
    if (!m) return false;
    const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
    return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3];
}

// Data em UTC: o CI e a máquina do Richard concordam sobre o dia em que a data vence.
function todayUtc(now = new Date()) {
    return now.toISOString().slice(0, 10);
}

const ISSUE_RE = /^(sem issue|PRI-\d+(, PRI-\d+)*)$/;

// Pura: recebe a tabela e o que o código lê; devolve problemas, sem tocar disco.
//   reads: Set de variáveis lidas; flagReads: Set das lidas com forma de flag;
//   sourceExists(onde): confere arquivo ou chave quando a flag não é de ambiente.
function checkFlagRegistry({ markdown, reads, flagReads, sourceExists, today }) {
    const { rows, errors } = parseFlagRegistry(markdown);
    const problems = errors.map(message => ({ code: 'PARSE_ERROR', flag: '-', message }));
    const add = (code, flag, message) => problems.push({ code, flag, message });
    const seen = new Set();
    for (const r of rows) {
        const f = r.flag || `(linha ${r.line})`;
        if (seen.has(r.flag)) { add('DUPLICATE', f, 'flag listada duas vezes'); continue; }
        seen.add(r.flag);

        for (const k of ['flag', 'onde', 'padrao', 'issue', 'consumidor', 'ligar', 'desligar', 'desligado']) {
            if (!r[k]) add('ROW_INCOMPLETE', f, `coluna vazia: ${COLUMNS.find(c => KEY[c] === k)}`);
        }
        if (r.padrao && !['ligada', 'desligada'].includes(r.padrao)) add('VALUE_INVALID', f, `Padrão deve ser ligada ou desligada (veio "${r.padrao}")`);
        if (r.desligado && !['sim', 'não'].includes(r.desligado)) add('VALUE_INVALID', f, `Item desligado deve ser sim ou não (veio "${r.desligado}")`);
        if (r.issue && !ISSUE_RE.test(r.issue)) add('VALUE_INVALID', f, `Issue deve ser PRI-N (separadas por vírgula) ou "sem issue" (veio "${r.issue}")`);
        if (r.desligado === 'sim' && r.padrao === 'ligada') add('VALUE_INVALID', f, 'item construído e desligado não pode ter padrão ligada');

        if (!r.decidirAte) add('DATE_MISSING', f, 'sem data de decisão');
        else if (!validDate(r.decidirAte)) add('DATE_INVALID', f, `data fora do formato AAAA-MM-DD (veio "${r.decidirAte}")`);
        else if (r.decidirAte < today) add('DATE_EXPIRED', f, `data de decisão vencida em ${r.decidirAte} (hoje ${today}): ligar, remover ou renovar com decisão`);

        if (r.onde === 'env') {
            if (!/^[A-Z][A-Z0-9_]*$/.test(r.flag)) add('VALUE_INVALID', f, 'flag de ambiente deve ser o nome da variável');
            else if (!reads.has(r.flag)) add('FLAG_NOT_READ', f, 'o código escaneado não lê esta variável: remova a linha ou corrija "Onde"');
        } else if (r.onde && !sourceExists(r.onde)) {
            add('SOURCE_MISSING', f, `fonte não encontrada: ${r.onde}`);
        }
    }
    for (const name of [...flagReads].sort()) {
        if (!seen.has(name)) add('READ_NOT_REGISTERED', name, `o código lê ${name} como flag e ela não está em ${REGISTRY_REL}: adicione a linha com data de decisão`);
    }
    return { problems, flags: rows.length, desligados: rows.filter(r => r.desligado === 'sim').length };
}

function sourceExistsIn(root) {
    return onde => {
        const [rel, key] = onde.split('#');
        const file = path.join(root, rel);
        try {
            if (!fs.statSync(file).isFile()) return false;
            if (!key) return true;
            const data = JSON.parse(fs.readFileSync(file, 'utf8'));
            return data !== null && typeof data === 'object' && key in data;
        } catch { return false; }
    };
}

const contextOf = (root, contractPath = path.join(root, '.claude', 'config-contract.json')) => ({ root, contract: loadContract(contractPath) });

function inspectRepo(root, { today = todayUtc(), contractPath } = {}) {
    let markdown;
    try { markdown = fs.readFileSync(path.join(root, REGISTRY_REL), 'utf8'); } catch {
        return { problems: [{ code: 'REGISTRY_MISSING', flag: '-', message: `${REGISTRY_REL} não existe` }], flags: 0, desligados: 0 };
    }
    const ctx = contextOf(root, contractPath);
    const reads = new Set(envReadsInCode(ctx).keys());
    const flagReads = new Set();
    for (const file of scanFiles(ctx)) for (const n of flagShapedReads(fs.readFileSync(file, 'utf8').split('\n'))) flagReads.add(n);
    return checkFlagRegistry({ markdown, reads, flagReads, sourceExists: sourceExistsIn(root), today });
}

module.exports = {
    REGISTRY_REL, COLUMNS, parseFlagRegistry, flagShapedReads, checkFlagRegistry, inspectRepo, todayUtc,
};
