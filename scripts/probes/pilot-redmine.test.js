// PRI-391: o Redmine local do piloto responde ao que os clientes reais da plataforma pedem.
// Os testes usam os clientes de verdade (redmine-ticket-list, redmine-journal-fetcher,
// spec-generator.createRestMcpClient) em vez de remontar o protocolo à mão.

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const pilot = require('./pilot-redmine');
const ticketList = require('../lib/redmine-ticket-list');
const journalFetcher = require('../lib/redmine-journal-fetcher');
const { createRestMcpClient } = require('../lib/spec-generator');

const KEY = 'chave-do-piloto';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pilot-redmine-'));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

let n = 0;
async function boot(tickets = [{ id: 9001, subject: 'Primeiro', description: 'Corpo', custom_fields: [{ id: 50, name: 'Branch Liberação', value: 'main' }] }]) {
    const dir = path.join(tmp, `c${++n}`);
    fs.mkdirSync(dir);
    const store = path.join(dir, 'store.json');
    const log = path.join(dir, 'requests.jsonl');
    const from = path.join(dir, 'novos.json');
    fs.writeFileSync(from, JSON.stringify(tickets));
    pilot.seed(store, from);
    const server = pilot.createServer({ store, key: KEY, log });
    const addr = await pilot.listen(server, 0);
    const url = `http://${addr.address}:${addr.port}`;
    const close = () => new Promise(r => server.close(r));
    const requests = () => fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse) : [];
    return { url, store, close, requests, dir };
}

const quiet = () => {};

test('listen escuta só em loopback, com trava do store enquanto está de pé', async () => {
    const s = await boot();
    try {
        assert.match(s.url, /^http:\/\/127\.0\.0\.1:\d+$/);
        assert.ok(fs.existsSync(`${s.store}.lock`));
    } finally { await s.close(); }
    assert.ok(!fs.existsSync(`${s.store}.lock`), 'trava removida ao fechar');
});

test('sem a chave do piloto responde 401 e não devolve ticket', async () => {
    const s = await boot();
    try {
        const res = await fetch(`${s.url}/issues.json?assigned_to_id=me&status_id=open`);
        assert.strictEqual(res.status, 401);
        const errado = await fetch(`${s.url}/issues/9001.json`, { headers: { 'X-Redmine-API-Key': 'outra' } });
        assert.strictEqual(errado.status, 401);
    } finally { await s.close(); }
});

test('lista do watcher: status Aprovada|Recusa QA e atribuídos a mim', async () => {
    const s = await boot([{ id: 1, subject: 'a' }, { id: 2, subject: 'b' }]);
    try {
        const h = { headers: { 'X-Redmine-API-Key': KEY } };
        const put = await fetch(`${s.url}/issues/2.json`, { method: 'PUT', headers: { ...h.headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ issue: { status_id: 2 } }) });
        assert.strictEqual(put.status, 204);
        // Mesma URL que readmine-watcher.js:325 monta.
        const data = await (await fetch(`${s.url}/issues.json?assigned_to_id=me&status_id=11|13&sort=created_on:desc`, h)).json();
        assert.deepStrictEqual(data.issues.map(i => i.id), [1]);
        assert.strictEqual(data.issues[0].journals, undefined, 'a lista não traz journals');
        const todos = await (await fetch(`${s.url}/issues.json?status_id=*`, h)).json();
        assert.strictEqual(todos.total_count, 2);
        const outro = await (await fetch(`${s.url}/issues.json?assigned_to_id=99&status_id=*`, h)).json();
        assert.strictEqual(outro.total_count, 0);
    } finally { await s.close(); }
});

test('cliente real redmine-ticket-list lê os tickets abertos', async () => {
    const s = await boot([{ id: 10, subject: 'dez' }, { id: 11, subject: 'onze' }]);
    try {
        const tickets = await ticketList.fetchAssignedTickets({ redmineUrl: s.url, apiKey: KEY, log: quiet });
        assert.deepStrictEqual(tickets.map(t => t.id).sort(), [10, 11]);
    } finally { await s.close(); }
});

