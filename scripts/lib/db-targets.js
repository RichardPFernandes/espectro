// Cadastro da allowlist de bancos do db-effect (PRI-180). A allowlist fica SÓ em
// ~/.config/prisma/db-targets.json (modo 600, scripts/lib/prisma-config.js) e guarda
// a referência ao segredo, derivada do alias. A senha vai para o Keychain do macOS
// (serviço prisma-db-<alias>, conta <alias>), cadastrada pelo próprio /usr/bin/security,
// que a pede no terminal sem eco — ela não passa por este processo nem por argv.
//
// O item é criado com ACL vazia (-T ''): nenhum aplicativo lê sem confirmação, então
// cada execução aprovada mostra o diálogo do macOS ("security quer usar..."). Clique
// "Permitir", nunca "Sempre Permitir" (isso põe o security na ACL e qualquer processo
// do usuário passa a ler sem prompt). Trade-off: um clique a mais por execução, em troca
// de um agente com shell não conseguir ler a senha em silêncio.
//
//   node scripts/lib/db-targets.js add <alias> --host=<h> --db=<banco> --user=<u> --env=<qa|stage|production>
//        [--port=5432] [--label="QA – embarc"] [--display=masked|visible] [--allow-production] [--sslmode=require]
//   node scripts/lib/db-targets.js add <alias> --from-properties=<application.properties> [--datasource=default|<nome>]
//        --env=<qa|stage|...> [--label=...] [--yes]
//        lê host/porta/banco da jdbc.url, o usuário e a senha do .properties do consumidor
//        (ISO-8859-1, CRLF), mostra mascarado, pede confirmação e grava a senha direto no
//        Keychain pelo stdin do `security -i` (nunca em argv, saída ou arquivo temporário)
//   node scripts/lib/db-targets.js secret <alias>   (re)grava a senha no Keychain (ACL vazia)
//   node scripts/lib/db-targets.js check <alias>    o item existe? (não lê a senha)
//   node scripts/lib/db-targets.js remove <alias>   tira da allowlist e apaga do Keychain
//   node scripts/lib/db-targets.js list             alias, rótulo, ambiente (sem usuário/segredo)

const { spawnSync } = require('child_process');
const dbEffect = require('./db-effect');
const prismaConfig = require('./prisma-config');

const fs = require('fs');

// /usr/bin/security por caminho absoluto; settings.json da config segura pode trocar
// (só teste/ambiente atípico) — nunca PATH/env.
function securityBin(dir = null) {
    let s = {};
    try { s = prismaConfig.settings({ dir }); } catch { s = {}; }
    return typeof s.security_bin === 'string' && s.security_bin.startsWith('/') ? s.security_bin : dbEffect.DEFAULT_SECURITY_BIN;
}
let SECURITY = dbEffect.DEFAULT_SECURITY_BIN;

// ── .properties do consumidor (Quarkus) ──────────────────────────────────────────

/** Java .properties (ISO-8859-1): comentários #/!, key=value|key: value|key value, continuação com \, escapes \uXXXX. */
function parseProperties(buf) {
    const text = Buffer.isBuffer(buf) ? buf.toString('latin1') : String(buf);
    const lines = text.split(/\r\n|\r|\n/);
    const out = {};
    for (let i = 0; i < lines.length; i++) {
        let line = lines[i].replace(/^[ \t\f]+/, '');
        if (!line || line[0] === '#' || line[0] === '!') continue;
        while (/(^|[^\\])(\\\\)*\\$/.test(line) && i + 1 < lines.length) line = line.slice(0, -1) + lines[++i].replace(/^[ \t\f]+/, '');
        let k = 0, key = '';
        for (; k < line.length; k++) {
            const c = line[k];
            if (c === '\\') { key += line[k] + (line[k + 1] ?? ''); k++; continue; }
            if (c === '=' || c === ':' || c === ' ' || c === '\t' || c === '\f') break;
            key += c;
        }
        let rest = line.slice(k).replace(/^[ \t\f]*[=:]?[ \t\f]*/, '');
        const unescape = v => v.replace(/\\u([0-9a-fA-F]{4})|\\(.)/g, (m, u, ch) => (u ? String.fromCharCode(parseInt(u, 16)) : ({ t: '\t', n: '\n', r: '\r', f: '\f' }[ch] ?? ch)));
        out[unescape(key)] = unescape(rest);
    }
    return out;
}

/** jdbc:postgresql://host[:port]/db[?…] → { host, port, database } ou null. */
function parseJdbcUrl(url) {
    const m = /^jdbc:postgresql:\/\/([^/:?,\s]+)(?::(\d+))?\/([^?;\s]+)/i.exec(String(url || '').trim());
    if (!m) return null;
    return { host: m[1], port: m[2] ? Number(m[2]) : 5432, database: decodeURIComponent(m[3]) };
}

