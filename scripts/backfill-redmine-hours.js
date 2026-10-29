#!/usr/bin/env node
// One-shot: reprocessa demandas Redmine M&O já cicladas e sincroniza horas
// (time entries) a partir do cost_tracking dos runs.
//
// NÃO altera o caminho hot do /commit — só lê memory/runs, memory/runs/_archive
// e memory/archive/<YYYY-MM>/ (rotação cleanup-runs) e (com --apply) cria time
// entries. O fluxo live (PRJ-54) deve reutilizar scripts/lib/redmine-hours-sync.js
// e o mesmo marcador [prisma-hours:<taskId>] para idempotência cruzada.
//
// Uso (no Mac worker, dados do consumidor app-back):
//
//   # Dry-run (padrão — não escreve no Redmine)
//   REPO_PATH=~/Workspace/app-back node scripts/backfill-redmine-hours.js
//
//   # Relatório JSON + filtro
//   REPO_PATH=~/Workspace/app-back node scripts/backfill-redmine-hours.js \
//     --ticket=43703 --report=/tmp/horas-dry.json
//
//   # Aplicar (depois de revisar o dry-run)
//   REPO_PATH=~/Workspace/app-back node scripts/backfill-redmine-hours.js --apply --limit=5
//
// Flags:
//   --dry-run              padrão; só simula (GET time_entries, sem POST)
//   --apply                grava time entries no Redmine
//   --ticket=<id>          pode repetir; filtra tickets
//   --since=YYYY-MM-DD     só runs com updated_at/started_at >= data
//   --limit=N              máximo de candidatos *com horas* a processar
//   --min-hours=0.5        piso após ceil duration_ms → degraus de 0,5 h
//   --activity-id=9        atividade Redmine (9 = Desenvolvimento no M&O)
//   --include-active       também varre memory/runs/ ativos
//                          (padrão: _archive + memory/archive/<YYYY-MM>/)
//   --fill-even-if-spent   cria mesmo se o ticket já tiver spent_hours > 0
//                          (ainda pula se o marcador [prisma-hours:task] existir)
//   --runs-dir=<path>      override de memory/runs (default: $REPO_PATH/memory/runs)
//   --report=<path>        grava JSON {summary,results}
//   --help
//
// Exit: 0 ok · 1 erro operacional · 2 uso incorreto.
//
// Riscos: ver docs do relatório Project (m-o-demanda-horas-backfill.md). Rate limit
// via scripts/lib/redmine-fetch.js (REDMINE_MIN_INTERVAL_MS / RETRY_*).

'use strict';

const fs = require('fs');
const path = require('path');
const { redmineFetch } = require('./lib/redmine-fetch');
const {
    runBackfill,
    DEFAULT_ACTIVITY_ID,
    DEFAULT_MIN_HOURS,
} = require('./lib/redmine-hours-sync');

function loadDotEnv(envPath) {
    if (!fs.existsSync(envPath)) return;
    for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
        const t = line.trim();
        if (!t || t.startsWith('#')) continue;
        const i = t.indexOf('=');
        if (i <= 0) continue;
        const key = t.slice(0, i).trim();
        let value = t.slice(i + 1).trim();
        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
            value = value.slice(1, -1);
        }
        if (!(key in process.env)) process.env[key] = value;
    }
}

function parseArgs(argv) {
    const out = {
        dryRun: true,
        tickets: [],
        includeActive: false,
        fillEvenIfSpent: false,
        activityId: DEFAULT_ACTIVITY_ID,
        minHours: DEFAULT_MIN_HOURS,
        limit: null,
        since: null,
        runsDir: null,
        report: null,
        help: false,
    };

    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        const eq = a.startsWith('--') && a.includes('=') ? a.indexOf('=') : -1;
        const flag = eq >= 0 ? a.slice(0, eq) : a;
        const inline = eq >= 0 ? a.slice(eq + 1) : null;
        const value = () => {
            if (inline != null) return inline;
            const v = argv[++i];
            if (v == null || v.startsWith('--')) throw new Error(`faltou valor para ${flag}`);
            return v;
        };

        switch (flag) {
            case '--help':
            case '-h':
                out.help = true;
                break;
            case '--dry-run':
                out.dryRun = true;
                break;
            case '--apply':
                out.dryRun = false;
                break;
            case '--ticket':
                out.tickets.push(Number(value()));
                break;
            case '--since':
                out.since = value();
                break;
            case '--limit':
                out.limit = Number(value());
                break;
            case '--min-hours':
                out.minHours = Number(value());
                break;
            case '--activity-id':
                out.activityId = Number(value());
                break;
            case '--include-active':
                out.includeActive = true;
                break;
            case '--fill-even-if-spent':
                out.fillEvenIfSpent = true;
                break;
            case '--runs-dir':
                out.runsDir = value();
                break;
            case '--report':
                out.report = value();
                break;
            default:
                throw new Error(`argumento desconhecido: ${a}`);
        }
    }

    if (out.tickets.some(n => !Number.isFinite(n) || n <= 0)) {
        throw new Error('--ticket exige id numérico positivo');
    }
    if (out.limit != null && (!Number.isFinite(out.limit) || out.limit < 1)) {
        throw new Error('--limit exige inteiro >= 1');
    }
    if (!Number.isFinite(out.minHours) || out.minHours < 0) {
        throw new Error('--min-hours inválido');
    }
    if (!Number.isFinite(out.activityId) || out.activityId < 1) {
        throw new Error('--activity-id inválido');
    }
    if (out.since) {
        const d = new Date(`${out.since}T00:00:00.000Z`);
        if (Number.isNaN(d.getTime())) throw new Error(`--since inválido: ${out.since}`);
        out.sinceDate = d;
    }
    return out;
}

