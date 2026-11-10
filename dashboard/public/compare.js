// Comparar runs (artboard RunCompare): visão própria "comparar" (item do AppNav em Trabalho, logo
// depois de Runs). Entra pelo menu (escolhe A e B nos cartões) ou pelo "Comparar" da lista
// (modo de seleção limitado a 2 runs, em index.html), que abre já com o par. Dados:
// GET /api/compare/:a/:b (scripts/lib/run-comparator.js) e o resultado por nó da projeção do
// dashboard (run.nodes). A lógica das linhas fica em compare-model.js (testada sem DOM); aqui só o
// HTML, os eventos e o estado da tela. Run A = o que começou antes. Estado = glifo + rótulo + cor,
// nunca só a cor. Script clássico carregado depois do principal; usa os globais dele (runs, api,
// esc, STATUS, NODES, titleOf, when, select, Views). Estilos: screens/compare.css.
(() => {
  const M = window.CompareModel;
  const NA = M.NA;
  // ids: [a, b] (vazio = lado ainda não escolhido). only: "Só diferenças".
  let cmp = { ids: ['', ''], data: null, loading: false, error: null, only: false };
  let foldOpen = false; // <details> do state.json: continua aberto entre repinturas
  const root = document.createElement('div');
  root.className = 'cmp';
  let lastHtml = '';
  // Repintura com um <select> focado recria o elemento e fecha a lista nativa: adia até o blur,
  // salvo quando a própria tela pediu (escolha de run, troca, filtro).
  let force = false, dirty = false;

  const startOf = id => {
    const r = runs.get(id);
    return Date.parse(r?.state?.started_at || r?.updatedAt || '') || 0;
  };
  const both = () => Boolean(cmp.ids[0] && cmp.ids[1]);
  const active = () => window.Views?.current() === 'comparar';

  function paint({ own = false } = {}) {
    if (own) force = true;
    if (active()) window.Views.refresh();
  }

  function setPair(ids, { sort = false } = {}) {
    const next = sort ? [...ids].sort((a, b) => startOf(a) - startOf(b)) : ids;
    cmp = { ...cmp, ids: next, data: null, error: null, loading: Boolean(next[0] && next[1]) };
    if (cmp.loading) load();
    paint({ own: true });
  }

  // Botão "Comparar" da lista: abre a visão já com o par, A = o que começou antes.
  function open(ids) {
    setPair(ids, { sort: true });
    window.Views?.setView('comparar');
  }

  function swap() {
    setPair([cmp.ids[1], cmp.ids[0]]);
  }

  // O run escolhido já estava do outro lado: troca A e B (como no artboard).
  function pick(side, id) {
    const i = side === 'A' ? 0 : 1;
    const ids = [...cmp.ids];
    if (id && id === ids[1 - i]) { ids[1 - i] = ids[i]; ids[i] = id; } else ids[i] = id;
    setPair(ids);
  }

  async function load() {
    const want = cmp.ids.join('|');
    try {
      const data = await api(`/api/compare/${encodeURIComponent(cmp.ids[0])}/${encodeURIComponent(cmp.ids[1])}`);
      if (cmp.ids.join('|') === want) cmp = { ...cmp, data, loading: false };
    } catch (e) {
      if (cmp.ids.join('|') === want) cmp = { ...cmp, error: e.message, loading: false };
    }
    paint({ own: true });
  }

  // ------------------------------------------------------------------ peças
  const isOpen = r => r && ['running', 'in_progress', 'needs_human_review', 'awaiting_approval', 'spec-pending-approval', 'spec-change-pending-approval'].includes(r.status);
  // Status do run → pílula do artboard (✓ concluído, ◐ executando, ‖ parado, ✕ falhou, ○ na fila).
  const TONE = {
    committed: ['done', '✓'], running: ['running', '◐'],
    needs_human_review: ['waiting', '‖'], awaiting_approval: ['waiting', '‖'],
    failed: ['failed', '✕'], escalated: ['failed', '✕'], 'pre-build-failed': ['failed', '✕'],
    pending: ['queued', '○'],
  };
  function statusPill(status) {
    if (!status || status === NA) return `<span class="pill queued"><span aria-hidden="true">?</span>${NA}</span>`;
    const [cls, glyph] = Object.hasOwn(TONE, status) ? TONE[status] : ['queued', '○'];
    const label = Object.hasOwn(STATUS, status) ? STATUS[status] : status;
    return `<span class="pill ${cls}"><span aria-hidden="true">${glyph}</span>${esc(label)}</span>`;
  }
  const cmpPill = c => `<span class="cmp-st ${c.kind}"><span aria-hidden="true">${c.glyph}</span>${c.label}</span>`;
  const resPill = s => `<span class="pill ${s.tone}"><span aria-hidden="true">${s.glyph}</span>${esc(s.label)}</span>`;
  const firstTag = text => `<span class="cmp-first">${text}</span>`;
  const sub = (txt, extra = '') => (txt ? `<span class="cmp-sub${extra}">${esc(txt)}</span>` : '');

  function options(selfId, otherId) {
    const ids = [...runs.keys()].sort((a, b) => startOf(b) - startOf(a));
    if (selfId && !ids.includes(selfId)) ids.unshift(selfId); // run fora da lista (arquivado)
    const label = id => {
      const r = runs.get(id);
      const t = r ? titleOf(r) : null;
      const started = r?.state?.started_at || r?.updatedAt;
      return [id, t?.num, started ? when(started) : ''].filter(Boolean).join(' · ') + (id === otherId ? ' (no outro lado)' : '');
    };
    return `<option value=""${selfId ? '' : ' selected'}>Escolher run…</option>`
      + ids.map(id => `<option value="${esc(id)}"${id === selfId ? ' selected' : ''}>${esc(label(id))}</option>`).join('');
  }

  function picker(side, id, otherId, facts) {
    const r = runs.get(id);
    const t = r ? titleOf(r) : null;
    const started = r?.state?.started_at || facts?.startedAt || r?.updatedAt;
    const status = r?.status || cmp.data?.[side === 'A' ? 'runA' : 'runB']?.status;
    const dur = facts ? M.runDuration(facts, isOpen(r)) : null;
    const selId = `cmp-sel-${side.toLowerCase()}`;
    const body = id ? `<div class="cmp-card-body">
        <span class="cmp-meta mono"><span class="cmp-id">${esc(id)}</span>${t?.num ? `<span>· ${esc(t.num)}</span>` : ''}${started ? `<span>· ${esc(when(started))}</span>` : ''}</span>
        <span class="cmp-name">${esc(t ? t.text : id)}</span>
        <span class="cmp-state">${statusPill(status)}${dur ? `<span class="num cmp-dur" title="Fonte: started_at → updated_at do state.json">${esc(dur)}</span>` : ''}</span>
      </div>
      <div class="cmp-links"><button type="button" class="cmp-chip" data-cmp-open="${esc(id)}"${r ? '' : ' disabled title="Run fora da lista atual"'}>Abrir run</button></div>` : '';
    return `<div class="cmp-card">
      <div class="cmp-card-top"><span class="cmp-side" aria-hidden="true">${side}</span><label for="${selId}" class="cmp-card-label">Run ${side}</label>
        <select id="${selId}" data-cmp-pick="${side}">${options(id, otherId)}</select></div>
      ${body}</div>`;
  }

  const gridHead = cols => `<div class="cmp-grid-head">${cols.map(c => `<span>${c}</span>`).join('')}</div>`;

  function inputsSection(m, d) {
    const [a, b] = cmp.ids;
    const rows = m.inputs.map(r => {
      const first = m.div.firstKey === r.key;
      return `<div id="cmp-${esc(r.key)}" class="cmp-row cmp-in${first ? ' is-first' : ''}">
        <span class="cmp-cell-label"><span class="cmp-strong">${esc(r.label)}</span>${first ? firstTag('1ª DIVERGÊNCIA') : ''}</span>
        <span class="cmp-val"><span class="mono${r.a === NA ? ' cmp-na' : ''}">${esc(r.a)}</span>${sub(r.aSub)}</span>
        <span class="cmp-val"><span class="mono${r.b === NA ? ' cmp-na' : ''}">${esc(r.b)}</span>${sub(r.bSub)}</span>
        ${cmpPill(r.cmp)}</div>`;
    }).join('');
    return `<section class="cmp-sec" aria-labelledby="cmp-in-h">
      <div class="cmp-sec-head"><h2 id="cmp-in-h">Entradas do run</h2><span class="cmp-hint">spec e provider gravados por cada run</span></div>
      <div class="cmp-panel"><div class="cmp-tbl cmp-tbl-in">${gridHead(['Campo', `A · ${esc(a)}`, `B · ${esc(b)}`, 'Comparação'])}${rows}
        ${m.inputs.length ? '' : '<p class="cmp-empty">Nenhuma diferença nas entradas.</p>'}</div></div></section>`;
  }

  function nodesSection(m) {
    const rows = m.nodes.map(n => {
      const isFirstNode = m.div.firstNodeKey === n.key;
      const label = m.div.firstKey === n.key ? '1ª DIVERGÊNCIA' : '1º NÓ QUE DIVERGE';
      const side = s => `<span class="cmp-val">
          <span class="cmp-node-top">${resPill(s)}${s.model ? `<span class="cmp-model${s.modelDiff ? ' diff' : ''}${s.modelKnown === false ? ' cmp-na' : ''}">${esc(s.model)}</span>` : ''}</span>
          <span class="num mono cmp-line">${esc(s.line)}</span>${sub(s.note)}</span>`;
      return `<div id="cmp-${esc(n.key)}" class="cmp-row cmp-nd${isFirstNode ? ' is-first' : ''}">
        <span class="cmp-cell-label"><span class="mono cmp-strong">${esc(n.node)}</span>${isFirstNode ? firstTag(label) : ''}</span>
        ${side(n.sides[0])}${side(n.sides[1])}${cmpPill(n.cmp)}</div>`;
    }).join('');
    return `<section id="cmp-nodes" class="cmp-sec" aria-labelledby="cmp-nd-h">
      <div class="cmp-sec-head"><h2 id="cmp-nd-h">Nós do pipeline</h2><span class="cmp-hint">na ordem do workflow · modelo, duração, tentativas, custo e resultado de cada nó</span></div>
      <div class="cmp-panel"><div class="cmp-tbl cmp-tbl-nd">${gridHead(['Nó', 'A', 'B', 'Comparação'])}${rows}
        ${m.nodes.length ? '' : '<p class="cmp-empty">Os dois runs percorreram os nós com o mesmo modelo, tentativas e resultado.</p>'}</div></div></section>`;
  }

  function costSection(m) {
    const rows = m.costs.map(r => `<div class="cmp-row cmp-co" title="Fonte: cost_tracking do state.json (telemetria, não verdade contábil)">
        <span>${esc(r.label)}</span>
        <span class="cmp-num"><span class="num mono${r.a === M.SEM ? ' cmp-na' : ''}">${esc(r.a)}</span>${sub(r.aSub)}</span>
        <span class="cmp-num"><span class="num mono${r.b === M.SEM ? ' cmp-na' : ''}">${esc(r.b)}</span>${sub(r.bSub)}</span>
        <span class="num mono cmp-d ${r.tone}">${esc(r.d)}</span></div>`).join('');
    return `<section class="cmp-sec" aria-labelledby="cmp-co-h">
      <div class="cmp-sec-head"><h2 id="cmp-co-h">Custo e tokens</h2><span class="cmp-hint">telemetria do provider · sinal, não verdade contábil</span></div>
      <div class="cmp-panel"><div class="cmp-tbl cmp-tbl-co"><div class="cmp-grid-head"><span>Medida</span><span class="r">A</span><span class="r">B</span><span class="r">B − A</span></div>${rows}</div></div></section>`;
  }

  function evidenceSection(m) {
    const rows = m.evs.map(r => `<div class="cmp-row cmp-ev">
        <span class="cmp-cell-label"><span>${esc(r.label)}</span><span class="mono cmp-ev-st ${r.cmp.kind}"><span aria-hidden="true">${r.cmp.glyph} </span>${r.stLabel}</span></span>
        ${r.sides.map(s => `<span class="cmp-val"><span class="cmp-ev-v ${s.tone}"><span aria-hidden="true">${s.glyph}</span>${esc(s.label)}</span><span class="mono cmp-sub">${esc(s.note)}</span></span>`).join('')}
      </div>`).join('');
    return `<section class="cmp-sec" aria-labelledby="cmp-ev-h">
      <div class="cmp-sec-head"><h2 id="cmp-ev-h">Evidências</h2><span class="cmp-hint">artefatos gravados por cada run</span></div>
      <div class="cmp-panel"><div class="cmp-tbl cmp-tbl-ev">${gridHead(['Artefato', 'A', 'B'])}${rows}
        ${m.evs.length ? '' : '<p class="cmp-empty">Mesmo estado nas evidências.</p>'}</div></div></section>`;
  }

  // ------------------------------------------------------------------ fora do artboard (prompt de canvas no PR)
  // Dados que o app já mostrava e o artboard não tem: veredito do comparador, as outras métricas e
  // os campos do state.json que mudaram. Ficam no fim, até o canvas decidir.
  const VERDICT = {
    'B-better': { cls: 'better', glyph: '✓', title: 'Run B melhor' },
    'A-better': { cls: 'worse', glyph: '✕', title: 'Run B pior' },
    inconclusive: { cls: 'unknown', glyph: '?', title: 'Inconclusivo' },
    equivalent: { cls: 'same', glyph: '=', title: 'Equivalentes' },
  };
  function extrasSection(d) {
    const v = (Object.hasOwn(VERDICT, d.verdict) && VERDICT[d.verdict]) || { cls: 'same', glyph: '·', title: d.verdict };
    const keys = ['status', 'node', 'test_result', 'planScore', 'retries'];
    const fmt = x => (x === NA || x === null || x === undefined ? NA : typeof x === 'string' ? x : JSON.stringify(x));
    const mark = m => (m.better === 'B' ? '<span class="cmp-ev-v done"><span aria-hidden="true">✓</span>melhor</span>'
      : m.better === 'A' ? '<span class="cmp-ev-v failed"><span aria-hidden="true">✕</span>pior</span>' : '');
    const rows = d.metrics.filter(m => keys.includes(m.key)).map(m => `<div class="cmp-row cmp-co">
        <span>${esc(m.label)}</span><span class="cmp-num"><span class="mono${fmt(m.a) === NA ? ' cmp-na' : ''}">${esc(fmt(m.a))}</span></span>
        <span class="cmp-num"><span class="mono${fmt(m.b) === NA ? ' cmp-na' : ''}">${esc(fmt(m.b))}</span></span>
        <span class="cmp-num">${mark(m) || `<span class="mono cmp-na">${esc(typeof m.delta === 'number' ? String(m.delta) : fmt(m.delta))}</span>`}</span></div>`).join('');
    const cell = x => (x === NA ? `<span class="cmp-na">${NA}</span>` : esc(fmt(x)));
    const state = d.stateDiff.length ? `<div class="cmp-tbl cmp-tbl-ev">${gridHead(['Campo', 'A', 'B'])}${d.stateDiff.map(s => `<div class="cmp-row cmp-ev">
        <span class="mono">${esc(s.key)}</span><span class="mono cmp-val">${cell(s.a)}</span><span class="mono cmp-val">${cell(s.b)}</span></div>`).join('')}</div>`
      : '<p class="cmp-empty">Nenhum campo mudou.</p>';
    const src = r => `${esc(r.source ?? NA)} · custo: ${esc(r.costSource ?? 'sem cost_tracking')}${r.replayOf ? ` · replay de ${esc(r.replayOf)}` : ''}`;
    return `<section class="cmp-sec cmp-extra" aria-labelledby="cmp-vd-h">
      <div class="cmp-sec-head"><h2 id="cmp-vd-h">Veredito do comparador</h2><span class="cmp-hint">status → testes → tokens (limiar ${esc(String(d.significantPct))}%)</span></div>
      <div class="cmp-verdict ${v.cls}"><div class="cmp-verdict-top"><span class="cmp-verdict-glyph" aria-hidden="true">${v.glyph}</span><strong>${esc(v.title)}</strong><span class="mono cmp-sub">verdict: ${esc(d.verdict)}</span></div>
        <p>${esc(d.summary)}</p><span class="cmp-sub">${esc(d.verdictReason)}</span></div>
      <div class="cmp-panel"><div class="cmp-tbl cmp-tbl-co"><div class="cmp-grid-head"><span>Métrica</span><span class="r">A</span><span class="r">B</span><span class="r">B × A</span></div>${rows}</div></div>
      <details class="cmp-panel cmp-fold"${foldOpen ? ' open' : ''}><summary>Campos do state.json que mudaram <span class="num cmp-sub">${d.stateDiff.length}</span></summary>${state}
        <p class="cmp-sub cmp-fold-note">Fora da lista: ${esc(d.stateDiffIgnored.join(', '))}. Origem — A: ${src(d.runA)}; B: ${src(d.runB)}.</p></details>
    </section>`;
  }

  // ------------------------------------------------------------------ tela
  function html() {
    const [a, b] = cmp.ids;
    const d = cmp.data;
    const intro = `<div class="cmp-intro">
        <span class="cmp-eyebrow">Runs · dois runs do mesmo repositório</span>
        <h1 id="cmp-h">Comparar runs</h1>
        <p>O que mudou entre dois runs: spec, provider, modelos, o caminho pelo pipeline, custo e evidências. A primeira diferença aparece marcada. Nada aqui altera os runs.</p>
      </div>
      <section class="cmp-runs" aria-label="Runs comparados">${picker('A', a, b, d?.facts?.a)}${picker('B', b, a, d?.facts?.b)}</section>`;
    if (!both()) return `${intro}<p class="cmp-status" role="status">Escolha o Run A e o Run B para comparar.</p>`;
    if (cmp.loading) return `${intro}<p class="cmp-status" role="status">Comparando…</p>`;
    if (cmp.error) return `${intro}<p class="cmp-error" role="alert"><span aria-hidden="true">✕</span> Não deu para comparar: ${esc(cmp.error)}</p>`;
    const ra = runs.get(a), rb = runs.get(b);
    const m = M.build(d, { order: NODES.map(([k]) => k), resultsA: ra?.nodes || null, resultsB: rb?.nodes || null, openA: isOpen(ra), openB: isOpen(rb), only: cmp.only });
    const warn = [d.runA, d.runB].filter(r => r.readError).map(r => `<p class="cmp-error"><span aria-hidden="true">‖</span> Run ${r === d.runB ? 'B' : 'A'}: ${esc(r.readError)} — os campos aparecem como N/A.</p>`).join('');
    const div = m.div;
    const view = (on, label) => `<button type="button" data-cmp-only="${on}" aria-pressed="${cmp.only === on}">${label}</button>`;
    return `${intro}${warn}
      <section class="cmp-div ${div.kind}" aria-labelledby="cmp-dv-h">
        <div class="cmp-div-top"><span class="cmp-div-glyph" aria-hidden="true">${div.glyph}</span><h2 id="cmp-dv-h">${esc(div.title)}</h2></div>
        <p class="cmp-div-body">${esc(div.body)}</p>
        ${div.node ? `<p class="cmp-div-node">${esc(div.node)}</p>` : ''}
        <div class="cmp-div-foot">${div.firstKey ? `<a class="cmp-chip" href="#cmp-${esc(div.firstKey)}" data-cmp-jump="cmp-${esc(div.firstKey)}">Ir para a linha marcada</a>` : ''}
          <span class="cmp-hint">Divergência conta spec, provider, modelo, tentativas e resultado; duração e custo variam em todo run e não contam.</span></div>
      </section>
      <div class="cmp-toolbar">
        <div class="cmp-seg" role="group" aria-label="Linhas exibidas">${view(false, 'Tudo')}${view(true, 'Só diferenças')}</div>
        <span class="num cmp-hint">${esc(m.diffText)} entre ${esc(a)} e ${esc(b)}</span>
        <span class="cmp-legend"><span><span aria-hidden="true">= </span>igual</span><span><span aria-hidden="true" class="ne">≠ </span>difere</span><span><span aria-hidden="true">? </span>N/A, com motivo</span></span>
      </div>
      ${inputsSection(m, d)}
      ${nodesSection(m)}
      <div class="cmp-pair">${costSection(m)}${evidenceSection(m)}</div>
      ${extrasSection(d)}
      <p class="cmp-origin">Origem: spec_hash, history, status e testes vêm do state.json de cada run (GET /api/compare); o resultado por nó, da projeção dos runs do dashboard; custo, tokens, modelo e provider, do cost_tracking (telemetria do provider). Esta tela só lê: decisões sobre um run ficam na run e nos gates.</p>`;
  }

  // Nó persistente (views.js não remonta): o <select> aberto e o foco não caem a cada evento ao vivo.
  function render() {
    syncSwap();
    const h = html();
    const picking = document.activeElement?.matches?.('.cmp [data-cmp-pick]');
    if (h !== lastHtml && picking && !force) { dirty = true; return root; }
    force = false;
    if (h !== lastHtml) {
      const focusSel = document.activeElement?.closest?.('.cmp [data-cmp-pick], .cmp [data-cmp-only]');
      const key = focusSel ? (focusSel.dataset.cmpPick ? `[data-cmp-pick="${focusSel.dataset.cmpPick}"]` : `[data-cmp-only="${focusSel.dataset.cmpOnly}"]`) : null;
      root.innerHTML = h;
      lastHtml = h;
      if (key) root.querySelector(key)?.focus();
    }
    return root;
  }

  root.addEventListener('focusout', e => {
    if (dirty && e.target.matches?.('[data-cmp-pick]')) { dirty = false; setTimeout(() => paint({ own: true }), 0); }
  });
  root.addEventListener('toggle', e => { if (e.target.matches?.('.cmp-fold')) foldOpen = e.target.open; }, true);
  root.addEventListener('change', e => {
    const s = e.target.closest('[data-cmp-pick]');
    if (s) pick(s.dataset.cmpPick, s.value);
  });
  root.addEventListener('click', e => {
    const o = e.target.closest('[data-cmp-open]');
    if (o && runs.has(o.dataset.cmpOpen)) { window.Views.setView('runs'); select(o.dataset.cmpOpen, { open: true }); return; }
    const v = e.target.closest('[data-cmp-only]');
    if (v) { cmp = { ...cmp, only: v.dataset.cmpOnly === 'true' }; paint({ own: true }); return; }
    const j = e.target.closest('[data-cmp-jump]');
    if (j) { e.preventDefault(); root.querySelector(`#${CSS.escape(j.dataset.cmpJump)}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' }); }
  });

  // Topo (barra da shell): pílula "projeção · só leitura" e "Trocar A e B" (S), só nesta visão.
  document.querySelector('.crumbs-top')?.insertAdjacentHTML('afterend', '<span class="cmp-top-pill mono">projeção · só leitura</span>');
  document.querySelector('.topbar-right')?.insertAdjacentHTML('afterbegin', `<button type="button" class="cmp-top-swap" data-cmp-swap aria-label="Trocar A e B (atalho S)">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 4L3 8l4 4M3 8h14M17 20l4-4-4-4M21 16H7"/></svg>Trocar A e B<kbd>S</kbd></button>`);
  const swapBtn = document.querySelector('[data-cmp-swap]');
  swapBtn?.addEventListener('click', () => { if (both()) swap(); });
  // Par incompleto: o botão do topo fica desabilitado (nada para trocar).
  const syncSwap = () => { if (swapBtn) swapBtn.disabled = !both(); };

  // S troca A e B, D alterna "Só diferenças" (fora de campo de texto e sem modificador).
  document.addEventListener('keydown', e => {
    if (!active() || e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || e.target?.isContentEditable
      || /^(INPUT|TEXTAREA|SELECT)$/.test(e.target?.tagName || '')) return;
    // Diálogo, paleta ou painel aberto por cima: a tecla é dele.
    if (document.querySelector('.overlay:not([hidden]), .wctl-panel:not([hidden]), dialog[open]')) return;
    const k = e.key.toLowerCase();
    if (k === 's' && both()) { e.preventDefault(); swap(); }
    else if (k === 'd') { e.preventDefault(); cmp = { ...cmp, only: !cmp.only }; paint({ own: true }); }
  });

  window.Compare = { open, swap, pick, render, active, html, close() {} };
  // Aberta direto por #comparar: o shell montou a visão antes deste script existir.
  if (active()) window.Views.refresh();
})();
