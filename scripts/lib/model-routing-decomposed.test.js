// node --test scripts/lib/model-routing-decomposed.test.js
// PRI-311 (PRI-287 S5.2b): resolução por grupo da Run decomposta (B5.3, B5.7–8, Q4) e papéis de
// subagente (B8). Funções puras; policy, modelos e sinais sintéticos.
const test = require('node:test');
const assert = require('node:assert');
const mr = require('./model-routing');
const visit = require('./decomposition-visit');

function policy(extra = {}) {
    return {
        id: 'routing-sintetica', version: 'p-test-1', mode: 'ROUTED', classifier: { provider: 'cheap_rule' },
        class_to_tier: {
            C1: { tier: 'T1', effort: 'baixo' }, C2: { tier: 'T2', effort: 'médio' }, C3: { tier: 'T2', effort: 'alto' },
            C4: { tier: 'T3', effort: 'alto' }, C5: { tier: 'T3', effort: 'máximo' },
        },
        tiers: { T1: { models: ['m-t1'] }, T2: { models: ['m-t2'] }, T3: { models: ['m-t3'] } },
        default_route: { model_id: 'm-t3', effort: 'alto' },
        effort_map: { baixo: 'low', 'médio': 'medium', alto: 'high', 'máximo': 'max' },
        ...extra,
    };
}
const snapshotOf = (p = policy()) => mr.buildRoutingSnapshot({
    status: 'ON', policy: p, policy_ref: { id: p.id, version: p.version, sha256: 'a'.repeat(64), path: '.claude/routing-policy.json' }, decomposition: 'on',
});
const CAPS = { pluginProof: { status: 'NOT_LOADED', settings_path: '/run/s.json', settings_sha256: 'b'.repeat(64) } };
const C1 = { subtask_key: 'pv/1-1', steps: [1], signals: { sensitive_decl: false, n_files: 1, kind: 'docs', n_acs_step: 1, n_new_files: 0, code_local: false, schema_decl: false, rework_count: 0 } };
const C5 = { subtask_key: 'pv/2-2', steps: [2], signals: { sensitive_decl: true, n_files: 2, kind: 'code', n_acs_step: 2, n_new_files: 1, code_local: true, schema_decl: false, rework_count: 0 } };
const SIGNALS = { status: 'COMPLETE', plan_version: 'pv', groups: [C1, C5] };
const NOW = '2026-11-09T12:00:00.000Z';

function resolve(extra = {}) {
    return mr.resolveRoute({ snapshot: snapshotOf(extra.policy), node: 'implement', provider: { state: 'ACTIVE' }, capabilities: CAPS, nodeBoundaryAt: NOW, ...extra });
}

test('AC-24: classe por grupo — os sinais de um grupo não sobem a classe do outro', () => {
    const g1 = resolve({ signals: visit.groupSignals(SIGNALS, 'pv/1-1'), subtaskKey: 'pv/1-1' });
    const g2 = resolve({ signals: visit.groupSignals(SIGNALS, 'pv/2-2'), subtaskKey: 'pv/2-2' });
    assert.strictEqual(g1.decision.class, 'C1');
    assert.strictEqual(g1.decision.chosen.model_id, 'm-t1');
    assert.strictEqual(g2.decision.class, 'C5');
    // Nó inteiro (S4) seria a classe máxima: C5.
    assert.strictEqual(resolve({ signals: SIGNALS }).decision.class, 'C5');
});

