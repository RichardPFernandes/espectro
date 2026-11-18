'use strict';
// Ligações entre specs vivas, ADRs e SPECs: um teste por regra, em repos temporários.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const kl = require('./knowledge-links');

const SCRIPTS = path.resolve(__dirname, '..');
const page = (fields, body) => {
    const lines = Object.entries(fields).filter(([, value]) => value !== undefined).map(([key, value]) => `${key}: ${value}`);
    return `---\n${lines.join('\n')}\n---\n\n${body}\n`;
};
const cap = (id, over = {}) => page({ id, ...over }, `# ${id}\n\nCorpo.`);
const adr = (n, over = {}) => page({ id: `ADR-000${n}`, capacidades: '[estado]', status: 'aceita', ...over }, `# ADR 000${n}: Título ${n}\n\nCorpo.`);
const base = () => ({
    'docs/capacidades/estado.md': cap('estado', { adrs: '[ADR-0001]' }),
    'docs/capacidades/grafo.md': cap('grafo', { depende_de: '[estado]' }),
    'docs/capacidades/solta.md': cap('solta'),
    'docs/adr/0001-a.md': adr(1),
    'docs/adr/README.md': '# ADRs\n',
});

function withRepo(files, fn) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'knowledge-links-'));
    try {
        for (const [name, text] of Object.entries(files)) {
            fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
            fs.writeFileSync(path.join(dir, name), text);
        }
        return fn(dir);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}
const read = (dir, name) => fs.readFileSync(path.join(dir, name), 'utf8');
const rule = (dir, name) => kl.check(dir).problems.filter(problem => problem.rule === name);

describe('--check: regras de reprovação', () => {
    it('aprova o repo com as seções geradas', () => withRepo(base(), dir => {
        kl.write(dir);
        assert.deepEqual(kl.check(dir).problems, []);
    }));

    it('1: ID de capacidade ou de ADR que não existe, em qualquer campo', () => withRepo({
        ...base(),
        'docs/capacidades/grafo.md': cap('grafo', { depende_de: '[fantasma]', adrs: '[ADR-0009]' }),
        'docs/adr/0001-a.md': adr(1, { capacidades: '[estado, outra]', substitui: 'ADR-0008' }),
    }, dir => {
        const messages = rule(dir, 'id-inexistente').map(problem => problem.message).join('\n');
        for (const id of ['fantasma', 'ADR-0009', 'outra', 'ADR-0008']) assert.match(messages, new RegExp(`"${id}"`));
    }));

    it('2: capacidade e ADR divergem em adrs/capacidades', () => withRepo({
        ...base(),
        'docs/adr/0001-a.md': adr(1, { capacidades: '[grafo]' }),
    }, dir => {
        assert.equal(rule(dir, 'lados-divergem').length, 2);
    }));

    it('2: substitui e substituida_por divergem', () => withRepo({
        ...base(),
        'docs/adr/0002-b.md': adr(2, { capacidades: '[]', substitui: 'ADR-0001' }),
    }, dir => {
        const [problem, ...rest] = rule(dir, 'lados-divergem');
        assert.equal(rest.length, 0);
        assert.match(problem.message, /0002-b\.md: substitui cita ADR-0001, mas docs\/adr\/0001-a\.md não cita ADR-0002 em substituida_por/);
    }));

    it('3: status fora do MADR', () => withRepo({ ...base(), 'docs/adr/0001-a.md': adr(1, { status: 'Aceita em 2026' }) }, dir => {
        assert.match(rule(dir, 'adr-invalida')[0].message, /status "Aceita em 2026"/);
    }));

    it('3: substituída sem substituida_por, e substituida_por com outro status', () => withRepo({
        ...base(),
        'docs/capacidades/estado.md': cap('estado'),
        'docs/adr/0001-a.md': adr(1, { status: 'substituída' }),
        'docs/adr/0002-b.md': adr(2, { substituida_por: 'ADR-0001' }),
    }, dir => {
        const messages = rule(dir, 'adr-invalida').map(problem => problem.message).join('\n');
        assert.match(messages, /0001-a\.md: .*substituída.* sem substituida_por/);
        assert.match(messages, /0002-b\.md: .*substituida_por.*status "aceita"/);
    }));

    it('3: ADR sem front-matter, sem campo obrigatório ou com id diferente do nome', () => withRepo({
        ...base(),
        'docs/capacidades/estado.md': cap('estado'),
        'docs/adr/0001-a.md': '# ADR 0001: sem cabeçalho\n',
        'docs/adr/0002-b.md': adr(2, { capacidades: undefined }),
        'docs/adr/0003-c.md': adr(3, { id: 'ADR-0004' }),
    }, dir => {
        const messages = rule(dir, 'adr-invalida').map(problem => problem.message).join('\n');
        assert.match(messages, /0001-a\.md: sem front-matter/);
        assert.match(messages, /0002-b\.md: .*ausente: capacidades/);
        assert.match(messages, /0003-c\.md: .*"ADR-0004".*ADR-0003/);
    }));

    it('4: seção ausente, diferente da esperada ou em página sem ligação', () => withRepo(base(), dir => {
        kl.write(dir);
        const solta = 'docs/capacidades/solta.md';
        fs.appendFileSync(path.join(dir, solta), '\n<!-- ligacoes:inicio -->\n## Ligações\n<!-- ligacoes:fim -->\n');
        fs.writeFileSync(path.join(dir, 'docs/adr/0001-a.md'), read(dir, 'docs/adr/0001-a.md').replace('estado.md', 'outra.md'));
        fs.writeFileSync(path.join(dir, 'docs/capacidades/grafo.md'), cap('grafo', { depende_de: '[estado]' }));
        const files = rule(dir, 'secao').map(problem => problem.message.split(':')[0]).sort();
        assert.deepEqual(files, ['docs/adr/0001-a.md', 'docs/capacidades/grafo.md', solta]);
    }));
});

