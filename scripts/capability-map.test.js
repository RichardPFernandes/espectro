'use strict';
// Mapa de capacidades (docs/capacidades/): um teste por regra, em caso sintético e no repo.
const { describe, it, mock } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const map = require('./capability-map');

const REPO = path.resolve(__dirname, '..');
const CLI = path.join(__dirname, 'capability-map.js');

const HEADER = {
    id: 'spec',
    tipo: 'capacidade',
    resumo: 'Gera, valida, versiona e invalida a spec de um ticket.',
    situacao: 'ligada',
    spec: 'sem-spec',
    flags: '[SPEC_DRAFT_AUTOGEN, SPEC_AUTO_REPAIR]',
    modulos: '\n  - scripts/lib/spec-*\n  - scripts/invalidate.js',
};

// Monta um arquivo de capacidade; `changes` troca um campo, e `undefined` tira o campo.
function doc(changes = {}) {
    const fields = { ...HEADER, ...changes };
    const lines = Object.entries(fields)
        .filter(([, value]) => value !== undefined)
        .map(([key, value]) => (value.startsWith('\n') ? `${key}:${value}` : `${key}: ${value}`));
    return ['---', ...lines, '---', '', 'Corpo.', ''].join('\n');
}

// Monta os arquivos (caminho relativo → texto) num diretório temporário e o apaga no fim.
function withFiles(files, fn) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'capability-map-'));
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

describe('cabeçalho de uma capacidade', () => {
    it('lê escalar, lista em linha e lista em bloco', () => {
        assert.deepEqual(map.parseHeader(doc()), {
            id: 'spec',
            tipo: 'capacidade',
            resumo: 'Gera, valida, versiona e invalida a spec de um ticket.',
            situacao: 'ligada',
            spec: 'sem-spec',
            flags: ['SPEC_DRAFT_AUTOGEN', 'SPEC_AUTO_REPAIR'],
            modulos: ['scripts/lib/spec-*', 'scripts/invalidate.js'],
            depende_de: [],
            adrs: [],
        });
    });

    it('depende_de e adrs são opcionais: ausentes viram lista vazia', () => {
        const header = map.parseHeader(doc());
        assert.deepEqual(header.depende_de, []);
        assert.deepEqual(header.adrs, []);
    });

    it('lê depende_de e adrs em linha e em bloco', () => {
        const inline = map.parseHeader(doc({ depende_de: '[estado, cas-1]', adrs: '[ADR-0001, ADR-0012]' }));
        assert.deepEqual(inline.depende_de, ['estado', 'cas-1']);
        assert.deepEqual(inline.adrs, ['ADR-0001', 'ADR-0012']);
        const block = map.parseHeader(doc({ depende_de: '\n  - estado\n  - cas', adrs: '\n  - ADR-0003' }));
        assert.deepEqual(block.depende_de, ['estado', 'cas']);
        assert.deepEqual(block.adrs, ['ADR-0003']);
    });

    it('aceita depende_de e adrs em lista vazia', () => {
        const header = map.parseHeader(doc({ depende_de: '[]', adrs: '[]' }));
        assert.deepEqual([header.depende_de, header.adrs], [[], []]);
    });

    it('recusa depende_de e adrs escalares, com mensagem de cabeçalho', () => {
        for (const field of ['depende_de', 'adrs']) {
            assert.throws(
                () => map.parseHeader(doc({ [field]: 'estado' })),
                error => error.message.startsWith('cabeçalho: ') && new RegExp(`${field} deve ser uma lista`).test(error.message),
            );
        }
    });

    it('recusa depende_de com item fora do padrão de id de capacidade', () => {
        for (const bad of ['Estado', 'cas_1', '1cas']) {
            assert.throws(
                () => map.parseHeader(doc({ depende_de: `[estado, ${bad}]` })),
                error => error.message.startsWith('cabeçalho: ') && error.message.includes(`depende_de: "${bad}"`),
            );
        }
    });

    it('recusa adrs com item fora do padrão ADR-NNNN', () => {
        for (const bad of ['ADR-1', 'adr-0001', 'ADR-00012', '0001']) {
            assert.throws(
                () => map.parseHeader(doc({ adrs: `[ADR-0001, ${bad}]` })),
                error => error.message.startsWith('cabeçalho: ') && error.message.includes(`adrs: "${bad}"`),
            );
        }
    });

    it('depende_de e adrs vazios em bloco (sem itens) são campo vazio', () => {
        assert.throws(() => map.parseHeader(doc({ depende_de: '\n' })), /campo vazio: depende_de/);
    });

    it('readFields é exportado e devolve os campos sem validar', () => {
        assert.equal(typeof map.readFields, 'function');
        assert.deepEqual(map.readFields('---\ndepende_de: [a, b]\nqualquer: x\n---\n'), { depende_de: ['a', 'b'], qualquer: 'x' });
    });

    it('aceita lista em linha vazia', () => {
        assert.deepEqual(map.parseHeader(doc({ flags: '[]' })).flags, []);
    });

    it('ignora comentário no fim da linha', () => {
        assert.equal(map.parseHeader(doc({ tipo: 'capacidade   # base | capacidade | fluxo' })).tipo, 'capacidade');
    });

    for (const field of Object.keys(HEADER)) {
        it(`recusa cabeçalho sem o campo ${field}`, () => {
            assert.throws(() => map.parseHeader(doc({ [field]: undefined })), new RegExp(`campo ausente: ${field}`));
        });
    }

    for (const [field, allowed] of [['tipo', 'base, capacidade, fluxo'], ['situacao', 'ligada, parcial, desligada, sem-chamador'], ['spec', 'sem-spec, rascunho, viva']]) {
        it(`recusa valor fora do enum em ${field} e diz os valores aceitos`, () => {
            assert.throws(() => map.parseHeader(doc({ [field]: 'talvez' })), new RegExp(`${field}: "talvez".*${allowed}`));
        });
    }

    // Cada caso diz o motivo: o teste só passa se a recusa for pelo motivo certo.
    const NO_BLOCK = /não começa com um bloco entre duas linhas "---"/;
    const PLAIN = /linha \d+: forma não suportada \(use texto simples, \[a, b\] ou lista com "- "\)/;
    const PAIR = /linha \d+: forma não suportada \(use "campo: valor"\)/;
    const BAD_ID = /deve ter só minúsculas, dígitos e hífen/;
    const unsupported = {
        'arquivo sem cabeçalho': ['Só o corpo.\n', NO_BLOCK],
        'cabeçalho sem linha de fechamento': ['---\nid: spec\n', NO_BLOCK],
        'texto antes do primeiro "---"': [`Antes.\n${doc()}`, NO_BLOCK],
        'escalar entre aspas': [doc({ resumo: '"Gera a spec."' }), PLAIN],
        'escalar com dois-pontos no meio': [doc({ resumo: 'Gera: valida.' }), PLAIN],
        'escalar terminando em dois-pontos': [doc({ resumo: 'Gera:' }), PLAIN],
        'escalar em bloco': [doc({ resumo: '|\n  Gera a spec.' }), PLAIN],
        'mapa aninhado': [doc({ flags: '\n  nome: SPEC_DRAFT_AUTOGEN' }), PAIR],
        'mapa em linha': [doc({ flags: '{ nome: SPEC_DRAFT_AUTOGEN }' }), PLAIN],
        'campo vazio': [doc({ resumo: '' }), /campo vazio: resumo/],
        'campo repetido': [doc().replace('tipo: capacidade', 'tipo: capacidade\ntipo: base'), /linha \d+: campo repetido: tipo/],
        'campo desconhecido (erro de digitação em flags)': [doc({ flag: '[SPEC_DRAFT_AUTOGEN]' }), /campo desconhecido: flag/],
        'item vazio em lista': [doc({ flags: '[SPEC_DRAFT_AUTOGEN, ]' }), PLAIN],
        'lista em linha sem "]"': [doc({ flags: '[SPEC_DRAFT_AUTOGEN, SPEC_AUTO_REPAIR' }), /lista em linha sem "\]"/],
        'lista dentro de item de lista em bloco': [doc({ flags: '\n  - [a, b]' }), PLAIN],
        'item de lista sem chave antes': ['---\n- a\nid: spec\n---\n', PAIR],
        'item de lista depois de escalar': [doc().replace('tipo: capacidade', 'tipo: capacidade\n  - x'), /item de lista fora de uma lista/],
        'lista onde cabe escalar': [doc({ id: '[spec]' }), /id deve ser um texto, não uma lista/],
        'escalar onde cabe lista': [doc({ modulos: 'scripts/invalidate.js' }), /modulos deve ser uma lista/],
        'curinga no meio do padrão': [doc({ modulos: '\n  - scripts/*/spec.js' }), /só aceita "\*" no fim/],
        'id com espaço e maiúscula': [doc({ id: 'Spec Viva' }), BAD_ID],
        'id com sublinhado': [doc({ id: 'spec_viva' }), BAD_ID],
        'id começando por dígito': [doc({ id: '1spec' }), BAD_ID],
    };
    for (const [name, [text, reason]] of Object.entries(unsupported)) {
        it(`recusa forma não suportada: ${name}`, () => {
            assert.throws(() => map.parseHeader(text), error => error.message.startsWith('cabeçalho: ') && reason.test(error.message));
        });
    }

    it('aceita fim de linha CRLF e espaço depois do "---"', () => {
        assert.deepEqual(map.parseHeader(doc().replace(/\n/g, '\r\n')), map.parseHeader(doc()));
        assert.deepEqual(map.parseHeader(doc().replace('---\n', '--- \n')), map.parseHeader(doc()));
    });

    it('linha inteira de comentário é ignorada', () => {
        assert.deepEqual(map.parseHeader(doc().replace('tipo:', '# nota\ntipo:')), map.parseHeader(doc()));
    });

    it('linha enorme de espaços antes de um "#" não trava o parser (tempo linear)', () => {
        const started = Date.now();
        map.parseHeader(doc({ resumo: `Gera${' '.repeat(80000)}a spec.` }));
        assert.ok(Date.now() - started < 1000, 'o parser levou mais de 1 s numa linha de 80 mil espaços');
    });

    it('"#" colado em texto não é comentário; " #" é, como em YAML', () => {
        assert.equal(map.parseHeader(doc({ resumo: 'Lê C# e Java.' })).resumo, 'Lê C# e Java.');
        // Limite aceito: o texto depois de " #" é cortado, como em YAML. Quem precisar do "#" reescreve.
        assert.equal(map.parseHeader(doc({ resumo: 'Trata o ticket #12 hoje.' })).resumo, 'Trata o ticket');
    });

    it('lista em bloco sem indentação não é aceita (limite do subconjunto)', () => {
        assert.throws(() => map.parseHeader(doc({ flags: '\n- A' })), /forma não suportada/);
    });
});

