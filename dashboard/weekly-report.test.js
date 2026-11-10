// node --test weekly-report.test.js
// Relatório semanal (public/weekly-report.js, PRI-327): janelas em Brasília, agregação, deltas,
// séries do gráfico e regra "sem medição" (null) nunca vira zero.
const test = require('node:test');
const assert = require('node:assert');
const W = require('./public/weekly-report');

const DAY = 86400000;
// Quarta-feira, 11/11/2026, 12:00 em Brasília (15:00 UTC).
const NOW = Date.parse('2026-11-11T15:00:00Z');
const NODES = [['fetch_ticket', 'Ticket'], ['plan', 'Plano'], ['implement', 'Implementação'], ['review', 'Revisão'], ['test', 'Testes'], ['verify', 'Verificação'], ['commit', 'Commit']];

function run(id, iso, { done = true, usd = 1, tokens = [900, 100], loops = 0, retries = {}, msgs = 0, pr = null, tracker = 'Defeito', ticket = id, nodes = null, status } = {}) {
    const state = { retries, human_inputs: Array.from({ length: msgs }, () => ({ content: 'x' })) };
    if (usd !== null) { // usd: null = run sem cost_tracking
        state.cost_tracking = {
            nodes: nodes || { plan: { input_tokens: tokens[0], output_tokens: tokens[1], duration_ms: 60000, runs: 1, cost_usd: usd, models: ['claude-sonnet-5-5'], also_covers: ['fetch_ticket'] } },
            totals: { input_tokens: tokens[0], output_tokens: tokens[1], loop_count: loops, cost_usd: usd },
        };
    }
    if (pr) state.pull_request = { id: pr.id, state: pr.state, url: `https://example.test/pr/${pr.id}` };
    return { taskId: `t${id}`, ticketId: ticket, updatedAt: iso, kind: done ? 'completed' : 'active', status: status || (done ? 'committed' : 'running'), location: 'main', ticket: { tracker }, state };
}
const env = (over = {}) => ({
    nodes: NODES,
    isDone: r => r.kind === 'completed',
    needsYou: r => r.status === 'awaiting_approval',
    prsOf: r => (r.state.pull_request ? [r.state.pull_request] : []),
    prState: (r, p) => p.state || '',
    prUpdatedOn: () => null,
    ticketStatus: () => undefined,
    ticketLabel: r => `#${r.ticketId}`,
    titleText: r => `Ticket ${r.ticketId}`,
    statusLabel: r => r.status,
    ...over,
});

test('weekStart: segunda 00:00 em Brasília, inclusive perto da virada do dia em UTC', () => {
    assert.strictEqual(new Date(W.weekStart(NOW)).toISOString(), '2026-11-09T03:00:00.000Z');
    // Domingo 23:30 em Brasília = segunda 02:30 UTC: ainda é a semana anterior.
    assert.strictEqual(new Date(W.weekStart(Date.parse('2026-11-16T02:30:00Z'))).toISOString(), '2026-11-09T03:00:00.000Z');
    assert.strictEqual(new Date(W.weekStart(Date.parse('2026-11-16T03:00:00Z'))).toISOString(), '2026-11-16T03:00:00.000Z');
});

test('windowOf e rangeLabel: semana atual, anterior e todos os runs', () => {
    const cur = W.windowOf('cur', NOW), prev = W.windowOf('prev', NOW), all = W.windowOf('all', NOW);
    assert.strictEqual(W.rangeLabel(cur.from, cur.to), '09–15/11/2026');
    assert.strictEqual(W.rangeLabel(prev.from, prev.to), '02–08/11/2026');
    assert.strictEqual(prev.prev.to, prev.from);
    assert.strictEqual(all.prev, null);
    assert.strictEqual(W.rangeLabel(Date.parse('2026-10-26T03:00:00Z'), Date.parse('2026-11-02T03:00:00Z')), '26/10–01/11/2026');
    assert.ok(W.inWindow({ updatedAt: null }, all));
    assert.ok(!W.inWindow({ updatedAt: null }, cur));
});

