// node --test scripts/memory-consolidator.test.js
// scripts/memory-consolidator.js: consolidação de padrões de falha/custo de
// memory/runs/*/state.json em memory/patterns.md. Fixtures sintéticas num repo
// temporário — nunca lê/escreve memory/runs/ real (ver context.md do run
// 2026-09-26-memory-consolidator-padroes-falha pra por que as fontes reais são
// retries/agent_log, não "review-result.md"/"Decisões de Implementação").
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
    classifyModule, loopCountOf, isReviewVerdictEntry, reviewSignatureOf,
    reviewFailurePatterns, highCostPatterns, decisionPatterns, recommendations,
    consolidate, maybeRun,
} = require('./memory-consolidator');

// Taxonomia deste fixture. A plataforma não traz palavras de negócio por default.
const CONSUMER_KEYWORDS = [
    ['track/calculofrete', /\bfrete\b|\bcte\b\.?|conhecimento de transporte|pagamento.*frete|\bspot\b/i],
    ['track/patio-portaria-expedicao', /portaria|p[aá]tio|etapa.*controle|expedi[cç][aã]o/i],
    ['portal/wms', /separa[cç][aã]o|\bwms\b|endere[cç]amento|unitiza[cç][aã]o/i],
];

const tmpBase = process.env.CLAUDE_JOB_DIR ? path.join(process.env.CLAUDE_JOB_DIR, 'tmp') : os.tmpdir();

function freshRepo() {
    const repoRoot = fs.mkdtempSync(path.join(tmpBase, 'memory-consolidator-'));
    fs.mkdirSync(path.join(repoRoot, 'memory', 'runs', '_archive'), { recursive: true });
    fs.mkdirSync(path.join(repoRoot, 'memory', 'spec'), { recursive: true });
    return repoRoot;
}

function writeRun(repoRoot, taskId, state, { archived = false } = {}) {
    const dir = path.join(repoRoot, 'memory', 'runs', archived ? '_archive' : '', taskId);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify(state, null, 2));
}

function baseState(overrides = {}) {
    return {
        task_id: overrides.task_id || 'x',
        node: 'commit',
        history: ['plan', 'implement', 'review', 'test', 'verify', 'commit'],
        status: 'committed',
        agent_log: [],
        ...overrides,
    };
}

test('classifyModule: reconhece módulo pelas palavras do consumidor, senão null', () => {
    assert.strictEqual(classifyModule('Correção no cálculo de frete do CT-e', CONSUMER_KEYWORDS), 'track/calculofrete');
    assert.strictEqual(classifyModule('Ajuste no Controle de Portaria', CONSUMER_KEYWORDS), 'track/patio-portaria-expedicao');
    assert.strictEqual(classifyModule('Separação por dia no WMS', CONSUMER_KEYWORDS), 'portal/wms');
    assert.strictEqual(classifyModule('nada que bata com palavra-chave alguma', CONSUMER_KEYWORDS), null);
    assert.strictEqual(classifyModule('', CONSUMER_KEYWORDS), null);
    assert.strictEqual(classifyModule(undefined, CONSUMER_KEYWORDS), null);
    assert.strictEqual(classifyModule('Correção no cálculo de frete do CT-e'), null);
});

test('loopCountOf: usa o maior valor de retries quando existe', () => {
    assert.strictEqual(loopCountOf(baseState({ retries: { review: 2, test: 0, verify: 1 } })), 2);
    assert.strictEqual(loopCountOf(baseState({ retries: {} })), 0);
});

test('loopCountOf: fallback conta só vereditos REAIS de review (nodes inclui "review")', () => {
    const state = baseState({
        retries: undefined,
        agent_log: [
            { nodes: ['review'], note: 'REPROVADO. achado bloqueante.' },
            { nodes: ['review'], note: 'REPROVADO (rodada 2). outro achado.' },
            { nodes: ['plan'], note: 'Diagnóstico menciona 9 notas REPROVADO no histórico — não é um veredito deste run.' },
        ],
    });
    assert.strictEqual(loopCountOf(state), 2);
});

