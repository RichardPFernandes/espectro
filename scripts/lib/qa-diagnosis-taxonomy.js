'use strict';
// PRI-181 C3 — taxonomia 0.1 (DB-04).
//
// FACT só por predicado de sistema. Hipóteses usam MODERATE / WEAK / UNKNOWN.
// Sem nível causal automático. Sem nova enum além desta taxonomia revisável.

const TAXONOMY_VERSION = '0.1';

/** Categorias revisáveis (MVP C — Redmine). */
const CATEGORIES = Object.freeze({
    IDENTITY: 'identity',
    INGESTION: 'ingestion',
    CODE: 'code',
    REQUIREMENT_SPEC: 'requirement_spec',
    TEST: 'test',
    ENVIRONMENT: 'environment',
    DATA: 'data',
    CONFIGURATION: 'configuration',
    DATABASE_MIGRATION: 'database_migration',
    INTEGRATION: 'integration',
    ALREADY_RESOLVED: 'already_resolved',
    INDETERMINATE: 'indeterminate',
    INFORMATION_ABSENT: 'information_absent',
});

/** Níveis de apoio (DB-04). FACT = só predicado de sistema. */
const CONFIDENCE = Object.freeze({
    FACT: 'FACT',
    MODERATE: 'MODERATE',
    WEAK: 'WEAK',
    UNKNOWN: 'UNKNOWN',
});

function isFact(confidence) {
    return confidence === CONFIDENCE.FACT;
}

function assertFactOnlyFromSystem(confidence, { systemPredicate = false } = {}) {
    if (confidence === CONFIDENCE.FACT && !systemPredicate) {
        const err = new Error('DB-04: FACT só por predicado de sistema');
        err.code = 'FACT_REQUIRES_SYSTEM_PREDICATE';
        throw err;
    }
}

module.exports = {
    TAXONOMY_VERSION,
    CATEGORIES,
    CONFIDENCE,
    isFact,
    assertFactOnlyFromSystem,
};
