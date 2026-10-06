// node --test scripts/lib/ac-registry.test.js
// Registro de Critérios de Aceite: extração, upsert atômico, rebuild a partir das specs,
// predecessoras no grafo e a varredura do watcher (REPO_PATH sintético).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(process.env.CLAUDE_JOB_DIR ? path.join(process.env.CLAUDE_JOB_DIR, 'tmp') : os.tmpdir(), 'ac-registry-'));
const repo = path.join(tmp, 'app-back');
fs.mkdirSync(repo, { recursive: true });
process.env.REPO_PATH = repo;
// Portão de build pré-implement roda mvn de verdade — coberto em build-validator.test.js.
process.env.SKIP_PRE_BUILD_VALIDATION = 'true';
process.env.REDMINE_URL = 'http://redmine.test';
process.env.REDMINE_API_KEY = 'k';

const acRegistry = require('./ac-registry');
const { rebuild } = require('../rebuild-ac-registry');
const watcher = require('../readmine-watcher');

function spec(criteria, extra = '') {
    return [
        '# Spec',
        '## Contexto',
        'Situação atual.',
        '## Critérios de aceite',
        ...criteria.map(c => `- [ ] ${c}`),
        '',
        extra,
        '## Observações',
        '- não é critério',
    ].join('\n');
}

let n = 0;
function freshDir(name) {
    const d = path.join(tmp, `${name}-${++n}`);
    fs.mkdirSync(d, { recursive: true });
    return d;
}

test('extractACs: checkbox, continuação indentada, lista numerada e fim da seção', () => {
    const content = [
        '## Critérios de Aceite (QA)',
        '<!-- instrução do template -->',
        '- [x] Primeiro critério quebrado',
        '      em duas linhas.',
        '* Segundo',
        '1. Terceiro numerado',
        '2) Quarto',
        '',
        'Parágrafo solto não é item.',
        '## Solução',
        '- fora da seção',
    ].join('\r\n');
    const r = acRegistry.extractACs(content, '123');
    assert.strictEqual(r.taskId, '123');
    assert.deepStrictEqual(r.criteria, ['Primeiro critério quebrado em duas linhas.', 'Segundo', 'Terceiro numerado', 'Quarto']);
    assert.ok(!Number.isNaN(Date.parse(r.extractedAt)));
});

test('extractACs: cabeçalho ### / Textile / sem acento; spec sem seção devolve []', () => {
    assert.deepStrictEqual(acRegistry.extractACs('### Criterio de aceite\n- a\n- b', 'x').criteria, ['a', 'b']);
    assert.deepStrictEqual(acRegistry.extractACs('h2. Critérios de Aceite\n\n- a', 'x').criteria, ['a']);
    assert.deepStrictEqual(acRegistry.extractACs('## Contexto\n- a', 'x').criteria, []);
});

test('extractDependencies: ids #NNN da seção Dependências, sem o próprio id', () => {
    const c = '## Dependências\n- depende de #43509 e #41948\n- ver #43511\n## Outra\n- #99999';
    assert.deepStrictEqual(acRegistry.extractDependencies(c, '43511'), ['43509', '41948']);
    assert.deepStrictEqual(acRegistry.extractDependencies('## Contexto\n#1234'), []);
});

