// node --test scripts/lib/workspace-manifest.test.js
// PRI-310 (PRI-287 S5.1) AC-12 a AC-21: manifesto do workspace com repositórios git sintéticos.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const wm = require('./workspace-manifest');
const dom06 = require('./dom06-attempt');

const tmpRoot = fs.mkdtempSync(path.join(process.env.CLAUDE_JOB_DIR ? path.join(process.env.CLAUDE_JOB_DIR, 'tmp') : os.tmpdir(), 'manifest-'));
test.after(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));

const GIT_ENV = {
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_AUTHOR_NAME: 'm', GIT_AUTHOR_EMAIL: 'm@example.invalid', GIT_COMMITTER_NAME: 'm', GIT_COMMITTER_EMAIL: 'm@example.invalid',
};
const env = { PATH: process.env.PATH, ...GIT_ENV };
const git = (cwd, ...args) => execFileSync('git', args, { cwd, env, encoding: 'utf8' }).trim();
const KEY = crypto.randomBytes(32);

let n = 0;
function repo() {
    const dir = path.join(tmpRoot, `r${n++}`);
    fs.mkdirSync(dir, { recursive: true });
    git(dir, 'init', '-q', '-b', 'main');
    fs.writeFileSync(path.join(dir, '.gitignore'), 'node_modules/\n.env*\nmemory/runs/\n');
    fs.mkdirSync(path.join(dir, 'src'));
    fs.writeFileSync(path.join(dir, 'src', 'a.js'), 'module.exports = 1;\n');
    git(dir, 'add', '.');
    git(dir, 'commit', '-q', '-m', 'base');
    return dir;
}
const obs = (dir, extra = {}) => wm.observe({ worktree: dir, key: KEY, env, ...extra });
const write = (dir, rel, text) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), text); };

test('AC-12 M1: conteúdo de um untracked muda (A → B) → manifestos diferentes', () => {
    const d = repo();
    write(d, 'novo.js', 'A');
    const a = obs(d);
    write(d, 'novo.js', 'B');
    const b = obs(d);
    assert.strictEqual(a.completeness, 'COMPLETE');
    assert.notStrictEqual(a.digest, b.digest);
    assert.deepStrictEqual(wm.compare(a, b).changed, ['novo.js']);
});

test('AC-13 M2: só o modo muda (chmod +x) → diferentes', () => {
    const d = repo();
    const a = obs(d);
    fs.chmodSync(path.join(d, 'src', 'a.js'), 0o755);
    const b = obs(d);
    assert.notStrictEqual(a.digest, b.digest);
});

test('AC-14 M3: mudança só no índice (staged, worktree igual ao HEAD depois) → diferentes', () => {
    const d = repo();
    const a = obs(d);
    write(d, 'src/a.js', 'module.exports = 2;\n');
    git(d, 'add', 'src/a.js');
    write(d, 'src/a.js', 'module.exports = 1;\n'); // worktree volta ao conteúdo do HEAD
    const b = obs(d);
    assert.notStrictEqual(a.digest, b.digest, 'o índice staged muda o componente index');
    assert.ok(b.counts.index >= 1);
});

test('AC-15 M4: ignorado no escopo muda → diferentes; fora do escopo → iguais; node_modules grande não estoura', () => {
    const d = repo();
    write(d, '.env', 'SEGREDO=1');
    write(d, 'node_modules/x/index.js', 'a');
    const scope = { watchGlobs: ['.env*'], scopePaths: ['src/a.js'] };
    const a = obs(d, scope);
    write(d, '.env', 'SEGREDO=2');
    const b = obs(d, scope);
    assert.notStrictEqual(a.digest, b.digest, '.env em workspace_watch_globs é observado');
    write(d, 'node_modules/x/index.js', 'b');
    const c = obs(d, scope);
    assert.strictEqual(b.digest, c.digest, 'node_modules fora do escopo não é observado (limite declarado)');
    // 2 500 arquivos com limite 50 equivalem aos 50 000 da SDD: o pathspec filtra antes do limite.
    for (let i = 0; i < 2500; i++) write(d, `node_modules/pkg${i}/i.js`, String(i));
    const e = obs(d, { ...scope, limits: { maxEntries: 50 } });
    assert.strictEqual(e.completeness, 'COMPLETE', 'pathspec filtra antes do limite');
});

