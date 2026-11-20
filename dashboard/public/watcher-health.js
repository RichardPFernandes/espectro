// Saúde do PROCESSO watcher, no pé do rail (#navFoot, abaixo do cartão do watcher) — a única superfície do
// dashboard que reflete o watcher em si em vez de runs individuais. Dados de
// GET /api/watcher/health (= `readmine-watcher.js --health-check`, só leitura),
// atualizados a cada 30s; o "em Xs" da próxima poll anda a cada segundo, sem refetch.
// Script clássico; usa os globais do script principal (api, esc, NODE_LABEL, $).
(() => {
  const POLL_MS = 30000;
  let h = null, err = null;

  // Lista compacta (uma linha por fato) no pé do rail; CSS em screens/system.css.
  $('navFoot').insertAdjacentHTML('beforeend',
    '<div class="whb" id="whb" role="status" aria-live="polite" data-tone="idle"><span class="whb-main"><i aria-hidden="true"></i>Watcher: verificando…</span></div>');
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
      bar.innerHTML = `<span class="whb-main"><i aria-hidden="true"></i>Watcher: health-check indisponível</span><span class="whb-item" title="${esc(err)}">${esc(err)}</span>`;
      return;
    }
    if (!h) return;
    const tone = !h.healthy ? 'off' : h.status === 'running' ? 'on' : 'idle';
    bar.dataset.tone = tone;
    const items = [];
    items.push(`<span class="whb-item">Uptime <b>${h.uptimeSeconds == null || (!h.uptimeSeconds && h.status !== 'running') ? '—' : esc(dur(h.uptimeSeconds))}</b></span>`);
    items.push(`<span class="whb-item">Próxima poll <b>${h.nextPollAt ? `${esc(hms(h.nextPollAt))} <span data-until="${esc(h.nextPollAt)}" aria-hidden="true">(${esc(until(h.nextPollAt))})</span>` : '—'}</b></span>`);
    if (h.activeCycle) {
      const since = h.activeCycle.startedAt ? ` desde ${esc(hms(h.activeCycle.startedAt))}` : '';
      const who = h.activeCycle.source === 'agent' ? ' (agente destacado)' : '';
      items.push(`<span class="whb-item" title="#${esc(h.activeCycle.taskId || '—')} · ${esc(node(h.activeCycle.node))}">Ciclo <b>#${esc(task(h.activeCycle.taskId))} · ${esc(node(h.activeCycle.node))}</b>${since}${who}</span>`);
    }
    if (h.lastCompletedCycle) {
      const l = h.lastCompletedCycle;
      items.push(`<span class="whb-item whb-last${l.status === 'interrupted' ? ' int' : ''}">Último <b>#${esc(task(l.taskId))} · ${esc(l.status || '—')}</b>${l.completedAt ? ` ${esc(hms(l.completedAt))}` : ''}</span>`);
    }
    const issues = (h.issues || []).length
      ? `<span class="whb-issues" title="${esc(h.issues.join('\n'))}"><span aria-hidden="true">⚠</span> Estado inconsistente: ${esc(h.issues[0])}${h.issues.length > 1 ? ` (+${h.issues.length - 1})` : ''}</span>` : '';
    bar.innerHTML = `<span class="whb-main"><i aria-hidden="true"></i><span class="label">Health-check</span> <b>${esc(h.status)}</b></span>${items.join('')}${issues}`;
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

  window.WatcherHealth = { load };
})();
