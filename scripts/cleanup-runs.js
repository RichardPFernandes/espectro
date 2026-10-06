#!/usr/bin/env node
// Rotação de runs antigos: tira de memory/runs/ o que já não precisa estar no scan de
// inicialização do watcher (recoverOrphanedNodes e cia.) e move pra
// memory/archive/<YYYY-MM>/<task-id>/ do checkout principal. Nunca apaga run — só
// move. O que se apaga de verdade são screenshots velhos (browser*/ e screenshots/).
//
//   node scripts/cleanup-runs.js [--dry-run]
//
// Chamado também pelo watcher no startup, depois da recuperação de órfãos
// (DISABLE_AUTO_CLEANUP=true desliga). Idempotente: o que já foi movido não está mais
// em memory/runs/, e colisão de nome no destino ganha sufixo em vez de sobrescrever.
//
// Política (dias contados de updated_at → node_started_at → started_at do state.json):
//   committed, fully_merged, completed, cancelled  arquiva após RUNS_RETENTION_DAYS (30)
//   escalated, state_corrupted                     arquiva após RUNS_ERROR_RETENTION_DAYS (90)
//   qualquer outro status (running, needs_human_review, in_progress, blocked, ...)  nunca
//   screenshots (<run>/browser*/, <run>/screenshots/)  apaga após SCREENSHOTS_RETENTION_DAYS (14)
//                                                      — exceto em run running/needs_human_review
//
// Onde procura: memory/runs/ e memory/runs/_archive/ do checkout principal e de cada
// worktree em .claude/worktrees/ (os mesmos lugares do scan de órfãos). Pula:
//   - run versionado no git daquele checkout (os worktrees de ticket ainda carregam
//     cópias legadas de memory/runs; mover deixaria deleções pendentes que o /commit
//     poderia levar pro PR do ticket);
//   - run arquivado pelo dashboard (memory/runs/_archive/dashboard-archived.json) — o
//     botão "Restaurar" depende do caminho gravado lá;
//   - state.json ausente, ilegível ou sem data.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ARCHIVE_STATUSES = new Set(['committed', 'fully_merged', 'completed', 'cancelled']);
const ERROR_STATUSES = new Set(['escalated', 'state_corrupted']);
// Nunca arquivados (já cobertos por "qualquer outro status"), e nem os screenshots mexidos.
const PROTECTED_STATUSES = new Set(['running', 'needs_human_review']);
const SCREENSHOT_DIR_RE = /^(browser.*|screenshots)$/;
const DAY_MS = 24 * 60 * 60 * 1000;
const DASHBOARD_REGISTRY = 'dashboard-archived.json';

function envDays(env, key, fallback) {
    const raw = env[key];
    if (raw === undefined || raw === '') return fallback;
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0) {
        console.warn(`[cleanup] ${key}="${raw}" inválido — usando ${fallback}.`);
        return fallback;
    }
    return n;
}

function retentionFromEnv(env = process.env) {
    return {
        runsDays: envDays(env, 'RUNS_RETENTION_DAYS', 30),
        errorDays: envDays(env, 'RUNS_ERROR_RETENTION_DAYS', 90),
        screenshotsDays: envDays(env, 'SCREENSHOTS_RETENTION_DAYS', 14),
    };
}

// Dias de retenção pro status, ou null = nunca arquivar.
function retentionFor(status, retention) {
    if (ARCHIVE_STATUSES.has(status)) return retention.runsDays;
    if (ERROR_STATUSES.has(status)) return retention.errorDays;
    return null;
}

function referenceTime(state) {
    for (const key of ['updated_at', 'node_started_at', 'started_at']) {
        const t = Date.parse(state?.[key]);
        if (Number.isFinite(t)) return t;
    }
    return null;
}

// Checkouts com memory/runs: principal + worktrees de ticket.
function checkoutRoots(repoRoot) {
    const roots = [{ label: 'main', dir: repoRoot }];
    const worktreesDir = path.join(repoRoot, '.claude', 'worktrees');
    let entries = [];
    try { entries = fs.readdirSync(worktreesDir, { withFileTypes: true }); } catch { /* sem worktrees */ }
    for (const d of entries) {
        if (d.isDirectory()) roots.push({ label: `wt-${d.name}`, dir: path.join(worktreesDir, d.name) });
    }
    return roots.filter(r => fs.existsSync(path.join(r.dir, 'memory', 'runs')));
}

