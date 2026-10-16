// node --test scripts/lib/qa-handback.test.js
// Devolução ao QA sem código (scripts/lib/qa-handback.js) contra um Redmine FALSO em
// loopback que exige X-Redmine-API-Key (como o real), com 422 e 5xx sob controle.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const qaHandback = require('./qa-handback');
const dom06 = require('./dom06-attempt');

const KEY = 'chave-redmine-falsa-handback-123';
const tmpBase = process.env.CLAUDE_JOB_DIR ? path.join(process.env.CLAUDE_JOB_DIR, 'tmp') : os.tmpdir();
const tmp = fs.mkdtempSync(path.join(tmpBase, 'qa-handback-'));
process.env.STATE_CONFLICTS_LOG = path.join(tmp, 'state-conflicts.jsonl');

// Ticket falso: { status, journals[], mode: 'ok' | '422' | '500' }.
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
            // 500 depois de gravar: o caso incerto.
            issue.status = parsed.status_id;
            issue.journals.push({ id: issue.journals.length + 1, notes: parsed.notes });
            issue.custom = parsed.custom_fields;
            if (issue.mode === '500') { res.writeHead(500); return res.end('{}'); }
            res.writeHead(204); return res.end();
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ issue: { id: Number(m[1]), status: { id: issue.status }, journals: issue.journals } }));
    });
});

