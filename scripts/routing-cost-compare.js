#!/usr/bin/env node
// Comparador de custo das Runs do piloto, decomposta × monomodelo (PRI-341, T3). Só lê.
//
//   node scripts/routing-cost-compare.js [--json] <run_dir> [<run_dir> ...]
//
// Lê <run_dir>/state.json de cada Run (o state-writer é o único que escreve nele; aqui não se
// escreve nada). Saída: tabela markdown para colar no PR (Evidência), ou JSON com --json.
// Código de saída: 0 ok · 1 falha de leitura · 2 uso incorreto.

const fs = require('fs');
const path = require('path');
const { compareRuns, formatMarkdown } = require('./lib/routing-cost-compare');

function main(argv) {
    const json = argv.includes('--json');
    const dirs = argv.filter(a => a !== '--json');
    if (dirs.length === 0 || dirs.some(a => a.startsWith('--'))) {
        process.stderr.write('uso: node scripts/routing-cost-compare.js [--json] <run_dir> [<run_dir> ...]\n');
        return 2;
    }
    // A mesma Run, ou duas com o mesmo basename (run_id), contaria em dobro: recusa antes de ler.
    const resolved = dirs.map(d => path.resolve(d));
    const ids = resolved.map(d => path.basename(d));
    if (new Set(resolved).size !== resolved.length || new Set(ids).size !== ids.length) {
        process.stderr.write('Run repetida (mesmo caminho ou mesmo nome de diretório): cada run_dir só pode aparecer uma vez\n');
        return 2;
    }
    const runs = [];
    for (const dir of dirs) {
        const file = path.join(path.resolve(dir), 'state.json');
        try {
            runs.push({ run_id: path.basename(path.resolve(dir)), state: JSON.parse(fs.readFileSync(file, 'utf8')) });
        } catch (e) {
            process.stderr.write(`falha ao ler ${file}: ${e.code || e.name}\n`);
            return 1;
        }
    }
    const result = compareRuns(runs);
    process.stdout.write(json ? `${JSON.stringify(result, null, 2)}\n` : `${formatMarkdown(result)}\n`);
    return 0;
}

process.exitCode = main(process.argv.slice(2));