test('formatos: dinheiro e tokens no padrão do artboard; null vira "sem medição"', () => {
    assert.strictEqual(W.money(1234.5), 'US$ 1.234,50');
    assert.strictEqual(W.money(0.001), '< US$ 0,01');
    assert.strictEqual(W.money(0), 'US$ 0,00');
    assert.strictEqual(W.money(null), 'sem medição');
    assert.strictEqual(W.tok(21600000), '21,6 M');
    assert.strictEqual(W.tok(780400), '780 mil');
    assert.strictEqual(W.tok(null), 'sem medição');
    assert.strictEqual(W.msLabel(null), 'sem medição');
    assert.strictEqual(W.msLabel(65000), '1:05');
    assert.strictEqual(W.modelName('claude-sonnet-4-5-20250929'), 'Sonnet 4.5');
    assert.strictEqual(W.modelName('claude-opus-5-5'), 'Opus 5.5');
    assert.strictEqual(W.modelName('gpt-x'), 'gpt-x');
});

test('aggregate: tokens, custo e loops sem cost_tracking são null, não zero', () => {
    const a = W.aggregate([run(1, '2026-11-10T12:00:00Z', { usd: null })], env());
    assert.strictEqual(a.done, 1);
    assert.strictEqual(a.tokens, null);
    assert.strictEqual(a.cost, null);
    assert.strictEqual(a.avg, null);
    assert.strictEqual(a.rate, null);
    assert.strictEqual(a.msgs, 0);
});

test('aggregate: tickets fechados só com status consultado no Redmine', () => {
    const list = [run(1, '2026-11-10T12:00:00Z'), run(2, '2026-11-10T13:00:00Z'), run(3, '2026-11-10T14:00:00Z', { ticket: 1 })];
    assert.strictEqual(W.aggregate(list, env()).tickets, null);
    const st = { t1: 'Fechado', t2: 'Em andamento' };
    const a = W.aggregate(list, env({ ticketStatus: r => st[r.taskId] }));
    assert.strictEqual(a.tickets, 1);
    assert.strictEqual(a.ticketsTotal, 2); // ticket 1 aparece em dois runs e conta uma vez
    assert.strictEqual(W.aggregate([], env()).tickets, 0);
});

test('aggregate: PRs por estado, primeira passagem e taxa de loops', () => {
    const list = [
        run(1, '2026-11-10T12:00:00Z', { pr: { id: 1, state: 'MERGED' }, usd: 2, msgs: 2 }),
        run(2, '2026-11-10T12:00:00Z', { pr: { id: 2, state: 'OPEN' }, loops: 2, retries: { test: 1 } }),
        run(3, '2026-11-10T12:00:00Z', { pr: { id: 3 } }),
        run(4, '2026-11-10T12:00:00Z', { done: false, usd: 0.5 }),
    ];
    const a = W.aggregate(list, env());
    assert.deepStrictEqual(a.prCounts, { OPEN: 1, MERGED: 1, DECLINED: 0, SUPERSEDED: 0, '': 1 });
    assert.strictEqual(a.cost, 4.5);
    assert.strictEqual(a.avg, 4 / 3);
    assert.strictEqual(a.loops, 2);
    assert.strictEqual(a.rate, 2 / 3);
    assert.strictEqual(a.firstPass, 2 / 3);
    assert.strictEqual(a.msgs, 2);
    assert.strictEqual(a.tokens, 4000);
});

test('delta: texto e tom do artboard; sem comparação e sem medição', () => {
    const cnt = d => `${d > 0 ? '+' : '−'}${Math.abs(d)}`;
    assert.deepStrictEqual(W.delta(5, 3, true, cnt), { t: '▲ +2 contra a semana anterior', tone: 'good' });
    assert.deepStrictEqual(W.delta(5, 3, false, cnt), { t: '▲ +2 contra a semana anterior', tone: 'bad' });
    assert.deepStrictEqual(W.delta(3, 3, true, cnt), { t: '= igual à semana anterior', tone: 'muted' });
    assert.strictEqual(W.delta(1, 2, null, cnt).tone, 'neutral');
    assert.strictEqual(W.delta(1, null, true, cnt).t, 'semana anterior sem medição');
    assert.strictEqual(W.delta(null, 1, true, cnt, { field: 'cost_tracking' }).t, 'nenhum run com cost_tracking na janela');
    assert.match(W.delta(1, 2, true, cnt, { all: true }).t, /^sem comparação/);
});

