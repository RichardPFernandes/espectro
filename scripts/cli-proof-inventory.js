#!/usr/bin/env node
// PRI-366 (U-09): inventário offline "mecanismo × versão × prova" contra a CLI instalada.
// Lógica pura em scripts/lib/cli-proof-inventory.js. Offline: só roda `claude --version`.
//
// Uso:
//   node scripts/cli-proof-inventory.js [--cli-version X.Y.Z | --claude-bin <path>] [--json]
// Sem argumento, pergunta a versão ao `claude` do PATH, o mesmo que o watcher chama.
// Saída: 0 = todo mecanismo obrigatório tem prova na versão; 1 = falta prova (ou o binário não
// informou a versão); 2 = uso inválido (argumento desconhecido ou --cli-version fora de X.Y.Z).

'use strict';

const { spawnSync } = require('child_process');
const { inventory, formatInventory, parseCliVersion } = require('./lib/cli-proof-inventory');

function parseArgs(argv) {
    const opts = { cliVersion: null, claudeBin: null, json: false };
    for (let i = 0; i < argv.length; i++) {
        const k = argv[i];
        if (k === '--json') opts.json = true;
        else if (k === '--cli-version' && argv[i + 1]) opts.cliVersion = argv[++i];
        else if (k === '--claude-bin' && argv[i + 1]) opts.claudeBin = argv[++i];
        else throw new Error(`argumento inválido: ${k}`);
    }
    if (opts.cliVersion && opts.claudeBin) throw new Error('use --cli-version ou --claude-bin, não os dois');
    if (opts.cliVersion !== null && !/^\d+\.\d+\.\d+$/.test(opts.cliVersion)) throw new Error(`--cli-version precisa ser X.Y.Z: ${opts.cliVersion}`);
    return opts;
}

function installedVersion(bin) {
    const r = spawnSync(bin, ['--version'], { encoding: 'utf8', timeout: 15000, env: { ...process.env, DISABLE_AUTOUPDATER: '1' } });
    return r.status === 0 ? parseCliVersion(r.stdout) : null;
}

function main(argv) {
    let opts;
    try {
        opts = parseArgs(argv);
    } catch (e) {
        process.stderr.write(`ERRO: ${e.message}\n`);
        return 2;
    }
    const bin = opts.claudeBin || 'claude';
    const cliVersion = opts.cliVersion || installedVersion(bin);
    const source = opts.cliVersion ? '--cli-version' : `${bin} --version`;
    const inv = inventory({ cliVersion });
    process.stdout.write(opts.json ? `${JSON.stringify({ version_source: source, ...inv }, null, 2)}\n` : formatInventory(inv, { versionSource: source }));
    return inv.ok ? 0 : 1;
}

if (require.main === module) process.exit(main(process.argv.slice(2)));

module.exports = { main, parseArgs };
