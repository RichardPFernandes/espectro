'use strict';
// PRI-181 C3 — predicados determinísticos. Sem causa automática.
const test = require('node:test');
const assert = require('node:assert/strict');
const predicates = require('./qa-diagnosis-predicates');
const taxonomy = require('./qa-diagnosis-taxonomy');
const collect = require('./qa-diagnosis-collect');

test('C3 predicates: FACT só em checagens de sistema; causa indeterminada UNKNOWN', () => {
    const pack = collect.collectEvidencePack({
        identity: {
            rejection_key: 'qa-rej:v1:t880200:j402',
            identity_quality: 'OK',
            transition_journal_id: 402,
            note: 'x',
            note_journal_id: 402,
        },
        state: { status: 'archived', qa_rejection: { rejection_key: 'qa-rej:v1:t880200:j402' } },
        ticketId: 880200,
    });
    const out = predicates.evaluatePredicates(pack);
    assert.equal(out.taxonomy_version, '0.1');
    assert.equal(out.causal_auto, false);
    assert.equal(out.findings_status, 'EVALUATED');
    assert.ok(out.findings.some(f => f.predicate_id === 'sys.has_rejection_key' && f.confidence === 'FACT'));
    assert.ok(out.findings.some(f => f.predicate_id === 'sys.identity_quality_ok'));
    assert.ok(out.findings.some(f => f.predicate_id === 'sys.cause_indeterminate'
        && f.confidence === taxonomy.CONFIDENCE.UNKNOWN
        && f.category === taxonomy.CATEGORIES.INDETERMINATE));
    assert.ok(out.findings.every(f => f.causal_level === null));
    assert.ok(out.findings.every(f => f.system_predicate === true));
});

test('C3 predicates: identity DEGRADED e missing transition = FACT de sistema', () => {
    const out = predicates.evaluatePredicates({
        signals: {
            has_rejection_key: true,
            rejection_key: 'qa-rej:v1:t880201:j0',
            identity_quality: 'DEGRADED',
            transition_journal_id: null,
            note_present: false,
            retry_requested: false,
        },
    });
    assert.ok(out.findings.some(f => f.predicate_id === 'sys.identity_quality_degraded'));
    assert.ok(out.findings.some(f => f.predicate_id === 'sys.missing_transition_journal'));
    assert.ok(out.findings.some(f => f.predicate_id === 'sys.note_absent'));
});

test('C3 predicates: FACT sem systemPredicate → throw', () => {
    assert.throws(
        () => predicates.finding({
            predicate_id: 'bad',
            category: taxonomy.CATEGORIES.CODE,
            confidence: taxonomy.CONFIDENCE.FACT,
            systemPredicate: false,
            summary: 'não permitido',
        }),
        (err) => err.code === 'FACT_REQUIRES_SYSTEM_PREDICATE'
    );
});
