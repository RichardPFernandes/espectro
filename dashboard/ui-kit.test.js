// node --test ui-kit.test.js
// Padrões de tela do design (public/ui-kit.js): HTML gerado, escape e navegação J/K.
const test = require('node:test');
const assert = require('node:assert');
const UI = require('./public/ui-kit');

test('esc: escapa os cinco caracteres de HTML e trata null', () => {
    assert.strictEqual(UI.esc(`<a href="x">'&'</a>`), '&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;');
    assert.strictEqual(UI.esc(null), '');
});

test('sparkPoints: normaliza no viewBox 100×32 e recusa série curta', () => {
    assert.strictEqual(UI.sparkPoints([]), null);
    assert.strictEqual(UI.sparkPoints([5]), null);
    assert.strictEqual(UI.sparkPoints([1, 'x', NaN]), null);
    assert.deepStrictEqual(UI.sparkPoints([0, 10]), [[0, 30], [100, 2]]);
    // série constante fica numa linha só, sem dividir por zero
    assert.deepStrictEqual(UI.sparkPoints([3, 3, 3]).map(p => p[1]), [30, 30, 30]);
});

test('spark: sem série não desenha; com série tem rótulo e tom', () => {
    assert.strictEqual(UI.spark([1]), '');
    const svg = UI.spark([1, 2, 3], { label: 'Custo <7d>', tone: 'up' });
    assert.match(svg, /role="img" aria-label="Custo &lt;7d&gt;"/);
    assert.match(svg, /class="spark spark-up"/);
    assert.match(UI.spark([1, 2], { tone: 'inventado' }), /spark-flat/);
});

test('kcard: aria-pressed, fonte no title, sem sparkline quando não há série', () => {
    const on = UI.kcard({ key: 'waiting', label: 'Pedem você', value: 3, source: 'state.json', tip: 'Runs parados', pressed: true, series: [1, 2, 3], hint: 'filtrando' });
    assert.match(on, /data-kcard="waiting" aria-pressed="true" title="Runs parados · Fonte: state.json"/);
    assert.match(on, /<svg class="spark/);
    assert.match(on, /class="kcard-hint">filtrando</);
    const off = UI.kcard({ key: 'k', label: 'L', value: '<b>' });
    assert.match(off, /class="kcard no-spark"/);
    assert.match(off, /aria-pressed="false"/);
    assert.match(off, /&lt;b&gt;/);
    assert.doesNotMatch(off, /title=/);
});

test('bulkBar: some sem seleção; singular e plural', () => {
    assert.strictEqual(UI.bulkBar({ count: 0 }), '');
    assert.match(UI.bulkBar({ count: 1 }), /role="toolbar" aria-label="Ações em lote".*1 selecionado</);
    assert.match(UI.bulkBar({ count: 4, hint: 'só os seus', actionsHtml: '<button>X</button>' }), /4 selecionados<\/span><span class="bulk-hint">só os seus<\/span><button>X<\/button>/);
});

test('filterChip e drawerClose: rótulos acessíveis e data-act', () => {
    assert.match(UI.filterChip({ label: 'Pedem você', act: 'clear' }), /data-act="clear" aria-label="Remover filtro do card"/);
    assert.match(UI.drawerClose(), /data-act="close-detail" aria-label="Fechar o detalhe \(Esc\)"/);
});

test('statusbar: rodapé mono com estado (role=status) e atalhos à direita, texto escapado', () => {
    assert.strictEqual(UI.statusbar({ left: '3 PRs <nesta aba>', keys: 'J K navegar' }),
        '<footer class="statusbar"><span role="status">3 PRs &lt;nesta aba&gt;</span><span class="statusbar-keys">J K navegar</span></footer>');
    assert.strictEqual(UI.statusbar({ left: 'só estado' }), '<footer class="statusbar"><span role="status">só estado</span></footer>');
});

test('step: J/K presos às pontas; sem foco começa na ponta certa', () => {
    assert.strictEqual(UI.step(-1, 1, 3), 0);
    assert.strictEqual(UI.step(-1, -1, 3), 2);
    assert.strictEqual(UI.step(0, -1, 3), 0);
    assert.strictEqual(UI.step(2, 1, 3), 2);
    assert.strictEqual(UI.step(1, 1, 3), 2);
    assert.strictEqual(UI.step(0, 1, 0), -1);
});
