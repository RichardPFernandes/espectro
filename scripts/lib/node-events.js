// Log estruturado de eventos por nó em state.json.events — observabilidade pra
// investigar falha de nó sem reler handoff.md/context.md (narrativos).
//
// Quem emite é o watcher, a partir do que ele já sabe do despacho: node_start ao
// despachar (dispatchTicket) e, quando o agente sai, recordNodeExit — chamado do
// release do lease, que roda nos dois modos (em --follow no exit do child; sem
// --follow pelo wrapper sh, via `node lib/node-lease.js release '<lease>' <exit code>`).
// O resultado do nó é deduzido comparando o state.json antes/depois:
//   - exit code != 0 (ou sem exit code: sinal/falha no spawn) → node_error
//   - exit 0 → node_end e, conforme o que o comando gravou:
//       status/node "escalated"          → escalation (max_retries ou outro motivo)
//       retries[node] incrementado       → node_retry (aresta on_fail)
//       status blocked/needs_human_review/spec-invalid/spec-drift/
//              spec-change-pending-approval                  → checkpoint
// Os agentes não mudam. Tipos novos (node_start/node_end/node_retry/checkpoint) somam
// aos que outros módulos já gravam (node_error, escalation, plan_replan, replay...).
//
// Formato: { ts, type, node, agent, detail, exit_code?, at } — `ts` é o campo
// pedido pela spec de observabilidade; `at` (mesmo valor) mantém compatível quem já
// lia/validava eventos por `at`. exit_code só em node_end/node_error.
//
// Nunca lança: falha ao gravar evento é logada e o watcher segue (logging não pode
// derrubar despacho). Append-only: nunca remove nem reescreve eventos existentes.
const fs = require('fs');
const path = require('path');
const stateWriter = require('../state-writer');

const GRAPH_PATH = path.join(__dirname, '..', '..', '.graph', 'graph.yaml');
// Fallback se .graph/graph.yaml não puder ser lido — mesmos valores de hoje.
const DEFAULT_MAX_RETRIES = { review: 3, test: 3, verify: 2 };
const CHECKPOINT_STATUSES = new Set(['blocked', 'needs_human_review', 'spec-invalid', 'spec-drift', 'spec-change-pending-approval', 'authorization-pending']);

let maxRetriesCache = null;
// Parser mínimo (sem dependência de YAML): pares `- id: <nó>` / `max_retries: N`.
function maxRetries(node) {
    if (!maxRetriesCache) {
        maxRetriesCache = { ...DEFAULT_MAX_RETRIES };
        try {
            let current = null;
            for (const line of fs.readFileSync(GRAPH_PATH, 'utf8').split('\n')) {
                const id = line.match(/^\s*-\s*id:\s*([\w-]+)/);
                if (id) { current = id[1]; continue; }
                const max = line.match(/^\s+max_retries:\s*(\d+)/);
                if (max && current) maxRetriesCache[current] = Number(max[1]);
            }
        } catch { /* fica o fallback */ }
    }
    return maxRetriesCache[node];
}

function buildEvent(event) {
    const ts = event.ts || new Date().toISOString();
    const out = { ts, type: event.type };
    for (const k of ['node', 'agent', 'detail']) if (event[k] !== undefined) out[k] = event[k];
    if (event.type === 'node_end' || event.type === 'node_error') out.exit_code = event.exit_code ?? null;
    out.at = ts;
    return out;
}

// Lê state.json de `dir`, faz push em events (inicializa [] se ausente) e regrava.
function appendEvents(dir, events) {
    if (!events.length) return true;
    try {
        // Campo secundário: não sobe state_version (sem conflito falso com transições).
        const written = stateWriter.update(dir, state => {
            state.events = Array.isArray(state.events) ? state.events : [];
            state.events.push(...events.map(buildEvent));
        }, { operation: 'append_events', actor: 'watcher' });
        if (!written) throw new Error('state.json ausente ou ilegível');
        return true;
    } catch (e) {
        console.error(`[events] falha gravando evento(s) ${events.map(e => e.type).join(', ')} em ${dir}: ${e.message}`);
        return false;
    }
}

