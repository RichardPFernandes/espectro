// node --test scripts/git-push-effect.test.js
// PRI-179 (F1.6): o push do /commit multi-repo leva a identidade do repo na chave do
// efeito. O mesmo `push -u origin <branch>` em dois repos irmãos são dois efeitos;
// cwd, `-C <dir>` e caminho por symlink para o mesmo repo dão a mesma chave; fora de
// repo, nada roda. Só repos temporários com remotes bare locais, sem rede.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, execFileSync } = require('child_process');
const dom06 = require('./lib/dom06-attempt');

const script = path.join(__dirname, 'git-push-effect.sh');
const tmpBase = process.env.CLAUDE_JOB_DIR ? path.join(process.env.CLAUDE_JOB_DIR, 'tmp') : os.tmpdir();
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(tmpBase, 'git-push-effect-')));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const BRANCH = 'TICKET-X';
const GIT_ENV = {
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_AUTHOR_NAME: 'teste', GIT_AUTHOR_EMAIL: 'teste@example.invalid',
    GIT_COMMITTER_NAME: 'teste', GIT_COMMITTER_EMAIL: 'teste@example.invalid',
    // Nenhum repo acima do diretório temporário entra na descoberta do git.
    GIT_CEILING_DIRECTORIES: tmp,
};

// `git` falso no PATH: anota cada `git push` e repassa ao git real.
const realGit = execFileSync('/usr/bin/env', ['which', 'git'], { encoding: 'utf8' }).trim();
const binDir = path.join(tmp, 'bin');
const pushLog = path.join(tmp, 'git-push.log');
fs.mkdirSync(binDir);
fs.writeFileSync(path.join(binDir, 'git'), `#!/bin/sh
for a in "$@"; do
  if [ "$a" = push ]; then echo "$PWD $*" >> ${JSON.stringify(pushLog)}; break; fi
done
exec ${JSON.stringify(realGit)} "$@"
`, { mode: 0o755 });
const pushesLogged = () => (fs.existsSync(pushLog) ? fs.readFileSync(pushLog, 'utf8').split('\n').filter(Boolean) : []);

const git = (cwd, ...args) => execFileSync(realGit, args, { cwd, env: { PATH: process.env.PATH, ...GIT_ENV }, encoding: 'utf8' }).trim();

// Remote bare + clone com um commit, num diretório próprio do caso.
function makeRemote(caseDir, name) {
    const remote = path.join(caseDir, `${name}.git`);
    git(caseDir, 'init', '-q', '--bare', remote);
    return remote;
}
function cloneOf(caseDir, remote, name) {
    const dir = path.join(caseDir, name);
    git(caseDir, 'clone', '-q', remote, dir);
    git(dir, 'checkout', '-q', '-b', BRANCH);
    git(dir, 'commit', '-q', '--allow-empty', '-m', `primeiro commit de ${name}`);
    return dir;
}
function remoteHasBranch(remote) {
    return spawnSync(realGit, ['--git-dir', remote, 'rev-parse', '--verify', '--quiet', `refs/heads/${BRANCH}`],
        { env: { PATH: process.env.PATH, ...GIT_ENV } }).status === 0;
}

function admit(caseDir) {
    const run = fs.mkdtempSync(path.join(caseDir, 'run-'));
    const decision = dom06.beginAttempt(run, {
        node: 'commit',
        admission: {
            status: 'ADMITTED',
            owner: 'dom06',
            snapshot: { ticket_id: 1, node: 'commit', base_branch: 'main', spec_hash: 'hash-teste' },
        },
        obligations: dom06.obligationsFor('commit'),
    });
    assert.ok(decision.dispatch, 'Attempt admitido');
    return decision.attemptFile;
}
const pushEffects = attemptFile => (dom06.readAttempt(attemptFile).effects || []).filter(e => e.obligation_id === 'push');

function pushEffect(cwd, attemptFile, args) {
    return spawnSync(script, args, {
        cwd,
        encoding: 'utf8',
        env: { PATH: `${binDir}:${process.env.PATH}`, ...GIT_ENV, DOM06_ATTEMPT_FILE: attemptFile },
    });
}

function newCase(name) {
    const dir = path.join(tmp, name);
    fs.mkdirSync(dir);
    fs.rmSync(pushLog, { force: true });
    return dir;
}

test('AC-1: mesmo push em repo-a e repo-b chega aos dois remotes e grava dois efeitos', () => {
    const caseDir = newCase('irmaos');
    const remoteA = makeRemote(caseDir, 'repo-a');
    const remoteB = makeRemote(caseDir, 'repo-b');
    const repoA = cloneOf(caseDir, remoteA, 'repo-a');
    const repoB = cloneOf(caseDir, remoteB, 'repo-b');
    const attemptFile = admit(caseDir);

    const a = pushEffect(repoA, attemptFile, ['push', '-u', 'origin', BRANCH]);
    const b = pushEffect(repoB, attemptFile, ['push', '-u', 'origin', BRANCH]);

    assert.strictEqual(a.status, 0, a.stderr);
    assert.strictEqual(b.status, 0, b.stderr);
    assert.ok(remoteHasBranch(remoteA), 'repo-a recebeu a branch');
    assert.ok(remoteHasBranch(remoteB), 'repo-b recebeu a branch');
    const effects = pushEffects(attemptFile);
    assert.strictEqual(effects.length, 2, JSON.stringify(effects));
    assert.ok(effects.every(e => e.status === 'fulfilled'));
    assert.ok(effects[0].idempotency_key.includes(repoA), effects[0].idempotency_key);
    assert.ok(effects[1].idempotency_key.includes(repoB), effects[1].idempotency_key);
    assert.strictEqual(pushesLogged().length, 2);
});

