// node --test scripts/probes/effort-benchmark.test.js
// PRI-353 (T5, AC8). Todas as fixtures são SINTÉTICAS: ids `synthetic-*`, números inventados só
// para exercitar a conta. Nada aqui é medição de run real, e a página real nunca usa estes valores.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const bench = require('./effort-benchmark');

const TABLE = { plan: 'high', implement: 'high', review: 'high', test: 'medium', verify: 'medium', commit: 'low' };
const applied = level => ({ phase_effort: { level, effort_applied: true } });

// run no formato de loadRun: { ref, taskId, state, cost_tracking }
function mkRun(id, { fixed = false, status = 'committed', nodes = {}, retries, misses, noAttempts = false } = {}) {
    const costNodes = {};
    for (const [node, m] of Object.entries(nodes)) {
        costNodes[node] = {
            ...(m.in !== undefined ? { input_tokens: m.in } : {}),
            ...(m.out !== undefined ? { output_tokens: m.out } : {}),
            ...(m.ms !== undefined ? { duration_ms: m.ms } : {}),
            ...(noAttempts ? {} : { attempts: [{ ...(fixed ? applied(m.level || TABLE[node] || 'high') : {}), ...(m.ms !== undefined ? { duration_ms: m.ms } : {}) }] }),
            ...(m.noTokensRuns !== undefined ? { runs_without_tokens: m.noTokensRuns } : {}),
        };
    }
    const state = { task_id: id, status, ...(retries ? { retries } : {}), ...(misses ? { effort_misses: misses } : {}) };
    return { ref: id, taskId: id, state, cost_tracking: Object.keys(costNodes).length ? { nodes: costNodes, totals: {} } : null };
}
const miss = (phase, would = 'unknown') => ({ id: 'em-1', phase, effort: 'medium', what_missed: 'x', would_high_catch: would,
    class: 'cobertura-de-ac', evidence_ref: 'r', recorded_by: 'review', recorded_at: '2026-01-01T00:00:00.000Z' });

const phaseRow = (b, phase) => b.phases.find(p => p.phase === phase);

test('sem pares: tudo UNKNOWN (null), nenhum zero, 0 pares válidos', () => {
    const b = bench.buildBenchmark({ pairs: [], expectedPairs: 10, table: TABLE });
    assert.strictEqual(b.pairs.received, 0);
    assert.strictEqual(b.pairs.valid, 0);
    assert.strictEqual(b.pairs.expected, 10);
    assert.deepStrictEqual(b.phases.map(p => p.phase), ['plan', 'implement', 'review', 'test', 'verify', 'commit']);
    for (const p of b.phases) {
        for (const arm of ['as_is', 'fixed']) {
            assert.strictEqual(p[arm].duration_ms.median, null);
            assert.strictEqual(p[arm].tokens.median, null);
            assert.strictEqual(p[arm].retries.total, null);
        }
        assert.strictEqual(p.delta.duration_ms, null);
        assert.strictEqual(p.delta.tokens, null);
    }
    assert.strictEqual(b.runs_failed.as_is.count, null);
    assert.strictEqual(b.runs_failed.fixed.count, null);
});

