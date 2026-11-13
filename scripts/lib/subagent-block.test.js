// node --test scripts/lib/subagent-block.test.js
// PRI-315: forma do bloqueio de subagente no argv do plan (unidade + watcher).
// A parte do watcher usa REPO_PATH sintético, fetch stubado (nenhum Redmine real) e um
// binário `claude` falso no PATH que grava o argv em JSON (nenhum agente real), no mesmo
// arranjo do plan-scorer.test.js.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { subagentBlockArgs, planDenySettingsEnabled, DENY_SETTINGS_JSON, NO_SUBAGENT_NODES } = require('./subagent-block');

// Expressão do AS-IS (readmine-watcher.js @ 5560d29, linha 4313), copiada literalmente.
const AS_IS_NO_SUBAGENT_NODES = new Set(['plan']);
const asIs = nodes => (nodes.some(n => AS_IS_NO_SUBAGENT_NODES.has(n)) ? ['--disallowedTools', 'Agent,Task'] : []);

const NODE_LISTS = [['plan'], ['fetch_ticket', 'plan'], ['implement'], ['review'], ['verify'], ['fetch_ticket'], []];

// ---------------------------------------------------------------------------------
// Unidade

test('AC3: flag desligada devolve exatamente o trecho do AS-IS, roteado ou não', () => {
    assert.deepStrictEqual([...NO_SUBAGENT_NODES], [...AS_IS_NO_SUBAGENT_NODES]);
    for (const nodes of NODE_LISTS) {
        for (const routed of [false, true]) {
            assert.deepStrictEqual(subagentBlockArgs({ nodes, routed, denySettings: false }), asIs(nodes), JSON.stringify({ nodes, routed }));
        }
    }
});

test('flag ligada, plan não roteado: permissions.deny [Agent, Task] por --settings inline', () => {
    assert.deepStrictEqual(subagentBlockArgs({ nodes: ['plan'], denySettings: true }), ['--settings', DENY_SETTINGS_JSON]);
    assert.deepStrictEqual(subagentBlockArgs({ nodes: ['fetch_ticket', 'plan'], denySettings: true }), ['--settings', DENY_SETTINGS_JSON]);
    assert.deepStrictEqual(JSON.parse(DENY_SETTINGS_JSON), { permissions: { deny: ['Agent', 'Task'] } });
});

test('flag ligada, run roteada (já leva --settings da SP-2): fica no AS-IS (D1)', () => {
    assert.deepStrictEqual(subagentBlockArgs({ nodes: ['plan'], routed: true, denySettings: true }), ['--disallowedTools', 'Agent,Task']);
});

test('flag ligada, nó sem bloqueio: argv sem nada', () => {
    for (const nodes of [['implement'], ['review'], ['verify'], []]) {
        assert.deepStrictEqual(subagentBlockArgs({ nodes, denySettings: true }), []);
    }
});

test('WATCHER_PLAN_DENY_SETTINGS: só 1|true|sim ligam; ausente ou outro valor = desligada', () => {
    assert.strictEqual(planDenySettingsEnabled({}), false);
    for (const v of ['1', 'true', 'TRUE', 'sim']) assert.strictEqual(planDenySettingsEnabled({ WATCHER_PLAN_DENY_SETTINGS: v }), true, v);
    for (const v of ['', '0', 'false', 'nao', 'yes']) assert.strictEqual(planDenySettingsEnabled({ WATCHER_PLAN_DENY_SETTINGS: v }), false, v);
});

// ---------------------------------------------------------------------------------
// Watcher: argv real do despacho do plan

const SPEC = `## Problema
Texto descritivo suficiente para passar do limite mínimo de caracteres exigido pela validação. Hoje o filtro lista tudo.

## Solução
Texto descritivo suficiente para passar do limite mínimo de caracteres exigido pela validação. Filtrar pelo resultado.

## Critérios de Aceite
- Filtro lista somente itens presentes no resultado da tela.
- Novo filtro de operação com o mesmo comportamento dinâmico.
- Paginação continua funcionando sem regressão.

## Restrições
- Não alterar o contrato do endpoint.

## Arquivos Afetados
- Service.java

## Dependências
- Nenhuma.
`;

// Plano reprovado no score → o watcher redespacha o /plan (re-plan), o caminho mais curto
// até um despacho do nó plan sem Redmine real.
const BAD_PLAN = '# Handoff\n\n## Plano de execução\n1. Ajustar o código.\n2. Fazer os ajustes necessários.\n';

const tmp = fs.mkdtempSync(path.join(process.env.CLAUDE_JOB_DIR ? path.join(process.env.CLAUDE_JOB_DIR, 'tmp') : os.tmpdir(), 'subagent-block-'));
const repo = path.join(tmp, 'app-back');
const binDir = path.join(tmp, 'bin');
const claudeCalls = path.join(tmp, 'claude-calls.jsonl');
fs.mkdirSync(repo, { recursive: true });
fs.mkdirSync(binDir);
fs.writeFileSync(path.join(binDir, 'claude'),
    `#!/usr/bin/env node\nrequire('fs').appendFileSync(${JSON.stringify(claudeCalls)}, JSON.stringify(process.argv.slice(2)) + '\\n');\n`,
    { mode: 0o755 });
