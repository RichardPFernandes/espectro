// Validação de memory/runs/<task-id>/state.json contra .graph/schemas/state.schema.json.
//
// Existe porque o watcher lia state.json só com JSON.parse, sem checar estrutura: um
// agente que grava JSON truncado, sem campo obrigatório ou com tipo errado (ex:
// status: 123) fazia o watcher ou lançar exceção no meio do tick, ou seguir com
// `undefined` e decidir errado em silêncio (o pior caso: não achar task ativa e
// redespachar fetch_ticket por cima de uma task em andamento).
//
// Usa ajv (devDependency em scripts/package.json — `npm install` dentro de scripts/).
// LIMITAÇÃO: se ajv não estiver instalado, cai numa validação mínima manual só dos
// campos críticos pro despacho (objeto na raiz, task_id/node/status como string não
// vazia) — pega o caso "status: 123" e JSON truncado, mas não valida o resto do
// schema (enums, agent_log, retries, etc.). Um aviso é logado uma vez por processo.
//
// Nome do campo: o task original fala em `current_node`, mas o state.json deste
// projeto sempre usou `node` (ver schema e .claude/commands/*.md) — é ele que é
// checado.
const fs = require('fs');
const path = require('path');

const DEFAULT_SCHEMA_PATH = path.join(__dirname, '..', '.graph', 'schemas', 'state.schema.json');

let Ajv = null;
let addFormats = null;
try {
    Ajv = require('ajv');
    try { addFormats = require('ajv-formats'); } catch { /* formats ficam sem validar */ }
} catch {
    Ajv = null;
}
let warnedNoAjv = false;
const warnedBadSchema = new Set();

const compiledBySchemaPath = new Map();

function compile(schemaPath) {
    const resolved = path.resolve(schemaPath);
    if (compiledBySchemaPath.has(resolved)) return compiledBySchemaPath.get(resolved);
    const schema = JSON.parse(fs.readFileSync(resolved, 'utf8'));
    // strict:false — o schema usa `description` em todo canto e `format` sem que
    // ajv-formats seja garantido; strict mode recusaria compilar em vez de validar.
    const ajv = new Ajv({ allErrors: true, strict: false });
    if (addFormats) addFormats(ajv);
    const validate = ajv.compile(schema);
    compiledBySchemaPath.set(resolved, validate);
    return validate;
}

function formatAjvError(e) {
    const where = e.instancePath || '(raiz)';
    if (e.keyword === 'enum') return `${where} ${e.message}: ${e.params.allowedValues.join(', ')}`;
    if (e.keyword === 'required') return `${where} sem campo obrigatório "${e.params.missingProperty}"`;
    return `${where} ${e.message}`;
}

function validateManually(stateObj) {
    if (!stateObj || typeof stateObj !== 'object' || Array.isArray(stateObj)) {
        return { valid: false, errors: ['(raiz) deve ser um objeto'] };
    }
    const errors = [];
    for (const field of ['task_id', 'node', 'status']) {
        if (!(field in stateObj)) errors.push(`(raiz) sem campo obrigatório "${field}"`);
        else if (typeof stateObj[field] !== 'string' || !stateObj[field]) errors.push(`/${field} deve ser string não vazia`);
    }
    return errors.length ? { valid: false, errors } : { valid: true };
}

// Retorna { valid: true } ou { valid: false, errors: [string, ...] }.
function validateState(stateObj, schemaPath = DEFAULT_SCHEMA_PATH) {
    if (!Ajv) {
        if (!warnedNoAjv) {
            console.warn('[state-validate] ajv não instalado (rode `npm install` em scripts/) — validando só task_id/node/status.');
            warnedNoAjv = true;
        }
        return validateManually(stateObj);
    }
    let validate;
    try {
        validate = compile(schemaPath);
    } catch (e) {
        // Schema ilegível não pode virar "toda task corrompida" nem derrubar o watcher.
        // Loga uma vez por schema (a cada chamada tentaria recompilar e relogar).
        if (!warnedBadSchema.has(schemaPath)) {
            console.error(`[state-validate] schema ${schemaPath} ilegível (${e.message}) — validando só task_id/node/status.`);
            warnedBadSchema.add(schemaPath);
        }
        return validateManually(stateObj);
    }
    if (validate(stateObj)) return { valid: true };
    return { valid: false, errors: validate.errors.map(formatAjvError) };
}

