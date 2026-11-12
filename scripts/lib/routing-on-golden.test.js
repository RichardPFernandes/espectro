// node --test scripts/lib/routing-on-golden.test.js
// PRI-310 (PRI-287 S5.1) AC-01: golden do despacho roteado (Run ON) antes da decomposição.
//
// Rede de segurança da S5.1, gerada em 2024597 antes de qualquer mudança do contrato do
// DOM-06. Captura, para uma Run ON sem a chave `decomposition` e com `decomposition: "off"`
// explícito: argv do `claude`, snapshot `routing` da admissão (bytes canônicos e sha),
// Attempts DOM-06 (sem ids e horários), obrigações e o estado da task depois do despacho.
// As duas variantes têm de ser iguais ao golden gravado em
// scripts/fixtures/routing-on-golden.json.
//
// Regenerar só de propósito, com revisão do diff:
//   ROUTING_ON_GOLDEN_UPDATE=1 node --test scripts/lib/routing-on-golden.test.js
//
// Watcher real num processo próprio por despacho, `claude` stub no PATH (grava argv; no
// segmento de ticket novo cria a task como o agente faria), Redmine falso. Policy e ids de
// modelo sintéticos. Sem rede externa.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { execFile, execFileSync } = require('child_process');
const dom06 = require('./dom06-attempt');
const mr = require('./model-routing');
const policyLoader = require('./model-routing-policy');
const routingRun = require('./routing-run');
const { validateState } = require('../validate-state');

const PRISMA_ROOT = path.resolve(__dirname, '..', '..');
const WATCHER = path.join(PRISMA_ROOT, 'scripts', 'readmine-watcher.js');
const GOLDEN = path.join(PRISMA_ROOT, 'scripts', 'fixtures', 'routing-on-golden.json');
const UPDATE = process.env.ROUTING_ON_GOLDEN_UPDATE === '1';

const tmp = fs.mkdtempSync(path.join(process.env.CLAUDE_JOB_DIR ? path.join(process.env.CLAUDE_JOB_DIR, 'tmp') : os.tmpdir(), 'routing-on-golden-'));
const binDir = path.join(tmp, 'bin');
const captures = path.join(tmp, 'captures');
const results = path.join(tmp, 'results');
const driver = path.join(tmp, 'driver.js');
for (const d of [binDir, captures, results]) fs.mkdirSync(d, { recursive: true });

// Variantes da config ON que precisam produzir o mesmo despacho e o mesmo registro.
const VARIANTS = {
    on: {},
    on_decomposition_off: { decomposition: 'off' },
};

fs.writeFileSync(driver, `
const fs = require('fs');
const [watcherPath, id, resultFile] = process.argv.slice(2).filter(a => a !== '--follow');
global.fetch = async () => ({ ok: true, status: 204, json: async () => ({}), text: async () => '' });
const watcher = require(watcherPath);
const { description } = require(${JSON.stringify(path.join(PRISMA_ROOT, 'scripts', 'fixtures', 'ticket-example.json'))});
const ticket = {
    id: Number(id), subject: 'Ticket ' + id, description, status: { name: 'Em Desenvolvimento' },
    tracker: { name: 'Melhoria' }, custom_fields: [{ name: 'Branch Liberação', value: 'Dev - Local' }],
    updated_on: new Date().toISOString(),
};
watcher.dispatchTicket(ticket).then(
    r => { fs.writeFileSync(resultFile, JSON.stringify(r)); process.exit(0); },
    e => { fs.writeFileSync(resultFile, JSON.stringify({ error: e.message, stack: e.stack })); process.exit(1); },
);
`);

fs.writeFileSync(path.join(binDir, 'claude'), `#!${process.execPath}
const fs = require('fs');
const path = require('path');
const scenario = process.env.GOLDEN_SCENARIO || 'sem-cenario';
const dir = path.join(${JSON.stringify(captures)}, scenario);
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, String(fs.readdirSync(dir).length).padStart(3, '0') + '.json'), JSON.stringify({ argv: process.argv.slice(2) }));
const prompt = process.argv[process.argv.indexOf('-p') + 1] || '';
const m = /\\/fetch-ticket (\\d+)/.exec(prompt);
if (m) {
    const taskId = m[1] + '-og';
    const runDir = path.join(process.cwd(), 'memory', 'runs', taskId);
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(path.join(runDir, 'state.json'), JSON.stringify({
        task_id: taskId, node: 'implement', history: ['fetch_ticket', 'plan'], status: 'in_progress',
        started_at: new Date().toISOString(), retries: {},
    }));
    fs.writeFileSync(path.join(runDir, 'context.md'), '# Contexto\\n');
    fs.writeFileSync(path.join(runDir, 'plan.md'), '# Plano\\n\\n## Passos\\n\\n1. Passo único.\\n');
}
`, { mode: 0o755 });
fs.writeFileSync(path.join(binDir, 'osascript'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });

