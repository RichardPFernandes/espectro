// node --test ui-verify-projection.test.js
// Projeção somente leitura de .prisma/ui-verify/ (PRI-361). Fail-closed: veredito ausente, inválido ou
// incoerente vira UNKNOWN, nunca PASSOU; a resolução de imagem nunca sai da pasta da task.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { listVerifications, readImage, isTaskId, isImageName } = require('./ui-verify-projection');

const tmpBase = process.env.CLAUDE_JOB_DIR ? path.join(process.env.CLAUDE_JOB_DIR, 'tmp') : os.tmpdir();
const tmp = fs.mkdtempSync(path.join(tmpBase, 'ui-verify-proj-'));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('dados')]);
let n = 0;
function root() {
    const r = path.join(tmp, `r${++n}`);
    fs.mkdirSync(r, { recursive: true });
    return r;
}
function task(r, id, { verdict, findings, files = {} } = {}) {
    const d = path.join(r, id);
    fs.mkdirSync(d, { recursive: true });
    // Mesma ordem do /verify-ui: PNGs, depois findings, e o veredito por último.
    for (const [name, buf] of Object.entries(files)) fs.writeFileSync(path.join(d, name), buf);
    if (findings !== undefined) fs.writeFileSync(path.join(d, 'findings.json'), JSON.stringify(findings));
    if (verdict !== undefined) fs.writeFileSync(path.join(d, 'verdict.json'), typeof verdict === 'string' ? verdict : JSON.stringify(verdict));
    return d;
}
const byId = (list, id) => list.find(t => t.taskId === id);

test('pasta inexistente ou vazia: lista vazia', () => {
    assert.deepStrictEqual(listVerifications(path.join(tmp, 'nao-existe')), []);
    assert.deepStrictEqual(listVerifications(root()), []);
});

test('veredito válido sai com problemas, telas e imagens', () => {
    const r = root();
    task(r, 'pri-361', {
        verdict: { verdict: 'FALHOU', problems: [{ code: 'ELEMENT_MISSING', where: 'AC-2 http://127.0.0.1:3399/', detail: 'elemento esperado ausente: Runs' }] },
        findings: { screens: [{ ac: 'AC-2', url: 'http://127.0.0.1:3399/', screenshot: '.prisma/ui-verify/pri-361/AC-2-runs.png', console: [{ level: 'error', text: 'x' }, { level: 'log', text: 'y' }], requests: [{ url: 'u', status: 200 }], expected: [{ selector: 'Runs', found: false }, { selector: 'Tabela', found: true }] }] },
        files: { 'AC-2-runs.png': PNG },
    });
    const t = byId(listVerifications(r), 'pri-361');
    assert.strictEqual(t.verdict, 'FALHOU');
    assert.strictEqual(t.problems[0].code, 'ELEMENT_MISSING');
    assert.deepStrictEqual(t.images, ['AC-2-runs.png']);
    assert.strictEqual(t.screens[0].ac, 'AC-2');
    assert.strictEqual(t.screens[0].image, 'AC-2-runs.png');
    assert.deepStrictEqual(t.screens[0].expected, { total: 2, found: 1 });
    assert.strictEqual(t.screens[0].consoleErrors, 1);
});

test('AC-4: verdict.json ausente, inválido, de tipo errado ou com valor desconhecido é UNKNOWN', () => {
    const r = root();
    task(r, 'sem-veredito');
    task(r, 'json-quebrado', { verdict: '{nao e json' });
    task(r, 'lista', { verdict: '[]' });
    task(r, 'valor-estranho', { verdict: { verdict: 'OK' } });
    task(r, 'sem-campo', { verdict: { problems: [] } });
    const list = listVerifications(r);
    for (const id of ['sem-veredito', 'json-quebrado', 'lista', 'valor-estranho', 'sem-campo']) {
        assert.strictEqual(byId(list, id).verdict, 'UNKNOWN', id);
        assert.ok(byId(list, id).reason, `${id} sem motivo`);
    }
});

test('AC-4: PASSOU com problemas listados é incoerente e vira UNKNOWN', () => {
    const r = root();
    task(r, 'incoerente', { verdict: { verdict: 'PASSOU', problems: [{ code: 'CONSOLE_ERROR', where: 'AC-1', detail: 'x' }] } });
    task(r, 'limpo', { verdict: { verdict: 'PASSOU', problems: [] } });
    const list = listVerifications(r);
    assert.strictEqual(byId(list, 'incoerente').verdict, 'UNKNOWN');
    assert.strictEqual(byId(list, 'limpo').verdict, 'PASSOU');
});

test('N/A e SKIPPED são preservados com o motivo', () => {
    const r = root();
    task(r, 'na', { verdict: { verdict: 'N/A', problems: [], reason: 'diff sem frontend' } });
    task(r, 'skip', { verdict: { verdict: 'SKIPPED', problems: [], reason: 'PRISMA_UI_VERIFY=off' } });
    const list = listVerifications(r);
    assert.strictEqual(byId(list, 'na').verdict, 'N/A');
    assert.strictEqual(byId(list, 'na').reason, 'diff sem frontend');
    assert.strictEqual(byId(list, 'skip').verdict, 'SKIPPED');
});

