#!/usr/bin/env node
// PRI-353 (T5, AC8): benchmark offline do piloto de esforço fixo por fase (N runs pareadas,
// esforço fixo contra AS-IS). Gera JSON e uma página HTML com tempo, uso de limite, falhas e
// `effort_miss` por fase. SPEC: tasks/effort-por-fase/SPEC.md. Rodar o piloto de verdade é a PRI-354.
//
// STATUS: ferramenta offline, SÓ LEITURA sobre as runs (nunca escreve em memory/) e fora do
// watcher, do harness e de qualquer estado de Run. Não é canal de despacho nem decide nada: não
// há veredito, só os números e o que falta.
//
// Regras de honestidade (AGENTS.md 7): onde não há medição a página mostra UNKNOWN, nunca zero
// nem valor de exemplo. Mediana só sobre quem mediu, com o n ao lado. Ausência de registro de
// `effort_miss` é UNKNOWN. "Uso de limite" é proxy: tokens de entrada+saída (a assinatura não
// expõe o consumo de limite por run). Custo em dinheiro está fora de escopo.
//
// Reaproveita, sem lógica paralela: scripts/lib/run-comparator.js (leitura de run, tokens por nó,
// status), dashboard/cost-projection.js (duração por nó, já saneada) e scripts/lib/effort-miss.js
// (projeção do registro).
//
// Uso:
//   node scripts/probes/effort-benchmark.js --out <dir> [--manifest <pares.json>] [--expected 10]
//   manifest: { "pairs": [ { "id": "p1", "as_is": "<run-ref>", "fixed": "<run-ref>" } ] }
//   Sem --manifest gera a página vazia (só UNKNOWN). REPO_PATH aponta o checkout com as runs.

'use strict';

const fs = require('fs');
const path = require('path');

const comparator = require('../lib/run-comparator');
const { projectCostTracking } = require('../../dashboard/cost-projection');
const { projectEffortMisses } = require('../lib/effort-miss');
const { loadPhaseEffortTable } = require('../lib/phase-effort');
const { median } = require('./effort-flag-probe');

const { NA } = comparator;
const PHASES = ['plan', 'implement', 'review', 'test', 'verify', 'commit'];
const ARMS = ['as_is', 'fixed'];
const DEFAULT_EXPECTED = 10;
const MAX_PAIRS = 200;
const JSON_FILE = 'effort-benchmark.json';
const HTML_FILE = 'effort-benchmark.html';

const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const finite = v => (typeof v === 'number' && Number.isFinite(v) ? v : null);

// ---------------------------------------------------------------------------------
// Conta (pura)

function attemptsOf(run) {
    const nodes = isObj(run?.cost_tracking?.nodes) ? Object.values(run.cost_tracking.nodes) : [];
    return nodes.flatMap(n => (Array.isArray(n?.attempts) ? n.attempts : []));
}

// Confere o rótulo do braço contra o que a run registrou (T2: Attempt.phase_effort).
// CONFIRMED | CONTRADICTED | NOT_OBSERVED (sem Attempt registrado, não dá para saber).
function armCheck(run, arm) {
    const attempts = attemptsOf(run);
    if (!attempts.length) return { status: 'NOT_OBSERVED' };
    const applied = attempts.some(a => a?.phase_effort?.effort_applied === true);
    if (arm === 'as_is') return applied ? { status: 'CONTRADICTED', reason: 'braço AS-IS com phase_effort aplicado' } : { status: 'CONFIRMED' };
    return applied ? { status: 'CONFIRMED' } : { status: 'CONTRADICTED', reason: 'braço fixo sem phase_effort aplicado' };
}

function phaseDuration(run, phase) {
    const projected = projectCostTracking(run?.cost_tracking)?.nodes?.[phase];
    return finite(projected?.duration_ms);
}

const measure = values => {
    const known = values.filter(v => v !== null);
    return { median: median(known), n: known.length };
};
const delta = (asIs, fixed) => (asIs.median !== null && fixed.median !== null ? fixed.median - asIs.median : null);

function failedRuns(statuses) {
    const known = statuses.filter(s => s !== null);
    return { count: known.length ? known.filter(s => comparator.statusOutcome(s) === 'failure').length : null, n: known.length };
}

