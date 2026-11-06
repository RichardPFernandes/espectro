// node --test authorization-api.test.js
// Endpoints de autorização humana e devolução ao QA (PRI-180): GET/approve/reject/manual
// e handback-qa, com executor de SQL FALSO injetado (nunca banco real), Redmine falso
// em loopback que exige X-Redmine-API-Key e config segura (allowlist + aprovadores) num
// diretório temporário injetado por código — nunca por env/.env (revisão de segurança).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { createDashboard } = require('./server');

const KEY = 'redmine-chave-de-teste-autorizacao-1';
// Sentinels: senha do aprovador, usuário e host do banco nunca saem em resposta/log.
const APPROVER_PW = 'senha-aprovador-SENTINEL-55';
const DB_USER = 'usuario_banco_sentinel';
const approvers = require('../scripts/lib/approvers');
const prismaConfig = require('../scripts/lib/prisma-config');
const CRED = { approver: 'richard', approver_password: APPROVER_PW };
const tmpBase = process.env.CLAUDE_JOB_DIR ? path.join(process.env.CLAUDE_JOB_DIR, 'tmp') : os.tmpdir();
const tmp = fs.mkdtempSync(path.join(tmpBase, 'authorization-api-'));
const repo = path.join(tmp, 'app-back');
const runs = path.join(repo, 'memory', 'runs');
const SQL = "ALTER TABLE t ADD CONSTRAINT c CHECK (tipo IN ('A','SERVICO_ADICIONAL'));\n";
const SHA = crypto.createHash('sha256').update(SQL).digest('hex');
fs.mkdirSync(path.join(repo, 'docs', 'migrations'), { recursive: true });
fs.writeFileSync(path.join(repo, 'docs', 'migrations', 'check.sql'), SQL);

function writeRun(taskId, { phase = 'pending', status = 'authorization-pending', then = 'handback_qa', alias = 'qa-app', pending = true } = {}) {
    const dir = path.join(runs, taskId);
    fs.mkdirSync(dir, { recursive: true });
    const at = new Date().toISOString();
    fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({
        task_id: taskId, node: 'implement', history: ['plan', 'implement'], status, updated_at: at,
        redmine_ticket: { id: Number(taskId.split('-')[0]), subject: 'Serviço Adicional' }, execution_id: 'exec-x',
        blocked_reason: 'migration não aplicada no QA',
        ...(pending ? { pending_authorization: {
            id: 'AUTH-001', kind: 'db_migration', summary: 'aplicar a constraint no QA', target_hint: { alias },
            artifact: 'docs/migrations/check.sql', artifact_sha256: SHA, verify_sql: "SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'c'",
            expected: 'lista SERVICO_ADICIONAL', expected_contains: 'SERVICO_ADICIONAL', then, requested_by: 'implement', requested_at: at, phase,
        }, authorization_history: [{ id: 'AUTH-001', event: 'requested', by: 'implement', via: 'agent', at }] } : {}),
    }, null, 2));
    fs.writeFileSync(path.join(dir, 'context.md'), '# Contexto\n');
    fs.writeFileSync(path.join(dir, 'handoff.md'), '# Handoff\n\nO erro é do banco do QA.\n');
    issues.set(Number(taskId.split('-')[0]), { status: 2, journals: [], mode: 'ok' });
    return dir;
}
const readState = taskId => JSON.parse(fs.readFileSync(path.join(runs, taskId, 'state.json'), 'utf8'));

const issues = new Map();
const seen = [];
const redmine = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
        seen.push({ method: req.method, url: req.url, key: req.headers['x-redmine-api-key'], body });
        if (req.headers['x-redmine-api-key'] !== KEY) { res.writeHead(401); return res.end('{}'); }
        const m = req.url.match(/^\/issues\/(\d+)\.json/);
        const issue = m && issues.get(Number(m[1]));
        if (!issue) { res.writeHead(404); return res.end('{}'); }
        if (req.method === 'PUT') {
            if (issue.mode === '422') { res.writeHead(422, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ errors: ['Apontamentos Desenvolvedor não pode ficar vazio'] })); }
            const parsed = JSON.parse(body).issue;
            issue.status = parsed.status_id;
            issue.journals.push({ id: issue.journals.length + 1, notes: parsed.notes });
            res.writeHead(204); return res.end();
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ issue: { id: Number(m[1]), status: { id: issue.status, name: 'x' }, journals: issue.journals } }));
    });
});

