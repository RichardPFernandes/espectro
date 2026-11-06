'use strict';
// Writer SDD (PRI-266) — utilitários SÓ de teste. Nunca importado por código de produção
// (WT-F0-02 confere). Sabotagem por mutação: cada proteção do writer fica entre
//   // @guard <ID>   …   [// @else   // <linha alternativa> …]   // @end <ID>
// e loadMutant() copia o writer para TMPDIR, remove o bloco protegido (ou troca pela
// alternativa comentada) e carrega a cópia. Não existe flag de sabotagem em produção.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const LIB = __dirname;
// Arquivos que o writer carrega (ele + primitivas permitidas pela F0).
const WRITER_SUPPORT = ['spec-hash.js', 'spec-headings.js'];

function writerFiles() {
    return fs.readdirSync(LIB).filter(f => /^sdd-writer.*\.js$/.test(f) && !f.endsWith('.test.js'));
}

function applyGuard(src, guardId, file) {
    const lines = src.split('\n');
    const open = lines.findIndex(l => l.trim() === `// @guard ${guardId}`);
    const close = lines.findIndex((l, i) => i > open && l.trim() === `// @end ${guardId}`);
    if (open < 0 || close < 0) throw new Error(`guard "${guardId}" não encontrado em ${file}`);
    const elseIdx = lines.findIndex((l, i) => i > open && i < close && l.trim() === '// @else');
    const alt = elseIdx < 0 ? [] : lines.slice(elseIdx + 1, close).map(l => l.replace(/^(\s*)\/\/ ?/, '$1'));
    return [...lines.slice(0, open), ...alt, ...lines.slice(close + 1)].join('\n');
}

let mutantSeq = 0;
/**
 * Carrega o writer com uma ou mais proteções retiradas.
 * @param {Array<[string,string]>|[string,string]} mutations [arquivo, guardId]
 * @param {string} [entry] módulo a devolver (padrão: o índice sdd-writer.js)
 */
function loadMutant(mutations, entry = 'sdd-writer.js') {
    const list = Array.isArray(mutations[0]) ? mutations : [mutations];
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `sdd-mutant-${process.pid}-${mutantSeq++}-`));
    for (const f of [...writerFiles(), ...WRITER_SUPPORT]) {
        fs.copyFileSync(path.join(LIB, f), path.join(dir, f));
    }
    for (const [file, guard] of list) {
        const p = path.join(dir, file);
        fs.writeFileSync(p, applyGuard(fs.readFileSync(p, 'utf8'), guard, file));
    }
    return require(path.join(dir, entry));
}

/** Lista todos os guards declarados (para conferir que cada um tem sabotagem). */
function listGuards() {
    const out = [];
    for (const f of writerFiles()) {
        const src = fs.readFileSync(path.join(LIB, f), 'utf8');
        for (const m of src.matchAll(/^\s*\/\/ @guard (\S+)\s*$/gm)) out.push([f, m[1]]);
    }
    return out;
}

function tmpDir(prefix = 'sdd-test-') {
    return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

module.exports = { loadMutant, applyGuard, listGuards, writerFiles, tmpDir, LIB };
