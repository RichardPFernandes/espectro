#!/usr/bin/env node
// PRI-353 (T3, AC6): gravação do registro `effort_miss` pelo state-writer (único autorizado a
// escrever state.json) e a CLI `record`. Validação, leitura e projeção: scripts/lib/effort-miss.js
// (puro). Fica fora de scripts/lib porque lib não importa o writer (regra no-lib-upward).
//
// Uso (agente ou humano):
//   node scripts/effort-miss.js record <run> --phase=test --class=cobertura-de-ac \
//       --what="…" --evidence=<ref> --by=review|verify|human [--would-high-catch=yes|no|unknown]

'use strict';

const fs = require('fs');
const path = require('path');

const stateWriter = require('./state-writer');
const phaseEffort = require('./lib/phase-effort');
const { buildRecord } = require('./lib/effort-miss');

function recordEffortMiss(runDir, input, { table, now } = {}) {
    const tbl = table || (() => {
        const loaded = phaseEffort.loadPhaseEffortTable();
        if (!loaded.ok) throw new Error(loaded.error);
        return loaded.table;
    })();
    if (!fs.existsSync(path.join(runDir, 'state.json'))) throw new Error(`EFFORT_MISS_RUN_NOT_FOUND: ${runDir}`);
    let created = null;
    const state = stateWriter.update(runDir, draft => {
        const existing = Array.isArray(draft.effort_misses) ? draft.effort_misses : [];
        created = buildRecord(input, { table: tbl, now, existing });
        draft.effort_misses = [...existing, created];
    }, { operation: 'effort_miss', actor: input.recorded_by || 'agent' });
    if (!state) throw new Error(`EFFORT_MISS_RUN_NOT_FOUND: ${runDir}`);
    return created;
}

function cli(argv) {
    const args = Object.fromEntries(argv.filter(a => a.startsWith('--')).map(a => {
        const i = a.indexOf('=');
        return i < 0 ? [a.slice(2), true] : [a.slice(2, i), a.slice(i + 1)];
    }));
    const [cmd, runDir] = argv.filter(a => !a.startsWith('--'));
    if (cmd !== 'record' || !runDir) throw new Error('uso: effort-miss.js record <run> --phase= --class= --what= --evidence= --by= [--would-high-catch=]');
    const rec = recordEffortMiss(runDir, {
        phase: args.phase, class: args.class, what_missed: args.what, evidence_ref: args.evidence,
        recorded_by: args.by, ...(args['would-high-catch'] ? { would_high_catch: args['would-high-catch'] } : {}),
    });
    console.log(JSON.stringify(rec, null, 2));
}

if (require.main === module) {
    try { cli(process.argv.slice(2)); } catch (e) { console.error(`[effort-miss] ${e.message}`); process.exit(1); }
}

module.exports = { recordEffortMiss };
