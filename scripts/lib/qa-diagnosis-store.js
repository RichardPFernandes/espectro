'use strict';
// PRI-181 c2b-1-model (SPEC-c2b-1-model r3.1): store por run do Diagnosis Record (SDD B v2 §4.1).
//
//   <runDir>/qa-diagnosis/<slug>/vNNN.json                 versões imutáveis (INV-3)
//   <runDir>/qa-diagnosis/<slug>/quarantine/<token>[.<k>].json
//
// Criação exclusiva por link (§4.3 passo 4.3), nunca rename/writeFile/copyFile/force sobre
// vNNN. Sem lock e sem I/O remoto (INV-13): quem chama sob o lock do run é a c2b-2. Nada
// aqui grava state.json (INV-2) nem apaga arquivo (decisão 2). Desfecho esperado volta
// tipado ({ ok, code }); exceção só para bug. Sem chamador nesta fatia.
//
// Contrato para a c2b-2 (premissa 5): o arquivo de staging nasce por criação exclusiva (wx),
// nunca é reaberto para escrita e, depois do commit, só é removido ou ligado à quarentena.

const realFs = require('fs');
const path = require('path');
const model = require('./qa-diagnosis-model');

const STORE_DIR = 'qa-diagnosis';
const QUARANTINE_DIR = 'quarantine';
const SEALED_MODE = 0o444;
const LINK_REFUSED_ERRNOS = ['EXDEV', 'EPERM', 'ENOTSUP'];
const MAX_QUARANTINE_SUFFIX = 9999;

/** Slug injetivo (premissa 4): só a gramática da SDD; ':' → '_' ('_' não pertence à gramática). */
function slug(key) {
    if (!model.isValidKey(key)) return { ok: false, code: 'INVALID_KEY' };
    return { ok: true, slug: key.replace(/:/g, '_') };
}

function slugToKey(s) {
    if (typeof s !== 'string' || !/^[A-Za-z0-9._-]+$/.test(s)) return null;
    const key = s.replace(/_/g, ':');
    return model.isValidKey(key) ? key : null;
}

/** Nome canônico: zero à esquerda até 3 dígitos (v001, v999, v1000). */
function versionFileName(v) {
    return `v${String(v).padStart(3, '0')}.json`;
}

/** { v } para nome canônico; { anomaly } para ^v\d+\.json$ não canônico; null para o resto. */
function parseVersionFileName(name) {
    const m = /^v(\d+)\.json$/.exec(name);
    if (!m) return null;
    const v = Number(m[1]);
    if (Number.isSafeInteger(v) && v >= 1 && versionFileName(v) === name) return { v };
    return { anomaly: name };
}

function fail(code, extra = {}) { return { ok: false, code, ...extra }; }

function lstatOrNull(fs, p) {
    try { return { st: fs.lstatSync(p) }; } catch (e) { return { err: e }; }
}

function readNoFollow(fs, file) {
    let fd;
    try {
        fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
        return { bytes: fs.readFileSync(fd) };
    } catch (e) {
        return { err: e };
    } finally {
        if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* fd já fechado */ } }
    }
}

/** runDir precisa ser um run: diretório real (não symlink) com state.json regular. */
function checkRun(fs, runDir) {
    if (typeof runDir !== 'string' || runDir.length === 0) return fail('NOT_A_RUN');
    const d = lstatOrNull(fs, runDir);
    if (d.err) return d.err.code === 'ENOENT' ? fail('NOT_A_RUN') : fail('UNKNOWN_IO', { errno: d.err.code });
    if (d.st.isSymbolicLink() || !d.st.isDirectory()) return fail('NOT_A_RUN');
    const r = lstatOrNull(fs, path.join(runDir, 'state.json'));
    if (r.err) return r.err.code === 'ENOENT' ? fail('NOT_A_RUN') : fail('UNKNOWN_IO', { errno: r.err.code });
    if (!r.st.isFile() || r.st.isSymbolicLink()) return fail('NOT_A_RUN');
    return { ok: true };
}

