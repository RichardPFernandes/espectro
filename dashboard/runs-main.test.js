// node --test runs-main.test.js
// HTML da tela Runs (runs-main.js) com os globais do script principal simulados: filtros por estado
// e por kcard, e "sem medição" (nunca 0) onde o run não tem cost_tracking.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function boot(prefs = {}) {
    const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const ctx = {
        prefs, esc, Date, Math, JSON, Number, String, Array, Object, Set, Map,
        NODES: [['fetch_ticket', 'Ticket'], ['plan', 'Plano'], ['implement', 'Implementação'], ['review', 'Revisão'], ['test', 'Testes'], ['verify', 'Verificação'], ['commit', 'Commit']],
        NODE_LABEL: { fetch_ticket: 'Ticket', plan: 'Plano', implement: 'Implementação', review: 'Revisão', test: 'Testes', verify: 'Verificação', commit: 'Commit' },
        STATUS: { running: 'Em andamento', needs_human_review: 'Precisa de você', committed: 'Concluído', pending: 'Planejado' },
        ago: () => 'há 1 hora', when: () => '09/11, 12:00', titleOf: r => ({ num: `#${r.taskId}`, text: `Título ${r.taskId}` }),
        explanation: () => ({ title: 'Próximo passo: Revisão.', body: 'corpo' }), extractPrs: () => [], isHighRisk: () => false,
        fmtUsd: v => `US$ ${v}`, fmtTok: v => `${v} tok`, fmtMs: v => `${v} ms`,
    };
    ctx.window = ctx;
    vm.createContext(ctx);
    for (const f of ['run-list-model.js', 'ui-kit.js', 'runs-main.js']) {
        vm.runInContext(fs.readFileSync(path.join(__dirname, 'public', f), 'utf8'), ctx, { filename: f });
    }
    return ctx;
}
const now = new Date().toISOString();
const r = (id, over = {}, state = {}) => ({ taskId: id, status: 'running', kind: 'active', node: 'review', nodes: {}, updatedAt: now, ...over, state: { started_at: now, ...state } });
const measured = r('a', {}, { cost_tracking: { nodes: { plan: { cost_usd: 3, input_tokens: 10, output_tokens: 1, duration_ms: 1000 } }, totals: { cost_usd: 3, input_tokens: 10, output_tokens: 1, duration_ms: 1000, loop_count: 0 } }, retries: {} });
const bare = r('b', { status: 'committed', kind: 'completed' });

test('applyFilters: filtro por estado e filtro do kcard; pref inválida vale "todas"', () => {
    const all = [measured, bare];
    assert.deepEqual(boot({ runsFilter: 'done' }).RunsMain.applyFilters(all, all).map(x => x.taskId), ['b']);
    assert.deepEqual(boot({ runsFilter: 'run' }).RunsMain.applyFilters(all, all).map(x => x.taskId), ['a']);
    assert.deepEqual(boot({ runsFilter: 'xyz', runsKf: 'xyz' }).RunsMain.applyFilters(all, all).map(x => x.taskId), ['a', 'b']);
    assert.deepEqual(boot({ runsKf: 'tokens' }).RunsMain.applyFilters(all, all).map(x => x.taskId), ['a']);
    const html = boot({ runsFilter: 'done' }).RunsMain.stateFilterHtml(all);
    assert.match(html, /data-runs-filter="done" aria-pressed="true">Concluídas<span class="num rl-count">1</);
});

test('sem medição, nunca zero: kcards, painel da run e cabeçalho do detalhe', () => {
    const M = boot().RunsMain;
    const head = M.headHtml([bare], '');
    assert.match(head, /Custo médio por run<\/span><span class="kcard-row"><span class="kcard-value num">sem medição/);
    assert.doesNotMatch(head, /rl-nodecost/); // nada medido: a barra de custo por nó não aparece
    const sum = M.summaryHtml(bare);
    assert.match(sum, /Custo até agora<\/span><b class="num">sem medição/);
    assert.doesNotMatch(sum, /US\$ 0\b/);
    assert.doesNotMatch(M.detailHeadHtml(bare), /rd-totals/);
    assert.match(M.detailHeadHtml(measured), /US\$ 3/);
    // nó sem custo gravado na janela: "sem medição" na legenda, não 0%
    assert.match(M.headHtml([measured], ''), /Commit sem medição/);
});

test('detalhe (RunDetail): pipeline com nome do nó em mono, estado por extenso e "—" no pendente', () => {
    const M = boot().RunsMain;
    const waiting = r('w', { status: 'awaiting_approval', node: 'implement', nodes: { fetch_ticket: 'done', plan: 'done' } });
    const html = M.pipelineHtml(waiting, 'lg');
    assert.match(html, /class="pl-name" title="fetch-ticket">fetch-ticket/);
    assert.match(html, /pl-node waiting reached">[\s\S]*?<span class="pl-state">Aguardando você</);
    assert.match(html, /pl-node done reached next-reached/); // plan → implement alcançado: linha contínua
    assert.match(html, /<span class="pl-state">Pendente<\/span>\s*<span class="pl-meta">—</);
    assert.doesNotMatch(M.pipelineHtml(waiting, 'sm'), /pl-state/);
});

test('detalhe: cabeçalho numa linha (selos vão para a faixa), faixa de parada e rodapé de status', () => {
    const M = boot().RunsMain;
    const head = M.detailHeadHtml(measured);
    assert.match(head, /<span>Trabalho<\/span><span aria-hidden="true">›<\/span><button type="button" class="rd-back" data-run-back>Runs/);
    assert.doesNotMatch(head, /rd-badges/);
    const stop = { node: 'implement', since: '4 min', title: 'Pediu decisão.', tab: 'summary', link: 'Ver detalhes do gate', actions: '<button data-band-approval="approve">A</button>' };
    const band = M.detailBandHtml(measured, stop, {}, { badges: '<span class="x">selo</span>' });
    assert.match(band, /<span class="rd-badges"><span class="x">selo<\/span><\/span>/);
    assert.match(band, /<strong class="num">Parado em implement há 4 min\.<\/strong> Pediu decisão\./);
    assert.match(band, /data-band-approval="approve"[\s\S]*data-dtab-go="summary">Ver detalhes do gate/);
    const groups = [{ n: 1, label: 'Resumo', tabs: [{ id: 'summary', label: 'Resumo' }] }, { n: 2, label: 'Custos', tabs: [{ id: 'costs', label: 'Custos' }] }];
    assert.match(M.statusBarHtml(groups, 'costs', stop), /Aba: Custos · 2 de 2 · parado em implement há 4 min<\/span><span class="rd-status-keys">J K abas · 1–2 grupos · Esc volta ao Resumo/);
    assert.match(M.statusBarHtml(groups, 'summary', null), />Aba: Resumo · 1 de 2</);
});

test('detalhe: abas com contagem só quando há dado; aba ativa marcada', () => {
    const M = boot().RunsMain;
    const groups = [{ n: 1, label: 'Resumo', tabs: [{ id: 'summary', label: 'Resumo' }, { id: 'log', label: 'Log do agente' }] }];
    const nav = M.sideNavHtml(groups, 'log', { log: { text: '● ao vivo', tone: 'done' }, summary: null });
    assert.match(nav, /data-rd-tab="log" aria-current="true"><span class="rd-tab-l">Log do agente<\/span><span class="rd-tab-c done">● ao vivo</);
    assert.match(nav, /data-rd-tab="summary" aria-current="false"><span class="rd-tab-l">Resumo<\/span><\/button>/);
});
