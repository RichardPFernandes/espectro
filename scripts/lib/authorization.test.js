// node --test scripts/lib/authorization.test.js
// Pedido de autorização humana (scripts/lib/authorization.js) + db-effect
// (scripts/lib/db-effect.js) com executor FALSO injetado: nenhum teste conecta em banco.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const authorization = require('./authorization');
const dbEffect = require('./db-effect');
const dom06 = require('./dom06-attempt');
const cas = require('../cas');

const tmpBase = process.env.CLAUDE_JOB_DIR ? path.join(process.env.CLAUDE_JOB_DIR, 'tmp') : os.tmpdir();
const tmp = fs.mkdtempSync(path.join(tmpBase, 'authorization-'));
process.env.STATE_CONFLICTS_LOG = path.join(tmp, 'state-conflicts.jsonl');
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

// Sentinel: se aparecer em qualquer arquivo/argv/saída, vazou.
const PASSWORD = 'SENTINEL-senha-do-banco-NAO-VAZA-123';
const SQL = "ALTER TABLE f_solicitacao_autorizacao DROP CONSTRAINT IF EXISTS f_check;\nALTER TABLE f_solicitacao_autorizacao ADD CONSTRAINT f_check CHECK (tipo IN ('A','SERVICO_ADICIONAL'));\n";
const TARGETS = {
    'qa-app': { label: 'QA – embarc', host: 'db.qa.local', port: 5432, database: 'embarc_db_production', user: 'usuario_qa_secreto', env: 'qa', secret: { keychain: 'prisma-db-qa-app', account: 'qa-app' } },
    'qa-env': { host: 'db.qa.local', database: 'embarc', user: 'app', env: 'qa', secret: { env: 'PRISMA_DB_QA_ENV_PASSWORD' } },
    'prod-app': { host: 'db.prod.local', database: 'embarc', user: 'app', env: 'production', secret: { keychain: 'prisma-db-prod-app' } },
    'prod-liberado': { host: 'db.prod.local', database: 'embarc', user: 'app', env: 'production', allow_production: true, secret: { keychain: 'prisma-db-prod-liberado' } },
};
const ENV = { PRISMA_DB_TARGETS: JSON.stringify(TARGETS) };

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
        redmine_ticket: { id: 42359 }, execution_id: 'exec-1', ...state,
    }, null, 2));
    fs.writeFileSync(path.join(dir, 'context.md'), '# Contexto\n');
    fs.writeFileSync(path.join(dir, 'handoff.md'), '# Handoff\n\nBloqueado: falta o SQL no banco do QA.\n');
    return { root, dir, taskId };
}
const readState = dir => JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'));
const input = (extra = {}) => ({
    kind: 'db_migration', summary: 'Aplicar a check constraint no banco do QA', target_hint: { alias: 'qa-app', datasource: 'app', env: 'qa' },
    artifact: 'docs/migrations/check.sql', verify_sql: "SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'f_check'",
    expected: 'lista SERVICO_ADICIONAL', expected_contains: 'SERVICO_ADICIONAL', then: 'handback_qa', ...extra,
});

// Executor falso: registra cada chamada; a saída depende de ser verify (READ ONLY) ou apply.
function fakeExecutor({ applyExit = 0, preOut = "CHECK (tipo IN ('A'))", postOut = "CHECK (tipo IN ('A','SERVICO_ADICIONAL'))", stderr = '', available = true } = {}) {
    const calls = [];
    let verifies = 0;
    return {
        calls,
        available: () => (available ? { ok: true } : { ok: false, error: dbEffect.PSQL_MISSING }),
        async run(arg) {
            calls.push(arg);
            if (/BEGIN READ ONLY/.test(arg.script)) {
                verifies += 1;
                return { exitCode: 0, stdout: verifies === 1 ? preOut : postOut, stderr: '', spawnError: null, timedOut: false };
            }
            return { exitCode: applyExit, stdout: applyExit === 0 ? 'ALTER TABLE\nALTER TABLE\n' : '', stderr: applyExit ? `${stderr || 'ERROR:  check constraint violated'} password=xyz` : '', spawnError: null, timedOut: false };
        },
    };
}

