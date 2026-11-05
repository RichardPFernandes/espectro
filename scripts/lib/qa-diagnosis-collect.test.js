'use strict';
// PRI-181 C3 — coletor. Só metadados de plataforma; sem corpo de nota.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const collect = require('./qa-diagnosis-collect');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pri181-c3-col-'));
const repo = path.join(tmp, 'consumer');
fs.mkdirSync(path.join(repo, '.git'), { recursive: true });

test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

test('C3 collect: signals de plataforma sem corporate_content', () => {
    const identity = {
        rejection_key: 'qa-rej:v1:t880100:j401',
        identity_quality: 'OK',
        transition_journal_id: 401,
        note: 'TEXTO CORPORATIVO QUE NÃO DEVE VIRAR FINDING',
        note_journal_id: 401,
        rejected_at: '2026-01-02T10:00:00Z',
    };
    const pack = collect.collectEvidencePack({
        identity,
        state: {
            status: 'archived',
            ticket_status: 'Recusa QA',
            qa_rejection: identity,
            qa_rejections: [identity],
            task_id: 'task-synth-1',
        },
        ticketId: 880100,
        repoPath: repo,
        taskId: 'task-synth-1',
        at: '2026-01-02T12:00:00.000Z',
    });
    assert.equal(pack.corporate_content_included, false);
    assert.equal(pack.taxonomy_scope, 'platform_metadata_only');
    assert.equal(pack.signals.note_present, true);
    assert.equal(pack.signals.has_rejection_key, true);
    assert.equal(pack.signals.identity_quality, 'OK');
    const dump = JSON.stringify(pack);
    assert.equal(dump.includes('TEXTO CORPORATIVO'), false, 'nota não entra no pacote');
    assert.ok(pack.evidence_refs.some(r => r.type === 'rejection_key'));
    assert.ok(pack.evidence_refs.some(r => r.type === 'ticket_id'));
});

test('C3 collect: ausência de chave → signals falsos sem inventar', () => {
    const pack = collect.collectEvidencePack({
        identity: null,
        state: { status: 'archived' },
        ticketId: 1,
    });
    assert.equal(pack.signals.has_rejection_key, false);
    assert.equal(pack.signals.rejection_key, null);
    assert.equal(pack.corporate_content_included, false);
});