/** Confere componentes existentes (sem criar): diretório real, nunca symlink. */
function checkDirs(fs, dirs) {
    for (const d of dirs) {
        const r = lstatOrNull(fs, d);
        if (r.err) {
            if (r.err.code === 'ENOENT') continue;
            return fail('UNKNOWN_IO', { errno: r.err.code });
        }
        if (r.st.isSymbolicLink() || !r.st.isDirectory()) return fail('SYMLINK_OR_NOT_DIR', { path: d });
    }
    return { ok: true };
}

function makeDirs(fs, dirs) {
    for (const d of dirs) {
        try { fs.mkdirSync(d); } catch (e) {
            if (e.code !== 'EEXIST') return fail('UNKNOWN_IO', { errno: e.code });
        }
        const r = lstatOrNull(fs, d);
        if (r.err) return fail('UNKNOWN_IO', { errno: r.err.code });
        if (r.st.isSymbolicLink() || !r.st.isDirectory()) return fail('SYMLINK_OR_NOT_DIR', { path: d });
    }
    return { ok: true };
}

/** Checagens comuns da origem (premissa 5): regular, não symlink, mesmo st_dev de runDir. */
function checkSource(fs, runDir, srcFile) {
    const s = lstatOrNull(fs, srcFile);
    if (s.err) return fail(s.err.code === 'ENOENT' ? 'SRC_MISSING' : 'UNKNOWN_IO', { errno: s.err.code });
    if (s.st.isSymbolicLink() || !s.st.isFile()) return fail('SRC_NOT_REGULAR');
    const r = lstatOrNull(fs, runDir);
    if (r.err) return fail('UNKNOWN_IO', { errno: r.err.code });
    if (r.st.dev !== s.st.dev) return fail('CROSS_DEVICE');
    const read = readNoFollow(fs, srcFile);
    if (read.err) return fail('UNKNOWN_IO', { errno: read.err.code });
    return { ok: true, st: s.st, bytes: read.bytes };
}

/**
 * Selagem (premissa 5): abre o destino sem seguir symlink, confere o inode esperado, garante
 * 0444 por fchmod no próprio descritor e relê pelos mesmos bytes (sha e, se pedido, validador).
 */
function seal(fs, dest, expectedSha, { validate = false, expectIno = null } = {}) {
    let fd;
    try {
        try {
            fd = fs.openSync(dest, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
        } catch (e) {
            return e.code === 'ELOOP' ? fail('ANOMALY', { reason: 'NOT_REGULAR', file: dest }) : fail('UNKNOWN_IO', { errno: e.code });
        }
        let st;
        try { st = fs.fstatSync(fd); } catch (e) { return fail('UNKNOWN_IO', { errno: e.code }); }
        if (!st.isFile()) return fail('ANOMALY', { reason: 'NOT_REGULAR', file: dest });
        if (expectIno && (st.dev !== expectIno.dev || st.ino !== expectIno.ino)) {
            return fail('ANOMALY', { reason: 'INO_AFTER_LINK', file: dest });
        }
        if ((st.mode & 0o777) !== SEALED_MODE) {
            try { fs.fchmodSync(fd, SEALED_MODE); } catch (e) {
                return fail('SEAL_FAILED', { errno: e.code, file: dest });
            }
        }
        let bytes;
        try { bytes = fs.readFileSync(fd); } catch (e) { return fail('UNKNOWN_IO', { errno: e.code }); }
        if (model.sha256(bytes) !== expectedSha) return fail('ANOMALY', { reason: 'SHA_AFTER_LINK', file: dest });
        if (validate) {
            let parsed;
            try { parsed = JSON.parse(bytes.toString('utf8')); } catch { return fail('ANOMALY', { reason: 'INVALID_AFTER_LINK', file: dest }); }
            if (!model.validateVersion(parsed).ok) return fail('ANOMALY', { reason: 'INVALID_AFTER_LINK', file: dest });
        }
        return { ok: true };
    } finally {
        if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* fd já fechado */ } }
    }
}

