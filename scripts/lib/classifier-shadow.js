// Núcleo 2 do roteamento em SOMBRA (PRI-205 S3b, SPEC §B6/§B7): coleta as opiniões
// do Jev para os grupos do Implement antes do spawn. Nada aqui muda o despacho: a
// classe, o modelo e o argv continuam saindo só do núcleo 1 (model-routing).
//
// Por grupo selecionado (classifier-gray-zone.prioritize, teto de 3):
//   envelope → classifier-guard (bloqueia sem chamar) → Attempt de efeito
//   (`node: classifier`, intenção durável ANTES do envio) → jev-client.classify →
//   recordEffect + closeAttempt (COMPLETE / FAILED / UNCERTAIN).
// Reuso do registro existente do DOM-06 (R-4, padrão db-effect.js); sem journal novo.
//
// Não repetição (B7, AGENTS.md regra 5):
// - EffectId = sha256(task, nó, visita, subtask_key, envelope, prompt, rep_index).
// - Mesma EffectId já COMPLETE → reusa a opinião; FAILED/UNCERTAIN/STARTED → não chama.
// - 401/403 → revoga o efeito e grava `<run>/dom06/classifier-disabled.json`: o núcleo
//   2 fica off no resto da Run.
// O Attempt do Implement nunca é tocado (AC-11). Nunca lança.
//
// A resposta compacta vai no `detail` do efeito, em JSON (classe, confianças, risco,
// modelo reportado, latência, parse). Nunca o corpo bruto, o envelope ou a chave.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const dom06 = require('./dom06-attempt');
const grayZone = require('./classifier-gray-zone');
const classifierGuard = require('./classifier-guard');
const classifierAuthority = require('./classifier-authority');
const jevClient = require('./jev-client');

const NODE = 'classifier';
const OBLIGATION = 'classifier_call';
const CLASS_RANK = { C1: 1, C2: 2, C3: 3, C4: 4, C5: 5 };
const CLASSES = ['C1', 'C2', 'C3', 'C4', 'C5'];
const UP_MIN = 0.3;
const DOWN_MIN = 0.6;

function canonical(value) {
    if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
    if (value && typeof value === 'object') {
        return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
    }
    return JSON.stringify(value === undefined ? null : value);
}

function sha256(text) {
    return crypto.createHash('sha256').update(text).digest('hex');
}

function disabledFile(runDir) {
    return path.join(runDir, 'dom06', 'classifier-disabled.json');
}

function readDisabled(runDir) {
    try {
        return JSON.parse(fs.readFileSync(disabledFile(runDir), 'utf8'));
    } catch (e) {
        if (e && e.code === 'ENOENT') return null;
        return { reason: 'CLASSIFIER_DISABLED_UNREADABLE' };
    }
}

function writeOnce(file, content) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    try {
        fs.writeFileSync(file, content, { flag: 'wx' });
    } catch (e) {
        if (!e || e.code !== 'EEXIST') throw e;
    }
}

/**
 * Regras do §4.8 aplicadas SÓ como registro. Na sonda (G3) a descida é ignorada.
 * @param {{ class: string, probe: string }} hit saída da elegibilidade
 */
function wouldClass(hit, suggested, confidence) {
    const base = hit.class;
    if (!CLASS_RANK[suggested]) return { would_class: base, direction: 'NO_ANSWER' };
    if (suggested === base) return { would_class: base, direction: 'SAME' };
    if (typeof confidence !== 'number') return { would_class: base, direction: 'NO_CONFIDENCE' };
    if (CLASS_RANK[suggested] > CLASS_RANK[base]) {
        return confidence >= UP_MIN ? { would_class: suggested, direction: 'UP' } : { would_class: base, direction: 'LOW_CONFIDENCE' };
    }
    if (hit.probe === 'UPGRADE_PROBE') return { would_class: base, direction: 'DOWN_IGNORED' };
    if (confidence < DOWN_MIN) return { would_class: base, direction: 'LOW_CONFIDENCE' };
    return { would_class: CLASSES[CLASS_RANK[base] - 2], direction: 'DOWN' };
}

function parseDetail(effect) {
    try {
        return JSON.parse(effect && effect.detail);
    } catch {
        return null;
    }
}

function findPrior(runDir, effectId) {
    const prior = dom06.listAttempts(runDir).filter(a => a.node === NODE && a.snapshot && a.snapshot.effect_id === effectId);
    return prior.length ? prior[prior.length - 1] : null;
}