function request(dir, extra) {
    const out = authorization.requestAuthorization(dir, input(extra));
    assert.deepStrictEqual(out.errors, []);
    return out.pending;
}
function approve(dir, extra = {}) {
    const s = readState(dir);
    return authorization.approve(dir, {
        by: 'richard', operationId: extra.operationId || `op-${Math.random()}`, expectedStateVersion: cas.effectiveVersion(s),
        authorizationId: s.pending_authorization.id, artifactSha256: s.pending_authorization.artifact_sha256, targetAlias: 'qa-app', env: ENV, ...extra,
    });
}

// ── Pedido ──────────────────────────────────────────────────────────────────────

test('request: grava pending_authorization com sha256, status authorization-pending, histórico, evento e bloco no handoff', () => {
    const { dir } = seedRun();
    const p = request(dir);
    const s = readState(dir);
    assert.strictEqual(s.status, 'authorization-pending');
    assert.strictEqual(p.id, 'AUTH-001');
    assert.strictEqual(p.artifact_sha256, dbEffect.sha256(SQL));
    assert.strictEqual(p.phase, 'pending');
    assert.strictEqual(p.requested_by, 'implement');
    assert.deepStrictEqual(p.target_hint, { alias: 'qa-app', datasource: 'app', env: 'qa' });
    assert.strictEqual(p.target, undefined, 'o alvo não vem do agente');
    assert.strictEqual(s.authorization_history[0].event, 'requested');
    assert.ok(s.events.some(e => e.type === 'authorization_requested'));
    assert.match(fs.readFileSync(path.join(dir, 'handoff.md'), 'utf8'), /authorization-pending:inicio[\s\S]*AUTH-001/);
    // Um pedido por vez.
    assert.throws(() => authorization.requestAuthorization(dir, input()), /já existe o pedido AUTH-001/);
});

