// node --test scripts/lib/human-input-intent.test.js
const test = require('node:test');
const assert = require('node:assert');
const intent = require('./human-input-intent');

const cliOutput = (structured, extra = {}) => JSON.stringify({ type: 'result', is_error: false, total_cost_usd: 0.01, result: JSON.stringify(structured), structured_output: structured, ...extra });
const interp = over => ({ intent: 'resume', node: 'test', confidence: 0.95, understood: 'liberou o disco', instructions: '', question: '', ...over });

test('parseOutput: lê structured_output e normaliza', () => {
    const out = intent.parseOutput(cliOutput(interp({ confidence: 1.7 })));
    assert.strictEqual(out.intent, 'resume');
    assert.strictEqual(out.node, 'test');
    assert.strictEqual(out.confidence, 1);
    assert.strictEqual(out.cost_usd, 0.01);
});

test('parseOutput: cai pro result quando não há structured_output', () => {
    const out = intent.parseOutput(JSON.stringify({ is_error: false, result: JSON.stringify(interp({ intent: 'hold' })) }));
    assert.strictEqual(out.intent, 'hold');
});

test('parseOutput: lixo, erro do CLI, intent desconhecida e nó inválido', () => {
    assert.strictEqual(intent.parseOutput('não é json'), null);
    assert.strictEqual(intent.parseOutput(cliOutput(interp(), { is_error: true })), null);
    assert.strictEqual(intent.parseOutput(cliOutput(interp({ intent: 'yolo' }))), null);
    assert.strictEqual(intent.parseOutput(cliOutput(interp({ node: 'deploy' }))).node, null);
});

test('decide: resume claro retoma no nó pedido', () => {
    const d = intent.decide(interp({ node: 'verify' }));
    assert.strictEqual(d.action, 'resume');
    assert.strictEqual(d.node, 'verify');
    assert.match(d.reply, /liberou o disco.*\/verify/);
});

test('decide: resume com confiança baixa pede confirmação em vez de retomar', () => {
    const d = intent.decide(interp({ confidence: 0.6 }), { minConfidence: 0.8 });
    assert.strictEqual(d.action, 'ask');
    assert.match(d.reply, /Confirma que é pra retomar em \/test\?/);
});

test('decide: resume sem nó válido não retoma', () => {
    assert.strictEqual(intent.decide(interp({ node: null })).action, 'ask');
});

test('decide: hold e unclear não retomam e devolvem a pergunta', () => {
    const hold = intent.decide(interp({ intent: 'hold', understood: 'vai liberar o disco depois', question: 'Me avisa quando liberar?' }));
    assert.strictEqual(hold.action, 'hold');
    assert.match(hold.reply, /vai liberar o disco depois.*Me avisa quando liberar\?/);
    const unclear = intent.decide(interp({ intent: 'unclear', question: 'Rodo o /test de novo ou sigo pro /verify?' }));
    assert.strictEqual(unclear.action, 'ask');
    assert.match(unclear.reply, /Rodo o \/test de novo ou sigo pro \/verify\?/);
});

test('buildPrompt: leva bloqueio, opções do handoff e a pergunta anterior', () => {
    const p = intent.buildPrompt({
        message: '## Human input — X\n\nsim', node: 'test', history: ['plan', 'implement'],
        blockedReason: 'disco cheio', agentNote: 'nota', handoff: 'liberar disco ou aceitar suíte focada',
        previous: { understood: 'liberou o disco', question: 'Confirma /test?' },
    });
    for (const s of ['travou', 'disco cheio', 'aceitar suíte focada', 'Confirma /test?', 'plan → implement', 'sim']) assert.ok(p.includes(s), s);
});

test('claudeArgs: sem ferramentas, sem MCP, saída validada por schema', () => {
    const args = intent.claudeArgs('p', 'm');
    assert.deepStrictEqual(args.slice(args.indexOf('--tools'), args.indexOf('--tools') + 2), ['--tools', '']);
    assert.ok(args.includes('--strict-mcp-config'));
    assert.strictEqual(JSON.parse(args[args.indexOf('--json-schema') + 1]).required.includes('intent'), true);
});

test('interpret: falha do CLI volta ok:false sem lançar', async () => {
    const execFile = (bin, args, opts, cb) => { cb(Object.assign(new Error('boom'), { killed: false }), ''); return {}; };
    const r = await intent.interpret({ message: 'x', node: 'test' }, { execFile, env: {} });
    assert.deepStrictEqual(r, { ok: false, error: 'boom' });
});

test('interpret: sucesso usa o modelo configurado', async () => {
    let seen;
    const execFile = (bin, args, opts, cb) => { seen = args; cb(null, cliOutput(interp())); return {}; };
    const r = await intent.interpret({ message: 'pode seguir', node: 'test' }, { execFile, env: { HUMAN_INPUT_INTERPRETER_MODEL: 'modelo-x' } });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.model, 'modelo-x');
    assert.strictEqual(seen[seen.indexOf('--model') + 1], 'modelo-x');
});

test('resolveConfig: valores inválidos caem no padrão', () => {
    const c = intent.resolveConfig({ HUMAN_INPUT_MIN_CONFIDENCE: '7', HUMAN_INPUT_INTERPRETER_TIMEOUT_MS: 'abc' });
    assert.strictEqual(c.minConfidence, intent.DEFAULT_MIN_CONFIDENCE);
    assert.strictEqual(c.timeoutMs, intent.DEFAULT_TIMEOUT_MS);
    assert.strictEqual(c.model, intent.DEFAULT_MODEL);
});

test('messageHash: estável e ignora espaços nas pontas', () => {
    assert.strictEqual(intent.messageHash(' a \n'), intent.messageHash('a'));
    assert.notStrictEqual(intent.messageHash('a'), intent.messageHash('b'));
});

test('buildPrompt: informa o status e o papel de cada nó', () => {
    const p = intent.buildPrompt({ message: 'numera os critérios', status: 'escalated', node: 'verify' });
    assert.match(p, /status "escalated" no nó "verify"/);
    assert.match(p, /- verify: só confere/);
    assert.match(p, /- plan: .*AC-NN/);
});

test('decide: não duplica o ponto final da paráfrase', () => {
    assert.doesNotMatch(intent.decide(interp({ understood: 'liberou o disco.' })).reply, /\.\./);
});
