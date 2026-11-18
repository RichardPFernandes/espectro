'use strict';
// Teto de linhas dos três arquivos grandes (PRI-406, F0.7, AC-02): o arquivo não cresce além do teto.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.resolve(__dirname, '..');

// Teto igual às linhas de hoje. Só desce; subir é decisão do Richard (arquivo grande novo vira módulo).
const CEILINGS = {
    'scripts/readmine-watcher.js': 6212,
    'dashboard/server.js': 3902,
    'dashboard/public/index.html': 3497,
};

// Folga máxima entre o teto e as linhas atuais; acima disso o teto precisa descer.
const MAX_SLACK = 50;

// Conta linhas como o `wc -l`: o número de quebras de linha (\n) do texto.
const countLines = text => text.split('\n').length - 1;
const linesOf = file => countLines(fs.readFileSync(path.join(REPO, file), 'utf8'));

describe('countLines', () => {
    for (const [text, expected] of [['', 0], ['a\nb', 1], ['a\nb\n', 2], ['\n', 1]]) {
        it(`${JSON.stringify(text)} tem ${expected} linha(s), como o wc -l`, () => assert.equal(countLines(text), expected));
    }
});

describe('teto de linhas dos arquivos grandes', () => {
    for (const [file, ceiling] of Object.entries(CEILINGS)) {
        it(`${file} tem no máximo ${ceiling} linhas`, () => {
            const lines = linesOf(file);
            assert.ok(lines <= ceiling, `${file} tem ${lines} linhas e o teto é ${ceiling}: extraia para um módulo em vez de crescer o arquivo ou, com decisão do Richard, suba o teto aqui.`);
        });

        it(`${file} não tem teto folgado demais`, () => {
            const lines = linesOf(file);
            assert.ok(ceiling - lines <= MAX_SLACK, `${file} tem ${lines} linhas e o teto é ${ceiling} (folga acima de ${MAX_SLACK}): baixe o teto para ${lines}.`);
        });
    }
});
