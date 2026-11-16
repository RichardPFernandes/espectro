// Aba "Verificações de UI" (chave verificacoes-ui, PRI-361): veredito, achados e screenshots que o
// /verify-ui gravou em .prisma/ui-verify/ (PRI-355), lidos por GET /api/ui-verify. Só leitura.
//
// A aba só entra no menu se a API responde 200: com PRISMA_UI_VERIFY_TAB desligada (padrão) a API
// responde 404 e a tela não existe. Nada inventado: veredito ausente ou desconhecido é "Sem veredito",
// nunca "Passou". Todo texto vindo do disco é escapado; a URL da imagem só sai de nomes seguros.
//
// O modelo e o HTML são puros e exportados para teste (CommonJS); no navegador o mesmo arquivo registra
// a aba (window.UiVerifyView) por Views.addView. Estilos em screens/ui-verify.css.
(root => {
  const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const KEY = 'verificacoes-ui';
  const LABEL = 'Verificações de UI';
  const ICON = 'M4 5h16v11H4zM9 20h6M12 16v4M8 10l3 3 5-5';
  const TASK_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
  const IMAGE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,123}\.png$/;

  const VERDICT = {
    PASSOU: { label: 'Passou', tone: 'ok' },
    FALHOU: { label: 'Falhou', tone: 'bad' },
    'N/A': { label: 'Não se aplica', tone: 'muted' },
    SKIPPED: { label: 'Pulada', tone: 'muted' },
  };
  const UNKNOWN = { label: 'Sem veredito', tone: 'warn' };
  const verdictOf = v => (Object.prototype.hasOwnProperty.call(VERDICT, v) ? VERDICT[v] : UNKNOWN);

  function imageUrl(taskId, file) {
    if (!TASK_RE.test(String(taskId)) || !IMAGE_RE.test(String(file))) return null;
    return `/api/ui-verify/${encodeURIComponent(taskId)}/${encodeURIComponent(file)}`;
  }

  // ---------------------------------------------------------------- modelo
  function model(data, { sel } = {}) {
    if (!data) return { state: 'loading', rows: [] };
    if (data.error) return { state: 'error', error: String(data.error), rows: [] };
    const tasks = Array.isArray(data.tasks) ? data.tasks : [];
    if (!tasks.length) return { state: 'empty', rows: [] };
    const rows = tasks.map(t => {
      const v = verdictOf(t.verdict);
      return { taskId: t.taskId, label: v.label, tone: v.tone, problems: Array.isArray(t.problems) ? t.problems.length : 0, updatedAt: t.updatedAt || null };
    });
    const chosen = rows.some(r => r.taskId === sel) ? sel : rows[0].taskId;
    const raw = tasks.find(t => t.taskId === chosen);
    const v = verdictOf(raw.verdict);
    return { state: 'ok', rows, sel: chosen, detail: { ...raw, label: v.label, tone: v.tone } };
  }

  // ---------------------------------------------------------------- HTML
  const when = iso => {
    const d = iso ? new Date(iso) : null;
    return d && !Number.isNaN(d.getTime()) ? d.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' }) : 'sem data';
  };
  const badge = (tone, label) => `<span class="uiv-badge ${esc(tone)}">${esc(label)}</span>`;

  function rowHtml(r, sel) {
    const meta = r.problems ? `${r.problems} problema${r.problems === 1 ? '' : 's'}` : 'sem problemas';
    return `<button type="button" class="uiv-row" data-uiv-sel="${esc(r.taskId)}" aria-current="${r.taskId === sel}">
      <span class="uiv-row-id">${esc(r.taskId)}</span>${badge(r.tone, r.label)}
      <span class="uiv-row-meta">${esc(meta)} · ${esc(when(r.updatedAt))}</span></button>`;
  }

  function screenHtml(taskId, s) {
    const url = s.image ? imageUrl(taskId, s.image) : null;
    const exp = s.expected || { total: 0, found: 0 };
    const img = url
      ? `<a href="${esc(url)}" target="_blank" rel="noopener"><img class="uiv-shot" src="${esc(url)}" alt="Captura da tela do ${esc(s.ac)}" loading="lazy"></a>`
      : '<div class="uiv-noshot">Sem captura registrada</div>';
    return `<figure class="uiv-screen"><figcaption><strong>${esc(s.ac)}</strong> <span class="uiv-muted">${esc(s.url)}</span>
      <span class="uiv-muted">Elementos: ${esc(exp.found)} de ${esc(exp.total)} · erros de console: ${esc(s.consoleErrors)} · requisições: ${esc(s.requests)}</span></figcaption>${img}</figure>`;
  }

  function detailHtml(d) {
    const problems = (d.problems || []).length
      ? `<ul class="uiv-problems">${d.problems.map(p => `<li><code>${esc(p.code)}</code> <span class="uiv-muted">${esc(p.where)}</span><div>${esc(p.detail)}</div></li>`).join('')}</ul>${d.omitted ? `<p class="uiv-muted">+${esc(d.omitted)} problemas omitidos</p>` : ''}`
      : '<p class="uiv-muted">Nenhum problema registrado.</p>';
    const screens = (d.screens || []).length
      ? (d.screens).map(s => screenHtml(d.taskId, s)).join('')
      : '<p class="uiv-muted">Nenhuma tela registrada nos achados.</p>';
    return `<article class="uiv-article">
      <header class="uiv-title"><span class="uiv-muted">${esc(when(d.updatedAt))}</span><h1>${esc(d.taskId)} ${badge(d.tone, d.label)}</h1>${d.reason ? `<p class="uiv-muted">${esc(d.reason)}</p>` : ''}</header>
      <section><h2>Problemas</h2>${problems}</section>
      <section><h2>Telas verificadas</h2>${screens}</section></article>`;
  }

  function renderHtml(m) {
    const shell = (body, status = '') => `<div class="uiv">${body}<footer class="uiv-status"><span role="status">${esc(status)}</span></footer></div>`;
    if (m.state === 'loading') return shell('<div class="uiv-empty">Carregando…</div>', 'Carregando…');
    if (m.state === 'error') return shell(`<div class="uiv-empty"><p class="uiv-empty-t">Não deu para ler as verificações.</p><p class="uiv-muted">${esc(m.error)}</p></div>`);
    if (m.state === 'empty') {
      return shell('<div class="uiv-empty"><p class="uiv-empty-t">Nenhuma verificação ainda.</p><p class="uiv-muted">Elas aparecem aqui depois de rodar <code>/verify-ui</code>.</p></div>');
    }
    return shell(`<div class="uiv-panes"><section class="uiv-side" aria-label="Verificações, da mais recente para a mais antiga">${m.rows.map(r => rowHtml(r, m.sel)).join('')}</section><div class="uiv-detail">${detailHtml(m.detail)}</div></div>`,
      `${m.rows.length} verificaç${m.rows.length === 1 ? 'ão' : 'ões'} · somente leitura`);
  }

  // ---------------------------------------------------------------- navegador
  const st = { data: null, sel: undefined, loading: false };

  // Pergunta à API se a aba existe. Flag desligada responde 200 `{enabled:false}` (sem 4xx na carga da
  // página); isso, erro HTTP ou falha de rede: a aba não entra no menu.
  async function probe(env) {
    try {
      const res = await env.fetch('/api/ui-verify', { cache: 'no-store' });
      if (!res || !res.ok) return null;
      const data = await res.json();
      if (!data || data.enabled !== true) return null;
      st.data = data;
      env.Views?.addView?.(KEY, LABEL, 'Operação', ICON);
      return data;
    } catch { return null; }
  }

  async function load() {
    if (st.loading) return;
    st.loading = true;
    try {
      const res = await root.fetch('/api/ui-verify', { cache: 'no-store' });
      st.data = res.ok ? await res.json() : { error: `HTTP ${res.status}` };
    } catch (e) { st.data = { error: e.message }; }
    st.loading = false;
    root.Views?.refresh();
  }

  function render() { return renderHtml(model(st.data, { sel: st.sel })); }

  if (typeof window !== 'undefined') {
    const view = root.document.getElementById('view');
    view?.addEventListener('click', e => {
      const row = e.target.closest?.('[data-uiv-sel]');
      if (row) { st.sel = row.dataset.uivSel; root.Views?.refresh(); }
    });
    // Entrar de novo na aba relê a pasta (o /verify-ui grava fora do dashboard).
    new MutationObserver(() => { if (root.document.body.dataset.view === KEY) load(); })
      .observe(root.document.body, { attributes: true, attributeFilter: ['data-view'] });
    root.UiVerifyView = { render, load };
    probe(root);
  }

  const api = { model, renderHtml, imageUrl, probe, KEY };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
