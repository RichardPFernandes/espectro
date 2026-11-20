'use strict';
// PRI-181 c2b-2-protocol (SPEC-c2b-2-protocol r5.1): AC-07 (D-06 por execução). Processo filho
// real, morto por SIGKILL num ponto K1–K6; o pai ESPERA o exit do filho (spawnSync) antes do
// tick() de reinício, porque um zumbi não reapado parece vivo para o breakIfStale (P3).
// O mesmo arquivo é o filho quando C2B2_CRASH_CHILD está definido.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const P = require('./qa-diagnosis-protocol');
const model = require('./qa-diagnosis-model');
const store = require('./qa-diagnosis-store');
const stateWriter = require('../state-writer');
const cas = require('../cas');

const HEX_A = 'a'.repeat(64);
const T0 = Date.parse('2026-11-13T12:00:00.000Z');
const KEY = 'redmine:4242:j101';
const die = () => process.kill(process.pid, 'SIGKILL');
let tokenSeq = 0;

function optsFor(cfg, now) {
    return {
        stateWriter, cas,
        now: () => now.t,
        token: () => `det-crash-${process.pid}-${++tokenSeq}`,
        discoveryRoots: () => cfg.roots,
        locationRoots: () => cfg.roots,
        log: () => {},
    };
}

function runChild() {
    const cfg = JSON.parse(process.env.C2B2_CRASH_CHILD);
    const now = { t: cfg.now };
    const opts = optsFor(cfg, now);
    const point = cfg.point;
    if (point === 'K1') P._testHooks.afterReserve = die;
    if (point === 'K2') P._testHooks.duringStagingWrite = ({ fd, bytes }) => { fs.writeSync(fd, bytes, 0, Math.floor(bytes.length / 2), 0); fs.fsyncSync(fd); die(); };
    if (point === 'K3') P._testHooks.afterStaging = die;
    if (point === 'K4') P._testHooks.afterLink = die;
    if (point === 'K5') {
        // Depois do write e antes de liberar o lock: o lock é reentrante, então o filho o segura por fora.
        opts.stateWriter = {
            ...stateWriter,
            update(dir, mutator, o = {}) {
                if (o.operation !== 'qa_diagnosis_commit') return stateWriter.update(dir, mutator, o);
                stateWriter.acquireLock(stateWriter.statePath(dir));
                const r = stateWriter.update(dir, mutator, o);
                die();
                return r;
            },
        };
    }
    if (point === 'K6') opts.fs = new Proxy(fs, { get: (t, k) => (k === 'fchmodSync' ? die : t[k]) });
    P.publishKey(cfg.dir, KEY, cfg.rev, opts);
    process.exit(0); // não chegou ao ponto: o pai acusa
}

