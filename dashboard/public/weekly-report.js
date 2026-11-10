// Aba "Relatório semanal" (chave metricas): artboard WeeklyReport do canvas Espectro, com o bloco
// Learning embutido na aba "Aprendizado e fonte". Substitui a antiga tela Métricas (PRI-327).
//
// Regra da onda 1: o que o artboard mostra e o app não mede fica FORA da tela (lista "Pendente de
// implementação" na PRI-327): teto/orçamento, custo do retrabalho,
// padrões com custo, gates respondidos/espera, sugestões e envio, Comparar runs embutido. Nada de
// zero no lugar de "sem medição": valor que não foi medido sai como null e vira "sem medição".
//
// Duas camadas: lógica pura (janelas, agregação, deltas, textos, parse de patterns.md) recebe os
// runs e um adaptador `env` com o que hoje vive em index.html/views.js — testada em
// weekly-report.test.js; e o render no navegador, que monta `env` com os globais
// (isDone, needsYou, extractPrs, prState, prCache, ticketCache, NODES) e pluga em views.js via
// window.WeeklyReportView. Estilos em screens/weekly-report.css.
(root => {
  const DAY = 86400000;
  // Brasília: UTC−3 o ano todo (sem horário de verão desde 2019). A semana vai de segunda a domingo.
  const TZ = -3 * 3600000;
  const DOW = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];
  const CLOSED_RE = /conclu|encerr|fechad|closed|rejeit|cancel/i;
  const PR_ORDER = ['OPEN', 'MERGED', 'DECLINED', 'SUPERSEDED', ''];

  const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const sum = a => a.reduce((x, y) => x + y, 0);
  const r2 = x => Math.round(x * 100) / 100;
  const pad2 = n => String(n).padStart(2, '0');

  // ---------------------------------------------------------------- formatos (os do artboard)
  function money(n) {
    if (n == null) return 'sem medição';
    if (n > 0 && n < 0.005) return '< US$ 0,01';
    const p = Math.abs(n).toFixed(2).split('.');
    return `US$ ${p[0].replace(/\B(?=(\d{3})+(?!\d))/g, '.')},${p[1]}`;
  }
  function tok(n) {
    if (n == null) return 'sem medição';
    if (n >= 1e6) return `${(n / 1e6).toFixed(1).replace('.', ',')} M`;
    if (n >= 1000) return `${Math.round(n / 1e3)} mil`;
    return String(Math.round(n));
  }
  const pct1 = x => `${(Math.round(x * 10) / 10).toFixed(1).replace('.', ',')}%`;
  const sgnPct = x => `${x >= 0 ? '+' : '−'}${Math.abs(x).toFixed(1).replace('.', ',')}%`;
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
  // "claude-sonnet-4-5-20250929" → "Sonnet 4.5"; id fora do padrão segue como veio.
  function modelName(id) {
    const m = /claude-(opus|sonnet|haiku|fable)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?$/i.exec(String(id || ''));
    if (!m) return String(id || '');
    return `${m[1][0].toUpperCase()}${m[1].slice(1).toLowerCase()} ${m[2]}${m[3] ? `.${m[3]}` : ''}`;
  }
  function msLabel(ms) {
    if (ms == null || !(ms >= 0)) return 'sem medição';
    const s = Math.round(ms / 1000);
    return `${Math.floor(s / 60)}:${pad2(s % 60)}`;
  }

  // ---------------------------------------------------------------- janelas
  const local = ts => new Date(ts + TZ); // campos UTC deste Date = relógio de Brasília
  function weekStart(ts) {
    const d = local(ts);
    const dow = (d.getUTCDay() + 6) % 7; // segunda = 0
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - dow * DAY - TZ;
  }
  const dm = ts => { const d = local(ts); return `${pad2(d.getUTCDate())}/${pad2(d.getUTCMonth() + 1)}`; };
  function rangeLabel(from, to) { // to exclusivo
    const a = local(from), b = local(to - 1);
    const year = b.getUTCFullYear();
    if (a.getUTCMonth() === b.getUTCMonth() && a.getUTCFullYear() === year) return `${pad2(a.getUTCDate())}–${dm(to - 1)}/${year}`;
    return `${dm(from)}–${dm(to - 1)}/${year}`;
  }
  // ISO 8601: semana da quinta-feira.
  function isoWeek(ts) {
    const d = local(ts);
    const t = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
    const day = (new Date(t).getUTCDay() + 6) % 7;
    const thu = t - day * DAY + 3 * DAY;
    const y = new Date(thu).getUTCFullYear();
    return 1 + Math.floor((thu - Date.UTC(y, 0, 1)) / (7 * DAY));
  }
  // win: cur | prev | all. prev da janela = a semana anterior a ela (null em "Todos os runs").
  function windowOf(win, now) {
    const ws = weekStart(now);
    if (win === 'all') return { win, from: -Infinity, to: Infinity, prev: null };
    const from = win === 'prev' ? ws - 7 * DAY : ws;
    return { win, from, to: from + 7 * DAY, prev: { from: from - 7 * DAY, to: from } };
  }
  const tsOf = r => Date.parse(r?.updatedAt);
  function inWindow(r, w) {
    if (w.from === -Infinity) return true;
    const t = tsOf(r);
    return t >= w.from && t < w.to;
  }

  // ---------------------------------------------------------------- leitura de um run
  function costOf(r) { const c = r?.state?.cost_tracking; return c && c.nodes && c.totals ? c : null; }
  const usdOf = r => { const v = costOf(r)?.totals.cost_usd; return Number.isFinite(v) ? v : null; };
  function tokensOf(r) {
    const t = costOf(r)?.totals;
    if (!t || (t.input_tokens == null && t.output_tokens == null)) return null;
    return (t.input_tokens || 0) + (t.output_tokens || 0);
  }
  const nodeTok = n => (n.input_tokens == null && n.output_tokens == null) ? null : (n.input_tokens || 0) + (n.output_tokens || 0);
  const retriesOf = r => sum(Object.values(r?.state?.retries || {}).map(v => Number(v) || 0));
  const loopsOf = r => { const v = costOf(r)?.totals.loop_count; return Number.isFinite(v) ? v : null; };
  const msgsOf = r => (Array.isArray(r?.state?.human_inputs) ? r.state.human_inputs.length : 0);
  // "Passou de primeira": concluído sem retry em state.json.retries e com loop_count 0 no cost_tracking.
  // Run sem cost_tracking não entra na conta (não dá para afirmar que passou de primeira).
  const firstPass = r => retriesOf(r) === 0 && loopsOf(r) === 0;

  // ---------------------------------------------------------------- agregação de uma janela
  // env: { isDone(r), prsOf(r) -> [{id, repo, url}], prState(r, p) -> OPEN|MERGED|DECLINED|SUPERSEDED|'',
  //        prUpdatedOn(r, p) -> ISO|null, ticketStatus(r) -> string | undefined (não consultado) }
  function aggregate(list, env) {
    const done = list.filter(env.isDone);
    const prCounts = Object.fromEntries(PR_ORDER.map(k => [k, 0]));
    for (const r of list) for (const p of env.prsOf(r)) prCounts[env.prState(r, p) || ''] += 1;
    const tickets = new Map();
    const keyOf = env.ticketKey || (r => r?.ticketId ?? r?.ticket?.id ?? null);
    for (const r of list) { const k = keyOf(r); if (k != null && !tickets.has(k)) tickets.set(k, env.ticketStatus(r)); }
    const known = [...tickets.values()].filter(s => s !== undefined);
    const ticketsClosed = !tickets.size ? 0 : known.length ? known.filter(s => CLOSED_RE.test(s || '')).length : null;
    const tokened = list.filter(r => tokensOf(r) != null);
    const priced = list.filter(r => usdOf(r) != null);
    const donePriced = done.filter(r => usdOf(r) != null);
    const doneLooped = done.filter(r => loopsOf(r) != null);
    return {
      runs: list.length, done: done.length, doneList: done, list,
      prCounts, prTotal: sum(Object.values(prCounts)), merged: prCounts.MERGED,
      tickets: ticketsClosed, ticketsKnown: known.length, ticketsTotal: tickets.size, ticketsPartial: known.length > 0 && known.length < tickets.size,
      tokens: tokened.length ? sum(tokened.map(tokensOf)) : null, tokenRuns: tokened.length,
      msgs: sum(list.map(msgsOf)),
      cost: priced.length ? r2(sum(priced.map(usdOf))) : null, pricedRuns: priced.length,
      avg: donePriced.length ? sum(donePriced.map(usdOf)) / donePriced.length : null, avgRuns: donePriced.length,
      loops: doneLooped.length ? sum(doneLooped.map(loopsOf)) : null, loopRuns: doneLooped.length,
      rate: doneLooped.length ? sum(doneLooped.map(loopsOf)) / doneLooped.length : null,
      firstPass: doneLooped.length ? doneLooped.filter(firstPass).length / doneLooped.length : null, firstPassRuns: doneLooped.length,
      declined: prCounts.DECLINED,
    };
  }

  // Delta contra a janela anterior, no texto do artboard. good: true = subir é bom; false = ruim; null = neutro.
  function delta(c, p, good, fmt, { all = false, field = '' } = {}) {
    if (all) return { t: 'sem comparação: janela sem recorte de semana', tone: 'muted' };
    if (c == null) return { t: `nenhum run com ${field} na janela`, tone: 'muted' };
    if (p == null) return { t: 'semana anterior sem medição', tone: 'muted' };
    const d = c - p;
    if (Math.abs(d) < 1e-9) return { t: '= igual à semana anterior', tone: 'muted' };
    const up = d > 0;
    return { t: `${up ? '▲' : '▼'} ${fmt(d)} contra a semana anterior`, tone: good === null ? 'neutral' : up === good ? 'good' : 'bad' };
  }
  const cnt = d => `${d > 0 ? '+' : '−'}${Math.abs(d)}`;
  const prc = (c, p) => (p ? sgnPct(((c - p) / p) * 100) : `${c - p >= 0 ? '+' : '−'}${money(Math.abs(c - p))}`);

  // ---------------------------------------------------------------- séries do gráfico
  // cur/prev: 7 dias da janela; all: semanas registradas (as 12 últimas com run).
  function series(list, w, env, now) {
    let buckets;
    if (w.from !== -Infinity) {
      buckets = Array.from({ length: 7 }, (_, i) => {
        const from = w.from + i * DAY, d = local(from);
        return { from, to: from + DAY, label: `${DOW[d.getUTCDay()]} ${pad2(d.getUTCDate())}` };
      });
    } else {
      const ts = list.map(tsOf).filter(Number.isFinite);
      if (!ts.length) return [];
      const last = weekStart(Math.max(now, ...ts));
      let first = weekStart(Math.min(...ts));
      first = Math.max(first, last - 11 * 7 * DAY);
      buckets = [];
      for (let from = first; from <= last; from += 7 * DAY) buckets.push({ from, to: from + 7 * DAY, label: rangeLabel(from, from + 7 * DAY).replace(/\/\d{4}$/, '') });
    }
    return buckets.map(b => {
      // Dia/semana que ainda não começou não é zero: fica sem barra e sem rótulo.
      if (b.from > now) return { label: b.label, cost: null, runs: null, future: true };
      const rs = list.filter(r => { const t = tsOf(r); return t >= b.from && t < b.to; });
      // Bucket com run mas sem nenhum custo medido é "sem medição" (null), não US$ 0,00.
      const priced = rs.filter(r => usdOf(r) != null);
      return { label: b.label, cost: priced.length ? r2(sum(priced.map(usdOf))) : rs.length ? null : 0, runs: rs.filter(env.isDone).length };
    });
  }
  // Escala "redonda" com 3–6 marcas, partindo de 0.
  function ticks(max, { integer = false } = {}) {
    if (!(max > 0)) return [0, 1];
    const raw = max / 4, mag = 10 ** Math.floor(Math.log10(raw));
    let step = [1, 2, 2.5, 5, 10].map(m => m * mag).find(s => s >= raw) || 10 * mag;
    if (integer) step = Math.max(1, Math.ceil(step));
    const out = [];
    for (let v = 0; v < max + step - 1e-9; v += step) out.push(r2(v));
    return out;
  }

  // ---------------------------------------------------------------- custo / tokens por nó e tipo
  function nodeCosts(list, nodes) {
    const acc = new Map();
    for (const r of list) {
      const c = costOf(r);
      if (!c) continue;
      for (const [k, n] of Object.entries(c.nodes)) {
        const a = acc.get(k) || { usd: 0, priced: 0, models: new Set() };
        if (Number.isFinite(n.cost_usd)) { a.usd += n.cost_usd; a.priced += 1; }
        for (const m of n.models || []) a.models.add(m);
        acc.set(k, a);
      }
    }
    const order = [...nodes.map(([k]) => k), ...[...acc.keys()].filter(k => !nodes.some(([n]) => n === k))];
    const rows = order.filter(k => acc.has(k)).map(k => {
      const a = acc.get(k);
      const models = [...a.models].map(modelName);
      return { name: k, model: models.length > 1 ? `${models[0]} +${models.length - 1}` : (models[0] || ''), modelTip: models.join(', '), usd: a.priced ? r2(a.usd) : null };
    });
    const base = sum(rows.map(x => x.usd || 0)), max = Math.max(0, ...rows.map(x => x.usd || 0));
    return rows.map(x => ({ ...x, w: x.usd && max ? Math.round((x.usd / max) * 100) : 0, pct: x.usd != null && base ? (x.usd / base) * 100 : null }));
  }
  function stageTokens(list, nodes) {
    const covered = new Map(); // nó → nó que o cobre (also_covers: plan cobre fetch_ticket)
    const rows = nodes.map(([k, label]) => {
      let v = 0, any = false, silent = 0;
      for (const r of list) {
        const n = costOf(r)?.nodes[k];
        if (!n) continue;
        for (const o of n.also_covers || []) covered.set(o, label);
        const t = nodeTok(n);
        if (t != null) { v += t; any = true; }
        silent += n.runs_without_tokens || 0;
      }
      return { key: k, name: label, v: any ? v : null, silent };
    });
    const total = sum(rows.map(x => x.v || 0)), max = Math.max(0, ...rows.map(x => x.v || 0));
    return rows.map(x => ({
      ...x, w: x.v && max ? Math.round((x.v / max) * 100) : 0, pct: x.v != null && total ? (x.v / total) * 100 : null,
      note: x.v == null ? (covered.has(x.key) ? `incluído em ${covered.get(x.key)}` : 'o nó não gravou cost_tracking nesta janela')
        : x.silent ? `${plural(x.silent, 'execução', 'execuções')} sem tokens reportados` : '',
    }));
  }
  function trackerCosts(list) {
    const acc = new Map();
    for (const r of list) {
      const usd = usdOf(r);
      if (usd == null) continue;
      const k = r.ticket?.tracker || 'Sem tipo';
      const a = acc.get(k) || { usd: 0, runs: 0 };
      a.usd += usd; a.runs += 1;
      acc.set(k, a);
    }
    const rows = [...acc.entries()].map(([name, a]) => ({ name, usd: r2(a.usd), runs: a.runs })).sort((a, b) => b.usd - a.usd);
    const max = Math.max(0, ...rows.map(x => x.usd));
    return rows.map(x => ({ ...x, w: max ? Math.round((x.usd / max) * 100) : 0 }));
  }
  // Custo por projeto (artboard "Custo por projeto"): projeto = location do run. Participação no total
  // medido da janela e custo médio por run concluído com custo medido; run sem custo fica fora.
  function projectCosts(list, env) {
    const acc = new Map();
    for (const r of list) {
      const usd = usdOf(r);
      if (usd == null) continue;
      const k = r.location || 'Sem projeto';
      const a = acc.get(k) || { usd: 0, runs: 0, doneUsd: 0, done: 0 };
      a.usd += usd; a.runs += 1;
      if (env.isDone(r)) { a.doneUsd += usd; a.done += 1; }
      acc.set(k, a);
    }
    const total = sum([...acc.values()].map(a => a.usd));
    return [...acc.entries()].map(([name, a]) => ({ name, usd: r2(a.usd), runs: a.runs, avg: a.done ? a.doneUsd / a.done : null,
      w: total ? Math.round((a.usd / total) * 100) : 0 })).sort((a, b) => b.usd - a.usd);
  }
  // "dados capturados em 27/10, 14:56" (Brasília) e "atualizado há 12 s".
  function captureLabel(ts) { const d = local(ts); return `${dm(ts)}, ${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`; }
  function sinceLabel(ms) {
    const s = Math.max(0, Math.floor(ms / 1000));
    return s < 60 ? `${s} s` : s < 3600 ? `${Math.floor(s / 60)} min` : `${Math.floor(s / 3600)} h`;
  }

  // state.json.retries por nó: cada tentativa extra do nó é uma volta (loop) que saiu dele.
  function retryRows(list, nodes) {
    const acc = new Map();
    for (const r of list) for (const [k, v] of Object.entries(r.state?.retries || {})) if (Number(v) > 0) acc.set(k, (acc.get(k) || 0) + Number(v));
    const order = [...nodes.map(([k]) => k), ...[...acc.keys()].filter(k => !nodes.some(([n]) => n === k))];
    const rows = order.filter(k => acc.has(k)).map(k => ({ name: k, loops: acc.get(k) }));
    const max = Math.max(0, ...rows.map(x => x.loops));
    return rows.map(x => ({ ...x, w: max ? Math.round((x.loops / max) * 100) : 0 }));
  }

  // ---------------------------------------------------------------- gates e destaques
  function openGates(all, env, now) {
    return all.filter(r => !env.isDone(r) && env.needsYou(r)).map(r => {
      const t = tsOf(r), mins = Number.isFinite(t) ? Math.max(0, Math.floor((now - t) / 60000)) : null;
      return { taskId: r.taskId, id: env.ticketLabel(r), t: env.titleText(r), status: env.statusLabel(r), mins,
        age: mins == null ? 'aberto' : `aberto há ${Math.floor(mins / 60)} h ${pad2(mins % 60)}` };
    }).sort((a, b) => (b.mins ?? -1) - (a.mins ?? -1));
  }
  function highlights(list, env) {
    const out = [];
    for (const r of list) for (const p of env.prsOf(r)) {
      if (env.prState(r, p) !== 'MERGED') continue;
      const on = Date.parse(env.prUpdatedOn(r, p) || '');
      out.push({ taskId: r.taskId, ticket: env.ticketLabel(r), title: env.titleText(r), proj: r.location || '',
        pr: p.id ? `#${p.id}` : 'PR', url: p.url || '', date: Number.isFinite(on) ? dm(on) : '', at: Number.isFinite(on) ? on : tsOf(r) || 0, cost: usdOf(r) });
    }
    return out.sort((a, b) => b.at - a.at);
  }

  // ---------------------------------------------------------------- modelo do relatório
  function buildReport(all, env, { win = 'cur', now = Date.now(), scopeLabel = 'todos os projetos' } = {}) {
    const w = windowOf(win, now);
    const isAll = w.from === -Infinity;
    const list = all.filter(r => inWindow(r, w));
    const cur = aggregate(list, env);
    const prev = w.prev ? aggregate(all.filter(r => inWindow(r, w.prev)), env) : null;
    const ts = all.map(tsOf).filter(Number.isFinite);
    const range = isAll ? (ts.length ? rangeLabel(Math.min(...ts), Math.max(...ts) + 1) : 'sem runs') : rangeLabel(w.from, w.to);
    // "em 3 semanas": semanas de calendário (segunda a domingo) entre o primeiro e o último run registrado.
    const weeks = isAll && ts.length ? Math.round((weekStart(Math.max(...ts)) - weekStart(Math.min(...ts))) / (7 * DAY)) + 1 : 0;
    const o = { all: isAll };
    const k = {
      runs: delta(cur.done, prev?.done, true, cnt, o),
      prs: delta(cur.merged, prev?.merged, true, cnt, o),
      tickets: delta(cur.tickets, prev?.tickets, true, cnt, { ...o, field: 'ticket consultado no Redmine' }),
      tokens: delta(cur.tokens, prev?.tokens, false, d => `${d > 0 ? '+' : '−'}${tok(Math.abs(d))}`, { ...o, field: 'cost_tracking' }),
      msgs: delta(cur.msgs, prev?.msgs, null, cnt, o),
      total: delta(cur.cost, prev?.cost, false, () => `${prc(cur.cost, prev.cost)} (era ${money(prev.cost)})`, { ...o, field: 'custo em US$' }),
      avg: delta(cur.avg, prev?.avg, false, () => prc(cur.avg, prev.avg), { ...o, field: 'custo em US$' }),
      rate: delta(cur.rate, prev?.rate, false, d => `${d >= 0 ? '+' : '−'}${Math.abs(d).toFixed(2).replace('.', ',')}`, { ...o, field: 'loop_count' }),
    };
    // Contagem de tickets com parte ainda não consultada no Redmine: não compara nem finge ser total.
    if (cur.ticketsPartial) k.tickets = { t: `parcial: ${cur.ticketsKnown} de ${cur.ticketsTotal} tickets consultados no Redmine`, tone: 'muted' };
    else if (prev?.ticketsPartial && !isAll) k.tickets = { t: 'semana anterior com consulta parcial no Redmine', tone: 'muted' };
    const sr = series(list, w, env, now);
    return {
      win, isAll, w, range, scopeLabel, list, cur, prev, k, series: sr,
      nodes: nodeCosts(list, env.nodes), stages: stageTokens(list, env.nodes), types: trackerCosts(list), projects: projectCosts(list, env),
      retries: retryRows(list, env.nodes), highlights: highlights(list, env), gates: openGates(all, env, now),
      summary: summaryText({ isAll, range, cur, prev, scopeLabel, weeks }),
    };
  }

  // Resumo escrito (artboard: 4 parágrafos; o de sugestões fica fora — sem dado no app).
  function summaryText({ isAll, range, cur, prev, scopeLabel = 'todos os projetos', weeks = 0 }) {
    const capS = scopeLabel.charAt(0).toUpperCase() + scopeLabel.slice(1);
    const tk = cur.tickets == null ? 'tickets fechados sem medição (Redmine não consultado)'
      : cur.ticketsPartial ? `fechou ao menos ${plural(cur.tickets, 'ticket', 'tickets')} (${cur.ticketsKnown} de ${cur.ticketsTotal} consultados no Redmine)`
      : `fechou ${plural(cur.tickets, 'ticket', 'tickets')}`;
    let s1;
    if (isAll) s1 = `${capS} registrou ${plural(cur.done, 'run concluído', 'runs concluídos')}${weeks ? ` em ${plural(weeks, 'semana', 'semanas')}` : ''} (${range}), mergeou ${plural(cur.merged, 'PR', 'PRs')} e ${tk}.`;
    else {
      const d = prev ? cur.done - prev.done : 0;
      const cmp = !prev ? '' : d === 0 ? ', o mesmo número da semana anterior' : `, ${Math.abs(d)} ${d > 0 ? 'a mais' : 'a menos'} que na semana anterior`;
      s1 = `${capS} concluiu ${plural(cur.done, 'run', 'runs')}${cmp}, mergeou ${plural(cur.merged, 'PR', 'PRs')} e ${tk}.`;
    }
    let s2;
    if (cur.cost == null) s2 = 'Custo sem medição: nenhum run da janela tem cost_tracking com preço.';
    else {
      s2 = `O custo foi de ${money(cur.cost)}.`;
      if (cur.avg != null) {
        s2 += ` O custo médio por run concluído ficou em ${money(cur.avg)}`;
        if (!isAll && prev?.avg != null) s2 += `, ${Math.abs(cur.avg - prev.avg) < 1e-9 ? `igual aos ${money(prev.avg)} da semana anterior` : `${cur.avg > prev.avg ? 'acima' : 'abaixo'} dos ${money(prev.avg)} da semana anterior (${prc(cur.avg, prev.avg)})`}`;
        s2 += '.';
      }
    }
    const s3 = cur.loops == null ? 'Retrabalho sem medição: nenhum run concluído na janela tem loop_count no cost_tracking.'
      : `O retrabalho somou ${plural(cur.loops, 'loop', 'loops')} em ${plural(cur.loopRuns, 'run concluído', 'runs concluídos')} com telemetria, ${cur.rate.toFixed(2).replace('.', ',')} por run.`;
    return [s1, s2, s3];
  }

  // Texto do "Copiar resumo" (artboard buildText, sem as partes que o app não mede).
  function copyText(M, scope) {
    const L = [`Relatório semanal do Espectro · ${M.range}${M.isAll ? ' · todos os runs' : ''} · ${scope || M.scopeLabel || 'todos os projetos'}`, '', ...M.summary, ''];
    L.push(`Entregas: ${M.cur.done} runs concluídos, ${M.cur.merged} PRs mergeados, ${M.cur.tickets == null ? 'tickets fechados sem medição' : `${M.cur.tickets} tickets fechados`}.`);
    L.push(`Tokens: ${tok(M.cur.tokens)}; mensagens ao agente: ${M.cur.msgs}.`);
    L.push(`Custo: ${money(M.cur.cost)}; média por run ${money(M.cur.avg)}${!M.isAll && M.prev?.avg != null ? ` contra ${money(M.prev.avg)} na semana anterior` : ''}.`);
    L.push(`Retrabalho: ${M.cur.loops == null ? 'sem medição' : `${M.cur.loops} loops`}${M.retries.length ? ` (${M.retries.map(x => `${x.name} ${x.loops}`).join(', ')})` : ''}.`);
    L.push(`PRs por estado: ${PR_ORDER.map(s => `${s || 'desconhecido'} ${M.cur.prCounts[s]}`).join(', ')}.`);
    L.push('', 'Fonte: state.json dos runs (cost_tracking, retries, human_inputs), Bitbucket e Redmine. Números são sinal, não verdade contábil.');
    return L.join('\n');
  }

  // ---------------------------------------------------------------- Aprendizado (Learning embutido)
  const PERIODS = { '30': 30, '7': 7, all: null };
  function median(xs) {
    if (!xs.length) return null;
    const s = [...xs].sort((a, b) => a - b), m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  }
  function buildLearning(all, env, { period = '30', now = Date.now() } = {}) {
    const days = PERIODS[period] ?? null;
    const inP = (r, from, to) => { const t = tsOf(r); return t >= from && t < to; };
    const list = days ? all.filter(r => inP(r, now - days * DAY, now + 1)) : all;
    const prevList = days ? all.filter(r => inP(r, now - 2 * days * DAY, now - days * DAY)) : null;
    const cur = aggregate(list, env), prev = prevList ? aggregate(prevList, env) : null;
    const arrow = (c, p, good, fmt) => {
      if (!prev) return { t: 'sem comparação', tone: 'muted' };
      if (c == null || p == null) return { t: 'período anterior sem medição', tone: 'muted' };
      const d = c - p;
      if (Math.abs(d) < 1e-9) return { t: '= igual ao período anterior', tone: 'muted' };
      return { t: `${d > 0 ? '↑' : '↓'} ${fmt(Math.abs(d), c, p)}`, tone: good === null ? 'muted' : (d > 0) === good ? 'good' : 'bad' };
    };
    const kpis = [
      { label: 'Runs concluídos', value: String(cur.done), ...arrow(cur.done, prev?.done, true, d => `${d} vs período anterior`) },
      { label: 'Passaram de primeira', value: cur.firstPass == null ? 'sem medição' : `${Math.round(cur.firstPass * 100)}%`,
        ...arrow(cur.firstPass, prev?.firstPass, true, d => `${Math.round(d * 100)} p.p.`) },
      { label: 'Custo total', value: money(cur.cost), ...arrow(cur.cost, prev?.cost, false, (d, c, p) => (p ? `${Math.round((d / p) * 100)}%` : money(d))) },
      { label: 'PRs recusados', value: String(cur.declined), ...arrow(cur.declined, prev?.declined, null, d => `${d} vs período anterior`) },
    ];
    // Custo por semana: as 8 últimas semanas até hoje, independente do período (como no artboard).
    const last = weekStart(now);
    const weeks = Array.from({ length: 8 }, (_, i) => {
      const from = last - (7 - i) * 7 * DAY, to = from + 7 * DAY;
      const rs = all.filter(r => inP(r, from, to)).filter(r => usdOf(r) != null);
      return { label: `s${isoWeek(from)}`, from, cost: rs.length ? r2(sum(rs.map(usdOf))) : null, range: rangeLabel(from, to) };
    });
    const wmax = Math.max(0, ...weeks.map(x => x.cost || 0));
    // Mediana por etapa: duração medida pelo watcher (cost_tracking: duration_ms/runs por passagem);
    // run sem cost_tracking cai na estimativa do agent_log (env.segmentsOf). Custo = mediana por passagem.
    const stages = env.nodes.map(([k]) => {
      const times = [], costs = [];
      let visited = 0, retried = 0, measured = 0;
      for (const r of list) {
        const c = costOf(r), n = c?.nodes[k];
        const hist = r.state?.history || [];
        if (n || hist.includes(k) || r.state?.retries?.[k] != null) visited += 1;
        if (Number(r.state?.retries?.[k]) > 0) retried += 1;
        if (n) {
          const runsN = Math.max(n.runs || 1, 1);
          if (n.duration_ms >= 0) { for (let i = 0; i < runsN; i++) times.push(n.duration_ms / runsN); measured += 1; }
          if (Number.isFinite(n.cost_usd)) costs.push(n.cost_usd / runsN);
        } else if (!c && env.segmentsOf) {
          for (const s of env.segmentsOf(r).segs) if (s.node === k) times.push(s.to - s.from);
        }
      }
      const t = median(times), cu = median(costs);
      return { node: k, ms: t, time: msLabel(t), cost: cu == null ? 'sem medição' : money(cu),
        retryPct: visited ? Math.round((retried / visited) * 100) : null, measured };
    });
    const tmax = Math.max(0, ...stages.map(s => s.ms || 0));
    return {
      period, cur, prev, kpis,
      weeks: weeks.map(x => ({ ...x, h: x.cost && wmax ? Math.max((x.cost / wmax) * 100, 1) : 0, tip: `${x.label} (${x.range}): ${money(x.cost)}` })),
      anyWeekCost: weeks.some(x => x.cost != null),
      stages: stages.map(s => ({ ...s, pct: s.ms && tmax ? Math.round((s.ms / tmax) * 100) : 0, retry: s.retryPct == null ? 'sem medição' : `${s.retryPct}%` })),
      anyMeasured: stages.some(s => s.measured > 0),
    };
  }

  // memory/patterns.md (scripts/memory-consolidator.js renderPatternsMarkdown): formato fixo.
  function parsePatterns(md) {
    const out = [];
    let sec = '';
    for (const line of String(md || '').split('\n')) {
      if (line.startsWith('## ')) { sec = line.slice(3).trim(); continue; }
      let m = /^- \*\*(.+?)\*\*: ocorreu em (\d+)\/(\d+) run\(s\) revisado\(s\)(?: \(ex\.: (.+)\))?$/.exec(line);
      if (m) { out.push({ kind: 'review', title: m[1], count: +m[2], total: +m[3], where: m[4] ? `ex.: ${m[4]}` : '' }); continue; }
      m = /^- Runs tocando `(.+?)\/`: média ([\d.]+) loops \((\d+) run\(s\)\)$/.exec(line);
      if (m && /alto custo/i.test(sec)) out.push({ kind: 'cost', title: `Runs tocando ${m[1]}/`, count: +m[3], total: null, where: `média de ${m[2].replace('.', ',')} loops por run` });
    }
    const gen = /generated_at=(\S+)/.exec(String(md || ''));
    return { items: out, generatedAt: gen ? gen[1] : null };
  }
  // Bolinhas do card (máx. 8): ocorrências contra runs revisados, na proporção.
  function patternDots(p) {
    const n = 8;
    if (!p.total) return Array.from({ length: Math.min(p.count, n) }, () => 'hit');
    const hits = Math.min(n, Math.max(p.count ? 1 : 0, Math.round((p.count / p.total) * n)));
    return Array.from({ length: n }, (_, i) => (i < hits ? 'hit' : 'rest'));
  }

  const pub = { DAY, TZ, money, tok, pct1, modelName, msLabel, weekStart, rangeLabel, isoWeek, windowOf, inWindow, aggregate, delta, series, ticks,
    nodeCosts, stageTokens, trackerCosts, projectCosts, captureLabel, sinceLabel, retryRows, openGates, highlights, buildReport, summaryText, copyText, buildLearning, parsePatterns, patternDots, firstPass };
  if (typeof module !== 'undefined' && module.exports) { module.exports = pub; return; }

  // ================================================================ navegador
  const savedPrefs = (typeof prefs !== 'undefined' && prefs.weekly) || {};
  const st = {
    win: ['cur', 'prev', 'all'].includes(savedPrefs.win) ? savedPrefs.win : 'cur',
    scope: typeof savedPrefs.scope === 'string' && savedPrefs.scope ? savedPrefs.scope : 'all',
    tab: 'summary', mode: 'cost', q: '', period: '30', ltab: 'metrics', copied: '', toast: '',
    capturedAt: null, wasLoading: false, renderedAt: null,
    pat: { data: null, loading: false, error: null },
  };
  const save = () => { try { prefs.weekly = { win: st.win, scope: st.scope }; persist(); } catch { /* prefs indisponível */ } };
  const TABS = [['summary', 'Resumo e entregas'], ['cost', 'Custo'], ['rework', 'Retrabalho e padrões'], ['learn', 'Aprendizado e fonte']];

  function env() {
    const V = window.Views || {};
    return {
      nodes: NODES, isDone, needsYou,
      prsOf: r => extractPrs(r.state?.pull_request),
      prState: (r, p) => prState(r.taskId, p),
      prUpdatedOn: (r, p) => prCache.get(r.taskId)?.data?.prs?.find(x => x.id === p.id && (!p.repo || x.repo === p.repo))?.updated_on || null,
      // loadAll grava o ticket sob um único run; o status vale para todos os runs do mesmo ticket.
      ticketKey: ticketIdOfRun,
      ticketStatus: r => {
        const id = ticketIdOfRun(r);
        for (const x of id == null ? [r] : [...runs.values()].filter(y => ticketIdOfRun(y) === id)) {
          const c = ticketCache.get(x.taskId);
          if (c?.data) return String(c.data.status || '');
        }
        return undefined;
      },
      ticketLabel: r => { const n = String(titleOf(r).num || ''); return n ? (n.startsWith('#') ? n : `#${n}`) : r.taskId; },
      titleText: r => titleOf(r).text || r.taskId,
      statusLabel: r => STATUS[r.status] || r.status,
      segmentsOf: V.segmentsOf,
    };
  }
  const shownAll = () => visibleRuns().filter(r => !isHidden(r));
  // Escopo e "Custo por projeto" do artboard ficam pendentes: o run não grava o projeto consumidor
  // (location é a cópia do checkout: main, worktree:<ticket>…), então o relatório é sempre de todos.
  const SCOPE_BY_PROJECT = false;
  const shown = () => (!SCOPE_BY_PROJECT || st.scope === 'all' ? shownAll() : shownAll().filter(r => r.location === st.scope));
  const scopeLabelOf = () => (!SCOPE_BY_PROJECT || st.scope === 'all' ? 'todos os projetos' : st.scope);
  const model = () => buildReport(shown(), env(), { win: st.win, scopeLabel: scopeLabelOf() });
  const WINS = [['cur', 'Semana atual'], ['prev', 'Semana anterior'], ['all', 'Todos os runs']];
  const toneCls = t => `wr-tone-${t || 'muted'}`;
  const matches = (q, ...xs) => !q || xs.join(' ').toLowerCase().includes(q);

  function head(M, eyebrow, health, info, locs) {
    const scopes = [['all', 'Todos os projetos'], ...locs.map(l => [l, l])];
    return `<header class="wr-head">
      <div class="wr-head-row"><div class="wr-head-text">
        <span class="wr-eyebrow">Relatório semanal${eyebrow ? ` · ${esc(eyebrow)}` : ''}</span>
        <span class="wr-title-row"><h2 class="wr-h1">Relatório semanal</h2>
          <span class="wr-pill wr-pill-${health.k}"><span aria-hidden="true">${health.glyph}</span>${esc(health.label)}</span>
          <span class="wr-seg" role="radiogroup" aria-label="Janela do relatório">${WINS.map(([id, label]) =>
            `<button type="button" role="radio" aria-checked="${st.win === id}" data-wract="win" data-v="${id}">${label}</button>`).join('')}</span></span>
        <p class="wr-muted">${esc(M.isAll ? `${M.range}, todos os runs registrados` : M.range)} · ${esc(M.scopeLabel)} · ${info}</p>
      </div></div>
      ${health.k === 'partial' ? `<div class="wr-alert" role="alert"><span aria-hidden="true">‖</span><span>${esc(health.note)}</span></div>` : ''}
      <div class="wr-tools">
        ${SCOPE_BY_PROJECT ? `<label class="wr-scope">Escopo
          <select data-wrscope>${scopes.map(([v, l]) => `<option value="${esc(v)}"${st.scope === v ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select></label>` : ''}
        <label class="wr-search"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg>
          <input type="search" data-wrq aria-label="Filtrar entregas, gates e padrões" placeholder="Filtrar ticket, PR, padrão…" value="${esc(st.q)}"></label>
      </div>
      <div class="wr-tools">
        <button type="button" class="wr-btn wr-btn-primary" data-wract="copy">Copiar resumo</button>
        <span role="status" aria-live="polite" class="wr-copy ${st.copied === 'ok' ? 'wr-tone-good' : 'wr-tone-fail'}">${st.copied === 'ok' ? '✓ Resumo copiado para a área de transferência'
          : st.copied === 'fail' ? '✕ Não foi possível copiar. Selecione o texto do resumo acima e copie com Ctrl+C' : ''}</span>
      </div>
    </header>`;
  }

  const kcard = (label, value, d, src, cls = '') => `<div class="wr-card ${cls}"><span class="wr-k">${esc(label)}</span><span class="wr-kv${value === 'sem medição' ? ' wr-none' : ''}">${esc(value)}</span>`
    + `${d ? `<span class="wr-kd ${toneCls(d.tone)}">${esc(d.t)}</span>` : ''}${src ? `<span class="wr-k">Fonte: ${esc(src)}</span>` : ''}</div>`;
  const secHead = (id, title, sub, tag = 'h2') => `<div class="wr-sec-head"><${tag} id="${id}" class="wr-${tag}">${esc(title)}</${tag}>${sub ? `<span class="wr-sub">${esc(sub)}</span>` : ''}</div>`;
  // Coluna estreita (Mediana por etapa): "sem medição" não cabe; mostra "—" e diz o motivo no title/aria.
  const cellNm = (v, cls) => (v === 'sem medição' ? `<span class="${cls} wr-none" title="sem medição" aria-label="sem medição">—</span>` : `<span class="${cls}">${esc(v)}</span>`);
  const bar = (w, cls = '') => `<span class="wr-track" aria-hidden="true"><span class="wr-fill ${cls}" style="width:${w}%"></span></span>`;
  const usdTip = usd => (usd != null && typeof fx !== 'undefined' && fx?.rate ? ` title="${esc(fmtBrl(usd))}"` : '');

  function panelSummary(M, q) {
    const c = M.cur;
    const hl = M.highlights.filter(h => matches(q, h.ticket, h.title, h.proj, h.pr));
    const gates = M.gates.filter(g => matches(q, g.id, g.t, g.status));
    const PRS = [['OPEN', 'Abertos', '◐', 'running'], ['MERGED', 'Mergeados', '✓', 'done'], ['DECLINED', 'Recusados', '✕', 'failed'],
      ['SUPERSEDED', 'Substituídos', '○', 'queued'], ['', 'Estado desconhecido', '?', 'unknown']];
    const prMax = Math.max(1, ...PRS.map(([s]) => c.prCounts[s]));
    const over24 = M.gates.filter(g => g.mins != null && g.mins >= 1440).length;
    return `<section class="wr-sec" aria-labelledby="wr-res-h">
        <h2 id="wr-res-h" class="wr-h2">Resumo da semana</h2>
        <div class="wr-summary">${M.summary.map(t => `<p>${esc(t)}</p>`).join('')}</div>
      </section>
      <section class="wr-sec wr-sec-rule" aria-labelledby="wr-ent-h">
        ${secHead('wr-ent-h', 'Entregas', 'runs com PR aberto e merge confirmado no Bitbucket; tickets fechados no Redmine')}
        <div class="wr-grid">
          ${kcard('Runs concluídos', String(c.done), M.k.runs, 'state.json · status do run', 'wr-card-mono')}
          ${kcard('PRs mergeados', String(c.merged), M.k.prs, 'Bitbucket', 'wr-card-mono')}
          ${kcard('Tickets fechados', c.tickets == null ? 'sem medição' : String(c.tickets), M.k.tickets, 'Redmine', 'wr-card-mono')}
          ${kcard('Tokens', tok(c.tokens), M.k.tokens, 'state.json · cost_tracking', 'wr-card-mono')}
          ${kcard('Mensagens ao agente', String(c.msgs), M.k.msgs, 'state.json · human_inputs', 'wr-card-mono')}
        </div>
        <div class="wr-col">
          <span class="wr-sub wr-note">Destaques: ${Math.min(hl.length, 5)} de ${plural(c.merged, 'PR mergeado', 'PRs mergeados')}, com o custo do run</span>
          <div class="wr-box">${hl.length ? hl.slice(0, 5).map(h => `<div class="wr-row">
              <button type="button" class="wr-chip" data-wract="open-run" data-task="${esc(h.taskId)}">${esc(h.ticket)}</button>
              <span class="wr-row-main">${esc(h.title)}${h.proj ? `<span class="wr-row-sub">${esc(h.proj)}</span>` : ''}</span>
              ${h.url ? `<a class="wr-mono-link" href="${esc(h.url)}" target="_blank" rel="noopener noreferrer">${esc(h.pr)} mergeado${h.date ? ` ${esc(h.date)}` : ''}</a>`
                : `<span class="wr-mono-link">${esc(h.pr)} mergeado${h.date ? ` ${esc(h.date)}` : ''}</span>`}
              <span class="wr-row-cost${h.cost == null ? ' wr-none' : ''}"${usdTip(h.cost)}>${esc(money(h.cost))}</span></div>`).join('')
            : `<p class="wr-empty">${q ? `Nenhuma entrega com “${esc(st.q)}” nesta janela.` : 'Nenhum PR mergeado nesta janela.'}</p>`}</div>
        </div>
        <div class="wr-col wr-col-8">
          ${secHead('wr-prs-h', 'Pull requests por estado', 'PRs abertos pelos runs da janela, pelo estado atual', 'h3')}
          <div class="wr-box wr-box-foot">${PRS.map(([s, label, g, k]) => `<div class="wr-pr-row">
              <span class="wr-pill wr-pill-${k}"><span aria-hidden="true">${g}</span>${label}</span>
              <span class="wr-code">${s || '—'}</span>
              ${bar(Math.round((c.prCounts[s] / prMax) * 100), `wr-fill-${k}`)}
              <span class="wr-num">${c.prCounts[s]}</span></div>`).join('')}
            <span class="wr-foot"><span class="wr-foot-main">Estado do Bitbucket onde já foi consultado; senão, o gravado no state.json.</span><span>Fonte: Bitbucket · state.json · <span class="wr-mono">${plural(c.prTotal, 'PR', 'PRs')}</span></span></span>
          </div>
        </div>
      </section>
      <section class="wr-sec wr-sec-rule" aria-labelledby="wr-gt-h">
        ${secHead('wr-gt-h', 'Gates e decisões da semana', 'quanto tempo os runs esperaram por uma pessoa')}
        <div class="wr-grid wr-grid-thirds">
          <div class="wr-card"><span class="wr-k">Gates abertos agora</span><span class="wr-gv">${M.gates.length}</span><span class="wr-gd">${plural(over24, 'passou', 'passaram')} de 24 h</span></div>
        </div>
        ${gates.length ? `<div class="wr-box">${gates.map(g => `<div class="wr-row">
            <span class="wr-mono wr-secondary">${esc(g.id)}</span>
            <span class="wr-row-main wr-row-plain">${esc(g.t)}<span class="wr-row-sub">${esc(g.status)}</span></span>
            <span class="wr-pill wr-pill-waiting wr-num-pill" title="desde a última atualização do state.json do run"><span aria-hidden="true">‖</span>${esc(g.age)}</span>
            <button type="button" class="wr-link" data-wract="open-run" data-task="${esc(g.taskId)}">Decidir</button></div>`).join('')}</div>` : ''}
      </section>`;
  }

  function chart(M) {
    const cost = st.mode === 'cost', vals = M.series.map(x => (cost ? x.cost : x.runs) ?? 0);
    const tk = ticks(Math.max(0, ...vals), { integer: !cost }), top = tk[tk.length - 1] || 1, H = 180;
    const unitAll = M.isAll ? 'semana' : 'dia';
    const title = cost ? `Custo por ${unitAll}` : `Runs concluídos por ${unitAll}`;
    const sub = cost ? `US$ por ${M.isAll ? 'semana registrada' : 'dia, de segunda a domingo'}, em escala de 0 a ${top}` : `quantidade por ${M.isAll ? 'semana registrada' : 'dia, de segunda a domingo'}, em escala de 0 a ${top}`;
    const aria = `${title}: ${M.series.filter(x => !x.future).map(x => `${x.label} ${cost ? money(x.cost) : x.runs}`).join('; ')}`;
    const peak = M.series.reduce((a, x) => (x.cost > (a?.cost ?? -1) ? x : a), null);
    const peakNote = !peak || !(peak.cost > 0) ? '' : M.isAll ? `Semana mais cara: ${peak.label}, ${money(peak.cost)}.` : `Pico em ${peak.label}: ${money(peak.cost)}.`;
    const noCost = M.cur.cost == null && cost;
    return `<div class="wr-chartbox">
      <div class="wr-chart-top"><div class="wr-col-2"><span class="wr-strong">${title}</span><span class="wr-sub">${esc(sub)}</span></div>
        <div class="wr-seg" role="radiogroup" aria-label="Métrica do gráfico">${[['cost', 'Custo'], ['runs', 'Runs']].map(([id, l]) =>
          `<button type="button" role="radio" aria-checked="${st.mode === id}" data-wract="mode" data-v="${id}" class="wr-seg-wide">${l}</button>`).join('')}</div></div>
      ${noCost || !M.series.length ? `<p class="wr-empty">${M.series.length ? 'Nenhum run da janela tem custo em US$ (sem medição).' : 'Nenhum run nesta janela.'}</p>` : `
      <div class="wr-plot"><div class="wr-yaxis" aria-hidden="true">${tk.map(t => `<span style="bottom:${Math.round((t / top) * H)}px">${t}</span>`).join('')}</div>
        <div class="wr-area" role="img" aria-label="${esc(aria)}">${tk.map(t => `<span class="wr-grid-line" aria-hidden="true" style="bottom:${Math.round((t / top) * H)}px"></span>`).join('')}
          <div class="wr-bars">${M.series.map((x, i) => (x.future ? '<div class="wr-bar-col" aria-hidden="true"></div>'
            : cost && x.cost == null ? '<div class="wr-bar-col"><span class="wr-bar-lbl wr-none" title="sem medição" aria-label="sem medição">—</span></div>'
            : `<div class="wr-bar-col"><span class="wr-bar-lbl">${cost ? x.cost.toFixed(2).replace('.', ',') : vals[i]}</span><span class="wr-bar" style="height:${Math.round((vals[i] / top) * H)}px"></span></div>`)).join('')}</div></div></div>
      <div class="wr-plot wr-plot-x"><div class="wr-yaxis-pad"></div><div class="wr-xlabels">${M.series.map(x => `<span>${esc(x.label)}</span>`).join('')}</div></div>
      <div class="wr-legend"><span><span class="wr-sw" aria-hidden="true"></span>${cost ? `custo do ${unitAll} em US$` : `runs concluídos no ${unitAll}`}</span></div>
      ${peakNote ? `<p class="wr-peak">${esc(peakNote)}</p>` : ''}`}
    </div>`;
  }

  function panelCost(M) {
    const c = M.cur, p = M.prev;
    const unpriced = c.runs - c.pricedRuns;
    return `<section class="wr-sec wr-sec-rule" aria-labelledby="wr-cus-h">
      ${secHead('wr-cus-h', 'Custo', 'telemetria dos runs; preço de API por modelo (equivalente, se for assinatura)')}
      <div class="wr-grid wr-grid-300">
        <div class="wr-card wr-card-10"><span class="wr-k">${M.isAll ? 'Total da janela' : 'Total da semana'}</span>
          <span class="wr-big${c.cost == null ? ' wr-none' : ''}"${usdTip(c.cost)}>${esc(money(c.cost))}</span>
          <span class="wr-k">${plural(c.pricedRuns, 'run com custo medido', 'runs com custo medido')}${unpriced ? ` · ${unpriced} sem medição` : ''}</span>
          <span class="wr-kd ${toneCls(M.k.total.tone)}">${esc(M.k.total.t)}</span></div>
        <div class="wr-card wr-card-10"><span class="wr-k">Custo médio por run concluído</span>
          <span class="wr-big-row"><span class="wr-big${c.avg == null ? ' wr-none' : ''}"${usdTip(c.avg)}>${esc(money(c.avg))}</span><span class="wr-mono wr-muted">${M.isAll ? 'sem comparação' : p?.avg != null ? `antes ${esc(money(p.avg))}` : ''}</span></span>
          <span class="wr-kd ${toneCls(M.k.avg.tone)}">${esc(M.k.avg.t)}</span>
          <span class="wr-k">custo dos ${c.avgRuns} runs concluídos ÷ número de runs</span></div>
      </div>
      ${chart(M)}
      <div class="wr-col wr-col-8">
        ${secHead('wr-node-h', 'Custo por nó na semana', 'inclui tentativas e loops; a barra mostra a parte do custo total do escopo', 'h3')}
        <div class="wr-box">${M.nodes.length ? M.nodes.map(n => `<div class="wr-node-row">
            <span class="wr-mono">${esc(n.name)}</span><span class="wr-model" title="${esc(n.modelTip)}">${esc(n.model)}</span>${bar(n.w)}
            <span class="wr-num${n.usd == null ? ' wr-none' : ''}"${usdTip(n.usd)}>${n.usd == null ? 'sem medição' : `${esc(money(n.usd))} · ${pct1(n.pct)}`}</span></div>`).join('')
          : '<p class="wr-empty">Nenhum run da janela tem cost_tracking.</p>'}</div>
        ${unpriced && M.nodes.length ? `<span class="wr-sub">${plural(unpriced, 'run sem custo em US$ fica', 'runs sem custo em US$ ficam')} fora das barras (sem medição).</span>` : ''}
      </div>
      <div class="wr-col wr-col-8">
        ${secHead('wr-st-h', 'Tokens por etapa', 'etapas do grafo, do ticket ao commit; a barra mostra a parte dos tokens medidos na janela', 'h3')}
        <div class="wr-box wr-box-foot">${!c.runs ? '<p class="wr-empty">Nenhum run nesta janela.</p>' : M.stages.map(t => `<div class="wr-stage-row">
            <span class="wr-col-2"><span class="wr-stage-name">${esc(t.name)}</span>${t.note ? `<span class="wr-row-sub">${esc(t.note)}</span>` : ''}</span>${bar(t.w)}
            <span class="wr-num${t.v == null ? ' wr-none' : ''}">${t.v == null ? 'sem medição' : `${tok(t.v)} · ${pct1(t.pct)}`}</span></div>`).join('')}
          <span class="wr-foot">Fonte: state.json · cost_tracking${c.runs - c.tokenRuns ? ` · ${plural(c.runs - c.tokenRuns, 'run sem medição', 'runs sem medição')} de tokens` : ''}</span></div>
      </div>
      <div class="wr-col wr-col-8">
        ${secHead('wr-ty-h', 'Custo por tipo de ticket', 'tipo do ticket no Redmine; a barra mostra a parte do custo medido por run', 'h3')}
        <div class="wr-box wr-box-foot">${M.types.length ? M.types.map(y => `<div class="wr-type-row">
            <span class="wr-stage-name${y.name === 'Sem tipo' ? ' wr-secondary' : ''}">${esc(y.name)}</span>${bar(y.w)}
            <span class="wr-num"${usdTip(y.usd)}>${esc(money(y.usd))} · ${plural(y.runs, 'run', 'runs')}</span></div>`).join('')
          : '<p class="wr-empty">Nenhum run com custo medido nesta janela.</p>'}
          <span class="wr-foot">Fonte: tracker do Redmine + state.json · cost_tracking${unpriced ? ` · ${plural(unpriced, 'run sem custo fica', 'runs sem custo ficam')} fora das barras` : ''}</span></div>
      </div>
    </section>
    ${SCOPE_BY_PROJECT && M.projects.length ? `<section class="wr-sec wr-sec-rule" aria-labelledby="wr-bp-h">
      ${secHead('wr-bp-h', 'Custo por projeto', `participação no total ${M.isAll ? 'da janela' : 'da semana'}, com o custo médio por run`)}
      <div class="wr-proj-box">${M.projects.map(x => `<div class="wr-proj-row">
          <span class="wr-proj-name">${esc(x.name)}</span>${bar(x.w)}
          <span class="wr-num wr-secondary"${usdTip(x.usd)}>${esc(money(x.usd))}${x.avg == null ? '' : ` · ${esc(money(x.avg))}/run`}</span></div>`).join('')}
      </div>
    </section>` : ''}`;
  }

  function panelRework(M) {
    const c = M.cur;
    return `<section class="wr-sec wr-sec-rule" aria-labelledby="wr-ret-h">
      ${secHead('wr-ret-h', 'Retrabalho', 'cada tentativa extra de um nó conta como uma volta (loop)')}
      <div class="wr-grid wr-grid-halves">
        <div class="wr-card"><span class="wr-k">Taxa de loops</span>
          <span class="wr-big-row"><span class="wr-big${c.rate == null ? ' wr-none' : ''}">${c.rate == null ? 'sem medição' : c.rate.toFixed(2).replace('.', ',')}</span><span class="wr-mono wr-muted">loops por run</span></span>
          <span class="wr-k">${c.loops == null ? 'nenhum run concluído com loop_count na janela' : `${plural(c.loops, 'loop', 'loops')} em ${plural(c.loopRuns, 'run concluído', 'runs concluídos')} com telemetria${c.done - c.loopRuns ? ` · ${c.done - c.loopRuns} sem medição` : ''}`}</span>
          <span class="wr-kd ${toneCls(M.k.rate.tone)}">${esc(M.k.rate.t)}</span></div>
      </div>
      ${M.retries.length ? `<div class="wr-box">${M.retries.map(l => `<div class="wr-loop-row">
          <span class="wr-col-2"><span class="wr-mono">${esc(l.name)}</span><span class="wr-row-sub">tentativas extras do nó (state.json.retries)</span></span>
          <span class="wr-mono wr-secondary">${plural(l.loops, 'loop', 'loops')}</span>${bar(l.w, 'wr-fill-waiting')}</div>`).join('')}</div>`
        : `<p class="wr-empty wr-box-empty">${c.runs ? 'Nenhuma tentativa extra registrada nesta janela.' : 'Nenhum run nesta janela.'}</p>`}
    </section>`;
  }

  function panelLearn(L) {
    const ltabs = [['metrics', 'Métricas'], ['patterns', 'Padrões']];
    let body = '';
    if (st.ltab === 'metrics') {
      body = `<div class="wr-l-col">
        <div class="wr-grid wr-grid-190">${L.kpis.map(k => `<div class="wr-card wr-l-card"><span class="wr-l-k">${esc(k.label)}</span><span class="wr-l-v${k.value === 'sem medição' ? ' wr-none' : ''}">${esc(k.value)}</span><span class="wr-l-d ${toneCls(k.tone)}">${esc(k.t)}</span></div>`).join('')}</div>
        <div class="wr-grid wr-grid-420">
          <section class="wr-l-box" aria-labelledby="wr-wk-h"><div class="wr-l-head"><h2 id="wr-wk-h" class="wr-h2">Custo por semana</h2><span class="wr-l-tag">telemetria de custo</span></div>
            ${L.anyWeekCost ? `<div class="wr-l-bars">${L.weeks.map(x => `<span class="wr-l-barcol"><span class="wr-l-bar" title="${esc(x.tip)}" style="height:${x.h}%"></span></span>`).join('')}</div>
            <div class="wr-l-xl">${L.weeks.map(x => `<span>${esc(x.label)}</span>`).join('')}</div>
            <span class="wr-l-legend"><span><span class="wr-sw" aria-hidden="true"></span>custo da semana em US$</span></span>` : '<p class="wr-empty">Nenhum run com custo em US$ nas últimas 8 semanas.</p>'}
          </section>
          <section class="wr-l-box wr-l-box-12" aria-labelledby="wr-md-h"><div class="wr-l-head"><h2 id="wr-md-h" class="wr-h2">Mediana por etapa</h2><span class="wr-l-tag">${L.anyMeasured ? 'watcher · agent_log' : 'estimada pelo agent_log'}</span></div>
            ${L.stages.map(s => `<div class="wr-l-stage"><span class="wr-mono wr-secondary">${esc(s.node)}</span><span class="wr-l-track"><span style="width:${s.pct}%"></span></span>
              ${cellNm(s.time, 'wr-mono wr-r')}${cellNm(s.cost, 'wr-mono wr-r wr-secondary')}${cellNm(s.retry, `wr-mono wr-r wr-l-retry${s.retryPct >= 30 ? ' wr-tone-bad' : ''}`)}</div>`).join('')}
            <span class="wr-sub">Colunas: tempo · custo · taxa de retrabalho que sai da etapa.</span>
          </section>
        </div></div>`;
    } else {
      const P = st.pat;
      const q = st.q.trim().toLowerCase();
      if (!P.data && !P.error) body = '<p class="wr-empty">Carregando memory/patterns.md…</p>';
      else if (P.error) body = `<p class="wr-empty">Não foi possível ler memory/patterns.md: ${esc(P.error)}</p>`;
      else if (!P.data.exists) body = '<p class="wr-empty">memory/patterns.md ainda não existe: o consolidador gera o arquivo depois dos primeiros runs terminados.</p>';
      else {
        const parsed = parsePatterns(P.data.content);
        const items = parsed.items.filter(p => matches(q, p.title, p.where));
        const at = Date.parse(P.data.updatedAt || parsed.generatedAt || '');
        body = `<div class="wr-l-col wr-l-col-14"><span class="wr-l-tag">memory/patterns.md · gerado pelo consolidador a partir do histórico${Number.isFinite(at) && typeof ago === 'function' ? ` · ${esc(ago(new Date(at).toISOString()))}` : ''}</span>
          ${items.length ? `<div class="wr-grid wr-grid-380">${items.map(p => `<article class="wr-l-box wr-l-box-10">
            <div class="wr-l-pt"><h2 class="wr-h2 wr-h2-23">${esc(p.title)}</h2><span class="wr-l-freq wr-l-freq-${p.kind}">${p.total ? `${p.count} de ${p.total} runs` : plural(p.count, 'run', 'runs')}</span></div>
            <span class="wr-l-dots" aria-hidden="true">${patternDots(p).map(d => `<span class="wr-l-dot wr-l-dot-${p.kind}-${d}"></span>`).join('')}</span>
            ${p.where ? `<span class="wr-mono wr-muted">${esc(p.where)}</span>` : ''}
            <a class="wr-l-graph" href="#grafo" data-wract="graph">Ver no grafo</a></article>`).join('')}</div>`
            : `<p class="wr-empty">${q ? `Nenhum padrão com “${esc(st.q)}”.` : 'O arquivo ainda não lista padrões.'}</p>`}</div>`;
      }
    }
    return `<footer class="wr-origin"><span class="wr-eyebrow wr-muted">Origem dos dados</span>
        <p>Runs, custo por nó, tokens, loops, tentativas e mensagens ao agente vêm do state.json de cada run (cost_tracking gravado pelo watcher, retries e human_inputs). PRs vêm do Bitbucket onde já foram consultados, senão do state.json; tickets e tipo do ticket vêm do Redmine. Padrões vêm de memory/patterns.md, gerado pelo consolidador. O run entra na janela pela data da última atualização do state.json; semana de segunda a domingo, fuso de Brasília. Custo é o preço de API por modelo (equivalente, se for assinatura). Esta página é um relatório de leitura: copiar o resumo não altera nenhum run. Os números são sinal, não verdade contábil.</p></footer>
      <section class="wr-sec wr-learn" aria-labelledby="wr-learn-h">
        <span class="wr-col-4"><h2 id="wr-learn-h" class="wr-h2-20">Aprendizado da semana</h2><span class="wr-muted">Padrões, métricas por etapa e comparação com a semana anterior. Antes era a tela Aprendizado.</span></span>
        <div class="wr-l">
          <header class="wr-l-hd"><div class="wr-col-4"><span class="wr-eyebrow wr-muted">Agentes e modelos · histórico</span><h1 class="wr-l-h1">Aprendizado</h1>
            <p class="wr-muted">O que o histórico de runs ensina: onde o tempo e o custo vão e o que se repete.</p></div>
            <label class="wr-l-period">Período <select data-wrperiod>${[['30', 'últimos 30 dias'], ['7', 'últimos 7 dias'], ['all', 'tudo']].map(([v, l]) => `<option value="${v}"${st.period === v ? ' selected' : ''}>${l}</option>`).join('')}</select></label></header>
          <div class="wr-l-tabs" role="tablist" aria-label="Seções do Aprendizado">${ltabs.map(([id, l]) => `<button type="button" role="tab" aria-selected="${st.ltab === id}" data-wract="ltab" data-v="${id}">${l}</button>`).join('')}</div>
          ${body}
        </div>
      </section>`;
  }

  function body(M, q) {
    const hlN = M.highlights.filter(h => matches(q, h.ticket, h.title, h.proj, h.pr)).length;
    const counts = { summary: String(Math.min(hlN, 5)), cost: '', rework: String(M.retries.length || ''), learn: '' };
    const pos = TABS.findIndex(([k]) => k === st.tab) + 1;
    const panel = { summary: () => panelSummary(M, q), cost: () => panelCost(M), rework: () => panelRework(M), learn: () => panelLearn(buildLearning(shown(), env(), { period: st.period })) }[st.tab]();
    return `<div class="wr-tabs-row"><div role="tablist" aria-label="Seções do relatório" class="wr-tabs">${TABS.map(([k, l], i) =>
        `<button type="button" role="tab" id="wr-tab-${k}" aria-selected="${st.tab === k}" aria-controls="wr-panel" data-wract="tab" data-v="${k}"><span class="wr-tab-n">${i + 1}</span>${l}<span class="wr-tab-c">${counts[k]}</span></button>`).join('')}</div>
        <span class="wr-tab-pos">aba ${pos} de ${TABS.length}</span></div>
      ${!M.cur.done ? `<div class="wr-empty-note" role="note"><strong>Nenhum run concluído ${M.isAll ? 'registrado' : st.win === 'prev' ? 'na semana anterior' : 'nesta semana'} para ${esc(M.scopeLabel)}.</strong><span>Para ver runs em andamento, abra <a href="#runs" data-wract="runs">Runs</a>.</span></div>` : ''}
      <div id="wr-panel" role="tabpanel" aria-labelledby="wr-tab-${st.tab}" class="wr-panel">${panel}</div>`;
  }

  let lastModel = null;
  const tabPos = () => TABS.findIndex(([k]) => k === st.tab) + 1;
  // Barra de status do artboard: à esquerda o recorte (ou o aviso da última ação); à direita os atalhos.
  const statusLeft = M => st.toast || `Relatório ${M.range}${M.isAll ? ' · todos os runs' : ''} · ${M.scopeLabel} · aba ${tabPos()} de ${TABS.length}${st.q.trim() ? ` · filtro “${st.q.trim()}”` : ''}`;
  const agoText = () => `atualizado há ${sinceLabel(Date.now() - (st.renderedAt || Date.now()))}`;
  function render() {
    const V = window.Views;
    const b = V?.bulkState?.() || {};
    if (V && runs.size && !b.running && !b.loadedOnce) setTimeout(() => V.loadAll(false), 0);
    if (st.tab === 'learn' && st.ltab === 'patterns' && !st.pat.data && !st.pat.loading && !st.pat.error) loadPatterns();
    // Captura = fim da última consulta a Redmine/Bitbucket (ou a primeira montagem, sem consulta).
    if (b.running) st.wasLoading = true;
    else if (st.wasLoading || !st.capturedAt) { st.capturedAt = Date.now(); st.wasLoading = false; }
    st.renderedAt = Date.now();
    const all = shownAll();
    const locs = [...new Set(all.map(r => r.location).filter(Boolean))].sort((a, b) => a.localeCompare(b));
    // Projeto salvo que sumiu dos runs volta a "todos" (só depois que há runs, para não perder a preferência na carga).
    if (all.length && st.scope !== 'all' && !locs.includes(st.scope)) st.scope = 'all';
    const M = model();
    lastModel = M;
    const eyebrow = SCOPE_BY_PROJECT && st.scope !== 'all' ? st.scope : '';
    const errs = V?.bulkErrors?.() || { tickets: 0, prs: 0 };
    const health = !M.cur.runs ? { k: 'queued', glyph: '○', label: 'Sem runs' }
      : errs.tickets || errs.prs ? { k: 'partial', glyph: '‖', label: 'Dados parciais',
        note: `A consulta falhou para ${[errs.tickets ? plural(errs.tickets, 'ticket no Redmine', 'tickets no Redmine') : '', errs.prs ? plural(errs.prs, 'run no Bitbucket', 'runs no Bitbucket') : ''].filter(Boolean).join(' e ')}. Tickets fechados e estados de PR podem estar incompletos; custo e tokens vêm do state.json.` }
      : st.win === 'prev' ? { k: 'done', glyph: '✓', label: 'Fechado' }
      : st.win === 'cur' ? { k: 'running', glyph: '◐', label: 'Em andamento' } : { k: 'done', glyph: '✓', label: 'Todos os runs' };
    const info = b.running ? esc(`consultando Redmine e Bitbucket… ${b.done}/${b.total}`)
      : `dados capturados em ${esc(captureLabel(st.capturedAt))} · <span data-wr-ago>${esc(agoText())}</span>`;
    return `<div class="wr-screen" tabindex="-1" aria-label="Relatório semanal. J e K percorrem as abas, 1 a ${TABS.length} pulam direto, Esc volta ao Resumo ou limpa o filtro.">
      ${head(M, eyebrow, health, info, locs)}<div class="wr-body">${body(M, st.q.trim().toLowerCase())}</div>
      <footer class="wr-status"><span role="status" class="${st.toast ? 'wr-status-toast' : ''}" data-wr-status>${esc(statusLeft(M))}</span><span class="wr-status-keys">J K abas · 1–${TABS.length} · Esc volta ao Resumo · ⌘K paleta</span></footer></div>`;
  }
  // "atualizado há N s" anda sozinho, sem re-renderizar a tela (não tira o foco de nenhum campo).
  setInterval(() => {
    const el = document.querySelector('.wr-screen [data-wr-ago]');
    if (el) el.textContent = agoText();
  }, 1000);

  async function loadPatterns() {
    st.pat.loading = true;
    try { st.pat.data = await api('/api/patterns'); } catch (e) { st.pat.error = e.message; }
    st.pat.loading = false;
    window.Views?.refresh();
  }
  const refresh = () => window.Views?.refresh();
  // Filtro: re-renderiza só o corpo e a barra de status, para o campo não perder o foco nem o cursor.
  function rerenderBody() {
    const el = document.querySelector('.wr-screen .wr-body');
    if (!el || !lastModel) return;
    const M = model();
    el.innerHTML = body(M, st.q.trim().toLowerCase());
    const sb = document.querySelector('.wr-screen [data-wr-status]');
    if (sb) { sb.textContent = statusLeft(M); sb.className = st.toast ? 'wr-status-toast' : ''; }
  }
  function setTab(k) { if (TABS.some(([t]) => t === k)) { st.tab = k; st.toast = ''; refresh(); } }

  async function copy() {
    const M = lastModel || model();
    const text = copyText(M, M.scopeLabel);
    let ok = false;
    try { await navigator.clipboard.writeText(text); ok = true; } catch {
      try {
        const ta = document.createElement('textarea');
        ta.value = text; ta.setAttribute('readonly', ''); ta.style.position = 'fixed'; ta.style.opacity = '0';
        document.body.appendChild(ta); ta.select(); ok = document.execCommand('copy'); ta.remove();
      } catch { ok = false; }
    }
    st.copied = ok ? 'ok' : 'fail';
    refresh();
    clearTimeout(copy.t); copy.t = setTimeout(() => { st.copied = ''; refresh(); }, 4000);
  }

  const inScreen = el => el?.closest?.('.wr-screen');
  document.addEventListener('click', e => {
    const a = e.target.closest?.('[data-wract]');
    if (!a || !inScreen(a)) return;
    const v = a.dataset.v;
    switch (a.dataset.wract) {
      case 'win': st.win = v; st.toast = `Janela: ${(WINS.find(([id]) => id === v) || [])[1] || v}`; save(); refresh(); break;
      case 'tab': setTab(v); break;
      case 'mode': st.mode = v; refresh(); break;
      case 'ltab': st.ltab = v; refresh(); break;
      case 'copy': copy(); break;
      case 'open-run': window.Views?.openRun(a.dataset.task); break;
      case 'graph': e.preventDefault(); window.Views?.setView('grafo'); break;
      case 'runs': e.preventDefault(); window.Views?.setView('runs'); break;
    }
  });
  document.addEventListener('input', e => {
    if (!e.target.matches?.('[data-wrq]')) return;
    st.q = e.target.value;
    rerenderBody();
  });
  document.addEventListener('change', e => {
    if (e.target.matches?.('[data-wrscope]') && inScreen(e.target)) {
      st.scope = e.target.value; st.toast = `Escopo: ${scopeLabelOf()}`; save(); refresh(); return;
    }
    if (!e.target.matches?.('[data-wrperiod]')) return;
    st.period = e.target.value;
    refresh();
  });
  // Atalhos do artboard: 1–4 abas, J/K anterior/próxima, Esc volta ao Resumo ou limpa o filtro.
  document.addEventListener('keydown', e => {
    if (window.Views?.current?.() !== 'metricas' || e.metaKey || e.ctrlKey || e.altKey) return;
    const t = e.target;
    if (!inScreen(t) && t !== document.body) return;
    if (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName || '')) {
      if (e.key === 'Escape' && t.matches?.('[data-wrq]') && st.q) { st.q = ''; t.value = ''; st.toast = 'Filtro limpo'; rerenderBody(); e.preventDefault(); }
      return;
    }
    const order = TABS.map(([k]) => k), i = order.indexOf(st.tab);
    if (e.key >= '1' && e.key <= String(order.length)) { e.preventDefault(); setTab(order[+e.key - 1]); }
    else if (e.key === 'j' || e.key === 'k') { e.preventDefault(); setTab(order[Math.max(0, Math.min(order.length - 1, i + (e.key === 'j' ? 1 : -1)))]); }
    else if (e.key === 'Escape' && inScreen(t)) {
      if (st.q) { st.q = ''; st.toast = 'Filtro limpo'; refresh(); e.preventDefault(); } else if (st.tab !== 'summary') { setTab('summary'); e.preventDefault(); }
    }
  });

  root.WeeklyReportView = { render, state: st };
})(typeof window !== 'undefined' ? window : globalThis);
