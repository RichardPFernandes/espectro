// Comparação de dois runs da mesma task lado a lado (scripts/compare-runs.js é a CLI;
// GET /api/compare/:taskIdA/:taskIdB no dashboard usa a mesma lib). Caso típico: o run
// original contra o replay (<task-id>-replay-<n>) ou contra um novo ciclo depois de
// ajustar a spec — o que mudou no state, no consumo de tokens por nó, nos nós visitados,
// no resultado dos testes e no score do plano.
//
// Somente leitura: este módulo só faz readFileSync/readdirSync/statSync. Nunca escreve,
// renomeia ou toca mtime de nada em memory/.
//
// Tolerante a schema: state.json de épocas diferentes tem campos diferentes (cost_tracking,
// planScore e test_result estruturado só existem em runs mais novos). Todo campo ausente
// vira N/A — nada aqui lança por falta de campo; state.json ilegível vira run sem state
// (tudo N/A), com o erro em readError.
const fs = require('fs');
const path = require('path');

const NA = 'N/A';
// Acima disso (em módulo), a diferença de tokens/custo/duração é "significativa": pinta
// no texto/dashboard e decide o veredito quando status e testes empatam.
const SIGNIFICANT_PCT = 20;
const GRAPH_ORDER = ['fetch_ticket', 'plan', 'implement', 'review', 'test', 'verify', 'commit', 'escalated'];

// Mesmos grupos do cycle-replayer/cleanup-runs: sucesso = ciclo entregue; falha = parou
// esperando humano ou quebrado. O resto (in_progress, running, planned...) é neutro.
const SUCCESS_STATUSES = new Set(['committed', 'fully_merged', 'completed']);
const FAILURE_STATUSES = new Set(['escalated', 'blocked', 'state_corrupted', 'spec-invalid', 'pre-build-failed',
    'plan-escalation', 'churn-escalation', 'needs_human_review']);

// Fora do stateDiff: logs volumosos (cada evento viraria uma linha) e cost_tracking, que
// já tem seção própria (tokenDiff).
const STATE_DIFF_IGNORED = ['cost_tracking', 'events', 'agent_log', 'human_inputs', 'transcripts'];
// Objetos são achatados em caminhos pontuados até esta profundidade (test_result.result,
// pull_request.url...); abaixo disso, e arrays, comparam por valor inteiro.
const STATE_DIFF_DEPTH = 3;

const TASK_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
// Arquivo de state dentro do diretório do run: o state.json ou o registro de um replay
// (state-replay-<replay-task-id>.json, gravado pelo cycle-replayer ao lado do original).
const STATE_FILE_RE = /^state(?:-replay-[A-Za-z0-9._-]+)?\.json$/;

class RunNotFoundError extends Error {
    constructor(message, code = 'not_found') {
        super(message);
        this.code = code;
    }
}

// ---------------------------------------------------------------------------------
// Localização / leitura (read-only)

function repoPathOf(opts = {}) {
    return opts.repoPath || process.env.REPO_PATH || process.cwd();
}

// "task-42" -> { taskId: 'task-42', file: 'state.json' }
// "task-42/state-replay-1234.json" -> { taskId: 'task-42', file: 'state-replay-1234.json' }
function parseRunRef(ref) {
    const raw = String(ref ?? '').trim().replace(/\\/g, '/');
    const [taskId, file = 'state.json', ...rest] = raw.split('/');
    if (rest.length || !TASK_ID_RE.test(taskId) || taskId.startsWith('_')) {
        throw new RunNotFoundError(`id de run inválido: "${ref}" — use <task-id> ou <task-id>/state-replay-<id>.json`, 'invalid_ref');
    }
    if (!STATE_FILE_RE.test(file)) {
        throw new RunNotFoundError(`arquivo inválido em "${ref}": só state.json ou state-replay-<id>.json`, 'invalid_ref');
    }
    return { ref: file === 'state.json' ? taskId : `${taskId}/${file}`, taskId, file };
}

