// Consolidador periódico de padrões de falha/custo do histórico do grafo
// (memory/runs/*/state.json) em memory/patterns.md, pro nó /plan já começar uma
// tarefa nova sabendo o que historicamente deu problema.
//
// Fontes de dado REAIS deste projeto (confirmado por leitura direta antes de
// escrever este arquivo — ver memory/runs/2026-09-26-memory-consolidator-padroes-falha/context.md):
// - `state.json.retries` (contagem por nó: review/test/verify) e, como fallback pra
//   runs mais antigos sem esse campo, notas "REPROVADO" em `agent_log` — não existe
//   "review-result.md" neste histórico.
// - `state.json.agent_log[].note` (texto livre do /review) — às vezes cita
//   "item N, <achado>", mas o N não é comparável entre notas (checklist fixo de 7
//   itens do /review vs. checklist de subagente de domínio); só o nome do achado
//   ao lado é o sinal estável.
// - `## Decisões de Implementação` de memory/spec/*.md (templates/spec-decisions-section.md)
//   — pode não existir nenhuma ainda; o script degrada graciosamente.
// - "tipo de arquivo" não é rastreado em state.json (isso só existe agregado em
//   memory/knowledge-graph.json); o proxy usado é o módulo de negócio (nomes de
//   memory/spec/index.yaml > modules, em estilo "track/calculofrete"), inferido por
//   palavra-chave a partir de scope + redmine_ticket.subject.
//
// Restrições (ticket): roda em < 5s para até 100 runs; NUNCA apaga/move arquivo de
// memory/runs/ — este script só LÊ ali, e só ESCREVE em memory/patterns.md (e,
// via maybeRun, memory/consolidator-state.json).
'use strict';

const fs = require('fs');
const path = require('path');

const GENERIC_SIGNATURE = 'lógica de negócio / regra de domínio (sem item de checklist citado)';
const TERMINAL_STATUSES = new Set(['committed', 'fully_merged', 'completed']);

// Nomes em memory/spec/index.yaml > modules, normalizados em estilo "track/calculofrete"
// (bate com o exemplo da descrição da tarefa). Heurística sobre texto livre — não é
// uma classificação exaustiva nem autoritativa, só um agrupamento útil.
const MODULE_KEYWORDS = [];

function moduleKeywords(opts = {}) {
    if (opts.moduleKeywords) return opts.moduleKeywords;
    const file = opts.moduleKeywordsFile || process.env.CONSOLIDATOR_MODULE_KEYWORDS_FILE;
    if (!file) return MODULE_KEYWORDS;
    const root = opts.repoRoot || process.env.REPO_PATH || process.cwd();
    return JSON.parse(fs.readFileSync(path.resolve(root, file), 'utf8'))
        .map(([label, source, flags = 'i']) => [label, new RegExp(source, flags)]);
}

function isCompleted(state) {
    return TERMINAL_STATUSES.has(state && state.status);
}

// memory/runs/<taskId>/state.json (ativos) + memory/runs/_archive/<taskId>/state.json
// (arquivados pelo /commit). Outros arquivos soltos direto em memory/runs/ (*.log,
// *-cost.json, *-spec-gate.json, ...) não são diretórios de run — ignorados.
function listRunDirs(runsDir) {
    const out = [];
    const scan = (dir, archived) => {
        let entries;
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
        for (const e of entries) {
            if (!e.isDirectory() || e.name === '_archive') continue;
            out.push({ taskId: e.name, dir: path.join(dir, e.name), archived });
        }
    };
    scan(runsDir, false);
    scan(path.join(runsDir, '_archive'), true);
    return out;
}