const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{}'); });
});
const origin = () => `http://127.0.0.1:${server.address().port}`;

const GIT_ENV = {
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_AUTHOR_NAME: 'golden', GIT_AUTHOR_EMAIL: 'golden@example.invalid',
    GIT_COMMITTER_NAME: 'golden', GIT_COMMITTER_EMAIL: 'golden@example.invalid',
};
const git = (cwd, ...args) => execFileSync('git', args, { cwd, env: { PATH: process.env.PATH, ...GIT_ENV }, encoding: 'utf8' }).trim();

const POLICY = {
    id: 'routing-sintetica', version: 'p-golden-1', mode: 'ROUTED', classifier: { provider: 'cheap_rule' },
    class_to_tier: {
        C1: { tier: 'T1', effort: 'baixo' }, C2: { tier: 'T2', effort: 'médio' }, C3: { tier: 'T2', effort: 'alto' },
        C4: { tier: 'T3', effort: 'alto' }, C5: { tier: 'T3', effort: 'máximo' },
    },
    tiers: { T1: { models: ['m-t1'] }, T2: { models: ['m-t2'] }, T3: { models: ['m-t3'] } },
    default_route: { model_id: 'm-t3', effort: 'alto' },
    effort_map: { baixo: 'low', 'médio': 'medium', alto: 'high', 'máximo': 'max' },
};

function consumer(variant) {
    const root = path.join(tmp, variant);
    const repo = path.join(root, 'app-back');
    fs.mkdirSync(path.join(repo, '.claude'), { recursive: true });
    const bytes = JSON.stringify(POLICY);
    fs.writeFileSync(path.join(repo, '.claude', 'routing-policy.json'), bytes);
    fs.writeFileSync(path.join(repo, '.claude', 'model-routing.json'), JSON.stringify({
        mode: 'ON',
        policy_ref: { id: POLICY.id, version: POLICY.version, sha256: crypto.createHash('sha256').update(bytes).digest('hex'), path: '.claude/routing-policy.json' },
        ...VARIANTS[variant],
    }));
    git(repo, 'init', '-q', '-b', 'development');
    git(repo, 'commit', '-q', '--allow-empty', '-m', 'base sintética');
    const remote = path.join(root, 'origin.git');
    fs.mkdirSync(remote, { recursive: true });
    git(remote, 'init', '-q', '--bare');
    git(repo, 'remote', 'add', 'origin', remote);
    git(repo, 'push', '-q', 'origin', 'development');
    return repo;
}

const worktreeOf = (repo, id) => path.join(repo, '.claude', 'worktrees', String(id));
const fetchRunDirOf = (repo, id) => path.join(worktreeOf(repo, id), 'memory', 'runs', '_dom06');
const taskDirOf = (repo, id) => path.join(worktreeOf(repo, id), 'memory', 'runs', `${id}-og`);

const PLAN_TWO_GROUPS = [
    '# Plano', '', '## Plano de execução', '',
    '1. Ajustar o serviço.', '   - Arquivo: `src/main/java/app/Servico.java`', '   - Critérios: AC-01', '   - Verificação: teste unitário', '',
    '2. Ajustar a documentação.', '   - Arquivo: `docs/leia.md`', '   - Critérios: AC-02', '   - Verificação: leitura', '',
].join('\n');

