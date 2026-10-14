// node --test scripts/lib/knowledge-graph.test.js
// Knowledge Graph de rastreabilidade: merge append-only, lock, anotação @spec, CLI do
// /commit, varredura do watcher e scripts/trace.js — contra repos git sintéticos
// (app-back + app-core + app-front, cada um com worktree do ticket), sem tocar nos reais.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(process.env.CLAUDE_JOB_DIR ? path.join(process.env.CLAUDE_JOB_DIR, 'tmp') : os.tmpdir(), 'kg-')));
const repo = path.join(tmp, 'app-back');
process.env.REPO_PATH = repo;
process.env.WATCHER_MAIN_REPO_NAME = 'app-back';
process.env.WATCHER_SIBLING_REPOS = 'app-core,app-front';
process.env.SKIP_PRE_BUILD_VALIDATION = 'true';
process.env.REDMINE_URL = 'http://redmine.test';
process.env.REDMINE_API_KEY = 'k';
delete process.env.KNOWLEDGE_GRAPH_PATH;

const kg = require('./knowledge-graph');
const { trace, format } = require('../trace');

const TICKET = '90010';
const TASK = `${TICKET}-rastreio`;
const graphPath = path.join(repo, 'memory', 'knowledge-graph.json');
const wt = r => path.join(tmp, r, '.claude', 'worktrees', TICKET);

function git(cwd, ...args) {
    return execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args],
        { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}
const javaLines = (n, tag = 'x') => Array.from({ length: n }, (_, i) => `    int ${tag}${i} = ${i};`).join('\n');
const javaClass = (name, body = '') => `package br.com.t;\n\npublic class ${name} {\n${body}\n}\n`;
function write(root, rel, content) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), content);
}

// Repo com branch development + worktree do ticket.
function makeRepo(name, files) {
    const dir = path.join(tmp, name);
    fs.mkdirSync(dir, { recursive: true });
    git(dir, 'init', '-q', '-b', 'development');
    write(dir, '.gitignore', 'memory/\n.claude/\n');
    for (const [rel, content] of Object.entries(files)) write(dir, rel, content);
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', `${name === 'app-back' ? '90005 - Ajuste antigo' : 'base'}`);
    git(dir, 'worktree', 'add', '-q', '-b', TICKET, path.join('.claude', 'worktrees', TICKET), 'development');
    return dir;
}

const J = 'src/main/java/br/com/t';
makeRepo('app-back', {
    [`${J}/Big.java`]: javaClass('Big'),
    [`${J}/Small.java`]: javaClass('Small'),
    [`${J}/Tagged.java`]: `// @spec memory/spec/80000-spec.md | redmine:#80000 | pr:PR-app-back-1\n${javaClass('Tagged')}`,
    'src/main/resources/config.xml': '<a/>\n',
});
makeRepo('app-core', { [`${J}/Core.java`]: javaClass('Core') });
makeRepo('app-front', { [`${J}/Front.java`]: javaClass('Front') });

// Mudanças da branch do ticket.
write(wt('app-back'), `${J}/Big.java`, javaClass('Big', javaLines(25)));
write(wt('app-back'), `${J}/Small.java`, javaClass('Small', javaLines(2)));
write(wt('app-back'), `${J}/Tagged.java`, `// @spec memory/spec/80000-spec.md | redmine:#80000 | pr:PR-app-back-1\n${javaClass('Tagged', javaLines(30))}`);
write(wt('app-back'), `${J}/Novo.java`, javaClass('Novo'));
write(wt('app-back'), 'src/main/resources/config.xml', `<a>${'<b/>\n'.repeat(40)}</a>\n`);
git(wt('app-back'), 'add', `${J}/Big.java`);
git(wt('app-back'), 'commit', '-q', '-m', `${TICKET} - Big`);
write(wt('app-core'), `${J}/Core.java`, javaClass('Core', javaLines(30)));
write(wt('app-core'), 'jacoco.exec', 'bin'); // artefato de build: não é arquivo tocado
write(wt('app-back'), 'app/images/CTe.png', 'png');
write(wt('app-front'), `${J}/Front.java`, javaClass('Front', javaLines(30))); // sem PR nesse repo

const prUrl = n => `https://bitbucket.org/mosistemas/app-back/pull-requests/${n}`;
const state = {
    task_id: TASK, node: 'commit', history: ['fetch_ticket', 'plan', 'implement', 'review', 'test', 'verify'],
    status: 'in_progress', started_at: '2026-09-20T10:00:00Z', updated_at: '2026-09-20T12:00:00Z',
    redmine_ticket: { id: Number(TICKET), subject: 'Rastreio de frete', tracker: 'Melhoria', base_branch: 'development' },
    pull_request: {
        'app-back': { url: prUrl(891), opened_at: '2026-09-20T12:00:00Z' },
        'app-core': 'https://bitbucket.org/mosistemas/app-core/pull-requests/55',
    },
};
const taskDir = path.join(wt('app-back'), 'memory', 'runs', TASK);
fs.mkdirSync(taskDir, { recursive: true });
fs.writeFileSync(path.join(taskDir, 'state.json'), JSON.stringify(state, null, 2));
write(repo, `memory/spec/${TICKET}-spec.md`, '# Spec\n');

