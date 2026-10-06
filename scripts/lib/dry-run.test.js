// node --test scripts/lib/dry-run.test.js
// Modo DRY-RUN do watcher (scripts/lib/dry-run.js): adaptadores isolados (fixture,
// Redmine falso, guarda de rede, agente simulado) e ponta a ponta — o watcher de
// verdade num processo filho com DRY_RUN=true, um `claude` falso no PATH que denuncia
// se for chamado e um Redmine falso (HTTP local) que conta requisições: o ciclo
// plan→commit tem que fechar sem tocar nenhum dos dois.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn, spawnSync } = require('child_process');
const dryRun = require('./dry-run');
const { readAndValidateState } = require('../validate-state');

const TMP_ROOT = process.env.CLAUDE_JOB_DIR ? path.join(process.env.CLAUDE_JOB_DIR, 'tmp') : os.tmpdir();
const WATCHER = path.join(__dirname, '..', 'readmine-watcher.js');
const mkTmp = prefix => fs.mkdtempSync(path.join(TMP_ROOT, prefix));
const readJson = f => JSON.parse(fs.readFileSync(f, 'utf8'));
const quiet = () => {};

// ---------------------------------------------------------------------------------
// Fixture

test('fixture padrão: ticket 99999 com Branch Liberação e updated_on carimbado', () => {
    const now = new Date('2026-09-29T12:00:00Z');
    const [t] = dryRun.loadFixtures(dryRun.DEFAULT_FIXTURE, { now });
    assert.strictEqual(t.id, 99999);
    assert.match(t.subject, /^\[DRY-RUN\]/);
    assert.strictEqual(t.updated_on, now.toISOString());
    assert.deepStrictEqual(t.journals, []);
    assert.strictEqual(t.custom_fields.find(f => f.name === 'Branch Liberação').value, 'Dev - Local');
});

test('fixture: aceita objeto, array e { issues }; rejeita ticket sem id/subject', () => {
    const dir = mkTmp('dry-fixture-');
    const write = (name, data) => { const f = path.join(dir, name); fs.writeFileSync(f, JSON.stringify(data)); return f; };
    const t = { id: 1, subject: 'a', updated_on: '2026-01-01T00:00:00Z' };
    assert.strictEqual(dryRun.loadFixtures(write('o.json', t))[0].updated_on, '2026-01-01T00:00:00Z', 'updated_on explícito é preservado');
    assert.deepStrictEqual(dryRun.loadFixtures(write('a.json', [t, { ...t, id: 2 }])).map(x => x.id), [1, 2]);
    assert.deepStrictEqual(dryRun.loadFixtures(write('i.json', { issues: [t] })).map(x => x.id), [1]);
    assert.throws(() => dryRun.loadFixtures(write('bad.json', { subject: 'sem id' })), /sem "id" inteiro/);
    assert.throws(() => dryRun.loadFixtures(path.join(dir, 'nao-existe.json')), /fixture ilegível/);
});

test('DRY_RUN_FIXTURE: absoluto, relativo ao cwd ou à raiz do repo; ausente = padrão', () => {
    const root = path.join(__dirname, '..', '..');
    assert.strictEqual(dryRun.resolveFixturePath({}), dryRun.DEFAULT_FIXTURE);
    assert.strictEqual(dryRun.resolveFixturePath({ DRY_RUN_FIXTURE: '/x/y.json' }), '/x/y.json');
    assert.strictEqual(
        dryRun.resolveFixturePath({ DRY_RUN_FIXTURE: './scripts/fixtures/ticket-example.json' }, root),
        path.resolve(root, 'scripts/fixtures/ticket-example.json'));
});

test('DRY_RUN só liga com o valor exato "true"', () => {
    assert.strictEqual(dryRun.isEnabled({ DRY_RUN: 'true' }), true);
    for (const v of [undefined, '', '1', 'TRUE', 'false', 'yes']) assert.strictEqual(dryRun.isEnabled({ DRY_RUN: v }), false, String(v));
});

// ---------------------------------------------------------------------------------
// Redmine falso

