// node --test routing-ui.test.js
// Tela Roteamento no layout do artboard ModelRouting (PRI-328; antes T5–T7b), no harness de DOM do
// dashboard (vm, sem browser). O /api/routing é servido com fixtures: o contrato da API
// é testado em routing-api.test.js; aqui só a renderização dos estados.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const vm = require('node:vm');

function element(tag = 'div') {
    return {
        tag, children: [], attributes: {}, listeners: {}, dataset: {}, className: '', textContent: '',
        disabled: false, type: '', title: '', hidden: false, scrollTop: 0, html: '', tabIndex: 0,
        classList: { add() {}, remove() {} },
        append(...kids) { this.children.push(...kids.map(k => (typeof k === 'string' ? { textContent: k, children: [] } : k))); },
        setAttribute(name, value) { this.attributes[name] = String(value); },
        getAttribute(name) { return this.attributes[name]; },
        addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); },
        click() { if (!this.disabled) for (const fn of this.listeners.click || []) fn({ target: this }); },
        replaceChildren(...kids) { this.children = kids; },
        querySelector() { return null; },
        closest() { return null; },
        focus() {},
        scrollIntoView() {},
        set innerHTML(value) { this.html = String(value); },
        get innerHTML() { return this.html; },
    };
}
function walk(node, out = []) {
    if (!node || typeof node !== 'object') return out;
    out.push(node);
    for (const child of node.children || []) walk(child, out);
    return out;
}
function flatText(node) {
    if (typeof node === 'string') return node;
    if (!node || typeof node !== 'object') return '';
    return `${node.textContent || ''} ${(node.children || []).map(flatText).join(' ')}`;
}
async function until(fn, ms = 4000) {
    const start = Date.now();
    while (Date.now() - start < ms) {
        if (fn()) return;
        await new Promise(resolve => setTimeout(resolve, 20));
    }
    throw new Error('timeout esperando a view Roteamento');
}

const SHA = '02923a43' + 'a'.repeat(56);
const P1 = {
    id: 'routing-pri205', version: 'p1-2026-11-06', sha256: SHA, sha_short: '02923a43', status: 'APROVADA',
    approval: { by: 'Richard Fernandes', at: '2026-11-06' }, classifier_provider: 'cheap_rule',
    classes: [
        { class: 'C1', tier: 'T1', effort: 'baixo', models: ['claude-sonnet-5-5'] },
        { class: 'C2', tier: 'T2', effort: 'médio', models: ['claude-sonnet-5-5'] },
        { class: 'C3', tier: 'T3', effort: 'alto', models: ['claude-opus-5-5'] },
        { class: 'C4', tier: 'T3', effort: 'alto', models: ['claude-opus-5-5'] },
        { class: 'C5', tier: 'T3', effort: 'máximo', models: ['claude-opus-5-5'] },
    ],
    default_route: { model_id: 'claude-opus-5-5', effort: 'alto', tier: 'T3' },
    effort_applied: false,
};
const ON_RUN = {
    task_id: '9101-roteada', ticket_id: 9101, mode: 'ON', updated_at: '2026-11-06T12:00:00.000Z',
    snapshot: { attempt_id: 'x', sha256: 'c'.repeat(64), sha_short: 'cccccccc', integrity: 'ok', policy_ref: { id: 'routing-pri205', version: 'p1-2026-11-06', sha256: SHA, sha_short: '02923a43' } },
    policy_drift: { status: 'DIFFERENT', current_mode: 'ON', current: { id: 'routing-pri205', version: 'p2-2026-12-01', sha_short: 'ffffffff' } },
    selection_sources: { RULES: 1, FIXED_NODE: 1 }, decisions_total: 2, attempts_without_decision: 0,
    overrides: [{ ref: 'RO-1', scope: 'node', node: 'implement', subtask_key: null, value: { model_id: 'claude-opus-5-5', effort: 'alto' }, by: 'Richard', recorded_at: '2026-11-06T11:00:00.000Z', status: 'NOT_APPLIED' }],
    models: [
        { node: 'implement', attempt_id: 'a1', requested_model: 'claude-sonnet-5-5', requested_effort: 'UNAVAILABLE', routed: true, selection_source: 'RULES', observed_main: ['claude-sonnet-5-5'], observed_subagent: [], cost_usd: 0.5, unpriced_models: [], mismatch: false },
        { node: 'review', attempt_id: 'a2', requested_model: 'claude-opus-5-5', requested_effort: 'UNAVAILABLE', routed: true, selection_source: 'FIXED_NODE', observed_main: ['claude-sonnet-5-5'], observed_subagent: [], cost_usd: null, unpriced_models: ['claude-opus-5-5'], mismatch: true },
    ],
    not_started: [],
};
const BLOCKED_RUN = {
    ...ON_RUN, task_id: '9103-bloqueada', ticket_id: 9103, overrides: [], policy_drift: { status: 'SAME', current_mode: 'ON', current: null },
    not_started: [{ attempt_id: 'n1', node: 'implement', cause: 'CONFIG_UNVERIFIABLE', detail: 'PLUGIN_NOT_PROVEN_OFF', at: '2026-11-06T12:30:00.000Z', class: 'C2', would_model: 'claude-sonnet-5-5' }],
};
const OFF_RUN = { task_id: '9102-off', ticket_id: 9102, mode: 'OFF', snapshot: null, policy_drift: null, selection_sources: null, decisions_total: null, attempts_without_decision: null, overrides: [], models: [], not_started: null, updated_at: '2026-11-06T10:00:00.000Z' };
const UNKNOWN_RUN = { task_id: '9104-ruim', ticket_id: 9104, mode: 'UNKNOWN', error: 'STATE_UNREADABLE', updated_at: null };

