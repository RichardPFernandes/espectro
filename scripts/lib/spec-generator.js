// Gera o RASCUNHO de memory/spec/<ticket>-spec.md a partir dos campos estruturados do
// ticket Redmine, antes de qualquer agente rodar — specs escritas à mão ignoravam
// category/fixed_version/estimated_hours e saíam desconectadas do contexto do projeto.
//
// Mapeamento campo Redmine → seção de templates/spec-template.md:
//   description     → ## Problema (subseções "Solução", "Critérios de Aceite",
//                     "Restrições", "Arquivos Afetados", "Dependências" da descrição
//                     vão para as seções de mesmo nome — nunca inventadas)
//   category        → ## Módulo Afetado (+ microsserviços inferidos, ver inferMicroservices)
//   fixed_version   → ## Versão Alvo / Restrições de Deploy (é o "target_version" do Redmine)
//   estimated_hours → ## Sugestão de Granularidade do Plan (ver suggestPlanGranularity)
//   assigned_to     → ## Responsável
//
// A spec sai com `draft: true` e `generated_from_ticket: true` no frontmatter. O watcher
// (scripts/readmine-watcher.js > runSpecDraftGate) NUNCA inicia ciclo enquanto
// `draft: true` estiver lá — liberar exige um humano revisar e trocar para `draft: false`
// (ou apagar a linha). Este módulo só gera texto; quem grava (sem sobrescrever) e
// comenta no Redmine é o watcher.
//
// `mcpClient` é qualquer objeto com `getIssue({ issueId, queryParams })` — mesma forma
// do tool mcp__redmine__getIssue. Aceita as três respostas que aparecem na prática:
// `{ issue }` (REST), o issue direto, ou o envelope de tool MCP
// (`{ content: [{ type: 'text', text: '<json>' }] }`). O watcher passa um adaptador REST
// (createRestMcpClient) que usa scripts/lib/redmine-fetch.js (throttle + retry).
//
// Uso como CLI (só imprime, não grava): node scripts/lib/spec-generator.js <ticket>

const fs = require('fs');
const path = require('path');
const { parseHeading, normalizeHeading } = require('./spec-validator');
const acIds = require('./ac-ids');

const DEFAULT_TEMPLATE_PATH = path.join(__dirname, '..', '..', 'templates', 'spec-template.md');
const NOT_INFORMED = '_não informado no ticket_';
const SERVICE_ROOT = 'backend';

// Subseções da descrição que têm seção própria no template. `match` roda contra o
// cabeçalho normalizado (mesma normalização do spec-validator: sem acento, minúsculo).
const DESCRIPTION_SECTIONS = [
    { key: 'problema', match: /^(problema|contexto)\b/ },
    { key: 'solucao', match: /^solucao\b/ },
    { key: 'criterios', match: /^criterios? de aceit/ },
    { key: 'restricoes', match: /^restric/ },
    { key: 'arquivos', match: /^arquivos afetados\b/ },
    { key: 'dependencias', match: /^dependencias?\b/ },
];

const slugify = s => String(s)
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

// Override de categoria → serviço(s) para quando o nome da categoria não bate com o do
// módulo. SPEC_CATEGORY_SERVICE_MAP='{"Portaria":"ms-patio"}' (chave comparada via slug;
// valor string ou lista). JSON inválido é ignorado com aviso — não derruba o watcher.
function categoryOverrides(env = process.env) {
    if (!env.SPEC_CATEGORY_SERVICE_MAP) return {};
    try {
        const raw = JSON.parse(env.SPEC_CATEGORY_SERVICE_MAP);
        return Object.fromEntries(Object.entries(raw).map(([k, v]) => [slugify(k), [].concat(v)]));
    } catch (e) {
        console.warn(`[spec-generator] SPEC_CATEGORY_SERVICE_MAP ignorado (JSON inválido): ${e.message}`);
        return {};
    }
}

// "Pedidos" → ["ms-pedidos"]; "Pedidos / Expedição" → ["ms-pedidos", "ms-expedicao"].
// Heurística por nome — o /plan confirma. Com repoRoot, marca se backend/<svc> existe.
function inferMicroservices(category, { overrides = categoryOverrides(), repoRoot = null } = {}) {
    if (!category) return [];
    const names = [];
    for (const part of String(category).split(/[/,;&|]|\s+e\s+/)) {
        const slug = slugify(part);
        if (!slug) continue;
        for (const svc of overrides[slug] || [slug.startsWith('ms-') ? slug : `ms-${slug}`]) {
            if (!names.includes(svc)) names.push(svc);
        }
    }
    return names.map(name => ({
        name,
        exists: repoRoot ? fs.existsSync(path.join(repoRoot, SERVICE_ROOT, name)) : null,
    }));
}