function readJsonSafe(p) {
    try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

function collectRuns(runsDir) {
    const runs = [];
    for (const { taskId, dir, archived } of listRunDirs(runsDir)) {
        const state = readJsonSafe(path.join(dir, 'state.json'));
        if (!state) continue;
        runs.push({ taskId, dir, archived, state });
    }
    return runs;
}

// Maior retry entre os nós com loop (review/test/verify); fallback pra runs sem
// `retries` (mais antigos): número de notas "REPROVADO" distintas no agent_log.
// Só conta como veredito de review a nota de um agent_log entry cujo `nodes`
// realmente inclui "review" — sem isso, qualquer nota de outro nó que só MENCIONE
// a palavra "reprovado" (ex.: um /plan comentando o histórico de reprovações, como
// este próprio run fez) seria lida como uma reprovação nova. Bug real encontrado
// rodando o script contra o histório real antes deste ajuste.
function isReviewVerdictEntry(entry) {
    return !!entry && typeof entry.note === 'string' && Array.isArray(entry.nodes)
        && entry.nodes.includes('review') && /reprovad/i.test(entry.note);
}

function loopCountOf(state) {
    const retries = state.retries;
    if (retries && typeof retries === 'object' && !Array.isArray(retries)) {
        const vals = Object.values(retries).filter(v => typeof v === 'number' && !Number.isNaN(v));
        if (vals.length) return Math.max(0, ...vals);
    }
    return (state.agent_log || []).filter(isReviewVerdictEntry).length;
}

function scopeText(state) {
    const scope = state.scope;
    if (typeof scope === 'string') return scope;
    if (scope && typeof scope === 'object') { try { return JSON.stringify(scope); } catch { return ''; } }
    return '';
}

function textOf(state) {
    return [scopeText(state), state.redmine_ticket && state.redmine_ticket.subject].filter(Boolean).join(' \n ');
}

function classifyModule(text, keywords = MODULE_KEYWORDS) {
    if (!text) return null;
    for (const [label, re] of keywords) if (re.test(text)) return label;
    return null;
}

// "schema-guardian (item 1, codSap): achado..." -> "codSap". Sem esse formato
// (típico de reprovação por lógica de negócio, sem checklist fixo), cai no
// GENERIC_SIGNATURE.
function reviewSignatureOf(note) {
    const m = /item\s+\d+\s*,\s*([^\s)]+)/i.exec(note);
    return m ? m[1] : null;
}

// Agrega por RUN (task_id), não por nota: um run reprovado 3x pelo mesmo motivo
// (ex.: retrabalho em rodadas sucessivas) conta 1, não 3.
function reviewFailurePatterns(runs) {
    const reviewedTaskIds = new Set();
    const perRunSignatures = new Map();
    for (const { taskId, state } of runs) {
        if ((state.history || []).includes('review')) reviewedTaskIds.add(taskId);
        for (const entry of state.agent_log || []) {
            if (!isReviewVerdictEntry(entry)) continue;
            reviewedTaskIds.add(taskId);
            const sig = reviewSignatureOf(entry.note) || GENERIC_SIGNATURE;
            if (!perRunSignatures.has(taskId)) perRunSignatures.set(taskId, new Set());
            perRunSignatures.get(taskId).add(sig);
        }
    }
    const counts = new Map();
    for (const [taskId, sigs] of perRunSignatures) {
        for (const sig of sigs) {
            if (!counts.has(sig)) counts.set(sig, { count: 0, examples: [] });
            const c = counts.get(sig);
            c.count += 1;
            if (c.examples.length < 3) c.examples.push(taskId);
        }
    }
    const totalReviewedRuns = reviewedTaskIds.size || perRunSignatures.size;
    return [...counts.entries()]
        .map(([signature, v]) => ({ signature, count: v.count, totalReviewedRuns, examples: v.examples }))
        .sort((a, b) => b.count - a.count || a.signature.localeCompare(b.signature));
}

// Só runs com loop_count > 1 (título da seção pedida), agrupados pelo módulo
// inferido do texto do run.
function highCostPatterns(runs, keywords = MODULE_KEYWORDS) {
    const perModule = new Map();
    for (const { state } of runs) {
        const loops = loopCountOf(state);
        if (loops <= 1) continue;
        const label = classifyModule(textOf(state), keywords) || 'outros/não classificado';
        if (!perModule.has(label)) perModule.set(label, { sum: 0, n: 0 });
        const b = perModule.get(label);
        b.sum += loops; b.n += 1;
    }
    return [...perModule.entries()]
        .map(([label, v]) => ({ label, avgLoops: v.sum / v.n, n: v.n }))
        .sort((a, b) => b.avgLoops - a.avgLoops || b.n - a.n);
}