test('página vazia mostra só UNKNOWN: sem número de medição, sem NaN, sem exemplo', () => {
    const html = bench.renderHtml(bench.buildBenchmark({ pairs: [], expectedPairs: 10, table: TABLE }));
    assert.match(html, /UNKNOWN/);
    assert.doesNotMatch(html, /NaN|undefined|null/);
    // nenhuma célula de dado vale zero nem número: as únicas células de dado são UNKNOWN ou N/A
    const cells = [...html.matchAll(/<td class="m[^"]*">([^<]*)<\/td>/g)].map(m => m[1].trim());
    assert.ok(cells.length > 0);
    for (const c of cells) assert.match(c, /^(UNKNOWN|N\/A)/, `célula inesperada: ${c}`);
    assert.doesNotMatch(html, /synthetic/);
});

test('com pares sintéticos: mediana por fase e braço, delta fixo menos AS-IS', () => {
    const pairs = [
        { id: 'p1', as_is: mkRun('synthetic-a1', { nodes: { plan: { in: 100, out: 100, ms: 1000 }, test: { in: 50, out: 50, ms: 400 } } }),
          fixed: mkRun('synthetic-f1', { fixed: true, nodes: { plan: { in: 150, out: 150, ms: 2000 }, test: { in: 40, out: 40, ms: 300 } } }) },
        { id: 'p2', as_is: mkRun('synthetic-a2', { nodes: { plan: { in: 100, out: 300, ms: 3000 }, test: { in: 60, out: 60, ms: 600 } } }),
          fixed: mkRun('synthetic-f2', { fixed: true, nodes: { plan: { in: 200, out: 400, ms: 4000 }, test: { in: 40, out: 60, ms: 500 } } }) },
    ];
    const b = bench.buildBenchmark({ pairs, expectedPairs: 10, table: TABLE });
    assert.strictEqual(b.pairs.valid, 2);
    const plan = phaseRow(b, 'plan');
    assert.deepStrictEqual(plan.as_is.duration_ms, { median: 2000, n: 2 });
    assert.deepStrictEqual(plan.fixed.duration_ms, { median: 3000, n: 2 });
    assert.strictEqual(plan.delta.duration_ms, 1000);
    assert.deepStrictEqual(plan.as_is.tokens, { median: 300, n: 2 });
    assert.deepStrictEqual(plan.fixed.tokens, { median: 450, n: 2 });
    assert.strictEqual(plan.delta.tokens, 150);
    assert.strictEqual(plan.effort, 'high');
    assert.strictEqual(phaseRow(b, 'test').effort, 'medium');
    // fase sem nenhum dado segue UNKNOWN, não zero
    assert.strictEqual(phaseRow(b, 'review').as_is.duration_ms.median, null);
    assert.strictEqual(phaseRow(b, 'review').delta.duration_ms, null);
});

test('medição parcial: mediana só sobre quem mediu, com n; ninguém mediu = null', () => {
    const pairs = [
        { id: 'p1', as_is: mkRun('synthetic-a1', { nodes: { plan: { ms: 1000 } } }), fixed: mkRun('synthetic-f1', { fixed: true, nodes: { plan: { ms: 1500 } } }) },
        { id: 'p2', as_is: mkRun('synthetic-a2', { nodes: { plan: {} } }), fixed: mkRun('synthetic-f2', { fixed: true, nodes: { plan: { ms: 2500 } } }) },
    ];
    const plan = phaseRow(bench.buildBenchmark({ pairs, table: TABLE }), 'plan');
    assert.deepStrictEqual(plan.as_is.duration_ms, { median: 1000, n: 1 });
    assert.deepStrictEqual(plan.fixed.duration_ms, { median: 2000, n: 2 });
    assert.deepStrictEqual(plan.as_is.tokens, { median: null, n: 0 });
});

test('falhas: run em status de falha por braço, retries por fase só quando registrados', () => {
    const pairs = [
        { id: 'p1', as_is: mkRun('synthetic-a1', { status: 'escalated', nodes: { test: { ms: 1 } }, retries: { test: 2 } }),
          fixed: mkRun('synthetic-f1', { fixed: true, status: 'committed', nodes: { test: { ms: 1 } }, retries: { test: 1 } }) },
        { id: 'p2', as_is: mkRun('synthetic-a2', { status: 'committed', nodes: { test: { ms: 1 } } }),
          fixed: mkRun('synthetic-f2', { fixed: true, status: 'committed', nodes: { test: { ms: 1 } } }) },
    ];
    const b = bench.buildBenchmark({ pairs, table: TABLE });
    assert.deepStrictEqual(b.runs_failed.as_is, { count: 1, n: 2 });
    assert.deepStrictEqual(b.runs_failed.fixed, { count: 0, n: 2 });
    const t = phaseRow(b, 'test');
    // p2 não registrou retries: não vira zero, fica fora do n
    assert.deepStrictEqual(t.as_is.retries, { total: 2, n: 1 });
    assert.deepStrictEqual(t.fixed.retries, { total: 1, n: 1 });
});

test('status ausente não conta como sucesso nem como falha (fora do n)', () => {
    const noStatus = id => ({ ref: id, taskId: id, state: { task_id: id }, cost_tracking: null });
    const b = bench.buildBenchmark({ pairs: [{ id: 'p1', as_is: noStatus('synthetic-a'), fixed: noStatus('synthetic-f') }], table: TABLE });
    assert.deepStrictEqual(b.runs_failed.as_is, { count: null, n: 0 });
});

test('effort_miss: só fase média, do braço fixo; sem registro = UNKNOWN; fase não média = NOT_APPLICABLE', () => {
    const pairs = [
        { id: 'p1', as_is: mkRun('synthetic-a1', { nodes: { test: { ms: 1 } } }),
          fixed: mkRun('synthetic-f1', { fixed: true, nodes: { test: { ms: 1 } }, misses: [miss('test', 'yes'), miss('test')] }) },
        { id: 'p2', as_is: mkRun('synthetic-a2', { nodes: { test: { ms: 1 } } }),
          fixed: mkRun('synthetic-f2', { fixed: true, nodes: { test: { ms: 1 } }, misses: [miss('test', 'no')] }) },
    ];
    const b = bench.buildBenchmark({ pairs, table: TABLE });
    assert.deepStrictEqual(phaseRow(b, 'test').effort_miss, { status: 'RECORDED', yes: 1, no: 1, unknown: 1, runs_recorded: 2, runs_total: 2 });
    assert.deepStrictEqual(phaseRow(b, 'verify').effort_miss, { status: 'UNKNOWN' });
    assert.deepStrictEqual(phaseRow(b, 'plan').effort_miss, { status: 'NOT_APPLICABLE' });
});

test('registro de effort_miss do braço AS-IS não entra na conta', () => {
    const pairs = [{ id: 'p1', as_is: mkRun('synthetic-a1', { nodes: { test: { ms: 1 } }, misses: [miss('test', 'yes')] }),
        fixed: mkRun('synthetic-f1', { fixed: true, nodes: { test: { ms: 1 } } }) }];
    assert.deepStrictEqual(phaseRow(bench.buildBenchmark({ pairs, table: TABLE }), 'test').effort_miss, { status: 'UNKNOWN' });
});

test('rótulo contradito pelos dados exclui o par: AS-IS com esforço aplicado, ou fixo sem ele', () => {
    const good = { id: 'ok', as_is: mkRun('synthetic-a0', { nodes: { plan: { ms: 10 } } }), fixed: mkRun('synthetic-f0', { fixed: true, nodes: { plan: { ms: 20 } } }) };
    const asIsApplied = { id: 'bad1', as_is: mkRun('synthetic-a1', { fixed: true, nodes: { plan: { ms: 999 } } }), fixed: mkRun('synthetic-f1', { fixed: true, nodes: { plan: { ms: 999 } } }) };
    const fixedNotApplied = { id: 'bad2', as_is: mkRun('synthetic-a2', { nodes: { plan: { ms: 999 } } }), fixed: mkRun('synthetic-f2', { nodes: { plan: { ms: 999 } } }) };
    const b = bench.buildBenchmark({ pairs: [good, asIsApplied, fixedNotApplied], table: TABLE });
    assert.strictEqual(b.pairs.received, 3);
    assert.strictEqual(b.pairs.valid, 1);
    assert.deepStrictEqual(b.pairs.excluded.map(e => e.id), ['bad1', 'bad2']);
    assert.match(b.pairs.excluded[0].reason, /AS-IS.*phase_effort/);
    assert.match(b.pairs.excluded[1].reason, /fixo.*phase_effort/);
    assert.deepStrictEqual(phaseRow(b, 'plan').fixed.duration_ms, { median: 20, n: 1 });
});

test('sem tentativas registradas: não dá para confirmar o rótulo, o par entra e fica sinalizado', () => {
    const pairs = [{ id: 'p1', as_is: mkRun('synthetic-a1', { nodes: { plan: { ms: 10 } }, noAttempts: true }), fixed: mkRun('synthetic-f1', { nodes: { plan: { ms: 20 } }, noAttempts: true }) }];
    const b = bench.buildBenchmark({ pairs, table: TABLE });
    assert.strictEqual(b.pairs.valid, 1);
    assert.deepStrictEqual(b.pairs.unconfirmed, ['p1']);
});

test('renderHtml escapa conteúdo e mostra os números das fixtures; nunca usa valor de exemplo próprio', () => {
    const pairs = [{ id: 'ok', as_is: mkRun('synthetic-a1', { nodes: { plan: { in: 1, out: 1, ms: 61000 } } }),
        fixed: mkRun('synthetic-f1', { fixed: true, nodes: { plan: { in: 2, out: 2, ms: 121000 } } }) },
    { id: '<img src=x onerror=1>', as_is: mkRun('synthetic-a2', { fixed: true, nodes: { plan: { ms: 5 } } }), fixed: mkRun('synthetic-f2', { fixed: true, nodes: { plan: { ms: 5 } } }) }];
    const html = bench.renderHtml(bench.buildBenchmark({ pairs, table: TABLE }));
    assert.doesNotMatch(html, /<img src=x/);
    assert.match(html, /&lt;img src=x/);
    assert.match(html, /1m01s/);
    assert.match(html, /2m01s/);
    assert.match(html, /Pares excluídos/); // par excluído é listado, com o id escapado
});

test('parseArgs: --out obrigatório, --manifest e --expected opcionais, inválidos falham', () => {
    const o = bench.parseArgs(['--out', 'd']);
    assert.strictEqual(o.out, 'd');
    assert.strictEqual(o.expected, 10);
    assert.strictEqual(o.manifest, undefined);
    assert.strictEqual(bench.parseArgs(['--out', 'd', '--manifest', 'm.json', '--expected=12']).expected, 12);
    assert.throws(() => bench.parseArgs([]), /--out/);
    assert.throws(() => bench.parseArgs(['--out', 'd', '--x']), /desconhecido/);
    assert.throws(() => bench.parseArgs(['--out', 'd', '--expected', '0']), /--expected/);
});

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'effort-bench-')); }
const sink = () => { let s = ''; return { write: x => { s += x; }, get text() { return s; } }; };

