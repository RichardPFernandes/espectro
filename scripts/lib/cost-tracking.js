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
// Tabela versionada: preços legados preservados; D11 acrescenta Sonnet/Haiku 5.5.
// O digest identifica os bytes da tabela (inclusive limites), não só a página fonte.
const crypto = require('crypto');
const { isDeepStrictEqual } = require('util');
const RATE_FIELDS = ['input', 'output', 'cache_read', 'cache_write_5m', 'cache_write_1h'];
const TIER_BASIS_FIELDS = new Set(['input_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens']);
const EMPTY_PRICING = { version: 'UNKNOWN', source: {}, legacy_source: {}, fast_multiplier: 1, models: {} };
const validRate = price => RATE_FIELDS.every(field =>
    Object.hasOwn(price, field) && Number.isFinite(price[field]) && price[field] >= 0);
function validModelPrice(price) {
    if (!price || typeof price !== 'object' || Array.isArray(price)) return false;
    if (!Object.hasOwn(price, 'tiers')) return validRate(price);
    if (!Array.isArray(price.tier_basis) || !price.tier_basis.length ||
        price.tier_basis.some(field => !TIER_BASIS_FIELDS.has(field)) ||
        !Array.isArray(price.tiers) || !price.tiers.length) return false;
    const ids = new Set();
    let previousMax = -1;
    for (const [index, tier] of price.tiers.entries()) {
        if (!tier || typeof tier !== 'object' || Array.isArray(tier) || !validRate(tier) ||
            typeof tier.id !== 'string' || !tier.id || ids.has(tier.id)) return false;
        ids.add(tier.id);
        if (index === price.tiers.length - 1) {
            if (tier.max_prompt_tokens !== null) return false;
        } else if (!Number.isSafeInteger(tier.max_prompt_tokens) || tier.max_prompt_tokens <= previousMax) return false;
        previousMax = tier.max_prompt_tokens;
    }
    return true;
}
function validatedPricing(table) {
    if (!table || typeof table !== 'object' || Array.isArray(table) ||
        !Number.isFinite(table.fast_multiplier) || table.fast_multiplier <= 0 ||
        !table.models || typeof table.models !== 'object' || Array.isArray(table.models)) return EMPTY_PRICING;
    const models = {};
    for (const [id, price] of Object.entries(table.models)) if (validModelPrice(price)) models[id] = price;
    return { ...table, models };
}
// Custo é observação secundária: arquivo ausente/JSON inválido não impede o watcher
// de subir. Sem tabela verificável, nenhum modelo recebe preço.
let PRICING_BYTES, PRICING;
try {
    PRICING_BYTES = fs.readFileSync(path.join(__dirname, 'model-pricing.json'));
    PRICING = validatedPricing(JSON.parse(PRICING_BYTES));
} catch {
    PRICING = EMPTY_PRICING;
    PRICING_BYTES = Buffer.from(JSON.stringify(EMPTY_PRICING));
    console.warn('[custo] tabela de preços indisponível; custo fica UNKNOWN');
}
const PRICING_SHA256 = crypto.createHash('sha256').update(PRICING_BYTES).digest('hex');
const PRICES_USD_PER_MTOK = PRICING.models;
// Continua string para os leitores legados do dashboard. Cada Attempt guarda sua fonte.
function pricingSource(table, sha256) {
    return `Anthropic ${table.source?.url || 'UNKNOWN'}, captura ${table.source?.captured_at || 'UNKNOWN'}, ` +
        `source_sha256=${table.source?.sha256 || 'UNKNOWN'}; tabela=${table.version || 'UNKNOWN'}, sha256=${sha256}; ` +
        `demais modelos: ${table.legacy_source?.description || 'UNKNOWN'}`;
}
const PRICING_SOURCE = pricingSource(PRICING, PRICING_SHA256);

// O ledger existente guarda o pin do despacho. Não há registry paralelo: retomar
// um pendente com outra versão do watcher ainda usa os mesmos bytes e limites.
function pricingSnapshot() {
    return { json: PRICING_BYTES.toString('utf8'), sha256: PRICING_SHA256 };
}
function readPricing(snapshot) {
    if (!snapshot) return { table: PRICING, sha256: PRICING_SHA256, source: PRICING_SOURCE };
    const sha256 = crypto.createHash('sha256').update(snapshot.json).digest('hex');
    if (sha256 !== snapshot.sha256) throw new Error('PRICING_SNAPSHOT_HASH_MISMATCH');
    const table = validatedPricing(JSON.parse(snapshot.json));
    return { table, sha256, source: pricingSource(table, sha256) };
}

function modelId(model) {
    return String(model || '').replace(/\[[^\]]*\]$/, '').replace(/-\d{8}$/, '').trim();
}

