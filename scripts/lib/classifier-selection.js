// Seletor do classificador: "Só policy" × "Policy + Jev" (PRI-205 S3b, SPEC §B11).
//
// Requisito do Richard (R-SEL, 2026-11-06): "deve ter como selecionar as duas opções
// tanto usar o jev quanto só usar a policy". Decisões Q11–Q14:
// - Q11: a escolha fica num REGISTRO PRÓPRIO do consumidor, append-only, em
//   memory/routing/classifier-selection.json, fora do git e fora da policy (o hash da
//   policy aprovada não muda). Entra no snapshot da Run na admissão (T11).
// - Q12: os parâmetros do Jev vêm da plataforma (platformJevSection), gravados em cada
//   versão do registro. Não há policy p2.
// - Q13: escopo por projeto consumidor. Q14: só aprovador autenticado troca (o
//   chamador, Dashboard, autentica; aqui chega o nome).
// - A comparação de versão (CAS) usa scripts/cas.js, injetado pelo chamador (AC-02).
//
// writeSelection é o ÚNICO writer. Valida na ordem do §4.8 e recusa com código:
//   (pedido) 400 CLASSIFIER_REQUEST_INVALID
//   0 idempotência (antes do CAS) → 409 CLASSIFIER_IDEMPOTENCY_MISMATCH
//   1 expected_version (CAS)      → 409 CLASSIFIER_VERSION_CONFLICT
//   2 autorização (só jev)        → 422 CLASSIFIER_SCOPE_NOT_AUTHORIZED
//   3 calibração (só active)      → 422 CLASSIFIER_NOT_CALIBRATED (não há registro de calibração)
//   4 trava de experimento        → 422 CLASSIFIER_LOCKED_BY_EXPERIMENT
//   5 gravação atômica (trava exclusiva, tmp + rename) com auditoria.
// A troca vale só para Runs novas; nada aqui toca Run em andamento.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const jevClient = require('./jev-client');
const classifierAuthority = require('./classifier-authority');
const policyLoader = require('./model-routing-policy');

const REGISTRY_REL = path.join('memory', 'routing', 'classifier-selection.json');
const EXPERIMENT_REL = path.join('memory', 'routing', 'experiment-units.json');
const SCHEMA = 'classifier-selection@1';
const CHOICES = new Set(['policy_only', 'policy_jev']);
const JEV_MODES = new Set(['shadow', 'active']);
const OPERATION_ID = /^[\w:.@-]{8,100}$/;
const MAX_REASON = 500;
const STALE_LOCK_MS = 60 * 1000;

class SelectionError extends Error {
    constructor(code, httpStatus, message, detail = null) {
        super(message);
        this.code = code;
        this.httpStatus = httpStatus;
        this.detail = detail;
    }
}

function canonical(value) {
    if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
    if (value && typeof value === 'object') {
        return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
    }
    return JSON.stringify(value === undefined ? null : value);
}

function sha256(buf) {
    return crypto.createHash('sha256').update(buf).digest('hex');
}

function registryPath(root) {
    return path.join(path.resolve(root), REGISTRY_REL);
}

/** Seção completa do jev com os parâmetros desta versão do Prisma (Q12). */
function platformJevSection(mode) {
    return {
        provider: 'jev',
        mode,
        model_id: 'jev-latest',
        timeout_ms: jevClient.DEFAULT_TIMEOUT_MS,
        prompt_ref: { id: 'prisma-class-prompt', version: '1', sha256: jevClient.promptSha256() },
        enum_version: jevClient.ENUM_VERSION,
        destination: jevClient.DESTINATION_ID,
    };
}

function invalidRegistry(detail) {
    return { ok: false, reason: 'CLASSIFIER_SELECTION_INVALID', detail };
}

/** @returns {{ ok: true, version: number, current: object|null, sha256: string|null } | { ok: false, reason: string, detail: string }} */
function readSelection(root) {
    let bytes;
    try {
        bytes = fs.readFileSync(registryPath(root));
    } catch (e) {
        if (e && e.code === 'ENOENT') return { ok: true, version: 0, current: null, sha256: null };
        return invalidRegistry(`read:${(e && e.code) || 'ERROR'}`);
    }
    let reg;
    try { reg = JSON.parse(bytes.toString('utf8')); } catch { return invalidRegistry('json_parse'); }
    if (!reg || typeof reg !== 'object' || reg.schema !== SCHEMA || !Array.isArray(reg.versions) || !reg.versions.length) {
        return invalidRegistry('shape');
    }
    for (let i = 0; i < reg.versions.length; i += 1) {
        const v = reg.versions[i];
        if (!v || v.version !== i + 1 || !CHOICES.has(v.choice) || !v.classifier || typeof v.classifier !== 'object') {
            return invalidRegistry(`version_${i + 1}`);
        }
    }
    const current = reg.versions[reg.versions.length - 1];
    if (reg.current_version !== current.version) return invalidRegistry('current_version');
    return { ok: true, version: current.version, current, sha256: sha256(bytes) };
}

