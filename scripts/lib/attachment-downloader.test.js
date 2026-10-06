const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { execFile } = require('child_process');
const XLSX = require('xlsx');
const { downloadAttachments, classify, safeFilename, maxSizeFromEnv } = require('./attachment-downloader');

const API_KEY = 'chave-secreta-redmine-1234567890';
const EXPECTED_AUTH = `Basic ${Buffer.from(`${API_KEY}:${API_KEY}`).toString('base64')}`;
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');

function makeXlsx() {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['uf', 'cidade'], ['SP', 'Campinas'], ['MG', 'Uberaba'], ['PR', 'Londrina']]), 'Dados');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['x']]), 'Outra');
    return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

// DOCX mínimo válido, montado com o writer de zip que vem no SheetJS.
function makeDocx(text) {
    const cfb = XLSX.CFB.utils.cfb_new();
    const add = (name, xml) => XLSX.CFB.utils.cfb_add(cfb, name, Buffer.from(xml));
    add('[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
    add('_rels/.rels', '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
    add('word/document.xml', `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`);
    return Buffer.from(XLSX.CFB.write(cfb, { fileType: 'zip', type: 'buffer' }));
}

function startServer(routes) {
    const requests = [];
    const server = http.createServer((req, res) => {
        requests.push({ url: req.url, auth: req.headers.authorization });
        const route = routes[req.url];
        if (!route) { res.writeHead(404); return res.end(); }
        if (route.redirect) { res.writeHead(302, { location: route.redirect }); return res.end(); }
        if (req.headers.authorization !== EXPECTED_AUTH) { res.writeHead(401); return res.end(); }
        res.writeHead(200, route.headers || {});
        res.end(route.body);
    });
    return new Promise(resolve => server.listen(0, '127.0.0.1', () => {
        resolve({ server, requests, url: `http://127.0.0.1:${server.address().port}` });
    }));
}

function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'anexos-')); }

function fakePdftotext(dir) {
    const bin = path.join(dir, 'pdftotext');
    fs.writeFileSync(bin, '#!/bin/sh\necho "Requisito: agrupar por UF.\nSegunda linha." > "$2"\n', { mode: 0o755 });
    return bin;
}

function att(id, filename, content_type, base, extra = {}) {
    return { id, filename, content_type, filesize: 100, content_url: `${base}/attachments/download/${id}/${encodeURIComponent(filename)}`, ...extra };
}