// Lê "## Decisões de Implementação" de memory/spec/*.md (templates/spec-decisions-section.md).
// Nenhuma spec real tem essa seção ainda neste histórico — retorna [] graciosamente,
// nunca fabrica dado.
function decisionPatterns(repoRoot) {
    const specDir = path.join(repoRoot, 'memory', 'spec');
    const out = [];
    let files;
    try { files = fs.readdirSync(specDir).filter(f => f.endsWith('.md')); } catch { return out; }
    for (const f of files) {
        let content;
        try { content = fs.readFileSync(path.join(specDir, f), 'utf8'); } catch { continue; }
        const idx = content.indexOf('## Decisões de Implementação');
        if (idx === -1) continue;
        const section = content.slice(idx);
        for (const m of section.matchAll(/^-\s*\*\*Decisão\*\*:\s*(.+)$/gm)) {
            out.push({ file: f, decision: m[1].trim() });
        }
    }
    return out;
}

function recommendations(reviewPatterns, decisions, highCost) {
    const recs = [];
    for (const p of reviewPatterns.slice(0, 3)) {
        if (p.signature === GENERIC_SIGNATURE) {
            recs.push(`Specs de regras de negócio complexas deveriam registrar explicitamente os casos-limite esperados nos Critérios de Aceite — ${p.count}/${p.totalReviewedRuns} run(s) revisado(s) reprovado(s) por lógica de negócio não coberta pela spec original (ex.: ${p.examples.join(', ')}).`);
        } else {
            recs.push(`Tasks que tocam "${p.signature}" deveriam especificar isso explicitamente na spec (Critérios de Aceite/Restrições) — reprovado em ${p.count}/${p.totalReviewedRuns} run(s) revisado(s) por esse motivo (ex.: ${p.examples.join(', ')}).`);
        }
    }
    for (const d of decisions.slice(0, 3)) {
        recs.push(`Decisão de implementação recorrente em ${d.file}: "${d.decision}" — considerar deixar isso explícito já na spec inicial de tasks parecidas.`);
    }
    for (const p of highCost.slice(0, 2)) {
        if (recs.length >= 8) break;
        recs.push(`Tasks tocando \`${p.label}/\` custaram em média ${p.avgLoops.toFixed(1)} loop(s) de review/test/verify (${p.n} run(s)) — revisar se a spec dessas tasks costuma sair ambígua ou incompleta.`);
    }
    if (!recs.length) {
        recs.push('Nenhum padrão de falha de review nem decisão de implementação divergente registrada até agora — histórico ainda pequeno ou specs bem escritas; reavaliar quando houver mais runs.');
    }
    return recs;
}

function renderPatternsMarkdown({ reviewPatterns, highCostPatterns: highCost, decisionPatterns: decisions, recs, meta }) {
    const lines = [];
    lines.push('# Padrões Identificados');
    lines.push('');
    lines.push(`<!-- Gerado automaticamente por scripts/memory-consolidator.js — não editar à mão, a próxima consolidação sobrescreve. Heurística sobre texto livre (scope/agent_log), não é auditoria exaustiva. ${meta.totalRuns} run(s) analisado(s) (${meta.completedRuns} completado(s)) em ${meta.runsDir}. Gerado em ${meta.generatedAt}. -->`);
    lines.push('');
    lines.push('## Padrões de Falha no Review');
    if (reviewPatterns.length) {
        for (const p of reviewPatterns.slice(0, 10)) {
            lines.push(`- **${p.signature}**: ocorreu em ${p.count}/${p.totalReviewedRuns} run(s) revisado(s)${p.examples.length ? ` (ex.: ${p.examples.join(', ')})` : ''}`);
        }
    } else {
        lines.push('- Nenhuma reprovação de review registrada no histórico atual.');
    }
    lines.push('');
    lines.push('## Runs de Alto Custo (loop_count > 1)');
    if (highCost.length) {
        for (const p of highCost.slice(0, 10)) {
            lines.push(`- Runs tocando \`${p.label}/\`: média ${p.avgLoops.toFixed(1)} loops (${p.n} run(s))`);
        }
    } else {
        lines.push('- Nenhum run com loop_count > 1 no histórico atual.');
    }
    lines.push('');
    lines.push('## Recomendações para Specs Futuras');
    for (const r of recs) lines.push(`- ${r}`);
    lines.push('');
    lines.push(`<!-- metadata: generated_at=${meta.generatedAt} runs_analyzed=${meta.totalRuns} completed_runs=${meta.completedRuns} decisions_found=${decisions.length} source=scripts/memory-consolidator.js -->`);
    lines.push('');
    return lines.join('\n');
}

