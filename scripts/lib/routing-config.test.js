// node --test scripts/lib/routing-config.test.js
// PRI-233 (PRI-205 S4) T2: `routing` do consumidor e policy para mode ON.
//
// readRoutingConfig(root) lê `.claude/model-routing.json` do consumidor e, só com
// mode ON, a policy referenciada (presença, sha256 aprovado, envelope roteado).
// Status: OFF (ausente ou OFF declarado), ON (válido) ou INVALID (bloqueia o escopo,
// AC-04). Falha de leitura transitória é marcada `transient` (diretriz R-6 n.º 6).
// Policy, ids de modelo e consumidor são sintéticos.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const policyLoader = require('./model-routing-policy');

const tmpBase = process.env.CLAUDE_JOB_DIR ? path.join(process.env.CLAUDE_JOB_DIR, 'tmp') : os.tmpdir();
const roots = [];
test.after(() => { for (const r of roots) fs.rmSync(r, { recursive: true, force: true }); });

const sha = buf => crypto.createHash('sha256').update(buf).digest('hex');

function routedPolicy(overrides = {}) {
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
            T1: { models: ['modelo-ficticio-t1'] },
            T2: { models: ['modelo-ficticio-t2a', 'modelo-ficticio-t2b'] },
            T3: { models: ['modelo-ficticio-t3'] },
        },
        default_route: { model_id: 'modelo-ficticio-t3', effort: 'alto' },
        effort_map: { baixo: 'low', 'médio': 'medium', alto: 'high', 'máximo': 'max' },
        ...overrides,
    };
}

// Consumidor sintético. `policy` vira bytes em .claude/routing-policy.json; `routing`
// vira .claude/model-routing.json. sha256 do policy_ref = sha dos bytes gravados,
// salvo override explícito.
function consumer({ routing, policy, policyBytes, refOverrides = {} } = {}) {
    const root = fs.mkdtempSync(path.join(tmpBase, 'routing-config-'));
    roots.push(root);
    fs.mkdirSync(path.join(root, '.claude'), { recursive: true });
    let bytes = null;
    if (policyBytes != null) bytes = Buffer.from(policyBytes);
    else if (policy) bytes = Buffer.from(JSON.stringify(policy, null, 2));
    if (bytes) fs.writeFileSync(path.join(root, '.claude', 'routing-policy.json'), bytes);
    if (routing !== undefined) {
        const body = typeof routing === 'string' ? routing : JSON.stringify(
            routing.mode === 'ON' && !('policy_ref' in routing)
                ? {
                    ...routing,
                    policy_ref: {
                        id: 'routing-sintetica', version: 'p-test-1',
                        sha256: bytes ? sha(bytes) : '0'.repeat(64),
                        path: '.claude/routing-policy.json',
                        ...refOverrides,
                    },
                }
                : routing,
        );
        fs.writeFileSync(path.join(root, '.claude', 'model-routing.json'), body);
    }
    return root;
}

test('routing ausente → OFF, sem ler policy', () => {
    const root = consumer({ policyBytes: '{ isto não é json' });
    const r = policyLoader.readRoutingConfig(root);
    assert.deepStrictEqual(r, { status: 'OFF', source: 'absent' });
});

test('mode OFF declarado → OFF, mesmo com policy_ref quebrado', () => {
    const root = consumer({ routing: { mode: 'OFF', policy_ref: { path: '../../fora' } } });
    assert.deepStrictEqual(policyLoader.readRoutingConfig(root), { status: 'OFF', source: 'declared' });
});

test('arquivo de routing sem campo mode → OFF (mode ausente = OFF)', () => {
    const root = consumer({ routing: {} });
    assert.deepStrictEqual(policyLoader.readRoutingConfig(root), { status: 'OFF', source: 'declared' });
});