test('classify: tipo por content_type/extensão; extensão executável/compactada força raw', () => {
    assert.strictEqual(classify({ filename: 'a.png', content_type: 'image/png' }), 'image');
    assert.strictEqual(classify({ filename: 'a.jpg', content_type: 'application/octet-stream' }), 'image');
    assert.strictEqual(classify({ filename: 'a.pdf', content_type: 'application/pdf' }), 'pdf');
    assert.strictEqual(classify({ filename: 'a.docx', content_type: 'application/octet-stream' }), 'docx');
    assert.strictEqual(classify({ filename: 'a.xlsx', content_type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), 'xlsx');
    assert.strictEqual(classify({ filename: 'x.sh', content_type: 'image/png' }), 'raw');
    assert.strictEqual(classify({ filename: 'x.zip', content_type: 'application/pdf' }), 'raw');
    assert.strictEqual(classify({ filename: 'x.svg', content_type: 'image/svg+xml' }), 'raw');
    assert.strictEqual(classify({ filename: 'log.txt', content_type: 'text/plain' }), 'raw');
});

test('safeFilename: sem diretório/traversal, sem arquivo oculto, colisão ganha prefixo com id', () => {
    const used = new Set();
    assert.strictEqual(safeFilename({ id: 1, filename: '../../etc/passwd' }, used), 'passwd');
    assert.strictEqual(safeFilename({ id: 2, filename: '..\\..\\win.ini' }, used), 'win.ini');
    assert.strictEqual(safeFilename({ id: 3, filename: '.bashrc' }, used), 'bashrc');
    assert.strictEqual(safeFilename({ id: 4, filename: '' }, used), 'anexo-4');
    assert.strictEqual(safeFilename({ id: 5, filename: 'attachments.json' }, used), 'anexo-5-attachments.json');
    used.add('print.png');
    assert.strictEqual(safeFilename({ id: 6, filename: 'Print.PNG' }, used), '6-Print.PNG');
});

test('maxSizeFromEnv: padrão 10 MB, configurável em MB, valor inválido cai no padrão', () => {
    assert.strictEqual(maxSizeFromEnv({}), 10 * 1024 * 1024);
    assert.strictEqual(maxSizeFromEnv({ MAX_ATTACHMENT_SIZE_MB: '2' }), 2 * 1024 * 1024);
    assert.strictEqual(maxSizeFromEnv({ MAX_ATTACHMENT_SIZE_MB: 'abc' }), 10 * 1024 * 1024);
});

test('sem anexos: não cria diretório nem faz request', async () => {
    const dest = path.join(tmpDir(), 'nada');
    const r = await downloadAttachments([], dest, { apiKey: API_KEY, redmineUrl: 'http://x', fetchImpl: () => assert.fail('não deveria buscar') });
    assert.deepStrictEqual(r, { downloaded: [], skipped: [] });
    assert.strictEqual(fs.existsSync(dest), false);
});

test('baixa e converte cada tipo, com auth Basic key:key', async t => {
    const docx = makeDocx('Tela de agrupamento por UF');
    const { server, requests, url } = await startServer({
        '/attachments/download/1/print.png': { body: PNG },
        '/attachments/download/2/req.pdf': { body: Buffer.from('%PDF-1.4 fake') },
        '/attachments/download/3/dados.xlsx': { body: makeXlsx() },
        '/attachments/download/4/spec.docx': { body: docx },
        '/attachments/download/5/deploy.sh': { body: 'rm -rf /' },
    });
    t.after(() => server.close());
    const dir = tmpDir();
    const dest = path.join(dir, '43000-attachments');
    const r = await downloadAttachments([
        att(1, 'print.png', 'image/png', url),
        att(2, 'req.pdf', 'application/pdf', url),
        att(3, 'dados.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', url),
        att(4, 'spec.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', url),
        att(5, 'deploy.sh', 'image/png', url),
    ], dest, { apiKey: API_KEY, redmineUrl: url, pdftotextPath: fakePdftotext(dir) });

    assert.deepStrictEqual(r.skipped, []);
    assert.ok(requests.every(q => q.auth === EXPECTED_AUTH));
    const byId = Object.fromEntries(r.downloaded.map(d => [d.id, d]));

    assert.strictEqual(byId[1].type, 'image');
    assert.deepStrictEqual(fs.readFileSync(path.join(dest, 'print.png')), PNG);
    assert.strictEqual(byId[1].converted_path, undefined);

    assert.strictEqual(byId[2].type, 'pdf');
    assert.ok(fs.existsSync(path.join(dest, 'req.pdf')));
    assert.strictEqual(byId[2].converted_path, path.join(dest, 'req.txt'));
    assert.match(byId[2].excerpt, /agrupar por UF/);

    assert.strictEqual(byId[3].type, 'xlsx');
    assert.strictEqual(fs.readFileSync(path.join(dest, 'dados.csv'), 'utf8').split('\n')[1], 'SP,Campinas');
    assert.strictEqual(byId[3].excerpt, 'uf,cidade\nSP,Campinas\nMG,Uberaba');
    assert.match(byId[3].warnings[0], /2 sheets/);

    assert.strictEqual(byId[4].type, 'docx');
    assert.match(fs.readFileSync(path.join(dest, 'spec.md'), 'utf8'), /Tela de agrupamento por UF/);

    assert.strictEqual(byId[5].type, 'raw');
    assert.strictEqual(byId[5].converted_path, undefined);
    assert.deepStrictEqual(fs.readdirSync(dest).sort(), ['dados.csv', 'dados.xlsx', 'deploy.sh', 'print.png', 'req.pdf', 'req.txt', 'spec.docx', 'spec.md']);
});

test('PDF sem pdftotext: salva só o PDF, com aviso', async t => {
    const { server, url } = await startServer({ '/attachments/download/2/req.pdf': { body: '%PDF' } });
    t.after(() => server.close());
    const dest = tmpDir();
    const r = await downloadAttachments([att(2, 'req.pdf', 'application/pdf', url)], dest, { apiKey: API_KEY, redmineUrl: url, pdftotextPath: null });
    assert.strictEqual(r.downloaded[0].converted_path, undefined);
    assert.match(r.downloaded[0].warnings[0], /pdftotext não encontrado/);
    assert.deepStrictEqual(fs.readdirSync(dest), ['req.pdf']);
});

test('conversão que falha vira aviso e mantém o original', async t => {
    const { server, url } = await startServer({ '/attachments/download/4/ruim.docx': { body: 'não é zip' } });
    t.after(() => server.close());
    const dest = tmpDir();
    const r = await downloadAttachments([att(4, 'ruim.docx', 'application/octet-stream', url)], dest, { apiKey: API_KEY, redmineUrl: url });
    assert.strictEqual(r.downloaded.length, 1);
    assert.match(r.downloaded[0].warnings[0], /conversão docx falhou/);
    assert.ok(fs.existsSync(path.join(dest, 'ruim.docx')));
});

test('acima do limite: pula sem baixar (metadado) ou aborta no stream (metadado mentindo)', async t => {
    const { server, requests, url } = await startServer({
        '/attachments/download/2/mentiroso.bin': { body: Buffer.alloc(3000) },
        '/attachments/download/3/ok.png': { body: PNG },
    });
    t.after(() => server.close());
    const dest = tmpDir();
    const warnings = [];
    const r = await downloadAttachments([
        att(1, 'grande.pdf', 'application/pdf', url, { filesize: 15 * 1024 * 1024 }),
        att(2, 'mentiroso.bin', 'application/octet-stream', url, { filesize: 10 }),
        att(3, 'ok.png', 'image/png', url),
    ], dest, { apiKey: API_KEY, redmineUrl: url, maxSizeBytes: 2048, onWarning: w => warnings.push(w) });

    assert.deepStrictEqual(r.skipped.map(s => [s.id, s.reason]), [[1, 'size_exceeded'], [2, 'size_exceeded']]);
    assert.strictEqual(r.skipped[0].filesize, 15 * 1024 * 1024);
    assert.ok(!requests.some(q => q.url.includes('/1/')), 'o de 15 MB não pode ser requisitado');
    assert.deepStrictEqual(r.downloaded.map(d => d.id), [3]);
    assert.deepStrictEqual(fs.readdirSync(dest), ['ok.png'], 'download parcial não fica no disco');
    assert.strictEqual(warnings.length, 2);
});

test('falha de download (404) não interrompe os demais', async t => {
    const { server, url } = await startServer({ '/attachments/download/2/ok.png': { body: PNG } });
    t.after(() => server.close());
    const r = await downloadAttachments([att(1, 'sumiu.png', 'image/png', url), att(2, 'ok.png', 'image/png', url)], tmpDir(), { apiKey: API_KEY, redmineUrl: url });
    assert.deepStrictEqual(r.skipped.map(s => [s.id, s.reason, s.error]), [[1, 'download_failed', 'HTTP 404']]);
    assert.deepStrictEqual(r.downloaded.map(d => d.id), [2]);
});

test('credencial nunca vai pra outra origem: content_url estrangeiro é remontado sobre REDMINE_URL; redirect cross-origin falha', async t => {
    const other = await startServer({ '/attachments/download/1/a.png': { body: 'x' }, '/roubo': { body: 'x' } });
    const main = await startServer({
        '/attachments/download/1/a.png': { body: PNG },
        '/attachments/download/2/r.png': { redirect: `${other.url}/roubo` },
    });
    t.after(() => { other.server.close(); main.server.close(); });
    const r = await downloadAttachments([
        att(1, 'a.png', 'image/png', other.url), // host_name interno do Redmine ≠ REDMINE_URL
        att(2, 'r.png', 'image/png', main.url),
        { id: 'x', filename: 'b.png', content_type: 'image/png', filesize: 1, content_url: `${other.url}/roubo` },
    ], tmpDir(), { apiKey: API_KEY, redmineUrl: `${main.url}/` });
    assert.deepStrictEqual(r.downloaded.map(d => d.id), [1]);
    assert.deepStrictEqual(r.skipped.map(s => [s.id, s.reason]), [[2, 'download_failed'], ['x', 'foreign_host']]);
    assert.match(r.skipped[0].error, /outra origem/);
    assert.strictEqual(other.requests.length, 0);
});

test('sem REDMINE_API_KEY: pula com motivo, não quebra', async () => {
    const r = await downloadAttachments([att(1, 'a.png', 'image/png', 'http://127.0.0.1:1')], tmpDir(), { apiKey: '', redmineUrl: 'http://127.0.0.1:1' });
    assert.deepStrictEqual(r.skipped.map(s => s.reason), ['missing_api_key']);
});

function runCli(args, { input, env }) {
    return new Promise(resolve => {
        const child = execFile(process.execPath, [path.join(__dirname, 'attachment-downloader.js'), ...args], { env }, (err, stdout, stderr) => {
            resolve({ code: err ? err.code : 0, stdout, stderr });
        });
        if (input !== undefined) child.stdin.end(input);
    });
}

test('CLI: grava manifesto, e a API key não aparece em stdout, stderr nem em arquivo gerado', async t => {
    // Servidor ecoa a key no corpo/erro pra provar que a redação cobre tudo que sai.
    const { server, url } = await startServer({ '/attachments/download/1/print.png': { body: PNG } });
    t.after(() => server.close());
    const cwd = tmpDir();
    const dest = path.join(cwd, 'out');
    const attachments = [
        att(1, 'print.png', 'image/png', url),
        att(2, `falha-${API_KEY}.png`, 'image/png', url),
        att(3, 'grande.pdf', 'application/pdf', url, { filesize: 15 * 1024 * 1024 }),
    ];
    const env = { PATH: process.env.PATH, REDMINE_URL: url, REDMINE_API_KEY: API_KEY };
    const r = await runCli(['43000', '--dest', dest], { input: JSON.stringify({ issue: { attachments } }), env });
    assert.strictEqual(r.code, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.deepStrictEqual(out.downloaded.map(d => d.id), [1]);
    assert.deepStrictEqual(out.skipped.map(s => s.reason), ['download_failed', 'size_exceeded']);
    assert.match(r.stderr, /size_exceeded/);

    const everything = [r.stdout, r.stderr, ...fs.readdirSync(dest).map(f => fs.readFileSync(path.join(dest, f), 'latin1'))].join('\n');
    assert.ok(!everything.includes(API_KEY), 'API key vazou');
    assert.ok(!everything.includes(EXPECTED_AUTH.slice(6)), 'header Authorization vazou');
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(dest, 'attachments.json'), 'utf8')), out);
});

test('CLI: uso incorreto e JSON inválido saem com 2; lista vazia não cria diretório', async () => {
    const env = { PATH: process.env.PATH };
    assert.strictEqual((await runCli([], { input: '[]', env })).code, 2);
    assert.strictEqual((await runCli(['43000'], { input: '{nope', env })).code, 2);
    const dest = path.join(tmpDir(), 'vazio');
    const r = await runCli(['43000', '--dest', dest], { input: '[]', env });
    assert.strictEqual(r.code, 0);
    assert.strictEqual(fs.existsSync(dest), false);
});
