'use strict';
// Receita oficial de testes (README, "Primeiros passos"; .github/workflows/tests.yml)
// como comando da raiz: `npm test`. Ambiente limpo, roots absolutos, rede só em loopback.
// Não conhece o formato do script `test` de cada pacote: só delega para o npm.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { requiredNode, assertNodeVersion } = require('./run-tests');

const ROOT = path.resolve(__dirname, '..');
const PACKAGES = ['scripts', 'dashboard'];

// Mesmo ambiente do `env -i` da receita (PATH igual ao da CI): nada de quem chama passa.
function recipeEnv(root, scratch) {
    for (const dir of ['home', 'tmp']) fs.mkdirSync(path.join(scratch, dir), { recursive: true });
    return {
        PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`,
        HOME: path.join(scratch, 'home'),
        TMPDIR: path.join(scratch, 'tmp'),
        NODE_OPTIONS: `--require=${path.join(root, 'harness', 'loopback-only.cjs')}`,
        PRISMA_ROOT: root,
        REPO_PATH: root,
    };
}

// Roda fn(env) com um scratch temporário próprio, removido ao final, inclusive em falha.
function withRecipeEnv(fn, root = ROOT) {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'espectro-test-'));
    try {
        return fn(recipeEnv(root, scratch));
    } finally {
        fs.rmSync(scratch, { recursive: true, force: true });
    }
}

// Pacotes sem dependências instaladas; a suíte quebraria no meio com erro pouco claro.
function missingInstalls(root = ROOT, exists = fs.existsSync) {
    return PACKAGES.filter(pkg => !exists(path.join(root, pkg, 'node_modules')));
}

function main() {
    // Mesma conferência do runner, feita uma vez aqui: sem ela, o `npm test` em Node
    // antigo sairia com 1 ("falhou: scripts, dashboard") em vez de 2 com o motivo.
    try {
        assertNodeVersion(process.versions.node, requiredNode());
    } catch (err) {
        console.error(`[recipe] ${err.message}`);
        process.exitCode = 2;
        return;
    }
    const missing = missingInstalls();
    if (missing.length) {
        for (const pkg of missing) console.error(`[recipe] ${pkg}/ sem node_modules. Rode: npm ci --ignore-scripts --no-audit --no-fund --prefix ${pkg}`);
        process.exitCode = 2;
        return;
    }
    const failed = withRecipeEnv(env => PACKAGES.filter(pkg =>
        spawnSync('npm', ['--prefix', path.join(ROOT, pkg), 'test'], { cwd: ROOT, env, stdio: 'inherit' }).status !== 0));
    if (failed.length) console.error(`[recipe] falhou: ${failed.join(', ')}`);
    process.exitCode = failed.length ? 1 : 0;
}

module.exports = { recipeEnv, withRecipeEnv, missingInstalls, ROOT };
if (require.main === module) main();
