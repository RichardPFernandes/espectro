// node --test scripts/lib/authorization-watcher.test.js
// Watcher diante de um run authorization-pending (PRI-180): não despacha, não chama o
// intérprete de mensagem livre (que não aprova nada) e comenta no Redmine uma vez só.
// REPO_PATH sintético, fetch stubado e binário `claude` falso no PATH.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(process.env.CLAUDE_JOB_DIR ? path.join(process.env.CLAUDE_JOB_DIR, 'tmp') : os.tmpdir(), 'auth-watcher-'));
const repo = path.join(tmp, 'app-back');
const binDir = path.join(tmp, 'bin');
const claudeCalls = path.join(tmp, 'claude-calls.log');
fs.mkdirSync(repo, { recursive: true });
fs.mkdirSync(binDir);
// Qualquer chamada ao claude (agente ou intérprete) fica registrada; o intérprete "aprovaria".
fs.writeFileSync(path.join(binDir, 'claude'), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${claudeCalls}'\n` +
    `echo '{"type":"result","is_error":false,"structured_output":{"intent":"resume","node":"implement","confidence":0.99,"understood":"aprovado","instructions":"","question":""}}'\n`, { mode: 0o755 });
fs.writeFileSync(path.join(binDir, 'osascript'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
process.env.REPO_PATH = repo;
process.env.SKIP_PRE_BUILD_VALIDATION = 'true';
process.env.REDMINE_URL = 'http://redmine.test';
process.env.REDMINE_API_KEY = 'k';
process.env.PATH = `${binDir}:${process.env.PATH}`;
const puts = [];
global.fetch = async (url, init = {}) => {
    if ((init.method || 'GET') === 'PUT') puts.push({ url, body: init.body });
    return { ok: true, status: 204, json: async () => ({}), text: async () => '' };
};

const watcher = require('../readmine-watcher');
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

function seed(id) {
    const taskId = `${id}-recusa`;
    const dir = path.join(repo, '.claude', 'worktrees', String(id), 'memory', 'runs', taskId);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({
        task_id: taskId, node: 'implement', history: ['plan', 'implement'], status: 'authorization-pending', started_at: new Date().toISOString(),
        blocked_reason: 'Autorização AUTH-001 pendente: aplicar check constraint',
        pending_authorization: {
            id: 'AUTH-001', kind: 'db_migration', summary: 'aplicar check constraint no banco do QA', target_hint: { alias: 'qa-app' },
            artifact: 'docs/migrations/check.sql', artifact_sha256: 'a'.repeat(64), verify_sql: 'SELECT 1', expected: 'lista SERVICO_ADICIONAL',
            then: 'handback_qa', requested_by: 'implement', requested_at: new Date().toISOString(), phase: 'pending',
        },
    }));
    fs.writeFileSync(path.join(dir, 'context.md'), '# Contexto\n');
    return { taskId, dir };
}
const ticket = id => ({
    id, subject: `Ticket ${id}`, description: '', status: { name: 'Em Desenvolvimento' }, tracker: { name: 'Melhoria' },
    custom_fields: [{ name: 'Branch Liberação', value: 'Dev - Local' }], updated_on: new Date().toISOString(),
});
const readState = dir => JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'));

test('dispatchTicket: authorization-pending é pulado sem despachar, mensagem "aprovado" não passa pelo intérprete e não aprova', async () => {
    const { dir } = seed(92001);
    fs.writeFileSync(path.join(dir, 'human-input.md'), '## Human input — X\n\naprovado, pode rodar o SQL no banco do QA\n');
    const result = await watcher.dispatchTicket(ticket(92001));
    assert.strictEqual(result.action, 'skip');
    assert.strictEqual(result.reason, 'status_authorization_pending');
    assert.strictEqual(result.authorization, 'AUTH-001');
    const s = readState(dir);
    assert.strictEqual(s.status, 'authorization-pending');
    assert.strictEqual(s.pending_authorization.phase, 'pending');
    assert.strictEqual(s.human_input_interpretations, undefined);
    assert.ok(!fs.existsSync(claudeCalls), 'nenhum claude (agente ou intérprete) foi chamado');
    assert.ok(fs.existsSync(path.join(dir, 'human-input.md')), 'mensagem continua na fila');
});

test('dispatchTicket: comenta no Redmine uma vez por pedido (sem spam a cada tick)', async () => {
    const { dir } = seed(92002);
    const before = puts.length;
    await watcher.dispatchTicket(ticket(92002));
    await watcher.dispatchTicket(ticket(92002));
    const mine = puts.slice(before).filter(p => p.url.includes('/issues/92002.json'));
    assert.strictEqual(mine.length, 1);
    const notes = JSON.parse(mine[0].body).issue.notes;
    assert.match(notes, /AUTH-001[\s\S]*Aprovar[\s\S]*Mensagem livre .*não aprova/);
    assert.strictEqual(readState(dir).status, 'authorization-pending');
});

test('findLocallyActiveTicketIds: authorization-pending conta como ativo (reidratado todo tick, para o skip acima)', () => {
    seed(92003);
    assert.ok(watcher.findLocallyActiveTicketIds().includes(92003));
});

test('A4: config/segredo de banco e aprovadores não chegam ao ambiente do agente', () => {
    process.env.PRISMA_DB_QA_APP_PASSWORD = 'segredo-que-nao-pode-vazar';
    process.env.PRISMA_APPROVERS = '{}';
    process.env.PGPASSWORD = 'outro-segredo';
    try {
        const env = watcher.cleanAgentEnv();
        for (const k of ['PRISMA_DB_QA_APP_PASSWORD', 'PRISMA_APPROVERS', 'PGPASSWORD']) assert.strictEqual(env[k], undefined, k);
    } finally {
        delete process.env.PRISMA_DB_QA_APP_PASSWORD; delete process.env.PRISMA_APPROVERS; delete process.env.PGPASSWORD;
    }
});
