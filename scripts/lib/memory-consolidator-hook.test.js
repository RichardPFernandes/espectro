// node --test scripts/lib/memory-consolidator-hook.test.js
// Gap apontado (não-bloqueante) no Review de
// memory/runs/2026-09-26-memory-consolidator-padroes-falha/context.md: prova
// isolada de que runMemoryConsolidatorSafe() (scripts/readmine-watcher.js) nunca
// deixa uma exceção de memory-consolidator.js escapar pro tick() do watcher, mesmo
// quando a escrita de memory/patterns.md falha (ex.: diretório inexistente).
// Mesma técnica de scripts/lib/ac-registry.test.js: REPO_PATH sintético +
// require('../readmine-watcher') — CONSOLIDATOR_PATTERNS_PATH/CONSOLIDATOR_STATE_PATH
// são const de módulo (lidas de process.env na hora do require), então precisam
// estar setadas ANTES do require, não podem ser passadas por opts em runtime.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(process.env.CLAUDE_JOB_DIR ? path.join(process.env.CLAUDE_JOB_DIR, 'tmp') : os.tmpdir(), 'memory-consolidator-hook-'));
const repo = path.join(tmp, 'app-back');
fs.mkdirSync(path.join(repo, 'memory', 'runs'), { recursive: true });
process.env.REPO_PATH = repo;
process.env.SKIP_PRE_BUILD_VALIDATION = 'true';
process.env.REDMINE_URL = 'http://redmine.test';
process.env.REDMINE_API_KEY = 'k';
// Força a escrita de memory/patterns.md dentro de um diretório que nunca é criado
// -> fs.writeFileSync(patternsPath, ...) dentro de consolidate() lança ENOENT.
process.env.CONSOLIDATOR_PATTERNS_PATH = path.join(repo, 'diretorio-inexistente', 'patterns.md');
process.env.CONSOLIDATOR_STATE_PATH = path.join(repo, 'memory', 'consolidator-state.json');

const watcher = require('../readmine-watcher');

// threshold default de maybeRun() é 10 — precisa de 10 runs em status terminal
// pra maybeRun() de fato chamar consolidate() (e não só early-return { ran: false }).
for (let i = 1; i <= 10; i++) {
    const dir = path.join(repo, 'memory', 'runs', `run-${i}`);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ task_id: `run-${i}`, status: 'committed' }));
}

test('runMemoryConsolidator: com a escrita de patterns.md forçada a falhar, a exceção propaga (comportamento sem o wrapper Safe)', () => {
    assert.throws(() => watcher.runMemoryConsolidator(), /ENOENT/);
});

test('runMemoryConsolidatorSafe: engole a exceção de runMemoryConsolidator, devolve null e não derruba o processo', () => {
    let result;
    assert.doesNotThrow(() => { result = watcher.runMemoryConsolidatorSafe(); });
    assert.strictEqual(result, null);
    // consolidate() lançou antes de chegar no fs.writeFileSync(statePath, ...) de
    // maybeRun() -> o contador nunca deveria ter sido criado.
    assert.strictEqual(fs.existsSync(process.env.CONSOLIDATOR_STATE_PATH), false);
});

test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
