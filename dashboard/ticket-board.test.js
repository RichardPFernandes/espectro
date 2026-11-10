// public/ticket-board.js — lógica pura da tela Tickets (PRI-325).
const test = require('node:test');
const assert = require('node:assert');
const TB = require('./public/ticket-board.js');
const NOW = Date.parse('2026-11-09T12:00:00Z');

test('alertsFor: ticket fechado com run ativo é vermelho; status não confirmado não alerta', () => {
  const runs = [{ status: 'running', kind: 'active' }];
  assert.deepStrictEqual(TB.alertsFor({ ticketStatus: 'Encerrado', runs, prs: [] }).map(a => a.level), ['red']);
  assert.deepStrictEqual(TB.alertsFor({ ticketStatus: null, runs, prs: [] }), []);
});

test('alertsFor: PR mergeado com ticket aberto e PR aberto sem aprovação há mais de 7 dias', () => {
  const done = [{ status: 'committed', kind: 'has_pr' }];
  assert.strictEqual(TB.alertsFor({ ticketStatus: 'Ag Teste', runs: done, prs: [{ id: 85, state: 'MERGED' }], now: NOW }).length, 1);
  const old = { id: 9, state: 'OPEN', approvals: [], created_on: '2026-10-20T00:00:00Z' };
  assert.match(TB.alertsFor({ ticketStatus: 'Ag Revisão', runs: [{ status: 'running', kind: 'active' }], prs: [old], now: NOW })[0].text, /sem aprovação/);
});

test('verdict: sem status confirmado nunca diz Consistente', () => {
  assert.strictEqual(TB.verdict({ alerts: [], statusVerified: false }).kind, 'unk');
  assert.strictEqual(TB.verdict({ alerts: [], statusVerified: true }).kind, 'ok');
  assert.strictEqual(TB.verdict({ alerts: [{ level: 'red', text: 'x' }], statusVerified: true }).kind, 'red');
});

test('runTrail: 7 segmentos e rótulos', () => {
  assert.strictEqual(TB.runTrail(null).label, 'sem run');
  const r = TB.runTrail({ status: 'running', kind: 'active', node: 'implement' });
  assert.strictEqual(r.label, 'implement 3/7');
  assert.strictEqual(r.segs.length, 7);
  assert.strictEqual(TB.runTrail({ status: 'failed', kind: 'failed', node: 'test' }).label, 'falhou em test');
  assert.strictEqual(TB.runTrail({ status: 'committed', kind: 'completed' }).label, 'concluído');
});

test('prioBars e hoursLabel: nunca chutam valor', () => {
  assert.ok(TB.prioBars('Qualquer').every(b => b.c === 'var(--state-queued)'));
  assert.ok(TB.prioBars('Urgente').every(b => b.c === 'var(--state-failed)'));
  assert.strictEqual(TB.hoursLabel(null), null);
  assert.strictEqual(TB.hoursLabel(5.5), '5,5 h');
});

test('buildRows: junta tickets meus e de runs; filterRows e groupByStatus', () => {
  const rows = TB.buildRows({
    mine: [{ id: 1, subject: 'A', status: 'Em Desenvolvimento', estimated_hours: 4 }],
    runs: [{ taskId: '2-b', ticketId: 2, status: 'running', kind: 'active', node: 'plan', ticket: { subject: 'B' }, updatedAt: '2026-11-09T10:00:00Z' }],
    ticketOf: () => null, now: NOW,
  });
  assert.deepStrictEqual(rows.map(r => [r.id, r.mine, r.statusVerified]), [[1, true, true], [2, false, false]]);
  assert.strictEqual(TB.filterRows(rows, 'mine', '').length, 1);
  assert.strictEqual(TB.filterRows(rows, 'all', '#2').length, 1);
  const g = TB.groupByStatus(rows);
  assert.strictEqual(g[g.length - 1].label, 'Status não consultado');
  assert.strictEqual(g[0].hours, 4);
});

test('shortAgo: formato curto da coluna Atualizado', () => {
  const at = m => new Date(NOW - m * 60000).toISOString();
  assert.deepStrictEqual([0, 4, 90, 60 * 30, 60 * 24 * 9].map(m => TB.shortAgo(at(m), NOW)), ['agora', 'há 4 min', 'há 2 h', 'ontem', 'há 9 dias']);
  assert.strictEqual(TB.shortAgo(null, NOW), null);
});

test('verdict: PR sem estado ou runs ilegíveis não viram Consistente', () => {
  assert.strictEqual(TB.verdict({ alerts: [], statusVerified: true, prs: [{ id: 3, state: '' }], runs: [] }).kind, 'unk');
  assert.strictEqual(TB.verdict({ alerts: [], statusVerified: true, prs: [], runs: [{ status: 'unknown' }] }).kind, 'unk');
  assert.strictEqual(TB.verdict({ alerts: [], statusVerified: true, prs: [{ id: 3, state: 'OPEN' }], runs: [{ status: 'running' }] }).kind, 'ok');
});

test('alertsFor: PR recusado com run concluído e com run ativo', () => {
  const pr = [{ id: 90, state: 'DECLINED' }];
  assert.match(TB.alertsFor({ ticketStatus: 'Aprovada', runs: [{ status: 'committed', kind: 'completed' }], prs: pr })[0].text, /run está concluído/);
  assert.match(TB.alertsFor({ ticketStatus: 'Aprovada', runs: [{ status: 'running', kind: 'active' }], prs: pr })[0].text, /^PR #90 foi recusado no Bitbucket\.$/);
});

test('linkedRun: mesma regra do servidor (só completed é pulado)', () => {
  const rs = [{ taskId: 'a', kind: 'completed', updatedAt: '2026-11-09T11:00:00Z' }, { taskId: 'b', kind: 'has_pr', updatedAt: '2026-11-09T10:00:00Z' }];
  assert.strictEqual(TB.linkedRun(rs).taskId, 'b');
  assert.strictEqual(TB.linkedRun([rs[0]]).taskId, 'a');
});