let env;
test.before(async () => {
    await new Promise(r => redmine.listen(0, '127.0.0.1', r));
    env = { REDMINE_URL: `http://127.0.0.1:${redmine.address().port}`, REDMINE_API_KEY: KEY, REDMINE_MIN_INTERVAL_MS: '0', REDMINE_RETRY_BASE_DELAY_MS: '0', REDMINE_RETRY_MAX_ATTEMPTS: '1' };
});
test.after(() => { redmine.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

let seq = 0;
function seedRun(ticketId, state = {}) {
    const root = path.join(tmp, `repo-${++seq}`);
    const taskId = `${ticketId}-recusa-${seq}`;
    const dir = path.join(root, 'memory', 'runs', taskId);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({
        task_id: taskId, node: 'implement', history: ['implement'], status: 'blocked', redmine_ticket: { id: ticketId },
        blocked_reason: 'migration não aplicada no banco do QA', ...state,
    }, null, 2));
    fs.writeFileSync(path.join(dir, 'handoff.md'), '# Handoff\n\n## Por que bloqueou\n\nO erro vem do banco do QA sem a migration.\n');
    issues.set(ticketId, { status: 13, journals: [], mode: 'ok' });
    return { root, dir, taskId };
}

test('handback: PUT com X-Redmine-API-Key, status Ag Teste (8), notas + Apontamentos (cf 2); arquiva com handed_back_qa', async () => {
    const { root, dir, taskId } = seedRun(42359);
    const out = await qaHandback.handback(dir, { by: 'richard', operationId: 'op-hb-1', env });
    assert.strictEqual(out.ok, true, out.error);
    const put = seen.filter(r => r.method === 'PUT' && r.url === '/issues/42359.json').at(-1);
    assert.strictEqual(put.key, KEY);
    const issue = JSON.parse(put.body).issue;
    assert.strictEqual(issue.status_id, 8);
    assert.match(issue.notes, /Devolvido ao QA sem nova mudança de código[\s\S]*\[op handback:op-hb-1\]/);
    assert.deepStrictEqual(issue.custom_fields.map(c => c.id), [2]);
    assert.match(issue.custom_fields[0].value, /migration não aplicada[\s\S]*Por que bloqueou/);
    assert.ok(!fs.existsSync(dir), 'run saiu de memory/runs');
    const archived = path.join(root, 'memory', 'runs', '_archive', taskId);
    const s = JSON.parse(fs.readFileSync(path.join(archived, 'state.json'), 'utf8'));
    assert.strictEqual(s.status, 'handed_back_qa');
    assert.strictEqual(s.ticket_status, 'Ag Teste');
    assert.strictEqual(s.handed_back_qa.by, 'richard');
    assert.ok(s.processed_operations.some(o => o.operation_id === 'op-hb-1' && o.type === 'QA_HANDBACK'));
    assert.strictEqual(s.blocked_reason, undefined);
    const attempt = dom06.listAttempts(archived).find(a => a.node === 'handback_qa');
    assert.strictEqual(attempt.result, 'COMPLETE');
});

test('handback: ids configuráveis (REDMINE_STATUS_AG_TESTE / REDMINE_CF_APONTAMENTOS_ID) e textos editados', async () => {
    const { dir } = seedRun(42400);
    const out = await qaHandback.handback(dir, { by: 'r', operationId: 'op-hb-cfg', notes: 'nota editada', apontamentos: 'apontamento editado', env: { ...env, REDMINE_STATUS_AG_TESTE: '31', REDMINE_CF_APONTAMENTOS_ID: '77' } });
    assert.strictEqual(out.ok, true);
    const issue = JSON.parse(seen.filter(r => r.method === 'PUT' && r.url === '/issues/42400.json').at(-1).body).issue;
    assert.strictEqual(issue.status_id, 31);
    assert.deepStrictEqual(issue.custom_fields, [{ id: 77, value: 'apontamento editado' }]);
    assert.match(issue.notes, /^nota editada\n\n\[op handback:op-hb-cfg\]$/);
});

test('handback: 422 do Redmine → NÃO arquiva, blocked com o campo exigido', async () => {
    const { dir } = seedRun(42401);
    issues.get(42401).mode = '422';
    const out = await qaHandback.handback(dir, { by: 'r', operationId: 'op-hb-422', env });
    assert.strictEqual(out.ok, false);
    assert.strictEqual(out.http_status, 422);
    assert.match(out.error, /422.*Apontamentos Desenvolvedor não pode ficar vazio/);
    assert.ok(fs.existsSync(dir), 'não arquivou');
    const s = JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'));
    assert.strictEqual(s.status, 'blocked');
    assert.match(s.blocked_reason, /Devolução ao QA falhou/);
    assert.strictEqual(dom06.listAttempts(dir).find(a => a.node === 'handback_qa').result, 'FAILED');
});

test('handback: sem chave / chave errada → não arquiva (401 revoga o Attempt)', async () => {
    const { dir } = seedRun(42402);
    const noKey = await qaHandback.handback(dir, { by: 'r', operationId: 'op-hb-nokey', env: { ...env, REDMINE_API_KEY: '' } });
    assert.match(noKey.error, /REDMINE_URL\/REDMINE_API_KEY|REDMINE_API_KEY/);
    const wrong = await qaHandback.handback(dir, { by: 'r', operationId: 'op-hb-wrong', env: { ...env, REDMINE_API_KEY: 'errada' } });
    assert.strictEqual(wrong.ok, false);
    assert.ok(fs.existsSync(dir));
    assert.ok(dom06.listAttempts(dir).some(a => a.node === 'handback_qa' && a.authority === 'revoked'));
});

test('handback: 5xx depois de gravar (incerto) → não arquiva; nova tentativa com o mesmo operation_id acha o marcador e não reposta', async () => {
    const { dir } = seedRun(42403);
    issues.get(42403).mode = '500';
    const first = await qaHandback.handback(dir, { by: 'r', operationId: 'op-hb-unc', env });
    assert.strictEqual(first.ok, false);
    assert.ok(fs.existsSync(dir));
    issues.get(42403).mode = 'ok';
    const putsBefore = seen.filter(r => r.method === 'PUT' && r.url === '/issues/42403.json').length;
    const again = await qaHandback.handback(dir, { by: 'r', operationId: 'op-hb-unc', env });
    assert.strictEqual(again.ok, true, again.error);
    assert.strictEqual(seen.filter(r => r.method === 'PUT' && r.url === '/issues/42403.json').length, putsBefore, 'não repostou');
    assert.strictEqual(issues.get(42403).journals.length, 1);
});
