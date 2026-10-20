// Detecção de churn de implementação: o mesmo arquivo modificado N vezes em rodadas
// diferentes do ciclo (review/test reprovando → re-implement em loop) sem convergir.
// Normalmente é conflito estrutural entre a spec e o código existente que ninguém
// detectou — mais uma rodada só gasta tokens. Quem integra no fluxo é o watcher
// (readmine-watcher.js > runChurnGate); este módulo só grava snapshots e conta.
//
// O /implement não commita (quem commita é o /commit, no fim), então o histórico
// da branch não mostra as rodadas. Por isso o watcher grava, antes de cada
// re-implement, um commit-snapshot do worktree numa ref privada da task:
//   refs/churn/<taskId>/start   — âncora: worktree logo antes do 1º implement do ciclo
//   refs/churn/<taskId>/rounds  — 1 commit por rodada que mudou algo (pai = rodada anterior)
// Os snapshots usam um índice temporário (GIT_INDEX_FILE) e commit-tree: não mexem
// na branch, no índice nem no working tree do agente, e refs/churn/* nunca vão pro
// remoto (push de branch/--tags não as leva). O retry de Recusa QA reabre o MESMO
// task-id, então o watcher chama resetCycle ao reabrir: senão as rodadas do ciclo
// aprovado (e a diferença do /commit, ex. a anotação @spec) contam como churn do novo.
//
// detectChurn roda `git log --name-only <anchor>..<head>` e conta em quantos commits
// cada arquivo aparece. Arquivo de teste tem threshold dobrado (churn em teste é mais
// tolerável — o teste acompanha o código que mudou).
//
// Uso manual: node scripts/lib/churn-detector.js <worktree> [<anchor> [<head>]]
const { execFile, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DEFAULT_THRESHOLD = 3;
const MAX_COMMITS_PER_FILE = 10;
const MAX_BUFFER = 64 * 1024 * 1024;
const RECORD_SEP = '\x1e';
// Nunca é mudança do agente: memory/ é local (linkada no worktree) e .DS_Store é do Finder.
const IGNORED = [/^memory\//, /(^|\/)\.DS_Store$/];
const TEST_FILE = /(Tests?|IT)\.java$|Spec\.js$|\.(spec|test)\.[cm]?[jt]sx?$/;
const SNAPSHOT_IDENTITY = {
    GIT_AUTHOR_NAME: 'graph-watcher', GIT_AUTHOR_EMAIL: 'watcher@graph.local',
    GIT_COMMITTER_NAME: 'graph-watcher', GIT_COMMITTER_EMAIL: 'watcher@graph.local',
};

// CHURN_THRESHOLD sobrescreve o padrão (3). Valor inválido (< 2 não é churn) cai no padrão.
function resolveThreshold(env = process.env) {
    const n = Number(env.CHURN_THRESHOLD);
    return Number.isInteger(n) && n >= 2 ? n : DEFAULT_THRESHOLD;
}

function isTestFile(file) {
    return TEST_FILE.test(file);
}

function thresholdFor(file, threshold) {
    return isTestFile(file) ? threshold * 2 : threshold;
}

function anchorRef(taskId) { return `refs/churn/${taskId}/start`; }
function roundsRef(taskId) { return `refs/churn/${taskId}/rounds`; }

function git(cwd, args, env = {}) {
    return execFileSync('git', ['-c', 'core.quotePath=false', ...args], {
        cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...env }, maxBuffer: MAX_BUFFER,
    }).trim();
}

function gitAsync(cwd, args) {
    return new Promise((resolve, reject) => {
        execFile('git', ['-c', 'core.quotePath=false', ...args], { cwd, encoding: 'utf8', maxBuffer: MAX_BUFFER },
            (err, stdout) => (err ? reject(err) : resolve(stdout)));
    });
}

function resolveRef(cwd, ref) {
    try { return git(cwd, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]) || null; } catch { return null; }
}

function isGitWorktree(dir) {
    try { return git(dir, ['rev-parse', '--is-inside-work-tree']) === 'true'; } catch { return false; }
}

// Saída de `git log --name-only --format=<RS>%h %s` → [{ sha, subject, files }].
// O separador de registro evita confundir a linha do commit com um nome de arquivo
// (o formato --oneline puro é ambíguo pra isso).
function parseLog(output) {
    return String(output || '').split(RECORD_SEP).map(chunk => chunk.split('\n').map(l => l.trim()).filter(Boolean))
        .filter(lines => lines.length)
        .map(([header, ...files]) => {
            const sp = header.indexOf(' ');
            return {
                sha: sp === -1 ? header : header.slice(0, sp),
                subject: sp === -1 ? '' : header.slice(sp + 1),
                files: [...new Set(files)].filter(f => !IGNORED.some(re => re.test(f))),
            };
        });
}

