'use strict';
// PRI-373: exportador do vault do Obsidian (AC-1 a AC-6). Usa um repositório git sintético.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const { buildVault, writeVault, classify, UsageError } = require('./obsidian-export');

let tmp, repo;
const put = (rel, text) => {
    fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
    fs.writeFileSync(path.join(repo, rel), text);
};
const git = (...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...a], { cwd: repo, stdio: 'pipe' });

before(() => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'obsidian-export-')));
    repo = path.join(tmp, 'repo');
    fs.mkdirSync(repo);
    git('init', '-q', '-b', 'main');
    put('tasks/pri-1/SPEC.md', '# SPEC: PRI-1, exemplo\n\nVeja `docs/guia.md` e [guia](../../docs/guia.md). Ligado a PRI-2.\n\n```\nPRI-9 docs/guia.md\n```\n');
    put('docs/guia.md', '# Guia\n\nCitada por PRI-1.\n| a |\n| `docs/guia.md` |\n');
    put('docs/vazou.md', 'token = abcdefghijklmnopqrstuvwxyz123456\n');
    put('docs/env1.md', 'OPENAI_API_KEY=abcdefghijklmnopqrstuvwxyz\n');
    put('docs/env2.md', 'AWS_SECRET_ACCESS_KEY: abcdefghijklmnopqrstuvwxyz\n');
    put('docs/ação.md', '# Ação\n');
    put('docs/links.md', '[t](docs/guia.md "título") [p](docs/100%.md)\n[ref]: docs/guia.md\n\n````\n```\nPRI-9 docs/guia.md\n```\n````\nfora PRI-8\n');
    put('tasks/pri-1/plan.md', 'Veja `SPEC.md`.\n');
    put('.agents/skills/y/SKILL.md', '---\nname: y\ndescription: >-\n  linha um\n  linha dois\n---\n# y\n');
    fs.writeFileSync(path.join(repo, '.env'), 'SEGREDO=1\n');
    fs.symlinkSync('../.env', path.join(repo, 'docs/leak.md'));
    put('.agents/skills/x/SKILL.md', '---\nname: x\ndescription: faz x\n---\n# x\n');
    put('.claude/commands/plan.md', '# plan\n');
    put('.graph/graph.yaml', 'nodes:\n  - id: plan\n    command: /plan\n    on_success: plan\n');
    put('ownership.yaml', 'modules:\n  - path: scripts/a.js\n    capability: cap\n    owner: UNKNOWN\n');
    git('add', '-A', '--', ':!.env');
    git('commit', '-q', '-m', 'init');
});
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

test('classify separa spec, tarefa, doc, skill e comando; ignora o resto', () => {
    assert.equal(classify('tasks/a/SPEC.md')[0], 'spec');
    assert.equal(classify('tasks/a/plan.md')[0], 'tarefa');
    assert.equal(classify('docs/x.md')[0], 'doc');
    assert.equal(classify('.agents/skills/s/SKILL.md')[0], 'skill');
    assert.equal(classify('scripts/x.js'), null);
});

