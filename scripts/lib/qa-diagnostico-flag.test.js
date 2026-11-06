'use strict';
// PRI-181 c0b-containment (SPEC-c0b-containment r2.1): WATCHER_QA_DIAGNOSTICO desligado por padrão
// = comportamento C0. AC-03 (sem marcadores C1–C3), AC-05 (parsing), AC-06 (propagação/.env),
// AC-09 (bordas) e AC-10 (health-check). Fixtures sintéticas do C0 (PR #50); nada de consumidor.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const fixture = require('../fixtures/qa-rejection/current.json');

const WATCHER = path.resolve(__dirname, '../readmine-watcher.js');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pri181-c0b-flag-'));
function makeRepo(name) {
    const repo = path.join(tmp, name);
    fs.mkdirSync(path.join(repo, '.claude'), { recursive: true });
    fs.mkdirSync(path.join(repo, '.git'), { recursive: true }); // travas ficam no .git do repo, não no /tmp global
    fs.copyFileSync(path.resolve(__dirname, '../../.claude/spec-hash-config.json'), path.join(repo, '.claude/spec-hash-config.json'));
    return repo;
}
const repo = makeRepo('consumer');
const envKeys = ['REPO_PATH', 'REDMINE_URL', 'REDMINE_API_KEY', 'REDMINE_MIN_INTERVAL_MS',
    'REDMINE_RETRY_BASE_DELAY_MS', 'REDMINE_RETRY_MAX_ATTEMPTS', 'WATCHER_RECUSA_QA_NOVO_CICLO', 'WATCHER_QA_DIAGNOSTICO'];
const savedEnv = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
Object.assign(process.env, {
    REPO_PATH: repo, REDMINE_URL: 'https://redmine.synthetic.invalid', REDMINE_API_KEY: 'synthetic-key-c0b',
    REDMINE_MIN_INTERVAL_MS: '0', REDMINE_RETRY_BASE_DELAY_MS: '0', REDMINE_RETRY_MAX_ATTEMPTS: '1',
});
delete process.env.WATCHER_RECUSA_QA_NOVO_CICLO;
delete process.env.WATCHER_QA_DIAGNOSTICO; // padrão: desligado

const originalFetch = global.fetch;
let response = 'own';
let calls = [];
function ticket(id, status = 'Recusa QA', updated = fixture.poll_updated_on) {
    return { id, subject: 'Formas geométricas sintéticas', description: '', status: { id: status === 'Recusa QA' ? 13 : 2, name: status },
        tracker: { name: 'Melhoria' }, updated_on: updated, custom_fields: [{ name: 'Branch Liberação', value: 'Dev - Local' }] };
}
async function fakeFetch(url, init = {}) {
    assert.equal(init.method || 'GET', 'GET');
    const match = String(url).match(/^https:\/\/redmine\.synthetic\.invalid\/issues\/(\d+)\.json(\?include=journals)?$/);
    assert.ok(match, `endpoint inesperado: ${url}`);
    calls.push(String(url));
    if (!match[2]) return { ok: true, status: 200, json: async () => ({ issue: ticket(Number(match[1])) }) };
    const failure = fixture.transport[response];
    if (failure?.error) throw Object.assign(new Error(failure.error), { name: failure.name });
    if (failure?.status) return { ok: false, status: failure.status };
    return { ok: true, status: 200, json: async () => ({ issue: { journals: fixture.journals[response] } }) };
}
global.fetch = fakeFetch;

// Spies (AC-03): com a flag desligada nenhum módulo C1–C3 pode ser chamado pelo watcher.
const c1c3 = { ingest: require('./qa-rejection-ingest'), publish: require('./qa-diagnosis-publish'), analyze: require('./qa-diagnosis-analyze') };
const touched = [];
for (const [mod, exp] of Object.entries(c1c3)) {
    for (const [name, fn] of Object.entries(exp)) {
        if (typeof fn !== 'function') continue;
        exp[name] = function spied(...args) { touched.push(`${mod}.${name}`); return fn.apply(this, args); };
    }
}
const watcher = require('../readmine-watcher');
const watcherLock = require('./watcher-lock');

