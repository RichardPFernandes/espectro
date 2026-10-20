// Markdown -> HTML do preview do context.md (public/context-md.js). O arquivo é escrito
// por agentes, então nada do texto vira tag: tudo passa por esc() e só as tags geradas
// aqui entram no HTML. HTML cru aparece como texto; links só http(s)/mailto, sempre em
// aba nova com rel="noopener noreferrer"; imagem vira link (nada é carregado sozinho).
//
// Suporta o que os agentes escrevem: #..######, parágrafos (quebra de linha mantida, o
// context.md é log), listas (aninhadas, numeradas, [ ]/[x]), > citação, ``` código,
// tabelas GFM, ---, **negrito**, *itálico*, ~~riscado~~, `código`, [link](url), URL solta.
// Carregado como script clássico (window.Markdown) e via require() nos testes.
(function (root) {
  function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  const SAFE_URL = /^(https?:\/\/|mailto:)/i;
  const link = (href, label) => `<a href="${esc(href)}" target="_blank" rel="noopener noreferrer">${label}</a>`;

  // Inline. Código, links e URLs viram marcadores \u0001N\u0002 antes do esc() pra que
  // ênfase não mexa neles; o resto do texto é escapado e só então recebe <strong>/<em>.
  function inline(text, { links = true } = {}) {
    const slots = [];
    const hold = html => `\u0001${slots.push(html) - 1}\u0002`;
    let s = String(text ?? '').replace(/[\u0001\u0002]/g, '');
    s = s.replace(/(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/g, (_, _t, code) => hold(`<code>${esc(code.trim() || code)}</code>`));
    if (links) {
      s = s.replace(/(!?)\[([^\]\n]*)\]\(\s*<?((?:[^()\s<>]|\([^()\s<>]*\))+)>?(?:\s+"[^"]*")?\s*\)/g, (m, img, label, url) => {
        const inner = inline(label || url, { links: false });
        if (!SAFE_URL.test(url)) return hold(inner || esc(url));
        return hold(link(url, img ? `🖼 ${inner || esc(url)}` : inner || esc(url)));
      });
      s = s.replace(/<((?:https?:\/\/|mailto:)[^\s<>"]+)>/gi, (_, url) => hold(link(url, esc(url))));
      s = s.replace(/\bhttps?:\/\/[^\s<>"'`]+/gi, m => {
        const url = m.replace(/[.,;:!?)\]]+$/, '');
        return hold(link(url, esc(url))) + m.slice(url.length);
      });
    }
    s = esc(s)
      .replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^\w])__(?=\S)([\s\S]*?\S)__(?!\w)/g, '$1<strong>$2</strong>')
      .replace(/~~(?=\S)([\s\S]*?\S)~~/g, '<del>$1</del>')
      .replace(/(^|[^*\w])\*(?=[^\s*])([^*]*?[^\s*])\*(?!\*)/g, '$1<em>$2</em>')
      .replace(/(^|[^\w])_(?=[^\s_])([^_]*?[^\s_])_(?!\w)/g, '$1<em>$2</em>');
    return s.replace(/\u0001(\d+)\u0002/g, (_, i) => slots[i]);
  }

  const FENCE = /^ {0,3}(`{3,}|~{3,})\s*([^`\s]*)/;
  const HEADING = /^ {0,3}(#{1,6})\s+(.*?)(?:\s+#+)?\s*$/;
  const HR = /^ {0,3}([-*_])(\s*\1){2,}\s*$/;
  const ITEM = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
  const TASK = /^\[( |x|X)\]\s+(.*)$/;
  const TABLE_SEP = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;

  function cells(line) {
    let s = line.trim();
    if (s.startsWith('|')) s = s.slice(1);
    if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
    const out = [];
    let cur = '';
    for (let i = 0; i < s.length; i++) {
      if (s[i] === '\\' && s[i + 1] === '|') { cur += '|'; i++; } else if (s[i] === '|') { out.push(cur.trim()); cur = ''; } else cur += s[i];
    }
    out.push(cur.trim());
    return out;
  }

  function table(head, sep, rows) {
    const align = cells(sep).map(c => (/^:-+:$/.test(c) ? 'center' : /-:$/.test(c) ? 'right' : /^:-/.test(c) ? 'left' : ''));
    const cell = (tag, text, i) => `<${tag}${align[i] ? ` style="text-align:${align[i]}"` : ''}>${inline(text)}</${tag}>`;
    const cols = cells(head);
    const body = rows.map(r => { const c = cells(r); return `<tr>${cols.map((_, i) => cell('td', c[i] || '', i)).join('')}</tr>`; });
    return `<div class="md-table"><table><thead><tr>${cols.map((c, i) => cell('th', c, i)).join('')}</tr></thead>${body.length ? `<tbody>${body.join('')}</tbody>` : ''}</table></div>`;
  }

  // Lista a partir de lines[start]; devolve { html, next }. Itens com recuo maior que o
  // do item atual abrem sublista; linha recuada sem marcador continua o item.
  function list(lines, start) {
    const html = [];
    const stack = []; // { tag, indent }
    let i = start;
    let open = false; // <li> aberto no topo da pilha
    const closeTo = indent => {
      while (stack.length && stack[stack.length - 1].indent > indent) {
        html.push(`</li></${stack.pop().tag}>`);
      }
    };
    for (; i < lines.length; i++) {
      const line = lines[i];
      const m = line.match(ITEM);
      if (m && !HR.test(line)) {
        const indent = m[1].replace(/\t/g, '    ').length;
        const tag = /^\d/.test(m[2]) ? 'ol' : 'ul';
        closeTo(indent);
        const top = stack[stack.length - 1];
        if (!top || indent > top.indent) {
          const startAt = tag === 'ol' && parseInt(m[2], 10) !== 1 ? ` start="${parseInt(m[2], 10)}"` : '';
          html.push(`<${tag}${startAt}>`);
          stack.push({ tag, indent });
        } else if (top.tag !== tag) {
          html.push(`</li></${top.tag}><${tag}>`);
          top.tag = tag;
        } else if (open) {
          html.push('</li>');
        }
        const task = m[3].match(TASK);
        html.push(task
          ? `<li class="md-task"><input type="checkbox" disabled${task[1] !== ' ' ? ' checked' : ''}> ${inline(task[2])}`
          : `<li>${inline(m[3])}`);
        open = true;
        continue;
      }
      if (line.trim() && /^\s+\S/.test(line) && stack.length && !FENCE.test(line)) {
        html.push(`<br>${inline(line.trim())}`);
        continue;
      }
      break;
    }
    closeTo(-1);
    return { html: html.join(''), next: i };
  }

  function render(markdown) {
    const lines = String(markdown ?? '').replace(/\r\n?/g, '\n').split('\n');
    const html = [];
    let para = [];
    const flush = () => { if (para.length) { html.push(`<p>${para.map(l => inline(l)).join('<br>')}</p>`); para = []; } };
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const fence = line.match(FENCE);
      if (fence) {
        flush();
        const code = [];
        const close = new RegExp(`^ {0,3}${fence[1][0] === '`' ? '`' : '~'}{${fence[1].length},}\\s*$`);
        for (i++; i < lines.length && !close.test(lines[i]); i++) code.push(lines[i]);
        const lang = fence[2] ? ` data-lang="${esc(fence[2])}"` : '';
        html.push(`<pre class="md-code"${lang}><code>${esc(code.join('\n'))}</code></pre>`);
        continue;
      }
      if (!line.trim()) { flush(); continue; }
      const h = line.match(HEADING);
      if (h) { flush(); html.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`); continue; }
      if (HR.test(line)) { flush(); html.push('<hr>'); continue; }
      if (/^ {0,3}>/.test(line)) {
        flush();
        const quote = [];
        for (; i < lines.length && /^ {0,3}>/.test(lines[i]); i++) quote.push(lines[i].replace(/^ {0,3}>\s?/, ''));
        i--;
        html.push(`<blockquote>${render(quote.join('\n'))}</blockquote>`);
        continue;
      }
      if (line.includes('|') && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1]) && lines[i + 1].includes('|')) {
        flush();
        const rows = [];
        let j = i + 2;
        for (; j < lines.length && lines[j].trim() && lines[j].includes('|'); j++) rows.push(lines[j]);
        html.push(table(line, lines[i + 1], rows));
        i = j - 1;
        continue;
      }
      if (ITEM.test(line) && (!para.length || !/^\s/.test(line))) {
        flush();
        const l = list(lines, i);
        html.push(l.html);
        i = l.next - 1;
        continue;
      }
      para.push(line.trim());
    }
    flush();
    return html.join('\n');
  }

  const api = { render, inline, esc };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Markdown = api;
})(typeof window !== 'undefined' ? window : globalThis);
