// node --test scripts/probes/u10-subagent-model.test.js
// PRI-311 tarefa 0: avaliação pura da prova U10 (sem chamada ao provider). Fora do harness
// por ficar em scripts/probes/ junto do probe (que é excluído: faz chamadas reais).
const test = require('node:test');
const assert = require('node:assert');
const { evaluateRun, ROLES } = require('./u10-subagent-model');

const attr = (role, models, provenance = 'META+TOOL_USE') => ({ file_ref: `${role}.jsonl`, role, provenance, models });

test('prova obtida só com os dois papéis na família declarada, exit 0 e sem conflito', () => {
    const r = evaluateRun({ candidate: 'agents', exitCode: 0, attribution: ROLES.map(role => attr(role, ['claude-sonnet-4-5'])) });
    assert.strictEqual(r.result, 'PROOF_OBTAINED');
    assert.ok(r.roles.every(x => x.match));
});

test('um papel no frontmatter → prova não obtida; conflito ou exit ≠ 0 → incerto', () => {
    assert.strictEqual(evaluateRun({ candidate: 'agents', exitCode: 0, attribution: [attr(ROLES[0], ['claude-sonnet-4-5']), attr(ROLES[1], ['claude-haiku-4-5'])] }).result, 'PROOF_NOT_OBTAINED');
    assert.strictEqual(evaluateRun({ candidate: 'agents', exitCode: 0, attribution: [attr(ROLES[0], ['claude-sonnet-4-5']), attr(null, ['x'], 'CONFLICTED')] }).result, 'UNCERTAIN');
    assert.strictEqual(evaluateRun({ candidate: 'env', exitCode: 1, attribution: ROLES.map(role => attr(role, ['claude-sonnet-4-5'])) }).result, 'UNCERTAIN');
    assert.strictEqual(evaluateRun({ candidate: 'agents', exitCode: 0, attribution: [] }).result, 'PROOF_NOT_OBTAINED', 'sem transcript de subagente não é prova');
});

test('papel só pelo meta.json (sem tool_use casado) não conta como prova', () => {
    const r = evaluateRun({ candidate: 'agents', exitCode: 0, attribution: ROLES.map(role => attr(role, ['claude-sonnet-4-5'], 'META')) });
    assert.strictEqual(r.result, 'UNCERTAIN');
    assert.ok(r.roles.every(x => !x.match));
});

test('controle negativo: observação precisa ver o frontmatter', () => {
    assert.strictEqual(evaluateRun({ candidate: 'control', exitCode: 0, attribution: ROLES.map(role => attr(role, ['claude-haiku-4-5'])) }).result, 'CONTROL_DETECTS_FRONTMATTER');
    assert.strictEqual(evaluateRun({ candidate: 'control', exitCode: 0, attribution: ROLES.map(role => attr(role, ['claude-sonnet-4-5'])) }).result, 'CONTROL_FAILED');
});