test('AC-16 M5: comando git com erro → UNKNOWN, sem nova tentativa', () => {
    const d = path.join(tmpRoot, 'nao-e-repo');
    fs.mkdirSync(d, { recursive: true });
    const m = obs(d);
    assert.deepStrictEqual([m.completeness, m.cause, m.counts, m.digest], ['UNKNOWN', 'GIT_ERROR', null, null]);
});

function gitFingerprint(d) {
    const g = path.join(d, '.git');
    const objects = execFileSync('find', [path.join(g, 'objects'), '-type', 'f'], { encoding: 'utf8' }).split('\n').filter(Boolean).sort();
    const idx = fs.readFileSync(path.join(g, 'index'));
    return {
        objects,
        index: crypto.createHash('sha256').update(idx).digest('hex'),
        index_mtime: fs.statSync(path.join(g, 'index')).mtimeMs,
        refs: git(d, 'for-each-ref', '--format=%(refname) %(objectname)'),
        head: fs.readFileSync(path.join(g, 'HEAD'), 'utf8'),
    };
}

test('AC-17 M6: nenhuma escrita no repositório (índice, objetos e refs idênticos)', () => {
    const d = repo();
    write(d, 'src/a.js', 'mudou');
    write(d, 'novo.txt', 'x');
    // Envelhece o index: um git status com locks reescreveria o index "racy-clean".
    const past = new Date(Date.now() - 60000);
    fs.utimesSync(path.join(d, 'src', 'a.js'), past, past);
    const before = gitFingerprint(d);
    obs(d, { watchGlobs: ['.env*'], scopePaths: ['src/a.js'] });
    obs(d);
    assert.deepStrictEqual(gitFingerprint(d), before);
});

test('AC-18 M7: o resumo e um Attempt não exportam caminho, id de conteúdo, hash simples nem a chave', () => {
    const d = repo();
    const secret = 'conteudo-de-baixa-entropia';
    write(d, 'segredo-unico-nome.env.local', secret);
    const m = obs(d);
    const out = wm.summary(m);
    const runDir = path.join(tmpRoot, 'run-m7');
    const begun = dom06.beginAttempt(runDir, {
        node: 'implement', admission: { status: 'ADMITTED', owner: 'dom06', snapshot: { ticket_id: 1 } },
        decomposition: { role: 'subtask', plan_version: 'p'.repeat(64), subtask_key: 'pppppppppppp/1-1', workspace_baseline: out },
    });
    const exported = JSON.stringify(out) + fs.readFileSync(begun.attemptFile, 'utf8');
    const blobSha1 = crypto.createHash('sha1').update(`blob ${secret.length}\0${secret}`).digest('hex');
    const forbidden = ['segredo-unico-nome', 'src/a.js', secret, blobSha1,
        crypto.createHash('sha256').update(secret).digest('hex'), KEY.toString('hex'), KEY.toString('base64')];
    for (const f of forbidden) assert.ok(!exported.includes(f), `vazou: ${f.slice(0, 16)}`);
    assert.deepStrictEqual(Object.keys(out).sort(), ['cause', 'completeness', 'counts', 'digest']);
});

