#!/usr/bin/env node
// F0.6 (PRI-376): sonda de fumaça da CLI. Responde, para a versão instalada: um `claude -p` sem
// flags de modo ainda carrega o comando customizado (.claude/commands), o hook de projeto
// (.claude/settings.json) e o CLAUDE.md? O despacho do watcher (readmine-watcher.js,
// dispatchClaudeSegment) depende dos três. A documentação da CLI anuncia que `--bare`, que não
// descobre nenhum deles, passará a ser o padrão do `-p` numa versão futura:
// https://code.claude.com/docs/en/headless (seção "Start faster with bare mode").
//
// STATUS: verificação pontual, FORA do watcher, do harness e de qualquer estado de Run. Faz duas
// chamadas reais e curtas ao provider com a conta padrão da CLI: roda só com o «sim» do Richard.
// Projeto sintético num diretório temporário, apagado ao final; sem código nem dado de consumidor.
//
// Como mede (marcadores aleatórios por execução; a resposta do modelo não é copiada):
//   chamada 1, prompt simples com um marcador de controle. O CLAUDE.md manda incluir outro
//     marcador. Sem o de controle na resposta, a chamada não vale como medição (DESCONHECIDO).
//   chamada 2, prompt `/<comando>`. O marcador do comando só existe no arquivo do comando.
//   hook SessionStart grava um arquivo-sentinela no diretório temporário.
// `--max-turns 1` em ambas: sem um segundo turno o modelo não consegue ler os arquivos por
// ferramenta e devolver o marcador por outro caminho.
//
// Uso:
//   node scripts/probes/cli-smoke-probe.js [--claude-bin claude] [--timeout-ms 120000]
//   (binário também por CLI_SMOKE_CLAUDE_BIN; o argumento vence)
// Saída: uma linha por item e o JSON. Exit 0 = três CARREGADO; 2 = algum NÃO CARREGADO;
// 3 = algum DESCONHECIDO e nenhum NÃO CARREGADO.

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const LOADED = 'CARREGADO';
const NOT_LOADED = 'NÃO CARREGADO';
const UNKNOWN = 'DESCONHECIDO';
const ITEMS = [['custom_command', 'comando customizado'], ['hook', 'hook de projeto'], ['claude_md', 'CLAUDE.md']];
const DEFAULT_TIMEOUT_MS = 120000;
const SENTINEL = 'hook-sentinel.txt';

function parseArgs(argv, env = process.env) {
    const opts = { claudeBin: env.CLI_SMOKE_CLAUDE_BIN || 'claude', timeoutMs: DEFAULT_TIMEOUT_MS };
    for (let i = 0; i < argv.length; i += 2) {
        const [k, v] = [argv[i], argv[i + 1]];
        if (k === '--claude-bin' && v) opts.claudeBin = v;
        else if (k === '--timeout-ms') opts.timeoutMs = Number(v);
        else throw new Error(`argumento desconhecido ou sem valor: ${k}`);
    }
    if (!Number.isInteger(opts.timeoutMs) || opts.timeoutMs < 1) throw new Error('--timeout-ms inteiro >= 1');
    return opts;
}

function newMarkers() {
    const mk = prefix => `${prefix}${crypto.randomBytes(6).toString('hex').toUpperCase()}`;
    return { control: mk('CTRL'), command: mk('CMD'), hook: mk('HOOK'), claudeMd: mk('MD'), commandName: `sonda-${crypto.randomBytes(4).toString('hex')}` };
}

