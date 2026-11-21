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
    'docs/adr/modelo.md': '# Modelo\n',
    'docs/capacidades/README.md': '# Mapa\n',
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
const messages = (dir, name) => rule(dir, name).map(problem => problem.message).join('\n');
const [BEGIN, END] = ['<!-- ligacoes:inicio -->', '<!-- ligacoes:fim -->'];
const [SOLTA, GRAFO] = ['docs/capacidades/solta.md', 'docs/capacidades/grafo.md'];
const INLINE = `Use \`${BEGIN}\` e \`${END}\`.`;

describe('--check: regras de reprovação', () => {
    it('1: ID de capacidade ou de ADR que não existe, em qualquer campo', () => withRepo({
        ...base(),
        [GRAFO]: cap('grafo', { depende_de: '[fantasma]', adrs: '[ADR-0009]' }),
        'docs/adr/0001-a.md': adr(1, { capacidades: '[estado, outra]', substitui: 'ADR-0008', substituida_por: 'ADR-0007' }),
        'tasks/pri-1/SPEC-a.md': page({ capacidades: '[nenhuma]', adrs: '[ADR-0006]' }, '# SPEC'),
    }, dir => {
        for (const id of ['fantasma', 'ADR-0009', 'outra', 'ADR-0008', 'ADR-0007', 'nenhuma', 'ADR-0006']) assert.match(messages(dir, 'id-inexistente'), new RegExp(`"${id}"`));
    }));

    it('2: capacidade e ADR divergem em adrs/capacidades', () => withRepo({
        ...base(),
        'docs/adr/0001-a.md': adr(1, { capacidades: '[grafo]' }),
    }, dir => {
        assert.equal(rule(dir, 'lados-divergem').length, 2);
    }));

    for (const [field, over] of [['substitui', { substitui: 'ADR-0001' }], ['substituida_por', { status: 'substituída', substituida_por: 'ADR-0001' }]]) {
        it(`2: ${field} sem o espelho na outra ADR`, () => withRepo({ ...base(), 'docs/adr/0002-b.md': adr(2, { capacidades: '[]', ...over }) }, dir => {
            const mirror = field === 'substitui' ? 'substituida_por' : 'substitui';
            assert.match(messages(dir, 'lados-divergem'), new RegExp(`^docs/adr/0002-b\\.md: ${field} cita ADR-0001, mas docs/adr/0001-a\\.md não cita ADR-0002 em ${mirror}\\.`));
            assert.equal(rule(dir, 'lados-divergem').length, 1);
        }));
    }

    it('3: ADR sem front-matter, campo obrigatório, id, status ou substituição inválidos', () => withRepo({
        ...base(),
        'docs/adr/0001-a.md': '# ADR 0001: sem cabeçalho\n',
        'docs/adr/0002-b.md': adr(2, { capacidades: undefined }),
        'docs/adr/0003-c.md': adr(3, { id: 'ADR-0004' }),
        'docs/adr/0005-e.md': adr(5, { status: 'substituída' }),
        'docs/adr/0006-f.md': adr(6, { substituida_por: 'ADR-0005' }),
        'docs/adr/0007-g.md': adr(7, { status: 'Aceita em 2026' }),
    }, dir => {
        for (const pattern of [/0001-a\.md: sem front-matter/, /0002-b\.md: .*ausente: capacidades/, /0003-c\.md: .*"ADR-0004".*ADR-0003/, /0005-e\.md: .*substituída.* sem substituida_por/, /0006-f\.md: .*substituida_por.*status "aceita"/, /0007-g\.md: .*status "Aceita em 2026"/]) {
            assert.match(messages(dir, 'adr-invalida'), pattern);
        }
    }));

    it('4: seção ausente, diferente da esperada ou em página sem ligação', () => withRepo(base(), dir => {
        kl.write(dir);
        fs.appendFileSync(path.join(dir, SOLTA), `\n${BEGIN}\n## Ligações\n${END}\n`);
        fs.writeFileSync(path.join(dir, 'docs/adr/0001-a.md'), read(dir, 'docs/adr/0001-a.md').replace('estado.md', 'outra.md'));
        fs.writeFileSync(path.join(dir, GRAFO), cap('grafo', { depende_de: '[estado]' }));
        const files = rule(dir, 'secao').map(problem => problem.message.split(':')[0]).sort();
        assert.deepEqual(files, ['docs/adr/0001-a.md', GRAFO, SOLTA]);
    }));

    for (const [name, tail] of [['só início', BEGIN], ['só fim', END], ['fim antes do início', `${END}\n${BEGIN}`]]) {
        it(`4: marcadores incompletos (${name}): check aponta e write não escreve`, () => withRepo({ ...base(), [SOLTA]: `${cap('solta')}\n${tail}\n` }, dir => {
            const before = read(dir, SOLTA);
            assert.match(messages(dir, 'secao'), /docs\/capacidades\/solta\.md: faltam os marcadores/);
            assert.throws(() => kl.write(dir), /faltam os marcadores/);
            assert.equal(read(dir, SOLTA), before);
        }));
    }
});

