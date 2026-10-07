// node --test scripts/lib/ticket-filter-tick.test.js
// --ticket=<id> isola o tick inteiro, inclusive o que roda antes do filtro de despacho:
// fechamento de custo pendente (state.json, *-cost.json, transcripts/), registro de ACs,
// knowledge graph e consolidador de memória. Ponta a ponta, como session-limit-dispatch:
// ONLY_TICKET sai de process.argv no load do módulo, então cada cenário é um processo.
// Dois tickets com um run de custo `pending` do /commit (pid morto) apontando para a
// task arquivada do worktree; o Redmine falso não devolve ticket nenhum, então nada é
// despachado e todo efeito vem do início/fim do tick.
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn, spawnSync } = require('child_process');

const TMP_ROOT = process.env.CLAUDE_JOB_DIR ? path.join(process.env.CLAUDE_JOB_DIR, 'tmp') : os.tmpdir();
const WATCHER = path.join(__dirname, '..', 'readmine-watcher.js');
const readJson = f => JSON.parse(fs.readFileSync(f, 'utf8'));
const A = 90101;
const B = 90202;

function deadPid() {
    return spawnSync(process.execPath, ['-e', '']).pid;
}

function seedTicket(repo, ticketId) {
    const wt = path.join(repo, '.claude', 'worktrees', String(ticketId));
    const taskDir = path.join(wt, 'memory', 'runs', '_archive', `${ticketId}-teste`);
    fs.mkdirSync(taskDir, { recursive: true });
    const now = new Date().toISOString();
    fs.writeFileSync(path.join(taskDir, 'state.json'), JSON.stringify({
        task_id: `${ticketId}-teste`, node: 'commit', status: 'committed',
        history: ['fetch_ticket', 'plan', 'implement', 'review', 'test', 'verify', 'commit'],
        started_at: now, updated_at: now,
    }, null, 2));
    fs.mkdirSync(path.join(wt, 'memory', 'spec'), { recursive: true });
    fs.writeFileSync(path.join(wt, 'memory', 'spec', `${ticketId}-spec.md`),
        `# Spec ${ticketId}\n\n## Critérios de Aceite\n\n- AC-01: o ticket ${ticketId} faz o que deve.\n`);
    fs.writeFileSync(path.join(repo, 'memory', 'runs', `${ticketId}-cost.json`), JSON.stringify({
        ticket_id: ticketId,
        pending: [{ session_id: crypto.randomUUID(), agent: 'claude', nodes: ['commit'], started_at_ms: Date.now() - 60000, pid: deadPid() }],
        tasks: {}, unattributed: [],
    }, null, 2));
    return taskDir;
}

function sandbox() {
    const tmp = fs.mkdtempSync(path.join(TMP_ROOT, 'ticket-filter-'));
    const repo = path.join(tmp, 'app-back');
    const bin = path.join(tmp, 'bin');
    fs.mkdirSync(path.join(repo, 'memory', 'runs'), { recursive: true });
    fs.mkdirSync(path.join(tmp, 'home'));
    fs.mkdirSync(bin);
    fs.mkdirSync(path.join(repo, '.claude'));
    fs.copyFileSync(path.join(__dirname, '..', '..', '.claude', 'spec-hash-config.json'), path.join(repo, '.claude', 'spec-hash-config.json'));
    fs.writeFileSync(path.join(bin, 'osascript'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    // 10 runs terminais: o bastante para o consolidador (threshold 10) gravar algo.
    for (let i = 1; i <= 10; i++) {
        const dir = path.join(repo, 'memory', 'runs', `run-${i}`);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ task_id: `run-${i}`, node: 'commit', status: 'committed', history: [] }));
    }
    return { tmp, repo, bin, dirA: seedTicket(repo, A), dirB: seedTicket(repo, B) };
}

function fakeRedmine() {
    const server = http.createServer((req, res) => {
        req.resume();
        req.on('end', () => {
            if (req.method === 'PUT') { res.writeHead(204); return res.end(); }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(req.url.startsWith('/issues.json') ? { issues: [] } : {}));
        });
    });
    return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({ server, url: `http://127.0.0.1:${server.address().port}` })));
}