test('AC-18: chave fora do worktree, 0600; caminho não ignorado → KEY_PATH_NOT_IGNORED e nada gravado', () => {
    const main = repo(); // checkout principal: memory/runs/ ignorado pelo .gitignore
    const keysDir = path.join(main, 'memory', 'runs', '_dom06-keys');
    const k = wm.ensureKey({ keysDir, task: '1-t', checkoutRoot: main, env });
    assert.strictEqual(k.ok, true);
    assert.strictEqual(fs.statSync(wm.keyPath(keysDir, '1-t')).mode & 0o777, 0o600);
    assert.ok(wm.ensureKey({ keysDir, task: '1-t', checkoutRoot: main, env }).key.equals(k.key), 'a mesma chave na releitura');
    const exposed = path.join(main, 'chaves-expostas');
    const r = wm.ensureKey({ keysDir: exposed, task: '1-t', checkoutRoot: main, env });
    assert.deepStrictEqual(r, { ok: false, cause: 'KEY_PATH_NOT_IGNORED' });
    assert.ok(!fs.existsSync(exposed), 'nada gravado fora do caminho ignorado');
    wm.destroyKey({ keysDir, task: '1-t' });
    assert.ok(!fs.existsSync(wm.keyPath(keysDir, '1-t')));
});

test('AC-19 M8: encadeamento A → B → integração → gate (Test escreve teste) → rework de A', () => {
    const d = repo();
    const s = () => wm.summary(obs(d));
    const chain = [];
    // A: primeiro Attempt manifestado da Run (o anterior é o Plan, sem manifesto).
    const aBase = s();
    assert.deepStrictEqual(wm.chainCheck({ previousPost: null, baseline: aBase }).reason, 'PREVIOUS_POST_ABSENT', 'sem reancoragem, ausência não vira cadeia válida');
    assert.strictEqual(wm.chainCheck({ previousPost: null, baseline: aBase, anchor: { reason: 'RUN_START' } }).ok, true);
    write(d, 'src/a.js', 'A fez');
    chain.push(s()); // post de A
    // B
    assert.strictEqual(wm.chainCheck({ previousPost: chain.at(-1), baseline: s() }).ok, true);
    write(d, 'src/b.js', 'B fez');
    chain.push(s());
    // integração
    assert.strictEqual(wm.chainCheck({ previousPost: chain.at(-1), baseline: s() }).ok, true);
    write(d, 'src/a.js', 'junção');
    chain.push(s());
    // gate Test escreve teste
    assert.strictEqual(wm.chainCheck({ previousPost: chain.at(-1), baseline: s() }).ok, true);
    write(d, 'test/a.test.js', 'teste');
    chain.push(s());
    // rework de A: baseline = post do gate
    assert.strictEqual(wm.chainCheck({ previousPost: chain.at(-1), baseline: s() }).ok, true);
    // alguém mexe fora de Attempt
    write(d, 'src/a.js', 'mexida humana');
    assert.strictEqual(wm.chainCheck({ previousPost: chain.at(-1), baseline: s() }).reason, 'CHANGED_BETWEEN_ATTEMPTS');
    // post anterior UNKNOWN bloqueia
    assert.strictEqual(wm.chainCheck({ previousPost: { completeness: 'UNKNOWN', digest: null }, baseline: s() }).reason, 'PREVIOUS_POST_UNKNOWN');
});

test('AC-19: reancoragens SCOPE_CHANGED, HUMAN_UNBLOCK e HUMAN_RESUME são explícitas e registradas', () => {
    const d = repo();
    const base = wm.summary(obs(d));
    assert.strictEqual(wm.chainCheck({ previousPost: base, baseline: base, anchor: { reason: 'SCOPE_CHANGED', old_scope_equal: true } }).ok, true);
    assert.strictEqual(wm.chainCheck({ previousPost: base, baseline: base, anchor: { reason: 'SCOPE_CHANGED', old_scope_equal: false } }).reason, 'SCOPE_CHANGED_WITH_MUTATION');
    write(d, 'src/a.js', 'editado pelo humano no desbloqueio');
    const edited = wm.summary(obs(d));
    const unblock = wm.chainCheck({ previousPost: base, baseline: edited, anchor: { reason: 'HUMAN_UNBLOCK', by: 'human_input' }, at: '2026-11-09T12:00:00.000Z' });
    assert.deepStrictEqual([unblock.ok, unblock.anchor], [true, { reason: 'HUMAN_UNBLOCK', by: 'human_input', at: '2026-11-09T12:00:00.000Z' }]);
    assert.strictEqual(wm.chainCheck({ previousPost: base, baseline: edited, anchor: { reason: 'HUMAN_RESUME', by: '' } }).reason, 'ANCHOR_WITHOUT_HUMAN');
    const resume = wm.chainCheck({ previousPost: base, baseline: edited, anchor: { reason: 'HUMAN_RESUME', by: 'richard (SPEC_CHANGE aprovada)' } });
    assert.strictEqual(resume.ok, true);
    assert.strictEqual(wm.chainCheck({ previousPost: base, baseline: base, anchor: { reason: 'OUTRA' } }).reason, 'ANCHOR_INVALID');
});

