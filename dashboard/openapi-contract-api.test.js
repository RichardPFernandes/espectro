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
const coordinationPath = path.join(tmp, 'coord-status.json');
const capacityPath = path.join(tmp, 'coord-capacity.mjs');
fs.writeFileSync(capacityPath, "console.log(JSON.stringify([{runtime:'codex',reading:{five_hour:{used:12},seven_day:{used:34}}}]))");
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
const dash = createDashboard({ memoryDir: mainRuns, env: { ...process.env, COORD_STATUS_PATH: coordinationPath, COORD_CAPACITY_SCRIPT: capacityPath } });
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
    assert.ok(route.get.responses['500'], 'route contract documents internal errors');
    const schemas = contract.components.schemas;
    const validateObject = (value, schema) => {
        for (const key of schema.required || []) assert.ok(Object.hasOwn(value, key), `required ${key}`);
        for (const key of Object.keys(value)) assert.ok(Object.hasOwn(schema.properties, key), `unexpected ${key}`);
    };
    const validateResponse = body => {
        validateObject(body, schemas.Coordination);
        assert.ok(schemas.Coordination.properties.status.enum.includes(body.status));
        assert.deepStrictEqual(schemas.State.enum.slice().sort(), Object.keys(body.counts).sort());
        for (const front of body.frentes) validateObject(front, schemas.Front);
        for (const task of body.tarefas) {
            const taskSchema = task.id === undefined ? schemas.RestrictedTask : schemas.Task;
            validateObject(task, taskSchema);
            assert.ok(schemas.State.enum.includes(task.estado));
        }
        if (body.capacity.status === 'ok') {
            for (const runtime of body.capacity.runtimes) {
                validateObject(runtime, schemas.Capacity.oneOf[1].properties.runtimes.items);
                assert.match(runtime.runtime, /^(codex|claude)( \([^\r\n]{1,100}\))?$/);
                for (const window of [runtime.five_hour, runtime.seven_day]) {
                    if (window !== null) {
                        validateObject(window, schemas.Window);
                        assert.equal(typeof window.used, 'number');
                        assert.ok(window.used >= 0 && window.used <= 100);
                    }
                }
            }
        } else validateObject(body.capacity, schemas.Capacity.oneOf[0]);
    };
    let body = await (await fetch(`${base}/api/coordination`)).json();
    assert.strictEqual(body.status, 'empty');
    validateResponse(body);

    fs.writeFileSync(coordinationPath, JSON.stringify({ schemaVersion: 1, updatedAt: '2026-10-10T15:00:00Z',
        frentes: [{ id: 'public', nome: 'Plataforma' }, { id: 'restricted', nome: 'M&O', restricted: true }],
        tarefas: [
            { id: 'T-1', frente: 'public', tarefa: 'Implementar', agente: 'Codex', runtime: 'codex', estado: 'Em andamento', nota: 'Segue', atualizado: '2026-10-10T15:00:00Z', link: 'https://example.com/task' },
            { id: 'T-2', frente: 'restricted', tarefa: 'Revisar', estado: 'Na fila' },
        ] }));
    body = await (await fetch(`${base}/api/coordination`)).json();
    assert.strictEqual(body.status, 'ok');
    assert.deepStrictEqual(body.capacity, { status: 'ok', runtimes: [{ runtime: 'codex', five_hour: { used: 12 }, seven_day: { used: 34 } }] });
    validateResponse(body);

    fs.writeFileSync(coordinationPath, '{ invalid secret }');
    body = await (await fetch(`${base}/api/coordination`)).json();
    assert.strictEqual(body.status, 'invalid');
    assert.ok(!JSON.stringify(body).includes('invalid secret'));
    validateResponse(body);
    assert.deepStrictEqual(schemas.RestrictedTask.required, ['frente', 'tarefa', 'estado']);
});
