const test = require('node:test');
const assert = require('node:assert');
const { withRetry, isTransientError } = require('./retry');

const noSleep = async () => {};
const quiet = () => {};

test('withRetry: sucesso na 2ª tentativa devolve o valor', async () => {
    let calls = 0;
    const out = await withRetry(async () => { if (++calls === 1) throw new Error('boom'); return 'ok'; },
        { sleep: noSleep, log: quiet });
    assert.strictEqual(out, 'ok');
    assert.strictEqual(calls, 2);
});

test('withRetry: esgota maxAttempts e relança o último erro', async () => {
    let calls = 0;
    await assert.rejects(withRetry(async () => { calls++; throw new Error(`e${calls}`); },
        { maxAttempts: 3, sleep: noSleep, log: quiet }), /e3/);
    assert.strictEqual(calls, 3);
});

test('withRetry: retryOn=false falha na hora', async () => {
    let calls = 0;
    await assert.rejects(withRetry(async () => { calls++; throw new Error('x'); },
        { retryOn: () => false, sleep: noSleep, log: quiet }));
    assert.strictEqual(calls, 1);
});

test('withRetry: backoff exponencial com jitter até +20% e teto maxDelayMs', async () => {
    const delays = [];
    await assert.rejects(withRetry(async () => { throw new Error('x'); }, {
        maxAttempts: 5, baseDelayMs: 100, maxDelayMs: 500, log: quiet, sleep: async ms => { delays.push(ms); },
    }));
    assert.strictEqual(delays.length, 4);
    [100, 200, 400].forEach((base, i) => assert.ok(delays[i] >= base && delays[i] <= base * 1.2, `${delays[i]} vs ${base}`));
    assert.strictEqual(delays[3], 500);
});

test('withRetry: minDelayFor (Retry-After) eleva a espera, respeitando o teto', async () => {
    const delays = [];
    await assert.rejects(withRetry(async () => { throw new Error('x'); }, {
        maxAttempts: 2, baseDelayMs: 10, maxDelayMs: 5000, minDelayFor: () => 3000, log: quiet,
        sleep: async ms => { delays.push(ms); },
    }));
    assert.deepStrictEqual(delays, [3000]);
});

test('isTransientError: 429/503/504 e rede transiente sim; 401/403/404/422 não', () => {
    for (const s of [429, 503, 504]) assert.ok(isTransientError({ statusCode: s }), String(s));
    for (const s of [400, 401, 403, 404, 422, 500]) assert.ok(!isTransientError({ statusCode: s }), String(s));
    for (const code of ['ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND']) {
        assert.ok(isTransientError({ code }), code);
        assert.ok(isTransientError(Object.assign(new TypeError('fetch failed'), { cause: { code } })), `cause ${code}`);
    }
    assert.ok(isTransientError(Object.assign(new Error('aborted'), { name: 'TimeoutError' })));
    assert.ok(isTransientError(new Error('request timeout')));
    assert.ok(!isTransientError(new Error('ECONNREFUSED')));
    assert.ok(!isTransientError(null));
});