test('mode ON com policy válida → ON com policy_ref e hash conferidos', () => {
    const policy = routedPolicy();
    const root = consumer({ routing: { mode: 'ON' }, policy });
    const r = policyLoader.readRoutingConfig(root);
    assert.strictEqual(r.status, 'ON', JSON.stringify(r));
    assert.strictEqual(r.policy.id, 'routing-sintetica');
    assert.strictEqual(r.policy_hash, sha(fs.readFileSync(path.join(root, '.claude', 'routing-policy.json'))));
    assert.deepStrictEqual(r.policy_ref, {
        id: 'routing-sintetica', version: 'p-test-1', sha256: r.policy_hash, path: '.claude/routing-policy.json',
    });
});

// Cada caso: status INVALID com a causa e o detalhe exatos, e transient=false.
const INVALID_CASES = [
    ['JSON de routing ilegível', { routing: '{ quebrado' }, 'ROUTING_CONFIG_INVALID', /^json_parse:/],
    ['mode malformado', { routing: { mode: 'on' } }, 'ROUTING_CONFIG_INVALID', /^mode_malformed$/],
    ['mode ON sem policy_ref', { routing: { mode: 'ON', policy_ref: null } }, 'ROUTING_CONFIG_INVALID', /^policy_ref_invalid$/],
    ['policy_ref.sha256 fora do formato', { routing: { mode: 'ON' }, policy: routedPolicy(), refOverrides: { sha256: 'abc' } }, 'ROUTING_CONFIG_INVALID', /^policy_ref_invalid$/],
    ['policy_ref.path fora da raiz', { routing: { mode: 'ON' }, policy: routedPolicy(), refOverrides: { path: '../fora.json' } }, 'ROUTING_CONFIG_INVALID', /^policy_path_outside_root$/],
    ['policy_ref.path absoluto', { routing: { mode: 'ON' }, policy: routedPolicy(), refOverrides: { path: '/etc/hosts' } }, 'ROUTING_CONFIG_INVALID', /^policy_path_outside_root$/],
    ['policy ausente', { routing: { mode: 'ON' } }, 'POLICY_MISSING', /^not_found$/],
    ['hash divergente do aprovado', { routing: { mode: 'ON' }, policy: routedPolicy(), refOverrides: { sha256: 'f'.repeat(64) } }, 'POLICY_HASH_MISMATCH', /^expected:f{64}$/],
    ['versão divergente do policy_ref', { routing: { mode: 'ON' }, policy: routedPolicy(), refOverrides: { version: 'p-test-0' } }, 'POLICY_INVALID', /^version_mismatch$/],
    ['id divergente do policy_ref', { routing: { mode: 'ON' }, policy: routedPolicy(), refOverrides: { id: 'outra' } }, 'POLICY_INVALID', /^id_mismatch$/],
    ['policy JSON quebrado', { routing: { mode: 'ON' }, policyBytes: '{ x' }, 'POLICY_INVALID', /^json_parse:/],
    ['policy de sombra usada para rotear', { routing: { mode: 'ON' }, policy: routedPolicy({ mode: 'SHADOW' }) }, 'POLICY_INVALID', /^mode_not_routed$/],
    ['modelo UNAVAILABLE em tier', { routing: { mode: 'ON' }, policy: routedPolicy({ tiers: { T1: { models: ['UNAVAILABLE'] }, T2: { models: ['m2'] }, T3: { models: ['modelo-ficticio-t3'] } } }) }, 'POLICY_INVALID', /^tier_model_unavailable:T1$/],
    ['default_route UNAVAILABLE', { routing: { mode: 'ON' }, policy: routedPolicy({ default_route: { model_id: 'UNAVAILABLE', effort: 'alto' } }) }, 'POLICY_INVALID', /^default_route_invalid$/],
    ['default_route fora do T3', { routing: { mode: 'ON' }, policy: routedPolicy({ default_route: { model_id: 'modelo-ficticio-t1', effort: 'alto' } }) }, 'POLICY_INVALID', /^default_route_not_t3$/],
    ['effort_map sem um esforço usado', { routing: { mode: 'ON' }, policy: routedPolicy({ effort_map: { baixo: 'low', 'médio': 'medium', alto: 'high' } }) }, 'POLICY_INVALID', /^effort_map_missing:máximo$/],
    ['effort_map com valor fora do CLI', { routing: { mode: 'ON' }, policy: routedPolicy({ effort_map: { baixo: 'low', 'médio': 'medium', alto: 'high', 'máximo': 'ultra' } }) }, 'POLICY_INVALID', /^effort_map_value_invalid:máximo$/],
    ['class_to_tier incompleto', { routing: { mode: 'ON' }, policy: routedPolicy({ class_to_tier: { C1: { tier: 'T1', effort: 'baixo' } } }) }, 'POLICY_INVALID', /^class_to_tier_invalid$/],
    ['provider desconhecido', { routing: { mode: 'ON' }, policy: routedPolicy({ classifier: { provider: 'oraculo' } }) }, 'POLICY_INVALID', /^classifier_provider_unsupported:oraculo$/],
];

