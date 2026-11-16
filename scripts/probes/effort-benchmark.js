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

// PRI-354 (MINOR 4): soma parcial não entra na mediana. O cost-tracking grava 0 quando a duração
// não foi medida (e nenhum despacho real dura 0 ms) e conta runs_without_tokens por nó.
const PARTIAL = Symbol('PARTIAL');

// Fase coberta por um segmento (also_covers: implement cobrindo plan no [plan, implement]) não tem
// medição separada: tanto a fase coberta quanto a que cobre ficam parciais (não comparáveis).
function coveredBySegment(run, phase) {
    const nodes = isObj(run?.cost_tracking?.nodes) ? run.cost_tracking.nodes : {};
    return Object.entries(nodes).some(([node, entry]) => {
        const covers = Array.isArray(entry?.also_covers) ? entry.also_covers.filter(c => PHASES.includes(c)) : [];
        return covers.length > 0 && (node === phase || covers.includes(phase));
    });
}

function phaseDuration(run, phase) {
    const projected = finite(projectCostTracking(run?.cost_tracking)?.nodes?.[phase]?.duration_ms);
    if (projected === null) return coveredBySegment(run, phase) ? PARTIAL : null;
    if (projected <= 0 || coveredBySegment(run, phase)) return PARTIAL;
    const node = run?.cost_tracking?.nodes?.[phase];
    const attempts = Array.isArray(node?.attempts) ? node.attempts : null;
    if (attempts) {
        const runs = finite(node.runs);
        if ((runs !== null && attempts.length < runs) || attempts.some(a => !(finite(a?.duration_ms) > 0))) return PARTIAL;
    }
    return projected;
}

function phaseTokens(run, value, phase) {
    if (value === null) return coveredBySegment(run, phase) ? PARTIAL : null;
    const node = run?.cost_tracking?.nodes?.[phase];
    const without = finite(node?.runs_without_tokens);
    // Um dos dois contadores ausente = soma de um lado só (o cost-tracking só conta os dois null).
    const oneSided = (finite(node?.input_tokens) === null) !== (finite(node?.output_tokens) === null);
    return (without !== null && without > 0) || oneSided || coveredBySegment(run, phase) ? PARTIAL : value;
}

const measure = values => {
    const known = values.filter(v => typeof v === 'number');
    const partial = values.filter(v => v === PARTIAL).length;
    return { median: median(known), n: known.length, ...(partial ? { partial } : {}) };
};

// PRI-354 (MINOR 5): Δ pareado = mediana das diferenças por par, só onde os dois lados mediram.
function pairedDelta(asIsValues, fixedValues) {
    const diffs = asIsValues.map((a, i) => (typeof a === 'number' && typeof fixedValues[i] === 'number' ? fixedValues[i] - a : null)).filter(v => v !== null);
    return { value: median(diffs), n: diffs.length };
}

// PRI-354 (MINOR 3): nível por fase vem do que o braço fixo gravou (Attempt.phase_effort), inclusive
// fase coberta no mesmo segmento (also_covers). Sem gravação, a tabela atual entra rotulada.
function recordedLevels(runs, phase) {
    const levels = new Set();
    for (const run of runs) {
        const nodes = isObj(run?.cost_tracking?.nodes) ? run.cost_tracking.nodes : {};
        for (const [node, entry] of Object.entries(nodes)) {
            for (const a of Array.isArray(entry?.attempts) ? entry.attempts : []) {
                const covers = node === phase || (Array.isArray(a?.also_covers) && a.also_covers.includes(phase));
                if (covers && a?.phase_effort?.effort_applied === true && typeof a.phase_effort.level === 'string') levels.add(a.phase_effort.level);
            }
        }
    }
    return [...levels].sort();
}

function phaseEffortOf(fixedRuns, phase, table) {
    const levels = recordedLevels(fixedRuns, phase);
    if (levels.length === 1) return { effort: levels[0], effort_source: 'RECORDED', medium: levels[0] === 'medium' };
    if (levels.length > 1) return { effort: `misto (${levels.join(', ')})`, effort_source: 'RECORDED', medium: levels.includes('medium') };
    const fromTable = table?.[phase] ?? null;
    return { effort: fromTable, effort_source: fromTable ? 'TABLE_LATEST' : 'UNKNOWN', medium: fromTable === 'medium' };
}

