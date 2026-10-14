// node --test lib/config-validator.test.js
// Regras de scripts/lib/config-validator.js e o CLI scripts/validate-config.js contra
// um repo de mentira montado em tmp (contrato e schema de state copiados do real).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const v = require('./config-validator');

const REAL_ROOT = path.resolve(__dirname, '..', '..');
const CLI = path.join(REAL_ROOT, 'scripts', 'validate-config.js');
const tmpBase = process.env.CLAUDE_JOB_DIR ? path.join(process.env.CLAUDE_JOB_DIR, 'tmp') : os.tmpdir();
const NODES = ['fetch_ticket', 'plan', 'implement', 'review', 'test', 'verify', 'commit'];
const GRAPH = `version: 1
description: >
  Grafo de teste.
entry_point: plan
# comentário solto
nodes:
  - id: fetch_ticket
    command: /fetch-ticket
    on_success: plan
  - id: plan
    command: /plan
    description: >
      Texto dobrado
      em duas linhas.
    on_success: implement
  - id: implement
    command: /implement
    on_success: review
  - id: review
    command: /review
    on_pass: test
    on_fail: implement
    max_retries: 3
  - id: test
    command: /test
    on_pass: verify
    on_fail: implement
    max_retries: 3
  - id: verify
    command: /verify
    on_pass: commit
    on_fail: test
    max_retries: 2
  - id: commit
    command: /commit
    terminal: true
on_max_retries_exceeded: escalate_to_human
`;
const ENV_EXAMPLE = `REDMINE_URL=https://x
REDMINE_API_KEY=
REPO_PATH=/x
BITBUCKET_WORKSPACE=
BITBUCKET_REPO_SLUG=
BITBUCKET_API_TOKEN=
BITBUCKET_EMAIL=a@b.c
# OPCIONAL_X=1
`;

const tmpDirs = [];
// Porta livre (fechada) pro dashboard: stopPreviewViaDashboard recebe ECONNREFUSED =
// "dashboard fora do ar, nenhum preview rodando". A porta 1 não serve: o fetch a recusa.
let freePort;
test.before(() => new Promise(resolve => {
    const s = require('net').createServer().listen(0, '127.0.0.1', () => { freePort = s.address().port; s.close(resolve); });
}));
test.after(() => { for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true }); });