for (const [name, setup, cause, detail] of INVALID_CASES) {
    test(`mode ON inválido: ${name} → INVALID/${cause}`, () => {
        const r = policyLoader.readRoutingConfig(consumer(setup));
        assert.strictEqual(r.status, 'INVALID', JSON.stringify(r));
        assert.strictEqual(r.cause, cause, JSON.stringify(r));
        assert.match(r.detail, detail);
        assert.strictEqual(r.transient, false);
        assert.strictEqual(r.policy, undefined, 'policy inválida nunca é devolvida para uso');
    });
}

test('NITs da revisão: json_parse não vaza conteúdo; nome começando com ".." é aceito', () => {
    const leak = policyLoader.readRoutingConfig(consumer({ routing: '{ "segredo-do-arquivo": ' }));
    assert.strictEqual(leak.detail, 'json_parse:SyntaxError');
    const root = consumer({ routing: { mode: 'ON' }, policy: routedPolicy() });
    const bytes = fs.readFileSync(path.join(root, '.claude', 'routing-policy.json'));
    fs.writeFileSync(path.join(root, '..policy.json'), bytes);
    fs.writeFileSync(path.join(root, '.claude', 'model-routing.json'), JSON.stringify({ mode: 'ON', policy_ref: {
        id: 'routing-sintetica', version: 'p-test-1', sha256: sha(bytes), path: '..policy.json',
    } }));
    assert.strictEqual(policyLoader.readRoutingConfig(root).status, 'ON');
});

test('classifier jev não invalida a policy roteada (A4: a admissão decide o efetivo)', () => {
    const root = consumer({ routing: { mode: 'ON' }, policy: routedPolicy({ classifier: { provider: 'jev' } }) });
    assert.strictEqual(policyLoader.readRoutingConfig(root).status, 'ON');
});

test('leitura transitória da policy (EIO) ≠ hash divergente: INVALID com transient=true', () => {
    const root = consumer({ routing: { mode: 'ON' }, policy: routedPolicy() });
    const realRead = fs.readFileSync;
    const readFile = (p, ...rest) => {
        if (String(p).endsWith('routing-policy.json')) throw Object.assign(new Error('falha de E/S simulada'), { code: 'EIO' });
        return realRead(p, ...rest);
    };
    const r = policyLoader.readRoutingConfig(root, { readFile });
    assert.deepStrictEqual([r.status, r.cause, r.transient], ['INVALID', 'POLICY_UNREADABLE', true]);
});

test('leitura transitória do arquivo de routing (EBUSY): INVALID com transient=true', () => {
    const root = consumer({ routing: { mode: 'ON' }, policy: routedPolicy() });
    const realRead = fs.readFileSync;
    const readFile = (p, ...rest) => {
        if (String(p).endsWith('model-routing.json')) throw Object.assign(new Error('ocupado'), { code: 'EBUSY' });
        return realRead(p, ...rest);
    };
    const r = policyLoader.readRoutingConfig(root, { readFile });
    assert.deepStrictEqual([r.status, r.cause, r.transient], ['INVALID', 'ROUTING_CONFIG_UNREADABLE', true]);
});

