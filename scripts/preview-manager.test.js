// node --test scripts/preview-manager.test.js
// mvn/java/npm falsos (shell scripts em tmp, via PATH e javaHome) no lugar dos reais —
// os comandos padrão do preview-manager rodam de verdade, só que contra os fakes.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createPreviewManager, readProperties, LOG_LINES } = require('./preview-manager');

const tmpBase = process.env.CLAUDE_JOB_DIR ? path.join(process.env.CLAUDE_JOB_DIR, 'tmp') : os.tmpdir();
const tmp = fs.mkdtempSync(path.join(tmpBase, 'preview-manager-'));
const bin = path.join(tmp, 'bin');
const jdk = path.join(tmp, 'jdk');
fs.mkdirSync(bin);
fs.mkdirSync(path.join(jdk, 'bin'), { recursive: true });
const managers = [];
test.after(async () => {
    await Promise.all(managers.map(m => m.stopAll()));
    fs.rmSync(tmp, { recursive: true, force: true });
});

function script(file, body) {
    fs.writeFileSync(file, `#!/bin/sh\n${body}\n`);
    fs.chmodSync(file, 0o755);
}
// mvn: grava a chamada em calls.log, FAIL_IN=<nome do dir> falha, MVN_SLEEP segura o
// build (com um neto `sleep` pra provar que stop() mata o grupo).
script(path.join(bin, 'mvn'), `
echo "mvn $* @ $(basename "$PWD") JAVA_HOME=$JAVA_HOME" >> "$CALLS"
echo "[INFO] building $(basename "$PWD") token=$PREVIEW_TEST_TOKEN"
if [ -n "$MVN_SLEEP" ]; then sleep 30 & echo $! > "$GRANDCHILD"; wait; fi
if [ "$(basename "$PWD")" = "$FAIL_IN" ]; then echo "[ERROR] BUILD FAILURE" >&2; exit 1; fi
exit 0`);
// java: ecoa os args; BACK_MODE=hang nunca loga "started in", crash sai depois de subir.
script(path.join(jdk, 'bin', 'java'), `
echo "java $* SISTEMA=$SISTEMA ambiente=$ambiente"
echo "senha do banco: s3nh4-do-banco-stage"
if [ "$BACK_MODE" = "hang" ]; then exec sleep 30; fi
echo "tms 1.0 on JVM (powered by Quarkus 3.9) started in 1.234s. Listening on: http://0.0.0.0:8081"
if [ "$BACK_MODE" = "crash" ]; then sleep 0.3; exit 3; fi
exec sleep 30`);
// app-front: grunt falso no node_modules do worktree (o preview-gruntfile.js chama
// grunt.tasks() dele); fica vivo como o watch.
const FAKE_GRUNT = `module.exports = { tasks(tasks, opts) {
    console.log('grunt ' + tasks.join(' ') + ' gruntfile=' + opts.gruntfile + ' base=' + opts.base + ' BACK_PORT=' + process.env.PREVIEW_BACK_PORT);
    console.log('Running "watch" task'); process.stdout.write('\\x1b[36mWaiting...\\x1b[39m');
    setInterval(() => {}, 1000);
} };`;

