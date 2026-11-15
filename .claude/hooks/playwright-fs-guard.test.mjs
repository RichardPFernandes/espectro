// node --test .claude/hooks/playwright-fs-guard.test.mjs
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { decide } from './playwright-fs-guard.mjs';

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pw-guard-')));
const env = { CLAUDE_PROJECT_DIR: tmp };
fs.mkdirSync(path.join(tmp, '.prisma/ui-verify/T-1'), { recursive: true });
const call = (tool_input, tool = 'mcp__playwright__browser_take_screenshot', e = env) => decide({ tool_name: tool, tool_input }, e);
const denied = (tool_input, tool, e) => call(tool_input, tool, e)?.hookSpecificOutput?.permissionDecision === 'deny';

test('sem filename nem url: passa (resposta volta como texto)', () => {
    assert.strictEqual(call({ depth: 3 }, 'mcp__playwright__browser_snapshot'), null);
});
test('filename em <task-id>/arquivo: passa', () => {
    assert.strictEqual(call({ filename: '.prisma/ui-verify/PRI-1/AC-1.png' }), null);
    assert.strictEqual(call({ filename: `${tmp}/.prisma/ui-verify/PRI-1/sub/x.yml` }), null);
});
test('arquivos na raiz de ui-verify e nomes de controle do CLI: nega', () => {
    for (const f of ['.prisma/ui-verify/server.json', '.prisma/ui-verify/server.lock/x', '.prisma/ui-verify/x.png', '.prisma/ui-state/server.json']) {
        assert.ok(denied({ filename: f }), f);
    }
});
test('filename que sobrescreve arquivo do repositório: nega', () => {
    for (const f of ['.mcp.json', '.claude/settings.json', 'dashboard/package.json', '.prisma/other.json', '/etc/passwd', '~/x.json', '.git/hooks/pre-commit']) {
        assert.ok(denied({ filename: f }), f);
    }
});
test('traversal e prefixo parecido: nega', () => {
    for (const f of ['.prisma/ui-verify/../../.mcp.json', '.prisma/ui-verify-evil/T/x.png', '.prisma/ui-verify', '.prisma/ui-verify/', '.prisma/ui-verify/T-1/../../x']) {
        assert.ok(denied({ filename: f }), f);
    }
});
test('symlink dentro de ui-verify apontando para fora: nega', () => {
    fs.symlinkSync(tmp, path.join(tmp, '.prisma/ui-verify/T-1/escape'));
    assert.ok(denied({ filename: '.prisma/ui-verify/T-1/escape/.mcp.json' }));
    assert.ok(denied({ filename: '.prisma/ui-verify/T-1/escape/novo/x.json' }));
});
test('filename que não é string, vazio, null com valor estranho ou com NUL: nega', () => {
    for (const f of ['', '   ', 5, {}, ['a'], '.prisma/ui-verify/T-1/a\0.png']) assert.ok(denied({ filename: f }), JSON.stringify(f));
    assert.strictEqual(call({ filename: null }, 'mcp__playwright__browser_snapshot'), null, 'null = sem filename (documentado)');
});
test('paths (upload/drop): nega sempre', () => {
    assert.ok(denied({ paths: ['/etc/passwd'] }, 'mcp__playwright__browser_file_upload'));
    assert.ok(denied({ paths: [] }, 'mcp__playwright__browser_drop'));
});
test('navigate/tabs: só http://localhost|127.0.0.1 na porta da verificação', () => {
    const nav = 'mcp__playwright__browser_navigate';
    for (const u of ['http://localhost:3399/', 'http://127.0.0.1:3399/x?y=1', 'http://localhost:3399']) assert.strictEqual(call({ url: u }, nav), null, u);
    for (const u of ['file:///etc/passwd', 'data:text/html,x', 'javascript:alert(1)', 'chrome://version', 'http://localhost:3400/', 'http://localhost:33990/', 'http://localhost:3399.evil.com/', 'https://example.com/', 5]) {
        assert.ok(denied({ url: u }, nav), String(u));
    }
    assert.ok(denied({ url: 'https://example.com', action: 'new' }, 'mcp__playwright__browser_tabs'));
    assert.strictEqual(call({ url: 'http://localhost:3410/' }, nav, { ...env, PRISMA_UI_PORT: '3410' }), null, 'segue PRISMA_UI_PORT');
    assert.ok(denied({ url: 'http://localhost:3399/' }, nav, { ...env, PRISMA_UI_PORT: '3399;x' }), 'porta malformada nega');
});
test('entrada sem tool_input: nega (fail-closed)', () => {
    assert.ok(decide({ tool_name: 'x' }, env)?.hookSpecificOutput?.permissionDecision === 'deny');
    assert.ok(decide(null, env)?.hookSpecificOutput?.permissionDecision === 'deny');
});
test('via stdin, como o Claude Code chama: JSON inválido, vazio e válido', () => {
    const script = path.join(path.dirname(fileURLToPath(import.meta.url)), 'playwright-fs-guard.mjs');
    const run = input => execFileSync(process.execPath, [script], { input, env: { ...process.env, CLAUDE_PROJECT_DIR: tmp }, encoding: 'utf8' });
    assert.match(run(JSON.stringify({ tool_input: { filename: '.mcp.json' } })), /"permissionDecision":"deny"/);
    assert.strictEqual(run(JSON.stringify({ tool_input: { filename: '.prisma/ui-verify/T-1/a.png' } })), '');
    assert.match(run('E{{{ não é json'), /"permissionDecision":"deny"/, 'JSON inválido nega');
    assert.match(run(''), /"permissionDecision":"deny"/, 'vazio nega');
});
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