function body(overrides = {}) {
    return {
        generated_at: '2026-11-06T13:00:00.000Z', reader: 'OK',
        config: { mode: 'ON', source: 'declared', invalid: null, policy: P1 },
        admission_blocked: null, runs_total: 4,
        runs: [BLOCKED_RUN, ON_RUN, OFF_RUN, UNKNOWN_RUN],
        mix: {
            totals: { attempts: 3, priced_attempts: 2, cost_usd: 2.5 },
            by_requested: [
                { model: 'claude-sonnet-5-5', attempts: 1, priced_attempts: 1, unpriced_attempts: 0, cost_usd: 0.5, share_attempts: 0.333333, share_cost: 0.2 },
                { model: 'claude-opus-5-5', attempts: 1, priced_attempts: 0, unpriced_attempts: 1, cost_usd: null, share_attempts: 0.333333, share_cost: null },
                { model: 'NOT_ROUTED', attempts: 1, priced_attempts: 1, unpriced_attempts: 0, cost_usd: 2, share_attempts: 0.333333, share_cost: 0.8 },
            ],
        },
        shadow_vs_real: { summary: { SAME: 1, REAL_HIGHER: 0, REAL_LOWER: 0, UNKNOWN: 0 }, rows: [] },
        ...overrides,
    };
}

// Resposta mínima do /api/would-route-metrics (contrato próprio, testado em would-route-metrics*.test.js).
const WOULD_ROUTE = {
    counts: { by_faixa: { leve: 1, medio: 0, opus: 1 }, no_decision: 0, decisions: 2, leaves_opus_tier: 1, attempts_with_would_route: 1 },
    savings_vs_opus_only: { opus_only_usd: 1, potential_usd: 0.6, potential_savings_usd: 0.4 },
    pricing_hypothesis: { description: 'Razões de preço de entrada.', cost_ratio_vs_opus: { T1: 0.2, T2: 0.6, T3: 1 }, source: 'model-pricing.json' },
    recent: [], note: '',
};

const SHADOW_ROWS = [
    { task_id: '9101-roteada', node: 'implement', attempt_id: 'a1', shadow: { status: 'SHADOW', policy_version: 's3-shadow-p1-0', class: 'C2', tier: 'T2', subtasks: 2 }, real: { class: 'C2', tier: 'T2', model_id: 'claude-sonnet-5-5' }, comparison: 'SAME', quality_effect: 'NOT_MEASURED' },
    { task_id: '9103-bloqueada', node: 'implement', attempt_id: 'a3', shadow: { status: 'SHADOW', policy_version: 's3-shadow-p1-0', class: 'C1', tier: 'T1', subtasks: 1 }, real: { class: 'C3', tier: 'T3', model_id: 'claude-opus-5-5' }, comparison: 'REAL_HIGHER', quality_effect: 'NOT_MEASURED' },
    { task_id: '9101-roteada', node: 'review', attempt_id: 'a2', shadow: 'UNAVAILABLE', real: { class: null, tier: 'T3', model_id: 'claude-opus-5-5' }, comparison: 'UNKNOWN', quality_effect: 'NOT_MEASURED' },
];

