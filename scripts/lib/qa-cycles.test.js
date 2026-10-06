// node --test scripts/lib/qa-cycles.test.js
// Recusas QA separadas do ciclo principal: parse dos blocos do context.md, fatiamento
// do agent_log por retry, custo por recusa, recusa pendente e fallback sem bloco.
const test = require('node:test');
const assert = require('node:assert');
const { parseContextRejections, buildQaCycles, appendRejection, recordRejection } = require('./qa-cycles');
const { contextBlock } = require('./redmine-journal-fetcher');

const log = (node, at, note) => ({ nodes: [node], agent: 'claude', at, note });

test('parseContextRejections lê os blocos gerados por contextBlock (nota multilinha e sem nota)', () => {
    const md = '# ctx\n' + contextBlock('linha 1\n\nlinha 3', '2026-09-20T10:00:00.000Z') + contextBlock(null, '2026-09-22T10:00:00.000Z');
    assert.deepStrictEqual(parseContextRejections(md), [
        { at: '2026-09-20T10:00:00.000Z', note: 'linha 1\n\nlinha 3' },
        { at: '2026-09-22T10:00:00.000Z', note: null },
    ]);
    assert.deepStrictEqual(parseContextRejections(''), []);
});

test('run sem recusa: null', () => {
    assert.strictEqual(buildQaCycles({ status: 'committed', agent_log: [log('plan', '2026-09-01T00:00:00Z')] }, ''), null);
});

test('qa_rejections: fatia o agent_log por retry, custo por diferença e situação de cada ciclo', () => {
    const state = {
        started_at: '2026-09-01T00:00:00Z', status: 'in_progress', node: 'review',
        cost_tracking: { totals: { cost_usd: 10, input_tokens: 900, output_tokens: 100 } },
        qa_rejections: [
            { n: 1, note: 'a', retry_requested_at: '2026-09-05T00:00:00Z', cost_baseline_usd: 3, tokens_baseline: 300 },
            { n: 2, note: 'b', retry_requested_at: '2026-09-08T00:00:00Z', cost_baseline_usd: 7, tokens_baseline: 700 },
        ],
        agent_log: [
            log('plan', '2026-09-01T01:00:00Z'), log('commit', '2026-09-01T05:00:00Z'),
            log('implement', '2026-09-05T01:00:00Z'), log('review', '2026-09-05T02:00:00Z'),
            log('implement', '2026-09-08T01:00:00Z'),
        ],
    };
    const q = buildQaCycles(state, '');
    assert.deepStrictEqual(q.main, { started_at: '2026-09-01T00:00:00Z', ended_at: '2026-09-01T05:00:00Z', steps: 2, committed: true, cost_usd: 3 });
    assert.deepStrictEqual(q.cycles.map(c => [c.n, c.situation, c.steps.length, c.cost_usd, c.tokens, c.node]),
        [[1, 'superseded', 2, 4, 400, null], [2, 'running', 1, 3, 300, 'review']]);
    assert.strictEqual(q.cycles[0].ended_at, '2026-09-05T02:00:00Z');
    assert.strictEqual(q.cycles[1].ended_at, null);
    assert.strictEqual(q.pending, null);
});

test('PRs abertos dentro do retry ficam no ciclo dele; o PR do ciclo principal não', () => {
    const state = {
        status: 'committed',
        qa_rejections: [{ n: 1, retry_requested_at: '2026-09-05T00:00:00Z' }],
        pull_request: { 'app-back': { url: 'u2', id: 2, status: 'OPEN', opened_at: '2026-09-05T03:00:00Z' } },
        pull_request_history: [{ repo: 'app-front', url: 'u1', id: 1, status: 'MERGED', opened_at: '2026-09-01T03:00:00Z' }],
        agent_log: [log('commit', '2026-09-05T03:00:00Z')],
    };
    const [c] = buildQaCycles(state, '').cycles;
    assert.strictEqual(c.situation, 'committed');
    assert.deepStrictEqual(c.prs.map(p => [p.repo, p.id]), [['app-back', 2]]);
});

test('recusa gravada pelo watcher sem retry ainda: pending', () => {
    const q = buildQaCycles({ status: 'committed', ticket_status: 'Recusa QA', qa_rejection: { note: 'x', rejected_at: '2026-09-10T00:00:00Z', journal_id: 5 } }, '');
    assert.deepStrictEqual(q.cycles, []);
    assert.deepStrictEqual(q.pending, { note: 'x', rejected_at: '2026-09-10T00:00:00Z', journal_id: 5 });
});

test('reconstrução: context.md sumarizado sem o bloco usa qa_rejection.retry_requested_at', () => {
    const q = buildQaCycles({
        status: 'committed', ticket_status: 'Ag Merge', qa_retry_count: 1,
        qa_rejection: { note: 'nota', rejected_at: '2026-09-28T14:35:40Z', journal_id: '44724', retry_requested_at: '2026-09-28T14:46:59.501Z' },
        agent_log: [log('commit', '2026-09-24T14:16:05Z'), log('implement', '2026-09-28T14:56:32Z'), log('commit', '2026-09-28T20:26:01Z')],
    }, '# resumo sem blocos');
    assert.strictEqual(q.cycles.length, 1);
    assert.deepStrictEqual([q.cycles[0].note, q.cycles[0].journal_id, q.cycles[0].situation, q.cycles[0].reconstructed, q.cycles[0].cost_usd],
        ['nota', '44724', 'committed', true, null]);
    assert.strictEqual(q.main.steps, 1);
});

