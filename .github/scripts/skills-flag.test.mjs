// node --test .github/scripts/skills-flag.test.mjs
// O watcher abre o consumidor com --add-dir deste repo, e o Claude Code carrega
// .claude/skills de diretórios adicionados. Toda skill do repo precisa de
// disable-model-invocation: true para não aparecer nem ser chamada pelo modelo lá.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SKILLS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '.claude', 'skills');

test('toda skill em .claude/skills tem disable-model-invocation: true', () => {
    const dirs = fs.existsSync(SKILLS) ? fs.readdirSync(SKILLS) : [];
    assert.ok(dirs.length > 0, 'nenhuma skill encontrada');
    for (const d of dirs) {
        const md = fs.readFileSync(path.join(SKILLS, d, 'SKILL.md'), 'utf8');
        const front = md.match(/^---\n([\s\S]*?)\n---/)?.[1] ?? '';
        assert.match(front, /^disable-model-invocation:\s*true\s*$/m, d);
    }
});
