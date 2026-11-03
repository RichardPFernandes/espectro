// node --test version-ui.test.js
// AC-06: aba Versão no mesmo harness de DOM do dashboard (vm, sem browser),
// ligada ao createVersion por HTTP. Abrir a aba, confirmar e ver o pin ir para
// a revisão nova num processo com PID diferente.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { execFileSync } = require('node:child_process');
const { createVersion } = require('./version');

const gitEnv = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { env: gitEnv, encoding: 'utf8' }).trim();
const OLD_PID = 12001;
const NEW_PID = 12002;

function element(tag = 'div') {
    return {
        tag, children: [], attributes: {}, listeners: {}, dataset: {}, className: '', textContent: '',
        disabled: false, type: '', title: '', hidden: false, scrollTop: 0, html: '',
        classList: { add() {}, remove() {} },
        append(...kids) { this.children.push(...kids); },
        setAttribute(name, value) { this.attributes[name] = String(value); },
        addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); },
        click() { if (!this.disabled) for (const fn of this.listeners.click || []) fn(); },
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
    return `${node.textContent || ''}${(node.children || []).map(flatText).join('')}`;
}
async function until(fn, ms = 4000) {
    const start = Date.now();
    while (Date.now() - start < ms) {
        if (fn()) return;
        await new Promise(resolve => setTimeout(resolve, 20));
    }
    throw new Error('timeout esperando a aba Versão');
}

function boot({ restart }) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'version-ui-'));
    const origin = path.join(tmp, 'origin.git');
    const seed = path.join(tmp, 'seed');
    const prisma = path.join(tmp, 'prisma');
    const consumer = path.join(tmp, 'consumer');
    const bumpLog = path.join(tmp, 'bump.log');
    fs.mkdirSync(path.join(consumer, 'dashboard'), { recursive: true });
    execFileSync('git', ['init', '--bare', '-b', 'main', origin]);
    execFileSync('git', ['clone', '-q', origin, seed]);
    git(seed, 'checkout', '-q', '-b', 'main');
    const shas = [];
    for (const msg of ['base', 'feat: um', 'fix: dois TOKEN=abc123segredo']) {
        fs.writeFileSync(path.join(seed, 'f.txt'), msg);
        git(seed, 'add', '.'); git(seed, 'commit', '-q', '-m', msg);
        shas.push(git(seed, 'rev-parse', 'HEAD'));
        git(seed, 'push', '-q', 'origin', 'main');
    }
    execFileSync('git', ['clone', '-q', origin, prisma]);
    git(prisma, 'checkout', '-q', '--detach', shas[0]);
    const bump = path.join(tmp, 'bump.sh');
    fs.writeFileSync(bump, `#!/bin/sh\necho "$1" >> ${JSON.stringify(bumpLog)}\ngit -C ${JSON.stringify(prisma)} checkout -q --detach "$1"\n`);
    fs.chmodSync(bump, 0o755);
    const spawned = [];
    const exits = [];
    const versionOpts = {
        prismaRoot: prisma, repoRoot: consumer, redact: value => JSON.parse(JSON.stringify(value).split('abc123segredo').join('***')),
        watcherStatus: () => ({ running: false, state: 'stopped' }),
        lockStatus: () => ({ lock_state: 'free', agents: [] }),
        env: { ...gitEnv, PRISMA_BUMP_COMMAND: restart ? bump : '', ...(restart ? { PRISMA_RESTART_COMMAND: 'bash scripts/prisma-start.sh dashboard' } : {}) },
        requestExit: restart ? () => exits.push(1) : null,
        spawnDetached: (args, opts) => { spawned.push({ args, opts }); },
        pid: OLD_PID,
    };
    let active = createVersion(versionOpts);
    const server = http.createServer(async (req, res) => {
        try {
            if (req.method === 'GET' && req.url.startsWith('/api/version')) {
                const body = await active.read({ force: req.url.includes('refresh=1') });
                res.writeHead(200, { 'content-type': 'application/json' });
                res.end(JSON.stringify(body));
                return;
            }
            if (req.method === 'POST' && req.url === '/api/version/update') {
                const chunks = [];
                for await (const chunk of req) chunks.push(chunk);
                const target = JSON.parse(Buffer.concat(chunks).toString() || '{}').target;
                const result = await active.update(target);
                if (result.body?.restarting) active = createVersion({ ...versionOpts, pid: NEW_PID, requestExit: () => {} });
                res.writeHead(result.status, { 'content-type': 'application/json' });
                res.end(JSON.stringify(result.body));
                return;
            }
            res.writeHead(404); res.end();
        } catch (error) {
            res.writeHead(500, { 'content-type': 'text/plain' });
            res.end(error.message);
        }
    });
    const confirms = [];
    let allow = false;
    const elements = new Map();
    const dollar = id => { if (!elements.has(id)) elements.set(id, element(id)); return elements.get(id); };
    const location = { hash: '', pathname: '/' };
    const window = { addEventListener() {} };
    const context = {
        window, location, prefs: {}, selected: null, runs: new Map(), NODES: [],
        visibleRuns: () => [], isHidden: () => false, needsYou: () => false,
        history: { replaceState(_s, _t, url) { location.hash = url.startsWith('#') ? url : ''; } },
        document: { head: element('head'), body: { dataset: {}, appendChild() {} }, activeElement: { dataset: {} }, createElement: tag => element(tag) },
        $: dollar, persist() {}, requestAnimationFrame: cb => { setTimeout(cb, 0); }, setTimeout, clearTimeout, Date, URL,
        confirm(message) { confirms.push(message); return allow; },
        fetch(url, opts) { return globalThis.fetch(new URL(url, base), opts); },
        async api(url) {
            const res = await globalThis.fetch(new URL(url, base));
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            return res.json();
        },
    };
    let base;
    return {
        shas, bumpLog, confirms, spawned, exits, prisma,
        async open() {
            await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
            base = `http://127.0.0.1:${server.address().port}`;
            vm.createContext(context);
            vm.runInContext(fs.readFileSync(path.join(__dirname, 'public', 'version.js'), 'utf8'), context, { filename: 'version.js' });
            vm.runInContext(fs.readFileSync(path.join(__dirname, 'public', 'views.js'), 'utf8'), context, { filename: 'views.js' });
        },
        tabsHtml: () => dollar('tabs').innerHTML,
        setView: name => window.Views.setView(name),
        viewName: () => context.document.body.dataset.view,
        root: () => dollar('view').children[0],
        text: () => flatText(dollar('view')),
        button: () => walk(dollar('view')).find(node => String(node.className || '').includes('version-go')),
        allow(value) { allow = value; },
        async close() {
            await new Promise(resolve => server.close(resolve));
            fs.rmSync(tmp, { recursive: true, force: true });
        },
    };
}

