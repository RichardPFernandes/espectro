// node --test scripts/lib/routing-pilot-policy.test.js
// PRI-341 T2: policy de piloto routing-pri205@p2-pilot-2026-11-16 (arquivo real do repositório).
// A raiz de consumidor é sintética e temporária; nada é lido de outro projeto. Este teste não
// liga nada no consumidor: a policy só vale num consumidor cujo .claude/model-routing.json aponte para ela (T6).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const policyLoader = require('./model-routing-policy');

const POLICY_REL = path.join('.claude', 'model-routing-policy.json');
const POLICY_FILE = path.join(__dirname, '..', '..', POLICY_REL);
// Fixado: mudar um byte da policy exige versão nova (policy_ref é por sha256).
const PINNED_SHA256 = '37fcbf0b2b017de3f6ee60f611d93ea60f7e278d472bd02c4402262d16f8bce4';

const tmpBase = process.env.CLAUDE_JOB_DIR ? path.join(process.env.CLAUDE_JOB_DIR, 'tmp') : os.tmpdir();
const roots = [];
test.after(() => { for (const r of roots) fs.rmSync(r, { recursive: true, force: true }); });

const bytes = fs.readFileSync(POLICY_FILE);
const sha = crypto.createHash('sha256').update(bytes).digest('hex');
const policy = JSON.parse(bytes.toString('utf8'));

