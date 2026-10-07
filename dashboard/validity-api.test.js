// node --test validity-api.test.js
// Dados de validade dos artefatos (scripts/invalidate.js describe) no dashboard:
// GET /api/runs/:taskId (campo validity) e GET /api/runs/:taskId/validity. STALE vira
// badge "⚠ STALE" com "Evidence produzida contra Spec v1. Spec atual: v2." por AC e no
// nó do trilho; run legado sem spec_hash = UNKNOWN, "legado sem versão" (sem badge).
// Nenhuma credencial na resposta.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpBase = process.env.CLAUDE_JOB_DIR ? path.join(process.env.CLAUDE_JOB_DIR, 'tmp') : os.tmpdir();
const tmp = fs.mkdtempSync(path.join(tmpBase, 'validity-api-'));
const repo = path.join(tmp, 'app-back');
const mainRuns = path.join(repo, 'memory', 'runs');
fs.mkdirSync(mainRuns, { recursive: true });

process.env.BITBUCKET_API_TOKEN = 'token-bitbucket-que-nao-vaza';
process.env.REDMINE_API_KEY = 'chave-redmine-que-nao-vaza';

const H1 = 'a'.repeat(64);
const H2 = 'b'.repeat(64);
const stale = { status: 'STALE', stale_since_version: 2, stale_acs: [] };
const entry = (artifact, v) => ({ artifact, spec_hash: H1, spec_version: 1, produced_at: '2026-10-01T10:00:00.000Z', validity: v });

function seedRun(taskId, state, evidence) {
    const dir = path.join(mainRuns, taskId);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({
        task_id: taskId, history: ['plan'], started_at: '2026-10-01T10:00:00.000Z', updated_at: '2026-10-01T12:00:00.000Z', ...state,
    }));
    if (evidence) fs.writeFileSync(path.join(dir, 'acceptance-evidence.json'), JSON.stringify(evidence));
}

// Run invalidado por SPEC_CHANGE (v1 → v2).
seedRun('43700-invalidado', {
    node: 'plan', status: 'in_progress', spec_hash: H2, spec: { version: 2, hash: H2, hash_scope: 'contract_sections_v1' },
    artifact_validity: {
        plan: entry('plan.md', stale), implement: entry('implementação (diff do worktree)', stale), review: entry('review-result.md', stale),
        evidence: entry('acceptance-evidence.json', stale), verify: entry('spec-conformance.md', stale),
    },
    invalidations: [{ at: '2026-10-01T12:00:00.000Z', triggered_by: 'SPEC_CHANGE SC-001', case: 'idle', old_spec_hash: H1, new_spec_hash: H2, old_spec_version: 1, new_spec_version: 2, phases: ['plan', 'implement', 'review', 'evidence', 'verify'], stale_acs: [] }],
}, {
    schema_version: 1, run_id: '43700-invalidado', generated_at: '2026-10-01T10:00:00.000Z', spec_hash: H1, spec_version: 1, validity: stale,
    coverage: { 'AC-03': { status: 'PASS', evidence: [{ description: 'FreteTest#csv', type: 'manual', result: 'PASS' }] } },
});
// Run legado: sem bloco spec, matriz sem spec_hash.
seedRun('43701-legado', { node: 'verify', status: 'in_progress', spec_hash: H1 }, {
    schema_version: 1, run_id: '43701-legado', generated_at: '2026-09-20T10:00:00.000Z',
    coverage: { 'AC-01': { status: 'PASS', evidence: [{ description: 'x', type: 'manual', result: 'PASS' }] } },
});

const { createDashboard } = require('./server');
const dash = createDashboard({ memoryDir: mainRuns, worktreesDir: path.join(repo, '.claude', 'worktrees') });
let base;
test.before(async () => {
    await new Promise(r => dash.server.listen(0, '127.0.0.1', r));
    base = `http://localhost:${dash.server.address().port}`;
    await dash.ready;
});
test.after(() => { dash.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

async function get(p) {
    const res = await fetch(base + p);
    const text = await res.text();
    assert.ok(!text.includes('token-bitbucket-que-nao-vaza') && !text.includes('chave-redmine-que-nao-vaza'), `credencial vazou em ${p}`);
    return { status: res.status, body: JSON.parse(text) };
}

test('run invalidado: badge ⚠ STALE por fase/nó e mensagem por AC (dados das Tasks 67 e 68)', async () => {
    const { status, body } = await get('/api/runs/43700-invalidado/validity');
    assert.strictEqual(status, 200);
    assert.strictEqual(body.spec.version, 2);
    assert.strictEqual(body.nodes.test, 'STALE', 'nó Verify/Test do trilho com badge');
    assert.strictEqual(body.nodes.verify, 'STALE');
    assert.strictEqual(body.phases.evidence.badge, '⚠ STALE');
    assert.strictEqual(body.phases.evidence.message, 'Evidence produzida contra Spec v1. Spec atual: v2.');
    assert.deepStrictEqual(body.acs, [{ ac: 'AC-03', test_status: 'PASS', validity: 'STALE', message: 'Evidence produzida contra Spec v1. Spec atual: v2.' }]);
    assert.deepStrictEqual(body.phases.evidence.stale_acs, []);
    assert.strictEqual(body.last_invalidation.triggered_by, 'SPEC_CHANGE SC-001');
    const detail = await get('/api/runs/43700-invalidado');
    assert.strictEqual(detail.status, 200);
    assert.deepStrictEqual(detail.body.validity, body, 'RunDetail recebe os mesmos dados');
});

test('run legado sem spec_hash: UNKNOWN exibido como "legado sem versão" (nem STALE nem VALID)', async () => {
    const { body } = await get('/api/runs/43701-legado/validity');
    assert.strictEqual(body.phases.evidence.status, 'UNKNOWN');
    assert.strictEqual(body.phases.evidence.label, 'legado sem versão');
    assert.strictEqual(body.phases.evidence.badge, null);
    assert.strictEqual(body.acs[0].message, 'legado sem versão');
    assert.strictEqual(body.spec.versioned, false);
});

test('run inexistente: 404', async () => {
    assert.strictEqual((await get('/api/runs/43799-nada/validity')).status, 404);
});
