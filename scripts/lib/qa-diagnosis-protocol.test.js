'use strict';
// PRI-181 c2b-2-protocol (SPEC-c2b-2-protocol r5.1): AC-01…AC-06, AC-07b (sem crash), AC-07c,
// AC-08…AC-11, AC-14 e AC-15. Raízes temporárias, chaves sintéticas, blocos de fixture, relógio
// injetado; nada de consumidor. O crash real (AC-07) está em qa-diagnosis-protocol-crash.test.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const P = require('./qa-diagnosis-protocol');
const model = require('./qa-diagnosis-model');
const store = require('./qa-diagnosis-store');
const stateWriter = require('../state-writer');
const cas = require('../cas');

const HEX_A = 'a'.repeat(64);
const HEX_B = 'b'.repeat(64);
const T0 = Date.parse('2026-11-13T12:00:00.000Z');
const KEY = 'redmine:4242:j101';
const KEY2 = 'redmine:4242:j102';
const SENTINEL = 'NOTA-SENTINELA-NAO-VAZAR';

const BINDINGS = {
    full: { execution_id: 'exec-1', spec_hash: HEX_A, spec_version: 3, reason: 'contemporaneous' },
    partial: { execution_id: null, spec_hash: HEX_A, spec_version: null, reason: 'contemporaneous' },
    null: { execution_id: null, spec_hash: null, spec_version: null, reason: 'not_contemporaneous' },
    absent: undefined,
};

function env() {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'c2b2-'));
    const repo = path.join(base, 'repo');
    const runs = path.join(repo, 'memory/runs');
    const archive = path.join(runs, '_archive');
    const rotated = path.join(repo, 'memory/archive/2026-10');
    const wtRoot = path.join(repo, '.claude/worktrees');
    const wt = t => path.join(wtRoot, `t${t}`, 'memory/runs');
    for (const d of [runs, archive, rotated, wt(4242)]) fs.mkdirSync(d, { recursive: true });
    const clock = { t: T0 };
    let seq = 0;
    const logs = [];
    const opts = {
        stateWriter, cas,
        now: () => clock.t,
        token: () => `det-test-${++seq}`,
        discoveryRoots: () => {
            const r = [runs, archive];
            for (const d of fs.existsSync(wtRoot) ? fs.readdirSync(wtRoot) : []) r.push(path.join(wtRoot, d, 'memory/runs'), path.join(wtRoot, d, 'memory/runs/_archive'));
            return [...r, rotated];
        },
        locationRoots: t => [wt(t), path.join(wt(t), '_archive'), runs, archive, rotated],
        log: m => logs.push(m),
    };
    return { base, repo, runs, archive, rotated, wt, clock, opts, logs };
}

function entry(key = KEY, { binding = 'full', block = {}, extra = {} } = {}) {
    const e = { rejection_key: key, journal_id: 101, at: '2026-11-13T11:00:00.000Z', note: SENTINEL, ...extra };
    if (BINDINGS[binding] !== undefined) e.binding = structuredClone(BINDINGS[binding]);
    e.diagnosis = { ...model.initialDiagnosisBlock(), ...block };
    return e;
}

function mkRun(root, name, entries = [entry()], state = {}) {
    const dir = path.join(root, name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({
        task_id: name, node: 'implement', status: 'waiting', ticket_status: 'Recusa QA', spec_hash: HEX_A,
        spec: { version: 3 }, execution_id: 'exec-1', updated_at: '2026-11-13T10:00:00.000Z', retries: 0,
        spec_notes: SENTINEL, events: [], qa_rejections: entries, ...state,
    }, null, 2));
    return dir;
}

const read = dir => JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'));
const raw = dir => fs.readFileSync(path.join(dir, 'state.json'), 'utf8');
const blkOf = (dir, key = KEY) => read(dir).qa_rejections.find(e => e.rejection_key === key).diagnosis;
const evs = (dir, type) => (read(dir).events || []).filter(e => e.type === type);
const patchState = (dir, fn) => { const s = read(dir); fn(s); fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify(s, null, 2)); };
const vfile = (dir, n, key = KEY) => path.join(dir, 'qa-diagnosis', store.slug(key).slug, store.versionFileName(n));
const qdir = (dir, key = KEY) => path.join(dir, 'qa-diagnosis', store.slug(key).slug, 'quarantine');
const qfiles = (dir, key = KEY) => (fs.existsSync(qdir(dir, key)) ? fs.readdirSync(qdir(dir, key)) : []);

/** state-writer instrumentado: profundidade de lock e contagem de mutator por operação. */
function spyWriter({ failOps = [], doubleMutator = false } = {}) {
    const spy = { depth: 0, calls: {}, ops: [] };
    spy.writer = {
        ...stateWriter,
        update(dir, mutator, o = {}) {
            if (failOps.includes(o.operation)) { const e = new Error('lock'); e.code = 'STATE_LOCK_TIMEOUT'; throw e; }
            spy.ops.push(o.operation);
            spy.depth += 1;
            spy.maxDepth = Math.max(spy.maxDepth || 0, spy.depth);
            try {
                return stateWriter.update(dir, (draft, cur) => {
                    spy.calls[o.operation] = (spy.calls[o.operation] || 0) + 1;
                    if (doubleMutator) mutator(structuredClone(draft), cur); // retryExternal: mutator reexecutado
                    return mutator(draft, cur);
                }, o);
            } finally { spy.depth -= 1; }
        },
    };
    return spy;
}

// ── AC-01 reserva ────────────────────────────────────────────────────────────────

test('AC-01: reserva de pending e de cada failed automático → collecting, job válido, rev+1, um reserved', () => {
    for (const status of ['pending', 'failed:SOURCE_UNAVAILABLE', 'failed:TIMEOUT', 'failed:FENCED', 'failed:INTERNAL']) {
        const E = env();
        const dir = mkRun(E.runs, '4242-a', [entry(KEY, { block: { status } })]);
        const r = P.reserve(dir, KEY, 0, E.opts);
        assert.equal(r.code, 'RESERVED', status);
        const b = blkOf(dir);
        assert.equal(b.status, 'collecting');
        assert.equal(b.rev, 1);
        assert.ok(model.validateBlock(b).ok);
        assert.deepEqual(b.job.snapshot, BINDINGS.full, 'snapshot = cópia do binding (14.12, quatro chaves)');
        assert.equal(b.job.lease_until, new Date(T0 + P.LEASE_MS).toISOString());
        assert.equal(evs(dir, 'qa_diagnosis_reserved').length, 1);
    }
});

