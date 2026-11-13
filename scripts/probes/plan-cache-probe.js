#!/usr/bin/env node
// PRI-315 (L1 da PRI-206): medição offline do cache do prefixo no 1º request do nó plan,
// AS-IS (`--disallowedTools Agent,Task`) contra a flag (`permissions.deny` via `--settings`),
// e prova de que, com a flag, o plan não abre subagente. SPEC: tasks/pri-315/SPEC.md.
//
// STATUS: verificação pontual, FORA do watcher, do harness (loopback-only) e de qualquer
// estado de Run: faz chamadas reais ao provider com a conta padrão do CLI (config pessoal,
// como na PRI-206 P0/P0b). Não é canal de despacho. Roda só com o «sim» do Richard (D2,
// 2026-11-13). Diretório de trabalho sintético, sem código nem dado de consumidor.
//
// O argv imita o trecho fixo do despacho do plan (golden em scripts/lib/subagent-block.test.js)
// e usa a mesma função do watcher para o bloqueio. Prompt é um stub curto: mede o prefixo,
// não o custo de uma run real do nó plan (esse valor fica UNKNOWN até o piloto).
//
// Evidência só agregada (contagens de tokens e de ferramentas); nenhum transcript copiado.
//
// Uso:
//   node scripts/probes/plan-cache-probe.js measure --n 5 --out <dir> [--work-dir <dir>]
//   node scripts/probes/plan-cache-probe.js prove-deny --n 3 --out <dir> [--work-dir <dir>]
//   node scripts/probes/plan-cache-probe.js prove-control --n 1 --out <dir> [--work-dir <dir>]
//     (controle: mesmo prompt sem bloqueio — prova que o prompt provoca a chamada a Agent)
//   node scripts/probes/plan-cache-probe.js tool-list --out <dir> [--work-dir <dir>]
//     (lista de ferramentas do evento init, por argv: review, plan A e plan B — o 1º segmento
//      do prompt; igual ao do review = prefixo compartilhável)

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync, execFileSync } = require('child_process');

const { subagentBlockArgs, DENY_SETTINGS_JSON } = require('../lib/subagent-block');
const { findClaudeTranscripts, sumClaudeUsage } = require('../lib/cost-tracking');

const PRISMA_ROOT = path.resolve(__dirname, '..', '..');
const MAX_CALLS = 40;
const STUB_PROMPT = 'Reply with the single word ok. Do not use any tool.';
const DENY_PROMPT = 'Call the Agent tool once with subagent_type "general-purpose", description "probe" and prompt "Reply ok". ' +
    'Then call the Task tool once with the same arguments. Do not use any other tool. ' +
    'Finally reply with one line per tool saying whether the call was accepted or refused.';

const ARMS = { A: false, B: true }; // A = AS-IS; B = flag ligada (denySettings)

function parseArgs(argv) {
    const [mode, ...rest] = argv;
    const opts = { mode, n: 5, out: null, workDir: null, claudeBin: 'claude' };
    for (let i = 0; i < rest.length; i += 2) {
        const [k, v] = [rest[i], rest[i + 1]];
        if (k === '--n') opts.n = Number(v);
        else if (k === '--out') opts.out = v;
        else if (k === '--work-dir') opts.workDir = v;
        else if (k === '--claude-bin') opts.claudeBin = v;
        else throw new Error(`argumento desconhecido: ${k}`);
    }
    if (!['measure', 'prove-deny', 'prove-control', 'tool-list'].includes(opts.mode)) throw new Error('modo: measure | prove-deny | prove-control | tool-list');
    if (!Number.isInteger(opts.n) || opts.n < 1) throw new Error('--n inteiro >= 1');
    if (!opts.out) throw new Error('--out obrigatório');
    return opts;
}

// Mesmo trecho fixo do despacho do plan (readmine-watcher.js, dispatchClaudeSegment), não roteado.
function probeArgv({ prompt, nodes, denySettings, sessionId }) {
    return [
        '-p', prompt,
        '--name', `pri-315-probe-${nodes.join('-')}`,
        '--session-id', sessionId,
        '--permission-mode', 'acceptEdits',
        '--allowedTools', 'mcp__redmine__*,Read,Edit,Write,Bash,Grep,Glob',
        ...subagentBlockArgs({ nodes, routed: false, denySettings }),
        '--add-dir', PRISMA_ROOT,
    ];
}

