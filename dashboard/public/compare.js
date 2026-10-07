// Comparação de dois runs lado a lado (GET /api/compare/:taskIdA/:taskIdB →
// scripts/lib/run-comparator.js). Entra pelo botão "Comparar" da lista (modo de seleção
// limitado a 2 runs, em index.html) e ocupa o painel principal até outro run ser aberto.
// Run A = o que começou antes. Verde = B melhorou; vermelho = B piorou. Script clássico
// carregado depois do principal; usa os globais dele (runs, api, esc, fmtTok...).
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

  // Classe da célula: melhora de B (verde) / regressão de B (vermelho); forte se passou
  // do limiar de significância (> 20% ou mudança de status/teste).
  function tone(row) {
    if (!row.better) return '';
    return `${row.better === 'B' ? 'cmp-up' : 'cmp-down'}${row.significant ? ' cmp-strong' : ''}`;
  }

  function fmtDelta(row) {
    if (typeof row.delta !== 'number') return row.delta === NA ? NA : String(row.delta);
    if (row.delta === 0) return '=';
    const sign = row.delta > 0 ? '+' : '−';
    const pct = row.deltaPct !== NA ? ` (${row.deltaPct > 0 ? '+' : ''}${row.deltaPct}%)` : '';
    return `${sign}${fmt(Math.abs(row.delta), row.format)}${pct}`;
  }

  const runLabel = id => {
    const r = runs.get(id);
    const t = r ? titleOf(r) : null;
    return t ? `${t.num ? `${t.num} ` : ''}${t.text}` : id;
  };

  // Custo com runs sem custo calculável (complete: false) é subtotal, não total.
  function partialMark(m, side) {
    if (m.complete?.[side] !== false || m[side] === NA) return '';
    const n = m.missing?.[side];
    return ` <small class="cmp-partial" title="Soma parcial: ${esc(String(n ?? '?'))} run(s) sem custo calculável">(parcial)</small>`;
  }

  function metricsTable(metrics) {
    const rows = metrics.map(m => `<tr>
        <td>${esc(m.label)}</td>
        <td class="n">${esc(fmt(m.a, m.format))}${partialMark(m, 'a')}</td>
        <td class="n">${esc(fmt(m.b, m.format))}${partialMark(m, 'b')}</td>
        <td class="n ${tone(m)}">${esc(fmtDelta(m))}</td></tr>`).join('');
    return `<div class="cost-wrap"><table class="cost-table cmp-table">
      <thead><tr><th>Métrica</th><th class="n">Run A</th><th class="n">Run B</th><th class="n">Delta</th></tr></thead>
      <tbody>${rows}</tbody></table></div>`;
  }

  function tokensTable(t) {
    if (!t.nodes.length) return '<p class="cost-note">N/A — nenhum dos runs tem cost_tracking.</p>';
    const row = (label, r, strong) => {
      const better = typeof r.delta === 'number' && r.delta !== 0 ? (r.delta < 0 ? 'B' : 'A') : null;
      const cells = { ...r, format: 'int', better };
      return `<tr${strong ? ' class="cmp-total"' : ''}><td>${esc(label)}</td><td class="n">${esc(fmt(r.a, 'int'))}</td>
        <td class="n">${esc(fmt(r.b, 'int'))}</td><td class="n ${tone(cells)}">${esc(fmtDelta(cells))}</td></tr>`;
    };
    return `<div class="cost-wrap"><table class="cost-table cmp-table">
      <thead><tr><th>Nó</th><th class="n">Run A</th><th class="n">Run B</th><th class="n">Delta</th></tr></thead>
      <tbody>${t.nodes.map(r => row(NODE_LABEL[r.node] || r.node, r)).join('')}${row('Total', t.total, true)}</tbody></table></div>`;
  }

  function nodesBlock(n) {
    const list = xs => (xs.length ? xs.map(x => `<code>${esc(x)}</code>`).join(' ') : '<span class="cmp-muted">nenhum</span>');
    const loops = n.both.filter(x => n.executions[x].a !== n.executions[x].b);
    return `<ul class="cmp-list">
      <li><b>Só em A:</b> ${list(n.onlyInA)}</li>
      <li><b>Só em B:</b> ${list(n.onlyInB)}</li>
      ${loops.length ? `<li><b>Execuções diferentes:</b> ${loops.map(x => `<code>${esc(x)}</code> ${n.executions[x].a}→${n.executions[x].b}`).join(', ')}</li>` : ''}
    </ul>`;
  }

  function stateTable(diff, ignored) {
    if (!diff.length) return '<p class="cost-note">Nenhum campo mudou.</p>';
    const cell = v => (v === NA ? `<span class="cmp-muted">${NA}</span>` : esc(fmt(v)));
    return `<div class="cost-wrap"><table class="cost-table cmp-table cmp-state">
      <thead><tr><th>Campo</th><th>Run A</th><th>Run B</th></tr></thead>
      <tbody>${diff.map(d => `<tr><td><code>${esc(d.key)}</code></td><td>${cell(d.a)}</td><td>${cell(d.b)}</td></tr>`).join('')}</tbody>
    </table></div><p class="cost-note">Fora da lista: ${esc(ignored.join(', '))}.</p>`;
  }

  function html() {
    const [a, b] = cmp.ids;
    const head = `<header class="cmp-head">
        <div class="cmp-title"><h2>Comparação de runs</h2>
          <button type="button" class="ghost-btn" data-cmp-swap title="Trocar Run A e Run B">⇄ Inverter</button>
          <button type="button" class="ghost-btn" data-cmp-close>Fechar</button></div>
        <div class="cmp-runs">
          <div><span class="cmp-tag">A</span> <button type="button" class="linklike" data-cmp-open="${esc(a)}">${esc(runLabel(a))}</button> <small>${esc(a)}</small></div>
          <div><span class="cmp-tag">B</span> <button type="button" class="linklike" data-cmp-open="${esc(b)}">${esc(runLabel(b))}</button> <small>${esc(b)}</small></div>
        </div></header>`;
    if (cmp.loading) return `<div class="cmp">${head}<p class="cost-note">Comparando…</p></div>`;
    if (cmp.error) return `<div class="cmp">${head}<p class="cmp-error" role="alert">Não deu para comparar: ${esc(cmp.error)}</p></div>`;
    const d = cmp.data;
    const vcls = d.verdict === 'B-better' ? 'cmp-up' : d.verdict === 'A-better' ? 'cmp-down' : d.verdict === 'inconclusive' ? 'cmp-unknown' : '';
    const warn = [d.runA, d.runB].filter(r => r.readError).map((r, i) => `<p class="cmp-error">Run ${i ? 'B' : 'A'}: ${esc(r.readError)} — campos aparecem como N/A.</p>`).join('');
    const tr = d.testResultsDiff;
    return `<div class="cmp">${head}${warn}
      <section class="cmp-verdict ${vcls}" aria-label="Veredito">
        <span class="cmp-verdict-tag">verdict: ${esc(d.verdict)}</span>
        <p>${esc(d.summary)}</p><small>${esc(d.verdictReason)}</small>
      </section>
      ${metricsTable(d.metrics)}
      <p class="cost-note">Verde: Run B melhorou. Vermelho: Run B piorou. Negrito: diferença acima de ${d.significantPct}% ou mudança de status/testes.</p>
      <div class="folds">
        <details class="fold" open><summary>${ICON.chev} Tokens por nó</summary><div class="fold-body">${tokensTable(d.tokenDiff)}</div></details>
        <details class="fold" open><summary>${ICON.chev} Nós executados</summary><div class="fold-body">${nodesBlock(d.nodeDiff)}</div></details>
        <details class="fold"><summary>${ICON.chev} Testes <span class="sum-right">${esc(tr.a.outcome)} → ${esc(tr.b.outcome)}</span></summary><div class="fold-body">
          <ul class="cmp-list"><li><b>A:</b> ${esc(tr.a.summary)}</li><li><b>B:</b> ${esc(tr.b.summary)}</li></ul></div></details>
        <details class="fold"><summary>${ICON.chev} Campos do state.json que mudaram <span class="sum-right">${d.stateDiff.length}</span></summary>
          <div class="fold-body">${stateTable(d.stateDiff, d.stateDiffIgnored)}</div></details>
      </div></div>`;
  }

  document.addEventListener('click', e => {
    if (!cmp) return;
    if (e.target.closest('[data-cmp-close]')) { close(); renderDetail(); return; }
    if (e.target.closest('[data-cmp-swap]')) { swap(); return; }
    const o = e.target.closest('[data-cmp-open]');
    if (o && runs.has(o.dataset.cmpOpen)) select(o.dataset.cmpOpen);
  });

  const style = document.createElement('style');
  style.textContent = `
    .cmp { padding: 20px 24px 32px; max-width: 1100px; }
    .cmp-head { margin-bottom: 14px; }
    .cmp-title { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
    .cmp-title h2 { margin: 0 auto 0 0; font-size: 20px; }
    .cmp-runs { display: grid; gap: 4px; margin-top: 10px; font-size: 14px; }
    .cmp-runs small { color: var(--muted); font-family: var(--mono); font-size: 12px; }
    .cmp-tag { display: inline-grid; place-items: center; width: 20px; height: 20px; border-radius: 5px; background: var(--signal-soft); color: var(--signal); font-weight: 700; font-size: 12px; }
    .linklike { border: 0; background: none; padding: 0; color: var(--ink); font: inherit; font-weight: 600; cursor: pointer; text-align: left; }
    .linklike:hover { color: var(--signal); text-decoration: underline; }
    .cmp-verdict { border: 1px solid var(--line); border-radius: 10px; padding: 12px 14px; margin: 0 0 14px; background: var(--sunken); }
    .cmp-verdict p { margin: 6px 0 2px; font-weight: 600; }
    .cmp-verdict small { color: var(--muted); }
    .cmp-verdict-tag { font-family: var(--mono); font-size: 13px; font-weight: 700; }
    .cmp-verdict.cmp-up { background: var(--clear-bg); border-color: var(--clear); }
    .cmp-verdict.cmp-down { background: var(--stop-bg); border-color: var(--stop); }
    .cmp-verdict.cmp-unknown { background: var(--attention-bg); border-color: var(--attention-line); }
    .cmp-partial { color: var(--attention); font-weight: 600; }
    .cmp-table td.cmp-up { color: var(--clear); }
    .cmp-table td.cmp-down { color: var(--stop); }
    .cmp-table td.cmp-strong { font-weight: 700; }
    .cmp-table tr.cmp-total td { font-weight: 700; }
    .cmp-state td { word-break: break-word; font-size: 12.5px; }
    .cmp-muted { color: var(--faint); }
    .cmp-list { margin: 0; padding-left: 18px; display: grid; gap: 4px; font-size: 13.5px; }
    .cmp-error { color: var(--stop); font-size: 13.5px; }
    .action-bar button[disabled] { opacity: .45; cursor: not-allowed; }
    .action-bar.compare-bar button.compare-go { background: var(--signal); color: #fff; }
    @media (max-width: 820px) { .cmp { padding: 16px; } }
  `;
  document.head.appendChild(style);

  window.Compare = { open, close, swap, active: () => Boolean(cmp), html };
})();
