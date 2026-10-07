// node --test provenance-api.test.js
// GET /api/provenance/:ticket/:acId e /api/provenance/:acId?ticket= — provenance de AC
// (scripts/lib/ac-provenance.js). Identidade = (ticket, ac_id): sem ticket e com o AC em
// mais de um ticket → 409 com candidatos. Só referências na resposta, nada de credencial.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpBase = process.env.CLAUDE_JOB_DIR ? path.join(process.env.CLAUDE_JOB_DIR, 'tmp') : os.tmpdir();
const tmp = fs.mkdtempSync(path.join(tmpBase, 'provenance-api-'));
const repo = path.join(tmp, 'app-back');
const mainRuns = path.join(repo, 'memory', 'runs');
const specDir = path.join(repo, 'memory', 'spec');
fs.mkdirSync(mainRuns, { recursive: true });
fs.mkdirSync(specDir, { recursive: true });
fs.mkdirSync(path.join(repo, '.graph'), { recursive: true });

process.env.BITBUCKET_API_TOKEN = 'token-bitbucket-que-nao-vaza';
process.env.REDMINE_API_KEY = 'chave-redmine-que-nao-vaza';
const prov = require('../scripts/lib/ac-provenance');

const AC_TEXT = 'Produtos divergentes do XML retornam 400';
const spec = acs => `# Spec\n\n## Problema\nx\n\n## Critérios de Aceite\n${acs.map(a => `- ${a}: ${AC_TEXT} (${a}).`).join('\n')}\n`;
// 43666: AC-01 com cadeia completa (ORIGIN → CLARIFICATION → MODIFICATION) + run com evidência e PR.
fs.writeFileSync(path.join(specDir, '43666-spec.md'), spec(['AC-01', 'AC-02']));
prov.appendEvents('43666', [
    ...prov.descriptionOriginEvents('43666', ['AC-01'], { specPath: 'memory/spec/43666-spec.md' }),
    ...prov.specChangeEvents('43666', [{ ac: 'AC-01', action: 'affected' }], {
        change_id: 'SC-001', approval_ref: 'spec-change-audit.json#entry-1', proposal_comment_id: 45411, approval_journal_id: 45412,
        spec_hash_before: 'a'.repeat(64), spec_hash_after: 'b'.repeat(64), previous_version: 1, new_version: 2, task_id: '43666-sincroniza',
    }, [{ message_hash: 'abc123def4567890', at: '2026-09-30T12:42:00.000Z', node: 'implement' }]),
], { root: repo });
const runDir = path.join(mainRuns, '43666-sincroniza');
fs.mkdirSync(runDir, { recursive: true });
fs.writeFileSync(path.join(runDir, 'state.json'), JSON.stringify({
    task_id: '43666-sincroniza', node: 'commit', status: 'committed', history: ['plan'], started_at: '2026-10-01T10:00:00.000Z', updated_at: '2026-10-01T12:00:00.000Z',
    redmine_ticket: { id: 43666 }, spec_hash: 'b'.repeat(64), spec: { version: 2, hash: 'b'.repeat(64) },
    pull_request: { 'app-back': { url: 'https://bitbucket.org/mosistemas/app-back/pull-requests/456', number: 456 } },
}));
fs.writeFileSync(path.join(runDir, 'acceptance-evidence.json'), '{}');
// 43703: também tem AC-01 (identidade não é global) — sem provenance → legacy.
fs.writeFileSync(path.join(specDir, '43703-spec.md'), spec(['AC-01']));
// 43690: AC só na spec do worktree do ticket (ciclo em andamento, /commit ainda não sincronizou).
fs.mkdirSync(path.join(repo, '.claude', 'worktrees', '43690', 'memory', 'spec'), { recursive: true });
fs.writeFileSync(path.join(repo, '.claude', 'worktrees', '43690', 'memory', 'spec', '43690-spec.md'), spec(['AC-05']));
// 41948: entrada legada do registro, critérios sem ID.
fs.writeFileSync(path.join(repo, '.graph', 'ac-registry.json'), JSON.stringify({
    version: 2, updatedAt: null, tasks: { '41948': { ticket_id: '41948', spec_hash: 'x', ac_ids: [], legacy: true, criteria: ['texto legado'] } },
}));

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
    return { status: res.status, body: JSON.parse(text), text };
}

