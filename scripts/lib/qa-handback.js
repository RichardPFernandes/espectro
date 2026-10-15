// Desfecho "devolver ao QA sem código" (handback_qa, PRI-180). Para run parado em
// blocked/authorization-pending cujo problema foi resolvido fora do código (ex.: SQL
// aplicado no banco do QA): nenhum agente é despachado.
//
//   1. Efeito Redmine governado (Attempt DOM06 node "handback_qa", redmineEffect com
//      X-Redmine-API-Key): status → Ag Teste (REDMINE_STATUS_AG_TESTE, padrão 8), notes
//      com o resumo e o campo "Apontamentos Desenvolvedor" (REDMINE_CF_APONTAMENTOS_ID,
//      padrão 2). 422 → erro dizendo o campo exigido.
//   2. Só com o Redmine confirmado: arquiva o run em <raiz do run>/_archive/<task-id>
//      (stateWriter.archive, com o lock até o rename) com status "handed_back_qa".
//      NÃO entra no registro dashboard-archived.json: como o arquivamento do /commit, o
//      run continua visível como "arquivado com demanda aberta" e uma nova Recusa QA
//      cai no fluxo normal ("Corrigir recusa QA" → retry-signal → watcher restaura).
//   3. Falha no Redmine: NÃO arquiva; run fica blocked com o erro.
//
// Resultado incerto (rede/5xx no PUT): antes de repetir, os journals do ticket são
// conferidos pelo marcador "[op handback:<id>]" — achou, conta como feito (não reposta).

const fs = require('fs');
const path = require('path');
const dom06 = require('./dom06-attempt');
const stateWriter = require('../state-writer');

const DEFAULT_STATUS_AG_TESTE = 8;
const DEFAULT_CF_APONTAMENTOS = 2;
const MAX_APONTAMENTOS = 8000;
const HANDED_BACK_STATUS = 'handed_back_qa';

function config(env = process.env) {
    const num = (v, d) => (/^\d+$/.test(String(v ?? '').trim()) ? Number(String(v).trim()) : d);
    return {
        url: String(env.REDMINE_URL || '').replace(/\/+$/, ''),
        statusId: num(env.REDMINE_STATUS_AG_TESTE, DEFAULT_STATUS_AG_TESTE),
        cfApontamentos: num(env.REDMINE_CF_APONTAMENTOS_ID, DEFAULT_CF_APONTAMENTOS),
    };
}

function ticketIdOf(taskId, state) {
    const fromTaskId = /^\d{4}-\d{2}-\d{2}-/.test(taskId) ? null : (String(taskId).match(/^(\d{4,6})-/) || [])[1];
    const id = state?.ticket_id ?? state?.issue_id ?? state?.redmine_ticket?.id ?? fromTaskId;
    return /^\d+$/.test(String(id ?? '')) ? Number(id) : null;
}

function marker(operationId) {
    return `[op handback:${operationId}]`;
}

// Última autorização concluída (ou a do contexto), para citar alvo/hora do SQL.
function lastAuthorization(state, explicit) {
    if (explicit) return explicit;
    const hist = Array.isArray(state?.authorization_history) ? state.authorization_history : [];
    const done = [...hist].reverse().find(e => e.event === 'applied' || e.event === 'manual_confirmed');
    if (!done) return null;
    const decided = [...hist].reverse().find(e => e.id === done.id && (e.event === 'approved' || e.event === 'manual_applied'));
    const requested = hist.find(e => e.id === done.id && e.event === 'requested');
    return { id: done.id, target: { alias: done.target || requested?.target || null }, last_result: done, approved_by: decided?.event === 'approved' ? decided.by : null, manual_by: decided?.event === 'manual_applied' ? decided.by : null, decided_at: decided?.at || null };
}

