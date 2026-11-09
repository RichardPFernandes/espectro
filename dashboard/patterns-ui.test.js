// node --test patterns-ui.test.js
// Tela "Padrões de falha" (public/patterns.js, artboard FailureIntelligence, PRI-329): leitura do
// memory/patterns.md no formato de scripts/memory-consolidator.js, recomendação por padrão, busca e
// modelo da lista + detalhe. Nada inventado: o que o arquivo não diz não aparece.
const test = require('node:test');
const assert = require('node:assert/strict');
const P = require('./public/patterns');
const { renderPatternsMarkdown, recommendations } = require('../scripts/memory-consolidator');

// Arquivo real, gerado pelo próprio consolidador (mesmo formato que a tela lê).
function realFile({ review = [], highCost = [] } = {}) {
    const recs = recommendations(review, [], highCost);
    return renderPatternsMarkdown({
        reviewPatterns: review, highCostPatterns: highCost, decisionPatterns: [], recs,
        meta: { totalRuns: 12, completedRuns: 10, runsDir: 'memory/runs', generatedAt: '2026-11-09T12:00:00Z' },
    });
}
const REVIEW = [
    { signature: 'codSap', count: 2, totalReviewedRuns: 8, examples: ['APP-1', 'APP-2'] },
    { signature: P.GENERIC_SIGNATURE, count: 5, totalReviewedRuns: 8, examples: ['APP-3', 'APP-4', 'APP-5'] },
    { signature: 'nullCheck', count: 1, totalReviewedRuns: 8, examples: [] },
    { signature: 'idx', count: 1, totalReviewedRuns: 8, examples: ['APP-9'] },
];

test('parse: lê os padrões do consolidador, mais frequente primeiro, empate na ordem do arquivo', () => {
    const p = P.parse(realFile({ review: REVIEW, highCost: [{ label: 'track/frete', avgLoops: 2.5, n: 2 }] }));
    assert.equal(p.known, true);
    assert.equal(p.hasReview, true);
    assert.deepEqual(p.review.map(r => r.sig), [P.GENERIC_SIGNATURE, 'codSap', 'nullCheck', 'idx']);
    assert.deepEqual(p.review[1], { sig: 'codSap', count: 2, total: 8, examples: ['APP-1', 'APP-2'] });
    assert.deepEqual(p.review[2].examples, []);
    // alto custo não vira padrão de falha (não está no artboard)
    assert.ok(!p.review.some(r => /frete/.test(r.sig)));
});

test('parse: seção sem reprovação vira nota, não padrão com zero', () => {
    const p = P.parse(realFile());
    assert.equal(p.review.length, 0);
    assert.match(p.reviewNotes[0], /Nenhuma reprovação de review/);
});

test('recFor: acha a recomendação do padrão (assinatura entre aspas e a genérica) e separa ação e evidência', () => {
    const p = P.parse(realFile({ review: REVIEW }));
    const gen = P.recFor(p.review[0], p.recs);
    assert.match(gen.action, /^Specs de regras de negócio complexas/);
    assert.match(gen.evidence, /5\/8 run\(s\) revisado\(s\)/);
    const cod = P.recFor(p.review[1], p.recs);
    assert.match(cod.action, /"codSap"/);
    assert.ok(!cod.action.includes(' — '));
    // o consolidador só recomenda para os três primeiros: o quarto fica sem cartão
    assert.equal(P.recFor({ sig: 'idx' }, p.recs), null);
    // assinatura que só aparece como parte de outra não casa
    assert.equal(P.recFor({ sig: 'cod' }, p.recs), null);
});

test('filter: busca por sintoma e por run de exemplo, sem diferenciar caixa', () => {
    const list = P.parse(realFile({ review: REVIEW })).review;
    assert.deepEqual(P.filter(list, 'CODSAP').map(r => r.sig), ['codSap']);
    assert.deepEqual(P.filter(list, 'app-9').map(r => r.sig), ['idx']);
    assert.equal(P.filter(list, '  ').length, list.length);
    assert.equal(P.filter(list, 'nada-disso').length, 0);
});

