// node --require ./harness/loopback-only.cjs --test scripts/lib/classifier-shadow.test.js
// PRI-205 S3b T6: orquestração do núcleo 2 em sombra com Attempt de efeito
// (SPEC §B6, §B7; AC-05, AC-08 a AC-11). Cliente do Jev falso (roteiro) ou o
// cliente real contra um fake HTTP em 127.0.0.1. Nada aqui muda o despacho.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('node:http');
const crypto = require('crypto');
const shadow = require('./classifier-shadow');
const dom06 = require('./dom06-attempt');
const jevClient = require('./jev-client');

const tmpBase = process.env.CLAUDE_JOB_DIR ? path.join(process.env.CLAUDE_JOB_DIR, 'tmp') : os.tmpdir();
const dirs = [];
test.after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });
const KEY = 'chave-falsa-' + 'shadow-0001';
const MIRROR = '.claude/classifier-authority.json';

function sig(overrides = {}) {
    return {
        n_files: 2, kind: 'code', code_local: true, n_new_files: 1, n_acs_step: 2,
        sensitive_decl: false, schema_decl: false, n_services_decl: 1, rework_count: 0, ticket_rework: false,
        ...overrides,
    };
}
const GRAY = sig({ n_files: 3, n_new_files: 2, n_acs_step: 4 }); // G2, C4
const PROBE = sig(); // G3, C2

function group(key, signals, envelope = {}) {
    return {
        subtask_key: key, signals, plan_class: null,
        envelope: { step_text: `Passo ${key} em backend/svc-a/src/${key}.js`, ac_texts: ['AC-01: o total aparece'], declared_paths: [`backend/svc-a/src/${key}.js`], ...envelope },
    };
}

// Consumidor sintético com o espelho da Authority Ref e o snapshot já decidido.
function setup() {
    const root = fs.mkdtempSync(path.join(tmpBase, 'classifier-shadow-'));
    dirs.push(root);
    fs.mkdirSync(path.join(root, '.claude'), { recursive: true });
    const bytes = Buffer.from(JSON.stringify({ id: 'ref-1', revoked_at: null }));
    fs.writeFileSync(path.join(root, MIRROR), bytes);
    const runDir = path.join(root, 'memory', 'runs', '205-x');
    fs.mkdirSync(runDir, { recursive: true });
    const effective = {
        provider: 'jev', declared: 'jev', mode: 'shadow', reason: null, detail: null,
        authority_ref: { id: 'ref-1', sha256: crypto.createHash('sha256').update(bytes).digest('hex'), path: MIRROR },
        credential: { keychain: 'prisma-jev-typesafe', account: 'typesafe' },
        model_id: 'jev-latest', timeout_ms: 3000, guard_version: 'classifier-guard@1',
    };
    const snapshot = { sha256: 's'.repeat(64), policy_ref: { sha256: 'p'.repeat(64) }, classifier_effective: effective };
    return { root, runDir, snapshot };
}

// Cliente falso: uma resposta por chamada, na ordem; registra o que recebeu.
function scriptedClient(responses) {
    const calls = [];
    return {
        calls,
        classify: async input => {
            calls.push(input);
            const r = responses[Math.min(calls.length - 1, responses.length - 1)];
            return { class: null, confidence: null, risky: null, model_reported: null, parse: null, http_status: null, auth_rejected: false, latency_ms: 5, detail: null, ...r };
        },
    };
}
const OK = (cls, confidence = 0.9) => ({ outcome: 'OK', certain: true, parse: 'OK', class: cls, confidence, http_status: 200, model_reported: 'jev-2026-10-01' });
const credentialOk = async () => ({ ok: true, value: KEY });

function run(ctx, { groups, client, visit = 'v1', credentialProvider = credentialOk, repIndex } = {}) {
    return shadow.collectOpinions({
        runDir: ctx.runDir, root: ctx.root, snapshot: ctx.snapshot, taskId: '205-x', visit,
        groups, client, credentialProvider, ...(repIndex ? { repIndex } : {}),
    });
}

const effectAttempts = runDir => dom06.listAttempts(runDir).filter(a => a.node === 'classifier');

