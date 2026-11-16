// node --test scripts/lib/roadmap-lint.test.js
// Validador do mapa de entrega (ROADMAP.md + roadmap/fase-*/FASE.md): regras R1–R8.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const lint = require('./roadmap-lint');

const REPO = path.resolve(__dirname, '..', '..');
const SEP = '| -- | -- | -- | -- |';
const FASE1 = 'roadmap/fase-1-um/FASE.md';
const FASE2 = 'roadmap/fase-2-dois/FASE.md';

// Mapa válido mínimo. As duas tabelas têm colunas em ordens diferentes e colunas extras:
// o validador acha cada coluna pelo nome do cabeçalho.
function base() {
    return {
        'ROADMAP.md': ['| Fase | Objetivo | Depende de | Status |', SEP,
            '| [1. Um](roadmap/fase-1-um/FASE.md) | x | — | em andamento |',
            '| [2. Dois](roadmap/fase-2-dois/FASE.md) | x | Fase 1 | não iniciada |',
            '', 'Fora: F1.2 fechada.'].join('\n'),
        'roadmap/README.md': 'Ver [mapa](../ROADMAP.md#fases), [site](https://x.dev), [a](#a), [m](mailto:a@b.c) e [d](DECISOES.md).\n\n```text\n[não é link](nada.md)\n```\n',
        'roadmap/DECISOES.md': ['| ID | Pergunta | Premissa | Decidido |', SEP, '| D1 | Custo? | Aberto | |'].join('\n'),
        [FASE1]: ['# Fase 1', '',
            '| ID | Fatia e demonstração | Semanas | Depende de | Decisão | Status | Issue no Linear |',
            '| -- | -- | -- | -- | -- | -- | -- |',
            '| F1.1 | Registro | 1 | F1.2 | — | concluída | PRI-1 |',
            '| F1.2 | Retorno | 1 | — | D1 | em spec | sem issue |'].join('\n'),
        [FASE2]: ['| Status | Depende de | Fatia | ID |', SEP,
            '| não iniciada | Fase 1, F1.2 estabilizada | Portão | F2.1 |'].join('\n'),
        'tasks/f1-2-retorno/SPEC.md': 'x',
        'tasks/pri-1/plan.md': 'x',
    };
}

function mk(files) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'roadmap-lint-'));
    for (const [rel, content] of Object.entries(files)) {
        fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
        fs.writeFileSync(path.join(root, rel), content);
    }
    return root;
}

