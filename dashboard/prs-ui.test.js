// node --test prs-ui.test.js
// Lógica pura da tela "Pull requests" (public/prs.js, artboard PullRequests, PRI-326): estado por PR
// (inclusive SUPERSEDED e desconhecido), abas, filtros dos cards, indicadores, "Pronto para merge?",
// faixa do detalhe e barra "sem review há". Regra da casa: sem dado = "sem medição", nunca zero.
const test = require('node:test');
const assert = require('node:assert/strict');
const M = require('./public/prs');

const H = 3600000;
const NOW = Date.parse('2026-11-09T12:00:00.000Z');
const iso = ms => new Date(NOW - ms).toISOString();
const rev = (displayName, approved = false, changesRequested = false) => ({ displayName, approved, changesRequested });
const pr = o => ({
    id: 1, repo: 'app-back', state: 'OPEN', draft: false, reviewers: [], hasConflicts: false, conflictFiles: [],
    targetBranch: 'develop', createdOn: iso(H), updatedOn: iso(H), linkedRun: null, canApprove: false, ...o,
});

test('stateKey: OPEN/draft, encerrados, SUPERSEDED e qualquer outro valor como desconhecido', () => {
    assert.equal(M.stateKey(pr({})), 'OPEN');
    assert.equal(M.stateKey(pr({ draft: true })), 'DRAFT');
    assert.equal(M.stateKey(pr({ state: 'MERGED' })), 'MERGED');
    assert.equal(M.stateKey(pr({ state: 'DECLINED' })), 'DECLINED');
    assert.equal(M.stateKey(pr({ state: 'SUPERSEDED' })), 'SUPERSEDED');
    assert.equal(M.stateKey(pr({ state: null })), 'UNKNOWN');
    assert.equal(M.stateKey(pr({ state: 'ALGO_NOVO' })), 'UNKNOWN');
    assert.equal(M.STATES.UNKNOWN.label, 'Estado desconhecido');
});

test('revSummary: revisores não consultados = sem medição; mudanças pedidas vencem; todos aprovados = done', () => {
    assert.deepEqual(M.revSummary(pr({ reviewers: null })), { text: 'aprovações sem medição', tone: 'muted' });
    assert.equal(M.revSummary(pr({ reviewers: [] })).text, 'sem revisores');
    assert.deepEqual(M.revSummary(pr({ reviewers: [rev('A', true), rev('B')] })), { text: '1 de 2 aprovações', tone: 'muted' });
    assert.deepEqual(M.revSummary(pr({ reviewers: [rev('A', true), rev('B', true)] })), { text: '2 de 2 aprovações', tone: 'done' });
    assert.deepEqual(M.revSummary(pr({ reviewers: [rev('A', true), rev('B', false, true)] })), { text: 'mudanças pedidas', tone: 'failed' });
});

test('waitHours: só PR aberto com revisores e nenhuma aprovação; escala e rótulo do artboard', () => {
    assert.equal(M.waitHours(pr({ reviewers: [rev('A')], createdOn: iso(26 * H) }), NOW), 26);
    assert.equal(M.waitHours(pr({ reviewers: [rev('A', true)], createdOn: iso(26 * H) }), NOW), 0, 'já tem aprovação');
    assert.equal(M.waitHours(pr({ reviewers: [], createdOn: iso(26 * H) }), NOW), 0, 'sem revisores');
    assert.equal(M.waitHours(pr({ reviewers: null, createdOn: iso(26 * H) }), NOW), 0, 'revisores não consultados');
    assert.equal(M.waitHours(pr({ state: 'MERGED', reviewers: [rev('A')], createdOn: iso(26 * H) }), NOW), 0);
    assert.equal(M.waitHours(pr({ reviewers: [rev('A')], createdOn: null }), NOW), 0);
    assert.equal(M.waitLabel(5), '5 h');
    assert.equal(M.waitLabel(26), '1 d 2 h');
    assert.equal(M.waitTone(20), 'running');
    assert.equal(M.waitTone(26), 'waiting');
    assert.equal(M.waitTone(48), 'failed');
    assert.equal(M.waitWidth(36), '50%');
    assert.equal(M.waitWidth(500), '100%');
});

