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
