// Aba "Padrões de falha" (chave padroes): memory/patterns.md (GET /api/patterns), escrito por
// scripts/memory-consolidator.js a partir de memory/runs/. Artboard: FailureIntelligence.dc.html
// (design Espectro, onda 1, PRI-329): lista de padrões à esquerda e detalhe do escolhido à direita,
// J/K percorrem, Esc fecha o detalhe.
//
// Só entra o que o arquivo diz (comparação elemento a elemento na PRI-329). Fica fora, por falta de
// dado: origem (Execução / Recusa do QA) e seu seletor, cenário, projeto e janela de 30 dias, total em
// US$ perdido, severidade e seu filtro, custo em US$, tendência por semana, "última", "desde", status do
// padrão, custo e economia da correção, faixa "Mesma raiz que…", causa provável, correção selecionável e
// o pedido de correção, quando/custo/nota por run, abas Ao vivo e Histórico. O nó é sempre review: a
// única seção de padrões do consolidador é a de reprovações de review. A seção de alto custo e as
// recomendações que não citam um padrão também ficam fora: não estão no artboard.
//
// O modelo (parse/model/filtro) é puro e exportado para teste (CommonJS); no navegador o mesmo arquivo
// monta a tela (window.PatternsView), com UIKit (ui-kit.js) para o fechar do detalhe e o passo do J/K.
// Estilos em screens/patterns.css.
(root => {
  const escHtml = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // ---------------------------------------------------------------- modelo
  // Linhas exatas de scripts/memory-consolidator.js (renderPatternsMarkdown).
  const RE_REVIEW = /^\*\*(.+?)\*\*: ocorreu em (\d+)\/(\d+) run\(s\) revisado\(s\)(?: \(ex\.: (.+)\))?$/;
  const GENERIC_SIGNATURE = 'lógica de negócio / regra de domínio (sem item de checklist citado)';
  const KIND = [
    ['review', /^Padrões de Falha no Review/i],
    ['cost', /^Runs de Alto Custo/i],
    ['recs', /^Recomendações/i],
  ];

  // review: padrões com contagem; reviewNotes: linhas da seção fora do formato (ex.: "Nenhuma
  // reprovação…"); recs: recomendações; known: o arquivo tem ao menos uma seção do consolidador.
  function parse(markdown) {
    const out = { review: [], reviewNotes: [], recs: [], known: false, hasReview: false, runsAnalyzed: null };
    const meta = String(markdown || '').match(/<!--\s*metadata:[^>]*\bruns_analyzed=(\d+)/);
    if (meta) out.runsAnalyzed = +meta[1];
    let kind = null;
    for (const raw of String(markdown || '').split('\n')) {
      const line = raw.replace(/\s+$/, '');
      if (/^<!--.*-->$/.test(line.trim()) || /^#\s+/.test(line)) continue;
      const h = line.match(/^##\s+(.*)$/);
      if (h) {
        const k = KIND.find(([, re]) => re.test(h[1]));
        kind = k ? k[0] : null;
        if (kind) out.known = true;
        if (kind === 'review') out.hasReview = true;
        continue;
      }
      const b = line.match(/^-\s+(.*)$/);
      if (kind === 'review') {
        const text = b ? b[1] : line.trim();
        if (!text) continue;
        const m = text.match(RE_REVIEW);
        if (m) out.review.push({ sig: m[1], count: +m[2], total: +m[3], examples: m[4] ? m[4].split(/,\s*/).filter(Boolean) : [] });
        else out.reviewNotes.push(text);
      } else if (kind === 'recs' && b) out.recs.push(b[1]);
    }
    // mais frequente primeiro, ordem do arquivo no empate
    out.review = out.review.map((p, i) => ({ ...p, i })).sort((a, b) => b.count - a.count || a.i - b.i).map(({ i, ...p }) => p);
    return out;
  }

  // A recomendação que o consolidador escreveu para este padrão (recommendations(): as três primeiras
  // são por padrão de review). Frase fixa do consolidador com a assinatura entre aspas (as de decisão
  // também usam aspas, por isso o prefixo); a genérica tem frase própria.
  function recFor(p, recs) {
    const hit = p.sig === GENERIC_SIGNATURE
      ? recs.find(r => r.startsWith('Specs de regras de negócio complexas'))
      : recs.find(r => r.startsWith(`Tasks que tocam "${p.sig}"`));
    if (!hit) return null;
    const cut = hit.indexOf(' — ');
    return cut < 0 ? { action: hit, evidence: '' } : { action: hit.slice(0, cut), evidence: hit.slice(cut + 3) };
  }

  // Nó de todos os padrões do arquivo: a seção "Padrões de Falha no Review" só junta reprovações do review.
  const NODE = 'review';

  // Busca do artboard ("sintoma, nó ou run"): sintoma (assinatura), nó (review) e run de exemplo.
  function filter(list, q) {
    const s = String(q || '').trim().toLowerCase();
    if (!s) return list;
    return list.filter(p => `${p.sig} ${NODE} ${p.examples.join(' ')}`.toLowerCase().includes(s));
  }

  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

  // Estado da tela -> o que desenhar. sel: assinatura escolhida (null = detalhe fechado).
  // A contagem do consolidador é por run distinto (um run reprovado 3x pelo mesmo motivo conta 1), e o
  // arquivo guarda só os 10 padrões mais frequentes e até 3 runs de exemplo por padrão.
  function model(data, { q = '', sel } = {}) {
    if (!data?.exists) return { state: 'absent' };
    const p = parse(data.content);
    if (!p.known) return { state: 'raw', content: data.content };
    const vis = filter(p.review, q);
    const cur = sel === undefined ? vis[0]?.sig ?? null : sel;
    const x = vis.find(r => r.sig === cur) || null;
    return {
      state: 'ok', all: p.review, vis, hasReview: p.hasReview,
      // Cauda do caminho no topo (no artboard, projeto e janela): aqui só os runs que a consolidação leu.
      crumb: p.runsAnalyzed == null ? '' : plural(p.runsAnalyzed, 'run analisado', 'runs analisados'),
      clean: p.hasReview && !p.review.length ? (p.reviewNotes[0] || 'Nenhuma reprovação de review registrada.') : '',
      sel: x ? x.sig : null,
      detail: x && {
        ...x,
        reviewed: `em ${x.count} de ${plural(x.total, 'run revisado', 'runs revisados')}`,
        exampleNote: x.examples.length && x.examples.length < x.count ? `${plural(x.examples.length, 'exemplo', 'exemplos')} de ${plural(x.count, 'run', 'runs')}` : '',
        fix: recFor(x, p.recs),
      },
      // Sem a seção de review no arquivo não há contagem: nada, em vez de "0 de 0".
      status: p.hasReview ? `${vis.length} de ${plural(p.review.length, 'padrão', 'padrões')}` : '',
    };
  }

  // ---------------------------------------------------------------- HTML (puro)
  const SRC = 'Fonte: memory/patterns.md';

  function inline(text) {
    return escHtml(text)
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  }

  function rowHtml(r, cur) {
    const on = r.sig === cur;
    return `<button type="button" class="pat-row" data-pat-sel="${escHtml(r.sig)}" aria-current="${on}" title="${escHtml(`${r.count} de ${r.total} runs revisados · ${SRC}`)}">
      <span class="pat-row-meta">${NODE}</span>
      <span class="pat-row-sig">${inline(r.sig)}</span>
      <span class="pat-row-foot"><span class="num">${plural(r.count, 'ocorrência', 'ocorrências')}</span></span>
    </button>`;
  }

  // closeHtml: botão de fechar do detalhe (UIKit.drawerClose no navegador).
  function detailHtml(d, closeHtml = '') {
    const fix = d.fix ? `<section aria-labelledby="pat-fx-h" class="pat-col-main">
        <h2 id="pat-fx-h" class="pat-cap">Como corrigir na origem</h2>
        <div class="pat-fix">
          <span class="pat-fix-ring" aria-hidden="true"><span></span></span>
          <span class="pat-fix-body">
            <span class="pat-fix-label">${inline(d.fix.action)} <span class="pat-fix-rec">· recomendada</span></span>
            ${d.fix.evidence ? `<span class="pat-fix-what">${inline(d.fix.evidence)}</span>` : ''}
            <span class="pat-fix-where">recomendação do consolidador · memory/patterns.md</span>
          </span>
        </div>
      </section>` : '';
    const ex = d.examples.length ? `<aside aria-labelledby="pat-ex-h" class="pat-where">
        <h2 id="pat-ex-h" class="pat-cap">Onde aconteceu</h2>
        ${d.examples.map(id => `<a href="#run/${encodeURIComponent(id)}" data-pat-run="${escHtml(id)}" title="Abrir o run"><span class="pat-ex-top"><span class="pat-run">${escHtml(id)}</span><span class="pat-ex-node">${NODE}</span></span></a>`).join('')}
        ${d.exampleNote ? `<span class="pat-where-note">${escHtml(d.exampleNote)} · memory/patterns.md</span>` : ''}
      </aside>` : '';
    return `<section class="pat-detail" aria-labelledby="pat-h">
      ${closeHtml}
      <article class="pat-article">
        <div class="pat-title"><span class="pat-title-meta">nó ${NODE}</span><h1 id="pat-h">${inline(d.sig)}</h1></div>
        <div class="pat-stats">
          <div class="pat-stat" title="${SRC} · contagem por run"><span class="pat-stat-k">Ocorrências</span><span class="pat-stat-v num">${d.count}</span><span class="pat-stat-d">${escHtml(d.reviewed)}</span></div>
        </div>
        <div role="tablist" aria-label="Partes do padrão" class="pat-tabs">
          <button type="button" role="tab" id="pat-tab-fix" class="pat-tab" aria-selected="true" aria-controls="pat-panel-fix" tabindex="0"><kbd>1</kbd>Causa e correção<span class="num">${d.fix ? 1 : 0}</span></button>
        </div>
        <div role="tabpanel" id="pat-panel-fix" aria-labelledby="pat-tab-fix" class="pat-panel">
          ${fix || ex ? `<div class="pat-cols">${fix}${ex}</div>` : '<span class="pat-empty-h">O arquivo não traz recomendação nem run de exemplo para este padrão.</span>'}
        </div>
      </article>
    </section>`;
  }

  const exported = { RE_REVIEW, GENERIC_SIGNATURE, NODE, parse, recFor, filter, model, inline, rowHtml, detailHtml };
  if (typeof module !== 'undefined' && module.exports) { module.exports = exported; return; }

  // ---------------------------------------------------------------- navegador
  const st = { data: null, loading: false, error: null, loadedOnce: false, q: '', sel: undefined };

  async function load() {
    st.loading = true; st.error = null;
    root.Views?.refresh();
    try {
      st.data = await api('/api/patterns');
    } catch (e) {
      st.error = e.message;
    }
    st.loading = false; st.loadedOnce = true;
    root.Views?.refresh();
  }

  // Arquivo fora do formato do consolidador: mostra o markdown como veio (##, listas, **bold**,
  // `code`; comentários HTML de metadata nunca aparecem), para não esconder conteúdo.
  function mdToHtml(markdown) {
    const html = [];
    let inList = false;
    const closeList = () => { if (inList) { html.push('</ul>'); inList = false; } };
    for (const raw of String(markdown || '').split('\n')) {
      const line = raw.replace(/\s+$/, '');
      if (/^<!--.*-->$/.test(line.trim())) continue;
      const bullet = line.match(/^-\s+(.*)$/);
      if (/^#\s+/.test(line)) { closeList(); continue; }
      if (/^##\s+/.test(line)) { closeList(); html.push(`<h2 class="pat-cap">${inline(line.replace(/^##\s+/, ''))}</h2>`); continue; }
      if (bullet) {
        if (!inList) { html.push('<ul class="pat-md-list">'); inList = true; }
        html.push(`<li>${inline(bullet[1])}</li>`);
        continue;
      }
      if (line.trim()) { closeList(); html.push(`<p>${inline(line)}</p>`); } else closeList();
    }
    closeList();
    return html.join('\n');
  }

  const note = (tone, glyph, text) => `<div role="note" class="pat-note ${tone}"><span aria-hidden="true">${glyph} </span>${text}</div>`;
  const empty = (title, hint) => `<div class="pat-empty"><span class="pat-empty-t">${title}</span><span class="pat-empty-h">${hint}</span></div>`;

  function render() {
    if (!st.loadedOnce && !st.loading) load();
    keepFocus();
    const search = `<input type="search" class="pat-q" data-pat-q aria-label="Buscar padrões" placeholder="Buscar por sintoma, nó ou run" value="${escHtml(st.q)}">`;
    const shell = (side, detail = '', status = '') => `<div class="pat">
      <div class="pat-panes" tabindex="0" aria-label="Padrões de falha. J e K navegam, Esc fecha.">
        <section class="pat-side${detail ? ' has-sel' : ''}" aria-label="Padrões, do mais frequente ao menos frequente">${side}</section>${detail}
      </div>
      <footer class="pat-status"><span role="status">${status}</span><span class="pat-keys">J K navegar · Esc fechar · ⌘K paleta</span></footer>
    </div>`;
    const top = extra => `<div class="pat-tools">${search}${extra || ''}</div>`;

    paintTopbar(st.data && !st.error ? model(st.data).crumb || '' : '');
    if (st.error) return shell(top(note('failed', '✕', `Não deu para ler os padrões: ${escHtml(st.error)}. Saia e volte para esta tela para tentar de novo.`)));
    if (!st.data) return shell(top(), '', 'Carregando…');
    const m = model(st.data, { q: st.q, sel: st.sel });
    if (m.state === 'absent') return shell(top() + empty('Ainda não há padrões.', 'O arquivo <code>memory/patterns.md</code> não existe. Ele nasce depois de 10 runs completados, ou rodando <code>node scripts/memory-consolidator.js</code>.'));
    if (m.state === 'raw') return shell(`<div class="pat-md">${mdToHtml(m.content)}</div>`);
    const list = m.vis.map(r => rowHtml(r, m.sel)).join('');
    const side = top(m.clean ? note('done', '✓', inline(m.clean)) : '')
      + (!m.vis.length && !m.clean ? empty('Nenhum padrão nesse recorte.', m.all.length ? 'Limpe a busca.' : 'A seção de padrões de review não está no arquivo.') : '')
      + list;
    return shell(side, m.detail ? detailHtml(m.detail, root.UIKit.drawerClose('pat-close')) : '',
      m.status ? `<span title="${SRC}">${m.status}</span>` : '');
  }

  // Cauda do caminho no topbar do shell (como em Roteamento); some nas outras telas pelo CSS.
  function paintTopbar(text) {
    const crumbs = root.document.querySelector?.('.topbar .crumbs-top');
    if (!crumbs) return;
    let tail = root.document.getElementById('patCrumbTail');
    if (!tail) {
      tail = root.document.createElement('span');
      tail.id = 'patCrumbTail'; tail.className = 'pat-crumb-tail';
      crumbs.append(tail);
    }
    const html = text ? `<span aria-hidden="true">›</span><span title="${SRC} · runs_analyzed">${escHtml(text)}</span>` : '';
    if (tail.innerHTML !== html) tail.innerHTML = html;
  }

  // #view é remontado a cada refresh (eventos ao vivo): devolve foco, cursor da busca e rolagem
  // dos painéis depois que o HTML novo entra (microtarefa roda depois do innerHTML do refresh).
  // Foco que estava em qualquer lugar da tela (linha, X, painel) volta para a linha escolhida, ou
  // para o painel: J/K/Esc continuam funcionando depois de um clique. Detalhe de outro padrão
  // abre do topo; a linha escolhida fica visível.
  let shownSel = null;
  function keepFocus() {
    const view = $('view');
    const a = root.document.activeElement;
    const inQ = a?.matches?.('[data-pat-q]') ? [a.selectionStart, a.selectionEnd] : null;
    const inPat = !inQ && !!a?.closest?.('.pat');
    const side = view.querySelector('.pat-side')?.scrollTop || 0;
    const det = view.querySelector('.pat-detail')?.scrollTop || 0;
    queueMicrotask(() => {
      const row = view.querySelector('.pat-row[aria-current="true"]');
      const sel = row?.dataset.patSel ?? null;
      const s = view.querySelector('.pat-side'); if (s) s.scrollTop = side;
      const d = view.querySelector('.pat-detail'); if (d) d.scrollTop = sel === shownSel ? det : 0;
      if (sel !== shownSel) row?.scrollIntoView?.({ block: 'nearest' });
      shownSel = sel;
      if (inQ) { const q = view.querySelector('[data-pat-q]'); q?.focus(); q?.setSelectionRange(inQ[0], inQ[1]); }
      else if (inPat) (row || view.querySelector('.pat-panes'))?.focus({ preventScroll: true });
    });
  }

  function current() { return st.data ? model(st.data, { q: st.q, sel: st.sel }) : null; }
  function select(sig) { st.sel = sig; root.Views?.refresh(); }

  const view = $('view');
  view.addEventListener('click', e => {
    const row = e.target.closest('[data-pat-sel]');
    if (row) { select(row.dataset.patSel); return; }
    // Abre o run direto: pelo hash, o ux.js ignora o run que já é o selecionado em Runs.
    const run = e.target.closest('[data-pat-run]');
    if (run && root.Views?.openRun) { e.preventDefault(); root.Views.openRun(run.dataset.patRun); return; }
    if (e.target.closest('[data-act="pat-close"]')) select(null);
  });
  view.addEventListener('input', e => {
    if (!e.target.matches('[data-pat-q]')) return;
    st.q = e.target.value; st.sel = undefined; root.Views?.refresh();
  });
  view.addEventListener('keydown', e => {
    if (root.Views?.current() !== 'padroes' || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
    const m = current();
    if (m?.state !== 'ok') return;
    const k = e.key.toLowerCase();
    if (k === 'escape' && m.sel) { e.preventDefault(); e.stopPropagation(); select(null); return; }
    if ((k === 'j' || k === 'k') && m.vis.length) {
      e.preventDefault();
      const i = m.vis.findIndex(r => r.sig === m.sel);
      select(m.vis[root.UIKit.step(i, k === 'j' ? 1 : -1, m.vis.length)].sig);
    }
  });
  // Entrar de novo na tela relê o arquivo (o consolidador reescreve a cada 10 runs completados).
  new MutationObserver(() => {
    if (root.document.body.dataset.view === 'padroes' && st.loadedOnce && !st.loading) load();
  }).observe(root.document.body, { attributes: true, attributeFilter: ['data-view'] });

  root.PatternsView = { render, load };
  root.Views?.refresh();
})(typeof window !== 'undefined' ? window : globalThis);
