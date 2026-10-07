// node --test scripts/lib/spec-enricher.test.js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
    extractKeywords, matchFileNodes, ticketsForFile, readRegrasInvioláveis, matchesRegra,
    parsePatterns, upsertSection, formatSection, enrichSpec, CONTEXT_BEGIN, CONTEXT_END,
} = require('./spec-enricher');

const tmpRoot = fs.mkdtempSync(
    path.join(process.env.CLAUDE_JOB_DIR ? path.join(process.env.CLAUDE_JOB_DIR, 'tmp') : os.tmpdir(), 'spec-enricher-')
);
let seq = 0;
function newRepo() {
    const dir = path.join(tmpRoot, `repo-${++seq}`);
    fs.mkdirSync(path.join(dir, 'memory'), { recursive: true });
    return dir;
}
function writeGraph(mainRepo, { nodes = {}, edges = [] } = {}) {
    fs.writeFileSync(path.join(mainRepo, 'memory', 'knowledge-graph.json'), JSON.stringify({ version: 1, updatedAt: null, nodes, edges }));
}
function writeProjectYaml(mainRepo, regrasBlock) {
    fs.writeFileSync(path.join(mainRepo, 'memory', 'project.yaml'), `${regrasBlock}\nagentes_por_dominio:\n  x: y\n`);
}
function writeRun(mainRepo, ticketId, dirSuffix, state) {
    const dir = path.join(mainRepo, 'memory', 'runs', dirSuffix ? `${ticketId}-${dirSuffix}` : ticketId);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify(state));
}
function writeSpec(mainRepo, name, content) {
    const p = path.join(mainRepo, `${name}.md`);
    fs.writeFileSync(p, content);
    return p;
}

// --- extractKeywords -------------------------------------------------------------

test('extractKeywords: nomes de classe por sufixo comum e arquivos citados', () => {
    const kw = extractKeywords('Ajustar o CalculoFreteService e o FaturaResource. Ver src/App.js também.');
    assert.deepStrictEqual(kw.classNames.sort(), ['CalculoFreteService', 'FaturaResource']);
    assert.deepStrictEqual(kw.fileMentions, ['src/App.js']);
});

test('extractKeywords: sem menções -> arrays vazios, nunca lança', () => {
    const kw = extractKeywords('');
    assert.deepStrictEqual(kw.classNames, []);
    assert.deepStrictEqual(kw.fileMentions, []);
});

// --- matchFileNodes / ticketsForFile ----------------------------------------------

test('matchFileNodes: casa nó "file" por sufixo /<Classe>.java, ignora nós de outro tipo', () => {
    const graph = {
        nodes: {
            'src/main/java/x/CalculoFreteService.java': { type: 'file' },
            'TASK-1': { type: 'ticket' },
        },
        edges: [],
    };
    const hits = matchFileNodes(graph, { classNames: ['CalculoFreteService'], fileMentions: [] });
    assert.deepStrictEqual([...hits.keys()], ['src/main/java/x/CalculoFreteService.java']);
});

test('ticketsForFile: só arestas touched_file, sem duplicar, sem prefixo TASK-', () => {
    const graph = {
        nodes: {},
        edges: [
            { from: 'TASK-1', rel: 'touched_file', to: 'a.java' },
            { from: 'TASK-1', rel: 'touched_file', to: 'a.java' },
            { from: 'TASK-2', rel: 'touched_file', to: 'a.java' },
            { from: 'TASK-3', rel: 'opened_pr', to: 'a.java' },
        ],
    };
    assert.deepStrictEqual(ticketsForFile(graph, 'a.java'), ['1', '2']);
});

// --- regras invioláveis ------------------------------------------------------------

test('readRegrasInvioláveis: quebra bullets multi-linha e para na próxima chave de nível 0', () => {
    const mainRepo = newRepo();
    writeProjectYaml(mainRepo,
        'regras_invioláveis:\n' +
        '  - "Regra A, continua\n' +
        '     na linha de baixo."\n' +
        '  - "Regra B."\n'
    );
    const regras = readRegrasInvioláveis(mainRepo);
    assert.strictEqual(regras.length, 2);
    assert.match(regras[0], /Regra A, continua na linha de baixo\./);
    assert.match(regras[1], /Regra B\./);
});

test('readRegrasInvioláveis: project.yaml ausente -> [] sem lançar', () => {
    assert.deepStrictEqual(readRegrasInvioláveis(newRepo()), []);
});