const SAMPLE = [
    pr({ id: 81, reviewers: [rev('M. Souza', true), rev('L. Prado')], hasConflicts: true, conflictFiles: ['TabelaFrete.java'], linkedRun: { taskId: '205-x', ticketId: 205 } }),
    pr({ id: 88, draft: true, reviewers: [rev('M. Souza'), rev('R. Alves')], linkedRun: { taskId: '215-y', ticketId: 215 }, updatedOn: iso(5 * H) }),
    pr({ id: 92, reviewers: [rev('Você'), rev('M. Souza', true)], canApprove: true, hasConflicts: null }),
    pr({ id: 85, state: 'MERGED', reviewers: [rev('A', true)] }),
    pr({ id: 90, state: 'SUPERSEDED', reviewers: null, source: 'run', linkedRun: { taskId: '224-z' }, hasConflicts: null, updatedOn: null, stateCheckedAt: iso(2 * H) }),
    pr({ id: 61, repo: 'app-front', state: null, reviewers: null, source: 'run', linkedRun: { taskId: '224-z' }, hasConflicts: null, updatedOn: null }),
];

test('abas: Abertos, Para você, Do Espectro (inclui SUPERSEDED e desconhecido), Encerrados', () => {
    const ids = tab => M.poolOf(SAMPLE, tab, null).map(p => p.id).sort((a, b) => a - b);
    assert.deepEqual(ids('open'), [81, 88, 92]);
    assert.deepEqual(ids('review'), [92]);
    assert.deepEqual(ids('prisma'), [61, 81, 88, 90]);
    assert.deepEqual(ids('closed'), [85, 90]);
    assert.deepEqual(M.poolOf(SAMPLE, 'inexistente', null).map(p => p.id).sort((a, b) => a - b), [81, 88, 92], 'aba desconhecida cai em Abertos');
});

test('poolOf: mais recente primeiro e filtro do card por cima da aba', () => {
    assert.deepEqual(M.poolOf(SAMPLE, 'open', null).map(p => p.id), [81, 92, 88]);
    assert.deepEqual(M.poolOf(SAMPLE, 'open', 'conflict').map(p => p.id), [81]);
    assert.deepEqual(M.poolOf(SAMPLE, 'open', 'wait').map(p => p.id).sort(), [81, 88, 92]);
    assert.deepEqual(M.poolOf(SAMPLE, 'open', 'prisma').map(p => p.id).sort(), [81, 88]);
});

test('kpis: contagens com fonte; "sem medição" quando não há como medir; Tempo até merge nunca inventa', () => {
    const k = Object.fromEntries(M.kpis(SAMPLE).map(x => [x.key, x]));
    assert.equal(k.wait.value, '3');
    assert.equal(k.wait.hint, '1 com você', 'todos os abertos medidos: sem aviso');
    assert.equal(k.conflict.value, '1');
    assert.equal(k.conflict.hint, 'merge-tree local · 1 sem medição', 'o #92 não teve conflito calculado');
    assert.equal(k.merge.value, 'sem medição');
    assert.equal(k.merge.filter, false);
    assert.equal(k.prisma.value, '2');
    assert.equal(k.prisma.hint, '1 em draft');
    assert.ok(Object.values(k).every(x => x.source), 'todo indicador diz a fonte');

    const unmeasured = Object.fromEntries(M.kpis([pr({ reviewers: null, hasConflicts: null, source: 'run' })]).map(x => [x.key, x]));
    assert.equal(unmeasured.wait.value, 'sem medição', 'aberto sem revisores consultados não vira zero');
    assert.equal(unmeasured.conflict.value, 'sem medição', 'conflito não calculado não vira zero');

    const mixed = Object.fromEntries(M.kpis([pr({ reviewers: [rev('A')] }), pr({ id: 2, reviewers: null, source: 'run' })]).map(x => [x.key, x]));
    assert.equal(mixed.wait.value, '1', 'conta só os medidos...');
    assert.equal(mixed.wait.hint, '0 com você · 1 sem medição', '...e diz quantos ficaram de fora');

    const none = Object.fromEntries(M.kpis([pr({ state: 'MERGED' })]).map(x => [x.key, x]));
    assert.equal(none.wait.value, '0', 'sem PR aberto o zero é medido');
    assert.equal(none.conflict.value, '0');
});