// Conta, por arquivo, em quantos commits de anchor..head ele aparece. Devolve
// { churnDetected, files: ChurnFile[], counts, commitsAnalyzed, threshold } com
// ChurnFile = { path, modificationCount, commits: ["<sha> <mensagem>", ...] (mais
// recente primeiro), threshold }. Sem anchor, conta o histórico inteiro de head.
// baseline {path: n}: contagens já aceitas por humano — só o que passou delas conta.
async function detectChurn(worktreePath, threshold = resolveThreshold(), { anchor = null, head = 'HEAD', baseline = {} } = {}) {
    const limit = Number.isInteger(threshold) && threshold >= 2 ? threshold : resolveThreshold();
    const range = anchor ? [head, `^${anchor}`] : [head];
    const out = await gitAsync(worktreePath, ['log', '--no-merges', '--name-only', `--format=${RECORD_SEP}%h %s`, ...range, '--']);
    const commits = parseLog(out);
    const byFile = new Map();
    for (const c of commits) {
        for (const f of c.files) {
            if (!byFile.has(f)) byFile.set(f, []);
            byFile.get(f).push(`${c.sha} ${c.subject}`.trim());
        }
    }
    const counts = {};
    const files = [];
    for (const [file, list] of byFile) {
        counts[file] = list.length;
        const fileThreshold = thresholdFor(file, limit);
        const accepted = Number(baseline?.[file]) || 0;
        if (list.length - accepted >= fileThreshold) {
            files.push({ path: file, modificationCount: list.length, commits: list.slice(0, MAX_COMMITS_PER_FILE), threshold: fileThreshold });
        }
    }
    files.sort((a, b) => b.modificationCount - a.modificationCount || a.path.localeCompare(b.path));
    return { churnDetected: files.length > 0, files, counts, commitsAnalyzed: commits.length, threshold: limit };
}

// Tree do worktree inteiro como está agora (tracked + untracked não ignorados),
// montada num índice temporário — o índice real do worktree fica intocado.
function snapshotTree(worktreePath) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'churn-index-'));
    const env = { GIT_INDEX_FILE: path.join(tmp, 'index') };
    try {
        if (resolveRef(worktreePath, 'HEAD')) git(worktreePath, ['read-tree', 'HEAD'], env);
        git(worktreePath, ['add', '-A', '--', '.'], env);
        return git(worktreePath, ['write-tree'], env);
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
}

function commitTree(worktreePath, tree, parent, message) {
    const args = ['commit-tree', tree, ...(parent ? ['-p', parent] : []), '-m', message];
    return git(worktreePath, args, SNAPSHOT_IDENTITY);
}

// Âncora do ciclo: grava refs/churn/<taskId>/start se ainda não existir. Devolve o sha
// (novo ou já existente) ou null se o diretório não for um worktree git.
function ensureAnchor(worktreePath, taskId) {
    if (!isGitWorktree(worktreePath)) return null;
    const ref = anchorRef(taskId);
    const existing = resolveRef(worktreePath, ref);
    if (existing) return existing;
    const sha = commitTree(worktreePath, snapshotTree(worktreePath), resolveRef(worktreePath, 'HEAD'), `churn: início do ciclo — task ${taskId}`);
    git(worktreePath, ['update-ref', ref, sha]);
    return sha;
}

// Snapshot de uma rodada em refs/churn/<taskId>/rounds. Idempotente: se o worktree não
// mudou desde a última rodada (ou desde a âncora), não grava nada e devolve null.
function recordRound(worktreePath, taskId, message) {
    const anchor = resolveRef(worktreePath, anchorRef(taskId));
    if (!anchor) return null;
    const parent = resolveRef(worktreePath, roundsRef(taskId)) || anchor;
    const tree = snapshotTree(worktreePath);
    if (tree === git(worktreePath, ['rev-parse', `${parent}^{tree}`])) return null;
    const sha = commitTree(worktreePath, tree, parent, message);
    git(worktreePath, ['update-ref', roundsRef(taskId), sha]);
    return sha;
}

// Começa um ciclo novo pra task: apaga âncora e rodadas. O próximo portão grava a
// âncora a partir do worktree atual. Devolve quantas refs apagou.
function resetCycle(worktreePath, taskId) {
    if (!isGitWorktree(worktreePath)) return 0;
    let removed = 0;
    for (const ref of [anchorRef(taskId), roundsRef(taskId)]) {
        if (!resolveRef(worktreePath, ref)) continue;
        git(worktreePath, ['update-ref', '-d', ref]);
        removed++;
    }
    return removed;
}

module.exports = {
    DEFAULT_THRESHOLD, resolveThreshold, isTestFile, thresholdFor,
    anchorRef, roundsRef, resolveRef, isGitWorktree,
    parseLog, detectChurn, ensureAnchor, recordRound, resetCycle,
};

if (require.main === module) {
    const [worktree, anchor, head] = process.argv.slice(2);
    if (!worktree) {
        console.error('uso: node scripts/lib/churn-detector.js <worktree> [<anchor> [<head>]]');
        process.exit(2);
    }
    detectChurn(worktree, resolveThreshold(), { anchor: anchor || null, head: head || 'HEAD' })
        .then(r => { console.log(JSON.stringify(r, null, 2)); process.exit(r.churnDetected ? 1 : 0); })
        .catch(e => { console.error(e.message); process.exit(2); });
}
