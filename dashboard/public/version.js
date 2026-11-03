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
  // Layout do design Espectro (artboard System · "Versão do Espectro"); CSS em screens/system.css.
  function render() {
    if (!data && !error && !loading) load(false);
    const root = el('section', null, 'version-view sys-page');
    const head = el('header', null, 'sys-head');
    head.append(el('span', 'Plataforma · versão', 'label'), el('h2', 'Versão', 't-display'), el('p', 'Revisão do Prisma em execução comparada com a origin/main.'));
    root.append(head);
    if (notice) {
      const box = el('div', null, `version-notice ${notice.ok ? 'ok' : 'fail'}`);
      box.setAttribute('role', 'status');
      const msg = el('p');
      msg.append(el('span', notice.ok ? '✓' : '✕', 'version-glyph'), ` ${notice.text}`);
      box.append(msg);
      if (notice.output) { const d = el('details'); d.append(el('summary', 'Saída do bump'), el('pre', notice.output)); box.append(d); }
      root.append(box);
    }
    const panel = el('section', null, 'panel sys-panel');
    panel.setAttribute('aria-labelledby', 'versionPanelTitle');
    const phead = el('div', null, 'sys-panel-head');
    const title = el('h3', 'Revisão em uso', 't-heading');
    title.id = 'versionPanelTitle';
    const refresh = el('button', loading ? 'Consultando…' : 'Consultar origin', 'btn');
    refresh.type = 'button'; refresh.disabled = loading || busy; refresh.addEventListener('click', () => load(true));
    phead.append(title, refresh); panel.append(phead); root.append(panel);
    if (error || !data) { panel.append(el('p', error || 'Carregando…', 'vempty')); return root; }
    if (data.status !== 'ok') { panel.append(el('p', data.message, 'vempty')); return root; }
    const behindN = `${data.behind.length}${data.behind_truncated ? '+' : ''}`;
    const grid = el('dl', null, 'version-grid');
    const row = (label, c, extra) => {
      const cell = el('div', null, 'version-cell');
      const dd = el('dd');
      if (c) {
        const sha = el('code', short(c.sha), 'version-sha');
        if (extra) sha.append(el('span', ` · ${extra}`, 'version-ahead'));
        dd.append(sha, el('span', c.subject, 'version-subject'));
        dd.title = `${c.sha} · ${new Date(c.date).toLocaleString('pt-BR')}`;
      } else dd.textContent = 'indisponível';
      cell.append(el('dt', label), dd); grid.append(cell);
    };
    row('Em execução', data.current);
    if (data.drift) row('Checkout em disco', data.checkout);
    row('origin/main', data.latest, data.behind.length ? `${behindN} à frente` : null);
    panel.append(grid);
    if (data.behind.length) {
      panel.append(el('h4', `${behindN} commit(s) atrás`, 'label version-list-title'));
      const list = el('ul', null, 'version-commits');
      for (const c of data.behind) { const li = el('li'); li.append(el('code', short(c.sha)), el('span', c.subject)); list.append(li); }
      panel.append(list);
    }
    const action = el('div', null, 'version-action');
    const button = el('button', busy ? 'Atualizando…' : `Atualizar para ${short(data.latest?.sha)}`, 'btn primary lg version-go');
    button.type = 'button'; button.disabled = busy || !data.update.enabled; button.addEventListener('click', update);
    action.append(button);
    if (!data.update.enabled && data.update.reason) action.append(el('span', data.update.reason, 'version-why'));
    if (data.behind.length || data.update.configured) panel.append(action);
    else panel.append(el('p', data.update.reason, 'version-why version-pad'));
    const foot = el('div', null, 'version-foot source-note');
    const fetchedAt = `Consultado em ${new Date(data.fetched_at).toLocaleString('pt-BR')}`;
    foot.append(el('p', data.fetch_error ? `${fetchedAt} — ${data.fetch_error}; mostrando a última origin/main conhecida.` : fetchedAt, data.fetch_error ? 'version-stale' : null));
    if (data.last_update) {
      const u = data.last_update;
      foot.append(el('p', `Última atualização: ${new Date(u.at).toLocaleString('pt-BR')} · ${short(u.from)} → ${short(u.to)} · ${u.ok ? 'ok' : `falhou (exit ${u.exit_code})`}`));
    }
    panel.append(foot);
    return root;
  }
  window.VersionView = { render, load };
  window.Views?.refresh();
})();
