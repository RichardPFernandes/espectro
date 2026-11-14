// node --test scripts/lib/phase-effort-watcher.test.js
// PRI-353 T2 (AC2, AC3): argv real do despacho do plan com a flag desligada e ligada.
// Mesmo harness do subagent-block.test.js (claude falso que grava o argv).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

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
const BAD_PLAN = '# Handoff\n\n## Plano de execução\n1. Ajustar o código.\n2. Fazer os ajustes necessários.\n';

const tmp = fs.mkdtempSync(path.join(process.env.CLAUDE_JOB_DIR ? path.join(process.env.CLAUDE_JOB_DIR, 'tmp') : os.tmpdir(), 'phase-effort-'));
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
delete process.env.WATCHER_PHASE_EFFORT;
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

const fixedSlice = argv => argv.slice(argv.indexOf('--permission-mode'), argv.indexOf('--add-dir') + 2);
const AS_IS_FIXED = [
    '--permission-mode', 'acceptEdits',
    '--allowedTools', 'mcp__redmine__*,Read,Edit,Write,Bash,Grep,Glob',
    '--disallowedTools', 'Agent,Task',
    '--add-dir', PRISMA_ROOT,
];

test('AC2 (watcher): flag desligada → argv do plan sem --effort e idêntico ao AS-IS', async () => {
    delete process.env.WATCHER_PHASE_EFFORT;
    const taskId = seedPlannedTask(93161);
    const result = await watcher.dispatchTicket(ticket(93161));
    assert.strictEqual(result.node, 'plan');
    const argv = await planArgv(taskId);
    assert.deepStrictEqual(fixedSlice(argv), AS_IS_FIXED);
    assert.ok(!argv.includes('--effort'));
});

test('AC3 (watcher): flag ligada → plan leva --effort high no fim; o resto do argv não muda', async () => {
    process.env.WATCHER_PHASE_EFFORT = '1';
    try {
        const taskId = seedPlannedTask(93162);
        const result = await watcher.dispatchTicket(ticket(93162));
        assert.strictEqual(result.node, 'plan');
        const argv = await planArgv(taskId);
        assert.deepStrictEqual(argv.slice(-2), ['--effort', 'high']);
        assert.deepStrictEqual(fixedSlice(argv), AS_IS_FIXED);
        assert.strictEqual(argv.filter(a => a === '--effort').length, 1);
    } finally {
        delete process.env.WATCHER_PHASE_EFFORT;
    }
});

// PRI-353 T4 (AC4): instrução de handoff no extraNote, só com a flag ligada.
test('AC4 (watcher): flag desligada → prompt do plan sem a instrução de handoff', async () => {
    delete process.env.WATCHER_PHASE_EFFORT;
    const taskId = seedPlannedTask(93163);
    await watcher.dispatchTicket(ticket(93163));
    const argv = await planArgv(taskId);
    assert.ok(!argv[1].includes('Handoff desta fase'));
    assert.ok(!argv[1].includes('handoff-lint.js'));
});

test('AC4 (watcher): flag ligada → prompt do plan manda gravar ## Decisões e rodar o lint', async () => {
    process.env.WATCHER_PHASE_EFFORT = '1';
    try {
        const taskId = seedPlannedTask(93164);
        await watcher.dispatchTicket(ticket(93164));
        const argv = await planArgv(taskId);
        assert.match(argv[1], /Handoff desta fase/);
        assert.match(argv[1], /## Decisões/);
        assert.ok(argv[1].includes(`node ${PRISMA_ROOT}/scripts/lib/handoff-lint.js`));
        // o resto do argv segue como no AC3
        assert.deepStrictEqual(argv.slice(-2), ['--effort', 'high']);
        assert.deepStrictEqual(fixedSlice(argv), AS_IS_FIXED);
    } finally {
        delete process.env.WATCHER_PHASE_EFFORT;
    }
});

test('AC4 (watcher): tabela inválida com a flag ligada → sem instrução e sem derrubar o despacho', async () => {
    process.env.WATCHER_PHASE_EFFORT = '1';
    const phaseEffort = require('./phase-effort');
    const orig = phaseEffort.loadPhaseEffortTable;
    phaseEffort.loadPhaseEffortTable = () => ({ ok: false, error: 'PHASE_EFFORT_TABLE_MISSING' });
    try {
        const taskId = seedPlannedTask(93165);
        const result = await watcher.dispatchTicket(ticket(93165));
        assert.strictEqual(result.node, 'plan');
        const argv = await planArgv(taskId);
        assert.ok(!argv[1].includes('Handoff desta fase'));
        assert.ok(!argv.includes('--effort'));
    } finally {
        phaseEffort.loadPhaseEffortTable = orig;
        delete process.env.WATCHER_PHASE_EFFORT;
    }
});
