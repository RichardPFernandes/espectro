'use strict';
// Base de violações aceitas do lint ({ "<arquivo>": { "<regra>": n } }, caminhos relativos com "/"): só encolhe. Funções puras.

const path = require('path');

const PARSE_ERROR = 'parse-error';

/** Objeto com as chaves em ordem alfabética (saída estável). */
function sortKeys(obj) {
    const sorted = {};
    for (const key of Object.keys(obj).sort()) sorted[key] = obj[key];
    return sorted;
}

/** Conta violações por arquivo e regra a partir do array do `eslint -f json`. */
function countViolations(eslintResults, root) {
    const counts = {};
    for (const result of eslintResults) {
        if (!result.messages.length) continue;
        const file = path.relative(root, result.filePath).split(path.sep).join('/');
        const rules = counts[file] || (counts[file] = {});
        for (const message of result.messages) {
            const rule = message.ruleId || PARSE_ERROR;
            rules[rule] = (rules[rule] || 0) + 1;
        }
    }
    const sorted = {};
    for (const file of Object.keys(counts).sort()) sorted[file] = sortKeys(counts[file]);
    return sorted;
}

/** Compara a contagem atual com a base: o que passou dela (added) e o que ficou abaixo (shrunk). */
function compareToBaseline(current, baseline) {
    const added = [];
    const shrunk = [];
    const files = [...new Set([...Object.keys(current), ...Object.keys(baseline)])].sort();
    for (const file of files) {
        const now = current[file] || {};
        const base = baseline[file] || {};
        const rules = [...new Set([...Object.keys(now), ...Object.keys(base)])].sort();
        for (const rule of rules) {
            const n = now[rule] || 0;
            const b = base[rule] || 0;
            if (n > b) added.push({ file, rule, base: b, now: n });
            else if (n < b) shrunk.push({ file, rule, base: b, now: n });
        }
    }
    return { added, shrunk };
}

/** JSON da base com uma linha por arquivo e chaves ordenadas. */
function formatBaseline(counts) {
    const files = Object.keys(counts).sort();
    if (!files.length) return '{}\n';
    const lines = files.map(file => {
        const rules = Object.keys(counts[file]).sort()
            .map(rule => `${JSON.stringify(rule)}: ${counts[file][rule]}`)
            .join(', ');
        return `  ${JSON.stringify(file)}: {${rules}}`;
    });
    return `{\n${lines.join(',\n')}\n}\n`;
}

/** Nova base com a contagem atual no que encolheu, sem o que zerou. Lança se algo cresceu. */
function shrinkBaseline(current, baseline) {
    const { added } = compareToBaseline(current, baseline);
    if (added.length) {
        const list = added.map(a => `${a.file} ${a.rule} (${a.base} -> ${a.now})`).join('; ');
        throw new Error(`a base não cresce; violações acima dela: ${list}`);
    }
    const next = {};
    for (const file of Object.keys(baseline).sort()) {
        for (const rule of Object.keys(baseline[file]).sort()) {
            const n = (current[file] && current[file][rule]) || 0;
            if (n > 0) (next[file] || (next[file] = {}))[rule] = n;
        }
    }
    return next;
}

module.exports = { countViolations, compareToBaseline, formatBaseline, shrinkBaseline };
