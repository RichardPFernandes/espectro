// node --test scripts/lib/classifier-authority.test.js
// PRI-205 S3b T5: Authority Ref do envio ao Jev e núcleo 2 efetivo na admissão
// (SPEC §B2, AC-07), mais a releitura da revogação por Attempt (Q4). Consumidor,
// espelho e policy sintéticos. Nenhum caso bloqueia a admissão: o pior é `off`.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const auth = require('./classifier-authority');
const jevClient = require('./jev-client');
const modelRouting = require('./model-routing');

const tmpBase = process.env.CLAUDE_JOB_DIR ? path.join(process.env.CLAUDE_JOB_DIR, 'tmp') : os.tmpdir();
const roots = [];
test.after(() => { for (const r of roots) fs.rmSync(r, { recursive: true, force: true }); });
const sha = buf => crypto.createHash('sha256').update(buf).digest('hex');
const NOW = '2026-11-06T12:00:00.000Z';
const MIRROR = '.claude/classifier-authority.json';

function authority(overrides = {}) {
    return {
        id: 'jev-envio-2026-10-26',
        issued_by: 'Richard Fernandes',
        issued_at: '2026-10-26',
        source: ['PRI-205 D20 (2026-10-20)', 'PRI-205 U-A1 (2026-10-26)'],
        destination: jevClient.DESTINATION_ID,
        envelope: {
            allow: ['step_text', 'ac_text', 'declared_paths'],
            never: ['code', 'customer_data', 'personal_data', 'secrets', 'credentials'],
        },
        scope: { projects: ['consumidor-sintetico'] },
        valid_from: '2026-10-26T00:00:00.000Z',
        revoked_at: null,
        ...overrides,
    };
}

function jevSection(overrides = {}) {
    return {
        provider: 'jev', mode: 'shadow', model_id: 'jev-latest', timeout_ms: 3000,
        prompt_ref: { id: 'prisma-class-prompt', version: '1', sha256: jevClient.promptSha256() },
        enum_version: jevClient.ENUM_VERSION, destination: jevClient.DESTINATION_ID,
        ...overrides,
    };
}

// Grava o espelho e devolve { root, ref } com o hash dos bytes gravados.
function mirror(content = authority()) {
    const root = fs.mkdtempSync(path.join(tmpBase, 'classifier-authority-'));
    roots.push(root);
    fs.mkdirSync(path.join(root, '.claude'), { recursive: true });
    const bytes = Buffer.from(typeof content === 'string' ? content : JSON.stringify(content, null, 2));
    fs.writeFileSync(path.join(root, MIRROR), bytes);
    return { root, ref: { id: 'jev-envio-2026-10-26', sha256: sha(bytes), path: MIRROR } };
}

function evaluate({ classifier = jevSection(), config, root, project = 'consumidor-sintetico' } = {}) {
    return auth.evaluateClassifier({ classifier, classifierConfig: config, root, project, now: NOW });
}

function okConfig(ref) {
    return { credential: { keychain: 'prisma-jev-typesafe', account: 'typesafe' }, authority_ref: ref, errors: [] };
}

test('tudo válido → jev em sombra, com a ref, a credencial (só nomes) e os parâmetros da seção', () => {
    const { root, ref } = mirror();
    const r = evaluate({ config: okConfig(ref), root });
    assert.deepStrictEqual(r, {
        provider: 'jev', declared: 'jev', mode: 'shadow', reason: null, detail: null,
        authority_ref: { id: ref.id, sha256: ref.sha256, path: MIRROR },
        credential: { keychain: 'prisma-jev-typesafe', account: 'typesafe' },
        model_id: 'jev-latest', timeout_ms: 3000,
        guard_version: require('./classifier-guard').GUARD_VERSION,
    });
});

test('mode active sem calibração → sombra com ACTIVE_NOT_CALIBRATED', () => {
    const { root, ref } = mirror();
    const r = evaluate({ classifier: jevSection({ mode: 'active' }), config: okConfig(ref), root });
    assert.deepStrictEqual([r.provider, r.mode, r.reason], ['jev', 'shadow', 'ACTIVE_NOT_CALIBRATED']);
});

test('provider off ou cheap_rule → null (o snapshot não ganha campo novo)', () => {
    assert.strictEqual(evaluate({ classifier: { provider: 'cheap_rule' } }), null);
    assert.strictEqual(evaluate({ classifier: { provider: 'off' } }), null);
});

