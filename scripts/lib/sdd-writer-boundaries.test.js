'use strict';
// PRI-266 F0 — fronteiras estáticas do writer (C-01, C-03, C-18, C-20; P-2). WT-F0-01…06.
// Análise de texto sobre a árvore do checkout (PRISMA_ROOT), parametrizada pela raiz
// para que as sabotagens rodem sobre uma cópia alterada em TMPDIR.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { tmpDir } = require('./sdd-writer-testkit');

const ROOT = process.env.PRISMA_ROOT || path.resolve(__dirname, '..', '..');

// Tokens dos caminhos/refs protegidos do registro SDD.
const PROTECTED_TOKENS = [/docs\/sdd\/(?:capabilities|admitted)/, /catalog\.yaml/, /sdd-op\//, /refs\/tags\/sdd\//];
const CODE_EXT = /\.(?:c?js|mjs|ts|tsx|sh|py)$/;
const SKIP_DIRS = new Set(['node_modules', '.git', 'fixtures', 'coverage', 'dist']);

function walk(dir, out = []) {
    if (!fs.existsSync(dir)) return out;
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        if (SKIP_DIRS.has(ent.name)) continue;
        const p = path.join(dir, ent.name);
        if (ent.isDirectory()) walk(p, out);
        else out.push(p);
    }
    return out;
}

const isWriterFile = rel => /^scripts\/lib\/sdd-writer[^/]*\.js$/.test(rel);

/** Arquivos executáveis (código + instruções de nó/agente) fora do writer que citam caminho protegido. */
function scanProtectedWriters(root) {
    const files = [
        ...walk(path.join(root, 'scripts')), ...walk(path.join(root, 'dashboard')), ...walk(path.join(root, 'harness')),
        ...walk(path.join(root, '.claude', 'commands')), ...walk(path.join(root, '.claude', 'hooks')),
        ...walk(path.join(root, '.claude', 'agents')),
    ].filter(f => CODE_EXT.test(f) || f.includes(`${path.sep}.claude${path.sep}`));
    const hits = [];
    for (const f of files) {
        const rel = path.relative(root, f).split(path.sep).join('/');
        if (isWriterFile(rel)) continue;
        const text = fs.readFileSync(f, 'utf8');
        if (PROTECTED_TOKENS.some(re => re.test(text))) hits.push(rel);
    }
    return hits;
}

const requiresOf = text => [...text.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)].map(m => m[1]);

// C-20 (lista fixada na F0): primitivas genéricas sem semântica de idempotência, CAS ou autorização.
const PROD_ALLOWED = new Set(['node:crypto', 'node:child_process', './spec-hash']);
const TEST_INFRA_ALLOWED = new Set([...PROD_ALLOWED, 'node:fs', 'node:os', 'node:path']);
const TEST_INFRA = new Set(['sdd-writer-testkit.js', 'sdd-writer-hostsim.js']);
const FORBIDDEN = [/(^|\/)cas(\.js)?$/, /(^|\/)state-writer(\.js)?$/, /(^|\/)authorization(\.js)?$/, /(^|\/)db-effect(\.js)?$/, /(^|\/)approvers(\.js)?$/];

/** Violações de import no writer (raiz `root`). */
function scanWriterImports(root) {
    const lib = path.join(root, 'scripts', 'lib');
    const problems = [];
    const writer = fs.readdirSync(lib).filter(f => /^sdd-writer.*\.js$/.test(f) && !f.endsWith('.test.js'));
    for (const f of writer) {
        const allowed = TEST_INFRA.has(f) ? TEST_INFRA_ALLOWED : PROD_ALLOWED;
        for (const spec of requiresOf(fs.readFileSync(path.join(lib, f), 'utf8'))) {
            if (FORBIDDEN.some(re => re.test(spec))) { problems.push(`${f}: proibido ${spec}`); continue; }
            if (/^\.\/sdd-writer-[a-z-]+$/.test(spec)) {
                if (!TEST_INFRA.has(f) && TEST_INFRA.has(`${spec.slice(2)}.js`)) problems.push(`${f}: produção importa infraestrutura de teste ${spec}`);
                continue;
            }
            if (!allowed.has(spec)) problems.push(`${f}: import fora da lista ${spec}`);
        }
    }
    // Fecho transitivo da primitiva spec-hash: nada de CAS, state-writer ou autorização.
    const seen = new Set();
    const visit = rel => {
        if (seen.has(rel)) return;
        seen.add(rel);
        const p = path.join(lib, `${rel}.js`);
        if (!fs.existsSync(p)) return;
        for (const spec of requiresOf(fs.readFileSync(p, 'utf8'))) {
            if (FORBIDDEN.some(re => re.test(spec))) problems.push(`${rel} (transitivo): proibido ${spec}`);
            if (spec.startsWith('./')) visit(spec.slice(2).replace(/\.js$/, ''));
        }
    };
    visit('spec-hash');
    return problems;
}

