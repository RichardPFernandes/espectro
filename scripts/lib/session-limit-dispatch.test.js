// node --test scripts/lib/session-limit-dispatch.test.js
// Gap identificado no /test da task 2026-09-26-resiliencia-sessao-limite:
// scripts/lib/session-limit.test.js só cobre looksLikeSessionLimit() isolada — não
// o trecho de dispatchTicket() que efetivamente grava status="session_limit" no
// state.json real quando o `claude` sai com erro batendo a assinatura, nem o branch
// que impede o watcher de redespachar sozinho depois disso. Como a detecção só
// funciona no modo --follow (stderrBuffer só existe nesse modo — ver spawnAgent),
// e FOLLOW é calculado uma vez a partir de process.argv no load do módulo, não dá
// pra exercitar isso com um require() em processo (ver node-lease.test.js, cujo
// processo de teste nunca tem --follow no argv). Segue o precedente ponta-a-ponta
// já usado em graceful-shutdown.test.js: sobe o watcher de verdade num processo
// filho (--follow), com um `claude` falso no PATH que sai com erro imprimindo uma
// das assinaturas em stderr, e um Redmine falso (HTTP local).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const TMP_ROOT = process.env.CLAUDE_JOB_DIR ? path.join(process.env.CLAUDE_JOB_DIR, 'tmp') : os.tmpdir();
const WATCHER = path.join(__dirname, '..', 'readmine-watcher.js');
const mkTmp = prefix => fs.mkdtempSync(path.join(TMP_ROOT, prefix));
const readJson = f => JSON.parse(fs.readFileSync(f, 'utf8'));

function seedTask(runsDir, taskId, state) {
    const dir = path.join(runsDir, taskId);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ task_id: taskId, history: [], started_at: new Date().toISOString(), ...state }, null, 2));
    return dir;
}

function fakeRedmine({ issues }) {
    const puts = [];
    const server = http.createServer((req, res) => {
        let body = '';
        req.on('data', c => { body += c; });
        req.on('end', () => {
            const reply = obj => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
            if (req.method === 'PUT') { puts.push({ url: req.url, body: JSON.parse(body || '{}') }); res.writeHead(204); return res.end(); }
            if (req.url.startsWith('/issues.json')) return reply({ issues });
            const m = req.url.match(/^\/issues\/(\d+)\.json/);
            if (m) return reply({ issue: { ...(issues.find(i => i.id === Number(m[1])) || { id: Number(m[1]) }), journals: [] } });
            reply({});
        });
    });
    return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({ server, puts, url: `http://127.0.0.1:${server.address().port}` })));
}

// `claude` falso: sai com erro imprimindo uma assinatura de SESSION_LIMIT_SIGNATURES
// em STDERR (não stdout) — só stderr é checado por looksLikeSessionLimit.
function sandbox({ claudeScript }) {
    const tmp = mkTmp('sl-e2e-');
    const repo = path.join(tmp, 'app-back');
    const bin = path.join(tmp, 'bin');
    fs.mkdirSync(path.join(repo, 'memory', 'runs'), { recursive: true });
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'claude'), claudeScript, { mode: 0o755 });
    fs.writeFileSync(path.join(bin, 'osascript'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    return { tmp, repo, bin };
}

function startWatcher({ repo, bin, url, args }) {
    const env = {
        ...process.env, REPO_PATH: repo, REDMINE_URL: url, REDMINE_API_KEY: 'k',
        PATH: `${bin}:${process.env.PATH}`, SKIP_PRE_BUILD_VALIDATION: 'true',
        WATCHER_LOOP_STARTED_AT: new Date(Date.now() - 5000).toISOString(), WATCHER_TICK_INTERVAL_MS: '60000',
    };
    const child = spawn(process.execPath, [WATCHER, ...args], { cwd: repo, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { out += d; });
    const exited = new Promise(resolve => child.on('exit', (code, signal) => resolve({ code, signal })));
    return { child, exited, output: () => out };
}

function ticket(id) {
    return {
        id, subject: `Ticket ${id}`, status: { name: 'Em Desenvolvimento' }, tracker: { name: 'Melhoria' },
        custom_fields: [{ name: 'Branch Liberação', value: 'Dev - Local' }],
    };
}

test('e2e: claude sai com erro batendo assinatura de estouro de contexto (stderr) → state.json real vira status="session_limit"/session_interrupted:true/interrupted_node/interrupted_at, e o watcher não redespacha sozinho no tick seguinte', async () => {
    const { repo, bin } = sandbox({
        claudeScript: '#!/bin/sh\necho "trabalhando..."\necho "API error: prompt exceeds context window" 1>&2\nexit 1\n',
    });
    const runs = path.join(repo, '.claude', 'worktrees', '881', 'memory', 'runs');
    const dir = seedTask(runs, '881-teste', { node: 'review', status: 'in_progress', history: ['fetch_ticket', 'plan', 'implement'] });
    const rm = await fakeRedmine({ issues: [ticket(881)] });
    try {
        const before = Date.now();
        const w = startWatcher({ repo, bin, url: rm.url, args: ['--follow', '--ticket=881'] });
        const r1 = await w.exited;
        assert.strictEqual(r1.code, 0, w.output());

        const st = readJson(path.join(dir, 'state.json'));
        assert.strictEqual(st.status, 'session_limit');
        assert.strictEqual(st.session_interrupted, true);
        assert.strictEqual(st.interrupted_node, 'review', 'usa state.node vigente no momento do crash, não um node_started novo');
        assert.ok(Number.isFinite(Date.parse(st.interrupted_at)), 'interrupted_at é data ISO válida');
        assert.ok(Date.parse(st.interrupted_at) >= before, 'interrupted_at gravado agora, não reaproveitado de outro campo');
        assert.match(w.output(), /interrompida por estouro de contexto\/tokens/);

        // Tick seguinte: o watcher não pode redespachar sozinho um run em session_limit
        // (retomada é ação humana via dashboard — POST /resume-session).
        const w2 = startWatcher({ repo, bin, url: rm.url, args: ['--ticket=881'] });
        const r2 = await w2.exited;
        assert.strictEqual(r2.code, 0, w2.output());
        assert.match(w2.output(), /status_session_limit/);
        assert.deepStrictEqual(readJson(path.join(dir, 'state.json')), st, 'state.json não muda no tick que só confirma o skip');
    } finally {
        rm.server.close();
    }
});

test('e2e: claude sai com erro que NÃO bate nenhuma assinatura de estouro → cai no caminho de "indisponível" existente, sem marcar session_limit', async () => {
    const { repo, bin } = sandbox({
        claudeScript: '#!/bin/sh\necho "boom: null pointer" 1>&2\nexit 1\n',
    });
    const runs = path.join(repo, '.claude', 'worktrees', '882', 'memory', 'runs');
    const dir = seedTask(runs, '882-teste', { node: 'review', status: 'in_progress', history: ['fetch_ticket', 'plan', 'implement'] });
    const rm = await fakeRedmine({ issues: [ticket(882)] });
    try {
        const w = startWatcher({ repo, bin, url: rm.url, args: ['--follow', '--ticket=882'] });
        const r = await w.exited;
        assert.strictEqual(r.code, 0, w.output());
        const st = readJson(path.join(dir, 'state.json'));
        assert.strictEqual(st.status, 'in_progress', 'sem assinatura de estouro, status não muda pra session_limit');
        assert.strictEqual(st.session_interrupted, undefined);
    } finally {
        rm.server.close();
    }
});

test.after(() => {});