const PROPS = 'sistema=MOTESTE\nambiente=dev\nquarkus.datasource.password=s3nh4-do-banco-stage\n# Configura\xe7\xe3o\n';
let n = 0;
function worktrees(parts = ['', '-mo-entity', '-app-core', '-app-front']) {
    const root = path.join(tmp, `wt-${++n}`);
    for (const p of parts) fs.mkdirSync(path.join(root, `4242${p}`), { recursive: true });
    if (parts.includes('-app-front')) {
        const g = path.join(root, '4242-app-front', 'node_modules', 'grunt');
        fs.mkdirSync(g, { recursive: true });
        fs.writeFileSync(path.join(g, 'index.js'), FAKE_GRUNT);
    }
    if (parts.includes('')) {
        const back = path.join(root, '4242');
        fs.mkdirSync(path.join(back, 'target', 'quarkus-app'), { recursive: true });
        fs.writeFileSync(path.join(back, 'target', 'quarkus-app', 'quarkus-run.jar'), '');
        fs.mkdirSync(path.join(back, 'src', 'main', 'resources'), { recursive: true });
        fs.writeFileSync(path.join(back, 'src', 'main', 'resources', 'application-local-dev.properties'), Buffer.from(PROPS, 'latin1'));
    }
    return root;
}
function manager(root, env = {}, extra = {}) {
    const calls = path.join(root, 'calls.log');
    const m = createPreviewManager({
        adapter: 'maven-quarkus-grunt', profile: 'local-dev', dbOptions: 'stage=local-dev,local-cacaushow=local-cacau',
        worktreesDir: root, envFile: null, javaHome: jdk, checkPorts: false, stopGraceMs: 500,
        startupTimeoutMs: 3000, frontReadyMs: 3000,
        libRepos: {}, // nunca os ../mo-entity e ../app-core reais
        ports: { back: 8081, front: 9000 }, // o java falso anuncia 8081
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, CALLS: calls, GRANDCHILD: path.join(root, 'grandchild.pid'), ...env },
        ...extra,
    });
    managers.push(m);
    return { m, calls: () => (fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8') : '') };
}
async function until(fn, ms = 6000) {
    for (const end = Date.now() + ms; ;) {
        if (fn()) return;
        if (Date.now() > end) throw new Error('timeout esperando condição');
        await new Promise(r => setTimeout(r, 25));
    }
}
const texts = (m, id = '4242') => m.getLogBuffer(id).map(e => e.text);
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };

test('pipeline completo: builda na ordem, sobe back e front, stop mata tudo e volta pra idle', async () => {
    const root = worktrees();
    const { m, calls } = manager(root);
    const phases = [];
    m.on('phase', (id, st) => phases.push(st.phase));
    const st = m.start('4242');
    assert.strictEqual(st.phase, 'building-mo-entity');
    assert.deepStrictEqual(st.worktrees, { back: true, moEntity: true, appCore: true, front: true });
    await until(() => m.status('4242').phase === 'running');

    const order = calls().trim().split('\n').map(l => l.match(/@ (\S+)/)[1]);
    assert.deepStrictEqual(order, ['4242-mo-entity', '4242-app-core', '4242']);
    assert.match(calls(), /mvn clean install -DskipTests -q @ 4242-mo-entity/);
    assert.match(calls(), /mvn clean package -DskipTests -q @ 4242 /);
    assert.match(calls(), new RegExp(`JAVA_HOME=${jdk}`));
    assert.deepStrictEqual([...new Set(phases)], ['building-mo-entity', 'building-app-core', 'building-app-back', 'starting-back', 'starting-front', 'running']);

    const log = texts(m).join('\n');
    assert.match(log, /\[mo-entity\] \[INFO\] building 4242-mo-entity/);
    assert.match(log, /\[build-back\] \[INFO\] building 4242/);
    assert.match(log, /\[app-back\] java -Dquarkus\.profile=local-dev -Dquarkus\.http\.port=8081 -jar target\/quarkus-app\/quarkus-run\.jar SISTEMA=MOTESTE ambiente=dev/);
    assert.match(log, /\[app-front\] grunt serve gruntfile=\S+scripts\/preview-gruntfile\.js base=\S+4242-app-front BACK_PORT=8081/);

    const running = m.status('4242');
    assert.deepStrictEqual(running.ports, { back: 8081, front: 9000 });
    assert.ok(running.runningAt && running.pids.back && running.pids.front);
    assert.ok(!texts(m).some(t => t.includes('\x1b')), 'ANSI removido do log');
    assert.ok(!texts(m).some(t => /considerando no ar/.test(t)), 'front pronto pelo "Waiting..." sem \\n, não pelo fallback');
    assert.deepStrictEqual(running.steps, { 'mo-entity': 'done', 'app-core': 'done', 'app-back': 'done', back: 'done', front: 'done' });
    assert.strictEqual(running.activeTicket, '4242');

    const { back, front } = running.pids;
    const stopped = await m.stop('4242');
    assert.strictEqual(stopped.phase, 'idle');
    assert.strictEqual(stopped.pids.back, null);
    await until(() => !alive(back) && !alive(front));
    assert.strictEqual(m.status('4242').activeTicket, null);
});

