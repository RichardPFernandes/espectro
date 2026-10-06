// node --test scripts/lib/service-detector.test.js
// Escopo de teste por microsserviço: unidade do detector e integração com o watcher
// (dispatchTicket no nó test) contra um REPO_PATH sintético com git de verdade, fetch
// stubado e um binário `claude` falso no PATH.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const tmp = fs.mkdtempSync(path.join(process.env.CLAUDE_JOB_DIR ? path.join(process.env.CLAUDE_JOB_DIR, 'tmp') : os.tmpdir(), 'service-detector-'));
const repo = path.join(tmp, 'app-back');
const binDir = path.join(tmp, 'bin');
const claudeCalls = path.join(tmp, 'claude-calls.log');
const claudeEnv = path.join(tmp, 'claude-env.log');
fs.mkdirSync(repo, { recursive: true });
fs.mkdirSync(binDir);
fs.writeFileSync(path.join(binDir, 'claude'),
    `#!/bin/sh\nprintf '%s\\n' "$*" >> '${claudeCalls}'\nprintf 'AFFECTED_SERVICES=%s\\n' "$AFFECTED_SERVICES" >> '${claudeEnv}'\n`, { mode: 0o755 });
fs.writeFileSync(path.join(binDir, 'osascript'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
process.env.REPO_PATH = repo;
// Portão de build pré-implement roda mvn de verdade — coberto em build-validator.test.js.
process.env.SKIP_PRE_BUILD_VALIDATION = 'true';
// Comandos Maven são config deste consumidor de teste, não default da plataforma.
process.env.TEST_COMMAND = 'mvn test';
process.env.TEST_SCOPED_COMMAND = 'mvn test -pl {services}';
process.env.REDMINE_URL = 'http://redmine.test';
process.env.REDMINE_API_KEY = 'k';
process.env.PATH = `${binDir}:${process.env.PATH}`;
global.fetch = async () => ({ ok: true, status: 204, json: async () => ({}) });

const { detectAffectedServices, analyzeChangedFiles, testCommandFor } = require('./service-detector');
const watcher = require('../readmine-watcher');
const { validateState } = require('../validate-state');

// --- unidade -------------------------------------------------------------------

test('só arquivos de backend/ms-pedidos/ (main e test) -> backend/ms-pedidos, deduplicado', () => {
    const files = [
        'backend/ms-pedidos/src/main/java/br/Pedido.java',
        'backend/ms-pedidos/src/test/java/br/PedidoTest.java',
        './backend/ms-pedidos/pom.xml',
    ];
    assert.deepStrictEqual(detectAffectedServices(files), ['backend/ms-pedidos']);
    assert.strictEqual(testCommandFor(detectAffectedServices(files)), 'mvn test -pl backend/ms-pedidos');
});

test('vários serviços -> lista ordenada e sem duplicatas', () => {
    const files = [
        'backend/ms-estoque/src/main/java/A.java',
        'backend/ms-pedidos/src/main/java/B.java',
        'backend/ms-estoque/src/test/java/ATest.java',
        'backend\\ms-frete\\src\\main\\java\\C.java',
    ];
    assert.deepStrictEqual(detectAffectedServices(files), ['backend/ms-estoque', 'backend/ms-frete', 'backend/ms-pedidos']);
    assert.strictEqual(testCommandFor(detectAffectedServices(files)), 'mvn test -pl backend/ms-estoque,backend/ms-frete,backend/ms-pedidos');
});

test('changedFiles vazio/ausente -> suíte completa (retrocompatível)', () => {
    for (const v of [[], undefined, null, ['', '  ']]) {
        assert.deepStrictEqual(detectAffectedServices(v), []);
        assert.strictEqual(analyzeChangedFiles(v).reason, 'sem_arquivos_alterados');
    }
    assert.strictEqual(testCommandFor([]), 'mvn test');
});

test('sem TEST_COMMAND do consumidor, o detector não inventa mvn', () => {
    assert.strictEqual(testCommandFor(['backend/ms-pedidos'], {}), null);
    assert.strictEqual(testCommandFor([], {}), null);
});

test('arquivo raiz ou de configuração junto com serviço -> suíte completa', () => {
    const svc = 'backend/ms-pedidos/src/main/java/A.java';
    for (const other of ['pom.xml', 'backend/pom.xml', '.mvn/wrapper/maven-wrapper.properties', 'Dockerfile',
        'src/main/resources/application.properties', 'bitbucket-pipelines.yml', 'backend/README']) {
        const r = analyzeChangedFiles([svc, other]);
        assert.deepStrictEqual(r.services, [], other);
        assert.strictEqual(r.fullSuite, true, other);
        assert.deepStrictEqual(r.fullSuiteTriggers, [other]);
    }
});

test('arquivos de orquestração/docs não derrubam o escopo nem sozinhos reduzem', () => {
    const svc = 'backend/ms-pedidos/src/main/java/A.java';
    const noise = ['memory/runs/1-x/state.json', 'docs/nota.md', '.graph/graph.yaml', 'scripts/readmine-watcher.js',
        'dashboard/server.js', 'backend/ms-pedidos/README.md', '.DS_Store', 'backend/.DS_Store'];
    assert.deepStrictEqual(detectAffectedServices([svc, ...noise]), ['backend/ms-pedidos']);
    const onlyNoise = analyzeChangedFiles(noise);
    assert.deepStrictEqual(onlyNoise.services, []);
    assert.strictEqual(onlyNoise.reason, 'nenhum_servico_tocado');
});

// --- integração com o watcher --------------------------------------------------

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const write = (root, rel, content = 'x\n') => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), content);
};