test('AC-01: recusas sem escrita (bytes iguais)', () => {
    const cases = [
        ['rev diferente', {}, 5],
        ['job presente', { status: 'collecting', job: { token: 'det-x', kind: 'deterministic', target_version: 1, parent_version: 0, snapshot: BINDINGS.full, runner_binding: null, lease_until: '2026-11-13T13:00:00.000Z' } }],
        ['blocked', { blocked: { reason: 'DUPLICATE_SUBJECT', clones: ['4242-b'], detected_at: '2026-11-13T11:00:00.000Z' } }],
        ['proposed', { status: 'proposed' }], ['reviewed', { status: 'reviewed' }], ['stale', { status: 'stale' }],
        ['superseded', { status: 'superseded' }], ['failed:INTEGRITY', { status: 'failed:INTEGRITY' }],
        ['failed:SCHEMA_INVALID', { status: 'failed:SCHEMA_INVALID' }], ['bloco inválido', { rev: -1 }],
    ];
    for (const [name, block, rev = 0] of cases) {
        const E = env();
        const dir = mkRun(E.runs, '4242-a', [entry(KEY, { block })]);
        const before = raw(dir);
        const r = P.reserve(dir, KEY, rev, E.opts);
        assert.equal(r.ok, false, name);
        assert.equal(raw(dir), before, `${name}: bytes iguais`);
    }
    // backoff: failed:FENCED com qa_diagnosis_failed recente
    const E = env();
    const dir = mkRun(E.runs, '4242-a', [entry(KEY, { block: { status: 'failed:FENCED' } })], {
        events: [{ type: 'qa_diagnosis_failed', node: 'implement', ts: new Date(T0 - 60000).toISOString(), at: new Date(T0 - 60000).toISOString(), detail: `${KEY} FENCED lease` }],
    });
    const before = raw(dir);
    assert.equal(P.reserve(dir, KEY, 0, E.opts).code, 'BACKOFF');
    assert.equal(raw(dir), before);
    E.clock.t = T0 + P.BACKOFF_MS;
    assert.equal(P.reserve(dir, KEY, 0, E.opts).code, 'RESERVED', 'depois do backoff');
    // chave inválida (qa-rej:v1) e run running
    const E2 = env();
    const d2 = mkRun(E2.runs, '4242-b', [entry('qa-rej:v1:abc')]);
    const b2 = raw(d2);
    assert.equal(P.reserve(d2, 'qa-rej:v1:abc', 0, E2.opts).code, 'INVALID_KEY');
    assert.equal(raw(d2), b2);
    const d3 = mkRun(E2.runs, '4242-c', [entry()], { status: 'running' });
    const b3 = raw(d3);
    assert.equal(P.reserve(d3, KEY, 0, E2.opts).code, 'RUNNING');
    assert.equal(raw(d3), b3);
});

test('AC-01/AC-09: SLOT_OCCUPIED grava um evento sem mudar status nem rev; depois bytes iguais', () => {
    const E = env();
    const dir = mkRun(E.runs, '4242-a');
    fs.mkdirSync(path.dirname(vfile(dir, 1)), { recursive: true });
    fs.writeFileSync(vfile(dir, 1), '{"outro":"job"}\n', { mode: 0o444 });
    assert.equal(P.reserve(dir, KEY, 0, E.opts).code, 'SLOT_OCCUPIED');
    const b = blkOf(dir);
    assert.equal(b.status, 'pending');
    assert.equal(b.rev, 0);
    assert.deepEqual(evs(dir, 'qa_diagnosis_quarantined').map(e => e.detail), [`${KEY} slot v001 (sem arquivo novo)`]);
    const after = raw(dir);
    for (let i = 0; i < 3; i++) assert.equal(P.reserve(dir, KEY, 0, E.opts).code, 'SLOT_OCCUPIED');
    assert.equal(raw(dir), after, 'N ticks: um evento por (K, N)');
    assert.equal((fs.statSync(vfile(dir, 1)).mode & 0o777), 0o444, 'vN intocado');
});

test('AC-01: duas reservas do mesmo K com o mesmo rev lido → um job', () => {
    const E = env();
    const dir = mkRun(E.runs, '4242-a');
    const a = P.reserve(dir, KEY, 0, E.opts);
    const b = P.reserve(dir, KEY, 0, E.opts);
    assert.equal(a.code, 'RESERVED');
    assert.equal(b.code, 'RESERVE_CAS');
    assert.equal(evs(dir, 'qa_diagnosis_reserved').length, 1);
});

// ── AC-02 produção ───────────────────────────────────────────────────────────────

test('AC-02: staging na raiz do run, mesmo st_dev, wx; cabeçalho com null; nenhum lock na produção', () => {
    const E = env();
    const dir = mkRun(E.runs, '4242-a');
    const spy = spyWriter();
    let depthAtProduce = null;
    P._testHooks.produce = () => { depthAtProduce = spy.depth; };
    try {
        const r = P.publishKey(dir, KEY, 0, { ...E.opts, stateWriter: spy.writer });
        assert.equal(r.code, 'PROPOSED');
    } finally { P._testHooks.produce = null; }
    assert.equal(depthAtProduce, 0, 'produção fora de lock (INV-13)');
    const staging = path.join(E.runs, P.STAGING_DIR, 'det-test-1', 'v001.json');
    assert.ok(fs.existsSync(staging));
    assert.equal(fs.statSync(staging).dev, fs.statSync(dir).dev);
    const header = JSON.parse(fs.readFileSync(staging, 'utf8'));
    assert.equal(header.bindings.task_id, '4242-a');
    assert.equal(header.bindings.spec_hash, HEX_A);
    for (const k of ['dom06_attempt_ids', 'pr', 'commit']) assert.equal(header.bindings[k], null);
    for (const k of ['prisma_revision', 'consumer_ref', 'taxonomy_version', 'predicates_version', 'rules_version', 'inputs_digest']) assert.equal(header[k], null);
    assert.deepEqual(header.cost, { usd: null, tokens: null, status: 'UNKNOWN' });
    assert.ok(!JSON.stringify(header).includes(SENTINEL));
    // wx: o arquivo nunca é reaberto para escrita.
    assert.throws(() => fs.openSync(staging, 'wx'), { code: 'EEXIST' });
});

test('AC-02: task_id ausente → failed:INTERNAL sem staging; erro injetado → failed:<reason> com token cercado', () => {
    const E = env();
    const dir = mkRun(E.runs, '4242-a', [entry()], { task_id: undefined });
    patchState(dir, s => { delete s.task_id; });
    const r = P.publishKey(dir, KEY, 0, E.opts);
    assert.equal(r.code, 'FAILED_INTERNAL');
    assert.equal(blkOf(dir).status, 'failed:INTERNAL');
    assert.ok(!fs.existsSync(path.join(E.runs, P.STAGING_DIR)));
    const E2 = env();
    const d2 = mkRun(E2.runs, '4242-b');
    P._testHooks.produce = () => { const e = new Error('fonte fora'); e.reason = 'SOURCE_UNAVAILABLE'; throw e; };
    try { assert.equal(P.publishKey(d2, KEY, 0, E2.opts).code, 'FAILED_SOURCE_UNAVAILABLE'); } finally { P._testHooks.produce = null; }
    const b = blkOf(d2);
    assert.equal(b.status, 'failed:SOURCE_UNAVAILABLE');
    assert.deepEqual(b.fenced_tokens, ['det-test-1']);
    assert.equal(b.job, null);
    assert.equal(evs(d2, 'qa_diagnosis_failed').length, 1);
});

// ── AC-03 localização (D-14) ─────────────────────────────────────────────────────

function reserveAndProduce(E, dir, key = KEY) {
    const res = P.reserve(dir, key, blkOf(dir, key).rev, E.opts);
    assert.equal(res.code, 'RESERVED');
    const prod = P.produceDeterministic(dir, key, res.job, res.taskId, E.opts);
    assert.equal(prod.code, 'PRODUCED');
    return { job: res.job, file: prod.file };
}

test('AC-03: recência invertida → commit no run com K+T; dois runs com K+T → SUBJECT_CONFLICT sem escrita', () => {
    const E = env();
    const older = mkRun(E.runs, '4242-old', [entry()], { updated_at: '2026-01-01T00:00:00.000Z' });
    const newer = mkRun(E.runs, '4242-new', [entry()], { updated_at: '2026-12-01T00:00:00.000Z' });
    const { job, file } = reserveAndProduce(E, older);
    const newerBefore = raw(newer);
    const loc = P.locate(KEY, job.token, E.opts);
    assert.equal(loc.dir, older);
    assert.equal(P.commit(KEY, job.token, file, loc, E.opts).code, 'PROPOSED');
    assert.equal(raw(newer), newerBefore);
    // clone com o mesmo job → conflito
    const clone = path.join(E.runs, '4242-clone');
    fs.mkdirSync(clone);
    const s = read(newer);
    s.qa_rejections[0].diagnosis = structuredClone(blkOf(older));
    s.qa_rejections[0].diagnosis.job = { ...job };
    s.qa_rejections[0].diagnosis.status = 'collecting';
    fs.writeFileSync(path.join(clone, 'state.json'), JSON.stringify(s));
    const s2 = read(older); s2.qa_rejections[0].diagnosis = structuredClone(s.qa_rejections[0].diagnosis);
    fs.writeFileSync(path.join(older, 'state.json'), JSON.stringify(s2));
    const b1 = raw(clone); const b2 = raw(older);
    assert.equal(P.locate(KEY, job.token, E.opts).code, 'SUBJECT_CONFLICT');
    assert.equal(raw(clone), b1); assert.equal(raw(older), b2);
});