const OFF_CASES = [
    ['seção jev incompleta', () => ({ classifier: { provider: 'jev' }, ...withMirror() }), 'CLASSIFIER_SECTION_INVALID'],
    ['referência malformada no config', () => { const m = mirror(); return { config: { ...okConfig(m.ref), errors: ['classifier_credential_invalid'] }, root: m.root }; }, 'CLASSIFIER_CONFIG_INVALID'],
    ['sem referência de credencial', () => { const m = mirror(); return { config: { ...okConfig(m.ref), credential: null }, root: m.root }; }, 'CREDENTIAL_REF_ABSENT'],
    ['sem Authority Ref (hoje)', () => { const m = mirror(); return { config: { ...okConfig(null) }, root: m.root }; }, 'AUTHORITY_REF_ABSENT'],
    ['config ausente', () => ({ config: undefined, root: mirror().root }), 'AUTHORITY_REF_ABSENT'],
    ['espelho ausente', () => { const m = mirror(); fs.rmSync(path.join(m.root, MIRROR)); return { config: okConfig(m.ref), root: m.root }; }, 'AUTHORITY_REF_INVALID'],
    ['hash do espelho divergente', () => { const m = mirror(); return { config: okConfig({ ...m.ref, sha256: 'c'.repeat(64) }), root: m.root }; }, 'AUTHORITY_REF_INVALID'],
    ['espelho não é JSON', () => { const m = mirror('{quebrado'); return { config: okConfig(m.ref), root: m.root }; }, 'AUTHORITY_REF_INVALID'],
    ['id do espelho diferente da ref', () => { const m = mirror(authority({ id: 'outro' })); return { config: okConfig(m.ref), root: m.root }; }, 'AUTHORITY_REF_INVALID'],
    ['campo obrigatório ausente', () => { const a = authority(); delete a.issued_by; const m = mirror(a); return { config: okConfig(m.ref), root: m.root }; }, 'AUTHORITY_REF_INVALID'],
    ['ainda não vigente', () => { const m = mirror(authority({ valid_from: '2027-01-01T00:00:00.000Z' })); return { config: okConfig(m.ref), root: m.root }; }, 'AUTHORITY_REF_INVALID'],
    ['revogada', () => { const m = mirror(authority({ revoked_at: '2026-11-01T00:00:00.000Z' })); return { config: okConfig(m.ref), root: m.root }; }, 'AUTHORITY_REF_REVOKED'],
    ['destino diferente', () => { const m = mirror(authority({ destination: 'outro:/x' })); return { config: okConfig(m.ref), root: m.root }; }, 'AUTHORITY_REF_SCOPE_MISMATCH'],
    ['envelope sem caminhos declarados', () => { const m = mirror(authority({ envelope: { allow: ['step_text', 'ac_text'], never: ['code', 'customer_data', 'personal_data', 'secrets', 'credentials'] } })); return { config: okConfig(m.ref), root: m.root }; }, 'AUTHORITY_REF_SCOPE_MISMATCH'],
    ['envelope sem proibir segredos', () => { const m = mirror(authority({ envelope: { allow: ['step_text', 'ac_text', 'declared_paths'], never: ['code'] } })); return { config: okConfig(m.ref), root: m.root }; }, 'AUTHORITY_REF_SCOPE_MISMATCH'],
    ['projeto fora do escopo', () => ({ ...withMirror(), project: 'outro-consumidor' }), 'AUTHORITY_REF_SCOPE_MISMATCH'],
];

function withMirror() {
    const m = mirror();
    return { config: okConfig(m.ref), root: m.root };
}

for (const [name, setup, reason] of OFF_CASES) {
    test(`${name} → núcleo 2 off com ${reason}`, () => {
        const r = evaluate(setup());
        assert.strictEqual(r.provider, 'off');
        assert.strictEqual(r.declared, 'jev');
        assert.strictEqual(r.reason, reason);
        assert.strictEqual(r.credential, null, 'off nunca carrega a credencial');
    });
}

test('guarda indisponível → off com CONTENT_GUARD_UNAVAILABLE', () => {
    const m = mirror();
    const r = auth.evaluateClassifier({ classifier: jevSection(), classifierConfig: okConfig(m.ref), root: m.root, project: 'consumidor-sintetico', now: NOW, guard: null });
    assert.deepStrictEqual([r.provider, r.reason], ['off', 'CONTENT_GUARD_UNAVAILABLE']);
});