// Repo com branch development e um worktree do ticket em .claude/worktrees/<id>.
function seedTicket(id, changes) {
    const r = path.join(tmp, `repo-${id}`);
    fs.mkdirSync(r);
    git(r, 'init', '-q', '-b', 'development');
    git(r, 'config', 'user.email', 't@t'); git(r, 'config', 'user.name', 't');
    write(r, 'pom.xml', '<project/>\n');
    write(r, 'backend/ms-pedidos/src/main/java/A.java', 'class A {}\n');
    git(r, 'add', '.'); git(r, 'commit', '-qm', 'base');
    const wt = path.join(repo, '.claude', 'worktrees', String(id));
    git(r, 'worktree', 'add', '-q', '-b', String(id), wt);
    for (const f of changes.committed || []) write(wt, f, `// ${id}\n`);
    if ((changes.committed || []).length) { git(wt, 'add', '.'); git(wt, 'commit', '-qm', 'impl'); }
    for (const f of changes.dirty || []) write(wt, f, `// dirty ${id}\n`);
    const taskId = `${id}-teste`;
    const dir = path.join(wt, 'memory', 'runs', taskId);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({
        task_id: taskId, node: 'test', history: ['fetch_ticket', 'plan', 'implement', 'review'], status: 'in_progress',
        started_at: new Date().toISOString(),
    }));
    fs.writeFileSync(path.join(dir, 'context.md'), '# Contexto\n');
    return { taskId, dir };
}

function ticket(id) {
    return {
        id, subject: `Ticket ${id}`, description: '', status: { name: 'Em Desenvolvimento' }, tracker: { name: 'Melhoria' },
        custom_fields: [{ name: 'Branch Liberação', value: 'Dev - Local' }], updated_on: new Date().toISOString(),
    };
}

async function waitFor(fn) {
    for (let i = 0; i < 100; i++) {
        if (fn()) return true;
        await new Promise(r => setTimeout(r, 50));
    }
    return false;
}

const read = dir => JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'));
const lastLine = f => fs.readFileSync(f, 'utf8').trim().split('\n').at(-1);

async function dispatchAndCapture(id) {
    const before = fs.existsSync(claudeCalls) ? fs.readFileSync(claudeCalls, 'utf8').length : 0;
    const logs = [];
    const orig = console.log;
    console.log = (...a) => { logs.push(a.join(' ')); };
    let res;
    try { res = await watcher.dispatchTicket(ticket(id)); } finally { console.log = orig; }
    assert.ok(await waitFor(() => fs.existsSync(claudeCalls) && fs.readFileSync(claudeCalls, 'utf8').length > before), 'claude despachado');
    await new Promise(r => setTimeout(r, 100));
    return { res, prompt: fs.readFileSync(claudeCalls, 'utf8').slice(before), env: lastLine(claudeEnv), logs };
}

test('dispatch do nó test com diff só em backend/ms-pedidos -> -pl backend/ms-pedidos + affectedServices no state', async () => {
    const { dir } = seedTicket(93001, {
        committed: ['backend/ms-pedidos/src/main/java/B.java'],
        dirty: ['backend/ms-pedidos/src/test/java/BTest.java'],
    });
    const { res, prompt, env, logs } = await dispatchAndCapture(93001);
    assert.strictEqual(res.node, 'test');
    assert.match(prompt, /AFFECTED_SERVICES=backend\/ms-pedidos/);
    assert.match(prompt, /mvn test -pl backend\/ms-pedidos`/);
    assert.strictEqual(env, 'AFFECTED_SERVICES=backend/ms-pedidos');
    assert.ok(logs.some(l => /\[test-scope\].*escopo reduzido.*backend\/ms-pedidos/.test(l)), logs.join('\n'));
    const s = read(dir);
    assert.deepStrictEqual(s.affectedServices, ['backend/ms-pedidos']);
    assert.strictEqual(validateState(s).valid, true);
});

test('dispatch do nó test com arquivo raiz no diff -> suíte completa, affectedServices []', async () => {
    const { dir } = seedTicket(93002, { committed: ['backend/ms-pedidos/src/main/java/B.java', 'pom.xml'] });
    const { prompt, env, logs } = await dispatchAndCapture(93002);
    assert.match(prompt, /rode a suíte completa \(`mvn test`\)/);
    assert.doesNotMatch(prompt, /-pl /);
    assert.strictEqual(env, 'AFFECTED_SERVICES=');
    assert.ok(logs.some(l => /\[test-scope\].*suíte completa.*pom\.xml/.test(l)), logs.join('\n'));
    assert.deepStrictEqual(read(dir).affectedServices, []);
});

test('dispatch do nó test sem código alterado (só memory/) -> suíte completa', async () => {
    const { dir } = seedTicket(93003, {});
    const { prompt, logs } = await dispatchAndCapture(93003);
    assert.match(prompt, /rode a suíte completa/);
    assert.ok(logs.some(l => /suíte completa \(nenhum microsserviço tocado/.test(l)), logs.join('\n'));
    assert.deepStrictEqual(read(dir).affectedServices, []);
});

test('nós fora do escopo de teste (implement) não calculam nem gravam affectedServices', async () => {
    const { dir } = seedTicket(93004, { committed: ['backend/ms-pedidos/src/main/java/B.java'] });
    fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ ...read(dir), node: 'implement' }));
    const { prompt, env } = await dispatchAndCapture(93004);
    assert.doesNotMatch(prompt, /AFFECTED_SERVICES/);
    assert.strictEqual(env, 'AFFECTED_SERVICES=');
    assert.strictEqual(read(dir).affectedServices, undefined);
});

test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