// Diretórios de primeiro nível em memory/runs e memory/runs/_archive versionados no git
// daquele checkout (Set de caminhos absolutos). null = não deu pra perguntar ao git —
// quem chama não mexe em nada desse checkout.
function trackedRunDirs(checkoutDir) {
    let out;
    try {
        out = execFileSync('git', ['-C', checkoutDir, 'ls-files', '-z', '--', 'memory/runs'], {
            encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024,
        });
    } catch {
        return null;
    }
    const dirs = new Set();
    for (const file of out.split('\0')) {
        const parts = file.split('/'); // memory/runs/<task>/... ou memory/runs/_archive/<task>/...
        if (parts.length < 4) continue;
        if (parts[2] === '_archive') {
            if (parts.length >= 5) dirs.add(path.join(checkoutDir, 'memory', 'runs', '_archive', parts[3]));
        } else {
            dirs.add(path.join(checkoutDir, 'memory', 'runs', parts[2]));
        }
    }
    return dirs;
}

function readDashboardRegistry(repoRoot) {
    try {
        return new Set(Object.keys(JSON.parse(fs.readFileSync(path.join(repoRoot, 'memory', 'runs', '_archive', DASHBOARD_REGISTRY), 'utf8'))));
    } catch {
        return new Set();
    }
}

function listRunDirs(runsDir) {
    let entries = [];
    try { entries = fs.readdirSync(runsDir, { withFileTypes: true }); } catch { return []; }
    return entries
        .filter(d => d.isDirectory() && !d.name.startsWith('_') && !d.name.startsWith('.'))
        .map(d => ({ taskId: d.name, dir: path.join(runsDir, d.name) }));
}

// Apaga arquivos com mtime anterior a cutoff dentro de dir (recursivo), e as subpastas
// que ficarem vazias. Symlink nunca é seguido nem apagado. Devolve quantos apagou.
function pruneOldFiles(dir, cutoff, dryRun) {
    let removed = 0;
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return 0; }
    for (const e of entries) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) {
            removed += pruneOldFiles(p, cutoff, dryRun);
            if (!dryRun) {
                try { if (!fs.readdirSync(p).length) fs.rmdirSync(p); } catch { /* segue */ }
            }
        } else if (e.isFile()) {
            let st;
            try { st = fs.lstatSync(p); } catch { continue; }
            if (st.mtimeMs >= cutoff) continue;
            if (!dryRun) {
                try { fs.unlinkSync(p); } catch (err) { console.warn(`[cleanup] não consegui remover ${p}: ${err.message}`); continue; }
            }
            removed++;
        }
    }
    return removed;
}

function pruneScreenshots(runDir, cutoff, dryRun) {
    let removed = 0;
    let entries = [];
    try { entries = fs.readdirSync(runDir, { withFileTypes: true }); } catch { return 0; }
    for (const e of entries) {
        if (e.isDirectory() && SCREENSHOT_DIR_RE.test(e.name)) removed += pruneOldFiles(path.join(runDir, e.name), cutoff, dryRun);
    }
    return removed;
}

// Destino livre em memory/archive/<YYYY-MM>/: <task-id>, ou <task-id>__<checkout>[-n]
// quando o mesmo task-id já foi arquivado (worktrees carregam cópias do mesmo run).
function archiveTarget(archiveRoot, month, taskId, rootLabel) {
    const base = path.join(archiveRoot, month);
    const candidates = [taskId, `${taskId}__${rootLabel}`];
    for (let n = 2; n < 100; n++) candidates.push(`${taskId}__${rootLabel}-${n}`);
    for (const name of candidates) {
        const p = path.join(base, name);
        if (!fs.existsSync(p)) return p;
    }
    return null;
}

// rename; entre filesystems (EXDEV), copia, confere e só então remove a origem. Falha
// no meio desfaz a cópia parcial — a origem fica intacta.
function moveDir(from, to) {
    fs.mkdirSync(path.dirname(to), { recursive: true });
    try {
        fs.renameSync(from, to);
        return;
    } catch (e) {
        if (e.code !== 'EXDEV') throw e;
    }
    try {
        fs.cpSync(from, to, { recursive: true, errorOnExist: true, force: false, preserveTimestamps: true, verbatimSymlinks: true });
        if (!fs.existsSync(path.join(to, 'state.json'))) throw new Error('cópia sem state.json');
    } catch (e) {
        fs.rmSync(to, { recursive: true, force: true });
        throw e;
    }
    fs.rmSync(from, { recursive: true, force: true });
}

