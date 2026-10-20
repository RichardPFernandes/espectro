// Gaveta "Ver context.md" no detalhe do run: o context.md inteiro (GET
// /api/runs/:taskId/context) renderizado em Markdown (public/markdown.js) ou como texto.
// Script clássico carregado depois do principal; usa os globais runs, selected, esc,
// nearBottom e $. O principal chama ContextMd.refresh(taskId) no context_update do
// WebSocket (e no hello da reconexão); a releitura mantém a posição de leitura, e quem
// estava no fim continua acompanhando o fim.
//
// renderDetail() reescreve #detail a cada atualização do run, então o botão do hero se
// recoloca via MutationObserver; a gaveta fica fora de #detail e vive aqui.
(() => {
  const MODE_KEY = 'contextMd.mode';
  let mode = 'rendered';
  try { if (localStorage.getItem(MODE_KEY) === 'text') mode = 'text'; } catch {}

  let current = null;  // task-id aberto na gaveta
  let data = null;     // última resposta da API ou { error }
  let seq = 0;
  let timer = null;

  document.body.insertAdjacentHTML('beforeend', `<aside id="ctxMdDrawer" class="log-drawer ctxmd-drawer" aria-label="context.md do run">
    <div class="log-drawer-head">
      <h3 id="ctxMdTitle">context.md</h3>
      <div class="ctxmd-seg" role="group" aria-label="Formato">
        <button type="button" data-ctxmd-mode="rendered">Renderizado</button>
        <button type="button" data-ctxmd-mode="text">Texto</button>
      </div>
      <button type="button" class="icon-btn" id="ctxMdClose" aria-label="Fechar context.md" title="Fechar">✕</button>
    </div>
    <div id="ctxMdBody" class="log-drawer-body"></div>
  </aside>`);
  const drawer = $('ctxMdDrawer');
  const body = $('ctxMdBody');

  function paintMode() {
    drawer.querySelectorAll('[data-ctxmd-mode]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.ctxmdMode === mode)));
    body.classList.toggle('md-mode', mode === 'rendered');
  }

  function emptyText() {
    if (data?.error) return data.status === 404 ? 'Run não encontrado: pode ter sido arquivado ou removido.' : `Não foi possível carregar o context.md: ${data.error}`;
    if (data && !data.exists) return data.archived ? 'Run arquivado sem context.md disponível.' : 'Este run ainda não tem context.md.';
    if (data && !data.markdown.trim()) return 'O context.md deste run está vazio.';
    return null;
  }

  // keep: releitura ao vivo — mantém o scroll (ou segue o fim, se estava lá).
  function paint(keep) {
    const follow = keep && nearBottom(body);
    const top = body.scrollTop;
    const empty = emptyText();
    if (!data) body.innerHTML = '<div class="log-drawer-empty">Carregando…</div>';
    else if (empty) body.innerHTML = `<div class="log-drawer-empty">${esc(empty)}</div>`;
    else body.innerHTML = mode === 'text'
      ? `<pre class="contract-yaml">${esc(data.markdown)}</pre>`
      : `<div class="md-body">${window.Markdown.render(data.markdown)}</div>`;
    body.scrollTop = !keep ? 0 : follow ? body.scrollHeight : top;
  }

  async function load(keep) {
    if (!current) return;
    const taskId = current;
    const n = ++seq;
    let next;
    try {
      const res = await fetch(`/api/runs/${encodeURIComponent(taskId)}/context`);
      const json = await res.json().catch(() => ({}));
      next = res.ok ? json : { error: json.error || `HTTP ${res.status}`, status: res.status };
    } catch (e) {
      next = { error: e.message || 'sem conexão' };
    }
    if (n !== seq || taskId !== current) return;
    data = next;
    paint(keep);
  }

  function open(taskId) {
    if (typeof closeLog === 'function') closeLog(); // a gaveta do log ocupa o mesmo lugar
    current = taskId; data = null; seq++;
    $('ctxMdTitle').textContent = `context.md · ${taskId}`;
    paintMode(); paint(false);
    drawer.classList.add('open');
    $('ctxMdClose').focus();
    load(false);
  }

  // focus: false quando quem fecha é a troca de run (não rouba o foco da lista).
  function close({ focus = true } = {}) {
    if (!current) return;
    current = null; data = null; seq++; clearTimeout(timer);
    drawer.classList.remove('open');
    if (focus) document.querySelector('#detail [data-ctxmd-open]')?.focus();
  }

  function refresh(taskId) {
    if (!current || (taskId && taskId !== current)) return;
    clearTimeout(timer);
    timer = setTimeout(() => load(true), 250); // rajada de writes do watcher = uma releitura
  }

  drawer.addEventListener('click', e => {
    const b = e.target.closest('[data-ctxmd-mode]');
    if (!b || b.dataset.ctxmdMode === mode) return;
    mode = b.dataset.ctxmdMode;
    try { localStorage.setItem(MODE_KEY, mode); } catch {}
    paintMode();
    // A proporção do scroll sobrevive à troca de formato (as alturas mudam).
    const ratio = body.scrollHeight > body.clientHeight ? body.scrollTop / (body.scrollHeight - body.clientHeight) : 0;
    paint(false);
    body.scrollTop = ratio * (body.scrollHeight - body.clientHeight);
  });
  $('ctxMdClose').addEventListener('click', close);
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && current) close(); });
  document.addEventListener('click', e => {
    if (e.target.closest('#detail [data-ctxmd-open]') && selected) open(selected);
    else if (e.target.closest('#viewLogBtn, #viewOpenApiBtn')) close(); // mesma posição da gaveta do log
  });

  function injectHero() {
    const meta = document.querySelector('#detail .hero-meta');
    if (!meta || meta.querySelector('[data-ctxmd-open]') || !selected) return;
    const btn = `<button class="copy-chip" type="button" data-ctxmd-open title="Ver o context.md inteiro deste run, renderizado em Markdown">📝 Ver context.md</button>`;
    const log = meta.querySelector('#viewLogBtn');
    log ? log.insertAdjacentHTML('afterend', btn) : meta.insertAdjacentHTML('beforeend', btn);
  }

  new MutationObserver(() => {
    if (current && current !== selected) close({ focus: false }); // trocou de run com a gaveta aberta
    injectHero();
  }).observe($('detail'), { childList: true, subtree: true });
  injectHero();

  window.ContextMd = { open, close, refresh };
})();
