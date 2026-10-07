#!/usr/bin/env node
// Re-executa um ciclo que falhou a partir de um nó específico, reaproveitando o que os
// nós anteriores já produziram (ver scripts/lib/cycle-replayer.js).
//
//   node scripts/replay-cycle.js --task <task-id> --from <nó> [--dry-run] [--follow] [--json]
//
//   --from      plan | implement | review | test | verify | commit
//   --dry-run   só mostra o que seria feito (nós re-executados/reaproveitados,
//               artefatos removidos, campos do state zerados) — não escreve nada
//   --follow    espera o agente e encadeia os nós seguintes até o ciclo parar (igual
//               ao watcher com --follow); sem ela, despacha o nó e sai — o watcher
//               continua o ciclo nos próximos ticks
//   --json      saída em JSON na stdout (usado pelo dashboard); logs vão pra stderr
//
// Saída: 0 ok · 1 replay recusado (validação) ou falha · 2 uso incorreto.
const replayer = require('./lib/cycle-replayer');

function parseArgs(argv) {
    const out = { dryRun: false, follow: false, json: false };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        const [flag, inline] = a.startsWith('--') && a.includes('=') ? [a.slice(0, a.indexOf('=')), a.slice(a.indexOf('=') + 1)] : [a, null];
        const value = () => inline ?? argv[++i];
        if (flag === '--task') out.task = value();
        else if (flag === '--from') out.from = value();
        else if (flag === '--dry-run') out.dryRun = true;
        else if (flag === '--follow') out.follow = true;
        else if (flag === '--json') out.json = true;
        // CAS do run original (scripts/cas.js): o que a tela do dashboard carregou.
        else if (flag === '--expected-version') out.expectedVersion = Number(value());
        else if (flag === '--expected-node') out.expectedNode = value();
        else if (flag === '--execution-id') out.executionId = value();
        else if (flag === '--help' || flag === '-h') out.help = true;
        else throw new Error(`argumento desconhecido: ${a}`);
    }
    return out;
}

const USAGE = 'uso: node scripts/replay-cycle.js --task <task-id> --from <nó> [--dry-run] [--follow] [--json]\n' +
    `     nós: ${replayer.REPLAY_NODES.join(', ')}`;

function printPlan(plan) {
    const list = xs => (xs.length ? xs.map(x => `    - ${x}`).join('\n') : '    (nenhum)');
    console.log(`[dry-run] Replay de ${plan.originalRun}${plan.originalArchived ? ' (arquivado)' : ''} a partir do nó "${plan.fromNode}"`);
    console.log(`  novo run:            ${plan.replayTaskId}`);
    console.log(`  worktree:            ${plan.worktree}`);
    console.log(`  nós re-executados:   ${plan.nodesToRun.join(' → ')}`);
    console.log(`  nós reaproveitados:  ${plan.nodesKept.join(', ') || '(nenhum)'}`);
    console.log(`  history mantido:     ${plan.historyKept.join(' → ') || '(vazio)'}`);
    console.log('  artefatos removidos (não vão pro run de replay):');
    console.log(list(plan.artifactsToRemove));
    console.log('  artefatos mantidos:');
    console.log(list(plan.artifactsKept));
    console.log(`  campos do state zerados: ${plan.stateFieldsReset.join(', ') || '(nenhum)'}`);
    console.log('  diff do implement: preservado (vive no working tree do worktree, não é tocado)');
    console.log(`  state.json original: intacto; registro em ${plan.originalDir}/state-replay-${plan.replayTaskId}.json`);
    for (const w of plan.warnings) console.log(`  AVISO: ${w}`);
}

async function main(argv = process.argv.slice(2)) {
    let args;
    try {
        args = parseArgs(argv);
    } catch (e) {
        console.error(`${e.message}\n${USAGE}`);
        return 2;
    }
    if (args.help) { console.log(USAGE); return 0; }
    if (!args.task || !args.from) { console.error(USAGE); return 2; }

    // Com --json, stdout é só o resultado: tudo que o watcher/despacho loga vai pra stderr.
    const emit = value => process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
    if (args.json) console.log = (...xs) => console.error(...xs);

    try {
        if (args.dryRun) {
            const plan = replayer.planReplay(args.task, args.from);
            if (args.json) emit({ ok: true, dryRun: true, ...plan });
            else printPlan(plan);
            return 0;
        }

        const { state } = replayer.loadStateForReplay(args.task, args.from);
        // Só aqui o watcher é carregado (.env, Redmine) — dry-run nunca o toca.
        const dispatcher = require('./lib/node-dispatcher');
        const expect = {};
        if (Number.isInteger(args.expectedVersion)) expect.expected_state_version = args.expectedVersion;
        if (args.expectedNode !== undefined) expect.expected_node = args.expectedNode || null;
        if (args.executionId !== undefined) expect.execution_id = args.executionId || null;
        const result = await replayer.replayFrom(args.task, args.from, state, {
            expect,
            postNote: dispatcher.postNote,
            dispatch: ({ ticketId }) => dispatcher.dispatchNode({ ticketId, fallbackState: state, follow: args.follow }),
        });
        if (args.json) emit(result);
        else {
            console.log(`Replay ${result.replayTaskId} criado a partir do nó "${result.fromNode}" (original: ${result.originalRun}).`);
            console.log(`  nós a re-executar: ${result.nodesToRun.join(' → ')}`);
            console.log(`  artefatos removidos: ${result.removed.join(', ') || '(nenhum)'}`);
            console.log(`  Redmine: ${result.redmine ? 'comentário postado' : 'sem comentário'}`);
            console.log(`  despacho: ${result.dispatch ? JSON.stringify(result.dispatch) : 'não despachado (o próximo tick do watcher retoma)'}`);
            for (const w of result.warnings) console.log(`  AVISO: ${w}`);
        }
        return 0;
    } catch (e) {
        const known = e instanceof replayer.ReplayError;
        if (args.json) emit({ ok: false, error: e.message, code: known ? e.code : 'error' });
        else console.error(`Replay recusado: ${e.message}`);
        if (!known) console.error(e.stack);
        return 1;
    }
}

if (require.main === module) {
    main().then(code => { process.exitCode = code; });
}

module.exports = { main, parseArgs };
