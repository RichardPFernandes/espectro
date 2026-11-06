// node --test scripts/lib/classifier-selection.test.js
// PRI-205 S3b T10: seletor "Só policy" × "Policy + Jev" (SPEC §B11; R-SEL e Q11–Q14 do
// Richard em 2026-11-06). Registro próprio do consumidor, append-only, fora da policy;
// writer governado com as validações 0–5 do §4.8, na ordem. Consumidor sintético.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const sel = require('./classifier-selection');
const jevClient = require('./jev-client');
const cas = require('../cas');

const tmpBase = process.env.CLAUDE_JOB_DIR ? path.join(process.env.CLAUDE_JOB_DIR, 'tmp') : os.tmpdir();
const roots = [];
test.after(() => { for (const r of roots) fs.rmSync(r, { recursive: true, force: true }); });
const sha = buf => crypto.createHash('sha256').update(buf).digest('hex');
const MIRROR = '.claude/classifier-authority.json';
const NOW = '2026-11-06T12:00:00.000Z';

// Consumidor sintético; com `authority`, grava o espelho e devolve o config com a ref.
function consumer({ authority = false } = {}) {
    const root = fs.mkdtempSync(path.join(tmpBase, 'classifier-selection-'));
    roots.push(root);
    fs.mkdirSync(path.join(root, '.claude'), { recursive: true });
    let config = { credential: { keychain: 'prisma-jev-typesafe', account: 'typesafe' }, authority_ref: null, errors: [] };
    if (authority) {
        const bytes = Buffer.from(JSON.stringify({
            id: 'ref-1', issued_by: 'Richard Fernandes', issued_at: '2026-10-26', source: ['PRI-205 D20'],
            destination: jevClient.DESTINATION_ID,
            envelope: { allow: ['step_text', 'ac_text', 'declared_paths'], never: ['code', 'customer_data', 'personal_data', 'secrets', 'credentials'] },
            scope: { projects: [path.basename(root)] }, valid_from: '2026-10-26T00:00:00.000Z', revoked_at: null,
        }));
        fs.writeFileSync(path.join(root, MIRROR), bytes);
        config = { ...config, authority_ref: { id: 'ref-1', sha256: sha(bytes), path: MIRROR } };
    }
    return { root, config, project: path.basename(root) };
}

function write(c, overrides = {}) {
    return sel.writeSelection(c.root, {
        choice: 'policy_only', expectedVersion: 0, operationId: `op-${crypto.randomUUID()}`, by: 'richard',
        reason: 'teste', project: c.project, classifierConfig: c.config, now: NOW, cas, ...overrides,
    });
}

function refusal(fn) {
    try { fn(); } catch (e) { return { code: e.code, http: e.httpStatus }; }
    return null;
}

const P1 = { provider: 'cheap_rule' };

test('sem registro: versão 0 e vale a policy (AC-15)', () => {
    const c = consumer();
    assert.deepStrictEqual(sel.readSelection(c.root), { ok: true, version: 0, current: null, sha256: null });
    const eff = sel.effectiveClassifier(c.root, { classifier: P1 });
    assert.deepStrictEqual(eff, { classifier: P1, source: 'POLICY', selection_ref: null, reason: null });
});

test('"Só policy" grava provider off, com auditoria completa; o efetivo passa a ser o do registro (AC-15, AC-17)', () => {
    const c = consumer();
    const out = write(c, { reason: 'só núcleo 1' });
    assert.strictEqual(out.status, 'applied');
    const r = sel.readSelection(c.root);
    assert.strictEqual(r.version, 1);
    const v = r.current;
    assert.deepStrictEqual(v.classifier, { provider: 'off' });
    assert.deepStrictEqual([v.version, v.choice, v.by, v.at, v.reason, v.previous_version], [1, 'policy_only', 'richard', NOW, 'só núcleo 1', 0]);
    assert.match(v.payload_sha256, /^[0-9a-f]{64}$/);
    assert.ok(v.operation_id.startsWith('op-'));
    assert.deepStrictEqual(v.checks, { idempotency: 'NEW', version: 'OK', authorization: 'NOT_REQUIRED', calibration: 'NOT_REQUIRED', experiment_lock: 'NO_REGISTRY' });
    const eff = sel.effectiveClassifier(c.root, { classifier: P1 });
    assert.deepStrictEqual([eff.classifier, eff.source, eff.selection_ref.version], [{ provider: 'off' }, 'SELECTION', 1]);
    assert.strictEqual(eff.selection_ref.sha256, r.sha256);
});