function opinionBase(g) {
    return {
        subtask_key: g.subtask_key ?? null,
        status: null,
        reason: g.eligibility.reason,
        probe: g.eligibility.probe,
        class: g.eligibility.class,
        effect_attempt_id: null,
        class_suggested: null,
        confidence: null,
        risky: null,
        model_reported: null,
        would_class: g.eligibility.class,
        direction: 'NO_ANSWER',
    };
}

function withAnswer(op, hit, answer) {
    const w = wouldClass(hit, answer.class, answer.confidence);
    return {
        ...op,
        class_suggested: answer.class ?? null,
        confidence: answer.confidence ?? null,
        risky: answer.risky ?? null,
        model_reported: answer.model_reported ?? null,
        ...w,
    };
}

const OUTCOME_STATUS = { NOT_SENT: 'NOT_SENT', FAILED: 'FAILED', UNCERTAIN: 'UNCERTAIN' };
const OUTCOME_RESULT = { OK: 'COMPLETE', NOT_SENT: 'FAILED', FAILED: 'FAILED', UNCERTAIN: 'UNCERTAIN' };

/**
 * @param {{ runDir: string, root: string, snapshot: object, taskId: string, visit: string,
 *   groups: { subtask_key?: string, signals?: object, plan_class?: string|null,
 *             envelope?: { step_text: string, ac_texts: string[], declared_paths: string[] } }[],
 *   routedNode?: string, repIndex?: number, maxCalls?: number,
 *   client?: { classify: Function }, credentialProvider?: Function, guard?: object }} input
 * @returns {Promise<{ status: 'ON'|'OFF', reason: string|null, opinions: object[] }>}
 */
