'use strict';
// Writer SDD (PRI-266) — transição pura da capability (contrato PRI-231 r4 C-12):
// V-0 (estado de auditoria), V-3 (comando), V-4 (op_id), V-5 (Decision + C-14 consumo),
// V-7 (E-01/E-02, U-002-8), V-6 (P-1 (i)–(v)), V-8 (geração/precondições),
// V-9 (consequências: result, spec.md, versions/, catalog.yaml), V-10 (alias).
// Ordem V-4 → V-5 → V-8 preserva a R-RRC-02 A. V-1/V-2/V-11 (delta e metadados do PR)
// ficam no W-C (sdd-writer-check) e na auditoria.
// Modo `new` (W-C/W-P): Decision com direito ATUAL em at_commit = base_sha.
// Modo `historical` (C-22): identidade/política da validation_basis da própria operação,
// Decision em at_commit = commit do append, direito atual não entra.
// Saída: {ok:true, next, result} | {ok:false, code, reason}. Falha de obtenção →
// code 'UNVERIFIABLE' (transitório); resposta negativa → código semântico (definitivo).

const {
    validateEntry, CommandError, ADMITTED_PROJECT, ADMITTED_POLICY, SPEC_HASH_CONFIG, HASH_SCOPE,
    specPath, versionPath, CATALOG_PATH, capDir, sha256hex, deriveOpId, parseCapabilityId, exactKeys,
    RE_NAME, RE_ID, RE_HEX64,
} = require('./sdd-writer-command');
const { parseCanonical, parseStrict } = require('./sdd-writer-jcs');
const { applyCommand, aliasKey } = require('./sdd-writer-log');
const { checkRecord } = require('./sdd-writer-decision');
const { generateCatalog, projectCapabilities } = require('./sdd-writer-catalog');
const { UnverifiableError } = require('./sdd-writer-git');
const specHash = require('./spec-hash');

// U-002-8 aberta: E-01/E-02 em operação não-INC não decididas → operação não-INC impedida.
// D-266-3 A: só teste injeta `conditions.u0028Decided`; nenhum CLI/W-C produtivo o aceita.
const PRODUCTION_CONDITIONS = Object.freeze({ u0028Decided: false });

const fail = (code, reason) => ({ ok: false, code, reason });

/** Lê e valida um arquivo admitido da E-01 (JCS canônico, schema fechado). */
function readAdmitted(tree, p, keys) {
    const bytes = tree.read(p);
    if (bytes === null) return { ok: false, reason: 'ABSENT' };
    let v;
    try { v = parseCanonical(bytes); } catch { return { ok: false, reason: 'NOT_CANONICAL' }; }
    try { exactKeys(v, keys, p); } catch (e) { return { ok: false, reason: e.reason || 'SCHEMA' }; }
    return { ok: true, value: v, bytes };
}

/** project.json admitido (D-266-1 A). Usado também pela C-04 (registry_branch, sem default). */
function readAdmittedProject(tree) {
    const r = readAdmitted(tree, ADMITTED_PROJECT, ['schema', 'project', 'registry_branch', 'activation']);
    if (!r.ok) return r;
    const v = r.value;
    if (v.schema !== 'sdd-admitted-project-v1' || typeof v.project !== 'string' || !RE_NAME.test(v.project)
        || typeof v.registry_branch !== 'string' || !/^[A-Za-z0-9._/-]{1,200}$/.test(v.registry_branch)) {
        return { ok: false, reason: 'SCHEMA' };
    }
    try { exactKeys(v.activation, ['promote_change', 'write_docs_sdd'], 'activation'); } catch { return { ok: false, reason: 'SCHEMA' }; }
    if (typeof v.activation.promote_change !== 'boolean' || typeof v.activation.write_docs_sdd !== 'boolean') return { ok: false, reason: 'SCHEMA' };
    return r;
}

function readAdmittedPolicy(tree) {
    const r = readAdmitted(tree, ADMITTED_POLICY, ['schema', 'incorporation_rule']);
    if (!r.ok) return r;
    if (r.value.schema !== 'sdd-admitted-policy-v1' || r.value.incorporation_rule !== 'DS-03b') return { ok: false, reason: 'SCHEMA' };
    return r;
}

/** DS-03b (P-1 iv): o tipo vem da identidade admitida, nunca de config ou do payload. */
const requiredValidationKind = project => (project === 'prisma' ? 'verify_pass' : 'qa_approved');

const PROMOTION_FIELDS = ['promotion_id', 'execution_id', 'spec_sha256', 'observed_contract_hash',
    'sealed_contract_hash', 'post_verify_contract_change', 'contract'];

