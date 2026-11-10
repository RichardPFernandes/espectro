// node --test scripts/lib/redmine-ticket-list.test.js
// fetchAssignedTickets: mapeamento do payload, cache-free (o cache é responsabilidade
// do dashboard/server.js, não deste módulo), e nunca lança nem loga a key.
const test = require('node:test');
const assert = require('node:assert');
const tickets = require('./redmine-ticket-list');

const KEY = 'chave-super-secreta-xyz';
const json = (status, data) => ({ ok: status >= 200 && status < 300, status, json: async () => data });
function stub(handler) {
    const calls = [];
    const fn = async (url, init = {}) => { calls.push({ url, init }); return handler(url, init, calls.length); };
    return { fn, calls };
}
const base = (fetch, logs = []) => ({ redmineUrl: 'http://redmine.test/', apiKey: KEY, fetch, log: m => logs.push(m) });

test('fetchAssignedTickets: monta a URL com assigned_to_id=me&status_id=open e mapeia os campos', async () => {
    const { fn, calls } = stub(() => json(200, { issues: [
        { id: 43666, subject: 'Painel de tickets', status: { id: 1, name: 'Novo' }, priority: { id: 2, name: 'Alta' }, updated_on: '2026-09-26T10:00:00Z', description: 'ignorado' },
        { id: 43590, subject: 'Outro', status: { name: 'Recusa QA' }, priority: { name: 'Normal' }, updated_on: '2026-09-25T10:00:00Z' },
    ] }));
    const out = await tickets.fetchAssignedTickets(base(fn));
    assert.deepStrictEqual(out, [
        { id: 43666, subject: 'Painel de tickets', status: 'Novo', priority: 'Alta', updated_on: '2026-09-26T10:00:00Z', tracker: null, assignee: null, estimated_hours: null, done_ratio: null },
        { id: 43590, subject: 'Outro', status: 'Recusa QA', priority: 'Normal', updated_on: '2026-09-25T10:00:00Z', tracker: null, assignee: null, estimated_hours: null, done_ratio: null },
    ]);
    assert.strictEqual(calls[0].url, 'http://redmine.test/issues.json?assigned_to_id=me&status_id=open&sort=updated_on:desc');
    assert.strictEqual(calls[0].init.headers['X-Redmine-API-Key'], KEY);
});

test('fetchAssignedTickets: tipo, responsável, horas estimadas e % feito; ausente vira null, nunca 0', async () => {
    const { fn } = stub(() => json(200, { issues: [
        { id: 1, subject: 'A', status: { name: 'Aprovada' }, priority: { name: 'Alta' }, updated_on: null,
            tracker: { name: 'Bug' }, assigned_to: { name: 'Fulano' }, estimated_hours: 5.5, done_ratio: 0 },
        { id: 2, subject: 'B', status: { name: 'Nova' }, priority: { name: 'Baixa' }, estimated_hours: '', done_ratio: 'x' },
    ] }));
    const [a, b] = await tickets.fetchAssignedTickets(base(fn));
    assert.deepStrictEqual([a.tracker, a.assignee, a.estimated_hours, a.done_ratio], ['Bug', 'Fulano', 5.5, 0]);
    assert.deepStrictEqual([b.tracker, b.assignee, b.estimated_hours, b.done_ratio], [null, null, null, null]);
});

test('fetchAssignedTickets: sem issues no payload => []', async () => {
    const out = await tickets.fetchAssignedTickets(base(stub(() => json(200, {})).fn));
    assert.deepStrictEqual(out, []);
});

test('fetchAssignedTickets: sem Redmine configurado => [] sem chamar fetch', async () => {
    let called = false;
    const fn = async () => { called = true; return json(200, { issues: [] }); };
    assert.deepStrictEqual(await tickets.fetchAssignedTickets({ redmineUrl: '', apiKey: '', fetch: fn }), []);
    assert.deepStrictEqual(await tickets.fetchAssignedTickets({ redmineUrl: 'http://redmine.test', apiKey: '', fetch: fn }), []);
    assert.strictEqual(called, false);
});

test('fetchAssignedTickets: HTTP de erro ou exceção de rede => [], sem vazar a chave', async () => {
    const logs = [];
    assert.deepStrictEqual(await tickets.fetchAssignedTickets(base(stub(() => json(500, {})).fn, logs)), []);
    assert.deepStrictEqual(await tickets.fetchAssignedTickets(base(stub(() => { throw new Error(`boom ${KEY}`); }).fn, logs)), []);
    assert.ok(logs.length >= 2);
    assert.ok(logs.every(l => !l.includes(KEY)), logs.join('\n'));
});

// ---------------------------------------------------------------------------
// Aba "Redmine": getTicketDetail / updateTicketStatus / addJournalNote.
const noContent = () => ({ ok: true, status: 204, json: async () => { throw new Error('sem corpo'); } });
function redmineStub(issue) {
    return stub(url => {
        if (url.includes('/issue_statuses.json')) return json(200, { issue_statuses: [{ id: 2, name: 'Em Desenvolvimento' }, { id: 7, name: 'Recusada QA' }, { id: 5, name: 'Fechada', is_closed: true }] });
        if (url.includes('/enumerations/issue_priorities.json')) return json(200, { issue_priorities: [{ id: 3, name: 'Normal' }, { id: 4, name: 'Urgente' }] });
        if (url.includes('/issues/')) return issue ? json(200, { issue }) : json(404, {});
        return json(500, {});
    });
}

