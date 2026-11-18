// node --test scripts/lib/db-effect-pg.test.js
// db-effect contra um Postgres DESCARTÁVEL (docker, imagem postgres:16-alpine local,
// porta aleatória no loopback). Pula quando não há docker/imagem. Executor e filho
// reais (driver pg); só o `security` é falso (devolve a senha do container). Os PoCs da
// revisão de segurança da PRI-180 rodam aqui contra o banco: nenhum deles toca a tabela.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const dbEffect = require('./db-effect');
const prismaConfig = require('./prisma-config');

const DOCKER = ['/opt/homebrew/bin/docker', '/usr/local/bin/docker', '/usr/bin/docker'].find(p => fs.existsSync(p));
const IMAGE = 'postgres:16-alpine';
function dockerOk() {
    if (!DOCKER) return false;
    try { execFileSync(DOCKER, ['image', 'inspect', IMAGE], { stdio: 'ignore', timeout: 15000 }); return true; } catch { return false; }
}
const available = dockerOk();
const skip = available ? false : 'docker/imagem postgres:16-alpine indisponível';

const tmpBase = process.env.CLAUDE_JOB_DIR ? path.join(process.env.CLAUDE_JOB_DIR, 'tmp') : os.tmpdir();
const tmp = fs.mkdtempSync(path.join(tmpBase, 'db-effect-pg-'));
const PASSWORD = `pg-${crypto.randomBytes(8).toString('hex')}`;
const NAME = `prisma-dbeffect-test-${process.pid}`;
const CFG = path.join(tmp, 'config');
let port = null;

async function waitReady() {
    const { Client } = require('pg');
    for (let i = 0; i < 60; i++) {
        const c = new Client({ host: '127.0.0.1', port, user: 'postgres', password: PASSWORD, database: 'postgres', connectionTimeoutMillis: 2000 });
        c.on('error', () => {});
        try { await c.connect(); await c.query('SELECT 1'); await c.end(); return; } catch { await c.end().catch(() => {}); await new Promise(r => setTimeout(r, 1000)); }
    }
    throw new Error('postgres do container não ficou pronto');
}
async function sql(text) {
    const { Client } = require('pg');
    const c = new Client({ host: '127.0.0.1', port, user: 'postgres', password: PASSWORD, database: 'postgres' });
    await c.connect();
    try { return await c.query(text); } finally { await c.end(); }
}
const tableExists = async () => (await sql("SELECT count(*)::int AS n FROM pg_tables WHERE tablename = 'clientes'")).rows[0].n === 1;
const reset = () => sql('DROP TABLE IF EXISTS clientes; CREATE TABLE clientes(id int); INSERT INTO clientes VALUES (1); DROP TABLE IF EXISTS nova; CREATE SEQUENCE IF NOT EXISTS s;');

test.before(async () => {
    if (!available) return;
    execFileSync(DOCKER, ['run', '-d', '--rm', '--pull', 'never', '--name', NAME, '-e', `POSTGRES_PASSWORD=${PASSWORD}`, '-p', '127.0.0.1::5432', IMAGE], { stdio: 'ignore', timeout: 60000 });
    port = Number(execFileSync(DOCKER, ['port', NAME, '5432/tcp'], { encoding: 'utf8' }).trim().split(':').pop());
    await waitReady();
    const bin = path.join(tmp, 'bin');
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'security'), `#!/bin/sh\n[ "$3" = prisma-db-pg-test ] && printf '%s\\n' '${PASSWORD}' && exit 0\nexit 44\n`, { mode: 0o755 });
    prismaConfig.writeSecureJson('db-targets.json', { 'pg-test': { label: 'teste', host: '127.0.0.1', port, database: 'postgres', user: 'postgres', env: 'qa', secret: { keychain: 'prisma-db-pg-test', account: 'pg-test' } } }, { dir: CFG });
    prismaConfig.writeSecureJson('settings.json', { security_bin: path.join(bin, 'security') }, { dir: CFG });
});
test.after(() => {
    if (available) try { execFileSync(DOCKER, ['rm', '-f', NAME], { stdio: 'ignore', timeout: 30000 }); } catch { /* já saiu */ }
    fs.rmSync(tmp, { recursive: true, force: true });
});

