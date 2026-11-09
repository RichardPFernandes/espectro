// Admissão DOM06 de um Attempt (PRI-66).
//
// DOM06 é o writer lógico que aceita o Context Record antes do início do Attempt
// e prende owner/snapshot a essa tentativa. Este módulo não escolhe o mecanismo
// físico que CP002/AR001 ainda deixam em aberto: só o seam que o contrato exige
// pra provar admissão, obligations e autoridade.
//
// Regras:
// - Attempt só fica `started` depois de admissão ADMITTED com owner e snapshot.
//   DENIED e UNKNOWN são gravados, não despacham e o veredito nunca é PASS.
// - Obligations ausentes ficam null (não viram lista vazia nem contagem zero).
//   Obrigação não cumprida permanece no resultado.
// - retry, timeout e resume abrem outro Attempt com o mesmo owner/snapshot.
//   Valor novo proposto é recusado e fica em rebind_refused.
// - Efeito externo só corre com autoridade valid. 401/403 revoga e o efeito
//   seguinte não executa (retry: false). A mesma chave de idempotência cumprida
//   não dispara o efeito de novo.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const RETRY_CAUSES = new Set(['retry', 'timeout', 'resume']);
const BINDING_CAUSES = new Set(['dispatch', 'retry', 'timeout', 'resume']);
// PRI-233 (PRI-205 S4, RC-2/D-5): `escalation` só reservada. Nenhum Attempt com essa
// causa pode ser criado até a S5b (autorização humana). Recusa explícita: antes, causa
// desconhecida virava `dispatch` em silêncio, e escalation passaria como despacho comum.
const RESERVED_CAUSES = new Set(['escalation']);
// Desfechos de resolução que impedem o início do Attempt (v9 §4.7; F13).
const NOT_STARTED_CAUSES = new Set(['CONFIG_UNVERIFIABLE', 'PROVIDER_NOT_ELIGIBLE']);

function assertCauseAllowed(cause) {
    if (RESERVED_CAUSES.has(cause)) throw new Error(`ESCALATION_CAUSE_RESERVED: causa "${cause}" reservada, sem efeito na S4`);
}

function attemptDir(runDir) {
    return path.join(runDir, 'dom06', 'attempts');
}

function attemptPath(runDir, attemptId) {
    return path.join(attemptDir(runDir), `${attemptId}.json`);
}

function writeJson(file, value) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
    fs.renameSync(tmp, file);
}

