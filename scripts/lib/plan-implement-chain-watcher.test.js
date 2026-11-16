// node --test scripts/lib/plan-implement-chain-watcher.test.js
// PRI-354 (AC1–AC3): despacho real do watcher com o `claude` falso (mesmo harness do
// phase-effort-watcher.test.js). Flag desligada = plan avulso de sempre; ligada = um único
// `claude -p` com /plan → plan-scorer → /implement, dois Attempts DOM06 e eventos só dos nós que
// rodaram. O claude falso não grava nada, então o plan "não terminou": o Attempt do implement é
// revogado e não há node_end do implement.
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

const tmp = fs.mkdtempSync(path.join(process.env.CLAUDE_JOB_DIR ? path.join(process.env.CLAUDE_JOB_DIR, 'tmp') : os.tmpdir(), 'chain-watcher-'));
const repo = path.join(tmp, 'app-back');
const binDir = path.join(tmp, 'bin');
const claudeCalls = path.join(tmp, 'claude-calls.jsonl');
fs.mkdirSync(repo, { recursive: true });
fs.mkdirSync(binDir);
// Plano que passa no scorer contra SPEC (100/100): a saída confere o plano de novo (G3 MINOR 5).
const GOOD_PLAN = "# Plano\n\n## Plano de execu\u00e7\u00e3o\n\n1. Filtrar a lista para mostrar somente itens presentes no resultado da tela (crit\u00e9rio 1).\n   - Arquivo: `app-core/src/main/java/app/Service.java`\n   - Verifica\u00e7\u00e3o: teste unit\u00e1rio confere que o filtro lista somente itens do resultado.\n2. Criar o novo filtro de opera\u00e7\u00e3o com o mesmo comportamento din\u00e2mico (crit\u00e9rio 2).\n   - Arquivo: `app-core/src/main/java/app/OperacaoFilter.java`\n   - Verifica\u00e7\u00e3o: teste unit\u00e1rio do filtro de opera\u00e7\u00e3o din\u00e2mico.\n3. Garantir que a pagina\u00e7\u00e3o continua funcionando sem regress\u00e3o (crit\u00e9rio 3).\n   - Arquivo: `app-core/src/test/java/app/PaginacaoTest.java`\n   - Verifica\u00e7\u00e3o: teste de pagina\u00e7\u00e3o passa sem regress\u00e3o.\n";
// FAKE_CHAIN: o que o agente "faz" no segmento (só no despacho com /implement no prompt).
//   plan-only  → /plan concluído (node=implement), scorer reprovou, sai 0;
//   plan-fail  → /plan concluído, sessão cai no implement (sai 143);
//   complete   → plan e implement concluídos, sem duplicar `plan` no histórico (re-plan; G3 MAJOR 1);
//   bad-plan   → como complete, mas com plan.md que reprova no scorer.
// Sem FAKE_CHAIN o agente não grava nada (plan não concluído).
fs.writeFileSync(path.join(binDir, 'claude'),
    `#!/usr/bin/env node
const fs = require('fs');
fs.appendFileSync(${JSON.stringify(claudeCalls)}, JSON.stringify(process.argv.slice(2)) + '\\n');
const mode = process.env.FAKE_CHAIN || '';
const m = /\\/implement ([\\w-]+)/.exec(process.argv[3] || '');
if (mode && m) {
    const dir = 'memory/runs/' + m[1];
    const f = dir + '/state.json';
    const s = JSON.parse(fs.readFileSync(f, 'utf8'));
    fs.writeFileSync(dir + '/plan.md', mode === 'bad-plan' ? '# Plano\\n\\n## Plano de execução\\n1. Ajustar.\\n' : ${JSON.stringify(GOOD_PLAN)});
    s.node = 'implement';
    if (mode === 'complete' || mode === 'bad-plan') { s.history = [...(s.history || []), 'implement']; s.node = 'review'; }
    // Escrita atômica: released() lê este arquivo em paralelo e um writeFileSync direto
    // deixa uma janela de arquivo vazio ("Unexpected end of JSON input", intermitente sob carga).
    fs.writeFileSync(f + '.fake.tmp', JSON.stringify(s));
    fs.renameSync(f + '.fake.tmp', f);
    if (mode === 'plan-fail') process.exit(143);
}
`,
    { mode: 0o755 });
