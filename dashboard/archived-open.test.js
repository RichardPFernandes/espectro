// node --test archived-open.test.js
// Arquivados (_archive/) cuja demanda ainda está aberta no Redmine voltam ao dashboard,
// só leitura. Repo sintético + Redmine falso local.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const tmpBase = process.env.CLAUDE_JOB_DIR ? path.join(process.env.CLAUDE_JOB_DIR, 'tmp') : os.tmpdir();
const tmp = fs.mkdtempSync(path.join(tmpBase, 'archived-open-'));
const repo = path.join(tmp, 'app-back');
const mainRuns = path.join(repo, 'memory', 'runs');
const wt = id => path.join(repo, '.claude', 'worktrees', id, 'memory', 'runs');

function seed(runsDir, taskId, state, context) {
    const dir = path.join(runsDir, taskId);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ task_id: taskId, history: [], ...state }));
    if (context) fs.writeFileSync(path.join(dir, 'context.md'), context);
    return dir;
}
const done = at => ({ node: 'commit', status: 'committed', updated_at: at, history: ['fetch_ticket', 'plan', 'implement', 'review', 'test', 'verify', 'commit'] });

// 94001: arquivado, ticket aberto (Ag Merge) -> aparece. Dois ciclos arquivados: só o mais recente.
seed(path.join(wt('94001'), '_archive'), '94001-ciclo-velho', done('2026-09-10T00:00:00Z'));
seed(path.join(wt('94001'), '_archive'), '94001-ciclo-novo', { ...done('2026-09-20T00:00:00Z'), pull_request: { 'app-back': { url: 'https://bitbucket.org/ws/app-back/pull-requests/1', status: 'open' } } }, '## Plano\n\nfeito\n');
// 94002: arquivado, ticket fechado -> não aparece.
seed(path.join(wt('94002'), '_archive'), '94002-fechado', done('2026-09-20T00:00:00Z'));
// 94003: arquivado com ticket aberto, mas já tem run ativo -> só o ativo aparece.
seed(path.join(wt('94003'), '_archive'), '94003-ciclo-1', done('2026-09-15T00:00:00Z'));
seed(wt('94003'), '94003-ciclo-2', { node: 'plan', status: 'in_progress', updated_at: '2026-09-21T00:00:00Z' });
// 94004: arquivado pelo dashboard (registro) -> não volta.
seed(path.join(wt('94004'), '_archive'), '94004-tirado', done('2026-09-20T00:00:00Z'));
fs.mkdirSync(path.join(mainRuns, '_archive'), { recursive: true });
fs.writeFileSync(path.join(mainRuns, '_archive', 'dashboard-archived.json'), JSON.stringify({ '94004-tirado': { archived_at: '2026-09-22T00:00:00Z' } }));
// 94005: status sem is_closed, nome "Concluído - Encerrado" -> fechado pelo nome.
seed(path.join(wt('94005'), '_archive'), '94005-por-nome', done('2026-09-20T00:00:00Z'));

const ISSUES = {
    94001: { status: { name: 'Ag Merge', is_closed: false }, assigned_to: { name: 'Dev' } },
    94002: { status: { name: 'Fechada', is_closed: true } },
    94003: { status: { name: 'Em Desenvolvimento', is_closed: false } },
    94004: { status: { name: 'Ag Teste', is_closed: false } },
    94005: { status: { name: 'Concluído - Encerrado' } },
};
const calls = [];
const FAIL = new Set(); // tickets em que o Redmine falha (500), como no Redmine instável
const redmine = http.createServer((req, res) => {
    const id = (req.url.match(/\/issues\/(\d+)\.json/) || [])[1];
    calls.push(id);
    if (FAIL.has(id)) { res.writeHead(500); return res.end('{}'); }
    if (!ISSUES[id]) { res.writeHead(404); return res.end('{}'); }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ issue: { id: Number(id), subject: `T${id}`, ...ISSUES[id] } }));
});

