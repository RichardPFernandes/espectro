#!/usr/bin/env node
// Ponto de retorno do consumidor (F1.2, PRI-379): CLI sobre scripts/lib/return-point.js.
//
//   node scripts/return-point.js status [--root <dir>] [--json]
//   node scripts/return-point.js mark   [--root <dir>] [--repo <dir>] [--json]
//   node scripts/return-point.js back   [--root <dir>] [--repo <dir>] [--to verde/<id>] [--json]
//
// --root: checkout do Prisma (padrão: o checkout onde este script está). --repo: repo do
// consumidor, onde moram a trava do watcher e os agentes (padrão: REPO_PATH). O dashboard é
// lido em http://127.0.0.1:${PORT||3333}. `status` só lê o git: árvore e último verde.
// Saída: 0 sucesso · 1 recusa ou reprovação · 2 uso errado. --json imprime o objeto, sem
// caminho absoluto.

'use strict';

const path = require('node:path');
const rp = require('./lib/return-point');

const DEFAULT_ROOT = path.resolve(__dirname, '..');
const USAGE = 'Uso: node scripts/return-point.js <status|mark|back> [--root <dir>] [--repo <dir>] [--to verde/<id>] [--json]';
const COMMANDS = new Set(['status', 'mark', 'back']);
const VALUE_FLAGS = new Set(['--root', '--repo', '--to']);
const TREE_REASONS = {
    dirty: 'suja',
    off_main: 'fora da origin/main',
    no_origin_main: 'sem origin/main local',
    not_git: 'não é um repositório git',
};

class UsageError extends Error {}

function parseArgs(argv) {
    const [command, ...rest] = argv;
    if (!COMMANDS.has(command)) throw new UsageError(command ? `comando desconhecido: ${command}` : 'falta o comando');
    const opts = { command, json: false };
    for (let i = 0; i < rest.length; i++) {
        let flag = rest[i];
        let value;
        const eq = flag.indexOf('=');
        if (flag.startsWith('--') && eq > 0) { value = flag.slice(eq + 1); flag = flag.slice(0, eq); }
        if (flag === '--json' && value === undefined) { opts.json = true; continue; }
        if (!VALUE_FLAGS.has(flag)) throw new UsageError(`opção desconhecida: ${rest[i]}`);
        if (value === undefined) value = rest[++i];
        if (!value || value.startsWith('--')) throw new UsageError(`${flag} pede um valor`);
        opts[flag.slice(2)] = value;
    }
    if (opts.to !== undefined && command !== 'back') throw new UsageError('--to só vale com back');
    return opts;
}

const short = sha => (sha ? String(sha).slice(0, 7) : '?');
const treeText = t => (t.ok ? 'limpa e na main' : t.reasons.map(r => TREE_REASONS[r] || r).join(', '));

function runStatus({ root }, out) {
    const tree = rp.checkTree({ root });
    const last = rp.lastGreen({ root });
    const result = { tree, last_green: last };
    if (out.json) return { code: tree.ok ? 0 : 1, result };
    out.log(`árvore:       ${treeText(tree)}`);
    out.log(`HEAD:         ${short(tree.head)}`);
    if (tree.paths.length) out.log(`caminhos:     ${tree.paths.join(', ')}${tree.paths.length >= rp.MAX_PATHS ? ' (até 10)' : ''}`);
    out.log(`último verde: ${last || 'nenhum'}`);
    return { code: tree.ok ? 0 : 1 };
}

async function runMark({ root, repo }, out) {
    const result = await rp.mark({ root, health: () => rp.health({ root, repo }) });
    if (out.json) return { code: result.ok ? 0 : 1, result };
    out.log('saúde:');
    for (const i of result.items) out.log(`  ${String(i.name).padEnd(10)} ${String(i.status).padEnd(13)} ${i.reason}`);
    out.log(result.ok
        ? `marca: ${result.tag} criada no ${short(result.head)}`
        : result.error === 'head_changed'
            ? 'marca: não criada; o HEAD mudou durante a checagem (registrado em logs/return-point.jsonl)'
            : 'marca: não criada; a checagem reprovou (registrado em logs/return-point.jsonl)');
    return { code: result.ok ? 0 : 1 };
}

async function runBack({ root, repo, to }, out) {
    const result = await rp.back({ root, repo, to });
    if (out.json) return { code: result.ok ? 0 : 1, result };
    if (!result.ok) {
        out.log('back recusado; nada mudou:');
        for (const r of result.reasons) out.log(`  - ${r.message}${r.code === 'dirty' && result.paths.length ? `: ${result.paths.join(', ')}` : ''}`);
        return { code: 1 };
    }
    out.log(`HEAD destacado em ${result.tag} (${short(result.head)}); antes em ${short(result.from)}.`);
    for (const w of result.warnings) out.log(`aviso: ${w.message}`);
    if (result.restart) out.log('Reinicie o dashboard para rodar esta revisão. Para avançar de novo: git switch main.');
    return { code: 0 };
}

async function main(argv = process.argv.slice(2), env = process.env) {
    let opts;
    try { opts = parseArgs(argv); } catch (e) {
        if (!(e instanceof UsageError)) throw e;
        console.error(`${e.message}\n${USAGE}`);
        return 2;
    }
    const args = { root: path.resolve(opts.root ?? DEFAULT_ROOT), repo: opts.repo ?? (env.REPO_PATH || undefined), to: opts.to };
    const out = { json: opts.json, log: s => console.log(s) };
    try {
        const run = { status: runStatus, mark: runMark, back: runBack }[opts.command];
        const { code, result } = await run(args, out);
        if (opts.json) console.log(JSON.stringify(result, null, 2));
        return code;
    } catch (e) {
        console.error(`erro: ${e.message}`);
        return 1;
    }
}

if (require.main === module) main().then(code => { process.exitCode = code; });

module.exports = { parseArgs, main };