test('getTicketDetail: inclui journals e traduz status_id/priority_id em nome', async () => {
    const { fn, calls } = redmineStub({
        id: 43700, subject: 'Tela X', description: 'desc', status: { id: 7, name: 'Recusada QA' }, priority: { id: 4, name: 'Urgente' },
        assigned_to: { name: 'Fulano' }, created_on: '2026-09-20T10:00:00Z', updated_on: '2026-09-28T10:00:00Z',
        allowed_statuses: [{ id: 2, name: 'Em Desenvolvimento' }],
        journals: [{ id: 1, user: { name: 'QA' }, notes: 'quebrou', created_on: '2026-09-28T10:00:00Z',
            details: [{ property: 'attr', name: 'status_id', old_value: '2', new_value: '7' }, { property: 'attr', name: 'priority_id', old_value: '3', new_value: '4' }] }],
    });
    const out = await tickets.getTicketDetail(43700, { ...base(fn), noCache: true });
    assert.match(calls[0].url, /\/issues\/43700\.json\?include=journals,changesets,watchers/);
    assert.strictEqual(out.assignee, 'Fulano');
    assert.strictEqual(out.status_id, 7);
    assert.deepStrictEqual(out.allowed_statuses, [{ id: 2, name: 'Em Desenvolvimento' }]);
    assert.strictEqual(out.journals[0].user, 'QA');
    assert.strictEqual(out.journals[0].details[0].old_label, 'Em Desenvolvimento');
    assert.strictEqual(out.journals[0].details[0].new_label, 'Recusada QA');
    assert.strictEqual(out.journals[0].details[1].new_label, 'Urgente');
    assert.deepStrictEqual([out.version, out.estimated_hours, out.spent_hours, out.done_ratio], [null, null, null, null]);
});

test('getTicketDetail: versão, horas estimadas/gastas e % feito vêm da mesma resposta', async () => {
    const { fn } = redmineStub({
        id: 43701, subject: 'Y', status: { id: 2, name: 'Em Desenvolvimento' }, priority: { id: 2, name: 'Normal' },
        fixed_version: { id: 9, name: 'Sprint 42' }, estimated_hours: 5, spent_hours: 6.5, done_ratio: 40, journals: [],
    });
    const out = await tickets.getTicketDetail(43701, { ...base(fn), noCache: true });
    assert.deepStrictEqual([out.version, out.estimated_hours, out.spent_hours, out.done_ratio], ['Sprint 42', 5, 6.5, 40]);
});

test('getTicketDetail: 404 do Redmine lança com status 404; id inválido => 400 sem chamar fetch', async () => {
    const { fn, calls } = redmineStub(null);
    await assert.rejects(tickets.getTicketDetail(1, { ...base(fn), noCache: true }), e => e.status === 404);
    const before = calls.length;
    await assert.rejects(tickets.getTicketDetail('1/../2', base(fn)), e => e.status === 400);
    assert.strictEqual(calls.length, before);
});

test('getTicketDetail: sem Redmine configurado => 503 sem chamar fetch', async () => {
    let called = false;
    await assert.rejects(tickets.getTicketDetail(1, { redmineUrl: '', apiKey: '', fetch: async () => { called = true; } }), e => e.status === 503);
    assert.strictEqual(called, false);
});

test('updateTicketStatus: PUT com status_id e notes; sem nota não manda notes', async () => {
    const { fn, calls } = stub(() => noContent());
    assert.deepStrictEqual(await tickets.updateTicketStatus(43700, 2, '  voltando pra dev  ', base(fn)), { ok: true });
    assert.strictEqual(calls[0].url, 'http://redmine.test/issues/43700.json');
    assert.strictEqual(calls[0].init.method, 'PUT');
    assert.strictEqual(calls[0].init.headers['X-Redmine-API-Key'], KEY);
    assert.deepStrictEqual(JSON.parse(calls[0].init.body), { issue: { status_id: 2, notes: 'voltando pra dev' } });
    await tickets.updateTicketStatus(43700, '3', '', base(fn));
    assert.deepStrictEqual(JSON.parse(calls[1].init.body), { issue: { status_id: 3 } });
    await assert.rejects(tickets.updateTicketStatus(43700, 'x', '', base(fn)), e => e.status === 400);
});

test('updateTicketStatus: 422 do Redmine traz os erros do workflow, sem vazar a key', async () => {
    const fn = async () => json(422, { errors: [`Status is invalid ${KEY}`] });
    await assert.rejects(tickets.updateTicketStatus(1, 2, '', base(fn)), e => e.status === 422 && /Status is invalid/.test(e.message) && !e.message.includes(KEY));
});

test('addJournalNote: PUT só com notes; nota vazia => 400 sem chamar fetch', async () => {
    const { fn, calls } = stub(() => noContent());
    await tickets.addJournalNote(43700, 'olá', base(fn));
    assert.deepStrictEqual(JSON.parse(calls[0].init.body), { issue: { notes: 'olá' } });
    await assert.rejects(tickets.addJournalNote(43700, '   ', base(fn)), e => e.status === 400);
    assert.strictEqual(calls.length, 1);
});

test('erro de rede nas escritas => 502 sem a key na mensagem', async () => {
    const fn = async () => { throw new Error(`ECONNREFUSED ${KEY}`); };
    await assert.rejects(tickets.addJournalNote(1, 'x', base(fn)), e => e.status === 502 && !e.message.includes(KEY));
});