test('sem worktree do mo-entity/app-core: pula o build deles (usa ~/.m2); sem front: running só com o back', async () => {
    const root = worktrees(['']);
    const { m, calls } = manager(root);
    const st = m.start('4242');
    assert.strictEqual(st.phase, 'building-app-back');
    // O primeiro build já dispara dentro do start().
    assert.deepStrictEqual(st.steps, { 'mo-entity': 'skipped', 'app-core': 'skipped', 'app-back': 'running', back: 'pending', front: 'skipped' });
    await until(() => m.status('4242').phase === 'running');
    assert.deepStrictEqual(calls().trim().split('\n').map(l => l.match(/@ (\S+)/)[1]), ['4242']);
    assert.ok(texts(m).some(t => /mo-entity: sem worktree próprio — usando a versão do ~\/\.m2/.test(t)));
    assert.strictEqual(m.status('4242').pids.front, null);
    await m.stop('4242');
});

test('sem worktree do app-back: rejeita com 404 e mensagem clara', () => {
    const root = worktrees(['-app-core']);
    const { m } = manager(root);
    assert.throws(() => m.start('4242'), e => e.status === 404 && e.message === 'worktree do app-back não encontrado para ticket 4242');
    assert.strictEqual(m.status('4242').worktrees.back, false);
});

test('ticket-id com path traversal ou inválido → 400', () => {
    const { m } = manager(worktrees());
    for (const bad of ['../etc', '..', 'a/b', '', '-x']) assert.throws(() => m.start(bad), e => e.status === 400, bad);
});

test('BUILD FAILURE para o pipeline: fase error, passos seguintes não rodam, retry funciona', async () => {
    const root = worktrees();
    const { m, calls } = manager(root, { FAIL_IN: '4242-app-core' });
    m.start('4242');
    await until(() => m.status('4242').phase === 'error');
    const st = m.status('4242');
    assert.strictEqual(st.errorPhase, 'building-app-core');
    assert.match(st.error, /BUILD FAILURE em app-core \(código 1\)/);
    assert.strictEqual(st.steps['app-core'], 'error');
    assert.strictEqual(st.steps['app-back'], 'pending');
    assert.doesNotMatch(calls(), /@ 4242 /);
    assert.ok(texts(m).some(t => t === '[app-core] [ERROR] BUILD FAILURE'));
    assert.strictEqual(st.activeTicket, null, 'erro não segura o slot');
    // Tentar novamente = start de novo a partir do erro.
    assert.strictEqual(m.start('4242').phase, 'building-mo-entity');
    await until(() => m.status('4242').phase === 'error');
    assert.strictEqual((await m.stop('4242')).phase, 'idle');
});

test('segundo preview com um ativo → 409 com o ticket do outro', async () => {
    const root = worktrees();
    fs.mkdirSync(path.join(root, '9999'));
    const { m } = manager(root, { MVN_SLEEP: '1' });
    m.start('4242');
    assert.throws(() => m.start('9999'), e => e.status === 409 && e.message === 'Preview do ticket 4242 ainda está rodando — pare-o antes de iniciar um novo');
    assert.throws(() => m.start('4242'), e => e.status === 409);
    assert.strictEqual(m.status('9999').activeTicket, '4242');
    await m.stop('4242');
    assert.doesNotThrow(() => m.start('9999'));
    await m.stop('9999');
});

