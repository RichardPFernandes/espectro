// node --test .github/scripts/processo-check-workflow.test.mjs
// Workflow processo-check (F0.16 AC-03), lido como texto: o conferidor de ligações entre specs,
// ADRs e SPECs roda em todo PR com o script da base e as páginas do PR.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FILE = path.join(HERE, '..', 'workflows', 'processo-check.yml');
const yml = fs.existsSync(FILE) ? fs.readFileSync(FILE, 'utf8') : '';
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

/** Caminhos listados no sparse-checkout do checkout cujo `path:` é `dir`. */
function sparse(dir) {
    const step = steps().find((s) => new RegExp(`^\\s+path:\\s*${dir}\\s*$`, 'm').test(s));
    assert.ok(step, `sem checkout em ${dir}`);
    const list = block(/^\s+sparse-checkout:/, step.split('\n')).slice(1);
    return list.map((l) => l.trim()).filter(Boolean);
}

const KL = ['/scripts/knowledge-links.js', '/scripts/lib/knowledge-links.js'];

test('o workflow existe', () => {
    assert.ok(yml.length > 0, `${FILE} ausente`);
});

test('sparse-checkout da base traz os dois arquivos do knowledge-links', () => {
    const base = sparse('base');
    for (const f of KL) assert.ok(base.includes(f), `base sem ${f}`);
});

test('sparse-checkout do head traz as páginas (ADRs, histórico, tasks) e os dois arquivos do knowledge-links', () => {
    const head = sparse('head');
    for (const f of ['/docs/capacidades/', '/docs/adr/', '/docs/historico/', '/tasks/', ...KL]) {
        assert.ok(head.includes(f), `head sem ${f}`);
    }
});

test('passo do knowledge-links: roda --check no head, mesmo se o anterior falhar, com o script da base', () => {
    const step = steps().find((s) => /node head\/scripts\/knowledge-links\.js --check/.test(s));
    assert.ok(step, 'sem passo que roda node head/scripts/knowledge-links.js --check');
    assert.match(step, /if:\s*\$\{\{\s*!cancelled\(\)\s*\}\}/);
    const run = block(/^\s+run:/, step.split('\n')).join('\n');
    const copyScript = run.search(/cp\s+base\/scripts\/knowledge-links\.js\s+head\/scripts\/knowledge-links\.js/);
    const copyLib = run.search(/cp\s+base\/scripts\/lib\/knowledge-links\.js\s+base\/scripts\/lib\/front-matter\.js\s+head\/scripts\/lib\//);
    const exec = run.search(/node head\/scripts\/knowledge-links\.js --check/);
    assert.ok(copyScript >= 0, 'não copia o script da base');
    assert.ok(copyLib >= 0, 'não copia as libs da base');
    assert.ok(exec > copyScript && exec > copyLib, 'roda antes de copiar da base');
    assert.match(run, /base\/scripts\/knowledge-links\.js\s*\]/, 'sem teste de existência na base');
    assert.match(run, /::notice/, 'sem aviso de bootstrap');
});

test('o passo do knowledge-links vem depois do passo que roda o processo-check.mjs', () => {
    const all = steps();
    const iCheck = all.findIndex((s) => /node base\/\.github\/scripts\/processo-check\.mjs/.test(s));
    const iKl = all.findIndex((s) => /node head\/scripts\/knowledge-links\.js --check/.test(s));
    assert.ok(iCheck >= 0, 'sem passo do processo-check.mjs');
    assert.ok(iKl > iCheck, 'passo do knowledge-links não vem depois');
});
