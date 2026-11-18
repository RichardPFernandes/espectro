'use strict';
// Ponto de retorno do consumidor (F1.2, PRI-379): conferência da árvore do checkout.
// Árvore válida = sem sujeira (rastreado modificado ou não rastreado; ignorado não conta)
// e HEAD alcançável pela origin/main local. Só leitura: sem fetch, sem mexer em refs, sem
// lock opcional do índice. O git é injetável, no estilo de dashboard/version.js.
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const MAX_PATHS = 10;
const ORIGIN_MAIN = 'refs/remotes/origin/main';
const ON_VALUES = new Set(['1', 'true', 'sim']);
const TAG_PREFIX = 'verde/';
const LOG_FILE = path.join('logs', 'return-point.jsonl');

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

// Último verde: a tag verde/* mais recente. A data de criação desempata pelo nome, que
// carrega a hora UTC e é ordenável (no git, a última --sort é a chave primária).
function lastGreen({ root, git = runGit }) {
    const r = git(['for-each-ref', '--sort=-refname', '--sort=-creatordate', '--count=1', '--format=%(refname:strip=2)', `refs/tags/${TAG_PREFIX}`], { cwd: root });
    if (r.status !== 0) return null;
    return r.stdout.trim() || null;
}

const pad = n => String(n).padStart(2, '0');
function tagName(d) {
    return `${TAG_PREFIX}${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}-${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`;
}

// Roda a checagem de saúde; se passar, cria a tag anotada no HEAD com o resultado.
// Passando ou não, acrescenta uma linha no log da raiz. Só SHA, tag, hora, itens e
// resultado: nada de caminho. Tag existente é erro (nunca -f); nada é publicado.
async function mark({ root, health, now = () => new Date(), git = runGit }) {
    const run = args => git(args, { cwd: root });
    const headR = run(['rev-parse', '--verify', '--quiet', 'HEAD^{commit}']);
    const head = headR.status === 0 ? headR.stdout.trim() : '';
    if (!head) throw new Error('mark: HEAD não resolvido');
    const date = now();
    const name = tagName(date);
    if (run(['rev-parse', '--verify', '--quiet', `refs/tags/${name}`]).status === 0) {
        throw new Error(`mark: a tag ${name} já existe`);
    }

    const result = await health();
    const ok = result?.ok === true;
    const items = Array.isArray(result?.items) ? result.items : [];
    const record = { at: date.toISOString(), head, ok, items };

    let tag = null;
    if (ok) {
        const t = run(['tag', '-a', '--cleanup=verbatim', '-m', JSON.stringify(record), name, head]);
        if (t.status !== 0) throw new Error(`mark: não criou a tag ${name}: ${t.stderr.trim()}`);
        tag = name;
    }

    const logPath = path.join(root, LOG_FILE);
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.appendFileSync(logPath, JSON.stringify({ at: record.at, head, tag, ok, items }) + '\n');
    return { ok, tag, head, items };
}

module.exports = { checkTree, guardEnabled, runGit, lastGreen, mark, MAX_PATHS };
