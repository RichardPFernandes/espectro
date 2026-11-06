// Snapshot `routing` da Run: admissão → task (PRI-233 / PRI-205 S4, T5).
//
// A Run é admitida no ramo de ticket novo do watcher, pelo Attempt fetch_ticket do
// DOM06 (memory/runs/_dom06 do ticket). Com mode ON, o snapshot routing vai dentro do
// admission.snapshot desse Attempt, que é imutável. A task nasce depois, criada pelo
// agente com task-id próprio; o watcher a liga ao snapshot gravando em state.json
// routing_snapshot = { attempt_id, sha256 }.
//
// - recordAdmission / clearAdmission: na admissão, o watcher grava (ON) ou apaga (OFF)
//   o ponteiro _dom06/routing-admission.json com o id do Attempt de admissão que ele
//   já tem. Revisão do Checkpoint B (MAJOR-1): a ligação não depende de timestamps
//   gravados pelo agente.
// - bindingFor: o que fazer com uma task ainda sem routing_snapshot. Sem ponteiro =
//   Run OFF; ponteiro livre = ligar e marcar consumido; ponteiro já consumido (pela
//   própria task ou por outra) ou ilegível = recusar. Rastro de ON que não dá para
//   ligar nunca vira OFF, e não existe religação automática (AGENTS.md, regra 5).
// - loadRunSnapshot: o snapshot que vale para os Attempts de nó. Só lê o Attempt de
//   admissão ligado; nunca a config corrente do consumidor (AD-4). Ilegível, ausente,
//   adulterado ou com sha diferente da ligação → ok:false, que vira CONFIG_UNVERIFIABLE.

const fs = require('fs');
const path = require('path');
const mr = require('./model-routing');

const ATTEMPT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const POINTER = 'routing-admission.json';

function pointerPath(fetchRunDir) {
    return path.join(fetchRunDir, POINTER);
}