test('"Policy + Jev" com Authority Ref grava a seção completa com os parâmetros da plataforma (Q12)', () => {
    const c = consumer({ authority: true });
    write(c, { choice: 'policy_jev' });
    const v = sel.readSelection(c.root).current;
    assert.deepStrictEqual(v.classifier, sel.platformJevSection('shadow'));
    assert.deepStrictEqual(v.classifier.prompt_ref.sha256, jevClient.promptSha256());
    assert.deepStrictEqual([v.mode, v.checks.authorization], ['shadow', 'OK']);
    assert.deepStrictEqual(require('./model-routing-policy').validateClassifierSection(v.classifier), { ok: true });
});

test('ordem 0: mesmo operation_id e mesmo pedido → already_processed sem nova versão; pedido diferente → 409 IDEMPOTENCY_MISMATCH, antes do CAS', () => {
    const c = consumer();
    write(c, { operationId: 'op-fixo-0001' });
    const again = write(c, { operationId: 'op-fixo-0001' });
    assert.strictEqual(again.status, 'already_processed');
    assert.strictEqual(sel.readSelection(c.root).version, 1);
    // expected_version velha (0) E pedido diferente: a idempotência responde primeiro.
    assert.deepStrictEqual(refusal(() => write(c, { operationId: 'op-fixo-0001', reason: 'outro motivo' })), { code: 'CLASSIFIER_IDEMPOTENCY_MISMATCH', http: 409 });
});

test('ordem 1: expected_version diferente da vigente → 409 VERSION_CONFLICT; duas escritas com a mesma versão → só a primeira grava (AC-17)', () => {
    const c = consumer();
    assert.strictEqual(write(c, { expectedVersion: 0 }).status, 'applied');
    assert.deepStrictEqual(refusal(() => write(c, { expectedVersion: 0 })), { code: 'CLASSIFIER_VERSION_CONFLICT', http: 409 });
    assert.deepStrictEqual(refusal(() => write(c, { expectedVersion: 7 })), { code: 'CLASSIFIER_VERSION_CONFLICT', http: 409 });
    assert.strictEqual(sel.readSelection(c.root).version, 1);
});

test('escrita concorrente (trava tomada) → 409 VERSION_CONFLICT, nada gravado', () => {
    const c = consumer();
    fs.mkdirSync(path.dirname(sel.registryPath(c.root)), { recursive: true });
    fs.writeFileSync(`${sel.registryPath(c.root)}.lock`, String(process.pid));
    assert.deepStrictEqual(refusal(() => write(c)), { code: 'CLASSIFIER_VERSION_CONFLICT', http: 409 });
    assert.strictEqual(sel.readSelection(c.root).version, 0);
});

test('ordem 2: "Policy + Jev" sem Authority Ref → 422 SCOPE_NOT_AUTHORIZED com o motivo; "Só policy" não exige', () => {
    const c = consumer();
    const e = (() => { try { write(c, { choice: 'policy_jev' }); } catch (err) { return err; } return null; })();
    assert.deepStrictEqual([e.code, e.httpStatus, e.detail], ['CLASSIFIER_SCOPE_NOT_AUTHORIZED', 422, 'AUTHORITY_REF_ABSENT']);
    assert.strictEqual(sel.readSelection(c.root).version, 0);
    assert.strictEqual(write(c).status, 'applied');
});

test('ordem 3: active sempre 422 NOT_CALIBRATED (não há registro de calibração), mesmo com Authority Ref', () => {
    const c = consumer({ authority: true });
    assert.deepStrictEqual(refusal(() => write(c, { choice: 'policy_jev', mode: 'active' })), { code: 'CLASSIFIER_NOT_CALIBRATED', http: 422 });
    // A autorização é conferida antes: sem ref, a recusa é a da ordem 2.
    const noRef = consumer();
    assert.deepStrictEqual(refusal(() => write(noRef, { choice: 'policy_jev', mode: 'active' })), { code: 'CLASSIFIER_SCOPE_NOT_AUTHORIZED', http: 422 });
});

test('ordem 4: unidade S6 ativa no registro de experimento → 422 LOCKED_BY_EXPERIMENT; sem registro grava NO_REGISTRY', () => {
    const c = consumer();
    fs.mkdirSync(path.join(c.root, 'memory', 'routing'), { recursive: true });
    fs.writeFileSync(path.join(c.root, 'memory', 'routing', 'experiment-units.json'), JSON.stringify({ units: [{ id: 'u1', status: 'ACTIVE' }] }));
    assert.deepStrictEqual(refusal(() => write(c)), { code: 'CLASSIFIER_LOCKED_BY_EXPERIMENT', http: 422 });
    fs.writeFileSync(path.join(c.root, 'memory', 'routing', 'experiment-units.json'), JSON.stringify({ units: [{ id: 'u1', status: 'DONE' }] }));
    assert.strictEqual(write(c).status, 'applied');
    assert.strictEqual(sel.readSelection(c.root).current.checks.experiment_lock, 'NONE_ACTIVE');
});

