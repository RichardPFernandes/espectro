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

module.exports = {
    DEFAULT_POLICY_PATH,
    ALLOWED_PROVIDERS,
    CLASSES,
    TIERS,
    loadPolicy,
    validatePolicyEnvelope,
    defaultPolicyPath,
    sha256Bytes,
};
