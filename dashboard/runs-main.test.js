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