/** Destino existente: mesmo dev/ino → IDEMPOTENT; bytes iguais → IDEMPOTENT; senão CONFLICT. */
function compareExisting(fs, dest, src) {
    const d = lstatOrNull(fs, dest);
    if (d.err) return fail('UNKNOWN_IO', { errno: d.err.code });
    if (d.st.isSymbolicLink() || !d.st.isFile()) return fail('ANOMALY', { reason: 'NOT_REGULAR', file: dest });
    if (d.st.dev === src.st.dev && d.st.ino === src.st.ino) return { ok: true, code: 'IDEMPOTENT' };
    const read = readNoFollow(fs, dest);
    if (read.err) return fail('UNKNOWN_IO', { errno: read.err.code });
    return Buffer.compare(read.bytes, src.bytes) === 0 ? { ok: true, code: 'IDEMPOTENT' } : fail('CONFLICT', { file: dest });
}

function keyDirs(runDir, s) {
    const store = path.join(runDir, STORE_DIR);
    return { store, key: path.join(store, s) };
}

/**
 * Cria <runDir>/qa-diagnosis/<slug>/vNNN.json por link exclusivo a partir de srcFile.
 * Desfechos: CREATED | IDEMPOTENT (ok) ou INVALID_KEY, INVALID_VERSION, NOT_A_RUN, SRC_*,
 * CROSS_DEVICE, SYMLINK_OR_NOT_DIR, CONFLICT, ANOMALY, SEAL_FAILED, LINK_REFUSED, UNKNOWN_IO.
 */
function createVersionExclusive(runDir, key, version, srcFile, { fs = realFs } = {}) {
    const sl = slug(key);
    if (!sl.ok) return sl;
    if (!Number.isSafeInteger(version) || version < 1) return fail('INVALID_VERSION');
    const run = checkRun(fs, runDir);
    if (!run.ok) return run;
    const src = checkSource(fs, runDir, srcFile);
    if (!src.ok) return src;
    let parsed;
    try { parsed = JSON.parse(src.bytes.toString('utf8')); } catch { return fail('SRC_INVALID', { errors: ['JSON'] }); }
    const valid = model.validateVersion(parsed);
    if (!valid.ok) return fail('SRC_INVALID', { errors: valid.errors });
    if (parsed.rejection_key !== key) return fail('SRC_INVALID', { errors: ['rejection_key != chave do diretório'] });
    if (parsed.version !== version) return fail('SRC_INVALID', { errors: ['version != nome do arquivo'] });

    const dirs = keyDirs(runDir, sl.slug);
    const chk = checkDirs(fs, [dirs.store, dirs.key]);
    if (!chk.ok) return chk;
    const dest = path.join(dirs.key, versionFileName(version));
    const sha = model.sha256(src.bytes);

    const existing = lstatOrNull(fs, dest);
    if (existing.err && existing.err.code !== 'ENOENT') return fail('UNKNOWN_IO', { errno: existing.err.code });
    let code;
    if (!existing.err) {
        const cmp = compareExisting(fs, dest, src);
        if (!cmp.ok) return cmp;
        code = cmp.code;
    } else {
        if (src.st.nlink !== 1) return fail('SRC_NLINK', { nlink: src.st.nlink });
        const mk = makeDirs(fs, [dirs.store, dirs.key]);
        if (!mk.ok) return mk;
        try {
            fs.linkSync(srcFile, dest);
            code = 'CREATED';
        } catch (e) {
            if (e.code === 'EEXIST') {
                const cmp = compareExisting(fs, dest, src);
                if (!cmp.ok) return cmp;
                code = cmp.code;
            } else if (LINK_REFUSED_ERRNOS.includes(e.code)) {
                return fail('LINK_REFUSED', { errno: e.code });
            } else {
                return fail('UNKNOWN_IO', { errno: e.code });
            }
        }
        if (code === 'CREATED') {
            const after = lstatOrNull(fs, dest);
            if (after.err) return fail('UNKNOWN_IO', { errno: after.err.code });
            if (after.st.dev !== src.st.dev || after.st.ino !== src.st.ino) return fail('ANOMALY', { reason: 'INO_AFTER_LINK', file: dest });
        }
    }
    const sealed = seal(fs, dest, sha, { validate: true, expectIno: code === 'CREATED' ? src.st : null });
    if (!sealed.ok) return sealed;
    return { ok: true, code, file: dest, sha256: sha };
}

