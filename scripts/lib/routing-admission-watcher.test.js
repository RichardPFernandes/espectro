// node --test scripts/lib/routing-admission-watcher.test.js
// PRI-233 (PRI-205 S4) T5/T6/T7: roteamento no watcher real.
//
// Cada despacho roda o watcher desta revisão num processo próprio, com um consumidor
// sintético (repo git com origin bare local) e um `claude` stub no PATH. O stub grava
// argv e, quando o segmento é o de ticket novo (/fetch-ticket), cria a task como o
// agente faria (state.json no worktree do ticket). Redmine falso em loopback.
// Policy e ids de modelo são sintéticos; nada sai da máquina.
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

const PRISMA_ROOT = path.resolve(__dirname, '..', '..');
const WATCHER = path.join(PRISMA_ROOT, 'scripts', 'readmine-watcher.js');

const tmp = fs.mkdtempSync(path.join(process.env.CLAUDE_JOB_DIR ? path.join(process.env.CLAUDE_JOB_DIR, 'tmp') : os.tmpdir(), 'routing-admission-'));
const binDir = path.join(tmp, 'bin');
const captures = path.join(tmp, 'captures');
const results = path.join(tmp, 'results');
const driver = path.join(tmp, 'driver.js');
for (const d of [binDir, captures, results]) fs.mkdirSync(d, { recursive: true });

fs.writeFileSync(driver, `
const fs = require('fs');
const [watcherPath, id, resultFile] = process.argv.slice(2).filter(a => a !== '--follow');
// fetch do watcher stubado; cada chamada fica registrada para as asserções de aviso.
// Redmine falso: PUT que "gravou" vira journal; GET ?include=journals devolve os journals.
// FAIL_PUT=1 → 503 (certeza de que não gravou); FAIL_PUT=timeout → grava e cai a conexão
// (resultado incerto, como um proxy que estoura o tempo depois do Redmine gravar).
global.fetch = async (url, opts = {}) => {
    const u = String(url);
    fs.appendFileSync(process.env.FETCH_LOG, JSON.stringify({ url: u, method: opts.method || 'GET', body: opts.body || null }) + '\\n');
    const m = /\\/issues\\/(\\d+)\\.json/.exec(u);
    const ok = (body = {}, status = 204) => ({ ok: true, status, json: async () => body, text: async () => '' });
    if (opts.method === 'PUT') {
        if (process.env.FAIL_PUT === '1') return { ok: false, status: 503, json: async () => ({}), text: async () => '' };
        if (m) fs.appendFileSync(process.env.JOURNAL_LOG, JSON.stringify({ id: m[1], notes: JSON.parse(opts.body).issue.notes }) + '\\n');
        if (process.env.FAIL_PUT === 'timeout') throw Object.assign(new Error('timeout simulado'), { code: 'ETIMEDOUT' });
        return ok();
    }
    if (m && u.includes('include=journals')) {
        const all = fs.existsSync(process.env.JOURNAL_LOG) ? fs.readFileSync(process.env.JOURNAL_LOG, 'utf8').split('\\n').filter(Boolean).map(l => JSON.parse(l)) : [];
        return ok({ issue: { id: Number(m[1]), journals: all.filter(j => j.id === m[1]).map(j => ({ notes: j.notes })) } }, 200);
    }
    return ok();
};
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

// Stub do agente: grava argv; no segmento de ticket novo cria a task no worktree (cwd).
fs.writeFileSync(path.join(binDir, 'claude'), `#!${process.execPath}
const fs = require('fs');
const path = require('path');
const scenario = process.env.ROUTING_SCENARIO || 'sem-cenario';
const dir = path.join(${JSON.stringify(captures)}, scenario);
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, String(fs.readdirSync(dir).length).padStart(3, '0') + '.json'), JSON.stringify({ argv: process.argv.slice(2) }));
const prompt = process.argv[process.argv.indexOf('-p') + 1] || '';
const m = /\\/fetch-ticket (\\d+)/.exec(prompt);
if (m) {
    const taskId = m[1] + '-rt';
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

const REDMINE_KEY = 'chave-falsa-routing';
const calls = [];
const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
        calls.push({ method: req.method, path: new URL(req.url, 'http://x').pathname, body });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{}');
    });
});
const origin = () => `http://127.0.0.1:${server.address().port}`;

const GIT_ENV = {
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_AUTHOR_NAME: 'routing', GIT_AUTHOR_EMAIL: 'routing@example.invalid',
    GIT_COMMITTER_NAME: 'routing', GIT_COMMITTER_EMAIL: 'routing@example.invalid',
};
const git = (cwd, ...args) => execFileSync('git', args, { cwd, env: { PATH: process.env.PATH, ...GIT_ENV }, encoding: 'utf8' }).trim();

function policy(version = 'p-test-1', classifier = { provider: 'cheap_rule' }) {
    return {
        id: 'routing-sintetica', version, mode: 'ROUTED', classifier,
        class_to_tier: {
            C1: { tier: 'T1', effort: 'baixo' }, C2: { tier: 'T2', effort: 'médio' }, C3: { tier: 'T2', effort: 'alto' },
            C4: { tier: 'T3', effort: 'alto' }, C5: { tier: 'T3', effort: 'máximo' },
        },
        tiers: { T1: { models: ['m-t1'] }, T2: { models: ['m-t2'] }, T3: { models: ['m-t3'] } },
        default_route: { model_id: 'm-t3', effort: 'alto' },
        effort_map: { baixo: 'low', 'médio': 'medium', alto: 'high', 'máximo': 'max' },
    };
}

