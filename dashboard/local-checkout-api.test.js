// node --test local-checkout-api.test.js
// "Usar na minha máquina" contra repos git reais e sintéticos em tmp (nunca os do usuário).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { createLocalCheckout } = require('../scripts/local-checkout');
const { createDashboard } = require('./server');

const tmpBase = process.env.CLAUDE_JOB_DIR ? path.join(process.env.CLAUDE_JOB_DIR, 'tmp') : os.tmpdir();
fs.mkdirSync(tmpBase, { recursive: true });
const tmp = fs.mkdtempSync(path.join(tmpBase, 'local-checkout-'));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const git = (dir, ...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const head = dir => git(dir, 'rev-parse', 'HEAD');
const branch = dir => { try { return git(dir, 'symbolic-ref', '-q', '--short', 'HEAD'); } catch { return ''; } };
const write = (dir, f, c) => fs.writeFileSync(path.join(dir, f), c);
const read = (dir, f) => fs.readFileSync(path.join(dir, f), 'utf8');

let seq = 0;
// Cria um ambiente isolado: um repo principal por key (branch master + branch "other"),
// worktrees em <env>/wts e state file próprio. Nada aponta pra fora do tmp.
function makeEnv(keys) {
    const root = path.join(tmp, `env${++seq}`);
    const wts = path.join(root, 'wts');
    fs.mkdirSync(wts, { recursive: true });
    const env = { root, wts, stateFile: path.join(root, 'state.json'), main: {}, wt: {} };
    for (const key of keys) {
        const dir = path.join(root, key);
        fs.mkdirSync(dir);
        git(dir, 'init', '-q', '-b', 'master');
        git(dir, 'config', 'user.name', 'Teste');
        git(dir, 'config', 'user.email', 'teste@example.com');
        git(dir, 'config', 'commit.gpgsign', 'false');
        write(dir, 'file.txt', 'base\n');
        write(dir, 'other.txt', 'base\n');
        git(dir, 'add', '.');
        git(dir, 'commit', '-q', '-m', 'init');
        git(dir, 'branch', 'other');
        env.main[key] = dir;
    }
    env.repos = keys.map(key => ({ key, main: env.main[key], worktrees: t => [path.join(wts, `${t}-${key}`)] }));
    env.lc = () => createLocalCheckout({ repoRoot: root, worktreesDir: wts, stateFile: env.stateFile, repos: env.repos });
    // worktree do ticket num repo, com um commit que altera file.txt.
    env.addWorktree = (key, ticket, content = `ticket ${ticket}\n`) => {
        const p = path.join(wts, `${ticket}-${key}`);
        git(env.main[key], 'worktree', 'add', '-q', '-b', `t/${ticket}-${key}`, p);
        git(p, 'config', 'user.name', 'Teste');
        git(p, 'config', 'user.email', 'teste@example.com');
        write(p, 'file.txt', content);
        git(p, 'commit', '-q', '-am', `ticket ${ticket}`);
        env.wt[`${ticket}-${key}`] = p;
        return p;
    };
    return env;
}

test('AC1: use põe repos com worktree no HEAD do worktree (detached), grava previous; repo sem worktree fica em skipped', async () => {
    const env = makeEnv(['a', 'b', 'c']);
    const wa = env.addWorktree('a', '100');
    const wb = env.addWorktree('b', '100');
    const cBefore = head(env.main.c);
    const r = await env.lc().use('100');
    assert.strictEqual(r.ok, true);
    for (const [k, w] of [['a', wa], ['b', wb]]) {
        assert.strictEqual(branch(env.main[k]), '', `${k} detached`);
        assert.strictEqual(head(env.main[k]), head(w));
        assert.deepStrictEqual(r.active.repos[k].previous, { type: 'branch', ref: 'master' });
        assert.strictEqual(r.active.repos[k].sha, head(w));
        assert.strictEqual(read(env.main[k], 'file.txt'), 'ticket 100\n');
    }
    assert.deepStrictEqual(r.skipped, ['c']);
    assert.strictEqual(branch(env.main.c), 'master');
    assert.strictEqual(head(env.main.c), cBefore);
    assert.ok(!r.active.repos.c);
    assert.ok(fs.existsSync(env.stateFile));
});

test('AC2: restore volta cada repo à branch anterior e apaga o estado', async () => {
    const env = makeEnv(['a', 'b']);
    env.addWorktree('a', '100');
    env.addWorktree('b', '100');
    git(env.main.b, 'switch', '-q', 'other'); // previous de b é "other"
    const lc = env.lc();
    await lc.use('100');
    const r = await lc.restore();
    assert.strictEqual(r.ok, true);
    assert.deepStrictEqual(r.results.map(x => [x.key, x.ok]), [['a', true], ['b', true]]);
    assert.strictEqual(branch(env.main.a), 'master');
    assert.strictEqual(branch(env.main.b), 'other');
    assert.strictEqual(fs.existsSync(env.stateFile), false);
    assert.strictEqual((await lc.status()).active, null);
});

test('restore sem estado: 404', async () => {
    const env = makeEnv(['a']);
    await assert.rejects(env.lc().restore(), e => e.status === 404);
});

test('AC3: conflito no 2º repo -> 409, 1º volta pra branch anterior (rollback), estado não gravado', async () => {
    const env = makeEnv(['a', 'b']);
    env.addWorktree('a', '100');
    env.addWorktree('b', '100');
    write(env.main.b, 'file.txt', 'alteração local conflitante\n'); // file.txt difere no commit do ticket
    const aBefore = head(env.main.a);
    await assert.rejects(env.lc().use('100'), e => {
        assert.strictEqual(e.status, 409);
        assert.strictEqual(e.repo, 'b');
        assert.deepStrictEqual(e.rollbackErrors, []);
        return true;
    });
    assert.strictEqual(branch(env.main.a), 'master');
    assert.strictEqual(head(env.main.a), aBefore);
    assert.strictEqual(branch(env.main.b), 'master');
    assert.strictEqual(read(env.main.b, 'file.txt'), 'alteração local conflitante\n');
    assert.strictEqual(fs.existsSync(env.stateFile), false);
});

test('AC4: alteração local que não conflita é preservada após use', async () => {
    const env = makeEnv(['a']);
    env.addWorktree('a', '100');
    write(env.main.a, 'other.txt', 'minha alteração\n'); // ticket não toca other.txt
    write(env.main.a, 'novo-untracked.txt', 'x\n');
    const r = await env.lc().use('100');
    assert.strictEqual(r.ok, true);
    assert.strictEqual(read(env.main.a, 'other.txt'), 'minha alteração\n');
    assert.strictEqual(read(env.main.a, 'novo-untracked.txt'), 'x\n');
    assert.strictEqual(read(env.main.a, 'file.txt'), 'ticket 100\n');
});

test('AC5: worktree do ticket com alteração não commitada gera warning', async () => {
    const env = makeEnv(['a', 'b']);
    const wa = env.addWorktree('a', '100');
    env.addWorktree('b', '100');
    write(wa, 'file.txt', 'sujo, não commitado\n');
    const r = await env.lc().use('100');
    assert.strictEqual(r.warnings.length, 1);
    assert.match(r.warnings[0], /^a: .*não commitada/);
    assert.strictEqual(read(env.main.a, 'file.txt'), 'ticket 100\n'); // a alteração não veio
});

test('AC6: estado sobrevive a nova instância (mesmo stateFile)', async () => {
    const env = makeEnv(['a']);
    env.addWorktree('a', '100');
    const r = await env.lc().use('100');
    const st = await env.lc().status();
    assert.strictEqual(st.active.ticket, '100');
    assert.deepStrictEqual(st.active.repos.a, r.active.repos.a);
    const rr = await env.lc().restore();
    assert.strictEqual(rr.ok, true);
    assert.strictEqual(branch(env.main.a), 'master');
});

test('status com ticket lista repos, worktree, sha e dirty', async () => {
    const env = makeEnv(['a', 'b']);
    const wa = env.addWorktree('a', '100');
    write(wa, 'file.txt', 'sujo\n');
    const st = await env.lc().status('100');
    assert.strictEqual(st.active, null);
    const [a, b] = st.repos;
    assert.strictEqual(a.available, true);
    assert.strictEqual(a.dirty, true);
    assert.strictEqual(a.worktree, wa);
    assert.strictEqual(a.sha, head(wa));
    assert.strictEqual(b.available, false);
    assert.strictEqual(b.worktree, null);
    await assert.rejects(env.lc().status('a..b'), e => e.status === 400);
});

test('troca A->B mantém o previous original; repo só de A volta pra ref original', async () => {
    const env = makeEnv(['a', 'b']);
    env.addWorktree('a', '100', 'A\n');
    env.addWorktree('b', '100', 'A\n');
    const wa2 = env.addWorktree('a', '200', 'B\n');
    const lc = env.lc();
    const first = await lc.use('100');
    const bShaA = first.active.repos.b.sha;
    assert.strictEqual(head(env.main.b), bShaA);
    const r = await lc.use('200');
    assert.strictEqual(r.active.ticket, '200');
    assert.deepStrictEqual(r.active.repos.a.previous, { type: 'branch', ref: 'master' });
    assert.strictEqual(head(env.main.a), head(wa2));
    assert.strictEqual(branch(env.main.a), '');
    assert.ok(!r.active.repos.b);
    assert.strictEqual(branch(env.main.b), 'master'); // b voltou
    assert.deepStrictEqual(r.skipped, ['b']);
    const st = await lc.status();
    assert.deepStrictEqual(Object.keys(st.active.repos), ['a']);
    await lc.restore();
    assert.strictEqual(branch(env.main.a), 'master');
    assert.strictEqual(fs.existsSync(env.stateFile), false);
});

test('restore com HEAD mudado à mão (git switch) -> skipped, não mexe', async () => {
    const env = makeEnv(['a', 'b']);
    env.addWorktree('a', '100');
    env.addWorktree('b', '100');
    const lc = env.lc();
    await lc.use('100');
    git(env.main.a, 'switch', '-q', 'other');
    const r = await lc.restore();
    const byKey = Object.fromEntries(r.results.map(x => [x.key, x]));
    assert.strictEqual(byKey.a.skipped, true);
    assert.strictEqual(byKey.a.ok, false);
    assert.match(byKey.a.message, /HEAD mudou/);
    assert.strictEqual(branch(env.main.a), 'other'); // intocado
    assert.strictEqual(byKey.b.ok, true);
    assert.strictEqual(branch(env.main.b), 'master');
});

test('use de novo no mesmo ticket após commit à mão em detached -> não retroca, warning', async () => {
    const env = makeEnv(['a']);
    env.addWorktree('a', '100');
    const lc = env.lc();
    const first = await lc.use('100');
    git(env.main.a, 'config', 'user.name', 'Teste');
    git(env.main.a, 'commit', '-q', '--allow-empty', '-m', 'commit à mão em detached');
    const manual = head(env.main.a);
    assert.notStrictEqual(manual, first.active.repos.a.sha);
    const r = await lc.use('100');
    assert.strictEqual(head(env.main.a), manual);
    assert.strictEqual(branch(env.main.a), '');
    assert.ok(r.warnings.some(w => /^a: HEAD mudou/.test(w)));
    assert.deepStrictEqual(r.active.repos.a, first.active.repos.a); // entrada anterior mantida
    assert.deepStrictEqual(r.active.repos.a.previous, { type: 'branch', ref: 'master' });
});

test('ticketId inválido -> 400 e sem worktree -> 404 (lib)', async () => {
    const env = makeEnv(['a']);
    const lc = env.lc();
    for (const bad of ['a..b', '../x', '', '-x', 'a/b']) {
        await assert.rejects(lc.use(bad), e => e.status === 400, `use(${bad})`);
    }
    await assert.rejects(lc.use('999'), e => e.status === 404);
});

test('use concorrente: segunda chamada recebe 409 (busy)', async () => {
    const env = makeEnv(['a']);
    env.addWorktree('a', '100');
    const lc = env.lc();
    const [x, y] = await Promise.allSettled([lc.use('100'), lc.use('100')]);
    assert.strictEqual(x.status, 'fulfilled');
    assert.strictEqual(y.status, 'rejected');
    assert.strictEqual(y.reason.status, 409);
});

// ---- HTTP ----
test('rotas HTTP: status, use, restore, 400 e 404', async t => {
    const env = makeEnv(['a', 'b']);
    env.addWorktree('a', '100');
    fs.mkdirSync(path.join(tmp, 'memory-http'), { recursive: true });
    const dash = createDashboard({
        memoryDir: path.join(tmp, 'memory-http'), worktreesDir: env.wts,
        prefsFile: path.join(env.root, 'prefs.json'), localCheckout: env.lc(),
    });
    await new Promise(r => dash.server.listen(0, '127.0.0.1', r));
    await dash.ready;
    t.after(() => dash.close());
    const base = `http://localhost:${dash.server.address().port}`;
    const call = async (method, p) => { const res = await fetch(base + p, { method }); return { status: res.status, body: await res.json() }; };

    let r = await call('GET', '/api/local-checkout?ticket=100');
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.active, null);
    assert.deepStrictEqual(r.body.repos.map(x => [x.key, x.available]), [['a', true], ['b', false]]);

    r = await call('GET', '/api/local-checkout');
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.repos, undefined);

    r = await call('GET', '/api/local-checkout?ticket=a..b');
    assert.strictEqual(r.status, 400);

    for (const bad of ['..%2Fx', 'a..b']) {
        r = await call('POST', `/api/local-checkout/${bad}/use`);
        assert.strictEqual(r.status, 400, bad);
        assert.ok(r.body.error);
    }

    r = await call('POST', '/api/local-checkout/999/use');
    assert.strictEqual(r.status, 404);

    r = await call('POST', '/api/local-checkout/restore'); // nada trocado
    assert.strictEqual(r.status, 404);

    r = await call('POST', '/api/local-checkout/100/use');
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.ok, true);
    assert.deepStrictEqual(r.body.skipped, ['b']);
    assert.strictEqual(branch(env.main.a), '');

    r = await call('GET', '/api/local-checkout');
    assert.strictEqual(r.body.active.ticket, '100');

    r = await call('POST', '/api/local-checkout/restore');
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.ok, true);
    assert.strictEqual(r.body.active, null);
    assert.strictEqual(branch(env.main.a), 'master');
});

test('rota use com conflito: 409 com repo no corpo', async t => {
    const env = makeEnv(['a']);
    env.addWorktree('a', '100');
    write(env.main.a, 'file.txt', 'local\n');
    fs.mkdirSync(path.join(tmp, 'memory-http2'), { recursive: true });
    const dash = createDashboard({
        memoryDir: path.join(tmp, 'memory-http2'), worktreesDir: env.wts,
        prefsFile: path.join(env.root, 'prefs.json'), localCheckout: env.lc(),
    });
    await new Promise(r => dash.server.listen(0, '127.0.0.1', r));
    await dash.ready;
    t.after(() => dash.close());
    const res = await fetch(`http://localhost:${dash.server.address().port}/api/local-checkout/100/use`, { method: 'POST' });
    const body = await res.json();
    assert.strictEqual(res.status, 409);
    assert.strictEqual(body.repo, 'a');
    assert.match(body.error, /git recusou/);
});