test('AC-03: archive entre a localização e o commit → relocaliza e publica no destino', () => {
    const E = env();
    const dir = mkRun(E.runs, '4242-a');
    const { job, file } = reserveAndProduce(E, dir);
    const loc = P.locate(KEY, job.token, E.opts);
    const target = path.join(E.archive, '4242-a');
    stateWriter.archive(dir, target);
    const r = P.commit(KEY, job.token, file, loc, E.opts);
    assert.equal(r.code, 'PROPOSED');
    assert.equal(r.dir, target);
    assert.equal(blkOf(target).status, 'proposed');
    assert.ok(!fs.existsSync(dir), 'nada no caminho antigo');
});

test('AC-03: diretório reutilizado com o nome antigo não é subject; rotação e worktree são localizados', () => {
    const E = env();
    const dir = mkRun(E.runs, '4242-a');
    const { job } = reserveAndProduce(E, dir);
    stateWriter.archive(dir, path.join(E.archive, '4242-a'));
    mkRun(E.runs, '4242-a'); // mesmo nome, sem o token
    assert.equal(P.locate(KEY, job.token, E.opts).dir, path.join(E.archive, '4242-a'));
    for (const root of [E.rotated, E.wt(4242)]) {
        const E2 = env();
        const r = root === E.rotated ? E2.rotated : E2.wt(4242);
        const d = mkRun(r, '4242-z');
        const p = reserveAndProduce(E2, d);
        assert.equal(P.locate(KEY, p.job.token, E2.opts).dir, d);
    }
    // fora das raízes de localização (worktree de outro ticket) → nunca é subject
    const E3 = env();
    const other = mkRun(E3.wt(9999), '4242-x');
    fs.mkdirSync(E3.wt(9999), { recursive: true });
    const res = P.reserve(other, KEY, 0, E3.opts);
    const prod = P.produceDeterministic(other, KEY, res.job, res.taskId, E3.opts);
    assert.equal(P.locate(KEY, res.job.token, E3.opts).code, 'LOST');
    assert.ok(prod.ok);
});

test('AC-03: token só em fenced_tokens → quarentena nesse run com um evento; segunda chamada bytes iguais', () => {
    const E = env();
    const dir = mkRun(E.runs, '4242-a');
    const { job, file } = reserveAndProduce(E, dir);
    E.clock.t = T0 + P.LEASE_MS + 1;
    P.tick(E.opts); // 9.2 cerca
    assert.equal(blkOf(dir).status, 'failed:FENCED');
    P.tick(E.opts); // 9.3 (índice do tick novo): localizador de recusa → quarentena
    const after = raw(dir);
    const r = P.commit(KEY, job.token, file, { dir }, E.opts);
    assert.equal(r.code, 'ALREADY');
    assert.equal(raw(dir), after);
    assert.equal(evs(dir, 'qa_diagnosis_quarantined').filter(e => e.detail.includes('late_token')).length, 1);
});

// ── AC-04 commit (D-05) ──────────────────────────────────────────────────────────

test('AC-04: caminho feliz — mesmo inode, 0444, um write com versão, ponteiro, status, job null, evento, rev+1', () => {
    const E = env();
    const dir = mkRun(E.runs, '4242-a');
    const spy = spyWriter();
    const r = P.publishKey(dir, KEY, 0, { ...E.opts, stateWriter: spy.writer });
    assert.equal(r.code, 'PROPOSED');
    const b = blkOf(dir);
    assert.equal(b.status, 'proposed');
    assert.equal(b.current_version, 1);
    assert.equal(b.job, null);
    assert.equal(b.rev, 2);
    assert.equal(b.versions.length, 1);
    const staging = path.join(E.runs, P.STAGING_DIR, 'det-test-1', 'v001.json');
    const st = fs.statSync(vfile(dir, 1));
    assert.equal(st.ino, fs.statSync(staging).ino);
    assert.equal(st.mode & 0o777, 0o444);
    assert.equal(spy.calls.qa_diagnosis_commit, 1);
    assert.equal(store.verifyCurrentVersion(dir, KEY, b).result, 'OK');
    assert.equal(evs(dir, 'qa_diagnosis_proposed').length, 1);
    assert.equal(read(dir).updated_at, '2026-11-13T10:00:00.000Z', 'updated_at nunca muda');
});

test('AC-04: mutator executado duas vezes → um registro em versions[]', () => {
    const E = env();
    const dir = mkRun(E.runs, '4242-a');
    const spy = spyWriter({ doubleMutator: true });
    // A primeira execução já liga (CREATED); a reexecução cai em IDEMPOTENT (mesmo inode).
    assert.equal(P.publishKey(dir, KEY, 0, { ...E.opts, stateWriter: spy.writer }).code, 'PROPOSED_IDEMPOTENT');
    assert.equal(blkOf(dir).versions.length, 1);
});

test('AC-04: SEAL_FAILED injetado → mutator roda uma vez por commit e nada é gravado; o próximo commit promove', () => {
    const E = env();
    const dir = mkRun(E.runs, '4242-a');
    const { job, file } = reserveAndProduce(E, dir);
    const failingFs = new Proxy(fs, { get: (t, k) => (k === 'fchmodSync' ? () => { const e = new Error('perm'); e.code = 'EPERM'; throw e; } : t[k]) });
    const spy = spyWriter();
    const before = raw(dir);
    const r = P.commit(KEY, job.token, file, { dir }, { ...E.opts, fs: failingFs, stateWriter: spy.writer });
    assert.equal(r.code, 'SEAL_FAILED');
    assert.equal(spy.calls.qa_diagnosis_commit, 1);
    assert.equal(raw(dir), before, 'SEAL_FAILED não grava o state no write do commit');
    assert.equal(P.commit(KEY, job.token, file, { dir }, E.opts).code, 'PROPOSED_IDEMPOTENT');
    assert.equal(fs.statSync(vfile(dir, 1)).mode & 0o777, 0o444);
});

test('AC-04/AC-07c: CONFLICT (vN com outros bytes) e IDEMPOTENT com inode diferente → failed:FENCED, vN intocado', () => {
    for (const variant of ['outros bytes', 'mesmos bytes, outro inode']) {
        const E = env();
        const dir = mkRun(E.runs, '4242-a');
        const { job, file } = reserveAndProduce(E, dir);
        fs.mkdirSync(path.dirname(vfile(dir, 1)), { recursive: true });
        fs.writeFileSync(vfile(dir, 1), variant === 'outros bytes' ? '{"x":1}\n' : fs.readFileSync(file), { mode: 0o444 });
        const vnBefore = fs.readFileSync(vfile(dir, 1));
        const r = P.commit(KEY, job.token, file, { dir }, E.opts);
        assert.equal(r.code, 'CONFLICT', variant);
        const b = blkOf(dir);
        assert.equal(b.status, 'failed:FENCED');
        assert.equal(b.current_version, 0);
        assert.deepEqual(fs.readFileSync(vfile(dir, 1)), vnBefore);
        assert.equal(evs(dir, 'qa_diagnosis_failed').length, 1);
        assert.equal(evs(dir, 'qa_diagnosis_quarantined').length, 1);
        assert.ok(evs(dir, 'qa_diagnosis_failed')[0].detail.includes('conflict v001'));
    }
});