let dash, base;
test.before(async () => {
    await new Promise(r => redmine.listen(0, '127.0.0.1', r));
    process.env.REDMINE_URL = `http://127.0.0.1:${redmine.address().port}`;
    process.env.REDMINE_API_KEY = 'k-teste';
    const { createDashboard } = require('./server');
    dash = createDashboard({ memoryDir: mainRuns });
    await new Promise(r => dash.server.listen(0, '127.0.0.1', r));
    base = `http://localhost:${dash.server.address().port}`;
    await dash.ready;
});
test.after(async () => { await dash.close(); await new Promise(r => redmine.close(r)); });

const CACHE_FILE = path.join(mainRuns, '_archive', 'dashboard-issue-status.json');
function ageIssueCache() {
    const c = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    for (const e of Object.values(c)) e.at -= 2 * 60 * 60 * 1000;
    fs.writeFileSync(CACHE_FILE, JSON.stringify(c));
}
async function withDashboard(fn) {
    const { createDashboard } = require('./server');
    const d = createDashboard({ memoryDir: mainRuns });
    await new Promise(r => d.server.listen(0, '127.0.0.1', r));
    const b = `http://localhost:${d.server.address().port}`;
    try {
        await fetch(`${b}/api/archived-open/refresh`, { method: 'POST' });
        return await fn(b);
    } finally { await d.close(); }
}

const get = async p => { const r = await fetch(base + p); return { status: r.status, body: await r.json() }; };
const post = async (p, b = {}) => { const r = await fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }); return { status: r.status, body: await r.json() }; };

test('só entra arquivado com ticket aberto, sem run ativo e não tirado pelo dashboard', async () => {
    assert.strictEqual((await post('/api/archived-open/refresh')).status, 200);
    const runs = (await get('/api/runs')).body;
    const ids = runs.map(r => r.taskId).sort();
    assert.deepStrictEqual(ids, ['94001-ciclo-novo', '94003-ciclo-2']);
    const a = runs.find(r => r.taskId === '94001-ciclo-novo');
    assert.strictEqual(a.archived, true);
    assert.strictEqual(a.demand.status, 'Ag Merge');
    assert.strictEqual(a.kind, 'has_pr');
    assert.match(a.location, /_archive/);
    assert.ok(!runs.find(r => r.taskId === '94003-ciclo-2').archived);
    assert.ok(!calls.includes('94003'), 'ticket com run ativo nem é consultado');
    assert.ok(!calls.includes('94004'), 'arquivado pelo dashboard nem é consultado');
});

