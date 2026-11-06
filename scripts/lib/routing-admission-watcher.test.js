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

function dispatch(repo, id, scenario, { follow = true } = {}) {
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

test('T5: admissão ON fixa o snapshot no fetch_ticket; a task liga-se a ele e mudar a config depois não troca nada', async () => {
    const id = 233501;
    const repo = consumer(r => writeRouting(r));
    const first = await dispatch(repo, id, 't5-on-admissao');
    assert.strictEqual(first.result?.action, 'dispatched', first.output);

    const [fetch] = dom06.listAttempts(fetchRunDirOf(repo, id));
    assert.strictEqual(fetch.node, 'fetch_ticket');
    const snap = fetch.snapshot.routing;
    assert.ok(snap && snap.mode === 'ON', 'o snapshot routing está no Attempt de admissão');
    assert.strictEqual(snap.policy_ref.version, 'p-test-1');
    assert.ok(!('routing_snapshot' in readState(repo, id)), 'a ligação só é gravada no primeiro despacho de nó');

    // Config muda depois da admissão: outra policy válida, outro sha.
    writeRouting(repo, { version: 'p-test-2' });
    const second = await dispatch(repo, id, 't5-on-no');
    assert.strictEqual(second.result?.action, 'dispatched', second.output);
    assert.deepStrictEqual(readState(repo, id).routing_snapshot, { attempt_id: fetch.attempt_id, sha256: snap.sha256 });
    assert.strictEqual(dom06.listAttempts(fetchRunDirOf(repo, id))[0].snapshot.routing.policy_ref.version, 'p-test-1');
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

    // Policy corrigida: o próximo tick admite e o marcador some.
    writeRouting(repo);
    const fixed = await dispatch(repo, id, 't6-corrigida', { follow: false });
    assert.strictEqual(fixed.result?.action, 'dispatched', fixed.output);
    assert.ok(!fs.existsSync(path.join(repo, 'memory', 'runs', 'routing-admission-blocked.json')), 'marcador removido');
});