test('AC-07c: o link só acontece dentro da seção crítica do commit, depois da admissão', () => {
    const E = env();
    const dir = mkRun(E.runs, '4242-a');
    const spy = spyWriter();
    const orig = store.createVersionExclusive;
    const seen = [];
    store.createVersionExclusive = function spied(...args) { seen.push({ depth: spy.depth, op: spy.ops[spy.ops.length - 1] }); return orig.apply(this, args); };
    try { P.publishKey(dir, KEY, 0, { ...E.opts, stateWriter: spy.writer }); } finally { store.createVersionExclusive = orig; }
    assert.deepEqual(seen, [{ depth: 1, op: 'qa_diagnosis_commit' }]);
});

// ── AC-05 admissão ───────────────────────────────────────────────────────────────

test('AC-05: retry que só muda execution_id publica; snapshot e bindings vêm do binding, não do state', () => {
    const E = env();
    const dir = mkRun(E.runs, '4242-a');
    patchState(dir, s => { s.execution_id = 'exec-pos-clique'; });
    assert.equal(P.publishKey(dir, KEY, 0, E.opts).code, 'PROPOSED');
    const header = JSON.parse(fs.readFileSync(vfile(dir, 1), 'utf8'));
    assert.equal(header.bindings.execution_id, 'exec-1', 'o execution_id pós-clique não entra');
    // Binding diferente do state: a reserva copia o binding (mutação "a reserva lê o state").
    const E2 = env();
    const d2 = mkRun(E2.runs, '4242-b', [entry(KEY, { binding: 'partial' })]);
    const res = P.reserve(d2, KEY, 0, E2.opts);
    assert.deepEqual(res.job.snapshot, BINDINGS.partial);
});

test('AC-05: (b)…(g), st_dev e LINK_REFUSED → linha exata; current_version nunca regride', () => {
    const E = env();
    const dir = mkRun(E.runs, '4242-a');
    const { job, file } = reserveAndProduce(E, dir);
    const refuseFs = new Proxy(fs, { get: (t, k) => (k === 'linkSync' ? () => { const e = new Error('xdev'); e.code = 'EXDEV'; throw e; } : t[k]) });
    const r = P.commit(KEY, job.token, file, { dir }, { ...E.opts, fs: refuseFs });
    assert.equal(r.code, 'LINK_REFUSED');
    assert.equal(blkOf(dir).status, 'failed:FENCED');
    assert.equal(blkOf(dir).current_version, 0);
    // (d) parent/target incoerentes
    const E2 = env();
    const d2 = mkRun(E2.runs, '4242-b');
    const p2 = reserveAndProduce(E2, d2);
    patchState(d2, s => { s.qa_rejections[0].diagnosis.job.target_version = 2; s.qa_rejections[0].diagnosis.job.parent_version = 1; });
    assert.equal(P.commit(KEY, p2.job.token, p2.file, { dir: d2 }, E2.opts).code, 'INTERNAL');
    assert.equal(blkOf(d2).status, 'failed:INTERNAL');
});

// ── AC-06 lease e cerco ──────────────────────────────────────────────────────────

test('AC-06: lease vencido → cerco, failed:FENCED, um evento; segundo tick não grava; produtor tardio → quarentena', () => {
    const E = env();
    const dir = mkRun(E.runs, '4242-a');
    const res = P.reserve(dir, KEY, 0, E.opts);
    E.clock.t = T0 + P.LEASE_MS;
    P.tick(E.opts);
    const b = blkOf(dir);
    assert.equal(b.status, 'failed:FENCED');
    assert.deepEqual(b.fenced_tokens, [res.job.token]);
    assert.equal(evs(dir, 'qa_diagnosis_failed').length, 1);
    const after = raw(dir);
    P.tick(E.opts);
    assert.equal(raw(dir), after, 'segundo tick (dentro do backoff) não grava');
    // produtor cercado termina depois
    const prod = P.produceDeterministic(dir, KEY, res.job, '4242-a', E.opts);
    const loc = P.locate(KEY, res.job.token, E.opts);
    assert.equal(loc.code, 'FENCED');
    assert.equal(P.quarantineLate(loc.dir, KEY, res.job.token, prod.file, E.opts).code, 'QUARANTINED');
    assert.equal(blkOf(dir).status, 'failed:FENCED', 'sem desfazer o status');
});

// ── AC-07b (invalidação antes do commit, sem crash) ──────────────────────────────

test('AC-07b: spec alterada e lease vencido juntos → stale, nunca failed:FENCED; sem reserva nova', () => {
    const E = env();
    const dir = mkRun(E.runs, '4242-a');
    const { job, file } = reserveAndProduce(E, dir);
    patchState(dir, s => { s.spec_hash = HEX_B; });
    E.clock.t = T0 + P.LEASE_MS + 1;
    assert.equal(P.commit(KEY, job.token, file, { dir }, E.opts).code, 'STALE');
    assert.equal(blkOf(dir).status, 'stale');
    P.tick(E.opts);
    assert.equal(blkOf(dir).status, 'stale');
    assert.equal(evs(dir, 'qa_diagnosis_reserved').length, 1);
    assert.equal(evs(dir, 'qa_diagnosis_failed').length, 0);
});

test('AC-07b/AC-10: reserve() direto de failed:FENCED com v1 publicada e spec alterada → stale no write da reserva', () => {
    const E = env();
    const dir = mkRun(E.runs, '4242-a');
    assert.equal(P.publishKey(dir, KEY, 0, E.opts).code, 'PROPOSED');
    patchState(dir, s => {
        s.qa_rejections[0].diagnosis.status = 'failed:FENCED';
        s.spec_hash = HEX_B;
        s.events.push({ type: 'qa_diagnosis_failed', node: 'implement', ts: new Date(T0 - P.BACKOFF_MS * 2).toISOString(), at: new Date(T0 - P.BACKOFF_MS * 2).toISOString(), detail: `${KEY} FENCED lease` });
    });
    const r = P.reserve(dir, KEY, blkOf(dir).rev, E.opts);
    assert.equal(r.code, 'STALE');
    assert.equal(blkOf(dir).status, 'stale');
    assert.equal(blkOf(dir).job, null);
});

test('AC-07b: (e) uniforme — cabeçalho trocado dá SCHEMA_INVALID no commit e no reconciliador', () => {
    for (const where of ['commit', 'reconciliador']) {
        const E = env();
        const dir = mkRun(E.runs, '4242-a');
        const res = P.reserve(dir, KEY, 0, E.opts);
        const bad = { ...res.job, token: 'det-outro' };
        const stagingDir = path.join(E.runs, P.STAGING_DIR, res.job.token);
        fs.mkdirSync(stagingDir, { recursive: true });
        const file = path.join(stagingDir, 'v001.json');
        fs.writeFileSync(file, model.serialize(P.buildDeterministicVersion(KEY, bad, '4242-a', T0)), { flag: 'wx' });
        if (where === 'commit') assert.equal(P.commit(KEY, res.job.token, file, { dir }, E.opts).code, 'SCHEMA_INVALID');
        else P.tick(E.opts);
        const b = blkOf(dir);
        assert.equal(b.status, 'failed:SCHEMA_INVALID', where);
        assert.equal(b.current_version, 0);
        assert.ok(qfiles(dir).length >= 1, `${where}: quarentena`);
    }
});

