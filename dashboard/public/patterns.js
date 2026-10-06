// Aba "Padrões": memory/patterns.md (GET /api/patterns), gerado periodicamente por
// scripts/memory-consolidator.js a partir do histórico de memory/runs/. Mesmo padrão
// de graph.js: módulo próprio carregado depois de views.js, cache local com
// load()/render(), plugado em VIEWS/RENDER de views.js. Sem lib de markdown externa —
// mini-renderer local (suficiente pro formato fixo gerado pelo consolidador: ##,
// listas, **bold**, `code`, comentários HTML de metadata ignorados na renderização).
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

  function render() {
    if (!st.loadedOnce && !st.loading) load();
    const d = st.data;
    const head = `<div class="vhead"><h2>Padrões</h2>
      <p>Padrões de falha de review e de custo alto, consolidados por <code>scripts/memory-consolidator.js</code> a partir de <code>memory/runs/</code>. O watcher reconsolida a cada 10 runs completados novos; o botão abaixo força uma leitura do arquivo atual.</p>
      <div class="vtools"><button class="ghost-btn" type="button" data-pat-reload ${st.loading ? 'disabled' : ''}>${st.loading ? 'Carregando…' : '↻ Atualizar'}</button>
        ${d?.lastConsolidationAt ? `<span class="muted" title="${esc(when(d.lastConsolidationAt))}">última consolidação ${esc(ago(d.lastConsolidationAt))} · ${esc(String(d.totalConsolidations ?? 0))} execução(ões)</span>` : ''}
      </div></div>`;
    if (st.error) return `${head}<p class="fold-msg warn">Não deu para ler os padrões: ${esc(st.error)}</p>`;
    if (!d) return `${head}<div class="vempty">Carregando…</div>`;
    if (!d.exists) return `${head}<div class="vempty">Ainda não existe <code>memory/patterns.md</code>. Ele nasce depois de 10 runs completados no histórico (contador em <code>memory/consolidator-state.json</code>), ou rodando <code>node scripts/memory-consolidator.js</code> manualmente.</div>`;
    return `${head}<div class="pat-body">${mdToHtml(d.content)}</div>`;
  }

  const view = $('view');
  view.addEventListener('click', e => {
    if (e.target.closest('[data-pat-reload]')) load();
  });

  const style = document.createElement('style');
  style.textContent = `
    .pat-body h3.pat-h { margin: 18px 0 8px; font-size: 15px; color: var(--ink-2); }
    .pat-body h3.pat-h:first-child { margin-top: 0; }
    .pat-list { margin: 0 0 4px; padding-left: 20px; display: grid; gap: 4px; }
    .pat-body p { margin: 0 0 8px; color: var(--muted); font-size: 13.5px; }
    .pat-body code { font: 12.5px var(--mono); background: var(--sunken); padding: 1px 4px; border-radius: 4px; overflow-wrap: anywhere; }
  `;
  document.head.appendChild(style);

  window.PatternsView = { render, load };
  window.Views?.refresh();
})();
