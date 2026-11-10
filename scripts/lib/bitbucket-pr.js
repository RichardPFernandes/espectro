// Cliente Bitbucket Cloud para a aba "PRs" do dashboard (dashboard/server.js).
// Mesmo request testado e validado ao vivo que scripts/check-pr-status.js e
// scripts/bitbucket-open-pr.sh já usam: Authorization: Bearer com o API token
// da Atlassian (Basic Auth com esse tipo de token pode dar 401/403 dependendo
// do endpoint).
//
// Input de cada função: { workspace, repo, token, ... } (+ apiBase/timeoutMs
// opcionais, pra teste). Nunca loga o token nem o coloca em mensagem de erro.
//
// hasConflicts: a API do Bitbucket Cloud não expõe conflito de merge (nem no
// recurso `pullrequest`, nem no diffstat — o do PR é "topic"/three-dot e o
// `merge=true` foi deprecado, CHANGE-3407). Este módulo devolve sempre
// `hasConflicts: null` e expõe os commits de origem/destino; quem calcula o
// conflito de verdade é scripts/lib/pr-conflicts.js (git merge-tree local),
// chamado pelo dashboard/server.js.

const DEFAULT_API_BASE = 'https://api.bitbucket.org/2.0';
const DEFAULT_TIMEOUT_MS = 15000;

function prUrl(apiBase, workspace, repo, prId) {
    return `${apiBase}/repositories/${encodeURIComponent(workspace)}/${encodeURIComponent(repo)}/pullrequests/${encodeURIComponent(prId)}`;
}

