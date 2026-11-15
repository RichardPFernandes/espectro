// node --test scripts/lib/ui-verify-cli.test.js
// CLI da verificação de UI (PRI-355): touches, verdict e ciclo de vida do servidor, com repositório git
// descartável e servidores falsos em porta efêmera. Sem rede externa. Cada teste é regressão de uma
// mutação que sobreviveu à revisão (reuso, stop, evidência velha, injeção de base, N/A silencioso).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const path = require('node:path');
const http = require('node:http');
const { spawn, execFileSync } = require('node:child_process');

const tmpBase = process.env.CLAUDE_JOB_DIR ? path.join(process.env.CLAUDE_JOB_DIR, 'tmp') : os.tmpdir();
const work = fs.mkdtempSync(path.join(fs.realpathSync(tmpBase), 'ui-verify-cli-'));
// Tudo que o CLI cria em os.tmpdir() cai aqui: contagem de sobras isolada de outros processos.
const tmproot = path.join(work, 'tmp'); fs.mkdirSync(tmproot);
process.env.TMPDIR = tmproot;
const { main, cfg, serverEnsure, serverStop, probe } = require('../ui-verify');
const leftovers = () => fs.readdirSync(tmproot).filter(n => /^ui-verify-(home|fixture)-/.test(n)).length;

function git(cwd, ...args) { return execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' }); }
function makeRepo(name) {
    const dir = path.join(work, name);
    fs.mkdirSync(path.join(dir, 'dashboard/public'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'lib'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'dashboard/public/app.js'), 'a');
    fs.writeFileSync(path.join(dir, 'lib/x.js'), 'x');
    git(dir, 'init', '-q', '-b', 'main'); git(dir, 'add', '-A'); git(dir, 'commit', '-q', '-m', 'base');
    return dir;
}
function capture() { const o = { out: [], err: [] }; return { log: s => o.out.push(s), error: s => o.err.push(s), o }; }
async function cli(argv, env) {
    const io = capture();
    const code = await main(argv, { PRISMA_UI_FRONTEND_GLOBS: 'dashboard/public/**', ...env }, io);
    return { code, out: io.o.out.join('\n'), err: io.o.err.join('\n') };
}
async function freePort() { return new Promise(r => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); }); }
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('dados')]);

const FAKE = "const h=require('http').createServer((q,s)=>s.end(JSON.stringify({env:process.env,cwd:process.cwd()})));h.listen(Number(process.env.PORT),process.env.HOST||'127.0.0.1');";
function envFor(repo, port, extra = {}) {
    fs.writeFileSync(path.join(repo, 'fake.js'), FAKE);
    return { REPO_PATH: repo, PRISMA_UI_VERIFY: 'on', PRISMA_UI_PORT: String(port), PRISMA_UI_SERVER_CMD: 'node fake.js', PRISMA_UI_SERVER_CWD: repo, PRISMA_UI_CUSTOM_SERVER: '1', PRISMA_UI_FRONTEND_GLOBS: 'dashboard/public/**', ...extra };
}
const stateOf = c => JSON.parse(fs.readFileSync(path.join(c.stateDir, 'server.json'), 'utf8'));
const getJson = (port, p = '/') => new Promise((res, rej) => http.get({ host: '127.0.0.1', port, path: p }, r => { let b = ''; r.on('data', d => { b += d; }); r.on('end', () => res(JSON.parse(b))); }).on('error', rej));
async function stopQuiet(c) { try { process.kill(-stateOf(c).pid, 'SIGKILL'); } catch { /* ok */ } await serverStop(c).catch(() => {}); }

