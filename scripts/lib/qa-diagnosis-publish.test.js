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

test('C3 publish: findings na primeira publicação', () => {
    const key = 'qa-rej:v1:t990210:j910';
    const findings = [{
        predicate_id: 'sys.has_rejection_key',
        category: 'identity',
        confidence: 'FACT',
        system_predicate: true,
        summary: 'rejection_key presente (identidade C1).',
        signal_keys: ['has_rejection_key'],
        lens: null,
        causal_level: null,
    }];
    const r = publish.publishDiagnosisRecord({
        repoPath: repo,
        identity: { ...identity, rejection_key: key, transition_journal_id: 910 },
        ticketId: 990210,
        findings,
        findings_status: 'EVALUATED',
        taxonomy_version: '0.1',
        evidence_refs: [{ type: 'rejection_key', id: key, source: 'qa-rejection-identity' }],
    });
    assert.equal(r.ok, true);
    assert.equal(r.promoted, true);
    assert.equal(r.record.findings_status, 'EVALUATED');
    assert.equal(r.record.findings.length, 1);
    assert.equal(r.record.taxonomy_version, '0.1');
    assert.equal(r.record.corporate_content_included, false);
    const ptr = publish.statePointer(r);
    assert.equal(ptr.findings_count, 1);
    assert.equal(ptr.taxonomy_version, '0.1');
});

test('C3 enrich: casca UNKNOWN → trash + nova autoridade com findings', () => {
    const key = 'qa-rej:v1:t990211:j911';
    const idn = { ...identity, rejection_key: key, transition_journal_id: 911 };
    const shell = publish.publishDiagnosisRecord({
        repoPath: repo,
        identity: idn,
        ticketId: 990211,
        at: '2026-01-02T14:00:00.000Z',
    });
    assert.equal(shell.ok, true);
    assert.equal(shell.record.findings_status, 'UNKNOWN');
    const authorityBefore = shell.authority_path;

    const findings = [{
        predicate_id: 'sys.has_rejection_key',
        category: 'identity',
        confidence: 'FACT',
        system_predicate: true,
        summary: 'rejection_key presente (identidade C1).',
        signal_keys: ['has_rejection_key'],
        lens: null,
        causal_level: null,
    }];
    const enriched = publish.publishDiagnosisRecord({
        repoPath: repo,
        identity: idn,
        ticketId: 990211,
        at: '2026-01-02T14:05:00.000Z',
        findings,
        findings_status: 'EVALUATED',
        taxonomy_version: '0.1',
        enrich: true,
    });
    assert.equal(enriched.ok, true);
    assert.equal(enriched.promoted, true);
    assert.equal(enriched.enriched, true);
    assert.equal(enriched.record.findings_status, 'EVALUATED');
    assert.equal(enriched.record.findings.length, 1);
    assert.ok(layout.isAuthorityDir(enriched.authority_path));
    // Mesmo path lógico (records/<seg>); versão antiga foi para trash/
    assert.equal(enriched.authority_path, authorityBefore);
    const trashRoot = path.join(layout.storeRoot(repo), layout.TRASH);
    const trashEntries = fs.readdirSync(trashRoot);
    assert.ok(trashEntries.length >= 1, 'casca UNKNOWN anterior em trash');
    const trashed = trashEntries
        .map((name) => path.join(trashRoot, name))
        .find((dir) => fs.existsSync(path.join(dir, layout.RECORD_FILE)));
    assert.ok(trashed);
    const oldRec = JSON.parse(fs.readFileSync(path.join(trashed, layout.RECORD_FILE), 'utf8'));
    assert.equal(oldRec.findings_status, 'UNKNOWN');
    assert.equal(layout.isAuthorityDir(trashed), false, 'trash não carrega AUTHORITY');

    // Segunda chamada com enrich + findings já presentes → idempotente
    const again = publish.publishDiagnosisRecord({
        repoPath: repo,
        identity: idn,
        ticketId: 990211,
        findings,
        findings_status: 'EVALUATED',
        taxonomy_version: '0.1',
        enrich: true,
    });
    assert.equal(again.ok, true);
    assert.equal(again.idempotent, true);
    assert.equal(again.enriched, false);
});
