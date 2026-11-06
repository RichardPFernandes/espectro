'use strict';
// PRI-181 c2b-1-model (SPEC-c2b-1-model r3.1): AC-01 (layout e slug), AC-02 (imutabilidade no
// primitivo, QRD-AC-05) e AC-04 (detecção de INTEGRITY, QRD-AC-06). Raízes temporárias e chaves
// sintéticas; falhas de I/O injetadas por stub de fs.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const model = require('./qa-diagnosis-model');
const store = require('./qa-diagnosis-store');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pri181-c2b1-store-'));
test.after(() => {
    // Teste só: as versões ficam 0444; liberar para limpar o tmp.
    const walk = d => { for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory() && !e.isSymbolicLink()) walk(p); else if (e.isFile()) { try { fs.chmodSync(p, 0o644); } catch { /* ok */ } }
    } };
    try { walk(tmp); } catch { /* ok */ }
    fs.rmSync(tmp, { recursive: true, force: true });
});

const KEY = 'redmine:900001:j900002';
let n = 0;
function newRun() {
    const dir = path.join(tmp, 'runs', `${900000 + (++n)}-synthetic`);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'state.json'), '{"task_id":"x","node":"plan","status":"in_progress"}\n');
    return dir;
}
function versionObj(over = {}) {
    return model.buildVersion({
        rejection_key: KEY, version: 1, parent_version: 0, job_token: 'job-900001-a', produced_by: 'deterministic',
        created_at: '2026-11-06T12:00:00.000Z', bindings: { task_id: '900001-synthetic' },
        analyzer: { kind: 'deterministic', runtime: 'node' }, ...over,
    });
}
function staging(runDir, over = {}, name = `stg-${++n}.json`) {
    const dir = path.join(path.dirname(path.dirname(runDir)), '.qa-diagnosis-staging');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, name);
    fs.writeFileSync(file, model.serialize(versionObj(over)), { flag: 'wx' });
    return file;
}
const mode = f => fs.lstatSync(f).mode & 0o777;
const exists = p => { try { fs.lstatSync(p); return true; } catch { return false; } };
function statWith(st, over) { return Object.assign(Object.create(Object.getPrototypeOf(st)), st, over); }

// ---------------------------------------------------------------- AC-01
test('AC-01: slug e slugToKey nas chaves sintéticas da SDD', () => {
    const keys = [KEY, 'redmine:900001:t2026-11-06T12:00:00Z', 'redmine:900001:t2026-11-06T12:00:00.123Z'];
    const slugs = keys.map(k => store.slug(k).slug);
    assert.equal(new Set(slugs).size, 3);
    keys.forEach((k, i) => assert.equal(store.slugToKey(slugs[i]), k));
    assert.equal(slugs[0], 'redmine_900001_j900002');
});

test('AC-01: propriedade — injetivo também em minúsculas, charset seguro, nunca . ou ..', () => {
    let seed = 181;
    const rnd = m => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % m; };
    const pad = (x, w) => String(x).padStart(w, '0');
    const nsChars = 'abcdefghijklmnopqrstuvwxyz0123456789-';
    const seen = new Map();
    for (let i = 0; i < 20000; i++) {
        let ns = 'abcdefghijklmnopqrstuvwxyz'[rnd(26)];
        for (let j = rnd(6); j > 0; j--) ns += nsChars[rnd(nsChars.length)];
        const issue = 1 + rnd(999999999);
        let key;
        if (rnd(2)) key = `${ns}:${issue}:j${1 + rnd(99999999)}`;
        else {
            const d = new Date(Date.UTC(2000 + rnd(40), rnd(12), 1 + rnd(28), rnd(24), rnd(60), rnd(60), rnd(1000)));
            const iso = d.toISOString();
            key = `${ns}:${issue}:t${rnd(2) ? iso : `${iso.slice(0, 19)}Z`}`;
        }
        assert.equal(model.isValidKey(key), true, key);
        const s = store.slug(key).slug;
        assert.match(s, /^[A-Za-z0-9._-]+$/);
        assert.ok(s !== '.' && s !== '..');
        assert.equal(store.slugToKey(s), key);
        const low = s.toLowerCase();
        if (seen.has(low)) assert.equal(seen.get(low), key, `colisão case-insensitive: ${key}`);
        seen.set(low, key);
    }
});

