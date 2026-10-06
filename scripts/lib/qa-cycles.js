// Recusas QA separadas do ciclo principal — o dashboard mostra, por recusa, a nota do
// QA, quando o retry começou, os passos que o agente rodou naquele retry, duração,
// custo e PRs, sem misturar com o ciclo original do ticket.
//
// Fonte: state.qa_rejections[], uma entrada por recusa. O watcher cria a entrada ao
// detectar a recusa (recordRejection, sem retry_requested_at = pendente) e o POST
// /api/runs/:taskId/retry-qa-rejection do dashboard completa ESSA entrada com o início
// do retry e o custo acumulado (appendRejection) — nenhuma recusa sobrescreve a outra.
// Runs de antes desse campo são reconstruídos dos blocos "## Recusa QA — Correção
// Solicitada (<at>)" que o endpoint anexa no context.md (contextBlock em
// redmine-journal-fetcher.js) e, quando a sumarização do context.md apagou o bloco, do
// implement "Retry Recusa QA" no agent_log (qa_retry_count diz quantos faltam) — nesses
// casos o custo por recusa fica null (cost_tracking é cumulativo).
//
// Os passos de cada ciclo saem do agent_log por horário: [início do retry, início do
// próximo retry). Tudo antes do primeiro retry é o ciclo principal.

const qaJournal = require('./redmine-journal-fetcher');

const SAME_RETRY_MS = 5 * 60 * 1000; // bloco do context.md × qa_rejection.retry_requested_at
const HEAD_RE = /^## Recusa QA — Correção Solicitada \(([^)]+)\)[ \t]*$/gm;

