// node --test notify.test.js
// scripts/notify.js contra um servidor HTTP local: entrega, HTTP de erro, timeout,
// sem URL (silêncio total) e URL inválida — nenhum caso pode rejeitar.
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const { sendNotification, slackPayload, genericPayload, webhookUrlFromEnv } = require('./notify');

function server(handler) {
    const received = [];
    const srv = http.createServer((req, res) => {
        let body = '';
        req.on('data', c => { body += c; });
        req.on('end', () => { received.push({ method: req.method, headers: req.headers, body }); handler(req, res); });
    });
    return new Promise(r => srv.listen(0, '127.0.0.1', () => r({ srv, received, url: `http://127.0.0.1:${srv.address().port}/hook/T0KEN` })));
}
function captureWarn(fn) {
    const orig = console.warn; const lines = [];
    console.warn = (...a) => lines.push(a.join(' '));
    return fn().finally(() => { console.warn = orig; }).then(r => ({ r, lines }));
}

test('POST JSON com o payload e resolve com o status HTTP', async () => {
    const { srv, received, url } = await server((req, res) => { res.statusCode = 200; res.end('ok'); });
    try {
        const payload = slackPayload({ title: 'T', message: 'M', color: 'good', url: 'https://x/pr/1' });
        const r = await sendNotification(payload, { webhookUrl: url });
        assert.deepStrictEqual(r, { sent: true, status: 200 });
        assert.strictEqual(received[0].method, 'POST');
        assert.strictEqual(received[0].headers['content-type'], 'application/json');
        assert.deepStrictEqual(JSON.parse(received[0].body), payload);
    } finally { srv.close(); }
});

test('HTTP 500 vira warn e resolve (sem a URL no log)', async () => {
    const { srv, url } = await server((req, res) => { res.statusCode = 500; res.end(); });
    try {
        const { r, lines } = await captureWarn(() => sendNotification({ a: 1 }, { webhookUrl: url }));
        assert.deepStrictEqual(r, { sent: false, status: 500 });
        assert.match(lines.join('\n'), /HTTP 500/);
        assert.ok(!lines.join('\n').includes('T0KEN'), 'URL/token apareceu no log');
    } finally { srv.close(); }
});

test('timeout total resolve em até timeoutMs mesmo com servidor pendurado', async () => {
    const { srv, url } = await server(() => { /* nunca responde */ });
    try {
        const t0 = Date.now();
        const { r, lines } = await captureWarn(() => sendNotification({ a: 1 }, { webhookUrl: url, timeoutMs: 200 }));
        assert.strictEqual(r.sent, false);
        assert.strictEqual(r.error, 'timeout');
        assert.ok(Date.now() - t0 < 2000);
        assert.strictEqual(lines.length, 1, `warn duplicado: ${lines}`);
    } finally { srv.closeAllConnections?.(); srv.close(); }
});

test('erro de rede (porta fechada) resolve com warn', async () => {
    const { srv, url } = await server(() => {});
    srv.close();
    await new Promise(r => srv.once('close', r));
    const { r, lines } = await captureWarn(() => sendNotification({ a: 1 }, { webhookUrl: url }));
    assert.strictEqual(r.sent, false);
    assert.ok(r.error);
    assert.strictEqual(lines.length, 1);
});

test('sem NOTIFY_WEBHOOK_URL: não faz nada e não loga nada', async () => {
    const prev = process.env.NOTIFY_WEBHOOK_URL;
    delete process.env.NOTIFY_WEBHOOK_URL;
    try {
        const { r, lines } = await captureWarn(() => sendNotification({ a: 1 }));
        assert.deepStrictEqual(r, { sent: false, skipped: true });
        assert.deepStrictEqual(lines, []);
    } finally { if (prev !== undefined) process.env.NOTIFY_WEBHOOK_URL = prev; }
});

test('valor vazio ou só comentário conta como não configurado', () => {
    assert.strictEqual(webhookUrlFromEnv({ NOTIFY_WEBHOOK_URL: '' }), null);
    assert.strictEqual(webhookUrlFromEnv({ NOTIFY_WEBHOOK_URL: '   ' }), null);
    assert.strictEqual(webhookUrlFromEnv({ NOTIFY_WEBHOOK_URL: '# URL do Slack webhook' }), null);
    assert.strictEqual(webhookUrlFromEnv({ NOTIFY_WEBHOOK_URL: 'https://h/x' }), 'https://h/x');
});

test('URL inválida não rejeita', async () => {
    const { r, lines } = await captureWarn(() => sendNotification({ a: 1 }, { webhookUrl: 'ftp://x/y' }));
    assert.deepStrictEqual(r, { sent: false, error: 'url_invalida' });
    assert.strictEqual(lines.length, 1);
});

test('slackPayload no formato Incoming Webhook; genericPayload plano', () => {
    const s = slackPayload({ title: 'T', message: 'M' });
    assert.strictEqual(s.attachments[0].color, 'good');
    assert.strictEqual(s.attachments[0].footer, 'Graph Engineering');
    assert.ok(!('title_link' in s.attachments[0]));
    assert.strictEqual(slackPayload({ title: 'T', message: 'M', url: 'https://p' }).attachments[0].title_link, 'https://p');
    const g = genericPayload({ title: 'T', message: 'M', status: 'ok' });
    assert.deepStrictEqual(Object.keys(g), ['title', 'message', 'url', 'status', 'ts']);
});
