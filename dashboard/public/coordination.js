// Data is always rendered as text/DOM; restricted fronts have only two columns.
(() => {
  let data, error, loading = false, reload = false;
  const states = ['Em andamento', 'Na fila', 'Aguardando você', 'Concluído', 'Bloqueado'];
  const el = (tag, text, className) => {
    const node = document.createElement(tag);
    if (text != null) node.textContent = text;
    if (className) node.className = className;
    return node;
  };
  async function load() {
    if (loading) { reload = true; return; }
    loading = true;
    try { data = await api('/api/coordination'); error = null; }
    catch { data = null; error = 'Não foi possível carregar a coordenação. Confira a conexão com o dashboard.'; }
    finally {
      loading = false;
      window.Views?.refresh();
      if (reload) { reload = false; load(); }
    }
  }
  function render() {
    if (!data && !error && !loading) load();
    const root = el('section', null, 'coordination');
    const head = el('div', null, 'vhead');
    head.append(el('h2', 'Coordenação'), el('p', 'Frentes e tarefas acompanhadas pelo Coordenador. Somente leitura.'));
    const button = el('button', loading ? 'Carregando…' : 'Atualizar', 'ghost-btn');
    button.type = 'button'; button.disabled = loading; button.addEventListener('click', load);
    head.append(button); root.append(head);
    if (error || !data) { root.append(el('p', error || 'Carregando…', 'vempty')); return root; }
    if (data.updatedAt) root.append(el('p', `Atualizado em ${new Date(data.updatedAt).toLocaleString('pt-BR')}`, 'muted'));
    const counts = el('div', null, 'coord-counts');
    for (const state of states) counts.append(el('span', `${state}: ${data.counts[state] ?? 'sem medição'}`, 'coord-count'));
    root.append(counts);
    const capacity = el('section', null, 'coord-capacity');
    capacity.append(el('h3', 'Capacidade das assinaturas'));
    if (data.capacity.status !== 'ok') capacity.append(el('p', 'Capacidade indisponível.'));
    else for (const runtime of data.capacity.runtimes) {
      const row = el('div', null, 'coord-runtime');
      row.append(el('h4', runtime.runtime));
      for (const [key, label] of [['five_hour', '5h'], ['seven_day', '7d']]) {
        const used = runtime[key]?.used;
        const line = el('label', `${label}: ${used == null ? 'sem medição' : `${used}% usado`}`, 'coord-window');
        if (used != null) { const bar = el('progress'); bar.max = 100; bar.value = used; bar.setAttribute('aria-label', `${runtime.runtime} ${label}: ${used}% usado`); line.append(bar); }
        row.append(line);
      }
      capacity.append(row);
    }
    root.append(capacity);
    if (data.status !== 'ok') { root.append(el('p', data.status === 'empty' ? 'Nenhum status de coordenação publicado. O Coordenador precisa publicar o arquivo configurado.' : data.message, 'vempty')); return root; }
    if (!data.frentes.length) root.append(el('p', 'Nenhuma frente publicada.', 'vempty'));
    for (const front of data.frentes) {
      const section = el('section', null, 'coord-front');
      section.append(el('h3', front.nome));
      const wrap = el('div', null, 'table-wrap');
      const table = el('table', null, 'coord-table');
      table.append(el('caption', front.nome));
      const header = el('tr');
      for (const label of front.restricted ? ['Tarefa', 'Estado'] : ['Tarefa', 'Agente / runtime', 'Estado', 'Nota / próximo passo', 'Link']) {
        const th = el('th', label); th.scope = 'col'; header.append(th);
      }
      const thead = el('thead'); thead.append(header); table.append(thead);
      const body = el('tbody');
      for (const task of data.tarefas.filter(t => t.frente === front.id)) {
        const tr = el('tr'); tr.append(el('td', task.tarefa));
        if (!front.restricted) tr.append(el('td', `${task.agente} / ${task.runtime}`));
        const state = el('td'); state.append(el('span', task.estado, `coord-chip coord-state-${states.indexOf(task.estado)}`)); tr.append(state);
        if (!front.restricted) {
          tr.append(el('td', task.nota));
          const linkCell = el('td');
          if (task.link) {
            try {
              const url = new URL(task.link);
              if (['https:', 'http:'].includes(url.protocol)) { const a = el('a', 'Abrir'); a.href = url.href; a.target = '_blank'; a.rel = 'noopener noreferrer'; linkCell.append(a); }
            } catch { /* ignore unsafe/malformed link */ }
          }
          tr.append(linkCell);
        }
        body.append(tr);
      }
      if (!body.children.length) { const tr = el('tr'); const td = el('td', 'Nenhuma tarefa nesta frente.'); td.colSpan = front.restricted ? 2 : 5; tr.append(td); body.append(tr); }
      table.append(body); wrap.append(table); section.append(wrap); root.append(section);
    }
    return root;
  }
  const style = el('style');
  style.textContent = `
    .coord-counts { display:flex; flex-wrap:wrap; gap:8px 20px; margin:16px 0; }
    .coord-count { color:var(--ink-2); }
    .coord-capacity { border-block:1px solid var(--line); padding:12px 0; margin:20px 0; }
    .coord-runtime { display:inline-grid; gap:8px; min-width:240px; margin:0 24px 16px 0; }
    .coord-runtime h4 { margin:0; }
    .coord-window { display:grid; gap:4px; color:var(--muted); }
    .coord-window progress { width:100%; accent-color:var(--signal); }
    .coord-table { width:100%; border-collapse:collapse; font-size:13.5px; }
    .coord-table th,.coord-table td { text-align:left; padding:10px 12px; border-bottom:1px solid var(--line-soft); vertical-align:top; overflow-wrap:anywhere; }
    .coord-table th { color:var(--muted); }
    .coord-table caption { position:absolute; width:1px; height:1px; overflow:hidden; clip-path:inset(50%); }
    .coord-chip { display:inline-block; white-space:nowrap; padding:3px 8px; border-radius:5px; background:var(--sunken); }
    .coord-state-0 { color:var(--signal); background:var(--signal-soft); }
    .coord-state-2 { color:var(--attention); background:var(--attention-bg); }
    .coord-state-3 { color:var(--clear); background:var(--clear-bg); }
    .coord-state-4 { color:var(--stop); background:var(--stop-bg); }
    .coordination button:focus-visible,.coordination a:focus-visible { outline:2px solid var(--signal); outline-offset:3px; }
  `;
  document.head.append(style);
  window.CoordinationView = { render, load };
  window.Views?.refresh();
})();
