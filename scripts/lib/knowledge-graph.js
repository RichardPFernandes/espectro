// Knowledge Graph de rastreabilidade ticket → spec → código → PR
// (memory/knowledge-graph.json no checkout principal — local, como todo memory/).
//
// Sem isto, dado um bug em produção num arquivo Java não havia como voltar à spec
// que originou a mudança: a ligação existia só implícita (branch = ticket, PR com o
// título do ticket, spec em memory/spec/<id>-spec.md). Aqui ela vira estrutura.
//
// Formato:
//   { version: 1, updatedAt, nodes: { "<id>": { type, ... } }, edges: [{ from, rel, to, at }] }
// Nós:
//   TASK-<ticket>                    type "ticket" (title, tracker, redmine_url)
//   memory/spec/<ticket>-spec.md     type "spec"   (task_id)
//   PR-<repo>-<n>                    type "pr"     (repo, number, url, status)
//   <caminho do arquivo>             type "file"   (repo, lang) — app-back sem prefixo,
//                                    repo irmão prefixado: "app-core/src/..."
// Arestas: generated_spec (ticket→spec), opened_pr (ticket→PR), touched_file (ticket→arquivo).
// A spec vive em memory/spec/<id>-spec.md (convenção real do /fetch-ticket), não em
// memory/runs/<task>/spec.md. O id do PR leva o repo: o mesmo número existe em
// app-back e app-front (cada repo do Bitbucket numera os seus).
//
// APPEND-ONLY: nó e aresta nunca são removidos. Atributo de nó existente só é
// acrescentado/atualizado (ex: status do PR open → merged), nunca apagado. Aresta
// é única por (from, rel, to) e mantém o `at` da primeira vez que foi vista.
//
// Escrita com lock simples (<kg>.lock criado com O_EXCL, 3 tentativas a 50ms) +
// tmp/rename: dois processos (watcher e /commit) nunca intercalam read-modify-write.
//
// Uso como CLI (o /commit chama, ver .claude/commands/commit.md):
//   node scripts/lib/knowledge-graph.js record <task-dir|task-id>     grava ticket/spec/PRs/arquivos da task
//   node scripts/lib/knowledge-graph.js annotate <task-dir|task-id> [--dry-run]
//        insere `// @spec ...` no topo dos .java criados ou com >20 linhas mudadas
//        (só repos com PR em state.json.pull_request; não commita — quem commita é o agente)
//   exit 0 = ok, 1 = falha, 2 = uso incorreto.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { listPrEntries } = require('./pr-status-poll');
const specVersion = require('./spec-version');

const KG_VERSION = 1;
const LOCK_ATTEMPTS = 3;
const LOCK_INTERVAL_MS = 50;
// Lock mais velho que isto é de um processo que morreu no meio — pode ser tomado.
const LOCK_STALE_MS = 10000;
const SIGNIFICANT_LINES = 20;
const SIBLING_REPOS = (process.env.WATCHER_SIBLING_REPOS || '').split(',').map(s => s.trim()).filter(Boolean);
// Nada disso é "código tocado": memory/ é local, .claude/ é tooling do agente.
const IGNORED_FILE_RE = /(^|\/)(memory|\.claude|node_modules|target)\/|^(dist|build)\//;
// Só código/config entra como arquivo tocado. Binário e artefato de build aparecem no
// working tree sem ser mudança da task (visto nos worktrees reais: app/images/CTe.png
// pela colisão de caixa do app-front, jacoco.exec do app-core) — e o grafo é
// append-only, então ruído gravado uma vez fica pra sempre.
const SOURCE_EXT_RE = /\.(java|kt|js|mjs|cjs|ts|tsx|jsx|html|jsp|css|scss|less|xml|properties|ya?ml|json|sql|sh|py|groovy|gradle|md|txt|csv|jrxml|ftl|vm)$/i;
const isTrackedSource = f => SOURCE_EXT_RE.test(f) && !IGNORED_FILE_RE.test(f) && !/(^|\/)\.DS_Store$/.test(f);
const SPEC_TAG_RE = /^\s*\/\/\s*@spec\s/;

