// node --test scripts/lib/effort-miss.test.js
// PRI-353 T3 (AC6): registro effort_miss. Só fases em esforço médio; would_high_catch nasce
// `unknown`; ausência de registro é UNKNOWN, nunca zero.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const stateWriter = require('../state-writer');
const { validateState } = require('../validate-state');
const {
    buildRecord, validateRecord, recordEffortMiss, readEffortMisses, projectEffortMisses, WOULD_HIGH_CATCH,
} = require('./effort-miss');

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

test('would_high_catch nasce unknown; só yes|no|unknown são aceitos', () => {
    assert.deepStrictEqual(WOULD_HIGH_CATCH, ['yes', 'no', 'unknown']);
    const r = buildRecord(input(), { table: TABLE, now: NOW, existing: [] });
    assert.strictEqual(r.would_high_catch, 'unknown');
    assert.strictEqual(r.effort, 'medium');
    assert.strictEqual(r.recorded_at, NOW);
    assert.strictEqual(r.id, 'em-1');
    assert.strictEqual(buildRecord(input({ would_high_catch: 'yes' }), { table: TABLE, now: NOW, existing: [{}, {}] }).id, 'em-3');
});

test('só fase em esforço médio na tabela entra no registro', () => {
    for (const phase of ['plan', 'implement', 'review', 'commit', 'fetch_ticket', 'inexistente']) {
        assert.throws(() => buildRecord(input({ phase }), { table: TABLE, now: NOW, existing: [] }), /EFFORT_MISS_PHASE_NOT_MEDIUM/, phase);
    }
    for (const phase of ['test', 'verify']) assert.doesNotThrow(() => buildRecord(input({ phase }), { table: TABLE, now: NOW, existing: [] }));
});

test('campos inválidos são recusados com a causa', () => {
    const bad = [
        [{ what_missed: '' }, /what_missed/], [{ class: 'Classe Inválida' }, /class/], [{ evidence_ref: '  ' }, /evidence_ref/],
        [{ recorded_by: 'robo' }, /recorded_by/], [{ would_high_catch: 'talvez' }, /would_high_catch/],
    ];
    for (const [over, re] of bad) {
        const errors = validateRecord({ ...buildRecordLoose(input(over)) }, { table: TABLE });
        assert.match(errors.join(' '), re, JSON.stringify(over));
    }
    assert.deepStrictEqual(validateRecord(buildRecordLoose(input()), { table: TABLE }), []);
});
function buildRecordLoose(i) {
    return { id: 'em-1', effort: 'medium', would_high_catch: 'unknown', recorded_at: NOW, ...i };
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

test('ausência de registro é UNKNOWN, nunca zero (campo ausente e lista vazia)', () => {
    assert.deepStrictEqual(readEffortMisses({}), { status: 'UNKNOWN', records: [] });
    assert.deepStrictEqual(readEffortMisses({ effort_misses: [] }), { status: 'UNKNOWN', records: [] });
    assert.deepStrictEqual(readEffortMisses(null), { status: 'UNKNOWN', records: [] });
    const rec = buildRecord(input(), { table: TABLE, now: NOW, existing: [] });
    assert.deepStrictEqual(readEffortMisses({ effort_misses: [rec] }), { status: 'RECORDED', records: [rec] });
});

test('projeção: sem registro nenhum = UNKNOWN; com registro conta por fase e por would_high_catch', () => {
    assert.deepStrictEqual(projectEffortMisses([{ taskId: 'a', state: {} }, { taskId: 'b', state: null }]).status, 'UNKNOWN');
    const mk = (over, existing = []) => buildRecord(input(over), { table: TABLE, now: NOW, existing });
    const p = projectEffortMisses([
        { taskId: 'a', state: { effort_misses: [mk({ phase: 'test', would_high_catch: 'yes' }), mk({ phase: 'test' })] } },
        { taskId: 'b', state: { effort_misses: [mk({ phase: 'verify', would_high_catch: 'no' })] } },
        { taskId: 'c', state: {} },
    ]);
    assert.strictEqual(p.status, 'RECORDED');
    assert.deepStrictEqual(p.runs.map(r => r.taskId), ['a', 'b']);
    assert.deepStrictEqual(p.by_phase.test, { yes: 1, no: 0, unknown: 1 });
    assert.deepStrictEqual(p.by_phase.verify, { yes: 0, no: 1, unknown: 0 });
    assert.strictEqual(p.total, 3);
    assert.match(p.note, /UNKNOWN/);
});

test('schema: run sem o campo segue válida; campo válido passa; inválidos são rejeitados', () => {
    const base = { task_id: 'schema-em', node: 'verify', history: ['plan'], status: 'in_progress' };
    assert.strictEqual(validateState(base).valid, true);
    const rec = buildRecord(input(), { table: TABLE, now: NOW, existing: [] });
    assert.strictEqual(validateState({ ...base, effort_misses: [rec] }).valid, true);
    for (const mutate of [
        r => { r.would_high_catch = 'talvez'; }, r => { r.effort = 'high'; }, r => { r.extra = 1; },
        r => { delete r.evidence_ref; }, r => { r.recorded_by = 'robo'; },
    ]) {
        const bad = JSON.parse(JSON.stringify(rec)); mutate(bad);
        assert.strictEqual(validateState({ ...base, effort_misses: [bad] }).valid, false, JSON.stringify(bad));
    }
});
