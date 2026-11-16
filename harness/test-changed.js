'use strict';
// `npm run test:changed [base]`: roda só os testes tocados em relação à base (padrão
// `main`): cada `*.test.js` alterado e o vizinho `<nome>.test.js` de cada arquivo
// alterado. Inclui o que ainda não foi commitado. Atalho local; não substitui `npm test`.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { recipeEnv, ROOT } = require('./recipe');

// Lista de caminhos alterados (relativos à raiz) → testes a rodar, por suíte do harness.
// Tudo fora de dashboard/ roda na suíte scripts, como harness/run-tests.test.js já roda.
function selectTests(changed, exists = rel => fs.existsSync(path.join(ROOT, rel))) {
    const picked = new Set();
    for (const rel of changed) {
        if (/(^|\/)node_modules\//.test(rel)) continue;
        const candidate = rel.endsWith('.test.js') ? rel : rel.replace(/\.[^./]+$/, '.test.js');
        if (candidate.endsWith('.test.js') && exists(candidate)) picked.add(candidate);
    }
    const suites = { scripts: [], dashboard: [] };
    for (const rel of [...picked].sort()) suites[rel.startsWith('dashboard/') ? 'dashboard' : 'scripts'].push(rel);
    return suites;
}

function git(args) {
    const r = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${(r.stderr || '').trim() || `exit ${r.status}`}`);
    return r.stdout.split('\n').filter(Boolean);
}

// Commits desde o ponto em que a branch saiu da base, mais o que está na árvore de trabalho.
function changedFiles(base) {
    const [fork] = git(['merge-base', base, 'HEAD']);
    return [...new Set([...git(['diff', '--name-only', fork]), ...git(['ls-files', '--others', '--exclude-standard'])])];
}

function main([base = 'main']) {
    let suites;
    try {
        suites = selectTests(changedFiles(base));
    } catch (err) {
        console.error(`[test:changed] ${err.message}`);
        process.exitCode = 2;
        return;
    }
    const total = suites.scripts.length + suites.dashboard.length;
    if (!total) {
        console.log(`[test:changed] nenhum teste alterado em relação a ${base}; nada rodou.`);
        return;
    }
    const env = recipeEnv();
    for (const [suite, files] of Object.entries(suites)) {
        if (!files.length) continue;
        console.log(`[test:changed] ${suite}: ${files.join(' ')}`);
        const r = spawnSync(process.execPath, [path.join(__dirname, 'run-tests.js'), suite, ...files.map(f => path.join(ROOT, f))],
            { cwd: ROOT, env, stdio: 'inherit' });
        if (r.status !== 0) process.exitCode = 1;
    }
}

module.exports = { selectTests };
if (require.main === module) main(process.argv.slice(2));
