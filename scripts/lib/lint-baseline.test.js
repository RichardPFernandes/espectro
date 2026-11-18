'use strict';
// Base de violações aceitas do lint: contagem, comparação, formato e encolhimento.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { countViolations, compareToBaseline, formatBaseline, shrinkBaseline } = require('./lint-baseline');

const ROOT = '/repo';
const result = (file, rules) => ({
    filePath: `${ROOT}/${file}`,
    messages: rules.map(ruleId => ({ ruleId, severity: 2, message: 'x' })),
});
const E = 'no-empty';
const item = (file, rule, base, now) => ({ file, rule, base, now });

describe('countViolations', () => {
    it('agrega por arquivo e regra, relativiza o caminho e ordena', () => {
        const counts = countViolations([
            result('scripts/z.js', [E]),
            result('scripts/a.js', ['no-unused-vars', E, E]),
            result('scripts/lib/b.js', []),
        ], ROOT);
        assert.deepEqual(counts, {
            'scripts/a.js': { [E]: 2, 'no-unused-vars': 1 },
            'scripts/z.js': { [E]: 1 },
        });
        assert.deepEqual(Object.keys(counts), ['scripts/a.js', 'scripts/z.js']);
        assert.deepEqual(Object.keys(counts['scripts/a.js']), [E, 'no-unused-vars']);
    });

    it('conta mensagem sem ruleId como parse-error', () => {
        assert.deepEqual(countViolations([result('scripts/a.js', [null])], ROOT), { 'scripts/a.js': { 'parse-error': 1 } });
    });
});

describe('compareToBaseline', () => {
    const same = { 'a.js': { [E]: 2 } };
    const cases = [
        ['added: contagem maior que a base', { 'a.js': { [E]: 3 } }, same, [item('a.js', E, 2, 3)], []],
        ['added: arquivo novo, base 0', { 'n.js': { [E]: 1 } }, {}, [item('n.js', E, 0, 1)], []],
        ['added: regra nova em arquivo existente', { 'a.js': { [E]: 1, 'no-undef': 1 } }, { 'a.js': { [E]: 1 } }, [item('a.js', 'no-undef', 0, 1)], []],
        ['shrunk: contagem menor que a base', { 'a.js': { [E]: 1 } }, same, [], [item('a.js', E, 2, 1)]],
        ['shrunk: o que sumiu, now 0', {}, same, [], [item('a.js', E, 2, 0)]],
        ['igual: nada', same, same, [], []],
    ];
    for (const [name, current, baseline, added, shrunk] of cases) {
        it(name, () => assert.deepEqual(compareToBaseline(current, baseline), { added, shrunk }));
    }
});

describe('formatBaseline', () => {
    it('escreve uma linha por arquivo, com chaves ordenadas', () => {
        const out = formatBaseline({ 'scripts/b.js': { [E]: 1 }, 'scripts/a.js': { 'no-unused-vars': 1, [E]: 2 } });
        assert.equal(out, '{\n  "scripts/a.js": {"no-empty": 2, "no-unused-vars": 1},\n  "scripts/b.js": {"no-empty": 1}\n}\n');
    });

    it('escreve objeto vazio como {}', () => assert.equal(formatBaseline({}), '{}\n'));
});

describe('shrinkBaseline', () => {
    it('usa a contagem atual no que encolheu e remove o que zerou', () => {
        const baseline = { 'a.js': { [E]: 3, 'no-unused-vars': 1 }, 'b.js': { [E]: 2 }, 'c.js': { [E]: 1 } };
        const current = { 'a.js': { [E]: 1, 'no-unused-vars': 1 }, 'c.js': { [E]: 1 } };
        assert.deepEqual(shrinkBaseline(current, baseline), { 'a.js': { [E]: 1, 'no-unused-vars': 1 }, 'c.js': { [E]: 1 } });
    });

    it('lança Error quando há crescimento', () => {
        assert.throws(() => shrinkBaseline({ 'a.js': { [E]: 2 } }, { 'a.js': { [E]: 1 } }), Error);
    });
});
