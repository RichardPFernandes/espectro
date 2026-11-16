// node --test scripts/probes/cli-smoke-probe.test.js
// F0.6: sonda de fumaça da CLI com uma CLI FALSA (script Node gravado em diretório temporário).
// Sem rede e sem a CLI real. A falsa lê o projeto sintético do cwd e imita o carregamento de
// cada item conforme o que o teste liga.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { parseArgs, probeArgv, evaluate, exitCodeFor, runProbe, lines, LOADED, NOT_LOADED, UNKNOWN } = require('./cli-smoke-probe');

const FAKE = `#!${process.execPath}
const fs = require('fs'), path = require('path'), { execSync } = require('child_process');
const cfg = __CFG__;
const argv = process.argv.slice(2);
if (argv[0] === '--version') { console.log('9.9.9 (fake)'); process.exit(0); }
if (cfg.hang) { setTimeout(() => {}, 60000); return; }
if (cfg.exit) { console.log('Not logged in'); process.exit(cfg.exit); }
if (cfg.empty) process.exit(0);
const prompt = argv[argv.indexOf('-p') + 1];
if (cfg.hook) {
    const settings = JSON.parse(fs.readFileSync('.claude/settings.json', 'utf8'));
    for (const h of settings.hooks.SessionStart[0].hooks) execSync(h.command);
}
let out = prompt.startsWith('/')
    ? (cfg.command ? fs.readFileSync(path.join('.claude/commands', prompt.slice(1) + '.md'), 'utf8') : 'comando desconhecido')
    : (cfg.control === false ? 'erro impresso com exit 0' : prompt);
if (cfg.claudeMd) out += ' ' + fs.readFileSync('CLAUDE.md', 'utf8');
console.log(out);
`;

const ALL = { command: true, hook: true, claudeMd: true };

function withFake(cfg, fn) {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-smoke-test-'));
    try {
        const bin = path.join(tmpRoot, 'fake-claude');
        fs.writeFileSync(bin, FAKE.replace('__CFG__', JSON.stringify(cfg)), { mode: 0o755 });
        const report = fn({ claudeBin: bin, tmpRoot, env: { PATH: process.env.PATH } });
        const left = fs.readdirSync(tmpRoot).filter(n => n.startsWith('cli-smoke-probe-'));
        assert.deepStrictEqual(left, [], 'diretório temporário do projeto sintético foi apagado');
        return report;
    } finally {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
}
const probe = (cfg, extra = {}) => withFake(cfg, base => runProbe({ ...base, timeoutMs: 20000, ...extra }));
const statuses = r => [r.items.custom_command.status, r.items.hook.status, r.items.claude_md.status];

test('os três carregados → exit 0, versão da CLI e uma linha por item', () => {
    const r = probe(ALL);
    assert.deepStrictEqual(statuses(r), [LOADED, LOADED, LOADED]);
    assert.strictEqual(r.exit_code, 0);
    assert.strictEqual(r.claude_version, '9.9.9 (fake)');
    assert.deepStrictEqual(lines(r), ['versão da CLI: 9.9.9 (fake)', 'comando customizado: CARREGADO', 'hook de projeto: CARREGADO', 'CLAUDE.md: CARREGADO']);
    assert.doesNotMatch(JSON.stringify(r), /CTRL|CMD[0-9A-F]|HOOK[0-9A-F]|MD[0-9A-F]{12}/, 'relatório não copia marcador nem resposta');
});

test('comando não carregado → só ele NÃO CARREGADO, exit 2', () => {
    const r = probe({ ...ALL, command: false });
    assert.deepStrictEqual(statuses(r), [NOT_LOADED, LOADED, LOADED]);
    assert.strictEqual(r.exit_code, 2);
});

test('hook não carregado → só ele NÃO CARREGADO, exit 2', () => {
    const r = probe({ ...ALL, hook: false });
    assert.deepStrictEqual(statuses(r), [LOADED, NOT_LOADED, LOADED]);
    assert.strictEqual(r.exit_code, 2);
});

test('CLAUDE.md não carregado → só ele NÃO CARREGADO, exit 2', () => {
    const r = probe({ ...ALL, claudeMd: false });
    assert.deepStrictEqual(statuses(r), [LOADED, LOADED, NOT_LOADED]);
    assert.strictEqual(r.exit_code, 2);
});

test('CLI ausente → três DESCONHECIDO com motivo, exit 3, versão desconhecida', () => {
    const r = withFake(ALL, base => runProbe({ ...base, claudeBin: path.join(base.tmpRoot, 'nao-existe') }));
    assert.deepStrictEqual(statuses(r), [UNKNOWN, UNKNOWN, UNKNOWN]);
    for (const key of Object.keys(r.items)) assert.match(r.items[key].reason, /CLI não encontrada/);
    assert.match(r.claude_version, /^desconhecida \(CLI não encontrada\)$/);
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

test('texto de erro com exit 0 (sem o marcador de controle) não vira NÃO CARREGADO nem CARREGADO', () => {
    const r = probe({ command: false, hook: false, claudeMd: false, control: false });
    assert.deepStrictEqual(statuses(r), [UNKNOWN, UNKNOWN, UNKNOWN]);
    assert.match(r.items.hook.reason, /marcador de controle/);
});

test('evaluate e exitCodeFor: NÃO CARREGADO vence DESCONHECIDO; marcador visto vale mesmo sem controle', () => {
    const markers = { control: 'C', command: 'K', hook: 'H', claudeMd: 'M' };
    const fail = { ok: false, reason: 'exit 1' };
    const mixed = evaluate({ plain: { ok: true, stdout: 'C' }, command: fail, sentinel: 'H', markers });
    assert.deepStrictEqual([mixed.custom_command.status, mixed.hook.status, mixed.claude_md.status], [UNKNOWN, LOADED, NOT_LOADED]);
    assert.strictEqual(exitCodeFor(mixed), 2);
    const positive = evaluate({ plain: fail, command: { ok: true, stdout: 'K' }, sentinel: 'H', markers });
    assert.deepStrictEqual([positive.custom_command.status, positive.hook.status, positive.claude_md.status], [LOADED, LOADED, UNKNOWN]);
    assert.strictEqual(exitCodeFor(positive), 3);
    assert.strictEqual(evaluate({ plain: fail, command: fail, sentinel: 'outro', markers }).hook.status, UNKNOWN);
});

test('argv sem flag de modo; binário por argumento vence o ambiente; padrão claude', () => {
    assert.deepStrictEqual(probeArgv('p'), ['-p', 'p', '--max-turns', '1']);
    assert.strictEqual(parseArgs([], {}).claudeBin, 'claude');
    assert.strictEqual(parseArgs([], { CLI_SMOKE_CLAUDE_BIN: '/x/claude' }).claudeBin, '/x/claude');
    assert.strictEqual(parseArgs(['--claude-bin', '/y/claude'], { CLI_SMOKE_CLAUDE_BIN: '/x/claude' }).claudeBin, '/y/claude');
    assert.throws(() => parseArgs(['--bare', 'x'], {}), /desconhecido/);
    assert.throws(() => parseArgs(['--timeout-ms', '0'], {}), /inteiro/);
});