function isDir(p) {
    try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

function listDirs(p) {
    try { return fs.readdirSync(p, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name); } catch { return []; }
}

// Onde um run pode estar (ver CLAUDE.md > "Runs ativos e arquivados"): memory/runs e
// _archive do checkout principal e de cada worktree, e memory/archive/<YYYY-MM>/ (só no
// principal).
function runRoots(repoPath) {
    const roots = [];
    const addRunsDir = (dir, label, worktree = null) => {
        roots.push({ dir, label, worktree });
        roots.push({ dir: path.join(dir, '_archive'), label: `${label}/_archive`, worktree });
    };
    addRunsDir(path.join(repoPath, 'memory', 'runs'), 'main');
    const wtBase = path.join(repoPath, '.claude', 'worktrees');
    for (const name of listDirs(wtBase)) addRunsDir(path.join(wtBase, name, 'memory', 'runs'), `worktree:${name}`, name);
    const archiveBase = path.join(repoPath, 'memory', 'archive');
    for (const month of listDirs(archiveBase)) roots.push({ dir: path.join(archiveBase, month), label: `archive/${month}`, worktree: null });
    return roots;
}

function readJsonSafe(file) {
    let raw;
    try { raw = fs.readFileSync(file, 'utf8'); } catch (e) { return { ok: false, error: `não foi possível ler ${path.basename(file)}: ${e.message}` }; }
    try {
        const value = JSON.parse(raw);
        if (!value || typeof value !== 'object' || Array.isArray(value)) return { ok: false, error: `${path.basename(file)} não é um objeto` };
        return { ok: true, value };
    } catch (e) {
        return { ok: false, error: `${path.basename(file)} malformado: ${e.message}` };
    }
}

function stateTime(state) {
    return Date.parse(state?.updated_at || state?.started_at || '') || 0;
}

// Resolve o diretório do run. Com várias cópias (worktrees carregam cópias legadas de
// memory/runs), mesma regra do dashboard: a do worktree do ticket, senão a mais recente.
function locateRun(ref, opts = {}) {
    const parsed = parseRunRef(ref);
    const repoPath = repoPathOf(opts);
    const candidates = [];
    for (const root of runRoots(repoPath)) {
        const dir = path.join(root.dir, parsed.taskId);
        if (isDir(dir) && fs.existsSync(path.join(dir, parsed.file))) candidates.push({ ...root, runDir: dir });
    }
    if (!candidates.length) {
        throw new RunNotFoundError(`run não encontrado: ${parsed.ref} (procurado em memory/runs, _archive, worktrees e memory/archive de ${repoPath})`);
    }
    const ticket = (parsed.taskId.match(/^(\d{4,6})-/) || [])[1];
    let chosen = ticket && candidates.find(c => c.worktree === ticket);
    if (!chosen) {
        chosen = candidates
            .map(c => ({ c, t: stateTime(readJsonSafe(path.join(c.runDir, parsed.file)).value) }))
            .sort((x, y) => y.t - x.t)[0].c;
    }
    return { ...parsed, dir: chosen.runDir, source: chosen.label, repoPath, copies: candidates.length };
}

// Cópia autoritativa de custo: memory/runs/<ticket>-cost.json (checkout principal), por
// task-id. Só usada quando o state não tem cost_tracking embutido (runs antigos).
function costFallback(taskId, repoPath) {
    const ticket = (String(taskId).match(/^(\d{4,6})-/) || [])[1];
    if (!ticket || !repoPath) return null;
    const r = readJsonSafe(path.join(repoPath, 'memory', 'runs', `${ticket}-cost.json`));
    const entry = r.ok ? r.value.tasks?.[taskId] : null;
    return entry && typeof entry === 'object' ? entry : null;
}

// Run pronto pra comparar a partir de um diretório conhecido (o dashboard resolve o
// diretório pelas regras dele e entra por aqui).
function loadRunFromDir(dir, { ref, taskId, file = 'state.json', source = null, repoPath = null } = {}) {
    const id = taskId || path.basename(dir);
    const r = readJsonSafe(path.join(dir, file));
    const state = r.ok ? r.value : null;
    const costTaskId = file === 'state.json' ? id : state?.task_id;
    const cost = state && !isObj(state.cost_tracking) ? costFallback(costTaskId, repoPath) : null;
    return {
        ref: ref || (file === 'state.json' ? id : `${id}/${file}`),
        taskId: id,
        file,
        dir,
        source,
        state,
        readError: r.ok ? null : r.error,
        costSource: isObj(state?.cost_tracking) ? 'state.json' : cost ? `${(id.match(/^(\d{4,6})-/) || [])[1]}-cost.json` : null,
        cost_tracking: isObj(state?.cost_tracking) ? state.cost_tracking : cost,
    };
}

function loadRun(ref, opts = {}) {
    const loc = locateRun(ref, opts);
    return loadRunFromDir(loc.dir, { ...loc, repoPath: loc.repoPath });
}

// ---------------------------------------------------------------------------------
// Normalização (pura)

function isObj(v) {
    return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function num(v) {
    return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

// Aceita o objeto de loadRun ({ state, cost_tracking, ... }) ou um state cru.
function normalizeRun(run, label) {
    if (isObj(run) && ('state' in run || 'readError' in run) && !('status' in run)) {
        const state = isObj(run.state) ? run.state : null;
        return { ...run, label, state, cost_tracking: isObj(run.cost_tracking) ? run.cost_tracking : isObj(state?.cost_tracking) ? state.cost_tracking : null };
    }
    const state = isObj(run) ? run : null;
    return { ref: state?.task_id || label, taskId: state?.task_id || null, label, state, readError: state ? null : 'state ausente', cost_tracking: isObj(state?.cost_tracking) ? state.cost_tracking : null };
}

function statusOutcome(status) {
    if (typeof status !== 'string' || !status) return 'unknown';
    if (SUCCESS_STATUSES.has(status)) return 'success';
    if (FAILURE_STATUSES.has(status)) return 'failure';
    return 'in_progress';
}
const OUTCOME_RANK = { success: 2, in_progress: 1, unknown: 1, failure: 0 };

// test_result é texto livre ou objeto ({ result: 'passou', total, failures, errors, missing, ... }).
// Resultado parcial (missing > 0 ou texto PARTIAL/parcial/incompleto) nunca vira passed:
// sem falha observada fica N/A (partial: true); falha observada continua failed.
function testOutcome(value) {
    if (value === undefined || value === null || value === '') return { outcome: NA, summary: NA, total: null, failures: null, missing: null, partial: false };
    const obj = isObj(value) ? value : null;
    const text = obj ? [obj.result, obj.status, obj.verdict, obj.outcome].find(x => typeof x === 'string') : typeof value === 'string' ? value : null;
    const total = num(obj?.total);
    const failures = num(obj?.failures) !== null || num(obj?.errors) !== null ? (num(obj?.failures) || 0) + (num(obj?.errors) || 0) : null;
    const missing = num(obj?.missing);
    const partial = (missing !== null && missing > 0) || Boolean(text && /partial|parcial|incomplet/i.test(text));
    let outcome = NA;
    if (typeof obj?.passed === 'boolean') outcome = obj.passed ? 'passed' : 'failed';
    else if (text && /falh|fail|reprov|erro|error|quebr|vermelh|\bred\b/i.test(text)) outcome = 'failed';
    else if (text && /pass|aprov|\bok\b|success|sucesso|verde|green/i.test(text)) outcome = 'passed';
    else if (failures !== null) outcome = failures > 0 ? 'failed' : 'passed';
    if (partial && outcome === 'passed') outcome = NA;
    const summary = text || (outcome !== NA ? outcome : typeof value === 'string' ? value : NA);
    const counts = `${failures ? `, ${failures} falhas` : ''}${missing ? `, ${missing} faltando` : ''}`;
    return { outcome, summary: total !== null ? `${summary} (${total} testes${counts})` : summary, total, failures, missing, partial };
}
const TEST_RANK = { passed: 2, [NA]: 1, failed: 0 };

function nodeTokens(n) {
    if (!isObj(n)) return null;
    const i = num(n.input_tokens), o = num(n.output_tokens);
    return i === null && o === null ? null : (i || 0) + (o || 0);
}

function costNodes(ct) {
    return isObj(ct?.nodes) ? ct.nodes : {};
}

function totalTokens(ct) {
    if (!isObj(ct)) return null;
    const t = ct.totals;
    const fromTotals = isObj(t) && (num(t.input_tokens) !== null || num(t.output_tokens) !== null) ? (num(t.input_tokens) || 0) + (num(t.output_tokens) || 0) : null;
    if (fromTotals !== null) return fromTotals;
    const vals = Object.values(costNodes(ct)).map(nodeTokens).filter(v => v !== null);
    return vals.length ? vals.reduce((a, b) => a + b, 0) : null;
}

function totalOf(ct, field) {
    if (!isObj(ct)) return null;
    if (num(ct.totals?.[field]) !== null) return ct.totals[field];
    const vals = Object.values(costNodes(ct)).map(n => num(n?.[field])).filter(v => v !== null);
    return vals.length ? vals.reduce((a, b) => a + b, 0) : null;
}

// Soma parcial sinalizada pelo cost-tracking: runs_without_cost (custo) e
// runs_without_tokens (tokens) por nó. null = sem cost_tracking.
function runsWithout(ct, field) {
    if (!isObj(ct)) return null;
    return Object.values(costNodes(ct)).reduce((sum, n) => sum + (num(n?.[field]) || 0), 0);
}

function retriesTotal(state) {
    if (!isObj(state?.retries)) return null;
    const vals = Object.values(state.retries).map(num).filter(v => v !== null);
    return vals.length ? vals.reduce((a, b) => a + b, 0) : null;
}

function pctDelta(a, b) {
    if (a === null || b === null) return null;
    if (a === 0) return b === 0 ? 0 : null;
    return Math.round(((b - a) / a) * 1000) / 10;
}

function round(v, digits = 6) {
    return v === null ? null : Math.round(v * 10 ** digits) / 10 ** digits;
}

const orderNodes = nodes => [...nodes].sort((x, y) => {
    const ix = GRAPH_ORDER.indexOf(x), iy = GRAPH_ORDER.indexOf(y);
    return (ix === -1 ? 99 : ix) - (iy === -1 ? 99 : iy) || x.localeCompare(y);
});

// ---------------------------------------------------------------------------------
// Seções

function flatten(value, prefix, depth, out) {
    if (isObj(value) && depth < STATE_DIFF_DEPTH && Object.keys(value).length) {
        for (const [k, v] of Object.entries(value)) flatten(v, prefix ? `${prefix}.${k}` : k, depth + 1, out);
    } else {
        out[prefix] = value;
    }
    return out;
}

function sameValue(a, b) {
    return JSON.stringify(a) === JSON.stringify(b);
}

function diffState(stateA, stateB) {
    const strip = s => {
        if (!isObj(s)) return {};
        const copy = { ...s };
        for (const k of STATE_DIFF_IGNORED) delete copy[k];
        return copy;
    };
    const fa = flatten(strip(stateA), '', 0, {});
    const fb = flatten(strip(stateB), '', 0, {});
    const keys = [...new Set([...Object.keys(fa), ...Object.keys(fb)])].sort();
    const out = [];
    for (const key of keys) {
        const inA = key in fa, inB = key in fb;
        if (inA && inB && sameValue(fa[key], fb[key])) continue;
        out.push({
            key,
            a: inA ? fa[key] : NA,
            b: inB ? fb[key] : NA,
            change: !inA ? 'added' : !inB ? 'removed' : 'changed',
        });
    }
    return out;
}

function diffTokens(ctA, ctB) {
    const na = costNodes(ctA), nb = costNodes(ctB);
    const nodes = orderNodes(new Set([...Object.keys(na), ...Object.keys(nb)]));
    const row = (a, b) => {
        const deltaPct = pctDelta(a, b);
        return {
            a: a ?? NA,
            b: b ?? NA,
            delta: a !== null && b !== null ? b - a : NA,
            deltaPct: deltaPct ?? NA,
            significant: deltaPct !== null && Math.abs(deltaPct) > SIGNIFICANT_PCT,
        };
    };
    return {
        available: { a: isObj(ctA), b: isObj(ctB) },
        nodes: nodes.map(node => ({ node, ...row(nodeTokens(na[node]), nodeTokens(nb[node])) })),
        total: row(totalTokens(ctA), totalTokens(ctB)),
    };
}

// Nós executados: history (com repetições = loops) ∪ nós com custo registrado ∪
// also_covers (o plan cobre o fetch_ticket quando rodam na mesma sessão).
function executedNodes(state, ct) {
    const counts = {};
    const history = Array.isArray(state?.history) ? state.history.filter(x => typeof x === 'string') : [];
    for (const n of history) counts[n] = (counts[n] || 0) + 1;
    for (const [n, v] of Object.entries(costNodes(ct))) {
        if (!(n in counts)) counts[n] = num(v?.runs) ?? 1;
        for (const c of Array.isArray(v?.also_covers) ? v.also_covers : []) if (typeof c === 'string' && !(c in counts)) counts[c] = 1;
    }
    return counts;
}

// Provider de cada tentativa gravada no cost_tracking (attempts[].provider); UNKNOWN fica fora.
function nodeProviders(n) {
    const out = new Set();
    for (const at of Array.isArray(n?.attempts) ? n.attempts : []) {
        if (typeof at?.provider === 'string' && at.provider && at.provider !== 'UNKNOWN') out.add(at.provider);
    }
    return [...out].sort();
}

// Detalhe de um nó num run (tela Comparar runs): modelos, provider, duração, custo e tokens
// do cost_tracking; execuções do history. null = o nó não executou nesse run. Campo sem
// medição fica null (a tela mostra N/A com o motivo), nunca 0.
function nodeDetail(execs, n, coveredBy = null) {
    if (!execs) return null;
    const known = isObj(n);
    return {
        coveredBy: known ? null : coveredBy,
        executions: execs,
        models: known && Array.isArray(n.models) ? n.models.filter(m => typeof m === 'string' && m) : [],
        providers: known ? nodeProviders(n) : [],
        durationMs: known ? num(n.duration_ms) : null,
        costUsd: known ? num(n.cost_usd) : null,
        tokens: known ? nodeTokens(n) : null,
        runsWithoutCost: known ? num(n.runs_without_cost) || 0 : null,
        runsWithoutTokens: known ? num(n.runs_without_tokens) || 0 : null,
        tracked: known,
    };
}

function diffNodes(runA, runB) {
    const ca = executedNodes(runA.state, runA.cost_tracking);
    const cb = executedNodes(runB.state, runB.cost_tracking);
    const all = orderNodes(new Set([...Object.keys(ca), ...Object.keys(cb)]));
    const na = costNodes(runA.cost_tracking), nb = costNodes(runB.cost_tracking);
    // also_covers: o nó rodou na sessão de outro (fetch_ticket dentro do plan); custo e tokens estão lá.
    const coverOf = (nodes, node) => Object.keys(nodes).find(k => Array.isArray(nodes[k]?.also_covers) && nodes[k].also_covers.includes(node)) || null;
    return {
        detail: Object.fromEntries(all.map(n => [n, { a: nodeDetail(ca[n], na[n], coverOf(na, n)), b: nodeDetail(cb[n], nb[n], coverOf(nb, n)) }])),
        onlyInA: all.filter(n => n in ca && !(n in cb)),
        onlyInB: all.filter(n => n in cb && !(n in ca)),
        both: all.filter(n => n in ca && n in cb),
        executions: Object.fromEntries(all.map(n => [n, { a: ca[n] ?? 0, b: cb[n] ?? 0 }])),
        historyA: Array.isArray(runA.state?.history) ? runA.state.history : NA,
        historyB: Array.isArray(runB.state?.history) ? runB.state.history : NA,
    };
}

function diffTests(stateA, stateB) {
    const a = testOutcome(stateA?.test_result);
    const b = testOutcome(stateB?.test_result);
    let direction = null;
    if (a.outcome === 'passed' && b.outcome === 'failed') direction = 'regressed';
    else if (a.outcome === 'failed' && b.outcome === 'passed') direction = 'fixed';
    return { a, b, changed: a.outcome !== b.outcome, direction };
}

function diffPlanScore(stateA, stateB) {
    const a = num(stateA?.planScore), b = num(stateB?.planScore);
    if (a === null && b === null) return null;
    return {
        a: a ?? NA,
        b: b ?? NA,
        delta: a !== null && b !== null ? round(b - a, 2) : NA,
        thresholdA: num(stateA?.planScoreThreshold) ?? NA,
        thresholdB: num(stateB?.planScoreThreshold) ?? NA,
        attemptsA: num(stateA?.planAttempts) ?? NA,
        attemptsB: num(stateB?.planAttempts) ?? NA,
    };
}

// Linhas da tabela Métrica | Run A | Run B | Delta. better: qual lado é melhor naquela
// métrica ('A' | 'B' | null) — o dashboard pinta verde quando B melhora e vermelho
// quando piora.
function metricRow(key, label, a, b, { lowerIsBetter = true, numeric = true, rank = null, format = null } = {}) {
    const va = a ?? NA, vb = b ?? NA;
    const row = { key, label, a: va, b: vb, delta: NA, deltaPct: NA, significant: false, better: null };
    if (format) row.format = format;
    if (rank) {
        const ra = rank(va), rb = rank(vb);
        row.delta = sameValue(va, vb) ? '=' : `${va} → ${vb}`;
        row.significant = !sameValue(va, vb);
        if (ra !== rb) row.better = ra > rb ? 'A' : 'B';
        return row;
    }
    if (!numeric) {
        row.delta = sameValue(va, vb) ? '=' : `${va} → ${vb}`;
        row.significant = !sameValue(va, vb);
        return row;
    }
    if (va === NA || vb === NA) {
        if (sameValue(va, vb)) row.delta = '=';
        return row;
    }
    row.delta = round(vb - va);
    const pct = pctDelta(va, vb);
    row.deltaPct = pct ?? NA;
    row.significant = pct !== null && Math.abs(pct) > SIGNIFICANT_PCT;
    if (va !== vb) row.better = (vb < va) === lowerIsBetter ? 'B' : 'A';
    return row;
}

function buildMetrics(runA, runB, tests, plan) {
    const sa = runA.state || {}, sb = runB.state || {};
    const ca = runA.cost_tracking, cb = runB.cost_tracking;
    const len = s => (Array.isArray(s.history) ? s.history.length : null);
    const costA = round(totalOf(ca, 'cost_usd'), 4), costB = round(totalOf(cb, 'cost_usd'), 4);
    const missingCost = { a: runsWithout(ca, 'runs_without_cost'), b: runsWithout(cb, 'runs_without_cost') };
    const cost = {
        ...metricRow('cost_usd', 'Custo (US$)', costA, costB, { format: 'usd' }),
        complete: { a: costA !== null && missingCost.a === 0, b: costB !== null && missingCost.b === 0 },
        missing: missingCost,
    };
    return [
        metricRow('status', 'Status', sa.status, sb.status, { rank: v => OUTCOME_RANK[statusOutcome(v === NA ? null : v)] }),
        metricRow('node', 'Nó final', sa.node, sb.node, { numeric: false }),
        metricRow('test_result', 'Testes', tests.a.outcome, tests.b.outcome, { rank: v => TEST_RANK[v] ?? 1 }),
        metricRow('planScore', 'Plan score', plan?.a === NA ? null : plan?.a, plan?.b === NA ? null : plan?.b, { lowerIsBetter: false }),
        metricRow('tokens', 'Tokens (entrada+saída)', totalTokens(ca), totalTokens(cb), { format: 'int' }),
        cost,
        metricRow('duration_ms', 'Duração dos agentes', totalOf(ca, 'duration_ms'), totalOf(cb, 'duration_ms'), { format: 'ms' }),
        metricRow('history_len', 'Nós executados', len(sa), len(sb), { format: 'int' }),
        metricRow('retries', 'Retries', retriesTotal(sa), retriesTotal(sb), { format: 'int' }),
    ];
}

// ---------------------------------------------------------------------------------
// Veredito: status (sucesso > neutro > falha) → testes (passou > N/A > falhou) → tokens
// (diferença acima de SIGNIFICANT_PCT). Nada disso decidiu = equivalent, desde que haja
// prova: status ausente, testes parciais ou tokens parciais em algum lado = inconclusive.
function missingEvidence(runA, runB, tests) {
    const gaps = [];
    const sides = (pred, what) => {
        const a = pred(runA, tests.a), b = pred(runB, tests.b);
        if (a || b) gaps.push(`${what} em ${a && b ? 'A e B' : a ? 'A' : 'B'}`);
    };
    sides(run => statusOutcome(run.state?.status) === 'unknown', 'status ausente');
    sides((run, t) => t.partial, 'testes parciais');
    sides(run => runsWithout(run.cost_tracking, 'runs_without_tokens') > 0, 'tokens parciais');
    return gaps;
}

function decideVerdict(runA, runB, tests, tokens) {
    const oa = statusOutcome(runA.state?.status), ob = statusOutcome(runB.state?.status);
    if (OUTCOME_RANK[oa] !== OUTCOME_RANK[ob]) {
        const b = OUTCOME_RANK[ob] > OUTCOME_RANK[oa];
        return { verdict: b ? 'B-better' : 'A-better', reason: 'status', detail: `status ${runA.state?.status ?? NA} (A) vs ${runB.state?.status ?? NA} (B)` };
    }
    const ta = TEST_RANK[tests.a.outcome], tb = TEST_RANK[tests.b.outcome];
    if (ta !== tb) {
        return { verdict: tb > ta ? 'B-better' : 'A-better', reason: 'tests', detail: `testes ${tests.a.outcome} (A) vs ${tests.b.outcome} (B)` };
    }
    const pct = tokens.total.deltaPct;
    if (pct !== NA && Math.abs(pct) > SIGNIFICANT_PCT) {
        return { verdict: pct < 0 ? 'B-better' : 'A-better', reason: 'tokens', detail: `tokens ${pct > 0 ? '+' : ''}${pct}% em B` };
    }
    const gaps = missingEvidence(runA, runB, tests);
    if (gaps.length) return { verdict: 'inconclusive', reason: 'insufficient-evidence', detail: `sem prova suficiente: ${gaps.join('; ')}` };
    return { verdict: 'equivalent', reason: pct === NA ? 'no-token-data' : 'tokens', detail: pct === NA ? 'mesmo status/testes; tokens N/A' : `mesmo status/testes; tokens ${pct > 0 ? '+' : ''}${pct}% em B (limiar ${SIGNIFICANT_PCT}%)` };
}

function outcomePhrase(status) {
    const o = statusOutcome(status);
    if (o === 'success') return 'completou com sucesso';
    if (o === 'failure') return `terminou em "${status}"`;
    if (o === 'in_progress') return `está em "${status}"`;
    return 'tem status N/A';
}

function summarySentence(runA, runB, verdict, tokens) {
    if (verdict.verdict === 'inconclusive') return `Comparação inconclusiva: ${verdict.detail}`;
    const subj = verdict.verdict === 'A-better' ? 'A' : 'B';
    const other = subj === 'A' ? 'B' : 'A';
    const subjState = (subj === 'A' ? runA : runB).state;
    const a = tokens.total.a, b = tokens.total.b;
    let pct = null;
    if (a !== NA && b !== NA) pct = subj === 'B' ? pctDelta(a, b) : pctDelta(b, a);
    let tokenPart;
    if (pct === null) tokenPart = '(tokens N/A)';
    else if (Math.abs(pct) < 1) tokenPart = `com consumo de tokens equivalente ao Run ${other}`;
    else tokenPart = `em ${Math.round(Math.abs(pct))}% ${pct < 0 ? 'menos' : 'mais'} tokens que Run ${other}`;
    const lead = `Run ${subj} ${outcomePhrase(subjState?.status)} ${tokenPart}`;
    if (verdict.verdict === 'equivalent') return `Runs equivalentes: ${lead.charAt(0).toLowerCase()}${lead.slice(1)}`;
    const otherState = (subj === 'A' ? runB : runA).state;
    return verdict.reason === 'status' ? `${lead} (Run ${other} ${outcomePhrase(otherState?.status)})` : lead;
}

// Entradas e evidências do run para a tela Comparar runs. Ausente = null (N/A na tela).
function runFacts(run) {
    const s = run.state || {};
    const providers = new Set();
    for (const n of Object.values(costNodes(run.cost_tracking))) for (const p of nodeProviders(n)) providers.add(p);
    const transcripts = num(s.transcripts_total) ?? (Array.isArray(s.transcripts) ? s.transcripts.length : null);
    return {
        specPath: typeof s.spec_path === 'string' && s.spec_path ? s.spec_path : null,
        specHash: typeof s.spec_hash === 'string' && s.spec_hash ? s.spec_hash : null,
        providers: [...providers].sort(),
        planScore: num(s.planScore),
        transcripts,
        startedAt: typeof s.started_at === 'string' ? s.started_at : null,
        updatedAt: typeof s.updated_at === 'string' ? s.updated_at : null,
    };
}

function describeRun(run) {
    return {
        ref: run.ref ?? NA,
        taskId: run.taskId ?? run.state?.task_id ?? NA,
        source: run.source ?? null,
        status: run.state?.status ?? NA,
        replayOf: run.state?.replayOf?.originalRun ?? null,
        costSource: run.costSource ?? (run.cost_tracking ? 'state.json' : null),
        readError: run.readError ?? null,
    };
}

function compareRuns(runA, runB) {
    const a = normalizeRun(runA, 'A');
    const b = normalizeRun(runB, 'B');
    const testResultsDiff = diffTests(a.state, b.state);
    const planScoreDiff = diffPlanScore(a.state, b.state);
    const tokenDiff = diffTokens(a.cost_tracking, b.cost_tracking);
    const verdict = decideVerdict(a, b, testResultsDiff, tokenDiff);
    return {
        runA: describeRun(a),
        runB: describeRun(b),
        metrics: buildMetrics(a, b, testResultsDiff, planScoreDiff),
        facts: { a: runFacts(a), b: runFacts(b) },
        stateDiff: diffState(a.state, b.state),
        stateDiffIgnored: STATE_DIFF_IGNORED,
        tokenDiff,
        nodeDiff: diffNodes(a, b),
        testResultsDiff,
        planScoreDiff: planScoreDiff ?? NA,
        verdict: verdict.verdict,
        verdictReason: verdict.detail,
        summary: summarySentence(a, b, verdict, tokenDiff),
        significantPct: SIGNIFICANT_PCT,
    };
}

module.exports = {
    NA,
    SIGNIFICANT_PCT,
    RunNotFoundError,
    compareRuns,
    loadRun,
    loadRunFromDir,
    locateRun,
    parseRunRef,
    statusOutcome,
    testOutcome,
};
