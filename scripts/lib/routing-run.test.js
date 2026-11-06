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

// Revisão do Checkpoint B (MAJOR-1): a ligação vem de um ponteiro gravado na admissão
// (id do Attempt que o watcher já tem), nunca de timestamps; rastro de ON que não dá
// para ligar recusa (fail-closed), nunca vira OFF; não há religação automática.

test('recordAdmission + bindingFor: Run admitida ON → bind com o id do Attempt de admissão, sem olhar started_at', () => {
    const dir = fetchRunDir();
    const snap = snapshot();
    const admitted = admitFetch(dir, snap);
    rr.recordAdmission(dir, admitted.attempt);
    for (const started_at of ['1999-01-01T00:00:00.000Z', '2999-01-01T00:00:00.000Z', 'ontem', undefined]) {
        assert.deepStrictEqual(rr.bindingFor({ started_at }, dir, '233-a'),
            { action: 'bind', binding: { attempt_id: admitted.attempt.attempt_id, sha256: snap.sha256 } });
    }
});

test('bindingFor: sem ponteiro (Run admitida OFF ou ticket sem admissão ON) → none', () => {
    const dir = fetchRunDir();
    admitFetch(dir);
    assert.deepStrictEqual(rr.bindingFor({}, dir, '233-a'), { action: 'none' });
    assert.deepStrictEqual(rr.bindingFor({}, fetchRunDir(), '233-a'), { action: 'none' }, '_dom06 vazio também');
});

test('clearAdmission: admissão OFF posterior apaga o ponteiro ON anterior', () => {
    const dir = fetchRunDir();
    rr.recordAdmission(dir, admitFetch(dir, snapshot()).attempt);
    rr.clearAdmission(dir);
    assert.deepStrictEqual(rr.bindingFor({}, dir, '233-a'), { action: 'none' });
    rr.clearAdmission(fetchRunDir()); // sem ponteiro: no-op
});

test('bindingFor: state já ligado → none (o snapshot nunca é trocado)', () => {
    const dir = fetchRunDir();
    rr.recordAdmission(dir, admitFetch(dir, snapshot()).attempt);
    assert.deepStrictEqual(rr.bindingFor({ routing_snapshot: { attempt_id: 'x', sha256: 'y' } }, dir, '233-a'), { action: 'none' });
});

test('bindingFor: ponteiro consumido pela própria task e ligação sumida do state → refuse (sem religar)', () => {
    const dir = fetchRunDir();
    rr.recordAdmission(dir, admitFetch(dir, snapshot()).attempt);
    rr.markConsumed(dir, '233-a');
    assert.deepStrictEqual(rr.bindingFor({}, dir, '233-a'), { action: 'refuse', detail: 'snapshot_binding_lost' });
});

test('bindingFor: ponteiro consumido por outra task → refuse (ambíguo)', () => {
    const dir = fetchRunDir();
    rr.recordAdmission(dir, admitFetch(dir, snapshot()).attempt);
    rr.markConsumed(dir, '233-a');
    assert.deepStrictEqual(rr.bindingFor({}, dir, '233-b'), { action: 'refuse', detail: 'snapshot_binding_ambiguous' });
});

test('bindingFor: ponteiro ilegível ou malformado → refuse (rastro de ON nunca vira OFF)', () => {
    const dir = fetchRunDir();
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'routing-admission.json'), '{ x');
    assert.deepStrictEqual(rr.bindingFor({}, dir, '233-a'), { action: 'refuse', detail: 'admission_pointer_unreadable' });
    fs.writeFileSync(path.join(dir, 'routing-admission.json'), JSON.stringify({ attempt_id: '../x', sha256: 'z' }));
    assert.deepStrictEqual(rr.bindingFor({}, dir, '233-a'), { action: 'refuse', detail: 'admission_pointer_unreadable' });
});

