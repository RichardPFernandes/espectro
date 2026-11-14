'use strict';
// PRI-353 (T3, AC6): registro `effort_miss`, a base para decidir escalada de esforço no futuro.
// SPEC: tasks/effort-por-fase/SPEC.md (Desenho 6).
//
// Cobre só fase em esforço médio na tabela (.claude/phase-effort.json). `would_high_catch`
// nasce `unknown`: o que esforço alto teria pego não é observável, é julgamento registrado por
// quem detectou (review, verify ou humano) e nunca inferido. Ausência de registro é UNKNOWN,
// nunca zero. A gravação passa pelo state-writer (único autorizado a escrever state.json) e não
// mexe em campo crítico, então não muda state_version.
//
// Uso (agente ou humano):
//   node scripts/lib/effort-miss.js record <run> --phase=test --class=cobertura-de-ac \
//       --what="…" --evidence=<ref> --by=review|verify|human [--would-high-catch=yes|no|unknown]

const fs = require('fs');
const path = require('path');

const stateWriter = require('../state-writer');
const phaseEffort = require('./phase-effort');

const WOULD_HIGH_CATCH = ['yes', 'no', 'unknown'];
const RECORDED_BY = ['review', 'verify', 'human'];
const CLASS_RE = /^[a-z0-9][a-z0-9-]*$/;
const nonEmpty = v => typeof v === 'string' && v.trim() !== '';

function mediumPhases(table) {
    return Object.entries(table || {}).filter(([, level]) => level === 'medium').map(([phase]) => phase);
}

function validateRecord(rec, { table }) {
    const errors = [];
    if (!mediumPhases(table).includes(rec.phase)) errors.push(`EFFORT_MISS_PHASE_NOT_MEDIUM: ${rec.phase}`);
    if (rec.effort !== 'medium') errors.push('effort deve ser medium');
    if (!nonEmpty(rec.what_missed)) errors.push('what_missed obrigatório');
    if (!WOULD_HIGH_CATCH.includes(rec.would_high_catch)) errors.push(`would_high_catch inválido: ${rec.would_high_catch}`);
    if (!CLASS_RE.test(rec.class || '')) errors.push('class deve ser um slug em minúsculas (a-z, 0-9, hífen)');
    if (!nonEmpty(rec.evidence_ref)) errors.push('evidence_ref obrigatório');
    if (!RECORDED_BY.includes(rec.recorded_by)) errors.push(`recorded_by inválido: ${rec.recorded_by}`);
    return errors;
}

function buildRecord(input, { table, now = new Date().toISOString(), existing = [] }) {
    const rec = {
        id: `em-${existing.length + 1}`,
        phase: input.phase,
        effort: 'medium',
        what_missed: input.what_missed,
        would_high_catch: input.would_high_catch ?? 'unknown',
        class: input.class,
        evidence_ref: input.evidence_ref,
        recorded_by: input.recorded_by,
        recorded_at: now,
    };
    const errors = validateRecord(rec, { table });
    if (errors.length) throw new Error(errors.join('; '));
    return rec;
}

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

function readEffortMisses(state) {
    const records = Array.isArray(state?.effort_misses) ? state.effort_misses : [];
    return records.length ? { status: 'RECORDED', records } : { status: 'UNKNOWN', records: [] };
}

// entries: [{ taskId, state }]. Só devolve runs com registro; sem nenhum = UNKNOWN.
function projectEffortMisses(entries) {
    const runs = [];
    const byPhase = {};
    let total = 0;
    for (const { taskId, state } of entries || []) {
        const r = readEffortMisses(state);
        if (r.status !== 'RECORDED') continue;
        runs.push({ taskId, records: r.records });
        for (const rec of r.records) {
            const bucket = (byPhase[rec.phase] ||= { yes: 0, no: 0, unknown: 0 });
            bucket[WOULD_HIGH_CATCH.includes(rec.would_high_catch) ? rec.would_high_catch : 'unknown']++;
            total++;
        }
    }
    return {
        status: runs.length ? 'RECORDED' : 'UNKNOWN',
        total: runs.length ? total : null,
        runs,
        by_phase: byPhase,
        note: 'Ausência de registro é UNKNOWN, nunca zero erros. would_high_catch é julgamento de quem registrou.',
    };
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

module.exports = { buildRecord, validateRecord, recordEffortMiss, readEffortMisses, projectEffortMisses, WOULD_HIGH_CATCH, RECORDED_BY };