// Aplica `change` ao mapa válido e devolve os achados de nível erro.
function errors(change) {
    const files = base();
    if (change) change(files);
    const root = mk(files);
    try {
        return lint.lint(root).filter(f => f.level === 'erro');
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
}

const rules = change => [...new Set(errors(change).map(f => f.rule))];
const row = cells => `\n| ${cells.join(' | ')} |`;

test('mapa válido: zero achados, com colunas extras e em outra ordem', () => {
    const root = mk(base());
    assert.deepStrictEqual(lint.lint(root), []);
    fs.rmSync(root, { recursive: true, force: true });
});

test('parseSlices acha as colunas pelo nome do cabeçalho', () => {
    const [s] = lint.parseSlices(base()[FASE2], FASE2);
    assert.deepStrictEqual(
        { id: s.id, phase: s.phase, deps: s.deps, status: s.status },
        { id: 'F2.1', phase: 2, deps: ['F1.2'], status: 'não iniciada' });
    const [a, b] = lint.parseSlices(base()[FASE1], FASE1);
    assert.deepStrictEqual([a.id, a.deps, b.decisions], ['F1.1', ['F1.2'], ['D1']]);
});

test('R1: ID duplicado, fora do padrão ou de outra fase', () => {
    assert.deepStrictEqual(rules(f => { f[FASE1] += row(['F1.1', 'Outra', '1', '—', '—', 'em spec', '-']); }), ['R1']);
    assert.deepStrictEqual(rules(f => { f[FASE1] += row(['F1.x', 'Outra', '1', '—', '—', 'em spec', '-']); }), ['R1']);
    const wrongPhase = errors(f => { f[FASE2] += row(['em spec', '—', 'Outra', 'F3.1']); });
    assert.deepStrictEqual(wrongPhase.map(f => [f.rule, f.id, f.file]), [['R1', 'F3.1', FASE2]]);
});

test('R2: dependência inexistente é erro; fase inteira e texto livre são ignorados', () => {
    const found = errors(f => { f[FASE2] = f[FASE2].replace('F1.2 estabilizada', 'F1.9 e a Fase 1'); });
    assert.deepStrictEqual(found.map(f => [f.rule, f.id]), [['R2', 'F2.1']]);
    assert.match(found[0].message, /F1\.9/);
});

test('R3: fase posterior e ciclo são erro; ordem de linha e Fase 6 não', () => {
    assert.deepStrictEqual(rules(f => { f[FASE1] = f[FASE1].replace('| 1 | — | D1', '| 1 | F2.1 | D1'); }), ['R3']);
    const cycle = errors(f => { f[FASE1] = f[FASE1].replace('| 1 | — | D1', '| 1 | F1.1 | D1'); });
    assert.deepStrictEqual(cycle.map(f => f.rule), ['R3']);
    assert.match(cycle[0].message, /F1\.1 → F1\.2 → F1\.1|F1\.2 → F1\.1 → F1\.2/);
    const fila = f => {
        f['ROADMAP.md'] += '\n[6](roadmap/fase-6-fila/FASE.md) [7](roadmap/fase-7-fim/FASE.md)';
        f['roadmap/fase-6-fila/FASE.md'] = ['| ID | Fatia | Depende de | Status |', SEP, '| F6.1 | Cache | F1.1, F7.1 | não iniciada |'].join('\n');
        f['roadmap/fase-7-fim/FASE.md'] = ['| ID | Fatia | Depende de | Status |', SEP, '| F7.1 | Fim | — | não iniciada |'].join('\n');
    };
    assert.deepStrictEqual(rules(fila), []);
});

test('R4: status fora do vocabulário é erro; o README do roadmap lista o vocabulário', () => {
    assert.deepStrictEqual(rules(f => { f[FASE1] = f[FASE1].replace('em spec', 'feito'); }), ['R4']);
    assert.deepStrictEqual(rules(f => { f[FASE1] = f[FASE1].replace('em spec', 'removida em 2026-11-20: sem ganho'); }), []);
    const readme = fs.readFileSync(path.join(REPO, 'roadmap', 'README.md'), 'utf8');
    for (const term of lint.STATUS_VOCAB) {
        assert.ok(readme.includes(`\`${term}\``), `roadmap/README.md (regra 8) deixou de listar \`${term}\``);
    }
});

test('R5: link relativo quebrado é erro', () => {
    const found = errors(f => { f['roadmap/README.md'] += '[x](fase-9/FASE.md#a) e [y](../LICENSE "t")'; });
    assert.deepStrictEqual(found.map(f => [f.rule, f.file]), [['R5', 'roadmap/README.md'], ['R5', 'roadmap/README.md']]);
});

test('R6: fase do ROADMAP sem pasta e pasta fora do ROADMAP são erro', () => {
    assert.deepStrictEqual(rules(f => { f['ROADMAP.md'] = f['ROADMAP.md'].replace(/^.*2\. Dois.*\n/m, ''); }), ['R6']);
    assert.deepStrictEqual(rules(f => { f['ROADMAP.md'] = f['ROADMAP.md'].replace('\n\nFora', '\n| 3. Três | x | Fase 2 | não iniciada |\n\nFora'); }), ['R6']);
    assert.deepStrictEqual(rules(f => { delete f[FASE2]; f['roadmap/fase-2-dois/x.md'] = 'x'; f[FASE1] = f[FASE1].replace('F1.2 |', '— |'); }).sort(), ['R5', 'R6']);
});

test('R7: decisão citada na tabela de fatias precisa existir em DECISOES.md', () => {
    const found = errors(f => { f[FASE1] = f[FASE1].replace('| D1 |', '| D1, D9 |'); });
    assert.deepStrictEqual(found.map(f => [f.rule, f.id]), [['R7', 'F1.2']]);
    assert.match(found[0].message, /D9/);
});

test('R8: pasta tasks/f<fase>-<n>-<slug> precisa de fatia no mapa', () => {
    const found = errors(f => { f['tasks/f1-9-fantasma/SPEC.md'] = 'x'; });
    assert.deepStrictEqual(found.map(f => [f.rule, f.id, f.file]), [['R8', 'F1.9', 'tasks/f1-9-fantasma']]);
});

test('avisos não falham: menção solta a fatia inexistente e dependência de fatia removida', () => {
    const files = base();
    files['ROADMAP.md'] += ' Retomar na F4.4.';
    files[FASE1] = files[FASE1].replace('em spec', 'removida');
    const root = mk(files);
    const found = lint.lint(root);
    assert.deepStrictEqual(found.map(f => [f.level, f.rule, f.id]).sort(), [['aviso', 'R2', 'F1.1'], ['aviso', 'R2', 'F2.1'], ['aviso', 'R2', 'F4.4']]);
    assert.strictEqual(execFileSync(process.execPath, [path.join(__dirname, 'roadmap-lint.js'), root], { encoding: 'utf8' }).split('\n').filter(l => l.startsWith('aviso R2 ')).length, 3);
    fs.rmSync(root, { recursive: true, force: true });
});

test('CLI: exit 1 com uma linha por erro, trazendo arquivo e ID', () => {
    const files = base();
    files[FASE2] = files[FASE2].replace('F1.2 estabilizada', 'F1.9');
    const root = mk(files);
    assert.throws(() => execFileSync(process.execPath, [path.join(__dirname, 'roadmap-lint.js'), root], { encoding: 'utf8', stdio: 'pipe' }),
        e => e.status === 1 && e.stdout.includes(`erro R2 ${FASE2} F2.1: `));
    fs.rmSync(root, { recursive: true, force: true });
});

test('integração: o roadmap real do repo não tem erros', () => {
    const found = lint.lint(REPO).filter(f => f.level === 'erro').map(lint.format);
    assert.deepStrictEqual(found, []);
});
