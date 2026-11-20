// node --test scripts/lib/qa-retry-watcher.test.js
// Recusa QA no watcher: detecção no polling (ticket_status + qa_rejection no run mais
// recente, inclusive arquivado), ticket com run anterior não abre ciclo novo, e o
// retry-signal.json do dashboard traz o run de volta pro worktree com node=implement.
// REPO_PATH sintético, fetch stubado (Redmine falso); Git local só nas regressões PRI-177.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(process.env.CLAUDE_JOB_DIR ? path.join(process.env.CLAUDE_JOB_DIR, 'tmp') : os.tmpdir(), 'qa-retry-watcher-'));
const repo = path.join(tmp, 'app-back');
fs.mkdirSync(repo, { recursive: true });
fs.mkdirSync(path.join(repo, '.claude'), { recursive: true });
fs.copyFileSync(path.resolve(__dirname, '../../.claude/spec-hash-config.json'), path.join(repo, '.claude/spec-hash-config.json'));
process.env.REPO_PATH = repo;
process.env.REDMINE_URL = 'http://redmine.test';
process.env.REDMINE_API_KEY = 'chave-watcher-teste';
delete process.env.WATCHER_RECUSA_QA_NOVO_CICLO;
// PRI-181 c0b: esta suíte cobre o caminho C1–C3 (flag ligada); o C0 está em qa-retry-watcher-c0-oracle.test.js.
const savedQaDiagnostico = process.env.WATCHER_QA_DIAGNOSTICO;
process.env.WATCHER_QA_DIAGNOSTICO = '1';

const calls = [];
const statusName = { 13: 'Recusa QA', 2: 'Em Desenvolvimento' };
global.fetch = async (url) => {
    calls.push(String(url));
    const m = String(url).match(/\/issues\/(\d+)\.json(\?include=journals)?$/);
    const id = m && Number(m[1]);
    const body = m && m[2]
        ? { issue: { id, journals: [
            { id: 70, created_on: '2026-09-24T09:00:00Z', notes: '', details: [{ name: 'status_id', new_value: '13' }] },
            { id: 71, created_on: '2026-09-24T09:05:00Z', notes: 'Botão salvar não grava UF', details: [] },
        ] } }
        : { issue: ticket(id, 2) };
    return { ok: true, status: 200, json: async () => body };
};

const watcher = require('../readmine-watcher');
const specAuthority = require('./spec-authority');

process.env.REDMINE_MIN_INTERVAL_MS = '0';
process.env.REDMINE_RETRY_BASE_DELAY_MS = '0';

function ticket(id, statusId) {
    return {
        id, subject: `Ticket ${id}`, description: '', status: { id: statusId, name: statusName[statusId] }, tracker: { name: 'Melhoria' },
        custom_fields: [{ name: 'Branch Liberação', value: 'Dev - Local' }], updated_on: new Date().toISOString(),
    };
}
const UPDATED = '2026-09-20T10:00:00.000Z';
function archived(id, extra = {}, root = repo) {
    const taskId = `${id}-entrega`;
    const dir = path.join(root, 'memory', 'runs', '_archive', taskId);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({
        task_id: taskId, node: 'commit', history: ['fetch_ticket', 'plan', 'implement', 'review', 'test', 'verify', 'commit'],
        status: 'committed', started_at: UPDATED, updated_at: UPDATED, redmine_ticket: { id }, ...extra,
    }, null, 2));
    fs.writeFileSync(path.join(dir, 'context.md'), '# Contexto\n');
    return { taskId, dir };
}
const read = dir => JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'));

test('syncQaRejection: grava ticket_status + qa_rejection no run arquivado, sem mexer em updated_at', async () => {
    const { dir } = archived(92001);
    await watcher.syncQaRejection(ticket(92001, 13));
    const st = read(dir);
    assert.strictEqual(st.ticket_status, 'Recusa QA');
    // Campos legados C0 + identidade C1 (DB-01: transition journal 70; nota no journal 71).
    assert.strictEqual(st.qa_rejection.note, 'Botão salvar não grava UF');
    assert.strictEqual(st.qa_rejection.rejected_at, '2026-09-24T09:00:00Z');
    assert.strictEqual(st.qa_rejection.journal_id, 71);
    assert.strictEqual(st.qa_rejection.transition_journal_id, 70);
    assert.strictEqual(st.qa_rejection.rejection_key, 'qa-rej:v1:t92001:j70');
    assert.ok(['OK', 'DEGRADED'].includes(st.qa_rejection.identity_quality));
    assert.strictEqual(st.updated_at, UPDATED);
    assert.strictEqual(st.status, 'committed');

    // PRI-181 C1/DB-01b: mesmo status ainda relê journals; sem transição nova, legado estável.
    const before = calls.length;
    const beforeRejection = JSON.stringify(st.qa_rejection);
    await watcher.syncQaRejection(ticket(92001, 13));
    assert.ok(calls.length > before, 'C1 relê journals com status igual');
    assert.strictEqual(JSON.stringify(read(dir).qa_rejection), beforeRejection);
});

test('dispatchTicket: Recusa QA com run anterior espera o botão, não abre fetch_ticket', async () => {
    archived(92002);
    const out = await watcher.dispatchTicket(ticket(92002, 13));
    assert.deepStrictEqual(out, { action: 'skip', reason: 'recusa_qa_aguardando_retry', taskId: '92002-entrega' });
    assert.ok(!fs.existsSync(path.join(repo, '.claude', 'worktrees', '92002')), 'nenhum worktree criado');
});