const calls = [];
const OK_VERIFY = { ok: true, text: "CHECK (tipo IN ('A','SERVICO_ADICIONAL'))" };
const executor = {
    available: () => ({ ok: true }),
    async run(job) {
        calls.push(job);
        if (job.mode === 'verify') return { post: OK_VERIFY };
        return { pre: OK_VERIFY, apply: { ok: true, certain: true, text: '1: ALTER' }, post: OK_VERIFY };
    },
};
const CONFIG = path.join(tmp, 'config-prisma');
prismaConfig.writeSecureJson('db-targets.json', {
    'qa-app': { label: 'QA – embarc', host: 'db.qa.interno', database: 'embarc_db_stage', user: DB_USER, env: 'qa', secret: { keychain: 'prisma-db-qa-app', account: 'qa-app' } },
    'prod-app': { host: 'db.prod', database: 'embarc', user: DB_USER, env: 'production', secret: { keychain: 'prisma-db-prod-app' } },
}, { dir: CONFIG });
prismaConfig.writeSecureJson('approvers.json', { richard: approvers.hashPassword(APPROVER_PW), dba: approvers.hashPassword('senha-do-dba-123') }, { dir: CONFIG });

let dash, base;
const logs = [];
const orig = { log: console.log, warn: console.warn, error: console.error };
test.before(async () => {
    for (const k of ['log', 'warn', 'error']) console[k] = (...a) => { logs.push(a.join(' ')); };
    await new Promise(r => redmine.listen(0, '127.0.0.1', r));
    const env = {
        ...process.env, REDMINE_URL: `http://127.0.0.1:${redmine.address().port}`, REDMINE_API_KEY: KEY,
        REDMINE_MIN_INTERVAL_MS: '0', REDMINE_RETRY_MAX_ATTEMPTS: '1', STATE_CONFLICTS_LOG: path.join(tmp, 'conflicts.jsonl'),
        // A1: o que viesse do .env/env do consumidor é ignorado (só ~/.config/prisma vale).
        PRISMA_APPROVERS: JSON.stringify({ intruso: approvers.hashPassword('senha-do-intruso-1') }),
        PRISMA_DB_TARGETS: JSON.stringify({ evil: { host: 'evil', database: 'x', user: 'u', env: 'qa', secret: { keychain: 'prisma-db-evil' } } }),
    };
    dash = createDashboard({ env, repoRoot: repo, memoryDir: runs, worktreesDir: path.join(tmp, 'wt'), prefsFile: path.join(tmp, 'prefs.json'), dbExecutor: executor, prismaConfigDir: CONFIG });
    await new Promise(r => dash.server.listen(0, '127.0.0.1', r));
    base = `http://localhost:${dash.server.address().port}`;
    await dash.ready;
});
test.after(async () => {
    Object.assign(console, orig);
    await dash.close();
    redmine.close();
    fs.rmSync(tmp, { recursive: true, force: true });
});

const get = async p => { const r = await fetch(base + p); const text = clean(await r.text()); return { status: r.status, body: JSON.parse(text) }; };
const post = async (p, body = {}) => {
    const r = await fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const text = clean(await r.text());
    return { status: r.status, text, body: JSON.parse(text) };
};
const casOf = async taskId => (await get(`/api/runs/${taskId}`)).body.casToken;
const hashOf = async (taskId, alias = 'qa-app') => (await get(`/api/runs/${taskId}/authorization${alias ? `?target=${alias}` : ''}`)).body.request.request_hash;
// Toda resposta HTTP passa por aqui: nenhum sentinel pode sair.
const responses = [];
const clean = text => { responses.push(text); return text; };
test.after(() => {
    const all = responses.join('\n');
    for (const s of [APPROVER_PW, DB_USER, 'db.qa.interno']) assert.ok(!all.includes(s), `vazou em resposta HTTP: ${s}`);
    const logged = logs.join('\n');
    for (const s of [APPROVER_PW, DB_USER]) assert.ok(!logged.includes(s), `vazou no log do dashboard: ${s}`);
});