test('link simbólico da policy para fora da raiz → policy_path_outside_root', () => {
    const outside = fs.mkdtempSync(path.join(tmpBase, 'routing-config-fora-'));
    roots.push(outside);
    const bytes = Buffer.from(JSON.stringify(routedPolicy()));
    fs.writeFileSync(path.join(outside, 'p.json'), bytes);
    const root = consumer({ routing: { mode: 'ON' }, refOverrides: { sha256: sha(bytes), path: '.claude/link.json' } });
    fs.symlinkSync(path.join(outside, 'p.json'), path.join(root, '.claude', 'link.json'));
    const r = policyLoader.readRoutingConfig(root);
    assert.deepStrictEqual([r.status, r.cause, r.detail], ['INVALID', 'ROUTING_CONFIG_INVALID', 'policy_path_outside_root']);
});

test('caminho sombra da S3 inalterado: policy default carrega e mode ON na policy continua INVALID', () => {
    const shadow = policyLoader.loadPolicy();
    assert.strictEqual(shadow.status, 'LOADED');
    assert.strictEqual(shadow.policy.mode, 'SHADOW');
    const routed = policyLoader.loadPolicy({ json: routedPolicy() });
    assert.deepStrictEqual([routed.status, routed.detail], ['INVALID', 'mode_not_shadow']);
    const jev = policyLoader.loadPolicy({ json: { ...JSON.parse(fs.readFileSync(policyLoader.DEFAULT_POLICY_PATH, 'utf8')), classifier: { provider: 'jev' } } });
    assert.deepStrictEqual([jev.status, jev.detail], ['INVALID', 'classifier_provider_jev_blocked']);
});

// ---- PRI-205 S3b T4: seção classifier do jev e referências do núcleo 2 no config ----
// Nada do núcleo 2 bloqueia a admissão (SPEC §B2): seção jev incompleta, credencial
// ou Authority Ref malformadas deixam a policy válida e o núcleo 2 off, com o motivo.
const jevClient = require('./jev-client');

function jevSection(overrides = {}) {
    return {
        provider: 'jev',
        mode: 'shadow',
        model_id: 'jev-latest',
        timeout_ms: 3000,
        prompt_ref: { id: 'prisma-class-prompt', version: '1', sha256: jevClient.promptSha256() },
        enum_version: jevClient.ENUM_VERSION,
        destination: jevClient.DESTINATION_ID,
        ...overrides,
    };
}

test('T4: validateClassifierSection aceita a seção jev completa e ignora off/cheap_rule', () => {
    assert.deepStrictEqual(policyLoader.validateClassifierSection(jevSection()), { ok: true });
    assert.deepStrictEqual(policyLoader.validateClassifierSection({ provider: 'cheap_rule' }), { ok: true });
    assert.deepStrictEqual(policyLoader.validateClassifierSection({ provider: 'off' }), { ok: true });
});

const SECTION_CASES = [
    ['provider jev sem mais nada', { provider: 'jev' }, 'classifier_mode_invalid'],
    ['mode desconhecido', jevSection({ mode: 'ligado' }), 'classifier_mode_invalid'],
    ['sem model_id', jevSection({ model_id: '' }), 'classifier_model_missing'],
    ['timeout acima de 5000', jevSection({ timeout_ms: 5001 }), 'classifier_timeout_invalid'],
    ['timeout não inteiro', jevSection({ timeout_ms: 2.5 }), 'classifier_timeout_invalid'],
    ['prompt_ref sem sha', jevSection({ prompt_ref: { id: 'x', version: '1' } }), 'classifier_prompt_ref_invalid'],
    ['prompt de outra versão', jevSection({ prompt_ref: { id: 'x', version: '1', sha256: 'a'.repeat(64) } }), 'classifier_prompt_mismatch'],
    ['enum de outra versão', jevSection({ enum_version: 'prisma-class-c1c5@0' }), 'classifier_enum_mismatch'],
    ['destino diferente', jevSection({ destination: 'typesafe:/v2/outro' }), 'classifier_destination_mismatch'],
    ['provider desconhecido', { provider: 'haiku' }, 'classifier_provider_unsupported:haiku'],
];
for (const [name, section, detail] of SECTION_CASES) {
    test(`T4: validateClassifierSection recusa ${name} → ${detail}`, () => {
        assert.deepStrictEqual(policyLoader.validateClassifierSection(section), { ok: false, detail });
    });
}

