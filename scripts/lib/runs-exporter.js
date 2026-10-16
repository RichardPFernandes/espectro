// Exporta memory/runs/ (ativos + _archive/) como um relatório JSON agregado, pra
// permitir análise de performance/audit trail sem iteração manual (scripts/export-runs.js
// é a CLI; este módulo é a lib pura, testável sem I/O de processo).
//
// NUNCA inclui conteúdo de transcrição — só metadados (tamanho de context.md, seções
// presentes, contadores de test-results.md). Um state.json malformado (JSON inválido)
// é pulado com aviso, nunca derruba o export inteiro.
const fs = require('fs');
const path = require('path');

const ARCHIVE_DIRNAME = '_archive';
const DEFAULT_CURSOR_RELATIVE_PATH = path.join('memory', '.runs-export-cursor.json');

// Mesma convenção de scripts/lib/cycle-replayer.js: raiz do repo resolvida a partir
// deste arquivo, com override por opts.repoPath ou REPO_PATH (útil em teste/CI).
function repoPathOf(opts = {}) {
    return opts.repoPath || process.env.REPO_PATH || process.cwd();
}

function runsDirOf(opts = {}) {
    return path.join(repoPathOf(opts), 'memory', 'runs');
}

function cursorPathOf(opts = {}) {
    return opts.cursorPath || path.join(repoPathOf(opts), DEFAULT_CURSOR_RELATIVE_PATH);
}

// Extrai o id numérico do ticket (prefixo do task-id), igual cycle-replayer.ticketIdOf —
// usado só como fallback pra achar memory/runs/<ticket>-cost.json quando o state.json
// não tem cost_tracking embutido.
function ticketIdOf(taskId) {
    const m = String(taskId).match(/^(\d{4,6})-/);
    return m ? m[1] : null;
}

// Diretórios de run = subpastas de memory/runs/ (e de memory/runs/_archive/) que têm
// um state.json dentro. Arquivos soltos na raiz (*.log, *-cost.json, watcher-state.json,
// etc.) não são runs e são ignorados.
function listRunDirs(runsDir) {
    const out = [];
    const scan = (dir, archived) => {
        let entries;
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
            return;
        }
        for (const entry of entries) {
            if (!entry.isDirectory() || entry.name === ARCHIVE_DIRNAME) continue;
            const dirPath = path.join(dir, entry.name);
            if (fs.existsSync(path.join(dirPath, 'state.json'))) {
                out.push({ taskId: entry.name, dir: dirPath, archived });
            }
        }
    };
    scan(runsDir, false);
    scan(path.join(runsDir, ARCHIVE_DIRNAME), true);
    return out;
}

function readStateSafe(dir) {
    const statePath = path.join(dir, 'state.json');
    let raw;
    try {
        raw = fs.readFileSync(statePath, 'utf8');
    } catch (e) {
        return { ok: false, error: `não foi possível ler state.json: ${e.message}` };
    }
    try {
        const state = JSON.parse(raw);
        if (!state || typeof state !== 'object' || Array.isArray(state)) {
            return { ok: false, error: 'state.json não é um objeto' };
        }
        return { ok: true, state };
    } catch (e) {
        return { ok: false, error: `state.json malformado: ${e.message}` };
    }
}

