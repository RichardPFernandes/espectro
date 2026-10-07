// Consulta o estado de um PR no Bitbucket Cloud. Mesmo request do
// bitbucket-open-pr.sh (Authorization: Bearer com o API token da Atlassian — Basic
// Auth com esse tipo de token dá 401/403 dependendo do endpoint).
//
// Input:  { workspace, repo, prId, token } (+ opcionais apiBase/timeoutMs, pra teste)
// Output: { status: 'OPEN' | 'MERGED' | 'DECLINED' | 'SUPERSEDED', url: string, draft: boolean }
//
// Usado pelo polling de PRs do watcher (scripts/lib/pr-status-poll.js). Erro HTTP
// vira exceção com `.status` — quem chama decide se tenta de novo (withRetry).
// Nunca coloca o token na URL nem na mensagem de erro.

const DEFAULT_API = 'https://api.bitbucket.org/2.0';
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
    return res.json();
}

async function getPRStatus({ workspace, repo, prId, token, apiBase = DEFAULT_API, timeoutMs = DEFAULT_TIMEOUT_MS }) {
    const data = await bitbucketJson(prUrl(apiBase, workspace, repo, prId), token, timeoutMs);
    return { status: data.state, url: data.links?.html?.href, draft: data.draft === true };
}

// Tira o PR de Draft (botão "Marcar como pronto" do dashboard). O PUT do Bitbucket
// Cloud valida o PR inteiro — sem `title` responde 400 —, então relê o PR e manda o
// título atual junto de draft:false. PR que já não é draft não é tocado.
// Output: { status, url, draft: false, changed: boolean }. Só PR OPEN pode mudar.
async function markPrReady({ workspace, repo, prId, token, apiBase = DEFAULT_API, timeoutMs = DEFAULT_TIMEOUT_MS }) {
    const url = prUrl(apiBase, workspace, repo, prId);
    const pr = await bitbucketJson(url, token, timeoutMs);
    if (pr.draft !== true) return { status: pr.state, url: pr.links?.html?.href, draft: false, changed: false };
    if (pr.state !== 'OPEN') {
        const err = new Error(`PR ${repo}#${prId} está ${pr.state} — só PR aberto sai de Draft`);
        err.status = 409;
        throw err;
    }
    const data = await bitbucketJson(url, token, timeoutMs, { method: 'PUT', body: JSON.stringify({ title: pr.title, draft: false }) });
    if (data.draft === true) throw new Error(`Bitbucket manteve ${repo}#${prId} como Draft`);
    return { status: data.state, url: data.links?.html?.href, draft: false, changed: true };
}

module.exports = { getPRStatus, markPrReady };

// CLI pra checagem manual: node scripts/check-pr-status.js <repo> <prId>
// (lê BITBUCKET_WORKSPACE/BITBUCKET_API_TOKEN do ambiente).
if (require.main === module) {
    const [repo, prId] = process.argv.slice(2);
    const { BITBUCKET_WORKSPACE: workspace, BITBUCKET_API_TOKEN: token } = process.env;
    if (!repo || !prId || !workspace || !token) {
        console.error('uso: BITBUCKET_WORKSPACE=... BITBUCKET_API_TOKEN=... node scripts/check-pr-status.js <repo> <prId>');
        process.exit(1);
    }
    getPRStatus({ workspace, repo, prId, token })
        .then(r => console.log(JSON.stringify(r)))
        .catch(e => { console.error(e.message); process.exit(1); });
}
