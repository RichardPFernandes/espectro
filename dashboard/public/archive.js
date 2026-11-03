// Arquivar runs de verdade (move a pasta pra memory/runs/_archive/, como o /commit
// faz) e restaurar. Botão no painel do run, na barra da seleção múltipla, e grupo
// "Arquivados" no fim da lista. Diferente de "Remover da lista" (só esconde neste
// navegador). O grupo também lista a rotação automática (scripts/cleanup-runs.js →
// memory/archive/<YYYY-MM>/), só leitura, por mês: fechado ele só pede a contagem
// (?summary=1); a lista de runs vem ao expandir. Script clássico carregado por último;
// usa os globais do script principal.
(() => {
  let archived = [];
  let rotated = { months: [], total: 0, full: false };
  let groupOpen = false;
  const monthsOpen = new Set();
  const ACTIVE = new Set(['active', 'failed', 'unknown']);
  const isActive = r => ACTIVE.has(r?.kind || 'unknown');
  const num = r => titleOf(r).num || r.taskId;

  async function loadArchived() {
    const full = groupOpen;
    try {
      const body = await api(full ? '/api/archive' : '/api/archive?summary=1');
      archived = (body.dashboard || []).filter(a => a.exists);
      rotated = { months: body.months || [], total: body.total || 0, full };
      if (full && !monthsOpen.size && rotated.months[0]) monthsOpen.add(rotated.months[0].month);
    } catch { archived = []; rotated = { months: [], total: 0, full: false }; }
    paintGroup();
  }

  // ------------------------------------------------------------------ confirmação
  function confirmArchive(ids) {
    const list = ids.map(id => runs.get(id)).filter(Boolean);
    const active = list.filter(isActive);
    const many = list.length > 1;
    return new Promise(resolve => {
      const dlg = document.createElement('div');
      dlg.className = 'overlay arch-overlay';
      dlg.innerHTML = `<div class="ov-backdrop" data-no></div>
        <div class="arch-dialog" role="alertdialog" aria-modal="true" aria-labelledby="archTitle" aria-describedby="archBody">
          <h2 id="archTitle">Arquivar ${many ? `${list.length} runs` : esc(num(list[0]))}?</h2>
          <div id="archBody">
            <p>${many ? 'A pasta de cada run vai' : 'A pasta do run vai'} para <code>memory/runs/_archive/</code>, o mesmo que o <code>/commit</code> faz ao concluir, e sai do dashboard. Dá para restaurar depois em <b>Arquivados</b>, no fim da lista.</p>
            ${active.length ? `<div class="arch-warn"><b>${active.length === 1 ? `${esc(num(active[0]))} ainda está ativo.` : `${active.length} ainda estão ativos: ${active.map(r => esc(num(r))).join(', ')}.`}</b>
              O watcher deixa de acompanhar ${active.length === 1 ? 'esse run' : 'esses runs'}. Se o ticket voltar para Aprovada ou Recusa QA, ele começa um ciclo novo. Se um agente estiver rodando agora, ele pode recriar a pasta, e aí o run reaparece.</div>` : ''}
            <p class="arch-git">Fica uma mudança pendente no git do checkout onde o run está (arquivos movidos em <code>memory/runs</code>).</p>
            ${many ? `<ul class="arch-list">${list.map(r => `<li>${stateGlyph(r.status)}${esc(num(r))} <span>${esc(titleOf(r).text)}</span></li>`).join('')}</ul>` : ''}
          </div>
          <div class="arch-actions">
            <button type="button" class="ghost-btn" data-no>Cancelar</button>
            <button type="button" class="arch-go" data-yes>${active.length ? 'Arquivar mesmo assim' : 'Arquivar'}</button>
          </div>
        </div>`;
      const done = ok => { dlg.remove(); document.removeEventListener('keydown', onKey, true); resolve(ok); };
      const onKey = e => { if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); done(false); } };
      dlg.addEventListener('click', e => { if (e.target.closest('[data-yes]')) done(true); else if (e.target.closest('[data-no]')) done(false); });
      document.addEventListener('keydown', onKey, true);
      document.body.appendChild(dlg);
      dlg.querySelector('[data-no].ghost-btn').focus();
    });
  }

  // ------------------------------------------------------------------ ações
  async function archive(ids) {
    ids = ids.filter(id => runs.has(id));
    if (!ids.length || !(await confirmArchive(ids))) return;
    const ok = [], failed = [];
    for (const id of ids) {
      try {
        await api(`/api/runs/${encodeURIComponent(id)}/archive`, {
          // CAS (scripts/cas.js): versão/nó/execution_id que a tela carregou.
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(StateVersion.casBody(runs.get(id), { force: true })),
        });
        ok.push(id);
      } catch (e) { failed.push(`${id}: ${e.message}`); }
    }
    if (ok.includes(selected)) {
      selected = null; prefs.selected = null; persist();
      window.UX?.route(null);
    }
    if (typeof selecting !== 'undefined' && selecting) setSelecting(false);
    await refreshRuns();
    renderDetail();
    await loadArchived();
    if (failed.length) toast(`Não deu para arquivar ${failed.length}: ${failed[0]}`);
    else toast(`${ok.length === 1 ? `${ok[0]} arquivado` : `${ok.length} runs arquivados`}.`, { label: 'Desfazer', run: () => restore(ok) });
  }

  async function restore(ids) {
    const ok = [], failed = [];
    for (const id of ids) {
      try { await api(`/api/archive/${encodeURIComponent(id)}/restore`, { method: 'POST' }); ok.push(id); }
      catch (e) { failed.push(`${id}: ${e.message}`); }
    }
    await refreshRuns();
    await loadArchived();
    toast(failed.length ? `Não deu para restaurar ${failed.length}: ${failed[0]}` : `${ok.length === 1 ? ok[0] : `${ok.length} runs`} de volta à lista.`);
  }

  // ------------------------------------------------------------------ UI injetada
  // As telas são re-renderizadas pelo script principal a cada evento; um observer
  // recoloca os botões sempre que o lugar deles reaparece.
  function injectHero() {
    const top = document.querySelector('#detail .hero-top');
    if (!top || top.querySelector('.arch-btn') || !selected) return;
    const r = runs.get(selected);
    if (!r || r.pretask) return; // ticket sem task: não há pasta de run pra arquivar
    if (r.archived) {
      if (document.querySelector('#detail .arch-note')) return;
      const d = r.demand || {};
      top.insertAdjacentHTML('afterend', `<div class="arch-note" role="note"><b>Arquivado pelo /commit, demanda ainda aberta.</b>
        O ciclo do agente terminou, mas o ticket está “${esc(d.status || 'aberto')}” no Redmine${d.assigned_to ? `, com ${esc(d.assigned_to)}` : ''}.
        Ele sai daqui sozinho quando o ticket fechar. Só leitura: o watcher não lê mensagens de runs arquivados.</div>`);
      top.querySelector('.arch-btn')?.remove();
      return;
    }
    top.insertAdjacentHTML('beforeend', `<button type="button" class="arch-btn" data-arch-one title="Mover para memory/runs/_archive/ e tirar do dashboard">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true"><rect x="3" y="4" width="18" height="5" rx="1.5" stroke="currentColor" stroke-width="2"/><path d="M5 9v9a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V9M10 13h4" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
      Arquivar</button>`);
  }
  function injectActionBar() {
    const bar = document.querySelector('#sidebar .action-bar');
    if (!bar || bar.classList.contains('compare-bar') || bar.querySelector('[data-arch-many]')) return;
    const ids = [...picked].filter(id => runs.has(id) && !isHidden(runs.get(id)));
    if (!ids.length) return;
    const hideBtn = bar.querySelector('[data-act="hide"]');
    if (hideBtn) hideBtn.textContent = `Só ocultar aqui (${ids.length})`;
    const btn = `<button type="button" class="arch-many" data-arch-many>Arquivar (${ids.length})</button>`;
    hideBtn ? hideBtn.insertAdjacentHTML('beforebegin', btn) : bar.querySelector('.what')?.insertAdjacentHTML('afterend', btn);
    const fine = bar.querySelector('.fine');
    if (fine) fine.textContent = 'Arquivar move as pastas para memory/runs/_archive/. Só ocultar esconde neste navegador.';
  }
  const MONTH_NAMES = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
  const monthLabel = m => `${MONTH_NAMES[Number(m.slice(5, 7)) - 1] || m.slice(5, 7)} ${m.slice(0, 4)}`;
  const archTitle = a => {
    const n = a.ticket?.id ? `#${a.ticket.id}` : a.taskId.replace(/^(\d{4,6})-.*/, '#$1');
    return a.ticket?.subject ? `${n} ${a.ticket.subject}` : a.taskId;
  };
  function monthBlock(m) {
    const open = monthsOpen.has(m.month);
    const rows = open && rotated.full ? (m.runs || []).map(r => `<div class="arch-row arch-row-ro" title="${esc(r.path)}">
        ${stateGlyph(r.status || 'unknown', r.status || 'sem status')}<div class="arch-row-main"><span class="arch-row-title">${esc(archTitle(r))}</span>
        <span class="arch-row-sub"${r.updatedAt ? ` title="${esc(when(r.updatedAt))}"` : ''}>${esc(r.status || 'sem status')}${r.updatedAt ? ` · ${esc(ago(r.updatedAt))}` : ''}${r.copies > 1 ? ` · ${r.copies} cópias` : ''}</span></div></div>`).join('') : '';
    return `<button class="group-head arch-month" type="button" data-arch-month="${esc(m.month)}" aria-expanded="${open}">
        ${ICON.chevLeft}${esc(monthLabel(m.month))} <span class="count">${m.count}</span></button>${rows}`;
  }
  function paintGroup() {
    const side = $('sidebar');
    let el = $('archivedGroup');
    const total = archived.length + rotated.total;
    if (!total) { el?.remove(); return; }
    const html = `<button class="group-head" type="button" data-arch-toggle aria-expanded="${groupOpen}">
        ${ICON.chevLeft}Arquivados <span class="count">${total}</span></button>
      ${groupOpen ? archived.map(a => `<div class="arch-row"><div class="arch-row-main"><span class="arch-row-title">${esc(archTitle(a))}</span>
          <span class="arch-row-sub" title="${esc(when(a.archived_at))}">arquivado ${esc(ago(a.archived_at))}</span></div>
          <button type="button" class="ghost-btn" data-arch-restore="${esc(a.taskId)}">Restaurar</button></div>`).join('')
        + (!rotated.total ? '' : !rotated.full ? '<div class="arch-row arch-loading">Carregando…</div>'
          : `<div class="arch-rotated-note">Rotação automática (memory/archive/), só leitura</div>${rotated.months.map(monthBlock).join('')}`) : ''}`;
    if (!el) { el = document.createElement('div'); el.id = 'archivedGroup'; }
    if (el.innerHTML !== html) el.innerHTML = html;
    const bar = side.querySelector('.action-bar');
    if (el.parentNode !== side || (bar ? el.nextSibling !== bar : el !== side.lastElementChild)) {
      bar ? side.insertBefore(el, bar) : side.appendChild(el);
    }
  }

  const obs = new MutationObserver(() => { injectHero(); injectActionBar(); paintGroup(); });
  obs.observe($('detail'), { childList: true, subtree: true });
  obs.observe($('sidebar'), { childList: true });

  document.addEventListener('click', e => {
    if (e.target.closest('[data-arch-one]')) { archive([selected]); return; }
    if (e.target.closest('[data-arch-many]')) { archive([...picked]); return; }
    const rb = e.target.closest('[data-arch-restore]');
    if (rb) { rb.disabled = true; restore([rb.dataset.archRestore]); return; }
    if (e.target.closest('[data-arch-toggle]')) { groupOpen = !groupOpen; paintGroup(); if (groupOpen) loadArchived(); return; }
    const mb = e.target.closest('[data-arch-month]');
    if (mb) { const m = mb.dataset.archMonth; monthsOpen.has(m) ? monthsOpen.delete(m) : monthsOpen.add(m); paintGroup(); }
  });

  const style = document.createElement('style');
  style.textContent = `
    .arch-btn { margin-left: 8px; flex-shrink: 0; display: inline-flex; align-items: center; gap: 6px; min-height: 34px; padding: 0 12px; border: 1px solid var(--border-control); background: transparent; border-radius: var(--radius-control); font-size: 13px; font-weight: 500; color: var(--text); cursor: pointer; }
    .arch-btn:hover { border-color: var(--state-failed); color: var(--state-failed-fg); background: var(--state-failed-bg); }
    .arch-note { margin-top: 16px; padding: 12px 16px; border-radius: var(--radius-control); border: 1px solid color-mix(in srgb, var(--accent) 40%, transparent); background: var(--state-running-bg); color: var(--text-secondary); font-size: 14px; line-height: 20px; }
    .arch-note b { color: var(--state-running-fg); margin-right: 4px; }
    .action-bar .arch-many { background: var(--ground) !important; border-color: var(--state-failed) !important; color: var(--state-failed-fg) !important; }
    .action-bar [data-act="hide"] { background: var(--ground) !important; border-color: var(--border-control) !important; color: var(--text) !important; }
    .arch-overlay { display: grid; }
    .arch-dialog { position: relative; width: min(520px, 100%); background: var(--surface); border: 1px solid var(--border-control); border-radius: var(--radius-panel); box-shadow: var(--shadow-pop); padding: 20px 24px; display: grid; gap: 12px; }
    .arch-dialog h2 { margin: 0; font-size: 20px; line-height: 28px; font-weight: 600; }
    .arch-dialog p { margin: 0 0 8px; font-size: 14px; color: var(--text-secondary); line-height: 20px; }
    .arch-dialog code { font: 12px var(--mono); background: var(--ground); padding: 1px 4px; border-radius: var(--radius-tag); }
    .arch-warn { background: var(--state-waiting-bg); border: 1px solid color-mix(in srgb, var(--state-waiting) 45%, transparent); border-radius: var(--radius-control); padding: 10px 12px; font-size: 14px; color: var(--text); line-height: 20px; margin-bottom: 8px; }
    .arch-warn b { display: block; color: var(--state-waiting-fg); margin-bottom: 2px; }
    .arch-git { font-size: 13px !important; color: var(--muted) !important; }
    .arch-list { list-style: none; margin: 0; padding: 0; max-height: 180px; overflow: auto; border: 1px solid var(--border); border-radius: var(--radius-control); }
    .arch-list li { display: flex; align-items: center; gap: 8px; padding: 6px 10px; font-family: var(--mono); font-size: 12px; font-weight: 500; }
    .arch-list li + li { border-top: 1px solid var(--border); }
    .arch-list li span:last-child { font-family: var(--sans); font-size: 13px; font-weight: 400; color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .arch-actions { display: flex; justify-content: flex-end; gap: 8px; }
    .arch-go { min-height: 40px; padding: 0 16px; border: 1px solid var(--state-failed); border-radius: var(--radius-control); background: var(--state-failed-bg); color: var(--state-failed-fg); font-weight: 600; font-size: 13px; cursor: pointer; }
    .arch-go:hover { filter: brightness(1.12); }
    #archivedGroup .group-head { color: var(--muted); }
    .arch-row { display: flex; align-items: center; gap: 10px; min-height: 44px; padding: 6px 16px 6px 40px; }
    .arch-row-main { display: grid; min-width: 0; flex: 1; }
    .arch-row-title { font-size: 13px; color: var(--text-secondary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .arch-row-sub { font-family: var(--mono); font-size: 11px; color: var(--muted); }
    .arch-row .ghost-btn { min-height: 30px; padding: 0 10px; font-size: 12px; }
    #archivedGroup .arch-month { padding-left: 32px; }
    .arch-row-ro { padding-left: 48px; align-items: flex-start; }
    .arch-rotated-note, .arch-loading { padding: 8px 16px 2px 40px; font-size: 12px; color: var(--muted); }
  `;
  document.head.appendChild(style);

  window.Archive = { archive, restore, loadArchived };
  loadArchived();
  injectHero();
})();