test('readiness: aberto mostra aprovações, conflito e ticket; encerrados e desconhecido têm linhas próprias', () => {
    const row = (p, i) => M.readiness(p)[i];
    assert.deepEqual(M.readiness(SAMPLE[0]), [
        { key: 'Aprovações', v: '1 de 2 · falta L. Prado', tone: 'warn' },
        { key: 'Conflito com develop', v: 'TabelaFrete.java', tone: 'fail' },
    ]);
    assert.deepEqual(row(SAMPLE[1], 0), { key: 'Aprovações', v: '0 de 2 · falta M. Souza, R. Alves', tone: 'fail' });
    assert.deepEqual(row(SAMPLE[1], 1), { key: 'Conflito com develop', v: 'nenhum', tone: 'ok' });
    assert.deepEqual(M.readiness(SAMPLE[2])[1], { key: 'Conflito com develop', v: 'não calculado', tone: 'pend' });
    assert.deepEqual(M.readiness(SAMPLE[2])[2], { key: 'Ticket', v: 'sem ticket vinculado', tone: 'pend' });
    assert.deepEqual(row(pr({ reviewers: [rev('A', true), rev('B', false, true)] }), 0), { key: 'Aprovações', v: 'B pediu mudanças', tone: 'fail' });
    assert.deepEqual(row(pr({ reviewers: null }), 0).tone, 'pend');
    assert.deepEqual(M.readiness(SAMPLE[3]), [{ key: 'Aprovações', v: '1 de 1', tone: 'ok' }, { key: 'Merge', v: 'em develop', tone: 'ok' }]);
    assert.deepEqual(M.readiness(SAMPLE[4]), [{ key: 'Estado', v: 'substituído por outro PR no Bitbucket', tone: 'warn' }]);
    assert.equal(M.readiness(SAMPLE[5])[0].tone, 'pend');
    assert.equal(M.readiness(pr({ state: 'DECLINED' }))[0].tone, 'fail');
});

test('banner: conflito > recusado/substituído/desconhecido > sem review há 7+ dias; senão nada', () => {
    assert.deepEqual(M.banner(SAMPLE[0], NOW), { tone: 'fail', text: 'Conflito com develop em TabelaFrete.java (merge-tree local)' });
    assert.equal(M.banner(pr({ state: 'DECLINED' }), NOW).tone, 'fail');
    assert.equal(M.banner(SAMPLE[4], NOW).text, 'Substituído por outro PR no Bitbucket');
    assert.match(M.banner(SAMPLE[5], NOW).text, /^Estado desconhecido/);
    assert.deepEqual(M.banner(pr({ reviewers: [rev('A')], createdOn: iso(9 * 24 * H) }), NOW), { tone: 'warn', text: 'Sem nenhum review há 9 dias' });
    assert.equal(M.banner(pr({ reviewers: [rev('A')], createdOn: iso(6 * 24 * H) }), NOW), null);
    assert.equal(M.banner(SAMPLE[3], NOW), null);
});

test('footnote e ageText: PR só do run diz de onde vem o estado; aprovação só quando o app aprova', () => {
    const fmt = () => 'há 2 horas';
    assert.match(M.footnote(SAMPLE[4], fmt), /^Estado registrado no run 224-z, conferido há 2 horas\. Revisores e conflito não foram consultados/);
    assert.match(M.footnote(SAMPLE[5], fmt), /^Estado registrado no run 224-z\. /, 'sem last_checked_at não inventa hora');
    assert.equal(M.footnote(SAMPLE[2], fmt), 'A aprovação vai para o Bitbucket em seu nome.');
    assert.equal(M.footnote(SAMPLE[3], fmt), 'Ciclo encerrado no Bitbucket.');
    assert.equal(M.ageText(SAMPLE[0], fmt), 'aberto há 2 horas');
    assert.equal(M.ageText(SAMPLE[3], fmt), 'atualizado há 2 horas', 'sem hora do merge na lista: atualizado');
    assert.equal(M.ageText(SAMPLE[4], fmt), 'conferido há 2 horas');
    assert.equal(M.ageText(SAMPLE[5], fmt), '');
});

test('keyOf separa o mesmo número de PR em repos irmãos', () => {
    assert.notEqual(M.keyOf(pr({ id: 61, repo: 'app-back' })), M.keyOf(pr({ id: 61, repo: 'app-front' })));
});
