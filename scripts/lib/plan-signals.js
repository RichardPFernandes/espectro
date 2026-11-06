// Sinais prospectivos e retrospectivos por subtarefa (PRI-205 S2 / PRI-222).
// Desenho: prisma-evidence/pri-205/desenho-selecao-modelo.md (v9) §3.4, §4.2–§4.5.
//
// SOMENTE OBSERVACIONAL. Este módulo não classifica (sem C1–C5), não escolhe modelo,
// não decide nada: devolve fatos. Regra de ouro (§4.1): sinal ausente é 'UNKNOWN',
// nunca zero/false. Funções puras — quem lê git/disco é o watcher.

const crypto = require('crypto');
const planScorer = require('./plan-scorer');
const acRegistry = require('./ac-registry');
const schemaWatcher = require('./schema-watcher');
const { serviceOf } = require('./service-detector');

const UNKNOWN = 'UNKNOWN';

// Listas iniciais do §4.3: proposta para calibração, não thresholds aprovados. A S3
// as move para a policy versionada; aqui são o padrão e podem ser sobrescritas.
const DEFAULT_POLICY = Object.freeze({
    service_roots: ['backend'],
    sensitive_globs: ['**/auth/**', '**/authn/**', '**/authz/**', '**/security/**', '**/session/**', '**/sessions/**',
        '**/permission/**', '**/permissions/**', '**/tenant/**', '**/tenants/**', '**/secret/**', '**/secrets/**',
        '**/crypto/**', '**/payment/**', '**/payments/**'],
    sensitive_terms: ['auth', 'login', 'token', 'senha', 'permiss', 'tenant', 'isolamento', 'segredo', 'criptograf', 'lgpd'],
    behavior_globs: ['.claude/**', '.agents/**', 'memory/**', 'decisions/**', 'AGENTS.md', 'CLAUDE.md', 'docs/handoff-contract.md'],
    config_globs: ['**/*.yml', '**/*.yaml', '**/*.properties', '**/*.toml', '.env*', '**/.env*', '**/Dockerfile*',
        '**/package.json', '**/pom.xml', '**/*.gradle*', '.github/**'],
    test_globs: ['**/test/**', '**/tests/**', '**/*.test.*', '**/*.spec.*', '**/*Test.java', '**/*Tests.java'],
    docs_globs: ['**/*.md', 'docs/**'],
    shared_code_globs: ['**/shared/**', '**/common/**', 'scripts/lib/**'],
});

// Ordem do §4.2: a maior natureza entre os caminhos vale.
const KIND_ORDER = ['sensitive', 'schema', 'behavior', 'config', 'code', 'test', 'docs'];

function normPath(p) {
    return String(p || '').trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '');
}

function globToRe(glob) {
    let re = '';
    for (let i = 0; i < glob.length; i++) {
        const c = glob[i];
        if (c === '*' && glob[i + 1] === '*') {
            if (glob[i + 2] === '/') { re += '(?:.*/)?'; i += 2; } else { re += '.*'; i += 1; }
        } else if (c === '*') re += '[^/]*';
        else re += c.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
    }
    return new RegExp(`^${re}$`, 'i');
}

const GLOB_CACHE = new Map();
function compiledGlob(g) {
    if (!GLOB_CACHE.has(g)) GLOB_CACHE.set(g, globToRe(g));
    return GLOB_CACHE.get(g);
}

function matchesAny(file, globs) {
    return (globs || []).some(g => compiledGlob(g).test(file));
}

// Natureza de UM caminho (a do grupo é a maior entre os caminhos). `behavior` vem antes
// de `docs`: .md de prompt/governança nunca é docs. D18 (a): `isCandidate` => schema,
// inclusive .java de teste (conservador e declarado).
function kindOfPath(file, policy = DEFAULT_POLICY) {
    if (matchesAny(file, policy.sensitive_globs)) return 'sensitive';
    if (schemaWatcher.isCandidate(file)) return 'schema';
    if (matchesAny(file, policy.behavior_globs)) return 'behavior';
    if (matchesAny(file, policy.config_globs)) return 'config';
    if (matchesAny(file, policy.test_globs)) return 'test';
    if (matchesAny(file, policy.docs_globs)) return 'docs';
    return 'code';
}

function maxKind(kinds) {
    return KIND_ORDER.find(k => kinds.includes(k)) || UNKNOWN;
}