const BAD_REQUESTS = [
    ['escolha desconhecida', { choice: 'jev_only' }],
    ['mode com "Só policy"', { mode: 'shadow' }],
    ['mode desconhecido', { choice: 'policy_jev', mode: 'ligado' }],
    ['expected_version negativa', { expectedVersion: -1 }],
    ['operation_id curto', { operationId: 'x' }],
    ['sem autor', { by: '' }],
    ['sem motivo', { reason: '   ' }],
    ['motivo longo demais', { reason: 'x'.repeat(501) }],
];
for (const [name, overrides] of BAD_REQUESTS) {
    test(`pedido inválido (${name}) → 400 REQUEST_INVALID, nada gravado`, () => {
        const c = consumer();
        assert.deepStrictEqual(refusal(() => write(c, overrides)), { code: 'CLASSIFIER_REQUEST_INVALID', http: 400 });
        assert.strictEqual(sel.readSelection(c.root).version, 0);
    });
}

test('append-only: cada troca é uma versão nova com previous_version; o histórico não muda', () => {
    const c = consumer({ authority: true });
    write(c, { expectedVersion: 0 });
    const v1 = JSON.stringify(sel.readSelection(c.root).current);
    write(c, { choice: 'policy_jev', expectedVersion: 1 });
    write(c, { expectedVersion: 2, reason: 'voltar a só policy' });
    const reg = JSON.parse(fs.readFileSync(sel.registryPath(c.root), 'utf8'));
    assert.deepStrictEqual(reg.versions.map(v => [v.version, v.choice, v.previous_version]), [[1, 'policy_only', 0], [2, 'policy_jev', 1], [3, 'policy_only', 2]]);
    assert.strictEqual(JSON.stringify(reg.versions[0]), v1);
    assert.strictEqual(reg.current_version, 3);
});

test('registro quebrado → leitura inválida e efetivo off com CLASSIFIER_SELECTION_INVALID; writer recusa sem sobrescrever', () => {
    const c = consumer();
    fs.mkdirSync(path.dirname(sel.registryPath(c.root)), { recursive: true });
    fs.writeFileSync(sel.registryPath(c.root), '{quebrado');
    assert.strictEqual(sel.readSelection(c.root).ok, false);
    const eff = sel.effectiveClassifier(c.root, { classifier: P1 });
    assert.deepStrictEqual([eff.classifier, eff.source, eff.reason], [{ provider: 'off' }, 'INVALID', 'CLASSIFIER_SELECTION_INVALID']);
    assert.deepStrictEqual(refusal(() => write(c)), { code: 'CLASSIFIER_SELECTION_INVALID', http: 409 });
    assert.strictEqual(fs.readFileSync(sel.registryPath(c.root), 'utf8'), '{quebrado');
});

test('preview para a UI: opções com allowed e o código previsto, sem gravar nada', () => {
    const c = consumer();
    const p = sel.previewOptions(c.root, { project: c.project, classifierConfig: c.config, now: NOW });
    assert.deepStrictEqual(p, [
        { choice: 'policy_only', allowed: true, refusal: null, detail: null },
        { choice: 'policy_jev', modes: {
            shadow: { allowed: false, refusal: 'CLASSIFIER_SCOPE_NOT_AUTHORIZED', detail: 'AUTHORITY_REF_ABSENT' },
            active: { allowed: false, refusal: 'CLASSIFIER_SCOPE_NOT_AUTHORIZED', detail: 'AUTHORITY_REF_ABSENT' },
        } },
    ]);
    const ok = consumer({ authority: true });
    const q = sel.previewOptions(ok.root, { project: ok.project, classifierConfig: ok.config, now: NOW });
    assert.deepStrictEqual(q[1].modes, {
        shadow: { allowed: true, refusal: null, detail: null },
        active: { allowed: false, refusal: 'CLASSIFIER_NOT_CALIBRATED', detail: null },
    });
    assert.ok(!fs.existsSync(sel.registryPath(c.root)));
});

test('.gitignore: o registro deve ficar fora do git (Q11); conferido sem ler dados', () => {
    const c = consumer();
    assert.strictEqual(sel.registryGitIgnored(c.root), false);
    fs.writeFileSync(path.join(c.root, '.gitignore'), 'node_modules/\nmemory/routing/\n');
    assert.strictEqual(sel.registryGitIgnored(c.root), true);
    fs.writeFileSync(path.join(c.root, '.gitignore'), '/memory\n');
    assert.strictEqual(sel.registryGitIgnored(c.root), true);
});

test('cas é obrigatório: sem ele o writer não roda (a comparação de versão mora em scripts/cas.js)', () => {
    const c = consumer();
    assert.throws(() => sel.writeSelection(c.root, { choice: 'policy_only', expectedVersion: 0, operationId: 'op-sem-cas-1', by: 'r', reason: 'x', project: c.project }), /cas/);
});
