// node --test graph-ui.test.js
// Lógica pura da tela "Knowledge Graph" (public/graph.js, artboard KnowledgeGraph): índice do grafo,
// vizinhança em anéis, caminho mais curto, relações do item em foco, busca e feed de ingestão.
// Só tipos com dado no knowledge-graph.json (ticket, spec, arquivo, PR); nada de nó inventado.
const test = require('node:test');
const assert = require('node:assert/strict');
const M = require('./public/graph');

const F1 = 'src/main/java/br/com/t/CalculoFreteService.java';
const F2 = 'app-core/src/main/java/br/com/t/Imposto.java';
const DATA = {
    nodes: {
        'TASK-90021': { type: 'ticket', ticket_id: 90021, title: 'Frete por faixa', tracker: 'Feature' },
        'TASK-90020': { type: 'ticket', ticket_id: 90020, title: 'Revalidar frete' },
        'memory/spec/90021-spec.md': { type: 'spec', task_id: 'TASK-90021' },
        'PR-app-back-8': { type: 'pr', repo: 'app-back', number: 8, status: 'open' },
        'PR-app-back-7': { type: 'pr', repo: 'app-back', number: 7, status: 'ALGO' },
        [F1]: { type: 'file', repo: 'app-back', lang: 'java' },
        [F2]: { type: 'file', repo: 'app-core', lang: 'java' },
        'X-1': { type: 'decisao' },
    },
    edges: [
        { from: 'TASK-90021', rel: 'generated_spec', to: 'memory/spec/90021-spec.md', at: '2026-11-09T10:00:00.000Z' },
        { from: 'TASK-90021', rel: 'touched_file', to: F1, at: '2026-11-09T11:00:00.000Z' },
        { from: 'TASK-90021', rel: 'opened_pr', to: 'PR-app-back-8', at: '2026-11-09T12:00:00.000Z' },
        { from: 'TASK-90020', rel: 'touched_file', to: F1, at: '2026-11-08T11:00:00.000Z' },
        { from: 'TASK-90020', rel: 'touched_file', to: F2 },
        { from: 'TASK-90020', rel: 'opened_pr', to: 'PR-app-back-7', at: 'não é data' },
        { from: 'TASK-90020', rel: 'depende_de', to: F2 },
        { from: 'TASK-90020', rel: 'touched_file', to: 'arquivo-sem-no' },
    ],
};
const ALL = { code: true, sdd: true, exec: true, ticket: true };

test('buildIndex: só tipos e relações conhecidos, pontas existentes; graus e tickets do mais novo', () => {
    const I = M.buildIndex(DATA);
    assert.equal(I.ents.length, 7, 'tipo desconhecido fica fora');
    assert.equal(I.rels.length, 6, 'relação desconhecida e ponta ausente ficam fora');
    assert.deepEqual(I.tickets.map(t => t.id), ['TASK-90021', 'TASK-90020']);
    assert.equal(I.deg[F1], 2);
    assert.equal(I.byId['TASK-90021'].name, '#90021');
    assert.equal(I.byId[F1].name, 'CalculoFreteService.java');
    assert.equal(I.byId[F2].sub, 'arquivo · app-core');
    assert.equal(I.byId['PR-app-back-8'].sub, 'PR · aberto');
    assert.equal(I.byId['PR-app-back-7'].sub, 'PR · estado desconhecido');
    assert.equal(I.byId['memory/spec/90021-spec.md'].sub, 'spec · #90021');
    assert.deepEqual(M.buildIndex(null).ents, []);
});

test('ego: foco no centro, 1º anel com os vizinhos e 2º anel pelo arquivo compartilhado', () => {
    const I = M.buildIndex(DATA);
    const g = M.ego(I, 'TASK-90021', 2, ALL, null);
    const ring = r => g.nodes.filter(n => n.ring === r).map(n => n.id).sort();
    assert.deepEqual(ring(0), ['TASK-90021']);
    assert.deepEqual(ring(1), [F1, 'PR-app-back-8', 'memory/spec/90021-spec.md'].sort());
    assert.deepEqual(ring(2), ['TASK-90020']);
    const center = g.nodes.find(n => n.ring === 0);
    assert.deepEqual([center.left, center.top, center.w, center.h], [334, 320, 212, 60]);
    assert.equal(g.edges.length, 4);
    assert.ok(g.labels.every(l => ['gerou', 'abriu', 'alterou'].includes(l.text)));
    assert.equal(g.showRing2, true);

    const one = M.ego(I, 'TASK-90021', 1, ALL, null);
    assert.equal(one.nodes.length, 4, 'um salto: sem 2º anel');
    assert.equal(one.nodes.find(n => n.id === F1).more, 1, '+1 ligação além do foco');
    assert.equal(one.showRing2, false);
});