process.env.REPO_PATH = repo;
process.env.REDMINE_URL = 'http://redmine.test';
process.env.REDMINE_API_KEY = 'k';
process.env.SPEC_AUTO_REPAIR = '0';
process.env.SKIP_PRE_BUILD_VALIDATION = 'true';
delete process.env.PLAN_SCORE_THRESHOLD;
delete process.env.WATCHER_PHASE_EFFORT;
delete process.env.WATCHER_PLAN_DENY_SETTINGS;
delete process.env.WATCHER_PLAN_IMPLEMENT_CHAIN;
delete process.env.FAKE_CHAIN;
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

// Plano ruim: o portão do watcher manda re-plan, e o próximo despacho é o plan (sem implement no histórico).
function seedPlannedTask(id, { spec = true } = {}) {
    const wt = path.join(repo, '.claude', 'worktrees', String(id));
    const taskId = `${id}-teste`;
    const dir = path.join(wt, 'memory', 'runs', taskId);
    fs.mkdirSync(dir, { recursive: true });
    fs.mkdirSync(path.join(wt, 'memory', 'spec'), { recursive: true });
    if (spec) fs.writeFileSync(path.join(wt, 'memory', 'spec', `${id}-spec.md`), SPEC);
    fs.writeFileSync(path.join(dir, 'handoff.md'), BAD_PLAN);
    fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({
        task_id: taskId, node: 'implement', history: ['fetch_ticket', 'plan'], status: 'in_progress',
        started_at: '2026-09-01T00:00:00.000Z',
    }));
    return { taskId, dir };
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

// Espera o release do wrapper destacado (node-lease.js release) gravar a saída do nó.
async function released(dir) {
    for (let i = 0; i < 200; i++) {
        const s = JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'));
        if (s.status !== 'running' && (s.events || []).some(e => e.type === 'node_end' || e.type === 'node_error')) return s;
        await new Promise(r => setTimeout(r, 50));
    }
    assert.fail(`sem release em ${dir}`);
}

// Só os .json finais (a escrita atômica do dom06 passa por <id>.json.<pid>.tmp); arquivo que
// some entre o readdir e a leitura é ignorado (G3 MINOR 5: corrida com o release).
const attempts = dir => {
    const d = path.join(dir, 'dom06', 'attempts');
    if (!fs.existsSync(d)) return [];
    return fs.readdirSync(d).filter(f => f.endsWith('.json')).flatMap(f => {
        try { return [JSON.parse(fs.readFileSync(path.join(d, f), 'utf8'))]; } catch { return []; }
    });
};

// Espera o release fechar os Attempts (ele grava os eventos antes de fechá-los).
async function settled(dir, done) {
    let byNode = {};
    for (let i = 0; i < 200; i++) {
        byNode = Object.fromEntries(attempts(dir).map(a => [a.node, a]));
        if (done(byNode)) return byNode;
        await new Promise(r => setTimeout(r, 50));
    }
    assert.fail(`Attempts não fecharam em ${dir}: ${JSON.stringify(Object.values(byNode).map(a => [a.node, a.authority, a.obligations]))}`);
}
const fulfilled = a => !!a?.obligations?.some(o => o.id === 'execute_node' && o.status === 'fulfilled');
const revoked = a => a?.authority === 'revoked';

test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const AS_IS_FIXED = [
    '--permission-mode', 'acceptEdits',
    '--allowedTools', 'mcp__redmine__*,Read,Edit,Write,Bash,Grep,Glob',
    '--disallowedTools', 'Agent,Task',
    '--add-dir', PRISMA_ROOT,
];
const fixedSlice = argv => argv.slice(argv.indexOf('--permission-mode'), argv.indexOf('--add-dir') + 2);

