// node --test scripts/lib/churn-detector.test.js
// Churn de implementação: detectChurn/snapshots num repo git real (temporário), e o
// portão do watcher (runChurnGate via dispatchTicket) com `claude` falso no PATH,
// REPO_PATH sintético e fetch do Redmine stubado.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const cd = require('./churn-detector');

const tmp = fs.mkdtempSync(path.join(process.env.CLAUDE_JOB_DIR ? path.join(process.env.CLAUDE_JOB_DIR, 'tmp') : os.tmpdir(), 'churn-detector-'));
const repo = path.join(tmp, 'app-back');
const binDir = path.join(tmp, 'bin');
const claudeCalls = path.join(tmp, 'claude-calls.log');
fs.mkdirSync(repo, { recursive: true });
fs.mkdirSync(binDir);
fs.writeFileSync(path.join(binDir, 'claude'), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${claudeCalls}'\n`, { mode: 0o755 });
fs.writeFileSync(path.join(binDir, 'osascript'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
process.env.REPO_PATH = repo;
process.env.PLAN_SCORE_THRESHOLD = '0';
process.env.SKIP_PRE_BUILD_VALIDATION = 'true';
process.env.REDMINE_URL = 'http://redmine.test';
process.env.REDMINE_API_KEY = 'k';
process.env.PATH = `${binDir}:${process.env.PATH}`;
delete process.env.CHURN_THRESHOLD;

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

const git = (cwd, ...a) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
function initRepo(dir) {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, '.gitignore'), 'memory/\n');
    fs.writeFileSync(path.join(dir, 'Foo.java'), 'class Foo {}\n');
    git(dir, 'init', '-q'); git(dir, 'add', '.'); git(dir, 'commit', '-qm', 'base');
    return git(dir, 'rev-parse', 'HEAD');
}
function commit(dir, files, msg) {
    for (const [f, c] of Object.entries(files)) {
        fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
        fs.writeFileSync(path.join(dir, f), c);
    }
    git(dir, 'add', '-A'); git(dir, 'commit', '-qm', msg);
}

// ---------------------------------------------------------------- detector

test('resolveThreshold: CHURN_THRESHOLD válido (>= 2) sobrescreve; inválido cai no 3', () => {
    assert.strictEqual(cd.resolveThreshold({}), 3);
    assert.strictEqual(cd.resolveThreshold({ CHURN_THRESHOLD: '5' }), 5);
    assert.strictEqual(cd.resolveThreshold({ CHURN_THRESHOLD: '1' }), 3);
    assert.strictEqual(cd.resolveThreshold({ CHURN_THRESHOLD: 'x' }), 3);
});

test('isTestFile / thresholdFor: *Test.java e *Spec.js têm threshold dobrado', () => {
    for (const f of ['src/test/java/br/FooTest.java', 'src/test/java/br/FooTests.java', 'src/test/java/br/FooIT.java', 'app/FooSpec.js', 'app/foo.spec.js', 'app/foo.test.ts']) {
        assert.strictEqual(cd.isTestFile(f), true, f);
        assert.strictEqual(cd.thresholdFor(f, 3), 6, f);
    }
    for (const f of ['src/main/java/br/Foo.java', 'src/main/java/br/Testador.java', 'app/spec.md']) {
        assert.strictEqual(cd.isTestFile(f), false, f);
        assert.strictEqual(cd.thresholdFor(f, 3), 3, f);
    }
});

test('parseLog: separa commits e arquivos; ignora memory/ e .DS_Store', () => {
    const out = '\x1eabc123 implement #2: review reprovou\n\nsrc/A.java\nmemory/runs/x/state.json\n\x1edef456 implement #1\n\nsrc/A.java\nsrc/.DS_Store\nsrc/B.java\n';
    assert.deepStrictEqual(cd.parseLog(out), [
        { sha: 'abc123', subject: 'implement #2: review reprovou', files: ['src/A.java'] },
        { sha: 'def456', subject: 'implement #1', files: ['src/A.java', 'src/B.java'] },
    ]);
    assert.deepStrictEqual(cd.parseLog(''), []);
});

test('detectChurn: arquivo em 3 commits do ciclo => churn; só conta depois da âncora', async () => {
    const dir = path.join(tmp, 'det-1');
    initRepo(dir);
    commit(dir, { 'src/A.java': 'a0' }, 'antes do ciclo');
    commit(dir, { 'src/A.java': 'a00' }, 'antes do ciclo 2');
    const anchor = git(dir, 'rev-parse', 'HEAD');
    commit(dir, { 'src/A.java': 'a1', 'src/B.java': 'b1' }, 'rodada 1');
    commit(dir, { 'src/A.java': 'a2' }, 'rodada 2');
    commit(dir, { 'src/A.java': 'a3', 'src/B.java': 'b3' }, 'rodada 3');

    const r = await cd.detectChurn(dir, 3, { anchor });
    assert.strictEqual(r.churnDetected, true);
    assert.strictEqual(r.commitsAnalyzed, 3);
    assert.deepStrictEqual(r.files.map(f => [f.path, f.modificationCount]), [['src/A.java', 3]]);
    assert.deepStrictEqual(r.files[0].commits.map(c => c.replace(/^\S+ /, '')), ['rodada 3', 'rodada 2', 'rodada 1']);
    assert.match(r.files[0].commits[0], /^[0-9a-f]{7,} rodada 3$/);
    assert.deepStrictEqual(r.counts, { 'src/A.java': 3, 'src/B.java': 2 });

    const semAncora = await cd.detectChurn(dir, 3);
    assert.strictEqual(semAncora.files[0].modificationCount, 5, 'sem âncora conta o histórico inteiro');
    const limite4 = await cd.detectChurn(dir, 4, { anchor });
    assert.strictEqual(limite4.churnDetected, false);
});

test('detectChurn: arquivo de teste modificado 3x NÃO é churn (threshold dobrado); 6x é', async () => {
    const dir = path.join(tmp, 'det-2');
    const anchor = initRepo(dir);
    for (let i = 1; i <= 3; i++) commit(dir, { 'src/test/java/br/FooTest.java': `t${i}`, 'web/FooSpec.js': `s${i}` }, `rodada ${i}`);
    const r = await cd.detectChurn(dir, 3, { anchor });
    assert.strictEqual(r.churnDetected, false);
    assert.strictEqual(r.counts['src/test/java/br/FooTest.java'], 3);
    for (let i = 4; i <= 6; i++) commit(dir, { 'src/test/java/br/FooTest.java': `t${i}` }, `rodada ${i}`);
    const r6 = await cd.detectChurn(dir, 3, { anchor });
    assert.deepStrictEqual(r6.files.map(f => [f.path, f.modificationCount, f.threshold]), [['src/test/java/br/FooTest.java', 6, 6]]);
});

test('detectChurn: baseline aceito desconta as rodadas já aceitas', async () => {
    const dir = path.join(tmp, 'det-3');
    const anchor = initRepo(dir);
    for (let i = 1; i <= 4; i++) commit(dir, { 'src/A.java': `a${i}` }, `rodada ${i}`);
    assert.strictEqual((await cd.detectChurn(dir, 3, { anchor, baseline: { 'src/A.java': 3 } })).churnDetected, false);
    for (let i = 5; i <= 6; i++) commit(dir, { 'src/A.java': `a${i}` }, `rodada ${i}`);
    assert.strictEqual((await cd.detectChurn(dir, 3, { anchor, baseline: { 'src/A.java': 3 } })).churnDetected, true);
});

test('ensureAnchor/recordRound: snapshot do worktree (inclui untracked) sem mexer em branch, índice nem working tree', async () => {
    const dir = path.join(tmp, 'snap');
    const base = initRepo(dir);
    fs.writeFileSync(path.join(dir, 'Foo.java'), 'class Foo { int x; }\n'); // mudança pré-existente não commitada
    const anchor = cd.ensureAnchor(dir, 't-1');
    assert.match(anchor, /^[0-9a-f]{40}$/);
    assert.strictEqual(cd.ensureAnchor(dir, 't-1'), anchor, 'idempotente');
    assert.strictEqual(cd.recordRound(dir, 't-1', 'implement #1'), null, 'nada mudou desde a âncora => sem rodada');

    fs.writeFileSync(path.join(dir, 'Novo.java'), 'class Novo {}\n');
    fs.mkdirSync(path.join(dir, 'memory'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'memory', 'x.md'), 'ignorado');
    const r1 = cd.recordRound(dir, 't-1', 'implement #1');
    assert.match(r1, /^[0-9a-f]{40}$/);
    assert.strictEqual(cd.recordRound(dir, 't-1', 'implement #1'), null, 'idempotente sem mudança');
    fs.writeFileSync(path.join(dir, 'Novo.java'), 'class Novo { }\n');
    cd.recordRound(dir, 't-1', 'implement #2: review reprovou');

    assert.strictEqual(git(dir, 'rev-parse', 'HEAD'), base, 'branch intocada');
    assert.deepStrictEqual(execFileSync('git', ['status', '--porcelain'], { cwd: dir, encoding: 'utf8' }).split('\n').filter(Boolean), [' M Foo.java', '?? Novo.java'], 'índice/working tree intocados');
    const r = await cd.detectChurn(dir, 2, { anchor: cd.anchorRef('t-1'), head: cd.roundsRef('t-1') });
    assert.deepStrictEqual(r.files.map(f => [f.path, f.modificationCount]), [['Novo.java', 2]]);
    assert.deepStrictEqual(r.files[0].commits.map(c => c.replace(/^\S+ /, '')), ['implement #2: review reprovou', 'implement #1']);
});

test('ensureAnchor fora de repo git => null', () => {
    const dir = path.join(tmp, 'nao-git');
    fs.mkdirSync(dir);
    assert.strictEqual(cd.ensureAnchor(dir, 't'), null);
});

// ---------------------------------------------------------------- watcher

function seed(id, { node = 'implement', history = ['fetch_ticket', 'plan'], status = 'in_progress', extra = {} } = {}) {
    const taskId = `${id}-churn`;
    const wt = path.join(repo, '.claude', 'worktrees', String(id));
    const dir = path.join(wt, 'memory', 'runs', taskId);
    fs.mkdirSync(dir, { recursive: true });
    writeState(dir, { task_id: taskId, node, history, status, started_at: new Date().toISOString(), ...extra });
    fs.writeFileSync(path.join(dir, 'context.md'), '# Contexto\n');
    fs.writeFileSync(path.join(dir, 'handoff.md'), '## Plano de execução\n\n' + [1, 2, 3].map(i =>
        `${i}. Ajustar passo ${i}. Arquivo: \`src/main/java/br/Passo${i}.java\`. Verificação: \`mvn compile\` passa.`).join('\n') + '\n');
    initRepo(wt);
    return { taskId, dir, wt };
}
const readState = dir => JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'));
const writeState = (dir, s) => fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify(s, null, 2));
function ticket(id) {
    return {
        id, subject: `Ticket ${id}`, description: '', status: { name: 'Em Desenvolvimento' }, tracker: { name: 'Melhoria' },
        custom_fields: [{ name: 'Branch Liberação', value: 'Dev - Local' }], updated_on: new Date().toISOString(),
    };
}
// O despacho é destacado (sem --follow): o watcher marca status="running" e o wrapper
// do agente, ao sair, faz DUAS escritas no state: releaseNode (devolve o status) e
// recordNodeExit (acrescenta node_end/node_error, lendo o state de novo). O agente real
// grava o state ANTES de sair; simular a rodada entre essas escritas fazia a segunda
// sobrescrever o state (history incluído) sob carga, e o portão via uma rodada a menos
// (PRI-233: flaky em "CHURN_THRESHOLD=2", log "1 rodada(s) analisada(s)"). Espera o
// wrapper terminar: status fora de running e todo node_start com seu evento de saída.
async function waitReleased(dir, ms = 30000) {
    const until = Date.now() + ms;
    const done = () => {
        let s;
        try { s = readState(dir); } catch { return false; } // escrita em curso
        const ev = s.events || [];
        const starts = ev.filter(e => e.type === 'node_start').length;
        const exits = ev.filter(e => e.type === 'node_end' || e.type === 'node_error').length;
        return s.status !== 'running' && exits >= starts;
    };
    while (!done()) {
        if (Date.now() > until) throw new Error('timeout esperando o wrapper do agente destacado');
        await new Promise(r => setTimeout(r, 25));
    }
}

