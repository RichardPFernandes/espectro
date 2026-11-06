'use strict';
// Writer SDD (PRI-266) — catalog.yaml como projeção determinística dos log.json
// (PR §3.2: índice sem autoridade; RRC-SDD-001 §4.2; EM §3 prop. 3) e resolução de alias
// (R-RRC-01d A: 2+ vigentes → AMBIGUOUS_ALIAS, sem vencedor por ordem incidental).

const { CAPABILITIES_DIR, logPath, parseCapabilityId } = require('./sdd-writer-command');
const { parseLog, deriveState, aliasKey } = require('./sdd-writer-log');

const HEADER = '# Gerado pelo writer SDD: projeção determinística de capabilities/*/log.json. Não editar.';

/** Slugs com log.json na árvore. */
function capabilitySlugs(tree) {
    const slugs = new Set();
    for (const p of tree.list(CAPABILITIES_DIR).keys()) {
        const m = /^docs\/sdd\/capabilities\/([^/]+)\/log\.json$/.exec(p);
        if (m) slugs.add(m[1]);
    }
    return [...slugs].sort();
}

/** Estado projetado de cada capability da árvore. */
function projectCapabilities(tree, { editResolver = null } = {}) {
    const caps = [];
    for (const slug of capabilitySlugs(tree)) {
        const parsed = parseLog(tree.read(logPath(slug)));
        if (parsed.status !== 'OK') { caps.push({ slug, id: null, status: 'UNKNOWN_BYTES' }); continue; }
        const d = deriveState(parsed.entries, { editResolver });
        const id = parsed.entries[0].command.capability;
        if (!d.ok || parseCapabilityId(id).slug !== slug) { caps.push({ slug, id, status: 'UNKNOWN_STATE' }); continue; }
        caps.push({ slug, id, status: 'OK', state: d.state });
    }
    return caps;
}

const q = s => JSON.stringify(s); // ASCII → string YAML entre aspas duplas válida
const flowActive = a => (a === null ? 'null' : `{cap_version: ${a.cap_version}, cap_hash: ${q(a.cap_hash)}}`);
const flowHead = h => (h === null ? 'null' : `{cap_version: ${h.cap_version}, cap_hash: ${q(h.cap_hash)}, spec_sha256: ${q(h.spec_sha256)}}`);

/** Bytes do catalog.yaml (null quando não há capability). */
function renderCatalog(caps) {
    if (!caps.length) return null;
    const lines = [HEADER, 'schema: "sdd-catalog-v1"', 'capabilities:'];
    for (const c of caps) {
        lines.push(`  - slug: ${q(c.slug)}`);
        lines.push(`    id: ${c.id === null ? 'null' : q(c.id)}`);
        lines.push(`    status: ${q(c.status)}`);
        if (c.status !== 'OK') continue;
        const s = c.state;
        lines.push(`    generation: ${s.generation}`);
        lines.push(`    active: ${flowActive(s.active)}`);
        lines.push(`    version_head: ${flowHead(s.version_head)}`);
        lines.push(`    archived: ${s.archived}`);
        const vs = Object.keys(s.versions).map(Number).sort((a, b) => a - b);
        lines.push(`    versions:${vs.length ? '' : ' []'}`);
        for (const v of vs) lines.push(`      - {cap_version: ${v}, cap_hash: ${q(s.versions[v].cap_hash)}, spec_sha256: ${q(s.versions[v].spec_sha256)}}`);
        if (s.aliases.unknown) { lines.push('    aliases: "UNKNOWN"'); continue; }
        lines.push(`    aliases:${s.aliases.vigentes.length ? '' : ' []'}`);
        for (const a of s.aliases.vigentes) lines.push(`      - {kind: ${q(a.kind)}, value: ${q(a.value)}}`);
        lines.push(`    retired_aliases:${s.aliases.retired.length ? '' : ' []'}`);
        for (const a of s.aliases.retired) lines.push(`      - {kind: ${q(a.kind)}, value: ${q(a.value)}}`);
    }
    return Buffer.from(lines.join('\n') + '\n', 'utf8');
}

const generateCatalog = (tree, opts) => renderCatalog(projectCapabilities(tree, opts));

/** Índice de alias vigentes do projeto: chave → [capability ids]. */
function aliasIndex(caps) {
    const idx = new Map();
    for (const c of caps) {
        if (c.status !== 'OK') continue;
        for (const a of c.state.aliases.vigentes) {
            const k = aliasKey(a);
            if (!idx.has(k)) idx.set(k, []);
            idx.get(k).push(c.id);
        }
    }
    return idx;
}

/** resolve(project, kind, value) da RRC-SDD-001 §4.2 [r3]. */
function resolveAlias(caps, kind, value) {
    const k = aliasKey({ kind, value });
    const vig = caps.filter(c => c.status === 'OK' && c.state.aliases.vigentes.some(a => aliasKey(a) === k)).map(c => c.id);
    if (vig.length === 1) return { status: 'RESOLVED', id: vig[0] };
    if (vig.length > 1) return { status: 'AMBIGUOUS_ALIAS', ids: vig.sort() };
    const ret = caps.filter(c => c.status === 'OK' && c.state.aliases.retired.some(a => aliasKey(a) === k)).map(c => c.id);
    return ret.length ? { status: 'RETIRED', ids: ret.sort() } : { status: 'NOT_FOUND' };
}

/** Valores com 2+ vigentes (fallback da auditoria: os dois ficam AMBIGUOUS_ALIAS). */
function ambiguousAliases(caps) {
    return [...aliasIndex(caps)].filter(([, ids]) => ids.length > 1)
        .map(([k, ids]) => { const [kind, value] = k.split('\u0000'); return { kind, value, ids: ids.sort() }; });
}

module.exports = { capabilitySlugs, projectCapabilities, renderCatalog, generateCatalog, aliasIndex, resolveAlias, ambiguousAliases };