test('buildReport: janela atual contra a anterior, sem misturar runs de fora', () => {
    const list = [
        run(1, '2026-11-10T12:00:00Z', { usd: 2, pr: { id: 1, state: 'MERGED' } }),
        run(2, '2026-11-11T12:00:00Z', { usd: 1 }),
        run(3, '2026-11-04T12:00:00Z', { usd: 4 }),
        run(4, '2026-11-12T12:00:00Z', { done: false, status: 'awaiting_approval', usd: 0.2 }),
    ];
    const M = W.buildReport(list, env(), { win: 'cur', now: NOW });
    assert.strictEqual(M.range, '09–15/11/2026');
    assert.strictEqual(M.cur.done, 2);
    assert.strictEqual(M.prev.done, 1);
    assert.strictEqual(M.k.runs.tone, 'good');
    assert.match(M.k.total.t, /^▼ −/);
    assert.strictEqual(M.highlights.length, 1);
    assert.strictEqual(M.highlights[0].pr, '#1');
    assert.strictEqual(M.gates.length, 1);
    assert.strictEqual(M.summary.length, 3);
    assert.match(M.summary[0], /^Todos os projetos concluiu 2 runs, 1 a mais que na semana anterior, mergeou 1 PR/);
    const P = W.buildReport(list, env(), { win: 'prev', now: NOW });
    assert.strictEqual(P.cur.done, 1);
    const A = W.buildReport(list, env(), { win: 'all', now: NOW });
    assert.strictEqual(A.prev, null);
    assert.match(A.k.runs.t, /^sem comparação/);
});

test('series: 7 dias da semana; dia que ainda não chegou fica sem valor (não zero)', () => {
    const list = [run(1, '2026-11-10T12:00:00Z', { usd: 2 }), run(2, '2026-11-10T13:00:00Z', { usd: 1, done: false })];
    const s = W.series(list, W.windowOf('cur', NOW), env(), NOW);
    assert.deepStrictEqual(s.map(x => x.label), ['seg 09', 'ter 10', 'qua 11', 'qui 12', 'sex 13', 'sáb 14', 'dom 15']);
    assert.deepStrictEqual(s[1], { label: 'ter 10', cost: 3, runs: 1 });
    assert.strictEqual(s[0].cost, 0);
    assert.strictEqual(s[3].cost, null);
    assert.strictEqual(s[3].future, true);
    const all = W.series(list.concat(run(3, '2026-10-20T12:00:00Z')), W.windowOf('all', NOW), env(), NOW);
    assert.strictEqual(all[0].label, '19–25/10');
    assert.strictEqual(all.length, 4);
});

test('ticks: escala redonda começando em zero', () => {
    assert.deepStrictEqual(W.ticks(7), [0, 2, 4, 6, 8]);
    assert.deepStrictEqual(W.ticks(0), [0, 1]);
    assert.deepStrictEqual(W.ticks(450), [0, 200, 400, 600]);
    // modo Runs: sem fração de run no eixo
    assert.deepStrictEqual(W.ticks(1, { integer: true }), [0, 1]);
    assert.deepStrictEqual(W.ticks(3, { integer: true }), [0, 1, 2, 3]);
});

