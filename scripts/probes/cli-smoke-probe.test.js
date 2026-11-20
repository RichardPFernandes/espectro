// node --test scripts/probes/cli-smoke-probe.test.js
// F0.6: sonda de fumaça da CLI com uma CLI FALSA (script Node gravado em diretório temporário).
// Sem rede e sem a CLI real. A falsa lê o projeto sintético do cwd e imita o carregamento de
// cada item conforme o que o teste liga; o controle ela resolve juntando as partes, não por eco.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const PROBE = path.join(__dirname, 'cli-smoke-probe.js');
const { parseArgs, probeArgv, plainPrompt, newMarkers, agentEnv, evaluate, exitCodeFor, runProbe, lines, LOADED, NOT_LOADED, UNKNOWN, ABSENT } = require('./cli-smoke-probe');

// A sonda tem de tirar CLAUDE* do ambiente do filho: a falsa sai com 7 se alguma chegar.
process.env.CLAUDE_SMOKE_TEST_LEAK = '1';

const FAKE = `#!${process.execPath}
const fs = require('fs'), path = require('path'), { execSync } = require('child_process');
const cfg = __CFG__;
const argv = process.argv.slice(2);
if (Object.keys(process.env).some(k => k.startsWith('CLAUDE'))) process.exit(7);
if (argv[0] === '--version') { if (cfg.noVersion) process.exit(1); console.log('9.9.9 (fake)'); process.exit(0); }
if (cfg.hang) { setTimeout(() => {}, 60000); return; }
if (cfg.exit) { console.log('Not logged in'); process.exit(cfg.exit); }
if (cfg.empty) process.exit(0);
const prompt = argv[argv.indexOf('-p') + 1];
if (cfg.hook) {
    const settings = JSON.parse(fs.readFileSync('.claude/settings.json', 'utf8'));
    for (const h of settings.hooks.SessionStart[0].hooks) execSync(h.command);
}
let out;
if (cfg.echo) out = prompt;
else if (prompt.startsWith('/')) out = cfg.command ? fs.readFileSync(path.join('.claude/commands', prompt.slice(1) + '.md'), 'utf8') : 'comando desconhecido';
else {
    const [, a, b] = prompt.match(/partes (\\w+) e (\\w+)/);
    const word = cfg.claudeMd ? fs.readFileSync('CLAUDE.md', 'utf8').match(/projeto é (\\w+)/)[1] : (cfg.vague ? 'não sei' : '${ABSENT}');
    out = a + b + ' ' + word;
}
if (cfg.stderrOnly) { console.error(out); console.log('nada'); } else console.log(out);
`;

const ALL = { command: true, hook: true, claudeMd: true };

