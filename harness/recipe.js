'use strict';
// Receita oficial de testes (README, "Primeiros passos"; .github/workflows/tests.yml)
// como comando da raiz: `npm test`. Ambiente limpo, roots absolutos, rede só em loopback.
// Não conhece o formato do script `test` de cada pacote: só delega para o npm.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');

// Mesmo ambiente do `env -i` da receita: nada do ambiente de quem chama passa.
function recipeEnv(root = ROOT, scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'espectro-test-'))) {
    for (const dir of ['home', 'tmp']) fs.mkdirSync(path.join(scratch, dir), { recursive: true });
    return {
        PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`,
        HOME: path.join(scratch, 'home'),
        TMPDIR: path.join(scratch, 'tmp'),
        NODE_OPTIONS: `--require=${path.join(root, 'harness', 'loopback-only.cjs')}`,
        PRISMA_ROOT: root,
        REPO_PATH: root,
    };
}

function main() {
    const env = recipeEnv();
    const failed = [];
    for (const pkg of ['scripts', 'dashboard']) {
        const r = spawnSync('npm', ['--prefix', path.join(ROOT, pkg), 'test'], { cwd: ROOT, env, stdio: 'inherit' });
        if (r.status !== 0) failed.push(`${pkg} (exit ${r.status ?? r.signal ?? r.error?.code})`);
    }
    if (failed.length) console.error(`[recipe] falhou: ${failed.join(', ')}`);
    process.exitCode = failed.length ? 1 : 0;
}

module.exports = { recipeEnv, ROOT };
if (require.main === module) main();
