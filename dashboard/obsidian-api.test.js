// node --test obsidian-api.test.js
// Botão "Abrir no Obsidian" (dashboard/obsidian.js, PRI-373): flag desligada não monta rota, GET/POST
// com exportador falso e uma execução com o exportador real.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const express = require('express');
const { createObsidian, MARKER } = require('./obsidian');

const tmpBase = process.env.CLAUDE_JOB_DIR ? path.join(process.env.CLAUDE_JOB_DIR, 'tmp') : os.tmpdir();
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(tmpBase, 'obsidian-api-')));
const prismaRoot = path.resolve(__dirname, '..');
const quiet = { warn() {} };
let n = 0;

async function boot(env, exportFn) {
    const prefsFile = path.join(tmp, `prefs-${n += 1}`, 'dashboard-prefs.json');
    const app = express();
    app.use(express.json());
    createObsidian({ env, prefsFile, prismaRoot, exportFn, log: quiet }).mount(app);
    const server = await new Promise(r => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
    const call = (method, url, body) => new Promise((resolve, reject) => {
        const req = http.request({ port: server.address().port, host: '127.0.0.1', method, path: url, headers: { 'content-type': 'application/json' } }, res => {
            let raw = ''; res.on('data', c => { raw += c; });
            res.on('end', () => { let body = {}; try { body = JSON.parse(raw); } catch { /* 404 do Express vem em HTML */ } resolve({ status: res.statusCode, body }); });
        });
        req.on('error', reject); req.end(body === undefined ? undefined : JSON.stringify(body));
    });
    return { call, prefsFile, close: () => { server.closeAllConnections(); server.close(); } };
}
const fakeVault = async (out) => { fs.mkdirSync(out, { recursive: true }); fs.writeFileSync(path.join(out, MARKER), '{}'); };

test('AC-7: flag desligada, ausente ou inválida não monta nenhuma rota', async () => {
    for (const env of [{}, { PRISMA_OBSIDIAN: 'off' }, { PRISMA_OBSIDIAN: 'talvez' }]) {
        const s = await boot(env, fakeVault);
        assert.equal((await s.call('GET', '/api/obsidian')).status, 404);
        assert.equal((await s.call('POST', '/api/obsidian/export', {})).status, 404);
        assert.ok(!fs.existsSync(s.prefsFile));
        s.close();
    }
});

test('AC-8: sem vault o GET diz que não está pronto; o POST cria, guarda a pasta e devolve a URI', async () => {
    const s = await boot({ PRISMA_OBSIDIAN: 'on' }, fakeVault);
    const antes = await s.call('GET', '/api/obsidian');
    assert.equal(antes.status, 200);
    assert.deepEqual([antes.body.ready, antes.body.uri], [false, null]);
    assert.ok(antes.body.vault.endsWith(path.join('Vaults', 'espectro')));
    assert.ok(!fs.existsSync(antes.body.vault), 'GET não cria nada');
    const vault = path.join(tmp, 'meu vault');
    const feito = await s.call('POST', '/api/obsidian/export', { vault });
    assert.equal(feito.status, 200);
    assert.equal(feito.body.ready, true);
    assert.equal(feito.body.uri, `obsidian://open?path=${encodeURIComponent(vault)}`);
    assert.equal((await s.call('GET', '/api/obsidian')).body.vault, vault);
    assert.equal(JSON.parse(fs.readFileSync(s.prefsFile, 'utf8')).obsidian_vault, vault);
    s.close();
});

test('AC-9: caminho relativo, falha do exportador e exportação simultânea não gravam a pasta', async () => {
    let solta;
    const s = await boot({ PRISMA_OBSIDIAN: 'on' }, (out) => (out.includes('quebra') ? Promise.reject(new Error('pasta não vazia')) : new Promise(r => { solta = () => r(fakeVault(out)); })));
    assert.equal((await s.call('POST', '/api/obsidian/export', { vault: 'relativo' })).status, 400);
    const ruim = await s.call('POST', '/api/obsidian/export', { vault: path.join(tmp, 'quebra') });
    assert.deepEqual([ruim.status, ruim.body.error], [422, 'pasta não vazia']);
    assert.ok(!fs.existsSync(s.prefsFile));
    const lenta = s.call('POST', '/api/obsidian/export', { vault: path.join(tmp, 'lenta') });
    await new Promise(r => setTimeout(r, 50));
    assert.equal((await s.call('POST', '/api/obsidian/export', { vault: path.join(tmp, 'outra') })).status, 409);
    solta();
    assert.equal((await lenta).status, 200);
    s.close();
});

test('exportador real: gera o vault do repositório e o GET passa a dizer pronto', { skip: !fs.existsSync(path.join(prismaRoot, '.git')) }, async () => {
    const s = await boot({ PRISMA_OBSIDIAN: 'on' });
    const vault = path.join(tmp, 'real');
    const feito = await s.call('POST', '/api/obsidian/export', { vault });
    assert.equal(feito.status, 200, JSON.stringify(feito.body));
    assert.ok(fs.existsSync(path.join(vault, '00 Início.md')));
    s.close();
});

test('AC-9 com o exportador real: pasta alheia não vazia é recusada e nada é salvo', { skip: !fs.existsSync(path.join(prismaRoot, '.git')) }, async () => {
    const s = await boot({ PRISMA_OBSIDIAN: 'on' });
    const alheia = path.join(tmp, 'alheia');
    fs.mkdirSync(alheia);
    fs.writeFileSync(path.join(alheia, 'nota.md'), 'minha');
    const r = await s.call('POST', '/api/obsidian/export', { vault: alheia });
    assert.equal(r.status, 422);
    assert.match(r.body.error, /não está vazia/);
    assert.deepEqual(fs.readdirSync(alheia), ['nota.md']);
    assert.ok(!fs.existsSync(s.prefsFile));
    s.close();
});

test('prefs ilegível não derruba o GET e o POST preserva as outras chaves', async () => {
    const s = await boot({ PRISMA_OBSIDIAN: 'on' }, fakeVault);
    fs.mkdirSync(path.dirname(s.prefsFile), { recursive: true });
    fs.writeFileSync(s.prefsFile, JSON.stringify({ obsidian_vault: 123, auto_start: true }));
    assert.equal((await s.call('GET', '/api/obsidian')).status, 200);
    fs.writeFileSync(s.prefsFile, 'null');
    assert.equal((await s.call('GET', '/api/obsidian')).status, 200);
    fs.writeFileSync(s.prefsFile, JSON.stringify({ auto_start: true }));
    await s.call('POST', '/api/obsidian/export', { vault: path.join(tmp, 'prefs') });
    assert.deepEqual(JSON.parse(fs.readFileSync(s.prefsFile, 'utf8')), { auto_start: true, obsidian_vault: path.join(tmp, 'prefs') });
    s.close();
});

test('dashboard real: com a flag ligada monta as rotas e o POST recusa origem externa e modo somente leitura', async () => {
    const { createDashboard } = require('./server');
    const memoryDir = path.join(tmp, 'consumer', 'memory', 'runs');
    fs.mkdirSync(memoryDir, { recursive: true });
    const prefsFile = path.join(tmp, 'consumer', 'prefs.json');
    const dash = createDashboard({ memoryDir, prefsFile, env: { PRISMA_OBSIDIAN: 'on' }, obsidianExport: fakeVault });
    await new Promise(r => dash.server.listen(0, '127.0.0.1', r));
    await dash.ready;
    const url = `http://localhost:${dash.server.address().port}/api/obsidian`;
    const post = (headers = {}) => fetch(`${url}/export`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ vault: path.join(tmp, 'dash vault') }) });
    try {
        assert.equal((await fetch(url)).status, 200);
        assert.equal((await post({ Origin: 'http://evil.example' })).status, 403);
        assert.ok(!fs.existsSync(path.join(tmp, 'dash vault')));
        process.env.PRISMA_DASHBOARD_READONLY = '1';
        assert.equal((await post()).status, 403);
        delete process.env.PRISMA_DASHBOARD_READONLY;
        assert.equal((await post()).status, 200);
        assert.equal(JSON.parse(fs.readFileSync(prefsFile, 'utf8')).obsidian_vault, path.join(tmp, 'dash vault'));
    } finally {
        delete process.env.PRISMA_DASHBOARD_READONLY;
        await dash.close();
    }
});