function effortMissByPhase(fixedRuns, table) {
    const projected = projectEffortMisses(fixedRuns.map(r => ({ taskId: r.taskId, state: r.state })));
    return Object.fromEntries(PHASES.map(phase => {
        if (table?.[phase] !== 'medium') return [phase, { status: 'NOT_APPLICABLE' }];
        const bucket = projected.by_phase[phase];
        return [phase, bucket ? { status: 'RECORDED', ...bucket } : { status: 'UNKNOWN' }];
    }));
}

function buildBenchmark({ pairs = [], expectedPairs = DEFAULT_EXPECTED, table, source = 'NO_MANIFEST', now = new Date().toISOString() } = {}) {
    const tbl = table || (() => {
        const loaded = loadPhaseEffortTable();
        return loaded.ok ? loaded.table : {};
    })();

    const valid = [];
    const excluded = [];
    const unconfirmed = [];
    for (const [i, pair] of pairs.entries()) {
        const id = pair.id || `pair-${i + 1}`;
        const checks = ARMS.map(arm => ({ arm, ...armCheck(pair[arm], arm) }));
        const bad = checks.find(c => c.status === 'CONTRADICTED');
        if (bad) { excluded.push({ id, reason: bad.reason }); continue; }
        if (checks.some(c => c.status === 'NOT_OBSERVED')) unconfirmed.push(id);
        valid.push({ id, as_is: pair.as_is, fixed: pair.fixed, cmp: comparator.compareRuns(pair.as_is, pair.fixed) });
    }

    const numberOrNull = v => (v === NA ? null : finite(v));
    const statusOf = (pair, side) => {
        const v = pair.cmp.metrics.find(m => m.key === 'status')?.[side];
        return typeof v === 'string' && v !== NA ? v : null;
    };

    const phases = PHASES.map(phase => {
        const row = { phase, effort: tbl[phase] ?? null };
        for (const arm of ARMS) {
            const side = arm === 'as_is' ? 'a' : 'b';
            const retries = valid.map(p => finite(p[arm].state?.retries?.[phase])).filter(v => v !== null);
            row[arm] = {
                duration_ms: measure(valid.map(p => phaseDuration(p[arm], phase))),
                tokens: measure(valid.map(p => numberOrNull(p.cmp.tokenDiff.nodes.find(n => n.node === phase)?.[side]))),
                retries: { total: retries.length ? retries.reduce((a, b) => a + b, 0) : null, n: retries.length },
            };
        }
        row.delta = { duration_ms: delta(row.as_is.duration_ms, row.fixed.duration_ms), tokens: delta(row.as_is.tokens, row.fixed.tokens) };
        return row;
    });
    const misses = effortMissByPhase(valid.map(p => p.fixed), tbl);
    for (const row of phases) row.effort_miss = misses[row.phase];

    return {
        generated_at: now,
        source,
        notes: [
            'Uso de limite = tokens de entrada+saída (proxy). A assinatura não expõe o consumo de limite por run.',
            'UNKNOWN = sem medição. Nunca vale zero. Mediana só sobre quem mediu (n ao lado).',
            'effort_miss é julgamento de quem registrou (review, verify ou humano) e só existe para fase em esforço médio.',
        ],
        pairs: { expected: expectedPairs, received: pairs.length, valid: valid.length, excluded, unconfirmed },
        runs_failed: {
            as_is: failedRuns(valid.map(p => statusOf(p, 'a'))),
            fixed: failedRuns(valid.map(p => statusOf(p, 'b'))),
        },
        phases,
    };
}

// ---------------------------------------------------------------------------------
// HTML (autocontido, sem script nem recurso externo)

