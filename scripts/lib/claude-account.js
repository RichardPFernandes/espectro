// Conta do Claude Code usada pelos agentes que o watcher/dashboard despacham.
// Os spawns limpam toda variável CLAUDE* herdada (pra não vazar a sessão de quem
// subiu o processo), então a conta volta aqui como CLAUDE_CONFIG_DIR, vinda de:
//   1. dashboard/dashboard-prefs.json > claude_config_dir — o seletor "Conta do
//      Claude" do painel Watcher. Lido a cada spawn: trocar lá vale no próximo nó,
//      sem reiniciar o watcher. "default" = conta padrão do CLI (~/.claude).
//   2. WATCHER_CLAUDE_CONFIG_DIR no .env — sem o prefixo CLAUDE, sobrevive à limpeza.
// Nenhum dos dois = conta padrão do CLI. Aceita ~ no começo.
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DEFAULT_PREFS_FILE = path.join(process.env.REPO_PATH || process.cwd(), 'dashboard', 'dashboard-prefs.json');
const DEFAULT_ACCOUNT = 'default';

const expandHome = (dir, home = os.homedir()) => dir.replace(/^~(?=$|\/)/, home);

function readPrefsAccount(prefsFile = process.env.DASHBOARD_PREFS_FILE || DEFAULT_PREFS_FILE) {
    try {
        const v = JSON.parse(fs.readFileSync(prefsFile, 'utf8')).claude_config_dir;
        return typeof v === 'string' && v.trim() ? v.trim() : null;
    } catch { return null; }
}

// { dir: caminho absoluto ou null (conta padrão), source: 'dashboard' | 'env' | 'default' }
function resolveClaudeAccount(source = process.env, { prefsFile } = {}) {
    const pref = readPrefsAccount(prefsFile);
    if (pref) return { dir: pref === DEFAULT_ACCOUNT ? null : expandHome(pref), source: 'dashboard' };
    const env = (source.WATCHER_CLAUDE_CONFIG_DIR || '').trim();
    if (env) return { dir: expandHome(env), source: 'env' };
    return { dir: null, source: 'default' };
}

function withClaudeAccount(env, source = process.env, opts) {
    const { dir } = resolveClaudeAccount(source, opts);
    if (dir) env.CLAUDE_CONFIG_DIR = dir;
    return env;
}

// Contas instaladas na máquina: ~/.claude (padrão) + toda pasta ~/.claude-<nome>
// (convenção de CLAUDE_CONFIG_DIR por conta, ex: a função claude-personal do zshrc).
function listClaudeAccounts(home = os.homedir()) {
    const accounts = [{ id: DEFAULT_ACCOUNT, label: 'padrão', dir: path.join(home, '.claude') }];
    let entries = [];
    try { entries = fs.readdirSync(home, { withFileTypes: true }); } catch {}
    for (const e of entries) {
        const m = e.isDirectory() && /^\.claude-([\w.-]+)$/.exec(e.name);
        if (m) accounts.push({ id: `~/${e.name}`, label: m[1], dir: path.join(home, e.name) });
    }
    return accounts;
}

// Metadados observacionais. Mapa explícito em dashboard-prefs.json:
// claude_account_labels: { "~/.claude-personal": "personal" }. Sem inferir rótulo
// pelo basename: só rótulos simples e sem caminho podem sair na trilha de custo.
function accountCostMetadata(account, { prefsFile = process.env.DASHBOARD_PREFS_FILE || DEFAULT_PREFS_FILE, home = os.homedir() } = {}) {
    let label = 'UNKNOWN';
    try {
        const labels = JSON.parse(fs.readFileSync(prefsFile, 'utf8')).claude_account_labels || {};
        const selected = path.resolve(account.dir || path.join(home, '.claude'));
        for (const [dir, value] of Object.entries(labels)) {
            const mapped = dir === DEFAULT_ACCOUNT ? path.join(home, '.claude') : expandHome(dir, home);
            if (path.isAbsolute(mapped) && path.resolve(mapped) === selected && typeof value === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(value)) {
                label = value;
                break;
            }
        }
    } catch { /* sem mapa observável: UNKNOWN */ }
    const configDir = account.dir || path.join(home, '.claude');
    let plugin = 'UNKNOWN';
    try {
        const settings = JSON.parse(fs.readFileSync(path.join(configDir, 'settings.json'), 'utf8'));
        plugin = detectEffortRouterPlugin(settings, configDir);
    } catch { /* sem observação suficiente: UNKNOWN */ }
    return { account: { source: account.source, label }, effort_router_plugin: plugin };
}

