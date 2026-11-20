// Subtarefas no detalhe/lista de Runs — lê cost_tracking projetado (signals + would_route).
// Sombra apenas: não liga S4. Estilos em screens/run-subtasks.css.
(function (root) {
  'use strict';
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const TIER_FAIXA = { T1: 'leve', T2: 'medio', T3: 'opus' };
  const FAIXA_LABEL = { leve: 'leve', medio: 'médio', opus: 'Opus' };

  function subtasksOfCostTracking(costTracking) {
    const byKey = new Map();
    let withWould = 0;
    let noDecision = 0;
    if (!costTracking?.nodes) return { rows: [], summary: { count: 0, leaves_opus_tier: 0, by_faixa: { leve: 0, medio: 0, opus: 0, unknown: 0 }, with_would_route: 0, no_decision: 0 } };
    for (const [nodeKey, node] of Object.entries(costTracking.nodes)) {
      if (!Array.isArray(node?.attempts)) continue;
      for (const attempt of node.attempts) {
        const wr = attempt?.would_route;
        const groups = attempt?.signals && typeof attempt.signals === 'object' && Array.isArray(attempt.signals.groups)
          ? attempt.signals.groups : [];
        if (wr && wr !== 'UNAVAILABLE' && typeof wr === 'object') {
          withWould += 1;
          const decisions = Array.isArray(wr.decisions) ? wr.decisions : [];
          if (!decisions.length) {
            noDecision += 1;
            for (const g of groups) {
              const key = g.subtask_key || 'UNKNOWN';
              if (byKey.has(key) && byKey.get(key).source === 'would_route') continue;
              byKey.set(key, {
                subtask_key: key,
                steps: Array.isArray(g.steps) ? g.steps : [],
                class: null, tier: null, faixa: null, faixa_label: null, rule: null,
                leaves_opus_tier: false, kind: g.signals?.kind || null, n_files: g.signals?.n_files ?? null,
                node: nodeKey, shadow_status: wr.status || 'NO_DECISION', cause: wr.cause || null,
                source: 'signals',
              });
            }
            continue;
          }
          for (const d of decisions) {
            const key = d.subtask_key || 'UNKNOWN';
            const faixa = TIER_FAIXA[d.tier] || null;
            byKey.set(key, {
              subtask_key: key,
              steps: Array.isArray(d.steps) ? d.steps : [],
              class: d.class || null, tier: d.tier || null, faixa, faixa_label: faixa ? FAIXA_LABEL[faixa] : null,
              rule: d.rule || null, leaves_opus_tier: d.leaves_opus_tier === true,
              kind: null, n_files: null, node: nodeKey,
              shadow_status: wr.status || 'SHADOW', cause: wr.cause || null, source: 'would_route',
            });
          }
          continue;
        }
        for (const g of groups) {
          const key = g.subtask_key || 'UNKNOWN';
          if (byKey.has(key) && byKey.get(key).source === 'would_route') continue;
          byKey.set(key, {
            subtask_key: key,
            steps: Array.isArray(g.steps) ? g.steps : [],
            class: null, tier: null, faixa: null, faixa_label: null, rule: null,
            leaves_opus_tier: false, kind: g.signals?.kind || null, n_files: g.signals?.n_files ?? null,
            node: nodeKey, shadow_status: null, cause: null, source: 'signals',
          });
        }
      }
    }
    const rows = [...byKey.values()].sort((a, b) => String(a.subtask_key).localeCompare(String(b.subtask_key)));
    const by_faixa = { leve: 0, medio: 0, opus: 0, unknown: 0 };
    for (const r of rows) {
      if (r.faixa && Object.hasOwn(by_faixa, r.faixa)) by_faixa[r.faixa] += 1;
      else by_faixa.unknown += 1;
    }
    return {
      rows,
      summary: {
        count: rows.length,
        leaves_opus_tier: rows.filter(r => r.leaves_opus_tier).length,
        by_faixa,
        with_would_route: withWould,
        no_decision: noDecision,
      },
    };
  }

  function chipHtml(costTracking) {
    const { summary } = subtasksOfCostTracking(costTracking);
    if (!summary.count) return '';
    const leave = summary.leaves_opus_tier
      ? ` · ${summary.leaves_opus_tier} sairia${summary.leaves_opus_tier > 1 ? 'm' : ''} do Opus`
      : '';
    return `<span class="run-subtasks-chip" title="Subtarefas do plano (sombra would_route) · S4 desligado">${esc(summary.count)} subtarefa${summary.count > 1 ? 's' : ''}${esc(leave)}</span>`;
  }

  function foldHtml(costTracking, { taskId, open = false, nodeLabels = {} } = {}) {
    const { rows, summary } = subtasksOfCostTracking(costTracking);
    if (!summary.count && !summary.with_would_route) return '';
    const leave = summary.leaves_opus_tier
      ? `${summary.leaves_opus_tier} sairia${summary.leaves_opus_tier > 1 ? 'm' : ''} do Opus`
      : 'nenhuma sair do Opus';
    const body = !rows.length
      ? `<p class="fold-msg">would_route presente, mas sem decisões (classificador off ou sem grupos). S4 continua desligado.</p>`
      : `<div class="rst-wrap" role="region" aria-label="Subtarefas do run" tabindex="0"><table class="rst-table">
        <caption>Subtarefas do plano neste run</caption>
        <thead><tr>
          <th scope="col">Subtarefa</th><th scope="col">Passos</th><th scope="col">Tipo</th>
          <th scope="col">Classe</th><th scope="col">Faixa sombra</th><th scope="col">Regra</th>
          <th scope="col">Sai do Opus?</th><th scope="col">Nó</th>
        </tr></thead>
        <tbody>${rows.map(r => `<tr>
          <td><code>${esc(r.subtask_key)}</code></td>
          <td>${esc(r.steps.length ? r.steps.join(', ') : '—')}</td>
          <td>${esc(r.kind || '—')}</td>
          <td>${esc(r.class || '—')}</td>
          <td class="rst-faixa rst-faixa-${esc(r.faixa || 'unknown')}">${esc(r.faixa_label || (r.shadow_status === 'NO_DECISION' ? 'sem decisão' : '—'))}</td>
          <td>${esc(r.rule || '—')}</td>
          <td>${r.leaves_opus_tier ? 'sim' : (r.faixa ? 'não' : '—')}</td>
          <td>${esc(nodeLabels[r.node] || r.node || '—')}</td>
        </tr>`).join('')}</tbody>
      </table></div>
      <p class="cost-note">Somente leitura · sombra. O despacho continua AS-IS; faixa sombra não troca o modelo (S4 desligado). Fonte: Attempt.signals + Attempt.would_route.</p>`;

    return `<div class="folds"><details class="fold" id="foldSubtasks" ${open ? 'open' : ''}>
      <summary>${typeof ICON !== 'undefined' ? ICON.chev : ''} Subtarefas <span class="sum-right">${esc(String(summary.count))} · ${esc(leave)}</span></summary>
      <div class="fold-body">${body}</div>
    </details></div>`;
  }

  function wouldRouteNote(a) {
    const wr = a?.would_route;
    if (!wr || wr === 'UNAVAILABLE') return '';
    if (typeof wr !== 'object') return '';
    const n = Array.isArray(wr.decisions) ? wr.decisions.length : 0;
    if (wr.status === 'NO_DECISION' || !n) {
      return `<p class="cost-note">would_route: ${esc(wr.status || 'NO_DECISION')}${wr.cause ? ` (${esc(wr.cause)})` : ''} · applied=${esc(String(!!wr.applied))} · S4 desligado</p>`;
    }
    const leave = wr.decisions.filter(d => d.leaves_opus_tier).length;
    return `<p class="cost-note">would_route sombra: ${esc(String(n))} subtarefa${n > 1 ? 's' : ''} · ${esc(String(leave))} sairiam do Opus · applied=${esc(String(!!wr.applied))} · provider=${esc(wr.classifier_ref?.provider || '—')}</p>`;
  }

  const api = { subtasksOfCostTracking, chipHtml, foldHtml, wouldRouteNote, FAIXA_LABEL };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.RunSubtasks = api;
})(typeof window === 'object' ? window : globalThis);