async function runTick({ tmp, repo, bin }, args) {
    const rm = await fakeRedmine();
    try {
        const env = {
            ...process.env, REPO_PATH: repo, REDMINE_URL: rm.url, REDMINE_API_KEY: 'k', HOME: path.join(tmp, 'home'),
            PATH: `${bin}:${process.env.PATH}`, SKIP_PRE_BUILD_VALIDATION: 'true',
            WATCHER_LOOP_STARTED_AT: new Date(Date.now() - 5000).toISOString(), WATCHER_TICK_INTERVAL_MS: '60000',
        };
        for (const k of ['CLAUDE_CONFIG_DIR', 'DRY_RUN', 'TRANSCRIPTS_DISABLED', 'KNOWLEDGE_GRAPH_PATH', 'CONSOLIDATOR_STATE_PATH', 'CONSOLIDATOR_PATTERNS_PATH']) delete env[k];
        const child = spawn(process.execPath, [WATCHER, ...args], { cwd: repo, env, stdio: ['ignore', 'pipe', 'pipe'] });
        let out = '';
        child.stdout.on('data', d => { out += d; });
        child.stderr.on('data', d => { out += d; });
        const code = await new Promise(resolve => child.on('exit', resolve));
        assert.strictEqual(code, 0, out);
        return out;
    } finally {
        rm.server.close();
    }
}

// Hash de tudo que é do ticket: worktree inteiro (state.json, transcripts/, spec),
// ledger de custo e log do ticket no checkout principal.
function ticketFootprint(repo, ticketId) {
    const files = [];
    const walk = d => {
        if (!fs.existsSync(d)) return;
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
            const p = path.join(d, e.name);
            if (e.isDirectory()) walk(p); else files.push(p);
        }
    };
    walk(path.join(repo, '.claude', 'worktrees', String(ticketId)));
    for (const f of [`${ticketId}-cost.json`, `${ticketId}.log`]) files.push(path.join(repo, 'memory', 'runs', f));
    const h = crypto.createHash('sha256');
    for (const f of files.sort()) {
        h.update(path.relative(repo, f));
        h.update(fs.existsSync(f) ? fs.readFileSync(f) : '<ausente>');
    }
    return h.digest('hex');
}

const costClosed = (repo, dir, ticketId) => {
    assert.deepStrictEqual(readJson(path.join(repo, 'memory', 'runs', `${ticketId}-cost.json`)).pending, [], `#${ticketId}: pending fechado`);
    const st = readJson(path.join(dir, 'state.json'));
    assert.ok(st.cost_tracking?.nodes?.commit, `#${ticketId}: cost_tracking gravado`);
    assert.ok(fs.readdirSync(path.join(dir, 'transcripts')).some(f => /^commit-\d+\.json$/.test(f)), `#${ticketId}: transcript gravado`);
};

test(`--ticket=${A}: só o custo pendente do filtro fecha; o outro ticket fica byte a byte igual`, async () => {
    const sb = sandbox();
    const before = ticketFootprint(sb.repo, B);
    const out = await runTick(sb, [`--ticket=${A}`]);

    costClosed(sb.repo, sb.dirA, A);
    assert.strictEqual(ticketFootprint(sb.repo, B), before, `#${B} não pode mudar com --ticket=${A}\n${out}`);
    assert.strictEqual(readJson(path.join(sb.repo, 'memory', 'runs', `${B}-cost.json`)).pending.length, 1);
    assert.ok(!fs.existsSync(path.join(sb.dirB, 'transcripts')));

    const registry = JSON.stringify(readJson(path.join(sb.repo, '.graph', 'ac-registry.json')));
    assert.ok(registry.includes(String(A)), 'registro de ACs indexa o ticket do filtro');
    assert.ok(!registry.includes(String(B)), 'registro de ACs não indexa outro ticket');
    const kgPath = path.join(sb.repo, 'memory', 'knowledge-graph.json');
    const kg = fs.readFileSync(kgPath, 'utf8');
    assert.ok(kg.includes(String(A)) && !kg.includes(String(B)), 'knowledge graph só com o ticket do filtro');

    assert.ok(!fs.existsSync(path.join(sb.repo, 'memory', 'consolidator-state.json')), 'consolidador não roda com --ticket');
    assert.ok(!fs.existsSync(path.join(sb.repo, 'memory', 'patterns.md')));
    fs.rmSync(sb.tmp, { recursive: true, force: true });
});

test('sem --ticket (e sem --follow): todo custo pendente fecha e o consolidador roda', async () => {
    const sb = sandbox();
    await runTick(sb, []);

    costClosed(sb.repo, sb.dirA, A);
    costClosed(sb.repo, sb.dirB, B);
    const registry = JSON.stringify(readJson(path.join(sb.repo, '.graph', 'ac-registry.json')));
    assert.ok(registry.includes(String(A)) && registry.includes(String(B)));
    assert.ok(fs.existsSync(path.join(sb.repo, 'memory', 'consolidator-state.json')));
    assert.ok(fs.existsSync(path.join(sb.repo, 'memory', 'patterns.md')));
    fs.rmSync(sb.tmp, { recursive: true, force: true });
});
