#!/usr/bin/env node
// Reconstrói .graph/ac-registry.json do zero a partir das specs (ver scripts/lib/ac-registry.js).
// Só lê as specs — nunca as altera.
//
// Uso: node scripts/rebuild-ac-registry.js [--specs-dir=<dir>] [--registry=<path>] [--all-md] [--dry-run] [--json]
//   --specs-dir  default memory/spec (relativo à raiz do app-back)
//   --all-md     indexa todo *.md do diretório (task-id = nome do arquivo); sem ele, só
//                <id>-spec.md — 00-overview.md/01-arquitetura.md não são specs de task.
//   --dry-run    só reporta, não grava o registro.
// exit 0 = ok (avisos não falham), 2 = uso incorreto/diretório inexistente.

const fs = require('fs');
const path = require('path');
const acRegistry = require('./lib/ac-registry');

const ROOT = path.resolve(process.env.REPO_PATH || process.cwd());

function listSpecs(specsDir, { allMd = false } = {}) {
    return fs.readdirSync(specsDir, { withFileTypes: true })
        .filter(d => d.isFile() && (allMd ? /\.md$/i.test(d.name) : /-spec\.md$/i.test(d.name)))
        .map(d => ({ file: path.join(specsDir, d.name), taskId: d.name.replace(allMd ? /\.md$/i : /-spec\.md$/i, '') }))
        .sort((a, b) => a.taskId.localeCompare(b.taskId, undefined, { numeric: true }));
}

/**
 * @returns {{registry: object, report: {indexed: string[], withoutACs: string[],
 *   changed: Array<{taskId, added: string[], removed: string[]}>, added: string[], removed: string[]}}}
 */
function rebuild({ specsDir, registryPath, allMd = false, dryRun = false }) {
    let previous;
    try {
        previous = acRegistry.readRegistry(registryPath);
    } catch (e) {
        // Rebuild é justamente a saída pra registro corrompido: avisa e segue do zero.
        console.warn(`[aviso] registro atual ilegível (${e.message}) — reconstruindo sem comparar.`);
        previous = acRegistry.emptyRegistry();
    }
    const now = new Date().toISOString();
    const registry = { version: acRegistry.REGISTRY_VERSION, updatedAt: now, tasks: {} };
    const report = { indexed: [], withoutACs: [], changed: [], added: [], removed: [], provenanceErrors: [] };

    for (const { file, taskId } of listSpecs(specsDir, { allMd })) {
        const content = fs.readFileSync(file, 'utf8');
        const acs = acRegistry.extractACs(content, taskId);
        const prev = previous.tasks[taskId];
        // ac_sources vem do log de provenance (fonte de verdade), nunca do registro anterior:
        // reconstruir do zero — inclusive com o registro corrompido — não perde provenance.
        const projected = acRegistry.acSourcesFor(taskId, { provenanceSpecDir: specsDir });
        if (projected.error) report.provenanceErrors.push(`${taskId}: ${projected.error}`);
        registry.tasks[taskId] = acRegistry.buildEntry(taskId, acs, {
            acSources: projected.sources,
            specContent: content,
            dependsOn: acRegistry.extractDependencies(content, taskId),
            runTaskId: prev && prev.lastRunTaskId,
            now,
        });
        report.indexed.push(taskId);
        if (!acs.criteria.length) report.withoutACs.push(taskId);
        // Compara no que a entrada identifica: IDs (spec com AC-XX) ou texto (legada/v1).
        const before = acRegistry.entryView(prev);
        const after = acRegistry.entryView(registry.tasks[taskId]);
        const keys = v => (v.acIds.length ? v.acIds : v.criteria);
        if (!prev) {
            report.added.push(taskId);
        } else if (JSON.stringify(keys(before)) !== JSON.stringify(keys(after))) {
            report.changed.push({
                taskId,
                added: keys(after).filter(c => !keys(before).includes(c)),
                removed: keys(before).filter(c => !keys(after).includes(c)),
            });
        }
    }
    report.removed = Object.keys(previous.tasks).filter(id => !registry.tasks[id]);

    if (!dryRun) acRegistry.writeRegistryAtomic(registry, registryPath);
    return { registry, report };
}

function printReport(report, { registryPath, dryRun }) {
    console.log(`${dryRun ? '[dry-run] ' : ''}Tasks indexadas: ${report.indexed.length}${dryRun ? '' : ` → ${registryPath}`}`);
    for (const id of report.withoutACs) console.log(`  [aviso] ${id}: spec sem itens em "## Critérios de Aceite"`);
    if (report.added.length) console.log(`Novas no índice: ${report.added.join(', ')}`);
    for (const c of report.changed) {
        console.log(`ACs alterados vs. índice atual: ${c.taskId}`);
        for (const a of c.added) console.log(`  + ${a}`);
        for (const r of c.removed) console.log(`  - ${r}`);
    }
    if (report.removed.length) console.log(`Removidas (spec não existe mais): ${report.removed.join(', ')}`);
    for (const e of report.provenanceErrors || []) console.log(`  [aviso] provenance ilegível (log não alterado, sem ac_sources): ${e}`);
}

module.exports = { rebuild, listSpecs };

if (require.main === module) {
    const flag = name => (process.argv.find(a => a.startsWith(`--${name}=`)) || '').split('=').slice(1).join('=') || null;
    const specsDir = path.resolve(ROOT, flag('specs-dir') || 'memory/spec');
    const registryPath = path.resolve(ROOT, flag('registry') || acRegistry.DEFAULT_REGISTRY_PATH);
    const dryRun = process.argv.includes('--dry-run');
    if (!fs.existsSync(specsDir) || !fs.statSync(specsDir).isDirectory()) {
        console.error(`Diretório de specs não encontrado: ${specsDir}`);
        process.exit(2);
    }
    const { report } = rebuild({ specsDir, registryPath, allMd: process.argv.includes('--all-md'), dryRun });
    if (process.argv.includes('--json')) console.log(JSON.stringify(report, null, 2));
    else printReport(report, { registryPath, dryRun });
}
