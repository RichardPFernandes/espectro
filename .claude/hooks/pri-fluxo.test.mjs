// node --test .claude/hooks/pri-fluxo.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { decide } from './pri-fluxo.mjs';

const HOOK = path.join(path.dirname(fileURLToPath(import.meta.url)), 'pri-fluxo.mjs');
const g = (cwd, ...a) => execFileSync('git', ['-C', cwd, ...a], { encoding: 'utf8' }).trim();

function repo({ level = 'leve', ctx = true, branch = 'pri-9' } = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pri-fluxo-'));
    g(dir, 'init', '-q', '-b', branch);
    g(dir, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'x');
    if (level) {
        fs.mkdirSync(path.join(dir, '.prisma'));
        fs.writeFileSync(path.join(dir, '.prisma', 'level'), `${level}\n`);
        if (ctx) fs.writeFileSync(path.join(dir, '.prisma', 'context.json'), JSON.stringify({ issue: 'PRI-9', branch }));
    }
    return dir;
}
function evidence(dir, home, check) {
    const sha = g(dir, 'rev-parse', '--short', 'HEAD');
    const d = path.join(home, 'Workspace', 'prisma-evidence', 'PRI-9', sha);
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, 'check.json'), JSON.stringify({ sha: g(dir, 'rev-parse', 'HEAD'), ...check }));
}
const pr = (dir) => ({ hook_event_name: 'PreToolUse', tool_name: 'Bash', cwd: dir, tool_input: { command: 'gh pr create --draft --base main' } });
const reason = (o) => o?.hookSpecificOutput?.permissionDecisionReason || '';

test('gh pr create sem sessão de dev passa', () => {
    assert.equal(decide(pr(repo({ level: null })), { HOME: os.tmpdir() }), null);
});

test('gh pr create sem context.json, sem check.json ou com revisão FAIL nega', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'home-'));
    assert.match(reason(decide(pr(repo({ ctx: false })), { HOME: home })), /rode \/pri-start/);
    const dir = repo();
    assert.match(reason(decide(pr(dir), { HOME: home })), /Falta .*check\.json/);
    evidence(dir, home, { revisao: { veredito: 'FAIL' } });
    assert.match(reason(decide(pr(dir), { HOME: home })), /não está PASS/);
});

test('gh pr create com check.json PASS no HEAD passa; commit novo exige check de novo', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'home-'));
    const dir = repo();
    evidence(dir, home, { revisao: { veredito: 'PASS' } });
    assert.equal(decide(pr(dir), { HOME: home }), null);
    g(dir, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'y');
    assert.match(reason(decide(pr(dir), { HOME: home })), /Falta/);
});

test('context.json de outra branch nega', () => {
    const dir = repo();
    g(dir, 'switch', '-q', '-c', 'outra');
    assert.match(reason(decide(pr(dir), { HOME: os.tmpdir() })), /é da branch pri-9/);
});

test('outros comandos Bash passam, inclusive texto que só cita gh pr create', () => {
    for (const command of ['gh pr view 1', "git commit -F - <<'EOF'\nnega gh pr create sem check\nEOF", 'echo "gh pr create"']) {
        assert.equal(decide({ ...pr(repo()), tool_input: { command } }, { HOME: os.tmpdir() }), null, command);
    }
    assert.notEqual(decide({ ...pr(repo()), tool_input: { command: 'cd x && gh pr create --draft' } }, { HOME: os.tmpdir() }), null);
});

test('revisor não escreve; agente principal e outros subagentes escrevem', () => {
    const w = (agent_type) => ({ hook_event_name: 'PreToolUse', tool_name: 'Edit', agent_type, tool_input: { file_path: '/x' } });
    for (const a of ['agent-skills:code-reviewer', 'code-reviewer', 'agent-skills:security-auditor', 'agent-skills:test-engineer']) {
        assert.equal(decide(w(a))?.hookSpecificOutput?.permissionDecision, 'deny', a);
    }
    for (const a of [undefined, 'general-purpose', 'test-writer']) assert.equal(decide(w(a)), null, String(a));
});

test('comando do grafo bloqueado só em sessão de dev; agent-skills e pri-* passam', () => {
    const ev = (cwd, command_name) => ({ hook_event_name: 'UserPromptExpansion', cwd, command_name });
    const dev = repo();
    assert.equal(decide(ev(dev, 'plan'))?.decision, 'block');
    assert.equal(decide(ev(dev, 'fetch-ticket'))?.decision, 'block');
    for (const c of ['agent-skills:plan', 'pri-plan', 'pri-check']) assert.equal(decide(ev(dev, c)), null, c);
    assert.equal(decide(ev(repo({ level: null }), 'plan')), null);
});

test('CLI: lê stdin e devolve o bloqueio em JSON', () => {
    const r = spawnSync(process.execPath, [HOOK], { input: JSON.stringify({ hook_event_name: 'UserPromptExpansion', cwd: repo(), command_name: 'review' }), encoding: 'utf8' });
    assert.equal(r.status, 0);
    assert.equal(JSON.parse(r.stdout).decision, 'block');
});