test('request: entrada inválida não grava nada (verify_sql com DML, artifact com .., then inválido, senha no pedido)', () => {
    const { dir } = seedRun();
    const before = fs.readFileSync(path.join(dir, 'state.json'), 'utf8');
    for (const bad of [
        { verify_sql: 'DELETE FROM x' }, { artifact: '../fora.sql' }, { then: 'commit' }, { target_hint: { alias: 'qa-app', password: 'x' } },
        { artifact: 'docs/migrations/nao-existe.sql' }, { kind: 'shell' },
    ]) {
        const out = authorization.requestAuthorization(dir, input(bad));
        assert.ok(out.errors.length, JSON.stringify(bad));
    }
    assert.strictEqual(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'), before);
});

test('request: artefato que controla a própria transação é recusado já no pedido', () => {
    const { root, dir } = seedRun();
    fs.writeFileSync(path.join(root, 'docs', 'migrations', 'tx.sql'), 'BEGIN;\nALTER TABLE x ADD COLUMN y int;\nCOMMIT;\n');
    const out = authorization.requestAuthorization(dir, input({ artifact: 'docs/migrations/tx.sql' }));
    assert.match(out.errors.join(' '), /controla a própria transação/);
});

test('CLI: request registra (exit 4); approve/reject/manual/execute não existem (exit 2) — aprovação é só humana', async () => {
    const { dir } = seedRun();
    const file = path.join(tmp, `pedido-${seq}.json`);
    fs.writeFileSync(file, JSON.stringify(input()));
    const cli = args => new Promise(resolve => execFile(process.execPath, [path.join(__dirname, 'authorization.js'), ...args],
        { env: { ...process.env, STATE_EXECUTION_ID: '' } }, (err, stdout, stderr) => resolve({ code: err ? err.code : 0, stdout, stderr })));
    const r = await cli(['request', dir, `--input=${file}`]);
    assert.strictEqual(r.code, 4, r.stderr);
    assert.strictEqual(readState(dir).status, 'authorization-pending');
    for (const cmd of ['approve', 'reject', 'manual', 'execute']) {
        const out = await cli([cmd, dir]);
        assert.strictEqual(out.code, 2, cmd);
        assert.match(out.stderr, /decisão é humana/);
    }
    assert.strictEqual(readState(dir).pending_authorization.phase, 'pending');
});

// ── Decisão (CAS) ───────────────────────────────────────────────────────────────

test('approve: CAS — versão velha é STATE_CONFLICT; hash não confirmado é recusado; mesmo operation_id é idempotente', () => {
    const { dir } = seedRun();
    request(dir);
    const s = readState(dir);
    const v = cas.effectiveVersion(s);
    assert.throws(() => authorization.approve(dir, { by: 'r', operationId: 'op-velha-1', expectedStateVersion: v - 1, authorizationId: 'AUTH-001', artifactSha256: s.pending_authorization.artifact_sha256, targetAlias: 'qa-app', env: ENV }),
        e => cas.isConflict(e) && e.code === cas.STATE_CONFLICT);
    assert.throws(() => authorization.approve(dir, { by: 'r', operationId: 'op-hash-1', expectedStateVersion: v, authorizationId: 'AUTH-001', artifactSha256: 'abc', targetAlias: 'qa-app', env: ENV }),
        e => e.code === 'HASH_NOT_CONFIRMED');
    assert.throws(() => authorization.approve(dir, { by: 'r', operationId: 'op-id-1', expectedStateVersion: v, authorizationId: 'AUTH-999', artifactSha256: s.pending_authorization.artifact_sha256, targetAlias: 'qa-app', env: ENV }),
        e => e.code === 'AUTHORIZATION_MISMATCH');
    const ok = approve(dir, { operationId: 'op-aprova-1' });
    assert.strictEqual(ok.status, 'applied');
    const after = readState(dir);
    assert.strictEqual(after.pending_authorization.phase, 'executing');
    const entry = after.authorization_history.find(e => e.event === 'approved');
    assert.deepStrictEqual([entry.by, entry.via, entry.target], ['richard', 'dashboard', 'qa-app']);
    assert.deepStrictEqual(after.pending_authorization.target, { alias: 'qa-app' });
    assert.ok(after.processed_operations.some(o => o.operation_id === 'op-aprova-1' && o.type === 'AUTHORIZATION_DECISION'));
    assert.strictEqual(authorization.approve(dir, { by: 'r', operationId: 'op-aprova-1', expectedStateVersion: 0, authorizationId: 'AUTH-001', artifactSha256: 'x' }).status, 'already_processed');
});

test('execute sem decisão humana registrada pelo dashboard não roda nada (estado editado à mão não executa SQL)', async () => {
    const { dir } = seedRun();
    request(dir);
    const s = readState(dir);
    s.pending_authorization.phase = 'executing'; // "aprovação" forjada editando o state
    s.pending_authorization.target = { alias: 'qa-app' };
    fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify(s));
    const exec = fakeExecutor();
    await assert.rejects(authorization.execute(dir, { env: ENV, executor: exec }), e => e.code === 'NO_HUMAN_DECISION');
    assert.strictEqual(exec.calls.length, 0);
});

test('reject: volta para blocked com o motivo, pedido vai para o histórico (Responder ao agente segue disponível)', () => {
    const { dir } = seedRun();
    request(dir);
    const s = readState(dir);
    const out = authorization.reject(dir, { by: 'richard', reason: 'aplicar só depois do deploy', operationId: 'op-recusa-1', expectedStateVersion: cas.effectiveVersion(s), authorizationId: 'AUTH-001' });
    assert.strictEqual(out.status, 'applied');
    const after = readState(dir);
    assert.strictEqual(after.status, 'blocked');
    assert.strictEqual(after.pending_authorization, undefined);
    assert.match(after.blocked_reason, /recusada por richard: aplicar só depois do deploy/);
    assert.strictEqual(after.authorization_history.at(-1).event, 'rejected');
    assert.doesNotMatch(fs.readFileSync(path.join(dir, 'handoff.md'), 'utf8'), /authorization-pending:inicio/);
});

// ── db-effect (executor falso) ──────────────────────────────────────────────────