test('AC-24: rework ≥ resolução inicial; piso nunca desce; override humano prevalece sobre o piso', () => {
    const signals = visit.groupSignals(SIGNALS, 'pv/1-1');
    const floored = resolve({ signals, subtaskKey: 'pv/1-1', classFloor: { class: 'C3', selection_source: 'LINEAGE_FLOOR' } });
    assert.deepStrictEqual([floored.decision.class, floored.decision.selection_source, floored.decision.chosen.model_id], ['C3', 'LINEAGE_FLOOR', 'm-t2']);
    const below = resolve({ signals: visit.groupSignals(SIGNALS, 'pv/2-2'), subtaskKey: 'pv/2-2', classFloor: { class: 'C2', selection_source: 'LINEAGE_FLOOR' } });
    assert.strictEqual(below.decision.class, 'C5', 'piso abaixo da classe calculada não a rebaixa');
    const overrides = [{ ref: 'o1', scope: 'subtask', subtask_key: 'pv/1-1', by: 'richard', recorded_at: '2026-11-09T11:00:00.000Z', value: { model_id: 'm-t1', effort: 'baixo' } }];
    const ov = resolve({ signals, subtaskKey: 'pv/1-1', overrides, classFloor: { class: 'C4', selection_source: 'RISK_RECLASSIFIED' } });
    assert.deepStrictEqual([ov.decision.selection_source, ov.decision.chosen.model_id], ['HUMAN_OVERRIDE', 'm-t1']);
    // ALL não aceita override de subtarefa (subtaskKey null): o piso C4 vale.
    const all = resolve({ signals: SIGNALS, subtaskKey: null, overrides, classFloor: { class: 'C4', selection_source: 'RISK_RECLASSIFIED' } });
    assert.deepStrictEqual([all.decision.class, all.decision.override_ref], ['C5', null], 'override de subtarefa não vale para ALL; classe acima do piso fica');
    const allC1 = resolve({ signals: visit.groupSignals(SIGNALS, 'pv/1-1'), subtaskKey: null, overrides, classFloor: { class: 'C4', selection_source: 'RISK_RECLASSIFIED' } });
    assert.deepStrictEqual([allC1.decision.class, allC1.decision.selection_source, allC1.decision.chosen.model_id], ['C4', 'RISK_RECLASSIFIED', 'm-t3']);
});

test('AC-25: ALL = nó inteiro em C4 (exato, mesmo com grupo C5); scope_violation com classe já ≥ C4 grava RISK_RECLASSIFIED', () => {
    const all = resolve({ signals: SIGNALS, subtaskKey: null, classFloor: { class: 'C4', selection_source: 'RISK_RECLASSIFIED', exact: true } });
    assert.deepStrictEqual([all.decision.class, all.decision.selection_source, all.decision.chosen.model_id], ['C4', 'RISK_RECLASSIFIED', 'm-t3']);
    const sv = resolve({ signals: visit.groupSignals(SIGNALS, 'pv/2-2'), subtaskKey: 'pv/2-2', classFloor: { class: 'C4', selection_source: 'RISK_RECLASSIFIED' } });
    assert.deepStrictEqual([sv.decision.class, sv.decision.selection_source], ['C5', 'RISK_RECLASSIFIED'], 'classe fica (nunca desce), a marca de risco é gravada (m3)');
});

test('Q4: integração no default_route (nó fixo), com a classe ignorada', () => {
    const r = resolve({ signals: visit.groupSignals(SIGNALS, 'pv/1-1'), fixedRoute: true });
    assert.deepStrictEqual([r.decision.class, r.decision.selection_source, r.decision.chosen.model_id, r.decision.chosen.effort], [null, 'FIXED_NODE', 'm-t3', 'alto']);
});

test('AC-27: sem subagent_roles na policy → linha default UNENFORCED, sem --agents', () => {
    const roles = mr.subagentRoles({ snapshot: snapshotOf(), agents: [{ name: 'revisor', description: 'r', prompt: 'p' }] });
    assert.deepStrictEqual(roles, { roles: [{ role: 'default', declared_model: null, declared_effort: null, enforcement: 'UNENFORCED', effort_enforcement: 'UNKNOWN', cause: 'NO_SUBAGENT_ROLES_SECTION', observed_model: null }], agentsJson: null, agents_sha256: null, mechanism: null });
    const r = resolve({ signals: SIGNALS, subagentRoles: roles.roles });
    assert.deepStrictEqual(r.decision.subagent_roles, roles.roles);
    assert.strictEqual(r.decision.subagent, 'UNENFORCED');
    assert.ok(!mr.routedArgs([], r, { agentsJson: roles.agentsJson }).includes('--agents'));
});