test('nunca lança: entradas quebradas viram off', () => {
    const r = auth.evaluateClassifier({ classifier: jevSection(), classifierConfig: okConfig({ id: 'x', sha256: 'd'.repeat(64), path: MIRROR }), root: '/caminho/que/nao/existe', project: 'p', now: NOW });
    assert.deepStrictEqual([r.provider, r.reason], ['off', 'AUTHORITY_REF_INVALID']);
});

test('Q4: espelho inalterado → segue; revogado depois da admissão → para; mudado ou ausente → para', () => {
    const m = mirror();
    const effective = evaluate({ config: okConfig(m.ref), root: m.root });
    assert.deepStrictEqual(auth.checkStillAuthorized({ root: m.root, effective }), { ok: true });

    fs.writeFileSync(path.join(m.root, MIRROR), JSON.stringify(authority({ revoked_at: '2026-11-06T13:00:00.000Z' })));
    assert.deepStrictEqual(auth.checkStillAuthorized({ root: m.root, effective }), { ok: false, reason: 'AUTHORITY_REF_REVOKED' });

    fs.writeFileSync(path.join(m.root, MIRROR), JSON.stringify(authority({ scope: { projects: ['x'] } })));
    assert.deepStrictEqual(auth.checkStillAuthorized({ root: m.root, effective }), { ok: false, reason: 'AUTHORITY_REF_CHANGED' });

    fs.rmSync(path.join(m.root, MIRROR));
    assert.deepStrictEqual(auth.checkStillAuthorized({ root: m.root, effective }), { ok: false, reason: 'AUTHORITY_REF_CHANGED' });
});

test('Q4: efetivo off não precisa de releitura', () => {
    assert.deepStrictEqual(auth.checkStillAuthorized({ root: '/x', effective: { provider: 'off' } }), { ok: false, reason: 'NUCLEUS2_OFF' });
    assert.deepStrictEqual(auth.checkStillAuthorized({ root: '/x', effective: null }), { ok: false, reason: 'NUCLEUS2_OFF' });
});

// ---- snapshot da Run (buildRoutingSnapshot) ----
function loaded(classifier) {
    const policy = {
        id: 'routing-sintetica', version: 'p-test-1', mode: 'ROUTED', classifier,
        class_to_tier: {
            C1: { tier: 'T1', effort: 'baixo' }, C2: { tier: 'T2', effort: 'médio' }, C3: { tier: 'T2', effort: 'alto' },
            C4: { tier: 'T3', effort: 'alto' }, C5: { tier: 'T3', effort: 'máximo' },
        },
        tiers: { T1: { models: ['m-t1'] }, T2: { models: ['m-t2'] }, T3: { models: ['m-t3'] } },
        default_route: { model_id: 'm-t3', effort: 'alto' },
        effort_map: { baixo: 'low', 'médio': 'medium', alto: 'high', 'máximo': 'max' },
    };
    return { status: 'ON', policy, policy_ref: { id: policy.id, version: policy.version, sha256: 'e'.repeat(64), path: '.claude/p.json' } };
}

test('snapshot: cheap_rule fica byte a byte igual ao da S4; jev ganha classifier_effective no hash', () => {
    const s4 = modelRouting.buildRoutingSnapshot(loaded({ provider: 'cheap_rule' }));
    const same = modelRouting.buildRoutingSnapshot(loaded({ provider: 'cheap_rule' }), { classifierEffective: null });
    assert.deepStrictEqual(same, s4);
    assert.ok(!('classifier_effective' in s4));

    const m = mirror();
    const eff = evaluate({ config: okConfig(m.ref), root: m.root });
    const withJev = modelRouting.buildRoutingSnapshot(loaded(jevSection()), { classifierEffective: eff });
    assert.deepStrictEqual(withJev.classifier_effective, eff);
    assert.deepStrictEqual(modelRouting.snapshotIntegrity(withJev), { ok: true });
    const tampered = { ...withJev, classifier_effective: { ...eff, mode: 'active' } };
    assert.deepStrictEqual(modelRouting.snapshotIntegrity(tampered), { ok: false, detail: 'snapshot_hash_mismatch' });
});
