// node --test .github/scripts/estado-no-merge-lib.test.mjs
// Decisão do estado no merge (F0.9 AC-02): funções puras, sem rede nem disco.
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from './processo-lib.mjs';
import { parseRefs, levelFromLabels, decide, pendenciaText, rewriteEstado, estadoText, uncheckedAcs } from './estado-no-merge-lib.mjs';

const { levels } = loadConfig();

test('parseRefs: vários Refs, sem caixa e sem repetição; Fixes/Closes não contam', () => {
    const ids = parseRefs('feat: x (Refs PRI-399)', 'refs pri-12\nRefs PRI-399\nFixes PRI-7\nCloses PRI-8\nREFS: PRI-13');
    assert.deepEqual(ids, ['PRI-399', 'PRI-12', 'PRI-13']);
});

test('parseRefs: sem Refs devolve lista vazia; corpo nulo não quebra', () => {
    assert.deepEqual(parseRefs('feat: x', null), []);
    assert.deepEqual(parseRefs(undefined, 'PRI-5 citado sem Refs'), []);
});

test('levelFromLabels: um rótulo de nível, como string ou { name }', () => {
    assert.equal(levelFromLabels(['Governance', 'processo:medio'], levels), 'medio');
    assert.equal(levelFromLabels([{ name: 'Processo:Leve' }, { name: 'bug' }], levels), 'leve');
});

test('levelFromLabels: sem rótulo ou com dois níveis → null', () => {
    assert.equal(levelFromLabels([], levels), null);
    assert.equal(levelFromLabels(undefined, levels), null);
    assert.equal(levelFromLabels(['processo:leve', { name: 'processo:alto' }], levels), null);
});

test('decide: Alto não muda nada, nem com tudo limpo', () => {
    const r = decide({ level: 'alto', otherOpenPrs: [], openChildren: [] });
    assert.equal(r.acao, 'nada');
    assert.match(r.motivo, /alto/i);
});

test('decide: sem nível → nada', () => {
    const r = decide({ level: null, otherOpenPrs: [], openChildren: [] });
    assert.equal(r.acao, 'nada');
    assert.match(r.motivo, /rótulo/i);
});

test('decide: Médio com outro PR aberto → estado, listando o que falta', () => {
    const r = decide({ level: 'medio', otherOpenPrs: [220], openChildren: ['PRI-500'] });
    assert.equal(r.acao, 'estado');
    assert.deepEqual(r.pendencias, [{ tipo: 'pr', n: 220 }, { tipo: 'filha', id: 'PRI-500' }]);
});

test('decide: PR anexado sem leitura impede o Done e aparece como "sem leitura"', () => {
    const url = 'https://github.com/acme/sumido/pull/9';
    const r = decide({ level: 'medio', otherOpenPrs: [], unreadablePrs: [url], openChildren: [] });
    assert.equal(r.acao, 'estado');
    assert.deepEqual(r.pendencias, [{ tipo: 'pr-ilegivel', url }]);
    assert.equal(pendenciaText(r.pendencias[0]), `PR ${url} sem leitura`);
});

test('decide: PR aberto de outro repo leva o nome do repo no texto', () => {
    const r = decide({ level: 'leve', otherOpenPrs: [{ n: 7, repo: 'outra/coisa' }] });
    assert.equal(r.acao, 'estado');
    assert.deepEqual(r.pendencias, [{ tipo: 'pr', n: 7, repo: 'outra/coisa' }]);
    assert.equal(pendenciaText(r.pendencias[0]), 'PR outra/coisa#7');
});

test('decide: Leve limpo → done', () => {
    const r = decide({ level: 'leve', otherOpenPrs: [], openChildren: [] });
    assert.equal(r.acao, 'done');
    assert.deepEqual(r.pendencias, []);
});

const DESC = [
    '**Estado:** em revisão no PR #210.',
    '**Próximo passo:** Richard mescla.',
    '**Decisão pendente:** nenhuma.',
    '- **Ligado ao fechar:** F0.9',
    '',
    '## Contexto',
    'O **Estado:** citado aqui no corpo não muda.',
].join('\n');