test('main sem manifest grava JSON e HTML vazios (UNKNOWN) e sai 0', () => {
    const out = tmp();
    const io = { stdout: sink(), stderr: sink(), env: {} };
    assert.strictEqual(bench.main(['--out', out], io), 0);
    const json = JSON.parse(fs.readFileSync(path.join(out, 'effort-benchmark.json'), 'utf8'));
    assert.strictEqual(json.pairs.received, 0);
    assert.strictEqual(json.source, 'NO_MANIFEST');
    const html = fs.readFileSync(path.join(out, 'effort-benchmark.html'), 'utf8');
    assert.match(html, /UNKNOWN/);
    fs.rmSync(out, { recursive: true, force: true });
});

test('main com manifest lê as runs do disco, só leitura, e respeita --expected', () => {
    const root = tmp();
    const runs = path.join(root, 'memory', 'runs');
    const write = (id, run) => {
        fs.mkdirSync(path.join(runs, id), { recursive: true });
        fs.writeFileSync(path.join(runs, id, 'state.json'), JSON.stringify({ ...run.state, cost_tracking: run.cost_tracking }));
    };
    write('synthetic-a1', mkRun('synthetic-a1', { nodes: { plan: { in: 10, out: 10, ms: 1000 } } }));
    write('synthetic-f1', mkRun('synthetic-f1', { fixed: true, nodes: { plan: { in: 20, out: 20, ms: 3000 } } }));
    const manifest = path.join(root, 'manifest.json');
    fs.writeFileSync(manifest, JSON.stringify({ pairs: [{ id: 'p1', as_is: 'synthetic-a1', fixed: 'synthetic-f1' }] }));
    const before = fs.readFileSync(path.join(runs, 'synthetic-a1', 'state.json'), 'utf8');
    const out = path.join(root, 'out');
    const io = { stdout: sink(), stderr: sink(), env: { REPO_PATH: root } };
    assert.strictEqual(bench.main(['--out', out, '--manifest', manifest, '--expected', '2'], io), 0);
    const json = JSON.parse(fs.readFileSync(path.join(out, 'effort-benchmark.json'), 'utf8'));
    assert.strictEqual(json.pairs.valid, 1);
    assert.strictEqual(json.pairs.expected, 2);
    assert.deepStrictEqual(json.phases.find(p => p.phase === 'plan').fixed.duration_ms, { median: 3000, n: 1 });
    assert.strictEqual(fs.readFileSync(path.join(runs, 'synthetic-a1', 'state.json'), 'utf8'), before);
    fs.rmSync(root, { recursive: true, force: true });
});

