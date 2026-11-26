'use strict';
// Docs como vault do Obsidian (PRI-413, AC-06): .obsidian/ fica fora do repo e o README explica o uso.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.join(__dirname, '..');
const DOCS = path.join(REPO, 'docs');
const README = path.join(DOCS, 'README.md');

// Só o .gitignore do repo conta: sem a config global e do sistema (um core.excludesFile com
// .obsidian faria o teste passar sem a linha no .gitignore).
function checkIgnore(file) {
    const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' };
    const { status } = spawnSync('git', ['-c', 'core.excludesFile=', 'check-ignore', '-q', file], { cwd: REPO, env });
    assert.ok(status === 0 || status === 1, `git check-ignore indisponível (status ${status}): precisa de git e de .git`);
    return status;
}

describe('.obsidian/ fora do repo', () => {
    it('a pasta que o Obsidian cria em docs/ é ignorada pelo git', () => {
        assert.equal(checkIgnore('docs/.obsidian/workspace.json'), 0);
    });

    it('o README de docs/ não é ignorado', () => {
        assert.equal(checkIgnore('docs/README.md'), 1);
    });
});

describe('docs/README.md', () => {
    it('existe', () => {
        assert.ok(fs.existsSync(README), 'docs/README.md não existe');
    });

    it('explica como abrir o vault e como manter as ligações', () => {
        const text = fs.readFileSync(README, 'utf8');
        assert.match(text, /Abrir pasta como cofre/);
        assert.match(text, /knowledge-links\.js --write/);
        assert.match(text, /\.obsidian\//);
    });

    it('liga a obsidian.md e a capacidades/README.md com links que resolvem', () => {
        const text = fs.readFileSync(README, 'utf8');
        const targets = [...text.matchAll(/\]\(([^)#\s]+)(?:#[^)]*)?\)/g)].map((m) => m[1]);
        for (const wanted of ['obsidian.md', 'capacidades/README.md']) {
            assert.ok(targets.includes(wanted), `falta o link relativo para ${wanted}`);
        }
        for (const target of targets.filter((t) => !/^[a-z]+:/i.test(t))) {
            assert.ok(fs.existsSync(path.join(DOCS, target)), `link quebrado: ${target}`);
        }
    });
});
