// ui-kit.js — padrões repetidos nos artboards do design Espectro, para as telas não recriarem cada um:
//   kcard      card de indicador com sparkline que também filtra a lista (aria-pressed)
//   spark      sparkline 100×32 (área + linha), com rótulo acessível
//   filterChip filtro ativo removível ("Remover filtro do card")
//   bulkBar    barra de ações em lote (role="toolbar")
//   drawerClose botão de fechar do painel de detalhe (Esc)
//   listKeys   J/K percorrem a lista, Enter abre, Esc fecha o detalhe
// O estilo de cada um fica em theme.css (seção 5). Funções de HTML devolvem string e escapam o
// texto; quem chama decide onde inserir. Script clássico (window.UIKit) e módulo CommonJS (testes).
(root => {
  const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const TONES = new Set(['up', 'down', 'flat', 'waiting', 'failed']);
  const r1 = n => Math.round(n * 10) / 10;

  // Pontos no viewBox 100×32 (2 px de folga em cima e embaixo). Série vazia ou de 1 valor: null.
  function sparkPoints(values) {
    const v = (values || []).map(Number).filter(Number.isFinite);
    if (v.length < 2) return null;
    const min = Math.min(...v), max = Math.max(...v), span = max - min || 1;
    return v.map((y, i) => [r1((i / (v.length - 1)) * 100), r1(30 - ((y - min) / span) * 28)]);
  }

  // Sem série suficiente não desenha nada: um traço inventado diria uma tendência que não existe.
  function spark(values, { label = '', tone = 'flat' } = {}) {
    const pts = sparkPoints(values);
    if (!pts) return '';
    const line = pts.map(p => p.join(',')).join(' ');
    const area = `M${pts[0][0]},32 L${pts.map(p => p.join(',')).join(' L')} L${pts.at(-1)[0]},32 Z`;
    const t = TONES.has(tone) ? tone : 'flat';
    return `<svg class="spark spark-${t}" viewBox="0 0 100 32" preserveAspectRatio="none" role="img" aria-label="${esc(label)}">`
      + `<path class="spark-area" d="${area}"/><polyline class="spark-line" points="${line}" vector-effect="non-scaling-stroke"/></svg>`;
  }

  // key: identificador do filtro (data-kcard). pressed: o filtro do card está ativo.
  // source: domínio dono do número (PRIN-003: todo número diz de onde vem), vai no title.
  function kcard({ key, label, value, delta = '', deltaTone = 'flat', hint = '', source = '', tip = '', pressed = false, series = null, sparkLabel = '' }) {
    const title = [tip, source && `Fonte: ${source}`].filter(Boolean).join(' · ');
    const t = TONES.has(deltaTone) ? deltaTone : 'flat';
    const sp = series ? spark(series, { label: sparkLabel || `Tendência de ${label}`, tone: t }) : '';
    return `<button type="button" class="kcard${sp ? '' : ' no-spark'}" data-kcard="${esc(key)}" aria-pressed="${pressed ? 'true' : 'false'}"${title ? ` title="${esc(title)}"` : ''}>`
      + `<span class="kcard-body"><span class="kcard-label">${esc(label)}</span>`
      + `<span class="kcard-row"><span class="kcard-value num">${esc(value)}</span>${delta ? `<span class="kcard-delta tone-${t}">${esc(delta)}</span>` : ''}</span></span>`
      + sp
      + (hint ? `<span class="kcard-hint">${esc(hint)}</span>` : '')
      + '</button>';
  }

  // act: valor de data-act do botão que remove o filtro (a tela trata o clique).
  function filterChip({ label, act = 'clear-kcard' }) {
    return `<span class="filter-chip">${esc(label)}<button type="button" data-act="${esc(act)}" aria-label="Remover filtro do card" title="Remover filtro">`
      + '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg></button></span>';
  }

  // actionsHtml: botões da tela (HTML confiável, já montado por quem chama).
  function bulkBar({ count, hint = '', actionsHtml = '' }) {
    count = Number(count) || 0;
    if (!count) return '';
    return `<div class="bulk-bar" role="toolbar" aria-label="Ações em lote"><span class="bulk-count num">${esc(count)} ${count === 1 ? 'selecionado' : 'selecionados'}</span>`
      + (hint ? `<span class="bulk-hint">${esc(hint)}</span>` : '') + actionsHtml + '</div>';
  }

  function drawerClose(act = 'close-detail') {
    return `<div class="drawer-close-wrap"><button type="button" class="drawer-close" data-act="${esc(act)}" aria-label="Fechar o detalhe (Esc)" title="Fechar (Esc)">`
      + '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg></button></div>';
  }

  // Próximo índice para J/K, preso às pontas (sem dar a volta, como no design).
  const step = (i, dir, n) => (n ? Math.max(0, Math.min(n - 1, (i < 0 ? (dir > 0 ? -1 : n) : i) + dir)) : -1);

  // Atalhos de lista. Ignora teclas com modificador e digitação em campos. Devolve o removedor.
  function listKeys(container, { item = '[data-row]', onOpen, onClose } = {}) {
    const typing = el => el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));
    const handler = e => {
      if (e.metaKey || e.ctrlKey || e.altKey || typing(e.target)) return;
      const k = e.key.toLowerCase();
      // Esc tratado (onClose não devolveu false) não segue para outros handlers de Esc da página.
      if (k === 'escape' && onClose) { if (onClose() !== false) { e.preventDefault(); e.stopPropagation(); } return; }
      if (k !== 'j' && k !== 'k' && k !== 'enter') return;
      const rows = [...container.querySelectorAll(item)];
      const cur = rows.indexOf(document.activeElement?.closest?.(item));
      if (k === 'enter') { if (cur >= 0 && onOpen && e.target === rows[cur]) { e.preventDefault(); onOpen(rows[cur]); } return; }
      const next = rows[step(cur, k === 'j' ? 1 : -1, rows.length)];
      if (next) { e.preventDefault(); next.focus(); next.scrollIntoView?.({ block: 'nearest' }); }
    };
    container.addEventListener('keydown', handler);
    return () => container.removeEventListener('keydown', handler);
  }

  const api = { esc, sparkPoints, spark, kcard, filterChip, bulkBar, drawerClose, step, listKeys };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.UIKit = api;
})(typeof window !== 'undefined' ? window : globalThis);