describe('dono de um arquivo', () => {
    const capabilities = [
        { id: 'spec', modulos: ['scripts/lib/spec-*', 'scripts/invalidate.js'] },
        { id: 'estado', modulos: ['scripts/cas.js'] },
    ];

    it('caminho exato casa só com o próprio arquivo', () => {
        assert.deepEqual(map.ownersOf(capabilities, 'scripts/invalidate.js'), ['spec']);
        assert.deepEqual(map.ownersOf(capabilities, 'scripts/invalidate.js.bak'), []);
    });

    it('prefixo terminado em * casa com todo caminho que começa por ele', () => {
        assert.deepEqual(map.ownersOf(capabilities, 'scripts/lib/spec-draft.js'), ['spec']);
        assert.deepEqual(map.ownersOf(capabilities, 'scripts/lib/ac-registry.js'), []);
    });

    it('prefixo ancora no início do caminho e respeita o começo do nome', () => {
        assert.deepEqual(map.ownersOf(capabilities, 'scripts/lib/spec-x.js'), ['spec']);
        assert.deepEqual(map.ownersOf(capabilities, 'dashboard/scripts/lib/spec-x.js'), []);
        assert.deepEqual(map.ownersOf(capabilities, 'scripts/lib/spec.js'), []);
        assert.deepEqual(map.ownersOf(capabilities, 'scripts/lib/specimen.js'), []);
    });

    it('devolve todos os donos quando dois padrões casam', () => {
        const overlapping = [...capabilities, { id: 'medicao', modulos: ['scripts/c*'] }];
        assert.deepEqual(map.ownersOf(overlapping, 'scripts/cas.js'), ['estado', 'medicao']);
    });
});