function boot(initial, { classifier = null, wouldRoute = WOULD_ROUTE } = {}) {
    let payload = initial;
    let hits = 0;
    const posts = [];
    const confirms = [];
    const server = http.createServer(async (req, res) => {
        // Seletor do classificador (contrato da sessão do Jev): fixture por teste; padrão 404.
        if (req.url.startsWith('/api/routing/classifier')) {
            const send = (status, obj) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
            if (!classifier) { res.writeHead(404); res.end(); return; }
            if (req.method === 'GET') { const g = classifier.get(); send(g.status || 200, g.body); return; }
            const chunks = [];
            for await (const c of req) chunks.push(c);
            const body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
            posts.push(body);
            const out = await classifier.post(body);
            if (out.destroy) { req.socket.destroy(); return; }
            send(out.status, out.body);
            return;
        }
        if (req.method === 'GET' && req.url.startsWith('/api/routing')) {
            hits += 1;
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify(payload));
            return;
        }
        if (req.method === 'GET' && req.url.startsWith('/api/would-route-metrics')) {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify(wouldRoute));
            return;
        }
        res.writeHead(404); res.end();
    });
    const elements = new Map();
    const dollar = id => { if (!elements.has(id)) elements.set(id, element(id)); return elements.get(id); };
    const location = { hash: '', pathname: '/' };
    const window = { addEventListener() {} };
    let base;
    const context = {
        window, location, prefs: {}, selected: null, runs: new Map(), NODES: [],
        NODE_LABEL: { plan: 'Plano', implement: 'Implementação', review: 'Revisão', test: 'Testes' },
        visibleRuns: () => [], isHidden: () => false, needsYou: () => false,
        history: { replaceState(_s, _t, url) { location.hash = url.startsWith('#') ? url : ''; } },
        document: { head: element('head'), body: { dataset: {}, appendChild() {} }, activeElement: { dataset: {} }, createElement: tag => element(tag), createTextNode: t => ({ textContent: t, children: [] }) },
        $: dollar, persist() {}, requestAnimationFrame: cb => { setTimeout(cb, 0); }, setTimeout, clearTimeout, Date, URL, Intl,
        async api(url) {
            const res = await globalThis.fetch(new URL(url, base));
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            return res.json();
        },
        fetch: (url, opts) => globalThis.fetch(new URL(url, base), opts),
        confirm(msg) { confirms.push(msg); return true; },
        localStorage: { getItem: () => null, setItem() {} },
    };
    return {
        set(next) { payload = next; },
        hits: () => hits,
        posts, confirms,
        async open() {
            await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
            base = `http://127.0.0.1:${server.address().port}`;
            vm.createContext(context);
            for (const f of ['ui-kit.js', 'would-route-metrics.js', 'routing-model.js']) vm.runInContext(fs.readFileSync(path.join(__dirname, 'public', f), 'utf8'), context, { filename: f });
            vm.runInContext(fs.readFileSync(path.join(__dirname, 'public', 'routing.js'), 'utf8'), context, { filename: 'routing.js' });
            vm.runInContext(fs.readFileSync(path.join(__dirname, 'public', 'views.js'), 'utf8'), context, { filename: 'views.js' });
        },
        tabsHtml: () => dollar('tabs').innerHTML,
        setView: name => window.Views.setView(name),
        reload: () => window.RoutingView.load(),
        text: () => flatText(dollar('view')),
        nodes: () => walk(dollar('view')),
        async close() { await new Promise(resolve => server.close(resolve)); },
    };
}

const loaded = ui => until(() => ui.text().includes('Todos') && ui.nodes().some(n => n.dataset?.key === 'cls'));
const byKey = (ui, key) => ui.nodes().find(n => n.dataset?.key === key);
const tf = (ui, key) => ui.nodes().find(n => n.dataset?.tfilter === key);
const hasClass = (n, c) => String(n.className || '').split(' ').includes(c);
const rows = ui => ui.nodes().filter(n => hasClass(n, 'rt-row'));
const detail = ui => ui.nodes().find(n => hasClass(n, 'rt-detail'));
const fire = (n, type, e = {}) => { for (const fn of n.listeners[type] || []) fn({ target: n, preventDefault() {}, stopPropagation() {}, ...e }); };
const panes = ui => ui.nodes().find(n => hasClass(n, 'rt-panes'));
const withShadow = (extra = {}) => body({ shadow_vs_real: { summary: { SAME: 1, REAL_HIGHER: 1, REAL_LOWER: 0, UNKNOWN: 1 }, rows: SHADOW_ROWS }, ...extra });
async function openScreen(payload, opts) {
    const ui = boot(payload, opts);
    await ui.open();
    ui.setView('roteamento');
    await loaded(ui);
    return ui;
}