// Grava routing ON com policy válida (ou com sha divergente, para o caso inválido).
function writeRouting(repo, { version = 'p-test-1', badSha = false, classifier, extra = {} } = {}) {
    const bytes = JSON.stringify(policy(version, classifier));
    fs.writeFileSync(path.join(repo, '.claude', 'routing-policy.json'), bytes);
    const sha = badSha ? 'f'.repeat(64) : crypto.createHash('sha256').update(bytes).digest('hex');
    fs.writeFileSync(path.join(repo, '.claude', 'model-routing.json'), JSON.stringify({
        mode: 'ON', policy_ref: { id: 'routing-sintetica', version, sha256: sha, path: '.claude/routing-policy.json' },
        ...extra,
    }));
}

let repoCount = 0;
function consumer(setup = () => {}) {
    const root = path.join(tmp, `c${repoCount++}`);
    const repo = path.join(root, 'app-back');
    fs.mkdirSync(path.join(repo, '.claude'), { recursive: true });
    git(repo, 'init', '-q', '-b', 'development');
    git(repo, 'commit', '-q', '--allow-empty', '-m', 'base sintética');
    const remote = path.join(root, 'origin.git');
    fs.mkdirSync(remote, { recursive: true });
    git(remote, 'init', '-q', '--bare');
    git(repo, 'remote', 'add', 'origin', remote);
    git(repo, 'push', '-q', 'origin', 'development');
    setup(repo);
    return repo;
}

const fetchLog = path.join(tmp, 'fetch.jsonl');
const redminePuts = id => (fs.existsSync(fetchLog) ? fs.readFileSync(fetchLog, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) : [])
    .filter(c => c.method === 'PUT' && c.url.endsWith(`/issues/${id}.json`));

const journalLog = path.join(tmp, 'journals.jsonl');

function dispatch(repo, id, scenario, { follow = true, failPut = false } = {}) {
    const resultFile = path.join(results, `${scenario}-${Date.now()}.json`);
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
        ROUTING_SCENARIO: scenario,
        FETCH_LOG: fetchLog,
        JOURNAL_LOG: journalLog,
        ...(failPut ? { FAIL_PUT: failPut === true ? '1' : String(failPut) } : {}),
    };
    const args = [driver, WATCHER, String(id), resultFile, ...(follow ? ['--follow'] : [])];
    return new Promise(resolve => {
        execFile(process.execPath, args, { cwd: repo, env, timeout: 120000 }, (err, stdout, stderr) => {
            const result = fs.existsSync(resultFile) ? JSON.parse(fs.readFileSync(resultFile, 'utf8')) : null;
            resolve({ code: err ? err.code : 0, result, output: `${stdout}\n${stderr}` });
        });
    });
}

const worktreeOf = (repo, id) => path.join(repo, '.claude', 'worktrees', String(id));
const fetchRunDirOf = (repo, id) => path.join(worktreeOf(repo, id), 'memory', 'runs', '_dom06');
const taskDirOf = (repo, id) => path.join(worktreeOf(repo, id), 'memory', 'runs', `${id}-rt`);
const readState = (repo, id) => JSON.parse(fs.readFileSync(path.join(taskDirOf(repo, id), 'state.json'), 'utf8'));
const invocations = scenario => {
    const dir = path.join(captures, scenario);
    return fs.existsSync(dir) ? fs.readdirSync(dir).length : 0;
};

const argvOf = scenario => {
    const dir = path.join(captures, scenario);
    const [first] = fs.existsSync(dir) ? fs.readdirSync(dir).sort() : [];
    return first ? JSON.parse(fs.readFileSync(path.join(dir, first), 'utf8')).argv : null;
};
const flag = (argv, name) => { const i = argv.indexOf(name); return i === -1 ? null : argv[i + 1]; };

// Recusa que segue existindo em produção depois da SP-1 revista (só modelo): o plugin de
// roteamento não pode ser provado desligado. pluginConfigs ligado no settings do projeto
// (cwd do despacho = worktree) dá LOADED na prova (SP-2) → CONFIG_UNVERIFIABLE.
function blockPluginIn(dir) {
    fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.claude', 'settings.local.json'),
        JSON.stringify({ pluginConfigs: { 'jev-model-router@skills-dir': { enabled: true } } }));
}