test('matchesRegra: casa classe com prefixo de convenção do projeto (F<Classe>) e por pacote br.com.mosistemas.app.*', () => {
    assert.strictEqual(matchesRegra('x/CalculoFreteService.java', 'usa FCalculoFreteService em algum lugar'), true);
    assert.strictEqual(
        matchesRegra('src/main/java/br/com/mosistemas/app/track/calculofrete/GrupoDTO.java', 'tudo em br.com.mosistemas.app.track.calculofrete é crítico'),
        true
    );
    assert.strictEqual(matchesRegra('x/OutraCoisa.java', 'nada a ver com isso'), false);
});

// --- patterns.md -------------------------------------------------------------------

test('parsePatterns: bloco completo casa; bloco sem keywords/padrao/recomendacao é descartado', () => {
    const text =
        '- keywords: endpoint, financeiro, fatura\n' +
        '  padrao: endpoint financeiro\n' +
        '  recomendacao: especificar tipo monetário nos critérios de aceite\n' +
        '  evidencia: identificado em 6/12 runs similares\n' +
        '- keywords: so isso\n';
    const patterns = parsePatterns(text);
    assert.strictEqual(patterns.length, 1);
    assert.deepStrictEqual(patterns[0].keywords, ['endpoint', 'financeiro', 'fatura']);
    assert.strictEqual(patterns[0].padrao, 'endpoint financeiro');
});

// --- upsertSection (idempotência) ---------------------------------------------------