test('item Roteamento em Agentes e modelos; abre e carrega o /api/routing', async () => {
    const ui = boot(body());
    try {
        await ui.open();
        assert.match(ui.tabsHtml(), /data-view="roteamento"[^>]*>(<svg[\s\S]*?<\/svg>)<span>Roteamento<\/span>/);
        assert.doesNotMatch(ui.tabsHtml(), /data-view="medicao-modelo"/);
        ui.setView('roteamento');
        await loaded(ui);
        assert.equal(ui.hits(), 1);
    } finally { await ui.close(); }
});

test('lista: um nó por linha na ordem do grafo, estado em glifo + texto, classificador por último', async () => {
    const ui = await openScreen(withShadow());
    try {
        const keys = rows(ui).map(r => r.dataset.key);
        assert.deepEqual(keys, ['implement', 'review', 'cls']);
        const impl = flatText(byKey(ui, 'implement'));
        assert.match(impl, /implement/);
        assert.match(impl, /Implementação/);
        assert.match(impl, /‖[\s\S]*sombra mais barata/);
        assert.match(impl, /1 de 2 divergem/);
        const rev = flatText(byKey(ui, 'review'));
        assert.match(rev, /\?[\s\S]*sem comparação/);
        assert.match(rev, /sem comparação em 1/);
        assert.doesNotMatch(rev, /0 de|concorda em 0/, 'sem comparação nunca vira zero');
        assert.match(flatText(byKey(ui, 'cls')), /Quem decide o modelo de cada subtarefa/);
        assert.match(ui.text(), /sombra escolheria tier menor[\s\S]*Efeito na qualidade não medido/);
        assert.match(ui.text(), /2 Attempt\(s\) comparados · 1 sem comparação/, 'sem comparação não conta como comparado');
    } finally { await ui.close(); }
});

test('abas Todos · Economia · Atual certo com contagem; filtro por texto e vazio com Limpar filtro', async () => {
    const ui = await openScreen(withShadow());
    try {
        assert.match(flatText(tf(ui, 'routing-view-all')), /Todos\s+3/);
        assert.match(flatText(tf(ui, 'routing-view-save')), /Economia\s+1/);
        assert.match(flatText(tf(ui, 'routing-view-ok')), /Atual certo\s+0/);
        assert.equal(tf(ui, 'routing-view-sent'), undefined, 'aba Pedidos fica fora: não há pedido de mudança de policy');
        tf(ui, 'routing-view-save').click();
        await until(() => rows(ui).length === 1);
        assert.equal(rows(ui)[0].dataset.key, 'implement');
        tf(ui, 'routing-view-ok').click();
        await until(() => rows(ui).length === 0);
        assert.match(ui.text(), /Nenhum nó neste recorte/);
        tf(ui, 'routing-clear').click();
        await until(() => rows(ui).length === 3);
        const q = tf(ui, 'routing-q');
        q.value = 'sonnet';
        fire(q, 'input');
        await until(() => rows(ui).length === 1);
        assert.equal(rows(ui)[0].dataset.key, 'implement');
    } finally { await ui.close(); }
});

test('atalhos: 1–3 trocam a aba; Esc fecha o detalhe e a lista ocupa a largura', async () => {
    const ui = await openScreen(withShadow());
    try {
        assert.equal(panes(ui).attributes['data-local-digits'], '', 'o atalho global de visões (ux.js) não age dentro da tela');
        assert.match(fs.readFileSync(path.join(__dirname, 'public', 'ux.js'), 'utf8'), /closest\?\.\('\[data-local-digits\]'\)\) return;/);
        fire(panes(ui), 'keydown', { key: '2' });
        await until(() => tf(ui, 'routing-view-save')?.attributes['aria-selected'] === 'true');
        assert.ok(detail(ui), 'detalhe aberto no primeiro nó');
        fire(panes(ui), 'keydown', { key: 'Escape' });
        await until(() => !detail(ui));
        assert.ok(!hasClass(ui.nodes().find(n => hasClass(n, 'rt-side')), 'has-sel'));
        assert.match(ui.text(), /J K navegar · Enter abrir · 1–3 abas · Esc fechar/);
    } finally { await ui.close(); }
});