test.before(() => new Promise(r => server.listen(0, '127.0.0.1', r)));
test.after(() => { server.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

// Run já admitida ON: o Attempt de admissão é gravado pelo DOM06 real com o snapshot da
// config do consumidor, e a task existe como o agente a teria criado. `bound` = state já
// ligado (T5); `pluginBlocked` = worktree com o plugin não neutralizável (recusa SP-2).
function seedOnRun(repo, id, { bound = true, node = 'implement', startedAt = new Date(Date.now() + 1000).toISOString(), retries = {}, pluginBlocked = false, classifierEffective = null, planText = null } = {}) {
    const worktree = worktreeOf(repo, id);
    fs.mkdirSync(worktree, { recursive: true });
    git(worktree, 'init', '-q', '-b', String(id));
    git(worktree, 'commit', '-q', '--allow-empty', '-m', `Melhoria #${id}`);
    if (pluginBlocked) blockPluginIn(worktree);
    const snapshot = mr.buildRoutingSnapshot(policyLoader.readRoutingConfig(repo), { classifierEffective });
    const fetch = dom06.prepareDispatch({
        runDir: fetchRunDirOf(repo, id), node: 'fetch_ticket', ticketId: id, baseBranch: 'development',
        specHash: null, cause: 'dispatch', routing: snapshot,
    });
    // Mesmo ponteiro que o watcher grava na admissão ON (MAJOR-1).
    routingRun.recordAdmission(fetchRunDirOf(repo, id), fetch.attempt);
    if (bound) routingRun.markConsumed(fetchRunDirOf(repo, id), `${id}-rt`);
    const dir = taskDirOf(repo, id);
    fs.mkdirSync(dir, { recursive: true });
    const history = ['fetch_ticket', 'plan', 'implement', 'review', 'test', 'verify'];
    fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({
        task_id: `${id}-rt`, node, history: history.slice(0, history.indexOf(node)), status: 'in_progress',
        started_at: startedAt, retries,
        ...(bound ? { routing_snapshot: { attempt_id: fetch.attempt.attempt_id, sha256: snapshot.sha256 } } : {}),
    }));
    fs.writeFileSync(path.join(dir, 'context.md'), '# Contexto\n');
    fs.writeFileSync(path.join(dir, 'plan.md'), planText || '# Plano\n\n## Passos\n\n1. Passo único.\n');
    return { fetch: fetch.attempt, snapshot, dir };
}

test('T5: a task liga-se ao snapshot da admissão; mudar a config depois não troca nada', async () => {
    const id = 233501;
    const repo = consumer(r => writeRouting(r));
    const { fetch, snapshot } = seedOnRun(repo, id, { bound: false });
    // Config muda depois da admissão: outra policy válida, outro sha.
    writeRouting(repo, { version: 'p-test-2' });
    const r = await dispatch(repo, id, 't5-on-no');
    assert.strictEqual(r.result?.action, 'dispatched', r.output);
    assert.deepStrictEqual(readState(repo, id).routing_snapshot, { attempt_id: fetch.attempt_id, sha256: snapshot.sha256 });
    assert.strictEqual(dom06.listAttempts(fetchRunDirOf(repo, id))[0].snapshot.routing.policy_ref.version, 'p-test-1');
    const [attempt] = dom06.listAttempts(taskDirOf(repo, id));
    assert.strictEqual(attempt.routing.snapshot_sha256, snapshot.sha256, 'a resolução usou o snapshot da admissão, não a config nova');
});

test('T5: Run admitida OFF (config ausente) não ganha snapshot nem campo no state', async () => {
    const id = 233502;
    const repo = consumer();
    assert.strictEqual((await dispatch(repo, id, 't5-off-admissao')).result?.action, 'dispatched');
    const [fetch] = dom06.listAttempts(fetchRunDirOf(repo, id));
    assert.deepStrictEqual(Object.keys(fetch.snapshot).sort(), ['base_branch', 'node', 'spec_hash', 'ticket_id']);
    // Ligar ON depois não muda a Run já admitida OFF.
    writeRouting(repo);
    assert.strictEqual((await dispatch(repo, id, 't5-off-no')).result?.action, 'dispatched');
    assert.ok(!('routing_snapshot' in readState(repo, id)));
});

test('T5/T6: admissão ON inválida recusa antes de worktree, marcador ou Attempt; nenhuma Run criada', async () => {
    const id = 233503;
    const repo = consumer(r => writeRouting(r, { badSha: true }));
    const r = await dispatch(repo, id, 't6-invalida');
    assert.deepStrictEqual(
        [r.result?.action, r.result?.reason, r.result?.cause],
        ['skip', 'routing_admission_blocked', 'POLICY_HASH_MISMATCH'], r.output,
    );
    assert.strictEqual(invocations('t6-invalida'), 0, 'o stub do claude não rodou');
    assert.ok(!fs.existsSync(worktreeOf(repo, id)), 'nenhum worktree de ticket');
    assert.ok(!fs.existsSync(path.join(repo, 'memory', 'runs', `${id}-spec-gate.json`)) ||
        !JSON.parse(fs.readFileSync(path.join(repo, 'memory', 'runs', `${id}-spec-gate.json`), 'utf8')).fetch_dispatch,
    'nenhum marcador fetch_dispatch');
});

test('T6: um aviso por projeto em 3 ticks; outro projeto OFF despacha; corrigir a policy libera no tick seguinte', async () => {
    const id = 233601;
    const other = 233602;
    const repo = consumer(r => writeRouting(r, { badSha: true }));
    for (let i = 0; i < 3; i++) {
        const r = await dispatch(repo, id, `t6-tick-${i}`, { follow: false });
        assert.strictEqual(r.result?.reason, 'routing_admission_blocked', r.output);
    }
    // Segundo ticket do mesmo projeto: bloqueado, mas sem segundo aviso.
    assert.strictEqual((await dispatch(repo, other, 't6-outro-ticket', { follow: false })).result?.reason, 'routing_admission_blocked');
    const puts = redminePuts(id);
    assert.strictEqual(puts.length, 1, 'exatamente um comentário no Redmine para o projeto');
    const note = JSON.parse(puts[0].body).issue.notes;
    assert.match(note, /POLICY_HASH_MISMATCH/);
    assert.match(note, /"mode": "OFF"|mode OFF/);
    assert.strictEqual(redminePuts(other).length, 0);
    const marker = JSON.parse(fs.readFileSync(path.join(repo, 'memory', 'runs', 'routing-admission-blocked.json'), 'utf8'));
    assert.deepStrictEqual([marker.cause, marker.tickets], ['POLICY_HASH_MISMATCH', [id, other]]);

    // Projeto OFF na mesma máquina segue admitindo normalmente.
    const off = consumer();
    assert.strictEqual((await dispatch(off, 233603, 't6-projeto-off')).result?.action, 'dispatched');

    // Policy corrigida: o próximo tick passa da admissão (marcador some) e o ticket novo é
    // despachado roteado (SP-1 revista: só modelo).
    writeRouting(repo);
    const fixed = await dispatch(repo, id, 't6-corrigida', { follow: false });
    assert.strictEqual(fixed.result?.action, 'dispatched', fixed.output);
    assert.ok(!fs.existsSync(path.join(repo, 'memory', 'runs', 'routing-admission-blocked.json')), 'marcador removido');
});

// ── T7: resolução no despacho por nó ──────────────────────────────────────────

test('T7 / AC-02 / AC-07: Run ON em andamento → despacho roteado só por modelo (--model e --settings, sem --effort)', async () => {
    const id = 233704;
    const repo = consumer(r => writeRouting(r));
    const { dir, snapshot } = seedOnRun(repo, id);
    const r = await dispatch(repo, id, 't7-roteado');
    assert.strictEqual(r.result?.action, 'dispatched', r.output);
    const argv = argvOf('t7-roteado');
    assert.strictEqual(flag(argv, '--model'), 'm-t3', 'C4 conservador → T3');
    assert.ok(!argv.includes('--effort'), 'esforço adiado (SP-1 revista)');
    const settings = flag(argv, '--settings');
    assert.ok(settings && settings.startsWith(dir), '--settings gerado no diretório da Run');
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(settings, 'utf8')).enabledPlugins['jev-model-router@skills-dir'], false);
    const [a] = dom06.listAttempts(dir);
    assert.deepStrictEqual([a.started, a.routing.snapshot_sha256, a.routing.effort_applied, a.routing.effort_router_plugin],
        [true, snapshot.sha256, false, 'NOT_LOADED']);
    assert.strictEqual(a.routing.subagent, 'UNENFORCED');
});