test('main: run do manifest não encontrada = erro claro, exit 1, nada gravado', () => {
    const root = tmp();
    const manifest = path.join(root, 'manifest.json');
    fs.writeFileSync(manifest, JSON.stringify({ pairs: [{ id: 'p1', as_is: 'synthetic-nao-existe', fixed: 'synthetic-tambem-nao' }] }));
    const out = path.join(root, 'out');
    const io = { stdout: sink(), stderr: sink(), env: { REPO_PATH: root } };
    assert.strictEqual(bench.main(['--out', out, '--manifest', manifest], io), 1);
    assert.match(io.stderr.text, /run não encontrado/);
    assert.ok(!fs.existsSync(out));
    fs.rmSync(root, { recursive: true, force: true });
});

test('main: manifest malformado ou sem pairs = exit 1', () => {
    const root = tmp();
    const manifest = path.join(root, 'manifest.json');
    fs.writeFileSync(manifest, JSON.stringify({ pairs: 'x' }));
    const io = { stdout: sink(), stderr: sink(), env: { REPO_PATH: root } };
    assert.strictEqual(bench.main(['--out', path.join(root, 'o'), '--manifest', manifest], io), 1);
    assert.match(io.stderr.text, /pairs/);
    fs.rmSync(root, { recursive: true, force: true });
});