test('db-effect: aprovado → verify antes, SQL em transação única com timeouts, verify depois; saídas sem senha; Attempt COMPLETE; then handback chamado', async () => {
    const { dir } = seedRun();
    request(dir);
    approve(dir);
    const exec = fakeExecutor();
    let handbackCtx = null;
    const out = await authorization.execute(dir, { env: ENV, executor: exec, handback: async (runDir, ctx) => { handbackCtx = ctx; return { ok: true, archived: true }; } });
    assert.strictEqual(out.ok, true, out.error);
    assert.strictEqual(exec.calls.length, 3);
    const [pre, apply, post] = exec.calls;
    assert.match(pre.script, /BEGIN READ ONLY;[\s\S]*pg_constraint[\s\S]*ROLLBACK;/);
    assert.match(apply.script, /^\\set ON_ERROR_STOP on\nBEGIN;\nSET LOCAL lock_timeout = '5s';\nSET LOCAL statement_timeout = '60s';\n[\s\S]*SERVICO_ADICIONAL[\s\S]*\nCOMMIT;\n$/);
    assert.strictEqual((apply.script.match(/BEGIN;/g) || []).length, 1, 'uma transação só');
    assert.strictEqual(apply.alias, 'qa-app');
    assert.deepStrictEqual(Object.keys(apply).sort(), ['alias', 'readOnly', 'script'], 'executor recebe só alias + script (nada de senha/usuário/host)');
    assert.strictEqual(handbackCtx.operationId, 'handback:AUTH-001');

    const outDir = path.join(dir, 'authorization', 'AUTH-001');
    for (const f of ['pre.txt', 'apply.txt', 'post.txt', 'result.json']) assert.ok(fs.existsSync(path.join(outDir, f)), f);
    const result = JSON.parse(fs.readFileSync(path.join(outDir, 'result.json'), 'utf8'));
    assert.deepStrictEqual([result.ok, result.outcome, result.verify_matched], [true, 'applied', true]);
    // Senha em nenhum lugar gravado.
    const all = [...fs.readdirSync(outDir).map(f => fs.readFileSync(path.join(outDir, f), 'utf8')),
        fs.readFileSync(path.join(dir, 'state.json'), 'utf8'), fs.readFileSync(path.join(dir, 'context.md'), 'utf8'),
        ...dom06.listAttempts(dir).map(a => JSON.stringify(a))].join('\n');
    assert.ok(!all.includes(PASSWORD), 'senha vazou');
    const attempt = dom06.listAttempts(dir).find(a => a.node === 'db-effect');
    assert.strictEqual(attempt.result, 'COMPLETE');
    assert.strictEqual(dom06.summarize(attempt).verdict, 'PASS');
    const s = readState(dir);
    assert.strictEqual(s.pending_authorization.phase, 'handback');
    assert.ok(s.authorization_history.some(e => e.event === 'applied'));
});

test('db-effect: mesma chave cumprida não aplica de novo (ALREADY_APPLIED)', async () => {
    const { dir } = seedRun();
    const p = request(dir, { then: 'resume:review' });
    approve(dir);
    assert.strictEqual((await authorization.execute(dir, { env: ENV, executor: fakeExecutor() })).ok, true);
    const exec = fakeExecutor();
    const again = await dbEffect.run({ runDir: dir, pending: { ...p, phase: 'executing', target: { alias: 'qa-app' } }, env: ENV, executor: exec, roots: authorization.rootsFor(dir) });
    assert.strictEqual(again.code, 'ALREADY_APPLIED');
    assert.strictEqual(exec.calls.length, 0);
});

test('db-effect: then resume:<nó> retoma o run (in_progress no nó indicado) e limpa o pedido', async () => {
    const { dir } = seedRun();
    request(dir, { then: 'resume:review' });
    approve(dir);
    const out = await authorization.execute(dir, { env: ENV, executor: fakeExecutor() });
    assert.deepStrictEqual([out.ok, out.node], [true, 'review']);
    const s = readState(dir);
    assert.deepStrictEqual([s.status, s.node, s.pending_authorization, s.blocked_reason], ['in_progress', 'review', undefined, undefined]);
    assert.match(fs.readFileSync(path.join(dir, 'context.md'), 'utf8'), /Autorização AUTH-001 concluída/);
});

