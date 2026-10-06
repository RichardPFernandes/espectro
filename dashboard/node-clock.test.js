// node --test node-clock.test.js
// Relógio do nó em execução e banner INTERRUPTED derivados do state.json.
const test = require('node:test');
const assert = require('node:assert');
const NC = require('./public/node-clock');

const NOW = Date.parse('2026-09-23T12:00:00.000Z');
const HOUR = 3600000;
const ago = ms => new Date(NOW - ms).toISOString();
const running = (elapsedMs, extra = {}) => ({ status: 'running', node: 'test', node_started_at: ago(elapsedMs), node_timeout_ms: HOUR, ...extra });

test('clock: só com status cru "running" e node_started_at válido', () => {
    assert.strictEqual(NC.clock({ status: 'in_progress', node_started_at: ago(1000) }, NOW), null);
    assert.strictEqual(NC.clock({ status: 'running' }, NOW), null);
    assert.strictEqual(NC.clock({ status: 'running', node_started_at: 'lixo' }, NOW), null);
    const c = NC.clock(running(90 * 1000), NOW);
    assert.strictEqual(c.elapsedMs, 90000);
    assert.strictEqual(NC.fmtDuration(c.elapsedMs), '01:30');
});

test('clock: níveis nos limites 50% / 80% / 100% do node_timeout_ms', () => {
    assert.strictEqual(NC.clock(running(0.5 * HOUR), NOW).level, '');
    assert.strictEqual(NC.clock(running(0.5 * HOUR + 1000), NOW).level, 'warn');
    assert.strictEqual(NC.clock(running(0.8 * HOUR + 1000), NOW).level, 'hot');
    assert.strictEqual(NC.clock(running(HOUR + 1000), NOW).level, 'over');
    // sem node_timeout_ms cai no padrão do watcher (60 min)
    assert.strictEqual(NC.clock(running(0.9 * HOUR, { node_timeout_ms: undefined }), NOW).timeoutMs, NC.DEFAULT_TIMEOUT_MS);
});

test('fmtDuration: horas quando passa de 60 min', () => {
    assert.strictEqual(NC.fmtDuration(0), '00:00');
    assert.strictEqual(NC.fmtDuration(HOUR + 65000), '1:01:05');
});

test('interruption: running além do timeout = suspected', () => {
    assert.strictEqual(NC.interruption(running(0.9 * HOUR), NOW), null);
    const it = NC.interruption(running(2 * HOUR), NOW);
    assert.strictEqual(it.kind, 'suspected');
    assert.strictEqual(it.activeNodeAtInterruption, 'test');
    assert.strictEqual(it.interruptedAt, ago(2 * HOUR));
});

test('interruption: órfão recuperado aguardando redespacho = recovered; some depois do redespacho', () => {
    const since = ago(3 * HOUR);
    const state = {
        status: 'in_progress', node: 'verify', node_started_at: since,
        recovered_from_orphan: { node: 'verify', orphan_since: since, detected_at: ago(60000) },
        events: [{ type: 'node_error', node: 'verify', at: ago(60000), detail: 'Nó órfão detectado na reinicialização do watcher — redespachando' }],
    };
    const it = NC.interruption(state, NOW);
    assert.deepStrictEqual([it.kind, it.activeNodeAtInterruption, it.interruptedAt], ['recovered', 'verify', since]);

    const redispatched = { ...state, status: 'running', node_started_at: ago(1000), recovered_from_orphan: undefined };
    assert.strictEqual(NC.interruption(redispatched, NOW), null);
});

test('interruption: commit órfão escalado = escalated, até o humano trocar o status', () => {
    const state = {
        status: 'needs_human_review', node: 'commit', node_started_at: ago(3 * HOUR),
        events: [{ type: 'escalation', node: 'commit', at: ago(60000), detail: 'Commit órfão detectado na reinicialização do watcher (iniciado em …)' }],
    };
    assert.strictEqual(NC.interruption(state, NOW).kind, 'escalated');
    assert.strictEqual(NC.interruption({ ...state, status: 'in_progress' }, NOW), null);
});

test('interruption: node_error que não é de órfão (state.json inválido) não conta', () => {
    const state = { status: 'in_progress', node: 'review', events: [{ type: 'node_error', node: 'review', at: ago(1000), detail: 'state.json inválido: /status must be string' }] };
    assert.strictEqual(NC.interruption(state, NOW), null);
    assert.strictEqual(NC.interruption({ ...running(2 * HOUR), status: 'committed' }, NOW), null);
});