test('isReviewVerdictEntry: exige nodes incluindo "review" E o texto "reprovad..."', () => {
    assert.strictEqual(isReviewVerdictEntry({ nodes: ['review'], note: 'REPROVADO.' }), true);
    assert.strictEqual(isReviewVerdictEntry({ nodes: ['plan'], note: 'texto que cita REPROVADO de outro run' }), false);
    assert.strictEqual(isReviewVerdictEntry({ nodes: ['review'], note: 'Aprovado, só achados não bloqueantes.' }), false);
    assert.strictEqual(isReviewVerdictEntry(null), false);
});

test('reviewSignatureOf: extrai o achado citado após "item N,"; sem esse formato, null', () => {
    assert.strictEqual(reviewSignatureOf('schema-guardian (item 1, codSap): achado crítico'), 'codSap');
    assert.strictEqual(reviewSignatureOf('security-reviewer (item 6, retornar-status): aprovado'), 'retornar-status');
    assert.strictEqual(reviewSignatureOf('REPROVADO. Lógica de alocação não cobre o caso X.'), null);
});

test('reviewFailurePatterns: agrega por RUN (não por nota) — 3 rodadas reprovadas pelo mesmo run contam 1', () => {
    const runs = [
        { taskId: 'A', state: baseState({ history: ['plan', 'implement', 'review'], agent_log: [
            { nodes: ['review'], note: 'REPROVADO (rodada 1). lógica de negócio X.' },
            { nodes: ['review'], note: 'REPROVADO (rodada 2). mesma lógica de negócio.' },
        ] }) },
        { taskId: 'B', state: baseState({ history: ['plan', 'implement', 'review'], agent_log: [
            { nodes: ['review'], note: 'REPROVADO. schema-guardian (item 1, codSap): achado crítico' },
        ] }) },
        { taskId: 'C', state: baseState({ history: ['plan', 'implement', 'review'], agent_log: [] }) },
    ];
    const patterns = reviewFailurePatterns(runs);
    const generic = patterns.find(p => p.signature.startsWith('lógica de negócio'));
    const codSap = patterns.find(p => p.signature === 'codSap');
    assert.strictEqual(generic.count, 1);
    assert.deepStrictEqual(generic.examples, ['A']);
    assert.strictEqual(codSap.count, 1);
    assert.strictEqual(generic.totalReviewedRuns, 3);
});

test('highCostPatterns: loop_count exatamente 1 não entra (só > 1)', () => {
    const runs = [
        { taskId: 'A', state: baseState({ scope: 'Correção no cálculo de frete', retries: { review: 1 } }) },
    ];
    assert.deepStrictEqual(highCostPatterns(runs), []);
});

test('highCostPatterns: só runs com loop_count > 1, agrupados por módulo inferido do scope', () => {
    const runs = [
        { taskId: 'A', state: baseState({ scope: 'Correção no cálculo de frete', retries: { review: 2 } }) },
        { taskId: 'B', state: baseState({ scope: 'Correção no cálculo de frete', retries: { review: 3 } }) },
        { taskId: 'C', state: baseState({ scope: 'Sem palavra-chave nenhuma', retries: { review: 1 } }) },
    ];
    const patterns = highCostPatterns(runs, CONSUMER_KEYWORDS);
    assert.strictEqual(patterns.length, 1);
    assert.strictEqual(patterns[0].label, 'track/calculofrete');
    assert.strictEqual(patterns[0].n, 2);
    assert.strictEqual(patterns[0].avgLoops, 2.5);
});

