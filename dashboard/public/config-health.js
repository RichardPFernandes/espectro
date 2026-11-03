// Painel "Saúde do Sistema" (botão no pé do rail, #navFoot): validação da CONFIGURAÇÃO do fluxo —
// .claude/, .graph/, .env.example contra .claude/config-contract.json. Dados de
// GET /api/validate-config (= `scripts/validate-config.js --format json`, só leitura),
// buscados ao carregar, a cada 5 min e ao abrir o painel. exitCode 1 (há erros) acende
// o alerta "⚠ Erros de Configuração" no pé do rail, que também abre o painel.
// Script clássico; usa os globais do script principal (api, esc, $). Reaproveita o
// visual de .overlay/.help do ux.js, mas com camada própria (a de lá é privada).
(() => {
  const POLL_MS = 5 * 60 * 1000;
  const GROUPS = [
    { sev: 'error', title: 'Erros', tone: 'err', glyph: '✕' },
    { sev: 'warning', title: 'Avisos', tone: 'warn', glyph: '⚠' },
    { sev: 'info', title: 'Info', tone: 'info', glyph: '○' },
  ];
  let report = null, err = null, loading = false;

  // Fora da topbar (congestionada): linha própria no pé do rail, abaixo do watcher.
  // CSS em screens/system.css.
  $('navFoot').insertAdjacentHTML('beforeend', `
    <div class="cfg-foot-row">
      <button id="cfgHealthBtn" class="cfg-btn" type="button" title="Saúde do Sistema — validação da configuração do fluxo">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18l3 3 6.3-6.3a4 4 0 0 0 5.4-5.4l-2.5 2.5-2.4-.6-.6-2.4z"/></svg>
        <span class="cfg-btn-label">Saúde do Sistema</span>
        <span class="cfg-state" id="cfgState">○ validando</span>
      </button>
      <button id="cfgAlert" class="cfg-alert" type="button" hidden title="Abrir Saúde do Sistema">⚠ Erros de Configuração</button>
    </div>`);

  const layer = document.createElement('div');
  layer.className = 'overlay';
  layer.hidden = true;
  document.body.appendChild(layer);
  let lastFocus = null;

  function open() {
    lastFocus = document.activeElement;
    layer.hidden = false;
    paintPanel();
    layer.querySelector('.cfg-close')?.focus();
    load();
  }
  function close() {
    if (layer.hidden) return;
    layer.hidden = true;
    layer.innerHTML = '';
    lastFocus?.focus?.();
  }
  layer.addEventListener('click', e => {
    if (e.target.closest('[data-close]')) close();
    if (e.target.closest('.cfg-reload')) load();
  });
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && !layer.hidden) { e.stopPropagation(); close(); } }, true);
  $('cfgHealthBtn').addEventListener('click', open);
  $('cfgAlert').addEventListener('click', open);

  const when = iso => new Date(iso).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

  function item(r) {
    const details = r.details || [];
    const list = details.length
      ? `<details${details.length <= 5 ? ' open' : ''}><summary>${details.length} item(ns)</summary><ul>${details.map(d => `<li>${esc(d)}</li>`).join('')}</ul></details>` : '';
    return `<li class="cfg-item"><code class="cfg-rule">${esc(r.rule)}</code><div class="cfg-msg">${esc(r.message)}${list}</div></li>`;
  }

  function body() {
    if (err && !report) return `<p class="cfg-empty">Validação indisponível: ${esc(err)}</p>`;
    if (!report) return '<p class="cfg-empty">Validando configuração…</p>';
    const failed = report.results.filter(r => !r.passed);
    const groups = GROUPS.map(g => {
      const rs = failed.filter(r => r.severity === g.sev);
      if (!rs.length) return '';
      return `<section class="cfg-group" data-tone="${g.tone}"><h3><span class="cfg-glyph" aria-hidden="true">${g.glyph}</span>${g.title} <span>${rs.length}</span></h3><ul>${rs.map(item).join('')}</ul></section>`;
    }).join('');
    const passed = report.results.filter(r => r.passed);
    const ok = passed.length
      ? `<section class="cfg-group" data-tone="ok"><details><summary><h3><span class="cfg-glyph" aria-hidden="true">✓</span>Regras que passaram <span>${passed.length}</span></h3></summary><ul>${passed.map(item).join('')}</ul></details></section>` : '';
    return `${groups}${ok}`;
  }

  function paintPanel() {
    if (layer.hidden) return;
    const s = report?.summary;
    const head = report
      ? `<p class="cfg-head" data-valid="${report.exitCode === 0}"><span class="pill ${report.exitCode === 0 ? 'done' : 'failed'}"><span aria-hidden="true">${report.exitCode === 0 ? '✓' : '✕'}</span> ${report.exitCode === 0 ? 'válida' : 'com erros'}</span> ${esc(report.message)}</p>
         <div class="cfg-counts">
           <div><b class="ok">${report.results.filter(r => r.passed).length}</b><span>regras passaram</span></div>
           <div><b class="${s.warnings ? 'warn' : ''}">${s.warnings}</b><span>aviso(s)</span></div>
           <div><b class="${s.errors ? 'err' : ''}">${s.errors}</b><span>erro(s)</span></div>
         </div>
         <p class="cfg-meta">${s.errors} erro(s) · ${s.warnings} aviso(s) · ${s.info} info · contrato v${esc(report.contractVersion)} · ${esc(when(report.generatedAt))}${err ? ` · <span class="cfg-stale">última atualização falhou: ${esc(err)}</span>` : ''}</p>` : '';
    layer.innerHTML = `<div class="ov-backdrop" data-close></div>
      <div class="help cfg-panel" role="dialog" aria-modal="true" aria-labelledby="cfgTitle">
        <header><h2 id="cfgTitle">Saúde do Sistema</h2>
          <div class="cfg-actions"><button type="button" class="btn cfg-reload"${loading ? ' disabled' : ''}>${loading ? 'Validando…' : 'Revalidar'}</button>
          <button type="button" class="icon-btn cfg-close" data-close aria-label="Fechar" title="Fechar">✕</button></div></header>
        <div class="cfg-body">${head}${body()}</div>
        <footer class="cfg-foot">Somente leitura: o painel nunca corrige a configuração sozinho. Worktrees de ciclo encerrado ou órfãos: <code>node scripts/validate-config.js --fix</code></footer>
      </div>`;
  }

  function paintAlert() {
    const alert = $('cfgAlert');
    const bad = report && report.exitCode !== 0;
    alert.hidden = !bad;
    if (bad) alert.title = `${report.message} — abrir Saúde do Sistema`;
    const state = !report ? '' : bad ? 'err' : report.summary.warnings ? 'warn' : 'ok';
    $('cfgHealthBtn').dataset.state = state;
    // Estado com glifo + texto (nunca só a cor); sem relatório, "indisponível", nunca "ok".
    $('cfgState').textContent = state === 'err' ? `✕ ${report.summary.errors} erro(s)`
      : state === 'warn' ? `⚠ ${report.summary.warnings} aviso(s)`
      : state === 'ok' ? '✓ ok' : err ? '— indisponível' : '○ validando';
  }

  async function load() {
    if (loading) return;
    loading = true; paintPanel();
    try { report = await api('/api/validate-config'); err = null; } catch (e) { err = e.message; }
    loading = false;
    paintAlert(); paintPanel();
  }

  setInterval(() => { if (!document.hidden) load(); }, POLL_MS);
  load();

})();