test('Redmine falso: lista, detalhe, 404 fora do fixture, PUT registra nota sem sair do processo', async () => {
    const fixtures = dryRun.loadFixtures(dryRun.DEFAULT_FIXTURE);
    const lines = [];
    const f = dryRun.createFakeRedmine({ fixtures, log: l => lines.push(l) });
    const list = await f('https://redmine.x/issues.json?assigned_to_id=me&status_id=11|13');
    assert.strictEqual(list.ok, true);
    assert.deepStrictEqual((await list.json()).issues.map(t => t.id), [99999]);
    assert.strictEqual((await (await f('https://redmine.x/issues/99999.json?include=journals')).json()).issue.id, 99999);
    const missing = await f('https://redmine.x/issues/43000.json');
    assert.strictEqual(missing.status, 404);
    assert.strictEqual(missing.ok, false);
    const put = await f('https://redmine.x/issues/99999.json', { method: 'PUT', body: JSON.stringify({ issue: { notes: '[Watcher] teste\nlinha 2' } }) });
    assert.strictEqual(put.status, 204);
    assert.strictEqual(fixtures[0].journals.at(-1).notes, '[Watcher] teste\nlinha 2', 'nota vira journal (portões que esperam resposta enxergam a pergunta)');
    assert.ok(lines.some(l => /PUT #99999 NÃO enviado.*\[Watcher\] teste/.test(l)), lines.join('\n'));
});

// ---------------------------------------------------------------------------------
// Guarda de rede/processo

test('blockedCommand: bloqueia agentes, build, rede e git de rede; libera git local e utilitários', () => {
    const blocked = [
        ['claude', ['-p', 'x']], ['codex', []], ['/usr/local/bin/mvn', ['compile']], ['curl', ['-X', 'POST']],
        ['osascript', ['-e', 'x']], ['git', ['-C', '/r', 'fetch', 'origin', 'development']], ['git', ['push', 'origin', 'x']],
        ['/bin/sh', ['-c', 'n=$1; claude "$@"; c=$?']], ['git -C /r fetch origin development'],
        ['scripts/bitbucket-open-pr.sh --draft'],
    ];
    for (const [file, args] of blocked) assert.ok(dryRun.blockedCommand(file, args || []), `${file} ${args || ''}`);
    const allowed = [
        ['git', ['-C', '/r', 'diff', 'HEAD']], ['git', ['rev-parse', '--verify', 'x']], ['ps', ['-p', '1']],
        [process.execPath, ['sanitize-log.js']], ['git -C /r worktree list --porcelain'],
    ];
    for (const [file, args] of allowed) assert.strictEqual(dryRun.blockedCommand(file, args || []), null, `${file} ${args || ''}`);
});

test('guarda instalada: fetch, http(s) e spawn de binário externo estouram DryRunViolation (sem vazar URL/token)', () => {
    const script = `
        const d = require(${JSON.stringify(path.join(__dirname, 'dry-run.js'))});
        d.installNetworkGuard({ log: () => {} });
        const out = {};
        const tryIt = async (k, fn) => { try { await fn(); out[k] = 'passou'; } catch (e) { out[k] = e.name + ': ' + e.message; } };
        (async () => {
            await tryIt('fetch', () => fetch('https://hooks.slack.com/services/T000/SECRET-TOKEN'));
            await tryIt('https', () => require('https').request('https://api.bitbucket.org/2.0'));
            await tryIt('spawn', () => require('child_process').spawn('claude', ['-p', 'x']));
            await tryIt('execSync', () => require('child_process').execSync('git fetch origin development'));
            await tryIt('local', () => require('child_process').execFileSync(process.execPath, ['-e', '1']));
            console.log(JSON.stringify(out));
        })();`;
    const r = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8' });
    const out = JSON.parse(r.stdout.trim());
    for (const k of ['fetch', 'https', 'spawn', 'execSync']) assert.match(out[k], /^DryRunViolation: \[dry-run\] chamada externa bloqueada/, k);
    assert.match(out.fetch, /hooks\.slack\.com/);
    assert.doesNotMatch(out.fetch, /SECRET-TOKEN/, 'só o host vai pro log');
    assert.strictEqual(out.local, 'passou', 'node local continua liberado');
});

// ---------------------------------------------------------------------------------
// Agente simulado (sem watcher): escreve o que cada comando escreveria

test('simulateSegment: fetch_ticket+plan cria a task; nós seguintes avançam state.node; commit arquiva', async () => {
    const runsDir = path.join(mkTmp('dry-seg-'), 'memory', 'runs');
    fs.mkdirSync(runsDir, { recursive: true });
    const [ticket] = dryRun.loadFixtures(dryRun.DEFAULT_FIXTURE);
    const env = { DRY_RUN_DELAY_FACTOR: '0', DRY_RUN_RISK_LEVEL: 'high' };
    const lines = [];
    const log = l => lines.push(l);
    const dir = path.join(runsDir, '99999-dry-run');

    await dryRun.simulateSegment({ ticket, nodes: ['fetch_ticket', 'plan'], lease: null, runsDir, baseBranch: 'development', env, log });
    let st = readJson(path.join(dir, 'state.json'));
    assert.deepStrictEqual([st.node, st.status, st.history, st.dry_run], ['implement', 'in_progress', ['fetch_ticket', 'plan'], true]);
    assert.strictEqual(st.redmine_ticket.base_branch, 'development');
    assert.match(fs.readFileSync(path.join(dir, 'handoff.md'), 'utf8'), /## Plano de execução/);

    const expectNext = { implement: 'review', review: 'test', test: 'verify', verify: 'commit' };
    for (const [node, next] of Object.entries(expectNext)) {
        const r = await dryRun.simulateSegment({ ticket, nodes: [node], lease: { dir, node }, runsDir, env, log });
        assert.strictEqual(r.code, 0);
        assert.strictEqual(readJson(path.join(dir, 'state.json')).node, next, node);
    }
    assert.strictEqual(readJson(path.join(dir, 'state.json')).risk_level, 'high');

    const r = await dryRun.simulateSegment({ ticket, nodes: ['commit'], lease: { dir, node: 'commit' }, runsDir, env, log });
    st = readJson(path.join(dir, 'state.json'));
    assert.strictEqual(st.status, 'committed');
    assert.strictEqual(st.pull_request, undefined, 'URL fictícia fora de pull_request (polling de PR real iria atrás)');
    assert.strictEqual(st.dry_run_pull_request['app-back'].title.startsWith('[HIGH-RISK] '), true);
    assert.ok(lines.some(l => l.includes('[dry-run] PR que seria aberto: https://bitbucket.org/[DRY-RUN]/')), lines.join('\n'));

    r.finalize();
    assert.ok(!fs.existsSync(dir), 'pasta ativa saiu de memory/runs/');
    const archived = path.join(runsDir, '_archive', '99999-dry-run');
    const v = readAndValidateState('99999-dry-run', { dir: archived });
    assert.strictEqual(v.valid, true, JSON.stringify(v.errors));
    assert.strictEqual(v.state.status, 'committed');
});

test('simulateSegment/archiveTask nunca sobrescrevem dados que não são de dry-run', async () => {
    const runsDir = path.join(mkTmp('dry-safe-'), 'memory', 'runs');
    const [ticket] = dryRun.loadFixtures(dryRun.DEFAULT_FIXTURE);
    const real = path.join(runsDir, '99999-dry-run');
    fs.mkdirSync(real, { recursive: true });
    fs.writeFileSync(path.join(real, 'state.json'), JSON.stringify({ task_id: '99999-dry-run', node: 'plan', history: [], status: 'in_progress' }));
    await assert.rejects(
        dryRun.simulateSegment({ ticket, nodes: ['fetch_ticket'], runsDir, env: { DRY_RUN_DELAY_FACTOR: '0' }, log: quiet }),
        /não é de dry-run/);
    assert.ok(fs.existsSync(path.join(real, 'state.json')), 'state.json alheio intacto');

    const target = path.join(runsDir, '_archive', '99999-dry-run');
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(target, 'state.json'), JSON.stringify({ status: 'committed' }));
    assert.throws(() => dryRun.archiveTask(real, runsDir, '99999-dry-run', quiet), /não é de dry-run/);
});

test('.watcher-mode: grava e relê; ausente = null', () => {
    const runsDir = path.join(mkTmp('dry-mode-'), 'memory', 'runs');
    assert.strictEqual(dryRun.readModeFile(runsDir), null);
    dryRun.writeModeFile(runsDir, { mode: 'dry-run', dry_run: true, tickets: [99999] });
    const m = dryRun.readModeFile(runsDir);
    assert.strictEqual(m.mode, 'dry-run');
    assert.ok(Number.isFinite(Date.parse(m.updated_at)));
});

// ---------------------------------------------------------------------------------
// Ponta a ponta: watcher real num processo filho

function sandbox() {
    const tmp = mkTmp('dry-e2e-');
    const repo = path.join(tmp, 'app-back');
    const bin = path.join(tmp, 'bin');
    const claudeMarker = path.join(tmp, 'claude-foi-chamado');
    fs.mkdirSync(path.join(repo, 'memory', 'runs'), { recursive: true });
    fs.mkdirSync(bin);
    for (const name of ['claude', 'mvn', 'osascript', 'curl']) {
        fs.writeFileSync(path.join(bin, name), `#!/bin/sh\necho "${name} $@" >> "${claudeMarker}"\nexit 0\n`, { mode: 0o755 });
    }
    return { tmp, repo, bin, claudeMarker };
}

// Redmine "real" (HTTP local): em DRY-RUN não pode receber nenhuma requisição.
function countingRedmine(issues = []) {
    const hits = [];
    const server = http.createServer((req, res) => {
        hits.push(`${req.method} ${req.url}`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(req.url.startsWith('/issues.json') ? { issues } : {}));
    });
    return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({ server, hits, url: `http://127.0.0.1:${server.address().port}` })));
}

