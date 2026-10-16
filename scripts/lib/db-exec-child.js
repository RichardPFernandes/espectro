// Processo filho do db-effect (scripts/lib/db-effect.js createChildExecutor). Único
// ponto que lê o segredo de um alvo, e só no momento da execução:
//   stdin  ← { mode: 'apply'|'verify', alias, sql, verify_sql, configDir, budget_ms }
//   1. resolve o alias na allowlist SEGURA (~/.config/prisma) e recheca o SQL;
//   2. lê o segredo do Keychain por /usr/bin/security (caminho absoluto), serviço
//      prisma-db-<alias>, conta <alias>. O item é criado com ACL vazia: o macOS pede
//      confirmação a cada leitura;
//   3. conecta pelo driver `pg` (senha no objeto de conexão — nada em env/argv) com
//      startup options fixas: statement_timeout, lock_timeout,
//      idle_in_transaction_session_timeout, standard_conforming_strings=on e, no
//      verify, default_transaction_read_only=on;
//   4. verify: BEGIN READ ONLY → 1 statement (protocolo estendido) → ROLLBACK;
//      apply: verify antes → BEGIN → cada statement numa mensagem estendida (o servidor
//      recusa mais de um comando por mensagem) → COMMIT → verify depois;
//   5. stdout → JSON com o resultado, sem segredo, usuário, host nem banco.
// Erro com SQLSTATE antes/no COMMIT = certo (transação desfeita). Conexão perdida depois
// de enviar o COMMIT = incerto. Não é CLI para humano nem agente.

const fs = require('fs');
const { execFile } = require('child_process');
const dbEffect = require('./db-effect');
const prismaConfig = require('./prisma-config');

function readStdin() {
    return new Promise(resolve => {
        let raw = '';
        process.stdin.setEncoding('utf8');
        process.stdin.on('data', d => { raw += d; });
        process.stdin.on('end', () => resolve(raw));
    });
}

function securityBin(configDir) {
    let s = {};
    try { s = prismaConfig.settings({ dir: configDir }); } catch { s = {}; }
    const bin = typeof s.security_bin === 'string' && s.security_bin.startsWith('/') ? s.security_bin : dbEffect.DEFAULT_SECURITY_BIN;
    return fs.existsSync(bin) ? bin : null;
}

function readKeychain(alias, configDir) {
    const bin = securityBin(configDir);
    if (!bin) return Promise.resolve(null);
    const args = ['find-generic-password', '-s', dbEffect.keychainService(alias), '-a', alias, '-w'];
    return new Promise(resolve => {
        execFile(bin, args, { timeout: 120000, maxBuffer: 64 * 1024, env: { PATH: '/usr/bin:/bin', HOME: prismaConfig.homeDir() } }, (err, stdout) => {
            if (err) return resolve(null);
            resolve(String(stdout).replace(/\r?\n$/, '') || null);
        });
    });
}

function rowsText(res) {
    if (!res || !Array.isArray(res.fields)) return res?.command ? `${res.command} ${res.rowCount ?? ''}`.trim() : '';
    const cols = res.fields.map(f => f.name);
    const lines = [cols.join(' | ')];
    for (const r of res.rows) lines.push(cols.map(c => (r[c] === null ? 'NULL' : typeof r[c] === 'object' ? JSON.stringify(r[c]) : String(r[c]))).join(' | '));
    lines.push(`(${res.rows.length} linha${res.rows.length === 1 ? '' : 's'})`);
    return lines.join('\n');
}

function errText(e) {
    return `${e.code ? `${e.code}: ` : ''}${e.message || String(e)}`;
}