function readJson(file) {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function stable(value) {
    if (value === null || typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
    return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${stable(value[k])}`).join(',')}}`;
}

function normalizeObligations(list) {
    if (!Array.isArray(list) || list.length === 0) return null;
    return list.map(item => ({
        id: item.id,
        kind: item.kind || 'external_effect',
        status: 'pending',
    }));
}

// PRI-310 (S5.1, B3): Attempt de subtarefa e de integração do Implement decomposto.
// `execute_node` do nó fica no Attempt de integração e só é cumprida pela agregação.
function obligationsFor(node, ctx = null) {
    if (ctx && ctx.role === 'subtask') {
        return [{ id: `execute_subtask:${ctx.subtask_key}`, kind: 'subtask_execution' }];
    }
    if (ctx && ctx.role === 'integration') {
        return [
            { id: `integrate:${ctx.plan_version}`, kind: 'integration' },
            { id: 'execute_node', kind: 'node_execution' },
        ];
    }
    if (node === 'commit') {
        return [
            { id: 'push', kind: 'external_effect' },
            { id: 'pull_request', kind: 'external_effect' },
            { id: 'redmine_status', kind: 'external_effect' },
            { id: 'redmine_notes', kind: 'external_effect' },
        ];
    }
    return [{ id: 'execute_node', kind: 'node_execution' }];
}

function classifyAdmission(admission) {
    if (!admission || admission.status == null || admission.status === 'UNKNOWN') {
        return { dispatch: false, result: 'UNKNOWN', reason: 'ADMISSION_UNKNOWN' };
    }
    if (admission.status === 'DENIED') {
        return { dispatch: false, result: 'DENIED', reason: 'ADMISSION_DENIED' };
    }
    if (admission.status === 'NOT_STARTED') {
        if (!NOT_STARTED_CAUSES.has(admission.cause)) return { dispatch: false, result: 'UNKNOWN', reason: 'ADMISSION_UNKNOWN' };
        return { dispatch: false, result: 'NOT_STARTED', reason: admission.cause };
    }
    if (admission.status !== 'ADMITTED' || !admission.owner || !admission.snapshot || typeof admission.snapshot !== 'object') {
        return { dispatch: false, result: 'UNKNOWN', reason: 'ADMISSION_INCOMPLETE' };
    }
    return { dispatch: true, result: 'ADMITTED', reason: null };
}

function blankAttempt({ node, cause, result }) {
    return {
        attempt_id: crypto.randomUUID(),
        node,
        cause: BINDING_CAUSES.has(cause) ? cause : 'dispatch',
        started: false,
        result,
        owner: null,
        snapshot: null,
        obligations: null,
        effects: [],
        authority: 'absent',
        rebind_refused: null,
        created_at: new Date().toISOString(),
        admitted_at: null,
        revoked_at: null,
        revoke_reason: null,
    };
}

function persist(runDir, attempt) {
    writeJson(attemptPath(runDir, attempt.attempt_id), attempt);
    return attemptPath(runDir, attempt.attempt_id);
}

const ROLES = new Set(['subtask', 'integration', 'gate']);

// Ordem entre Attempts com papel: `seq` (monotônico por Run); created_at só desempata legado.
function bySeq(a, b) {
    const sa = Number.isInteger(a.seq) ? a.seq : 0;
    const sb = Number.isInteger(b.seq) ? b.seq : 0;
    return sa !== sb ? sa - sb : String(a.created_at).localeCompare(String(b.created_at));
}

// Campos da decomposição (PRI-310, B3). Só entram quando há `role`: Attempt AS-IS fica
// byte a byte como antes. `workspace.baseline` é o resumo exportável do manifesto
// (digest, contagens, completeness), nunca caminhos.
function decompositionFields(ctx) {
    if (!ctx || !ROLES.has(ctx.role)) throw new Error(`DECOMPOSITION_ROLE_INVALID: ${ctx && ctx.role}`);
    if (ctx.role !== 'gate' && (typeof ctx.plan_version !== 'string' || !ctx.plan_version)) throw new Error('DECOMPOSITION_PLAN_VERSION_REQUIRED');
    if (ctx.role === 'subtask' && (typeof ctx.subtask_key !== 'string' || !ctx.subtask_key)) throw new Error('DECOMPOSITION_SUBTASK_KEY_REQUIRED');
    return {
        role: ctx.role,
        subtask_key: ctx.role === 'subtask' ? ctx.subtask_key : null,
        plan_version: ctx.plan_version ?? null,
        steps: Array.isArray(ctx.steps) ? [...ctx.steps] : null,
        parent_attempt_id: ctx.parent_attempt_id ?? null,
        lineage_id: ctx.role === 'subtask' ? ctx.subtask_key : null,
        rework: Boolean(ctx.rework),
        context_record_sha256: ctx.context_record_sha256 ?? null,
        // PRI-311 (H0): HMAC do escopo do baseline com a chave da Run; nunca o escopo.
        scope_hmac: typeof ctx.scope_hmac === 'string' ? ctx.scope_hmac : null,
        chain_anchor: ctx.chain_anchor ? structuredClone(ctx.chain_anchor) : null,
        workspace: { baseline: ctx.workspace_baseline ? structuredClone(ctx.workspace_baseline) : null, post: null },
        acceptance: null,
    };
}

function beginAttempt(runDir, { node, admission, obligations, cause = 'dispatch', rebindRefused = null, routing, decomposition } = {}) {
    assertCauseAllowed(cause);
    const gate = classifyAdmission(admission);
    const attempt = blankAttempt({ node, cause, result: gate.result });
    attempt.rebind_refused = rebindRefused;
    if (decomposition != null) {
        Object.assign(attempt, decompositionFields(decomposition));
        // Ordinal monotônico por Run entre Attempts com papel (C-O-04): a ordem integração ×
        // rework não depende de created_at em ms nem do desempate aleatório do listing.
        attempt.seq = 1 + listAttempts(runDir).reduce((m, a) => (a.role && Number.isInteger(a.seq) && a.seq > m ? a.seq : m), 0);
    }
    // RoutingDecision (PRI-233) só quando há roteamento: Attempt AS-IS fica sem o campo.
    if (routing !== undefined) attempt.routing = structuredClone(routing);
    if (gate.result === 'NOT_STARTED') {
        attempt.not_started = { cause: admission.cause, detail: admission.detail ?? null };
    }
    if (!gate.dispatch) {
        const attemptFile = persist(runDir, attempt);
        return { dispatch: false, reason: gate.reason, attempt, attemptFile, spawned: false };
    }
    attempt.started = true;
    attempt.result = 'STARTED';
    attempt.owner = admission.owner;
    attempt.snapshot = structuredClone(admission.snapshot);
    attempt.obligations = normalizeObligations(obligations ?? (decomposition != null && decomposition.role !== 'gate'
        ? obligationsFor(node, decomposition) : admission.obligations));
    attempt.authority = 'valid';
    attempt.admitted_at = attempt.created_at;
    const attemptFile = persist(runDir, attempt);
    return { dispatch: true, reason: null, attempt, attemptFile, spawned: false };
}

function listAttempts(runDir) {
    const dir = attemptDir(runDir);
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir)
        .filter(name => name.endsWith('.json'))
        .map(name => readJson(path.join(dir, name)))
        .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
}

// PRI-310 (S5.1, B3): seleção do anterior por (nó, subtask_key). Sem opções, só Attempts
// sem `role` (AS-IS): um retry do Implement não decomposto nunca pega um Attempt de passo.
// Com `subtaskKey`, só essa chave; com `role`, só esse papel.
function latestBound(runDir, node, { subtaskKey = null, role = null } = {}) {
    const found = listAttempts(runDir).filter(item => {
        if (item.node !== node || !item.started || !item.owner || !item.snapshot) return false;
        if (subtaskKey != null) return item.role === 'subtask' && item.subtask_key === subtaskKey;
        if (role != null) return item.role === role;
        return !item.role;
    });
    if (found.length && (subtaskKey != null || role != null)) found.sort(bySeq);
    return found.length ? found[found.length - 1] : null;
}

function readAttempt(attemptFile) {
    return readJson(attemptFile);
}

function retryAttempt(runDir, { node, cause, proposed, routing, decomposition } = {}) {
    assertCauseAllowed(cause);
    const previous = decomposition != null
        ? latestBound(runDir, node, decomposition.role === 'subtask' ? { subtaskKey: decomposition.subtask_key } : { role: decomposition.role })
        : latestBound(runDir, node);
    // Retry da mesma chave encadeia o anterior (B3): parent_attempt_id obrigatório.
    if (decomposition != null && previous && decomposition.parent_attempt_id == null) {
        decomposition = { ...decomposition, parent_attempt_id: previous.attempt_id };
    }
    if (!previous || previous.authority === 'revoked' || !Array.isArray(previous.obligations)) {
        const reason = previous?.authority === 'revoked' ? 'AUTHORITY_REVOKED' : 'ADMISSION_UNKNOWN';
        return beginAttempt(runDir, {
            node,
            cause,
            routing,
            decomposition,
            admission: { status: previous?.authority === 'revoked' ? 'DENIED' : 'UNKNOWN' },
            rebindRefused: proposed ? { owner: proposed.owner ?? null, snapshot: proposed.snapshot ?? null, reason } : null,
        });
    }
    const proposedOwner = proposed?.owner ?? null;
    const proposedSnapshot = proposed?.snapshot ?? null;
    const refused = proposedOwner !== previous.owner || stable(proposedSnapshot) !== stable(previous.snapshot);
    return beginAttempt(runDir, {
        node,
        cause,
        routing,
        decomposition,
        admission: {
            status: 'ADMITTED',
            owner: previous.owner,
            snapshot: structuredClone(previous.snapshot),
            obligations: previous.obligations.map(item => ({ id: item.id, kind: item.kind })),
        },
        rebindRefused: refused ? { owner: proposedOwner, snapshot: proposedSnapshot, reason: 'REBIND_REFUSED' } : null,
    });
}

function readHold(runDir) {
    const file = path.join(runDir, 'dom06', 'hold.json');
    if (!fs.existsSync(file)) return null;
    try {
        const parsed = readJson(file);
        if (!parsed || (parsed.status !== 'DENIED' && parsed.status !== 'UNKNOWN' && parsed.status !== 'ADMITTED')) {
            return { status: 'UNKNOWN' };
        }
        return parsed;
    } catch {
        return { status: 'UNKNOWN' };
    }
}

function causeFromState(state) {
    const recovered = state?.recovered_from_orphan;
    if (recovered && recovered.node === state.node) {
        return recovered.reason === 'timeout' ? 'timeout' : 'resume';
    }
    if ((Number(state?.retries?.[state.node]) || 0) > 0) return 'retry';
    return 'dispatch';
}

// `routing` (PRI-233): snapshot routing da Run, fixado na admissão. Só entra no
// snapshot do Attempt quando passado; sem ele, o snapshot fica como no AS-IS.
// `routingDecision`: RoutingDecision resolvida para este Attempt (despacho roteado).
// `decomposition` (PRI-310, B3): contexto do Attempt de subtarefa/integração/gate. Com ele a
// causa vem explícita do watcher (A-15): `retry` só para nova tentativa da mesma chave.
function prepareDispatch({ runDir, node, ticketId, baseBranch = null, specHash = null, cause = 'dispatch', state = null, routing, routingDecision, decomposition } = {}) {
    const resolvedCause = state && decomposition == null ? causeFromState(state) : cause;
    assertCauseAllowed(resolvedCause);
    const hold = readHold(runDir);
    if (hold && hold.status !== 'ADMITTED') {
        return beginAttempt(runDir, {
            node,
            cause: resolvedCause,
            decomposition,
            admission: { status: hold.status === 'DENIED' ? 'DENIED' : 'UNKNOWN' },
        });
    }
    const snapshot = {
        ticket_id: ticketId,
        node,
        base_branch: baseBranch,
        spec_hash: specHash,
    };
    if (routing !== undefined) snapshot.routing = structuredClone(routing);
    const needsIdentity = snapshot.ticket_id == null || snapshot.ticket_id === '' || !snapshot.node || !snapshot.base_branch;
    const proposed = needsIdentity
        ? { status: 'UNKNOWN', owner: null, snapshot }
        : { status: 'ADMITTED', owner: 'dom06', snapshot };
    if (RETRY_CAUSES.has(resolvedCause)) {
        const previous = decomposition != null
            ? latestBound(runDir, node, decomposition.role === 'subtask' ? { subtaskKey: decomposition.subtask_key } : { role: decomposition.role })
            : latestBound(runDir, node);
        if (previous) return retryAttempt(runDir, { node, cause: resolvedCause, proposed, routing: routingDecision, decomposition });
    }
    return beginAttempt(runDir, {
        node,
        cause: resolvedCause,
        routing: routingDecision,
        decomposition,
        admission: proposed.status === 'ADMITTED' ? proposed : { status: 'UNKNOWN' },
        obligations: proposed.status === 'ADMITTED' ? obligationsFor(node, decomposition && decomposition.role !== 'gate' ? decomposition : null) : null,
    });
}

function spawnIfAdmitted(decision, spawn) {
    if (!decision?.dispatch) return { ...decision, spawned: false };
    spawn(decision);
    return { ...decision, spawned: true };
}

function loadForUpdate(attemptFile) {
    const attempt = readAttempt(attemptFile);
    const saved = stable({ owner: attempt.owner, snapshot: attempt.snapshot });
    return { attempt, saved };
}

function saveFrozen(attemptFile, attempt, saved) {
    if (stable({ owner: attempt.owner, snapshot: attempt.snapshot }) !== saved) {
        throw new Error('rebind de owner/snapshot recusado');
    }
    writeJson(attemptFile, attempt);
    return attempt;
}

function recordEffect(attemptFile, { obligation_id: obligationId, idempotency_key: idempotencyKey, status, detail = null, http_status: httpStatus = null } = {}) {
    const { attempt, saved } = loadForUpdate(attemptFile);
    const effects = Array.isArray(attempt.effects) ? attempt.effects : [];
    const existing = effects.find(item => item.idempotency_key === idempotencyKey && item.status === 'fulfilled');
    if (existing && status === 'fulfilled') return { attempt, duplicate: true, effect: existing };
    effects.push({
        obligation_id: obligationId,
        idempotency_key: idempotencyKey,
        status,
        detail,
        http_status: httpStatus,
        at: new Date().toISOString(),
    });
    attempt.effects = effects;
    if (Array.isArray(attempt.obligations)) {
        const obligation = attempt.obligations.find(item => item.id === obligationId);
        if (obligation) obligation.status = status === 'fulfilled' ? 'fulfilled' : obligation.status;
        else attempt.obligations.push({ id: obligationId, kind: 'external_effect', status: status === 'fulfilled' ? 'fulfilled' : 'pending' });
    }
    saveFrozen(attemptFile, attempt, saved);
    return { attempt, duplicate: false };
}

function revoke(attemptFile, { reason = 'revoked' } = {}) {
    const { attempt, saved } = loadForUpdate(attemptFile);
    attempt.authority = 'revoked';
    attempt.revoked_at = new Date().toISOString();
    attempt.revoke_reason = reason;
    saveFrozen(attemptFile, attempt, saved);
    return attempt;
}

function authorizeEffect(attempt, { obligationId, idempotencyKey } = {}) {
    if (!attempt?.started || attempt.authority !== 'valid') {
        const error = attempt?.authority === 'revoked' ? 'AUTHORITY_REVOKED' : 'AUTHORITY_INVALID';
        return { ok: false, error, retry: false, duplicate: false };
    }
    const existing = (attempt.effects || []).find(item => item.idempotency_key === idempotencyKey && item.status === 'fulfilled');
    if (existing) return { ok: true, error: null, retry: false, duplicate: true, effect: existing };
    return { ok: true, error: null, retry: false, duplicate: false };
}

async function applyExternalEffect(attemptFile, { obligationId, idempotencyKey, perform }) {
    const attempt = readAttempt(attemptFile);
    const auth = authorizeEffect(attempt, { obligationId, idempotencyKey });
    if (!auth.ok || auth.duplicate) return { ...auth, performed: false };
    let outcome;
    try {
        outcome = await perform();
    } catch (err) {
        recordEffect(attemptFile, {
            obligation_id: obligationId,
            idempotency_key: idempotencyKey,
            status: 'failed',
            detail: err && err.message ? err.message : String(err),
        });
        return { ok: false, error: 'EFFECT_FAILED', retry: false, duplicate: false, performed: true };
    }
    const status = Number(outcome?.status);
    if (status === 401 || status === 403) {
        recordEffect(attemptFile, {
            obligation_id: obligationId,
            idempotency_key: idempotencyKey,
            status: 'failed',
            http_status: status,
            detail: outcome.detail || null,
        });
        revoke(attemptFile, { reason: `http_${status}` });
        return { ok: false, error: 'AUTHORITY_REVOKED', retry: false, duplicate: false, performed: true, status };
    }
    const fulfilled = outcome?.ok !== false && status >= 200 && status < 300;
    recordEffect(attemptFile, {
        obligation_id: obligationId,
        idempotency_key: idempotencyKey,
        status: fulfilled ? 'fulfilled' : 'failed',
        http_status: Number.isFinite(status) ? status : null,
        detail: outcome?.detail || null,
    });
    return { ok: fulfilled, error: fulfilled ? null : 'EFFECT_FAILED', retry: false, duplicate: false, performed: true, status };
}

// Desfecho explícito de um Attempt de efeito (db-effect, handback_qa): COMPLETE, FAILED
// ou UNCERTAIN. Não mexe em owner/snapshot (saveFrozen) nem nas obligations — quem
// decide PASS continua sendo summarize; isto só registra que a tentativa acabou e como.
const CLOSE_RESULTS = new Set(['COMPLETE', 'FAILED', 'UNCERTAIN']);
function closeAttempt(attemptFile, { result, reason = null } = {}) {
    if (!CLOSE_RESULTS.has(result)) throw new TypeError(`closeAttempt: resultado inválido ${result}`);
    const { attempt, saved } = loadForUpdate(attemptFile);
    attempt.result = result;
    attempt.closed_at = new Date().toISOString();
    attempt.close_reason = reason;
    saveFrozen(attemptFile, attempt, saved);
    return attempt;
}

// PUT/POST no Redmine como efeito governado: chave no header X-Redmine-API-Key (sem
// ela o Redmine responde 401 e o Attempt seria revogado), idempotência pela chave e
// 401/403 revogando. Usado pela CLI redmine-effect (/commit) e, em processo, pelo
// handback ao QA (scripts/lib/qa-handback.js). Devolve também o corpo (truncado) da
// resposta, para o caller explicar um 422.
async function redmineEffect(attemptFile, { url, method = 'PUT', body, obligationId = 'redmine_notes', idempotencyKey = null, env = process.env, fetchImpl = null } = {}) {
    const key = idempotencyKey || crypto.createHash('sha256').update(`${method}\n${url}\n${body}`).digest('hex');
    const apiKey = String(env.REDMINE_API_KEY || '').trim();
    if (!apiKey) return { ok: false, error: 'REDMINE_API_KEY_MISSING', performed: false, duplicate: false };
    const { createRedmineFetch } = require('./redmine-fetch');
    const redmineFetch = createRedmineFetch({ env, ...(fetchImpl ? { fetch: fetchImpl } : {}) });
    let responseText = null;
    const result = await applyExternalEffect(attemptFile, {
        obligationId,
        idempotencyKey: key,
        perform: async () => {
            const response = await redmineFetch(url, { method, body, headers: { 'X-Redmine-API-Key': apiKey, 'Content-Type': 'application/json' } });
            responseText = await response.text();
            return { status: response.status, ok: response.ok, detail: responseText.slice(0, 500) };
        },
    });
    return { ...result, key, body: responseText };
}

// Exit 0 de um nó que não é commit cumpre execute_node. Commit fica com as
// obrigações externas, gravadas pelos scripts de push/PR/Redmine. Chamar de
// novo com a mesma chave não duplica o effect. code null (despacho detached
// ainda em voo) não cumpre nada.
function fulfillOnExit({ attemptFile, attemptId, node, code } = {}) {
    if (!attemptFile || !attemptId || node === 'commit') return false;
    if (code === null || code === undefined || code === '' || Number(code) !== 0) return false;
    try {
        recordEffect(attemptFile, {
            obligation_id: 'execute_node',
            idempotency_key: `execute:${attemptId}`,
            status: 'fulfilled',
        });
        return true;
    } catch (err) {
        console.error(`Falha registrando effect do Attempt ${attemptId}:`, err.message);
        return false;
    }
}

// ---------------------------------------------------------------------------------
// Saída única e agregação do Implement decomposto (PRI-310 / PRI-287 S5.1, SDD B3)

const LOST_CLAIM = new Set(['LEASE_REPLACED', 'SESSION_CONFLICT']);
const EXEMPT_CAUSES = new Set(['PROVIDER_UNAVAILABLE', 'SESSION_LIMIT']);
const HUMAN_ANCHORS = new Set(['HUMAN_RESUME', 'HUMAN_UNBLOCK']);
const UNOBSERVED_POST = Object.freeze({ digest: null, counts: null, completeness: 'UNKNOWN', cause: 'POST_NOT_OBSERVED' });

function complete(summary) {
    return Boolean(summary && summary.completeness === 'COMPLETE' && typeof summary.digest === 'string');
}

// Resumo exportável do manifesto: digest, contagens, completeness e causa. Nada além.
function manifestSummary(m) {
    if (!m || typeof m !== 'object') return { ...UNOBSERVED_POST };
    const ok = m.completeness === 'COMPLETE' && typeof m.digest === 'string';
    return {
        digest: ok ? m.digest : null,
        counts: ok && m.counts && typeof m.counts === 'object' ? { ...m.counts } : null,
        completeness: ok ? 'COMPLETE' : 'UNKNOWN',
        cause: ok ? null : (m.cause || 'UNKNOWN'),
    };
}

/**
 * Tabela de aceite da SDD (B3), pura. `claim` = motivo de releaseNodeWithReason.
 * `parentAcceptance` = aceite do `parent_attempt_id` (teto de retry, B4).
 * `currentPlanVersion` ausente = versão vigente desconhecida → não aceita (fail-closed).
 * `operationalCause` (PRI-311, H2): PROVIDER_UNAVAILABLE e SESSION_LIMIT sem mutação não
 * consomem o teto (`exempt`); com mutação ou UNKNOWN bloqueiam como qualquer falha.
 * Devolve { accepted, reason, block, no_change, retry_allowed, exempt? }.
 */
function decideAcceptance({ attempt, code, claim, post, currentPlanVersion, parentAcceptance = null, operationalCause = null }) {
    const baseline = attempt?.workspace?.baseline || null;
    const same = complete(baseline) && complete(post) && baseline.digest === post.digest;
    const out = (accepted, reason, block, extra = {}) => ({ accepted, reason, block, no_change: same, retry_allowed: false, ...extra });
    // Claim perdido: resultado tardio (F9), nunca aplicado; com mutação ou UNKNOWN o diff
    // nunca é herdado.
    if (LOST_CLAIM.has(claim)) return out(false, 'CLAIM_LOST', !same);
    // O comando gravou outro status: segue o caminho desse status (não é perda de claim
    // nem bloqueio do manifesto; a retomada humana reancora, B4 HUMAN_RESUME).
    if (claim === 'STATUS_CHANGED') return out(false, 'STATUS_CHANGED', false);
    if (claim === 'STATE_MISSING') return out(false, 'STATE_MISSING', true);
    if (claim !== 'RELEASED') return out(false, 'CLAIM_UNKNOWN', true);
    // Versão vigente desconhecida = não aceita (fail-closed); superada = resultado tardio.
    if (currentPlanVersion === undefined || currentPlanVersion === null) return out(false, 'PLAN_VERSION_UNKNOWN', true);
    if (attempt.plan_version !== currentPlanVersion) return out(false, 'PLAN_SUPERSEDED', !same);
    if (Number(code) !== 0) {
        if (same) {
            // Indisponibilidade do provider e session_limit, só sem mutação: fora do teto e
            // redespachadas como no controle (D15; PRI-311 H2, O-04).
            if (EXEMPT_CAUSES.has(operationalCause)) {
                return out(false, 'OPERATIONAL_FAILURE_EXEMPT', false, { retry_allowed: true, exempt: true });
            }
            // Teto (B4, AC-20): um retry automático por chave sem mutação. A 2ª falha
            // operacional da mesma chave (o pai já era falha sem mutação) bloqueia.
            // Pela linhagem, não pela causa (R2-C-O-02): qualquer nova tentativa da mesma chave
            // cujo pai foi falha sem mutação (retry, timeout, resume ou dispatch) bate no teto.
            // PRI-311 (R2-O-03): pai isento não conta; Attempt reancorado por ato humano
            // (HUMAN_RESUME/HUMAN_UNBLOCK) recomeça a contagem.
            const humanAnchor = attempt.chain_anchor && HUMAN_ANCHORS.has(attempt.chain_anchor.reason);
            if (attempt.parent_attempt_id && !humanAnchor && parentAcceptance
                && parentAcceptance.retry_allowed === true && parentAcceptance.exempt !== true) {
                return out(false, 'RETRY_CEILING', true);
            }
            return out(false, 'OPERATIONAL_FAILURE', false, { retry_allowed: true });
        }
        const both = complete(baseline) && complete(post);
        return out(false, both ? 'PARTIAL_MUTATION' : 'MANIFEST_UNKNOWN', true);
    }
    if (!complete(post)) return out(false, 'POST_UNKNOWN', true);
    return out(true, null, false);
}

/**
 * Saída única do Attempt (os dois caminhos: releaseLease em --follow e o wrapper
 * `node-lease.js release` no modo destacado). Attempt sem `role` delega ao fulfillOnExit
 * de sempre, sem mudança. Gate: cumpre execute_node como hoje e grava o `post`.
 * Subtarefa/integração: aplica a tabela de aceite; só o aceite cumpre a obrigação.
 * Idempotente: um aceite já gravado é devolvido sem regravar.
 */
function closeOnExit({ attemptFile, attemptId, node, code, claim = null, manifestPost, currentPlanVersion, operationalCause = null, signalled = false } = {}) {
    if (!attemptFile || !attemptId) return false;
    let attempt;
    try {
        attempt = readAttempt(attemptFile);
    } catch {
        return fulfillOnExit({ attemptFile, attemptId, node, code });
    }
    if (!attempt.role) return fulfillOnExit({ attemptFile, attemptId, node, code });
    // Despacho destacado ainda em voo: nada a decidir. Em --follow, saída sem código (sinal ou
    // erro de spawn, `signalled`) é falha do agente (PRI-311, C-O-02).
    const noCode = code === null || code === undefined || code === '';
    if (noCode && !signalled) return { pending: true };
    const effectiveCode = noCode ? 1 : code;
    try {
        const obligationId = attempt.role === 'subtask' ? `execute_subtask:${attempt.subtask_key}` : `integrate:${attempt.plan_version}`;
        if (attempt.role === 'gate') {
            const fulfilled = fulfillOnExit({ attemptFile, attemptId, node, code });
            // O post do gate é gravado uma vez (a 2ª chamada não regrava).
            if (!attempt.workspace || attempt.workspace.post == null) {
                const { attempt: fresh, saved } = loadForUpdate(attemptFile);
                fresh.workspace = { ...(fresh.workspace || {}), post: manifestSummary(manifestPost) };
                saveFrozen(attemptFile, fresh, saved);
            }
            return { gate: true, fulfilled };
        }
        if (attempt.acceptance) {
            // Queda entre gravar o aceite e cumprir a obrigação (C-O-03): completa agora; a
            // chave execute:<id> é idempotente.
            const pendingObligation = (attempt.obligations || []).some(o => o.id === obligationId && o.status !== 'fulfilled');
            if (attempt.acceptance.accepted === true && pendingObligation) {
                recordEffect(attemptFile, { obligation_id: obligationId, idempotency_key: `execute:${attemptId}`, status: 'fulfilled' });
            }
            return { ...attempt.acceptance, duplicate: true };
        }
        const post = manifestSummary(manifestPost);
        let parentAcceptance = null;
        if (attempt.parent_attempt_id) {
            // O pai mora no mesmo diretório de Attempts da Run.
            try { parentAcceptance = readAttempt(path.join(path.dirname(attemptFile), `${attempt.parent_attempt_id}.json`)).acceptance || null; } catch { parentAcceptance = null; }
        }
        const decision = decideAcceptance({ attempt, code: effectiveCode, claim, post, currentPlanVersion, parentAcceptance, operationalCause });
        const { attempt: fresh, saved } = loadForUpdate(attemptFile);
        fresh.workspace = { ...(fresh.workspace || {}), post };
        fresh.acceptance = {
            ...decision, claim, exit_code: noCode ? null : Number(code),
            operational_cause: Number(effectiveCode) === 0 ? null : (operationalCause || 'AGENT_FAILURE'),
            decided_at: new Date().toISOString(),
        };
        saveFrozen(attemptFile, fresh, saved);
        if (decision.accepted) {
            recordEffect(attemptFile, { obligation_id: obligationId, idempotency_key: `execute:${attemptId}`, status: 'fulfilled' });
        }
        return decision;
    } catch (err) {
        console.error(`Falha fechando o Attempt ${attemptId}:`, err.message);
        return false;
    }
}

/**
 * `execute_node` do Implement decomposto, cumprida só pela agregação (B3). Exige, para a
 * `planVersion`: o último Attempt (por `seq`) de cada chave (e do rework `<pv12>/ALL`, se
 * houve) aceito, e o último Attempt de integração aceito, com `integrate:<pv>` cumprida,
 * posterior a todos eles. Idempotência POR VISITA (C-A-01): uma agregação já gravada só é
 * devolvida se nenhum Attempt de subtarefa da `planVersion` veio depois da integração que a
 * gravou; um rework posterior exige nova integração e nova agregação. A chave é
 * `aggregate:<pv>:<attempt_id da integração>`.
 */
function aggregateImplement(runDir, planVersion, subtaskKeys) {
    if (typeof planVersion !== 'string' || !planVersion || !Array.isArray(subtaskKeys) || subtaskKeys.length === 0) {
        return { ok: false, pending: null, reason: 'AGGREGATE_INPUT_INVALID' };
    }
    const prefix = `aggregate:${planVersion}:`;
    const roleAttempts = listAttempts(runDir).filter(a => a.role && a.plan_version === planVersion).sort(bySeq);
    const seqOf = a => (Number.isInteger(a.seq) ? a.seq : 0);
    const keys = [...new Set(subtaskKeys)];
    const ak = allKey(planVersion);
    if (!keys.includes(ak) && roleAttempts.some(a => a.role === 'subtask' && a.subtask_key === ak)) keys.push(ak);
    const pending = [];
    let lastKeySeq = 0;
    for (const k of keys) {
        const mine = roleAttempts.filter(a => a.role === 'subtask' && a.subtask_key === k);
        const last = mine[mine.length - 1];
        if (last && seqOf(last) > lastKeySeq) lastKeySeq = seqOf(last);
        if (!last || !last.acceptance || last.acceptance.accepted !== true) pending.push(k);
    }
    const integrations = roleAttempts.filter(a => a.role === 'integration');
    const integ = integrations[integrations.length - 1];
    const integOk = integ && integ.acceptance && integ.acceptance.accepted === true
        && (integ.obligations || []).some(o => o.id === `integrate:${planVersion}` && o.status === 'fulfilled')
        && seqOf(integ) > lastKeySeq;
    if (!integOk) pending.push(`integrate:${planVersion}`);
    if (pending.length) return { ok: false, pending };
    // Integração válida desta visita: a agregação gravada nela (se houver) é a da visita.
    const done = roleAttempts.find(a => (a.effects || []).some(e => typeof e.idempotency_key === 'string' && e.idempotency_key.startsWith(prefix) && e.status === 'fulfilled')
        && seqOf(a) > lastKeySeq);
    if (done) return { ok: true, duplicate: true, attempt_id: done.attempt_id };
    recordEffect(attemptPath(runDir, integ.attempt_id), { obligation_id: 'execute_node', idempotency_key: `${prefix}${integ.attempt_id}`, status: 'fulfilled' });
    return { ok: true, duplicate: false, attempt_id: integ.attempt_id };
}

// Chave sintética do rework do nó inteiro (B5.7), fora da identidade D14. Fonte única.
function allKey(planVersion) {
    return `${String(planVersion).slice(0, 12)}/ALL`;
}

/**
 * Órfão (STARTED sem saída) no recovery existente: fecha como UNCERTAIN, com o manifesto
 * corrente comparado ao `baseline`. Nunca cumpre obrigação nem reaplica efeito.
 */
function closeOrphan(attemptFile, { manifestNow, orphanReason = null } = {}) {
    const { attempt, saved } = loadForUpdate(attemptFile);
    if (!attempt.role || attempt.acceptance) return attempt.acceptance || null;
    if (!attempt.started || attempt.result !== 'STARTED') return null;
    const post = manifestSummary(manifestNow);
    const baseline = attempt.workspace?.baseline || null;
    const same = complete(baseline) && complete(post) && baseline.digest === post.digest;
    // PRI-311 (H4, O-06): órfão por timeout não tem pid gravado — o agente pode estar vivo e
    // escrevendo, então "sem mutação" lido agora não autoriza retry. Divergência conservadora
    // declarada em relação à SPEC B3/AC-10.
    const retryAllowed = same && orphanReason !== 'timeout';
    attempt.result = 'UNCERTAIN';
    attempt.workspace = { ...(attempt.workspace || {}), post };
    attempt.acceptance = {
        accepted: false, reason: 'ORPHAN_UNCERTAIN', block: !retryAllowed, no_change: same, retry_allowed: retryAllowed,
        orphan_reason: orphanReason, claim: null, exit_code: null, decided_at: new Date().toISOString(),
    };
    saveFrozen(attemptFile, attempt, saved);
    return attempt.acceptance;
}

function summarize(attempt) {
    const obligations = Array.isArray(attempt?.obligations) ? attempt.obligations : null;
    const summary = {
        attempt_id: attempt?.attempt_id || null,
        started: Boolean(attempt?.started),
        owner: attempt?.owner ?? null,
        snapshot: attempt?.snapshot ?? null,
        authority: attempt?.authority || 'absent',
        obligations,
        effects: Array.isArray(attempt?.effects) ? attempt.effects : [],
        pending: null,
        pending_count: null,
        pass: false,
        result: 'UNKNOWN',
        verdict: 'UNKNOWN',
    };
    if (!attempt?.started) {
        const result = attempt?.result === 'DENIED' || attempt?.result === 'NOT_STARTED' ? attempt.result : 'UNKNOWN';
        return { ...summary, result, verdict: result };
    }
    if (!obligations) return summary;
    const pending = obligations.filter(item => item.status !== 'fulfilled');
    if (pending.length === 0 && attempt.authority === 'valid') {
        return { ...summary, pending, pending_count: 0, pass: true, result: 'COMPLETE', verdict: 'PASS' };
    }
    return { ...summary, pending, pending_count: pending.length, result: 'INCOMPLETE', verdict: 'INCOMPLETE' };
}

// Registro `escalation_proposal` (RC-2/DP-1): só a forma. Não há produtor na S4 e nenhum
// caminho do escritor transforma a proposta em despacho. A proposta nunca carrega a
// autorização: authorization_ref nasce null e só a S5b (humano) a preenche.
function validateEscalationProposal(p) {
    if (!p || typeof p !== 'object' || Array.isArray(p)) return { ok: false, errors: ['not_object'] };
    const errors = [];
    const route = r => r && typeof r === 'object' && typeof r.model_id === 'string' && r.model_id !== '' && typeof r.effort === 'string' && r.effort !== '';
    if (typeof p.node !== 'string' || !p.node) errors.push('node_invalid');
    if (p.subtask_key !== null && typeof p.subtask_key !== 'string') errors.push('subtask_key_invalid');
    if (typeof p.failure_class !== 'string' || !p.failure_class) errors.push('failure_class_invalid');
    if (!route(p.from)) errors.push('from_invalid');
    if (!route(p.to)) errors.push('to_invalid');
    if (typeof p.proposed_at !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(p.proposed_at) || !Number.isFinite(Date.parse(p.proposed_at))) {
        errors.push('proposed_at_invalid');
    }
    if (p.authorization_ref !== null) errors.push('authorization_ref_must_be_null');
    return { ok: errors.length === 0, errors };
}

function argValue(argv, name) {
    const index = argv.indexOf(name);
    if (index === -1 || index + 1 >= argv.length) return null;
    return argv[index + 1];
}

function printRefusal(auth) {
    const error = auth.error || 'AUTHORITY_INVALID';
    process.stderr.write(`ERROR: ${error} — efeito recusado, sem retry.\n`);
    process.exit(3);
}

async function main(argv) {
    const [cmd] = argv;
    const attemptFile = argValue(argv, '--attempt');
    if (!cmd || !attemptFile) {
        process.stderr.write('Uso: dom06-attempt.js <authorize|record|revoke|summarize|redmine-effect> --attempt <arquivo> ...\n');
        process.exit(2);
    }
    if (cmd === 'summarize') {
        process.stdout.write(`${JSON.stringify(summarize(readAttempt(attemptFile)))}\n`);
        return;
    }
    if (cmd === 'revoke') {
        revoke(attemptFile, { reason: argValue(argv, '--reason') || 'revoked' });
        process.stdout.write('REVOKED\n');
        return;
    }
    const obligationId = argValue(argv, '--obligation');
    const idempotencyKey = argValue(argv, '--key');
    if (cmd === 'authorize') {
        const auth = authorizeEffect(readAttempt(attemptFile), { obligationId, idempotencyKey });
        if (!auth.ok) printRefusal(auth);
        if (auth.duplicate) {
            process.stdout.write(`DUPLICATE ${auth.effect?.detail || ''}\n`.replace(/ \n/, '\n'));
            return;
        }
        process.stdout.write('ALLOW\n');
        return;
    }
    if (cmd === 'record') {
        recordEffect(attemptFile, {
            obligation_id: obligationId,
            idempotency_key: idempotencyKey,
            status: argValue(argv, '--status') || 'fulfilled',
            detail: argValue(argv, '--detail'),
        });
        process.stdout.write('RECORDED\n');
        return;
    }
    if (cmd === 'redmine-effect') {
        const url = argValue(argv, '--url');
        const method = argValue(argv, '--method') || 'PUT';
        const body = fs.readFileSync(0, 'utf8');
        // A chave vai no header, como em todo outro call site do Redmine (watcher,
        // dashboard). Sem ela o Redmine responde 401 e applyExternalEffect revoga o
        // Attempt — foi o que travou o "Ag Merge" de todos os /commit desde o PRI-66.
        // Chave ausente é erro de configuração, não autoridade revogada: sai antes do
        // efeito, sem gravar falha nem revogar.
        const result = await redmineEffect(attemptFile, { url, method, body, obligationId: obligationId || 'redmine_notes', idempotencyKey });
        if (result.error === 'REDMINE_API_KEY_MISSING') {
            process.stderr.write('ERROR: REDMINE_API_KEY ausente no ambiente — Redmine não foi chamado.\n');
            process.exit(1);
        }
        if (result.duplicate) {
            process.stdout.write('DUPLICATE\n');
            return;
        }
        if (!result.ok) {
            process.stderr.write(`ERROR: ${result.error} — Redmine não foi repetido.\n`);
            process.exit(result.error === 'AUTHORITY_REVOKED' || result.error === 'AUTHORITY_INVALID' ? 3 : 1);
        }
        process.stdout.write('OK\n');
        return;
    }
    process.stderr.write(`comando desconhecido: ${cmd}\n`);
    process.exit(2);
}

module.exports = {
    allKey,
    closeOnExit,
    decideAcceptance,
    aggregateImplement,
    closeOrphan,
    manifestSummary,
    decompositionFields,
    beginAttempt, retryAttempt, prepareDispatch, causeFromState, spawnIfAdmitted,
    readAttempt, recordEffect, revoke, authorizeEffect, applyExternalEffect, summarize,
    fulfillOnExit, obligationsFor, listAttempts, closeAttempt, redmineEffect,
    RESERVED_CAUSES, NOT_STARTED_CAUSES, validateEscalationProposal,
};

if (require.main === module) {
    main(process.argv.slice(2)).catch(err => {
        process.stderr.write(`ERROR: ${err.message}\n`);
        process.exit(1);
    });
}
