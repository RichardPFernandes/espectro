// Validação da configuração do fluxo agêntico (.claude/, .graph/, .env.example) contra
// o contrato em .claude/config-contract.json.
//
// Existe porque edição manual nessas pastas quebrava em silêncio e só aparecia em
// runtime: nó do grafo sem template em .claude/commands/ (o watcher despacha um
// comando que não existe), variável lida no código sem entrada no .env.example
// (ninguém sabe que ela existe), worktree de ciclo encerrado acumulando em
// .claude/worktrees/, state.json antigo que não valida mais contra o schema atual
// (o watcher o marca state_corrupted no próximo tick).
//
// Cada regra devolve um resultado — ou uma lista, quando os achados têm severidades
// diferentes — no formato { rule, severity, passed, message, details?, fixes? }.
// `fixes` só aparece em worktrees-clean: é o que o --fix do CLI sabe desfazer
// (applyFixes). Nenhuma regra escreve em disco; applyFixes só remove worktree.
//
// Caminhos do contrato são relativos à raiz do app-back (pasta pai de .claude/).
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { validateState } = require('../validate-state');
const { cleanupWorktrees, stopPreviewViaDashboard } = require('./worktree-cleanup');

let Ajv = null;
try { Ajv = require('ajv'); } catch { Ajv = null; }

const DEFAULT_CONFIG_PATH = path.join(process.env.REPO_PATH || process.cwd(), '.claude', 'config-contract.json');
const SEVERITIES = ['error', 'warning', 'info'];

const rel = (root, p) => path.relative(root, p) || '.';
const readText = p => { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } };
const isDir = p => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };
const listDirs = p => { try { return fs.readdirSync(p, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name); } catch { return []; } };

function defaultExec(cmd, args) {
    return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 15000 });
}

