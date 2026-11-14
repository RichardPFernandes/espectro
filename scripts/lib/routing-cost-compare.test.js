// node --test scripts/lib/routing-cost-compare.test.js
// PRI-341 T3 / AC-5: comparador de custo, Run decomposta × monomodelo. Só lê state.json.
// Runs sintéticas; nenhum dado de consumidor. Custo ausente = null, nunca 0 (UNK-AR-006).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const cmp = require('./routing-cost-compare');

const att = usd => ({ cost: usd === undefined ? undefined : { usd } });
function state(nodes, decomposition) {
    const cost_tracking = { nodes: Object.fromEntries(Object.entries(nodes).map(([n, list]) => [n, { attempts: list.map(att) }])) };
    return decomposition === undefined ? { cost_tracking } : { cost_tracking, decomposition };
}
const DEC = { plan_version: 'v', status: 'DECOMPOSABLE', groups: [{ subtask_key: 'a', steps: [1], paths_decl: [] }], recorded_at: '2026-11-16T00:00:00Z' };
const NOT_DEC = { plan_version: null, status: 'NOT_DECOMPOSABLE', cause: 'x', groups: [], recorded_at: '2026-11-16T00:00:00Z' };

test('classifica por state.decomposition: DECOMPOSABLE, NOT_DECOMPOSABLE (caminho da S4) e monomodelo', () => {
    const r = cmp.compareRuns([
        { run_id: 'm1', state: state({ plan: [1], implement: [2] }) },
        { run_id: 'd1', state: state({ plan: [1], implement: [1, 1] }, DEC) },
        { run_id: 'n1', state: state({ plan: [1], implement: [2] }, NOT_DEC) },
    ]);
    assert.deepStrictEqual(r.runs.map(x => [x.run_id, x.kind]), [['m1', 'monomodel'], ['d1', 'decomposed'], ['n1', 'not_decomposable']]);
    assert.strictEqual(r.by_kind.decomposed.runs, 1);
    assert.strictEqual(r.by_kind.not_decomposable.runs, 1);
});

test('custo por Run e por Attempt; média só sobre Runs completas', () => {
    const r = cmp.compareRuns([
        { run_id: 'm1', state: state({ plan: [1], implement: [3] }) },
        { run_id: 'm2', state: state({ plan: [1], implement: [5] }) },
        { run_id: 'd1', state: state({ plan: [1], implement: [1, 1, 1] }, DEC) },
    ]);
    const m1 = r.runs[0];
    assert.deepStrictEqual([m1.attempts, m1.priced_attempts, m1.unpriced_attempts, m1.cost_usd, m1.complete], [2, 2, 0, 4, true]);
    assert.strictEqual(r.by_kind.monomodel.mean_cost_per_run_usd, 5);
    assert.strictEqual(r.by_kind.monomodel.mean_cost_per_attempt_usd, 2.5); // (4 + 6) USD em 4 Attempts
    assert.strictEqual(r.by_kind.decomposed.mean_cost_per_run_usd, 4);
    assert.deepStrictEqual([r.diff.decomposed_minus_monomodel_per_run_usd, r.diff.ratio_per_run], [-1, 0.8]);
});

test('AC-5: custo ausente é null e nunca vira 0; Run incompleta fica fora da média', () => {
    const r = cmp.compareRuns([
        { run_id: 'm1', state: state({ plan: [1], implement: [undefined] }) },
        { run_id: 'm2', state: state({ plan: [2], implement: [2] }) },
    ]);
    const m1 = r.runs[0];
    assert.deepStrictEqual([m1.priced_attempts, m1.unpriced_attempts, m1.cost_usd, m1.complete], [1, 1, 1, false]);
    assert.strictEqual(r.by_kind.monomodel.complete_runs, 1);
    assert.strictEqual(r.by_kind.monomodel.mean_cost_per_run_usd, 4);

    const none = cmp.compareRuns([{ run_id: 'x', state: state({ plan: [undefined] }) }]);
    assert.strictEqual(none.runs[0].cost_usd, null);
    assert.strictEqual(none.by_kind.monomodel.mean_cost_per_run_usd, null);
});

