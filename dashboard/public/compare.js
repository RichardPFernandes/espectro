// Comparação de dois runs lado a lado (GET /api/compare/:taskIdA/:taskIdB →
// scripts/lib/run-comparator.js). Entra pelo botão "Comparar" da lista (modo de seleção
// limitado a 2 runs, em index.html) e ocupa o painel principal até outro run ser aberto.
// Run A = o que começou antes. Melhor/pior de B é sempre glifo + rótulo + cor
// (✓ melhor, ✕ pior, = igual), nunca só a cor. Script clássico carregado depois do
// principal; usa os globais dele (runs, api, esc, fmtTok, STATUS, titleOf, when...).
// Estilos: screens/compare.css.
(() => {
  const NA = 'N/A';
  let cmp = null; // { ids: [a, b], loading, data, error }

  const startOf = id => {
    const r = runs.get(id);
    return Date.parse(r?.state?.started_at || r?.updatedAt || '') || 0;
  };

  function open(ids) {
    cmp = { ids: [...ids].sort((a, b) => startOf(a) - startOf(b)), loading: true };
    renderDetail();
    load();
  }

  function swap() {
    if (!cmp) return;
    cmp = { ids: [cmp.ids[1], cmp.ids[0]], loading: true };
    renderDetail();
    load();
  }

  function close() {
    cmp = null;
  }

  async function load() {
    const want = cmp.ids.join('|');
    try {
      const data = await api(`/api/compare/${encodeURIComponent(cmp.ids[0])}/${encodeURIComponent(cmp.ids[1])}`);
      if (cmp?.ids.join('|') === want) cmp = { ids: cmp.ids, data };
    } catch (e) {
      if (cmp?.ids.join('|') === want) cmp = { ids: cmp.ids, error: e.message };
    }
    if (cmp) renderDetail();
  }

  // ------------------------------------------------------------------ formatação
  function fmt(v, format) {
    if (v === NA || v === null || v === undefined) return NA;
    if (format === 'int') return fmtTok(v);
    if (format === 'usd') return fmtUsd(v);
    if (format === 'ms') return fmtMs(v);
    return typeof v === 'string' ? v : JSON.stringify(v);
  }

  // Leitura do delta para B: melhorou / piorou / igual / sem medição. Forma (glifo) +
  // rótulo + cor; "forte" (fundo preenchido) se passou do limiar de significância
  // (> significantPct ou mudança de status/testes).
  const MARK = {
    B: { cls: 'better', glyph: '✓', text: 'melhor', sr: 'Run B melhorou' },
    A: { cls: 'worse', glyph: '✕', text: 'pior', sr: 'Run B piorou' },
  };
  function mark(row) {
    const m = MARK[row.better];
    if (!m) return '';
    const strong = row.significant ? ' strong' : '';
    const sr = `${m.sr}${row.significant ? ', diferença significativa' : ''}`;
    return `<span class="cmp-mark ${m.cls}${strong}" title="${esc(sr)}"><span aria-hidden="true">${m.glyph}</span>${m.text}<span class="sr-only"> — ${esc(sr)}</span></span>`;
  }

  function fmtDelta(row) {
    if (typeof row.delta !== 'number') return row.delta === NA ? NA : String(row.delta);
    if (row.delta === 0) return '=';
    const sign = row.delta > 0 ? '+' : '−';
    const pct = row.deltaPct !== NA ? ` (${row.deltaPct > 0 ? '+' : ''}${row.deltaPct}%)` : '';
    return `${sign}${fmt(Math.abs(row.delta), row.format)}${pct}`;
  }

  // Célula B − A: número com sinal (texto neutro) + marca melhor/pior.
  function deltaCell(row) {
    const txt = fmtDelta(row);
    const quiet = txt === NA || txt === '=' ? ' cmp-quiet' : '';
    return `<td class="n cmp-delta${quiet}${row.significant ? ' cmp-strong' : ''}"><span class="cmp-delta-in"><span class="num">${esc(txt)}</span>${mark(row)}</span></td>`;
  }

  const valueCell = (v, format, extra = '') => {
    const s = fmt(v, format);
    return `<td class="n${s === NA ? ' cmp-quiet' : ''}"><span class="num">${esc(s)}</span>${extra}</td>`;
  };

  const runTitle = id => {
    const r = runs.get(id);
    return r ? titleOf(r) : null;
  };

  // Status do pipeline → pílula com glifo (✓ concluído, ◐ em execução, ‖ aguardando
  // humano, ✕ falhou, ○ na fila). Rótulo vem de STATUS do principal; valor cru como fallback.
  const TONE = {
    committed: ['done', '✓'], running: ['running', '◐'],
    needs_human_review: ['waiting', '‖'], awaiting_approval: ['waiting', '‖'],
    failed: ['failed', '✕'], escalated: ['failed', '✕'], 'pre-build-failed': ['failed', '✕'],
    pending: ['queued', '○'],
  };
  function statusPill(status) {
    if (!status || status === NA) return `<span class="pill queued"><span aria-hidden="true">?</span>${NA}</span>`;
    const [cls, glyph] = TONE[status] || ['queued', '○'];
    return `<span class="pill ${cls}"><span aria-hidden="true">${glyph}</span>${esc(STATUS[status] || status)}</span>`;
  }

  // Custo com runs sem custo calculável (complete: false) é subtotal, não total.
  function partialMark(m, side) {
    if (m.complete?.[side] !== false || m[side] === NA) return '';
    const n = m.missing?.[side];
    return ` <small class="cmp-partial" title="Soma parcial: ${esc(String(n ?? '?'))} run(s) sem custo calculável"><span aria-hidden="true">◐</span> parcial</small>`;
  }

  function section(id, title, hint, body) {
    return `<section class="cmp-sec" aria-labelledby="${id}">
      <div class="cmp-sec-head"><h3 id="${id}" class="t-heading">${title}</h3>${hint ? `<span class="t-caption">${hint}</span>` : ''}</div>
      ${body}</section>`;
  }

  const tableHead = (first, last = 'B − A') =>
    `<thead><tr><th scope="col">${first}</th><th scope="col" class="n">Run A</th><th scope="col" class="n">Run B</th><th scope="col" class="n">${last}</th></tr></thead>`;

  function metricsTable(metrics) {
    const rows = metrics.map(m => `<tr>
        <th scope="row">${esc(m.label)}</th>
        ${valueCell(m.a, m.format, partialMark(m, 'a'))}
        ${valueCell(m.b, m.format, partialMark(m, 'b'))}
        ${deltaCell(m)}</tr>`).join('');
    return `<div class="panel cmp-wrap"><table class="dtable cmp-table">${tableHead('Métrica')}<tbody>${rows}</tbody></table></div>`;
  }

  function tokensTable(t) {
    if (!t.nodes.length) return '<p class="panel cmp-empty">N/A — nenhum dos runs tem cost_tracking.</p>';
    const row = (label, r, strong) => {
      const better = typeof r.delta === 'number' && r.delta !== 0 ? (r.delta < 0 ? 'B' : 'A') : null;
      const cells = { ...r, format: 'int', better };
      return `<tr${strong ? ' class="cmp-total"' : ''}><th scope="row">${esc(label)}</th>${valueCell(r.a, 'int')}${valueCell(r.b, 'int')}${deltaCell(cells)}</tr>`;
    };
    return `<div class="panel cmp-wrap"><table class="dtable cmp-table">${tableHead('Nó')}
      <tbody>${t.nodes.map(r => row(NODE_LABEL[r.node] || r.node, r)).join('')}${row('Total', t.total, true)}</tbody></table></div>`;
  }

  function nodesBlock(n) {
    const list = xs => (xs.length ? xs.map(x => `<code class="tag">${esc(x)}</code>`).join(' ') : '<span class="cmp-muted">nenhum</span>');
    const loops = n.both.filter(x => n.executions[x].a !== n.executions[x].b);
    return `<dl class="panel cmp-dl">
      <div><dt class="label">Só em A</dt><dd>${list(n.onlyInA)}</dd></div>
      <div><dt class="label">Só em B</dt><dd>${list(n.onlyInB)}</dd></div>
      ${loops.length ? `<div><dt class="label">Execuções diferentes</dt><dd>${loops.map(x => `<code class="tag">${esc(x)}</code> <span class="num mono">${n.executions[x].a}→${n.executions[x].b}</span>`).join(', ')}</dd></div>` : ''}
    </dl>`;
  }

  function testsBlock(tr) {
    return `<dl class="panel cmp-dl">
      <div><dt class="label">Run A · ${esc(tr.a.outcome)}</dt><dd>${esc(tr.a.summary)}</dd></div>
      <div><dt class="label">Run B · ${esc(tr.b.outcome)}</dt><dd>${esc(tr.b.summary)}</dd></div>
    </dl>`;
  }

  function stateTable(diff, ignored) {
    if (!diff.length) return '<p class="cmp-empty">Nenhum campo mudou.</p>';
    const cell = v => (v === NA ? `<span class="cmp-muted">${NA}</span>` : esc(fmt(v)));
    return `<div class="cmp-wrap"><table class="dtable cmp-table cmp-state">
      <thead><tr><th scope="col">Campo</th><th scope="col">Run A</th><th scope="col">Run B</th></tr></thead>
      <tbody>${diff.map(d => `<tr><th scope="row"><code>${esc(d.key)}</code></th><td>${cell(d.a)}</td><td>${cell(d.b)}</td></tr>`).join('')}</tbody>
    </table></div><p class="source-note cmp-ignored">Fora da lista: ${esc(ignored.join(', '))}.</p>`;
  }

  // Cartão de um lado (A/B). info = runA/runB da resposta (depois de carregar).
  function runCard(side, id, info) {
    const t = runTitle(id);
    const r = runs.get(id);
    const status = info ? info.status : r?.state?.status;
    const started = r?.state?.started_at || r?.updatedAt;
    const meta = [
      `<span class="cmp-id">${esc(id)}</span>`,
      t?.num ? `<span>· ${esc(t.num)}</span>` : '',
      started ? `<span>· ${esc(when(started))}</span>` : '',
    ].join('');
    const src = info ? `<span class="t-caption mono cmp-src">origem: ${esc(info.source ?? NA)} · custo: ${esc(info.costSource ?? NA)}${info.replayOf ? ` · replay de ${esc(info.replayOf)}` : ''}</span>` : '';
    return `<article class="panel cmp-card" aria-label="Run ${side}">
      <div class="cmp-card-top"><span class="cmp-side" aria-hidden="true">${side}</span><span class="cmp-card-label">Run ${side}</span>${statusPill(status)}</div>
      <div class="cmp-card-body">
        <span class="cmp-meta mono">${meta}</span>
        <span class="cmp-name">${esc(t ? t.text : id)}</span>
        ${src}
      </div>
      <div class="cmp-card-actions"><button type="button" class="btn lg" data-cmp-open="${esc(id)}"${runs.has(id) ? '' : ' disabled title="Run fora da lista atual"'}>Abrir run</button></div>
    </article>`;
  }

  // Veredito: glifo + título + cor; texto do servidor intacto.
  const VERDICT = {
    'B-better': { cls: 'better', glyph: '✓', title: 'Run B melhor' },
    'A-better': { cls: 'worse', glyph: '✕', title: 'Run B pior' },
    inconclusive: { cls: 'unknown', glyph: '?', title: 'Inconclusivo' },
    equivalent: { cls: 'same', glyph: '=', title: 'Equivalentes' },
  };

  function html() {
    const [a, b] = cmp.ids;
    const d = cmp.data;
    const head = `<header class="cmp-head">
        <div class="cmp-intro">
          <span class="label">Runs · A × B</span>
          <h2 class="t-display">Comparação de runs</h2>
          <p class="cmp-lead">O que mudou entre dois runs: status, tokens, custo, o caminho pelo pipeline, testes e campos do state.json. Run A é o que começou antes. Nada aqui altera os runs.</p>
        </div>
        <div class="cmp-actions">
          <button type="button" class="btn lg" data-cmp-swap title="Trocar Run A e Run B"><span aria-hidden="true">⇄</span> Inverter</button>
          <button type="button" class="btn lg" data-cmp-close>Fechar</button>
        </div>
      </header>
      <section class="cmp-runs" aria-label="Runs comparados">${runCard('A', a, d?.runA)}${runCard('B', b, d?.runB)}</section>`;
    if (cmp.loading) return `<div class="cmp">${head}<p class="cmp-status" role="status">Comparando…</p></div>`;
    if (cmp.error) return `<div class="cmp">${head}<p class="cmp-error" role="alert"><span aria-hidden="true">✕</span> Não deu para comparar: ${esc(cmp.error)}</p></div>`;
    const v = VERDICT[d.verdict] || { cls: 'same', glyph: '·', title: d.verdict };
    const warn = [d.runA, d.runB].filter(r => r.readError).map(r => `<p class="cmp-error"><span aria-hidden="true">‖</span> Run ${r === d.runB ? 'B' : 'A'}: ${esc(r.readError)} — campos aparecem como N/A.</p>`).join('');
    const tr = d.testResultsDiff;
    const legend = `<div class="cmp-legend t-caption" aria-label="Legenda">
        <span><span class="cmp-mark better"><span aria-hidden="true">✓</span>melhor</span> Run B melhorou</span>
        <span><span class="cmp-mark worse"><span aria-hidden="true">✕</span>pior</span> Run B piorou</span>
        <span><span class="cmp-mark better strong"><span aria-hidden="true">✓</span>melhor</span> preenchido: diferença acima de ${esc(String(d.significantPct))}% ou mudança de status/testes</span>
        <span><span class="num">=</span> igual · <span class="num">${NA}</span> sem medição</span>
      </div>`;
    return `<div class="cmp">${head}${warn}
      <section class="cmp-verdict ${v.cls}" aria-labelledby="cmp-verdict-h">
        <div class="cmp-verdict-top">
          <span class="cmp-verdict-glyph" aria-hidden="true">${v.glyph}</span>
          <h3 id="cmp-verdict-h" class="t-heading">${esc(v.title)}</h3>
          <span class="cmp-verdict-tag mono">verdict: ${esc(d.verdict)}</span>
        </div>
        <p>${esc(d.summary)}</p><small>${esc(d.verdictReason)}</small>
      </section>
      ${section('cmp-metrics-h', 'Métricas', 'B − A: sinal do número; a marca diz se é melhor ou pior para B', `${legend}${metricsTable(d.metrics)}`)}
      <div class="cmp-grid">
        ${section('cmp-tokens-h', 'Tokens por nó', 'entrada + saída, de cost_tracking', tokensTable(d.tokenDiff))}
        <div class="cmp-col">
          ${section('cmp-nodes-h', 'Nós executados', 'history de cada state.json', nodesBlock(d.nodeDiff))}
          ${section('cmp-tests-h', 'Testes', `<span class="mono">${esc(tr.a.outcome)} → ${esc(tr.b.outcome)}</span>`, testsBlock(tr))}
        </div>
      </div>
      <details class="panel cmp-fold"><summary>${ICON.chev}<span class="t-heading">Campos do state.json que mudaram</span><span class="count-badge cmp-count">${d.stateDiff.length}</span></summary>
        <div class="cmp-fold-body">${stateTable(d.stateDiff, d.stateDiffIgnored)}</div></details>
      <p class="source-note cmp-origin">Origem: GET /api/compare (scripts/lib/run-comparator.js) lendo o state.json de cada run — A em <span class="mono">${esc(d.runA.source ?? NA)}</span>, B em <span class="mono">${esc(d.runB.source ?? NA)}</span>; custo e tokens de cost_tracking (telemetria, não verdade contábil). Esta tela só lê.</p>
    </div>`;
  }

  document.addEventListener('click', e => {
    if (!cmp) return;
    if (e.target.closest('[data-cmp-close]')) { close(); renderDetail(); return; }
    if (e.target.closest('[data-cmp-swap]')) { swap(); return; }
    const o = e.target.closest('[data-cmp-open]');
    if (o && runs.has(o.dataset.cmpOpen)) select(o.dataset.cmpOpen);
  });

  window.Compare = { open, close, swap, active: () => Boolean(cmp), html };
})();
