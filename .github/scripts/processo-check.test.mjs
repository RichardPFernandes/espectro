// node --test .github/scripts/processo-check.test.mjs
// Payloads simulados do processo-check (Acordo v2, seção 8).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { evaluate, loadConfig, globToRegExp, evidenceLines, loadCapabilityMap } from './processo-lib.mjs';

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
    assert.equal(run({ labels: ['processo:medio'], body: '## Evidência\nCI verde: https://github.com/x/y/actions/runs/1\n' }).ok, true);
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

test('alto sem Rollback, Readback e SPEC citada → FAIL; completo → OK', () => {
    const r = run({ labels: ['processo:alto'] });
    assert.equal(r.ok, false);
    assert.match(r.errors.join('\n'), /seção "## Rollback"/);
    assert.match(r.errors.join('\n'), /seção "## Readback"/);
    assert.match(r.errors.join('\n'), /citar a SPEC/);
    const body = `${BODY_OK}\nSPEC: [tasks/f1-2-teto/SPEC.md](tasks/f1-2-teto/SPEC.md)\n\n## Rollback\n- reverter o bump para a0\n\n## Readback\n- \`status\` mostra a flag ligada`;
    assert.equal(run({ labels: ['processo:alto'], body }).ok, true);
    assert.equal(run({ labels: ['processo:alto'], body: body.replace('- reverter o bump para a0', '') }).ok, false);
    assert.equal(run({ labels: ['processo:alto'], body: body.replace(/tasks\/f1-2-teto\/SPEC\.md/g, 'tasks/<pasta>/SPEC.md') }).ok, false);
});

// Capacidades sintéticas (nada do consumidor); ownersOf/isCovered são os reais do repo.
const real = loadCapabilityMap();
const cap = (id, spec, modulos) => ({ id, spec, modulos });
const capabilityMap = {
    capabilities: [cap('alfa', 'viva', ['scripts/alfa-*']), cap('beta', 'sem-spec', ['scripts/beta.js'])],
    ownersOf: real.ownersOf,
    isCovered: real.isCovered,
};
const warn = (files) => run({ labels: ['processo:medio'], files, capabilityMap });

test('aviso de capacidade: código com spec viva sem tocar a spec → 1 aviso, sem reprovar', () => {
    const r = warn([file('scripts/alfa-x.js'), file('scripts/alfa-y.js')]);
    assert.equal(r.ok, true);
    assert.deepEqual(r.errors, []);
    assert.equal(r.warnings.length, 1);
    assert.match(r.warnings[0], /Capacidade "alfa".*scripts\/alfa-x\.js, scripts\/alfa-y\.js.*docs\/capacidades\/alfa\.md.*Aviso, não reprova/);
    assert.match(warn(['a', 'b', 'c', 'd'].map((n) => file(`scripts/alfa-${n}.js`))).warnings[0], /\+1\)/);
});

test('aviso de capacidade: tocar a spec no mesmo PR (inclusive renomeada) tira o aviso', () => {
    assert.deepEqual(warn([file('scripts/alfa-x.js'), file('docs/capacidades/alfa.md')]).warnings, []);
    const renamed = { ...file('docs/capacidades/outra.md', 1, 'renamed'), previous_filename: 'docs/capacidades/alfa.md' };
    assert.deepEqual(warn([file('scripts/alfa-x.js'), renamed]).warnings, []);
});

test('aviso de capacidade: sem-spec não avisa, mas entra na linha de info', () => {
    const r = warn([file('scripts/beta.js'), file('scripts/alfa-x.js')]);
    assert.equal(r.warnings.length, 1);
    assert.match(r.info.join('\n'), /capacidades com código alterado: alfa \(viva\), beta \(sem-spec\)/);
    assert.deepEqual(warn([file('scripts/beta.js')]).warnings, []);
});

test('aviso de capacidade: só teste, fixture ou docs alterados não avisa', () => {
    const r = warn([file('scripts/alfa-x.test.js'), file('scripts/fixtures/alfa-y.js'), file('README.md')]);
    assert.deepEqual(r.warnings, []);
    assert.doesNotMatch(r.info.join('\n'), /capacidades com código/);
});

test('aviso de capacidade: código removido ou renomeado de dentro da capacidade conta', () => {
    assert.equal(warn([file('scripts/alfa-x.js', 0, 'removed', 9)]).warnings.length, 1);
    const moved = { ...file('scripts/outro.js', 1, 'renamed'), previous_filename: 'scripts/alfa-x.js' };
    assert.equal(warn([moved]).warnings.length, 1);
});

test('aviso de capacidade: mapa indisponível não muda ok e fica em info', () => {
    const r = run({ labels: ['processo:medio'], files: [file('scripts/alfa-x.js')], capabilityMap: { unavailable: 'sem docs/capacidades' } });
    assert.equal(r.ok, true);
    assert.deepEqual(r.warnings, []);
    assert.match(r.info.join('\n'), /aviso de capacidade indisponível: sem docs\/capacidades/);
    assert.equal(run({ labels: [] }).ok, false);
    assert.deepEqual(run({ labels: ['processo:medio'] }).warnings, []);
    assert.match(loadCapabilityMap({ dir: '/nao/existe' }).unavailable, /\S/);
});

test('CLI com --capabilities: exit 0 com AVISO (1 e 2 cabeçalhos sintéticos)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'processo-cap-'));
    const header = (id, spec) => `---\nid: ${id}\ntipo: capacidade\nresumo: Sintética.\nsituacao: ligada\nspec: ${spec}\nflags: []\nmodulos: [scripts/${id}-*]\n---\n`;
    const files = path.join(dir, 'files.json');
    fs.writeFileSync(files, JSON.stringify([file('scripts/alfa-x.js'), file('scripts/gama-x.js')]));
    const ev = path.join(dir, 'ev.json');
    fs.writeFileSync(ev, JSON.stringify({ pull_request: { number: 1, body: BODY_OK, labels: [{ name: 'processo:medio' }] } }));
    const env = { ...process.env, GITHUB_ACTIONS: '' };
    const caps = path.join(dir, 'caps');
    fs.mkdirSync(caps);
    fs.writeFileSync(path.join(caps, 'alfa.md'), header('alfa', 'viva'));
    const one = spawnSync(process.execPath, [CLI, '--event', ev, '--files', files, '--capabilities', caps], { encoding: 'utf8', env });
    assert.equal(one.status, 0, one.stdout + one.stderr);
    assert.match(one.stdout, /processo-check: PASS[\s\S]*- AVISO: Capacidade "alfa"/);
    fs.writeFileSync(path.join(caps, 'gama.md'), header('gama', 'rascunho'));
    const two = spawnSync(process.execPath, [CLI, '--event', ev, '--files', files, '--capabilities', caps], { encoding: 'utf8', env });
    assert.equal(two.status, 0, two.stdout + two.stderr);
    assert.equal(two.stdout.match(/- AVISO:/g).length, 2);
});
