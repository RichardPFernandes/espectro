// node --test scripts/lib/prompt-context.test.js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const pc = require('./prompt-context');
const { buildSanitizer } = require('../sanitize-log');

const tmpRoot = fs.mkdtempSync(path.join(process.env.CLAUDE_JOB_DIR ? path.join(process.env.CLAUDE_JOB_DIR, 'tmp') : os.tmpdir(), 'prompt-context-'));

function makeRepo(name, files) {
    const dir = path.join(tmpRoot, name);
    fs.mkdirSync(dir, { recursive: true });
    const g = args => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
    g(['init', '-q']);
    g(['config', 'user.email', 't@t']);
    g(['config', 'user.name', 't']);
    for (const [f, c] of Object.entries(files)) {
        fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
        fs.writeFileSync(path.join(dir, f), c);
    }
    g(['add', '-A']);
    g(['commit', '-qm', 'init']);
    return dir;
}

test('truncate: curto passa intacto; longo corta no limite e marca', () => {
    assert.strictEqual(pc.truncate('abc', 5), 'abc');
    assert.strictEqual(pc.truncate(null, 5), '');
    const out = pc.truncate('x'.repeat(10), 4);
    assert.strictEqual(out, 'xxxx\n[... truncado para reduzir tokens ...]');
});

test('compressedTree: colapsa cadeia de filho único e respeita o teto de nós', () => {
    const files = [];
    for (let i = 0; i < 50; i++) files.push(`src/main/java/br/com/app/mod${i}/A.java`);
    files.push('pom.xml', 'docs/a.md');
    const tree = pc.compressedTree(files, 10);
    assert.ok(tree.length <= 11, tree.join('\n'));
    assert.ok(tree.some(l => l.startsWith('src/main/java/br/com/app')), tree.join('\n'));
    assert.ok(tree.includes('./* (1)'));
});

test('ticketKeywords/keywordPaths: sem acento, sem stopword, ranqueia por nº de termos', () => {
    const kw = pc.ticketKeywords('Ajuste na Expedição: ordenação da portaria quando o cliente filtra');
    assert.ok(kw.includes('expedicao') && kw.includes('portaria') && kw.includes('ordenacao'));
    assert.ok(!kw.includes('quando') && !kw.includes('cliente'));
    const paths = pc.keywordPaths(['a/ExpedicaoPortariaService.java', 'b/Expedicao.java', 'c/Outro.java'], kw);
    assert.deepStrictEqual(paths, ['a/ExpedicaoPortariaService.java', 'b/Expedicao.java']);
});

test('planContextBlock: trunca descrição/context.md, lista citados e nomes, nunca conteúdo', () => {
    const repo = makeRepo('plan-app-back', {
        'src/main/java/x/ControlePortariaService.java': 'class ControlePortariaService { SEGREDO_DE_CONTEUDO }',
        'src/main/java/x/Outro.java': 'class Outro {}',
    });
    const secret = 'tok_' + 'z'.repeat(20);
    const sanitize = buildSanitizer({ REDMINE_API_KEY: secret }, { onWarning: () => {} });
    const block = pc.planContextBlock({
        ticket: { id: 1, subject: 'Portaria', description: `Corrigir ControlePortariaService ${secret} ` + 'y'.repeat(5000) },
        contextMd: 'c'.repeat(7000),
        repos: [{ name: 'app-back', path: repo }],
        sanitize,
    });
    assert.ok(block.includes('app-back/src/main/java/x/ControlePortariaService.java'));
    assert.ok(!block.includes('SEGREDO_DE_CONTEUDO'), 'conteúdo de arquivo não entra no plan');
    assert.ok(!block.includes(secret), 'secret redigido');
    assert.ok(block.includes('[REDACTED]'));
    assert.ok(!block.includes('y'.repeat(3100)), 'descrição truncada em 3000');
    assert.ok(!block.includes('c'.repeat(6001)), 'context.md truncado em 6000');
    assert.strictEqual((block.match(/truncado para reduzir tokens/g) || []).length, 2);
});