test('AC-01: nomes de versão canônicos; não canônicos são anomalia', () => {
    assert.equal(store.versionFileName(1), 'v001.json');
    assert.equal(store.versionFileName(999), 'v999.json');
    assert.equal(store.versionFileName(1000), 'v1000.json');
    assert.deepEqual(store.parseVersionFileName('v001.json'), { v: 1 });
    assert.deepEqual(store.parseVersionFileName('v1000.json'), { v: 1000 });
    for (const bad of ['v1.json', 'v0001.json', 'v000.json', 'v01000.json']) assert.deepEqual(store.parseVersionFileName(bad), { anomaly: bad });
    assert.equal(store.parseVersionFileName('state.json'), null);
});

test('AC-01: recusas tipadas sem criar nada', () => {
    const run = newRun();
    const src = staging(run);
    const r1 = store.createVersionExclusive(run, 'qa-rej:v1:t900001:j900002', 1, src);
    assert.equal(r1.code, 'INVALID_KEY');
    assert.equal(store.quarantineExclusive(run, KEY, 'Op.1', src).code, 'INVALID_TOKEN');
    const notRun = path.join(tmp, 'not-a-run');
    fs.mkdirSync(notRun, { recursive: true });
    assert.equal(store.createVersionExclusive(notRun, KEY, 1, src).code, 'NOT_A_RUN');
    assert.equal(exists(path.join(run, store.STORE_DIR)), false);
    assert.equal(exists(path.join(notRun, store.STORE_DIR)), false);
});

test('AC-01: componente symlink (qa-diagnosis, slug, quarantine) é recusado sem tocar no alvo', () => {
    const outside = fs.mkdtempSync(path.join(tmp, 'outside-'));
    const runA = newRun();
    fs.symlinkSync(outside, path.join(runA, store.STORE_DIR));
    assert.equal(store.createVersionExclusive(runA, KEY, 1, staging(runA)).code, 'SYMLINK_OR_NOT_DIR');
    const runB = newRun();
    fs.mkdirSync(path.join(runB, store.STORE_DIR));
    fs.symlinkSync(outside, path.join(runB, store.STORE_DIR, store.slug(KEY).slug));
    assert.equal(store.createVersionExclusive(runB, KEY, 1, staging(runB)).code, 'SYMLINK_OR_NOT_DIR');
    const runC = newRun();
    fs.mkdirSync(path.join(runC, store.STORE_DIR, store.slug(KEY).slug), { recursive: true });
    fs.symlinkSync(outside, path.join(runC, store.STORE_DIR, store.slug(KEY).slug, store.QUARANTINE_DIR));
    assert.equal(store.quarantineExclusive(runC, KEY, 'job-x', staging(runC)).code, 'SYMLINK_OR_NOT_DIR');
    assert.deepEqual(fs.readdirSync(outside), []);
});

