'use strict';
// Harness somente de testes: não muda a resolução de roots do runtime.
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

// O filho não herda o env de quem roda: config do consumidor, credenciais e
// variáveis de integração mudariam o resultado. Só passam estas chaves + roots.
const ENV_ALLOWLIST = ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'TZ', 'CI', 'NODE_OPTIONS'];

function resolveRoots(env) {
    const roots = {};
    for (const key of ['REPO_PATH', 'PRISMA_ROOT']) {
        if (!env[key] || !path.isAbsolute(env[key])) {
            throw new Error(`${key} deve ser uma raiz absoluta explícita; consulte docs/runbook.md (testes)`);
        }
        if (!fs.existsSync(env[key])) throw new Error(`${key} não existe: ${env[key]}`);
        roots[key] = fs.realpathSync(env[key]);
        if (!fs.statSync(roots[key]).isDirectory()) throw new Error(`${key} deve ser um diretório`);
    }
    if (roots.PRISMA_ROOT !== fs.realpathSync(path.resolve(__dirname, '..'))) {
        throw new Error('PRISMA_ROOT deve identificar esta versão do harness, não latest ou outro checkout');
    }
    for (const rel of ['.claude/spec-hash-config.json', '.claude/config-contract.json', 'scripts/fixtures/ticket-example.json']) {
        const asset = path.join(roots.REPO_PATH, rel);
        if (!fs.existsSync(asset) || !fs.statSync(asset).isFile()) throw new Error(`asset de teste ausente em REPO_PATH: ${rel}`);
    }
    return roots;
}

function childEnv(env, roots) {
    const out = {};
    for (const key of ENV_ALLOWLIST) if (env[key] !== undefined) out[key] = env[key];
    return { ...out, ...roots };
}

// Descoberta por nome: todo `*.test.js` do checkout roda em exatamente uma suíte.
// `dashboard/` vai para a suíte dashboard; o resto, para scripts. Ficam de fora
// só dependências, saída de build, checkouts aninhados (worktrees) e o que
// harness/test-exclusions.json lista com motivo.
const SUITES = ['scripts', 'dashboard'];
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'coverage']);
const EXCLUSIONS_FILE = path.join(__dirname, 'test-exclusions.json');

function findTestFiles(root, rel = '') {
    const found = [];
    for (const entry of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
        const child = rel ? `${rel}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
            if (SKIP_DIRS.has(entry.name) || fs.existsSync(path.join(root, child, '.git'))) continue;
            found.push(...findTestFiles(root, child));
        } else if (entry.isFile() && entry.name.endsWith('.test.js')) {
            found.push(child);
        }
    }
    return found.sort();
}

const suiteOf = rel => (rel.startsWith('dashboard/') ? 'dashboard' : 'scripts');

function readExclusions(file = EXCLUSIONS_FILE) {
    const out = {};
    for (const { arquivo, motivo } of JSON.parse(fs.readFileSync(file, 'utf8')).excluir) {
        if (!arquivo || !motivo || !String(motivo).trim()) throw new Error(`exclusão sem arquivo ou motivo em ${path.basename(file)}`);
        out[arquivo] = motivo;
    }
    return out;
}

function discover(root, suite, exclusions = readExclusions()) {
    const mine = findTestFiles(root).filter(rel => suiteOf(rel) === suite);
    return { files: mine.filter(rel => !(rel in exclusions)), excluded: mine.filter(rel => rel in exclusions) };
}

function main([suite, ...files]) {
    let roots;
    let targets;
    try {
        roots = resolveRoots(process.env);
        if (!SUITES.includes(suite)) throw new Error('uso: run-tests.js <scripts|dashboard> [arquivos de teste]');
        const packageDir = path.join(roots.PRISMA_ROOT, suite);
        targets = files.map(file => path.resolve(packageDir, file));
        if (!files.length) {
            const exclusions = readExclusions();
            const found = discover(roots.PRISMA_ROOT, suite, exclusions);
            for (const rel of found.excluded) console.error(`[test-roots] fora da receita: ${rel} — ${exclusions[rel]}`);
            if (!found.files.length) throw new Error(`nenhum *.test.js descoberto para a suíte ${suite}`);
            targets = found.files.map(rel => path.join(roots.PRISMA_ROOT, rel));
        }
    } catch (err) {
        console.error(`[test-roots] ${err.message}`);
        process.exitCode = 2;
        return;
    }
    const child = spawn(process.execPath, ['--test', '--test-reporter=tap', ...targets], {
        cwd: roots.REPO_PATH, env: childEnv(process.env, roots), stdio: 'inherit',
    });
    child.on('error', err => { console.error(err.message); process.exitCode = 1; });
    child.on('exit', (code, signal) => {
        if (signal) console.error(`[test-roots] suíte interrompida por ${signal}; não é PASS`);
        process.exitCode = code ?? 1;
    });
}

module.exports = { resolveRoots, childEnv, ENV_ALLOWLIST, SUITES, findTestFiles, suiteOf, readExclusions, discover };
if (require.main === module) main(process.argv.slice(2));
