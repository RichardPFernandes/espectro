'use strict';
// Writer SDD (PRI-266) — envelope `sdd-cmd-v1`, entrada do log e caminhos do registro.
// Fontes: RRC-SDD-002 §4.1/§4.4, PR §5.2, RRC-SDD-003 §4.3 (INC), H3 §3 P-1,
// contrato PRI-231 r4 (C-05 entrada sem mudança de schema, D-231-5), D-266-1 (E-01).
// Schema fechado: todo campo presente (null explícito quando admitido), sem extras.

const crypto = require('node:crypto');
const { canonicalBytes, parseCanonical, JcsError } = require('./sdd-writer-jcs');

const CANON = 'sdd-cmd-v1';
const SPEC_ROOT = 'docs/sdd';
const CATALOG_PATH = `${SPEC_ROOT}/catalog.yaml`;
const CAPABILITIES_DIR = `${SPEC_ROOT}/capabilities`;
// D-266-1 A: representação admitida e protegida da E-01, fixa no código (ref confiável).
const ADMITTED_DIR = `${SPEC_ROOT}/admitted`;
const ADMITTED_PROJECT = `${ADMITTED_DIR}/project.json`;
const ADMITTED_POLICY = `${ADMITTED_DIR}/policy.json`;
const SPEC_HASH_CONFIG = '.claude/spec-hash-config.json';
const HASH_SCOPE = 'contract_sections_v1';
// D-266-3 A / O-07: ganchos SÓ de teste (condição U-002-8, resolvedor de edit) viajam numa
// chave Symbol, que não sai de JSON, env nem argv: opção de configuração não os liga.
const TEST_HOOKS = Symbol.for('prisma.sdd-writer.test-hooks');

const OPS = ['INC', 'ACTIVATE', 'REACTIVATE', 'ARCHIVE', 'EDIT_ALIASES_SOURCES'];
const VALIDATION_KINDS = ['qa_approved', 'verify_pass'];
const MAX_INT = 2 ** 53;

const RE_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
const RE_ID = /^[A-Za-z0-9][A-Za-z0-9._:@/+=-]{0,255}$/;
const RE_HEX64 = /^[0-9a-f]{64}$/;
const RE_AT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const RE_PATH = /^[A-Za-z0-9._/-]{1,512}$/;

class CommandError extends Error {
    constructor(reason, message) {
        super(message || reason);
        this.name = 'CommandError';
        this.reason = reason;
    }
}

const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);

function exactKeys(obj, keys, where) {
    if (!isObj(obj)) throw new CommandError('SCHEMA', `${where}: objeto esperado`);
    const got = Object.keys(obj).sort();
    const want = [...keys].sort();
    for (const k of want) if (!Object.prototype.hasOwnProperty.call(obj, k)) throw new CommandError('MISSING_FIELD', `${where}: campo ausente "${k}"`);
    for (const k of got) if (!want.includes(k)) throw new CommandError('EXTRA_FIELD', `${where}: campo extra "${k}"`);
}

function str(v, re, where) {
    if (typeof v !== 'string') throw new CommandError('SCHEMA', `${where}: string esperada`);
    if (v.normalize('NFC') !== v) throw new CommandError('NFC', `${where}: string fora de NFC`);
    if (!re.test(v)) throw new CommandError('SCHEMA', `${where}: valor fora do formato`);
}

function int(v, where, { min = 0 } = {}) {
    if (typeof v !== 'number' || !Number.isInteger(v)) throw new CommandError('INTEGER', `${where}: inteiro esperado`);
    if (v < min || v >= MAX_INT) throw new CommandError('INTEGER', `${where}: inteiro fora de [${min}, 2^53)`);
}

const nullable = (v, fn) => { if (v !== null) fn(v); };

function activeRef(v, where) {
    exactKeys(v, ['cap_version', 'cap_hash'], where);
    int(v.cap_version, `${where}.cap_version`, { min: 1 });
    str(v.cap_hash, RE_HEX64, `${where}.cap_hash`);
}

