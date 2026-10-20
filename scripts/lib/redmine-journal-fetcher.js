// Recusa QA: busca da nota de recusa nos journals do ticket e troca de status no
// Redmine. Usado pelo botão "Corrigir recusa QA" do dashboard
// (POST /api/runs/:taskId/retry-qa-rejection) e pela detecção de recusa no polling
// do watcher (readmine-watcher.js > syncQaRejection).
//
// Journals: este Redmine responde 404 pra /issues/:id/journals.json (conferido em
// 2026-09-25) — journals só vêm embutidos em /issues/:id.json?include=journals, o
// mesmo endpoint que o fetchQaFeedback do watcher sempre usou.
//
// Segurança: REDMINE_API_KEY só vai no header X-Redmine-API-Key. Nenhum log, erro
// devolvido ou objeto de retorno carrega o valor — mensagens de erro passam por
// scrub() antes de sair daqui, por garantia.
const specValidator = require('./spec-validator');
const { redmineFetch } = require('./redmine-fetch');

// Nome do status no Redmine é "Recusa QA" (id 13, ver STATUS_IDS no watcher); a spec
// da feature fala "Recusada QA" — os dois contam.
const QA_REJECTED_STATUS_ID = 13;
const QA_REJECTED_STATUS_NAMES = ['recusa qa', 'recusada qa'];
// Mesmo id que o /fetch-ticket usa ao mover o ticket (ver .claude/commands/fetch-ticket.md).
const EM_DESENVOLVIMENTO_STATUS_ID = Number(process.env.REDMINE_STATUS_EM_DESENVOLVIMENTO_ID) || 2;
const TIMEOUT_MS = 15000;

function isQaRejectedStatus(name) {
    return typeof name === 'string' && QA_REJECTED_STATUS_NAMES.includes(name.trim().toLowerCase());
}

function config(opts = {}) {
    return {
        url: (opts.redmineUrl ?? process.env.REDMINE_URL ?? '').replace(/\/+$/, ''),
        key: opts.apiKey ?? process.env.REDMINE_API_KEY ?? '',
        fetch: opts.fetch || redmineFetch,
        timeoutMs: opts.timeoutMs || TIMEOUT_MS,
        log: opts.log || console.warn,
    };
}

function scrub(text, key) {
    const s = String(text ?? '');
    return key && key.length >= 4 ? s.split(key).join('[REDACTED]') : s;
}

// Journal que mudou o status pra Recusa QA: o mais recente com detail status_id = 13.
function rejectionJournal(journals) {
    for (let i = journals.length - 1; i >= 0; i--) {
        const details = journals[i].details || [];
        if (details.some(d => d.name === 'status_id' && Number(d.new_value) === QA_REJECTED_STATUS_ID)) return journals[i];
    }
    return null;
}

// Nota da recusa: a do próprio journal que moveu pra Recusa QA; senão a mais recente
// (não vazia) desde a troca de status anterior a ela — o comentário que o QA deixa
// enquanto testa. Nunca volta pra antes disso: sem essa janela, uma 2ª recusa sem
// comentário herdava a nota da 1ª. Ignora comentários do próprio watcher
// ("[Watcher] ..."), que não são feedback do QA. Nunca lança: sem Redmine configurado,
// erro de rede/HTTP ou nenhuma nota => null.
// Retorno: { note, journal_id, created_on, author, rejected_at } — rejected_at é quando
// o ticket foi movido pra Recusa QA (journal com mudança de status_id), senão a data da nota.
async function fetchLastRejectionNote(issueId, opts = {}) {
    const cfg = config(opts);
    if (!cfg.url || !cfg.key || !/^\d+$/.test(String(issueId ?? ''))) return null;
    try {
        const res = await cfg.fetch(`${cfg.url}/issues/${issueId}.json?include=journals`, {
            headers: { 'X-Redmine-API-Key': cfg.key, Accept: 'application/json' },
            signal: AbortSignal.timeout(cfg.timeoutMs),
        });
        if (!res.ok) {
            cfg.log(`[redmine-journal-fetcher] #${issueId}: journals HTTP ${res.status}`);
            return null;
        }
        const data = await res.json();
        const journals = Array.isArray(data?.issue?.journals) ? data.issue.journals : [];
        const rejection = rejectionJournal(journals);
        const isStatusChange = j => (j.details || []).some(d => d.name === 'status_id');
        const noteOf = j => {
            const n = typeof j.notes === 'string' ? j.notes.trim() : '';
            return n && !specValidator.isWatcherNote(n) ? n : '';
        };
        const touchesRejected = j => (j.details || []).some(d => d.name === 'status_id'
            && (Number(d.new_value) === QA_REJECTED_STATUS_ID || Number(d.old_value) === QA_REJECTED_STATUS_ID));
        let from = 0;
        if (rejection) {
            const at = journals.indexOf(rejection);
            const own = noteOf(rejection);
            if (own) {
                return { note: own, journal_id: rejection.id ?? null, created_on: rejection.created_on || null, author: rejection.user?.name || null, rejected_at: rejection.created_on || null };
            }
            // QA devolveu direto pra Em Desenvolvimento comentando, e alguém levou o
            // ticket pra Recusa QA depois, em saltos sem nota (#43819: 8→2 com a nota,
            // depois 2→8→19→13). Volta pelos saltos até o primeiro journal com nota; se
            // for essa devolução, a nota é a da recusa. Para em qualquer entrada/saída de
            // Recusa QA, pra não herdar a nota de uma recusa anterior.
            for (let i = at - 1; i >= 0 && !touchesRejected(journals[i]); i--) {
                const j = journals[i];
                const note = noteOf(j);
                if (!note) continue;
                const bounced = (j.details || []).some(d => d.name === 'status_id' && Number(d.new_value) === EM_DESENVOLVIMENTO_STATUS_ID);
                if (bounced) return { note, journal_id: j.id ?? null, created_on: j.created_on || null, author: j.user?.name || null, rejected_at: j.created_on || null };
                break;
            }
            for (let i = at - 1; i >= 0; i--) if (isStatusChange(journals[i])) { from = i + 1; break; }
        }
        for (let i = journals.length - 1; i >= from; i--) {
            const j = journals[i];
            const note = typeof j.notes === 'string' ? j.notes.trim() : '';
            if (!note || specValidator.isWatcherNote(note)) continue;
            return {
                note,
                journal_id: j.id ?? null,
                created_on: j.created_on || null,
                author: j.user?.name || null,
                rejected_at: rejection?.created_on || j.created_on || null,
            };
        }
        return null;
    } catch (e) {
        cfg.log(`[redmine-journal-fetcher] #${issueId}: falha buscando journals (${scrub(e?.name === 'TimeoutError' ? 'timeout' : e?.message, cfg.key)})`);
        return null;
    }
}