test('upsertSection: insere no fim quando não há bloco ainda', () => {
    const out = upsertSection('# Spec\ncorpo\n', 'BLOCO');
    assert.match(out, /# Spec\ncorpo\n\nBLOCO\n$/);
});

test('upsertSection: rodar de novo substitui só o bloco entre os marcadores, nunca duplica', () => {
    const section1 = formatSection({ fileEntries: [{ fileId: 'a.java', regra: null, decisions: [], total: 1, ticketsSample: ['TASK-1'], retry: { reworked: 0, resolved: 0 } }], patterns: [] });
    const once = upsertSection('# Spec\ncorpo original\n', section1);
    assert.strictEqual((once.match(/Contexto Histórico/g) || []).length, 1);
    assert.match(once, /corpo original/);

    const section2 = formatSection({ fileEntries: [{ fileId: 'b.java', regra: null, decisions: [], total: 2, ticketsSample: ['TASK-2'], retry: { reworked: 0, resolved: 0 } }], patterns: [] });
    const twice = upsertSection(once, section2);
    assert.strictEqual((twice.match(/Contexto Histórico/g) || []).length, 1);
    assert.match(twice, /corpo original/); // resto do arquivo preservado
    assert.doesNotMatch(twice, /a\.java/); // bloco antigo saiu
    assert.match(twice, /b\.java/); // bloco novo entrou
});

test('upsertSection: section null remove o bloco existente sem tocar o resto', () => {
    const withBlock = `# Spec\ncorpo\n\n${CONTEXT_BEGIN}\nlixo\n${CONTEXT_END}\n`;
    const removed = upsertSection(withBlock, null);
    assert.doesNotMatch(removed, /CONTEXT_BEGIN|lixo/);
    assert.match(removed, /corpo/);
});

// --- enrichSpec: end-to-end ----------------------------------------------------------

test('enrichSpec: spec sem nenhuma palavra-chave casada -> applied=false, arquivo intocado', () => {
    const mainRepo = newRepo();
    writeGraph(mainRepo);
    const specPath = writeSpec(mainRepo, 'spec-vazia', '## Problema\nAlgo genérico sem classe nenhuma.\n');
    const before = fs.readFileSync(specPath, 'utf8');
    const r = enrichSpec(specPath, 'x', { mainRepo });
    assert.strictEqual(r.applied, false);
    assert.strictEqual(fs.readFileSync(specPath, 'utf8'), before);
});

test('enrichSpec: memory/knowledge-graph.json ausente -> applied=false com motivo, nunca lança', () => {
    const mainRepo = newRepo();
    const specPath = writeSpec(mainRepo, 'spec', '## Problema\nAjustar FooService.\n');
    const r = enrichSpec(specPath, 'x', { mainRepo });
    assert.strictEqual(r.applied, false);
    assert.match(r.reason, /nenhum arquivo ou padrão casado/); // KG ausente = readGraph devolve grafo vazio, não erro
});

test('enrichSpec: spec.md inexistente -> applied=false, nunca lança', () => {
    const mainRepo = newRepo();
    const r = enrichSpec(path.join(mainRepo, 'nao-existe.md'), 'x', { mainRepo });
    assert.strictEqual(r.applied, false);
    assert.match(r.reason, /ilegível/);
});

test('enrichSpec: CalculoFreteService com histórico no KG -> aviso de regra inviolável + histórico + retry rate', () => {
    const mainRepo = newRepo();
    const fileId = 'src/main/java/br/com/mosistemas/app/track/calculofrete/CalculoFreteService.java';
    writeProjectYaml(mainRepo,
        'regras_invioláveis:\n' +
        '  - "O motor de cálculo de frete (br.com.mosistemas.app.track.calculofrete e\n' +
        '     serviços correlatos, ex: FCalculoFreteService) é legado crítico."\n'
    );
    writeGraph(mainRepo, {
        nodes: { 'TASK-41200': { type: 'ticket' }, 'TASK-38291': { type: 'ticket' }, [fileId]: { type: 'file' } },
        edges: [
            { from: 'TASK-41200', rel: 'touched_file', to: fileId },
            { from: 'TASK-38291', rel: 'touched_file', to: fileId },
        ],
    });
    // 41200 precisou de 2 implements (retrabalho); 38291 rodou limpo.
    writeRun(mainRepo, '41200', null, { history: ['plan', 'implement', 'review', 'implement', 'review', 'test', 'verify', 'commit'] });
    writeRun(mainRepo, '38291', null, { history: ['plan', 'implement', 'review', 'test', 'verify', 'commit'] });

    const specPath = writeSpec(mainRepo, 'spec', '## Problema\nAjustar o CalculoFreteService para novo cenário de rateio.\n');
    const r = enrichSpec(specPath, '99999-nova-task', { mainRepo });
    assert.strictEqual(r.applied, true);
    assert.strictEqual(r.filesMatched, 1);

    const out = fs.readFileSync(specPath, 'utf8');
    assert.match(out, /⚠️ REGRA INVIOLÁVEL/);
    assert.match(out, /legado crítico/);
    assert.match(out, /Tocado em 2 run\(s\) anterior\(es\) \(TASK-41200, TASK-38291\)/);
    assert.match(out, /Taxa de retry: 50% \(1\/2 precisaram de re-implement\)/);
});

test('enrichSpec: arquivo tocado sem regra inviolável -> histórico sem o aviso', () => {
    const mainRepo = newRepo();
    const fileId = 'src/main/java/x/FooResource.java';
    writeGraph(mainRepo, {
        nodes: { 'TASK-1': { type: 'ticket' }, [fileId]: { type: 'file' } },
        edges: [{ from: 'TASK-1', rel: 'touched_file', to: fileId }],
    });
    writeRun(mainRepo, '1', null, { history: ['plan', 'implement', 'review', 'test', 'verify', 'commit'] });
    const specPath = writeSpec(mainRepo, 'spec', '## Problema\nAjustar FooResource.\n');
    const r = enrichSpec(specPath, 'x', { mainRepo });
    assert.strictEqual(r.applied, true);
    const out = fs.readFileSync(specPath, 'utf8');
    assert.doesNotMatch(out, /REGRA INVIOLÁVEL/);
    assert.match(out, /Tocado em 1 run\(s\) anterior\(es\)/);
});

test('enrichSpec: mais de uma run pro mesmo ticket conta como retrabalho (ex.: Recusa QA)', () => {
    const mainRepo = newRepo();
    const fileId = 'src/main/java/x/BarService.java';
    writeGraph(mainRepo, {
        nodes: { 'TASK-7': { type: 'ticket' }, [fileId]: { type: 'file' } },
        edges: [{ from: 'TASK-7', rel: 'touched_file', to: fileId }],
    });
    writeRun(mainRepo, '7', 'ciclo-1', { history: ['plan', 'implement', 'review', 'test', 'verify', 'commit'] });
    writeRun(mainRepo, '7', 'recusa-qa', { history: ['plan', 'implement', 'review', 'test', 'verify', 'commit'] });
    const specPath = writeSpec(mainRepo, 'spec', '## Problema\nAjustar BarService.\n');
    enrichSpec(specPath, 'x', { mainRepo });
    const out = fs.readFileSync(specPath, 'utf8');
    assert.match(out, /Taxa de retry: 100% \(1\/1 precisaram de re-implement\)/);
});

test('enrichSpec: ticket sem run localizável entra no total mas não no denominador de retry', () => {
    const mainRepo = newRepo();
    const fileId = 'src/main/java/x/BazService.java';
    writeGraph(mainRepo, {
        nodes: { 'TASK-9': { type: 'ticket' }, [fileId]: { type: 'file' } },
        edges: [{ from: 'TASK-9', rel: 'touched_file', to: fileId }],
    });
    // Sem memory/runs/9*/state.json de propósito.
    const specPath = writeSpec(mainRepo, 'spec', '## Problema\nAjustar BazService.\n');
    enrichSpec(specPath, 'x', { mainRepo });
    const out = fs.readFileSync(specPath, 'utf8');
    assert.match(out, /Tocado em 1 run\(s\) anterior\(es\) \(TASK-9\)/);
    assert.doesNotMatch(out, /Taxa de retry/); // resolved=0 -> não reporta percentual inventado
});

test('enrichSpec: patterns.md ausente -> não falha, seção sem "Padrões Aplicáveis"', () => {
    const mainRepo = newRepo();
    const fileId = 'src/main/java/x/QuxService.java';
    writeGraph(mainRepo, {
        nodes: { 'TASK-1': { type: 'ticket' }, [fileId]: { type: 'file' } },
        edges: [{ from: 'TASK-1', rel: 'touched_file', to: fileId }],
    });
    const specPath = writeSpec(mainRepo, 'spec', '## Problema\nAjustar QuxService.\n');
    const r = enrichSpec(specPath, 'x', { mainRepo });
    assert.strictEqual(r.applied, true);
    assert.strictEqual(r.patternsMatched, 0);
    assert.doesNotMatch(fs.readFileSync(specPath, 'utf8'), /Padrões Aplicáveis/);
});

test('enrichSpec: patterns.md presente e keyword casa no texto da spec -> seção "Padrões Aplicáveis"', () => {
    const mainRepo = newRepo();
    writeGraph(mainRepo);
    fs.writeFileSync(path.join(mainRepo, 'memory', 'patterns.md'),
        '- keywords: endpoint, financeiro, fatura\n' +
        '  padrao: endpoint financeiro\n' +
        '  recomendacao: especificar tipo monetário nos critérios de aceite\n' +
        '  evidencia: identificado em 6/12 runs similares\n'
    );
    const specPath = writeSpec(mainRepo, 'spec', '## Problema\nNovo endpoint de fatura para o financeiro.\n');
    const r = enrichSpec(specPath, 'x', { mainRepo });
    assert.strictEqual(r.applied, true);
    assert.strictEqual(r.patternsMatched, 1);
    const out = fs.readFileSync(specPath, 'utf8');
    assert.match(out, /\*\*endpoint financeiro\*\* → especificar tipo monetário nos critérios de aceite \(identificado em 6\/12 runs similares\)/);
});

test('enrichSpec: rodar duas vezes na mesma spec não duplica a seção (idempotência ponta a ponta)', () => {
    const mainRepo = newRepo();
    const fileId = 'src/main/java/x/QuuxService.java';
    writeGraph(mainRepo, {
        nodes: { 'TASK-1': { type: 'ticket' }, [fileId]: { type: 'file' } },
        edges: [{ from: 'TASK-1', rel: 'touched_file', to: fileId }],
    });
    const specPath = writeSpec(mainRepo, 'spec', '## Problema\nAjustar QuuxService.\n');
    enrichSpec(specPath, 'x', { mainRepo });
    enrichSpec(specPath, 'x', { mainRepo });
    const out = fs.readFileSync(specPath, 'utf8');
    assert.strictEqual((out.match(/Contexto Histórico/g) || []).length, 1);
});

test('enrichSpec: nunca sinaliza a própria task como "run anterior" de si mesma', () => {
    const mainRepo = newRepo();
    const fileId = 'src/main/java/x/SelfService.java';
    // O próprio ticket desta run (43425) já aparece no KG (cenário de Recusa QA
    // reabrindo o ciclo) — não deve contar como histórico "anterior" dele mesmo.
    writeGraph(mainRepo, {
        nodes: { 'TASK-43425': { type: 'ticket' }, [fileId]: { type: 'file' } },
        edges: [{ from: 'TASK-43425', rel: 'touched_file', to: fileId }],
    });
    const specPath = writeSpec(mainRepo, 'spec', '## Problema\nAjustar SelfService.\n');
    const r = enrichSpec(specPath, '43425-recusa-qa', { mainRepo });
    assert.strictEqual(r.applied, false);
});