test('GET /authorization: pedido com conteúdo do SQL, hash conferido e alvo da allowlist (sem senha)', async () => {
    writeRun('42359-recusa-a');
    const { status, body, } = await get('/api/runs/42359-recusa-a/authorization');
    assert.strictEqual(status, 200);
    assert.strictEqual(body.pending.id, 'AUTH-001');
    assert.strictEqual(body.artifact.content, SQL);
    assert.deepStrictEqual([body.artifact.sha256_now, body.artifact.matches], [SHA, true]);
    assert.strictEqual(body.target, undefined, 'sem dados de alvo sem autenticar');
    assert.strictEqual(body.pending.target_hint.alias, 'qa-app');
    assert.strictEqual(body.approvers_configured, true);
    assert.strictEqual(body.handback.available, true);
    assert.strictEqual(body.ticketId, 42359);
    assert.match(body.handback.preview.notes, /Devolvido ao QA/, 'aprovador vê a nota antes');
    assert.match(body.request.request_hash, /^[0-9a-f]{64}$/);
    const withTarget = (await get('/api/runs/42359-recusa-a/authorization?target=qa-app')).body.request;
    assert.notStrictEqual(withTarget.request_hash, body.request.request_hash, 'o hash inclui o banco escolhido');
    assert.strictEqual(withTarget.canonical.target, 'qa-app');
});

test('C3: o SQL aparece INTEGRAL na tela, sem redação (o que parece segredo também executa)', async () => {
    const dir = writeRun('42367-recusa-i');
    const tricky = 'UPDATE configuracao SET x_token=1;DROP/**/TABLE/**/clientes;\n';
    fs.writeFileSync(path.join(repo, 'docs', 'migrations', 'tricky.sql'), tricky);
    const s = readState('42367-recusa-i');
    s.pending_authorization.artifact = 'docs/migrations/tricky.sql';
    s.pending_authorization.artifact_sha256 = crypto.createHash('sha256').update(tricky).digest('hex');
    fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify(s));
    const { body } = await get('/api/runs/42367-recusa-i/authorization');
    assert.strictEqual(body.artifact.content, tricky);
    assert.ok(!body.artifact.content.includes('***'));
});

test('targets: só para aprovador autenticado (401 sem, 403 errado); lista alias/rótulo, host/banco mascarados', async () => {
    assert.strictEqual((await post('/api/authorization/targets', {})).status, 401);
    assert.strictEqual((await post('/api/authorization/targets', { approver: 'richard', approver_password: 'errada' })).status, 403);
    assert.strictEqual((await post('/api/authorization/targets', { approver: 'intruso', approver_password: APPROVER_PW })).status, 403);
    const ok = await post('/api/authorization/targets', CRED);
    assert.strictEqual(ok.status, 200, ok.text);
    const qa = ok.body.targets.find(t => t.alias === 'qa-app');
    assert.deepStrictEqual([qa.label, qa.env, qa.selectable, qa.host], ['QA – embarc', 'qa', true, 'db…o']);
    assert.strictEqual(ok.body.targets.find(t => t.alias === 'prod-app').selectable, false);
});

test('approve/manual/reject/handback sem aprovador → 401; senha errada → 403; nada muda', async () => {
    writeRun('42365-recusa-g');
    const token = await casOf('42365-recusa-g');
    for (const [p, extra] of [['authorization/approve', { artifact_sha256: SHA, target_alias: 'qa-app' }], ['authorization/manual', {}], ['authorization/reject', {}], ['handback-qa', {}]]) {
        const none = await post(`/api/runs/42365-recusa-g/${p}`, { ...token, authorization_id: 'AUTH-001', operation_id: `op-noauth-${p.replace(/\W/g, '')}`, ...extra });
        assert.strictEqual(none.body.code, 'APPROVER_REQUIRED');
        assert.strictEqual(none.status, 401, p);
        const wrong = await post(`/api/runs/42365-recusa-g/${p}`, { ...token, authorization_id: 'AUTH-001', operation_id: `op-wrong-${p.replace(/\W/g, '')}`, approver: 'richard', approver_password: 'chute', ...extra });
        assert.strictEqual(wrong.status, 403, p);
    }
    assert.strictEqual(calls.length, 0);
    const s = readState('42365-recusa-g');
    assert.deepStrictEqual([s.status, s.pending_authorization.phase], ['authorization-pending', 'pending']);
    assert.ok(!seen.some(r => r.url === '/issues/42365.json' && r.method === 'PUT'));
});

