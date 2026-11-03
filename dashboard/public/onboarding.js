// Tela "Este computador": Reconhecer → Configurar → Pronto (dashboard/onboarding.js no
// servidor). Abre sozinha em tela cheia quando falta configuração essencial; depois fica em
// Plataforma › Este computador. Tudo montado em DOM com textContent; segredo nunca volta do
// servidor, só "preenchido ou não".
(() => {
  const STEPS = ['Reconhecer', 'Configurar', 'Pronto'];
  const GLYPH = { done: '✓', queued: '○', waiting: '‖', failed: '✕', running: '◐' };
  const DISMISS_KEY = 'espectro.onboarding.dismissed';
  let step = 1, tools = null, config = null, check = null, error = null;
  let loadingTools = false, saving = false, checking = false;
  let form = null, fieldErrors = {}, repoHint = null, repoTimer = null;
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

  function paint() {
    if (!node) return;
    const focusId = document.activeElement?.id;
    node.replaceChildren(...build());
    if (focusId && node.contains(document.getElementById(focusId))) document.getElementById(focusId).focus();
  }

  async function loadTools() {
    if (loadingTools) return;
    loadingTools = true; error = null; paint();
    try { tools = await call('/api/onboarding/tools'); } catch (e) { error = e.message; }
    loadingTools = false; paint();
  }
  async function loadConfig() {
    try { config = await call('/api/onboarding/config'); } catch (e) { error = e.message; }
    form = config && {
      repoPath: config.repo.path, claudeAccount: config.agent.account,
      redmineUrl: config.redmine.url, redmineApiKey: '',
      bitbucketWorkspace: config.bitbucket.workspace, bitbucketRepoSlug: config.bitbucket.repoSlug, bitbucketApiToken: '',
    };
    repoHint = config ? (config.repo.git.ok ? { ok: true, text: '✓ Repositório Git encontrado' } : { ok: false, text: `✕ ${config.repo.git.reason}` }) : null;
    return config;
  }
  async function save() {
    if (saving) return;
    saving = true; fieldErrors = {}; error = null; paint();
    const body = { ...form };
    if (config.repo.locked) delete body.repoPath;
    if (!body.claudeAccount) delete body.claudeAccount;
    try {
      config = await call('/api/onboarding/config', json('PUT', body));
      form.redmineApiKey = ''; form.bitbucketApiToken = '';
      saving = false; step = 3; paint(); runCheck();
    } catch (e) {
      saving = false; fieldErrors = e.body?.errors || {}; error = e.message; paint();
      node?.querySelector('[aria-invalid="true"]')?.focus();
    }
  }
  async function runCheck() {
    if (checking) return;
    checking = true; check = null; error = null; paint();
    try { check = await call('/api/onboarding/check', json('POST')); } catch (e) { error = e.message; }
    checking = false; paint();
  }
  function validateRepo(value) {
    clearTimeout(repoTimer);
    repoTimer = setTimeout(async () => {
      try {
        const r = await call(`/api/onboarding/repo?path=${encodeURIComponent(value)}`);
        repoHint = r.ok ? { ok: true, text: '✓ Repositório Git encontrado' } : { ok: false, text: `✕ ${r.reason}` };
      } catch { repoHint = null; }
      const hint = document.getElementById('onbRepoHint');
      if (hint && repoHint) { hint.textContent = repoHint.text; hint.className = `onb-hint ${repoHint.ok ? 'ok' : 'err'}`; }
    }, 300);
  }
  function go(n) { step = n; error = null; paint(); node?.querySelector('h1')?.focus(); }
  function finish() {
    try { localStorage.setItem(DISMISS_KEY, '1'); } catch { /* sem storage: só não lembra */ }
    document.body.classList.remove('onboarding');
    window.Views?.setView('runs');
  }

  // ---------------------------------------------------------------- partes
  function header() {
    const head = el('header', null, 'onb-head');
    const brand = el('div', null, 'onb-brand');
    brand.innerHTML = '<svg width="24" height="24" viewBox="0 0 48 48" aria-hidden="true"><path d="M6.1 15A20 20 0 0 1 41.9 15Z" style="fill: var(--accent)"/><path d="M4.9 18H43.1A20 20 0 0 1 43.1 30H4.9A20 20 0 0 1 4.9 18Z" style="fill: var(--state-done)"/><path d="M6.1 33H41.9A20 20 0 0 1 6.1 33Z" style="fill: var(--state-waiting)"/></svg>';
    brand.append(el('b', 'espectro'), el('span', '· Configurar este computador'));
    const ol = el('ol', null, 'onb-steps', { 'aria-label': 'Etapas' });
    STEPS.forEach((label, i) => {
      const n = i + 1;
      ol.append(el('li', `${n < step ? '✓' : n} ${label}`, n < step ? 'done' : '', { 'aria-current': n === step ? 'step' : null }));
    });
    const skip = el('button', 'Agora não', 'btn onb-skip', { type: 'button' });
    skip.addEventListener('click', finish);
    head.append(brand, ol, skip);
    return head;
  }
  function intro(title, text) {
    const box = el('div', null, 'onb-intro');
    box.append(el('h1', title, 't-display', { tabindex: '-1' }), el('p', text));
    return box;
  }
  function row(item, role) {
    const li = el('li', null, `onb-row ${item.state}`);
    li.append(el('span', GLYPH[item.state] || '○', `onb-glyph ${item.state}`, { 'aria-hidden': 'true' }), el('span', item.name, 'onb-name'));
    const detail = el('span', null, 'onb-detail');
    detail.append(el('span', item.detail, item.state === 'waiting' ? '' : 'mono'));
    if (item.command) detail.append(el('code', item.command));
    if (item.hint) detail.append(el('span', item.hint, 'onb-hint'));
    li.append(detail);
    if (role) li.append(el('span', role, 'onb-role'));
    if (item.command) {
      const copy = el('button', 'Copiar comando', 'btn', { type: 'button' });
      copy.addEventListener('click', async () => {
        try { await navigator.clipboard.writeText(item.command); copy.textContent = 'Copiado'; }
        catch { copy.textContent = 'Copie à mão'; }
        setTimeout(() => { copy.textContent = 'Copiar comando'; }, 2000);
      });
      li.append(copy);
    }
    li.setAttribute('aria-label', `${item.name}: ${{ done: 'pronto', queued: 'opcional ou pendente', waiting: 'pede você', failed: 'falhou', running: 'testando' }[item.state] || ''}. ${item.detail}`);
    return li;
  }
  function footer(...children) {
    const foot = el('footer', null, 'onb-foot');
    const inner = el('div', null, 'onb-foot-in');
    inner.append(...children.filter(Boolean));
    foot.append(inner);
    return foot;
  }
  function button(text, onClick, { primary, push, disabled } = {}) {
    const b = el('button', text, `btn lg${primary ? ' primary' : ''}${push ? ' push' : ''}`, { type: 'button', disabled: !!disabled });
    b.addEventListener('click', onClick);
    return b;
  }
  const alertBox = text => { const b = el('div', null, 'onb-box failed', { role: 'alert' }); b.append(el('p', text)); return b; };

  // ---------------------------------------------------------------- etapa 1
  function stepTools() {
    const main = el('main', null, 'onb-main');
    main.append(intro('O que este computador já tem', 'Procuramos as ferramentas que o Espectro usa. A verificação é local; nada sai daqui.'));
    if (error) main.append(alertBox(error));
    const list = el('ul', null, 'onb-list panel', { 'aria-busy': loadingTools ? 'true' : null });
    if (!tools) list.append(el('li', loadingTools ? 'Procurando…' : 'Sem resultado ainda.', 'onb-row empty'));
    else for (const t of tools.items) list.append(row(t, t.role));
    main.append(list, el('p', 'Falta alguma ferramenta ou a versão é antiga? O Espectro mostra o comando; quem instala é você, no seu terminal.', 'onb-note'));
    const s = tools?.summary;
    return [main, footer(
      s ? el('span', `${s.done} pronto${s.done === 1 ? '' : 's'} · ${s.optional} opcional · ${s.waiting} pede${s.waiting === 1 ? '' : 'm'} você`, 'mono', { role: 'status' }) : null,
      button('Verificar de novo', loadTools, { push: true, disabled: loadingTools }),
      button('Continuar', async () => { if (!config) await loadConfig(); go(2); }, { primary: true }),
    )];
  }

  // ---------------------------------------------------------------- etapa 2
  function input(id, field, { label, type = 'text', mono, placeholder, readonly, autocomplete = 'off' }) {
    const wrap = el('div', null, 'onb-sub');
    if (label) wrap.append(el('label', label, null, { for: id }));
    const inp = el('input', null, `onb-input${mono ? ' mono' : ''}`, {
      id, type, placeholder, readonly: !!readonly, autocomplete, spellcheck: 'false',
      'aria-invalid': fieldErrors[field] ? 'true' : null, 'aria-describedby': fieldErrors[field] ? `${id}Err` : null,
    });
    inp.value = form[field] || '';
    inp.addEventListener('input', () => { form[field] = inp.value; if (field === 'repoPath') validateRepo(inp.value); });
    wrap.append(inp);
    if (fieldErrors[field]) wrap.append(el('span', fieldErrors[field], 'onb-hint err', { id: `${id}Err` }));
    return wrap;
  }
  function fieldset(legend, ...children) {
    const fs = el('fieldset', null, 'onb-field');
    fs.append(el('legend', legend), ...children.filter(Boolean));
    return fs;
  }
  function stepConfig() {
    const main = el('main', null, 'onb-main');
    main.append(intro('Algumas escolhas e pronto', 'Dá para mudar tudo depois em Plataforma › Este computador.'));
    if (error) main.append(alertBox(error));
    if (!config) { main.append(el('p', 'Carregando a configuração…', 'onb-note')); return [main]; }
    const f = el('form', null, 'onb-form', { novalidate: true });
    f.addEventListener('submit', e => { e.preventDefault(); save(); });

    const repo = fieldset('Pasta do repositório',
      input('onbRepo', 'repoPath', { mono: true, placeholder: '~/[pasta do projeto]', readonly: config.repo.locked }),
      fieldErrors.repoPath ? null : el('span', config.repo.locked ? 'Definida pelo launcher do projeto (REPO_PATH).' : repoHint?.text || '', `onb-hint ${config.repo.locked ? '' : repoHint?.ok ? 'ok' : 'err'}`, { id: 'onbRepoHint', role: 'status' }));
    const seg = el('div', null, 'onb-seg', { role: 'group', 'aria-label': 'Agente padrão' });
    seg.append(el('button', 'Claude Code', null, { type: 'button', 'aria-pressed': 'true' }),
      el('button', 'Codex · ainda não suportado', null, { type: 'button', 'aria-pressed': 'false', disabled: true }));
    let account = null;
    if (config.agent.accounts.length > 1) {
      account = el('div', null, 'onb-sub');
      const sel = el('select', null, 'onb-input', { id: 'onbAccount', 'aria-invalid': fieldErrors.claudeAccount ? 'true' : null });
      for (const a of config.agent.accounts) {
        const o = el('option', a.id === 'default' ? 'Conta padrão (~/.claude)' : `${a.label} (${a.id})`);
        o.value = a.id; o.selected = a.id === form.claudeAccount; sel.append(o);
      }
      sel.addEventListener('change', () => { form.claudeAccount = sel.value; });
      account.append(el('label', 'Conta do Claude', null, { for: 'onbAccount' }), sel);
    }
    const agent = fieldset('Agente padrão', seg, account,
      el('span', 'Usa a conta já conectada no Claude Code. O Espectro não guarda a chave.', 'onb-hint'));
    const redmine = fieldset('Onde ficam as tarefas · Redmine',
      input('onbRedmineUrl', 'redmineUrl', { label: 'Endereço', type: 'url', placeholder: 'https://[redmine da empresa]' }),
      input('onbRedmineKey', 'redmineApiKey', { label: 'Chave de API', type: 'password', mono: true, autocomplete: 'new-password',
        placeholder: config.redmine.apiKeySet ? '•••••••• salva · deixe em branco para manter' : 'Minha conta › Chave de acesso à API' }),
      el('span', 'A chave fica no .env do projeto e nunca aparece na tela.', 'onb-hint'));
    const pair = el('div', null, 'onb-pair');
    pair.append(input('onbBbWs', 'bitbucketWorkspace', { label: 'Workspace', mono: true, placeholder: '[workspace]' }),
      input('onbBbSlug', 'bitbucketRepoSlug', { label: 'Repositório', mono: true, placeholder: '[repositório]' }));
    const bitbucket = fieldset('Pull requests · Bitbucket (opcional)', pair,
      input('onbBbToken', 'bitbucketApiToken', { label: 'Token de API', type: 'password', mono: true, autocomplete: 'new-password',
        placeholder: config.bitbucket.apiTokenSet ? '•••••••• salvo · deixe em branco para manter' : '[token do Bitbucket]' }),
      el('span', 'Sem token, o Espectro funciona; só o status dos PRs fica sem dados.', 'onb-hint'));
    f.append(repo, agent, redmine, bitbucket);
    main.append(f);
    return [main, footer(
      button('Voltar', () => go(1)),
      button(saving ? 'Salvando…' : 'Salvar e testar', save, { primary: true, push: true, disabled: saving }),
    )];
  }

  // ---------------------------------------------------------------- etapa 3
  function stepReady() {
    const main = el('main', null, 'onb-main');
    const ready = check?.ready;
    main.append(intro(checking ? 'Testando cada peça…' : ready ? 'Este computador está pronto' : 'Falta pouco',
      'Testamos cada peça só com leitura: nada é gravado no repositório, no Redmine nem no Bitbucket. O teste do agente gasta uma chamada mínima da cota do Claude.'));
    if (error) main.append(alertBox(error));
    if (check?.restartRequired || config?.repo.restartRequired) {
      const box = el('div', null, 'onb-box waiting', { role: 'status' });
      box.append(el('span', 'Reinicie o Espectro para usar a pasta nova', 't-heading'),
        el('p', 'A pasta foi salva, mas este processo ainda lê a anterior. Pare o Espectro (Ctrl+C no terminal) e rode npm start de novo na pasta dashboard.'));
      main.append(box);
    }
    const list = el('ul', null, 'onb-list panel', { 'aria-busy': checking ? 'true' : null });
    const items = check?.items || ['Repositório', 'Agente · Claude Code', 'Tracker · Redmine', 'PRs · Bitbucket', 'Configuração do projeto']
      .map(name => ({ name, state: checking ? 'running' : 'queued', detail: checking ? 'testando…' : 'não testado' }));
    for (const it of items) list.append(row(it));
    main.append(list);
    const next = el('div', null, 'onb-box');
    next.append(el('span', 'E agora?', 't-heading'),
      el('p', 'Nenhuma run começa sozinha. Você escolhe uma tarefa no Espectro e acompanha cada gate. Para refazer esta verificação: Plataforma › Este computador.'));
    main.append(next);
    return [main, footer(
      button('Voltar', () => go(2)),
      button('Testar de novo', runCheck, { push: true, disabled: checking }),
      button('Abrir o Espectro', finish, { primary: true }),
    )];
  }

  function build() {
    const parts = step === 1 ? stepTools() : step === 2 ? stepConfig() : stepReady();
    return [header(), ...parts];
  }
  function render() {
    if (!node) { node = el('section', null, 'onb', { 'aria-label': 'Configurar este computador' }); paint(); }
    return node;
  }
  function load() {
    if (!tools && !loadingTools) loadTools();
    if (!config) loadConfig().then(paint);
  }

  window.OnboardingView = { render, load };

  // Primeira vez: falta repositório ou Redmine → abre em tela cheia (uma vez por navegador,
  // até alguém fechar com "Agora não" ou "Abrir o Espectro").
  let dismissed = false;
  try { dismissed = localStorage.getItem(DISMISS_KEY) === '1'; } catch { /* sem storage */ }
  // Aberta direto por #computador: o shell montou antes deste script existir.
  if (window.Views?.current() === 'computador') { load(); window.Views.refresh(); }
  loadConfig().then(c => {
    if (!c?.needsSetup || dismissed) return paint();
    document.body.classList.add('onboarding');
    window.Views?.setView('computador');
  });
})();
