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