test('cliente real do MCP (createRestMcpClient) lê ticket com journals e custom field', async () => {
    const s = await boot();
    try {
        const client = createRestMcpClient({ baseUrl: s.url, apiKey: KEY, fetchImpl: fetch });
        const { issue } = await client.getIssue({ issueId: 9001, queryParams: { include: ['attachments', 'journals'] } });
        assert.strictEqual(issue.subject, 'Primeiro');
        assert.strictEqual(issue.status.name, 'Aprovada');
        assert.deepStrictEqual(issue.journals, []);
        assert.deepStrictEqual(issue.attachments, []);
        assert.strictEqual(issue.custom_fields.find(f => f.name === 'Branch Liberação').value, 'main');
        const semInclude = await (await fetch(`${s.url}/issues/9001.json`, { headers: { 'X-Redmine-API-Key': KEY } })).json();
        assert.strictEqual(semInclude.issue.journals, undefined);
        const formaArray = await (await fetch(`${s.url}/issues/9001.json?include[]=journals`, { headers: { 'X-Redmine-API-Key': KEY } })).json();
        assert.deepStrictEqual(formaArray.issue.journals, []);
    } finally { await s.close(); }
});

test('cliente real setIssueStatus troca o status, relê e grava journal com detail', async () => {
    const s = await boot();
    try {
        const r = await journalFetcher.setIssueStatus(9001, 20, { redmineUrl: s.url, apiKey: KEY, fetch, log: quiet });
        assert.deepStrictEqual(r.ok, true);
        assert.strictEqual(r.status.name, 'Ag Merge');
        const issue = pilot.loadStore(s.store).issues[0];
        assert.strictEqual(issue.journals.length, 1);
        assert.deepStrictEqual(issue.journals[0].details[0], { property: 'attr', name: 'status_id', old_value: '11', new_value: '20' });
    } finally { await s.close(); }
});

