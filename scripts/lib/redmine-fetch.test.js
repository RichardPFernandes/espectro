const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { createRedmineFetch } = require('./redmine-fetch');

// Redmine fake: responde com a sequência de status dada (o último se repete) e
// registra método + instante de cada requisição.
async function fakeRedmine(statuses, headers = {}) {
    const hits = [];
    const server = http.createServer((req, res) => {
        const status = statuses[Math.min(hits.length, statuses.length - 1)];
        hits.push({ method: req.method, url: req.url, at: Date.now() });
        req.resume();
        req.on('end', () => {
            res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
            res.end(JSON.stringify({ issue: { id: 1 }, status }));
        });
    });
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${server.address().port}`;
    return { url, hits, close: () => new Promise(r => server.close(r)) };
}

function setup(envOverrides = {}) {
    const logs = [];
    const f = createRedmineFetch({
        env: { REDMINE_RETRY_BASE_DELAY_MS: '10', REDMINE_MIN_INTERVAL_MS: '0', ...envOverrides },
        log: m => logs.push(m),
    });
    return { f, logs };
}

test('503 na 1ª tentativa e 200 na 2ª: sucesso, sem falhar o chamador', async t => {
    const rm = await fakeRedmine([503, 200]);
    t.after(rm.close);
    const { f, logs } = setup();
    const res = await f(`${rm.url}/issues/1.json`, { headers: { 'X-Redmine-API-Key': 'k' } });
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual((await res.json()).issue, { id: 1 });
    assert.strictEqual(rm.hits.length, 2);
    assert.ok(logs.some(l => /\[retry\] Tentativa 1\/3 falhou: GET \/issues\/1\.json: HTTP 503/.test(l)), logs.join('\n'));
});

test('401: sem retry, devolve a resposta na hora e loga', async t => {
    const rm = await fakeRedmine([401, 200]);
    t.after(rm.close);
    const { f, logs } = setup();
    const res = await f(`${rm.url}/issues/1.json`);
    assert.strictEqual(res.status, 401);
    assert.strictEqual(rm.hits.length, 1);
    assert.ok(logs.some(l => /HTTP 401 — erro de autenticação, sem retry/.test(l)), logs.join('\n'));
    assert.ok(!logs.some(l => l.startsWith('[retry]')));
});

test('403/404/422: sem retry', async t => {
    for (const status of [403, 404, 422]) {
        const rm = await fakeRedmine([status, 200]);
        const { f } = setup();
        const res = await f(`${rm.url}/x`, { method: 'PUT', body: '{}' });
        assert.strictEqual(res.status, status);
        assert.strictEqual(rm.hits.length, 1, `status ${status}`);
        await rm.close();
    }
});

test('503 persistente: esgota as tentativas e devolve a última Response (não lança)', async t => {
    const rm = await fakeRedmine([503]);
    t.after(rm.close);
    const { f } = setup({ REDMINE_RETRY_MAX_ATTEMPTS: '4' });
    const res = await f(`${rm.url}/issues/1.json`);
    assert.strictEqual(res.status, 503);
    assert.strictEqual(res.ok, false);
    assert.strictEqual(rm.hits.length, 4);
});

test('PUT (comentário): repete em 503, mas NÃO em 504 (pode já ter gravado a nota)', async t => {
    const a = await fakeRedmine([503, 204]);
    const b = await fakeRedmine([504, 204]);
    t.after(async () => { await a.close(); await b.close(); });
    const { f } = setup();
    const init = { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ issue: { notes: 'x' } }) };
    assert.strictEqual((await f(`${a.url}/issues/1.json`, init)).status, 204);
    assert.strictEqual(a.hits.length, 2);
    assert.strictEqual((await f(`${b.url}/issues/1.json`, init)).status, 504);
    assert.strictEqual(b.hits.length, 1);
});

test('GET: repete em 504', async t => {
    const rm = await fakeRedmine([504, 200]);
    t.after(rm.close);
    const { f } = setup();
    assert.strictEqual((await f(`${rm.url}/issues.json`)).status, 200);
    assert.strictEqual(rm.hits.length, 2);
});

test('erro de rede não transiente (ECONNREFUSED): lança na hora, sem retry', async () => {
    const { f, logs } = setup();
    await assert.rejects(f('http://127.0.0.1:9/issues/1.json'), /fetch failed/);
    assert.ok(!logs.some(l => l.startsWith('[retry]')));
});

test('erro de rede transiente (ECONNRESET) em GET: repete', async () => {
    let calls = 0;
    const f = createRedmineFetch({
        env: { REDMINE_RETRY_BASE_DELAY_MS: '0', REDMINE_MIN_INTERVAL_MS: '0' }, log: () => {},
        fetch: async () => {
            if (++calls === 1) throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } });
            return new Response('{}', { status: 200 });
        },
    });
    assert.strictEqual((await f('http://redmine.test/issues/1.json')).status, 200);
    assert.strictEqual(calls, 2);
});

test('signal do chamador já estourado: não repete', async () => {
    let calls = 0;
    const f = createRedmineFetch({
        env: { REDMINE_RETRY_BASE_DELAY_MS: '0', REDMINE_MIN_INTERVAL_MS: '0' }, log: () => {},
        fetch: async () => { calls++; throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' }); },
    });
    const signal = AbortSignal.abort();
    await assert.rejects(f('http://redmine.test/x', { signal }), /timeout/);
    assert.strictEqual(calls, 1);
});

test('429 com Retry-After: espera pelo menos o indicado', async t => {
    const rm = await fakeRedmine([429, 200], { 'Retry-After': '1' });
    t.after(rm.close);
    const { f } = setup();
    const res = await f(`${rm.url}/issues/1.json`);
    assert.strictEqual(res.status, 200);
    assert.ok(rm.hits[1].at - rm.hits[0].at >= 950, `${rm.hits[1].at - rm.hits[0].at}ms`);
});

test('throttle: chamadas consecutivas (e concorrentes) saem com >= REDMINE_MIN_INTERVAL_MS entre si, com log', async t => {
    const rm = await fakeRedmine([200]);
    t.after(rm.close);
    const { f, logs } = setup({ REDMINE_MIN_INTERVAL_MS: '500' });
    // "task A" e "task B" em sequência + duas concorrentes.
    await f(`${rm.url}/issues/1.json`);
    await f(`${rm.url}/issues/2.json`);
    await Promise.all([f(`${rm.url}/issues/3.json`), f(`${rm.url}/issues/4.json`)]);
    assert.strictEqual(rm.hits.length, 4);
    for (let i = 1; i < rm.hits.length; i++) {
        const gap = rm.hits[i].at - rm.hits[i - 1].at;
        assert.ok(gap >= 490, `gap ${i}: ${gap}ms`); // tolerância de resolução do timer
    }
    assert.ok(logs.filter(l => l.startsWith('[redmine-throttle] aguardando')).length >= 3, logs.join('\n'));
});

test('env inválida cai no padrão', () => {
    const { settings } = require('./redmine-fetch');
    assert.deepStrictEqual(settings({ REDMINE_RETRY_MAX_ATTEMPTS: 'abc', REDMINE_RETRY_BASE_DELAY_MS: '-1', REDMINE_MIN_INTERVAL_MS: '' }),
        { maxAttempts: 3, baseDelayMs: 1000, minIntervalMs: 500 });
});
