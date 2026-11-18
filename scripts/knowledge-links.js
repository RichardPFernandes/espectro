#!/usr/bin/env node
'use strict';
// Ligações entre specs vivas, ADRs e SPECs de fatia (lógica em scripts/lib/knowledge-links.js).
//
//   node scripts/knowledge-links.js --check   → confere IDs, lados, cabeçalho de ADR e seções
//   node scripts/knowledge-links.js --write   → regenera a seção "## Ligações" de cada página
//
// --check lista cada problema com o arquivo e o comando que corrige e sai 1 se houver algum.
// --write não conserta ID inexistente nem lado divergente: lista os problemas e sai 1 sem
// escrever. Os dois saem 2 em erro de uso ou de cabeçalho.
const path = require('node:path');
const { check, write, summary } = require('./lib/knowledge-links');

const ROOT = path.resolve(__dirname, '..');
const USAGE = 'uso: node scripts/knowledge-links.js --check | --write';

function main(args) {
    try {
        if (args.length === 1 && args[0] === '--check') {
            const report = check(ROOT);
            for (const { message } of report.problems) console.error(message);
            console.log(summary(report));
            return report.problems.length ? 1 : 0;
        }
        if (args.length === 1 && args[0] === '--write') {
            const { problems, changed } = write(ROOT);
            for (const { message } of problems) console.error(message);
            if (problems.length) return 1;
            console.log(changed.length ? `ligações: ${changed.length} páginas atualizadas` : 'ligações: já estavam em dia');
            return 0;
        }
    } catch (error) {
        console.error(error.message);
        return 2;
    }
    console.error(USAGE);
    return 2;
}

process.exitCode = main(process.argv.slice(2));
