// node --test scripts/lib/would-route.test.js
// PRI-223 S3: policy + classificadora §4.4 (R1–R8) + would_route sombra. Sem S4.
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const policyLoader = require('./model-routing-policy');
const wr = require('./would-route');
const ps = require('./plan-signals');

const U = 'UNKNOWN';
const SPEC = '## Critérios de Aceite\n- AC-01: lista de transportadoras.\n- AC-02: mensagem de erro.\n- AC-03: ordenação.\n- AC-04: filtro.\n';

function plan(...steps) {
    return '# Plano — t\n\n## Plano de execução\n' + steps.map((s, i) => {
        const lines = [`${i + 1}. ${s.title || 'Passo'}`];
        if (s.files !== null) lines.push(`   - Arquivo: ${s.files}`);
        if (s.acs !== null) lines.push(`   - Critérios: ${(s.acs || ['AC-01']).join(', ')}`);
        lines.push('   - Verificação: teste.');
        return lines.join('\n');
    }).join('\n') + '\n\n## Cobertura dos ACs\n- AC-01 → passos 1\n';
}
const tick = (...p) => p.map(x => '`' + x + '`').join(', ');

function firstSignals(steps, ctx = {}) {
    const r = ps.buildProspective(plan(...steps), { specContent: SPEC, fileExists: () => true, ...ctx });
    assert.strictEqual(r.status, 'COMPLETE');
    return r.groups[0].signals;
}

function cheapPolicy(overrides = {}) {
    const base = JSON.parse(fs.readFileSync(policyLoader.DEFAULT_POLICY_PATH, 'utf8'));
    base.classifier = { provider: 'cheap_rule' };
    Object.assign(base, overrides);
    return policyLoader.loadPolicy({ json: base });
}

// --- policy envelope --------------------------------------------------------

test('policy default (cheap_rule) carrega com hash estável', () => {
    const a = policyLoader.loadPolicy();
    const b = policyLoader.loadPolicy();
    assert.strictEqual(a.status, 'LOADED');
    assert.strictEqual(a.policy.classifier.provider, 'cheap_rule');
    assert.strictEqual(a.policy.mode, 'SHADOW');
    assert.strictEqual(a.policy_version, b.policy_version);
    assert.strictEqual(a.policy_hash, b.policy_hash);
    assert.match(a.policy_hash, /^[0-9a-f]{64}$/);
});

test('policy inválida / jev / mode ON → INVALID; despacho não é assunto deste módulo', () => {
    assert.strictEqual(policyLoader.loadPolicy({ json: { version: 'x' } }).status, 'INVALID');
    const jev = policyLoader.loadPolicy({
        json: {
            version: 'x', mode: 'SHADOW', classifier: { provider: 'jev' },
            class_to_tier: JSON.parse(fs.readFileSync(policyLoader.DEFAULT_POLICY_PATH, 'utf8')).class_to_tier,
            tiers: JSON.parse(fs.readFileSync(policyLoader.DEFAULT_POLICY_PATH, 'utf8')).tiers,
            default_route: { model_id: 'UNAVAILABLE', effort: 'UNAVAILABLE' },
        },
    });
    assert.strictEqual(jev.status, 'INVALID');
    assert.match(jev.detail, /jev/);
    const on = policyLoader.loadPolicy({
        json: {
            ...JSON.parse(fs.readFileSync(policyLoader.DEFAULT_POLICY_PATH, 'utf8')),
            mode: 'ON',
        },
    });
    assert.strictEqual(on.status, 'INVALID');
});

test('classifier off → NO_DECISION, applied=false, sem classes', () => {
    const off = JSON.parse(fs.readFileSync(policyLoader.DEFAULT_POLICY_PATH, 'utf8'));
    off.classifier = { provider: 'off' };
    const out = wr.shadowDecide({
        loaded: policyLoader.loadPolicy({ json: off }),
        signals: { status: 'COMPLETE', groups: [{ subtask_key: 'k', signals: firstSignals([{ files: tick('README.md') }]) }] },
    });
    assert.strictEqual(out.status, wr.NO_DECISION);
    assert.strictEqual(out.cause, 'CLASSIFIER_OFF');
    assert.strictEqual(out.applied, false);
    assert.deepStrictEqual(out.decisions, []);
    assert.strictEqual(out.planning_bias.alters_r1_r8, false);
});

