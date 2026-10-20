// node --test context-md.test.js
// Preview do context.md (PRI-211): endpoint /api/runs/:id/context e o renderizador
// Markdown do front (public/markdown.js). Repo sintético, não toca nos runs reais.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpBase = process.env.CLAUDE_JOB_DIR ? path.join(process.env.CLAUDE_JOB_DIR, 'tmp') : os.tmpdir();
const tmp = fs.mkdtempSync(path.join(tmpBase, 'dashboard-context-md-'));
const mainRuns = path.join(tmp, 'app-back', 'memory', 'runs');

const MD = require('./public/markdown');

function seed(taskId, context) {
    const dir = path.join(mainRuns, taskId);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ task_id: taskId, history: [], node: 'review', status: 'in_progress', updated_at: '2026-10-20T00:00:00Z' }));
    if (context != null) fs.writeFileSync(path.join(dir, 'context.md'), context);
    return dir;
}

const FULL = `# Contexto\n\n${Array.from({ length: 300 }, (_, i) => `linha ${i}`).join('\n')}\n\n## Fim\n`;
seed('95001-com', FULL);
seed('95002-sem');
// context.md que é symlink para fora da pasta do run.
const secret = path.join(tmp, 'segredo.txt');
fs.writeFileSync(secret, 'NAO-PODE-SAIR');
fs.symlinkSync(secret, path.join(seed('95003-link'), 'context.md'));

const { createDashboard } = require('./server');
const dash = createDashboard({ memoryDir: mainRuns });
let base;
test.before(async () => {
    await new Promise(r => dash.server.listen(0, '127.0.0.1', r));
    base = `http://localhost:${dash.server.address().port}`;
    await dash.ready;
});
test.after(() => dash.close());

const get = async p => { const r = await fetch(base + p); return { status: r.status, text: await r.text() }; };

test('API: devolve o context.md inteiro, não só o fim', async () => {
    const r = await get('/api/runs/95001-com/context');
    assert.strictEqual(r.status, 200);
    const body = JSON.parse(r.text);
    assert.deepStrictEqual([body.taskId, body.exists, body.archived], ['95001-com', true, false]);
    assert.strictEqual(body.markdown, FULL);
});

test('API: run sem context.md é estado vazio (200), não erro', async () => {
    const r = await get('/api/runs/95002-sem/context');
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(JSON.parse(r.text), { taskId: '95002-sem', archived: false, exists: false, markdown: null });
});

test('API: run inexistente, task-id inválido e traversal dão 404', async () => {
    for (const p of [
        '/api/runs/99999-nada/context',
        '/api/runs/..%2F..%2Fsegredo.txt/context',
        '/api/runs/..%2F95001-com/context',
        '/api/runs/%2Fetc%2Fpasswd/context',
        `/api/runs/${encodeURIComponent(secret)}/context`,
        '/api/runs/..%5C95001-com/context',
        '/api/runs/_archive/context',
        '/api/runs/a%20b/context',
    ]) {
        const r = await get(p);
        assert.ok(r.status === 404 || r.status === 400, `${p} -> ${r.status}`);
        assert.ok(!r.text.includes('NAO-PODE-SAIR') && !r.text.includes('linha 1'), p);
    }
});

test('API: context.md que é symlink para fora da pasta do run conta como ausente', async () => {
    const r = await get('/api/runs/95003-link/context');
    assert.strictEqual(r.status, 200);
    assert.ok(!r.text.includes('NAO-PODE-SAIR'));
    assert.strictEqual(JSON.parse(r.text).exists, false);
});

// Toda tag do HTML gerado tem de vir da lista do renderizador, com atributos conhecidos.
const TAGS = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'br', 'ul', 'ol', 'li', 'input', 'blockquote', 'pre', 'code', 'hr',
    'div', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'strong', 'em', 'del', 'a']);