test('mergeFacts é append-only: acrescenta, atualiza atributo, nunca remove; aresta única', () => {
    const g = kg.emptyGraph();
    assert.strictEqual(kg.mergeFacts(g, { nodes: { A: { type: 'pr', status: 'open' } }, edges: [{ from: 'T', rel: 'opened_pr', to: 'A', at: 't1' }] }), true);
    assert.strictEqual(kg.mergeFacts(g, { nodes: { A: { type: 'pr', status: 'open' } }, edges: [{ from: 'T', rel: 'opened_pr', to: 'A', at: 't2' }] }), false);
    kg.mergeFacts(g, { nodes: { A: { type: 'pr', status: 'merged', url: null } }, edges: [] });
    assert.deepStrictEqual(g.nodes.A, { type: 'pr', status: 'merged' });
    kg.mergeFacts(g, { nodes: {}, edges: [] });
    assert.strictEqual(g.edges.length, 1);
    assert.strictEqual(g.edges[0].at, 't1'); // mantém o `at` da primeira vez
});

test('lock: ocupado por outro processo falha após 3 tentativas; lock velho é tomado', () => {
    const p = path.join(tmp, 'lock-test.json');
    fs.writeFileSync(`${p}.lock`, 'outro');
    const t0 = Date.now();
    assert.throws(() => kg.updateGraph(() => true, p), /lock ocupado/);
    assert.ok(Date.now() - t0 >= 2 * kg.LOCK_INTERVAL_MS - 5, 'esperou entre as tentativas');
    assert.ok(!fs.existsSync(p), 'não escreveu sem lock');
    const old = new Date(Date.now() - 60000);
    fs.utimesSync(`${p}.lock`, old, old);
    kg.updateGraph(g => kg.mergeFacts(g, { nodes: { X: { type: 'file' } } }), p);
    assert.ok(kg.readGraph(p).nodes.X);
    assert.ok(!fs.existsSync(`${p}.lock`), 'libera o lock');
});

test('insertSpecTag: topo, abaixo das @spec existentes, idempotente, preserva CRLF', () => {
    const tag = '// @spec memory/spec/1-spec.md | redmine:#1 | pr:PR-app-back-2';
    assert.strictEqual(kg.insertSpecTag('package a;\n', tag), `${tag}\npackage a;\n`);
    const prev = '// @spec memory/spec/0-spec.md | redmine:#0 | pr:PR-app-back-1';
    assert.strictEqual(kg.insertSpecTag(`${prev}\npackage a;\n`, tag), `${prev}\n${tag}\npackage a;\n`);
    assert.strictEqual(kg.insertSpecTag(`${prev}\n${tag}\npackage a;\n`, tag), null);
    assert.strictEqual(kg.insertSpecTag('package a;\r\nclass A {}\r\n', tag), `${tag}\r\npackage a;\r\nclass A {}\r\n`);
});

