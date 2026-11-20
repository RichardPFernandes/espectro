#!/usr/bin/env node
// Leitor do registro effort_miss para o Dashboard (PRI-353, AC6). A regra G3
// (no-dashboard-scripts-internals) não deixa o dashboard importar scripts/lib; este script expõe,
// por processo (mesmo padrão do routing-read.js), a MESMA projeção da lib. Só lê: não importa o
// writer e não grava nada.
//
//   echo '{"entries":[{"taskId":"<id>","effort_misses":[...]|null}]}' | node scripts/effort-miss-read.js --json
//
// Saída (stdout): { ok: true, projection } | { ok: false, error }.
// Código de saída: 0 ok · 2 entrada inválida. Sem registro algum a projeção é UNKNOWN, nunca zero.

'use strict';

const { projectEffortMisses } = require('./lib/effort-miss');

function readStdin() {
    return new Promise((resolve, reject) => {
        const chunks = [];
        process.stdin.on('data', c => chunks.push(c));
        process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        process.stdin.on('error', reject);
    });
}

function parseInput(text) {
    let input;
    try { input = JSON.parse(text); } catch { throw new Error('stdin não é JSON'); }
    if (!input || typeof input !== 'object' || !Array.isArray(input.entries)) throw new Error('stdin deve ser { entries: [...] }');
    return input.entries.map(e => ({ taskId: String(e?.taskId ?? ''), state: { effort_misses: e?.effort_misses } }));
}

async function main() {
    try {
        const entries = parseInput(await readStdin());
        process.stdout.write(`${JSON.stringify({ ok: true, projection: projectEffortMisses(entries) })}\n`);
        return 0;
    } catch (e) {
        process.stdout.write(`${JSON.stringify({ ok: false, error: e.message })}\n`);
        return 2;
    }
}

if (require.main === module) main().then(code => { process.exitCode = code; });

module.exports = { parseInput };
