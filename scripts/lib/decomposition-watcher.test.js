// node --test scripts/lib/decomposition-watcher.test.js
// PRI-311 (PRI-287 S5.2b): Run decomposta no watcher real, modo destacado (sem --follow).
// AC-26: ciclo completo de duas subtarefas + integração; AC-22: ordem, uma por tick, transição
// implement → review pelo watcher só com a agregação, Review sem agregação → blocked, Review
// como gate com manifesto (H7); AC-29: implement.md/review.md/commit.md iguais aos de 2024597.
//
// Cada tick roda o watcher desta revisão num processo próprio, com um consumidor sintético
// (repo git com origin bare local) e um `claude` stub no PATH, que faz o trabalho do comando
// de passo (escreve nos arquivos do escopo do bloco de contexto). O release do lease roda no
// wrapper `sh` destacado (node-lease.js release), como em produção. A decomposição é ligada
// injetando a admissão no harness (snapshot com decomposition "on"), nunca pela config do
// consumidor, que continua recusando "on" (DECOMPOSITION_RESERVED). Nada sai da máquina.
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

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(process.env.CLAUDE_JOB_DIR ? path.join(process.env.CLAUDE_JOB_DIR, 'tmp') : os.tmpdir(), 'deco-watcher-')));
const binDir = path.join(tmp, 'bin');
const captures = path.join(tmp, 'captures');
const results = path.join(tmp, 'results');
const driver = path.join(tmp, 'driver.js');
for (const d of [binDir, captures, results]) fs.mkdirSync(d, { recursive: true });

fs.writeFileSync(driver, `
const fs = require('fs');
const [watcherPath, id, resultFile] = process.argv.slice(2);
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

// Stub do agente: grava argv; /implement-step escreve nos arquivos do escopo declarado no bloco
// de contexto; /implement-integrate e os gates não mudam nada.
fs.writeFileSync(path.join(binDir, 'claude'), `#!${process.execPath}
const fs = require('fs');
const path = require('path');
// Versão provada na tarefa 0 (U10-a): habilita o mecanismo --agents no watcher.
if (process.argv.includes('--version')) { process.stdout.write('2.1.319 (Claude Code)\\n'); process.exit(0); }
const scenario = process.env.DECO_SCENARIO || 'sem-cenario';
const dir = path.join(${JSON.stringify(captures)}, scenario);
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, String(fs.readdirSync(dir).length).padStart(3, '0') + '.json'), JSON.stringify({ argv: process.argv.slice(2) }));
const prompt = process.argv[process.argv.indexOf('-p') + 1] || '';
const step = /\\/implement-step (\\S+) (\\S+)/.exec(prompt);
if (step) {
    const m = /Escopo de escrita \\(paths_decl\\): ([^\\n]+)\\./.exec(prompt);
    for (const rel of (m ? m[1].split(', ') : [])) {
        fs.mkdirSync(path.dirname(path.join(process.cwd(), rel)), { recursive: true });
        fs.appendFileSync(path.join(process.cwd(), rel), 'mudança da subtarefa ' + step[2] + '\\n');
    }
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
    GIT_AUTHOR_NAME: 'deco', GIT_AUTHOR_EMAIL: 'deco@example.invalid',
    GIT_COMMITTER_NAME: 'deco', GIT_COMMITTER_EMAIL: 'deco@example.invalid',
};
const git = (cwd, ...args) => execFileSync('git', args, { cwd, env: { PATH: process.env.PATH, ...GIT_ENV }, encoding: 'utf8' }).trim();