test('AC-2/AC-3/AC-6: origem, issues, links, código intacto e segredo fora', () => {
    const { files, skipped } = buildVault(repo);
    const spec = files.get('Specs/Spec · pri-1.md');
    assert.match(spec, /origem: "tasks\/pri-1\/SPEC\.md"/);
    assert.match(spec, /commit: "[0-9a-f]{7}"/);
    assert.match(spec, /issues: \["\[\[PRI-1\]\]", "\[\[PRI-2\]\]", "\[\[PRI-9\]\]"\]/);
    assert.match(spec, /\[\[Doc · guia\|docs\/guia\.md\]\]/);
    assert.match(spec, /\[\[Doc · guia\|guia\]\]/);
    assert.match(spec, /^```\nPRI-9 docs\/guia\.md\n```$/m);
    assert.match(spec, /Ligado a \[\[PRI-2\]\]/);
    assert.match(spec, /^# SPEC: PRI-1, exemplo$/m);
    assert.match(files.get('Docs/Doc · guia.md'), /^\| \[\[Doc · guia\\\|docs\/guia\.md\]\] \|$/m);
    assert.match(files.get('Issues/PRI-1.md'), /linear\.app\/prisma-app\/issue\/PRI-1\b[\s\S]*\[\[Spec · pri-1\]\][\s\S]*\[\[Doc · guia\]\]/);
    assert.match(files.get('Skills/Skill · x.md'), /descricao: "faz x"/);
    assert.ok(!files.has('Docs/Doc · vazou.md'));
    for (const f of ['vazou', 'env1', 'env2']) assert.ok(skipped.some((s) => s.startsWith(`docs/${f}.md`)), f);
    assert.ok(!files.has('Docs/Doc · leak.md'), 'symlink não é lido');
    assert.ok(![...files.values()].some((v) => v.includes('SEGREDO')));
});

test('AC-4: índice inicial e índices por tipo', () => {
    const { files } = buildVault(repo);
    for (const f of ['00 Início', '01 Specs', '02 Issues', '03 Docs', '04 Skills', '05 Comandos e fluxo', '06 Tarefas', '07 Módulos']) assert.ok(files.has(`${f}.md`), f);
    assert.match(files.get('07 Módulos.md'), /\| `scripts\/a\.js` \| cap \| UNKNOWN \|/);
    assert.match(files.get('05 Comandos e fluxo.md'), /\[\[Comando · plan\]\] → `plan`/);
});

test('AC-1/AC-5: não escreve no repo, é idempotente e recusa pasta alheia', () => {
    const out = path.join(tmp, 'vault');
    const antes = git('status', '--porcelain').toString();
    writeVault(out, repo, buildVault(repo));
    const snap = () => fs.readdirSync(out, { recursive: true }).sort().map((f) => (fs.statSync(path.join(out, f)).isFile() ? fs.readFileSync(path.join(out, f), 'utf8') : f));
    const primeira = snap();
    writeVault(out, repo, buildVault(repo));
    assert.deepEqual(snap(), primeira);
    assert.equal(git('status', '--porcelain').toString(), antes);
    assert.throws(() => writeVault(path.join(repo, 'vault'), repo, buildVault(repo)), UsageError);
    const alheia = path.join(tmp, 'alheia');
    fs.mkdirSync(alheia);
    fs.writeFileSync(path.join(alheia, 'nota.md'), 'minha');
    assert.throws(() => writeVault(alheia, repo, buildVault(repo)), UsageError);
    assert.equal(fs.readFileSync(path.join(alheia, 'nota.md'), 'utf8'), 'minha');
});

test('linkify: título de link, definição, cerca aninhada, %, irmão e descrição multilinha', () => {
    const { files } = buildVault(repo);
    const links = files.get('Docs/Doc · links.md');
    assert.match(links, /^\[t\]\(docs\/guia\.md "título"\) \[p\]\(docs\/100%\.md\)$/m);
    assert.match(links, /^\[ref\]: docs\/guia\.md$/m);
    assert.match(links, /^```\nPRI-9 docs\/guia\.md\n```$/m);
    assert.match(links, /fora \[\[PRI-8\]\]/);
    assert.match(files.get('Tarefas/Tarefa · pri-1 · plan.md'), /\[\[Spec · pri-1\|SPEC\.md\]\]/);
    assert.match(files.get('Skills/Skill · y.md'), /descricao: "linha um linha dois"/);
    assert.match(files.get('Docs/Doc · ação.md'), /atualizado: "\d{4}-\d\d-\d\d"/);
});

test('AC-1/AC-5: --out por symlink, marcador adulterado e CLI', () => {
    const vault = buildVault(repo);
    fs.mkdirSync(path.join(repo, 'sub'));
    fs.symlinkSync(path.join(repo, 'sub'), path.join(tmp, 'lnk'));
    assert.throws(() => writeVault(path.join(tmp, 'lnk', 'v'), repo, vault), UsageError);
    assert.throws(() => writeVault(path.join(repo, '..v'), repo, vault), UsageError);
    const out = path.join(tmp, 'v2');
    const fora = path.join(tmp, 'fora');
    fs.mkdirSync(fora);
    fs.writeFileSync(path.join(fora, 'p.md'), 'precioso');
    writeVault(out, repo, vault);
    const mk = path.join(out, '.espectro-vault.json');
    fs.symlinkSync(fora, path.join(out, 'Link'));
    for (const arquivos of [['00 Início.md', '../x'], ['Link/p.md'], 'x']) {
        fs.writeFileSync(mk, JSON.stringify({ arquivos }));
        assert.throws(() => writeVault(out, repo, vault));
        assert.ok(fs.existsSync(path.join(out, '00 Início.md')), 'nada apagado antes de abortar');
        assert.equal(fs.readFileSync(path.join(fora, 'p.md'), 'utf8'), 'precioso');
    }
    const cli = (...a) => spawnSync(process.execPath, [path.join(__dirname, 'obsidian-export.js'), ...a], { encoding: 'utf8' }).status;
    assert.equal(cli(), 2);
    assert.equal(cli('--out', '--repo', repo), 2);
    assert.equal(cli('--out', path.join(tmp, 'v3'), '--repo', repo), 0);
});
