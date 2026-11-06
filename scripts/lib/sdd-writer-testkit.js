'use strict';
// Writer SDD (PRI-266) — utilitários SÓ de teste. Nunca importado por código de produção
// (WT-F0-02 confere). Sabotagem por mutação: cada proteção do writer fica entre
//   // @guard <ID>   …   [// @else   // <linha alternativa> …]   // @end <ID>
// e loadMutant() copia o writer para TMPDIR, remove o bloco protegido (ou troca pela
// alternativa comentada) e carrega a cópia. Não existe flag de sabotagem em produção.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const LIB = __dirname;
// Arquivos que o writer carrega (ele + primitivas permitidas pela F0).
const WRITER_SUPPORT = ['spec-hash.js', 'spec-headings.js'];

function writerFiles() {
    return fs.readdirSync(LIB).filter(f => /^sdd-writer.*\.js$/.test(f) && !f.endsWith('.test.js'));
}

function applyGuard(src, guardId, file) {
    const lines = src.split('\n');
    const open = lines.findIndex(l => l.trim() === `// @guard ${guardId}`);
    const close = lines.findIndex((l, i) => i > open && l.trim() === `// @end ${guardId}`);
    if (open < 0 || close < 0) throw new Error(`guard "${guardId}" não encontrado em ${file}`);
    const elseIdx = lines.findIndex((l, i) => i > open && i < close && l.trim() === '// @else');
    const alt = elseIdx < 0 ? [] : lines.slice(elseIdx + 1, close).map(l => l.replace(/^(\s*)\/\/ ?/, '$1'));
    return [...lines.slice(0, open), ...alt, ...lines.slice(close + 1)].join('\n');
}

let mutantSeq = 0;
/**
 * Carrega o writer com uma ou mais proteções retiradas.
 * @param {Array<[string,string]>|[string,string]} mutations [arquivo, guardId]
 * @param {string} [entry] módulo a devolver (padrão: o índice sdd-writer.js)
 */
function loadMutant(mutations, entry = 'sdd-writer.js') {
    const list = Array.isArray(mutations[0]) ? mutations : [mutations];
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `sdd-mutant-${process.pid}-${mutantSeq++}-`));
    for (const f of [...writerFiles(), ...WRITER_SUPPORT]) {
        fs.copyFileSync(path.join(LIB, f), path.join(dir, f));
    }
    for (const [file, guard] of list) {
        const p = path.join(dir, file);
        fs.writeFileSync(p, applyGuard(fs.readFileSync(p, 'utf8'), guard, file));
    }
    return require(path.join(dir, entry));
}

/** Lista todos os guards declarados (para conferir que cada um tem sabotagem). */
function listGuards() {
    const out = [];
    for (const f of writerFiles()) {
        const src = fs.readFileSync(path.join(LIB, f), 'utf8');
        for (const m of src.matchAll(/^\s*\/\/ @guard (\S+)\s*$/gm)) out.push([f, m[1]]);
    }
    return out;
}

