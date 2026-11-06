// Núcleo 2 do roteamento (PRI-205 S3b): quem o Jev pergunta, em sombra (SPEC §B3).
//
// Função pura sobre a saída do núcleo 1 (would-route.classifySubtask, R1–R8). Não lê
// disco, relógio nem rede, e não muda a classe: só diz se o grupo é perguntado e
// por quê.
//
// - Exclusões soberanas (nunca perguntadas): sensível true ou UNKNOWN, R2, schema
//   ≠ false, kind behavior/config, ≥ 2 serviços, retrabalho (Q3) e Plan acima da
//   classe calculada.
// - G1 (zona cinzenta): R3 por falta de sinal que não é de segurança.
// - G2 (zona cinzenta): R8, ou R4 só por n_files, com R7 ou R6 falhando em
//   exatamente um predicado numérico por exatamente 1 unidade.
// - G3 (sonda de subida, Q0' do Richard em 2026-11-06): classe C1–C3. Só a subida é
//   registrada; a descida é ignorada (a direção fica para o classifier-shadow).
//
// prioritize corta em MAX_CALLS_PER_VISIT (Q8), com G1/G2 antes de G3.

const wouldRoute = require('./would-route');

const MAX_CALLS_PER_VISIT = 3;
const PROBE_CLASSES = new Set(['C1', 'C2', 'C3']);

function isNumber(v) {
    return typeof v === 'number' && Number.isFinite(v);
}

function hasRework(s) {
    return Boolean(s.ticket_rework) || Number(s.rework_count) > 0;
}

function exclusion(s, hit) {
    if (s.sensitive_decl !== false) return 'EXCLUDED_SENSITIVE';
    if (hit.rule === 'R2') return 'EXCLUDED_R2';
    if (s.schema_decl !== false) return 'EXCLUDED_SCHEMA';
    if (s.kind === 'behavior' || s.kind === 'config') return 'EXCLUDED_KIND';
    if (isNumber(s.n_services_decl) && s.n_services_decl >= 2) return 'EXCLUDED_SERVICES';
    if (hasRework(s)) return 'EXCLUDED_REWORK';
    if (hit.selection_source === 'PLAN_RAISED') return 'EXCLUDED_PLAN_RAISED';
    if (hit.selection_source === 'CONSERVATIVE_DEFAULT') return 'EXCLUDED_CLASSIFIER_ERROR';
    return null;
}

// Regras das classes abaixo de C4, separadas em predicados não numéricos (têm de
// valer) e cortes numéricos (`campo ≤ corte`). Espelham R7 e R6 de would-route.
const LOWER_RULES = [
    {
        rule: 'R7',
        nonNumeric: s => s.kind === 'test' || s.kind === 'docs' || s.code_local === true,
        cuts: { n_files: 5, n_acs_step: 3 },
    },
    {
        rule: 'R6',
        nonNumeric: s => s.kind === 'test' || s.code_local === true,
        cuts: { n_files: 2, n_new_files: 1, n_acs_step: 2 },
    },
];

function oneCriterionAway(s) {
    for (const r of LOWER_RULES) {
        if (!r.nonNumeric(s)) continue;
        let failed = 0;
        let byOne = true;
        for (const [field, cut] of Object.entries(r.cuts)) {
            const v = s[field];
            if (!isNumber(v)) { failed = Infinity; break; }
            if (v > cut) {
                failed += 1;
                if (v !== cut + 1) byOne = false;
            }
        }
        if (failed === 1 && byOne) return r.rule;
    }
    return null;
}

/**
 * @param {object} signals sinais prospectivos S2 de um grupo
 * @param {string|null} planClass classe proposta pelo Plan (só sobe)
 * @returns {{ call: boolean, probe: 'GRAY'|'UPGRADE_PROBE'|null, reason: string,
 *   class: string, rule: string, near_rule?: string }}
 */
function eligibility(signals, planClass = null) {
    const s = signals && typeof signals === 'object' ? signals : {};
    const hit = wouldRoute.classifySubtask(s, planClass);
    const base = { class: hit.class, rule: hit.rule };
    const excluded = exclusion(s, hit);
    if (excluded) return { call: false, probe: null, reason: excluded, ...base };

    if (hit.rule === 'R3') return { call: true, probe: 'GRAY', reason: 'G1', ...base };
    if (hit.rule === 'R8' || hit.rule === 'R4') {
        // Depois das exclusões, R4 só pode ter vindo de n_files > 5.
        const near = oneCriterionAway(s);
        if (near) return { call: true, probe: 'GRAY', reason: 'G2', near_rule: near, ...base };
        return { call: false, probe: null, reason: 'NOT_GRAY', ...base };
    }
    if (PROBE_CLASSES.has(hit.class)) return { call: true, probe: 'UPGRADE_PROBE', reason: 'G3', ...base };
    return { call: false, probe: null, reason: 'NOT_GRAY', ...base };
}

/**
 * Marca cada grupo como SELECTED, SKIPPED_BUDGET ou NOT_ELIGIBLE, mantendo a ordem
 * recebida. Seleciona primeiro os da zona cinzenta (G1/G2) e depois a sonda (G3).
 * @param {{ subtask_key?: string, signals?: object, plan_class?: string|null }[]} groups
 */
function prioritize(groups, max = MAX_CALLS_PER_VISIT) {
    const out = (Array.isArray(groups) ? groups : []).map(g => ({
        ...g,
        eligibility: eligibility(g && g.signals, (g && g.plan_class) || null),
        status: 'NOT_ELIGIBLE',
    }));
    let left = max;
    for (const probe of ['GRAY', 'UPGRADE_PROBE']) {
        for (const g of out) {
            if (g.eligibility.probe !== probe) continue;
            if (left > 0) { g.status = 'SELECTED'; left -= 1; } else g.status = 'SKIPPED_BUDGET';
        }
    }
    return out;
}

module.exports = { eligibility, prioritize, MAX_CALLS_PER_VISIT };
