// node --test scripts/lib/dry-run-flag-watcher.test.js
// --dry-run (argv) não escreve nada: um tick inteiro, com e sem --ticket, contra um Redmine
// HTTP local, com runs que fariam o portão de drift (enforceSpecIntegrity → changed), o
// baseline tardio com changelog da spec e o stale_artifacts gravarem. memory/, .graph/ e os
// worktrees ficam iguais (hash + mtime) e o Redmine só recebe GET. Sem a flag (live ou
// DRY_RUN=true), o mesmo portão continua gravando o state.json.
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn, spawnSync, execFileSync } = require('child_process');

const tmp = fs.mkdtempSync(path.join(process.env.CLAUDE_JOB_DIR ? path.join(process.env.CLAUDE_JOB_DIR, 'tmp') : os.tmpdir(), 'dry-run-flag-'));
const repo = path.join(tmp, 'app-back');
fs.mkdirSync(path.join(repo, '.claude'), { recursive: true });
fs.copyFileSync(path.join(__dirname, '..', '..', '.claude', 'spec-hash-config.json'), path.join(repo, '.claude', 'spec-hash-config.json'));
execFileSync('git', ['-C', repo, 'init', '-q']);
process.env.REPO_PATH = repo;

const specAuthority = require('./spec-authority');
const specChange = require('./spec-change');
const specVersion = require('./spec-version');

const WATCHER = path.join(__dirname, '..', 'readmine-watcher.js');
const bin = path.join(tmp, 'bin');
fs.mkdirSync(bin);
fs.writeFileSync(path.join(bin, 'claude'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });

const SPEC = '# Spec\n\n## Objetivo\nTestar o --dry-run.\n\n## Critérios de Aceite\n- AC-01: nada é gravado.\n';
const OLD = new Date(Date.now() - 45 * 24 * 60 * 60 * 1000).toISOString();

function write(rel, content) {
    const abs = path.join(repo, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, typeof content === 'string' ? content : JSON.stringify(content, null, 2));
    return abs;
}
const wt = id => `.claude/worktrees/${id}`;
function seedTask(id, slug, state) {
    write(`${wt(id)}/memory/spec/${id}-spec.md`, SPEC);
    return write(`${wt(id)}/memory/runs/${id}-${slug}/state.json`, { task_id: `${id}-${slug}`, status: 'in_progress', updated_at: new Date().toISOString(), spec_path: `memory/spec/${id}-spec.md`, ...state });
}

// Drift: spec_hash do Plan diferente da spec atual → status spec-drift.
seedTask(96701, 'drift', { node: 'test', history: ['fetch_ticket', 'plan', 'implement', 'review'], spec_hash: 'f'.repeat(64) });
// Baseline tardio com bloco spec em rascunho: gravaria state.json e o changelog da spec.
const baselineState = { task_id: '96702-baseline', node: 'review', history: ['fetch_ticket', 'plan', 'implement'] };
specVersion.init(baselineState, { root: path.join(repo, wt(96702)), specRel: 'memory/spec/96702-spec.md', content: SPEC, taskId: '96702-baseline' });
seedTask(96702, 'baseline', baselineState);
// SPEC_CHANGE aprovada deixou plan.md stale: volta pro /plan.
seedTask(96703, 'stale', { node: 'test', history: ['fetch_ticket', 'plan', 'implement', 'review'], stale_artifacts: ['plan.md'], stale_since: new Date().toISOString() });
// Trabalho para os syncs do início do tick: run entregue com ACs (registro de ACs e knowledge
// graph), run velho (rotação), nó órfão e sinal de retry de Recusa QA.
write('memory/spec/96720-spec.md', SPEC);
write('memory/runs/_archive/96720-entregue/state.json', { task_id: '96720-entregue', node: 'commit', history: ['fetch_ticket', 'plan', 'implement', 'review', 'test', 'verify', 'commit'], status: 'committed', updated_at: OLD });
write('memory/runs/96721-qa/state.json', { task_id: '96721-qa', node: 'commit', history: ['commit'], status: 'committed', updated_at: OLD });
write('memory/runs/96721-qa/retry-signal.json', { requested_at: new Date().toISOString() });
write('memory/runs/96722-orfao/state.json', { task_id: '96722-orfao', node: 'implement', history: ['plan'], status: 'running', agent_pid: 999999, node_started_at: OLD, updated_at: OLD });

function snapshot(root) {
    const out = {};
    (function walk(dir) {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
            if (e.name === '.git') continue;
            const p = path.join(dir, e.name);
            const st = fs.lstatSync(p);
            if (e.isDirectory()) {
                out[`${path.relative(root, p)}/`] = `dir ${st.mtimeMs}`;
                walk(p);
            } else {
                out[path.relative(root, p)] = `${crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex')} ${st.size} ${st.mtimeMs}`;
            }
        }
    })(root);
    return out;
}

const requests = [];
const server = http.createServer((req, res) => {
    requests.push(`${req.method} ${req.url}`);
    const m = /^\/issues\/(\d+)\.json/.exec(req.url);
    res.setHeader('Content-Type', 'application/json');
    if (req.method === 'GET' && req.url.startsWith('/issues.json')) return res.end(JSON.stringify({ issues: [] }));
    if (req.method === 'GET' && m) {
        return res.end(JSON.stringify({ issue: {
            id: Number(m[1]), subject: `Ticket ${m[1]}`, status: { id: 2, name: 'Em Desenvolvimento' },
            updated_on: new Date().toISOString(), custom_fields: [{ id: 1, name: 'Branch Liberação', value: 'Dev - Local' }], journals: [],
        } }));
    }
    res.statusCode = req.method === 'GET' ? 404 : 200;
    res.end('{}');
});