// Metadados de context.md: nunca o conteúdo. Tamanho em bytes/palavras + títulos "## ".
function contextMeta(dir) {
    const contextPath = path.join(dir, 'context.md');
    let text;
    try {
        text = fs.readFileSync(contextPath, 'utf8');
    } catch {
        return null;
    }
    const sizeBytes = Buffer.byteLength(text, 'utf8');
    const wordCount = text.trim() ? text.trim().split(/\s+/).length : 0;
    const sections = [];
    for (const line of text.split('\n')) {
        const m = line.match(/^##\s+(.*\S)\s*$/);
        if (m) sections.push(m[1]);
    }
    return { sizeBytes, wordCount, sections };
}

// test-results.md ainda não é escrito por nenhum nó real (ver scripts/export-runs.js
// docstring) — convenção esperada, tolerante a variação de rótulo (PT/EN):
//   Passed: 12
//   Failed: 3
//   Total: 15
// total é opcional: se ausente, é derivado de passed+failed.
function parseTestResults(text) {
    const passedMatch = text.match(/\b(?:passed|passou|passaram|aprovad\w*)\b\D*(\d+)/i);
    const failedMatch = text.match(/\b(?:failed|falhou|falharam|reprovad\w*)\b\D*(\d+)/i);
    const totalMatch = text.match(/\btotal\b\D*(\d+)/i);
    if (!passedMatch && !failedMatch && !totalMatch) return null;
    const passed = passedMatch ? Number(passedMatch[1]) : null;
    const failed = failedMatch ? Number(failedMatch[1]) : null;
    const total = totalMatch ? Number(totalMatch[1]) : ((passed ?? 0) + (failed ?? 0)) || null;
    return { passed, failed, total };
}

function testResultMeta(dir) {
    let text;
    try {
        text = fs.readFileSync(path.join(dir, 'test-results.md'), 'utf8');
    } catch {
        return null;
    }
    return parseTestResults(text);
}

// tokenUsage de um run: prefere state.cost_tracking.totals (cópia autoritativa, ver
// schema); sem isso, tenta o fallback memory/runs/<ticket>-cost.json (formato usado
// hoje pelo watcher — tasks[taskId].totals). null se nenhuma fonte existir.
function tokenUsageOf(state, taskId, runsDir) {
    const fromEmbedded = state.cost_tracking && state.cost_tracking.totals;
    if (fromEmbedded) return normalizeTotals(fromEmbedded);

    const ticketId = ticketIdOf(taskId);
    if (!ticketId) return null;
    const costPath = path.join(runsDir, `${ticketId}-cost.json`);
    let costRaw;
    try {
        costRaw = JSON.parse(fs.readFileSync(costPath, 'utf8'));
    } catch {
        return null;
    }
    const totals = costRaw?.tasks?.[taskId]?.totals;
    return totals ? normalizeTotals(totals) : null;
}

function normalizeTotals(totals) {
    return {
        totals: {
            inputTokens: totals.input_tokens ?? null,
            outputTokens: totals.output_tokens ?? null,
            durationMs: totals.duration_ms ?? null,
        },
    };
}

const TERMINAL_STATUSES = new Set(['committed', 'fully_merged', 'completed', 'handed_back_qa']);
// Portões/paradas do watcher que representam falha/bloqueio de um nó — ver descrições
// completas em .graph/schemas/state.schema.json > status.
const FAILURE_STATUSES = new Set([
    'blocked', 'escalated', 'needs_human_review', 'state_corrupted',
    'spec-invalid', 'spec-pending-approval', 'plan-escalation', 'churn-escalation',
    'pre-build-failed', 'churn-escalation', 'interrupted', 'authorization-pending',
]);

function durationMsOf(state, tokenUsage) {
    if (tokenUsage?.totals?.durationMs != null) return tokenUsage.totals.durationMs;
    const start = state.started_at ? Date.parse(state.started_at) : NaN;
    const end = state.updated_at ? Date.parse(state.updated_at) : NaN;
    if (Number.isNaN(start) || Number.isNaN(end)) return null;
    return end - start;
}

function buildRunEntry(entry, runsDir) {
    const { taskId, dir, archived } = entry;
    const read = readStateSafe(dir);
    if (!read.ok) return { ok: false, taskId, warning: read.error };

    const { state } = read;
    const tokenUsage = tokenUsageOf(state, taskId, runsDir);
    const run = {
        taskId,
        archived,
        node: state.node ?? null,
        status: state.status ?? null,
        startedAt: state.started_at ?? null,
        completedAt: TERMINAL_STATUSES.has(state.status) ? (state.updated_at ?? null) : null,
        durationMs: durationMsOf(state, tokenUsage),
        tokenUsage,
        nodeCount: Array.isArray(state.history) ? state.history.length : 0,
        replayOf: state.replayOf ?? null,
        contextMeta: contextMeta(dir),
        testResult: testResultMeta(dir),
    };
    return { ok: true, run };
}

function summarize(runs) {
    const totalRuns = runs.length;
    const completed = runs.filter(r => r.status === 'completed').length;
    const successRate = totalRuns ? completed / totalRuns : 0;

    const failuresByNode = {};
    for (const r of runs) {
        if (!FAILURE_STATUSES.has(r.status)) continue;
        const key = r.node || '(desconhecido)';
        failuresByNode[key] = (failuresByNode[key] || 0) + 1;
    }

    const withTokens = runs.filter(r => r.tokenUsage?.totals);
    const avgTokensPerCycle = withTokens.length
        ? withTokens.reduce((sum, r) => sum + (r.tokenUsage.totals.inputTokens || 0) + (r.tokenUsage.totals.outputTokens || 0), 0) / withTokens.length
        : 0;

    return { totalRuns, successRate, avgTokensPerCycle, failuresByNode };
}

function readCursor(opts) {
    try {
        return JSON.parse(fs.readFileSync(cursorPathOf(opts), 'utf8'));
    } catch {
        return null;
    }
}

function writeCursor(opts, exportedAt) {
    const cursorPath = cursorPathOf(opts);
    fs.mkdirSync(path.dirname(cursorPath), { recursive: true });
    fs.writeFileSync(cursorPath, JSON.stringify({ lastExportAt: exportedAt }, null, 2));
}

// Modificação real do run: maior entre mtime de state.json e de context.md (cobre
// runs cujo state.json não mudou desde o export mas ganharam progresso no context).
function runModifiedAt(dir) {
    let latest = 0;
    for (const name of ['state.json', 'context.md']) {
        try {
            const mtime = fs.statSync(path.join(dir, name)).mtimeMs;
            if (mtime > latest) latest = mtime;
        } catch { /* arquivo ausente não conta */ }
    }
    return latest;
}

async function exportRuns(options = {}) {
    const runsDir = runsDirOf(options);
    const warnings = [];

    let sinceMs = null;
    if (options.since) {
        const parsed = Date.parse(options.since);
        if (Number.isNaN(parsed)) throw new Error(`--since inválido: "${options.since}" não é uma data`);
        sinceMs = parsed;
    }

    let cursorMs = null;
    if (options.incremental) {
        const cursor = readCursor(options);
        if (cursor?.lastExportAt) {
            const parsed = Date.parse(cursor.lastExportAt);
            if (!Number.isNaN(parsed)) cursorMs = parsed;
        }
    }

    const dirs = listRunDirs(runsDir);
    const runs = [];
    for (const entry of dirs) {
        // Piso em milissegundo inteiro: cursorMs vem de um ISO string (resolução de 1ms),
        // então comparar contra um mtime com fração de ms sub-tick pode achar "mais novo"
        // um arquivo escrito bem antes do cursor, só por ruído de resolução do filesystem.
        if (cursorMs != null && Math.floor(runModifiedAt(entry.dir)) <= cursorMs) continue;

        const result = buildRunEntry(entry, runsDir);
        if (!result.ok) {
            warnings.push(`${result.taskId}: ${result.warning}`);
            continue;
        }
        if (sinceMs != null) {
            const startedMs = result.run.startedAt ? Date.parse(result.run.startedAt) : NaN;
            if (Number.isNaN(startedMs) || startedMs < sinceMs) continue;
        }
        runs.push(result.run);
    }

    runs.sort((a, b) => (Date.parse(b.startedAt) || 0) - (Date.parse(a.startedAt) || 0));

    // Capturado só agora (depois de ler todos os state.json/context.md), nunca antes do
    // scan: um cursor carimbado no início da função pode, por causa de resolução
    // sub-milissegundo do mtime do filesystem, acabar MENOR que o mtime de um arquivo
    // lido durante o próprio scan — o próximo --incremental reexportaria esse run à toa.
    const exportedAt = new Date().toISOString();
    const report = {
        exportedAt,
        version: 1,
        environment: {
            nodeVersion: process.version,
            platform: process.platform,
            generatedBy: 'scripts/export-runs.js',
        },
        summary: summarize(runs),
        runs,
    };

    if (options.incremental) writeCursor(options, exportedAt);

    return { report, warnings };
}

module.exports = {
    exportRuns,
    listRunDirs,
    readStateSafe,
    contextMeta,
    parseTestResults,
    testResultMeta,
    summarize,
    repoPathOf,
    runsDirOf,
    cursorPathOf,
};