test('AC-06: abrir Versão, confirmar Atualizar, pin na revisão nova e PID novo', { timeout: 20000 }, async () => {
    const ui = boot({ restart: true });
    try {
        await ui.open();
        assert.match(ui.tabsHtml(), /data-view="versao"/);
        assert.match(ui.tabsHtml(), /Versão/);
        ui.setView('versao');
        await until(() => ui.button() && ui.button().disabled === false);
        assert.equal(ui.viewName(), 'versao');
        assert.match(ui.tabsHtml(), /data-view="versao" aria-selected="true"/);
        const text = ui.text();
        assert.match(text, /Versão/);
        assert.match(text, /feat: um/);
        assert.match(text, /TOKEN=\*\*\*/);
        assert.equal(text.includes('abc123segredo'), false);
        ui.allow(false);
        ui.button().click();
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(ui.confirms.length, 1);
        assert.match(ui.confirms[0], new RegExp(`Atualizar o Prisma de ${ui.shas[0].slice(0, 7)} para ${ui.shas[2].slice(0, 7)}`));
        assert.match(ui.confirms[0], /reiniciar/);
        assert.equal(fs.existsSync(ui.bumpLog), false, 'cancelar a confirmação não move o pin');
        ui.allow(true);
        ui.button().click();
        await until(() => ui.text().includes('Dashboard reiniciado'), 8000);
        assert.match(ui.text(), new RegExp(`Dashboard reiniciado em ${ui.shas[2].slice(0, 7)}`));
        assert.equal(git(ui.prisma, 'rev-parse', 'HEAD'), ui.shas[2]);
        assert.equal(fs.readFileSync(ui.bumpLog, 'utf8').trim(), ui.shas[2]);
        assert.equal(ui.exits.length, 1);
        assert.equal(ui.spawned.length, 1);
        assert.match(ui.spawned[0].args[1], /kill -0/);
        assert.equal(ui.spawned[0].args[4], 'bash scripts/prisma-start.sh dashboard');
    } finally { await ui.close(); }
});

test('AC-06: sem bump a aba mostra o delta e o botão fica desabilitado com o motivo', async () => {
    const ui = boot({ restart: false });
    try {
        await ui.open();
        ui.setView('versao');
        await until(() => ui.button());
        assert.equal(ui.button().disabled, true);
        assert.match(ui.button().textContent, /Atualizar para /);
        assert.match(ui.text(), /feat: um/);
        assert.match(ui.text(), /PRISMA_BUMP_COMMAND/);
        ui.button().click();
        assert.equal(ui.confirms.length, 0);
        assert.equal(fs.existsSync(ui.bumpLog), false);
    } finally { await ui.close(); }
});