test('AC-5: valor inválido (negativo, NaN, texto) conta como sem preço, não como 0', () => {
    const bad = { cost_tracking: { nodes: { plan: { attempts: [{ cost: { usd: -1 } }, { cost: { usd: 'x' } }, { cost: { usd: NaN } }, {}] } } } };
    const r = cmp.compareRuns([{ run_id: 'b', state: bad }]);
    assert.deepStrictEqual([r.runs[0].attempts, r.runs[0].priced_attempts, r.runs[0].cost_usd], [4, 0, null]);
});

test('sem um dos braços a diferença é null (não há comparação)', () => {
    const r = cmp.compareRuns([{ run_id: 'm1', state: state({ plan: [1] }) }]);
    assert.deepStrictEqual([r.diff.decomposed_minus_monomodel_per_run_usd, r.diff.ratio_per_run], [null, null]);
});

test('Run sem cost_tracking: 0 Attempts, custo null, kind ainda classificado', () => {
    const r = cmp.compareRuns([{ run_id: 'z', state: {} }]);
    assert.deepStrictEqual([r.runs[0].kind, r.runs[0].attempts, r.runs[0].cost_usd, r.runs[0].complete], ['monomodel', 0, null, false]);
});

test('custo do nó implement por Run, onde a decomposição age', () => {
    const r = cmp.compareRuns([
        { run_id: 'm1', state: state({ plan: [1], implement: [4] }) },
        { run_id: 'd1', state: state({ plan: [1], implement: [1, 1] }, DEC) },
    ]);
    assert.deepStrictEqual([r.runs[0].implement_cost_usd, r.runs[1].implement_cost_usd], [4, 2]);
    assert.deepStrictEqual([r.by_kind.monomodel.mean_implement_usd, r.by_kind.decomposed.mean_implement_usd], [4, 2]);
});

test('formatMarkdown: ausente vira n/d na linha da tabela, nunca 0', () => {
    const md = cmp.compareRuns([{ run_id: 'm1', state: state({ plan: [undefined] }) }]);
    const line = cmp.formatMarkdown(md).split('\n').find(l => l.startsWith('| monomodel |'));
    assert.strictEqual(line, '| monomodel | 1 | 0 | 0 / 1 | n/d | n/d | n/d |');
    assert.ok(!/NaN|undefined|null|Infinity/.test(cmp.formatMarkdown(md)));
});

test('AC-5: custo 0 legítimo conta como com preço (não é ausente)', () => {
    const r = cmp.compareRuns([{ run_id: 'm', state: state({ plan: [0], implement: [0.1] }) }]);
    assert.deepStrictEqual([r.runs[0].priced_attempts, r.runs[0].unpriced_attempts, r.runs[0].cost_usd, r.runs[0].complete], [2, 0, 0.1, true]);
});

test('AC-5: média por Attempt divide só pelos Attempts com preço; sem nenhum preço é null', () => {
    const r = cmp.compareRuns([{ run_id: 'm', state: state({ plan: [2, undefined] }) }]);
    assert.deepStrictEqual([r.by_kind.monomodel.mean_cost_per_attempt_usd, r.by_kind.monomodel.unpriced_attempts], [2, 1]);
    const none = cmp.compareRuns([{ run_id: 'x', state: state({ plan: [undefined, undefined] }) }]);
    assert.strictEqual(none.by_kind.monomodel.mean_cost_per_attempt_usd, null);
});

test('AC-5: Run sem o nó implement tem implement null, incompleto, e média do implement null', () => {
    const r = cmp.compareRuns([{ run_id: 'm', state: state({ plan: [1] }) }]);
    assert.deepStrictEqual([r.runs[0].implement_cost_usd, r.runs[0].implement_complete, r.by_kind.monomodel.mean_implement_usd], [null, false, null]);
});

test('média do implement exclui Run com implement parcial', () => {
    const r = cmp.compareRuns([
        { run_id: 'a', state: state({ implement: [2, undefined] }) },
        { run_id: 'b', state: state({ implement: [4] }) },
    ]);
    assert.strictEqual(r.by_kind.monomodel.mean_implement_usd, 4);
});

