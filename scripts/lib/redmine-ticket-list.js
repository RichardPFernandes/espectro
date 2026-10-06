// Lista os tickets abertos atribuídos ao usuário da API key configurada, pra exibir
// na aba "Redmine" do dashboard (GET /api/tickets[/mine], dashboard/server.js). Mais
// abaixo: detalhe com journals e escrita (status/nota) da mesma aba.
//
// NÃO é o mesmo `fetchAssignedTickets` de scripts/readmine-watcher.js: aquele filtra
// status_id pelas duas únicas situações em que o watcher despacha um agente
// (Aprovada|Recusa QA — ver STATUS_IDS lá) porque serve só pro tick decidir o que
// começar. Este aqui é `status_id=open` (qualquer status aberto do Redmine), porque
// serve pra exibição — o usuário quer ver TUDO que está com ele, não só o que já
// está pronto pra disparar. Os dois módulos não devem ser unificados sem revisitar
// esse filtro.
//
// Segurança: REDMINE_API_KEY só vai no header X-Redmine-API-Key. Nenhum log, erro
// devolvido ou objeto de retorno carrega o valor.
const TIMEOUT_MS = 15000;

function config(opts = {}) {
    return {
        url: (opts.redmineUrl ?? process.env.REDMINE_URL ?? '').replace(/\/+$/, ''),
        key: opts.apiKey ?? process.env.REDMINE_API_KEY ?? '',
        fetch: opts.fetch || globalThis.fetch,
        timeoutMs: opts.timeoutMs || TIMEOUT_MS,
        log: opts.log || console.warn,
    };
}

function scrub(text, key) {
    const s = String(text ?? '');
    return key && key.length >= 4 ? s.split(key).join('[REDACTED]') : s;
}

// Tickets abertos (qualquer status não-fechado) atribuídos ao dono da API key.
// Nunca lança: sem Redmine configurado, erro de rede ou resposta HTTP não-ok
// devolvem [] (log de aviso, sem o valor da key).
async function fetchAssignedTickets(opts = {}) {
    const cfg = config(opts);
    if (!cfg.url || !cfg.key) return [];
    try {
        const res = await cfg.fetch(
            `${cfg.url}/issues.json?assigned_to_id=me&status_id=open&sort=updated_on:desc`,
            {
                headers: { 'X-Redmine-API-Key': cfg.key, Accept: 'application/json' },
                signal: AbortSignal.timeout(cfg.timeoutMs),
            }
        );
        if (!res.ok) {
            cfg.log(`[redmine-ticket-list] HTTP ${res.status} buscando tickets atribuídos`);
            return [];
        }
        const data = await res.json();
        const issues = Array.isArray(data?.issues) ? data.issues : [];
        return issues.map(i => ({
            id: i.id,
            subject: i.subject || '',
            status: i.status?.name || '',
            priority: i.priority?.name || '',
            updated_on: i.updated_on || null,
        }));
    } catch (e) {
        cfg.log(`[redmine-ticket-list] falha buscando tickets atribuídos (${scrub(e?.name === 'TimeoutError' ? 'timeout' : e?.message, cfg.key)})`);
        return [];
    }
}

// ---------------------------------------------------------------------------
// Aba "Redmine" do dashboard: detalhe do ticket (journals), status disponíveis e
// escrita direta (mudar status / adicionar nota). Diferente de fetchAssignedTickets,
// estas LANÇAM em caso de erro — o endpoint precisa distinguir 404/422/503 pra
// devolver a mensagem certa. O erro lançado tem `.status` (HTTP do Redmine, ou 503
// sem Redmine configurado) e mensagem já sem a key (scrub).

function fail(status, message) {
    const err = new Error(message);
    err.status = status;
    return err;
}

