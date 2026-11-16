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

// PRI-390 (AC-2): no somente leitura da verificação de UI, GET /api/obsidian responde 200 neutro,
// com a flag ligada ou não. A tela não pode depender de 404 e a verificação não lê vault nem prefs.
const NEUTRO = { enabled: false, vault: null, ready: false, uri: null };
async function bootDash(flag) {
    const { createDashboard } = require('./server');
    const root = path.join(tmp, `ro-${n += 1}`);
    const memoryDir = path.join(root, 'memory', 'runs');
    fs.mkdirSync(memoryDir, { recursive: true });
    const prefsFile = path.join(root, 'prefs.json');
    const dash = createDashboard({ memoryDir, prefsFile, env: { PRISMA_OBSIDIAN: flag }, obsidianExport: fakeVault });
    await new Promise(r => dash.server.listen(0, '127.0.0.1', r));
    await dash.ready;
    return { dash, prefsFile, url: `http://localhost:${dash.server.address().port}/api/obsidian` };
}

test('PRI-390 AC-2: somente leitura responde 200 neutro com PRISMA_OBSIDIAN on e off', async () => {
    for (const flag of ['on', 'off']) {
        const { dash, prefsFile, url } = await bootDash(flag);
        process.env.PRISMA_DASHBOARD_READONLY = '1';
        try {
            const r = await fetch(url);
            assert.equal(r.status, 200, `flag ${flag}`);
            assert.deepEqual(await r.json(), NEUTRO);
            assert.ok(!fs.existsSync(prefsFile), 'não lê nem cria prefs');
        } finally {
            delete process.env.PRISMA_DASHBOARD_READONLY;
            await dash.close();
        }
    }
});

test('PRI-390 AC-2: fora do somente leitura a resposta é a de hoje (404 desligada, estado ligada)', async () => {
    const off = await bootDash('off');
    try { assert.equal((await fetch(off.url)).status, 404); } finally { await off.dash.close(); }
    const on = await bootDash('on');
    try {
        const r = await fetch(on.url);
        assert.equal(r.status, 200);
        const body = await r.json();
        assert.equal(body.enabled, undefined);
        assert.deepEqual([body.ready, body.uri], [false, null]);
        assert.ok(body.vault.endsWith(path.join('Vaults', 'espectro')));
    } finally { await on.dash.close(); }
});

// Cliente (public/obsidian.js) no harness de DOM em vm, sem browser.
async function bootClient(response) {
    const vm = require('node:vm');
    const els = new Map();
    const el = id => ({ id, hidden: false, innerHTML: '', children: [], className: '', appendChild(c) { this.children.push(c); }, addEventListener() {} });
    const $ = id => { if (!els.has(id)) els.set(id, el(id)); return els.get(id); };
    const context = {
        $, esc: s => String(s), toast() {}, api: async () => ({}), location: {},
        document: { createElement: () => el('row') },
        fetch: async () => response,
    };
    vm.createContext(context);
    vm.runInContext(fs.readFileSync(path.join(__dirname, 'public', 'obsidian.js'), 'utf8'), context, { filename: 'obsidian.js' });
    await new Promise(r => setTimeout(r, 0));
    return $('navFoot').children[0];
}

test('PRI-390: o botão fica escondido com enabled:false e aparece com o estado normal', async () => {
    const neutro = await bootClient({ ok: true, json: async () => NEUTRO });
    assert.equal(neutro.hidden, true);
    assert.equal(neutro.innerHTML, '');
    const normal = await bootClient({ ok: true, json: async () => ({ vault: '/v/espectro', ready: true, uri: 'obsidian://open?path=%2Fv' }) });
    assert.equal(normal.hidden, false);
    assert.match(normal.innerHTML, /Abrir no Obsidian/);
    const desligada = await bootClient({ ok: false, json: async () => ({}) });
    assert.equal(desligada.hidden, true);
});