// estimated_hours → quantos passos o /plan deveria quebrar a tarefa. Faixas pensadas
// para o ciclo plan→commit de uma task: acima de ~3 dias, um task-id só vira um diff
// grande demais para /review revisar direito.
function suggestPlanGranularity(hours) {
    const h = Number(hours);
    if (hours == null || hours === '' || !Number.isFinite(h) || h <= 0) {
        return { steps: null, text: 'sem estimativa no ticket — o /plan define a granularidade no diagnóstico.' };
    }
    if (h <= 2) return { steps: '1', text: `${h}h → mudança pontual: 1 passo no plan, um único ciclo.` };
    if (h <= 8) return { steps: '2-4', text: `${h}h → 2 a 4 passos no plan (ex: modelo/dados, serviço, endpoint, testes), um único ciclo.` };
    if (h <= 24) return { steps: '4-8', text: `${h}h → 4 a 8 passos no plan, agrupados por camada; considerar checkpoints de review intermediários.` };
    return { steps: 'split', text: `${h}h → grande demais para um ciclo: quebrar em subtarefas (um task-id por entrega verificável) antes do /implement.` };
}

// Cabeçalho normalizado sem numeração na frente ("5. Critérios de Aceite (BDD)",
// "2) Contexto / Problema", "3 - Solução"): o template de ticket numera as seções.
function headingKeyText(text) {
    return normalizeHeading(text).replace(/^\d+(?:\.\d+)*[.)]?\s*(?:[-–—:]\s*)?/, '');
}

