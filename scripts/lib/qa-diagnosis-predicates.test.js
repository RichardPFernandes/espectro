'use strict';
// PRI-274 c2b-4, T2 — predicados determinísticos pred/0.1 emitem assertions FACT (SDD B v3 §6.2).
const test = require('node:test');
const assert = require('node:assert/strict');
const predicates = require('./qa-diagnosis-predicates');

const PRED_RE = /^pred:[a-z][a-z0-9_]*@[0-9]+\.[0-9]+$/;
const pack = (signals, trust = 'TRUSTED_SYSTEM') => ({ trust, signals });

test('predicates: FACT só por SYSTEM_PREDICATE sobre fonte TRUSTED_SYSTEM, com predicate_ref', () => {
    const out = predicates.evaluatePredicates(pack({
        has_rejection_key: true,
        rejection_key: 'qa-rej:v1:t880200:j402',
        identity_quality: 'OK',
        transition_journal_id: 402,
        note_present: true,
        retry_requested: false,
    }));
    assert.equal(out.predicates_version, 'pred/0.1');
    const refs = out.assertions.map(a => a.predicate_ref);
    for (const r of ['pred:has_rejection_key@0.1', 'pred:identity_quality_ok@0.1',
        'pred:has_transition_journal@0.1', 'pred:note_present@0.1']) assert.ok(refs.includes(r), r);
    for (const a of out.assertions) {
        assert.equal(a.type, 'FACT');
        assert.equal(a.basis, 'SYSTEM_PREDICATE');
        assert.match(a.predicate_ref, PRED_RE);
        assert.deepEqual(a.contradicted_by, []);
        assert.ok(Array.isArray(a.evidence_ids));
    }
    assert.equal(new Set(out.assertions.map(a => a.id)).size, out.assertions.length);
});

test('predicates: não classifica causa nem categoria (INV-4: sem causa por default)', () => {
    const out = predicates.evaluatePredicates(pack({ has_rejection_key: true, rejection_key: 'k' }));
    for (const a of out.assertions) {
        assert.equal(Object.prototype.hasOwnProperty.call(a, 'category'), false);
        assert.equal(Object.prototype.hasOwnProperty.call(a, 'causal_level'), false);
    }
    assert.equal(out.cause, undefined);
    assert.equal(out.causal_auto, false);
});

test('predicates: identity DEGRADED, sem journal de transição e sem nota são FACT de sistema', () => {
    const out = predicates.evaluatePredicates(pack({
        has_rejection_key: true,
        rejection_key: 'qa-rej:v1:t880201:j0',
        identity_quality: 'DEGRADED',
        transition_journal_id: null,
        note_present: false,
        retry_requested: false,
    }));
    const refs = out.assertions.map(a => a.predicate_ref);
    for (const r of ['pred:identity_quality_degraded@0.1', 'pred:missing_transition_journal@0.1', 'pred:note_absent@0.1']) {
        assert.ok(refs.includes(r), r);
    }
});

test('predicates: fonte que não é TRUSTED_SYSTEM não produz FACT', () => {
    for (const trust of [undefined, null, 'UNTRUSTED_EXTERNAL_TEXT', 'AGENT_DERIVED', 'HUMAN']) {
        const out = predicates.evaluatePredicates({ trust, signals: { has_rejection_key: true, rejection_key: 'k' } });
        assert.deepEqual(out.assertions, [], String(trust));
    }
    assert.deepEqual(predicates.evaluatePredicates(undefined).assertions, []);
});

test('predicates: assertion de FACT sem predicado de sistema é recusada pelo construtor', () => {
    assert.throws(() => predicates.factAssertion({ id: 'x', predicate_id: 'x', trust: 'REPORTED' }),
        err => err.code === 'FACT_REQUIRES_SYSTEM_PREDICATE');
    assert.throws(() => predicates.factAssertion({ id: 'x', predicate_id: 'Bad Id', trust: 'TRUSTED_SYSTEM' }),
        err => err.code === 'FACT_REQUIRES_SYSTEM_PREDICATE');
    assert.equal(predicates.factAssertion({ id: 'x', predicate_id: 'x', trust: 'TRUSTED_SYSTEM' }).type, 'FACT');
});