// ---------- touches ----------
test('touches: frontend modificado, untracked e com acento dão exit 0; sem mudança dá exit 1', async () => {
    const repo = makeRepo('t1');
    assert.strictEqual((await cli(['touches', 'main'], { REPO_PATH: repo })).code, 1, 'sem mudança');
    fs.writeFileSync(path.join(repo, 'dashboard/public/app.js'), 'b');
    assert.deepStrictEqual(await cli(['touches', 'main'], { REPO_PATH: repo }), { code: 0, out: 'frontend', err: '' });
    git(repo, 'checkout', '-q', '.');
    fs.writeFileSync(path.join(repo, 'dashboard/public/café.js'), 'c');
    assert.strictEqual((await cli(['touches', 'main'], { REPO_PATH: repo })).code, 0, 'untracked com acento');
});
test('touches: rename para fora do glob ainda conta (frontend removido)', async () => {
    const repo = makeRepo('t2');
    git(repo, 'checkout', '-q', '-b', 'feat'); git(repo, 'mv', 'dashboard/public/app.js', 'lib/app.js'); git(repo, 'commit', '-q', '-m', 'mv');
    assert.strictEqual((await cli(['touches', 'main'], { REPO_PATH: repo })).code, 0);
});
test('touches: mudança na base depois do fork não conta (base...HEAD, não base..HEAD)', async () => {
    const repo = makeRepo('t2b');
    git(repo, 'checkout', '-q', '-b', 'feat'); fs.writeFileSync(path.join(repo, 'lib/y.js'), 'y'); git(repo, 'add', '-A'); git(repo, 'commit', '-q', '-m', 'feat');
    git(repo, 'checkout', '-q', 'main'); fs.writeFileSync(path.join(repo, 'dashboard/public/app.js'), 'main-change'); git(repo, 'commit', '-q', '-am', 'main avança');
    git(repo, 'checkout', '-q', 'feat');
    assert.strictEqual((await cli(['touches', 'main'], { REPO_PATH: repo })).code, 1);
});
test('touches: erro nunca vira "sem frontend" (exit 2)', async () => {
    const repo = makeRepo('t3');
    const bad = await cli(['touches', 'base-que-nao-existe'], { REPO_PATH: repo });
    assert.strictEqual(bad.code, 2); assert.ok(bad.err.length > 0); assert.strictEqual(bad.out, '');
    assert.strictEqual((await cli(['touches'], { REPO_PATH: repo })).code, 2, 'sem base');
    assert.strictEqual((await cli(['touches', 'main'], { REPO_PATH: work })).code, 2, 'fora de um repositório git');
});
test('touches: base que começa com "-" é recusada e não escreve arquivo (injeção de opção do git)', async () => {
    const repo = makeRepo('t3b'); const victim = path.join(work, 'pwned.txt');
    for (const base of [`--output=${victim}`, '-p', '--help']) {
        const r = await cli(['touches', base], { REPO_PATH: repo });
        assert.strictEqual(r.code, 2, base); assert.match(r.err, /base inválida/);
    }
    assert.strictEqual(fs.existsSync(victim), false); assert.strictEqual(fs.existsSync(`${victim}...HEAD`), false);
});
test('touches roda o git do checkout (REPO_PATH), não o da plataforma', async () => {
    const repo = makeRepo('t4'); fs.writeFileSync(path.join(repo, 'dashboard/public/app.js'), 'z');
    assert.strictEqual((await cli(['touches', 'main'], { REPO_PATH: repo, PRISMA_ROOT: path.join(__dirname, '../..') })).code, 0);
});
test('touches: REPO_PATH em subdiretório do repo git dá o mesmo resultado antes e depois do commit', async () => {
    const top = path.join(work, 't5'); const app = path.join(top, 'app');
    fs.mkdirSync(path.join(app, 'dashboard/public'), { recursive: true }); fs.writeFileSync(path.join(app, 'a.txt'), 'a');
    git(top, 'init', '-q', '-b', 'main'); git(top, 'add', '-A'); git(top, 'commit', '-q', '-m', 'base'); git(top, 'checkout', '-q', '-b', 'feat');
    fs.writeFileSync(path.join(app, 'dashboard/public/new.js'), 'n');
    assert.strictEqual((await cli(['touches', 'main'], { REPO_PATH: app })).code, 0, 'untracked');
    git(top, 'add', '-A'); git(top, 'commit', '-q', '-m', 'f');
    assert.strictEqual((await cli(['touches', 'main'], { REPO_PATH: app })).code, 0, 'commitado');
});
test('touches: fora da plataforma, sem PRISMA_UI_FRONTEND_GLOBS é erro (N/A silencioso); globs inválidos também', async () => {
    const repo = makeRepo('t6');
    const r = await main(['touches', 'main'], { REPO_PATH: repo }, capture());
    assert.strictEqual(r, 2);
    const io = capture();
    assert.strictEqual(await main(['touches', 'main'], { REPO_PATH: repo }, io), 2); assert.match(io.o.err.join(), /PRISMA_UI_FRONTEND_GLOBS/);
    for (const g of [' , ', '', 'web/**/*.{ts,tsx}', 'web/[ab].js', '!web/**']) {
        assert.strictEqual((await cli(['touches', 'main'], { REPO_PATH: repo, PRISMA_UI_FRONTEND_GLOBS: g })).code, 2, JSON.stringify(g));
    }
});

// ---------- verdict ----------
function session(repo, at = Date.now()) { fs.mkdirSync(path.join(repo, '.prisma/ui-state'), { recursive: true }); fs.writeFileSync(path.join(repo, '.prisma/ui-state/session.json'), JSON.stringify({ ensureAt: at })); }
function findingsDir(repo) { const d = path.join(repo, '.prisma/ui-verify/T-1'); fs.mkdirSync(d, { recursive: true }); return d; }
const goodFindings = shot => ({ screens: [{ ac: 'AC-1', url: 'http://127.0.0.1:3399/', screenshot: shot, console: [], requests: [{ url: '/x', status: 200 }], expected: [{ selector: 'Runs', found: true }] }] });
function frontendRepo(name) { const repo = makeRepo(name); fs.writeFileSync(path.join(repo, 'dashboard/public/app.js'), 'new'); session(repo); return repo; }
const vArgs = (f, acs = 'AC-1') => ['verdict', f, '--base', 'main', '--acs', acs];