test('approve: alias fora da allowlist ou de produção sem allow_production → 409, nada executa', async () => {
    writeRun('42366-recusa-h');
    const token = await casOf('42366-recusa-h');
    const out = await post('/api/runs/42366-recusa-h/authorization/approve', { ...token, ...CRED, authorization_id: 'AUTH-001', request_hash: await hashOf('42366-recusa-h', 'banco-qualquer'), target_alias: 'banco-qualquer', operation_id: 'op-alias-1' });
    assert.strictEqual(out.status, 409);
    assert.strictEqual(out.body.code, 'TARGET_NOT_ALLOWED');
    const prod = await post('/api/runs/42366-recusa-h/authorization/approve', { ...token, ...CRED, authorization_id: 'AUTH-001', request_hash: await hashOf('42366-recusa-h', 'prod-app'), target_alias: 'prod-app', operation_id: 'op-alias-2' });
    assert.strictEqual(prod.body.code, 'PRODUCTION_REFUSED');
    const evil = await post('/api/runs/42366-recusa-h/authorization/approve', { ...token, approver: 'intruso', approver_password: 'senha-do-intruso-1', authorization_id: 'AUTH-001', request_hash: 'x', target_alias: 'evil', operation_id: 'op-alias-3' });
    assert.strictEqual(evil.status, 403, 'A1: aprovador/allowlist do env/.env não valem');
    assert.strictEqual(calls.length, 0);
});

test('approve: CAS velho → 409 sem executar; com a versão da tela executa, devolve ao QA e arquiva', async () => {
    writeRun('42360-recusa-b');
    const token = await casOf('42360-recusa-b');
    const hash = await hashOf('42360-recusa-b');
    const stale = await post('/api/runs/42360-recusa-b/authorization/approve', { ...token, ...CRED, expected_state_version: token.expected_state_version - 1, authorization_id: 'AUTH-001', request_hash: hash, target_alias: 'qa-app', operation_id: 'op-approve-stale' });
    assert.strictEqual(stale.status, 409);
    assert.strictEqual(stale.body.code, 'STATE_CONFLICT');
    assert.strictEqual(calls.length, 0);
    const noHash = await post('/api/runs/42360-recusa-b/authorization/approve', { ...token, ...CRED, authorization_id: 'AUTH-001', target_alias: 'qa-app', operation_id: 'op-approve-nohash' });
    assert.strictEqual(noHash.status, 409);
    assert.strictEqual(noHash.body.code, 'REQUEST_HASH_REQUIRED');

    const ok = await post('/api/runs/42360-recusa-b/authorization/approve', { ...token, ...CRED, authorization_id: 'AUTH-001', request_hash: hash, target_alias: 'qa-app', operation_id: 'op-approve-1', by: 'forjado' });
    assert.strictEqual(ok.status, 200, ok.text);
    assert.deepStrictEqual([ok.body.ok, ok.body.outcome, ok.body.handback.archived], [true, 'applied', true]);
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].sql, SQL);
    const put = seen.filter(r => r.method === 'PUT' && r.url === '/issues/42360.json').at(-1);
    assert.strictEqual(put.key, KEY);
    assert.strictEqual(JSON.parse(put.body).issue.status_id, 8);
    assert.match(JSON.parse(put.body).issue.notes, /qa-app/);
    const archived = JSON.parse(fs.readFileSync(path.join(runs, '_archive', '42360-recusa-b', 'state.json'), 'utf8'));
    assert.strictEqual(archived.status, 'handed_back_qa');
    assert.ok(archived.authorization_history.some(e => e.event === 'approved' && e.by === 'richard' && e.via === 'dashboard' && e.target === 'qa-app'), 'by = aprovador autenticado, não o "by" do body');
    assert.ok(!JSON.stringify(archived).includes(DB_USER));
    // Não entra no registro do dashboard: segue visível como arquivado com demanda aberta
    // e uma nova Recusa QA reaproveita o run pelo "Corrigir recusa QA".
    const reg = path.join(runs, '_archive', 'dashboard-archived.json');
    assert.ok(!fs.existsSync(reg) || !JSON.parse(fs.readFileSync(reg, 'utf8'))['42360-recusa-b']);
});