// Igual ao cleanAgentEnv do watcher no essencial: nenhuma variável CLAUDE* herdada.
function agentEnv() {
    const env = { ...process.env };
    for (const key of Object.keys(env)) if (key.startsWith('CLAUDE') || key === 'AI_AGENT') delete env[key];
    return env;
}

function projectsDir() {
    return path.join(process.env.CLAUDE_CONFIG_DIR_PROBE || path.join(os.homedir(), '.claude'), 'projects');
}

function ensureWorkDir(dir) {
    const wd = dir || fs.mkdtempSync(path.join(os.tmpdir(), 'pri-315-probe-'));
    fs.mkdirSync(wd, { recursive: true });
    if (!fs.existsSync(path.join(wd, '.git'))) {
        execFileSync('git', ['init', '-q'], { cwd: wd });
        fs.writeFileSync(path.join(wd, 'README.md'), '# probe\n');
    }
    return wd;
}

let calls = 0;
function runSession({ claudeBin, workDir, prompt, nodes, denySettings }) {
    if (++calls > MAX_CALLS) throw new Error(`teto de ${MAX_CALLS} chamadas`);
    const sessionId = crypto.randomUUID();
    const started = Date.now();
    const r = spawnSync(claudeBin, probeArgv({ prompt, nodes, denySettings, sessionId }), {
        cwd: workDir, env: agentEnv(), stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', timeout: 5 * 60 * 1000,
    });
    const files = findClaudeTranscripts(sessionId, projectsDir());
    const contents = files.map((f, i) => ({ content: fs.readFileSync(f, 'utf8'), role: i === 0 ? 'main' : 'subagent' }));
    return { sessionId, exitCode: r.status, durationMs: Date.now() - started, files, contents };
}

function usageSummary(session) {
    const u = sumClaudeUsage(session.contents);
    return {
        exit_code: session.exitCode,
        first_request: {
            cache_read: u.first_turn.cache_read_tokens,
            cache_write_5m: u.first_turn.cache_write_5m_tokens,
            cache_write_1h: u.first_turn.cache_write_1h_tokens,
        },
        session: {
            input: u.input_tokens, output: u.output_tokens,
            cache_read: u.cache_read_input_tokens, cache_write: u.cache_creation_input_tokens,
            cost_usd: u.cost_usd, cost_estimated: u.cost_estimated, models: u.models,
        },
        transcripts: session.files.length,
    };
}

// Contagem agregada de tool_use/tool_result no transcript principal (sem conteúdo).
function toolOutcome(session) {
    const main = session.contents[0]?.content || '';
    const uses = new Map();
    const results = [];
    let reportedUnavailable = false;
    for (const line of main.split('\n')) {
        if (!line.trim()) continue;
        let e; try { e = JSON.parse(line); } catch { continue; }
        const blocks = Array.isArray(e.message?.content) ? e.message.content : [];
        for (const b of blocks) {
            if (e.type === 'assistant' && b.type === 'tool_use') uses.set(b.id, b.name);
            if (e.type === 'assistant' && b.type === 'text' && /not available|doesn't exist|does not exist|isn't among|não (existe|está disponível)/i.test(b.text || '')) reportedUnavailable = true;
            if (e.type === 'user' && b.type === 'tool_result') {
                const text = typeof b.content === 'string' ? b.content : JSON.stringify(b.content || '');
                results.push({ tool: uses.get(b.tool_use_id) || 'UNKNOWN', is_error: b.is_error === true,
                    permission_denied: /permission|denied|not allowed|deny/i.test(text) });
            }
        }
    }
    const subagentTool = n => n === 'Agent' || n === 'Task';
    return {
        tool_uses: [...uses.values()],
        subagent_tool_uses: [...uses.values()].filter(subagentTool).length,
        subagent_results: results.filter(r => subagentTool(r.tool)),
        subagent_transcripts: Math.max(0, session.files.length - 1),
        reported_unavailable: reportedUnavailable,
    };
}

function denyVerdict(session, outcome) {
    if (!session.files.length) return 'NO_TRANSCRIPT';
    if (outcome.subagent_transcripts > 0 || outcome.subagent_results.some(r => !r.is_error)) return 'SUBAGENT_OPENED';
    if (outcome.subagent_tool_uses === 0) return 'NOT_ATTEMPTED';
    // Recusa só conta se for de permissão (AC1); outro erro (ex.: validação de input) é inconclusivo.
    return outcome.subagent_results.length === outcome.subagent_tool_uses && outcome.subagent_results.every(r => r.permission_denied)
        ? 'REFUSED' : 'INCONCLUSIVE';
}

