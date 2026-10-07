// Conta do Claude Code usada pelos agentes que o watcher/dashboard despacham.
// Os spawns limpam toda variável CLAUDE* herdada (pra não vazar a sessão de quem
// subiu o processo), então a conta volta aqui como CLAUDE_CONFIG_DIR, vinda de:
//   1. dashboard/dashboard-prefs.json > claude_config_dir — o seletor "Conta do
//      Claude" do painel Watcher. Lido a cada spawn: trocar lá vale no próximo nó,
//      sem reiniciar o watcher. "default" = conta padrão do CLI (~/.claude).
//   2. WATCHER_CLAUDE_CONFIG_DIR no .env — sem o prefixo CLAUDE, sobrevive à limpeza.
// Nenhum dos dois = conta padrão do CLI. Aceita ~ no começo.
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

module.exports = { withClaudeAccount, resolveClaudeAccount, listClaudeAccounts, expandHome, DEFAULT_ACCOUNT, DEFAULT_PREFS_FILE };
