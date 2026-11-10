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

test('lista do artboard Main: campo de filtro antes da ordenação e de Selecionar; Retrabalho com "loops"', () => {
    const M = boot().RunsMain;
    const head = M.headHtml([measured], '<div class="side-bar">SEL</div>');
    const iq = head.indexOf('id="runsQ"'), is = head.indexOf('rl-sort'), ib = head.indexOf('SEL');
    assert.ok(iq > 0 && iq < is && is < ib, 'ordem: filtro, ordenação, Selecionar');
    assert.match(head, /placeholder="Filtrar por ticket, título ou nó"/);
    assert.match(head, /Retrabalho por run<\/span><span class="kcard-row"><span class="kcard-value num">0<\/span><span class="kcard-delta tone-flat">loops</);
    // sem medição de retrabalho, sem a unidade solta
    assert.doesNotMatch(M.headHtml([bare], ''), /loops</);
});

test('matchQuery: ticket, título, task-id e nó (rótulo ou chave), sem acento e sem caixa', () => {
    const M = boot().RunsMain;
    const run = r('90218-exportacao', { node: 'implement' });
    for (const q of ['90218', 'título 90218', 'TITULO', 'implementa', 'implement', 'exportacao', '']) assert.equal(M.matchQuery(run, q), true, q);
    assert.equal(M.matchQuery(run, 'revisão'), false);
    M.setQuery('nada-casa');
    assert.equal(M.queryOf(), 'nada-casa');
    assert.equal(M.matchQuery(run), false);
});

test('rowWhere: "nó · detalhe" só com o que o state.json grava', () => {
    const M = boot().RunsMain;
    assert.equal(M.rowWhere(r('a', { node: 'review' }, { status: 'running', retries: { review: 1 } })), 'Revisão · rodando · tentativa 2 · 4/7');
    assert.equal(M.rowWhere(r('a', { node: 'plan' }, { status: 'in_progress' })), 'Plano · próximo nó · 2/7');
    assert.equal(M.rowWhere(r('a', { status: 'failed', node: 'test' })), 'Testes · falhou');
    assert.equal(M.rowWhere(r('a', { status: 'needs_human_review', node: 'implement' }, { status: 'spec-change-pending-approval' })), 'Implementação · SPEC_CHANGE aguardando você');
    assert.equal(M.rowWhere(r('a', { status: 'needs_human_review', node: 'commit', qaRejected: true })), 'Commit · recusa QA');
    assert.equal(M.rowWhere(bare), 'Commit · concluído');
    assert.equal(M.rowWhere(r('a', { status: 'pending', node: null })), 'na fila · aguardando slot');
});

test('rowWhen: "parado 4 min" / "parado 1 h 1 min" esperando você; relógio no nó com o agente rodando', () => {
    const M = boot().RunsMain;
    const t0 = Date.parse('2026-11-10T12:00:00Z');
    const at = min => new Date(t0 - min * 60000).toISOString();
    assert.deepEqual({ ...M.rowWhen(r('a', { status: 'needs_human_review', updatedAt: at(4) }), t0) }, { text: 'parado 4 min', tone: '', since: '' });
    assert.deepEqual({ ...M.rowWhen(r('a', { status: 'failed', updatedAt: at(61) }), t0) }, { text: 'parado 1 h 1 min', tone: 'waiting', since: '' });
    const live = r('a', { updatedAt: at(1) }, { status: 'running', node_started_at: new Date(t0 - 724000).toISOString() });
    assert.deepEqual({ ...M.rowWhen(live, t0) }, { text: '12:04 no nó', tone: 'running', since: live.state.node_started_at });
    assert.equal(M.rowWhen(bare, t0).text, 'há 1 hora'); // concluída: última atualização
});

// ux.js num vm com DOM mínimo: só o atalho global de dígitos interessa aqui.
function bootUx(view) {
    const el = () => ({ dataset: {}, hidden: false, classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
        addEventListener() {}, insertAdjacentHTML() {}, appendChild() {}, setAttribute() {}, removeAttribute() {}, closest: () => null, querySelector: () => null, querySelectorAll: () => [], focus() {}, set innerHTML(_v) {} });
    const keydown = [];
    const els = new Map();
    const calls = [];
    const ctx = {
        navigator: { platform: 'MacIntel' }, location: { hash: '', pathname: '/' }, history: { replaceState() {} },
        window: { addEventListener() {} }, prefs: {}, persist() {}, selected: null, selecting: false, runs: new Map(),
        $: id => { if (!els.has(id)) els.set(id, el()); return els.get(id); },
        document: { body: { ...el(), dataset: { view } }, activeElement: null, createElement: el, querySelector: () => el(), querySelectorAll: () => [],
            addEventListener(type, fn) { if (type === 'keydown') keydown.push(fn); } },
        Views: { setView: v => calls.push(v), openRun() {} }, renderDetail() {}, closeRun() {},
        isHidden: () => false, needsYou: () => false, isDone: () => false, NODE_LABEL: {}, STATUS: {}, titleOf: () => ({ num: '', text: '' }),
    };
    ctx.window.Views = ctx.Views;
    vm.createContext(ctx);
    vm.runInContext(fs.readFileSync(path.join(__dirname, 'public', 'ux.js'), 'utf8'), ctx, { filename: 'ux.js' });
    const press = key => { const e = { key, preventDefault() {}, stopImmediatePropagation() {} }; keydown.forEach(fn => fn(e)); };
    return { press, calls };
}

test('atalho de dígitos só na tela Runs: "3" em Tickets não vai para #tabela', () => {
    const tk = bootUx('redmine');
    tk.press('3');
    assert.deepEqual(tk.calls, []);
    for (const v of ['runs', 'quadro', 'timeline']) {
        const rn = bootUx(v);
        rn.press('3');
        assert.deepEqual(rn.calls, ['tabela'], v);
    }
});

test('footerHtml: watcher ativo · tick N, parado ou verificando; atalhos do artboard', () => {
    const M = boot().RunsMain;
    assert.match(M.footerHtml({ reachable: true, st: { running: true, ticks: 412 } }), /data-tone="on"><i aria-hidden="true"><\/i>watcher ativo · tick 412</);
    assert.match(M.footerHtml({ reachable: true, st: { running: false, state: 'stopped' } }), /watcher parado/);
    assert.match(M.footerHtml({ reachable: false, st: null }), /watcher sem conexão/);
    assert.match(M.footerHtml(null), /watcher: verificando/);
    assert.match(M.footerHtml(null), /K buscar · J K navegar · X selecionar · Esc fechar · V lista\/quadro\/linha do tempo/);
});