/** Datasource do .properties: "default" = quarkus.datasource.*; senão quarkus.datasource.<nome>.*. */
function datasourceFromProperties(props, name = 'default') {
    const prefix = !name || name === 'default' ? 'quarkus.datasource.' : `quarkus.datasource.${name}.`;
    const url = props[`${prefix}jdbc.url`];
    const user = props[`${prefix}username`];
    const password = props[`${prefix}password`];
    const errors = [];
    const conn = parseJdbcUrl(url);
    if (!url) errors.push(`${prefix}jdbc.url ausente`);
    else if (!conn) errors.push(`${prefix}jdbc.url não é jdbc:postgresql://host[:porta]/banco`);
    if (!user) errors.push(`${prefix}username ausente`);
    if (!password) errors.push(`${prefix}password ausente`);
    for (const [k, v] of [['jdbc.url', url], ['username', user], ['password', password]]) if (/\$\{/.test(String(v || ''))) errors.push(`${prefix}${k} usa placeholder \${...} — resolva à mão`);
    return { errors, conn, user, password };
}

// Senha para o Keychain pelo STDIN do `security -i` (modo interativo: o comando inteiro,
// com a senha entre aspas, vai como uma linha no stdin). argv do processo é só "-i";
// nada em arquivo temporário. Saída do security descartada (não ecoa a linha).
function storeSecretFromValue(alias, password, { spawn = spawnSync } = {}) {
    const service = dbEffect.keychainService(alias);
    const q = v => `"${String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
    if (/[\r\n]/.test(password)) return false;
    spawn(SECURITY, ['delete-generic-password', '-s', service, '-a', alias], { stdio: 'ignore' });
    const line = `add-generic-password -s ${q(service)} -a ${q(alias)} -l ${q(`Prisma DB ${alias}`)} -T "" -w ${q(password)}\n`;
    const r = spawn(SECURITY, ['-i'], { input: line, stdio: ['pipe', 'ignore', 'ignore'] });
    return r.status === 0;
}

function maskValue(v) {
    const s = String(v || '');
    return s.length <= 3 ? '***' : `${s.slice(0, 2)}${'*'.repeat(Math.min(6, s.length - 3))}${s.slice(-1)}`;
}

function confirmLine(question) {
    if (!process.stdin.isTTY) return false;
    process.stderr.write(question);
    const buf = Buffer.alloc(256);
    let n = 0;
    try { n = fs.readSync(0, buf, 0, 256, null); } catch { return false; }
    return /^\s*(s|sim|y|yes)\s*$/i.test(buf.slice(0, n).toString());
}

// Recria o item (apaga antes: -U manteria a ACL antiga). `-w` por último: o security
// pede a senha no terminal. `-T ''`: ACL vazia → toda leitura pede confirmação.
function storeSecret(alias, { spawn = spawnSync } = {}) {
    const service = dbEffect.keychainService(alias);
    spawn(SECURITY, ['delete-generic-password', '-s', service, '-a', alias], { stdio: 'ignore' });
    const r = spawn(SECURITY, ['add-generic-password', '-s', service, '-a', alias, '-l', `Prisma DB ${alias}`, '-T', '', '-w'], { stdio: 'inherit' });
    return r.status === 0;
}

// Sem -w/-g: só confere que o item existe, sem ler (e sem diálogo).
function hasSecret(alias, { spawn = spawnSync } = {}) {
    return spawn(SECURITY, ['find-generic-password', '-s', dbEffect.keychainService(alias), '-a', alias], { stdio: 'ignore' }).status === 0;
}

function deleteSecret(alias, { spawn = spawnSync } = {}) {
    return spawn(SECURITY, ['delete-generic-password', '-s', dbEffect.keychainService(alias), '-a', alias], { stdio: 'ignore' }).status === 0;
}

/** Monta e valida a entrada (sem segredo). @returns {{ entry, errors }} */
function buildEntry(alias, opts) {
    const entry = {
        label: opts.label || alias, env: opts.env, host: opts.host, port: opts.port ? Number(opts.port) : 5432,
        database: opts.db || opts.database, user: opts.user,
        secret: { keychain: dbEffect.keychainService(alias), account: alias },
        display: opts.display || 'masked',
        ...(opts['allow-production'] ? { allow_production: true } : {}),
        ...(opts.production ? { production: true } : {}),
        ...(opts.sslmode ? { sslmode: opts.sslmode } : {}),
    };
    return { entry, errors: dbEffect.validateEntry(alias, entry) };
}

module.exports = { buildEntry, storeSecret, storeSecretFromValue, hasSecret, deleteSecret, parseProperties, parseJdbcUrl, datasourceFromProperties };

if (require.main === module) {
    const opts = {};
    const pos = [];
    for (const a of process.argv.slice(2)) {
        const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
        if (m) opts[m[1]] = m[2] === undefined ? true : m[2]; else pos.push(a);
    }
    const [cmd, alias] = pos;
    const dir = typeof opts['config-dir'] === 'string' ? opts['config-dir'] : null;
    const usage = msg => {
        if (msg) console.error(`[db-targets] ${msg}`);
        console.error('Uso: node scripts/lib/db-targets.js add <alias> --host= --db= --user= --env= [--label=] [--port=] [--display=masked|visible] [--allow-production] [--sslmode=] | secret <alias> | check <alias> | remove <alias> | list');
        process.exit(2);
    };
    if (Object.keys(opts).some(k => /pass|senha|pwd|secret/i.test(k))) usage('senha não vai em argv: o Keychain pede no terminal (comando "secret")');
    SECURITY = securityBin(dir);
    let data;
    try { data = prismaConfig.readSecureJson(dbEffect.TARGETS_FILE, { dir }) || {}; } catch (e) { usage(e.message); }
    const save = () => prismaConfig.writeSecureJson(dbEffect.TARGETS_FILE, data, { dir });
    if (cmd === 'list') {
        console.log(JSON.stringify(Object.entries(data).map(([a, e]) => ({ alias: a, label: e.label || a, env: e.env, production: dbEffect.isProductionEntry(e) })), null, 2));
        process.exit(0);
    }
    if (!alias || !dbEffect.ALIAS_RE.test(alias)) usage('alias inválido');
    if (cmd === 'add' && typeof opts['from-properties'] === 'string') {
        let props;
        try { props = parseProperties(fs.readFileSync(opts['from-properties'])); } catch (e) { usage(`não li ${opts['from-properties']}: ${e.code || e.message}`); }
        const ds = datasourceFromProperties(props, typeof opts.datasource === 'string' ? opts.datasource : 'default');
        if (ds.errors.length) usage(ds.errors.join('; '));
        const { entry, errors } = buildEntry(alias, { ...opts, host: ds.conn.host, port: String(ds.conn.port), db: ds.conn.database, user: ds.user });
        if (errors.length) usage(errors.join('; '));
        // Mostra mascarado o que vai cadastrar; a senha só como "(do .properties)".
        console.error([
            `[db-targets] Vou cadastrar o alvo "${alias}":`,
            `  rótulo:   ${entry.label}`,
            `  ambiente: ${entry.env}${dbEffect.isProductionEntry(entry) ? ' (PRODUÇÃO)' : ''}`,
            `  host:     ${maskValue(entry.host)}:${entry.port}`,
            `  banco:    ${maskValue(entry.database)}`,
            `  usuário:  ${maskValue(entry.user)}`,
            `  senha:    (lida do .properties, vai direto para o Keychain ${entry.secret.keychain} com ACL vazia)`,
        ].join('\n'));
        if (!opts.yes && !confirmLine('Confirmar? [s/N] ')) { console.error('[db-targets] cancelado — nada gravado.'); process.exit(1); }
        if (!storeSecretFromValue(alias, ds.password)) { console.error('[db-targets] Keychain não gravou a senha — nada gravado na allowlist.'); process.exit(1); }
        data[alias] = entry;
        const file = save();
        console.error(`[db-targets] "${alias}" gravado em ${file} e senha no Keychain. Cada execução aprovada vai pedir confirmação do macOS: clique "Permitir" (nunca "Sempre Permitir").`);
        process.exit(0);
    }
    if (cmd === 'add') {
        const { entry, errors } = buildEntry(alias, opts);
        if (errors.length) usage(errors.join('; '));
        data[alias] = entry;
        const file = save();
        console.error(`[db-targets] "${alias}" gravado em ${file}.`);
        console.error(`[db-targets] Agora a senha do banco (Keychain, serviço ${entry.secret.keychain}, ACL vazia) — o macOS pede abaixo, sem eco:`);
        if (!storeSecret(alias)) { console.error(`[db-targets] Keychain não gravou a senha; rode de novo: db-targets.js secret ${alias}`); process.exit(1); }
        console.error('[db-targets] senha gravada. Cada execução aprovada vai pedir confirmação do macOS: clique "Permitir" (nunca "Sempre Permitir").');
        process.exit(0);
    }
    if (!data[alias]) usage(`"${alias}" não está na allowlist`);
    if (cmd === 'secret') process.exit(storeSecret(alias) ? 0 : 1);
    if (cmd === 'check') {
        const ok = hasSecret(alias);
        console.log(ok ? `segredo de "${alias}" presente no Keychain` : `segredo de "${alias}" AUSENTE`);
        process.exit(ok ? 0 : 1);
    }
    if (cmd === 'remove') {
        delete data[alias];
        save();
        deleteSecret(alias);
        console.error(`[db-targets] "${alias}" removido (e apagado do Keychain).`);
        process.exit(0);
    }
    usage();
}