// ── YAML mínimo ─────────────────────────────────────────────────────────────────
// Só o subconjunto que .graph/graph.yaml usa (mesma escolha de lib/node-events.js:
// sem dependência de YAML): escalares `chave: valor`, blocos `>`/`|` (texto
// indentado, descartado como string) e uma lista de mapas `- chave: valor`.
// Estrutura fora disso vira erro de parse — melhor reprovar que validar pela metade.
function scalar(raw) {
    const v = raw.trim();
    if (/^-?\d+$/.test(v)) return Number(v);
    if (v === 'true' || v === 'false') return v === 'true';
    if (v === '' || v === '~' || v === 'null') return null;
    const q = v.match(/^(['"])(.*)\1$/);
    return q ? q[2] : v;
}

function parseGraphYaml(text) {
    const data = {};
    const errors = [];
    const lines = text.split('\n');
    let list = null;      // array da chave de lista corrente
    let item = null;      // mapa do item corrente da lista
    let blockIndent = -1; // indentação mínima do bloco `>`/`|` sendo pulado
    let blockTarget = null;
    lines.forEach((line, i) => {
        const noComment = line.replace(/\s+#.*$/, '').replace(/^\s*#.*$/, '');
        if (!noComment.trim()) return;
        const indent = line.match(/^ */)[0].length;
        if (blockTarget) {
            if (indent > blockIndent) { blockTarget.obj[blockTarget.key] += (blockTarget.obj[blockTarget.key] ? ' ' : '') + noComment.trim(); return; }
            blockTarget = null;
        }
        const listItem = noComment.match(/^(\s*)-\s+([\w-]+):\s*(.*)$/);
        const kv = noComment.match(/^(\s*)([\w-]+):\s*(.*)$/);
        let obj; let key; let value; let keyIndent;
        if (listItem && list) {
            item = {}; list.push(item);
            obj = item; key = listItem[2]; value = listItem[3]; keyIndent = listItem[1].length + 2;
        } else if (kv && indent === 0) {
            list = null; item = null;
            obj = data; key = kv[2]; value = kv[3]; keyIndent = 0;
            if (!value.trim()) { data[key] = []; list = data[key]; return; }
        } else if (kv && item && kv[3].trim()) {
            obj = item; key = kv[2]; value = kv[3]; keyIndent = indent;
        } else {
            errors.push(`linha ${i + 1}: estrutura não suportada: ${line.trim()}`);
            return;
        }
        if (/^[>|][-+]?$/.test(value.trim())) {
            obj[key] = '';
            blockTarget = { obj, key }; blockIndent = keyIndent;
            return;
        }
        obj[key] = scalar(value);
    });
    return { data, errors };
}

function readConfigFile(file, format) {
    const text = readText(file);
    if (text === null) return { missing: true };
    if (format === 'yaml') {
        const { data, errors } = parseGraphYaml(text);
        return errors.length ? { error: errors.join('; ') } : { data };
    }
    try { return { data: JSON.parse(text) }; } catch (e) { return { error: `JSON inválido: ${e.message}` }; }
}

// ── Contexto compartilhado entre as regras ───────────────────────────────────────
function loadContract(configPath) {
    const text = readText(configPath);
    if (text === null) throw new Error(`contrato não encontrado: ${configPath}`);
    let contract;
    try { contract = JSON.parse(text); } catch (e) { throw new Error(`contrato ilegível (${configPath}): ${e.message}`); }
    if (typeof contract.contractVersion !== 'string' || !contract.contractVersion) {
        throw new Error(`contrato sem contractVersion: ${configPath}`);
    }
    return contract;
}

function createContext(configPath, opts = {}) {
    const contract = loadContract(configPath);
    const root = path.resolve(opts.root || path.join(path.dirname(configPath), '..'));
    const graphFile = path.join(root, contract.graph.file);
    const graphRead = readConfigFile(graphFile, 'yaml');
    return {
        root,
        contract,
        exec: opts.exec || defaultExec,
        env: opts.env || process.env,
        graphFile,
        graph: graphRead.data || null,
        graphError: graphRead.missing ? `${contract.graph.file} não encontrado` : graphRead.error || null,
    };
}

function graphNodes(ctx) {
    return Array.isArray(ctx.graph?.nodes) ? ctx.graph.nodes.filter(n => n && typeof n.id === 'string') : [];
}

// Resultado com severidade padrão da regra (contract.rules.<id>.severity).
function makeResult(ctx, rule, fields) {
    const severity = fields.severity || ctx.contract.rules?.[rule]?.severity || 'error';
    return { rule, severity, passed: false, message: '', ...fields };
}

function graphUnavailable(ctx, rule) {
    return makeResult(ctx, rule, { severity: 'error', message: `não deu pra ler o grafo: ${ctx.graphError}` });
}

// ── Regra: config-files-schema ───────────────────────────────────────────────────
function compileSchema(schema) {
    const ajv = new Ajv({ allErrors: true, strict: false });
    return ajv.compile(schema);
}

function ruleConfigFilesSchema(ctx) {
    const rule = 'config-files-schema';
    const problems = [];
    const notes = [];
    for (const [relPath, spec] of Object.entries(ctx.contract.files || {})) {
        const r = readConfigFile(path.join(ctx.root, relPath), spec.format || 'json');
        if (r.missing) {
            if (!spec.optional) problems.push(`${relPath}: arquivo obrigatório não existe`);
            continue;
        }
        if (r.error) { problems.push(`${relPath}: ${r.error}`); continue; }
        if (!Ajv) { notes.push(`${relPath}: ajv não instalado (npm install em scripts/) — só o parse foi checado`); continue; }
        const validate = compileSchema(spec.schema || {});
        if (!validate(r.data)) {
            for (const e of validate.errors) {
                const where = e.instancePath || '(raiz)';
                const what = e.keyword === 'required' ? `sem campo obrigatório "${e.params.missingProperty}"`
                    : e.keyword === 'additionalProperties' ? `campo não previsto no contrato "${e.params.additionalProperty}"`
                        : e.keyword === 'enum' ? `${e.message}: ${e.params.allowedValues.join(', ')}` : e.message;
                problems.push(`${relPath} ${where}: ${what}`);
            }
        }
    }
    // Nós do grafo x graph.validNodes do contrato.
    const valid = ctx.contract.graph?.validNodes || [];
    const ids = graphNodes(ctx).map(n => n.id);
    for (const id of ids) if (!valid.includes(id)) problems.push(`${ctx.contract.graph.file}: nó "${id}" não está em graph.validNodes do contrato`);
    const missingNodes = ctx.graph ? valid.filter(v => !ids.includes(v)) : [];

    const out = [];
    const checked = Object.keys(ctx.contract.files || {}).length;
    out.push(problems.length
        ? makeResult(ctx, rule, { message: `${problems.length} problema(s) de estrutura nos arquivos de configuração`, details: problems })
        : makeResult(ctx, rule, { passed: true, message: `${checked} arquivo(s) de configuração conferem com o contrato` }));
    if (missingNodes.length) {
        out.push(makeResult(ctx, rule, { severity: 'warning', message: `nó(s) do contrato ausentes do grafo: ${missingNodes.join(', ')}`, details: missingNodes }));
    }
    if (notes.length) out.push(makeResult(ctx, rule, { severity: 'info', message: 'validação de schema parcial', details: notes }));
    return out;
}

// ── Regra: nodes-have-templates ──────────────────────────────────────────────────
function parseFrontmatter(text) {
    const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
    if (!m) return { frontmatter: null, body: text };
    const frontmatter = {};
    for (const line of m[1].split('\n')) {
        const kv = line.match(/^([\w-]+):\s*(.*)$/);
        if (kv) frontmatter[kv[1]] = kv[2].trim();
    }
    return { frontmatter, body: text.slice(m[0].length) };
}

function templatePathFor(ctx, command) {
    const t = ctx.contract.templates;
    const name = String(command || '').replace(/^\//, '');
    return path.join(ctx.root, t.dir, (t.fileFromCommand || '{command}.md').replace('{command}', name));
}

function ruleNodesHaveTemplates(ctx) {
    const rule = 'nodes-have-templates';
    if (!ctx.graph) return graphUnavailable(ctx, rule);
    const t = ctx.contract.templates;
    const required = t.requiredFrontmatter || [];
    const known = new Set([...required, ...(t.optionalFrontmatter || [])]);
    const minBody = t.minBodyChars || 0;
    const problems = [];
    const unknownKeys = [];
    const used = new Set();
    const nodes = graphNodes(ctx);
    for (const n of nodes) {
        if (!n.command) { problems.push(`nó "${n.id}" sem campo command`); continue; }
        const file = templatePathFor(ctx, n.command);
        used.add(path.resolve(file));
        const text = readText(file);
        if (text === null) { problems.push(`nó "${n.id}" (${n.command}) sem template: ${rel(ctx.root, file)} não existe`); continue; }
        const { frontmatter, body } = parseFrontmatter(text);
        if (required.length && !frontmatter) { problems.push(`${rel(ctx.root, file)}: sem frontmatter (--- ... ---)`); continue; }
        for (const k of required) if (!frontmatter[k]) problems.push(`${rel(ctx.root, file)}: frontmatter sem "${k}"`);
        for (const k of Object.keys(frontmatter || {})) if (!known.has(k)) unknownKeys.push(`${rel(ctx.root, file)}: "${k}"`);
        if (body.trim().length < minBody) problems.push(`${rel(ctx.root, file)}: corpo com ${body.trim().length} caracteres (mínimo ${minBody}) — template vazio ou truncado`);
    }
    const dir = path.join(ctx.root, t.dir);
    let extra = [];
    try { extra = fs.readdirSync(dir).filter(f => f.endsWith('.md') && !used.has(path.resolve(dir, f))); } catch { /* dir ausente já aparece como template faltando */ }

    const out = [problems.length
        ? makeResult(ctx, rule, { message: `${problems.length} problema(s) nos templates dos nós`, details: problems })
        : makeResult(ctx, rule, { passed: true, message: `${nodes.length} nó(s) com template válido em ${t.dir}/` })];
    if (unknownKeys.length) out.push(makeResult(ctx, rule, { severity: 'info', message: 'frontmatter com campo fora do contrato (templates.optionalFrontmatter)', details: unknownKeys }));
    if (extra.length) out.push(makeResult(ctx, rule, { severity: 'info', message: `${extra.length} comando(s) em ${t.dir}/ fora do grafo`, details: extra }));
    return out;
}

// ── Regra: graph-acyclic ─────────────────────────────────────────────────────────
function findForwardCycle(nodes, forwardEdges) {
    const next = new Map(nodes.map(n => [n.id, forwardEdges.map(e => n[e]).filter(Boolean)]));
    const state = new Map(); // 1 = na pilha, 2 = visitado
    const stack = [];
    const visit = id => {
        if (state.get(id) === 2 || !next.has(id)) return null;
        if (state.get(id) === 1) return [...stack.slice(stack.indexOf(id)), id];
        state.set(id, 1); stack.push(id);
        for (const to of next.get(id)) { const c = visit(to); if (c) return c; }
        stack.pop(); state.set(id, 2);
        return null;
    };
    for (const n of nodes) { const c = visit(n.id); if (c) return c; }
    return null;
}

function ruleGraphAcyclic(ctx) {
    const rule = 'graph-acyclic';
    if (!ctx.graph) return graphUnavailable(ctx, rule);
    const g = ctx.contract.graph;
    const forward = g.forwardEdges || ['on_success', 'on_pass'];
    const retry = g.retryEdges || ['on_fail'];
    const nodes = graphNodes(ctx);
    const ids = new Set();
    const problems = [];
    const warnings = [];
    for (const n of nodes) {
        if (ids.has(n.id)) problems.push(`nó "${n.id}" duplicado`);
        ids.add(n.id);
    }
    const entry = ctx.graph.entry_point;
    if (!ids.has(entry)) problems.push(`entry_point "${entry}" não é um nó do grafo`);
    else if (g.entryPoint && entry !== g.entryPoint) warnings.push(`entry_point é "${entry}", o contrato espera "${g.entryPoint}"`);
    for (const n of nodes) {
        for (const e of [...forward, ...retry]) {
            if (n[e] !== undefined && !ids.has(n[e])) problems.push(`${n.id}.${e} aponta pra nó inexistente "${n[e]}"`);
        }
        const retries = retry.filter(e => n[e]);
        if (retries.length && !(Number.isInteger(n.max_retries) && n.max_retries > 0)) {
            problems.push(`${n.id}.${retries[0]} sem max_retries — loop de retry sem limite`);
        }
        const hasForward = forward.some(e => n[e]);
        if (n.terminal && hasForward) problems.push(`nó terminal "${n.id}" tem aresta de avanço`);
        if (!n.terminal && !hasForward) problems.push(`nó "${n.id}" sem aresta de avanço e não marcado terminal — beco sem saída`);
    }
    for (const t of g.terminalNodes || []) {
        const n = nodes.find(x => x.id === t);
        if (n && !n.terminal) problems.push(`nó "${t}" deveria ser terminal (graph.terminalNodes do contrato)`);
    }
    const cycle = findForwardCycle(nodes, forward);
    if (cycle) problems.push(`ciclo nas arestas de avanço: ${cycle.join(' → ')}`);

    // Alcançabilidade a partir dos entry points (todas as arestas).
    const reach = new Set();
    const queue = [entry, ...(g.alternateEntryPoints || [])].filter(id => ids.has(id));
    while (queue.length) {
        const id = queue.shift();
        if (reach.has(id)) continue;
        reach.add(id);
        const n = nodes.find(x => x.id === id);
        for (const e of [...forward, ...retry]) if (n[e] && ids.has(n[e])) queue.push(n[e]);
    }
    const unreachable = nodes.filter(n => !reach.has(n.id)).map(n => n.id);
    if (unreachable.length) warnings.push(`nó(s) inalcançáveis a partir dos entry points: ${unreachable.join(', ')}`);

    const out = [problems.length
        ? makeResult(ctx, rule, { message: `${problems.length} problema(s) na topologia do grafo`, details: problems })
        : makeResult(ctx, rule, { passed: true, message: `grafo sem ciclos de avanço (${nodes.length} nós; retries limitados por max_retries)` })];
    if (warnings.length) out.push(makeResult(ctx, rule, { severity: 'warning', message: `${warnings.length} aviso(s) na topologia do grafo`, details: warnings }));
    return out;
}

// ── Runs (state-schema-compat e worktrees-clean) ─────────────────────────────────
// Diretórios de run: memory/runs/<task>, memory/runs/_archive/<task>,
// memory/archive/<YYYY-MM>/<task> e, dentro de cada worktree de ticket,
// memory/runs[/_archive]/<ticket>-* — só os do próprio ticket: os worktrees carregam
// cópias legadas de memory/runs de outras tasks, que não são runs deles.
function expandDirs(root, patterns) {
    const out = [];
    for (const p of patterns || []) {
        if (p.endsWith('/*')) {
            const base = path.join(root, p.slice(0, -2));
            for (const d of listDirs(base)) out.push(path.join(base, d));
        } else out.push(path.join(root, p));
    }
    return out;
}

function runsIn(dir, { archived, onlyTicket = null, source }) {
    const out = [];
    for (const name of listDirs(dir)) {
        if (name.startsWith('_') || name.startsWith('.')) continue;
        if (onlyTicket && !name.startsWith(`${onlyTicket}-`)) continue;
        const stateFile = path.join(dir, name, 'state.json');
        if (!fs.existsSync(stateFile)) continue;
        out.push({ taskId: name, dir: path.join(dir, name), stateFile, archived, source });
    }
    return out;
}

function matchTicketDir(ctx, name) {
    const pattern = ctx.contract?.worktrees?.ticketPattern;
    if (!pattern || name == null) return null;
    const m = new RegExp(pattern).exec(String(name));
    if (!m) return null;
    // Grupo nomeado `ticket` (nome maior que o id), senão o primeiro grupo.
    // Padrão sem grupo — o contrato histórico e quem o copiou — usa o match inteiro.
    const ticket = (m.groups && m.groups.ticket) || m[1] || m[0];
    if (!ticket) return null;
    return { ticket: String(ticket), entire: m[0] === String(name) };
}

function ticketOfDir(ctx, name) {
    return matchTicketDir(ctx, name)?.ticket || null;
}

function collectRuns(ctx) {
    const s = ctx.contract.stateSchema;
    const runs = [];
    for (const d of expandDirs(ctx.root, s.activeRunsDirs)) runs.push(...runsIn(d, { archived: false, source: 'main' }));
    for (const d of expandDirs(ctx.root, s.archivedRunsDirs)) runs.push(...runsIn(d, { archived: true, source: 'main' }));
    if (s.includeTicketWorktrees) {
        const wtDir = path.join(ctx.root, ctx.contract.worktrees.dir);
        for (const name of listDirs(wtDir)) {
            const hit = matchTicketDir(ctx, name);
            // O padrão casa o diretório inteiro (pre-601 com ^pre-(\d+)$), mesmo
            // quando o id capturado é mais curto. Prefixo de irmão (601-app-core
            // com ^(\d+)) não carrega memory/.
            if (!hit || !hit.entire) continue;
            const base = path.join(wtDir, name, 'memory', 'runs');
            runs.push(...runsIn(base, { archived: false, onlyTicket: hit.ticket, source: 'worktree' }));
            runs.push(...runsIn(path.join(base, '_archive'), { archived: true, onlyTicket: hit.ticket, source: 'worktree' }));
        }
    }
    for (const r of runs) {
        try { r.state = JSON.parse(fs.readFileSync(r.stateFile, 'utf8')); } catch (e) { r.parseError = e.message; }
    }
    return runs;
}

const runTime = st => Date.parse(st?.updated_at || st?.node_started_at || st?.started_at || '') || 0;

// ── Regra: state-schema-compat ───────────────────────────────────────────────────
function ruleStateSchemaCompat(ctx) {
    const rule = 'state-schema-compat';
    const schemaPath = path.join(ctx.root, ctx.contract.stateSchema.schema);
    let schema;
    try { schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8')); } catch (e) {
        return makeResult(ctx, rule, { message: `schema ilegível: ${rel(ctx.root, schemaPath)} (${e.message})` });
    }
    const out = [];
    const nodeEnum = schema.properties?.node?.enum || [];
    const missing = graphNodes(ctx).map(n => n.id).filter(id => !nodeEnum.includes(id));
    if (missing.length) {
        out.push(makeResult(ctx, rule, { message: `enum de "node" do state.schema.json não cobre nó(s) do grafo: ${missing.join(', ')}`, details: missing.map(id => `state.json com node="${id}" seria marcado state_corrupted`) }));
    }

    const runs = ctx.runs || (ctx.runs = collectRuns(ctx));
    const active = [];
    const archived = [];
    for (const r of runs) {
        const where = rel(ctx.root, r.stateFile);
        let errors = null;
        if (r.parseError) errors = [`JSON malformado: ${r.parseError}`];
        else {
            const check = validateState(r.state, schemaPath);
            if (!check.valid) errors = check.errors;
        }
        if (!errors) continue;
        const line = `${where}: ${errors.slice(0, 3).join('; ')}${errors.length > 3 ? ` (+${errors.length - 3})` : ''}`;
        (r.archived ? archived : active).push(line);
    }
    if (active.length) out.push(makeResult(ctx, rule, { message: `${active.length} run(s) ativo(s) incompatível(is) com o schema atual — o watcher os marcaria state_corrupted`, details: active }));
    if (archived.length) out.push(makeResult(ctx, rule, { severity: 'warning', message: `${archived.length} run(s) arquivado(s) incompatível(is) com o schema atual`, details: archived }));
    if (!out.length) out.push(makeResult(ctx, rule, { passed: true, message: `${runs.length} run(s) compatível(is) com ${ctx.contract.stateSchema.schema}` }));
    if (!Ajv) out.push(makeResult(ctx, rule, { severity: 'info', message: 'ajv não instalado (npm install em scripts/) — só task_id/node/status foram validados' }));
    return out;
}

// ── Regra: env-documented ────────────────────────────────────────────────────────
const ENV_READ_RES = [
    /\b(?:process\.env|env|source)\.([A-Z][A-Z0-9_]{2,})\b/g,
    /\b(?:process\.env|env)\[\s*['"`]([A-Z][A-Z0-9_]{2,})['"`]\s*\]/g,
    // Helpers do tipo intEnv(env, 'X', ...) / envDays(env, 'X', ...).
    /\b\w*[Ee]nv\w*\(\s*[\w.]+\s*,\s*['"]([A-Z][A-Z0-9_]{2,})['"]/g,
];

function scanFiles(ctx) {
    const scan = ctx.contract.env.scan || {};
    const exts = scan.extensions || ['.js'];
    const excl = scan.excludeSuffixes || [];
    const files = [];
    for (const d of scan.dirs || []) {
        const dir = path.join(ctx.root, d);
        let names = [];
        try { names = fs.readdirSync(dir, { withFileTypes: true }).filter(e => e.isFile()).map(e => e.name); } catch { continue; }
        for (const n of names) if (exts.some(e => n.endsWith(e)) && !excl.some(e => n.endsWith(e))) files.push(path.join(dir, n));
    }
    return files;
}

function envReadsInCode(ctx) {
    const found = new Map(); // VAR -> "arquivo:linha" da primeira leitura
    for (const file of scanFiles(ctx)) {
        const lines = (readText(file) || '').split('\n');
        lines.forEach((line, i) => {
            if (/^\s*(\/\/|\*)/.test(line)) return;
            for (const re of ENV_READ_RES) {
                re.lastIndex = 0;
                let m;
                while ((m = re.exec(line))) if (!found.has(m[1])) found.set(m[1], `${rel(ctx.root, file)}:${i + 1}`);
            }
        });
    }
    return found;
}

function documentedEnv(text) {
    const out = new Set();
    for (const m of text.matchAll(/^[ \t]*#?[ \t]*([A-Z][A-Z0-9_]+)=/gm)) out.add(m[1]);
    return out;
}

function ruleEnvDocumented(ctx) {
    const rule = 'env-documented';
    const e = ctx.contract.env;
    const exampleText = readText(path.join(ctx.root, e.exampleFile));
    if (exampleText === null) return makeResult(ctx, rule, { severity: 'error', message: `${e.exampleFile} não existe` });
    const documented = documentedEnv(exampleText);
    const ignore = e.ignore || {};
    const reads = envReadsInCode(ctx);

    const out = [];
    const missingRequired = (e.required || []).filter(v => !documented.has(v));
    if (missingRequired.length) {
        out.push(makeResult(ctx, rule, { severity: 'error', message: `${missingRequired.length} variável(is) obrigatória(s) sem entrada no ${e.exampleFile}`, details: missingRequired }));
    }
    const undocumented = [...reads].filter(([v]) => !documented.has(v) && !(v in ignore)).sort(([a], [b]) => a.localeCompare(b));
    if (undocumented.length) {
        out.push(makeResult(ctx, rule, {
            message: `${undocumented.length} variável(is) lida(s) no código sem entrada no ${e.exampleFile}`,
            details: undocumented.map(([v, where]) => `${v} (${where})`),
        }));
    }
    // Documentada sem nenhuma menção no código escaneado nem nos .sh/comandos: sobra.
    const filesIn = (d, ext) => { try { return fs.readdirSync(path.join(ctx.root, d)).filter(f => f.endsWith(ext)).map(f => path.join(ctx.root, d, f)); } catch { return []; } };
    const corpus = [...scanFiles(ctx), ...filesIn('scripts', '.sh'), ...filesIn(ctx.contract.templates.dir, '.md')]
        .map(f => readText(f) || '').join('\n');
    const unused = [...documented].filter(v => !reads.has(v) && !new RegExp(`\\b${v}\\b`).test(corpus)).sort();
    if (unused.length) out.push(makeResult(ctx, rule, { severity: 'info', message: `${unused.length} variável(is) do ${e.exampleFile} sem leitura encontrada no código`, details: unused }));
    if (!missingRequired.length && !undocumented.length) {
        out.unshift(makeResult(ctx, rule, { passed: true, message: `${reads.size} variável(is) lida(s) no código, todas documentadas ou ignoradas pelo contrato` }));
    }
    return out;
}

// ── Regra: worktrees-clean ───────────────────────────────────────────────────────
function registeredWorktrees(repo, exec) {
    try {
        return exec('git', ['-C', repo, 'worktree', 'list', '--porcelain'])
            .split('\n').filter(l => l.startsWith('worktree ')).map(l => l.slice(9).trim());
    } catch { return []; }
}

function realish(p) {
    try { return fs.realpathSync(p); } catch {}
    const parent = path.dirname(p);
    return parent === p ? p : path.join(realish(parent), path.basename(p));
}

function siblingRepos(ctx) {
    return (ctx.contract.worktrees.siblingRepos || []).map(n => path.resolve(ctx.root, '..', n));
}

function latestRunByTicket(runs) {
    const byTicket = new Map();
    for (const r of runs) {
        if (/^\d{4}-\d{2}-\d{2}-/.test(r.taskId)) continue; // task-id datado não é ticket
        const t = (r.taskId.match(/^(\d+)-/) || [])[1];
        if (!t || !r.state) continue;
        const cur = byTicket.get(t);
        if (!cur || runTime(r.state) > runTime(cur.state)) byTicket.set(t, r);
    }
    return byTicket;
}

function ruleWorktreesClean(ctx) {
    const rule = 'worktrees-clean';
    const w = ctx.contract.worktrees;
    const wtDir = path.join(ctx.root, w.dir);
    const closed = new Set(w.closedStatuses || []);
    const prOpen = new Set(w.prOpenStatuses || []);
    const runs = ctx.runs || (ctx.runs = collectRuns(ctx));
    const latest = latestRunByTicket(runs);

    const closedFound = [];  // { ticket, dirs, status, taskId }
    const broken = [];       // diretório com .git apontando pra gitdir que não existe
    const notGit = [];       // diretório sem .git
    const prunable = [];     // registrado no git, diretório não existe
    const prOpenFound = [];
    const noRun = [];

    const byTicket = new Map();
    for (const name of listDirs(wtDir)) {
        const dir = path.join(wtDir, name);
        const gitFile = path.join(dir, '.git');
        if (!fs.existsSync(gitFile)) { notGit.push(dir); continue; }
        if (!isDir(gitFile)) {
            const gitdir = ((readText(gitFile) || '').match(/^gitdir:\s*(.+)$/m) || [])[1];
            const resolved = gitdir && path.resolve(dir, gitdir.trim());
            if (!resolved || !fs.existsSync(resolved)) { broken.push(dir); continue; }
        }
        const ticket = ticketOfDir(ctx, name);
        if (!ticket) continue; // worktree nomeado (feature do fluxo), não é ciclo de ticket
        if (!byTicket.has(ticket)) byTicket.set(ticket, []);
        byTicket.get(ticket).push(dir);
    }
    for (const [ticket, dirs] of byTicket) {
        const r = latest.get(ticket);
        if (!r) { noRun.push(...dirs.map(d => `${rel(ctx.root, d)} (#${ticket})`)); continue; }
        const status = r.state.status;
        if (closed.has(status)) closedFound.push({ ticket, dirs, status, taskId: r.taskId });
        else if (prOpen.has(status)) prOpenFound.push(`${dirs.map(d => rel(ctx.root, d)).join(', ')} (${r.taskId}: ${status})`);
    }
    for (const repo of [ctx.root, ...siblingRepos(ctx)]) {
        const underWt = registeredWorktrees(repo, ctx.exec)
            .filter(p => { const rp = path.relative(realish(wtDir), p); return rp && !rp.startsWith('..') && !path.isAbsolute(rp); });
        const stale = underWt.filter(p => !fs.existsSync(p));
        if (stale.length) prunable.push({ repo, paths: stale });
    }

    const out = [];
    if (closedFound.length) {
        out.push(makeResult(ctx, rule, {
            message: `${closedFound.length} ticket(s) com worktree de ciclo encerrado`,
            details: closedFound.map(c => `${c.dirs.map(d => rel(ctx.root, d)).join(', ')} — ${c.taskId}: ${c.status}`),
            fixes: closedFound.map(c => ({ type: 'cleanup-ticket', ticketId: c.ticket, paths: c.dirs })),
        }));
    }
    const orphanDetails = [
        ...broken.map(d => `${rel(ctx.root, d)}: .git aponta pra gitdir que não existe mais`),
        ...prunable.flatMap(p => p.paths.map(x => `${x}: registrado em ${path.basename(p.repo)} mas o diretório não existe`)),
    ];
    if (orphanDetails.length) {
        out.push(makeResult(ctx, rule, {
            message: `${orphanDetails.length} worktree(s) órfão(s)`,
            details: orphanDetails,
            fixes: [
                ...broken.map(d => ({ type: 'remove-broken', path: d })),
                ...prunable.map(p => ({ type: 'prune', repo: p.repo, paths: p.paths })),
            ],
        }));
    }
    if (notGit.length) {
        out.push(makeResult(ctx, rule, {
            message: `${notGit.length} diretório(s) em ${w.dir}/ que não são worktree git — não removidos pelo --fix, confira à mão`,
            details: notGit.map(d => rel(ctx.root, d)),
        }));
    }
    if (prOpenFound.length) out.push(makeResult(ctx, rule, { severity: 'info', message: `${prOpenFound.length} worktree(s) de ticket com PR aberto — saem no merge`, details: prOpenFound }));
    if (noRun.length) out.push(makeResult(ctx, rule, { severity: 'info', message: `${noRun.length} worktree(s) de ticket sem run encontrado`, details: noRun }));
    if (!closedFound.length && !orphanDetails.length && !notGit.length) {
        out.unshift(makeResult(ctx, rule, { passed: true, message: `nenhum worktree de ciclo encerrado ou órfão em ${w.dir}/` }));
    }
    return out;
}

// ── Execução ─────────────────────────────────────────────────────────────────────
const RULES = [
    { id: 'config-files-schema', run: ruleConfigFilesSchema },
    { id: 'nodes-have-templates', run: ruleNodesHaveTemplates },
    { id: 'graph-acyclic', run: ruleGraphAcyclic },
    { id: 'state-schema-compat', run: ruleStateSchemaCompat },
    { id: 'env-documented', run: ruleEnvDocumented },
    { id: 'worktrees-clean', run: ruleWorktreesClean },
];

function summarize(results) {
    const failed = results.filter(r => !r.passed);
    const count = sev => failed.filter(r => r.severity === sev).length;
    const ruleIds = [...new Set(results.map(r => r.rule))];
    const errorRules = new Set(failed.filter(r => r.severity === 'error').map(r => r.rule));
    const cleanRules = ruleIds.filter(id => !failed.some(r => r.rule === id && r.severity !== 'info'));
    return {
        rules: ruleIds.length,
        passedRules: ruleIds.length - errorRules.size,
        cleanRules: cleanRules.length,
        errors: count('error'),
        warnings: count('warning'),
        info: count('info'),
    };
}

function headline(summary) {
    if (summary.errors) return `Configuração inválida - ${summary.errors} erro(s) em ${summary.rules - summary.passedRules} regra(s)`;
    const extra = summary.warnings ? ` (${summary.warnings} aviso(s))` : '';
    return `Configuração válida - ${summary.passedRules} regras passaram${extra}`;
}

// Executa todas as regras e devolve o relatório. Nunca lança por regra quebrada (vira
// resultado de erro); lança só se o contrato não puder ser lido.
function validateAll(configPath = DEFAULT_CONFIG_PATH, opts = {}) {
    const ctx = createContext(path.resolve(configPath), opts);
    const only = opts.rules ? new Set(opts.rules) : null;
    const results = [];
    for (const r of RULES) {
        if (only && !only.has(r.id)) continue;
        try {
            const res = r.run(ctx);
            results.push(...(Array.isArray(res) ? res : [res]));
        } catch (e) {
            results.push({ rule: r.id, severity: 'error', passed: false, message: `regra falhou ao executar: ${e.message}` });
        }
    }
    const summary = summarize(results);
    return {
        contractVersion: ctx.contract.contractVersion,
        generatedAt: new Date().toISOString(),
        root: ctx.root,
        valid: summary.errors === 0,
        message: headline(summary),
        summary,
        results,
    };
}

// ── --fix: só worktrees ──────────────────────────────────────────────────────────
// Nunca toca arquivo de configuração. Antes de remover o worktree de um ticket, copia
// os runs do ticket que moram nele pra memory/runs/_archive/ (mesma coisa que o
// watcher faz em onTaskFullyMerged / cleanupWorktreesAfterPrOpen) — sem isso o
// histórico do ciclo sumiria junto. A cópia de um diretório só é desfeita se
// esse diretório continuar no disco — um irmão sujo que fica não apaga o run
// que só existia no worktree já removido.
function underWorktrees(worktreesDir, target) {
    const relp = path.relative(realish(worktreesDir), realish(target));
    return !!relp && !relp.startsWith('..') && !path.isAbsolute(relp);
}

function ticketFixDirs(worktreesDir, fix) {
    const listed = Array.isArray(fix.paths) ? fix.paths : [];
    const source = listed.length ? listed : [path.join(worktreesDir, String(fix.ticketId))];
    return source.filter(p => underWorktrees(worktreesDir, p));
}

// Copia os runs do ticket a partir dos diretórios reais do fix (fixes[].paths).
// O id capturado pode ser mais curto que o nome do worktree.
function rescueTicketRuns(root, ticketId, dirs) {
    const archive = path.join(root, 'memory', 'runs', '_archive');
    const copied = [];
    const seen = new Set();
    for (const dir of dirs) {
        const src = path.join(dir, 'memory', 'runs');
        for (const base of [src, path.join(src, '_archive')]) {
            for (const r of runsIn(base, { archived: false, onlyTicket: String(ticketId) })) {
                if (seen.has(r.taskId)) continue;
                seen.add(r.taskId);
                const inMain = fs.existsSync(path.join(root, 'memory', 'runs', r.taskId)) || fs.existsSync(path.join(archive, r.taskId));
                if (inMain) continue;
                const dst = path.join(archive, r.taskId);
                fs.mkdirSync(archive, { recursive: true });
                fs.cpSync(r.dir, dst, { recursive: true });
                copied.push({ dst, source: dir });
            }
        }
    }
    return copied;
}

// Desfaz só a cópia cujo diretório de origem ainda existe. Devolve os destinos
// que ficam no arquivo.
function dropRescuesStillOnDisk(copied) {
    const kept = [];
    for (const c of copied) {
        if (fs.existsSync(c.source)) fs.rmSync(c.dst, { recursive: true, force: true });
        else kept.push(c.dst);
    }
    return kept;
}

function worktreeIsDirty(dir, exec) {
    try {
        return !!exec('git', ['-C', dir, 'status', '--porcelain', '--untracked-files=no']).trim();
    } catch { return true; }
}

function removeWorktreePath(dir, exec) {
    const common = exec('git', ['-C', dir, 'rev-parse', '--path-format=absolute', '--git-common-dir']).trim();
    const repo = path.dirname(common);
    exec('git', ['-C', repo, 'worktree', 'remove', '--force', dir]);
    return repo;
}

async function applyFixes(report, opts = {}) {
    const root = report.root;
    const exec = opts.exec || defaultExec;
    const log = opts.log || { log() {}, warn() {}, error() {} };
    const contract = opts.contract || loadContract(opts.configPath || path.join(root, '.claude', 'config-contract.json'));
    const worktreesDir = path.join(root, contract.worktrees.dir);
    const siblings = (contract.worktrees.siblingRepos || []).map(n => path.resolve(root, '..', n));
    const out = { removed: [], kept: [], errors: [], rescuedRuns: [] };
    const fixes = report.results.flatMap(r => r.fixes || []);

    for (const f of fixes) {
        if (f.type === 'cleanup-ticket') {
            const realDirs = ticketFixDirs(worktreesDir, f);
            if (!realDirs.length) {
                out.errors.push({ path: path.join(worktreesDir, String(f.ticketId)), error: 'fora de .claude/worktrees — recusado' });
                continue;
            }
            let copied = [];
            try { copied = rescueTicketRuns(root, f.ticketId, realDirs); } catch (e) {
                out.errors.push({ path: realDirs[0], error: `não consegui preservar os runs do worktree: ${e.message}` });
                continue;
            }
            const conventional = path.resolve(path.join(worktreesDir, String(f.ticketId)));
            const extras = realDirs.filter(d => path.resolve(d) !== conventional && fs.existsSync(d));
            // cleanupWorktrees deriva .claude/worktrees/<ticket> e só para o preview
            // quando esse caminho existe. O diretório real pode ter outro nome.
            if (extras.length) {
                try {
                    const stop = opts.stopPreview || stopPreviewViaDashboard;
                    await stop(String(f.ticketId));
                } catch (e) {
                    dropRescuesStillOnDisk(copied);
                    for (const d of extras) out.errors.push({ path: d, error: `preview não parou: ${e.message}` });
                    continue;
                }
            }
            const r = await (opts.cleanupWorktrees || cleanupWorktrees)(f.ticketId, {
                worktreesDir, siblingRepos: siblings, exec, log, skipDirty: true,
                ...(opts.stopPreview ? { stopPreview: opts.stopPreview } : {}),
            });
            const handled = new Set([
                ...(r.kept || []).map(k => path.resolve(k.path)),
                ...(r.errors || []).filter(e => e.path).map(e => path.resolve(e.path)),
            ]);
            for (const dir of realDirs) {
                const abs = path.resolve(dir);
                if (!fs.existsSync(dir) || handled.has(abs) || abs === conventional) continue;
                if (worktreeIsDirty(dir, exec)) {
                    out.kept.push({ path: dir, reason: 'mudança rastreada não commitada' });
                    log.warn(`[worktree-cleanup] #${f.ticketId}: ${dir} tem mudança não commitada — mantido.`);
                    continue;
                }
                try {
                    const repo = removeWorktreePath(dir, exec);
                    out.removed.push(dir);
                    log.log(`[worktree-cleanup] #${f.ticketId}: removido ${dir} (repo ${path.basename(repo)}).`);
                } catch (e) {
                    const error = String(e.stderr || e.message || e).trim().split('\n')[0];
                    out.errors.push({ path: dir, error });
                    log.error(`[worktree-cleanup] #${f.ticketId}: falha removendo ${dir}: ${error}`);
                }
            }
            out.rescuedRuns.push(...dropRescuesStillOnDisk(copied));
            out.removed.push(...r.removed);
            out.kept.push(...(r.kept || []));
            out.errors.push(...r.errors);
        } else if (f.type === 'remove-broken') {
            const rp = path.relative(realish(worktreesDir), realish(f.path));
            if (!rp || rp.startsWith('..') || path.isAbsolute(rp)) { out.errors.push({ path: f.path, error: 'fora de .claude/worktrees — recusado' }); continue; }
            try {
                fs.rmSync(f.path, { recursive: true, force: true });
                out.removed.push(f.path);
                for (const repo of [root, ...siblings]) { try { exec('git', ['-C', repo, 'worktree', 'prune']); } catch { /* repo irmão pode não existir */ } }
            } catch (e) { out.errors.push({ path: f.path, error: e.message }); }
        } else if (f.type === 'prune') {
            try { exec('git', ['-C', f.repo, 'worktree', 'prune']); out.removed.push(...f.paths); } catch (e) {
                const error = String(e.stderr || e.message || e).trim().split('\n')[0];
                for (const p of f.paths) out.errors.push({ path: p, error });
            }
        }
    }
    return out;
}

module.exports = {
    validateAll, applyFixes, loadContract, parseGraphYaml, parseFrontmatter, findForwardCycle,
    documentedEnv, RULES, SEVERITIES, DEFAULT_CONFIG_PATH,
};
