// node --test claude-account-api.test.js
// /api/claude/accounts, /api/claude/usage e a troca de conta via /api/watcher/prefs,
// com contas e sondagem falsas (nenhuma chamada real ao Claude).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createDashboard } = require('./server');
const claudeAccount = require('../scripts/lib/claude-account');
const { parseProbeOutput } = require('../scripts/lib/claude-usage');

const tmpBase = process.env.CLAUDE_JOB_DIR ? path.join(process.env.CLAUDE_JOB_DIR, 'tmp') : os.tmpdir();
const tmp = fs.mkdtempSync(path.join(tmpBase, 'claude-account-api-'));
fs.mkdirSync(path.join(tmp, 'memory', 'runs'), { recursive: true });
const home = path.join(tmp, 'home');
fs.mkdirSync(path.join(home, '.claude-personal'), { recursive: true });
fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
fs.writeFileSync(path.join(home, '.claude-arquivo'), '');   // arquivo, não pasta: ignorado

const prefsFile = path.join(tmp, 'dashboard-prefs.json');
const probes = [];
const dash = createDashboard({
    memoryDir: path.join(tmp, 'memory', 'runs'), worktreesDir: path.join(tmp, 'wt'), prefsFile,
    listClaudeAccounts: () => claudeAccount.listClaudeAccounts(home),
    probeClaudeUsage: async ({ configDir }) => {
        probes.push(configDir);
        return { ok: true, status: 'allowed', windows: { five_hour: { utilization: 0.4, resets_at: null } }, checked_at: new Date().toISOString() };
    },
});
let base;
const savedEnv = process.env.WATCHER_CLAUDE_CONFIG_DIR;

test.before(async () => {
    delete process.env.WATCHER_CLAUDE_CONFIG_DIR;
    await new Promise(r => dash.server.listen(0, '127.0.0.1', r));
    base = `http://localhost:${dash.server.address().port}`;
    await dash.ready;
});
test.after(async () => {
    if (savedEnv !== undefined) process.env.WATCHER_CLAUDE_CONFIG_DIR = savedEnv;
    await dash.close();
    fs.rmSync(tmp, { recursive: true, force: true });
});

async function call(method, p, body) {
    const res = await fetch(base + p, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body && JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
}

test('lista ~/.claude e as pastas ~/.claude-<nome>; sem escolha, usa a conta padrão', async () => {
    const r = await call('GET', '/api/claude/accounts');
    assert.deepStrictEqual(r.body.accounts, [{ id: 'default', label: 'padrão' }, { id: '~/.claude-personal', label: 'personal' }]);
    assert.strictEqual(r.body.selected, 'default');
    assert.strictEqual(r.body.source, 'default');
});

test('troca de conta grava no prefs e o spawn dos agentes passa a usar CLAUDE_CONFIG_DIR dela', async () => {
    const r = await call('PUT', '/api/watcher/prefs', { claude_config_dir: '~/.claude-personal' });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.claude_config_dir, '~/.claude-personal');
    const acc = await call('GET', '/api/claude/accounts');
    assert.strictEqual(acc.body.selected, '~/.claude-personal');
    assert.strictEqual(acc.body.source, 'dashboard');
    const env = claudeAccount.withClaudeAccount({}, {}, { prefsFile });
    assert.strictEqual(env.CLAUDE_CONFIG_DIR, path.join(os.homedir(), '.claude-personal'));
});

test('recusa conta que não existe na máquina (nada de caminho arbitrário)', async () => {
    const r = await call('PUT', '/api/watcher/prefs', { claude_config_dir: '/tmp/qualquer' });
    assert.strictEqual(r.status, 400);
    const bad = await call('PUT', '/api/watcher/prefs', {});
    assert.strictEqual(bad.status, 400);
});

test('auto_start continua funcionando sozinho e preserva a conta', async () => {
    const r = await call('PUT', '/api/watcher/prefs', { auto_start: true });
    assert.strictEqual(r.body.auto_start, true);
    assert.strictEqual(r.body.claude_config_dir, '~/.claude-personal');
});

test('uso: sonda uma vez, depois devolve o cache até ?refresh=1', async () => {
    probes.length = 0;
    const a = await call('GET', '/api/claude/usage');
    assert.strictEqual(a.body.ok, true);
    assert.strictEqual(a.body.cached, false);
    assert.strictEqual(a.body.account.id, '~/.claude-personal');
    const b = await call('GET', '/api/claude/usage');
    assert.strictEqual(b.body.cached, true);
    await call('GET', '/api/claude/usage?refresh=1');
    assert.strictEqual(probes.length, 2);
});

test('"default" no prefs volta pra conta padrão mesmo com WATCHER_CLAUDE_CONFIG_DIR no .env', () => {
    fs.writeFileSync(prefsFile, JSON.stringify({ claude_config_dir: 'default' }));
    const env = claudeAccount.withClaudeAccount({}, { WATCHER_CLAUDE_CONFIG_DIR: '~/.claude-personal' }, { prefsFile });
    assert.strictEqual(env.CLAUDE_CONFIG_DIR, undefined);
    fs.writeFileSync(prefsFile, JSON.stringify({}));
    const fromEnv = claudeAccount.withClaudeAccount({}, { WATCHER_CLAUDE_CONFIG_DIR: '~/.claude-personal' }, { prefsFile });
    assert.strictEqual(fromEnv.CLAUDE_CONFIG_DIR, path.join(os.homedir(), '.claude-personal'));
});

test('parser do stream-json: janelas, reset em ISO e erro quando não há rate_limit_event', () => {
    const out = [
        '{"type":"system","subtype":"init"}',
        '{"type":"rate_limit_event","rate_limit_info":{"status":"allowed_warning","resetsAt":1790910000,"rateLimitType":"seven_day","utilization":0.77,"isUsingOverage":false,"unifiedWindows":{"five_hour":{"utilization":0.85,"resetsAt":1790724600},"seven_day":{"utilization":0.77,"resetsAt":1790910000}}}}',
        '{"type":"result","is_error":false,"result":"ok"}',
    ].join('\n');
    const r = parseProbeOutput(out);
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.status, 'allowed_warning');
    assert.strictEqual(r.windows.five_hour.utilization, 0.85);
    assert.strictEqual(r.windows.seven_day.resets_at, new Date(1790910000 * 1000).toISOString());
    const fail = parseProbeOutput('{"type":"result","is_error":true,"result":"Invalid API key · Please run /login"}');
    assert.strictEqual(fail.ok, false);
    assert.match(fail.error, /login/);
});
