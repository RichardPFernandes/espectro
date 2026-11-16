'use strict';
// PRI-274 c2b-4, T2 — taxonomia qa-cause-taxonomy/0.1 exata (SDD B v3 §6.3, DB-04).
const test = require('node:test');
const assert = require('node:assert/strict');
const taxonomy = require('./qa-diagnosis-taxonomy');

const SDD_CATEGORIES = ['code', 'requirement_spec', 'test', 'environment', 'data', 'configuration',
    'db_migration', 'integration', 'already_resolved', 'invalid_rejection', 'indeterminate'];

test('taxonomia: identidade e versão da SDD', () => {
    assert.equal(taxonomy.TAXONOMY_ID, 'qa-cause-taxonomy/0.1');
    assert.equal(taxonomy.TAXONOMY_VERSION, '0.1');
});

test('taxonomia: exatamente as 11 categorias da SDD, congeladas', () => {
    assert.deepEqual([...Object.values(taxonomy.CATEGORIES)].sort(), [...SDD_CATEGORIES].sort());
    assert.ok(Object.isFrozen(taxonomy.CATEGORIES));
    for (const c of SDD_CATEGORIES) assert.equal(taxonomy.isCategory(c), true, c);
});

test('taxonomia: nomes da taxonomia antiga não existem, sem alias', () => {
    for (const old of ['identity', 'ingestion', 'database_migration', 'information_absent']) {
        assert.equal(taxonomy.isCategory(old), false, old);
        assert.ok(!Object.values(taxonomy.CATEGORIES).includes(old), old);
    }
    assert.equal(taxonomy.isCategory(undefined), false);
    assert.equal(taxonomy.isCategory(null), false);
    assert.equal(taxonomy.isCategory('CODE'), false);
});

test('taxonomia: support é ordinal MODERATE/WEAK/UNKNOWN, sem nível acima de MODERATE', () => {
    assert.deepEqual([...Object.values(taxonomy.SUPPORT)].sort(), ['MODERATE', 'UNKNOWN', 'WEAK']);
    assert.ok(Object.isFrozen(taxonomy.SUPPORT));
    assert.equal(taxonomy.CONFIDENCE, undefined);
});