test('T7 / AC-08: plugin não neutralizável → 1 Attempt NOT_STARTED, Run blocked e 1 aviso em 3 ticks; agente nunca roda', async () => {
    const id = 233701;
    const repo = consumer(r => writeRouting(r));
    const { dir, snapshot } = seedOnRun(repo, id, { pluginBlocked: true });
    for (let i = 0; i < 3; i++) await dispatch(repo, id, `t7-andamento-${i}`, { follow: false });
    for (let i = 0; i < 3; i++) assert.strictEqual(invocations(`t7-andamento-${i}`), 0, 'o stub do claude não rodou');
    const attempts = dom06.listAttempts(dir);
    assert.deepStrictEqual(attempts.map(a => [a.node, a.started, a.result]), [['implement', false, 'NOT_STARTED']]);
    const [a] = attempts;
    assert.deepStrictEqual(a.not_started, { cause: 'CONFIG_UNVERIFIABLE', detail: 'PLUGIN_NOT_PROVEN_OFF' });
    assert.strictEqual(a.routing.snapshot_sha256, snapshot.sha256);
    assert.strictEqual(a.routing.class, 'C4', 'sinais do Plano sintético sem grupos completos → C4 conservador');
    assert.deepStrictEqual(a.routing.chosen, { model_id: 'm-t3', effort: 'alto', cli_effort: 'high', tier: 'T3' });
    assert.strictEqual(a.routing.effort_router_plugin, 'LOADED');
    assert.strictEqual(readState(repo, id).status, 'blocked');
    assert.strictEqual(redminePuts(id).length, 1, 'um único aviso');
    assert.match(JSON.parse(redminePuts(id)[0].body).issue.notes, /PLUGIN_NOT_PROVEN_OFF/);
});

test('T7 / AC-05: snapshot adulterado → NOT_STARTED/CONFIG_UNVERIFIABLE, sem reler a config corrente (OFF)', async () => {
    const id = 233702;
    const repo = consumer(r => writeRouting(r));
    const { fetch, dir } = seedOnRun(repo, id);
    const file = path.join(fetchRunDirOf(repo, id), 'dom06', 'attempts', `${fetch.attempt_id}.json`);
    const a = JSON.parse(fs.readFileSync(file, 'utf8'));
    a.snapshot.routing.default_route.model_id = 'm-t1';
    fs.writeFileSync(file, JSON.stringify(a));
    // Config corrente OFF: se fosse relida, o nó despacharia AS-IS.
    fs.rmSync(path.join(repo, '.claude', 'model-routing.json'));
    const r = await dispatch(repo, id, 't7-adulterado');
    assert.strictEqual(r.result?.reason, 'routing_not_started', r.output);
    assert.strictEqual(invocations('t7-adulterado'), 0);
    const [ns] = dom06.listAttempts(dir);
    assert.deepStrictEqual(ns.not_started, { cause: 'CONFIG_UNVERIFIABLE', detail: 'snapshot_hash_mismatch' });
    assert.strictEqual(ns.routing, undefined, 'sem snapshot íntegro não há decisão');
});