test('AC-20 M9: falha sem mutação → retry permitido; com mutação → bloqueia sem reset', () => {
    const d = repo();
    const base = wm.summary(obs(d));
    const pv = 'q'.repeat(64);
    const attempt = { plan_version: pv, workspace: { baseline: base } };
    const noMut = dom06.decideAcceptance({ attempt, code: 1, claim: 'RELEASED', post: wm.summary(obs(d)), currentPlanVersion: pv });
    assert.deepStrictEqual([noMut.accepted, noMut.retry_allowed, noMut.block], [false, true, false]);
    write(d, 'src/a.js', 'parcial');
    const mut = dom06.decideAcceptance({ attempt, code: 1, claim: 'RELEASED', post: wm.summary(obs(d)), currentPlanVersion: pv });
    assert.deepStrictEqual([mut.reason, mut.block, mut.retry_allowed], ['PARTIAL_MUTATION', true, false]);
    assert.strictEqual(fs.readFileSync(path.join(d, 'src', 'a.js'), 'utf8'), 'parcial', 'nada é restaurado');
});

test('AC-21: UNKNOWN para link para fora, limite, chave ausente e conteúdo mudando durante a leitura; contagens null', () => {
    const d = repo();
    fs.symlinkSync(os.tmpdir(), path.join(d, 'fora'));
    assert.strictEqual(obs(d).cause, 'SYMLINK_OUTSIDE_WORKTREE');
    fs.rmSync(path.join(d, 'fora'));
    fs.symlinkSync('src/a.js', path.join(d, 'dentro'));
    assert.strictEqual(obs(d).completeness, 'COMPLETE', 'link para dentro é observado');
    write(d, 'x1.txt', '1'); write(d, 'x2.txt', '2');
    assert.strictEqual(obs(d, { limits: { maxEntries: 2 } }).cause, 'LIMIT_EXCEEDED');
    assert.strictEqual(obs(d, { limits: { maxBytes: 1 } }).cause, 'LIMIT_EXCEEDED');
    const noKey = wm.observe({ worktree: d, key: null, env });
    assert.deepStrictEqual([noKey.cause, noKey.counts], ['KEY_MISSING', null]);
    // Conteúdo muda entre a 1ª e a 2ª leitura: o fs de leitura é interceptado só neste caso.
    const orig = fs.readFileSync;
    let calls = 0;
    fs.readFileSync = function (p, ...rest) {
        if (String(p).endsWith('x1.txt')) { calls++; return Buffer.from(calls === 1 ? '1' : 'mudou'); }
        return orig.call(this, p, ...rest);
    };
    try {
        const m = obs(d);
        assert.deepStrictEqual([m.completeness, m.cause, m.counts], ['UNKNOWN', 'CHANGED_DURING_READ', null]);
    } finally {
        fs.readFileSync = orig;
    }
});

test('memory/runs/** fica fora do manifesto (estado do orquestrador)', () => {
    const d = repo();
    const a = obs(d);
    write(d, 'memory/runs/1-t/state.json', '{"x":1}');
    assert.strictEqual(obs(d).digest, a.digest);
});

test('submódulo com mudança → UNKNOWN (parser do porcelain v2)', () => {
    const line = Buffer.from('1 .M SC.. 160000 160000 160000 abc abc lib/sub\0');
    assert.throws(() => wm._parseStatus(line), /SUBMODULE_CHANGED/);
    assert.deepStrictEqual(wm._parseStatus(Buffer.from('1 .M N... 100644 100644 100644 a b src/x y.js\0')), ['src/x y.js']);
    assert.deepStrictEqual(wm._parseStatus(Buffer.from('2 R. N... 100644 100644 100644 a b R100 novo.js\0velho.js\0')), ['novo.js', 'velho.js']);
});

