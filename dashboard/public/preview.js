// Painel "Preview de Ambiente" no detalhe do run (scripts/preview-manager.js via
// /api/preview/:ticketId/*): builda o código do ticket — do worktree ou de um commit da
// branch dele — e sobe app-back (:8081) + app-front (:9100). Script clássico carregado
// depois do principal; usa os globais runs, selected, esc, api, toast, nearBottom,
// ticketIdOfRun e $.
//
// renderDetail() reescreve #detail com innerHTML a cada atualização do run, então o
// painel se remonta via MutationObserver; estado (status, log, fold aberto) vive aqui.

// Fonte do código (worktree × commit): regras e HTML puros, testados no Node
// (preview-ui.test.js) como o ui-kit.js.
const PreviewSource = (() => {
  const esc = (typeof UIKit !== 'undefined' ? UIKit : require('./ui-kit')).esc;
  const short = sha => String(sha || '').slice(0, 8);
  const when = iso => {
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? '' : d.toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  };

  // Worktree quando existe (o que o watcher está mexendo agora); senão a branch.
  function defaultSource(st) {
    if (st?.worktrees?.back) return 'worktree';
    return st?.branches?.back ? 'commit' : 'worktree';
  }

  function sourceHtml(st, source, busy) {
    const opt = (key, label, why) => `<button type="button" data-pvsrc="${key}" aria-pressed="${source === key}"${busy || why ? ' disabled' : ''}${why ? ` title="${esc(why)}"` : ''}>${label}</button>`;
    return `<span class="pv-meta pv-db">Fonte <span class="seg" role="group" aria-label="Fonte do código">${
      opt('worktree', 'Worktree', st?.worktrees?.back ? '' : 'worktree não encontrado')}${
      opt('commit', 'Commit', st?.branches?.back ? '' : 'sem branch do ticket no app-back')}</span></span>`;
  }

  // SHA escolhido se ainda está na lista; senão o mais recente.
  function pickCommit(state, choice) {
    const list = state?.data?.commits || [];
    return list.some(c => c.sha === choice) ? choice : list[0]?.sha || null;
  }

  function commitPickerHtml(state, choice, busy) {
    if (state?.loading) return '<span class="pv-meta">Buscando commits da branch do ticket…</span>';
    if (state?.error) return `<span class="pv-meta">Não foi possível listar os commits: ${esc(state.error)}</span> <button type="button" class="link-btn" data-pvcommitsload>Tentar de novo</button>`;
    if (!state?.data) return '';
    const { ref, commits, front } = state.data;
    if (!commits.length) return `<span class="pv-meta">Nenhum commit em ${esc(ref)}.</span>`;
    const cur = pickCommit(state, choice);
    const opts = commits.map((c, i) => `<option value="${esc(c.sha)}" ${c.sha === cur ? 'selected' : ''}>${esc(short(c.sha))} · ${esc(c.subject)}${
      when(c.date) ? ` · ${esc(when(c.date))}` : ''}${i === 0 ? ' · mais recente' : ''}</option>`).join('');
    return `<label class="pv-meta pv-db pv-commit">Commit de ${esc(ref)}
        <select data-pvcommit ${busy ? 'disabled' : ''}>${opts}</select></label>
      <span class="pv-meta">${front ? `front: ${esc(front.ref)} @ ${esc(short(front.sha))} (ponta)` : 'front: sem branch do ticket — sobe só o back'}</span>`;
  }

  function canStart(st, source, state) {
    return source === 'commit' ? !!state?.data?.commits?.length : !!st?.worktrees?.back;
  }

  function startBody(source, state, choice) {
    return source === 'commit' ? { source, commit: pickCommit(state, choice) } : { source };
  }

  function liveSourceText(st) {
    if (st?.source === 'worktree') return 'worktree do ticket';
    if (st?.source !== 'commit' || !st.commit) return '';
    const front = st.refs?.front;
    return `commit ${short(st.commit.sha)} de ${st.commit.ref}${front ? ` · front ${short(front.sha)}` : ''}`;
  }

  return { defaultSource, sourceHtml, commitPickerHtml, canStart, startBody, liveSourceText };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = PreviewSource;

(() => {
  if (typeof document === 'undefined') return; // Node (testes): só o PreviewSource
  const PS = PreviewSource;
  const MAX_LINES = 300;
  const BUILDING = ['exporting', 'building-mo-entity', 'building-app-core', 'building-app-back', 'starting-back', 'starting-front'];
  const CHIPS = [
    ['mo-entity', 'mo-entity', s => s['mo-entity']],
    ['app-core', 'app-core', s => s['app-core']],
    // Build e start do back num chip só: "app-back" pronto = Quarkus de pé.
    ['app-back', 'app-back', s => s['app-back'] === 'error' || s.back === 'error' ? 'error'
      : s.back === 'done' ? 'done' : s['app-back'] === 'running' || s.back === 'running' || s['app-back'] === 'done' ? 'running' : s['app-back']],
    ['front', 'front', s => s.front],
  ];
  const MARK = { done: '✓', running: '⟳', error: '✗', skipped: '–', pending: '–' };

  let key = null;          // ticket-id do preview do run aberto
  let st = null;           // último status (GET /status ou evento SSE phase)
  let busy = null;         // 'start' | 'stop' enquanto a chamada não volta
  let loadError = null;    // falha do GET /status antes de ter qualquer status
  let es = null;
  let lines = [];
  let lastSeq = 0;
  let instance = null;
  let showLog = true;      // toggle do log no estado running
  // Banco escolhido no select (rótulo de PREVIEW_DB_OPTIONS); lembrado por navegador.
  let dbChoice = null;
  try { dbChoice = localStorage.getItem('preview.db'); } catch {}
  // Status do PR (state.json.pr_status): override local até o state_update chegar.
  const prLocal = new Map(); // taskId → 'ready'
  let prBusy = false;
  let prError = null;
  const openKeys = new Set();
  // "Usar na minha máquina" (GET/POST /api/local-checkout*): { active, repos } e a ação em curso.
  let lc = null;
  let lcBusy = null;       // 'use' | 'restore'
  let lcError = null;      // último erro (conflito do git é longo demais pro toast)
  // "Reconstruir libs": branches candidatas (GET /lib-refs) e a escolhida no select.
  let libRefs = {};        // { loading } | { data: { need, libs: [{ key, refs }] } } | { error }
  let libRefChoice = null;
  let pendingLibRef = null;
  // Fonte do código: null = PS.defaultSource(st). Commits da branch (GET /commits) e o escolhido.
  let source = null;
  let commitsState = {};   // { loading } | { data: { ref, sha, commits, front } } | { error }
  let commitChoice = null;
  const curSource = () => source || PS.defaultSource(st);

  // Worktree do app-back = .claude/worktrees/<id>; run lido de um worktree usa o nome
  // dele (inclui os sem número de ticket), senão o ticket-id. location vem como
  // "worktree:<nome>" ou, em run arquivado, "worktree:<nome> (_archive)".
  function previewKey(r) {
    const wt = (r.location?.match(/^worktree:(\S+)/) || [])[1] || null;
    if (wt) return wt.replace(/-(mo-entity|app-core|app-front)$/, '');
    const tid = ticketIdOfRun(r);
    return tid ? String(tid) : r.taskId;
  }

  function dur(ms) {
    if (!(ms >= 0)) return '';
    const s = Math.floor(ms / 1000), m = Math.floor(s / 60), h = Math.floor(m / 60);
    if (h) return `${h}h ${String(m % 60).padStart(2, '0')}m`;
    return m ? `${m}m ${String(s % 60).padStart(2, '0')}s` : `${s}s`;
  }
  const hhmmss = iso => new Date(iso).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

  // ------------------------------------------------------------------ dados
  async function refresh() {
    if (!key) return;
    const k = key;
    try {
      const s = await api(`/api/preview/${encodeURIComponent(k)}/status`);
      if (k === key) { st = s; loadError = null; }
    } catch (e) {
      if (k === key) loadError = e.message;
    }
    try {
      const l = await api(`/api/local-checkout?ticket=${encodeURIComponent(k)}`);
      if (k === key) lc = l;
    } catch { /* sem a seção "minha máquina"; o preview segue */ }
    paint();
  }

  function connect() {
    es?.close();
    lines = []; lastSeq = 0;
    if (!key) return;
    const k = key;
    es = new EventSource(`/api/preview/${encodeURIComponent(k)}/log-stream`);
    es.addEventListener('hello', ev => {
      let h; try { h = JSON.parse(ev.data); } catch { return; }
      if (instance && h.instance !== instance) { lines = []; lastSeq = 0; renderLog(); }
      instance = h.instance;
    });
    es.addEventListener('log', ev => {
      let e; try { e = JSON.parse(ev.data); } catch { return; }
      if (k !== key || e.seq <= lastSeq) return;
      // Start novo zera o buffer no servidor: a primeira linha dele é "preview iniciado".
      if (/^\[preview\] preview iniciado/.test(e.text)) lines = [];
      lastSeq = e.seq;
      lines.push(e);
      if (lines.length > MAX_LINES) lines.splice(0, lines.length - MAX_LINES);
      appendLine(e);
    });
    es.addEventListener('phase', ev => {
      let s; try { s = JSON.parse(ev.data); } catch { return; }
      if (k !== key) return;
      const was = st?.phase;
      st = s;
      paint();
      if (was && was !== 'running' && s.phase === 'running') toast(`Preview ${k} no ar — back :${s.ports.back}`);
    });
  }

  // Erro no build do back com lib(s) vindas do ~/.m2: o snapshot de lá pode estar fora de
  // sincronia com o código do ticket (ex.: assinatura de método que mudou na lib).
  const libFixable = () => st?.phase === 'error' && st.errorPhase === 'building-app-back'
    && (st.libFallback || []).filter(f => f.fixable);

  async function loadLibRefs() {
    if (!key || libRefs.loading) return;
    const k = key;
    libRefs = { loading: true };
    paint();
    try {
      const r = await api(`/api/preview/${encodeURIComponent(k)}/lib-refs`);
      if (k === key) libRefs = { data: r };
    } catch (e) {
      if (k === key) libRefs = { error: e.message };
    }
    paint();
  }

  async function loadCommits() {
    if (!key || commitsState.loading) return;
    const k = key;
    commitsState = { loading: true };
    paint();
    try {
      const r = await api(`/api/preview/${encodeURIComponent(k)}/commits`);
      if (k === key) commitsState = { data: r };
    } catch (e) {
      if (k === key) commitsState = { error: e.message };
    }
    paint();
  }
  // Modo commit parado: a lista aparece sozinha (uma busca por ticket; "Tentar de novo" refaz).
  function ensureCommits() {
    const idle = st && (st.phase === 'idle' || st.phase === 'error');
    if (idle && st.configured !== false && curSource() === 'commit' && !commitsState.loading && !commitsState.data && !commitsState.error) loadCommits();
  }

  async function act(action) {
    if (!key) return;
    const k = key;
    if (action === 'clean' && !confirm(`Apagar o cache do build de ${k}?\n\n• target/ dos worktrees (e .tmp do front)\n• código extraído no modo commit\n• mo-entity/app-core que o preview instalou no repositório Maven dele (o seu ~/.m2 não é tocado)`)) return;
    busy = action; paint();
    try {
      const opts = { method: 'POST' };
      if (action === 'start') {
        const db = selectedDb();
        opts.headers = { 'Content-Type': 'application/json' };
        opts.body = JSON.stringify({ db: db?.key ?? null, libRef: pendingLibRef || undefined, ...PS.startBody(curSource(), commitsState, commitChoice) });
        pendingLibRef = null; // vale só pro clique de "Reconstruir libs"
        libRefs = {};         // lista de branches fica velha após um novo start
      }
      const s = await api(`/api/preview/${encodeURIComponent(k)}/${action}`, opts);
      if (k === key) st = s;
      if (action === 'start') { showLog = true; openKeys.add(k); }
      if (action === 'clean') toast(s.removed?.length ? `Cache de ${k} limpo (${s.removed.length} diretório${s.removed.length > 1 ? 's' : ''})` : `Nada a limpar em ${k}`);
    } catch (e) {
      toast(e.message);
    } finally {
      busy = null;
      refresh();
    }
  }

  async function markReady() {
    const r = runs.get(selected);
    if (!r || !key || prBusy) return;
    const taskId = r.taskId;
    prBusy = true; prError = null; paint();
    try {
      await api(`/api/pr/${encodeURIComponent(key)}/ready`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ taskId }),
      });
      prLocal.set(taskId, 'ready');
    } catch (e) {
      if (runs.get(selected)?.taskId === taskId) prError = e.message;
    } finally {
      prBusy = false;
      paint();
    }
  }

  async function localCheckout(action) {
    if (!key || lcBusy) return;
    const k = key;
    if (action === 'use') {
      const repos = (lc?.repos || []).filter(r => r.available);
      const msg = `Colocar os checkouts principais no commit do ticket ${k}?\n\n`
        + repos.map(r => `• ${r.key} → ${r.sha.slice(0, 10)}${r.dirty ? ' (worktree com alteração não commitada: ela NÃO vem)' : ''}`).join('\n')
        + '\n\nFica em detached HEAD; suas alterações locais vão junto. Os arquivos versionados do projeto também passam a ser os do ticket até você clicar em "Voltar às branches".';
      if (!confirm(msg)) return;
    }
    lcBusy = action; lcError = null; paint();
    try {
      const path = action === 'use' ? `/api/local-checkout/${encodeURIComponent(k)}/use` : '/api/local-checkout/restore';
      // fetch direto (não api()): no 409 o corpo traz rollbackErrors, que o api() descarta.
      const res = await fetch(path, { method: 'POST' });
      const r = await res.json().catch(() => ({}));
      if (!res.ok) {
        const extra = r.rollbackErrors?.length ? ` · NÃO VOLTOU: ${r.rollbackErrors.join(' · ')} — use "Voltar às branches"` : '';
        throw new Error((r.error || `HTTP ${res.status}`) + extra);
      }
      if (action === 'use') toast([`Checkouts no ticket ${k} — pode subir o ambiente`, ...(r.warnings || [])].join(' · '));
      else {
        const bad = (r.results || []).filter(x => !x.ok);
        toast(bad.length ? `Voltou em parte: ${bad.map(x => `${x.key}: ${x.message}`).join(' · ')}` : 'Checkouts de volta às branches anteriores');
      }
    } catch (e) {
      lcError = e.message;
      toast(e.message);
    } finally {
      lcBusy = null;
      refresh();
    }
  }

  // ------------------------------------------------------------------ UI
  function lcHtml() {
    if (!lc) return '';
    const a = lc.active;
    const avail = (lc.repos || []).filter(r => r.available);
    const refs = a ? Object.entries(a.repos || {}).map(([k, r]) => `${esc(k)} → ${esc(r.previous.ref.slice(0, r.previous.type === 'branch' ? 80 : 10))}`).join(', ') : '';
    const here = a && a.ticket === key;
    const useBtn = `<button type="button" class="ghost-btn" data-lcact="use" ${lcBusy || !avail.length ? 'disabled' : ''} title="${avail.length ? `Checkouts principais (${esc(avail.map(r => r.key).join(', '))}) no commit do worktree do ticket` : 'nenhum worktree do ticket'}">${lcBusy === 'use' ? 'Trocando…' : here ? '💻 Atualizar pro último commit' : '💻 Usar na minha máquina'}</button>`;
    return `
      <div class="pv-actions pv-lc" role="group" aria-label="Checkouts da minha máquina">
        ${useBtn}
        ${a ? `<button type="button" class="ghost-btn" data-lcact="restore" ${lcBusy ? 'disabled' : ''} title="Volta cada repo pra: ${refs}">${lcBusy === 'restore' ? 'Voltando…' : '↩ Voltar às branches'}</button>` : ''}
        ${lcError ? `<p class="fold-msg err" role="alert" style="flex-basis:100%;margin:0">${esc(lcError)}</p>` : ''}
        <span class="pv-meta">${a ? `${here ? '🟢' : '⚠'} checkouts principais no ticket <b>${esc(a.ticket)}</b> (${esc(Object.keys(a.repos || {}).join(', '))})` : 'checkouts principais nas suas branches'}</span>
      </div>`;
  }

  // Badge acima dos botões de preview. Sem pr_status (PR ainda não aberto) = nada.
  function prHtml() {
    const r = runs.get(selected);
    const server = r?.state?.pr_status || null;
    const local = r && prLocal.get(r.taskId);
    const status = server === 'merged' ? 'merged' : local || server;
    if (!['draft', 'ready', 'merged'].includes(status)) return '';
    const badge = {
      draft: '<span class="pr-badge draft"><span aria-hidden="true">‖</span> Draft</span>',
      ready: '<span class="pr-badge ready"><span aria-hidden="true">◐</span> Ready for review</span>',
      merged: '<span class="pr-badge merged"><span aria-hidden="true">✓</span> Mergeado</span>',
    }[status];
    const cleaned = r.state?.worktrees_cleaned_at;
    const extra = status === 'draft'
      ? `<button type="button" class="ghost-btn" data-prready ${prBusy ? 'disabled aria-busy="true"' : ''}>${prBusy ? 'Marcando…' : 'Marcar como pronto →'}</button>`
      : status === 'merged'
        ? `<span class="pv-meta">${cleaned ? 'Worktrees removidos' : r.state?.worktrees_cleanup_errors?.length ? 'Worktrees: remoção manual pendente' : 'Removendo worktrees…'}</span>`
        : '';
    return `
      <div class="pr-status" role="group" aria-label="Status do PR">
        <span class="pr-status-label">Status do PR</span>${badge}${extra}
      </div>
      ${prError && status === 'draft' ? `<p class="fold-msg err" role="alert">Não foi possível marcar como pronto: ${esc(prError)}</p>` : ''}`;
  }

  function lineHtml(e) {
    return `<span class="pv-${e.level.toLowerCase()}${e.source === 'preview' ? ' pv-mgr' : ''}">${hhmmss(e.ts)} ${esc(e.text)}\n</span>`;
  }
  function logEl() { return document.getElementById('pvLog'); }
  function renderLog() {
    const el = logEl();
    if (!el) return;
    el.innerHTML = lines.length ? lines.map(lineHtml).join('') : '<span class="pv-empty">Sem linhas de log ainda.</span>';
    el.scrollTop = el.scrollHeight;
  }
  function appendLine(e) {
    const el = logEl();
    if (!el) return;
    const stick = nearBottom(el);
    el.querySelector('.pv-empty')?.remove();
    el.insertAdjacentHTML('beforeend', lineHtml(e));
    while (el.childElementCount > MAX_LINES) el.firstElementChild.remove();
    if (stick) el.scrollTop = el.scrollHeight;
  }

  function summary() {
    if (st?.configured === false) return 'não configurado';
    const p = st?.phase;
    if (busy === 'start') return '<span class="pv-dot warn"></span>Iniciando…';
    if (busy === 'stop' || p === 'stopping') return '<span class="pv-dot warn"></span>Parando…';
    if (p === 'running') return `<span class="pv-dot on"></span>Rodando :${st.ports.back}`;
    if (BUILDING.includes(p)) return '<span class="pv-dot warn"></span>Construindo…';
    if (p === 'error') return '<span class="pv-dot off"></span>Erro';
    if (!st && loadError) return '<span class="pv-dot off"></span>indisponível';
    return st && !st.worktrees?.back && !st.branches?.back ? 'sem worktree nem branch' : 'parado';
  }

  function detected(w) {
    const one = (label, ok) => `<span class="${ok ? 'pv-ok' : 'pv-no'}">${label} ${ok ? '✓' : '–'}</span>`;
    return `Worktrees detectados: ${one('back', w.back)} | ${one('app-core', w.appCore)} | ${one('mo-entity', w.moEntity)} | ${one('front', w.front)}`;
  }
  function chips(steps) {
    return CHIPS.map(([, label, f]) => { const v = f(steps || {}) || 'pending'; return `<span class="pv-chip ${v}">${label} ${MARK[v] || '–'}</span>`; }).join('');
  }
  const CLEAN_TIP = 'Apaga target/ dos worktrees, o código extraído no modo commit e o que o preview instalou no repositório Maven dele (o ~/.m2 fica)';
  const logBox = () => '<pre class="pv-log" id="pvLog" tabindex="0" aria-label="Log do preview" aria-live="off"></pre>';
  const btn = (act, label, extra = '') => `<button type="button" class="ghost-btn" data-pvact="${act}" ${busy ? 'disabled' : ''} ${extra}>${label}</button>`;

  // Escolha válida (existe no worktree); senão a do último start, senão a primeira.
  function selectedDb() {
    const opts = (st?.dbOptions || []).filter(o => o.exists);
    return opts.find(o => o.key === dbChoice) || opts.find(o => o.key === st?.db) || opts[0] || null;
  }
  const dbText = o => `${o.key}${o.db ? ` — ${o.db}` : ''}${o.sistema ? ` (${o.sistema})` : ''}`;
  function dbSelect() {
    const opts = st?.dbOptions || [];
    if (!opts.length) return '';
    const cur = selectedDb();
    return `<label class="pv-meta pv-db">Banco
      <select data-pvdb ${busy ? 'disabled' : ''}>${opts.map(o => `<option value="${esc(o.key)}" ${o === cur ? 'selected' : ''} ${o.exists ? '' : 'disabled'}>${esc(dbText(o))}${o.exists ? '' : ' — sem .properties'}</option>`).join('')}</select></label>`;
  }
  function runningDb() {
    const o = (st?.dbOptions || []).find(x => x.key === st?.db);
    return o ? `<span class="pv-meta">banco: ${esc(dbText(o))}</span>` : '';
  }

  // Aviso + reparo no erro de build do back quando mo-entity/app-core vieram do ~/.m2.
  function libFixHtml() {
    const fx = libFixable();
    if (!fx || !fx.length) return '';
    const names = fx.map(f => f.key).join(', ');
    let picker;
    if (libRefs.loading) picker = '<span class="pv-meta">Buscando branches com a versão do back…</span>';
    else if (libRefs.error) picker = `<span class="pv-meta">Não foi possível listar as branches: ${esc(libRefs.error)}</span> <button type="button" class="link-btn" data-pvlibload>Tentar de novo</button>`;
    else if (!libRefs.data) picker = '<button type="button" class="ghost-btn" data-pvlibload>Escolher branch das libs…</button>';
    else {
      const all = [...new Set(libRefs.data.libs.flatMap(l => l.refs))];
      if (!all.length) picker = `<span class="pv-meta">Nenhuma branch remota de ${esc(names)} tem a versão ${esc(libRefs.data.need || '?')}. Rode o install da lib na branch certa e tente de novo.</span>`;
      else {
        const cur = all.includes(libRefChoice) ? libRefChoice : all[0];
        picker = `<label class="pv-meta pv-db">Branch das libs (versão ${esc(libRefs.data.need)})
          <select data-pvlibref ${busy ? 'disabled' : ''}>${all.map(r => `<option value="${esc(r)}" ${r === cur ? 'selected' : ''}>${esc(r)}</option>`).join('')}</select></label>
          <button type="button" class="ghost-btn" data-pvlibgo="${esc(cur)}" ${busy ? 'disabled' : ''} title="Reconstrói ${esc(names)} a partir dessa branch (ignora o cache do repositório do preview; o ~/.m2 não é tocado) e reinicia o preview">🔧 Reconstruir libs e tentar de novo</button>`;
      }
    }
    return `
      <p class="fold-msg warn">${esc(names)} ${fx.length > 1 ? 'usaram' : 'usou'} o ~/.m2 (nenhuma branch padrão com a versão do back). Erro de compilação em chamada de lib costuma ser snapshot desatualizado ou de outra branch.</p>
      <div class="pv-actions">${picker}</div>`;
  }

  function bodyHtml() {
    if (!st && loadError) return `<p class="fold-msg err">Não foi possível consultar o preview de <code>${esc(key)}</code>: ${esc(loadError)}</p>
      <div class="pv-actions"><button type="button" class="ghost-btn" data-pvretry>↻ Tentar de novo</button></div>`;
    if (!st) return '<p class="fold-msg">Verificando worktrees…</p>';
    if (st.configured === false) return '<p class="fold-msg">Preview não configurado para este projeto.</p>';
    const p = st.phase;
    const w = st.worktrees || {};
    const other = st.activeTicket && st.activeTicket !== key
      ? `<p class="fold-msg warn">Preview do ticket ${esc(st.activeTicket)} está rodando — pare-o antes de iniciar este.</p>` : '';
    if (p === 'running') {
      const front = st.steps?.front && st.steps.front !== 'skipped';
      return `
        <p class="pv-state">🟢 Rodando — back :${st.ports.back}${front ? `  front :${st.ports.front}` : ''}</p>
        <div class="pv-actions">
          <a class="ghost-btn" href="http://localhost:${st.ports.back}" target="_blank" rel="noopener">Abrir :${st.ports.back}</a>
          ${front ? `<a class="ghost-btn" href="http://localhost:${st.ports.front}" target="_blank" rel="noopener">Abrir :${st.ports.front}</a>` : ''}
          ${runningDb()}
          ${PS.liveSourceText(st) ? `<span class="pv-meta">${esc(PS.liveSourceText(st))}</span>` : ''}
          <span class="pv-meta">uptime: <span id="pvUptime">${dur(Date.now() - Date.parse(st.runningAt))}</span></span>
          <button type="button" class="link-btn" data-pvlog>${showLog ? 'Ocultar log' : 'Mostrar log'}</button>
        </div>
        ${showLog ? logBox() : ''}
        <div class="pv-actions">${btn('stop', '■ Parar Preview')}</div>`;
    }
    if (BUILDING.includes(p) || p === 'stopping') {
      return `
        <p class="pv-state">🔨 ${p === 'exporting' ? 'Extraindo o commit...' : 'Construindo...'} ${chips(st.steps)}</p>
        ${PS.liveSourceText(st) ? `<p class="pv-meta" style="margin:0">${esc(PS.liveSourceText(st))}</p>` : ''}
        ${logBox()}
        <div class="pv-actions">${btn('stop', '■ Parar')}</div>`;
    }
    if (p === 'error') {
      return `
        <p class="pv-state err">🔴 Erro na fase: ${esc(st.errorPhase || '—')}</p>
        <p class="pv-msg">Mensagem: ${esc(st.error || '—')}</p>
        ${libFixHtml()}
        ${logBox()}
        ${other}
        <div class="pv-actions">${PS.sourceHtml(st, curSource(), !!busy)} ${curSource() === 'commit' ? PS.commitPickerHtml(commitsState, commitChoice, !!busy) : ''}</div>
        <div class="pv-actions">${dbSelect()} ${btn('start', '↺ Tentar novamente', PS.canStart(st, curSource(), commitsState) ? '' : 'disabled')} ${btn('stop', '■ Parar')} ${btn('clean', '🧹 Limpar cache', `title="${CLEAN_TIP}"`)}</div>`;
    }
    const src = curSource();
    const noWt = src === 'worktree' && !w.back;
    const ready = PS.canStart(st, src, commitsState);
    return `
      <div class="pv-actions">
        ${PS.sourceHtml(st, src, !!busy)}
        ${src === 'commit' ? PS.commitPickerHtml(commitsState, commitChoice, !!busy) : `<span class="pv-meta">${detected(w)}</span>`}
      </div>
      <div class="pv-actions">
        ${dbSelect()}
        <button type="button" class="ghost-btn pv-start" data-pvact="start" ${busy || !ready ? 'disabled' : ''} ${noWt ? `title="worktree não encontrado (.claude/worktrees/${esc(key)})"` : ''}>▶ Iniciar Preview</button>
        ${btn('clean', '🧹 Limpar cache', `title="${CLEAN_TIP}"`)}
      </div>
      ${noWt ? `<p class="fold-msg">worktree não encontrado: <code>.claude/worktrees/${esc(key)}</code>${st.branches?.back ? ' — use a fonte <b>Commit</b> para subir a branch do ticket' : ''}</p>` : ''}
      ${other}
      ${lines.length ? `<details class="pv-last"><summary>Log do último preview</summary>${logBox()}</details>` : ''}`;
  }

  function paint() {
    const fold = document.getElementById('foldPreview');
    if (!fold) return;
    const body = fold.querySelector('.fold-body');
    const el = logEl();
    const keepScroll = el && !nearBottom(el) ? el.scrollTop : null;
    fold.querySelector('#pvSum').innerHTML = summary();
    body.innerHTML = prHtml() + bodyHtml() + lcHtml();
    renderLog();
    if (keepScroll !== null && logEl()) logEl().scrollTop = keepScroll;
    ensureCommits();
  }

  function mount() {
    const r = runs.get(selected);
    const hero = document.querySelector('#detail section.hero');
    if (!r || !hero || document.getElementById('foldPreview')) return;
    const k = previewKey(r);
    if (k !== key) { key = k; st = null; loadError = null; showLog = true; prError = null; lc = null; lcError = null; libRefs = {}; libRefChoice = pendingLibRef = null; source = null; commitsState = {}; commitChoice = null; connect(); refresh(); }
    // Aberto sozinho enquanto há preview deste ticket em andamento.
    const open = openKeys.has(k) || (st && st.phase !== 'idle');
    hero.insertAdjacentHTML('beforeend', `
      <div class="folds pv-folds"><details class="fold" id="foldPreview" ${open ? 'open' : ''}>
        <summary>▶ Preview de Ambiente <span class="sum-right" id="pvSum"></span></summary>
        <div class="fold-body"></div>
      </details></div>`);
    const fold = document.getElementById('foldPreview');
    fold.addEventListener('change', e => {
      const lr = e.target.closest('[data-pvlibref]');
      if (lr) { libRefChoice = lr.value; paint(); return; }
      const cm = e.target.closest('[data-pvcommit]');
      if (cm) { commitChoice = cm.value; return; }
      const sel = e.target.closest('[data-pvdb]');
      if (!sel) return;
      dbChoice = sel.value;
      try { localStorage.setItem('preview.db', dbChoice); } catch {}
    });
    fold.addEventListener('toggle', () => { if (fold.open) openKeys.add(key); else openKeys.delete(key); });
    fold.addEventListener('click', e => {
      if (e.target.closest('[data-pvlibload]')) { libRefs = {}; return loadLibRefs(); }
      if (e.target.closest('[data-pvcommitsload]')) { commitsState = {}; return loadCommits(); }
      const sb = e.target.closest('[data-pvsrc]');
      if (sb && !sb.disabled) { source = sb.dataset.pvsrc; paint(); return; }
      const lg = e.target.closest('[data-pvlibgo]');
      if (lg && !lg.disabled) { libRefChoice = pendingLibRef = lg.dataset.pvlibgo; return act('start'); }
      const a = e.target.closest('[data-pvact]');
      if (a && !a.disabled) return act(a.dataset.pvact);
      const l = e.target.closest('[data-lcact]');
      if (l && !l.disabled) return localCheckout(l.dataset.lcact);
      const pr = e.target.closest('[data-prready]');
      if (pr && !pr.disabled) return markReady();
      if (e.target.closest('[data-pvlog]')) { showLog = !showLog; paint(); }
      if (e.target.closest('[data-pvretry]')) { loadError = null; paint(); refresh(); }
    });
    paint();
  }

  const detail = $('detail');
  new MutationObserver(() => {
    if (!runs.get(selected)) { if (key) { es?.close(); es = null; key = null; st = null; } return; }
    mount();
  }).observe(detail, { childList: true });
  mount();

  setInterval(() => {
    const el = document.getElementById('pvUptime');
    if (el && st?.runningAt) el.textContent = dur(Date.now() - Date.parse(st.runningAt));
  }, 1000);
  // O SSE cobre as mudanças de fase; isto só pega worktree criado/removido com o painel aberto.
  setInterval(() => { if (!document.hidden && key && (!st || st.phase === 'idle')) refresh(); }, 10000);

  const style = document.createElement('style');
  style.textContent = `
    .pv-folds { margin-top: 10px; }
    .pv-lc { border-top: 1px solid var(--line-soft); padding-top: 10px; }
    .pv-db { display: inline-flex; align-items: center; gap: 6px; }
    .pv-db select { font: inherit; max-width: 100%; }
    #pvSum { display: inline-flex; align-items: center; gap: 6px; }
    .pv-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--idle); display: inline-block; }
    .pv-dot.on { background: var(--clear); box-shadow: 0 0 0 3px var(--clear-bg); }
    .pv-dot.off { background: var(--stop); box-shadow: 0 0 0 3px var(--stop-bg); }
    .pv-dot.warn { background: var(--attention); box-shadow: 0 0 0 3px var(--attention-bg); }
    #foldPreview .fold-body { display: grid; gap: 10px; }
    /* Item de grid não encolhe abaixo do conteúdo por padrão: um select longo esticava o fold além da tela. */
    #foldPreview, #foldPreview .fold-body > * { min-width: 0; }
    .pv-commit { flex: 1 1 18rem; min-width: 0; flex-wrap: wrap; }
    .pv-commit select { flex: 1 1 12rem; min-width: 0; width: 100%; max-width: 36rem; text-overflow: ellipsis; }
    .pv-actions { display: flex; align-items: center; gap: 8px 12px; flex-wrap: wrap; }
    .pv-actions a.ghost-btn { text-decoration: none; }
    .pv-actions .ghost-btn:disabled { opacity: .45; cursor: default; }
    .pv-meta { font-size: 13px; color: var(--muted); font-variant-numeric: tabular-nums; }
    .pv-ok { color: var(--ink-2); } .pv-no { color: var(--faint); }
    .pv-state { margin: 0; font-weight: 600; display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
    .pv-state.err { color: var(--stop); }
    .pv-msg { margin: 0; font-size: 13.5px; color: var(--ink-2); overflow-wrap: anywhere; }
    .pv-chip { font: 12px var(--mono); font-weight: 500; border: 1px solid var(--line); border-radius: 6px; padding: 1px 7px; color: var(--muted); }
    .pv-chip.done { color: var(--clear); border-color: var(--clear); }
    .pv-chip.running { color: var(--attention); border-color: var(--attention); }
    .pv-chip.error { color: var(--stop); border-color: var(--stop); }
    .pv-chip.skipped { color: var(--faint); border-style: dashed; }
    /* ~20 linhas visíveis; o resto do ringbuffer (300) rola. */
    .pv-log { margin: 0; max-height: calc(20 * 12px * 1.55 + 16px); overflow: auto; background: var(--c-0b0d13); border: 1px solid var(--border); border-radius: 8px; padding: 8px 10px; font: 12px/1.55 var(--mono); color: var(--ink-2); white-space: pre-wrap; overflow-wrap: anywhere; }
    .pv-log .pv-warn { color: var(--attention); }
    .pv-log .pv-error { color: var(--stop); }
    .pv-log .pv-mgr { font-weight: 600; color: var(--signal); }
    .pv-log .pv-mgr.pv-error { color: var(--stop); }
    .pv-log .pv-empty { color: var(--faint); }
    .pr-status { display: flex; align-items: center; gap: 8px 12px; flex-wrap: wrap; padding: 8px 10px; border: 1px solid var(--line-soft); border-radius: 8px; }
    .pr-status-label { font-size: 13px; color: var(--muted); }
    .pr-status .pr-badge { font-size: 12px; font-weight: 600; border-radius: var(--radius-pill); padding: 0 10px; border: 1px solid currentColor; box-shadow: none; }
    .pr-status .pr-badge.draft { color: var(--state-waiting-fg); background: var(--state-waiting-bg); }
    .pr-status .pr-badge.ready { color: var(--state-running-fg); background: var(--state-running-bg); }
    .pr-status .pr-badge.merged { color: var(--state-done-fg); background: var(--state-done-bg); }
    .pr-status .ghost-btn:disabled { opacity: .45; cursor: default; }
    .pv-last > summary { cursor: pointer; font-size: 13px; color: var(--muted); margin-bottom: 6px; }
  `;
  document.head.appendChild(style);
  window.PreviewPanel = { refresh, key: () => key };
})();
