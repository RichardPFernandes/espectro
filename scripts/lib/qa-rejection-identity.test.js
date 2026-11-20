'use strict';
// PRI-181 C1 — identidade (DB-01 / DB-11). Sem I/O Redmine.
const test = require('node:test');
const assert = require('node:assert/strict');
const fixture = require('../fixtures/qa-rejection/current.json');
const id = require('./qa-rejection-identity');

test('C1 identity: own — OK com chave no journal de transição → 13', () => {
    const transitions = id.listTransitionJournals(fixture.journals.own);
    assert.equal(transitions.length, 1);
    assert.equal(transitions[0].id, 102);
    const out = id.buildIdentity({
        ticketId: 990001,
        transitionJournal: transitions[0],
        noteSource: { note: 'O cubo violeta deve girar duas vezes.', journal_id: 102, rejected_at: '2026-01-02T11:00:00Z' },
        allTransitions: transitions,
    });
    assert.deepEqual(out, {
        rejection_key: 'qa-rej:v1:t990001:j102',
        identity_quality: 'OK',
        transition_journal_id: 102,
        rejected_at: '2026-01-02T11:00:00Z',
        note: 'O cubo violeta deve girar duas vezes.',
        note_journal_id: 102,
        reason: 'transition_journal',
    });
});

test('C1 identity: bounce — DEGRADED (nota no 8→2, identidade no →13)', () => {
    const transitions = id.listTransitionJournals(fixture.journals.bounce);
    assert.equal(transitions[0].id, 305);
    const out = id.buildIdentity({
        ticketId: 990002,
        transitionJournal: transitions[0],
        noteSource: { note: 'A esfera laranja deve saltar três vezes.', journal_id: 302, rejected_at: '2026-01-02T10:00:00Z' },
        allTransitions: transitions,
    });
    assert.equal(out.rejection_key, 'qa-rej:v1:t990002:j305');
    assert.equal(out.identity_quality, 'DEGRADED');
    assert.equal(out.reason, 'note_not_on_transition');
    assert.equal(out.transition_journal_id, 305);
    assert.equal(out.note_journal_id, 302);
});

test('C1 identity: between_polls — três chaves distintas (DB-01b)', () => {
    const list = id.buildIdentitiesFromJournals(990003, fixture.journals.between_polls, {
        noteSourceForLatest: { note: 'O cilindro verde deve parar.', journal_id: 404, rejected_at: '2026-01-02T11:40:00Z' },
    });
    assert.deepEqual(list.map(x => x.transition_journal_id), [102, 402, 404]);
    assert.deepEqual(list.map(x => x.rejection_key), [
        'qa-rej:v1:t990003:j102',
        'qa-rej:v1:t990003:j402',
        'qa-rej:v1:t990003:j404',
    ]);
    assert.equal(list[2].identity_quality, 'OK');
    assert.equal(list[0].note, null, 'nota heurística só na última');
});

test('C1 identity: legacy_ambiguous — DEGRADED por mesmo instante', () => {
    const list = id.buildIdentitiesFromJournals(990004, fixture.journals.legacy_ambiguous);
    assert.equal(list.length, 2);
    assert.ok(list.every(x => x.identity_quality === 'DEGRADED'));
    assert.ok(list.every(x => x.reason === 'ambiguous_same_instant'));
    assert.notEqual(list[0].rejection_key, list[1].rejection_key);
});

test('C1 identity: sem transição → UNKNOWN; bounce 8→2 sozinho não é chave (DB-11)', () => {
    const bounceOnly = [
        { id: 1, created_on: 'T1', notes: 'x', details: [{ name: 'status_id', old_value: '8', new_value: '2' }] },
    ];
    assert.deepEqual(id.listTransitionJournals(bounceOnly), []);
    const out = id.buildIdentity({ ticketId: 1, transitionJournal: null });
    assert.equal(out.identity_quality, 'UNKNOWN');
    assert.equal(out.rejection_key, null);
});

test('C1 identity: parseRejectionKey round-trip', () => {
    const key = id.rejectionKey(42, 99);
    assert.deepEqual(id.parseRejectionKey(key), { ticket_id: 42, transition_journal_id: 99 });
    assert.equal(id.parseRejectionKey('lixo'), null);
});
