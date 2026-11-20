'use strict';
// PRI-181 c2b-2-protocol (SPEC-c2b-2-protocol r5.1): AC-12 e AC-13 com WATCHER_QA_DIAGNOSTICO=1,
// pelo passo do watcher (qaDiagnosisTickSafe) com as raízes reais do watcher. A flag é constante
// de carga, então este modo roda em processo próprio. Fixtures sintéticas; nada de consumidor.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pri181-c2b2-flag-on-'));
const repo = path.join(tmp, 'consumer');
fs.mkdirSync(path.join(repo, '.claude'), { recursive: true });
fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
fs.copyFileSync(path.resolve(__dirname, '../../.claude/spec-hash-config.json'), path.join(repo, '.claude/spec-hash-config.json'));
const envKeys = ['REPO_PATH', 'REDMINE_URL', 'REDMINE_API_KEY', 'WATCHER_QA_DIAGNOSTICO', 'DRY_RUN'];
const savedEnv = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
Object.assign(process.env, { REPO_PATH: repo, REDMINE_URL: 'https://redmine.synthetic.invalid', REDMINE_API_KEY: 'synthetic-key-c2b2' });
delete process.env.DRY_RUN;
process.env.WATCHER_QA_DIAGNOSTICO = '1';

const protocol = require('./qa-diagnosis-protocol');
const model = require('./qa-diagnosis-model');
const watcher = require('../readmine-watcher');

const HEX_A = 'a'.repeat(64);
const T0 = Date.parse('2026-11-13T12:00:00.000Z');
const KEY = 'redmine:4242:j101';
const CONTROL = s => ({ node: s.node, status: s.status, pending_authorization: s.pending_authorization, retries: s.retries, updated_at: s.updated_at, execution_id: s.execution_id });

function mkRun(root, name, entries) {
    const dir = path.join(root, name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({
        task_id: name, node: 'implement', status: 'blocked', pending_authorization: null, retries: {}, history: [],
        updated_at: '2026-11-13T10:00:00.000Z', execution_id: 'exec-1', spec_hash: HEX_A, spec: { version: 3 }, events: [],
        qa_rejections: entries,
    }, null, 2));
    return dir;
}
const entry = (key = KEY, block = {}) => ({
    rejection_key: key, binding: { execution_id: 'exec-1', spec_hash: HEX_A, spec_version: 3, reason: 'contemporaneous' },
    diagnosis: { ...model.initialDiagnosisBlock(), ...block },
});
const read = dir => JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'));
const raw = dir => fs.readFileSync(path.join(dir, 'state.json'), 'utf8');

test.after(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
    for (const key of envKeys) {
        if (savedEnv[key] === undefined) delete process.env[key];
        else process.env[key] = savedEnv[key];
    }
});

test('modo: flag ligada neste processo', () => {
    assert.equal(watcher.QA_DIAGNOSTICO, true);
});

test('AC-12: passo do watcher publica no checkout, no worktree do ticket e na rotação; controle do run intacto', () => {
    const runs = path.join(repo, 'memory/runs');
    const main = mkRun(runs, '4242-a', [entry()]);
    const wt = mkRun(path.join(repo, '.claude/worktrees/4242/memory/runs'), '4242-wt', [entry('redmine:4242:j102')]);
    const rot = mkRun(path.join(repo, 'memory/archive/2026-10'), '4242-rot', [entry('redmine:4242:j103')]);
    const before = [main, wt, rot].map(d => CONTROL(read(d)));
    const out = watcher.qaDiagnosisTickSafe({ now: () => T0 });
    assert.ok(out && !out.error, JSON.stringify(out));
    for (const [i, d] of [main, wt, rot].entries()) {
        const s = read(d);
        assert.equal(s.qa_rejections[0].diagnosis.status, 'proposed', d);
        assert.deepEqual(CONTROL(s), before[i], 'AC-13: status/node/pending_authorization/retries/updated_at iguais');
    }
    const idle = [main, wt, rot].map(raw);
    watcher.qaDiagnosisTickSafe({ now: () => T0 + 1000 });
    assert.deepEqual([main, wt, rot].map(raw), idle, 'dois ticks ociosos → bytes iguais');
});

