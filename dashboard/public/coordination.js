// Data is always rendered as text/DOM; restricted fronts have only two columns.
// Visual: design Espectro ("Frota em execução" + medidores de janela). Estilos em screens/coordination.css.
(() => {
  let data, error, loading = false, reload = false;
  const states = ['Em andamento', 'Na fila', 'Aguardando você', 'Concluído', 'Bloqueado'];
  // Estado sempre com glifo + cor (classe .pill/.dot do tema), nunca só o matiz.
  const STATE_LOOK = {
    'Em andamento': ['running', '◐'], 'Na fila': ['queued', '○'], 'Aguardando você': ['waiting', '‖'],
    'Concluído': ['done', '✓'], 'Bloqueado': ['failed', '✕'],
  };
  // Limiar visual de aviso das janelas 5h/7d (referência do design; não altera dado nem contrato).
  const WARN = 85;
  const el = (tag, text, className) => {
    const node = document.createElement(tag);
    if (text != null) node.textContent = text;
    if (className) node.className = className;
    return node;
  };
  const glyph = (state) => {
    const [tone, mark] = STATE_LOOK[state] || ['queued', '?'];
    const g = el('span', mark, `coord-glyph ${tone}`); g.setAttribute('aria-hidden', 'true');
    return g;
  };
  const pill = (state) => {
    const [tone] = STATE_LOOK[state] || ['queued'];
    const p = el('span', null, `pill ${tone} coord-chip coord-state-${states.indexOf(state)}`);
    p.append(glyph(state), el('span', state));
    return p;
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
  function capacityMeter(runtime, key, label) {
    const used = runtime[key]?.used;
    const line = el('div', null, 'coord-window');
    const top = el('div', null, 'coord-window-top');
    top.append(el('span', `Janela ${label}`, 'label'));
    const tone = used == null ? 'na' : used >= 100 ? 'over' : used >= WARN ? 'warn' : 'ok';
    const value = el('span', null, `coord-window-value ${tone}`);
    if (tone === 'warn' || tone === 'over') {
      const g = el('span', tone === 'over' ? '✕' : '‖', 'coord-window-glyph'); g.setAttribute('aria-hidden', 'true');
      value.append(g);
    }
    value.append(el('span', used == null ? 'sem medição' : `${used}% usado`));
    top.append(value); line.append(top);
    const track = el('span', null, `meter coord-meter ${tone}`);
    if (used == null) {
      // Sem medição: trilho tracejado e vazio, nunca uma barra em 0%.
      track.setAttribute('aria-hidden', 'true');
    } else {
      track.setAttribute('role', 'img');
      track.setAttribute('aria-label', `${runtime.runtime} ${label}: ${used}% usado${tone === 'ok' ? '' : tone === 'warn' ? `, acima do aviso de ${WARN}%` : ', no limite'}`);
      track.setAttribute('title', `${used}% usado · aviso em ${WARN}%`);
      const fill = el('i'); fill.setAttribute('style', `width:${Math.max(0, Math.min(100, used))}%`);
      const mark = el('span', null, 'coord-meter-warn'); mark.setAttribute('aria-hidden', 'true'); mark.setAttribute('style', `left:calc(${WARN}% - 1px)`);
      track.append(fill, mark);
    }
    line.append(track);
    return line;
  }
  function render() {
    if (!data && !error && !loading) load();
    const root = el('section', null, 'coordination');
    const head = el('div', null, 'vhead coord-head');
    const title = el('div', null, 'coord-title');
    title.append(el('p', 'Operação · somente leitura', 'label'), el('h2', 'Coordenação', 't-title'), el('p', 'Frentes e tarefas acompanhadas pelo Coordenador. Somente leitura.'));
    const actions = el('div', null, 'coord-actions');
    if (data?.updatedAt) actions.append(el('p', `Atualizado em ${new Date(data.updatedAt).toLocaleString('pt-BR')}`, 'muted source-note coord-updated'));
    const button = el('button', loading ? 'Carregando…' : 'Atualizar', 'btn lg');
    button.type = 'button'; button.disabled = loading; button.addEventListener('click', load);
    actions.append(button); head.append(title, actions); root.append(head);
    if (error || !data) { root.append(el('p', error || 'Carregando…', 'vempty coord-empty')); return root; }

    const summary = el('section', null, 'coord-summary');
    summary.setAttribute('aria-label', 'Tarefas por estado');
    const counts = el('div', null, 'kpis coord-counts');
    for (const state of states) {
      const value = data.counts?.[state];
      const kpi = el('div', null, 'kpi coord-count');
      const name = el('span', null, 'kpi-label coord-count-label');
      name.append(glyph(state), el('span', state));
      kpi.append(name, el('span', value == null ? 'sem medição' : String(value), value == null ? 'kpi-value coord-na' : 'kpi-value mono coord-count-value'));
      counts.append(kpi);
    }
    summary.append(counts, el('p', 'Fonte: status publicado pelo Coordenador. Sem fonte válida, a contagem fica sem medição, nunca zero.', 'source-note'));
    root.append(summary);

    const capacity = el('section', null, 'panel coord-capacity');
    const capHead = el('div', null, 'panel-head coord-panel-head');
    capHead.append(el('h3', 'Capacidade das assinaturas', 't-heading'));
    capacity.append(capHead);
    if (data.capacity?.status !== 'ok') capacity.append(el('p', 'Capacidade indisponível.', 'coord-unavailable'));
    else {
      const grid = el('div', null, 'coord-runtimes');
      for (const runtime of data.capacity.runtimes) {
        const row = el('div', null, 'coord-runtime');
        row.append(el('h4', runtime.runtime, 'mono coord-runtime-name'));
        for (const [key, label] of [['five_hour', '5h'], ['seven_day', '7d']]) row.append(capacityMeter(runtime, key, label));
        grid.append(row);
      }
      capacity.append(grid);
    }
    capacity.append(el('p', `Fonte: script de capacidade (percentuais 5h/7d por runtime). O traço âmbar marca o aviso em ${WARN}%. Sem medição não é 0%.`, 'source-note coord-cap-note'));
    root.append(capacity);

    if (data.status !== 'ok') { root.append(el('p', data.status === 'empty' ? 'Nenhum status de coordenação publicado. O Coordenador precisa publicar o arquivo configurado.' : data.message, 'vempty coord-empty')); return root; }
    if (!data.frentes.length) root.append(el('p', 'Nenhuma frente publicada.', 'vempty coord-empty'));
    for (const front of data.frentes) {
      const tasks = data.tarefas.filter(t => t.frente === front.id);
      const section = el('section', null, 'panel coord-front');
      const fhead = el('div', null, 'panel-head coord-panel-head');
      fhead.append(el('h3', front.nome, 't-heading'), el('span', `${tasks.length} ${tasks.length === 1 ? 'tarefa' : 'tarefas'}`, 'tag'));
      if (front.restricted) fhead.append(el('span', 'restrita · só tarefa e estado', 'tag coord-restricted'));
      section.append(fhead);
      const wrap = el('div', null, 'table-wrap coord-table-wrap');
      const table = el('table', null, 'dtable coord-table');
      table.append(el('caption', front.nome));
      const header = el('tr');
      for (const label of front.restricted ? ['Tarefa', 'Estado'] : ['Tarefa', 'Agente / runtime', 'Estado', 'Nota / próximo passo', 'Link']) {
        const th = el('th', label); th.scope = 'col'; header.append(th);
      }
      const thead = el('thead'); thead.append(header); table.append(thead);
      const body = el('tbody');
      for (const task of tasks) {
        const tr = el('tr'); tr.append(el('td', task.tarefa, 'coord-task'));
        if (!front.restricted) {
          const who = el('td', null, 'coord-agent');
          who.append(el('span', task.agente), el('span', ' / ', 'coord-sep'), el('span', task.runtime, 'mono coord-runtime-tag'));
          tr.append(who);
        }
        const state = el('td', null, 'coord-state'); state.append(pill(task.estado)); tr.append(state);
        if (!front.restricted) {
          tr.append(el('td', task.nota, 'coord-note'));
          const linkCell = el('td', null, 'coord-link');
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
      if (!body.children.length) { const tr = el('tr'); const td = el('td', 'Nenhuma tarefa nesta frente.', 'coord-none'); td.colSpan = front.restricted ? 2 : 5; tr.append(td); body.append(tr); }
      table.append(body); wrap.append(table); section.append(wrap); root.append(section);
    }
    return root;
  }
  window.CoordinationView = { render, load };
  window.Views?.refresh();
})();
