// Policy versionada de roteamento de modelo (PRI-205 S3 / PRI-223), caminho sombra.
// Envelope + hash. Taxonomia C1–C5 / R1–R8 vem do extrato v9 §4.4 (would-route.js),
// não inventada aqui. Platform default atual: classifier.provider = cheap_rule
// (medição sombra). off ainda permitido. jev fora (núcleo 2).
//
// SOMBRA: carregar/validar nunca altera argv, Attempt vivo nem gates. Sem S4.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DEFAULT_POLICY_PATH = path.join(__dirname, 'model-routing-policy.s3-shadow.json');
// off = sem decisão sombra de classe; cheap_rule = §4.4 R1–R8 local.
// jev = núcleo 2 — rejeitado até HD/RC-6/U-A* (PRI-223).
const ALLOWED_PROVIDERS = new Set(['off', 'cheap_rule']);
const CLASSES = ['C1', 'C2', 'C3', 'C4', 'C5'];
const TIERS = ['T1', 'T2', 'T3'];

function sha256Bytes(buf) {
    return crypto.createHash('sha256').update(buf).digest('hex');
}

function validClassToTier(map) {
    if (!map || typeof map !== 'object' || Array.isArray(map)) return false;
    for (const c of CLASSES) {
        const row = map[c];
        if (!row || typeof row !== 'object' || !TIERS.includes(row.tier) || typeof row.effort !== 'string') return false;
    }
    return true;
}

function validTiers(tiers) {
    if (!tiers || typeof tiers !== 'object' || Array.isArray(tiers)) return false;
    for (const t of TIERS) {
        if (!tiers[t] || !Array.isArray(tiers[t].models) || !tiers[t].models.length) return false;
    }
    return true;
}

/**
 * @returns {{ ok: true, policy: object } | { ok: false, cause: string, detail?: string }}
 */
function validatePolicyEnvelope(raw) {
    if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) {
        return { ok: false, cause: 'POLICY_INVALID', detail: 'root_not_object' };
    }
    if (typeof raw.version !== 'string' || !raw.version.trim()) {
        return { ok: false, cause: 'POLICY_INVALID', detail: 'version_missing' };
    }
    if (raw.mode != null && raw.mode !== 'SHADOW') {
        return { ok: false, cause: 'POLICY_INVALID', detail: 'mode_not_shadow' };
    }
    const provider = raw.classifier?.provider;
    if (provider == null || provider === '') {
        return { ok: false, cause: 'POLICY_INVALID', detail: 'classifier_provider_missing' };
    }
    if (provider === 'jev') {
        return { ok: false, cause: 'POLICY_INVALID', detail: 'classifier_provider_jev_blocked' };
    }
    if (!ALLOWED_PROVIDERS.has(provider)) {
        return { ok: false, cause: 'POLICY_INVALID', detail: `classifier_provider_unsupported:${provider}` };
    }
    if (!validClassToTier(raw.class_to_tier)) {
        return { ok: false, cause: 'POLICY_INVALID', detail: 'class_to_tier_invalid' };
    }
    if (!validTiers(raw.tiers)) {
        return { ok: false, cause: 'POLICY_INVALID', detail: 'tiers_invalid' };
    }
    if (!raw.default_route || typeof raw.default_route.model_id !== 'string') {
        return { ok: false, cause: 'POLICY_INVALID', detail: 'default_route_invalid' };
    }
    return { ok: true, policy: raw };
}

/**
 * @param {{ path?: string, json?: string|Buffer|object, bytes?: Buffer }=} source
 */
function loadPolicy(source = {}) {
    let bytes;
    let sourcePath = source.path || null;
    try {
        if (source.bytes != null) {
            bytes = Buffer.isBuffer(source.bytes) ? source.bytes : Buffer.from(source.bytes);
        } else if (source.json != null) {
            bytes = Buffer.isBuffer(source.json)
                ? source.json
                : Buffer.from(typeof source.json === 'string' ? source.json : JSON.stringify(source.json));
        } else {
            sourcePath = sourcePath || DEFAULT_POLICY_PATH;
            if (!fs.existsSync(sourcePath)) {
                return { status: 'MISSING', cause: 'POLICY_MISSING', path: sourcePath };
            }
            bytes = fs.readFileSync(sourcePath);
        }
    } catch (e) {
        return { status: 'MISSING', cause: 'POLICY_MISSING', detail: e.message, path: sourcePath || undefined };
    }

    let raw;
    try {
        raw = JSON.parse(bytes.toString('utf8'));
    } catch (e) {
        return {
            status: 'INVALID',
            cause: 'POLICY_INVALID',
            detail: `json_parse:${e.message}`,
            policy_hash: sha256Bytes(bytes),
            path: sourcePath || undefined,
        };
    }

    const checked = validatePolicyEnvelope(raw);
    const hash = sha256Bytes(bytes);
    if (!checked.ok) {
        return {
            status: 'INVALID',
            cause: checked.cause,
            detail: checked.detail,
            policy_hash: hash,
            path: sourcePath || undefined,
        };
    }
    return {
        status: 'LOADED',
        policy: checked.policy,
        policy_version: checked.policy.version,
        policy_hash: hash,
        path: sourcePath || undefined,
    };
}