test('stop no meio do build mata o grupo do mvn (inclusive o neto) e aborta o pipeline', async () => {
    const root = worktrees();
    const { m, calls } = manager(root, { MVN_SLEEP: '1' });
    m.start('4242');
    const gc = path.join(root, 'grandchild.pid');
    await until(() => fs.existsSync(gc) && fs.readFileSync(gc, 'utf8').trim());
    const grandchild = Number(fs.readFileSync(gc, 'utf8'));
    assert.ok(alive(grandchild));
    assert.strictEqual((await m.stop('4242')).phase, 'idle');
    await until(() => !alive(grandchild));
    await new Promise(r => setTimeout(r, 200));
    assert.strictEqual(calls().trim().split('\n').length, 1, 'nenhum build depois do stop');
    assert.strictEqual(m.status('4242').phase, 'idle');
});

test('back sem "started in" no timeout → error e processo java morto', async () => {
    const { m } = manager(worktrees(['']), { BACK_MODE: 'hang' }, { startupTimeoutMs: 400 });
    m.start('4242');
    await until(() => m.status('4242').phase === 'starting-back');
    const pid = m.status('4242').pids.back;
    await until(() => m.status('4242').phase === 'error');
    assert.match(m.status('4242').error, /não logou "started in" em 0s/);
    assert.strictEqual(m.status('4242').errorPhase, 'starting-back');
    await until(() => !alive(pid));
    await m.stop('4242');
});

test('back que cai depois de rodando → error', async () => {
    const { m } = manager(worktrees(['']), { BACK_MODE: 'crash' });
    m.start('4242');
    await until(() => m.status('4242').phase === 'error');
    assert.match(m.status('4242').error, /app-back encerrou \(código 3\)/);
    assert.strictEqual(m.status('4242').errorPhase, 'running');
    await m.stop('4242');
});

test('secrets: valor do env e senha do .properties viram [REDACTED]', async () => {
    const { m } = manager(worktrees(['']), { PREVIEW_TEST_TOKEN: 'tok-super-secreto-123' });
    m.start('4242');
    await until(() => m.status('4242').phase === 'running');
    const log = texts(m).join('\n');
    assert.doesNotMatch(log, /tok-super-secreto-123|s3nh4-do-banco-stage/);
    assert.match(log, /token=\[REDACTED\]/);
    assert.match(log, /senha do banco: \[REDACTED\]/);
    await m.stop('4242');
});

test('ringbuffer guarda só as últimas 300 linhas', async () => {
    const root = worktrees(['']);
    const { m } = manager(root, {}, { commands: { build: () => ({ cmd: process.execPath, args: ['-e', 'for (let i = 0; i < 500; i++) console.log("linha " + i)'] }) } });
    m.start('4242');
    await until(() => m.status('4242').phase === 'running');
    const buf = m.getLogBuffer('4242');
    assert.strictEqual(buf.length, LOG_LINES);
    assert.ok(!buf.some(e => e.text === '[build-back] linha 0'));
    assert.ok(buf.some(e => e.text === '[build-back] linha 499'));
    await m.stop('4242');
});

test('back padrão na 8080; back e front na mesma porta é recusado; porta ocupada vira erro antes do build', async () => {
    assert.strictEqual(createPreviewManager({ env: {}, envFile: null }).ports.back, 8080);
    assert.throws(() => createPreviewManager({ ports: { back: 9000, front: 9000 } }), /não podem ser iguais/);
    const srv = require('net').createServer().listen(0, '127.0.0.1');
    await new Promise(r => srv.once('listening', r));
    const port = srv.address().port;
    const { m, calls } = manager(worktrees(['']), {}, { checkPorts: true, ports: { back: port, front: 9000 } });
    m.start('4242');
    await until(() => m.status('4242').phase === 'error');
    assert.match(m.status('4242').error, new RegExp(`porta em uso \\(back :${port}\\)`));
    assert.strictEqual(calls(), '');
    srv.close();
    await m.stop('4242');
});

test('readProperties lê latin1 e ignora comentário', () => {
    const f = path.join(tmp, 'p.properties');
    fs.writeFileSync(f, Buffer.from('# coment\xe1rio\nsistema=MOTESTE\ndescricao=Configura\xe7\xe3o\n', 'latin1'));
    assert.deepStrictEqual(readProperties(f), { sistema: 'MOTESTE', descricao: 'Configuração' });
});

