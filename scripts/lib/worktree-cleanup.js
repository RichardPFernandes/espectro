// Remoção dos worktrees de um ticket depois que o(s) PR(s) dele foram mergeados.
//
// Quem chama: o polling de PRs do watcher (readmine-watcher.js > onTaskFullyMerged),
// e só quando o Bitbucket confirmou MERGED em todos os PRs da task — nunca antes.
//
// Worktrees do ticket (mesmo padrão do preview, scripts/preview-manager.js):
//   .claude/worktrees/<id>            (app-back)
//   .claude/worktrees/<id>-mo-entity
//   .claude/worktrees/<id>-app-core
//   .claude/worktrees/<id>-app-front
// Os três irmãos moram embaixo do .claude/worktrees do app-back, mas são worktrees
// dos repos deles — `git worktree remove` roda no repo dono (descoberto pelo
// --git-common-dir do próprio worktree), senão o git recusa ("is not a working tree").
// Layout que o watcher usa hoje (o mesmo que o preview-manager também procura):
//   ../mo-entity/.claude/worktrees/<id>, ../app-core/…/<id>, ../app-front/…/<id>
// Diretório que já sumiu mas continua registrado no repo (`git worktree list` o marca
// "prunable") é limpo com `git worktree prune` no repo dono — senão fica vinculado.
//
// Preview: roda DENTRO do processo do dashboard (filhos dele), então quem o para é o
// dashboard — POST /api/preview/<id>/stop no localhost. Dashboard fora do ar = nenhum
// preview rodando (o dashboard mata os filhos ao sair). Se o dashboard está de pé mas
// não confirmou a parada, NADA é removido: apagar o worktree com mvn/java/grunt
// rodando em cima deixaria processo órfão segurando porta e arquivo.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const REPO_ROOT = path.resolve(process.env.REPO_PATH || process.cwd());
const SIBLING_NAMES = (process.env.WATCHER_SIBLING_REPOS || '').split(',').map(s => s.trim()).filter(Boolean);
const SUFFIXES = ['', ...SIBLING_NAMES.map(n => `-${n}`)];
const TICKET_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const DASHBOARD_TIMEOUT_MS = 30000;
const SIBLING_REPOS = SIBLING_NAMES.map(n => path.resolve(REPO_ROOT, '..', n));

function dashboardBase(env = process.env) {
    return `http://127.0.0.1:${Number(env.PORT) || 3333}`;
}