test('decisionPatterns: lê "## Decisões de Implementação" de memory/spec/*.md; sem a seção, ignora o arquivo', () => {
    const repoRoot = freshRepo();
    fs.writeFileSync(path.join(repoRoot, 'memory', 'spec', '111-spec.md'),
        '## Critérios de Aceite\n- a\n\n## Decisões de Implementação\n\n### implement · 2026-09-01T00:00Z · 111\n- **Decisão**: usar BigDecimal\n- **Motivo**: precisão monetária\n- **Impacto no spec**: nenhum\n');
    fs.writeFileSync(path.join(repoRoot, 'memory', 'spec', '00-overview.md'), '## Contexto\nsem decisões aqui');
    const found = decisionPatterns(repoRoot);
    assert.deepStrictEqual(found, [{ file: '111-spec.md', decision: 'usar BigDecimal' }]);
});

test('decisionPatterns: sem memory/spec/, devolve [] sem lançar', () => {
    const repoRoot = fs.mkdtempSync(path.join(tmpBase, 'memory-consolidator-nospec-'));
    assert.deepStrictEqual(decisionPatterns(repoRoot), []);
});

test('recommendations: nunca fica vazio, mesmo sem nenhum padrão', () => {
    assert.strictEqual(recommendations([], [], []).length >= 1, true);
});

test('consolidate: com 10+ runs completados, gera as 3 seções com pelo menos 1 entrada cada (AC1)', () => {
    const repoRoot = freshRepo();
    for (let i = 1; i <= 8; i++) {
        writeRun(repoRoot, `run-${i}`, baseState({ task_id: `run-${i}`, scope: 'tarefa qualquer sem palavra-chave' }));
    }
    writeRun(repoRoot, 'run-9', baseState({
        task_id: 'run-9', scope: 'Ajuste no cálculo de frete do CT-e', retries: { review: 2 },
        history: ['plan', 'implement', 'review', 'implement', 'review', 'test', 'verify', 'commit'],
        agent_log: [{ nodes: ['review'], note: 'REPROVADO. Regra de negócio não coberta pela spec.' }],
    }));
    writeRun(repoRoot, 'run-10', baseState({ task_id: 'run-10', scope: 'Outra tarefa qualquer' }), { archived: true });

    const result = consolidate({ repoRoot });
    assert.strictEqual(fs.existsSync(result.patternsPath), true);
    const md = fs.readFileSync(result.patternsPath, 'utf8');
    const section = (h) => md.slice(md.indexOf(h), md.indexOf('\n## ', md.indexOf(h) + 1) === -1 ? undefined : md.indexOf('\n## ', md.indexOf(h) + 1));
    for (const h of ['## Padrões de Falha no Review', '## Runs de Alto Custo (loop_count > 1)', '## Recomendações para Specs Futuras']) {
        const s = section(h);
        assert.match(s, /\n- /, `seção "${h}" deveria ter pelo menos 1 item de lista`);
    }
    assert.strictEqual(result.meta.totalRuns, 10);
});

test('collectRuns: state.json malformado (JSON inválido) é ignorado, não lança', () => {
    const repoRoot = freshRepo();
    writeRun(repoRoot, 'run-ok', baseState({ task_id: 'run-ok' }));
    const brokenDir = path.join(repoRoot, 'memory', 'runs', 'run-quebrado');
    fs.mkdirSync(brokenDir, { recursive: true });
    fs.writeFileSync(path.join(brokenDir, 'state.json'), '{ isso não é JSON');
    const result = consolidate({ repoRoot });
    assert.strictEqual(result.meta.totalRuns, 1, 'run com state.json malformado não deveria contar');
});

test('listRunDirs: arquivos soltos direto em memory/runs/ (*.log, *-cost.json) são ignorados, só diretórios contam', () => {
    const repoRoot = freshRepo();
    writeRun(repoRoot, 'run-1', baseState({ task_id: 'run-1' }));
    fs.writeFileSync(path.join(repoRoot, 'memory', 'runs', '43511.log'), 'log solto');
    fs.writeFileSync(path.join(repoRoot, 'memory', 'runs', '43511-cost.json'), '{}');
    const result = consolidate({ repoRoot });
    assert.strictEqual(result.meta.totalRuns, 1, 'arquivo solto (não-diretório) não deveria ser tratado como run');
});