test('recordAdmission recusa Attempt sem snapshot routing', () => {
    const dir = fetchRunDir();
    assert.throws(() => rr.recordAdmission(dir, admitFetch(dir).attempt), /ROUTING_ADMISSION_REQUIRES_SNAPSHOT/);
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

// Bugbot no PR #97: notified_at só é gravado depois que o aviso saiu (markNoticeSent);
// aviso que falhou é tentado de novo no próximo tick.
const sent = (r, at = AT) => rr.markNoticeSent(r.marker, at);

test('blockedNotice: primeiro bloqueio não transitório avisa; notified_at só depois do envio', () => {
    const r = rr.blockedNotice(null, invalidCfg(), { ticketId: 1, at: AT });
    assert.strictEqual(r.notify, true);
    assert.deepStrictEqual(r.marker, {
        signature: 'POLICY_HASH_MISMATCH|expected:ff', cause: 'POLICY_HASH_MISMATCH', detail: 'expected:ff',
        transient: false, transient_count: 0, tickets: [1], first_blocked_at: AT, notified_at: null,
    });
    assert.strictEqual(sent(r).notified_at, AT);
});

test('blockedNotice: aviso que falhou (sem markNoticeSent) é tentado de novo no tick seguinte', () => {
    const failed = rr.blockedNotice(null, invalidCfg(), { ticketId: 1, at: AT });
    const retry = rr.blockedNotice(failed.marker, invalidCfg(), { ticketId: 1, at: '2026-11-06T12:05:00.000Z' });
    assert.strictEqual(retry.notify, true);
    assert.strictEqual(retry.marker.first_blocked_at, AT);
});

test('blockedNotice: mesma assinatura não avisa de novo; outro ticket entra na lista (um aviso por projeto)', () => {
    const first = sent(rr.blockedNotice(null, invalidCfg(), { ticketId: 1, at: AT }));
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
    assert.strictEqual(rr.blockedNotice(sent(c), t, { ticketId: 1, at: AT }).notify, false);
});

// ── T8: limite de nó (D-4) para a vigência da override ──────────────────────────

const ev = (type, node, ts) => ({ type, node, ts });
const NOW = '2026-11-06T16:00:00.000Z';

test('nodeVisitStart: primeiro Attempt de uma visita nova ao nó → agora', () => {
    const state = { events: [ev('node_start', 'plan', '2026-11-06T10:00:00.000Z'), ev('node_end', 'plan', '2026-11-06T10:30:00.000Z')] };
    assert.strictEqual(rr.nodeVisitStart(state, 'implement', NOW), NOW);
    assert.strictEqual(rr.nodeVisitStart({}, 'implement', NOW), NOW, 'sem eventos');
});

test('nodeVisitStart: retry do mesmo nó → início do 1º Attempt da visita (override no meio não vale)', () => {
    const state = { events: [
        ev('node_end', 'plan', '2026-11-06T10:30:00.000Z'),
        ev('node_start', 'implement', '2026-11-06T11:00:00.000Z'),
        { type: 'routing_override', node: 'review', ts: '2026-11-06T11:10:00.000Z' },
        ev('node_error', 'implement', '2026-11-06T11:20:00.000Z'),
        ev('node_start', 'implement', '2026-11-06T11:30:00.000Z'),
        ev('node_error', 'implement', '2026-11-06T11:40:00.000Z'),
    ] };
    assert.strictEqual(rr.nodeVisitStart(state, 'implement', NOW), '2026-11-06T11:00:00.000Z');
});

test('nodeVisitStart: nó revisitado depois de outro (implement → review → implement) → visita nova', () => {
    const state = { events: [
        ev('node_start', 'implement', '2026-11-06T11:00:00.000Z'), ev('node_end', 'implement', '2026-11-06T11:20:00.000Z'),
        ev('node_start', 'review', '2026-11-06T11:30:00.000Z'), ev('node_end', 'review', '2026-11-06T11:40:00.000Z'),
        ev('node_retry', 'review', '2026-11-06T11:40:00.000Z'),
    ] };
    assert.strictEqual(rr.nodeVisitStart(state, 'implement', NOW), NOW);
});

// Bugbot (PR #97): o limite do 1º Attempt é o instante da resolução, anterior ao
// node_start; ele fica gravado em state.routing_visit e o retry da mesma visita usa o menor.
test('nodeVisitStart: retry usa o limite gravado no 1º Attempt (anterior ao node_start)', () => {
    const state = {
        routing_visit: { node: 'implement', at: '2026-11-06T10:55:00.000Z' },
        events: [
            ev('node_end', 'plan', '2026-11-06T10:30:00.000Z'),
            ev('node_start', 'implement', '2026-11-06T11:00:00.000Z'),
            ev('node_error', 'implement', '2026-11-06T11:20:00.000Z'),
        ],
    };
    assert.strictEqual(rr.nodeVisitStart(state, 'implement', NOW), '2026-11-06T10:55:00.000Z');
});

test('nodeVisitStart: routing_visit de uma visita anterior do mesmo nó é ignorado', () => {
    const state = {
        routing_visit: { node: 'implement', at: '2026-11-06T09:00:00.000Z' },
        events: [
            ev('node_start', 'implement', '2026-11-06T09:01:00.000Z'), ev('node_end', 'implement', '2026-11-06T09:30:00.000Z'),
            ev('node_start', 'review', '2026-11-06T10:00:00.000Z'), ev('node_retry', 'review', '2026-11-06T10:20:00.000Z'),
            ev('node_start', 'implement', '2026-11-06T11:00:00.000Z'), ev('node_error', 'implement', '2026-11-06T11:20:00.000Z'),
        ],
    };
    assert.strictEqual(rr.nodeVisitStart(state, 'implement', NOW), '2026-11-06T11:00:00.000Z');
});

test('nodeVisitStart: visita nova ignora routing_visit (vale agora)', () => {
    const state = { routing_visit: { node: 'implement', at: '2026-11-06T09:00:00.000Z' }, events: [ev('node_end', 'review', '2026-11-06T10:20:00.000Z')] };
    assert.strictEqual(rr.nodeVisitStart(state, 'implement', NOW), NOW);
});

test('loadRunSnapshot: attempt_id com caminho (../) é recusado sem ler fora do _dom06', () => {
    const r = rr.loadRunSnapshot({ routing_snapshot: { attempt_id: '../../etc/passwd', sha256: 'a'.repeat(64) } }, fetchRunDir());
    assert.deepStrictEqual(r, { mode: 'ON', ok: false, detail: 'snapshot_unreadable' });
});