test('nodeCosts, stageTokens e trackerCosts: barras, modelo e "incluído em Plano"', () => {
    const nodes = {
        plan: { input_tokens: 300, output_tokens: 100, cost_usd: 1, models: ['claude-sonnet-5-5'], also_covers: ['fetch_ticket'] },
        implement: { input_tokens: 500, output_tokens: 100, cost_usd: 3, models: ['claude-opus-5-5', 'claude-sonnet-5-5'] },
        review: { input_tokens: null, output_tokens: null, cost_usd: null, runs_without_tokens: 1 },
    };
    const list = [run(1, '2026-11-10T12:00:00Z', { nodes, usd: 4, tracker: 'Melhoria' }), run(2, '2026-11-10T12:00:00Z', { usd: 1, tracker: null })];
    const nc = W.nodeCosts(list, NODES);
    assert.deepStrictEqual(nc.map(x => x.name), ['plan', 'implement', 'review']);
    assert.strictEqual(nc[1].model, 'Opus 5.5 +1');
    assert.strictEqual(nc[1].w, 100);
    assert.strictEqual(nc[2].usd, null);
    const st = W.stageTokens(list, NODES);
    assert.strictEqual(st[0].v, null);
    assert.strictEqual(st[0].note, 'incluído em Plano');
    assert.strictEqual(st[1].v, 1400);
    assert.strictEqual(st[3].v, null);
    assert.strictEqual(st[6].note, 'o nó não gravou cost_tracking nesta janela');
    const ty = W.trackerCosts(list);
    assert.deepStrictEqual(ty.map(x => [x.name, x.usd, x.runs]), [['Melhoria', 4, 1], ['Sem tipo', 1, 1]]);
});

test('retryRows e openGates', () => {
    const list = [run(1, '2026-11-10T12:00:00Z', { retries: { test: 2, review: 1 } }), run(2, '2026-11-10T12:00:00Z', { retries: { test: 1, qa: 1 } })];
    assert.deepStrictEqual(W.retryRows(list, NODES).map(x => [x.name, x.loops]), [['review', 1], ['test', 3], ['qa', 1]]);
    const g = W.openGates([run(3, '2026-11-10T14:30:00Z', { done: false, status: 'awaiting_approval' })], env(), NOW);
    assert.strictEqual(g[0].age, 'aberto há 24 h 30');
});

test('buildLearning: KPIs contra o período anterior, 8 semanas e mediana por etapa', () => {
    const list = [
        run(1, '2026-11-10T12:00:00Z', { usd: 2 }),
        run(2, '2026-11-01T12:00:00Z', { usd: 1, retries: { plan: 1 }, pr: { id: 9, state: 'DECLINED' } }),
        run(3, '2026-09-25T12:00:00Z', { usd: 1 }),
    ];
    const L = W.buildLearning(list, env(), { period: '30', now: NOW });
    assert.strictEqual(L.kpis[0].value, '2');
    assert.match(L.kpis[0].t, /^↑ 1 vs período anterior/);
    assert.strictEqual(L.kpis[1].value, '50%');
    assert.strictEqual(L.kpis[3].value, '1');
    assert.strictEqual(L.weeks.length, 8);
    assert.strictEqual(L.weeks[7].label, 's46');
    assert.strictEqual(L.weeks[7].cost, 2);
    assert.strictEqual(L.weeks[0].label, 's39');
    assert.strictEqual(L.weeks[0].cost, 1);
    assert.strictEqual(L.weeks[1].cost, null);
    const plan = L.stages.find(s => s.node === 'plan');
    assert.strictEqual(plan.time, '1:00');
    assert.strictEqual(plan.retry, '50%');
    assert.strictEqual(L.stages.find(s => s.node === 'commit').time, 'sem medição');
    assert.strictEqual(W.buildLearning(list, env(), { period: 'all', now: NOW }).kpis[0].t, 'sem comparação');
});

