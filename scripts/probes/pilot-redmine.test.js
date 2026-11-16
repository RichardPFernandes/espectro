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
async function boot(tickets = [{ id: 9001, subject: 'Primeiro', description: 'Corpo', custom_fields: [{ id: 7, name: 'Branch Liberação', value: 'main' }] }]) {
    const dir = path.join(tmp, `c${++n}`);
    fs.mkdirSync(dir);
    const store = path.join(dir, 'store.json');
    const log = path.join(dir, 'requests.jsonl');
    const from = path.join(dir, 'novos.json');
    fs.writeFileSync(from, JSON.stringify(tickets));
    pilot.seed(store, from);
    const server = pilot.createServer({ store, key: KEY, log });
    await new Promise(r => server.listen(0, pilot.HOST, r));
    const url = `http://${pilot.HOST}:${server.address().port}`;
    const close = () => new Promise(r => server.close(r));
    const requests = () => fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse) : [];
    return { url, store, close, requests };
}

const quiet = () => {};

test('escuta só em loopback', async () => {
    const s = await boot();
    try { assert.match(s.url, /^http:\/\/127\.0\.0\.1:\d+$/); } finally { await s.close(); }
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
        await fetch(`${s.url}/issues/2.json`, { method: 'PUT', headers: { ...h.headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ issue: { status_id: 2 } }) });
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
    try {
        const from = path.join(tmp, `dup${n}.json`);
        fs.writeFileSync(from, JSON.stringify([{ id: 9001, subject: 'de novo' }]));
        assert.throws(() => pilot.seed(s.store, from), /já existe/);
        fs.writeFileSync(from, JSON.stringify([{ id: 9002 }]));
        assert.throws(() => pilot.seed(s.store, from), /sem subject/);
        assert.deepStrictEqual(pilot.loadStore(s.store).issues.map(i => i.id), [9001]);
    } finally { await s.close(); }
});