function defaultPolicyPath() {
    return DEFAULT_POLICY_PATH;
}

// ── PRI-233 (PRI-205 S4) T2: routing do consumidor e policy para mode ON ─────────
// O caminho sombra acima (loadPolicy/validatePolicyEnvelope) não muda. A policy
// roteada é validada à parte: precisa declarar mode ROUTED, id, ids de modelo reais
// (nunca UNAVAILABLE), default_route explícito no T3 e mapeamento total de esforço
// para o vocabulário do CLI. `routing.mode` vive no consumidor (SP-3), não na policy.

const ROUTING_CONFIG_REL = path.join('.claude', 'model-routing.json');
const ROUTED_PROVIDERS = new Set(['off', 'cheap_rule', 'jev']); // jev: efetivo decidido na admissão (A4)
const CLI_EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);
const TRANSIENT_FS_CODES = new Set(['EIO', 'EAGAIN', 'EBUSY', 'EMFILE', 'ENFILE', 'ETIMEDOUT', 'EINTR']);
const SHA256_HEX = /^[0-9a-f]{64}$/;

function nonEmptyString(v) {
    return typeof v === 'string' && v.trim() !== '';
}

function isRealModel(v) {
    return nonEmptyString(v) && v !== 'UNAVAILABLE' && v !== 'UNKNOWN';
}

/**
 * @returns {{ ok: true, policy: object } | { ok: false, cause: string, detail: string }}
 */
function validateRoutedPolicy(raw) {
    const fail = detail => ({ ok: false, cause: 'POLICY_INVALID', detail });
    if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) return fail('root_not_object');
    if (!nonEmptyString(raw.id)) return fail('id_missing');
    if (!nonEmptyString(raw.version)) return fail('version_missing');
    if (raw.mode !== 'ROUTED') return fail('mode_not_routed');
    const provider = raw.classifier?.provider;
    if (!nonEmptyString(provider)) return fail('classifier_provider_missing');
    if (!ROUTED_PROVIDERS.has(provider)) return fail(`classifier_provider_unsupported:${provider}`);
    if (!validClassToTier(raw.class_to_tier)) return fail('class_to_tier_invalid');
    if (!validTiers(raw.tiers)) return fail('tiers_invalid');
    for (const t of TIERS) {
        if (!raw.tiers[t].models.every(isRealModel)) return fail(`tier_model_unavailable:${t}`);
    }
    const dr = raw.default_route;
    if (!dr || !isRealModel(dr.model_id) || !nonEmptyString(dr.effort)) return fail('default_route_invalid');
    if (!raw.tiers.T3.models.includes(dr.model_id)) return fail('default_route_not_t3');
    const map = raw.effort_map;
    if (!map || typeof map !== 'object' || Array.isArray(map)) return fail('effort_map_invalid');
    const used = [...new Set([...CLASSES.map(c => raw.class_to_tier[c].effort), dr.effort])];
    for (const effort of used) {
        if (!Object.prototype.hasOwnProperty.call(map, effort)) return fail(`effort_map_missing:${effort}`);
        if (!CLI_EFFORTS.has(map[effort])) return fail(`effort_map_value_invalid:${effort}`);
    }
    return { ok: true, policy: raw };
}

// PRI-205 S3b (T4): seção `classifier` do núcleo 2. Validada à parte e NUNCA torna
// a policy roteada inválida: nada do núcleo 2 bloqueia a admissão (SPEC §B2). A
// admissão usa o resultado para decidir o efetivo (off com motivo, ou jev em sombra).
// O prompt, o enum e o destino têm de bater com o cliente desta versão do Prisma.
const CLASSIFIER_MODES = new Set(['shadow', 'active']);
const MAX_CLASSIFIER_TIMEOUT_MS = 5000;