const read = dir => JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'));
const raw = dir => fs.readFileSync(path.join(dir, 'state.json'), 'utf8');
let nextId = 990500;
function archived(extra = {}) {
    const id = ++nextId;
    const taskId = `${id}-synthetic`;
    const dir = path.join(repo, 'memory/runs/_archive', taskId);
    fs.mkdirSync(dir, { recursive: true });
    const state = { ...fixture.base_state, task_id: taskId, redmine_ticket: { id }, ...structuredClone(extra) };
    fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify(state));
    fs.writeFileSync(path.join(dir, 'context.md'), '# Contexto sintético\n');
    return { id, taskId, dir, state };
}
const C1_MARKERS = ['rejection_key', 'identity_quality', 'transition_journal_id', 'qa_diagnosis', 'qa-rej:'];
function ingestLocks() {
    // Com .git no repo, lockPathFor resolve para <repo>/.git (isolado de outras suítes em paralelo).
    const dir = path.dirname(watcherLock.lockPathFor(repo, 'prisma-qa-ingest-x.lock'));
    assert.equal(dir, path.join(fs.realpathSync(repo), '.git'));
    return fs.readdirSync(dir).filter(f => f.startsWith('prisma-qa-ingest-'));
}

test.after(() => {
    global.fetch = originalFetch;
    fs.rmSync(tmp, { recursive: true, force: true });
    for (const key of envKeys) {
        if (savedEnv[key] === undefined) delete process.env[key];
        else process.env[key] = savedEnv[key];
    }
});

test('AC-05/padrão: flag ausente = desligada no processo de teste', () => {
    assert.equal(watcher.QA_DIAGNOSTICO, false);
});

for (const name of ['own', 'none', 'bounce']) {
    test(`AC-03: Recusa QA (${name}) com a flag desligada não grava marcador C1–C3`, async () => {
        const { id, dir } = archived();
        response = name; calls = []; touched.length = 0;
        assert.deepEqual(ingestLocks(), []);
        await watcher.syncQaRejection(ticket(id));
        const text = raw(dir);
        for (const marker of C1_MARKERS) assert.ok(!text.includes(marker), `marcador ${marker} gravado`);
        assert.equal(read(dir).ticket_status, 'Recusa QA');
        assert.equal(calls.length, 1, 'C0: um GET de journals');
        assert.deepEqual(touched, [], 'nenhum módulo C1–C3 chamado');
        assert.equal(fs.existsSync(path.join(repo, 'memory/qa-diagnosis')), false);
        assert.deepEqual(ingestLocks(), [], 'sem lock de ingestão');
    });
}

test('AC-03: legado C0 não é promovido (status igual = sem releitura nem escrita)', async () => {
    const { id, dir } = archived(fixture.states.legacy);
    const before = raw(dir);
    response = 'legacy_unique'; calls = []; touched.length = 0;
    await watcher.syncQaRejection(ticket(id));
    assert.equal(raw(dir), before);
    assert.equal(calls.length, 0);
    assert.deepEqual(touched, []);
});

test('AC-09: run em running retorna sem escrita', async () => {
    const { id, dir } = archived({ status: 'running' });
    const before = raw(dir);
    calls = [];
    await watcher.syncQaRejection(ticket(id));
    assert.equal(raw(dir), before);
    assert.equal(calls.length, 0);
});

test('AC-09: saída da Recusa QA grava só ticket_status', async () => {
    const { id, dir, state } = archived({ ticket_status: 'Recusa QA', qa_rejection: { note: null, rejected_at: '2026-01-02T11:00:00Z', journal_id: 102 } });
    calls = [];
    await watcher.syncQaRejection(ticket(id, 'Em Desenvolvimento'));
    const after = read(dir);
    assert.equal(after.ticket_status, 'Em Desenvolvimento');
    assert.deepEqual(after.qa_rejection, state.qa_rejection);
    assert.equal(after.qa_rejections, undefined);
    assert.equal(calls.length, 0);
});

test('AC-09: transporte falho → identity_quality ausente (nunca UNKNOWN)', async () => {
    for (const name of ['unavailable', 'unauthorized', 'timeout']) {
        const { id, dir } = archived();
        response = name; touched.length = 0;
        await watcher.syncQaRejection(ticket(id));
        const after = read(dir);
        assert.equal(after.qa_rejection.identity_quality, undefined, name);
        assert.ok(!raw(dir).includes('UNKNOWN'), name);
        assert.deepEqual(touched, [], name);
    }
});