test('policy default cheap_rule → decisões sombra com faixa; applied=false; sem S4', () => {
    const signals = ps.buildProspective(plan(
        { title: 'Docs', files: tick('README.md'), acs: ['AC-01'] },
        { title: 'Code', files: tick('src/a.js', 'src/a.test.js'), acs: ['AC-02'] },
    ), { specContent: SPEC, fileExists: () => true });
    const out = wr.shadowDecide({ loaded: policyLoader.loadPolicy(), signals });
    assert.strictEqual(out.status, wr.SHADOW);
    assert.strictEqual(out.applied, false);
    assert.strictEqual(out.classifier_ref.provider, 'cheap_rule');
    assert.ok(out.decisions.length >= 1);
    assert.ok(out.decisions.every(d => d.class && d.tier && d.rule));
    assert.ok(out.aggregate.subtasks === out.decisions.length);
});

test('policy ausente → NO_DECISION POLICY_MISSING', () => {
    const out = wr.shadowDecide({ loaded: policyLoader.loadPolicy({ path: path.join(__dirname, 'nao-existe-policy.json') }) });
    assert.strictEqual(out.cause, 'POLICY_MISSING');
    assert.strictEqual(out.applied, false);
});

// --- §4.4 / §4.5 (classes do desenho v9; mesmos casos S2) -------------------

test('§4.5 C1: README.md → R5', () => {
    const s = firstSignals([{ files: tick('README.md') }]);
    assert.deepStrictEqual(wr.classifyByRules(s), { class: 'C1', rule: 'R5' });
});

test('§4.5 C2: js+teste code_local → R6', () => {
    const s = firstSignals(
        [{ files: tick('backend/svc-a/src/x.js', 'backend/svc-a/test/x.test.js'), acs: ['AC-01', 'AC-02'] }],
        { fileExists: p => p !== 'backend/svc-a/test/x.test.js' },
    );
    assert.deepStrictEqual(wr.classifyByRules(s), { class: 'C2', rule: 'R6' });
});

test('§4.5 C2: docs não conta bucket, code_local → R6', () => {
    const s = firstSignals([{ files: tick('backend/svc-a/src/a.js', 'backend/svc-a/README.md') }]);
    assert.deepStrictEqual(wr.classifyByRules(s), { class: 'C2', rule: 'R6' });
});

test('§4.5 C4: 3 arquivos 4 ACs code_local → R8 (não C2/C3)', () => {
    const s = firstSignals([{
        files: tick('backend/svc-a/src/a.js', 'backend/svc-a/src/b.js', 'backend/svc-a/src/c.js'),
        acs: ['AC-01', 'AC-02', 'AC-03', 'AC-04'],
    }]);
    assert.deepStrictEqual(wr.classifyByRules(s), { class: 'C4', rule: 'R8' });
});

test('§4.5 C4: behavior / config / schema / multi-serviço / shared', () => {
    assert.strictEqual(wr.classifyByRules(firstSignals([{ files: tick('.claude/commands/plan.md') }])).class, 'C4');
    assert.strictEqual(wr.classifyByRules(firstSignals([{ files: tick('backend/svc-a/src/main/resources/application.yml') }])).rule, 'R4');
    assert.strictEqual(wr.classifyByRules(firstSignals([{ files: tick('backend/svc-a/src/main/java/X.java') }])).rule, 'R4');
    assert.strictEqual(wr.classifyByRules(firstSignals([{ files: tick('backend/svc-a/src/a.js', 'backend/svc-b/src/b.js') }])).rule, 'R4');
    assert.strictEqual(wr.classifyByRules(firstSignals([{ files: tick('backend/svc-a/src/shared/util.js') }])).class, 'C4');
});

