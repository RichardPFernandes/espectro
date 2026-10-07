#!/usr/bin/env node
// Retenção das transcrições por nó (memory/runs/<task>/transcripts/, gravadas pelo
// watcher via scripts/lib/transcript-writer.js). Script separado do cleanup-runs.js
// porque aqui se APAGA de verdade (transcrição é grande e sensível), lá só se move.
//
//   node scripts/cleanup-transcripts.js [--dry-run]
//
// Política:
//   ciclo bem-sucedido (status committed/fully_merged/completed)  apaga transcrições
//       com finishedAt (fallback: mtime) há mais de TRANSCRIPTS_RETENTION_DAYS (30)
//   ciclo com falha (escalated, cancelled, state_corrupted, failed, ...)  retém sempre
//   ciclo ainda em andamento (qualquer outro status)                         retém
//   sem state.json (ex: memory/runs/_transcripts-unattributed/, fetch_ticket que
//   travou antes de criar a task)                                            retém
//
// Onde procura: memory/runs/, memory/runs/_archive/ e memory/archive/<YYYY-MM>/ do
// checkout principal e de cada worktree em .claude/worktrees/. Pula arquivo versionado
// no git (mesma cautela do cleanup-runs.js). Depois de apagar, reescreve
// transcripts/index.json e state.json.transcripts/_total/_size_bytes.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const tw = require('./lib/transcript-writer');
const { checkoutRoots } = require('./cleanup-runs');

const SUCCESS_STATUSES = new Set(['committed', 'fully_merged', 'completed']);
const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_RETENTION_DAYS = 30;

function retentionDaysFromEnv(env = process.env) {
    const n = Number(env.TRANSCRIPTS_RETENTION_DAYS);
    return env.TRANSCRIPTS_RETENTION_DAYS && Number.isFinite(n) && n > 0 ? n : DEFAULT_RETENTION_DAYS;
}

function subdirs(dir) {
    try {
        return fs.readdirSync(dir, { withFileTypes: true }).filter(d => d.isDirectory() && !d.name.startsWith('.')).map(d => path.join(dir, d.name));
    } catch {
        return [];
    }
}

// Diretórios de task com transcripts/ debaixo de um checkout.
function taskDirsWithTranscripts(checkoutDir) {
    const runs = path.join(checkoutDir, 'memory', 'runs');
    const bases = [runs, path.join(runs, '_archive'), ...subdirs(path.join(checkoutDir, 'memory', 'archive'))];
    return bases.flatMap(subdirs).filter(d => fs.existsSync(path.join(d, tw.TRANSCRIPTS_DIR)));
}

// Arquivos versionados no git (caminhos absolutos). null = git indisponível.
function trackedFiles(checkoutDir) {
    try {
        const out = execFileSync('git', ['-C', checkoutDir, 'ls-files', '-z', '--', 'memory'], {
            encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024,
        });
        return new Set(out.split('\0').filter(Boolean).map(f => path.join(checkoutDir, f)));
    } catch {
        return null;
    }
}

function entryTime(taskDir, entry) {
    const t = Date.parse(entry.finishedAt);
    if (Number.isFinite(t)) return t;
    try { return fs.statSync(path.join(taskDir, entry.path)).mtimeMs; } catch { return null; }
}

// Opções: repoRoot, env, now, dryRun, log. Devolve o sumário.
function runTranscriptCleanup(options = {}) {
    const env = options.env || process.env;
    const repoRoot = path.resolve(options.repoRoot || env.REPO_PATH || process.cwd());
    const now = options.now ?? Date.now();
    const dryRun = !!options.dryRun;
    const log = options.log || console.log;
    const days = options.retentionDays ?? retentionDaysFromEnv(env);
    const cutoff = now - days * DAY_MS;
    const prefix = dryRun ? '[transcripts-cleanup] [dry-run]' : '[transcripts-cleanup]';
    const summary = { removed: [], bytesFreed: 0, keptFailedCycles: 0, errors: [] };

    for (const root of checkoutRoots(repoRoot)) {
        const tracked = trackedFiles(root.dir);
        if (!tracked) {
            log(`${prefix} ${root.label}: git indisponível em ${root.dir} — checkout ignorado.`);
            continue;
        }
        for (const taskDir of taskDirsWithTranscripts(root.dir)) {
            let state;
            try { state = JSON.parse(fs.readFileSync(path.join(taskDir, 'state.json'), 'utf8')); } catch { continue; }
            if (!SUCCESS_STATUSES.has(state?.status)) {
                if (['escalated', 'cancelled', 'state_corrupted', 'failed'].includes(state?.status)) summary.keptFailedCycles++;
                continue;
            }
            const index = tw.readIndex(taskDir);
            const keep = [];
            for (const entry of index) {
                const file = path.join(taskDir, entry.path || '');
                const t = entryTime(taskDir, entry);
                const safe = /^transcripts\/[A-Za-z0-9._-]+$/.test(entry.path || '');
                if (!safe || t === null || t >= cutoff || tracked.has(file)) { keep.push(entry); continue; }
                try {
                    if (!dryRun) fs.rmSync(file, { force: true });
                    summary.removed.push(path.relative(repoRoot, file));
                    summary.bytesFreed += entry.sizeBytes || 0;
                    log(`${prefix} Removida ${path.relative(repoRoot, file)} (ciclo ${state.status}, ${Math.floor((now - t) / DAY_MS)}d)`);
                } catch (e) {
                    keep.push(entry);
                    summary.errors.push(`${file}: ${e.message}`);
                }
            }
            if (keep.length === index.length || dryRun) continue;
            try {
                fs.writeFileSync(path.join(taskDir, tw.TRANSCRIPTS_DIR, tw.INDEX_FILE), JSON.stringify(keep, null, 2));
                tw.applyIndexToState(taskDir, keep);
            } catch (e) {
                summary.errors.push(`${taskDir}: falha atualizando índice/state.json: ${e.message}`);
            }
        }
    }
    log(`${prefix} ${summary.removed.length} transcrições removidas (${summary.bytesFreed} bytes)`
        + (summary.errors.length ? `, ${summary.errors.length} erro(s)` : '') + '.');
    return summary;
}

if (require.main === module) {
    const argv = process.argv.slice(2);
    const usage = 'uso: node scripts/cleanup-transcripts.js [--dry-run]';
    if (argv.includes('--help') || argv.includes('-h')) { console.log(usage); process.exit(0); }
    const unknown = argv.filter(a => a !== '--dry-run');
    if (unknown.length) { console.error(`argumento desconhecido: ${unknown[0]}\n${usage}`); process.exit(2); }
    try {
        const summary = runTranscriptCleanup({ dryRun: argv.includes('--dry-run') });
        process.exitCode = summary.errors.length ? 1 : 0;
    } catch (e) {
        console.error('[transcripts-cleanup] falha:', e.message);
        process.exitCode = 1;
    }
}

module.exports = { runTranscriptCleanup, retentionDaysFromEnv, SUCCESS_STATUSES };
