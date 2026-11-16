#!/usr/bin/env node
'use strict';
// `npm run demo`: um ciclo simulado do grafo (DRY_RUN=true, ver scripts/lib/dry-run.js)
// com o ticket sintético de scripts/fixtures/ticket-example.json. Sem credencial e sem
// rede: o consumidor é uma pasta temporária, o ambiente não herda nada de quem chama e o
// preload do harness recusa conexão fora de loopback. Nada é escrito neste checkout.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const NODES = ['fetch_ticket', 'plan', 'implement', 'review', 'test', 'verify', 'commit'];
const TASK_ID = '99999-dry-run';

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'espectro-demo-'));
const consumer = path.join(scratch, 'consumidor');
for (const dir of [path.join(consumer, '.claude'), path.join(scratch, 'home'), path.join(scratch, 'tmp')]) fs.mkdirSync(dir, { recursive: true });
// Único arquivo que o ciclo exige do consumidor (portão de drift da spec).
fs.copyFileSync(path.join(ROOT, '.claude', 'spec-hash-config.json'), path.join(consumer, '.claude', 'spec-hash-config.json'));

// Conjunto mínimo: DRY_RUN liga a simulação, REPO_PATH aponta o consumidor e
// DRY_RUN_FIXTURE absoluto dispensa copiar a fixture para dentro dele.
const env = {
    PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`,
    HOME: path.join(scratch, 'home'),
    TMPDIR: path.join(scratch, 'tmp'),
    NODE_OPTIONS: `--require=${path.join(ROOT, 'harness', 'loopback-only.cjs')}`,
    DRY_RUN: 'true',
    REPO_PATH: consumer,
    DRY_RUN_FIXTURE: path.join(ROOT, 'scripts', 'fixtures', 'ticket-example.json'),
};
// Opcionais de quem chama: acelerar (0 = sem espera) e simular risco alto.
for (const key of ['DRY_RUN_DELAY_FACTOR', 'DRY_RUN_RISK_LEVEL']) if (process.env[key]) env[key] = process.env[key];

const started = Date.now();
const run = spawnSync(process.execPath, [path.join(__dirname, 'readmine-watcher.js')], { cwd: consumer, env, stdio: 'inherit' });
const seconds = ((Date.now() - started) / 1000).toFixed(1);

// O watcher sai com 0 mesmo quando o agente simulado falha: quem decide é o state.json.
const stateFile = path.join(consumer, 'memory', 'runs', '_archive', TASK_ID, 'state.json');
let state = null;
try { state = JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch { /* sem estado arquivado: ciclo não fechou */ }
const closed = run.status === 0 && state?.status === 'committed' && NODES.every((node, i) => state.history?.[i] === node);

console.log('');
if (!closed) {
    console.error(`[demo] O ciclo simulado não fechou (exit ${run.status ?? run.signal}; status ${state?.status ?? 'desconhecido'}).`);
    console.error(`[demo] Estado parcial em ${consumer}`);
    process.exit(1);
}
console.log(`[demo] Ciclo simulado fechado em ${seconds}s: ${state.history.join(' → ')}`);
console.log(`[demo] status ${state.status} · plano ${state.planScore ?? 'desconhecido'}/100 · risco ${state.risk_level ?? 'desconhecido'} · ${state.events?.length ?? 0} eventos`);
console.log(`[demo] Estado para inspecionar: ${stateFile}`);
console.log('[demo] Nenhum modelo foi chamado; tracker e forge não foram tocados. A pasta temporária pode ser apagada.');
