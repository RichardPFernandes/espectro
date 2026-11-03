// Painel de controle do watcher (scripts/watcher-manager.js via /api/watcher/*):
// indicador no pé do rail (#navFoot), Start/Stop/Restart, log em tempo real (SSE) com filtro por nível,
// task em andamento e auto-start. Script clássico carregado por último; usa os globais
// do script principal (runs, NODE_LABEL, titleOf, esc, api, toast, select, prefs,
// persist, nearBottom, Views, $).
(() => {
  const POLL_MS = 5000;
  const MAX_LINES = 1000;
  const LEVELS = ['INFO', 'WARN', 'ERROR'];
  prefs.watcherLevels ||= { INFO: true, WARN: true, ERROR: true };

  let st = null;          // último /api/watcher/status
  let reachable = true;
  let busy = null;        // 'start' | 'stop' | 'restart' enquanto a chamada não volta
  let autoStart = null;
  const lines = [];
  let lastSeq = 0;
  let clearedSeq = 0;     // "Limpar" só esconde localmente o que veio até aqui
  let instance = null;

  // ------------------------------------------------------------------ formatação
  function dur(ms) {
    if (ms == null) return '';
    const s = Math.floor(ms / 1000);
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60), h = Math.floor(m / 60), d = Math.floor(h / 24);
    if (d) return `${d}d ${h % 24}h`;
    return h ? `${h}h ${String(m % 60).padStart(2, '0')}m` : `${m}m`;
  }
  const hhmm = iso => new Date(iso).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  const hhmmss = iso => new Date(iso).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

  function tone() {
    if (!reachable || !st) return 'idle';
    if (busy || st.state === 'restarting' || st.state === 'stopping') return 'warn';
    if (st.running) return 'on';
    return 'off';
  }
  function label() {
    if (!reachable) return 'Watcher: sem conexão com o dashboard';
    if (!st) return 'Watcher: verificando…';
    if (busy === 'start' || busy === 'restart') return 'Watcher: iniciando…';
    if (busy === 'stop' || st.state === 'stopping') return 'Watcher: parando…';
    if (st.state === 'restarting') return `Watcher: reiniciando (tentativa ${st.restarts_last_hour}/${st.max_restarts_per_hour})`;
    if (st.running) return `Watcher: ativo há ${dur(st.uptime_ms)}`;
    if (st.error === 'restart_limit_reached') return 'Watcher: parado (limite de restarts atingido — verificar logs)';
    return 'Watcher: parado';
  }

  // Run que o watcher está tocando agora: status running (in_progress/running no
  // state.json); com mais de um, o mais recente.
  function currentRun() {
    let best = null;
    for (const r of runs.values()) {
      if (r.status !== 'running' || r.archived) continue;
      if (!best || (Date.parse(r.updatedAt) || 0) > (Date.parse(best.updatedAt) || 0)) best = r;
    }
    return best;
  }

  // ------------------------------------------------------------------ UI
  // Cartão "Watcher ativo · tick N · próximo em X s" no pé do rail (AppNav do design);
  // o painel abre ao lado do rail. CSS em screens/system.css.
  $('navFoot').insertAdjacentHTML('beforeend', `
    <div class="wctl" id="wctl" data-tone="idle">
      <button type="button" class="wctl-chip" id="wctlChip" aria-expanded="false" aria-controls="wctlPanel">
        <span class="wctl-chip-row"><i aria-hidden="true"></i><span class="wctl-short" id="wctlShort" aria-hidden="true">Watcher</span></span>
        <span class="sys-sr" id="wctlText">Watcher: verificando…</span>
        <span class="wctl-sub" id="wctlSub"></span>
      </button>
      <section class="wctl-panel" id="wctlPanel" hidden aria-label="Controle do Watcher">
        <div class="wctl-head">
          <span class="wctl-title"><i aria-hidden="true"></i><span class="wctl-title-text"><b>Watcher</b><span class="wctl-state" id="wctlState"></span></span></span>
          <div class="wctl-actions">
            <button type="button" class="btn wctl-go" data-wact="start"><span aria-hidden="true">▶</span> Start</button>
            <button type="button" class="btn wctl-halt" data-wact="stop"><span aria-hidden="true">■</span> Stop</button>
            <button type="button" class="btn" data-wact="restart"><span aria-hidden="true">↻</span> Restart</button>
          </div>
        </div>
        <dl class="wctl-facts" id="wctlFacts"></dl>
        <div class="wctl-alert" id="wctlAlert" hidden></div>
        <div class="wctl-task" id="wctlTask" hidden></div>
        <p class="wctl-meta wctl-last" id="wctlLast" hidden></p>
        <div class="wctl-settings" aria-labelledby="wctlSettingsTitle">
          <span class="wctl-settings-title label" id="wctlSettingsTitle">Configurações</span>
          <label class="wctl-auto"><input type="checkbox" id="wctlAuto"> Iniciar automaticamente quando o dashboard subir</label>
          <div class="wctl-notify">
            <label class="wctl-notify-label" for="wctlAccount">Conta do Claude</label>
            <select id="wctlAccount" disabled><option>carregando…</option></select>
            <span class="wctl-notify-state" id="wctlAccountSrc"></span>
          </div>
          <div class="wctl-usage" aria-labelledby="wctlUsageTitle">
            <div class="wctl-notify">
              <span class="wctl-notify-label" id="wctlUsageTitle">Uso da conta</span>
              <span class="wctl-notify-state" id="wctlUsageState"></span>
              <button type="button" class="btn" id="wctlUsageRefresh">Atualizar</button>
            </div>
            <div id="wctlUsageBars" class="wctl-usage-bars"></div>
          </div>
          <div class="wctl-notify">
            <span class="wctl-notify-label">Notificações</span>
            <span class="wctl-notify-state" id="wctlNotifyState">verificando…</span>
            <button type="button" class="btn" id="wctlNotifyTest" disabled>Testar Notificação</button>
            <span class="wctl-notify-result" id="wctlNotifyResult" role="status" aria-live="polite"></span>
          </div>
          <div class="wctl-hours" aria-labelledby="wctlHoursTitle">
            <span class="wctl-settings-title label" id="wctlHoursTitle">Horas Redmine (backfill)</span>
            <p class="wctl-hours-help">Reprocessa runs arquivados e sincroniza time entries a partir do cost_tracking. Dry-run não grava.</p>
            <div class="wctl-hours-row">
              <label class="wctl-hours-field">Limit <input type="number" id="wctlHoursLimit" min="1" step="1" placeholder="todos" inputmode="numeric"></label>
              <label class="wctl-hours-field">Ticket <input type="number" id="wctlHoursTicket" min="1" step="1" placeholder="opcional" inputmode="numeric"></label>
              <label class="wctl-auto"><input type="checkbox" id="wctlHoursConfirmApply"> Confirmar apply (grava no Redmine)</label>
            </div>
            <div class="wctl-hours-row">
              <button type="button" class="btn" id="wctlHoursDry">Dry-run</button>
              <button type="button" class="btn danger" id="wctlHoursApply" disabled>Apply</button>
              <button type="button" class="btn" id="wctlHoursCancel" disabled>Cancelar</button>
            </div>
            <div class="wctl-hours-progress" id="wctlHoursProgress" aria-live="polite">
              <div class="wctl-hours-bar" aria-hidden="true"><i id="wctlHoursBar"></i></div>
              <p class="wctl-hours-msg" id="wctlHoursMsg">Nenhum backfill ainda.</p>
              <p class="wctl-hours-meta" id="wctlHoursMeta"></p>
              <pre class="wctl-hours-log" id="wctlHoursLog" tabindex="0" aria-label="Progresso do backfill de horas"></pre>
            </div>
          </div>
        </div>
        <div class="wctl-loghead">
          <span class="label">Log em tempo real</span>
          <span class="wctl-levels">${LEVELS.map(l => `<label><input type="checkbox" data-wlevel="${l}"${prefs.watcherLevels[l] !== false ? ' checked' : ''}> ${l}</label>`).join('')}</span>
          <button type="button" class="btn" id="wctlClear">Limpar</button>
        </div>
        <pre class="wctl-log" id="wctlLog" tabindex="0" aria-label="Log do watcher" aria-live="off"></pre>
      </section>
    </div>`);

  const chip = $('wctlChip'), panel = $('wctlPanel'), logEl = $('wctlLog');

  // "próximo em 42 s": anda a cada segundo sem refetch (ver ticker abaixo).
  function untilText(iso) {
    const sec = Math.round((Date.parse(iso) - Date.now()) / 1000);
    return sec > 0 ? `em ${sec < 60 ? `${sec} s` : dur(sec * 1000)}` : 'agora';
  }
  // Segunda linha do cartão do rail: só dado medido pelo watcher-manager; sem dado, nada.
  function subText() {
    if (!reachable || !st || busy) return '';
    if (st.state === 'restarting') return st.next_tick_at ? `reinício ${untilText(st.next_tick_at)}` : '';
    if (st.running) {
      const tick = st.ticks != null ? `tick ${st.ticks}` : '';
      if (st.phase === 'tick') return [tick, 'em andamento'].filter(Boolean).join(' · ');
      return [tick, st.next_tick_at ? `próximo ${untilText(st.next_tick_at)}` : ''].filter(Boolean).join(' · ');
    }
    return st.last_run?.ended_at ? `parou às ${hhmm(st.last_run.ended_at)}` : '';
  }
  function paintSub() { $('wctlSub').textContent = subText(); }

  function paint() {
    const t = tone(), text = label();
    const limit = st?.error === 'restart_limit_reached' && !st.running;
    $('wctl').dataset.tone = t;
    $('wctl').classList.toggle('limit', limit);
    $('wctlState').textContent = text.replace(/^Watcher: /, '');
    $('wctlText').textContent = (limit ? '⚠ ' : '') + text;
    chip.title = `${text} — abrir controle do watcher`;
    $('wctlShort').textContent = !reachable || !st || busy || st.state !== 'running' && st.state !== 'stopped' ? text.replace(/^Watcher: /, 'Watcher ')
      : st.running ? 'Watcher ativo' : `${limit ? '⚠ ' : ''}Watcher parado`;
    paintSub();
    const running = !!st?.running;
    for (const b of panel.querySelectorAll('[data-wact]')) {
      const a = b.dataset.wact;
      b.disabled = !reachable || !!busy || (a === 'start' ? running || st?.state === 'stopping' : !running && st?.state !== 'stopping');
    }
    const alert = $('wctlAlert');
    if (limit) {
      alert.hidden = false;
      alert.textContent = `⚠ O watcher morreu ${st.max_restarts_per_hour + 1} vezes em menos de 1 hora e não será mais reiniciado sozinho. Verifique o log abaixo e use Start para tentar de novo.`;
    } else if (st?.orphan_pid) {
      alert.hidden = false;
      alert.textContent = `Há um watcher órfão (PID ${st.orphan_pid}) de uma execução anterior do dashboard. Ele será encerrado ao clicar Start.`;
    } else alert.hidden = true;

    // Fatos do processo (só leitura do /api/watcher/status). Sem medição → "—", nunca 0.
    let next = '—';
    if (running && st.phase === 'tick') next = 'em andamento';
    else if ((running || st?.state === 'restarting') && st.next_tick_at) next = `${st.state === 'restarting' ? 'reinício ' : ''}${hhmmss(st.next_tick_at)}`;
    const facts = [
      ['Uptime', running ? dur(st.uptime_ms) || '—' : '—'],
      ['Ticks', running && st.ticks != null ? String(st.ticks) : '—'],
      ['Próximo tick', next],
      ['Restarts automáticos', st && st.restarts != null ? String(st.restarts) : '—'],
      ['PID', st?.pid ? String(st.pid) : '—'],
    ];
    $('wctlFacts').innerHTML = facts.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join('');

    const last = st?.last_run;
    $('wctlLast').hidden = !last;
    if (last) $('wctlLast').textContent = `Última execução: ${dur(last.uptime_ms)} de uptime · parou às ${hhmm(last.ended_at)}${last.reason === 'restart_limit' ? ' (limite de restarts)' : ''}`;

    const cur = currentRun();
    const task = $('wctlTask');
    task.hidden = !cur;
    if (cur) {
      const num = titleOf(cur).num || cur.taskId;
      const node = cur.node || cur.state?.node;
      task.innerHTML = `<span>Processando: <b>${esc(num)}</b>${node ? ` · nó: ${esc(NODE_LABEL[node] || node)}` : ''}</span>
        <button type="button" class="btn" data-wopen="${esc(cur.taskId)}">Ver run atual</button>`;
    }
    if (autoStart !== null) $('wctlAuto').checked = autoStart;
  }

  function lineHtml(e) {
    const cls = `wl-${e.level.toLowerCase()}${e.source === 'manager' ? ' wl-mgr' : ''}`;
    return `<span class="${cls}" data-level="${e.level}">${hhmmss(e.ts)} [${e.level}] ${esc(e.text)}\n</span>`;
  }
  function renderLog() {
    const shown = lines.filter(e => e.seq > clearedSeq && prefs.watcherLevels[e.level] !== false);
    logEl.innerHTML = shown.length ? shown.map(lineHtml).join('') : '<span class="wl-empty">Sem linhas de log ainda.</span>';
    logEl.scrollTop = logEl.scrollHeight;
  }
  function appendLine(e) {
    if (e.seq <= lastSeq) return;
    lastSeq = e.seq;
    lines.push(e);
    if (lines.length > MAX_LINES) lines.splice(0, lines.length - MAX_LINES);
    if (panel.hidden || prefs.watcherLevels[e.level] === false) return;
    const stick = nearBottom(logEl);
    logEl.querySelector('.wl-empty')?.remove();
    logEl.insertAdjacentHTML('beforeend', lineHtml(e));
    while (logEl.childElementCount > MAX_LINES) logEl.firstElementChild.remove();
    if (stick) logEl.scrollTop = logEl.scrollHeight;
  }

  // ------------------------------------------------------------------ dados
  async function poll() {
    try { st = await api('/api/watcher/status'); reachable = true; } catch { reachable = false; }
    paint();
  }
  async function act(action) {
    busy = action; paint();
    try {
      st = await api(`/api/watcher/${action}`, { method: 'POST' });
      if (action === 'stop') toast('Watcher parado.');
    } catch (e) {
      toast(`Falha ao executar ${action}: ${e.message}`);
    } finally {
      busy = null;
      poll();
    }
  }
  // Webhook (NOTIFY_WEBHOOK_URL no .env do repo, scripts/notify.js): o servidor só
  // devolve o host, nunca a URL.
  let notifyCfg = null, notifyBusy = false;
  function paintNotify(result) {
    const stEl = $('wctlNotifyState'), btn = $('wctlNotifyTest');
    stEl.textContent = !notifyCfg ? 'verificando…'
      : notifyCfg.configured ? `webhook: ${notifyCfg.host || 'configurado'}` : 'desligadas (NOTIFY_WEBHOOK_URL vazia no .env)';
    btn.disabled = notifyBusy || !notifyCfg?.configured;
    btn.textContent = notifyBusy ? 'Enviando…' : 'Testar Notificação';
    if (result === undefined) return;
    const out = $('wctlNotifyResult');
    out.dataset.tone = result?.sent ? 'ok' : 'err';
    out.textContent = !result ? ''
      : result.status != null ? `HTTP ${result.status}${result.sent ? ' — enviada' : ' — recusada pelo destino'}`
      : `falhou: ${result.error === 'timeout' ? 'timeout (5 s)' : result.error || 'erro desconhecido'}`;
  }
  async function loadNotify() {
    try { notifyCfg = await api('/api/notify/status'); } catch { notifyCfg = null; }
    paintNotify();
  }
  async function testNotify() {
    notifyBusy = true; paintNotify(null);
    let r;
    try { r = await api('/api/notify/test', { method: 'POST' }); } catch (e) { r = { sent: false, status: null, error: e.message }; }
    notifyBusy = false; paintNotify(r);
  }

  // Conta do Claude dos agentes (scripts/lib/claude-account.js) e uso/limite dela
  // (scripts/lib/claude-usage.js). "Atualizar" faz uma chamada mínima ao Claude, que
  // gasta um pouco da cota — por isso abrir o painel só lê o cache do servidor.
  const WINDOW_LABEL = { five_hour: 'Sessão (5h)', seven_day: 'Semana (7 dias)', seven_day_opus: 'Semana · Opus', seven_day_sonnet: 'Semana · Sonnet' };
  const SOURCE_LABEL = { dashboard: 'escolhida aqui', env: 'WATCHER_CLAUDE_CONFIG_DIR no .env', default: 'padrão do CLI' };
  let accounts = null, usage = null, usageBusy = false;
  function resetLabel(iso) {
    if (!iso) return '';
    const d = new Date(iso), now = new Date();
    const time = d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
    if (d.toDateString() === now.toDateString()) return `reseta às ${time}`;
    return `reseta ${d.toLocaleDateString('pt-BR', { weekday: 'short', day: '2-digit', month: '2-digit' })} ${time}`;
  }
  function paintAccounts() {
    const sel = $('wctlAccount');
    if (!accounts) { sel.disabled = true; return; }
    sel.innerHTML = accounts.accounts.map(a => `<option value="${esc(a.id)}"${a.id === accounts.selected ? ' selected' : ''}>${esc(a.label)}${a.id === 'default' ? '' : ` (${esc(a.id)})`}</option>`).join('');
    sel.disabled = usageBusy;
    $('wctlAccountSrc').textContent = SOURCE_LABEL[accounts.source] || '';
  }
  function paintUsage() {
    const btn = $('wctlUsageRefresh');
    btn.disabled = usageBusy;
    btn.textContent = usageBusy ? 'Consultando…' : 'Atualizar';
    const stEl = $('wctlUsageState'), bars = $('wctlUsageBars');
    if (!usage) { stEl.textContent = usageBusy ? 'consultando o Claude…' : ''; bars.innerHTML = ''; return; }
    if (!usage.ok) { stEl.textContent = `falhou: ${usage.error || 'erro desconhecido'}`; stEl.dataset.tone = 'err'; bars.innerHTML = ''; return; }
    delete stEl.dataset.tone;
    const status = usage.status === 'rejected' ? '⛔ limite atingido' : usage.status === 'allowed_warning' ? '⚠ perto do limite' : 'ok';
    stEl.textContent = `${status}${usage.is_using_overage ? ' · usando overage' : ''} · consultado às ${hhmm(usage.checked_at)}`;
    bars.innerHTML = Object.entries(usage.windows || {}).map(([name, w]) => {
      const pct = w.utilization == null ? null : Math.round(w.utilization * 100);
      const tone = pct == null ? '' : pct >= 90 ? 'stop' : pct >= 70 ? 'warn' : 'ok';
      return `<div class="wctl-ubar" data-tone="${tone}">
        <span class="wctl-ubar-label">${esc(WINDOW_LABEL[name] || name)}</span>
        <span class="wctl-ubar-track" role="meter" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct ?? 0}" aria-label="${esc(WINDOW_LABEL[name] || name)}"><i style="width:${Math.min(pct ?? 0, 100)}%"></i></span>
        <span class="wctl-ubar-pct">${pct == null ? '—' : `${pct}%`}</span>
        <span class="wctl-ubar-reset">${esc(resetLabel(w.resets_at))}</span>
      </div>`;
    }).join('');
  }
  async function loadAccounts() {
    try { accounts = await api('/api/claude/accounts'); } catch { accounts = null; }
    paintAccounts();
  }
  async function loadUsage(refresh) {
    usageBusy = true; paintUsage(); paintAccounts();
    try { usage = await api(`/api/claude/usage${refresh ? '?refresh=1' : ''}`); }
    catch (e) { usage = { ok: false, error: e.message }; }
    usageBusy = false; paintUsage(); paintAccounts();
  }
  async function chooseAccount(id) {
    try {
      await api('/api/watcher/prefs', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ claude_config_dir: id }) });
      toast('Conta do Claude trocada — vale a partir do próximo nó despachado.');
    } catch (err) { toast(`Não foi possível trocar a conta: ${err.message}`); }
    await loadAccounts();
    loadUsage(false);
  }

  async function loadPrefs() {
    try { autoStart = (await api('/api/watcher/prefs')).auto_start; paint(); } catch {}
  }

  // EventSource reconecta sozinho; o servidor manda o buffer inteiro de novo a cada
  // conexão, então seq descarta o repetido. Instância nova (dashboard reiniciado)
  // zera a contagem.
  function connectLog() {
    const es = new EventSource('/api/watcher/log-stream');
    es.addEventListener('hello', ev => {
      let h; try { h = JSON.parse(ev.data); } catch { return; }
      if (instance && h.instance !== instance) { lines.length = 0; lastSeq = 0; clearedSeq = 0; if (!panel.hidden) renderLog(); }
      instance = h.instance;
    });
    es.onmessage = ev => { try { appendLine(JSON.parse(ev.data)); } catch {} };
  }

  // ------------------------------------------------------------------ eventos
  function setOpen(open) {
    panel.hidden = !open;
    chip.setAttribute('aria-expanded', open);
    if (open) { renderLog(); poll(); loadNotify(); loadAccounts(); if (!usage && !usageBusy) loadUsage(false); refreshHours(); }
    else stopHoursPoll();
  }
  chip.addEventListener('click', () => setOpen(panel.hidden));
  document.addEventListener('click', e => { if (!panel.hidden && !$('wctl').contains(e.target)) setOpen(false); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && !panel.hidden) { setOpen(false); chip.focus(); } });
  panel.addEventListener('click', e => {
    const a = e.target.closest('[data-wact]');
    if (a && !a.disabled) return act(a.dataset.wact);
    const o = e.target.closest('[data-wopen]');
    if (o) { setOpen(false); window.Views?.openRun ? Views.openRun(o.dataset.wopen) : select(o.dataset.wopen); }
  });
  $('wctlClear').addEventListener('click', () => { clearedSeq = lastSeq; renderLog(); });
  $('wctlNotifyTest').addEventListener('click', testNotify);
  $('wctlUsageRefresh').addEventListener('click', () => loadUsage(true));

  // Backfill de horas Redmine (GET/POST /api/redmine-hours-backfill/*)
  let hoursJob = null, hoursPollTimer = null;
  function hoursBody(dryRun) {
    const body = { dryRun: !!dryRun };
    const lim = $('wctlHoursLimit').value.trim();
    const ticket = $('wctlHoursTicket').value.trim();
    if (lim) body.limit = Number(lim);
    if (ticket) body.ticket = Number(ticket);
    if (!dryRun) body.confirmApply = true;
    return body;
  }
  function paintHours() {
    const j = hoursJob;
    const running = j?.state === 'running';
    $('wctlHoursDry').disabled = running;
    $('wctlHoursApply').disabled = running || !$('wctlHoursConfirmApply').checked;
    $('wctlHoursCancel').disabled = !running;
    const msg = $('wctlHoursMsg');
    msg.textContent = j?.message || 'Nenhum backfill ainda.';
    msg.dataset.tone = j?.state === 'error' ? 'err' : j?.state === 'done' ? 'ok' : j?.state === 'cancelled' ? 'warn' : '';
    const pct = j?.total ? Math.min(100, Math.round((j.index || 0) / j.total * 100)) : (j?.state === 'done' ? 100 : 0);
    $('wctlHoursBar').style.width = `${running || j?.state === 'done' ? pct : 0}%`;
    const bits = [];
    if (j?.id) bits.push(j.dryRun === false ? 'APPLY' : 'dry-run');
    if (j?.state) bits.push(j.state);
    if (j?.total) bits.push(`${j.index || 0}/${j.total}`);
    if (j?.counts) {
      const c = j.counts;
      bits.push(`criar:${c.would_create || c.created || 0}`);
      bits.push(`skip:${c.skip || 0}`);
      if (c.error) bits.push(`err:${c.error}`);
    }
    if (j?.hoursWouldSync) bits.push(`${j.hoursWouldSync}h`);
    $('wctlHoursMeta').textContent = bits.join(' · ');
    const log = $('wctlHoursLog');
    const evs = (j?.events || []).slice(-40);
    log.textContent = evs.length
      ? evs.map(e => {
          const t = (e.ts || '').slice(11, 19);
          return [t, e.action || e.phase || '', e.taskId || '', e.ticketId != null ? `#${e.ticketId}` : '', e.hours != null ? `${e.hours}h` : '', e.reason || e.message || ''].filter(Boolean).join(' ');
        }).join('\n')
      : '';
    if (running) log.scrollTop = log.scrollHeight;
  }
  function stopHoursPoll() {
    if (hoursPollTimer) { clearInterval(hoursPollTimer); hoursPollTimer = null; }
  }
  async function refreshHours() {
    try { hoursJob = await api('/api/redmine-hours-backfill/status'); } catch { /* keep last */ }
    paintHours();
    if (hoursJob?.state === 'running' && !hoursPollTimer) {
      hoursPollTimer = setInterval(refreshHours, 800);
    }
    if (hoursJob && hoursJob.state !== 'running') stopHoursPoll();
  }
  async function startHours(dryRun) {
    paintHours();
    try {
      hoursJob = await api('/api/redmine-hours-backfill/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(hoursBody(dryRun)),
      });
      toast(dryRun ? 'Dry-run de horas iniciado.' : 'Apply de horas iniciado.');
      stopHoursPoll();
      hoursPollTimer = setInterval(refreshHours, 800);
      paintHours();
    } catch (e) {
      toast(`Backfill horas: ${e.message}`);
      refreshHours();
    }
  }
  async function cancelHours() {
    try {
      hoursJob = await api('/api/redmine-hours-backfill/cancel', { method: 'POST' });
      toast('Cancelamento pedido.');
      paintHours();
    } catch (e) { toast(`Cancelar: ${e.message}`); }
  }
  $('wctlHoursDry').addEventListener('click', () => startHours(true));
  $('wctlHoursApply').addEventListener('click', () => {
    if (!$('wctlHoursConfirmApply').checked) return toast('Marque “Confirmar apply” antes.');
    if (!confirm('Isso cria time entries reais no Redmine M&O. Continuar?')) return;
    startHours(false);
  });
  $('wctlHoursCancel').addEventListener('click', cancelHours);
  $('wctlHoursConfirmApply').addEventListener('change', paintHours);

  panel.addEventListener('change', async e => {
    if (e.target.dataset.wlevel) {
      prefs.watcherLevels[e.target.dataset.wlevel] = e.target.checked; persist(); renderLog();
    } else if (e.target.id === 'wctlAccount') {
      chooseAccount(e.target.value);
    } else if (e.target.id === 'wctlAuto') {
      const want = e.target.checked;
      try { autoStart = (await api('/api/watcher/prefs', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ auto_start: want }) })).auto_start; }
      catch (err) { toast(`Não foi possível salvar: ${err.message}`); }
      paint();
    }
  });

  // Tempo relativo e "task em andamento" acompanham os runs, que já chegam por WebSocket.
  setInterval(() => { if (!document.hidden) poll(); }, POLL_MS);
  setInterval(() => { if (!document.hidden && st?.next_tick_at) paintSub(); }, 1000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) poll(); });
  poll();
  loadPrefs();
  connectLog();
  window.WatcherPanel = { poll, open: () => setOpen(true) };
})();