test('findings quebrado não derruba a task: telas vazias, veredito mantido', () => {
    const r = root();
    const d = task(r, 'f-quebrado', { verdict: { verdict: 'FALHOU', problems: [{ code: 'X', where: 'run', detail: 'd' }] } });
    fs.writeFileSync(path.join(d, 'findings.json'), '{quebrado');
    const depois = new Date(Date.now() + 60_000); // veredito gravado por último, como no /verify-ui
    fs.utimesSync(path.join(d, 'verdict.json'), depois, depois);
    const t = byId(listVerifications(r), 'f-quebrado');
    assert.strictEqual(t.verdict, 'FALHOU');
    assert.deepStrictEqual(t.screens, []);
});

test('nomes de task inválidos e entradas que não são pasta real são ignorados', () => {
    const r = root();
    task(r, 'ok', { verdict: { verdict: 'N/A', problems: [] } });
    task(r, '.oculta', { verdict: { verdict: 'N/A', problems: [] } });
    fs.writeFileSync(path.join(r, 'arquivo.txt'), 'x');
    const fora = path.join(tmp, `fora${n}`);
    fs.mkdirSync(fora);
    fs.writeFileSync(path.join(fora, 'verdict.json'), JSON.stringify({ verdict: 'PASSOU', problems: [] }));
    fs.symlinkSync(fora, path.join(r, 'link-para-fora'));
    assert.deepStrictEqual(listVerifications(r).map(t => t.taskId), ['ok']);
});

test('verdict.json que é symlink não vale (UNKNOWN), mesmo apontando para um PASSOU válido', () => {
    const r = root();
    const d = task(r, 'sym');
    const alvo = path.join(tmp, `alvo${n}.json`);
    fs.writeFileSync(alvo, JSON.stringify({ verdict: 'PASSOU', problems: [] }));
    fs.symlinkSync(alvo, path.join(d, 'verdict.json'));
    assert.strictEqual(byId(listVerifications(r), 'sym').verdict, 'UNKNOWN');
});

test('imagens: só PNG real e regular entra na lista; symlink e arquivo de outro tipo ficam de fora', () => {
    const r = root();
    const d = task(r, 'img', { verdict: { verdict: 'N/A', problems: [] }, files: { 'ok.png': PNG, 'falso.png': Buffer.from('texto'), 'nota.txt': Buffer.from('x') } });
    const alvo = path.join(tmp, `alvo-img${n}.png`);
    fs.writeFileSync(alvo, PNG);
    fs.symlinkSync(alvo, path.join(d, 'link.png'));
    assert.deepStrictEqual(byId(listVerifications(r), 'img').images, ['ok.png']);
});

test('limites: lista de problemas e de telas são cortadas', () => {
    const r = root();
    const problems = Array.from({ length: 80 }, (_, i) => ({ code: 'C', where: `w${i}`, detail: 'd'.repeat(2000) }));
    const screens = Array.from({ length: 80 }, (_, i) => ({ ac: `AC-${i}`, url: 'http://127.0.0.1/', console: [], requests: [], expected: [] }));
    task(r, 'grande', { verdict: { verdict: 'FALHOU', problems }, findings: { screens } });
    const t = byId(listVerifications(r), 'grande');
    assert.ok(t.problems.length <= 50);
    assert.ok(t.problems[0].detail.length <= 300);
    assert.ok(t.screens.length <= 50);
});

test('limit corta a lista e a ordem é a da mais recente', () => {
    const r = root();
    for (const id of ['a', 'b', 'c']) task(r, id, { verdict: { verdict: 'N/A', problems: [] } });
    const antigo = new Date(Date.now() - 3600_000);
    fs.utimesSync(path.join(r, 'a', 'verdict.json'), antigo, antigo);
    const list = listVerifications(r, { limit: 2 });
    assert.strictEqual(list.length, 2);
    assert.ok(!list.some(t => t.taskId === 'a'));
});

test('AC-5: isTaskId e isImageName recusam travessia, barra, ponto inicial e extensão errada', () => {
    for (const bad of ['', '.', '..', '../x', 'a/b', 'a\\b', '.oculto', 'a\0b', 'x'.repeat(200)]) assert.strictEqual(isTaskId(bad), false, JSON.stringify(bad));
    assert.strictEqual(isTaskId('pri-361'), true);
    for (const bad of ['', 'a.jpg', '../a.png', 'a/b.png', '.a.png', 'a.png/..', 'a.PNG.txt']) assert.strictEqual(isImageName(bad), false, JSON.stringify(bad));
    assert.strictEqual(isImageName('AC-1-runs.png'), true);
});

