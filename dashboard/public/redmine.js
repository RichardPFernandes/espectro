// Tela "Tickets" (chave de view `redmine`) — artboards Tickets.dc.html e TicketActions.dc.html
// do design Espectro. Junta o Redmine (GET /api/tickets: abertos atribuídos a mim;
// /api/runs/:id/ticket via Views.loadAll: tickets dos runs), os runs locais (/api/runs) e o
// estado dos PRs no Bitbucket (prCache, também via Views.loadAll). A lógica pura (linhas,
// divergências, trilha do run, veredito) fica em ticket-board.js (window.TicketBoard).
//
// Ações: só as que já existem no app — disparar run (POST /api/runs/start, 409 = run ativo),
// corrigir recusa QA (retryQaRejection), mudar status (PUT /api/tickets/:id/status) e
// adicionar nota (POST /api/tickets/:id/note), estas duas na página de ações do ticket.
//
// A tela devolve sempre o mesmo nó (views.js > domView): a remontagem preserva rolagem,
// foco e o que foi digitado. Usa os globais de index.html/views.js: esc(), ago(), when(),
// toast(), runs, refreshRuns(), retryQaRejection(), extractPrs(), ticketCache, prCache,
// prefs, persist(), window.UIKit, window.TicketBoard.
(() => {
  const TB = window.TicketBoard;
  const pref = Object.assign({ view: 'mine', layout: 'list', closed: {} }, prefs.ticketBoard || {});
  if (!TB.VIEWS.some(v => v[0] === pref.view)) pref.view = 'mine';
  const st = {
    list: [], at: 0, loading: false, error: null,
    q: '', sel: null, page: null, note: '', toast: '',
    starting: new Set(), // tickets com "Iniciar run" em voo
    statuses: null, // GET /api/tickets/statuses (fallback sem allowed_statuses)
  };
  // Detalhe do ticket (GET /api/tickets/:id), por id.
  const det = new Map();
  // Página de ações: status escolhido, envio em voo e o último resultado.
  const pa = { pick: null, busy: null, stDone: false, noteSent: false };

  const savePref = () => { prefs.ticketBoard = pref; persist(); };
  const hoursText = h => TB.hoursLabel(h);

  // PRs do run com o estado mais atual conhecido: Bitbucket (prCache) > state.json.
  function prsOf(r) {
    const live = prCache.get(r.taskId)?.data?.prs;
    return extractPrs(r.state?.pull_request).map(p => {
      const l = live?.find(x => x.id === p.id && (!p.repo || x.repo === p.repo));
      return { ...p, state: String(l?.state || p.state || '').toUpperCase(), title: l?.title || null, approvals: l?.participants || [], created_on: l?.created_on || null };
    });
  }
  const rows = () => TB.buildRows({ mine: st.list, runs: [...runs.values()], ticketOf: id => ticketCache.get(id)?.data || null, prsOf });

  // ------------------------------------------------------------------ dados
  let root = null;
  const render = () => window.Views?.refresh();

  async function load(force) {
    if (st.loading) return;
    if (!force && Date.now() - st.at < 25000) return;
    st.loading = true; render();
    try {
      const res = await fetch('/api/tickets');
      const body = await res.json().catch(() => ({}));
      if (res.ok) { st.list = Array.isArray(body) ? body : []; st.error = null; }
      else st.error = body.error || `HTTP ${res.status}`;
    } catch (e) { st.error = e.message; }
    st.at = Date.now(); st.loading = false;
    render();
  }
  // Redmine dos tickets de run + estado dos PRs (mesmos caches/endpoints do painel do run).
  const loadRunSources = force => window.Views?.loadAll?.(force);

  async function loadDetail(id, force) {
    const cur = det.get(id);
    if (cur?.loading || (cur?.data && !force)) return;
    det.set(id, { data: cur?.data || null, loading: true, error: null });
    render();
    try {
      const res = await fetch(`/api/tickets/${id}`);
      const body = await res.json().catch(() => ({}));
      det.set(id, res.ok ? { data: body, loading: false, error: null } : { data: cur?.data || null, loading: false, error: body.error || `HTTP ${res.status}` });
    } catch (e) { det.set(id, { data: cur?.data || null, loading: false, error: e.message }); }
    render();
  }
  async function loadStatuses() {
    if (st.statuses) return;
    try { const res = await fetch('/api/tickets/statuses'); if (res.ok) { st.statuses = await res.json(); render(); } } catch { /* usa allowed_statuses */ }
  }

  // Poll curto (2s, até 60s) depois de disparar: o run só existe quando o fetch_ticket
  // destacado cria o state.json — o POST não devolve runId.
  function pollForNewRun(ticketId, before) {
    const deadline = Date.now() + 60000;
    const iv = setInterval(async () => {
      await refreshRuns();
      const found = [...runs.values()].find(r => r.ticketId === ticketId && !before.has(r.taskId));
      if (found) { clearInterval(iv); load(true); render(); return; }
      if (Date.now() > deadline) { clearInterval(iv); say('Run ainda não apareceu — confira Runs em instantes.'); }
    }, 2000);
  }
  async function start(ticketId) {
    if (st.starting.has(ticketId)) return;
    st.starting.add(ticketId); render();
    // Runs que o ticket já tinha: o poll espera um run novo, não um antigo concluído.
    const before = new Set([...runs.values()].filter(r => r.ticketId === ticketId).map(r => r.taskId));
    try {
      const res = await fetch('/api/runs/start', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ticketId }) });
      const body = await res.json().catch(() => ({}));
      if (res.status === 409) toast('Run já ativa para este ticket', body.runId ? { label: 'Ver run', run: () => window.Views.openRun(body.runId) } : undefined);
      else if (!res.ok) toast(`Não foi possível iniciar o run: ${body.error || `HTTP ${res.status}`}`);
      else { say(`Run pedido para #${ticketId}; aparece aqui quando o fetch-ticket criar o estado.`); pollForNewRun(ticketId, before); }
    } catch (e) { toast(`Não foi possível iniciar o run: ${e.message}`); }
    finally { st.starting.delete(ticketId); render(); }
  }

  let toastTimer = null;
  function say(msg) {
    st.toast = msg; render();
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { st.toast = ''; render(); }, 8000);
  }

  // ------------------------------------------------------------------ peças
  const ring = (s, size = 10) => `<span class="tk-ring" aria-hidden="true" style="--rc:${s.c};--rb:${s.bs};--rf:${s.fill};--rs:${size}px"></span>`;
  const bars = p => `<span class="tk-bars" aria-hidden="true">${TB.prioBars(p).map(b => `<i style="height:${b.h};background:${b.c}"></i>`).join('')}</span>`;
  function trIcon(tracker, size = 14) {
    const k = TB.trackerKind(tracker);
    if (!k) return `<span class="tk-tr" style="width:${size}px" aria-hidden="true"></span>`;
    const t = TB.TRACKERS[k];
    return `<svg class="tk-tr" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="stroke:${t.c}"><path d="${t.icon}"/></svg>`;
  }
  // Selo do PR (artboard: um selo "#81" / "#85 merged" por linha). Run com vários PRs mostra o
  // primeiro e "+N" (os outros no title): selos encolhidos viravam "#." ilegíveis na coluna de 150 px.
  const prTip = p => [p.repo, p.id ? `#${p.id}` : null, p.title, TB.prBadge(p).word].filter(Boolean).join(' · ');
  const prChips = r => {
    if (!r.prs.length) return '';
    const b = TB.prBadge(r.prs[0]);
    const first = `<span class="tk-pr" style="color:${b.fg};background:${b.bg}" title="${esc(prTip(r.prs[0]))}">${esc(b.label)}</span>`;
    const rest = r.prs.slice(1);
    return first + (rest.length ? `<span class="tk-pr tk-pr-more num" title="${esc(rest.map(prTip).join('\n'))}">+${rest.length}</span>` : '');
  };
  const alertChip = r => {
    if (!r.alerts.length) return '';
    const red = r.alerts.some(a => a.level === 'red');
    return `<span class="tk-div ${red ? 'red' : 'amber'}" title="${esc(r.alerts.map(a => a.text).join(' '))}">divergência</span>`;
  };
  const avatar = name => (name
    ? `<span class="tk-own c-own" title="${esc(name)}" style="background:${TB.avatarBg(name)}">${esc(TB.initials(name))}</span>`
    : '<span class="tk-own c-own tk-own-none" title="Sem responsável no Redmine">—</span>');

  function row(r) {
    const s = TB.statusStyle(r.status);
    const trail = TB.runTrail(r.run);
    const est = hoursText(r.estimated_hours);
    const on = st.sel === r.id;
    return `<button type="button" class="tk-row trow" data-tk="pick" data-id="${r.id}" aria-current="${on}">
      <span class="c-prio" title="Prioridade ${esc(r.priority || 'não informada')}">${bars(r.priority)}</span>
      ${ring(s)}
      <span class="tk-id">#${r.id}</span>
      <span class="tk-ttl">${trIcon(r.tracker)}<span class="tk-ttl-t">${esc(r.subject || 'Sem título consultado')}</span></span>
      <span class="c-alert">${alertChip(r)}${prChips(r)}</span>
      <span class="c-run" title="Run ${esc(r.run ? r.run.taskId : 'nenhum')}"><span class="tk-segs" aria-hidden="true">${trail.segs.map(c => `<i style="background:${c}"></i>`).join('')}</span><span class="tk-run-l" style="color:${trail.fg}">${esc(trail.label)}</span></span>
      <span class="c-est num" title="${est ? 'Horas estimadas no Redmine' : 'Sem estimativa no Redmine'}">${est || '—'}</span>
      ${avatar(r.assignee)}
      <span class="c-upd" title="${esc(r.updated_on ? when(r.updated_on) : 'Não consultado no Redmine')}">${esc(TB.shortAgo(r.updated_on) || '—')}</span>
    </button>`;
  }

  function card(r) {
    const on = st.sel === r.id;
    return `<button type="button" class="tk-card${r.alerts.length ? ' has-alert' : ''}" data-tk="pick" data-id="${r.id}" aria-current="${on}">
      <span class="tk-card-top">${trIcon(r.tracker, 12)}#${r.id}<span class="tk-card-own">${esc(TB.initials(r.assignee) || '—')}</span></span>
      <span class="tk-card-t">${esc(r.subject || 'Sem título consultado')}</span>
      <span class="tk-card-chips">${bars(r.priority)}${prChips(r)}${alertChip(r)}</span>
    </button>`;
  }

  // ------------------------------------------------------------------ estados
  function estBlock(kind) {
    const BADGE = { load: ['◐', 'CARREGANDO', 'running'], err: ['✕', 'ERRO', 'failed'], empty: ['○', 'VAZIO', 'queued'] }[kind];
    const head = `<span class="tk-est-head"><span class="tk-est-badge ${BADGE[2]}"><span aria-hidden="true">${BADGE[0]}</span>${BADGE[1]}</span><span>fonte: Redmine</span></span>`;
    if (kind === 'load') {
      const sk = [70, 52, 64, 46, 74, 58].map(w => `<div class="tk-skel-row"><i style="width:${w - 22}%"></i><i></i><i style="width:${w}%"></i></div>`).join('');
      return `<section class="tk-est" aria-label="Carregando os tickets" aria-busy="true"><div class="tk-est-in">${head}<p role="status">Carregando os tickets…</p><div class="tk-skel" aria-hidden="true">${sk}</div></div></section>`;
    }
    if (kind === 'err') {
      return `<section class="tk-est" aria-label="Erro ao carregar os tickets"><div class="tk-est-in">${head}
        <div class="tk-est-err" role="alert"><h2><span aria-hidden="true">✕</span>Não foi possível carregar os tickets</h2>
          <dl><dt>Causa</dt><dd>${esc(st.error)}</dd><dt>Preservado</dt><dd>Visão, layout e filtros ficam guardados. Nada foi alterado no Redmine.</dd><dt>Tentativa</dt><dd class="num">${esc(when(new Date(st.at).toISOString()))}</dd></dl>
          <div><button type="button" class="tk-btn-primary" data-tk="refresh" ${st.loading ? 'disabled' : ''}>Tentar novamente</button></div></div></div></section>`;
    }
    return `<section class="tk-est" aria-label="Nenhum ticket"><div class="tk-est-in">${head}
      <div class="tk-est-empty" role="status"><h2>Nenhum ticket nesta visão</h2>
        <p>O Redmine devolveu lista vazia e nenhum run aponta para um ticket. O dashboard também recebe lista vazia quando REDMINE_URL/REDMINE_API_KEY não estão configurados ou a consulta falha, então isto não confirma zero tickets.</p>
        <button type="button" class="tk-btn-primary" data-tk="refresh" ${st.loading ? 'disabled' : ''}>Consultar agora</button></div></div></section>`;
  }

  // ------------------------------------------------------------------ painel do ticket
  function journalText(j) {
    const LABELS = { status_id: 'Status', assigned_to_id: 'Responsável', priority_id: 'Prioridade', done_ratio: '% feito', estimated_hours: 'Tempo estimado', fixed_version_id: 'Versão', subject: 'Título', tracker_id: 'Tipo' };
    const parts = (j.details || []).filter(d => d.property === 'attr' && LABELS[d.name])
      .map(d => `${LABELS[d.name]}: ${d.old_label || d.old_value || 'vazio'} → ${d.new_label || d.new_value || 'vazio'}`);
    const desc = (j.details || []).some(d => d.name === 'description') ? ['Descrição alterada'] : [];
    const att = (j.details || []).filter(d => d.property === 'attachment').map(d => (d.new_value ? `Anexo: ${d.new_value}` : 'Anexo removido'));
    return [...parts, ...desc, ...att, j.notes || ''].filter(Boolean).join(' · ');
  }
  function journalList(d, cls) {
    const items = (d?.journals || []).map(j => ({ j, text: journalText(j) })).filter(x => x.text)
      .sort((x, y) => (Date.parse(y.j.created_on) || 0) - (Date.parse(x.j.created_on) || 0));
    if (!items.length) return '<p class="tk-muted">Nenhuma alteração ou nota registrada.</p>';
    return `<ol class="${cls}">${items.map(({ j, text }) => `<li><span class="tk-ini" aria-hidden="true" style="background:${TB.avatarBg(j.user)}">${esc(TB.initials(j.user) || '·')}</span>
      <span class="tk-jr-b"><span class="tk-jr-h">${esc(j.user || 'Sistema')} · <span title="${esc(when(j.created_on))}">${esc(ago(j.created_on))}</span>${j.private_notes ? ' · nota privada' : ''}</span><span class="tk-jr-t">${esc(text)}</span></span></li>`).join('')}</ol>`;
  }

  const SYNC_BAD = 'var(--c-4a2226)';
  function syncCards(r, v) {
    const s = TB.statusStyle(r.status);
    const trail = TB.runTrail(r.run);
    const RUN_DOT = { run: 'var(--accent)', human: 'var(--state-waiting)', fail: 'var(--state-failed)', done: 'var(--state-done)', queued: 'var(--border-control)', none: 'var(--border-control)' };
    const pr = r.prs[0] ? TB.prBadge(r.prs[0]) : null;
    const cards = [
      ['Redmine', r.status ? (r.statusVerified ? r.status : `${r.status} (gravado pelo watcher)`) : 'não consultado', r.statusVerified ? s.c : 'var(--border-control)'],
      ['Run', r.run ? (trail.node ? `${trail.node} · ${trail.state}` : trail.state) : 'nenhum', RUN_DOT[trail.tone]],
      ['Bitbucket', pr ? `PR ${r.prs[0].id ? `#${r.prs[0].id} ` : ''}${pr.word}${r.prs.length > 1 ? ` +${r.prs.length - 1}` : ''}` : 'sem PR', pr ? pr.dot : 'var(--border-control)'],
    ];
    return cards.map(([src, val, c]) => `<span class="tk-sync" style="border-color:${c === 'var(--state-failed)' || v.kind === 'red' ? SYNC_BAD : 'var(--border)'}"><span class="tk-sync-src">${src}</span><span class="tk-sync-v"><i aria-hidden="true" style="background:${c}"></i>${esc(val)}</span></span>`).join('');
  }

  function aside(r) {
    const d = det.get(r.id);
    const t = d?.data?.ticket;
    const v = TB.verdict(r);
    const VER = { ok: ['✓', 'done'], amber: ['‖', 'waiting'], red: ['✕', 'failed'], unk: ['?', 'queued'] }[v.kind];
    const s = TB.statusStyle(r.status);
    const pending = d?.loading ? 'carregando…' : d?.error ? 'não carregou' : '—';
    const est = t ? t.estimated_hours : r.estimated_hours;
    const spent = t?.spent_hours ?? null;
    const pct = est && spent != null ? Math.min(100, Math.round(spent / est * 100)) : 0;
    const hours = est == null && spent == null ? (t ? 'sem medição' : pending)
      : `${spent == null ? 'sem medição' : hoursText(spent).replace(' h', '')} / ${est == null ? 'sem estimativa' : hoursText(est)}`;
    const desc = t?.description ? (t.description.length > 280 ? `${t.description.slice(0, 280)}…` : t.description) : '';
    // Status confirmado no Redmine (o gravado pelo watcher pode estar velho); mesma regra de antes para o run.
    const rejected = r.statusVerified && TB.isQaRejected(r.status) && r.run && r.run.kind !== 'completed';
    // Mesma guarda do POST /api/runs/start: run com kind diferente de 'completed' devolve 409.
    const active = r.runs.some(x => x.kind !== 'completed');
    const starting = st.starting.has(r.id);
    const acts = [
      rejected && `<button type="button" class="tk-act primary" data-tk="qaretry" data-run="${esc(r.run.taskId)}">Corrigir recusa QA</button>`,
      !active && `<button type="button" class="tk-act primary" data-tk="start" data-id="${r.id}" ${starting ? 'disabled aria-busy="true"' : ''}>${starting ? 'Iniciando run…' : 'Iniciar run'}</button>`,
      `<button type="button" class="tk-act" data-tk="page" data-id="${r.id}">Mudar status ou comentar</button>`,
      r.run && `<button type="button" class="tk-link" data-tk="run" data-run="${esc(r.run.taskId)}">Abrir run</button>`,
      r.prUrl && `<a class="tk-link" href="${esc(r.prUrl)}" target="_blank" rel="noopener noreferrer">Ver PR</a>`,
    ].filter(Boolean).join('');
    return `<aside class="tk-side" aria-labelledby="tk-h" data-keep="side">
      ${UIKit.drawerClose('close')}
      <div class="tk-side-head">
        <span class="tk-side-meta">${trIcon(r.tracker)}${esc([r.tracker, `#${r.id}`].filter(Boolean).join(' · '))}
          ${r.url ? `<a class="tk-btn2 sm" href="${esc(r.url)}" target="_blank" rel="noopener noreferrer">Abrir no Redmine ↗</a>` : ''}</span>
        <h2 id="tk-h">${esc(r.subject || 'Sem título consultado')}</h2>
        ${desc ? `<span class="tk-side-desc">${esc(desc)}</span>` : d?.loading ? '<span class="tk-side-desc tk-muted">Carregando descrição…</span>' : ''}
      </div>
      <dl class="tk-facts">
        <dt>Status</dt><dd class="tk-inline">${ring(s)}${esc(r.status || 'não consultado')}</dd>
        <dt>Prioridade</dt><dd class="tk-inline">${bars(r.priority)}${esc(r.priority || '—')}</dd>
        <dt>Responsável</dt><dd>${esc(r.assignee || t?.assignee || 'sem responsável')}</dd>
        <dt>Sprint</dt><dd${t && !t.version ? ' title="Sem versão-alvo no Redmine"' : ''}>${t ? esc(t.version || 'Backlog') : pending}</dd>
        <dt>Horas</dt><dd class="tk-inline"><span class="tk-hbar" aria-hidden="true"><i style="width:${pct}%;background:${spent != null && est != null && spent > est ? 'var(--state-failed)' : 'var(--accent)'}"></i></span><span class="num" title="Gastas / estimadas no Redmine">${esc(hours)}</span></dd>
        <dt>Branch</dt><dd class="tk-mono"${r.branch ? '' : ' title="Nenhum run gravou a branch base"'}>${esc(r.branch || '—')}</dd>
      </dl>
      <section class="tk-sec" aria-labelledby="sync-h">
        <h3 id="sync-h" class="tk-h3">Três fontes, uma história?</h3>
        <div class="tk-syncs">${syncCards(r, v)}</div>
        <div class="tk-verdict ${VER[1]}" role="status"><span aria-hidden="true">${VER[0]}</span><span><b>${esc(v.title)}</b><span>${esc(v.body)}</span></span></div>
        <div class="tk-acts">${acts}</div>
      </section>
      <section class="tk-sec tk-sec-last" aria-labelledby="jr-h">
        <h3 id="jr-h" class="tk-h3">Histórico no Redmine</h3>
        ${d?.data ? journalList(d.data, 'tk-journal') : `<p class="tk-muted">${d?.error ? `Não foi possível carregar o histórico: ${esc(d.error)}` : 'Carregando histórico…'}</p>`}
      </section>
    </aside>`;
  }

  // ------------------------------------------------------------------ página de ações (TicketActions)
  function actionsPage(r) {
    const d = det.get(r.id);
    const t = d?.data?.ticket;
    if (!t) {
      return `<section class="tk-page" data-keep="page"><div class="tk-page-in">
        <header class="tk-page-head"><div><span class="tk-page-kick">#${r.id}</span><h1>${esc(r.subject || `Ticket #${r.id}`)}</h1></div>
          <button type="button" class="tk-chip" data-tk="back">Voltar para Tickets</button></header>
        <p class="tk-muted" role="status">${d?.error ? `Não foi possível carregar o ticket: ${esc(d.error)}` : 'Carregando o ticket…'}</p></div></section>`;
    }
    const opts = (t.allowed_statuses && t.allowed_statuses.length ? t.allowed_statuses : st.statuses || [])
      .filter((s, i, a) => a.findIndex(x => x.id === s.id) === i);
    if (t.status_id != null && !opts.some(s => s.id === t.status_id)) opts.unshift({ id: t.status_id, name: t.status });
    const pick = opts.find(s => s.id === pa.pick) || null;
    const canSt = !!pick && pick.id !== t.status_id && !pa.busy;
    const tone = TB.isQaRejected(t.status) ? 'waiting' : TB.CLOSED_RE.test(t.status) ? 'done' : 'running';
    const run = r.run;
    const est = hoursText(t.estimated_hours);
    const spent = hoursText(t.spent_hours);
    const meta = [t.assignee || 'sem responsável', `estimativa ${est || 'sem estimativa'}`, `gasto ${spent || 'sem medição'}`].map(esc).join(' · ');
    return `<section class="tk-page" data-keep="page"><div class="tk-page-in">
      <header class="tk-page-head">
        <div class="tk-page-title">
          <span class="tk-page-kick">${esc([`#${t.id}`, t.tracker, t.project].filter(Boolean).join(' · '))}</span>
          <h1>${esc(t.subject)}</h1>
          <span class="tk-page-meta"><span class="tk-pill ${tone}">${esc(t.status)}</span>${meta}${run ? ` · run <button type="button" class="tk-link tk-mono" data-tk="run" data-run="${esc(run.taskId)}">${esc(run.taskId)}</button>` : ''}</span>
        </div>
        <button type="button" class="tk-chip" data-tk="back">Voltar para Tickets</button>
      </header>
      <div class="tk-page-cols"><div class="tk-page-col">
        <section class="tk-box" aria-labelledby="st-h">
          <h2 id="st-h">Mudar status</h2>
          <div class="tk-opts" role="radiogroup" aria-label="Novo status">${opts.map(s => {
            const cur = s.id === t.status_id, on = pa.pick === s.id;
            return `<button type="button" class="tk-opt${cur ? ' cur' : ''}" role="radio" aria-checked="${on}" data-tk="pickst" data-st="${s.id}" ${cur ? 'aria-disabled="true"' : ''}>${esc(cur ? `${s.name} · atual` : s.name)}</button>`;
          }).join('')}</div>
          <p class="tk-effect${pick ? '' : ' none'}">${esc(pick ? TB.statusEffect(pick.name) : 'Escolha um status. O que muda no Espectro aparece aqui antes de confirmar.')}</p>
          <button type="button" class="tk-btn-primary${canSt ? '' : ' off'}" data-tk="applyst" aria-disabled="${!canSt}">${pa.busy === 'status' ? 'Mudando…' : pa.stDone ? '✓ Status alterado no Redmine' : pick ? `Mudar para ${esc(pick.name)}` : 'Mudar status'}</button>
        </section>
        <section class="tk-box" aria-labelledby="nt-h">
          <h2 id="nt-h">Adicionar nota</h2>
          <textarea id="tkNote" aria-label="Texto da nota" rows="4" maxlength="20000" placeholder="Escreva para o time. O agente também lê a nota no próximo ciclo.">${esc(st.note)}</textarea>
          <div class="tk-note-row"><button type="button" class="tk-btn-sec" data-tk="sendnote" ${pa.busy ? 'disabled' : ''}>${pa.busy === 'note' ? 'Enviando…' : pa.noteSent ? '✓ Nota enviada' : 'Enviar nota'}</button></div>
        </section>
        <section class="tk-hist" aria-labelledby="hi-h">
          <h2 id="hi-h">Histórico no Redmine</h2>
          ${journalList(d.data, 'tk-hist-list')}
        </section>
      </div></div>
    </div></section>`;
  }

  async function applyStatus() {
    const r = st.page && det.get(st.page)?.data?.ticket;
    if (!r || pa.busy || pa.pick == null || pa.pick === r.status_id) return;
    pa.busy = 'status'; render();
    try {
      const res = await fetch(`/api/tickets/${r.id}/status`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ statusId: pa.pick }) });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      Object.assign(pa, { busy: null, stDone: true, pick: null });
      say(`Status do #${r.id} alterado no Redmine.`);
      await loadDetail(r.id, true); load(true);
    } catch (e) { pa.busy = null; render(); toast(`Não foi possível mudar o status: ${e.message}`); }
  }
  async function sendNote() {
    const id = st.page;
    const note = (root?.querySelector('#tkNote')?.value ?? st.note).trim();
    if (!id || pa.busy) return;
    if (!note) { toast('Escreva a nota antes de enviar.'); root?.querySelector('#tkNote')?.focus(); return; }
    pa.busy = 'note'; render();
    try {
      const res = await fetch(`/api/tickets/${id}/note`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ note }) });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      Object.assign(pa, { busy: null, noteSent: true }); st.note = '';
      say(`Nota adicionada ao #${id}.`);
      await loadDetail(id, true); load(true);
    } catch (e) { pa.busy = null; render(); toast(`Não foi possível adicionar a nota: ${e.message}`); }
  }

  // ------------------------------------------------------------------ tela
  function html() {
    const all = rows();
    const byId = new Map(all.map(r => [r.id, r]));
    if (st.page != null) {
      const r = byId.get(st.page) || { id: st.page, subject: '', run: null, prs: [], alerts: [] };
      return actionsPage(r);
    }
    let body;
    if (!st.at && !all.length) body = estBlock('load');
    else if (st.error && !all.length) body = estBlock('err');
    else if (!all.length) body = estBlock('empty');
    else {
      const vis = TB.filterRows(all, pref.view, st.q);
      // Estado inicial do artboard: o primeiro ticket da lista já aberto no painel. Depois que a
      // pessoa fecha (Esc / ×), a tela não reabre sozinha.
      if (st.sel == null && !st.selClosed && vis.length) {
        st.sel = order()[0] ?? vis[0].id;
        const id = st.sel;
        queueMicrotask(() => loadDetail(id));
      }
      const views =TB.VIEWS.map(([id, label, fn], i) => {
        const on = pref.view === id;
        return `<button type="button" role="tab" class="tk-seg" data-tk="view" data-v="${id}" aria-selected="${on}"><kbd>${i + 1}</kbd>${label}<span class="num">${all.filter(fn).length}</span></button>`;
      }).join('');
      const layouts = [['list', 'Lista'], ['board', 'Quadro']].map(([id, label]) => `<button type="button" role="tab" class="tk-seg sm" data-tk="layout" data-l="${id}" aria-selected="${pref.layout === id}">${label}</button>`).join('');
      const groups = TB.groupByStatus(vis);
      let main;
      if (!vis.length) {
        main = `<div class="tk-empty" role="status"><span>Nenhum ticket nesta visão</span><button type="button" class="tk-btn2" data-tk="showall">Ver todos os tickets</button></div>`;
      } else if (pref.layout === 'board') {
        main = `<section class="tk-board" aria-label="Quadro de tickets"><div class="tk-board-cols">${groups.map(g => `<div class="tk-col">
          <span class="tk-col-h">${ring(g.style)}${esc(g.label)}<span class="num">${g.rows.length}</span></span>${g.rows.map(card).join('')}</div>`).join('')}</div></section>`;
      } else {
        main = `<section aria-label="Lista de tickets">${groups.map(g => {
          const open = !pref.closed[g.name];
          const hrs = g.hours != null ? `${hoursText(g.hours).replace(' h', '')} h estimadas${g.withHours < g.rows.length ? ` (${g.withHours} de ${g.rows.length} com estimativa)` : ''}` : '';
          return `<div><button type="button" class="tk-grp" data-tk="group" data-g="${esc(g.name)}" aria-expanded="${open}">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>
            ${ring(g.style)}${esc(g.label)}<span class="num tk-grp-n">${g.rows.length}</span><span class="tk-grp-h">${esc(hrs)}</span></button>
            ${open ? g.rows.map(row).join('') : ''}</div>`;
        }).join('')}</section>`;
      }
      const sel = st.sel != null ? byId.get(st.sel) : null;
      const viewLabel = (TB.VIEWS.find(v => v[0] === pref.view) || TB.VIEWS[0])[1];
      body = `<div class="tk-bar">
          <div class="tk-tabs" role="tablist" aria-label="Visões salvas">${views}</div>
          <label class="tk-search"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM21 21l-5-5"/></svg>
            <span class="sr-only">Buscar tickets</span><input id="tkQ" type="text" value="${esc(st.q)}" placeholder="Título, #número, tipo…" autocomplete="off"></label>
          <div class="tk-layouts" role="tablist" aria-label="Layout">${layouts}</div>
        </div>
        <div class="tk-panes" tabindex="0" aria-label="Tickets. J e K navegam, 1 a 3 trocam a visão, L troca lista e quadro, Esc fecha o detalhe.">
          <section class="tk-main" aria-label="Tickets" data-keep="main">${main}
            <p class="tk-note">Status, prioridade e responsável vêm do Redmine. A trilha de 7 segmentos é o run do Espectro; os selos de PR vêm do Bitbucket. “Divergência” = as três fontes não contam a mesma história.</p>
          </section>
          ${sel ? aside(sel) : ''}
        </div>
        <footer class="tk-status"><span>${vis.length} tickets em “${esc(viewLabel)}” · ${esc(st.toast || 'Redmine é a fonte dos status')}</span><span class="tk-keys">⌘K buscar · J K navegar · 1–3 visão · L lista/quadro · Esc fechar</span></footer>`;
    }
    return body;
  }

  // Cabeçalho do artboard ("Tickets [N com divergência] … Redmine · consultado há N · Consultar
  // agora") na mesma linha do caminho, no topbar do shell — mesmo padrão da tela Pull requests
  // (prs.js > paintTopbar). Na página de ações, o caminho ganha a cauda "› #id" (TicketActions).
  // Os nós somem nas outras telas (hidden aqui + CSS por body[data-view]).
  let top = null, tail = null;
  function paintTopbar() {
    const crumbs = document.querySelector('.topbar .crumbs-top');
    if (!crumbs) return;
    if (!top) {
      top = document.createElement('div');
      top.id = 'tkTop'; top.className = 'tk-top';
      top.addEventListener('click', e => { if (e.target.closest('[data-tk="refresh"]')) onAction(e.target.closest('[data-tk]')); });
      crumbs.after(top);
    }
    if (!tail) {
      tail = document.createElement('span');
      tail.id = 'tkCrumbTail'; tail.className = 'tk-crumb-tail';
      crumbs.append(tail);
    }
    const on = document.body.dataset.view === 'redmine';
    const tailHtml = on && st.page != null ? `<span aria-hidden="true">›</span><span aria-current="page">#${esc(String(st.page))}</span>` : '';
    if (tail.innerHTML !== tailHtml) tail.innerHTML = tailHtml;
    top.hidden = !on || st.page != null;
    if (top.hidden) { if (top.innerHTML) top.innerHTML = ''; return; }
    const all = rows();
    const alerts = all.filter(r => r.alerts.length).length;
    const sync = st.loading ? 'consultando…' : st.error ? 'última consulta falhou' : st.at ? `consultado ${ago(new Date(st.at).toISOString())}` : 'ainda não consultado';
    const html = `${alerts ? `<span class="tk-alert-pill num">${alerts} com divergência</span>` : ''}
      <span class="tk-sync-l" title="${esc(st.error && all.length ? `${st.error} — a lista é a da última leitura que funcionou` : st.at ? when(new Date(st.at).toISOString()) : '')}">Redmine · ${esc(sync)}</span>
      <button type="button" class="tk-btn2" data-tk="refresh" ${st.loading ? 'disabled' : ''}>${st.loading ? 'Consultando…' : 'Consultar agora'}</button>`;
    if (top.innerHTML !== html) {
      const hadFocus = top.contains(document.activeElement);
      top.innerHTML = html;
      if (hadFocus) top.querySelector('[data-tk="refresh"]')?.focus({ preventScroll: true });
    }
  }
  new MutationObserver(() => paintTopbar()).observe(document.body, { attributes: true, attributeFilter: ['data-view'] });

  // Remonta o conteúdo do nó fixo preservando rolagem dos painéis e foco/seleção de campos.
  function paint() {
    // Composição de acento em curso (IME / tecla morta): remontar agora perderia o caractere.
    if (root && st.composing) { st.dirty = true; return root; }
    // Página aberta direto em #redmine antes do /api/runs: pede Redmine/PR dos runs quando chegarem.
    if (!st.runSourcesAsked && runs.size) { st.runSourcesAsked = true; loadRunSources(false); }
    if (!root) {
      root = document.createElement('div');
      root.className = 'tk';
      // 1–3 trocam a visão salva desta tela; o atalho global de abas (ux.js) cede (data-local-digits).
      root.dataset.localDigits = '';
      wire(root);
    }
    const scroll = {};
    root.querySelectorAll('[data-keep]').forEach(el => { scroll[el.dataset.keep] = el.scrollTop; });
    const a = document.activeElement;
    const focus = a && root.contains(a) ? { id: a.id, tk: a.dataset?.tk, k: a.dataset?.id || a.dataset?.v || a.dataset?.l || a.dataset?.g || a.dataset?.st, s: a.selectionStart, e: a.selectionEnd } : null;
    if (a?.id === 'tkNote') st.note = a.value;
    root.innerHTML = html();
    paintTopbar();
    root.querySelectorAll('[data-keep]').forEach(el => { if (scroll[el.dataset.keep] != null) el.scrollTop = scroll[el.dataset.keep]; });
    if (focus) {
      const el = focus.id ? root.querySelector(`#${focus.id}`)
        : [...root.querySelectorAll(`[data-tk="${focus.tk}"]`)].find(x => (x.dataset.id || x.dataset.v || x.dataset.l || x.dataset.g || x.dataset.st) === focus.k);
      if (el) { el.focus({ preventScroll: true }); if (focus.s != null && el.setSelectionRange) try { el.setSelectionRange(focus.s, focus.e); } catch { /* campo sem seleção */ } }
      else root.querySelector('.tk-panes')?.focus({ preventScroll: true });
    }
    return root;
  }

  // ------------------------------------------------------------------ eventos
  function select(id) {
    st.sel = id;
    st.selClosed = id == null;
    if (id != null) loadDetail(id);
    render();
  }
  function openPage(id) {
    Object.assign(pa, { pick: null, busy: null, stDone: false, noteSent: false });
    st.page = id; st.note = '';
    loadDetail(id); loadStatuses();
    render();
    requestAnimationFrame(() => { const p = root?.querySelector('.tk-page'); if (p) p.scrollTop = 0; });
  }
  function order() {
    const vis = TB.filterRows(rows(), pref.view, st.q);
    return TB.groupByStatus(vis).filter(g => pref.layout === 'board' || !pref.closed[g.name]).flatMap(g => g.rows.map(r => r.id));
  }

  function onAction(el) {
    const a = el.dataset.tk;
    if (a === 'refresh') { load(true); loadRunSources(true); }
    else if (a === 'view') { pref.view = el.dataset.v; savePref(); render(); }
    else if (a === 'layout') { pref.layout = el.dataset.l; savePref(); render(); }
    else if (a === 'showall') { pref.view = 'all'; st.q = ''; savePref(); render(); }
    else if (a === 'group') { const g = el.dataset.g; pref.closed[g] = !pref.closed[g]; savePref(); render(); }
    else if (a === 'pick') select(Number(el.dataset.id));
    else if (a === 'close') select(null);
    else if (a === 'start') start(Number(el.dataset.id));
    else if (a === 'qaretry') retryQaRejection(el.dataset.run);
    else if (a === 'run') window.Views.openRun(el.dataset.run);
    else if (a === 'page') openPage(Number(el.dataset.id));
    else if (a === 'back') { st.page = null; render(); }
    else if (a === 'pickst') { const id = Number(el.dataset.st); if (el.getAttribute('aria-disabled') !== 'true') { pa.pick = id; pa.stDone = false; render(); } }
    else if (a === 'applyst') applyStatus();
    else if (a === 'sendnote') sendNote();
  }

  function wire(node) {
    node.addEventListener('click', e => {
      if (e.target.closest('[data-act="close"]')) { select(null); return; } // UIKit.drawerClose
      const el = e.target.closest('[data-tk]');
      if (el && node.contains(el)) onAction(el);
    });
    node.addEventListener('compositionstart', () => { st.composing = true; });
    node.addEventListener('compositionend', e => {
      st.composing = false;
      if (e.target.id === 'tkQ') st.q = e.target.value;
      if (e.target.id === 'tkNote') st.note = e.target.value;
      if (st.dirty || e.target.id === 'tkQ') { st.dirty = false; render(); }
    });
    node.addEventListener('input', e => {
      if (e.isComposing) return;
      if (e.target.id === 'tkQ') { st.q = e.target.value; render(); }
      else if (e.target.id === 'tkNote') { st.note = e.target.value; if (pa.noteSent) { pa.noteSent = false; render(); } }
    });
    node.addEventListener('keydown', e => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName);
      if (e.key === 'Escape' && !typing) {
        if (st.page != null) { st.page = null; render(); }
        else if (st.sel != null) select(null);
        else return;
        e.preventDefault(); e.stopPropagation();
        return;
      }
      if (typing || st.page != null) return;
      const k = e.key.toLowerCase();
      if (k === 'j' || k === 'k') {
        const ids = order();
        if (!ids.length) return;
        e.preventDefault(); e.stopPropagation();
        const next = ids[UIKit.step(ids.indexOf(st.sel), k === 'j' ? 1 : -1, ids.length)];
        select(next);
        requestAnimationFrame(() => root?.querySelector(`[data-tk="pick"][data-id="${next}"]`)?.scrollIntoView?.({ block: 'nearest' }));
      } else if (/^[1-3]$/.test(k)) { e.preventDefault(); e.stopPropagation(); pref.view = TB.VIEWS[Number(k) - 1][0]; savePref(); render(); }
      else if (k === 'l') { e.preventDefault(); e.stopPropagation(); pref.layout = pref.layout === 'list' ? 'board' : 'list'; savePref(); render(); }
    });
  }

  // Auto-refresh de 30s só com a tela aberta e a página visível.
  const onTab = () => window.Views?.current?.() === 'redmine';
  setInterval(() => { if (onTab() && !document.hidden) load(false); }, 30000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden && onTab()) load(false); });

  window.RedmineView = {
    render: paint,
    load(force) { load(force); loadRunSources(false); },
  };
  if (onTab()) window.RedmineView.load(false);
})();
