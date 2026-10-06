// Quando o watcher notifica o dev via webhook (scripts/notify.js, NOTIFY_WEBHOOK_URL):
//
//   a) PR aberto (low-risk)            — task "committed" com URL em state.pull_request
//   b) PR aberto como Draft HIGH-RISK  — idem, com state.risk_level = "high"
//   c) Escalação pra humano            — status "escalated" (max_retries) ou
//                                        "needs_human_review" (commit órfão)
//
// O PR é aberto pelo agente do /commit, não pelo watcher — em modo destacado o watcher
// nem vê o agente sair. Por isso (a)/(b) são uma varredura por tick (sweepOpenedPrs),
// igual à limpeza de worktrees pós-PR, e (c) sai do mesmo ponto do despacho que já
// chama notifyBlocked.
//
// Dedup em arquivo marcador DENTRO do dir da task — nunca no state.json (falha de
// notificação não pode mexer no estado do ciclo). O marcador viaja junto quando o run
// é arquivado/copiado pro checkout principal, então a mesma task não notifica duas vezes.
// Só entram na varredura tasks cujo state.json mudou nas últimas PR_NOTIFY_MAX_AGE_MS:
// ligar o webhook num checkout com dezenas de tasks committed antigas não dispara uma
// rajada de mensagens velhas.
//
// Conteúdo: só título do ticket, URLs de PR, risk_reason e o detail de eventos que o
// watcher/agente gravam no state.json. Nunca context.md/handoff.md (informação de
// negócio sensível).
const fs = require('fs');
const path = require('path');
const { sendNotification, slackPayload, webhookUrlFromEnv } = require('../notify');

const PR_MARKER = '.watcher-pr-notified.json';
const ESCALATION_MARKER = '.watcher-webhook-notified.json';
const PR_NOTIFY_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const ESCALATION_STATUSES = new Set(['escalated', 'needs_human_review']);
const MAX_TEXT = 300;