test('detalhe do nó: Hoje contra a sombra, qualidade não medida e onde a sombra divergiu', async () => {
    const ui = await openScreen(withShadow());
    try {
        assert.equal(byKey(ui, 'implement').attributes['aria-current'], 'true', 'abre o primeiro nó, como no artboard');
        const sec = ui.nodes().find(n => n.attributes?.['aria-label'] === 'Hoje contra a sombra');
        const t = flatText(sec);
        assert.match(t, /Hoje roda\s+claude-opus-5-5, claude-sonnet-5-5/, 'modelos reais do nó, mais frequente primeiro (empate em ordem alfabética)');
        assert.match(t, /1 de 2 a sombra escolheria igual/);
        assert.match(t, /A sombra rodaria[\s\S]*T1 · C1[\s\S]*T2 · C2/);
        assert.match(t, /1 com tier menor · 0 com tier maior/);
        assert.match(ui.text(), /Efeito na qualidade: não medido/);
        assert.match(ui.text(), /Onde a sombra divergiu/);
        const open = ui.nodes().find(n => n.dataset?.open === '9103-bloqueada');
        assert.ok(open, 'a Run divergente abre a Run');
        assert.match(ui.text(), /T3 \(claude-opus-5-5\) → T1/);
        assert.doesNotMatch(ui.text(), /O que fazer|Pedir esta mudança|routing-policy@8|potencial/, 'sem proposta de policy nem economia inventada');
    } finally { await ui.close(); }
});

test('nó sem divergência mostra "Nenhuma divergência."', async () => {
    const same = [SHADOW_ROWS[0]];
    const ui = await openScreen(body({ shadow_vs_real: { summary: { SAME: 1, REAL_HIGHER: 0, REAL_LOWER: 0, UNKNOWN: 0 }, rows: same } }));
    try {
        assert.match(flatText(byKey(ui, 'implement')), /✓[\s\S]*sombra concorda[\s\S]*sombra concorda em 1/);
        assert.match(ui.text(), /Nenhuma divergência\./);
    } finally { await ui.close(); }
});

test('sem linhas de sombra: só o classificador e mensagem explícita, sem contagens inventadas', async () => {
    const ui = await openScreen(body());
    try {
        assert.deepEqual(rows(ui).map(r => r.dataset.key), ['cls']);
        assert.match(ui.text(), /0 Attempt\(s\) comparados/);
        tf(ui, 'routing-view-save').click();
        await until(() => /Nenhum Attempt com sombra ou decisão real ainda/.test(ui.text()));
    } finally { await ui.close(); }
});

test('mistura de modelos: "não roteado", custo ausente como "sem preço", nunca 0', async () => {
    const ui = await openScreen(withShadow());
    try {
        const t = ui.text();
        assert.match(t, /Mistura de modelos nas 4 Runs lidas/);
        assert.match(t, /claude-opus-5-5[\s\S]*33% · sem preço · 1 sem preço/);
        assert.match(t, /não roteado[\s\S]*US\$ 2,00/);
        assert.match(t, /2 de 3 Attempts com preço/);
        assert.doesNotMatch(t, /US\$ 0,00/);
    } finally { await ui.close(); }
});

test('histórico da routing-policy: versão vigente com aprovação; OFF mostra aviso e nenhuma policy', async () => {
    const ui = await openScreen(withShadow());
    try {
        assert.match(ui.text(), /Histórico da routing-policy[\s\S]*@p1-2026-11-06[\s\S]*routing-pri205 · APROVADA[\s\S]*Richard Fernandes · 2026-11-06 · vigente/);
        ui.set(withShadow({ config: { mode: 'OFF', source: 'absent', invalid: null, policy: null } }));
        ui.reload();
        await until(() => /Roteamento desligado/.test(ui.text()));
        assert.match(ui.text(), /Sem policy vigente: roteamento desligado/);
        assert.doesNotMatch(ui.text(), /@p1-2026-11-06/);
    } finally { await ui.close(); }
});

