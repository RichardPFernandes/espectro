// node --test scripts/watcher-manager.test.js
// Watcher falso (scripts sintéticos em tmp) no lugar do readmine-watcher.js real —
// nada aqui fala com Redmine nem despacha agente.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { createWatcherManager, MAX_AUTO_RESTARTS, LOG_LINES } = require('./watcher-manager');

const tmpBase = process.env.CLAUDE_JOB_DIR ? path.join(process.env.CLAUDE_JOB_DIR, 'tmp') : os.tmpdir();
const tmp = fs.mkdtempSync(path.join(tmpBase, 'watcher-manager-'));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

let n = 0;
function fake(name, body) {
    const file = path.join(tmp, `${name}-${++n}.js`);
    fs.writeFileSync(file, body);
    return file;
}
function manager(script, extra = {}) {
    return createWatcherManager({
        script, cwd: tmp, pidFile: path.join(tmp, `pid-${++n}`), historyFile: path.join(tmp, `hist-${n}.json`),
        envFile: null, intervalMs: 100, restartDelayMs: 50, stopGraceMs: 400, ...extra,
    });
}
async function until(fn, ms = 4000) {
    for (const end = Date.now() + ms; ;) {
        if (fn()) return;
        if (Date.now() > end) throw new Error('timeout esperando condição');
        await new Promise(r => setTimeout(r, 20));
    }
}
const texts = m => m.getLogBuffer().map(e => e.text);

test('tick limpo vira laço: loga stdout/stderr, agenda o próximo, stop encerra', async () => {
    const m = manager(fake('ok', `console.log('Polling Redmine...'); console.error('Falha comentando'); console.warn('aviso qualquer');`));
    const st = await m.start();
    assert.strictEqual(st.running, true);
    assert.ok(st.pid > 0);
    await until(() => m.status().ticks >= 2);
    const buf = m.getLogBuffer();
    const info = buf.find(e => e.text === 'Polling Redmine...');
    assert.strictEqual(info.level, 'INFO');
    assert.strictEqual(buf.find(e => e.text === 'Falha comentando').level, 'ERROR');
    assert.strictEqual(buf.find(e => e.text === 'aviso qualquer').level, 'WARN');
    assert.strictEqual(m.status().restarts, 0, 'saída 0 não é crash');
    const stopped = await m.stop();
    assert.strictEqual(stopped.running, false);
    assert.strictEqual(stopped.pid, null);
    assert.strictEqual(stopped.uptime_ms, null);
    const ticks = m.status().ticks;
    await new Promise(r => setTimeout(r, 250));
    assert.strictEqual(m.status().ticks, ticks, 'nada dispara depois do stop');
});

test('crash reinicia sozinho até o limite por hora e depois para com restart_limit_reached', async () => {
    const m = manager(fake('crash', `console.log('subi'); process.exit(2);`));
    await m.start();
    await until(() => m.status().error === 'restart_limit_reached');
    const st = m.status();
    assert.strictEqual(st.running, false);
    assert.strictEqual(st.restarts, MAX_AUTO_RESTARTS);
    assert.strictEqual(st.ticks, MAX_AUTO_RESTARTS + 1, 'um tick original + 3 reinícios');
    const log = texts(m).join('\n');
    for (let i = 1; i <= MAX_AUTO_RESTARTS; i++) assert.match(log, new RegExp(`reiniciando automaticamente.*tentativa ${i}/${MAX_AUTO_RESTARTS}`));
    assert.match(log, /limite de 3 reinícios automáticos/);
    await new Promise(r => setTimeout(r, 200));
    assert.strictEqual(m.status().ticks, MAX_AUTO_RESTARTS + 1, 'não reinicia mais');
    assert.strictEqual(st.last_run.reason, 'restart_limit');
    // Start manual limpa o erro e zera a contagem.
    const again = await m.start();
    assert.strictEqual(again.error, null);
    assert.strictEqual(again.restarts, 0);
    await m.stop();
});

test('morte por sinal também é crash', async () => {
    const m = manager(fake('sig', `setTimeout(() => process.kill(process.pid, 'SIGKILL'), 50);`), { restartDelayMs: 5000 });
    await m.start();
    await until(() => m.status().state === 'restarting');
    assert.match(texts(m).join('\n'), /sinal SIGKILL.*tentativa 1\/3/);
    await m.stop();
    assert.strictEqual(m.status().state, 'stopped');
});

