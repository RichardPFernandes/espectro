// node --test flags-summary-api.test.js
// GET /api/flags-summary: resumo do registro de flags (docs/flags.md), só leitura (PRI-399,
// F0.9 AC-03, métrica 4). O servidor chama scripts/flags-read.js por processo; falha é
// UNKNOWN (502), nunca contagem zero.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpBase = process.env.CLAUDE_JOB_DIR ? path.join(process.env.CLAUDE_JOB_DIR, 'tmp') : os.tmpdir();
const tmp = fs.mkdtempSync(path.join(tmpBase, 'flags-summary-api-'));
const mainRuns = path.join(tmp, 'app-back', 'memory', 'runs');
fs.mkdirSync(mainRuns, { recursive: true });

const { createDashboard } = require('./server');

// Linhas de dados da tabela de flags do docs/flags.md, contadas aqui (sem número fixo):
// a tabela começa no cabeçalho "| Flag |", pula o separador e vai até a primeira linha sem "|".
function countRegistryRows() {
    const lines = fs.readFileSync(path.join(__dirname, '..', 'docs', 'flags.md'), 'utf8').split('\n');
    const start = lines.findIndex(l => /^\|\s*Flag\s*\|/.test(l));
    assert.ok(start >= 0, 'docs/flags.md sem tabela de flags');
    let n = 0;
    for (let i = start + 2; i < lines.length && lines[i].trim().startsWith('|'); i++) n++;
    return n;
}

let dash, base;
test.before(async () => {
    dash = createDashboard({ memoryDir: mainRuns });
    await new Promise(r => dash.server.listen(0, '127.0.0.1', r));
    base = `http://localhost:${dash.server.address().port}`;
    await dash.ready;
});
test.after(() => { dash?.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

test('200 com o resumo do registro: n igual às linhas da tabela de docs/flags.md', async () => {
    const res = await fetch(`${base}/api/flags-summary`);
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.n, countRegistryRows());
    assert.strictEqual(body.fonte, 'docs/flags.md');
    assert.strictEqual(body.padrao.ligada + body.padrao.desligada, body.n);
    assert.strictEqual(body.consumidor.nao_verificado + body.consumidor.outro, body.n);
    assert.strictEqual(typeof body.vencidas, 'number');
    assert.strictEqual(typeof body.itens_desligados, 'number');
    assert.match(body.hoje, /^\d{4}-\d{2}-\d{2}$/);
});

test('endpoint é só leitura: POST/PUT/DELETE não existem', async () => {
    for (const method of ['POST', 'PUT', 'DELETE']) {
        const res = await fetch(`${base}/api/flags-summary`, { method });
        assert.ok([404, 405].includes(res.status), `${method} → ${res.status}`);
    }
});

test('leitor por processo quebrado: 502 com status UNKNOWN, sem vazar caminho e sem zero', async () => {
    const brokenScript = path.join(tmp, 'flags-read-quebrado.js');
    fs.writeFileSync(brokenScript, `process.stdout.write(JSON.stringify({ ok: false, error: ${JSON.stringify(tmp)} })); process.exitCode = 2;\n`);
    for (const script of [brokenScript, path.join(tmp, 'nao-existe.js')]) {
        const broken = createDashboard({ memoryDir: mainRuns, flagsReadScript: script });
        await new Promise(r => broken.server.listen(0, '127.0.0.1', r));
        try {
            await broken.ready;
            const res = await fetch(`http://localhost:${broken.server.address().port}/api/flags-summary`);
            assert.strictEqual(res.status, 502);
            const body = await res.json();
            assert.strictEqual(body.status, 'UNKNOWN');
            assert.strictEqual(body.n, undefined);
            assert.ok(!JSON.stringify(body).includes(tmp));
        } finally { broken.close(); }
    }
});

test('o dashboard não importa scripts/lib/flag-registry (fronteira G3)', () => {
    const src = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
    assert.doesNotMatch(src, /require\([^)]*flag-registry/);
});
