// Painel "Saúde do Sistema" (🔧 no topo): validação da CONFIGURAÇÃO do fluxo —
// .claude/, .graph/, .env.example contra .claude/config-contract.json. Dados de
// GET /api/validate-config (= `scripts/validate-config.js --format json`, só leitura),
// buscados ao carregar, a cada 5 min e ao abrir o painel. exitCode 1 (há erros) acende
// o alerta "⚠ Erros de Configuração" no topo, que também abre o painel.
// Script clássico; usa os globais do script principal (api, esc, $). Reaproveita o
// visual de .overlay/.help do ux.js, mas com camada própria (a de lá é privada).
(() => {
  const POLL_MS = 5 * 60 * 1000;
  const GROUPS = [
    { sev: 'error', title: 'Erros', tone: 'err' },
    { sev: 'warning', title: 'Avisos', tone: 'warn' },
    { sev: 'info', title: 'Info', tone: 'info' },
  ];
  let report = null, err = null, loading = false;

  $('theme').insertAdjacentHTML('beforebegin', `
    <button id="cfgAlert" class="cfg-alert" type="button" hidden title="Abrir Saúde do Sistema">⚠ Erros de Configuração</button>
    <button id="cfgHealthBtn" class="icon-btn" type="button" title="Saúde do Sistema" aria-label="Saúde do Sistema">🔧</button>`);

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
      return `<section class="cfg-group" data-tone="${g.tone}"><h3>${g.title} <span>${rs.length}</span></h3><ul>${rs.map(item).join('')}</ul></section>`;
    }).join('');
    const passed = report.results.filter(r => r.passed);
    const ok = passed.length
      ? `<section class="cfg-group" data-tone="ok"><details><summary><h3>Regras que passaram <span>${passed.length}</span></h3></summary><ul>${passed.map(item).join('')}</ul></details></section>` : '';
    return `${groups}${ok}`;
  }

  function paintPanel() {
    if (layer.hidden) return;
    const s = report?.summary;
    const head = report
      ? `<p class="cfg-head" data-valid="${report.exitCode === 0}">${report.exitCode === 0 ? '✅' : '❌'} ${esc(report.message)}</p>
         <p class="cfg-meta">${s.errors} erro(s) · ${s.warnings} aviso(s) · ${s.info} info · contrato v${esc(report.contractVersion)} · ${esc(when(report.generatedAt))}${err ? ` · <span class="cfg-stale">última atualização falhou: ${esc(err)}</span>` : ''}</p>` : '';
    layer.innerHTML = `<div class="ov-backdrop" data-close></div>
      <div class="help cfg-panel" role="dialog" aria-modal="true" aria-labelledby="cfgTitle">
        <header><h2 id="cfgTitle">🔧 Saúde do Sistema</h2>
          <div class="cfg-actions"><button type="button" class="ghost-btn cfg-reload"${loading ? ' disabled' : ''}>${loading ? 'Validando…' : 'Revalidar'}</button>
          <button type="button" class="icon-btn cfg-close" data-close aria-label="Fechar" title="Fechar">✕</button></div></header>
        <div class="cfg-body">${head}${body()}</div>
        <footer class="cfg-foot">Worktrees de ciclo encerrado ou órfãos: <code>node scripts/validate-config.js --fix</code></footer>
      </div>`;
  }

  function paintAlert() {
    const alert = $('cfgAlert');
    const bad = report && report.exitCode !== 0;
    alert.hidden = !bad;
    if (bad) alert.title = `${report.message} — abrir Saúde do Sistema`;
    $('cfgHealthBtn').dataset.state = !report ? '' : bad ? 'err' : report.summary.warnings ? 'warn' : 'ok';
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

  const style = document.createElement('style');
  style.textContent = `
    .cfg-alert { border: 1px solid var(--stop); background: var(--stop-bg); color: var(--stop); font: inherit; font-size: 13px; font-weight: 600;
      padding: 5px 10px; border-radius: 8px; cursor: pointer; white-space: nowrap; }
    .cfg-alert[hidden] { display: none; }
    #cfgHealthBtn { position: relative; font-size: 14px; }
    #cfgHealthBtn[data-state]:not([data-state=""])::after { content: ""; position: absolute; top: 3px; right: 3px; width: 7px; height: 7px; border-radius: 50%; }
    #cfgHealthBtn[data-state="err"]::after { background: var(--stop); }
    #cfgHealthBtn[data-state="warn"]::after { background: var(--attention); }
    #cfgHealthBtn[data-state="ok"]::after { background: var(--clear); }
    .cfg-panel { width: min(780px, 100%); max-height: 80vh; display: flex; flex-direction: column; }
    .cfg-actions { display: flex; gap: 8px; align-items: center; }
    .cfg-body { overflow: auto; padding: 14px 18px 18px; }
    .cfg-head { margin: 0; font-weight: 600; color: var(--ink); }
    .cfg-meta { margin: 4px 0 12px; font-size: 12.5px; color: var(--muted); }
    .cfg-stale { color: var(--attention); }
    .cfg-empty { color: var(--muted); margin: 8px 0; }
    .cfg-group { margin-top: 12px; border: 1px solid var(--line-soft); border-left-width: 4px; border-radius: 10px; overflow: hidden; }
    .cfg-group h3 { margin: 0; padding: 8px 12px; font-size: 13.5px; display: inline-flex; gap: 8px; align-items: center; }
    .cfg-group h3 span { font-weight: 500; color: var(--muted); }
    .cfg-group > ul, .cfg-group details > ul { list-style: none; margin: 0; padding: 0; }
    .cfg-group summary { cursor: pointer; }
    .cfg-group[data-tone="err"] { border-left-color: var(--stop); } .cfg-group[data-tone="err"] h3 { color: var(--stop); }
    .cfg-group[data-tone="err"] > h3 { background: var(--stop-bg); display: flex; }
    .cfg-group[data-tone="warn"] { border-left-color: var(--attention); } .cfg-group[data-tone="warn"] h3 { color: var(--attention); }
    .cfg-group[data-tone="warn"] > h3 { background: var(--attention-bg); display: flex; }
    .cfg-group[data-tone="info"] { border-left-color: var(--idle); } .cfg-group[data-tone="info"] h3 { color: var(--muted); }
    .cfg-group[data-tone="info"] > h3 { background: var(--sunken); display: flex; }
    .cfg-group[data-tone="ok"] { border-left-color: var(--clear); } .cfg-group[data-tone="ok"] h3 { color: var(--clear); }
    .cfg-group[data-tone="ok"] summary { padding-left: 12px; }
    .cfg-item { display: grid; grid-template-columns: minmax(0, 170px) minmax(0, 1fr); gap: 10px; padding: 9px 12px; border-top: 1px solid var(--line-soft); font-size: 13.5px; }
    .cfg-rule { font-family: var(--mono); font-size: 12px; color: var(--ink-2); overflow-wrap: anywhere; }
    .cfg-msg { color: var(--ink); min-width: 0; }
    .cfg-msg details { margin-top: 4px; color: var(--muted); font-size: 12.5px; }
    .cfg-msg ul { margin: 4px 0 0; padding-left: 18px; }
    .cfg-msg li { font-family: var(--mono); font-size: 12px; overflow-wrap: anywhere; }
    .cfg-foot { padding: 9px 18px; border-top: 1px solid var(--line-soft); font-size: 12.5px; color: var(--muted); }
    .cfg-foot code { font-family: var(--mono); }
    @media (max-width: 640px) { .cfg-item { grid-template-columns: minmax(0, 1fr); gap: 4px; } }
  `;
  document.head.appendChild(style);
})();
