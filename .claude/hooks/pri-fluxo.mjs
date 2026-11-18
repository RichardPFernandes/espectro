#!/usr/bin/env node
// Hooks do fluxo de desenvolvimento (CLAUDE.md, "Fluxo de desenvolvimento").
// Só agem numa sessão de dev: checkout com `.prisma/level` (gravado pelo
// /pri-start). Sem o arquivo, nada é bloqueado — o watcher e o piloto que rodam
// o grafo neste repo não são afetados.
//  - PreToolUse Bash `gh pr create`: exige check.json do /pri-check no HEAD.
//  - PreToolUse Bash `git commit`/`git push`: nega se o PR da branch já foi
//    mesclado ou fechado (o commit ficaria só na worktree e se perderia).
//  - PreToolUse Write|Edit|NotebookEdit em subagente revisor: nega escrita.
//  - UserPromptExpansion de comando do grafo do consumidor: bloqueia.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const REVISORES = /^(agent-skills:)?(code-reviewer|security-auditor|test-engineer)$/;
export const GRAFO = new Set(['plan', 'implement', 'implement-step', 'implement-integrate', 'review',
    'test', 'verify', 'verify-ui', 'commit', 'fetch-ticket', 'init-project']);

const git = (cwd, ...args) => {
    try { return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return null; }
};
// Raiz do checkout com sessão de dev, ou null.
export function devRoot(cwd) {
    const root = git(cwd, 'rev-parse', '--show-toplevel');
    return root && fs.existsSync(path.join(root, '.prisma', 'level')) ? root : null;
}
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const deny = (reason) => ({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } });

export function prGate(input, env = process.env) {
    const root = devRoot(input.cwd || process.cwd());
    if (!root) return null;
    const ctx = readJson(path.join(root, '.prisma', 'context.json'));
    if (!ctx?.issue) return deny('Sem .prisma/context.json: rode /pri-start antes de abrir o PR.');
    const branch = git(root, 'branch', '--show-current');
    if (ctx.branch && ctx.branch !== branch) return deny(`.prisma/context.json é da branch ${ctx.branch}, não de ${branch}: rode /pri-start de novo.`);
    const sha = git(root, 'rev-parse', '--short', 'HEAD');
    const home = env.HOME || os.homedir();
    const file = path.join(home, 'Workspace', 'prisma-evidence', ctx.issue, sha || '?', 'check.json');
    const check = readJson(file);
    if (!check) return deny(`Falta ${file}: rode /pri-check no HEAD (${sha}) antes do PR.`);
    if (!String(check.sha || '').startsWith(sha)) return deny(`check.json é de ${check.sha}, não do HEAD ${sha}: rode /pri-check de novo.`);
    if (check.revisao?.veredito !== 'PASS') return deny(`Revisão do /pri-check não está PASS (${check.revisao?.veredito ?? 'ausente'}).`);
    return null;
}

// Estado do PR da branch atual pelo gh: 'MERGED' | 'CLOSED' | 'OPEN' | null.
// Sem remote `origin` ou sem gh, null: o hook não bloqueia sem saber.
export function prStateDaBranch(root) {
    const branch = git(root, 'branch', '--show-current');
    if (!branch || !git(root, 'remote', 'get-url', 'origin')) return null;
    try {
        const out = execFileSync('gh', ['pr', 'view', branch, '--json', 'state,number'],
            { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 8000 });
        return JSON.parse(out);
    } catch { return null; }
}

export function branchJaMesclada(input, deps = {}) {
    const root = devRoot(input.cwd || process.cwd());
    if (!root) return null;
    const pr = (deps.prState || prStateDaBranch)(root);
    if (!pr || !['MERGED', 'CLOSED'].includes(pr.state)) return null;
    const estado = pr.state === 'MERGED' ? 'mesclado' : 'fechado';
    return deny(`O PR #${pr.number} desta branch já foi ${estado}: um commit aqui fica só na worktree e se perde. ` +
        'Crie uma branch nova a partir de origin/main e abra outro PR (por exemplo, para marcar a fatia no FASE.md).');
}

export function revisorSomenteLeitura(input) {
    if (!REVISORES.test(String(input.agent_type || ''))) return null;
    if (!devRoot(input.cwd || process.cwd())) return null;
    return deny(`O revisor (${input.agent_type}) não edita arquivos: devolva os achados com arquivo:linha.`);
}

export function grafoForaDoDev(input) {
    if (!GRAFO.has(String(input.command_name || ''))) return null;
    if (!devRoot(input.cwd || process.cwd())) return null;
    return { decision: 'block', reason: `/${input.command_name} é do grafo do consumidor e não vale no desenvolvimento do Prisma. Use os comandos /pri-* (CLAUDE.md, "Fluxo de desenvolvimento").` };
}

// `gh pr create` como comando: início de um segmento de qualquer linha, aceitando
// `(`, variáveis de ambiente e `-R dono/repo`. Texto no meio de mensagem não conta.
const PR_CREATE = /^\s*\(?\s*(?:\w+=\S+\s+)*gh\s+(?:-R\s+\S+\s+)?pr\s+create\b/;
export function isPrCreate(command) {
    return String(command || '').split(/\n|&&|\|\||;|\|/).some((seg) => PR_CREATE.test(seg));
}

// `git commit` ou `git push` como comando, com as mesmas regras de segmento.
const GIT_WRITE = /^\s*\(?\s*(?:\w+=\S+\s+)*git\s+(?:-C\s+\S+\s+|-c\s+\S+\s+)*(?:commit|push)\b/;
export function isGitWrite(command) {
    return String(command || '').split(/\n|&&|\|\||;|\|/).some((seg) => GIT_WRITE.test(seg));
}

export function decide(input, env = process.env, deps = {}) {
    if (input.hook_event_name === 'UserPromptExpansion') return grafoForaDoDev(input);
    if (input.hook_event_name !== 'PreToolUse') return null;
    if (input.tool_name === 'Bash') {
        const command = input.tool_input?.command;
        if (isPrCreate(command)) return prGate(input, env);
        return isGitWrite(command) ? branchJaMesclada(input, deps) : null;
    }
    if (['Write', 'Edit', 'NotebookEdit'].includes(input.tool_name)) return revisorSomenteLeitura(input);
    return null;
}

async function main() {
    let raw = '';
    for await (const chunk of process.stdin) raw += chunk;
    const out = decide(JSON.parse(raw || '{}'));
    if (out) process.stdout.write(JSON.stringify(out));
}

const invoked = (() => { try { return pathToFileURL(fs.realpathSync(process.argv[1])).href; } catch { return ''; } })();
if (invoked && import.meta.url === invoked) {
    // Falha do hook não bloqueia (exit ≠ 2); a barreira final é o CI.
    main().catch((e) => { console.error(`pri-fluxo: ${e.message}`); process.exitCode = 1; });
}
