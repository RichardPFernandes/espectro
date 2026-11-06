'use strict';
// Writer SDD por projeto (PRI-266, DS-09 A) — índice dos papéis do contrato PRI-231 r4:
//   W-C  sdd-writer-check    checagem de integração (único ponto de commit)
//   W-P  sdd-writer-prepare  preparação/proposta, marcador em voo e retomada (sem autoridade)
//   W-R  sdd-writer-replay   reconhecimento de replay (caminho R, somente leitura)
//   W-A  sdd-writer-audit    auditoria pós-integração, âncoras e estado derivado
// O writer executa a consequência; a autoridade é a Decision (RRC-SDD-002 §4.7).
// Nenhuma operação protegida real roda sem HP-1/2/7/8 demonstradas no host (F8 fora, D-266-2).

module.exports = {
    jcs: require('./sdd-writer-jcs'),
    command: require('./sdd-writer-command'),
    git: require('./sdd-writer-git'),
    log: require('./sdd-writer-log'),
    catalog: require('./sdd-writer-catalog'),
    decision: require('./sdd-writer-decision'),
    decide: require('./sdd-writer-decide'),
    replay: require('./sdd-writer-replay'),
};
