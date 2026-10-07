// Registro consultável dos Critérios de Aceite de todas as specs (.graph/ac-registry.json).
// Sem ele, os ACs ficam espalhados em memory/spec/<id>-spec.md e não dá pra checar,
// de forma automatizada, se uma task quebra o que uma task predecessora prometeu.
//
// Chave do registro = id do ticket (o mesmo <id> de memory/spec/<id>-spec.md), não o
// task-id do run (<id>-<slug>): a spec é por ticket e sobrevive a vários ciclos
// (Recusa QA gera task nova com a mesma spec). O task-id do último ciclo que indexou
// fica em `lastRunTaskId`, só pra rastreio.
//
// Formato (version 2):
//   { version: 2, updatedAt, tasks: { "<id>": { ticket_id, spec_hash, ac_ids[],
//     indexedAt, dependsOn?[], lastRunTaskId? } } }
// Só os IDs dos critérios (AC-01, AC-02... — ver scripts/lib/ac-ids.js): o texto vive
// na spec, que é a única fonte de verdade dele; spec_hash diz de qual versão da spec
// os IDs vieram. Exceção de compatibilidade: spec anterior aos IDs não tem como ser
// referenciada por ID, então a entrada dela leva `legacy: true` + `criteria[]` (texto,
// como no v1) e `ac_ids: []` — até a spec ser numerada num ciclo novo.
// Entradas v1 ({criteria, specHash}) continuam legíveis e não são reescritas enquanto
// a spec não mudar (o registro é índice derivado, não histórico).
// `dependsOn` (ids citados em "## Dependências" da spec) faz o próprio registro servir
// de graphData pra getRelatedACs.
// `ac_sources` ({ "AC-01": sources[] }) é PROJEÇÃO do log de provenance
// memory/spec/<id>-ac-provenance.json (scripts/lib/ac-provenance.js), que é a fonte de
// verdade: updateRegistry e o rebuild recalculam a projeção a partir do log, então
// apagar/reconstruir o registro não perde provenance (INV-AC-PROVENANCE-02). Sem eventos
// no log, a chave nem aparece (entrada fica igual à de antes da provenance).
//
// Nunca escreve em spec — só lê. Escrita do registro é atômica (tmp + fsync + rename
// no mesmo diretório): leitor concorrente vê o arquivo antigo ou o novo, nunca meio.
//
// Uso como CLI:
//   node scripts/lib/ac-registry.js extract <spec.md> [--task=<id>]   imprime os ACs extraídos
//   node scripts/lib/ac-registry.js related <id> [--registry=<path>]   ACs das predecessoras
//   exit 0 = ok, 2 = uso incorreto/arquivo inexistente.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { parseSections, stripComments } = require('./spec-validator');
const acIdsLib = require('./ac-ids');

const REGISTRY_VERSION = 2;
const DEFAULT_REGISTRY_PATH = path.join(process.env.REPO_PATH || process.cwd(), '.graph', 'ac-registry.json');

// Mesmo casamento de cabeçalho do portão (spec-validator REQUIRED_SECTIONS.criterios_aceite).
const AC_HEADING = /^criterios? de aceit/;
const DEPS_HEADING = /^dependencias?\b/;
const LIST_ITEM = /^(\s*)(?:[-*+]|\d+[.)])\s+(.*)$/;
const CHECKBOX = /^\[[ xX]\]\s*/;

function normalizeContent(specContent) {
    return stripComments(String(specContent || '').replace(/\r\n?/g, '\n'));
}

function findSection(content, match) {
    return parseSections(content.split('\n')).find(s => match.test(s.normalized)) || null;
}

