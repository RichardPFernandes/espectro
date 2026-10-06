// Tela desatualizada ANTES do clique (scripts/cas.js, docs/concurrency-map.md): com um
// run aberto no detalhe, consulta GET /api/state/version a cada 5 s e compara com a
// stateVersion que a tela carregou (summary do servidor). Servidor à frente → banner não
// bloqueante. As ações devolvem o casToken carregado no body; 409 STATE_CONFLICT /
// SESSION_CONFLICT mostra o mesmo banner (nunca erro genérico).
// Carregado como script clássico (window.StateVersion) e via require() nos testes.
(function (root) {
  const INTERVAL_MS = 5000;
  const MESSAGE = 'Este run mudou desde que a tela foi carregada. Atualize antes de executar esta ação.';
  const CONFLICT_CODES = ['STATE_CONFLICT', 'SESSION_CONFLICT'];

  function loadedVersion(run) {
    return run && Number.isInteger(run.stateVersion) ? run.stateVersion : null;
  }

  function isStale(loaded, server) {
    return Number.isInteger(loaded) && !!server && Number.isInteger(server.state_version) && server.state_version > loaded;
  }

  function newOperationId() {
    if (root.crypto && typeof root.crypto.randomUUID === 'function') return root.crypto.randomUUID();
    return `op-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  }

  // Corpo das ações humanas: o que a tela carregou + operation_id (idempotência).
  function casBody(run, extra) {
    const t = (run && run.casToken) || {};
    return Object.assign({
      expected_state_version: t.expected_state_version,
      expected_node: t.expected_node,
      expected_spec_hash: t.expected_spec_hash,
      execution_id: t.execution_id,
    }, extra || {});
  }

  function isConflict(status, body) {
    return status === 409 && !!body && CONFLICT_CODES.includes(body.code);
  }

  // fetchVersion(taskId) → { state_version, node, execution_id }; current() → run aberto
  // (ou null); onChange(stale, info) a cada checagem. timers/isVisible injetáveis (teste).
  function createPoller({ fetchVersion, current, onChange, intervalMs = INTERVAL_MS, timers = root, isVisible = () => true }) {
    let timer = null;
    async function check() {
      const run = current();
      if (!run || !isVisible()) return null;
      const loaded = loadedVersion(run);
      let server;
      try { server = await fetchVersion(run.taskId); } catch { return null; }
      const stale = isStale(loaded, server);
      onChange(stale, { taskId: run.taskId, loaded, server });
      return stale;
    }
    return {
      check,
      start() { if (!timer) timer = timers.setInterval(check, intervalMs); },
      stop() { if (timer) { timers.clearInterval(timer); timer = null; } },
    };
  }

  const api = { INTERVAL_MS, MESSAGE, CONFLICT_CODES, loadedVersion, isStale, newOperationId, casBody, isConflict, createPoller };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.StateVersion = api;
})(typeof window !== 'undefined' ? window : globalThis);