const esc = v => String(v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const UNKNOWN = 'UNKNOWN';

function fmtMs(ms) {
    if (ms === null) return UNKNOWN;
    if (ms < 1000) return `${Math.round(ms)}ms`;
    const s = Math.round(ms / 1000);
    return s >= 60 ? `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s` : `${s}s`;
}
const fmtInt = v => (v === null ? UNKNOWN : Math.round(v).toLocaleString('pt-BR'));
const withN = (text, n) => (text === UNKNOWN ? text : `${text} (n=${n})`);
const signed = (v, fmt) => (v === null ? UNKNOWN : v === 0 ? fmt(0) : `${v > 0 ? '+' : '−'}${fmt(Math.abs(v))}`);

function missCell(m) {
    if (m.status === 'NOT_APPLICABLE') return 'N/A (fase fora de esforço médio)';
    if (m.status !== 'RECORDED') return UNKNOWN;
    return `sim ${m.yes} · não ${m.no} · incerto ${m.unknown}`;
}

function renderHtml(b) {
    const td = (text, extra = '') => `<td class="m${extra}">${esc(text)}</td>`;
    const rows = b.phases.map(p => `<tr><th scope="row">${esc(p.phase)}<span class="eff">${esc(p.effort ?? 'sem entrada')}</span></th>` + [
        td(withN(fmtMs(p.as_is.duration_ms.median), p.as_is.duration_ms.n)),
        td(withN(fmtMs(p.fixed.duration_ms.median), p.fixed.duration_ms.n)),
        td(signed(p.delta.duration_ms, fmtMs)),
        td(withN(fmtInt(p.as_is.tokens.median), p.as_is.tokens.n)),
        td(withN(fmtInt(p.fixed.tokens.median), p.fixed.tokens.n)),
        td(signed(p.delta.tokens, fmtInt)),
        td(withN(fmtInt(p.as_is.retries.total), p.as_is.retries.n)),
        td(withN(fmtInt(p.fixed.retries.total), p.fixed.retries.n)),
        td(missCell(p.effort_miss)),
    ].join('') + '</tr>').join('\n');

    const failCell = f => td(f.count === null ? UNKNOWN : `${f.count} de ${f.n}`);
    const excluded = b.pairs.excluded.length
        ? `<h2>Pares excluídos</h2><ul>${b.pairs.excluded.map(e => `<li><code>${esc(e.id)}</code>: ${esc(e.reason)}</li>`).join('')}</ul>` : '';
    const unconfirmed = b.pairs.unconfirmed.length
        ? `<p class="warn">Rótulo não confirmável (run sem Attempt registrado): ${b.pairs.unconfirmed.map(i => `<code>${esc(i)}</code>`).join(', ')}.</p>` : '';

    return `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Benchmark de esforço por fase</title>
<style>
:root { --bg: #fbfbfa; --fg: #1d1d1b; --muted: #6a6a64; --line: #dcdcd6; --head: #f0f0ec; --warn: #8a5a00; }
@media (prefers-color-scheme: dark) { :root { --bg: #161615; --fg: #ececE8; --muted: #9a9a92; --line: #333330; --head: #222220; --warn: #e0b050; } }
body { margin: 0; padding: 24px 16px; background: var(--bg); color: var(--fg); font: 15px/1.5 system-ui, sans-serif; }
main { max-width: 1100px; margin: 0 auto; }
h1 { font-size: 1.3rem; margin: 0 0 4px; } h2 { font-size: 1.05rem; margin: 28px 0 8px; }
p, li { max-width: 70ch; } .muted { color: var(--muted); } .warn { color: var(--warn); }
.wrap { overflow-x: auto; }
table { border-collapse: collapse; width: 100%; min-width: 860px; font-variant-numeric: tabular-nums; }
th, td { border-bottom: 1px solid var(--line); padding: 6px 10px; text-align: left; vertical-align: top; }
thead th { background: var(--head); font-weight: 600; font-size: 0.85rem; }
.eff { display: block; font-weight: 400; font-size: 0.8rem; color: var(--muted); }
code { font-size: 0.9em; }
</style>
</head>
<body>
<main>
<h1>Benchmark de esforço fixo por fase</h1>
<p class="muted">PRI-353 · esforço fixo contra AS-IS · gerado em ${esc(b.generated_at)} · fonte: ${esc(b.source)}</p>
<p>Pares recebidos: ${b.pairs.received} de ${b.pairs.expected} esperados. Pares válidos: ${b.pairs.valid}. Piloto real é a PRI-354.</p>
${unconfirmed}
<h2>Por fase</h2>
<div class="wrap"><table>
<thead><tr><th scope="col">Fase</th><th scope="col">Tempo AS-IS</th><th scope="col">Tempo fixo</th><th scope="col">Δ tempo</th><th scope="col">Tokens AS-IS</th><th scope="col">Tokens fixo</th><th scope="col">Δ tokens</th><th scope="col">Retries AS-IS</th><th scope="col">Retries fixo</th><th scope="col">effort_miss (fixo)</th></tr></thead>
<tbody>
${rows}
</tbody></table></div>
<h2>Falhas por braço</h2>
<div class="wrap"><table style="min-width:0">
<thead><tr><th scope="col">Runs em status de falha, AS-IS</th><th scope="col">Runs em status de falha, fixo</th></tr></thead>
<tbody><tr>${failCell(b.runs_failed.as_is)}${failCell(b.runs_failed.fixed)}</tr></tbody></table></div>
${excluded}
<h2>Como ler</h2>
<ul>${b.notes.map(n => `<li>${esc(n)}</li>`).join('')}</ul>
</main>
</body>
</html>
`;
}

// ---------------------------------------------------------------------------------
// CLI

const USAGE = 'uso: node scripts/probes/effort-benchmark.js --out <dir> [--manifest <pares.json>] [--expected 10]';

function parseArgs(argv) {
    const out = { expected: DEFAULT_EXPECTED };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        const eq = a.startsWith('--') ? a.indexOf('=') : -1;
        const flag = eq < 0 ? a : a.slice(0, eq);
        const value = () => {
            const v = eq < 0 ? argv[++i] : a.slice(eq + 1);
            if (v === undefined) throw new Error(`${flag} precisa de um valor`);
            return v;
        };
        if (flag === '--out') out.out = value();
        else if (flag === '--manifest') out.manifest = value();
        else if (flag === '--expected') {
            const n = Number(value());
            if (!Number.isInteger(n) || n < 1 || n > MAX_PAIRS) throw new Error(`--expected deve ser inteiro de 1 a ${MAX_PAIRS}`);
            out.expected = n;
        } else throw new Error(`argumento desconhecido: ${a}`);
    }
    if (!out.out) throw new Error('--out é obrigatório');
    return out;
}

