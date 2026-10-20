// node --test scripts/lib/redmine-journal-fetcher.test.js
// Busca da nota de recusa (ordem reversa, ignora [Watcher], nunca lança), troca de
// status com releitura e o bloco do context.md — fetch stubado, sem rede.
const test = require('node:test');
const assert = require('node:assert');
const qa = require('./redmine-journal-fetcher');

const KEY = 'chave-super-secreta-xyz';
const json = (status, data) => ({ ok: status >= 200 && status < 300, status, json: async () => data });
function stub(handler) {
    const calls = [];
    const fn = async (url, init = {}) => { calls.push({ url, init }); return handler(url, init, calls.length); };
    return { fn, calls };
}
const base = (fetch, logs = []) => ({ redmineUrl: 'http://redmine.test/', apiKey: KEY, fetch, log: m => logs.push(m) });

test('isQaRejectedStatus aceita "Recusa QA" e "Recusada QA"', () => {
    assert.ok(qa.isQaRejectedStatus('Recusa QA'));
    assert.ok(qa.isQaRejectedStatus(' recusada qa '));
    assert.ok(!qa.isQaRejectedStatus('Em Desenvolvimento'));
    assert.ok(!qa.isQaRejectedStatus(null));
});

test('fetchLastRejectionNote: nota mais recente não vazia, fora [Watcher], com journal e data da recusa', async () => {
    const { fn, calls } = stub(() => json(200, { issue: { journals: [
        { id: 1, created_on: 'T1', notes: 'antiga', details: [] },
        { id: 2, created_on: 'T2', notes: '', details: [{ name: 'status_id', new_value: '13' }] },
        { id: 3, created_on: 'T3', notes: '  corrigir filtro  ', user: { name: 'QA' }, details: [] },
        { id: 4, created_on: 'T4', notes: '   ', details: [] },
        { id: 5, created_on: 'T5', notes: '[Watcher] pendência', details: [] },
    ] } }));
    const out = await qa.fetchLastRejectionNote(43499, base(fn));
    assert.deepStrictEqual(out, { note: 'corrigir filtro', journal_id: 3, created_on: 'T3', author: 'QA', rejected_at: 'T2' });
    assert.strictEqual(calls[0].url, 'http://redmine.test/issues/43499.json?include=journals');
    assert.strictEqual(calls[0].init.headers['X-Redmine-API-Key'], KEY);
});

test('fetchLastRejectionNote: sem notas, HTTP de erro ou exceção => null, sem vazar a chave', async () => {
    const logs = [];
    assert.strictEqual(await qa.fetchLastRejectionNote(1, base(stub(() => json(200, { issue: { journals: [] } })).fn, logs)), null);
    assert.strictEqual(await qa.fetchLastRejectionNote(1, base(stub(() => json(500, {})).fn, logs)), null);
    assert.strictEqual(await qa.fetchLastRejectionNote(1, base(stub(() => { throw new Error(`boom ${KEY}`); }).fn, logs)), null);
    assert.strictEqual(await qa.fetchLastRejectionNote(1, { ...base(stub(() => json(200, {})).fn), apiKey: '' }), null);
    assert.strictEqual(await qa.fetchLastRejectionNote('1; rm', base(stub(() => json(200, {})).fn)), null);
    assert.ok(logs.length >= 2);
    assert.ok(logs.every(l => !l.includes(KEY)), logs.join('\n'));
});

test('setIssueStatus: PUT status_id e confirma na releitura', async () => {
    let status = 13;
    const { fn, calls } = stub((url, init) => {
        if (init.method === 'PUT') { status = JSON.parse(init.body).issue.status_id; return json(204, null); }
        return json(200, { issue: { status: { id: status, name: status === 2 ? 'Em Desenvolvimento' : 'Recusa QA' } } });
    });
    const out = await qa.setIssueStatus(10, qa.EM_DESENVOLVIMENTO_STATUS_ID, base(fn));
    assert.deepStrictEqual(out, { ok: true, status: { id: 2, name: 'Em Desenvolvimento' } });
    assert.strictEqual(calls[0].init.method, 'PUT');
    assert.deepStrictEqual(JSON.parse(calls[0].init.body), { issue: { status_id: 2 } });
});

test('setIssueStatus: 204 sem aplicar (workflow) e exceções viram { ok: false } sem a chave', async () => {
    const ignored = stub((url, init) => init.method === 'PUT' ? json(204, null) : json(200, { issue: { status: { id: 13, name: 'Recusa QA' } } }));
    const out = await qa.setIssueStatus(10, 2, base(ignored.fn));
    assert.strictEqual(out.ok, false);
    assert.match(out.error, /Recusa QA/);
    const thrown = await qa.setIssueStatus(10, 2, base(stub(() => { throw new Error(`falhou ${KEY}`); }).fn));
    assert.strictEqual(thrown.ok, false);
    assert.ok(!thrown.error.includes(KEY));
    assert.deepStrictEqual(await qa.setIssueStatus(10, 2, base(stub(() => json(403, {})).fn)), { ok: false, error: 'Redmine HTTP 403' });
});