function withFake(cfg, fn) {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-smoke-test-'));
    try {
        const bin = path.join(tmpRoot, 'fake-claude');
        fs.writeFileSync(bin, FAKE.replace('__CFG__', JSON.stringify(cfg)), { mode: 0o755 });
        const report = fn({ claudeBin: bin, tmpRoot });
        const left = fs.readdirSync(tmpRoot).filter(n => n.startsWith('cli-smoke-probe-'));
        assert.deepStrictEqual(left, [], 'diretório temporário do projeto sintético foi apagado');
        return report;
    } finally {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
}
const probe = (cfg, extra = {}) => withFake(cfg, base => runProbe({ ...base, timeoutMs: 20000, ...extra }));
const statuses = r => [r.items.custom_command.status, r.items.hook.status, r.items.claude_md.status];

test('os três carregados → exit 0; ambiente do filho sem CLAUDE* (agentEnv de verdade)', () => {
    const r = probe(ALL);
    assert.deepStrictEqual(statuses(r), [LOADED, LOADED, LOADED]);
    assert.strictEqual(r.exit_code, 0);
    assert.deepStrictEqual(lines(r), ['versão da CLI: 9.9.9 (fake)', 'comando customizado: CARREGADO', 'hook de projeto: CARREGADO', 'CLAUDE.md: CARREGADO']);
    assert.doesNotMatch(JSON.stringify(r), /C[AB][0-9A-F]{6}|CMD[0-9A-F]|HOOK[0-9A-F]|MD[0-9A-F]{12}/, 'relatório não copia marcador nem resposta');
    assert.deepStrictEqual(agentEnv({ CLAUDECODE: '1', CLAUDE_CODE_ENTRYPOINT: 'cli', AI_AGENT: 'x', PATH: '/bin' }), { PATH: '/bin' });
});

test('cada item não carregado → só ele NÃO CARREGADO, exit 2', () => {
    for (const [off, expected] of [['command', [NOT_LOADED, LOADED, LOADED]], ['hook', [LOADED, NOT_LOADED, LOADED]], ['claudeMd', [LOADED, LOADED, NOT_LOADED]]]) {
        const r = probe({ ...ALL, [off]: false });
        assert.deepStrictEqual(statuses(r), expected, off);
        assert.strictEqual(r.exit_code, 2);
    }
});

test('CLAUDE.md é inferido: sem a palavra e sem AUSENTE → DESCONHECIDO, não NÃO CARREGADO', () => {
    const r = probe({ ...ALL, claudeMd: false, vague: true });
    assert.deepStrictEqual(statuses(r), [LOADED, LOADED, UNKNOWN]);
    assert.match(r.items.claude_md.reason, /inferido da resposta do modelo/);
    assert.strictEqual(r.exit_code, 3);
});

test('versão não obtida com as duas chamadas boas → exit 3, nunca 0', () => {
    const r = probe({ ...ALL, noVersion: true });
    assert.deepStrictEqual(statuses(r), [LOADED, LOADED, LOADED]);
    assert.match(r.claude_version, /^desconhecida \(/);
    assert.strictEqual(r.version_known, false);
    assert.strictEqual(r.exit_code, 3);
});

test('CLI ausente → três DESCONHECIDO com motivo, exit 3, versão desconhecida', () => {
    const r = withFake(ALL, base => runProbe({ ...base, claudeBin: path.join(base.tmpRoot, 'nao-existe') }));
    assert.deepStrictEqual(statuses(r), [UNKNOWN, UNKNOWN, UNKNOWN]);
    for (const key of Object.keys(r.items)) assert.match(r.items[key].reason, /CLI não encontrada/);
    assert.strictEqual(r.claude_version, 'desconhecida (CLI não encontrada)');
    assert.strictEqual(r.exit_code, 3);
});

test('timeout → três DESCONHECIDO com motivo, exit 3', () => {
    const r = probe({ ...ALL, hang: true }, { timeoutMs: 400 });
    assert.deepStrictEqual(statuses(r), [UNKNOWN, UNKNOWN, UNKNOWN]);
    assert.match(r.items.claude_md.reason, /timeout de 400 ms/);
    assert.strictEqual(r.exit_code, 3);
});

test('erro (ex.: sem login, exit 1) e saída vazia → DESCONHECIDO, nunca CARREGADO', () => {
    for (const [cfg, re] of [[{ ...ALL, hook: false, exit: 1 }, /exit 1/], [{ ...ALL, hook: false, empty: true }, /saída vazia/]]) {
        const r = probe(cfg);
        assert.deepStrictEqual(statuses(r), [UNKNOWN, UNKNOWN, UNKNOWN]);
        assert.match(r.items.custom_command.reason, re);
        assert.strictEqual(r.exit_code, 3);
    }
});

test('CLI que só ecoa o prompt → DESCONHECIDO (o resultado do controle não é trecho do prompt)', () => {
    const m = newMarkers();
    assert.ok(!plainPrompt(m).includes(m.control) && !plainPrompt(m).includes(m.claudeMd));
    const r = probe({ echo: true });
    assert.deepStrictEqual(statuses(r), [UNKNOWN, UNKNOWN, UNKNOWN]);
    assert.match(r.items.hook.reason, /controle/);
});

test('marcador só no stderr não conta', () => {
    const r = probe({ ...ALL, stderrOnly: true });
    assert.deepStrictEqual(statuses(r), [UNKNOWN, LOADED, UNKNOWN]);
});

test('evaluate e exitCodeFor: NÃO CARREGADO vence DESCONHECIDO; marcador visto vale mesmo sem controle', () => {
    const markers = { control: 'AB', command: 'K', hook: 'H', claudeMd: 'M' };
    const fail = { ok: false, reason: 'exit 1' };
    const mixed = evaluate({ plain: { ok: true, stdout: `AB ${ABSENT}` }, command: fail, sentinel: 'H', markers });
    assert.deepStrictEqual([mixed.custom_command.status, mixed.hook.status, mixed.claude_md.status], [UNKNOWN, LOADED, NOT_LOADED]);
    assert.strictEqual(exitCodeFor(mixed), 2);
    assert.strictEqual(exitCodeFor(mixed, false), 2);
    const positive = evaluate({ plain: fail, command: { ok: true, stdout: 'K' }, sentinel: 'H', markers });
    assert.deepStrictEqual([positive.custom_command.status, positive.hook.status, positive.claude_md.status], [LOADED, LOADED, UNKNOWN]);
    assert.strictEqual(exitCodeFor(positive), 3);
    assert.strictEqual(evaluate({ plain: fail, command: fail, sentinel: 'outro', markers }).hook.status, UNKNOWN);
});

test('main: linhas legíveis, JSON e código de saída; bin relativo vale contra o cwd de quem chamou', () => {
    withFake(ALL, ({ claudeBin, tmpRoot }) => {
        const run = args => spawnSync(process.execPath, [PROBE, ...args], { cwd: tmpRoot, encoding: 'utf8', env: { ...process.env, TMPDIR: tmpRoot } });
        const ok = run(['--claude-bin', `./${path.basename(claudeBin)}`]);
        assert.strictEqual(ok.status, 0, ok.stdout + ok.stderr);
        assert.match(ok.stdout, /^versão da CLI: 9\.9\.9 \(fake\)\ncomando customizado: CARREGADO\nhook de projeto: CARREGADO\nCLAUDE\.md: CARREGADO\n\{/);
        assert.strictEqual(JSON.parse(ok.stdout.slice(ok.stdout.indexOf('\n{'))).exit_code, 0);
        assert.strictEqual(run(['--claude-bin', './nao-existe']).status, 3);
        assert.strictEqual(run(['--bare', 'x']).status, 1);
        const help = run(['--help']);
        assert.deepStrictEqual([help.status, /^Uso:/.test(help.stdout)], [0, true]);
    });
});

test('argv sem flag de modo; binário por argumento vence o ambiente; padrão claude', () => {
    assert.deepStrictEqual(probeArgv('p'), ['-p', 'p', '--max-turns', '1']);
    assert.strictEqual(parseArgs([], {}).claudeBin, 'claude');
    assert.strictEqual(parseArgs([], { CLI_SMOKE_CLAUDE_BIN: '/x/claude' }).claudeBin, '/x/claude');
    assert.strictEqual(parseArgs(['--claude-bin', '/y/claude'], { CLI_SMOKE_CLAUDE_BIN: '/x/claude' }).claudeBin, '/y/claude');
    assert.throws(() => parseArgs(['--timeout-ms', '0'], {}), /inteiro/);
});
