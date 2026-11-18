// node --test lib/cli-result.test.js
// PRI-381 (F1.5): funções puras do custo pelo JSON da CLI. Fixtures sintéticas, sem dado de consumidor.
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { cliResultJsonEnabled, parseCliResult, cliVersionFromTranscript, promptHashes, promptTemplates } = require('./cli-result');

const resultLine = (over = {}) => JSON.stringify({
    type: 'result', subtype: 'success', session_id: 'sess-a', num_turns: 7, total_cost_usd: 0.4321,
    usage: { input_tokens: 10, output_tokens: 20 }, modelUsage: { 'modelo-x': { costUSD: 0.4321 } }, ...over,
});

test('cliResultJsonEnabled: ausente, vazio e off desligam; só on liga', () => {
    assert.strictEqual(cliResultJsonEnabled({}), false);
    assert.strictEqual(cliResultJsonEnabled({ WATCHER_CLI_RESULT_JSON: '' }), false);
    assert.strictEqual(cliResultJsonEnabled({ WATCHER_CLI_RESULT_JSON: 'off' }), false);
    assert.strictEqual(cliResultJsonEnabled({ WATCHER_CLI_RESULT_JSON: 'on' }), true);
    assert.strictEqual(cliResultJsonEnabled({ WATCHER_CLI_RESULT_JSON: 'ON' }), true);
});

test('cliResultJsonEnabled: valor fora de on/off é erro, não conta como off', () => {
    assert.throws(() => cliResultJsonEnabled({ WATCHER_CLI_RESULT_JSON: '1' }), /WATCHER_CLI_RESULT_JSON deve ser on ou off/);
    assert.throws(() => cliResultJsonEnabled({ WATCHER_CLI_RESULT_JSON: 'true' }), /WATCHER_CLI_RESULT_JSON/);
});

test('parseCliResult acha a linha result da sessão, com ou sem prefixo [claude], e mapeia os campos', () => {
    const log = ['[watcher] despachando', `[claude] ${resultLine()}`, '[watcher] fim'].join('\n');
    assert.deepStrictEqual(parseCliResult(log, 'sess-a'), {
        cost_usd: 0.4321, usage: { input_tokens: 10, output_tokens: 20 },
        model_usage: { 'modelo-x': { costUSD: 0.4321 } }, num_turns: 7,
    });
    assert.strictEqual(parseCliResult(resultLine(), 'sess-a').cost_usd, 0.4321);
});

test('parseCliResult usa a última linha da sessão e ignora a de outra sessão', () => {
    const log = [resultLine({ total_cost_usd: 0.1 }), resultLine({ total_cost_usd: 0.2 }), resultLine({ session_id: 'sess-b', total_cost_usd: 9 })].join('\n');
    assert.strictEqual(parseCliResult(log, 'sess-a').cost_usd, 0.2);
    assert.strictEqual(parseCliResult(resultLine({ session_id: 'sess-b' }), 'sess-a'), null);
});

test('parseCliResult: JSON ilegível, objeto sem type result, texto vazio ou sem sessão viram null', () => {
    assert.strictEqual(parseCliResult('[claude] {"type":"result","session_id":"sess-a",', 'sess-a'), null);
    assert.strictEqual(parseCliResult(JSON.stringify({ type: 'assistant', session_id: 'sess-a' }), 'sess-a'), null);
    assert.strictEqual(parseCliResult('', 'sess-a'), null);
    assert.strictEqual(parseCliResult(undefined, 'sess-a'), null);
    assert.strictEqual(parseCliResult(resultLine(), undefined), null);
});

test('parseCliResult: custo ausente ou não numérico vira null, nunca zero', () => {
    const r = parseCliResult(resultLine({ total_cost_usd: undefined, usage: undefined, modelUsage: undefined, num_turns: undefined }), 'sess-a');
    assert.deepStrictEqual(r, { cost_usd: null, usage: null, model_usage: null, num_turns: null });
    assert.strictEqual(parseCliResult(resultLine({ total_cost_usd: 'caro' }), 'sess-a').cost_usd, null);
});