// Ticket novo recusado: sem Run não há Attempt; a recusa fica no marcador
// RUNS_DIR/<ticket>-routing-not-started.json. Recusas que não dependem do plugin saem
// antes de branch/worktree (Bugbot, PR #97); a do plugin (settings do worktree) depois.
const notStartedMarker = (repo, id) => path.join(repo, 'memory', 'runs', `${id}-routing-not-started.json`);

// Consumidor com o plugin não neutralizável já na base (o worktree do ticket herda).
function blockedConsumer() {
    return consumer(r => {
        writeRouting(r);
        blockPluginIn(r);
        git(r, 'add', '.claude/settings.local.json');
        git(r, 'commit', '-q', '-m', 'plugin router ligado');
        git(r, 'push', '-q', 'origin', 'development');
    });
}

test('T7 / AC-03: ticket novo ON → fetch_ticket+plan no default_route, roteado só por modelo', async () => {
    const id = 233703;
    const repo = consumer(r => writeRouting(r));
    const r = await dispatch(repo, id, 't7-novo');
    assert.strictEqual(r.result?.action, 'dispatched', r.output);
    const argv = argvOf('t7-novo');
    assert.match(argv[argv.indexOf('-p') + 1], /\/fetch-ticket 233703/);
    assert.strictEqual(flag(argv, '--model'), 'm-t3', 'nós fixos no default_route (D6)');
    assert.ok(!argv.includes('--effort'));
    assert.ok(flag(argv, '--settings'));
    const [fetch] = dom06.listAttempts(fetchRunDirOf(repo, id));
    assert.deepStrictEqual([fetch.started, fetch.routing.selection_source, fetch.routing.chosen.model_id], [true, 'FIXED_NODE', 'm-t3']);
    assert.ok(!fs.existsSync(notStartedMarker(repo, id)));
});

test('T7: ticket novo ON com plugin não neutralizável → recusa sem Run e 1 aviso em 3 ticks', async () => {
    const id = 233705;
    const repo = blockedConsumer();
    for (let i = 0; i < 3; i++) {
        const r = await dispatch(repo, id, `t7-novo-bloq-${i}`, { follow: false });
        assert.strictEqual(r.result?.reason, 'routing_not_started', r.output);
        assert.strictEqual(invocations(`t7-novo-bloq-${i}`), 0);
    }
    const marker = JSON.parse(fs.readFileSync(notStartedMarker(repo, id), 'utf8'));
    assert.deepStrictEqual([marker.node, marker.result, marker.cause, marker.detail],
        ['fetch_ticket', 'NOT_STARTED', 'CONFIG_UNVERIFIABLE', 'PLUGIN_NOT_PROVEN_OFF']);
    assert.deepStrictEqual(marker.routing.chosen, { model_id: 'm-t3', effort: 'alto', cli_effort: 'high', tier: 'T3' });
    assert.ok(marker.notified_at, 'aviso marcado depois de enviado');
    assert.strictEqual(redminePuts(id).length, 1);
    assert.ok(!fs.existsSync(taskDirOf(repo, id)), 'nenhuma task criada');
    // Revisão independente (MAJOR-2): a recusa sai na pré-checagem, sem tocar no git.
    assert.ok(!fs.existsSync(worktreeOf(repo, id)), 'nenhum worktree criado para ticket recusado');
    assert.strictEqual(git(repo, 'branch', '--list', String(id)), '', 'nenhuma branch do ticket criada');
    assert.strictEqual(marker.routing.effort_router_plugin, 'LOADED');
});

test('Bugbot (PR #97): aviso que não chegou ao Redmine é tentado de novo no tick seguinte', async () => {
    const recusado = 233706;
    const repo = blockedConsumer();
    await dispatch(repo, recusado, 'b-falha-1', { follow: false, failPut: true });
    assert.strictEqual(redminePuts(recusado).length, 1);
    assert.strictEqual(JSON.parse(fs.readFileSync(notStartedMarker(repo, recusado), 'utf8')).notified_at, null);
    await dispatch(repo, recusado, 'b-falha-2', { follow: false });
    assert.strictEqual(redminePuts(recusado).length, 2, 'tentou de novo');
    assert.ok(JSON.parse(fs.readFileSync(notStartedMarker(repo, recusado), 'utf8')).notified_at);
    await dispatch(repo, recusado, 'b-falha-3', { follow: false });
    assert.strictEqual(redminePuts(recusado).length, 2, 'depois de enviado, não repete');

    // Mesmo comportamento no aviso de admissão recusada por config inválida (por projeto).
    const invalido = consumer(r => writeRouting(r, { badSha: true }));
    const blocked = path.join(invalido, 'memory', 'runs', 'routing-admission-blocked.json');
    await dispatch(invalido, 233707, 'b-falha-adm-1', { follow: false, failPut: true });
    assert.strictEqual(JSON.parse(fs.readFileSync(blocked, 'utf8')).notified_at, null);
    await dispatch(invalido, 233707, 'b-falha-adm-2', { follow: false });
    assert.strictEqual(redminePuts(233707).length, 2);
    assert.ok(JSON.parse(fs.readFileSync(blocked, 'utf8')).notified_at);
});