describe('leitura de docs/capacidades', () => {
    it('lê um arquivo por capacidade, em ordem de id, e deixa o README de fora', () => {
        const files = { 'spec.md': doc(), 'estado.md': doc({ id: 'estado' }), 'README.md': '# Mapa\n' };
        const ids = withFiles(files, dir => map.readCapabilities(dir).map(c => c.id));
        assert.deepEqual(ids, ['estado', 'spec']);
    });

    it('ordena por id mesmo quando o sistema de arquivos devolve fora de ordem', () => {
        const files = { 'b.md': doc({ id: 'b' }), 'a.md': doc({ id: 'a' }), 'c.md': doc({ id: 'c' }) };
        withFiles(files, dir => {
            const real = fs.readdirSync;
            const reversed = mock.method(fs, 'readdirSync', (...args) => real(...args).reverse());
            try {
                assert.deepEqual(map.readCapabilities(dir).map(c => c.id), ['a', 'b', 'c']);
            } finally {
                reversed.mock.restore();
            }
        });
    });

    it('ignora o que não é .md (.DS_Store, notas em .txt)', () => {
        const files = { 'spec.md': doc(), '.DS_Store': 'binário', 'notas.txt': 'não é cabeçalho' };
        assert.deepEqual(withFiles(files, dir => map.readCapabilities(dir).map(c => c.id)), ['spec']);
    });

    it('recusa id diferente do nome do arquivo, citando o arquivo', () => {
        assert.throws(() => withFiles({ 'estado.md': doc() }, dir => map.readCapabilities(dir)), /estado\.md.*id "spec"/);
    });

    it('cita o arquivo quando o cabeçalho é inválido', () => {
        assert.throws(() => withFiles({ 'spec.md': doc({ tipo: 'talvez' }) }, dir => map.readCapabilities(dir)), /spec\.md.*tipo/);
    });
});

// Um repo mínimo em que o mapa fecha: três arquivos de código, todos da capacidade spec,
// e as duas flags do cabeçalho lidas no código dela.
const TREE = {
    'docs/capacidades/spec.md': doc(),
    'scripts/lib/spec-draft.js': "module.exports = process.env.SPEC_DRAFT_AUTOGEN === 'on';\n",
    'scripts/lib/spec-repair.js': "module.exports = process.env.SPEC_AUTO_REPAIR === 'on';\n",
    'scripts/invalidate.js': "'use strict';\n",
};
const ESTADO = doc({ id: 'estado', flags: '[]', modulos: '\n  - scripts/cas.js' });

// Confere o mapa do repo mínimo com os arquivos de `changes` trocados ou acrescentados.
function check(changes = {}) {
    return withFiles({ ...TREE, ...changes }, dir => map.checkMap(dir));
}

describe('o que entra na cobertura (AC-03)', () => {
    const covered = [
        'scripts/cas.js',
        'scripts/lib/spec-draft.js',
        'scripts/hooks/guard.mjs',
        'scripts/fixtures.cjs',
        'scripts/install.sh',
        'scripts/.eslintrc.cjs',
        'scripts/novo.test.mjs', // só *.test.js é teste, como na receita: este precisa de dona
        'dashboard/server.js',
        '.claude/commands/plan.md',
        '.graph/schemas/state.schema.json',
    ];
    const notCovered = [
        'scripts/cas.test.js',
        'scripts/fixtures/spec-heading/v1-normal.md',
        'scripts/fixtures/qa-rejection/sentinel-tree.cjs',
        'scripts/lib/fixtures/seed.js',
        'dashboard/fixtures/seed.js',
        'scripts/package.json',
        'dashboard/public/style.css',
        '.graph/.gitkeep',
        'harness/run-tests.js',
        'docs/capacidades/spec.md',
        '.claude/hooks/processo-level.mjs',
    ];
    for (const file of covered) {
        it(`${file} precisa de capacidade dona`, () => assert.equal(map.isCovered(file), true));
    }
    for (const file of notCovered) {
        it(`${file} fica de fora`, () => assert.equal(map.isCovered(file), false));
    }
});

describe('cobertura do mapa (AC-03)', () => {
    it('mapa fechado não tem problema e conta os arquivos da cobertura', () => {
        assert.deepEqual(check(), { total: 3, problems: [] });
    });

    it('arquivo fora da cobertura não precisa de dona', () => {
        const extras = { 'scripts/cas.test.js': '', 'scripts/package.json': '{}', 'README.md': '# Repo\n' };
        assert.deepEqual(check(extras), { total: 3, problems: [] });
    });

    for (const skipped of ['node_modules', 'dist', 'build', 'coverage']) {
        it(`pasta ${skipped} não entra na cobertura quando não há git`, () => {
            assert.deepEqual(check({ [`scripts/${skipped}/lib/index.js`]: '' }), { total: 3, problems: [] });
        });
    }

    it('arquivo sem dona: cita o arquivo e o comando que confere a correção', () => {
        const { total, problems } = check({ 'scripts/novo.js': '' });
        assert.equal(total, 4);
        assert.deepEqual(problems.map(p => p.rule), ['sem-dona']);
        assert.match(problems[0].message, /^scripts\/novo\.js: sem capacidade dona/);
        assert.match(problems[0].message, /"modulos"/);
        assert.match(problems[0].message, /node scripts\/capability-map\.js --of scripts\/novo\.js/);
    });

    it('arquivo com duas donas: cita o arquivo, as duas capacidades e o comando', () => {
        const overlapping = doc({ id: 'estado', flags: '[]', modulos: '\n  - scripts/cas.js\n  - scripts/inv*' });
        const { problems } = check({ 'docs/capacidades/estado.md': overlapping, 'scripts/cas.js': '' });
        assert.deepEqual(problems.map(p => p.rule), ['mais-de-uma-dona']);
        assert.match(problems[0].message, /^scripts\/invalidate\.js: mais de uma capacidade dona \(estado, spec\)/);
        assert.match(problems[0].message, /node scripts\/capability-map\.js --of scripts\/invalidate\.js/);
    });

    it('padrão que não casa com nenhum arquivo: cita a capacidade, o padrão e o comando', () => {
        const stale = doc({ modulos: '\n  - scripts/lib/spec-*\n  - scripts/invalidate.js\n  - scripts/lib/ac-*' });
        const { problems } = check({ 'docs/capacidades/spec.md': stale });
        assert.deepEqual(problems.map(p => p.rule), ['padrao-sem-arquivo']);
        assert.match(problems[0].message, /^docs\/capacidades\/spec\.md: o padrão "scripts\/lib\/ac-\*" não casa com nenhum arquivo/);
        assert.match(problems[0].message, /node scripts\/capability-map\.js --check/);
    });

    it('junta os problemas de regras diferentes numa só conferência', () => {
        const stale = doc({ modulos: '\n  - scripts/lib/spec-*\n  - scripts/invalidate.js\n  - scripts/lib/ac-*' });
        const { problems } = check({ 'docs/capacidades/spec.md': stale, 'scripts/novo.js': '', 'dashboard/server.js': '' });
        assert.deepEqual(problems.map(p => p.rule).sort(), ['padrao-sem-arquivo', 'sem-dona', 'sem-dona']);
    });
});

