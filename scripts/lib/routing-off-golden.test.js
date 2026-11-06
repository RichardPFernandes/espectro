// node --test scripts/lib/routing-off-golden.test.js
// PRI-233 (PRI-205 S4) T1 / AC-01: golden do despacho AS-IS.
//
// Rede de segurança da S4. Antes de qualquer mudança de roteamento, captura o argv
// e o env que o watcher desta revisão passa ao `claude` em cada forma de despacho:
// o segmento de ticket novo (fetch_ticket + plan) e cada nó do grafo nas causas
// dispatch, retry, timeout e resume. A captura roda duas vezes, em consumidores
// sintéticos separados: sem configuração de roteamento e com
// `.claude/model-routing.json` = { "mode": "OFF" }. As duas precisam ser iguais ao
// golden gravado em scripts/fixtures/routing-off-golden.json.
//
// O golden foi gerado a partir da revisão anterior à S4 (ver o commit que o
// introduz). Regenerar só de propósito, com revisão do diff:
//   ROUTING_GOLDEN_UPDATE=1 node --test scripts/lib/routing-off-golden.test.js
//
// Watcher real num processo próprio por despacho, `claude` stub no PATH que só
// grava argv/env e sai 0, Redmine falso em loopback, token falso. Sem rede externa.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { execFile, execFileSync } = require('child_process');

const PRISMA_ROOT = path.resolve(__dirname, '..', '..');
const WATCHER = path.join(PRISMA_ROOT, 'scripts', 'readmine-watcher.js');
const GOLDEN = path.join(PRISMA_ROOT, 'scripts', 'fixtures', 'routing-off-golden.json');
const UPDATE = process.env.ROUTING_GOLDEN_UPDATE === '1';

const tmp = fs.mkdtempSync(path.join(process.env.CLAUDE_JOB_DIR ? path.join(process.env.CLAUDE_JOB_DIR, 'tmp') : os.tmpdir(), 'routing-off-golden-'));
const binDir = path.join(tmp, 'bin');
const captures = path.join(tmp, 'captures');
const results = path.join(tmp, 'results');
const driver = path.join(tmp, 'driver.js');
for (const d of [binDir, captures, results]) fs.mkdirSync(d, { recursive: true });

// Variantes de configuração do consumidor que precisam produzir o mesmo despacho.
const VARIANTS = {
    absent: null,
    off: { mode: 'OFF' },
};

const NODES = ['plan', 'implement', 'review', 'test', 'verify', 'commit'];
const CAUSES = ['dispatch', 'retry', 'timeout', 'resume'];

// Campos normalizados (voláteis por construção, não por comportamento):
// - caminho do checkout da plataforma → <prisma_root> (cada checkout/CI tem o seu);
// - caminho do tmp do teste → <tmp> (o consumidor sintético varia por execução);
// - nome da variante no caminho do consumidor → <variant> (absent/off moram em pastas diferentes);
// - UUIDs → <uuid> (--session-id e id do Attempt DOM06, gerados por despacho);
// - instantes ISO-8601 → <ts> (node_started_at e afins citados no prompt/env).
const NORMALIZED_FIELDS = ['prisma_root', 'tmp_path', 'variant_dir', 'uuid', 'iso_timestamp'];

fs.writeFileSync(driver, `
const fs = require('fs');
const [watcherPath, id, resultFile] = process.argv.slice(2).filter(a => a !== '--follow');
global.fetch = async () => ({ ok: true, status: 204, json: async () => ({}), text: async () => '' });
const watcher = require(watcherPath);
// Descrição válida da fixture sintética do harness: passa o portão de spec do ticket,
// senão o plan e o ticket novo param em spec_aguardando_aprovacao antes do despacho.
const { description } = require(${JSON.stringify(path.join(PRISMA_ROOT, 'scripts', 'fixtures', 'ticket-example.json'))});
const ticket = {
    id: Number(id), subject: 'Ticket ' + id, description, status: { name: 'Em Desenvolvimento' },
    tracker: { name: 'Melhoria' }, custom_fields: [{ name: 'Branch Liberação', value: 'Dev - Local' }],
    updated_on: new Date().toISOString(),
};
watcher.dispatchTicket(ticket).then(
    r => { fs.writeFileSync(resultFile, JSON.stringify(r)); process.exit(0); },
    e => { fs.writeFileSync(resultFile, JSON.stringify({ error: e.message })); process.exit(1); },
);
`);