// Revisão independente (MAJOR-1, AGENTS.md regra 5): resultado incerto não é reenviado às
// cegas; falha certa é tentada de novo até o teto e depois desiste.
test('MAJOR-1: PUT com resultado incerto (gravou e caiu) não duplica a nota: confere journals e marca como dado', async () => {
    const id = 233708;
    const repo = blockedConsumer();
    await dispatch(repo, id, 'm1-incerto-1', { follow: false, failPut: 'timeout' });
    const m1 = JSON.parse(fs.readFileSync(notStartedMarker(repo, id), 'utf8'));
    assert.deepStrictEqual([m1.notified_at, Boolean(m1.notice_uncertain_at)], [null, true]);
    await dispatch(repo, id, 'm1-incerto-2', { follow: false });
    await dispatch(repo, id, 'm1-incerto-3', { follow: false });
    assert.strictEqual(redminePuts(id).length, 1, 'a nota que já tinha gravado não é repetida');
    const m2 = JSON.parse(fs.readFileSync(notStartedMarker(repo, id), 'utf8'));
    assert.ok(m2.notified_at, 'achou o token nos journals e marcou como dado');
    assert.match(JSON.parse(redminePuts(id)[0].body).issue.notes, /\[aviso-roteamento [0-9a-f]{12}\]/);
});

test('MAJOR-1: falha certa (503) é tentada até o teto e depois desiste, sem repetir para sempre', async () => {
    const id = 233709;
    const repo = blockedConsumer();
    for (let i = 0; i < 7; i++) await dispatch(repo, id, `m1-certa-${i}`, { follow: false, failPut: true });
    assert.strictEqual(redminePuts(id).length, 5, 'teto de 5 tentativas');
    const m = JSON.parse(fs.readFileSync(notStartedMarker(repo, id), 'utf8'));
    assert.deepStrictEqual([m.notified_at, m.notice_attempts, Boolean(m.notice_failed_at)], [null, 5, true]);
});

// ── Revisão do Checkpoint B ────────────────────────────────────────────────────

const onlyAttempt = dir => {
    const all = dom06.listAttempts(dir);
    assert.strictEqual(all.length, 1, JSON.stringify(all.map(a => [a.node, a.result])));
    return all[0];
};

test('MAJOR-1 (a): Attempt de admissão apagado antes do 1º nó → NOT_STARTED, nunca OFF com modelo herdado', async () => {
    const id = 233801;
    const repo = consumer(r => writeRouting(r));
    const { fetch, dir } = seedOnRun(repo, id, { bound: false });
    fs.rmSync(path.join(fetchRunDirOf(repo, id), 'dom06', 'attempts', `${fetch.attempt_id}.json`));
    const r = await dispatch(repo, id, 'b-a-apagado');
    assert.strictEqual(r.result?.reason, 'routing_not_started', r.output);
    assert.strictEqual(invocations('b-a-apagado'), 0);
    assert.deepStrictEqual(onlyAttempt(dir).not_started, { cause: 'CONFIG_UNVERIFIABLE', detail: 'snapshot_unreadable' });
});

test('MAJOR-1 (b): started_at anterior à admissão não esconde o snapshot (liga pelo ponteiro)', async () => {
    const id = 233802;
    const repo = consumer(r => writeRouting(r));
    const { fetch, snapshot, dir } = seedOnRun(repo, id, { bound: false, startedAt: '1999-01-01T00:00:00.000Z' });
    const r = await dispatch(repo, id, 'b-b-passado');
    assert.strictEqual(r.result?.action, 'dispatched', r.output);
    assert.deepStrictEqual(readState(repo, id).routing_snapshot, { attempt_id: fetch.attempt_id, sha256: snapshot.sha256 });
    assert.strictEqual(onlyAttempt(dir).routing.snapshot_sha256, snapshot.sha256);
});

test('MAJOR-1 (d): ligação apagada do state depois de ligada → recusa, sem religar', async () => {
    const id = 233803;
    const repo = consumer(r => writeRouting(r));
    const { dir } = seedOnRun(repo, id);
    const statePath = path.join(dir, 'state.json');
    const s = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    delete s.routing_snapshot;
    fs.writeFileSync(statePath, JSON.stringify(s));
    const r = await dispatch(repo, id, 'b-d-religar');
    assert.deepStrictEqual([r.result?.reason, r.result?.detail], ['routing_not_started', 'snapshot_binding_lost'], r.output);
    assert.ok(!('routing_snapshot' in readState(repo, id)), 'não religou');
});