async function main() {
    let req;
    try { req = JSON.parse(await readStdin()); } catch { return { fatal: { code: 'BAD_INPUT', message: 'entrada inválida', certain: true } }; }
    const configDir = typeof req.configDir === 'string' ? req.configDir : null;
    const r = dbEffect.resolveTarget(req.alias, { configDir });
    if (!r.ok) return { fatal: { code: r.code, message: r.error, certain: true } };
    const entry = r.entry;
    const vp = dbEffect.checkVerifySql(req.verify_sql);
    if (vp.length) return { fatal: { code: 'VERIFY_SQL_INVALID', message: vp.join('; '), certain: true } };
    let statements = [];
    if (req.mode === 'apply') {
        const ap = dbEffect.checkArtifactSql(req.sql);
        if (ap.length) return { fatal: { code: 'ARTIFACT_SQL_REFUSED', message: ap.join('; '), certain: true } };
        statements = dbEffect.splitStatements(req.sql);
    }
    const secret = await readKeychain(req.alias, configDir);
    if (!secret) return { fatal: { code: 'SECRET_UNAVAILABLE', message: `segredo do alvo "${req.alias}" não lido do Keychain (item ausente, ou a leitura foi negada/não confirmada no macOS) — cadastre com db-targets.js secret ${req.alias}`, certain: true } };

    const hide = [secret, entry.user, entry.host, entry.database].filter(v => typeof v === 'string' && v.length >= 3).sort((a, b) => b.length - a.length);
    const scrub = t => hide.reduce((out, v) => out.split(v).join('***'), String(t ?? ''));
    const { Client } = require('pg');
    const baseOptions = `-c statement_timeout=${dbEffect.STATEMENT_TIMEOUT_MS} -c lock_timeout=${dbEffect.LOCK_TIMEOUT_MS} -c idle_in_transaction_session_timeout=${dbEffect.STATEMENT_TIMEOUT_MS * 2} -c standard_conforming_strings=on`;
    const ssl = entry.sslmode === 'verify-full' ? { rejectUnauthorized: true } : entry.sslmode === 'require' ? { rejectUnauthorized: false } : undefined;
    const connect = async readOnly => {
        const c = new Client({
            host: entry.host, port: entry.port || 5432, database: entry.database, user: entry.user, password: secret,
            application_name: 'prisma-db-effect', connectionTimeoutMillis: 10000, ssl,
            options: readOnly ? `${baseOptions} -c default_transaction_read_only=on` : baseOptions,
        });
        c.on('error', () => { /* tratado nas chamadas */ });
        await c.connect();
        return c;
    };
    const deadline = Date.now() + (Number(req.budget_ms) > 0 ? Number(req.budget_ms) : dbEffect.CHILD_BUDGET_MS);
    const withDeadline = (p, client) => {
        const left = deadline - Date.now();
        if (left <= 0) { try { client?.connection?.stream?.destroy(); } catch { /* */ } return Promise.reject(Object.assign(new Error('prazo do executor esgotado'), { timeout: true })); }
        let t;
        return Promise.race([p, new Promise((_, rej) => { t = setTimeout(() => { try { client?.connection?.stream?.destroy(); } catch { /* */ } rej(Object.assign(new Error('prazo do executor esgotado'), { timeout: true })); }, left); })]).finally(() => clearTimeout(t));
    };

    const verify = async () => {
        let c;
        try {
            c = await withDeadline(connect(true));
            await withDeadline(c.query('BEGIN READ ONLY'), c);
            const res = await withDeadline(c.query({ text: req.verify_sql.replace(/;\s*$/, ''), queryMode: 'extended' }), c);
            await withDeadline(c.query('ROLLBACK'), c).catch(() => {});
            return { ok: true, text: scrub(rowsText(res)) };
        } catch (e) {
            return { ok: false, error: scrub(errText(e)) };
        } finally {
            if (c) await c.end().catch(() => {});
        }
    };

    if (req.mode !== 'apply') return { post: await verify() };

    const pre = await verify();
    if (!pre.ok) return { pre, apply: { ok: false, skipped: true, certain: true }, post: { ok: false, skipped: true } };

    let c;
    let commitSent = false;
    let apply;
    try {
        c = await withDeadline(connect(false));
        await withDeadline(c.query('BEGIN'), c);
        await withDeadline(c.query(`SET LOCAL lock_timeout = '${dbEffect.LOCK_TIMEOUT}'`), c);
        await withDeadline(c.query(`SET LOCAL statement_timeout = '${dbEffect.STATEMENT_TIMEOUT}'`), c);
        const done = [];
        for (const [i, text] of statements.entries()) {
            try {
                const res = await withDeadline(c.query({ text, queryMode: 'extended' }), c);
                done.push(`${i + 1}: ${res.command || 'OK'}${Number.isInteger(res.rowCount) ? ` ${res.rowCount}` : ''}`);
            } catch (e) {
                e.statement = i + 1;
                throw e;
            }
        }
        commitSent = true;
        await withDeadline(c.query('COMMIT'), c);
        apply = { ok: true, certain: true, text: done.join('\n') };
    } catch (e) {
        // SQLSTATE = o servidor respondeu: antes do COMMIT, ou o COMMIT falhou → desfeito.
        // Sem SQLSTATE depois de enviar o COMMIT (conexão caiu/prazo) → incerto.
        const serverAnswered = typeof e.code === 'string' && /^[0-9A-Z]{5}$/.test(e.code);
        const certain = !commitSent || serverAnswered;
        if (!commitSent && c) await c.query('ROLLBACK').catch(() => {});
        apply = { ok: false, certain, error: scrub(`${e.statement ? `comando ${e.statement}: ` : ''}${errText(e)}`) };
    } finally {
        if (c) await c.end().catch(() => {});
    }
    if (!apply.ok) {
        const post = apply.certain ? await verify() : { ok: false, skipped: true };
        return { pre, apply, post };
    }
    return { pre, apply, post: await verify() };
}

main()
    .then(out => { process.stdout.write(JSON.stringify(out)); })
    .catch(e => { process.stdout.write(JSON.stringify({ fatal: { code: 'CHILD_ERROR', message: String(e && e.message || e).slice(0, 300), certain: false } })); });