test('AC-12: run fora de ticketRunRoots(ticket de K) (worktree de outro ticket) nunca é subject', () => {
    const other = mkRun(path.join(repo, '.claude/worktrees/9999/memory/runs'), '4242-x', [entry('redmine:4242:j104')]);
    const before = raw(other);
    watcher.qaDiagnosisTickSafe({ now: () => T0 });
    assert.equal(raw(other), before);
    assert.ok(!fs.existsSync(path.join(path.dirname(other), protocol.STAGING_DIR)));
});

test('AC-12 (AI1-01): run fora das raízes com spec alterada e bloco proposed → nenhuma escrita (nem stale)', () => {
    const other = mkRun(path.join(repo, '.claude/worktrees/9998/memory/runs'), '4242-y', [entry('redmine:4242:j106', { status: 'proposed' })]);
    const s = read(other);
    s.spec_hash = 'b'.repeat(64);
    fs.writeFileSync(path.join(other, 'state.json'), JSON.stringify(s, null, 2));
    const before = raw(other);
    watcher.qaDiagnosisTickSafe({ now: () => T0 });
    assert.equal(raw(other), before);
    // Chamada direta também respeita a premissa 2.
    protocol.applyStale(other, { stateWriter: require('../state-writer'), cas: require('../cas'), locationRoots: watcher.qaDiagnosisLocationRoots, now: () => T0 });
    assert.equal(raw(other), before);
});

test('AC-13: exceção no passo não sai do passo (o tick segue)', () => {
    const orig = protocol.tick;
    protocol.tick = () => { throw new Error('boom'); };
    try { assert.equal(watcher.qaDiagnosisTickSafe(), null); } finally { protocol.tick = orig; }
});

test('AC-13: no tick, o passo roda uma vez e antes de consumeQaRetrySignals', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../readmine-watcher.js'), 'utf8');
    const body = src.slice(src.indexOf('async function tick()'));
    const end = body.indexOf('\n}\n');
    const tickSrc = body.slice(0, end);
    const step = tickSrc.indexOf('qaDiagnosisTickSafe()');
    const retry = tickSrc.indexOf('consumeQaRetrySignals()');
    assert.ok(step > 0 && retry > step, 'passo antes do retry');
    assert.equal(tickSrc.split('qaDiagnosisTickSafe()').length - 1, 1, 'uma vez por tick');
});

test('AC-12: DRY_RUN e SIMULATE → nenhum byte gravado pelo passo', () => {
    const runs = path.join(repo, 'memory/runs');
    const dir = mkRun(runs, '4242-dry', [entry('redmine:4242:j105')]);
    const before = raw(dir);
    const watcherPath = path.resolve(__dirname, '../readmine-watcher.js');
    const script = `process.argv.push(process.env.MODE === 'dry' ? '--dry-run' : '--x'); const w = require(${JSON.stringify(watcherPath)}); w.qaDiagnosisTickSafe();`;
    for (const mode of ['dry', 'simulate']) {
        const env = { ...process.env, MODE: mode, WATCHER_QA_DIAGNOSTICO: '1', REPO_PATH: repo };
        if (mode === 'simulate') { env.DRY_RUN = 'true'; env.DRY_RUN_FIXTURE = path.resolve(__dirname, '../fixtures/ticket-example.json'); }
        const r = spawnSync(process.execPath, ['-e', script], { env, encoding: 'utf8', timeout: 60000 });
        assert.equal(r.status, 0, r.stderr);
        assert.match(r.stdout, /no-op em DRY_RUN\/SIMULATE/);
        assert.equal(raw(dir), before, mode);
    }
});
