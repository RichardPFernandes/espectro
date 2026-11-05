'use strict';
// PRI-181 C3 — orquestra coleta + predicados.
const test = require('node:test');
const assert = require('node:assert/strict');
const analyze = require('./qa-diagnosis-analyze');

test('C3 analyze: pacote + findings EVALUATED sem conteúdo corporativo', () => {
    const out = analyze.analyzeRejection({
        identity: {
            rejection_key: 'qa-rej:v1:t880300:j403',
            identity_quality: 'OK',
            transition_journal_id: 403,
            note: 'SEGREDO DO CONSUMIDOR',
            note_journal_id: 403,
            rejected_at: '2026-01-02T11:00:00Z',
        },
        state: {
            status: 'archived',
            ticket_status: 'Recusa QA',
            qa_rejection: {
                rejection_key: 'qa-rej:v1:t880300:j403',
                note: 'SEGREDO DO CONSUMIDOR',
            },
        },
        ticketId: 880300,
        taskId: 'task-c3',
        at: '2026-01-02T12:00:00.000Z',
    });
    assert.equal(out.corporate_content_included, false);
    assert.equal(out.findings_status, 'EVALUATED');
    assert.ok(out.findings.length > 0);
    assert.equal(out.taxonomy_version, '0.1');
    assert.equal(out.causal_auto, false);
    const dump = JSON.stringify(out);
    assert.equal(dump.includes('SEGREDO DO CONSUMIDOR'), false);
});