/**
 * Quarentena sem sobrescrita (premissa 5): link a partir do staging, checagens comuns, sem
 * validateVersion, selagem 0444. Colisão: mesmo inode ou bytes → idempotente; senão <token>.<k>.json.
 */
function quarantineExclusive(runDir, key, token, srcFile, { fs = realFs } = {}) {
    const sl = slug(key);
    if (!sl.ok) return sl;
    if (!model.isValidToken(token)) return fail('INVALID_TOKEN');
    const run = checkRun(fs, runDir);
    if (!run.ok) return run;
    const src = checkSource(fs, runDir, srcFile);
    if (!src.ok) return src;
    const dirs = keyDirs(runDir, sl.slug);
    const qdir = path.join(dirs.key, QUARANTINE_DIR);
    const chk = checkDirs(fs, [dirs.store, dirs.key, qdir]);
    if (!chk.ok) return chk;
    const mk = makeDirs(fs, [dirs.store, dirs.key, qdir]);
    if (!mk.ok) return mk;
    const sha = model.sha256(src.bytes);
    for (let k = 0; k <= MAX_QUARANTINE_SUFFIX; k++) {
        const dest = path.join(qdir, k === 0 ? `${token}.json` : `${token}.${k}.json`);
        let code = null;
        try {
            fs.linkSync(srcFile, dest);
            code = 'CREATED';
        } catch (e) {
            if (e.code === 'EEXIST') {
                const cmp = compareExisting(fs, dest, src);
                if (cmp.ok) code = cmp.code;
                else if (cmp.code === 'CONFLICT') continue;
                else return cmp;
            } else if (LINK_REFUSED_ERRNOS.includes(e.code)) {
                return fail('LINK_REFUSED', { errno: e.code });
            } else {
                return fail('UNKNOWN_IO', { errno: e.code });
            }
        }
        if (code === 'CREATED') {
            const after = lstatOrNull(fs, dest);
            if (after.err) return fail('UNKNOWN_IO', { errno: after.err.code });
            if (after.st.dev !== src.st.dev || after.st.ino !== src.st.ino) return fail('ANOMALY', { reason: 'INO_AFTER_LINK', file: dest });
        }
        const sealed = seal(fs, dest, sha, { expectIno: code === 'CREATED' ? src.st : null });
        if (!sealed.ok) return sealed;
        return { ok: true, code, file: dest };
    }
    return fail('UNKNOWN_IO', { errno: 'QUARANTINE_FULL' });
}

/** Versões canônicas em ordem numérica; nomes ^v\d+\.json$ não canônicos voltam como anomalia. */
function listVersions(runDir, key, { fs = realFs } = {}) {
    const sl = slug(key);
    if (!sl.ok) return sl;
    const dirs = keyDirs(runDir, sl.slug);
    const chk = checkDirs(fs, [dirs.store, dirs.key]);
    if (!chk.ok) return chk;
    let names;
    try { names = fs.readdirSync(dirs.key); } catch (e) {
        if (e.code === 'ENOENT') return { ok: true, versions: [], anomalies: [] };
        return fail('UNKNOWN_IO', { errno: e.code });
    }
    const versions = [];
    const anomalies = [];
    for (const n of names) {
        const p = parseVersionFileName(n);
        if (!p) continue;
        if (p.anomaly) { anomalies.push(n); continue; }
        const file = path.join(dirs.key, n);
        const st = lstatOrNull(fs, file);
        if (st.err) return fail('UNKNOWN_IO', { errno: st.err.code });
        // Nome canônico que não é arquivo regular (symlink, diretório) não é versão.
        if (st.st.isSymbolicLink() || !st.st.isFile()) anomalies.push(n);
        else versions.push({ v: p.v, file });
    }
    versions.sort((a, b) => a.v - b.v);
    return { ok: true, versions, anomalies };
}