// Stub do agente: grava cada invocação (argv e env completos) e sai 0.
fs.writeFileSync(path.join(binDir, 'claude'), `#!${process.execPath}
const fs = require('fs');
const path = require('path');
const dir = path.join(${JSON.stringify(captures)}, process.env.GOLDEN_SCENARIO || 'sem-cenario');
fs.mkdirSync(dir, { recursive: true });
const n = fs.readdirSync(dir).length;
fs.writeFileSync(path.join(dir, String(n).padStart(3, '0') + '.json'), JSON.stringify({ argv: process.argv.slice(2), env: process.env }));
`, { mode: 0o755 });
fs.writeFileSync(path.join(binDir, 'osascript'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });

const REDMINE_KEY = 'chave-falsa-golden';
const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{}');
    });
});
const origin = () => `http://127.0.0.1:${server.address().port}`;

const GIT_ENV = {
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_AUTHOR_NAME: 'golden', GIT_AUTHOR_EMAIL: 'golden@example.invalid',
    GIT_COMMITTER_NAME: 'golden', GIT_COMMITTER_EMAIL: 'golden@example.invalid',
};
const git = (cwd, ...args) => execFileSync('git', args, { cwd, env: { PATH: process.env.PATH, ...GIT_ENV }, encoding: 'utf8' }).trim();

function repoFor(variant) {
    const repo = path.join(tmp, variant, 'app-back');
    if (!fs.existsSync(repo)) {
        fs.mkdirSync(path.join(repo, '.claude'), { recursive: true });
        if (VARIANTS[variant]) {
            fs.writeFileSync(path.join(repo, '.claude', 'model-routing.json'), JSON.stringify(VARIANTS[variant]));
        }
        // O ticket novo cria o worktree do ciclo a partir do checkout do consumidor.
        git(repo, 'init', '-q', '-b', 'development');
        git(repo, 'commit', '-q', '--allow-empty', '-m', 'base sintética');
        const remote = path.join(tmp, variant, 'origin.git');
        fs.mkdirSync(remote, { recursive: true });
        git(remote, 'init', '-q', '--bare');
        git(repo, 'remote', 'add', 'origin', remote);
        git(repo, 'push', '-q', 'origin', 'development');
    }
    return repo;
}

function stateFor(node, cause) {
    const history = ['fetch_ticket', ...NODES.slice(0, NODES.indexOf(node))];
    const state = {
        task_id: null, node, history, status: 'in_progress',
        started_at: '2026-11-06T12:00:00.000Z', retries: {},
    };
    if (cause === 'retry') state.retries[node] = 1;
    // causeFromState: reason timeout → timeout; qualquer outro (agent_dead) → resume.
    if (cause === 'timeout') state.recovered_from_orphan = { node, reason: 'timeout' };
    if (cause === 'resume') state.recovered_from_orphan = { node, reason: 'agent_dead' };
    return state;
}

// Run de um ticket já em andamento no worktree sintético do consumidor.
function seedRun(repo, id, node, cause) {
    const taskId = `${id}-golden`;
    const worktree = path.join(repo, '.claude', 'worktrees', String(id));
    const dir = path.join(worktree, 'memory', 'runs', taskId);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ ...stateFor(node, cause), task_id: taskId }));
    fs.writeFileSync(path.join(dir, 'context.md'), '# Contexto\n');
    fs.writeFileSync(path.join(dir, 'plan.md'), '# Plano\n\n## Passos\n\n1. Passo único.\n');
    git(worktree, 'init', '-q', '-b', String(id));
    git(worktree, 'commit', '-q', '--allow-empty', '-m', `Melhoria #${id}`);
    return { taskId, dir, worktree };
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
        REDMINE_API_KEY: REDMINE_KEY,
        REDMINE_RETRY_MAX_ATTEMPTS: '1',
        REDMINE_MIN_INTERVAL_MS: '0',
        GOLDEN_SCENARIO: scenario,
    };
    const args = [driver, WATCHER, String(id), resultFile, '--follow'];
    return new Promise(resolve => {
        execFile(process.execPath, args, { cwd: repo, env, timeout: 120000 }, (err, stdout, stderr) => {
            const result = fs.existsSync(resultFile) ? JSON.parse(fs.readFileSync(resultFile, 'utf8')) : null;
            resolve({ code: err ? err.code : 0, result, output: `${stdout}\n${stderr}`, env });
        });
    });
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const ISO = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g;