test('cliVersionFromTranscript devolve o último version não vazio do JSONL, pulando linha ilegível', () => {
    const jsonl = [
        JSON.stringify({ type: 'user', version: '1.0.0' }),
        'linha quebrada {',
        JSON.stringify({ type: 'assistant', version: '1.2.3' }),
        JSON.stringify({ type: 'summary', version: '' }),
        JSON.stringify({ type: 'summary' }),
    ].join('\n');
    assert.strictEqual(cliVersionFromTranscript(jsonl), '1.2.3');
});

test('cliVersionFromTranscript: sem version, vazio ou ausente vira null', () => {
    assert.strictEqual(cliVersionFromTranscript(JSON.stringify({ type: 'user' })), null);
    assert.strictEqual(cliVersionFromTranscript(''), null);
    assert.strictEqual(cliVersionFromTranscript(undefined), null);
});

test('promptHashes: sha256 do template de cada nó, fetch_ticket vira fetch-ticket, ausente vira UNKNOWN', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-result-'));
    try {
        fs.mkdirSync(path.join(root, '.claude', 'commands'), { recursive: true });
        fs.writeFileSync(path.join(root, '.claude', 'commands', 'plan.md'), '# plan sintético\n');
        fs.writeFileSync(path.join(root, '.claude', 'commands', 'fetch-ticket.md'), '# fetch sintético\n');
        const sha = s => crypto.createHash('sha256').update(s).digest('hex');
        assert.deepStrictEqual(promptHashes(root, ['plan', 'fetch_ticket', 'implement']), {
            plan: sha('# plan sintético\n'), fetch_ticket: sha('# fetch sintético\n'), implement: 'UNKNOWN',
        });
        assert.deepStrictEqual(promptHashes(root, []), {});
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

// Run decomposta: o nó é implement, mas o comando lido é /implement-step ou /implement-integrate.
test('promptTemplates: template = primeiro token do comando sem a barra; sem comandos, os nós', () => {
    assert.deepStrictEqual(promptTemplates(['/implement-step 93803-x 0-1'], ['implement']), ['implement-step']);
    assert.deepStrictEqual(promptTemplates(['/implement-integrate 93803-x'], ['implement']), ['implement-integrate']);
    assert.deepStrictEqual(promptTemplates(['/fetch-ticket 1', '/plan (use o task-id que acabou de gerar)'], ['fetch_ticket', 'plan']),
        ['fetch-ticket', 'plan']);
    assert.deepStrictEqual(promptTemplates([], ['plan']), ['plan']);
    assert.deepStrictEqual(promptTemplates(undefined, ['fetch_ticket', 'plan']), ['fetch_ticket', 'plan']);
});

test('promptTemplates: comando de shell na cadeia plan+implement não vira template', () => {
    assert.deepStrictEqual(
        promptTemplates(['/plan 93803-x', 'node "/x/scripts/plan-scorer.js" 93803-x', '/implement 93803-x'], ['plan', 'implement']),
        ['plan', 'implement']);
});

test('promptHashes: template do comando decomposto; ausente ou nome fora do formato vira UNKNOWN sem ler arquivo', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-result-'));
    try {
        fs.mkdirSync(path.join(root, '.claude', 'commands'), { recursive: true });
        fs.writeFileSync(path.join(root, '.claude', 'commands', 'implement-step.md'), '# step sintético\n');
        fs.writeFileSync(path.join(root, 'fora.md'), '# fora do diretório de comandos\n');
        const sha = s => crypto.createHash('sha256').update(s).digest('hex');
        assert.deepStrictEqual(promptHashes(root, ['implement-step', 'implement-integrate', '../../fora']), {
            'implement-step': sha('# step sintético\n'), 'implement-integrate': 'UNKNOWN', '../../fora': 'UNKNOWN',
        });
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});