test('aprovar: alvo fora da allowlist / sem allowlist / produção sem allow_production / segredo env ausente → recusado, nada muda', () => {
    for (const [alias, env, code] of [
        ['qa-outro', ENV, 'TARGET_NOT_ALLOWED'],
        ['qa-app', { HOME: tmp }, 'NO_ALLOWLIST'],
        ['prod-app', ENV, 'PRODUCTION_REFUSED'],
        ['qa-env', ENV, 'SECRET_MISSING'],
    ]) {
        const { dir } = seedRun();
        request(dir);
        assert.throws(() => approve(dir, { targetAlias: alias, env }), e => e.code === code, alias);
        assert.strictEqual(readState(dir).pending_authorization.phase, 'pending', alias);
    }
    assert.throws(() => { const { dir } = seedRun(); request(dir); approve(dir, { targetAlias: '' }); }, e => e.code === 'TARGET_REQUIRED');
    // Produção com allow_production explícito passa pelo guard; env com a variável presente também.
    assert.strictEqual(dbEffect.resolveTarget('prod-liberado', ENV).ok, true);
    assert.strictEqual(dbEffect.resolveTarget('qa-env', { ...ENV, PRISMA_DB_QA_ENV_PASSWORD: 'x' }).ok, true);
});

test('trocar o alias depois da aprovação exige nova aprovação (TARGET_CHANGED, nada executa)', async () => {
    const { dir } = seedRun();
    request(dir);
    approve(dir);
    const s = readState(dir);
    s.pending_authorization.target = { alias: 'prod-liberado' };
    fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify(s));
    const exec = fakeExecutor();
    await assert.rejects(authorization.execute(dir, { env: ENV, executor: exec }), e => e.code === 'TARGET_CHANGED');
    assert.strictEqual(exec.calls.length, 0);
});

test('db-effect: artefato alterado depois do pedido (hash mismatch) aborta antes de conectar', async () => {
    const { root, dir } = seedRun();
    request(dir);
    approve(dir);
    fs.appendFileSync(path.join(root, 'docs', 'migrations', 'check.sql'), 'DROP TABLE tudo;\n');
    const exec = fakeExecutor();
    const out = await authorization.execute(dir, { env: ENV, executor: exec });
    assert.strictEqual(out.result.code, 'ARTIFACT_CHANGED');
    assert.strictEqual(exec.calls.length, 0);
    assert.match(readState(dir).blocked_reason, /mudou depois do pedido/);
});

test('db-effect: erro no SQL (ON_ERROR_STOP, exit 3) → failed, transação desfeita, stderr gravado sem senha, Attempt FAILED', async () => {
    const { dir } = seedRun();
    request(dir);
    approve(dir);
    const out = await authorization.execute(dir, { env: ENV, executor: fakeExecutor({ applyExit: 3 }) });
    assert.strictEqual(out.ok, false);
    assert.strictEqual(out.result.code, 'APPLY_FAILED');
    assert.strictEqual(out.phase, 'failed');
    const apply = fs.readFileSync(path.join(dir, 'authorization', 'AUTH-001', 'apply.txt'), 'utf8');
    assert.match(apply, /check constraint violated/);
    assert.ok(!apply.includes(PASSWORD));
    assert.strictEqual(dom06.listAttempts(dir).find(a => a.node === 'db-effect').result, 'FAILED');
    assert.strictEqual(readState(dir).status, 'blocked');
});

test('db-effect: conexão caída na aplicação (exit 2) é UNCERTAIN — não repete e só aceita decisão manual', async () => {
    const { dir } = seedRun();
    request(dir);
    approve(dir);
    const out = await authorization.execute(dir, { env: ENV, executor: fakeExecutor({ applyExit: 2, stderr: 'server closed the connection unexpectedly' }) });
    assert.strictEqual(out.phase, 'uncertain');
    const s = readState(dir);
    assert.strictEqual(s.pending_authorization.phase, 'uncertain');
    // Aprovar de novo não é permitido; "Já apliquei manualmente" sim.
    assert.throws(() => approve(dir), e => e.code === 'NOT_APPROVABLE');
    const m = authorization.markManual(dir, { by: 'richard', operationId: 'op-manual-unc', expectedStateVersion: cas.effectiveVersion(readState(dir)), authorizationId: 'AUTH-001', targetAlias: 'qa-app', env: ENV });
    assert.strictEqual(m.status, 'applied');
});