const median = xs => {
    const v = xs.filter(Number.isFinite).sort((a, b) => a - b);
    if (!v.length) return null;
    const m = Math.floor(v.length / 2);
    return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
};
const stats = xs => ({ n: xs.filter(Number.isFinite).length, median: median(xs),
    min: xs.filter(Number.isFinite).length ? Math.min(...xs.filter(Number.isFinite)) : null,
    max: xs.filter(Number.isFinite).length ? Math.max(...xs.filter(Number.isFinite)) : null });

function claudeVersion(bin) {
    try { return execFileSync(bin, ['--version'], { encoding: 'utf8', env: agentEnv() }).trim(); } catch { return 'UNKNOWN'; }
}
function gitCommit() {
    try { return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: PRISMA_ROOT, encoding: 'utf8' }).trim(); } catch { return 'UNKNOWN'; }
}
// Atribuição à versão com árvore suja: sha256 do código que de fato rodou.
function codeDigests() {
    const sha = f => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
    return { 'scripts/probes/plan-cache-probe.js': sha(__filename), 'scripts/lib/subagent-block.js': sha(require.resolve('../lib/subagent-block')) };
}

function measure(opts, workDir) {
    const samples = [];
    // Braços alternados (A,B,B,A,...) para não favorecer um lado pela ordem; cada amostra =
    // 1 sessão de aquecimento (argv de nó sem bloqueio, como o review) + 1 sessão do plan.
    const order = [];
    for (let i = 0; i < opts.n; i++) order.push(...(i % 2 ? ['B', 'A'] : ['A', 'B']));
    for (const [i, arm] of order.entries()) {
        const warm = runSession({ ...opts, workDir, prompt: STUB_PROMPT, nodes: ['review'], denySettings: false });
        const plan = runSession({ ...opts, workDir, prompt: STUB_PROMPT, nodes: ['plan'], denySettings: ARMS[arm] });
        samples.push({ i, arm, warm: usageSummary(warm), plan: usageSummary(plan) });
        console.error(`amostra ${i + 1}/${order.length} braço ${arm}: read=${samples.at(-1).plan.first_request.cache_read} ` +
            `write5m=${samples.at(-1).plan.first_request.cache_write_5m} write1h=${samples.at(-1).plan.first_request.cache_write_1h}`);
    }
    const byArm = arm => samples.filter(s => s.arm === arm).map(s => s.plan);
    const write = p => (p.first_request.cache_write_5m || 0) + (p.first_request.cache_write_1h || 0);
    const summary = Object.fromEntries(Object.keys(ARMS).map(arm => [arm, {
        first_request_cache_read: stats(byArm(arm).map(p => p.first_request.cache_read)),
        first_request_cache_write: stats(byArm(arm).map(write)),
        session_total_tokens: stats(byArm(arm).map(p => ['input', 'output', 'cache_read', 'cache_write'].reduce((a, k) => a + (p.session[k] || 0), 0))),
        session_cost_usd: stats(byArm(arm).map(p => p.session.cost_usd)),
        exit_nonzero: byArm(arm).filter(p => p.exit_code !== 0).length,
    }]));
    return { samples, summary };
}

function proveDeny(opts, workDir) {
    const runs = [];
    for (let i = 0; i < opts.n; i++) {
        const s = runSession({ ...opts, workDir, prompt: DENY_PROMPT, nodes: ['plan'], denySettings: true });
        const outcome = toolOutcome(s);
        const verdict = denyVerdict(s, outcome);
        runs.push({ i, exit_code: s.exitCode, ...outcome, verdict, usage: usageSummary(s).session });
        console.error(`prova ${i + 1}/${opts.n}: tool_uses=${outcome.tool_uses.join(',') || '-'} ` +
            `subagent_transcripts=${outcome.subagent_transcripts} verdict=${verdict}`);
    }
    // AC1 só passa com prova positiva: toda execução tentou Agent/Task e levou recusa.
    // Ausência de tentativa ou de transcript é inconclusiva, nunca aprovação.
    return { runs, ac1: runs.every(r => r.verdict === 'REFUSED') ? 'PASS' : runs.some(r => r.verdict === 'SUBAGENT_OPENED') ? 'FAIL' : 'INCONCLUSIVE' };
}

