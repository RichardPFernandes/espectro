#!/usr/bin/env node
// Exporta memory/runs/ (ativos + _archive/) como relatório JSON agregado — permite
// analisar performance/audit trail do ciclo Graph Engineering sem iteração manual.
// Lib pura em scripts/lib/runs-exporter.js; este arquivo só é a CLI.
//
//   node scripts/export-runs.js [--output report.json] [--since YYYY-MM-DD]
//                                [--incremental] [--pretty]
//
//   --output       caminho do arquivo de saída (default: stdout)
//   --since        só runs com started_at >= esta data
//   --incremental  só runs modificados desde o último export (cursor em
//                   memory/.runs-export-cursor.json, gravado ao final)
//   --pretty       JSON indentado (4 espaços) em vez de compacto
//
// Saída: 0 ok · 1 falha (exceção, --since inválido) · 2 uso incorreto.
const fs = require('fs');
const path = require('path');
const { exportRuns } = require('./lib/runs-exporter');

function parseArgs(argv) {
    const out = { pretty: false, incremental: false };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        const [flag, inline] = a.startsWith('--') && a.includes('=') ? [a.slice(0, a.indexOf('=')), a.slice(a.indexOf('=') + 1)] : [a, null];
        const value = () => inline ?? argv[++i];
        if (flag === '--output') out.output = value();
        else if (flag === '--since') out.since = value();
        else if (flag === '--incremental') out.incremental = true;
        else if (flag === '--pretty') out.pretty = true;
        else if (flag === '--help' || flag === '-h') out.help = true;
        else throw new Error(`argumento desconhecido: ${a}`);
    }
    return out;
}

const USAGE = 'uso: node scripts/export-runs.js [--output report.json] [--since YYYY-MM-DD] [--incremental] [--pretty]';

async function main(argv) {
    let args;
    try {
        args = parseArgs(argv);
    } catch (e) {
        console.error(e.message);
        console.error(USAGE);
        return 2;
    }
    if (args.help) {
        console.log(USAGE);
        return 0;
    }

    const { report, warnings } = await exportRuns({ since: args.since, incremental: args.incremental });
    const json = JSON.stringify(report, null, args.pretty ? 4 : 0);

    if (args.output) {
        fs.mkdirSync(path.dirname(path.resolve(args.output)), { recursive: true });
        fs.writeFileSync(args.output, json);
    } else {
        console.log(json);
    }

    for (const w of warnings) console.error(`[export-runs] aviso: ${w}`);
    return 0;
}

if (require.main === module) {
    main(process.argv.slice(2))
        .then(code => process.exit(code))
        .catch(e => {
            console.error(`[export-runs] erro: ${e.message}`);
            process.exit(1);
        });
}

module.exports = { parseArgs, main };