test('updateRegistry: upsert com schema esperado, idempotente, sem .tmp sobrando', () => {
    const dir = freshDir('upsert');
    const registryPath = path.join(dir, 'ac-registry.json');
    const content = spec(['a', 'b']);

    const first = acRegistry.updateRegistry('task-1', ['a', 'b'], { registryPath, specContent: content });
    assert.strictEqual(first.changed, true);
    const reg = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
    assert.strictEqual(reg.version, 2);
    assert.ok(Date.parse(reg.updatedAt));
    // Spec sem IDs (array de critérios, API v1): entrada legada, com o texto.
    assert.strictEqual(reg.tasks['task-1'].ticket_id, 'task-1');
    assert.deepStrictEqual(reg.tasks['task-1'].ac_ids, []);
    assert.strictEqual(reg.tasks['task-1'].legacy, true);
    assert.deepStrictEqual(reg.tasks['task-1'].criteria, ['a', 'b']);
    assert.strictEqual(reg.tasks['task-1'].spec_hash, acRegistry.specHash(content));
    assert.match(reg.tasks['task-1'].spec_hash, /^[0-9a-f]{64}$/);
    assert.ok(Date.parse(reg.tasks['task-1'].indexedAt));

    assert.strictEqual(acRegistry.updateRegistry('task-1', ['a', 'b'], { registryPath, specContent: content }).changed, false);
    acRegistry.updateRegistry('task-2', ['c'], { registryPath, specContent: 'x' });
    acRegistry.updateRegistry('task-1', ['a'], { registryPath, specContent: spec(['a']) });
    const after = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
    assert.deepStrictEqual(Object.keys(after.tasks).sort(), ['task-1', 'task-2']);
    assert.deepStrictEqual(after.tasks['task-1'].criteria, ['a']);
    assert.deepStrictEqual(fs.readdirSync(dir), ['ac-registry.json']);
});

test('updateRegistry: registro com JSON inválido não é sobrescrito', () => {
    const dir = freshDir('corrupt');
    const registryPath = path.join(dir, 'ac-registry.json');
    fs.writeFileSync(registryPath, '{ quebrado');
    assert.throws(() => acRegistry.updateRegistry('t', ['a'], { registryPath }));
    assert.strictEqual(fs.readFileSync(registryPath, 'utf8'), '{ quebrado');
});

test('rebuild: 10 specs → 10 tasks indexadas; reporta sem ACs, alterados e removidos; não altera specs', () => {
    const specsDir = freshDir('specs');
    const registryPath = path.join(freshDir('reg'), 'ac-registry.json');
    for (let i = 1; i <= 10; i++) {
        fs.writeFileSync(path.join(specsDir, `${4000 + i}-spec.md`), i === 7 ? '## Contexto\nsem ACs' : spec([`critério ${i}.1`, `critério ${i}.2`]));
    }
    fs.writeFileSync(path.join(specsDir, '00-overview.md'), spec(['não é task']));
    const before = Object.fromEntries(fs.readdirSync(specsDir).map(f => [f, fs.readFileSync(path.join(specsDir, f), 'utf8')]));

    const { report } = rebuild({ specsDir, registryPath });
    const reg = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
    assert.strictEqual(Object.keys(reg.tasks).length, 10);
    assert.strictEqual(report.indexed.length, 10);
    assert.deepStrictEqual(report.withoutACs, ['4007']);
    assert.deepStrictEqual(reg.tasks['4003'].criteria, ['critério 3.1', 'critério 3.2']);
    assert.strictEqual(report.added.length, 10);

    fs.writeFileSync(path.join(specsDir, '4003-spec.md'), spec(['critério 3.1', 'critério 3.X']));
    fs.unlinkSync(path.join(specsDir, '4010-spec.md'));
    const second = rebuild({ specsDir, registryPath }).report;
    assert.deepStrictEqual(second.changed, [{ taskId: '4003', added: ['critério 3.X'], removed: ['critério 3.2'] }]);
    assert.deepStrictEqual(second.removed, ['4010']);
    assert.strictEqual(second.added.length, 0);

    for (const [f, c] of Object.entries(before)) {
        if (f === '4003-spec.md' || f === '4010-spec.md') continue;
        assert.strictEqual(fs.readFileSync(path.join(specsDir, f), 'utf8'), c);
    }
});

test('rebuild --dry-run não grava', () => {
    const specsDir = freshDir('specs-dry');
    fs.writeFileSync(path.join(specsDir, '1-spec.md'), spec(['a']));
    const registryPath = path.join(freshDir('reg-dry'), 'ac-registry.json');
    rebuild({ specsDir, registryPath, dryRun: true });
    assert.strictEqual(fs.existsSync(registryPath), false);
});