// Blocos de recusa do context.md, na ordem em que aparecem: [{ at, note }].
function parseContextRejections(md) {
    if (typeof md !== 'string' || !md) return [];
    const heads = [...md.matchAll(HEAD_RE)];
    return heads.map((h, i) => {
        const body = md.slice(h.index + h[0].length, i + 1 < heads.length ? heads[i + 1].index : md.length);
        const quoted = [];
        for (const line of body.split(/\r?\n/)) {
            if (/^>/.test(line)) quoted.push(line.replace(/^> ?/, ''));
            else if (quoted.length && /^(---|## )/.test(line)) break;
        }
        const note = quoted.join('\n').trim();
        return { at: h[1].trim(), note: !note || note === '(sem nota registrada)' ? null : note };
    });
}

const time = iso => { const t = Date.parse(iso); return Number.isFinite(t) ? t : null; };

function costTotals(state) {
    const t = state?.cost_tracking?.totals;
    if (!t) return { usd: null, tokens: null };
    const tokens = t.input_tokens == null && t.output_tokens == null ? null : (t.input_tokens || 0) + (t.output_tokens || 0);
    return { usd: typeof t.cost_usd === 'number' ? t.cost_usd : null, tokens };
}

// Entradas de recusa já iniciadas (com retry pedido). state.qa_rejections tem
// precedência; senão reconstrói do context.md, completando com o que state.qa_rejection
// guardou (journal/data da recusa) SÓ o bloco do mesmo retry. Retries que sumiram dos
// dois (qa_retry_count maior) vêm do agent_log.
function rejectionEntries(state, contextMd) {
    const entries = Array.isArray(state?.qa_rejections) && state.qa_rejections.length
        ? state.qa_rejections.filter(e => e && time(e.retry_requested_at) != null)
        : legacyEntries(state, contextMd);
    return withLostRetries(state, entries).map((e, i) => ({ ...e, n: i + 1 }));
}

function legacyEntries(state, contextMd) {
    const blocks = parseContextRejections(contextMd).filter(b => time(b.at) != null);
    // qa_rejection.retry_requested_at é gravado junto com o bloco (mesmo endpoint, mesmo
    // instante); sumarização do context.md pode ter apagado o bloco — aí vira entrada só.
    const last = state?.qa_rejection || {};
    const lastAt = time(last.retry_requested_at);
    const owner = lastAt == null ? -1 : blocks.findIndex(b => Math.abs(time(b.at) - lastAt) < SAME_RETRY_MS);
    if (lastAt != null && owner === -1) blocks.push({ at: last.retry_requested_at, note: null });
    blocks.sort((a, b) => time(a.at) - time(b.at));
    return blocks.map((b, i) => {
        // qa_rejection sem retry_requested_at é a recusa que o watcher acabou de detectar
        // (ainda sem retry): não é de nenhum bloco — antes ia pro último e a recusa nova
        // aparecia por cima da anterior.
        const mine = lastAt != null && Math.abs(time(b.at) - lastAt) < SAME_RETRY_MS;
        return {
            n: i + 1,
            note: b.note ?? (mine ? last.note ?? null : null),
            rejected_at: mine ? last.rejected_at ?? null : null,
            journal_id: mine ? last.journal_id ?? null : null,
            retry_requested_at: b.at,
            cost_baseline_usd: null,
            tokens_baseline: null,
            reconstructed: true,
        };
    });
}

// Início de retry que só sobrou no agent_log: o primeiro implement citando "Recusa QA"
// depois de um commit (o ciclo anterior tem que ter sido entregue pra ser recusado).
const RETRY_NOTE_RE = /recusa\s*qa/i;
function agentLogRetryStarts(agentLog, before) {
    const out = [];
    let delivered = false;
    for (const s of stepsBetween(agentLog, null, before)) {
        if (s.nodes.includes('commit')) delivered = true;
        else if (delivered && s.nodes.includes('implement') && RETRY_NOTE_RE.test(s.note || '')) {
            out.push(s.at);
            delivered = false;
        }
    }
    return out;
}

function withLostRetries(state, entries) {
    const count = Number.isInteger(state?.qa_retry_count) ? state.qa_retry_count : 0;
    const missing = count - entries.length;
    if (missing <= 0) return entries;
    const first = entries.length ? time(entries[0].retry_requested_at) : null;
    const lost = agentLogRetryStarts(state.agent_log, first).slice(-missing).map(at => ({
        note: null, rejected_at: null, journal_id: null, retry_requested_at: at,
        cost_baseline_usd: null, tokens_baseline: null, reconstructed: true,
    }));
    return [...lost, ...entries];
}

function stepsBetween(agentLog, from, to) {
    return (Array.isArray(agentLog) ? agentLog : [])
        .filter(a => { const t = time(a?.at); return t != null && (from == null || t >= from) && (to == null || t < to); })
        .sort((a, b) => time(a.at) - time(b.at))
        .map(a => ({
            nodes: Array.isArray(a.nodes) ? a.nodes : [],
            agent: a.agent || null,
            at: a.at,
            fallback: a.fallback === true || a.fallback === 'True',
            note: typeof a.note === 'string' ? a.note : (typeof a.summary === 'string' ? a.summary : null),
        }));
}

function prsBetween(state, from, to) {
    const out = [];
    const seen = new Set();
    const push = (repo, p) => {
        if (!p || !p.url || seen.has(p.url)) return;
        const t = time(p.opened_at);
        if (t == null || t < from || (to != null && t >= to)) return;
        seen.add(p.url);
        out.push({ repo: repo || p.repo || null, url: p.url, id: p.id ?? p.pr_id ?? null, status: p.status || null, opened_at: p.opened_at });
    };
    const cur = state?.pull_request;
    if (cur && typeof cur === 'object' && !Array.isArray(cur)) {
        if (cur.url) push(null, cur);
        else for (const [repo, p] of Object.entries(cur)) push(repo, p);
    }
    for (const p of Array.isArray(state?.pull_request_history) ? state.pull_request_history : []) push(p?.repo, p);
    return out;
}

const hasCommit = steps => steps.some(s => s.nodes.includes('commit'));

// { main, cycles, pending } ou null quando o run nunca teve recusa.
//   main    — ciclo original: início, fim (último passo antes do 1º retry), passos, custo.
//   cycles  — um por retry, mais recente por último: nota, datas, passos, custo, PRs, situação.
//   pending — recusa gravada pelo watcher que ainda não teve retry (ticket em Recusa QA agora).
function buildQaCycles(state, contextMd) {
    if (!state || typeof state !== 'object') return null;
    const entries = rejectionEntries(state, contextMd);
    const recorded = Array.isArray(state.qa_rejections) ? state.qa_rejections.filter(e => e && time(e.retry_requested_at) == null) : [];
    const rej = recorded[recorded.length - 1] || state.qa_rejection;
    const lastStart = entries.length ? time(entries[entries.length - 1].retry_requested_at) : null;
    const rejectedAt = time(rej?.rejected_at);
    const pending = rej && qaJournal.isQaRejectedStatus(state.ticket_status) && (lastStart == null || rejectedAt == null || rejectedAt > lastStart)
        ? { note: rej.note ?? null, rejected_at: rej.rejected_at ?? null, journal_id: rej.journal_id ?? null }
        : null;
    if (!entries.length && !pending) return null;

    const now = costTotals(state);
    const firstStart = entries.length ? time(entries[0].retry_requested_at) : null;
    const mainSteps = stepsBetween(state.agent_log, null, firstStart);
    const mainCost = entries[0]?.cost_baseline_usd;
    const main = {
        started_at: state.started_at || mainSteps[0]?.at || null,
        ended_at: mainSteps.length ? mainSteps[mainSteps.length - 1].at : null,
        steps: mainSteps.length,
        committed: hasCommit(mainSteps),
        cost_usd: entries.length ? (typeof mainCost === 'number' ? mainCost : null) : now.usd,
    };

    const active = ['in_progress', 'running'].includes(state.status);
    const cycles = entries.map((e, i) => {
        const from = time(e.retry_requested_at);
        const next = entries[i + 1];
        const to = next ? time(next.retry_requested_at) : null;
        const steps = stepsBetween(state.agent_log, from, to);
        const isLast = !next;
        const endUsd = next ? next.cost_baseline_usd : now.usd;
        const endTok = next ? next.tokens_baseline : now.tokens;
        const committed = hasCommit(steps);
        const situation = committed ? 'committed'
            : !isLast ? 'superseded'
                : active ? 'running'
                    : (state.status || 'unknown');
        const lastAt = steps.length ? steps[steps.length - 1].at : null;
        return {
            n: i + 1,
            note: e.note ?? null,
            rejected_at: e.rejected_at ?? null,
            journal_id: e.journal_id ?? null,
            started_at: e.retry_requested_at,
            ended_at: committed || !isLast ? lastAt : null,
            last_step_at: lastAt,
            node: isLast ? state.node || null : null,
            situation,
            // Entregue e recusado de novo depois (retry seguinte ou recusa pendente).
            rejected_again: !isLast || !!pending,
            steps,
            prs: prsBetween(state, from, to),
            cost_usd: typeof e.cost_baseline_usd === 'number' && typeof endUsd === 'number' ? Math.max(0, endUsd - e.cost_baseline_usd) : null,
            tokens: typeof e.tokens_baseline === 'number' && typeof endTok === 'number' ? Math.max(0, endTok - e.tokens_baseline) : null,
            reconstructed: e.reconstructed === true,
        };
    });
    return { main, cycles, pending };
}

// Histórico gravável (sem os campos de exibição): o array do state ou, em run antigo, o
// reconstruído. qa_rejection só entra na reconstrução se já teve retry — a recusa que o
// watcher acabou de detectar é a NOVA, não a de algum bloco antigo.
function historyOf(state, contextMd) {
    if (Array.isArray(state?.qa_rejections) && state.qa_rejections.length) return state.qa_rejections;
    const last = state?.qa_rejection;
    const legacyState = { ...state, qa_rejections: undefined, qa_rejection: time(last?.retry_requested_at) != null ? last : undefined };
    return rejectionEntries(legacyState, contextMd).map(({ reconstructed, ...e }) => e);
}

const sameRejection = (e, rej) => !!e && (
    (rej.rejected_at && e.rejected_at === rej.rejected_at) ||
    (!rej.rejected_at && rej.journal_id != null && e.journal_id === rej.journal_id && time(e.retry_requested_at) == null));

// Watcher detectou Recusa QA: entrada nova (pendente) em state.qa_rejections. Run antigo
// sem o campo herda antes o histórico reconstruído (lido com o qa_rejection ANTERIOR,
// que é o único que ainda sabe quando o último retry começou). Mesma recusa já gravada
// (mesmo rejected_at) não duplica.
function recordRejection(state, contextMd, { note, rejected_at, journal_id, at }) {
    const prior = historyOf(state, contextMd);
    if (prior.some(e => sameRejection(e, { rejected_at, journal_id }))) return prior;
    return [...prior, {
        n: prior.length + 1,
        note: note ?? null,
        rejected_at: rejected_at ?? null,
        journal_id: journal_id ?? null,
        detected_at: at ?? new Date().toISOString(),
        retry_requested_at: null,
    }];
}

// Retry que está começando: completa a recusa pendente (a última, gravada pelo watcher)
// com o início do retry e o custo acumulado agora; sem pendente, cria a entrada.
function appendRejection(state, contextMdBefore, { note, rejected_at, journal_id, at }) {
    const prior = historyOf(state, contextMdBefore);
    const c = costTotals(state);
    const retry = {
        retry_requested_at: at,
        history_len: Array.isArray(state?.history) ? state.history.length : 0,
        cost_baseline_usd: c.usd,
        tokens_baseline: c.tokens,
    };
    const last = prior[prior.length - 1];
    if (last && time(last.retry_requested_at) == null) {
        return [...prior.slice(0, -1), {
            ...last,
            note: note ?? last.note ?? null,
            rejected_at: rejected_at ?? last.rejected_at ?? null,
            journal_id: journal_id ?? last.journal_id ?? null,
            ...retry,
        }];
    }
    return [...prior, {
        n: prior.length + 1,
        note: note ?? null,
        rejected_at: rejected_at ?? null,
        journal_id: journal_id ?? null,
        ...retry,
    }];
}

module.exports = { parseContextRejections, buildQaCycles, appendRejection, recordRejection };
