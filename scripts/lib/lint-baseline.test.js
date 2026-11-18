'use strict';
// Base de violações aceitas do lint: contagem, comparação, formato e encolhimento.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { countViolations, compareToBaseline, formatBaseline, shrinkBaseline } = require('./lint-baseline');

const ROOT = '/repo';

function result(file, rules) {
    return {
        filePath: `${ROOT}/${file}`,
        messages: rules.map(ruleId => ({ ruleId, severity: 2, message: 'x' })),
    };
}

describe('countViolations', () => {
    it('agrega por arquivo e regra e relativiza o caminho', () => {
        const counts = countViolations([
            result('scripts/a.js', ['no-empty', 'no-empty', 'no-unused-vars']),
            result('scripts/lib/b.js', ['no-empty']),
        ], ROOT);
        assert.deepEqual(counts, {
            'scripts/a.js': { 'no-empty': 2, 'no-unused-vars': 1 },
            'scripts/lib/b.js': { 'no-empty': 1 },
        });
    });

    it('omite arquivos sem violação', () => {
        assert.deepEqual(countViolations([result('scripts/a.js', [])], ROOT), {});
    });

    it('conta mensagem sem ruleId como parse-error', () => {
        const counts = countViolations([result('scripts/a.js', [null])], ROOT);
        assert.deepEqual(counts, { 'scripts/a.js': { 'parse-error': 1 } });
    });

    it('ordena arquivos e regras alfabeticamente', () => {
        const counts = countViolations([
            result('scripts/z.js', ['no-empty']),
            result('scripts/a.js', ['no-unused-vars', 'no-empty']),
        ], ROOT);
        assert.deepEqual(Object.keys(counts), ['scripts/a.js', 'scripts/z.js']);
        assert.deepEqual(Object.keys(counts['scripts/a.js']), ['no-empty', 'no-unused-vars']);
    });
});

describe('compareToBaseline', () => {
    it('marca como added a contagem maior que a base', () => {
        const diff = compareToBaseline({ 'a.js': { 'no-empty': 3 } }, { 'a.js': { 'no-empty': 2 } });
        assert.deepEqual(diff, { added: [{ file: 'a.js', rule: 'no-empty', base: 2, now: 3 }], shrunk: [] });
    });

    it('marca como added o arquivo novo, com base 0', () => {
        const diff = compareToBaseline({ 'novo.js': { 'no-empty': 1 } }, {});
        assert.deepEqual(diff.added, [{ file: 'novo.js', rule: 'no-empty', base: 0, now: 1 }]);
    });

    it('marca como added a regra nova num arquivo existente', () => {
        const diff = compareToBaseline(
            { 'a.js': { 'no-empty': 1, 'no-undef': 1 } },
            { 'a.js': { 'no-empty': 1 } },
        );
        assert.deepEqual(diff.added, [{ file: 'a.js', rule: 'no-undef', base: 0, now: 1 }]);
        assert.deepEqual(diff.shrunk, []);
    });

    it('marca como shrunk a contagem menor que a base', () => {
        const diff = compareToBaseline({ 'a.js': { 'no-empty': 1 } }, { 'a.js': { 'no-empty': 2 } });
        assert.deepEqual(diff, { added: [], shrunk: [{ file: 'a.js', rule: 'no-empty', base: 2, now: 1 }] });
    });

    it('marca como shrunk o que sumiu, com now 0', () => {
        const diff = compareToBaseline({}, { 'a.js': { 'no-empty': 2 } });
        assert.deepEqual(diff.shrunk, [{ file: 'a.js', rule: 'no-empty', base: 2, now: 0 }]);
    });

    it('não gera nada quando é igual', () => {
        const same = { 'a.js': { 'no-empty': 2 } };
        assert.deepEqual(compareToBaseline(same, same), { added: [], shrunk: [] });
    });
});

describe('formatBaseline', () => {
    it('escreve uma linha por arquivo, com chaves ordenadas', () => {
        const out = formatBaseline({
            'scripts/b.js': { 'no-empty': 1 },
            'scripts/a.js': { 'no-unused-vars': 1, 'no-empty': 2 },
        });
        assert.equal(
            out,
            '{\n  "scripts/a.js": {"no-empty": 2, "no-unused-vars": 1},\n  "scripts/b.js": {"no-empty": 1}\n}\n',
        );
    });

    it('escreve objeto vazio como {}', () => {
        assert.equal(formatBaseline({}), '{}\n');
    });
});

describe('shrinkBaseline', () => {
    it('usa a contagem atual no que encolheu e remove o que zerou', () => {
        const baseline = {
            'a.js': { 'no-empty': 3, 'no-unused-vars': 1 },
            'b.js': { 'no-empty': 2 },
            'c.js': { 'no-empty': 1 },
        };
        const current = { 'a.js': { 'no-empty': 1, 'no-unused-vars': 1 }, 'c.js': { 'no-empty': 1 } };
        assert.deepEqual(shrinkBaseline(current, baseline), {
            'a.js': { 'no-empty': 1, 'no-unused-vars': 1 },
            'c.js': { 'no-empty': 1 },
        });
    });

    it('lança Error quando há crescimento', () => {
        assert.throws(
            () => shrinkBaseline({ 'a.js': { 'no-empty': 2 } }, { 'a.js': { 'no-empty': 1 } }),
            Error,
        );
    });
});