test('annotate: só .java criado ou >20 linhas, só em repo com PR; segunda rodada não repete', () => {
    const done = kg.annotateTask({ mainRepo: repo, taskId: TASK, state });
    const got = done.map(d => `${d.repo}:${path.basename(d.file)}`).sort();
    assert.deepStrictEqual(got, ['app-back:Big.java', 'app-back:Novo.java', 'app-back:Tagged.java', 'app-core:Core.java']);
    const big = fs.readFileSync(path.join(wt('app-back'), J, 'Big.java'), 'utf8');
    assert.ok(big.startsWith(`// @spec memory/spec/${TICKET}-spec.md | redmine:#${TICKET} | pr:PR-app-back-891\npackage`));
    const tagged = fs.readFileSync(path.join(wt('app-back'), J, 'Tagged.java'), 'utf8').split('\n');
    assert.match(tagged[0], /#80000/);
    assert.match(tagged[1], new RegExp(`#${TICKET} \\| pr:PR-app-back-891`));
    assert.match(fs.readFileSync(path.join(wt('app-core'), J, 'Core.java'), 'utf8'), /pr:PR-app-core-55/);
    assert.doesNotMatch(fs.readFileSync(path.join(wt('app-back'), J, 'Small.java'), 'utf8'), /@spec/);
    assert.doesNotMatch(fs.readFileSync(path.join(wt('app-front'), J, 'Front.java'), 'utf8'), /@spec/);
    assert.doesNotMatch(fs.readFileSync(path.join(wt('app-back'), 'src/main/resources/config.xml'), 'utf8'), /@spec/);
    assert.deepStrictEqual(kg.annotateTask({ mainRepo: repo, taskId: TASK, state }), []);
});

test('CLI record (do worktree): ticket, spec, PRs e arquivos tocados no KG do checkout principal', () => {
    const logs = [];
    const orig = console.log;
    console.log = m => logs.push(m);
    const cwd = process.cwd();
    try {
        process.chdir(wt('app-back'));
        assert.strictEqual(kg.main(['record', TASK]), 0);
    } finally { process.chdir(cwd); console.log = orig; }
    assert.match(logs.join('\n'), /atualizado/);
    const g = kg.readGraph(graphPath);
    const t = `TASK-${TICKET}`;
    assert.deepStrictEqual(g.nodes[t], { type: 'ticket', ticket_id: 90010, title: 'Rastreio de frete', tracker: 'Melhoria', redmine_url: `http://redmine.test/issues/${TICKET}` });
    assert.strictEqual(g.nodes[`memory/spec/${TICKET}-spec.md`].type, 'spec');
    assert.strictEqual(g.nodes['PR-app-back-891'].url, prUrl(891));
    assert.strictEqual(g.nodes['PR-app-core-55'].repo, 'app-core');
    for (const f of [`${J}/Big.java`, `${J}/Novo.java`, 'src/main/resources/config.xml', `app-core/${J}/Core.java`, `app-front/${J}/Front.java`]) {
        assert.ok(g.edges.some(e => e.from === t && e.rel === 'touched_file' && e.to === f), `touched_file ${f}`);
    }
    assert.ok(!Object.keys(g.nodes).some(id => id.includes('memory/runs')), 'memory/ não é arquivo tocado');
    assert.ok(!Object.keys(g.nodes).some(id => /jacoco\.exec|CTe\.png/.test(id)), 'binário/artefato não é arquivo tocado');
    assert.ok(g.edges.some(e => e.rel === 'generated_spec' && e.at === state.started_at));
    assert.ok(g.edges.some(e => e.rel === 'opened_pr' && e.to === 'PR-app-back-891' && e.at === '2026-09-20T12:00:00Z'));
});

test('watcher: varredura atualiza status do PR sem remover nada; roda de novo sem mudança', () => {
    const watcher = require('../readmine-watcher');
    assert.strictEqual(watcher.KNOWLEDGE_GRAPH_PATH, graphPath);
    const before = kg.readGraph(graphPath);
    fs.writeFileSync(path.join(taskDir, 'state.json'), JSON.stringify({
        ...state, status: 'committed',
        pull_request: { ...state.pull_request, 'app-back': { ...state.pull_request['app-back'], status: 'MERGED' } },
    }, null, 2));
    assert.strictEqual(watcher.syncKnowledgeGraph().changed, true);
    const after = kg.readGraph(graphPath);
    assert.strictEqual(after.nodes['PR-app-back-891'].status, 'merged');
    for (const id of Object.keys(before.nodes)) assert.ok(after.nodes[id], `nó ${id} continua`);
    assert.ok(after.edges.length >= before.edges.length);
    assert.strictEqual(watcher.syncKnowledgeGraph().changed, false);
});

test('trace.js: acha o ticket pelo KG, pelos @spec e pelo git log (qualquer forma de caminho)', () => {
    for (const arg of [path.join(wt('app-back'), J, 'Big.java'), `${J}/Big.java`, 'Big.java']) {
        const r = trace(arg, { mainRepo: repo, graphPath });
        assert.strictEqual(r.file.endsWith('Big.java'), true);
        assert.deepStrictEqual(r.tickets.map(t => t.id), [`TASK-${TICKET}`], arg);
        assert.deepStrictEqual(r.tickets[0].prs.map(p => p.id).sort(), ['PR-app-back-891', 'PR-app-core-55']);
    }
    const r = trace(path.join(wt('app-back'), J, 'Tagged.java'), { mainRepo: repo, graphPath });
    assert.deepStrictEqual(r.specTags.map(t => t.redmine), ['#80000', `#${TICKET}`]);
    const out = format(trace(path.join(wt('app-back'), J, 'Big.java'), { mainRepo: repo, graphPath }));
    assert.match(out, /TASK-90010 — Rastreio de frete/);
    assert.match(out, /90005 - Ajuste antigo/); // fallback git log (histórico anterior ao grafo)
    assert.match(out, /Tickets: .*#90010.*#90005|Tickets: .*#90005.*#90010/);
    const core = trace(`app-core/${J}/Core.java`, { mainRepo: repo, graphPath });
    assert.deepStrictEqual(core.tickets.map(t => t.id), [`TASK-${TICKET}`]);
    assert.strictEqual(core.repo, 'app-core');
});

test('subgrafos: por ticket aceita 90010 / TASK-90010 / task-id; arquivo desconhecido volta vazio', () => {
    const g = kg.readGraph(graphPath);
    for (const id of [TICKET, `TASK-${TICKET}`, TASK]) {
        assert.ok(kg.subgraphForTicket(g, id).nodes[`TASK-${TICKET}`], id);
    }
    assert.deepStrictEqual(kg.subgraphForFile(g, 'nao/existe.java'), { nodes: {}, edges: [] });
    assert.strictEqual(kg.ticketIdOf('2026-09-19-liquibase-migrations', {}), null);
    assert.strictEqual(kg.ticketIdOf('43425-slug', {}), '43425');
});

test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

module.exports = { graphPath };
