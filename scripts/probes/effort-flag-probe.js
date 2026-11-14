#!/usr/bin/env node
// PRI-353 (T1, AC1): prova offline do U1, isto é, se `claude -p --effort <nível>` chega ao modelo.
// SPEC: tasks/effort-por-fase/SPEC.md. Plano: tasks/effort-por-fase/plan.md (passo 1).
//
// STATUS: verificação pontual, FORA do watcher, do harness e de qualquer estado de Run. Faz
// chamadas reais ao provider com a conta padrão do CLI (config pessoal) e gasta a assinatura:
// roda só com o «sim» do Richard. Diretório de trabalho sintético, sem código nem dado de
// consumidor. Não é canal de despacho.
//
// O que mede: o mesmo prompt de raciocínio longo, sem ferramentas, nos níveis de `--levels`
// (padrão low e max), `n` vezes cada, mais 1 controle (`--effort` inválido). Indício de efeito:
// mediana de tokens de saída (>= 1,5x entre o primeiro e o último nível) ou mais blocos
// `thinking` no nível mais alto. Isso é INDÍCIO, não prova de mecanismo: o veredito nunca passa
// de EFFECT_OBSERVED, e quem decide o U1 é o Richard. A rodada 1 (n=3, CLI 2.1.325, prompt
// curto) deu ACCEPTED_EFFECT_UNKNOWN e o controle inválido saiu com exit 0.
//
// Evidência só agregada (versão da CLI, exit codes, contagem de tokens); nenhum transcript copiado.
//
// Uso:
//   node scripts/probes/effort-flag-probe.js --out <dir> [--n 3] [--levels low,max] [--work-dir <dir>] [--claude-bin claude]

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync, execFileSync } = require('child_process');

const { findClaudeTranscripts, sumClaudeUsage } = require('../lib/cost-tracking');

const VALID_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'];
const DEFAULT_LEVELS = ['low', 'max'];
const CONTROL_LEVEL = 'bogus';
const MAX_CALLS = 40;
const OUTPUT_RATIO = 1.5;
const PROMPT = 'Count the ordered triples (a, b, c) of positive integers with a + b + c = 60 and ' +
    'a < b < c. Solve it, then verify the count with a second, independent method and reconcile ' +
    'any difference. State the final number on the last line. Do not use any tool.';

function parseArgs(argv) {
    const opts = { n: 3, levels: DEFAULT_LEVELS, out: null, workDir: null, claudeBin: 'claude' };
    for (let i = 0; i < argv.length; i += 2) {
        const [k, v] = [argv[i], argv[i + 1]];
        if (k === '--n') opts.n = Number(v);
        else if (k === '--out') opts.out = v;
        else if (k === '--levels') opts.levels = String(v).split(',');
        else if (k === '--work-dir') opts.workDir = v;
        else if (k === '--claude-bin') opts.claudeBin = v;
        else throw new Error(`argumento desconhecido: ${k}`);
    }
    if (!Number.isInteger(opts.n) || opts.n < 1) throw new Error('--n inteiro >= 1');
    if (!opts.out) throw new Error('--out obrigatório');
    const bad = opts.levels.filter(l => !VALID_LEVELS.includes(l));
    if (bad.length) throw new Error(`nível inválido em --levels: ${bad.join(',')}`);
    if (opts.levels.length < 2) throw new Error('--levels precisa de ao menos dois níveis');
    return opts;
}

// Trecho fixo do despacho (readmine-watcher.js, dispatchClaudeSegment), sem roteamento nem
// bloqueio de subagente: o único que varia é o nível.
function probeArgv({ prompt, level, sessionId }) {
    return [
        '-p', prompt,
        '--name', 'pri-353-effort-probe',
        '--session-id', sessionId,
        '--permission-mode', 'acceptEdits',
        '--allowedTools', 'mcp__redmine__*,Read,Edit,Write,Bash,Grep,Glob',
        '--effort', level,
    ];
}

