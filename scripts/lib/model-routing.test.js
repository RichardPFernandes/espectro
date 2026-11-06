// node --test scripts/lib/model-routing.test.js
// PRI-233 (PRI-205 S4) T3: resolução §4.7 pura, RoutingDecision e argv roteado.
//
// Funções puras: nada aqui lê disco, relógio ou rede. O snapshot é fixado na
// admissão (buildRoutingSnapshot) e a resolução roda no início de cada Attempt
// (resolveRoute). Capacidades (mecanismo de esforço, prova do plugin desligado) são
// injetadas; em produção nesta fatia o mecanismo de esforço é UNAVAILABLE (SP-1).
// Policy, modelos e sinais são sintéticos.
const test = require('node:test');
const assert = require('node:assert');
const wouldRoute = require('./would-route');
const mr = require('./model-routing');

function policy(overrides = {}) {
    return {
        id: 'routing-sintetica',
        version: 'p-test-1',
        mode: 'ROUTED',
        classifier: { provider: 'cheap_rule' },
        class_to_tier: {
            C1: { tier: 'T1', effort: 'baixo' },
            C2: { tier: 'T2', effort: 'médio' },
            C3: { tier: 'T2', effort: 'alto' },
            C4: { tier: 'T3', effort: 'alto' },
            C5: { tier: 'T3', effort: 'máximo' },
        },
        tiers: {
            T1: { models: ['m-t1'] },
            T2: { models: ['m-t2a', 'm-t2b'] },
            T3: { models: ['m-t3'] },
        },
        default_route: { model_id: 'm-t3', effort: 'alto' },
        effort_map: { baixo: 'low', 'médio': 'medium', alto: 'high', 'máximo': 'max' },
        ...overrides,
    };
}

function loaded(p = policy()) {
    return {
        status: 'ON',
        policy: p,
        policy_ref: { id: p.id, version: p.version, sha256: 'a'.repeat(64), path: '.claude/routing-policy.json' },
        policy_hash: 'a'.repeat(64),
    };
}

const VERIFIED = Object.freeze({
    effortMechanism: { status: 'VERIFIED', flag: '--effort' },
    pluginProof: { status: 'NOT_LOADED', settings_path: '/run/routing-settings.json', settings_sha256: 'b'.repeat(64) },
});

// Grupo de sinais S2 que a classificadora põe em C1 (R5: 1 arquivo docs, ≤1 AC).
const C1_GROUP = {
    subtask_key: 'g1', steps: [1],
    signals: { sensitive_decl: false, n_files: 1, kind: 'docs', n_acs_step: 1, n_new_files: 0, code_local: false, schema_decl: false, rework_count: 0 },
};
// C2 (R6: 2 arquivos code_local).
const C2_GROUP = {
    subtask_key: 'g2', steps: [2],
    signals: { sensitive_decl: false, n_files: 2, kind: 'code', n_acs_step: 2, n_new_files: 1, code_local: true, schema_decl: false, rework_count: 0 },
};
// C5 (R1: sensível).
const C5_GROUP = { subtask_key: 'g5', steps: [3], signals: { ...C2_GROUP.signals, sensitive_decl: true } };

const signalsOf = (...groups) => ({ status: 'COMPLETE', plan_version: 'pv1', groups });

function resolve(extra = {}) {
    const snapshot = extra.snapshot || mr.buildRoutingSnapshot(loaded(extra.policy));
    return mr.resolveRoute({
        snapshot,
        node: 'implement',
        signals: signalsOf(C1_GROUP),
        provider: { state: 'ACTIVE' },
        capabilities: VERIFIED,
        overrides: [],
        nodeBoundaryAt: '2026-11-06T12:00:00.000Z',
        ...extra,
        ...(extra.snapshot ? {} : { snapshot }),
    });
}

// ── Snapshot ───────────────────────────────────────────────────────────────────