// Slack trata &, < e > como controle no mrkdwn; resto do texto vai literal.
function slackText(s, max = MAX_TEXT) {
    const t = String(s ?? '').replace(/\s+/g, ' ').trim();
    const cut = t.length > max ? `${t.slice(0, max - 1)}…` : t;
    return cut.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// URLs de PR aberto em state.json.pull_request: mapa por repo ({url} ou URL solta) ou,
// em task antiga, uma entrada plana. Mesma regra de openedPrUrls no watcher.
function prUrls(pr) {
    const one = v => (typeof v === 'string' ? v : v && typeof v === 'object' ? v.url : null);
    if (!pr) return [];
    const urls = typeof pr === 'string' || typeof pr.url === 'string' ? [one(pr)] : Object.values(pr).map(one);
    return [...new Set(urls.filter(u => typeof u === 'string' && /^https?:\/\//.test(u)))];
}

function isDraftPr(state) {
    if (state?.risk_level === 'high') return true;
    const pr = state?.pull_request;
    return !!pr && typeof pr === 'object' && Object.values(pr).some(v => v && typeof v === 'object' && v.draft === true);
}

function taskTitleOf(state) {
    return state?.redmine_ticket?.subject || '';
}

function prOpenedPayload(taskId, state) {
    const urls = prUrls(state.pull_request);
    const title = taskTitleOf(state);
    const lines = [];
    if (title) lines.push(`*${slackText(title)}*`);
    lines.push(...urls.map(u => `PR: ${u}`));
    if (isDraftPr(state)) {
        lines.push(`Motivo: ${slackText(state.risk_reason || '(Verify não registrou risk_reason)')}`);
        return slackPayload({ title: `⚠️ Task #${taskId} — PR HIGH-RISK (Draft)`, message: lines.join('\n'), color: 'warning', url: urls[0] });
    }
    return slackPayload({ title: `✅ Task #${taskId} — PR aberto`, message: lines.join('\n'), color: 'good', url: urls[0] });
}

// Motivo da escalação: detail do último evento "escalation" (nodeEvents: max_retries;
// node-lease: commit órfão) ou, sem ele, status/nó/tentativas.
function escalationReason(state, node, status) {
    const events = Array.isArray(state?.events) ? state.events : [];
    for (let i = events.length - 1; i >= 0; i--) {
        if (events[i]?.type === 'escalation' && events[i].detail) return events[i].detail;
    }
    const retries = Number(state?.retries?.[node]) || 0;
    return `status "${status}" no nó "${node}"` + (retries ? ` após ${retries} tentativa(s)` : '');
}

function escalationPayload(taskId, state, node, status) {
    const title = taskTitleOf(state);
    const lines = [];
    if (title) lines.push(`*${slackText(title)}*`);
    lines.push(`Motivo: ${slackText(escalationReason(state, node, status))}`);
    return slackPayload({ title: `🚨 Task #${taskId} — Escalada para humano`, message: lines.join('\n'), color: 'danger' });
}

function readJson(file) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function writeMarker(dir, name, data) {
    try {
        fs.writeFileSync(path.join(dir, name), JSON.stringify({ ...data, notified_at: new Date().toISOString() }, null, 2));
    } catch (e) {
        console.warn(`[notify] não consegui gravar ${name} em ${dir}: ${e.message}`);
    }
}

// Dirs de task em cada runsDir e no _archive dele.
function taskDirs(runsDirs) {
    const out = [];
    for (const base of runsDirs) {
        for (const d of [base, path.join(base, '_archive')]) {
            let entries;
            try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
            for (const e of entries) if (e.isDirectory() && e.name !== '_archive') out.push(path.join(d, e.name));
        }
    }
    return out;
}

// Varre os runs e notifica (a)/(b) uma vez por task. Devolve [{ taskId, draft, result }].
async function sweepOpenedPrs({
    runsDirs, send = sendNotification, enabled = !!webhookUrlFromEnv(),
    now = Date.now(), maxAgeMs = PR_NOTIFY_MAX_AGE_MS, filter,
} = {}) {
    if (!enabled) return [];
    const byTask = new Map(); // taskId -> { state, dirs, marked }
    for (const dir of taskDirs(runsDirs)) {
        const stateFile = path.join(dir, 'state.json');
        let mtime;
        try { mtime = fs.statSync(stateFile).mtimeMs; } catch { continue; }
        if (now - mtime > maxAgeMs) continue;
        const state = readJson(stateFile);
        if (state?.status !== 'committed' || !prUrls(state.pull_request).length) continue;
        const taskId = state.task_id || path.basename(dir);
        if (filter && !filter(taskId)) continue;
        const entry = byTask.get(taskId) || { state, dirs: [], marked: false };
        entry.dirs.push(dir);
        if (fs.existsSync(path.join(dir, PR_MARKER))) entry.marked = true;
        byTask.set(taskId, entry);
    }

    const results = [];
    for (const [taskId, { state, dirs, marked }] of byTask) {
        if (marked) continue;
        let result;
        try {
            result = await send(prOpenedPayload(taskId, state));
        } catch (e) {
            result = { sent: false, error: e.message };
        }
        // Marca mesmo se falhou: best-effort, sem reenviar a cada tick (webhook fora do
        // ar custaria até 5 s por task em todo tick).
        for (const dir of dirs) writeMarker(dir, PR_MARKER, { urls: prUrls(state.pull_request), sent: !!result?.sent, status: result?.status ?? null });
        results.push({ taskId, draft: isDraftPr(state), result });
    }
    return results;
}

// (c): chamado a cada tick em que a task está parada nesse status; só notifica quando
// nó+status muda (mesma assinatura do notifyBlocked). Devolve o resultado do envio ou null.
async function notifyEscalation({ dir, taskId, state, node, status, send = sendNotification, enabled = !!webhookUrlFromEnv() }) {
    if (!enabled || !ESCALATION_STATUSES.has(status)) return null;
    const signature = `${node}:${status}`;
    if (readJson(path.join(dir, ESCALATION_MARKER))?.signature === signature) return null;
    let result;
    try {
        result = await send(escalationPayload(taskId, state, node, status));
    } catch (e) {
        result = { sent: false, error: e.message };
    }
    writeMarker(dir, ESCALATION_MARKER, { signature, sent: !!result?.sent, status: result?.status ?? null });
    return result;
}

module.exports = {
    sweepOpenedPrs, notifyEscalation, prOpenedPayload, escalationPayload, escalationReason,
    prUrls, isDraftPr, PR_MARKER, ESCALATION_MARKER, PR_NOTIFY_MAX_AGE_MS,
};