test('MINOR-1 + retry: recusa ON em retry grava cause retry e não consome human-input.md', async () => {
    const id = 233804;
    const repo = consumer(r => writeRouting(r));
    const { dir } = seedOnRun(repo, id, { retries: { implement: 1 }, pluginBlocked: true });
    fs.writeFileSync(path.join(dir, 'human-input.md'), 'pode seguir\n');
    const r = await dispatch(repo, id, 'b-retry');
    assert.strictEqual(r.result?.reason, 'routing_not_started', r.output);
    const a = onlyAttempt(dir);
    assert.deepStrictEqual([a.cause, a.result], ['retry', 'NOT_STARTED']);
    assert.ok(fs.existsSync(path.join(dir, 'human-input.md')), 'a mensagem humana não foi consumida pela recusa');
});

test('MAJOR-1: admissão OFF depois de um ciclo ON apaga o ponteiro (a Run nova fica OFF)', async () => {
    const id = 233805;
    const repo = consumer();
    const ptr = path.join(fetchRunDirOf(repo, id), 'routing-admission.json');
    fs.mkdirSync(path.dirname(ptr), { recursive: true });
    fs.writeFileSync(ptr, JSON.stringify({ attempt_id: '00000000-0000-4000-8000-000000000000', sha256: 'a'.repeat(64), consumed_by: '233805-velho' }));
    const r = await dispatch(repo, id, 'b-off-limpa');
    assert.strictEqual(r.result?.action, 'dispatched', r.output);
    assert.ok(!fs.existsSync(ptr), 'ponteiro do ciclo ON anterior removido');
    const next = await dispatch(repo, id, 'b-off-limpa-no');
    assert.strictEqual(next.result?.action, 'dispatched', next.output);
    assert.ok(!('routing_snapshot' in readState(repo, id)));
});

// ── T8: override humano no watcher ─────────────────────────────────────────────

function addToState(dir, extra) {
    const p = path.join(dir, 'state.json');
    fs.writeFileSync(p, JSON.stringify({ ...JSON.parse(fs.readFileSync(p, 'utf8')), ...extra }));
}
const override = (ref, value, recordedAt, extra = {}) => ({
    ref, scope: 'node', node: 'implement', value, by: 'richard', via: 'dashboard', recorded_at: recordedAt, ...extra,
});

test('T8 / AC-09: override vigente entra na decisão (HUMAN_OVERRIDE); inelegível vira PROVIDER_NOT_ELIGIBLE', async () => {
    const id = 233901;
    const repo = consumer(r => writeRouting(r));
    const { dir } = seedOnRun(repo, id);
    addToState(dir, { routing_overrides: [override('RO-1', { model_id: 'm-t2', effort: 'médio' }, '2026-11-06T10:00:00.000Z')] });
    const res = await dispatch(repo, id, 't8-vigente');
    assert.strictEqual(res.result?.action, 'dispatched', res.output);
    assert.strictEqual(flag(argvOf('t8-vigente'), '--model'), 'm-t2', 'o despacho usa o modelo da override');
    const [a] = dom06.listAttempts(dir);
    assert.strictEqual(a.started, true);
    assert.deepStrictEqual([a.routing.selection_source, a.routing.override_ref.ref, a.routing.chosen.model_id], ['HUMAN_OVERRIDE', 'RO-1', 'm-t2']);
    // Bugbot (PR #97): o limite do 1º Attempt da visita fica gravado para os retries.
    const visit = readState(repo, id).routing_visit;
    assert.strictEqual(visit.node, 'implement');
    assert.ok(Date.parse(visit.at) <= Date.now());

    const bad = 233902;
    const repo2 = consumer(r => writeRouting(r));
    const seeded = seedOnRun(repo2, bad);
    addToState(seeded.dir, { routing_overrides: [override('RO-1', { model_id: 'm-fora-da-policy', effort: 'alto' }, '2026-11-06T10:00:00.000Z')] });
    const r = await dispatch(repo2, bad, 't8-inelegivel');
    assert.deepStrictEqual([r.result?.reason, r.result?.cause, r.result?.detail], ['routing_not_started', 'PROVIDER_NOT_ELIGIBLE', 'override_ineligible'], r.output);
});

test('T8 / D-4: override gravada no meio da visita ao nó não vale no retry do mesmo nó', async () => {
    const id = 233903;
    const repo = consumer(r => writeRouting(r));
    const { dir } = seedOnRun(repo, id, { retries: { implement: 1 } });
    addToState(dir, {
        events: [
            { type: 'node_start', node: 'implement', ts: '2026-11-06T11:00:00.000Z', agent: 'claude' },
            { type: 'node_error', node: 'implement', ts: '2026-11-06T11:20:00.000Z', agent: 'claude', exit_code: 1 },
        ],
        routing_overrides: [override('RO-1', { model_id: 'm-t2', effort: 'médio' }, '2026-11-06T11:10:00.000Z')],
    });
    await dispatch(repo, id, 't8-meio-do-no');
    const [a] = dom06.listAttempts(dir);
    assert.strictEqual(a.cause, 'retry');
    assert.strictEqual(a.routing.override_ref, null, 'override do meio do nó não vale neste Attempt');
    assert.deepStrictEqual(a.routing.overrides_pending, ['RO-1']);
});