test('AC-07b: releitura do passo 2 divergente → failed:INTEGRITY, cerco e quarentena; spec alterada → stale', () => {
    const E = env();
    const dir = mkRun(E.runs, '4242-a');
    P._testHooks.beforeReread = ({ file }) => { fs.chmodSync(file, 0o644); fs.appendFileSync(file, ' '); };
    try { assert.equal(P.publishKey(dir, KEY, 0, E.opts).code, 'FAILED_INTEGRITY'); } finally { P._testHooks.beforeReread = null; }
    const b = blkOf(dir);
    assert.equal(b.status, 'failed:INTEGRITY');
    assert.equal(b.job, null);
    assert.equal(b.current_version, 0);
    assert.ok(evs(dir, 'qa_diagnosis_failed')[0].detail.includes('INTEGRITY:staging_sha'));
    assert.equal(qfiles(dir).length, 1);
    // com spec alterada → stale (precedência (g))
    const E2 = env();
    const d2 = mkRun(E2.runs, '4242-b');
    P._testHooks.beforeReread = ({ file }) => { fs.appendFileSync(file, ' '); patchState(d2, s => { s.spec_hash = HEX_B; }); };
    try { assert.equal(P.publishKey(d2, KEY, 0, E2.opts).code, 'STALE'); } finally { P._testHooks.beforeReread = null; }
    assert.equal(blkOf(d2).status, 'stale');
    // job de análise sobre proposed (pela função) → status mantido
    const E3 = env();
    const d3 = mkRun(E3.runs, '4242-c');
    const p3 = reserveAndProduce(E3, d3);
    patchState(d3, s => { s.qa_rejections[0].diagnosis.status = 'proposed'; });
    assert.equal(P.verifyFailJob(d3, KEY, p3.job.token, p3.file, E3.opts).code, 'FENCED_KEEP_STATUS');
    assert.equal(blkOf(d3).status, 'proposed');
    // token já cercado → só quarentena
    assert.equal(P.verifyFailJob(d3, KEY, p3.job.token, p3.file, E3.opts).code, 'QUARANTINE_ONLY');
});

test('AC-07b: failJob com snapshot divergente → stale, não failed:<auto>', () => {
    const E = env();
    const dir = mkRun(E.runs, '4242-a');
    const res = P.reserve(dir, KEY, 0, E.opts);
    patchState(dir, s => { s.spec = { version: 4 }; });
    assert.equal(P.failJob(dir, KEY, res.job.token, 'INTERNAL', E.opts).code, 'STALE');
    assert.equal(blkOf(dir).status, 'stale');
});

test('AC-07b: bloco proposed sem job com vN órfão → status igual, quarentena e um evento', () => {
    const E = env();
    const dir = mkRun(E.runs, '4242-a');
    assert.equal(P.publishKey(dir, KEY, 0, E.opts).code, 'PROPOSED');
    fs.writeFileSync(vfile(dir, 2), '{"orfao":true}\n', { mode: 0o444 });
    P.tick(E.opts);
    const b = blkOf(dir);
    assert.equal(b.status, 'proposed');
    assert.equal(b.current_version, 1);
    assert.equal(evs(dir, 'qa_diagnosis_quarantined').filter(e => e.detail.includes('orphan')).length, 1);
    const after = raw(dir);
    P.tick(E.opts);
    assert.equal(raw(dir), after, 'evento uma vez');
});

// ── AC-07c carência ──────────────────────────────────────────────────────────────

function orphanAfterLink(E, dir) {
    // Simula K4 sem crash: link feito e write do state perdido.
    const { job, file } = reserveAndProduce(E, dir);
    const r = store.createVersionExclusive(dir, KEY, 1, file);
    assert.equal(r.code, 'CREATED');
    return { job, file };
}

test('AC-07c: promotion_deferred uma vez por (T, N); carência protege do vencimento; tick seguinte promove', () => {
    const E = env();
    const dir = mkRun(E.runs, '4242-a');
    orphanAfterLink(E, dir);
    E.clock.t = T0 + P.LEASE_MS + 1;
    const spy = spyWriter({ failOps: ['qa_diagnosis_commit'] });
    P.tick({ ...E.opts, stateWriter: spy.writer });
    assert.equal(evs(dir, 'qa_diagnosis_promotion_deferred').length, 1);
    assert.equal(blkOf(dir).status, 'collecting', 'dentro da carência: nenhum cerco');
    P.tick({ ...E.opts, stateWriter: spy.writer });
    assert.equal(evs(dir, 'qa_diagnosis_promotion_deferred').length, 1, 'uma vez por (T, N)');
    P.tick(E.opts);
    assert.equal(blkOf(dir).status, 'proposed');
});

test('AC-07c: carência que vence → FENCED promotion_deferred, vN na quarentena, reserva seguinte → SLOT_OCCUPIED', () => {
    const E = env();
    const dir = mkRun(E.runs, '4242-a');
    orphanAfterLink(E, dir);
    E.clock.t = T0 + P.LEASE_MS + 1;
    const spy = spyWriter({ failOps: ['qa_diagnosis_commit'] });
    P.tick({ ...E.opts, stateWriter: spy.writer });
    E.clock.t += P.LEASE_MS;
    P.tick(E.opts);
    const b = blkOf(dir);
    assert.equal(b.status, 'failed:FENCED');
    assert.ok(evs(dir, 'qa_diagnosis_failed').some(e => e.detail.includes('promotion_deferred')));
    assert.ok(qfiles(dir).length >= 1);
    E.clock.t += P.BACKOFF_MS;
    assert.equal(P.reserve(dir, KEY, blkOf(dir).rev, E.opts).code, 'SLOT_OCCUPIED');
});

test('AC-07c (AI1-02): promoção que falha com código não transitório também abre a carência e termina', () => {
    const E = env();
    const dir = mkRun(E.runs, '4242-a');
    orphanAfterLink(E, dir);
    E.clock.t = T0 + P.LEASE_MS + 1;
    // Falha não transitória no commit: o store devolve SYMLINK_OR_NOT_DIR (fora de PROMOTION_TRANSIENT),
    // simulado por lstat que vê o diretório da chave como symlink só durante o commit.
    let inCommit = false;
    const odd = { ...stateWriter, update(d, m, o = {}) { inCommit = o.operation === 'qa_diagnosis_commit'; try { return stateWriter.update(d, m, o); } finally { inCommit = false; } } };
    const keyDir = path.dirname(vfile(dir, 1));
    const symFs = new Proxy(fs, {
        get: (t, k) => (k === 'lstatSync' ? (p, ...a) => {
            const st = t.lstatSync(p, ...a);
            if (!inCommit || p !== keyDir) return st;
            const fake = Object.create(Object.getPrototypeOf(st));
            return Object.assign(fake, st, { isSymbolicLink: () => true });
        } : t[k]),
    });
    const report = P.tick({ ...E.opts, stateWriter: odd, fs: symFs });
    assert.ok(report.reconcile.some(r => r.cause === 'SYMLINK_OR_NOT_DIR' && r.transient === false), JSON.stringify(report.reconcile));
    assert.equal(evs(dir, 'qa_diagnosis_promotion_deferred').length, 1);
    E.clock.t += P.LEASE_MS;
    P.tick({ ...E.opts, stateWriter: odd, fs: symFs });
    assert.equal(blkOf(dir).status, 'failed:FENCED', 'a carência vence e cerca');
});

test('AC-07c: com clonesOf(K) > 1 nenhum promotion_deferred é gravado e não há promoção', () => {
    const E = env();
    const dir = mkRun(E.runs, '4242-a');
    orphanAfterLink(E, dir);
    E.clock.t = T0 + P.LEASE_MS + 1;
    const spy = spyWriter({ failOps: ['qa_diagnosis_commit'] });
    P.tick({ ...E.opts, stateWriter: spy.writer, clonesOf: () => 2 });
    assert.equal(evs(dir, 'qa_diagnosis_promotion_deferred').length, 0);
    assert.equal(blkOf(dir).current_version, 0);
});

// ── AC-08 INTEGRITY ──────────────────────────────────────────────────────────────

