// Rastreamento de custo por nó do grafo — state.json.cost_tracking (schema em
// .graph/schemas/state.schema.json). Só a parte pura/parseável fica aqui (merge,
// totais, leitura de transcript/codex-result); o I/O de despacho (registro pendente,
// liveness do processo, escrita no state.json) fica em scripts/readmine-watcher.js.
//
// Regra de null: token que o agente não reportou numa invocação é null, nunca 0 — 0
// seria ambíguo com "rodou e não custou nada". Ao somar runs, null só "contamina" o
// resultado se TODOS os runs forem null; soma parcial é sinalizada por
// runs_without_tokens > 0 no nó. Mesma regra pra cost_usd (runs_without_cost).
const fs = require('fs');
const path = require('path');

// input_tokens = entrada TOTAL (input_tokens + cache_creation + cache_read do usage da
// API do Claude). Só o input_tokens cru da API seria enganoso: com prompt caching ele
// fica em unidades/dezenas por mensagem, e quase toda a entrada vem como cache_read.
// A quebra de cache fica nos dois campos à parte, pra quem quiser calcular custo em $.
const TOKEN_FIELDS = ['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens'];
// Tudo que um run reporta além da duração (o watcher copia estes campos da coleta).
const METRIC_FIELDS = [...TOKEN_FIELDS, 'cost_usd'];

// ---------------------------------------------------------------------------------
// Custo em US$ = preço de API da Anthropic (1ª parte), por modelo, calculado POR
// MENSAGEM com o modelo daquela mensagem (uma sessão mistura modelos: subagente em
// outro modelo, /model no meio). Em assinatura (Pro/Max) não é o valor cobrado — é o
// equivalente em preço de API, útil pra comparar tickets/etapas entre si.
// Fonte: skill claude-api (tabela "Current Models", cache de 2026-06-24) + multiplicadores
// de cache de shared/prompt-caching.md: escrita 5 min = 1,25× entrada, escrita 1 h =
// 2× entrada, leitura = cache_read abaixo (0,1× entrada, exceto onde a tabela diz outro).
// Atualize aqui quando o preço mudar; runs já fechados mantêm o valor calculado na época.
const PRICING_SOURCE = 'Preço de API Anthropic (skill claude-api, tabela de 2026-06-24)';
const PRICES_USD_PER_MTOK = {
    'claude-fable-5-1': { input: 10, output: 50, cache_read: 0.25 },
    // Mythos 5.1: leitura de cache 0,025× ainda "em aberto" no lançamento — usa 0,1×
    // (conservador: nunca subestima).
    'claude-mythos-5-1': { input: 10, output: 50, cache_read: 1 },
    'claude-fable-5': { input: 10, output: 50, cache_read: 1 },
    'claude-mythos-5': { input: 10, output: 50, cache_read: 1 },
    'claude-opus-5-5': { input: 4, output: 20, cache_read: 0.2 },
    'claude-opus-5': { input: 5, output: 25, cache_read: 0.5 },
    'claude-opus-4-8': { input: 5, output: 25, cache_read: 0.5 },
    'claude-opus-4-7': { input: 5, output: 25, cache_read: 0.5 },
    'claude-opus-4-6': { input: 5, output: 25, cache_read: 0.5 },
    'claude-sonnet-5': { input: 2, output: 10, cache_read: 0.2 },
    'claude-sonnet-4-6': { input: 3, output: 15, cache_read: 0.3 },
    'claude-haiku-4-5': { input: 1, output: 5, cache_read: 0.1 },
};
const CACHE_WRITE_5M = 1.25;
const CACHE_WRITE_1H = 2;
// Fast mode (usage.speed === 'fast'): tabela dá 2× em entrada/saída (Opus 5 $10/$50,
// Opus 5.5 $8/$40); aplica o mesmo 2× aos componentes de cache — estimativa.
const FAST_MULTIPLIER = 2;

// "claude-opus-5-5[1m]" / "claude-sonnet-4-6-20260101" -> id da tabela. Modelo fora da
// tabela => null (custo não calculado, nunca chutado).
function priceFor(model) {
    if (!model) return null;
    const id = String(model).replace(/\[[^\]]*\]$/, '').replace(/-\d{8}$/, '').trim();
    return PRICES_USD_PER_MTOK[id] ? { id, ...PRICES_USD_PER_MTOK[id] } : null;
}