test('parsePatterns e patternDots: formato fixo de memory/patterns.md', () => {
    const md = [
        '# Padrões Identificados', '', '## Padrões de Falha no Review',
        '- **Datas em UTC**: ocorreu em 3/8 run(s) revisado(s) (ex.: a, b)',
        '- **Sem exemplo**: ocorreu em 1/2 run(s) revisado(s)',
        '- Nenhuma reprovação de review registrada no histórico atual.',
        '', '## Runs de Alto Custo (loop_count > 1)', '- Runs tocando `frete/`: média 2.5 loops (4 run(s))',
        '<!-- metadata: generated_at=2026-11-10T00:00:00Z runs_analyzed=3 -->',
    ].join('\n');
    const p = W.parsePatterns(md);
    assert.deepStrictEqual(p.items.map(x => [x.kind, x.title, x.count, x.total]), [['review', 'Datas em UTC', 3, 8], ['review', 'Sem exemplo', 1, 2], ['cost', 'Runs tocando frete/', 4, null]]);
    assert.strictEqual(p.items[0].where, 'ex.: a, b');
    assert.strictEqual(p.items[2].where, 'média de 2,5 loops por run');
    assert.strictEqual(p.generatedAt, '2026-11-10T00:00:00Z');
    assert.deepStrictEqual(W.patternDots(p.items[0]), ['hit', 'hit', 'hit', 'rest', 'rest', 'rest', 'rest', 'rest']);
    assert.strictEqual(W.patternDots(p.items[2]).length, 4);
    assert.deepStrictEqual(W.parsePatterns('').items, []);
});

test('copyText: resumo copiável sem inventar número', () => {
    const M = W.buildReport([run(1, '2026-11-10T12:00:00Z', { usd: null })], env(), { win: 'cur', now: NOW });
    const t = W.copyText(M, '');
    assert.match(t, /^Relatório semanal do Espectro · 09–15\/11\/2026 · todos os projetos\n/);
    assert.match(t, /Tokens: sem medição/);
    assert.match(t, /Custo: sem medição/);
    assert.doesNotMatch(t, /US\$ 0,00/);
});

test('tickets: status vem do ticket, mesmo gravado no cache sob outro run', () => {
    const a = run(1, '2026-11-04T12:00:00Z', { ticket: 77 }), b = run(2, '2026-11-10T12:00:00Z', { ticket: 77 });
    const cache = { t1: 'Fechado' }; // loadAll guardou só o run A
    const byTicket = r => { for (const x of [a, b]) if (x.ticketId === r.ticketId && cache[x.taskId]) return cache[x.taskId]; return undefined; };
    const M = W.buildReport([a, b], env({ ticketKey: r => r.ticketId, ticketStatus: byTicket }), { win: 'cur', now: NOW });
    assert.strictEqual(M.cur.tickets, 1);
});

test('tickets: consulta parcial não compara e o resumo diz "ao menos"', () => {
    const list = [run(1, '2026-11-10T12:00:00Z'), run(2, '2026-11-10T12:00:00Z'), run(3, '2026-11-03T12:00:00Z')];
    const M = W.buildReport(list, env({ ticketStatus: r => ({ t1: 'Fechado', t3: 'Fechado' })[r.taskId] }), { win: 'cur', now: NOW });
    assert.strictEqual(M.cur.tickets, 1);
    assert.strictEqual(M.cur.ticketsPartial, true);
    assert.strictEqual(M.k.tickets.t, 'parcial: 1 de 2 tickets consultados no Redmine');
    assert.match(M.summary[0], /fechou ao menos 1 ticket \(1 de 2 consultados no Redmine\)/);
});

test('series: dia com run sem custo medido é null, não US$ 0,00', () => {
    const list = [run(1, '2026-11-09T12:00:00Z', { usd: null }), run(2, '2026-11-10T12:00:00Z', { usd: 1 }), run(3, '2026-11-10T13:00:00Z', { usd: null })];
    const s = W.series(list, W.windowOf('cur', NOW), env(), NOW);
    assert.strictEqual(s[0].cost, null);
    assert.strictEqual(s[1].cost, 1); // parcial: soma só o medido
});

test('primeira passagem: run sem cost_tracking não conta como aprovado de primeira', () => {
    const a = W.aggregate([run(1, '2026-11-10T12:00:00Z', { usd: null }), run(2, '2026-11-10T12:00:00Z', { usd: null })], env());
    assert.strictEqual(a.firstPass, null);
    const b = W.aggregate([run(1, '2026-11-10T12:00:00Z', { usd: null }), run(2, '2026-11-10T12:00:00Z', { loops: 1 }), run(3, '2026-11-10T12:00:00Z')], env());
    assert.strictEqual(b.firstPass, 1 / 2);
});

