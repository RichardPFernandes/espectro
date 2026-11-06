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
global.fetch = async (url, opts = {}) => {
    fs.appendFileSync(process.env.FETCH_LOG, JSON.stringify({ url: String(url), method: opts.method || 'GET', body: opts.body || null }) + '\\n');
    // FAIL_PUT=1: o Redmine responde 500 aos PUTs (aviso que não chegou).
    if (process.env.FAIL_PUT === '1' && opts.method === 'PUT') return { ok: false, status: 500, json: async () => ({}), text: async () => '' };
    return { ok: true, status: 204, json: async () => ({}), text: async () => '' };
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

function policy(version = 'p-test-1') {
    return {
        id: 'routing-sintetica', version, mode: 'ROUTED', classifier: { provider: 'cheap_rule' },
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
function writeRouting(repo, { version = 'p-test-1', badSha = false } = {}) {
    const bytes = JSON.stringify(policy(version));
    fs.writeFileSync(path.join(repo, '.claude', 'routing-policy.json'), bytes);
    const sha = badSha ? 'f'.repeat(64) : crypto.createHash('sha256').update(bytes).digest('hex');
    fs.writeFileSync(path.join(repo, '.claude', 'model-routing.json'), JSON.stringify({
        mode: 'ON', policy_ref: { id: 'routing-sintetica', version, sha256: sha, path: '.claude/routing-policy.json' },
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
        ...(failPut ? { FAIL_PUT: '1' } : {}),
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

test.before(() => new Promise(r => server.listen(0, '127.0.0.1', r)));
test.after(() => { server.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

// Run já admitida ON (o fetch_ticket ON nunca inicia em produção hoje, SP-1): o
// Attempt de admissão é gravado pelo DOM06 real com o snapshot da config do consumidor,
// e a task existe como o agente a teria criado. `bound` = state já ligado (T5).
function seedOnRun(repo, id, { bound = true, node = 'implement', startedAt = new Date(Date.now() + 1000).toISOString(), retries = {} } = {}) {
    const worktree = worktreeOf(repo, id);
    fs.mkdirSync(worktree, { recursive: true });
    git(worktree, 'init', '-q', '-b', String(id));
    git(worktree, 'commit', '-q', '--allow-empty', '-m', `Melhoria #${id}`);
    const snapshot = mr.buildRoutingSnapshot(policyLoader.readRoutingConfig(repo));
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
    fs.writeFileSync(path.join(dir, 'plan.md'), '# Plano\n\n## Passos\n\n1. Passo único.\n');
    return { fetch: fetch.attempt, snapshot, dir };
}

test('T5: a task liga-se ao snapshot da admissão; mudar a config depois não troca nada', async () => {
    const id = 233501;
    const repo = consumer(r => writeRouting(r));
    const { fetch, snapshot } = seedOnRun(repo, id, { bound: false });
    // Config muda depois da admissão: outra policy válida, outro sha.
    writeRouting(repo, { version: 'p-test-2' });
    const r = await dispatch(repo, id, 't5-on-no');
    assert.strictEqual(r.result?.reason, 'routing_not_started', r.output);
    assert.deepStrictEqual(readState(repo, id).routing_snapshot, { attempt_id: fetch.attempt_id, sha256: snapshot.sha256 });
    assert.strictEqual(dom06.listAttempts(fetchRunDirOf(repo, id))[0].snapshot.routing.policy_ref.version, 'p-test-1');
    const [notStarted] = dom06.listAttempts(taskDirOf(repo, id));
    assert.strictEqual(notStarted.routing.snapshot_sha256, snapshot.sha256, 'a resolução usou o snapshot da admissão, não a config nova');
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

    // Policy corrigida: o próximo tick passa da admissão (marcador some). Em produção o
    // fetch_ticket roteado ainda para em NOT_STARTED (SP-1, coberto pelos testes T7).
    writeRouting(repo);
    const fixed = await dispatch(repo, id, 't6-corrigida', { follow: false });
    assert.strictEqual(fixed.result?.reason, 'routing_not_started', fixed.output);
    assert.ok(!fs.existsSync(path.join(repo, 'memory', 'runs', 'routing-admission-blocked.json')), 'marcador removido');
});

// ── T7: resolução no despacho por nó ──────────────────────────────────────────

test('T7 / AC-07: Run ON em andamento em produção → 1 Attempt NOT_STARTED, Run blocked e 1 aviso em 3 ticks; agente nunca roda', async () => {
    const id = 233701;
    const repo = consumer(r => writeRouting(r));
    const { dir, snapshot } = seedOnRun(repo, id);
    for (let i = 0; i < 3; i++) await dispatch(repo, id, `t7-andamento-${i}`, { follow: false });
    for (let i = 0; i < 3; i++) assert.strictEqual(invocations(`t7-andamento-${i}`), 0, 'o stub do claude não rodou');
    const attempts = dom06.listAttempts(dir);
    assert.deepStrictEqual(attempts.map(a => [a.node, a.started, a.result]), [['implement', false, 'NOT_STARTED']]);
    const [a] = attempts;
    assert.deepStrictEqual(a.not_started, { cause: 'CONFIG_UNVERIFIABLE', detail: 'EFFORT_MECHANISM_UNAVAILABLE' });
    assert.strictEqual(a.routing.snapshot_sha256, snapshot.sha256);
    assert.strictEqual(a.routing.class, 'C4', 'sinais do Plano sintético sem grupos completos → C4 conservador');
    assert.deepStrictEqual(a.routing.chosen, { model_id: 'm-t3', effort: 'alto', cli_effort: 'high', tier: 'T3' });
    assert.deepStrictEqual(a.routing.effort_mechanism, { status: 'UNAVAILABLE' });
    assert.strictEqual(a.routing.subagent, 'UNENFORCED');
    assert.strictEqual(readState(repo, id).status, 'blocked');
    assert.strictEqual(redminePuts(id).length, 1, 'um único aviso');
    assert.match(JSON.parse(redminePuts(id)[0].body).issue.notes, /EFFORT_MECHANISM_UNAVAILABLE/);
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

// Bugbot (PR #97): ticket novo recusado não cria branch nem worktree; sem Run não há
// Attempt, a recusa fica no marcador RUNS_DIR/<ticket>-routing-not-started.json.
const notStartedMarker = (repo, id) => path.join(repo, 'memory', 'runs', `${id}-routing-not-started.json`);

test('T7 / AC-03: ticket novo ON → fetch_ticket+plan no default_route, recusa sem worktree e 1 aviso em 3 ticks', async () => {
    const id = 233703;
    const repo = consumer(r => writeRouting(r));
    for (let i = 0; i < 3; i++) {
        const r = await dispatch(repo, id, `t7-novo-${i}`, { follow: false });
        assert.strictEqual(r.result?.reason, 'routing_not_started', r.output);
        assert.strictEqual(invocations(`t7-novo-${i}`), 0);
    }
    assert.ok(!fs.existsSync(worktreeOf(repo, id)), 'nenhum worktree criado para ticket recusado');
    assert.strictEqual(git(repo, 'branch', '--list', String(id)), '', 'nenhuma branch do ticket criada');
    const marker = JSON.parse(fs.readFileSync(notStartedMarker(repo, id), 'utf8'));
    assert.deepStrictEqual([marker.node, marker.result, marker.cause, marker.detail],
        ['fetch_ticket', 'NOT_STARTED', 'CONFIG_UNVERIFIABLE', 'EFFORT_MECHANISM_UNAVAILABLE']);
    assert.deepStrictEqual(marker.routing.chosen, { model_id: 'm-t3', effort: 'alto', cli_effort: 'high', tier: 'T3' });
    assert.strictEqual(marker.routing.selection_source, 'FIXED_NODE');
    assert.ok(marker.notified_at, 'aviso marcado depois de enviado');
    assert.strictEqual(redminePuts(id).length, 1);
    assert.ok(!fs.existsSync(taskDirOf(repo, id)), 'nenhuma task criada');
});

test('Bugbot (PR #97): aviso que não chegou ao Redmine é tentado de novo no tick seguinte', async () => {
    const recusado = 233706;
    const repo = consumer(r => writeRouting(r));
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
    assert.strictEqual(r.result?.reason, 'routing_not_started', r.output);
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
    const { dir } = seedOnRun(repo, id, { retries: { implement: 1 } });
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