function tmpDir(prefix = 'sdd-test-') {
    return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

module.exports = { loadMutant, applyGuard, listGuards, writerFiles, tmpDir, LIB };

// ---------------------------------------------------------------------------
// Fixtures sintéticas (nenhum dado de consumidor). Constroem operações VÁLIDAS;
// cada teste estraga exatamente uma coisa.

const W = () => ({
    cmd: require('./sdd-writer-command'),
    jcs: require('./sdd-writer-jcs'),
    log: require('./sdd-writer-log'),
    catalog: require('./sdd-writer-catalog'),
    git: require('./sdd-writer-git'),
    specHash: require('./spec-hash'),
});

const TEST_HOOKS_KEY = Symbol.for('prisma.sdd-writer.test-hooks');
const ROOT = process.env.PRISMA_ROOT || path.resolve(LIB, '..', '..');
const H = c => c.repeat(64);
const AT = '2026-11-06T12:00:00Z';

function hashConfigBytes() {
    return fs.readFileSync(path.join(ROOT, '.claude', 'spec-hash-config.json'));
}

function specText(label) {
    return `# Capability de teste\n\n## Objetivo\n${label}\n\n## Referências\n- nota fora do HASH_SCOPE\n`;
}

function contractHashOf(text) {
    const { specHash } = W();
    const cfg = specHash.parseConfig(JSON.parse(hashConfigBytes().toString('utf8')));
    return specHash.contractHash(text, { scope: 'contract_sections_v1', config: cfg });
}

function admittedFiles(project = 'prisma', { registryBranch = 'main', extra = null } = {}) {
    const { jcs, cmd } = W();
    const projectObj = { schema: 'sdd-admitted-project-v1', project, registry_branch: registryBranch, activation: { promote_change: false, write_docs_sdd: false } };
    const policyObj = { schema: 'sdd-admitted-policy-v1', incorporation_rule: 'DS-03b' };
    if (extra) Object.assign(policyObj, extra);
    return {
        [cmd.ADMITTED_PROJECT]: jcs.canonicalBytes(projectObj),
        [cmd.ADMITTED_POLICY]: jcs.canonicalBytes(policyObj),
    };
}

/** Promoção sintética em docs/sdd/changes/<ticket>/ (EM §2; RRC-SDD-004 §4.3). */
function promotionFiles({ ticket = 'PRI-900', exec = 'exec-1', n = 1, specBytes = Buffer.from('spec do ticket\n'), overrides = {} } = {}) {
    const { cmd } = W();
    const specSha = cmd.sha256hex(specBytes);
    const entry = {
        promotion_id: `${ticket}:${exec}:${n}`, n, cycle: 1, task_id: ticket, execution_id: exec, spec_version: 1,
        hash_scope: 'contract_sections_v1', sealed_contract_hash: H('e'), observed_contract_hash: H('e'),
        spec_sha256: specSha, changelog: { status: 'ABSENT_LEGACY' }, provenance: { status: 'ABSENT_LEGACY' },
        post_verify_contract_change: false, contract: 'contract_sections_v1', base_branch: 'main', promoted_at: AT,
        ...overrides,
    };
    return {
        promotion: entry,
        files: {
            [`docs/sdd/changes/${ticket}/promotions.json`]: Buffer.from(JSON.stringify([entry], null, 2)),
            [`docs/sdd/changes/${ticket}/blobs/${specSha}`]: specBytes,
        },
    };
}

const approving = (entry, over = {}) => ({
    state: 'DECIDED', approving: true, command_sha256: entry.command_sha256, authorized_op_id: entry.op_id,
    approver_id: 'richard', approver_current_right: true, record_digest: H('f'), ...over,
});

/**
 * Construtor de cenário em memória. Cada passo devolve {baseTree, resultTree, entry, ctx};
 * `commit(step)` torna o resultado a nova base.
 */
function scenario({ project = 'prisma', slug = 'spec-change', ticket = 'PRI-900', exec = 'exec-1', extraFiles = {} } = {}) {
    const { cmd, log, catalog, git } = W();
    const prom = promotionFiles({ ticket, exec });
    const files = {
        [cmd.SPEC_HASH_CONFIG]: hashConfigBytes(),
        ...admittedFiles(project),
        ...prom.files,
        ...extraFiles,
    };
    const state = { files: { ...files }, entries: [], state: log.emptyState(), records: {}, seq: 0 };
    const capability = `cap:${project}:${slug}`;
    const tree = (f = state.files, id = 'mem') => git.memTree(f, id);

    function basisOf(f) {
        return {
            project_binding_ref: { path: cmd.ADMITTED_PROJECT, sha256: cmd.sha256hex(f[cmd.ADMITTED_PROJECT]) },
            policy_ref: { path: cmd.ADMITTED_POLICY, sha256: cmd.sha256hex(f[cmd.ADMITTED_POLICY]) },
        };
    }

    /** Monta o passo. `mutate(cmdObj)` antes do hash; `mutateEntry(entry)` depois. */
    function step(op, opts = {}) {
        const n = ++state.seq;
        const head = state.state.version_head;
        let payload;
        let specBytes = null;
        if (op === 'INC') {
            const text = opts.specText || specText(`versão ${n}`);
            specBytes = Buffer.from(text, 'utf8');
            const th = contractHashOf(text);
            const noop = head && th === head.cap_hash;
            payload = {
                base_version: head ? head.cap_version : null, base_hash: head ? head.cap_hash : null,
                delta_sha256: H('d'), target_version: noop ? head.cap_version : (head ? head.cap_version : 0) + 1,
                target_hash: th, target_spec_sha256: cmd.sha256hex(specBytes),
                source_promotion: { promotion_id: prom.promotion.promotion_id, spec_sha256: prom.promotion.spec_sha256, observed_contract_hash: prom.promotion.observed_contract_hash },
                validation_ref: { kind: project === 'prisma' ? 'verify_pass' : 'qa_approved', ref: `verify:${exec}`, promotion_id: prom.promotion.promotion_id, execution_id: exec },
                validation_basis: basisOf(state.files),
            };
        } else if (op === 'ACTIVATE' || op === 'REACTIVATE') {
            const v = opts.target || state.state.version_head;
            payload = { expected_active: state.state.active, target_version: v.cap_version, target_hash: v.cap_hash };
        } else if (op === 'ARCHIVE') {
            payload = { expected_active: state.state.active };
        } else if (op === 'EDIT_ALIASES_SOURCES') {
            payload = { edit_sha256: opts.editSha || H('a') };
        }
        const command = { canon: 'sdd-cmd-v1', op, project, capability, expected_generation: state.state.generation, approved_payload: payload };
        if (opts.mutate) opts.mutate(command);
        const opId = opts.opId || `op:${project}:${slug}:${op}:req-${n}`;
        const applied = log.applyCommand(state.state, command, { editResolver: opts.editResolver || null, strictEdit: false });
        let entry = {
            op_id: opId, command, command_sha256: cmd.commandSha256(command), decision_ref: opts.decisionRef || `D-${n}`,
            actor: opts.actor || 'richard', at: AT,
            result_generation: state.state.generation + 1, result: applied.ok ? applied.result : 'activated',
        };
        if (opts.mutateEntry) opts.mutateEntry(entry);
        const oldBytes = state.files[cmd.logPath(slug)] || null;
        const result = { ...state.files, [cmd.logPath(slug)]: log.appendBytes(oldBytes, entry) };
        if (specBytes) {
            result[cmd.specPath(slug)] = specBytes;
            result[cmd.versionPath(slug, cmd.sha256hex(specBytes))] = specBytes;
        }
        const cat = catalog.generateCatalog(tree(result), { editResolver: opts.editResolver || null });
        if (cat) result[cmd.CATALOG_PATH] = cat; else delete result[cmd.CATALOG_PATH];
        if (opts.mutateFiles) opts.mutateFiles(result);
        const records = { ...state.records, [entry.decision_ref]: approving(entry, opts.record || {}) };
        return {
            op, entry, files: result, records,
            baseTree: tree(state.files, 'base'), resultTree: tree(result, 'result'),
            ctx: {
                mode: 'new', project, slug, baseTree: tree(state.files, 'base'), resultTree: tree(result, 'result'),
                entry, oldEntries: [...state.entries], oldState: state.state, auditState: 'OK', atCommit: 'base-sha',
                [TEST_HOOKS_KEY]: { editResolver: opts.editResolver || null },
            },
        };
    }

    function commit(s) {
        const r = log.applyCommand(state.state, s.entry.command, { editResolver: s.ctx[TEST_HOOKS_KEY].editResolver, strictEdit: false });
        if (!r.ok) throw new Error(`fixture: passo inválido ${r.code} ${r.reason}`);
        state.files = s.files;
        state.entries = [...state.entries, s.entry];
        state.state = r.next;
        state.records = s.records;
        return s;
    }

    return { state, step, commit, tree, project, slug, capability, promotion: prom.promotion, basisOf };
}

module.exports.fixtures = { H, AT, ROOT, specText, contractHashOf, hashConfigBytes, admittedFiles, promotionFiles, approving, scenario };

// ---------------------------------------------------------------------------
// Adaptadores de Decision SÓ DE TESTE (D-231-4 A), fora da API de produção (O-07).
const { DecisionPortError } = require('./sdd-writer-decision');

/**
 * Adaptador SÓ DE TESTE. `records`: { [decision_ref]: record | (atCommit) => record }.
 * `fail`: { [decision_ref]: 'throw' } simula exceção/timeout. `calls` registra as consultas.
 */
function createTestDecisionPort(records = {}, { fail = {} } = {}) {
    const calls = [];
    return {
        calls,
        async resolveDecision(ref, atCommit) {
            calls.push({ ref, atCommit });
            if (fail[ref] === 'throw' || fail['*'] === 'throw') throw new DecisionPortError(`porta indisponível para ${ref}`);
            const r = records[ref];
            if (r === undefined) return { state: 'UNKNOWN' };
            return typeof r === 'function' ? r(atCommit) : r;
        },
    };
}

/**
 * Adaptador SÓ DE TESTE lido de objetos Git em `at_commit` (para o caso M-02): registros em
 * `<dir>/<decision_ref>.json`. Ler `at_commit` = base nunca enxerga o que o PR adiciona.
 */
function createTreeDecisionPort(git, dir) {
    const calls = [];
    return {
        calls,
        async resolveDecision(ref, atCommit) {
            calls.push({ ref, atCommit });
            const bytes = git.readBlob(atCommit, `${dir}/${ref.replace(/[^A-Za-z0-9._-]/g, '_')}.json`);
            if (bytes === null) return { state: 'UNKNOWN' };
            return JSON.parse(bytes.toString('utf8'));
        },
    };
}

module.exports.createTestDecisionPort = createTestDecisionPort;
module.exports.createTreeDecisionPort = createTreeDecisionPort;
module.exports.TEST_HOOKS = require('./sdd-writer-command').TEST_HOOKS;