test('verdict CLI: PASSOU com PNG real e relativo, grava verdict.json', async () => {
    const repo = frontendRepo('v1'); const dir = findingsDir(repo); const shot = path.join(dir, 'AC-1.png'); fs.writeFileSync(shot, PNG);
    const f = path.join(dir, 'findings.json'); const env = { REPO_PATH: repo, PRISMA_UI_VERIFY: 'on' };
    for (const p of [shot, path.relative(repo, shot)]) {
        fs.writeFileSync(f, JSON.stringify(goodFindings(p)));
        const ok = await cli(vArgs(f), env);
        assert.strictEqual(ok.code, 0, p); assert.match(ok.out, /Veredito: PASSOU/);
    }
    assert.strictEqual(JSON.parse(fs.readFileSync(path.join(dir, 'verdict.json'))).verdict, 'PASSOU');
});
test('verdict CLI: screenshot vazio, diretório, fora de ui-verify, symlink e não-PNG reprovam', async () => {
    const repo = frontendRepo('v1b'); const dir = findingsDir(repo); const f = path.join(dir, 'findings.json'); const env = { REPO_PATH: repo, PRISMA_UI_VERIFY: 'on' };
    fs.writeFileSync(path.join(dir, 'empty.png'), ''); fs.mkdirSync(path.join(dir, 'dir.png')); fs.writeFileSync(path.join(dir, 'fake.png'), 'não sou png');
    fs.writeFileSync(path.join(dir, 'real.png'), PNG); fs.symlinkSync(path.join(dir, 'real.png'), path.join(dir, 'link.png'));
    for (const p of [path.join(dir, 'empty.png'), path.join(dir, 'dir.png'), path.join(dir, 'fake.png'), path.join(dir, 'link.png'), path.join(dir, 'nao-existe.png'), path.join(repo, 'lib/x.js'), path.join(dir, '../../../lib/x.js')]) {
        fs.writeFileSync(f, JSON.stringify(goodFindings(p)));
        const r = await cli(vArgs(f), env);
        assert.strictEqual(r.code, 1, p); assert.match(r.out, /NO_SCREENSHOT/, p);
    }
});
test('verdict CLI: erros e UNKNOWN nunca deixam verdict.json antigo valer', async () => {
    const repo = frontendRepo('v2'); const dir = findingsDir(repo); const f = path.join(dir, 'findings.json'); const vj = path.join(dir, 'verdict.json');
    const env = { REPO_PATH: repo, PRISMA_UI_VERIFY: 'on' };
    const stale = () => fs.writeFileSync(vj, JSON.stringify({ verdict: 'PASSOU', problems: [] }));
    fs.writeFileSync(f, JSON.stringify(goodFindings('x')));
    for (const argv of [['verdict', f, '--base', 'nao-existe', '--acs', 'AC-1'], ['verdict', f, '--acs', 'AC-1'], ['verdict', f, '--base', 'main'], ['verdict', f, '--base', 'main', '--acs', ' ']]) {
        stale();
        const r = await cli(argv, env);
        assert.strictEqual(r.code, 2, argv.join(' ')); assert.ok(r.err.length > 0);
        assert.strictEqual(fs.existsSync(vj), false, `verdict.json removido: ${argv.join(' ')}`);
    }
    stale(); fs.writeFileSync(f, '{invalido');
    assert.strictEqual((await cli(vArgs(f), env)).code, 1);
    assert.strictEqual(JSON.parse(fs.readFileSync(vj)).verdict, 'FALHOU');
});
test('verdict CLI: flag off dá SKIPPED sem ler findings; valor inválido é erro, não SKIPPED', async () => {
    const repo = makeRepo('v3'); const f = path.join(findingsDir(repo), 'findings.json');
    const off = await cli(['verdict', f], { REPO_PATH: repo });
    assert.strictEqual(off.code, 0); assert.match(off.out, /SKIPPED/);
    for (const v of ['true', '1', 'yes', 'ONN']) assert.strictEqual((await cli(['verdict', f], { REPO_PATH: repo, PRISMA_UI_VERIFY: v })).code, 2, v);
});
test('verdict CLI: --base e --acs obrigatórios (com mensagem); --acs só aceita lista válida ou "none" exato', async () => {
    const repo = frontendRepo('v4'); const f = path.join(findingsDir(repo), 'findings.json'); fs.writeFileSync(f, JSON.stringify({ screens: [] })); const env = { REPO_PATH: repo, PRISMA_UI_VERIFY: 'on' };
    assert.match((await cli(['verdict', f, '--acs', 'AC-1'], env)).err, /exige --base/);
    assert.match((await cli(['verdict', f, '--base', 'main'], env)).err, /exige --acs/);
    for (const a of [' ', ',', ',,', 'none ', 'NONE', 'AC 1', 'AC-1,,AC-2', 'AC-1;rm']) assert.strictEqual((await cli(vArgs(f, a), env)).code, 2, JSON.stringify(a));
    const none = await cli(vArgs(f, 'none'), env);
    assert.strictEqual(none.code, 0); assert.match(none.out, /N\/A \(spec sem AC de UI\)/);
    assert.strictEqual((await cli(['verdict', path.join(repo, 'lib/x.js'), '--base', 'main', '--acs', 'AC-1'], env)).code, 2, 'findings fora de ui-verify');
});
test('verdict CLI: diff sem frontend dá N/A; frontend sem findings dá FALHOU (não N/A)', async () => {
    const repo = makeRepo('v5'); session(repo); const dir = findingsDir(repo); const f = path.join(dir, 'findings.json'); const env = { REPO_PATH: repo, PRISMA_UI_VERIFY: 'on' };
    fs.writeFileSync(f, JSON.stringify({ screens: [] }));
    const na = await cli(vArgs(f), env); assert.strictEqual(na.code, 0); assert.match(na.out, /N\/A \(diff sem frontend\)/);
    fs.writeFileSync(path.join(repo, 'dashboard/public/app.js'), 'novo'); fs.rmSync(f);
    const miss = await cli(vArgs(f), env); assert.strictEqual(miss.code, 1); assert.match(miss.out, /INVALID_FINDINGS/);
});
test('verdict CLI: evidência de rodada anterior e ausência de sessão reprovam', async () => {
    const repo = frontendRepo('v6'); const dir = findingsDir(repo); const shot = path.join(dir, 'a.png'); fs.writeFileSync(shot, PNG);
    const f = path.join(dir, 'findings.json'); fs.writeFileSync(f, JSON.stringify(goodFindings(shot))); const env = { REPO_PATH: repo, PRISMA_UI_VERIFY: 'on' };
    session(repo, Date.now() + 60000); // `server ensure` mais novo que os arquivos
    const stale = await cli(vArgs(f), env); assert.strictEqual(stale.code, 1); assert.match(stale.out, /STALE_EVIDENCE/);
    session(repo, Date.now() - 60000); // arquivos são mais novos: ok
    assert.strictEqual((await cli(vArgs(f), env)).code, 0);
    fs.utimesSync(shot, new Date(Date.now() - 600000), new Date(Date.now() - 600000)); // só o PNG é velho
    const oldPng = await cli(vArgs(f), env); assert.strictEqual(oldPng.code, 1); assert.match(oldPng.out, /NO_SCREENSHOT/);
    fs.rmSync(path.join(repo, '.prisma/ui-state/session.json'));
    const noSession = await cli(vArgs(f), env); assert.strictEqual(noSession.code, 1); assert.match(noSession.out, /sem sessão/);
});
test('cfg: porta, flag, glob e CWD inválidos; servidor customizado exige PRISMA_UI_CUSTOM_SERVER=1', async () => {
    const repo = makeRepo('c1');
    assert.throws(() => cfg({ REPO_PATH: repo, PRISMA_UI_SERVER_CWD: '/etc' }), /fora da plataforma/);
    for (const p of ['abc', '1;x', '1', '999999']) assert.throws(() => cfg({ REPO_PATH: repo, PRISMA_UI_PORT: p }), /PRISMA_UI_PORT/, p);
    assert.throws(() => cfg({ REPO_PATH: repo, PRISMA_UI_TERM_WAIT_MS: 'x' }), /PRISMA_UI_TERM_WAIT_MS/);
    const io = capture();
    assert.strictEqual(await main(['server', 'ensure'], { REPO_PATH: repo, PRISMA_UI_SERVER_CMD: 'node fake.js', PRISMA_UI_SERVER_CWD: repo }, io), 2);
    assert.match(io.o.err.join(), /PRISMA_UI_CUSTOM_SERVER=1/);
});