// Run ON já admitida pelo DOM06 real, ligada ao snapshot (como a S4 deixa a task).
function seedOnRun(repo, id, { node, retries = {} }) {
    const worktree = worktreeOf(repo, id);
    fs.mkdirSync(worktree, { recursive: true });
    git(worktree, 'init', '-q', '-b', String(id));
    git(worktree, 'commit', '-q', '--allow-empty', '-m', `Melhoria #${id}`);
    const snapshot = mr.buildRoutingSnapshot(policyLoader.readRoutingConfig(repo));
    const fetch = dom06.prepareDispatch({
        runDir: fetchRunDirOf(repo, id), node: 'fetch_ticket', ticketId: id, baseBranch: 'development',
        specHash: null, cause: 'dispatch', routing: snapshot,
    });
    routingRun.recordAdmission(fetchRunDirOf(repo, id), fetch.attempt);
    routingRun.markConsumed(fetchRunDirOf(repo, id), `${id}-og`);
    const dir = taskDirOf(repo, id);
    fs.mkdirSync(dir, { recursive: true });
    const history = ['fetch_ticket', 'plan', 'implement', 'review', 'test', 'verify'];
    fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({
        task_id: `${id}-og`, node, history: history.slice(0, history.indexOf(node)), status: 'in_progress',
        started_at: new Date(Date.now() + 1000).toISOString(), retries,
        routing_snapshot: { attempt_id: fetch.attempt.attempt_id, sha256: snapshot.sha256 },
    }));
    fs.writeFileSync(path.join(dir, 'context.md'), '# Contexto\n');
    fs.writeFileSync(path.join(dir, 'plan.md'), PLAN_TWO_GROUPS);
}

