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

test('PRI-214 MINOR-1: perfil pessoal — pluginConfigs skills-dir e skills/ também contam', () => {
    const account = { dir, source: 'dashboard' };
    const settings = path.join(dir, 'settings.json');
    const skillDir = path.join(dir, 'skills', 'jev-model-router');

    fs.writeFileSync(settings, JSON.stringify({
        pluginConfigs: { 'jev-model-router@skills-dir': { enabled: true } },
    }));
    assert.equal(accountCostMetadata(account, { prefsFile, home }).effort_router_plugin, 'LOADED');

    fs.writeFileSync(settings, JSON.stringify({
        enabledPlugins: { 'jev-model-router@typesafe': false },
        pluginConfigs: { 'jev-model-router@skills-dir': { enabled: false } },
    }));
    assert.equal(accountCostMetadata(account, { prefsFile, home }).effort_router_plugin, 'NOT_LOADED');

    fs.writeFileSync(settings, JSON.stringify({ enabledPlugins: {} }));
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '# stub\n');
    assert.equal(accountCostMetadata(account, { prefsFile, home }).effort_router_plugin, 'LOADED');
    fs.rmSync(path.join(dir, 'skills'), { recursive: true, force: true });
});

// ── PRI-233 (PRI-205 S4) T7 / SP-2: prova do plugin desligado no despacho roteado ──
const { routedPluginProof } = require('./claude-account');
const crypto = require('node:crypto');

function proofCase(name, setup) {
    const acc = path.join(root, `proof-${name}`);
    const run = path.join(root, `proof-${name}-run`);
    fs.mkdirSync(acc, { recursive: true });
    fs.mkdirSync(run, { recursive: true });
    setup(acc);
    return { acc, run };
}

test('PRI-233 SP-2: conta sem rastro do plugin → --settings gerado desliga e a prova é NOT_LOADED', () => {
    const { acc, run } = proofCase('limpa', () => {});
    const p = routedPluginProof({ accountDir: acc, runDir: run });
    assert.equal(p.status, 'NOT_LOADED');
    assert.equal(p.settings_path, path.join(run, 'routing-settings.json'));
    const bytes = fs.readFileSync(p.settings_path);
    assert.deepEqual(JSON.parse(bytes), { enabledPlugins: { 'jev-model-router@skills-dir': false } });
    assert.equal(p.settings_sha256, crypto.createHash('sha256').update(bytes).digest('hex'));
});

test('PRI-233 SP-2: plugin habilitado em enabledPlugins é sobrescrito como false no --settings', () => {
    const { acc, run } = proofCase('enabled', a => fs.writeFileSync(path.join(a, 'settings.json'),
        JSON.stringify({ enabledPlugins: { 'jev-model-router@mkt': true, 'outro@mkt': true } })));
    const p = routedPluginProof({ accountDir: acc, runDir: run });
    assert.equal(p.status, 'NOT_LOADED');
    assert.deepEqual(JSON.parse(fs.readFileSync(p.settings_path)).enabledPlugins,
        { 'jev-model-router@mkt': false, 'jev-model-router@skills-dir': false });
});

for (const [name, setup, reason] of [
    ['árvore skills/', a => { fs.mkdirSync(path.join(a, 'skills', 'jev-model-router'), { recursive: true }); }, 'skills_dir_not_neutralizable'],
    ['pluginConfigs ligado', a => fs.writeFileSync(path.join(a, 'settings.json'),
        JSON.stringify({ pluginConfigs: { 'jev-model-router@skills-dir': { enabled: true } } })), 'plugin_config_not_neutralizable'],
]) {
    test(`PRI-233 SP-2 / AC-08: ${name} não é neutralizável → LOADED, sem --settings`, () => {
        const { acc, run } = proofCase(name.replace(/\W+/g, '-'), setup);
        const p = routedPluginProof({ accountDir: acc, runDir: run });
        assert.deepEqual([p.status, p.reason], ['LOADED', reason]);
        assert.equal(fs.existsSync(path.join(run, 'routing-settings.json')), false);
    });
}

test('PRI-233 SP-2: settings.json da conta ilegível → UNKNOWN (ausência de prova nunca vira NOT_LOADED)', () => {
    const { acc, run } = proofCase('ilegivel', a => fs.writeFileSync(path.join(a, 'settings.json'), '{ quebrado'));
    assert.deepEqual(routedPluginProof({ accountDir: acc, runDir: run }), { status: 'UNKNOWN', reason: 'account_settings_unreadable' });
});

test('PRI-233 SP-2: falha ao gravar o --settings → UNKNOWN', () => {
    const { acc } = proofCase('sem-run', () => {});
    const p = routedPluginProof({ accountDir: acc, runDir: path.join(root, 'nao-existe', 'run') });
    assert.deepEqual([p.status, p.reason], ['UNKNOWN', 'settings_write_failed']);
});