/** P-1 (i)–(iv) sobre a árvore (H3 §3; RRC-SDD-004 §4.3; D-231-7 C). */
function checkP1(tree, command) {
    const p = command.approved_payload;
    const sp = p.source_promotion;
    const vr = p.validation_ref;
    const m = /^([A-Za-z0-9._-]+):([A-Za-z0-9._-]+):([0-9]+)$/.exec(sp.promotion_id);
    if (!m) return fail('P1', 'PROMOTION_ID_FORMAT');
    const [, ticket, execSegment] = m;
    // (iv) identidade admitida + DS-03b; nenhuma chave dispensa o QA.
    const proj = readAdmittedProject(tree);
    if (!proj.ok) return fail('P1', `ADMITTED_PROJECT_${proj.reason}`);
    const pol = readAdmittedPolicy(tree);
    if (!pol.ok) return fail('P1', `ADMITTED_POLICY_${pol.reason}`);
    if (proj.value.project !== command.project) return fail('P1', 'IDENTITY_NOT_ADMITTED');
    if (vr.kind !== requiredValidationKind(proj.value.project)) return fail('P1', 'VALIDATION_KIND');
    // (i) promoção em registry_branch, digests e blob preservado. Sem promoção = handback (U-H3-6).
    const promBytes = tree.read(`docs/sdd/changes/${ticket}/promotions.json`);
    if (promBytes === null) return fail('P1', 'NO_PROMOTION_HANDBACK');
    let proms;
    try { proms = parseStrict(promBytes); } catch { return fail('P1', 'PROMOTIONS_UNREADABLE'); }
    if (!Array.isArray(proms)) return fail('P1', 'PROMOTIONS_NOT_ARRAY');
    const hits = proms.filter(x => x && x.promotion_id === sp.promotion_id);
    if (hits.length !== 1) return fail('P1', hits.length ? 'PROMOTION_AMBIGUOUS' : 'NO_PROMOTION_HANDBACK');
    const pe = hits[0];
    for (const f of PROMOTION_FIELDS) if (!(f in pe) || pe[f] === null || pe[f] === undefined) return fail('P1', `PROMOTION_FIELD_${f}`);
    if (pe.spec_sha256 !== sp.spec_sha256 || pe.observed_contract_hash !== sp.observed_contract_hash) return fail('P1', 'PROMOTION_DIGEST');
    const blob = tree.read(`docs/sdd/changes/${ticket}/blobs/${sp.spec_sha256}`);
    if (blob === null || sha256hex(blob) !== sp.spec_sha256) return fail('P1', 'PROMOTION_BLOB');
    // (ii) quarentena: sem executor da saída (D-231-7 C) → impedida. Legado sem contrato idem.
    if (pe.post_verify_contract_change !== false) return fail('P1', 'QUARANTINE');
    if (pe.contract === 'LEGACY_UNVERSIONED') return fail('P1', 'LEGACY_UNVERSIONED');
    // (iii) vínculo validação ↔ promoção ↔ execução.
    if (vr.promotion_id !== sp.promotion_id) return fail('P1', 'VALIDATION_PROMOTION');
    if (vr.execution_id !== pe.execution_id || pe.execution_id !== execSegment) return fail('P1', 'VALIDATION_EXECUTION');
    return { ok: true };
}

/** Configuração do HASH_SCOPE lida de objeto Git (nunca do disco/REPO_PATH). */
function hashConfig(tree) {
    const bytes = tree.read(SPEC_HASH_CONFIG);
    if (bytes === null) return null;
    try { return specHash.parseConfig(JSON.parse(bytes.toString('utf8')), SPEC_HASH_CONFIG); } catch { return null; }
}

/** versions/** só cresce; nome = sha256 do conteúdo (R-RRC-03b). */
function checkVersions(baseTree, resultTree, slug, allowedNew) {
    const dir = `${capDir(slug)}/versions`;
    const before = baseTree.list(dir);
    const after = resultTree.list(dir);
    for (const [p] of before) {
        const a = resultTree.read(p);
        if (a === null || !a.equals(baseTree.read(p))) return fail('DERIVED', 'VERSIONS_ALTERED');
    }
    for (const [p] of after) {
        if (before.has(p)) continue;
        if (p !== allowedNew) return fail('DERIVED', 'VERSIONS_UNEXPECTED_FILE');
        const m = /\/versions\/([0-9a-f]{64})\.md$/.exec(p);
        if (!m || sha256hex(resultTree.read(p)) !== m[1]) return fail('DERIVED', 'VERSION_NAME_DIGEST');
    }
    return { ok: true };
}