test('AC-27: mecanismo só nas versões provadas da CLI (U10-a: 2.1.319 e 2.1.323), cada uma com a própria prova', () => {
    assert.deepStrictEqual(mr.subagentMechanism('2.1.319'), { status: 'VERIFIED', mechanism: 'agents_flag', cli_version: '2.1.319', proof_ref: 'tasks/pri-287-s5/u10-probe-evidence.json' });
    assert.deepStrictEqual(mr.subagentMechanism('2.1.323'), { status: 'VERIFIED', mechanism: 'agents_flag', cli_version: '2.1.323', proof_ref: 'tasks/pri-287-s5/u10-probe-evidence-2.1.323.json' });
    for (const v of ['2.1.320', '2.1.322', '2.1.324', '2.2.0', 'toString', '__proto__']) {
        assert.deepStrictEqual([v, mr.subagentMechanism(v).status, mr.subagentMechanism(v).reason, mr.subagentMechanism(v).proof_ref], [v, 'UNVERIFIED', 'CLI_VERSION_NOT_PROVEN', null]);
    }
    assert.strictEqual(mr.subagentMechanism(null).reason, 'CLI_VERSION_UNKNOWN');
    assert.deepStrictEqual(mr.SUBAGENT_MECHANISM_PROOF.cli_versions, ['2.1.319', '2.1.323']);
});

test('AC-27: cada proof_ref aponta para evidência no repositório com controle que vê o frontmatter e duas provas do --agents na própria versão', () => {
    const fs = require('fs');
    const path = require('path');
    const root = path.resolve(__dirname, '..', '..');
    for (const [version, ref] of Object.entries(mr.SUBAGENT_MECHANISM_PROOF.proof_refs)) {
        const records = JSON.parse(fs.readFileSync(path.join(root, ref), 'utf8')).records.filter(r => r.cli_version.startsWith(`${version} `));
        const observedIs = (r, model) => r.plugin_proof.status === 'NOT_LOADED' && r.roles.length === 2
            && r.roles.every(x => x.match && x.observed.length === 1 && x.observed[0] === model);
        // Controle: o último controle da versão vê o frontmatter (uma execução incerta anterior só
        // conta se foi repetida com «sim» registrado, caso da 2.1.319).
        const controls = records.filter(r => r.candidate === 'control');
        const lastControl = controls[controls.length - 1];
        assert.ok(lastControl && lastControl.result === 'CONTROL_DETECTS_FRONTMATTER' && !lastControl.argv.includes('--agents')
            && observedIs(lastControl, lastControl.models.frontmatter), `${version}: controle negativo`);
        assert.ok(controls.slice(0, -1).every(r => r.result === 'UNCERTAIN') && controls.slice(1).every(r => r.repeat_authorized), `${version}: repetição do controle só com «sim»`);
        // --agents: exatamente as execuções 1 e 2, seguidas, as duas PROOF_OBTAINED, sem falha
        // intercalada nem repetição; observado = declarado nos dois papéis.
        const agents = records.filter(r => r.candidate === 'agents');
        assert.deepStrictEqual([version, agents.map(r => [r.run, r.result])], [version, [[1, 'PROOF_OBTAINED'], [2, 'PROOF_OBTAINED']]]);
        assert.ok(lastControl.at < agents[0].at && agents[0].at < agents[1].at, `${version}: controle antes de agents/1, agents/1 antes de agents/2`);
        for (const r of agents) {
            assert.ok(r.argv.includes('--agents') && observedIs(r, r.models.declared) && r.roles.every(x => x.declared === r.models.declared), `${version}: agents run ${r.run}`);
        }
    }
});

