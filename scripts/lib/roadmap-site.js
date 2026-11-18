// Camada de dados da página do roadmap: lê roadmap/fase-N-*/FASE.md (e arquivo/) e devolve
// { phases: [{ n, name, file, status, start, end, slices }] } ordenado por fase.
// Só lê arquivos. Reaproveita o parser do lint; as colunas são achadas pelo NOME do
// cabeçalho, nunca pela posição: coluna nova ou ausente não quebra o gerador.

const fs = require('fs');
const path = require('path');
const { STATUS_VOCAB, parseTables, parseSlices } = require('./roadmap-lint');

const DATES = /(\d{2})\/(\d{2})(?:\/(\d{4}))? a (\d{2})\/(\d{2})\/(\d{4})/;
const plain = s => String(s || '').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/[*_~`]/g, '').trim();

// Primeiro bloco `>` do arquivo, em uma linha só.
const firstQuote = text => (/^(?:>.*(?:\r?\n|$))+/m.exec(text) || [''])[0].replace(/^>\s?/gm, '').replace(/\s+/g, ' ');

function parsePhase(text, file) {
    const quote = firstQuote(text);
    const [, d1, m1, y1, d2, m2, y2] = DATES.exec(quote) || [];
    const iso = (y, m, d) => `${y}-${m}-${d}`;
    return {
        n: Number(/fase-(\d+)-/.exec(file)[1]),
        name: ((/^#\s+Fase\s+\d+\s+—\s*(.+)$/m.exec(text) || [])[1] || '').trim(),
        file,
        status: (/Status:\s*([^·.\n]+)/.exec(quote) || [])[1]?.trim() || null,
        start: y2 ? iso(y1 || (Number(m1) > Number(m2) ? y2 - 1 : y2), m1, d1) : null,
        end: y2 ? iso(y2, m2, d2) : null,
        slices: parseSiteSlices(text, file),
    };
}

function parseSiteSlices(text, file) {
    // Linhas das tabelas de fatias, por número de linha, com acesso às colunas pelo nome.
    const byLine = new Map();
    for (const { headers, rows } of parseTables(text)) {
        if (!headers.includes('id')) continue;
        const col = pred => headers.findIndex(pred);
        const idx = {
            name: col(h => h.startsWith('fatia')), dias: col(h => h.startsWith('dias')),
            nivel: col(h => h === 'nível' || h === 'nivel'), autorizo: col(h => h === 'autorizo'),
            issue: col(h => h.startsWith('issue no linear')),
        };
        for (const { cells, line } of rows) {
            const get = key => (idx[key] < 0 ? '' : plain(cells[idx[key]]));
            byLine.set(line, { name: get('name'), dias: get('dias'), nivel: get('nivel'), autorizo: get('autorizo'), issue: get('issue') });
        }
    }
    return parseSlices(text, file).map(({ id, phase, deps, status, line }) => {
        const c = byLine.get(line);
        const nums = c.dias.match(/\d+/g);
        return {
            id, phase, name: c.name,
            dias: nums ? nums.reduce((sum, n) => sum + Number(n), 0) : null,
            nivel: c.nivel, autorizo: c.autorizo,
            alto: /^alto/i.test(c.nivel) || /^sim/i.test(c.autorizo),
            status: STATUS_VOCAB.find(term => (status || '').startsWith(term)) || status,
            deps, issue: c.issue,
        };
    });
}

/** Lê o roadmap sob `root`. @returns {{phases: Array}} */
function loadRoadmap(root) {
    const dirs = base => {
        const dir = path.join(root, base);
        if (!fs.existsSync(dir)) return [];
        return fs.readdirSync(dir, { withFileTypes: true })
            .filter(e => e.isDirectory() && /^fase-\d+-/.test(e.name)).map(e => `${base}/${e.name}/FASE.md`);
    };
    const phases = [...dirs('roadmap'), ...dirs('roadmap/arquivo')]
        .filter(file => fs.existsSync(path.join(root, file)))
        .map(file => parsePhase(fs.readFileSync(path.join(root, file), 'utf8'), file));
    return { phases: phases.sort((a, b) => a.n - b.n) };
}

module.exports = { loadRoadmap };