test('AC-2: dois clones do mesmo remote são dois efeitos', () => {
    const caseDir = newCase('clones');
    const remote = makeRemote(caseDir, 'repo-a');
    const clone1 = cloneOf(caseDir, remote, 'repo-a-1');
    const clone2 = path.join(caseDir, 'repo-a-2');
    git(caseDir, 'clone', '-q', remote, clone2);
    git(clone2, 'checkout', '-q', '-b', BRANCH);
    const attemptFile = admit(caseDir);

    const first = pushEffect(clone1, attemptFile, ['push', '-u', 'origin', BRANCH]);
    git(clone2, 'pull', '-q', remote, BRANCH);
    const second = pushEffect(clone2, attemptFile, ['push', '-u', 'origin', BRANCH]);

    assert.strictEqual(first.status, 0, first.stderr);
    assert.strictEqual(second.status, 0, second.stderr);
    assert.doesNotMatch(second.stderr, /já cumprido/);
    assert.strictEqual(pushEffects(attemptFile).length, 2);
    assert.strictEqual(pushesLogged().length, 2, 'o git rodou nos dois checkouts');
});

test('AC-4: cwd, -C, subdiretório e caminho por symlink dão a mesma chave', () => {
    const caseDir = newCase('mesma-chave');
    const remote = makeRemote(caseDir, 'repo-a');
    const repoA = cloneOf(caseDir, remote, 'repo-a');
    fs.mkdirSync(path.join(repoA, 'sub'));
    const link = path.join(caseDir, 'atalho');
    fs.symlinkSync(repoA, link);
    const attemptFile = admit(caseDir);

    const byCwd = pushEffect(repoA, attemptFile, ['push', '-u', 'origin', BRANCH]);
    assert.strictEqual(byCwd.status, 0, byCwd.stderr);
    assert.ok(remoteHasBranch(remote));

    const byC = pushEffect(caseDir, attemptFile, ['-C', repoA, 'push', '-u', 'origin', BRANCH]);
    const byRelC = pushEffect(caseDir, attemptFile, ['-C', 'repo-a', 'push', '-u', 'origin', BRANCH]);
    const bySub = pushEffect(path.join(repoA, 'sub'), attemptFile, ['push', '-u', 'origin', BRANCH]);
    const byLink = pushEffect(link, attemptFile, ['push', '-u', 'origin', BRANCH]);
    const byLinkC = pushEffect(caseDir, attemptFile, ['-C', link, 'push', '-u', 'origin', BRANCH]);

    for (const r of [byC, byRelC, bySub, byLink, byLinkC]) {
        assert.strictEqual(r.status, 0, r.stderr);
        assert.match(r.stderr, /já cumprido/);
    }
    const effects = pushEffects(attemptFile);
    assert.strictEqual(effects.length, 1, JSON.stringify(effects));
    assert.ok(effects[0].idempotency_key.includes(repoA), effects[0].idempotency_key);
    assert.strictEqual(pushesLogged().length, 1, 'só o primeiro push chamou o git');
});

test('AC-4: -C num repo válido faz o push nesse repo', () => {
    const caseDir = newCase('so-C');
    const remote = makeRemote(caseDir, 'repo-a');
    const repoA = cloneOf(caseDir, remote, 'repo-a');
    const attemptFile = admit(caseDir);

    const r = pushEffect(caseDir, attemptFile, ['-C', repoA, 'push', '-u', 'origin', BRANCH]);

    assert.strictEqual(r.status, 0, r.stderr);
    assert.ok(remoteHasBranch(remote), 'o remote do repo do -C recebeu a branch');
    assert.strictEqual(pushEffects(attemptFile).length, 1);
});

test('AC-5: fora de repo git, sai ≠ 0 sem chamar git push e sem efeito', () => {
    const caseDir = newCase('fora-de-repo');
    const plain = path.join(caseDir, 'sem-git');
    fs.mkdirSync(plain);
    const attemptFile = admit(caseDir);

    const byCwd = pushEffect(plain, attemptFile, ['push', '-u', 'origin', BRANCH]);
    const byC = pushEffect(caseDir, attemptFile, ['-C', plain, 'push', '-u', 'origin', BRANCH]);

    for (const r of [byCwd, byC]) {
        assert.notStrictEqual(r.status, 0, r.stderr);
        assert.match(r.stderr, /git push não rodou/);
    }
    assert.deepStrictEqual(pushesLogged(), []);
    assert.deepStrictEqual(dom06.readAttempt(attemptFile).effects || [], []);
});

