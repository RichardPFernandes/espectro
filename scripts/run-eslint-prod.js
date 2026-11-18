#!/usr/bin/env node
'use strict';
// PRI-406 / F0.7: ESLint só de erros sobre o JavaScript de produção, comparado com a base scripts/lint-baseline.json (só encolhe).
//   node scripts/run-eslint-prod.js            confere (CI): sai 1 se algo cresceu ou se a base ficou folgada
//   node scripts/run-eslint-prod.js --shrink   grava na base o que encolheu (nunca aceita crescimento)

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { countViolations, compareToBaseline, formatBaseline, shrinkBaseline } = require('./lib/lint-baseline');

const repoRoot = path.resolve(__dirname, '..');
const eslint = path.join(__dirname, 'node_modules', '.bin', 'eslint');
const baselinePath = path.join(__dirname, 'lint-baseline.json');

function fail(code, message) {
    console.error(message);
    process.exit(code);
}

/** Roda o ESLint e devolve o array do `-f json`; sem saída válida, falha (nunca vira PASS). */
function runEslint() {
    const r = spawnSync(eslint, ['-c', 'eslint.prod.config.mjs', 'scripts', 'dashboard', '-f', 'json'], {
        cwd: repoRoot, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'inherit'], env: process.env,
    });
    if (r.error) fail(2, `lint:prod: não foi possível rodar o eslint: ${r.error.message}`);
    if (r.status === null || r.status > 1) fail(2, `lint:prod: o eslint falhou (status ${r.status === null ? r.signal : r.status})`);
    let results;
    try {
        results = JSON.parse(r.stdout);
    } catch (err) {
        fail(2, `lint:prod: a saída do eslint não é JSON (${err.message})`);
    }
    if (!Array.isArray(results)) fail(2, 'lint:prod: a saída do eslint não é uma lista de resultados');
    return results;
}

function readBaseline() {
    try {
        return JSON.parse(fs.readFileSync(baselinePath, 'utf8'));
    } catch (err) {
        return fail(2, `lint:prod: não foi possível ler scripts/lint-baseline.json (${err.message})`);
    }
}

const printItems = items => items.forEach(i => console.log(`${i.file} ${i.rule} ${i.base} -> ${i.now}`));

function main() {
    const current = countViolations(runEslint(), repoRoot);
    const baseline = readBaseline();
    const { added, shrunk } = compareToBaseline(current, baseline);

    if (process.argv.includes('--shrink')) {
        let next;
        try {
            next = shrinkBaseline(current, baseline);
        } catch (err) {
            fail(1, `lint:prod: ${err.message}`);
        }
        fs.writeFileSync(baselinePath, formatBaseline(next));
        printItems(shrunk);
        console.log(shrunk.length
            ? `lint:prod: base encolhida em ${shrunk.length} item(ns); commite scripts/lint-baseline.json`
            : 'lint:prod: a base já estava justa; nada a encolher');
        return;
    }

    if (added.length) {
        printItems(added);
        fail(1, 'lint:prod: violação nova acima da base; corrija o código (a base só encolhe)');
    }
    if (shrunk.length) {
        printItems(shrunk);
        fail(1, 'lint:prod: a base encolheu; rode: npm --prefix scripts run lint:prod:shrink e commite scripts/lint-baseline.json');
    }
    const total = Object.values(current).flatMap(Object.values).reduce((a, b) => a + b, 0);
    console.log(`lint:prod ok (${total} violações aceitas)`);
}

main();