test('C-O-01: digest independe do locale (nomes acentuados e caixa mista)', () => {
    const d = repo();
    for (const f of ['a.txt', 'z.txt', 'ä.txt', 'B.txt', 'Á.txt']) write(d, f, f);
    const run = lc => execFileSync(process.execPath, ['-e', `
        const wm = require(${JSON.stringify(path.join(__dirname, 'workspace-manifest.js'))});
        const key = Buffer.from(${JSON.stringify(KEY.toString('hex'))}, 'hex');
        process.stdout.write(wm.observe({ worktree: ${JSON.stringify(d)}, key, env: process.env }).digest || 'null');
    `], { env: { ...env, LC_ALL: lc, LANG: lc }, encoding: 'utf8' });
    const sv = run('sv_SE.UTF-8');
    assert.notStrictEqual(sv, 'null');
    assert.strictEqual(run('en_US.UTF-8'), sv);
    assert.strictEqual(run('C'), sv);
});

test('C-O-09: edição em arquivo assume-unchanged/skip-worktree é observada; repositório aninhado → UNKNOWN', () => {
    const d = repo();
    git(d, 'update-index', '--assume-unchanged', 'src/a.js');
    const a = obs(d);
    write(d, 'src/a.js', 'editado escondido');
    assert.notStrictEqual(obs(d).digest, a.digest);
    const d2 = repo();
    fs.mkdirSync(path.join(d2, 'aninhado'));
    git(path.join(d2, 'aninhado'), 'init', '-q');
    write(d2, 'aninhado/x.txt', 'x');
    assert.strictEqual(obs(d2).cause, 'NESTED_REPOSITORY');
});

test('C-A-07: cadeia de links que termina fora do worktree → UNKNOWN', () => {
    const d = repo();
    fs.symlinkSync(os.tmpdir(), path.join(d, 'ponte'));
    fs.appendFileSync(path.join(d, '.gitignore'), 'ponte\n');
    fs.symlinkSync('ponte/algum-arquivo', path.join(d, 'elo'));
    assert.strictEqual(obs(d).cause, 'SYMLINK_OUTSIDE_WORKTREE');
});

test('C-O-10/C-A-06: causa da chave preservada; corrida de criação lê a do vencedor; manifesto só em caminho ignorado', () => {
    const d = repo();
    assert.strictEqual(wm.observe({ worktree: d, key: null, keyCause: 'KEY_PATH_NOT_IGNORED', env }).cause, 'KEY_PATH_NOT_IGNORED');
    const main = repo();
    const keysDir = path.join(main, 'memory', 'runs', '_dom06-keys');
    const origLink = fs.linkSync;
    let winner = null;
    fs.linkSync = function (src, dst) {
        // Outro processo publica antes: simula EEXIST na corrida.
        winner = crypto.randomBytes(32);
        fs.mkdirSync(path.dirname(dst), { recursive: true });
        fs.writeFileSync(dst, winner, { mode: 0o600 });
        const e = new Error('existe'); e.code = 'EEXIST'; throw e;
    };
    try {
        const k = wm.ensureKey({ keysDir, task: '2-t', checkoutRoot: main, env });
        assert.ok(k.ok && k.key.equals(winner), 'quem perde a corrida usa a chave do vencedor');
    } finally {
        fs.linkSync = origLink;
    }
    assert.deepStrictEqual(fs.readdirSync(keysDir).filter(f => f.endsWith('.tmp')), [], 'sem temporário sobrando');
    const okDir = path.join(main, 'memory', 'runs', '_dom06-manifests');
    assert.ok(wm.storeManifest(okDir, '2-t', 'att-1', 'post', { x: 1 }, { checkoutRoot: main, env }));
    assert.strictEqual(wm.storeManifest(path.join(main, 'exposto'), '2-t', 'att-1', 'post', { x: 1 }, { checkoutRoot: main, env }), null);
    assert.ok(!fs.existsSync(path.join(main, 'exposto')));
    assert.throws(() => wm.storeManifest(okDir, '../fora', 'att', 'post', {}, { checkoutRoot: main, env }), /MANIFEST_ID_INVALID/);
});

