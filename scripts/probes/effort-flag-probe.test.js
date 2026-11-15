// node --test scripts/probes/effort-flag-probe.test.js
// Só as partes puras do probe do U1 da PRI-353 (nenhuma chamada ao provider).
const test = require('node:test');
const assert = require('node:assert');

const { probeArgv, median, verdict, parseArgs, runProbe, countThinkingBlocks, DEFAULT_LEVELS, VALID_LEVELS } = require('./effort-flag-probe');

test('argv leva só --effort e o trecho fixo; sem --model nem bloqueio de subagente', () => {
    const argv = probeArgv({ prompt: 'p', level: 'high', sessionId: 's' });
    assert.deepStrictEqual(argv.slice(argv.indexOf('--effort')), ['--effort', 'high']);
    assert.ok(!argv.includes('--model'));
    assert.ok(!argv.includes('--disallowedTools'));
    assert.ok(!argv.includes('--settings'));
});

test('padrão compara low contra max; níveis válidos são os da CLI', () => {
    assert.deepStrictEqual(DEFAULT_LEVELS, ['low', 'max']);
    assert.deepStrictEqual(VALID_LEVELS, ['low', 'medium', 'high', 'xhigh', 'max']);
});

test('median de lista par e ímpar; vazia = null (UNKNOWN, nunca zero)', () => {
    assert.strictEqual(median([3, 1, 2]), 2);
    assert.strictEqual(median([4, 1, 3, 2]), 2.5);
    assert.strictEqual(median([]), null);
    assert.strictEqual(median([null, undefined]), null);
});

test('countThinkingBlocks conta só blocos thinking de mensagens do assistente; sem transcript = null', () => {
    const line = o => JSON.stringify(o);
    const content = [
        line({ type: 'assistant', message: { content: [{ type: 'thinking', thinking: '' }, { type: 'text', text: 'a' }] } }),
        line({ type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'x' }] } }),
        line({ type: 'user', message: { content: [{ type: 'thinking' }] } }),
        'não é json',
    ].join('\n');
    assert.strictEqual(countThinkingBlocks(content), 2);
    assert.strictEqual(countThinkingBlocks(''), 0);
    assert.strictEqual(countThinkingBlocks(null), null);
});

const run = (out, thinking = null, exit = 0) => ({ exit_code: exit, output_tokens: out, thinking_blocks: thinking });
const by = (low, max) => ({ low: low.map(o => run(...[].concat(o))), max: max.map(o => run(...[].concat(o))) });
const levels = ['low', 'max'];

test('nível válido recusado = UNAVAILABLE', () => {
    const b = by([10], [10]);
    b.max[0].exit_code = 1;
    assert.strictEqual(verdict({ control: { exit_code: 1 }, byLevel: b, levels }).status, 'UNAVAILABLE');
});

test('saída de max >= 1,5x a de low = EFFECT_OBSERVED (indício, não prova)', () => {
    const v = verdict({ control: { exit_code: 1 }, byLevel: by([100, 110, 105], [400, 380, 420]), levels });
    assert.strictEqual(v.status, 'EFFECT_OBSERVED');
    assert.deepStrictEqual(v.medians.output_tokens, { low: 105, max: 400 });
});

test('mais blocos thinking em max que em low = EFFECT_OBSERVED mesmo com saída parecida', () => {
    const v = verdict({ control: { exit_code: 1 }, byLevel: by([[100, 0], [100, 0], [100, 0]], [[110, 2], [105, 3], [100, 2]]), levels });
    assert.strictEqual(v.status, 'EFFECT_OBSERVED');
});

test('controle inválido aceito não anula o efeito, mas vira nota no veredito', () => {
    const v = verdict({ control: { exit_code: 0 }, byLevel: by([100, 100, 100], [500, 500, 500]), levels });
    assert.strictEqual(v.status, 'EFFECT_OBSERVED');
    assert.match(v.notes.join(' '), /não valida/);
});

test('sem diferença mensurável = ACCEPTED_EFFECT_UNKNOWN', () => {
    const v = verdict({ control: { exit_code: 1 }, byLevel: by([[260, 0], [265, 0], [302, 0]], [[290, 0], [300, 0], [383, 0]]), levels });
    assert.strictEqual(v.status, 'ACCEPTED_EFFECT_UNKNOWN');
});

test('sem medição (null) nunca vira EFFECT_OBSERVED', () => {
    const v = verdict({ control: { exit_code: 1 }, byLevel: by([[null, null]], [[null, null]]), levels });
    assert.strictEqual(v.status, 'ACCEPTED_EFFECT_UNKNOWN');
    assert.strictEqual(v.medians.output_tokens.low, null);
});

test('parseArgs: --n padrão 3, --levels padrão low,max, --out obrigatório, inválidos falham', () => {
    const o = parseArgs(['--out', 'd']);
    assert.strictEqual(o.n, 3);
    assert.deepStrictEqual(o.levels, ['low', 'max']);
    assert.deepStrictEqual(parseArgs(['--out', 'd', '--levels', 'low,high,max']).levels, ['low', 'high', 'max']);
    assert.throws(() => parseArgs([]), /--out/);
    assert.throws(() => parseArgs(['--out', 'd', '--x', '1']), /desconhecido/);
    assert.throws(() => parseArgs(['--out', 'd', '--n', '0']), /--n/);
    assert.throws(() => parseArgs(['--out', 'd', '--levels', 'low,turbo']), /nível/);
    assert.throws(() => parseArgs(['--out', 'd', '--levels', 'low']), /ao menos dois/);
});

test('runProbe com runner fake: 1 controle + n por nível, e respeita o teto de chamadas', () => {
    const seen = [];
    const fake = ({ level }) => { seen.push(level); return run(level === 'max' ? 400 : 100, level === 'max' ? 2 : 0, level === 'bogus' ? 1 : 0); };
    const report = runProbe({ n: 2, levels, run: fake, claudeVersion: '2.1.325' });
    assert.strictEqual(seen.filter(l => l === 'bogus').length, 1);
    for (const l of levels) assert.strictEqual(seen.filter(x => x === l).length, 2);
    assert.strictEqual(report.calls, 5);
    assert.strictEqual(report.claude_version, '2.1.325');
    assert.strictEqual(report.verdict.status, 'EFFECT_OBSERVED');
    assert.throws(() => runProbe({ n: 50, levels, run: fake, claudeVersion: 'x' }), /teto/);
});