if (process.env.C2B2_CRASH_CHILD) {
    runChild();
} else {
    const test = require('node:test');
    const assert = require('node:assert/strict');

    function env() {
        const base = fs.mkdtempSync(path.join(os.tmpdir(), 'c2b2-crash-'));
        const runs = path.join(base, 'memory/runs');
        const archive = path.join(runs, '_archive');
        fs.mkdirSync(archive, { recursive: true });
        const now = { t: T0 };
        const cfg = { roots: [runs, archive] };
        return { base, runs, archive, now, cfg, opts: () => optsFor(cfg, now) };
    }

    function mkRun(root, name, block = {}, extra = {}) {
        const dir = path.join(root, name);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({
            task_id: name, node: 'implement', status: 'blocked', spec_hash: HEX_A, spec: { version: 3 }, events: [],
            qa_rejections: [{ rejection_key: KEY, binding: { execution_id: 'exec-1', spec_hash: HEX_A, spec_version: 3, reason: 'contemporaneous' }, diagnosis: { ...model.initialDiagnosisBlock(), ...block } }],
            ...extra,
        }, null, 2));
        return dir;
    }

    const read = dir => JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'));
    const blk = dir => read(dir).qa_rejections[0].diagnosis;
    const vfile = (dir, n) => path.join(dir, 'qa-diagnosis', store.slug(KEY).slug, store.versionFileName(n));
    const stagings = E => { const b = path.join(E.runs, P.STAGING_DIR); return fs.existsSync(b) ? fs.readdirSync(b).map(t => path.join(b, t)) : []; };

    function crash(E, dir, point) {
        const cfg = { ...E.cfg, point, dir, rev: blk(dir).rev, now: E.now.t };
        const r = spawnSync(process.execPath, [__filename], { env: { ...process.env, C2B2_CRASH_CHILD: JSON.stringify(cfg) }, encoding: 'utf8', timeout: 60000 });
        assert.equal(r.signal, 'SIGKILL', `filho não morreu em ${point}: status=${r.status} ${r.stderr}`);
    }

    function failingWriter(ops) {
        return { ...stateWriter, update(dir, m, o = {}) { if (ops.includes(o.operation)) { const e = new Error('lock'); e.code = 'STATE_LOCK_TIMEOUT'; throw e; } return stateWriter.update(dir, m, o); } };
    }

    test('AC-07 K1 (reserva, antes do staging), lease vencido → failed:FENCED; depois do backoff, nova reserva publica v1', () => {
        const E = env();
        const dir = mkRun(E.runs, '4242-k1');
        crash(E, dir, 'K1');
        assert.equal(blk(dir).status, 'collecting');
        E.now.t = T0 + P.LEASE_MS;
        P.tick(E.opts());
        assert.equal(blk(dir).status, 'failed:FENCED');
        E.now.t += P.BACKOFF_MS;
        P.tick(E.opts());
        assert.equal(blk(dir).status, 'proposed');
        assert.equal(blk(dir).current_version, 1);
    });

    test('AC-07 K2 (escrita parcial do staging): lease válido → nada gravado; no vencimento FENCED; nova reserva publica; parcial preservado', () => {
        const E = env();
        const dir = mkRun(E.runs, '4242-k2');
        crash(E, dir, 'K2');
        const [stagingDir] = stagings(E);
        const partial = path.join(stagingDir, 'v001.json');
        const partialBytes = fs.readFileSync(partial);
        const before = fs.readFileSync(path.join(dir, 'state.json'), 'utf8');
        P.tick(E.opts());
        assert.equal(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'), before, 'produtor interrompido: nada gravado');
        E.now.t = T0 + P.LEASE_MS;
        P.tick(E.opts());
        assert.equal(blk(dir).status, 'failed:FENCED');
        E.now.t += P.BACKOFF_MS;
        P.tick(E.opts());
        assert.equal(blk(dir).status, 'proposed');
        assert.deepEqual(fs.readFileSync(partial), partialBytes, 'staging parcial preservado');
    });

    test('AC-07 K2 com lease vencido no reinício → FENCED; nova reserva publica v1', () => {
        const E = env();
        const dir = mkRun(E.runs, '4242-k2b');
        crash(E, dir, 'K2');
        E.now.t = T0 + P.LEASE_MS + 1;
        P.tick(E.opts());
        assert.equal(blk(dir).status, 'failed:FENCED');
        E.now.t += P.BACKOFF_MS;
        P.tick(E.opts());
        assert.equal(blk(dir).current_version, 1);
    });

    test('AC-07 K3 (staging completo, antes do commit), lease válido → o reconciliador faz o commit', () => {
        const E = env();
        const dir = mkRun(E.runs, '4242-k3');
        crash(E, dir, 'K3');
        P.tick(E.opts());
        assert.equal(blk(dir).status, 'proposed');
        assert.equal(store.verifyCurrentVersion(dir, KEY, blk(dir)).result, 'OK');
    });

    test('AC-07 K4 (depois do link, antes do write), lease válido → lock quebrado, órfão promovido', () => {
        const E = env();
        const dir = mkRun(E.runs, '4242-k4');
        crash(E, dir, 'K4');
        assert.ok(fs.existsSync(vfile(dir, 1)));
        assert.equal(blk(dir).current_version, 0);
        P.tick(E.opts());
        assert.equal(blk(dir).status, 'proposed');
        assert.equal(blk(dir).current_version, 1);
    });

    test('AC-07 K4 sobre v1 (S3) → v2 promovido com parent_version 1', () => {
        const E = env();
        const dir = mkRun(E.runs, '4242-k4v1');
        assert.equal(P.publishKey(dir, KEY, 0, E.opts()).code, 'PROPOSED');
        const s = read(dir);
        s.qa_rejections[0].diagnosis.status = 'failed:FENCED';
        s.events.push({ type: 'qa_diagnosis_failed', node: 'implement', ts: new Date(T0 - P.BACKOFF_MS * 2).toISOString(), at: new Date(T0 - P.BACKOFF_MS * 2).toISOString(), detail: `${KEY} FENCED lease` });
        fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify(s));
        crash(E, dir, 'K4');
        P.tick(E.opts());
        assert.equal(blk(dir).current_version, 2);
        assert.equal(JSON.parse(fs.readFileSync(vfile(dir, 2), 'utf8')).parent_version, 1);
    });

    test('AC-07 K4 com lease vencido e sem promotion_deferred → promovido; o vencimento não cerca antes', () => {
        const E = env();
        const dir = mkRun(E.runs, '4242-k4x');
        crash(E, dir, 'K4');
        E.now.t = T0 + P.LEASE_MS * 3;
        P.tick(E.opts());
        assert.equal(blk(dir).status, 'proposed');
    });

    test('AC-07 K4 com falha transitória: promotion_deferred uma vez; carência sem cerco; tick seguinte promove', () => {
        const E = env();
        const dir = mkRun(E.runs, '4242-k4t');
        crash(E, dir, 'K4');
        E.now.t = T0 + P.LEASE_MS + 1;
        P.tick({ ...E.opts(), stateWriter: failingWriter(['qa_diagnosis_commit']) });
        assert.equal(read(dir).events.filter(e => e.type === 'qa_diagnosis_promotion_deferred').length, 1);
        assert.equal(blk(dir).status, 'collecting');
        P.tick(E.opts());
        assert.equal(blk(dir).status, 'proposed');
    });

    test('AC-07 K4 com a falha persistindo → FENCED promotion_deferred, vN na quarentena, reserva seguinte SLOT_OCCUPIED', () => {
        const E = env();
        const dir = mkRun(E.runs, '4242-k4p');
        crash(E, dir, 'K4');
        E.now.t = T0 + P.LEASE_MS + 1;
        P.tick({ ...E.opts(), stateWriter: failingWriter(['qa_diagnosis_commit']) });
        E.now.t += P.LEASE_MS;
        P.tick(E.opts());
        assert.equal(blk(dir).status, 'failed:FENCED');
        assert.ok(read(dir).events.some(e => e.type === 'qa_diagnosis_failed' && e.detail.includes('promotion_deferred')));
        E.now.t += P.BACKOFF_MS;
        assert.equal(P.reserve(dir, KEY, blk(dir).rev, E.opts()).code, 'SLOT_OCCUPIED');
    });

    test('AC-07 K4 depois de parada longa (> LEASE_MS), falha transitória e recuperação → promovido na carência', () => {
        const E = env();
        const dir = mkRun(E.runs, '4242-k4l');
        crash(E, dir, 'K4');
        E.now.t = T0 + P.LEASE_MS * 10;
        P.tick({ ...E.opts(), stateWriter: failingWriter(['qa_diagnosis_commit']) });
        E.now.t += P.LEASE_MS / 2;
        P.tick(E.opts());
        assert.equal(blk(dir).status, 'proposed');
    });

    test('AC-07 K4 + run arquivado antes do reinício → staging achado pela varredura global; promovido no destino', () => {
        const E = env();
        const dir = mkRun(E.runs, '4242-k4a');
        crash(E, dir, 'K4');
        const target = path.join(E.archive, '4242-k4a');
        stateWriter.archive(dir, target);
        P.tick(E.opts());
        assert.equal(blk(target).status, 'proposed');
        assert.equal(store.verifyCurrentVersion(target, KEY, blk(target)).result, 'OK');
    });

    test('AC-07 K5 (depois do write, antes de liberar o lock) → lock quebrado; proposed coerente', () => {
        const E = env();
        const dir = mkRun(E.runs, '4242-k5');
        crash(E, dir, 'K5');
        assert.ok(fs.existsSync(path.join(dir, 'state.json.lock')), 'lock órfão do filho');
        P.tick(E.opts());
        assert.equal(blk(dir).status, 'proposed');
        assert.equal(store.verifyCurrentVersion(dir, KEY, blk(dir)).result, 'OK');
        stateWriter.update(dir, d => { d.probe = 1; }); // o lock foi quebrado e o run aceita escrita
        assert.equal(read(dir).probe, 1);
    });

    test('AC-07 K6 (entre link e fchmod), lease válido → selado 0444 e promovido', () => {
        const E = env();
        const dir = mkRun(E.runs, '4242-k6');
        crash(E, dir, 'K6');
        assert.notEqual(fs.statSync(vfile(dir, 1)).mode & 0o777, 0o444);
        P.tick(E.opts());
        assert.equal(blk(dir).status, 'proposed');
        assert.equal(fs.statSync(vfile(dir, 1)).mode & 0o777, 0o444);
    });

    test('AC-07b: invalidação depois de K4 e antes do reconciliador — spec, superseded, lease — sem versão nova', () => {
        for (const kind of ['spec', 'superseded']) {
            const E = env();
            const dir = mkRun(E.runs, `4242-k4-${kind}`);
            crash(E, dir, 'K4');
            stateWriter.update(dir, d => {
                if (kind === 'spec') d.spec_hash = 'b'.repeat(64);
                else P.applySuperseded(d, KEY, { at: new Date(T0).toISOString() });
            });
            P.tick(E.opts());
            const b = blk(dir);
            assert.equal(b.current_version, 0, kind);
            assert.equal(b.status, kind === 'spec' ? 'stale' : 'superseded');
        }
    });
}
