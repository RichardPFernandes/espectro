// node --test ui-fixture-offline.test.js
// PRI-390: a tela inicial servida no fixture da verificação de UI não depende de rede.
// O navegador da verificação só alcança 127.0.0.1; fonte de CDN vira REQUEST_FAILED no veredito.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PUBLIC = path.join(__dirname, 'public');
const FONTS = path.join(PUBLIC, 'fonts');
const read = f => fs.readFileSync(f, 'utf8');

const tmpBase = process.env.CLAUDE_JOB_DIR ? path.join(process.env.CLAUDE_JOB_DIR, 'tmp') : os.tmpdir();
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(tmpBase, 'ui-fixture-offline-')));

function fontFaces() {
    const css = read(path.join(FONTS, 'fonts.css'));
    return [...css.matchAll(/@font-face\s*{([^}]*)}/g)].map(([, body]) => ({
        body,
        family: (body.match(/font-family:\s*['"]?([^'";]+)['"]?/) || [])[1],
        urls: [...body.matchAll(/url\(\s*['"]?([^'")]+)['"]?\s*\)/g)].map(m => m[1]),
    }));
}

test('PRI-390 T2: index.html não carrega fonte do Google e linka fonts/fonts.css', () => {
    const html = read(path.join(PUBLIC, 'index.html'));
    assert.doesNotMatch(html, /fonts\.(googleapis|gstatic)\.com/);
    assert.match(html, /<link rel="stylesheet" href="fonts\/fonts\.css">/);
});