test('buildRoutingSnapshot: mode ON, policy_ref, default_route explícito, eligible_set e sha256 canônico', () => {
    const s = mr.buildRoutingSnapshot(loaded());
    assert.strictEqual(s.mode, 'ON');
    assert.deepStrictEqual(s.policy_ref, loaded().policy_ref);
    assert.deepStrictEqual(s.default_route, { model_id: 'm-t3', effort: 'alto' });
    assert.deepStrictEqual(s.eligible_set, { provider: 'anthropic', models: ['m-t1', 'm-t2a', 'm-t2b', 'm-t3'] });
    assert.match(s.eligible_set_ref, /^[0-9a-f]{64}$/);
    assert.match(s.sha256, /^[0-9a-f]{64}$/);
    assert.strictEqual(mr.snapshotIntegrity(s).ok, true);
    // Mesma entrada → mesmo snapshot, byte a byte.
    assert.strictEqual(JSON.stringify(mr.buildRoutingSnapshot(loaded())), JSON.stringify(s));
});

test('buildRoutingSnapshot recusa routing que não está ON', () => {
    assert.throws(() => mr.buildRoutingSnapshot({ status: 'OFF', source: 'absent' }), /ROUTING_SNAPSHOT_REQUIRES_ON/);
    assert.throws(() => mr.buildRoutingSnapshot({ status: 'INVALID', cause: 'POLICY_MISSING' }), /ROUTING_SNAPSHOT_REQUIRES_ON/);
});

// ── Passo 1: snapshot legível e íntegro ─────────────────────────────────────────

for (const [name, mutate] of [
    ['ausente', () => null],
    ['não é objeto', () => 'texto'],
    ['sha256 divergente', s => ({ ...s, sha256: 'c'.repeat(64) })],
    ['conteúdo alterado depois do hash', s => ({ ...s, default_route: { model_id: 'm-t1', effort: 'baixo' } })],
    ['mode diferente de ON', s => ({ ...s, mode: 'OFF' })],
]) {
    test(`passo 1: snapshot ${name} → NOT_STARTED/CONFIG_UNVERIFIABLE (AC-05)`, () => {
        const snap = mutate(mr.buildRoutingSnapshot(loaded()));
        const r = mr.resolveRoute({ snapshot: snap, node: 'implement', signals: signalsOf(C1_GROUP), provider: { state: 'ACTIVE' }, capabilities: VERIFIED, overrides: [] });
        assert.deepStrictEqual([r.ok, r.result, r.cause], [false, 'NOT_STARTED', 'CONFIG_UNVERIFIABLE']);
        assert.match(r.detail, /^snapshot_/);
    });
}

// ── Passo 2: provider ──────────────────────────────────────────────────────────

for (const state of ['DISABLED', 'DRAINING', 'UNKNOWN', undefined]) {
    test(`passo 2: provider ${state} → NOT_STARTED/PROVIDER_NOT_ELIGIBLE (AC-06)`, () => {
        const r = resolve({ provider: { state } });
        assert.deepStrictEqual([r.ok, r.result, r.cause], [false, 'NOT_STARTED', 'PROVIDER_NOT_ELIGIBLE']);
        assert.strictEqual(r.detail, `provider_${String(state || 'UNKNOWN').toLowerCase()}`);
    });
}

// ── Passo 4/5: classificadora e candidatos ─────────────────────────────────────

test('caminho feliz (Implement, C1): par fixado, RoutingDecision completa (AC-02)', () => {
    const r = resolve();
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    const d = r.decision;
    assert.deepStrictEqual(d.chosen, { model_id: 'm-t1', effort: 'baixo', cli_effort: 'low', tier: 'T1' });
    assert.strictEqual(d.class, 'C1');
    assert.strictEqual(d.selection_source, 'RULES');
    assert.deepStrictEqual(d.policy_ref, loaded().policy_ref);
    assert.match(d.eligible_set_ref, /^[0-9a-f]{64}$/);
    assert.match(d.signals_sha256, /^[0-9a-f]{64}$/);
    assert.deepStrictEqual(d.candidates, [{ tier: 'T1', model_id: 'm-t1', status: 'CHOSEN', reason: null }]);
    assert.strictEqual(d.override_ref, null);
    assert.strictEqual(d.subagent, 'UNENFORCED');
    assert.strictEqual(d.effort_router_plugin, 'NOT_LOADED');
    assert.deepStrictEqual(d.plugin_proof, { settings_path: '/run/routing-settings.json', settings_sha256: 'b'.repeat(64) });
    assert.deepStrictEqual(d.effort_mechanism, { status: 'VERIFIED', flag: '--effort' });
    assert.strictEqual(d.node, 'implement');
    assert.strictEqual(d.snapshot_sha256, mr.buildRoutingSnapshot(loaded()).sha256);
});

