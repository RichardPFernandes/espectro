// system-model.js — regras puras da tela Sistema (artboard System do design Espectro): o que cada
// elemento mostra a partir das APIs do dashboard. Sem DOM e sem relógio implícito (now/format injetados),
// para testar sem browser. Sem leitura → "UNKNOWN" ou "—", nunca "ok" nem zero.
// Script clássico (window.SystemModel) e módulo CommonJS (system-model.test.js).
(root => {
  const UNKNOWN = 'UNKNOWN';
  const STATUS_SRC = 'GET /api/watcher/status';
  const CONFIG_SRC = 'GET /api/validate-config';
  const VERSION_SRC = 'GET /api/version';
  const TABS = [['watch', 'Watcher', '1'], ['config', 'Configuração e versão', '2']];

  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
  const hhmmPt = iso => new Date(iso).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });

  // "45 s", "12 min", "6 h 12 min", "2 d 3 h" (formato do artboard: "uptime 6 h 12 min").
  function durLong(ms) {
    if (ms == null || !Number.isFinite(ms) || ms < 0) return null;
    const s = Math.floor(ms / 1000);
    if (s < 60) return `${s} s`;
    const m = Math.floor(s / 60), h = Math.floor(m / 60), d = Math.floor(h / 24);
    if (d) return `${d} d ${h % 24} h`;
    return h ? `${h} h ${m % 60} min` : `${m} min`;
  }

  // "agora", "há 2 min", "há 2 h", "ontem", "há 3 dias" (commits e "contrato vN · há X").
  function ago(iso, now) {
    const t = Date.parse(iso);
    if (!Number.isFinite(t)) return null;
    const s = Math.max(0, Math.floor((now - t) / 1000));
    if (s < 60) return 'agora';
    const m = Math.floor(s / 60), h = Math.floor(m / 60), d = Math.floor(h / 24);
    if (!h) return `há ${m} min`;
    if (!d) return `há ${h} h`;
    return d === 1 ? 'ontem' : `há ${d} dias`;
  }

  // Cabeçalho, botões, fatos e nota do painel Watcher. st = último /api/watcher/status (ou null).
  function watcher(st, { reachable = true, busy = null } = {}, now = Date.now(), hhmm = hhmmPt) {
    const known = !!st && reachable;
    const running = known && !!st.running;
    const limit = known && !st.running && st.error === 'restart_limit_reached';
    const max = known && Number.isInteger(st.max_restarts_per_hour) ? st.max_restarts_per_hour : null;
    let tone, label, sub;
    if (!known) { tone = 'unknown'; label = UNKNOWN; sub = reachable ? 'verificando o watcher…' : `sem resposta de ${STATUS_SRC}`; }
    else if (busy === 'start' || busy === 'restart' || st.state === 'starting') { tone = 'warn'; label = 'iniciando'; sub = ''; }
    else if (busy === 'stop' || st.state === 'stopping') { tone = 'warn'; label = 'parando'; sub = 'termina o tick atual e para'; }
    else if (st.state === 'restarting') {
      tone = 'warn'; label = 'reiniciando';
      sub = max != null && st.restarts_last_hour != null ? `reinício automático ${st.restarts_last_hour} de ${max}` : '';
    } else if (running) {
      tone = 'on'; label = 'ativo';
      const up = durLong(st.uptime_ms);
      sub = [st.pid ? `PID ${st.pid}` : 'PID entre ticks', up && `uptime ${up}`].filter(Boolean).join(' · ');
    } else {
      tone = 'off'; label = limit ? 'parado por crash' : 'parado';
      const ended = st.last_run?.ended_at;
      sub = [ended && `parado às ${hhmm(ended)}`, limit && max != null && `${max + 1} crashes na última hora`].filter(Boolean).join(' · ');
    }
    // Mesmas regras do painel do rail (watcher.js paint): sem st ainda, Start fica liberado.
    const off = !reachable || !!busy;
    const startDisabled = off || running || st?.state === 'stopping';
    const stopDisabled = off || (!running && st?.state !== 'stopping');
    const facts = [
      { k: 'Ticks', v: running && Number.isInteger(st.ticks) ? String(st.ticks) : '—' },
      { k: 'Reinícios / hora', v: known && max != null && Number.isInteger(st.restarts_last_hour) ? `${st.restarts_last_hour} de ${max}` : '—' },
      { k: 'Intervalo', v: known && st.interval_ms > 0 ? `${Math.round(st.interval_ms / 1000)} s` : '—' },
    ].map(f => ({ ...f, source: STATUS_SRC }));
    const crash = limit && max != null
      ? `Laço parado depois de ${max + 1} crashes em 1 hora.` : limit ? 'Laço parado pelo limite de reinícios automáticos.' : null;
    const note = max != null
      ? `Segredos aparecem como [REDACTED]. Até ${max} reinícios automáticos por hora; no ${max + 1}º crash o laço para e espera um Start manual. Runs despachados aparecem em `
      : 'Segredos aparecem como [REDACTED]. Runs despachados aparecem em ';
    return { known, running, limit, tone, label, sub, startDisabled, stopDisabled, restartDisabled: stopDisabled, facts, crash, note, cycle: cycle(st, { known, busy }, now) };
  }

  // Barra "Ciclo do tick": posição no intervalo entre ticks, medida pelo watcher-manager.
  function cycle(st, { known, busy } = {}, now = Date.now()) {
    const tick = known && Number.isInteger(st.ticks) ? `tick ${st.ticks}` : 'tick';
    const iv = known && st.interval_ms > 0 ? st.interval_ms : null;
    const pct = v => `${Math.max(0, Math.min(100, Math.round(v)))}%`;
    if (!known) return { pct: '0%', tone: 'unknown', left: `${UNKNOWN} · sem leitura do watcher`, right: '', aria: 'Ciclo do tick desconhecido' };
    if (busy || st.state === 'stopping' || st.state === 'starting') return { pct: '0%', tone: 'warn', left: busy === 'stop' || st.state === 'stopping' ? 'parando' : 'iniciando', right: '', aria: 'Watcher mudando de estado' };
    if (st.state === 'restarting') {
      const r = st.next_tick_at ? Math.max(0, Math.round((Date.parse(st.next_tick_at) - now) / 1000)) : null;
      return { pct: '0%', tone: 'warn', left: 'reiniciando', right: r != null ? `reinício em ${r} s` : '', aria: 'Watcher reiniciando' };
    }
    if (!st.running) {
      const last = Number.isInteger(st.ticks) && st.ticks > 0 ? ` · último tick ${st.ticks}` : '';
      return { pct: '0%', tone: 'off', left: `laço parado${last}`, right: 'sem próximo tick', aria: 'Laço parado' };
    }
    if (st.phase === 'tick') {
      const e = st.tick_started_at ? Math.max(0, Math.floor((now - Date.parse(st.tick_started_at)) / 1000)) : null;
      // Durante o tick a barra fica cheia (não mistura duração do tick com o intervalo); a legenda dá o tempo.
      return {
        pct: '100%', tone: 'on',
        left: [tick, e != null && `${e} s`, 'lendo tasks e despachando'].filter(Boolean).join(' · '),
        right: 'tick em andamento', aria: 'Fase atual: lendo tasks e despachando',
      };
    }
    if (!st.next_tick_at) return { pct: '0%', tone: 'on', left: `${tick} · ocioso`, right: '', aria: 'Fase atual: ocioso' };
    const r = Math.max(0, Math.round((Date.parse(st.next_tick_at) - now) / 1000));
    const e = iv ? Math.max(0, Math.round(iv / 1000) - r) : null;
    return {
      pct: iv ? pct(((iv / 1000 - r) / (iv / 1000)) * 100) : '0%', tone: 'on',
      left: [tick, e != null && `${e} s`, 'ocioso'].filter(Boolean).join(' · '),
      right: `próximo em ${r} s`, aria: `Fase atual: ocioso, próximo tick em ${r} segundos`,
    };
  }

  // Linhas do log com os filtros de nível e o "Limpar" (só esconde até clearedSeq).
  function logLines(lines, levels = {}, clearedSeq = 0) {
    return (lines || []).filter(e => e.seq > clearedSeq && levels[e.level] !== false);
  }
  function logEmpty(lines, shown, cleared) {
    if (shown.length) return '';
    if (cleared) return 'Log limpo nesta tela. Novas linhas aparecem no próximo tick.';
    return (lines || []).length ? 'Nenhuma linha com os níveis selecionados.' : 'Sem linhas de log ainda.';
  }

  // Saúde da configuração. report = /api/validate-config (ou null); kf = filtro do card ('ok'|'warn'|'err').
  const KF = {
    ok: ['Regras que passaram', r => r.passed],
    warn: ['Avisos', r => !r.passed && r.severity === 'warning'],
    err: ['Erros', r => !r.passed && r.severity === 'error'],
  };
  const SEV_ORDER = { error: 0, warning: 1, info: 2 };
  function ruleTone(r) {
    if (r.passed) return 'ok';
    return r.severity === 'error' ? 'err' : r.severity === 'warning' ? 'warn' : 'info';
  }
  function config(report, kf = null, now = Date.now()) {
    if (!report || !Array.isArray(report.results)) return { known: false, tabCount: '' };
    const all = report.results.slice().sort((a, b) => (a.passed - b.passed) || ((SEV_ORDER[a.severity] ?? 3) - (SEV_ORDER[b.severity] ?? 3)));
    const n = id => all.filter(KF[id][1]).length;
    const counts = { ok: n('ok'), warn: n('warn'), err: n('err') };
    const filter = KF[kf] ? kf : null;
    const rules = all.filter(r => !filter || KF[filter][1](r)).map(r => ({ rule: r.rule, msg: r.message, tone: ruleTone(r) }));
    const when = ago(report.generatedAt, now);
    return {
      known: true, counts, filter, filterLabel: filter ? KF[filter][0] : '', rules,
      tone: counts.err ? 'err' : counts.warn ? 'warn' : 'ok',
      meta: [report.contractVersion != null && `contrato v${report.contractVersion}`, when].filter(Boolean).join(' · '),
      tabCount: counts.err ? plural(counts.err, 'erro', 'erros') : counts.warn ? plural(counts.warn, 'aviso', 'avisos') : '',
      cards: [
        { id: 'ok', value: counts.ok, label: 'regras passaram', tone: 'ok' },
        { id: 'warn', value: counts.warn, label: counts.warn === 1 ? 'aviso' : 'avisos', tone: 'warn' },
        { id: 'err', value: counts.err, label: counts.err === 1 ? 'erro' : 'erros', tone: counts.err ? 'err' : 'flat' },
      ].map(c => ({ ...c, pressed: filter === c.id, hint: filter === c.id ? 'filtrando · clique para limpar' : `ver ${plural(c.value, 'regra', 'regras')} →`, source: CONFIG_SRC })),
    };
  }

  // Abas com tecla e contador; idx para J/K e "aba N de M".
  function tabs(current, configCount = '') {
    const idx = Math.max(0, TABS.findIndex(t => t[0] === current));
    return {
      idx, id: TABS[idx][0], pos: `aba ${idx + 1} de ${TABS.length}`,
      list: TABS.map(([id, label, key], i) => ({ id, label, key, selected: i === idx, count: id === 'config' ? configCount : '' })),
    };
  }
  // Tecla → aba (J/K presos às pontas) ou null. Os dígitos ficam com o atalho global do app, que já
  // troca de tela (ux.js); o "1–4" do artboard não entra para não mudar esse comportamento.
  function tabForKey(key, current) {
    const { idx } = tabs(current);
    if (key === 'j' || key === 'k') return TABS[Math.max(0, Math.min(TABS.length - 1, idx + (key === 'j' ? 1 : -1)))][0];
    return null;
  }

  const short = sha => (typeof sha === 'string' && sha ? sha.slice(0, 7) : UNKNOWN);

  const api = { UNKNOWN, TABS, STATUS_SRC, CONFIG_SRC, VERSION_SRC, durLong, ago, watcher, cycle, logLines, logEmpty, config, tabs, tabForKey, short };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SystemModel = api;
})(typeof window !== 'undefined' ? window : globalThis);