// ---------------------------------------------------------------------------------
// Caminhos

function git(cwd, args) {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
}

function gitLines(cwd, args) {
    return git(cwd, args).split('\n').map(l => l.trim()).filter(Boolean);
}

// Checkout principal do app-back a partir de qualquer worktree dele (o /commit roda
// no worktree do ticket; o KG é um só, no principal).
function mainRepoOf(cwd) {
    try {
        const common = git(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir']).trim();
        return path.dirname(common);
    } catch {
        return path.resolve(process.env.REPO_PATH || cwd);
    }
}

function defaultGraphPath(cwd = process.cwd()) {
    return process.env.KNOWLEDGE_GRAPH_PATH || path.join(mainRepoOf(cwd), 'memory', 'knowledge-graph.json');
}

// ---------------------------------------------------------------------------------
// Leitura / escrita

function emptyGraph() {
    return { version: KG_VERSION, updatedAt: null, nodes: {}, edges: [] };
}

function readGraph(graphPath = defaultGraphPath()) {
    let raw;
    try { raw = fs.readFileSync(graphPath, 'utf8'); } catch { return emptyGraph(); }
    const g = JSON.parse(raw); // malformado: lança — melhor parar do que sobrescrever o histórico
    return {
        version: g.version || KG_VERSION,
        updatedAt: g.updatedAt || null,
        nodes: g.nodes && typeof g.nodes === 'object' ? g.nodes : {},
        edges: Array.isArray(g.edges) ? g.edges : [],
    };
}

function sleepSync(ms) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function acquireLock(lockPath) {
    for (let attempt = 1; attempt <= LOCK_ATTEMPTS; attempt++) {
        try {
            fs.writeFileSync(lockPath, `${process.pid} ${new Date().toISOString()}`, { flag: 'wx' });
            return;
        } catch (e) {
            if (e.code !== 'EEXIST') throw e;
            try {
                if (Date.now() - fs.statSync(lockPath).mtimeMs > LOCK_STALE_MS) { fs.rmSync(lockPath, { force: true }); continue; }
            } catch { continue; } // sumiu entre o EEXIST e o stat: tenta de novo
            if (attempt < LOCK_ATTEMPTS) sleepSync(LOCK_INTERVAL_MS);
        }
    }
    throw new Error(`knowledge-graph: lock ocupado (${lockPath}) depois de ${LOCK_ATTEMPTS} tentativas`);
}

// Aplica mutate(graph) sob lock e grava só se algo mudou. mutate devolve true/false.
function updateGraph(mutate, graphPath = defaultGraphPath()) {
    fs.mkdirSync(path.dirname(graphPath), { recursive: true });
    const lockPath = `${graphPath}.lock`;
    acquireLock(lockPath);
    try {
        const graph = readGraph(graphPath);
        const changed = mutate(graph);
        if (changed) {
            graph.updatedAt = new Date().toISOString();
            const tmp = `${graphPath}.${process.pid}.tmp`;
            fs.writeFileSync(tmp, JSON.stringify(graph, null, 2) + '\n');
            fs.renameSync(tmp, graphPath);
        }
        return { changed, graph };
    } finally {
        fs.rmSync(lockPath, { force: true });
    }
}

// ---------------------------------------------------------------------------------
// Merge append-only

const isEmpty = v => v == null || v === '' || (Array.isArray(v) && !v.length);

// Devolve true se mudou algo. Nunca remove nó, atributo ou aresta.
function mergeFacts(graph, { nodes = {}, edges = [] }) {
    let changed = false;
    for (const [id, attrs] of Object.entries(nodes)) {
        const cur = graph.nodes[id];
        if (!cur) { graph.nodes[id] = Object.fromEntries(Object.entries(attrs).filter(([, v]) => !isEmpty(v))); changed = true; continue; }
        for (const [k, v] of Object.entries(attrs)) {
            if (isEmpty(v) || JSON.stringify(cur[k]) === JSON.stringify(v)) continue;
            cur[k] = v;
            changed = true;
        }
    }
    const seen = new Set(graph.edges.map(e => `${e.from}\u0000${e.rel}\u0000${e.to}`));
    for (const e of edges) {
        const key = `${e.from}\u0000${e.rel}\u0000${e.to}`;
        if (seen.has(key)) continue;
        seen.add(key);
        graph.edges.push({ from: e.from, rel: e.rel, to: e.to, at: e.at || new Date().toISOString() });
        changed = true;
    }
    return changed;
}

// ---------------------------------------------------------------------------------
// Fatos de uma task

function ticketIdOf(taskId, state) {
    const fromState = state?.redmine_ticket?.id;
    if (fromState != null && /^\d+$/.test(String(fromState))) return String(fromState);
    const id = String(taskId || '');
    // Run sem ticket nomeado por data (2026-09-19-liquibase-...): não é o ticket 2026.
    if (/^\d{4}-\d{2}-\d{2}(?:-|$)/.test(id)) return null;
    const m = /^(\d+)(?:-|$)/.exec(id);
    return m ? m[1] : null;
}

const ticketNodeId = ticketId => `TASK-${ticketId}`;
const specNodeId = ticketId => `memory/spec/${ticketId}-spec.md`;
const prNodeId = (repo, number) => `PR-${repo}-${number}`;
const mainRepoName = () => process.env.WATCHER_MAIN_REPO_NAME || path.basename(process.env.REPO_PATH || process.cwd());
const fileNodeId = (repo, file) => (repo === mainRepoName() ? file : `${repo}/${file}`);

// PRs de state.pull_request em qualquer formato real (mapa por repo, string, plano legado).
function prsOf(state) {
    const pr = state?.pull_request;
    if (!pr) return [];
    const flatUrl = typeof pr === 'string' ? pr : (typeof pr.url === 'string' ? pr.url : (typeof pr.pr_url === 'string' ? pr.pr_url : null));
    const entries = flatUrl ? listPrEntries({ _flat: { ...(typeof pr === 'object' ? pr : {}), url: flatUrl } }) : listPrEntries(pr);
    return entries.filter(e => e.prId).map(e => {
        const raw = flatUrl ? pr : pr[e.key];
        const repo = e.key === '_flat' ? (e.repo === '_flat' ? mainRepoName() : e.repo) : e.key;
        return {
            repo, number: e.prId, url: e.url, status: e.status ? e.status.toLowerCase() : null,
            opened_at: (raw && typeof raw === 'object' && raw.opened_at) || null,
            // spec_version/spec_hash gravados pelo /commit na entrada do PR (versão usada
            // quando o PR abriu) — base da aresta PR→SpecVersion (Task 71).
            spec_version: (raw && typeof raw === 'object' && Number.isInteger(raw.spec_version)) ? raw.spec_version : null,
            spec_hash: (raw && typeof raw === 'object' && typeof raw.spec_hash === 'string') ? raw.spec_hash : null,
        };
    });
}

// files: [{ repo, path }]; redmineUrl: base do Redmine (sem barra final) ou null.
function taskFacts({ taskId, state, specExists = true, files = [], redmineUrl = null, now = new Date().toISOString() }) {
    const ticketId = ticketIdOf(taskId, state);
    if (!ticketId) return { nodes: {}, edges: [] };
    const t = ticketNodeId(ticketId);
    const rt = state?.redmine_ticket || {};
    const nodes = {
        [t]: {
            type: 'ticket', ticket_id: Number(ticketId), title: rt.subject || null, tracker: rt.tracker || null,
            redmine_url: redmineUrl ? `${String(redmineUrl).replace(/\/+$/, '')}/issues/${ticketId}` : null,
        },
    };
    const edges = [];
    if (specExists) {
        const s = specNodeId(ticketId);
        const ref = specVersion.prSpecRef(state);
        nodes[s] = { type: 'spec', task_id: t, spec_version: ref?.spec_version ?? null, spec_hash: ref?.spec_hash ?? null };
        edges.push({ from: t, rel: 'generated_spec', to: s, at: state?.started_at || now });
    }
    for (const pr of prsOf(state)) {
        const p = prNodeId(pr.repo, pr.number);
        // Sem versão na entrada do PR: a vigente do run (legado = sem atributo).
        const ref = specVersion.prSpecRef(state);
        nodes[p] = {
            type: 'pr', repo: pr.repo, number: pr.number, url: pr.url, status: pr.status,
            spec_id: ref?.spec_id ?? null, spec_version: pr.spec_version ?? ref?.spec_version ?? null, spec_hash: pr.spec_hash ?? ref?.spec_hash ?? null,
        };
        edges.push({ from: t, rel: 'opened_pr', to: p, at: pr.opened_at || now });
    }
    for (const f of files) {
        if (!isTrackedSource(f.path)) continue;
        const id = fileNodeId(f.repo, f.path);
        nodes[id] = { type: 'file', repo: f.repo, lang: path.extname(f.path).slice(1) || null };
        edges.push({ from: t, rel: 'touched_file', to: id, at: now });
    }
    return { nodes, edges };
}

// ---------------------------------------------------------------------------------
// Git: arquivos tocados na branch do ticket

function findMergeBase(cwd, base) {
    for (const ref of [`origin/${base}`, base]) {
        try { return gitLines(cwd, ['merge-base', 'HEAD', ref])[0] || null; } catch { /* próximo */ }
    }
    return null;
}

// Diff contra o merge-base (commitado + working tree) + não rastreados.
function changedFiles(cwd, base) {
    try {
        const mb = findMergeBase(cwd, base);
        if (!mb) return [];
        return [...new Set([
            ...gitLines(cwd, ['diff', '--name-only', mb]),
            ...gitLines(cwd, ['ls-files', '--others', '--exclude-standard']),
        ])].filter(isTrackedSource);
    } catch {
        return [];
    }
}

// Worktrees do ticket em app-back e nos irmãos (mesmo layout que o watcher cria).
function ticketRepos(mainRepo, ticketId) {
    const workspace = path.dirname(mainRepo);
    return [{ repo: process.env.WATCHER_MAIN_REPO_NAME || path.basename(mainRepo), dir: mainRepo }, ...SIBLING_REPOS.map(repo => ({ repo, dir: path.join(workspace, repo) }))]
        .map(r => ({ repo: r.repo, dir: path.join(r.dir, '.claude', 'worktrees', ticketId) }))
        .filter(r => fs.existsSync(r.dir));
}

function ticketFiles(mainRepo, ticketId, base) {
    return ticketRepos(mainRepo, ticketId).flatMap(r => changedFiles(r.dir, base).map(p => ({ repo: r.repo, path: p })));
}

// ---------------------------------------------------------------------------------
// Anotação @spec

function specTagLine({ ticketId, taskId, prId }) {
    const spec = ticketId ? specNodeId(ticketId) : `memory/runs/${taskId}`;
    return `// @spec ${spec} | redmine:${ticketId ? `#${ticketId}` : '-'} | pr:${prId || '-'}`;
}

// Insere a linha no topo, logo abaixo das @spec que já existirem (runs anteriores).
// Devolve o conteúdo novo, ou null se a linha já estava lá.
function insertSpecTag(content, tagLine) {
    const eol = content.includes('\r\n') ? '\r\n' : '\n';
    const bom = content.startsWith('﻿') ? '﻿' : '';
    const lines = content.slice(bom.length).split(/\r?\n/);
    let i = 0;
    while (i < lines.length && SPEC_TAG_RE.test(lines[i])) {
        if (lines[i].trim() === tagLine.trim()) return null;
        i++;
    }
    lines.splice(i, 0, tagLine);
    return bom + lines.join(eol);
}

// .java criados na branch ou com mais de SIGNIFICANT_LINES linhas (adições+remoções).
function significantJavaFiles(cwd, base) {
    const mb = findMergeBase(cwd, base);
    if (!mb) return [];
    const out = new Map();
    for (const line of gitLines(cwd, ['diff', '--numstat', mb, '--', '*.java'])) {
        const [add, del, file] = line.split('\t');
        const n = (Number(add) || 0) + (Number(del) || 0);
        let created = false;
        try { git(cwd, ['cat-file', '-e', `${mb}:${file}`]); } catch { created = true; }
        if (created || n > SIGNIFICANT_LINES) out.set(file, { file, created, lines: n });
    }
    for (const file of gitLines(cwd, ['ls-files', '--others', '--exclude-standard', '--', '*.java'])) {
        out.set(file, { file, created: true, lines: null });
    }
    return [...out.values()].filter(f => !IGNORED_FILE_RE.test(f.file));
}

function annotateTask({ mainRepo, taskId, state, dryRun = false }) {
    const ticketId = ticketIdOf(taskId, state);
    const base = state?.redmine_ticket?.base_branch || 'development';
    const prByRepo = new Map(prsOf(state).map(p => [p.repo, prNodeId(p.repo, p.number)]));
    const result = [];
    for (const r of ticketId ? ticketRepos(mainRepo, ticketId) : []) {
        const prId = prByRepo.get(r.repo);
        if (!prId) continue; // sem PR nesse repo: nada a referenciar (e nada foi pushado)
        const tag = specTagLine({ ticketId, taskId, prId });
        for (const f of significantJavaFiles(r.dir, base)) {
            const abs = path.join(r.dir, f.file);
            if (!fs.existsSync(abs)) continue; // removido na branch
            const next = insertSpecTag(fs.readFileSync(abs, 'utf8'), tag);
            if (next == null) continue;
            if (!dryRun) fs.writeFileSync(abs, next);
            result.push({ repo: r.repo, file: f.file, created: f.created, lines: f.lines, tag });
        }
    }
    return result;
}

// ---------------------------------------------------------------------------------
// Consulta

function edgesOf(graph, pred) {
    return graph.edges.filter(pred);
}

// Subgrafo de um ticket (aceita "43425", "TASK-43425" ou o task-id "43425-slug").
function subgraphForTicket(graph, idLike) {
    const ticketId = ticketIdOf(String(idLike).replace(/^TASK-/i, ''), null);
    if (!ticketId) return { nodes: {}, edges: [] };
    const t = ticketNodeId(ticketId);
    const edges = edgesOf(graph, e => e.from === t);
    const ids = new Set([t, ...edges.map(e => e.to)]);
    return { nodes: pick(graph.nodes, ids), edges };
}

// Normaliza um caminho qualquer (absoluto, de dentro de worktree, com prefixo de repo)
// pro id de nó "file".
function normalizeFilePath(p, mainRepo = null) {
    let s = String(p).replace(/\\/g, '/');
    if (mainRepo) {
        const ws = path.dirname(mainRepo).replace(/\\/g, '/') + '/';
        if (s.startsWith(ws)) s = s.slice(ws.length);
    }
    s = s.replace(/^\.\//, '');
    s = s.replace(/(^|\/)\.claude\/worktrees\/[^/]+\//, '$1');
    const prefix = `${process.env.WATCHER_MAIN_REPO_NAME || (mainRepo ? path.basename(mainRepo) : mainRepoName())}/`;
    if (s.startsWith(prefix)) s = s.slice(prefix.length);
    return s;
}

// Tickets que tocaram o arquivo, com o subgrafo de cada um.
function subgraphForFile(graph, file, mainRepo = null) {
    const id = normalizeFilePath(file, mainRepo);
    const hits = edgesOf(graph, e => e.rel === 'touched_file' && (e.to === id || e.to.endsWith(`/${id}`)));
    const out = { nodes: {}, edges: [] };
    for (const t of new Set(hits.map(e => e.from))) {
        const sub = subgraphForTicket(graph, t);
        Object.assign(out.nodes, sub.nodes);
        out.edges.push(...sub.edges);
    }
    return out;
}

function pick(obj, ids) {
    return Object.fromEntries([...ids].filter(id => obj[id]).map(id => [id, obj[id]]));
}

// ---------------------------------------------------------------------------------
// CLI

function resolveTaskDir(arg, cwd) {
    if (fs.existsSync(path.join(arg, 'state.json'))) return path.resolve(arg);
    let top = cwd;
    try { top = git(cwd, ['rev-parse', '--show-toplevel']).trim(); } catch { /* cwd */ }
    for (const d of [path.join(top, 'memory', 'runs', arg), path.join(top, 'memory', 'runs', '_archive', arg)]) {
        if (fs.existsSync(path.join(d, 'state.json'))) return d;
    }
    return null;
}

function recordTask({ taskDir, graphPath, mainRepo, redmineUrl = process.env.REDMINE_URL || null }) {
    const taskId = path.basename(taskDir);
    const state = JSON.parse(fs.readFileSync(path.join(taskDir, 'state.json'), 'utf8'));
    const ticketId = ticketIdOf(taskId, state);
    // <root>/memory/runs/[_archive/]<task> → <root> (checkout principal ou worktree).
    let root = path.resolve(taskDir);
    while (path.basename(root) !== 'memory' && path.dirname(root) !== root) root = path.dirname(root);
    root = path.dirname(root);
    const specExists = !!ticketId && [root, mainRepo].some(r => fs.existsSync(path.join(r, specNodeId(ticketId))));
    const files = ticketId ? ticketFiles(mainRepo, ticketId, state?.redmine_ticket?.base_branch || 'development') : [];
    const facts = taskFacts({ taskId, state, specExists, files, redmineUrl });
    const { changed } = updateGraph(g => mergeFacts(g, facts), graphPath);
    return { taskId, ticketId, changed, nodes: Object.keys(facts.nodes).length, files: files.length };
}

function main(argv) {
    const [cmd, arg] = argv;
    const dryRun = argv.includes('--dry-run');
    if (!['record', 'annotate'].includes(cmd) || !arg) {
        console.error('uso: knowledge-graph.js record|annotate <task-dir|task-id> [--dry-run]');
        return 2;
    }
    const cwd = process.cwd();
    const taskDir = resolveTaskDir(arg, cwd);
    if (!taskDir) { console.error(`task não encontrada: ${arg}`); return 2; }
    const mainRepo = mainRepoOf(taskDir);
    try {
        if (cmd === 'record') {
            const r = recordTask({ taskDir, graphPath: defaultGraphPath(taskDir), mainRepo });
            console.log(`[knowledge-graph] ${r.taskId}: ${r.changed ? 'atualizado' : 'sem mudança'} (${r.nodes} nó(s), ${r.files} arquivo(s)) → ${defaultGraphPath(taskDir)}`);
        } else {
            const state = JSON.parse(fs.readFileSync(path.join(taskDir, 'state.json'), 'utf8'));
            const done = annotateTask({ mainRepo, taskId: path.basename(taskDir), state, dryRun });
            for (const d of done) console.log(`${dryRun ? '[dry-run] ' : ''}${d.repo}: ${d.file} (${d.created ? 'criado' : `${d.lines} linhas`}) ← ${d.tag}`);
            if (!done.length) console.log('[knowledge-graph] nenhum .java a anotar (sem PR no repo, nada significativo, ou já anotado).');
        }
        return 0;
    } catch (e) {
        console.error(`[knowledge-graph] falha: ${e.message}`);
        return 1;
    }
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = {
    KG_VERSION, LOCK_ATTEMPTS, LOCK_INTERVAL_MS, SIGNIFICANT_LINES,
    defaultGraphPath, mainRepoOf, emptyGraph, readGraph, updateGraph, acquireLock, mergeFacts,
    ticketIdOf, ticketNodeId, specNodeId, prNodeId, fileNodeId, prsOf, taskFacts,
    isTrackedSource, changedFiles, ticketRepos, ticketFiles, significantJavaFiles,
    specTagLine, insertSpecTag, annotateTask, recordTask, resolveTaskDir,
    subgraphForTicket, subgraphForFile, normalizeFilePath, main,
};
