// node --test scripts/lib/schema-watcher.test.js
// Checklist de migração: unidade do detector/renderizador e integração com o watcher
// (stampSchemaChecklist) contra um worktree sintético com git de verdade.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const tmp = fs.mkdtempSync(path.join(process.env.CLAUDE_JOB_DIR ? path.join(process.env.CLAUDE_JOB_DIR, 'tmp') : os.tmpdir(), 'schema-watcher-'));
process.env.REPO_PATH = path.join(tmp, 'app-back');
// Portão de build pré-implement roda mvn de verdade — coberto em build-validator.test.js.
process.env.SKIP_PRE_BUILD_VALIDATION = 'true';
process.env.REDMINE_URL = 'http://redmine.test';
process.env.REDMINE_API_KEY = 'k';

const sw = require('./schema-watcher');
const watcher = require('../readmine-watcher');

function newFileDiff(file, content) {
    const lines = content.split('\n');
    return `diff --git a/${file} b/${file}\nnew file mode 100644\n--- /dev/null\n+++ b/${file}\n@@ -0,0 +1,${lines.length} @@\n` +
        lines.map(l => `+${l}`).join('\n') + '\n';
}

// --- detecção ------------------------------------------------------------------

test('V12__add_column_cliente.sql com ADD COLUMN -> detectado, low, tabela cliente', () => {
    const f = 'src/main/resources/db/migration/V12__add_column_cliente.sql';
    const r = sw.detectSchemaChanges([f], newFileDiff(f, 'ALTER TABLE cliente ADD COLUMN ds_apelido VARCHAR(100);'));
    assert.strictEqual(r.detected, true);
    assert.strictEqual(r.riskLevel, 'low');
    assert.strictEqual(r.changes.length, 1);
    assert.strictEqual(r.changes[0].type, 'ADD');
    assert.strictEqual(r.changes[0].table, 'cliente');
});

test('SQL com DROP -> high', () => {
    const f = 'db/V13__drop_coluna.sql';
    const r = sw.detectSchemaChanges([f], newFileDiff(f, 'ALTER TABLE cliente DROP COLUMN ds_apelido;'));
    assert.strictEqual(r.riskLevel, 'high');
    assert.strictEqual(r.changes[0].type, 'DROP');
});

test('SQL com RENAME -> high (e sp_rename / CHANGE COLUMN também)', () => {
    for (const sql of [
        'ALTER TABLE cliente RENAME COLUMN nome TO nm_cliente;',
        "EXEC sp_rename 'cliente.nome', 'nm_cliente', 'COLUMN';",
        'ALTER TABLE cliente CHANGE COLUMN nome nm_cliente VARCHAR(100);',
    ]) {
        const f = 'V14__rename.sql';
        const r = sw.detectSchemaChanges([f], newFileDiff(f, sql));
        assert.strictEqual(r.riskLevel, 'high', sql);
        assert.strictEqual(r.changes[0].type, 'RENAME', sql);
    }
});

test('ALTER COLUMN -> medium; risco geral é o maior entre os statements', () => {
    const f = 'V15__tipo.sql';
    const r = sw.detectSchemaChanges([f], newFileDiff(f,
        '-- ajuste\nCREATE TABLE log_x (id BIGINT);\nALTER TABLE cliente ALTER COLUMN nome TYPE VARCHAR(200);'));
    assert.deepStrictEqual(r.changes.map(c => c.type), ['ADD', 'ALTER']);
    assert.strictEqual(r.riskLevel, 'medium');
    assert.deepStrictEqual(sw.affectedTables(r.changes), ['cliente', 'log_x']);
});

test('comentário com DROP não conta como DROP', () => {
    const f = 'V16__x.sql';
    const r = sw.detectSchemaChanges([f], newFileDiff(f, '-- não vamos DROP nada\n/* DROP TABLE a; */\nCREATE INDEX ix_a ON a (b);'));
    assert.strictEqual(r.riskLevel, 'low');
});

test('migration Flyway existente editada -> high; removida -> DROP high', () => {
    const f = 'V3__old.sql';
    const edited = `diff --git a/${f} b/${f}\n--- a/${f}\n+++ b/${f}\n@@ -1 +1 @@\n-CREATE TABLE a (id INT);\n+CREATE TABLE a (id BIGINT);\n`;
    const r = sw.detectSchemaChanges([f], edited);
    assert.strictEqual(r.riskLevel, 'high');
    assert.ok(r.changes.some(c => /checksum/.test(c.detail)));

    const deleted = `diff --git a/${f} b/${f}\ndeleted file mode 100644\n--- a/${f}\n+++ /dev/null\n@@ -1 +0,0 @@\n-CREATE TABLE a (id INT);\n`;
    const d = sw.detectSchemaChanges([f], deleted);
    assert.strictEqual(d.changes[0].type, 'DROP');
});