// Opções: repoRoot (default REPO_PATH ou a raiz deste script), env, now, dryRun,
// filter(taskId) => bool, log. Devolve o sumário (também impresso).
function runCleanup(options = {}) {
    const env = options.env || process.env;
    const repoRoot = path.resolve(options.repoRoot || env.REPO_PATH || process.cwd());
    const now = options.now ?? Date.now();
    const dryRun = !!options.dryRun;
    const log = options.log || console.log;
    const retention = options.retention || retentionFromEnv(env);
    const archiveRoot = path.join(repoRoot, 'memory', 'archive');
    const dashboardArchived = readDashboardRegistry(repoRoot);
    const screenshotCutoff = now - retention.screenshotsDays * DAY_MS;
    const prefix = dryRun ? '[cleanup] [dry-run]' : '[cleanup]';

    const summary = { archived: [], screenshotsRemoved: 0, skippedTracked: 0, errors: [] };

    for (const root of checkoutRoots(repoRoot)) {
        const tracked = trackedRunDirs(root.dir);
        if (!tracked) {
            log(`${prefix} ${root.label}: git indisponível em ${root.dir} — checkout ignorado (não dá pra saber o que é versionado).`);
            continue;
        }
        const runsDir = path.join(root.dir, 'memory', 'runs');
        for (const base of [runsDir, path.join(runsDir, '_archive')]) {
            for (const run of listRunDirs(base)) {
                if (options.filter && !options.filter(run.taskId)) continue;
                if (tracked.has(run.dir)) { summary.skippedTracked++; continue; }
                let state;
                try { state = JSON.parse(fs.readFileSync(path.join(run.dir, 'state.json'), 'utf8')); } catch { continue; }
                if (!state || typeof state !== 'object') continue;
                const status = state.status;
                if (PROTECTED_STATUSES.has(status)) continue;

                summary.screenshotsRemoved += pruneScreenshots(run.dir, screenshotCutoff, dryRun);

                const days = retentionFor(status, retention);
                const ref = referenceTime(state);
                if (days === null || ref === null) continue;
                const ageDays = Math.floor((now - ref) / DAY_MS);
                if (now - ref < days * DAY_MS) continue;
                if (path.basename(base) === '_archive' && dashboardArchived.has(run.taskId)) continue;

                const month = new Date(ref).toISOString().slice(0, 7);
                const target = archiveTarget(archiveRoot, month, run.taskId, root.label);
                if (!target) { summary.errors.push(`${run.dir}: sem nome livre em ${month}`); continue; }
                try {
                    if (!dryRun) moveDir(run.dir, target);
                } catch (e) {
                    summary.errors.push(`${run.dir}: ${e.message}`);
                    log(`${prefix} Falha arquivando ${run.taskId} (${root.label}): ${e.message} — fica onde está.`);
                    continue;
                }
                summary.archived.push({ taskId: run.taskId, status, ageDays, from: path.relative(repoRoot, run.dir), to: path.relative(repoRoot, target) });
                log(`${prefix} Arquivado run ${run.taskId} (status: ${status}, age: ${ageDays}d) → ${path.relative(repoRoot, target)}`);
            }
        }
    }

    log(`${prefix} ${summary.archived.length} runs arquivados, ${summary.screenshotsRemoved} screenshots removidos`
        + (summary.skippedTracked ? ` (${summary.skippedTracked} runs versionados no git ignorados)` : '')
        + (summary.errors.length ? `, ${summary.errors.length} erro(s)` : '') + '.');
    return summary;
}

// Mesmo formato do loadDotEnv do watcher: nunca sobrescreve env var já setada.
function loadDotEnv(envPath) {
    let text;
    try { text = fs.readFileSync(envPath, 'utf8'); } catch { return; }
    for (const rawLine of text.split('\n')) {
        const line = rawLine.trim();
        if (!line || line.startsWith('#')) continue;
        const eq = line.indexOf('=');
        if (eq === -1) continue;
        const key = line.slice(0, eq).trim();
        let value = line.slice(eq + 1).trim();
        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
        if (!(key in process.env)) process.env[key] = value;
    }
}

if (require.main === module) {
    const argv = process.argv.slice(2);
    if (argv.includes('--help') || argv.includes('-h')) {
        console.log('uso: node scripts/cleanup-runs.js [--dry-run]');
        process.exit(0);
    }
    const unknown = argv.filter(a => a !== '--dry-run');
    if (unknown.length) {
        console.error(`argumento desconhecido: ${unknown[0]}\nuso: node scripts/cleanup-runs.js [--dry-run]`);
        process.exit(2);
    }
    loadDotEnv(path.join(process.env.REPO_PATH || process.cwd(), '.env'));
    try {
        const summary = runCleanup({ dryRun: argv.includes('--dry-run') });
        process.exitCode = summary.errors.length ? 1 : 0;
    } catch (e) {
        console.error('[cleanup] falha:', e.message);
        process.exitCode = 1;
    }
}

module.exports = {
    runCleanup, retentionFromEnv, retentionFor, referenceTime, trackedRunDirs, checkoutRoots,
    ARCHIVE_STATUSES, ERROR_STATUSES, PROTECTED_STATUSES,
};