test('caminho feliz: zona cinzenta e sonda viram opiniões, cada uma com seu Attempt de efeito COMPLETE', async () => {
    const ctx = setup();
    const client = scriptedClient([OK('C3', 0.7), OK('C4', 0.5)]);
    const r = await run(ctx, { groups: [group('a', GRAY), group('b', PROBE), group('c', sig({ sensitive_decl: true }))], client });
    assert.strictEqual(r.status, 'ON');
    const [a, b, c] = r.opinions;
    assert.deepStrictEqual([a.status, a.probe, a.class_suggested, a.would_class, a.direction], ['OK', 'GRAY', 'C3', 'C3', 'DOWN']);
    assert.deepStrictEqual([b.status, b.probe, b.class_suggested, b.would_class, b.direction], ['OK', 'UPGRADE_PROBE', 'C4', 'C4', 'UP']);
    assert.deepStrictEqual([c.status, c.reason], ['NOT_ELIGIBLE', 'EXCLUDED_SENSITIVE']);
    const attempts = effectAttempts(ctx.runDir);
    assert.strictEqual(attempts.length, 2);
    for (const att of attempts) {
        assert.strictEqual(att.result, 'COMPLETE');
        assert.strictEqual(att.effects[0].status, 'fulfilled');
        assert.ok(att.snapshot.effect_id && att.snapshot.envelope_sha256);
        assert.strictEqual(att.snapshot.rep_index, 1);
    }
    assert.strictEqual(a.effect_attempt_id, attempts.find(x => x.snapshot.subtask_key === 'a').attempt_id);
    assert.strictEqual(client.calls[0].credential, KEY);
    assert.strictEqual(client.calls[0].model, 'jev-latest');
    assert.strictEqual(client.calls[0].timeoutMs, 3000);
});

test('wouldClass: regras do §4.8 só como registro (sobe ≥ 0,3; desce uma classe ≥ 0,6; sonda ignora descida)', () => {
    const w = shadow.wouldClass;
    assert.deepStrictEqual(w({ class: 'C4', probe: 'GRAY' }, 'C5', 0.3), { would_class: 'C5', direction: 'UP' });
    assert.deepStrictEqual(w({ class: 'C4', probe: 'GRAY' }, 'C5', 0.29), { would_class: 'C4', direction: 'LOW_CONFIDENCE' });
    assert.deepStrictEqual(w({ class: 'C4', probe: 'GRAY' }, 'C1', 0.95), { would_class: 'C3', direction: 'DOWN' });
    assert.deepStrictEqual(w({ class: 'C4', probe: 'GRAY' }, 'C3', 0.59), { would_class: 'C4', direction: 'LOW_CONFIDENCE' });
    assert.deepStrictEqual(w({ class: 'C2', probe: 'UPGRADE_PROBE' }, 'C1', 0.99), { would_class: 'C2', direction: 'DOWN_IGNORED' });
    assert.deepStrictEqual(w({ class: 'C2', probe: 'UPGRADE_PROBE' }, 'C2', 0.99), { would_class: 'C2', direction: 'SAME' });
    assert.deepStrictEqual(w({ class: 'C2', probe: 'UPGRADE_PROBE' }, 'C5', null), { would_class: 'C2', direction: 'NO_CONFIDENCE' });
    assert.deepStrictEqual(w({ class: 'C4', probe: 'GRAY' }, null, 0.9), { would_class: 'C4', direction: 'NO_ANSWER' });
});

test('AC-08: o Attempt de efeito existe e está STARTED antes de o servidor receber o pedido (cliente real + fake HTTP)', async t => {
    const ctx = setup();
    const seen = [];
    const server = http.createServer((req, res) => {
        let body = '';
        req.on('data', c => { body += c; });
        req.on('end', () => {
            seen.push(effectAttempts(ctx.runDir).map(a => [a.result, a.started]));
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ answers: { class: { choice: 'C3', confidence: 0.8 } } }));
        });
    });
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    t.after(() => new Promise(r => server.close(r)));
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const client = { classify: input => jevClient.classify({ ...input, baseUrl }) };
    const r = await run(ctx, { groups: [group('a', GRAY)], client });
    assert.deepStrictEqual(seen, [[['STARTED', true]]]);
    assert.strictEqual(r.opinions[0].status, 'OK');
    assert.strictEqual(effectAttempts(ctx.runDir)[0].result, 'COMPLETE');
});