test('stop: SIGTERM ignorado vira SIGKILL depois da carência', async () => {
    const m = manager(fake('stubborn', `process.on('SIGTERM', () => console.log('ignorando SIGTERM')); console.log('pronto'); setInterval(() => {}, 1000);`));
    await m.start();
    await until(() => texts(m).includes('pronto'));
    const pid = m.status().pid;
    const t0 = Date.now();
    await m.stop();
    const took = Date.now() - t0;
    assert.ok(took >= 350 && took < 2000, `levou ${took}ms`);
    assert.throws(() => process.kill(pid, 0));
    assert.match(texts(m).join('\n'), /enviando SIGKILL/);
});

test('secrets do env e do .env viram [REDACTED]; filho herda o env', async () => {
    const envFile = path.join(tmp, 'dot-env');
    fs.writeFileSync(envFile, 'OUTRO_SECRET=segredo-so-no-dotenv\n');
    process.env.BITBUCKET_API_TOKEN = 'bb-token-muito-secreto';
    process.env.REDMINE_API_KEY = 'redmine-key-1234567';
    process.env.WM_TEST_VAR = 'herdado';
    try {
        const m = manager(fake('leak', `
            console.log('token=' + process.env.BITBUCKET_API_TOKEN + ' key ' + process.env.REDMINE_API_KEY);
            console.log('var ' + process.env.WM_TEST_VAR);
            console.log('dotenv segredo-so-no-dotenv');
            console.log('FOO_TOKEN=abc123 e Authorization: Bearer xyz789');
        `), { envFile });
        await m.start();
        await until(() => texts(m).some(t => t.startsWith('FOO_TOKEN')));
        await m.stop();
        const all = JSON.stringify(m.getLogBuffer());
        for (const secret of ['bb-token-muito-secreto', 'redmine-key-1234567', 'segredo-so-no-dotenv', 'abc123', 'xyz789']) {
            assert.ok(!all.includes(secret), `vazou ${secret}`);
        }
        assert.ok(texts(m).includes('token=[REDACTED] key [REDACTED]'));
        assert.ok(texts(m).includes('var herdado'));
    } finally {
        delete process.env.BITBUCKET_API_TOKEN; delete process.env.REDMINE_API_KEY; delete process.env.WM_TEST_VAR;
    }
});

test('ringbuffer guarda só as últimas 200 linhas e emite cada linha nova', async () => {
    const m = manager(fake('many', `for (let i = 1; i <= 450; i++) console.log('linha ' + i);`));
    const seen = [];
    const off = m.onLine(e => seen.push(e.text));
    await m.start();
    await until(() => seen.includes('linha 450'));
    await m.stop();
    off();
    const buf = m.getLogBuffer();
    assert.strictEqual(buf.length, LOG_LINES);
    assert.strictEqual(buf[buf.length - 1].text.startsWith('watcher parado'), true);
    assert.ok(!texts(m).includes('linha 1'));
    assert.ok(buf.every((e, i) => i === 0 || e.seq > buf[i - 1].seq));
});

test('PID gravado durante o tick, removido depois; órfão detectado e encerrado no start', async () => {
    const pidFile = path.join(tmp, 'orphan.pid');
    const script = fake('slow', `console.log('tick'); setTimeout(() => {}, 60000);`);
    const m = manager(script, { pidFile });
    await m.start();
    await until(() => fs.existsSync(pidFile));
    assert.strictEqual(Number(fs.readFileSync(pidFile, 'utf8')), m.status().pid);
    await m.stop();
    assert.ok(!fs.existsSync(pidFile));

    // Simula dashboard que morreu com o watcher no meio de um tick.
    const orphan = spawn(process.execPath, [script], { stdio: 'ignore' });
    fs.writeFileSync(pidFile, `${orphan.pid}\n`);
    const m2 = manager(script, { pidFile });
    assert.strictEqual(m2.status().orphan_pid, orphan.pid);
    const exited = new Promise(r => orphan.once('exit', r));
    await m2.start();
    await exited;
    assert.strictEqual(m2.status().orphan_pid, null);
    assert.notStrictEqual(m2.status().pid, orphan.pid);
    await m2.stop();

    // PID de processo que não é o watcher: ignora e limpa o arquivo.
    fs.writeFileSync(pidFile, `${process.pid}\n`);
    const m3 = manager(script, { pidFile });
    assert.strictEqual(m3.status().orphan_pid, null);
    assert.ok(!fs.existsSync(pidFile));
});