test('model: sem arquivo, fora do formato e arquivo do consolidador', () => {
    assert.equal(P.model(null).state, 'absent');
    assert.equal(P.model({ exists: false }).state, 'absent');
    const raw = P.model({ exists: true, content: '# Notas\n- livre' });
    assert.equal(raw.state, 'raw');
    const m = P.model({ exists: true, content: realFile({ review: REVIEW }) });
    assert.equal(m.state, 'ok');
    assert.equal(m.status, '4 de 4 padrões no arquivo');
    assert.equal(m.clean, '');
});

test('model: seleção padrão é o primeiro visível; Esc (null) fecha; busca refaz a seleção', () => {
    const data = { exists: true, content: realFile({ review: REVIEW }) };
    const m = P.model(data);
    assert.equal(m.sel, P.GENERIC_SIGNATURE);
    assert.equal(m.detail.reviewed, 'em 5 de 8 runs revisados');
    // o arquivo guarda até 3 runs de exemplo: a tela diz que são exemplos
    assert.equal(m.detail.exampleNote, '3 exemplos de 5 runs');
    assert.ok(m.detail.fix);
    const closed = P.model(data, { sel: null });
    assert.equal(closed.sel, null);
    assert.equal(closed.detail, null);
    const one = P.model(data, { sel: 'idx' });
    assert.equal(one.detail.exampleNote, '');
    assert.equal(one.detail.fix, null);
    // escolhido que saiu da busca: detalhe fecha, como no artboard
    const gone = P.model(data, { q: 'codsap', sel: 'idx' });
    assert.equal(gone.sel, null);
    assert.equal(gone.status, '1 de 4 padrões no arquivo');
    assert.equal(P.model(data, { q: 'codsap' }).sel, 'codSap');
});

test('model: histórico sem reprovação mostra a nota do arquivo; sem a seção, nenhuma nota', () => {
    const clean = P.model({ exists: true, content: realFile() });
    assert.match(clean.clean, /Nenhuma reprovação de review/);
    assert.equal(clean.status, '0 de 0 padrões no arquivo');
    const noSection = P.model({ exists: true, content: '## Recomendações para Specs Futuras\n- algo' });
    assert.equal(noSection.state, 'ok');
    assert.equal(noSection.hasReview, false);
    assert.equal(noSection.clean, '');
    // sem a seção não há contagem: status vazio, nunca "0 de 0"
    assert.equal(noSection.status, '');
});

test('recFor: recomendação de decisão com o mesmo texto entre aspas não casa com o padrão', () => {
    const recs = ['Decisão de implementação recorrente em a.md: "codSap" — considerar deixar isso explícito.'];
    assert.equal(P.recFor({ sig: 'codSap' }, recs), null);
});

test('HTML: assinatura e id de run vindos do arquivo saem escapados; sem origem inventada', () => {
    const evil = { sig: '<img src=x onerror=alert(1)>', count: 2, total: 3, examples: ['a"b<c>'] };
    const row = P.rowHtml(evil, evil.sig);
    assert.ok(!row.includes('<img'));
    assert.match(row, /&lt;img src=x onerror=alert\(1\)&gt;/);
    assert.match(row, /aria-current="true"/);
    assert.match(row, /2 runs/);
    assert.ok(!/Execução/.test(row));
    const det = P.detailHtml({ ...evil, reviewed: 'em 2 de 3 runs revisados', exampleNote: '1 exemplo de 2 runs', fix: { action: '**x** <b>', evidence: '' } }, '<X>');
    assert.ok(!det.includes('<img') && !det.includes('<b>'));
    assert.match(det, /href="#run\/a%22b%3Cc%3E" data-pat-run="a&quot;b&lt;c&gt;"/);
    assert.match(det, /<strong>x<\/strong> &lt;b&gt;/);
    assert.match(det, /^<section class="pat-detail"/);
    assert.ok(!/<main/.test(det));
    assert.ok(det.includes('<X>'));
});