function writePointer(fetchRunDir, pointer) {
    fs.mkdirSync(fetchRunDir, { recursive: true });
    const file = pointerPath(fetchRunDir);
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(pointer, null, 2)}\n`);
    fs.renameSync(tmp, file);
}

/** Admissão ON: ponteiro livre para o Attempt fetch_ticket que carrega o snapshot. */
function recordAdmission(fetchRunDir, attempt) {
    const sha = attempt?.snapshot?.routing?.sha256;
    if (!attempt || typeof attempt.attempt_id !== 'string' || typeof sha !== 'string') {
        throw new Error('ROUTING_ADMISSION_REQUIRES_SNAPSHOT');
    }
    writePointer(fetchRunDir, { attempt_id: attempt.attempt_id, sha256: sha, consumed_by: null });
}

/** Admissão OFF: apaga o ponteiro de uma admissão ON anterior (no-op sem ponteiro). */
function clearAdmission(fetchRunDir) {
    fs.rmSync(pointerPath(fetchRunDir), { force: true });
}

function readPointer(fetchRunDir) {
    const file = pointerPath(fetchRunDir);
    if (!fs.existsSync(file)) return { exists: false };
    try {
        const p = JSON.parse(fs.readFileSync(file, 'utf8'));
        const ok = p && typeof p === 'object' && typeof p.attempt_id === 'string' && ATTEMPT_ID.test(p.attempt_id)
            && typeof p.sha256 === 'string' && SHA256_HEX.test(p.sha256)
            && (p.consumed_by === null || typeof p.consumed_by === 'string');
        return ok ? { exists: true, pointer: p } : { exists: true, pointer: null };
    } catch {
        return { exists: true, pointer: null };
    }
}

/** Depois de gravar state.routing_snapshot: o ponteiro passa a ser desta task. */
function markConsumed(fetchRunDir, taskId) {
    const { pointer } = readPointer(fetchRunDir);
    if (!pointer) throw new Error('ROUTING_ADMISSION_POINTER_UNREADABLE');
    writePointer(fetchRunDir, { ...pointer, consumed_by: taskId });
}

/**
 * @param {object} state state.json da task
 * @param {string} fetchRunDir memory/runs/_dom06 do ticket
 * @param {string} taskId
 * @returns {{ action: 'none' } | { action: 'bind', binding: { attempt_id: string, sha256: string } } | { action: 'refuse', detail: string }}
 */
function bindingFor(state, fetchRunDir, taskId) {
    if (state && state.routing_snapshot) return { action: 'none' };
    const read = readPointer(fetchRunDir);
    if (!read.exists) return { action: 'none' };
    if (!read.pointer) return { action: 'refuse', detail: 'admission_pointer_unreadable' };
    const p = read.pointer;
    if (p.consumed_by === null) return { action: 'bind', binding: { attempt_id: p.attempt_id, sha256: p.sha256 } };
    return { action: 'refuse', detail: p.consumed_by === taskId ? 'snapshot_binding_lost' : 'snapshot_binding_ambiguous' };
}

/**
 * @returns {{ mode: 'OFF' } | { mode: 'ON', ok: true, snapshot: object } | { mode: 'ON', ok: false, detail: string }}
 */
function loadRunSnapshot(state, fetchRunDir) {
    const binding = state && state.routing_snapshot;
    if (!binding) return { mode: 'OFF' };
    const fail = detail => ({ mode: 'ON', ok: false, detail });
    if (typeof binding.attempt_id !== 'string' || !ATTEMPT_ID.test(binding.attempt_id)) return fail('snapshot_unreadable');
    let attempt;
    try {
        attempt = JSON.parse(fs.readFileSync(path.join(fetchRunDir, 'dom06', 'attempts', `${binding.attempt_id}.json`), 'utf8'));
    } catch {
        return fail('snapshot_unreadable');
    }
    const snapshot = attempt?.snapshot?.routing;
    const integrity = mr.snapshotIntegrity(snapshot);
    if (!integrity.ok) return fail(integrity.detail);
    if (snapshot.sha256 !== binding.sha256) return fail('snapshot_binding_mismatch');
    return { mode: 'ON', ok: true, snapshot };
}

// ── T6: aviso único da admissão recusada ────────────────────────────────────────
// Um aviso por projeto e por assinatura (causa|detalhe), não por ticket nem por tick
// (diretriz R-6 n.º 5). Leitura transitória (E/S passageira) bloqueia sempre, mas só
// avisa no 3º bloqueio seguido, para não acusar "policy inválida" por I/O (R-6 n.º 6).
const TRANSIENT_NOTICE_AFTER = 3;

/**
 * @param {object|null} marker marcador anterior do projeto (ou null)
 * @param {{ cause: string, detail: string, transient: boolean }} cfg saída INVALID de readRoutingConfig
 * @param {{ ticketId: number|string, at: string }} ctx
 * @returns {{ notify: boolean, marker: object }}
 */
function blockedNotice(marker, cfg, { ticketId, at }) {
    const signature = `${cfg.cause}|${cfg.detail}`;
    const same = marker && marker.signature === signature;
    const tickets = same && Array.isArray(marker.tickets) ? [...marker.tickets] : [];
    if (!tickets.includes(ticketId)) tickets.push(ticketId);
    const transientCount = cfg.transient ? (same ? (marker.transient_count || 0) : 0) + 1 : 0;
    const alreadyNotified = Boolean(same && marker.notified_at);
    const notify = !alreadyNotified && (!cfg.transient || transientCount >= TRANSIENT_NOTICE_AFTER);
    // notified_at só é gravado por markNoticeSent, depois que o aviso saiu de fato: um
    // PUT que falhou deixa o marcador sem ele e o próximo tick tenta de novo (Bugbot, PR #97).
    // Mesma assinatura: preserva o estado de entrega do aviso (incerto, tentativas, local).
    const delivery = {};
    if (same) {
        for (const k of DELIVERY_FIELDS) if (marker[k] !== undefined) delivery[k] = marker[k];
    }
    return {
        notify,
        marker: {
            signature, cause: cfg.cause, detail: cfg.detail, transient: Boolean(cfg.transient),
            transient_count: transientCount, tickets,
            first_blocked_at: same ? marker.first_blocked_at : at,
            notified_at: same ? marker.notified_at || null : null,
            ...delivery,
        },
    };
}

const DELIVERY_FIELDS = ['local_notified_at', 'notice_attempts', 'notice_uncertain_at', 'notice_failed_at'];

function markNoticeSent(marker, at) {
    return { ...marker, notified_at: at };
}

// ── T8: limite de nó (D-4) ──────────────────────────────────────────────────────
// A override humana vale a partir do próximo limite de nó: retry/timeout/resume do mesmo
// nó não é limite. Limite = início da visita atual ao nó, achado voltando pelos eventos
// de ciclo de vida (node_start/node_end/node_error/node_retry) enquanto forem deste nó.
// Sem node_start nessa sequência, a visita começa agora (1º Attempt dela).
const LIFECYCLE = new Set(['node_start', 'node_end', 'node_error', 'node_retry']);

// O 1º Attempt de uma visita resolve com `now`, antes do node_start (gravado depois, no
// lease). Esse instante fica em state.routing_visit { node, at } (o watcher grava); nos
// retries da mesma visita vale o menor entre ele e o node_start (Bugbot, PR #97). Um
// routing_visit de visita anterior do mesmo nó (anterior ao fim da visita de outro nó
// que quebrou a sequência) é ignorado.
function nodeVisitStart(state, node, now) {
    const events = Array.isArray(state?.events) ? state.events : [];
    let start = null;
    let before = null; // instante do último evento de outro nó (fim da visita anterior)
    for (let i = events.length - 1; i >= 0; i--) {
        const e = events[i];
        if (!e || !LIFECYCLE.has(e.type)) continue;
        const ts = typeof (e.ts || e.at) === 'string' ? (e.ts || e.at) : null;
        if (e.node !== node) { before = ts; break; }
        if (e.type === 'node_start' && ts) start = ts;
    }
    if (!start) return now; // visita nova: 1º Attempt
    const v = state?.routing_visit;
    const vAt = v && v.node === node && typeof v.at === 'string' ? Date.parse(v.at) : NaN;
    const ok = Number.isFinite(vAt) && (before == null || vAt > Date.parse(before)) && vAt < Date.parse(start);
    return ok ? v.at : start;
}

/** O watcher grava o limite do 1º Attempt da visita (só quando a visita é nova). */
function visitToRecord(state, node, boundary, now) {
    return boundary === now ? { node, at: now } : null;
}

module.exports = {
    recordAdmission, clearAdmission, markConsumed, bindingFor, loadRunSnapshot, blockedNotice, markNoticeSent, nodeVisitStart, visitToRecord,
    TRANSIENT_NOTICE_AFTER,
};