// C-03/P-1: o writer não lê memória do consumidor, runs, state.json nem Redmine.
const STATE_TOKENS = [/memory\//, /\bruns\//, /state\.json/, /redmine/i];
function scanWriterStateAccess(root) {
    const lib = path.join(root, 'scripts', 'lib');
    const hits = [];
    for (const f of fs.readdirSync(lib).filter(x => /^sdd-writer.*\.js$/.test(x) && !x.endsWith('.test.js'))) {
        const text = fs.readFileSync(path.join(lib, f), 'utf8');
        for (const re of STATE_TOKENS) if (re.test(text)) hits.push(`${f}: ${re}`);
    }
    return hits;
}

/** Cópia mínima da árvore para sabotar sem tocar o checkout. */
function copyTree(root, rels) {
    const dst = tmpDir('sdd-f0-');
    for (const rel of rels) {
        const src = path.join(root, rel);
        if (!fs.existsSync(src)) continue;
        fs.cpSync(src, path.join(dst, rel), { recursive: true, filter: s => !s.includes(`${path.sep}node_modules`) });
    }
    return dst;
}

describe('WT-F0-01 só scripts/lib/sdd-writer* cita/escreve capabilities, catalog.yaml, admitted e refs sdd', () => {
    it('nenhum outro módulo executável', () => {
        assert.deepEqual(scanProtectedWriters(ROOT), []);
    });
});

describe('WT-F0-02 imports do writer (C-18, C-20)', () => {
    it('sem cas, state-writer, authorization, db-effect, approvers; lista fechada de primitivas', () => {
        assert.deepEqual(scanWriterImports(ROOT), []);
    });
    it('produção não importa a infraestrutura de teste', () => {
        const lib = path.join(ROOT, 'scripts', 'lib');
        for (const f of fs.readdirSync(lib).filter(x => /^sdd-writer.*\.js$/.test(x) && !x.endsWith('.test.js') && !TEST_INFRA.has(x))) {
            assert.doesNotMatch(fs.readFileSync(path.join(lib, f), 'utf8'), /sdd-writer-(testkit|hostsim)/, f);
        }
    });
});

describe('WT-F0-03 nenhum acesso a memória do consumidor, runs/, state.json ou Redmine', () => {
    it('ausência confirmada nos módulos do writer', () => {
        assert.deepEqual(scanWriterStateAccess(ROOT), []);
    });
});

describe('WT-F0-04 P-2: o nó Commit não toca capabilities/**, catalog.yaml nem a configuração E-01', () => {
    it('commit.md e os scripts que ele invoca', () => {
        const commitMd = path.join(ROOT, '.claude', 'commands', 'commit.md');
        const text = fs.readFileSync(commitMd, 'utf8');
        for (const re of PROTECTED_TOKENS) assert.doesNotMatch(text, re, `commit.md cita ${re}`);
        const scripts = [...new Set([...text.matchAll(/\$PRISMA_ROOT\/(scripts\/[A-Za-z0-9_./-]+\.js)/g)].map(m => m[1]))];
        assert.ok(scripts.length > 0, 'commit.md deveria invocar scripts da plataforma');
        for (const rel of scripts) {
            const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
            for (const re of PROTECTED_TOKENS) assert.doesNotMatch(src, re, `${rel} cita ${re}`);
        }
    });
});

describe('WT-F0-05 sabotagem: escrita em capabilities/ fora do writer', () => {
    it('WT-F0-01 detecta', () => {
        const root = copyTree(ROOT, ['scripts/lib', '.claude/commands']);
        fs.writeFileSync(path.join(root, 'scripts', 'lib', 'evil-promoter.js'),
            "require('node:fs').writeFileSync('docs/sdd/capabilities/x/log.json', '[]');\n");
        assert.deepEqual(scanProtectedWriters(root), ['scripts/lib/evil-promoter.js']);
    });
});

describe('WT-F0-06 sabotagem: require("../cas") no writer', () => {
    it('WT-F0-02 detecta', () => {
        const root = copyTree(ROOT, ['scripts/lib']);
        const f = path.join(root, 'scripts', 'lib', 'sdd-writer-command.js');
        fs.writeFileSync(f, "const { SKIP } = require('../cas');\n" + fs.readFileSync(f, 'utf8'));
        assert.ok(scanWriterImports(root).some(p => p.includes('proibido ../cas')));
    });
    it('WT-F0-02 detecta cas carregado transitivamente pela primitiva', () => {
        const root = copyTree(ROOT, ['scripts/lib']);
        const f = path.join(root, 'scripts', 'lib', 'spec-hash.js');
        fs.writeFileSync(f, "require('./spec-validator');\n" + fs.readFileSync(f, 'utf8'));
        assert.ok(scanWriterImports(root).some(p => p.includes('transitivo')));
    });
});

describe('Matriz de sabotagem: toda proteção marcada tem teste de sabotagem', () => {
    it('cada // @guard <ID> é referenciado por algum teste do writer', () => {
        const { listGuards } = require('./sdd-writer-testkit');
        const lib = path.join(ROOT, 'scripts', 'lib');
        const tests = fs.readdirSync(lib).filter(f => /^sdd-writer.*\.test\.js$/.test(f)).map(f => fs.readFileSync(path.join(lib, f), 'utf8')).join('\n');
        const missing = listGuards().filter(([, g]) => !tests.includes(`'${g}'`)).map(([f, g]) => `${f}:${g}`);
        assert.deepEqual(missing, []);
        assert.ok(listGuards().length >= 30);
    });
});