function cleanEnv(extra) {
    const env = { ...process.env, ...extra };
    for (const k of ['DRY_RUN', 'DRY_RUN_FIXTURE', 'KNOWLEDGE_GRAPH_PATH', 'CONSOLIDATOR_STATE_PATH', 'CONSOLIDATOR_PATTERNS_PATH', 'DISABLE_AUTO_CLEANUP', 'NOTIFY_WEBHOOK_URL', 'PRISMA_ROOT']) {
        if (!(k in extra)) delete env[k];
    }
    return env;
}

function tick(args) {
    const env = cleanEnv({
        REPO_PATH: repo, REDMINE_URL: `http://127.0.0.1:${server.address().port}`, REDMINE_API_KEY: 'chave-teste',
        REDMINE_RETRY_MAX_ATTEMPTS: '1', REDMINE_MIN_INTERVAL_MS: '0', BITBUCKET_API_TOKEN: '', PATH: `${bin}${path.delimiter}${process.env.PATH}`,
    });
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [WATCHER, ...args], { cwd: repo, env });
        let out = '';
        child.stdout.on('data', d => { out += d; });
        child.stderr.on('data', d => { out += d; });
        const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`tick não terminou:\n${out}`)); }, 60000);
        child.on('close', code => { clearTimeout(timer); resolve({ code, out }); });
    });
}

test.before(() => new Promise(resolve => server.listen(0, '127.0.0.1', resolve)));
test.after(() => { server.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

test('fixture: sem --dry-run, drift, baseline e stale gravariam o state.json', () => {
    const read = (id, slug) => JSON.parse(fs.readFileSync(path.join(repo, wt(id), 'memory/runs', `${id}-${slug}`, 'state.json'), 'utf8'));
    const drift = specAuthority.enforceSpecIntegrity(read(96701, 'drift'), { root: path.join(repo, wt(96701)), taskId: '96701-drift', node: 'test' });
    assert.deepStrictEqual([drift.changed, drift.proceed], [true, false]);
    assert.strictEqual(specAuthority.checkDrift(read(96702, 'baseline'), { root: path.join(repo, wt(96702)), taskId: '96702-baseline' }).status, 'no_baseline');
    assert.strictEqual(specChange.staleGate(read(96703, 'stale'), 'test').rerouted, true);
});

for (const args of [['--dry-run'], ['--dry-run', '--ticket=96701']]) {
    test(`tick ${args.join(' ')}: nada muda em memory/, .graph/ nem nos worktrees`, async () => {
        const before = snapshot(repo);
        requests.length = 0;
        await new Promise(r => setTimeout(r, 20)); // mtime de uma escrita indevida não empata com o snapshot
        const { code, out } = await tick(args);
        assert.strictEqual(code, 0, out);
        assert.deepStrictEqual(snapshot(repo), before, out);
        assert.deepStrictEqual(requests.filter(r => !r.startsWith('GET ')), [], out);
        assert.match(out, /\[dry-run\] Task 96701-drift: gravaria state\.json: spec integrity — .*mudou depois do Plan/, out);
        assert.match(out, /SPEC DRIFT antes de test/, out);
        assert.match(out, /\[dry-run\] Tick concluído/, out);
        if (args.includes('--ticket=96701')) {
            assert.doesNotMatch(out, /9670[23]-/, out);
        } else {
            assert.match(out, /\[dry-run\] Task 96702-baseline: gravaria state\.json \(e o changelog da spec, se versionada\): spec integrity/, out);
            assert.match(out, /\[dry-run\] Task 96702-baseline \(nó review\) — dispararia Claude/, out);
            assert.match(out, /\[dry-run\] Task 96703-stale: gravaria state\.json: stale_artifacts \(plan\.md\)/, out);
            assert.match(out, /\[cleanup\] \[dry-run\]/, out);
        }
    });
}

// Sem a flag o portão grava como antes — inclusive no modo DRY_RUN=true (env), que simula o
// ciclo inteiro e continua escrevendo nos runs.
for (const mode of ['live', 'DRY_RUN=true']) {
    test(`runSpecDriftGate sem --dry-run (${mode}) grava o state.json`, () => {
        const root = path.join(tmp, `gate-${mode.replace(/\W/g, '')}`);
        fs.cpSync(repo, root, { recursive: true });
        const dir = path.join(root, wt(96701), 'memory/runs/96701-drift');
        const fixture = path.join(tmp, 'ticket-fixture.json');
        fs.writeFileSync(fixture, JSON.stringify({ id: 96701, subject: 'drift', custom_fields: [{ name: 'Branch Liberação', value: 'Dev - Local' }] }));
        const script = `
            const w = require(${JSON.stringify(WATCHER)});
            const dir = ${JSON.stringify(dir)};
            w.runSpecDriftGate({ id: 96701, subject: 'drift' }, { taskId: '96701-drift', state: w.readStateJson(dir), dir }, 'test')
                .then(r => console.log('PROCEED=' + r.proceed));`;
        const env = cleanEnv({
            REPO_PATH: root, REDMINE_URL: 'http://127.0.0.1:9', REDMINE_API_KEY: 'chave-teste', REDMINE_RETRY_MAX_ATTEMPTS: '1',
            REDMINE_MIN_INTERVAL_MS: '0', ...(mode === 'live' ? {} : { DRY_RUN: 'true', DRY_RUN_FIXTURE: fixture }),
        });
        const r = spawnSync(process.execPath, ['-e', script], { cwd: root, env, encoding: 'utf8', timeout: 60000 });
        const out = `${r.stdout}\n${r.stderr}`;
        assert.match(out, /PROCEED=false/, out);
        const state = JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'));
        assert.strictEqual(state.status, 'spec-drift', out);
        assert.strictEqual(state.spec_drift.node, 'test');
    });
}
