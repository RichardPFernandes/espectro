// node --test scripts/probes/plugin-neutralization-probe.test.js
// PRI-366 (U-08): avaliação pura do probe de neutralização do plugin (sem rodar a CLI). Fora do
// harness por ficar em scripts/probes/ junto do probe (que roda o binário real da CLI).
const test = require('node:test');
const assert = require('node:assert');
const { summarizeRun, evaluateScenario, overall, SCENARIOS } = require('./plugin-neutralization-probe');

const init = ({ skills = ['debug'], plugins = [], slash = ['debug'], apiKeySource = 'none' } = {}) =>
    ({ type: 'system', subtype: 'init', skills, plugins, slash_commands: slash, apiKeySource, claude_code_version: '9.9.9' });
const result = (cost = 0, apiMs = 0) => ({ type: 'result', total_cost_usd: cost, duration_api_ms: apiMs });
const run = (lines, exitCode = 1) => summarizeRun({ exitCode, lines });
const seen = () => run([init({ skills: ['debug', 'jev-model-router'], plugins: [{ name: 'jev-model-router', source: 'jev-model-router@skills-dir', path: '/x' }] }), result()]);
const clean = () => run([init(), result()]);

test('controle vê o router e o teste não o menciona, offline → PROOF_OBTAINED', () => {
    const control = seen();
    assert.deepStrictEqual(control.init.router.plugins, [{ name: 'jev-model-router', source: 'jev-model-router@skills-dir' }], 'sem caminho na evidência');
    assert.deepStrictEqual(evaluateScenario({ control, test: clean() }), { result: 'PROOF_OBTAINED', reason: null });
});

test('teste ainda carrega o router → PROOF_NOT_OBTAINED; controle cego → CONTROL_FAILED', () => {
    assert.strictEqual(evaluateScenario({ control: seen(), test: seen() }).result, 'PROOF_NOT_OBTAINED');
    assert.strictEqual(evaluateScenario({ control: clean(), test: clean() }).result, 'CONTROL_FAILED');
    // Menção fora das listas do init (ex.: evento de log do plugin) também reprova.
    const leaky = run([init(), { type: 'system', subtype: 'ui_log', text: 'jev-model-router ready' }, result()]);
    assert.strictEqual(evaluateScenario({ control: seen(), test: leaky }).result, 'PROOF_NOT_OBTAINED');
});

test('sem init, com custo, com chamada à API ou com chave → INCONCLUSIVE (nunca prova)', () => {
    assert.strictEqual(evaluateScenario({ control: seen(), test: run([result()]) }).result, 'INCONCLUSIVE');
    assert.strictEqual(evaluateScenario({ control: seen(), test: run([init(), result(0.01, 0)]) }).reason, 'OFFLINE_NAO_CONFIRMADO');
    assert.strictEqual(evaluateScenario({ control: seen(), test: run([init(), result(0, 120)]) }).reason, 'OFFLINE_NAO_CONFIRMADO');
    assert.strictEqual(evaluateScenario({ control: seen(), test: run([init({ apiKeySource: 'ANTHROPIC_API_KEY' }), result()]) }).reason, 'OFFLINE_NAO_CONFIRMADO');
    assert.strictEqual(evaluateScenario({ control: seen(), test: run([init()]) }).reason, 'OFFLINE_NAO_CONFIRMADO', 'sem evento result não confirma custo 0');
});

test('veredito geral: PROOF_OBTAINED só com todos os cenários provados', () => {
    const ok = SCENARIOS.map(() => ({ result: 'PROOF_OBTAINED' }));
    assert.strictEqual(overall(ok), 'PROOF_OBTAINED');
    assert.strictEqual(overall(ok.slice(1)), 'INCONCLUSIVE', 'cenário faltando');
    assert.strictEqual(overall([...ok.slice(1), { result: 'PROOF_NOT_OBTAINED' }]), 'PROOF_NOT_OBTAINED');
    assert.strictEqual(overall([...ok.slice(1), { result: 'CONTROL_FAILED' }]), 'INCONCLUSIVE');
});
