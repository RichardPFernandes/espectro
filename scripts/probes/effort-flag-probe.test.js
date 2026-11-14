// node --test scripts/probes/effort-flag-probe.test.js
// Só as partes puras do probe do U1 da PRI-353 (nenhuma chamada ao provider).
const test = require('node:test');
const assert = require('node:assert');

const { probeArgv, median, verdict, parseArgs, runProbe, LEVELS } = require('./effort-flag-probe');

test('argv leva só --effort e o trecho fixo; sem --model nem bloqueio de subagente', () => {
    const argv = probeArgv({ prompt: 'p', level: 'high', sessionId: 's' });
    assert.deepStrictEqual(argv.slice(argv.indexOf('--effort')), ['--effort', 'high']);
    assert.ok(!argv.includes('--model'));
    assert.ok(!argv.includes('--disallowedTools'));
    assert.ok(!argv.includes('--settings'));
});

test('níveis do probe são low, medium e high', () => {
    assert.deepStrictEqual(LEVELS, ['low', 'medium', 'high']);
});

test('median de lista par e ímpar; vazia = null (UNKNOWN, nunca zero)', () => {
    assert.strictEqual(median([3, 1, 2]), 2);
    assert.strictEqual(median([4, 1, 3, 2]), 2.5);
    assert.strictEqual(median([]), null);
});

const runs = (low, medium, high, exit = 0) => ({
    low: low.map(o => ({ exit_code: exit, output_tokens: o })),
    medium: medium.map(o => ({ exit_code: exit, output_tokens: o })),
    high: high.map(o => ({ exit_code: exit, output_tokens: o })),
});

test('nível válido recusado = UNAVAILABLE', () => {
    const r = runs([10], [10], [10]);
    r.high[0].exit_code = 1;
    assert.strictEqual(verdict({ control: { exit_code: 1 }, byLevel: r }).status, 'UNAVAILABLE');
});

test('controle inválido aceito (exit 0) = ACCEPTED_EFFECT_UNKNOWN: a flag pode estar sendo ignorada', () => {
    const v = verdict({ control: { exit_code: 0 }, byLevel: runs([10, 10, 10], [20, 20, 20], [30, 30, 30]) });
    assert.strictEqual(v.status, 'ACCEPTED_EFFECT_UNKNOWN');
});

test('controle recusado e mediana de saída crescente = EFFECT_OBSERVED (indício, não prova)', () => {
    const v = verdict({ control: { exit_code: 1 }, byLevel: runs([10, 12, 11], [20, 22, 21], [90, 80, 85]) });
    assert.strictEqual(v.status, 'EFFECT_OBSERVED');
    assert.deepStrictEqual(v.medians, { low: 11, medium: 21, high: 85 });
});

test('controle recusado e sem diferença entre low e high = ACCEPTED_EFFECT_UNKNOWN', () => {
    const v = verdict({ control: { exit_code: 1 }, byLevel: runs([50, 52, 51], [49, 50, 51], [51, 50, 49]) });
    assert.strictEqual(v.status, 'ACCEPTED_EFFECT_UNKNOWN');
});

test('sem medição de tokens (null) nunca vira EFFECT_OBSERVED', () => {
    const r = runs([1], [1], [1]);
    for (const l of LEVELS) r[l][0].output_tokens = null;
    assert.strictEqual(verdict({ control: { exit_code: 1 }, byLevel: r }).status, 'ACCEPTED_EFFECT_UNKNOWN');
});

test('parseArgs: --n padrão 3, --out obrigatório, argumento desconhecido falha', () => {
    assert.strictEqual(parseArgs(['--out', 'd']).n, 3);
    assert.throws(() => parseArgs([]), /--out/);
    assert.throws(() => parseArgs(['--out', 'd', '--x', '1']), /desconhecido/);
    assert.throws(() => parseArgs(['--out', 'd', '--n', '0']), /--n/);
});

test('runProbe com runner fake: 1 controle + n por nível, e respeita o teto de chamadas', () => {
    const seen = [];
    const run = ({ level }) => { seen.push(level); return { exit_code: level === 'bogus' ? 1 : 0, output_tokens: level === 'high' ? 90 : 10 }; };
    const report = runProbe({ n: 2, run, claudeVersion: '2.1.325' });
    assert.strictEqual(seen.filter(l => l === 'bogus').length, 1);
    for (const l of LEVELS) assert.strictEqual(seen.filter(x => x === l).length, 2);
    assert.strictEqual(report.claude_version, '2.1.325');
    assert.strictEqual(report.verdict.status, 'EFFECT_OBSERVED');
    assert.throws(() => runProbe({ n: 50, run, claudeVersion: 'x' }), /teto/);
});