test('T4: seção jev incompleta continua deixando a policy roteada válida (não bloqueia a admissão)', () => {
    const root = consumer({ routing: { mode: 'ON' }, policy: routedPolicy({ classifier: { provider: 'jev', mode: 'shadow' } }) });
    assert.strictEqual(policyLoader.readRoutingConfig(root).status, 'ON');
});

test('T4: config sem referências do núcleo 2 → classifier_config vazio, sem erro', () => {
    const root = consumer({ routing: { mode: 'ON' }, policy: routedPolicy() });
    const r = policyLoader.readRoutingConfig(root);
    assert.deepStrictEqual(r.classifier_config, { credential: null, authority_ref: null, errors: [] });
});

test('T4: credencial e Authority Ref válidas são lidas só como nomes e referência', () => {
    const authority_ref = { id: 'jev-envio-2026-10-26', sha256: 'b'.repeat(64), path: '.claude/classifier-authority.json' };
    const root = consumer({
        routing: { mode: 'ON', classifier_credential: { keychain: 'prisma-jev-typesafe', account: 'typesafe' }, authority_ref },
        policy: routedPolicy({ classifier: jevSection() }),
    });
    const r = policyLoader.readRoutingConfig(root);
    assert.strictEqual(r.status, 'ON');
    assert.deepStrictEqual(r.classifier_config, {
        credential: { keychain: 'prisma-jev-typesafe', account: 'typesafe' },
        authority_ref,
        errors: [],
    });
});

const CONFIG_CASES = [
    ['credencial com valor literal', { classifier_credential: { keychain: 'prisma-jev-typesafe', account: 'typesafe', value: 'x' } }, 'classifier_credential_invalid'],
    ['credencial com campo de senha', { classifier_credential: { keychain: 'prisma-jev-typesafe', password: 'x' } }, 'classifier_credential_invalid'],
    ['credencial como string', { classifier_credential: 'chave' }, 'classifier_credential_invalid'],
    ['nome de item com espaço', { classifier_credential: { keychain: 'prisma jev', account: 'typesafe' } }, 'classifier_credential_invalid'],
    ['authority_ref sem sha', { authority_ref: { id: 'x', path: '.claude/a.json' } }, 'authority_ref_invalid'],
    ['authority_ref fora da raiz', { authority_ref: { id: 'x', sha256: 'b'.repeat(64), path: '../a.json' } }, 'authority_ref_path_outside_root'],
    ['authority_ref absoluto', { authority_ref: { id: 'x', sha256: 'b'.repeat(64), path: '/etc/a.json' } }, 'authority_ref_path_outside_root'],
];
for (const [name, extra, detail] of CONFIG_CASES) {
    test(`T4: ${name} → núcleo 2 com erro ${detail}, sem bloquear a admissão nem ecoar o valor`, () => {
        const root = consumer({ routing: { mode: 'ON', ...extra }, policy: routedPolicy({ classifier: jevSection() }) });
        const r = policyLoader.readRoutingConfig(root);
        assert.strictEqual(r.status, 'ON');
        assert.ok(r.classifier_config.errors.includes(detail), JSON.stringify(r.classifier_config.errors));
        assert.ok(!JSON.stringify(r.classifier_config).includes('"x"'));
        if (detail.startsWith('classifier_credential')) assert.strictEqual(r.classifier_config.credential, null);
        else assert.strictEqual(r.classifier_config.authority_ref, null);
    });
}
