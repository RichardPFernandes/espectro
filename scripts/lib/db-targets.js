// Cadastro da allowlist de bancos do db-effect (PRI-180). A allowlist fica num arquivo
// fora do repo (PRISMA_DB_TARGETS_FILE ou ~/.config/prisma/db-targets.json, modo 600)
// e guarda só a REFERÊNCIA ao segredo; a senha vai para o Keychain do macOS
// (serviço prisma-db-<alias>), cadastrada pelo próprio `security`, que a pede no
// terminal sem eco — ela não passa por este processo nem por argv.
//
//   node scripts/lib/db-targets.js add <alias> --host=<h> --db=<banco> --user=<u> --env=<qa|stage|production>
//        [--port=5432] [--label="QA – embarc"] [--display=masked|visible] [--allow-production]
//        [--sslmode=require] [--secret-env=PRISMA_DB_<ALIAS>_PASSWORD (fallback por env, sem Keychain)]
//   node scripts/lib/db-targets.js secret <alias>   (re)grava a senha no Keychain
//   node scripts/lib/db-targets.js check <alias>    o Keychain tem o segredo? (não imprime)
//   node scripts/lib/db-targets.js remove <alias>   tira da allowlist e apaga do Keychain
//   node scripts/lib/db-targets.js list             alias, rótulo, ambiente (sem usuário/segredo)

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const dbEffect = require('./db-effect');
const { writeFileSecure } = require('./approvers');

function readFileTargets(file) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; }
}

function securityBin(env = process.env) {
    return dbEffect.findInPath('security', env) || '/usr/bin/security';
}

// `-w` por último: o security pede a senha no terminal (sem eco) e não a recebe em argv.
function storeSecret(alias, { env = process.env, spawn = spawnSync } = {}) {
    const service = dbEffect.keychainService(alias);
    const r = spawn(securityBin(env), ['add-generic-password', '-U', '-s', service, '-a', alias, '-l', `Prisma DB ${alias}`, '-w'], { stdio: 'inherit' });
    return r.status === 0;
}

function hasSecret(alias, { env = process.env, spawn = spawnSync } = {}) {
    const r = spawn(securityBin(env), ['find-generic-password', '-s', dbEffect.keychainService(alias)], { stdio: 'ignore' });
    return r.status === 0;
}

function deleteSecret(alias, { env = process.env, spawn = spawnSync } = {}) {
    const r = spawn(securityBin(env), ['delete-generic-password', '-s', dbEffect.keychainService(alias)], { stdio: 'ignore' });
    return r.status === 0;
}

/** Monta e valida a entrada (sem segredo). @returns {{ entry, errors }} */
function buildEntry(alias, opts) {
    const entry = {
        label: opts.label || alias, env: opts.env, host: opts.host, port: opts.port ? Number(opts.port) : 5432,
        database: opts.db || opts.database, user: opts.user,
        secret: opts['secret-env'] ? { env: opts['secret-env'] } : { keychain: dbEffect.keychainService(alias), account: alias },
        display: opts.display || 'masked',
        ...(opts['allow-production'] ? { allow_production: true } : {}),
        ...(opts.production ? { production: true } : {}),
        ...(opts.sslmode ? { sslmode: opts.sslmode } : {}),
    };
    return { entry, errors: dbEffect.validateEntry(alias, entry) };
}

module.exports = { buildEntry, storeSecret, hasSecret, deleteSecret, readFileTargets };

if (require.main === module) {
    const argv = process.argv.slice(2);
    const opts = {};
    const pos = [];
    for (const a of argv) {
        const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
        if (m) opts[m[1]] = m[2] === undefined ? true : m[2]; else pos.push(a);
    }
    const [cmd, alias] = pos;
    const usage = msg => {
        if (msg) console.error(`[db-targets] ${msg}`);
        console.error('Uso: node scripts/lib/db-targets.js add <alias> --host= --db= --user= --env= [--label=] [--port=] [--display=masked|visible] [--allow-production] [--secret-env=] | secret <alias> | check <alias> | remove <alias> | list');
        process.exit(2);
    };
    if (Object.keys(opts).some(k => /pass|senha|pwd/i.test(k) && k !== 'secret-env')) usage('senha não vai em argv: o Keychain pede no terminal (comando "secret")');
    const file = dbEffect.targetsFile(process.env);
    const data = readFileTargets(file);
    if (cmd === 'list') {
        console.log(JSON.stringify(Object.entries(data).map(([a, e]) => ({ alias: a, label: e.label || a, env: e.env, production: dbEffect.isProductionEntry(e), secret: e.secret?.keychain ? 'keychain' : 'env' })), null, 2));
        process.exit(0);
    }
    if (!alias || !dbEffect.ALIAS_RE.test(alias)) usage('alias inválido');
    if (cmd === 'add') {
        const { entry, errors } = buildEntry(alias, opts);
        if (errors.length) usage(errors.join('; '));
        data[alias] = entry;
        writeFileSecure(file, data);
        console.error(`[db-targets] "${alias}" gravado em ${file}.`);
        if (entry.secret.keychain) {
            console.error(`[db-targets] Agora a senha do banco (Keychain, serviço ${entry.secret.keychain}) — o macOS pede abaixo, sem eco:`);
            if (!storeSecret(alias)) { console.error('[db-targets] Keychain não gravou a senha; rode de novo: db-targets.js secret ' + alias); process.exit(1); }
            console.error('[db-targets] senha gravada no Keychain.');
        } else {
            console.error(`[db-targets] Fallback por env: defina ${entry.secret.env} no .env do consumidor (não versionar). Prefira o Keychain.`);
        }
        process.exit(0);
    }
    if (!data[alias]) usage(`"${alias}" não está na allowlist (${file})`);
    if (cmd === 'secret') process.exit(storeSecret(alias) ? 0 : 1);
    if (cmd === 'check') {
        const ok = data[alias].secret?.keychain ? hasSecret(alias) : !!process.env[data[alias].secret?.env || data[alias].password_env];
        console.log(ok ? `segredo de "${alias}" presente` : `segredo de "${alias}" AUSENTE`);
        process.exit(ok ? 0 : 1);
    }
    if (cmd === 'remove') {
        const kc = !!data[alias].secret?.keychain;
        delete data[alias];
        writeFileSecure(file, data);
        if (kc) deleteSecret(alias);
        console.error(`[db-targets] "${alias}" removido${kc ? ' (e apagado do Keychain)' : ''}.`);
        process.exit(0);
    }
    usage();
}