function handoffBody(runDir) {
    try {
        return fs.readFileSync(path.join(runDir, 'handoff.md'), 'utf8')
            .replace(/<!--[\s\S]*?-->/g, '').replace(/^# .*\n/, '').trim();
    } catch { return ''; }
}

function sqlLine(auth) {
    if (!auth) return null;
    const alias = auth.target?.alias || auth.last_result?.target || '?';
    const when = auth.approved_at || auth.manual_at || auth.decided_at || auth.last_result?.at || null;
    if (auth.manual_by || auth.last_result?.event === 'manual_confirmed') {
        return `SQL ${auth.artifact ? `\`${auth.artifact}\` ` : ''}aplicado manualmente por ${auth.manual_by || 'humano'} no alvo "${alias}"${when ? ` (${when})` : ''}.`;
    }
    return `SQL ${auth.artifact ? `\`${auth.artifact}\` ` : ''}aplicado pelo Prisma no alvo "${alias}"${when ? ` em ${when}` : ''}, em transação única, após aprovação de ${auth.approved_by || 'humano'} no dashboard.`;
}

/** Textos sugeridos (o dashboard mostra e deixa editar antes de confirmar). */
function preview(runDir, { authorization = null } = {}) {
    const state = stateWriter.read(runDir) || {};
    const taskId = state.task_id || path.basename(runDir);
    const auth = lastAuthorization(state, authorization || state.pending_authorization);
    const what = auth?.summary || state.blocked_reason || 'Correção resolvida fora do código.';
    const verify = auth?.expected ? `Verificação: ${auth.expected}${auth.last_result?.verify_matched === true ? ' — conferida.' : '.'}` : null;
    const notes = [
        `[Prisma] Devolvido ao QA sem nova mudança de código (task ${taskId}).`,
        '',
        `O que foi feito: ${what}`,
        sqlLine(auth),
        verify,
        '',
        'Pode testar novamente. Se o problema persistir, devolva como Recusa QA com a evidência.',
    ].filter(l => l !== null).join('\n');
    const body = handoffBody(runDir);
    const apontamentos = [
        `Resumo: ${what}`,
        sqlLine(auth),
        verify,
        'Não houve mudança de código nesta rodada.',
        body ? `\n${body}` : null,
    ].filter(Boolean).join('\n').slice(0, MAX_APONTAMENTOS);
    return { notes, apontamentos, ticketId: ticketIdOf(taskId, state), taskId };
}

// Corpo de um 422: {"errors": ["Apontamentos Desenvolvedor não pode ficar vazio", ...]}.
function explain422(text) {
    let errors = [];
    try { errors = JSON.parse(text || '{}').errors || []; } catch { /* corpo não-JSON */ }
    const list = Array.isArray(errors) ? errors.map(String) : [];
    return `Redmine recusou a transição (422)${list.length ? `: ${list.join('; ')}` : ''} — preencha o campo exigido no ticket (ou ajuste o texto) e tente "Devolver ao QA" de novo.`;
}

async function alreadyDone({ cfg, ticketId, operationId, env, fetchImpl }) {
    try {
        const f = fetchImpl || ((...a) => globalThis.fetch(...a));
        const res = await f(`${cfg.url}/issues/${ticketId}.json?include=journals`, {
            headers: { 'X-Redmine-API-Key': String(env.REDMINE_API_KEY || ''), Accept: 'application/json' },
            signal: AbortSignal.timeout(10000),
        });
        if (!res.ok) return { known: false };
        const issue = (await res.json())?.issue;
        const found = (issue?.journals || []).some(j => String(j.notes || '').includes(marker(operationId)));
        return { known: true, found, statusId: issue?.status?.id ?? null };
    } catch {
        return { known: false };
    }
}

/**
 * Devolve ao QA e arquiva. Sem CAS aqui: quem chama (endpoint do dashboard, ou a
 * aprovação com then=handback_qa) já decidiu sob CAS.
 * @returns {Promise<{ ok, archived?, to?, error?, http_status?, attempt_id? }>}
 */
async function handback(runDir, { by, operationId, notes = null, apontamentos = null, authorization = null, env = process.env, fetchImpl = null, now = () => new Date().toISOString(), onArchived = null } = {}) {
    const cfg = config(env);
    const state = stateWriter.read(runDir);
    if (!state) return { ok: false, error: 'state.json ausente ou ilegível' };
    const suggested = preview(runDir, { authorization });
    const ticketId = suggested.ticketId;
    const taskId = suggested.taskId;
    const fail = (error, extra = {}) => {
        const at = now();
        stateWriter.update(runDir, s => {
            s.status = 'blocked';
            s.blocked_reason = `Devolução ao QA falhou: ${error}`;
            s.handback_qa_error = { at, error, ...(extra.http_status ? { http_status: extra.http_status } : {}) };
            if (s.pending_authorization?.phase === 'handback') s.pending_authorization.phase = 'handback_failed';
            s.updated_at = at;
            s.events = [...(Array.isArray(s.events) ? s.events : []), { ts: at, type: 'qa_handback_failed', agent: 'prisma', detail: error, at }];
        }, { operation: 'qa_handback_failed', actor: 'dashboard' });
        return { ok: false, error, ...extra };
    };
    if (!ticketId) return fail('run sem ticket do Redmine');
    if (!cfg.url || !String(env.REDMINE_API_KEY || '').trim()) return fail('Redmine não configurado (REDMINE_URL/REDMINE_API_KEY)');

    const notesText = `${(notes && notes.trim()) || suggested.notes}\n\n${marker(operationId)}`;
    const apontText = ((apontamentos && apontamentos.trim()) || suggested.apontamentos).slice(0, MAX_APONTAMENTOS);
    const body = JSON.stringify({ issue: { status_id: cfg.statusId, notes: notesText, custom_fields: [{ id: cfg.cfApontamentos, value: apontText }] } });

    const decision = dom06.beginAttempt(runDir, {
        node: 'handback_qa',
        admission: { status: 'ADMITTED', owner: 'dom06', snapshot: { task_id: taskId, ticket_id: ticketId, operation_id: operationId, status_id: cfg.statusId } },
        obligations: [{ id: 'redmine_status' }],
    });
    const attemptFile = decision.attemptFile;

    // Conferência antes do PUT (cobre a retomada de um PUT incerto).
    const check = await alreadyDone({ cfg, ticketId, operationId, env, fetchImpl });
    let httpStatus = null;
    if (check.known && check.found) {
        dom06.recordEffect(attemptFile, { obligation_id: 'redmine_status', idempotency_key: `handback:${operationId}`, status: 'fulfilled', detail: 'marcador já presente no ticket — não repostado' });
    } else {
        const res = await dom06.redmineEffect(attemptFile, {
            url: `${cfg.url}/issues/${ticketId}.json`, method: 'PUT', body,
            obligationId: 'redmine_status', idempotencyKey: `handback:${operationId}`, env, fetchImpl,
        });
        httpStatus = res.status ?? null;
        if (!res.ok && !res.duplicate) {
            dom06.closeAttempt(attemptFile, { result: 'FAILED', reason: res.error });
            if (res.error === 'REDMINE_API_KEY_MISSING') return fail('REDMINE_API_KEY ausente no ambiente do dashboard');
            if (res.status === 422) return fail(explain422(res.body), { http_status: 422, attempt_id: decision.attempt.attempt_id });
            if (res.error === 'AUTHORITY_REVOKED') return fail(`Redmine recusou a chave (HTTP ${res.status}) — confira REDMINE_API_KEY`, { http_status: res.status });
            return fail(`Redmine não confirmou a devolução${res.status ? ` (HTTP ${res.status})` : ''} — confira o ticket antes de tentar de novo`, { http_status: res.status ?? null });
        }
    }
    dom06.closeAttempt(attemptFile, { result: 'COMPLETE' });

    const at = now();
    const archiveDir = path.join(path.dirname(runDir), '_archive');
    let target = path.join(archiveDir, taskId);
    if (fs.existsSync(target)) target = path.join(archiveDir, `${taskId}-${at.replace(/[:.]/g, '-')}`);
    const auth = lastAuthorization(state, authorization || state.pending_authorization);
    const out = stateWriter.archive(runDir, target, {
        operation: 'qa_handback_archive', actor: 'dashboard',
        mutator: d => {
            if (d.pending_authorization) {
                d.authorization_history = [...(d.authorization_history || []), { id: d.pending_authorization.id, event: d.pending_authorization.phase === 'handback' ? 'handed_back' : 'superseded_by_handback', by, via: 'dashboard', at }];
                delete d.pending_authorization;
            }
            delete d.blocked_reason;
            delete d.handback_qa_error;
            d.status = HANDED_BACK_STATUS;
            d.ticket_status = 'Ag Teste';
            d.handed_back_qa = {
                at, by, operation_id: operationId, redmine_status_id: cfg.statusId, attempt_id: decision.attempt.attempt_id,
                authorization_id: auth?.id || null, ...(httpStatus ? { http_status: httpStatus } : {}),
            };
            d.processed_operations = [...(Array.isArray(d.processed_operations) ? d.processed_operations : []).filter(o => o?.operation_id !== operationId),
                { operation_id: operationId, type: 'QA_HANDBACK', processed_at: at }];
            if (Array.isArray(d.pending_operations)) {
                d.pending_operations = d.pending_operations.filter(o => o?.operation_id !== operationId);
                if (!d.pending_operations.length) delete d.pending_operations;
            }
            d.events = [...(Array.isArray(d.events) ? d.events : []), { ts: at, type: 'qa_handback', agent: 'prisma', detail: `ticket #${ticketId} → Ag Teste (status ${cfg.statusId}); run arquivado`, at }];
            d.updated_at = at;
        },
    });
    if (typeof onArchived === 'function') onArchived(out);
    return { ok: true, archived: true, to: out.to, ticketId, attempt_id: decision.attempt.attempt_id };
}

module.exports = { HANDED_BACK_STATUS, DEFAULT_STATUS_AG_TESTE, DEFAULT_CF_APONTAMENTOS, config, preview, handback, explain422, marker, ticketIdOf };
