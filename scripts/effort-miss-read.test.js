// node --test scripts/effort-miss-read.test.js
// Leitor por processo do registro effort_miss para o Dashboard (fronteira G3, mesmo padrão do
// routing-read.js). Só lê; sem registro = UNKNOWN, nunca zero.
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { spawnSync } = require('child_process');

const CLI = path.join(__dirname, 'effort-miss-read.js');
const run = input => spawnSync(process.execPath, [CLI, '--json'], { input: typeof input === 'string' ? input : JSON.stringify(input), encoding: 'utf8' });
const rec = (id, phase, would) => ({ id, phase, effort: 'medium', what_missed: 'x', would_high_catch: would, class: 'c', evidence_ref: 'r', recorded_by: 'review', recorded_at: '2026-11-14T22:00:00.000Z' });

test('sem registro algum: ok, UNKNOWN, total null', () => {
    const r = run({ entries: [{ taskId: 'a', effort_misses: undefined }, { taskId: 'b', effort_misses: [] }] });
    assert.strictEqual(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.strictEqual(out.ok, true);
    assert.strictEqual(out.projection.status, 'UNKNOWN');
    assert.strictEqual(out.projection.total, null);
});

test('com registros: mesma projeção da lib, contada por fase', () => {
    const out = JSON.parse(run({ entries: [{ taskId: 'a', effort_misses: [rec('em-1', 'test', 'yes'), rec('em-2', 'verify', 'unknown')] }] }).stdout);
    assert.strictEqual(out.projection.status, 'RECORDED');
    assert.strictEqual(out.projection.total, 2);
    assert.deepStrictEqual(out.projection.by_phase.test, { yes: 1, no: 0, unknown: 0 });
});

test('entrada inválida: exit 2 e erro em JSON, nunca projeção', () => {
    for (const bad of ['não é json', '[]', '{"entries":"x"}']) {
        const r = run(bad);
        assert.strictEqual(r.status, 2, bad);
        assert.strictEqual(JSON.parse(r.stdout).ok, false);
    }
});

test('não escreve nada: o script não importa writer', () => {
    const src = require('fs').readFileSync(CLI, 'utf8');
    assert.doesNotMatch(src, /state-writer|writeFileSync/);
});