// PRI-205 S3b T5: núcleo 2 na admissão. Hoje não há Authority Ref: a Run é admitida
// normalmente e o snapshot registra o núcleo 2 off com o motivo (nunca bloqueia).
test('S3b T5 / AC-07: policy jev sem Authority Ref → admitida, snapshot com núcleo 2 off (AUTHORITY_REF_ABSENT)', async () => {
    const jevClient = require('./jev-client');
    const id = 205501;
    const classifier = {
        provider: 'jev', mode: 'shadow', model_id: 'jev-latest', timeout_ms: 3000,
        prompt_ref: { id: 'prisma-class-prompt', version: '1', sha256: jevClient.promptSha256() },
        enum_version: jevClient.ENUM_VERSION, destination: jevClient.DESTINATION_ID,
    };
    const repo = consumer(r => writeRouting(r, { classifier, extra: { classifier_credential: { keychain: 'prisma-jev-typesafe', account: 'typesafe' } } }));
    const r = await dispatch(repo, id, 's3b-t5-sem-ref');
    assert.strictEqual(r.result?.action, 'dispatched', r.output);
    const [fetch] = dom06.listAttempts(fetchRunDirOf(repo, id));
    const eff = fetch.snapshot.routing.classifier_effective;
    assert.deepStrictEqual([eff.provider, eff.declared, eff.reason, eff.credential], ['off', 'jev', 'AUTHORITY_REF_ABSENT', null]);
    assert.strictEqual(flag(argvOf('s3b-t5-sem-ref'), '--model'), 'm-t3', 'o despacho segue igual');
});

// PRI-205 S3b T7: Run ON com o Jev efetivo no snapshot. O item do Keychain não existe
// (nome de teste), então nada é enviado: o núcleo 2 fica registrado na decisão, sem
// Attempt de efeito, e o despacho é o do núcleo 1.
test('S3b T7 / AC-01 / AC-02: jev efetivo sem credencial → núcleo 2 registrado, nenhum Attempt classifier, mesmo modelo', async () => {
    const jevClient = require('./jev-client');
    const id = 205701;
    const classifier = {
        provider: 'jev', mode: 'shadow', model_id: 'jev-latest', timeout_ms: 3000,
        prompt_ref: { id: 'p', version: '1', sha256: jevClient.promptSha256() },
        enum_version: jevClient.ENUM_VERSION, destination: jevClient.DESTINATION_ID,
    };
    const repo = consumer(r => writeRouting(r, { classifier }));
    const mirrorBytes = Buffer.from(JSON.stringify({ id: 'ref-teste', revoked_at: null }));
    fs.writeFileSync(path.join(repo, '.claude', 'classifier-authority.json'), mirrorBytes);
    const eff = {
        provider: 'jev', declared: 'jev', mode: 'shadow', reason: null, detail: null,
        authority_ref: { id: 'ref-teste', sha256: crypto.createHash('sha256').update(mirrorBytes).digest('hex'), path: '.claude/classifier-authority.json' },
        credential: { keychain: 'prisma-jev-teste-inexistente', account: 'teste' },
        model_id: 'jev-latest', timeout_ms: 3000, guard_version: 'classifier-guard@1',
    };
    const planText = '# Plano\n\n## Plano de execução\n1. Ajustar a listagem\n   - Arquivo: `backend/svc-a/src/a.js`\n   - Critérios: AC-01\n   - Verificação: teste.\n';
    const { dir } = seedOnRun(repo, id, { classifierEffective: eff, planText });
    fs.mkdirSync(path.join(worktreeOf(repo, id), 'memory', 'spec'), { recursive: true });
    fs.writeFileSync(path.join(worktreeOf(repo, id), 'memory', 'spec', `${id}-spec.md`), '## Critérios de Aceite\n- AC-01: a listagem aparece.\n');
    const r = await dispatch(repo, id, 's3b-t7-jev');
    assert.strictEqual(r.result?.action, 'dispatched', r.output);
    const attempts = dom06.listAttempts(dir);
    assert.strictEqual(attempts.filter(a => a.node === 'classifier').length, 0, 'sem credencial nada é emitido');
    const [impl] = attempts.filter(a => a.node === 'implement');
    assert.strictEqual(impl.routing.classifier_ref.provider, 'jev');
    assert.strictEqual(impl.routing.nucleus2.status, 'ON');
    assert.ok(impl.routing.nucleus2.groups.length >= 1);
    assert.deepStrictEqual(impl.routing.nucleus2.groups.map(g => [g.status, g.probe]), [['CREDENTIAL_UNAVAILABLE', 'UPGRADE_PROBE']], JSON.stringify(impl.routing.nucleus2.groups));
    assert.strictEqual(flag(argvOf('s3b-t7-jev'), '--model'), impl.routing.chosen.model_id, 'argv = escolha do núcleo 1');
});

test('S3b T7 / AC-01: Run ON cheap_rule → sem núcleo 2 na decisão e sem Attempt classifier', async () => {
    const id = 205702;
    const repo = consumer(r => writeRouting(r));
    const { dir } = seedOnRun(repo, id);
    const r = await dispatch(repo, id, 's3b-t7-cheap');
    assert.strictEqual(r.result?.action, 'dispatched', r.output);
    const attempts = dom06.listAttempts(dir);
    assert.strictEqual(attempts.filter(a => a.node === 'classifier').length, 0);
    const [impl] = attempts.filter(a => a.node === 'implement');
    assert.deepStrictEqual([impl.routing.nucleus2, impl.routing.classifier_ref.provider], [null, 'cheap_rule']);
});