test('preview-gruntfile: porta do connect e proxy :8080 → porta do preview, sem abrir browser', () => {
    const front = path.join(tmp, 'front');
    fs.mkdirSync(path.join(front, 'node_modules', 'connect-modrewrite'), { recursive: true });
    fs.writeFileSync(path.join(front, 'node_modules', 'connect-modrewrite', 'index.js'), 'module.exports = rules => ({ rules });');
    fs.writeFileSync(path.join(front, 'Gruntfile.js'), `module.exports = g => g.initConfig({ connect: { options: { port: 9000 }, livereload: { options: { open: true,
        middleware: () => [require('connect-modrewrite')(['^/portal/api http://localhost:8080/portal/ [P L]', '^/api http://localhost:8080/ [P L]', '^/mongo http://localhost:5000 [P L]'])] } } } });`);
    const config = {};
    const get = k => k.split('.').reduce((o, p) => o?.[p], config);
    const grunt = {
        initConfig: c => Object.assign(config, c),
        config: { get, set: (k, v) => { const ps = k.split('.'); const last = ps.pop(); ps.reduce((o, p) => (o[p] ||= {}), config)[last] = v; } },
        log: { writeln: () => {}, error: () => {} },
    };
    Object.assign(process.env, { PREVIEW_FRONT_DIR: front, PREVIEW_BACK_PORT: '8181', PREVIEW_FRONT_PORT: '9100' });
    try { require('./preview-gruntfile')(grunt); } finally { for (const k of ['PREVIEW_FRONT_DIR', 'PREVIEW_BACK_PORT', 'PREVIEW_FRONT_PORT']) delete process.env[k]; }
    assert.strictEqual(config.connect.options.port, 9100);
    assert.strictEqual(config.connect.livereload.options.open, false);
    assert.strictEqual(config.connect.livereload.options.keepalive, true);
    assert.deepStrictEqual(config.connect.livereload.options.middleware()[0].rules, [
        '^/portal/api http://localhost:8181/portal/ [P L]', '^/api http://localhost:8181/ [P L]', '^/mongo http://localhost:5000 [P L]',
    ]);
});

test('clean: apaga target/ dos worktrees, .tmp do front e o install do preview no ~/.m2; recusa com preview ativo', async () => {
    const root = worktrees();
    const m2 = path.join(root, 'm2');
    const pom = a => `<project><parent><groupId>x.parent</groupId><artifactId>pai</artifactId><version>9</version></parent>
    <groupId>br.com.mosistemas</groupId><artifactId>${a}</artifactId><version>3.49-SNAPSHOT</version>
    <dependencies><dependency><groupId>outro</groupId><artifactId>dep</artifactId><version>1</version></dependency></dependencies></project>`;
    fs.writeFileSync(path.join(root, '4242-mo-entity', 'pom.xml'), pom('mo-entity'));
    fs.writeFileSync(path.join(root, '4242-app-core', 'pom.xml'), pom('app-core'));
    for (const d of ['4242-mo-entity/target', '4242-app-core/target', '4242-app-front/.tmp']) fs.mkdirSync(path.join(root, d), { recursive: true });
    const installed = a => path.join(m2, 'br', 'com', 'mosistemas', a, '3.49-SNAPSHOT');
    const outra = path.join(m2, 'br', 'com', 'mosistemas', 'mo-entity', '3.48');
    for (const d of [installed('mo-entity'), installed('app-core'), outra]) fs.mkdirSync(d, { recursive: true });

    const { m } = manager(root, { MVN_SLEEP: '1' }, { m2Repo: m2 });
    m.start('4242');
    assert.throws(() => m.clean('4242'), e => e.status === 409);
    await m.stop('4242');

    const r = m.clean('4242');
    assert.strictEqual(r.removed.length, 6);
    for (const d of ['4242/target', '4242-mo-entity/target', '4242-app-core/target', '4242-app-front/.tmp']) assert.ok(!fs.existsSync(path.join(root, d)), d);
    assert.ok(!fs.existsSync(installed('mo-entity')) && !fs.existsSync(installed('app-core')));
    assert.ok(fs.existsSync(outra), 'outras versões do ~/.m2 ficam');
    assert.ok(fs.existsSync(path.join(root, '4242', 'src')), 'fonte intacto');
    assert.match(texts(m).join('\n'), /cache removido: ~\/\.m2\/br\/com\/mosistemas\/app-core\/3\.49-SNAPSHOT/);
    assert.deepStrictEqual(m.clean('4242').removed, []);
    assert.throws(() => m.clean('../x'), e => e.status === 400);
});