async function request(cfg, method, pathAndQuery, body) {
    if (!cfg.url || !cfg.key) throw fail(503, 'Redmine não configurado (REDMINE_URL/REDMINE_API_KEY)');
    const headers = { 'X-Redmine-API-Key': cfg.key, Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    let res;
    try {
        res = await cfg.fetch(`${cfg.url}${pathAndQuery}`, {
            method, headers,
            body: body === undefined ? undefined : JSON.stringify(body),
            signal: AbortSignal.timeout(cfg.timeoutMs),
        });
    } catch (e) {
        throw fail(502, e?.name === 'TimeoutError' ? 'tempo esgotado falando com o Redmine' : `falha de rede: ${scrub(e?.message, cfg.key)}`);
    }
    if (!res.ok) {
        // 422 do Redmine traz { errors: ["Status is invalid", ...] } — útil pro usuário
        // (transição de status não permitida pelo workflow).
        let detail = '';
        try { const data = await res.json(); if (Array.isArray(data?.errors)) detail = `: ${data.errors.join('; ')}`; } catch { /* sem corpo */ }
        throw fail(res.status, scrub(`Redmine HTTP ${res.status}${detail}`, cfg.key));
    }
    // PUT devolve 204 (ou 200 vazio em versões antigas): sem JSON pra ler.
    if (res.status === 204 || method !== 'GET') return null;
    return res.json();
}

// Status do Redmine (id -> nome/is_closed), cache de 10 min por URL: muda raramente e
// é consultado a cada detalhe aberto (tradução de status_id nos journals).
const STATUS_TTL_MS = 10 * 60 * 1000;
const statusCache = new Map(); // url -> { at, value }
async function listIssueStatuses(opts = {}) {
    const cfg = config(opts);
    const hit = statusCache.get(cfg.url);
    if (!opts.noCache && hit && Date.now() - hit.at < STATUS_TTL_MS) return hit.value;
    const data = await request(cfg, 'GET', '/issue_statuses.json');
    const value = (Array.isArray(data?.issue_statuses) ? data.issue_statuses : [])
        .map(s => ({ id: s.id, name: s.name || '', is_closed: s.is_closed === true }));
    statusCache.set(cfg.url, { at: Date.now(), value });
    return value;
}

// Prioridades (id -> nome), mesmo cache. Falha aqui não derruba o detalhe.
const priorityCache = new Map();
async function listIssuePriorities(opts = {}) {
    const cfg = config(opts);
    const hit = priorityCache.get(cfg.url);
    if (!opts.noCache && hit && Date.now() - hit.at < STATUS_TTL_MS) return hit.value;
    const data = await request(cfg, 'GET', '/enumerations/issue_priorities.json');
    const value = (Array.isArray(data?.issue_priorities) ? data.issue_priorities : []).map(p => ({ id: p.id, name: p.name || '' }));
    priorityCache.set(cfg.url, { at: Date.now(), value });
    return value;
}

function assertIssueId(issueId) {
    const s = String(issueId ?? '');
    if (!/^\d+$/.test(s)) throw fail(400, 'id de ticket inválido');
    return s;
}

// Detalhe do ticket com journals. Cada detail de journal ganha old_label/new_label
// quando o campo é status_id/priority_id (o Redmine só manda os ids), pra UI mostrar
// "Status: Em Desenvolvimento → Aguardando QA" sem outra chamada.
async function getTicketDetail(issueId, opts = {}) {
    const cfg = config(opts);
    const id = assertIssueId(issueId);
    const data = await request(cfg, 'GET', `/issues/${id}.json?include=journals,changesets,watchers,allowed_statuses`);
    const i = data?.issue;
    if (!i) throw fail(502, 'resposta do Redmine sem issue');
    const [statuses, priorities] = await Promise.all([
        listIssueStatuses(opts).catch(() => []),
        listIssuePriorities(opts).catch(() => []),
    ]);
    const names = { status_id: new Map(statuses.map(s => [String(s.id), s.name])), priority_id: new Map(priorities.map(p => [String(p.id), p.name])) };
    const label = (name, v) => (v == null ? null : names[name]?.get(String(v)) ?? null);
    const journals = (Array.isArray(i.journals) ? i.journals : []).map(j => ({
        id: j.id,
        user: j.user?.name || '',
        notes: j.notes || '',
        created_on: j.created_on || null,
        private_notes: j.private_notes === true,
        details: (Array.isArray(j.details) ? j.details : []).map(d => ({
            property: d.property || '',
            name: d.name || '',
            old_value: d.old_value ?? null,
            new_value: d.new_value ?? null,
            old_label: label(d.name, d.old_value),
            new_label: label(d.name, d.new_value),
        })),
    }));
    return {
        id: i.id,
        subject: i.subject || '',
        description: i.description || '',
        status: i.status?.name || '',
        status_id: i.status?.id ?? null,
        priority: i.priority?.name || '',
        assignee: i.assigned_to?.name || null,
        tracker: i.tracker?.name || null,
        project: i.project?.name || null,
        author: i.author?.name || null,
        created_on: i.created_on || null,
        updated_on: i.updated_on || null,
        // Transições permitidas pelo workflow pra este usuário (Redmine 5+); null = versão
        // antiga sem allowed_statuses — a UI cai na lista global de /issue_statuses.
        allowed_statuses: Array.isArray(i.allowed_statuses) ? i.allowed_statuses.map(s => ({ id: s.id, name: s.name || '' })) : null,
        journals,
    };
}

function cleanNote(note) {
    if (note == null) return '';
    if (typeof note !== 'string') throw fail(400, 'nota deve ser texto');
    if (note.length > 20000) throw fail(400, 'nota longa demais (máx. 20000 caracteres)');
    return note.trim();
}

async function updateTicketStatus(issueId, statusId, note, opts = {}) {
    const cfg = config(opts);
    const id = assertIssueId(issueId);
    if (!/^\d+$/.test(String(statusId ?? ''))) throw fail(400, 'statusId inválido');
    const notes = cleanNote(note);
    const issue = { status_id: Number(statusId) };
    if (notes) issue.notes = notes;
    await request(cfg, 'PUT', `/issues/${id}.json`, { issue });
    return { ok: true };
}

async function addJournalNote(issueId, note, opts = {}) {
    const cfg = config(opts);
    const id = assertIssueId(issueId);
    const notes = cleanNote(note);
    if (!notes) throw fail(400, 'nota vazia');
    await request(cfg, 'PUT', `/issues/${id}.json`, { issue: { notes } });
    return { ok: true };
}

module.exports = { fetchAssignedTickets, getTicketDetail, updateTicketStatus, addJournalNote, listIssueStatuses };