test('AC1: flag desligada → plan avulso de sempre (argv, um Attempt, eventos do plan)', async () => {
    delete process.env.WATCHER_PLAN_IMPLEMENT_CHAIN;
    const { taskId, dir } = seedPlannedTask(93541);
    const result = await watcher.dispatchTicket(ticket(93541));
    assert.strictEqual(result.node, 'plan');
    const argv = await planArgv(taskId);
    assert.deepStrictEqual(fixedSlice(argv), AS_IS_FIXED);
    assert.ok(!argv[1].includes(`/implement ${taskId}`));
    assert.ok(!argv[1].includes('plan-scorer.js'));
    assert.ok(!argv[1].includes('mesma sessão'));
    const s = await released(dir);
    const byNode = await settled(dir, b => fulfilled(b.plan));
    assert.deepStrictEqual(Object.keys(byNode), ['plan']);
    assert.ok(!(s.events || []).some(e => e.node === 'implement'));
    assert.match(s.events.filter(e => e.type === 'node_start').at(-1).detail, /^Despachando plan para Claude/);
});

async function chainRun(id, mode, { spec = true } = {}) {
    process.env.WATCHER_PLAN_IMPLEMENT_CHAIN = '1';
    if (mode) process.env.FAKE_CHAIN = mode;
    try {
        const { taskId, dir } = seedPlannedTask(id, { spec });
        const result = await watcher.dispatchTicket(ticket(id));
        const argv = await planArgv(taskId);
        return { taskId, dir, result, argv };
    } finally {
        delete process.env.WATCHER_PLAN_IMPLEMENT_CHAIN;
        delete process.env.FAKE_CHAIN;
    }
}

test('AC2: flag ligada → um claude -p com /plan, plan-scorer e /implement, sem bloqueio de subagente', async () => {
    const { taskId, result, argv } = await chainRun(93542);
    assert.strictEqual(result.node, 'plan');
    const prompt = argv[1];
    const iPlan = prompt.indexOf(`/plan ${taskId}`);
    const iScorer = prompt.indexOf(`plan-scorer.js" memory/runs/${taskId}/plan.md memory/spec/93542-spec.md`);
    const iImpl = prompt.indexOf(`/implement ${taskId}`);
    assert.ok(iPlan >= 0 && iScorer > iPlan && iImpl > iScorer, 'ordem /plan → scorer → /implement');
    assert.match(prompt, /NÃO rode o \/implement/);
    assert.ok(!argv.includes('--disallowedTools'));
    assert.ok(!argv.includes('--settings'));
});

test('AC2: flag ligada sem spec no worktree → plan avulso (SPEC_MISSING)', async () => {
    const { taskId, argv } = await chainRun(93543, null, { spec: false });
    assert.ok(!argv[1].includes(`/implement ${taskId}`));
    assert.deepStrictEqual(fixedSlice(argv), AS_IS_FIXED);
});

test('AC2: flag ligada com pré-build ativo → plan avulso (PRE_BUILD_ACTIVE)', async () => {
    delete process.env.SKIP_PRE_BUILD_VALIDATION;
    try {
        const { taskId, argv } = await chainRun(93544);
        assert.ok(!argv[1].includes(`/implement ${taskId}`));
    } finally {
        process.env.SKIP_PRE_BUILD_VALIDATION = 'true';
    }
});

test('AC2: admissão DOM06 do implement recusada → plan avulso, com bloqueio de subagente', async () => {
    const dom06 = require('./dom06-attempt');
    const orig = dom06.prepareDispatch;
    dom06.prepareDispatch = args => (args.node === 'implement'
        ? { dispatch: false, attempt: { result: 'UNKNOWN' }, reason: 'ADMISSION_UNKNOWN' }
        : orig(args));
    try {
        const { taskId, dir, argv } = await chainRun(93547);
        assert.ok(!argv[1].includes(`/implement ${taskId}`));
        assert.deepStrictEqual(fixedSlice(argv), AS_IS_FIXED);
        await released(dir);
        assert.deepStrictEqual(Object.keys(await settled(dir, b => fulfilled(b.plan))), ['plan']);
    } finally {
        dom06.prepareDispatch = orig;
    }
});