function normalize(value, variant) {
    const variantRoot = path.join(tmp, variant);
    return JSON.parse(JSON.stringify(value)
        .split(variantRoot).join('<tmp>/<variant>')
        .split(tmp).join('<tmp>')
        .split(PRISMA_ROOT).join('<prisma_root>')
        .replace(UUID, '<uuid>')
        .replace(ISO, '<ts>'));
}

// Variáveis que o sistema operacional injeta em todo processo (não vêm do watcher).
const OS_ENV = new Set(['__CF_USER_TEXT_ENCODING']);

// Só o que o watcher acrescenta ou muda no env herdado do processo do watcher.
function envDelta(childEnv, watcherEnv) {
    const delta = {};
    for (const key of Object.keys(childEnv).sort()) {
        if (OS_ENV.has(key)) continue;
        if (watcherEnv[key] !== childEnv[key]) delta[key] = childEnv[key];
    }
    return delta;
}

function invocationsOf(scenario, watcherEnv, variant) {
    const dir = path.join(captures, scenario);
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir).sort().map(f => {
        const c = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
        return normalize({ argv: c.argv, env: envDelta(c.env, watcherEnv) }, variant);
    });
}

const SCENARIOS = [];
SCENARIOS.push({ key: 'new_ticket/dispatch', id: 233001, seed: null });
NODES.forEach((node, i) => CAUSES.forEach((cause, j) => {
    SCENARIOS.push({ key: `${node}/${cause}`, id: 233100 + i * 10 + j, seed: { node, cause } });
}));

async function captureVariant(variant) {
    const repo = repoFor(variant);
    const out = {};
    for (const s of SCENARIOS) {
        if (s.seed) seedRun(repo, s.id, s.seed.node, s.seed.cause);
        const scenario = `${variant}--${s.key.replace('/', '--')}`;
        const r = await dispatch(repo, s.id, scenario);
        out[s.key] = {
            action: r.result?.action ?? null,
            reason: r.result?.reason ?? null,
            invocations: invocationsOf(scenario, r.env, variant),
        };
        // O golden só vale se cada cenário chegou ao despacho real do agente.
        assert.strictEqual(out[s.key].action, 'dispatched', `${variant} ${s.key}: não despachou (${out[s.key].reason})\n${r.output}`);
        assert.ok(out[s.key].invocations.length > 0, `${variant} ${s.key}: o stub do claude não foi invocado\n${r.output}`);
    }
    return out;
}

test.before(() => new Promise(r => server.listen(0, '127.0.0.1', r)));
test.after(() => { server.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

test('AC-01: sem routing e com mode OFF, o despacho é igual ao golden do AS-IS', { timeout: 15 * 60 * 1000 }, async t => {
    const absent = await captureVariant('absent');
    const off = await captureVariant('off');

    if (UPDATE) {
        fs.mkdirSync(path.dirname(GOLDEN), { recursive: true });
        fs.writeFileSync(GOLDEN, JSON.stringify({ normalized_fields: NORMALIZED_FIELDS, scenarios: absent }, null, 2) + '\n');
        t.diagnostic(`golden regenerado em ${path.relative(PRISMA_ROOT, GOLDEN)} (${Object.keys(absent).length} cenários)`);
    }
    assert.ok(fs.existsSync(GOLDEN), 'golden ausente: gere com ROUTING_GOLDEN_UPDATE=1 na revisão AS-IS');
    const golden = JSON.parse(fs.readFileSync(GOLDEN, 'utf8'));
    assert.deepStrictEqual(golden.normalized_fields, NORMALIZED_FIELDS, 'a lista de campos normalizados mudou');
    assert.deepStrictEqual(Object.keys(golden.scenarios).sort(), SCENARIOS.map(s => s.key).sort(), 'o conjunto de cenários mudou');
    for (const s of SCENARIOS) {
        assert.deepStrictEqual(absent[s.key], golden.scenarios[s.key], `routing ausente diverge do golden em ${s.key}`);
        assert.deepStrictEqual(off[s.key], golden.scenarios[s.key], `mode OFF diverge do golden em ${s.key}`);
    }
});