function appendEvent(dir, event) {
    return appendEvents(dir, [event]);
}

const label = node => node.charAt(0).toUpperCase() + node.slice(1);

// Eventos de saída de um despacho (puro — testável sem disco). `nodes`: nós cobertos
// pelo despacho, na ordem (normalmente um; fetch_ticket+plan num despacho de task nova).
// `state`: state.json depois que o agente saiu. `retriesBefore`: retries[último nó]
// no momento do despacho.
function exitEvents({ nodes, state, code, retriesBefore = 0, agent = 'claude' }) {
    const node = nodes[nodes.length - 1];
    if (code !== 0) {
        return [{
            type: 'node_error', node, agent, exit_code: code ?? null,
            detail: code == null
                ? `Agente saiu sem exit code (sinal ou falha no spawn) no nó ${node} — ver handoff.md para detalhes`
                : `Claude retornou exit code ${code} no nó ${node} — ver handoff.md para detalhes`,
        }];
    }
    const s = state || {};
    const next = s.node;
    const status = s.status;
    const extra = [];
    if (node === 'verify' && s.risk_level) extra.push(`risk_level: ${s.risk_level}`);
    if (next) extra.push(`node: ${next}`);
    if (status && !['in_progress', 'running'].includes(status)) extra.push(`status: ${status}`);
    const events = nodes.map(n => ({
        type: 'node_end', node: n, agent, exit_code: 0,
        detail: `Nó ${n} concluído` + (n === node && extra.length ? ` — ${extra.join(', ')}` : ''),
    }));

    const retries = Number(s.retries?.[node]) || 0;
    const max = maxRetries(node);
    if (status === 'escalated' || next === 'escalated') {
        events.push({
            type: 'escalation', node, agent,
            detail: max != null && retries >= max
                ? `max_retries atingido em ${node} (${retries}/${max}) — escalando para humano`
                : `Nó ${node} escalou para humano (status: ${status || '-'}, node: ${next || '-'})`,
        });
    } else if (retries > retriesBefore) {
        events.push({
            type: 'node_retry', node, agent,
            detail: `${label(node)} reprovado (retry ${retries}${max != null ? `/${max}` : ''}) — voltando para ${next || '?'}`,
        });
    } else if (CHECKPOINT_STATUSES.has(status)) {
        events.push({
            type: 'checkpoint', node, agent,
            detail: `Pausado para decisão humana após ${node} — status: ${status}`,
        });
    }
    return events;
}

// Chamado quando o agente de um lease sai. lease.dir (task existente) ou `dir`
// resolvido pelo caller (task nova, criada pelo próprio fetch_ticket durante o despacho
// — aí os node_start também vão aqui, com ts do despacho, já que antes não havia
// state.json onde gravá-los). Ignora se o state.json já é de outro despacho.
function recordNodeExit(lease, code, dir = lease?.dir) {
    try {
        if (!lease || !dir) return false;
        const state = JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'));
        if (state.node_started_at && lease.startedAt && state.node_started_at !== lease.startedAt) return false;
        const nodes = lease.nodes || (lease.node ? [lease.node] : []);
        if (!nodes.length) return false;
        const events = [];
        if (!lease.dir) {
            for (const n of nodes) {
                events.push({
                    type: 'node_start', node: n, agent: 'claude', ts: lease.startedAt,
                    detail: `Despachando ${nodes.join('+')} para Claude (task nova)`,
                });
            }
        }
        events.push(...exitEvents({ nodes, state, code, retriesBefore: lease.retriesBefore || 0 }));
        return appendEvents(dir, events);
    } catch (e) {
        console.error(`[events] falha registrando saída do nó (${lease?.node || lease?.nodes}): ${e.message}`);
        return false;
    }
}

module.exports = { appendEvent, appendEvents, buildEvent, exitEvents, recordNodeExit, maxRetries, CHECKPOINT_STATUSES };