function median(values) {
    const v = values.filter(x => typeof x === 'number' && Number.isFinite(x)).sort((a, b) => a - b);
    if (!v.length) return null;
    const mid = Math.floor(v.length / 2);
    return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

function countThinkingBlocks(content) {
    if (typeof content !== 'string') return null;
    let n = 0;
    for (const line of content.split('\n')) {
        if (!line.trim()) continue;
        let e; try { e = JSON.parse(line); } catch { continue; }
        if (e.type !== 'assistant' || !Array.isArray(e.message?.content)) continue;
        n += e.message.content.filter(b => b.type === 'thinking').length;
    }
    return n;
}

// Sem medição = null/UNKNOWN. EFFECT_OBSERVED só com todos os níveis aceitos e um destes sinais,
// medidos de verdade, entre o primeiro e o último nível: mediana de saída >= OUTPUT_RATIO x, ou
// mediana de blocos thinking maior. Controle inválido aceito não anula o efeito: vira nota.
function verdict({ control, byLevel, levels }) {
    const rejected = levels.filter(l => (byLevel[l] || []).some(r => r.exit_code !== 0));
    if (rejected.length) return { status: 'UNAVAILABLE', reason: `nível válido recusado: ${rejected.join(',')}` };
    const med = key => Object.fromEntries(levels.map(l => [l, median((byLevel[l] || []).map(r => r[key]))]));
    const medians = { output_tokens: med('output_tokens'), thinking_blocks: med('thinking_blocks') };
    const notes = control.exit_code === 0 ? ['a CLI não valida --effort inválido (exit 0); aceitar a flag não prova efeito'] : [];
    const [lo, hi] = [levels[0], levels[levels.length - 1]];
    const o = medians.output_tokens, t = medians.thinking_blocks;
    const byTokens = o[lo] !== null && o[hi] !== null && o[lo] > 0 && o[hi] >= OUTPUT_RATIO * o[lo];
    const byThinking = t[lo] !== null && t[hi] !== null && t[hi] > t[lo];
    if (byTokens || byThinking) {
        return { status: 'EFFECT_OBSERVED', reason: `${byTokens ? 'saída' : 'blocos thinking'} maior em ${hi} que em ${lo}; indício, não prova do mecanismo`, medians, notes };
    }
    const measured = [o[lo], o[hi]].every(x => x !== null);
    return { status: 'ACCEPTED_EFFECT_UNKNOWN', reason: measured ? 'sem diferença mensurável entre os níveis' : 'sem medição de tokens de saída', medians, notes };
}

function runProbe({ n, levels = DEFAULT_LEVELS, run, claudeVersion }) {
    const total = 1 + levels.length * n;
    if (total > MAX_CALLS) throw new Error(`teto de ${MAX_CALLS} chamadas (pedido: ${total})`);
    const control = run({ level: CONTROL_LEVEL });
    const byLevel = {};
    for (const level of levels) {
        byLevel[level] = [];
        for (let i = 0; i < n; i++) byLevel[level].push(run({ level }));
    }
    return { claude_version: claudeVersion, n, levels, calls: total, control, by_level: byLevel, verdict: verdict({ control, byLevel, levels }) };
}

// ---- parte com efeito (chamadas reais); não coberta pelos testes puros -------------------

function agentEnv() {
    const env = { ...process.env };
    for (const key of Object.keys(env)) if (key.startsWith('CLAUDE') || key === 'AI_AGENT') delete env[key];
    return env;
}

function ensureWorkDir(dir) {
    const wd = dir || fs.mkdtempSync(path.join(os.tmpdir(), 'pri-353-probe-'));
    fs.mkdirSync(wd, { recursive: true });
    if (!fs.existsSync(path.join(wd, '.git'))) {
        execFileSync('git', ['init', '-q'], { cwd: wd });
        fs.writeFileSync(path.join(wd, 'README.md'), '# probe\n');
    }
    return wd;
}

function realRunner({ claudeBin, workDir }) {
    const projects = path.join(os.homedir(), '.claude', 'projects');
    return ({ level }) => {
        const sessionId = crypto.randomUUID();
        const started = Date.now();
        const r = spawnSync(claudeBin, probeArgv({ prompt: PROMPT, level, sessionId }), {
            cwd: workDir, env: agentEnv(), stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', timeout: 5 * 60 * 1000,
        });
        let outputTokens = null, thinking = null;
        try {
            const files = findClaudeTranscripts(sessionId, projects);
            if (files.length) {
                const contents = files.map(f => ({ content: fs.readFileSync(f, 'utf8'), role: 'main' }));
                outputTokens = sumClaudeUsage(contents).output_tokens;
                thinking = countThinkingBlocks(contents[0].content);
            }
        } catch { /* sem transcript = UNKNOWN */ }
        return { exit_code: r.status, duration_ms: Date.now() - started, output_tokens: outputTokens, thinking_blocks: thinking };
    };
}

function markdown(report) {
    const m = report.verdict.medians;
    const rows = report.levels.map(l => `| ${l} | ${report.by_level[l].map(r => r.output_tokens ?? 'UNKNOWN').join(', ')} | ${m?.output_tokens[l] ?? 'UNKNOWN'} | ${report.by_level[l].map(r => r.thinking_blocks ?? 'UNKNOWN').join(', ')} |`);
    return [
        '# Probe do esforço (PRI-353, AC1)', '',
        `CLI: ${report.claude_version} · n por nível: ${report.n} · chamadas: ${report.calls}`,
        `Controle (\`--effort ${CONTROL_LEVEL}\`): exit ${report.control.exit_code}`, '',
        '| nível | tokens de saída | mediana | blocos thinking |', '| -- | -- | -- | -- |', ...rows, '',
        `**Veredito:** ${report.verdict.status}. ${report.verdict.reason}`,
        ...(report.verdict.notes || []).map(x => `Nota: ${x}.`), '',
        'Indício, não prova do mecanismo. Quem decide o U1 é o Richard.', '',
    ].join('\n');
}

function main() {
    const opts = parseArgs(process.argv.slice(2));
    const claudeVersion = execFileSync(opts.claudeBin, ['--version'], { encoding: 'utf8', env: agentEnv() }).trim();
    const workDir = ensureWorkDir(opts.workDir);
    const report = runProbe({ n: opts.n, levels: opts.levels, run: realRunner({ claudeBin: opts.claudeBin, workDir }), claudeVersion });
    fs.mkdirSync(opts.out, { recursive: true });
    fs.writeFileSync(path.join(opts.out, 'effort-flag-probe.json'), JSON.stringify(report, null, 2) + '\n');
    fs.writeFileSync(path.join(opts.out, 'effort-flag-probe.md'), markdown(report));
    console.log(markdown(report));
}

if (require.main === module) main();

module.exports = { probeArgv, median, verdict, parseArgs, runProbe, countThinkingBlocks, DEFAULT_LEVELS, VALID_LEVELS, PROMPT };
