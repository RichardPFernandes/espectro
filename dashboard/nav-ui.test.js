// node --test nav-ui.test.js
// Navegação lateral (design Espectro, AppNav) no harness de DOM do dashboard (vm, sem browser):
// grupos recolhíveis, estado em prefs.navClosed, grupo reaberto ao entrar numa visão e soma
// das pendências no grupo recolhido.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SRC = fs.readFileSync(path.join(__dirname, 'public', 'views.js'), 'utf8');

function element(id) {
    return {
        id, listeners: {}, dataset: {}, hidden: false, html: '', children: [],
        attributes: {}, classList: { add() {}, remove() {}, toggle() {} },
        setAttribute(n, v) { this.attributes[n] = String(v); }, removeAttribute(n) { delete this.attributes[n]; },
        append() {}, appendChild() {}, replaceChildren() {}, closest() { return null; }, scrollIntoView() {},
        addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); },
        querySelector() { return null; }, querySelectorAll() { return []; },
        focus() {},
        set innerHTML(v) { this.html = String(v); },
        get innerHTML() { return this.html; },
        set textContent(v) { this.text = String(v); },
        get textContent() { return this.text || ''; },
    };
}

function boot({ prefs = {}, waiting = 0 } = {}) {
    const els = new Map();
    const $ = id => { if (!els.has(id)) els.set(id, element(id)); return els.get(id); };
    const location = { hash: '', pathname: '/' };
    const runs = new Map(Array.from({ length: waiting }, (_, i) => [`t${i}`, { taskId: `t${i}` }]));
    let saved = 0;
    const context = {
        window: { addEventListener() {} }, location, prefs, selected: null, runs, NODES: [],
        visibleRuns: () => [], isHidden: () => false, needsYou: () => true,
        history: { replaceState(_s, _t, url) { location.hash = url.startsWith('#') ? url : ''; } },
        document: { head: element('head'), body: { dataset: {}, appendChild() {} }, activeElement: null, createElement: element },
        $, persist() { saved++; }, requestAnimationFrame: cb => setTimeout(cb, 0), setTimeout, clearTimeout, Date, URL,
        fetch: async () => ({ ok: false, json: async () => ({}) }), api: async () => ({}),
    };
    vm.createContext(context);
    vm.runInContext(SRC, context, { filename: 'views.js' });
    const tabs = () => $('tabs').innerHTML;
    // Fatia do HTML de um grupo: do botão do cabeçalho até o fim do seu tablist.
    const group = name => {
        const html = tabs();
        const at = html.indexOf(`data-nav-group="${name}"`);
        assert.ok(at >= 0, `grupo ${name} ausente`);
        return html.slice(at, html.indexOf('</div>', at));
    };
    const clickGroup = name => {
        const expanded = /aria-expanded="true"/.test(group(name));
        const btn = { dataset: { navGroup: name }, getAttribute: a => (a === 'aria-expanded' ? String(expanded) : null) };
        const target = { closest: sel => (sel === '[data-nav-group]' ? btn : null) };
        for (const fn of $('tabs').listeners.click) fn({ target });
    };
    return { context, tabs, group, clickGroup, setView: v => context.window.Views.setView(v), saved: () => saved };
}

test('nav: grupos na ordem das áreas do AppNav, com aria-controls e tablist por grupo', () => {
    const ui = boot();
    ui.setView('runs');
    const names = [...ui.tabs().matchAll(/data-nav-group="([^"]+)"/g)].map(m => m[1]);
    assert.deepEqual(names, ['Trabalho', 'Operação', 'Conhecimento', 'Agentes e modelos', 'Plataforma']);
    assert.match(ui.group('Agentes e modelos'), /aria-controls="nav-agentes-e-modelos"/);
    assert.match(ui.tabs(), /id="nav-agentes-e-modelos" role="tablist" aria-orientation="vertical"/);
    assert.match(ui.group('Agentes e modelos'), /data-view="roteamento"/);
    assert.match(ui.tabs(), /data-view="runs" aria-selected="true"/);
});

test('nav: recolher persiste em prefs.navClosed e esconde os itens; abrir de novo desfaz', () => {
    const ui = boot();
    ui.setView('runs');
    const before = ui.saved();
    ui.clickGroup('Plataforma');
    assert.equal(ui.context.prefs.navClosed['Plataforma'], true);
    assert.ok(ui.saved() > before);
    assert.match(ui.group('Plataforma'), /aria-expanded="false"/);
    assert.match(ui.tabs(), /id="nav-plataforma" role="tablist"[^>]* hidden>/);
    ui.clickGroup('Plataforma');
    assert.equal(ui.context.prefs.navClosed['Plataforma'], false);
    assert.match(ui.group('Plataforma'), /aria-expanded="true"/);
    assert.doesNotMatch(ui.tabs(), /id="nav-plataforma" role="tablist"[^>]* hidden>/);
});

test('nav: o grupo da visão atual também recolhe; entrar numa visão reabre o grupo dela', () => {
    const ui = boot();
    ui.setView('versao');
    ui.clickGroup('Plataforma');
    assert.match(ui.group('Plataforma'), /aria-expanded="false"/);
    ui.setView('runs');
    ui.setView('computador');
    assert.match(ui.group('Plataforma'), /aria-expanded="true"/);
    assert.equal(ui.context.prefs.navClosed['Plataforma'], undefined);
});

test('nav: na carga, o grupo da visão salva abre mesmo se estava recolhido', () => {
    const ui = boot({ prefs: { view: 'versao', navClosed: { Plataforma: true, Conhecimento: true } } });
    ui.setView('versao');
    assert.match(ui.group('Plataforma'), /aria-expanded="true"/);
    assert.match(ui.group('Conhecimento'), /aria-expanded="false"/);
});

test('nav: grupo recolhido mostra a soma do que pede você; aberto, a soma fica no item', () => {
    const ui = boot({ waiting: 2 });
    ui.setView('versao');
    assert.doesNotMatch(ui.group('Trabalho').split('</button>')[0], /nav-count/);
    ui.clickGroup('Trabalho');
    assert.match(ui.group('Trabalho').split('</button>')[0], /<span class="nav-count" title="2 pedem você">2<\/span>/);
    // grupo sem Runs não soma nada
    ui.clickGroup('Operação');
    assert.doesNotMatch(ui.group('Operação').split('</button>')[0], /nav-count/);
});

test('nav: repintura ao vivo devolve o foco ao cabeçalho de grupo que estava focado', () => {
    const ui = boot({ waiting: 1 });
    ui.setView('runs');
    const tabsEl = ui.context.$('tabs');
    let focusedSel = null;
    tabsEl.querySelector = sel => ({ focus() { focusedSel = sel; } });
    ui.context.document.activeElement = { closest: sel => (sel.endsWith('[data-nav-group]') ? { dataset: { navGroup: 'Plataforma' } } : null) };
    // muda o HTML (um run a mais pedindo você) como um evento ao vivo faria
    ui.context.runs.set('novo', { taskId: 'novo' });
    ui.context.window.Views.setView('runs');
    assert.equal(focusedSel, '[data-nav-group="Plataforma"]');
});
