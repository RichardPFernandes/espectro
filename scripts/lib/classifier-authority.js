// Authority Ref do envio ao Jev e núcleo 2 efetivo na admissão da Run
// (PRI-205 S3b, SPEC §B2; Q4 e Q9 do Richard em 2026-11-06).
//
// - A Authority Ref durável é registrada pelo Coordenador no Linear (DP-7). O
//   consumidor guarda um ESPELHO com hash (`authority_ref {id, sha256, path}` em
//   .claude/model-routing.json). Config não autoriza nada: sem espelho válido, o
//   núcleo 2 fica off (AGENTS.md regra 6). Hoje não há ref: tudo AUTHORITY_REF_ABSENT.
// - evaluateClassifier roda na admissão e devolve `classifier_effective`, que entra
//   no snapshot da Run. Nunca lança e NUNCA bloqueia a admissão: o pior é `off`.
// - checkStillAuthorized roda a cada Attempt (Q4): o espelho é o único dado relido
//   fora do snapshot. Qualquer mudança nos bytes (revogação ou outra) para o envio a
//   partir daquele Attempt; um Attempt já iniciado não muda.
//
// Identidade do projeto (scope.projects): o identificador do consumidor que o
// chamador passa (no watcher, o nome da pasta do REPO_PATH).

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const policyLoader = require('./model-routing-policy');
const jevClient = require('./jev-client');
const classifierGuard = require('./classifier-guard');

const REQUIRED_ALLOW = ['step_text', 'ac_text', 'declared_paths'];
const REQUIRED_NEVER = ['code', 'customer_data', 'personal_data', 'secrets', 'credentials'];

function sha256(buf) {
    return crypto.createHash('sha256').update(buf).digest('hex');
}

function nonEmpty(v) {
    return typeof v === 'string' && v.trim() !== '';
}

function instant(v) {
    return nonEmpty(v) && Number.isFinite(Date.parse(v));
}

function insideRoot(root, target) {
    const rel = path.relative(root, target);
    return rel !== '' && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}

/** Lê o espelho e confere o hash dos bytes. @returns {{ ok: true, authority: object, sha256: string } | { ok: false }} */
function readMirror(root, ref, readFile = fs.readFileSync) {
    try {
        const abs = path.resolve(root, ref.path);
        if (path.isAbsolute(ref.path) || !insideRoot(path.resolve(root), abs)) return { ok: false };
        const bytes = readFile(abs);
        const digest = sha256(Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes));
        const authority = JSON.parse(Buffer.isBuffer(bytes) ? bytes.toString('utf8') : String(bytes));
        return { ok: true, authority, sha256: digest };
    } catch {
        return { ok: false };
    }
}

/** @returns {null | string} motivo da recusa, ou null se a ref cobre este envio */
function authorityProblem(a, { id, project, now }) {
    if (!a || typeof a !== 'object' || Array.isArray(a)) return 'AUTHORITY_REF_INVALID';
    if (a.id !== id) return 'AUTHORITY_REF_INVALID';
    if (!nonEmpty(a.issued_by) || !nonEmpty(a.issued_at) || !Array.isArray(a.source) || !a.source.length) return 'AUTHORITY_REF_INVALID';
    if (!instant(a.valid_from)) return 'AUTHORITY_REF_INVALID';
    if (a.revoked_at != null) return 'AUTHORITY_REF_REVOKED';
    if (Date.parse(a.valid_from) > Date.parse(now)) return 'AUTHORITY_REF_INVALID';
    if (a.valid_until != null && (!instant(a.valid_until) || Date.parse(a.valid_until) <= Date.parse(now))) return 'AUTHORITY_REF_INVALID';
    if (a.destination !== jevClient.DESTINATION_ID) return 'AUTHORITY_REF_SCOPE_MISMATCH';
    const env = a.envelope;
    if (!env || !Array.isArray(env.allow) || !Array.isArray(env.never)) return 'AUTHORITY_REF_SCOPE_MISMATCH';
    if (!REQUIRED_ALLOW.every(f => env.allow.includes(f))) return 'AUTHORITY_REF_SCOPE_MISMATCH';
    if (!REQUIRED_NEVER.every(f => env.never.includes(f))) return 'AUTHORITY_REF_SCOPE_MISMATCH';
    if (!a.scope || !Array.isArray(a.scope.projects) || !a.scope.projects.includes(project)) return 'AUTHORITY_REF_SCOPE_MISMATCH';
    return null;
}

