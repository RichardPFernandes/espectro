// node --test ui-verify-api.test.js
// GET /api/ui-verify e /api/ui-verify/:task/:file (PRI-361): aba "Verificações de UI", somente leitura,
// atrás de PRISMA_UI_VERIFY_TAB (padrão desligada).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpBase = process.env.CLAUDE_JOB_DIR ? path.join(process.env.CLAUDE_JOB_DIR, 'tmp') : os.tmpdir();
const tmp = fs.mkdtempSync(path.join(tmpBase, 'ui-verify-api-'));
const repo = path.join(tmp, 'app-back');
const mainRuns = path.join(repo, 'memory', 'runs');
fs.mkdirSync(mainRuns, { recursive: true });
const uiDir = path.join(tmp, 'ui-verify');
fs.mkdirSync(path.join(uiDir, 'pri-361'), { recursive: true });
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('dados')]);
fs.writeFileSync(path.join(uiDir, 'pri-361', 'AC-1-runs.png'), PNG);
fs.writeFileSync(path.join(uiDir, 'pri-361', 'verdict.json'), JSON.stringify({
    verdict: 'FALHOU',
    problems: [{ code: 'CONSOLE_ERROR', where: 'AC-1', detail: 'falhou com token=segredo-que-nao-vaza' }],
}));
fs.mkdirSync(path.join(uiDir, 'sem-veredito'));
// alvo fora da pasta, para provar que symlink não é seguido
const fora = path.join(tmp, 'fora');
fs.mkdirSync(fora);
fs.writeFileSync(path.join(fora, 'segredo.png'), PNG);
fs.symlinkSync(path.join(fora, 'segredo.png'), path.join(uiDir, 'pri-361', 'link.png'));

process.env.BITBUCKET_API_TOKEN = 'segredo-que-nao-vaza';
const { createDashboard } = require('./server');

function start(env) {
    const dash = createDashboard({ memoryDir: mainRuns, uiVerifyDir: uiDir, env: { ...process.env, ...env } });
    return new Promise(r => dash.server.listen(0, '127.0.0.1', async () => {
        await dash.ready;
        r({ dash, base: `http://localhost:${dash.server.address().port}` });
    }));
}