test('A1: Implement usa a classe máxima dos grupos', () => {
    const r = resolve({ signals: signalsOf(C1_GROUP, C2_GROUP, C1_GROUP) });
    assert.deepStrictEqual([r.decision.class, r.decision.chosen.model_id, r.decision.chosen.effort], ['C2', 'm-t2a', 'médio']);
    const c5 = resolve({ signals: signalsOf(C1_GROUP, C5_GROUP) });
    assert.deepStrictEqual([c5.decision.class, c5.decision.chosen.model_id, c5.decision.chosen.cli_effort], ['C5', 'm-t3', 'max']);
});

test('Plan só sobe a classe (D4) e a decisão registra PLAN_RAISED', () => {
    const r = resolve({ planClasses: { g1: 'C4' } });
    assert.deepStrictEqual([r.decision.class, r.decision.selection_source], ['C4', 'PLAN_RAISED']);
    const down = resolve({ signals: signalsOf(C2_GROUP), planClasses: { g2: 'C1' } });
    assert.strictEqual(down.decision.class, 'C2');
});

for (const [name, signals] of [
    ['ausentes', undefined],
    ['UNAVAILABLE', 'UNAVAILABLE'],
    ['incompletos', { status: 'PARTIAL', groups: [C1_GROUP] }],
    ['sem grupos', signalsOf()],
]) {
    test(`passo 4: sinais ${name} no Implement → C4 CONSERVATIVE_DEFAULT`, () => {
        const r = resolve({ signals });
        assert.strictEqual(r.ok, true, JSON.stringify(r));
        assert.deepStrictEqual([r.decision.class, r.decision.selection_source, r.decision.chosen.model_id], ['C4', 'CONSERVATIVE_DEFAULT', 'm-t3']);
    });
}

test('A2: nós fora do Implement vão no default_route explícito (D6), sem herdar modelo (AC-03)', () => {
    for (const node of ['fetch_ticket', 'plan', 'review', 'test', 'verify', 'commit']) {
        const r = resolve({ node, signals: signalsOf(C1_GROUP) });
        assert.strictEqual(r.ok, true, `${node}: ${JSON.stringify(r)}`);
        assert.deepStrictEqual(r.decision.chosen, { model_id: 'm-t3', effort: 'alto', cli_effort: 'high', tier: 'T3' });
        assert.strictEqual(r.decision.selection_source, 'FIXED_NODE');
        assert.strictEqual(r.decision.class, null);
    }
});

test('passo 5: modelo fora do conjunto elegível é pulado com motivo; tie-break pela ordem declarada', () => {
    const snapshot = mr.buildRoutingSnapshot(loaded());
    const r = resolve({ snapshot, signals: signalsOf(C2_GROUP), ineligibleModels: ['m-t2a'] });
    assert.deepStrictEqual(r.decision.candidates, [
        { tier: 'T2', model_id: 'm-t2a', status: 'DISCARDED', reason: 'INELIGIBLE' },
        { tier: 'T2', model_id: 'm-t2b', status: 'CHOSEN', reason: null },
    ]);
});

test('passo 5: sem candidato no tier, sobe de tier e nunca desce', () => {
    const r = resolve({ signals: signalsOf(C2_GROUP), ineligibleModels: ['m-t2a', 'm-t2b'] });
    assert.deepStrictEqual(r.decision.chosen, { model_id: 'm-t3', effort: 'médio', cli_effort: 'medium', tier: 'T3' });
    assert.ok(!r.decision.candidates.some(c => c.tier === 'T1'), 'nunca avalia tier abaixo da classe');
});

test('passo 5: nenhum candidato em tier ≥ da classe → PROVIDER_NOT_ELIGIBLE (AC-06)', () => {
    const r = resolve({ signals: signalsOf(C2_GROUP), ineligibleModels: ['m-t2a', 'm-t2b', 'm-t3'] });
    assert.deepStrictEqual([r.ok, r.result, r.cause, r.detail], [false, 'NOT_STARTED', 'PROVIDER_NOT_ELIGIBLE', 'no_eligible_candidate']);
    assert.strictEqual(r.decision.candidates.length, 3, 'a decisão recusada guarda os candidatos e os motivos');
});