test('consolidate: nunca apaga nem move nenhum arquivo de memory/runs/', () => {
    const repoRoot = freshRepo();
    for (let i = 1; i <= 5; i++) writeRun(repoRoot, `run-${i}`, baseState({ task_id: `run-${i}` }));
    writeRun(repoRoot, 'run-6', baseState({ task_id: 'run-6' }), { archived: true });
    const walk = (dir, into) => { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const p = path.join(dir, e.name); if (e.isDirectory()) walk(p, into); else into.add(p); } };
    const before = new Set();
    walk(path.join(repoRoot, 'memory', 'runs'), before);

    consolidate({ repoRoot });
    consolidate({ repoRoot }); // roda 2x: idempotente, não deve sobrar/faltar nada

    const after = new Set();
    walk(path.join(repoRoot, 'memory', 'runs'), after);
    assert.deepStrictEqual(after, before, 'nenhum arquivo de memory/runs/ deveria ter sido criado/removido pelo consolidate');
});

test('consolidate: até 100 runs, roda bem dentro do orçamento de 5s da tarefa', () => {
    const repoRoot = freshRepo();
    for (let i = 1; i <= 100; i++) {
        writeRun(repoRoot, `run-${i}`, baseState({
            task_id: `run-${i}`,
            scope: i % 3 === 0 ? 'Ajuste no cálculo de frete' : 'Tarefa qualquer',
            retries: { review: i % 4 },
        }));
    }
    const start = Date.now();
    consolidate({ repoRoot });
    assert.ok(Date.now() - start < 5000, 'consolidate() excedeu 5s para 100 runs');
});

test('maybeRun: só consolida a cada `threshold` runs completados novos; contador persiste', () => {
    const repoRoot = freshRepo();
    const statePath = path.join(repoRoot, 'memory', 'consolidator-state.json');
    for (let i = 1; i <= 9; i++) writeRun(repoRoot, `run-${i}`, baseState({ task_id: `run-${i}` }));

    let r = maybeRun({ repoRoot, statePath, threshold: 10 });
    assert.strictEqual(r.ran, false);
    assert.strictEqual(fs.existsSync(statePath), false);

    writeRun(repoRoot, 'run-10', baseState({ task_id: 'run-10' }));
    r = maybeRun({ repoRoot, statePath, threshold: 10 });
    assert.strictEqual(r.ran, true);
    const counter1 = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    assert.strictEqual(counter1.completed_runs_at_last_run, 10);
    assert.strictEqual(counter1.total_consolidations, 1);

    r = maybeRun({ repoRoot, statePath, threshold: 10 });
    assert.strictEqual(r.ran, false, 'não deve rodar de novo sem 10 novos runs completados');

    for (let i = 11; i <= 20; i++) writeRun(repoRoot, `run-${i}`, baseState({ task_id: `run-${i}` }));
    r = maybeRun({ repoRoot, statePath, threshold: 10 });
    assert.strictEqual(r.ran, true);
    const counter2 = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    assert.strictEqual(counter2.total_consolidations, 2);
});

test('maybeRun: dryRun nunca escreve patterns.md nem o contador', () => {
    const repoRoot = freshRepo();
    const statePath = path.join(repoRoot, 'memory', 'consolidator-state.json');
    const patternsPath = path.join(repoRoot, 'memory', 'patterns.md');
    for (let i = 1; i <= 10; i++) writeRun(repoRoot, `run-${i}`, baseState({ task_id: `run-${i}` }));
    const r = maybeRun({ repoRoot, statePath, patternsPath, threshold: 10, dryRun: true });
    assert.strictEqual(r.ran, false);
    assert.strictEqual(r.wouldRun, true);
    assert.strictEqual(fs.existsSync(statePath), false);
    assert.strictEqual(fs.existsSync(patternsPath), false);
});