// Critérios em Gherkin (bloco ```gherkin ou texto com "Cenário:") viram itens de lista,
// um critério por cenário com os passos como sub-itens, pra numeração AC-NN seguir
// igual. Só converte quando a seção não tem item de lista fora do bloco: aí o autor já
// escolheu o formato e o texto fica como veio. Cenário vira critério literal do ticket,
// nada é inventado.
const GHERKIN_SCENARIO = /^\s*(?:esquema do cen[aá]rio|delinea[cç][aã]o do cen[aá]rio|cen[aá]rio|scenario outline|scenario|example|exemplo)\s*:\s*(.+?)\s*$/i;
const FENCE = /^\s*(?:```|~~~)/;
const LIST_LINE = /^\s*(?:[-*+]|\d+[.)])\s+/;

function gherkinToCriteria(text) {
    const src = String(text || '');
    const lines = src.split('\n');
    if (!lines.some(l => GHERKIN_SCENARIO.test(l))) return src;
    let fenced = false;
    for (const l of lines) {
        if (FENCE.test(l)) { fenced = !fenced; continue; }
        if (!fenced && LIST_LINE.test(l)) return src;
    }
    const out = [];
    let inScenario = false;
    fenced = false;
    for (const l of lines) {
        if (FENCE.test(l)) {
            fenced = !fenced;
            if (!fenced) inScenario = false; // fim do bloco: texto depois dele não é passo
            continue;
        }
        const sc = GHERKIN_SCENARIO.exec(l);
        if (sc) { out.push(`- ${sc[1]}`); inScenario = true; continue; }
        if (!l.trim()) continue;
        if (!inScenario) { out.push(l.trim()); continue; }
        // Tabela de exemplos / docstring: continuação do passo de cima, sem marcador.
        out.push(/^\s*(?:\||""")/.test(l) ? `    ${l.trim()}` : `  - ${l.trim()}`);
    }
    return out.join('\n');
}

// Separa a descrição do ticket nas seções do template. Quebra só nos cabeçalhos do
// nível mais alto presente (subtítulos internos ficam no corpo da seção). Texto antes
// do primeiro cabeçalho e seções não reconhecidas vão para "problema", com cabeçalho.
function splitDescription(description) {
    const out = { problema: [], solucao: [], criterios: [], restricoes: [], arquivos: [], dependencias: [] };
    const lines = String(description || '').replace(/\r\n?/g, '\n').split('\n');
    const headings = lines.map((l, idx) => ({ ...parseHeading(l), idx })).filter(h => h.level);
    const top = headings.length ? Math.min(...headings.map(h => h.level)) : 0;
    // Cabeçalho que fica no corpo desce para ### ou abaixo: "# 4. Regras" ou "## Filtros"
    // dentro de "## Problema" seriam lidos pelo validador como seção nova (e o Problema
    // ficava vazio quando o ticket começava com um "# 1. Título").
    const shift = top ? Math.max(0, 3 - top) : 0;
    let bucket = 'problema';
    for (let i = 0; i < lines.length; i++) {
        const h = parseHeading(lines[i]);
        if (h && h.level === top) {
            const def = DESCRIPTION_SECTIONS.find(d => d.match.test(headingKeyText(h.text)));
            if (def) { bucket = def.key; continue; }
            bucket = 'problema';
        }
        out[bucket].push(h && shift ? `${'#'.repeat(Math.min(h.level + shift, 6))} ${h.text}` : lines[i]);
    }
    const clean = arr => arr.join('\n').replace(/^\s*\n+|\s+$/g, '');
    return Object.fromEntries(Object.entries(out).map(([k, v]) => [k, clean(v)]));
}

// Frontmatter YAML simples (chave: valor escalar), só o bloco inicial entre "---".
function parseFrontmatter(content) {
    const m = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(String(content || ''));
    if (!m) return null;
    const data = {};
    for (const line of m[1].split(/\r?\n/)) {
        const kv = /^([A-Za-z_][\w-]*):\s*(.*?)\s*$/.exec(line);
        if (!kv) continue;
        const v = kv[2].replace(/^["']|["']$/g, '');
        data[kv[1]] = /^true$/i.test(v) ? true : /^false$/i.test(v) ? false : v;
    }
    return data;
}

// true só com `draft: true` literal no frontmatter — trocar para false ou apagar a
// linha libera o ciclo.
function isDraftSpec(content) {
    return parseFrontmatter(content)?.draft === true;
}

function isGeneratedSpec(content) {
    return parseFrontmatter(content)?.generated_from_ticket === true;
}

function unwrapIssue(resp) {
    if (!resp) return null;
    if (Array.isArray(resp.content)) {
        const text = resp.content.find(c => c?.type === 'text')?.text;
        if (!text) return null;
        return unwrapIssue(JSON.parse(text));
    }
    if (resp.issue) return resp.issue;
    return resp.id != null ? resp : null;
}

const named = v => (v && typeof v === 'object' ? v.name : v) || null;
const orNotInformed = v => (v == null || v === '' ? NOT_INFORMED : String(v));

function fillTemplate(template, values) {
    return template.replace(/\{\{([A-Z_]+)\}\}/g, (all, key) => (key in values ? values[key] : all));
}

// Monta o conteúdo da spec a partir de um issue já buscado. Separado de
// generateSpecDraft para ser testável sem cliente nenhum.
function buildSpecDraft(issue, { template, repoRoot = null, now = new Date(), overrides } = {}) {
    const tpl = template ?? fs.readFileSync(DEFAULT_TEMPLATE_PATH, 'utf8');
    const category = named(issue.category);
    const targetVersion = named(issue.fixed_version || issue.target_version);
    const hours = issue.estimated_hours ?? issue.total_estimated_hours ?? null;
    const services = inferMicroservices(category, { repoRoot, ...(overrides ? { overrides } : {}) });
    const granularity = suggestPlanGranularity(hours);
    const desc = splitDescription(issue.description);

    const servicesMd = services.length
        ? services.map(s => `\`${s.name}\`${s.exists === true ? '' : s.exists === false ? ` (não encontrado em ${SERVICE_ROOT}/ — confirmar no /plan)` : ' (inferido — confirmar no /plan)'}`).join(', ')
        : NOT_INFORMED;

    const content = fillTemplate(tpl, {
        TICKET_ID: String(issue.id),
        SUBJECT: issue.subject || '(sem título)',
        DRAFT: 'true',
        GENERATED_FROM_TICKET: 'true',
        GENERATED_AT: now.toISOString(),
        PROBLEMA: desc.problema || NOT_INFORMED,
        REDMINE_CATEGORY: orNotInformed(category),
        MICROSERVICES: servicesMd,
        TARGET_VERSION: orNotInformed(targetVersion),
        ESTIMATED_HOURS: hours == null ? NOT_INFORMED : `${hours}h`,
        PLAN_GRANULARITY: granularity.text,
        ASSIGNED_TO: orNotInformed(named(issue.assigned_to)),
        // Vazias de propósito quando a descrição não traz: o portão de spec aponta a
        // falta na revisão em vez de o gerador inventar critério. Critérios que vieram
        // do ticket ganham ID estável (AC-01...) sem mudar o texto; ID já dado no ticket
        // é mantido, e seção com ID malformado fica como veio (o portão reporta).
        SOLUCAO: desc.solucao,
        CRITERIOS_ACEITE: acIds.numberCriteriaText(gherkinToCriteria(desc.criterios)),
        RESTRICOES: desc.restricoes,
        ARQUIVOS_AFETADOS: desc.arquivos,
        DEPENDENCIAS: desc.dependencias,
    });

    return {
        ticketId: issue.id,
        content: content.replace(/\n{3,}/g, '\n\n'),
        meta: {
            category, targetVersion, estimatedHours: hours,
            microservices: services.map(s => s.name),
            planSteps: granularity.steps,
            assignedTo: named(issue.assigned_to),
        },
    };
}