test('effort_miss leva denominador: runs fixas sem registro seguem UNKNOWN, nunca viram "sim 0"', () => {
    const mk = (i, misses) => ({ id: `p${i}`, as_is: mkRun(`synthetic-a${i}`, { nodes: { test: { ms: 1 } } }),
        fixed: mkRun(`synthetic-f${i}`, { fixed: true, nodes: { test: { ms: 1 } }, ...(misses ? { misses } : {}) }) });
    const b = bench.buildBenchmark({ pairs: [mk(1, [miss('test', 'no')]), mk(2), mk(3)], table: TABLE });
    assert.deepStrictEqual(phaseRow(b, 'test').effort_miss, { status: 'RECORDED', yes: 0, no: 1, unknown: 0, runs_recorded: 1, runs_total: 3 });
    const html = bench.renderHtml(b);
    assert.match(html, /registrado em 1 de 3 runs fixas/);
    assert.match(html, /demais UNKNOWN/);
});

// PRI-354: MINOR 3–6 da G3 da PRI-353.

test('MINOR 3: nível por fase vem do phase_effort gravado nas runs, não da tabela latest', () => {
    const pairs = [{ id: 'p1', as_is: mkRun('synthetic-a1', { nodes: { test: { in: 1, out: 1, ms: 10 } } }),
        fixed: mkRun('synthetic-f1', { fixed: true, nodes: { test: { in: 1, out: 1, ms: 10, level: 'high' } } }) }];
    // a tabela atual diz test=medium, mas a run gravou high
    const b = bench.buildBenchmark({ pairs, table: TABLE });
    const row = phaseRow(b, 'test');
    assert.strictEqual(row.effort, 'high');
    assert.strictEqual(row.effort_source, 'RECORDED');
    assert.strictEqual(row.effort_miss.status, 'NOT_APPLICABLE');
    // fase sem Attempt no braço fixo cai na tabela, rotulada
    const plan = phaseRow(b, 'plan');
    assert.strictEqual(plan.effort, 'high');
    assert.strictEqual(plan.effort_source, 'TABLE_LATEST');
});