function priceFor(model, usage = {}, pricing = readPricing()) {
    const id = modelId(model);
    const p = Object.hasOwn(pricing.table.models, id) ? pricing.table.models[id] : null;
    if (!p) return null;
    if (!p.tiers) return { id, price_tier: 'flat', ...p };
    const total = p.tier_basis.reduce((sum, field) => sum + (usage[field] || 0), 0);
    const tier = p.tiers.find(t => t.max_prompt_tokens == null || total <= t.max_prompt_tokens);
    return tier ? { ...tier, id, price_tier: tier.id } : null;
}

// Mesma aritmética legada de TTL: sem quebra, a projeção assume 5 min e é estimada.
function cacheWrites(u) {
    const creation = u.cache_creation_input_tokens || 0;
    const h = u.cache_creation?.ephemeral_1h_input_tokens ?? 0;
    const known5m = u.cache_creation?.ephemeral_5m_input_tokens;
    return {
        cache_write_5m_tokens: known5m ?? 0,
        cache_write_1h_tokens: h,
        cache_write_ttl_unknown_tokens: known5m == null ? Math.max(creation - h, 0) : 0,
    };
}

function pricedComponents(p, row, pricing = readPricing()) {
    if (!p) return null;
    return ((row.input_tokens || 0) * p.input + (row.output_tokens || 0) * p.output +
        (row.cache_read_tokens || 0) * p.cache_read +
        ((row.cache_write_5m_tokens || 0) + (row.cache_write_ttl_unknown_tokens || 0)) * p.cache_write_5m +
        (row.cache_write_1h_tokens || 0) * p.cache_write_1h) *
        (row.speed === 'fast' ? pricing.table.fast_multiplier : 1) / 1e6;
}

// Sem arredondamento por linha: o AS-IS arredonda apenas o total do despacho.
// A soma da projeção agrupada pode mudar a ordem das parcelas em ponto flutuante.
// Compare seu valor bruto ao agregado legado arredondado com tolerância de meio
// microdólar mais 1e-12; em empate, arredondá-la pode diferir em 1 microdólar.
// Nunca ajuste cost_usd legado para casar com a projeção.
function projectUsageCost(row, snapshot = null) {
    const pricing = readPricing(snapshot);
    if (row.pricing_sha256 !== pricing.sha256) return null; // nunca reinterpretar histórico por latest
    // Mensagem local sem tokens faturáveis não precisa de preço. Preserva a regra
    // legada billable > 0 sem converter preço ausente de uso real em zero.
    if (['input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_write_5m_tokens',
        'cache_write_1h_tokens', 'cache_write_ttl_unknown_tokens'].every(field => row[field] === 0)) return 0;
    const id = modelId(row.model);
    const model = Object.hasOwn(pricing.table.models, id) ? pricing.table.models[id] : null;
    const p = model?.tiers ? model.tiers.find(t => t.id === row.price_tier)
        : row.price_tier === 'flat' ? model : null;
    return pricedComponents(p, row, pricing);
}