test('reviewContextBlock: diff real (inclui novo), nada de arquivo não modificado; secret só por arquivo', () => {
    const repo = makeRepo('review-app-back', {
        'a.js': 'const a = 1;\n',
        'intocado.js': 'const INTOCADO = 1;\n',
    });
    const secret = 'ATATT' + 'Q'.repeat(30);
    fs.writeFileSync(path.join(repo, 'a.js'), 'const a = 2;\n');
    fs.writeFileSync(path.join(repo, 'novo.js'), `const t = "${secret}";\n`);
    const sanitize = buildSanitizer({ BITBUCKET_API_TOKEN: secret }, { onWarning: () => {} });
    const block = pc.reviewContextBlock({ repos: [{ name: 'app-back', path: repo }], contextMd: 'ctx', sanitize });
    assert.ok(block.includes('+const a = 2;'));
    assert.ok(block.includes('novo.js'));
    assert.ok(!block.includes('INTOCADO'), 'arquivo não modificado nunca entra');
    assert.ok(!block.includes(secret), 'valor do secret nunca entra no prompt');
    assert.match(block, /Item 1 \(secret no diff\): ENCONTRADO — app-back\/novo\.js/);
    assert.match(block, /Item 3 \(lint\): OK/);
});

test('reviewContextBlock: memory/ versionada em branch antiga não entra no diff', () => {
    const repo = makeRepo('mem-app-back', { 'memory/runs/t/state.json': '{}\n', 'c.js': 'x();\n' });
    fs.writeFileSync(path.join(repo, 'memory/runs/t/state.json'), '{"node":"review"}\n');
    fs.writeFileSync(path.join(repo, 'memory/runs/t/context.md'), 'novo\n');
    fs.writeFileSync(path.join(repo, 'c.js'), 'y();\n');
    const block = pc.reviewContextBlock({ repos: [{ name: 'app-back', path: repo }] });
    assert.ok(block.includes('+y();'));
    assert.ok(!block.includes('memory/runs'), block);
});

test('runLint: .js quebrado e whitespace no diff reprovam com o arquivo citado', () => {
    const repo = makeRepo('lint-app-back', { 'b.js': 'ok();\n' });
    fs.writeFileSync(path.join(repo, 'b.js'), 'function ( {\n');
    const diff = pc.collectRepoDiff({ name: 'app-back', path: repo });
    const lint = pc.runLint([diff]);
    assert.strictEqual(lint.ok, false);
    assert.match(lint.summary, /app-back\/b\.js: node --check/);
});

test('reviewContextBlock: diff acima do teto vira lista de omitidos', () => {
    const repo = makeRepo('big-app-back', { 'big.txt': 'a\n' });
    fs.writeFileSync(path.join(repo, 'big.txt'), 'b'.repeat(pc.REVIEW_DIFF_MAX_CHARS + 10) + '\n');
    const block = pc.reviewContextBlock({ repos: [{ name: 'app-back', path: repo }] });
    assert.match(block, /diff omitido por tamanho.*app-back\/big\.txt/);
    assert.ok(block.length < pc.REVIEW_DIFF_MAX_CHARS);
});

test('reviewContextBlock: contrato OpenAPI da task vira Item 8 com [FAIL] do DTO; sem contrato, sem linha', () => {
    const pkg = 'src/main/java/x';
    const repo = makeRepo('openapi-app-back', {
        [`${pkg}/dto/CargaRequest.java`]: 'package x.dto;\npublic record CargaRequest(String oidViagem) {}\n',
        [`${pkg}/CargaResource.java`]: 'package x;\n@Path("carga")\npublic class CargaResource {}\n',
    });
    fs.writeFileSync(path.join(repo, pkg, 'CargaResource.java'), `package x;
@Path("carga")
public class CargaResource {
    @POST
    @Path("liberar")
    public Response liberar(CargaRequest request) {
        return ResponseFactory.ok("ok");
    }
}
`);
    const contractPath = path.join(tmpRoot, 'openapi-contract.yaml');
    fs.writeFileSync(contractPath, `openapi: 3.0.3
paths:
  /carga/liberar:
    post:
      requestBody:
        content:
          application/json:
            schema:
              type: object
              properties:
                oidViagem: { type: string }
                emails: { type: array, items: { type: string } }
      responses:
        '200': { description: ok }
`);
    const repos = [{ name: 'app-back', path: repo }];
    const block = pc.reviewContextBlock({ repos, contractPath });
    assert.match(block, /Item 8 \(contrato OpenAPI\): FALHA — 1 \[FAIL\]/);
    assert.match(block, /\[FAIL\] OpenAPI POST \/carga\/liberar — missing_field: campo "emails".*src\/main\/java\/x\/dto\/CargaRequest\.java/);
    assert.ok(!pc.reviewContextBlock({ repos }).includes('Item 8'));
    assert.ok(!pc.reviewContextBlock({ repos, contractPath: path.join(tmpRoot, 'nao-existe.yaml') }).includes('Item 8'));
});

test.after(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));