describe('--write', () => {
    it('gera links relativos, ordenados, só em página com ligação (SPEC com front-matter), e não mexe no resto', () => withRepo({
        ...base(),
        'tasks/pri-1/SPEC-a.md': page({ capacidades: '[grafo, estado]', adrs: '[ADR-0001]' }, '# SPEC'),
        'docs/historico/pri-2/SPEC-b.md': '# SPEC sem cabeçalho\n',
        'docs/historico/pri-2/SPEC-c.md': page({ capacidades: '[estado]' }, '# SPEC'),
    }, dir => {
        const before = read(dir, 'docs/capacidades/estado.md');
        kl.write(dir);
        assert.equal(read(dir, 'docs/capacidades/estado.md'), `${before}\n${BEGIN}\n## Ligações\n\n- Usada por: [grafo](grafo.md)\n- ADRs: [ADR-0001](../adr/0001-a.md) — Título 1\n${END}\n`);
        assert.match(read(dir, GRAFO), /- Depende de: \[estado\]\(estado\.md\)\n<!-- ligacoes:fim -->\n$/);
        assert.match(read(dir, 'tasks/pri-1/SPEC-a.md'), /- Capacidades: \[estado\]\(\.\.\/\.\.\/docs\/capacidades\/estado\.md\)\n- Capacidades: \[grafo\].*\n- ADRs: \[ADR-0001\]\(\.\.\/\.\.\/docs\/adr\/0001-a\.md\)/);
        assert.equal(read(dir, 'docs/historico/pri-2/SPEC-b.md'), '# SPEC sem cabeçalho\n');
        assert.match(read(dir, 'docs/historico/pri-2/SPEC-c.md'), /- Capacidades: \[estado\]\(\.\.\/\.\.\/capacidades\/estado\.md\)\n<!-- ligacoes:fim -->\n$/);
    }));

    it('arquivo sem newline final: seção com newline final, idempotente, e some quando a ligação some', () => withRepo({ ...base(), [GRAFO]: cap('grafo', { depende_de: '[estado]' }).trimEnd() }, dir => {
        kl.write(dir);
        assert.match(read(dir, GRAFO), /Corpo\.\n\n<!-- ligacoes:inicio -->[^]*<!-- ligacoes:fim -->\n$/);
        assert.deepEqual(kl.write(dir).changed, []);
        fs.writeFileSync(path.join(dir, GRAFO), read(dir, GRAFO).replace('depende_de: [estado]\n', ''));
        kl.write(dir);
        assert.equal(read(dir, GRAFO), cap('grafo'));
        assert.doesNotMatch(read(dir, 'docs/capacidades/estado.md'), /Usada por/);
    }));

    it('marcador citado no texto não é seção: só vale na linha inteira', () => withRepo({
        ...base(),
        [SOLTA]: cap('solta').replace('Corpo.', INLINE),
        [GRAFO]: cap('grafo', { depende_de: '[estado]' }).replace('Corpo.', INLINE),
    }, dir => {
        const solta = read(dir, SOLTA);
        kl.write(dir);
        assert.equal(read(dir, SOLTA), solta);
        assert.equal(read(dir, GRAFO).split(BEGIN).length, 3);
        assert.ok(read(dir, GRAFO).includes(`${INLINE}\n\n${BEGIN}\n## Ligações`));
        assert.deepEqual(kl.check(dir).problems, []);
    }));

    it('não conserta ID inexistente nem lado divergente: devolve os problemas sem escrever', () => withRepo({ ...base(), [GRAFO]: cap('grafo', { depende_de: '[fantasma]' }) }, dir => {
        const result = kl.write(dir);
        assert.equal(result.problems.length, 1);
        assert.deepEqual(result.changed, []);
        assert.equal(read(dir, 'docs/adr/0001-a.md'), adr(1));
    }));
});

describe('CLI', () => {
    const run = (dir, ...args) => spawnSync(process.execPath, [path.join(dir, 'scripts/knowledge-links.js'), ...args], { encoding: 'utf8' });
    const sources = ['knowledge-links.js', 'lib/knowledge-links.js', 'lib/front-matter.js'].map(name => [`scripts/${name}`, read(SCRIPTS, name)]);
    const withCli = (files, fn) => withRepo({ ...files, ...Object.fromEntries(sources) }, fn);

    it('--check reprova (1), --write conserta (0), --check aprova (0) com o resumo', () => withCli(base(), dir => {
        const failed = run(dir, '--check');
        assert.equal(failed.status, 1);
        assert.match(failed.stderr, /docs\/adr\/0001-a\.md: .*--write/);
        assert.equal(run(dir, '--write').status, 0);
        const ok = run(dir, '--check');
        assert.equal(ok.status, 0);
        assert.match(ok.stdout, /ligações: 4 páginas, sem problema/);
    }));

    for (const [name, args, over, status, pattern] of [
        ['argumento desconhecido', ['--outro'], {}, 2, /^uso: /],
        ['cabeçalho ilegível', ['--check'], { [GRAFO]: cap('grafo', { depende_de: '[estado' }) }, 2, /lista em linha sem "\]"/],
        ['--write com ID inexistente (sem escrever)', ['--write'], { [GRAFO]: cap('grafo', { depende_de: '[fantasma]' }) }, 1, /"fantasma"/],
    ]) {
        it(`${name} sai ${status}`, () => withCli({ ...base(), ...over }, dir => {
            const result = run(dir, ...args);
            assert.equal(result.status, status);
            assert.match(result.stderr, pattern);
            assert.equal(read(dir, 'docs/adr/0001-a.md'), adr(1));
        }));
    }
});