function messageCostUsd(model, u, pricing = readPricing()) {
    return pricedComponents(priceFor(model, u, pricing), {
        input_tokens: u.input_tokens, output_tokens: u.output_tokens,
        cache_read_tokens: u.cache_read_input_tokens, ...cacheWrites(u), speed: u.speed,
    }, pricing);
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
function mergeRun(ct, { node, agent, alsoCovers = [], metrics, run = {}, outcome = {} }) {
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
    entry.attempts = [...(prev?.attempts || []), attemptRecord({ ...run, agent }, node, alsoCovers, metrics, outcome)];
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
function sumClaudeUsage(contents, snapshot = null) {
    const pricing = readPricing(snapshot);
    const byMessage = new Map(), seen = new Map();
    const readOrder = [];
    let lastTs = null, firstMain = null;
    for (const [fileIndex, source] of contents.entries()) {
        const { content, role = 'main', file_ref = role } = typeof source === 'string' ? { content: source } : source;
        readOrder.push({ role, file_ref });
        for (const line of content.split('\n')) {
            if (!line.trim()) continue;
            let entry;
            try { entry = JSON.parse(line); } catch { continue; }
            const ts = entry.timestamp ? Date.parse(entry.timestamp) : NaN;
            if (!Number.isNaN(ts) && (lastTs === null || ts > lastTs)) lastTs = ts;
            const usage = entry.type === 'assistant' && entry.message?.usage;
            if (!usage) continue;
            const key = entry.message.id || `${entry.uuid}`;
            const model = entry.message.model;
            const prev = seen.get(key);
            if (prev) {
                prev.files.add(fileIndex);
                prev.roles.add(role);
                if (!isDeepStrictEqual(prev.usage, usage) || prev.model !== model) prev.diverged = true;
            } else seen.set(key, { files: new Set([fileIndex]), roles: new Set([role]), usage, model, diverged: false });
            // Map.set e ordem de leitura preservados: última ocorrência vence.
            byMessage.set(key, { usage, model, role });
            if (role === 'main' && (!firstMain || firstMain.key === key)) firstMain = { key, usage };
        }
    }
    const result = {
        input_tokens: null, output_tokens: null, cache_read_input_tokens: null, cache_creation_input_tokens: null,
        cost_usd: null, models: [], unpriced_models: [], last_timestamp_ms: lastTs,
        usage: [], read_order: readOrder, dedup_conflicts: [],
        role_attribution: { status: 'COMPLETE', conflicted_messages: 0 },
        first_turn: { cache_read_tokens: null, cache_write_5m_tokens: null, cache_write_1h_tokens: null },
        cost_estimated: false, pricing_sha256: pricing.sha256, pricing_source: pricing.source,
    };
    if (firstMain) {
        const u = firstMain.usage;
        result.first_turn = { cache_read_tokens: u.cache_read_input_tokens ?? null,
            cache_write_5m_tokens: u.cache_creation?.ephemeral_5m_input_tokens ?? null,
            cache_write_1h_tokens: u.cache_creation?.ephemeral_1h_input_tokens ?? null };
    }
    const models = new Set(), unpriced = new Set(), groups = new Map();
    let anyUnpriced = false;
    for (const [key, { usage: u, model, role }] of byMessage) {
        const observation = seen.get(key);
        const conflicted = observation.files.size > 1 && observation.roles.size > 1;
        if (observation.files.size > 1) result.dedup_conflicts.push({
            message_id_hash: crypto.createHash('sha256').update(String(key)).digest('hex'),
            files_seen: observation.files.size, roles_seen: [...observation.roles],
            winner_role: role, usage_diverged: observation.diverged,
        });
        if (conflicted) result.role_attribution.conflicted_messages++;
        const billable = (u.input_tokens || 0) + (u.output_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
        if (model && model !== '<synthetic>') models.add(model);
        if (billable > 0) {
            const usd = messageCostUsd(model, u, pricing);
            if (usd == null) { anyUnpriced = true; unpriced.add(model || '(sem modelo)'); }
            else result.cost_usd = addNullable(result.cost_usd, usd);
        }
        const cacheRead = u.cache_read_input_tokens || 0;
        const cacheCreation = u.cache_creation_input_tokens || 0;
        result.input_tokens = addNullable(result.input_tokens, (u.input_tokens || 0) + cacheRead + cacheCreation);
        result.output_tokens = addNullable(result.output_tokens, u.output_tokens || 0);
        result.cache_read_input_tokens = addNullable(result.cache_read_input_tokens, cacheRead);
        result.cache_creation_input_tokens = addNullable(result.cache_creation_input_tokens, cacheCreation);
        const speed = u.speed === 'fast' ? 'fast' : 'standard';
        const price_tier = priceFor(model, u, pricing)?.price_tier || 'UNKNOWN';
        // role_provenance na chave: CONFLICTED não contamina mensagens limpas do mesmo
        // modelo/papel/velocidade/tier (PRI-214 MINOR-3).
        const role_provenance = conflicted ? 'CONFLICTED' : 'SELF_REPORTED';
        const groupKey = JSON.stringify([model || 'UNKNOWN', role, speed, price_tier, role_provenance]);
        const row = groups.get(groupKey) || {
            model: model || 'UNKNOWN', role, speed, price_tier, pricing_sha256: pricing.sha256,
            messages: 0, input_tokens: 0, output_tokens: 0, cache_read_tokens: 0,
            cache_write_5m_tokens: 0, cache_write_1h_tokens: 0, cache_write_ttl_unknown_tokens: 0,
            role_provenance, role_conflicted_messages: 0,
        };
        row.messages++;
        row.input_tokens += u.input_tokens || 0;
        row.output_tokens += u.output_tokens || 0;
        row.cache_read_tokens += cacheRead;
        const writes = cacheWrites(u);
        for (const field of Object.keys(writes)) row[field] += writes[field];
        if (writes.cache_write_ttl_unknown_tokens > 0) result.cost_estimated = true;
        if (conflicted) row.role_conflicted_messages++;
        groups.set(groupKey, row);
    }
    if (anyUnpriced) result.cost_usd = null;
    result.cost_usd = roundUsd(result.cost_usd);
    result.models = [...models];
    result.unpriced_models = [...unpriced];
    result.usage = [...groups.values()];
    if (result.role_attribution.conflicted_messages) result.role_attribution.status = 'PARTIAL';
    if (!byMessage.size) result.role_attribution.status = 'UNKNOWN';
    return result;
}

// Identidade apenas da admissão; não usa o lease (Commit não tem aquele vínculo).
function admissionForCost(decision, ticketId, runsRoot) {
    const attempt = decision?.attempt;
    const unknown = { attempt_id: 'UNKNOWN', admitted_node: 'UNKNOWN', attempt_ref: 'UNKNOWN' };
    if (!attempt?.started || !attempt.attempt_id || !decision.attemptFile || !fs.existsSync(decision.attemptFile)) {
        return { admission: { ...unknown, reason: 'NO_REAL_ATTEMPT' }, cause: attempt?.cause || 'UNKNOWN' };
    }
    const relative = path.relative(runsRoot, decision.attemptFile);
    const valid = relative && !relative.startsWith('..') && !path.isAbsolute(relative);
    return { admission: {
        attempt_id: attempt.attempt_id, admitted_node: attempt.node,
        attempt_ref: valid ? { runs_root: `worktree:${ticketId}/memory/runs`, path: relative } : 'UNKNOWN',
        ...(valid ? {} : { reason: 'INVALID_ATTEMPT_REF' }),
    }, cause: attempt.cause || 'UNKNOWN' };
}

function attemptRecord(run, node, alsoCovers, metrics, outcome) {
    const codexUsage = [{ model: 'UNKNOWN', role: 'main', speed: 'UNKNOWN', price_tier: 'UNKNOWN',
        pricing_sha256: PRICING_SHA256, messages: null, input_tokens: metrics.input_tokens ?? null,
        output_tokens: metrics.output_tokens ?? null, cache_read_tokens: null, cache_write_5m_tokens: null,
        cache_write_1h_tokens: null, cache_write_ttl_unknown_tokens: null, role_provenance: 'UNKNOWN', role_conflicted_messages: 0 }];
    return {
        admission: run.admission || { attempt_id: 'UNKNOWN', admitted_node: 'UNKNOWN', attempt_ref: 'UNKNOWN', reason: 'NO_REAL_ATTEMPT' },
        attributed_node: node, also_covers: alsoCovers, cause: run.cause || 'UNKNOWN', parent_attempt_id: 'UNKNOWN',
        session_id: run.session_id || 'UNKNOWN', runtime: run.agent,
        provider: run.agent === 'claude' ? 'anthropic' : run.agent === 'codex' ? 'openai' : 'UNKNOWN',
        account: run.account || { source: 'UNKNOWN', label: 'UNKNOWN' },
        // PRI-233 T7: despacho roteado grava o par fixado (modelo, esforço do CLI) e a decisão.
        requested: run.routing_decision?.chosen
            ? { model: run.routing_decision.chosen.model_id, effort: run.routing_decision.chosen.cli_effort }
            : { model: 'UNAVAILABLE', effort: 'UNAVAILABLE' },
        effort_router_plugin: run.effort_router_plugin || 'UNKNOWN',
        first_turn: metrics.first_turn || { cache_read_tokens: null, cache_write_5m_tokens: null, cache_write_1h_tokens: null },
        selection_source: run.routing_decision?.selection_source || 'DEFAULT_INHERITED',
        routing_decision: run.routing_decision || 'UNAVAILABLE', subtask: 'UNAVAILABLE', workspace: 'UNAVAILABLE',
        signals: run.signals || 'UNAVAILABLE',
        // PRI-223 S3: decisão sombra (would_route). Nunca altera argv; applied=false.
        would_route: run.would_route || 'UNAVAILABLE',
        observed: { usage: run.agent === 'codex' ? codexUsage : metrics.usage || [], effort: 'UNKNOWN' },
        usage_provenance: 'SELF_REPORTED',
        read_order: metrics.read_order || [], dedup_conflicts: metrics.dedup_conflicts || [],
        role_attribution: metrics.role_attribution || { status: 'UNKNOWN', conflicted_messages: 0 },
        cost: { usd: metrics.cost_usd ?? null, unpriced_models: metrics.unpriced_models || [],
            pricing_source: metrics.pricing_source || PRICING_SOURCE, pricing_sha256: metrics.pricing_sha256 || PRICING_SHA256, estimated: metrics.cost_estimated ?? 'UNKNOWN' },
        duration_ms: Math.max(0, Math.round(metrics.duration_ms || 0)), wait_ms: 'UNAVAILABLE',
        exit: Number.isInteger(outcome.exitCode) ? outcome.exitCode : 'UNKNOWN', result: outcome.attemptResult || 'UNKNOWN',
    };
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
    TOKEN_FIELDS, METRIC_FIELDS, PRICES_USD_PER_MTOK, PRICING_SOURCE, PRICING_SHA256, pricingSnapshot, priceFor, projectUsageCost, admissionForCost, messageCostUsd, addNullable, emptyCostTracking, recomputeTotals, mergeRun,
    findClaudeTranscripts, sumClaudeUsage, parseCodexResultTokens,
};