/** Lê uma versão sem seguir symlink em nenhum componente a partir de runDir. */
function readVersion(runDir, key, v, { fs = realFs } = {}) {
    const sl = slug(key);
    if (!sl.ok) return sl;
    if (!Number.isSafeInteger(v) || v < 1) return fail('INVALID_VERSION');
    const dirs = keyDirs(runDir, sl.slug);
    const file = path.join(dirs.key, versionFileName(v));
    for (const [p, wantDir] of [[dirs.store, true], [dirs.key, true], [file, false]]) {
        const r = lstatOrNull(fs, p);
        if (r.err) return fail(r.err.code === 'ENOENT' ? 'MISSING' : 'UNKNOWN_IO', { errno: r.err.code });
        if (r.st.isSymbolicLink() || (wantDir ? !r.st.isDirectory() : !r.st.isFile())) return fail('NOT_REGULAR', { path: p });
    }
    const read = readNoFollow(fs, file);
    if (read.err) return fail('UNKNOWN_IO', { errno: read.err.code });
    return { ok: true, file, bytes: read.bytes, sha256: model.sha256(read.bytes) };
}

/**
 * Detecção de INTEGRITY (QRD-AC-06, parte da c2b-1). Desfechos: OK | NO_VERSION |
 * INTEGRITY (MISSING, NOT_REGULAR, SHA_MISMATCH) | UNKNOWN. UNKNOWN nunca vira OK nem
 * INTEGRITY. Não muda o bloco: a transição failed:INTEGRITY é da c2b-2.
 * Forma { result, reason } (e não { ok, code }) porque é um veredito de três vias mais
 * NO_VERSION, não o desfecho de uma operação.
 */
function runPresent(fs, runDir) {
    const r = checkRun(fs, runDir);
    if (r.ok) return null;
    return r.code === 'NOT_A_RUN' ? { result: 'UNKNOWN', reason: 'RUN_GONE' } : { result: 'UNKNOWN', reason: 'IO', errno: r.errno };
}

function verifyCurrentVersion(runDir, key, block, { fs = realFs } = {}) {
    if (!model.validateBlock(block).ok) return { result: 'UNKNOWN', reason: 'BLOCK_INVALID' };
    if (!slug(key).ok) return { result: 'UNKNOWN', reason: 'INVALID_KEY' };
    if (block.current_version === 0) return { result: 'NO_VERSION' };
    // Mesmo critério de run do createVersionExclusive: diretório com state.json regular.
    const gone = runPresent(fs, runDir);
    if (gone) return gone;
    const r = readVersion(runDir, key, block.current_version, { fs });
    if (!r.ok) {
        if (r.code === 'MISSING') {
            // O run pode ter sumido (archive, cópia parcial) durante a leitura: só é INTEGRITY
            // se o run continua presente depois do ENOENT.
            const goneAfter = runPresent(fs, runDir);
            return goneAfter || { result: 'INTEGRITY', reason: 'MISSING' };
        }
        if (r.code === 'NOT_REGULAR') return { result: 'INTEGRITY', reason: 'NOT_REGULAR' };
        return { result: 'UNKNOWN', reason: 'IO', errno: r.errno };
    }
    const entry = block.versions[block.current_version - 1];
    if (r.sha256 !== entry.sha256 || r.sha256 !== block.current_sha256) return { result: 'INTEGRITY', reason: 'SHA_MISMATCH' };
    return { result: 'OK' };
}

module.exports = {
    STORE_DIR, QUARANTINE_DIR, SEALED_MODE,
    slug, slugToKey, versionFileName, parseVersionFileName,
    createVersionExclusive, quarantineExclusive, listVersions, readVersion, verifyCurrentVersion,
};
