#!/usr/bin/env node
// Valida .claude/, .graph/ e .env.example contra .claude/config-contract.json.
// Regras em scripts/lib/config-validator.js.
//
//   node scripts/validate-config.js [--fix] [--severity error|warning|all] [--format text|json] [--config <contrato>]
//
// --severity filtra o que é MOSTRADO (error = só erros; warning = erros + avisos;
// all = tudo, inclusive info e regras que passaram — padrão). O exit code não muda
// com o filtro: 1 se houver qualquer erro, 0 caso contrário, 2 se o próprio
// validador não rodou (contrato ausente/ilegível, argumento inválido).
//
// --fix só faz limpeza de worktree (ciclo encerrado ou órfão) — nunca edita arquivo de
// configuração. Worktree com mudança rastreada não commitada fica. Depois do fix a
// validação roda de novo e o relatório/exit code refletem o estado final.
//
// Saída sem cor ANSI (CI-friendly); --format json imprime só o JSON do relatório.
const path = require('path');
const { validateAll, applyFixes, DEFAULT_CONFIG_PATH } = require('./lib/config-validator');

const ICON = { error: '❌', warning: '⚠️ ', info: 'ℹ️ ', passed: '✅' };
const SHOW = { error: ['error'], warning: ['error', 'warning'], all: ['error', 'warning', 'info'] };
const MAX_DETAILS = 20;

function parseArgs(argv) {
    const args = { fix: false, severity: 'all', format: 'text', config: DEFAULT_CONFIG_PATH };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        const [flag, inline] = a.includes('=') ? a.split(/=(.*)/s) : [a, undefined];
        const value = () => (inline !== undefined ? inline : argv[++i]);
        if (flag === '--fix') args.fix = true;
        else if (flag === '--severity') args.severity = value();
        else if (flag === '--format') args.format = value();
        else if (flag === '--config') args.config = path.resolve(value());
        else if (flag === '--help' || flag === '-h') args.help = true;
        else throw new Error(`argumento desconhecido: ${a}`);
    }
    if (!SHOW[args.severity]) throw new Error(`--severity inválido: ${args.severity} (use error, warning ou all)`);
    if (!['text', 'json'].includes(args.format)) throw new Error(`--format inválido: ${args.format} (use text ou json)`);
    return args;
}

function renderText(report, severity, fix) {
    const lines = [];
    const shown = SHOW[severity];
    lines.push(`Validação de configuração (contrato v${report.contractVersion})`);
    lines.push('');
    const failed = report.results.filter(r => !r.passed && shown.includes(r.severity));
    const order = { error: 0, warning: 1, info: 2 };
    failed.sort((a, b) => order[a.severity] - order[b.severity]);
    for (const r of failed) {
        lines.push(`${ICON[r.severity]} [${r.rule}] ${r.message}`);
        const details = r.details || [];
        for (const d of details.slice(0, MAX_DETAILS)) lines.push(`     - ${d}`);
        if (details.length > MAX_DETAILS) lines.push(`     … e mais ${details.length - MAX_DETAILS}`);
    }
    if (severity === 'all') {
        for (const r of report.results.filter(x => x.passed)) lines.push(`${ICON.passed} [${r.rule}] ${r.message}`);
    }
    if (fix) {
        lines.push('');
        lines.push(fix.removed.length ? `🧹 Worktrees removidos (${fix.removed.length}):` : '🧹 --fix: nenhum worktree removido.');
        for (const p of fix.removed) lines.push(`     - ${path.relative(report.root, p) || p}`);
        for (const k of fix.kept) lines.push(`     ↳ mantido ${path.relative(report.root, k.path)}: ${k.reason}`);
        for (const e of fix.errors) lines.push(`     ✗ ${e.path ? path.relative(report.root, e.path) : '(ticket)'}: ${e.error}`);
        if (fix.rescuedRuns.length) lines.push(`     runs preservados em memory/runs/_archive/: ${fix.rescuedRuns.map(p => path.basename(p)).join(', ')}`);
    }
    const s = report.summary;
    lines.push('');
    lines.push(`${report.valid ? ICON.passed : ICON.error} ${report.message}`);
    lines.push(`   ${s.errors} erro(s) · ${s.warnings} aviso(s) · ${s.info} info · ${s.rules} regra(s)`);
    return lines.join('\n');
}

async function main(argv = process.argv.slice(2)) {
    let args;
    try { args = parseArgs(argv); } catch (e) { console.error(e.message); return 2; }
    if (args.help) {
        console.log('uso: node scripts/validate-config.js [--fix] [--severity error|warning|all] [--format text|json] [--config <contrato>]');
        return 0;
    }
    let report;
    let fix = null;
    try {
        report = validateAll(args.config);
        if (args.fix) {
            const quiet = { log() {}, warn() {}, error() {} };
            fix = await applyFixes(report, { configPath: args.config, log: args.format === 'json' ? quiet : console });
            report = validateAll(args.config);
        }
    } catch (e) {
        if (args.format === 'json') console.log(JSON.stringify({ valid: false, error: e.message }));
        else console.error(`❌ validação não rodou: ${e.message}`);
        return 2;
    }
    const exitCode = report.valid ? 0 : 1;
    if (args.format === 'json') {
        const shown = SHOW[args.severity];
        const out = { ...report, exitCode, results: report.results.filter(r => r.passed ? args.severity === 'all' : shown.includes(r.severity)) };
        if (fix) out.fix = fix;
        console.log(JSON.stringify(out, null, 2));
    } else {
        console.log(renderText(report, args.severity, fix));
    }
    return exitCode;
}

module.exports = { parseArgs, renderText, main };

if (require.main === module) {
    main().then(code => { process.exitCode = code; });
}