// Três fontes observáveis do perfil (plugin marketplace, skills-dir e árvore skills/).
// Ausência total continua UNKNOWN: não prova NOT_LOADED.
function detectEffortRouterPlugin(settings, configDir) {
    const isRouterKey = (key) => typeof key === 'string' && /^jev-model-router(?:@|$)/.test(key);
    const flags = Object.entries(settings.enabledPlugins || {}).filter(([key]) => isRouterKey(key));
    if (flags.some(([, enabled]) => enabled === true)) return 'LOADED';

    const configs = settings.pluginConfigs || {};
    const configEntries = Object.entries(configs).filter(([key]) => isRouterKey(key));
    if (configEntries.some(([, value]) => value && typeof value === 'object' && value.enabled === true)) return 'LOADED';
    if (configEntries.some(([, value]) => value && typeof value === 'object' && value.enabled !== false)) return 'LOADED';
    if (configEntries.some(([, value]) => value === true)) return 'LOADED';

    try {
        const skillDir = path.join(configDir, 'skills', 'jev-model-router');
        if (fs.existsSync(skillDir) && fs.statSync(skillDir).isDirectory()) return 'LOADED';
    } catch { /* ignore FS transitório */ }

    if (flags.length && flags.every(([, enabled]) => enabled === false) &&
        configEntries.every(([, value]) => value === false || (value && typeof value === 'object' && value.enabled === false))) {
        return 'NOT_LOADED';
    }
    if (flags.length && flags.every(([, enabled]) => enabled === false) && configEntries.length === 0) {
        return 'NOT_LOADED';
    }
    return 'UNKNOWN';
}

// PRI-233 (PRI-205 S4) SP-2: prova de que o jev-model-router fica desligado num
// despacho roteado. Gera <runDir>/routing-settings.json com todo plugin do router
// conhecido em false (o --settings do despacho tem precedência sobre o settings da
// conta), relê e confere o sha256. Fontes que um --settings não neutraliza (árvore
// skills/ e pluginConfigs ligados) dão LOADED. Sem observação suficiente: UNKNOWN.
// Nunca devolve NOT_LOADED sem o arquivo gravado e conferido.
const ROUTER_SKILLS_DIR_KEY = 'jev-model-router@skills-dir';

function routedPluginProof({ accountDir = null, runDir, home = os.homedir() } = {}) {
    const configDir = accountDir || path.join(home, '.claude');
    const isRouterKey = (key) => typeof key === 'string' && /^jev-model-router(?:@|$)/.test(key);
    let settings = {};
    const settingsFile = path.join(configDir, 'settings.json');
    if (fs.existsSync(settingsFile)) {
        try { settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8')) || {}; } catch { return { status: 'UNKNOWN', reason: 'account_settings_unreadable' }; }
    }
    try {
        if (fs.existsSync(path.join(configDir, 'skills', 'jev-model-router'))) return { status: 'LOADED', reason: 'skills_dir_not_neutralizable' };
    } catch { return { status: 'UNKNOWN', reason: 'account_skills_unreadable' }; }
    const configs = Object.entries(settings.pluginConfigs || {}).filter(([key]) => isRouterKey(key));
    if (configs.some(([, value]) => !(value === false || (value && typeof value === 'object' && value.enabled === false)))) {
        return { status: 'LOADED', reason: 'plugin_config_not_neutralizable' };
    }
    const keys = new Set([ROUTER_SKILLS_DIR_KEY, ...Object.keys(settings.enabledPlugins || {}).filter(isRouterKey)]);
    const generated = { enabledPlugins: Object.fromEntries([...keys].sort().map(k => [k, false])) };
    const target = path.join(runDir, 'routing-settings.json');
    const bytes = Buffer.from(`${JSON.stringify(generated, null, 2)}\n`);
    const expected = crypto.createHash('sha256').update(bytes).digest('hex');
    try {
        fs.writeFileSync(target, bytes);
        const back = crypto.createHash('sha256').update(fs.readFileSync(target)).digest('hex');
        if (back !== expected) return { status: 'UNKNOWN', reason: 'settings_readback_mismatch' };
    } catch {
        return { status: 'UNKNOWN', reason: 'settings_write_failed' };
    }
    return { status: 'NOT_LOADED', settings_path: target, settings_sha256: expected };
}

module.exports = {
    routedPluginProof,
    accountCostMetadata, detectEffortRouterPlugin, withClaudeAccount, resolveClaudeAccount,
    listClaudeAccounts, expandHome, DEFAULT_ACCOUNT, DEFAULT_PREFS_FILE,
};