/**
 * Classifier efetivo para a admissão: o do registro, ou o da policy sem registro.
 * Registro ilegível → off (nunca bloqueia a admissão).
 */
function effectiveClassifier(root, policy) {
    const r = readSelection(root);
    if (!r.ok) return { classifier: { provider: 'off' }, source: 'INVALID', selection_ref: null, reason: r.reason };
    if (!r.current) return { classifier: policy && policy.classifier, source: 'POLICY', selection_ref: null, reason: null };
    return { classifier: r.current.classifier, source: 'SELECTION', selection_ref: { version: r.version, sha256: r.sha256 }, reason: null };
}

function experimentLock(root) {
    let raw;
    try {
        raw = fs.readFileSync(path.join(path.resolve(root), EXPERIMENT_REL), 'utf8');
    } catch (e) {
        if (e && e.code === 'ENOENT') return { locked: false, check: 'NO_REGISTRY' };
        return { locked: true, check: 'UNREADABLE' };
    }
    try {
        const units = JSON.parse(raw).units;
        if (!Array.isArray(units)) return { locked: true, check: 'UNREADABLE' };
        return units.some(u => u && u.status === 'ACTIVE') ? { locked: true, check: 'ACTIVE_UNIT' } : { locked: false, check: 'NONE_ACTIVE' };
    } catch {
        return { locked: true, check: 'UNREADABLE' };
    }
}

function authorization(root, { project, classifierConfig, now }) {
    const eff = classifierAuthority.evaluateClassifier({
        classifier: platformJevSection('shadow'), classifierConfig, root, project, now,
    });
    return eff && eff.provider === 'jev' ? { ok: true } : { ok: false, detail: (eff && eff.reason) || 'NOT_AUTHORIZED' };
}

function validateRequest({ choice, mode, expectedVersion, operationId, by, reason }, casLib) {
    const bad = msg => new SelectionError('CLASSIFIER_REQUEST_INVALID', 400, msg);
    if (!CHOICES.has(choice)) return bad('choice deve ser policy_only ou policy_jev');
    if (choice === 'policy_only' && mode != null) return bad('mode só vale com policy_jev');
    if (choice === 'policy_jev' && mode != null && !JEV_MODES.has(mode)) return bad('mode deve ser shadow ou active');
    if (!casLib.isCounter(expectedVersion)) return bad('expected_version inválida');
    if (typeof operationId !== 'string' || !OPERATION_ID.test(operationId)) return bad('operation_id inválido');
    if (typeof by !== 'string' || !by.trim()) return bad('autor ausente');
    if (typeof reason !== 'string' || !reason.trim() || reason.length > MAX_REASON) return bad(`motivo obrigatório, até ${MAX_REASON} caracteres`);
    return null;
}

function acquireLock(lockPath) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
            const fd = fs.openSync(lockPath, 'wx');
            fs.writeSync(fd, String(process.pid));
            fs.closeSync(fd);
            return () => { try { fs.unlinkSync(lockPath); } catch { /* já saiu */ } };
        } catch (e) {
            if (!e || e.code !== 'EEXIST') throw e;
            let stale = false;
            try { stale = Date.now() - fs.statSync(lockPath).mtimeMs > STALE_LOCK_MS; } catch { stale = true; }
            if (!stale || attempt > 0) break;
            try { fs.unlinkSync(lockPath); } catch { /* outro escritor levou */ }
        }
    }
    throw new SelectionError('CLASSIFIER_VERSION_CONFLICT', 409, 'outra troca do classificador está em andamento; recarregue e tente de novo');
}

/**
 * @param {string} root raiz do consumidor
 * @param {{ choice: string, mode?: string|null, expectedVersion: number, operationId: string, by: string,
 *   reason: string, project: string, classifierConfig?: object, now?: string, cas: object }} input
 *   `cas` = scripts/cas.js, injetado pelo chamador: a comparação de versão mora só lá
 *   (AC-02 de state-concurrency) e scripts/lib não importa scripts/ (no-lib-upward).
 * @returns {{ status: 'applied'|'already_processed', current: object }}
 * @throws {SelectionError}
 */
