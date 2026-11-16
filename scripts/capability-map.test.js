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

function withCapabilities(files, fn) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'capability-map-'));
    try {
        for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), text);
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
        const ids = withCapabilities(files, dir => map.readCapabilities(dir).map(c => c.id));
        assert.deepEqual(ids, ['estado', 'spec']);
    });

    it('recusa id diferente do nome do arquivo, citando o arquivo', () => {
        assert.throws(() => withCapabilities({ 'estado.md': doc() }, dir => map.readCapabilities(dir)), /estado\.md.*id "spec"/);
    });

    it('cita o arquivo quando o cabeçalho é inválido', () => {
        assert.throws(() => withCapabilities({ 'spec.md': doc({ tipo: 'talvez' }) }, dir => map.readCapabilities(dir)), /spec\.md.*tipo/);
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
