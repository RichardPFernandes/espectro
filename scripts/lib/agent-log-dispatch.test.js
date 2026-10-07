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

function startWatcher({ repo, bin, url, args, extraEnv = {} }) {
    const env = {
        ...process.env, REPO_PATH: repo, REDMINE_URL: url, REDMINE_API_KEY: 'k',
        PATH: `${bin}:${process.env.PATH}`, SKIP_PRE_BUILD_VALIDATION: 'true',
        WATCHER_LOOP_STARTED_AT: new Date(Date.now() - 5000).toISOString(), WATCHER_TICK_INTERVAL_MS: '60000', ...extraEnv,
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

const FAKE_TOKEN = 'fake-bb-token-ZZ9Y8X7W6V5U4T3S';
const ISO = '\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z';

async function runScenario(id, claudeScript) {
    const { repo, bin } = sandbox({ claudeScript });
    const runs = path.join(repo, '.claude', 'worktrees', String(id), 'memory', 'runs');
    seedTask(runs, `${id}-teste`, { node: 'review', status: 'in_progress', history: ['fetch_ticket', 'plan', 'implement'] });
    const rm = await fakeRedmine({ issues: [ticket(id)] });
    try {
        const w = startWatcher({ repo, bin, url: rm.url, args: ['--follow', `--ticket=${id}`], extraEnv: { BITBUCKET_API_TOKEN: FAKE_TOKEN } });
        const r = await w.exited;
        assert.strictEqual(r.code, 0, w.output());
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
    const { log } = await runScenario(892, '#!/bin/sh\necho "trabalhando"\n');
    const lines = log.split('\n').filter(Boolean);
    const iStart = lines.findIndex(l => new RegExp(`^${ISO} \\[watcher\\] iniciando nó review$`).test(l));
    const iAgent = lines.findIndex(l => l.includes('[claude] trabalhando'));
    const iEnd = lines.findIndex(l => new RegExp(`^${ISO} \\[watcher\\] nó review finalizado \\(code=0\\)$`).test(l));
    assert.ok(iStart >= 0 && iAgent >= 0 && iEnd >= 0, log);
    assert.ok(iStart < iAgent && iAgent < iEnd, `ordem inesperada\n${log}`);
});
