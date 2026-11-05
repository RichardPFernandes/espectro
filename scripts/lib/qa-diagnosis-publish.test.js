'use strict';
// PRI-181 C2 — publicação R3-A / P-R3-01. Só fixtures sintéticas.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const layout = require('./qa-diagnosis-layout');
const publish = require('./qa-diagnosis-publish');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pri181-c2-pub-'));
const repo = path.join(tmp, 'consumer');
fs.mkdirSync(path.join(repo, '.git'), { recursive: true });

const identity = {
    rejection_key: 'qa-rej:v1:t990200:j501',
    identity_quality: 'OK',
    transition_journal_id: 501,
    rejected_at: '2026-01-02T11:00:00Z',
    note_journal_id: 501,
};

test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

test('C2 publish: staging nunca é autoridade; destino ganha AUTHORITY após promote', () => {
    const r = publish.publishDiagnosisRecord({
        repoPath: repo,
        identity,
        ticketId: 990200,
        at: '2026-01-02T12:00:00.000Z',
    });
    assert.equal(r.ok, true);
    assert.equal(r.promoted, true);
    assert.equal(r.record.authority, true);
    assert.equal(r.record.is_context_record, false);
    assert.equal(r.record.findings_status, 'UNKNOWN');
    assert.equal(r.record.findings.length, 0, 'C3 não autorizado — sem predicados');
    assert.ok(layout.isAuthorityDir(r.authority_path));
    const p = layout.pathsFor(repo, identity.rejection_key);
    assert.equal(fs.existsSync(p.stagingDir), false, 'staging consumido no promote');
    assert.ok(fs.existsSync(p.authorityMarker));
    assert.equal(r.n08.global_pass, false);
    assert.equal(r.no_replace.global_pass, false);
    assert.equal(r.p_r3_01.demonstrated_path, true);
    assert.equal(r.p_r3_01.global_pass, false);
});

test('C2 publish: idempotente na mesma rejection_key', () => {
    const r = publish.publishDiagnosisRecord({
        repoPath: repo,
        identity,
        ticketId: 990200,
        at: '2026-01-02T13:00:00.000Z',
    });
    assert.equal(r.ok, true);
    assert.equal(r.idempotent, true);
    assert.equal(r.promoted, false);
});

test('C2 no-replace: destino ocupado por outra chave → fail-closed', () => {
    const otherKey = 'qa-rej:v1:t990201:j777';
    const p = layout.pathsFor(repo, otherKey);
    // Publica other primeiro
    const first = publish.publishDiagnosisRecord({
        repoPath: repo,
        identity: { ...identity, rejection_key: otherKey, transition_journal_id: 777 },
        ticketId: 990201,
    });
    assert.equal(first.ok, true);

    // Simula corrida: cria authority dir da key nova antes do rename
    const raceKey = 'qa-rej:v1:t990202:j888';
    const racePaths = layout.pathsFor(repo, raceKey);
    fs.mkdirSync(racePaths.authorityDir, { recursive: true });
    fs.writeFileSync(path.join(racePaths.authorityDir, 'sentinel'), 'ocupado\n');

    const blocked = publish.publishDiagnosisRecord({
        repoPath: repo,
        identity: { ...identity, rejection_key: raceKey, transition_journal_id: 888 },
        ticketId: 990202,
    });
    assert.equal(blocked.ok, false);
    assert.equal(blocked.reason, 'no_replace_destination_exists');
    assert.equal(blocked.no_replace.demonstrated_path, true);
    assert.equal(blocked.no_replace.global_pass, false);
});

test('C2 N-08: contention na publish → fail-closed sem promover', () => {
    const key = 'qa-rej:v1:t990203:j900';
    const lock = require('./qa-rejection-ingest').acquireKeyLock(key, { repoPath: repo });
    assert.equal(lock.acquired, true);
    try {
        const r = publish.publishDiagnosisRecord({
            repoPath: repo,
            identity: { ...identity, rejection_key: key, transition_journal_id: 900 },
            ticketId: 990203,
        });
        assert.equal(r.ok, false);
        assert.equal(r.reason, 'n08_contention');
        assert.equal(r.n08.global_pass, false);
    } finally {
        lock.release();
    }
});

test('C2 statePointer: ponteiro para state sem embutir findings', () => {
    const key = 'qa-rej:v1:t990204:j901';
    const r = publish.publishDiagnosisRecord({
        repoPath: repo,
        identity: { ...identity, rejection_key: key, transition_journal_id: 901 },
        ticketId: 990204,
    });
    const ptr = publish.statePointer(r);
    assert.equal(ptr.rejection_key, key);
    assert.equal(ptr.is_context_record, false);
    assert.equal(ptr.findings_status, 'UNKNOWN');
    assert.ok(ptr.authority_path);
});

test('C2 record: exige rejection_key', () => {
    const rec = require('./qa-diagnosis-record');
    assert.throws(() => rec.buildDiagnosisRecord({}), (err) => err.code === 'MISSING_REJECTION_KEY');
});
