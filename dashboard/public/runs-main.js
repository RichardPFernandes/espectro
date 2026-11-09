// runs-main.js — HTML da tela Runs no design Espectro: cabeçalho da lista (artboard Main:
// indicadores de 7 dias, custo por nó, filtro por estado, ordenação), painel da run selecionada
// e o shell do detalhe (artboard RunDetail: cabeçalho, pipeline, faixa de parada, abas laterais).
// Script clássico carregado depois do principal: usa os globais de lá (esc, NODES, NODE_LABEL,
// STATUS, ago, when, titleOf, explanation, extractPrs, isHighRisk, fmtUsd, fmtTok, fmtMs, prefs)
// e window.RunListModel / window.UIKit. Só monta HTML; quem chama decide onde pôr e liga eventos.
(() => {
  const M = window.RunListModel;
  const K = window.UIKit;
  const DAY = 86400000;
  const STATE_GLYPH = { done: '✓', running: '◐', waiting: '‖', failed: '✕', queued: '○' };
  const stateKey = r => (r.status === 'committed' || M.isDone(r) ? 'done' : r.status === 'failed' ? 'failed'
    : M.needsYou(r) ? 'waiting' : r.status === 'running' ? 'running' : 'queued');
  const NONE = 'sem medição';
  const usd = v => (v == null ? NONE : fmtUsd(v));
  const tok = v => (v == null ? NONE : fmtTok(v));
  const pct = v => `${v > 0 ? '↑' : v < 0 ? '↓' : '='} ${Math.abs(Math.round(v * 100))}% vs 7 d anteriores`;

  // ---------------------------------------------------------------- filtro por estado (topo)
  const FILTERS = [['all', 'Todas'], ['need', 'Precisa de você'], ['run', 'Em andamento'], ['done', 'Concluídas']];
  const filterOf = () => (FILTERS.some(([k]) => k === prefs.runsFilter) ? prefs.runsFilter : 'all');
  function stateFilterHtml(list) {
    const cur = filterOf();
    const n = k => (k === 'all' ? list.length : list.filter(r => M.bucketOf(r) === k).length);
    return FILTERS.map(([k, label]) => `<button type="button" data-runs-filter="${k}" aria-pressed="${k === cur}">${label}<span class="num rl-count">${n(k)}</span></button>`).join('');
  }

  // ---------------------------------------------------------------- indicadores (kcards)
  const KCARDS = [
    ['cost', 'Custo médio por run', 'cost_tracking.totals.cost_usd (watcher)', 'Custo acima da média', k => usd(k.cost.value), 'down'],
    ['tokens', 'Tokens por run (mediana)', 'cost_tracking.totals, entrada + saída (watcher)', 'Consumindo tokens agora', k => tok(k.tokens.value), 'down'],
    ['rework', 'Retrabalho por run', 'state.retries', 'Com retrabalho (nova tentativa ou loop)', k => (k.rework.value == null ? NONE : k.rework.value.toLocaleString('pt-BR', { maximumFractionDigits: 1 })), 'down'],
  ];
  const kfOf = () => (KCARDS.some(c => c[0] === prefs.runsKf) ? prefs.runsKf : null);
  const sortOf = () => (['urg', 'cost', 'recent'].includes(prefs.runsSort) ? prefs.runsSort : 'urg');

  // Aplica filtro por estado e filtro do kcard (a busca do topo já veio em `list`).
  function applyFilters(list, all) {
    const f = filterOf(), kf = kfOf(), k = kf ? M.kpis(all) : null;
    return list.filter(r => (f === 'all' || M.bucketOf(r) === f) && (!kf || M.kfMatch(kf, r, k)));
  }

  function headHtml(all, sideBarHtml) {
    const k = M.kpis(all), kf = kfOf();
    const nc = M.nodeCost(all);
    const cards = KCARDS.map(([key, label, source, kfLabel, value, good]) => {
      const st = k[key], n = all.filter(r => M.kfMatch(key, r, k)).length, on = kf === key;
      const tone = st.delta == null ? 'flat' : (st.delta < 0) === (good === 'down') ? 'up' : 'waiting';
      return K.kcard({ key, label, value: value(k), source, tip: `Mostrar só: ${kfLabel}`, pressed: on,
        delta: st.delta == null ? '' : pct(st.delta), deltaTone: tone,
        series: st.series.length > 1 ? st.series : null, sparkLabel: `${label} por dia, últimos 14 dias`,
        hint: on ? 'filtrando · clique para limpar' : `ver ${n} ${n === 1 ? 'run' : 'runs'} →` });
    }).join('');
    const bar = nc ? `<div class="rl-nodecost">
        <span class="rl-nc-title">Custo por nó · 7 dias${nc.top.length ? ` · ${nc.top.map(n => NODE_LABEL[n] || n).join(' e ')} concentram o gasto` : ''}</span>
        <span class="rl-nc-bar" role="img" aria-label="${esc(`Custo por nó em 7 dias: ${nc.rows.map(x => `${NODE_LABEL[x.node] || x.node} ${x.share}%`).join(', ')}`)}">${nc.rows.filter(x => x.usd > 0).map(x =>
          `<span class="${x.share >= 20 ? 'hi' : ''}" style="flex:${x.usd} 1 0" title="${esc(`${NODE_LABEL[x.node] || x.node} · ${x.share}% · ${fmtUsd(x.usd)}`)}"></span>`).join('')}</span>
        <span class="rl-nc-legend">${nc.rows.map(x => `<span>${esc(NODE_LABEL[x.node] || x.node)} ${x.share}%</span>`).join('')}</span>
      </div>` : '';
    const sort = sortOf();
    const kfLabel = kf ? KCARDS.find(c => c[0] === kf)[3] : '';
    return `<section class="rl-kpis" aria-label="Indicadores dos últimos 7 dias">
        <div class="rl-team" role="status" aria-live="polite"><span class="rl-team-t"><i aria-hidden="true"></i>Todas as runs</span>
          <span class="num rl-team-line" title="Fonte: state.started_at e cost_tracking.totals.cost_usd">${k.runs7} ${k.runs7 === 1 ? 'run' : 'runs'} em 7 dias · ${usd(k.cost7)}</span>
          <span class="rl-team-note">indicadores abaixo: este projeto, últimos 7 dias</span></div>
        <div class="rl-kgrid">${cards}</div>
        ${bar}
      </section>
      <div class="rl-filters">
        ${kf ? K.filterChip({ label: kfLabel, act: 'clear-kcard' }) : ''}
        <div class="seg rl-sort" role="group" aria-label="Ordenar">${[['urg', 'Urgência'], ['cost', 'Custo'], ['recent', 'Recentes']].map(([v, l]) =>
          `<button type="button" data-runs-sort="${v}" aria-pressed="${v === sort}">${l}</button>`).join('')}</div>
        ${sideBarHtml}
      </div>`;
  }

  // ---------------------------------------------------------------- pipeline
  const nodeState = (r, key) => {
    const cur = r.status !== 'committed' && r.node === key;
    if (cur) return stateKey(r) === 'done' ? 'done' : stateKey(r);
    return r.nodes?.[key] === 'done' || r.status === 'committed' ? 'done' : 'pend';
  };
  const NODE_TEXT = { done: 'concluído', running: 'em execução', waiting: 'esperando você', failed: 'falhou', queued: 'na fila', pend: '—' };
  // size 'sm' = painel da run (artboard Main); 'lg' = detalhe (artboard RunDetail).
  function pipelineHtml(r, size = 'sm') {
    const keys = NODES.map(([k]) => k);
    const items = keys.map((key, i) => {
      const st = nodeState(r, key), next = i < keys.length - 1 ? nodeState(r, keys[i + 1]) : null;
      const meta = M.nodeMeta(r, key) || (size === 'lg' ? '' : NODE_TEXT[st]);
      return `<li class="pl-node ${st}${next && st === 'done' && next !== 'pend' ? ' line-done' : ''}">
        <span class="pl-track"><span class="pl-dot" aria-hidden="true">${st === 'pend' ? '' : STATE_GLYPH[st === 'done' ? 'done' : st]}</span></span>
        <span class="pl-name">${esc(NODE_LABEL[key] || key)}<span class="sr-only"> — ${NODE_TEXT[st] === '—' ? 'pendente' : NODE_TEXT[st]}</span></span>
        ${size === 'lg' ? `<span class="pl-state">${esc(st === 'pend' ? 'Pendente' : NODE_TEXT[st][0].toUpperCase() + NODE_TEXT[st].slice(1))}</span>` : ''}
        ${meta ? `<span class="pl-meta">${esc(meta)}</span>` : ''}
      </li>`;
    }).join('');
    return `<ol class="pl pl-${size}" aria-label="Pipeline">${items}</ol>`;
  }

  // Faixa dos últimos 7 dias (mesma conta da Linha do tempo).
  function strip7(r, now = Date.now()) {
    const { segs, tail } = M.segments(r, now);
    const from = now - 7 * DAY;
    const pos = t => ((Math.max(t, from) - from) / (7 * DAY)) * 100;
    const bars = segs.filter(s => s.to >= from).map(s => {
      const l = pos(s.from), w = Math.max(pos(s.to) - l, 0.6);
      return `<span class="tl7-seg ph${s.phase}" style="left:${l}%;width:${w}%" title="${esc(`${NODE_LABEL[s.node] || s.node} · ${when(new Date(s.from).toISOString())} → ${when(new Date(s.to).toISOString())}`)}"></span>`;
    });
    if (tail && tail.to > from && tail.blocked) {
      const l = pos(tail.from), w = Math.max(pos(tail.to) - l, 0.6);
      bars.push(`<span class="tl7-seg wait" style="left:${l}%;width:${w}%" title="Parado esperando você"></span>`);
    }
    return bars.join('');
  }
  const LEGEND = `<span class="tl7-k"><i class="ph0"></i>planejar</span><span class="tl7-k"><i class="ph1"></i>implementar</span><span class="tl7-k"><i class="ph2"></i>revisar e testar</span><span class="tl7-k"><i class="ph3"></i>commit</span><span class="tl7-k"><i class="wait"></i>esperando você</span>`;

  // ---------------------------------------------------------------- painel da run selecionada
  const stateLabel = r => STATUS[r.status] || r.status;
  const lastNote = r => [...(r.state?.agent_log || [])].reverse().find(a => a.note)?.note || '';
  function summaryHtml(r) {
    const t = titleOf(r), k = stateKey(r), ex = explanation(r), tt = M.totalsOf(r);
    const prs = extractPrs(r.state?.pull_request);
    const need = M.needsYou(r) && !M.isDone(r);
    const node = NODE_LABEL[r.node] || r.node || '—';
    const pos = NODES.findIndex(([x]) => x === r.node);
    const note = ex.note || (need ? lastNote(r) : '');
    const action = r.status === 'needs_human_review' ? ['Responder ao agente', 'chat'] : ['Abrir run', 'summary'];
    const segs = strip7(r);
    const act = M.activity(r);
    const at = M.attempts(r);
    return `<section class="rs" aria-label="Run selecionada">
      <div class="rs-in">
        <div class="rs-head">
          <div class="rs-chips">
            <span class="rs-ticket">${esc(t.num || r.taskId)}</span>
            <span class="pill ${k}"><span aria-hidden="true">${STATE_GLYPH[k]}</span>${esc(stateLabel(r))}</span>
            ${prs.length ? `<span class="rs-chip pr">PR ${esc(prs.length > 1 ? `${prs.length}` : prs[0].label || prs[0].id || '')}</span>` : ''}
            ${isHighRisk(r) ? '<span class="rs-chip risk">HIGH-RISK</span>' : ''}
          </div>
          <div class="rs-titlerow">
            <h1 class="rs-title">${esc(t.text)}</h1>
            <button type="button" class="rs-open" data-run-open="summary">Abrir run<kbd>↵</kbd></button>
            <button type="button" class="rs-close" data-run-close aria-label="Fechar a run (Esc)" title="Fechar (Esc)">×</button>
          </div>
        </div>
        ${need ? `<section class="rs-gate ${k}" aria-labelledby="rs-gt">
            <div class="rs-gate-text"><span class="rs-gate-kind">${esc(stateLabel(r))} · parado há ${esc(ago(r.updatedAt).replace(/^há /, ''))}</span>
              <h2 id="rs-gt">${esc(ex.title)}</h2><span class="rs-gate-meta">${esc(node)} · atualizado ${esc(ago(r.updatedAt))}</span></div>
            <button type="button" class="primary" data-run-open="${action[1]}">${action[0]}</button>
          </section>` : `<section class="rs-next" aria-labelledby="rs-nx"><h2 id="rs-nx">Próxima ação</h2><span>${esc(ex.title)}</span></section>`}
        ${note ? `<div class="rs-note"><span>${esc(ex.body)}</span><span class="rs-note-q">Última nota do agente: “${esc(note)}”</span></div>` : ''}
        <div class="rs-metrics">
          <div class="rs-m" title="Fonte: cost_tracking.totals.cost_usd (watcher)"><span>Custo até agora</span><b class="num">${esc(usd(tt.usd))}</b></div>
          <div class="rs-m" title="Fonte: cost_tracking.totals, entrada + saída"><span>Tokens</span><b class="num">${esc(tok(tt.tokens))}</b></div>
          <div class="rs-m" title="Fonte: cost_tracking.totals.duration_ms"><span>Duração</span><b class="num">${esc(tt.ms == null ? NONE : fmtMs(tt.ms))}</b></div>
          <div class="rs-m sm" title="Fonte: state.node"><span>Onde está</span><b class="num">${esc(r.status === 'committed' ? 'concluído' : `${node}${pos >= 0 ? ` · ${pos + 1}/7` : ''}`)}</b></div>
        </div>
        <section class="rs-sec" aria-labelledby="rs-pl"><h2 id="rs-pl" class="rs-h">Pipeline</h2>${pipelineHtml(r, 'sm')}</section>
        <section class="rs-sec" aria-labelledby="rs-tl"><h2 id="rs-tl" class="rs-h">Últimos 7 dias</h2>
          ${segs ? `<div class="tl7">${segs}</div><div class="tl7-legend"><span class="mono">há 7 d</span>${LEGEND}<span class="mono tl7-now">agora</span></div>`
            : `<p class="rs-empty">${r.status === 'pending' ? 'Ainda não começou: está na fila esperando um slot do watcher.' : 'Sem etapa registrada no agent_log nos últimos 7 dias.'}</p>`}
        </section>
        <section class="rs-card" aria-labelledby="rs-ac"><h2 id="rs-ac" class="rs-h">Atividade recente</h2>
          ${act.length ? `<ol class="rs-act">${act.map(a => `<li><i aria-hidden="true"></i><span><span>${esc(a.note || `${a.nodes.map(n => NODE_LABEL[n] || n).join(', ')} registrado`)}</span><span class="rs-act-t">${esc(ago(a.at))} · agente</span></span></li>`).join('')}</ol>`
            : '<span class="rs-empty">Sem eventos recentes deste run.</span>'}
        </section>
        ${at.length ? `<section class="rs-sec" aria-labelledby="rs-tt"><h2 id="rs-tt" class="rs-h">Tentativas do agente</h2>
          <table class="rs-att"><tbody>${at.map(x => `<tr><td class="mono"><i class="${x.usd == null ? '' : 'on'}" aria-hidden="true"></i>${esc(NODE_LABEL[x.node] || x.node)}</td>
            <td>${esc(x.runs == null ? '' : `${x.runs} despacho${x.runs === 1 ? '' : 's'}${x.retries ? ` · ${x.retries} nova${x.retries === 1 ? '' : 's'} tentativa${x.retries === 1 ? '' : 's'}` : ''}`)}</td>
            <td class="num mono muted">${esc(x.tokens == null ? NONE : `${fmtTok(x.tokens)} tok`)}</td><td class="num mono">${esc(usd(x.usd))}</td></tr>`).join('')}</tbody></table></section>` : ''}
        <p class="rs-foot">Projeção do estado das runs · não autoritativo · o state.json do run é a fonte.</p>
      </div>
    </section>`;
  }

  // ---------------------------------------------------------------- detalhe (RunDetail)
  function detailHeadHtml(r) {
    const t = titleOf(r), k = stateKey(r), tt = M.totalsOf(r);
    return `<header class="rd-head">
      <nav class="rd-crumbs" aria-label="Caminho"><button type="button" class="rd-back" data-run-back>Runs</button><span aria-hidden="true">›</span><span class="mono">${esc(t.num || r.taskId)}</span><span class="rd-crumb-title">${esc(t.text)}</span></nav>
      <span class="pill ${k}"><span aria-hidden="true">${STATE_GLYPH[k]} </span>${esc(r.state?.status === 'pre-build-failed' ? 'Build quebrado' : stateLabel(r))}</span>
      ${tt.usd == null && tt.tokens == null && tt.ms == null ? '' : `<span class="rd-totals num" title="Totais medidos pelo watcher · fonte: cost_tracking do state.json"><span>${esc(usd(tt.usd))}</span><span>${esc(tt.tokens == null ? NONE : `${fmtTok(tt.tokens)} tokens`)}</span><span>${esc(tt.ms == null ? NONE : fmtMs(tt.ms))}</span></span>`}
      <span class="rd-actions hero-top">
        <button type="button" class="ghost" data-copy-link>Copiar link</button>
        <button type="button" class="ghost" data-run-compare>Comparar</button>
      </span>
    </header>`;
  }

  // Faixa do pipeline + chips (loops, risco, onde foi lido) + faixa de parada.
  function detailBandHtml(r, stop) {
    const tt = M.totalsOf(r);
    const loops = tt.loops || 0;
    return `<div class="rd-band">
      ${pipelineHtml(r, 'lg')}
      <div class="rd-chips">
        ${loops ? `<span class="rd-loops mono">↺ ${loops} ${loops === 1 ? 'loop' : 'loops'} de retrabalho</span>` : ''}
        <span class="rd-chip-row">
          <span class="rd-chip">${isHighRisk(r) ? 'risco alto' : r.state?.risk_level ? `risco ${esc(r.state.risk_level === 'low' ? 'baixo' : r.state.risk_level)}` : 'risco não classificado'}</span>
          <button type="button" class="ghost rd-copy" data-copy="${esc(r.taskId)}" title="Copiar task-id">⎘ ${esc(r.taskId)}</button>
          <span class="rd-where">cópia: ${esc(r.pretask ? 'spec-gate (ainda sem task)' : r.location === 'main' ? 'checkout principal' : String(r.location || '').replace('worktree:', 'worktree '))}</span>
        </span>
      </div>
      ${stop ? `<div class="rd-stop ${stateKey(r)}" role="status"><i aria-hidden="true"></i><span><strong>${esc(stop.title)}</strong>${stop.since ? ` <span class="num">Parado há ${esc(stop.since)}.</span>` : ''}</span>
        <button type="button" class="lnk" data-dtab-go="${stop.tab}">${esc(stop.link)}</button></div>` : ''}
    </div>`;
  }

  function sideNavHtml(groups, cur) {
    return `<nav class="rd-side" aria-label="Abas da run">${groups.map(g => `<div class="rd-grp"><span class="rd-grp-h"><span>${g.n}</span>${esc(g.label)}</span>
      ${g.tabs.map(t => `<button type="button" class="rd-tab" data-rd-tab="${t.id}" aria-current="${t.id === cur}">${esc(t.label)}</button>`).join('')}</div>`).join('')}</nav>`;
  }

  window.RunsMain = { stateKey, filterOf, sortOf, kfOf, applyFilters, stateFilterHtml, headHtml, pipelineHtml, summaryHtml, detailHeadHtml, detailBandHtml, sideNavHtml, NONE };
})();
