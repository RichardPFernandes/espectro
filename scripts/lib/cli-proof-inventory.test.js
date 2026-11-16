// PRI-366 (U-09): inventário "mecanismo × versão × prova" da CLI. Puro + o comando, offline.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const inv = require('./cli-proof-inventory');
const { SUBAGENT_MECHANISM_PROOF } = require('./model-routing');
const { PLUGIN_NEUTRALIZATION_PROOF } = require('./claude-account');

const ROOT = path.resolve(__dirname, '..', '..');
const CLI = path.join(ROOT, 'scripts', 'cli-proof-inventory.js');
const row = (r, id) => r.rows.find(x => x.mechanism === id);

test('CLI do watcher (2.1.325): modelo do subagente e plugin provados → ok; esforço UNKNOWN sem reprovar', () => {
    const r = inv.inventory({ cliVersion: '2.1.325' });
    assert.deepStrictEqual([r.ok, r.missing, r.cli_version], [true, [], '2.1.325']);
    assert.deepStrictEqual([row(r, 'subagent_model').status, row(r, 'subagent_model').proof_ref], ['PROOF_OBTAINED', 'tasks/pri-366/u10-probe-evidence-2.1.325.json']);
    assert.deepStrictEqual([row(r, 'plugin_neutralization').status, row(r, 'plugin_neutralization').proof_ref], ['PROOF_OBTAINED', 'tasks/pri-366/plugin-neutralization-2.1.325.json']);
    assert.deepStrictEqual([row(r, 'subagent_effort').status, row(r, 'subagent_effort').required], ['UNKNOWN', false]);
    assert.match(row(r, 'subagent_effort').reason, /^SEM_PROBE/);
});

test('versão exata (R8): só passa a versão com prova de todo mecanismo obrigatório', () => {
    assert.strictEqual(inv.inventory({ cliVersion: '2.1.319' }).ok, true);
    assert.deepStrictEqual(inv.inventory({ cliVersion: '2.1.323' }).missing, ['plugin_neutralization']);
    const next = inv.inventory({ cliVersion: '2.1.326' });
    assert.deepStrictEqual([next.ok, next.missing, row(next, 'subagent_model').status, row(next, 'subagent_model').reason],
        [false, ['subagent_model', 'plugin_neutralization'], 'UNVERIFIED', 'CLI_VERSION_NOT_PROVEN'], 'versão nova = sem prova até prova própria');
    for (const v of ['2.1.324', '2.1.326', '2.2.0', '2.1.32']) assert.strictEqual(inv.inventory({ cliVersion: v }).ok, false, v);
    for (const v of [null, '', 'lixo', '__proto__', 'toString', '2.1.325 (Claude Code)']) {
        const r = inv.inventory({ cliVersion: v });
        assert.deepStrictEqual([r.ok, r.cli_version, row(r, 'subagent_model').reason], [false, 'UNKNOWN', 'CLI_VERSION_UNKNOWN'], String(v));
    }
    assert.strictEqual(inv.parseCliVersion('2.1.325 (Claude Code)\n'), '2.1.325');
    assert.strictEqual(inv.parseCliVersion('erro'), null);
});

test('as versões provadas vêm das mesmas listas que o código usa (sem cópia)', () => {
    const r = inv.inventory({ cliVersion: '2.1.325' });
    assert.deepStrictEqual(row(r, 'subagent_model').proven_versions, [...SUBAGENT_MECHANISM_PROOF.cli_versions]);
    assert.deepStrictEqual(row(r, 'plugin_neutralization').proven_versions, Object.keys(PLUGIN_NEUTRALIZATION_PROOF.proof_refs));
    assert.deepStrictEqual(inv.MECHANISMS.map(m => [m.id, m.required]), [['subagent_model', true], ['plugin_neutralization', true], ['subagent_effort', false]]);
});

