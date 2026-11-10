// ticket-board.js — lógica pura da tela Tickets (artboard Tickets.dc.html), sem DOM.
// Junta as três fontes que contam a história de um ticket:
//   Redmine   — /api/tickets (abertos atribuídos a mim) e /api/runs/:id/ticket (ticket de run)
//   Runs      — /api/runs (state.json de cada run)
//   Bitbucket — estado do PR (/api/runs/:id/pr, senão o gravado no state.json)
// e deriva o que a tela desenha: anel de status, barras de prioridade, trilha de 7 segmentos,
// selos de PR, divergências e o veredito "Três fontes, uma história?".
// Regras de divergência portadas de views.js > alertsFor ("Tickets e PRs"), mesmas mensagens.
// Nada aqui inventa número: ausente fica null e a tela escreve "—" / "sem medição".
// Script clássico (window.TicketBoard) e módulo CommonJS (testes).
(root => {
  const NODES = ['fetch_ticket', 'plan', 'implement', 'review', 'test', 'verify', 'commit'];
  const DAY = 86400000;
  const CLOSED_RE = /conclu|encerr|fechad|closed|rejeit|cancel/i;
  const isQaRejected = s => typeof s === 'string' && ['recusa qa', 'recusada qa'].includes(s.trim().toLowerCase());

  // Anel do status (forma + cor), na ordem dos grupos do artboard. Nome que não casa com
  // nenhuma faixa fica no fim, com anel neutro: o workflow do Redmine varia por instalação.
  const STATUS_STYLES = [
    { re: /recusa|recusada/i, c: 'var(--state-waiting)', bs: 'solid', fill: 'var(--state-waiting)' },
    { re: /desenvolvimento|andamento|progress/i, c: 'var(--accent)', bs: 'solid', fill: 'conic-gradient(var(--accent) 0 50%, transparent 0)' },
    { re: /revis|review/i, c: 'var(--c-b79cff)', bs: 'solid', fill: 'conic-gradient(var(--c-b79cff) 0 70%, transparent 0)' },
    { re: /teste|qa|homolog|aguard|merge/i, c: 'var(--c-b79cff)', bs: 'solid', fill: 'conic-gradient(var(--c-b79cff) 0 88%, transparent 0)' },
    { re: /aprovad/i, c: 'var(--text-secondary)', bs: 'solid', fill: 'transparent' },
    { re: /^nov|^new/i, c: 'var(--muted)', bs: 'dashed', fill: 'transparent' },
    { re: CLOSED_RE, c: 'var(--state-done)', bs: 'solid', fill: 'var(--state-done)' },
  ];
  const UNKNOWN_STYLE = { c: 'var(--muted)', bs: 'dotted', fill: 'transparent' };
  function statusStyle(name) {
    if (!name) return { rank: STATUS_STYLES.length + 1, ...UNKNOWN_STYLE };
    const i = STATUS_STYLES.findIndex(s => s.re.test(name));
    if (i < 0) return { rank: STATUS_STYLES.length, c: 'var(--text-secondary)', bs: 'solid', fill: 'transparent' };
    const { re, ...st } = STATUS_STYLES[i];
    return { rank: i, ...st };
  }

  // 3 barras de altura crescente. Urgente/Imediata = 3 vermelhas; Alta = 3 âmbar; Normal = 2;
  // Baixa = 1. Nome fora da escala: barras apagadas (nunca chuta nível).
  function prioBars(name) {
    const p = String(name || '');
    const lvl = /urgente|imediata/i.test(p) ? 4 : /alta/i.test(p) ? 3 : /normal/i.test(p) ? 2 : /baixa/i.test(p) ? 1 : 0;
    return [1, 2, 3].map(i => ({
      h: `${3 + i * 3}px`,
      c: lvl === 4 ? 'var(--state-failed)' : (lvl && i <= lvl ? (lvl === 3 ? 'var(--state-waiting-fg)' : 'var(--text-secondary)') : 'var(--state-queued)'),
    }));
  }

  // Ícone do tipo: Bug e Melhoria como no artboard; outro tipo conhecido ganha um ponto neutro.
  const TRACKERS = {
    bug: { c: 'var(--state-failed-fg)', icon: 'M8 9h8v6a4 4 0 0 1-8 0zM12 9V6M8 13H4M20 13h-4M8 17l-3 2M16 17l3 2M9.5 4.5 11 6M14.5 4.5 13 6' },
    feat: { c: 'var(--state-running-fg)', icon: 'M12 19V5M5 12l7-7 7 7' },
    other: { c: 'var(--muted)', icon: 'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8z' },
  };
  function trackerKind(name) {
    if (!name) return null;
    if (/bug|defeito|erro|falha/i.test(name)) return 'bug';
    if (/melhoria|feature|funcionalidade|evolu/i.test(name)) return 'feat';
    return 'other';
  }

  const isDone = r => r.kind === 'completed' || r.kind === 'has_pr';
  const nodeCmd = n => (n === 'fetch_ticket' ? 'fetch-ticket' : n);

  // Run vinculado: o primeiro com kind diferente de 'completed' (lista do mais recente), senão o
  // mais recente — mesma regra de server.js > linkedRunFor (has_pr conta como não concluído lá).
  function linkedRun(rs) {
    const list = [...(rs || [])].sort((a, b) => (Date.parse(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0));
    return list.find(r => r.kind !== 'completed') || list[0] || null;
  }

  function nodeIndex(r) {
    let i = NODES.indexOf(r.node);
    if (i < 0) {
      const h = (r.state?.history || []).filter(n => NODES.includes(n));
      i = h.length ? NODES.indexOf(h[h.length - 1]) : 0;
    }
    return i;
  }

  // Trilha de 7 segmentos (fetch_ticket → commit) + rótulo e tom do run.
  // tone: run | human | fail | done | queued | none.
  const SEG = { done: 'var(--state-done)', run: 'var(--accent)', human: 'var(--state-waiting)', fail: 'var(--state-failed)', no: 'var(--state-queued)' };
  const RUN_FG = { run: 'var(--state-running-fg)', human: 'var(--state-waiting-fg)', fail: 'var(--state-failed-fg)', done: 'var(--state-done-fg)', queued: 'var(--muted)', none: 'var(--muted)' };
  function runTrail(r) {
    const segs = tone => NODES.map((_, i) => {
      if (tone === 'none') return SEG.no;
      if (tone === 'done') return SEG.done;
      if (i < at) return SEG.done;
      if (i === at) return SEG[tone] || SEG.no;
      return SEG.no;
    });
    let at = 0;
    if (!r) return { tone: 'none', label: 'sem run', segs: segs('none'), fg: RUN_FG.none, state: 'nenhum' };
    if (r.status === 'unknown') return { tone: 'none', label: 'sem estado', segs: segs('none'), fg: RUN_FG.none, state: 'sem estado' };
    if (isDone(r)) return { tone: 'done', label: 'concluído', segs: segs('done'), fg: RUN_FG.done, state: 'concluído' };
    at = nodeIndex(r);
    const node = nodeCmd(NODES[at]);
    let tone, label, state;
    if (r.qaRejected) { tone = 'human'; label = 'recusa QA'; state = 'parado'; }
    else if (r.status === 'running') { tone = 'run'; label = `${node} ${at + 1}/7`; state = 'rodando'; }
    else if (r.status === 'needs_human_review' || r.status === 'awaiting_approval') { tone = 'human'; label = 'aguardando você'; state = 'parado'; }
    else if (r.status === 'failed') { tone = 'fail'; label = `falhou em ${node}`; state = 'falhou'; }
    else { tone = 'queued'; label = 'na fila'; state = 'na fila'; }
    return { tone, label, segs: segs(tone), fg: RUN_FG[tone], state, node };
  }

  // Selo do PR: #n + sufixo do estado (OPEN sem sufixo, como no artboard).
  const PR_TONE = {
    OPEN: ['', 'var(--state-running-fg)', 'var(--state-running-bg)', 'aberto', 'var(--accent)'],
    MERGED: [' merged', 'var(--state-done-fg)', 'var(--state-done-bg)', 'mergeado', 'var(--state-done)'],
    DECLINED: [' recusado', 'var(--state-failed-fg)', 'var(--state-failed-bg)', 'recusado', 'var(--state-failed)'],
    SUPERSEDED: [' substituído', 'var(--state-waiting-fg)', 'var(--state-waiting-bg)', 'substituído', 'var(--state-waiting)'],
  };
  function prBadge(p) {
    const t = PR_TONE[p.state];
    const id = p.id ? `#${p.id}` : 'PR';
    return t ? { label: id + t[0], fg: t[1], bg: t[2], word: t[3], dot: t[4] }
      : { label: id, fg: 'var(--text-secondary)', bg: 'var(--state-queued-bg)', word: 'sem estado', dot: 'var(--border-control)' };
  }

  const dur = ms => {
    const d = ms / DAY;
    return d >= 1 ? `${Math.round(d)} dia${Math.round(d) === 1 ? '' : 's'}` : `${Math.max(1, Math.round(ms / 3600000))} h`;
  };

  // Divergências entre as três fontes. ticketStatus só conta quando veio do Redmine
  // (lista ou consulta por ticket) — o status gravado pelo watcher pode estar velho.
  // level: red (ticket fechado com run ativo) | amber (o resto).
  function alertsFor({ ticketStatus, runs, prs, now = Date.now() }) {
    const out = [];
    const known = (runs || []).filter(r => r.status !== 'unknown');
    const anyActive = known.some(r => !isDone(r));
    const allDone = known.length > 0 && known.every(isDone);
    const closed = !!ticketStatus && CLOSED_RE.test(ticketStatus);
    if (closed && anyActive) out.push({ level: 'red', text: `Ticket está “${ticketStatus}” no Redmine, mas há run ativo.` });
    for (const p of prs || []) {
      const name = `PR ${p.repo ? `${p.repo} ` : ''}#${p.id}`;
      if (p.state === 'DECLINED' && allDone) out.push({ level: 'amber', text: `${name} foi recusado no Bitbucket, mas o run está concluído.` });
      if (p.state === 'DECLINED' && anyActive) out.push({ level: 'amber', text: `${name} foi recusado no Bitbucket.` });
      if (p.state === 'OPEN' && !(p.approvals || []).length && p.created_on && now - Date.parse(p.created_on) > 7 * DAY) {
        out.push({ level: 'amber', text: `${name} está aberto há ${dur(now - Date.parse(p.created_on))} sem aprovação.` });
      }
    }
    if (ticketStatus && (prs || []).length && prs.every(p => p.state === 'MERGED') && !closed && allDone) {
      out.push({ level: 'amber', text: `Todos os PRs estão mergeados; o ticket segue “${ticketStatus}”.` });
    }
    return out;
  }

  // Veredito do painel. Sem status do Redmine confirmado não diz "Consistente".
  function verdict(row) {
    const red = row.alerts.find(a => a.level === 'red');
    if (red || row.alerts.length) {
      const lv = red ? 'red' : 'amber';
      return { kind: lv, title: red ? 'Não batem' : 'Divergência', body: row.alerts.map(a => a.text).join(' ') };
    }
    if (!row.statusVerified) {
      return { kind: 'unk', title: 'Sem confirmação', body: 'O Redmine ainda não foi consultado para este ticket. Até lá, nada aqui aparece como consistente.' };
    }
    // Fonte sem estado conhecido (PR sem estado do Bitbucket nem do state.json; runs sem state.json
    // legível) também não vira "Consistente": UNKNOWN nunca é aprovação.
    if ((row.prs || []).some(p => !PR_TONE[p.state])) {
      return { kind: 'unk', title: 'Sem confirmação', body: 'O estado do PR no Bitbucket ainda não é conhecido. Até lá, nada aqui aparece como consistente.' };
    }
    if ((row.runs || []).length && row.runs.every(r => r.status === 'unknown')) {
      return { kind: 'unk', title: 'Sem confirmação', body: 'O estado do run não pôde ser lido. Até lá, nada aqui aparece como consistente.' };
    }
    return { kind: 'ok', title: 'Consistente', body: 'Status do Redmine, run e PR não se contradizem pelas regras de divergência.' };
  }

  const num = v => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
  // "5 h" / "5,5 h"; null → null (a tela decide o texto da ausência).
  function hoursLabel(h) {
    const n = num(h);
    if (n == null) return null;
    return `${String(Math.round(n * 10) / 10).replace('.', ',')} h`;
  }

  // Tempo curto da coluna "Atualizado" (64 px no artboard): agora · há N min · há N h · ontem · há N dias.
  function shortAgo(iso, now = Date.now()) {
    const t = Date.parse(iso);
    if (!Number.isFinite(t)) return null;
    const m = Math.max(0, Math.round((now - t) / 60000));
    if (m < 1) return 'agora';
    if (m < 60) return `há ${m} min`;
    const h = Math.round(m / 60);
    if (h < 24) return `há ${h} h`;
    const d = Math.round(h / 24);
    return d === 1 ? 'ontem' : `há ${d} dias`;
  }

  const initials = name => String(name || '').trim().split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0]).join('').toUpperCase();
  const AVATAR_BG = ['var(--c-2b3f70)', 'var(--c-3a2e52)', 'var(--c-3a3220)', 'var(--c-1f3a30)'];
  function avatarBg(name) {
    let h = 0;
    for (const ch of String(name || '')) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    return AVATAR_BG[h % AVATAR_BG.length];
  }

  // Monta as linhas da tela.
  //   mine:      GET /api/tickets (Redmine, abertos atribuídos a mim)
  //   runs:      runs do /api/runs (com ticketId, status, kind, node, state, ticket, ticketStatus, qaRejected)
  //   ticketOf:  taskId → dado de /api/runs/:id/ticket (ou null se não consultado)
  //   prsOf:     run → [{ id, repo, url, state, approvals, created_on }]
  function buildRows({ mine = [], runs = [], ticketOf = () => null, prsOf = () => [], now = Date.now() } = {}) {
    const runsBy = new Map();
    for (const r of runs) {
      if (r.ticketId == null || r.pretask) continue;
      if (!runsBy.has(r.ticketId)) runsBy.set(r.ticketId, []);
      runsBy.get(r.ticketId).push(r);
    }
    const mineIds = new Set(mine.map(t => t.id));
    const ids = [...mine.map(t => t.id), ...[...runsBy.keys()].filter(id => !mineIds.has(id))];
    return ids.map(id => {
      const m = mine.find(t => t.id === id) || null;
      const rs = runsBy.get(id) || [];
      const fetched = rs.map(r => ticketOf(r.taskId)).find(Boolean) || null;
      const snap = rs.map(r => r.ticket).find(Boolean) || null; // state.redmine_ticket (gravado no fetch_ticket)
      const run = linkedRun(rs);
      const seen = new Set();
      const prs = rs.flatMap(r => prsOf(r)).filter(p => {
        const k = `${p.repo || ''}#${p.id || p.url}`;
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      });
      const verified = m?.status || fetched?.status || null;
      const status = verified || run?.ticketStatus || null;
      const row = {
        id,
        mine: !!m,
        subject: m?.subject || fetched?.subject || snap?.subject || '',
        status,
        statusVerified: !!verified,
        priority: m?.priority || fetched?.priority || null,
        tracker: m?.tracker || fetched?.tracker || snap?.tracker || null,
        assignee: m?.assignee || fetched?.assigned_to || null,
        estimated_hours: num(m ? m.estimated_hours : fetched?.estimated_hours),
        done_ratio: num(m ? m.done_ratio : fetched?.done_ratio),
        updated_on: m?.updated_on || fetched?.updated_on || null,
        url: m?.url || fetched?.url || null,
        branch: snap?.base_branch || null,
        runs: rs,
        run,
        prs,
        prUrl: prs.find(p => p.url)?.url || m?.prUrl || null,
      };
      row.alerts = alertsFor({ ticketStatus: verified, runs: rs, prs, now });
      return row;
    });
  }

  // Visões salvas do artboard que têm dado no app (Sprint fica pendente).
  const VIEWS = [
    ['mine', 'Atribuídos a mim', r => r.mine],
    ['diverge', 'Com divergência', r => r.alerts.length > 0],
    ['all', 'Todos', () => true],
  ];
  function filterRows(rows, view, q) {
    const fn = (VIEWS.find(v => v[0] === view) || VIEWS[0])[2];
    const needle = String(q || '').trim().toLowerCase().replace(/^#/, '');
    return rows.filter(fn).filter(r => !needle || `${r.id} ${r.subject} ${r.tracker || ''}`.toLowerCase().includes(needle));
  }

  // Grupos por status (ordem do artboard; mesmo nome = mesmo grupo). hours = soma das
  // estimativas conhecidas e quantas linhas têm estimativa (para não vender soma parcial como total).
  function groupByStatus(rows) {
    const by = new Map();
    for (const r of rows) {
      const k = r.status || '';
      if (!by.has(k)) by.set(k, []);
      by.get(k).push(r);
    }
    return [...by.entries()].map(([name, rs]) => {
      const est = rs.map(r => r.estimated_hours).filter(h => h != null);
      return { name, label: name || 'Status não consultado', style: statusStyle(name), rows: rs,
        hours: est.length ? est.reduce((a, b) => a + b, 0) : null, withHours: est.length };
    }).sort((a, b) => a.style.rank - b.style.rank || a.label.localeCompare(b.label, 'pt-BR'));
  }

  // Efeito de mudar para um status (TicketActions). Só para status cujo comportamento no
  // Espectro existe hoje; o resto diz que não está mapeado — nada de efeito inventado.
  function statusEffect(name) {
    if (!name) return null;
    if (/aprovad/i.test(name)) return 'O watcher pega o ticket no próximo ciclo e abre uma run.';
    if (isQaRejected(name)) return 'O Espectro oferece “Corrigir recusa QA” na run.';
    if (CLOSED_RE.test(name)) return 'Fecha o ticket. Uma run ativa ligada a ele vira divergência em Tickets.';
    return 'O Espectro não reage a este status por conta própria; a mudança fica só no Redmine.';
  }

  const api = { NODES, CLOSED_RE, VIEWS, isQaRejected, statusStyle, prioBars, TRACKERS, trackerKind, linkedRun, runTrail,
    prBadge, alertsFor, verdict, hoursLabel, shortAgo, initials, avatarBg, buildRows, filterRows, groupByStatus, statusEffect };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.TicketBoard = api;
})(typeof window !== 'undefined' ? window : globalThis);