test('resumo sem semana anterior e delta de custo partindo de zero', () => {
    const M = W.buildReport([run(1, '2026-11-10T12:00:00Z', { usd: 1.5 }), run(2, '2026-11-04T12:00:00Z', { usd: 0 })], env(), { win: 'cur', now: NOW });
    assert.strictEqual(M.k.total.t, '▲ +US$ 1,50 (era US$ 0,00) contra a semana anterior');
    const A = W.buildReport([run(1, '2026-11-10T12:00:00Z', { usd: 1.5 })], env(), { win: 'all', now: NOW });
    assert.match(A.summary[0], /^Todos os projetos registrou 1 run concluído em 1 semana \(/);
    assert.match(A.summary[1], /^O custo foi de US\$ 1,50\. O custo médio por run concluído ficou em US\$ 1,50\.$/);
});

test('semana anterior sem loop_count: diz "sem medição"; média igual não vira "acima"', () => {
    const list = [run(1, '2026-11-10T12:00:00Z', { usd: 2, loops: 1 }), run(2, '2026-11-04T12:00:00Z', { usd: 2, nodes: {}, loops: undefined })];
    list[1].state.cost_tracking.totals.loop_count = undefined;
    const M = W.buildReport(list, env(), { win: 'cur', now: NOW });
    assert.strictEqual(M.k.rate.t, 'semana anterior sem medição');
    assert.match(M.summary[1], /igual aos US\$ 2,00 da semana anterior\.$/);
    assert.doesNotMatch(M.summary[1], /acima/);
});

test('escopo: rótulo do projeto no resumo e no texto copiado; "em N semanas" conta semanas de calendário', () => {
    const list = [run(1, '2026-11-10T12:00:00Z', { usd: 2 }), run(2, '2026-10-28T12:00:00Z', { usd: 1 })];
    const M = W.buildReport(list, env(), { win: 'cur', now: NOW, scopeLabel: 'app-back' });
    assert.strictEqual(M.scopeLabel, 'app-back');
    assert.match(M.summary[0], /^App-back concluiu 1 run, o mesmo número da semana anterior|^App-back concluiu 1 run, 1 a mais que na semana anterior/);
    assert.match(W.copyText(M, M.scopeLabel), /^Relatório semanal do Espectro · 09–15\/11\/2026 · app-back\n/);
    const A = W.buildReport(list, env(), { win: 'all', now: NOW, scopeLabel: 'app-back' });
    assert.match(A.summary[0], /^App-back registrou 2 runs concluídos em 3 semanas \(28\/10–10\/11\/2026\)/);
    assert.match(W.copyText(A, ''), /· todos os runs · app-back\n/);
});

test('projectCosts: participação no total medido e média por run concluído; run sem custo fica fora', () => {
    const a = run(1, '2026-11-10T12:00:00Z', { usd: 3 }), b = run(2, '2026-11-10T12:00:00Z', { usd: 1 });
    const c = run(3, '2026-11-10T12:00:00Z', { usd: 2, done: false }), d = run(4, '2026-11-10T12:00:00Z', { usd: null });
    b.location = 'app-front'; c.location = 'app-front';
    const rows = W.projectCosts([a, b, c, d], env());
    assert.deepStrictEqual(rows.map(x => [x.name, x.usd, x.runs, x.avg, x.w]), [['main', 3, 1, 3, 50], ['app-front', 3, 2, 1, 50]]);
    assert.deepStrictEqual(W.projectCosts([d], env()), []);
    const M = W.buildReport([a, b], env(), { win: 'cur', now: NOW });
    assert.strictEqual(M.projects.length, 2);
});

test('captureLabel e sinceLabel: hora de Brasília e "há N s/min/h"', () => {
    assert.strictEqual(W.captureLabel(Date.parse('2026-10-27T17:56:00Z')), '27/10, 14:56');
    assert.strictEqual(W.sinceLabel(2400), '2 s');
    assert.strictEqual(W.sinceLabel(-5), '0 s');
    assert.strictEqual(W.sinceLabel(125000), '2 min');
    assert.strictEqual(W.sinceLabel(7300000), '2 h');
});