let off, on, ro;
test.before(async () => {
    delete process.env.PRISMA_UI_VERIFY_TAB;
    off = await start({ PRISMA_UI_VERIFY_TAB: '' });
    on = await start({ PRISMA_UI_VERIFY_TAB: 'on' });
    ro = await start({ PRISMA_UI_VERIFY_TAB: 'on' });
});
test.after(() => { off.dash.close(); on.dash.close(); ro.dash.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

test('AC-1: flag desligada, a listagem diz enabled:false sem 4xx e a imagem não existe (404)', async () => {
    // A página pergunta a cada carga: um 4xx aqui reprovaria o /verify-ui do próprio dashboard (PRI-355).
    const list = await fetch(`${off.base}/api/ui-verify`);
    assert.strictEqual(list.status, 200);
    assert.deepStrictEqual(await list.json(), { enabled: false, tasks: [] });
    const img = await fetch(`${off.base}/api/ui-verify/pri-361/AC-1-runs.png`);
    assert.strictEqual(img.status, 404);
    // mesma resposta do resto de /api: nada denuncia que a rota existe
    const unknown = await fetch(`${off.base}/api/rota-que-nao-existe`);
    assert.deepStrictEqual(await img.json(), await unknown.json());
});

test('AC-1: com a flag desligada a listagem não expõe nenhuma task, mesmo havendo dados na pasta', async () => {
    const body = await (await fetch(`${off.base}/api/ui-verify`)).text();
    assert.ok(!body.includes('pri-361'));
});

test('AC-2: flag ligada, lista as verificações com veredito e problemas', async () => {
    const res = await fetch(`${on.base}/api/ui-verify`);
    assert.strictEqual(res.status, 200);
    const { enabled, tasks } = await res.json();
    assert.strictEqual(enabled, true);
    const t = tasks.find(x => x.taskId === 'pri-361');
    assert.strictEqual(t.verdict, 'FALHOU');
    assert.strictEqual(t.problems[0].code, 'CONSOLE_ERROR');
    assert.deepStrictEqual(t.images, ['AC-1-runs.png']);
});

test('AC-4: task sem veredito aparece como UNKNOWN', async () => {
    const { tasks } = await (await fetch(`${on.base}/api/ui-verify`)).json();
    assert.strictEqual(tasks.find(x => x.taskId === 'sem-veredito').verdict, 'UNKNOWN');
});

test('a resposta passa por redact: segredo no detalhe não sai', async () => {
    const body = await (await fetch(`${on.base}/api/ui-verify`)).text();
    assert.ok(!body.includes('segredo-que-nao-vaza'));
});

test('limit inválido responde 400', async () => {
    for (const bad of ['0', '-1', 'abc', '1.5', '9999']) {
        assert.strictEqual((await fetch(`${on.base}/api/ui-verify?limit=${bad}`)).status, 400, bad);
    }
    assert.strictEqual((await fetch(`${on.base}/api/ui-verify?limit=1`)).status, 200);
});

test('AC-3: serve o PNG da task com tipo image/png e nosniff', async () => {
    const res = await fetch(`${on.base}/api/ui-verify/pri-361/AC-1-runs.png`);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.headers.get('content-type'), 'image/png');
    assert.strictEqual(res.headers.get('x-content-type-options'), 'nosniff');
    assert.ok(Buffer.from(await res.arrayBuffer()).equals(PNG));
});

test('AC-5: a rota de imagem recusa travessia, symlink, arquivo inexistente e tipo errado', async () => {
    const paths = [
        '/api/ui-verify/pri-361/link.png',          // symlink para fora
        '/api/ui-verify/pri-361/verdict.json',      // não é PNG
        '/api/ui-verify/pri-361/nao-existe.png',
        '/api/ui-verify/..%2Ffora/segredo.png',     // travessia codificada
        '/api/ui-verify/pri-361/..%2F..%2Ffora%2Fsegredo.png',
    ];
    for (const p of paths) assert.strictEqual((await fetch(on.base + p)).status, 404, p);
});

// fetch() normaliza `%2e%2e` para `..` antes de enviar e cairia no 404 genérico de /api sem tocar a
// rota nova. http.request envia o caminho cru, então o parâmetro chega ao handler como `..`.
test('AC-5: travessia %2e%2e crua chega ao handler e é recusada por ele', async () => {
    const http = require('node:http');
    const get = p => new Promise((resolve, reject) => {
        const u = new URL(on.base);
        http.get({ host: '127.0.0.1', port: u.port, path: p, headers: { Host: `localhost:${u.port}` } }, res => {
            const chunks = [];
            res.on('data', c => chunks.push(c));
            res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }));
        }).on('error', reject);
    });
    for (const p of ['/api/ui-verify/%2e%2e/AC-1-runs.png', '/api/ui-verify/pri-361/%2e%2e%2fsegredo.png']) {
        const r = await get(p);
        assert.strictEqual(r.status, 404, p);
        assert.ok(!r.body.equals(PNG), p);
    }
});

test('o PNG servido é o do arquivo, e só 1 caminho existe: troca por symlink depois não vaza', async () => {
    const alvo = path.join(uiDir, 'pri-361', 'AC-1-runs.png');
    const copia = fs.readFileSync(alvo);
    fs.rmSync(alvo);
    fs.symlinkSync(path.join(fora, 'segredo.png'), alvo);
    try {
        assert.strictEqual((await fetch(`${on.base}/api/ui-verify/pri-361/AC-1-runs.png`)).status, 404);
    } finally { fs.rmSync(alvo); fs.writeFileSync(alvo, copia); }
});

test('AC-6: com PRISMA_DASHBOARD_READONLY=1 a aba continua funcionando e nenhuma escrita passa', async () => {
    process.env.PRISMA_DASHBOARD_READONLY = '1';
    try {
        assert.strictEqual((await fetch(`${ro.base}/api/ui-verify`)).status, 200);
        assert.strictEqual((await fetch(`${ro.base}/api/ui-verify/pri-361/AC-1-runs.png`)).status, 200);
        // Escrita: quem recusa é o filtro global de somente leitura, não esta feature; a feature só tem GET.
        for (const method of ['POST', 'PUT', 'DELETE']) {
            const res = await fetch(`${ro.base}/api/ui-verify`, { method });
            assert.ok([403, 404, 405].includes(res.status), `${method} ${res.status}`);
        }
    } finally { delete process.env.PRISMA_DASHBOARD_READONLY; }
});

test('a rota não escreve: nenhum arquivo novo na pasta de verificações', async () => {
    const antes = fs.readdirSync(path.join(uiDir, 'pri-361')).sort();
    await fetch(`${on.base}/api/ui-verify`);
    await fetch(`${on.base}/api/ui-verify/pri-361/AC-1-runs.png`);
    assert.deepStrictEqual(fs.readdirSync(path.join(uiDir, 'pri-361')).sort(), antes);
});