test('AC-27: com subagent_roles e mecanismo verificado → só agentes reproduzíveis redefinidos (ENFORCED de modelo); resto UNENFORCED com causa', () => {
    const p = policy({ subagent_roles: { default: { model_id: 'm-t3', effort: 'alto' }, revisor: { model_id: 'm-t2', effort: 'médio' } } });
    const agents = [
        { name: 'revisor', redefinable: true, definition: { description: 'Revisa', prompt: 'Você revisa.', tools: ['Read'] } },
        { name: 'schema-guardian', redefinable: true, definition: { description: 'Schema', prompt: 'Você guarda.' } },
        { name: 'lista', redefinable: false, cause: 'AGENT_NOT_REPRODUCIBLE' },
        { name: 'Inválido', redefinable: true, definition: { description: 'x', prompt: 'y' } },
    ];
    const mechanism = mr.subagentMechanism('2.1.319');
    const roles = mr.subagentRoles({ snapshot: snapshotOf(p), agents, mechanism });
    assert.deepStrictEqual(roles.roles.map(r => [r.role, r.declared_model, r.enforcement, r.effort_enforcement, r.cause || null]), [
        ['lista', 'm-t3', 'UNENFORCED', 'UNKNOWN', 'AGENT_NOT_REPRODUCIBLE'],
        ['revisor', 'm-t2', 'ENFORCED', 'UNKNOWN', null],
        ['schema-guardian', 'm-t3', 'ENFORCED', 'UNKNOWN', null],
        ['default', 'm-t3', 'UNENFORCED', 'UNKNOWN', 'BUILTIN_NOT_VERIFIED'],
    ]);
    assert.deepStrictEqual(JSON.parse(roles.agentsJson), {
        revisor: { description: 'Revisa', prompt: 'Você revisa.', tools: ['Read'], model: 'm-t2' },
        'schema-guardian': { description: 'Schema', prompt: 'Você guarda.', model: 'm-t3' },
    });
    const r = resolve({ policy: p, signals: SIGNALS, subagentRoles: roles.roles, subagentMechanism: mechanism });
    assert.strictEqual(r.decision.subagent, 'PARTIAL');
    assert.deepStrictEqual(r.decision.subagent_mechanism, mechanism);
    const argv = mr.routedArgs([], r, { agentsJson: roles.agentsJson });
    assert.deepStrictEqual(argv.slice(-2), ['--agents', roles.agentsJson]);
    assert.deepStrictEqual(mr.routedArgs([], r), ['--model', r.decision.chosen.model_id, '--settings', '/run/s.json'], 'sem agentsJson: argv da S4');
    // CLI de outra versão: nada redefinido, sem --agents.
    const off = mr.subagentRoles({ snapshot: snapshotOf(p), agents, mechanism: mr.subagentMechanism('9.9.9') });
    assert.strictEqual(off.agentsJson, null);
    assert.ok(off.roles.every(x => x.enforcement === 'UNENFORCED'));
    // JSON acima do teto do argv: sem --agents, UNENFORCED com causa.
    const big = mr.subagentRoles({ snapshot: snapshotOf(p), agents: [{ name: 'revisor', redefinable: true, definition: { description: 'r', prompt: 'x'.repeat(mr.AGENTS_JSON_MAX_BYTES) } }], mechanism });
    assert.deepStrictEqual([big.agentsJson, big.roles[0].enforcement, big.roles[0].cause], [null, 'UNENFORCED', 'AGENTS_ARG_TOO_LARGE']);
});

test('AC-27: observação pós-saída — observed_model por papel; divergência = SUBAGENT_MODEL_MISMATCH; CONFLICTED não conta', () => {
    const declared = [
        { role: 'revisor', declared_model: 'm-t2', enforcement: 'ENFORCED', observed_model: null },
        { role: 'default', declared_model: 'm-t3', enforcement: 'UNENFORCED', observed_model: null },
    ];
    const obs = mr.observeSubagentRoles(declared, [
        { role: 'revisor', provenance: 'META+TOOL_USE', models: ['m-t2'] },
        { role: 'Explore', provenance: 'META', models: ['m-t1'] },
        { role: 'revisor', provenance: 'CONFLICTED', models: ['m-t1'] },
    ]);
    assert.deepStrictEqual(obs.roles.map(r => [r.role, r.observed_model, r.mismatch, r.finding || null]), [
        ['revisor', 'm-t2', false, null], ['default', 'm-t1', true, 'SUBAGENT_MODEL_MISMATCH'],
    ]);
    assert.strictEqual(obs.unattributed, 1);
});