function writeProject(dir, markers) {
    fs.mkdirSync(path.join(dir, '.claude', 'commands'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.claude', 'commands', `${markers.commandName}.md`),
        `Responda somente com a palavra ${markers.command}. Não use nenhuma ferramenta.\n`);
    const hookCommand = `printf %s ${markers.hook} > "${path.join(dir, SENTINEL)}"`;
    fs.writeFileSync(path.join(dir, '.claude', 'settings.json'), JSON.stringify({
        hooks: { SessionStart: [{ hooks: [{ type: 'command', command: hookCommand }] }] },
    }, null, 2) + '\n');
    fs.writeFileSync(path.join(dir, 'CLAUDE.md'),
        `# Projeto de sonda\n\nRegra do projeto: toda resposta termina com a palavra ${markers.claudeMd}.\n`);
}

// Só o que a sonda mede: `-p` sem flag de modo (nem --bare, nem --setting-sources).
function probeArgv(prompt) {
    return ['-p', prompt, '--max-turns', '1'];
}

function agentEnv(env = process.env) {
    const out = { ...env };
    for (const key of Object.keys(out)) if (key.startsWith('CLAUDE') || key === 'AI_AGENT') delete out[key];
    return out;
}

// Nunca devolve stdout de chamada que falhou: erro, exit != 0 e saída vazia viram motivo.
function callCli(claudeBin, args, { cwd, env, timeoutMs }) {
    const r = spawnSync(claudeBin, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', timeout: timeoutMs });
    if (r.error) {
        if (r.error.code === 'ENOENT') return { ok: false, reason: 'CLI não encontrada' };
        if (r.error.code === 'ETIMEDOUT') return { ok: false, reason: `timeout de ${timeoutMs} ms` };
        return { ok: false, reason: `erro ao executar a CLI (${r.error.code || 'sem código'})` };
    }
    if (r.status !== 0) return { ok: false, reason: `CLI saiu com erro (exit ${r.status ?? r.signal}); pode ser falta de login ou limite de turnos` };
    if (!String(r.stdout || '').trim()) return { ok: false, reason: 'saída vazia' };
    return { ok: true, stdout: r.stdout };
}

// Regra de AC-02: CARREGADO só com o marcador visto; NÃO CARREGADO só quando a chamada de
// controle provou que a CLI respondeu de verdade; todo o resto é DESCONHECIDO com motivo.
function evaluate({ plain, command, sentinel, markers }) {
    const item = (status, reason = null) => ({ status, reason });
    const controlOk = plain.ok && plain.stdout.includes(markers.control);
    const noControl = plain.ok ? 'resposta sem o marcador de controle; a chamada não vale como medição' : plain.reason;

    let claudeMd;
    if (!controlOk) claudeMd = item(UNKNOWN, noControl);
    else claudeMd = plain.stdout.includes(markers.claudeMd) ? item(LOADED) : item(NOT_LOADED, 'resposta sem o marcador do CLAUDE.md');

    let customCommand;
    if (command.ok && command.stdout.includes(markers.command)) customCommand = item(LOADED);
    else if (!command.ok) customCommand = item(UNKNOWN, command.reason);
    else if (!controlOk) customCommand = item(UNKNOWN, noControl);
    else customCommand = item(NOT_LOADED, 'resposta sem o marcador do comando');

    let hook;
    if (sentinel === markers.hook) hook = item(LOADED);
    else if (controlOk) hook = item(NOT_LOADED, 'a CLI respondeu e o hook não gravou o sentinela');
    else hook = item(UNKNOWN, noControl);

    return { custom_command: customCommand, hook, claude_md: claudeMd };
}

function exitCodeFor(items) {
    const statuses = ITEMS.map(([key]) => items[key].status);
    if (statuses.includes(NOT_LOADED)) return 2;
    if (statuses.includes(UNKNOWN)) return 3;
    return 0;
}

function readVersion(claudeBin, opts) {
    const r = callCli(claudeBin, ['--version'], opts);
    return r.ok ? r.stdout.trim().split('\n')[0] : `desconhecida (${r.reason})`;
}

function runProbe({ claudeBin = 'claude', timeoutMs = DEFAULT_TIMEOUT_MS, env = agentEnv(), tmpRoot = os.tmpdir() } = {}) {
    const dir = fs.mkdtempSync(path.join(tmpRoot, 'cli-smoke-probe-'));
    try {
        const markers = newMarkers();
        writeProject(dir, markers);
        const opts = { cwd: dir, env, timeoutMs };
        const version = readVersion(claudeBin, opts);
        const plain = callCli(claudeBin, probeArgv(`Responda com a palavra ${markers.control}. Não use nenhuma ferramenta.`), opts);
        const command = callCli(claudeBin, probeArgv(`/${markers.commandName}`), opts);
        let sentinel = null;
        try { sentinel = fs.readFileSync(path.join(dir, SENTINEL), 'utf8').trim(); } catch { /* sem sentinela */ }
        const items = evaluate({ plain, command, sentinel, markers });
        return { claude_version: version, argv: probeArgv('<prompt>'), items, exit_code: exitCodeFor(items) };
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

function lines(report) {
    return [
        `versão da CLI: ${report.claude_version}`,
        ...ITEMS.map(([key, label]) => {
            const { status, reason } = report.items[key];
            return `${label}: ${status}${reason ? ` (${reason})` : ''}`;
        }),
    ];
}

function main() {
    let opts;
    try { opts = parseArgs(process.argv.slice(2)); } catch (err) { console.error(err.message); process.exitCode = 1; return; }
    const report = runProbe(opts);
    console.log(lines(report).join('\n'));
    console.log(JSON.stringify(report, null, 2));
    process.exitCode = report.exit_code;
}

if (require.main === module) main();

module.exports = { parseArgs, newMarkers, writeProject, probeArgv, agentEnv, callCli, evaluate, exitCodeFor, runProbe, lines, LOADED, NOT_LOADED, UNKNOWN, SENTINEL };
