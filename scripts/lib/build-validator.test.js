// node --test scripts/lib/build-validator.test.js
// Portão de build pré-implement: parser/exec do build-validator com exec stubado, e o
// fluxo do watcher (dispatchTicket) com `mvn` e `claude` falsos no PATH, REPO_PATH
// sintético e fetch do Redmine stubado.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const bv = require('./build-validator');
process.env.PRE_BUILD_COMMAND = process.env.PRE_BUILD_COMMAND || 'mvn compile -q --no-transfer-progress';

const tmp = fs.mkdtempSync(path.join(process.env.CLAUDE_JOB_DIR ? path.join(process.env.CLAUDE_JOB_DIR, 'tmp') : os.tmpdir(), 'build-validator-'));
const repo = path.join(tmp, 'app-back');
const binDir = path.join(tmp, 'bin');
const claudeCalls = path.join(tmp, 'claude-calls.log');
const mvnCalls = path.join(tmp, 'mvn-calls.log');
const mvnMode = path.join(tmp, 'mvn-mode');
fs.mkdirSync(repo, { recursive: true });
fs.mkdirSync(binDir);
fs.writeFileSync(path.join(binDir, 'claude'), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${claudeCalls}'\n`, { mode: 0o755 });
fs.writeFileSync(path.join(binDir, 'osascript'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
// mvn falso: registra a chamada; "fail" imprime erros no formato do maven-compiler-plugin
// (no stdout, como o Maven real) e sai 1.
fs.writeFileSync(path.join(binDir, 'mvn'), `#!/bin/sh
printf '%s|%s\\n' "$PWD" "$*" >> '${mvnCalls}'
if [ "$(cat '${mvnMode}' 2>/dev/null)" = "jdk" ]; then
  echo "[ERROR] Failed to execute goal org.apache.maven.plugins:maven-compiler-plugin:3.11.0:compile (default-compile) on project app-back: Fatal error compiling: error: release version 25 not supported -> [Help 1]"
  exit 1
fi
if [ "$(cat '${mvnMode}' 2>/dev/null)" = "fail" ]; then
  echo "[ERROR] COMPILATION ERROR :"
  echo "[ERROR] $PWD/src/main/java/br/Foo.java:[12,9] cannot find symbol"
  echo "  symbol:   variable total"
  echo "  location: class br.Foo"
  exit 1
fi
exit 0
`, { mode: 0o755 });
process.env.REPO_PATH = repo;
// Portão do plano (runPlanGate) fora do escopo: estes seeds não têm handoff.md — threshold 0 aprova qualquer plano.
process.env.PLAN_SCORE_THRESHOLD = '0';
process.env.REDMINE_URL = 'http://redmine.test';
process.env.REDMINE_API_KEY = 'k';
process.env.PATH = `${binDir}:${process.env.PATH}`;
delete process.env.SKIP_PRE_BUILD_VALIDATION;

// Redmine stub: PUTs gravados em `puts`; GET de journals devolve `journals`.
let puts = [];
let journals = [];
global.fetch = async (url, opts = {}) => {
    if (opts.method === 'PUT') {
        const notes = JSON.parse(opts.body).issue.notes;
        puts.push({ url, notes });
        journals.push({ id: journals.length + 1, notes, user: { name: 'Watcher' }, created_on: new Date().toISOString() });
        return { ok: true, status: 204, json: async () => ({}) };
    }
    return { ok: true, status: 200, json: async () => ({ issue: { journals } }) };
};

const watcher = require('../readmine-watcher');

// ---------------------------------------------------------------- parser / exec

const MAVEN_OUT = `[ERROR] COMPILATION ERROR :
[INFO] -------------------------------------------------------------
[ERROR] /w/app/src/main/java/br/Foo.java:[12,9] cannot find symbol
  symbol:   variable total
  location: class br.Foo
[ERROR] /w/app/src/main/java/br/Bar.java:[40] ';' expected
[INFO] 2 errors
[ERROR] Failed to execute goal org.apache.maven.plugins:maven-compiler-plugin:3.11.0:compile (default-compile) on project app: Compilation failure: Compilation failure:
[ERROR] /w/app/src/main/java/br/Foo.java:[12,9] cannot find symbol
[ERROR] -> [Help 1]`;

test('parseCompileErrors: arquivo relativo:linha — mensagem, com symbol, sem duplicata do bloco final', () => {
    assert.deepStrictEqual(bv.parseCompileErrors(MAVEN_OUT, '/w/app'), [
        'src/main/java/br/Foo.java:12 — cannot find symbol (symbol: variable total)',
        "src/main/java/br/Bar.java:40 — ';' expected",
    ]);
});

test('parseCompileErrors: caminho fora do worktree fica absoluto; saída sem erro Java => []', () => {
    assert.deepStrictEqual(bv.parseCompileErrors('[ERROR] /outro/X.java:[3,1] boom', '/w/app'), ['/outro/X.java:3 — boom']);
    assert.deepStrictEqual(bv.parseCompileErrors('[INFO] BUILD SUCCESS', '/w/app'), []);
});

test('parseCompileErrors: worktree acessado por link simbólico relativiza o caminho físico', () => {
    const real = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bv-real-')));
    const link = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bv-link-')), 'wt');
    fs.symlinkSync(real, link);
    const out = `[ERROR] ${real}/src/main/java/br/Foo.java:[12,9] cannot find symbol`;
    assert.deepStrictEqual(bv.parseCompileErrors(out, link), ['src/main/java/br/Foo.java:12 — cannot find symbol']);
});

function fakeExec(err, stdout = '', stderr = '', calls = []) {
    return (cmd, opts, cb) => { calls.push({ cmd, opts }); setImmediate(() => cb(err, stdout, stderr)); };
}

test('validateBuild: sem PRE_BUILD_COMMAND não executa e não trata como falha de compilação', async () => {
    const calls = [];
    const r = await bv.validateBuild('/w/app', { exec: fakeExec(null, '', '', calls), env: {} });
    assert.strictEqual(r.success, false);
    assert.strictEqual(r.configurationError, 'pre_build_unconfigured');
    assert.strictEqual(r.infraError, undefined);
    const state = { status: 'in_progress', preBuildAccepted: { by: 'old' }, preBuildStatus: 'passed' };
    assert.strictEqual(bv.applyResult(state, r), 'failed');
    assert.strictEqual(state.status, 'pre-build-failed');
    assert.strictEqual(state.preBuildStatus, 'failed');
    assert.strictEqual(state.preBuildAccepted, undefined);
    assert.deepStrictEqual(state.preBuildErrors, ['PRE_BUILD_COMMAND não configurado pelo consumidor']);
    assert.strictEqual(calls.length, 0);
});

test('validateBuild: sucesso => {success:true, errors:[], duration}; roda o comando certo no worktree com timeout', async () => {
    const calls = [];
    const r = await bv.validateBuild('/w/app', { exec: fakeExec(null, '', '', calls), timeoutMs: 5000 });
    assert.strictEqual(r.success, true);
    assert.deepStrictEqual(r.errors, []);
    assert.ok(Number.isFinite(r.duration));
    assert.strictEqual(calls[0].cmd, 'mvn compile -q --no-transfer-progress');
    assert.strictEqual(calls[0].opts.cwd, '/w/app');
    assert.strictEqual(calls[0].opts.timeout, 5000);
});

test('validateBuild: erro de compilação lido do stdout e do stderr', async () => {
    const err = Object.assign(new Error('exit 1'), { code: 1 });
    const r = await bv.validateBuild('/w/app', { exec: fakeExec(err, '', MAVEN_OUT) });
    assert.strictEqual(r.success, false);
    assert.strictEqual(r.errors.length, 2);
    const r2 = await bv.validateBuild('/w/app', { exec: fakeExec(err, MAVEN_OUT, '') });
    assert.deepStrictEqual(r2.errors, r.errors);
});

test('validateBuild: falha sem erro Java devolve as linhas [ERROR] cruas, sem o ruído de ajuda', async () => {
    const err = Object.assign(new Error('exit 1'), { code: 1 });
    const out = '[ERROR] Failed to execute goal on project app: Could not resolve dependencies for project br:app:jar:1.0\n[ERROR] \n[ERROR] -> [Help 1]\n[ERROR] Re-run Maven using the -X switch';
    const r = await bv.validateBuild('/w/app', { exec: fakeExec(err, out) });
    assert.deepStrictEqual(r.errors, ['Failed to execute goal on project app: Could not resolve dependencies for project br:app:jar:1.0']);
});

test('validateBuild: timeout vira falha com timedOut', async () => {
    const err = Object.assign(new Error('killed'), { killed: true, signal: 'SIGKILL', code: null });
    const r = await bv.validateBuild('/w/app', { exec: fakeExec(err), timeoutMs: 1000 });
    assert.strictEqual(r.success, false);
    assert.strictEqual(r.timedOut, true);
    assert.match(r.errors[0], /Timeout.*1s/);
});

test('validateBuild: mvn ausente => infraError (não é erro do código)', async () => {
    const err = Object.assign(new Error('not found'), { code: 127 });
    const r = await bv.validateBuild('/w/app', { exec: fakeExec(err, '', 'sh: mvn: command not found') });
    assert.strictEqual(r.infraError, 'mvn_not_found');
});

test('validateBuild: "release version 25 not supported" é JDK errado (ambiente), não erro da base', async () => {
    const err = Object.assign(new Error('exit 1'), { code: 1 });
    const out = '[ERROR] Failed to execute goal org.apache.maven.plugins:maven-compiler-plugin:3.11.0:compile (default-compile) on project app-back: Fatal error compiling: error: release version 25 not supported -> [Help 1]';
    const r = await bv.validateBuild('/w/app', { exec: fakeExec(err, out), java: { javaHome: '/jdk17', source: 'herdado' } });
    assert.strictEqual(r.success, false);
    assert.strictEqual(r.infraError, 'jdk_mismatch');
    assert.match(r.errors[0], /JDK incompatível.*JAVA_HOME=\/jdk17.*release version 25 not supported/);
    assert.strictEqual(r.javaHome, '/jdk17');
});

test('resolveJavaHome: explícito > herdado suficiente > java_home -v <release do pom>', () => {
    const dir = fs.mkdtempSync(path.join(tmp, 'jdk-'));
    const jdk = (name, v) => { const h = path.join(dir, name); fs.mkdirSync(h); fs.writeFileSync(path.join(h, 'release'), `JAVA_VERSION="${v}"\n`); return h; };
    const j17 = jdk('j17', '17.0.18'); const j25 = jdk('j25', '25.0.2'); const j8 = jdk('j8', '1.8.0_482');
    const wt = path.join(dir, 'wt'); fs.mkdirSync(wt);
    fs.writeFileSync(path.join(wt, 'pom.xml'), '<project><properties><maven.compiler.release>25</maven.compiler.release></properties></project>');
    assert.strictEqual(bv.requiredRelease(wt), 25);
    assert.strictEqual(bv.javaMajor(j8), 8);
    const lookups = [];
    const javaHomeFor = v => { lookups.push(v); return v === 25 ? j25 : null; };
    assert.deepStrictEqual(bv.resolveJavaHome(wt, { JAVA_HOME: j17 }, { javaHomeFor }), { javaHome: j25, source: 'java_home -v 25' });
    assert.deepStrictEqual(lookups, [25]);
    assert.strictEqual(bv.resolveJavaHome(wt, { JAVA_HOME: j25 }, { javaHomeFor }).source, 'herdado');
    assert.strictEqual(bv.resolveJavaHome(wt, { JAVA_HOME: j17, PREVIEW_JAVA_HOME: '/p' }, { javaHomeFor }).javaHome, '/p');
    assert.strictEqual(bv.resolveJavaHome(wt, { JAVA_HOME: j17, PREVIEW_JAVA_HOME: '/p', PRE_BUILD_JAVA_HOME: '/x' }, { javaHomeFor }).javaHome, '/x');
    const missing = bv.resolveJavaHome(wt, { JAVA_HOME: j17 }, { javaHomeFor: () => null });
    assert.strictEqual(missing.javaHome, j17);
    assert.match(missing.warning, /release 25/);
    assert.strictEqual(bv.resolveJavaHome(dir, { JAVA_HOME: j17 }, { javaHomeFor }).javaHome, j17, 'sem pom: herdado');
});

test('validateBuild: roda o mvn com JAVA_HOME e PATH do JDK resolvido', async () => {
    const calls = [];
    await bv.validateBuild('/w/app', { exec: fakeExec(null, '', '', calls), java: { javaHome: '/jdk25', source: 't' }, env: { PATH: '/usr/bin', PRE_BUILD_COMMAND: 'mvn compile -q --no-transfer-progress' } });
    assert.strictEqual(calls[0].opts.env.JAVA_HOME, '/jdk25');
    assert.strictEqual(calls[0].opts.env.PATH, `/jdk25/bin${path.delimiter}/usr/bin`);
});

test('staleDependencies: só quando TODO erro é classe ausente que existe num repo irmão', () => {
    const findClass = (repo, cls) => (repo.endsWith('app-core') && cls === 'FRecalculoOrdemCargaLoteService' ? 'origin/master' : null);
    const e1 = 'src/F.java:27 — cannot find symbol (symbol: class FRecalculoOrdemCargaLoteService)';
    const e2 = 'src/F.java:113 — cannot find symbol (symbol: class FRecalculoOrdemCargaLoteService)';
    const repos = ['/ws/app-core', '/ws/mo-entity'];
    assert.deepStrictEqual(bv.staleDependencies([e1, e2], repos, { findClass }), [{ cls: 'FRecalculoOrdemCargaLoteService', repo: '/ws/app-core', ref: 'origin/master' }]);
    assert.strictEqual(bv.staleDependencies([e1, 'src/G.java:3 — cannot find symbol (symbol: class Inexistente)'], repos, { findClass }), null);
    assert.strictEqual(bv.staleDependencies([e1, "src/G.java:3 — ';' expected"], repos, { findClass }), null);
    assert.strictEqual(bv.staleDependencies([e1], [], { findClass }), null);
});

test('validateBuild: classe de repo irmão ausente do ~/.m2 => infraError stale_dependency', async () => {
    const err = Object.assign(new Error('exit 1'), { code: 1 });
    const out = '[ERROR] /w/app/src/F.java:[27,43] cannot find symbol\n  symbol:   class FRecalculoOrdemCargaLoteService\n  location: package br.x\n[ERROR] /w/app/src/F.java:[27,43] cannot find symbol';
    const r = await bv.validateBuild('/w/app', { exec: fakeExec(err, out), java: { javaHome: null, source: 't' },
        siblingRepos: ['/ws/app-core'], findClass: () => 'origin/master' });
    assert.strictEqual(r.infraError, 'stale_dependency');
    assert.match(r.errors[0], /FRecalculoOrdemCargaLoteService existe em app-core \(origin\/master\).*mvn install -DskipTests.*app-core/);
});

test('resolveTimeoutMs / skipRequested', () => {
    assert.strictEqual(bv.resolveTimeoutMs({}), 120000);
    assert.strictEqual(bv.resolveTimeoutMs({ PRE_BUILD_TIMEOUT_MS: '3000' }), 3000);
    assert.strictEqual(bv.resolveTimeoutMs({ PRE_BUILD_TIMEOUT_MS: 'x' }), 120000);
    assert.strictEqual(bv.skipRequested({ SKIP_PRE_BUILD_VALIDATION: 'true' }), true);
    assert.strictEqual(bv.skipRequested({ SKIP_PRE_BUILD_VALIDATION: 'TRUE' }), true);
    assert.strictEqual(bv.skipRequested({ SKIP_PRE_BUILD_VALIDATION: '1' }), false);
    assert.strictEqual(bv.skipRequested({}), false);
});

// ---------------------------------------------------------------- watcher

function seed(id, { node = 'implement', history = ['fetch_ticket', 'plan'], status = 'in_progress', extra = {} } = {}) {
    const taskId = `${id}-teste`;
    const dir = path.join(repo, '.claude', 'worktrees', String(id), 'memory', 'runs', taskId);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({
        task_id: taskId, node, history, status, started_at: new Date().toISOString(), ...extra,
    }));
    fs.writeFileSync(path.join(dir, 'context.md'), '# Contexto\n');
    // Plano que passa no portão de plano (runPlanGate, roda antes deste portão).
    fs.writeFileSync(path.join(dir, 'handoff.md'), '## Plano de execução\n\n' + [1, 2, 3].map(i =>
        `${i}. Ajustar passo ${i}. Arquivo: \`src/main/java/br/Passo${i}.java\`. Verificação: \`mvn compile\` passa.`).join('\n') + '\n');
    return { taskId, dir };
}
const readState = dir => JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'));
const claudeLog = () => (fs.existsSync(claudeCalls) ? fs.readFileSync(claudeCalls, 'utf8') : '');
const mvnCount = () => (fs.existsSync(mvnCalls) ? fs.readFileSync(mvnCalls, 'utf8').trim().split('\n').filter(Boolean).length : 0);

function ticket(id) {
    return {
        id, subject: `Ticket ${id}`, description: '', status: { name: 'Em Desenvolvimento' }, tracker: { name: 'Melhoria' },
        custom_fields: [{ name: 'Branch Liberação', value: 'Dev - Local' }], updated_on: new Date().toISOString(),
    };
}

async function waitFor(fn) {
    for (let i = 0; i < 50; i++) { if (fn()) return true; await new Promise(r => setTimeout(r, 50)); }
    return false;
}

test.beforeEach(() => {
    puts = []; journals = [];
    fs.rmSync(mvnCalls, { force: true });
    fs.rmSync(claudeCalls, { force: true });
    fs.writeFileSync(mvnMode, 'ok');
    delete process.env.SKIP_PRE_BUILD_VALIDATION;
});

test('needsPreBuildGate', () => {
    const g = watcher.needsPreBuildGate;
    assert.strictEqual(g({ node: 'implement', history: ['plan'] }), true);
    assert.strictEqual(g({ node: 'plan', history: [] }), false);
    assert.strictEqual(g({ node: 'implement', history: ['plan'], preBuildStatus: 'passed' }), false);
    assert.strictEqual(g({ node: 'implement', history: ['plan'], preBuildStatus: 'skipped' }), false);
    assert.strictEqual(g({ node: 'implement', history: ['plan', 'implement', 'review'] }), false, 'voltou do review: worktree já tem mudança do agente');
    assert.strictEqual(g({ node: 'implement', history: ['plan'], status: 'pre-build-failed', preBuildStatus: 'failed' }), true);
    assert.strictEqual(g({ node: 'implement', history: ['plan'], status: 'in_progress', preBuildStatus: 'failed' }), true, 'humano voltou status à mão => recompila');
    assert.strictEqual(g({ node: 'implement', history: ['plan'], preBuildStatus: 'failed', preBuildAccepted: { at: 'x' } }), false);
});

test('aceite: build sem erro => passed + duração, implement despachado', async () => {
    const { dir, taskId } = seed(93001);
    const r = await watcher.dispatchTicket(ticket(93001));
    assert.strictEqual(r.action, 'dispatched');
    assert.strictEqual(mvnCount(), 1);
    assert.match(fs.readFileSync(mvnCalls, 'utf8'), /\/\.claude\/worktrees\/93001\|compile -q --no-transfer-progress/);
    const s = readState(dir);
    assert.strictEqual(s.preBuildStatus, 'passed');
    assert.ok(typeof s.preBuildDurationMs === 'number' && s.preBuildDurationMs >= 0);
    assert.strictEqual(s.preBuildErrors, undefined);
    assert.strictEqual(puts.length, 0);
    assert.ok(await waitFor(() => claudeLog().includes(`/implement ${taskId}`)));
});

test('aceite: erro de compilação => pre-build-failed, erros no state, comentário no Redmine, implement NÃO despachado', async () => {
    fs.writeFileSync(mvnMode, 'fail');
    const { dir } = seed(93002);
    const r = await watcher.dispatchTicket(ticket(93002));
    assert.strictEqual(r.action, 'skip');
    assert.strictEqual(r.reason, 'pre_build_falhou');
    const s = readState(dir);
    assert.strictEqual(s.status, 'pre-build-failed');
    assert.strictEqual(s.preBuildStatus, 'failed');
    assert.deepStrictEqual(s.preBuildErrors, ['src/main/java/br/Foo.java:12 — cannot find symbol (symbol: variable total)']);
    assert.ok(typeof s.preBuildDurationMs === 'number');
    assert.strictEqual(s.events.at(-1).type, 'pre_build_failed');
    assert.strictEqual(puts.length, 1);
    assert.match(puts[0].url, /\/issues\/93002\.json$/);
    assert.ok(puts[0].notes.startsWith(watcher.PRE_BUILD_COMMENT_PREFIX));
    assert.match(puts[0].notes, /Foo\.java:12 — cannot find symbol/);
    await new Promise(r2 => setTimeout(r2, 150));
    assert.ok(!claudeLog().includes('/implement'), 'claude não pode ter sido chamado');

    // Tick seguinte sem mudança: sem aceite, não roda mvn de novo nem recomenta.
    const again = await watcher.dispatchTicket(ticket(93002));
    assert.strictEqual(again.reason, 'pre_build_falhou');
    assert.strictEqual(puts.length, 1);
});

test('falha + "aceito" no Redmine => implement despachado com os erros no prompt', async () => {
    fs.writeFileSync(mvnMode, 'fail');
    const { dir, taskId } = seed(93003);
    await watcher.dispatchTicket(ticket(93003));
    // "aceito" ANTES do comentário não vale; depois vale.
    journals.unshift({ id: 0, notes: 'aceito', user: { name: 'Dev' }, created_on: '2026-01-01T00:00:00Z' });
    assert.strictEqual((await watcher.dispatchTicket(ticket(93003))).reason, 'pre_build_falhou');
    journals.push({ id: 99, notes: 'aceito, o ticket é justamente corrigir isso', user: { name: 'Dev' }, created_on: new Date().toISOString() });
    const r = await watcher.dispatchTicket(ticket(93003));
    assert.strictEqual(r.action, 'dispatched');
    const s = readState(dir);
    assert.strictEqual(s.preBuildStatus, 'failed');
    assert.match(s.preBuildAccepted.by, /Dev/);
    assert.ok(await waitFor(() => new RegExp(`/implement ${taskId}[\\s\\S]*Foo\\.java:12`).test(claudeLog())));
});

test('falha com worktree alterado => recompila; se passar volta pra in_progress e despacha', async () => {
    fs.writeFileSync(mvnMode, 'fail');
    const { dir } = seed(93004);
    await watcher.dispatchTicket(ticket(93004));
    // Worktree sem git => fingerprint null => sempre recompila no tick seguinte.
    fs.writeFileSync(mvnMode, 'ok');
    const r = await watcher.dispatchTicket(ticket(93004));
    assert.strictEqual(r.action, 'dispatched');
    assert.strictEqual(mvnCount(), 2);
    const s = readState(dir);
    assert.strictEqual(s.preBuildStatus, 'passed');
    assert.strictEqual(s.preBuildErrors, undefined);
});

test('worktree git sem mudança não roda mvn de novo; mudança fora de memory/ recompila', async () => {
    fs.writeFileSync(mvnMode, 'fail');
    const { dir } = seed(93009);
    const wt = path.join(repo, '.claude', 'worktrees', '93009');
    const { execFileSync } = require('child_process');
    const git = (...a) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { cwd: wt, stdio: 'ignore' });
    fs.writeFileSync(path.join(wt, '.gitignore'), 'memory/\n');
    fs.writeFileSync(path.join(wt, 'Foo.java'), 'class Foo {}\n');
    git('init', '-q'); git('add', '.'); git('commit', '-qm', 'base');

    await watcher.dispatchTicket(ticket(93009));
    assert.strictEqual(mvnCount(), 1);
    assert.match(readState(dir).preBuildFingerprint, /^[0-9a-f]{40}$/);
    await watcher.dispatchTicket(ticket(93009));
    assert.strictEqual(mvnCount(), 1, 'mesmo worktree (state.json mudou, mas memory/ não conta) => sem mvn');

    fs.writeFileSync(path.join(wt, 'Foo.java'), 'class Foo { int total; }\n');
    fs.writeFileSync(mvnMode, 'ok');
    const r = await watcher.dispatchTicket(ticket(93009));
    assert.strictEqual(mvnCount(), 2);
    assert.strictEqual(r.action, 'dispatched');
});

test('JDK errado => skipped com motivo (sem comentário no Redmine, implement segue)', async () => {
    fs.writeFileSync(mvnMode, 'jdk');
    const { dir } = seed(93010);
    const r = await watcher.dispatchTicket(ticket(93010));
    assert.strictEqual(r.action, 'dispatched');
    const s2 = readState(dir);
    assert.strictEqual(s2.preBuildStatus, 'skipped');
    assert.match(s2.preBuildSkipReason, /release version 25 not supported/);
    assert.strictEqual(s2.status === 'pre-build-failed', false);
    assert.strictEqual(puts.length, 0);
});

test('task pre-build-failed gravada antes da resolução de JDK (sem preBuildJavaHome) recompila mesmo sem mudança no worktree', async () => {
    const { dir } = seed(93011, { status: 'pre-build-failed', extra: {
        preBuildStatus: 'failed', preBuildDurationMs: 3500, preBuildFingerprint: 'x',
        preBuildErrors: ['Failed to execute goal ...: Fatal error compiling: error: release version 25 not supported -> [Help 1]'],
    } });
    const r = await watcher.dispatchTicket(ticket(93011));
    assert.strictEqual(mvnCount(), 1);
    assert.strictEqual(r.action, 'dispatched');
    assert.strictEqual(readState(dir).preBuildStatus, 'passed');
    assert.notStrictEqual(readState(dir).status, 'pre-build-failed'); // 'running' enquanto o claude falso roda
});

test('"Corrigir com IA" do dashboard rodando (pid vivo) => watcher espera; pid morto não prende o ticket', async () => {
    fs.writeFileSync(mvnMode, 'fail');
    const { dir } = seed(93010);
    await watcher.dispatchTicket(ticket(93010));
    assert.strictEqual(readState(dir).status, 'pre-build-failed');
    const s = readState(dir);
    s.preBuildAiFix = { status: 'running', startedAt: new Date().toISOString(), pid: process.pid };
    fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify(s));
    fs.writeFileSync(mvnMode, 'ok');
    process.env.SKIP_PRE_BUILD_VALIDATION = 'true'; // nem o skip atropela a correção em andamento
    const r = await watcher.dispatchTicket(ticket(93010));
    assert.strictEqual(r.action, 'skip');
    assert.strictEqual(mvnCount(), 1);
    assert.strictEqual(readState(dir).status, 'pre-build-failed');
    delete process.env.SKIP_PRE_BUILD_VALIDATION;
    // Dashboard caiu: pid não existe mais => portão segue normal (recompila e despacha).
    const orphan = readState(dir);
    orphan.preBuildAiFix.pid = 2 ** 22 + 12345;
    fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify(orphan));
    assert.strictEqual((await watcher.dispatchTicket(ticket(93010))).action, 'dispatched');
    assert.strictEqual(readState(dir).preBuildStatus, 'passed');
});

