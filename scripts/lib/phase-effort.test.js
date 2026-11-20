// node --test scripts/lib/phase-effort.test.js
// PRI-353 T2 (AC2, AC3, AC7): esforço fixo por fase no argv do despacho, atrás de flag.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
    phaseEffortEnabled, loadPhaseEffortTable, phaseEffortArgs, DEFAULT_TABLE_PATH,
} = require('./phase-effort');
const { CLI_EFFORTS } = require('./model-routing-policy');

const TABLE = { plan: 'high', implement: 'high', review: 'high', test: 'medium', verify: 'medium', commit: 'low' };
const NODE_LISTS = [['plan'], ['implement'], ['review'], ['test'], ['verify'], ['commit'], ['fetch_ticket'], ['fetch_ticket', 'plan'], []];

test('WATCHER_PHASE_EFFORT: só 1|true|sim ligam; ausente ou outro valor = desligada', () => {
    assert.strictEqual(phaseEffortEnabled({}), false);
    for (const v of ['1', 'true', 'TRUE', 'sim']) assert.strictEqual(phaseEffortEnabled({ WATCHER_PHASE_EFFORT: v }), true, v);
    for (const v of ['', '0', 'false', 'nao', 'yes']) assert.strictEqual(phaseEffortEnabled({ WATCHER_PHASE_EFFORT: v }), false, v);
});

test('AC2: flag desligada devolve argv vazio para qualquer nó, roteado ou não, e nem lê a tabela', () => {
    for (const nodes of NODE_LISTS) {
        for (const routedEffortApplied of [false, true]) {
            const r = phaseEffortArgs({ nodes, enabled: false, table: null, routedEffortApplied });
            assert.deepStrictEqual(r, { args: [], level: null }, JSON.stringify({ nodes, routedEffortApplied }));
        }
    }
});

test('AC3: flag ligada, cada nó da tabela recebe o --effort dela', () => {
    for (const [node, level] of Object.entries(TABLE)) {
        assert.deepStrictEqual(phaseEffortArgs({ nodes: [node], enabled: true, table: TABLE }), { args: ['--effort', level], level }, node);
    }
});

test('nó sem entrada na tabela herda o esforço da sessão (argv vazio)', () => {
    assert.deepStrictEqual(phaseEffortArgs({ nodes: ['fetch_ticket'], enabled: true, table: TABLE }), { args: [], level: null });
    assert.deepStrictEqual(phaseEffortArgs({ nodes: [], enabled: true, table: TABLE }), { args: [], level: null });
});

test('segmento com vários nós usa o nível mais alto entre eles', () => {
    assert.deepStrictEqual(phaseEffortArgs({ nodes: ['test', 'plan'], enabled: true, table: TABLE }).level, 'high');
    assert.deepStrictEqual(phaseEffortArgs({ nodes: ['test', 'verify'], enabled: true, table: TABLE }).level, 'medium');
    assert.deepStrictEqual(phaseEffortArgs({ nodes: ['commit', 'fetch_ticket'], enabled: true, table: TABLE }).level, 'low');
});

test('run roteada com esforço já aplicado pela policy: não duplica --effort', () => {
    assert.deepStrictEqual(phaseEffortArgs({ nodes: ['plan'], enabled: true, table: TABLE, routedEffortApplied: true }), { args: [], level: null });
});

test('flag ligada sem tabela válida falha alto, em vez de despachar sem esforço em silêncio', () => {
    assert.throws(() => phaseEffortArgs({ nodes: ['plan'], enabled: true, table: null }), /PHASE_EFFORT_TABLE_REQUIRED/);
});

function tmpJson(obj) {
    const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'phase-effort-')), 'phase-effort.json');
    fs.writeFileSync(f, typeof obj === 'string' ? obj : JSON.stringify(obj));
    return f;
}

test('tabela versionada do repositório: válida, só níveis da CLI e cobre os nós do fluxo de código', () => {
    const r = loadPhaseEffortTable(DEFAULT_TABLE_PATH);
    assert.strictEqual(r.ok, true, r.error);
    assert.deepStrictEqual(r.table, TABLE);
    for (const level of Object.values(r.table)) assert.ok(CLI_EFFORTS.has(level), level);
});

test('AC7: o JSON fixa o critério de reabertura da escalada dinâmica', () => {
    const raw = JSON.parse(fs.readFileSync(DEFAULT_TABLE_PATH, 'utf8'));
    assert.deepStrictEqual(raw.reopen_criteria, {
        min_runs_with_flag: 15, min_yes_same_class_and_phase: 3, max_share_of_runs_with_yes_per_phase: 0.2,
    });
});

test('tabela inválida: nível fora de CLI_EFFORTS, nó desconhecido, JSON quebrado, arquivo ausente', () => {
    assert.strictEqual(loadPhaseEffortTable(tmpJson({ version: 1, table: { plan: 'turbo' } })).ok, false);
    assert.strictEqual(loadPhaseEffortTable(tmpJson({ version: 1, table: { planejar: 'high' } })).ok, false);
    assert.strictEqual(loadPhaseEffortTable(tmpJson({ version: 1 })).ok, false);
    assert.strictEqual(loadPhaseEffortTable(tmpJson('{ não é json')).ok, false);
    assert.strictEqual(loadPhaseEffortTable(path.join(os.tmpdir(), 'nao-existe-phase-effort.json')).ok, false);
});

// ---------------------------------------------------------------------------------
// Registro no Attempt (AC3): campo opcional, ausente com a flag desligada (AC2)

const ct = require('./cost-tracking');
const { validateState } = require('../validate-state');

const stateWithRun = run => ({
    task_id: 'phase-effort', node: 'implement', history: ['fetch_ticket', 'plan'], status: 'in_progress',
    cost_tracking: ct.mergeRun(null, {
        node: 'plan', agent: 'claude', alsoCovers: ['fetch_ticket'], run,
        metrics: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: null, cache_creation_input_tokens: null, duration_ms: 1 },
    }),
});
const attemptOf = s => s.cost_tracking.nodes.plan.attempts[0];

test('AC2: sem phase_effort na run o Attempt não ganha chave nova (forma AS-IS)', () => {
    const s = stateWithRun({});
    assert.strictEqual('phase_effort' in attemptOf(s), false);
    assert.deepStrictEqual(attemptOf(s).requested, { model: 'UNAVAILABLE', effort: 'UNAVAILABLE' });
    assert.strictEqual(validateState(s).valid, true);
});

test('AC3: com phase_effort o Attempt grava o nível aplicado e effort_applied: true; schema aceita', () => {
    const s = stateWithRun({ phase_effort: { level: 'high', effort_applied: true } });
    assert.deepStrictEqual(attemptOf(s).phase_effort, { level: 'high', effort_applied: true });
    const r = validateState(s);
    assert.strictEqual(r.valid, true, (r.errors || []).join('\n'));
});

test('schema rejeita phase_effort com nível fora da CLI ou effort_applied falso', () => {
    for (const bad of [{ level: 'alto', effort_applied: true }, { level: 'high', effort_applied: false }, { level: 'high' }]) {
        const s = stateWithRun({ phase_effort: { level: 'high', effort_applied: true } });
        attemptOf(s).phase_effort = bad;
        assert.strictEqual(validateState(s).valid, false, JSON.stringify(bad));
    }
});

test('o par requested continua UNAVAILABLE sem roteamento (a coerência do PRI-334 não muda)', () => {
    const s = stateWithRun({ phase_effort: { level: 'high', effort_applied: true } });
    assert.deepStrictEqual(attemptOf(s).requested, { model: 'UNAVAILABLE', effort: 'UNAVAILABLE' });
});