test('nó fixo com default_route inelegível → PROVIDER_NOT_ELIGIBLE, nunca troca silenciosa', () => {
    const r = resolve({ node: 'review', ineligibleModels: ['m-t3'] });
    assert.deepStrictEqual([r.ok, r.cause, r.detail], [false, 'PROVIDER_NOT_ELIGIBLE', 'default_route_ineligible']);
});

// ── Passo 3: override humano ───────────────────────────────────────────────────

const ov = (scope, value, extra = {}) => ({
    ref: `ov-${scope}`, scope, value, by: 'richard', recorded_at: '2026-11-06T11:00:00.000Z', ...extra,
});

test('passo 3: precedência subtarefa > nó > ticket (AC-09)', () => {
    const overrides = [
        ov('ticket', { model_id: 'm-t2a', effort: 'médio' }),
        ov('node', { model_id: 'm-t2b', effort: 'alto' }, { node: 'implement' }),
        ov('subtask', { model_id: 'm-t3', effort: 'máximo' }, { subtask_key: 's-1' }),
    ];
    const withSubtask = resolve({ overrides, subtaskKey: 's-1' });
    assert.deepStrictEqual([withSubtask.decision.chosen.model_id, withSubtask.decision.override_ref.ref], ['m-t3', 'ov-subtask']);
    assert.strictEqual(withSubtask.decision.selection_source, 'HUMAN_OVERRIDE');
    // S4: sem subtask_key no Attempt, o escopo subtarefa não casa (A5).
    const nodeLevel = resolve({ overrides });
    assert.deepStrictEqual([nodeLevel.decision.chosen.model_id, nodeLevel.decision.override_ref.ref], ['m-t2b', 'ov-node']);
    const otherNode = resolve({ overrides, node: 'review' });
    assert.deepStrictEqual([otherNode.decision.chosen.model_id, otherNode.decision.override_ref.ref], ['m-t2a', 'ov-ticket']);
    assert.deepStrictEqual(nodeLevel.decision.override_ref, {
        ref: 'ov-node', scope: 'node', by: 'richard', recorded_at: '2026-11-06T11:00:00.000Z', value: { model_id: 'm-t2b', effort: 'alto' },
    });
});

test('passo 3: override gravado depois do limite do nó não vale neste Attempt (D-4)', () => {
    const late = ov('ticket', { model_id: 'm-t2a', effort: 'médio' }, { recorded_at: '2026-11-06T12:30:00.000Z' });
    const r = resolve({ overrides: [late] });
    assert.strictEqual(r.decision.override_ref, null);
    assert.deepStrictEqual(r.decision.overrides_pending, ['ov-ticket']);
    const nextNode = resolve({ overrides: [late], nodeBoundaryAt: '2026-11-06T13:00:00.000Z' });
    assert.strictEqual(nextNode.decision.override_ref.ref, 'ov-ticket');
});

test('passo 3: override sem instante válido não vale e fica pendente com motivo', () => {
    const r = resolve({ overrides: [ov('ticket', { model_id: 'm-t2a', effort: 'médio' }, { recorded_at: 'ontem' })] });
    assert.strictEqual(r.decision.override_ref, null);
    assert.deepStrictEqual(r.decision.overrides_pending, ['ov-ticket']);
});

for (const [name, value] of [
    ['modelo fora do conjunto elegível', { model_id: 'm-desconhecido', effort: 'alto' }],
    ['esforço fora do effort_map', { model_id: 'm-t3', effort: 'turbo' }],
]) {
    test(`passo 3: override inelegível (${name}) → PROVIDER_NOT_ELIGIBLE, sem troca silenciosa`, () => {
        const r = resolve({ overrides: [ov('ticket', value)] });
        assert.deepStrictEqual([r.ok, r.cause, r.detail], [false, 'PROVIDER_NOT_ELIGIBLE', 'override_ineligible']);
        assert.strictEqual(r.decision.override_ref.ref, 'ov-ticket');
    });
}

// ── Classificador (A3/A4) ──────────────────────────────────────────────────────