function writeSelection(root, { choice, mode = null, expectedVersion, operationId, by, reason, project, classifierConfig, now = new Date().toISOString(), cas: casLib } = {}) {
    if (!casLib || typeof casLib.compareCounter !== 'function' || typeof casLib.isCounter !== 'function') {
        throw new TypeError('writeSelection: cas (scripts/cas.js) é obrigatório');
    }
    const invalid = validateRequest({ choice, mode, expectedVersion, operationId, by, reason }, casLib);
    if (invalid) throw invalid;
    const effMode = choice === 'policy_jev' ? (mode || 'shadow') : null;
    const payloadSha = sha256(canonical({ choice, mode: effMode, expected_version: expectedVersion, reason: reason.trim(), by: by.trim() }));

    const file = registryPath(root);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const release = acquireLock(`${file}.lock`);
    try {
        const r = readSelection(root);
        if (!r.ok) throw new SelectionError('CLASSIFIER_SELECTION_INVALID', 409, 'registro de seleção ilegível: não sobrescrevo; corrija ou remova o arquivo', r.detail);
        const reg = r.current
            ? JSON.parse(fs.readFileSync(file, 'utf8'))
            : { schema: SCHEMA, project, current_version: 0, versions: [] };

        // 0. Idempotência, antes do CAS.
        const seen = reg.versions.find(v => v.operation_id === operationId);
        if (seen) {
            if (seen.payload_sha256 === payloadSha) return { status: 'already_processed', current: reg.versions[reg.versions.length - 1] };
            throw new SelectionError('CLASSIFIER_IDEMPOTENCY_MISMATCH', 409, 'operation_id já usado com outro pedido');
        }
        // 1. CAS.
        if (!casLib.compareCounter(expectedVersion, reg.current_version).ok) {
            throw new SelectionError('CLASSIFIER_VERSION_CONFLICT', 409, `a escolha mudou (versão vigente ${reg.current_version}); recarregue e tente de novo`);
        }
        const checks = { idempotency: 'NEW', version: 'OK', authorization: 'NOT_REQUIRED', calibration: 'NOT_REQUIRED', experiment_lock: null };
        // 2. Autorização de dados para qualquer jev (sombra também envia texto).
        if (choice === 'policy_jev') {
            const auth = authorization(root, { project, classifierConfig, now });
            if (!auth.ok) throw new SelectionError('CLASSIFIER_SCOPE_NOT_AUTHORIZED', 422, 'sem Authority Ref válida para enviar texto ao Jev neste projeto', auth.detail);
            checks.authorization = 'OK';
        }
        // 3. Calibração para active: não há registro de calibração nesta versão.
        if (effMode === 'active') {
            throw new SelectionError('CLASSIFIER_NOT_CALIBRATED', 422, 'modo ativo exige calibração PASS (U15 e acerto); nenhuma calibração registrada');
        }
        // 4. Trava de experimento (S6).
        const lock = experimentLock(root);
        if (lock.locked) throw new SelectionError('CLASSIFIER_LOCKED_BY_EXPERIMENT', 422, 'há unidade do experimento ativa (ou registro ilegível) neste projeto', lock.check);
        checks.experiment_lock = lock.check;

        // 5. Gravação atômica com auditoria.
        const entry = {
            version: reg.current_version + 1,
            choice,
            mode: effMode,
            classifier: choice === 'policy_jev' ? platformJevSection(effMode) : { provider: 'off' },
            by: by.trim(),
            at: now,
            reason: reason.trim(),
            previous_version: reg.current_version,
            operation_id: operationId,
            payload_sha256: payloadSha,
            calibration_ref: null,
            checks,
        };
        const next = { ...reg, project: reg.project || project, current_version: entry.version, versions: [...reg.versions, entry] };
        const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
        fs.writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, { flag: 'wx' });
        fs.renameSync(tmp, file);
        return { status: 'applied', current: entry };
    } finally {
        release();
    }
}

