// Configuração privilegiada do Prisma (PRI-180): allowlist de bancos, aprovadores,
// ajustes do executor e cópias congeladas das aprovações. Mora SÓ em
// ~/.config/prisma/ do usuário dono do processo (diretório resolvido por
// os.userInfo(), não por HOME/REPO_PATH/.env), nunca no repo consumidor nem em
// variável de ambiente — um agente que escreve no worktree, no state.json ou no .env
// do consumidor não muda alvo, aprovador nem executor.
//
// Leitura recusa: symlink, arquivo/diretório de outro dono, ou com escrita para
// grupo/outros. Escrita: diretório 700, arquivo 600, rename atômico.
//
// Limite que sobra (docs/runbook.md, "Autorização humana"): o MESMO usuário do SO
// continua podendo escrever aqui. A proteção definitiva é rodar o dashboard com outro
// usuário do SO, ou os agentes num sandbox sem acesso a ~/.config/prisma.

const fs = require('fs');
const os = require('os');
const path = require('path');

function homeDir() {
    try { return os.userInfo().homedir; } catch { return os.homedir(); }
}

/** Diretório da config. `override` só por código (testes, CLI --config-dir), nunca por env. */
function configDir(override = null) {
    return override ? path.resolve(override) : path.join(homeDir(), '.config', 'prisma');
}

class ConfigError extends Error {
    constructor(code, message) { super(message); this.name = 'ConfigError'; this.code = code; }
}

function checkSafe(p, kind) {
    let st;
    try { st = fs.lstatSync(p); } catch (e) {
        if (e.code === 'ENOENT') return null;
        throw new ConfigError('CONFIG_UNREADABLE', `${p}: ${e.code}`);
    }
    if (st.isSymbolicLink()) throw new ConfigError('CONFIG_UNSAFE', `${p} é symlink — recusado`);
    if (kind === 'dir' ? !st.isDirectory() : !st.isFile()) throw new ConfigError('CONFIG_UNSAFE', `${p} não é ${kind === 'dir' ? 'diretório' : 'arquivo'}`);
    if (typeof process.getuid === 'function' && st.uid !== process.getuid()) throw new ConfigError('CONFIG_UNSAFE', `${p} não pertence ao usuário do dashboard — recusado`);
    if (st.mode & 0o022) throw new ConfigError('CONFIG_UNSAFE', `${p} tem permissão de escrita para grupo/outros (${(st.mode & 0o777).toString(8)}) — corrija com chmod go-w`);
    return st;
}

/**
 * JSON da config (`name` relativo ao diretório). Ausente → null. Inseguro/ilegível →
 * ConfigError (o caller recusa a operação; não cai em default).
 */
function readSecureJson(name, { dir = null } = {}) {
    const base = configDir(dir);
    if (!checkSafe(base, 'dir')) return null;
    const file = path.join(base, name);
    if (!checkSafe(file, 'file')) return null;
    let raw;
    try { raw = fs.readFileSync(file, 'utf8'); } catch (e) { throw new ConfigError('CONFIG_UNREADABLE', `${file}: ${e.code}`); }
    try { return JSON.parse(raw); } catch { throw new ConfigError('CONFIG_INVALID', `${file} não é JSON válido`); }
}

function ensureDir(dir) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.chmodSync(dir, 0o700);
    checkSafe(dir, 'dir');
}

function writeSecureJson(name, data, { dir = null } = {}) {
    const base = configDir(dir);
    const file = path.join(base, name);
    ensureDir(path.dirname(file));
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(tmp, file);
    fs.chmodSync(file, 0o600);
    return file;
}

/** settings.json: { security_bin? } — só para teste/ambiente atípico; padrão /usr/bin/security. */
function settings({ dir = null } = {}) {
    const s = readSecureJson('settings.json', { dir }) || {};
    return s && typeof s === 'object' && !Array.isArray(s) ? s : {};
}

module.exports = { configDir, readSecureJson, writeSecureJson, ensureDir, settings, checkSafe, ConfigError, homeDir };
