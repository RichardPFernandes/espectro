'use strict';
// PRI-181 C3 — orquestra coleta + predicados → findings para o Diagnosis Record.
// Sem piloto, sem agente, sem dados corporativos no pacote.

const collect = require('./qa-diagnosis-collect');
const predicates = require('./qa-diagnosis-predicates');

/**
 * @returns {{
 *   pack: object,
 *   findings: object[],
 *   findings_status: string,
 *   taxonomy_version: string,
 *   evidence_refs: object[],
 * }}
 */
function analyzeRejection({
    identity = null,
    state = null,
    ticketId = null,
    repoPath = null,
    taskId = null,
    at = new Date().toISOString(),
} = {}) {
    const pack = collect.collectEvidencePack({
        identity, state, ticketId, repoPath, taskId, at,
    });
    const evaluated = predicates.evaluatePredicates(pack);
    return {
        pack,
        evidence_refs: pack.evidence_refs,
        findings: evaluated.findings,
        findings_status: evaluated.findings_status,
        taxonomy_version: evaluated.taxonomy_version,
        causal_auto: false,
        corporate_content_included: pack.corporate_content_included,
    };
}

module.exports = {
    analyzeRejection,
};