const POLICY = {
    id: 'routing-sintetica', version: 'p-deco-1', mode: 'ROUTED', classifier: { provider: 'cheap_rule' },
    class_to_tier: {
        C1: { tier: 'T1', effort: 'baixo' }, C2: { tier: 'T2', effort: 'médio' }, C3: { tier: 'T2', effort: 'alto' },
        C4: { tier: 'T3', effort: 'alto' }, C5: { tier: 'T3', effort: 'máximo' },
    },
    tiers: { T1: { models: ['m-t1'] }, T2: { models: ['m-t2'] }, T3: { models: ['m-t3'] } },
    default_route: { model_id: 'm-t3', effort: 'alto' },
    effort_map: { baixo: 'low', 'médio': 'medium', alto: 'high', 'máximo': 'max' },
    subagent_roles: { default: { model_id: 'm-t3', effort: 'alto' } },
    manifest_limits: { max_entries: 20000, max_bytes: 268435456 },
    workspace_watch_globs: ['.env', '.env.*'],
};

const PLAN_TWO_GROUPS = [
    '# Plano', '', '## Plano de execução', '',
    '1. Ajustar o serviço.', '   - Arquivo: `src/main/java/app/Servico.java`', '   - Critérios: AC-01', '   - Verificação: teste unitário', '',
    '2. Ajustar a documentação.', '   - Arquivo: `docs/leia.md`', '   - Critérios: AC-02', '   - Verificação: leitura', '',
].join('\n');

let repoCount = 0;
function consumer() {
    const root = path.join(tmp, `c${repoCount++}`);
    const repo = path.join(root, 'app-back');
    fs.mkdirSync(path.join(repo, '.claude'), { recursive: true });
    const bytes = JSON.stringify(POLICY);
    fs.writeFileSync(path.join(repo, '.claude', 'routing-policy.json'), bytes);
    fs.writeFileSync(path.join(repo, '.claude', 'model-routing.json'), JSON.stringify({
        mode: 'ON',
        policy_ref: { id: POLICY.id, version: POLICY.version, sha256: crypto.createHash('sha256').update(bytes).digest('hex'), path: '.claude/routing-policy.json' },
    }));
    // Chave e manifestos do DOM-06 ficam em memory/runs/ do checkout principal, ignorado.
    fs.writeFileSync(path.join(repo, '.gitignore'), 'memory/runs/\n.claude/worktrees/\n');
    git(repo, 'init', '-q', '-b', 'development');
    git(repo, 'add', '.gitignore');
    git(repo, 'commit', '-q', '-m', 'base sintética');
    const remote = path.join(root, 'origin.git');
    fs.mkdirSync(remote, { recursive: true });
    git(remote, 'init', '-q', '--bare');
    git(repo, 'remote', 'add', 'origin', remote);
    git(repo, 'push', '-q', 'origin', 'development');
    return repo;
}

const worktreeOf = (repo, id) => path.join(repo, '.claude', 'worktrees', String(id));
const fetchRunDirOf = (repo, id) => path.join(worktreeOf(repo, id), 'memory', 'runs', '_dom06');
const taskIdOf = id => `${id}-dc`;
const taskDirOf = (repo, id) => path.join(worktreeOf(repo, id), 'memory', 'runs', taskIdOf(id));
const readState = (repo, id) => JSON.parse(fs.readFileSync(path.join(taskDirOf(repo, id), 'state.json'), 'utf8'));

