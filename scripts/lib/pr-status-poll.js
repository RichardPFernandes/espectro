// Polling pós-abertura dos PRs de cada task (consistência cross-repo).
//
// Uma task que toca mais de um repo abre um PR por repo (state.json.pull_request,
// mapa repo → entrada). Depois de abertos, nada acompanhava o que acontecia com
// eles: se o PR do app-front fosse mergeado e o do app-back recusado, o front ia
// pra produção chamando endpoint que só existe em branch — sem alerta nenhum.
//
// A cada ciclo (readmine-watcher.js > startPrStatusPolling, a cada
// PR_STATUS_POLL_INTERVAL_MS), pra cada task com status "committed":
//   1. consulta cada PR registrado (scripts/check-pr-status.js, via withRetry);
//   2. grava `status` e `last_checked_at` na entrada do repo;
//   3. um MERGED + outro DECLINED na mesma task → evento `escalation` em
//      state.events (uma vez por combinação) + alerta no log a cada ciclo;
//   4. todos MERGED → status da task vira "fully_merged" (+ pr_status "merged") e ela
//      sai do polling; depois da escrita chama onFullyMerged (o watcher remove os
//      worktrees do ticket — scripts/lib/worktree-cleanup.js).
//   5. pr_status (Task 51) acompanha o campo `draft` do Bitbucket enquanto aberto:
//      algum PR ainda Draft → "draft"; todos fora de Draft → "ready" (inclui quem
//      tirou de Draft direto no Bitbucket, não pelo dashboard).
//
// Nunca mexe em `updated_at`: mostRecentArchivedCommit (watcher) compara o
// updated_at da task arquivada com o updated_on do ticket pra decidir se uma
// Recusa QA nova é um ciclo novo — reescrevê-lo aqui a cada 10 min faria o watcher
// ignorar recusas reais. O horário da checagem fica em last_checked_at.
//
// Só lê/escreve state.json; não abre, fecha nem altera PR nenhum.

const fs = require('fs');
const path = require('path');
const stateWriter = require('../state-writer');

const PR_URL_RE = /bitbucket\.org\/([^/]+)\/([^/]+)\/pull-requests?\/(\d+)/i;
const DEFAULT_INTERVAL_MS = 600000;

function resolvePollIntervalMs(env = process.env) {
    const v = Number(env.PR_STATUS_POLL_INTERVAL_MS);
    return Number.isFinite(v) && v > 0 ? v : DEFAULT_INTERVAL_MS;
}

