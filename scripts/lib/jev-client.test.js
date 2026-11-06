// node --require ./harness/loopback-only.cjs --test scripts/lib/jev-client.test.js
// PRI-205 S3b T3: cliente do Jev (SPEC §B4, §B7). O Jev real nunca é chamado:
// um fake HTTP em 127.0.0.1 com roteiro faz o papel da TypeSafe. A chave é falsa.
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const jev = require('./jev-client');

const KEY = 'chave-falsa-' + 'de-teste-0001';
const ENVELOPE = {
    step_text: 'Alterar backend/svc-a/src/a.js para cobrir AC-01',
    ac_texts: ['AC-01: o total aparece na tela'],
    declared_paths: ['backend/svc-a/src/a.js'],
};

// Fake da TypeSafe. handler(req, body, res) decide a resposta; received guarda o
// que chegou, para os testes conferirem o que saiu da máquina.
async function fakeJev(handler) {
    const received = [];
    const sockets = new Set();
    const server = http.createServer((req, res) => {
        let body = '';
        req.on('data', c => { body += c; });
        req.on('end', () => {
            received.push({ method: req.method, url: req.url, headers: req.headers, body });
            handler(req, body, res);
        });
    });
    server.on('connection', s => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    return {
        baseUrl,
        received,
        close: () => new Promise(r => { for (const s of sockets) s.destroy(); server.close(r); }),
    };
}

function answer(res, obj, status = 200) {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(typeof obj === 'string' ? obj : JSON.stringify(obj));
}

const OK_BODY = {
    model: 'jev-2026-10-01',
    answers: { class: { choice: 'C3', confidence: 0.82 }, risky: { noul: 0.1, confidence: 0.9 } },
};

function call(fake, extra = {}) {
    return jev.classify({ envelope: ENVELOPE, model: 'jev-latest', credential: KEY, baseUrl: fake.baseUrl, timeoutMs: 1000, ...extra });
}

test('envia só os três campos do envelope, a pergunta versionada e a chave no header (AC-04)', async t => {
    const fake = await fakeJev((req, body, res) => answer(res, OK_BODY));
    t.after(fake.close);
    await call(fake, { envelope: { ...ENVELOPE, extra: 'não pode sair' } });
    assert.strictEqual(fake.received.length, 1);
    const r = fake.received[0];
    assert.strictEqual(r.method, 'POST');
    assert.strictEqual(r.url, '/v1/systemone');
    assert.strictEqual(r.headers.authorization, `Bearer ${KEY}`);
    assert.match(r.headers['content-type'], /application\/json/);
    const body = JSON.parse(r.body);
    assert.deepStrictEqual(Object.keys(body).sort(), ['model', 'questions', 'state']);
    assert.deepStrictEqual(body.state, ENVELOPE);
    assert.deepStrictEqual(body.questions, jev.PROMPT);
    assert.strictEqual(body.model, 'jev-latest');
    assert.ok(!r.body.includes(KEY), 'a chave não vai no corpo');
});

test('resposta válida → OK com classe, confianças, risco e modelo reportado', async t => {
    const fake = await fakeJev((req, body, res) => answer(res, OK_BODY));
    t.after(fake.close);
    const r = await call(fake);
    assert.strictEqual(r.outcome, 'OK');
    assert.strictEqual(r.certain, true);
    assert.strictEqual(r.parse, 'OK');
    assert.strictEqual(r.class, 'C3');
    assert.strictEqual(r.confidence, 0.82);
    assert.strictEqual(r.risky, 0.1);
    assert.strictEqual(r.model_reported, 'jev-2026-10-01');
    assert.strictEqual(r.http_status, 200);
    assert.ok(Number.isFinite(r.latency_ms) && r.latency_ms >= 0);
});

test('classe fora do enum → OK com parse OUT_OF_ENUM e classe null', async t => {
    const fake = await fakeJev((req, body, res) => answer(res, { answers: { class: { choice: 'C9', confidence: 0.9 } } }));
    t.after(fake.close);
    const r = await call(fake);
    assert.deepStrictEqual([r.outcome, r.parse, r.class, r.certain], ['OK', 'OUT_OF_ENUM', null, true]);
});

test('JSON inválido → OUT_OF_ENUM, sem lançar', async t => {
    const fake = await fakeJev((req, body, res) => answer(res, '{nao-e-json'));
    t.after(fake.close);
    const r = await call(fake);
    assert.deepStrictEqual([r.outcome, r.parse, r.class], ['OK', 'OUT_OF_ENUM', null]);
});

test('confiança fora de [0,1] ou ausente vira null; o modelo ausente vira null', async t => {
    const fake = await fakeJev((req, body, res) => answer(res, { answers: { class: { choice: 'C2', confidence: 7 } } }));
    t.after(fake.close);
    const r = await call(fake);
    assert.deepStrictEqual([r.class, r.confidence, r.risky, r.model_reported], ['C2', null, null, null]);
});

test('HTTP 500 → FAILED certo, sem marca de autorização', async t => {
    const fake = await fakeJev((req, body, res) => answer(res, { error: 'x' }, 500));
    t.after(fake.close);
    const r = await call(fake);
    assert.deepStrictEqual([r.outcome, r.certain, r.http_status, r.auth_rejected], ['FAILED', true, 500, false]);
});

for (const status of [401, 403]) {
    test(`HTTP ${status} → FAILED certo com auth_rejected`, async t => {
        const fake = await fakeJev((req, body, res) => answer(res, { error: 'no' }, status));
        t.after(fake.close);
        const r = await call(fake);
        assert.deepStrictEqual([r.outcome, r.certain, r.http_status, r.auth_rejected], ['FAILED', true, status, true]);
    });
}

test('conexão recusada → NOT_SENT certo', async () => {
    const fake = await fakeJev(() => {});
    const baseUrl = fake.baseUrl;
    await fake.close();
    const r = await jev.classify({ envelope: ENVELOPE, model: 'jev-latest', credential: KEY, baseUrl, timeoutMs: 1000 });
    assert.deepStrictEqual([r.outcome, r.certain, r.detail], ['NOT_SENT', true, 'ECONNREFUSED']);
});

test('timeout depois do envio → UNCERTAIN (o pedido chegou ao servidor)', async t => {
    const fake = await fakeJev(() => { /* nunca responde */ });
    t.after(fake.close);
    const r = await call(fake, { timeoutMs: 200 });
    assert.deepStrictEqual([r.outcome, r.certain, r.detail], ['UNCERTAIN', false, 'TIMEOUT']);
    assert.strictEqual(fake.received.length, 1);
});

test('conexão caída depois do envio → UNCERTAIN', async t => {
    const fake = await fakeJev(req => { req.socket.destroy(); });
    t.after(fake.close);
    const r = await call(fake);
    assert.deepStrictEqual([r.outcome, r.certain], ['UNCERTAIN', false]);
});

test('sem credencial → NOT_SENT, nada chega ao servidor', async t => {
    const fake = await fakeJev((req, body, res) => answer(res, OK_BODY));
    t.after(fake.close);
    for (const credential of [undefined, '', '   ']) {
        const r = await call(fake, { credential });
        assert.deepStrictEqual([r.outcome, r.certain, r.detail], ['NOT_SENT', true, 'CREDENTIAL_UNAVAILABLE']);
    }
    assert.strictEqual(fake.received.length, 0);
});

test('a chave nunca aparece no resultado, em nenhum desfecho (parte do AC-06)', async t => {
    const scripts = [
        (req, body, res) => answer(res, OK_BODY),
        (req, body, res) => answer(res, `eco ${req.headers.authorization}`, 500),
        req => { req.socket.destroy(); },
    ];
    for (const handler of scripts) {
        const fake = await fakeJev(handler);
        t.after(fake.close);
        const r = await call(fake);
        assert.ok(!JSON.stringify(r).includes(KEY));
    }
});

test('PROMPT: escolha entre C1–C5 com critério em texto, mais risco; hash e versões estáveis', () => {
    assert.deepStrictEqual(Object.keys(jev.PROMPT).sort(), ['class', 'risky']);
    assert.strictEqual(jev.PROMPT.class.type, 'choice');
    assert.deepStrictEqual(Object.keys(jev.PROMPT.class.criteria), ['C1', 'C2', 'C3', 'C4', 'C5']);
    assert.strictEqual(jev.PROMPT.risky.type, 'noul');
    assert.match(jev.promptSha256(), /^[0-9a-f]{64}$/);
    assert.strictEqual(jev.promptSha256(), jev.promptSha256());
    assert.match(jev.ENUM_VERSION, /^prisma-class-c1c5@\d+$/);
    assert.match(jev.CLIENT_VERSION, /^jev-client@\d+$/);
});

test('destino de produção é fixo; a base só muda por parâmetro (AD-5)', () => {
    assert.strictEqual(jev.DESTINATION, 'https://api.typesafe.ai/v1/systemone');
    assert.strictEqual(jev.DESTINATION_ID, 'typesafe:/v1/systemone');
    assert.strictEqual(jev.requestTarget(), jev.DESTINATION);
    assert.strictEqual(jev.requestTarget('http://127.0.0.1:9'), 'http://127.0.0.1:9/v1/systemone');
});

test('Keychain: chama /usr/bin/security sem shell e devolve o valor sem a quebra de linha', async () => {
    const calls = [];
    const execFileImpl = (file, args, opts, cb) => { calls.push({ file, args, opts }); cb(null, `${KEY}\n`, ''); };
    const r = await jev.readKeychainCredential({ keychain: 'prisma-jev-typesafe', account: 'typesafe' }, { execFileImpl });
    assert.deepStrictEqual(r, { ok: true, value: KEY });
    assert.strictEqual(calls[0].file, '/usr/bin/security');
    assert.deepStrictEqual(calls[0].args, ['find-generic-password', '-s', 'prisma-jev-typesafe', '-a', 'typesafe', '-w']);
    assert.ok(!calls[0].opts.shell);
    assert.ok(calls[0].opts.timeout > 0);
});

test('Keychain: falha, valor vazio ou referência inválida → CREDENTIAL_UNAVAILABLE, sem detalhe do processo', async () => {
    const failing = (file, args, opts, cb) => cb(Object.assign(new Error(`saída com ${KEY}`), { code: 44 }), '', 'item não encontrado');
    const empty = (file, args, opts, cb) => cb(null, '\n', '');
    for (const [ref, execFileImpl] of [
        [{ keychain: 'prisma-jev-typesafe', account: 'typesafe' }, failing],
        [{ keychain: 'prisma-jev-typesafe', account: 'typesafe' }, empty],
        [{ keychain: '', account: 'typesafe' }, empty],
        [null, empty],
    ]) {
        const r = await jev.readKeychainCredential(ref, { execFileImpl });
        assert.deepStrictEqual(r, { ok: false, reason: 'CREDENTIAL_UNAVAILABLE' });
    }
});

// Só com o preload loopback ativo: sem ele, este teste tentaria a rede de verdade.
const LOOPBACK_ON = [...process.execArgv, process.env.NODE_OPTIONS || ''].some(a => String(a).includes('loopback-only'));
test('sem base de teste, sob o controle loopback, o destino real é recusado e nada sai (NOT_SENT, sem lançar)', { skip: !LOOPBACK_ON }, async () => {
    const r = await jev.classify({ envelope: ENVELOPE, model: 'jev-latest', credential: KEY, timeoutMs: 1000 });
    assert.deepStrictEqual([r.outcome, r.certain], ['NOT_SENT', true]);
    assert.ok(!JSON.stringify(r).includes(KEY));
});
