// node --test scripts/lib/roadmap-site.test.js
// Camada de dados da página do roadmap: lê roadmap/fase-*/FASE.md com o parser do lint.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { loadRoadmap, render, main } = require('./roadmap-site');
const lint = require('./roadmap-lint');

const REPO = path.resolve(__dirname, '..', '..');
const SEP = '| -- | -- | -- | -- | -- |';

// Duas fases com colunas em ordens diferentes e uma coluna extra desconhecida.
const FASES = {
    'roadmap/fase-1-um/FASE.md': ['# Fase 1 — Um', '', '> 6 semanas · 23/11/2026 a 15/01/2027 (D14) · Status: em andamento. Texto.', '',
        '| ID | Fatia | Dias | Nível | AUTORIZO | Depende de | Status | Issue no Linear | Extra |',
        '| -- | -- | -- | -- | -- | -- | -- | -- | -- |',
        '| F1.1 | [Lista **de** flags](x.md) | 5 + 5 | Alto ao ligar | — | — | removida em 2026-11-20: x | [PRI-1](http://l) | ? |',
        '| F1.2 | Retorno | a definir | Leve | Sim | F1.1 | ligada (15/11) | sem issue | ? |',
        '| F1.3 | Régua | 3 | Médio | Não | F1.1, F1.2 | em spec | PRI-3 | ? |'].join('\n'),
    'roadmap/fase-2-dois/FASE.md': ['# Fase 2 — Dois', '', '> Sem agenda · Status: não iniciada', '',
        '| Status | Nova coluna | Fatia e demonstração | ID | Depende de |', SEP,
        '| não iniciada | x | Portão | F2.1 | Fase 1, F1.3 |'].join('\n'),
    'roadmap/fase-3-tres/FASE.md': ['# Fase 3 — Três', '', '> 7 semanas · 18/01 a 05/03/2027 · Status: não iniciada · Abre depois.', '',
        '| ID | Fatia | Status |', '| -- | -- | -- |', '| F3.1 | Sem dias nem nível | em spec |'].join('\n'),
};

function withRoot(fn) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'roadmap-site-'));
    try {
        for (const [rel, content] of Object.entries(FASES)) {
            fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
            fs.writeFileSync(path.join(root, rel), content);
        }
        return fn(loadRoadmap(root));
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
}

test('fatias: nome limpo, dias somados, status base, alto e deps', () => withRoot(({ phases }) => {
    assert.deepStrictEqual(phases.map(p => [p.n, p.name]), [[1, 'Um'], [2, 'Dois'], [3, 'Três']]);
    const [a, b, c] = phases[0].slices;
    assert.deepStrictEqual(a, { id: 'F1.1', phase: 1, name: 'Lista de flags', dias: 10, nivel: 'Alto ao ligar',
        autorizo: '—', alto: true, status: 'removida', deps: [], issue: 'PRI-1' });
    assert.deepStrictEqual([b.dias, b.alto, b.status, b.deps], [null, true, 'ligada', ['F1.1']]);
    assert.deepStrictEqual([c.dias, c.alto, c.status, c.deps], [3, false, 'em spec', ['F1.1', 'F1.2']]);
    assert.strictEqual(phases[1].slices[0].name, 'Portão');
    assert.strictEqual(phases[0].status, 'em andamento');
}));

test('datas: com ano no início, sem ano no início e sem agenda', () => withRoot(({ phases }) => {
    assert.deepStrictEqual([phases[0].start, phases[0].end], ['2026-11-23', '2027-01-15']);
    assert.deepStrictEqual([phases[2].start, phases[2].end], ['2027-01-18', '2027-03-05']);
    assert.deepStrictEqual([phases[1].start, phases[1].end, phases[1].status], [null, null, 'não iniciada']);
}));

test('tabela sem as colunas Dias e Nível não quebra', () => withRoot(({ phases }) => {
    const [s] = phases[2].slices;
    assert.deepStrictEqual([s.dias, s.nivel, s.autorizo, s.issue, s.alto], [null, '', '', '', false]);
}));

test('repo real: 7 fases, ids, status no vocabulário e mesmos ids do lint', () => {
    const { phases } = loadRoadmap(REPO);
    assert.deepStrictEqual(phases.map(p => p.n), [0, 1, 2, 3, 4, 5, 6]);
    const slices = phases.flatMap(p => p.slices);
    for (const s of slices) {
        assert.match(s.id, /^F\d+\.\d+$/);
        assert.ok(lint.STATUS_VOCAB.includes(s.status), `${s.id}: status "${s.status}"`);
    }
    const expected = phases.flatMap(p => lint.parseSlices(fs.readFileSync(path.join(REPO, p.file), 'utf8'), p.file).map(s => s.id));
    assert.deepStrictEqual(slices.map(s => s.id), expected);
});