test('reject: volta para blocked com o motivo; dá para responder ao agente', async () => {
    writeRun('42361-recusa-c');
    const token = await casOf('42361-recusa-c');
    const r = await post('/api/runs/42361-recusa-c/authorization/reject', { ...token, ...CRED, authorization_id: 'AUTH-001', reason: 'não neste ambiente', operation_id: 'op-reject-1' });
    assert.strictEqual(r.status, 200, r.text);
    const s = readState('42361-recusa-c');
    assert.strictEqual(s.status, 'blocked');
    assert.match(s.blocked_reason, /recusada por richard: não neste ambiente/);
    assert.strictEqual(s.pending_authorization, undefined);
    const msg = await post('/api/runs/42361-recusa-c/message', { message: 'tente pelo código então' });
    assert.strictEqual(msg.status, 200);
    // Mesmo clique de novo: idempotente.
    const again = await post('/api/runs/42361-recusa-c/authorization/reject', { ...token, ...CRED, authorization_id: 'AUTH-001', operation_id: 'op-reject-1' });
    assert.strictEqual(again.body.status, 'already_processed');
});

test('manual: registra quem, roda só o verify e segue o then (resume:review)', async () => {
    writeRun('42362-recusa-d', { then: 'resume:review' });
    const before = calls.length;
    const token = await casOf('42362-recusa-d');
    const r = await post('/api/runs/42362-recusa-d/authorization/manual', { ...token, approver: 'dba', approver_password: 'senha-do-dba-123', authorization_id: 'AUTH-001', request_hash: await hashOf('42362-recusa-d'), target_alias: 'qa-app', operation_id: 'op-manual-1' });
    assert.strictEqual(r.status, 200, r.text);
    assert.strictEqual(calls.length - before, 1);
    assert.strictEqual(calls.at(-1).mode, 'verify');
    const s = readState('42362-recusa-d');
    assert.deepStrictEqual([s.status, s.node], ['in_progress', 'review']);
    assert.ok(s.authorization_history.some(e => e.event === 'manual_applied' && e.by === 'dba'));
});

test('handback-qa: 422 não arquiva (blocked com o campo); depois de corrigido, devolve e arquiva', async () => {
    writeRun('42363-recusa-e', { status: 'blocked', pending: false });
    issues.get(42363).mode = '422';
    const token = await casOf('42363-recusa-e');
    const fail = await post('/api/runs/42363-recusa-e/handback-qa', { ...token, ...CRED, operation_id: 'op-hb-1' });
    assert.strictEqual(fail.status, 502);
    assert.match(fail.body.error, /422.*Apontamentos Desenvolvedor/);
    assert.ok(fs.existsSync(path.join(runs, '42363-recusa-e')), 'não arquivou');
    const s = readState('42363-recusa-e');
    assert.strictEqual(s.status, 'blocked');
    assert.strictEqual(s.pending_operations, undefined, '4xx: reserva liberada');
    issues.get(42363).mode = 'ok';
    const ok = await post('/api/runs/42363-recusa-e/handback-qa', { ...(await casOf('42363-recusa-e')), ...CRED, operation_id: 'op-hb-2', apontamentos: 'SQL aplicado pelo DBA' });
    assert.strictEqual(ok.status, 200, ok.text);
    assert.ok(fs.existsSync(path.join(runs, '_archive', '42363-recusa-e', 'state.json')));
    const put = JSON.parse(seen.filter(r => r.method === 'PUT' && r.url === '/issues/42363.json').at(-1).body).issue;
    assert.deepStrictEqual(put.custom_fields, [{ id: 2, value: 'SQL aplicado pelo DBA' }]);
});

test('handback-qa: só para blocked/authorization-pending', async () => {
    writeRun('42364-recusa-f', { status: 'in_progress', pending: false });
    const r = await post('/api/runs/42364-recusa-f/handback-qa', { ...(await casOf('42364-recusa-f')), ...CRED, operation_id: 'op-hb-x' });
    assert.strictEqual(r.status, 409);
});

test('A3: pedido trocado no state depois do GET → 409 REQUEST_CHANGED, nada executa', async () => {
    const dir = writeRun('42368-recusa-j');
    const hash = await hashOf('42368-recusa-j');
    const st = readState('42368-recusa-j');
    st.pending_authorization.verify_sql = "SELECT '/*'; COMMIT; DELETE FROM clientes; SELECT '*/'";
    st.pending_authorization.then = 'resume:commit';
    fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify(st));
    const before = calls.length;
    const r = await post('/api/runs/42368-recusa-j/authorization/approve', { ...(await casOf('42368-recusa-j')), ...CRED, authorization_id: 'AUTH-001', request_hash: hash, target_alias: 'qa-app', operation_id: 'op-changed-1' });
    assert.strictEqual(r.status, 409);
    assert.strictEqual(r.body.code, 'REQUEST_CHANGED');
    assert.strictEqual(calls.length, before);
});

