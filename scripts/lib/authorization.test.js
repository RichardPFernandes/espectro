// node --test scripts/lib/authorization.test.js
// Pedido de autorização humana (scripts/lib/authorization.js) + db-effect
// (scripts/lib/db-effect.js) + tokenizer (sql-lexer.js) + config segura. Executor FALSO
// injetado: nenhum teste aqui conecta em banco (o Postgres descartável fica em
// db-effect-pg.test.js). Os PoCs da revisão de segurança da PRI-180 viraram regressão.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const authorization = require('./authorization');
const dbEffect = require('./db-effect');
const dom06 = require('./dom06-attempt');
const prismaConfig = require('./prisma-config');
const approvers = require('./approvers');
const { tokenize } = require('./sql-lexer');
const cas = require('../cas');

const tmpBase = process.env.CLAUDE_JOB_DIR ? path.join(process.env.CLAUDE_JOB_DIR, 'tmp') : os.tmpdir();
const tmp = fs.mkdtempSync(path.join(tmpBase, 'authorization-'));
process.env.STATE_CONFLICTS_LOG = path.join(tmp, 'state-conflicts.jsonl');
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

// Sentinels: se aparecerem em argv/saída/arquivo, vazou.
const SECRET = 'SENTINEL-senha-do-banco-NAO-VAZA-123';
const DB_USER = 'usuario_qa_sentinel';
const DB_HOST = 'host-sentinel.qa.interno';
const SQL = "ALTER TABLE f_solicitacao_autorizacao DROP CONSTRAINT IF EXISTS f_check;\nALTER TABLE f_solicitacao_autorizacao ADD CONSTRAINT f_check CHECK (tipo IN ('A','SERVICO_ADICIONAL'));\n";
const entry = (alias, extra = {}) => ({ label: alias, host: DB_HOST, port: 5432, database: 'embarc_db_stage', user: DB_USER, env: 'qa', secret: { keychain: `prisma-db-${alias}`, account: alias }, ...extra });
const TARGETS = {
    'qa-app': entry('qa-app', { label: 'QA – embarc' }),
    'prod-app': entry('prod-app', { env: 'production' }),
    'prd-app': entry('prd-app', { env: 'prd' }),
    'live-app': entry('live-app', { env: 'live' }),
    'prod-liberado': entry('prod-liberado', { env: 'production', allow_production: true }),
};
// Config segura de teste (o default real é ~/.config/prisma do usuário do SO).
const CONFIG = path.join(tmp, 'config-prisma');
prismaConfig.writeSecureJson('db-targets.json', TARGETS, { dir: CONFIG });

let seq = 0;
function seedRun(state = {}) {
    const root = path.join(tmp, `repo-${++seq}`);
    const taskId = `42359-teste-${seq}`;
    const dir = path.join(root, 'memory', 'runs', taskId);
    fs.mkdirSync(dir, { recursive: true });
    fs.mkdirSync(path.join(root, 'docs', 'migrations'), { recursive: true });
    fs.writeFileSync(path.join(root, 'docs', 'migrations', 'check.sql'), SQL);
    fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({
        task_id: taskId, node: 'implement', history: ['plan', 'implement'], status: 'in_progress',
        redmine_ticket: { id: 99999 }, ticket_id: 88888, execution_id: 'exec-1', ...state,
    }, null, 2));
    fs.writeFileSync(path.join(dir, 'context.md'), '# Contexto\n');
    fs.writeFileSync(path.join(dir, 'handoff.md'), '# Handoff\n\nBloqueado: falta o SQL no banco do QA.\n');
    return { root, dir, taskId };
}
const readState = dir => JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'));
const writeState = (dir, s) => fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify(s));
const input = (extra = {}) => ({
    kind: 'db_migration', summary: 'Aplicar a check constraint no banco do QA', target_hint: { alias: 'qa-app', datasource: 'app', env: 'qa' },
    artifact: 'docs/migrations/check.sql', verify_sql: "SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'f_check'",
    expected: 'lista SERVICO_ADICIONAL', expected_contains: 'SERVICO_ADICIONAL', then: 'handback_qa', ...extra,
});

// Executor falso (mesma interface do filho): registra cada job.
function fakeExecutor({ pre = { ok: true, text: "CHECK (tipo IN ('A'))" }, apply = { ok: true, certain: true, text: '1: ALTER\n2: ALTER' }, post = { ok: true, text: "CHECK (tipo IN ('A','SERVICO_ADICIONAL'))" }, available = true } = {}) {
    const calls = [];
    return {
        calls,
        available: () => (available ? { ok: true } : { ok: false, error: 'dependência `pg` ausente' }),
        async run(job) {
            calls.push(job);
            if (job.mode === 'verify') return { post };
            if (!pre.ok) return { pre, apply: { ok: false, skipped: true, certain: true }, post: { ok: false, skipped: true } };
            return { pre, apply, post };
        },
    };
}

