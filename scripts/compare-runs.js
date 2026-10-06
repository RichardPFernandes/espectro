#!/usr/bin/env node
// Compara dois runs da mesma task lado a lado (ver scripts/lib/run-comparator.js).
//
//   node scripts/compare-runs.js <run-A> <run-B> [--format text|json] [--output <arquivo>]
//
//   <run>      task-id (procurado em memory/runs, _archive, worktrees e memory/archive)
//              ou <task-id>/state-replay-<id>.json pro registro de um replay
//   --format   text (padrão): tabelas no terminal, com cor quando é TTY
//              json: objeto com metrics, stateDiff, tokenDiff, nodeDiff,
//              testResultsDiff, planScoreDiff, verdict e summary
//   --output   grava a saída no arquivo (sem cor) em vez da stdout
//
// Só leitura: nenhum arquivo de run é escrito. NO_COLOR desliga a cor; FORCE_COLOR liga.
// Saída: 0 ok · 1 run não encontrado ou erro · 2 uso incorreto.
const fs = require('fs');
const path = require('path');
const comparator = require('./lib/run-comparator');

const { NA } = comparator;
const USAGE = 'uso: node scripts/compare-runs.js <run-A> <run-B> [--format text|json] [--output <arquivo>]\n' +
    '     <run>: <task-id> ou <task-id>/state-replay-<id>.json';

function parseArgs(argv) {
    const out = { format: 'text', runs: [] };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        const [flag, inline] = a.startsWith('--') && a.includes('=') ? [a.slice(0, a.indexOf('=')), a.slice(a.indexOf('=') + 1)] : [a, null];
        const value = () => {
            const v = inline ?? argv[++i];
            if (v === undefined) throw new Error(`${flag} precisa de um valor`);
            return v;
        };
        if (flag === '--format') out.format = value();
        else if (flag === '--output' || flag === '-o') out.output = value();
        else if (flag === '--help' || flag === '-h') out.help = true;
        else if (a.startsWith('-')) throw new Error(`argumento desconhecido: ${a}`);
        else out.runs.push(a);
    }
    if (!['text', 'json'].includes(out.format)) throw new Error(`--format inválido: "${out.format}" (use text ou json)`);
    return out;
}

// ---------------------------------------------------------------------------------
// Texto

function makeColors(enabled) {
    const wrap = code => s => (enabled ? `\x1b[${code}m${s}\x1b[0m` : String(s));
    return { red: wrap('31'), green: wrap('32'), yellow: wrap('33'), bold: wrap('1'), dim: wrap('2') };
}

