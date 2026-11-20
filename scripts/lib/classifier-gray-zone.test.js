// node --test scripts/lib/classifier-gray-zone.test.js
// PRI-205 S3b T1: quem o núcleo 2 (Jev, sombra) pergunta — exclusões soberanas,
// G1/G2 (zona cinzenta) e G3 (sonda de subida C1–C3), SPEC §B3. Sinais sintéticos.
const test = require('node:test');
const assert = require('node:assert');
const gz = require('./classifier-gray-zone');

// Grupo C2 típico (R6): 2 arquivos de código local, 1 novo, 2 ACs, 1 serviço.
function sig(overrides = {}) {
    return {
        n_files: 2, kind: 'code', code_local: true, n_new_files: 1, n_acs_step: 2,
        sensitive_decl: false, schema_decl: false, n_services_decl: 1,
        rework_count: 0, ticket_rework: false,
        ...overrides,
    };
}

const CASES = [
    // [nome, sinais, planClass, call, probe, reason, class]
    ['C2 (R6) → sonda de subida', sig(), null, true, 'UPGRADE_PROBE', 'G3', 'C2'],
    ['C1 (R5): 1 README, 1 AC → sonda', sig({ n_files: 1, kind: 'docs', code_local: false, n_new_files: 0, n_acs_step: 1 }), null, true, 'UPGRADE_PROBE', 'G3', 'C1'],
    ['C3 (R7): 4 arquivos, 3 ACs → sonda', sig({ n_files: 4, n_new_files: 2, n_acs_step: 3 }), null, true, 'UPGRADE_PROBE', 'G3', 'C3'],
    ['§4.5: 3 arquivos, 4 ACs (R8) → a 1 AC de C3 → cinzenta', sig({ n_files: 3, n_new_files: 2, n_acs_step: 4 }), null, true, 'GRAY', 'G2', 'C4'],
    ['3 arquivos, 5 ACs (R8) → 2 acima do corte → não cinzenta', sig({ n_files: 3, n_new_files: 2, n_acs_step: 5 }), null, false, null, 'NOT_GRAY', 'C4'],
    ['6 arquivos (R4 só por n_files) → a 1 de C3 → cinzenta', sig({ n_files: 6, n_new_files: 2, n_acs_step: 3 }), null, true, 'GRAY', 'G2', 'C4'],
    ['7 arquivos (R4) → 2 acima → não cinzenta', sig({ n_files: 7, n_new_files: 2, n_acs_step: 3 }), null, false, null, 'NOT_GRAY', 'C4'],
    ['6 arquivos e 4 ACs → dois critérios falham → não cinzenta', sig({ n_files: 6, n_new_files: 2, n_acs_step: 4 }), null, false, null, 'NOT_GRAY', 'C4'],
    ['topologia não declarada (code_local/serviços UNKNOWN, R3) → G1', sig({ code_local: 'UNKNOWN', n_services_decl: 'UNKNOWN' }), null, true, 'GRAY', 'G1', 'C4'],
    ['código compartilhado, 2 arquivos (R8 sem critério numérico) → não cinzenta', sig({ code_local: false }), null, false, null, 'NOT_GRAY', 'C4'],
    ['sensível true (R1) → excluído', sig({ sensitive_decl: true }), null, false, null, 'EXCLUDED_SENSITIVE', 'C5'],
    ['sensível UNKNOWN (AC fora da spec) → excluído (Q3)', sig({ sensitive_decl: 'UNKNOWN' }), null, false, null, 'EXCLUDED_SENSITIVE', 'C4'],
    ['passo sem Arquivo: (tudo UNKNOWN) → excluído', sig({ n_files: 'UNKNOWN', kind: 'UNKNOWN', schema_decl: 'UNKNOWN', sensitive_decl: 'UNKNOWN', code_local: 'UNKNOWN', n_new_files: 'UNKNOWN', n_services_decl: 'UNKNOWN' }), null, false, null, 'EXCLUDED_SENSITIVE', 'C4'],
    ['retrabalho repetido (R2) → excluído', sig({ rework_count: 2 }), null, false, null, 'EXCLUDED_R2', 'C5'],
    ['schema com risco alto (R2) → excluído', sig({ schema_decl: true, schema_risk_seen: 'high' }), null, false, null, 'EXCLUDED_R2', 'C5'],
    ['schema declarado → excluído', sig({ schema_decl: true }), null, false, null, 'EXCLUDED_SCHEMA', 'C4'],
    ['schema UNKNOWN → excluído (núcleo 1 dá C2)', sig({ schema_decl: 'UNKNOWN' }), null, false, null, 'EXCLUDED_SCHEMA', 'C2'],
    ['kind behavior → excluído', sig({ kind: 'behavior', code_local: false }), null, false, null, 'EXCLUDED_KIND', 'C4'],
    ['kind config → excluído', sig({ kind: 'config', code_local: false }), null, false, null, 'EXCLUDED_KIND', 'C4'],
    ['2 serviços → excluído', sig({ n_services_decl: 2, code_local: false }), null, false, null, 'EXCLUDED_SERVICES', 'C4'],
    ['retrabalho (rework_count 1) → excluído (Q3)', sig({ rework_count: 1 }), null, false, null, 'EXCLUDED_REWORK', 'C4'],
    ['ticket em retrabalho → excluído (Q3)', sig({ ticket_rework: true }), null, false, null, 'EXCLUDED_REWORK', 'C4'],
    ['Plan subiu a classe → excluído', sig(), 'C4', false, null, 'EXCLUDED_PLAN_RAISED', 'C4'],
    ['Plan propõe a mesma classe → segue a sonda', sig(), 'C2', true, 'UPGRADE_PROBE', 'G3', 'C2'],
];