function readManifest(file) {
    let value;
    try { value = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { throw new Error(`manifest ilegível: ${e.code || e.message}`); }
    if (!isObj(value) || !Array.isArray(value.pairs)) throw new Error('manifest inválido: "pairs" deve ser uma lista');
    if (value.pairs.length > MAX_PAIRS) throw new Error(`manifest com pares demais (máx. ${MAX_PAIRS})`);
    return value.pairs.map((p, i) => {
        const ok = ref => typeof ref === 'string' && ref.trim() !== '';
        if (!isObj(p) || !ok(p.as_is) || !ok(p.fixed)) throw new Error(`manifest inválido: pairs[${i}] precisa de "as_is" e "fixed" (ref de run)`);
        return { id: typeof p.id === 'string' && p.id ? p.id : `pair-${i + 1}`, as_is: p.as_is, fixed: p.fixed };
    });
}

function assertOutOutsideRuns(out, runs) {
    const target = path.resolve(out);
    for (const r of runs) {
        const dir = path.resolve(r.dir);
        if (target === dir || target.startsWith(dir + path.sep)) throw new Error(`--out dentro do diretório da run ${r.ref}: escolha outro caminho; o benchmark não escreve em runs`);
    }
}

function main(argv = process.argv.slice(2), io = { stdout: process.stdout, stderr: process.stderr, env: process.env }) {
    let args;
    try { args = parseArgs(argv); } catch (e) { io.stderr.write(`${e.message}\n${USAGE}\n`); return 2; }
    try {
        const repoPath = io.env.REPO_PATH || process.cwd();
        const refs = args.manifest ? readManifest(args.manifest) : [];
        const loaded = refs.map(p => ({ id: p.id, as_is: comparator.loadRun(p.as_is, { repoPath }), fixed: comparator.loadRun(p.fixed, { repoPath }) }));
        assertOutOutsideRuns(args.out, loaded.flatMap(p => [p.as_is, p.fixed]));
        const result = buildBenchmark({ pairs: loaded, expectedPairs: args.expected, source: args.manifest ? path.basename(args.manifest) : 'NO_MANIFEST' });
        fs.mkdirSync(args.out, { recursive: true });
        fs.writeFileSync(path.join(args.out, JSON_FILE), `${JSON.stringify(result, null, 2)}\n`);
        fs.writeFileSync(path.join(args.out, HTML_FILE), renderHtml(result));
        io.stdout.write(`benchmark gravado em ${args.out} (${result.pairs.valid} de ${result.pairs.received} pares válidos)\n`);
        return 0;
    } catch (e) {
        io.stderr.write(`${e.message}\n`);
        return 1;
    }
}

if (require.main === module) process.exitCode = main();

module.exports = { buildBenchmark, renderHtml, parseArgs, main, armCheck, PHASES };