// A CI lista os arquivos com `git ls-files`: o ramo com git precisa de teste próprio, num repo
// de verdade (git init), porque os outros testes rodam em pastas sem .git.
describe('listagem de arquivos com git (AC-03)', () => {
    const git = (dir, ...args) => {
        const result = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
        assert.equal(result.status, 0, result.stderr);
    };
    const inGit = (files, fn) => withFiles(files, dir => {
        git(dir, 'init', '-q');
        return fn(dir);
    });

    it('conta o rastreado e o novo não ignorado; o ignorado fica de fora', () => {
        const files = { ...TREE, '.gitignore': 'scripts/gerado.js\n', 'scripts/gerado.js': '' };
        inGit(files, dir => {
            git(dir, 'add', '--', 'scripts/invalidate.js'); // rastreado; o resto é novo, sem add
            assert.deepEqual(map.checkMap(dir), { total: 3, problems: [] });
        });
    });

    it('arquivo rastreado e apagado do disco não conta e não quebra', () => {
        inGit({ ...TREE, 'scripts/velho.js': '' }, dir => {
            git(dir, 'add', '-A');
            fs.rmSync(path.join(dir, 'scripts/velho.js'));
            assert.deepEqual(map.checkMap(dir), { total: 3, problems: [] });
        });
    });

    it('nome com espaço e acento chega inteiro, sem aspas do git', () => {
        inGit({ ...TREE, 'scripts/lib/spec-ação x.js': '' }, dir => {
            assert.deepEqual(map.checkMap(dir), { total: 4, problems: [] });
        });
    });

    it('pasta do tipo build entra quando o git a lista (como na receita)', () => {
        inGit({ ...TREE, 'scripts/build/novo.js': '' }, dir => {
            const { problems } = map.checkMap(dir);
            assert.deepEqual(problems.map(problem => problem.rule), ['sem-dona']);
        });
    });

    it('falha do git vira erro com a causa, não lista vazia', () => {
        withFiles({ ...TREE, '.git/placeholder': '' }, dir => {
            assert.throws(() => map.checkMap(dir), /git ls-files falhou/);
        });
    });
});

describe('flag do cabeçalho aparece no código da capacidade (AC-02)', () => {
    const absent = {
        'não aparece em arquivo nenhum': { 'scripts/lib/spec-repair.js': "'use strict';\n" },
        'só aparece como pedaço de outro nome': { 'scripts/lib/spec-repair.js': 'process.env.SPEC_AUTO_REPAIR_MAX;\n' },
        'só aparece no teste da capacidade': {
            'scripts/lib/spec-repair.js': "'use strict';\n",
            'scripts/lib/spec-repair.test.js': 'process.env.SPEC_AUTO_REPAIR;\n',
        },
        'só aparece no código de outra capacidade': {
            'scripts/lib/spec-repair.js': "'use strict';\n",
            'docs/capacidades/estado.md': ESTADO,
            'scripts/cas.js': 'process.env.SPEC_AUTO_REPAIR;\n',
        },
    };
    for (const [name, changes] of Object.entries(absent)) {
        it(`flag que ${name}: cita a capacidade, a flag e o comando`, () => {
            const { problems } = check(changes);
            assert.deepEqual(problems.map(p => p.rule), ['flag-fora-do-codigo']);
            assert.match(problems[0].message, /^docs\/capacidades\/spec\.md: a flag SPEC_AUTO_REPAIR não aparece/);
            assert.match(problems[0].message, /node scripts\/capability-map\.js --check/);
        });
    }
});

describe('resumo do --check', () => {
    it('mapa fechado: diz quantos arquivos têm dona', () => {
        assert.equal(map.summary({ total: 233, problems: [] }), 'mapa de capacidades: 233 arquivos, cada um com uma capacidade dona');
    });

    it('mapa aberto: conta os arquivos que faltam e cada tipo de problema', () => {
        const problems = [{ rule: 'sem-dona' }, { rule: 'sem-dona' }, { rule: 'mais-de-uma-dona' }, { rule: 'flag-fora-do-codigo' }];
        assert.equal(
            map.summary({ total: 233, problems }),
            'mapa de capacidades: faltam 2 de 233 arquivos (sem capacidade dona); com mais de uma dona: 1; padrões sem arquivo: 0; flags fora do código: 1',
        );
    });
});

