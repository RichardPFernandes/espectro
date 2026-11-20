'use strict';
// PRI-181 C1 — ingestão idempotente + demonstração N-08 no caminho (não PASS global).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const fixture = require('../fixtures/qa-rejection/current.json');
const ingest = require('./qa-rejection-ingest');
const identity = require('./qa-rejection-identity');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pri181-c1-ingest-'));
const repo = path.join(tmp, 'consumer');
fs.mkdirSync(path.join(repo, '.git'), { recursive: true });

test.after(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
});

test('C1 ingest: idempotente — mesma rejection_key não duplica', () => {
    const identities = identity.buildIdentitiesFromJournals(990010, fixture.journals.own, {
        noteSourceForLatest: { note: 'n', journal_id: 102, rejected_at: '2026-01-02T11:00:00Z' },
    });
    const first = ingest.applyIdentities({ ticket_status: 'Recusa QA' }, identities, {
        repoPath: repo,
        at: '2026-01-02T12:00:00.000Z',
        noteSource: { note: 'n', journal_id: 102, rejected_at: '2026-01-02T11:00:00Z' },
        ticketFallbackRejectedAt: '2026-01-02T12:00:00Z',
    });
    assert.equal(first.ingested.length, 1);
    assert.equal(first.state.qa_rejections.length, 1);
    assert.equal(first.n08.global_pass, false, 'N-08 não é PASS global');
    assert.equal(first.n08.demonstrated_path, true);

    const second = ingest.applyIdentities(first.state, identities, {
        repoPath: repo,
        at: '2026-01-02T13:00:00.000Z',
        noteSource: { note: 'n', journal_id: 102, rejected_at: '2026-01-02T11:00:00Z' },
    });
    assert.equal(second.ingested.length, 0);
    assert.ok(second.skipped.some(s => s.reason === 'idempotent'));
    assert.equal(second.state.qa_rejections.length, 1);
});

test('C1 ingest: between_polls — três transições viram três entradas', () => {
    const note = { note: 'O cilindro verde deve parar.', journal_id: 404, rejected_at: '2026-01-02T11:40:00Z' };
    const result = ingest.ingestFromJournals({
        ticketId: 990011,
        journals: fixture.journals.between_polls,
        state: { ticket_status: 'Recusa QA' },
        noteSource: note,
        repoPath: repo,
        at: '2026-01-02T14:00:00.000Z',
        ticketFallbackRejectedAt: '2026-01-02T14:00:00Z',
    });
    assert.equal(result.ingested.length, 3);
    assert.deepEqual(result.state.qa_rejections.map(e => e.transition_journal_id), [102, 402, 404]);
    assert.equal(result.state.qa_rejection.rejection_key, 'qa-rej:v1:t990011:j404');
    assert.equal(result.state.qa_rejection.journal_id, 404, 'campo legado = journal da nota');
});

test('C1 N-08: segundo writer da mesma rejection_key falha fechado (contention)', () => {
    const key = 'qa-rej:v1:t990012:j102';
    const first = ingest.acquireKeyLock(key, { repoPath: repo });
    assert.equal(first.acquired, true);
    try {
        const second = ingest.acquireKeyLock(key, { repoPath: repo });
        assert.equal(second.acquired, false);
        assert.ok(['held', 'takeover_in_progress'].includes(second.reason));

        const identities = [{
            rejection_key: key,
            identity_quality: 'OK',
            transition_journal_id: 102,
            rejected_at: '2026-01-02T11:00:00Z',
            note: 'x',
            note_journal_id: 102,
        }];
        // Lock já segura a chave: apply deve bloquear (não inserir).
        const blocked = ingest.applyIdentities({ ticket_status: 'Recusa QA' }, identities, {
            repoPath: repo,
            at: '2026-01-02T12:00:00.000Z',
            noteSource: { note: 'x', journal_id: 102, rejected_at: '2026-01-02T11:00:00Z' },
        });
        assert.equal(blocked.ingested.length, 0);
        assert.equal(blocked.blocked.length, 1);
        assert.equal(blocked.blocked[0].reason, 'n08_contention');
        assert.equal(blocked.n08.global_pass, false);
    } finally {
        first.release();
    }

    // Após liberar, a mesma chave ingere.
    const ok = ingest.applyIdentities({ ticket_status: 'Recusa QA' }, [{
        rejection_key: key,
        identity_quality: 'OK',
        transition_journal_id: 102,
        rejected_at: '2026-01-02T11:00:00Z',
        note: 'x',
        note_journal_id: 102,
    }], {
        repoPath: repo,
        at: '2026-01-02T12:00:00.000Z',
        noteSource: { note: 'x', journal_id: 102, rejected_at: '2026-01-02T11:00:00Z' },
    });
    assert.equal(ok.ingested.length, 1);
});

test('C1 N-08: chaves distintas não contendem', () => {
    const a = ingest.acquireKeyLock('qa-rej:v1:t1:j1', { repoPath: repo });
    const b = ingest.acquireKeyLock('qa-rej:v1:t1:j2', { repoPath: repo });
    assert.equal(a.acquired, true);
    assert.equal(b.acquired, true);
    a.release();
    b.release();
});