function request(dir, extra) {
    const out = authorization.requestAuthorization(dir, input(extra));
    assert.deepStrictEqual(out.errors, []);
    return out.pending;
}
function hashFor(dir, alias = 'qa-app') {
    return authorization.describeRequest(dir, { targetAlias: alias }).request_hash;
}
function approve(dir, extra = {}) {
    const s = readState(dir);
    const alias = extra.targetAlias === undefined ? 'qa-app' : extra.targetAlias;
    return authorization.approve(dir, {
        by: 'richard', operationId: `op-${Math.random()}`, expectedStateVersion: cas.effectiveVersion(s),
        authorizationId: s.pending_authorization.id, requestHash: alias ? hashFor(dir, alias) : 'x', configDir: CONFIG, ...extra, targetAlias: alias,
    });
}
async function approveAndRun(dir, execOpts = {}, approveExtra = {}) {
    const dec = approve(dir, approveExtra);
    return authorization.execute(dir, { frozen: dec.frozen, configDir: CONFIG, executor: fakeExecutor(), ...execOpts });
}
const CANON = ['v', 'task_id', 'ticket', 'authorization_id', 'kind', 'artifact', 'artifact_sha256', 'verify_sql', 'expected_contains', 'then', 'target'];

// ── Pedido ──────────────────────────────────────────────────────────────────────

test('request: grava pending_authorization com sha256 e target_hint (o agente só sugere), status authorization-pending', () => {
    const { dir } = seedRun();
    const p = request(dir);
    const s = readState(dir);
    assert.strictEqual(s.status, 'authorization-pending');
    assert.strictEqual(p.id, 'AUTH-001');
    assert.strictEqual(p.artifact_sha256, dbEffect.sha256(SQL));
    assert.strictEqual(p.target, undefined);
    assert.deepStrictEqual(p.target_hint, { alias: 'qa-app', datasource: 'app', env: 'qa' });
    assert.ok(s.events.some(e => e.type === 'authorization_requested'));
    assert.match(fs.readFileSync(path.join(dir, 'handoff.md'), 'utf8'), /authorization-pending:inicio[\s\S]*AUTH-001/);
    assert.throws(() => authorization.requestAuthorization(dir, input()), /já existe o pedido AUTH-001/);
});