test('§4.5 C4 via R3: UNKNOWN (paths / sensitive)', () => {
    assert.strictEqual(wr.classifyByRules(firstSignals([{ files: null }])).rule, 'R3');
    assert.strictEqual(wr.classifyByRules(firstSignals([{ files: tick('backend/svc-a/src/a.js'), acs: ['AC-99'] }])).rule, 'R3');
    const topo = firstSignals([{ files: tick('backend/svc-a/src/a.js') }], {
        policy: { ...ps.DEFAULT_POLICY, service_roots: [] },
    });
    assert.strictEqual(wr.classifyByRules(topo).rule, 'R3');
});

test('§4.5 C5: sensitive_decl → R1; schema+high → R2', () => {
    const spec = '## Critérios de Aceite\n- AC-01: exige autenticação do usuário (auth) antes de listar.\n';
    assert.deepStrictEqual(
        wr.classifyByRules(firstSignals([{ files: tick('backend/svc-a/src/a.js') }], { specContent: spec })),
        { class: 'C5', rule: 'R1' },
    );
    const mig = firstSignals(
        [{ files: tick('backend/svc-a/src/main/resources/db/migration/V12__add_col.sql') }],
        { state: { schema_risk_level: 'high' } },
    );
    assert.deepStrictEqual(wr.classifyByRules(mig), { class: 'C5', rule: 'R2' });
});

test('Plan só sobe a classe (nunca desce)', () => {
    const s = firstSignals([{ files: tick('README.md') }]); // C1
    const raised = wr.classifySubtask(s, 'C4');
    assert.strictEqual(raised.class, 'C4');
    assert.strictEqual(raised.selection_source, 'PLAN_RAISED');
    const ignored = wr.classifySubtask(
        firstSignals([{ files: tick('backend/svc-a/src/auth/Login.js') }]), // C5
        'C1',
    );
    assert.strictEqual(ignored.class, 'C5');
});

test('cheap_rule grava would_route por subtarefa com classe/tier/regra; applied=false', () => {
    const prospective = ps.buildProspective(plan(
        { files: tick('README.md') },
        { files: tick('backend/svc-a/src/a.js', 'backend/svc-a/test/a.test.js'), acs: ['AC-01', 'AC-02'] },
    ), { specContent: SPEC, fileExists: p => !p.includes('test') });
    const out = wr.shadowDecide({ loaded: cheapPolicy(), signals: prospective });
    assert.strictEqual(out.status, wr.SHADOW);
    assert.strictEqual(out.applied, false);
    assert.strictEqual(out.classifier_ref.provider, 'cheap_rule');
    assert.ok(out.policy_hash);
    assert.strictEqual(out.decisions.length, 2);
    assert.strictEqual(out.decisions[0].class, 'C1');
    assert.strictEqual(out.decisions[0].tier, 'T1');
    assert.strictEqual(out.decisions[0].rule, 'R5');
    assert.strictEqual(out.decisions[0].leaves_opus_tier, true);
    assert.strictEqual(out.decisions[0].requested_effort, 'UNAVAILABLE');
    assert.strictEqual(out.decisions[1].class, 'C2');
    assert.strictEqual(out.decisions[1].tier, 'T2');
    assert.ok(out.aggregate.leaves_opus_tier >= 1);
});

test('argv/despacho idêntico com ou sem sombra (fronteira S3)', () => {
    const asIs = ['claude', '-p', '--output-format', 'text'];
    const withShadowComputed = [...asIs]; // sombra calculada à parte, nunca no argv
    wr.shadowDecide({ loaded: cheapPolicy(), signals: { groups: [] } });
    assert.strictEqual(wr.assertDispatchUnchanged(asIs, withShadowComputed), true);
});

test('nota humana de planejamento não altera R1–R8', () => {
    const s = firstSignals([{ files: tick('README.md') }]);
    assert.deepStrictEqual(wr.classifyByRules(s), { class: 'C1', rule: 'R5' });
    const out = wr.shadowDecide({ loaded: cheapPolicy() });
    assert.strictEqual(out.planning_bias.prefer_quality_on_doubt, true);
    assert.strictEqual(out.planning_bias.sonnet_only_if_very_simple, true);
    assert.strictEqual(out.planning_bias.alters_r1_r8, false);
});
