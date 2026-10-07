// Banner persistente "⚠ DRY-RUN MODE" no topo do dashboard enquanto o watcher estiver
// (ou tiver rodado por último) em modo DRY-RUN — ver scripts/lib/dry-run.js. Evita
// confundir os runs do ticket fictício do fixture com tickets reais do Redmine. Dados
// de GET /api/watcher/mode; sem botão de fechar de propósito: some quando o watcher
// volta pro modo live. Script clássico; usa os globais do script principal (api, esc, $).
(() => {
  const POLL_MS = 15000;

  document.body.insertAdjacentHTML('afterbegin',
    '<div class="dryrun-banner" id="dryRunBanner" role="status" aria-live="polite" hidden></div>');
  const banner = $('dryRunBanner');

  async function load() {
    let m;
    try { m = await api('/api/watcher/mode'); } catch { return; } // mantém o último estado
    banner.hidden = !m.dry_run;
    if (!m.dry_run) return;
    const tickets = (m.tickets || []).map(t => `#${t}`).join(', ');
    const origin = m.source === 'env' ? 'dashboard iniciado com DRY_RUN=true' : 'último tick do watcher';
    banner.innerHTML =
      '<b>⚠ DRY-RUN MODE</b>' +
      `<span>Dados de teste (fixture${m.fixture ? ` <code>${esc(m.fixture)}</code>` : ''}${tickets ? `, ticket ${esc(tickets)}` : ''}) — ` +
      `nenhuma chamada real ao Redmine, Bitbucket ou agentes. Origem: ${esc(origin)}.</span>`;
  }

  load();
  setInterval(() => { if (!document.hidden) load(); }, POLL_MS);
})();