// Cada item de lista vira uma string. Linhas indentadas sem marcador logo abaixo são
// continuação do item (specs quebram critério longo em várias linhas); linha em branco
// encerra o item. Checkbox "[ ]"/"[x]" é removido — é estado, não parte do critério.
function listItems(bodyLines) {
    const items = [];
    let current = null;
    for (const line of bodyLines) {
        const m = LIST_ITEM.exec(line);
        if (m) {
            if (current !== null) items.push(current);
            current = m[2].replace(CHECKBOX, '');
            continue;
        }
        if (current !== null && line.trim() && /^\s/.test(line)) {
            current += ' ' + line.trim();
            continue;
        }
        if (current !== null) { items.push(current); current = null; }
    }
    if (current !== null) items.push(current);
    return items.map(i => i.replace(/\s+/g, ' ').trim()).filter(Boolean);
}

/**
 * @param {string} specContent
 * @param {string} taskId
 * @returns {{taskId: string, criteria: string[], acIds: string[], extractedAt: string}}
 *   Seção com IDs: criteria = texto de cada critério com ID (sem o prefixo), na mesma
 *   ordem de acIds. Sem IDs: acIds = [] e criteria = itens de lista, como sempre.
 *   Uso em memória (plan-scorer, relatório) — o registro grava só acIds.
 */
function extractACs(specContent, taskId) {
    const section = findSection(normalizeContent(specContent), AC_HEADING);
    const parsed = section ? acIdsLib.parseAcItems(section.body) : { hasIds: false, items: [] };
    const acIds = [];
    let criteria = [];
    if (parsed.hasIds) {
        for (const i of parsed.items) {
            if (!i.id || acIds.includes(i.id)) continue;
            acIds.push(i.id);
            criteria.push(i.text);
        }
    } else if (section) {
        criteria = listItems(section.body);
    }
    return { taskId: String(taskId), criteria, acIds, extractedAt: new Date().toISOString() };
}

