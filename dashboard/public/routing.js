// View "Roteamento" (artboard ModelRouting do design Espectro, PRI-328; antes PRI-205 T5–T7b).
// Lista de nós à esquerda (sombra S3 × decisão real, agregada por nó) e detalhe à direita com
// "Hoje contra a sombra", divergências, mistura de modelos e a policy vigente. O classificador
// é a última linha da lista; o detalhe dele usa o writer existente (POST /api/routing/classifier).
// Fontes: GET /api/routing, GET/POST /api/routing/classifier, GET /api/would-route-metrics
// (só o diagnóstico da sombra, para o aviso). Só projeta: nunca calcula classe, resolve modelo
// ou estima custo; ausência de dado aparece como "sem comparação"/"sem preço", nunca 0 ou OFF.
// Lógica pura em routing-model.js; estilos em screens/routing.css.
(() => {
  const M = window.RoutingModel;
  let data, error, loading = false, reload = false;
  // Estado da tela. sel: chave do nó, 'cls' (classificador) ou null (detalhe fechado);
  // undefined = ainda não escolhido (abre o primeiro da lista, como no artboard).
  const ui = { view: 'all', q: '', sel: undefined };

  const el = (tag, text, className) => {
    const node = document.createElement(tag);
    if (text != null) node.textContent = text;
    if (className) node.className = className;
    return node;
  };
  const txt = t => document.createTextNode(t);
  const attr = (node, map) => { for (const [k, v] of Object.entries(map)) node.setAttribute(k, v); return node; };
  const when = iso => {
    if (!iso || iso === 'UNKNOWN') return 'quando: desconhecido';
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? 'quando: desconhecido' : d.toLocaleString('pt-BR');
  };
  const clock = iso => {
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? 'desconhecido' : d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  };
  const nodeLabel = k => (typeof NODE_LABEL !== 'undefined' && NODE_LABEL[k]) || k;
  const refresh = () => window.Views?.refresh();
  const SRC_SHADOW = 'Fonte: /api/routing · shadow_vs_real (comparação de tier por Attempt)';

  async function load() {
    if (loading) { reload = true; return; }
    loading = true;
    refresh();
    try {
      data = await api('/api/routing');
      error = null;
    } catch (e) {
      data = null;
      error = e?.message || 'Não foi possível carregar o roteamento de modelo.';
    } finally {
      loading = false;
      refresh();
      if (reload) { reload = false; load(); }
    }
    window.WouldRouteMetricsView?.load();
    loadClassifier();
  }

  // ── classificador (contrato GET/POST /api/routing/classifier) ────────────────────
  // As opções e os motivos de recusa vêm de options[], e quem valida é o writer.
  // "Enviado" até a resposta; "aplicado" só depois do 200. Mesmo operation_id no reenvio
  // enquanto o pedido for o mesmo e o desfecho for incerto.
  const cls = { data: undefined, error: null, loading: false, missing: false, form: { option: null, reason: '' }, op: null, busy: false, msg: '', msgCls: '' };
  const CLS_OPTIONS = [
    ['policy_only', 'policy_only', null, 'Só policy', 'Só o núcleo 1 (as regras da policy). O Jev não é chamado.'],
    ['policy_jev:shadow', 'policy_jev', 'shadow', 'Policy + Jev (sombra)', 'O Jev opina e a opinião fica registrada, sem efeito no modelo escolhido.'],
    ['policy_jev:active', 'policy_jev', 'active', 'Policy + Jev (ativo)', 'A opinião do Jev pode mudar a classe. Só com calibração aprovada (D20).'],
  ];
  const CLS_HINT = { CLASSIFIER_VERSION_CONFLICT: 'a escolha mudou desde que a tela carregou; a tela foi atualizada' };
  const newOpId = () => (globalThis.crypto?.randomUUID?.() || `op-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`);
  const optionLabel = (choice, mode) => (CLS_OPTIONS.find(o => o[1] === choice && (o[2] === mode || (o[2] === null && choice === 'policy_only'))) || [])[3];

  async function loadClassifier() {
    if (cls.loading) return;
    cls.loading = true;
    try {
      const res = await fetch('/api/routing/classifier');
      cls.missing = res.status === 404;
      if (cls.missing) { cls.data = null; cls.error = null; }
      else if (!res.ok) throw new Error(`HTTP ${res.status}`);
      else { cls.data = await res.json(); cls.error = null; }
    } catch (e) { cls.error = e.message; cls.data = null; }
    cls.loading = false;
    refresh();
  }

  function optionState(d, key) {
    const [, choice, mode] = CLS_OPTIONS.find(o => o[0] === key);
    const opt = (d.options || []).find(o => o.choice === choice);
    if (!opt) return { allowed: false, refusal: null, detail: 'opção não oferecida pela API' };
    if (choice === 'policy_only') return { allowed: opt.allowed === true, refusal: opt.refusal || null, detail: opt.detail || null };
    const m = opt.modes?.[mode];
    if (!m) return { allowed: false, refusal: null, detail: 'modo não oferecido pela API' };
    return { allowed: m.allowed === true, refusal: m.refusal || null, detail: m.detail || null };
  }
  function isCurrent(d, key) {
    const c = d.current || {};
    if (c.source !== 'SELECTION') return false;
    const [, choice, mode] = CLS_OPTIONS.find(o => o[0] === key);
    return c.choice === choice && (choice === 'policy_only' || c.mode === mode);
  }
  function sendBlock(d) {
    const key = cls.form.option;
    if (cls.busy) return 'Enviado. Aguardando a resposta do writer…';
    if (!key) return 'Escolha uma opção.';
    if (!optionState(d, key).allowed) return 'Esta opção está recusada pela API agora (motivo na opção).';
    if (isCurrent(d, key)) return 'Esta opção já é a escolha atual.';
    if (!cls.form.reason.trim()) return 'Escreva o motivo da troca (vai para o histórico).';
    return '';
  }
  function clsCurrentLabel() {
    const c = cls.data?.current || {};
    if (c.source === 'INVALID') return 'registro ilegível';
    if (c.source === 'POLICY') return `definido pela policy (${c.provider || 'desconhecido'})`;
    return optionLabel(c.choice, c.mode) || `desconhecido (${c.choice || '?'}/${c.mode || '?'})`;
  }

  async function sendClassifier(d) {
    const key = cls.form.option;
    const [, choice, mode, label] = CLS_OPTIONS.find(o => o[0] === key);
    if (!confirm(`Trocar o classificador do projeto para "${label}"?\n\nVale só para Runs novas; Runs já admitidas não mudam. O writer confere autorização, calibração e versão antes de gravar.`)) return;
    const request = { choice, ...(mode ? { mode } : {}), expected_version: d.current && 'version' in d.current ? d.current.version : null, reason: cls.form.reason.trim() };
    const opKey = JSON.stringify(request);
    if (!cls.op || cls.op.key !== opKey) cls.op = { key: opKey, id: newOpId() };
    cls.busy = true; cls.msg = 'Enviado. Aguardando a resposta do writer…'; cls.msgCls = '';
    refresh();
    let res, out;
    try {
      res = await fetch('/api/routing/classifier', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...request, operation_id: cls.op.id }) });
      out = await res.json().catch(() => ({}));
    } catch (e) {
      cls.busy = false;
      cls.msgCls = 'err';
      cls.msg = `Resultado incerto (${e.message}): a troca pode ter sido gravada. Reenvie sem mudar nada; a mesma operação é reaproveitada e não grava duas vezes.`;
      refresh();
      return;
    }
    cls.busy = false;
    // Só desfecho CERTO encerra a operação: 2xx ou recusa do writer com código. 5xx é
    // incerto e mantém o mesmo operation_id para o reenvio (revisão do Checkpoint B, MAJOR-2).
    if (res.status >= 500) {
      cls.msgCls = 'err';
      cls.msg = `Resultado incerto (HTTP ${res.status}): a troca pode ter sido gravada. Reenvie sem mudar nada; a mesma operação é reaproveitada e não grava duas vezes.`;
      refresh();
      return;
    }
    if (res.ok || out.code) cls.op = null;
    if (res.ok && out.ok) {
      cls.msgCls = 'ok';
      cls.msg = out.status === 'already_processed'
        ? 'Esta troca já estava registrada (mesma operação): nada foi gravado de novo.'
        : `Aplicado: ${optionLabel(out.current?.choice, out.current?.mode) || label} (versão ${out.current?.version ?? '?'}). Vale para Runs novas.`;
      if (out.current && cls.data) cls.data = { ...cls.data, current: out.current };
      cls.form = { option: null, reason: '' };
    } else {
      const hint = CLS_HINT[out.code];
      cls.msgCls = 'err';
      cls.msg = `Recusado${out.code ? ` (${out.code})` : ` (HTTP ${res.status})`}: ${out.error || hint || 'sem detalhe'}${out.detail ? ` · ${out.detail}` : ''}${hint && out.error ? ` — ${hint}` : ''}`;
    }
    refresh();
    await loadClassifier();
  }

  // ── avisos (faixa no topo da lista) ──────────────────────────────────────────────
  const NOTICE = {
    SENT: 'aviso enviado ao Redmine',
    FAILED: 'aviso ao Redmine falhou',
    UNCERTAIN: 'aviso com resultado incerto (não será repetido às cegas)',
    PENDING: 'aviso ainda não enviado',
  };
  function banners() {
    const out = [];
    const add = (tone, glyph, text) => out.push({ tone, glyph, text });
    if (data.reader === 'FAILED') add('waiting', '‖', 'O leitor de roteamento não respondeu. Configuração e snapshots aparecem como desconhecidos até a próxima atualização; nada aqui significa roteamento desligado.');
    const cfg = data.config || {};
    if (cfg.mode === 'OFF') {
      add('queued', '○', cfg.source === 'absent'
        ? 'Roteamento desligado: o projeto está sem .claude/model-routing.json; todo despacho segue o modelo herdado da conta. A sombra continua só medindo.'
        : 'Roteamento desligado (mode OFF): todo despacho segue o modelo herdado da conta. A sombra continua só medindo.');
    } else if (cfg.mode === 'INVALID') {
      add('failed', '✕', `Configuração inválida (${cfg.invalid?.cause || 'UNKNOWN'}${cfg.invalid?.detail ? ` · ${cfg.invalid.detail}` : ''}): Runs novas não são admitidas até corrigir .claude/model-routing.json. Runs já admitidas mantêm o próprio snapshot.${cfg.invalid?.transient ? ' A falha parece passageira (leitura de disco).' : ''}`);
    } else if (cfg.mode !== 'ON' && data.reader !== 'FAILED') {
      add('waiting', '?', 'Estado do roteamento desconhecido: a configuração não pôde ser interpretada.');
    }
    const b = data.admission_blocked;
    if (b) {
      add('failed', '‖', `Admissão recusada (${b.cause}${b.detail ? ` · ${b.detail}` : ''}) desde ${when(b.first_blocked_at)}. Tickets barrados: ${b.tickets?.length ? b.tickets.map(t => `#${t}`).join(', ') : 'nenhum listado'} · ${NOTICE[b.notice?.status] || 'estado do aviso desconhecido'}${b.notice?.attempts != null ? ` (${b.notice.attempts} tentativa(s))` : ''}${b.transient ? ' · falha passageira' : ''}.`);
    }
    const diag = window.WouldRouteMetricsView?.get()?.diagnosis;
    if (diag?.title_pt && diag.code !== 'OK') add('waiting', '‖', `${diag.title_pt}.${diag.next_step_pt ? ` ${diag.next_step_pt}` : ''}`);
    if (cls.data?.registry_git_ignored === false) add('waiting', '‖', 'O registro memory/routing/classifier-selection.json não está ignorado pelo git do projeto consumidor: a escolha do classificador pode entrar num commit do consumidor. Inclua-o no .gitignore.');
    return out;
  }

  // ── topo (cauda do caminho e frase de apoio do artboard, no topbar do shell) ─────
  // Os nós ficam no topbar e somem nas outras telas pelo CSS (body[data-view]).
  function topbar() {
    const crumbs = document.querySelector?.('.crumbs-top');
    if (!crumbs) return;
    let tail = document.getElementById('rtCrumbTail');
    if (!tail) {
      tail = el('span', null, 'rt-top rt-crumb-tail');
      tail.id = 'rtCrumbTail';
      crumbs.append(tail);
    }
    let hint = document.getElementById('rtTopHint');
    if (!hint) {
      hint = el('span', null, 'rt-top rt-top-hint');
      hint.id = 'rtTopHint';
      crumbs.after(hint);
    }
    const p = data?.config?.mode === 'ON' ? data.config.policy : null;
    const project = cls.data?.project;
    const label = [project, p ? `${p.id}@${p.version}` : null].filter(Boolean).join(' · ');
    tail.replaceChildren(...(label ? [attr(el('span', '›'), { 'aria-hidden': 'true' }), el('span', `◆ ${label}`)] : []));
    hint.title = 'Fonte: /api/routing · runs_total';
    hint.textContent = data && Number.isInteger(data.runs_total)
      ? `A sombra calcula em paralelo o que a policy escolheria nas ${data.runs_total} Runs lidas, sem afetar o despacho.`
      : '';
  }

  // ── lista ────────────────────────────────────────────────────────────────────────
  function clsRow() {
    let st;
    if (cls.busy) st = { k: 'running', glyph: '◐', label: 'troca enviada' };
    else if (cls.data) st = { k: 'done', glyph: '✓', label: clsCurrentLabel() };
    else st = { k: 'queued', glyph: '?', label: cls.missing ? 'indisponível' : cls.error ? 'desconhecido' : 'carregando' };
    const c = cls.data?.current;
    return {
      key: 'cls', node: 'classificador', name: 'Quem decide o modelo de cada subtarefa', st,
      split: c ? `versão ${c.version ?? '?'}${c.by ? ` · por ${c.by}` : ''}` : '', bar: null,
    };
  }

  function rowButton(r) {
    const cur = ui.sel === r.key;
    const b = attr(el('button', null, `rt-row${cur ? ' is-current' : ''}`), { 'aria-current': cur ? 'true' : 'false' });
    b.type = 'button';
    b.dataset.row = '';
    b.dataset.key = r.key;
    b.dataset.tfilter = `routing-node-${String(r.key).replace(/[^\w-]/g, '_')}`;
    const top = el('span', null, 'rt-row-top');
    const pill = el('span', null, `rt-pill rt-pill-${r.st.k}`);
    pill.append(attr(el('span', r.st.glyph), { 'aria-hidden': 'true' }), txt(r.st.label));
    top.append(el('span', r.node, 'rt-row-node'), pill);
    const line = el('span', null, 'rt-row-line');
    if (r.bar) {
      const bar = attr(el('span', null, 'rt-bar'), { 'aria-hidden': 'true' });
      for (const [cl, w] of [['same', r.bar.same], ['cheaper', r.bar.cheaper], ['pricier', r.bar.pricier]]) {
        const seg = el('span', null, `rt-bar-${cl}`);
        seg.style && (seg.style.width = w);
        bar.append(seg);
      }
      line.append(bar);
    }
    const split = el('span', r.split, 'num');
    if (r.bar) split.title = SRC_SHADOW;
    line.append(split);
    b.append(top, el('span', r.name, 'rt-row-name'), line);
    b.addEventListener('click', () => { ui.sel = r.key; refresh(); });
    return b;
  }

  function sidePane(nodes) {
    const side = attr(el('section', null, `rt-side${ui.sel ? ' has-sel' : ''}`), { 'aria-label': 'Etapas e classificador' });
    const head = el('div', null, 'rt-side-head');
    const tabs = attr(el('div', null, 'rt-seg'), { role: 'tablist', 'aria-label': 'Recorte dos nós' });
    const allRows = nodes.map(n => ({ n, key: n.node, label: nodeLabel(n.node) }));
    const inQuery = r => M.matches(r.n, ui.q, r.label);
    const clsMatches = !ui.q.trim() || 'classificador quem decide o modelo jev policy'.includes(ui.q.trim().toLowerCase());
    for (const [id, label, fn] of M.VIEWS) {
      const on = ui.view === id;
      const count = allRows.filter(r => inQuery(r) && fn(r.n)).length + (id === 'all' && clsMatches ? 1 : 0);
      const t = attr(el('button', null, 'rt-seg-btn'), { role: 'tab', 'aria-selected': String(on) });
      t.type = 'button';
      t.dataset.tfilter = `routing-view-${id}`;
      t.append(txt(`${label} `), el('span', String(count), 'num rt-seg-n'));
      t.title = SRC_SHADOW;
      t.addEventListener('click', () => { ui.view = id; refresh(); });
      tabs.append(t);
    }
    const search = attr(el('input', null, 'rt-search'), { type: 'search', 'aria-label': 'Filtrar nós e modelos', placeholder: 'Filtrar por nó ou modelo…' });
    search.value = ui.q;
    search.dataset.tfilter = 'routing-q';
    search.addEventListener('input', e => { ui.q = e.target.value; refresh(); });
    search.addEventListener('focus', () => { const n = search.value.length; search.setSelectionRange?.(n, n); });
    const live = el('span', null, 'rt-live num');
    const compared = nodes.reduce((a, n) => a + n.comparable, 0);
    const unknown = nodes.reduce((a, n) => a + n.total - n.comparable, 0);
    live.textContent = `${compared} Attempt(s) comparados${unknown ? ` · ${unknown} sem comparação` : ''} · atualizado às ${clock(data.generated_at)}`;
    live.title = SRC_SHADOW;
    head.append(tabs, search, live);
    side.append(head);

    for (const b of banners()) {
      const p = attr(el('p', null, `rt-banner rt-banner-${b.tone}`), { role: 'status' });
      p.append(attr(el('span', `${b.glyph} `), { 'aria-hidden': 'true' }), txt(b.text));
      side.append(p);
    }

    const viewFn = (M.VIEWS.find(v => v[0] === ui.view) || M.VIEWS[0])[2];
    const visible = allRows.filter(r => inQuery(r) && viewFn(r.n)).map(r => ({
      key: r.key, node: r.n.node, name: r.label, st: M.STATUS[r.n.status], split: M.splitText(r.n), bar: M.barWidths(r.n),
    }));
    if (ui.view === 'all' && clsMatches) visible.push(clsRow());
    const list = el('div', null, 'rt-list');
    for (const r of visible) list.append(rowButton(r));
    side.append(list);
    if (!visible.length) {
      const empty = el('div', null, 'rt-empty');
      empty.append(el('span', 'Nenhum nó neste recorte.', 'rt-empty-title'), el('span', nodes.length ? 'Nada bate com o filtro na aba escolhida.' : 'Nenhum Attempt com sombra ou decisão real ainda.'));
      const clear = el('button', 'Limpar filtro', 'rt-ghost');
      clear.type = 'button';
      clear.dataset.tfilter = 'routing-clear';
      clear.addEventListener('click', () => { ui.q = ''; ui.view = 'all'; refresh(); });
      empty.append(clear);
      side.append(empty);
    }
    const legend = el('p', null, 'rt-legend');
    legend.append(attr(el('span', '■', 'rt-sw-same'), { 'aria-hidden': 'true' }), txt(' igual ao atual · '),
      attr(el('span', '■', 'rt-sw-cheaper'), { 'aria-hidden': 'true' }), txt(' sombra escolheria tier menor · '),
      attr(el('span', '■', 'rt-sw-pricier'), { 'aria-hidden': 'true' }), txt(' sombra escolheria tier maior. Efeito na qualidade não medido.'));
    side.append(legend);
    return { side, visible };
  }

  // ── detalhe ──────────────────────────────────────────────────────────────────────
  function compareSection(cards) {
    const sec = attr(el('section', null, 'rt-compare'), { 'aria-label': 'Hoje contra a sombra' });
    for (const c of cards) {
      const card = el('div', null, `rt-card${c.accent ? ' is-accent' : ''}`);
      card.append(el('span', c.k, 'label'), el('span', c.v, 'rt-card-v'), el('span', c.d, 'rt-card-d'));
      if (c.src) card.title = c.src;
      sec.append(card);
    }
    return sec;
  }

  function sideList(title, items, emptyText) {
    const aside = attr(el('aside', null, 'rt-aside'), { 'aria-labelledby': 'rtDvH' });
    const h = el('h2', title, 'label rt-aside-h');
    h.id = 'rtDvH';
    aside.append(h);
    for (const u of items) {
      const item = el('div', null, 'rt-aside-item');
      const line = el('span', null, 'rt-aside-line');
      const run = u.open ? el('button', u.run, 'linkish rt-aside-run') : el('span', u.run, 'rt-aside-run');
      if (u.open) { run.type = 'button'; run.dataset.open = u.open; }
      line.append(run, el('span', u.swap, 'rt-aside-swap'), el('span', u.d, `num rt-aside-d rt-tone-${u.kind || 'muted'}`));
      item.append(line);
      if (u.why) item.append(el('span', u.why, 'rt-aside-why'));
      aside.append(item);
    }
    if (!items.length) aside.append(el('span', emptyText, 'rt-aside-empty'));
    return aside;
  }

  function nodeDetail(n) {
    const frag = [];
    const head = el('div', null, 'rt-detail-head');
    const h = el('h1', nodeLabel(n.node), 'rt-h1');
    h.id = 'rtH';
    const kick = el('span', `Nó ${n.node} · ${n.total} Attempt(s) com sombra ou decisão real`, 'rt-kicker');
    kick.title = SRC_SHADOW;
    head.append(kick, h);
    frag.push(head, compareSection(M.compareCards(n).map(c => ({ ...c, src: SRC_SHADOW }))));
    const ev = el('div', null, 'rt-evidence');
    ev.append(attr(el('span', '⚗', 'rt-evidence-glyph'), { 'aria-hidden': 'true' }),
      el('span', 'Efeito na qualidade: não medido. A comparação é de tier, que é o que muda o modelo; saber se a escolha da sombra daria o mesmo resultado exige rodar as duas.'));
    frag.push(ev);
    const row = el('div', null, 'rt-split');
    row.append(sideList('Onde a sombra divergiu', n.divergent.map(r => ({ ...M.divergenceRow(r), open: r.task_id })), 'Nenhuma divergência.'));
    frag.push(row);
    return frag;
  }

  function clsDetail() {
    const frag = [];
    const head = el('div', null, 'rt-detail-head');
    const h = el('h1', 'Quem decide o modelo de cada subtarefa', 'rt-h1');
    h.id = 'rtH';
    head.append(el('span', 'Classificador · vale para todos os nós', 'rt-kicker'), h);
    frag.push(head);
    if (cls.missing || cls.error || !cls.data) {
      const p = attr(el('p', null, 'rt-status'), { role: 'status' });
      p.textContent = cls.missing
        ? 'Seletor do classificador indisponível neste Dashboard: o endpoint /api/routing/classifier ainda não existe. Nada aqui foi alterado.'
        : cls.error ? `Não deu para ler o classificador (${cls.error}). Estado desconhecido.` : 'Carregando o classificador…';
      frag.push(p);
      return frag;
    }
    const d = cls.data;
    const c = d.current || {};
    const chosen = cls.form.option ? CLS_OPTIONS.find(o => o[0] === cls.form.option) : null;
    const today = c.source === 'INVALID'
      ? { k: 'Hoje', v: 'Registro de seleção ilegível', d: `${c.reason || 'CLASSIFIER_SELECTION_INVALID'} · classificador efetivo informado pela API: ${c.provider || 'desconhecido'}. O writer decide se aceita uma troca agora.` }
      : { k: 'Hoje', v: clsCurrentLabel(), d: `versão ${c.version ?? '?'}${c.by ? ` · por ${c.by}` : ''}${c.at ? ` · ${when(c.at)}` : ''}${c.reason ? ` · “${c.reason}”` : ''}` };
    frag.push(compareSection([
      { ...today, src: 'Fonte: /api/routing/classifier · current' },
      { k: 'Escolhido', v: chosen ? chosen[3] : 'nenhuma opção marcada', d: chosen ? chosen[4] : 'Marque uma opção abaixo.', accent: !!chosen },
    ]));
    if (d.routing_mode === 'OFF') {
      const ev = el('div', null, 'rt-evidence');
      ev.append(attr(el('span', '⚗', 'rt-evidence-glyph'), { 'aria-hidden': 'true' }),
        el('span', 'O roteamento deste projeto está desligado: a escolha fica registrada, mas não muda nenhum despacho enquanto ele estiver OFF.'));
      frag.push(ev);
    }
    const row = el('div', null, 'rt-split');
    const col = el('div', null, 'rt-split-main');
    const group = attr(el('section', null, 'rt-opts'), { role: 'radiogroup', 'aria-labelledby': 'rtOpH' });
    const oh = el('h2', 'Classificador', 'label');
    oh.id = 'rtOpH';
    group.append(oh);
    for (const [key, , , label, desc] of CLS_OPTIONS) {
      const st = optionState(d, key);
      const on = cls.form.option === key;
      const b = attr(el('button', null, `rt-opt${on ? ' is-on' : ''}`), { role: 'radio', 'aria-checked': String(on) });
      b.type = 'button';
      b.dataset.clsOption = key;
      b.dataset.tfilter = `routing-cls-opt-${key.replace(/[^\w-]/g, '_')}`;
      b.disabled = !st.allowed || cls.busy;
      const ring = attr(el('span', null, 'rt-opt-ring'), { 'aria-hidden': 'true' });
      ring.append(el('span', null, 'rt-opt-dot'));
      const body = el('span', null, 'rt-opt-body');
      const title = el('span', label, 'rt-opt-label');
      if (isCurrent(d, key)) title.append(el('span', ' · ativo', 'rt-opt-tag'));
      body.append(title, el('span', desc, 'rt-opt-what'));
      if (!st.allowed) {
        const why = el('span', null, 'rt-opt-refusal');
        why.append(txt('Recusado agora: '), el('code', st.refusal || 'sem código'), txt(st.detail ? ` · ${st.detail}` : ''));
        body.append(why);
      }
      b.append(ring, body);
      b.addEventListener('click', () => { if (!b.disabled) { cls.form.option = key; refresh(); } });
      group.append(b);
    }
    col.append(group);
    // Motivo: exigido pelo writer (vai para o histórico). Não está no artboard; prompt de canvas no PR.
    const reason = attr(el('textarea', null, 'rt-reason'), { 'aria-label': 'Motivo da troca', rows: '2' });
    reason.dataset.clsField = 'reason';
    reason.dataset.tfilter = 'routing-cls-reason';
    reason.value = cls.form.reason;
    const label = el('label', 'Motivo (vai para o histórico)', 'rt-field');
    label.append(reason);
    col.append(label);
    if (cls.msg) {
      const m = attr(el('div', cls.msg, `rt-status${cls.msgCls === 'ok' ? ' is-ok' : cls.msgCls === 'err' ? ' is-err' : ''}`), { role: 'status' });
      col.append(m);
    }
    const sendRow = el('div', null, 'rt-send-row');
    const send = el('button', null, 'rt-send');
    send.type = 'button';
    send.dataset.clsAction = 'send';
    send.dataset.tfilter = 'routing-cls-send';
    const hint = attr(el('span', null, 'rt-send-hint'), { role: 'status' });
    const sync = () => {
      const why = sendBlock(d);
      send.disabled = !!why;
      const cur = cls.form.option && isCurrent(d, cls.form.option);
      send.replaceChildren(txt(cls.busy ? 'Enviado…' : !cls.form.option ? 'Escolha uma opção' : cur ? 'Já é o ativo' : `Pedir troca para ${chosen ? chosen[3] : ''}`));
      hint.textContent = why && why !== 'Escolha uma opção.' ? why : 'Vale só para Runs novas. Runs já admitidas mantêm o classificador do próprio snapshot.';
    };
    reason.addEventListener('input', e => { cls.form.reason = e.target.value; sync(); });
    send.addEventListener('click', () => { if (!send.disabled) sendClassifier(d); });
    sync();
    sendRow.append(send, hint);
    col.append(sendRow);
    row.append(col);
    const hist = Array.isArray(d.history) ? d.history : [];
    row.append(sideList('Histórico do classificador', hist.map(v => ({
      run: `versão ${v.version ?? 'desconhecida'}`, swap: optionLabel(v.choice, v.mode) || v.choice || '?', d: when(v.at), kind: 'muted',
      why: `${v.by || '?'}${v.reason ? ` · “${v.reason}”` : ''}`,
    })), 'Nenhuma troca registrada.'));
    frag.push(row);
    return frag;
  }

  function mixSection() {
    const sec = attr(el('section', null, 'rt-box'), { 'aria-labelledby': 'rtMixH' });
    const n = Number.isInteger(data.runs_total) ? data.runs_total : null;
    const h = el('h2', `Mistura de modelos ${n != null ? `nas ${n} Runs lidas` : 'nas Runs lidas'}`, 'label');
    h.id = 'rtMixH';
    sec.append(h);
    const rows = M.mixRows(data.mix);
    const t = data.mix?.totals;
    if (!rows.length || !t?.attempts) {
      sec.append(el('span', 'Nenhum Attempt nesta janela.', 'rt-box-note'));
      return sec;
    }
    for (const m of rows) {
      const item = el('div', null, 'rt-mix-item');
      const line = el('span', null, 'rt-mix-line');
      const nums = el('span', `${m.share} · ${m.cost}${m.unpriced ? ` · ${m.unpriced} sem preço` : ''}`, 'num rt-mix-n');
      nums.title = `Fonte: /api/routing · mix (${m.attempts} Attempt(s) com este modelo pedido)`;
      line.append(el('span', m.name), nums);
      const bar = attr(el('span', null, 'rt-mix-bar'), { 'aria-hidden': 'true' });
      const fill = el('span', null, 'rt-mix-fill');
      fill.style && (fill.style.width = m.w);
      bar.append(fill);
      item.append(line, bar);
      sec.append(item);
    }
    const note = el('span', `${Number.isInteger(t.priced_attempts) ? `${t.priced_attempts} de ${t.attempts}` : `Preço desconhecido nos ${t.attempts}`} Attempts com preço. Custo do Attempt inteiro, agrupado pelo modelo pedido; o classificador fica fora da conta.`, 'rt-box-note');
    note.title = 'Fonte: /api/routing · mix.totals';
    sec.append(note);
    return sec;
  }

  function policySection() {
    const sec = attr(el('section', null, 'rt-box'), { 'aria-labelledby': 'rtHistH' });
    const h = el('h2', 'Histórico da routing-policy', 'label');
    h.id = 'rtHistH';
    sec.append(h);
    const cfg = data.config || {};
    const p = cfg.mode === 'ON' ? cfg.policy : null;
    if (!p) {
      sec.append(el('span', cfg.mode === 'OFF' ? 'Sem policy vigente: roteamento desligado.' : cfg.mode === 'INVALID' ? 'Sem policy vigente: configuração inválida.' : 'Policy vigente desconhecida.', 'rt-box-note'));
      return sec;
    }
    const ol = el('ol', null, 'rt-hist');
    const li = el('li', null, 'rt-hist-item');
    const what = el('span', null, 'rt-hist-what');
    const k = v => (v == null || v === '' ? 'desconhecido' : String(v));
    what.append(el('span', `${k(p.id)} · ${k(p.status)} · classificador ${k(p.classifier_provider)}`),
      el('span', `${p.approval ? `${k(p.approval.by)} · ${k(p.approval.at)}` : 'aprovação não registrada'} · vigente · SHA ${k(p.sha_short)}`, 'num rt-hist-who'));
    what.title = 'Fonte: /api/routing · config.policy';
    li.append(el('span', `@${p.version}`, 'rt-hist-v'), what);
    ol.append(li);
    sec.append(ol);
    return sec;
  }

  // ── tela ─────────────────────────────────────────────────────────────────────────
  function render() {
    if (!data && !error && !loading) load();
    topbar();
    const root = el('section', null, 'routing');
    if (error || !data) {
      root.append(el('p', error || 'Carregando…', 'vempty rt-loading'));
      return root;
    }
    const nodes = M.aggregateNodes(data.shadow_vs_real?.rows);
    if (ui.sel === undefined) ui.sel = nodes[0]?.node || 'cls';
    if (ui.sel && ui.sel !== 'cls' && !nodes.some(n => n.node === ui.sel)) ui.sel = nodes[0]?.node || 'cls';
    const panes = attr(el('div', null, 'rt-panes'), {
      tabindex: '0',
      'data-local-digits': '',
      'aria-label': 'Roteamento de modelos. J e K percorrem a lista, Enter abre, 1 a 3 trocam a aba, Esc fecha, Command K abre a paleta.',
    });
    const { side, visible } = sidePane(nodes);
    panes.append(side);
    if (ui.sel) {
      const main = attr(el('main', null, 'rt-detail'), { 'aria-labelledby': 'rtH' });
      const close = el('div');
      close.innerHTML = window.UIKit ? window.UIKit.drawerClose('rt-close') : '';
      close.addEventListener('click', e => { if (e.target?.closest?.('[data-act="rt-close"]')) { ui.sel = null; refresh(); } });
      const art = el('article', null, 'rt-article');
      const n = nodes.find(x => x.node === ui.sel);
      art.append(...(ui.sel === 'cls' || !n ? clsDetail() : nodeDetail(n)));
      const grid = el('div', null, 'rt-grid');
      grid.append(mixSection(), policySection());
      art.append(grid);
      main.append(close, art);
      panes.append(main);
    }
    // J/K percorrem as linhas, Enter abre, Esc fecha (UIKit.listKeys); 1–3 trocam a aba.
    window.UIKit?.listKeys(panes, {
      item: '[data-row]',
      onOpen: row => { ui.sel = row.dataset.key; refresh(); },
      onClose: () => { if (!ui.sel) return false; ui.sel = null; refresh(); return true; },
    });
    panes.addEventListener('keydown', e => {
      if (e.metaKey || e.ctrlKey || e.altKey || /^(INPUT|TEXTAREA|SELECT)$/.test(e.target?.tagName || '')) return;
      const i = Number(e.key) - 1;
      if (Number.isInteger(i) && M.VIEWS[i]) { e.preventDefault(); ui.view = M.VIEWS[i][0]; refresh(); }
    });
    root.append(panes);

    const bar = el('footer', null, 'rt-statusbar');
    const cheaper = nodes.filter(n => n.status === 'economia').length;
    const tabIdx = M.VIEWS.findIndex(v => v[0] === ui.view) + 1;
    const nodeCount = nodes.length + 1;
    const left = attr(el('span', `${visible.length} de ${nodeCount} linhas · aba ${tabIdx} de ${M.VIEWS.length} · ${cheaper} nó(s) com sombra mais barata · classificador: ${cls.data ? clsCurrentLabel() : 'desconhecido'}`), { role: 'status' });
    left.title = SRC_SHADOW;
    bar.append(left, el('span', 'J K navegar · Enter abrir · 1–3 abas · Esc fechar · ⌘K paleta', 'rt-statusbar-keys'));
    root.append(bar);
    return root;
  }

  window.RoutingView = { render, load };
})();
