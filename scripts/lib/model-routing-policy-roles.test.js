// node --test scripts/lib/model-routing-policy-roles.test.js
// PRI-341 T1 / AC-4: subagent_roles.default tem de ser igual ao default_route (v9 §5.1: «subagentes
// iguais nos dois braços, no default_route»; D6 pede id e esforço fixos). Sem a conferência, a
// policy de piloto poderia derivar entre papéis sem ninguém ver.
const test = require('node:test');
const assert = require('node:assert');
const { validateRoutedPolicy } = require('./model-routing-policy');

// Forma da policy aprovada p1-2026-11-06 (valores reais; só o necessário para o envelope).
function policy(extra = {}) {
    return {
        id: 'routing-pri205',
        version: 'p-test',
        mode: 'ROUTED',
        classifier: { provider: 'cheap_rule' },
        class_to_tier: {
            C1: { tier: 'T1', effort: 'baixo' }, C2: { tier: 'T2', effort: 'médio' },
            C3: { tier: 'T3', effort: 'alto' }, C4: { tier: 'T3', effort: 'alto' }, C5: { tier: 'T3', effort: 'máximo' },
        },
        tiers: { T1: { models: ['claude-sonnet-5-5'] }, T2: { models: ['claude-sonnet-5-5'] }, T3: { models: ['claude-opus-5-5'] } },
        default_route: { model_id: 'claude-opus-5-5', effort: 'alto' },
        effort_map: { baixo: 'low', médio: 'medium', alto: 'high', máximo: 'max' },
        ...extra,
    };
}

test('AC-4: default igual ao default_route → válida', () => {
    const r = validateRoutedPolicy(policy({ subagent_roles: { default: { model_id: 'claude-opus-5-5', effort: 'alto' } } }));
    assert.deepStrictEqual(r.ok, true);
});

test('AC-4: default com model_id diferente → POLICY_INVALID com detalhe', () => {
    const r = validateRoutedPolicy(policy({ subagent_roles: { default: { model_id: 'claude-sonnet-5-5', effort: 'alto' } } }));
    assert.deepStrictEqual([r.ok, r.cause, r.detail], [false, 'POLICY_INVALID', 'subagent_default_model_differs_from_default_route']);
});

test('AC-4: default com esforço diferente → POLICY_INVALID com detalhe', () => {
    const r = validateRoutedPolicy(policy({ subagent_roles: { default: { model_id: 'claude-opus-5-5', effort: 'médio' } } }));
    assert.deepStrictEqual([r.ok, r.cause, r.detail], [false, 'POLICY_INVALID', 'subagent_default_effort_differs_from_default_route']);
});

test('AC-4: effort UNKNOWN com effort_ref (U1) continua válido; só o modelo é conferido', () => {
    const r = validateRoutedPolicy(policy({ subagent_roles: { default: { model_id: 'claude-opus-5-5', effort: 'UNKNOWN', effort_ref: 'U1' } } }));
    assert.deepStrictEqual(r.ok, true);
});

test('AC-4: papel nomeado pode diferir do default_route; só o default é conferido', () => {
    const r = validateRoutedPolicy(policy({ subagent_roles: {
        default: { model_id: 'claude-opus-5-5', effort: 'alto' },
        revisor: { model_id: 'claude-sonnet-5-5', effort: 'médio' },
    } }));
    assert.deepStrictEqual(r.ok, true);
});

test('AC-4: sem subagent_roles ou sem entrada default → como antes', () => {
    assert.deepStrictEqual(validateRoutedPolicy(policy()).ok, true);
    assert.deepStrictEqual(validateRoutedPolicy(policy({ subagent_roles: { revisor: { model_id: 'claude-sonnet-5-5', effort: 'médio' } } })).ok, true);
});

test('AC-4: effort UNKNOWN não dispensa o modelo: modelo diferente continua inválido', () => {
    const r = validateRoutedPolicy(policy({ subagent_roles: { default: { model_id: 'claude-sonnet-5-5', effort: 'UNKNOWN', effort_ref: 'U1' } } }));
    assert.deepStrictEqual([r.ok, r.detail], [false, 'subagent_default_model_differs_from_default_route']);
});