// Run ON admitida pelo DOM-06 real com a decomposição ligada só no snapshot do harness.
function seedDecomposedRun(repo, id, { node = 'implement', extraState = {}, agent = false } = {}) {
    const worktree = worktreeOf(repo, id);
    fs.mkdirSync(worktree, { recursive: true });
    if (agent) {
        // Agente de projeto reproduzível (só campos que a redefinição leva sem perda).
        fs.mkdirSync(path.join(worktree, '.claude', 'agents'), { recursive: true });
        fs.writeFileSync(path.join(worktree, '.claude', 'agents', 'revisor.md'), '---\nname: revisor\ndescription: Revisa código\ntools: Read, Grep\nmodel: haiku\n---\nVocê revisa.\n');
    }
    git(worktree, 'init', '-q', '-b', String(id));
    fs.writeFileSync(path.join(worktree, '.gitignore'), 'memory/runs/\n');
    git(worktree, 'add', '.gitignore');
    git(worktree, 'commit', '-q', '-m', `Melhoria #${id}`);
    const loaded = policyLoader.readRoutingConfig(repo);
    assert.strictEqual(loaded.status, 'ON', JSON.stringify(loaded));
    const snapshot = mr.buildRoutingSnapshot({ ...loaded, decomposition: 'on' });
    assert.strictEqual(snapshot.decomposition, 'on');
    const fetch = dom06.prepareDispatch({
        runDir: fetchRunDirOf(repo, id), node: 'fetch_ticket', ticketId: id, baseBranch: 'development',
        specHash: null, cause: 'dispatch', routing: snapshot,
    });
    routingRun.recordAdmission(fetchRunDirOf(repo, id), fetch.attempt);
    routingRun.markConsumed(fetchRunDirOf(repo, id), taskIdOf(id));
    const dir = taskDirOf(repo, id);
    fs.mkdirSync(dir, { recursive: true });
    const history = ['fetch_ticket', 'plan', 'implement', 'review', 'test', 'verify'];
    fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({
        task_id: taskIdOf(id), node, history: history.slice(0, history.indexOf(node)), status: 'in_progress',
        started_at: new Date(Date.now() + 1000).toISOString(), retries: {},
        routing_snapshot: { attempt_id: fetch.attempt.attempt_id, sha256: snapshot.sha256 },
        ...extraState,
    }));
    fs.writeFileSync(path.join(dir, 'context.md'), '# Contexto\n');
    fs.writeFileSync(path.join(dir, 'plan.md'), PLAN_TWO_GROUPS);
    return { worktree, dir };
}

function dispatch(repo, id, scenario) {
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
        REDMINE_API_KEY: 'chave-falsa-deco',
        REDMINE_RETRY_MAX_ATTEMPTS: '1',
        REDMINE_MIN_INTERVAL_MS: '0',
        DECO_SCENARIO: scenario,
    };
    return new Promise(resolve => {
        // Sem --follow: modo destacado (o agente e o release sobrevivem ao processo do tick).
        execFile(process.execPath, [driver, WATCHER, String(id), resultFile], { cwd: repo, env, timeout: 120000 }, (err, stdout, stderr) => {
            const result = fs.existsSync(resultFile) ? JSON.parse(fs.readFileSync(resultFile, 'utf8')) : null;
            resolve({ result, output: `${stdout}\n${stderr}` });
        });
    });
}

const roleAttempts = dir => dom06.listAttempts(dir).filter(a => a.role).sort((a, b) => a.seq - b.seq);

// Espera o wrapper destacado fechar o último Attempt com papel (aceite gravado, ou post do gate)
// e o lease devolver a Run para in_progress.
async function settle(repo, id, timeoutMs = 60000) {
    const dir = taskDirOf(repo, id);
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const last = roleAttempts(dir).at(-1);
        const closed = last && (last.role === 'gate' ? last.workspace && last.workspace.post : last.acceptance);
        if (closed && readState(repo, id).status !== 'running') return last;
        await new Promise(r => setTimeout(r, 200));
    }
    throw new Error(`Attempt não fechou em ${timeoutMs} ms: ${JSON.stringify(roleAttempts(dir).at(-1))}`);
}