function consolidate(opts = {}) {
    const repoRoot = opts.repoRoot || process.env.REPO_PATH || process.cwd();
    const runsDir = opts.runsDir || path.join(repoRoot, 'memory', 'runs');
    const patternsPath = opts.patternsPath || path.join(repoRoot, 'memory', 'patterns.md');

    const runs = collectRuns(runsDir);
    const reviewPatterns = reviewFailurePatterns(runs);
    const highCost = highCostPatterns(runs, moduleKeywords({ ...opts, repoRoot }));
    const decisions = decisionPatterns(repoRoot);
    const recs = recommendations(reviewPatterns, decisions, highCost);
    const meta = {
        generatedAt: new Date().toISOString(),
        totalRuns: runs.length,
        completedRuns: runs.filter(r => isCompleted(r.state)).length,
        runsDir: path.relative(repoRoot, runsDir) || 'memory/runs',
    };
    const markdown = renderPatternsMarkdown({ reviewPatterns, highCostPatterns: highCost, decisionPatterns: decisions, recs, meta });
    fs.writeFileSync(patternsPath, markdown, 'utf8');
    return { patternsPath, meta, reviewPatterns, highCostPatterns: highCost, decisionPatterns: decisions, recommendations: recs };
}

// Hook do watcher (scripts/readmine-watcher.js, padrão syncAcRegistrySafe/
// syncKnowledgeGraphSafe): só consolida de novo depois que pelo menos `threshold`
// runs novos chegaram a status terminal desde a última consolidação. Contador
// persistido em memory/consolidator-state.json — comparar contagem absoluta (não um
// contador incremental por evento) o torna resiliente a tick perdido ou reinício do
// watcher: não depende de capturar o exato momento em que um run terminou.
function maybeRun(opts = {}) {
    const repoRoot = opts.repoRoot || process.env.REPO_PATH || process.cwd();
    const runsDir = opts.runsDir || path.join(repoRoot, 'memory', 'runs');
    const patternsPath = opts.patternsPath || path.join(repoRoot, 'memory', 'patterns.md');
    const statePath = opts.statePath || path.join(repoRoot, 'memory', 'consolidator-state.json');
    const threshold = opts.threshold || 10;

    const runs = collectRuns(runsDir);
    const completedRuns = runs.filter(r => isCompleted(r.state)).length;
    const counterState = readJsonSafe(statePath) || { completed_runs_at_last_run: 0, total_consolidations: 0 };
    const delta = completedRuns - (counterState.completed_runs_at_last_run || 0);
    if (delta < threshold) return { ran: false, completedRuns, delta, threshold };
    if (opts.dryRun) return { ran: false, wouldRun: true, completedRuns, delta, threshold };

    const result = consolidate({ ...opts, repoRoot, runsDir, patternsPath });
    const newCounterState = {
        completed_runs_at_last_run: completedRuns,
        last_run_at: new Date().toISOString(),
        total_consolidations: (counterState.total_consolidations || 0) + 1,
    };
    fs.writeFileSync(statePath, `${JSON.stringify(newCounterState, null, 2)}\n`, 'utf8');
    return { ran: true, completedRuns, delta, threshold, ...result };
}

if (require.main === module) {
    const result = consolidate({});
    console.log(`[memory-consolidator] ${result.meta.totalRuns} run(s) analisado(s) (${result.meta.completedRuns} completado(s)) -> ${result.patternsPath}`);
}

module.exports = {
    GENERIC_SIGNATURE, MODULE_KEYWORDS, moduleKeywords, TERMINAL_STATUSES,
    isCompleted, listRunDirs, collectRuns, loopCountOf, scopeText, textOf, classifyModule,
    isReviewVerdictEntry, reviewSignatureOf, reviewFailurePatterns, highCostPatterns, decisionPatterns,
    recommendations, renderPatternsMarkdown, consolidate, maybeRun,
};