test('reconstrução: qa_rejection completa o bloco do mesmo instante, não o último', () => {
    const md = contextBlock('um', '2026-09-20T10:00:00.000Z') + contextBlock('dois', '2026-09-25T10:00:00.000Z');
    const q = buildQaCycles({ status: 'in_progress', qa_rejection: { journal_id: 9, retry_requested_at: '2026-09-20T10:00:00.100Z' } }, md);
    assert.deepStrictEqual(q.cycles.map(c => [c.note, c.journal_id]), [['um', 9], ['dois', null]]);
});

test('appendRejection: herda as recusas do context.md e grava a base de custo', () => {
    const md = contextBlock('antiga', '2026-09-20T10:00:00.000Z');
    const state = { history: ['plan', 'implement'], qa_rejection: { note: 'nova', journal_id: 3 }, cost_tracking: { totals: { cost_usd: 2, input_tokens: 10, output_tokens: 5 } } };
    const out = appendRejection(state, md, { note: 'nova', rejected_at: 'r', journal_id: 3, at: '2026-09-26T00:00:00Z' });
    assert.deepStrictEqual(out.map(e => [e.n, e.note, e.journal_id]), [[1, 'antiga', null], [2, 'nova', 3]]);
    assert.deepStrictEqual([out[1].history_len, out[1].cost_baseline_usd, out[1].tokens_baseline], [2, 2, 15]);
    assert.ok(!('reconstructed' in out[0]));
});

test('recordRejection + appendRejection: cada recusa é uma entrada; o retry completa a pendente, não cria outra', () => {
    let state = { status: 'committed', history: ['plan'], cost_tracking: { totals: { cost_usd: 1, input_tokens: 1, output_tokens: 1 } } };
    state.qa_rejections = recordRejection(state, '', { note: 'um', rejected_at: '2026-09-10T00:00:00Z', journal_id: 1, at: '2026-09-10T00:01:00Z' });
    assert.deepStrictEqual(recordRejection(state, '', { note: 'um', rejected_at: '2026-09-10T00:00:00Z', journal_id: 1 }), state.qa_rejections, 'mesma recusa não duplica');
    state.qa_rejections = appendRejection(state, '', { note: 'um', rejected_at: '2026-09-10T00:00:00Z', journal_id: 1, at: '2026-09-10T01:00:00Z' });
    assert.strictEqual(state.qa_rejections.length, 1);
    assert.strictEqual(state.qa_rejections[0].retry_requested_at, '2026-09-10T01:00:00Z');
    state = { ...state, ticket_status: 'Recusa QA', cost_tracking: { totals: { cost_usd: 5 } } };
    state.qa_rejections = recordRejection(state, '', { note: 'dois', rejected_at: '2026-09-15T00:00:00Z', journal_id: 2 });
    const q = buildQaCycles(state, '');
    assert.deepStrictEqual(q.cycles.map(c => [c.n, c.note, c.rejected_again]), [[1, 'um', true]]);
    assert.deepStrictEqual([q.pending.note, q.pending.journal_id], ['dois', 2]);
    state.qa_rejections = appendRejection(state, '', { note: 'dois', rejected_at: '2026-09-15T00:00:00Z', journal_id: 2, at: '2026-09-15T01:00:00Z' });
    assert.deepStrictEqual(state.qa_rejections.map(e => [e.n, e.note, e.cost_baseline_usd]), [[1, 'um', 1], [2, 'dois', 5]]);
});

test('recordRejection em run antigo: o retry anterior (só em qa_rejection) não é sobrescrito pela recusa nova', () => {
    const state = {
        status: 'committed', ticket_status: 'Ag Merge', qa_retry_count: 1,
        qa_rejection: { note: 'primeira', rejected_at: '2026-09-20T00:00:00Z', journal_id: 7, retry_requested_at: '2026-09-20T01:00:00Z' },
    };
    const out = recordRejection(state, '# context.md sumarizado', { note: 'segunda', rejected_at: '2026-09-25T00:00:00Z', journal_id: 8 });
    assert.deepStrictEqual(out.map(e => [e.n, e.note, e.retry_requested_at]), [[1, 'primeira', '2026-09-20T01:00:00Z'], [2, 'segunda', null]]);
});

test('recusa pendente em run antigo não ocupa o bloco da recusa anterior do context.md', () => {
    const q = buildQaCycles({ status: 'committed', ticket_status: 'Recusa QA', qa_retry_count: 1, qa_rejection: { note: 'nova', rejected_at: '2026-09-25T00:00:00Z', journal_id: 9 } },
        contextBlock('antiga', '2026-09-20T10:00:00.000Z'));
    assert.deepStrictEqual(q.cycles.map(c => [c.note, c.journal_id, c.rejected_again]), [['antiga', null, true]]);
    assert.strictEqual(q.pending.note, 'nova');
});

test('retry perdido (qa_retry_count > histórico, context.md sumarizado): vem do implement "Retry Recusa QA" do agent_log', () => {
    const q = buildQaCycles({
        status: 'running', qa_retry_count: 2,
        qa_rejections: [{ n: 1, note: 'segunda', retry_requested_at: '2026-10-01T11:10:41Z' }],
        agent_log: [log('commit', '2026-09-24T14:16:05Z'), log('implement', '2026-09-28T14:56:32Z', 'Retry Recusa QA: listas'), log('commit', '2026-09-28T20:26:01Z')],
    }, '# resumo');
    assert.deepStrictEqual(q.cycles.map(c => [c.n, c.note, c.situation, c.steps.length, c.reconstructed]),
        [[1, null, 'committed', 2, true], [2, 'segunda', 'running', 0, false]]);
    assert.strictEqual(q.main.steps, 1);
});
