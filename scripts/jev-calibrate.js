#!/usr/bin/env node
// U15: reprodutibilidade do Jev (PRI-205 S3b, SPEC §B9). Comando MANUAL do operador.
//
//   node "$PRISMA_ROOT/scripts/jev-calibrate.js" --runs <dir> --max-calls <k> [--n 5] [--out <dir>]
//   node "$PRISMA_ROOT/scripts/jev-calibrate.js" --synthetic --out <dir> --max-calls 1 [--n 2]
//
// A configuração vem do consumidor (REPO_PATH ou cwd): a seleção do classificador (registro
// próprio, ou a policy sem registro) e o espelho da
// Authority Ref são avaliados AGORA (classifier-authority). Sem núcleo 2 efetivo
// (ex.: sem Authority Ref) nada é enviado. A chave é lida do Keychain pelo nome do item
// declarado no config; nunca por argumento nem env. Imprime só agregados (JSON).
//
// Saída: 0 = relatório gerado; 2 = uso; 3 = núcleo 2 off; 1 = erro inesperado.

const path = require('path');
const policyLoader = require('./lib/model-routing-policy');
const classifierAuthority = require('./lib/classifier-authority');
const calibration = require('./lib/jev-calibration');
const classifierSelection = require('./lib/classifier-selection');

const USAGE = 'Uso: jev-calibrate.js --runs <dir> --max-calls <k> [--n 5] [--out <dir>] | --synthetic --out <dir> --max-calls <k> [--n 2]\n'
    + '--max-calls é obrigatório (cada chamada gasta o saldo da conta do Jev).\n';

function arg(argv, name) {
    const i = argv.indexOf(name);
    return i === -1 ? undefined : argv[i + 1];
}

function intArg(argv, name) {
    const v = arg(argv, name);
    if (v === undefined) return undefined;
    return /^\d+$/.test(v) ? Number(v) : NaN;
}

async function main(argv) {
    const synthetic = argv.includes('--synthetic');
    const maxCalls = intArg(argv, '--max-calls');
    const n = intArg(argv, '--n');
    const runsDir = arg(argv, '--runs');
    const outDir = arg(argv, '--out');
    if (maxCalls === undefined || Number.isNaN(maxCalls) || Number.isNaN(n)) {
        process.stderr.write(USAGE);
        return 2;
    }
    const root = path.resolve(process.env.REPO_PATH || process.cwd());
    const cfg = policyLoader.readRoutingConfig(root);
    const effective = cfg.status === 'ON'
        ? classifierAuthority.evaluateClassifier({
            // --synthetic (teste de fumaça P-3): envelope embutido, sem dado de ticket. Usa a
            // seção do Jev da plataforma, para provar a API ANTES de ligar "Policy + Jev";
            // Authority Ref e credencial continuam exigidas.
            classifier: synthetic
                ? classifierSelection.platformJevSection('shadow')
                : classifierSelection.effectiveClassifier(root, cfg.policy).classifier,
            classifierConfig: cfg.classifier_config, root, project: path.basename(root),
        })
        : { provider: 'off', reason: cfg.status === 'OFF' ? 'ROUTING_OFF' : `ROUTING_${cfg.cause}` };

    const result = await calibration.calibrate({
        runsDir: runsDir && path.resolve(runsDir), outDir: outDir && path.resolve(outDir),
        n: n === undefined ? undefined : n, maxCalls, effective: effective || { provider: 'off', reason: 'NOT_JEV' }, synthetic,
    });
    if (result.status === 'USAGE') {
        process.stderr.write(`${result.reason}\n${USAGE}`);
        return 2;
    }
    if (result.status === 'BUSY') {
        process.stderr.write('Outra calibração está rodando neste --out. Nada foi enviado.\n');
        return 2;
    }
    if (result.status === 'OFF') {
        process.stderr.write(`Núcleo 2 off: ${result.reason}. Nada foi enviado.\n`);
        return 3;
    }
    process.stdout.write(`${JSON.stringify({ reason: result.reason, ...result.report }, null, 2)}\n`);
    return 0;
}

if (require.main === module) {
    main(process.argv.slice(2)).then(code => { process.exitCode = code; }, err => {
        process.stderr.write(`ERROR: ${err && err.message ? err.message : String(err)}\n`);
        process.exitCode = 1;
    });
}

module.exports = { main };