for (const [name, signals, planClass, call, probe, reason, klass] of CASES) {
    test(`eligibility: ${name}`, () => {
        const r = gz.eligibility(signals, planClass);
        assert.deepStrictEqual(
            { call: r.call, probe: r.probe, reason: r.reason, class: r.class },
            { call, probe, reason, class: klass },
        );
    });
}

test('eligibility: sinais ausentes não lançam e não chamam', () => {
    const r = gz.eligibility(undefined);
    assert.strictEqual(r.call, false);
    assert.strictEqual(r.probe, null);
});

test('eligibility: devolve a regra do núcleo 1 para auditoria', () => {
    assert.strictEqual(gz.eligibility(sig({ n_files: 6, n_new_files: 2, n_acs_step: 3 })).rule, 'R4');
    assert.strictEqual(gz.eligibility(sig()).rule, 'R6');
});

test('prioritize: G1/G2 antes de G3, no máximo 3, o resto SKIPPED_BUDGET, ordem estável', () => {
    const groups = [
        { subtask_key: 'a', signals: sig() }, // G3
        { subtask_key: 'b', signals: sig({ sensitive_decl: true }) }, // excluído
        { subtask_key: 'c', signals: sig({ n_files: 6, n_new_files: 2, n_acs_step: 3 }) }, // G2
        { subtask_key: 'd', signals: sig({ n_files: 1, kind: 'docs', code_local: false, n_new_files: 0, n_acs_step: 1 }) }, // G3
        { subtask_key: 'e', signals: sig({ code_local: 'UNKNOWN', n_services_decl: 'UNKNOWN' }) }, // G1
        { subtask_key: 'f', signals: sig({ n_files: 4, n_new_files: 2, n_acs_step: 3 }) }, // G3
    ];
    const out = gz.prioritize(groups, 3);
    assert.deepStrictEqual(out.map(g => [g.subtask_key, g.status]), [
        ['a', 'SELECTED'],
        ['b', 'NOT_ELIGIBLE'],
        ['c', 'SELECTED'],
        ['d', 'SKIPPED_BUDGET'],
        ['e', 'SELECTED'],
        ['f', 'SKIPPED_BUDGET'],
    ]);
    assert.strictEqual(out[1].eligibility.reason, 'EXCLUDED_SENSITIVE');
    assert.strictEqual(out[0].eligibility.probe, 'UPGRADE_PROBE');
});

test('prioritize: o padrão é 3 (Q8) e lista vazia devolve vazia', () => {
    assert.strictEqual(gz.MAX_CALLS_PER_VISIT, 3);
    assert.deepStrictEqual(gz.prioritize([]), []);
    const many = Array.from({ length: 5 }, (_, i) => ({ subtask_key: String(i), signals: sig() }));
    assert.strictEqual(gz.prioritize(many).filter(g => g.status === 'SELECTED').length, 3);
});