// US$ de UMA mensagem da API (objeto usage do transcript). null = modelo sem preço.
function messageCostUsd(model, u) {
    const p = priceFor(model);
    if (!p) return null;
    const m = u.speed === 'fast' ? FAST_MULTIPLIER : 1;
    const creation = u.cache_creation_input_tokens || 0;
    // Quebra por TTL quando existe; sem ela, assume 5 min (padrão da API).
    const w1h = u.cache_creation?.ephemeral_1h_input_tokens ?? 0;
    const w5m = u.cache_creation ? (u.cache_creation.ephemeral_5m_input_tokens ?? Math.max(creation - w1h, 0)) : creation;
    const usd = (
        (u.input_tokens || 0) * p.input +
        (u.output_tokens || 0) * p.output +
        (u.cache_read_input_tokens || 0) * p.cache_read +
        w5m * p.input * CACHE_WRITE_5M +
        w1h * p.input * CACHE_WRITE_1H
    ) * m / 1e6;
    return usd;
}

// Arredonda pra 6 casas (micro-dólar) — soma de float acumula ruído.
const roundUsd = v => (v == null ? null : Math.round(v * 1e6) / 1e6);

function addNullable(a, b) {
    if (a == null && b == null) return null;
    return (a || 0) + (b || 0);
}

function emptyCostTracking() {
    return {
        nodes: {},
        totals: { input_tokens: null, output_tokens: null, cost_usd: null, duration_ms: 0, loop_count: 0 },
        pricing_source: PRICING_SOURCE,
    };
}

// loop_count = total de reexecuções de qualquer nó (soma de retries = runs - 1 de cada
// nó). Ex: implement reprovado no review uma vez => implement e review rodam 2x cada
// => loop_count 2.
function recomputeTotals(ct) {
    const totals = { input_tokens: null, output_tokens: null, cost_usd: null, duration_ms: 0, loop_count: 0 };
    for (const entry of Object.values(ct.nodes)) {
        totals.input_tokens = addNullable(totals.input_tokens, entry.input_tokens);
        totals.output_tokens = addNullable(totals.output_tokens, entry.output_tokens);
        totals.cost_usd = roundUsd(addNullable(totals.cost_usd, entry.cost_usd ?? null));
        totals.duration_ms += entry.duration_ms || 0;
        totals.loop_count += entry.retries || 0;
    }
    return { ...ct, totals, pricing_source: ct.pricing_source || PRICING_SOURCE };
}

// Acumula UM run (um despacho de agente) no nó `node`. Retry soma, nunca sobrescreve.
// alsoCovers: outros nós cobertos pelo mesmo despacho (hoje só fetch_ticket, que roda
// junto com plan num único `claude -p` — não dá pra separar o custo de cada um, então
// vai tudo em plan e fica registrado que incluiu fetch_ticket).
function mergeRun(ct, { node, agent, alsoCovers = [], metrics }) {
    const base = ct && ct.nodes ? ct : emptyCostTracking();
    const prev = base.nodes[node];
    const entry = prev
        ? { ...prev }
        : { agent, input_tokens: null, output_tokens: null, duration_ms: 0, runs: 0, retries: 0, runs_without_tokens: 0 };
    entry.agent = agent;
    for (const field of TOKEN_FIELDS) {
        const sum = addNullable(entry[field] ?? null, metrics[field] ?? null);
        // Campos de cache só aparecem quando algum run os reportou (Codex não tem).
        if (sum !== null || field === 'input_tokens' || field === 'output_tokens') entry[field] = sum;
    }
    entry.cost_usd = roundUsd(addNullable(entry.cost_usd ?? null, metrics.cost_usd ?? null));
    // Run com tokens mas sem custo (modelo fora da tabela, ou Codex) => soma parcial.
    if (metrics.cost_usd == null && (metrics.input_tokens != null || metrics.output_tokens != null)) {
        entry.runs_without_cost = (entry.runs_without_cost || 0) + 1;
    }
    if (metrics.models?.length) entry.models = [...new Set([...(entry.models || []), ...metrics.models])];
    entry.duration_ms = (entry.duration_ms || 0) + Math.max(0, Math.round(metrics.duration_ms || 0));
    entry.runs = (entry.runs || 0) + 1;
    entry.retries = entry.runs - 1;
    if (metrics.input_tokens == null && metrics.output_tokens == null) {
        entry.runs_without_tokens = (entry.runs_without_tokens || 0) + 1;
    }
    if (alsoCovers.length) entry.also_covers = [...new Set([...(entry.also_covers || []), ...alsoCovers])];
    return recomputeTotals({ ...base, nodes: { ...base.nodes, [node]: entry } });
}