test('SCOPE_CHANGED: recalcula no escopo antigo antes de reancorar', () => {
    const d = repo();
    write(d, '.env', 'A');
    const prev = wm.summary(obs(d, { scopePaths: ['src/a.js'], watchGlobs: ['.env*'] }));
    const same = wm.scopeChangedCheck({ worktree: d, key: KEY, previousPost: prev, oldScopePaths: ['src/a.js'], watchGlobs: ['.env*'], env });
    assert.strictEqual(same.old_scope_equal, true);
    write(d, '.env', 'B');
    assert.strictEqual(wm.scopeChangedCheck({ worktree: d, key: KEY, previousPost: prev, oldScopePaths: ['src/a.js'], watchGlobs: ['.env*'], env }).old_scope_equal, false);
    const anchored = wm.chainCheck({ previousPost: prev, baseline: prev, anchor: { reason: 'SCOPE_CHANGED', old_scope_equal: true }, at: '2026-11-09T00:00:00.000Z' });
    assert.deepStrictEqual(anchored.anchor, { reason: 'SCOPE_CHANGED', by: null, at: '2026-11-09T00:00:00.000Z' });
});

test('AC-18: nada do manifesto entra no diretório da Run (worktree), inclusive numa cópia de _archive', () => {
    const main = repo();
    const worktree = repo();
    const secret = 'segredo-baixo';
    write(worktree, 'conf/nome-sensivel.env.local', secret);
    const k = wm.ensureKey({ keysDir: path.join(main, 'memory', 'runs', '_dom06-keys'), task: '3-t', checkoutRoot: main, env });
    const m = wm.observe({ worktree, key: k.key, env });
    wm.storeManifest(path.join(main, 'memory', 'runs', '_dom06-manifests'), '3-t', 'att-9', 'post', m, { checkoutRoot: main, env });
    const runDir = path.join(worktree, 'memory', 'runs', '3-t');
    const b = dom06.beginAttempt(runDir, { node: 'implement', admission: { status: 'ADMITTED', owner: 'dom06', snapshot: { ticket_id: 3 } }, decomposition: { role: 'subtask', plan_version: 'r'.repeat(64), subtask_key: 'rrrrrrrrrrrr/1-1', workspace_baseline: wm.summary(m) } });
    fs.writeFileSync(path.join(runDir, 'handoff.md'), `# Handoff\n\nmanifesto: ${JSON.stringify(wm.summary(m))}\n`);
    fs.cpSync(runDir, path.join(worktree, 'memory', 'runs', '_archive', '3-t'), { recursive: true });
    const scan = dir => fs.readdirSync(dir, { recursive: true }).map(f => path.join(dir, f)).filter(f => fs.statSync(f).isFile()).map(f => fs.readFileSync(f, 'utf8')).join('\n');
    const all = scan(path.join(worktree, 'memory', 'runs'));
    for (const f of ['nome-sensivel', secret, k.key.toString('hex'), k.key.toString('base64')]) assert.ok(!all.includes(f), `vazou no worktree: ${f.slice(0, 12)}`);
    assert.ok(b.attempt.workspace.baseline.digest, 'o resumo (digest) está no Attempt');
});

test('R2-C-O-01: link pendente dentro do worktree (alvo e pai ainda não existem) é observado', () => {
    const d = repo();
    fs.symlinkSync('build/out/app.js', path.join(d, 'latest'));
    assert.strictEqual(obs(d).completeness, 'COMPLETE');
    fs.symlinkSync('../../fora/x', path.join(d, 'escapa'));
    assert.strictEqual(obs(d).cause, 'SYMLINK_OUTSIDE_WORKTREE', 'pendente para fora continua UNKNOWN');
});