function sourceRef(v, where) {
    exactKeys(v, ['path', 'sha256'], where);
    str(v.path, RE_PATH, `${where}.path`);
    str(v.sha256, RE_HEX64, `${where}.sha256`);
}

function validationBasis(v, where) {
    exactKeys(v, ['project_binding_ref', 'policy_ref'], where);
    sourceRef(v.project_binding_ref, `${where}.project_binding_ref`);
    sourceRef(v.policy_ref, `${where}.policy_ref`);
}

const PAYLOADS = {
    INC(p) {
        exactKeys(p, ['base_version', 'base_hash', 'delta_sha256', 'target_version', 'target_hash',
            'target_spec_sha256', 'source_promotion', 'validation_ref', 'validation_basis'], 'approved_payload');
        nullable(p.base_version, v => int(v, 'base_version', { min: 1 }));
        nullable(p.base_hash, v => str(v, RE_HEX64, 'base_hash'));
        if ((p.base_version === null) !== (p.base_hash === null)) throw new CommandError('SCHEMA', 'base_version/base_hash: ambos null ou ambos presentes');
        str(p.delta_sha256, RE_HEX64, 'delta_sha256');
        int(p.target_version, 'target_version', { min: 1 });
        str(p.target_hash, RE_HEX64, 'target_hash');
        str(p.target_spec_sha256, RE_HEX64, 'target_spec_sha256');
        exactKeys(p.source_promotion, ['promotion_id', 'spec_sha256', 'observed_contract_hash'], 'source_promotion');
        str(p.source_promotion.promotion_id, RE_ID, 'source_promotion.promotion_id');
        str(p.source_promotion.spec_sha256, RE_HEX64, 'source_promotion.spec_sha256');
        str(p.source_promotion.observed_contract_hash, RE_HEX64, 'source_promotion.observed_contract_hash');
        exactKeys(p.validation_ref, ['kind', 'ref', 'promotion_id', 'execution_id'], 'validation_ref');
        if (!VALIDATION_KINDS.includes(p.validation_ref.kind)) throw new CommandError('SCHEMA', 'validation_ref.kind inválido');
        str(p.validation_ref.ref, RE_ID, 'validation_ref.ref');
        str(p.validation_ref.promotion_id, RE_ID, 'validation_ref.promotion_id');
        str(p.validation_ref.execution_id, RE_ID, 'validation_ref.execution_id');
        validationBasis(p.validation_basis, 'validation_basis');
    },
    ACTIVATE(p) {
        exactKeys(p, ['expected_active', 'target_version', 'target_hash'], 'approved_payload');
        nullable(p.expected_active, v => activeRef(v, 'expected_active'));
        int(p.target_version, 'target_version', { min: 1 });
        str(p.target_hash, RE_HEX64, 'target_hash');
    },
    REACTIVATE(p) { PAYLOADS.ACTIVATE(p); },
    ARCHIVE(p) {
        exactKeys(p, ['expected_active'], 'approved_payload');
        nullable(p.expected_active, v => activeRef(v, 'expected_active'));
    },
    EDIT_ALIASES_SOURCES(p) {
        exactKeys(p, ['edit_sha256'], 'approved_payload');
        str(p.edit_sha256, RE_HEX64, 'edit_sha256');
    },
};

function parseCapabilityId(id) {
    const m = /^cap:([a-z0-9][a-z0-9-]{0,63}):([a-z0-9][a-z0-9-]{0,63})$/.exec(id);
    if (!m) throw new CommandError('SCHEMA', 'capability fora do formato cap:<project>:<slug>');
    return { project: m[1], slug: m[2] };
}