test('getRelatedACs: predecessoras diretas e transitivas, ciclo tolerado, formatos de grafo', () => {
    const registry = {
        version: 1, updatedAt: null,
        tasks: {
            A: { criteria: ['a1'], dependsOn: [] },
            B: { criteria: ['b1', 'b2'], dependsOn: ['A'] },
            C: { criteria: ['c1'], dependsOn: ['B', 'D'] },
            E: { criteria: ['e1'], dependsOn: ['C'] },
        },
    };
    // D não está no registro; A↔C forma ciclo via edges extras.
    const related = acRegistry.getRelatedACs('C', registry, { registry });
    assert.deepStrictEqual(related, [
        { taskId: 'B', depth: 1, indexed: true, ac_ids: [], criteria: ['b1', 'b2'] },
        { taskId: 'D', depth: 1, indexed: false, ac_ids: [], criteria: [] },
        { taskId: 'A', depth: 2, indexed: true, ac_ids: [], criteria: ['a1'] },
    ]);
    // Sucessora (E) não entra: só predecessoras.
    assert.ok(!related.some(r => r.taskId === 'E'));

    const edges = { edges: [{ from: 'A', to: 'B' }, { from: 'B', to: 'A' }] };
    assert.deepStrictEqual(acRegistry.getRelatedACs('B', edges, { registry }).map(r => r.taskId), ['A']);
    assert.deepStrictEqual(acRegistry.getRelatedACs('#B', { B: ['#A'] }, { registry }).map(r => r.criteria), [['a1']]);
    assert.deepStrictEqual(acRegistry.getRelatedACs('A', null, { registry }), []);
});

function seedTask(ticketId, taskId, status, { archived = false, specContent = null, updatedAt } = {}) {
    const root = path.join(repo, '.claude', 'worktrees', String(ticketId));
    const runs = path.join(root, 'memory', 'runs', ...(archived ? ['_archive'] : []), taskId);
    fs.mkdirSync(runs, { recursive: true });
    fs.writeFileSync(path.join(runs, 'state.json'), JSON.stringify({
        task_id: taskId, node: 'commit', history: ['plan', 'commit'], status,
        started_at: '2026-09-01T00:00:00Z', updated_at: updatedAt || new Date().toISOString(),
    }));
    if (specContent != null) {
        fs.mkdirSync(path.join(root, 'memory', 'spec'), { recursive: true });
        fs.writeFileSync(path.join(root, 'memory', 'spec', `${ticketId}-spec.md`), specContent);
    }
    return runs;
}

test('watcher: ciclo concluído entra no registro com os ACs da spec; idempotente', () => {
    seedTask(7001, '7001-feito', 'committed', { archived: true, specContent: spec(['entrega ok', 'sem regressão'], '## Dependências\n- #7002') });
    seedTask(7002, '7002-legado', 'completed', { specContent: spec(['legado']) });
    seedTask(7003, '7003-andando', 'in_progress', { specContent: spec(['ainda não']) });
    // Ciclo novo (Recusa QA) em andamento sobre ticket já commitado: não reindexa.
    seedTask(7004, '7004-antigo', 'committed', { archived: true, specContent: spec(['v1']) });
    seedTask(7004, '7004-recusa', 'in_progress');

    const s1 = watcher.syncAcRegistry();
    assert.deepStrictEqual(s1.indexed.sort(), ['7001', '7002']);
    const reg = JSON.parse(fs.readFileSync(watcher.AC_REGISTRY_PATH, 'utf8'));
    assert.deepStrictEqual(reg.tasks['7001'].criteria, ['entrega ok', 'sem regressão']);
    assert.deepStrictEqual(reg.tasks['7001'].dependsOn, ['7002']);
    assert.strictEqual(reg.tasks['7001'].lastRunTaskId, '7001-feito');
    assert.ok(!reg.tasks['7003'] && !reg.tasks['7004']);

    assert.deepStrictEqual(acRegistry.getRelatedACs('7001', reg, { registry: reg }).map(r => r.criteria), [['legado']]);

    const s2 = watcher.syncAcRegistry();
    assert.deepStrictEqual(s2.indexed, []);
    assert.strictEqual(s2.unchanged, 2);

    // Spec editada depois (commit seguinte) → reindexa.
    fs.writeFileSync(path.join(repo, '.claude', 'worktrees', '7002', 'memory', 'spec', '7002-spec.md'), spec(['legado', 'novo']));
    assert.deepStrictEqual(watcher.syncAcRegistry().indexed, ['7002']);
});

test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
