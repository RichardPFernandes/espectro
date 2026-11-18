// Camada de dados da página do roadmap: lê roadmap/fase-N-*/FASE.md (e arquivo/) e devolve
// { phases: [{ n, name, file, status, start, end, slices }] } ordenado por fase.
// Só lê arquivos. Reaproveita o parser do lint; as colunas são achadas pelo NOME do
// cabeçalho, nunca pela posição: coluna nova ou ausente não quebra o gerador.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { STATUS_VOCAB, parseTables, parseSlices } = require('./roadmap-lint');

const DATES = /(\d{2})\/(\d{2})(?:\/(\d{4}))? a (\d{2})\/(\d{2})\/(\d{4})/;
const plain = s => String(s || '').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/[*_~`]/g, '').trim();

// Primeiro bloco `>` do arquivo, em uma linha só.
const firstQuote = text => (/^(?:>.*(?:\r?\n|$))+/m.exec(text) || [''])[0].replace(/^>\s?/gm, '').replace(/\s+/g, ' ');

function parsePhase(text, file) {
    const quote = firstQuote(text);
    const [, d1, m1, y1, d2, m2, y2] = DATES.exec(quote) || [];
    const iso = (y, m, d) => `${y}-${m}-${d}`;
    return {
        n: Number(/fase-(\d+)-/.exec(file)[1]),
        name: ((/^#\s+Fase\s+\d+\s+—\s*(.+)$/m.exec(text) || [])[1] || '').trim(),
        file,
        status: (/Status:\s*([^·.\n]+)/.exec(quote) || [])[1]?.trim() || null,
        start: y2 ? iso(y1 || (Number(m1) > Number(m2) ? y2 - 1 : y2), m1, d1) : null,
        end: y2 ? iso(y2, m2, d2) : null,
        slices: parseSiteSlices(text, file),
    };
}

function parseSiteSlices(text, file) {
    // Linhas das tabelas de fatias, por número de linha, com acesso às colunas pelo nome.
    const byLine = new Map();
    for (const { headers, rows } of parseTables(text)) {
        if (!headers.includes('id')) continue;
        const col = pred => headers.findIndex(pred);
        const idx = {
            name: col(h => h.startsWith('fatia')), dias: col(h => h.startsWith('dias')),
            nivel: col(h => h === 'nível' || h === 'nivel'), autorizo: col(h => h === 'autorizo'),
            issue: col(h => h.startsWith('issue no linear')),
        };
        for (const { cells, line } of rows) {
            const get = key => (idx[key] < 0 ? '' : plain(cells[idx[key]]));
            byLine.set(line, { name: get('name'), dias: get('dias'), nivel: get('nivel'), autorizo: get('autorizo'), issue: get('issue') });
        }
    }
    return parseSlices(text, file).map(({ id, phase, deps, status, line }) => {
        const c = byLine.get(line);
        const nums = c.dias.match(/\d+/g);
        return {
            id, phase, name: c.name,
            dias: nums ? nums.reduce((sum, n) => sum + Number(n), 0) : null,
            nivel: c.nivel, autorizo: c.autorizo,
            alto: /^alto/i.test(c.nivel) || /^sim/i.test(c.autorizo),
            status: STATUS_VOCAB.find(term => (status || '').startsWith(term)) || status,
            deps, issue: c.issue,
        };
    });
}

/** Lê o roadmap sob `root`. @returns {{phases: Array}} */
function loadRoadmap(root) {
    const dirs = base => {
        const dir = path.join(root, base);
        if (!fs.existsSync(dir)) return [];
        return fs.readdirSync(dir, { withFileTypes: true })
            .filter(e => e.isDirectory() && /^fase-\d+-/.test(e.name)).map(e => `${base}/${e.name}/FASE.md`);
    };
    const phases = [...dirs('roadmap'), ...dirs('roadmap/arquivo')]
        .filter(file => fs.existsSync(path.join(root, file)))
        .map(file => parsePhase(fs.readFileSync(path.join(root, file), 'utf8'), file));
    return { phases: phases.sort((a, b) => a.n - b.n) };
}

// ---- Página HTML: um arquivo só, sem rede nem JS ----
const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const br = iso => (iso ? iso.split('-').reverse().join('/') : 'sem data');
const day = iso => Date.parse(iso) / 864e5;
const cls = status => `s${Math.max(0, STATUS_VOCAB.indexOf(status))}`;
const tag = status => `<span class="tag ${cls(status)}">${esc(status)}</span>`;
const ACTIVE = ['em andamento', 'em spec', 'ligada'];
const CSS = `:root{color-scheme:light dark;--bg:#fff;--fg:#1f2328;--mut:#59636e;--line:#d1d9e0;--c0:#6b7280;--c1:#7c3aed;--c2:#b45309;--c3:#0369a1;--c4:#15803d;--c5:#9ca3af;--hj:#c2185b}
@media (prefers-color-scheme: dark){:root{--bg:#0d1117;--fg:#e6edf3;--mut:#9198a1;--line:#3d444d;--c0:#9ca3af;--c1:#a78bfa;--c2:#f59e0b;--c3:#38bdf8;--c4:#4ade80;--c5:#6b7280;--hj:#f472b6}}
*{box-sizing:border-box}body{margin:0 auto;max-width:72rem;padding:0 16px 3rem;background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,sans-serif;overflow-wrap:anywhere}
h1{margin:1.5rem 0 .25rem}h2{margin:2rem 0 .75rem;font-size:1.25rem}.mut{color:var(--mut);margin:.25rem 0}
.s0{--c:var(--c0)}.s1{--c:var(--c1)}.s2{--c:var(--c2)}.s3{--c:var(--c3)}.s4{--c:var(--c4)}.s5{--c:var(--c5)}
.tag,.lg span{display:inline-block;padding:0 .5rem;border:1px solid var(--c);border-radius:.4rem;background:color-mix(in srgb,var(--c) 18%,var(--bg));font-size:.85rem}
.s0.tag,.lg .s0{border-style:dashed}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(16rem,1fr));gap:1rem}
.card{border:1px solid var(--line);border-radius:.6rem;padding:.75rem 1rem}.card h3{margin:0 0 .25rem;font-size:1.05rem}
.pb{display:flex;height:.7rem;margin:.5rem 0;border-radius:.35rem;overflow:hidden;background:color-mix(in srgb,var(--c0) 20%,var(--bg))}
.pb i:nth-child(1){background:var(--c4)}.pb i:nth-child(2){background:var(--c2)}
details ul{padding-left:1.1rem;margin:.5rem 0 0}li{margin:.2rem 0}
.rola{overflow-x:auto;max-width:100%}.tl{padding-right:2.5rem}.row{display:grid;grid-template-columns:2.5rem 1fr;align-items:center}
.tr{position:relative;height:1.6rem}.ax{height:2.2rem}.ax b,.ax em{position:absolute;font-size:.7rem;white-space:nowrap;font-style:normal}.ax b{top:0}.ax em{bottom:0;color:var(--hj);transform:translateX(-50%)}
.bar{position:absolute;top:.3rem;height:1rem;border:1px solid var(--c);border-radius:.3rem;background:color-mix(in srgb,var(--c) 18%,var(--bg));overflow:hidden}.s0.bar{border-style:dashed}.bar b{display:block;height:100%;background:color-mix(in srgb,var(--c) 55%,var(--bg))}
.hoje{position:absolute;top:0;bottom:0;width:2px;background:var(--hj)}
svg{display:block;min-width:640px;width:100%;height:auto}.n rect{fill:color-mix(in srgb,var(--c) 18%,var(--bg));stroke:var(--c);stroke-width:1.5}.n.s0 rect{stroke-dasharray:4 2}.n text,.cl{fill:var(--fg);font:10px system-ui,sans-serif;text-anchor:middle;dominant-baseline:central}
.e{fill:none;stroke:var(--mut);opacity:.45}.lg{margin:.5rem 0}.lg span{margin:0 .5rem .25rem 0}
table{border-collapse:collapse;width:100%}th,td{border-bottom:1px solid var(--line);padding:.3rem .5rem;text-align:left}th,td:not(:nth-child(2)):not(:nth-child(7)){white-space:nowrap}`;

function progress(slices) {
    const sum = pred => slices.filter(pred).reduce((t, s) => t + (s.dias || 0), 0);
    const live = slices.filter(s => s.status !== 'removida');
    const [done, active, todo] = [sum(s => s.status === 'concluída'), sum(s => ACTIVE.includes(s.status)), sum(s => s.status === 'não iniciada')];
    return { done, total: done + active + todo, active, todo, unknown: live.filter(s => s.dias == null).length };
}

function renderCards(phases) {
    return phases.map(p => {
        const g = progress(p.slices), pct = n => (g.total ? (100 * n / g.total).toFixed(1) : 0);
        const items = p.slices.map(s => `<li data-id="${esc(s.id)}" data-status="${esc(s.status)}"><b>${esc(s.id)}</b> ${esc(s.name)} ${tag(s.status)} · ${s.dias == null ? 'sem dias' : `${s.dias} dias`} · ${esc(s.nivel || 'sem nível')}</li>`).join('');
        return `<article class="card" data-done="${g.done}" data-total="${g.total}"><h3>Fase ${p.n} · ${esc(p.name)}</h3>
<p class="mut">${tag(p.status || 'não iniciada')} ${p.start ? `${br(p.start)} a ${br(p.end)}` : 'sem data'}</p>
<div class="pb"><i style="width:${pct(g.done)}%"></i><i style="width:${pct(g.active)}%"></i><i style="width:${pct(g.todo)}%"></i></div>
<p class="mut">${g.done} de ${g.total} dias concluídos (${Math.round(g.total ? 100 * g.done / g.total : 0)}%)${g.unknown ? ` · ${g.unknown} fatia${g.unknown > 1 ? 's' : ''} sem estimativa` : ''}</p>
<details><summary>${p.slices.length} fatias</summary><ul>${items}</ul></details></article>`;
    }).join('\n');
}

function renderTimeline(phases, today) {
    const dated = phases.filter(p => p.start && p.end);
    const t0 = Math.min(day(today), ...dated.map(p => day(p.start))), span = Math.max(1, Math.max(...dated.map(p => day(p.end))) - t0);
    const pos = d => Math.min(100, Math.max(0, (100 * (d - t0) / span))).toFixed(2);
    const hoje = `<i class="hoje" style="left:${pos(day(today))}%"></i>`;
    const months = [], MES = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
    const first = new Date(t0 * 864e5);
    for (let m = Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), 1); m / 864e5 <= t0 + span; m = new Date(m).setUTCMonth(new Date(m).getUTCMonth() + 1)) {
        const d = new Date(m);
        if (m / 864e5 >= t0) months.push(`<b style="left:${pos(m / 864e5)}%">${MES[d.getUTCMonth()]}/${String(d.getUTCFullYear()).slice(2)}</b>`);
    }
    const rows = dated.map(p => {
        const g = progress(p.slices), [a, b] = [day(p.start), day(p.end)];
        return `<div class="row"><span>F${p.n}</span><div class="tr">${hoje}<div class="bar ${cls(p.status)}" style="left:${pos(a)}%;width:${(pos(b) - pos(a)).toFixed(2)}%" title="${esc(p.name)}: ${br(p.start)} a ${br(p.end)}"><b style="width:${g.total ? (100 * g.done / g.total).toFixed(1) : 0}%"></b></div></div></div>`;
    });
    const undated = phases.filter(p => !(p.start && p.end)).map(p => `<div class="row"><span>F${p.n}</span><span class="mut">sem data</span></div>`);
    return `<div class="tl"><div class="row"><span></span><div class="tr ax">${months.join('')}<em style="left:${pos(day(today))}%">hoje</em></div></div>\n${[...rows, ...undated].join('\n')}</div>`;
}

function renderGraph(phases) {
    const at = new Map(), W = 84, rows = Math.max(1, ...phases.map(p => p.slices.length));
    phases.forEach((p, i) => p.slices.forEach((s, j) => at.set(s.id, { x: 48 + i * W, y: 30 + j * 28, s })));
    const edges = [...at.values()].flatMap(({ x, y, s }) => s.deps.filter(d => at.has(d)).map(d => {
        const f = at.get(d), same = f.x === x, x0 = same ? f.x : f.x + 54, c = same ? -24 : 30;
        return `<path class="e" d="M${x0} ${f.y + 11}C${x0 + c} ${f.y + 11} ${x - (same ? 24 : 30)} ${y + 11} ${x} ${y + 11}"/>`;
    }));
    const nodes = [...at.values()].map(({ x, y, s }) => `<g class="n ${cls(s.status)}"><title>${esc(`${s.id} · ${s.name} · ${s.status}`)}</title><rect x="${x}" y="${y}" width="54" height="22" rx="5"/><text x="${x + 27}" y="${y + 11}">${esc(s.id)}</text></g>`);
    const heads = phases.map((p, i) => `<text class="cl" x="${48 + i * W + 27}" y="12">F${p.n}</text>`);
    const legend = STATUS_VOCAB.map(t => `<span class="${cls(t)}">${t}</span>`).join('');
    return `<div class="lg">${legend} (borda tracejada: não iniciada)</div>
<div class="rola"><svg viewBox="0 0 ${64 + phases.length * W} ${40 + rows * 28}" role="img" aria-label="Grafo de dependências entre fatias">${heads.join('')}${edges.join('')}${nodes.join('')}</svg></div>`;
}

/** Monta a página. @returns {string} HTML */
function render(model, { today, commit, generatedAt }) {
    const { phases } = model, sha = /^[0-9a-f]{7,}$/i.test(commit) ? commit.slice(0, 7) : commit;
    const alto = phases.flatMap(p => p.slices).filter(s => s.alto);
    const table = alto.length ? `<div class="rola"><table><tr><th>ID</th><th>Fatia</th><th>Fase</th><th>Nível</th><th>AUTORIZO</th><th>Status</th><th>Issue</th></tr>${alto.map(s => `<tr><td>${esc(s.id)}</td><td>${esc(s.name)}</td><td>${s.phase}</td><td>${esc(s.nivel)}</td><td>${esc(s.autorizo)}</td><td>${tag(s.status)}</td><td>${esc(s.issue)}</td></tr>`).join('')}</table></div>` : '<p>Nenhuma.</p>';
    return `<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Roadmap do Espectro</title><style>${CSS}</style></head><body>
<header><h1>Roadmap do Espectro</h1><p class="mut">Hoje: ${br(today)} · Gerado em ${esc(generatedAt)} do commit ${esc(sha)}</p>
<p class="mut">Fonte: <code>ROADMAP.md</code> e <code>roadmap/fase-*/FASE.md</code>. A página muda sozinha a cada merge na main.</p></header>
<section id="progresso"><h2>Progresso por fase</h2><div class="grid">${renderCards(phases)}</div></section>
<section id="linha-do-tempo"><h2>Linha do tempo</h2>${renderTimeline(phases, today)}</section>
<section id="grafo"><h2>Grafo de dependências</h2>${renderGraph(phases)}</section>
<section id="alto"><h2>Fatias Alto (pedem AUTORIZO)</h2>${table}</section>
</body></html>
`;
}

/** CLI: node roadmap-site.js <raiz> <saida>; saida é diretório (index.html) ou arquivo .html. */
function main([root, out]) {
    if (!root || !out) { console.error('uso: node scripts/lib/roadmap-site.js <raiz> <saida>'); process.exit(2); }
    let commit = process.env.GITHUB_SHA;
    if (!commit) {
        try { commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { /* sem git */ }
    }
    const iso = new Date().toISOString(), model = loadRoadmap(root);
    const html = render(model, { today: iso.slice(0, 10), commit: commit || 'desconhecido', generatedAt: `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC` });
    const file = out.endsWith('.html') ? out : path.join(out, 'index.html');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, html);
    console.log(`${file}: ${model.phases.flatMap(p => p.slices).length} fatias`);
}

if (require.main === module) main(process.argv.slice(2));

module.exports = { loadRoadmap, render, main };