test('AC-09: run com campos C1 já gravados — nada é removido nem reinterpretado', async () => {
    const c1Entry = { n: 1, note: null, rejected_at: '2026-01-01T10:00:00Z', journal_id: 90, detected_at: '2026-01-01T10:01:00Z',
        retry_requested_at: '2026-01-01T10:05:00Z', rejection_key: 'qa-rej:v1:t1:j90', identity_quality: 'OK', transition_journal_id: 90 };
    const pointer = { rejection_key: 'qa-rej:v1:t1:j90', authority_path: 'memory/qa-diagnosis/records/x/diagnosis-record.json' };
    // (a) status igual: nenhuma escrita, bytes idênticos.
    const same = archived({ ticket_status: 'Recusa QA', qa_rejection: { ...c1Entry }, qa_rejections: [c1Entry], qa_diagnosis: pointer });
    const before = raw(same.dir);
    await watcher.syncQaRejection(ticket(same.id));
    assert.equal(raw(same.dir), before);
    // (b) nova transição: C0 grava a recusa nova; histórico C1 e ponteiro ficam byte a byte.
    const moved = archived({ ticket_status: 'Em Desenvolvimento', qa_rejection: { ...c1Entry }, qa_rejections: [c1Entry], qa_diagnosis: pointer });
    response = 'own'; touched.length = 0;
    await watcher.syncQaRejection(ticket(moved.id));
    const after = read(moved.dir);
    assert.deepEqual(after.qa_diagnosis, pointer);
    assert.deepEqual(after.qa_rejections[0], c1Entry);
    assert.equal(after.qa_rejection.rejection_key, undefined, 'recusa nova sem identidade C1');
    assert.deepEqual(touched, []);
});

// Processo filho: QA_DIAGNOSTICO é lido no require, então parsing/.env/dry-run rodam isolados.
function child(env, script, args = []) {
    const r = spawnSync(process.execPath, ['-e', script, '--', ...args], {
        cwd: env.REPO_PATH, encoding: 'utf8', timeout: 60000,
        env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, NODE_OPTIONS: process.env.NODE_OPTIONS,
            REDMINE_URL: 'https://redmine.synthetic.invalid', REDMINE_API_KEY: 'synthetic-key-c0b', ...env },
    });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    return r.stdout.trim().split('\n').pop();
}
const flagOf = JSON.stringify(WATCHER);

test('AC-05: parsing de WATCHER_QA_DIAGNOSTICO', () => {
    const r = makeRepo('parse');
    const cases = { '1': true, 'true': true, 'TRUE': true, 'sim': true, '': false, '0': false, 'false': false, 'nao': false, 'on': false };
    for (const [value, expected] of Object.entries(cases)) {
        const out = child({ REPO_PATH: r, WATCHER_QA_DIAGNOSTICO: value }, `console.log(String(require(${flagOf}).QA_DIAGNOSTICO))`);
        assert.equal(out, String(expected), `valor ${JSON.stringify(value)}`);
    }
    assert.equal(child({ REPO_PATH: r }, `console.log(String(require(${flagOf}).QA_DIAGNOSTICO))`), 'false', 'ausente');
});

test('AC-06: .env do REPO_PATH vale quando o pai não define; env herdado tem precedência', () => {
    const r = makeRepo('dotenv');
    fs.writeFileSync(path.join(r, '.env'), 'WATCHER_QA_DIAGNOSTICO=1\n');
    assert.equal(child({ REPO_PATH: r }, `console.log(String(require(${flagOf}).QA_DIAGNOSTICO))`), 'true');
    assert.equal(child({ REPO_PATH: r, WATCHER_QA_DIAGNOSTICO: '0' }, `console.log(String(require(${flagOf}).QA_DIAGNOSTICO))`), 'false');
});

test('AC-06: o tick filho do watcher-manager herda a flag do processo pai', async () => {
    const { createWatcherManager } = require('../watcher-manager');
    const script = path.join(tmp, 'fake-tick.js');
    fs.writeFileSync(script, "console.log('flag=' + (process.env.WATCHER_QA_DIAGNOSTICO ?? 'ausente'));\n");
    process.env.WATCHER_QA_DIAGNOSTICO = '1';
    try {
        const m = createWatcherManager({ script, cwd: tmp, pidFile: path.join(tmp, 'pid'), historyFile: path.join(tmp, 'hist.json'),
            envFile: null, intervalMs: 100, restartDelayMs: 50, stopGraceMs: 400 });
        await m.start();
        for (const end = Date.now() + 4000; !m.getLogBuffer().some(e => e.text.startsWith('flag=')); ) {
            if (Date.now() > end) throw new Error('timeout esperando o tick');
            await new Promise(res => setTimeout(res, 20));
        }
        await m.stop();
        assert.ok(m.getLogBuffer().some(e => e.text === 'flag=1'));
    } finally {
        delete process.env.WATCHER_QA_DIAGNOSTICO;
    }
});