// Página HTML: render(model, { today, commit, generatedAt }) e a CLI.
const OPTS = { today: '2026-11-18', commit: 'abcdef1234567', generatedAt: '2026-11-18 12:00 UTC' };
const sl = (id, status, dias, extra = {}) => ({ id, phase: 1, name: id, dias, nivel: 'Leve', autorizo: 'Não', alto: false, status, deps: [], issue: '', ...extra });
const modelo = slices => ({ phases: [{ n: 1, name: 'Um', file: 'x', status: 'em andamento', start: '2026-11-23', end: '2027-01-15', slices }] });
const attr = (html, id) => new RegExp(`<li data-id="${id}" data-status="([^"]+)"`).exec(html)?.[1];

test('página do repo real: toda fatia viva com o status da tabela e #alto só com as Alto vivas', () => {
    const model = loadRoadmap(REPO);
    const html = render(model, OPTS);
    const slices = model.phases.flatMap(p => p.slices).filter(s => s.status !== 'removida');
    for (const s of slices) assert.strictEqual(attr(html, s.id), s.status, s.id);
    const alto = /<section id="alto"[\s\S]*?<\/section>/.exec(html)[0];
    assert.deepStrictEqual([...alto.matchAll(/<td>(F\d+\.\d+)<\/td>/g)].map(m => m[1]), slices.filter(s => s.alto).map(s => s.id));
    for (const id of ['progresso', 'linha-do-tempo', 'grafo', 'alto']) assert.match(html, new RegExp(`<section id="${id}"`));
});

test('página autocontida: sem rede, script, @import, url() nem link; tema e viewport', () => {
    const html = render(loadRoadmap(REPO), OPTS);
    assert.doesNotMatch(html, /https?:\/\/|<script|@import|url\(|<link/);
    assert.match(html, /prefers-color-scheme: dark/);
    assert.match(html, /name="viewport"/);
    assert.match(html, /<html lang="pt-BR">/);
});

test('esc: texto do roadmap sai escapado', () => {
    const html = render(modelo([sl('F1.1', 'em spec', 1, { name: '<script>x</script> & "y"' })]), OPTS);
    assert.ok(html.includes('&lt;script&gt;x&lt;/script&gt; &amp; &quot;y&quot;'));
    assert.doesNotMatch(html, /<script/);
});

test('progresso: removida fica fora, sem dias vira "sem estimativa"', () => {
    const html = render(modelo([sl('F1.1', 'concluída', 3), sl('F1.2', 'em andamento', 2), sl('F1.3', 'não iniciada', 5),
        sl('F1.4', 'removida', 4), sl('F1.5', 'não iniciada', null)]), OPTS);
    assert.match(html, /data-done="3" data-total="10"/);
    assert.match(html, /1 fatia sem estimativa/);
    assert.match(html, /3 de 10 dias concluídos \(30%\)/);
});

test('cabeçalho: commit de 7 caracteres, geração, hoje e marca de hoje antes da primeira fase', () => {
    const html = render(modelo([sl('F1.1', 'em spec', 1)]), OPTS);
    assert.match(html, /Hoje: 18\/11\/2026/);
    assert.match(html, /Gerado em 2026-11-18 12:00 UTC do commit abcdef1(?!2)/);
    const left = Number(/class="hoje" style="left:([\d.]+)%/.exec(html)[1]);
    assert.ok(left >= 0 && left <= 100, `left ${left}`);
});

test('main: grava index.html em diretório novo e em caminho .html, sem git, com o commit como 3º argumento', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'roadmap-site-main-'));
    const log = console.log;
    console.log = () => {};
    try {
        main([REPO, path.join(tmp, 'novo', 'site'), '1234567890abcdef']);
        main([REPO, path.join(tmp, 'solto.html'), '1234567890abcdef']);
    } finally {
        console.log = log;
    }
    for (const f of [path.join(tmp, 'novo', 'site', 'index.html'), path.join(tmp, 'solto.html')]) {
        assert.match(fs.readFileSync(f, 'utf8'), /^<!doctype html>[\s\S]*commit 1234567/);
    }
    fs.rmSync(tmp, { recursive: true, force: true });
});

test('removida não aparece na lista, no grafo nem na tabela de Alto; o card só cita o ID', () => {
    const fx = (id, status, alto = false) => ({ id, name: `nome ${id}`, dias: 2, nivel: alto ? 'Alto' : 'Leve', autorizo: alto ? 'Sim' : 'Não', alto, status, deps: [], issue: '', phase: 0 });
    const model = { phases: [{ n: 0, name: 'Zero', status: 'em andamento', start: '2026-11-16', end: '2026-12-01',
        slices: [fx('F0.1', 'concluída'), fx('F0.5', 'removida', true), fx('F0.8', 'não iniciada', true)] }] };
    const html = render(model, { today: '2026-11-18', commit: 'abcdef1', generatedAt: 'x' });
    assert.ok(!html.includes('data-id="F0.5"'), 'lista');
    assert.ok(!html.includes('<title>F0.5'), 'grafo');
    assert.ok(!/<td>F0\.5<\/td>/.test(html), 'tabela de Alto');
    assert.ok(/<td>F0\.8<\/td>/.test(html), 'Alto vivo segue na tabela');
    assert.match(html, /Removidas: F0\.5/);
    assert.match(html, /<summary>2 fatias<\/summary>/);
});