const ATTRS = new Set(['class', 'href', 'target', 'rel', 'type', 'disabled', 'checked', 'style', 'start', 'data-lang']);
function assertOnlySafeTags(html) {
    for (const [, tag, attrs] of html.matchAll(/<\/?([a-zA-Z][\w-]*)([^>]*)>/g)) {
        assert.ok(TAGS.has(tag.toLowerCase()), `tag inesperada <${tag}> em ${html}`);
        for (const [, name] of attrs.matchAll(/\s([^\s=]+)(?:="[^"]*")?/g)) assert.ok(ATTRS.has(name), `atributo inesperado ${name} em <${tag}${attrs}>`);
        for (const [, href] of attrs.matchAll(/href="([^"]*)"/g)) assert.match(href, /^(https?:\/\/|mailto:)/i);
    }
}

test('render: Markdown comum (títulos, ênfase, listas, tarefas, citação, links)', () => {
    const html = MD.render([
        '# Título', '## Plano', 'Texto **forte**, *itálico*, ~~riscado~~ e `código`; snake_case_fica.',
        '2026-10-20T10:00:00Z [watcher] linha de log', '',
        '- um', '  - um.a', '- [x] feito', '- [ ] pendente', '1. primeiro', '2. segundo', '',
        '> citação **x**', '', '---', '[PR](https://ex.com/pr/1) e https://ex.com/a?b=1&c=2.',
    ].join('\n'));
    assert.match(html, /<h1>Título<\/h1>/);
    assert.match(html, /<h2>Plano<\/h2>/);
    assert.match(html, /<strong>forte<\/strong>, <em>itálico<\/em>, <del>riscado<\/del> e <code>código<\/code>; snake_case_fica\./);
    assert.match(html, /<br>2026-10-20T10:00:00Z \[watcher\] linha de log/, 'quebra de linha do log é mantida');
    assert.match(html, /<ul><li>um<ul><li>um\.a<\/li><\/ul><\/li><li class="md-task"><input type="checkbox" disabled checked> feito<\/li><li class="md-task"><input type="checkbox" disabled> pendente<\/li><\/ul><ol><li>primeiro<\/li><li>segundo<\/li><\/ol>/);
    assert.match(html, /<blockquote><p>citação <strong>x<\/strong><\/p><\/blockquote>/);
    assert.match(html, /<hr>/);
    assert.match(html, /<a href="https:\/\/ex\.com\/pr\/1" target="_blank" rel="noopener noreferrer">PR<\/a>/);
    assert.match(html, /<a href="https:\/\/ex\.com\/a\?b=1&amp;c=2" target="_blank" rel="noopener noreferrer">https:\/\/ex\.com\/a\?b=1&amp;c=2<\/a>\./);
    assertOnlySafeTags(html);
});

test('render: tabela GFM com alinhamento e conteúdo escapado', () => {
    const html = MD.render('| Nó | Status | n |\n|:---|:---:|---:|\n| plan | **ok** | 1 |\n| review | <b>x</b> | 2 |\n');
    assert.match(html, /<table><thead><tr><th style="text-align:left">Nó<\/th><th style="text-align:center">Status<\/th><th style="text-align:right">n<\/th><\/tr><\/thead>/);
    assert.match(html, /<tr><td style="text-align:left">plan<\/td><td style="text-align:center"><strong>ok<\/strong><\/td><td style="text-align:right">1<\/td><\/tr>/);
    assert.match(html, /<td style="text-align:center">&lt;b&gt;x&lt;\/b&gt;<\/td>/);
    assertOnlySafeTags(html);
});

test('render: bloco de código mantém o texto literal e escapado', () => {
    const html = MD.render('```js\nconst a = `<b>` + **nada**;\n# não é título\n```\ndepois');
    assert.match(html, /<pre class="md-code" data-lang="js"><code>const a = `&lt;b&gt;` \+ \*\*nada\*\*;\n# não é título<\/code><\/pre>/);
    assert.match(html, /<p>depois<\/p>/);
    assert.match(MD.render('```\nsem fim'), /<pre class="md-code"><code>sem fim<\/code><\/pre>/, 'fence sem fechamento não quebra');
    assertOnlySafeTags(html);
});

test('render: HTML/script injetado é neutralizado', () => {
    const evil = [
        '<script>alert(1)</script>',
        '<img src=x onerror=alert(1)>',
        '<iframe src="https://ex.com"></iframe>',
        '# <svg onload=alert(1)>',
        '- <a href="javascript:alert(1)">x</a>',
        '| <script>t</script> | b |', '|---|---|', '| c | <img src=x onerror=y> |', '',
        '[clique](javascript:alert(1)) [d](data:text/html,<script>x</script>) [v](vbscript:x) [j](JAVASCRIPT:x)',
        '[q](https://ex.com/" onmouseover="alert(1)) ![i](https://ex.com/a.png" onerror="x)',
        '`<script>` **<b onclick=x>y</b>** <https://ex.com/"onclick=x>',
        '\u0001999\u0002 \u00010\u0002',
    ].join('\n');
    const html = MD.render(evil);
    assertOnlySafeTags(html);
    assert.doesNotMatch(html, /<script|<img|<iframe|<svg|javascript:alert\(1\)"|href="(data|vbscript|javascript):/i);
    assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/, 'HTML cru aparece como texto');
    assert.match(html, /<h1>&lt;svg onload=alert\(1\)&gt;<\/h1>/);
    assert.match(html, /<code>&lt;script&gt;<\/code>/);
});

test('render: imagem vira link, sem carregar nada', () => {
    const html = MD.render('![diagrama](https://ex.com/d.png)');
    assert.strictEqual(html, '<p><a href="https://ex.com/d.png" target="_blank" rel="noopener noreferrer">🖼 diagrama</a></p>');
});

test('render: entrada vazia ou nula não quebra', () => {
    assert.strictEqual(MD.render(''), '');
    assert.strictEqual(MD.render(null), '');
    assert.strictEqual(MD.render('\r\n\r\n'), '');
});

test('index.html: carrega markdown.js antes de context-md.js e liga o canal ao vivo', () => {
    const html = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');
    const md = html.indexOf('<script src="markdown.js"></script>');
    const view = html.indexOf('<script src="context-md.js"></script>');
    assert.ok(md > 0 && view > md);
    assert.match(html, /msg\.type === 'context_update'\) \{[\s\S]{0,200}window\.ContextMd\?\.refresh\(msg\.taskId\)/);
});
