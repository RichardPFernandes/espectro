// node --test openapi-contract-api.test.js
// Botão "Ver contrato OpenAPI" do detalhe: summary.hasOpenApiContract e
// GET /api/runs/:taskId/openapi-contract (memory/runs/<task-id>/openapi-contract.yaml,
// gerado pelo nó Plan só em task de endpoint).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpBase = process.env.CLAUDE_JOB_DIR ? path.join(process.env.CLAUDE_JOB_DIR, 'tmp') : os.tmpdir();
const tmp = fs.mkdtempSync(path.join(tmpBase, 'openapi-contract-api-'));
const mainRuns = path.join(tmp, 'memory', 'runs');
fs.mkdirSync(mainRuns, { recursive: true });

function seed(taskId, state) {
    const dir = path.join(mainRuns, taskId);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ task_id: taskId, history: ['plan'], ...state }));
    return dir;
}

const SECRET = 'segredo-do-contrato-nao-pode-vazar';
const CONTRACT = `openapi: 3.0.3
info:
  title: Contrato 81001
  version: "1.0"
paths:
  /carga/liberar:
    post:
      description: token ${SECRET}
      responses:
        '200': { description: ok }
`;

const withContract = seed('81001-endpoint', { node: 'implement', status: 'running', updated_at: '2026-09-29T00:00:00Z' });
fs.writeFileSync(path.join(withContract, 'openapi-contract.yaml'), CONTRACT);
seed('81002-sem-endpoint', { node: 'implement', status: 'running', updated_at: '2026-09-29T00:00:00Z' });

process.env.BITBUCKET_API_TOKEN = SECRET;
const { createDashboard } = require('./server');
const dash = createDashboard({ memoryDir: mainRuns, env: { ...process.env, COORD_STATUS_PATH: path.join(tmp, 'coord-status.json'), COORD_CAPACITY_SCRIPT: path.join(tmp, 'unavailable.mjs') } });
let base;

test.before(async () => {
    await new Promise(r => dash.server.listen(0, '127.0.0.1', r));
    base = `http://localhost:${dash.server.address().port}`;
    await dash.ready;
});
test.after(async () => {
    await dash.close();
    fs.rmSync(tmp, { recursive: true, force: true });
});

test('summary: hasOpenApiContract só no run que tem o arquivo', async () => {
    const runs = await (await fetch(`${base}/api/runs`)).json();
    assert.strictEqual(runs.find(r => r.taskId === '81001-endpoint').hasOpenApiContract, true);
    assert.strictEqual(runs.find(r => r.taskId === '81002-sem-endpoint').hasOpenApiContract, false);
    const detail = await (await fetch(`${base}/api/runs/81001-endpoint`)).json();
    assert.strictEqual(detail.hasOpenApiContract, true);
});

test('GET /openapi-contract: devolve o YAML em texto, com secret redigido', async () => {
    const res = await fetch(`${base}/api/runs/81001-endpoint/openapi-contract`);
    assert.strictEqual(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/plain/);
    const body = await res.text();
    assert.match(body, /^openapi: 3\.0\.3/);
    assert.match(body, /\/carga\/liberar:/);
    assert.ok(!body.includes(SECRET), 'secret do ambiente nunca sai no contrato');
});

test('GET /openapi-contract: 404 em run sem contrato e em run inexistente', async () => {
    const semContrato = await fetch(`${base}/api/runs/81002-sem-endpoint/openapi-contract`);
    assert.strictEqual(semContrato.status, 404);
    assert.match((await semContrato.json()).error, /sem contrato OpenAPI/);
    assert.strictEqual((await fetch(`${base}/api/runs/99999-nao-existe/openapi-contract`)).status, 404);
});

test('GET /api/coordination: adjacent OpenAPI contract describes and matches read-only response', async () => {
    const contract = JSON.parse(fs.readFileSync(path.join(__dirname, 'coordination.openapi.json'), 'utf8'));
    assert.strictEqual(contract.openapi, '3.0.3');
    const route = contract.paths['/api/coordination'];
    assert.deepStrictEqual(Object.keys(route), ['get']);
    assert.strictEqual(route.get.responses['200'].content['application/json'].schema.$ref, '#/components/schemas/Coordination');
    const body = await (await fetch(`${base}/api/coordination`)).json();
    const schema = contract.components.schemas.Coordination;
    assert.deepStrictEqual(Object.keys(body).sort(), schema.required.slice().sort());
    assert.ok(schema.properties.status.enum.includes(body.status));
    assert.strictEqual(body.status, 'empty');
    assert.deepStrictEqual(body.capacity, { status: 'unavailable' });
    assert.deepStrictEqual(contract.components.schemas.State.enum.slice().sort(), Object.keys(body.counts).sort());
    assert.deepStrictEqual(contract.components.schemas.RestrictedTask.required, ['frente', 'tarefa', 'estado']);
});