/** @returns {{ ok: true } | { ok: false, detail: string }} */
function validateClassifierSection(classifier) {
    const fail = detail => ({ ok: false, detail });
    if (!classifier || typeof classifier !== 'object' || Array.isArray(classifier)) return fail('classifier_not_object');
    const provider = classifier.provider;
    if (provider === 'off' || provider === 'cheap_rule') return { ok: true };
    if (provider !== 'jev') return fail(`classifier_provider_unsupported:${provider}`);
    const jevClient = require('./jev-client');
    if (!CLASSIFIER_MODES.has(classifier.mode)) return fail('classifier_mode_invalid');
    if (!nonEmptyString(classifier.model_id)) return fail('classifier_model_missing');
    const t = classifier.timeout_ms;
    if (!Number.isInteger(t) || t < 1 || t > MAX_CLASSIFIER_TIMEOUT_MS) return fail('classifier_timeout_invalid');
    const pr = classifier.prompt_ref;
    if (!pr || typeof pr !== 'object' || !nonEmptyString(pr.id) || !nonEmptyString(pr.version)
        || typeof pr.sha256 !== 'string' || !SHA256_HEX.test(pr.sha256)) return fail('classifier_prompt_ref_invalid');
    if (pr.sha256 !== jevClient.promptSha256()) return fail('classifier_prompt_mismatch');
    if (classifier.enum_version !== jevClient.ENUM_VERSION) return fail('classifier_enum_mismatch');
    if (classifier.destination !== jevClient.DESTINATION_ID) return fail('classifier_destination_mismatch');
    return { ok: true };
}

// Referências do núcleo 2 no config do consumidor: só nomes (item do Keychain) e
// referência com hash (espelho da Authority Ref). Nunca valor de segredo. Malformadas
// → erro no classifier_config (o núcleo 2 fica off), nunca INVALID da config.
const KEYCHAIN_NAME = /^[A-Za-z0-9._-]+$/;

function readCredentialRef(raw) {
    if (raw === undefined || raw === null) return { value: null, error: null };
    const ok = raw && typeof raw === 'object' && !Array.isArray(raw)
        && Object.keys(raw).every(k => k === 'keychain' || k === 'account')
        && typeof raw.keychain === 'string' && KEYCHAIN_NAME.test(raw.keychain)
        && typeof raw.account === 'string' && KEYCHAIN_NAME.test(raw.account);
    return ok
        ? { value: { keychain: raw.keychain, account: raw.account }, error: null }
        : { value: null, error: 'classifier_credential_invalid' };
}

function readAuthorityRef(raw, absRoot) {
    if (raw === undefined || raw === null) return { value: null, error: null };
    if (!validPolicyRef({ ...(raw && typeof raw === 'object' ? raw : {}), version: 'n/a' }) || Object.keys(raw).some(k => !['id', 'sha256', 'path'].includes(k))) {
        return { value: null, error: 'authority_ref_invalid' };
    }
    if (path.isAbsolute(raw.path) || !insideRoot(absRoot, path.resolve(absRoot, raw.path))) {
        return { value: null, error: 'authority_ref_path_outside_root' };
    }
    return { value: { id: raw.id, sha256: raw.sha256, path: raw.path }, error: null };
}

function readClassifierConfig(cfg, absRoot) {
    const credential = readCredentialRef(cfg.classifier_credential);
    const authority = readAuthorityRef(cfg.authority_ref, absRoot);
    return {
        credential: credential.value,
        authority_ref: authority.value,
        errors: [credential.error, authority.error].filter(Boolean),
    };
}

function readFailure(cause, e) {
    const transient = TRANSIENT_FS_CODES.has(e && e.code);
    return { status: 'INVALID', cause, detail: `read:${(e && e.code) || 'ERROR'}`, transient };
}

function invalid(cause, detail) {
    return { status: 'INVALID', cause, detail, transient: false };
}

function insideRoot(root, target) {
    const rel = path.relative(root, target);
    // `..policy.json` é um nome legítimo; só `..` ou `../…` saem da raiz (NIT da revisão).
    return rel !== '' && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}

function validPolicyRef(ref) {
    return ref && typeof ref === 'object' && !Array.isArray(ref)
        && nonEmptyString(ref.id) && nonEmptyString(ref.version)
        && typeof ref.sha256 === 'string' && SHA256_HEX.test(ref.sha256)
        && nonEmptyString(ref.path);
}