test('rewriteEstado: troca só Estado e Próximo passo; preserva Decisão pendente e o corpo', () => {
    const r = rewriteEstado(DESC, { estado: 'PR #214 mesclado em 2026-11-18; issue em Done pela Action.', proximo: 'nenhum.' });
    assert.equal(r.changed, true);
    assert.deepEqual(r.missing, []);
    const lines = r.text.split('\n');
    assert.equal(lines[0], '**Estado:** PR #214 mesclado em 2026-11-18; issue em Done pela Action.');
    assert.equal(lines[1], '**Próximo passo:** nenhum.');
    assert.deepEqual(lines.slice(2), DESC.split('\n').slice(2));
});

test('rewriteEstado: preserva prefixo de lista', () => {
    const r = rewriteEstado('- **Estado:** velho\n  * **Próximo passo:** velho\nresto', { estado: 'novo', proximo: 'nenhum.' });
    assert.equal(r.text, '- **Estado:** novo\n  * **Próximo passo:** nenhum.\nresto');
});

test('rewriteEstado: sem as linhas, texto intacto e changed false', () => {
    const desc = 'Estado: sem negrito\n## Contexto\nnada aqui';
    const r = rewriteEstado(desc, { estado: 'x', proximo: 'y' });
    assert.equal(r.changed, false);
    assert.equal(r.text, desc);
    assert.deepEqual(r.missing, ['Estado', 'Próximo passo']);
});

test('estadoText: frases de Done e de pendência', () => {
    assert.deepEqual(estadoText({ pr: 214, data: '2026-11-18', acao: 'done', pendencias: [] }), {
        estado: 'PR #214 mesclado em 2026-11-18; issue em Done pela Action.',
        proximo: 'nenhum.',
    });
    assert.deepEqual(estadoText({ pr: 214, data: '2026-11-18', acao: 'estado', pendencias: [{ tipo: 'pr', n: 220 }, { tipo: 'filha', id: 'PRI-500' }] }), {
        estado: 'PR #214 mesclado em 2026-11-18.',
        proximo: 'falta PR #220, filha PRI-500.',
    });
});

// D-PRI-399-01: AC desmarcado na descrição da issue é pendência; não fecha cedo.
test('uncheckedAcs: aceita - e *, ignora [x] e [X], sem repetição e na ordem', () => {
    const desc = [
        '## Pronto quando',
        '- [ ] AC-03: falta isto',
        '- [x] AC-01: feito',
        '* [X] AC-02: feito',
        '  * [ ] AC-05: aninhado',
        '- [ ] AC-03: repetido',
        'texto com - [ ] AC-09 no meio da linha não conta',
        '- [ ] AC-7a não é ID',
    ].join('\n');
    assert.deepEqual(uncheckedAcs(desc), ['AC-03', 'AC-05']);
});

test('uncheckedAcs: sem linhas de AC ou descrição nula → lista vazia', () => {
    assert.deepEqual(uncheckedAcs('**Estado:** x\n- [ ] tarefa sem ID'), []);
    assert.deepEqual(uncheckedAcs(null), []);
    assert.deepEqual(uncheckedAcs(undefined), []);
});

test('decide: Médio sem PR nem filha mas com AC desmarcado → estado com pendência AC', () => {
    const r = decide({ level: 'medio', otherOpenPrs: [216], openChildren: [], uncheckedAcs: ['AC-03'] });
    assert.equal(r.acao, 'estado');
    assert.deepEqual(r.pendencias, [{ tipo: 'pr', n: 216 }, { tipo: 'ac', id: 'AC-03' }]);
    assert.equal(pendenciaText(r.pendencias[1]), 'AC-03');
    assert.equal(estadoText({ pr: 215, data: '2026-11-18', acao: r.acao, pendencias: r.pendencias }).proximo, 'falta PR #216, AC-03.');
    const s = decide({ level: 'medio', uncheckedAcs: ['AC-03'] });
    assert.equal(s.acao, 'estado');
    assert.match(s.motivo, /AC-03/);
});

test('decide: todos os ACs marcados (lista vazia) ou sem linhas de AC → done', () => {
    assert.equal(decide({ level: 'medio', uncheckedAcs: [] }).acao, 'done');
    assert.equal(decide({ level: 'leve', uncheckedAcs: uncheckedAcs('- [x] AC-01: ok\n* [X] AC-02: ok') }).acao, 'done');
    assert.equal(decide({ level: 'medio', uncheckedAcs: uncheckedAcs('sem AC aqui') }).acao, 'done');
});

test('decide: Alto com AC desmarcado continua nada', () => {
    assert.equal(decide({ level: 'alto', uncheckedAcs: ['AC-01'] }).acao, 'nada');
});