test('db-effect: verificação de depois sem o esperado (expected_contains) → failed mesmo com COMMIT ok', async () => {
    const { dir } = seedRun();
    request(dir);
    approve(dir);
    const out = await authorization.execute(dir, { env: ENV, executor: fakeExecutor({ postOut: "CHECK (tipo IN ('A'))" }) });
    assert.strictEqual(out.result.code, 'VERIFY_MISMATCH');
    assert.strictEqual(readState(dir).status, 'blocked');
});

test('db-effect: sem psql → erro claro pedindo libpq, nada executa', async () => {
    const { dir } = seedRun();
    request(dir);
    approve(dir);
    const out = await authorization.execute(dir, { env: ENV, executor: fakeExecutor({ available: false }) });
    assert.strictEqual(out.result.code, 'EXECUTOR_UNAVAILABLE');
    assert.match(out.error, /brew install libpq/);
});

test('manual: registra quem, roda só o verify_sql (alvo na allowlist) e segue o then', async () => {
    const { dir } = seedRun();
    request(dir, { then: 'resume:verify' });
    const s = readState(dir);
    authorization.markManual(dir, { by: 'dba', note: 'apliquei via pgAdmin', operationId: 'op-manual-1', expectedStateVersion: cas.effectiveVersion(s), authorizationId: 'AUTH-001', targetAlias: 'qa-app', env: ENV });
    const exec = fakeExecutor({ preOut: "CHECK (tipo IN ('A','SERVICO_ADICIONAL'))" });
    const out = await authorization.execute(dir, { mode: 'verify', env: ENV, executor: exec });
    assert.strictEqual(out.ok, true, out.error);
    assert.strictEqual(exec.calls.length, 1);
    assert.match(exec.calls[0].script, /BEGIN READ ONLY/);
    const after = readState(dir);
    assert.deepStrictEqual([after.status, after.node], ['in_progress', 'verify']);
    assert.ok(after.authorization_history.some(e => e.event === 'manual_applied' && e.by === 'dba' && e.note === 'apliquei via pgAdmin'));
    assert.ok(fs.existsSync(path.join(dir, 'authorization', 'AUTH-001', 'manual-post.txt')));
});

test('manual: sem banco escolhido não há verificação; segue com o registro humano', async () => {
    const { dir } = seedRun();
    request(dir, { then: 'resume:review' });
    authorization.markManual(dir, { by: 'dba', operationId: 'op-manual-2', expectedStateVersion: cas.effectiveVersion(readState(dir)), authorizationId: 'AUTH-001', env: ENV });
    const exec = fakeExecutor();
    const out = await authorization.execute(dir, { mode: 'verify', env: ENV, executor: exec });
    assert.strictEqual(out.ok, true);
    assert.strictEqual(exec.calls.length, 0);
    assert.deepStrictEqual([readState(dir).status, readState(dir).node], ['in_progress', 'review']);
});

test('manual: alias fora da allowlist é recusado', () => {
    const { dir } = seedRun();
    request(dir);
    assert.throws(() => authorization.markManual(dir, { by: 'dba', operationId: 'op-manual-3', expectedStateVersion: cas.effectiveVersion(readState(dir)), authorizationId: 'AUTH-001', targetAlias: 'nao-existe', env: ENV }),
        e => e.code === 'TARGET_NOT_ALLOWED');
});

// ── db-effect: peças ────────────────────────────────────────────────────────────