test('AC-01: o módulo não lê nem escreve no store por repo (memory/qa-diagnosis)', () => {
    const src = fs.readFileSync(require.resolve('./qa-diagnosis-store'), 'utf8');
    assert.ok(!/memory['"`/]/.test(src) && !/records|AUTHORITY|repoPath/.test(src));
});

// ---------------------------------------------------------------- AC-02
test('AC-02: CREATED com o mesmo inode da origem e modo 0444; listVersions ordena e aponta anomalias', () => {
    const run = newRun();
    const src = staging(run);
    const before = fs.lstatSync(src);
    const r = store.createVersionExclusive(run, KEY, 1, src);
    assert.equal(r.ok, true);
    assert.equal(r.code, 'CREATED');
    assert.equal(fs.lstatSync(r.file).ino, before.ino);
    assert.equal(mode(r.file), 0o444);
    assert.equal(mode(src), 0o444, 'mesmo inode: staging também só leitura');
    assert.equal(r.sha256, model.sha256(fs.readFileSync(src)));
    assert.equal(path.basename(r.file), 'v001.json');
    fs.writeFileSync(path.join(path.dirname(r.file), 'v1.json'), 'x');
    const l = store.listVersions(run, KEY);
    assert.deepEqual(l.versions.map(v => v.v), [1]);
    assert.deepEqual(l.anomalies, ['v1.json']);
});

test('AC-02: escrita no staging depois do CREATED falha (EACCES)', t => {
    if (typeof process.getuid === 'function' && process.getuid() === 0) {
        t.skip('rodando como root: caso registrado como UNKNOWN, nunca PASS');
        return;
    }
    const run = newRun();
    const src = staging(run);
    assert.equal(store.createVersionExclusive(run, KEY, 1, src).code, 'CREATED');
    assert.throws(() => fs.writeFileSync(src, 'tampered'), e => e.code === 'EACCES');
});

test('AC-02: mesmo staging chamado de novo (nlink 2) → IDEMPOTENT, 0444', () => {
    const run = newRun();
    const src = staging(run);
    const first = store.createVersionExclusive(run, KEY, 1, src);
    assert.equal(first.code, 'CREATED');
    assert.equal(fs.lstatSync(src).nlink, 2);
    const again = store.createVersionExclusive(run, KEY, 1, src);
    assert.equal(again.ok, true);
    assert.equal(again.code, 'IDEMPOTENT');
    assert.equal(mode(again.file), 0o444);
});

test('AC-02: crash entre link e chmod → próxima chamada IDEMPOTENT e sela 0444', () => {
    const run = newRun();
    const src = staging(run);
    const dir = path.join(run, store.STORE_DIR, store.slug(KEY).slug);
    fs.mkdirSync(dir, { recursive: true });
    fs.linkSync(src, path.join(dir, 'v001.json')); // link feito, selagem não
    assert.notEqual(mode(path.join(dir, 'v001.json')), 0o444);
    const r = store.createVersionExclusive(run, KEY, 1, src);
    assert.equal(r.code, 'IDEMPOTENT');
    assert.equal(mode(r.file), 0o444);
});

test('AC-02: bytes iguais em outro arquivo → IDEMPOTENT; bytes diferentes → CONFLICT com destino intocado', () => {
    const run = newRun();
    assert.equal(store.createVersionExclusive(run, KEY, 1, staging(run)).code, 'CREATED');
    const same = store.createVersionExclusive(run, KEY, 1, staging(run));
    assert.equal(same.code, 'IDEMPOTENT');
    const dest = same.file;
    const bytes = fs.readFileSync(dest);
    const other = staging(run, { job_token: 'job-900001-b' });
    const c = store.createVersionExclusive(run, KEY, 1, other);
    assert.equal(c.ok, false);
    assert.equal(c.code, 'CONFLICT');
    assert.equal(Buffer.compare(fs.readFileSync(dest), bytes), 0);
});

test('AC-02: recusas antes do link, sem criar diretório', () => {
    const cases = [];
    const runA = newRun();
    const real = staging(runA);
    const link = path.join(path.dirname(real), `sym-${n}.json`);
    fs.symlinkSync(real, link);
    cases.push([runA, store.createVersionExclusive(runA, KEY, 1, link), 'SRC_NOT_REGULAR']);
    const runB = newRun();
    const src2 = staging(runB);
    fs.linkSync(src2, `${src2}.extra`);
    cases.push([runB, store.createVersionExclusive(runB, KEY, 1, src2), 'SRC_NLINK']);
    const runC = newRun();
    const srcC = staging(runC);
    const devFs = { ...fs, lstatSync: p => (p === srcC ? statWith(fs.lstatSync(p), { dev: fs.lstatSync(p).dev + 1 }) : fs.lstatSync(p)) };
    cases.push([runC, store.createVersionExclusive(runC, KEY, 1, srcC, { fs: devFs }), 'CROSS_DEVICE']);
    const runD = newRun();
    const bad = path.join(path.dirname(real), `bad-${n}.json`);
    fs.writeFileSync(bad, '{"schema":"qa-diagnosis-record/v1"}');
    cases.push([runD, store.createVersionExclusive(runD, KEY, 1, bad), 'SRC_INVALID']);
    const runE = newRun();
    cases.push([runE, store.createVersionExclusive(runE, 'redmine:900001:j900003', 1, staging(runE)), 'SRC_INVALID']);
    const runF = newRun();
    cases.push([runF, store.createVersionExclusive(runF, KEY, 2, staging(runF)), 'SRC_INVALID']);
    const runG = newRun();
    cases.push([runG, store.createVersionExclusive(runG, KEY, 2, staging(runG, { version: 2, parent_version: 0 })), 'SRC_INVALID']);
    for (const [run, r, code] of cases) {
        assert.equal(r.ok, false, code);
        assert.equal(r.code, code);
        assert.equal(exists(path.join(run, store.STORE_DIR)), false, `${code} criou diretório`);
    }
});

test('AC-02: destino symlink → ANOMALY; ino divergente após o link → ANOMALY com destino preservado', () => {
    const run = newRun();
    const dir = path.join(run, store.STORE_DIR, store.slug(KEY).slug);
    fs.mkdirSync(dir, { recursive: true });
    const elsewhere = staging(run);
    fs.symlinkSync(elsewhere, path.join(dir, 'v001.json'));
    const r = store.createVersionExclusive(run, KEY, 1, staging(run));
    assert.equal(r.code, 'ANOMALY');
    assert.equal(fs.lstatSync(path.join(dir, 'v001.json')).isSymbolicLink(), true);

    const run2 = newRun();
    const src = staging(run2);
    let linked = false;
    const inoFs = { ...fs,
        linkSync: (a, b) => { fs.linkSync(a, b); linked = true; },
        lstatSync: p => (linked && p.endsWith('v001.json') ? statWith(fs.lstatSync(p), { ino: fs.lstatSync(p).ino + 1 }) : fs.lstatSync(p)) };
    const r2 = store.createVersionExclusive(run2, KEY, 1, src, { fs: inoFs });
    assert.equal(r2.code, 'ANOMALY');
    assert.equal(exists(path.join(run2, store.STORE_DIR, store.slug(KEY).slug, 'v001.json')), true);
});

test('AC-02: EXDEV/EPERM/ENOTSUP → LINK_REFUSED sem cópia; outro erro → UNKNOWN_IO sem throw', () => {
    for (const code of ['EXDEV', 'EPERM', 'ENOTSUP', 'EIO']) {
        const run = newRun();
        const failFs = { ...fs, linkSync: () => { throw Object.assign(new Error(code), { code }); } };
        const r = store.createVersionExclusive(run, KEY, 1, staging(run), { fs: failFs });
        assert.equal(r.code, code === 'EIO' ? 'UNKNOWN_IO' : 'LINK_REFUSED');
        assert.equal(exists(path.join(run, store.STORE_DIR, store.slug(KEY).slug, 'v001.json')), false, 'sem cópia de fallback');
    }
});

test('AC-02: chmod falha → SEAL_FAILED (destino preservado) e a chamada seguinte repara', () => {
    const run = newRun();
    const src = staging(run);
    const failChmod = { ...fs, fchmodSync: () => { throw Object.assign(new Error('EPERM'), { code: 'EPERM' }); } };
    const r = store.createVersionExclusive(run, KEY, 1, src, { fs: failChmod });
    assert.equal(r.code, 'SEAL_FAILED');
    const dest = path.join(run, store.STORE_DIR, store.slug(KEY).slug, 'v001.json');
    assert.equal(exists(dest), true);
    const again = store.createVersionExclusive(run, KEY, 1, src);
    assert.equal(again.code, 'IDEMPOTENT');
    assert.equal(mode(dest), 0o444);
});

test('AC-02: releitura divergente na selagem → ANOMALY', () => {
    const run = newRun();
    const src = staging(run);
    const tamper = { ...fs, fchmodSync: (fd, m) => { fs.writeFileSync(src, 'tampered'); fs.fchmodSync(fd, m); } };
    const r = store.createVersionExclusive(run, KEY, 1, src, { fs: tamper });
    assert.equal(r.code, 'ANOMALY');
    assert.equal(r.reason, 'SHA_AFTER_LINK');
});

test('AC-02: quarentena por link — cria, idempotente, sufixo em conflito; nada apagado; 0444', () => {
    const run = newRun();
    const a = staging(run);
    const q1 = store.quarantineExclusive(run, KEY, 'job-q', a);
    assert.equal(q1.code, 'CREATED');
    assert.equal(path.basename(q1.file), 'job-q.json');
    assert.equal(mode(q1.file), 0o444);
    assert.equal(store.quarantineExclusive(run, KEY, 'job-q', a).code, 'IDEMPOTENT');
    const sameBytes = staging(run);
    assert.equal(store.quarantineExclusive(run, KEY, 'job-q', sameBytes).code, 'IDEMPOTENT');
    const other = staging(run, { job_token: 'job-900001-z' });
    const q2 = store.quarantineExclusive(run, KEY, 'job-q', other);
    assert.equal(q2.code, 'CREATED');
    assert.equal(path.basename(q2.file), 'job-q.1.json');
    assert.deepEqual(fs.readdirSync(path.dirname(q1.file)).sort(), ['job-q.1.json', 'job-q.json']);
});

test('AC-02: nenhum export reescreve, renomeia ou apaga versão; o código não usa essas primitivas', () => {
    for (const name of Object.keys(store)) assert.doesNotMatch(name, /delete|remove|rename|rewrite|unlink|overwrite|purge/i);
    const src = fs.readFileSync(require.resolve('./qa-diagnosis-store'), 'utf8');
    for (const prim of ['renameSync', 'writeFileSync', 'copyFileSync', 'cpSync', 'rmSync', 'unlinkSync', 'rmdirSync', 'appendFileSync']) {
        assert.ok(!src.includes(prim), `store usa ${prim}`);
    }
});

// ---------------------------------------------------------------- AC-04
function blockFor(file, { v = 1, sha } = {}) {
    const s = sha || model.sha256(fs.readFileSync(file));
    const versions = [];
    for (let i = 1; i <= v; i++) versions.push({ v: i, sha256: i === v ? s : 'c'.repeat(64), produced_by: 'deterministic', at: '2026-11-06T12:00:00Z' });
    return { ...model.initialDiagnosisBlock(), status: 'proposed', rev: 2, current_version: v, current_sha256: s, versions };
}

test('AC-04: OK, NO_VERSION, INTEGRITY (MISSING, SHA_MISMATCH, NOT_REGULAR) e UNKNOWN', () => {
    const run = newRun();
    const r = store.createVersionExclusive(run, KEY, 1, staging(run));
    assert.deepEqual(store.verifyCurrentVersion(run, KEY, blockFor(r.file)), { result: 'OK' });
    assert.deepEqual(store.verifyCurrentVersion(run, KEY, model.initialDiagnosisBlock()), { result: 'NO_VERSION' });
    assert.deepEqual(store.verifyCurrentVersion(run, KEY, blockFor(r.file, { v: 2, sha: 'd'.repeat(64) })), { result: 'INTEGRITY', reason: 'MISSING' });
    assert.deepEqual(store.verifyCurrentVersion(run, KEY, blockFor(r.file, { sha: 'e'.repeat(64) })), { result: 'INTEGRITY', reason: 'SHA_MISMATCH' });
    const mixed = blockFor(r.file);
    mixed.current_sha256 = mixed.versions[0].sha256;
    assert.equal(store.verifyCurrentVersion(run, KEY, { ...mixed, current_sha256: 'f'.repeat(64) }).result, 'UNKNOWN', 'bloco incoerente = BLOCK_INVALID');

    const runSym = newRun();
    const dir = path.join(runSym, store.STORE_DIR, store.slug(KEY).slug);
    fs.mkdirSync(dir, { recursive: true });
    fs.symlinkSync(r.file, path.join(dir, 'v001.json'));
    assert.deepEqual(store.verifyCurrentVersion(runSym, KEY, blockFor(r.file)), { result: 'INTEGRITY', reason: 'NOT_REGULAR' });

    assert.equal(store.verifyCurrentVersion(path.join(tmp, 'gone'), KEY, blockFor(r.file)).reason, 'RUN_GONE');
    assert.equal(store.verifyCurrentVersion(run, KEY, { rev: 1 }).reason, 'BLOCK_INVALID');
    assert.equal(store.verifyCurrentVersion(run, 'qa-rej:v1:t1:j1', blockFor(r.file)).reason, 'INVALID_KEY');
    for (const code of ['EIO', 'EACCES']) {
        const ioFs = { ...fs, openSync: () => { throw Object.assign(new Error(code), { code }); } };
        const u = store.verifyCurrentVersion(run, KEY, blockFor(r.file), { fs: ioFs });
        assert.equal(u.result, 'UNKNOWN', `${code} nunca vira OK nem INTEGRITY`);
    }
});

test('AC-04: a detecção não muda o bloco nem grava arquivo', () => {
    const run = newRun();
    const r = store.createVersionExclusive(run, KEY, 1, staging(run));
    const blk = blockFor(r.file, { sha: 'e'.repeat(64) });
    const copy = structuredClone(blk);
    const stateBefore = fs.readFileSync(path.join(run, 'state.json'));
    store.verifyCurrentVersion(run, KEY, blk);
    assert.deepEqual(blk, copy);
    assert.equal(Buffer.compare(fs.readFileSync(path.join(run, 'state.json')), stateBefore), 0);
});

// ---------------------------------------------------------------- r2 (revisão G3 do código)
test('CI-01: verifyCurrentVersion usa o critério de run — sem state.json ou run que some na leitura → UNKNOWN', () => {
    const run = newRun();
    const r = store.createVersionExclusive(run, KEY, 1, staging(run));
    const blk = blockFor(r.file);
    const noState = path.join(tmp, `nostate-${++n}`);
    fs.mkdirSync(path.join(noState, store.STORE_DIR, store.slug(KEY).slug), { recursive: true });
    assert.deepEqual(store.verifyCurrentVersion(noState, KEY, blk), { result: 'UNKNOWN', reason: 'RUN_GONE' });
    // run que some entre a leitura (ENOENT) e a reconferência: nunca INTEGRITY
    const missingBlk = blockFor(r.file, { v: 2, sha: 'd'.repeat(64) });
    let stateCalls = 0;
    const vanishing = { ...fs, lstatSync: p => {
        if (p === path.join(run, 'state.json') && ++stateCalls > 1) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
        return fs.lstatSync(p);
    } };
    assert.deepEqual(store.verifyCurrentVersion(run, KEY, missingBlk, { fs: vanishing }), { result: 'UNKNOWN', reason: 'RUN_GONE' });
    // erro de I/O em qualquer componente do caminho → UNKNOWN, nunca MISSING
    for (const comp of [store.STORE_DIR, store.slug(KEY).slug, 'v001.json']) {
        const ioFs = { ...fs, lstatSync: p => {
            if (path.basename(p) === comp) throw Object.assign(new Error('EIO'), { code: 'EIO' });
            return fs.lstatSync(p);
        } };
        assert.equal(store.verifyCurrentVersion(run, KEY, blk, { fs: ioFs }).result, 'UNKNOWN', comp);
    }
});

test('CI-01: symlink em qualquer componente (qa-diagnosis, slug, arquivo) → INTEGRITY:NOT_REGULAR', () => {
    const run = newRun();
    const r = store.createVersionExclusive(run, KEY, 1, staging(run));
    const blk = blockFor(r.file);
    const slugDir = path.join(run, store.STORE_DIR, store.slug(KEY).slug);
    const runA = newRun();
    fs.symlinkSync(path.join(run, store.STORE_DIR), path.join(runA, store.STORE_DIR));
    assert.deepEqual(store.verifyCurrentVersion(runA, KEY, blk), { result: 'INTEGRITY', reason: 'NOT_REGULAR' });
    const runB = newRun();
    fs.mkdirSync(path.join(runB, store.STORE_DIR));
    fs.symlinkSync(slugDir, path.join(runB, store.STORE_DIR, store.slug(KEY).slug));
    assert.deepEqual(store.verifyCurrentVersion(runB, KEY, blk), { result: 'INTEGRITY', reason: 'NOT_REGULAR' });
});

test('CI-02: listVersions ordena numericamente; symlink ou diretório com nome canônico é anomalia', () => {
    const run = newRun();
    for (const v of [1000, 999, 2, 1]) {
        const r = store.createVersionExclusive(run, KEY, v, staging(run, { version: v, parent_version: v - 1 }));
        assert.equal(r.code, 'CREATED', `v${v}`);
    }
    const dir = path.join(run, store.STORE_DIR, store.slug(KEY).slug);
    fs.symlinkSync(path.join(dir, 'v001.json'), path.join(dir, 'v003.json'));
    fs.mkdirSync(path.join(dir, 'v004.json'));
    const l = store.listVersions(run, KEY);
    assert.deepEqual(l.versions.map(v => v.v), [1, 2, 999, 1000], 'ordem numérica, não lexical');
    assert.deepEqual(l.anomalies.sort(), ['v003.json', 'v004.json']);
});

test('CI-03: quarentena aplica as checagens comuns e confere o inode antes de selar', () => {
    const runA = newRun();
    const real = staging(runA);
    const link = path.join(path.dirname(real), `qsym-${++n}.json`);
    fs.symlinkSync(real, link);
    assert.equal(store.quarantineExclusive(runA, KEY, 'job-q', link).code, 'SRC_NOT_REGULAR');
    const runB = newRun();
    const srcB = staging(runB);
    const devFs = { ...fs, lstatSync: p => (p === srcB ? statWith(fs.lstatSync(p), { dev: fs.lstatSync(p).dev + 1 }) : fs.lstatSync(p)) };
    assert.equal(store.quarantineExclusive(runB, KEY, 'job-q', srcB, { fs: devFs }).code, 'CROSS_DEVICE');
    const notRun = path.join(tmp, `qnotrun-${++n}`);
    fs.mkdirSync(notRun, { recursive: true });
    assert.equal(store.quarantineExclusive(notRun, KEY, 'job-q', staging(runA)).code, 'NOT_A_RUN');
    for (const d of [runA, runB, notRun]) assert.equal(exists(path.join(d, store.STORE_DIR)), false);
    const runC = newRun();
    const srcC = staging(runC);
    let linked = false;
    const inoFs = { ...fs, linkSync: (a, b) => { fs.linkSync(a, b); linked = true; },
        lstatSync: p => (linked && p.endsWith('job-q.json') ? statWith(fs.lstatSync(p), { ino: fs.lstatSync(p).ino + 1 }) : fs.lstatSync(p)) };
    const q = store.quarantineExclusive(runC, KEY, 'job-q', srcC, { fs: inoFs });
    assert.equal(q.code, 'ANOMALY');
    assert.notEqual(mode(srcC), 0o444, 'não sela inode divergente');
});

test('CI-06: slugToKey só aceita a gramática; state.json symlink não é run; slug nunca sai do diretório', () => {
    for (const bad of ['', 'qa-rej_v1_t1_j1', 'redmine_1_j1/../x', '../redmine_1_j1', 'redmine 1 j1', 'redmine_1', null, 7]) {
        assert.equal(store.slugToKey(bad), null, String(bad));
    }
    for (const k of ['redmine:1:j1/../../x', 'redmine:1:j1\u0000', '../redmine:1:j1']) assert.equal(store.slug(k).code, 'INVALID_KEY');
    const run = path.join(tmp, `symstate-${++n}`);
    fs.mkdirSync(run, { recursive: true });
    const realState = path.join(tmp, `real-state-${n}.json`);
    fs.writeFileSync(realState, '{}');
    fs.symlinkSync(realState, path.join(run, 'state.json'));
    assert.equal(store.createVersionExclusive(run, KEY, 1, staging(newRun())).code, 'NOT_A_RUN');
});

test('CI-03: selagem confere o inode pelo descritor (fstat) — versão e quarentena', () => {
    for (const kind of ['version', 'quarantine']) {
        const run = newRun();
        const src = staging(run);
        const fstatFs = { ...fs, fstatSync: fd => statWith(fs.fstatSync(fd), { ino: fs.fstatSync(fd).ino + 1 }) };
        const r = kind === 'version'
            ? store.createVersionExclusive(run, KEY, 1, src, { fs: fstatFs })
            : store.quarantineExclusive(run, KEY, 'job-q', src, { fs: fstatFs });
        assert.equal(r.code, 'ANOMALY', kind);
        assert.equal(r.reason, 'INO_AFTER_LINK', kind);
        assert.notEqual(mode(src), 0o444, `${kind}: inode divergente não é selado`);
    }
});

test('r2.1: runDir symlink ou indefinido não é run (fail closed, sem throw)', () => {
    const run = newRun();
    const r = store.createVersionExclusive(run, KEY, 1, staging(run));
    const link = path.join(tmp, `runlink-${++n}`);
    fs.symlinkSync(run, link);
    assert.deepEqual(store.verifyCurrentVersion(link, KEY, blockFor(r.file)), { result: 'UNKNOWN', reason: 'RUN_GONE' });
    assert.equal(store.createVersionExclusive(link, KEY, 1, staging(run)).code, 'NOT_A_RUN');
    for (const bad of [undefined, null, '', 7]) {
        assert.deepEqual(store.verifyCurrentVersion(bad, KEY, blockFor(r.file)), { result: 'UNKNOWN', reason: 'RUN_GONE' });
        assert.equal(store.createVersionExclusive(bad, KEY, 1, staging(run)).code, 'NOT_A_RUN');
        assert.equal(store.quarantineExclusive(bad, KEY, 'job-q', staging(run)).code, 'NOT_A_RUN');
    }
});
