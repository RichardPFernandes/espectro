#!/usr/bin/env node
// Hot path: propaga horas (time entry) de UM run no ticket Redmine, a partir
// do cost_tracking. Reutiliza scripts/lib/redmine-hours-sync.js e o marcador
// [prisma-hours:<taskId>] — idempotente com o backfill one-shot.
//
// Chamado pelo /commit (passo após "Apontamentos Desenvolvedor"). Não altera
// o backfill. Soft-fail: NÃO passa pelo Attempt DOM06 do commit (sem
// redmineEffect / obrigação redmine_hours) — POST direto via a lib. Falha de
// sync NÃO derruba o archive nem revoga o Attempt: exit 0 em skip; exit 1
// só em erro operacional duro (o /commit avisa e segue).
//
// Uso:
//   node scripts/sync-redmine-hours-live.js memory/runs/<task-id> --apply
//   node scripts/sync-redmine-hours-live.js memory/runs/<task-id>   # dry-run
//
// Env: REDMINE_URL, REDMINE_API_KEY (carrega .env do REPO_PATH ou cwd).
// Flags: --apply | --dry-run · --activity-id=9 · --min-hours=0.01
//        --no-fill-if-spent · --help
// Compat: --attempt=<file> é aceito e IGNORADO (aviso em stderr).

'use strict';

const fs = require('fs');
const path = require('path');
const { redmineFetch } = require('./lib/redmine-fetch');
const {
    syncRunHoursLive,
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
        attempt: null,
        activityId: DEFAULT_ACTIVITY_ID,
        minHours: DEFAULT_MIN_HOURS,
        fillEvenIfSpent: true,
        help: false,
        runDir: null,
    };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--help' || a === '-h') out.help = true;
        else if (a === '--apply') out.dryRun = false;
        else if (a === '--dry-run') out.dryRun = true;
        else if (a === '--no-fill-if-spent') out.fillEvenIfSpent = false;
        else if (a.startsWith('--attempt=')) out.attempt = a.slice('--attempt='.length);
        else if (a === '--attempt') {
            const next = argv[++i];
            if (!next || next.startsWith('-')) {
                console.error('--attempt exige caminho do arquivo');
                process.exit(2);
            }
            out.attempt = next;
        } else if (a.startsWith('--activity-id=')) {
            out.activityId = Number(a.slice('--activity-id='.length));
        } else if (a.startsWith('--min-hours=')) {
            out.minHours = Number(a.slice('--min-hours='.length));
        } else if (!a.startsWith('-') && !out.runDir) {
            out.runDir = a;
        } else {
            console.error(`flag desconhecida: ${a}`);
            process.exit(2);
        }
    }
    return out;
}

const USAGE = `uso: node scripts/sync-redmine-hours-live.js <runDir> [--dry-run|--apply]
  --activity-id=9      atividade Redmine (Desenvolvimento no M&O)
  --min-hours=0.01     piso após arredondar duration_ms → horas
  --no-fill-if-spent   pula se o ticket já tiver qualquer spent (padrão: cria)
  --attempt=<file>     ignorado (compat; horas não entram no Attempt do commit)
  --help`;

async function main() {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) {
        console.log(USAGE);
        process.exit(0);
    }
    if (!args.runDir) {
        console.error(USAGE);
        process.exit(2);
    }

    const repoPath = process.env.REPO_PATH || process.cwd();
    loadDotEnv(path.join(repoPath, '.env'));
    loadDotEnv(path.join(process.cwd(), '.env'));

    const baseUrl = (process.env.REDMINE_URL || '').replace(/\/+$/, '');
    const apiKey = process.env.REDMINE_API_KEY || '';
    if (!baseUrl || !apiKey) {
        console.error('[sync-redmine-hours-live] REDMINE_URL/REDMINE_API_KEY ausentes — skip');
        process.stdout.write(`${JSON.stringify({ ok: true, action: 'skip', reason: 'redmine_unconfigured' })}\n`);
        process.exit(0);
    }

    if (args.attempt) {
        console.error(
            '[sync-redmine-hours-live] --attempt ignorado: horas são soft-fail e '
            + 'não usam redmineEffect / Attempt do commit',
        );
    }

    const result = await syncRunHoursLive(args.runDir, {
        dryRun: args.dryRun,
        redmineFetch,
        baseUrl,
        apiKey,
        fillEvenIfSpent: args.fillEvenIfSpent,
        activityId: args.activityId,
        minHours: args.minHours,
    });

    process.stdout.write(`${JSON.stringify(result)}\n`);

    if (result.action === 'error') process.exit(1);
    process.exit(0);
}

main().catch(err => {
    console.error(`[sync-redmine-hours-live] erro: ${err.stack || err.message}`);
    process.exit(1);
});