const visibleLength = s => String(s).replace(/\x1b\[[0-9;]*m/g, '').length;
const pad = (s, n) => String(s) + ' '.repeat(Math.max(0, n - visibleLength(s)));

function table(headers, rows) {
    const widths = headers.map((h, i) => Math.max(visibleLength(h), ...rows.map(r => visibleLength(r[i]))));
    const line = cells => `  ${cells.map((c, i) => pad(c, widths[i])).join(' │ ')}`;
    const sep = `  ${widths.map(w => '─'.repeat(w)).join('─┼─')}`;
    return [line(headers), sep, ...rows.map(line)].join('\n');
}

const intFmt = n => (typeof n === 'number' ? Math.round(n).toLocaleString('pt-BR') : String(n));

function fmtValue(v, format) {
    if (v === NA || v === null || v === undefined) return NA;
    if (format === 'int') return intFmt(v);
    if (format === 'usd') return `$${Number(v).toFixed(2)}`;
    if (format === 'ms') {
        const s = Math.round(v / 1000);
        return s >= 60 ? `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s` : `${s}s`;
    }
    return typeof v === 'string' ? v : JSON.stringify(v);
}

function fmtDelta(row, c) {
    if (typeof row.delta !== 'number') {
        const text = row.delta === '=' ? '=' : String(row.delta);
        return row.significant ? c.yellow(text) : c.dim(text);
    }
    const sign = row.delta > 0 ? '+' : '';
    const abs = fmtValue(Math.abs(row.delta), row.format);
    const base = row.delta === 0 ? '=' : `${sign}${row.delta < 0 ? '-' : ''}${abs}`;
    const text = row.deltaPct !== NA && row.delta !== 0 ? `${base} (${row.deltaPct > 0 ? '+' : ''}${row.deltaPct}%)` : base;
    if (!row.significant) return text;
    return row.better === 'B' ? c.green(text) : row.better === 'A' ? c.red(text) : c.yellow(text);
}

function truncate(s, n = 48) {
    const str = String(s);
    return str.length > n ? `${str.slice(0, n - 1)}…` : str;
}

function renderText(result, { color }) {
    const c = makeColors(color);
    const out = [];
    const runLine = (label, r) => `${c.bold(`Run ${label}`)}: ${r.ref}${r.source ? c.dim(` [${r.source}]`) : ''}` +
        `${r.replayOf ? c.dim(` (replay de ${r.replayOf})`) : ''}${r.readError ? ` ${c.red(`⚠ ${r.readError}`)}` : ''}`;
    out.push(runLine('A', result.runA), runLine('B', result.runB), '');

    out.push(c.bold('Resumo'));
    out.push(table(['Métrica', 'Run A', 'Run B', 'Delta'], result.metrics.map(m => {
        const color = m.significant && (m.key === 'status' || m.key === 'test_result')
            ? (m.better === 'B' ? c.green : m.better === 'A' ? c.red : c.yellow) : s => s;
        return [m.label, color(fmtValue(m.a, m.format)), color(fmtValue(m.b, m.format)), fmtDelta(m, c)];
    })));
    out.push('');

    const t = result.tokenDiff;
    out.push(c.bold('Tokens por nó'));
    if (!t.nodes.length) out.push(c.dim(`  ${NA} — nenhum dos runs tem cost_tracking`));
    else {
        out.push(table(['Nó', 'Run A', 'Run B', 'Delta'], [...t.nodes, { node: 'total', ...t.total }].map(r => {
            const row = { ...r, format: 'int', better: typeof r.delta === 'number' && r.delta !== 0 ? (r.delta < 0 ? 'B' : 'A') : null };
            return [r.node === 'total' ? c.bold('total') : r.node, fmtValue(r.a, 'int'), fmtValue(r.b, 'int'), fmtDelta(row, c)];
        })));
    }
    out.push('');

    const n = result.nodeDiff;
    out.push(c.bold('Nós executados'));
    out.push(`  só em A: ${n.onlyInA.length ? c.yellow(n.onlyInA.join(', ')) : c.dim('(nenhum)')}`);
    out.push(`  só em B: ${n.onlyInB.length ? c.yellow(n.onlyInB.join(', ')) : c.dim('(nenhum)')}`);
    const loops = n.both.filter(x => n.executions[x].a !== n.executions[x].b);
    if (loops.length) out.push(`  execuções diferentes: ${loops.map(x => `${x} ${n.executions[x].a}→${n.executions[x].b}`).join(', ')}`);
    out.push('');

    const tr = result.testResultsDiff;
    out.push(c.bold('Testes'));
    const testMark = x => (x.outcome === 'passed' ? c.green(x.summary) : x.outcome === 'failed' ? c.red(x.summary) : c.dim(x.summary));
    out.push(`  A: ${testMark(tr.a)}`);
    out.push(`  B: ${testMark(tr.b)}`);
    if (tr.direction) out.push(`  ${tr.direction === 'fixed' ? c.green('passou em B, falhou em A') : c.red('passou em A, falhou em B')}`);
    out.push('');

    const p = result.planScoreDiff;
    if (p !== NA) {
        out.push(c.bold('Plan score'));
        out.push(`  A: ${p.a} (limiar ${p.thresholdA}, tentativas ${p.attemptsA})  B: ${p.b} (limiar ${p.thresholdB}, tentativas ${p.attemptsB})  delta: ${p.delta}`);
        out.push('');
    }

    out.push(c.bold(`Campos do state.json que mudaram (${result.stateDiff.length})`) + c.dim(` — fora: ${result.stateDiffIgnored.join(', ')}`));
    if (result.stateDiff.length) {
        out.push(table(['Campo', 'Run A', 'Run B'], result.stateDiff.map(d => [
            d.key,
            d.a === NA ? c.dim(NA) : truncate(fmtValue(d.a)),
            d.b === NA ? c.dim(NA) : truncate(fmtValue(d.b)),
        ])));
    } else out.push(c.dim('  (nenhum)'));
    out.push('');

    const vcolor = result.verdict === 'B-better' ? c.green : result.verdict === 'A-better' ? c.red : c.yellow;
    out.push(`${c.bold('verdict:')} ${vcolor(result.verdict)} ${c.dim(`(${result.verdictReason})`)}`);
    out.push(c.bold(result.summary));
    return `${out.join('\n')}\n`;
}

// ---------------------------------------------------------------------------------

// --output nunca pode cair dentro de um run comparado (restrição: comparação é read-only).
function assertOutputOutsideRuns(output, runs) {
    const target = path.resolve(output);
    for (const r of runs) {
        const dir = path.resolve(r.dir);
        if (target === dir || target.startsWith(dir + path.sep)) {
            throw new Error(`--output dentro do diretório do run ${r.ref} (${dir}) — escolha outro caminho; a comparação não escreve em runs`);
        }
    }
}

function main(argv = process.argv.slice(2), io = { stdout: process.stdout, stderr: process.stderr, env: process.env }) {
    let args;
    try {
        args = parseArgs(argv);
    } catch (e) {
        io.stderr.write(`${e.message}\n${USAGE}\n`);
        return 2;
    }
    if (args.help) { io.stdout.write(`${USAGE}\n`); return 0; }
    if (args.runs.length !== 2) { io.stderr.write(`${USAGE}\n`); return 2; }

    try {
        const [runA, runB] = args.runs.map(ref => comparator.loadRun(ref));
        if (args.output) assertOutputOutsideRuns(args.output, [runA, runB]);
        const result = comparator.compareRuns(runA, runB);
        const color = !args.output && !io.env.NO_COLOR && (Boolean(io.env.FORCE_COLOR) || Boolean(io.stdout.isTTY));
        const text = args.format === 'json' ? `${JSON.stringify(result, null, 2)}\n` : renderText(result, { color });
        if (args.output) {
            fs.writeFileSync(args.output, text);
            io.stderr.write(`comparação gravada em ${args.output}\n`);
        } else {
            io.stdout.write(text);
        }
        return 0;
    } catch (e) {
        io.stderr.write(`${e.message}\n`);
        return 1;
    }
}

if (require.main === module) process.exitCode = main();

module.exports = { main, parseArgs, renderText };