test('PUT com notes vira journal persistido; status desconhecido é 422', async () => {
    const s = await boot();
    try {
        const put = body => fetch(`${s.url}/issues/9001.json`, {
            method: 'PUT', headers: { 'X-Redmine-API-Key': KEY, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
        });
        assert.strictEqual((await put({ issue: { notes: '[Watcher] olá' } })).status, 204);
        assert.strictEqual((await put({ issue: { status_id: 999 } })).status, 422);
        assert.strictEqual((await put({ issue: { assigned_to_id: 42 } })).status, 422);
        const bad = await fetch(`${s.url}/issues/9001.json`, { method: 'PUT', headers: { 'X-Redmine-API-Key': KEY }, body: '{' });
        assert.strictEqual(bad.status, 400);
        const issue = pilot.loadStore(s.store).issues[0];
        assert.deepStrictEqual(issue.journals.map(j => j.notes), ['[Watcher] olá']);
        assert.strictEqual(issue.status.id, 11, 'PUT recusado não muda o ticket');
    } finally { await s.close(); }
});

test('rota desconhecida responde 404 e fica no log como UNHANDLED; a chave nunca vai para o log', async () => {
    const s = await boot();
    try {
        const res = await fetch(`${s.url}/time_entries.json`, { headers: { 'X-Redmine-API-Key': KEY } });
        assert.strictEqual(res.status, 404);
        assert.strictEqual((await fetch(`${s.url}/issues/4242.json`, { headers: { 'X-Redmine-API-Key': KEY } })).status, 404);
        const log = s.requests();
        const unhandled = log.filter(e => e.handled === false);
        assert.deepStrictEqual(unhandled.map(e => e.path), ['/time_entries.json']);
        assert.ok(!JSON.stringify(log).includes(KEY));
    } finally { await s.close(); }
});

test('seed recusa id repetido, ticket sem subject e não toca o store em caso de erro', async () => {
    const s = await boot();
    await s.close();
    const from = path.join(s.dir, 'dup.json');
    fs.writeFileSync(from, JSON.stringify([{ id: 9001, subject: 'de novo' }]));
    assert.throws(() => pilot.seed(s.store, from), /já existe/);
    fs.writeFileSync(from, JSON.stringify([{ id: 9002 }]));
    assert.throws(() => pilot.seed(s.store, from), /sem subject/);
    assert.deepStrictEqual(pilot.loadStore(s.store).issues.map(i => i.id), [9001]);
});

const putJson = (s, id, body) => fetch(`${s.url}/issues/${id}.json`, {
    method: 'PUT', headers: { 'X-Redmine-API-Key': KEY, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});

test('PUT fora do subconjunto (campo extra, sem wrapper issue) é 422 e fica no log como não tratado', async () => {
    const s = await boot();
    try {
        assert.strictEqual((await putJson(s, 9001, { issue: { subject: 'novo' } })).status, 422);
        assert.strictEqual((await putJson(s, 9001, { notes: 'sem wrapper' })).status, 422);
        assert.strictEqual((await putJson(s, 9001, { issue: { done_ratio: 'abc' } })).status, 422);
        const unhandled = s.requests().filter(e => e.handled === false);
        assert.strictEqual(unhandled.length, 2, 'campo extra e corpo sem wrapper são não tratados; done_ratio inválido é erro do cliente');
        const issue = pilot.loadStore(s.store).issues[0];
        assert.strictEqual(issue.subject, 'Primeiro');
        assert.deepStrictEqual(issue.journals, []);
    } finally { await s.close(); }
});

test('filtro desconhecido na lista é 422 (não devolve a lista inteira como se filtrasse)', async () => {
    const s = await boot();
    try {
        const res = await fetch(`${s.url}/issues.json?issue_id=999&status_id=*`, { headers: { 'X-Redmine-API-Key': KEY } });
        assert.strictEqual(res.status, 422);
        assert.strictEqual(s.requests().at(-1).handled, false);
    } finally { await s.close(); }
});

test('chave mandada na query sai do log como <redacted>', async () => {
    const s = await boot();
    try {
        await fetch(`${s.url}/issues/9001.json?key=${KEY}`, { headers: { 'X-Redmine-API-Key': KEY } });
        assert.ok(!JSON.stringify(s.requests()).includes(KEY));
    } finally { await s.close(); }
});

test('custom field por id numérico ou texto atualiza o mesmo campo, com old_value no journal', async () => {
    const s = await boot();
    try {
        assert.strictEqual((await putJson(s, 9001, { issue: { custom_fields: [{ id: '50', value: 'develop' }] } })).status, 204);
        const issue = pilot.loadStore(s.store).issues[0];
        assert.deepStrictEqual(issue.custom_fields, [{ id: 50, name: 'Branch Liberação', value: 'develop' }]);
        assert.deepStrictEqual(issue.journals[0].details[0], { property: 'cf', name: '50', old_value: 'main', new_value: 'develop' });
    } finally { await s.close(); }
});

test('cliente real fetchLastRejectionNote acha a nota da Recusa QA (status 8 → 13)', async () => {
    const s = await boot();
    try {
        assert.strictEqual((await putJson(s, 9001, { issue: { status_id: 8 } })).status, 204);
        assert.strictEqual((await putJson(s, 9001, { issue: { status_id: 13, notes: 'Botão salvar não grava' } })).status, 204);
        const r = await journalFetcher.fetchLastRejectionNote(9001, { redmineUrl: s.url, apiKey: KEY, fetch, log: quiet });
        assert.strictEqual(r.note, 'Botão salvar não grava');
        const list = await ticketList.fetchAssignedTickets({ redmineUrl: s.url, apiKey: KEY, log: quiet });
        assert.deepStrictEqual(list.map(t => t.id), [9001]);
    } finally { await s.close(); }
});

test('PUT com corpo lento não trava os outros pedidos; corpo acima de 1 MB recebe 413', async () => {
    const http = require('http');
    const s = await boot();
    try {
        const { port } = new URL(s.url);
        const slow = http.request({ host: pilot.HOST, port, method: 'PUT', path: '/issues/9001.json',
            headers: { 'X-Redmine-API-Key': KEY, 'Content-Type': 'application/json', 'Content-Length': 100 } });
        slow.on('error', () => {});
        slow.write('{"issue":');
        const t0 = Date.now();
        const res = await fetch(`${s.url}/issues/9001.json`, { headers: { 'X-Redmine-API-Key': KEY }, signal: AbortSignal.timeout(3000) });
        assert.strictEqual(res.status, 200);
        assert.ok(Date.now() - t0 < 1000, 'GET respondeu sem esperar o PUT lento');
        slow.destroy();
        const big = await putJson(s, 9001, { issue: { notes: 'x'.repeat(1024 * 1024 + 10) } });
        assert.strictEqual(big.status, 413);
    } finally { await s.close(); }
});

test('seed recusa rodar com o servidor de pé e valida os tipos dos campos', async () => {
    const s = await boot();
    const from = path.join(s.dir, 'mais.json');
    fs.writeFileSync(from, JSON.stringify([{ id: 9100, subject: 'x' }]));
    try {
        assert.throws(() => pilot.seed(s.store, from), /servidor rodando/);
    } finally { await s.close(); }
    fs.writeFileSync(from, JSON.stringify([{ id: 9100, subject: 'x', created_on: 5 }]));
    assert.throws(() => pilot.seed(s.store, from), /created_on/);
    fs.writeFileSync(from, JSON.stringify([{ id: 9100, subject: 'x', custom_fields: [{ name: 'sem id' }] }]));
    assert.throws(() => pilot.seed(s.store, from), /custom_fields/);
    fs.writeFileSync(from, JSON.stringify([{ id: 9100, subject: 'x' }]));
    assert.strictEqual(pilot.seed(s.store, from), 1);
});

test('request-target inválido (//) é 400 sem derrubar o servidor nem soltar a trava', async () => {
    const s = await boot();
    const { port, hostname } = new URL(s.url);
    const raw = await new Promise((resolve, reject) => {
        const sock = require('net').connect(Number(port), hostname, () => sock.write(`GET // HTTP/1.1\r\nHost: x\r\nX-Redmine-API-Key: ${KEY}\r\nConnection: close\r\n\r\n`));
        let out = '';
        sock.on('data', d => { out += d; });
        sock.on('end', () => resolve(out));
        sock.on('error', reject);
    });
    assert.match(raw, /^HTTP\/1\.1 400/);
    assert.equal((await fetch(`${s.url}/users/current.json`, { headers: { 'X-Redmine-API-Key': KEY } })).status, 200, 'servidor segue de pé');
    assert.ok(fs.existsSync(`${s.store}.lock`));
    await s.close();
});

test('trava: dono vivo bloqueia o seed e um segundo servidor; trava órfã (pid morto) some sozinha', async () => {
    const s = await boot();
    const from = path.join(s.dir, 'mais.json');
    fs.writeFileSync(from, JSON.stringify([{ id: 9002, subject: 'Outro' }]));
    assert.throws(() => pilot.seed(s.store, from), /pid \d+/);
    await assert.rejects(() => pilot.listen(pilot.createServer({ store: s.store, key: KEY }), 0), /já há servidor/);
    await s.close();
    fs.writeFileSync(`${s.store}.lock`, '999999999');
    assert.equal(pilot.seed(s.store, from), 1, 'pid morto: trava órfã não bloqueia');
    assert.ok(!fs.existsSync(`${s.store}.lock`));
});