// PUT /issues/:id.json { issue: { status_id } } e relê o ticket: o Redmine responde 204
// mesmo quando o workflow não permite a transição e ignora o status_id (mesma armadilha
// dos custom_fields). Nunca lança. Retorno: { ok: true, status } | { ok: false, error }.
async function setIssueStatus(issueId, statusId, opts = {}) {
    const cfg = config(opts);
    if (!cfg.url || !cfg.key) return { ok: false, error: 'Redmine não configurado (REDMINE_URL/REDMINE_API_KEY)' };
    if (!/^\d+$/.test(String(issueId ?? ''))) return { ok: false, error: 'ticket inválido' };
    try {
        const res = await cfg.fetch(`${cfg.url}/issues/${issueId}.json`, {
            method: 'PUT',
            headers: { 'X-Redmine-API-Key': cfg.key, 'Content-Type': 'application/json' },
            body: JSON.stringify({ issue: { status_id: statusId } }),
            signal: AbortSignal.timeout(cfg.timeoutMs),
        });
        if (!res.ok) return { ok: false, error: `Redmine HTTP ${res.status}` };
        const check = await cfg.fetch(`${cfg.url}/issues/${issueId}.json`, {
            headers: { 'X-Redmine-API-Key': cfg.key, Accept: 'application/json' },
            signal: AbortSignal.timeout(cfg.timeoutMs),
        });
        if (!check.ok) return { ok: false, error: `Redmine HTTP ${check.status} relendo o ticket` };
        const status = (await check.json())?.issue?.status || null;
        if (Number(status?.id) !== Number(statusId)) {
            return { ok: false, error: `Redmine não aplicou a troca de status (ticket segue em "${status?.name || '?'}" — transição não permitida no workflow?)` };
        }
        return { ok: true, status };
    } catch (e) {
        return { ok: false, error: scrub(e?.name === 'TimeoutError' ? 'timeout falando com o Redmine' : e?.message, cfg.key) };
    }
}

// Bloco anexado ao context.md pelo retry (append, nunca reescreve o que já existe).
function contextBlock(note, at = new Date().toISOString()) {
    const quoted = (note && note.trim() ? note.trim() : '(sem nota registrada)')
        .split(/\r?\n/).map(l => (l ? `> ${l}` : '>')).join('\n');
    return `\n\n## Recusa QA — Correção Solicitada (${at})\n\n` +
        'O time de QA recusou a entrega com a seguinte nota:\n\n' +
        `${quoted}\n\n` +
        '---\n' +
        '**Instrução para este retry**: corrija os pontos levantados\n' +
        'acima aproveitando todo o contexto do ciclo anterior.\n';
}

module.exports = {
    fetchLastRejectionNote, setIssueStatus, contextBlock, isQaRejectedStatus,
    QA_REJECTED_STATUS_ID, EM_DESENVOLVIMENTO_STATUS_ID,
};