/**
 * Lê `.claude/model-routing.json` do consumidor e, só com mode ON, a policy referenciada.
 * Nunca lança. Única função usada pelo check de config e pela admissão (AD-2).
 *
 * @param {string} root raiz do consumidor
 * @param {{ readFile?: Function }=} opts
 * @returns {{ status: 'OFF', source: 'absent'|'declared' }
 *   | { status: 'ON', policy: object, policy_ref: object, policy_hash: string }
 *   | { status: 'INVALID', cause: string, detail: string, transient: boolean }}
 */
function readRoutingConfig(root, { readFile = fs.readFileSync } = {}) {
    const absRoot = path.resolve(root);
    let text;
    try {
        text = readFile(path.join(absRoot, ROUTING_CONFIG_REL), 'utf8');
    } catch (e) {
        if (e && e.code === 'ENOENT') return { status: 'OFF', source: 'absent' };
        return readFailure('ROUTING_CONFIG_UNREADABLE', e);
    }
    let cfg;
    try {
        cfg = JSON.parse(text);
    } catch (e) {
        // Só o tipo do erro: a mensagem do JSON.parse cita trecho do arquivo, e o detalhe
        // vai para o comentário no Redmine (NIT da revisão).
        return invalid('ROUTING_CONFIG_INVALID', `json_parse:${e.name}`);
    }
    if (cfg == null || typeof cfg !== 'object' || Array.isArray(cfg)) return invalid('ROUTING_CONFIG_INVALID', 'root_not_object');
    if (cfg.mode === undefined || cfg.mode === 'OFF') return { status: 'OFF', source: 'declared' };
    if (cfg.mode !== 'ON') return invalid('ROUTING_CONFIG_INVALID', 'mode_malformed');

    const ref = cfg.policy_ref;
    if (!validPolicyRef(ref)) return invalid('ROUTING_CONFIG_INVALID', 'policy_ref_invalid');
    if (path.isAbsolute(ref.path)) return invalid('ROUTING_CONFIG_INVALID', 'policy_path_outside_root');
    const policyPath = path.resolve(absRoot, ref.path);
    if (!insideRoot(absRoot, policyPath)) return invalid('ROUTING_CONFIG_INVALID', 'policy_path_outside_root');
    try {
        if (fs.existsSync(policyPath) && !insideRoot(fs.realpathSync(absRoot), fs.realpathSync(policyPath))) {
            return invalid('ROUTING_CONFIG_INVALID', 'policy_path_outside_root');
        }
    } catch (e) {
        return readFailure('POLICY_UNREADABLE', e);
    }

    let bytes;
    try {
        bytes = readFile(policyPath);
    } catch (e) {
        if (e && e.code === 'ENOENT') return invalid('POLICY_MISSING', 'not_found');
        return readFailure('POLICY_UNREADABLE', e);
    }
    const hash = sha256Bytes(Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes));
    if (hash !== ref.sha256) return invalid('POLICY_HASH_MISMATCH', `expected:${ref.sha256}`);
    let raw;
    try {
        raw = JSON.parse(bytes.toString('utf8'));
    } catch (e) {
        return invalid('POLICY_INVALID', `json_parse:${e.name}`);
    }
    const checked = validateRoutedPolicy(raw);
    if (!checked.ok) return invalid(checked.cause, checked.detail);
    if (raw.id !== ref.id) return invalid('POLICY_INVALID', 'id_mismatch');
    if (raw.version !== ref.version) return invalid('POLICY_INVALID', 'version_mismatch');
    return {
        status: 'ON',
        policy: raw,
        policy_ref: { id: ref.id, version: ref.version, sha256: ref.sha256, path: ref.path },
        policy_hash: hash,
        classifier_config: readClassifierConfig(cfg, absRoot),
    };
}

module.exports = {
    DEFAULT_POLICY_PATH,
    ALLOWED_PROVIDERS,
    CLASSES,
    TIERS,
    loadPolicy,
    validatePolicyEnvelope,
    defaultPolicyPath,
    sha256Bytes,
    ROUTING_CONFIG_REL,
    CLI_EFFORTS,
    validateRoutedPolicy,
    readRoutingConfig,
    validateClassifierSection,
    MAX_CLASSIFIER_TIMEOUT_MS,
};
