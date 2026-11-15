// node --test scripts/effort-miss.test.js
// PRI-353 T3 (AC6): gravação do registro effort_miss pelo state-writer e a CLI `record`.
// A parte pura (validação, leitura, projeção) está em scripts/lib/effort-miss.test.js.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const stateWriter = require('./state-writer');
const { validateState } = require('./validate-state');
const { recordEffortMiss } = require('./effort-miss');

const TABLE = { plan: 'high', implement: 'high', review: 'high', test: 'medium', verify: 'medium', commit: 'low' };
const NOW = '2026-11-14T22:00:00.000Z';
const input = (over = {}) => ({
    phase: 'test', what_missed: 'teste não cobria o AC-03', class: 'cobertura-de-ac',
    evidence_ref: 'review_results[0]', recorded_by: 'review', ...over,
});

function tmpRun(extra = {}) {
    const dir = fs.mkdtempSync(path.join(process.env.CLAUDE_JOB_DIR ? path.join(process.env.CLAUDE_JOB_DIR, 'tmp') : os.tmpdir(), 'effort-miss-'));
    stateWriter.init(dir, { task_id: 'em-1', node: 'verify', history: ['fetch_ticket', 'plan'], status: 'in_progress', ...extra });
    return dir;
}

test('recordEffortMiss grava em state.json pelo writer, sem mexer em state_version nem em campo crítico', () => {
    const dir = tmpRun();
    const before = stateWriter.read(dir);
    const out = recordEffortMiss(dir, input(), { table: TABLE, now: NOW });
    assert.strictEqual(out.id, 'em-1');
    const after = stateWriter.read(dir);
    assert.strictEqual(after.state_version, before.state_version);
    assert.strictEqual(after.node, before.node);
    assert.deepStrictEqual(after.effort_misses.map(r => r.id), ['em-1']);
    recordEffortMiss(dir, input({ phase: 'verify', would_high_catch: 'yes' }), { table: TABLE, now: NOW });
    assert.deepStrictEqual(stateWriter.read(dir).effort_misses.map(r => r.id), ['em-1', 'em-2']);
    assert.strictEqual(validateState(stateWriter.read(dir)).valid, true);
});

test('recordEffortMiss em run inexistente falha alto, sem criar state.json', () => {
    const dir = path.join(os.tmpdir(), 'effort-miss-nao-existe-' + process.pid);
    assert.throws(() => recordEffortMiss(dir, input(), { table: TABLE, now: NOW }), /EFFORT_MISS_RUN_NOT_FOUND/);
    assert.strictEqual(fs.existsSync(dir), false);
});

test('registro inválido não grava nada', () => {
    const dir = tmpRun();
    assert.throws(() => recordEffortMiss(dir, input({ phase: 'plan' }), { table: TABLE, now: NOW }), /EFFORT_MISS_PHASE_NOT_MEDIUM/);
    assert.strictEqual('effort_misses' in stateWriter.read(dir), false);
});

test('CLI record grava pelo writer e imprime o registro; uso incorreto sai 1', () => {
    const dir = tmpRun();
    const cli = path.join(__dirname, 'effort-miss.js');
    const ok = spawnSync(process.execPath, [cli, 'record', dir, '--phase=test', '--class=cobertura-de-ac', '--what=x', '--evidence=r', '--by=review'], { encoding: 'utf8' });
    assert.strictEqual(ok.status, 0, ok.stderr);
    assert.strictEqual(JSON.parse(ok.stdout).would_high_catch, 'unknown');
    assert.deepStrictEqual(stateWriter.read(dir).effort_misses.map(r => r.id), ['em-1']);
    const bad = spawnSync(process.execPath, [cli], { encoding: 'utf8' });
    assert.strictEqual(bad.status, 1);
    assert.match(bad.stderr, /uso:/);
});