// Onde mora o state.json de uma task: dentro do WORKTREE do ticket
// (.claude/worktrees/<ticket>/memory/runs/<task-id>/ — ver readmine-watcher.js >
// taskRunsDir), com fallback pro checkout principal (tasks sem ticket, ex:
// 2026-09-01-*). `opts.dir` fixa o diretório da task quando quem chama já sabe
// (o watcher sempre sabe — inclusive pra tasks arquivadas em _archive/).
function resolveStatePath(taskId, opts = {}) {
    if (opts.dir) return path.join(opts.dir, 'state.json');
    const repo = opts.repoPath || process.env.REPO_PATH || process.cwd();
    const candidates = [];
    const ticket = /^(\d+)-/.exec(taskId);
    if (ticket) candidates.push(path.join(repo, '.claude', 'worktrees', ticket[1], 'memory', 'runs', taskId, 'state.json'));
    candidates.push(path.join(repo, 'memory', 'runs', taskId, 'state.json'));
    return candidates.find(p => fs.existsSync(p)) || candidates[0];
}

// Lê e valida o state.json de uma task. Formato de retorno:
//   válido:          { valid: true,  state, path }
//   não existe:      { valid: false, state: null, errors: ['not_found'], reason: 'missing', path }
//   JSON malformado: { valid: false, state: null, errors: ['not_found', 'JSON malformado: ...'], reason: 'parse_error', path }
//   fora do schema:  { valid: false, state: null, errors: [...], reason: 'schema', raw, path }
// JSON malformado é tratado como not_found (não há objeto utilizável), mas `reason`
// distingue os dois: quem chama precisa saber que "não existe" é normal (task nunca
// criada) e "malformado" é corrupção. `raw` (objeto parseado, fora do schema) nunca
// deve ser usado pra decidir despacho — existe só pra quem precisa preservar o
// conteúdo ao marcar a task como state_corrupted, ou ler histórico tolerante.
function readAndValidateState(taskId, opts = {}) {
    const statePath = resolveStatePath(taskId, opts);
    if (!fs.existsSync(statePath)) {
        return { valid: false, state: null, errors: ['not_found'], reason: 'missing', path: statePath };
    }

    let raw;
    try {
        raw = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    } catch (e) {
        const result = { valid: false, state: null, errors: ['not_found', `JSON malformado: ${e.message}`], reason: 'parse_error', path: statePath };
        logStateError(taskId, result, opts);
        return result;
    }

    const check = validateState(raw, opts.schemaPath);
    if (check.valid) return { valid: true, state: raw, path: statePath };

    const result = { valid: false, state: null, errors: check.errors, reason: 'schema', raw, path: statePath };
    logStateError(taskId, result, opts);
    return result;
}

function logStateError(taskId, result, opts) {
    if (opts.silent) return;
    console.error('[state-error] ' + JSON.stringify({
        task_id: taskId, path: result.path, reason: result.reason, errors: result.errors, at: new Date().toISOString(),
    }));
}

module.exports = { validateState, readAndValidateState, resolveStatePath, DEFAULT_SCHEMA_PATH };

// CLI: node scripts/validate-state.js <state.json> [...] — sai com 1 se algum for inválido.
if (require.main === module) {
    let bad = 0;
    for (const p of process.argv.slice(2)) {
        const r = readAndValidateState(path.basename(path.dirname(p)), { dir: path.dirname(p), silent: true });
        if (!r.valid) { bad++; console.log(`INVÁLIDO ${p}\n  - ${r.errors.join('\n  - ')}`); }
    }
    process.exit(bad ? 1 : 0);
}