test('request: entrada inválida não grava nada', () => {
    const { dir } = seedRun();
    const before = fs.readFileSync(path.join(dir, 'state.json'), 'utf8');
    for (const bad of [
        { verify_sql: 'DELETE FROM x' }, { artifact: '../fora.sql' }, { then: 'commit' }, { target_hint: { alias: 'qa-app', password: 'x' } },
        { artifact: 'docs/migrations/nao-existe.sql' }, { kind: 'shell' },
    ]) assert.ok(authorization.requestAuthorization(dir, input(bad)).errors.length, JSON.stringify(bad));
    assert.strictEqual(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'), before);
});

test('CLI: request registra (exit 4); approve/reject/manual/execute não existem (exit 2)', async () => {
    const { dir } = seedRun();
    const file = path.join(tmp, `pedido-${seq}.json`);
    fs.writeFileSync(file, JSON.stringify(input()));
    const cli = args => new Promise(resolve => execFile(process.execPath, [path.join(__dirname, 'authorization.js'), ...args],
        { env: { ...process.env, STATE_EXECUTION_ID: '' } }, (err, stdout, stderr) => resolve({ code: err ? err.code : 0, stderr })));
    assert.strictEqual((await cli(['request', dir, `--input=${file}`])).code, 4);
    for (const cmd of ['approve', 'reject', 'manual', 'execute']) {
        const out = await cli([cmd, dir]);
        assert.strictEqual(out.code, 2, cmd);
        assert.match(out.stderr, /decisão é humana/);
    }
});

// ── Decisão: CAS, request_hash, cópia congelada ─────────────────────────────────

test('approve: CAS velho = STATE_CONFLICT; hash vazio recusado; mesmo operation_id = idempotente; cópia congelada 600 em config/approved', () => {
    const { dir } = seedRun();
    request(dir);
    const v = cas.effectiveVersion(readState(dir));
    assert.throws(() => approve(dir, { expectedStateVersion: v - 1 }), e => cas.isConflict(e));
    assert.throws(() => approve(dir, { requestHash: '' }), e => e.code === 'REQUEST_HASH_REQUIRED');
    const ok = approve(dir, { operationId: 'op-aprova-1' });
    assert.strictEqual(ok.status, 'applied');
    assert.strictEqual(ok.frozen.sql, SQL);
    assert.strictEqual(ok.frozen.ticket, 42359, 'M3: ticket do task-id, não de state.ticket_id/redmine_ticket');
    const after = readState(dir);
    const e = after.authorization_history.find(x => x.event === 'approved');
    assert.deepStrictEqual([e.by, e.via, e.target, e.request_hash], ['richard', 'dashboard', 'qa-app', ok.frozen.request_hash]);
    const frozenFile = path.join(CONFIG, e.frozen);
    assert.ok(fs.existsSync(frozenFile));
    assert.strictEqual(fs.statSync(frozenFile).mode & 0o077, 0);
    assert.strictEqual(authorization.approve(dir, { by: 'r', operationId: 'op-aprova-1', expectedStateVersion: 0, authorizationId: 'AUTH-001', requestHash: 'x', targetAlias: 'qa-app', configDir: CONFIG }).status, 'already_processed');
});

test('A3: agente troca verify_sql/then no state depois do GET → REQUEST_CHANGED, nada aprovado', () => {
    const { dir } = seedRun();
    request(dir);
    const seen = hashFor(dir);
    const s = readState(dir);
    s.pending_authorization.verify_sql = "SELECT '/*'; COMMIT; DELETE FROM clientes; SELECT '*/'";
    s.pending_authorization.then = 'resume:commit';
    writeState(dir, s);
    assert.throws(() => approve(dir, { requestHash: seen }), e => e.code === 'REQUEST_CHANGED');
    assert.strictEqual(readState(dir).pending_authorization.phase, 'pending');
    // O hash muda com o alvo: aprovar outro banco com o hash do qa-app também é recusado.
    const { dir: d2 } = seedRun();
    request(d2);
    assert.throws(() => approve(d2, { targetAlias: 'prod-liberado', requestHash: hashFor(d2, 'qa-app') }), e => e.code === 'REQUEST_CHANGED');
});

test('A3: edição do state DEPOIS da aprovação não muda o que executa (roda a cópia congelada)', async () => {
    const { dir } = seedRun();
    request(dir, { then: 'resume:review' });
    const dec = approve(dir);
    const s = readState(dir);
    Object.assign(s.pending_authorization, { verify_sql: 'SELECT 666', then: 'resume:commit', artifact: 'docs/outro.sql' });
    writeState(dir, s);
    const exec = fakeExecutor();
    const out = await authorization.execute(dir, { frozen: dec.frozen, configDir: CONFIG, executor: exec });
    assert.strictEqual(out.ok, true, out.error);
    assert.strictEqual(exec.calls[0].sql, SQL);
    assert.match(exec.calls[0].verify_sql, /pg_constraint/);
    assert.strictEqual(out.node, 'review', 'then congelado, não o editado');
});

test('execute: sem cópia congelada, cópia forjada ou de outra decisão → nada executa', async () => {
    const { dir } = seedRun();
    request(dir);
    const dec = approve(dir);
    const exec = fakeExecutor();
    await assert.rejects(authorization.execute(dir, { configDir: CONFIG, executor: exec }), e => e.code === 'NO_FROZEN_APPROVAL');
    await assert.rejects(authorization.execute(dir, { frozen: { ...dec.frozen, verify_sql: 'SELECT 2' }, configDir: CONFIG, executor: exec }), e => e.code === 'FROZEN_INVALID');
    const forged = { ...dec.frozen, verify_sql: 'SELECT 2' };
    forged.request_hash = authorization.requestHashOf(Object.fromEntries(CANON.map(k => [k, forged[k] ?? null])));
    await assert.rejects(authorization.execute(dir, { frozen: forged, configDir: CONFIG, executor: exec }), e => e.code === 'NO_HUMAN_DECISION');
    assert.strictEqual(exec.calls.length, 0);
});

test('reject: volta para blocked com o motivo', () => {
    const { dir } = seedRun();
    request(dir);
    const out = authorization.reject(dir, { by: 'richard', reason: 'não agora', operationId: 'op-recusa-1', expectedStateVersion: cas.effectiveVersion(readState(dir)), authorizationId: 'AUTH-001' });
    assert.strictEqual(out.status, 'applied');
    const after = readState(dir);
    assert.deepStrictEqual([after.status, after.pending_authorization], ['blocked', undefined]);
    assert.match(after.blocked_reason, /recusada por richard: não agora/);
});

// ── db-effect (executor falso) ──────────────────────────────────────────────────

test('db-effect: executor recebe só alias + SQL congelado; saídas; Attempt COMPLETE; handback com o ticket do task-id', async () => {
    const { dir } = seedRun();
    request(dir);
    const exec = fakeExecutor();
    let ctx = null;
    const out = await approveAndRun(dir, { executor: exec, handback: async (runDir, c) => { ctx = c; return { ok: true, archived: true }; } });
    assert.strictEqual(out.ok, true, out.error);
    assert.deepStrictEqual(Object.keys(exec.calls[0]).sort(), ['alias', 'mode', 'sql', 'verify_sql']);
    assert.strictEqual(exec.calls[0].alias, 'qa-app');
    assert.strictEqual(ctx.ticket, 42359);
    const outDir = path.join(dir, 'authorization', 'AUTH-001');
    for (const f of ['pre.txt', 'apply.txt', 'post.txt', 'result.json']) assert.ok(fs.existsSync(path.join(outDir, f)), f);
    const attempt = dom06.listAttempts(dir).find(a => a.node === 'db-effect');
    assert.deepStrictEqual([attempt.result, dom06.summarize(attempt).verdict], ['COMPLETE', 'PASS']);
    assert.strictEqual(readState(dir).pending_authorization.phase, 'handback');
});

test('db-effect: mesma chave cumprida não aplica de novo (ALREADY_APPLIED)', async () => {
    const { dir } = seedRun();
    request(dir, { then: 'resume:review' });
    const dec = approve(dir);
    assert.strictEqual((await authorization.execute(dir, { frozen: dec.frozen, configDir: CONFIG, executor: fakeExecutor() })).ok, true);
    const exec = fakeExecutor();
    const again = await dbEffect.run({ runDir: dir, job: { id: 'AUTH-001', artifact: dec.frozen.artifact, artifact_sha256: dec.frozen.artifact_sha256, sql: SQL, verify_sql: dec.frozen.verify_sql, target_alias: 'qa-app' }, executor: exec, configDir: CONFIG });
    assert.strictEqual(again.code, 'ALREADY_APPLIED');
    assert.strictEqual(exec.calls.length, 0);
});

test('M2: fora da allowlist / produção (prod, prd, live) sem allow_production → recusado na aprovação', () => {
    for (const [alias, code] of [['qa-outro', 'TARGET_NOT_ALLOWED'], ['prod-app', 'PRODUCTION_REFUSED'], ['prd-app', 'PRODUCTION_REFUSED'], ['live-app', 'PRODUCTION_REFUSED']]) {
        const { dir } = seedRun();
        request(dir);
        assert.throws(() => approve(dir, { targetAlias: alias, requestHash: hashFor(dir, alias) }), e => e.code === code, alias);
        assert.strictEqual(readState(dir).pending_authorization.phase, 'pending');
    }
    assert.strictEqual(dbEffect.resolveTarget('prod-liberado', { configDir: CONFIG }).ok, true);
    assert.strictEqual(dbEffect.resolveTarget('qa-app', { configDir: path.join(tmp, 'config-vazia') }).code, 'NO_ALLOWLIST');
});

test('trocar o alias no state depois da aprovação → TARGET_CHANGED (nova aprovação)', async () => {
    const { dir } = seedRun();
    request(dir);
    const dec = approve(dir);
    const s = readState(dir);
    s.pending_authorization.target = { alias: 'prod-liberado' };
    writeState(dir, s);
    const exec = fakeExecutor();
    await assert.rejects(authorization.execute(dir, { frozen: dec.frozen, configDir: CONFIG, executor: exec }), e => e.code === 'TARGET_CHANGED');
    assert.strictEqual(exec.calls.length, 0);
});

test('artefato alterado entre o pedido e a aprovação → ARTIFACT_CHANGED na aprovação', () => {
    const { root, dir } = seedRun();
    request(dir);
    fs.appendFileSync(path.join(root, 'docs', 'migrations', 'check.sql'), 'DROP TABLE tudo;\n');
    assert.throws(() => approve(dir), e => e.code === 'ARTIFACT_CHANGED');
});

test('db-effect: falha certa → failed; incerta (COMMIT enviado, conexão caiu) → uncertain, só manual', async () => {
    const { dir } = seedRun();
    request(dir);
    const out = await approveAndRun(dir, { executor: fakeExecutor({ apply: { ok: false, certain: true, error: '23514: violação' } }) });
    assert.deepStrictEqual([out.ok, out.result.code, out.phase], [false, 'APPLY_FAILED', 'failed']);
    const { dir: d2 } = seedRun();
    request(d2);
    const unc = await approveAndRun(d2, { executor: fakeExecutor({ apply: { ok: false, certain: false, error: 'Connection terminated' } }) });
    assert.strictEqual(unc.phase, 'uncertain');
    assert.throws(() => approve(d2), e => e.code === 'NOT_APPROVABLE');
    const m = authorization.markManual(d2, { by: 'richard', operationId: 'op-manual-unc', expectedStateVersion: cas.effectiveVersion(readState(d2)), authorizationId: 'AUTH-001', targetAlias: 'qa-app', requestHash: hashFor(d2), configDir: CONFIG });
    assert.strictEqual(m.status, 'applied');
});

test('db-effect: verificação de depois sem o esperado → VERIFY_MISMATCH', async () => {
    const { dir } = seedRun();
    request(dir);
    const out = await approveAndRun(dir, { executor: fakeExecutor({ post: { ok: true, text: "CHECK (tipo IN ('A'))" } }) });
    assert.strictEqual(out.result.code, 'VERIFY_MISMATCH');
});

test('manual: com banco roda só o verify; sem banco não verifica; alias fora da allowlist recusado', async () => {
    const { dir } = seedRun();
    request(dir, { then: 'resume:verify' });
    const dec = authorization.markManual(dir, { by: 'dba', note: 'via pgAdmin', operationId: 'op-m1', expectedStateVersion: cas.effectiveVersion(readState(dir)), authorizationId: 'AUTH-001', targetAlias: 'qa-app', requestHash: hashFor(dir), configDir: CONFIG });
    const exec = fakeExecutor({ post: { ok: true, text: 'SERVICO_ADICIONAL' } });
    const out = await authorization.execute(dir, { frozen: dec.frozen, mode: 'verify', configDir: CONFIG, executor: exec });
    assert.strictEqual(out.ok, true, out.error);
    assert.deepStrictEqual([exec.calls.length, exec.calls[0].mode, exec.calls[0].sql], [1, 'verify', null]);
    assert.deepStrictEqual([readState(dir).status, readState(dir).node], ['in_progress', 'verify']);

    const { dir: d2 } = seedRun();
    request(d2, { then: 'resume:review' });
    const dec2 = authorization.markManual(d2, { by: 'dba', operationId: 'op-m2', expectedStateVersion: cas.effectiveVersion(readState(d2)), authorizationId: 'AUTH-001', requestHash: hashFor(d2, null), configDir: CONFIG });
    const exec2 = fakeExecutor();
    assert.strictEqual((await authorization.execute(d2, { frozen: dec2.frozen, mode: 'verify', configDir: CONFIG, executor: exec2 })).ok, true);
    assert.strictEqual(exec2.calls.length, 0);

    const { dir: d3 } = seedRun();
    request(d3);
    assert.throws(() => authorization.markManual(d3, { by: 'dba', operationId: 'op-m3', expectedStateVersion: cas.effectiveVersion(readState(d3)), authorizationId: 'AUTH-001', targetAlias: 'nao-existe', requestHash: 'x', configDir: CONFIG }), e => e.code === 'TARGET_NOT_ALLOWED');
});

// ── Tokenizer e checagens (PoCs da revisão) ─────────────────────────────────────

test('C1: `\\` no meio da linha (meta-comando do psql) é recusado no verify e no artefato', () => {
    assert.ok(dbEffect.checkVerifySql('SELECT 1; \\! echo SHELL PGPASSWORD=$PGPASSWORD | base64').length);
    assert.ok(dbEffect.checkArtifactSql('SELECT 1; \\! echo APPLY_SHELL').length);
    assert.ok(dbEffect.checkArtifactSql('ALTER TABLE t ADD c int; \\gexec').length);
    assert.deepStrictEqual(dbEffect.checkArtifactSql("INSERT INTO t VALUES ('C:\\\\dir\\\\x');"), [], '\\ dentro de literal é dado');
});

test('C2: comentário dentro de string não esconde COMMIT (verify e artefato)', () => {
    assert.ok(dbEffect.checkVerifySql("SELECT '/*' AS a; COMMIT; DROP TABLE clientes; SELECT '*/' AS b").length);
    assert.match(dbEffect.checkArtifactSql("SELECT '/*'; COMMIT; SET statement_timeout=0; SELECT pg_sleep(0); SELECT '*/';").join(' '), /COMMIT/);
    assert.match(dbEffect.checkArtifactSql("SELECT E'\\''; COMMIT; DROP TABLE clientes; --'").join(' '), /COMMIT/, "E'\\'' não engole o COMMIT");
    assert.deepStrictEqual(dbEffect.checkArtifactSql('/* externo /* aninhado */ COMMIT ainda comentário */ ALTER TABLE t ADD c int;'), []);
    assert.match(dbEffect.checkArtifactSql('DO $f$ BEGIN COMMIT; END $f$;').join(' '), /corpo/);
    assert.ok(dbEffect.checkArtifactSql("SELECT 'sem fim").length, 'literal sem fechamento');
    assert.ok(dbEffect.checkArtifactSql('/* sem fim').length);
});

test('M1: SET/RESET de timeout, role, sessão e set_config recusados; SET de coluna/search_path aceitos', () => {
    for (const bad of ['SET statement_timeout = 0;', 'SET LOCAL lock_timeout = 0;', 'RESET statement_timeout;', 'SET ROLE postgres;', 'SET SESSION AUTHORIZATION postgres;',
        "SELECT set_config('statement_timeout','0',false);", 'RESET ALL;', 'CREATE INDEX CONCURRENTLY i ON t (a);', 'VACUUM t;', "COPY t FROM PROGRAM 'id';", 'ALTER ROLE app SET statement_timeout = 0;',
        'BEGIN;', 'END;', 'SAVEPOINT a;', "PREPARE TRANSACTION 'x';", 'ABORT;']) {
        assert.ok(dbEffect.checkArtifactSql(bad).length, bad);
    }
    for (const ok of ['UPDATE t SET a = 1;', 'ALTER TABLE t ALTER COLUMN c SET NOT NULL;', 'SET search_path = public;', SQL]) assert.deepStrictEqual(dbEffect.checkArtifactSql(ok), [], ok);
    assert.ok(dbEffect.checkVerifySql('EXPLAIN ANALYZE DELETE FROM t').length);
    assert.ok(dbEffect.checkVerifySql('SELECT * INTO nova FROM t').length);
    assert.deepStrictEqual(dbEffect.checkVerifySql("SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'x; DROP TABLE y'"), []);
});

test('tokenizer: split só nos ; de código; dollar-quote com tag; E-string; identificador com aspas', () => {
    const st = tokenize("CREATE FUNCTION f() RETURNS int AS $body$ SELECT 1; $body$ LANGUAGE sql; SELECT E'a\\'b;c', \"x;y\"; SELECT $1").statements;
    assert.strictEqual(st.length, 3);
    assert.strictEqual(dbEffect.splitStatements('ALTER TABLE a ADD b int; -- fim ;\nALTER TABLE a ADD c int;').length, 2);
});

// ── Config segura, artefato, segredo ────────────────────────────────────────────

test('A1/A2: allowlist só de ~/.config/prisma segura; segredo amarrado ao alias; nada de senha/env', () => {
    const bad = path.join(tmp, 'config-ruim');
    prismaConfig.writeSecureJson('db-targets.json', TARGETS, { dir: bad });
    fs.chmodSync(path.join(bad, 'db-targets.json'), 0o664);
    assert.strictEqual(dbEffect.loadTargets({ configDir: bad }).code, 'CONFIG_UNSAFE');
    fs.chmodSync(path.join(bad, 'db-targets.json'), 0o600);
    fs.chmodSync(bad, 0o777);
    assert.strictEqual(dbEffect.loadTargets({ configDir: bad }).code, 'CONFIG_UNSAFE');
    fs.chmodSync(bad, 0o700);
    const link = path.join(tmp, 'config-link');
    fs.mkdirSync(link, { mode: 0o700 });
    fs.symlinkSync(path.join(bad, 'db-targets.json'), path.join(link, 'db-targets.json'));
    assert.strictEqual(dbEffect.loadTargets({ configDir: link }).code, 'CONFIG_UNSAFE');
    assert.match(dbEffect.validateEntry('qa-app', { ...entry('qa-app'), secret: { keychain: 'prisma-db-prod-app', account: 'qa-app' } }).join(' '), /prisma-db-qa-app/, 'A2: serviço de outro alias recusado');
    assert.match(dbEffect.validateEntry('a', { ...entry('a'), password: 'x' }).join(' '), /senha/);
    assert.match(dbEffect.validateEntry('a', { ...entry('a'), secret: { env: 'PRISMA_DB_A_PASSWORD' } }).join(' '), /fallback por env foi removido/);
    process.env.PRISMA_DB_TARGETS = JSON.stringify({ evil: entry('evil') });
    try { assert.strictEqual(dbEffect.resolveTarget('evil', { configDir: CONFIG }).code, 'TARGET_NOT_ALLOWED', 'A1: env não é lido'); } finally { delete process.env.PRISMA_DB_TARGETS; }
    const pub = JSON.stringify(dbEffect.publicTargets({ configDir: CONFIG }).targets);
    assert.ok(!pub.includes(DB_USER) && !pub.includes(DB_HOST) && !pub.includes('prisma-db-'));
});

test('B2: artefato symlink para fora do repo e artefato grande demais são recusados', () => {
    const { root, dir } = seedRun();
    const outside = path.join(tmp, 'fora.sql');
    fs.writeFileSync(outside, 'DROP TABLE x;');
    fs.symlinkSync(outside, path.join(root, 'docs', 'migrations', 'link.sql'));
    assert.match(authorization.requestAuthorization(dir, input({ artifact: 'docs/migrations/link.sql' })).errors.join(' '), /fora do repo/);
    fs.writeFileSync(path.join(root, 'docs', 'migrations', 'grande.sql'), `${'-- x\n'.repeat(60000)}ALTER TABLE t ADD c int;`);
    assert.match(authorization.requestAuthorization(dir, input({ artifact: 'docs/migrations/grande.sql' })).errors.join(' '), /bytes|maior/);
});

test('executor real (filho) sem banco: segredo pelo security configurado, nunca em argv/saída/state; conexão recusada = falha certa', async () => {
    const bin = path.join(tmp, 'bin-fake');
    fs.mkdirSync(bin, { recursive: true });
    const secArgv = path.join(tmp, 'security-argv.log');
    fs.writeFileSync(path.join(bin, 'security'), `#!/bin/sh\necho "$*" >> '${secArgv}'\n` +
        `[ "$1" = find-generic-password ] && [ "$3" = prisma-db-qa-local ] && [ "$5" = qa-local ] && printf '%s\\n' '${SECRET}' && exit 0\nexit 44\n`, { mode: 0o755 });
    const cfg = path.join(tmp, 'config-child');
    // Porta fechada no loopback: o pg tenta conectar com o segredo e falha (ECONNREFUSED).
    prismaConfig.writeSecureJson('db-targets.json', { 'qa-local': { ...entry('qa-local'), host: '127.0.0.1', port: 9 }, 'qa-sem': { ...entry('qa-sem'), host: '127.0.0.1', port: 9 } }, { dir: cfg });
    prismaConfig.writeSecureJson('settings.json', { security_bin: path.join(bin, 'security') }, { dir: cfg });
    const { dir } = seedRun();
    request(dir, { target_hint: { alias: 'qa-local' } });
    const dec = approve(dir, { targetAlias: 'qa-local', configDir: cfg, requestHash: hashFor(dir, 'qa-local') });
    const out = await authorization.execute(dir, { frozen: dec.frozen, configDir: cfg });
    assert.strictEqual(out.ok, false);
    assert.strictEqual(out.result.code, 'PRE_VERIFY_FAILED', out.error);
    assert.match(fs.readFileSync(secArgv, 'utf8'), /find-generic-password -s prisma-db-qa-local -a qa-local -w/);
    const files = [];
    const walk = d => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const f = path.join(d, e.name); e.isDirectory() ? walk(f) : files.push(f); } };
    walk(dir);
    for (const f of [...files, secArgv]) {
        const c = fs.readFileSync(f, 'utf8');
        assert.ok(!c.includes(SECRET), `segredo em ${f}`);
        assert.ok(!c.includes(DB_USER), `usuário em ${f}`);
    }
    const r = await dbEffect.createChildExecutor({ configDir: cfg }).run({ mode: 'verify', alias: 'qa-sem', verify_sql: 'SELECT 1' });
    assert.strictEqual(r.fatal.code, 'SECRET_UNAVAILABLE');
});