function write(root, rel, content) {
    const p = path.join(root, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
    return p;
}

function template(name) {
    return `---\ndescription: Nó ${name} de teste.\n---\nTask-id: $ARGUMENTS\n\n${'Instruções do nó. '.repeat(20)}\n`;
}

function state(taskId, status, extra = {}) {
    return JSON.stringify({ task_id: taskId, node: 'commit', status, history: [], updated_at: '2026-09-20T10:00:00Z', ...extra });
}

// Repo válido: grafo completo, templates, .env.example documentando tudo que o código lê.
function makeRepo() {
    const root = fs.mkdtempSync(path.join(tmpBase, 'config-validator-'));
    tmpDirs.push(root);
    fs.copyFileSync(path.join(REAL_ROOT, '.claude', 'config-contract.json'), write(root, '.claude/config-contract.json', ''));
    fs.copyFileSync(path.join(REAL_ROOT, '.graph', 'schemas', 'state.schema.json'), write(root, '.graph/schemas/state.schema.json', ''));
    fs.copyFileSync(path.join(REAL_ROOT, '.claude', 'spec-hash-config.json'), write(root, '.claude/spec-hash-config.json', ''));
    write(root, '.graph/graph.yaml', GRAPH);
    write(root, '.claude/settings.json', JSON.stringify({ worktree: { bgIsolation: 'none' } }));
    for (const n of NODES) write(root, `.claude/commands/${n.replace('_', '-')}.md`, template(n));
    write(root, '.env.example', ENV_EXAMPLE);
    write(root, 'scripts/watcher.js', "const u = process.env.REDMINE_URL;\nconst x = intEnv(env, 'OPCIONAL_X', 1);\nconst p = process.env.PATH;\n");
    write(root, 'scripts/watcher.test.js', 'process.env.SO_EM_TESTE = 1;\n');
    write(root, 'scripts/lib/.keep', '');
    write(root, 'dashboard/.keep', '');
    write(root, 'scripts/open-pr.sh', 'echo "$BITBUCKET_EMAIL $BITBUCKET_WORKSPACE $BITBUCKET_REPO_SLUG $BITBUCKET_API_TOKEN $REDMINE_API_KEY $REPO_PATH"\n');
    write(root, 'memory/runs/_archive/100-ok/state.json', state('100-ok', 'fully_merged'));
    fs.mkdirSync(path.join(root, '.claude', 'worktrees'), { recursive: true });
    return root;
}

const contractOf = root => path.join(root, '.claude', 'config-contract.json');
const failing = (report, rule, severity) => report.results.filter(r => r.rule === rule && !r.passed && (!severity || r.severity === severity));
const runCli = (root, args, env = {}) => spawnSync(process.execPath, [CLI, '--config', contractOf(root), ...args], {
    encoding: 'utf8', env: { ...process.env, PORT: String(freePort), ...env },
});

test('parseGraphYaml lê o grafo real sem erro e com as arestas', () => {
    const { data, errors } = v.parseGraphYaml(fs.readFileSync(path.join(REAL_ROOT, '.graph', 'graph.yaml'), 'utf8'));
    assert.deepStrictEqual(errors, []);
    assert.strictEqual(data.entry_point, 'plan');
    const review = data.nodes.find(n => n.id === 'review');
    assert.deepStrictEqual([review.on_pass, review.on_fail, review.max_retries], ['test', 'implement', 3]);
    assert.strictEqual(data.nodes.find(n => n.id === 'commit').terminal, true);
});

test('parseGraphYaml reprova estrutura fora do subconjunto suportado', () => {
    // mapa aninhado dentro de nó e linha sem chave: erro, nunca achatar em silêncio
    assert.match(v.parseGraphYaml('nodes:\n  - id: a\n    retries:\n      review: 3\n').errors.join(), /linha 3: estrutura não suportada: retries:/);
    assert.ok(v.parseGraphYaml('version: 1\nsolto sem chave\n').errors.length);
});

test('contrato real: versionado, com as regras e os nós do grafo', () => {
    const c = v.loadContract(v.DEFAULT_CONFIG_PATH);
    assert.match(c.contractVersion, /^\d+\.\d+\.\d+$/);
    for (const r of v.RULES) assert.ok(c.rules[r.id], `regra ${r.id} sem entrada no contrato`);
    assert.deepStrictEqual(c.graph.validNodes, NODES);
});

test('config válida: todas as regras passam, cada resultado no formato {rule, severity, passed, message}', () => {
    const root = makeRepo();
    const report = v.validateAll(contractOf(root), { exec: () => '' });
    assert.strictEqual(report.valid, true, JSON.stringify(report.results.filter(r => !r.passed), null, 2));
    assert.strictEqual(report.summary.errors, 0);
    assert.strictEqual(report.summary.warnings, 0);
    assert.strictEqual(report.message, `Configuração válida - ${v.RULES.length} regras passaram`);
    for (const r of report.results) {
        assert.strictEqual(typeof r.rule, 'string');
        assert.ok(v.SEVERITIES.includes(r.severity));
        assert.strictEqual(typeof r.passed, 'boolean');
        assert.strictEqual(typeof r.message, 'string');
    }
});

test('CLI com config válida: exit 0 e "Configuração válida - X regras passaram"', () => {
    const root = makeRepo();
    const r = runCli(root, []);
    assert.strictEqual(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /Configuração válida - 6 regras passaram/);
    assert.doesNotMatch(r.stdout, /\x1b\[/, 'saída sem ANSI (CI)');
});

test('nó sem template → erro bloqueante em nodes-have-templates, exit 1', () => {
    const root = makeRepo();
    fs.rmSync(path.join(root, '.claude', 'commands', 'verify.md'));
    const report = v.validateAll(contractOf(root), { exec: () => '' });
    const [err] = failing(report, 'nodes-have-templates', 'error');
    assert.ok(err, 'sem erro em nodes-have-templates');
    assert.match(err.details.join('\n'), /nó "verify" \(\/verify\) sem template/);
    assert.strictEqual(report.valid, false);

    const cli = runCli(root, ['--format', 'json']);
    assert.strictEqual(cli.status, 1);
    const json = JSON.parse(cli.stdout);
    assert.strictEqual(json.exitCode, 1);
    assert.ok(json.results.some(x => x.rule === 'nodes-have-templates' && x.severity === 'error' && !x.passed));
});

test('template sem frontmatter obrigatório ou vazio → erro', () => {
    const root = makeRepo();
    write(root, '.claude/commands/plan.md', 'sem frontmatter\n');
    write(root, '.claude/commands/test.md', '---\ndescription: ok\n---\ncurto\n');
    const report = v.validateAll(contractOf(root), { exec: () => '' });
    const details = failing(report, 'nodes-have-templates', 'error')[0].details.join('\n');
    assert.match(details, /plan\.md: sem frontmatter/);
    assert.match(details, /test\.md: corpo com \d+ caracteres/);
});

test('graph-acyclic: ciclo em arestas de avanço, alvo inexistente e retry sem max_retries', () => {
    const root = makeRepo();
    write(root, '.graph/graph.yaml', GRAPH
        .replace('    on_pass: verify\n    on_fail: implement\n    max_retries: 3', '    on_pass: plan\n    on_fail: implement')
        .replace('on_fail: test', 'on_fail: nao_existe'));
    const report = v.validateAll(contractOf(root), { exec: () => '' });
    const details = failing(report, 'graph-acyclic', 'error')[0].details.join('\n');
    assert.match(details, /ciclo nas arestas de avanço: plan → implement → review → test → plan/);
    assert.match(details, /verify\.on_fail aponta pra nó inexistente "nao_existe"/);
    assert.match(details, /test\.on_fail sem max_retries/);
});

test('findForwardCycle: grafo real (retries são arestas de retry) não tem ciclo', () => {
    const { data } = v.parseGraphYaml(fs.readFileSync(path.join(REAL_ROOT, '.graph', 'graph.yaml'), 'utf8'));
    assert.strictEqual(v.findForwardCycle(data.nodes, ['on_success', 'on_pass']), null);
    assert.ok(v.findForwardCycle(data.nodes, ['on_success', 'on_pass', 'on_fail']), 'com on_fail o ciclo de retry aparece');
});

test('config-files-schema: campo obrigatório faltando e nó fora do contrato', () => {
    const root = makeRepo();
    write(root, '.graph/graph.yaml', GRAPH.replace('entry_point: plan\n', '').replace('  - id: commit\n    command: /commit', '  - id: deploy\n    command: /deploy'));
    write(root, '.claude/commands/deploy.md', template('deploy'));
    const report = v.validateAll(contractOf(root), { exec: () => '' });
    const details = failing(report, 'config-files-schema', 'error')[0].details.join('\n');
    assert.match(details, /graph\.yaml \(raiz\): sem campo obrigatório "entry_point"/);
    assert.match(details, /nó "deploy" não está em graph\.validNodes/);
    assert.ok(failing(report, 'config-files-schema', 'warning')[0].details.includes('commit'));
});

test('env-documented: var lida sem .env.example é warning; obrigatória faltando é erro', () => {
    const root = makeRepo();
    write(root, 'scripts/lib/novo.js', "const t = Number(process.env.NOVO_TIMEOUT_MS || 10);\nconst d = envDays(env, 'NOVO_DIAS', 3);\n");
    write(root, '.env.example', ENV_EXAMPLE.replace('BITBUCKET_EMAIL=a@b.c\n', ''));
    const report = v.validateAll(contractOf(root), { exec: () => '' });
    const warn = failing(report, 'env-documented', 'warning')[0];
    assert.deepStrictEqual(warn.details, ['NOVO_DIAS (scripts/lib/novo.js:2)', 'NOVO_TIMEOUT_MS (scripts/lib/novo.js:1)']);
    assert.deepStrictEqual(failing(report, 'env-documented', 'error')[0].details, ['BITBUCKET_EMAIL']);
    // .test.js e vars do sistema (contrato > env.ignore) não contam
    assert.doesNotMatch(warn.details.join(), /SO_EM_TESTE|PATH/);
});

test('state-schema-compat: run ativo inválido é erro, arquivado é warning, JSON quebrado também', () => {
    const root = makeRepo();
    write(root, 'memory/runs/200-ativo/state.json', state('200-ativo', 123));
    write(root, 'memory/runs/_archive/201-velho/state.json', '{ truncado');
    const report = v.validateAll(contractOf(root), { exec: () => '' });
    assert.match(failing(report, 'state-schema-compat', 'error')[0].details[0], /200-ativo\/state\.json: \/status/);
    assert.match(failing(report, 'state-schema-compat', 'warning')[0].details[0], /201-velho\/state\.json: JSON malformado/);
});

test('state-schema-compat: nó do grafo fora do enum do schema é erro', () => {
    const root = makeRepo();
    const p = path.join(root, '.graph', 'schemas', 'state.schema.json');
    const s = JSON.parse(fs.readFileSync(p, 'utf8'));
    s.properties.node.enum = s.properties.node.enum.filter(n => n !== 'verify');
    fs.writeFileSync(p, JSON.stringify(s));
    const report = v.validateAll(contractOf(root), { exec: () => '', rules: ['state-schema-compat'] });
    assert.match(failing(report, 'state-schema-compat', 'error')[0].message, /não cobre nó\(s\) do grafo: verify/);
});

// ── worktrees ─────────────────────────────────────────────────────────────────────
function git(cwd, ...args) {
    return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function makeGitRepo() {
    const root = makeRepo();
    git(root, 'init', '-q', '-b', 'main');
    git(root, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init');
    return root;
}

function addWorktree(root, name) {
    const dir = path.join(root, '.claude', 'worktrees', name);
    git(root, 'worktree', 'add', '-q', '-b', `wt-${name}`, dir);
    return dir;
}

test('worktrees-clean: detecta ciclo encerrado, PR aberto (info), órfão e diretório não-git', () => {
    const root = makeGitRepo();
    const closed = addWorktree(root, '300');
    write(root, '.claude/worktrees/300/memory/runs/_archive/300-feito/state.json', state('300-feito', 'fully_merged'));
    addWorktree(root, '301');
    write(root, 'memory/runs/_archive/301-pr/state.json', state('301-pr', 'committed'));
    addWorktree(root, '302');
    write(root, 'memory/runs/302-andamento/state.json', state('302-andamento', 'in_progress'));
    const gone = addWorktree(root, '303');
    fs.rmSync(gone, { recursive: true, force: true }); // registrado, diretório sumiu
    write(root, '.claude/worktrees/lixo/arquivo.txt', 'x');

    const report = v.validateAll(contractOf(root));
    const warns = failing(report, 'worktrees-clean', 'warning');
    const all = warns.map(w => w.details.join('\n')).join('\n');
    assert.match(all, /\.claude\/worktrees\/300 — 300-feito: fully_merged/);
    assert.match(all, /303: registrado em .* mas o diretório não existe/);
    assert.match(all, /\.claude\/worktrees\/lixo/);
    assert.doesNotMatch(all, /\b30[12]\b/);
    assert.match(failing(report, 'worktrees-clean', 'info')[0].details.join(), /301-pr: committed/);
    assert.ok(fs.existsSync(closed), 'validação não remove nada');
});

test('CLI --fix remove worktrees de ciclo encerrado e órfãos, lista quais, preserva runs e não toca config', () => {
    const root = makeGitRepo();
    addWorktree(root, '400');
    write(root, '.claude/worktrees/400/memory/runs/_archive/400-feito/state.json', state('400-feito', 'fully_merged'));
    const active = addWorktree(root, '401');
    write(root, 'memory/runs/401-andamento/state.json', state('401-andamento', 'in_progress'));
    const gone = addWorktree(root, '402');
    fs.rmSync(gone, { recursive: true, force: true });
    const configFiles = ['.claude/config-contract.json', '.graph/graph.yaml', '.env.example', '.claude/settings.json'];
    const before = configFiles.map(f => fs.readFileSync(path.join(root, f), 'utf8'));

    const r = runCli(root, ['--fix']);
    assert.strictEqual(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /Worktrees removidos \(2\):/);
    assert.match(r.stdout, /- \.claude\/worktrees\/400\n/);
    assert.match(r.stdout, /- .*402/);
    assert.match(r.stdout, /runs preservados em memory\/runs\/_archive\/: 400-feito/);
    assert.ok(!fs.existsSync(path.join(root, '.claude', 'worktrees', '400')));
    assert.ok(fs.existsSync(path.join(root, 'memory', 'runs', '_archive', '400-feito', 'state.json')));
    assert.ok(fs.existsSync(active), 'worktree de ciclo ativo fica');
    assert.doesNotMatch(git(root, 'worktree', 'list'), /\b40[02]\b/);
    assert.deepStrictEqual(configFiles.map(f => fs.readFileSync(path.join(root, f), 'utf8')), before);
    // depois do fix, a revalidação não acusa mais nada em worktrees-clean
    assert.match(r.stdout, /✅ \[worktrees-clean\]/);
});

test('worktrees-clean: padrão sem grupo de captura ainda identifica o ticket do diretório', () => {
    const root = makeGitRepo();
    const contract = JSON.parse(fs.readFileSync(contractOf(root), 'utf8'));
    contract.worktrees.ticketPattern = '^[A-Za-z0-9][A-Za-z0-9._-]*$';
    fs.writeFileSync(contractOf(root), JSON.stringify(contract));
    addWorktree(root, '600');
    write(root, '.claude/worktrees/600/memory/runs/_archive/600-feito/state.json', state('600-feito', 'fully_merged'));
    const report = v.validateAll(contractOf(root));
    const all = failing(report, 'worktrees-clean', 'warning').map(w => w.details.join('\n')).join('\n');
    assert.match(all, /\.claude\/worktrees\/600 — 600-feito: fully_merged/);
});

test('worktrees-clean: grupo de captura e grupo nomeado extraem o ticket de um nome maior', () => {
    const root = makeGitRepo();
    const contract = JSON.parse(fs.readFileSync(contractOf(root), 'utf8'));
    contract.worktrees.ticketPattern = '^pre-(\\d+)$';
    fs.writeFileSync(contractOf(root), JSON.stringify(contract));
    addWorktree(root, 'pre-601');
    write(root, 'memory/runs/_archive/601-feito/state.json', state('601-feito', 'completed'));

    const named = makeGitRepo();
    const namedContract = JSON.parse(fs.readFileSync(contractOf(named), 'utf8'));
    namedContract.worktrees.ticketPattern = '^(?<prefix>pre)-(?<ticket>\\d+)$';
    fs.writeFileSync(contractOf(named), JSON.stringify(namedContract));
    addWorktree(named, 'pre-602');
    write(named, 'memory/runs/_archive/602-feito/state.json', state('602-feito', 'cancelled'));

    const captured = failing(v.validateAll(contractOf(root)), 'worktrees-clean', 'warning').map(w => w.details.join('\n')).join('\n');
    const byName = failing(v.validateAll(contractOf(named)), 'worktrees-clean', 'warning').map(w => w.details.join('\n')).join('\n');
    assert.match(captured, /\.claude\/worktrees\/pre-601 — 601-feito: completed/);
    assert.match(byName, /\.claude\/worktrees\/pre-602 — 602-feito: cancelled/);
});

test('--fix enxerga run fechado só no worktree e remove o diretório real, não .claude/worktrees/<ticket>', async () => {
    const root = makeGitRepo();
    const contract = JSON.parse(fs.readFileSync(contractOf(root), 'utf8'));
    contract.worktrees.ticketPattern = '^pre-(\\d+)$';
    fs.writeFileSync(contractOf(root), JSON.stringify(contract));
    const dir = addWorktree(root, 'pre-710');
    write(root, '.claude/worktrees/pre-710/memory/runs/_archive/710-feito/state.json', state('710-feito', 'fully_merged'));

    const report = v.validateAll(contractOf(root));
    const all = failing(report, 'worktrees-clean', 'warning').map(w => w.details.join('\n')).join('\n');
    assert.match(all, /\.claude\/worktrees\/pre-710 — 710-feito: fully_merged/);
    const fixes = report.results.flatMap(r => r.fixes || []).filter(f => f.type === 'cleanup-ticket');
    assert.ok(fixes.some(f => f.paths.some(p => path.resolve(p) === path.resolve(dir))));

    const fix = await v.applyFixes(report, { configPath: contractOf(root), stopPreview: async () => ({ stopped: false }) });
    assert.ok(fix.removed.some(p => path.resolve(p) === path.resolve(dir)), `removido: ${fix.removed.join(', ')}`);
    assert.ok(!fs.existsSync(dir), 'diretório real do worktree permanece');
    assert.ok(!fs.existsSync(path.join(root, '.claude', 'worktrees', '710')));
    assert.ok(fs.existsSync(path.join(root, 'memory', 'runs', '_archive', '710-feito', 'state.json')));
    assert.doesNotMatch(git(root, 'worktree', 'list'), /pre-710/);
});

test('--fix mantém worktree de ciclo encerrado com mudança rastreada não commitada', async () => {
    const root = makeGitRepo();
    write(root, 'rastreado.txt', 'a');
    git(root, 'add', 'rastreado.txt');
    git(root, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'arquivo');
    const dir = addWorktree(root, '500');
    write(root, '.claude/worktrees/500/memory/runs/500-feito/state.json', state('500-feito', 'completed'));
    fs.writeFileSync(path.join(dir, 'rastreado.txt'), 'mudou');

    const report = v.validateAll(contractOf(root));
    const fix = await v.applyFixes(report, { configPath: contractOf(root), stopPreview: async () => ({ stopped: false }) });
    assert.deepStrictEqual(fix.removed, []);
    assert.strictEqual(fix.kept.length, 1);
    assert.ok(fs.existsSync(dir));
    assert.ok(!fs.existsSync(path.join(root, 'memory', 'runs', '_archive', '500-feito')), 'cópia desfeita: o run continua no worktree');
});

test('CLI: --severity error esconde avisos no texto; argumento inválido sai com 2', () => {
    const root = makeRepo();
    write(root, 'scripts/lib/novo.js', 'process.env.NAO_DOCUMENTADA;\n');
    const r = runCli(root, ['--severity', 'error']);
    assert.strictEqual(r.status, 0);
    assert.doesNotMatch(r.stdout, /NAO_DOCUMENTADA/);
    assert.match(runCli(root, ['--severity', 'warning']).stdout, /NAO_DOCUMENTADA/);
    assert.strictEqual(runCli(root, ['--format', 'xml']).status, 2);
    assert.strictEqual(spawnSync(process.execPath, [CLI, '--config', path.join(root, 'nao-existe.json')]).status, 2);
});