test('MINOR 3: níveis diferentes entre runs aparecem como misto, sem escolher um', () => {
    const pairs = ['high', 'medium'].map((level, i) => ({ id: `p${i}`,
        as_is: mkRun(`synthetic-a${i}`, { nodes: { test: { in: 1, out: 1, ms: 10 } } }),
        fixed: mkRun(`synthetic-f${i}`, { fixed: true, nodes: { test: { in: 1, out: 1, ms: 10, level } } }) }));
    const row = phaseRow(bench.buildBenchmark({ pairs, table: TABLE }), 'test');
    assert.strictEqual(row.effort, 'misto (high, medium)');
    assert.strictEqual(row.effort_source, 'RECORDED');
});

test('MINOR 4: tokens com runs_without_tokens > 0 e duração com Attempt sem duration_ms viram UNKNOWN', () => {
    const asIs = mkRun('synthetic-a1', { nodes: { plan: { in: 100, out: 100, ms: 1000, noTokensRuns: 1 } } });
    const fixed = mkRun('synthetic-f1', { fixed: true, nodes: { plan: { in: 100, out: 100, ms: 1000 } } });
    fixed.cost_tracking.nodes.plan.attempts.push({ ...applied('high'), duration_ms: 0 });
    const b = bench.buildBenchmark({ pairs: [{ id: 'p1', as_is: asIs, fixed }], table: TABLE });
    const plan = phaseRow(b, 'plan');
    assert.deepStrictEqual(plan.as_is.tokens, { median: null, n: 0, partial: 1 });
    assert.deepStrictEqual(plan.fixed.duration_ms, { median: null, n: 0, partial: 1 });
    assert.strictEqual(plan.delta.tokens, null);
    assert.strictEqual(plan.delta.duration_ms, null);
    assert.match(bench.renderHtml(b), /1 parcial/);
});

test('MINOR 4: Attempts a menos que runs no nó = duração parcial', () => {
    const run = mkRun('synthetic-f1', { fixed: true, nodes: { plan: { in: 1, out: 1, ms: 1000 } } });
    run.cost_tracking.nodes.plan.runs = 2;
    const b = bench.buildBenchmark({ pairs: [{ id: 'p1', as_is: mkRun('synthetic-a1', { nodes: { plan: { in: 1, out: 1, ms: 5 } } }), fixed: run }], table: TABLE });
    assert.deepStrictEqual(phaseRow(b, 'plan').fixed.duration_ms, { median: null, n: 0, partial: 1 });
});

test('MINOR 5: Δ é a mediana das diferenças por par, só entre pares medidos dos dois lados', () => {
    const p = (i, a, f) => ({ id: `p${i}`,
        as_is: mkRun(`synthetic-a${i}`, { nodes: { plan: a === null ? { in: 1, out: 1 } : { in: 1, out: 1, ms: a } } }),
        fixed: mkRun(`synthetic-f${i}`, { fixed: true, nodes: { plan: f === null ? { in: 1, out: 1 } : { in: 1, out: 1, ms: f } } }) });
    // pares: (100→150), (1000→1010), (sem AS-IS → 9000). Não pareado: med(150,1010,9000) − med(100,1000) = 460.
    // Pareado: med(+50, +10) = 30, n=2; o 3º par fica fora.
    const b = bench.buildBenchmark({ pairs: [p(1, 100, 150), p(2, 1000, 1010), p(3, null, 9000)], table: TABLE });
    const plan = phaseRow(b, 'plan');
    assert.strictEqual(plan.delta.duration_ms, 30);
    assert.strictEqual(plan.delta.duration_n, 2);
});