function runWatcher({ repo, bin, url, extraEnv = {}, args = [] }) {
    const env = { ...process.env, REPO_PATH: repo, REDMINE_URL: url, REDMINE_API_KEY: 'k', PATH: `${bin}:${process.env.PATH}`, DISABLE_AUTO_CLEANUP: '1', ...extraEnv };
    for (const k of ['DRY_RUN', 'DRY_RUN_FIXTURE', 'DRY_RUN_RISK_LEVEL', 'DRY_RUN_DELAY_FACTOR', 'NOTIFY_WEBHOOK_URL']) if (!(k in extraEnv)) delete env[k];
    const started = Date.now();
    const child = spawn(process.execPath, [WATCHER, ...args], { cwd: repo, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { out += d; });
    return new Promise(resolve => child.on('exit', code => resolve({ code, out, ms: Date.now() - started })));
}

test('e2e: DRY_RUN=true fecha fetch_ticket→commit sem chamar Redmine, claude, mvn nem Bitbucket', async () => {
    const { repo, bin, claudeMarker } = sandbox();
    const rm = await countingRedmine();
    try {
        const r = await runWatcher({ repo, bin, url: rm.url, extraEnv: { DRY_RUN: 'true', DRY_RUN_DELAY_FACTOR: '0' } });
        assert.strictEqual(r.code, 0, r.out);
        assert.ok(r.ms < 30000, `ciclo em ${r.ms}ms`);
        assert.deepStrictEqual(rm.hits, [], 'nenhuma requisição ao Redmine');
        assert.ok(!fs.existsSync(claudeMarker), `binário externo chamado: ${fs.existsSync(claudeMarker) && fs.readFileSync(claudeMarker, 'utf8')}`);
        assert.doesNotMatch(r.out, /DryRunViolation|chamada externa bloqueada/, 'nenhuma chamada escapou dos adaptadores');
        assert.match(r.out, /\[dry-run\] Modo DRY-RUN ativo — nenhuma chamada externa real/);
        assert.match(r.out, /\[dry-run\] PR que seria aberto: /);

        const archived = path.join(repo, 'memory', 'runs', '_archive', '99999-dry-run');
        const v = readAndValidateState('99999-dry-run', { dir: archived });
        assert.strictEqual(v.valid, true, JSON.stringify(v.errors));
        const st = v.state;
        assert.strictEqual(st.status, 'committed');
        assert.deepStrictEqual(st.history, ['fetch_ticket', 'plan', 'implement', 'review', 'test', 'verify', 'commit']);
        assert.strictEqual(st.planScore, 100, 'portão de plano avaliado');
        assert.strictEqual(st.preBuildStatus, 'passed', 'portão de build avaliado (mvn simulado)');
        assert.strictEqual(st.risk_level, 'low');
        const ends = st.events.filter(e => e.type === 'node_end').map(e => e.node);
        assert.deepStrictEqual(ends, ['fetch_ticket', 'plan', 'implement', 'review', 'test', 'verify', 'commit'], 'eventos emitidos pelo release do lease');

        const mode = readJson(path.join(repo, 'memory', 'runs', '.watcher-mode'));
        assert.deepStrictEqual([mode.mode, mode.dry_run, mode.tickets], ['dry-run', true, [99999]]);
        assert.match(fs.readFileSync(path.join(repo, 'memory', 'runs', '99999.log'), 'utf8'), /\[claude\] \[dry-run\] Nó commit completado/);

        // Rodar de novo: ciclo novo (o fixture não tem updated_on fixo), sem duplicar pastas.
        const r2 = await runWatcher({ repo, bin, url: rm.url, extraEnv: { DRY_RUN: 'true', DRY_RUN_DELAY_FACTOR: '0', DRY_RUN_RISK_LEVEL: 'high' } });
        assert.strictEqual(r2.code, 0, r2.out);
        const st2 = readJson(path.join(archived, 'state.json'));
        assert.strictEqual(st2.status, 'committed');
        assert.strictEqual(st2.risk_level, 'high');
        assert.match(r2.out, /título: "\[HIGH-RISK\] 99999/);
        assert.deepStrictEqual(rm.hits, []);
    } finally {
        rm.server.close();
    }
});

test('e2e: sem DRY_RUN o watcher consulta o Redmine de verdade e grava .watcher-mode live (banner desliga)', async () => {
    const { repo, bin, claudeMarker } = sandbox();
    const rm = await countingRedmine([]);
    try {
        dryRun.writeModeFile(path.join(repo, 'memory', 'runs'), { mode: 'dry-run', dry_run: true });
        const r = await runWatcher({ repo, bin, url: rm.url });
        assert.strictEqual(r.code, 0, r.out);
        assert.ok(rm.hits.some(h => h.startsWith('GET /issues.json')), `Redmine consultado: ${rm.hits}`);
        assert.doesNotMatch(r.out, /\[dry-run\]/);
        assert.strictEqual(readJson(path.join(repo, 'memory', 'runs', '.watcher-mode')).mode, 'live');
        assert.ok(!fs.existsSync(path.join(repo, 'memory', 'runs', '_archive')), 'nada simulado');
        assert.ok(!fs.existsSync(claudeMarker));
    } finally {
        rm.server.close();
    }
});

test('e2e: DRY_RUN no .env não liga o modo (só o ambiente do processo)', async () => {
    // SIMULATE é calculado antes do loadDotEnv(). O .env lido é o do consumidor
    // (REPO_PATH ou cwd), não o diretório do script da plataforma.
    const src = fs.readFileSync(WATCHER, 'utf8');
    const loadAt = src.indexOf("loadDotEnv(path.join(process.env.REPO_PATH || process.cwd(), '.env'))");
    assert.ok(loadAt > 0, 'loadDotEnv do consumidor');
    assert.ok(src.indexOf('const SIMULATE = dryRun.isEnabled(process.env)') < loadAt, 'SIMULATE antes do loadDotEnv');
});
