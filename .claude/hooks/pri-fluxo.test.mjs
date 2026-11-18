// node --test .claude/hooks/pri-fluxo.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { decide, isPrCreate, isGitWrite, GRAFO } from './pri-fluxo.mjs';

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
    const dev = repo();
    const w = (agent_type) => ({ hook_event_name: 'PreToolUse', tool_name: 'Edit', cwd: dev, agent_type, tool_input: { file_path: '/x' } });
    for (const a of ['agent-skills:code-reviewer', 'code-reviewer', 'agent-skills:security-auditor', 'agent-skills:test-engineer']) {
        assert.equal(decide(w(a))?.hookSpecificOutput?.permissionDecision, 'deny', a);
    }
    for (const a of [undefined, 'general-purpose', 'test-writer']) assert.equal(decide(w(a)), null, String(a));
    // Fora da sessão de dev (piloto do grafo neste repo), o revisor escreve.
    assert.equal(decide({ ...w('agent-skills:test-engineer'), cwd: repo({ level: null }) }), null);
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

test('isPrCreate pega variações de comando', () => {
    for (const c of ['git push\ngh pr create', 'FOO=1 gh pr create', 'gh -R a/b pr create', '(gh pr create)']) assert.equal(isPrCreate(c), true, c);
});

test('matcher do UserPromptExpansion em settings.json cobre exatamente o GRAFO', () => {
    const settings = JSON.parse(fs.readFileSync(path.join(path.dirname(HOOK), '..', 'settings.json'), 'utf8'));
    const re = new RegExp(settings.hooks.UserPromptExpansion[0].matcher);
    const cmds = fs.readdirSync(path.join(path.dirname(HOOK), '..', 'commands')).map((f) => f.replace(/\.md$/, ''));
    assert.deepEqual(cmds.filter((c) => re.test(c)).sort(), [...GRAFO].sort());
    for (const c of ['agent-skills:plan', 'pri-plan']) assert.equal(re.test(c), false, c);
});

test('git commit e git push negam quando o PR da branch já foi mesclado ou fechado', () => {
    const dir = repo();
    const bash = (command) => ({ hook_event_name: 'PreToolUse', tool_name: 'Bash', cwd: dir, tool_input: { command } });
    const merged = { prState: () => ({ state: 'MERGED', number: 7 }) };
    assert.match(reason(decide(bash('git commit -m x'), {}, merged)), /PR #7 desta branch já foi mesclado.*branch nova a partir de origin\/main/);
    assert.match(reason(decide(bash('cd x && git push -u origin HEAD'), {}, { prState: () => ({ state: 'CLOSED', number: 8 }) })), /fechado/);
    assert.equal(decide(bash('git commit -m x'), {}, { prState: () => ({ state: 'OPEN', number: 9 }) }), null);
    assert.equal(decide(bash('git commit -m x'), {}, { prState: () => null }), null);
    // Fora da sessão de dev, nada é consultado.
    assert.equal(decide({ ...bash('git commit -m x'), cwd: repo({ level: null }) }, {}, merged), null);
    // Sem remote origin, o padrão não chama o gh e não bloqueia.
    assert.equal(decide(bash('git commit -m x'), {}), null);
});

test('isGitWrite pega commit e push, não status nem texto', () => {
    for (const c of ['git commit -m x', 'git -C /w push', 'git -c a=b commit -q', 'A=1 git push']) assert.equal(isGitWrite(c), true, c);
    for (const c of ['git status', 'echo "git commit"', 'git log --grep commit', 'git commit-tree x', 'git push-x']) assert.equal(isGitWrite(c), false, c);
});

test('git push --delete da branch mesclada passa (limpeza)', () => {
    const dir = repo();
    const merged = { prState: () => ({ state: 'MERGED', number: 7 }) };
    const bash = (command) => ({ hook_event_name: 'PreToolUse', tool_name: 'Bash', cwd: dir, tool_input: { command } });
    assert.equal(decide(bash('git push origin --delete pri-9'), {}, merged), null);
    assert.notEqual(decide(bash('git push origin pri-9'), {}, merged), null);
});

test('settings.json leva o hook a gh pr create, git commit e git push', () => {
    const settings = JSON.parse(fs.readFileSync(path.join(path.dirname(HOOK), '..', 'settings.json'), 'utf8'));
    const bash = settings.hooks.PreToolUse.filter((h) => h.matcher === 'Bash').flatMap((h) => h.hooks)
        .filter((h) => h.command.includes('pri-fluxo.mjs'));
    const ifs = bash.map((h) => h.if);
    for (const rule of ['Bash(gh pr create *)', 'Bash(git commit *)', 'Bash(git push *)']) assert.ok(ifs.includes(rule), rule);
});