test('arquivado aberto: detalhe e log funcionam, mensagem e arquivar são recusados', async () => {
    const d = await get('/api/runs/94001-ciclo-novo');
    assert.strictEqual(d.status, 200);
    assert.strictEqual(d.body.archived, true);
    assert.match(d.body.context, /feito/);
    assert.match((await get('/api/runs/94001-ciclo-novo/log')).body.log, /Plano/);
    // Preview do context.md (PRI-211): arquivado lê o arquivo; sem ele, estado vazio sem erro.
    const ctx = await get('/api/runs/94001-ciclo-novo/context');
    assert.strictEqual(ctx.status, 200);
    assert.deepStrictEqual([ctx.body.archived, ctx.body.exists], [true, true]);
    assert.match(ctx.body.markdown, /## Plano/);
    const ctxFile = path.join(wt('94001'), '_archive', '94001-ciclo-novo', 'context.md');
    fs.renameSync(ctxFile, `${ctxFile}.bak`);
    try {
        const none = await get('/api/runs/94001-ciclo-novo/context');
        assert.strictEqual(none.status, 200);
        assert.deepStrictEqual([none.body.archived, none.body.exists, none.body.markdown], [true, false, null]);
    } finally { fs.renameSync(`${ctxFile}.bak`, ctxFile); }
    assert.strictEqual((await post('/api/runs/94001-ciclo-novo/message', { message: 'oi' })).status, 409);
    assert.ok(!fs.existsSync(path.join(wt('94001'), '_archive', '94001-ciclo-novo', 'human-input.md')));
    assert.strictEqual((await post('/api/runs/94001-ciclo-novo/archive', { force: true })).status, 409);
});

test('cache: nova varredura não reconsulta ticket aberto dentro de 5 min', async () => {
    const before = calls.length;
    await post('/api/archived-open/refresh');
    assert.strictEqual(calls.length, before);
});

test('ticket que fecha no Redmine sai na próxima consulta', async () => {
    ISSUES[94001] = { status: { name: 'Concluído - Encerrado', is_closed: true } };
    // Simula o TTL vencido: servidor novo lendo o cache persistido já envelhecido.
    ageIssueCache();
    const { createDashboard } = require('./server');
    const d2 = createDashboard({ memoryDir: mainRuns });
    await new Promise(r => d2.server.listen(0, '127.0.0.1', r));
    const b2 = `http://localhost:${d2.server.address().port}`;
    await fetch(`${b2}/api/archived-open/refresh`, { method: 'POST' });
    const runs = await (await fetch(`${b2}/api/runs`)).json();
    assert.ok(!runs.some(r => r.taskId === '94001-ciclo-novo'));
    await d2.close();
});

test('sem Redmine configurado nenhum arquivado entra', async () => {
    const saved = process.env.REDMINE_API_KEY;
    delete process.env.REDMINE_API_KEY;
    const { createDashboard } = require('./server');
    const d3 = createDashboard({ memoryDir: mainRuns });
    await new Promise(r => d3.server.listen(0, '127.0.0.1', r));
    const b3 = `http://localhost:${d3.server.address().port}`;
    await fetch(`${b3}/api/archived-open/refresh`, { method: 'POST' });
    const runs = await (await fetch(`${b3}/api/runs`)).json();
    assert.deepStrictEqual(runs.map(r => r.taskId), ['94003-ciclo-2']);
    await d3.close();
    process.env.REDMINE_API_KEY = saved;
});

// 13/11/2026: Redmine instável + restart = demandas abertas sumindo do dashboard.
test('Redmine sem resposta e sem status conhecido: entra marcado como desconhecido, nunca como aberto', async () => {
    seed(path.join(wt('94006'), '_archive'), '94006-sem-resposta', done('2026-09-20T00:00:00Z'));
    FAIL.add('94006');
    try {
        const runs = await withDashboard(async b => (await fetch(`${b}/api/runs`)).json());
        const r = runs.find(x => x.taskId === '94006-sem-resposta');
        assert.ok(r, 'arquivado com status desconhecido não pode sumir');
        assert.strictEqual(r.archived, true);
        assert.deepStrictEqual([r.demand.unknown, r.demand.status, r.demand.checked_at], [true, null, null]);
        // Fechado conhecido continua fora; desconhecido não vira "fechado" nem "aberto".
        assert.ok(!runs.some(x => x.taskId === '94002-fechado'));
    } finally { FAIL.delete('94006'); }
});

test('cache persistido: restart com Redmine falhando usa o último status conhecido', async () => {
    ISSUES[94006] = { status: { name: 'Ag Teste', is_closed: false } };
    // Redmine respondendo: grava o status em disco.
    await withDashboard(async () => {});
    const saved = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    assert.deepStrictEqual([saved['94006'].status, saved['94006'].closed], ['Ag Teste', false]);
    // Restart com TTL vencido e Redmine falhando em tudo: vale o que já se sabia.
    ageIssueCache();
    ['94001', '94002', '94005', '94006'].forEach(id => FAIL.add(id));
    try {
        const runs = await withDashboard(async b => (await fetch(`${b}/api/runs`)).json());
        const r = runs.find(x => x.taskId === '94006-sem-resposta');
        assert.ok(r);
        assert.deepStrictEqual([r.demand.status, !!r.demand.unknown], ['Ag Teste', false]);
        assert.ok(!runs.some(x => x.taskId === '94002-fechado'), 'fechado conhecido não volta como desconhecido');
        assert.ok(!runs.some(x => x.taskId === '94001-ciclo-novo'));
    } finally { FAIL.clear(); }
});

test('cache persistido ilegível é ignorado sem derrubar o dashboard', async () => {
    fs.writeFileSync(CACHE_FILE, '{ não é json');
    const runs = await withDashboard(async b => (await fetch(`${b}/api/runs`)).json());
    assert.ok(runs.some(x => x.taskId === '94006-sem-resposta'));
    assert.doesNotThrow(() => JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')), 'varredura regrava o cache válido');
});
