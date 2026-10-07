// Detecção de conflito de merge de PR para a aba "PRs" do dashboard.
//
// A API do Bitbucket Cloud não diz se um PR tem conflito: o recurso
// `pullrequest` não tem o campo, o diffstat do PR redireciona para um diff
// "topic" (three-dot, contra o merge-base — nunca tem status "merge conflict")
// e o diffstat com `merge=true` responde "CHANGE-3407 - Functionality has been
// deprecated" (verificado ao vivo em 2026-10-01). Então o conflito é calculado
// localmente: `git merge-tree --write-tree <destino> <origem>` faz o merge sem
// tocar no working tree/índice e sai com 1 quando há conflito.
//
// O resultado é função só do par de commits, então fica em cache por par. Se
// algum commit não existe no clone local, faz um `git fetch origin` (no máximo
// um a cada FETCH_MIN_INTERVAL_MS) e tenta de novo; se ainda assim não der,
// devolve null (desconhecido) — nunca true/false inventado.

const { execFile } = require('child_process');

const FETCH_MIN_INTERVAL_MS = 2 * 60 * 1000;
const GIT_TIMEOUT_MS = 30000;
const HASH_RE = /^[0-9a-f]{7,40}$/i;

function git(args, cwd) {
    return new Promise(resolve => {
        execFile('git', args, { cwd, encoding: 'utf8', timeout: GIT_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 },
            (err, stdout) => resolve({ code: err ? (typeof err.code === 'number' ? err.code : -1) : 0, stdout: stdout || '' }));
    });
}

function createConflictDetector({ repoRoot, remote = 'origin', fetchMinIntervalMs = FETCH_MIN_INTERVAL_MS } = {}) {
    const cache = new Map(); // "src..dst" -> { hasConflicts, conflictFiles }
    let lastFetchAt = 0;
    let fetchInFlight = null;

    async function hasCommit(hash) {
        return (await git(['cat-file', '-e', `${hash}^{commit}`], repoRoot)).code === 0;
    }

    async function fetchOnce() {
        if (fetchInFlight) return fetchInFlight;
        if (Date.now() - lastFetchAt < fetchMinIntervalMs) return;
        lastFetchAt = Date.now();
        fetchInFlight = git(['fetch', '--quiet', remote], repoRoot).finally(() => { fetchInFlight = null; });
        return fetchInFlight;
    }

    // { sourceCommit, targetCommit } -> { hasConflicts: true|false|null, conflictFiles: string[] }
    async function detect({ sourceCommit, targetCommit }) {
        const unknown = { hasConflicts: null, conflictFiles: [] };
        if (!HASH_RE.test(sourceCommit || '') || !HASH_RE.test(targetCommit || '')) return unknown;
        const key = `${sourceCommit}..${targetCommit}`;
        if (cache.has(key)) return cache.get(key);

        if (!(await hasCommit(sourceCommit)) || !(await hasCommit(targetCommit))) {
            await fetchOnce();
            if (!(await hasCommit(sourceCommit)) || !(await hasCommit(targetCommit))) return unknown;
        }

        // Saída com --name-only --no-messages: 1ª linha = tree OID, depois os
        // arquivos em conflito (um por linha). Exit 0 = limpo, 1 = conflito.
        const r = await git(['merge-tree', '--write-tree', '--name-only', '--no-messages', targetCommit, sourceCommit], repoRoot);
        if (r.code !== 0 && r.code !== 1) return unknown;
        const result = r.code === 1
            ? { hasConflicts: true, conflictFiles: [...new Set(r.stdout.split('\n').slice(1).map(s => s.trim()).filter(Boolean))] }
            : { hasConflicts: false, conflictFiles: [] };
        cache.set(key, result);
        return result;
    }

    return { detect };
}

module.exports = { createConflictDetector };