test('razão com média monomodelo 0 é null (sem Infinity); a diferença segue calculada', () => {
    const r = cmp.compareRuns([
        { run_id: 'm', state: state({ implement: [0] }) },
        { run_id: 'd', state: state({ implement: [1] }, DEC) },
    ]);
    assert.deepStrictEqual([r.diff.decomposed_minus_monomodel_per_run_usd, r.diff.ratio_per_run], [1, null]);
});

test('arredondamento: 0.1 três vezes dá 0.3 e a média de 1, 1, 2 dá 1.333333', () => {
    const a = cmp.compareRuns([{ run_id: 'a', state: state({ plan: [0.1, 0.1, 0.1] }) }]);
    assert.strictEqual(a.runs[0].cost_usd, 0.3);
    const b = cmp.compareRuns([1, 1, 2].map((c, i) => ({ run_id: `r${i}`, state: state({ plan: [c] }) })));
    assert.strictEqual(b.by_kind.monomodel.mean_cost_per_run_usd, 1.333333);
});

test('entradas degeneradas não lançam: lista vazia, não-array, Attempt e nó malformados, Infinity e string numérica', () => {
    for (const bad of [[], undefined, null]) {
        const r = cmp.compareRuns(bad);
        assert.deepStrictEqual([r.by_kind.monomodel.runs, r.by_kind.monomodel.mean_cost_per_run_usd], [0, null]);
    }
    const weird = { cost_tracking: { nodes: {
        a: { attempts: [null, 'x', [], { cost: { usd: Infinity } }, { cost: { usd: '1.5' } }, { cost: { usd: 1 } }] },
        b: { attempts: 'nao-array' }, c: null,
    } } };
    const r = cmp.compareRuns([{ run_id: 'w', state: weird }]);
    assert.deepStrictEqual([r.runs[0].attempts, r.runs[0].priced_attempts, r.runs[0].unpriced_attempts, r.runs[0].cost_usd], [3, 1, 2, 1]);
});

test('segurança: soma que estoura vira sem preço, nunca Infinity; custo acima do teto é inválido', () => {
    const r = cmp.compareRuns([{ run_id: 'o', state: state({ plan: [1e305, 1e305, 5e307] }) }]);
    assert.strictEqual(r.runs[0].cost_usd, null);
    assert.strictEqual(r.runs[0].complete, false);
    const md = cmp.formatMarkdown(r);
    assert.ok(!/Infinity|NaN/.test(md));
    assert.strictEqual(JSON.parse(JSON.stringify(r)).runs[0].cost_usd, null);
});

test('segurança: custo finito acima do teto (> 1e6 USD por Attempt) é inválido, sem preço', () => {
    const r = cmp.compareRuns([{ run_id: 't', state: state({ plan: [1e6, 1e6 + 1, 2] }) }]);
    assert.deepStrictEqual([r.runs[0].priced_attempts, r.runs[0].unpriced_attempts, r.runs[0].cost_usd], [2, 1, 1000002]);
});

test('segurança: run_id com | ou quebra de linha não quebra a tabela markdown', () => {
    const md = cmp.formatMarkdown(cmp.compareRuns([{ run_id: 'h5|x\nINJETADO', state: state({ plan: [1] }) }]));
    const rows = md.split('\n').filter(l => l.includes('h5'));
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].split('|').length, 8); // 6 colunas + bordas
    assert.ok(!md.split('\n').some(l => l.startsWith('INJETADO')));
});