test('histórico: última execução com uptime e hora da parada', async () => {
    const m = manager(fake('hist', `console.log('x');`));
    await m.start();
    await new Promise(r => setTimeout(r, 150));
    await m.stop();
    const last = m.status().last_run;
    assert.strictEqual(last.reason, 'stop');
    assert.ok(last.uptime_ms >= 100);
    assert.ok(Date.parse(last.ended_at) >= Date.parse(last.started_at));
});

test('PRI-180 A4: o tick do watcher não herda config/segredo de banco nem aprovadores', async () => {
    const m = manager(fake('env', `console.log('ENV ' + Object.keys(process.env).filter(k => /^PRISMA_(DB_|APPROVERS|PSQL)/.test(k)).join(','));`),
        { env: { PRISMA_DB_QA_APP_PASSWORD: 'nao-vaza', PRISMA_APPROVERS: '{}', PRISMA_PSQL_BIN: '/x' } });
    await m.start();
    await until(() => texts(m).some(t => t.startsWith('ENV ')));
    await m.stop();
    assert.strictEqual(texts(m).find(t => t.startsWith('ENV ')), 'ENV ');
});

// ------------------------------------------------------------ guard do checkout (F1.2, PRI-379)
// Repositório temporário com origem bare local; config global e de sistema do git fora,
// autor fixo. O git é injetado contando chamadas; nada toca o checkout do Prisma.
const { runGit } = require('./lib/return-point');
const GUARD_GIT_ENV = {
    ...process.env,
    GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Teste', GIT_AUTHOR_EMAIL: 'teste@example.invalid', GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z',
    GIT_COMMITTER_NAME: 'Teste', GIT_COMMITTER_EMAIL: 'teste@example.invalid', GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z',
};
function guardSh(cwd, ...args) {
    const r = require('child_process').spawnSync('git', args, { cwd, env: GUARD_GIT_ENV, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
}
function guardRepo() {
    const base = fs.mkdtempSync(path.join(tmp, 'guard-'));
    const origin = path.join(base, 'origin.git');
    const root = path.join(base, 'work');
    guardSh(base, 'init', '--quiet', '--bare', '--initial-branch=main', origin);
    guardSh(base, 'init', '--quiet', '--initial-branch=main', root);
    fs.writeFileSync(path.join(root, 'a.txt'), 'um\n');
    guardSh(root, 'add', 'a.txt');
    guardSh(root, 'commit', '--quiet', '-m', 'um');
    guardSh(root, 'remote', 'add', 'origin', origin);
    guardSh(root, 'push', '--quiet', 'origin', 'main');
    guardSh(root, 'fetch', '--quiet', 'origin');
    return root;
}
function countingGit() {
    const g = (args, opts) => { g.calls++; return runGit(args, { ...opts, env: GUARD_GIT_ENV }); };
    g.calls = 0;
    return g;
}

test('guard: flag ausente não chama git e o tick segue igual ao de hoje', async () => {
    const root = guardRepo();
    fs.writeFileSync(path.join(root, 'solto.txt'), 'sujo\n');
    const git = countingGit();
    // env explícita: o teste não depende da flag exportada no shell.
    const m = manager(fake('guard-off', `console.log('tick ok');`), { prismaRoot: root, git, env: { PRISMA_CHECKOUT_GUARD: '' } });
    await m.start();
    await until(() => m.status().ticks >= 2);
    await m.stop();
    assert.strictEqual(git.calls, 0);
    assert.strictEqual(m.status().error, null);
    assert.strictEqual(m.status().guard, null);
    assert.ok(texts(m).includes('tick ok'));
});

test('guard: flag ligada e árvore suja não inicia o tick, para o laço e expõe o motivo', async () => {
    const root = guardRepo();
    fs.writeFileSync(path.join(root, 'solto.txt'), 'sujo\n');
    const marker = path.join(tmp, `guard-spawn-${++n}`);
    const git = countingGit();
    const m = manager(fake('guard-dirty', `require('fs').writeFileSync(${JSON.stringify(marker)}, 'x');`),
        { prismaRoot: root, git, env: { PRISMA_CHECKOUT_GUARD: '1' } });
    const st = await m.start();
    await new Promise(r => setTimeout(r, 250));
    assert.ok(git.calls > 0);
    assert.ok(!fs.existsSync(marker), 'nenhum spawn');
    for (const s of [st, m.status()]) {
        assert.strictEqual(s.error, 'checkout_guard');
        assert.ok(s.guard.reasons.includes('dirty'));
        assert.deepStrictEqual(s.guard.paths, ['solto.txt']);
        assert.strictEqual(s.running, false);
        assert.strictEqual(s.state, 'stopped');
        assert.strictEqual(s.next_tick_at, null);
        assert.strictEqual(s.ticks, 0);
    }
    assert.match(texts(m).join('\n'), /dirty[\s\S]*solto\.txt/);

    // Árvore limpa: start seguinte limpa error/guard e o tick roda.
    fs.rmSync(path.join(root, 'solto.txt'));
    const again = await m.start();
    assert.strictEqual(again.error, null);
    assert.strictEqual(again.guard, null);
    await until(() => fs.existsSync(marker));
    await m.stop();
});

test('guard: flag ligada e árvore ok faz o tick normal; sujeira depois para no tick seguinte', async () => {
    const root = guardRepo();
    const git = countingGit();
    const m = manager(fake('guard-ok', `console.log('tick ok');`), { prismaRoot: root, git, env: { PRISMA_CHECKOUT_GUARD: '1' } });
    await m.start();
    await until(() => m.status().ticks >= 2);
    assert.ok(git.calls > 0);
    assert.strictEqual(m.status().error, null);
    assert.strictEqual(m.status().running, true);
    fs.writeFileSync(path.join(root, 'b.txt'), 'novo\n');
    await until(() => m.status().state === 'stopped');
    const st = m.status();
    assert.strictEqual(st.error, 'checkout_guard');
    assert.deepStrictEqual(st.guard.paths, ['b.txt']);
    const ticks = st.ticks;
    await new Promise(r => setTimeout(r, 250));
    assert.strictEqual(m.status().ticks, ticks, 'laço parado, sem timer novo');
    await m.stop();
});

// checkoutGuard: a conferência de subida que o dashboard usa (sem importar scripts/lib/).
const { checkoutGuard } = require('./watcher-manager');

test('checkoutGuard: flag ausente devolve null sem chamar git', () => {
    const root = guardRepo();
    fs.writeFileSync(path.join(root, 'solto.txt'), 'sujo\n');
    const git = countingGit();
    assert.strictEqual(checkoutGuard({ root, env: {}, git }), null);
    assert.strictEqual(git.calls, 0);
});

test('checkoutGuard: flag ligada e árvore suja devolve motivos e caminhos', () => {
    const root = guardRepo();
    fs.writeFileSync(path.join(root, 'solto.txt'), 'sujo\n');
    const git = countingGit();
    const r = checkoutGuard({ root, env: { PRISMA_CHECKOUT_GUARD: '1' }, git });
    assert.ok(r.reasons.includes('dirty'));
    assert.deepStrictEqual(r.paths, ['solto.txt']);
    assert.ok(git.calls > 0);
});

test('checkoutGuard: flag ligada e árvore ok devolve null', () => {
    const root = guardRepo();
    const git = countingGit();
    assert.strictEqual(checkoutGuard({ root, env: { PRISMA_CHECKOUT_GUARD: 'sim' }, git }), null);
    assert.ok(git.calls > 0);
});

// ------------------------------------------------------------ guard: segunda leva da G3 (PRI-379)
const { bootGuardRoots } = require('./watcher-manager');
const { GUARD_GIT_TIMEOUT_MS } = require('./lib/return-point');
function recordingGit() {
    const g = (args, opts = {}) => { g.seen.push({ args, timeout: opts.timeout }); return runGit(args, { ...opts, env: GUARD_GIT_ENV }); };
    g.seen = [];
    return g;
}

test('bootGuardRoots: sem PRISMA_ROOT confere só a raiz do código', () => {
    const codeRoot = fs.mkdtempSync(path.join(tmp, 'code-'));
    assert.deepStrictEqual(bootGuardRoots({ codeRoot, env: {} }), [codeRoot]);
    assert.deepStrictEqual(bootGuardRoots({ codeRoot, env: { PRISMA_ROOT: '' } }), [codeRoot]);
});

test('bootGuardRoots: PRISMA_ROOT igual à raiz do código (realpath ou symlink) confere uma raiz', () => {
    const codeRoot = fs.mkdtempSync(path.join(tmp, 'code-'));
    const link = path.join(tmp, `code-link-${++n}`);
    fs.symlinkSync(codeRoot, link);
    assert.deepStrictEqual(bootGuardRoots({ codeRoot, env: { PRISMA_ROOT: fs.realpathSync(codeRoot) } }), [codeRoot]);
    assert.deepStrictEqual(bootGuardRoots({ codeRoot, env: { PRISMA_ROOT: `${codeRoot}/` } }), [codeRoot]);
    assert.deepStrictEqual(bootGuardRoots({ codeRoot, env: { PRISMA_ROOT: link } }), [codeRoot]);
});

test('bootGuardRoots: PRISMA_ROOT diferente confere as duas, a do código primeiro', () => {
    const codeRoot = fs.mkdtempSync(path.join(tmp, 'code-'));
    const other = fs.mkdtempSync(path.join(tmp, 'other-'));
    assert.deepStrictEqual(bootGuardRoots({ codeRoot, env: { PRISMA_ROOT: other } }), [codeRoot, other]);
});

test('checkoutGuard com roots: só a raiz recusada aparece, com os caminhos dela', () => {
    const clean = guardRepo();
    const dirty = guardRepo();
    fs.writeFileSync(path.join(dirty, 'solto.txt'), 'sujo\n');
    const r = checkoutGuard({ roots: [clean, dirty], env: { PRISMA_CHECKOUT_GUARD: '1' }, git: countingGit() });
    assert.deepStrictEqual(r.reasons, ['dirty']);
    assert.deepStrictEqual(r.paths, ['solto.txt']);
    assert.deepStrictEqual(r.byRoot, [{ root: dirty, reasons: ['dirty'], paths: ['solto.txt'] }]);
});

test('checkoutGuard com roots: motivos sem repetição e até 10 caminhos no total', () => {
    const a = guardRepo();
    const b = guardRepo();
    guardSh(b, 'switch', '--quiet', '-c', 'fora');
    fs.writeFileSync(path.join(b, 'c.txt'), 'fora\n');
    guardSh(b, 'add', 'c.txt');
    guardSh(b, 'commit', '--quiet', '-m', 'fora');
    for (let i = 0; i < 7; i++) {
        fs.writeFileSync(path.join(a, `a${i}.txt`), 'x\n');
        fs.writeFileSync(path.join(b, `b${i}.txt`), 'x\n');
    }
    const r = checkoutGuard({ roots: [a, b], env: { PRISMA_CHECKOUT_GUARD: '1' }, git: countingGit() });
    assert.deepStrictEqual(r.reasons, ['dirty', 'off_main']);
    assert.strictEqual(r.paths.length, 10);
    assert.deepStrictEqual(r.byRoot.map(x => [x.root, x.reasons, x.paths.length]), [[a, ['dirty'], 7], [b, ['dirty', 'off_main'], 3]]);
    assert.deepStrictEqual(r.paths, [...r.byRoot[0].paths, ...r.byRoot[1].paths]);
});

test('checkoutGuard: cada git do guard recebe o prazo GUARD_GIT_TIMEOUT_MS', () => {
    const root = guardRepo();
    const git = recordingGit();
    assert.strictEqual(checkoutGuard({ root, env: { PRISMA_CHECKOUT_GUARD: '1' }, git }), null);
    assert.ok(git.seen.length > 0);
    assert.deepStrictEqual([...new Set(git.seen.map(c => c.timeout))], [GUARD_GIT_TIMEOUT_MS]);
});

test('guard do tick: cada git recebe o prazo GUARD_GIT_TIMEOUT_MS', async () => {
    const root = guardRepo();
    const git = recordingGit();
    const m = manager(fake('guard-timeout', `console.log('tick ok');`), { prismaRoot: root, git, env: { PRISMA_CHECKOUT_GUARD: '1' } });
    await m.start();
    await until(() => m.status().ticks >= 1);
    await m.stop();
    assert.ok(git.seen.length > 0);
    assert.deepStrictEqual([...new Set(git.seen.map(c => c.timeout))], [GUARD_GIT_TIMEOUT_MS]);
});

test('guard do tick: árvore limpa numa branch fora da main recusa com off_main', async () => {
    const root = guardRepo();
    guardSh(root, 'switch', '--quiet', '-c', 'fora');
    fs.writeFileSync(path.join(root, 'b.txt'), 'fora\n');
    guardSh(root, 'add', 'b.txt');
    guardSh(root, 'commit', '--quiet', '-m', 'fora');
    const marker = path.join(tmp, `guard-spawn-${++n}`);
    const m = manager(fake('guard-off-main', `require('fs').writeFileSync(${JSON.stringify(marker)}, 'x');`),
        { prismaRoot: root, git: countingGit(), env: { PRISMA_CHECKOUT_GUARD: '1' } });
    const st = await m.start();
    await new Promise(r => setTimeout(r, 250));
    assert.ok(!fs.existsSync(marker), 'nenhum spawn');
    assert.strictEqual(st.error, 'checkout_guard');
    assert.deepStrictEqual(st.guard, { reasons: ['off_main'], paths: [] });
    assert.strictEqual(m.status().state, 'stopped');
});

test('guard: HEAD destacado numa tag verde/* alcançável pela origin/main passa e o tick roda', async () => {
    const root = guardRepo();
    guardSh(root, 'tag', '-a', 'verde/20260101-000000', '-m', 'verde');
    fs.writeFileSync(path.join(root, 'b.txt'), 'dois\n');
    guardSh(root, 'add', 'b.txt');
    guardSh(root, 'commit', '--quiet', '-m', 'dois');
    guardSh(root, 'push', '--quiet', 'origin', 'main');
    guardSh(root, 'fetch', '--quiet', 'origin');
    guardSh(root, 'switch', '--quiet', '--detach', 'verde/20260101-000000');
    const env = { PRISMA_CHECKOUT_GUARD: '1' };
    assert.strictEqual(checkoutGuard({ root, env, git: countingGit() }), null);
    const m = manager(fake('guard-verde', `console.log('tick ok');`), { prismaRoot: root, git: countingGit(), env });
    await m.start();
    await until(() => texts(m).includes('tick ok'));
    assert.strictEqual(m.status().error, null);
    assert.strictEqual(m.status().guard, null);
    await m.stop();
});

// exitIfCheckoutRefused: a subida do dashboard imprime a recusa e sai com 2 (PRI-379).
const { exitIfCheckoutRefused } = require('./watcher-manager');
function bootSpy() {
    const s = { lines: [], exits: [] };
    s.log = line => s.lines.push(line);
    s.exit = code => s.exits.push(code);
    return s;
}

test('exitIfCheckoutRefused: flag ausente não loga, não sai e não chama git', () => {
    const root = guardRepo();
    fs.writeFileSync(path.join(root, 'solto.txt'), 'sujo\n');
    const git = countingGit();
    const s = bootSpy();
    exitIfCheckoutRefused({ codeRoot: root, env: {}, log: s.log, exit: s.exit, git });
    assert.deepStrictEqual(s.lines, []);
    assert.deepStrictEqual(s.exits, []);
    assert.strictEqual(git.calls, 0);
});

test('exitIfCheckoutRefused: flag ligada e árvore suja imprime motivos e caminhos e sai com 2', () => {
    const root = guardRepo();
    fs.writeFileSync(path.join(root, 'solto.txt'), 'sujo\n');
    const s = bootSpy();
    exitIfCheckoutRefused({ codeRoot: root, env: { PRISMA_CHECKOUT_GUARD: '1' }, log: s.log, exit: s.exit, git: countingGit() });
    assert.deepStrictEqual(s.exits, [2]);
    assert.ok(s.lines[0].startsWith('[dashboard] subida recusada pelo guard do checkout (PRISMA_CHECKOUT_GUARD): '));
    assert.ok(s.lines[0].includes('dirty'));
    assert.ok(s.lines.some(l => l.startsWith(`[dashboard]   em ${root}: `) && l.includes('dirty')));
    assert.ok(s.lines.includes('[dashboard]     solto.txt'));
});

test('exitIfCheckoutRefused: flag ligada e árvore ok não loga nem sai', () => {
    const root = guardRepo();
    const git = countingGit();
    const s = bootSpy();
    exitIfCheckoutRefused({ codeRoot: root, env: { PRISMA_CHECKOUT_GUARD: '1' }, log: s.log, exit: s.exit, git });
    assert.deepStrictEqual(s.lines, []);
    assert.deepStrictEqual(s.exits, []);
    assert.ok(git.calls > 0);
});
