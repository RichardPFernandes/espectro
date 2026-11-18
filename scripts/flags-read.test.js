// node --test scripts/flags-read.test.js
// PRI-399 (F0.9, AC-03, métrica 4): leitor por processo do registro de flags para o Dashboard
// (fronteira G3, mesmo padrão do effort-miss-read.js). Só lê docs/flags.md.
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { spawnSync } = require('child_process');

const CLI = path.join(__dirname, 'flags-read.js');

test('lê docs/flags.md do repositório: ok, resumo coerente e fonte citada', () => {
    const r = spawnSync(process.execPath, [CLI, '--json'], { encoding: 'utf8' });
    assert.strictEqual(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.strictEqual(out.ok, true, out.error);
    const s = out.summary;
    assert.ok(s.n > 0);
    assert.strictEqual(s.padrao.ligada + s.padrao.desligada, s.n);
    assert.strictEqual(s.consumidor.nao_verificado + s.consumidor.outro, s.n);
    assert.strictEqual(s.fonte, 'docs/flags.md');
    assert.match(s.hoje, /^\d{4}-\d{2}-\d{2}$/);
});