test('A3: R1–R8 rodam mesmo com classifier.provider = off', () => {
    const r = resolve({ policy: policy({ classifier: { provider: 'off' } }), signals: signalsOf(C2_GROUP) });
    assert.strictEqual(r.decision.class, 'C2');
    assert.deepStrictEqual(r.decision.classifier_ref, { declared: 'off', nucleus2_effective: 'off', reason: 'DECLARED_OFF' });
});

test('A4: jev sem Authority Ref → núcleo 2 efetivo off, com motivo (AC-11)', () => {
    const r = resolve({ policy: policy({ classifier: { provider: 'jev' } }) });
    assert.deepStrictEqual(r.decision.classifier_ref, { declared: 'jev', nucleus2_effective: 'off', reason: 'AUTHORITY_REF_ABSENT' });
});

test('A4: jev com Authority Ref continua off na S4 (núcleo 2 fora desta fatia)', () => {
    const r = resolve({ policy: policy({ classifier: { provider: 'jev' } }), authorityRef: { ref: 'declaracao-richard-2026-10-26', valid: true } });
    assert.deepStrictEqual(r.decision.classifier_ref, { declared: 'jev', nucleus2_effective: 'off', reason: 'NUCLEUS2_NOT_IN_S4' });
});

// ── Precondições do despacho roteado (SP-1, SP-2) ──────────────────────────────

test('mecanismo de esforço UNAVAILABLE (produção hoje) → CONFIG_UNVERIFIABLE/EFFORT_MECHANISM_UNAVAILABLE (AC-07)', () => {
    const r = resolve({ capabilities: { ...VERIFIED, effortMechanism: { status: 'UNAVAILABLE' } } });
    assert.deepStrictEqual([r.ok, r.result, r.cause, r.detail], [false, 'NOT_STARTED', 'CONFIG_UNVERIFIABLE', 'EFFORT_MECHANISM_UNAVAILABLE']);
    assert.ok(r.decision.chosen, 'a decisão recusada ainda registra o par que seria usado');
});

test('capacidades ausentes valem como UNAVAILABLE/UNKNOWN, nunca como verificadas', () => {
    const r = resolve({ capabilities: undefined });
    assert.deepStrictEqual([r.cause, r.detail], ['CONFIG_UNVERIFIABLE', 'EFFORT_MECHANISM_UNAVAILABLE']);
});

for (const status of ['LOADED', 'UNKNOWN', undefined]) {
    test(`plugin ${status} → CONFIG_UNVERIFIABLE/PLUGIN_NOT_PROVEN_OFF (AC-08)`, () => {
        const r = resolve({ capabilities: { ...VERIFIED, pluginProof: { status } } });
        assert.deepStrictEqual([r.ok, r.cause, r.detail], [false, 'CONFIG_UNVERIFIABLE', 'PLUGIN_NOT_PROVEN_OFF']);
        assert.strictEqual(r.decision.effort_router_plugin, status || 'UNKNOWN');
    });
}

// ── argv roteado ───────────────────────────────────────────────────────────────

test('routedArgs acrescenta --model, esforço e --settings só a partir de decisão ok', () => {
    const base = ['-p', 'prompt', '--session-id', 'x'];
    const r = resolve();
    assert.deepStrictEqual(mr.routedArgs(base, r), [...base, '--model', 'm-t1', '--effort', 'low', '--settings', '/run/routing-settings.json']);
    assert.deepStrictEqual(base, ['-p', 'prompt', '--session-id', 'x'], 'não muta o argv recebido');
    const refused = resolve({ capabilities: { ...VERIFIED, effortMechanism: { status: 'UNAVAILABLE' } } });
    assert.throws(() => mr.routedArgs(base, refused), /ROUTED_ARGS_REQUIRE_OK_DECISION/);
});

// ── Determinismo e reuso ───────────────────────────────────────────────────────

test('determinismo: 100 resoluções da mesma entrada são idênticas (AC-12)', () => {
    const input = { signals: signalsOf(C1_GROUP, C2_GROUP), overrides: [ov('node', { model_id: 'm-t2b', effort: 'alto' }, { node: 'implement' })] };
    const first = JSON.stringify(resolve(input));
    for (let i = 0; i < 100; i++) assert.strictEqual(JSON.stringify(resolve(input)), first);
});

test('R1–R8 não estão duplicados: o resolver usa a classificadora da S3', () => {
    assert.strictEqual(mr._classifySubtask, wouldRoute.classifySubtask);
});