// true = parou (ou não havia nada rodando); lança se não deu pra confirmar.
async function stopPreviewViaDashboard(ticketId, { base = dashboardBase(), timeoutMs = DASHBOARD_TIMEOUT_MS } = {}) {
    const url = `${base}/api/preview/${encodeURIComponent(ticketId)}`;
    let st;
    try {
        const res = await fetch(`${url}/status`, { signal: AbortSignal.timeout(timeoutMs) });
        if (!res.ok) throw new Error(`status HTTP ${res.status}`);
        st = await res.json();
    } catch (e) {
        // Dashboard não está rodando: não há preview (os processos são filhos dele).
        if (e.cause?.code === 'ECONNREFUSED') return { running: false, stopped: false };
        throw new Error(`não consegui consultar o preview no dashboard: ${e.message}`);
    }
    if (!st || st.phase === 'idle') return { running: false, stopped: false };
    const res = await fetch(`${url}/stop`, { method: 'POST', signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) throw new Error(`dashboard recusou parar o preview (HTTP ${res.status})`);
    const after = await res.json().catch(() => null);
    if (after?.phase && after.phase !== 'idle') throw new Error(`preview ainda em "${after.phase}" depois do stop`);
    return { running: true, stopped: true };
}

// Repo principal dono do worktree (…/app-core pra .claude/worktrees/<id>-app-core).
function ownerRepo(worktreePath, exec) {
    const common = exec('git', ['-C', worktreePath, 'rev-parse', '--path-format=absolute', '--git-common-dir']).trim();
    return path.dirname(common);
}

function defaultExec(cmd, args) {
    return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

// Caminhos registrados como worktree no repo (vazio se o repo não existe/não é git).
function registeredWorktrees(repo, exec) {
    try {
        return exec('git', ['-C', repo, 'worktree', 'list', '--porcelain'])
            .split('\n').filter(l => l.startsWith('worktree ')).map(l => l.slice(9).trim());
    } catch { return []; }
}

// realpath de caminho que talvez não exista mais (resolve o que existir do prefixo) —
// o git registra o caminho real (/private/tmp vs /tmp no macOS).
function realish(p) {
    try { return fs.realpathSync(p); } catch {}
    const parent = path.dirname(p);
    return parent === p ? p : path.join(realish(parent), path.basename(p));
}

// true se o worktree tem mudança em arquivo rastreado (untracked — target/,
// node_modules, memory/ — não conta). Na dúvida (git falhou), conta como sujo.
function isDirty(worktreePath, exec) {
    try {
        return !!exec('git', ['-C', worktreePath, 'status', '--porcelain', '--untracked-files=no']).trim();
    } catch { return true; }
}

// Devolve { removed: string[], kept: { path, reason }[], errors: { path, error }[], previewStopped: boolean }.
// Worktree inexistente é ignorado (não é erro). Nunca lança.
// skipDirty: worktree com mudança rastreada não commitada fica (vai pra `kept`) em vez
// de ir embora no --force — usado na limpeza logo após o PR aberto (readmine-watcher.js
// > cleanupWorktreesAfterPrOpen), quando um repo irmão pode ter sobra que não entrou
// em PR nenhum. O cleanup pós-merge não passa isso: lá o PR já foi mergeado.
async function cleanupWorktrees(ticketId, {
    worktreesDir = path.join(REPO_ROOT, '.claude', 'worktrees'),
    stopPreview = stopPreviewViaDashboard,
    siblingRepos = SIBLING_REPOS,
    exec = defaultExec,
    log = console,
    skipDirty = false,
} = {}) {
    const out = { removed: [], kept: [], errors: [], previewStopped: false };
    if (!TICKET_ID_RE.test(String(ticketId))) {
        out.errors.push({ path: null, error: `ticket-id inválido: ${ticketId}` });
        return out;
    }
    const candidates = [
        ...[ '', ...siblingRepos.map(r => `-${path.basename(r)}`) ].map(s => path.join(worktreesDir, `${ticketId}${s}`)),
        ...siblingRepos.map(r => path.join(r, '.claude', 'worktrees', String(ticketId))),
    ];
    const existing = candidates.filter(p => fs.existsSync(p));

    // Diretório já apagado mas ainda registrado: prune no repo dono (não precisa parar
    // preview — não há arquivo nenhum pra processo segurar).
    const backRepo = path.resolve(worktreesDir, '..', '..');
    for (const repo of [backRepo, ...siblingRepos]) {
        const registered = new Set(registeredWorktrees(repo, exec));
        const stale = candidates.filter(p => !fs.existsSync(p) && registered.has(realish(p)));
        if (!stale.length) continue;
        try {
            exec('git', ['-C', repo, 'worktree', 'prune']);
            out.removed.push(...stale);
            log.log(`[worktree-cleanup] #${ticketId}: registro órfão podado em ${path.basename(repo)}: ${stale.join(', ')}.`);
        } catch (e) {
            const error = String(e.stderr || e.message || e).trim().split('\n')[0];
            for (const p of stale) out.errors.push({ path: p, error });
            log.error(`[worktree-cleanup] #${ticketId}: falha no prune de ${path.basename(repo)}: ${error}`);
        }
    }

    if (!existing.length) {
        if (out.removed.length || out.errors.length) return out;
        log.log(`[worktree-cleanup] #${ticketId}: nenhum worktree do ticket — nada a remover.`);
        return out;
    }

    try {
        const r = await stopPreview(String(ticketId));
        out.previewStopped = !!r?.stopped;
        if (out.previewStopped) log.log(`[worktree-cleanup] #${ticketId}: preview estava rodando — parado antes da remoção.`);
    } catch (e) {
        // Sem confirmação de que o preview parou, não remove nada.
        const error = `preview não parou: ${e.message}`;
        log.error(`[worktree-cleanup] #${ticketId}: ${error} — nenhum worktree removido.`);
        for (const p of existing) out.errors.push({ path: p, error });
        return out;
    }

    for (const p of existing) {
        if (skipDirty && isDirty(p, exec)) {
            out.kept.push({ path: p, reason: 'mudança rastreada não commitada' });
            log.warn(`[worktree-cleanup] #${ticketId}: ${p} tem mudança não commitada — mantido.`);
            continue;
        }
        try {
            const repo = ownerRepo(p, exec);
            exec('git', ['-C', repo, 'worktree', 'remove', '--force', p]);
            out.removed.push(p);
            log.log(`[worktree-cleanup] #${ticketId}: removido ${p} (repo ${path.basename(repo)}).`);
        } catch (e) {
            const error = String(e.stderr || e.message || e).trim().split('\n')[0];
            out.errors.push({ path: p, error });
            log.error(`[worktree-cleanup] #${ticketId}: falha removendo ${p}: ${error}`);
        }
    }
    return out;
}

module.exports = { cleanupWorktrees, stopPreviewViaDashboard, dashboardBase, SUFFIXES, SIBLING_REPOS };
