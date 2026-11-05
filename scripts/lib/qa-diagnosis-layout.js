'use strict';
// PRI-181 C2 — layout P-R3-01 (staging + autoridade + lixeira) para Diagnosis Record.
//
// Paths sob REPO_PATH/memory/qa-diagnosis/ (plataforma). Staging NUNCA é autoridade
// (R3-A / INV-R3-01). Não transporta dados de consumidor; testes usam raiz sintética.
//
 // no-replace: este host não expõe fs.constants.RENAME_NOREPLACE — a publicação
// demonstra fail-closed via exists+lock (UNKNOWN se a primitiva OS estiver ausente).

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const STORE_DIRNAME = 'qa-diagnosis';
const STAGING = 'staging';
const RECORDS = 'records';
const TRASH = 'trash';
const AUTHORITY_MARKER = 'AUTHORITY';
const RECORD_FILE = 'diagnosis-record.json';
const RECEIPT_FILE = 'cutover-receipt.json';

/** Segmento de path seguro a partir da rejection_key (sem dados corporativos). */
function keySegment(rejectionKey) {
    const raw = String(rejectionKey || '');
    if (!/^qa-rej:v1:t\d+:j\d+$/.test(raw)) {
        const digest = crypto.createHash('sha256').update(raw).digest('hex').slice(0, 24);
        return `opaque-${digest}`;
    }
    return raw.replace(/:/g, '_');
}

function storeRoot(repoPath) {
    return path.join(path.resolve(repoPath), 'memory', STORE_DIRNAME);
}

function pathsFor(repoPath, rejectionKey) {
    const root = storeRoot(repoPath);
    const seg = keySegment(rejectionKey);
    return {
        root,
        stagingDir: path.join(root, STAGING, seg),
        authorityDir: path.join(root, RECORDS, seg),
        trashParent: path.join(root, TRASH),
        stagingRecord: path.join(root, STAGING, seg, RECORD_FILE),
        stagingReceipt: path.join(root, STAGING, seg, RECEIPT_FILE),
        authorityRecord: path.join(root, RECORDS, seg, RECORD_FILE),
        authorityMarker: path.join(root, RECORDS, seg, AUTHORITY_MARKER),
        keySegment: seg,
    };
}

function ensureLayout(repoPath) {
    const root = storeRoot(repoPath);
    for (const sub of [STAGING, RECORDS, TRASH]) {
        fs.mkdirSync(path.join(root, sub), { recursive: true });
    }
    return root;
}

function isAuthorityDir(dir) {
    try {
        return fs.existsSync(path.join(dir, AUTHORITY_MARKER));
    } catch {
        return false;
    }
}

/** Staging nunca carrega AUTHORITY (R3-A). */
function assertStagingNotAuthority(stagingDir) {
    if (isAuthorityDir(stagingDir)) {
        const err = new Error(`INV-R3-01: staging não pode ser autoridade: ${stagingDir}`);
        err.code = 'STAGING_IS_AUTHORITY';
        throw err;
    }
}

module.exports = {
    STORE_DIRNAME, STAGING, RECORDS, TRASH,
    AUTHORITY_MARKER, RECORD_FILE, RECEIPT_FILE,
    keySegment, storeRoot, pathsFor, ensureLayout,
    isAuthorityDir, assertStagingNotAuthority,
    /** Evidência: primitiva OS de no-replace ausente neste runtime. */
    renameNoReplaceAvailable: typeof fs.constants?.RENAME_NOREPLACE === 'number',
};
