// node --test scripts/lib/roadmap-site.test.js
// Camada de dados da página do roadmap: lê roadmap/fase-*/FASE.md com o parser do lint.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { loadRoadmap } = require('./roadmap-site');
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