test('SKIP_PRE_BUILD_VALIDATION=true => skipped, sem mvn, implement despachado', async () => {
    process.env.SKIP_PRE_BUILD_VALIDATION = 'true';
    const { dir } = seed(93005);
    const r = await watcher.dispatchTicket(ticket(93005));
    assert.strictEqual(r.action, 'dispatched');
    assert.strictEqual(mvnCount(), 0);
    assert.strictEqual(readState(dir).preBuildStatus, 'skipped');
});

test('nós fora de implement (e implement vindo do review) não rodam o portão', async () => {
    seed(93006, { node: 'review', history: ['fetch_ticket', 'plan', 'implement'] });
    seed(93007, { node: 'implement', history: ['fetch_ticket', 'plan', 'implement', 'review'] });
    assert.strictEqual((await watcher.dispatchTicket(ticket(93006))).action, 'dispatched');
    assert.strictEqual((await watcher.dispatchTicket(ticket(93007))).action, 'dispatched');
    assert.strictEqual(mvnCount(), 0);
});

test('state.json gravado pelo portão passa no schema', async () => {
    fs.writeFileSync(mvnMode, 'fail');
    const { dir, taskId } = seed(93008);
    await watcher.dispatchTicket(ticket(93008));
    const { readAndValidateState } = require('../validate-state');
    const check = readAndValidateState(taskId, { dir });
    assert.ok(check.valid, check.errors?.join('; '));
});

test.after(async () => {
    // Deixa os `claude` falsos (spawn assíncrono) terminarem antes de apagar o tmp.
    await new Promise(r => setTimeout(r, 300));
    fs.rmSync(tmp, { recursive: true, force: true });
});

// Consumer command, cwd, env and JDK must travel together even with an ambient command.
test('validateBuild: explicit command and isolated env win over ambient defaults', async () => {
    const calls = [];
    const r = await bv.validateBuild('/consumer/worktree', {
        command: 'consumer-build --check', env: { PRE_BUILD_COMMAND: 'env-build', PATH: '/consumer/bin', CONSUMER: 'B' },
        java: { javaHome: '/consumer/jdk', source: 'explicit' }, exec: fakeExec(null, '', '', calls),
    });
    assert.strictEqual(r.success, true);
    assert.strictEqual(calls[0].cmd, 'consumer-build --check');
    assert.strictEqual(calls[0].opts.cwd, '/consumer/worktree');
    assert.deepStrictEqual(calls[0].opts.env, {
        PRE_BUILD_COMMAND: 'env-build', PATH: '/consumer/jdk/bin' + path.delimiter + '/consumer/bin',
        CONSUMER: 'B', JAVA_HOME: '/consumer/jdk',
    });
});