test('AC-08: MISSING, SHA_MISMATCH e NOT_REGULAR de proposed/reviewed → failed:INTEGRITY, um evento, sem republicação', () => {
    for (const from of ['proposed', 'reviewed']) {
        for (const damage of ['MISSING', 'SHA_MISMATCH', 'NOT_REGULAR']) {
            const E = env();
            const dir = mkRun(E.runs, '4242-a');
            assert.equal(P.publishKey(dir, KEY, 0, E.opts).code, 'PROPOSED');
            patchState(dir, s => { s.qa_rejections[0].diagnosis.status = from; });
            const f = vfile(dir, 1);
            fs.chmodSync(f, 0o644);
            fs.unlinkSync(f);
            if (damage === 'SHA_MISMATCH') fs.writeFileSync(f, '{}\n');
            if (damage === 'NOT_REGULAR') fs.mkdirSync(f);
            P.tick(E.opts);
            const b = blkOf(dir);
            assert.equal(b.status, 'failed:INTEGRITY', `${from}/${damage}`);
            assert.equal(evs(dir, 'qa_diagnosis_failed').length, 1);
            E.clock.t += P.BACKOFF_MS * 2;
            P.tick(E.opts);
            assert.equal(blkOf(dir).status, 'failed:INTEGRITY', 'sem republicação automática');
        }
    }
});

test('AC-08: stale, superseded e failed:* nunca transitam por integridade', () => {
    for (const status of ['stale', 'superseded', 'failed:FENCED']) {
        const E = env();
        const dir = mkRun(E.runs, '4242-a');
        assert.equal(P.publishKey(dir, KEY, 0, E.opts).code, 'PROPOSED');
        patchState(dir, s => {
            s.qa_rejections[0].diagnosis.status = status;
            s.events.push({ type: 'qa_diagnosis_failed', node: 'implement', ts: new Date(T0).toISOString(), at: new Date(T0).toISOString(), detail: `${KEY} FENCED lease` });
        });
        fs.chmodSync(vfile(dir, 1), 0o644);
        fs.unlinkSync(vfile(dir, 1));
        P.tick(E.opts);
        assert.equal(blkOf(dir).status, status);
    }
});

// ── AC-10 stale e superseded ─────────────────────────────────────────────────────

test('AC-10: compareBinding campo a campo — STALE, parcial, UNKNOWN, execution_id não conta, fonte spec.version', () => {
    const st = (over = {}) => ({ spec_hash: HEX_A, spec: { version: 3 }, events: [], ...over });
    assert.equal(P.compareBinding(BINDINGS.full, st()), 'OK');
    assert.equal(P.compareBinding({ ...BINDINGS.full, execution_id: 'outro' }, st()), 'OK');
    assert.equal(P.compareBinding(BINDINGS.full, st({ spec_hash: HEX_B })), 'STALE');
    assert.equal(P.compareBinding(BINDINGS.full, st({ spec: { version: 4 } })), 'STALE');
    assert.equal(P.compareBinding(BINDINGS.partial, st()), 'STALE_PARTIAL');
    assert.equal(P.compareBinding(BINDINGS.partial, st({ spec_hash: HEX_B })), 'STALE');
    assert.equal(P.compareBinding(BINDINGS.null, st()), 'STALE_UNKNOWN');
    assert.equal(P.compareBinding(P.snapshotFromBinding(undefined), st({ spec_hash: HEX_B })), 'STALE_UNKNOWN');
    assert.equal(P.compareBinding(BINDINGS.full, st({ spec: { version: 3 }, spec_hash_version: 9 })), 'OK', 'spec_hash_version não é fonte');
});

test('AC-10: UNKNOWN publica com bindings nulos, stale_check só quando muda, nunca fica stale', () => {
    const E = env();
    const dir = mkRun(E.runs, '4242-a', [entry(KEY, { binding: 'absent' })]);
    P.tick(E.opts);
    assert.equal(blkOf(dir).status, 'proposed');
    const header = JSON.parse(fs.readFileSync(vfile(dir, 1), 'utf8'));
    assert.equal(header.bindings.spec_hash, null);
    assert.equal(evs(dir, 'qa_diagnosis_stale_check').length, 1);
    patchState(dir, s => { s.spec_hash = HEX_B; });
    const before = raw(dir);
    P.tick(E.opts); P.tick(E.opts);
    assert.equal(raw(dir), before, 'dois ticks iguais → bytes iguais; nunca stale');
});

test('AC-10: parcial publica e fica stale quando o campo passa a diferir; proposed/reviewed sem job pela passada do tick', () => {
    const E = env();
    const dir = mkRun(E.runs, '4242-a', [entry(KEY, { binding: 'partial' }), entry(KEY2, { binding: 'full', block: { status: 'reviewed' } })]);
    P.tick(E.opts);
    assert.equal(blkOf(dir).status, 'proposed');
    patchState(dir, s => { s.spec_hash = HEX_B; });
    P.tick(E.opts);
    assert.equal(blkOf(dir).status, 'stale');
    assert.equal(blkOf(dir, KEY2).status, 'stale', 'reviewed sem job, run sem entrada elegível');
});

test('AC-10: failed:INTEGRITY com spec alterada continua failed:INTEGRITY', () => {
    const E = env();
    const dir = mkRun(E.runs, '4242-a', [entry(KEY, { block: { status: 'failed:INTEGRITY' } })]);
    patchState(dir, s => { s.spec_hash = HEX_B; });
    P.tick(E.opts);
    assert.equal(blkOf(dir).status, 'failed:INTEGRITY');
});

function link(prev, next, over = {}) {
    return { type: 'spec_baseline', node: 'implement', origin: 'qa_retry', previous_spec_hash: prev, new_spec_hash: next, spec_version: 3, ts: '2026-11-13T11:30:00.000Z', at: '2026-11-13T11:30:00.000Z', ...over };
}
const HEX_C = 'c'.repeat(64);

test('AC-10: cadeia de retry — aceita elos qa_retry completos; /plan, SPEC_CHANGE, versão nula → stale', () => {
    const st = events => ({ spec_hash: events.target || HEX_B, spec: { version: 3 }, events: events.list });
    assert.equal(P.compareBinding(BINDINGS.full, st({ list: [link(HEX_A, HEX_B)] })), 'OK');
    assert.equal(P.compareBinding(BINDINGS.full, st({ list: [link(HEX_A, HEX_B), link(HEX_B, HEX_C)], target: HEX_C })), 'OK', 'dois retries');
    assert.equal(P.compareBinding(BINDINGS.full, st({ list: [link(HEX_A, HEX_B), { type: 'spec_baseline', node: 'plan', ts: 'x' }] })), 'STALE', 'retry → /plan');
    assert.equal(P.compareBinding(BINDINGS.full, st({ list: [{ type: 'spec_baseline', node: 'plan', ts: 'x' }, link(HEX_A, HEX_B)] })), 'OK', '/plan antes do primeiro elo não conta, a cadeia fecha');
    assert.equal(P.compareBinding(BINDINGS.full, st({ list: [link(HEX_A, HEX_C), { type: 'spec_change_approved', ts: 'y' }, link(HEX_C, HEX_B)] })), 'STALE', 'SPEC_CHANGE no meio');
    assert.equal(P.compareBinding({ ...BINDINGS.full, spec_version: null }, st({ list: [link(HEX_A, HEX_B)] })), 'STALE', 'versão nula no vínculo');
    const sealed = { type: 'spec_version_sealed', node: 'qa_retry', ts: '2026-11-13T11:30:00.000Z' };
    assert.equal(P.compareBinding(BINDINGS.full, st({ list: [link(HEX_A, HEX_B), sealed] })), 'OK', 'elo com sealed adjacente');
    // retry real de hoje (sem origin) → stale
    const real = { type: 'spec_baseline', node: 'implement', ts: 'z', at: 'z', detail: 'retry de Recusa QA' };
    assert.equal(P.compareBinding(BINDINGS.full, st({ list: [real] })), 'STALE');
});

