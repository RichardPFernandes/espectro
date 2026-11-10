// Tela "Este computador" (artboard ThisComputer.dc.html, PRI-333): Reconhecer → Configurar →
// Pronto, sobre dashboard/onboarding.js no servidor. Abre sozinha em tela cheia quando falta
// configuração essencial (primeiro uso); depois fica em Plataforma › Este computador.
// Tudo montado em DOM com textContent; segredo nunca volta do servidor, só "preenchido ou não".
// Script clássico (window.OnboardingView) e módulo CommonJS com as partes puras (testes).
(root => {
  // ---------------------------------------------------------------- partes puras
  const STEPS = [[1, 'Reconhecer', 'ferramentas desta máquina'], [2, 'Configurar', 'pasta, conta e integrações'], [3, 'Pronto', 'testes só de leitura']];
  // Glifo e tom de cada estado do servidor. Ferramenta obrigatória ausente (waiting) aparece
  // como falta (✕), como no artboard; no teste, waiting é aviso (!).
  const TOOL_TONE = { done: ['✓', 'ok'], queued: ['○', 'opt'], waiting: ['✕', 'no'], failed: ['✕', 'no'] };
  const CHECK_TONE = { done: ['✓', 'ok'], queued: ['○', 'opt'], waiting: ['!', 'warn'], failed: ['✕', 'no'], running: ['◐', 'run'] };
  // Para que serve cada ferramenta (texto do artboard). Codex: o watcher ainda não o despacha.
  const TOOL_NOTE = {
    git: 'Usado para worktrees e para ler o repositório.',
    node: 'Roda o watcher e o dashboard.',
    claude: 'Executa os nós plan, implement, review, test e verify.',
    codex: 'O watcher ainda despacha só Claude Code.',
  };
  // Ordem e nomes do artboard; o servidor identifica cada teste pelo id.
  const CHECKS = [['repo', 'Repositório'], ['redmine', 'Redmine'], ['bitbucket', 'Bitbucket'], ['project', 'Contrato de configuração'], ['agent', 'Claude']];

  function stepsModel(step) {
    return STEPS.map(([n, label, sub]) => ({ n, label, sub, current: n === step, done: n < step, mark: n < step ? '✓' : String(n) }));
  }

  // Linha de ferramenta. Pronta/opcional: versão + uso. Ausente: o que o servidor pede (detalhe,
  // dica) no lugar da nota, e o comando, se houver.
  function toolRow(item) {
    const [glyph, tone] = TOOL_TONE[item.state] || TOOL_TONE.queued;
    const asks = item.state === 'waiting' || item.state === 'failed';
    const note = asks ? [item.detail, item.hint].filter(Boolean).join(' ') : TOOL_NOTE[item.id] || item.detail || '';
    return { id: item.id, glyph, tone, name: item.name, req: item.requirement || '', ver: item.version || (item.state === 'done' ? 'versão desconhecida' : 'não encontrado'), note, command: item.command || '' };
  }

  // Linhas do teste na ordem do artboard. Sem resultado: "não testado" (ou "testando…").
  function checkRows(items, { checking = false } = {}) {
    const by = Object.fromEntries((items || []).map(i => [i.id, i]));
    return CHECKS.map(([id, name]) => {
      const it = by[id] || { state: checking ? 'running' : 'queued', detail: checking ? 'testando…' : 'não testado' };
      const [glyph, tone] = CHECK_TONE[it.state] || CHECK_TONE.queued;
      return { id, name, glyph, tone, note: it.detail || '' };
    });
  }

  // Bitbucket num campo só, "workspace/repo" (artboard); o servidor guarda as duas chaves.
  // Só o workspace (sem barra) continua aceito, como antes do campo único.
  const joinRepo = (workspace, slug) => (workspace && slug ? `${workspace}/${slug}` : workspace || (slug ? `/${slug}` : ''));
  function splitRepo(value) {
    const v = String(value || '').trim();
    if (!v) return { ok: true, workspace: '', repoSlug: '' };
    if (/^[^/\s]+$/.test(v)) return { ok: true, workspace: v, repoSlug: '' };
    const m = /^([^/\s]*)\/([^/\s]+)$/.exec(v);
    return m ? { ok: true, workspace: m[1], repoSlug: m[2] } : { ok: false, error: 'Use workspace/repositório, como empresa/app-back.' };
  }
  // Erros do PUT por campo do servidor → campos da tela (workspace e slug viram o campo único).
  function mapFieldErrors(errors) {
    const out = { ...(errors || {}) };
    const bb = out.bitbucketWorkspace || out.bitbucketRepoSlug;
    delete out.bitbucketWorkspace; delete out.bitbucketRepoSlug;
    if (bb) out.bitbucketRepo = bb;
    return out;
  }
  // Valores do formulário a partir do /config. Segredos sempre em branco (em branco = mantém).
  const formFromConfig = c => ({
    repoPath: c.repo.path, claudeAccount: c.agent.account, redmineUrl: c.redmine.url, redmineApiKey: '',
    bitbucketRepo: joinRepo(c.bitbucket.workspace, c.bitbucket.repoSlug), bitbucketApiToken: '',
  });

  // Placeholder de segredo: só diz se há valor salvo.
  const secretPlaceholder = (isSet, saved = 'salva') => (isSet ? `${saved} · deixe em branco para manter` : 'não preenchido');

  // Nota sob a pasta. Sem conferência: explica; conferida: resultado do /api/onboarding/repo.
  const norm = p => String(p || '').trim().replace(/\/+$/, '');
  function pathNote(result, { value = '', active = '', locked = false } = {}) {
    if (locked) return { text: 'Definida pelo launcher do projeto (REPO_PATH no ambiente); mude por lá.', tone: '' };
    if (!result) return { text: 'Repositório onde o watcher cria os worktrees. Se a pasta vier do launcher do projeto, ela aparece travada aqui.', tone: '' };
    if (!result.ok) return { text: `✕ ${result.reason}`, tone: 'no' };
    const later = norm(value) && norm(value) !== norm(active) ? ' Vale depois de reiniciar.' : '';
    return { text: `✓ Repositório Git.${later}`, tone: 'ok' };
  }

  const option = a => (a.id === 'default' ? `~/.claude · ${a.label || 'padrão'}` : `${a.id} · ${a.label}`);

  const pure = { STEPS, CHECKS, stepsModel, toolRow, checkRows, joinRepo, splitRepo, mapFieldErrors, formFromConfig, secretPlaceholder, pathNote, option };
  if (typeof module !== 'undefined' && module.exports) { module.exports = pure; return; }

  // ---------------------------------------------------------------- estado
  const DISMISS_KEY = 'espectro.onboarding.dismissed';
  let step = 1, tools = null, config = null, check = null, error = null;
  let loadingTools = false, scanned = false, saving = false, checking = false, checkingPath = false;
  let form = null, fieldErrors = {}, repoResult = null;
  let node = null; // mesmo nó entre refreshes do shell: não derruba foco nem digitação

  const el = (tag, text, className, attrs) => {
    const n = document.createElement(tag);
    if (text != null) n.textContent = text;
    if (className) n.className = className;
    for (const [k, v] of Object.entries(attrs || {})) if (v != null && v !== false) n.setAttribute(k, v === true ? '' : v);
    return n;
  };
  async function call(path, opts) {
    const res = await fetch(path, opts);
    const body = await res.json().catch(() => ({}));
    if (!res.ok) { const e = new Error(body.error || `HTTP ${res.status}`); e.body = body; throw e; }
    return body;
  }
  const json = (method, body) => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });

  // Repinta a tela inteira mantendo o campo com foco e o cursor dentro dele.
  function paint() {
    if (!node) return;
    const act = document.activeElement;
    const focusId = node.contains(act) ? act.id : null;
    let sel = null;
    try { sel = focusId ? [act.selectionStart, act.selectionEnd] : null; } catch { /* tipo sem seleção */ }
    node.replaceChildren(...build());
    const back = focusId && document.getElementById(focusId);
    if (back && node.contains(back)) {
      back.focus();
      try { if (sel && sel[0] != null) back.setSelectionRange(sel[0], sel[1]); } catch { /* tipo sem seleção */ }
    }
  }

  async function loadTools(manual) {
    if (loadingTools) return;
    loadingTools = true; error = null; paint();
    try { tools = await call('/api/onboarding/tools'); if (manual === true) scanned = true; } catch (e) { error = e.message; }
    loadingTools = false; paint();
  }
  // Uma carga por vez: duas respostas reatribuindo o form apagariam o que já foi digitado.
  let configLoad = null;
  function loadConfig() {
    if (!configLoad) {
      configLoad = (async () => {
        try { config = await call('/api/onboarding/config'); error = null; } catch (e) { error = e.message; }
        if (config && !form) form = formFromConfig(config);
        configLoad = null;
        return config;
      })();
    }
    return configLoad;
  }
  async function save() {
    if (saving || !form) return;
    fieldErrors = {}; error = null;
    const bb = splitRepo(form.bitbucketRepo);
    if (!bb.ok) { fieldErrors.bitbucketRepo = bb.error; paint(); node?.querySelector('[aria-invalid="true"]')?.focus(); return; }
    saving = true; paint();
    const body = {
      repoPath: form.repoPath, claudeAccount: form.claudeAccount, redmineUrl: form.redmineUrl, redmineApiKey: form.redmineApiKey,
      bitbucketWorkspace: bb.workspace, bitbucketRepoSlug: bb.repoSlug, bitbucketApiToken: form.bitbucketApiToken,
    };
    if (config.repo.locked) delete body.repoPath;
    if (!body.claudeAccount) delete body.claudeAccount;
    try {
      config = await call('/api/onboarding/config', json('PUT', body));
      form = formFromConfig(config); // tela mostra o que ficou gravado
      saving = false; step = 3; paint(); runCheck();
    } catch (e) {
      saving = false; error = e.message;
      fieldErrors = mapFieldErrors(e.body?.errors);
      paint();
      node?.querySelector('[aria-invalid="true"]')?.focus();
    }
  }
  async function runCheck() {
    if (checking) return;
    checking = true; check = null; error = null; paint();
    try { check = await call('/api/onboarding/check', json('POST')); } catch (e) { error = e.message; }
    checking = false; paint();
  }
  async function checkPath() {
    if (checkingPath || !form) return;
    checkingPath = true; paint();
    try { repoResult = await call(`/api/onboarding/repo?path=${encodeURIComponent(form.repoPath || '')}`); } catch (e) { repoResult = { ok: false, reason: e.message }; }
    checkingPath = false; paint();
  }
  // Troca de etapa leva o foco ao título do cartão (leitor de tela ouve a etapa nova).
  async function go(n) {
    step = n; error = null;
    if (n === 2 && !config) { paint(); await loadConfig(); }
    paint();
    node?.querySelector('.onb-card h2')?.focus();
  }
  function finish() {
    try { localStorage.setItem(DISMISS_KEY, '1'); } catch { /* sem storage: só não lembra */ }
    document.body.classList.remove('onboarding');
    step = 1; paint(); // na volta por Plataforma › Este computador, sem o texto de primeiro uso
    window.Views?.setView('runs');
  }

  // ---------------------------------------------------------------- partes
  function intro() {
    const first = document.body.classList.contains('onboarding');
    const head = el('header', null, 'onb-intro');
    head.append(
      el('span', first ? 'primeiro uso · abre sozinho quando falta configuração' : 'plataforma · este computador', 'onb-eyebrow'),
      el('h1', 'Preparar este computador', 'onb-title'),
      el('p', 'O Espectro roda o watcher aqui. Esta tela confere o que a máquina tem, guarda a configuração mínima e testa cada peça só lendo. Nada é instalado e nenhum login é feito por aqui.'));
    return head;
  }
  function stepsNav() {
    const ol = el('ol', null, 'onb-steps', { 'aria-label': 'Etapas' });
    for (const p of stepsModel(step)) {
      const b = el('button', null, `onb-step${p.current ? ' cur' : ''}${p.done ? ' done' : ''}`, { type: 'button', 'aria-current': p.current ? 'step' : 'false' });
      const text = el('span', null, 'onb-step-text');
      text.append(el('span', p.label, 'onb-step-label'), el('span', p.sub, 'onb-step-sub'));
      b.append(el('span', p.mark, 'onb-step-n', { 'aria-hidden': 'true' }), text);
      b.addEventListener('click', () => go(p.n));
      const li = el('li'); li.append(b); ol.append(li);
    }
    return ol;
  }
  function section(id, title, aside) {
    const s = el('section', null, 'onb-card', { 'aria-labelledby': id });
    const head = el('div', null, 'onb-card-head');
    head.append(el('h2', title, null, { id, tabindex: '-1' }));
    if (aside) head.append(aside);
    s.append(head);
    return s;
  }
  const btn = (text, onClick, cls, attrs) => { const b = el('button', text, cls, { type: 'button', ...attrs }); b.addEventListener('click', onClick); return b; };
  const alertBox = text => el('p', text, 'onb-alert', { role: 'alert' });
  function line(row, extra) {
    const div = el('div', null, 'onb-line');
    div.append(el('span', row.glyph, `onb-glyph ${row.tone}`, { 'aria-hidden': 'true' }));
    const text = el('span', null, 'onb-line-text');
    const name = el('span', row.name, 'onb-line-name');
    if (row.req) name.append(' ', el('span', row.req, 'onb-line-req'));
    text.append(name, el('span', row.note, 'onb-line-note'));
    div.append(text);
    if (extra) div.append(extra);
    return div;
  }

  // ---------------------------------------------------------------- etapa 1
  function stepTools() {
    const s = section('onbToolsH', 'Ferramentas encontradas',
      btn(`↻ ${loadingTools ? 'Procurando…' : scanned ? 'Procurado agora' : 'Procurar de novo'}`, () => loadTools(true), 'onb-btn-ghost', { disabled: loadingTools }));
    s.setAttribute('aria-busy', loadingTools ? 'true' : 'false');
    if (!tools) s.append(el('p', loadingTools ? 'Procurando…' : 'Sem resultado ainda.', 'onb-empty'));
    else for (const t of tools.items) {
      const r = toolRow(t);
      const row = line(r, el('span', r.ver, `onb-line-ver ${r.tone}`));
      row.setAttribute('aria-label', `${r.name}, ${r.req}: ${r.ver}. ${r.note}`);
      if (r.command) {
        const box = el('span', null, 'onb-cmd');
        const copy = btn('Copiar comando', async () => {
          try { await navigator.clipboard.writeText(r.command); copy.textContent = '✓ Copiado'; }
          catch { copy.textContent = 'Copie à mão'; }
          setTimeout(() => { copy.textContent = 'Copiar comando'; }, 2000);
        }, 'onb-btn-ghost sm');
        box.append(el('code', r.command), copy);
        row.append(box);
      }
      s.append(row);
    }
    return s;
  }

  // ---------------------------------------------------------------- etapa 2
  function input(id, field, { type = 'text', mono, placeholder, readonly, autocomplete = 'off' } = {}) {
    const inp = el('input', null, `onb-input${mono ? ' mono' : ''}`, {
      id, type, placeholder, readonly: !!readonly, autocomplete, spellcheck: 'false',
      'aria-invalid': fieldErrors[field] ? 'true' : null, 'aria-describedby': fieldErrors[field] ? `${id}Err` : null,
    });
    inp.value = form[field] || '';
    inp.addEventListener('input', () => {
      form[field] = inp.value;
      if (field === 'repoPath' && repoResult) {
        repoResult = null; // nota volta a explicar; sem repintar (não mexe no cursor)
        const n = document.getElementById('onbPathNote');
        if (n) { const p = pathNote(null); n.textContent = p.text; n.className = 'onb-note'; }
      }
    });
    return inp;
  }
  const err = (id, field) => (fieldErrors[field] ? el('span', fieldErrors[field], 'onb-note no', { id: `${id}Err` }) : null);
  function labeled(text, opt, id, field, inputOpts) {
    const lab = el('label', text, 'onb-label', { for: id });
    if (opt) lab.append(' ', el('span', opt, 'onb-opt'));
    const wrap = el('div', null, 'onb-cell');
    wrap.append(lab, input(id, field, inputOpts));
    const e = err(id, field); if (e) wrap.append(e);
    return wrap;
  }
  function stepConfig() {
    const s = section('onbCfgH', 'Configuração mínima');
    s.classList.add('cfg');
    if (!config || !form) {
      if (configLoad || !error) s.append(el('p', 'Carregando a configuração…', 'onb-empty'));
      else s.append(btn('Tentar de novo', () => go(2), 'onb-btn'));
      return s;
    }
    const f = el('form', null, 'onb-form', { novalidate: true });
    f.addEventListener('submit', e => { e.preventDefault(); save(); });

    const repo = el('div', null, 'onb-field');
    const row = el('div', null, 'onb-row');
    row.append(input('onbPath', 'repoPath', { mono: true, readonly: config.repo.locked }),
      btn(checkingPath ? 'Conferindo…' : 'Conferir pasta', checkPath, 'onb-btn', { disabled: checkingPath || config.repo.locked }));
    const note = fieldErrors.repoPath ? { text: fieldErrors.repoPath, tone: 'no' } : pathNote(repoResult, { value: form.repoPath, active: config.repo.active, locked: config.repo.locked });
    repo.append(el('label', 'Pasta do projeto', 'onb-label', { for: 'onbPath' }), row,
      el('span', note.text, `onb-note${note.tone ? ` ${note.tone}` : ''}`, { id: fieldErrors.repoPath ? 'onbPathErr' : 'onbPathNote', role: 'status' }));
    f.append(repo);

    if (config.agent.accounts.length) {
      const acc = el('div', null, 'onb-field');
      const sel = el('select', null, 'onb-input', { id: 'onbAccount', 'aria-invalid': fieldErrors.claudeAccount ? 'true' : null });
      for (const a of config.agent.accounts) {
        const o = el('option', option(a)); o.value = a.id; o.selected = a.id === form.claudeAccount; sel.append(o);
      }
      sel.addEventListener('change', () => { form.claudeAccount = sel.value; });
      acc.append(el('label', 'Conta do Claude usada pelo watcher', 'onb-label', { for: 'onbAccount' }), sel);
      const e = err('onbAccount', 'claudeAccount'); if (e) acc.append(e);
      f.append(acc);
    }

    const grid = el('div', null, 'onb-grid');
    grid.append(
      labeled('Endereço do Redmine', null, 'onbRedmineUrl', 'redmineUrl', { type: 'url' }),
      labeled('Chave de API do Redmine', null, 'onbRedmineKey', 'redmineApiKey', { type: 'password', autocomplete: 'new-password', placeholder: secretPlaceholder(config.redmine.apiKeySet, 'salva') }),
      labeled('Bitbucket · workspace/repo', 'opcional', 'onbBbRepo', 'bitbucketRepo'),
      labeled('Token do Bitbucket', 'opcional', 'onbBbToken', 'bitbucketApiToken', { type: 'password', autocomplete: 'new-password', placeholder: secretPlaceholder(config.bitbucket.apiTokenSet, 'salvo') }));
    f.append(grid,
      el('p', 'Onde fica cada coisa: a pasta vai para o .env do Espectro e vale depois de reiniciar; Redmine e Bitbucket vão para o .env do projeto, as mesmas chaves que o watcher lê. Nenhuma chave volta para a tela depois de salva.', 'onb-where'));
    const actions = el('div', null, 'onb-actions');
    const submit = el('button', saving ? 'Salvando…' : 'Salvar e testar', 'onb-btn-primary', { type: 'submit', disabled: saving });
    actions.append(submit);
    f.append(actions);
    s.append(f);
    return s;
  }

  // ---------------------------------------------------------------- etapa 3
  function stepReady() {
    const s = section('onbChkH', 'Testes só de leitura', el('span', 'a sondagem do Claude gasta um pouco da cota', 'onb-aside'));
    s.setAttribute('aria-busy', checking ? 'true' : 'false');
    for (const r of checkRows(check?.items, { checking })) s.append(line(r));
    const foot = el('div', null, 'onb-chk-foot');
    const restart = check?.restartRequired || config?.repo.restartRequired;
    foot.append(restart ? el('span', 'A pasta mudou: reinicie o dashboard para o watcher usar a nova.', 'onb-restart', { role: 'status' }) : el('span', null, 'onb-restart'),
      btn(checking ? 'Testando…' : 'Testar de novo', runCheck, 'onb-btn', { disabled: checking }),
      btn('Abrir o Espectro', finish, 'onb-btn-primary'));
    s.append(foot);
    return s;
  }

  function build() {
    const main = el('div', null, 'onb-main');
    main.append(intro(), stepsNav());
    if (error) main.append(alertBox(error));
    main.append(step === 1 ? stepTools() : step === 2 ? stepConfig() : stepReady());
    return [main];
  }
  function render() {
    if (!node) { node = el('section', null, 'onb', { 'aria-label': 'Preparar este computador' }); paint(); }
    return node;
  }
  function load() {
    if (!tools && !loadingTools) loadTools();
    if (!config) loadConfig().then(paint);
  }

  root.OnboardingView = { render, load };

  // Primeira vez: falta repositório ou Redmine → abre em tela cheia (uma vez por navegador,
  // até alguém fechar com "Abrir o Espectro").
  let dismissed = false;
  try { dismissed = localStorage.getItem(DISMISS_KEY) === '1'; } catch { /* sem storage */ }
  // Aberta direto por #computador: o shell montou antes deste script existir.
  if (root.Views?.current() === 'computador') { load(); root.Views.refresh(); }
  loadConfig().then(c => {
    if (!c?.needsSetup || dismissed) return paint();
    document.body.classList.add('onboarding');
    root.Views?.setView('computador');
  });
})(typeof window !== 'undefined' ? window : globalThis);
