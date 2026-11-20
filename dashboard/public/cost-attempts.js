(function (root) {
  'use strict';
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const tokens = n => n == null ? 'não observado' : n.toLocaleString('pt-BR');
  const money = n => n == null ? 'sem preço' : `US$ ${n.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 9 })}`;
  const cell = value => `<td class="n">${esc(value)}</td>`;
  const status = { NOT_OBSERVED: 'contadores não observados', DIMENSION_NOT_OBSERVED: 'modo não observado', PRICING_UNAVAILABLE: 'tabela histórica indisponível', UNPRICED: 'modelo sem preço' };
  const role = row => `${row.role === 'main' ? 'principal' : row.role === 'subagent' ? 'subagente' : row.role}${row.role_provenance === 'CONFLICTED' ? ' · CONFLICTED (atribuição parcial)' : ''}`;

  const source = { FIXED_NODE: 'nó fixo (default_route)', CONSERVATIVE_DEFAULT: 'default conservador', HUMAN_OVERRIDE: 'override humano', RULES: 'regra' };
  const meta = (label, value) => `<div><dt>${esc(label)}</dt><dd>${value}</dd></div>`;
  // PRI-233: RoutingDecision de Attempt roteado (só leitura). String (UNAVAILABLE/UNKNOWN) segue como antes.
  function routingHtml(rd) {
    if (!rd || typeof rd !== 'object') return meta('RoutingDecision', esc(rd));
    const chosen = rd.chosen ? `${esc(rd.chosen.model_id)} · tier ${esc(rd.chosen.tier)} · esforço ${esc(rd.chosen.effort)}` : 'nenhum';
    const discarded = (rd.candidates || []).filter(c => c.status !== 'CHOSEN');
    const sha = String(rd.policy_ref?.sha256 ?? 'UNKNOWN');
    return [
      meta('Modelo roteado', `${chosen}${rd.effort_applied === false ? '<br><small>esforço não aplicado</small>' : rd.effort_applied === true ? '' : `<br><small>esforço aplicado: ${esc(rd.effort_applied)}</small>`}`),
      meta('Classe / regra', `${esc(rd.class ?? '—')} / ${esc(rd.class_rule ?? '—')}`),
      meta('Origem da seleção', `${esc(Object.hasOwn(source, rd.selection_source) ? source[rd.selection_source] : rd.selection_source)}<br><small>plugin de roteamento: ${esc(rd.effort_router_plugin)}</small>`),
      meta('Policy', `${esc(rd.policy_ref?.id)}@${esc(rd.policy_ref?.version)}<br><small><code title="${esc(sha)}">${esc(sha === 'UNKNOWN' ? sha : sha.slice(0, 12))}</code></small>`),
      rd.override_ref ? meta('Override', `${esc(rd.override_ref.ref ?? 'sem ref')} · escopo ${esc(rd.override_ref.scope)}`) : '',
      discarded.length ? meta('Candidatos descartados', discarded.map(c => `${esc(c.model_id)} (${esc(c.tier)}) · ${esc(c.reason ?? c.status)}`).join('<br>')) : '',
    ].join('');
  }

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
        ${routingHtml(a.routing_decision)}
      </dl>
      ${typeof root.RunSubtasks?.wouldRouteNote === 'function' ? root.RunSubtasks.wouldRouteNote(a) : ''}
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