test('allowlist: senha/connection string na entrada, secret fora do padrão e campos faltando são recusados; lista pública sem usuário', () => {
    const base = { host: 'h', database: 'd', user: 'u', env: 'qa', secret: { keychain: 'prisma-db-a' } };
    assert.match(dbEffect.loadTargets({ PRISMA_DB_TARGETS: JSON.stringify({ a: { ...base, password: 'x' } }) }).error, /senha\/connection string não vão/);
    assert.match(dbEffect.loadTargets({ PRISMA_DB_TARGETS: JSON.stringify({ a: { ...base, url: 'postgres://u:p@h/d' } }) }).error, /connection string/);
    assert.match(dbEffect.loadTargets({ PRISMA_DB_TARGETS: JSON.stringify({ a: { ...base, secret: { env: 'DB_PASS' } } }) }).error, /PRISMA_DB_/);
    assert.match(dbEffect.loadTargets({ PRISMA_DB_TARGETS: JSON.stringify({ a: { ...base, secret: undefined } }) }).error, /"secret" obrigatório/);
    assert.match(dbEffect.loadTargets({ PRISMA_DB_TARGETS: JSON.stringify({ a: { host: 'h', database: 'd', user: 'u', secret: base.secret } }) }).error, /"env" obrigatório/);
    assert.match(dbEffect.loadTargets({ PRISMA_DB_TARGETS: '{x' }).error, /JSON válido/);
    const file = path.join(tmp, 'targets.json');
    fs.writeFileSync(file, JSON.stringify(TARGETS));
    assert.ok(dbEffect.loadTargets({ PRISMA_DB_TARGETS_FILE: file }).targets['qa-app']);
    const pub = dbEffect.publicTargets(ENV).targets;
    const qa = pub.find(t => t.alias === 'qa-app');
    assert.deepStrictEqual([qa.label, qa.env, qa.selectable], ['QA – embarc', 'qa', true]);
    assert.ok(!JSON.stringify(pub).includes('usuario_qa_secreto') && !JSON.stringify(pub).includes('db.qa.local') && !JSON.stringify(pub).includes('prisma-db-'), 'lista pública vaza usuário/host/referência');
    assert.strictEqual(pub.find(t => t.alias === 'prod-app').selectable, false);
});

test('executor real (filho): segredo lido do Keychain só no filho, ao psql por PGPASSWORD; nunca em argv, saída, state ou Attempt', async () => {
    // `security` e `psql` falsos: o security devolve o sentinel; o psql grava argv e o que recebeu.
    const bin = path.join(tmp, 'bin-fake');
    fs.mkdirSync(bin, { recursive: true });
    const argvLog = path.join(tmp, 'psql-argv.log');
    const pwLog = path.join(tmp, 'psql-pw.log');
    fs.writeFileSync(path.join(bin, 'security'), `#!/bin/sh\necho "$*" >> '${path.join(tmp, 'security-argv.log')}'\n` +
        `[ "$1" = find-generic-password ] && [ "$3" = prisma-db-qa-app ] && printf '%s\\n' '${PASSWORD}' && exit 0\nexit 44\n`, { mode: 0o755 });
    fs.writeFileSync(path.join(bin, 'psql'), `#!/bin/sh\necho "$*" >> '${argvLog}'\nprintf '%s' "$PGPASSWORD" > '${pwLog}'\n` +
        `echo "user=$PGUSER host=$PGHOST db=$PGDATABASE"\ncat > /dev/null\necho "FATAL: password authentication failed for user \\"$PGUSER\\" senha $PGPASSWORD" 1>&2\nexit 0\n`, { mode: 0o755 });
    const env = { ...ENV, PATH: `${bin}:/usr/bin:/bin`, HOME: tmp, PRISMA_DB_TARGETS_FILE: '' };
    const exec = dbEffect.createChildExecutor({ env, consumerRoot: tmp });
    assert.strictEqual(exec.available().ok, true);
    const res = await exec.run({ script: "SELECT 1;", alias: 'qa-app' });
    assert.strictEqual(res.exitCode, 0, res.stderr);
    assert.strictEqual(fs.readFileSync(pwLog, 'utf8'), PASSWORD, 'o psql recebeu o segredo do Keychain');
    const argv = fs.readFileSync(argvLog, 'utf8');
    assert.ok(!argv.includes(PASSWORD) && !argv.includes('usuario_qa_secreto') && !argv.includes('db.qa.local'), `argv do psql com dado de conexão: ${argv}`);
    assert.match(argv, /ON_ERROR_STOP=1/);
    assert.ok(!fs.readFileSync(path.join(tmp, 'security-argv.log'), 'utf8').includes(PASSWORD));
    assert.ok(!res.stdout.includes('usuario_qa_secreto') && !res.stderr.includes('usuario_qa_secreto'), 'usuário vazou na saída');
    assert.ok(!res.stdout.includes(PASSWORD) && !res.stderr.includes(PASSWORD), 'segredo vazou na saída');

    // Ponta a ponta com o filho real: nada gravado contém o sentinel.
    const { dir } = seedRun();
    request(dir, { then: 'resume:review', expected_contains: undefined });
    approve(dir);
    const out = await authorization.execute(dir, { env, executor: exec });
    assert.strictEqual(out.ok, true, out.error);
    const files = [];
    const walk = d => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const f = path.join(d, e.name); e.isDirectory() ? walk(f) : files.push(f); } };
    walk(dir);
    for (const f of files) {
        const c = fs.readFileSync(f, 'utf8');
        assert.ok(!c.includes(PASSWORD), `segredo em ${path.relative(dir, f)}`);
        assert.ok(!c.includes('usuario_qa_secreto'), `usuário em ${path.relative(dir, f)}`);
    }

    // Sem segredo no Keychain: não executa (filho sai 64), claro.
    const noSecret = await exec.run({ script: 'SELECT 1;', alias: 'prod-liberado' });
    assert.strictEqual(noSecret.spawnError, 'NOT_RUN');
    assert.match(noSecret.stderr, /não encontrado no Keychain/);
});

