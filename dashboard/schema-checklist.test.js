// node --test schema-checklist.test.js
// Migration Checklist no dashboard: schemaChanges no /api/runs, endpoint
// /api/runs/:id/schema-checklist e o módulo do front (public/schema-checklist.js).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpBase = process.env.CLAUDE_JOB_DIR ? path.join(process.env.CLAUDE_JOB_DIR, 'tmp') : os.tmpdir();
const tmp = fs.mkdtempSync(path.join(tmpBase, 'dashboard-schema-'));
const mainRuns = path.join(tmp, 'app-back', 'memory', 'runs');

const schemaWatcher = require('../scripts/lib/schema-watcher');
const SC = require('./public/schema-checklist');

function seed(taskId, state, context = '') {
    const dir = path.join(mainRuns, taskId);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ task_id: taskId, history: [], node: 'review', status: 'in_progress', updated_at: '2026-09-20T00:00:00Z', ...state }));
    if (context) fs.writeFileSync(path.join(dir, 'context.md'), context);
}

const f = 'src/main/resources/db/migration/V12__add_column_cliente.sql';
const detected = schemaWatcher.detectSchemaChanges([f],
    `diff --git a/${f} b/${f}\nnew file mode 100644\n--- /dev/null\n+++ b/${f}\n@@ -0,0 +1 @@\n+ALTER TABLE cliente RENAME COLUMN nome TO nm_cliente;\n`);
const ctx = schemaWatcher.upsertContextChecklist('# Contexto\n\nlinha', detected);

seed('94001-schema', { schema_changes_detected: true, schema_risk_level: 'high' }, ctx);
seed('94002-sem', { schema_changes_detected: false, schema_risk_level: null }, '# Contexto\n');
seed('94003-antigo', {}, '# Contexto\n');

const { createDashboard } = require('./server');
const dash = createDashboard({ memoryDir: mainRuns });
let base;
test.before(async () => {
    await new Promise(r => dash.server.listen(0, '127.0.0.1', r));
    base = `http://localhost:${dash.server.address().port}`;
    await dash.ready;
});
test.after(() => dash.close());
async function get(p) {
    const res = await fetch(base + p);
    return { status: res.status, body: await res.json() };
}

test('GET /api/runs: schemaChanges com riskLevel só quando schema_changes_detected === true', async () => {
    const { body } = await get('/api/runs');
    const by = id => body.find(x => x.taskId === id);
    assert.deepStrictEqual(by('94001-schema').schemaChanges, { riskLevel: 'high' });
    assert.strictEqual(by('94002-sem').schemaChanges, null);
    assert.strictEqual(by('94003-antigo').schemaChanges, null);
});

test('GET /api/runs/:id/schema-checklist devolve o bloco inteiro + signature', async () => {
    const { status, body } = await get('/api/runs/94001-schema/schema-checklist');
    assert.strictEqual(status, 200);
    assert.strictEqual(body.detected, true);
    assert.strictEqual(body.riskLevel, 'high');
    assert.strictEqual(body.signature, schemaWatcher.signatureOf(detected));
    assert.match(body.markdown, /^## ⚠️ Schema Migration Checklist/);
    assert.match(body.markdown, /### Janela de manutenção/);
    assert.doesNotMatch(body.markdown, /schema-watcher:/);
});

test('GET /api/runs/:id/schema-checklist sem bloco -> markdown null; run inexistente -> 404', async () => {
    const { body } = await get('/api/runs/94002-sem/schema-checklist');
    assert.deepStrictEqual(body, { detected: false, riskLevel: null, markdown: null, signature: null });
    assert.strictEqual((await get('/api/runs/99999-nada/schema-checklist')).status, 404);
});

// --- módulo do front ---------------------------------------------------------------

const md = schemaWatcher.extractContextChecklist(ctx).markdown;

test('render: checkboxes interativos na ordem, conteúdo escapado, sem o título ##', () => {
    const html = SC.render(md);
    const n = SC.items(md).length;
    assert.ok(n >= 10);
    assert.strictEqual((html.match(/type="checkbox"/g) || []).length, n);
    assert.match(html, /data-mig-index="0"/);
    assert.match(html, /<h5>Rollback script<\/h5>/);
    assert.doesNotMatch(html, /Schema Migration Checklist<\/h/);
    const evil = SC.render('- [ ] <img src=x onerror=alert(1)> `a<b`');
    assert.doesNotMatch(evil, /<img/);
    assert.match(evil, /<code>a&lt;b<\/code>/);
});

test('effectiveChecks: salvo com a mesma signature vale; signature nova descarta', () => {
    const src = '- [ ] a\n- [x] b\n- [ ] c';
    assert.deepStrictEqual(SC.effectiveChecks(src, null, 's1'), [false, true, false]);
    assert.deepStrictEqual(SC.effectiveChecks(src, { sig: 's1', checked: { 0: true, 1: false } }, 's1'), [true, false, false]);
    assert.deepStrictEqual(SC.effectiveChecks(src, { sig: 's0', checked: { 0: true } }, 's1'), [false, true, false]);
    assert.strictEqual(SC.storageKey('94001-schema'), 'schemaChecklist:94001-schema');
});

test('toMarkdown: aplica os checks atuais e preserva o resto; progress conta', () => {
    const src = '### X\n- [ ] a\n- item\n- [x] b';
    assert.strictEqual(SC.toMarkdown(src, [true, false]), '### X\n- [x] a\n- item\n- [ ] b');
    assert.deepStrictEqual(SC.progress([true, false, true]), { done: 2, total: 3 });
});