// Controle sem bloqueio: o mesmo prompt tem de provocar tool_use de Agent/Task; só assim
// NOT_ATTEMPTED no braço com a flag significa ferramenta indisponível, e não prompt fraco.
function proveControl(opts, workDir) {
    const runs = [];
    for (let i = 0; i < opts.n; i++) {
        const s = runSession({ ...opts, workDir, prompt: DENY_PROMPT, nodes: ['review'], denySettings: false });
        const outcome = toolOutcome(s);
        runs.push({ i, exit_code: s.exitCode, ...outcome, usage: usageSummary(s).session });
        console.error(`controle ${i + 1}/${opts.n}: tool_uses=${outcome.tool_uses.join(',') || '-'} subagent_transcripts=${outcome.subagent_transcripts}`);
    }
    return { runs, control_elicits_call: runs.every(r => r.subagent_tool_uses > 0) };
}

// Lista de ferramentas que o CLI anuncia no evento `system/init` do stream-json. É o 1º
// segmento do prompt: se a do plan for igual à do review, o prefixo pode ser compartilhado.
function initTools(opts, workDir, { nodes, denySettings }) {
    if (++calls > MAX_CALLS) throw new Error(`teto de ${MAX_CALLS} chamadas`);
    const argv = [...probeArgv({ prompt: STUB_PROMPT, nodes, denySettings, sessionId: crypto.randomUUID() }), '--output-format', 'stream-json', '--verbose'];
    const r = spawnSync(opts.claudeBin, argv, { cwd: workDir, env: agentEnv(), encoding: 'utf8', timeout: 5 * 60 * 1000 });
    for (const line of (r.stdout || '').split('\n')) {
        let e; try { e = JSON.parse(line); } catch { continue; }
        if (e.type === 'system' && e.subtype === 'init' && Array.isArray(e.tools)) return e.tools;
    }
    return null;
}

function toolList(opts, workDir) {
    const lists = {
        review: initTools(opts, workDir, { nodes: ['review'], denySettings: false }),
        plan_A_disallowedTools: initTools(opts, workDir, { nodes: ['plan'], denySettings: false }),
        plan_B_permissions_deny: initTools(opts, workDir, { nodes: ['plan'], denySettings: true }),
    };
    const has = (l, t) => (l ? l.includes(t) : null);
    const sameAs = (a, b) => (a && b ? JSON.stringify(a) === JSON.stringify(b) : null);
    return {
        counts: Object.fromEntries(Object.entries(lists).map(([k, l]) => [k, l ? l.length : null])),
        has_agent: Object.fromEntries(Object.entries(lists).map(([k, l]) => [k, has(l, 'Agent')])),
        has_task: Object.fromEntries(Object.entries(lists).map(([k, l]) => [k, has(l, 'Task')])),
        plan_A_equals_review: sameAs(lists.plan_A_disallowedTools, lists.review),
        plan_B_equals_review: sameAs(lists.plan_B_permissions_deny, lists.review),
        plan_B_equals_plan_A: sameAs(lists.plan_B_permissions_deny, lists.plan_A_disallowedTools),
        // Só nomes de ferramentas embutidas que diferem (sem MCP do usuário).
        diff_review_vs_B: lists.review && lists.plan_B_permissions_deny
            ? lists.review.filter(t => !lists.plan_B_permissions_deny.includes(t) && !t.startsWith('mcp__')) : null,
    };
}

function writeEvidence(opts, result) {
    fs.mkdirSync(opts.out, { recursive: true });
    const meta = { issue: 'PRI-315', mode: opts.mode, n: opts.mode === 'tool-list' ? 1 : opts.n, code_sha256: codeDigests(), claude_version: claudeVersion(opts.claudeBin),
        prisma_commit: gitCommit(), deny_settings: DENY_SETTINGS_JSON, account: 'default (~/.claude)',
        prompt: ['measure', 'tool-list'].includes(opts.mode) ? STUB_PROMPT : DENY_PROMPT, control_argv: opts.mode === 'prove-control' ? 'sem bloqueio (nó review)' : undefined, at: new Date().toISOString() };
    const file = path.join(opts.out, `${opts.mode}-${meta.at.replace(/[:.]/g, '-')}.json`);
    fs.writeFileSync(file, JSON.stringify({ meta, ...result }, null, 2) + '\n');
    return file;
}

if (require.main === module) {
    const opts = parseArgs(process.argv.slice(2));
    const workDir = ensureWorkDir(opts.workDir);
    const runners = { measure, 'prove-deny': proveDeny, 'prove-control': proveControl, 'tool-list': toolList };
    const result = runners[opts.mode](opts, workDir);
    console.log(writeEvidence(opts, result));
}

module.exports = { probeArgv, toolOutcome, denyVerdict, stats, parseArgs };
