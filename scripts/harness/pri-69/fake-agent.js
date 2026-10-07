// `claude` falso da harness PRI-69 (instalado como <sandbox>/bin/claude). Processo real
// despachado pelo watcher (destacado sem --follow, filho com --follow); lê o roteiro do
// nó em HARNESS_SCENARIO e faz o que um agente faria pelas mesmas portas: transcript
// JSONL em $CLAUDE_CONFIG_DIR/projects (custo), state.json só pela CLI
// scripts/state-writer.js (com o STATE_EXECUTION_ID recebido), PR pelo
// scripts/bitbucket-open-pr.sh contra o Bitbucket falso, status pelo Redmine falso.
//
// Roteiro por nó (objeto, ou lista indexada pela n-ésima chamada daquele nó):
//   transcript {input, cache_read, output, model} | false   build: sobe `mvn` (→ `java`)
//   workMs: tempo "trabalhando"   hold: espera o arquivo HARNESS_RELEASE (o teste solta o nó)
//   transition: próximo nó   archive: status final
//   openPr   redmineStatus: id   printEnv: [VAR, ...] (stdout e stderr, após printAfterMs)
//   exitCode   sigterm: 'forward' (padrão: repassa aos filhos e sai 143) | 'abandon'
'use strict';
const fs = require('fs');
const path = require('path');
const { spawn, execFileSync } = require('child_process');

const argv = process.argv.slice(2);
const opt = name => { const i = argv.indexOf(name); return i === -1 ? null : argv[i + 1]; };
const prompt = opt('-p') || '';
const sessionId = opt('--session-id');
const NODE_OF = { 'fetch-ticket': 'fetch_ticket', plan: 'plan', implement: 'implement', review: 'review', test: 'test', verify: 'verify', commit: 'commit' };
const m = /\/(fetch-ticket|plan|implement|review|test|verify|commit) ([^\s,.]+)/.exec(prompt);
const node = m ? NODE_OF[m[1]] : null;
const taskArg = m ? m[2] : null;
const cwd = process.cwd();
const scriptsDir = process.env.HARNESS_SCRIPTS;

function append(file, obj) {
    if (file) fs.appendFileSync(file, JSON.stringify({ at: new Date().toISOString(), pid: process.pid, ...obj }) + '\n');
}

function previousCalls(n) {
    try {
        return fs.readFileSync(process.env.HARNESS_CALLS, 'utf8').split('\n').filter(Boolean)
            .map(l => JSON.parse(l)).filter(c => c.event === 'start' && c.node === n).length;
    } catch { return 0; }
}

function loadStep() {
    let scenario = {};
    try { scenario = JSON.parse(fs.readFileSync(process.env.HARNESS_SCENARIO, 'utf8')); } catch {}
    const entry = (scenario.nodes || {})[node];
    if (Array.isArray(entry)) return entry[Math.min(previousCalls(node), entry.length - 1)] || {};
    return entry || {};
}

const step = loadStep();
append(process.env.HARNESS_CALLS, {
    event: 'start', node, task_arg: taskArg, cwd, ppid: process.ppid, session_id: sessionId,
    claude_config_dir: process.env.CLAUDE_CONFIG_DIR || null,
    state_execution_id: process.env.STATE_EXECUTION_ID || null,
    recovery_note: /RECUPERAÇÃO/.test(prompt),
    prompt_commands: (prompt.match(/\/(fetch-ticket|plan|implement|review|test|verify|commit) [^\s,.]+/g) || []),
});

const taskDir = node && node !== 'fetch_ticket' ? path.join(cwd, 'memory', 'runs', taskArg) : null;

function stateCli(args) {
    return execFileSync(process.execPath, [path.join(scriptsDir, 'state-writer.js'), ...args], { encoding: 'utf8', env: process.env });
}

function writeTranscript() {
    if (step.transcript === false || !sessionId) return;
    const t = { input: 100, cache_read: 900, output: 100, model: 'claude-sonnet-5', ...(step.transcript || {}) };
    const base = process.env.CLAUDE_CONFIG_DIR || path.join(process.env.HOME, '.claude');
    const dir = path.join(base, 'projects', 'harness-project');
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, `${sessionId}.jsonl`), JSON.stringify({
        type: 'assistant', timestamp: new Date().toISOString(), sessionId,
        message: { id: `msg-${sessionId}`, model: t.model, role: 'assistant', content: [{ type: 'text', text: `nó ${node} (harness)` }],
            usage: { input_tokens: t.input, cache_read_input_tokens: t.cache_read, output_tokens: t.output } },
    }) + '\n');
}

