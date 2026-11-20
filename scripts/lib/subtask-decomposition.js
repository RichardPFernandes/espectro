// Identidade das subtarefas do Implement (PRI-310 / PRI-287 S5.1, SDD B2/AC-04; v9 §3.4, D14).
//
// Puro: reusa extractPlanSteps/groupSteps da S2 (plan-signals.js), sem recalcular nada.
// - plan_version = SHA-256 do bloco "## Plano de execução" normalizado (S2).
// - subtask_key = <pv[0:12]>/<menor>-<maior> do grupo por arquivos em comum (S2).
// - Grupos intercalados (o intervalo [min, max] de um grupo contém passo de outro) →
//   NOT_DECOMPOSABLE: fundir mudaria as chaves já usadas pelos sinais e pelo núcleo 2; o nó
//   segue o caminho da S4 (um Attempt), registrado, sem bloquear.
// - Passo sem `Arquivo:` parseável = grupo próprio, paths_decl UNKNOWN (classe C4, S5.2).
// - Replan: chaves da versão anterior viram SUPERSEDED; nada é herdado por posição.
// A gravação em state.json e a ligação no watcher são da S5.2.

const planSignals = require('./plan-signals');
const { allKey } = require('./dom06-attempt');

const UNKNOWN = planSignals.UNKNOWN;

function interleaved(groups) {
    for (const g of groups) {
        const min = g.steps[0];
        const max = g.steps[g.steps.length - 1];
        for (const other of groups) {
            if (other === g) continue;
            if (other.steps.some(s => s > min && s < max)) return true;
        }
    }
    return false;
}

/**
 * @returns {{ status: 'DECOMPOSABLE'|'NOT_DECOMPOSABLE', cause: string|null, plan_version: string|null,
 *   groups: Array<{ subtask_key: string, steps: number[], paths_decl: string[]|'UNKNOWN' }>,
 *   scope_paths: string[] }}
 */
function decomposePlan(planContent) {
    const { plan_version: pv, steps } = planSignals.extractPlanSteps(String(planContent || ''));
    if (!pv || !steps.length) return { status: 'NOT_DECOMPOSABLE', cause: 'PLAN_BLOCK_NOT_FOUND', plan_version: null, groups: [], scope_paths: [] };
    const groups = planSignals.groupSteps(pv, steps).map(g => {
        const declared = g.members.map(m => m.paths_decl);
        const paths = declared.some(p => p === UNKNOWN) ? UNKNOWN : [...new Set(declared.flat())].sort();
        return { subtask_key: g.subtask_key, steps: [...g.steps], paths_decl: paths };
    });
    const scope = [...new Set(groups.flatMap(g => (g.paths_decl === UNKNOWN ? [] : g.paths_decl)))].sort();
    if (interleaved(groups)) return { status: 'NOT_DECOMPOSABLE', cause: 'INTERLEAVED_GROUPS', plan_version: pv, groups, scope_paths: scope };
    return { status: 'DECOMPOSABLE', cause: null, plan_version: pv, groups, scope_paths: scope };
}

/** Chaves da versão anterior que ficam SUPERSEDED quando a plan_version muda. */
function superseded(previous, next) {
    if (!previous || !previous.plan_version || !next || previous.plan_version === next.plan_version) return [];
    return (previous.groups || []).map(g => ({ subtask_key: g.subtask_key, plan_version: previous.plan_version, status: 'SUPERSEDED' }));
}

module.exports = { decomposePlan, superseded, interleaved, allKey };
