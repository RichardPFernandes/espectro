'use strict';
// PRI-341 (T3, AC-5): comparador de custo, Run decomposta × monomodelo. Função pura sobre o
// state.json das Runs; só lê, não escreve estado, não despacha, não decide nada.
//
// Mora em scripts/ e não no dashboard: a regra G3 no-dashboard-scripts-internals impede o
// dashboard de importar scripts/lib. A regra de custo é a do buildMix (dashboard/routing-projection.js):
// custo ausente ou inválido é `null` e conta como "sem preço"; nunca soma como 0 (UNK-AR-006).
//
// Tipo da Run, por state.decomposition (schema state.schema.json):
//   - status DECOMPOSABLE      → "decomposed" (a decomposição de fato rodou);
//   - status NOT_DECOMPOSABLE  → "not_decomposable" (flag ligada, mas a Run seguiu o caminho da S4;
//                                 fica separada para não inflar nenhum dos dois braços);
//   - sem state.decomposition  → "monomodel".
//
// Indicador, sem limiar (D7): com n pequeno nada aqui prova economia.

const KINDS = ['monomodel', 'decomposed', 'not_decomposable'];
const round6 = n => Math.round(n * 1e6) / 1e6;
// Teto de plausibilidade por Attempt (USD). Acima disso o dado é lixo e conta como sem preço;
// com o teto, a soma nunca chega a Infinity.
const MAX_ATTEMPT_USD = 1e6;
const isObj = v => v != null && typeof v === 'object' && !Array.isArray(v);

function usd(v) {
    return typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= MAX_ATTEMPT_USD ? v : null;
}

function kindOf(state) {
    const d = isObj(state) ? state.decomposition : undefined;
    if (!isObj(d)) return 'monomodel';
    return d.status === 'DECOMPOSABLE' ? 'decomposed' : 'not_decomposable';
}

function addTo(acc, cost) {
    acc.attempts += 1;
    if (cost == null) acc.unpriced += 1;
    else { acc.priced += 1; acc.cost = round6((acc.cost ?? 0) + cost); }
}

function summarizeRun({ run_id, state }) {
    const total = { attempts: 0, priced: 0, unpriced: 0, cost: null };
    const impl = { attempts: 0, priced: 0, unpriced: 0, cost: null };
    const nodes = isObj(state?.cost_tracking?.nodes) ? state.cost_tracking.nodes : {};
    for (const [nodeKey, node] of Object.entries(nodes)) {
        if (!isObj(node) || !Array.isArray(node.attempts)) continue;
        for (const a of node.attempts) {
            if (!isObj(a)) continue;
            const cost = usd(a.cost?.usd);
            addTo(total, cost);
            if (nodeKey === 'implement') addTo(impl, cost);
        }
    }
    return {
        run_id: String(run_id),
        kind: kindOf(state),
        attempts: total.attempts,
        priced_attempts: total.priced,
        unpriced_attempts: total.unpriced,
        cost_usd: total.cost,
        // Completa = tem Attempt e todos com preço. Só estas entram nas médias por Run.
        complete: total.attempts > 0 && total.unpriced === 0,
        implement_cost_usd: impl.cost,
        implement_complete: impl.attempts > 0 && impl.unpriced === 0,
    };
}

const mean = values => (values.length ? round6(values.reduce((s, v) => s + v, 0) / values.length) : null);

function summarizeKind(runs) {
    const complete = runs.filter(r => r.complete);
    const implComplete = runs.filter(r => r.implement_complete);
    const priced = runs.reduce((s, r) => s + r.priced_attempts, 0);
    const cost = runs.reduce((s, r) => (r.cost_usd == null ? s : round6(s + r.cost_usd)), 0);
    return {
        runs: runs.length,
        complete_runs: complete.length,
        attempts: runs.reduce((s, r) => s + r.attempts, 0),
        priced_attempts: priced,
        unpriced_attempts: runs.reduce((s, r) => s + r.unpriced_attempts, 0),
        mean_cost_per_run_usd: mean(complete.map(r => r.cost_usd)),
        mean_implement_usd: mean(implComplete.map(r => r.implement_cost_usd)),
        // Por Attempt: só Attempts com preço (nunca 0 no lugar de ausente).
        mean_cost_per_attempt_usd: priced > 0 ? round6(cost / priced) : null,
    };
}

/**
 * @param {Array<{ run_id: string, state: object }>} runs state.json parseado de cada Run
 */
function compareRuns(runs) {
    const list = (Array.isArray(runs) ? runs : []).map(summarizeRun);
    const by_kind = {};
    for (const k of KINDS) by_kind[k] = summarizeKind(list.filter(r => r.kind === k));
    const m = by_kind.monomodel.mean_cost_per_run_usd;
    const d = by_kind.decomposed.mean_cost_per_run_usd;
    const both = m != null && d != null;
    return {
        runs: list,
        by_kind,
        diff: {
            decomposed_minus_monomodel_per_run_usd: both ? round6(d - m) : null,
            ratio_per_run: both && m > 0 ? round6(d / m) : null,
        },
    };
}

const fmt = v => (v == null ? 'n/d' : String(v));
// Célula de tabela markdown: `|` e quebra de linha do nome da Run não podem quebrar a tabela.
const cell = v => String(v).replace(/[|\r\n]+/g, ' ');

/** Tabela markdown para colar no PR (Evidência) e na issue. `n/d` = sem dado, nunca 0. */
function formatMarkdown(result) {
    const lines = [
        '| Braço | Runs | Runs completas | Attempts (com preço / sem preço) | Média por Run (USD) | Média do implement (USD) | Média por Attempt (USD) |',
        '| -- | -- | -- | -- | -- | -- | -- |',
    ];
    for (const k of KINDS) {
        const s = result.by_kind[k];
        lines.push(`| ${k} | ${s.runs} | ${s.complete_runs} | ${s.priced_attempts} / ${s.unpriced_attempts} | ${fmt(s.mean_cost_per_run_usd)} | ${fmt(s.mean_implement_usd)} | ${fmt(s.mean_cost_per_attempt_usd)} |`);
    }
    lines.push('', `Diferença por Run (decomposta − monomodelo): ${fmt(result.diff.decomposed_minus_monomodel_per_run_usd)} USD; razão: ${fmt(result.diff.ratio_per_run)}.`,
        'Indicador, sem limiar (D7). Média só sobre Runs completas (todo Attempt com preço); `n/d` = sem dado.', '',
        '| Run | Tipo | Attempts | Sem preço | Custo (USD) | implement (USD) |', '| -- | -- | -- | -- | -- | -- |');
    for (const r of result.runs) {
        lines.push(`| ${cell(r.run_id)} | ${r.kind} | ${r.attempts} | ${r.unpriced_attempts} | ${fmt(r.cost_usd)}${r.complete ? '' : ' (parcial)'} | ${fmt(r.implement_cost_usd)} |`);
    }
    return lines.join('\n');
}

module.exports = { compareRuns, formatMarkdown };