function off(reason, detail = null) {
    return {
        provider: 'off', declared: 'jev', mode: null, reason, detail,
        authority_ref: null, credential: null, model_id: null, timeout_ms: null, guard_version: null,
    };
}

/**
 * @param {{ classifier: object, classifierConfig?: { credential: object|null, authority_ref: object|null, errors: string[] },
 *   root: string, project: string, now?: string, readFile?: Function, guard?: object|null }} input
 * @returns {null | object} null quando o declarado não é jev (o snapshot fica como na S4)
 */
function evaluateClassifier({ classifier, classifierConfig, root, project, now = new Date().toISOString(), readFile, guard = classifierGuard } = {}) {
    if (!classifier || classifier.provider !== 'jev') return null;
    try {
        const section = policyLoader.validateClassifierSection(classifier);
        if (!section.ok) return off('CLASSIFIER_SECTION_INVALID', section.detail);
        const cfg = classifierConfig || { credential: null, authority_ref: null, errors: [] };
        if (Array.isArray(cfg.errors) && cfg.errors.length) return off('CLASSIFIER_CONFIG_INVALID', cfg.errors.join(','));
        if (!cfg.authority_ref) return off('AUTHORITY_REF_ABSENT');
        if (!cfg.credential) return off('CREDENTIAL_REF_ABSENT');
        if (!guard || typeof guard.checkEnvelope !== 'function' || !nonEmpty(guard.GUARD_VERSION)) return off('CONTENT_GUARD_UNAVAILABLE');

        const ref = cfg.authority_ref;
        const read = readMirror(root, ref, readFile);
        if (!read.ok || read.sha256 !== ref.sha256) return off('AUTHORITY_REF_INVALID');
        const problem = authorityProblem(read.authority, { id: ref.id, project, now });
        if (problem) return off(problem);

        return {
            provider: 'jev',
            declared: 'jev',
            mode: 'shadow',
            reason: classifier.mode === 'active' ? 'ACTIVE_NOT_CALIBRATED' : null,
            detail: null,
            authority_ref: { id: ref.id, sha256: ref.sha256, path: ref.path },
            credential: { keychain: cfg.credential.keychain, account: cfg.credential.account },
            model_id: classifier.model_id,
            timeout_ms: classifier.timeout_ms,
            guard_version: guard.GUARD_VERSION,
        };
    } catch {
        return off('AUTHORITY_REF_INVALID');
    }
}

/**
 * Q4: releitura por Attempt. Bytes iguais aos da admissão → segue. Diferentes,
 * ausentes ou ilegíveis → para (REVOKED se o espelho novo diz revoked_at).
 */
function checkStillAuthorized({ root, effective, readFile } = {}) {
    if (!effective || effective.provider !== 'jev' || !effective.authority_ref) return { ok: false, reason: 'NUCLEUS2_OFF' };
    const read = readMirror(root, effective.authority_ref, readFile);
    if (read.ok && read.sha256 === effective.authority_ref.sha256) return { ok: true };
    if (read.ok && read.authority && typeof read.authority === 'object' && read.authority.revoked_at != null) {
        return { ok: false, reason: 'AUTHORITY_REF_REVOKED' };
    }
    return { ok: false, reason: 'AUTHORITY_REF_CHANGED' };
}

module.exports = { evaluateClassifier, checkStillAuthorized, REQUIRED_ALLOW, REQUIRED_NEVER };