test('AC-09: --dry-run com a flag desligada não escreve nem cria lock', () => {
    const r = makeRepo('dryrun');
    const taskId = '990900-synthetic';
    const dir = path.join(r, 'memory/runs/_archive', taskId);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ ...fixture.base_state, task_id: taskId, redmine_ticket: { id: 990900 } }));
    const before = fs.readFileSync(path.join(dir, 'state.json'), 'utf8');
    const journals = JSON.stringify(fixture.journals.own);
    const out = child({ REPO_PATH: r }, `
        global.fetch = async (url) => String(url).includes('include=journals')
            ? { ok: true, status: 200, json: async () => ({ issue: { journals: ${journals} } }) }
            : { ok: true, status: 200, json: async () => ({ issue: {} }) };
        const w = require(${flagOf});
        w.syncQaRejection({ id: 990900, status: { id: 13, name: 'Recusa QA' }, updated_on: '2026-01-02T12:00:00Z' })
            .then(res => console.log(JSON.stringify({ flag: w.QA_DIAGNOSTICO, status: res.state.ticket_status })));
    `, ['--dry-run']);
    assert.deepEqual(JSON.parse(out), { flag: false, status: 'Recusa QA' });
    assert.equal(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'), before);
    assert.equal(fs.existsSync(path.join(r, 'memory/qa-diagnosis')), false);
    assert.deepEqual(fs.existsSync(path.join(r, '.git')) ? fs.readdirSync(path.join(r, '.git')).filter(f => f.startsWith('prisma-qa-ingest-')) : [], []);
});

test('AC-10: --health-check mantém JSON na última linha e não emite [qa-diagnostico]', () => {
    const r = makeRepo('health');
    const res = spawnSync(process.execPath, [WATCHER, '--health-check'], {
        cwd: r, encoding: 'utf8', timeout: 60000,
        env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, NODE_OPTIONS: process.env.NODE_OPTIONS, REPO_PATH: r },
    });
    const all = res.stdout + res.stderr;
    assert.ok(!all.includes('[qa-diagnostico]'), all);
    const last = res.stdout.trim().split('\n').pop();
    assert.doesNotThrow(() => JSON.parse(last), res.stdout);
});

// AC-06 (parte positiva): a primeira linha de um tick mostra o valor efetivo. Tick simulado
// (DRY_RUN=true + fixture sintética, sem chamada externa) e --dry-run (sem escrita); o
// processo é encerrado depois da primeira linha — não exige exit 0.
async function firstTickLine(flag) {
    const r = makeRepo(`tick-${flag || 'ausente'}`);
    const env = { PATH: process.env.PATH, HOME: r, TMPDIR: process.env.TMPDIR, NODE_OPTIONS: process.env.NODE_OPTIONS, REPO_PATH: r,
        DRY_RUN: 'true', DRY_RUN_FIXTURE: path.resolve(__dirname, '../fixtures/ticket-example.json') };
    if (flag !== undefined) env.WATCHER_QA_DIAGNOSTICO = flag;
    const proc = require('node:child_process').spawn(process.execPath, [WATCHER, '--dry-run'], { cwd: r, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    try {
        return await new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error(`sem linha do tick: ${out}`)), 30000);
            proc.stdout.on('data', chunk => {
                out += chunk;
                if (out.includes('\n')) { clearTimeout(timer); resolve(out.split('\n')[0]); }
            });
            proc.on('exit', () => { clearTimeout(timer); resolve(out.split('\n')[0]); });
        });
    } finally {
        proc.kill('SIGKILL');
    }
}

test('AC-06: primeira linha do tick mostra o valor efetivo da flag', async () => {
    assert.equal(await firstTickLine(undefined), '[qa-diagnostico] desligado (C0)');
    assert.equal(await firstTickLine('1'), '[qa-diagnostico] LIGADO (C1–C3)');
});