function consumerRoot(config) {
    fs.mkdirSync(tmpBase, { recursive: true });
    const root = fs.mkdtempSync(path.join(tmpBase, 'pilot-policy-'));
    roots.push(root);
    fs.mkdirSync(path.join(root, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(root, POLICY_REL), bytes);
    fs.writeFileSync(path.join(root, '.claude', 'model-routing.json'), JSON.stringify(config));
    return root;
}
const ref = { id: 'routing-pri205', version: 'p2-pilot-2026-11-16', sha256: sha, path: POLICY_REL };

test('o arquivo da policy tem o sha256 fixado', () => {
    assert.strictEqual(sha, PINNED_SHA256);
});

test('id e versão aprovados (Q2) e envelope roteado válido', () => {
    assert.deepStrictEqual([policy.id, policy.version], ['routing-pri205', 'p2-pilot-2026-11-16']);
    assert.deepStrictEqual(policyLoader.validateRoutedPolicy(policy).ok, true);
});

test('Q4: valores iguais aos da p1-2026-11-06 (sem alteração)', () => {
    assert.deepStrictEqual(policy.class_to_tier, {
        C1: { tier: 'T1', effort: 'baixo' }, C2: { tier: 'T2', effort: 'médio' },
        C3: { tier: 'T3', effort: 'alto' }, C4: { tier: 'T3', effort: 'alto' }, C5: { tier: 'T3', effort: 'máximo' },
    });
    assert.deepStrictEqual(policy.tiers, {
        T1: { models: ['claude-sonnet-5-5'] }, T2: { models: ['claude-sonnet-5-5'] }, T3: { models: ['claude-opus-5-5'] },
    });
    assert.deepStrictEqual(policy.default_route, { model_id: 'claude-opus-5-5', effort: 'alto' });
    assert.deepStrictEqual(policy.effort_map, { baixo: 'low', médio: 'medium', alto: 'high', máximo: 'max' });
    assert.strictEqual(policy.effort_applied, false);
    assert.deepStrictEqual(policy.classifier, { provider: 'cheap_rule' });
});

test('Q9: seções de decomposição, com o subagente default igual ao default_route (AC-4)', () => {
    assert.deepStrictEqual(policyLoader.decompositionSections(policy), {
        subagent_roles: { default: { model_id: 'claude-opus-5-5', effort: 'alto' } },
        manifest_limits: { maxEntries: 20000, maxBytes: 268435456 },
        workspace_watch_globs: ['.env', '.env.*'],
    });
    assert.deepStrictEqual(policy.subagent_roles.default, policy.default_route);
});

test('consumidor com mode ON e decomposition ausente ou off: admitido com a policy', () => {
    for (const extra of [{}, { decomposition: 'off' }]) {
        const r = policyLoader.readRoutingConfig(consumerRoot({ mode: 'ON', policy_ref: ref, ...extra }));
        assert.strictEqual(r.status, 'ON');
        assert.deepStrictEqual([r.policy_ref.id, r.policy_ref.version, r.policy_hash], ['routing-pri205', 'p2-pilot-2026-11-16', sha]);
    }
});

test('PR-B: decomposition "on" é admitida com a policy do piloto e o resultado traz decomposition "on"', () => {
    const r = policyLoader.readRoutingConfig(consumerRoot({ mode: 'ON', policy_ref: ref, decomposition: 'on' }));
    assert.deepStrictEqual([r.status, r.decomposition, r.policy_ref.version], ['ON', 'on', 'p2-pilot-2026-11-16']);
});

test('PR-B: "off" e ausente não trazem o campo decomposition no resultado (S4 intacta)', () => {
    for (const extra of [{}, { decomposition: 'off' }]) {
        const r = policyLoader.readRoutingConfig(consumerRoot({ mode: 'ON', policy_ref: ref, ...extra }));
        assert.ok(!('decomposition' in r));
    }
});

test('PR-B: "on" com policy sem subagent_roles (como a p1 do app-back) é recusada, fail-closed', () => {
    const noRoles = JSON.parse(bytes.toString('utf8'));
    delete noRoles.subagent_roles;
    const b = Buffer.from(JSON.stringify(noRoles));
    fs.mkdirSync(tmpBase, { recursive: true });
    const root = fs.mkdtempSync(path.join(tmpBase, 'pilot-policy-noroles-'));
    roots.push(root);
    fs.mkdirSync(path.join(root, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(root, POLICY_REL), b);
    const pref = { ...ref, sha256: crypto.createHash('sha256').update(b).digest('hex') };
    fs.writeFileSync(path.join(root, '.claude', 'model-routing.json'), JSON.stringify({ mode: 'ON', policy_ref: pref, decomposition: 'on' }));
    const on = policyLoader.readRoutingConfig(root);
    assert.deepStrictEqual([on.status, on.cause, on.detail], ['INVALID', 'POLICY_INVALID', 'decomposition_requires_subagent_roles']);
    // AC-6: a mesma policy, sem a chave decomposition (caso do app-back hoje), é admitida como antes.
    fs.writeFileSync(path.join(root, '.claude', 'model-routing.json'), JSON.stringify({ mode: 'ON', policy_ref: pref }));
    const off = policyLoader.readRoutingConfig(root);
    assert.strictEqual(off.status, 'ON');
    assert.ok(!('decomposition' in off));
});

test('PR-B: a recusa por falta de subagent_roles vem depois das checagens da policy (id errado → id_mismatch)', () => {
    const bad = JSON.parse(bytes.toString('utf8'));
    delete bad.subagent_roles;
    bad.id = 'outra-policy';
    const b = Buffer.from(JSON.stringify(bad));
    fs.mkdirSync(tmpBase, { recursive: true });
    const root = fs.mkdtempSync(path.join(tmpBase, 'pilot-policy-order-'));
    roots.push(root);
    fs.mkdirSync(path.join(root, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(root, POLICY_REL), b);
    fs.writeFileSync(path.join(root, '.claude', 'model-routing.json'),
        JSON.stringify({ mode: 'ON', policy_ref: { ...ref, sha256: crypto.createHash('sha256').update(b).digest('hex') }, decomposition: 'on' }));
    const r = policyLoader.readRoutingConfig(root);
    assert.deepStrictEqual([r.cause, r.detail], ['POLICY_INVALID', 'id_mismatch']);
});

test('sha256 errado no policy_ref → POLICY_HASH_MISMATCH', () => {
    const r = policyLoader.readRoutingConfig(consumerRoot({ mode: 'ON', policy_ref: { ...ref, sha256: '0'.repeat(64) } }));
    assert.deepStrictEqual([r.status, r.cause], ['INVALID', 'POLICY_HASH_MISMATCH']);
});

test('admissão: policy com subagent_roles.default divergente é recusada pelo caminho de admissão (POLICY_INVALID)', () => {
    const bad = JSON.parse(bytes.toString('utf8'));
    bad.subagent_roles.default = { model_id: 'claude-sonnet-5-5', effort: 'alto' };
    const badBytes = Buffer.from(JSON.stringify(bad));
    fs.mkdirSync(tmpBase, { recursive: true });
    const root = fs.mkdtempSync(path.join(tmpBase, 'pilot-policy-bad-'));
    roots.push(root);
    fs.mkdirSync(path.join(root, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(root, POLICY_REL), badBytes);
    fs.writeFileSync(path.join(root, '.claude', 'model-routing.json'),
        JSON.stringify({ mode: 'ON', policy_ref: { ...ref, sha256: crypto.createHash('sha256').update(badBytes).digest('hex') } }));
    const r = policyLoader.readRoutingConfig(root);
    assert.deepStrictEqual([r.status, r.cause, r.detail], ['INVALID', 'POLICY_INVALID', 'subagent_default_model_differs_from_default_route']);
});