/** Valida o objeto `command` (já parseado). Lança CommandError. */
function validateCommand(c) {
    exactKeys(c, ['canon', 'op', 'project', 'capability', 'expected_generation', 'approved_payload'], 'command');
    if (c.canon !== CANON) throw new CommandError('CANON', `canon deve ser "${CANON}"`);
    if (!OPS.includes(c.op)) throw new CommandError('SCHEMA', `op desconhecida "${c.op}"`);
    str(c.project, RE_NAME, 'project');
    str(c.capability, /^cap:[a-z0-9-]+:[a-z0-9-]+$/, 'capability');
    const cap = parseCapabilityId(c.capability);
    if (cap.project !== c.project) throw new CommandError('SCHEMA', 'capability de outro projeto');
    int(c.expected_generation, 'expected_generation');
    PAYLOADS[c.op](c.approved_payload);
    return c;
}

/** Bytes congelados do comando → objeto validado (RRC-SDD-002 §4.4). */
function parseCommandBytes(bytes) {
    let c;
    try { c = parseCanonical(bytes); } catch (e) {
        if (e instanceof JcsError) throw new CommandError(e.reason, e.message);
        throw e;
    }
    return validateCommand(c);
}

const sha256hex = buf => crypto.createHash('sha256').update(buf).digest('hex');
const commandSha256 = command => sha256hex(canonicalBytes(command));

const RESULTS = ['inc_version_created', 'inc_no_contract_change', 'activated', 'reactivated', 'archived', 'aliases_sources_edited'];

/** Entrada do log (sem mudança de schema, D-231-5). */
function validateEntry(e) {
    exactKeys(e, ['op_id', 'command', 'command_sha256', 'decision_ref', 'actor', 'at', 'result_generation', 'result'], 'entry');
    str(e.op_id, RE_ID, 'op_id');
    validateCommand(e.command);
    str(e.command_sha256, RE_HEX64, 'command_sha256');
    if (commandSha256(e.command) !== e.command_sha256) throw new CommandError('HASH', 'command_sha256 não confere com JCS(command)');
    str(e.decision_ref, RE_ID, 'decision_ref');
    str(e.actor, RE_ID, 'actor');
    str(e.at, RE_AT, 'at');
    int(e.result_generation, 'result_generation', { min: 1 });
    if (!RESULTS.includes(e.result)) throw new CommandError('SCHEMA', 'result desconhecido');
    return e;
}

/** Convenção da RRC-SDD-002 §4.3 para derivar `op_id` de `request_id`. */
const deriveOpId = (project, slug, op, requestId) => `op:${project}:${slug}:${op}:${requestId}`;

const capDir = slug => `${CAPABILITIES_DIR}/${slug}`;
const logPath = slug => `${capDir(slug)}/log.json`;
const specPath = slug => `${capDir(slug)}/spec.md`;
const versionPath = (slug, specSha) => `${capDir(slug)}/versions/${specSha}.md`;
const markerRef = (project, slug) => `refs/heads/sdd-op/${project}/${slug}`;
const markerBranch = (project, slug) => `sdd-op/${project}/${slug}`;
const anchorTag = (project, slug, gen) => `sdd/${project}/${slug}/g${gen}`;

/** Caminho protegido (EM §3 prop. 3 + R-RRC-03b): capabilities/** e catalog.yaml. */
function protectedSlugOf(p) {
    if (p === CATALOG_PATH) return { catalog: true };
    const m = /^docs\/sdd\/capabilities\/([^/]+)\/(.+)$/.exec(p);
    if (m) return { slug: m[1], rest: m[2] };
    return null;
}

module.exports = {
    CANON, SPEC_ROOT, CATALOG_PATH, CAPABILITIES_DIR, ADMITTED_DIR, ADMITTED_PROJECT, ADMITTED_POLICY,
    SPEC_HASH_CONFIG, HASH_SCOPE, TEST_HOOKS, OPS, VALIDATION_KINDS, RESULTS,
    RE_NAME, RE_ID, RE_HEX64,
    CommandError, validateCommand, parseCommandBytes, validateEntry, commandSha256, sha256hex,
    parseCapabilityId, deriveOpId, capDir, logPath, specPath, versionPath, markerRef, markerBranch, anchorTag,
    protectedSlugOf, exactKeys,
};
