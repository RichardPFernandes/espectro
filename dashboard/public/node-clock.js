// Relógio do nó em execução + detecção de interrupção, 100% client-side a partir do
// state.json (ver scripts/lib/node-lease.js e
// memory/decisions/2026-09-22-recuperacao-no-orfao-watcher.md). A interrupção vem de
//   - status "interrupted" gravado pelo shutdown graceful do watcher ao receber SIGTERM
//     (scripts/lib/graceful-shutdown.js — interruptedAt/activeNodeAtInterruption), ou é
//     DERIVADA de
//   - status "running" com node_started_at além de node_timeout_ms (suspeita: o agente
//     provavelmente morreu, o watcher recupera no próximo startup), ou
//   - último evento de recuperação de órfão em state.events (node_error "Nó órfão…"
//     ou escalation de commit órfão) sem despacho novo depois dele.
// Carregado como script clássico (window.NodeClock) e via require() nos testes.
(function (root) {
  const DEFAULT_TIMEOUT_MS = 60 * 60 * 1000; // mesmo padrão do watcher (node-lease.js)
  const ORPHAN_RE = /órf[ãa]o/i;

  function timeoutOf(state) {
    const t = Number(state && state.node_timeout_ms);
    return t > 0 ? t : DEFAULT_TIMEOUT_MS;
  }

  // Nó com lease ativo (status cru "running", não o "running" agregado do servidor,
  // que também cobre in_progress) e node_started_at legível.
  function isLive(state) {
    return !!state && state.status === 'running' && Number.isFinite(Date.parse(state.node_started_at));
  }

  // Níveis: '' (normal) → 'warn' (> 50%) → 'hot' (> 80%) → 'over' (> 100%).
  function levelOf(ratio) {
    if (ratio > 1) return 'over';
    if (ratio > 0.8) return 'hot';
    if (ratio > 0.5) return 'warn';
    return '';
  }

  function clock(state, now = Date.now()) {
    if (!isLive(state)) return null;
    const startedAt = Date.parse(state.node_started_at);
    const timeoutMs = timeoutOf(state);
    const elapsedMs = Math.max(0, now - startedAt);
    const ratio = elapsedMs / timeoutMs;
    return { node: state.node, startedAt, timeoutMs, elapsedMs, ratio, level: levelOf(ratio) };
  }

  function fmtDuration(ms) {
    const total = Math.floor(Math.max(0, ms) / 1000);
    const h = Math.floor(total / 3600), m = Math.floor((total % 3600) / 60), s = total % 60;
    const pad = n => String(n).padStart(2, '0');
    return h ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
  }

  function lastOrphanEvent(state) {
    const events = (state && state.events) || [];
    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i];
      if ((e.type === 'node_error' || e.type === 'escalation') && ORPHAN_RE.test(e.detail || '')) return e;
    }
    return null;
  }

  // null, ou { kind, interruptedAt (ISO), activeNodeAtInterruption, detectedAt?, detail? }.
  //   kind "suspected": running além do timeout, watcher ainda não recuperou.
  //   kind "recovered": órfão devolvido pra fila, aguardando o redespacho.
  //   kind "escalated": commit órfão, precisa de verificação humana.
  //   kind "sigterm": watcher recebeu SIGTERM durante o nó, retomada manual.
  function interruption(state, now = Date.now()) {
    if (!state || state.status === 'committed') return null;
    if (state.status === 'interrupted') {
      return { kind: 'sigterm', interruptedAt: state.interruptedAt || null, activeNodeAtInterruption: state.activeNodeAtInterruption || state.node };
    }
    const c = clock(state, now);
    if (c && c.ratio > 1) {
      return { kind: 'suspected', interruptedAt: state.node_started_at, activeNodeAtInterruption: state.node, timeoutMs: c.timeoutMs };
    }
    const ev = lastOrphanEvent(state);
    if (!ev) return null;
    const detectedAt = Date.parse(ev.at);
    // Despacho novo depois da detecção = já foi redespachado, não está mais interrompido.
    if (Number.isFinite(detectedAt) && Date.parse(state.node_started_at) > detectedAt) return null;
    if (ev.type === 'escalation' && state.status !== 'needs_human_review') return null;
    if (ev.type === 'node_error' && state.status !== 'in_progress') return null;
    const since = (state.recovered_from_orphan && state.recovered_from_orphan.orphan_since)
      || state.node_started_at || ev.at;
    return {
      kind: ev.type === 'escalation' ? 'escalated' : 'recovered',
      interruptedAt: since, activeNodeAtInterruption: ev.node || state.node,
      detectedAt: ev.at, detail: ev.detail,
    };
  }

  const api = { DEFAULT_TIMEOUT_MS, clock, levelOf, fmtDuration, interruption, lastOrphanEvent };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.NodeClock = api;
})(typeof window !== 'undefined' ? window : globalThis);