async function collectOpinions({
    runDir, root, snapshot, taskId, visit, groups,
    routedNode = 'implement', repIndex = 1, maxCalls = grayZone.MAX_CALLS_PER_VISIT,
    client = jevClient, credentialProvider = jevClient.readKeychainCredential, guard = classifierGuard,
} = {}) {
    const list = Array.isArray(groups) ? groups : [];
    const offAll = reason => ({
        status: 'OFF', reason,
        opinions: list.map(g => ({ subtask_key: (g && g.subtask_key) ?? null, status: 'NOT_CALLED', reason })),
    });
    try {
        const effective = snapshot && snapshot.classifier_effective;
        if (!effective || effective.provider !== 'jev') return offAll((effective && effective.reason) || 'NOT_JEV');
        const disabled = readDisabled(runDir);
        if (disabled) return offAll(disabled.reason || 'CLASSIFIER_DISABLED');
        const still = classifierAuthority.checkStillAuthorized({ root, effective });
        if (!still.ok) return offAll(still.reason);

        const promptSha = jevClient.promptSha256();
        const selected = grayZone.prioritize(list, maxCalls);
        let credential = null;
        let stopped = null;
        const opinions = [];

        for (const g of selected) {
            const op = opinionBase(g);
            if (g.status !== 'SELECTED') { opinions.push({ ...op, status: g.status }); continue; }
            if (stopped) { opinions.push({ ...op, status: 'DISABLED', reason: stopped }); continue; }
            if (!g.envelope) {
                opinions.push({ ...op, status: 'NO_ENVELOPE', reason: g.envelope_reason || 'ENVELOPE_MISSING' });
                continue;
            }
            const envelope = g.envelope && {
                step_text: g.envelope.step_text, ac_texts: g.envelope.ac_texts, declared_paths: g.envelope.declared_paths,
            };
            const checked = guard.checkEnvelope(envelope);
            if (!checked.ok) {
                opinions.push({ ...op, status: 'CONTENT_GUARD_BLOCKED', categories: checked.categories });
                continue;
            }
            const envelopeSha = sha256(canonical(envelope));
            const effectId = sha256(canonical([taskId, routedNode, visit, g.subtask_key ?? null, envelopeSha, promptSha, repIndex]));

            const prior = findPrior(runDir, effectId);
            if (prior) {
                const answer = prior.result === 'COMPLETE' ? parseDetail((prior.effects || []).find(e => e.idempotency_key === effectId)) : null;
                if (answer && answer.outcome === 'OK' && answer.parse === 'OK') {
                    opinions.push({ ...withAnswer(op, g.eligibility, answer), status: 'REUSED', effect_attempt_id: prior.attempt_id });
                } else {
                    opinions.push({ ...op, status: 'NOT_REPEATED', prior_result: prior.result, effect_attempt_id: prior.attempt_id });
                }
                continue;
            }

            writeOnce(path.join(runDir, 'dom06', 'classifier', 'envelopes', `${envelopeSha}.json`), JSON.stringify(envelope));

            if (!credential) {
                credential = await credentialProvider(effective.credential);
                if (!credential || !credential.ok) {
                    credential = null;
                    opinions.push({ ...op, status: 'CREDENTIAL_UNAVAILABLE' });
                    continue;
                }
            }

            const begun = dom06.beginAttempt(runDir, {
                node: NODE,
                admission: {
                    status: 'ADMITTED', owner: 'dom06',
                    snapshot: {
                        task_id: taskId, routed_node: routedNode, visit, subtask_key: g.subtask_key ?? null,
                        probe: g.eligibility.probe, envelope_sha256: envelopeSha, effect_id: effectId, rep_index: repIndex,
                        prompt_sha256: promptSha, model_id: effective.model_id,
                        authority_ref: { id: effective.authority_ref.id, sha256: effective.authority_ref.sha256 },
                        routing_snapshot_sha256: snapshot.sha256 ?? null,
                    },
                },
                obligations: [{ id: OBLIGATION }],
            });
            const attemptFile = begun.attemptFile;
            const attemptId = begun.attempt.attempt_id;
            const auth = dom06.authorizeEffect(dom06.readAttempt(attemptFile), { obligationId: OBLIGATION, idempotencyKey: effectId });
            if (!auth.ok) {
                dom06.closeAttempt(attemptFile, { result: 'FAILED', reason: auth.error });
                opinions.push({ ...op, status: 'NOT_AUTHORIZED', effect_attempt_id: attemptId });
                continue;
            }

            let res;
            try {
                res = await client.classify({ envelope, model: effective.model_id, credential: credential.value, timeoutMs: effective.timeout_ms });
            } catch {
                // Não se sabe se saiu: incerto, nunca repetido.
                dom06.recordEffect(attemptFile, { obligation_id: OBLIGATION, idempotency_key: effectId, status: 'failed', detail: JSON.stringify({ outcome: 'UNCERTAIN', detail: 'CLIENT_ERROR' }) });
                dom06.closeAttempt(attemptFile, { result: 'UNCERTAIN', reason: 'CLIENT_ERROR' });
                opinions.push({ ...op, status: 'ERROR', effect_attempt_id: attemptId });
                continue;
            }
            const outcome = OUTCOME_RESULT[res.outcome] ? res.outcome : 'UNCERTAIN';
            const compact = {
                outcome, parse: res.parse ?? null, class: res.class ?? null, confidence: res.confidence ?? null,
                risky: res.risky ?? null, model_reported: res.model_reported ?? null, latency_ms: res.latency_ms ?? null,
                detail: res.detail ?? null,
            };
            dom06.recordEffect(attemptFile, {
                obligation_id: OBLIGATION, idempotency_key: effectId,
                status: outcome === 'OK' ? 'fulfilled' : 'failed',
                detail: JSON.stringify(compact), http_status: res.http_status ?? null,
            });
            if (res.auth_rejected) {
                dom06.revoke(attemptFile, { reason: `http_${res.http_status}` });
                writeOnce(disabledFile(runDir), JSON.stringify({ reason: 'JEV_AUTH_REJECTED', at: new Date().toISOString(), attempt_id: attemptId }));
                stopped = 'JEV_AUTH_REJECTED';
            }
            dom06.closeAttempt(attemptFile, { result: OUTCOME_RESULT[outcome], reason: compact.detail || compact.parse });

            if (outcome === 'OK' && compact.parse === 'OK') {
                opinions.push({ ...withAnswer(op, g.eligibility, compact), status: 'OK', effect_attempt_id: attemptId });
            } else if (outcome === 'OK') {
                opinions.push({ ...op, status: 'OUT_OF_ENUM', effect_attempt_id: attemptId, model_reported: compact.model_reported });
            } else {
                opinions.push({ ...op, status: OUTCOME_STATUS[outcome], effect_attempt_id: attemptId });
            }
        }
        return { status: 'ON', reason: null, opinions };
    } catch {
        return offAll('CLASSIFIER_INTERNAL_ERROR');
    }
}

module.exports = { collectOpinions, wouldClass, NODE };