/**
 * Busca o ticket via MCP e devolve a spec rascunho preenchida (não grava nada).
 * @param {number|string} ticketId
 * @param {{getIssue: (args: {issueId: number, queryParams?: object}) => Promise<any>}} mcpClient
 * @param {{template?: string, repoRoot?: string, now?: Date, overrides?: object}} [opts]
 * @returns {Promise<{ticketId: number, content: string, meta: object}>}
 */
async function generateSpecDraft(ticketId, mcpClient, opts = {}) {
    if (!mcpClient || typeof mcpClient.getIssue !== 'function') {
        throw new TypeError('generateSpecDraft: mcpClient precisa expor getIssue({ issueId, queryParams })');
    }
    const id = Number(ticketId);
    if (!Number.isInteger(id) || id <= 0) throw new TypeError(`generateSpecDraft: ticketId inválido (${ticketId})`);
    const issue = unwrapIssue(await mcpClient.getIssue({ issueId: id, queryParams: {} }));
    if (!issue) throw new Error(`generateSpecDraft: ticket #${id} não retornado pelo Redmine`);
    return buildSpecDraft(issue, opts);
}

// Adaptador com a interface de mcp__redmine__getIssue sobre a API REST — o watcher é
// um processo Node, não uma sessão de agente, e não tem cliente MCP. `fetchImpl` é o
// redmineFetch (throttle + retry); a key vai só no header, nunca em log/erro.
function createRestMcpClient({ baseUrl, apiKey, fetchImpl }) {
    return {
        async getIssue({ issueId, queryParams = {} }) {
            const include = [].concat(queryParams.include || []).join(',');
            const qs = include ? `?include=${encodeURIComponent(include)}` : '';
            const res = await fetchImpl(`${baseUrl}/issues/${issueId}.json${qs}`, {
                headers: { 'X-Redmine-API-Key': apiKey },
            });
            if (!res.ok) throw new Error(`Redmine GET issue #${issueId}: HTTP ${res.status}`);
            return res.json();
        },
    };
}

module.exports = {
    generateSpecDraft, buildSpecDraft, createRestMcpClient,
    inferMicroservices, categoryOverrides, suggestPlanGranularity, splitDescription, gherkinToCriteria,
    parseFrontmatter, isDraftSpec, isGeneratedSpec, unwrapIssue,
    DEFAULT_TEMPLATE_PATH, NOT_INFORMED,
};

if (require.main === module) {
    const ticketId = process.argv[2];
    if (!ticketId) {
        console.error('Uso: node scripts/lib/spec-generator.js <ticket>');
        process.exit(2);
    }
    const { redmineFetch } = require('./redmine-fetch');
    const client = createRestMcpClient({
        baseUrl: process.env.REDMINE_URL, apiKey: process.env.REDMINE_API_KEY, fetchImpl: redmineFetch,
    });
    generateSpecDraft(ticketId, client, { repoRoot: process.env.REPO_PATH || process.cwd() })
        .then(d => process.stdout.write(d.content))
        .catch(e => { console.error(e.message); process.exit(1); });
}