const USAGE = `uso: node scripts/backfill-redmine-hours.js [--dry-run|--apply]
       [--ticket=ID]... [--since=YYYY-MM-DD] [--limit=N] [--min-hours=0.5]
       [--activity-id=9] [--include-active] [--fill-even-if-spent]
       [--runs-dir=path] [--report=path.json]

REPO_PATH aponta o consumidor (app-back). REDMINE_URL + REDMINE_API_KEY vêm do
.env do consumidor (ou do ambiente). Dry-run é o padrão.`;

async function main(argv) {
    let args;
    try {
        args = parseArgs(argv);
    } catch (e) {
        console.error(e.message);
        console.error(USAGE);
        return 2;
    }
    if (args.help) {
        console.log(USAGE);
        return 0;
    }

    const repoPath = process.env.REPO_PATH
        ? path.resolve(process.env.REPO_PATH)
        : path.resolve(__dirname, '..');
    loadDotEnv(path.join(repoPath, '.env'));

    const baseUrl = process.env.REDMINE_URL;
    const apiKey = process.env.REDMINE_API_KEY;
    if (!baseUrl || !apiKey) {
        console.error('REDMINE_URL e REDMINE_API_KEY são obrigatórios (env ou .env do REPO_PATH).');
        return 1;
    }

    const runsDir = path.resolve(args.runsDir || path.join(repoPath, 'memory', 'runs'));
    if (!fs.existsSync(runsDir)) {
        console.error(`runs-dir inexistente: ${runsDir}`);
        return 1;
    }

    console.error(`[backfill-redmine-hours] mode=${args.dryRun ? 'dry-run' : 'APPLY'} runsDir=${runsDir}`);

    const ticketIds = args.tickets.length ? new Set(args.tickets) : null;
    const { summary, results } = await runBackfill({
        runsDir,
        dryRun: args.dryRun,
        redmineFetch,
        baseUrl,
        apiKey,
        includeArchive: true,
        includeActive: args.includeActive,
        minHours: args.minHours,
        since: args.sinceDate || null,
        ticketIds,
        limit: args.limit,
        fillEvenIfSpent: args.fillEvenIfSpent,
        activityId: args.activityId,
        onProgress: r => {
            const tag = r.action || 'skip';
            const tid = r.ticketId != null ? `#${r.ticketId}` : '-';
            const hrs = r.hours != null ? `${r.hours}h` : '';
            const why = r.reason ? ` (${r.reason})` : '';
            console.error(`  [${tag}] ${r.taskId || '?'} ${tid} ${hrs}${why}`);
        },
    });

    const report = {
        generated_at: new Date().toISOString(),
        repo_path: repoPath,
        runs_dir: runsDir,
        summary,
        results,
    };

    if (args.report) {
        fs.mkdirSync(path.dirname(path.resolve(args.report)), { recursive: true });
        fs.writeFileSync(args.report, JSON.stringify(report, null, 2));
        console.error(`[backfill-redmine-hours] report → ${args.report}`);
    }

    console.log(JSON.stringify(summary, null, 2));
    return summary.errors > 0 ? 1 : 0;
}

if (require.main === module) {
    main(process.argv.slice(2))
        .then(code => process.exit(code))
        .catch(err => {
            console.error(`[backfill-redmine-hours] erro: ${err.stack || err.message}`);
            process.exit(1);
        });
}

module.exports = { parseArgs, main, USAGE };