/**
 * @param {object} ctx
 * @param {'new'|'historical'} ctx.mode
 * @param {string} ctx.project  identidade admitida (base)
 * @param {string} ctx.slug
 * @param {object} ctx.baseTree, ctx.resultTree  leitores de árvore
 * @param {object} [ctx.sourcesTree]  de onde vêm fontes E-01/P-1 (padrão: resultTree)
 * @param {object} ctx.entry   nova entrada (já isolada pela V-2)
 * @param {object[]} ctx.oldEntries
 * @param {object} ctx.oldState  estado derivado antes do append
 * @param {string} [ctx.auditState]  V-0 (só modo new)
 * @param {object} ctx.decisionPort
 * @param {string} ctx.atCommit
 */
async function decide(ctx) {
    try {
        return await decideInner(ctx);
    } catch (e) {
        if (e instanceof UnverifiableError) return fail('UNVERIFIABLE', e.reason);
        if (e && e.code === 'NOT_REGULAR_FILE') return fail('DERIVED', 'NOT_REGULAR_FILE');
        // Erro inesperado: nunca PASS; tratado como não obtido (W-C roda de novo).
        return fail('UNVERIFIABLE', `INTERNAL:${e && e.message}`);
    }
}

async function decideInner(ctx) {
    const { mode, project, slug, baseTree, resultTree, entry, oldEntries, oldState, decisionPort, atCommit } = ctx;
    const sourcesTree = ctx.sourcesTree || resultTree;
    const conditions = ctx.conditions || PRODUCTION_CONDITIONS;
    const editResolver = ctx.editResolver || null;
    if (mode !== 'new' && mode !== 'historical') throw new Error('mode inválido');

    // V-0 — elegibilidade da capability (estado de auditoria derivado, C-22).
    // @guard R4-02
    const auditState = ctx.auditState;
    // @else
    // const auditState = ctx.auditState === 'UNVERIFIABLE' ? 'OK' : ctx.auditState;
    // @end R4-02
    if (mode === 'new') {
        // @guard V-0
        if (auditState === 'VIOLATION') return fail('VIOLATION', 'AUDIT_STATE');
        if (auditState === 'UNVERIFIABLE') return fail('UNVERIFIABLE', 'AUDIT_STATE');
        if (auditState !== 'OK') return fail('UNKNOWN', 'AUDIT_STATE');
        // @end V-0
    }

    // V-3 — forma do comando e vínculo com o caminho.
    try { validateEntry(entry); } catch (e) {
        if (e instanceof CommandError) return fail('COMMAND', e.reason);
        throw e;
    }
    const command = entry.command;
    if (command.project !== project || parseCapabilityId(command.capability).slug !== slug) return fail('COMMAND', 'PATH_MISMATCH');

    // V-4 — op_id já no log antigo → sai pelo caminho R.
    // @guard V-4
    if (oldEntries.some(e => e.op_id === entry.op_id)) return fail('DUPLICATE_OP', 'OP_ID_IN_LOG');
    // @end V-4

    // V-5 — Decision pela porta, em at_commit; C-14 uso único registrado no próprio log.
    // @guard C-14
    if (oldEntries.some(e => e.decision_ref === entry.decision_ref)) return fail('DECISION', 'DECISION_CONSUMED');
    // @end C-14
    let rec;
    try {
        rec = await decisionPort.resolveDecision(entry.decision_ref, atCommit);
    } catch (e) {
        return fail('UNVERIFIABLE', `DECISION_PORT:${e && e.message}`);
    }
    // @guard V-5
    const chk = checkRecord(rec);
    if (!chk.valid) return fail('DECISION', chk.reason);
    if (rec.state !== 'DECIDED') return fail('DECISION', `STATE_${rec.state}`);
    if (rec.approving !== true) return fail('DECISION', 'NOT_APPROVING');
    if (rec.command_sha256 !== entry.command_sha256) return fail('DECISION', 'HASH');
    const opBound = typeof rec.authorized_op_id === 'string'
        ? rec.authorized_op_id === entry.op_id
        : deriveOpId(project, slug, command.op, rec.request_id) === entry.op_id;
    if (!opBound) return fail('DECISION', 'OP_ID_NOT_AUTHORIZED');
    // @end V-5
    // @guard HIST-RIGHT
    const requireCurrentRight = mode === 'new';
    // @else
    // const requireCurrentRight = true;
    // @end HIST-RIGHT
    // @guard V-5-RIGHT
    if (requireCurrentRight && rec.approver_current_right !== true) return fail('DECISION', 'APPROVER_RIGHT');
    // @end V-5-RIGHT

    // V-7 — E-01/E-02. Não-INC: impedida até a U-002-8 (fail-closed).
    if (command.op === 'INC') {
        const basis = command.approved_payload.validation_basis;
        // @guard E-01
        if (basis.project_binding_ref.path !== ADMITTED_PROJECT || basis.policy_ref.path !== ADMITTED_POLICY) {
            return fail('E01', 'SOURCE_NOT_ADMITTED');
        }
        // @end E-01
        // @guard E-02
        for (const ref of [basis.project_binding_ref, basis.policy_ref]) {
            const cur = sourcesTree.read(ref.path);
            if (cur === null) return fail('E02', 'SOURCE_ABSENT');
            if (sha256hex(cur) !== ref.sha256) return fail('E02', 'DIGEST_DIVERGENT');
        }
        // @end E-02
    } else {
        // @guard U0028
        if (conditions.u0028Decided !== true) return fail('U0028', 'NON_INC_E01_E02_UNDECIDED');
        // @end U0028
    }

    // V-6 — P-1 (i)–(iv) (a (v) é a V-7 acima).
    if (command.op === 'INC') {
        // @guard P-1
        const p1 = checkP1(sourcesTree, command);
        if (!p1.ok) return p1;
        // @end P-1
    }

    // V-8 — geração e precondições; V-9 — resultado coerente.
    const applied = applyCommand(oldState, command, { editResolver, strictEdit: true });
    if (!applied.ok) return applied;
    // @guard V-9-RESULT
    if (entry.result_generation !== applied.next.generation) return fail('DERIVED', 'RESULT_GENERATION');
    if (entry.result !== applied.result) return fail('DERIVED', 'RESULT');
    // @end V-9-RESULT

    // V-9 — spec.md, versions/** e catalog.yaml.
    const head = applied.next.version_head;
    const spec = resultTree.read(specPath(slug));
    // @guard V-9-SPEC
    if (head === null) {
        if (spec !== null) return fail('DERIVED', 'SPEC_WITHOUT_VERSION');
    } else {
        if (spec === null || sha256hex(spec) !== head.spec_sha256) return fail('DERIVED', 'SPEC_BYTES');
        if (command.op === 'INC') {
            const cfg = hashConfig(baseTree);
            if (!cfg) return fail('DERIVED', 'HASH_SCOPE_CONFIG');
            if (specHash.contractHash(spec.toString('utf8'), { scope: HASH_SCOPE, config: cfg }) !== command.approved_payload.target_hash) {
                return fail('DERIVED', 'SPEC_TARGET_HASH');
            }
        }
    }
    // @end V-9-SPEC
    // @guard V-9-VERSIONS
    let allowedNew = null;
    if (command.op === 'INC') {
        allowedNew = versionPath(slug, command.approved_payload.target_spec_sha256);
        const vb = resultTree.read(allowedNew);
        if (vb === null || spec === null || !vb.equals(spec)) return fail('DERIVED', 'VERSION_FILE');
    }
    const vchk = checkVersions(baseTree, resultTree, slug, allowedNew);
    if (!vchk.ok) return vchk;
    // @end V-9-VERSIONS
    // @guard V-9-CATALOG
    const cat = generateCatalog(resultTree, { editResolver });
    const catNow = resultTree.read(CATALOG_PATH);
    if (cat === null ? catNow !== null : (catNow === null || !catNow.equals(cat))) return fail('DERIVED', 'CATALOG');
    // @end V-9-CATALOG

    // V-10 — alias novo único no projeto inteiro, sobre a árvore resultante (R-RRC-01d A).
    if (command.op === 'EDIT_ALIASES_SOURCES') {
        // @guard V-10
        const edit = editResolver(command.approved_payload.edit_sha256);
        const caps = projectCapabilities(resultTree, { editResolver });
        for (const a of edit.add || []) {
            const holders = caps.filter(c => c.status === 'OK' && c.state.aliases.vigentes.some(x => aliasKey(x) === aliasKey(a)));
            if (holders.length !== 1) return fail('ALIAS', 'ALIAS_NOT_UNIQUE_IN_PROJECT');
        }
        // @end V-10
    }

    return { ok: true, next: applied.next, result: applied.result };
}

module.exports = {
    decide, checkP1, readAdmittedProject, readAdmittedPolicy, requiredValidationKind,
    PRODUCTION_CONDITIONS,
};