test('AC-10: applySuperseded — matriz do RC-6, confirmed_cause preservado, idempotente', () => {
    const base = o => ({ events: [], node: 'implement', qa_rejections: [entry(KEY, { block: { outcome: { status: 'PENDING', source: null, evidence_ref: null, at: null, confirmed_cause: { id: 'c1' }, ...o } } })] });
    for (const status of ['PENDING', 'UNKNOWN', 'HANDED_BACK_NO_CODE']) {
        const d = base({ status });
        assert.equal(P.applySuperseded(d, KEY, { newKey: KEY2, at: '2026-11-13T12:00:00.000Z' }).code, 'SUPERSEDED');
        const b = d.qa_rejections[0].diagnosis;
        assert.equal(b.status, 'superseded');
        assert.equal(b.outcome.status, 'QA_REJECTED_AGAIN');
        assert.equal(b.outcome.evidence_ref, KEY2);
        assert.deepEqual(b.outcome.confirmed_cause, { id: 'c1' });
        assert.ok(model.validateBlock(b).ok);
        const snap = JSON.stringify(d);
        assert.equal(P.applySuperseded(d, KEY, { at: '2026-11-13T12:00:00.000Z' }).code, 'IDEMPOTENT');
        assert.equal(JSON.stringify(d), snap);
    }
    for (const o of [{ status: 'QA_APPROVED' }, { status: 'WITHDRAWN' }, { status: 'QA_REJECTED_AGAIN' }, { status: 'PENDING', source: 'human_label' }]) {
        const d = base(o);
        P.applySuperseded(d, KEY, { at: '2026-11-13T12:00:00.000Z' });
        const b = d.qa_rejections[0].diagnosis;
        assert.equal(b.outcome.status, o.status);
        assert.deepEqual(b.outcome.confirmed_cause, { id: 'c1' });
        assert.equal(d.events[0].detail, `${KEY} outcome_kept:${o.status}`);
    }
    const d = base({});
    assert.equal(P.applySuperseded(d, KEY, {}).code, 'INVALID_AT', 'sem relógio implícito');
    assert.equal(P.applySuperseded(d, KEY, { at: '2026-11-13T12:00:00.000Z' }).code, 'SUPERSEDED');
    assert.equal(d.qa_rejections[0].diagnosis.outcome.evidence_ref, null, 'newKey ausente → null (UNKNOWN)');
});

// ── AC-11 eventos ────────────────────────────────────────────────────────────────

test('AC-11: detail na allowlist, sem sentinela de nota/spec; state passa no validate-state', () => {
    const E = env();
    const valid = { status: 'in_progress', retries: {}, history: [], spec: { version: 3, hash: HEX_A, hash_scope: 'default', path: 'memory/spec/4242-spec.md', status: 'active' } };
    const dir = mkRun(E.runs, '4242-a', [entry(KEY), entry(KEY2, { block: { status: 'failed:TIMEOUT' } })], valid);
    const { readAndValidateState } = require('../validate-state');
    assert.equal(readAndValidateState('4242-a', { dir }).valid, true, 'fixture válida antes');
    P.tick(E.opts);
    E.clock.t += P.LEASE_MS * 3;
    patchState(dir, s => { s.spec_hash = HEX_B; });
    P.tick(E.opts);
    const all = read(dir).events.filter(e => e.type.startsWith('qa_diagnosis_'));
    assert.ok(all.length >= 3);
    for (const e of all) {
        assert.match(e.detail, P.DETAIL_RE, e.detail);
        assert.deepEqual(Object.keys(e).sort(), ['at', 'detail', 'node', 'ts', 'type']);
    }
    assert.ok(!JSON.stringify(read(dir).events).includes(SENTINEL));
    const check = readAndValidateState('4242-a', { dir });
    assert.equal(check.valid, true, JSON.stringify(check.errors));
    assert.throws(() => P.mkDetail(KEY, 'texto com\nquebra'), /allowlist/);
});

// ── AC-14 preservação e listagens ────────────────────────────────────────────────

test('AC-14: writers que não alteram qa_rejections preservam diagnosis (job ativo) byte a byte', () => {
    const E = env();
    const dir = mkRun(E.runs, '4242-a');
    P.reserve(dir, KEY, 0, E.opts);
    const before = JSON.stringify(read(dir).qa_rejections);
    stateWriter.update(dir, d => { d.retries = 1; });
    const base = read(dir);
    stateWriter.write(dir, { ...base, ticket_status: 'Em Desenvolvimento' }, { base: structuredClone(base) });
    assert.equal(JSON.stringify(read(dir).qa_rejections), before);
    const target = path.join(E.archive, '4242-a');
    fs.mkdirSync(vfile(dir, 1).replace(/v001\.json$/, ''), { recursive: true });
    fs.writeFileSync(vfile(dir, 1), '{}');
    stateWriter.archive(dir, target);
    assert.ok(fs.existsSync(vfile(target, 1)), 'archive leva qa-diagnosis/');
    assert.equal(JSON.stringify(read(target).qa_rejections), before);
});

test('AC-14: listagens ignoram .qa-diagnosis-staging/', () => {
    const E = env();
    mkRun(E.runs, '4242-a');
    fs.mkdirSync(path.join(E.runs, P.STAGING_DIR, 'det-x'), { recursive: true });
    const names = stateWriter.runDirsOf(E.runs).map(d => path.basename(d));
    assert.ok(!names.includes(P.STAGING_DIR));
    const scanned = P.scan({ ...E.opts, fs, counters: {}, discoveryRoots: E.opts.discoveryRoots, locationRoots: E.opts.locationRoots, onlyTicket: null, log: () => {} });
    assert.ok(scanned.runs.every(r => !r.dir.includes(P.STAGING_DIR)));
});

// ── AC-12 (parte de protocolo) e AC-15 custo ─────────────────────────────────────

test('AC-12: S5 republicação depois do backoff; S6 duas pending → duas v1; failed não automático nunca; sem diagnosis nada', () => {
    const E = env();
    const s5 = mkRun(E.runs, '4242-s5', [entry(KEY, { block: { status: 'failed:SOURCE_UNAVAILABLE' } })], {
        events: [{ type: 'qa_diagnosis_failed', node: 'implement', ts: new Date(T0 - 60000).toISOString(), at: new Date(T0 - 60000).toISOString(), detail: `${KEY} SOURCE_UNAVAILABLE` }],
    });
    const s6 = mkRun(E.runs, '4242-s6', [entry(KEY), entry(KEY2)]);
    const never = mkRun(E.runs, '4242-n', [entry(KEY, { block: { status: 'failed:SCHEMA_INVALID' } })]);
    const legacy = mkRun(E.runs, '4242-l', [{ rejection_key: 'qa-rej:v1:abc', note: SENTINEL }, { rejection_key: KEY, note: SENTINEL }]);
    const wt = mkRun(E.wt(4242), '4242-wt');
    const neverB = raw(never); const legacyB = raw(legacy);
    P.tick(E.opts);
    assert.equal(blkOf(s5).status, 'failed:SOURCE_UNAVAILABLE', 'dentro do backoff');
    assert.equal(blkOf(s6).current_version, 1);
    assert.equal(blkOf(s6, KEY2).current_version, 1);
    assert.equal(blkOf(wt).status, 'proposed', 'run no worktree sintético');
    E.clock.t += P.BACKOFF_MS;
    P.tick(E.opts);
    assert.equal(blkOf(s5).status, 'proposed', 'S5 republicada');
    assert.equal(raw(never), neverB);
    assert.equal(raw(legacy), legacyB, 'sem diagnosis (inclusive qa-rej:v1) → nada criado');
    const idle = raw(s6);
    P.tick(E.opts); P.tick(E.opts);
    assert.equal(raw(s6), idle, 'dois ticks ociosos → bytes iguais');
});