test('consumeQaRetrySignals: traz o run do _archive pro worktree, implement a despachar, sinal removido', async () => {
    const { taskId, dir } = archived(92003, { node: 'implement', status: 'in_progress', qa_retry_count: 1 });
    fs.writeFileSync(path.join(dir, 'retry-signal.json'), JSON.stringify({ node: 'implement' }));
    fs.mkdirSync(path.join(repo, '.claude', 'worktrees', '92003'), { recursive: true }); // worktree já existe

    const ids = await watcher.consumeQaRetrySignals();
    assert.deepStrictEqual(ids, [92003]);
    const target = path.join(repo, '.claude', 'worktrees', '92003', 'memory', 'runs', taskId);
    assert.ok(!fs.existsSync(dir), 'saiu do _archive');
    assert.ok(!fs.existsSync(path.join(target, 'retry-signal.json')), 'sinal consumido');
    const st = read(target);
    assert.strictEqual(st.node, 'implement');
    assert.strictEqual(st.status, 'in_progress');
    assert.strictEqual(st.task_id, taskId, 'mesmo task-id, sem run novo');
    assert.strictEqual(watcher.findActiveTask(92003).taskId, taskId);
    assert.match(watcher.qaRetryNote(taskId, 'implement'), /RETRY de Recusa QA/);
    assert.strictEqual(watcher.qaRetryNote(taskId, 'implement'), '', 'nota só no primeiro despacho');

    // Sem sinal: nada a fazer.
    assert.deepStrictEqual(await watcher.consumeQaRetrySignals(), []);
});

test('consumeQaRetrySignals: destino ocupado mantém o sinal e não sobrescreve', async () => {
    const { taskId, dir } = archived(92004, { node: 'implement', status: 'in_progress' });
    fs.writeFileSync(path.join(dir, 'retry-signal.json'), '{"node":"implement"}');
    const target = path.join(repo, '.claude', 'worktrees', '92004', 'memory', 'runs', taskId);
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(target, 'marker'), 'x');
    assert.deepStrictEqual(await watcher.consumeQaRetrySignals(), []);
    assert.ok(fs.existsSync(path.join(dir, 'retry-signal.json')));
    assert.ok(fs.existsSync(path.join(target, 'marker')));
    const st = read(dir);
    assert.strictEqual(st.qa_retry_blocked.reason, 'destino_ocupado');
    assert.ok(st.qa_retry_blocked.at);
    assert.strictEqual(st.events.filter(e => e.type === 'qa_retry_blocked' && e.detail === 'destino_ocupado').length, 1);
});

