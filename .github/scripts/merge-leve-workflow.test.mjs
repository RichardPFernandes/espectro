// node --test .github/scripts/merge-leve-workflow.test.mjs
// Regras de segurança dos workflows do merge automático do Leve (F0.8, PRI-410;
// AC-01, AC-04; item c da SPEC). Lê o YAML como texto: nenhuma dependência nova.
// Para cobrir outro workflow, acrescente uma entrada em WORKFLOWS.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const WF_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'workflows');

const WORKFLOWS = [
    { file: 'merge-leve.yml', trigger: 'workflow_run', allowDispatch: false, readsMergeLeve: true },
    { file: 'merge-leve-resumo.yml', trigger: 'schedule', allowDispatch: true, readsMergeLeve: false },
];

// Tira comentários (linha inteira e fim de linha) para que um texto explicativo
// não satisfaça nem viole uma regra.
const stripComments = (text) =>
    text
        .split('\n')
        .filter((l) => !/^\s*#/.test(l))
        .map((l) => l.replace(/\s+#.*$/, ''))
        .join('\n');

const read = (file) => stripComments(fs.readFileSync(path.join(WF_DIR, file), 'utf8'));

for (const wf of WORKFLOWS) {
    test(`${wf.file}: dispara por ${wf.trigger}`, () => {
        const y = read(wf.file);
        assert.match(y, new RegExp(`^\\s+${wf.trigger}:`, 'm'));
    });

    test(`${wf.file}: sem pull_request_target`, () => {
        assert.doesNotMatch(read(wf.file), /pull_request_target/);
    });

    if (!wf.allowDispatch) {
        test(`${wf.file}: sem workflow_dispatch`, () => {
            assert.doesNotMatch(read(wf.file), /workflow_dispatch/);
        });
    }

    test(`${wf.file}: permissions: {} no topo`, () => {
        assert.match(read(wf.file), /^permissions:\s*\{\s*\}\s*$/m);
    });

    test(`${wf.file}: checkout nunca usa o head do evento como ref`, () => {
        const refs = read(wf.file).match(/^\s+ref:.*$/gm) ?? [];
        for (const r of refs) assert.doesNotMatch(r, /head_sha|head_branch|head\.sha|head\.ref/, r);
    });

    test(`${wf.file}: todo checkout com persist-credentials: false`, () => {
        const y = read(wf.file);
        const checkouts = (y.match(/uses:\s*actions\/checkout@/g) ?? []).length;
        const safe = (y.match(/persist-credentials:\s*false/g) ?? []).length;
        assert.ok(checkouts > 0, 'nenhum checkout');
        assert.equal(safe, checkouts);
    });

    test(`${wf.file}: todo uses: fixado por SHA de 40 caracteres`, () => {
        const uses = [...read(wf.file).matchAll(/^\s*(?:-\s+)?uses:\s*(\S+)/gm)].map((m) => m[1]);
        assert.ok(uses.length > 0, 'nenhum uses:');
        for (const u of uses) assert.match(u, /@[0-9a-f]{40}$/, u);
    });

    if (wf.readsMergeLeve) {
        test(`${wf.file}: passa vars.MERGE_LEVE`, () => {
            assert.match(read(wf.file), /MERGE_LEVE:\s*\$\{\{\s*vars\.MERGE_LEVE\s*\}\}/);
        });
    } else {
        test(`${wf.file}: não lê MERGE_LEVE`, () => {
            assert.doesNotMatch(read(wf.file), /MERGE_LEVE/);
        });
    }
}

test('merge-leve.yml: só PR, concorrência por sha, CLI da main', () => {
    const y = read('merge-leve.yml');
    assert.match(y, /workflows:\s*\[\s*Tests\s*,\s*processo-check\s*\]/);
    assert.match(y, /types:\s*\[\s*completed\s*\]/);
    assert.match(y, /if:\s*github\.event\.workflow_run\.event == 'pull_request'/);
    assert.match(y, /concurrency:.*merge-leve-\$\{\{\s*github\.event\.workflow_run\.head_sha\s*\}\}/s);
    assert.match(y, /node \.github\/scripts\/merge-leve\.mjs/);
    for (const p of ['contents: write', 'pull-requests: write', 'actions: write', 'checks: read', 'statuses: read']) {
        assert.ok(y.includes(p), p);
    }
});

test('merge-leve-resumo.yml: cron das 08:00 BRT, só na main, permissões mínimas, CLI da main', () => {
    const y = read('merge-leve-resumo.yml');
    assert.match(y, /^\s+schedule:\s*\n\s+-\s*cron:\s*'0 11 \* \* \*'/m);
    assert.match(y, /^\s+workflow_dispatch:/m);
    assert.match(y, /if:\s*github\.ref == 'refs\/heads\/main'/);
    assert.match(y, /node \.github\/scripts\/merge-leve-resumo\.mjs/);
    for (const p of ['issues: write', 'pull-requests: read', 'checks: read', 'statuses: read']) {
        assert.ok(y.includes(p), p);
    }
    for (const p of ['contents: write', 'pull-requests: write', 'actions: write', 'checks: write', 'statuses: write']) {
        assert.ok(!y.includes(p), p);
    }
});

test('merge-leve-resumo.yml: mesmas actions fixadas e mesmo checkout esparso do merge-leve.yml', () => {
    const uses = (f) => [...read(f).matchAll(/^\s*(?:-\s+)?uses:\s*(\S+)/gm)].map((m) => m[1]);
    assert.deepEqual(uses('merge-leve-resumo.yml'), uses('merge-leve.yml'));
    const y = read('merge-leve-resumo.yml');
    assert.match(y, /sparse-checkout-cone-mode:\s*false/);
    assert.match(y, /sparse-checkout:\s*\|\s*\n\s+\/\.github\/\s*$/m);
    assert.doesNotMatch(y, /^\s+ref:/m);
});

test('tests.yml aceita workflow_dispatch (o merge-leve dispara o Tests na main depois do merge)', () => {
    const yml = read('tests.yml');
    assert.match(yml, /^on:\n(?:  .*\n)*  workflow_dispatch:/m);
});