// PRI-233 T8 (P-2): override humano de roteamento pelo mesmo canal/autoridade das
// decisões (aprovador + CAS), sem pausar a Run. Antes do B3 (que esgota o rate limit).
test('PRI-233 T8: POST routing-override grava a override com aprovador e CAS, sem mudar status', async () => {
    const id = '42370-routing-a';
    const dir = writeRun(id, { status: 'in_progress', pending: false });
    const s = JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'));
    fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ ...s,
        routing_snapshot: { attempt_id: '00000000-0000-4000-8000-000000000000', sha256: 'a'.repeat(64) } }));
    const body = { scope: 'node', node: 'implement', model_id: 'claude-opus-5-5', effort: 'alto' };

    const denied = await post(`/api/runs/${id}/routing-override`, { ...(await casOf(id)), ...body, approver: 'richard', approver_password: 'chute', operation_id: 'op-route-deny' });
    assert.strictEqual(denied.status, 403);
    assert.strictEqual(readState(id).routing_overrides, undefined, 'senha errada não grava');

    const ok = await post(`/api/runs/${id}/routing-override`, { ...(await casOf(id)), ...body, ...CRED, operation_id: 'op-route-ok-1' });
    assert.strictEqual(ok.status, 200, JSON.stringify(ok.body));
    assert.deepStrictEqual([ok.body.ok, ok.body.override.ref, ok.body.override.by, ok.body.override.value],
        [true, 'RO-1', 'richard', { model_id: 'claude-opus-5-5', effort: 'alto' }]);
    const after = readState(id);
    assert.strictEqual(after.status, 'in_progress', 'a Run não pausa');
    assert.strictEqual(after.routing_overrides.length, 1);
    const listed = (await get('/api/runs')).body.find(r => r.taskId === id);
    assert.deepStrictEqual(listed.routingOverrides.map(o => o.ref), ['RO-1']);

    const again = await post(`/api/runs/${id}/routing-override`, { ...(await casOf(id)), ...body, ...CRED, operation_id: 'op-route-ok-1' });
    assert.deepStrictEqual([again.status, again.body.status], [200, 'already_processed']);
    assert.strictEqual(readState(id).routing_overrides.length, 1);
});

test('PRI-233 T8: routing-override recusa Run OFF, entrada inválida e nó rodando', async () => {
    const off = '42370-routing-b';
    writeRun(off, { status: 'in_progress', pending: false });
    const r1 = await post(`/api/runs/${off}/routing-override`, { ...(await casOf(off)), scope: 'ticket', model_id: 'm', effort: 'alto', ...CRED, operation_id: 'op-route-off' });
    assert.deepStrictEqual([r1.status, r1.body.code], [409, 'ROUTING_OFF']);

    const on = '42370-routing-c';
    const dir = writeRun(on, { status: 'in_progress', pending: false });
    const s = JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'));
    fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ ...s, routing_snapshot: { attempt_id: '00000000-0000-4000-8000-000000000000', sha256: 'a'.repeat(64) } }));
    const r2 = await post(`/api/runs/${on}/routing-override`, { ...(await casOf(on)), scope: 'projeto', model_id: 'm', effort: 'alto', ...CRED, operation_id: 'op-route-bad' });
    assert.deepStrictEqual([r2.status, r2.body.code], [409, 'OVERRIDE_INVALID']);

    fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ ...readState(on), status: 'running' }));
    const r3 = await post(`/api/runs/${on}/routing-override`, { ...(await casOf(on)), scope: 'ticket', model_id: 'm', effort: 'alto', ...CRED, operation_id: 'op-route-running' });
    assert.strictEqual(r3.status, 409);
    assert.strictEqual(readState(on).routing_overrides, undefined);
});

test('B3: rate limit global além do por nome (nomes variados) → 429', async () => {
    let last = null;
    for (let i = 0; i < 22; i++) last = await post('/api/authorization/targets', { approver: `chute${i}`, approver_password: 'errada' });
    assert.strictEqual(last.status, 429);
});
