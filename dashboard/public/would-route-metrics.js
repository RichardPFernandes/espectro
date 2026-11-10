// Leitor de GET /api/would-route-metrics (medição would_route em sombra, S3) para a tela
// Roteamento (routing.js). Desde a onda 1 do design (PRI-328) a tela segue o artboard
// ModelRouting e usa daqui só o diagnóstico da sombra, no aviso do topo da lista; a medição
// agregada (contagem por faixa, economia como hipótese de preço, decisões recentes) saiu da
// tela até entrar no canvas. Só lê; nunca altera o despacho.
(() => {
  let data = null, loading = false, reload = false;

  async function load() {
    if (loading) { reload = true; return; }
    loading = true;
    try {
      data = await api('/api/would-route-metrics');
    } catch {
      // Sem a medição, o aviso da sombra simplesmente não aparece (nada é inventado).
      data = null;
    } finally {
      loading = false;
      window.Views?.refresh();
      if (reload) { reload = false; load(); }
    }
  }

  window.WouldRouteMetricsView = { load, get: () => data };
})();
