// node --test .claude/hooks/processo-level.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { decide } from './processo-level.mjs';

const HOOK = path.join(path.dirname(fileURLToPath(import.meta.url)), 'processo-level.mjs');

function project(level) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'processo-level-'));
    if (level !== undefined) {
        fs.mkdirSync(path.join(dir, '.prisma'));
        fs.writeFileSync(path.join(dir, '.prisma', 'level'), `${level}\n`);
    }
    return dir;
}

const write = (dir, file) => ({ hook_event_name: 'PreToolUse', tool_name: 'Write', cwd: dir, tool_input: { file_path: path.join(dir, file) } });

test('leve nega SPEC, handoff e evidence', () => {
    const dir = project('leve');
    for (const f of ['tasks/pri-1/SPEC.md', 'tasks/pri-1/SPEC-s2.md', 'tasks/pri-1/handoff-final.yaml', 'docs/handoff.yml', 'tasks/pri-1/evidence-ac1.md']) {
        const out = decide(write(dir, f), { CLAUDE_PROJECT_DIR: dir });
        assert.equal(out?.hookSpecificOutput?.permissionDecision, 'deny', f);
        assert.match(out.hookSpecificOutput.permissionDecisionReason, /Nível leve/);
    }
});

test('leve deixa passar arquivos comuns e caminhos fora do projeto', () => {
    const dir = project('leve');
    for (const f of ['README.md', 'scripts/lib/x.js', 'docs/SPEC-guide.md', 'templates/handoff.yaml.template']) {
        assert.equal(decide(write(dir, f), { CLAUDE_PROJECT_DIR: dir }), null, f);
    }
    const outside = { tool_input: { file_path: path.join(os.tmpdir(), 'tasks', 'x', 'SPEC.md') } };
    assert.equal(decide(outside, { CLAUDE_PROJECT_DIR: dir }), null);
});

test('worktree fora do projeto: usa o .prisma/level do checkout do arquivo', () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'processo-root-'));
    const wt = fs.mkdtempSync(path.join(os.tmpdir(), 'processo-wt-'));
    fs.writeFileSync(path.join(wt, '.git'), 'gitdir: x\n');
    fs.mkdirSync(path.join(wt, '.prisma'));
    fs.writeFileSync(path.join(wt, '.prisma', 'level'), 'leve\n');
    const out = decide({ tool_input: { file_path: path.join(wt, 'tasks', 'pri-1', 'SPEC.md') } }, { CLAUDE_PROJECT_DIR: project });
    assert.equal(out?.hookSpecificOutput?.permissionDecision, 'deny');
});

test('CLI chamado por symlink também nega', () => {
    const dir = project('leve');
    const link = fs.mkdtempSync(path.join(os.tmpdir(), 'processo-link-'));
    const linked = path.join(link, 'hooks');
    fs.symlinkSync(path.dirname(HOOK), linked);
    const ran = spawnSync(process.execPath, [path.join(linked, 'processo-level.mjs')], {
        input: JSON.stringify(write(dir, 'tasks/pri-9/SPEC.md')),
        env: { ...process.env, CLAUDE_PROJECT_DIR: dir },
        encoding: 'utf8',
    });
    assert.equal(JSON.parse(ran.stdout).hookSpecificOutput.permissionDecision, 'deny');
});

test('médio, alto ou sem .prisma/level não bloqueiam', () => {
    for (const level of ['medio', 'alto', undefined]) {
        const dir = project(level);
        assert.equal(decide(write(dir, 'tasks/pri-1/SPEC.md'), { CLAUDE_PROJECT_DIR: dir }), null, String(level));
    }
});

test('CLI: stdin JSON → saída de deny do PreToolUse', () => {
    const dir = project('leve');
    const ran = spawnSync(process.execPath, [HOOK], {
        input: JSON.stringify(write(dir, 'tasks/pri-9/SPEC.md')),
        env: { ...process.env, CLAUDE_PROJECT_DIR: dir },
        encoding: 'utf8',
    });
    assert.equal(ran.status, 0);
    const out = JSON.parse(ran.stdout);
    assert.equal(out.hookSpecificOutput.hookEventName, 'PreToolUse');
    assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');

    const free = spawnSync(process.execPath, [HOOK], {
        input: JSON.stringify(write(dir, 'README.md')),
        env: { ...process.env, CLAUDE_PROJECT_DIR: dir },
        encoding: 'utf8',
    });
    assert.equal(free.status, 0);
    assert.equal(free.stdout, '');
});