function failedRuns(statuses) {
    const known = statuses.filter(s => s !== null);
    return { count: known.length ? known.filter(s => comparator.statusOutcome(s) === 'failure').length : null, n: known.length };
}

function effortMissByPhase(fixedRuns, mediumByPhase) {
    const projected = projectEffortMisses(fixedRuns.map(r => ({ taskId: r.taskId, state: r.state })));
    return Object.fromEntries(PHASES.map(phase => {
        if (!mediumByPhase[phase]) return [phase, { status: 'NOT_APPLICABLE' }];
        const bucket = projected.by_phase[phase];
        // Denominador: sem ele "sim 0" leria como zero acertos nas N runs, e a maioria é UNKNOWN.
        const runsRecorded = projected.runs.filter(r => r.records.some(rec => rec.phase === phase)).length;
        return [phase, bucket ? { status: 'RECORDED', ...bucket, runs_recorded: runsRecorded, runs_total: fixedRuns.length } : { status: 'UNKNOWN' }];
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

    const fixedRuns = valid.map(p => p.fixed);
    const mediumByPhase = {};
    const phases = PHASES.map(phase => {
        const { effort, effort_source, medium } = phaseEffortOf(fixedRuns, phase, tbl);
        mediumByPhase[phase] = medium;
        const row = { phase, effort, effort_source };
        const values = {};
        for (const arm of ARMS) {
            const side = arm === 'as_is' ? 'a' : 'b';
            const retries = valid.map(p => finite(p[arm].state?.retries?.[phase])).filter(v => v !== null);
            values[arm] = {
                duration: valid.map(p => phaseDuration(p[arm], phase)),
                tokens: valid.map(p => phaseTokens(p[arm], numberOrNull(p.cmp.tokenDiff.nodes.find(n => n.node === phase)?.[side]), phase)),
            };
            row[arm] = {
                duration_ms: measure(values[arm].duration),
                tokens: measure(values[arm].tokens),
                retries: { total: retries.length ? retries.reduce((a, b) => a + b, 0) : null, n: retries.length },
            };
        }
        const dDur = pairedDelta(values.as_is.duration, values.fixed.duration);
        const dTok = pairedDelta(values.as_is.tokens, values.fixed.tokens);
        row.delta = { duration_ms: dDur.value, duration_n: dDur.n, tokens: dTok.value, tokens_n: dTok.n };
        return row;
    });
    const misses = effortMissByPhase(fixedRuns, mediumByPhase);
    for (const row of phases) row.effort_miss = misses[row.phase];

    return {
        generated_at: now,
        source,
        notes: [
            'Uso de limite = tokens de entrada+saída (proxy). A assinatura não expõe o consumo de limite por run.',
            'UNKNOWN = sem medição. Nunca vale zero. Mediana só sobre quem mediu (n ao lado); soma parcial fica fora e é contada como "parcial".',
            'Δ = mediana das diferenças fixo − AS-IS por par, só entre pares medidos dos dois lados (n de pares ao lado).',
            'Esforço por fase = o que o braço fixo gravou (phase_effort). "tabela atual" = sem gravação; vale só como referência.',
            'Fase rodada dentro de um segmento (also_covers, ex.: plan+implement) não tem medição separada e conta como parcial.',
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
const withN = (text, n, partial = 0) => {
    const p = partial ? `${partial} parcial` : '';
    if (text === UNKNOWN) return p ? `${text} (${p})` : text;
    return `${text} (n=${n}${p ? `, ${p}` : ''})`;
};
const signed = (v, fmt) => (v === null ? UNKNOWN : v === 0 ? fmt(0) : `${v > 0 ? '+' : '−'}${fmt(Math.abs(v))}`);

function missCell(m) {
    if (m.status === 'NOT_APPLICABLE') return 'N/A (fase fora de esforço médio)';
    if (m.status !== 'RECORDED') return UNKNOWN;
    return `registrado em ${m.runs_recorded} de ${m.runs_total} runs fixas: sim ${m.yes} · não ${m.no} · incerto ${m.unknown}; demais UNKNOWN`;
}

function renderHtml(b) {
    const td = (text, extra = '') => `<td class="m${extra}">${esc(text)}</td>`;
    const effLabel = p => (p.effort ?? 'sem entrada') + (p.effort_source === 'TABLE_LATEST' ? ' (tabela atual, sem gravação)' : '');
    const rows = b.phases.map(p => `<tr><th scope="row">${esc(p.phase)}<span class="eff">${esc(effLabel(p))}</span></th>` + [
        td(withN(fmtMs(p.as_is.duration_ms.median), p.as_is.duration_ms.n, p.as_is.duration_ms.partial)),
        td(withN(fmtMs(p.fixed.duration_ms.median), p.fixed.duration_ms.n, p.fixed.duration_ms.partial)),
        td(withN(signed(p.delta.duration_ms, fmtMs), p.delta.duration_n)),
        td(withN(fmtInt(p.as_is.tokens.median), p.as_is.tokens.n, p.as_is.tokens.partial)),
        td(withN(fmtInt(p.fixed.tokens.median), p.fixed.tokens.n, p.fixed.tokens.partial)),
        td(withN(signed(p.delta.tokens, fmtInt), p.delta.tokens_n)),
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

// PRI-354 (MINOR 6): caminho canônico, segmento a segmento, como o kernel resolve: symlink é
// seguido ANTES do `..` seguinte (path.resolve faria o contrário), e realpath.native normaliza
// maiúsculas no APFS. Parte que ainda não existe é anexada como está.
function canonicalPath(p, cwd = process.cwd()) {
    const raw = path.isAbsolute(p) ? p : `${cwd}${path.sep}${p}`;
    let cur = path.parse(raw).root;
    let exists = true;
    for (const seg of raw.slice(cur.length).split(path.sep)) {
        if (!seg || seg === '.') continue;
        if (seg === '..') { cur = path.dirname(cur); continue; }
        cur = path.join(cur, seg);
        if (exists && fs.existsSync(cur)) cur = fs.realpathSync.native(cur);
        else exists = false;
    }
    return cur;
}

const inside = (target, dir) => target === dir || target.startsWith(dir + path.sep);
const fold = p => p.toLowerCase(); // APFS/HFS+ padrão não diferencia maiúsculas: compara dobrado

// Devolve o caminho canônico conferido; é nele que o benchmark grava.
function assertOutOutsideRuns(out, runs, { repoPath = null } = {}) {
    const target = canonicalPath(out);
    for (const r of runs) {
        if (inside(fold(target), fold(canonicalPath(r.dir)))) throw new Error(`--out dentro do diretório da run ${r.ref}: escolha outro caminho; o benchmark não escreve em runs`);
    }
    if (repoPath && inside(fold(target), fold(canonicalPath(path.join(repoPath, 'memory'))))) {
        throw new Error('--out dentro de memory/ do consumidor: escolha outro caminho; o benchmark não escreve em memory/');
    }
    return target;
}

function main(argv = process.argv.slice(2), io = { stdout: process.stdout, stderr: process.stderr, env: process.env }) {
    let args;
    try { args = parseArgs(argv); } catch (e) { io.stderr.write(`${e.message}\n${USAGE}\n`); return 2; }
    try {
        const repoPath = io.env.REPO_PATH || process.cwd();
        const refs = args.manifest ? readManifest(args.manifest) : [];
        const loaded = refs.map(p => ({ id: p.id, as_is: comparator.loadRun(p.as_is, { repoPath }), fixed: comparator.loadRun(p.fixed, { repoPath }) }));
        const outDir = assertOutOutsideRuns(args.out, loaded.flatMap(p => [p.as_is, p.fixed]), { repoPath });
        const result = buildBenchmark({ pairs: loaded, expectedPairs: args.expected, source: args.manifest ? path.basename(args.manifest) : 'NO_MANIFEST' });
        fs.mkdirSync(outDir, { recursive: true });
        fs.writeFileSync(path.join(outDir, JSON_FILE), `${JSON.stringify(result, null, 2)}\n`);
        fs.writeFileSync(path.join(outDir, HTML_FILE), renderHtml(result));
        io.stdout.write(`benchmark gravado em ${args.out} (${result.pairs.valid} de ${result.pairs.received} pares válidos)\n`);
        return 0;
    } catch (e) {
        io.stderr.write(`${e.message}\n`);
        return 1;
    }
}

if (require.main === module) process.exitCode = main();

module.exports = { buildBenchmark, renderHtml, parseArgs, main, armCheck, assertOutOutsideRuns, canonicalPath, PHASES };