process.env.REPO_PATH = repo;
process.env.REDMINE_URL = 'http://redmine.test';
process.env.REDMINE_API_KEY = 'k';
process.env.SPEC_AUTO_REPAIR = '0';
process.env.SKIP_PRE_BUILD_VALIDATION = 'true';
delete process.env.PLAN_SCORE_THRESHOLD;
delete process.env.WATCHER_PLAN_DENY_SETTINGS;
process.env.PATH = `${binDir}:${process.env.PATH}`;

global.fetch = async url => {
    const id = Number((/issues\/(\d+)\.json/.exec(url) || [])[1]);
    return { ok: true, status: 200, json: async () => ({ issue: { id, journals: [] } }) };
};

const watcher = require('../readmine-watcher');
const PRISMA_ROOT = path.resolve(__dirname, '..', '..');

function ticket(id) {
    return {
        id, subject: `Ticket ${id}`, description: SPEC, status: { name: 'Aprovada' }, tracker: { name: 'Melhoria' },
        custom_fields: [{ name: 'Branch Liberação', value: 'Dev - Local' }],
        updated_on: new Date().toISOString(),
    };
}

function seedPlannedTask(id) {
    const wt = path.join(repo, '.claude', 'worktrees', String(id));
    const taskId = `${id}-teste`;
    const dir = path.join(wt, 'memory', 'runs', taskId);
    fs.mkdirSync(dir, { recursive: true });
    fs.mkdirSync(path.join(wt, 'memory', 'spec'), { recursive: true });
    fs.writeFileSync(path.join(wt, 'memory', 'spec', `${id}-spec.md`), SPEC);
    fs.writeFileSync(path.join(dir, 'handoff.md'), BAD_PLAN);
    fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({
        task_id: taskId, node: 'implement', history: ['fetch_ticket', 'plan'], status: 'in_progress',
        started_at: '2026-09-01T00:00:00.000Z',
    }));
    return taskId;
}

async function planArgv(taskId) {
    for (let i = 0; i < 100; i++) {
        if (fs.existsSync(claudeCalls)) {
            const call = fs.readFileSync(claudeCalls, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l))
                .find(a => a[0] === '-p' && a[1].includes(`/plan ${taskId}`));
            if (call) return call;
        }
        await new Promise(r => setTimeout(r, 50));
    }
    assert.fail(`sem despacho do /plan ${taskId}`);
}

// Trecho fixo do argv do plan, do --permission-mode ao --add-dir (sem prompt e session-id,
// que mudam a cada despacho). Golden do AS-IS @ 5560d29.
const fixedSlice = argv => argv.slice(argv.indexOf('--permission-mode'), argv.indexOf('--add-dir') + 2);
const AS_IS_FIXED = [
    '--permission-mode', 'acceptEdits',
    '--allowedTools', 'mcp__redmine__*,Read,Edit,Write,Bash,Grep,Glob',
    '--disallowedTools', 'Agent,Task',
    '--add-dir', PRISMA_ROOT,
];

test('AC3 (watcher): flag desligada → argv do plan byte-idêntico ao AS-IS', async () => {
    delete process.env.WATCHER_PLAN_DENY_SETTINGS;
    const taskId = seedPlannedTask(93151);
    const result = await watcher.dispatchTicket(ticket(93151));
    assert.strictEqual(result.node, 'plan');
    const argv = await planArgv(taskId);
    assert.deepStrictEqual(fixedSlice(argv), AS_IS_FIXED);
    assert.deepStrictEqual(argv.slice(0, 1).concat(argv.slice(2, 3), argv.slice(4, 5)), ['-p', '--name', '--session-id']);
    assert.ok(!argv.includes('--settings'));
});

test('flag ligada → plan com --settings permissions.deny e sem --disallowedTools; resto igual', async () => {
    process.env.WATCHER_PLAN_DENY_SETTINGS = '1';
    try {
        const taskId = seedPlannedTask(93152);
        const result = await watcher.dispatchTicket(ticket(93152));
        assert.strictEqual(result.node, 'plan');
        const argv = await planArgv(taskId);
        assert.deepStrictEqual(fixedSlice(argv), [
            '--permission-mode', 'acceptEdits',
            '--allowedTools', 'mcp__redmine__*,Read,Edit,Write,Bash,Grep,Glob',
            '--settings', '{"permissions":{"deny":["Agent","Task"]}}',
            '--add-dir', PRISMA_ROOT,
        ]);
        assert.ok(!argv.includes('--disallowedTools'));
    } finally {
        delete process.env.WATCHER_PLAN_DENY_SETTINGS;
    }
});

// Sem rmSync no fim: o watcher ainda grava no run depois do despacho (mesma escolha do
// plan-scorer.test.js); o harness usa HOME/TMPDIR sintéticos.