test('projeto sem Flyway: JPA @Column adicionado -> low; name trocado -> RENAME high; removido -> DROP high', () => {
    const f = 'src/main/java/br/Cliente.java';
    const hdr = `diff --git a/${f} b/${f}\n--- a/${f}\n+++ b/${f}\n@@ -10,3 +10,4 @@ public class Cliente {\n`;
    const add = sw.detectSchemaChanges([f], hdr + '+    @Column(name = "ds_apelido")\n+    private String apelido;\n');
    assert.strictEqual(add.riskLevel, 'low');
    assert.strictEqual(add.changes[0].table, 'Cliente (entidade)');

    const ren = sw.detectSchemaChanges([f], hdr + '-    @Column(name = "nome")\n+    @Column(name = "nm_cliente")\n');
    assert.strictEqual(ren.changes[0].type, 'RENAME');
    assert.strictEqual(ren.riskLevel, 'high');

    const alt = sw.detectSchemaChanges([f], hdr + '-    @Column(name = "nome", length = 50)\n+    @Column(name = "nome", length = 200)\n');
    assert.strictEqual(alt.riskLevel, 'medium');

    const drop = sw.detectSchemaChanges([f], hdr + '-    @Column(name = "nome")\n-    private String nome;\n');
    assert.strictEqual(drop.riskLevel, 'high');
});

test('@Table(name) vira a tabela afetada', () => {
    const f = 'src/main/java/br/Pedido.java';
    const r = sw.detectSchemaChanges([f], newFileDiff(f, '@Entity\n@Table(name = "tb_pedido")\npublic class Pedido {}'));
    assert.deepStrictEqual(sw.affectedTables(r.changes), ['tb_pedido']);
});

test('persistence.xml alterado -> detectado; drop-and-create -> high', () => {
    const f = 'src/main/resources/META-INF/persistence.xml';
    assert.strictEqual(sw.detectSchemaChanges([f], '').riskLevel, 'medium');
    const r = sw.detectSchemaChanges([f], newFileDiff(f,
        '<property name="jakarta.persistence.schema-generation.database.action" value="drop-and-create"/>'));
    assert.strictEqual(r.riskLevel, 'high');
});

test('sem mudança de schema (java sem anotação JPA, sql fora do padrão Flyway, md) -> não detecta', () => {
    const j = 'src/main/java/br/Service.java';
    const r = sw.detectSchemaChanges([j, 'scripts/sql/relatorio.sql', 'docs/x.md'],
        `diff --git a/${j} b/${j}\n--- a/${j}\n+++ b/${j}\n@@ -1 +1 @@\n-int a = 1;\n+int a = 2;\n`);
    assert.deepStrictEqual(r, { detected: false, changes: [], riskLevel: 'low' });
    assert.strictEqual(sw.detectSchemaChanges([], '').detected, false);
});

// --- checklist / context.md ----------------------------------------------------

test('template real: todos os placeholders preenchidos e seções presentes', () => {
    const f = 'V12__add_column_cliente.sql';
    const out = sw.renderMigrationChecklist(sw.detectSchemaChanges([f], newFileDiff(f, 'ALTER TABLE cliente ADD COLUMN x INT;')));
    assert.doesNotMatch(out, /\{\{\w+\}\}/);
    for (const s of ['## ⚠️ Schema Migration Checklist', '### Mudanças detectadas', '### Rollback script',
        '### Validação em homologação', '### Comunicação DBA', '### Janela de manutenção']) {
        assert.ok(out.includes(s), s);
    }
    assert.match(out, /`cliente`/);
    assert.match(out, /DROP COLUMN/);
});

test('upsertContextChecklist: append, idempotente (preserva checkbox marcado), regenera se mudar, remove sem schema', () => {
    const f = 'V12__add_column_cliente.sql';
    const r1 = sw.detectSchemaChanges([f], newFileDiff(f, 'ALTER TABLE cliente ADD COLUMN x INT;'));
    const t1 = sw.upsertContextChecklist('# Contexto\n\nalgo', r1);
    assert.ok(t1.startsWith('# Contexto\n\nalgo\n\n'));
    assert.ok(t1.includes('## ⚠️ Schema Migration Checklist'));

    const marked = t1.replace('- [ ] DBA avisado', '- [x] DBA avisado');
    assert.strictEqual(sw.upsertContextChecklist(marked, r1), marked);

    const r2 = sw.detectSchemaChanges([f], newFileDiff(f, 'ALTER TABLE cliente DROP COLUMN x;'));
    const t2 = sw.upsertContextChecklist(marked, r2);
    assert.match(t2, /🔴 high/);
    assert.strictEqual(t2.split(sw.CONTEXT_BEGIN).length, 2);

    const none = sw.detectSchemaChanges([], '');
    assert.strictEqual(sw.upsertContextChecklist(t2, none).trim(), '# Contexto\n\nalgo');
    assert.strictEqual(sw.upsertContextChecklist('# Contexto', none), '# Contexto');
});

// --- integração com o watcher ----------------------------------------------------

