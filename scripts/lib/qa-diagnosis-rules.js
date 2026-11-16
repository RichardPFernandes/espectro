'use strict';
// PRI-274 c2b-4 — rules/0.1: compatibilidade predicado → categoria (SDD B v3 §6.3, DB-04).
//
// A SDD pede "uma regra versionada" que declare um FACT compatível com a categoria, mas não
// traz a tabela (SPEC Q2). Esta é a tabela mínima: só os predicados de exemplo da §6.2 que
// falam de causa. É delta a registrar na SDD.
//
// Compatibilidade não é causalidade: a tabela só autoriza o teto MODERATE. Categorias sem
// linha aqui (code, test, environment, data, configuration, integration, invalid_rejection,
// indeterminate) nunca passam de WEAK. Predicados de preparação ou de identidade (journal,
// preparação bloqueada) não são causais e ficam fora; a preparação vai em platform_signals.
// A chave é o id do predicado; a versão do predicado (pred/0.1) não entra na regra.

const RULES_VERSION = 'rules/0.1';

/** categoria → ids de predicado cujo FACT é compatível com ela. */
const COMPATIBLE = Object.freeze({
    requirement_spec: Object.freeze(['spec_change_approved_in_cycle']),
    db_migration: Object.freeze(['db_migration_authorized_in_window']),
    already_resolved: Object.freeze(['handed_back_qa_prior']),
});

/** categoria → ids de predicado cujo FACT contraria a categoria (derruba MODERATE e WEAK). */
const CONTRARY = Object.freeze({
    requirement_spec: Object.freeze(['spec_change_absent_in_cycle']),
    db_migration: Object.freeze(['db_migration_absent_in_window']),
    already_resolved: Object.freeze(['handed_back_qa_absent']),
});

/** `pred:<id>@<ver>` → `<id>`; null se não for uma referência. */
function predicateId(ref) {
    if (typeof ref !== 'string' || !ref.startsWith('pred:')) return null;
    const at = ref.indexOf('@');
    return at > 5 ? ref.slice(5, at) : null;
}

const listed = (table, category, ref) => (table[category] || []).includes(predicateId(ref));
const isCompatible = (category, ref) => listed(COMPATIBLE, category, ref);
const isContrary = (category, ref) => listed(CONTRARY, category, ref);

module.exports = { RULES_VERSION, COMPATIBLE, CONTRARY, predicateId, isCompatible, isContrary };