// ---------- servidor ----------
test('servidor: ensure sobe, segundo ensure reaproveita o MESMO, stop libera a porta e limpa tmp; stop repetido é inofensivo', async () => {
    const repo = makeRepo('s1'); const port = await freePort(); const c = cfg(envFor(repo, port)); const before = leftovers();
    const a = await serverEnsure(c, 15000);
    assert.ok(a.startedByUs && alive(a.pid));
    const b = await serverEnsure(c, 15000);
    assert.deepStrictEqual([b.pid, b.reused], [a.pid, true], 'não perde a posse nem sobe outro');
    const s = await serverStop(c);
    assert.deepStrictEqual([s.stopped, s.pid], [true, a.pid]);
    assert.strictEqual(await probe(c.url), false, 'porta livre depois do stop'); assert.strictEqual(alive(a.pid), false);
    assert.strictEqual(leftovers(), before, 'home e fixture removidos');
    assert.deepStrictEqual((await serverStop(c)).reason, 'sem estado');
    assert.ok(Number.isFinite(JSON.parse(fs.readFileSync(path.join(c.stateDir, 'session.json'))).ensureAt), 'sessão marcada');
});
test('servidor: estado do CLI fica em .prisma/ui-state, fora da área que o navegador escreve', async () => {
    const repo = makeRepo('s1b'); const port = await freePort(); const c = cfg(envFor(repo, port));
    await serverEnsure(c, 15000);
    try {
        assert.ok(fs.existsSync(path.join(repo, '.prisma/ui-state/server.json')));
        assert.deepStrictEqual(fs.readdirSync(path.join(repo, '.prisma')).filter(n => n === 'ui-verify' && fs.existsSync(path.join(repo, '.prisma/ui-verify/server.json'))), []);
    } finally { await serverStop(c); }
});
test('servidor: dois ensure simultâneos terminam com um servidor vivo e um stop o encerra', async () => {
    const repo = makeRepo('s2'); const port = await freePort(); const c = cfg(envFor(repo, port));
    const [a, b] = await Promise.all([serverEnsure(c, 15000), serverEnsure(c, 15000)]);
    assert.strictEqual(a.pid, b.pid); assert.ok(alive(a.pid));
    assert.strictEqual((await serverStop(c)).stopped, true); assert.strictEqual(await probe(c.url), false);
});
test('servidor: o dashboard real sobe somente leitura, com fixture e sem efeitos colaterais de GET', async () => {
    const repo = makeRepo('s3'); const port = await freePort();
    const c = cfg({ REPO_PATH: repo, PRISMA_UI_VERIFY: 'on', PRISMA_UI_PORT: String(port) });
    await serverEnsure(c, 60000);
    try {
        const call = (method, p = '/api/validate-config') => new Promise((res, rej) => {
            const q = http.request({ host: '127.0.0.1', port, path: p, method, headers: { Host: `localhost:${port}`, Origin: `http://localhost:${port}`, 'Sec-Fetch-Site': 'same-origin' } }, s => { s.resume(); res(s.statusCode); });
            q.on('error', rej); q.end();
        });
        assert.strictEqual(await call('GET'), 200, 'fixture traz o contrato; leitura funciona');
        for (const m of ['POST', 'PUT', 'PATCH', 'DELETE']) assert.strictEqual(await call(m), 403, m);
        assert.deepStrictEqual(await getJson(port, '/api/claude/usage?refresh=1'), { ok: false, error: 'somente leitura', cached: false }, 'stub, não roda claude -p');
        assert.notStrictEqual(stateOf(c).fixture, repo, 'REPO_PATH do servidor não é o checkout');
    } finally { await serverStop(c); }
});
test('servidor: env mínimo, loopback e sem credenciais herdadas; REPO_PATH é a fixture', async () => {
    const repo = makeRepo('s3b'); const port = await freePort(); const c = cfg(envFor(repo, port));
    process.env.REDMINE_API_KEY = 'segredo-nao-vaza'; process.env.NODE_OPTIONS = '--max-old-space-size=512';
    try {
        await serverEnsure(c, 15000);
        const { env, cwd } = await getJson(port);
        assert.strictEqual(JSON.stringify(env).includes('segredo-nao-vaza'), false, 'credencial não herdada');
        assert.strictEqual(env.NODE_OPTIONS, undefined);
        assert.strictEqual(env.HOST, '127.0.0.1'); assert.strictEqual(env.PRISMA_DASHBOARD_READONLY, '1');
        assert.match(path.basename(env.HOME), /^ui-verify-home-/); assert.match(path.basename(env.REPO_PATH), /^ui-verify-fixture-/);
        assert.strictEqual(cwd, fs.realpathSync(repo));
        assert.ok(fs.existsSync(path.join(env.REPO_PATH, '.claude/config-contract.json')), 'fixture com o contrato');
        assert.strictEqual(fs.existsSync(path.join(env.REPO_PATH, '.env')), false);
    } finally { delete process.env.REDMINE_API_KEY; delete process.env.NODE_OPTIONS; await stopQuiet(c); }
});
test('servidor: porta de terceiros é recusada (PORT_IN_USE) e o stop não a mata', async () => {
    const repo = makeRepo('s4'); const port = await freePort(); const c = cfg(envFor(repo, port));
    const foreign = http.createServer((q, s) => s.end('x')).listen(port, '127.0.0.1'); await new Promise(r => foreign.on('listening', r));
    try {
        await assert.rejects(serverEnsure(c, 5000), e => e.code === 'PORT_IN_USE');
        assert.strictEqual((await serverStop(c)).stopped, false); assert.strictEqual(await probe(c.url), true, 'o servidor alheio segue no ar');
    } finally { foreign.close(); }
});
test('servidor: PID reciclado + servidor de terceiros na porta NÃO é reaproveitado (PORT_IN_USE)', async () => {
    const repo = makeRepo('s4b'); const port = await freePort(); const c = cfg(envFor(repo, port));
    const a = await serverEnsure(c, 15000); const info = stateOf(c);
    process.kill(-a.pid, 'SIGKILL'); await new Promise(r => setTimeout(r, 300));
    const other = spawn('sleep', ['60']); // vivo, mas não é líder de grupo nem tem o lstart gravado
    const foreign = http.createServer((q, s) => s.end('x')).listen(port, '127.0.0.1'); await new Promise(r => foreign.on('listening', r));
    fs.writeFileSync(path.join(c.stateDir, 'server.json'), JSON.stringify({ ...info, pid: other.pid }));
    try {
        await assert.rejects(serverEnsure(c, 5000), e => e.code === 'PORT_IN_USE');
        assert.ok(alive(other.pid), 'o processo reciclado não foi morto'); assert.strictEqual(await probe(c.url), true);
    } finally { foreign.close(); other.kill('SIGKILL'); fs.rmSync(path.join(c.stateDir, 'server.json'), { force: true }); }
});
test('servidor: líder de grupo vivo com lstart diferente + servidor de terceiros também NÃO é reaproveitado', async () => {
    const repo = makeRepo('s4b2'); const port = await freePort(); const c = cfg(envFor(repo, port));
    const a = await serverEnsure(c, 15000); const info = stateOf(c);
    process.kill(-a.pid, 'SIGKILL'); await new Promise(r => setTimeout(r, 300));
    const leader = spawn('sleep', ['60'], { detached: true }); // líder do próprio grupo (pgid == pid), mas outro processo
    const foreign = http.createServer((q, s) => s.end('x')).listen(port, '127.0.0.1'); await new Promise(r => foreign.on('listening', r));
    // lstart tem resolução de 1 s: o registro guarda um horário claramente diferente do do líder atual.
    fs.writeFileSync(path.join(c.stateDir, 'server.json'), JSON.stringify({ ...info, pid: leader.pid, lstart: 'Mon Jan  1 00:00:00 2001' }));
    try {
        await assert.rejects(serverEnsure(c, 5000), e => e.code === 'PORT_IN_USE');
        assert.ok(alive(leader.pid), 'o líder reciclado não foi morto'); assert.strictEqual(await probe(c.url), true);
    } finally { foreign.close(); try { process.kill(-leader.pid, 'SIGKILL'); } catch { /* ok */ } fs.rmSync(path.join(c.stateDir, 'server.json'), { force: true }); }
});
test('servidor: código do servidor mudou ⇒ ensure reinicia (não serve código velho)', async () => {
    const repo = makeRepo('s4c'); const port = await freePort(); const c = cfg(envFor(repo, port));
    const a = await serverEnsure(c, 15000);
    try {
        fs.writeFileSync(path.join(repo, 'fake-novo.js'), 'novo');
        const b = await serverEnsure(c, 15000);
        assert.notStrictEqual(b.pid, a.pid); assert.ok(!b.reused); assert.strictEqual(alive(a.pid), false, 'o velho foi encerrado');
    } finally { await serverStop(c); }
});
test('servidor: registro velho (processo morto) é limpo e um servidor novo sobe', async () => {
    const repo = makeRepo('s4d'); const port = await freePort(); const c = cfg(envFor(repo, port)); const before = leftovers();
    const a = await serverEnsure(c, 15000); const old = stateOf(c);
    process.kill(-a.pid, 'SIGKILL'); await new Promise(r => setTimeout(r, 300));
    const b = await serverEnsure(c, 15000);
    try { assert.notStrictEqual(b.pid, a.pid); assert.strictEqual(fs.existsSync(old.home), false); assert.strictEqual(fs.existsSync(old.fixture), false); } finally { await serverStop(c); }
    assert.strictEqual(leftovers(), before);
});
test('servidor: comando inexistente, cwd inexistente, vazio e lista JSON inválida falham com mensagem, sem estado nem tmp vazado', async () => {
    const repo = makeRepo('s5'); const port = await freePort(); const before = leftovers();
    for (const extra of [{ PRISMA_UI_SERVER_CMD: 'comando-que-nao-existe --x' }, { PRISMA_UI_SERVER_CWD: path.join(repo, 'nao-existe') }]) {
        const c = cfg(envFor(repo, port, extra));
        const t = Date.now();
        await assert.rejects(serverEnsure(c, 20000), /não consegui iniciar/, JSON.stringify(extra));
        assert.ok(Date.now() - t < 5000, 'falha de spawn é rápida, não é o timeout');
        assert.strictEqual(fs.existsSync(path.join(c.stateDir, 'server.json')), false);
    }
    for (const cmd of ['   ', '[', '[]', '[1]', '[""]']) await assert.rejects(serverEnsure(cfg(envFor(repo, port, { PRISMA_UI_SERVER_CMD: cmd })), 3000), /vazio|inválido|lista JSON/, cmd);
    assert.strictEqual(leftovers(), before);
});
test('servidor: comando como lista JSON aceita caminho com espaço', async () => {
    const repo = makeRepo('s5b'); const port = await freePort(); const dir = path.join(repo, 'com espaço'); fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'srv.js'), FAKE);
    const c = cfg(envFor(repo, port, { PRISMA_UI_SERVER_CMD: JSON.stringify([process.execPath, path.join(dir, 'srv.js')]) }));
    await serverEnsure(c, 15000); try { assert.strictEqual(await probe(c.url), true); } finally { await serverStop(c); }
});
test('servidor: falha ao montar a fixture não vaza home', async () => {
    const repo = makeRepo('s5c'); const port = await freePort(); const empty = path.join(work, 'plataforma-vazia'); fs.mkdirSync(empty); const before = leftovers();
    const c = cfg(envFor(repo, port, { PRISMA_ROOT: empty }));
    await assert.rejects(serverEnsure(c, 3000), /asset do fixture ausente/); assert.strictEqual(leftovers(), before);
});
test('servidor: que sai com erro falha rápido; que trava dá timeout e é encerrado', async () => {
    const repo = makeRepo('s6'); const port = await freePort(); const before = leftovers();
    fs.writeFileSync(path.join(repo, 'exit1.js'), "console.error('boom'); process.exit(1)"); fs.writeFileSync(path.join(repo, 'hang.js'), 'setInterval(()=>{},1000)');
    let t = Date.now();
    await assert.rejects(serverEnsure(cfg(envFor(repo, port, { PRISMA_UI_SERVER_CMD: 'node exit1.js' })), 20000), /não respondeu/);
    assert.ok(Date.now() - t < 5000, 'falha rápida, não espera o timeout');
    const c = cfg(envFor(repo, port, { PRISMA_UI_SERVER_CMD: 'node hang.js' })); t = Date.now();
    await assert.rejects(serverEnsure(c, 1500), /não respondeu/); assert.ok(Date.now() - t >= 1400);
    assert.match(fs.readFileSync(path.join(c.stateDir, 'server.log'), 'utf8'), /^$|./, 'log existe');
    assert.strictEqual(fs.existsSync(path.join(c.stateDir, 'server.json')), false); assert.strictEqual(leftovers(), before);
});
test('stop: servidor que ignora SIGTERM e tem processo filho (mesmo grupo) é encerrado por SIGKILL, sem órfão', async () => {
    const repo = makeRepo('s6b'); const port = await freePort();
    fs.writeFileSync(path.join(repo, 'child.js'), `process.on('SIGTERM',()=>{});${FAKE}`);
    fs.writeFileSync(path.join(repo, 'wrapper.js'), "process.on('SIGTERM',()=>{});require('child_process').spawn(process.execPath,['child.js'],{stdio:'inherit'});setInterval(()=>{},1000);");
    const c = cfg(envFor(repo, port, { PRISMA_UI_SERVER_CMD: 'node wrapper.js', PRISMA_UI_TERM_WAIT_MS: '500' }));
    const a = await serverEnsure(c, 15000); const t = Date.now();
    const r = await serverStop(c);
    assert.deepStrictEqual([r.stopped, r.pid], [true, a.pid]); assert.ok(Date.now() - t < 6000);
    assert.strictEqual(await probe(c.url), false, 'o filho que escutava a porta morreu'); assert.strictEqual(alive(a.pid), false);
});
test('stop: se o kill falha, o registro e a posse são mantidos (nada apagado) e um stop posterior encerra', async () => {
    const repo = makeRepo('s6c'); const port = await freePort(); const c = cfg(envFor(repo, port, { PRISMA_UI_TERM_WAIT_MS: '200' }));
    const a = await serverEnsure(c, 15000); const info = stateOf(c); const orig = process.kill;
    process.kill = (pid, sig) => (sig === 'SIGTERM' || sig === 'SIGKILL' ? true : orig.call(process, pid, sig));
    let r; try { r = await serverStop(c); } finally { process.kill = orig; }
    try {
        assert.deepStrictEqual([r.stopped, r.reason], [false, 'processo não encerrou']);
        assert.ok(fs.existsSync(path.join(c.stateDir, 'server.json')) && fs.existsSync(info.home) && fs.existsSync(info.fixture), 'registro e dirs mantidos');
        assert.ok(alive(a.pid));
    } finally { assert.strictEqual((await serverStop(c)).stopped, true); }
    assert.strictEqual(alive(a.pid), false); assert.strictEqual(fs.existsSync(info.home), false);
});
test('stop: sem ps não declara parado um processo vivo (registro mantido) e funciona quando o ps volta', async () => {
    const repo = makeRepo('s6d'); const port = await freePort(); const c = cfg(envFor(repo, port));
    const a = await serverEnsure(c, 15000); const path0 = process.env.PATH; const empty = path.join(work, 'sem-ps'); fs.mkdirSync(empty);
    process.env.PATH = empty; let r; try { r = await serverStop(c); } finally { process.env.PATH = path0; }
    assert.strictEqual(r.stopped, false); assert.match(r.reason, /ps indisponível/); assert.ok(alive(a.pid) && fs.existsSync(path.join(c.stateDir, 'server.json')));
    assert.strictEqual((await serverStop(c)).stopped, true); assert.strictEqual(alive(a.pid), false);
});
test('stop: TMPDIR diferente entre ensure e stop não perde a posse (posse por token, não por caminho)', async () => {
    const repo = makeRepo('s6e'); const port = await freePort(); const c = cfg(envFor(repo, port)); const other = path.join(work, 'outro-tmp'); fs.mkdirSync(other);
    const a = await serverEnsure(c, 15000); const info = stateOf(c);
    process.env.TMPDIR = other; let r; try { r = await serverStop(c); } finally { process.env.TMPDIR = tmproot; }
    assert.deepStrictEqual([r.stopped, r.pid], [true, a.pid]); assert.strictEqual(await probe(c.url), false);
    assert.strictEqual(fs.existsSync(info.home), false); assert.strictEqual(fs.existsSync(info.fixture), false);
});
function ownedDir(prefix, token) { const d = fs.mkdtempSync(path.join(tmproot, prefix)); fs.writeFileSync(path.join(d, '.ui-verify-owner'), token); return d; }
test('stop: registro adulterado (pid 1/0/-1/1.5/"12"/true, sem lstart, sem token) nunca chama kill nem apaga', async () => {
    const repo = makeRepo('s7'); const c = cfg(envFor(repo, await freePort())); fs.mkdirSync(c.stateDir, { recursive: true });
    const home = ownedDir('ui-verify-home-', 'tok'); const fixture = ownedDir('ui-verify-fixture-', 'tok'); const orig = process.kill; const calls = [];
    process.kill = (pid, sig) => { calls.push([pid, sig]); throw new Error('kill não deveria ser chamado'); };
    try {
        const base = { startedByUs: true, port: '3399', lstart: 'Mon Jan  1 00:00:00 2001', token: 'tok', home, fixture };
        for (const bad of [{ pid: 1 }, { pid: 0 }, { pid: -1 }, { pid: 1.5 }, { pid: '12' }, { pid: true }, { pid: 4242, lstart: undefined }, { pid: 4242, token: undefined }, { pid: 4242, port: '3;x' }]) {
            fs.writeFileSync(path.join(c.stateDir, 'server.json'), JSON.stringify({ ...base, ...bad }));
            const r = await serverStop(c);
            assert.strictEqual(r.stopped, false, JSON.stringify(bad)); assert.match(r.reason, /inválido|adulterado/);
            assert.ok(fs.existsSync(home) && fs.existsSync(fixture) && fs.existsSync(path.join(c.stateDir, 'server.json')), 'nada apagado, registro mantido');
        }
    } finally { process.kill = orig; }
    assert.deepStrictEqual(calls, []);
});
test('stop: home/fixture sem token certo, com symlink ou fora do prefixo nunca são apagados', async () => {
    const repo = makeRepo('s7b'); const c = cfg(envFor(repo, await freePort())); fs.mkdirSync(c.stateDir, { recursive: true });
    const victim = fs.mkdtempSync(path.join(work, 'vitima-')); fs.writeFileSync(path.join(victim, 'f'), 'x');
    const good = ownedDir('ui-verify-fixture-', 'tok'); const link = path.join(tmproot, 'ui-verify-home-link'); fs.symlinkSync(victim, link);
    const wrongPrefix = ownedDir('qualquer-', 'tok'); const wrongToken = ownedDir('ui-verify-home-', 'outro');
    const realOwned = ownedDir('ui-verify-home-real-', 'tok'); const linkToOwned = path.join(tmproot, 'ui-verify-home-link2'); fs.symlinkSync(realOwned, linkToOwned);
    for (const home of [victim, link, wrongPrefix, wrongToken, linkToOwned, '/']) {
        fs.writeFileSync(path.join(c.stateDir, 'server.json'), JSON.stringify({ startedByUs: true, pid: process.pid, port: '3399', lstart: 'x', token: 'tok', home, fixture: good }));
        const r = await serverStop(c); assert.strictEqual(r.stopped, false, home);
        assert.ok(fs.existsSync(path.join(victim, 'f')) && alive(process.pid), 'nada apagado nem morto');
        assert.ok(fs.existsSync(home) && fs.existsSync(good) && fs.existsSync(path.join(c.stateDir, 'server.json')), `nada apagado: ${home}`);
    }
    assert.ok(fs.lstatSync(linkToOwned).isSymbolicLink() && fs.existsSync(realOwned));
});
test('stop: processo já morto é alreadyExited e limpa o tmp; PID reaproveitado (lstart diferente) não é encerrado', async () => {
    const repo = makeRepo('s8'); const port = await freePort(); const c = cfg(envFor(repo, port)); const before = leftovers();
    const a = await serverEnsure(c, 15000); process.kill(-a.pid, 'SIGKILL');
    for (let i = 0; i < 50 && alive(a.pid); i++) await new Promise(r => setTimeout(r, 100));
    const r = await serverStop(c); assert.deepStrictEqual([r.stopped, r.alreadyExited], [true, true]); assert.strictEqual(leftovers(), before);
    const b = await serverEnsure(c, 15000);
    try {
        fs.writeFileSync(path.join(c.stateDir, 'server.json'), JSON.stringify({ ...stateOf(c), lstart: 'Mon Jan  1 00:00:00 2001' }));
        const r2 = await serverStop(c); assert.strictEqual(r2.stopped, false); assert.match(r2.reason, /reaproveitado/); assert.ok(alive(b.pid), 'processo não foi morto');
        assert.strictEqual(leftovers(), before, 'dirs do registro velho limpos');
    } finally { try { process.kill(-b.pid, 'SIGKILL'); } catch { /* ok */ } }
});
test('lock: lock recente de outro processo faz o ensure falhar com mensagem; lock antigo é retomado', async () => {
    const repo = makeRepo('s9'); const port = await freePort(); const c = cfg(envFor(repo, port, { PRISMA_UI_LOCK_WAIT_MS: '300' }));
    fs.mkdirSync(path.join(c.stateDir, 'server.lock'), { recursive: true });
    await assert.rejects(serverEnsure(c, 5000), /em andamento/);
    const old = new Date(Date.now() - 600000); fs.utimesSync(path.join(c.stateDir, 'server.lock'), old, old);
    await serverEnsure(c, 15000); await serverStop(c);
});
test('ensure sem stop anterior deixa a porta liberável por um stop de outra chamada (CLI main)', async () => {
    const repo = makeRepo('s10'); const port = await freePort(); const env = envFor(repo, port);
    const e = await cli(['server', 'ensure'], env); assert.strictEqual(e.code, 0); assert.strictEqual(JSON.parse(e.out).startedByUs, true);
    const s = await cli(['server', 'stop'], env); assert.strictEqual(s.code, 0); assert.strictEqual(JSON.parse(s.out).stopped, true);
    assert.strictEqual(await probe(`http://127.0.0.1:${port}`), false);
});

test.after(() => fs.rmSync(work, { recursive: true, force: true }));