test('B3/approvers: hash scrypt assíncrono; config insegura = fail closed; parâmetros abusivos recusados; env não é lido', async () => {
    const cfg = path.join(tmp, 'config-approvers');
    prismaConfig.writeSecureJson('approvers.json', { richard: approvers.hashPassword('senha-de-aprovacao-1'), abuso: 'scrypt$1048576$8$1$AAAA$AAAA' }, { dir: cfg });
    assert.deepStrictEqual(await approvers.verify('richard', 'senha-de-aprovacao-1', { configDir: cfg }), { ok: true, name: 'richard' });
    assert.strictEqual((await approvers.verify('richard', 'errada', { configDir: cfg })).code, 'DENIED');
    assert.strictEqual((await approvers.verify('abuso', 'x', { configDir: cfg })).code, 'DENIED');
    assert.strictEqual((await approvers.verify('richard', '', { configDir: cfg })).code, 'MISSING');
    fs.chmodSync(path.join(cfg, 'approvers.json'), 0o666);
    assert.strictEqual((await approvers.verify('richard', 'senha-de-aprovacao-1', { configDir: cfg })).code, 'NO_APPROVERS');
    process.env.PRISMA_APPROVERS = JSON.stringify({ intruso: approvers.hashPassword('x-x-x-x-x-x') });
    try { assert.strictEqual((await approvers.verify('intruso', 'x-x-x-x-x-x', { configDir: path.join(tmp, 'config-nada') })).code, 'NO_APPROVERS'); } finally { delete process.env.PRISMA_APPROVERS; }
});

