const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { accountCostMetadata } = require('./claude-account');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pri-210-account-'));
const home = path.join(root, 'home');
const dir = path.join(home, '.claude-personal');
const prefsFile = path.join(root, 'prefs.json');
fs.mkdirSync(dir, { recursive: true });
test.after(() => fs.rmSync(root, { recursive: true, force: true }));

test('PRI-210: account.label exige mapa explícito; caminhos e rótulos inválidos viram UNKNOWN', () => {
    const account = { dir, source: 'dashboard' };
    assert.deepEqual(accountCostMetadata(account, { prefsFile, home }).account, { source: 'dashboard', label: 'UNKNOWN' });
    fs.writeFileSync(prefsFile, JSON.stringify({ claude_account_labels: { '~/.claude-personal': 'personal' } }));
    assert.deepEqual(accountCostMetadata(account, { prefsFile, home }).account, { source: 'dashboard', label: 'personal' });
    for (const label of ['/tmp/personal', '~/personal', 'C:\\personal', 'account/name', ['personal'], null]) {
        fs.writeFileSync(prefsFile, JSON.stringify({ claude_account_labels: { [dir]: label } }));
        assert.equal(accountCostMetadata(account, { prefsFile, home }).account.label, 'UNKNOWN');
    }
    fs.writeFileSync(prefsFile, JSON.stringify({ claude_account_labels: { default: 'team' } }));
    assert.equal(accountCostMetadata({ dir: null, source: 'default' }, { prefsFile, home }).account.label, 'team');
    assert.equal(accountCostMetadata(account, { prefsFile, home }).account.label, 'UNKNOWN', 'não inferir pelo basename');
});

test('PRI-210: estado do plugin somente quando observado; ausência não prova NOT_LOADED', () => {
    const account = { dir, source: 'env' };
    const settings = path.join(dir, 'settings.json');
    assert.equal(accountCostMetadata(account, { prefsFile, home }).effort_router_plugin, 'UNKNOWN');
    for (const [enabledPlugins, expected] of [
        [{ 'jev-model-router@typesafe': true }, 'LOADED'],
        [{ 'jev-model-router@typesafe': false }, 'NOT_LOADED'],
        [{ unrelated: true }, 'UNKNOWN'],
    ]) {
        fs.writeFileSync(settings, JSON.stringify({ enabledPlugins }));
        assert.equal(accountCostMetadata(account, { prefsFile, home }).effort_router_plugin, expected);
    }
    fs.writeFileSync(settings, '{');
    assert.equal(accountCostMetadata(account, { prefsFile, home }).effort_router_plugin, 'UNKNOWN');
});