describe('mapa do repo', () => {
    it('estado é uma capacidade e é dona de scripts/cas.js', () => {
        const capabilities = map.readCapabilities(path.join(REPO, 'docs', 'capacidades'));
        assert.deepEqual(map.ownersOf(capabilities, 'scripts/cas.js'), ['estado']);
    });

    // AC-03 contra o repo real: arquivo novo sem dona, com duas donas, padrão morto ou flag
    // que sumiu do código reprova aqui, com a mensagem que diz o arquivo e o comando.
    it('todo arquivo de código tem exatamente uma capacidade dona (AC-03)', () => {
        const { problems } = map.checkMap(REPO);
        assert.deepEqual(problems.map(problem => problem.message), []);
    });

    it('a cobertura enxerga os arquivos do repo, não uma lista vazia', () => {
        assert.ok(map.checkMap(REPO).total > 200, 'a cobertura contou menos de 200 arquivos de código');
    });

    it('as 16 capacidades da SPEC existem, sem "outros" nem "misc"', () => {
        const ids = map.readCapabilities(path.join(REPO, 'docs', 'capacidades')).map(capability => capability.id);
        assert.deepEqual(ids, [
            'autorizacao', 'ciclo-da-run', 'config', 'dashboard', 'db-effect', 'estado', 'execucao', 'ferramentas',
            'grafo', 'integracoes', 'medicao', 'portoes', 'qa', 'roteamento', 'sdd-writer', 'spec',
        ]);
    });
});

describe('capability-map.js --of (AC-06)', () => {
    const run = (...args) => spawnSync(process.execPath, [CLI, ...args], { cwd: REPO, encoding: 'utf8' });

    it('imprime o id da capacidade dona e sai 0', () => {
        const result = run('--of', 'scripts/cas.js');
        assert.equal(result.stdout, 'estado\n');
        assert.equal(result.status, 0);
    });

    it('aceita caminho absoluto', () => {
        assert.equal(run('--of', path.join(REPO, 'scripts', 'cas.js')).stdout, 'estado\n');
    });

    it('sai 1 para caminho sem dono, sem imprimir id', () => {
        const result = run('--of', 'nao/existe.js');
        assert.equal(result.status, 1);
        assert.equal(result.stdout, '');
        assert.match(result.stderr, /nao\/existe\.js/);
    });

    it('sai 2 e mostra o uso quando falta o caminho', () => {
        const result = run('--of');
        assert.equal(result.status, 2);
        assert.match(result.stderr, /uso:/);
    });

    it('resolve o caminho a partir da pasta em que roda, não da raiz', () => {
        const result = spawnSync(process.execPath, [CLI, '--of', 'cas.js'], { cwd: path.join(REPO, 'scripts'), encoding: 'utf8' });
        assert.equal(result.stdout, 'estado\n');
        assert.equal(run('--of', './scripts/cas.js').stdout, 'estado\n');
    });

    it('caminho fora do repo sai 1', () => {
        const result = run('--of', path.join(os.tmpdir(), 'qualquer.js'));
        assert.equal(result.status, 1);
        assert.equal(result.stdout, '');
    });

    for (const args of [[], ['--desconhecido'], ['--write', 'x'], ['--check', 'x'], ['--of', 'a.js', 'b.js']]) {
        it(`sai 2 e mostra o uso com os argumentos: ${args.join(' ') || '(nenhum)'}`, () => {
            const result = run(...args);
            assert.equal(result.status, 2);
            assert.match(result.stderr, /uso:/);
            assert.equal(result.stdout, '');
        });
    }
});

// --check e --write de ponta a ponta (AC-03 a AC-05): o script é copiado para um repo mínimo,
// onde a raiz é a pasta acima de scripts/, e roda como processo, para valer o código de saída.
describe('capability-map.js --check e --write', () => {
    const MODULES = '\n  - scripts/capability-map.js\n  - scripts/lib/front-matter.js';
    const MARKERS = '<!-- capacidades:inicio -->\n<!-- capacidades:fim -->';
    const FERRAMENTAS = doc({ id: 'ferramentas', flags: '[]', modulos: MODULES });
    const MINIMAL = {
        'scripts/capability-map.js': fs.readFileSync(CLI, 'utf8'),
        'scripts/lib/front-matter.js': fs.readFileSync(path.join(__dirname, 'lib/front-matter.js'), 'utf8'),
        'docs/capacidades/ferramentas.md': FERRAMENTAS,
        'docs/capacidades/README.md': `# Mapa\n\n## Capacidades\n\n${MARKERS}\n`,
    };

    // Monta o repo mínimo com `changes`, gera a tabela com --write e entrega `run` ao teste.
    function inRepo(changes, fn) {
        return withFiles({ ...MINIMAL, ...changes }, dir => {
            const script = path.join(dir, 'scripts', 'capability-map.js');
            const run = (...args) => spawnSync(process.execPath, [script, ...args], { cwd: dir, encoding: 'utf8' });
            return fn(run, dir);
        });
    }

    it('--write cria a tabela e, na segunda rodada, diz que já estava em dia', () => {
        inRepo({}, run => {
            const first = run('--write');
            assert.equal(first.status, 0);
            assert.match(first.stdout, /tabela atualizada/);
            assert.match(run('--write').stdout, /tabela já estava em dia/);
        });
    });

    it('--check num mapa fechado sai 0, sem nada em stderr', () => {
        inRepo({}, run => {
            run('--write');
            const result = run('--check');
            assert.equal(result.status, 0);
            assert.equal(result.stderr, '');
            assert.match(result.stdout, /2 arquivos, cada um com uma capacidade dona/);
        });
    });

    it('--check no repo real sai 0', () => {
        const result = spawnSync(process.execPath, [CLI, '--check'], { cwd: REPO, encoding: 'utf8' });
        assert.equal(result.stderr, '');
        assert.equal(result.status, 0);
    });

    it('--check com arquivo sem dona sai 1, cita o arquivo e conta no resumo', () => {
        inRepo({ 'scripts/novo.js': '' }, run => {
            run('--write');
            const result = run('--check');
            assert.equal(result.status, 1);
            assert.match(result.stderr, /^scripts\/novo\.js: sem capacidade dona/);
            assert.match(result.stdout, /faltam 1 de 3 arquivos/);
        });
    });

    it('--check com tabela defasada sai 1 e manda rodar --write', () => {
        inRepo({}, (run, dir) => {
            run('--write');
            fs.writeFileSync(path.join(dir, 'docs/capacidades/ferramentas.md'), doc({ id: 'ferramentas', flags: '[]', situacao: 'desligada', modulos: MODULES }));
            const result = run('--check');
            assert.equal(result.status, 1);
            assert.match(result.stderr, /README\.md: a tabela de capacidades está defasada.*--write/);
        });
    });

    it('--check com link relativo quebrado sai 1 e cita o link', () => {
        inRepo({ 'docs/capacidades/ferramentas.md': `${FERRAMENTAS}\n[x](falta.md)\n` }, run => {
            run('--write');
            const result = run('--check');
            assert.equal(result.status, 1);
            assert.match(result.stderr, /ferramentas\.md: o link "falta\.md"/);
        });
    });

    it('--check com cabeçalho inválido sai 2 e cita o arquivo', () => {
        inRepo({ 'docs/capacidades/ferramentas.md': doc({ id: 'ferramentas', tipo: 'talvez', modulos: MODULES }) }, run => {
            const result = run('--check');
            assert.equal(result.status, 2);
            assert.match(result.stderr, /ferramentas\.md.*tipo/);
        });
    });

    it('--of com duas donas sai 1, cita as duas e não imprime id', () => {
        const other = doc({ id: 'outra', flags: '[]', modulos: MODULES });
        inRepo({ 'docs/capacidades/outra.md': other }, run => {
            const result = run('--of', 'scripts/capability-map.js');
            assert.equal(result.status, 1);
            assert.equal(result.stdout, '');
            assert.match(result.stderr, /mais de uma capacidade dona \(ferramentas, outra\)/);
        });
    });

    it('--write sem marcadores no README sai 2', () => {
        inRepo({ 'docs/capacidades/README.md': '# Mapa\n' }, run => {
            const result = run('--write');
            assert.equal(result.status, 2);
            assert.match(result.stderr, /marcadores/);
        });
    });

    it('argumento sobrando em --check sai 2 e mostra o uso', () => {
        inRepo({}, run => {
            const result = run('--check', 'extra');
            assert.equal(result.status, 2);
            assert.match(result.stderr, /uso:/);
        });
    });
});