test('CLI: lê <run_dir>/state.json, não escreve nada e sai 0; uso incorreto sai 2', () => {
    const base = fs.mkdtempSync(path.join(process.env.CLAUDE_JOB_DIR ? path.join(process.env.CLAUDE_JOB_DIR, 'tmp') : os.tmpdir(), 'cost-compare-'));
    try {
        const a = path.join(base, 'run-a'); const b = path.join(base, 'run-b');
        fs.mkdirSync(a); fs.mkdirSync(b);
        fs.writeFileSync(path.join(a, 'state.json'), JSON.stringify(state({ plan: [1], implement: [2] })));
        fs.writeFileSync(path.join(b, 'state.json'), JSON.stringify(state({ plan: [1], implement: [1] }, DEC)));
        const before = fs.readdirSync(a).concat(fs.readdirSync(b));
        const cli = path.join(__dirname, '..', 'routing-cost-compare.js');
        const ok = spawnSync(process.execPath, [cli, '--json', a, b], { encoding: 'utf8' });
        assert.strictEqual(ok.status, 0, ok.stderr);
        const out = JSON.parse(ok.stdout);
        assert.deepStrictEqual(out.runs.map(x => [x.run_id, x.kind]), [['run-a', 'monomodel'], ['run-b', 'decomposed']]);
        assert.deepStrictEqual(fs.readdirSync(a).concat(fs.readdirSync(b)), before);
        assert.strictEqual(spawnSync(process.execPath, [cli], { encoding: 'utf8' }).status, 2);
        assert.strictEqual(spawnSync(process.execPath, [cli, path.join(base, 'nao-existe')], { encoding: 'utf8' }).status, 1);
    } finally {
        fs.rmSync(base, { recursive: true, force: true });
    }
});

function runDir(base, name, st) {
    const d = path.join(base, name);
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, 'state.json'), typeof st === 'string' ? st : JSON.stringify(st));
    return d;
}
const CLI = path.join(__dirname, '..', 'routing-cost-compare.js');
const tmp = () => fs.mkdtempSync(path.join(process.env.CLAUDE_JOB_DIR ? path.join(process.env.CLAUDE_JOB_DIR, 'tmp') : os.tmpdir(), 'cost-compare-'));

test('CLI: saída padrão é a tabela markdown', () => {
    const base = tmp();
    try {
        const a = runDir(base, 'run-a', state({ plan: [1], implement: [2] }));
        const r = spawnSync(process.execPath, [CLI, a], { encoding: 'utf8' });
        assert.strictEqual(r.status, 0, r.stderr);
        assert.match(r.stdout, /^\| Braço \|/);
        assert.match(r.stdout, /\| run-a \| monomodel \| 2 \| 0 \| 3 \| 2 \|/);
    } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('CLI: JSON inválido sai 1 sem saída parcial; state.json null ou [] vira monomodelo sem Attempts; flag desconhecida sai 2', () => {
    const base = tmp();
    try {
        const ok = runDir(base, 'ok', state({ plan: [1] }));
        const bad = runDir(base, 'bad', '{nao-json');
        const r = spawnSync(process.execPath, [CLI, ok, bad], { encoding: 'utf8' });
        assert.deepStrictEqual([r.status, r.stdout], [1, '']);
        for (const body of ['null', '[]']) {
            const d = runDir(base, `v${body.length}`, body);
            const x = JSON.parse(spawnSync(process.execPath, [CLI, '--json', d], { encoding: 'utf8' }).stdout);
            assert.deepStrictEqual([x.runs[0].kind, x.runs[0].attempts], ['monomodel', 0]);
        }
        assert.strictEqual(spawnSync(process.execPath, [CLI, '--foo', ok], { encoding: 'utf8' }).status, 2);
    } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('CLI: a mesma Run repetida, ou duas com o mesmo basename, é recusada (exit 2), nunca contada em dobro', () => {
    const base = tmp();
    try {
        const a = runDir(base, 'run-a', state({ plan: [1] }));
        const dup = spawnSync(process.execPath, [CLI, a, a], { encoding: 'utf8' });
        assert.deepStrictEqual([dup.status, dup.stdout], [2, '']);
        const x = runDir(path.join(base, 'x'), 'run', state({ plan: [1] }));
        const y = runDir(path.join(base, 'y'), 'run', state({ plan: [1] }));
        const same = spawnSync(process.execPath, [CLI, x, y], { encoding: 'utf8' });
        assert.deepStrictEqual([same.status, same.stdout], [2, '']);
    } finally { fs.rmSync(base, { recursive: true, force: true }); }
});