describe('--write', () => {
    it('gera links relativos, ordenados, só em página com ligação, e não mexe no resto', () => withRepo(base(), dir => {
        const before = read(dir, 'docs/capacidades/estado.md');
        kl.write(dir);
        assert.equal(read(dir, 'docs/capacidades/estado.md'), `${before}\n<!-- ligacoes:inicio -->\n## Ligações\n\n- Usada por: [grafo](grafo.md)\n- ADRs: [ADR-0001](../adr/0001-a.md) — Título 1\n<!-- ligacoes:fim -->\n`);
        assert.match(read(dir, 'docs/capacidades/grafo.md'), /- Depende de: \[estado\]\(estado\.md\)\n<!-- ligacoes:fim -->\n$/);
    }));

    it('é idempotente e desfaz a seção quando a ligação some', () => withRepo(base(), dir => {
        const first = kl.write(dir);
        assert.deepEqual(kl.write(dir).changed, []);
        fs.writeFileSync(path.join(dir, 'docs/capacidades/grafo.md'), read(dir, 'docs/capacidades/grafo.md').replace('depende_de: [estado]\n', ''));
        kl.write(dir);
        assert.equal(read(dir, 'docs/capacidades/grafo.md'), cap('grafo'));
        assert.doesNotMatch(read(dir, 'docs/capacidades/estado.md'), /Usada por/);
    }));

    it('liga SPEC com front-matter e ignora a sem front-matter', () => withRepo({
        ...base(),
        'tasks/pri-1/SPEC-a.md': page({ capacidades: '[estado, grafo]', adrs: '[ADR-0001]' }, '# SPEC'),
        'docs/historico/pri-2/SPEC-b.md': '# SPEC sem cabeçalho\n',
    }, dir => {
        kl.write(dir);
        assert.match(read(dir, 'tasks/pri-1/SPEC-a.md'), /- Capacidades: \[estado\]\(\.\.\/\.\.\/docs\/capacidades\/estado\.md\)\n- Capacidades: \[grafo\].*\n- ADRs: \[ADR-0001\]\(\.\.\/\.\.\/docs\/adr\/0001-a\.md\)/);
        assert.equal(read(dir, 'docs/historico/pri-2/SPEC-b.md'), '# SPEC sem cabeçalho\n');
        assert.doesNotMatch(read(dir, 'docs/capacidades/estado.md'), /SPEC/);
    }));

    it('não conserta ID inexistente nem lado divergente: devolve os problemas sem escrever', () => withRepo({
        ...base(),
        'docs/capacidades/grafo.md': cap('grafo', { depende_de: '[fantasma]' }),
    }, dir => {
        const result = kl.write(dir);
        assert.equal(result.problems.length, 1);
        assert.deepEqual(result.changed, []);
        assert.equal(read(dir, 'docs/adr/0001-a.md'), adr(1));
    }));
});

describe('CLI', () => {
    const run = (dir, ...args) => spawnSync(process.execPath, [path.join(dir, 'scripts/knowledge-links.js'), ...args], { encoding: 'utf8' });
    const withCli = (files, fn) => withRepo({
        ...files,
        'scripts/knowledge-links.js': read(SCRIPTS, 'knowledge-links.js'),
        'scripts/lib/knowledge-links.js': read(SCRIPTS, 'lib/knowledge-links.js'),
        'scripts/lib/front-matter.js': read(SCRIPTS, 'lib/front-matter.js'),
    }, fn);

    it('--check reprova (1), --write conserta (0), --check aprova (0) com o resumo', () => withCli(base(), dir => {
        const failed = run(dir, '--check');
        assert.equal(failed.status, 1);
        assert.match(failed.stderr, /docs\/adr\/0001-a\.md: .*--write/);
        assert.equal(run(dir, '--write').status, 0);
        const ok = run(dir, '--check');
        assert.equal(ok.status, 0);
        assert.match(ok.stdout, /ligações: 4 páginas, sem problema/);
    }));
});