test('GET /api/provenance/43666/AC-01 → 200 com a cadeia completa, em ordem', async () => {
    const { status, body } = await get('/api/provenance/43666/AC-01');
    assert.strictEqual(status, 200);
    assert.strictEqual(body.ticket_id, '43666');
    assert.strictEqual(body.ac_id, 'AC-01');
    assert.strictEqual(body.legacy, false);
    assert.deepStrictEqual(body.sources.map(s => [s.type, s.role]), [
        ['REDMINE_DESCRIPTION', 'ORIGIN'], ['HUMAN_CLARIFICATION', 'CLARIFICATION'], ['SPEC_CHANGE', 'MODIFICATION'],
    ]);
    const sc = body.sources[2].reference;
    assert.strictEqual(sc.change_id, 'SC-001');
    assert.strictEqual(sc.proposal_comment_id, 45411);
    assert.strictEqual(sc.approval_journal_id, 45412);
    assert.strictEqual(body.spec_version, 2);
    assert.strictEqual(body.spec_hash, 'b'.repeat(64));
    assert.strictEqual(body.evidence_ref, 'memory/runs/43666-sincroniza/acceptance-evidence.json#AC-01');
    assert.deepStrictEqual(body.pr_ref, { repo: 'app-back', url: 'https://bitbucket.org/mosistemas/app-back/pull-requests/456' });
    assert.ok(!('effective_source' in body));
});

test('ticket explícito resolve deterministicamente (rota e ?ticket=), e aceita ac minúsculo', async () => {
    const a = await get('/api/provenance/43703/AC-01');
    const b = await get('/api/provenance/AC-01?ticket=43703');
    const c = await get('/api/provenance/43703/ac-1');
    for (const r of [a, b, c]) {
        assert.strictEqual(r.status, 200);
        assert.strictEqual(r.body.ticket_id, '43703');
        assert.strictEqual(r.body.ac_id, 'AC-01');
    }
});

test('AC legado (existe, sem provenance) → 200, legacy=true, sources=[]', async () => {
    const { status, body } = await get('/api/provenance/43703/AC-01');
    assert.strictEqual(status, 200);
    assert.strictEqual(body.legacy, true);
    assert.deepStrictEqual(body.sources, []);
    assert.strictEqual(body.spec_version, null);
});

test('AC-01 em dois tickets, sem ticket → 409 com os candidatos; nunca escolhe um', async () => {
    const { status, body } = await get('/api/provenance/AC-01');
    assert.strictEqual(status, 409);
    assert.deepStrictEqual(body.candidates, ['43666', '43703']);
    assert.match(body.error, /não é global/);
});

test('sem ticket e um único dono → 200 (AC-02 só existe no 43666)', async () => {
    const { status, body } = await get('/api/provenance/AC-02');
    assert.strictEqual(status, 200);
    assert.strictEqual(body.ticket_id, '43666');
    assert.strictEqual(body.legacy, true);
});

test('inexistente → 404 com mensagem clara (inclusive ticket legado sem IDs)', async () => {
    const a = await get('/api/provenance/43666/AC-09');
    assert.strictEqual(a.status, 404);
    assert.match(a.body.error, /AC-09 não encontrado no ticket 43666/);
    const b = await get('/api/provenance/AC-77');
    assert.strictEqual(b.status, 404);
    const c = await get('/api/provenance/41948/AC-01');
    assert.strictEqual(c.status, 404);
    assert.match(c.body.error, /legado: critérios sem IDs/);
});

test('AC que só existe na spec do worktree do ticket é encontrado (legacy=true sem eventos)', async () => {
    const { status, body } = await get('/api/provenance/43690/AC-05');
    assert.strictEqual(status, 200);
    assert.strictEqual(body.legacy, true);
});

test('entrada inválida → 400', async () => {
    assert.strictEqual((await get('/api/provenance/abc/AC-01')).status, 400);
    assert.strictEqual((await get('/api/provenance/43666/XYZ')).status, 400);
    assert.strictEqual((await get('/api/provenance/AC-01?ticket=1;rm')).status, 400);
});

test('T11. zero credencial e zero texto de AC nas respostas', async () => {
    for (const p of ['/api/provenance/43666/AC-01', '/api/provenance/AC-01', '/api/provenance/43703/AC-01', '/api/provenance/43666/AC-09']) {
        const { text } = await get(p);
        assert.doesNotMatch(text, /token-bitbucket-que-nao-vaza|chave-redmine-que-nao-vaza|X-Redmine-API-Key|Authorization/i, p);
        assert.ok(!text.includes(AC_TEXT), `texto do AC não sai em ${p}`);
    }
});