function dispatch(repo, id, scenario) {
    const resultFile = path.join(results, `${scenario}.json`);
    const env = {
        PATH: `${binDir}:${process.env.PATH}`,
        ...(process.env.TMPDIR ? { TMPDIR: process.env.TMPDIR } : {}),
        ...(process.env.LANG ? { LANG: process.env.LANG } : {}),
        ...GIT_ENV,
        REPO_PATH: repo,
        PLAN_SCORE_THRESHOLD: '0',
        SKIP_PRE_BUILD_VALIDATION: 'true',
        SPEC_DRAFT_AUTOGEN: '0',
        REDMINE_URL: `${origin()}/redmine`,
        REDMINE_API_KEY: 'chave-falsa-on-golden',
        REDMINE_RETRY_MAX_ATTEMPTS: '1',
        REDMINE_MIN_INTERVAL_MS: '0',
        GOLDEN_SCENARIO: scenario,
    };
    return new Promise(resolve => {
        execFile(process.execPath, [driver, WATCHER, String(id), resultFile, '--follow'], { cwd: repo, env, timeout: 120000 }, (err, stdout, stderr) => {
            const result = fs.existsSync(resultFile) ? JSON.parse(fs.readFileSync(resultFile, 'utf8')) : null;
            resolve({ result, output: `${stdout}\n${stderr}` });
        });
    });
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const ISO = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g;
function normalize(value, variant) {
    return JSON.parse(JSON.stringify(value)
        .split(path.join(tmp, variant)).join('<tmp>/<variant>')
        .split(tmp).join('<tmp>')
        .split(PRISMA_ROOT).join('<prisma_root>')
        .replace(UUID, '<uuid>')
        .replace(ISO, '<ts>'));
}

const argvsOf = scenario => {
    const dir = path.join(captures, scenario);
    return fs.existsSync(dir) ? fs.readdirSync(dir).sort().map(f => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')).argv) : [];
};

// Attempt sem campos voláteis por construção (id, instantes); o resto é contrato.
function attemptView(a) {
    const { attempt_id: _id, created_at: _c, admitted_at: _a, revoked_at: _r, ...rest } = a;
    return rest;
}

function runView(repo, id) {
    const fetchAttempts = dom06.listAttempts(fetchRunDirOf(repo, id)).map(attemptView);
    const taskDir = taskDirOf(repo, id);
    const nodeAttempts = fs.existsSync(taskDir) ? dom06.listAttempts(taskDir).map(attemptView) : [];
    const state = fs.existsSync(path.join(taskDir, 'state.json')) ? JSON.parse(fs.readFileSync(path.join(taskDir, 'state.json'), 'utf8')) : null;
    const snap = fetchAttempts[0]?.snapshot?.routing ?? null;
    return {
        admission_snapshot_canonical: snap ? mr.canonicalSha256(snap) : null,
        admission_snapshot_keys: snap ? Object.keys(snap).sort() : null,
        fetch_attempts: fetchAttempts,
        node_attempts: nodeAttempts,
        obligations: nodeAttempts.map(a => a.obligations),
        state_after: state ? { node: state.node, status: state.status, history: state.history } : null,
    };
}

const SCENARIOS = [
    { key: 'new_ticket/dispatch', id: 287001, seed: null },
    { key: 'implement/dispatch', id: 287011, seed: { node: 'implement' } },
    { key: 'implement/retry', id: 287012, seed: { node: 'implement', retries: { implement: 1 } } },
    { key: 'review/dispatch', id: 287021, seed: { node: 'review' } },
];

async function captureVariant(variant) {
    const repo = consumer(variant);
    const out = {};
    for (const s of SCENARIOS) {
        if (s.seed) seedOnRun(repo, s.id, s.seed);
        const scenario = `${variant}--${s.key.replace('/', '--')}`;
        const r = await dispatch(repo, s.id, scenario);
        assert.strictEqual(r.result?.action, 'dispatched', `${variant} ${s.key}: não despachou (${r.result?.reason})\n${r.output}`);
        out[s.key] = normalize({ action: r.result.action, argv: argvsOf(scenario), ...runView(repo, s.id) }, variant);
        assert.ok(out[s.key].argv.length > 0, `${variant} ${s.key}: o stub do claude não foi invocado`);
        const routed = assertStateMatchesSchema(repo, s.id, `${variant} ${s.key}`);
        assert.ok(routed > 0, `${variant} ${s.key}: state.json sem tentativa roteada no cost_tracking; o cenário não exercitou a forma roteada`);
    }
    return out;
}

// PRI-334 AC-02: o state.json que o watcher grava depois de um despacho roteado tem de
// passar no mesmo validador que o tick seguinte usa (validate-state + state.schema.json).
// Sem isto, a tentativa roteada no cost_tracking virava state_corrupted só em produção.
// Devolve quantas tentativas roteadas o state tem, para o teste provar que exercitou a forma.
function assertStateMatchesSchema(repo, id, label) {
    const file = path.join(taskDirOf(repo, id), 'state.json');
    assert.ok(fs.existsSync(file), `${label}: state.json não foi gravado`);
    const state = JSON.parse(fs.readFileSync(file, 'utf8'));
    const check = validateState(state);
    assert.strictEqual(check.valid, true, `${label}: state.json fora do schema:\n${(check.errors || []).join('\n')}`);
    const nodes = state.cost_tracking?.nodes || {};
    return Object.values(nodes).flatMap(n => n.attempts || []).filter(a => a.routing_decision && typeof a.routing_decision === 'object').length;
}

test.before(() => new Promise(r => server.listen(0, '127.0.0.1', r)));
test.after(() => { server.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

test('AC-01 (S5.1): Run ON sem a chave e com decomposition "off" é igual ao golden pré-decomposição', { timeout: 10 * 60 * 1000 }, async t => {
    // PRI-334 AC-02: sem ajv o validateState cai na checagem mínima e a validação passaria à toa.
    let hasAjv = true;
    try { require.resolve('ajv'); } catch { hasAjv = false; }
    assert.ok(hasAjv, 'ajv ausente: rode npm ci em scripts/ (sem ele a validação contra o schema não é real)');
    const on = await captureVariant('on');
    const onOff = await captureVariant('on_decomposition_off');
    if (UPDATE) {
        fs.writeFileSync(GOLDEN, JSON.stringify({ generated_at_revision: '2024597', scenarios: on }, null, 2) + '\n');
        t.diagnostic(`golden ON regenerado em ${path.relative(PRISMA_ROOT, GOLDEN)}`);
    }
    assert.ok(fs.existsSync(GOLDEN), 'golden ausente: gere com ROUTING_ON_GOLDEN_UPDATE=1 na revisão pré-decomposição');
    const golden = JSON.parse(fs.readFileSync(GOLDEN, 'utf8'));
    assert.deepStrictEqual(Object.keys(golden.scenarios).sort(), SCENARIOS.map(s => s.key).sort(), 'o conjunto de cenários mudou');
    for (const s of SCENARIOS) {
        assert.deepStrictEqual(on[s.key], golden.scenarios[s.key], `Run ON sem a chave diverge do golden em ${s.key}`);
        assert.deepStrictEqual(onOff[s.key], golden.scenarios[s.key], `Run ON com decomposition "off" diverge do golden em ${s.key}`);
    }
});
