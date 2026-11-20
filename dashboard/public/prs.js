// Tela "Pull requests" (chave prs), no formato do artboard PullRequests do design Espectro (PRI-326):
// indicadores que filtram, abas 1–4, lista à esquerda, detalhe do PR no meio e revisores/números à
// direita. Fontes: GET /api/prs (PRs do dono do token no Bitbucket + PRs registrados nos runs ativos,
// com o estado do state.json) e GET /api/prs/:id (diffstat por arquivo). Única ação: a aprovação
// inline que já existia (POST /api/prs/:id/approve). Elemento do artboard sem dado no app fica fora
// (lista "Pendente de implementação" na issue PRI-326).
//
// Dois modos, como ui-kit.js: em Node exporta só a lógica pura (prs-ui.test.js); no navegador monta a
// tela e se pluga em views.js via window.PrsView. Usa os globais de index.html/views.js: api(), esc(),
// ago(), when(), toast(), $().
(root => {
  const DAY_H = 24;
  const circ = (x, y, r) => `M${x - r} ${y}a${r} ${r} 0 1 0 ${2 * r} 0a${r} ${r} 0 1 0 ${-2 * r} 0`;
  const ICON_BASE = circ(6, 6, 2.5) + circ(6, 18, 2.5);
  // Estado = glifo/ícone + cor (tom). SUPERSEDED e UNKNOWN não existem no artboard: entram no prompt
  // de atualização do canvas; até lá, tom neutro e ícone sem a terceira ponta.
  const STATES = {
    OPEN: { label: 'Aberto', tone: 'running', icon: ICON_BASE + circ(18, 18, 2.5) + 'M6 8.5v7M18 15.5V9a3 3 0 0 0-3-3h-4M13 3l-3 3 3 3' },
    DRAFT: { label: 'Draft', tone: 'draft', icon: ICON_BASE + circ(18, 18, 2.5) + 'M6 8.5v7M18 6v.01M18 11v.01' },
    MERGED: { label: 'Mergeado', tone: 'done', icon: ICON_BASE + circ(18, 12, 2.5) + 'M6 8.5v7M8 7.5c2 3 4.5 4.5 7.5 4.5' },
    DECLINED: { label: 'Recusado', tone: 'failed', icon: ICON_BASE + 'M6 8.5v7M15.5 13.5l5 5M20.5 13.5l-5 5' },
    SUPERSEDED: { label: 'Substituído', tone: 'waiting', icon: ICON_BASE + 'M6 8.5v7M15 18h6' },
    UNKNOWN: { label: 'Estado desconhecido', tone: 'queued', icon: ICON_BASE + 'M6 8.5v7' },
  };

  function stateKey(pr) {
    if (pr.state === 'OPEN') return pr.draft ? 'DRAFT' : 'OPEN';
    return ['MERGED', 'DECLINED', 'SUPERSEDED'].includes(pr.state) ? pr.state : 'UNKNOWN';
  }
  const isOpen = pr => pr.state === 'OPEN';
  const isClosed = pr => ['MERGED', 'DECLINED', 'SUPERSEDED'].includes(pr.state);
  // Número de PR se repete entre repos irmãos: a chave é "<repo>#<id>".
  const keyOf = pr => `${pr.repo || ''}#${pr.id}`;
  const known = pr => Array.isArray(pr.reviewers); // null = não consultado (PR só do run)
  const approvedN = pr => (known(pr) ? pr.reviewers.filter(r => r.approved).length : 0);

  // "x de y aprovações" da linha e do cabeçalho de Revisores. Sem consulta: sem medição, nunca zero.
  function revSummary(pr) {
    if (!known(pr)) return { text: 'aprovações sem medição', tone: 'muted' };
    const revs = pr.reviewers;
    if (!revs.length) return { text: 'sem revisores', tone: 'muted' };
    if (revs.some(r => r.changesRequested)) return { text: 'mudanças pedidas', tone: 'failed' };
    const ok = approvedN(pr);
    return { text: `${ok} de ${revs.length} aprovações`, tone: ok === revs.length ? 'done' : 'muted' };
  }

  // Horas sem nenhuma aprovação desde a abertura (barra "sem review há X"). 0 = não se aplica.
  function waitHours(pr, now = Date.now()) {
    if (!isOpen(pr) || !known(pr) || !pr.reviewers.length || approvedN(pr) > 0) return 0;
    const t = Date.parse(pr.createdOn);
    return t ? Math.max(0, Math.floor((now - t) / 3600000)) : 0;
  }
  const waitLabel = h => (h >= DAY_H ? `${Math.floor(h / DAY_H)} d ${h % DAY_H} h` : `${h} h`);
  // Escala do artboard: barra cheia em 72 h; âmbar a partir de 24 h, vermelho a partir de 48 h.
  const waitTone = h => (h >= 48 ? 'failed' : h >= DAY_H ? 'waiting' : 'running');
  const waitWidth = h => `${Math.min(100, Math.round((h / 72) * 100))}%`;

  const TABS = [
    ['open', 'Abertos', isOpen],
    ['review', 'Para você', pr => pr.canApprove === true],
    ['prisma', 'Do Espectro', pr => !!pr.linkedRun],
    ['closed', 'Encerrados', isClosed],
  ];
  // Filtros dos cards. Valem só sobre PR aberto (como no artboard) e trocam a aba para "Abertos".
  const KF = {
    wait: ['Esperando review', pr => isOpen(pr) && known(pr) && pr.reviewers.some(r => !r.approved)],
    conflict: ['Com conflito', pr => isOpen(pr) && pr.hasConflicts === true],
    prisma: ['Abertos pelo Espectro', pr => isOpen(pr) && !!pr.linkedRun],
  };

  // Os quatro indicadores. value é texto: "sem medição" quando não há como medir (PRIN-003).
  // PR aberto que ficou fora da contagem (revisores/conflito não consultados) é dito no hint.
  const unmeasured = n => (n > 0 ? ` · ${n} sem medição` : '');
  function kpis(prs) {
    const open = prs.filter(isOpen);
    const reviewKnown = open.filter(known);
    const mine = prs.filter(p => p.canApprove === true).length;
    const conflictKnown = open.filter(p => p.hasConflicts === true || p.hasConflicts === false);
    const fromRuns = open.filter(p => p.linkedRun);
    return [
      { key: 'wait', label: 'Esperando review', tone: 'waiting', filter: true,
        value: open.length && !reviewKnown.length ? 'sem medição' : String(prs.filter(KF.wait[1]).length),
        hint: `${mine} com você${unmeasured(open.length - reviewKnown.length)}`, source: 'Bitbucket · revisores dos PRs abertos' },
      { key: 'conflict', label: 'Com conflito', tone: 'failed', filter: true,
        value: open.length && !conflictKnown.length ? 'sem medição' : String(prs.filter(KF.conflict[1]).length),
        hint: `merge-tree local${unmeasured(open.length - conflictKnown.length)}`, source: 'git merge-tree local entre origem e destino' },
      { key: 'merge', label: 'Tempo até merge', tone: 'flat', filter: false, value: 'sem medição', hint: '',
        source: 'a lista do Bitbucket não traz a data do merge' },
      { key: 'prisma', label: 'Abertos pelo Espectro', tone: 'link', filter: true, value: String(fromRuns.length),
        hint: `${fromRuns.filter(p => p.draft).length} em draft`, source: 'PR registrado no state.json de um run' },
    ];
  }

  // Lista de uma aba, com o filtro do card por cima, mais recente primeiro.
  function poolOf(prs, tab, kf) {
    const fn = (TABS.find(([k]) => k === tab) || TABS[0])[2];
    const t = p => Date.parse(p.updatedOn || p.stateCheckedAt) || 0;
    return prs.filter(fn).filter(p => !KF[kf] || KF[kf][1](p)).sort((a, b) => t(b) - t(a));
  }

  // "Pronto para merge?": só as linhas com dado. tone: ok | warn | fail | pend.
  function readiness(pr) {
    const k = stateKey(pr);
    const dst = pr.targetBranch || 'o destino';
    const approvals = () => {
      if (!known(pr)) return ['Aprovações', 'sem medição · revisores não consultados', 'pend'];
      const revs = pr.reviewers;
      if (!revs.length) return ['Aprovações', 'sem revisores', 'warn'];
      const asked = revs.filter(r => r.changesRequested);
      if (asked.length) return ['Aprovações', `${asked.map(r => r.displayName).join(', ')} pediu mudanças`, 'fail'];
      const ok = approvedN(pr), missing = revs.filter(r => !r.approved).map(r => r.displayName);
      return ['Aprovações', `${ok} de ${revs.length}${missing.length ? ` · falta ${missing.join(', ')}` : ''}`,
        ok === revs.length ? 'ok' : ok ? 'warn' : 'fail'];
    };
    const row = ([key, v, tone]) => ({ key, v, tone });
    if (k === 'MERGED') return [approvals(), ['Merge', `em ${dst}`, 'ok']].map(row);
    if (k === 'DECLINED') return [['Revisão', 'recusado no Bitbucket', 'fail']].map(row);
    if (k === 'SUPERSEDED') return [['Estado', 'substituído por outro PR no Bitbucket', 'warn']].map(row);
    if (k === 'UNKNOWN') return [['Estado', 'desconhecido · o run não registrou o estado deste PR', 'pend']].map(row);
    const conflict = pr.hasConflicts === true
      ? [`Conflito com ${dst}`, (pr.conflictFiles || []).join(', ') || 'arquivos não informados', 'fail']
      : pr.hasConflicts === false ? [`Conflito com ${dst}`, 'nenhum', 'ok'] : [`Conflito com ${dst}`, 'não calculado', 'pend'];
    const out = [approvals(), conflict];
    if (!pr.linkedRun?.ticketId) out.push(['Ticket', 'sem ticket vinculado', 'pend']);
    return out.map(row);
  }

  // Faixa no topo do detalhe: o motivo mais forte para olhar este PR agora.
  function banner(pr, now = Date.now()) {
    const k = stateKey(pr);
    if ((k === 'OPEN' || k === 'DRAFT') && pr.hasConflicts === true) {
      const files = (pr.conflictFiles || []).join(', ');
      return { tone: 'fail', text: `Conflito com ${pr.targetBranch || 'o destino'}${files ? ` em ${files}` : ''} (merge-tree local)` };
    }
    if (k === 'DECLINED') return { tone: 'fail', text: 'Recusado no Bitbucket' };
    if (k === 'SUPERSEDED') return { tone: 'warn', text: 'Substituído por outro PR no Bitbucket' };
    if (k === 'UNKNOWN') return { tone: 'warn', text: 'Estado desconhecido: o run não registrou o estado deste PR' };
    const h = waitHours(pr, now);
    if (h >= 7 * DAY_H) return { tone: 'warn', text: `Sem nenhum review há ${Math.floor(h / DAY_H)} dias` };
    return null;
  }

  // Nota abaixo das ações: o que vale para este PR, sem prometer o que o app não faz.
  function footnote(pr, fmtAgo = () => '') {
    if (pr.source === 'run') {
      const checked = pr.stateCheckedAt ? `, conferido ${fmtAgo(pr.stateCheckedAt)}` : '';
      return `Estado registrado no run ${pr.linkedRun?.taskId || ''}${checked}. Revisores e conflito não foram consultados no Bitbucket.`;
    }
    if (pr.canApprove) return 'A aprovação vai para o Bitbucket em seu nome.';
    if (pr.state === 'MERGED') return 'Ciclo encerrado no Bitbucket.';
    if (isOpen(pr)) return 'Só um revisor designado que ainda não aprovou pode aprovar daqui; você não é um deles.';
    return 'Encerrado no Bitbucket.';
  }

  // Idade no cabeçalho do detalhe. A lista do Bitbucket não traz a hora do merge: "atualizado".
  function ageText(pr, fmtAgo = () => '') {
    if (pr.source === 'run') return pr.stateCheckedAt ? `conferido ${fmtAgo(pr.stateCheckedAt)}` : '';
    if (isOpen(pr) && pr.createdOn) return `aberto ${fmtAgo(pr.createdOn)}`;
    return pr.updatedOn ? `atualizado ${fmtAgo(pr.updatedOn)}` : '';
  }

  const model = { STATES, stateKey, keyOf, revSummary, waitHours, waitLabel, waitTone, waitWidth, TABS, KF, kpis, poolOf, readiness, banner, footnote, ageText };
  if (typeof module !== 'undefined' && module.exports) { module.exports = model; return; }

  // ================================================================== navegador
  const UI = root.UIKit;
  const st = {
    data: null, loading: false, error: null, loadedOnce: false, tries: 0, lastTryAt: null,
    tab: 'open', kf: null, sel: undefined, busy: new Set(), detail: new Map(), scroll: {},
  };

  async function load() {
    st.loading = true;
    window.Views?.refresh();
    try {
      st.data = await api('/api/prs');
      st.error = null; st.tries = 0;
    } catch (e) {
      st.error = e.message; st.tries += 1;
    }
    st.lastTryAt = new Date();
    st.loading = false; st.loadedOnce = true;
    window.Views?.refresh();
  }

  // Diffstat por arquivo (GET /api/prs/:id), uma vez por PR selecionado. PR só do run não tem.
  async function loadDetail(pr) {
    const k = keyOf(pr);
    const c = st.detail.get(k);
    // Refaz quando o PR mudou no Bitbucket (updatedOn) ou quando a última tentativa falhou há mais de 60 s.
    const fresh = c && c.updatedOn === pr.updatedOn && (!c.error || Date.now() - c.at < 60000);
    if (pr.source === 'run' || fresh || c?.loading) return;
    st.detail.set(k, { loading: true, updatedOn: pr.updatedOn, data: c?.data });
    try {
      st.detail.set(k, { data: await api(`/api/prs/${pr.id}?repo=${encodeURIComponent(pr.repo || '')}`), updatedOn: pr.updatedOn, at: Date.now() });
    } catch (e) {
      st.detail.set(k, { error: e.message, updatedOn: pr.updatedOn, at: Date.now() });
    }
    window.Views?.refresh();
  }

  async function approve(pr) {
    if (st.busy.has(keyOf(pr))) return;
    st.busy.add(keyOf(pr));
    window.Views?.refresh();
    try {
      await api(`/api/prs/${pr.id}/approve?repo=${encodeURIComponent(pr.repo || '')}`, { method: 'POST' });
      toast('PR aprovado ✓');
      st.detail.delete(keyOf(pr));
      await load();
    } catch (e) {
      toast(`Falha ao aprovar: ${e.message}`);
    }
    st.busy.delete(keyOf(pr));
    window.Views?.refresh();
  }

  const all = () => st.data?.prs || [];
  const pool = () => poolOf(all(), st.tab, st.kf);
  // sel undefined = primeiro da lista (o artboard abre com um PR selecionado); null = detalhe fechado (Esc).
  function current() {
    const p = pool();
    if (st.sel === null) return null;
    return p.find(x => keyOf(x) === st.sel) || p[0] || null;
  }

  const icon = (key, cls = 'prs-icon') =>
    `<svg class="${cls}" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${STATES[key].icon}"/></svg>`;
  const pill = key => `<span class="prs-state t-${STATES[key].tone}">${esc(STATES[key].label)}</span>`;
  const titleOf = pr => pr.title || `${pr.repo || 'PR'} #${pr.id}`;
  const label = text => `<h2 class="prs-label">${text}</h2>`;
  const GLYPH = { ok: '✓', warn: '‖', fail: '✕', pend: '○' };

  function kcardHtml(k) {
    if (!k.filter) {
      return `<div class="kcard kcard-static no-spark" title="${esc(`Fonte: ${k.source}`)}"><span class="kcard-body"><span class="kcard-label">${esc(k.label)}</span>`
        + `<span class="kcard-row"><span class="kcard-value num">${esc(k.value)}</span>${k.hint ? `<span class="kcard-delta">${esc(k.hint)}</span>` : ''}</span></span></div>`;
    }
    const on = st.kf === k.key;
    const n = all().filter(KF[k.key][1]).length;
    const html = UI.kcard({ key: k.key, label: k.label, value: k.value, delta: k.hint, source: k.source, tip: `Mostrar só: ${KF[k.key][0]}`,
      pressed: on, hint: on ? 'filtrando · clique para limpar' : `ver ${n} ${n === 1 ? 'PR' : 'PRs'} →` });
    return html.replace('class="kcard', `data-tone="${k.tone}" class="kcard`);
  }

  function rowHtml(pr, cur) {
    const k = stateKey(pr), rs = revSummary(pr), h = waitHours(pr);
    const on = cur && keyOf(cur) === keyOf(pr);
    // "+N −M" do artboard: a lista do Bitbucket não traz linhas; aparece quando o diffstat do PR já foi consultado.
    const ds = st.detail.get(keyOf(pr))?.data?.diffStat;
    return `<div class="prs-row${on ? ' on' : ''}" data-state="${k.toLowerCase()}">
      <button type="button" data-pr-pick="${esc(keyOf(pr))}" aria-current="${on ? 'true' : 'false'}">
        ${icon(k)}
        <span class="prs-meta mono"><span>#${esc(pr.id)}</span><span class="prs-repo">· ${esc(pr.repo || '')}</span>${ds ? `<span class="prs-lines num"><span class="t-done">+${esc(ds.linesAdded)}</span> <span class="t-failed">−${esc(ds.linesRemoved)}</span></span>` : ''}</span>
        <span class="prs-title">${esc(titleOf(pr))}</span>
        <span class="prs-facts">${pill(k)}<span class="prs-rev t-${rs.tone}">${esc(rs.text)}</span>${pr.author ? `<span class="prs-author">${esc(pr.author)}</span>` : ''}</span>
        ${h ? `<span class="prs-wait"><span class="prs-wait-bar" aria-hidden="true"><span class="t-${waitTone(h)}" style="width:${waitWidth(h)}"></span></span><span class="prs-wait-l num t-${waitTone(h)}">sem review há ${esc(waitLabel(h))}</span></span>` : ''}
      </button>
    </div>`;
  }

  function detailHtml(pr) {
    const k = stateKey(pr), rs = revSummary(pr), ban = banner(pr);
    const d = st.detail.get(keyOf(pr));
    const ds = d?.data?.diffStat;
    const age = ageText(pr, ago);
    const t = pr.linkedRun;
    const ticket = t?.ticketId
      ? (t.ticketUrl ? `<a href="${esc(t.ticketUrl)}" target="_blank" rel="noopener noreferrer">· #${esc(t.ticketId)}</a>`
        : `<span class="muted" title="Redmine não configurado">· #${esc(t.ticketId)}</span>`) : '';
    const diffUrl = pr.url ? `${pr.url}/diff` : '';
    const busy = st.busy.has(keyOf(pr));
    const canApprove = pr.canApprove === true && isOpen(pr);
    const sem = '<span class="muted" title="sem medição">sem medição</span>';
    const pending = d?.loading ? '<span class="muted">carregando…</span>' : d?.error ? `<span class="muted" title="${esc(d.error)}">sem medição</span>` : sem;
    const files = ds?.files || [];
    const filesHtml = ds
      ? (files.length ? `<ul class="prs-box">${files.map(f => `<li><a class="prs-file mono" href="${esc(diffUrl)}" target="_blank" rel="noopener noreferrer"><span class="prs-file-n">${esc(f.path || '?')}</span><span class="num t-done">+${esc(f.added)}</span><span class="num t-failed">−${esc(f.removed)}</span></a></li>`).join('')}</ul>`
        : '<p class="prs-note">Nenhum arquivo alterado.</p>')
      : `<p class="prs-note">${pr.source === 'run' ? 'Diffstat não consultado: PR conhecido só pelo run.' : d?.error ? `Não deu para consultar o diffstat: ${esc(d.error)}` : 'Carregando o diffstat…'}</p>`;
    return `<main class="prs-detail-pane prs-scroll" data-prs-scroll="detail" aria-labelledby="pr-h">
      ${UI.drawerClose('pr-close')}
      <div class="prs-detail">
        <div class="prs-dhead">
          <span class="prs-dmeta mono">${pill(k)}<span>#${esc(pr.id)} · ${esc(pr.repo || '')}</span>${t ? '<span class="prs-tag">Espectro</span>' : ''}</span>
          <h1 id="pr-h">${esc(titleOf(pr))}</h1>
          <span class="prs-branch">${pr.sourceBranch ? `<code>${esc(pr.sourceBranch)}</code><span aria-hidden="true">→</span><span class="sr-only">para</span><code>${esc(pr.targetBranch || '?')}</code>` : ''}
            ${pr.author || age ? `<span class="muted">· ${[pr.author, age].filter(Boolean).map(esc).join(' · ')}</span>` : ''}${ticket}
            ${diffUrl ? `<a class="prs-btn-s" href="${esc(diffUrl)}" target="_blank" rel="noopener noreferrer">Ver diff</a>` : ''}</span>
        </div>
        ${ban ? `<div class="prs-banner t-${ban.tone}" role="status"><span aria-hidden="true">${ban.tone === 'fail' ? '✕' : '‖'}</span><span>${esc(ban.text)}</span></div>` : ''}
        <section aria-labelledby="rd-h">${label('Pronto para merge?').replace('<h2', '<h2 id="rd-h"')}
          <ul class="prs-box prs-ready">${readiness(pr).map(c => `<li class="t-${c.tone}"><span class="prs-g" aria-hidden="true">${GLYPH[c.tone]}</span><span class="prs-rk">${esc(c.key)}</span><span class="prs-rv">${esc(c.v)}</span></li>`).join('')}</ul>
        </section>
        ${canApprove ? `<div class="prs-actions"><div class="prs-actions-row"><button type="button" class="prs-btn primary" data-pr-approve="${esc(keyOf(pr))}" ${busy ? 'disabled aria-busy="true"' : ''}>${busy ? 'Aprovando…' : 'Aprovar'}${busy ? '' : '<kbd>A</kbd>'}</button></div></div>` : ''}
        <p class="prs-foot">${esc(footnote(pr, ago))}</p>
        <section aria-labelledby="fl-h"><span class="prs-sechead">${label(`Arquivos · ${ds ? esc(ds.filesChanged) : '—'}`).replace('<h2', '<h2 id="fl-h"')}${diffUrl ? `<a href="${esc(diffUrl)}" target="_blank" rel="noopener noreferrer">Ver diff completo →</a>` : ''}</span>
          ${filesHtml}
        </section>
      </div>
    </main>
    <aside class="prs-rp prs-scroll" aria-label="Revisores e números">
      <section aria-labelledby="rv-h">${label(`Revisores · ${esc(rs.text)}`).replace('<h2', '<h2 id="rv-h"')}
        ${known(pr) ? pr.reviewers.map(r => {
          const s = r.changesRequested ? ['no', 'pediu mudanças'] : r.approved ? ['ok', 'aprovou'] : ['wait', 'pendente'];
          return `<div class="prs-revr"><span class="prs-ini r-${s[0]}" aria-hidden="true">${esc(initials(r.displayName))}</span><span class="prs-revn">${esc(r.displayName)}</span><span class="prs-revs r-${s[0]}">${s[1]}</span></div>`;
        }).join('') || '<p class="prs-note">Sem revisores designados.</p>' : '<p class="prs-note">Revisores não consultados: PR conhecido só pelo run.</p>'}
      </section>
      <section aria-labelledby="nm-h">${label('Números').replace('<h2', '<h2 id="nm-h"')}
        <dl class="prs-nums num">
          <dt>Linhas</dt><dd>${ds ? `<span class="t-done">+${esc(ds.linesAdded)}</span> <span class="t-failed">−${esc(ds.linesRemoved)}</span>` : pending}</dd>
          <dt>Arquivos</dt><dd>${ds ? esc(ds.filesChanged) : pending}</dd>
          <dt>Comentários</dt><dd>${pr.commentCount != null ? esc(pr.commentCount) : sem}</dd>
        </dl>
        ${t?.taskId ? `<a href="#run/${encodeURIComponent(t.taskId)}" data-pr-run="${esc(t.taskId)}">Aberto por um run · ver o run</a>` : ''}
      </section>
    </aside>`;
  }

  function initials(name) {
    return String(name || '?').trim().split(/\s+/).slice(0, 2).map(w => w[0]?.toUpperCase() || '').join('') || '?';
  }

  // Estados de interface do artboard (carregando, erro, vazio, desconhecido).
  function estHtml(kind) {
    const B = { carregando: ['◐', 'CARREGANDO', 'running'], erro: ['✕', 'ERRO', 'failed'], vazio: ['○', 'VAZIO', 'queued'], desconhecido: ['‖', 'ATTENTION_REQUIRED', 'waiting'] }[kind];
    const lbl = { carregando: 'Carregando os pull requests', erro: 'Erro ao carregar os pull requests', vazio: 'Nenhum PR aberto', desconhecido: 'Estado desconhecido: Bitbucket' }[kind];
    const tryNote = st.lastTryAt ? `${st.lastTryAt.toLocaleTimeString('pt-BR')} · ${st.tries}ª tentativa${st.tries > 1 ? ' seguida' : ''}` : '—';
    const actions = `<div class="prs-est-actions"><button type="button" class="prs-btn primary" data-pr-reload ${st.loading ? 'disabled aria-busy="true"' : ''}>${st.loading ? 'Tentando…' : 'Tentar novamente'}</button><a href="#computador">Ver o conector em Este computador</a></div>`;
    let body = '';
    if (kind === 'carregando') {
      body = `<p role="status" class="prs-est-msg">Carregando os pull requests…</p><div class="prs-est-skel" aria-hidden="true">${[70, 52, 64, 46, 74, 58].map(w =>
        `<div><span class="prs-sk" style="width:${w - 22}%"></span><span class="prs-sk prs-sk-r"></span><span class="prs-sk prs-sk-t" style="width:${w}%"></span></div>`).join('')}</div>`;
    } else if (kind === 'erro') {
      body = `<div role="alert" class="prs-est-card"><h2><span aria-hidden="true" class="t-failed">✕</span>Não foi possível carregar os pull requests</h2>
        <dl><dt>Causa</dt><dd>${esc(st.error)}</dd><dt>Preservado</dt><dd>Nenhuma aprovação foi enviada.</dd><dt>Tentativa</dt><dd class="num">${esc(tryNote)}</dd></dl>${actions}</div>`;
    } else if (kind === 'vazio') {
      body = `<div role="status" class="prs-est-empty"><h2>Nenhum PR aberto</h2><p>Quando um run chegar ao nó pr, o pull request aparece aqui com revisores e conflito.</p><a class="prs-btn primary" href="#runs">Ver runs a caminho do PR</a></div>`;
    } else {
      const last = st.data?.fetched_at ? `último resultado conhecido ${ago(st.data.fetched_at)}` : 'sem resultado anterior';
      body = `<div role="alert" class="prs-est-card prs-est-unk"><h2>Bitbucket não respondeu</h2>
        <p>${esc(st.error)}. Estado, revisões e conflitos podem ter mudado no Bitbucket.</p>
        <ul>${[['Estado dos PRs', last], ['Revisões pedidas a você', 'N/A até a fonte voltar'], ['Conflito com o destino', 'não confirmado']].map(([n, note]) =>
          `<li><span class="prs-unk-n">${esc(n)}</span><span class="prs-state t-queued"><span aria-hidden="true">?</span>UNKNOWN_STATUS</span><span class="prs-unk-note">${esc(note)}</span></li>`).join('')}</ul>
        <p class="prs-note">Até a fonte responder, nada aqui aparece como saudável, pendente ou zero.</p>${actions}</div>`;
    }
    return `<section class="prs-est prs-scroll" aria-label="${esc(lbl)}" aria-busy="${kind === 'carregando'}"><div class="prs-est-in">
      <span class="prs-est-head mono"><span class="prs-state t-${B[2]}"><span aria-hidden="true">${B[0]}</span>${B[1]}</span><span>fonte: Bitbucket</span></span>${body}</div></section>`;
  }

  // Chip "N esperam sua revisão" e a fonte, no topo da tela (o artboard põe os dois no cabeçalho).
  function topbarHtml() {
    if (!st.data) return '';
    const n = all().filter(p => p.canApprove === true).length;
    const at = st.data.fetched_at;
    // Fonte sem resposta: o chip some (a contagem antiga não vale) e a fonte diz quando respondeu por último.
    return (st.error ? '' : `<span class="prs-top-chip num">${n} ${n === 1 ? 'espera' : 'esperam'} sua revisão</span>`)
      + `<span class="prs-top-src mono"${at ? ` title="${esc(when(at))}"` : ''}><span class="prs-dot${st.error ? ' off' : ''}" aria-hidden="true"></span>Bitbucket · ${st.error ? 'respondeu por último' : 'consultado'} ${esc(at ? ago(at) : '—')}</span>`;
  }
  function paintTopbar() {
    let el = document.getElementById('prsTop');
    if (!el) {
      el = document.createElement('div');
      el.id = 'prsTop'; el.className = 'prs-top';
      document.querySelector('.topbar .crumbs-top')?.after(el);
    }
    const on = document.body.dataset.view === 'prs';
    el.hidden = !on;
    const html = on ? topbarHtml() : '';
    if (el.innerHTML !== html) el.innerHTML = html;
  }

  function render() {
    if (!st.loadedOnce && !st.loading) load();
    queueMicrotask(afterPaint);
    const shell = (inner, count) => `<div class="prs-screen">${inner}
      <footer class="prs-statusbar mono"><span>${count == null ? '' : `${count} PRs nesta aba · `}aprovações vão ao Bitbucket em seu nome</span><span class="prs-keys">⌘K buscar · J K navegar · 1–4 aba · A aprovar · Esc fechar</span></footer></div>`;
    if (!st.data) return shell(estHtml(st.error ? 'erro' : 'carregando'));
    if (st.error) return shell(estHtml('desconhecido'));
    if (!all().length) return shell(estHtml('vazio'));
    const prs = all(), p = pool(), cur = current();
    if (cur && st.sel !== null) loadDetail(cur);
    const warn = (st.data.warnings || []).length
      ? `<p class="prs-warn" role="status"><span aria-hidden="true">‖</span>Repos não consultados: ${esc(st.data.warnings.join('; '))}</p>` : '';
    const tabs = TABS.map(([id, lbl, fn], i) =>
      `<button type="button" role="tab" class="prs-tab" data-pr-tab="${id}" aria-selected="${st.tab === id}"><kbd>${i + 1}</kbd>${esc(lbl)} <span class="num">${prs.filter(fn).length}</span></button>`).join('');
    const list = `<section class="prs-side${cur ? ' lp' : ''}" aria-label="Lista de pull requests">
        <div class="prs-kpis" aria-label="Indicadores">${kpis(prs).map(kcardHtml).join('')}</div>
        <div class="prs-tabsbar"><div role="tablist" aria-label="Filtro">${tabs}</div>${KF[st.kf] ? UI.filterChip({ label: KF[st.kf][0], act: 'pr-clear-kf' }) : ''}</div>
        ${warn}
        <div class="prs-scroll prs-list" data-prs-scroll="list">${p.map(pr => rowHtml(pr, cur)).join('') || '<p class="prs-none">Nenhum item para este filtro.</p>'}</div>
      </section>`;
    return shell(`<div class="prs-panes" tabindex="0" aria-label="Pull requests. J e K navegam, 1 a 4 trocam a aba.">${list}${cur ? detailHtml(cur) : ''}</div>`, p.length);
  }

  // views.js troca o HTML inteiro a cada evento ao vivo: devolve a rolagem das colunas e o foco.
  function afterPaint() {
    paintTopbar();
    const view = $('view');
    for (const el of view.querySelectorAll('[data-prs-scroll]')) el.scrollTop = st.scroll[el.dataset.prsScroll] || 0;
    // Só devolve o foco que o repaint derrubou (ficou no body); foco na paleta ou no menu fica onde está.
    const a = document.activeElement;
    if (st.focus && (!a || a === document.body)) view.querySelector(st.focus)?.focus();
  }
  const view = $('view');
  view.addEventListener('scroll', e => { const n = e.target.dataset?.prsScroll; if (n) st.scroll[n] = e.target.scrollTop; }, true);
  view.addEventListener('focusout', e => {
    if (e.relatedTarget && !view.contains(e.relatedTarget)) st.focus = null;
  });
  view.addEventListener('focusin', e => {
    if (document.body.dataset.view !== 'prs') return;
    const el = e.target;
    const attr = ['data-pr-pick', 'data-pr-tab', 'data-kcard', 'data-pr-approve'].find(a => el.hasAttribute?.(a));
    st.focus = attr ? `[${attr}="${CSS.escape(el.getAttribute(attr))}"]` : el.classList?.contains('prs-panes') ? '.prs-panes' : null;
  });

  function pick(key) { st.sel = key; st.scroll.detail = 0; window.Views?.refresh(); }
  function setTab(id) { st.tab = id; st.sel = undefined; window.Views?.refresh(); }

  view.addEventListener('click', e => {
    if (document.body.dataset.view !== 'prs') return;
    if (e.target.closest('[data-pr-reload]')) { load(); return; }
    const run = e.target.closest('[data-pr-run]');
    if (run) { e.preventDefault(); window.Views?.openRun(run.dataset.prRun); return; }
    const b = e.target.closest('[data-pr-pick]');
    if (b) { pick(b.dataset.prPick); return; }
    const t = e.target.closest('[data-pr-tab]');
    if (t) { setTab(t.dataset.prTab); return; }
    const k = e.target.closest('[data-kcard]');
    if (k && KF[k.dataset.kcard]) { const id = k.dataset.kcard; st.kf = st.kf === id ? null : id; st.tab = 'open'; st.sel = undefined; window.Views?.refresh(); return; }
    if (e.target.closest('[data-act="pr-clear-kf"]')) { st.kf = null; window.Views?.refresh(); return; }
    if (e.target.closest('[data-act="pr-close"]')) { st.sel = null; st.focus = '.prs-panes'; window.Views?.refresh(); return; }
    const a = e.target.closest('[data-pr-approve]');
    if (a) { const pr = all().find(p => keyOf(p) === a.dataset.prApprove); if (pr) approve(pr); }
  });

  // Teclado do artboard, só com o foco dentro da lista/detalhe. Fase de captura em window: o atalho
  // global 1–N (ux.js, captura em document) trocaria de tela antes; aqui 1–4 trocam a aba.
  window.addEventListener('keydown', e => {
    if (document.body.dataset.view !== 'prs' || !e.target.closest?.('.prs-panes')) return;
    if (e.metaKey || e.ctrlKey || e.altKey || /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
    const k = e.key;
    if (/^[1-4]$/.test(k)) { e.preventDefault(); e.stopImmediatePropagation(); st.focus = '.prs-panes'; setTab(TABS[Number(k) - 1][0]); return; }
    const cur = current();
    if (k === 'Escape' && cur) { e.preventDefault(); st.sel = null; st.focus = '.prs-panes'; window.Views?.refresh(); return; }
    if ((k === 'a' || k === 'A') && cur?.canApprove && cur.state === 'OPEN') { e.preventDefault(); approve(cur); return; }
    if (k === 'j' || k === 'k') {
      e.preventDefault();
      const order = pool().map(keyOf);
      const next = order[UI.step(cur ? order.indexOf(keyOf(cur)) : -1, k === 'j' ? 1 : -1, order.length)];
      if (next) { st.focus = `[data-pr-pick="${CSS.escape(next)}"]`; pick(next); }
    }
  }, true);

  new MutationObserver(paintTopbar).observe(document.body, { attributes: true, attributeFilter: ['data-view'] });

  // Auto-refresh 60s, só com a aba "prs" ativa e a página visível (Page Visibility API).
  function tick() {
    if (!document.hidden && document.body.dataset.view === 'prs') load();
  }
  setInterval(tick, 60000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) tick(); });

  window.PrsView = { render, load };
  window.Views?.refresh();
})(typeof window !== 'undefined' ? window : globalThis);
