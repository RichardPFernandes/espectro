// Aba "Padrões": memory/patterns.md (GET /api/patterns), gerado periodicamente por
// scripts/memory-consolidator.js a partir do histórico de memory/runs/. Mesmo padrão
// de graph.js: módulo próprio carregado depois de views.js, cache local com
// load()/render(), plugado em VIEWS/RENDER de views.js. Sem lib de markdown externa.
//
// Design Espectro ("Padrões de falha"): o formato de memory/patterns.md é fixo
// (scripts/memory-consolidator.js renderPatterns), então as linhas conhecidas viram
// listas com contagem e barra de frequência; qualquer linha/seção fora desse formato
// cai no mini-renderer markdown (##, listas, **bold**, `code`; comentários HTML de
// metadata nunca aparecem no corpo). Nada é inventado: o que o arquivo não diz fica "—".
// Estilos em screens/patterns.css.
(() => {
  const st = { data: null, loading: false, error: null, loadedOnce: false };

  async function load() {
    st.loading = true; st.error = null;
    window.Views?.refresh();
    try {
      st.data = await api('/api/patterns');
    } catch (e) {
      st.error = e.message;
    }
    st.loading = false; st.loadedOnce = true;
    window.Views?.refresh();
  }

  function inline(text) {
    return esc(text)
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  }

  // markdown -> HTML pro formato fixo de memory/patterns.md: "# "/"## " (título já
  // fica no vhead da aba, então "# " é ignorado aqui), listas "- ", **bold**,
  // `code`. Linhas de comentário HTML (metadata do gerador) nunca aparecem no corpo.
  function mdToHtml(markdown) {
    const html = [];
    let inList = false;
    const closeList = () => { if (inList) { html.push('</ul>'); inList = false; } };
    for (const raw of String(markdown || '').split('\n')) {
      const line = raw.replace(/\s+$/, '');
      if (/^<!--.*-->$/.test(line.trim())) continue;
      const bullet = line.match(/^-\s+(.*)$/);
      if (/^#\s+/.test(line)) { closeList(); continue; }
      if (/^##\s+/.test(line)) { closeList(); html.push(`<h3 class="pat-h">${inline(line.replace(/^##\s+/, ''))}</h3>`); continue; }
      if (bullet) {
        if (!inList) { html.push('<ul class="pat-list">'); inList = true; }
        html.push(`<li>${inline(bullet[1])}</li>`);
        continue;
      }
      if (line.trim()) { closeList(); html.push(`<p>${inline(line)}</p>`); }
      else closeList();
    }
    closeList();
    return html.join('\n');
  }

  // ---------------------------------------------------------------- parsing
  // Linhas exatas de scripts/memory-consolidator.js (renderPatterns). Fora disso,
  // a linha é preservada como texto livre (rest) e renderizada pelo mdToHtml.
  const RE_REVIEW = /^\*\*(.+?)\*\*: ocorreu em (\d+)\/(\d+) run\(s\) revisado\(s\)(?: \(ex\.: (.+)\))?$/;
  const RE_COST = /^Runs tocando `([^`]+)`: média ([\d.]+) loops \((\d+) run\(s\)\)$/;
  const KIND = [
    ['review', /^Padrões de Falha no Review/i],
    ['cost', /^Runs de Alto Custo/i],
    ['recs', /^Recomendações/i],
  ];

  function parse(markdown) {
    const out = { review: [], cost: [], recs: [], notes: { review: [], cost: [] }, extra: [], meta: {}, heads: {} };
    let kind = null; let extra = null;
    for (const raw of String(markdown || '').split('\n')) {
      const line = raw.replace(/\s+$/, '');
      const meta = line.trim().match(/^<!--\s*metadata:(.*)-->$/);
      if (meta) {
        for (const m of meta[1].matchAll(/(\w+)=(\S+)/g)) out.meta[m[1]] = m[2];
        continue;
      }
      if (/^<!--.*-->$/.test(line.trim()) || /^#\s+/.test(line)) continue;
      const h = line.match(/^##\s+(.*)$/);
      if (h) {
        const k = KIND.find(([, re]) => re.test(h[1]));
        kind = k ? k[0] : null;
        if (kind) { out.heads[kind] = h[1]; extra = null; }
        else { extra = [line]; out.extra.push(extra); }
        continue;
      }
      if (!kind) { if (extra) extra.push(line); else if (line.trim()) out.extra.push([line]); continue; }
      const b = line.match(/^-\s+(.*)$/);
      if (!b) { if (line.trim()) (kind === 'recs' ? out.recs : out.notes[kind]).push(line.trim()); continue; }
      const text = b[1];
      if (kind === 'review') {
        const m = text.match(RE_REVIEW);
        if (m) out.review.push({ sig: m[1], count: +m[2], total: +m[3], examples: m[4] ? m[4].split(/,\s*/).filter(Boolean) : [] });
        else out.notes.review.push(text);
      } else if (kind === 'cost') {
        const m = text.match(RE_COST);
        if (m) out.cost.push({ label: m[1], avg: Number(m[2]), n: +m[3] });
        else out.notes.cost.push(text);
      } else out.recs.push(text);
    }
    // ordem estável, mais frequente primeiro
    out.review = out.review.map((p, i) => ({ ...p, i })).sort((a, b) => b.count - a.count || a.i - b.i);
    out.cost = out.cost.map((p, i) => ({ ...p, i })).sort((a, b) => b.avg - a.avg || a.i - b.i);
    return out;
  }

  // ---------------------------------------------------------------- render
  const fmt1 = n => (Number.isFinite(n) ? n.toFixed(1).replace('.', ',') : '—');
  const pct = (a, b) => (b > 0 ? Math.round((a / b) * 100) : null);
  const dash = v => (v == null || v === '' ? '—' : esc(String(v)));

  function kpi(label, value, hint) {
    return `<div class="kpi"><span class="kpi-label">${label}</span><span class="kpi-value">${value}</span>${hint ? `<span class="kpi-hint">${hint}</span>` : ''}</div>`;
  }

  function notesHtml(list) {
    return list.length ? `<div class="pat-notes">${list.map(t => `<p>${inline(t)}</p>`).join('')}</div>` : '';
  }

  function reviewSection(p) {
    const head = p.heads.review || 'Padrões de Falha no Review';
    const rows = p.review.map(r => {
      const share = pct(r.count, r.total);
      const w = r.total > 0 ? Math.max(0, Math.min(100, (r.count / r.total) * 100)) : 0;
      const tip = `${r.count} de ${r.total} run(s) revisado(s)${share != null ? ` (${share}%)` : ''}`;
      return `<li class="pat-row" title="${esc(tip)}">
        <div class="pat-row-top">
          <span class="pat-sig">${inline(r.sig)}</span>
          <span class="pat-val num"><b>${r.count}</b><span class="pat-of">/${r.total}</span>${share != null ? `<span class="pat-pct">${share}%</span>` : ''}</span>
        </div>
        <span class="meter pat-meter" role="img" aria-label="${esc(tip)}"><i style="width:${w.toFixed(1)}%"></i></span>
        ${r.examples.length ? `<div class="pat-ex"><span class="pat-ex-k">ex.:</span>${r.examples.map(x => `<span class="tag" title="run de exemplo em memory/runs/">${esc(x)}</span>`).join('')}</div>` : ''}
      </li>`;
    }).join('');
    return `<section class="panel pat-sec" aria-labelledby="pat-h-review">
      <header class="pat-sec-head">
        <h3 id="pat-h-review" class="label">${inline(head)}</h3>
        <span class="source-note">ocorrências / runs revisados · fonte: <code>memory/patterns.md</code></span>
      </header>
      ${rows ? `<ol class="pat-rows">${rows}</ol>` : ''}
      ${notesHtml(p.notes.review)}
      ${!rows && !p.notes.review.length ? '<p class="pat-none">Seção ausente no arquivo.</p>' : ''}
    </section>`;
  }

  function costSection(p) {
    const head = p.heads.cost || 'Runs de Alto Custo (loop_count > 1)';
    const max = Math.max(0, ...p.cost.map(c => c.avg).filter(Number.isFinite));
    const rows = p.cost.map(c => {
      const w = max > 0 && Number.isFinite(c.avg) ? (c.avg / max) * 100 : 0;
      const tip = `${c.label}: média ${fmt1(c.avg)} loop(s) em ${c.n} run(s)`;
      return `<li class="pat-row pat-cost" title="${esc(tip)}">
        <span class="pat-mod mono">${esc(c.label)}</span>
        <span class="meter pat-meter" role="img" aria-label="${esc(tip)}"><i style="width:${w.toFixed(1)}%"></i></span>
        <span class="pat-val num"><b>${fmt1(c.avg)}</b><span class="pat-of"> loops</span><span class="pat-pct">${c.n} run(s)</span></span>
      </li>`;
    }).join('');
    return `<section class="panel pat-sec" aria-labelledby="pat-h-cost">
      <header class="pat-sec-head">
        <h3 id="pat-h-cost" class="label">${inline(head)}</h3>
        <span class="source-note">média de loops review/test/verify por módulo · barra relativa ao maior · fonte: <code>memory/patterns.md</code></span>
      </header>
      ${rows ? `<ol class="pat-rows">${rows}</ol>` : ''}
      ${notesHtml(p.notes.cost)}
      ${!rows && !p.notes.cost.length ? '<p class="pat-none">Seção ausente no arquivo.</p>' : ''}
    </section>`;
  }

  function recsSection(p) {
    const head = p.heads.recs || 'Recomendações para Specs Futuras';
    return `<section class="panel pat-sec pat-recs" aria-labelledby="pat-h-recs">
      <header class="pat-sec-head">
        <h3 id="pat-h-recs" class="label">${inline(head)}</h3>
        <span class="source-note">geradas pelo consolidador · fonte: <code>memory/patterns.md</code></span>
      </header>
      ${p.recs.length ? `<ul class="pat-list">${p.recs.map(r => `<li>${inline(r)}</li>`).join('')}</ul>` : '<p class="pat-none">Seção ausente no arquivo.</p>'}
    </section>`;
  }

  function render() {
    if (!st.loadedOnce && !st.loading) load();
    const d = st.data;
    const head = `<div class="vhead pat-head">
      <div class="pat-head-text"><h2>Padrões</h2>
      <p>Padrões de falha de review e de custo alto, consolidados por <code>scripts/memory-consolidator.js</code> a partir de <code>memory/runs/</code>. O watcher reconsolida a cada 10 runs completados novos; o botão abaixo força uma leitura do arquivo atual.</p></div>
      <div class="vtools"><button class="btn" type="button" data-pat-reload ${st.loading ? 'disabled' : ''}>${st.loading ? 'Carregando…' : '↻ Atualizar'}</button>
        ${d?.lastConsolidationAt ? `<span class="muted" title="${esc(when(d.lastConsolidationAt))}">última consolidação ${esc(ago(d.lastConsolidationAt))} · ${esc(String(d.totalConsolidations ?? 0))} execução(ões)</span>` : ''}
      </div></div>`;
    if (st.error) return `<div class="pat">${head}<p class="fold-msg warn pat-state"><span aria-hidden="true">✕ </span>Não deu para ler os padrões: ${esc(st.error)}</p></div>`;
    if (!d) return `<div class="pat">${head}<div class="vempty">Carregando…</div></div>`;
    if (!d.exists) return `<div class="pat">${head}<div class="vempty pat-empty">Ainda não existe <code>memory/patterns.md</code>. Ele nasce depois de 10 runs completados no histórico (contador em <code>memory/consolidator-state.json</code>), ou rodando <code>node scripts/memory-consolidator.js</code> manualmente.</div></div>`;

    const p = parse(d.content);
    const known = p.heads.review || p.heads.cost || p.heads.recs;
    // Arquivo fora do formato do consolidador: mostra o markdown como veio.
    if (!known) return `<div class="pat">${head}<div class="panel pat-sec pat-body">${mdToHtml(d.content)}</div></div>`;

    const totals = [...new Set(p.review.map(r => r.total))];
    const reviewed = totals.length === 1 ? totals[0] : null;
    const kpis = `<div class="kpis pat-kpis">
      ${kpi('Padrões de falha no review', p.heads.review ? String(p.review.length) : '—', 'assinaturas distintas · patterns.md')}
      ${kpi('Runs revisados', dash(reviewed), 'denominador das ocorrências · patterns.md')}
      ${kpi('Runs analisados', dash(p.meta.runs_analyzed), `completados: ${dash(p.meta.completed_runs)} · metadata do patterns.md`)}
      ${kpi('Consolidações', d.lastConsolidationAt ? dash(d.totalConsolidations) : '—', `runs completados na última: ${dash(d.completedRunsAtLastRun)} · consolidator-state.json`)}
    </div>`;
    const extra = p.extra.length ? `<div class="panel pat-sec pat-body">${mdToHtml(p.extra.map(x => x.join('\n')).join('\n'))}</div>` : '';
    const updated = d.updatedAt ? `<p class="source-note pat-foot">Arquivo <code>memory/patterns.md</code> modificado ${esc(ago(d.updatedAt))} (${esc(when(d.updatedAt))})${p.meta.generated_at ? ` · gerado em ${esc(when(p.meta.generated_at) || p.meta.generated_at)}` : ''}. Heurística sobre texto livre (scope/agent_log), não é auditoria exaustiva.</p>` : '';
    return `<div class="pat">${head}${kpis}
      <div class="pat-grid">
        <div class="pat-main">${reviewSection(p)}${costSection(p)}${extra}</div>
        <aside class="pat-side">${recsSection(p)}</aside>
      </div>${updated}</div>`;
  }

  const view = $('view');
  view.addEventListener('click', e => {
    if (e.target.closest('[data-pat-reload]')) load();
  });

  window.PatternsView = { render, load };
  window.Views?.refresh();
})();