const argvsOf = scenario => {
    const dir = path.join(captures, scenario);
    return fs.existsSync(dir) ? fs.readdirSync(dir).sort().map(f => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')).argv) : [];
};
const promptOf = argv => argv[argv.indexOf('-p') + 1];

test.before(() => new Promise(r => server.listen(0, '127.0.0.1', r)));
test.after(() => { server.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

test('AC-26/AC-22: modo destacado — duas subtarefas + integração + agregação + transição; Review como gate', { timeout: 10 * 60 * 1000 }, async () => {
    const repo = consumer();
    const id = 311201;
    const { dir } = seedDecomposedRun(repo, id, { agent: true });
    const scenario = 'ciclo';
    const results = [];
    const tick = async () => {
        const r = await dispatch(repo, id, scenario);
        assert.ok(r.result && !r.result.error, `tick falhou: ${JSON.stringify(r.result)}\n${r.output}`);
        results.push(r.result);
        return r;
    };

    // Tick 1: primeira subtarefa (menor passo).
    let r = await tick();
    assert.strictEqual(r.result.action, 'dispatched', r.output);
    const a1 = await settle(repo, id);
    const state1 = readState(repo, id);
    const [k1, k2] = state1.decomposition.groups.map(g => g.subtask_key);
    assert.strictEqual(state1.decomposition.status, 'DECOMPOSABLE');
    assert.deepStrictEqual([a1.role, a1.subtask_key, a1.cause, a1.chain_anchor && a1.chain_anchor.reason], ['subtask', k1, 'dispatch', 'RUN_START']);
    assert.strictEqual(a1.acceptance.accepted, true, JSON.stringify(a1.acceptance));
    assert.strictEqual(a1.workspace.baseline.completeness, 'COMPLETE');
    assert.strictEqual(a1.workspace.post.completeness, 'COMPLETE');
    assert.notStrictEqual(a1.workspace.post.digest, a1.workspace.baseline.digest, 'a subtarefa mudou o workspace');
    assert.ok(a1.dod && a1.dod.source === 'derived', 'DoD derivado gravado no Attempt (AC-28)');
    assert.ok(/^[0-9a-f]{64}$/.test(a1.context_record_sha256));
    assert.deepStrictEqual(a1.routing.subagent_roles.map(x => [x.role, x.declared_model, x.enforcement, x.effort_enforcement]), [
        ['revisor', 'm-t3', 'ENFORCED', 'UNKNOWN'], ['default', 'm-t3', 'UNENFORCED', 'UNKNOWN'],
    ], 'RoutingDecision com subagent_roles[] (AC-27)');
    assert.deepStrictEqual([a1.routing.subagent_mechanism.status, a1.routing.subagent_mechanism.cli_version], ['VERIFIED', '2.1.319']);
    assert.ok(/^[0-9a-f]{64}$/.test(a1.routing.subagent_agents_sha256), 'só o hash da redefinição vai para a decisão');
    assert.ok(!JSON.stringify(a1).includes('Você revisa.'), 'o prompt do agente do consumidor não vai para o Attempt');
    assert.deepStrictEqual(state1.history, ['fetch_ticket', 'plan'], 'o comando de passo não mexe no history');
    assert.strictEqual(state1.node, 'implement');

    // Tick 2: segunda subtarefa; cadeia encadeada no post da primeira.
    r = await tick();
    assert.strictEqual(r.result.action, 'dispatched', r.output);
    const a2 = await settle(repo, id);
    assert.deepStrictEqual([a2.subtask_key, a2.chain_anchor], [k2, null]);
    assert.strictEqual(a2.workspace.baseline.digest, a1.workspace.post.digest, 'baseline = post do anterior (sem Attempt no meio)');
    assert.strictEqual(a2.acceptance.accepted, true);

    // Tick 3: integração, rota do default_route (Q4).
    r = await tick();
    assert.strictEqual(r.result.action, 'dispatched', r.output);
    const integ = await settle(repo, id);
    assert.strictEqual(integ.role, 'integration');
    assert.deepStrictEqual([integ.routing.selection_source, integ.routing.chosen.model_id], ['FIXED_NODE', POLICY.default_route.model_id]);
    assert.strictEqual(integ.acceptance.accepted, true);
    assert.strictEqual(integ.acceptance.no_change, true, 'integração sem ajuste: aceita com no_change');

    // Tick 4: agregação + transição implement → review feita pelo watcher.
    r = await tick();
    assert.strictEqual(r.result.action, 'transitioned', r.output);
    const state4 = readState(repo, id);
    assert.deepStrictEqual([state4.node, state4.history], ['review', ['fetch_ticket', 'plan', 'implement']]);
    assert.ok(dom06.readAttempt(path.join(dir, 'dom06', 'attempts', `${integ.attempt_id}.json`)).effects.some(e => e.idempotency_key.startsWith(`aggregate:${state4.decomposition.plan_version}:`)));

    // Tick 5: Review uma vez, sobre o integrado, como gate com manifesto (H7).
    r = await tick();
    assert.strictEqual(r.result.action, 'dispatched', r.output);
    const gate = await settle(repo, id);
    assert.deepStrictEqual([gate.role, gate.node], ['gate', 'review']);
    assert.strictEqual(gate.workspace.baseline.digest, integ.workspace.post.digest);
    assert.strictEqual(gate.workspace.post.completeness, 'COMPLETE');

    // Volta de gate (o /review reprovou com achado no arquivo do 2º grupo e devolveu ao implement).
    const failed = readState(repo, id);
    fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({
        ...failed, node: 'implement', history: [...failed.history, 'review'],
        review_results: { verdict: 'FAIL', failure_origin: 'engineering', spec_compliance: { verdict: 'PASS' }, engineering: { verdict: 'FAIL' }, findings: [{ item: 1, file: 'docs/leia.md', line: 1, expected: 'x', found: 'y', action: 'z' }] },
    }));

    // Tick 6: rework só da chave mapeada (k2), encadeado na linhagem, no post do gate.
    r = await tick();
    assert.strictEqual(r.result.action, 'dispatched', r.output);
    const rw = await settle(repo, id);
    const state6 = readState(repo, id);
    assert.deepStrictEqual([state6.decomposition.rework.keys, state6.decomposition.rework.gate_node], [[k2], 'review']);
    assert.deepStrictEqual([rw.role, rw.subtask_key, rw.rework, rw.cause, rw.parent_attempt_id], ['subtask', k2, true, 'dispatch', a2.attempt_id]);
    assert.strictEqual(rw.workspace.baseline.digest, gate.workspace.post.digest, 'rework parte do post do gate (Q6)');
    assert.strictEqual(rw.routing.class, a2.routing.class, 'rework sem override na resolução inicial da linhagem, nunca abaixo (AC-24)');
    assert.ok(rw.acceptance.accepted);

    // Tick 7: nova integração; tick 8: nova agregação desta visita e transição.
    r = await tick();
    assert.strictEqual(r.result.action, 'dispatched', r.output);
    const integ2 = await settle(repo, id);
    assert.strictEqual(integ2.role, 'integration');
    r = await tick();
    assert.strictEqual(r.result.action, 'transitioned', r.output);
    const state8 = readState(repo, id);
    assert.strictEqual(state8.node, 'review');
    assert.strictEqual(state8.history.filter(x => x === 'implement').length, 2, 'uma entrada de implement por visita');

    // Comandos despachados: um por tick, na ordem; a Review só depois da agregação; k1 não é refeita.
    const argvs = argvsOf(scenario).filter(a => a.includes('-p'));
    const commands = argvs.map(a => /Rode, nesta ordem: ([^.]+)\./.exec(promptOf(a))[1]);
    assert.deepStrictEqual(commands, [
        `/implement-step ${taskIdOf(id)} ${k1}`, `/implement-step ${taskIdOf(id)} ${k2}`,
        `/implement-integrate ${taskIdOf(id)}`, `/review ${taskIdOf(id)}`,
        `/implement-step ${taskIdOf(id)} ${k2}`, `/implement-integrate ${taskIdOf(id)}`,
    ]);
    // --agents (U10-a) só nos Attempts de subtarefa/integração, com o modelo da policy e a definição do projeto.
    argvs.forEach((a, i) => {
        const isGate = commands[i].startsWith('/review');
        assert.strictEqual(a.includes('--agents'), !isGate, `--agents em ${commands[i]}`);
        if (!isGate) assert.deepStrictEqual(JSON.parse(a[a.indexOf('--agents') + 1]), { revisor: { description: 'Revisa código', prompt: 'Você revisa.', tools: ['Read', 'Grep'], model: 'm-t3' } });
    });
});

test('AC-22: Review numa Run decomposta sem agregação → blocked, nada despachado', { timeout: 5 * 60 * 1000 }, async () => {
    const repo = consumer();
    const id = 311202;
    const decomposition = require('./decomposition-visit').recordDecomposition({}, PLAN_TWO_GROUPS, '2026-11-09T10:00:00.000Z').decomposition;
    seedDecomposedRun(repo, id, { node: 'review', extraState: { decomposition } });
    const r = await dispatch(repo, id, 'review-sem-agregacao');
    assert.deepStrictEqual([r.result.action, r.result.reason, r.result.cause], ['skip', 'decomposition_blocked', 'REVIEW_WITHOUT_AGGREGATE'], r.output);
    const state = readState(repo, id);
    assert.strictEqual(state.status, 'blocked');
    assert.deepStrictEqual([state.decomposition_block_applied.attempt_id, state.decomposition_block_applied.reason], [null, 'REVIEW_WITHOUT_AGGREGATE']);
    assert.deepStrictEqual(argvsOf('review-sem-agregacao'), []);
});

test('B2: plano intercalado → NOT_DECOMPOSABLE gravado e o Implement segue como um Attempt (S4)', { timeout: 5 * 60 * 1000 }, async () => {
    const repo = consumer();
    const id = 311203;
    const { dir } = seedDecomposedRun(repo, id);
    fs.writeFileSync(path.join(dir, 'plan.md'), [
        '# Plano', '', '## Plano de execução', '',
        '1. A.', '   - Arquivo: `src/a.js`', '', '2. B.', '   - Arquivo: `src/b.js`', '', '3. A de novo.', '   - Arquivo: `src/a.js`', '',
    ].join('\n'));
    const r = await dispatch(repo, id, 'intercalado');
    assert.strictEqual(r.result.action, 'dispatched', r.output);
    const state = readState(repo, id);
    assert.deepStrictEqual([state.decomposition.status, state.decomposition.cause], ['NOT_DECOMPOSABLE', 'INTERLEAVED_GROUPS']);
    // Modo destacado: o agente roda depois do tick; espera o stub gravar o argv.
    for (let i = 0; i < 300 && !argvsOf('intercalado').length; i++) await new Promise(res => setTimeout(res, 100));
    const argv = argvsOf('intercalado')[0];
    assert.match(promptOf(argv), new RegExp(`Rode, nesta ordem: /implement ${taskIdOf(id)}\\.`));
    assert.ok(dom06.listAttempts(dir).every(a => !a.role), 'nenhum Attempt com papel');
});

test('AC-29: implement.md, review.md e commit.md byte a byte iguais aos de 2024597', () => {
    const expected = {
        'implement.md': 'c58ad7440dc8a1ee0392355a1d88808944b0642545134dcd7f550512ef1c668b',
        'review.md': '0f56df42319fbd05ae9ecad1a78ee91e8ae0ede329a2f9e23bfac3903c87a89d',
        'commit.md': '85886ccca6116c84efdfa20f8614630ade280d4804e66ab910585c0425d92cce',
    };
    for (const [file, sha] of Object.entries(expected)) {
        const got = crypto.createHash('sha256').update(fs.readFileSync(path.join(PRISMA_ROOT, '.claude', 'commands', file))).digest('hex');
        assert.strictEqual(got, sha, `${file} mudou em relação a 2024597`);
    }
});
