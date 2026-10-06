// Barra de status do PROCESSO watcher, logo abaixo do topo — a única superfície do
// dashboard que reflete o watcher em si em vez de runs individuais. Dados de
// GET /api/watcher/health (= `readmine-watcher.js --health-check`, só leitura),
// atualizados a cada 30s; o "em Xs" da próxima poll anda a cada segundo, sem refetch.
// Script clássico; usa os globais do script principal (api, esc, NODE_LABEL, $).
(() => {
  const POLL_MS = 30000;
  let h = null, err = null;

  document.querySelector('header.topbar').insertAdjacentHTML('afterend',
    '<div class="whb" id="whb" role="status" aria-live="polite" data-tone="idle"><i aria-hidden="true"></i><span class="whb-main">Watcher: verificando…</span></div>');
  const bar = $('whb');

  function dur(sec) {
    if (!sec) return '0s';
    const m = Math.floor(sec / 60), hh = Math.floor(m / 60), d = Math.floor(hh / 24);
    if (d) return `${d}d ${hh % 24}h`;
    if (hh) return `${hh}h ${String(m % 60).padStart(2, '0')}m`;
    return m ? `${m}m` : `${sec}s`;
  }
  const hms = iso => new Date(iso).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  function until(iso) {
    const s = Math.round((Date.parse(iso) - Date.now()) / 1000);
    return s > 0 ? `em ${s < 60 ? `${s}s` : dur(s)}` : 'agora';
  }
  const node = n => (n && NODE_LABEL[n]) || n || '—';
  const task = t => (t ? String(t).split('-')[0] : '—');

  function paint() {
    if (err) {
      bar.dataset.tone = 'off';
      bar.innerHTML = `<i aria-hidden="true"></i><span class="whb-main">Watcher: health-check indisponível</span><span class="whb-item">${esc(err)}</span>`;
      return;
    }
    if (!h) return;
    const tone = !h.healthy ? 'off' : h.status === 'running' ? 'on' : 'idle';
    bar.dataset.tone = tone;
    const items = [];
    items.push(`<span class="whb-item">Uptime <b>${esc(dur(h.uptimeSeconds))}</b></span>`);
    items.push(`<span class="whb-item">Próxima poll <b>${h.nextPollAt ? `${esc(hms(h.nextPollAt))} <span data-until="${esc(h.nextPollAt)}">(${esc(until(h.nextPollAt))})</span>` : '—'}</b></span>`);
    if (h.activeCycle) {
      const since = h.activeCycle.startedAt ? ` desde ${esc(hms(h.activeCycle.startedAt))}` : '';
      const who = h.activeCycle.source === 'agent' ? ' (agente destacado)' : '';
      items.push(`<span class="whb-item">Ciclo <b>#${esc(task(h.activeCycle.taskId))} · ${esc(node(h.activeCycle.node))}</b>${since}${who}</span>`);
    }
    if (h.lastCompletedCycle) {
      const l = h.lastCompletedCycle;
      items.push(`<span class="whb-item whb-last${l.status === 'interrupted' ? ' int' : ''}">Último <b>#${esc(task(l.taskId))} · ${esc(l.status || '—')}</b>${l.completedAt ? ` ${esc(hms(l.completedAt))}` : ''}</span>`);
    }
    const issues = (h.issues || []).length
      ? `<span class="whb-issues" title="${esc(h.issues.join('\n'))}">⚠ Estado inconsistente: ${esc(h.issues[0])}${h.issues.length > 1 ? ` (+${h.issues.length - 1})` : ''}</span>` : '';
    bar.innerHTML = `<i aria-hidden="true"></i><span class="whb-main">Watcher <b>${esc(h.status)}</b></span>${items.join('')}${issues}`;
  }

  async function load() {
    try { h = await api('/api/watcher/health'); err = null; } catch (e) { err = e.message; }
    paint();
  }

  setInterval(() => {
    for (const el of bar.querySelectorAll('[data-until]')) el.textContent = `(${until(el.dataset.until)})`;
  }, 1000);
  setInterval(() => { if (!document.hidden) load(); }, POLL_MS);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) load(); });
  load();

  const style = document.createElement('style');
  style.textContent = `
    body { grid-template-rows: auto auto minmax(0, 1fr); }
    .whb { display: flex; align-items: center; flex-wrap: wrap; gap: 6px 18px; padding: 6px 24px; min-width: 0;
      background: var(--sunken); border-bottom: 1px solid var(--line); font-size: 13px; color: var(--muted); font-variant-numeric: tabular-nums; }
    .whb i { flex: none; width: 8px; height: 8px; border-radius: 50%; background: var(--idle); }
    .whb[data-tone="on"] i { background: var(--clear); box-shadow: 0 0 0 3px var(--clear-bg); }
    .whb[data-tone="off"] i { background: var(--stop); box-shadow: 0 0 0 3px var(--stop-bg); }
    .whb b { color: var(--ink-2); font-weight: 600; }
    .whb-main { margin-left: -10px; color: var(--ink-2); }
    .whb-last.int b { color: var(--attention); }
    .whb-issues { color: var(--stop); font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 100%; }
    @media (max-width: 820px) { .whb { padding: 6px 16px; gap: 4px 12px; } }
  `;
  document.head.appendChild(style);
  window.WatcherHealth = { load };
})();