// Simula uma rodada do agente: implement mexe nos arquivos e o review reprova
// (grava node="implement" de novo, com o motivo no agent_log).
async function agentRound(dir, wt, files, round) {
    await waitReleased(dir);
    for (const [f, c] of Object.entries(files)) {
        fs.mkdirSync(path.dirname(path.join(wt, f)), { recursive: true });
        fs.writeFileSync(path.join(wt, f), c);
    }
    const s = readState(dir);
    writeState(dir, {
        ...s, status: 'in_progress', node: 'implement', history: [...s.history, 'implement', 'review'],
        agent_log: [...(s.agent_log || []), { agent: 'claude', node: 'review', at: new Date().toISOString(), note: `reprovado na rodada ${round}` }],
    });
}

test.beforeEach(() => {
    puts = []; journals = [];
    delete process.env.CHURN_THRESHOLD;
});

test('needsChurnGate: só antes de despachar implement', () => {
    assert.strictEqual(watcher.needsChurnGate({ node: 'implement', history: [] }), true);
    assert.strictEqual(watcher.needsChurnGate({ node: 'review', history: ['implement'] }), false);
    assert.strictEqual(watcher.needsChurnGate(null), false);
});

test('implement inicial só grava a âncora; arquivo mexido em 3 rodadas => churn-escalation, relatório e ciclo parado', async () => {
    const { dir, wt, taskId } = seed(94001);
    let res = await watcher.dispatchTicket(ticket(94001));
    assert.strictEqual(res.action, 'dispatched');
    assert.ok(cd.resolveRef(wt, cd.anchorRef(taskId)), 'âncora do ciclo gravada');
    assert.strictEqual(cd.resolveRef(wt, cd.roundsRef(taskId)), null);

    for (let round = 1; round <= 2; round++) {
        await agentRound(dir, wt, { 'src/main/java/br/Pedido.java': `v${round}`, [`src/main/java/br/Outro${round}.java`]: 'x' }, round);
        res = await watcher.dispatchTicket(ticket(94001));
        assert.strictEqual(res.action, 'dispatched', `rodada ${round}: abaixo do limite, re-implement sai`);
    }
    await agentRound(dir, wt, { 'src/main/java/br/Pedido.java': 'v3' }, 3);
    res = await watcher.dispatchTicket(ticket(94001));

    assert.deepStrictEqual([res.action, res.reason, res.status], ['skip', 'churn_escalation', 'churn-escalation']);
    const s = readState(dir);
    assert.strictEqual(s.status, 'churn-escalation');
    assert.strictEqual(s.node, 'implement');
    assert.match(s.churnReport.detectedAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.deepStrictEqual(s.churnReport.files.map(f => [f.path, f.modificationCount]), [['src/main/java/br/Pedido.java', 3]]);
    assert.deepStrictEqual(s.churnReport.files[0].commits.map(c => c.replace(/^\S+ /, '')),
        ['implement #3: reprovado na rodada 3', 'implement #2: reprovado na rodada 2', 'implement #1: reprovado na rodada 1']);
    assert.ok(s.churnEscalationNotifiedAt);
    assert.strictEqual(s.events.at(-1).type, 'churn_escalation');

    assert.strictEqual(puts.length, 1);
    const note = puts[0].notes;
    assert.ok(note.startsWith(watcher.CHURN_COMMENT_PREFIX));
    assert.match(note, /src\/main\/java\/br\/Pedido\.java@ — modificado em \*3\* rodadas/);
    assert.match(note, /implement #3: reprovado na rodada 3/);
    assert.match(note, /implement #1: reprovado na rodada 1/);
    assert.match(note, /Sugestão:/);
    assert.match(note, /"aceito"/);
    assert.doesNotMatch(note, /Outro1\.java/);

    // Tick seguinte sem aceite: continua parado e não comenta de novo.
    res = await watcher.dispatchTicket(ticket(94001));
    assert.strictEqual(res.reason, 'churn_escalation');
    assert.strictEqual(puts.length, 1);
    assert.strictEqual(res.action, 'skip', 'escalado: sem despacho');

    // "aceito" no Redmine depois do relatório => volta a andar, com baseline.
    journals.push({ id: 99, notes: 'aceito, pode seguir', user: { name: 'Richard' }, created_on: new Date().toISOString() });
    res = await watcher.dispatchTicket(ticket(94001));
    assert.strictEqual(res.action, 'dispatched');
    const after = readState(dir);
    assert.strictEqual(after.churnAccepted.counts['src/main/java/br/Pedido.java'], 3);
    assert.match(after.churnAccepted.by, /Richard/);
    assert.ok(after.churnReport, 'relatório fica como histórico');

    // Mais uma rodada no mesmo arquivo depois do aceite: 4 - 3 < 3 => segue.
    journals = [];
    await agentRound(dir, wt, { 'src/main/java/br/Pedido.java': 'v4' }, 4);
    res = await watcher.dispatchTicket(ticket(94001));
    assert.strictEqual(res.action, 'dispatched');
});

test('arquivo de teste modificado em 3 rodadas NÃO escala (threshold dobrado)', async () => {
    const { dir, wt } = seed(94002);
    await watcher.dispatchTicket(ticket(94002));
    let res;
    for (let round = 1; round <= 3; round++) {
        await agentRound(dir, wt, { 'src/test/java/br/PedidoTest.java': `t${round}` }, round);
        res = await watcher.dispatchTicket(ticket(94002));
    }
    assert.strictEqual(res.action, 'dispatched');
    assert.notStrictEqual(readState(dir).status, 'churn-escalation');
    assert.strictEqual(readState(dir).churnReport, undefined);
    assert.strictEqual(puts.length, 0);
});

test('CHURN_THRESHOLD=2 escala na segunda rodada', async () => {
    process.env.CHURN_THRESHOLD = '2';
    const { dir, wt } = seed(94003);
    await watcher.dispatchTicket(ticket(94003));
    await agentRound(dir, wt, { 'A.java': '1' }, 1);
    assert.strictEqual((await watcher.dispatchTicket(ticket(94003))).action, 'dispatched');
    await agentRound(dir, wt, { 'A.java': '2' }, 2);
    const res = await watcher.dispatchTicket(ticket(94003));
    assert.strictEqual(res.status, 'churn-escalation');
    assert.strictEqual(readState(dir).churnReport.threshold, 2);
});

test('task anterior ao portão (re-implement sem âncora) ganha âncora e não escala de cara', async () => {
    const { dir, wt, taskId } = seed(94004, { history: ['fetch_ticket', 'plan', 'implement', 'review', 'implement', 'review'] });
    const res = await watcher.dispatchTicket(ticket(94004));
    assert.strictEqual(res.action, 'dispatched');
    assert.ok(cd.resolveRef(wt, cd.anchorRef(taskId)));
    assert.strictEqual(readState(dir).status === 'churn-escalation', false);
});

test('worktree sem git: portão não bloqueia', async () => {
    const taskId = '94005-churn';
    const dir = path.join(repo, '.claude', 'worktrees', '94005', 'memory', 'runs', taskId);
    fs.mkdirSync(dir, { recursive: true });
    writeState(dir, { task_id: taskId, node: 'implement', history: ['fetch_ticket', 'plan', 'implement', 'review'], status: 'in_progress', started_at: new Date().toISOString() });
    const res = await watcher.dispatchTicket(ticket(94005));
    assert.strictEqual(res.action, 'dispatched');
});
