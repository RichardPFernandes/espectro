// node --test scripts/lib/routing-run.test.js
// PRI-233 (PRI-205 S4) T5: snapshot `routing` da Run (admissão → task).
//
// O snapshot é fixado na admissão da Run, dentro do admission.snapshot do Attempt
// fetch_ticket (owner DOM06, em memory/runs/_dom06 do ticket). A task, criada depois
// pelo agente, liga-se a ele por state.routing_snapshot { attempt_id, sha256 }. Os
// Attempts de nó leem só esse snapshot; a config corrente do consumidor nunca é
// relida (AD-4). Run admitida OFF fica OFF: nada é ligado.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const dom06 = require('./dom06-attempt');
const mr = require('./model-routing');
const rr = require('./routing-run');

const tmpBase = process.env.CLAUDE_JOB_DIR ? path.join(process.env.CLAUDE_JOB_DIR, 'tmp') : os.tmpdir();
const dirs = [];
test.after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

function fetchRunDir() {
    const d = fs.mkdtempSync(path.join(tmpBase, 'routing-run-'));
    dirs.push(d);
    return d;
}

function snapshot(version = 'p-test-1') {
    const policy = {
        id: 'routing-sintetica', version, mode: 'ROUTED', classifier: { provider: 'cheap_rule' },
        class_to_tier: {
            C1: { tier: 'T1', effort: 'baixo' }, C2: { tier: 'T2', effort: 'médio' }, C3: { tier: 'T2', effort: 'alto' },
            C4: { tier: 'T3', effort: 'alto' }, C5: { tier: 'T3', effort: 'máximo' },
        },
        tiers: { T1: { models: ['m-t1'] }, T2: { models: ['m-t2'] }, T3: { models: ['m-t3'] } },
        default_route: { model_id: 'm-t3', effort: 'alto' },
        effort_map: { baixo: 'low', 'médio': 'medium', alto: 'high', 'máximo': 'max' },
    };
    return mr.buildRoutingSnapshot({
        status: 'ON', policy,
        policy_ref: { id: policy.id, version, sha256: 'a'.repeat(64), path: '.claude/routing-policy.json' },
        policy_hash: 'a'.repeat(64),
    });
}

// Admissão do fetch_ticket pelo DOM06 real, com ou sem routing.
function admitFetch(dir, routing) {
    return dom06.prepareDispatch({
        runDir: dir, node: 'fetch_ticket', ticketId: 233, baseBranch: 'development', specHash: null, cause: 'dispatch',
        ...(routing ? { routing } : {}),
    });
}

test('prepareDispatch: com routing, o snapshot do fetch_ticket carrega o routing; sem routing, fica como hoje', () => {
    const dir = fetchRunDir();
    const snap = snapshot();
    const on = admitFetch(dir, snap);
    assert.deepStrictEqual(on.attempt.snapshot.routing, snap);
    const off = admitFetch(fetchRunDir());
    assert.deepStrictEqual(Object.keys(off.attempt.snapshot).sort(), ['base_branch', 'node', 'spec_hash', 'ticket_id']);
});

test('bindingFor: Run admitida ON → { attempt_id, sha256 } do fetch_ticket', () => {
    const dir = fetchRunDir();
    const snap = snapshot();
    const admitted = admitFetch(dir, snap);
    const state = { started_at: new Date(Date.now() + 1000).toISOString() };
    assert.deepStrictEqual(rr.bindingFor(state, dir), { attempt_id: admitted.attempt.attempt_id, sha256: snap.sha256 });
});

test('bindingFor: Run admitida OFF → null (nada é ligado)', () => {
    const dir = fetchRunDir();
    admitFetch(dir);
    assert.strictEqual(rr.bindingFor({ started_at: new Date(Date.now() + 1000).toISOString() }, dir), null);
    assert.strictEqual(rr.bindingFor({ started_at: new Date().toISOString() }, fetchRunDir()), null, '_dom06 vazio também é null');
});

test('bindingFor: usa o fetch_ticket mais recente criado até o started_at da task (ciclos anteriores não contam)', async () => {
    const dir = fetchRunDir();
    const old = admitFetch(dir, snapshot('p-velha'));
    await new Promise(r => setTimeout(r, 5));
    const between = new Date().toISOString();
    await new Promise(r => setTimeout(r, 5));
    const later = admitFetch(dir, snapshot('p-nova'));
    assert.strictEqual(rr.bindingFor({ started_at: between }, dir).attempt_id, old.attempt.attempt_id);
    assert.strictEqual(rr.bindingFor({ started_at: new Date(Date.now() + 1000).toISOString() }, dir).attempt_id, later.attempt.attempt_id);
});

test('bindingFor: state já ligado → null (snapshot nunca é trocado)', () => {
    const dir = fetchRunDir();
    admitFetch(dir, snapshot());
    assert.strictEqual(rr.bindingFor({ routing_snapshot: { attempt_id: 'x', sha256: 'y' } }, dir), null);
});

test('loadRunSnapshot: sem routing_snapshot → OFF', () => {
    assert.deepStrictEqual(rr.loadRunSnapshot({}, fetchRunDir()), { mode: 'OFF' });
});

test('loadRunSnapshot: ligado e íntegro → ON com o snapshot da admissão', () => {
    const dir = fetchRunDir();
    const snap = snapshot();
    const admitted = admitFetch(dir, snap);
    const r = rr.loadRunSnapshot({ routing_snapshot: { attempt_id: admitted.attempt.attempt_id, sha256: snap.sha256 } }, dir);
    assert.deepStrictEqual(r, { mode: 'ON', ok: true, snapshot: snap });
});