test('PRI-390 T2: fonts.css declara Inter e JetBrains Mono com arquivos locais e font-display: swap', () => {
    const faces = fontFaces();
    assert.deepEqual([...new Set(faces.map(f => f.family))].sort(), ['Inter', 'JetBrains Mono']);
    for (const f of faces) {
        assert.match(f.body, /font-display:\s*swap/, f.family);
        assert.ok(f.urls.length > 0, `${f.family} sem url()`);
        for (const u of f.urls) {
            assert.doesNotMatch(u, /^(https?:)?\/\//, `${u} é remoto`);
            assert.ok(fs.existsSync(path.join(FONTS, u)), `${u} não existe em public/fonts`);
        }
    }
});

test('PRI-390 T2: README registra o sha256 de cada woff2 e as licenças OFL acompanham', () => {
    const readme = read(path.join(FONTS, 'README.md'));
    const files = fs.readdirSync(FONTS).filter(f => f.endsWith('.woff2'));
    assert.ok(files.length > 0);
    for (const f of files) {
        const sha = crypto.createHash('sha256').update(fs.readFileSync(path.join(FONTS, f))).digest('hex');
        const line = readme.split('\n').find(l => l.includes(f));
        assert.ok(line, `${f} fora do README`);
        assert.ok(line.includes(sha), `sha256 de ${f} não bate com o README`);
        assert.match(line, /https:\/\/github\.com\/(rsms\/inter|JetBrains\/JetBrainsMono)\/releases\/download\//, `${f} sem URL da release`);
    }
    for (const lic of ['OFL-Inter.txt', 'OFL-JetBrainsMono.txt']) {
        assert.match(read(path.join(FONTS, lic)), /SIL OPEN FONT LICENSE Version 1\.1/i, lic);
    }
});

test('PRI-390 T2: o dashboard no somente leitura serve fonts.css e as fontes como font/woff2', async () => {
    const { createDashboard } = require('./server');
    const memoryDir = path.join(tmp, 'memory', 'runs');
    fs.mkdirSync(memoryDir, { recursive: true });
    const dash = createDashboard({ memoryDir, prefsFile: path.join(tmp, 'prefs.json'), env: {} });
    await new Promise(r => dash.server.listen(0, '127.0.0.1', r));
    await dash.ready;
    process.env.PRISMA_DASHBOARD_READONLY = '1';
    try {
        const base = `http://127.0.0.1:${dash.server.address().port}`;
        const css = await fetch(`${base}/fonts/fonts.css`);
        assert.equal(css.status, 200);
        assert.match(css.headers.get('content-type'), /^text\/css/);
        for (const u of new Set(fontFaces().flatMap(f => f.urls))) {
            const r = await fetch(`${base}/fonts/${u}`);
            assert.equal(r.status, 200, u);
            assert.equal(r.headers.get('content-type'), 'font/woff2', u);
            await r.arrayBuffer();
        }
    } finally {
        delete process.env.PRISMA_DASHBOARD_READONLY;
        await dash.close();
    }
});

// ---- T3 (AC-1, AC-3): varredura genérica de origem externa e 200 em todo recurso local ----
// Referência em atributo href/src e em CSS (url(), @import). `${...}` é link montado em runtime
// com dado da Run (PR, ticket) e não é carregado pela tela; data: e âncoras (#) são locais.
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1']);
function attrRefs(html) {
    return [...html.matchAll(/<([a-z]+)\b[^>]*?\s(href|src)\s*=\s*(["'])(.*?)\3/gis)]
        .map(([, tag, attr, , ref]) => ({ tag: tag.toLowerCase(), attr, ref, rel: '' }))
        .filter(r => !r.ref.includes('${'));
}
function cssRefs(css) {
    const noComments = css.replace(/\/\*[\s\S]*?\*\//g, '');
    return [
        ...[...noComments.matchAll(/url\(\s*(["']?)([^"')]+)\1\s*\)/g)].map(m => m[2].trim()),
        ...[...noComments.matchAll(/@import\s+(["'])([^"']+)\1/g)].map(m => m[2].trim()),
    ];
}
function styleBlocks(html) {
    return [...html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)].map(m => m[1]).join('\n');
}
// Externa: tem esquema (ou é //host) e não é data: nem http(s) de localhost/127.0.0.1.
function isExternal(ref) {
    if (/^data:/i.test(ref)) return false;
    if (!/^([a-z][a-z0-9+.-]*:|\/\/)/i.test(ref)) return false;
    let u;
    try { u = new URL(ref, 'http://127.0.0.1/'); } catch { return true; }
    return !(/^https?:$/.test(u.protocol) && LOCAL_HOSTS.has(u.hostname));
}
const isLocalResource = ref => ref && !ref.startsWith('#') && !/^data:/i.test(ref) && !isExternal(ref);

// Arquivo HTML → externas no HTML e em toda folha CSS local que ele alcança (lidas do disco).
function externalRefsFromDisk(htmlFile, publicDir) {
    const html = read(htmlFile);
    const found = [];
    for (const r of attrRefs(html)) if (isExternal(r.ref)) found.push(`index.html ${r.attr}=${r.ref}`);
    for (const ref of cssRefs(styleBlocks(html))) if (isExternal(ref)) found.push(`index.html <style> ${ref}`);
    const seen = new Set();
    const queue = attrRefs(html).filter(r => r.tag === 'link' && isLocalResource(r.ref) && /\.css(\?|$)/.test(r.ref))
        .map(r => path.join(publicDir, r.ref.replace(/^\//, '').split('?')[0]));
    while (queue.length) {
        const file = queue.shift();
        if (seen.has(file)) continue;
        seen.add(file);
        assert.ok(fs.existsSync(file), `${path.relative(publicDir, file)} referenciada e ausente`);
        for (const ref of cssRefs(read(file))) {
            if (isExternal(ref)) found.push(`${path.relative(publicDir, file)} ${ref}`);
            else if (isLocalResource(ref) && /\.css(\?|$)/.test(ref)) queue.push(path.resolve(path.dirname(file), ref.split('?')[0]));
        }
    }
    return { found, cssFiles: [...seen] };
}

test('PRI-390 T3: a varredura reprova origem externa em href, src, url() e @import', () => {
    const html = [
        // as três linhas que o index.html do main tinha
        '<link rel="preconnect" href="https://fonts.googleapis.com">',
        '<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>',
        '<link href="https://fonts.googleapis.com/css2?family=Inter&display=swap" rel="stylesheet">',
        '<script src="//cdn.example.com/x.js"></script>',
        '<style>@import "https://cdn.example.com/a.css"; .x{background:url(https://cdn.example.com/b.png)}</style>',
    ].join('\n');
    const refs = [...attrRefs(html).map(r => r.ref), ...cssRefs(styleBlocks(html))];
    assert.deepEqual(refs.filter(isExternal), refs);
    assert.equal(refs.length, 6);
    for (const ok of ['fonts/fonts.css', '/api/export', '#runs', 'data:image/svg+xml,%3Csvg%3E', 'http://127.0.0.1:4317/x.css', 'http://localhost/y.js']) {
        assert.equal(isExternal(ok), false, ok);
    }
    assert.deepEqual(attrRefs('<a href="${esc(p.url)}">'), [], 'link montado em runtime não é recurso da tela');
});

test('PRI-390 T3 (AC-1): index.html e as folhas CSS locais não referenciam origem fora de localhost', () => {
    const { found, cssFiles } = externalRefsFromDisk(path.join(PUBLIC, 'index.html'), PUBLIC);
    assert.deepEqual(found, []);
    assert.ok(cssFiles.some(f => f.endsWith(path.join('fonts', 'fonts.css'))), 'fonts.css fora da varredura');
    assert.ok(cssFiles.length >= 3, `só ${cssFiles.length} folhas varridas`);
});

async function bootReadonly(obsidianFlag) {
    const { createDashboard } = require('./server');
    const root = fs.mkdtempSync(path.join(tmp, 'dash-'));
    const memoryDir = path.join(root, 'memory', 'runs');
    fs.mkdirSync(memoryDir, { recursive: true });
    const prefsFile = path.join(root, 'prefs.json');
    const env = obsidianFlag ? { PRISMA_OBSIDIAN: obsidianFlag } : {};
    const dash = createDashboard({ memoryDir, prefsFile, env });
    await new Promise(r => dash.server.listen(0, '127.0.0.1', r));
    await dash.ready;
    return { dash, prefsFile, base: `http://127.0.0.1:${dash.server.address().port}` };
}

test('PRI-390 T3 (AC-1): no somente leitura, todo recurso local da tela inicial responde 200 e as fontes vêm como font/woff2', async () => {
    const { dash, base } = await bootReadonly();
    process.env.PRISMA_DASHBOARD_READONLY = '1';
    try {
        const page = await fetch(`${base}/`);
        assert.equal(page.status, 200);
        const html = await page.text();
        // Recurso que a tela carrega: <link>, <script>, <img> etc.; <a href> é navegação, não carga.
        const pending = attrRefs(html).filter(r => r.tag !== 'a' && isLocalResource(r.ref))
            .map(r => new URL(r.ref, `${base}/`).href);
        for (const ref of cssRefs(styleBlocks(html))) if (isLocalResource(ref)) pending.push(new URL(ref, `${base}/`).href);
        assert.ok(pending.length > 10, `só ${pending.length} recursos locais`);
        const checked = new Map();
        while (pending.length) {
            const url = pending.shift();
            if (checked.has(url)) continue;
            const r = await fetch(url);
            const type = r.headers.get('content-type') || '';
            checked.set(url, type);
            assert.equal(r.status, 200, new URL(url).pathname);
            if (/\.woff2$/.test(new URL(url).pathname)) {
                assert.equal(type, 'font/woff2', new URL(url).pathname);
                await r.arrayBuffer();
            } else if (/^text\/css/.test(type)) {
                for (const ref of cssRefs(await r.text())) if (isLocalResource(ref)) pending.push(new URL(ref, url).href);
            } else {
                await r.arrayBuffer();
            }
        }
        const fonts = [...checked.keys()].filter(u => u.endsWith('.woff2'));
        assert.equal(fonts.length, new Set(fontFaces().flatMap(f => f.urls)).size, 'toda fonte do fonts.css foi alcançada a partir da tela');
    } finally {
        delete process.env.PRISMA_DASHBOARD_READONLY;
        await dash.close();
    }
});

test('PRI-390 T3 (AC-2): no somente leitura, /api/obsidian é neutra com PRISMA_OBSIDIAN on, off e ausente', async () => {
    for (const flag of ['on', 'off', undefined]) {
        const { dash, prefsFile, base } = await bootReadonly(flag);
        process.env.PRISMA_DASHBOARD_READONLY = '1';
        try {
            const r = await fetch(`${base}/api/obsidian`);
            assert.equal(r.status, 200, `flag ${flag}`);
            assert.deepEqual(await r.json(), { enabled: false, vault: null, ready: false, uri: null });
            assert.ok(!fs.existsSync(prefsFile), 'não lê nem cria prefs');
        } finally {
            delete process.env.PRISMA_DASHBOARD_READONLY;
            await dash.close();
        }
    }
});