test('clean sem worktree do mo-entity/app-core não toca no ~/.m2', () => {
    const root = worktrees(['']);
    const m2 = path.join(root, 'm2', 'br', 'com', 'mosistemas', 'mo-entity', '3.49-SNAPSHOT');
    fs.mkdirSync(m2, { recursive: true });
    const { m } = manager(root, {}, { m2Repo: path.join(root, 'm2') });
    assert.deepStrictEqual(m.clean('4242').removed.map(p => path.relative(root, p)), [path.join('4242', 'target')]);
    assert.ok(fs.existsSync(m2));
});

test('sem PREVIEW_JAVA_HOME: JAVA_HOME herdado abaixo do release do pom é trocado pelo java_home -v <release>', async t => {
    const { execFileSync } = require('child_process');
    let jdk25 = null;
    try { jdk25 = execFileSync('/usr/libexec/java_home', ['-v', '25'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch {}
    if (!jdk25) return t.skip('sem JDK 25 nesta máquina');
    const jdk17 = path.join(tmp, 'jdk17');
    fs.mkdirSync(jdk17, { recursive: true });
    fs.writeFileSync(path.join(jdk17, 'release'), 'JAVA_VERSION="17.0.18"\n');
    const root = worktrees(['']);
    const { m, calls } = manager(root, { JAVA_HOME: jdk17, PREVIEW_JAVA_HOME: '' }, { javaHome: undefined });
    m.start('4242');
    await until(() => calls().includes('@ 4242'));
    await m.stop('4242');
    assert.match(calls(), new RegExp(`JAVA_HOME=${jdk25}`));
});

test('lib sem worktree: builda do repo irmão na branch com a versão do back (origin/<ticket> antes do master), pula se o commit não mudou', async () => {
    const { execFileSync } = require('child_process');
    const root = worktrees(['']);
    fs.writeFileSync(path.join(root, '4242', 'pom.xml'), '<project><groupId>br.com.mosistemas</groupId><artifactId>app-back</artifactId><version>3.49</version></project>');
    const sh = (cwd, ...a) => execFileSync('git', a, { cwd, stdio: 'pipe', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } }).toString();
    const origin = path.join(root, 'origin-core.git');
    const seed = path.join(root, 'seed');
    sh(root, 'init', '-q', '--bare', origin);
    sh(root, 'init', '-q', '-b', 'master', seed);
    const commit = (v, msg) => { fs.writeFileSync(path.join(seed, 'pom.xml'), `<project><groupId>br.com.mosistemas</groupId><artifactId>app-core</artifactId><version>${v}</version></project>`); sh(seed, 'add', '.'); sh(seed, 'commit', '-q', '-m', msg); };
    commit('3.49', 'master');
    sh(seed, 'checkout', '-q', '-b', 'development'); commit('3.50-SNAPSHOT', 'dev');
    sh(seed, 'checkout', '-q', '-b', '4242', 'master'); fs.writeFileSync(path.join(seed, 'Ticket.java'), 'class Ticket {}'); commit('3.49', 'ticket');
    sh(seed, 'push', '-q', origin, 'master', 'development', '4242');
    const repo = path.join(root, 'app-core');
    sh(root, 'clone', '-q', origin, repo);
    const m2 = path.join(root, 'm2');

    const { m, calls } = manager(root, {}, { libRepos: { appCore: repo, moEntity: path.join(root, 'nao-existe') }, m2Repo: m2, libTmpDir: root });
    assert.strictEqual(m.start('4242').steps['app-core'], 'pending');
    await until(() => m.status('4242').phase === 'running');
    assert.match(calls(), /mvn clean install -DskipTests -q @ preview-app-core-4242 /);
    const log = texts(m).join('\n');
    assert.match(log, /app-core: sem worktree próprio — buildando origin\/4242 \(\w{10}, versão 3\.49\)/);
    assert.match(log, /mo-entity: sem worktree próprio — usando a versão do ~\/\.m2/);
    assert.ok(!fs.existsSync(path.join(root, 'preview-app-core-4242')), 'worktree temporário removido');
    assert.ok(!sh(repo, 'worktree', 'list').includes('preview-app-core'));
    const marker = JSON.parse(fs.readFileSync(path.join(m2, 'br', 'com', 'mosistemas', 'app-core', '3.49', '.preview-build.json'), 'utf8'));
    assert.strictEqual(marker.ref, 'origin/4242');
    await m.stop('4242');

    // Mesmo commit: não builda de novo.
    const before = calls().split('\n').filter(l => l.includes('preview-app-core')).length;
    m.start('4242');
    await until(() => m.status('4242').phase === 'running');
    assert.strictEqual(calls().split('\n').filter(l => l.includes('preview-app-core')).length, before);
    assert.match(texts(m).join('\n'), /app-core: ~\/\.m2 já tem 3\.49 de origin\/4242 \(\w{10}\) — build pulado/);
    await m.stop('4242');

    // Sem branch do ticket: cai no primeiro PREVIEW_LIB_REFS com a versão (master, não development).
    sh(repo, 'update-ref', '-d', 'refs/remotes/origin/4242');
    sh(origin, 'update-ref', '-d', 'refs/heads/4242');
    m.start('4242');
    await until(() => m.status('4242').phase === 'running');
    assert.match(texts(m).join('\n'), /buildando origin\/master \(/);
    await m.stop('4242');
});

test('lib sem worktree e sem branch com a versão do back: segue com o ~/.m2 e avisa', async () => {
    const { execFileSync } = require('child_process');
    const root = worktrees(['']);
    fs.writeFileSync(path.join(root, '4242', 'pom.xml'), '<project><groupId>g</groupId><artifactId>app-back</artifactId><version>9.99</version></project>');
    const repo = path.join(root, 'app-core');
    execFileSync('git', ['init', '-q', repo]);
    const { m, calls } = manager(root, {}, { libRepos: { appCore: repo }, m2Repo: path.join(root, 'm2'), libTmpDir: root });
    m.start('4242');
    await until(() => m.status('4242').phase === 'running');
    assert.doesNotMatch(calls(), /preview-app-core/);
    assert.strictEqual(m.status('4242').steps['app-core'], 'skipped');
    assert.match(texts(m).join('\n'), /app-core: nenhuma branch \(origin\/4242, origin\/master, origin\/development\) com a versão 9\.99 — usando a versão do ~\/\.m2/);
    await m.stop('4242');
});

test('back que anuncia porta diferente da pedida → error e processo derrubado', async () => {
    const root = worktrees(['']);
    const { m } = manager(root, {}, { ports: { back: 8099, front: 9099 } });
    m.start('4242');
    await until(() => m.status('4242').phase === 'error');
    assert.match(m.status('4242').error, /app-back subiu na porta 8081, não na 8099 pedida/);
    await until(() => m.status('4242').pids.back === null);
});

test('worktrees irmãos (../<repo>/.claude/worktrees/<id>) são detectados; front ganha node_modules/bower_components do principal se o manifest é igual', async () => {
    const root = worktrees(['']);
    const repo = k => path.join(root, 'repos', k);
    for (const k of ['mo-entity', 'app-core', 'app-front']) fs.mkdirSync(path.join(repo(k), '.claude', 'worktrees', '4242'), { recursive: true });
    const front = path.join(repo('app-front'), '.claude', 'worktrees', '4242');
    fs.mkdirSync(path.join(repo('app-front'), 'node_modules', 'grunt'), { recursive: true });
    fs.writeFileSync(path.join(repo('app-front'), 'node_modules', 'grunt', 'index.js'), FAKE_GRUNT);
    fs.mkdirSync(path.join(repo('app-front'), 'bower_components'));
    for (const d of [repo('app-front'), front]) { fs.writeFileSync(path.join(d, 'package.json'), '{"a":1}'); fs.writeFileSync(path.join(d, 'bower.json'), '{"b":1}'); }
    fs.writeFileSync(path.join(front, 'bower.json'), '{"b":2}'); // difere: não linka

    const { m, calls } = manager(root, {}, { libRepos: { moEntity: repo('mo-entity'), appCore: repo('app-core'), front: repo('app-front') } });
    assert.deepStrictEqual(m.status('4242').worktrees, { back: true, moEntity: true, appCore: true, front: true });
    m.start('4242');
    await until(() => m.status('4242').phase === 'running');
    assert.match(calls(), /mvn clean install -DskipTests -q @ 4242 .*\n.*mvn clean install -DskipTests -q @ 4242 /);
    assert.strictEqual(fs.readlinkSync(path.join(front, 'node_modules')), path.join(repo('app-front'), 'node_modules'));
    assert.ok(!fs.existsSync(path.join(front, 'bower_components')));
    assert.match(texts(m).join('\n'), /bower_components.*bower\.json difere do checkout principal/);
    await m.stop('4242');
});

test('banco: PREVIEW_DB_OPTIONS vira as opções (com banco/sistema do .properties); start({db}) troca o profile; banco fora da lista → 400', async () => {
    const root = worktrees(['']);
    const res = path.join(root, '4242', 'src', 'main', 'resources');
    fs.writeFileSync(path.join(res, 'application-local-cacau.properties'), 'sistema=CACAUSHOW\nambiente=HOMOLOGACAO\nquarkus.datasource.jdbc.url=jdbc:postgresql://10.0.0.1:5432/cacau_stage?x=1\nquarkus.datasource.password=segredo-cacau\n');
    const { m, calls } = manager(root, { PREVIEW_DB_OPTIONS: 'stage=local-dev, local-cacaushow=local-cacau, local=local-inexistente' });
    const opts = m.status('4242').dbOptions;
    assert.deepStrictEqual(opts.map(o => [o.key, o.profile, o.exists]), [['stage', 'local-dev', true], ['local-cacaushow', 'local-cacau', true], ['local', 'local-inexistente', false]]);
    assert.strictEqual(opts[1].db, '10.0.0.1:5432/cacau_stage');
    assert.strictEqual(opts[1].sistema, 'CACAUSHOW');
    assert.throws(() => m.start('4242', { db: 'producao' }), e => e.status === 400 && /banco inválido: producao/.test(e.message));
    assert.throws(() => m.start('4242', { db: 'local' }), e => e.status === 400 && /application-local-inexistente\.properties não existe/.test(e.message));

    const st = m.start('4242', { db: 'local-cacaushow' });
    assert.strictEqual(st.db, 'local-cacaushow');
    await until(() => m.status('4242').phase === 'running');
    const log = texts(m).join('\n');
    assert.match(log, /\[app-back\] java -Dquarkus\.profile=local-cacau -Dquarkus\.http\.port=8081 .* SISTEMA=CACAUSHOW ambiente=HOMOLOGACAO/);
    assert.match(log, /banco local-cacaushow \(profile local-cacau, 10\.0\.0\.1:5432\/cacau_stage\)/);
    assert.doesNotMatch(log, /segredo-cacau/);
    await m.stop('4242');

    m.start('4242'); // sem db: o primeiro da lista (stage)
    assert.strictEqual(m.status('4242').profile, 'local-dev');
    await m.stop('4242');
    assert.ok(calls());
});
