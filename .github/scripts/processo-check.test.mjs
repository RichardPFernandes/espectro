// node --test .github/scripts/processo-check.test.mjs
// Payloads simulados do processo-check (Acordo v2, seção 8).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { evaluate, loadConfig, globToRegExp, evidenceLines } from './processo-lib.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, 'processo-check.mjs');
const config = loadConfig();
const templateBody = fs.readFileSync(path.join(HERE, '..', 'pull_request_template.md'), 'utf8');

const BODY_OK = [
    '**Nível:** médio', '**Issue:** Refs PRI-343', '', '## O que muda', 'x', '',
    '## Evidência', '<!-- A evidência mora aqui. Não existe evidence.md separado. -->',
    '| AC | Resultado | Prova |', '| -- | -- | -- |', '| AC-1 | PASS | `node --test` 12/12 |', '',
    '## Riscos', '- nenhum relevante',
].join('\n');
const file = (filename, additions = 1, status = 'modified', deletions = 0) => ({ filename, status, additions, deletions });
const run = (o) => evaluate({ templateBody, config, body: BODY_OK, files: [file('README.md')], ...o });

test('sem rótulo de nível → FAIL com instrução', () => {
    const r = run({ labels: [] });
    assert.equal(r.ok, false);
    assert.match(r.errors.join('\n'), /Sem rótulo de nível\. Adicione exatamente um entre processo:leve, processo:medio, processo:alto/);
});

test('dois rótulos de nível → FAIL', () => {
    const r = run({ labels: ['processo:leve', 'processo:alto', 'Governance'] });
    assert.equal(r.ok, false);
    assert.match(r.errors.join('\n'), /Há 2 rótulos de nível .* Deixe só um\. Para reclassificar, troque o rótulo \(subir de nível exige o Richard\)/);
});

test('leve com SPEC novo → FAIL', () => {
    const r = run({ labels: ['processo:leve'], files: [file('tasks/pri-9/SPEC.md', 30, 'added')] });
    assert.equal(r.ok, false);
    assert.match(r.errors.join('\n'), /Nível leve não admite SPEC, handoff ou evidence separado: tasks\/pri-9\/SPEC\.md/);
});

test('leve com handoff/evidence novos → FAIL; editar SPEC existente não conta como adicionar', () => {
    const bad = run({ labels: ['processo:leve'], files: [file('tasks/a/handoff-x.yaml', 5, 'added'), file('docs/evidence-1.md', 5, 'added'), file('x/handoff.yml', 1, 'renamed')] });
    assert.equal(bad.ok, false);
    assert.match(bad.errors[0], /tasks\/a\/handoff-x\.yaml, docs\/evidence-1\.md, x\/handoff\.yml/);
    assert.equal(run({ labels: ['processo:leve'], files: [file('tasks/pri-9/SPEC.md', 3, 'modified')] }).ok, true);
});

test('leve com 401 linhas → FAIL; 400 → PASS; lockfile/fixture gerado não conta', () => {
    const r401 = run({ labels: ['processo:leve'], files: [file('a.js', 300), file('b.js', 1, 'modified', 100)] });
    assert.equal(r401.ok, false);
    assert.match(r401.errors.join('\n'), /401 linhas alteradas, acima do limite de 400/);
    assert.equal(run({ labels: ['processo:leve'], files: [file('a.js', 300), file('b.js', 0, 'modified', 100)] }).ok, true);
    const ignored = run({ labels: ['processo:leve'], files: [file('a.js', 10), file('scripts/package-lock.json', 5000), file('scripts/fixtures/routing-on-golden.json', 900), file('x/__snapshots__/a.snap', 900)] });
    assert.equal(ignored.ok, true);
    assert.match(ignored.info.join('\n'), /10\/400/);
});

test('médio com SPEC e mais de 400 linhas → PASS', () => {
    const r = run({ labels: ['processo:medio'], files: [file('tasks/pri-9/SPEC.md', 80, 'added'), file('a.js', 900)] });
    assert.deepEqual(r.errors, []);
    assert.equal(r.ok, true);
});

test('Evidência vazia, só com comentário HTML ou com o exemplo do template → FAIL', () => {
    const empty = BODY_OK.replace('| AC-1 | PASS | `node --test` 12/12 |', '');
    assert.match(run({ labels: ['processo:medio'], body: empty }).errors.join('\n'), /seção "## Evidência" está vazia/);
    assert.match(run({ labels: ['processo:medio'], body: templateBody }).errors.join('\n'), /seção "## Evidência" está vazia/);
    assert.match(run({ labels: ['processo:medio'], body: '## Evidência\n<!-- prova aqui\nem várias linhas -->\n## Riscos\n- x' }).errors.join('\n'), /está vazia/);
    assert.match(run({ labels: ['processo:medio'], body: 'sem seção' }).errors.join('\n'), /Falta a seção "## Evidência"/);
    assert.match(run({ labels: ['processo:medio'], body: null }).errors.join('\n'), /Falta a seção/);
});

