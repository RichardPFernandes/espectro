// Tela Sistema (chave `versao`; artboard System): abas Watcher e Configuração e versão. A versão
// (revisão em execução vs origin/main e o botão de atualizar o pin) é carregada aqui; watcher e
// configuração vêm de watcher.js e config-health.js. Tudo renderizado como texto/DOM; o servidor
// decide se a atualização está liberada.
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
  // ---------------------------------------------------------------- tela Sistema (artboard System)
  // Abas Watcher e Configuração e versão. Watcher: estado de watcher.js (window.WatcherCtl, mesmo poll,
  // mesmo SSE e mesmos endpoints do rail). Configuração: relatório de config-health.js
  // (window.ConfigHealth). Versão: /api/version, acima. Regras de exibição em system-model.js;
  // CSS em screens/system.css. Botões com data-tfilter: Views.refresh devolve o foco depois de repintar.
  const M = () => window.SystemModel;
  const store = typeof prefs === 'object' && prefs ? prefs : {};
  const save = () => { try { if (typeof persist === 'function') persist(); } catch { /* sem prefs */ } };
  let tab = M()?.tabs(store.systemTab).id || 'watch';
  let kf = null, flash = '', liveRoot = null, logStick = true;

  const attr = (node, name, value) => { node.setAttribute(name, value); return node; };
  const focusKey = (node, key) => { node.dataset.tfilter = key; return node; };
  const button = (text, className, key, onClick) => {
    const b = el('button', text, className);
    b.type = 'button';
    if (key) focusKey(b, key);
    if (onClick) b.addEventListener('click', onClick);
    return b;
  };
  function setTab(id) {
    if (!id || id === tab) return;
    tab = id; store.systemTab = id; save(); flash = '';
    if (id === 'config') { const c = window.ConfigHealth?.snapshot(); if (c && !c.report && !c.loading) window.ConfigHealth.load(); }
    window.Views?.refresh();
  }
  function onKey(e) {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const tag = e.target?.tagName || '';
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    if (e.key === 'Escape') {
      const ctl = window.WatcherCtl, levels = ctl?.snapshot().levels || {};
      const hidden = Object.keys(levels).filter(l => levels[l] === false);
      if (notice || flash) { notice = null; flash = ''; }
      else if (kf || hidden.length) { kf = null; for (const l of hidden) ctl.setLevel(l, true); flash = 'Filtros limpos.'; }
      else if (tab !== 'watch') { setTab('watch'); e.preventDefault(); return; }
      else return;
      e.preventDefault(); window.Views?.refresh();
      return;
    }
    const next = M().tabForKey(e.key, tab);
    if (next) { e.preventDefault(); setTab(next); }
  }

  // Aviso no topo (artboard: toast com fechar). O resultado do Atualizar mantém tom e saída do bump.
  function toastBox() {
    const text = notice ? notice.text : flash;
    if (!text) return null;
    const box = attr(el('div', null, `sys-toast${notice && !notice.ok ? ' fail' : ''}`), 'role', 'status');
    const msg = el('span', null, 'sys-toast-text');
    if (notice) msg.append(el('span', notice.ok ? '✓ ' : '✕ ', 'version-glyph'));
    msg.append(text);
    if (notice?.output) { const d = el('details'); d.append(el('summary', 'Saída do bump'), el('pre', notice.output)); msg.append(d); }
    const close = attr(button('×', 'sys-toast-close', 'sys-toast-close', () => { notice = null; flash = ''; window.Views?.refresh(); }), 'aria-label', 'Fechar aviso');
    box.append(msg, close);
    return box;
  }

  function card(labelId, title, extra) {
    const sec = attr(el('section', null, 'sys-card'), 'aria-labelledby', labelId);
    const head = el('div', null, 'sys-card-head');
    const h = el('h2', title, 'sys-card-title'); h.id = labelId;
    head.append(h);
    if (extra) head.append(extra);
    sec.append(head);
    return sec;
  }

  // ---------------------------------------------------------------- aba Watcher
  function liveState() {
    const snap = window.WatcherCtl?.snapshot() || { st: null, reachable: true, busy: null, lines: [], clearedSeq: 0, levels: {} };
    const st = snap.st && snap.st.uptime_ms != null && snap.polledAt ? { ...snap.st, uptime_ms: snap.st.uptime_ms + (Date.now() - snap.polledAt) } : snap.st;
    const ctl = !!window.WatcherCtl;
    return { snap, ctl, w: M().watcher(st, { reachable: ctl && snap.reachable, busy: snap.busy }, Date.now()) };
  }
  function cycleNodes(c) {
    const wrap = el('div', null, 'sys-cycle');
    const track = attr(attr(el('span', null, 'sys-cycle-track'), 'role', 'img'), 'aria-label', c.aria);
    const fill = el('span', null, 'sys-cycle-fill');
    fill.dataset.tone = c.tone; fill.style && (fill.style.width = c.pct);
    track.append(fill);
    const legend = el('span', null, 'sys-cycle-legend');
    legend.append(el('span', c.left), el('span', c.right));
    wrap.append(el('span', 'Ciclo do tick', 'sys-k'), track, legend);
    return wrap;
  }
  function watcherTab() {
    const { snap, ctl, w } = liveState();
    const out = [];
    if (w.crash) {
      const a = attr(el('div', null, 'sys-alert'), 'role', 'status');
      const txt = el('span');
      txt.append(el('strong', w.crash), ' O watcher espera um Start manual; runs em andamento continuam, nenhum novo despacho sai.');
      a.append(attr(el('span', '✕'), 'aria-hidden', 'true'), txt);
      out.push(a);
    }
    const grid = el('div', null, 'sys-grid');
    const sec = attr(el('section', null, 'sys-card sys-watcher'), 'aria-labelledby', 'sysWatcherTitle');
    sec.dataset.tone = w.tone;
    const head = el('div', null, 'sys-card-head sys-w-head');
    const who = el('div', null, 'sys-w-who');
    const names = el('div', null, 'sys-w-names');
    const h = el('h2', `Watcher · ${w.label}`, 'sys-card-title'); h.id = 'sysWatcherTitle';
    const sub = el('span', w.sub, 'sys-mono sys-w-sub'); sub.dataset.sysLive = 'sub';
    names.append(h, sub);
    who.append(attr(el('span', null, 'sys-dot'), 'aria-hidden', 'true'), names);
    const acts = el('div', null, 'sys-w-actions');
    const act = a => () => window.WatcherCtl?.act(a);
    const start = button('▶ Start', 'sys-btn sys-go', 'sys-w-start', act('start')); start.disabled = w.startDisabled;
    const stop = button('■ Stop', 'sys-btn sys-halt', 'sys-w-stop', act('stop')); stop.disabled = w.stopDisabled;
    const restart = button('↻ Restart', 'sys-btn', 'sys-w-restart', act('restart')); restart.disabled = w.restartDisabled;
    acts.append(start, stop, restart);
    head.append(who, acts);
    sec.append(head);
    const facts = el('dl', null, 'sys-facts');
    for (const f of w.facts) {
      const cell = el('div'); cell.title = `Fonte: ${f.source}`;
      cell.append(el('dt', f.k, 'sys-k'), el('dd', f.v, 'sys-mono sys-v'));
      facts.append(cell);
    }
    sec.append(facts);
    const cyc = cycleNodes(w.cycle); cyc.dataset.sysLive = 'cycle';
    sec.append(cyc);

    const bar = el('div', null, 'sys-logbar');
    const levels = attr(el('div', null, 'sys-levels'), 'role', 'group');
    levels.setAttribute('aria-label', 'Filtrar log');
    for (const l of window.WatcherCtl?.LEVELS || ['INFO', 'WARN', 'ERROR']) {
      const on = snap.levels[l] !== false;
      // Lê o valor vivo no clique: dois cliques antes do repaint não gravam o mesmo valor.
      const b = attr(button(l, 'sys-level', `sys-level-${l}`, () => { const ctl = window.WatcherCtl; if (ctl) ctl.setLevel(l, ctl.snapshot().levels[l] === false); }), 'aria-pressed', String(on));
      b.dataset.level = l; b.disabled = !ctl;
      levels.append(b);
    }
    const right = el('span', null, 'sys-logbar-right');
    const auto = el('label', null, 'sys-auto');
    // Sem data-tfilter: o listener de change de views.js trata esse atributo como filtro da Tabela.
    const box = el('input');
    box.type = 'checkbox'; box.checked = !!snap.autoStart; box.disabled = !ctl || snap.autoStart == null;
    box.addEventListener('change', () => window.WatcherCtl?.setAuto(box.checked));
    auto.append(box, 'Iniciar com o dashboard');
    const cleared = snap.clearedSeq > 0;
    const clear = button(cleared ? 'Mostrar log' : 'Limpar', 'sys-linkbtn', 'sys-log-clear', () => window.WatcherCtl?.clearLog(!cleared));
    clear.disabled = !ctl;
    right.append(auto, clear);
    bar.append(levels, right);
    sec.append(bar);

    const log = attr(el('div', null, 'sys-log'), 'aria-label', 'Log do watcher');
    log.tabIndex = 0;
    const shown = M().logLines(snap.lines, snap.levels, snap.clearedSeq);
    for (const e of shown) log.append(logRow(e));
    if (!shown.length) log.append(attr(el('p', w.known ? M().logEmpty(snap.lines, shown, cleared) : `${M().UNKNOWN} · log indisponível sem leitura do watcher.`, 'sys-log-empty'), 'role', 'status'));
    sec.append(log);
    const note = el('p', null, 'sys-card-foot');
    const runs = el('a', 'Runs'); runs.href = '#runs';
    runs.addEventListener('click', ev => { ev.preventDefault?.(); window.Views?.setView('runs'); });
    note.append(w.note, runs, '.');
    sec.append(note);
    grid.append(sec);
    out.push(grid);
    return out;
  }

  function logRow(e) {
    const row = el('div', null, `sys-logrow${e.source === 'manager' ? ' mgr' : ''}`);
    row.dataset.level = e.level;
    row.append(el('span', new Date(e.ts).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' }), 'sys-log-t'),
      el('span', e.level, 'sys-log-l'), el('span', e.text, 'sys-log-x'));
    return row;
  }
  // Linha nova do SSE (watcher.js) entra no lugar, sem repintar a tela: seleção, foco e scroll ficam.
  const MAX_LOG_ROWS = 1000;
  function appendLog(e) {
    if (!liveRoot || tab !== 'watch') return;
    const snap = window.WatcherCtl?.snapshot();
    if (!snap || snap.levels[e.level] === false || e.seq <= snap.clearedSeq) return;
    const log = liveRoot.querySelector?.('.sys-log');
    if (!log) return;
    const stick = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
    log.querySelector('.sys-log-empty')?.remove();
    log.append(logRow(e));
    while (log.childElementCount > MAX_LOG_ROWS) log.firstElementChild.remove();
    if (stick) log.scrollTop = log.scrollHeight;
  }

  // Uptime, fase e "próximo em N s" andam a cada segundo sem repintar a tela (foco e scroll ficam).
  function paintLive() {
    if (!liveRoot || tab !== 'watch' || window.Views?.current?.() !== 'versao') return;
    const { w } = liveState();
    const sub = liveRoot.querySelector?.('[data-sys-live="sub"]');
    if (sub) sub.textContent = w.sub;
    const cyc = liveRoot.querySelector?.('[data-sys-live="cycle"]');
    if (!cyc) return;
    const fill = cyc.querySelector('.sys-cycle-fill'), track = cyc.querySelector('.sys-cycle-track'), legend = cyc.querySelectorAll('.sys-cycle-legend > span');
    fill.dataset.tone = w.cycle.tone; fill.style.width = w.cycle.pct;
    track.setAttribute('aria-label', w.cycle.aria);
    if (legend.length === 2) { legend[0].textContent = w.cycle.left; legend[1].textContent = w.cycle.right; }
  }
  // J/K e Esc valem na tela inteira (foco no menu ou no body também), não só dentro dela.
  // Dígitos ficam com o atalho global (ux.js, capture), que troca de tela.
  if (typeof document.addEventListener === 'function') document.addEventListener('keydown', e => {
    if (window.Views?.current?.() !== 'versao' || e.defaultPrevented) return;
    if (document.querySelector?.('.overlay:not([hidden]), .wctl-panel:not([hidden])')) return;
    onKey(e);
  });
  if (typeof setInterval === 'function') setInterval(() => { if (typeof document.hidden === 'undefined' || !document.hidden) paintLive(); }, 1000);

  // ---------------------------------------------------------------- aba Configuração e versão
  function configCard() {
    const snap = window.ConfigHealth?.snapshot() || { report: null, err: null, loading: false };
    const c = M().config(snap.report, kf, Date.now());
    if (c.known && c.filter !== kf) kf = c.filter;
    const meta = el('span', c.known ? c.meta : '', 'sys-mono sys-meta');
    const sec = card('sysCfgTitle', 'Saúde da configuração', meta);
    sec.dataset.tone = c.known ? c.tone : 'unknown';
    if (!c.known) {
      const text = snap.err ? `${M().UNKNOWN} · validação indisponível: ${snap.err}` : window.ConfigHealth ? 'Validando configuração…' : `${M().UNKNOWN} · validação indisponível.`;
      sec.append(attr(el('p', text, 'sys-empty'), 'role', 'status'));
    } else {
      const row = el('div', null, 'sys-kcards');
      for (const k of c.cards) {
        const b = attr(button(null, 'sys-kc', `sys-kc-${k.id}`, () => { kf = kf === k.id ? null : k.id; window.Views?.refresh(); }), 'aria-pressed', String(k.pressed));
        b.title = `Mostrar só: ${k.label} · Fonte: ${k.source}`;
        b.dataset.tone = k.tone;
        b.append(el('span', String(k.value), 'sys-kc-v'), el('span', k.label, 'sys-kc-l'), el('span', k.hint, 'sys-kc-h'));
        row.append(b);
      }
      sec.append(row);
      if (c.filter && window.UIKit) {
        const chip = el('div', null, 'sys-chip');
        chip.innerHTML = window.UIKit.filterChip({ label: c.filterLabel });
        chip.addEventListener('click', ev => { if (ev.target.closest?.('[data-act="clear-kcard"]')) { kf = null; window.Views?.refresh(); } });
        sec.append(chip);
      }
      const list = el('ul', null, 'sys-rules');
      for (const r of c.rules) {
        const li = el('li'); li.dataset.tone = r.tone;
        const txt = el('span', null, 'sys-rule-txt');
        txt.append(el('span', r.rule, 'sys-mono sys-rule'), el('span', r.msg, 'sys-rule-msg'));
        li.append(attr(el('span', null, 'sys-dot'), 'aria-hidden', 'true'), txt);
        list.append(li);
      }
      if (!c.rules.length) list.append(el('li', 'Nenhum item para este filtro.', 'sys-rules-empty'));
      sec.append(list);
    }
    sec.append(el('p', 'Somente leitura: o painel nunca corrige a configuração sozinho.', 'sys-card-foot'));
    return sec;
  }

  function versionCard() {
    const refresh = button(loading ? 'Consultando…' : 'Consultar origin', 'sys-btn sys-btn-quiet', 'sys-origin', () => load(true));
    refresh.disabled = loading || busy;
    const sec = card('versionPanelTitle', 'Versão do Espectro', refresh);
    sec.classList.add('version-view');
    if (error || !data) { sec.append(el('p', error || 'Carregando…', 'sys-empty vempty')); return sec; }
    if (data.status !== 'ok') { sec.append(el('p', data.message || `${M().UNKNOWN} · versão indisponível.`, 'sys-empty vempty')); return sec; }
    const behindN = `${data.behind.length}${data.behind_truncated ? '+' : ''}`;
    const grid = el('dl', null, 'version-grid');
    const row = (label, c, extra) => {
      const cell = el('div', null, 'version-cell');
      cell.title = `Fonte: ${M().VERSION_SRC}`;
      const dd = el('dd');
      const sha = el('code', M().short(c?.sha), 'version-sha');
      if (extra) sha.append(el('span', ` · ${extra}`, 'version-ahead'));
      dd.append(sha);
      if (c?.subject) dd.append(el('span', c.subject, 'version-subject'));
      if (c?.sha) dd.title = `${c.sha}${c.date ? ` · ${new Date(c.date).toLocaleString('pt-BR')}` : ''}`;
      cell.append(el('dt', label), dd); grid.append(cell);
    };
    row('Em execução', data.current);
    if (data.drift) row('Checkout em disco', data.checkout);
    row('origin/main', data.latest, data.behind.length ? `${behindN} à frente` : null);
    sec.append(grid);
    if (data.behind.length) {
      const list = attr(el('ul', null, 'version-commits'), 'aria-label', `${behindN} commit(s) na origin/main que a revisão em execução não tem`);
      for (const c of data.behind) {
        const li = el('li');
        li.append(el('code', M().short(c.sha)), el('span', c.subject), el('span', M().ago(c.date, Date.now()) || '—', 'version-when'));
        list.append(li);
      }
      sec.append(list);
    }
    const action = el('div', null, 'version-action');
    const go = button(busy ? 'Atualizando…' : `Atualizar para ${M().short(data.latest?.sha)}`, 'version-go', 'sys-update', update);
    go.disabled = busy || !data.update.enabled;
    action.append(go);
    if (!data.update.enabled && data.update.reason) action.append(el('span', data.update.reason, 'version-why'));
    if (data.behind.length || data.update.configured) sec.append(action);
    else sec.append(el('p', data.update.reason, 'version-why version-pad'));
    const foot = el('div', null, 'version-foot');
    const fetchedAt = `Consultado em ${new Date(data.fetched_at).toLocaleString('pt-BR')}`;
    foot.append(el('p', data.fetch_error ? `${fetchedAt} — ${data.fetch_error}; mostrando a última origin/main conhecida.` : fetchedAt, data.fetch_error ? 'version-stale' : null));
    if (data.last_update) {
      const u = data.last_update;
      foot.append(el('p', `Última atualização: ${new Date(u.at).toLocaleString('pt-BR')} · ${M().short(u.from)} → ${M().short(u.to)} · ${u.ok ? 'ok' : `falhou (exit ${u.exit_code})`}`));
    }
    sec.append(foot);
    return sec;
  }

  function render() {
    if (!data && !error && !loading) load(false);
    if (!M()) return null;
    const prevLog = liveRoot?.querySelector?.('.sys-log');
    if (prevLog && prevLog.scrollHeight) logStick = prevLog.scrollHeight - prevLog.scrollTop - prevLog.clientHeight < 40;
    const prevScroll = prevLog?.scrollTop;
    const root = attr(el('section', null, 'sys-page'), 'aria-label', 'Sistema. J e K percorrem as abas, Esc fecha o aviso ou limpa o filtro.');
    const t = toastBox();
    if (t) root.append(t);
    const head = el('header', null, 'sys-head');
    head.append(el('span', 'Plataforma · watcher e configuração', 'sys-eyebrow'), el('h1', 'Sistema', 'sys-title'),
      el('p', 'O processo que move os runs, a configuração do fluxo e a versão do Espectro em uso.'));
    root.append(head);
    const cfg = M().config(window.ConfigHealth?.snapshot().report, null);
    const tb = M().tabs(tab, cfg.tabCount);
    tab = tb.id;
    const bar = el('div', null, 'sys-bar');
    const list = attr(el('div', null, 'sys-tabs'), 'role', 'tablist');
    list.setAttribute('aria-label', 'Partes do sistema');
    for (const x of tb.list) {
      const b = attr(attr(button(null, 'sys-tab', `sys-tab-${x.id}`, () => setTab(x.id)), 'role', 'tab'), 'aria-selected', String(x.selected));
      b.tabIndex = x.selected ? 0 : -1;
      // O artboard mostra "1"/"2", mas os dígitos trocam de tela no app (ux.js); a aba só mostra o nome.
      b.append(x.label);
      if (x.count) b.append(el('span', x.count, 'sys-tab-count'));
      list.append(b);
    }
    bar.append(list, el('span', tb.pos, 'sys-mono sys-tabpos'));
    root.append(bar);
    if (tab === 'watch') root.append(...watcherTab());
    else {
      const grid = el('div', null, 'sys-grid');
      const col = el('div', null, 'sys-col');
      col.append(configCard(), versionCard());
      grid.append(col);
      root.append(grid);
    }
    liveRoot = root;
    // Log grudado no fim (como o painel do rail), a menos que a pessoa tenha rolado para cima.
    Promise.resolve().then(() => {
      const log = root.querySelector?.('.sys-log');
      if (log) log.scrollTop = logStick ? log.scrollHeight : (prevScroll ?? log.scrollHeight);
    });
    return root;
  }
  window.VersionView = { render, load };
  window.SystemView = { appendLog };
  window.Views?.refresh();
})();