test('AC-05: guarda bloqueia → nenhuma chamada, nenhum Attempt, só a categoria', async () => {
    const ctx = setup();
    const client = scriptedClient([OK('C3')]);
    const r = await run(ctx, { groups: [group('a', GRAY, { step_text: 'avisar fulano@empresa.com' })], client });
    assert.deepStrictEqual([r.opinions[0].status, r.opinions[0].categories], ['CONTENT_GUARD_BLOCKED', ['email']]);
    assert.strictEqual(client.calls.length, 0);
    assert.strictEqual(effectAttempts(ctx.runDir).length, 0);
    assert.ok(!JSON.stringify(r).includes('fulano@empresa.com'));
});

test('B7: desfechos fecham o Attempt de efeito como FAILED, UNCERTAIN ou COMPLETE', async () => {
    const cases = [
        [{ outcome: 'NOT_SENT', certain: true, detail: 'ECONNREFUSED' }, 'FAILED', 'NOT_SENT'],
        [{ outcome: 'FAILED', certain: true, detail: 'HTTP_500', http_status: 500 }, 'FAILED', 'FAILED'],
        [{ outcome: 'UNCERTAIN', certain: false, detail: 'TIMEOUT' }, 'UNCERTAIN', 'UNCERTAIN'],
        [{ outcome: 'OK', certain: true, parse: 'OUT_OF_ENUM', class: null, http_status: 200 }, 'COMPLETE', 'OUT_OF_ENUM'],
    ];
    for (const [response, result, status] of cases) {
        const ctx = setup();
        const r = await run(ctx, { groups: [group('a', GRAY)], client: scriptedClient([response]) });
        const [att] = effectAttempts(ctx.runDir);
        assert.strictEqual(att.result, result, JSON.stringify(response));
        assert.strictEqual(r.opinions[0].status, status);
        assert.strictEqual(r.opinions[0].would_class, 'C4', 'sem resposta válida vale o núcleo 1');
    }
});

test('AC-09: timeout = UNCERTAIN e nunca repete, nem no retry da mesma visita; COMPLETE é reusado; visita nova chama de novo', async () => {
    const ctx = setup();
    const client = scriptedClient([{ outcome: 'UNCERTAIN', certain: false, detail: 'TIMEOUT' }, OK('C3')]);
    await run(ctx, { groups: [group('a', GRAY)], client });
    const again = await run(ctx, { groups: [group('a', GRAY)], client });
    assert.strictEqual(client.calls.length, 1, 'UNCERTAIN não se repete');
    assert.deepStrictEqual([again.opinions[0].status, again.opinions[0].prior_result], ['NOT_REPEATED', 'UNCERTAIN']);

    const ctx2 = setup();
    const client2 = scriptedClient([OK('C3', 0.8)]);
    await run(ctx2, { groups: [group('a', GRAY)], client: client2 });
    const reused = await run(ctx2, { groups: [group('a', GRAY)], client: client2 });
    assert.strictEqual(client2.calls.length, 1);
    assert.deepStrictEqual([reused.opinions[0].status, reused.opinions[0].class_suggested, reused.opinions[0].would_class], ['REUSED', 'C3', 'C3']);
    await run(ctx2, { groups: [group('a', GRAY)], client: client2, visit: 'v2' });
    assert.strictEqual(client2.calls.length, 2, 'visita nova ao nó é outra causa');
});

test('rep_index entra na EffectId: repetições do U15 são efeitos distintos', async () => {
    const ctx = setup();
    const client = scriptedClient([OK('C3')]);
    await run(ctx, { groups: [group('a', GRAY)], client, repIndex: 1 });
    await run(ctx, { groups: [group('a', GRAY)], client, repIndex: 2 });
    const ids = effectAttempts(ctx.runDir).map(a => a.snapshot.effect_id);
    assert.strictEqual(new Set(ids).size, 2);
    assert.strictEqual(client.calls.length, 2);
});

