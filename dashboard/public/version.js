// Painel Versão: revisão do Prisma em execução vs origin/main e botão de atualizar o pin.
// Tudo renderizado como texto/DOM; o servidor decide se a atualização está liberada.
(() => {
  let data, error, loading = false, busy = false, notice = null;
  const el = (tag, text, className) => {
    const node = document.createElement(tag);
    if (text != null) node.textContent = text;
    if (className) node.className = className;
    return node;
  };
  const short = sha => (sha || '').slice(0, 7);
  async function load(force) {
    if (loading) return;
    loading = true;
    window.Views?.refresh();
    try { data = await api(`/api/version${force ? '?refresh=1' : ''}`); error = null; }
    catch { data = null; error = 'Não foi possível carregar a versão. Confira a conexão com o dashboard.'; }
    finally { loading = false; window.Views?.refresh(); }
  }
  // Depois do reinício o servidor some por alguns segundos; espera voltar já na revisão nova.
  async function waitRestart(target, log, oldPid) {
    const deadline = Date.now() + 90000;
    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 2000));
      try {
        const v = await api('/api/version');
        if (v.current?.sha === target && v.pid !== oldPid) { data = v; notice = { ok: true, text: `Dashboard reiniciado em ${short(target)}.` }; busy = false; window.Views?.refresh(); return; }
      } catch { /* ainda reiniciando */ }
    }
    busy = false;
    notice = { ok: false, text: `O dashboard não voltou em ${short(target)} em 90 s. Veja ${log || 'o log de reinício'} e suba manualmente.` };
    window.Views?.refresh();
  }
  async function update() {
    const target = data?.latest?.sha;
    if (!target || busy) return;
    const restartNote = data.update.restart ? ' O dashboard vai reiniciar.' : ' Será preciso reiniciar o dashboard manualmente.';
    if (!confirm(`Atualizar o Prisma de ${short(data.current.sha)} para ${short(target)} (${data.behind.length}${data.behind_truncated ? '+' : ''} commit(s))?${restartNote}`)) return;
    busy = true; notice = null; window.Views?.refresh();
    try {
      const res = await fetch('/api/version/update', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ target }) });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        busy = false;
        notice = { ok: false, text: body.error || `HTTP ${res.status}`, output: body.update?.output };
        await load(false);
        return;
      }
      if (body.restarting) {
        notice = { ok: true, text: `Pin atualizado para ${short(target)}. Reiniciando o dashboard…`, output: body.update?.output };
        window.Views?.refresh();
        return waitRestart(target, body.restart_log, data.pid);
      }
      busy = false;
      notice = { ok: true, text: `Pin atualizado para ${short(target)}. ${body.update?.warning || 'Reinicie o dashboard para rodar a revisão nova.'}`, output: body.update?.output };
      await load(false);
    } catch {
      busy = false;
      notice = { ok: false, text: 'Falha de conexão durante a atualização; confira o estado antes de tentar de novo.' };
      window.Views?.refresh();
    }
  }
  function render() {
    if (!data && !error && !loading) load(false);
    const root = el('section', null, 'version-view');
    const head = el('div', null, 'vhead');
    head.append(el('h2', 'Versão'), el('p', 'Revisão do Prisma em execução comparada com a origin/main.'));
    const refresh = el('button', loading ? 'Consultando…' : 'Consultar origin', 'ghost-btn');
    refresh.type = 'button'; refresh.disabled = loading || busy; refresh.addEventListener('click', () => load(true));
    head.append(refresh); root.append(head);
    if (notice) {
      const box = el('div', null, `version-notice ${notice.ok ? 'ok' : 'fail'}`);
      box.setAttribute('role', 'status');
      box.append(el('p', notice.text));
      if (notice.output) { const d = el('details'); d.append(el('summary', 'Saída do bump'), el('pre', notice.output)); box.append(d); }
      root.append(box);
    }
    if (error || !data) { root.append(el('p', error || 'Carregando…', 'vempty')); return root; }
    if (data.status !== 'ok') { root.append(el('p', data.message, 'vempty')); return root; }
    const grid = el('dl', null, 'version-grid');
    const row = (label, c) => { grid.append(el('dt', label)); const dd = el('dd'); if (c) { dd.append(el('code', short(c.sha)), ` ${c.subject}`); dd.title = `${c.sha} · ${new Date(c.date).toLocaleString('pt-BR')}`; } else dd.textContent = 'indisponível'; grid.append(dd); };
    row('Em execução', data.current);
    if (data.drift) row('Checkout em disco', data.checkout);
    row('origin/main', data.latest);
    root.append(grid);
    const fetchedAt = `Consultado em ${new Date(data.fetched_at).toLocaleString('pt-BR')}`;
    root.append(el('p', data.fetch_error ? `${fetchedAt} — ${data.fetch_error}; mostrando a última origin/main conhecida.` : fetchedAt, 'muted'));
    const action = el('div', null, 'version-action');
    const button = el('button', busy ? 'Atualizando…' : `Atualizar para ${short(data.latest?.sha)}`, 'ghost-btn version-go');
    button.type = 'button'; button.disabled = busy || !data.update.enabled; button.addEventListener('click', update);
    action.append(button);
    if (!data.update.enabled && data.update.reason) action.append(el('span', data.update.reason, 'muted'));
    if (data.behind.length || data.update.configured) root.append(action);
    else root.append(el('p', data.update.reason, 'muted'));
    if (data.behind.length) {
      root.append(el('h3', `${data.behind.length}${data.behind_truncated ? '+' : ''} commit(s) atrás`));
      const list = el('ul', null, 'version-commits');
      for (const c of data.behind) { const li = el('li'); li.append(el('code', short(c.sha)), ` ${c.subject}`); list.append(li); }
      root.append(list);
    }
    if (data.last_update) {
      const u = data.last_update;
      root.append(el('p', `Última atualização: ${new Date(u.at).toLocaleString('pt-BR')} · ${short(u.from)} → ${short(u.to)} · ${u.ok ? 'ok' : `falhou (exit ${u.exit_code})`}`, 'muted'));
    }
    return root;
  }
  const style = el('style');
  style.textContent = `
    .version-view .vhead > button { justify-self:start; }
    .version-grid { display:grid; grid-template-columns:max-content 1fr; gap:6px 16px; margin:16px 0 4px; }
    .version-grid dt { color:var(--muted); }
    .version-grid dd { margin:0; overflow-wrap:anywhere; }
    .version-action { display:flex; flex-wrap:wrap; align-items:center; gap:8px 16px; margin:16px 0; }
    .version-commits { list-style:none; padding:0; margin:8px 0; display:grid; gap:4px; font-size:13.5px; }
    .version-commits li { overflow-wrap:anywhere; }
    .version-view code { font-size:12.5px; color:var(--ink-2); }
    .version-notice { border-radius:6px; padding:10px 14px; margin:12px 0; }
    .version-notice p { margin:0; }
    .version-notice.ok { background:var(--clear-bg); color:var(--clear); }
    .version-notice.fail { background:var(--stop-bg); color:var(--stop); }
    .version-notice pre { white-space:pre-wrap; max-height:240px; overflow:auto; color:var(--ink-2); }
    .version-go:not(:disabled) { background:var(--signal); border-color:var(--signal); color:#fff; }
    .version-go:disabled { cursor:not-allowed; opacity:.6; }
    .version-view button:focus-visible { outline:2px solid var(--signal); outline-offset:3px; }
  `;
  document.head.append(style);
  window.VersionView = { render, load };
  window.Views?.refresh();
})();
