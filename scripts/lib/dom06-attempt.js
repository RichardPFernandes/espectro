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

function obligationsFor(node) {
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

function beginAttempt(runDir, { node, admission, obligations, cause = 'dispatch', rebindRefused = null } = {}) {
    const gate = classifyAdmission(admission);
    const attempt = blankAttempt({ node, cause, result: gate.result });
    attempt.rebind_refused = rebindRefused;
    if (!gate.dispatch) {
        const attemptFile = persist(runDir, attempt);
        return { dispatch: false, reason: gate.reason, attempt, attemptFile, spawned: false };
    }
    attempt.started = true;
    attempt.result = 'STARTED';
    attempt.owner = admission.owner;
    attempt.snapshot = structuredClone(admission.snapshot);
    attempt.obligations = normalizeObligations(obligations ?? admission.obligations);
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

function latestBound(runDir, node) {
    const found = listAttempts(runDir).filter(item => item.node === node && item.started && item.owner && item.snapshot);
    return found.length ? found[found.length - 1] : null;
}

function readAttempt(attemptFile) {
    return readJson(attemptFile);
}

function retryAttempt(runDir, { node, cause, proposed } = {}) {
    const previous = latestBound(runDir, node);
    if (!previous || previous.authority === 'revoked' || !Array.isArray(previous.obligations)) {
        const reason = previous?.authority === 'revoked' ? 'AUTHORITY_REVOKED' : 'ADMISSION_UNKNOWN';
        return beginAttempt(runDir, {
            node,
            cause,
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

function prepareDispatch({ runDir, node, ticketId, baseBranch = null, specHash = null, cause = 'dispatch', state = null } = {}) {
    const resolvedCause = state ? causeFromState(state) : cause;
    const hold = readHold(runDir);
    if (hold && hold.status !== 'ADMITTED') {
        return beginAttempt(runDir, {
            node,
            cause: resolvedCause,
            admission: { status: hold.status === 'DENIED' ? 'DENIED' : 'UNKNOWN' },
        });
    }
    const snapshot = {
        ticket_id: ticketId,
        node,
        base_branch: baseBranch,
        spec_hash: specHash,
    };
    const needsIdentity = snapshot.ticket_id == null || snapshot.ticket_id === '' || !snapshot.node || !snapshot.base_branch;
    const proposed = needsIdentity
        ? { status: 'UNKNOWN', owner: null, snapshot }
        : { status: 'ADMITTED', owner: 'dom06', snapshot };
    if (RETRY_CAUSES.has(resolvedCause)) {
        const previous = latestBound(runDir, node);
        if (previous) return retryAttempt(runDir, { node, cause: resolvedCause, proposed });
    }
    return beginAttempt(runDir, {
        node,
        cause: resolvedCause,
        admission: proposed.status === 'ADMITTED' ? proposed : { status: 'UNKNOWN' },
        obligations: proposed.status === 'ADMITTED' ? obligationsFor(node) : null,
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
        const result = attempt?.result === 'DENIED' ? 'DENIED' : 'UNKNOWN';
        return { ...summary, result, verdict: result };
    }
    if (!obligations) return summary;
    const pending = obligations.filter(item => item.status !== 'fulfilled');
    if (pending.length === 0 && attempt.authority === 'valid') {
        return { ...summary, pending, pending_count: 0, pass: true, result: 'COMPLETE', verdict: 'PASS' };
    }
    return { ...summary, pending, pending_count: pending.length, result: 'INCOMPLETE', verdict: 'INCOMPLETE' };
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
        const key = idempotencyKey || crypto.createHash('sha256').update(`${method}\n${url}\n${body}`).digest('hex');
        // A chave vai no header, como em todo outro call site do Redmine (watcher,
        // dashboard). Sem ela o Redmine responde 401 e applyExternalEffect revoga o
        // Attempt — foi o que travou o "Ag Merge" de todos os /commit desde o PRI-66.
        // Chave ausente é erro de configuração, não autoridade revogada: sai antes do
        // efeito, sem gravar falha nem revogar.
        const apiKey = String(process.env.REDMINE_API_KEY || '').trim();
        if (!apiKey) {
            process.stderr.write('ERROR: REDMINE_API_KEY ausente no ambiente — Redmine não foi chamado.\n');
            process.exit(1);
        }
        const { createRedmineFetch } = require('./redmine-fetch');
        const redmineFetch = createRedmineFetch({ env: process.env });
        const result = await applyExternalEffect(attemptFile, {
            obligationId: obligationId || 'redmine_notes',
            idempotencyKey: key,
            perform: async () => {
                const response = await redmineFetch(url, { method, body, headers: { 'X-Redmine-API-Key': apiKey, 'Content-Type': 'application/json' } });
                const text = await response.text();
                return { status: response.status, ok: response.ok, detail: text.slice(0, 500) };
            },
        });
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
    beginAttempt, retryAttempt, prepareDispatch, causeFromState, spawnIfAdmitted,
    readAttempt, recordEffect, revoke, authorizeEffect, applyExternalEffect, summarize,
    fulfillOnExit, obligationsFor, listAttempts,
};

if (require.main === module) {
    main(process.argv.slice(2)).catch(err => {
        process.stderr.write(`ERROR: ${err.message}\n`);
        process.exit(1);
    });
}