function git(cwd, ...args) {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function makeWorktree(name) {
    const wt = path.join(tmp, name);
    fs.mkdirSync(path.join(wt, 'src/main/resources/db/migration'), { recursive: true });
    git(wt, 'init', '-q', '-b', 'development');
    git(wt, 'config', 'user.email', 't@t'); git(wt, 'config', 'user.name', 't');
    fs.writeFileSync(path.join(wt, 'README.md'), 'x\n');
    fs.writeFileSync(path.join(wt, '.gitignore'), 'memory/\n');
    git(wt, 'add', '.'); git(wt, 'commit', '-qm', 'base');
    const dir = path.join(wt, 'memory/runs/99999-x');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'context.md'), '# Contexto da task\n');
    return { wt, dir };
}

test('watcher: V12__add_column_cliente.sql untracked no worktree -> checklist no context.md', () => {
    const { wt, dir } = makeWorktree('wt-schema');
    fs.writeFileSync(path.join(wt, 'src/main/resources/db/migration/V12__add_column_cliente.sql'),
        'ALTER TABLE cliente ADD COLUMN ds_apelido VARCHAR(100);\n');
    const r = watcher.stampSchemaChecklist('99999-x', dir, wt, 'development');
    assert.strictEqual(r.detected, true);
    const ctx = fs.readFileSync(path.join(dir, 'context.md'), 'utf8');
    assert.ok(ctx.startsWith('# Contexto da task\n'));
    assert.ok(ctx.includes('## ⚠️ Schema Migration Checklist'));
    assert.ok(ctx.includes('V12__add_column_cliente.sql'));
    assert.match(watcher.schemaChecklistNote(r), /MUDANÇA DE SCHEMA \(risco low\)/);
});

test('watcher: migration commitada com RENAME -> high', () => {
    const { wt, dir } = makeWorktree('wt-rename');
    fs.writeFileSync(path.join(wt, 'src/main/resources/db/migration/V13__rename.sql'),
        'ALTER TABLE cliente RENAME COLUMN nome TO nm_cliente;\n');
    git(wt, 'checkout', '-qb', '99999'); git(wt, 'add', '.'); git(wt, 'commit', '-qm', 'mig');
    const r = watcher.stampSchemaChecklist('99999-x', dir, wt, 'development');
    assert.strictEqual(r.riskLevel, 'high');
    assert.match(fs.readFileSync(path.join(dir, 'context.md'), 'utf8'), /🔴 high/);
});

test('watcher: ciclo sem mudança de schema não toca o context.md', () => {
    const { wt, dir } = makeWorktree('wt-none');
    fs.writeFileSync(path.join(wt, 'Service.java'), 'class Service { int a = 1; }\n');
    const before = fs.readFileSync(path.join(dir, 'context.md'), 'utf8');
    const r = watcher.stampSchemaChecklist('99999-x', dir, wt, 'development');
    assert.strictEqual(r.detected, false);
    assert.strictEqual(fs.readFileSync(path.join(dir, 'context.md'), 'utf8'), before);
    assert.strictEqual(watcher.schemaChecklistNote(r), '');
});

test('watcher: falha de git não derruba o despacho (sem checklist, sem exceção)', () => {
    const dir = path.join(tmp, 'no-git');
    fs.mkdirSync(dir, { recursive: true });
    const r = watcher.stampSchemaChecklist('99999-x', dir, dir, 'development');
    assert.strictEqual(r.detected, false);
    assert.strictEqual(fs.existsSync(path.join(dir, 'context.md')), false);
});

test('watcher: grava schema_changes_detected/schema_risk_level no state.json (e zera quando some)', () => {
    const { wt, dir } = makeWorktree('wt-state');
    const statePath = path.join(dir, 'state.json');
    fs.writeFileSync(statePath, JSON.stringify({ task_id: '99999-x', node: 'review', history: ['plan'], status: 'in_progress', affectedServices: [] }));
    const mig = path.join(wt, 'src/main/resources/db/migration/V20__drop.sql');
    fs.writeFileSync(mig, 'ALTER TABLE cliente DROP COLUMN x;\n');
    watcher.stampSchemaChecklist('99999-x', dir, wt, 'development');
    let st = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    assert.strictEqual(st.schema_changes_detected, true);
    assert.strictEqual(st.schema_risk_level, 'high');
    assert.deepStrictEqual(st.affectedServices, [], 'preserva os outros campos');

    fs.unlinkSync(mig);
    watcher.stampSchemaChecklist('99999-x', dir, wt, 'development');
    st = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    assert.strictEqual(st.schema_changes_detected, false);
    assert.strictEqual(st.schema_risk_level, null);
    assert.doesNotMatch(fs.readFileSync(path.join(dir, 'context.md'), 'utf8'), /Schema Migration Checklist/);
});

test('extractContextChecklist: lê de volta o bloco gravado (markdown sem marcadores + signature)', () => {
    const f = 'V12__a.sql';
    const r = sw.detectSchemaChanges([f], newFileDiff(f, 'CREATE TABLE a (id INT);'));
    const back = sw.extractContextChecklist(sw.upsertContextChecklist('# C', r));
    assert.strictEqual(back.signature, sw.signatureOf(r));
    assert.match(back.markdown, /^## ⚠️ Schema Migration Checklist/);
    assert.doesNotMatch(back.markdown, /schema-watcher:/);
    assert.strictEqual(sw.extractContextChecklist('# nada'), null);
});