for (const [name, corrupt, detail] of [
    ['Attempt apagado', file => fs.rmSync(file), 'snapshot_unreadable'],
    ['JSON quebrado', file => fs.writeFileSync(file, '{ x'), 'snapshot_unreadable'],
    ['routing removido do Attempt', file => {
        const a = JSON.parse(fs.readFileSync(file, 'utf8'));
        delete a.snapshot.routing;
        fs.writeFileSync(file, JSON.stringify(a));
    }, 'snapshot_missing'],
    ['conteúdo alterado', file => {
        const a = JSON.parse(fs.readFileSync(file, 'utf8'));
        a.snapshot.routing.default_route.model_id = 'm-t1';
        fs.writeFileSync(file, JSON.stringify(a));
    }, 'snapshot_hash_mismatch'],
]) {
    test(`loadRunSnapshot: ${name} → ON sem snapshot utilizável (${detail})`, () => {
        const dir = fetchRunDir();
        const snap = snapshot();
        const admitted = admitFetch(dir, snap);
        corrupt(admitted.attemptFile);
        const r = rr.loadRunSnapshot({ routing_snapshot: { attempt_id: admitted.attempt.attempt_id, sha256: snap.sha256 } }, dir);
        assert.deepStrictEqual(r, { mode: 'ON', ok: false, detail });
    });
}

test('loadRunSnapshot: sha da ligação diverge do snapshot → snapshot_binding_mismatch', () => {
    const dir = fetchRunDir();
    const admitted = admitFetch(dir, snapshot());
    const r = rr.loadRunSnapshot({ routing_snapshot: { attempt_id: admitted.attempt.attempt_id, sha256: 'd'.repeat(64) } }, dir);
    assert.deepStrictEqual(r, { mode: 'ON', ok: false, detail: 'snapshot_binding_mismatch' });
});

// ── T6: aviso único da admissão recusada (por projeto) ────────────────────────

const invalidCfg = (over = {}) => ({ status: 'INVALID', cause: 'POLICY_HASH_MISMATCH', detail: 'expected:ff', transient: false, ...over });
const AT = '2026-11-06T12:00:00.000Z';

test('blockedNotice: primeiro bloqueio não transitório avisa e grava a assinatura', () => {
    const r = rr.blockedNotice(null, invalidCfg(), { ticketId: 1, at: AT });
    assert.strictEqual(r.notify, true);
    assert.deepStrictEqual(r.marker, {
        signature: 'POLICY_HASH_MISMATCH|expected:ff', cause: 'POLICY_HASH_MISMATCH', detail: 'expected:ff',
        transient: false, transient_count: 0, tickets: [1], first_blocked_at: AT, notified_at: AT,
    });
});

test('blockedNotice: mesma assinatura não avisa de novo; outro ticket entra na lista (um aviso por projeto)', () => {
    const first = rr.blockedNotice(null, invalidCfg(), { ticketId: 1, at: AT }).marker;
    const again = rr.blockedNotice(first, invalidCfg(), { ticketId: 1, at: '2026-11-06T12:05:00.000Z' });
    assert.strictEqual(again.notify, false);
    const other = rr.blockedNotice(again.marker, invalidCfg(), { ticketId: 2, at: '2026-11-06T12:06:00.000Z' });
    assert.strictEqual(other.notify, false);
    assert.deepStrictEqual(other.marker.tickets, [1, 2]);
    assert.strictEqual(other.marker.notified_at, AT);
});

test('blockedNotice: assinatura nova (outra causa) avisa de novo', () => {
    const first = rr.blockedNotice(null, invalidCfg(), { ticketId: 1, at: AT }).marker;
    const r = rr.blockedNotice(first, invalidCfg({ cause: 'POLICY_MISSING', detail: 'not_found' }), { ticketId: 1, at: AT });
    assert.strictEqual(r.notify, true);
    assert.strictEqual(r.marker.signature, 'POLICY_MISSING|not_found');
});

test('blockedNotice: leitura transitória só avisa no 3º bloqueio seguido (R-6 n.º 6), mas sempre bloqueia', () => {
    const t = invalidCfg({ cause: 'POLICY_UNREADABLE', detail: 'read:EIO', transient: true });
    const a = rr.blockedNotice(null, t, { ticketId: 1, at: AT });
    const b = rr.blockedNotice(a.marker, t, { ticketId: 1, at: AT });
    const c = rr.blockedNotice(b.marker, t, { ticketId: 1, at: AT });
    assert.deepStrictEqual([a.notify, b.notify, c.notify], [false, false, true]);
    assert.deepStrictEqual([a.marker.transient_count, b.marker.transient_count, c.marker.transient_count], [1, 2, 3]);
    assert.strictEqual(rr.blockedNotice(c.marker, t, { ticketId: 1, at: AT }).notify, false);
});

test('loadRunSnapshot: attempt_id com caminho (../) é recusado sem ler fora do _dom06', () => {
    const r = rr.loadRunSnapshot({ routing_snapshot: { attempt_id: '../../etc/passwd', sha256: 'a'.repeat(64) } }, fetchRunDir());
    assert.deepStrictEqual(r, { mode: 'ON', ok: false, detail: 'snapshot_unreadable' });
});