test('AC-12: onlyTicket processa só o ticket', () => {
    const E = env();
    const a = mkRun(E.runs, '4242-a');
    const other = mkRun(E.runs, '5151-a', [entry('redmine:5151:j9')]);
    const b = raw(other);
    P.tick({ ...E.opts, onlyTicket: 4242 });
    assert.equal(blkOf(a).status, 'proposed');
    assert.equal(raw(other), b);
});

test('AC-15: 1.200 runs (50 com bloco) e 500 stagings (metade LOST) ≤ 2 s; cada state.json lido uma vez pela varredura', () => {
    const E = env();
    for (let i = 0; i < 1200; i++) {
        const withBlock = i < 50;
        mkRun(E.runs, `4242-r${i}`, withBlock ? [entry(KEY, { block: { status: 'proposed' } })] : [{ rejection_key: 'qa-rej:v1:x' }]);
    }
    for (let i = 0; i < 500; i++) {
        const d = path.join(E.runs, P.STAGING_DIR, `det-s${i}`);
        fs.mkdirSync(d, { recursive: true });
        fs.writeFileSync(path.join(d, 'v001.json'), '{}');
        if (i % 2 === 0) fs.linkSync(path.join(d, 'v001.json'), path.join(d, 'extra'));
    }
    const counters = { stateReads: 0, scanReads: 0 };
    const t = process.hrtime.bigint();
    P.tick({ ...E.opts, counters });
    const ms = Number(process.hrtime.bigint() - t) / 1e6;
    console.log(`# AC-15: passo sobre 1200 runs/500 stagings em ${ms.toFixed(0)} ms (scanReads=${counters.scanReads})`);
    assert.ok(ms <= 2000, `${ms} ms`);
    assert.equal(counters.scanReads, 1200, 'a varredura lê cada state.json no máximo uma vez');
});

test('AC-15: no máximo um L_run por vez e nenhum lock na varredura', () => {
    const E = env();
    mkRun(E.runs, '4242-a', [entry(KEY), entry(KEY2)]);
    const spy = spyWriter();
    let maxDepth = 0;
    const writer = { ...spy.writer, update: (...a) => { const r = spy.writer.update(...a); maxDepth = Math.max(maxDepth, spy.maxDepth); return r; } };
    P.tick({ ...E.opts, stateWriter: writer });
    assert.equal(spy.depth, 0, 'nenhum lock fica preso');
    assert.equal(maxDepth, 1, 'no máximo um L_run por vez (nenhum aninhado)');
});

test('cas.SKIP vem do cas do repo', () => { assert.equal(typeof cas.SKIP, 'symbol'); });

// ── OI1-01 (G3 Opus r1): AC-05 dirigido e mutações M7/M12 ────────────────────────

test('AC-05 (c) no commit: now ≥ lease_until sem vN de mesmo inode → failed:FENCED (FENCED lease), quarentena', () => {
    const E = env();
    const dir = mkRun(E.runs, '4242-a');
    const { job, file } = reserveAndProduce(E, dir);
    E.clock.t = T0 + P.LEASE_MS;
    assert.equal(P.commit(KEY, job.token, file, { dir }, E.opts).code, 'FENCED_LEASE');
    const b = blkOf(dir);
    assert.equal(b.status, 'failed:FENCED');
    assert.equal(b.current_version, 0);
    assert.ok(!fs.existsSync(vfile(dir, 1)), 'sem link depois do lease');
    assert.ok(evs(dir, 'qa_diagnosis_failed')[0].detail.endsWith('FENCED lease'));
    assert.equal(qfiles(dir).length, 1);
});

test('AC-05 (b): token cercado no commit → só quarentena (late_token), status inalterado', () => {
    const E = env();
    const dir = mkRun(E.runs, '4242-a');
    const { job, file } = reserveAndProduce(E, dir);
    assert.equal(P.failJob(dir, KEY, job.token, 'TIMEOUT', E.opts).code, 'FAILED_TIMEOUT');
    const r = P.commit(KEY, job.token, file, { dir }, E.opts);
    assert.equal(r.code, 'QUARANTINED');
    assert.equal(blkOf(dir).status, 'failed:TIMEOUT');
    assert.equal(blkOf(dir).current_version, 0);
    assert.ok(evs(dir, 'qa_diagnosis_quarantined').some(e => e.detail.includes('late_token')));
});

test('AC-05 (f): status ≠ collecting com job T (bug) → cerca sem mudar status, mesmo com spec alterada (OI1-02)', () => {
    const E = env();
    const dir = mkRun(E.runs, '4242-a');
    const { job, file } = reserveAndProduce(E, dir);
    patchState(dir, s => { s.qa_rejections[0].diagnosis.status = 'proposed'; s.spec_hash = HEX_B; });
    assert.equal(P.commit(KEY, job.token, file, { dir }, E.opts).code, 'FENCED_BUG');
    const b = blkOf(dir);
    assert.equal(b.status, 'proposed');
    assert.equal(b.job, null);
    assert.deepEqual(b.fenced_tokens, [job.token]);
});

test('AC-05 CROSS_DEVICE: staging em outro st_dev → failed:FENCED, sem link', () => {
    const E = env();
    const dir = mkRun(E.runs, '4242-a');
    const { job, file } = reserveAndProduce(E, dir);
    const otherDev = new Proxy(fs, {
        get: (t, k) => (k === 'lstatSync' ? (p, ...a) => {
            const st = t.lstatSync(p, ...a);
            if (p !== file) return st;
            const fake = Object.create(Object.getPrototypeOf(st));
            return Object.assign(fake, st, { dev: st.dev + 1 });
        } : t[k]),
    });
    assert.equal(P.commit(KEY, job.token, file, { dir }, { ...E.opts, fs: otherDev }).code, 'CROSS_DEVICE');
    assert.equal(blkOf(dir).status, 'failed:FENCED');
    assert.ok(!fs.existsSync(vfile(dir, 1)));
});

test('AC-10 cadeia (mutação da cadeia de retry): spec_baseline completo mas sem origin "qa_retry" não é elo → stale', () => {
    const noOrigin = { ...link(HEX_A, HEX_B) };
    delete noOrigin.origin;
    assert.equal(P.compareBinding(BINDINGS.full, { spec_hash: HEX_B, spec: { version: 3 }, events: [noOrigin] }), 'STALE');
    const otherOrigin = link(HEX_A, HEX_B, { origin: 'plan' });
    assert.equal(P.compareBinding(BINDINGS.full, { spec_hash: HEX_B, spec: { version: 3 }, events: [otherOrigin] }), 'STALE');
    // elo do retry seguido de spec_baseline sem origin → stale
    assert.equal(P.compareBinding(BINDINGS.full, { spec_hash: HEX_C, spec: { version: 3 }, events: [link(HEX_A, HEX_B), { ...noOrigin, previous_spec_hash: HEX_B, new_spec_hash: HEX_C }] }), 'STALE');
});

test('OI1-03: 9.2 com carência vencida e spec alterada → stale, não FENCED promotion_deferred', () => {
    const E = env();
    const dir = mkRun(E.runs, '4242-a');
    orphanAfterLink(E, dir);
    E.clock.t = T0 + P.LEASE_MS + 1;
    const spy = spyWriter({ failOps: ['qa_diagnosis_commit'] });
    P.tick({ ...E.opts, stateWriter: spy.writer });
    E.clock.t += P.LEASE_MS;
    patchState(dir, s => { s.spec_hash = HEX_B; });
    P.tick({ ...E.opts, stateWriter: spy.writer }); // a 9.1 falha de novo; a 9.2 decide
    assert.equal(blkOf(dir).status, 'stale');
    // OI2-01: a 9.2 aplica a (g) antes da carência; nunca passa por FENCED promotion_deferred.
    assert.ok(!evs(dir, 'qa_diagnosis_failed').some(e => e.detail.includes('promotion_deferred')));
});