test('approvers: hash scrypt, sem aprovador = fail closed, senha errada negada', () => {
    const approvers = require('./approvers');
    const h = approvers.hashPassword('senha-de-aprovacao-1');
    assert.ok(!h.includes('senha-de-aprovacao-1'));
    const env = { PRISMA_APPROVERS: JSON.stringify({ richard: h }) };
    assert.deepStrictEqual(approvers.verify('richard', 'senha-de-aprovacao-1', env), { ok: true, name: 'richard' });
    assert.strictEqual(approvers.verify('richard', 'errada', env).code, 'DENIED');
    assert.strictEqual(approvers.verify('outro', 'senha-de-aprovacao-1', env).code, 'DENIED');
    assert.strictEqual(approvers.verify('richard', '', env).code, 'MISSING');
    assert.strictEqual(approvers.verify('richard', 'x', { HOME: tmp }).code, 'NO_APPROVERS');
});

test('db-targets: entrada nova referencia o Keychain (sem senha); senha em argv é recusada', async () => {
    const dbTargets = require('./db-targets');
    const { entry, errors } = dbTargets.buildEntry('qa-app', { host: 'h', db: 'd', user: 'u', env: 'qa', label: 'QA' });
    assert.deepStrictEqual(errors, []);
    assert.deepStrictEqual(entry.secret, { keychain: 'prisma-db-qa-app', account: 'qa-app' });
    const r = await new Promise(resolve => execFile(process.execPath, [path.join(__dirname, 'db-targets.js'), 'add', 'qa-app', '--host=h', '--db=d', '--user=u', '--env=qa', '--password=x'],
        { env: { ...process.env, HOME: tmp, PRISMA_DB_TARGETS_FILE: path.join(tmp, 'dbt.json') } }, (err, so, se) => resolve({ code: err ? err.code : 0, se })));
    assert.strictEqual(r.code, 2);
    assert.match(r.se, /senha não vai em argv/);
    assert.ok(!fs.existsSync(path.join(tmp, 'dbt.json')));
});

test('verify_sql: só leitura', () => {
    assert.deepStrictEqual(dbEffect.checkVerifySql("SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'x; DROP TABLE y'"), []);
    assert.ok(dbEffect.checkVerifySql('SELECT 1; DELETE FROM t').length);
    assert.ok(dbEffect.checkVerifySql('UPDATE t SET a = 1').length);
    assert.ok(dbEffect.checkArtifactSql('\\i outro.sql').length);
    assert.ok(dbEffect.checkArtifactSql('CREATE INDEX CONCURRENTLY i ON t (a);').length);
    assert.deepStrictEqual(dbEffect.checkArtifactSql(SQL), []);
});
