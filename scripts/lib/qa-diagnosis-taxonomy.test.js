'use strict';
// PRI-181 C3 — taxonomia 0.1. Fixtures sintéticas.
const test = require('node:test');
const assert = require('node:assert/strict');
const taxonomy = require('./qa-diagnosis-taxonomy');

test('C3 taxonomy: versão 0.1 e enums congelados', () => {
    assert.equal(taxonomy.TAXONOMY_VERSION, '0.1');
    assert.equal(taxonomy.CONFIDENCE.FACT, 'FACT');
    assert.equal(taxonomy.CATEGORIES.IDENTITY, 'identity');
    assert.equal(taxonomy.CATEGORIES.INDETERMINATE, 'indeterminate');
});

test('C3 taxonomy: FACT exige predicado de sistema (DB-04)', () => {
    assert.throws(
        () => taxonomy.assertFactOnlyFromSystem(taxonomy.CONFIDENCE.FACT, { systemPredicate: false }),
        (err) => err.code === 'FACT_REQUIRES_SYSTEM_PREDICATE'
    );
    assert.doesNotThrow(() =>
        taxonomy.assertFactOnlyFromSystem(taxonomy.CONFIDENCE.FACT, { systemPredicate: true })
    );
    assert.doesNotThrow(() =>
        taxonomy.assertFactOnlyFromSystem(taxonomy.CONFIDENCE.UNKNOWN, { systemPredicate: false })
    );
});
