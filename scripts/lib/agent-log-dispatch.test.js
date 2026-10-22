// node --test scripts/lib/agent-log-dispatch.test.js
// Gap do /test da task 2026-09-26-log-agente-sse-dashboard: prova ponta-a-ponta (watcher
// real em processo filho, --follow, claude falso — molde session-limit-dispatch.test.js)
// que memory/runs/<ticketId>.log recebe linhas `<ISO> [claude] ...` com secret redigido,
// sem cortar a última linha (regressão do `drained`), e linhas `[watcher]` de início/fim de nó.
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
    const tmp = mkTmp('al-e2e-');
    const repo = path.join(tmp, 'app-back');
    const bin = path.join(tmp, 'bin');
    fs.mkdirSync(path.join(repo, 'memory', 'runs'), { recursive: true });
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'claude'), claudeScript, { mode: 0o755 });
    fs.writeFileSync(path.join(bin, 'osascript'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    return { tmp, repo, bin };
}

function startWatcher({ repo, bin, url, args, extraEnv = {}, preload = null }) {
    const env = {
        ...process.env, REPO_PATH: repo, REDMINE_URL: url, REDMINE_API_KEY: 'k',
        PATH: `${bin}:${process.env.PATH}`, SKIP_PRE_BUILD_VALIDATION: 'true',
        WATCHER_LOOP_STARTED_AT: new Date(Date.now() - 5000).toISOString(), WATCHER_TICK_INTERVAL_MS: '60000', ...extraEnv,
    };
    const child = spawn(process.execPath, [...(preload ? ['--require', preload] : []), WATCHER, ...args], { cwd: repo, env, stdio: ['ignore', 'pipe', 'pipe'] });
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

const FAKE_TOKEN = 'fake-bb-token-ZZ9Y8X7W6V5U4T3S';
const ISO = '\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z';

async function runScenario(id, claudeScript, { logFault = null, expectWrites = true } = {}) {
    const { tmp, repo, bin } = sandbox({ claudeScript });
    let preload = null;
    const probe = path.join(tmp, 'log-probe.json');
    if (logFault) {
        // IO/falhas somente no filho e no arquivo do ticket. A sonda prova que
        // a injeção engatou e que todo WriteStream foi fechado antes de sair.
        preload = path.join(tmp, 'log-fault.cjs');
        const logFile = path.join(repo, 'memory', 'runs', `${id}.log`);
        fs.writeFileSync(preload, `
const fs = require('node:fs');
const create = fs.createWriteStream;
const probe = { created: 0, closed: 0, delayedWrites: 0, injectedErrors: 0 };
const fault = ${JSON.stringify(logFault)};
const fail = callback => {
    probe.injectedErrors++;
    const error = Object.assign(new Error('ENOSPC: falha sintética PRI-217'), { code: 'ENOSPC' });
    process.nextTick(() => callback(error));
};
fs.createWriteStream = function(file, options) {
    if (file !== ${JSON.stringify(logFile)}) return create.call(this, file, options);
    probe.created++;
    const io = { open: fs.open, close: fs.close };
    if (fault === 'openError') io.open = (...args) => fail(args.at(-1));
    for (const method of ['write', 'writev']) io[method] = (...args) => {
        if (fault === 'writeError') return fail(args.at(-1));
        probe.delayedWrites++;
        setTimeout(() => fs[method](...args), 50);
    };
    const stream = create.call(this, file, { ...options, fs: io });
    stream.once('close', () => probe.closed++);
    return stream;
};
process.on('exit', () => fs.writeFileSync(${JSON.stringify(probe)}, JSON.stringify(probe)));
`);
    }
    const runs = path.join(repo, '.claude', 'worktrees', String(id), 'memory', 'runs');
    seedTask(runs, `${id}-teste`, { node: 'review', status: 'in_progress', history: ['fetch_ticket', 'plan', 'implement'] });
    const rm = await fakeRedmine({ issues: [ticket(id)] });
    try {
        const w = startWatcher({ repo, bin, url: rm.url, args: ['--follow', `--ticket=${id}`], preload, extraEnv: { BITBUCKET_API_TOKEN: FAKE_TOKEN } });
        const r = await w.exited;
        assert.strictEqual(r.code, 0, w.output());
        if (logFault) {
            const counts = readJson(probe);
            assert.ok(counts.created > 0, 'interceptação de createWriteStream aplicada');
            assert.strictEqual(counts.closed, counts.created, 'todos os streams de log fechados antes do watcher sair');
            if (logFault === 'delay') {
                if (expectWrites) assert.ok(counts.delayedWrites > 0, 'atraso de IO aplicado');
            } else assert.ok(counts.injectedErrors > 0, 'falha de IO injetada');
        }
        const logFile = path.join(repo, 'memory', 'runs', `${id}.log`);
        assert.ok(fs.existsSync(logFile), `log ${logFile} inexistente\n${w.output()}`);
        return { log: fs.readFileSync(logFile, 'utf8'), out: w.output() };
    } finally {
        rm.server.close();
    }
}

test('e2e: saída do agente vai pro <ticketId>.log com "<ISO> [claude]", secret redigido e última linha (sem \\n final) preservada', async () => {
    const { log, out } = await runScenario(891,
        `#!/bin/sh\necho "linha normal do agente"\necho "usando token ${FAKE_TOKEN} aqui"\nprintf "ultima linha sem newline"\n`);
    const claude = log.split('\n').filter(l => l.includes('[claude]'));
    assert.ok(claude.length >= 3, log);
    for (const l of claude) assert.match(l, new RegExp(`^${ISO} \\[claude\\] `));
    assert.ok(claude.some(l => l.endsWith('[claude] linha normal do agente')), log);
    assert.ok(claude.some(l => /\[claude\] usando token .*aqui$/.test(l)), 'linha com secret presente, porém redigida');
    assert.ok(!log.includes(FAKE_TOKEN), 'token vazou no log');
    assert.ok(!out.includes(FAKE_TOKEN), 'token vazou no terminal do watcher');
    assert.ok(claude.some(l => l.endsWith('[claude] ultima linha sem newline')), `última linha cortada (drained)\n${log}`);
});

test('e2e: dispatchTicket grava [watcher] "iniciando nó" antes e "nó ... finalizado" depois das linhas [claude]', async () => {
    const { log } = await runScenario(892, '#!/bin/sh\necho "trabalhando"\n', { logFault: 'delay' });
    const lines = log.split('\n').filter(Boolean);
    const iStart = lines.findIndex(l => new RegExp(`^${ISO} \\[watcher\\] iniciando nó review$`).test(l));
    const iAgent = lines.findIndex(l => l.includes('[claude] trabalhando'));
    const iEnd = lines.findIndex(l => new RegExp(`^${ISO} \\[watcher\\] nó review finalizado \\(code=0\\)$`).test(l));
    assert.ok(iStart >= 0 && iAgent >= 0 && iEnd >= 0, log);
    assert.ok(iStart < iAgent && iAgent < iEnd, `ordem inesperada\n${log}`);
});

for (const [id, logFault] of [[893, 'openError'], [894, 'writeError']]) {
    test(`e2e: falha de ${logFault} no log é registrada sem derrubar o watcher`, async () => {
        const { out } = await runScenario(id, '#!/bin/sh\necho "agente ainda executou"\n', { logFault });
        assert.match(out, /falha gravando log do agente: ENOSPC/);
        assert.match(out, /agente ainda executou/);
    });
}

test('e2e: falha no spawn fecha os streams de log antes de retornar ao dispatch', async () => {
    const { log } = await runScenario(895, '#!/pri-217-interprete-inexistente\n', { logFault: 'delay', expectWrites: false });
    assert.match(log, /iniciando nó review/);
    assert.match(log, /nó review finalizado/);
});