test('consumeQaRetrySignals: zera o churn do ciclo anterior (refs e campos do state)', async () => {
    const churn = require('./churn-detector');
    const { execFileSync: run } = require('child_process');
    const wt = path.join(repo, '.claude', 'worktrees', '92005');
    fs.mkdirSync(wt, { recursive: true });
    const g = (...a) => run('git', ['-C', wt, '-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { stdio: 'pipe' });
    g('init', '-q', '-b', 'main');
    fs.writeFileSync(path.join(wt, 'A.java'), 'v0\n');
    g('add', '.'); g('commit', '-q', '-m', 'base');
    const { taskId, dir } = archived(92005, {
        node: 'implement', status: 'churn-escalation', qa_retry_count: 1,
        churnReport: { detectedAt: UPDATED, threshold: 3, files: [{
            path: 'A.java', modificationCount: 3,
            commits: ['abc1234 rodada 3', 'def5678 rodada 2', 'fed9012 rodada 1'],
        }] },
        churnAccepted: { at: UPDATED, by: 'x', counts: { 'A.java': 3 } }, churnEscalationNotifiedAt: UPDATED,
    });
    churn.ensureAnchor(wt, taskId);
    fs.writeFileSync(path.join(wt, 'A.java'), 'v1\n');
    assert.ok(churn.recordRound(wt, taskId, 'rodada 1'));
    fs.writeFileSync(path.join(dir, 'retry-signal.json'), '{"node":"implement"}');

    assert.deepStrictEqual(await watcher.consumeQaRetrySignals(), [92005]);
    assert.strictEqual(churn.resolveRef(wt, churn.anchorRef(taskId)), null, 'âncora do ciclo anterior apagada');
    assert.strictEqual(churn.resolveRef(wt, churn.roundsRef(taskId)), null, 'rodadas do ciclo anterior apagadas');
    const st = read(path.join(wt, 'memory', 'runs', taskId));
    assert.strictEqual(st.status, 'in_progress');
    assert.strictEqual(st.node, 'implement');
    for (const k of ['churnReport', 'churnAccepted', 'churnEscalationNotifiedAt']) assert.ok(!(k in st), `${k} limpo`);
});

function specBody(text) {
    return `# Spec\n\n## Objetivo\n\n${text}\n`;
}

function writeSpecBundle(dir, id, content, { hash = specAuthority.specHash(content), changelogHash = hash, provenance = '{"events":[]}\n', attachment = 'anexo\n' } = {}) {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${id}-spec.md`), content);
    fs.writeFileSync(path.join(dir, `${id}-spec-changelog.json`), JSON.stringify({
        schema_version: 1, spec_id: String(id), hash_scope: 'legacy_normative',
        versions: [{ version: 1, hash: changelogHash, hash_scope: 'legacy_normative' }],
        rebaselines: [],
    }));
    fs.writeFileSync(path.join(dir, `${id}-ac-provenance.json`), provenance);
    fs.mkdirSync(path.join(dir, `${id}-attachments`), { recursive: true });
    fs.writeFileSync(path.join(dir, `${id}-attachments`, 'nota.txt'), attachment);
    return hash;
}

function worktreeOf(id) {
    return path.join(repo, '.claude', 'worktrees', String(id));
}

test('consumeQaRetrySignals: pós-merge copia a spec do checkout principal sem sobrescrever o que já existe', async () => {
    const id = 92010;
    const content = specBody('tabela de frete destino');
    const hash = specAuthority.specHash(content);
    const { taskId, dir } = archived(id, {
        node: 'implement', status: 'in_progress', qa_retry_count: 1,
        spec_path: `memory/spec/${id}-spec.md`, spec_hash: hash, spec_hash_scope: 'legacy_normative',
    });
    fs.writeFileSync(path.join(dir, 'retry-signal.json'), JSON.stringify({ node: 'implement' }));
    const wtSpec = path.join(worktreeOf(id), 'memory', 'spec');
    fs.mkdirSync(wtSpec, { recursive: true });
    fs.writeFileSync(path.join(wtSpec, '111-spec.md'), '# spec antiga commitada\n');
    fs.writeFileSync(path.join(wtSpec, `${id}-spec-changelog.json`), '{"local":true}\n');
    writeSpecBundle(path.join(repo, 'memory', 'spec'), id, content, { hash });

    const ids = await watcher.consumeQaRetrySignals();
    assert.deepStrictEqual(ids, [id]);
    assert.strictEqual(fs.readFileSync(path.join(wtSpec, `${id}-spec.md`), 'utf8'), content);
    assert.strictEqual(fs.readFileSync(path.join(wtSpec, '111-spec.md'), 'utf8'), '# spec antiga commitada\n');
    assert.strictEqual(fs.readFileSync(path.join(wtSpec, `${id}-spec-changelog.json`), 'utf8'), '{"local":true}\n', 'changelog existente não é sobrescrito');
    assert.strictEqual(fs.readFileSync(path.join(wtSpec, `${id}-ac-provenance.json`), 'utf8'), '{"events":[]}\n');
    assert.strictEqual(fs.readFileSync(path.join(wtSpec, `${id}-attachments`, 'nota.txt'), 'utf8'), 'anexo\n');
    const target = path.join(worktreeOf(id), 'memory', 'runs', taskId);
    assert.ok(!fs.existsSync(path.join(target, 'retry-signal.json')));
    const st = read(target);
    assert.strictEqual(st.spec_hash, hash, 'hash do Plan permanece quando a spec copiada é a mesma');
    assert.ok(st.events.some(e => e.type === 'spec_imported'));
    assert.strictEqual(st.node, 'implement');
    assert.strictEqual(st.status, 'in_progress');
});

test('consumeQaRetrySignals: spec com spec_hash ausente em todo lugar mantém o sinal e não despacha', async () => {
    const id = 92011;
    const { dir } = archived(id, {
        node: 'implement', status: 'in_progress',
        spec_path: `memory/spec/${id}-spec.md`, spec_hash: 'a'.repeat(64), spec_hash_scope: 'legacy_normative',
    });
    fs.writeFileSync(path.join(dir, 'retry-signal.json'), JSON.stringify({ node: 'implement' }));
    fs.mkdirSync(worktreeOf(id), { recursive: true });

    assert.deepStrictEqual(await watcher.consumeQaRetrySignals(), []);
    assert.ok(fs.existsSync(path.join(dir, 'retry-signal.json')), 'sinal mantido');
    assert.ok(!fs.existsSync(path.join(worktreeOf(id), 'memory', 'runs')), 'run não foi para o worktree');
    assert.strictEqual(read(dir).status, 'in_progress');
    assert.strictEqual(read(dir).qa_retry_blocked.reason, 'spec_ausente');
});

test('consumeQaRetrySignals: spec_path fora de memory/spec mantém o sinal e não escreve fora', async () => {
    const id = 92012;
    const { dir } = archived(id, {
        node: 'implement', status: 'in_progress',
        spec_path: 'memory/spec/../../secret-spec.md', spec_hash: 'b'.repeat(64),
    });
    fs.writeFileSync(path.join(dir, 'retry-signal.json'), JSON.stringify({ node: 'implement' }));
    fs.mkdirSync(worktreeOf(id), { recursive: true });
    const escaped = path.join(repo, 'secret-spec.md');

    assert.deepStrictEqual(await watcher.consumeQaRetrySignals(), []);
    assert.ok(fs.existsSync(path.join(dir, 'retry-signal.json')));
    assert.ok(!fs.existsSync(escaped));
    assert.ok(!fs.existsSync(path.join(worktreeOf(id), 'memory', 'runs')));
});

test('consumeQaRetrySignals: symlink de spec que sai de memory/spec não conta como spec e não é copiado', async () => {
    const id = 92013;
    const content = specBody('fora de memory/spec');
    const hash = specAuthority.specHash(content);
    const outside = path.join(repo, 'fora', `${id}-spec.md`);
    fs.mkdirSync(path.dirname(outside), { recursive: true });
    fs.writeFileSync(outside, content);
    fs.mkdirSync(path.join(repo, 'memory', 'spec'), { recursive: true });
    fs.symlinkSync(outside, path.join(repo, 'memory', 'spec', `${id}-spec.md`));
    const { dir } = archived(id, {
        node: 'implement', status: 'in_progress',
        spec_path: `memory/spec/${id}-spec.md`, spec_hash: hash,
    });
    fs.writeFileSync(path.join(dir, 'retry-signal.json'), JSON.stringify({ node: 'implement' }));
    fs.mkdirSync(path.join(worktreeOf(id), 'memory', 'spec'), { recursive: true });

    assert.deepStrictEqual(await watcher.consumeQaRetrySignals(), []);
    assert.ok(fs.existsSync(path.join(dir, 'retry-signal.json')));
    assert.ok(!fs.existsSync(path.join(worktreeOf(id), 'memory', 'runs')));
    assert.ok(!fs.existsSync(path.join(worktreeOf(id), 'memory', 'spec', `${id}-spec.md`)));
    assert.strictEqual(fs.readFileSync(outside, 'utf8'), content);
});

function driftRun(id, extra = {}) {
    const taskId = `${id}-entrega`;
    const dir = path.join(worktreeOf(id), 'memory', 'runs', taskId);
    fs.mkdirSync(dir, { recursive: true });
    fs.mkdirSync(path.join(worktreeOf(id), 'memory', 'spec'), { recursive: true });
    const state = {
        task_id: taskId, node: 'implement', history: ['plan'], status: 'in_progress',
        started_at: UPDATED, updated_at: UPDATED, redmine_ticket: { id },
        spec_path: `memory/spec/${id}-spec.md`, spec_hash_scope: 'legacy_normative', ...extra,
    };
    fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify(state));
    return { taskId, dir, state };
}

test('runSpecDriftGate: spec ausente no worktree e com o mesmo hash no principal é restaurada', async () => {
    const id = 92020;
    const content = specBody('spec do Plan');
    const hash = specAuthority.specHash(content);
    writeSpecBundle(path.join(repo, 'memory', 'spec'), id, content, { hash, attachment: 'nao-copiar-no-portao\n' });
    const { taskId, dir, state } = driftRun(id, { spec_hash: hash });

    const gate = await watcher.runSpecDriftGate(ticket(id, 2), { taskId, state, dir }, 'implement');
    assert.strictEqual(gate.proceed, true, JSON.stringify(gate));
    const wtSpec = path.join(worktreeOf(id), 'memory', 'spec');
    assert.strictEqual(fs.readFileSync(path.join(wtSpec, `${id}-spec.md`), 'utf8'), content);
    const changelog = JSON.parse(fs.readFileSync(path.join(wtSpec, `${id}-spec-changelog.json`), 'utf8'));
    assert.strictEqual(changelog.versions[0].hash, hash);
    assert.ok(!fs.existsSync(path.join(wtSpec, `${id}-attachments`, 'nota.txt')), 'o portão restaura a spec, não o pacote inteiro do retry');
    const st = read(dir);
    assert.ok(st.events.some(e => e.type === 'spec_restored'));
    assert.notStrictEqual(st.status, 'spec-drift');
});

test('runSpecDriftGate: hash diferente no principal continua spec-drift e não copia a spec', async () => {
    const id = 92021;
    const content = specBody('spec diferente');
    writeSpecBundle(path.join(repo, 'memory', 'spec'), id, content);
    const { taskId, dir, state } = driftRun(id, { spec_hash: 'c'.repeat(64) });

    const gate = await watcher.runSpecDriftGate(ticket(id, 2), { taskId, state, dir }, 'implement');
    assert.strictEqual(gate.proceed, false);
    assert.ok(!fs.existsSync(path.join(worktreeOf(id), 'memory', 'spec', `${id}-spec.md`)));
    assert.ok(!fs.existsSync(path.join(worktreeOf(id), 'memory', 'spec', `${id}-spec-changelog.json`)));
    const st = read(dir);
    assert.strictEqual(st.status, 'spec-drift');
    assert.ok(!st.events.some(e => e.type === 'spec_restored'));
});

test('runSpecDriftGate: spec inexistente em todo lugar continua spec-drift', async () => {
    const id = 92022;
    const { taskId, dir, state } = driftRun(id, { spec_hash: 'd'.repeat(64) });

    const gate = await watcher.runSpecDriftGate(ticket(id, 2), { taskId, state, dir }, 'implement');
    assert.strictEqual(gate.proceed, false);
    const st = read(dir);
    assert.strictEqual(st.status, 'spec-drift');
    assert.match(st.spec_drift.reason, /não existe mais/);
    assert.ok(!st.events.some(e => e.type === 'spec_restored'));
});

test('runSpecDriftGate: changelog com hash diferente da spec não é restaurado', async () => {
    const id = 92023;
    const content = specBody('spec igual changelog diferente');
    const hash = specAuthority.specHash(content);
    writeSpecBundle(path.join(repo, 'memory', 'spec'), id, content, { hash, changelogHash: 'e'.repeat(64) });
    const { taskId, dir, state } = driftRun(id, { spec_hash: hash });

    const gate = await watcher.runSpecDriftGate(ticket(id, 2), { taskId, state, dir }, 'implement');
    assert.strictEqual(gate.proceed, true, JSON.stringify(gate));
    assert.strictEqual(fs.readFileSync(path.join(worktreeOf(id), 'memory', 'spec', `${id}-spec.md`), 'utf8'), content);
    assert.ok(!fs.existsSync(path.join(worktreeOf(id), 'memory', 'spec', `${id}-spec-changelog.json`)));
});


// PRI-177: checkout de branch com memory/spec versionado, sem a spec do ticket.
// Git real, sem remote; nenhum checkout consumidor é usado como fixture.
const { execFileSync } = require('child_process');
function git(root, ...args) {
    return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: 'pipe' });
}
function retrySignal(id, extra = {}, root = repo) {
    const run = archived(id, { spec_hash: specAuthority.specHash(specBody('baseline')), ...extra }, root);
    fs.writeFileSync(path.join(run.dir, 'retry-signal.json'), '{"node":"implement"}');
    return run;
}

test('PRI-177: qa-retry com memory e run versionados preserva links e rebaseline no principal', () => {
    const id = 92030;
    // Repo e processo próprios: git init/worktree não contaminam os demais testes.
    const repo = path.join(tmp, 'git-fixture-92030', 'app-back');
    fs.mkdirSync(repo, { recursive: true });
    const tracked = {
        'memory/spec/versionada-spec.md': 'spec versionada original\n',
        'memory/decisions/nested/versionada.md': 'decisão versionada\n',
        'memory/flows/versionado.md': 'fluxo versionado\n',
    };
    git(repo, 'init', '-b', 'main');
    fs.writeFileSync(path.join(repo, '.gitignore'), 'memory/\n.claude/worktrees/\n');
    git(repo, 'add', '.gitignore');
    for (const [rel, content] of Object.entries(tracked)) {
        fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
        fs.writeFileSync(path.join(repo, rel), content);
        git(repo, 'add', '-f', rel);
    }
    for (const [rel, target] of Object.entries({
        'memory/decisions/link-existente': '../flows',
        'memory/flows/link-quebrado.md': 'ausente.md',
    })) {
        fs.symlinkSync(target, path.join(repo, rel));
        git(repo, 'add', '-f', rel);
    }
    git(repo, '-c', 'user.name=QA sintético', '-c', 'user.email=qa@example.test', 'commit', '-m', 'fixture versionada');
    git(repo, 'branch', String(id));
    fs.writeFileSync(path.join(repo, 'memory/spec/versionada-spec.md'), 'versão diferente no principal\n');
    const content = specBody('baseline');
    fs.writeFileSync(path.join(repo, `memory/spec/${id}-spec.md`), content);
    fs.writeFileSync(path.join(repo, 'memory/decisions/nested/local.md'), 'decisão local\n');
    fs.writeFileSync(path.join(repo, 'memory/flows/local.md'), 'fluxo local\n');
    const { taskId, dir } = retrySignal(id, {}, repo);
    fs.mkdirSync(path.join(repo, '.claude'), { recursive: true });
    fs.copyFileSync(path.resolve(__dirname, '../../.claude/spec-hash-config.json'), path.join(repo, '.claude/spec-hash-config.json'));
    const state = read(dir);
    require('./spec-version').init(state, { root: repo, specRel: `memory/spec/${id}-spec.md`, content, taskId });
    specAuthority.applyBaseline(state, { root: repo, specPath: `memory/spec/${id}-spec.md`, taskId });
    fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify(state));
    const changed = specBody('baseline com correção pós-commit');
    fs.writeFileSync(path.join(repo, `memory/spec/${id}-spec.md`), changed);
    const hash = specAuthority.specHashFor(state, changed);
    const mainStatus = git(repo, 'status', '--porcelain');

    const wt = path.join(repo, '.claude/worktrees', String(id));
    const run = path.join(wt, 'memory/runs', taskId);
    const script = `
        const assert = require('node:assert');
        const fs = require('node:fs');
        global.fetch = async () => ({ ok: true, json: async () => ({ issue: ${JSON.stringify(ticket(id, 2))} }) });
        const watcher = require(${JSON.stringify(require.resolve('../readmine-watcher'))});
        (async () => {
            assert.deepStrictEqual(await watcher.consumeQaRetrySignals(), [${id}]);
            const state = JSON.parse(fs.readFileSync(${JSON.stringify(path.join(run, 'state.json'))}));
            const gate = await watcher.runSpecDriftGate(${JSON.stringify(ticket(id, 2))},
                { taskId: ${JSON.stringify(taskId)}, state, dir: ${JSON.stringify(run)} }, 'implement');
            assert.strictEqual(gate.proceed, true, JSON.stringify(gate));
        })().catch(e => { console.error(e); process.exitCode = 1; });
    `;
    const retry = require('child_process').spawnSync(process.execPath, ['-e', script], {
        cwd: repo, encoding: 'utf8', timeout: 60000,
        env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR,
            NODE_OPTIONS: process.env.NODE_OPTIONS, REPO_PATH: repo,
            REDMINE_URL: 'http://redmine.test', REDMINE_API_KEY: 'chave-watcher-teste' },
    });
    assert.strictEqual(retry.status, 0, retry.stdout + retry.stderr);
    for (const [rel, content] of Object.entries(tracked)) {
        assert.strictEqual(fs.readFileSync(path.join(wt, rel), 'utf8'), content);
        assert.ok(!fs.lstatSync(path.join(wt, rel)).isSymbolicLink());
    }
    assert.strictEqual(fs.readlinkSync(path.join(wt, 'memory/decisions/link-existente')), '../flows');
    assert.strictEqual(fs.readlinkSync(path.join(wt, 'memory/flows/link-quebrado.md')), 'ausente.md');
    assert.ok(fs.lstatSync(path.join(wt, `memory/spec/${id}-spec.md`)).isSymbolicLink());
    for (const rel of ['memory/decisions/nested/local.md', 'memory/flows/local.md']) {
        assert.strictEqual(fs.realpathSync(path.join(wt, rel)), fs.realpathSync(path.join(repo, rel)));
    }
    assert.ok(!fs.lstatSync(path.join(wt, 'memory/runs')).isSymbolicLink());
    assert.ok(!fs.existsSync(path.join(repo, 'memory/runs', taskId)));
    assert.strictEqual(read(run).spec_hash, hash);
    const after = read(run);
    assert.strictEqual(after.spec.hash, hash);
    assert.strictEqual(after.spec.version, state.spec.version);
    assert.strictEqual(after.spec_hash_version, state.spec.version);
    const changelogRel = `memory/spec/${id}-spec-changelog.json`;
    const log = JSON.parse(fs.readFileSync(path.join(repo, changelogRel)));
    assert.strictEqual(log.versions.length, 1);
    assert.strictEqual(log.rebaselines.length, 1);
    assert.strictEqual(log.rebaselines[0].hash, hash);
    assert.strictEqual(log.rebaselines[0].by, 'qa_retry');
    assert.strictEqual(log.rebaselines[0].version, state.spec.version);
    assert.ok(fs.lstatSync(path.join(wt, changelogRel)).isSymbolicLink());
    assert.strictEqual(fs.realpathSync(path.join(wt, changelogRel)), fs.realpathSync(path.join(repo, changelogRel)));
    assert.strictEqual(git(repo, 'status', '--porcelain'), mainStatus);
    assert.strictEqual(execFileSync('git', ['-C', wt, 'diff', '--exit-code'], { encoding: 'utf8' }), '');
});

test('PRI-177: rebaseline sem spec após importação mantém estado, sinal e bloqueio de despacho', async () => {
    const id = 92031;
    writeSpecBundle(path.join(repo, 'memory/spec'), id, specBody('baseline'));
    const { taskId } = retrySignal(id, { node: 'implement', status: 'in_progress' });
    fs.mkdirSync(worktreeOf(id), { recursive: true });
    const original = specAuthority.baselineFields;
    const warnings = [];
    const warn = console.warn;
    try {
        // Corrida: a spec deixa de estar legível entre importação e rebaseline.
        specAuthority.baselineFields = () => null;
        console.warn = (...args) => warnings.push(args.join(' '));
        assert.deepStrictEqual(await watcher.consumeQaRetrySignals(), []);
    } finally {
        specAuthority.baselineFields = original;
        console.warn = warn;
    }
    const target = path.join(worktreeOf(id), 'memory/runs', taskId);
    assert.ok(fs.existsSync(path.join(target, 'retry-signal.json')));
    assert.strictEqual(read(target).status, 'in_progress', 'status recebido do dashboard preservado');
    assert.deepStrictEqual(await watcher.dispatchTicket(ticket(id, 2)), { action: 'skip', reason: 'qa_retry_pendente', taskId }, 'despacho normal também respeita sinal pendente');
    assert.strictEqual(read(target).spec_hash, specAuthority.specHash(specBody('baseline')));
    assert.match(warnings.join('\n'), /spec.*ausente.*sinal mantido/);
    assert.deepStrictEqual(await watcher.consumeQaRetrySignals(), [id], 'tick seguinte pode tentar novamente');
});

test('PRI-177: erro de rebaseline mantém sinal e hash anterior sem despachar', async () => {
    const id = 92032;
    writeSpecBundle(path.join(repo, 'memory/spec'), id, specBody('baseline'));
    const { taskId } = retrySignal(id);
    fs.mkdirSync(worktreeOf(id), { recursive: true });
    const original = specAuthority.baselineFields;
    try {
        specAuthority.baselineFields = () => { throw new Error('leitura indisponível'); };
        assert.deepStrictEqual(await watcher.consumeQaRetrySignals(), []);
    } finally { specAuthority.baselineFields = original; }
    const target = path.join(worktreeOf(id), 'memory/runs', taskId);
    assert.ok(fs.existsSync(path.join(target, 'retry-signal.json')));
    assert.strictEqual(read(target).status, 'committed');
    assert.strictEqual(read(target).spec_hash, specAuthority.specHash(specBody('baseline')));
    assert.deepStrictEqual(await watcher.consumeQaRetrySignals(), [id]);
});

function versionedRetry(id) {
    const rootSpec = path.join(repo, 'memory/spec');
    fs.mkdirSync(path.join(repo, '.claude'), { recursive: true });
    fs.copyFileSync(path.resolve(__dirname, '../../.claude/spec-hash-config.json'), path.join(repo, '.claude/spec-hash-config.json'));
    const content = specBody('baseline');
    fs.writeFileSync(path.join(rootSpec, `${id}-spec.md`), content);
    const { taskId, dir } = retrySignal(id);
    const state = read(dir);
    const specVersion = require('./spec-version');
    specVersion.init(state, { root: repo, specRel: `memory/spec/${id}-spec.md`, content, taskId });
    specAuthority.applyBaseline(state, { root: repo, specPath: `memory/spec/${id}-spec.md`, taskId });
    fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify(state));
    fs.mkdirSync(path.join(worktreeOf(id), 'memory/spec'), { recursive: true });
    return { taskId, dir, state };
}

test('PRI-177: retry versionado mantém versão e registra rebaseline com hash e changelog', async () => {
    const id = 92033;
    const { taskId, state } = versionedRetry(id);
    const content = specBody('baseline com correção pós-commit');
    fs.writeFileSync(path.join(repo, `memory/spec/${id}-spec.md`), content);
    const expected = specAuthority.specHashFor(state, content);
    assert.deepStrictEqual(await watcher.consumeQaRetrySignals(), [id]);
    const run = path.join(worktreeOf(id), 'memory/runs', taskId);
    const after = read(run);
    assert.strictEqual(after.spec_hash, expected);
    assert.strictEqual(after.spec.hash, expected);
    assert.strictEqual(after.spec.version, state.spec.version);
    assert.strictEqual(after.spec_hash_version, state.spec.version);
    assert.ok(after.events.some(e => e.type === 'spec_baseline' && e.detail.includes(expected.slice(0, 12))));
    const log = JSON.parse(fs.readFileSync(path.join(worktreeOf(id), `memory/spec/${id}-spec-changelog.json`)));
    assert.strictEqual(log.versions.length, 1);
    assert.strictEqual(log.rebaselines.at(-1).hash, expected);
    assert.strictEqual(log.rebaselines.at(-1).by, 'qa_retry');
    assert.strictEqual(log.rebaselines.at(-1).version, state.spec.version);
    const gate = await watcher.runSpecDriftGate(ticket(id, 2), { taskId, state: after, dir: run }, 'implement');
    assert.strictEqual(gate.proceed, true);
});

test('PRI-177: changelog inválido impede rebaseline e mantém sinal, versão e hash anteriores', async () => {
    const id = 92034;
    const { taskId, state } = versionedRetry(id);
    fs.writeFileSync(path.join(repo, `memory/spec/${id}-spec.md`), specBody('contrato novo'));
    fs.writeFileSync(path.join(repo, `memory/spec/${id}-spec-changelog.json`), '{invalid');
    assert.deepStrictEqual(await watcher.consumeQaRetrySignals(), []);
    const run = path.join(worktreeOf(id), 'memory/runs', taskId);
    const after = read(run);
    assert.ok(fs.existsSync(path.join(run, 'retry-signal.json')));
    assert.strictEqual(after.status, 'committed');
    assert.strictEqual(after.spec_hash, state.spec_hash);
    assert.deepStrictEqual(after.spec, state.spec);
    assert.strictEqual(fs.readFileSync(path.join(worktreeOf(id), `memory/spec/${id}-spec-changelog.json`), 'utf8'), '{invalid');
    assert.strictEqual(after.qa_retry_blocked.reason, 'changelog_invalido');
});

test('PRI-177: spec existente divergente não é sobrescrita e continua bloqueada pelo gate', async () => {
    const id = 92035;
    const content = specBody('contrato do Plan');
    const hash = writeSpecBundle(path.join(repo, 'memory/spec'), id, content);
    const { taskId, dir, state } = driftRun(id, { spec_hash: hash });
    const changed = specBody('contrato local divergente');
    fs.writeFileSync(path.join(worktreeOf(id), `memory/spec/${id}-spec.md`), changed);
    const gate = await watcher.runSpecDriftGate(ticket(id, 2), { taskId, state, dir }, 'implement');
    assert.strictEqual(gate.proceed, false);
    assert.strictEqual(read(dir).status, 'spec-drift');
    assert.strictEqual(read(dir).spec_hash, hash);
    assert.strictEqual(fs.readFileSync(path.join(worktreeOf(id), `memory/spec/${id}-spec.md`), 'utf8'), changed);
});


test('PRI-177: --dry-run do retry mantém sinal e state, sem criar worktree nem ligar memória', () => {
    const id = 92036;
    writeSpecBundle(path.join(repo, 'memory/spec'), id, specBody('baseline'));
    const { dir } = retrySignal(id);
    const before = fs.readFileSync(path.join(dir, 'state.json'), 'utf8');
    const signal = fs.readFileSync(path.join(dir, 'retry-signal.json'), 'utf8');
    const script = `require(${JSON.stringify(require.resolve('../readmine-watcher'))}).consumeQaRetrySignals().then(ids => console.log('IDS=' + JSON.stringify(ids)));`;
    const run = require('child_process').spawnSync(process.execPath, ['-e', script, '--', '--dry-run'], {
        cwd: repo, encoding: 'utf8', timeout: 60000,
        env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR,
            NODE_OPTIONS: process.env.NODE_OPTIONS, REPO_PATH: repo,
            REDMINE_URL: 'http://127.0.0.1:9', REDMINE_API_KEY: 'chave-teste' },
    });
    assert.strictEqual(run.status, 0, run.stderr);
    assert.match(run.stdout, /IDS=\[\]/);
    assert.ok(!fs.existsSync(worktreeOf(id)));
    assert.strictEqual(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'), before);
    assert.strictEqual(fs.readFileSync(path.join(dir, 'retry-signal.json'), 'utf8'), signal);
});


test('PRI-177: sinal ainda no arquivo impede o despacho normal de abrir outro ciclo', async () => {
    const id = 92037;
    const { taskId, dir } = retrySignal(id, { node: 'implement', status: 'in_progress' });
    const before = fs.readFileSync(path.join(dir, 'state.json'), 'utf8');
    assert.deepStrictEqual(await watcher.dispatchTicket(ticket(id, 2)), { action: 'skip', reason: 'qa_retry_pendente', taskId });
    assert.strictEqual(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'), before);
    assert.ok(!fs.existsSync(worktreeOf(id)));
});

function assertBlockedOnce(dir, reason) {
    const st = read(dir);
    assert.ok(fs.existsSync(path.join(dir, 'retry-signal.json')), 'sinal mantido');
    assert.strictEqual(st.qa_retry_blocked?.reason, reason);
    assert.ok(st.qa_retry_blocked?.at);
    assert.strictEqual(
        (st.events || []).filter(e => e.type === 'qa_retry_blocked' && e.detail === reason).length, 1,
        `um único evento qa_retry_blocked para ${reason}`,
    );
}

test('PRI-184: destino_ocupado grava qa_retry_blocked uma vez e não despacha no tick seguinte', async () => {
    const { taskId, dir } = archived(92140, { node: 'implement', status: 'in_progress' });
    fs.writeFileSync(path.join(dir, 'retry-signal.json'), '{"node":"implement"}');
    const target = path.join(repo, '.claude', 'worktrees', '92140', 'memory', 'runs', taskId);
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(target, 'marker'), 'x');
    assert.deepStrictEqual(await watcher.consumeQaRetrySignals(), []);
    assertBlockedOnce(dir, 'destino_ocupado');
    const at = read(dir).qa_retry_blocked.at;
    assert.deepStrictEqual(await watcher.consumeQaRetrySignals(), []);
    assertBlockedOnce(dir, 'destino_ocupado');
    assert.strictEqual(read(dir).qa_retry_blocked.at, at, 'campo não reescrito no mesmo motivo');
    assert.deepStrictEqual(await watcher.dispatchTicket(ticket(92140, 2)), {
        action: 'skip', reason: 'qa_retry_pendente', taskId,
    });
});

test('PRI-184: spec_ausente grava qa_retry_blocked uma vez e não despacha', async () => {
    const id = 92141;
    const { dir } = archived(id, {
        node: 'implement', status: 'in_progress',
        spec_path: `memory/spec/${id}-spec.md`, spec_hash: 'c'.repeat(64), spec_hash_scope: 'legacy_normative',
    });
    fs.writeFileSync(path.join(dir, 'retry-signal.json'), JSON.stringify({ node: 'implement' }));
    fs.mkdirSync(worktreeOf(id), { recursive: true });
    assert.deepStrictEqual(await watcher.consumeQaRetrySignals(), []);
    assertBlockedOnce(dir, 'spec_ausente');
    assert.deepStrictEqual(await watcher.consumeQaRetrySignals(), []);
    assertBlockedOnce(dir, 'spec_ausente');
});

test('PRI-184: changelog_invalido (Branch Liberação) grava uma vez e não despacha', async () => {
    const id = 92142;
    const { taskId, dir } = archived(id, { node: 'implement', status: 'in_progress' });
    fs.writeFileSync(path.join(dir, 'retry-signal.json'), '{"node":"implement"}');
    const orig = global.fetch;
    global.fetch = async (url) => {
        const m = String(url).match(/\/issues\/(\d+)\.json/);
        const tid = m && Number(m[1]);
        return {
            ok: true, status: 200,
            json: async () => ({
                issue: {
                    id: tid, subject: `Ticket ${tid}`, description: '',
                    status: { id: 2, name: 'Em Desenvolvimento' }, tracker: { name: 'Melhoria' },
                    custom_fields: [{ name: 'Branch Liberação', value: 'Liberação Inventada' }],
                    updated_on: new Date().toISOString(),
                },
            }),
        };
    };
    try {
        assert.deepStrictEqual(await watcher.consumeQaRetrySignals(), []);
        assertBlockedOnce(dir, 'changelog_invalido');
        assert.deepStrictEqual(await watcher.consumeQaRetrySignals(), []);
        assertBlockedOnce(dir, 'changelog_invalido');
    } finally {
        global.fetch = orig;
    }
    assert.ok(!fs.existsSync(path.join(repo, '.claude', 'worktrees', String(id), 'memory', 'runs', taskId)));
});

test('PRI-184: state_fora_schema grava qa_retry_blocked uma vez e não despacha', async () => {
    const id = 92143;
    const taskId = `${id}-entrega`;
    const dir = path.join(repo, 'memory', 'runs', '_archive', taskId);
    fs.mkdirSync(dir, { recursive: true });
    // Sem `status` (obrigatório): falha mesmo no fallback manual sem ajv e no schema completo.
    // raw permanece disponível para gravar qa_retry_blocked.
    fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({
        task_id: taskId, node: 'implement', history: ['fetch_ticket'],
        started_at: UPDATED, updated_at: UPDATED, redmine_ticket: { id },
    }));
    fs.writeFileSync(path.join(dir, 'context.md'), '# Contexto\n');
    fs.writeFileSync(path.join(dir, 'retry-signal.json'), '{"node":"implement"}');
    assert.deepStrictEqual(await watcher.consumeQaRetrySignals(), []);
    assertBlockedOnce(dir, 'state_fora_schema');
    assert.deepStrictEqual(await watcher.consumeQaRetrySignals(), []);
    assertBlockedOnce(dir, 'state_fora_schema');
    assert.deepStrictEqual(await watcher.dispatchTicket(ticket(id, 2)), {
        action: 'skip', reason: 'qa_retry_pendente', taskId,
    });
});

test('PRI-184: consumo bem-sucedido limpa o campo qa_retry_blocked e preserva o evento', async () => {
    const id = 92144;
    const { taskId, dir } = archived(id, {
        node: 'implement', status: 'in_progress', qa_retry_count: 1,
        qa_retry_blocked: { reason: 'destino_ocupado', at: UPDATED },
        events: [{ type: 'qa_retry_blocked', node: 'implement', at: UPDATED, ts: UPDATED, detail: 'destino_ocupado' }],
    });
    fs.writeFileSync(path.join(dir, 'retry-signal.json'), JSON.stringify({ node: 'implement' }));
    fs.mkdirSync(worktreeOf(id), { recursive: true });
    assert.deepStrictEqual(await watcher.consumeQaRetrySignals(), [id]);
    const target = path.join(worktreeOf(id), 'memory', 'runs', taskId);
    const st = read(target);
    assert.strictEqual(st.qa_retry_blocked, undefined);
    assert.ok(st.events.some(e => e.type === 'qa_retry_blocked' && e.detail === 'destino_ocupado'));
    assert.ok(!fs.existsSync(path.join(target, 'retry-signal.json')));
});

test.after(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
    if (savedQaDiagnostico === undefined) delete process.env.WATCHER_QA_DIAGNOSTICO;
    else process.env.WATCHER_QA_DIAGNOSTICO = savedQaDiagnostico;
});