test('cada prova do plugin no repositório é PROOF_OBTAINED, offline e da própria versão', () => {
    for (const [version, ref] of Object.entries(PLUGIN_NEUTRALIZATION_PROOF.proof_refs)) {
        if (ref.startsWith('prisma-evidence:')) continue; // prova manual fora do repositório (2.1.319)
        const e = JSON.parse(fs.readFileSync(path.join(ROOT, ref), 'utf8'));
        assert.ok(e.cli_version.startsWith(`${version} `), `${version}: cli_version ${e.cli_version}`);
        assert.deepStrictEqual([version, e.result, e.offline.provider_calls, e.offline.credentials], [version, 'PROOF_OBTAINED', 0, 'none']);
        assert.deepStrictEqual(e.scenarios.map(s => [s.scenario, s.result]), [['project_skill', 'PROOF_OBTAINED'], ['account_skill', 'PROOF_OBTAINED'],
            ['account_skills_dir_plugin', 'PROOF_OBTAINED'], ['marketplace_plugin', 'PROOF_OBTAINED']]);
        for (const s of e.scenarios) {
            const seen = Object.values(s.control.init.router).some(list => list.length > 0);
            assert.ok(seen && !s.test.router_mentioned_anywhere, `${version}/${s.scenario}: controle vê, teste não`);
            assert.deepStrictEqual([s.control.total_cost_usd, s.test.total_cost_usd, s.control.duration_api_ms, s.test.duration_api_ms], [0, 0, 0, 0]);
            assert.ok(s.test.argv.includes('--settings') && !s.control.argv.includes('--settings'));
            for (const k of Object.keys(s.control.init.counts)) {
                assert.strictEqual(s.test.init.counts[k], s.control.init.counts[k] - s.control.init.router[k].length, `${version}/${s.scenario}/${k}: só o router sai`);
            }
        }
    }
});

test('comando: exit 1 sem prova, 0 com prova, 2 em uso inválido; versão pelo binário informado', () => {
    const run = (...args) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });
    const no = run('--cli-version', '2.1.326');
    assert.strictEqual(no.status, 1);
    assert.match(no.stdout, /subagent_model\s+\| U-06\s+\| sim\s+\| 2\.1\.319, 2\.1\.323, 2\.1\.325\s+\| UNVERIFIED/);
    assert.match(no.stdout, /FALHA, sem prova na 2\.1\.326: subagent_model, plugin_neutralization/);
    assert.strictEqual(run('--cli-version', '2.1.325').status, 0);
    const yes = run('--cli-version', '2.1.319', '--json');
    assert.strictEqual(yes.status, 0);
    assert.deepStrictEqual([JSON.parse(yes.stdout).ok, JSON.parse(yes.stdout).version_source], [true, '--cli-version']);
    assert.strictEqual(run('--x').status, 2);
    assert.strictEqual(run('--cli-version', 'lixo').status, 2, 'versão fora de X.Y.Z é uso inválido');
    assert.match(inv.formatInventory(inv.inventory({ cliVersion: null })), /FALHA, versão da CLI desconhecida; nenhuma prova se aplica \(subagent_model, plugin_neutralization\)/);
    assert.strictEqual(run('--cli-version', '2.1.319', '--claude-bin', '/x').status, 2);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pri366-'));
    try {
        const fake = path.join(dir, 'claude');
        fs.writeFileSync(fake, '#!/bin/sh\necho "2.1.326 (Claude Code)"\n', { mode: 0o755 });
        const viaBin = run('--claude-bin', fake, '--json');
        assert.deepStrictEqual([viaBin.status, JSON.parse(viaBin.stdout).cli_version], [1, '2.1.326']);
        const broken = path.join(dir, 'broken');
        fs.writeFileSync(broken, '#!/bin/sh\nexit 3\n', { mode: 0o755 });
        const unknown = run('--claude-bin', broken, '--json');
        assert.deepStrictEqual([unknown.status, JSON.parse(unknown.stdout).cli_version], [1, 'UNKNOWN']);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