let children = [];
let finishing = false;

function finish(code) {
    if (finishing) return;
    finishing = true;
    append(process.env.HARNESS_CALLS, { event: 'exit', node, code });
    process.exit(code);
}

process.on('SIGTERM', () => {
    append(process.env.HARNESS_CALLS, { event: 'sigterm', node, children: children.map(c => c.pid) });
    if (step.sigterm === 'abandon') return finish(143);
    const alive = children.filter(c => c.exitCode === null && c.signalCode === null);
    if (!alive.length) return finish(143);
    let left = alive.length;
    for (const c of alive) {
        c.once('exit', () => { if (--left === 0) finish(143); });
        try { c.kill('SIGTERM'); } catch {}
    }
    setTimeout(() => finish(143), 5000).unref();
});

async function sleep(ms) { await new Promise(r => setTimeout(r, ms)); }

async function main() {
    writeTranscript();
    if (step.printEnv) {
        if (step.printAfterMs) await sleep(step.printAfterMs);
        for (const name of step.printEnv) {
            process.stdout.write(`out ${process.env[name] || ''}\n`);
            process.stderr.write(`err ${process.env[name] || ''}\n`);
        }
        append(process.env.HARNESS_CALLS, { event: 'printed', node, vars: step.printEnv, lengths: step.printEnv.map(n => (process.env[n] || '').length) });
    }
    if (step.build) {
        const mvn = spawn('mvn', ['-q', 'test'], { cwd, stdio: ['ignore', 'inherit', 'inherit'] });
        children.push(mvn);
        append(process.env.HARNESS_CALLS, { event: 'spawned', node, child: 'mvn', child_pid: mvn.pid });
    }
    if (step.hold) {
        const flag = process.env.HARNESS_RELEASE;
        const until = Date.now() + (step.holdMs || 90000);
        while (flag && !fs.existsSync(flag)) {
            if (Date.now() > until) {
                append(process.env.HARNESS_CALLS, { event: 'hold_timeout', node });
                break;
            }
            await sleep(40);
        }
    }
    if (step.workMs) await sleep(step.workMs);
    if (step.redmineStatus) {
        const ticketId = String(taskArg).split('-')[0];
        await fetch(`${process.env.REDMINE_URL}/issues/${ticketId}.json`, {
            method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-Redmine-API-Key': process.env.REDMINE_API_KEY || '' },
            body: JSON.stringify({ issue: { status_id: step.redmineStatus } }),
        });
    }
    if (step.openPr) {
        const bb = JSON.parse(fs.readFileSync(process.env.HARNESS_BB_ENV, 'utf8'));
        const ticketId = String(taskArg).split('-')[0];
        const url = execFileSync('bash', [path.join(scriptsDir, 'bitbucket-open-pr.sh'), 'app-back', ticketId, 'development', `Melhoria #${ticketId} - harness`],
            { cwd, input: 'PR da harness PRI-69\n', encoding: 'utf8', env: { ...process.env, ...bb } }).trim();
        const patch = path.join(taskDir, '.harness-pr-patch.json');
        fs.writeFileSync(patch, JSON.stringify({ pull_request: { 'app-back': { url } }, pr_status: 'draft', pr_id: Number(url.split('/').pop()) }));
        stateCli(['set', taskDir, `--input=${patch}`]);
        fs.rmSync(patch);
    }
    if (step.transition && taskDir) stateCli(['transition', taskDir, `--from=${node}`, `--to=${step.transition}`]);
    if (step.archive && taskDir) {
        const to = path.join(path.dirname(taskDir), '_archive', path.basename(taskDir));
        stateCli(['archive', taskDir, `--to=${to}`, `--status=${step.archive}`, '--expected-node=commit']);
    }
    finish(step.exitCode ?? 0);
}

main().catch(e => {
    append(process.env.HARNESS_CALLS, { event: 'error', node, error: e.message });
    finish(1);
});
