'use strict';
// Ponto de retorno do consumidor (F1.2, PRI-379): conferência da árvore do checkout.
// Árvore válida = sem sujeira (rastreado modificado ou não rastreado; ignorado não conta)
// e HEAD alcançável pela origin/main local. Só leitura: sem fetch, sem mexer em refs, sem
// lock opcional do índice. O git é injetável, no estilo de dashboard/version.js.
const { spawnSync } = require('node:child_process');

const MAX_PATHS = 10;
const ORIGIN_MAIN = 'refs/remotes/origin/main';
const ON_VALUES = new Set(['1', 'true', 'sim']);

// Roda `git <args>` em cwd, sem shell. Falha ao iniciar (git ausente) vira status null.
function runGit(args, { cwd, env = process.env, timeout = 15000 } = {}) {
    const r = spawnSync('git', args, { cwd, env, timeout, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
    return { status: r.error ? null : r.status, stdout: r.stdout || '', stderr: r.stderr || (r.error ? r.error.message : '') };
}

// `status --porcelain -z`: "XY caminho\0"; renomeado/copiado traz a origem como entrada extra.
function dirtyPaths(stdout) {
    const entries = stdout.split('\0');
    const paths = [];
    for (let i = 0; i < entries.length; i++) {
        const e = entries[i];
        if (!e) continue;
        paths.push(e.slice(3));
        if (e[0] === 'R' || e[0] === 'C') i++;
    }
    return paths;
}

function checkTree({ root, git = runGit }) {
    const run = args => git(args, { cwd: root });
    if (run(['rev-parse', '--is-inside-work-tree']).status !== 0) {
        return { ok: false, reasons: ['not_git'], paths: [], head: null };
    }
    const headR = run(['rev-parse', '--verify', '--quiet', 'HEAD^{commit}']);
    const head = headR.status === 0 ? headR.stdout.trim() || null : null;
    const reasons = [];

    const status = run(['--no-optional-locks', 'status', '--porcelain', '-z', '--untracked-files=normal']);
    const all = status.status === 0 ? dirtyPaths(status.stdout) : [];
    if (status.status !== 0 || all.length) reasons.push('dirty');

    if (run(['rev-parse', '--verify', '--quiet', `${ORIGIN_MAIN}^{commit}`]).status !== 0) {
        reasons.push('no_origin_main');
    } else if (!head || run(['merge-base', '--is-ancestor', head, ORIGIN_MAIN]).status !== 0) {
        reasons.push('off_main');
    }

    return { ok: reasons.length === 0, reasons, paths: all.slice(0, MAX_PATHS), head };
}

// PRISMA_CHECKOUT_GUARD: 1, true ou sim (sem diferenciar maiúsculas) liga; o resto desliga.
function guardEnabled(env = process.env) {
    return ON_VALUES.has(String(env.PRISMA_CHECKOUT_GUARD ?? '').trim().toLowerCase());
}

module.exports = { checkTree, guardEnabled, runGit, MAX_PATHS };
