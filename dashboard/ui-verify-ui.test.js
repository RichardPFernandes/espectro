// node --test ui-verify-ui.test.js
// Tela "Verificações de UI" (public/ui-verify.js, PRI-361): modelo puro e HTML. Nada inventado:
// veredito ausente é "sem veredito", nunca "passou"; texto vindo do disco sempre escapado.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const U = require('./public/ui-verify');

const task = (over = {}) => ({
    taskId: 'pri-361', verdict: 'FALHOU', problems: [{ code: 'ELEMENT_MISSING', where: 'AC-2 http://127.0.0.1:3399/', detail: 'elemento esperado ausente: Runs' }],
    screens: [{ ac: 'AC-2', url: 'http://127.0.0.1:3399/', image: 'AC-2-runs.png', expected: { total: 2, found: 1 }, consoleErrors: 1, requests: 3 }],
    images: ['AC-2-runs.png'], updatedAt: '2026-11-15T12:00:00.000Z', ...over,
});

test('model: sem dado é loading; erro é error; lista vazia é empty', () => {
    assert.equal(U.model(null).state, 'loading');
    assert.equal(U.model({ enabled: true, tasks: [] }).state, 'empty');
    assert.equal(U.model({ error: 'x' }).state, 'error');
});

test('AC-4: veredito desconhecido ou fora da lista nunca vira passou', () => {
    const m = U.model({ enabled: true, tasks: [task({ taskId: 'a', verdict: 'UNKNOWN', problems: [] }), task({ taskId: 'b', verdict: 'OK', problems: [] }), task({ taskId: 'c', verdict: undefined })] });
    for (const r of m.rows) { assert.equal(r.tone, 'warn', r.taskId); assert.equal(r.label, 'Sem veredito', r.taskId); }
});

test('model: cada veredito tem rótulo e tom próprios', () => {
    const tone = v => U.model({ enabled: true, tasks: [task({ verdict: v, problems: [] })] }).rows[0];
    assert.deepEqual([tone('PASSOU').label, tone('PASSOU').tone], ['Passou', 'ok']);
    assert.deepEqual([tone('FALHOU').label, tone('FALHOU').tone], ['Falhou', 'bad']);
    assert.deepEqual([tone('N/A').label, tone('N/A').tone], ['Não se aplica', 'muted']);
    assert.deepEqual([tone('SKIPPED').label, tone('SKIPPED').tone], ['Pulada', 'muted']);
});

test('model: seleciona a primeira task por padrão e respeita sel; sel inexistente cai na primeira', () => {
    const data = { enabled: true, tasks: [task({ taskId: 'a' }), task({ taskId: 'b' })] };
    assert.equal(U.model(data).sel, 'a');
    assert.equal(U.model(data, { sel: 'b' }).sel, 'b');
    assert.equal(U.model(data, { sel: 'zzz' }).sel, 'a');
    assert.equal(U.model(data, { sel: 'b' }).detail.taskId, 'b');
});

test('imageUrl: codifica task e arquivo e só aceita PNG com nome seguro', () => {
    assert.equal(U.imageUrl('pri-361', 'AC-2-runs.png'), '/api/ui-verify/pri-361/AC-2-runs.png');
    for (const bad of [['..', 'a.png'], ['a/b', 'c.png'], ['a', '../c.png'], ['a', 'c.jpg'], ['a', 'c.png"onerror=x']]) {
        assert.equal(U.imageUrl(...bad), null, JSON.stringify(bad));
    }
});

test('AC-3: o detalhe mostra as screenshots por AC, com a imagem da própria task', () => {
    const html = U.renderHtml(U.model({ enabled: true, tasks: [task()] }));
    assert.match(html, /src="\/api\/ui-verify\/pri-361\/AC-2-runs\.png"/);
    assert.match(html, /AC-2/);
    assert.match(html, /1 de 2/); // elementos esperados encontrados
});

test('AC-2: o detalhe lista os problemas com código e onde', () => {
    const html = U.renderHtml(U.model({ enabled: true, tasks: [task()] }));
    assert.match(html, /ELEMENT_MISSING/);
    assert.match(html, /elemento esperado ausente: Runs/);
});

test('texto do disco é escapado: nada vira HTML ou atributo', () => {
    const evil = '<img src=x onerror=alert(1)>"\'';
    const t = task({
        taskId: 'ok', problems: [{ code: evil, where: evil, detail: evil }], reason: evil,
        screens: [{ ac: evil, url: evil, image: null, expected: { total: 0, found: 0 }, consoleErrors: 0, requests: 0 }], images: [],
    });
    const html = U.renderHtml(U.model({ enabled: true, tasks: [t] }));
    assert.ok(!html.includes('<img src=x'));
    assert.ok(!/onerror=alert\(1\)>/.test(html.replace(/&lt;img src=x onerror=alert\(1\)&gt;/g, '')));
    assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
});

test('task com nome inseguro não gera URL de imagem', () => {
    const t = task({ taskId: '../x', screens: [{ ac: 'AC-1', url: '', image: 'a.png', expected: { total: 1, found: 1 }, consoleErrors: 0, requests: 1 }], images: ['a.png'] });
    const html = U.renderHtml(U.model({ enabled: true, tasks: [t] }));
    assert.ok(!html.includes('<img'));
});

test('estados loading, empty e error têm texto próprio e sem lista', () => {
    assert.match(U.renderHtml(U.model(null)), /Carregando/);
    assert.match(U.renderHtml(U.model({ enabled: true, tasks: [] })), /Nenhuma verificação/);
    assert.match(U.renderHtml(U.model({ error: 'falhou' })), /falhou/);
});

test('AC-1: a tela é registrada no menu só quando a API responde ok (flag desligada não aparece)', async () => {
    const calls = [];
    const mk = status => ({
        window: undefined, document: undefined,
        fetch: async () => ({ ok: status === 200, status, json: async () => ({ enabled: true, tasks: [] }) }),
        Views: { addView: (...a) => calls.push(a), refresh() {}, current: () => 'runs' },
    });
    const off = mk(404); await U.probe(off); assert.equal(calls.length, 0);
    // flag desligada de verdade: o servidor responde 200 {enabled:false}
    const offOk = { fetch: async () => ({ ok: true, status: 200, json: async () => ({ enabled: false, tasks: [] }) }), Views: { addView: () => calls.push('x'), refresh() {} } };
    await U.probe(offOk); assert.equal(calls.length, 0);
    const down = { fetch: async () => { throw new Error('rede'); }, Views: { addView: () => calls.push('x'), refresh() {} } };
    await U.probe(down); assert.equal(calls.length, 0);
    const on = mk(200); await U.probe(on);
    assert.equal(calls.length, 1);
    assert.equal(calls[0][0], 'verificacoes-ui');
});

test('index.html carrega o script e o css da aba', () => {
    const html = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');
    assert.match(html, /<script src="ui-verify\.js"><\/script>/);
    assert.match(html, /href="screens\/ui-verify\.css"/);
});
