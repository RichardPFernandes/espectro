'use strict';
// Teto de linhas dos três arquivos grandes (PRI-406, F0.7, AC-02): o arquivo não cresce além do teto.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.resolve(__dirname, '..');

// Teto de linhas de cada arquivo grande, igual às linhas de hoje.
// O teto só desce: reduzir o arquivo permite baixar o teto neste arquivo.
// Subir o teto é decisão do Richard: arquivo grande novo vira módulo, não cresce o existente.
const CEILINGS = {
    'scripts/readmine-watcher.js': 6212,
    'dashboard/server.js': 3902,
    'dashboard/public/index.html': 3497,
};

// Folga máxima aceita entre o teto e as linhas atuais; acima disso o teto precisa descer.
const MAX_SLACK = 50;

// Conta linhas como o `wc -l`: o número de quebras de linha (\n) do texto.
function countLines(text) {
    return text.split('\n').length - 1;
}

function linesOf(relativePath) {
    return countLines(fs.readFileSync(path.join(REPO, relativePath), 'utf8'));
}

describe('countLines', () => {
    it('texto vazio tem 0 linhas', () => {
        assert.equal(countLines(''), 0);
    });

    it('texto sem \\n final não conta a última linha, como o wc -l', () => {
        assert.equal(countLines('a\nb'), 1);
    });

    it('texto com \\n final conta todas as linhas', () => {
        assert.equal(countLines('a\nb\n'), 2);
    });

    it('só \\n tem 1 linha', () => {
        assert.equal(countLines('\n'), 1);
    });
});

describe('teto de linhas dos arquivos grandes', () => {
    for (const [file, ceiling] of Object.entries(CEILINGS)) {
        it(`${file} tem no máximo ${ceiling} linhas`, () => {
            const lines = linesOf(file);
            assert.ok(
                lines <= ceiling,
                `${file} tem ${lines} linhas e o teto é ${ceiling}: extraia para um módulo em vez de crescer o arquivo ou, com decisão do Richard, suba o teto aqui.`
            );
        });

        it(`${file} não tem teto folgado demais`, () => {
            const lines = linesOf(file);
            assert.ok(
                ceiling - lines <= MAX_SLACK,
                `${file} tem ${lines} linhas e o teto é ${ceiling} (folga acima de ${MAX_SLACK}): baixe o teto para ${lines}.`
            );
        });
    }
});
