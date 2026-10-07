// node --test validate-config-api.test.js
// GET /api/validate-config: validação injetada (os casos de regra são cobertos em
// scripts/lib/config-validator.test.js) + uma execução real do script contra o repo.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createDashboard } = require('./server');

const tmpBase = process.env.CLAUDE_JOB_DIR ? path.join(process.env.CLAUDE_JOB_DIR, 'tmp') : os.tmpdir();
const tmp = fs.mkdtempSync(path.join(tmpBase, 'validate-config-api-'));
fs.mkdirSync(path.join(tmp, 'memory', 'runs'), { recursive: true });

const watcherManager = {
    status: () => ({ state: 'stopped', running: false }),
    start: async () => ({}), stop: async () => ({}), restart: async () => ({}),
    getLogBuffer: () => [], onLine: () => () => {},
};
let next = null;
const opts = extra => ({
    memoryDir: path.join(tmp, 'memory', 'runs'), worktreesDir: path.join(tmp, 'wt'), watcherManager,
    prefsFile: path.join(tmp, 'prefs.json'), ...extra,
});
const dash = createDashboard(opts({ validateConfig: async () => { if (next instanceof Error) throw next; return JSON.parse(JSON.stringify(next)); } }));
const realDash = createDashboard(opts({ prefsFile: path.join(tmp, 'prefs2.json') }));

const listen = async d => { await new Promise(r => d.server.listen(0, '127.0.0.1', r)); await d.ready; return `http://localhost:${d.server.address().port}`; };
let base, realBase;
test.before(async () => { base = await listen(dash); realBase = await listen(realDash); });
test.after(async () => { await dash.close(); await realDash.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

const get = async (b = base) => { const r = await fetch(`${b}/api/validate-config`); return { status: r.status, body: await r.json() }; };
const report = (exitCode, results) => ({
    contractVersion: '1.0.0', generatedAt: '2026-09-30T12:00:00Z', valid: exitCode === 0, exitCode,
    message: exitCode ? 'Configuração inválida - 1 erro(s) em 1 regra(s)' : 'Configuração válida - 6 regras passaram',
    summary: { rules: 6, passedRules: exitCode ? 5 : 6, errors: exitCode ? 1 : 0, warnings: 0, info: 0 }, results,
});

test('exit 1 do script continua 200, com exitCode=1 e os resultados pro header acender o alerta', async () => {
    next = report(1, [{ rule: 'nodes-have-templates', severity: 'error', passed: false, message: '1 problema(s)', details: ['nó "verify" sem template'] }]);
    const { status, body } = await get();
    assert.strictEqual(status, 200);
    assert.strictEqual(body.exitCode, 1);
    assert.strictEqual(body.results[0].rule, 'nodes-have-templates');
    assert.strictEqual(body.results[0].severity, 'error');
});

test('config válida devolve exitCode 0', async () => {
    next = report(0, [{ rule: 'graph-acyclic', severity: 'error', passed: true, message: 'ok' }]);
    const { status, body } = await get();
    assert.strictEqual(status, 200);
    assert.strictEqual(body.exitCode, 0);
    assert.strictEqual(body.message, 'Configuração válida - 6 regras passaram');
});

test('validador que não roda vira 500 com a mensagem', async () => {
    next = new Error('contrato não encontrado');
    const { status, body } = await get();
    assert.strictEqual(status, 500);
    assert.match(body.error, /validate-config falhou: contrato não encontrado/);
});

test('sem injeção: executa scripts/validate-config.js de verdade e devolve o relatório JSON', async () => {
    const { status, body } = await get(realBase);
    assert.strictEqual(status, 200, JSON.stringify(body));
    assert.match(body.contractVersion, /^\d+\.\d+\.\d+$/);
    assert.ok([0, 1].includes(body.exitCode));
    assert.strictEqual(body.exitCode === 0, body.valid);
    assert.ok(body.results.every(r => typeof r.rule === 'string' && typeof r.passed === 'boolean' && ['error', 'warning', 'info'].includes(r.severity)));
    assert.ok(!('fix' in body), 'o endpoint nunca roda --fix');
});