const remoteHead = remote => spawnSync(realGit, ['--git-dir', remote, 'rev-parse', '--verify', '--quiet', `refs/heads/${BRANCH}`],
    { env: { PATH: process.env.PATH, ...GIT_ENV }, encoding: 'utf8' }).stdout.trim();

test('AC-3: commit novo no mesmo repo faz push novo; o remote avança e há dois efeitos', () => {
    const caseDir = newCase('commit-novo');
    const remote = makeRemote(caseDir, 'repo-a');
    const repoA = cloneOf(caseDir, remote, 'repo-a');
    const attemptFile = admit(caseDir);

    const first = pushEffect(repoA, attemptFile, ['push', '-u', 'origin', BRANCH]);
    const firstSha = git(repoA, 'rev-parse', 'HEAD');
    git(repoA, 'commit', '-q', '--allow-empty', '-m', 'segundo commit');
    const secondSha = git(repoA, 'rev-parse', 'HEAD');
    const second = pushEffect(repoA, attemptFile, ['push', '-u', 'origin', BRANCH]);

    assert.strictEqual(first.status, 0, first.stderr);
    assert.strictEqual(second.status, 0, second.stderr);
    assert.doesNotMatch(second.stderr, /já cumprido/);
    assert.strictEqual(remoteHead(remote), secondSha, 'o remote avançou para o commit novo');
    const effects = pushEffects(attemptFile);
    assert.strictEqual(effects.length, 2, JSON.stringify(effects));
    assert.ok(effects.every(e => e.status === 'fulfilled'));
    assert.ok(effects[0].idempotency_key.includes(firstSha), effects[0].idempotency_key);
    assert.ok(effects[1].idempotency_key.includes(secondSha), effects[1].idempotency_key);
    assert.strictEqual(pushesLogged().length, 2);
});

test('AC-3: repetição idêntica não roda o git, sai 0 e a linha de pulo cita repo e commit', () => {
    const caseDir = newCase('repeticao');
    const remote = makeRemote(caseDir, 'repo-a');
    const repoA = cloneOf(caseDir, remote, 'repo-a');
    const sha = git(repoA, 'rev-parse', 'HEAD');
    const attemptFile = admit(caseDir);

    const first = pushEffect(repoA, attemptFile, ['push', '-u', 'origin', BRANCH]);
    const again = pushEffect(repoA, attemptFile, ['push', '-u', 'origin', BRANCH]);

    assert.strictEqual(first.status, 0, first.stderr);
    assert.strictEqual(again.status, 0, again.stderr);
    assert.match(again.stderr, /já cumprido/);
    assert.ok(again.stderr.includes(repoA), again.stderr);
    assert.ok(again.stderr.includes(sha), again.stderr);
    assert.strictEqual(pushEffects(attemptFile).length, 1);
    assert.strictEqual(pushesLogged().length, 1, 'o git não rodou de novo');
});

test('AC-3: HEAD:<branch>, <origem>:<branch> e --force-with-lease levam o sha da origem do refspec', () => {
    const caseDir = newCase('refspec');
    const remote = makeRemote(caseDir, 'repo-a');
    const repoA = cloneOf(caseDir, remote, 'repo-a');
    const c1 = git(repoA, 'rev-parse', 'HEAD');
    git(repoA, 'branch', 'base');
    git(repoA, 'commit', '-q', '--allow-empty', '-m', 'segundo commit');
    const c2 = git(repoA, 'rev-parse', 'HEAD');
    const attemptFile = admit(caseDir);

    const byBase = pushEffect(repoA, attemptFile, ['push', 'origin', `base:${BRANCH}`]);
    assert.strictEqual(byBase.status, 0, byBase.stderr);
    assert.strictEqual(remoteHead(remote), c1);

    const byHead = pushEffect(repoA, attemptFile, ['push', 'origin', `HEAD:${BRANCH}`]);
    assert.strictEqual(byHead.status, 0, byHead.stderr);
    assert.strictEqual(remoteHead(remote), c2);

    git(repoA, 'commit', '-q', '--amend', '--allow-empty', '-m', 'segundo commit reescrito');
    const c3 = git(repoA, 'rev-parse', 'HEAD');
    const byLease = pushEffect(repoA, attemptFile, ['push', '--force-with-lease', 'origin', BRANCH]);
    assert.strictEqual(byLease.status, 0, byLease.stderr);
    assert.strictEqual(remoteHead(remote), c3);

    const keys = pushEffects(attemptFile).map(e => e.idempotency_key);
    assert.strictEqual(keys.length, 3, JSON.stringify(keys));
    assert.ok(keys[0].includes(`${repoA}@${c1}`), keys[0]);
    assert.ok(keys[1].includes(`${repoA}@${c2}`), keys[1]);
    assert.ok(keys[2].includes(`${repoA}@${c3}`), keys[2]);
});
