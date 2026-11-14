'use strict';
// PRI-353 (T2; AC2, AC3, AC7): esforço fixo por fase no argv do `claude -p`, atrás da flag
// WATCHER_PHASE_EFFORT (desligada por padrão). SPEC: tasks/effort-por-fase/SPEC.md.
//
// Flag desligada = nenhum efeito: não lê a tabela e devolve argv vazio (golden em
// phase-effort.test.js). Esta flag é independente da policy de roteamento (PRI-352): não mexe em
// PRODUCTION_EFFORT_MECHANISM. Run roteada com esforço já aplicado pela policy manda a policy.
//
// A tabela é asset da plataforma (resolvida pelo próprio checkout, não pelo consumidor).

const fs = require('fs');
const path = require('path');

const { CLI_EFFORTS } = require('./model-routing-policy');

const DEFAULT_TABLE_PATH = path.resolve(__dirname, '..', '..', '.claude', 'phase-effort.json');
// Nós do grafo (.graph/graph.yaml); fetch_ticket é só a entrada do ticket e fica fora.
const TABLE_NODES = new Set(['plan', 'implement', 'review', 'test', 'verify', 'commit']);
const ORDER = ['low', 'medium', 'high', 'xhigh', 'max'];

function phaseEffortEnabled(env = process.env) {
    return /^(1|true|sim)$/i.test(env.WATCHER_PHASE_EFFORT || '');
}

function loadPhaseEffortTable(file = DEFAULT_TABLE_PATH) {
    let raw;
    try {
        raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (e) {
        return { ok: false, error: `PHASE_EFFORT_TABLE_UNREADABLE: ${e.code || e.name}` };
    }
    const table = raw && raw.table;
    if (!table || typeof table !== 'object' || Array.isArray(table)) return { ok: false, error: 'PHASE_EFFORT_TABLE_MISSING' };
    for (const [node, level] of Object.entries(table)) {
        if (!TABLE_NODES.has(node)) return { ok: false, error: `PHASE_EFFORT_NODE_UNKNOWN:${node}` };
        if (!CLI_EFFORTS.has(level)) return { ok: false, error: `PHASE_EFFORT_LEVEL_INVALID:${node}` };
    }
    return { ok: true, table: { ...table } };
}

// Devolve { args, level }. Segmento com vários nós usa o nível mais alto entre eles.
function phaseEffortArgs({ nodes, enabled, table, routedEffortApplied = false }) {
    const none = { args: [], level: null };
    if (!enabled) return none;
    if (!table) throw new Error('PHASE_EFFORT_TABLE_REQUIRED');
    if (routedEffortApplied) return none;
    const levels = (Array.isArray(nodes) ? nodes : []).map(n => table[n]).filter(Boolean);
    if (!levels.length) return none;
    const level = levels.reduce((a, b) => (ORDER.indexOf(b) > ORDER.indexOf(a) ? b : a));
    return { args: ['--effort', level], level };
}

module.exports = { phaseEffortEnabled, loadPhaseEffortTable, phaseEffortArgs, DEFAULT_TABLE_PATH, TABLE_NODES };
