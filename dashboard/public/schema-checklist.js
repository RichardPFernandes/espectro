// Checklist de migração (seção "## ⚠️ Schema Migration Checklist" que o watcher grava
// no context.md — ver scripts/lib/schema-watcher.js) no detalhe do run: markdown ->
// HTML com checkboxes interativos, estado dos checkboxes no localStorage por task-id e
// markdown de volta (com os checks atuais) pro botão "Copiar checklist".
//
// O estado salvo carrega a signature do bloco: quando o watcher regenera a checklist
// (mudou o que foi detectado no diff), os checks antigos deixam de valer e caem fora.
// Carregado como script clássico (window.SchemaChecklist) e via require() nos testes.
(function (root) {
  const CHECK_RE = /^(\s*[-*]\s+)\[( |x|X)\]\s+(.*)$/;
  const RISK = {
    low: { label: 'low', title: 'Mudança de schema de risco baixo (ADD)' },
    medium: { label: 'medium', title: 'Mudança de schema de risco médio (ALTER)' },
    high: { label: 'high', title: 'Mudança de schema de risco alto (DROP/RENAME)' },
  };

  function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function inline(text) {
    return esc(text)
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  }

  // Checkboxes do markdown, na ordem: [{ index, checked, text }].
  function items(markdown) {
    const out = [];
    for (const line of String(markdown || '').split('\n')) {
      const m = line.match(CHECK_RE);
      if (m) out.push({ index: out.length, checked: m[2] !== ' ', text: m[3] });
    }
    return out;
  }

  function storageKey(taskId) { return `schemaChecklist:${taskId}`; }

  // Estado efetivo: o do markdown, sobrescrito pelo salvo (se for da mesma signature).
  function effectiveChecks(markdown, saved, signature) {
    const base = items(markdown).map(i => i.checked);
    const own = saved && saved.sig === (signature || null) && saved.checked && typeof saved.checked === 'object' ? saved.checked : {};
    return base.map((v, i) => (typeof own[i] === 'boolean' ? own[i] : v));
  }

  // markdown -> HTML. Suporta o que o template usa: ##/###, > citação, listas, [ ]/[x],
  // **negrito** e `código`. Tudo escapado — o conteúdo vem do diff do ticket.
  function render(markdown, checks, { idPrefix = 'mig' } = {}) {
    const html = [];
    let list = null; // 'ul' aberto
    let quote = [];
    let n = 0;
    const closeList = () => { if (list) { html.push('</ul>'); list = null; } };
    const flushQuote = () => { if (quote.length) { html.push(`<blockquote>${quote.map(inline).join(' ')}</blockquote>`); quote = []; } };
    for (const raw of String(markdown || '').split('\n')) {
      const line = raw.replace(/\s+$/, '');
      const check = line.match(CHECK_RE);
      const bullet = !check && line.match(/^\s*[-*]\s+(.*)$/);
      if (/^>\s?/.test(line)) { closeList(); quote.push(line.replace(/^>\s?/, '')); continue; }
      flushQuote();
      if (check) {
        const i = n++;
        const on = checks ? !!checks[i] : check[2] !== ' ';
        if (list !== 'ul') { closeList(); html.push('<ul class="mig-list">'); list = 'ul'; }
        html.push(`<li class="mig-check${on ? ' done' : ''}"><label><input type="checkbox" data-mig-index="${i}" id="${esc(idPrefix)}-${i}"${on ? ' checked' : ''}> <span>${inline(check[3])}</span></label></li>`);
      } else if (bullet) {
        if (list !== 'ul') { closeList(); html.push('<ul class="mig-list">'); list = 'ul'; }
        html.push(`<li>${inline(bullet[1])}</li>`);
      } else if (/^##\s+/.test(line) && !/^###/.test(line)) {
        closeList(); // título da seção já está no summary do fold
      } else if (/^###\s+/.test(line)) {
        closeList(); html.push(`<h5>${inline(line.replace(/^###\s+/, ''))}</h5>`);
      } else if (line.trim()) {
        closeList(); html.push(`<p>${inline(line)}</p>`);
      } else {
        closeList();
      }
    }
    flushQuote(); closeList();
    return html.join('\n');
  }

  // Markdown com os checks atuais — o que o botão "Copiar checklist" põe no clipboard.
  function toMarkdown(markdown, checks) {
    let n = 0;
    return String(markdown || '').split('\n').map(line => {
      const m = line.match(CHECK_RE);
      if (!m) return line;
      const on = checks ? !!checks[n] : m[2] !== ' ';
      n++;
      return `${m[1]}[${on ? 'x' : ' '}] ${m[3]}`;
    }).join('\n');
  }

  function progress(checks) {
    const list = checks || [];
    return { done: list.filter(Boolean).length, total: list.length };
  }

  const api = { items, render, toMarkdown, effectiveChecks, storageKey, progress, RISK };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SchemaChecklist = api;
})(typeof window !== 'undefined' ? window : globalThis);
