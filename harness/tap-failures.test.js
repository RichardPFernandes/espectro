'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { parseFailures, report } = require('./tap-failures');

const TAP = `TAP version 13
# Subtest: passa
ok 1 - passa
  ---
  duration_ms: 1.5
  type: 'test'
  ...
not ok 2 - /ck/scripts/lib/quebra-ao-carregar.test.js
  ---
  location: '/ck/scripts/lib/quebra-ao-carregar.test.js:1:1'
  failureType: 'testCodeFailure'
  exitCode: 1
  error: 'test failed'
  ...
# Subtest: grupo
    # Subtest: filho com \\#
    not ok 1 - filho com \\#
      ---
      location: '/ck/dashboard/x-api.test.js:42:5'
      failureType: 'testCodeFailure'
      error: |-
        Expected values to be strictly equal:

        1 !== 0
      code: 'ERR_ASSERTION'
      ...
    1..1
not ok 3 - grupo
  ---
  location: '/ck/dashboard/x-api.test.js:40:1'
  failureType: 'subtestsFailed'
  error: '1 subtest failed'
  ...
not ok 4 - pendente # TODO ainda não
1..4
# fail 2
# cancelled 0
`;

test('parseFailures: nome, arquivo relativo e linha; pai de subteste e TODO não entram', () => {
    assert.deepStrictEqual(parseFailures(TAP, '/ck'), [
        { name: 'scripts/lib/quebra-ao-carregar.test.js', file: 'scripts/lib/quebra-ao-carregar.test.js', line: 1, error: 'test failed' },
        { name: 'filho com #', file: 'dashboard/x-api.test.js', line: 42, error: 'Expected values to be strictly equal:' },
    ]);
    assert.deepStrictEqual(parseFailures('not ok 1 - sem bloco\n', '/ck'), [{ name: 'sem bloco', file: 'arquivo desconhecido', line: null, error: '' }]);
});

test('report: lista no log, anota no Actions e grava o resumo; suíte limpa não polui', t => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tap-failures-'));
    t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
    const write = (name, body) => { const f = path.join(tmp, name); fs.writeFileSync(f, body); return f; };
    const summary = path.join(tmp, 'summary.md');
    const lines = [];
    report([write('scripts.tap', TAP), write('dashboard.tap', 'TAP version 13\n1..0\n# fail 0\n# cancelled 0\n')],
        { root: '/ck', env: { GITHUB_ACTIONS: 'true', GITHUB_STEP_SUMMARY: summary }, out: l => lines.push(l) });
    const log = lines.join('\n');
    assert.match(log, /\[scripts\] 2 teste\(s\) falharam/);
    assert.match(log, /not ok — dashboard\/x-api\.test\.js:42 — filho com #/);
    assert.match(log, /^::error file=dashboard\/x-api\.test\.js,line=42::filho com #$/m);
    assert.match(log, /\[dashboard\] sem falha no TAP/);
    const md = fs.readFileSync(summary, 'utf8');
    assert.match(md, /\*\*scripts\*\* `scripts\/lib\/quebra-ao-carregar\.test\.js:1`/);
    assert.match(md, /— `filho com #`$/m);
    assert.doesNotMatch(md, /\*\*dashboard\*\*/);
});

test('report: suíte que morre sem "not ok" mostra o fim do TAP; TAP ausente é dito', t => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tap-failures-'));
    t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
    const file = path.join(tmp, 'scripts.tap');
    fs.writeFileSync(file, '[test-roots] REPO_PATH deve ser uma raiz absoluta explícita\n');
    const lines = [];
    report([file, path.join(tmp, 'dashboard.tap')], { env: {}, out: l => lines.push(l) });
    assert.match(lines[0], /falhou sem "not ok"[\s\S]*REPO_PATH deve ser/);
    assert.match(lines[1], /\[dashboard\] TAP ilegível/);
});

test('report: texto do TAP não vira comando de workflow nem quebra o markdown do resumo', t => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tap-failures-'));
    t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
    const summary = path.join(tmp, 'summary.md');
    const a = path.join(tmp, 'scripts.tap');
    fs.writeFileSync(a, "not ok 1 - nome com `crase` e <b>\n  ---\n  location: '/ck/a:b,c.test.js:3:1'\n  error: '::add-mask::segredo'\n  ...\n");
    const b = path.join(tmp, 'dashboard.tap');
    fs.writeFileSync(b, 'saída\n::stop-commands::x\n  ::add-mask::y\n```\nfim\n');
    const lines = [];
    report([a, b], { root: '/ck', env: { GITHUB_ACTIONS: 'true', GITHUB_STEP_SUMMARY: summary }, out: l => lines.push(l) });
    const commands = lines.join('\n').split('\n').filter(l => /^\s*::/.test(l));
    assert.deepStrictEqual(commands, ['::error file=a%3Ab%2Cc.test.js,line=3::nome com `crase` e <b>']);
    assert.match(lines.join('\n'), /: :add-mask::segredo[\s\S]*: :stop-commands::x\n {2}: :add-mask::y/);
    const md = fs.readFileSync(summary, 'utf8');
    assert.match(md, /— `nome com 'crase' e <b>`$/m);
    assert.equal(md.match(/```/g).length, 2, 'a cauda não fecha a cerca');
});