// Transcripts da sessão `claude -p --session-id <id>`: o principal
// (~/.claude/projects/<cwd sanitizado>/<id>.jsonl) + os de subagentes
// (<id>/subagents/*.jsonl), que têm usage próprio e não entram no principal. Procura
// em todos os projetos em vez de recalcular a sanitização do cwd — não depende de
// como o Claude Code codifica o caminho.
function findClaudeTranscripts(sessionId, projectsDir) {
    if (!sessionId || !fs.existsSync(projectsDir)) return [];
    const files = [];
    for (const project of fs.readdirSync(projectsDir)) {
        const main = path.join(projectsDir, project, `${sessionId}.jsonl`);
        if (!fs.existsSync(main)) continue;
        files.push(main);
        const subDir = path.join(projectsDir, project, sessionId, 'subagents');
        if (fs.existsSync(subDir)) {
            for (const f of fs.readdirSync(subDir)) if (f.endsWith('.jsonl')) files.push(path.join(subDir, f));
        }
    }
    return files;
}

// Soma message.usage das mensagens `assistant` dos transcripts. A mesma mensagem da
// API aparece em várias linhas (uma por bloco de conteúdo, mesmo message.id) — conta
// uma vez só, com o usage da última linha. Sem nenhuma mensagem com usage => tokens
// null. last_timestamp_ms = último evento registrado (fim real da sessão, usado quando
// o watcher não acompanhou o processo até o exit).
function sumClaudeUsage(contents) {
    const byMessage = new Map();
    let lastTs = null;
    for (const content of contents) {
        for (const line of content.split('\n')) {
            if (!line.trim()) continue;
            let entry;
            try { entry = JSON.parse(line); } catch { continue; }
            const ts = entry.timestamp ? Date.parse(entry.timestamp) : NaN;
            if (!Number.isNaN(ts) && (lastTs === null || ts > lastTs)) lastTs = ts;
            const usage = entry.type === 'assistant' && entry.message?.usage;
            if (!usage) continue;
            byMessage.set(entry.message.id || `${entry.uuid}`, { usage, model: entry.message.model });
        }
    }
    const result = {
        input_tokens: null, output_tokens: null, cache_read_input_tokens: null, cache_creation_input_tokens: null,
        cost_usd: null, models: [], unpriced_models: [], last_timestamp_ms: lastTs,
    };
    const models = new Set(), unpriced = new Set();
    let anyUnpriced = false;
    for (const { usage: u, model } of byMessage.values()) {
        const billable = (u.input_tokens || 0) + (u.output_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
        // "<synthetic>" = mensagem gerada localmente pelo Claude Code (sem chamada à API).
        if (model && model !== '<synthetic>') models.add(model);
        if (billable > 0) {
            const usd = messageCostUsd(model, u);
            if (usd == null) { anyUnpriced = true; unpriced.add(model || '(sem modelo)'); }
            else result.cost_usd = addNullable(result.cost_usd, usd);
        }
        const cacheRead = u.cache_read_input_tokens || 0;
        const cacheCreation = u.cache_creation_input_tokens || 0;
        result.input_tokens = addNullable(result.input_tokens, (u.input_tokens || 0) + cacheRead + cacheCreation);
        result.output_tokens = addNullable(result.output_tokens, u.output_tokens || 0);
        result.cache_read_input_tokens = addNullable(result.cache_read_input_tokens, cacheRead);
        result.cache_creation_input_tokens = addNullable(result.cache_creation_input_tokens, cacheCreation);
    }
    // Algum modelo sem preço => custo do run inteiro fica null (parcial seria enganoso
    // no nível do run; no nó, runs_without_cost sinaliza).
    if (anyUnpriced) result.cost_usd = null;
    result.cost_usd = roundUsd(result.cost_usd);
    result.models = [...models];
    result.unpriced_models = [...unpriced];
    return result;
}

// Seção "## Tokens" de memory/runs/<task>/codex-result-<node>.md (formato em
// AGENTS.md). Valor não numérico ("não disponível", vazio, seção ausente) => null.
function parseCodexResultTokens(markdown) {
    const result = { input_tokens: null, output_tokens: null };
    if (!markdown) return result;
    const lines = markdown.split('\n');
    const start = lines.findIndex(l => /^##\s+Tokens\s*$/i.test(l.trim()));
    if (start === -1) return result;
    for (let i = start + 1; i < lines.length && !/^##\s/.test(lines[i]); i++) {
        const m = lines[i].match(/^\s*[-*]?\s*(input_tokens|output_tokens)\s*:\s*(.*)$/);
        if (!m) continue;
        const raw = m[2].trim().replace(/[`*]/g, '');
        if (/^\d[\d.,_ ]*$/.test(raw)) result[m[1]] = Number(raw.replace(/[.,_ ]/g, ''));
    }
    return result;
}

module.exports = {
    TOKEN_FIELDS, METRIC_FIELDS, PRICES_USD_PER_MTOK, PRICING_SOURCE, priceFor, messageCostUsd, addNullable, emptyCostTracking, recomputeTotals, mergeRun,
    findClaudeTranscripts, sumClaudeUsage, parseCodexResultTokens,
};
