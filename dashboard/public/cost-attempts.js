(function (root) {
  'use strict';
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const tokens = n => n == null ? 'não observado' : n.toLocaleString('pt-BR');
  const money = n => n == null ? 'sem preço' : `US$ ${n.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 9 })}`;
  const cell = value => `<td class="n">${esc(value)}</td>`;
  const status = { NOT_OBSERVED: 'contadores não observados', DIMENSION_NOT_OBSERVED: 'modo não observado', PRICING_UNAVAILABLE: 'tabela histórica indisponível', UNPRICED: 'modelo sem preço' };
  const role = row => `${row.role === 'main' ? 'principal' : row.role === 'subagent' ? 'subagente' : row.role}${row.role_provenance === 'CONFLICTED' ? ' · CONFLICTED (atribuição parcial)' : ''}`;

  function attemptHtml(a) {
    const usage = a.observed.usage;
    const rows = usage.map(u => `<tr><td>${esc(u.model)}</td><td>${esc(role(u))}</td>
      <td>${esc(u.speed)}<br><small>${esc(u.price_tier)}</small></td>
      ${['input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_write_5m_tokens', 'cache_write_1h_tokens', 'cache_write_ttl_unknown_tokens'].map(k => cell(tokens(u[k]))).join('')}
      <td class="n">${esc(money(u.cost_usd))}${status[u.cost_status] ? `<br><small>${esc(status[u.cost_status])}</small>` : ''}</td></tr>`).join('');
    return `<details class="cost-attempt"><summary><span>Attempt <code>${esc(a.admission.attempt_id)}</code></span><span>${esc(a.result)} · ${esc(money(a.cost.usd))}</span></summary>
      <dl class="cost-attempt-meta">
        <div><dt>Causa</dt><dd>${esc(a.cause)}</dd></div><div><dt>Início</dt><dd>${esc(a.started_at)}</dd></div>
        <div><dt>Runtime / conta</dt><dd>${esc(a.runtime)} · ${esc(a.account.label)}</dd></div>
        <div><dt>Nó admitido / atribuído</dt><dd>${esc(a.admission.admitted_node)} / ${esc(a.attributed_node)}</dd></div>
        <div><dt>Modelo solicitado / esforço</dt><dd>${esc(a.requested.model)} / ${esc(a.requested.effort)}</dd></div>
        <div><dt>RoutingDecision</dt><dd>${esc(a.routing_decision)}</dd></div>
      </dl>
      ${a.role_attribution.status !== 'COMPLETE' ? `<p class="cost-note">Atribuição por papel: ${esc(a.role_attribution.status)} · mensagens em conflito: ${esc(tokens(a.role_attribution.conflicted_messages))}.</p>` : ''}
      ${rows ? `<div class="cost-wrap" role="region" aria-label="Uso por modelo e papel" tabindex="0"><table class="cost-table cost-usage"><caption>Uso por modelo e papel</caption><thead><tr>
        <th scope="col">Modelo</th><th scope="col">Papel</th><th scope="col">Modo / faixa</th><th scope="col" class="n">Entrada sem cache</th><th scope="col" class="n">Saída</th><th scope="col" class="n">Cache read</th><th scope="col" class="n">Cache write 5 min</th><th scope="col" class="n">Cache write 1 h</th><th scope="col" class="n">Cache write TTL não observado</th><th scope="col" class="n">Custo</th>
      </tr></thead><tbody>${rows}</tbody></table></div>` : '<p class="cost-note">Uso por modelo não observado.</p>'}
      ${a.cost.unpriced_models.length ? `<p class="cost-note">Modelos sem preço: ${a.cost.unpriced_models.map(esc).join(', ')}.</p>` : ''}
      ${a.cost.estimated === true ? '<p class="cost-note">Custo estimado: TTL de cache não observado, precificado como 5 min.</p>' : ''}
      <p class="cost-note cost-pricing">Fonte de preços: ${esc(a.cost.pricing_source)}<br>Hash da tabela: <code>${esc(a.cost.pricing_sha256)}</code></p>
    </details>`;
  }

  function render(cost, labels = {}) {
    const nodes = Object.entries(cost?.nodes || {}).filter(([, n]) => Array.isArray(n.attempts) && n.attempts.length);
    if (!nodes.length) return '';
    return `<section class="cost-attempts"><h3>Attempts por nó</h3>
      <p class="cost-note">Custos e uso observados por despacho. Entrada sem cache + cache read + cache write compõem a entrada do nó. Totais acima preservam os agregados registrados; somas parciais continuam sinalizadas.</p>
      ${nodes.map(([key, node]) => `<section><h4>${esc(labels[key] || key)} · ${esc(money(node.cost_usd))}</h4>
        ${node.runs > node.attempts.length ? `<p class="cost-note">Detalhamento disponível para ${esc(node.attempts.length)} de ${esc(node.runs)} despachos. Os agregados incluem despachos sem Attempt detalhado.</p>` : ''}
        ${node.attempts.map(attemptHtml).join('')}</section>`).join('')}
    </section>`;
  }
  const api = { render, money, tokens };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CostAttempts = api;
})(typeof window === 'object' ? window : globalThis);