async function bitbucketJson(url, token, timeoutMs, init = {}) {
    const res = await fetch(url, {
        ...init,
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', ...(init.body ? { 'Content-Type': 'application/json' } : {}) },
        signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
        const err = new Error(`Bitbucket API: ${res.status}`);
        err.status = res.status;
        throw err;
    }
    if (res.status === 204) return null;
    return res.json();
}

// participants: todo mundo que interagiu (reviewer ou não), com approved/state.
// reviewers: só quem foi designado reviewer. Junta os dois pra saber, por
// reviewer designado, se já aprovou.
function normalizeReviewers(raw) {
    const participants = Array.isArray(raw.participants) ? raw.participants : [];
    const byAccountId = new Map(participants.map(p => [p.user?.account_id, p]));
    const reviewers = Array.isArray(raw.reviewers) ? raw.reviewers : [];
    return reviewers.map(r => {
        const p = byAccountId.get(r.account_id);
        return {
            accountId: r.account_id || null,
            uuid: r.uuid || null,
            displayName: r.display_name || r.nickname || 'Reviewer',
            approved: p?.approved === true,
            // "Pedir mudanças" no Bitbucket: participant.state === 'changes_requested'.
            changesRequested: p?.state === 'changes_requested',
        };
    });
}

function normalizePR(raw, repo = null) {
    return {
        id: raw.id,
        repo,
        title: raw.title,
        sourceBranch: raw.source?.branch?.name || null,
        targetBranch: raw.destination?.branch?.name || null,
        sourceCommit: raw.source?.commit?.hash || null,
        targetCommit: raw.destination?.commit?.hash || null,
        state: raw.state,
        draft: raw.draft === true,
        author: raw.author?.display_name || raw.author?.nickname || null,
        authorAccountId: raw.author?.account_id || null,
        reviewers: normalizeReviewers(raw),
        createdOn: raw.created_on || null,
        updatedOn: raw.updated_on || null,
        url: raw.links?.html?.href || null,
        // Ver comentário no topo do arquivo: preenchido por pr-conflicts.js.
        hasConflicts: null,
        commentCount: typeof raw.comment_count === 'number' ? raw.comment_count : null,
        taskCount: typeof raw.task_count === 'number' ? raw.task_count : null,
    };
}

// GET /2.0/user — identidade dona do token (pra decidir, no servidor, se o
// dono do token é reviewer de um PR e ainda não aprovou => pode aprovar).
async function getCurrentUser({ token, apiBase = DEFAULT_API_BASE, timeoutMs = DEFAULT_TIMEOUT_MS }) {
    const data = await bitbucketJson(`${apiBase}/user`, token, timeoutMs);
    return { accountId: data.account_id || null, uuid: data.uuid || null, displayName: data.display_name || data.nickname || null };
}

// GET /2.0/repositories/{workspace}/{repo}/pullrequests?state=&pagelen=
// Com authorAccountId, filtra por autor via `q`. Com `q` presente o Bitbucket
// ignora o parâmetro `state` (verificado ao vivo em 2026-10-01), então o state
// vai dentro do `q` também.
const ACCOUNT_ID_RE = /^[\w:-]+$/;
async function listPRs({ workspace, repo, token, state = 'OPEN', limit = 50, authorAccountId = null, apiBase = DEFAULT_API_BASE, timeoutMs = DEFAULT_TIMEOUT_MS }) {
    let query = `?state=${encodeURIComponent(state)}`;
    if (authorAccountId) {
        if (!ACCOUNT_ID_RE.test(authorAccountId)) throw new Error('authorAccountId inválido');
        query = `?q=${encodeURIComponent(`author.account_id="${authorAccountId}" AND state="${state}"`)}`;
    }
    const url = `${apiBase}/repositories/${encodeURIComponent(workspace)}/${encodeURIComponent(repo)}/pullrequests`
        + `${query}&pagelen=${encodeURIComponent(limit)}`;
    const data = await bitbucketJson(url, token, timeoutMs);
    return (data.values || []).map(raw => normalizePR(raw, repo));
}

// GET /2.0/repositories/{workspace}/{repo}/pullrequests/{id} — só o PR, sem diffstat.
async function getPR({ workspace, repo, prId, token, apiBase = DEFAULT_API_BASE, timeoutMs = DEFAULT_TIMEOUT_MS }) {
    return normalizePR(await bitbucketJson(prUrl(apiBase, workspace, repo, prId), token, timeoutMs), repo);
}

// Detalhe do PR + diffstat agregado (arquivos alterados, linhas +/-). O
// diffstat é paginado no Bitbucket; segue os `next` até esgotar (PRs grandes
// de verdade são raros neste projeto — ver docs/conhecimento_consolidado_tms.md
// — mas o loop evita truncar silenciosamente um PR grande).
async function getPRDetail({ workspace, repo, prId, token, apiBase = DEFAULT_API_BASE, timeoutMs = DEFAULT_TIMEOUT_MS }) {
    const detail = await bitbucketJson(prUrl(apiBase, workspace, repo, prId), token, timeoutMs);
    let filesChanged = 0, linesAdded = 0, linesRemoved = 0;
    const files = []; // por arquivo, para a lista "Arquivos" do detalhe na aba "PRs"
    let next = `${prUrl(apiBase, workspace, repo, prId)}/diffstat?pagelen=100`;
    while (next) {
        const page = await bitbucketJson(next, token, timeoutMs);
        for (const entry of page.values || []) {
            filesChanged += 1;
            linesAdded += entry.lines_added || 0;
            linesRemoved += entry.lines_removed || 0;
            files.push({
                path: entry.new?.path || entry.old?.path || null,
                added: entry.lines_added || 0,
                removed: entry.lines_removed || 0,
                status: entry.status || null,
            });
        }
        next = page.next || null;
    }
    return { ...normalizePR(detail, repo), diffStat: { filesChanged, linesAdded, linesRemoved, files } };
}

// POST /2.0/repositories/{workspace}/{repo}/pullrequests/{id}/approve — aprova
// o PR como o dono do token. Devolve só { approved: true } por design (a spec
// não pede o corpo completo da API de volta pro cliente).
async function approvePR({ workspace, repo, prId, token, apiBase = DEFAULT_API_BASE, timeoutMs = DEFAULT_TIMEOUT_MS }) {
    await bitbucketJson(`${prUrl(apiBase, workspace, repo, prId)}/approve`, token, timeoutMs, { method: 'POST' });
    return { approved: true };
}

module.exports = { DEFAULT_API_BASE, DEFAULT_TIMEOUT_MS, getCurrentUser, listPRs, getPR, getPRDetail, approvePR };