test('AC-10: 401/403 revoga o efeito, grava o marcador e desliga o núcleo 2 no resto da Run', async () => {
    const ctx = setup();
    const client = scriptedClient([{ outcome: 'FAILED', certain: true, detail: 'HTTP_401', http_status: 401, auth_rejected: true }, OK('C3')]);
    const r = await run(ctx, { groups: [group('a', GRAY), group('b', PROBE)], client });
    assert.deepStrictEqual(r.opinions.map(o => o.status), ['FAILED', 'DISABLED']);
    const [att] = effectAttempts(ctx.runDir);
    assert.strictEqual(att.authority, 'revoked');
    assert.ok(fs.existsSync(path.join(ctx.runDir, 'dom06', 'classifier-disabled.json')));
    const later = await run(ctx, { groups: [group('c', GRAY)], client, visit: 'v2' });
    assert.deepStrictEqual([later.status, later.reason], ['OFF', 'JEV_AUTH_REJECTED']);
    assert.strictEqual(client.calls.length, 1);
});

test('AC-11: em todos os desfechos o Attempt do Implement não ganha obrigação nem muda', async () => {
    const responses = [OK('C3'), { outcome: 'UNCERTAIN', certain: false }, { outcome: 'FAILED', certain: true, http_status: 403, auth_rejected: true }, { outcome: 'NOT_SENT', certain: true }];
    for (const response of responses) {
        const ctx = setup();
        const impl = dom06.beginAttempt(ctx.runDir, { node: 'implement', admission: { status: 'ADMITTED', owner: 'dom06', snapshot: { ticket_id: 1, node: 'implement' } }, obligations: [{ id: 'execute_node' }] });
        const before = fs.readFileSync(impl.attemptFile, 'utf8');
        await run(ctx, { groups: [group('a', GRAY)], client: scriptedClient([response]) });
        assert.strictEqual(fs.readFileSync(impl.attemptFile, 'utf8'), before);
        assert.deepStrictEqual(dom06.summarize(dom06.readAttempt(impl.attemptFile)).obligations.map(o => o.id), ['execute_node']);
    }
});

test('efetivo off, revogado depois da admissão (Q4) ou sem credencial → nada é chamado', async () => {
    const off = setup();
    off.snapshot = { ...off.snapshot, classifier_effective: { provider: 'off', reason: 'AUTHORITY_REF_ABSENT' } };
    const c1 = scriptedClient([OK('C3')]);
    assert.deepStrictEqual(await run(off, { groups: [group('a', GRAY)], client: c1 }).then(r => [r.status, r.reason]), ['OFF', 'AUTHORITY_REF_ABSENT']);

    const noSnap = setup();
    noSnap.snapshot = { sha256: 'x' };
    assert.deepStrictEqual(await run(noSnap, { groups: [group('a', GRAY)], client: c1 }).then(r => [r.status, r.reason]), ['OFF', 'NOT_JEV']);

    const revoked = setup();
    fs.writeFileSync(path.join(revoked.root, MIRROR), JSON.stringify({ id: 'ref-1', revoked_at: '2026-11-06T13:00:00Z' }));
    assert.deepStrictEqual(await run(revoked, { groups: [group('a', GRAY)], client: c1 }).then(r => [r.status, r.reason]), ['OFF', 'AUTHORITY_REF_REVOKED']);

    const noCred = setup();
    const r = await run(noCred, { groups: [group('a', GRAY)], client: c1, credentialProvider: async () => ({ ok: false, reason: 'CREDENTIAL_UNAVAILABLE' }) });
    assert.deepStrictEqual(r.opinions[0].status, 'CREDENTIAL_UNAVAILABLE');
    assert.strictEqual(c1.calls.length, 0);
    assert.strictEqual(effectAttempts(noCred.runDir).length, 0);
});