test('Evidência em prosa, sem tabela, conta', () => {
    assert.equal(run({ labels: ['processo:alto'], body: '## Evidência\nCI verde: https://github.com/x/y/actions/runs/1\n' }).ok, true);
    assert.deepEqual(evidenceLines('## Evidencia\nok\n### sub\nmais', 'Evidência', ''), null);
});

test('placeholder do template editado, linha de tabela vazia e comentário sem fechamento não contam', () => {
    const body = (row) => `## Evidência\n| AC | Resultado | Prova |\n| -- | -- | -- |\n${row}\n`;
    assert.match(run({ labels: ['processo:medio'], body: body('| AC-1 | PASS | <saída de teste, print, link do CI> |') }).errors.join('\n'), /está vazia/);
    assert.match(run({ labels: ['processo:medio'], body: body('| | | |') }).errors.join('\n'), /está vazia/);
    assert.match(run({ labels: ['processo:medio'], body: '## Evidência\n<!-- esqueci de fechar\nprova\n' }).errors.join('\n'), /está vazia/);
});

test('cabeçalho com sufixo vale; "## " dentro de bloco de código não encerra a seção; seção seguinte não conta', () => {
    assert.equal(run({ labels: ['processo:medio'], body: '## Evidência (ACs)\n| AC-1 | PASS | CI verde |' }).ok, true);
    assert.equal(run({ labels: ['processo:medio'], body: '## Evidência\n```\n## saída\nok 14\n```\n' }).ok, true);
    assert.match(run({ labels: ['processo:medio'], body: '## Evidência\n\n## Riscos\n- algum' }).errors.join('\n'), /está vazia/);
    assert.match(run({ labels: ['processo:medio'], body: '## Evidências antigas\nx' }).errors.join('\n'), /Falta a seção/);
});

test('rótulo sem diferenciar maiúsculas; nome proibido sem diferenciar maiúsculas; renamed/copied contam como adição', () => {
    assert.equal(run({ labels: ['Processo:Medio'] }).ok, true);
    assert.match(run({ labels: ['processo:leve', 'PROCESSO:LEVE'] }).info.join(), /nível: leve/);
    const r = run({ labels: ['processo:leve'], files: [file('tasks/a/spec.md', 1, 'added'), file('docs/Evidence-x.md', 1, 'copied')] });
    assert.match(r.errors.join('\n'), /tasks\/a\/spec\.md, docs\/Evidence-x\.md/);
});

test('globs', () => {
    assert.equal(globToRegExp('tasks/**/SPEC*').test('tasks/SPEC.md'), true);
    assert.equal(globToRegExp('tasks/**/SPEC*').test('tasks/a/b/SPEC-s5.2.md'), true);
    assert.equal(globToRegExp('tasks/**/SPEC*').test('docs/SPEC.md'), false);
    assert.equal(globToRegExp('**/evidence*.md').test('evidence.md'), true);
    assert.equal(globToRegExp('**/handoff*.yaml').test('templates/handoff.yaml.template'), false);
    assert.equal(globToRegExp('**/fixtures/**/*golden*.json').test('scripts/fixtures/qa-rejection/golden.json'), true);
    assert.equal(globToRegExp('**/fixtures/**/*golden*.json').test('scripts/fixtures/cost-usage-golden-pri311.json'), true);
});

test('CLI com payload simulado: exit 1 sem rótulo, exit 0 com médio', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'processo-check-'));
    const files = path.join(dir, 'files.json');
    fs.writeFileSync(files, JSON.stringify([file('README.md', 3)]));
    const ev = (labels) => {
        const p = path.join(dir, `ev-${labels.length}.json`);
        fs.writeFileSync(p, JSON.stringify({ pull_request: { number: 1, body: BODY_OK, labels: labels.map((name) => ({ name })) } }));
        return p;
    };
    const env = { ...process.env, GITHUB_ACTIONS: '' };
    const fail = spawnSync(process.execPath, [CLI, '--event', ev([]), '--files', files], { encoding: 'utf8', env });
    assert.equal(fail.status, 1);
    assert.match(fail.stdout, /processo-check: FAIL/);
    const pass = spawnSync(process.execPath, [CLI, '--event', ev(['processo:medio']), '--files', files], { encoding: 'utf8', env });
    assert.equal(pass.status, 0, pass.stdout + pass.stderr);
    assert.match(pass.stdout, /processo-check: PASS\n- nível: medio/);
});
