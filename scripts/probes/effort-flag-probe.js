#!/usr/bin/env node
// PRI-353 (T1, AC1): prova offline do U1, isto é, se `claude -p --effort <nível>` chega ao modelo.
// SPEC: tasks/effort-por-fase/SPEC.md. Plano: tasks/effort-por-fase/plan.md (passo 1).
//
// STATUS: verificação pontual, FORA do watcher, do harness e de qualquer estado de Run. Faz
// chamadas reais ao provider com a conta padrão do CLI (config pessoal) e gasta a assinatura:
// roda só com o «sim» do Richard. Diretório de trabalho sintético, sem código nem dado de
// consumidor. Não é canal de despacho.
//
// O que mede: o mesmo prompt de raciocínio, sem ferramentas, em low, medium e high, `n` vezes
// cada, mais 1 controle negativo (`--effort` inválido, que a CLI deve recusar). O indício de
// efeito é a mediana de tokens de saída por nível. Isso é INDÍCIO, não prova de mecanismo: o
// veredito nunca passa de EFFECT_OBSERVED, e quem decide o U1 é o Richard.
//
// Evidência só agregada (versão da CLI, exit codes, contagem de tokens); nenhum transcript copiado.
//
// Uso:
//   node scripts/probes/effort-flag-probe.js --out <dir> [--n 3] [--work-dir <dir>] [--claude-bin claude]

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync, execFileSync } = require('child_process');

const { findClaudeTranscripts, sumClaudeUsage } = require('../lib/cost-tracking');

const LEVELS = ['low', 'medium', 'high'];
const CONTROL_LEVEL = 'bogus';
const MAX_CALLS = 40;
const PROMPT = 'Three people (A, B, C) each own a different pet (cat, dog, fish) and live in a different ' +
    'house (red, blue, green). A does not own the dog. The fish owner lives in the blue house. ' +
    'C lives in the green house and does not own the cat. B does not live in the red house. ' +
    'Work out who owns which pet and who lives in which house. Do not use any tool.';

function parseArgs(argv) {
    const opts = { n: 3, out: null, workDir: null, claudeBin: 'claude' };
    for (let i = 0; i < argv.length; i += 2) {
        const [k, v] = [argv[i], argv[i + 1]];
        if (k === '--n') opts.n = Number(v);
        else if (k === '--out') opts.out = v;
        else if (k === '--work-dir') opts.workDir = v;
        else if (k === '--claude-bin') opts.claudeBin = v;
        else throw new Error(`argumento desconhecido: ${k}`);
    }
    if (!Number.isInteger(opts.n) || opts.n < 1) throw new Error('--n inteiro >= 1');
    if (!opts.out) throw new Error('--out obrigatório');
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

// Sem medição = null/UNKNOWN. Só vira EFFECT_OBSERVED com controle recusado, todos os níveis
// aceitos e mediana(high) > mediana(low) medida de verdade.
function verdict({ control, byLevel }) {
    const rejected = LEVELS.filter(l => (byLevel[l] || []).some(r => r.exit_code !== 0));
    if (rejected.length) return { status: 'UNAVAILABLE', reason: `nível válido recusado: ${rejected.join(',')}` };
    const medians = Object.fromEntries(LEVELS.map(l => [l, median((byLevel[l] || []).map(r => r.output_tokens))]));
    if (control.exit_code === 0) {
        return { status: 'ACCEPTED_EFFECT_UNKNOWN', reason: 'controle inválido foi aceito: a flag pode estar sendo ignorada', medians };
    }
    if (medians.low === null || medians.high === null) {
        return { status: 'ACCEPTED_EFFECT_UNKNOWN', reason: 'sem medição de tokens de saída', medians };
    }
    if (medians.high > medians.low) {
        return { status: 'EFFECT_OBSERVED', reason: 'mediana de saída maior em high que em low; indício, não prova do mecanismo', medians };
    }
    return { status: 'ACCEPTED_EFFECT_UNKNOWN', reason: 'sem diferença mensurável entre low e high', medians };
}

function runProbe({ n, run, claudeVersion }) {
    const total = 1 + LEVELS.length * n;
    if (total > MAX_CALLS) throw new Error(`teto de ${MAX_CALLS} chamadas (pedido: ${total})`);
    const control = run({ level: CONTROL_LEVEL });
    const byLevel = {};
    for (const level of LEVELS) {
        byLevel[level] = [];
        for (let i = 0; i < n; i++) byLevel[level].push(run({ level }));
    }
    return { claude_version: claudeVersion, n, calls: total, control, by_level: byLevel, verdict: verdict({ control, byLevel }) };
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
        let outputTokens = null;
        try {
            const files = findClaudeTranscripts(sessionId, projects);
            if (files.length) outputTokens = sumClaudeUsage(files.map(f => ({ content: fs.readFileSync(f, 'utf8'), role: 'main' }))).output_tokens;
        } catch { /* sem transcript = UNKNOWN */ }
        return { exit_code: r.status, duration_ms: Date.now() - started, output_tokens: outputTokens };
    };
}

function markdown(report) {
    const rows = LEVELS.map(l => `| ${l} | ${report.by_level[l].map(r => r.output_tokens ?? 'UNKNOWN').join(', ')} | ${report.verdict.medians?.[l] ?? 'UNKNOWN'} |`);
    return [
        '# Probe do esforço (PRI-353, AC1)', '',
        `CLI: ${report.claude_version} · n por nível: ${report.n} · chamadas: ${report.calls}`,
        `Controle (\`--effort ${CONTROL_LEVEL}\`): exit ${report.control.exit_code}`, '',
        '| nível | tokens de saída | mediana |', '| -- | -- | -- |', ...rows, '',
        `**Veredito:** ${report.verdict.status}. ${report.verdict.reason}`, '',
        'Indício, não prova do mecanismo. Quem decide o U1 é o Richard.', '',
    ].join('\n');
}

function main() {
    const opts = parseArgs(process.argv.slice(2));
    const claudeVersion = execFileSync(opts.claudeBin, ['--version'], { encoding: 'utf8', env: agentEnv() }).trim();
    const workDir = ensureWorkDir(opts.workDir);
    const report = runProbe({ n: opts.n, run: realRunner({ claudeBin: opts.claudeBin, workDir }), claudeVersion });
    fs.mkdirSync(opts.out, { recursive: true });
    fs.writeFileSync(path.join(opts.out, 'effort-flag-probe.json'), JSON.stringify(report, null, 2) + '\n');
    fs.writeFileSync(path.join(opts.out, 'effort-flag-probe.md'), markdown(report));
    console.log(markdown(report));
}

if (require.main === module) main();

module.exports = { probeArgv, median, verdict, parseArgs, runProbe, LEVELS, PROMPT };