test('Q6: o envelope fica só no diretório da Run; o Attempt guarda só o hash; a chave não é gravada (AC-06)', async () => {
    const ctx = setup();
    const r = await run(ctx, { groups: [group('a', GRAY)], client: scriptedClient([OK('C3')]) });
    const [att] = effectAttempts(ctx.runDir);
    const stored = path.join(ctx.runDir, 'dom06', 'classifier', 'envelopes', `${att.snapshot.envelope_sha256}.json`);
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(stored, 'utf8')), group('a', GRAY).envelope);
    assert.ok(!JSON.stringify(att).includes('Passo a em'));
    const all = [];
    const walk = d => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else all.push(fs.readFileSync(p, 'utf8')); } };
    walk(ctx.root);
    assert.ok(all.every(c => !c.includes(KEY)));
    assert.ok(!JSON.stringify(r).includes(KEY));
});

test('teto de 3 por visita: o resto fica SKIPPED_BUDGET e não é chamado', async () => {
    const ctx = setup();
    const client = scriptedClient([OK('C4')]);
    const groups = ['a', 'b', 'c', 'd'].map(k => group(k, PROBE));
    const r = await run(ctx, { groups, client });
    assert.deepStrictEqual(r.opinions.map(o => o.status), ['OK', 'OK', 'OK', 'SKIPPED_BUDGET']);
    assert.strictEqual(client.calls.length, 3);
});

test('nunca lança: cliente que explode vira ERROR e o Attempt fecha UNCERTAIN', async () => {
    const ctx = setup();
    const client = { classify: async () => { throw new Error('boom'); } };
    const r = await run(ctx, { groups: [group('a', GRAY)], client });
    assert.strictEqual(r.opinions[0].status, 'ERROR');
    assert.strictEqual(effectAttempts(ctx.runDir)[0].result, 'UNCERTAIN');
});

test('T7: grupo sem envelope (ex.: passo com bloco de código) → NO_ENVELOPE com o motivo, sem chamada nem Attempt', async () => {
    const ctx = setup();
    const client = scriptedClient([OK('C3')]);
    const g = { ...group('a', GRAY), envelope: undefined, envelope_reason: 'STEP_HAS_CODE_BLOCK' };
    const r = await run(ctx, { groups: [g], client });
    assert.deepStrictEqual([r.opinions[0].status, r.opinions[0].reason], ['NO_ENVELOPE', 'STEP_HAS_CODE_BLOCK']);
    assert.strictEqual(client.calls.length, 0);
    assert.strictEqual(effectAttempts(ctx.runDir).length, 0);
});

test('T9 / AC-14: Attempts classifier não confundem os consumidores (latestBound por nó, idempotência do db-effect)', async () => {
    const ctx = setup();
    const impl = dom06.beginAttempt(ctx.runDir, { node: 'implement', admission: { status: 'ADMITTED', owner: 'dom06', snapshot: { ticket_id: 1, node: 'implement' } }, obligations: [{ id: 'execute_node' }] });
    await run(ctx, { groups: [group('a', GRAY), group('b', PROBE)], client: scriptedClient([OK('C3'), OK('C4')]) });
    assert.strictEqual(dom06.listAttempts(ctx.runDir).length, 3);
    // retry do Implement se liga ao Attempt anterior DO IMPLEMENT (latestBound filtra por nó),
    // mesmo com Attempts classifier mais novos no mesmo diretório.
    const retry = dom06.retryAttempt(ctx.runDir, { node: 'implement', cause: 'retry', proposed: { owner: 'dom06', snapshot: { ticket_id: 1, node: 'implement' } } });
    assert.deepStrictEqual([retry.dispatch, retry.attempt.snapshot, retry.attempt.rebind_refused], [true, impl.attempt.snapshot, null]);
    assert.deepStrictEqual(retry.attempt.obligations.map(o => o.id), ['execute_node']);
    // db-effect procura a própria chave (db-apply:<job>:<sha>:<alias>): nenhuma chave do Jev colide.
    const keys = dom06.listAttempts(ctx.runDir).flatMap(a => (a.effects || []).map(e => e.idempotency_key));
    assert.ok(keys.every(k => /^[0-9a-f]{64}$/.test(k)));
});