// state.pull_request aparece em vários formatos nos runs reais (string com a URL,
// { url, id }, { pr_url }, { url, pr_id }, ...). Normaliza pra
// [{ key, workspace, repo, prId, url, status }]. `key` é a chave do mapa (nome do
// repo, que é o que aparece no log/evento); `repo` é o slug do Bitbucket (da URL,
// senão a própria chave). Entrada sem número de PR descobrível volta com prId null
// — nunca é consultada, e impede a task de virar fully_merged (não dá pra afirmar
// que esse repo foi mergeado).
function listPrEntries(pullRequest, defaultWorkspace = null) {
    if (!pullRequest || typeof pullRequest !== 'object' || Array.isArray(pullRequest)) return [];
    // Formato plano legado ({ url, id } direto em pull_request, sem repo) — não é
    // mapa por repo, não dá pra falar em consistência entre repos.
    if (typeof pullRequest.url === 'string' || typeof pullRequest.pr_url === 'string') return [];
    const out = [];
    for (const [key, raw] of Object.entries(pullRequest)) {
        const v = typeof raw === 'string' ? { url: raw } : raw;
        if (!v || typeof v !== 'object') continue;
        const url = [v.url, v.pr_url].find(u => typeof u === 'string' && /^https?:\/\//i.test(u)) || null;
        const m = url ? url.match(PR_URL_RE) : null;
        const prId = Number(v.pr_id ?? v.id ?? (m && m[3])) || null;
        out.push({
            key,
            workspace: (m && m[1]) || defaultWorkspace,
            repo: (m && m[2]) || key,
            prId,
            url,
            status: typeof v.status === 'string' ? v.status.toUpperCase() : null,
        });
    }
    return out;
}

// { 'app-back': 'DECLINED', 'app-front': 'MERGED' } → detalhe do alerta, ou null.
function findInconsistency(statusByRepo) {
    const repos = Object.keys(statusByRepo);
    if (repos.length < 2) return null; // repo único: não há irmão com que divergir
    const merged = repos.filter(r => statusByRepo[r] === 'MERGED');
    const declined = repos.filter(r => statusByRepo[r] === 'DECLINED');
    if (!merged.length || !declined.length) return null;
    return `PR inconsistência cross-repo: ${merged.join(', ')} MERGED mas ${declined.join(', ')} DECLINED`;
}

// Aplica os resultados da consulta (key → { status, checkedAt }) numa cópia do
// state. Entradas que falharam na consulta (ausentes de `results`) mantêm o status
// anterior. Devolve { state, statusByRepo, inconsistency, newEscalation, fullyMerged }.
function applyPrStatuses(state, results) {
    const next = { ...state, pull_request: { ...state.pull_request } };
    for (const [key, r] of Object.entries(results)) {
        const raw = next.pull_request[key];
        const entry = typeof raw === 'string' ? { url: raw } : { ...raw };
        if (entry.pr_id == null && entry.id == null && r.prId) entry.pr_id = r.prId;
        entry.status = r.status;
        if (typeof r.draft === 'boolean') entry.draft = r.draft;
        entry.last_checked_at = r.checkedAt;
        next.pull_request[key] = entry;
    }

    const entries = listPrEntries(next.pull_request);
    const statusByRepo = Object.fromEntries(entries.map(e => [e.key, e.status || 'UNKNOWN']));
    const inconsistency = findInconsistency(statusByRepo);
    const events = Array.isArray(next.events) ? next.events : [];
    let newEscalation = false;
    if (inconsistency && !events.some(e => e && e.type === 'escalation' && e.detail === inconsistency)) {
        const at = Object.values(results)[0]?.checkedAt || new Date().toISOString();
        next.events = [...events, { type: 'escalation', node: 'commit', at, detail: inconsistency }];
        newEscalation = true;
    }

    // Draft só é sabido dos PRs consultados neste ciclo; os outros (falha na consulta)
    // não mudam o veredito. pr_id: app-back primeiro, é o repo dono do ciclo.
    const drafts = Object.values(results).map(r => r.draft).filter(d => typeof d === 'boolean');
    if (drafts.length && next.pr_status !== 'merged') next.pr_status = drafts.some(Boolean) ? 'draft' : 'ready';
    if ((next.pr_id == null || next.pr_id === '') && entries.length) {
        const main = entries.find(e => e.key === (process.env.WATCHER_MAIN_REPO_NAME || require('path').basename(process.env.REPO_PATH || process.cwd()))) || entries[0];
        if (main.prId) next.pr_id = main.prId;
    }

    const fullyMerged = entries.length > 0 && entries.every(e => e.status === 'MERGED');
    if (fullyMerged) {
        const at = Object.values(results)[0]?.checkedAt || new Date().toISOString();
        next.status = 'fully_merged';
        next.pr_status = 'merged';
        next.events = [...(next.events || events), {
            type: 'fully_merged', node: 'commit', at,
            detail: `Todos os PRs mergeados (${entries.map(e => e.key).join(', ')}) — task sai do polling de PRs.`,
        }];
    }
    return { state: next, statusByRepo, inconsistency, newEscalation, fullyMerged };
}

function readStateRaw(dir) {
    try { return JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8')); } catch { return null; }
}

function writeStateRaw(dir, state) {
    stateWriter.write(dir, state, { operation: 'pr_status_poll', actor: 'watcher' });
}

function stateTime(state) {
    return new Date(state?.updated_at || state?.started_at || 0).getTime() || 0;
}

// Tasks "committed" com PR, uma cópia por task-id. Vários checkouts carregam cópias
// do mesmo run (memory/runs é versionado), então — mesma regra do dashboard
// (pickCandidate) — vale a do worktree do próprio ticket, senão a atualizada mais
// recentemente. O status é checado DEPOIS de escolher a cópia: uma cópia velha
// "committed" não pode ressuscitar o polling de uma task já fully_merged.
//
// roots: [{ dir: '<...>/memory/runs', worktree?: '<nome do worktree>' }] (em
// runPrStatusCycle pode ser função, reavaliada a cada ciclo). Varre
// <dir>/<task> e <dir>/_archive/<task> (commit arquiva a task).
function collectCommittedTasks(roots, { readState = readStateRaw, filter } = {}) {
    const byTask = new Map();
    for (const root of roots) {
        for (const base of [root.dir, path.join(root.dir, '_archive')]) {
            let dirents;
            try { dirents = fs.readdirSync(base, { withFileTypes: true }); } catch { continue; }
            for (const d of dirents) {
                if (!d.isDirectory() || d.name.startsWith('_') || d.name.startsWith('.')) continue;
                const dir = path.join(base, d.name);
                if (!fs.existsSync(path.join(dir, 'state.json'))) continue;
                if (filter && !filter(d.name)) continue;
                if (!byTask.has(d.name)) byTask.set(d.name, []);
                byTask.get(d.name).push({ taskId: d.name, dir, worktree: root.worktree || null });
            }
        }
    }
    const tasks = [];
    for (const [taskId, copies] of byTask) {
        const ticket = (taskId.match(/^(\d+)-/) || [])[1];
        const withState = copies.map(c => ({ ...c, state: readState(c.dir) })).filter(c => c.state);
        const own = ticket && withState.filter(c => c.worktree === ticket);
        const pool = own && own.length ? own : withState;
        const chosen = pool.reduce((best, c) => (!best || stateTime(c.state) > stateTime(best.state) ? c : best), null);
        if (!chosen || chosen.state.status !== 'committed') continue;
        if (!listPrEntries(chosen.state.pull_request).length) continue;
        tasks.push(chosen);
    }
    return tasks.sort((a, b) => a.taskId.localeCompare(b.taskId));
}

// Um ciclo completo. Nunca lança: erro de uma consulta/task é logado e o resto segue.
async function runPrStatusCycle({
    roots, getStatus, withRetry = fn => fn(), now = () => new Date(), log = console,
    dryRun = false, filter, defaultWorkspace = null,
    readState = readStateRaw, writeState = writeStateRaw, onFullyMerged = null,
}) {
    const summary = { tasks: 0, checked: 0, errors: 0, written: 0, fullyMerged: [], inconsistencies: [] };
    const tasks = collectCommittedTasks(typeof roots === 'function' ? roots() : roots, { readState, filter });
    summary.tasks = tasks.length;
    if (!tasks.length) {
        log.log('[pr-check] Nenhuma task committed com PR registrado — nada a consultar.');
        return summary;
    }

    // Mesmo PR registrado em mais de uma task (ex: task de ajuste reaproveitando o
    // PR aberto) é consultado uma vez só por ciclo.
    const cache = new Map();
    const check = e => {
        const k = `${e.workspace}/${e.repo}/${e.prId}`;
        if (!cache.has(k)) {
            cache.set(k, withRetry(() => getStatus({ workspace: e.workspace, repo: e.repo, prId: e.prId }))
                .then(r => ({ status: String(r.status || '').toUpperCase(), draft: r.draft, checkedAt: now().toISOString() })));
        }
        return cache.get(k);
    };

    for (const task of tasks) {
        try {
            const entries = listPrEntries(task.state.pull_request, defaultWorkspace);
            const results = {};
            for (const e of entries) {
                if (!e.prId || !e.workspace) {
                    log.warn(`[pr-check] Task ${task.taskId}: ${e.key} sem número de PR/workspace descobrível no state.json — não consultado.`);
                    continue;
                }
                try {
                    results[e.key] = { ...(await check(e)), prId: e.prId };
                    summary.checked++;
                } catch (err) {
                    summary.errors++;
                    log.error(`[pr-check] Task ${task.taskId}: falha consultando ${e.repo}#${e.prId} (mantém status anterior): ${err.message}`);
                }
            }

            // Relê logo antes de escrever: o state pode ter mudado durante as
            // consultas (ex: humano corrigindo à mão). Só aplica se ainda é committed.
            const fresh = readState(task.dir);
            if (!fresh || fresh.status !== 'committed') continue;
            const applied = applyPrStatuses(fresh, results);
            const line = entries.map(e => `${e.key}=${applied.statusByRepo[e.key]}`).join(', ');
            log.log(`[pr-check] Task ${task.taskId}: ${line}`);
            if (applied.inconsistency) {
                summary.inconsistencies.push({ taskId: task.taskId, detail: applied.inconsistency });
                log.error(`[pr-check] ALERTA Task ${task.taskId}: ${applied.inconsistency}${applied.newEscalation ? ' — evento escalation gravado' : ''}`);
            }
            if (applied.fullyMerged) {
                summary.fullyMerged.push(task.taskId);
                log.log(`[pr-check] Task ${task.taskId}: todos os PRs MERGED → status fully_merged.`);
            }
            if (!Object.keys(results).length || dryRun) continue;
            writeState(task.dir, applied.state, { previous: fresh });
            summary.written++;
            // Só depois do MERGED gravado: é a confirmação do Bitbucket que libera o
            // cleanup. Erro aqui não desfaz o fully_merged (a task já saiu do polling).
            if (applied.fullyMerged && onFullyMerged) {
                try {
                    await onFullyMerged({ taskId: task.taskId, dir: task.dir, worktree: task.worktree, state: applied.state });
                } catch (err) {
                    log.error(`[pr-check] Task ${task.taskId}: pós-merge falhou: ${err.message}`);
                }
            }
        } catch (err) {
            summary.errors++;
            log.error(`[pr-check] Task ${task.taskId}: erro inesperado (demais tasks seguem): ${err.message}`);
        }
    }
    return summary;
}

// withRetry de scripts/retry.js (Task 12), se existir; senão uma tentativa só —
// erro transiente fica logado e o próximo ciclo tenta de novo.
function loadWithRetry() {
    try {
        const m = require('../retry');
        if (typeof m.withRetry === 'function') return fn => m.withRetry(fn);
    } catch { /* retry.js ainda não existe */ }
    return fn => fn();
}

function readMarker(markerPath) {
    try { return JSON.parse(fs.readFileSync(markerPath, 'utf8')); } catch { return null; }
}

// Liga o polling em background: roda um ciclo agora (se o último, registrado em
// markerPath, foi há mais de intervalMs — o watcher normal é um processo por tick,
// via cron, então sem o marcador cada tick consultaria o Bitbucket) e agenda os
// próximos com setInterval. O timer é unref(): não segura o processo vivo — num
// tick de cron o processo sai quando o tick acaba (settle() espera o ciclo em
// andamento terminar de gravar); em --follow ele segue disparando a cada intervalo.
// Nunca bloqueia o despacho de tasks: quem chama NÃO dá await no ciclo.
function startPrStatusPolling({
    token, intervalMs = DEFAULT_INTERVAL_MS, markerPath = null, force = false,
    getStatus, now = () => new Date(), log = console, ...cycleOpts
}) {
    if (!token) {
        log.warn('[pr-check] BITBUCKET_API_TOKEN ausente — polling de status dos PRs desligado.');
        return { settle: async () => null, stop() {} };
    }
    const withRetry = cycleOpts.withRetry || loadWithRetry();
    let inFlight = null;

    const cycle = () => {
        if (inFlight) return inFlight; // ciclo anterior ainda rodando: não empilha
        inFlight = runPrStatusCycle({ ...cycleOpts, withRetry, now, log, getStatus: args => getStatus({ ...args, token }) })
            .then(summary => {
                if (markerPath && !cycleOpts.dryRun) {
                    fs.writeFileSync(markerPath, JSON.stringify({ last_run_at: now().toISOString(), ...summary }, null, 2));
                }
                return summary;
            })
            .catch(e => { log.error('[pr-check] ciclo falhou (watcher segue normal):', e.message); return null; })
            .finally(() => { inFlight = null; });
        return inFlight;
    };

    const last = Date.parse(markerPath ? readMarker(markerPath)?.last_run_at : '') || 0;
    if (force || now().getTime() - last >= intervalMs) cycle();
    const timer = setInterval(cycle, intervalMs);
    if (typeof timer.unref === 'function') timer.unref();

    return {
        settle: () => inFlight || Promise.resolve(null),
        stop: () => clearInterval(timer),
    };
}

module.exports = {
    DEFAULT_INTERVAL_MS, resolvePollIntervalMs,
    listPrEntries, findInconsistency, applyPrStatuses, collectCommittedTasks, runPrStatusCycle,
    startPrStatusPolling, loadWithRetry,
};
