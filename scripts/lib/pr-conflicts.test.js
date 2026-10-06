// node --test scripts/lib/pr-conflicts.test.js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { createConflictDetector } = require('./pr-conflicts');

const tmpBase = process.env.CLAUDE_JOB_DIR ? path.join(process.env.CLAUDE_JOB_DIR, 'tmp') : os.tmpdir();
const repo = fs.mkdtempSync(path.join(tmpBase, 'pr-conflicts-'));
const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
const commit = (file, content, msg) => { fs.writeFileSync(path.join(repo, file), content); git('add', file); git('commit', '-q', '-m', msg); return git('rev-parse', 'HEAD'); };

git('init', '-q', '-b', 'main');
git('config', 'user.email', 't@t'); git('config', 'user.name', 't');
const base = commit('a.txt', 'linha\n', 'base');
git('checkout', '-q', '-b', 'limpo'); const limpo = commit('b.txt', 'novo\n', 'limpo');
git('checkout', '-q', base); git('checkout', '-q', '-b', 'conflito'); const conflito = commit('a.txt', 'da branch\n', 'conflito');
git('checkout', '-q', 'main'); const main = commit('a.txt', 'do destino\n', 'destino');

test.after(() => fs.rmSync(repo, { recursive: true, force: true }));

test('detect: branch sem conflito => hasConflicts false', async () => {
    const d = createConflictDetector({ repoRoot: repo });
    assert.deepStrictEqual(await d.detect({ sourceCommit: limpo, targetCommit: main }), { hasConflicts: false, conflictFiles: [] });
});

test('detect: conflito => hasConflicts true com os arquivos (aceita hash curto, como o Bitbucket manda)', async () => {
    const d = createConflictDetector({ repoRoot: repo });
    assert.deepStrictEqual(await d.detect({ sourceCommit: conflito.slice(0, 12), targetCommit: main.slice(0, 12) }), { hasConflicts: true, conflictFiles: ['a.txt'] });
});

test('detect: sem commit ou commit inexistente => null (nunca inventa)', async () => {
    const d = createConflictDetector({ repoRoot: repo, remote: 'remoto-que-nao-existe' });
    assert.deepStrictEqual(await d.detect({ sourceCommit: null, targetCommit: main }), { hasConflicts: null, conflictFiles: [] });
    assert.deepStrictEqual(await d.detect({ sourceCommit: 'deadbeefdead', targetCommit: main }), { hasConflicts: null, conflictFiles: [] });
});