/** Opções para a UI, com o código de recusa previsto. Não grava nada. */
function previewOptions(root, { project, classifierConfig, now = new Date().toISOString() } = {}) {
    const lock = experimentLock(root);
    const locked = lock.locked ? { allowed: false, refusal: 'CLASSIFIER_LOCKED_BY_EXPERIMENT', detail: lock.check } : null;
    const auth = authorization(root, { project, classifierConfig, now });
    const scope = auth.ok ? null : { allowed: false, refusal: 'CLASSIFIER_SCOPE_NOT_AUTHORIZED', detail: auth.detail };
    return [
        { choice: 'policy_only', ...(locked || { allowed: true, refusal: null, detail: null }) },
        {
            choice: 'policy_jev',
            modes: {
                shadow: scope || locked || { allowed: true, refusal: null, detail: null },
                active: scope || { allowed: false, refusal: 'CLASSIFIER_NOT_CALIBRATED', detail: null },
            },
        },
    ];
}

/** O registro está fora do git do consumidor (Q11)? Lê só o .gitignore da raiz. */
function registryGitIgnored(root) {
    let text;
    try { text = fs.readFileSync(path.join(path.resolve(root), '.gitignore'), 'utf8'); } catch { return false; }
    const patterns = new Set(['memory', 'memory/', 'memory/**', 'memory/routing', 'memory/routing/', 'memory/routing/**']);
    return text.split(/\r?\n/).map(l => l.trim()).filter(l => l && !l.startsWith('#'))
        .some(l => patterns.has(l.replace(/^\//, '')));
}

function currentView(r, policyClassifier) {
    if (!r.ok) return { version: null, choice: null, provider: 'off', mode: null, source: 'INVALID', by: null, at: null, reason: r.reason };
    if (!r.current) {
        return { version: 0, choice: null, provider: (policyClassifier && policyClassifier.provider) || null, mode: null, source: 'POLICY', by: null, at: null, reason: null };
    }
    const v = r.current;
    return { version: v.version, choice: v.choice, provider: v.classifier.provider, mode: v.mode ?? null, source: 'SELECTION', by: v.by, at: v.at, reason: v.reason };
}

/**
 * Estado para a API do Dashboard (GET /api/routing/classifier e resposta do POST). Só
 * leitura; nenhum segredo (a credencial é só o nome do item, e nem ele sai daqui).
 * @param {string} root
 * @param {{ routingConfig: object, project: string, now?: string }} input saída de readRoutingConfig
 */
function apiState(root, { routingConfig, project, now = new Date().toISOString() } = {}) {
    const on = routingConfig && routingConfig.status === 'ON';
    const r = readSelection(root);
    let history = [];
    if (r.ok && r.current) {
        try {
            const reg = JSON.parse(fs.readFileSync(registryPath(root), 'utf8'));
            history = reg.versions.slice(-20).reverse()
                .map(v => ({ version: v.version, choice: v.choice, mode: v.mode ?? null, by: v.by, at: v.at, reason: v.reason }));
        } catch { history = []; }
    }
    return {
        project,
        routing_mode: routingConfig ? routingConfig.status : 'UNKNOWN',
        current: currentView(r, on ? routingConfig.policy.classifier : null),
        options: previewOptions(root, { project, classifierConfig: on ? routingConfig.classifier_config : null, now }),
        history,
        registry_git_ignored: registryGitIgnored(root),
    };
}

// ── API do Dashboard (T12) ──────────────────────────────────────────────────────
// O dashboard importa só este módulo de scripts/lib (exceção explícita na lista de
// violações conhecidas, decisão do Richard em 2026-11-06, dívida da F12).

/** Estado para GET /api/routing/classifier. */
function classifierState(root) {
    const routingConfig = policyLoader.readRoutingConfig(root);
    return apiState(root, { routingConfig, project: path.basename(path.resolve(root)) });
}

/** POST /api/routing/classifier. Recusa com SelectionError. */
function changeClassifier(root, { choice, mode = null, expectedVersion, operationId, by, reason, cas } = {}) {
    const routingConfig = policyLoader.readRoutingConfig(root);
    const project = path.basename(path.resolve(root));
    const out = writeSelection(root, {
        choice, mode, expectedVersion, operationId, by, reason, project, cas,
        classifierConfig: routingConfig.status === 'ON' ? routingConfig.classifier_config : null,
    });
    const state = apiState(root, { routingConfig, project });
    return { status: out.status, current: state.current, version: out.current.version, choice: out.current.choice };
}

module.exports = {
    readSelection,
    effectiveClassifier,
    writeSelection,
    previewOptions,
    apiState,
    classifierState,
    changeClassifier,
    currentView,
    platformJevSection,
    registryPath,
    registryGitIgnored,
    SelectionError,
    SCHEMA,
};