// Página de entrada e forma de cada capacidade (AC-01, AC-02, AC-07). Lê o repo real: o texto
// só passa se a página tiver as quatro seções, os 19 termos e os tetos de linhas.
describe('página de entrada e capacidades (AC-01, AC-02, AC-07)', () => {
    const DIR = path.join(REPO, 'docs', 'capacidades');
    const readme = fs.readFileSync(path.join(DIR, 'README.md'), 'utf8');
    const lines = text => text.replace(/\n$/, '').split('\n');
    // Corpo de uma seção "## título", sem a linha do título.
    const section = (text, title) => {
        const all = lines(text);
        const start = all.findIndex(line => line === `## ${title}`);
        if (start === -1) return null;
        const end = all.findIndex((line, index) => index > start && line.startsWith('## '));
        return all.slice(start + 1, end === -1 ? undefined : end);
    };
    const GLOSSARY = [
        'Espectro e Prisma', 'consumidor', 'Run', 'watcher', 'tick', 'nó', 'portão', 'gate (G0–G3)', 'spec de ticket',
        'spec viva', 'SPEC de fatia', 'SDD', 'writer de SDD', 'flag', 'fatia', 'AUTORIZO', 'lease', 'Attempt', 'EARS leve',
    ];

    it('README tem até 150 linhas', () => {
        assert.ok(lines(readme).length <= 150, `README.md tem ${lines(readme).length} linhas; o teto é 150`);
    });

    it('README traz as quatro seções, nesta ordem', () => {
        const titles = lines(readme).filter(line => line.startsWith('## ')).map(line => line.slice(3));
        assert.deepEqual(titles, ['O que o Espectro faz', 'Ciclo de uma Run', 'Glossário', 'Capacidades']);
    });

    it('a visão cabe em dez linhas', () => {
        const body = section(readme, 'O que o Espectro faz').filter(line => line.trim());
        assert.ok(body.length >= 1 && body.length <= 10, `a visão tem ${body.length} linhas; o teto é 10`);
    });

    it('o ciclo tem lista numerada e diagrama Mermaid com nós, portões e decisão humana', () => {
        const body = section(readme, 'Ciclo de uma Run').join('\n');
        assert.ok(/^1\. /m.test(body) && /^2\. /m.test(body), 'falta a lista numerada');
        const diagram = /```mermaid\n([\s\S]*?)```/.exec(body);
        assert.ok(diagram, 'falta o bloco ```mermaid');
        for (const node of ['plan', 'implement', 'review', 'test', 'verify', 'commit']) {
            assert.match(diagram[1], new RegExp(`\\b${node}\\b`), `o diagrama não tem o nó ${node}`);
        }
        assert.match(diagram[1], /classDef portao/, 'o diagrama não marca portões (classDef portao)');
        assert.ok((diagram[1].match(/:::portao/g) || []).length >= 3, 'o diagrama tem menos de 3 portões');
        assert.match(diagram[1], /classDef humano/, 'o diagrama não marca decisão humana (classDef humano)');
        assert.ok((diagram[1].match(/:::humano/g) || []).length >= 3, 'o diagrama tem menos de 3 pontos de decisão humana');
    });

    it('o glossário tem os 19 termos, um por item, uma vez cada', () => {
        const items = section(readme, 'Glossário').filter(line => line.startsWith('- '));
        const terms = items.map(line => /^- \*\*(.+?)\*\*: \S/.exec(line)?.[1]);
        assert.deepEqual(terms, GLOSSARY);
    });

    it('"gate" só nomeia nível de revisão em docs/capacidades (AC-07)', () => {
        const offenders = [];
        for (const name of fs.readdirSync(DIR).filter(file => file.endsWith('.md'))) {
            lines(fs.readFileSync(path.join(DIR, name), 'utf8')).forEach((line, index) => {
                if (/\bgates?\b/i.test(line) && !/\bG[0-3]\b/.test(line)) offenders.push(`${name}:${index + 1}: ${line.trim()}`);
            });
        }
        assert.deepEqual(offenders, [], 'use "portão" para a conferência do produto; "gate" só junto de G0–G3');
    });

    // "O que a capacidade faz em duas a quatro frases": o primeiro parágrafo depois do título.
    // Código em linha não conta como fim de frase (`modelo.js` tem ponto, mas não termina nada).
    it('o primeiro parágrafo de cada capacidade tem de 2 a 4 frases (AC-02)', () => {
        const problems = [];
        for (const capability of map.readCapabilities(DIR)) {
            const body = lines(fs.readFileSync(path.join(DIR, `${capability.id}.md`), 'utf8'));
            const title = body.findIndex(line => line.startsWith('# '));
            const rest = body.slice(title + 1).filter((line, index, all) => index >= all.findIndex(text => text.trim()));
            const end = rest.findIndex(line => !line.trim());
            const paragraph = rest.slice(0, end === -1 ? undefined : end).join(' ').replace(/`[^`]*`/g, 'X');
            const sentences = (paragraph.match(/[.!?](\s|$)/g) || []).length;
            if (sentences < 2 || sentences > 4) problems.push(`${capability.id}.md: o primeiro parágrafo tem ${sentences} frases; o certo é de 2 a 4`);
        }
        assert.deepEqual(problems, []);
    });

    // Spec viva (F0.12) cabe numa página, definida em docs/capacidades/README.md como até 80
    // linhas de arquivo; as outras são só cabeçalho e resumo.
    it('cada capacidade tem até 40 linhas (80 com spec viva) e até cinco arquivos por onde começar (AC-02)', () => {
        const problems = [];
        for (const capability of map.readCapabilities(DIR)) {
            const text = fs.readFileSync(path.join(DIR, `${capability.id}.md`), 'utf8');
            const max = capability.spec === 'viva' ? 80 : 40;
            if (lines(text).length > max) problems.push(`${capability.id}.md tem ${lines(text).length} linhas; o teto é ${max}`);
            const start = section(text, 'Por onde começar');
            const items = (start || []).filter(line => /^\d+\. /.test(line));
            if (!start || items.length < 1 || items.length > 5) problems.push(`${capability.id}.md: "Por onde começar" precisa de 1 a 5 itens numerados`);
        }
        assert.deepEqual(problems, []);
    });
});

// Ponteiros para o mapa (AC-08): o README.md da raiz, antes do sumário, e o passo 1 do AGENTS.md.
describe('ponteiros para o mapa (AC-08)', () => {
    const read = name => fs.readFileSync(path.join(REPO, name), 'utf8');

    it('o README.md da raiz aponta para o mapa antes do sumário', () => {
        const text = read('README.md');
        const pointer = text.indexOf('](docs/capacidades/README.md)');
        assert.notEqual(pointer, -1, 'o README.md da raiz não linka docs/capacidades/README.md');
        assert.ok(pointer < text.indexOf('## Sumário'), 'o ponteiro precisa vir antes do sumário');
    });

    it('o passo 1 do AGENTS.md manda começar pelo mapa', () => {
        const step = /^1\. [\s\S]*?(?=^2\. )/m.exec(read('AGENTS.md'));
        assert.ok(step, 'o AGENTS.md não tem o passo 1');
        assert.match(step[0], /docs\/capacidades\/README\.md/);
    });

    it('a página de entrada existe onde os dois ponteiros dizem', () => {
        assert.ok(fs.existsSync(path.join(REPO, 'docs', 'capacidades', 'README.md')));
    });
});

// Tabela de capacidades do README (AC-04): gerada dos cabeçalhos, entre marcadores.
describe('tabela gerada do README (AC-04)', () => {
    const BEGIN = '<!-- capacidades:inicio -->';
    const END = '<!-- capacidades:fim -->';
    const readme = table => ['# Mapa', '', 'Antes.', '', '## Capacidades', '', BEGIN, table, END, '', 'Depois.', ''].join('\n');
    const other = doc({ id: 'estado', tipo: 'base', resumo: 'Guarda o state.json.', situacao: 'parcial', spec: 'rascunho' });
    const files = extra => ({ 'docs/capacidades/spec.md': doc(), 'docs/capacidades/estado.md': other, ...extra });
    const capabilities = () => [map.parseHeader(other), map.parseHeader(doc())];

    it('monta uma linha por capacidade, com link para a página dela', () => {
        assert.deepEqual(map.renderTable(capabilities()).split('\n'), [
            '| Capacidade | Tipo | Situação | Spec | O que faz |',
            '| -- | -- | -- | -- | -- |',
            '| [estado](estado.md) | base | parcial | rascunho | Guarda o state.json. |',
            '| [spec](spec.md) | capacidade | ligada | sem-spec | Gera, valida, versiona e invalida a spec de um ticket. |',
        ]);
    });

    it('protege "|" no resumo para não quebrar a coluna', () => {
        const [row] = map.renderTable([map.parseHeader(doc({ resumo: 'Lê a | b.' }))]).split('\n').slice(2);
        assert.match(row, /Lê a \\\| b\./);
    });

    it('troca só o trecho entre os marcadores', () => {
        const next = map.applyTable(readme('velha'), 'nova');
        assert.equal(next, readme('nova'));
    });

    it('rodar duas vezes não muda nada', () => {
        const once = map.applyTable(readme('velha'), 'nova');
        assert.equal(map.applyTable(once, 'nova'), once);
    });

    it('recusa README sem os dois marcadores, ou fora de ordem', () => {
        assert.throws(() => map.applyTable('# Mapa\n', 'x'), /marcador/);
        assert.throws(() => map.applyTable(`${BEGIN}\n`, 'x'), /marcador/);
        assert.throws(() => map.applyTable(`${END}\n${BEGIN}\n`, 'x'), /marcador/);
        assert.throws(() => map.applyTable(`${END}\n`, 'x'), /marcador/);
    });

    it('tabela defasada falha com a instrução de rodar --write; depois do --write, passa', () => {
        withFiles(files({ 'docs/capacidades/README.md': readme('| velha |') }), dir => {
            assert.match(map.checkTable(dir), /docs\/capacidades\/README\.md.*--write/);
            assert.equal(map.writeTable(dir), true);
            assert.equal(map.checkTable(dir), null);
            assert.equal(map.writeTable(dir), false, 'a segunda rodada não deve mudar nada');
        });
    });

    it('tabela de um cabeçalho que mudou fica defasada', () => {
        withFiles(files({ 'docs/capacidades/README.md': readme('') }), dir => {
            map.writeTable(dir);
            fs.writeFileSync(path.join(dir, 'docs/capacidades/spec.md'), doc({ situacao: 'desligada' }));
            assert.match(map.checkTable(dir), /--write/);
        });
    });

    it('a tabela do README real está em dia', () => {
        assert.equal(map.checkTable(REPO), null);
    });
});

// Links relativos (AC-05): só arquivo local; externo e âncora não são conferidos.
describe('links relativos de docs/capacidades (AC-05)', () => {
    const page = (...links) => `${doc()}\n${links.join('\n')}\n`;
    const check = files => withFiles(files, dir => map.checkLinks(dir));

    it('link para arquivo que não existe falha citando o arquivo e o link', () => {
        const problems = check({
            'docs/capacidades/spec.md': page('Veja [o módulo](../../scripts/nao-existe.js).'),
        });
        assert.equal(problems.length, 1);
        assert.match(problems[0], /docs\/capacidades\/spec\.md/);
        assert.match(problems[0], /\.\.\/\.\.\/scripts\/nao-existe\.js/);
    });

    it('link para arquivo que existe passa, de arquivo, de pasta e de página irmã', () => {
        assert.deepEqual(check({
            'docs/capacidades/spec.md': page('[a](../../scripts/a.js) [b](../../scripts/) [c](estado.md) [d](./estado.md)'),
            'docs/capacidades/estado.md': doc({ id: 'estado' }),
            'scripts/a.js': '',
        }), []);
    });

    it('âncora, link externo e mailto não são conferidos', () => {
        assert.deepEqual(check({
            'docs/capacidades/spec.md': page('[a](#secao) [b](https://exemplo.org/x) [c](http://exemplo.org/y) [d](mailto:a@b.c)'),
        }), []);
    });

    it('a âncora e a query de um link local não contam, mas o arquivo precisa existir', () => {
        const files = { 'docs/capacidades/spec.md': page('[a](estado.md#secao) [b](estado.md?x=1) [c](falta.md#secao)'), 'docs/capacidades/estado.md': doc({ id: 'estado' }) };
        const problems = check(files);
        assert.equal(problems.length, 1);
        assert.match(problems[0], /falta\.md#secao/);
    });

    it('link quebrado depois de um bloco de código fechado ainda é detectado', () => {
        const problems = check({
            'docs/capacidades/spec.md': page('```md', '[x](falta.md)', '```', '[y](falta-depois.md)'),
        });
        assert.equal(problems.length, 1);
        assert.match(problems[0], /falta-depois\.md/);
    });

    it('cerca com ~~~ e cerca indentada também escondem o conteúdo', () => {
        assert.deepEqual(check({
            'docs/capacidades/spec.md': page('~~~', '[x](falta.md)', '~~~', '  ```', '[y](falta2.md)', '  ```'),
        }), []);
    });

    it('link entre < > para arquivo existente com espaço passa', () => {
        assert.deepEqual(check({
            'docs/capacidades/spec.md': page('[a](<com espaco.md>)'),
            'docs/capacidades/com espaco.md': '# x\n',
        }), []);
    });

    it('link que sai da raiz do repo falha, mesmo que o arquivo exista', () => {
        const outside = `fora-${process.pid}-${Date.now()}.md`;
        const outsideFile = path.join(os.tmpdir(), outside);
        fs.writeFileSync(outsideFile, '# fora\n');
        try {
            // A raiz do repo mínimo é uma pasta direta de os.tmpdir(): "../../../x" e "/../x" chegam ao mesmo arquivo.
            const problems = check({
                'docs/capacidades/spec.md': page(`[a](../../../${outside})`, `[b](/../${outside})`, '[c](../../scripts/a.js)', '[d](/..)'),
                'scripts/a.js': '',
            });
            assert.equal(problems.length, 3);
            for (const problem of problems) assert.match(problem, /fora do repositório/);
        } finally {
            fs.rmSync(outsideFile, { force: true });
        }
    });

    it('linha enorme de "[" não trava a conferência (tempo linear)', () => {
        const started = Date.now();
        assert.deepEqual(check({ 'docs/capacidades/spec.md': page('['.repeat(80000)) }), []);
        assert.ok(Date.now() - started < 1000, 'a conferência levou mais de 1 s numa linha de 80 mil "["');
    });

    it('%20 e outros escapes de URL valem pelo nome do arquivo; escape malformado não derruba', () => {
        const files = {
            'docs/capacidades/spec.md': page('[a](com%20espaco.md) [b](falta%20mesmo.md) [c](quebrado%E0%A4%A.md)'),
            'docs/capacidades/com espaco.md': '# x\n',
        };
        const problems = check(files);
        assert.equal(problems.length, 2);
        assert.match(problems[0], /falta%20mesmo\.md/);
        assert.match(problems[1], /quebrado%E0%A4%A\.md/);
    });

    it('confere imagem, link com título e link entre < >', () => {
        const problems = check({
            'docs/capacidades/spec.md': page('![fig](img/falta.png)', '[t](falta-titulo.md "um título")', '[u](<falta angulo.md>)'),
        });
        assert.equal(problems.length, 3);
    });

    it('ignora o que está em bloco de código e em código em linha', () => {
        assert.deepEqual(check({
            'docs/capacidades/spec.md': page('```md', '[x](falta.md)', '```', 'Escreva `[x](falta.md)` assim.'),
        }), []);
    });

    it('confere todos os arquivos .md da pasta, README inclusive', () => {
        const problems = check({
            'docs/capacidades/spec.md': doc(),
            'docs/capacidades/README.md': '# Mapa\n\n[x](falta.md)\n',
        });
        assert.equal(problems.length, 1);
        assert.match(problems[0], /README\.md/);
    });

    it('link com / inicial parte da raiz do repo', () => {
        const files = { 'docs/capacidades/spec.md': page('[a](/scripts/a.js) [b](/scripts/falta.js)'), 'scripts/a.js': '' };
        const problems = check(files);
        assert.equal(problems.length, 1);
        assert.match(problems[0], /\/scripts\/falta\.js/);
    });

    it('os links do mapa real apontam para arquivos que existem', () => {
        assert.deepEqual(map.checkLinks(REPO), []);
    });
});
