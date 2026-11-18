#!/usr/bin/env node
// Leitor do registro de flags para o Dashboard (PRI-399, F0.9 AC-03, métrica 4). A regra G3
// (no-dashboard-scripts-internals) não deixa o dashboard importar scripts/lib; este script expõe,
// por processo (mesmo padrão do effort-miss-read.js), o resumo calculado pela lib. Só lê
// docs/flags.md, com o caminho resolvido a partir deste arquivo; não grava nada.
//
//   node scripts/flags-read.js --json
//
// Saída (stdout): { ok: true, summary } | { ok: false, error }.
// Código de saída: 0 ok · 2 registro ausente ou ilegível. Falha nunca vira contagem zero.

'use strict';

const fs = require('fs');
const path = require('path');
const { REGISTRY_REL, summarizeFlagRegistry, todayUtc } = require('./lib/flag-registry');

const REGISTRY_PATH = path.join(__dirname, '..', REGISTRY_REL);

function main() {
    let result;
    try {
        result = summarizeFlagRegistry(fs.readFileSync(REGISTRY_PATH, 'utf8'), todayUtc());
    } catch (e) {
        result = { ok: false, error: `${REGISTRY_REL} não pôde ser lido: ${e.code || e.message}` };
    }
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return result.ok ? 0 : 2;
}

if (require.main === module) process.exitCode = main();
