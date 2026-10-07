// "Usar na minha máquina" do dashboard (dashboard/server.js > /api/local-checkout*):
// põe os checkouts principais configurados no commit do worktree do ticket, sem
// apagar o worktree — apagá-lo leva junto memory/runs/<task> e o run some do dashboard.
//
// `git checkout <branch>` é recusado com a branch presa ao worktree, então o checkout
// principal vai pro HEAD do worktree em detached (`git switch --detach <sha>`). A ref
// anterior de cada repo fica em dashboard/local-checkout.json; restore() volta pra ela.
//
// Só `git switch`: nunca stash/reset/clean. Alteração local do checkout principal vai
// junto; se o git recusar (conflito), use() desfaz os repos já trocados e falha inteiro.
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const TICKET_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function httpError(status, message, extra = {}) { return Object.assign(new Error(message), { status }, extra); }

function runGit(dir, args) {
    return new Promise((resolve, reject) => {
        execFile('git', ['-C', dir, ...args], { timeout: 60000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
            if (err) return reject(Object.assign(err, { message: String(stderr || err.message).trim() || err.message }));
            resolve(String(stdout).trim());
        });
    });
}

function createLocalCheckout(options = {}) {
    const env = options.env || process.env;
    const repoRoot = path.resolve(options.repoRoot || env.REPO_PATH || process.cwd());
    const worktreesDir = options.worktreesDir || path.join(repoRoot, '.claude', 'worktrees');
    const stateFile = options.stateFile || path.join(repoRoot, 'dashboard', 'local-checkout.json');
    const git = options.git || runGit;
    // Mesma regra de scripts/preview-manager.js > detectWorktrees(): o back em
    // .claude/worktrees/<t>; os irmãos em .claude/worktrees/<t>-<repo> ou no próprio
    // repo irmão (../<repo>/.claude/worktrees/<t>, onde o watcher os cria).
    const sibling = name => path.resolve(repoRoot, '..', name);
    const siblingNames = options.siblingRepos || String(env.WATCHER_SIBLING_REPOS || '').split(',').map(x => x.trim()).filter(Boolean);
    for (const name of siblingNames) {
        if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name) || name.includes('..')) throw new Error('nome de repositório irmão inválido');
    }
    const repos = options.repos || [
        { key: options.repoName || env.WATCHER_MAIN_REPO_NAME || env.BITBUCKET_REPO_SLUG || path.basename(repoRoot), main: repoRoot, worktrees: t => [path.join(worktreesDir, t)] },
        ...siblingNames.map(name => ({
            key: name, main: sibling(name),
            worktrees: t => [path.join(worktreesDir, `${t}-${name}`), path.join(sibling(name), '.claude', 'worktrees', t)],
        })),
    ];
    for (const repo of repos) {
        if (!repo.key || !path.isAbsolute(repo.main) || typeof repo.worktrees !== 'function') throw new Error('repositório de checkout inválido');
    }
    let busy = false;

    function readState() {
        let state;
        try { state = JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch { return null; }
        for (const [key, recorded] of Object.entries(state?.repos || {})) {
            const configured = repos.find(r => r.key === key);
            if (!configured || typeof recorded.dir !== 'string' || path.resolve(recorded.dir) !== path.resolve(configured.main)) {
                throw httpError(409, 'estado de checkout pertence a uma configuração de repositórios diferente');
            }
        }
        return state;
    }
    function writeState(state) {
        if (state && Object.keys(state.repos || {}).length) {
            fs.mkdirSync(path.dirname(stateFile), { recursive: true });
            fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
        }
        else fs.rmSync(stateFile, { force: true });
    }
    function validId(ticketId) {
        if (!TICKET_ID_RE.test(String(ticketId || '')) || String(ticketId).includes('..')) throw httpError(400, 'ticket inválido');
        return String(ticketId);
    }
    const isGit = dir => fs.existsSync(path.join(dir, '.git'));

    // { type: 'branch', ref: 'master' } ou { type: 'detached', ref: '<sha>' }.
    async function currentRef(dir) {
        const branch = await git(dir, ['symbolic-ref', '-q', '--short', 'HEAD']).catch(() => '');
        return branch ? { type: 'branch', ref: branch } : { type: 'detached', ref: await git(dir, ['rev-parse', 'HEAD']) };
    }
    const switchArgs = target => target.type === 'branch' ? ['switch', target.ref] : ['switch', '--detach', target.ref];

    // O que cada repo teria pra este ticket: worktree, sha do HEAD dele e se está sujo.
    async function ticketRepos(ticketId) {
        const out = [];
        for (const r of repos) {
            const candidates = r.worktrees(ticketId);
            if (!Array.isArray(candidates) || candidates.some(p => typeof p !== 'string' || !path.isAbsolute(p))) throw httpError(400, 'root de worktree inválido');
            const worktree = candidates.find(p => fs.existsSync(p)) || null;
            const item = { key: r.key, dir: r.main, worktree, sha: null, dirty: false, available: false };
            if (worktree && isGit(r.main)) {
                try {
                    item.sha = await git(worktree, ['rev-parse', 'HEAD']);
                    item.dirty = !!(await git(worktree, ['status', '--porcelain', '--untracked-files=no']));
                    item.available = true;
                } catch (e) { item.error = e.message; }
            }
            out.push(item);
        }
        return out;
    }

    async function status(ticketId) {
        const active = readState();
        const res = { active };
        if (ticketId) res.repos = await ticketRepos(validId(ticketId));
        return res;
    }

    // Aplica ops [{ key, dir, target }] em ordem; falhou uma (inclusive ao ler a ref
    // atual) → desfaz as já feitas, cada uma pra ref de antes DESTA chamada, e lança 409
    // com o erro do git. `stuck` = ops cujo desfazer também falhou (continuam trocadas).
    async function applyAll(ops) {
        const done = [];
        for (const op of ops) {
            try {
                const before = await currentRef(op.dir);
                await git(op.dir, switchArgs(op.target));
                done.push({ ...op, before });
            } catch (e) {
                const rollbackErrors = [];
                const stuck = [];
                for (const d of done.reverse()) {
                    try { await git(d.dir, switchArgs(d.before)); } catch (re) {
                        rollbackErrors.push(`${d.key}: ${re.message}`);
                        stuck.push(d);
                    }
                }
                throw httpError(409, `${op.key}: o git recusou a troca — ${e.message}`, { repo: op.key, rollbackErrors, stuck });
            }
        }
    }

    // Repo continua exatamente onde o "Usar" o deixou (detached no sha gravado)? Se
    // não, alguém mexeu à mão — voltar descartaria o que foi feito (commit em detached).
    async function untouched(r) {
        const head = await git(r.dir, ['rev-parse', 'HEAD']);
        const branch = await git(r.dir, ['symbolic-ref', '-q', '--short', 'HEAD']).catch(() => '');
        return !branch && head === r.sha;
    }

    async function use(ticketId) {
        const id = validId(ticketId);
        if (busy) throw httpError(409, 'outra troca de checkout em andamento');
        busy = true;
        try {
            const items = (await ticketRepos(id)).filter(i => i.available);
            if (!items.length) throw httpError(404, `nenhum worktree do ticket ${id} encontrado`);
            const prev = readState();
            const prevRepos = prev?.repos || {};
            const ops = [];
            const next = { ticket: id, at: new Date().toISOString(), repos: {} };
            const warnings = items.filter(i => i.dirty)
                .map(i => `${i.key}: o worktree do ticket tem alteração não commitada — ela não vem pro checkout principal`);
            for (const i of items) {
                const was = prevRepos[i.key];
                // Já trocado antes, mas alguém mexeu à mão desde então: não retroca (um
                // commit feito em detached ficaria órfão). Mantém a entrada anterior.
                if (was && !(await untouched(was).catch(() => false))) {
                    next.repos[i.key] = was;
                    warnings.push(`${i.key}: HEAD mudou desde o último "Usar" — não troquei`);
                    continue;
                }
                // Ticket anterior ainda ativo: a ref "de volta" continua sendo a original.
                const previous = was?.previous || await currentRef(i.dir);
                next.repos[i.key] = { dir: i.dir, previous, sha: i.sha };
                ops.push({ key: i.key, dir: i.dir, target: { type: 'detached', ref: i.sha } });
            }
            // Repo que o ticket anterior trocou e este não tem: volta pra ref original —
            // salvo se sumiu ou se alguém mexeu nele desde então (aí fica como está).
            for (const [key, r] of Object.entries(prevRepos)) {
                if (next.repos[key]) continue;
                const ok = isGit(r.dir) && await untouched(r).catch(() => false);
                if (ok) ops.push({ key, dir: r.dir, target: r.previous, returning: true });
                else warnings.push(`${key}: não voltei pra ${r.previous.ref} (HEAD mudou ou repo sumiu) — confira à mão`);
            }
            try {
                await applyAll(ops);
            } catch (e) {
                // Desfazer falhou em algum repo do ticket novo: ele segue no sha do ticket.
                // Grava no estado pra o "Voltar" continuar disponível pra ele. (Repo que
                // estava voltando e não desfez já está na ref original: sai do estado.)
                if (e.stuck?.length) {
                    const keep = { ...(prev || { ticket: id, at: next.at }), repos: { ...prevRepos } };
                    for (const s of e.stuck) {
                        if (s.returning) delete keep.repos[s.key];
                        else keep.repos[s.key] = next.repos[s.key];
                    }
                    writeState(keep);
                }
                throw e;
            }
            writeState(next);
            const skipped = repos.map(r => r.key).filter(k => !next.repos[k]);
            return { ok: true, active: next, warnings, skipped };
        } finally {
            busy = false;
        }
    }

    async function restore() {
        if (busy) throw httpError(409, 'outra troca de checkout em andamento');
        const state = readState();
        if (!state) throw httpError(404, 'nenhum checkout trocado pelo dashboard');
        busy = true;
        try {
            const results = [];
            const remaining = {};
            for (const [key, r] of Object.entries(state.repos || {})) {
                if (!isGit(r.dir)) {
                    results.push({ key, ok: false, skipped: true, message: `repo não encontrado em ${r.dir} — tirei do estado` });
                    continue;
                }
                try {
                    // Alguém já mudou o HEAD desde o "Usar" (switch/commit na mão): não
                    // mexe — voltar agora descartaria o que a pessoa fez de lá pra cá.
                    if (!(await untouched(r))) {
                        results.push({ key, ok: false, skipped: true, message: `HEAD mudou desde o "Usar na minha máquina" — não mexi (a ref de antes era ${r.previous.ref})` });
                        continue;
                    }
                    await git(r.dir, switchArgs(r.previous));
                    results.push({ key, ok: true, ref: r.previous.ref });
                } catch (e) {
                    remaining[key] = r;
                    results.push({ key, ok: false, message: e.message });
                }
            }
            writeState({ ...state, repos: remaining });
            return { ok: !Object.keys(remaining).length, results, active: readState() };
        } finally {
            busy = false;
        }
    }

    return { status, use, restore };
}

module.exports = { createLocalCheckout, TICKET_ID_RE };