test('AC3: agente não conclui o plan → Attempt do implement revogado (CHAIN_PLAN_NOT_DONE), sem eventos do implement', async () => {
    const { dir } = await chainRun(93545);
    const s = await released(dir);
    const byNode = await settled(dir, b => revoked(b.implement));
    assert.strictEqual(byNode.plan.started, true);
    assert.strictEqual(byNode.implement.started, true);
    assert.strictEqual(byNode.implement.revoke_reason, 'CHAIN_PLAN_NOT_DONE');
    assert.ok(!fulfilled(byNode.implement));
    assert.match(s.events.filter(e => e.type === 'node_start').at(-1).detail, /plan\+implement \(mesma sessão\)/);
    assert.ok(!s.events.some(e => e.node === 'implement'));
});

test('AC4: plan concluído e reprovado no scorer → plan cumprido, implement revogado (CHAIN_STOPPED_AFTER_PLAN), só node_end do plan', async () => {
    const { dir } = await chainRun(93548, 'plan-only');
    const s = await released(dir);
    const byNode = await settled(dir, b => revoked(b.implement) && fulfilled(b.plan));
    assert.strictEqual(byNode.implement.revoke_reason, 'CHAIN_STOPPED_AFTER_PLAN');
    const ends = s.events.filter(e => e.type === 'node_end').map(e => e.node);
    assert.ok(ends.includes('plan'));
    assert.ok(!s.events.some(e => e.node === 'implement'));
    // o próximo tick cai no portão do plano de sempre
    assert.strictEqual(s.node, 'implement');
});

test('AC3 (G3 MAJOR 2): sessão cai no implement depois do plan → node_end do plan, node_error do implement, plan cumprido', async () => {
    const { dir } = await chainRun(93549, 'plan-fail');
    const byNode = await settled(dir, b => revoked(b.implement) && fulfilled(b.plan));
    assert.strictEqual(byNode.implement.revoke_reason, 'CHAIN_IMPLEMENT_NOT_CONFIRMED');
    const s = JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'));
    const tail = s.events.slice(-3).map(e => [e.type, e.node]);
    assert.deepStrictEqual(tail, [['node_start', 'implement'], ['node_end', 'plan'], ['node_error', 'implement']]);
    assert.ok(!s.events.some(e => e.type === 'node_error' && e.node === 'plan'));
});

test('AC3/AC4 (G3 MAJOR 1): plan e implement concluídos sem plan duplicado → implement cumprido e node_end dos dois', async () => {
    const { dir } = await chainRun(93546, 'complete');
    const byNode = await settled(dir, b => fulfilled(b.implement) && fulfilled(b.plan));
    assert.ok(!revoked(byNode.implement));
    const s = JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'));
    assert.deepStrictEqual(s.history, ['fetch_ticket', 'plan', 'implement']);
    const ends = s.events.filter(e => e.type === 'node_end').map(e => e.node);
    assert.deepStrictEqual(ends.slice(-2), ['plan', 'implement']);
    assert.ok(s.events.some(e => e.type === 'node_start' && e.node === 'implement' && /UNKNOWN/.test(e.detail)));
});

test('G3 MINOR 5: implement rodou sobre plano que reprova no scorer → Attempt do implement revogado (CHAIN_PLAN_GATE_FAILED)', async () => {
    const { dir } = await chainRun(93550, 'bad-plan');
    const byNode = await settled(dir, b => revoked(b.implement));
    assert.strictEqual(byNode.implement.revoke_reason, 'CHAIN_PLAN_GATE_FAILED');
    assert.ok(!fulfilled(byNode.implement));
});
