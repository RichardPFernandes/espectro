// Snapshot `routing` da Run: admissão → task (PRI-233 / PRI-205 S4, T5).
//
// A Run é admitida no ramo de ticket novo do watcher, pelo Attempt fetch_ticket do
// DOM06 (memory/runs/_dom06 do ticket). Com mode ON, o snapshot routing vai dentro do
// admission.snapshot desse Attempt, que é imutável. A task nasce depois, criada pelo
// agente com task-id próprio; o watcher a liga ao snapshot gravando em state.json
// routing_snapshot = { attempt_id, sha256 }.
//
// - bindingFor: qual ligação gravar numa task ainda sem routing_snapshot. Usa o
//   fetch_ticket mais recente criado até o started_at da task; sem routing nele, a Run
//   foi admitida OFF e nada é ligado (null).
// - loadRunSnapshot: o snapshot que vale para os Attempts de nó. Só lê o Attempt de
//   admissão ligado; nunca a config corrente do consumidor (AD-4). Ilegível, ausente,
//   adulterado ou com sha diferente da ligação → ok:false, que vira CONFIG_UNVERIFIABLE.

const fs = require('fs');
const path = require('path');
const dom06 = require('./dom06-attempt');
const mr = require('./model-routing');

const ATTEMPT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function instant(v) {
    const t = typeof v === 'string' ? Date.parse(v) : NaN;
    return Number.isFinite(t) ? t : null;
}

/**
 * @param {object} state state.json da task
 * @param {string} fetchRunDir memory/runs/_dom06 do ticket
 * @returns {{ attempt_id: string, sha256: string } | null}
 */
function bindingFor(state, fetchRunDir) {
    if (state && state.routing_snapshot) return null;
    const startedAt = instant(state && state.started_at);
    const fetches = dom06.listAttempts(fetchRunDir).filter(a => a.node === 'fetch_ticket' && a.started
        && (startedAt == null || (instant(a.created_at) ?? Infinity) <= startedAt));
    const admitted = fetches[fetches.length - 1];
    const routing = admitted?.snapshot?.routing;
    if (!routing || typeof routing.sha256 !== 'string') return null;
    return { attempt_id: admitted.attempt_id, sha256: routing.sha256 };
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

module.exports = { bindingFor, loadRunSnapshot };