// Ids de ticket (#12345) citados na seção "## Dependências" — sem a seção, [].
function extractDependencies(specContent, selfId = null) {
    const section = findSection(normalizeContent(specContent), DEPS_HEADING);
    if (!section) return [];
    const ids = new Set();
    for (const m of section.body.join('\n').matchAll(/#(\d{3,})\b/g)) ids.add(m[1]);
    if (selfId != null) ids.delete(String(selfId));
    return [...ids];
}

// Mesmo spec_hash contratual de todo o pipeline (scripts/lib/spec-hash.js, HASH_SCOPE
// atual): o registro reindexa quando o contrato muda, não por comentário/contexto.
function specHash(specContent) {
    return require('./spec-hash').contractHash(String(specContent || ''));
}

function emptyRegistry() {
    return { version: REGISTRY_VERSION, updatedAt: null, tasks: {} };
}

// Arquivo ausente = registro vazio. JSON inválido NÃO vira vazio silenciosamente —
// um upsert em cima disso apagaria o índice inteiro; quem chama decide.
function readRegistry(registryPath = DEFAULT_REGISTRY_PATH) {
    if (!fs.existsSync(registryPath)) return emptyRegistry();
    const data = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
    if (!data || typeof data !== 'object' || typeof data.tasks !== 'object' || data.tasks === null) {
        throw new Error(`${registryPath}: formato inválido (esperado {version, updatedAt, tasks}).`);
    }
    return data;
}

function writeRegistryAtomic(registry, registryPath = DEFAULT_REGISTRY_PATH) {
    const dir = path.dirname(registryPath);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = path.join(dir, `.${path.basename(registryPath)}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`);
    const fd = fs.openSync(tmp, 'w');
    try {
        fs.writeSync(fd, JSON.stringify(registry, null, 2) + '\n');
        fs.fsyncSync(fd);
    } finally {
        fs.closeSync(fd);
    }
    try {
        fs.renameSync(tmp, registryPath);
    } catch (e) {
        try { fs.unlinkSync(tmp); } catch { /* já não existe */ }
        throw e;
    }
}

/**
 * Entrada v2 a partir do que extractACs devolveu.
 * @param {{acIds: string[], criteria: string[]}|string[]} acs  array = critérios de spec legada (API v1)
 */
function buildEntry(ticketId, acs, { specContent, specHash: hash, dependsOn, runTaskId, now, acSources }) {
    if (Array.isArray(acs)) acs = { acIds: [], criteria: acs };
    const entry = {
        ticket_id: String(ticketId),
        spec_hash: hash || (specContent != null ? specHash(specContent) : null),
        ac_ids: [...(acs.acIds || [])],
    };
    if (!entry.ac_ids.length && acs.criteria?.length) {
        entry.legacy = true;
        entry.criteria = [...acs.criteria];
    }
    entry.indexedAt = now;
    if (dependsOn && dependsOn.length) entry.dependsOn = dependsOn.map(String);
    if (runTaskId) entry.lastRunTaskId = String(runTaskId);
    if (acSources && Object.keys(acSources).length) entry.ac_sources = acSources;
    return entry;
}

// Diretório das specs (e dos logs de provenance) de um registro: <raiz>/.graph/ac-registry.json
// → <raiz>/memory/spec.
function specDirForRegistry(registryPath) {
    return path.join(path.resolve(registryPath, '..', '..'), 'memory', 'spec');
}

/**
 * Projeção de provenance do ticket para o registro. Log ilegível: sem projeção nova e
 * `error` (quem chama mantém a anterior — o log é a verdade, o registro só espelha).
 */
function acSourcesFor(ticketId, { provenanceSpecDir, registryPath = DEFAULT_REGISTRY_PATH } = {}) {
    return require('./ac-provenance').projectionFor(ticketId, { specDir: provenanceSpecDir || specDirForRegistry(registryPath) });
}

// Lê v1 e v2 no mesmo formato de comparação: {hash, acIds, criteria}.
function entryView(entry) {
    if (!entry) return null;
    return {
        hash: entry.spec_hash ?? entry.specHash ?? null,
        acIds: Array.isArray(entry.ac_ids) ? entry.ac_ids : [],
        criteria: Array.isArray(entry.criteria) ? entry.criteria : [],
    };
}

/**
 * Upsert de uma task no registro (read-modify-write, escrita atômica).
 * @param {string} taskId  id do ticket
 * @param {{acIds: string[], criteria: string[]}} acs  retorno de extractACs
 * @param {{registryPath?: string, specContent?: string, specHash?: string,
 *          dependsOn?: string[], runTaskId?: string}} [opts]
 * @returns {{changed: boolean, entry: object}} changed=false se spec/ACs/dependsOn já batiam
 *   (inclui entrada v1 da mesma spec — não é reescrita só pra trocar de formato).
 */
function updateRegistry(taskId, acs, opts = {}) {
    const registryPath = opts.registryPath || DEFAULT_REGISTRY_PATH;
    const registry = readRegistry(registryPath);
    const now = new Date().toISOString();
    const key = String(taskId);
    const prev = registry.tasks[key];
    const projected = opts.acSources ? { sources: opts.acSources } : acSourcesFor(key, { provenanceSpecDir: opts.provenanceSpecDir, registryPath });
    const acSources = projected.error ? prev?.ac_sources : projected.sources;
    const entry = buildEntry(key, acs, { ...opts, now, acSources });
    const p = entryView(prev);
    const n = entryView(entry);
    const same = prev
        && p.hash === n.hash
        && JSON.stringify(p.acIds) === JSON.stringify(n.acIds)
        && JSON.stringify(p.criteria) === JSON.stringify(n.criteria)
        && JSON.stringify(prev.dependsOn || []) === JSON.stringify(entry.dependsOn || [])
        && JSON.stringify(prev.ac_sources || {}) === JSON.stringify(entry.ac_sources || {});
    if (same) return { changed: false, entry: prev };
    registry.version = REGISTRY_VERSION;
    registry.updatedAt = now;
    registry.tasks[key] = entry;
    writeRegistryAtomic(registry, registryPath);
    return { changed: true, entry };
}

// Aceita os formatos de grafo de dependência que aparecem na prática:
//   { tasks: { "<id>": { dependsOn|depends_on|predecessors: [...] } } }  (inclui o próprio registro)
//   { edges: [{ from, to }] }   — from precede to
//   { "<id>": [...predecessoras] }
function predecessorsOf(graphData, id) {
    if (!graphData || typeof graphData !== 'object') return [];
    const out = [];
    if (Array.isArray(graphData.edges)) {
        for (const e of graphData.edges) if (e && normId(e.to) === id && e.from != null) out.push(normId(e.from));
    }
    const node = graphData.tasks && typeof graphData.tasks === 'object' ? graphData.tasks[id] : undefined;
    if (node && typeof node === 'object') {
        for (const k of ['dependsOn', 'depends_on', 'predecessors']) {
            if (Array.isArray(node[k])) out.push(...node[k].map(normId));
        }
    }
    if (!graphData.tasks && !graphData.edges && Array.isArray(graphData[id])) out.push(...graphData[id].map(normId));
    return out;
}

function normId(id) {
    return String(id).replace(/^#/, '').trim();
}

/**
 * ACs das tasks predecessoras de `taskId` (transitivo, em largura; ciclos tolerados).
 * @param {string} taskId
 * @param {object} graphData  ver predecessorsOf
 * @param {{registry?: object, registryPath?: string}} [opts]  default: lê .graph/ac-registry.json
 * @returns {Array<{taskId: string, depth: number, indexed: boolean, ac_ids: string[], criteria: string[]}>}
 *   depth 1 = predecessora direta. indexed=false = predecessora sem entrada no registro.
 *   ac_ids: IDs (texto na spec da predecessora); criteria: só em entrada legada/v1.
 */
function getRelatedACs(taskId, graphData, opts = {}) {
    const registry = opts.registry || readRegistry(opts.registryPath || DEFAULT_REGISTRY_PATH);
    const start = normId(taskId);
    const seen = new Set([start]);
    const result = [];
    let frontier = [start];
    for (let depth = 1; frontier.length; depth++) {
        const next = [];
        for (const id of frontier) {
            for (const pred of predecessorsOf(graphData, id)) {
                if (seen.has(pred)) continue;
                seen.add(pred);
                next.push(pred);
                const entry = registry.tasks[pred];
                const view = entryView(entry);
                result.push({ taskId: pred, depth, indexed: !!entry, ac_ids: view ? [...view.acIds] : [], criteria: view ? [...view.criteria] : [] });
            }
        }
        frontier = next;
    }
    return result;
}

module.exports = {
    extractACs, extractDependencies, specHash, updateRegistry, getRelatedACs,
    readRegistry, writeRegistryAtomic, emptyRegistry, buildEntry, entryView, acSourcesFor, specDirForRegistry,
    REGISTRY_VERSION, DEFAULT_REGISTRY_PATH,
};

if (require.main === module) {
    const [cmd, target] = process.argv.slice(2).filter(a => !a.startsWith('--'));
    const flag = name => (process.argv.find(a => a.startsWith(`--${name}=`)) || '').split('=').slice(1).join('=') || null;
    if (cmd === 'extract' && target && fs.existsSync(target)) {
        const id = flag('task') || path.basename(target).replace(/(-spec)?\.md$/, '');
        console.log(JSON.stringify(extractACs(fs.readFileSync(target, 'utf8'), id), null, 2));
    } else if (cmd === 'related' && target) {
        const registry = readRegistry(flag('registry') || DEFAULT_REGISTRY_PATH);
        console.log(JSON.stringify(getRelatedACs(target, registry, { registry }), null, 2));
    } else {
        console.error('Uso: node scripts/lib/ac-registry.js extract <spec.md> [--task=<id>]\n' +
            '     node scripts/lib/ac-registry.js related <id> [--registry=<path>]');
        process.exit(2);
    }
}
