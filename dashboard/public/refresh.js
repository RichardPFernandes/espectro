// Atualização manual (botão ↻ / tecla R) e automática a cada N segundos.
// O WebSocket já empurra mudanças de state.json/context.md; isto cobre o resto (run que
// muda de pasta, dados do Redmine/Bitbucket, tempos relativos) sem recarregar a página.
// Script clássico carregado depois de views.js/ux.js; usa os globais do script principal.
(() => {
  const OPTIONS = [[0, 'Desligado'], [30, 'A cada 30 s'], [60, 'A cada 1 min'], [300, 'A cada 5 min'], [900, 'A cada 15 min']];
  // Redmine/Bitbucket nunca mais que uma vez a cada 5 min no automático.
  const EXTERNAL_MIN_MS = 5 * 60 * 1000;
  const cfg = Object.assign({ sec: 0, external: false }, prefs.autoRefresh || {});
  let lastAt = 0, lastExternalAt = 0, busy = false, timer = null;

  const save = () => { prefs.autoRefresh = cfg; persist(); };
  const label = () => (OPTIONS.find(([s]) => s === cfg.sec) || OPTIONS[0])[1];

  async function refreshNow({ external = false, manual = false } = {}) {
    if (busy) return;
    busy = true; paint();
    try {
      // Força a varredura dos arquivados com demanda aberta (cache por ticket no servidor).
      if (external) await fetch('/api/archived-open/refresh', { method: 'POST' }).catch(() => {});
      await refreshRuns();
      if (selected) loadContext(false);
      if (external) {
        lastExternalAt = Date.now();
        const r = runs.get(selected);
        if (r && extractPrs(r.state?.pull_request).length) loadPr(selected, true);
        if (r && ticketCache.has(selected)) { ticketCache.delete(selected); if ($('foldTicket')?.open) loadTicket(selected); }
        await window.Views?.loadAll?.(true);
      }
      lastAt = Date.now();
      if (manual) toast(external ? 'Atualizado, incluindo Redmine e Bitbucket.' : 'Atualizado.');
    } catch (e) {
      if (manual) toast(`Não deu para atualizar: ${e.message}`);
    } finally {
      busy = false; paint();
    }
  }

  function tick() {
    if (document.hidden || !cfg.sec) return;
    const external = cfg.external && Date.now() - lastExternalAt >= EXTERNAL_MIN_MS;
    refreshNow({ external });
  }
  function schedule() {
    clearInterval(timer);
    timer = cfg.sec ? setInterval(tick, cfg.sec * 1000) : null;
    paint();
  }
  // Voltou pra aba depois de um intervalo inteiro parado: atualiza na hora.
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && cfg.sec && Date.now() - lastAt >= cfg.sec * 1000) tick();
  });

  // ------------------------------------------------------------------ UI
  // Controle compacto na topbar (um grupo de 40 px, como o LimitsBar do design); CSS em
  // screens/system.css.
  const live = $('live');
  live.insertAdjacentHTML('beforebegin', `
    <div class="refresh-ctl" id="refreshCtl">
      <button type="button" class="refresh-now" id="refreshNow" title="Atualizar agora (R)" aria-keyshortcuts="R">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M20 12a8 8 0 1 1-2.34-5.66M20 4v5h-5" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>
        <span class="sys-sr">Atualizar</span>
      </button>
      <button type="button" class="refresh-auto" id="refreshAuto" aria-haspopup="true" aria-expanded="false"></button>
      <div class="refresh-menu" id="refreshMenu" role="menu" hidden></div>
    </div>`);

  function paint() {
    const btn = $('refreshNow');
    btn.classList.toggle('spinning', busy);
    btn.disabled = busy;
    const ago_ = lastAt ? ago(new Date(lastAt).toISOString()) : 'ainda não';
    btn.title = `Atualizar agora (R). Última atualização: ${ago_}.`;
    const auto = $('refreshAuto');
    auto.textContent = cfg.sec ? `Auto: ${label().replace('A cada ', '')}` : 'Auto: desligado';
    auto.classList.toggle('on', !!cfg.sec);
    auto.title = cfg.sec
      ? `Atualiza sozinho ${label().toLowerCase()}${cfg.external ? ', com Redmine e Bitbucket no máximo a cada 5 min' : ''}. Pausa com a aba em segundo plano.`
      : 'Escolher atualização automática';
  }

  function renderMenu() {
    $('refreshMenu').innerHTML = `
      <div class="rm-title">Atualizar automaticamente</div>
      ${OPTIONS.map(([s, l]) => `<button type="button" role="menuitemradio" aria-checked="${cfg.sec === s}" data-sec="${s}">${l}</button>`).join('')}
      <label class="rm-check"><input type="checkbox" id="refreshExternal" ${cfg.external ? 'checked' : ''}>
        <span>Também consultar Redmine e Bitbucket<small>No máximo a cada 5 min, para não sobrecarregar as APIs.</small></span></label>
      <p class="rm-foot">Mudanças no state.json e no context.md já chegam ao vivo. Pausa com a aba em segundo plano.</p>`;
  }
  function toggleMenu(open) {
    const m = $('refreshMenu');
    const show = open ?? m.hidden;
    if (show) renderMenu();
    m.hidden = !show;
    $('refreshAuto').setAttribute('aria-expanded', show);
  }

  $('refreshNow').addEventListener('click', () => refreshNow({ external: true, manual: true }));
  $('refreshAuto').addEventListener('click', e => { e.stopPropagation(); toggleMenu(); });
  $('refreshMenu').addEventListener('click', e => {
    e.stopPropagation();
    const b = e.target.closest('[data-sec]');
    if (!b) return;
    cfg.sec = Number(b.dataset.sec); save(); schedule(); renderMenu();
    toast(cfg.sec ? `Atualização automática: ${label().toLowerCase()}.` : 'Atualização automática desligada.');
    if (cfg.sec) tick();
  });
  $('refreshMenu').addEventListener('change', e => {
    if (e.target.id !== 'refreshExternal') return;
    cfg.external = e.target.checked; save(); paint();
  });
  document.addEventListener('click', () => { if (!$('refreshMenu').hidden) toggleMenu(false); });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && !$('refreshMenu').hidden) { toggleMenu(false); return; }
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName);
    if (!typing && !e.metaKey && !e.ctrlKey && !e.altKey && (e.key === 'r' || e.key === 'R') && !document.querySelector('.overlay:not([hidden])')) {
      e.preventDefault();
      refreshNow({ external: true, manual: true });
    }
  });
  // "Última atualização: há X" envelhece sozinho.
  setInterval(paint, 30000);

  window.Refresh = { refreshNow };
  schedule();
})();