test('MINOR 6: --out por symlink para dentro de uma run é recusado (realpath)', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-real-'));
    const runDir = path.join(tmp, 'runs', 'synthetic-r1');
    fs.mkdirSync(runDir, { recursive: true });
    const link = path.join(tmp, 'atalho');
    fs.symlinkSync(runDir, link);
    assert.throws(() => bench.assertOutOutsideRuns(path.join(link, 'saida'), [{ ref: 'synthetic-r1', dir: runDir }]), /dentro do diretório da run/);
    assert.doesNotThrow(() => bench.assertOutOutsideRuns(path.join(tmp, 'fora'), [{ ref: 'synthetic-r1', dir: runDir }]));
});

test('MINOR 4 (G3 PRI-354): nó sem attempts com duration_ms 0 e tokens de um lado só não viram medição', () => {
    const asIs = mkRun('synthetic-a1', { noAttempts: true, nodes: { plan: { in: 100, ms: 0 } } });
    const fixed = mkRun('synthetic-f1', { fixed: true, nodes: { plan: { in: 100, out: 100, ms: 5000 } } });
    const plan = phaseRow(bench.buildBenchmark({ pairs: [{ id: 'p1', as_is: asIs, fixed }], table: TABLE }), 'plan');
    assert.deepStrictEqual(plan.as_is.duration_ms, { median: null, n: 0, partial: 1 });
    assert.deepStrictEqual(plan.as_is.tokens, { median: null, n: 0, partial: 1 });
    assert.strictEqual(plan.delta.duration_ms, null);
});

test('segmento plan+implement (also_covers): plan e implement do braço ficam parciais, nunca comparados', () => {
    const asIs = mkRun('synthetic-a1', { nodes: { plan: { in: 10, out: 10, ms: 1000 }, implement: { in: 10, out: 10, ms: 2000 } } });
    const fixed = mkRun('synthetic-f1', { fixed: true, nodes: { implement: { in: 30, out: 30, ms: 30000 } } });
    fixed.cost_tracking.nodes.implement.also_covers = ['plan'];
    const b = bench.buildBenchmark({ pairs: [{ id: 'p1', as_is: asIs, fixed }], table: TABLE });
    for (const phase of ['plan', 'implement']) {
        const row = phaseRow(b, phase);
        assert.strictEqual(row.fixed.duration_ms.median, null, phase);
        assert.strictEqual(row.fixed.duration_ms.partial, 1, phase);
        assert.strictEqual(row.delta.duration_ms, null, phase);
    }
});

test('MINOR 6 (G3 PRI-354): symlink seguido de .., maiúsculas e memory/ do consumidor são recusados', () => {
    const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'bench-real2-')));
    const repo = path.join(tmp, 'repo');
    const runDir = path.join(repo, 'memory', 'runs', 'synthetic-r1');
    fs.mkdirSync(path.join(runDir, 'sub'), { recursive: true });
    const runs = [{ ref: 'synthetic-r1', dir: runDir }];
    fs.symlinkSync(path.join(runDir, 'sub'), path.join(tmp, 'atalho'));
    // atalho/.. = runDir fisicamente (path.resolve diria tmp/)
    assert.throws(() => bench.assertOutOutsideRuns(path.join(tmp, 'atalho') + '/../saida', runs), /dentro do diretório da run/);
    assert.throws(() => bench.assertOutOutsideRuns(runDir.toUpperCase() + '/x', runs), /dentro do diretório da run/);
    assert.throws(() => bench.assertOutOutsideRuns(path.join(repo, 'memory', 'runs'), runs, { repoPath: repo }), /memory\//);
    assert.strictEqual(bench.assertOutOutsideRuns(path.join(tmp, 'fora', 'x'), runs, { repoPath: repo }), path.join(tmp, 'fora', 'x'));
});