// DV03: buckets distintos, sem usar analyzeChangedFiles. Docs não contam; caminho de
// código fora de qualquer serviço vai para __root__. Sem topologia declarada => UNKNOWN.
function serviceBuckets(paths, policy = DEFAULT_POLICY) {
    const roots = policy.service_roots;
    if (!Array.isArray(roots) || !roots.length) return UNKNOWN;
    const buckets = new Set();
    for (const p of paths) {
        if (kindOfPath(p, policy) === 'docs') continue;
        let bucket = '__root__';
        for (const root of roots) {
            const svc = serviceOf(p, root);
            if (svc) { bucket = `service:${svc}`; break; }
        }
        buckets.add(bucket);
    }
    return [...buckets].sort();
}

// ---------------------------------------------------------------------------------
// Extração dos passos do plano

function parsePathsLine(line) {
    const body = line.replace(/^\s*[-*]?\s*arquivos?\s*:\s*/i, '');
    const ticked = [...body.matchAll(/`([^`]+)`/g)].map(m => m[1]);
    const raw = ticked.length ? ticked : body.split(/[,;]|\se\s/).map(t => t.trim().replace(/[.)]+$/, ''));
    const out = [];
    for (const t of raw) {
        // Sufixos de posição (`x.js:42`, `X.java::metodo`) não fazem parte do caminho.
        const p = normPath(t.replace(/\s*\(.*$/, '').replace(/::.*$/, '').replace(/:\d+(?:[-:]\d+)*$/, ''));
        // Caminho concreto: sem "...", sem curinga, sem espaço (salvo entre crases); com "/" ou extensão.
        // Diretório (termina em "/") não é arquivo: lista incompleta => UNKNOWN.
        if (!p || /\/$/.test(p) || /\.\.\./.test(p) || (ticked.length && /[,;]|\se\s/.test(p)) || (!ticked.length && /\s/.test(p)) || /[*<>{}]/.test(p) || !/[/.]/.test(p)) return null;
        out.push(p);
    }
    return out.length ? [...new Set(out)] : null;
}

/**
 * @returns {{plan_version: string, steps: Array<{index: number, paths_decl: string[]|'UNKNOWN',
 *   acs: string[], text: string}>}} plan_version = null quando não há bloco de plano.
 */
function extractPlanSteps(planContent) {
    const { steps, block } = planScorer.extractSteps(planContent);
    if (!steps.length) return { plan_version: null, steps: [] };
    // D14: SHA-256 do bloco normalizado (espaços e quebras de linha colapsados).
    const planVersion = crypto.createHash('sha256').update(block.replace(/\s+/g, ' ').trim()).digest('hex');
    return {
        plan_version: planVersion,
        steps: steps.map((text, i) => {
            const lines = text.split('\n');
            // Mais de uma linha "Arquivo:" no passo: lista possivelmente parcial => UNKNOWN
            // (nunca subestimar paths_decl; §4.1).
            const fileLines = lines.filter(l => /^\s*[-*]?\s*arquivos?\s*:/i.test(l));
            const fileLine = fileLines.length === 1 ? fileLines[0] : null;
            const acLine = lines.find(l => /^\s*[-*]?\s*crit[eé]rios?\s*:/i.test(l));
            return {
                index: i + 1,
                text,
                paths_decl: (fileLine && parsePathsLine(fileLine)) || UNKNOWN,
                acs: acLine ? [...new Set(acLine.match(/\bAC-\d+\b/g) || [])] : [],
            };
        }),
    };
}

// D14: passos que declaram arquivos em comum formam um grupo (fecho transitivo); passo
// sem `Arquivo:` parseável vira grupo próprio. subtask_key = <pv[0:12]>/<menor>-<maior>.
function groupSteps(planVersion, steps) {
    const parent = steps.map((_, i) => i);
    const find = i => (parent[i] === i ? i : (parent[i] = find(parent[i])));
    const owner = new Map();
    steps.forEach((s, i) => {
        if (s.paths_decl === UNKNOWN) return;
        for (const p of s.paths_decl) {
            if (owner.has(p)) parent[find(i)] = find(owner.get(p)); else owner.set(p, i);
        }
    });
    const groups = new Map();
    steps.forEach((s, i) => {
        const r = find(i);
        if (!groups.has(r)) groups.set(r, []);
        groups.get(r).push(s);
    });
    return [...groups.values()].map(members => {
        const idx = members.map(m => m.index).sort((a, b) => a - b);
        return {
            subtask_key: `${planVersion.slice(0, 12)}/${idx[0]}-${idx[idx.length - 1]}`,
            steps: idx,
            members,
        };
    }).sort((a, b) => a.steps[0] - b.steps[0]);
}

// ---------------------------------------------------------------------------------
// Sinais prospectivos (§4.2)

function acTexts(specContent) {
    const out = new Map();
    if (!specContent) return out;
    try {
        const { acIds, criteria } = acRegistry.extractACs(specContent, 'x');
        acIds.forEach((id, i) => out.set(id, criteria[i] || ''));
    } catch { /* spec ilegível: nenhum AC conhecido */ }
    return out;
}

function mentionsSensitiveTerm(text, terms) {
    const t = String(text || '').toLowerCase();
    return (terms || []).some(term => t.includes(term));
}

/**
 * @param group      item de groupSteps
 * @param ctx        { policy?, specContent?, fileExists?(rel)=>bool, state?, costTracking? }
 */
function prospectiveSignals(group, ctx = {}) {
    const policy = ctx.policy || DEFAULT_POLICY;
    const members = group.members;
    const known = !members.some(m => m.paths_decl === UNKNOWN);
    const paths = known ? [...new Set(members.flatMap(m => m.paths_decl))].sort() : UNKNOWN;
    const kind = known ? maxKind(paths.map(p => kindOfPath(p, policy))) : UNKNOWN;

    let nNew = UNKNOWN;
    if (known && typeof ctx.fileExists === 'function') {
        try { nNew = paths.filter(p => !ctx.fileExists(p)).length; } catch { nNew = UNKNOWN; }
    }

    const buckets = known ? serviceBuckets(paths, policy) : UNKNOWN;

    // n_acs_step: sem nenhum id e kind != test => UNKNOWN; passo só de teste => 0 válido.
    const acIds = [...new Set(members.flatMap(m => m.acs))].sort();
    const nAcs = acIds.length ? acIds.length : (kind === 'test' ? 0 : UNKNOWN);

    // sensitive_decl: true se caminho em sensitive_globs OU texto casa sensitive_terms;
    // senão UNKNOWN se algum AC referenciado não está na spec; senão false.
    const specAcs = acTexts(ctx.specContent);
    const texts = members.map(m => m.text).concat(acIds.map(id => specAcs.get(id)).filter(Boolean));
    let sensitive;
    if ((known && paths.some(p => matchesAny(p, policy.sensitive_globs))) || texts.some(t => mentionsSensitiveTerm(t, policy.sensitive_terms))) {
        sensitive = true;
    } else if (!known || acIds.some(id => !specAcs.has(id))) sensitive = UNKNOWN;
    else sensitive = false;

    const hasShared = known && paths.some(p => matchesAny(p, policy.shared_code_globs));
    let codeLocal = UNKNOWN;
    if (known && Array.isArray(buckets)) codeLocal = kind === 'code' && buckets.length <= 1 && !hasShared;

    const state = ctx.state || {};
    const prior = ctx.costTracking?.nodes?.implement?.attempts;
    return {
        paths_decl: paths,
        n_files: known ? paths.length : UNKNOWN,
        n_new_files: nNew,
        kind,
        n_services_decl: Array.isArray(buckets) ? buckets.length : UNKNOWN,
        service_buckets: buckets,
        schema_decl: known ? paths.some(p => schemaWatcher.isCandidate(p)) : UNKNOWN,
        sensitive_decl: sensitive,
        n_acs_step: nAcs,
        code_local: codeLocal,
        // Proxy conservador: Attempts anteriores do implement com a mesma subtask_key
        // (retry de falha também conta; só pode subir a classe, nunca descer). 0 se nenhum.
        rework_count: Array.isArray(prior)
            ? prior.filter(a => a?.signals?.groups?.some?.(g => g.subtask_key === group.subtask_key)).length : 0,
        ticket_rework: Boolean(ctx.isRecusaQA) || Number(state.planAttempts) > 0 || Number(state.retries?.implement) > 0,
        schema_risk_seen: state.schema_risk_level ?? null,
    };
}

function buildProspective(planContent, ctx = {}) {
    const { plan_version, steps } = extractPlanSteps(planContent);
    if (!plan_version) return { status: UNKNOWN, cause: 'PLAN_BLOCK_NOT_FOUND', plan_version: UNKNOWN, groups: [] };
    const groups = groupSteps(plan_version, steps).map(g => ({
        subtask_key: g.subtask_key,
        steps: g.steps,
        signals: prospectiveSignals(g, ctx),
    }));
    return { status: 'COMPLETE', plan_version, plan_steps: steps.length, groups };
}

// ---------------------------------------------------------------------------------
// Sinais retrospectivos (§4.2; só calibração e reclassificação para cima)

// Artefatos do próprio fluxo, fora da comparação declarado × tocado (mesma exclusão de
// memory/runs/** declarada para o manifesto do §3.5). A spec do ticket também.
const FLOW_ARTIFACTS = [/^memory\/runs\//, /^memory\/spec\//];
function isFlowArtifact(file) { return FLOW_ARTIFACTS.some(re => re.test(normPath(file))); }

/**
 * @param input {changedFiles: string[]|null, diffStat: {added,removed}|null,
 *   affected: {services:string[], fullSuite:boolean}|null, schema: {detected:boolean,riskLevel:string|null}|null,
 *   declaredPaths: string[]|'UNKNOWN', state?: object}
 */
function retrospectiveSignals(input) {
    const files = Array.isArray(input.changedFiles)
        ? [...new Set(input.changedFiles.map(normPath).filter(f => f && !isFlowArtifact(f)))].sort()
        : null;
    const declared = Array.isArray(input.declaredPaths) ? new Set(input.declaredPaths) : null;
    const undeclared = files && declared ? files.filter(f => !declared.has(f)) : null;
    return {
        status: [files, input.diffStat, input.affected, input.schema].every(Boolean) && declared ? 'COMPLETE' : 'PARTIAL',
        files_touched: files ? files.length : UNKNOWN,
        files_declared: declared ? declared.size : UNKNOWN,
        undeclared_files: undeclared ? undeclared.length : UNKNOWN,
        scope_violation: undeclared ? undeclared.length > 0 : UNKNOWN,
        affected_services: input.affected ? input.affected.services : UNKNOWN,
        full_suite: input.affected ? input.affected.fullSuite : UNKNOWN,
        schema_changes_detected: input.schema ? input.schema.detected : UNKNOWN,
        schema_risk_level: input.schema ? (input.schema.detected ? input.schema.riskLevel : null) : UNKNOWN,
        diff_lines_added: input.diffStat ? input.diffStat.added : UNKNOWN,
        diff_lines_removed: input.diffStat ? input.diffStat.removed : UNKNOWN,
        risk_level_seen: input.state?.risk_level ?? UNKNOWN,
        tokens_vs_p90: 'UNAVAILABLE',
    };
}

function declaredUnion(prospective) {
    if (!prospective || !Array.isArray(prospective.groups) || !prospective.groups.length) return UNKNOWN;
    const all = [];
    for (const g of prospective.groups) {
        if (!Array.isArray(g.signals?.paths_decl)) return UNKNOWN;
        all.push(...g.signals.paths_decl);
    }
    return [...new Set(all)];
}

// PRI-205 S3b (T7): envelope por grupo para o núcleo 2 (Jev em sombra). Só o texto
// dos passos, o texto dos ACs citados que existem na spec e os caminhos declarados
// (R-2). Passo com bloco de código (``` ou ~~~) não vira envelope: nada de código sai.
// Devolve Map subtask_key → { ok: true, envelope } | { ok: false, reason }.
const CODE_BLOCK = /```|~~~/;
function classifierEnvelopes(planContent, specContent) {
    const out = new Map();
    const { plan_version, steps } = extractPlanSteps(planContent);
    if (!plan_version) return out;
    const specAcs = acTexts(specContent);
    for (const g of groupSteps(plan_version, steps)) {
        if (g.members.some(m => CODE_BLOCK.test(m.text))) {
            out.set(g.subtask_key, { ok: false, reason: 'STEP_HAS_CODE_BLOCK' });
            continue;
        }
        const known = !g.members.some(m => m.paths_decl === UNKNOWN);
        const paths = known ? [...new Set(g.members.flatMap(m => m.paths_decl))].sort() : [];
        const acIds = [...new Set(g.members.flatMap(m => m.acs))].sort().filter(id => specAcs.has(id));
        out.set(g.subtask_key, {
            ok: true,
            envelope: {
                step_text: g.members.map(m => m.text).join('\n\n'),
                ac_texts: acIds.map(id => `${id}: ${specAcs.get(id)}`),
                declared_paths: paths,
            },
        });
    }
    return out;
}

module.exports = {
    UNKNOWN, DEFAULT_POLICY, KIND_ORDER, kindOfPath, maxKind, serviceBuckets, matchesAny,
    extractPlanSteps, groupSteps, prospectiveSignals, buildProspective, retrospectiveSignals, declaredUnion, isFlowArtifact,
    classifierEnvelopes,
};
