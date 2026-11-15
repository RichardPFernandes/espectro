'use strict';
// PRI-274 c2b-4 — taxonomia qa-cause-taxonomy/0.1 (SDD B v3 §6.3, DB-04).
//
// Só vocabulário: as 11 categorias exatas da SDD e a escala ordinal de support.
// Sem alias para a taxonomia antiga (C3) e sem nível causal acima de MODERATE:
// compatibilidade não é causalidade. FACT não é nível de support; é o `type` de uma
// assertion de predicado de sistema (§6.2) e é validado fora daqui.

const TAXONOMY_ID = 'qa-cause-taxonomy/0.1';
const TAXONOMY_VERSION = '0.1';

const CATEGORIES = Object.freeze({
    CODE: 'code',
    REQUIREMENT_SPEC: 'requirement_spec',
    TEST: 'test',
    ENVIRONMENT: 'environment',
    DATA: 'data',
    CONFIGURATION: 'configuration',
    DB_MIGRATION: 'db_migration',
    INTEGRATION: 'integration',
    ALREADY_RESOLVED: 'already_resolved',
    INVALID_REJECTION: 'invalid_rejection',
    INDETERMINATE: 'indeterminate',
});

/** support ordinal (§6.3): mesmo critério no modo determinístico e no por agente. */
const SUPPORT = Object.freeze({
    MODERATE: 'MODERATE',
    WEAK: 'WEAK',
    UNKNOWN: 'UNKNOWN',
});

const CATEGORY_VALUES = new Set(Object.values(CATEGORIES));

function isCategory(value) {
    return typeof value === 'string' && CATEGORY_VALUES.has(value);
}

module.exports = {
    TAXONOMY_ID,
    TAXONOMY_VERSION,
    CATEGORIES,
    SUPPORT,
    isCategory,
};
