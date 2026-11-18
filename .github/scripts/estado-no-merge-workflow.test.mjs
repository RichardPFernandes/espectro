// node --test .github/scripts/estado-no-merge-workflow.test.mjs
// Workflow do estado no merge (F0.9 AC-02), lido como texto: gatilhos, liga pela variável,
// não roda código do PR, só leitura no GitHub e o secret só no passo da CLI.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORKFLOWS = path.join(HERE, '..', 'workflows');
const FILE = path.join(WORKFLOWS, 'estado-no-merge.yml');
const read = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '');
const yml = read(FILE);
const lines = yml.split('\n');

/** Bloco que começa na linha que casa `re` e vai até a próxima linha com indentação menor ou igual. */
function block(re, from = lines) {
    const i = from.findIndex((l) => re.test(l));
    if (i < 0) return [];
    const indent = from[i].search(/\S/);
    const out = [from[i]];
    for (const l of from.slice(i + 1)) {
        if (l.trim() !== '' && l.search(/\S/) <= indent) break;
        out.push(l);
    }
    return out;
}

/** Passos do job: cada item que começa com `- ` sob `steps:`. */
function steps() {
    const body = block(/^\s+steps:\s*$/).slice(1);
    const out = [];
    for (const l of body) {
        if (/^\s+- /.test(l) && (out.length === 0 || l.search(/\S/) === out[0][0].search(/\S/))) out.push([l]);
        else if (out.length) out.at(-1).push(l);
    }
    return out.map((s) => s.join('\n'));
}

test('o workflow existe', () => {
    assert.ok(yml.length > 0, `${FILE} ausente`);
});

test('gatilhos: pull_request closed e workflow_dispatch com input pr numérico obrigatório', () => {
    const on = block(/^on:\s*$/).join('\n');
    assert.match(on, /pull_request:\s*\n\s+types:\s*\[\s*closed\s*\]/);
    const pr = block(/^\s+pr:\s*$/, block(/^\s+workflow_dispatch:\s*$/, block(/^on:\s*$/))).join('\n');
    assert.match(pr, /required:\s*true/);
    assert.match(pr, /type:\s*number/);
});

test('if do job: variável em simular/on e, fora do dispatch, só merge na main do mesmo repo', () => {
    const cond = block(/^\s{4}if:/).join(' ');
    assert.match(cond, /vars\.ESTADO_NO_MERGE\s*==\s*'simular'/);
    assert.match(cond, /vars\.ESTADO_NO_MERGE\s*==\s*'on'/);
    assert.match(cond, /github\.event_name\s*==\s*'workflow_dispatch'/);
    assert.match(cond, /github\.event\.pull_request\.merged\s*==\s*true/);
    assert.match(cond, /github\.event\.pull_request\.base\.ref\s*==\s*'main'/);
    assert.match(cond, /github\.event\.pull_request\.head\.repo\.full_name\s*==\s*github\.repository/);
});

test('não faz checkout do código do PR', () => {
    assert.doesNotMatch(yml, /head\.sha|head\.ref|github\.head_ref|merge_commit_sha/);
    const checkouts = steps().filter((s) => /uses:\s*actions\/checkout@/.test(s));
    assert.ok(checkouts.length >= 1, 'sem checkout');
    for (const s of checkouts) {
        assert.match(s, /ref:\s*main\s*$/m);
        assert.match(s, /persist-credentials:\s*false/);
        assert.match(s, /sparse-checkout:[\s|]*\/?\.github\/?\s*$/m);
    }
    assert.doesNotMatch(yml, /npm (ci|install)/);
});

test('permissões só de leitura e concurrency por PR sem cancelar', () => {
    assert.doesNotMatch(yml, /:\s*write\b/);
    assert.doesNotMatch(yml, /write-all/);
    const perms = block(/^permissions:\s*$/).join('\n');
    assert.match(perms, /contents:\s*read/);
    assert.match(perms, /pull-requests:\s*read/);
    const conc = block(/^concurrency:\s*$/).join('\n');
    assert.match(conc, /group:.*github\.event\.pull_request\.number.*inputs\.pr/);
    assert.match(conc, /cancel-in-progress:\s*false/);
});

test('actions pinadas pelos mesmos SHAs dos outros workflows', () => {
    const others = ['processo-check.yml', 'tests.yml', 'roadmap-pages.yml'].map((f) => read(path.join(WORKFLOWS, f))).join('\n');
    const uses = [...yml.matchAll(/uses:\s*(\S+)@(\S+)\s*(#.*)?$/gm)];
    assert.ok(uses.length >= 2, 'esperava checkout e setup-node');
    for (const [, action, sha, comment] of uses) {
        assert.match(sha, /^[0-9a-f]{40}$/, `${action} não está pinada por SHA`);
        assert.ok(comment, `${action} sem comentário de versão`);
        assert.ok(others.includes(`${action}@${sha} ${comment.trim()}`), `${action}@${sha} difere dos outros workflows`);
    }
    assert.match(yml, /actions\/setup-node@[\s\S]*?node-version:\s*'24'/);
});

test('secret só no env do passo que roda a CLI', () => {
    const withSecret = steps().filter((s) => /secrets\./.test(s));
    assert.equal(withSecret.length, 1, 'secret fora de um único passo');
    assert.equal([...yml.matchAll(/secrets\./g)].length, 1, 'secret usado fora do passo da CLI');
    const step = withSecret[0];
    assert.match(step, /node \.github\/scripts\/estado-no-merge\.mjs/);
    const env = block(/^\s+env:\s*$/, step.split('\n')).join('\n');
    assert.match(env, /LINEAR_API_KEY:\s*\$\{\{\s*secrets\.LINEAR_API_KEY\s*\}\}/);
    assert.match(env, /GITHUB_TOKEN:\s*\$\{\{\s*github\.token\s*\}\}/);
    assert.match(env, /ESTADO_NO_MERGE:\s*\$\{\{\s*vars\.ESTADO_NO_MERGE\s*\}\}/);
});

test('o input pr chega ao shell por env, sem interpolação no run', () => {
    const step = steps().find((s) => /estado-no-merge\.mjs/.test(s));
    assert.ok(step, 'sem passo da CLI');
    const stepLines = step.split('\n');
    assert.match(block(/^\s+env:\s*$/, stepLines).join('\n'), /PR:\s*\$\{\{\s*inputs\.pr\s*\}\}/);
    const run = block(/^\s+run:/, stepLines).join('\n');
    assert.doesNotMatch(run, /\$\{\{/, 'expressão interpolada no run');
    assert.match(run, /workflow_dispatch/);
    assert.match(run, /--pr "\$PR"/);
});
