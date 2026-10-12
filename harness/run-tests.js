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

function main([suite, ...files]) {
    let roots;
    try {
        roots = resolveRoots(process.env);
        if (!['scripts', 'dashboard'].includes(suite) || !files.length) throw new Error('uso: run-tests.js <scripts|dashboard> <arquivos de teste>');
    } catch (err) {
        console.error(`[test-roots] ${err.message}`);
        process.exitCode = 2;
        return;
    }
    const packageDir = path.join(roots.PRISMA_ROOT, suite);
    const child = spawn(process.execPath, ['--test', '--test-reporter=tap',
        ...files.map(file => path.resolve(packageDir, file))], {
        cwd: roots.REPO_PATH, env: childEnv(process.env, roots), stdio: 'inherit',
    });
    child.on('error', err => { console.error(err.message); process.exitCode = 1; });
    child.on('exit', (code, signal) => {
        if (signal) console.error(`[test-roots] suíte interrompida por ${signal}; não é PASS`);
        process.exitCode = code ?? 1;
    });
}

module.exports = { resolveRoots, childEnv, ENV_ALLOWLIST };
if (require.main === module) main(process.argv.slice(2));