test('AC-5: readImage devolve os bytes só de PNG regular dentro da pasta da task', () => {
    const r = root();
    task(r, 't', { files: { 'a.png': PNG, 'falso.png': Buffer.from('texto'), 'x.txt': Buffer.from('x') } });
    assert.ok(readImage(r, 't', 'a.png').equals(PNG));
    assert.strictEqual(readImage(r, 't', 'falso.png'), null);
    assert.strictEqual(readImage(r, 't', 'x.txt'), null);
    assert.strictEqual(readImage(r, 't', 'nao-existe.png'), null);
    assert.strictEqual(readImage(r, 't', '../t/a.png'), null);
    assert.strictEqual(readImage(r, '..', 'a.png'), null);
});

test('AC-5: readImage recusa symlink de arquivo e de pasta que saem da raiz', () => {
    const r = root();
    const d = task(r, 't');
    const fora = path.join(tmp, `fora-img${n}`);
    fs.mkdirSync(fora);
    fs.writeFileSync(path.join(fora, 'segredo.png'), PNG);
    fs.symlinkSync(path.join(fora, 'segredo.png'), path.join(d, 'link.png'));
    assert.strictEqual(readImage(r, 't', 'link.png'), null);
    fs.symlinkSync(fora, path.join(r, 'pasta-link'));
    assert.strictEqual(readImage(r, 'pasta-link', 'segredo.png'), null);
});

test('readImage com raiz inexistente devolve null', () => {
    assert.strictEqual(readImage(path.join(tmp, 'nada'), 't', 'a.png'), null);
});

test('readImage recusa PNG acima do limite de tamanho', () => {
    const r = root();
    task(r, 't', { files: { 'grande.png': Buffer.concat([PNG, Buffer.alloc(11 * 1024 * 1024)]) } });
    assert.strictEqual(readImage(r, 't', 'grande.png'), null);
    assert.deepStrictEqual(byId(listVerifications(r), 't').images, []);
});

test('veredito anterior aos achados é UNKNOWN (rodada nova caiu antes de rodar o verdict)', () => {
    const r = root();
    const d = task(r, 'velho', { verdict: { verdict: 'PASSOU', problems: [] }, findings: { screens: [] } });
    const antigo = new Date(Date.now() - 60_000);
    fs.utimesSync(path.join(d, 'verdict.json'), antigo, antigo);
    const t = byId(listVerifications(r), 'velho');
    assert.strictEqual(t.verdict, 'UNKNOWN');
    assert.match(t.reason, /anterior/);
});

test('veredito anterior a um PNG novo também é UNKNOWN; veredito mais novo vale', () => {
    const r = root();
    const d = task(r, 'png-novo', { verdict: { verdict: 'PASSOU', problems: [] }, files: { 'a.png': PNG } });
    const antigo = new Date(Date.now() - 60_000);
    fs.utimesSync(path.join(d, 'verdict.json'), antigo, antigo);
    assert.strictEqual(byId(listVerifications(r), 'png-novo').verdict, 'UNKNOWN');
    const agora = new Date(Date.now() + 60_000);
    fs.utimesSync(path.join(d, 'verdict.json'), agora, agora);
    assert.strictEqual(byId(listVerifications(r), 'png-novo').verdict, 'PASSOU');
});

test('screenshot de outra task nos achados não vira imagem desta task', () => {
    const r = root();
    const mk = shot => task(r, `t${shot.length}`, {
        verdict: { verdict: 'N/A', problems: [] },
        findings: { screens: [{ ac: 'AC-1', url: 'http://127.0.0.1/', screenshot: shot, console: [], requests: [{ status: 200 }], expected: [{ selector: 'x', found: true }] }] },
        files: { 'AC-1.png': PNG },
    });
    mk('.prisma/ui-verify/outra/AC-1.png');   // pasta de outra task
    mk('../x/AC-1.png');                       // travessia
    const proprio = task(r, 'propria', {
        verdict: { verdict: 'N/A', problems: [] },
        findings: { screens: [{ ac: 'AC-1', url: 'http://127.0.0.1/', screenshot: '.prisma/ui-verify/propria/AC-1.png', console: [], requests: [{ status: 200 }], expected: [{ selector: 'x', found: true }] }] },
        files: { 'AC-1.png': PNG },
    });
    assert.ok(proprio);
    const list = listVerifications(r);
    assert.strictEqual(byId(list, 'propria').screens[0].image, 'AC-1.png');
    for (const t of list.filter(x => x.taskId !== 'propria')) assert.strictEqual(t.screens[0].image, null, t.taskId);
});

test('limit lê só as tasks pedidas (as mais recentes), sem processar as demais', () => {
    const r = root();
    for (let i = 0; i < 6; i++) {
        const d = task(r, `k${i}`, { verdict: { verdict: 'N/A', problems: [] } });
        const t = new Date(Date.now() - i * 60_000);
        fs.utimesSync(path.join(d, 'verdict.json'), t, t);
        fs.utimesSync(d, t, t);
    }
    assert.deepStrictEqual(listVerifications(r, { limit: 2 }).map(x => x.taskId), ['k0', 'k1']);
});
