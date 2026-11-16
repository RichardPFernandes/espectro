'use strict';
// Mapa de capacidades (docs/capacidades/): um teste por regra, em caso sintético e no repo.
const { describe, it } = require('node:test');
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
        });
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

    const unsupported = {
        'arquivo sem cabeçalho': 'Só o corpo.\n',
        'cabeçalho sem linha de fechamento': '---\nid: spec\n',
        'escalar entre aspas': doc({ resumo: '"Gera a spec."' }),
        'escalar com dois-pontos no meio': doc({ resumo: 'Gera: valida.' }),
        'escalar em bloco': doc({ resumo: '|\n  Gera a spec.' }),
        'mapa aninhado': doc({ flags: '\n  nome: SPEC_DRAFT_AUTOGEN' }),
        'mapa em linha': doc({ flags: '{ nome: SPEC_DRAFT_AUTOGEN }' }),
        'campo vazio': doc({ resumo: '' }),
        'campo repetido': doc().replace('tipo: capacidade', 'tipo: capacidade\ntipo: base'),
        'item vazio em lista': doc({ flags: '[SPEC_DRAFT_AUTOGEN, ]' }),
        'lista onde cabe escalar': doc({ id: '[spec]' }),
        'escalar onde cabe lista': doc({ modulos: 'scripts/invalidate.js' }),
        'curinga no meio do padrão': doc({ modulos: '\n  - scripts/*/spec.js' }),
        'id que não serve de nome de arquivo': doc({ id: 'Spec Viva' }),
    };
    for (const [name, text] of Object.entries(unsupported)) {
        it(`recusa forma não suportada: ${name}`, () => {
            assert.throws(() => map.parseHeader(text), /cabeçalho/);
        });
    }
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
        'dashboard/server.js',
        '.claude/commands/plan.md',
        '.graph/schemas/state.schema.json',
    ];
    const notCovered = [
        'scripts/cas.test.js',
        'scripts/fixtures/spec-heading/v1-normal.md',
        'scripts/fixtures/qa-rejection/sentinel-tree.cjs',
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

    it('dependência instalada (node_modules) não entra na cobertura', () => {
        assert.deepEqual(check({ 'scripts/node_modules/lib/index.js': '' }), { total: 3, problems: [] });
    });

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
});
