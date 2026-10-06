// node --test compare-runs.test.js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const tmpBase = process.env.CLAUDE_JOB_DIR ? path.join(process.env.CLAUDE_JOB_DIR, 'tmp') : os.tmpdir();
const repo = fs.mkdtempSync(path.join(tmpBase, 'compare-runs-'));
const runs = path.join(repo, 'memory', 'runs');
const SCRIPT = path.join(__dirname, 'compare-runs.js');

function seed(taskId, state, file = 'state.json') {
    const dir = path.join(runs, taskId);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, file), JSON.stringify(state));
}
const tokens = (i, o) => ({ nodes: { plan: { input_tokens: i, output_tokens: o }, implement: { input_tokens: i, output_tokens: o } } });
seed('95100-a', { status: 'escalated', node: 'escalated', history: ['plan', 'implement', 'test'], test_result: 'falhou', cost_tracking: tokens(1000, 0) });
seed('95100-a', { status: 'committed', node: 'commit', history: ['plan', 'implement', 'test', 'verify', 'commit'], test_result: 'passou', cost_tracking: tokens(600, 0) }, 'state-replay-95100-a-replay-1.json');
seed('95100-b', { status: 'committed', node: 'commit', history: ['plan', 'implement', 'test', 'verify', 'commit'], test_result: 'passou', cost_tracking: tokens(600, 0) });
seed('95100-incompleto', { status: 'committed' });

const run = (args, env = {}) => spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: 'utf8', env: { ...process.env, REPO_PATH: repo, NO_COLOR: '', FORCE_COLOR: '', ...env },
});

test.after(() => fs.rmSync(repo, { recursive: true, force: true }));

test('texto: tabela Métrica | Run A | Run B | Delta, verdict B-better e resumo', () => {
    const r = run(['95100-a', '95100-b']);
    assert.strictEqual(r.status, 0, r.stderr);
    assert.match(r.stdout, /Métrica\s+│ Run A\s+│ Run B\s+│ Delta/);
    assert.match(r.stdout, /verdict: B-better/);
    assert.match(r.stdout, /Run B completou com sucesso em 40% menos tokens que Run A/);
    assert.doesNotMatch(r.stdout, /\x1b\[/, 'sem cor fora de TTY');
});

test('FORCE_COLOR colore diferenças significativas; NO_COLOR desliga', () => {
    assert.match(run(['95100-a', '95100-b'], { FORCE_COLOR: '1' }).stdout, /\x1b\[32m/);
    assert.doesNotMatch(run(['95100-a', '95100-b'], { FORCE_COLOR: '1', NO_COLOR: '1' }).stdout, /\x1b\[/);
});

test('json: objeto com stateDiff, tokenDiff e verdict', () => {
    const r = run(['95100-a', '95100-b', '--format', 'json']);
    assert.strictEqual(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    for (const k of ['stateDiff', 'tokenDiff', 'verdict', 'nodeDiff', 'testResultsDiff', 'planScoreDiff', 'metrics']) assert.ok(k in out, k);
    assert.strictEqual(out.verdict, 'B-better');
});

test('replay file como run', () => {
    const r = run(['95100-a', '95100-a/state-replay-95100-a-replay-1.json', '--format=json']);
    assert.strictEqual(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.strictEqual(out.runB.ref, '95100-a/state-replay-95100-a-replay-1.json');
    assert.strictEqual(out.verdict, 'B-better');
});

test('schema incompleto: sem crash, N/A', () => {
    const r = run(['95100-b', '95100-incompleto']);
    assert.strictEqual(r.status, 0, r.stderr);
    assert.match(r.stdout, /N\/A/);
});

test('--output grava fora do run; recusa caminho dentro de um run comparado', () => {
    const out = path.join(repo, 'cmp.json');
    const r = run(['95100-a', '95100-b', '--format', 'json', '--output', out]);
    assert.strictEqual(r.status, 0, r.stderr);
    assert.strictEqual(JSON.parse(fs.readFileSync(out, 'utf8')).verdict, 'B-better');
    const inside = path.join(runs, '95100-a', 'cmp.txt');
    const bad = run(['95100-a', '95100-b', '--output', inside]);
    assert.strictEqual(bad.status, 1);
    assert.ok(!fs.existsSync(inside));
});

test('erros: uso incorreto = 2, run inexistente = 1', () => {
    assert.strictEqual(run(['95100-a']).status, 2);
    assert.strictEqual(run(['95100-a', '95100-b', '--format', 'xml']).status, 2);
    assert.strictEqual(run(['95100-a', '95100-b', '--nope']).status, 2);
    const r = run(['95100-a', 'nao-existe']);
    assert.strictEqual(r.status, 1);
    assert.match(r.stderr, /run não encontrado/);
    assert.match(execFileSync(process.execPath, [SCRIPT, '--help'], { encoding: 'utf8' }), /uso:/);
});