test('ego: chip desligado esconde o tipo (menos o foco) e destaque esmaece quem não é vizinho', () => {
    const I = M.buildIndex(DATA);
    const g = M.ego(I, 'TASK-90021', 2, { ...ALL, code: false }, null);
    assert.ok(!g.nodes.some(n => n.e.t === 'file'));
    const f = M.ego(I, F1, 1, { ...ALL, code: false }, null);
    assert.equal(f.nodes.find(n => n.ring === 0).id, F1, 'foco aparece mesmo com o tipo desligado');
    const h = M.ego(I, 'TASK-90021', 1, ALL, 'PR-app-back-8');
    assert.equal(h.nodes.find(n => n.id === 'PR-app-back-8').hov, true);
    assert.equal(h.nodes.find(n => n.id === F1).dim, true);
    assert.equal(h.nodes.find(n => n.id === 'TASK-90021').dim, false);
});

test('shortestPath: ignora direção, devolve a cadeia; sem caminho = []', () => {
    const I = M.buildIndex(DATA);
    const chain = M.shortestPath(I, 'PR-app-back-8', F2);
    assert.deepEqual(chain.map(c => c.b), ['TASK-90021', F1, 'TASK-90020', F2]);
    assert.equal(chain[0].r.rel, 'opened_pr');
    assert.deepEqual(M.shortestPath(I, F1, F1), []);
    const iso = M.buildIndex({ nodes: { ...DATA.nodes, 'TASK-1': { type: 'ticket', ticket_id: 1 } }, edges: DATA.edges });
    assert.deepEqual(M.shortestPath(iso, 'TASK-1', F1), []);
});

test('relGroups: rótulo lido a partir do foco, na ordem do artboard, respeitando os chips', () => {
    const I = M.buildIndex(DATA);
    const r = M.relGroups(I, 'TASK-90021', ALL);
    assert.deepEqual(r.groups.map(g => g.title), ['Gerou', 'Abriu', 'Alterou']);
    assert.equal(r.total, 3);
    const f = M.relGroups(I, F1, ALL);
    assert.deepEqual(f.groups.map(g => [g.title, g.items]), [['Alterado por', ['TASK-90020', 'TASK-90021']]]);
    assert.equal(M.relGroups(I, F1, { ...ALL, ticket: false }).total, 0);
});

test('search: nome que começa com o termo primeiro, depois mais ligações; vazio = nada', () => {
    const I = M.buildIndex(DATA);
    assert.deepEqual(M.search(I, ''), []);
    assert.deepEqual(M.search(I, 'calc').map(e => e.id), [F1]);
    assert.equal(M.search(I, '#9002')[0].id, 'TASK-90020', 'empate no início: mais ligações vence');
    assert.equal(M.search(I, 'frete').length, 3);
});

test('feed: arestas com data, da mais nova; agoShort no formato curto do artboard', () => {
    const I = M.buildIndex(DATA);
    const f = M.feed(I);
    assert.deepEqual(f.map(e => e.text), [
        'PR app-back #8 ligado a #90021',
        'CalculoFreteService.java alterado por #90021',
        'spec 90021-spec.md gerada para #90021',
        'CalculoFreteService.java alterado por #90020',
    ]);
    const now = Date.parse('2026-11-09T12:00:00.000Z');
    assert.equal(M.agoShort('2026-11-09T11:59:52.000Z', now), 'há 8 s');
    assert.equal(M.agoShort('2026-11-09T11:58:00.000Z', now), 'há 2 min');
    assert.equal(M.agoShort('2026-11-09T09:00:00.000Z', now), 'há 3 h');
    assert.equal(M.agoShort('2026-11-05T12:00:00.000Z', now), 'há 4 d');
    assert.equal(M.agoShort('nada', now), '');
});