test('contextBlock: bloco citado no formato pedido, com fallback sem nota', () => {
    const b = qa.contextBlock('linha 1\n\nlinha 3', '2026-09-25T10:00:00.000Z');
    assert.strictEqual(b,
        '\n\n## Recusa QA — Correção Solicitada (2026-09-25T10:00:00.000Z)\n\n' +
        'O time de QA recusou a entrega com a seguinte nota:\n\n' +
        '> linha 1\n>\n> linha 3\n\n---\n' +
        '**Instrução para este retry**: corrija os pontos levantados\n' +
        'acima aproveitando todo o contexto do ciclo anterior.\n');
    assert.match(qa.contextBlock(null, 'X'), /> \(sem nota registrada\)/);
});

test('fetchLastRejectionNote: 2ª recusa sem comentário não herda a nota da 1ª', async () => {
    const { fn } = stub(() => json(200, { issue: { journals: [
        { id: 1, created_on: 'T1', notes: 'nota da 1ª recusa', details: [{ name: 'status_id', new_value: '13' }] },
        { id: 2, created_on: 'T2', notes: '', details: [{ name: 'status_id', new_value: '2' }] },
        { id: 3, created_on: 'T3', notes: '', details: [{ name: 'status_id', new_value: '9' }] },
        { id: 4, created_on: 'T4', notes: '', details: [{ name: 'status_id', new_value: '13' }] },
    ] } }));
    assert.strictEqual(await qa.fetchLastRejectionNote(1, base(fn)), null);
});

test('fetchLastRejectionNote: QA devolve pra Em Desenvolvimento com nota e o ticket vai pra Recusa QA em saltos sem nota (#43819)', async () => {
    const { fn } = stub(() => json(200, { issue: { journals: [
        { id: 1, created_on: 'T1', notes: null, details: [{ name: 'status_id', old_value: '20', new_value: '8' }] },
        { id: 2, created_on: 'T2', notes: '1° Não deixa criar a DT', user: { name: 'QA' }, details: [{ name: 'status_id', old_value: '8', new_value: '2' }] },
        { id: 3, created_on: 'T3', notes: '', details: [{ name: 'status_id', old_value: '2', new_value: '8' }] },
        { id: 4, created_on: 'T4', notes: '', details: [{ name: 'status_id', old_value: '8', new_value: '19' }] },
        { id: 5, created_on: 'T5', notes: '', details: [{ name: 'status_id', old_value: '19', new_value: '13' }] },
    ] } }));
    assert.deepStrictEqual(await qa.fetchLastRejectionNote(1, base(fn)), { note: '1° Não deixa criar a DT', journal_id: 2, created_on: 'T2', author: 'QA', rejected_at: 'T2' });
});

test('fetchLastRejectionNote: nota de quem mandou pro teste (saída de Em Desenvolvimento) não vira nota da recusa', async () => {
    const { fn } = stub(() => json(200, { issue: { journals: [
        { id: 1, created_on: 'T1', notes: 'pronto pra teste', details: [{ name: 'status_id', old_value: '2', new_value: '8' }] },
        { id: 2, created_on: 'T2', notes: '', details: [{ name: 'status_id', old_value: '8', new_value: '13' }] },
    ] } }));
    assert.strictEqual(await qa.fetchLastRejectionNote(1, base(fn)), null);
});

test('fetchLastRejectionNote: devolução com nota de uma recusa anterior não é herdada', async () => {
    const { fn } = stub(() => json(200, { issue: { journals: [
        { id: 1, created_on: 'T1', notes: 'nota da 1ª devolução', details: [{ name: 'status_id', old_value: '8', new_value: '2' }] },
        { id: 2, created_on: 'T2', notes: '', details: [{ name: 'status_id', old_value: '2', new_value: '13' }] },
        { id: 3, created_on: 'T3', notes: '', details: [{ name: 'status_id', old_value: '13', new_value: '2' }] },
        { id: 4, created_on: 'T4', notes: '', details: [{ name: 'status_id', old_value: '2', new_value: '8' }] },
        { id: 5, created_on: 'T5', notes: '', details: [{ name: 'status_id', old_value: '8', new_value: '13' }] },
    ] } }));
    assert.strictEqual(await qa.fetchLastRejectionNote(1, base(fn)), null);
});

test('fetchLastRejectionNote: nota no próprio journal da recusa vence comentário posterior', async () => {
    const { fn } = stub(() => json(200, { issue: { journals: [
        { id: 1, created_on: 'T1', notes: '', details: [{ name: 'status_id', new_value: '9' }] },
        { id: 2, created_on: 'T2', notes: 'motivo da recusa', user: { name: 'QA' }, details: [{ name: 'status_id', new_value: '13' }] },
        { id: 3, created_on: 'T3', notes: 'outro comentário', details: [] },
    ] } }));
    assert.deepStrictEqual(await qa.fetchLastRejectionNote(1, base(fn)), { note: 'motivo da recusa', journal_id: 2, created_on: 'T2', author: 'QA', rejected_at: 'T2' });
});