test('avisos: INVALID, admissão recusada e leitor fora do ar no topo da lista', async () => {
    const ui = await openScreen(withShadow({
        reader: 'FAILED',
        config: { mode: 'INVALID', source: null, invalid: { cause: 'POLICY_UNREADABLE', detail: 'SCHEMA', transient: false }, policy: null },
        admission_blocked: { cause: 'CONFIG_UNVERIFIABLE', detail: 'PLUGIN_NOT_PROVEN_OFF', transient: false, tickets: [9105, 9106], first_blocked_at: 'UNKNOWN', notice: { status: 'UNCERTAIN', at: null, attempts: 2 } },
    }));
    try {
        const t = ui.text();
        assert.match(t, /O leitor de roteamento não respondeu/);
        assert.match(t, /nada aqui significa roteamento desligado/);
        assert.match(t, /Configuração inválida \(POLICY_UNREADABLE · SCHEMA\)/);
        assert.match(t, /Admissão recusada \(CONFIG_UNVERIFIABLE · PLUGIN_NOT_PROVEN_OFF\)[\s\S]*#9105, #9106[\s\S]*resultado incerto[\s\S]*2 tentativa/);
    } finally { await ui.close(); }
});

test('aviso da sombra vem do diagnóstico do /api/would-route-metrics; OK não avisa', async () => {
    const diag = { ...WOULD_ROUTE, diagnosis: { code: 'CLASSIFIER_OFF', title_pt: 'Zeros esperados: classificador sombra desligado', next_step_pt: 'Feche novos Implements.' } };
    const ui = await openScreen(withShadow(), { wouldRoute: diag });
    try {
        await until(() => /classificador sombra desligado/.test(ui.text()));
        assert.match(ui.text(), /Feche novos Implements/);
    } finally { await ui.close(); }
    const ok = await openScreen(withShadow(), { wouldRoute: { ...WOULD_ROUTE, diagnosis: { code: 'OK', title_pt: 'Medição com decisões sombra' } } });
    try {
        await new Promise(r => setTimeout(r, 100));
        assert.doesNotMatch(ok.text(), /Medição com decisões sombra/);
    } finally { await ok.close(); }
});

test('atalho antigo #medicao-modelo abre Roteamento', async () => {
    const ui = boot(withShadow());
    try {
        await ui.open();
        ui.setView('medicao-modelo');
        await loaded(ui);
        assert.match(ui.tabsHtml(), /data-view="roteamento" aria-selected="true"/);
        assert.match(ui.text(), /Hoje roda/);
    } finally { await ui.close(); }
});

// ── classificador (contrato GET/POST /api/routing/classifier) ──
function classifierState({ version = 0, choice = null, mode = null, source = 'POLICY', provider = 'cheap_rule', jevShadow = { allowed: false, refusal: 'CLASSIFIER_SCOPE_NOT_AUTHORIZED', detail: 'sem Authority Ref para o projeto' }, history = [] } = {}) {
    return {
        project: 'consumidor-sintetico', routing_mode: 'ON',
        current: { version, choice, provider, mode, source, by: source === 'SELECTION' ? 'richard' : null, at: source === 'SELECTION' ? '2026-11-06T14:00:00.000Z' : null, reason: source === 'SELECTION' ? 'teste' : null },
        options: [
            { choice: 'policy_only', allowed: true },
            { choice: 'policy_jev', modes: { shadow: jevShadow, active: { allowed: false, refusal: 'CLASSIFIER_NOT_CALIBRATED' } } },
        ],
        history,
    };
}
const clsNode = (ui, key) => ui.nodes().find(n => n.dataset?.clsOption === key);
const clsField = (ui, key) => ui.nodes().find(n => n.dataset?.clsField === key);
const clsSend = ui => ui.nodes().find(n => n.dataset?.clsAction === 'send');
function pick(ui, key) { clsNode(ui, key).click(); }
async function type(ui, key, value) {
    await until(() => clsField(ui, key));
    const n = clsField(ui, key);
    n.value = value;
    fire(n, 'input');
}
async function openCls(payload, classifier) {
    const ui = await openScreen(payload, { classifier });
    await until(() => byKey(ui, 'cls') && !/carregando/.test(flatText(byKey(ui, 'cls'))));
    byKey(ui, 'cls').click();
    await until(() => /Classificador · vale para todos os nós/.test(ui.text()));
    return ui;
}

test('classificador: estado atual, aviso de Runs novas e opções recusadas com o motivo da API', async () => {
    const st = classifierState();
    const ui = await openCls(body(), { get: () => ({ body: st }), post: async () => ({ status: 500, body: {} }) });
    try {
        const t = ui.text();
        assert.match(flatText(byKey(ui, 'cls')), /✓[\s\S]*cheap_rule ativo[\s\S]*definido pela policy/, 'linha no padrão do artboard: chip curto "<quem> ativo"');
        assert.doesNotMatch(flatText(byKey(ui, 'cls')), /versão 0/, 'sem troca registrada, a linha não mostra versão');
        assert.match(t, /Hoje[\s\S]*definido pela policy \(cheap_rule\)[\s\S]*versão 0/);
        assert.match(t, /Escolhido[\s\S]*nenhuma opção marcada/);
        assert.match(t, /Vale só para Runs novas/);
        assert.equal(clsNode(ui, 'policy_only').disabled, false);
        assert.equal(clsNode(ui, 'policy_only').attributes.role, 'radio');
        assert.equal(clsNode(ui, 'policy_jev:shadow').disabled, true);
        assert.match(t, /CLASSIFIER_SCOPE_NOT_AUTHORIZED[\s\S]*sem Authority Ref/);
        assert.equal(clsNode(ui, 'policy_jev:active').disabled, true);
        assert.match(t, /CLASSIFIER_NOT_CALIBRATED/);
        assert.equal(clsSend(ui).disabled, true, 'sem escolha e sem motivo, nada a enviar');
        assert.match(t, /Nenhuma troca registrada/);
    } finally { await ui.close(); }
});

test('classificador: endpoint ausente: indisponível, sem inventar estado nem botão', async () => {
    const ui = await openCls(body(), null);
    try {
        assert.match(ui.text(), /Seletor do classificador indisponível/);
        assert.match(flatText(byKey(ui, 'cls')), /indisponível/);
        assert.equal(clsSend(ui), undefined);
    } finally { await ui.close(); }
});

test('classificador: troca: "enviado" até a resposta, "aplicado" só depois do 200, corpo no contrato', async () => {
    let st = classifierState({ jevShadow: { allowed: true, refusal: null, detail: null } });
    let release;
    const gate = new Promise(r => { release = r; });
    const ui = await openCls(body(), {
        get: () => ({ body: st }),
        post: async b => {
            await gate;
            st = classifierState({ version: 1, choice: b.choice, mode: b.mode, source: 'SELECTION', provider: 'jev', jevShadow: { allowed: true, refusal: null, detail: null }, history: [{ version: 1, choice: b.choice, mode: b.mode, by: 'richard', at: '2026-11-06T15:00:00.000Z', reason: b.reason }] });
            return { status: 200, body: { ok: true, status: 'applied', current: st.current } };
        },
    });
    try {
        pick(ui, 'policy_jev:shadow');
        await until(() => clsNode(ui, 'policy_jev:shadow').attributes['aria-checked'] === 'true');
        assert.match(ui.text(), /Escolhido[\s\S]*Policy \+ Jev \(sombra\)/);
        await type(ui, 'reason', 'medir o Jev em sombra');
        await until(() => clsSend(ui) && clsSend(ui).disabled === false);
        assert.match(flatText(clsSend(ui)), /Pedir troca para Policy \+ Jev \(sombra\)/);
        clsSend(ui).click();
        await until(() => /Enviado/.test(ui.text()));
        assert.match(flatText(byKey(ui, 'cls')), /◐[\s\S]*troca enviada/);
        assert.doesNotMatch(ui.text(), /Aplicado/);
        assert.equal(ui.confirms.length, 1);
        assert.match(ui.confirms[0], /Policy \+ Jev \(sombra\)[\s\S]*Runs novas/);
        release();
        await until(() => /Aplicado/.test(ui.text()));
        await until(() => /versão 1 · por richard/.test(flatText(byKey(ui, 'cls'))));
        assert.match(flatText(byKey(ui, 'cls')), /✓[\s\S]*Jev em sombra ativo/);
        assert.match(ui.text(), /Histórico do classificador[\s\S]*versão 1[\s\S]*medir o Jev em sombra/);
        const p = ui.posts[0];
        assert.deepEqual({ choice: p.choice, mode: p.mode, expected_version: p.expected_version, reason: p.reason }, { choice: 'policy_jev', mode: 'shadow', expected_version: 0, reason: 'medir o Jev em sombra' });
        assert.match(p.operation_id, /^[\w:.@-]{8,100}$/);
        assert.ok(!('approver' in p) && !('approver_password' in p), 'sem aprovador nem senha (decisão de 2026-11-06)');
        assert.equal(clsField(ui, 'password'), undefined, 'sem campo de senha');
    } finally { release(); await ui.close(); }
});

test('classificador: recusa do writer projetada com o código; nada de "aplicado"', async () => {
    const st = classifierState({ jevShadow: { allowed: true, refusal: null, detail: null } });
    const ui = await openCls(body(), { get: () => ({ body: st }), post: async () => ({ status: 422, body: { ok: false, code: 'CLASSIFIER_LOCKED_BY_EXPERIMENT', error: 'unidade S6 ativa no escopo' } }) });
    try {
        pick(ui, 'policy_jev:shadow');
        await type(ui, 'reason', 'x');
        await until(() => clsSend(ui).disabled === false);
        clsSend(ui).click();
        await until(() => /CLASSIFIER_LOCKED_BY_EXPERIMENT/.test(ui.text()));
        assert.match(ui.text(), /unidade S6 ativa no escopo/);
        assert.doesNotMatch(ui.text(), /Aplicado/);
    } finally { await ui.close(); }
});

test('classificador: resposta perdida: reenvio com o mesmo operation_id; o writer devolve already_processed', async () => {
    let st = classifierState();
    let n = 0;
    const ui = await openCls(body(), {
        get: () => ({ body: st }),
        post: async b => {
            n += 1;
            st = classifierState({ version: 1, choice: b.choice, source: 'SELECTION', provider: 'off' });
            if (n === 1) return { destroy: true };
            return { status: 200, body: { ok: true, status: 'already_processed', current: st.current } };
        },
    });
    try {
        pick(ui, 'policy_only');
        await type(ui, 'reason', 'só a policy');
        await until(() => clsSend(ui).disabled === false);
        clsSend(ui).click();
        await until(() => /Resultado incerto/.test(ui.text()));
        await until(() => clsSend(ui).disabled === false);
        clsSend(ui).click();
        await until(() => /já estava registrada/i.test(ui.text()));
        assert.equal(ui.posts.length, 2);
        assert.equal(ui.posts[1].operation_id, ui.posts[0].operation_id);
        assert.equal(ui.posts[1].expected_version, ui.posts[0].expected_version, 'reenvio igual, sem trocar a versão esperada');
    } finally { await ui.close(); }
});

test('classificador: a opção que já é a atual não pode ser reenviada', async () => {
    const st = classifierState({ version: 2, choice: 'policy_only', source: 'SELECTION', provider: 'off' });
    const ui = await openCls(body(), { get: () => ({ body: st }), post: async () => ({ status: 500, body: {} }) });
    try {
        assert.match(ui.text(), /Hoje[\s\S]*Só policy/);
        assert.match(flatText(clsNode(ui, 'policy_only')), /· ativo/);
        pick(ui, 'policy_only');
        await type(ui, 'reason', 'de novo');
        await until(() => /já é a escolha atual/.test(ui.text()));
        assert.equal(clsSend(ui).disabled, true);
        assert.match(flatText(clsSend(ui)), /Já é o ativo/);
    } finally { await ui.close(); }
});

test('classificador: registro ilegível (source INVALID, version null): projeta o motivo, sem fingir estado', async () => {
    const st = { ...classifierState(), current: { version: null, choice: null, provider: 'off', mode: null, source: 'INVALID', by: null, at: null, reason: 'CLASSIFIER_SELECTION_INVALID' }, registry_git_ignored: true };
    const ui = await openCls(body(), { get: () => ({ body: st }), post: async () => ({ status: 409, body: { ok: false, code: 'CLASSIFIER_SELECTION_INVALID', error: 'registro ilegível' } }) });
    try {
        const t = ui.text();
        assert.match(t, /Registro de seleção ilegível/);
        assert.match(t, /CLASSIFIER_SELECTION_INVALID/);
        assert.doesNotMatch(t, /versão 0/);
        pick(ui, 'policy_only');
        await type(ui, 'reason', 'corrigir');
        await until(() => clsSend(ui).disabled === false);
        clsSend(ui).click();
        await until(() => /Recusado \(CLASSIFIER_SELECTION_INVALID\)/.test(ui.text()));
        assert.equal(ui.posts[0].expected_version, null, 'manda a versão como a API declarou; o writer decide');
    } finally { await ui.close(); }
});

test('classificador: registry_git_ignored false avisa; true ou ausente não avisa', async () => {
    for (const [flag, warn] of [[false, true], [true, false], [undefined, false]]) {
        const st = { ...classifierState(), ...(flag === undefined ? {} : { registry_git_ignored: flag }) };
        const ui = await openCls(body(), { get: () => ({ body: st }), post: async () => ({ status: 500, body: {} }) });
        try {
            if (warn) {
                assert.match(ui.text(), /não está ignorado pelo git/);
                assert.match(ui.text(), /memory\/routing\/classifier-selection\.json/);
            } else assert.doesNotMatch(ui.text(), /não está ignorado pelo git/);
        } finally { await ui.close(); }
    }
});

test('classificador (MAJOR-2): 5xx é incerto: mantém o operation_id; reenvio devolve already_processed', async () => {
    let st = classifierState();
    let n = 0;
    const ui = await openCls(body(), {
        get: () => ({ body: st }),
        post: async b => {
            n += 1;
            st = classifierState({ version: 1, choice: b.choice, source: 'SELECTION', provider: 'off' });
            if (n === 1) return { status: 500, body: { error: 'falhou depois de gravar' } };
            return { status: 200, body: { ok: true, status: 'already_processed', current: st.current } };
        },
    });
    try {
        pick(ui, 'policy_only');
        await type(ui, 'reason', 'só a policy');
        await until(() => clsSend(ui).disabled === false);
        clsSend(ui).click();
        await until(() => /Resultado incerto \(HTTP 500\)/.test(ui.text()));
        assert.doesNotMatch(ui.text(), /Recusado \(/, '5xx não vira recusa');
        await until(() => clsSend(ui).disabled === false);
        clsSend(ui).click();
        await until(() => /já estava registrada/i.test(ui.text()));
        assert.equal(ui.posts[1].operation_id, ui.posts[0].operation_id);
    } finally { await ui.close(); }
});