test('db-targets --from-properties: lê o .properties (ISO-8859-1/CRLF), mostra mascarado, senha só no stdin do security (nunca argv/saída)', async () => {
    const cfg = path.join(tmp, 'config-props');
    const bin = path.join(tmp, 'bin-props');
    fs.mkdirSync(bin, { recursive: true });
    const argvLog = path.join(tmp, 'props-security-argv.log');
    const stdinLog = path.join(tmp, 'props-security-stdin.log');
    fs.writeFileSync(path.join(bin, 'security'), `#!/bin/sh\necho "$*" >> '${argvLog}'\n[ "$1" = -i ] && cat >> '${stdinLog}'\nexit 0\n`, { mode: 0o755 });
    prismaConfig.writeSecureJson('settings.json', { security_bin: path.join(bin, 'security') }, { dir: cfg });
    const PROP_SECRET = 'SENTINEL-props-çã"\\x';
    const props = path.join(tmp, 'application.properties');
    fs.writeFileSync(props, Buffer.from([
        '# comentário', 'quarkus.datasource.db-kind=postgresql', 'quarkus.datasource.jdbc.url=jdbc:postgresql://192.168.10.234/embarc_db_stage',
        `quarkus.datasource.username=${DB_USER}`, `quarkus.datasource.password=${PROP_SECRET.replace(/\\/g, '\\\\')}`,
        'quarkus.datasource.portal.jdbc.url=jdbc:postgresql://outro/portal', 'quarkus.datasource.portal.password=nao-e-esta', '',
    ].join('\r\n'), 'latin1'));
    const run = args => new Promise(resolve => execFile(process.execPath, [path.join(__dirname, 'db-targets.js'), ...args], { env: { PATH: '/usr/bin:/bin', HOME: tmp } },
        (err, stdout, stderr) => resolve({ code: err ? err.code : 0, out: stdout + stderr })));
    const base = ['add', 'qa-app', `--from-properties=${props}`, '--env=qa', '--label=QA – embarc_db_stage', `--config-dir=${cfg}`];
    assert.strictEqual((await run(base)).code, 1, 'sem TTY e sem --yes: não grava');
    assert.ok(!fs.existsSync(argvLog), 'nada chamado sem confirmação');
    const r = await run([...base, '--yes']);
    assert.strictEqual(r.code, 0, r.out);
    assert.match(r.out, /host: +19\*+4:5432/);
    assert.ok(!r.out.includes('SENTINEL'), 'senha na saída');
    assert.ok(!r.out.includes(DB_USER), 'usuário sem máscara na saída');
    const argv = fs.readFileSync(argvLog, 'utf8');
    assert.ok(!argv.includes('SENTINEL'), `senha em argv: ${argv}`);
    assert.match(argv, /^-i$/m);
    const stdin = fs.readFileSync(stdinLog, 'utf8');
    assert.ok(stdin.includes('SENTINEL-props'), 'a senha chegou ao security pelo stdin');
    assert.match(stdin, /add-generic-password -s "prisma-db-qa-app" -a "qa-app" .*-T "" -w /);
    assert.ok(!stdin.includes('nao-e-esta'), 'datasource nomeado (portal) ignorado');
    const saved = prismaConfig.readSecureJson('db-targets.json', { dir: cfg })['qa-app'];
    assert.deepStrictEqual([saved.host, saved.port, saved.database, saved.user, saved.env], ['192.168.10.234', 5432, 'embarc_db_stage', DB_USER, 'qa']);
    assert.ok(!JSON.stringify(saved).includes('SENTINEL'));
    assert.strictEqual((await run(['add', 'x', '--host=h', '--db=d', '--user=u', '--env=qa', '--password=x', `--config-dir=${cfg}`])).code, 2);
});

test('C4: db-targets secret recria o item com ACL vazia (-T "") por /usr/bin/security', () => {
    const calls = [];
    const fake = (bin, args) => { calls.push([bin, ...args]); return { status: 0 }; };
    require('./db-targets').storeSecret('qa-app', { spawn: fake });
    assert.deepStrictEqual(calls[0].slice(0, 2), ['/usr/bin/security', 'delete-generic-password']);
    assert.deepStrictEqual(calls[1].slice(-3), ['-T', '', '-w']);
    assert.ok(calls[1].includes('qa-app') && calls[1].includes('prisma-db-qa-app'));
});