let n = 0;
function job(sqlText, verify = 'SELECT count(*) AS n FROM clientes', extra = {}) {
    return { id: `AUTH-${String(++n).padStart(3, '0')}`, artifact: 'docs/x.sql', artifact_sha256: dbEffect.sha256(sqlText), sql: sqlText, verify_sql: verify, target_alias: 'pg-test', ...extra };
}
function runDir() {
    const d = path.join(tmp, 'runs', `42359-pg-${++n}`);
    fs.mkdirSync(d, { recursive: true });
    return d;
}

test('PoCs da revisão (C1/C2/M1) recusados antes do banco — a tabela continua lá', { skip }, async () => {
    const cases = [
        ['verify', 'SELECT 1', "SELECT '/*' AS a; COMMIT; DROP TABLE clientes; SELECT '*/' AS b"],
        ['verify', 'SELECT 1', 'SELECT 1; \\! echo SHELL_EXEC PGPASSWORD=$PGPASSWORD | base64'],
        ['apply', "SELECT E'\\''; COMMIT; DROP TABLE clientes; --'", null],
        ['apply', 'SELECT 1; \\! echo APPLY_SHELL', null],
        ['apply', "SELECT '/*'; COMMIT; SET statement_timeout=0; SELECT pg_sleep(0); SELECT '*/';", null],
        ['apply', 'SET ROLE postgres; DROP TABLE clientes;', null],
    ];
    for (const [mode, art, verify] of cases) {
        await reset();
        const out = await dbEffect.run({ runDir: runDir(), job: job(art, verify || undefined), configDir: CFG, mode: mode === 'verify' ? 'verify' : 'apply' });
        assert.strictEqual(out.ok, false, `${mode}: ${art} ${verify || ''}`);
        assert.strictEqual(out.outcome, 'refused');
        assert.strictEqual(await tableExists(), true, `tabela sumiu: ${art} ${verify || ''}`);
    }
});

test('aplica em transação única com timeouts fixos e verifica antes/depois; segredo/usuário fora das saídas', { skip }, async () => {
    await reset();
    const dir = runDir();
    const out = await dbEffect.run({ runDir: dir, job: job('ALTER TABLE clientes ADD COLUMN nome text;\nINSERT INTO clientes VALUES (2, \'b\');', "SELECT string_agg(column_name, ',') AS cols FROM information_schema.columns WHERE table_name = 'clientes'", { expected_contains: 'nome' }), configDir: CFG });
    assert.strictEqual(out.ok, true, out.error);
    assert.strictEqual(out.outcome, 'applied');
    assert.strictEqual((await sql('SELECT count(*)::int AS n FROM clientes')).rows[0].n, 2);
    for (const f of fs.readdirSync(path.join(dir, 'authorization', out.authorization_id))) {
        const c = fs.readFileSync(path.join(dir, 'authorization', out.authorization_id, f), 'utf8');
        assert.ok(!c.includes(PASSWORD), `senha em ${f}`);
    }
    // Timeouts e read-only da conexão de verificação vêm da própria conexão.
    const t = await dbEffect.run({ runDir: runDir(), job: job('SELECT 1;', "SELECT current_setting('statement_timeout') || '/' || current_setting('lock_timeout') || '/' || current_setting('default_transaction_read_only') AS cfg", { expected_contains: '1min/5s/on' }), configDir: CFG, mode: 'verify' });
    assert.strictEqual(t.ok, true, t.error);
});

test('erro no 2º comando desfaz o 1º (transação única, falha certa)', { skip }, async () => {
    await reset();
    const out = await dbEffect.run({ runDir: runDir(), job: job('CREATE TABLE nova(a int);\nINSERT INTO tabela_que_nao_existe VALUES (1);'), configDir: CFG });
    assert.strictEqual(out.ok, false);
    assert.strictEqual(out.code, 'APPLY_FAILED', out.error);
    assert.strictEqual((await sql("SELECT count(*)::int AS n FROM pg_tables WHERE tablename = 'nova'")).rows[0].n, 0);
});

test('verify_sql que escreve falha no banco (conexão read-only), mesmo passando pelas checagens', { skip }, async () => {
    await reset();
    const out = await dbEffect.run({ runDir: runDir(), job: job('SELECT 1;', "SELECT nextval('s')"), configDir: CFG, mode: 'verify' });
    assert.strictEqual(out.ok, false);
    assert.match(out.error, /read-only|25006/);
});
