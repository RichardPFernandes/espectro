// Validação do Agent Handoff Contract (docs/handoff-contract.md), versões 1.0, 1.1 e 1.2.
//
// O receptor (normalmente o Coordenador) roda isto antes de aceitar um handoff, em vez
// de conferir a estrutura a olho. Aceita um .yaml/.yml puro ou um .md com um bloco
// ```yaml que contenha `handoff_version`. Usa o parseYaml de openapi-validator.js
// (sem dependência nova).
//
// O validador confere forma e coerência, não verdade: não reexecuta testes nem prova
// que uma evidência sustenta o resultado. `--check-paths` confere só que caminhos
// locais citados em artifacts/evidence existem.
//
// Saída: linhas `[ERROR] código: mensagem` / `[WARN] código: mensagem`.
// Exit 0 = válido (pode ter WARN); 1 = ERROR; 2 = arquivo ilegível ou sem YAML.
//
// `--pre-done` é a checagem do maestro-guard (GOV-4). Ela não altera a aceitação
// sem essa flag. Exit 0 nesse modo significa que as citações do planejamento
// Prisma estão presentes; Done não é registrado. Exit 3 = tipo sem critério
// automático, confirmação humana. O pior código entre os arquivos vale.
const fs = require('fs');
const path = require('path');
const { parseYaml } = require('./lib/openapi-validator.js');
const { checkPreDone } = require('./lib/maestro-guard-pre-done.js');

const STATUSES = ['COMPLETED', 'BLOCKED', 'NEEDS_HUMAN', 'FAILED', 'PARTIAL'];
const ARTIFACT_ACTIONS = ['CREATED', 'MODIFIED', 'DELETED'];
const RESULTS = ['PASSED', 'FAILED'];
const RUNTIMES = ['claude', 'codex', 'human', 'other'];
const RISK_LEVELS = ['LOW', 'MEDIUM', 'HIGH', 'MAX'];
const VERSIONS = ['1.0', '1.1', '1.2'];
// Níveis de processo do acordo de desenvolvimento (AGENTS.md, «Níveis de processo»).
const PROCESS_LEVELS = ['leve', 'medio', 'alto'];
const SECRET = /(ATATT[A-Za-z0-9_\-=]{20,}|ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9\-_]{20,}|xox[abp]-[A-Za-z0-9-]{10,}|apikey_[A-Za-z0-9_]{20,}|-----BEGIN [A-Z ]*PRIVATE KEY-----)/;

function extractYaml(text, file) {
    if (!/\.(md|markdown)$/i.test(file || '')) return text;
    const blocks = [...text.matchAll(/```ya?ml\s*\n([\s\S]*?)```/g)].map((m) => m[1]);
    return blocks.find((b) => /^\s*handoff_version\s*:/m.test(b)) ?? null;
}

const isStr = (v) => typeof v === 'string' && v.trim() !== '';
const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
const listOrEmpty = (v) => (v === undefined || v === null ? [] : v);

function validate(doc, opts = {}) {
    const out = [];
    const err = (code, msg) => out.push({ level: 'ERROR', code, msg });
    const warn = (code, msg) => out.push({ level: 'WARN', code, msg });
    const baseDir = opts.baseDir || process.cwd();
    const exists = (p) => fs.existsSync(path.isAbsolute(p) ? p : path.join(baseDir, p));

    if (!isObj(doc)) { err('NOT_A_MAP', 'o handoff precisa ser um mapa YAML'); return out; }
    const version = String(doc.handoff_version ?? '');
    if (!VERSIONS.includes(version)) err('VERSION', `handoff_version "${version}" não suportada (use ${VERSIONS.join(' ou ')})`);
    // 1.2 é aditiva sobre a 1.1: herda routing/risk e acrescenta nivel_processo.
    const v12 = version === '1.2';
    const v11 = version === '1.1' || v12;

    const task = doc.task;
    if (!isObj(task)) err('TASK_MISSING', 'bloco task ausente');
    else {
        if (!isStr(task.id)) err('TASK_ID', 'task.id vazio');
        else if (/^PRI-X+$/i.test(task.id)) err('TASK_ID_PLACEHOLDER', `task.id ainda é o placeholder "${task.id}"`);
        if (!isStr(task.objective)) err('TASK_OBJECTIVE', 'task.objective vazio');
        if (!isStr(task.specification_ref)) warn('TASK_SPEC_REF', 'task.specification_ref vazio');
        if (v11) {
            const ac = listOrEmpty(task.acceptance_criteria);
            if (!Array.isArray(ac)) err('TASK_AC_TYPE', 'task.acceptance_criteria precisa ser lista');
            else if (ac.length === 0) warn('TASK_AC_EMPTY', 'task.acceptance_criteria vazio — referencie os ACs da spec/issue');
        }
    }

    const ex = doc.execution;
    let status = '';
    if (!isObj(ex)) err('EXECUTION_MISSING', 'bloco execution ausente');
    else {
        if (!isStr(ex.agent)) err('EXECUTION_AGENT', 'execution.agent vazio');
        status = String(ex.status ?? '');
        if (!STATUSES.includes(status)) err('STATUS', `execution.status "${status}" inválido (${STATUSES.join(', ')})`);
        if (!isStr(ex.summary)) err('SUMMARY', 'execution.summary vazio');
    }

    const artifacts = listOrEmpty(doc.artifacts);
    if (!Array.isArray(artifacts)) err('ARTIFACTS_TYPE', 'artifacts precisa ser lista');
    else artifacts.forEach((a, i) => {
        if (!isObj(a) || !isStr(a.path)) { err('ARTIFACT_PATH', `artifacts[${i}].path vazio`); return; }
        if (!ARTIFACT_ACTIONS.includes(String(a.action))) err('ARTIFACT_ACTION', `artifacts[${i}].action "${a.action}" inválida (${ARTIFACT_ACTIONS.join(', ')})`);
        if (opts.checkPaths && a.action !== 'DELETED' && !exists(a.path)) err('ARTIFACT_NOT_FOUND', `artifacts[${i}].path não existe: ${a.path}`);
    });

    const dec = doc.decisions;
    if (dec !== undefined && dec !== null && !isObj(dec)) err('DECISIONS_TYPE', 'decisions precisa ter approved/proposed');

    const val = isObj(doc.validation) ? doc.validation : {};
    const executed = listOrEmpty(val.executed);
    const notExecuted = listOrEmpty(val.not_executed);
    if (!Array.isArray(executed)) err('VALIDATION_TYPE', 'validation.executed precisa ser lista');
    else executed.forEach((e, i) => {
        if (!isObj(e) || !isStr(e.command)) { err('VALIDATION_COMMAND', `validation.executed[${i}].command vazio`); return; }
        if (!RESULTS.includes(String(e.result))) err('VALIDATION_RESULT', `validation.executed[${i}].result "${e.result}" inválido (${RESULTS.join(', ')})`);
        if (e.expected !== undefined && e.expected !== null && !RESULTS.includes(String(e.expected))) err('VALIDATION_EXPECTED', `validation.executed[${i}].expected "${e.expected}" inválido (${RESULTS.join(', ')})`);
        if (!isStr(e.evidence)) err(e.result === 'PASSED' ? 'PASSED_WITHOUT_EVIDENCE' : 'RESULT_WITHOUT_EVIDENCE', `validation.executed[${i}] ${e.result} sem evidence — regra 7 do contrato`);
        if (opts.checkPaths && isStr(e.evidence) && /^[^\s]+\.(log|txt|md|json|xml|out)$/.test(e.evidence.trim()) && !exists(e.evidence.trim())) {
            err('EVIDENCE_NOT_FOUND', `validation.executed[${i}].evidence não existe: ${e.evidence}`);
        }
    });
    // Falha inesperada = result diferente de expected (padrão PASSED). Teste de injeção de
    // falha declara expected: FAILED e não conta como falha.
    const unexpected = Array.isArray(executed) ? executed.filter((e) => isObj(e) && RESULTS.includes(String(e.result)) && e.result !== (e.expected || 'PASSED')) : [];
    const issuesListed = Array.isArray(doc.open_issues) && doc.open_issues.length > 0;
    if (status === 'COMPLETED' && unexpected.length) {
        if (issuesListed) warn('COMPLETED_WITH_KNOWN_FAILURE', `COMPLETED com ${unexpected.length} validação(ões) fora do esperado; confira se open_issues explica cada uma`);
        else err('COMPLETED_WITH_FAILURE', 'status COMPLETED com validação fora do esperado e sem open_issues — use PARTIAL/FAILED ou declare expected');
    }
    if (status === 'COMPLETED' && Array.isArray(executed) && executed.length === 0 && Array.isArray(notExecuted) && notExecuted.length === 0) {
        warn('NO_VALIDATION', 'COMPLETED sem nenhuma validação executada nem justificada em not_executed');
    }

    const openIssues = listOrEmpty(doc.open_issues);
    if (['NEEDS_HUMAN', 'BLOCKED'].includes(status) && (!Array.isArray(openIssues) || openIssues.length === 0)) {
        err('BLOCKER_UNDESCRIBED', `status ${status} exige open_issues descrevendo o impedimento ou a decisão`);
    }

    if (!isObj(doc.next)) err('NEXT_MISSING', 'bloco next ausente');
    else if (status === 'COMPLETED' && !isStr(doc.next.action)) warn('NEXT_ACTION', 'next.action vazio');

    if (v11) {
        const r = doc.routing;
        if (!isObj(r)) err('ROUTING_MISSING', 'v1.1 exige o bloco routing');
        else {
            if (!isStr(r.from)) err('ROUTING_FROM', 'routing.from vazio');
            if (!isStr(r.to)) err('ROUTING_TO', 'routing.to vazio');
            if (!RUNTIMES.includes(String(r.runtime))) err('ROUTING_RUNTIME', `routing.runtime "${r.runtime}" inválido (${RUNTIMES.join(', ')})`);
        }
        const risk = doc.risk;
        if (!isObj(risk)) err('RISK_MISSING', 'v1.1 exige o bloco risk');
        else {
            if (!RISK_LEVELS.includes(String(risk.level))) err('RISK_LEVEL', `risk.level "${risk.level}" inválido (${RISK_LEVELS.join(', ')})`);
            if (['HIGH', 'MAX'].includes(String(risk.level)) && !(Array.isArray(risk.signals) && risk.signals.length)) {
                err('RISK_SIGNALS', `risk.level ${risk.level} exige risk.signals com o motivo`);
            }
        }
        for (const k of ['facts', 'assumptions']) {
            if (doc[k] !== undefined && doc[k] !== null && !Array.isArray(doc[k])) err(`${k.toUpperCase()}_TYPE`, `${k} precisa ser lista`);
        }
        const usage = doc.usage;
        if (usage !== undefined && usage !== null) {
            if (!isObj(usage)) err('USAGE_TYPE', 'usage precisa ser mapa');
            else for (const [k, v] of Object.entries(usage)) {
                if (v !== null && v !== 'UNKNOWN' && typeof v !== 'number' && !(typeof v === 'string' && /^\d+(\.\d+)?\s*(ms|s|min|h)?$/.test(v))) {
                    err('USAGE_VALUE', `usage.${k} = "${v}": use número observado, duração (ex: 90s) ou UNKNOWN`);
                }
            }
        }
    }
    if (v12) validateProcessLevel(doc, err, warn);
    return out;
}

// v1.2: nivel_processo obrigatório; mudança de nível exige motivo; descida só com o Richard.
function validateProcessLevel(doc, err, warn) {
    const level = doc.nivel_processo;
    if (typeof level !== 'string' || !PROCESS_LEVELS.includes(level)) {
        const norm = typeof level === 'string' ? level.trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '') : '';
        const hint = PROCESS_LEVELS.includes(norm) ? ` — escreva "${norm}", minúsculo, sem acento nem espaço` : '';
        err('NIVEL_PROCESSO', `nivel_processo "${level ?? ''}" inválido (${PROCESS_LEVELS.join(', ')})${hint}`);
        return;
    }
    const initial = doc.nivel_processo_inicial;
    if (initial === undefined || initial === null || initial === '') return;
    if (typeof initial !== 'string' || !PROCESS_LEVELS.includes(initial)) {
        err('NIVEL_PROCESSO_INICIAL', `nivel_processo_inicial "${initial}" inválido (${PROCESS_LEVELS.join(', ')})`);
        return;
    }
    if (initial === level) return;
    if (!isStr(doc.nivel_processo_motivo)) {
        err('NIVEL_PROCESSO_MOTIVO', `nivel_processo mudou de ${initial} para ${level}; registre o motivo em nivel_processo_motivo`);
    }
    if (PROCESS_LEVELS.indexOf(level) < PROCESS_LEVELS.indexOf(initial)) {
        const approved = isObj(doc.decisions) && Array.isArray(doc.decisions.approved) ? doc.decisions.approved : [];
        if (approved.length === 0) {
            err('NIVEL_PROCESSO_DESCEU_SEM_DECISAO', `nivel_processo desceu de ${initial} para ${level} sem decisão em decisions.approved; descer só com o Richard`);
        } else {
            warn('NIVEL_PROCESSO_DESCEU', `nivel_processo desceu de ${initial} para ${level}; descer só com o Richard — confira que decisions.approved cita a decisão dele (o validador não lê o conteúdo)`);
        }
    }
}

function validateFile(file, opts = {}) {
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch (e) { return { code: 2, results: [{ level: 'ERROR', code: 'UNREADABLE', msg: e.message }], doc: null }; }
    const results = [];
    if (SECRET.test(text)) results.push({ level: 'ERROR', code: 'SECRET', msg: 'o handoff contém algo com formato de credencial — remova antes de entregar' });
    const yaml = extractYaml(text, file);
    if (yaml === null) return { code: 2, results: [...results, { level: 'ERROR', code: 'NO_YAML', msg: 'nenhum bloco ```yaml com handoff_version (handoff em prosa não atende o contrato)' }], doc: null };
    let doc;
    try { doc = parseYaml(yaml); } catch (e) { return { code: 2, results: [...results, { level: 'ERROR', code: 'YAML_PARSE', msg: e.message }], doc: null }; }
    results.push(...validate(doc, { ...opts, baseDir: opts.baseDir || path.dirname(path.resolve(file)) }));
    return { code: results.some((r) => r.level === 'ERROR') ? 1 : 0, results, doc };
}

function rankExit(code) {
    if (code === 2) return 40;
    if (code === 1) return 30;
    if (code === 3) return 20;
    return 0;
}

function combineExit(structuralCode, preDoneExit) {
    return rankExit(structuralCode) >= rankExit(preDoneExit) ? structuralCode : preDoneExit;
}

function parseArgs(argv) {
    const checkPaths = argv.includes('--check-paths');
    const preDone = argv.includes('--pre-done');
    const baseIdx = argv.indexOf('--base');
    const typeIdx = argv.indexOf('--task-type');
    const missingValue = (idx) => idx >= 0 && (argv[idx + 1] === undefined || argv[idx + 1].startsWith('--'));
    const skip = new Set();
    if (baseIdx >= 0 && !missingValue(baseIdx)) skip.add(baseIdx + 1);
    if (typeIdx >= 0 && !missingValue(typeIdx)) skip.add(typeIdx + 1);
    const files = argv.filter((a, i) => !a.startsWith('--') && !skip.has(i));
    return {
        checkPaths,
        preDone,
        baseDir: baseIdx >= 0 && !missingValue(baseIdx) ? argv[baseIdx + 1] : undefined,
        taskType: typeIdx >= 0 && !missingValue(typeIdx) ? argv[typeIdx + 1] : undefined,
        missingFlagValue: missingValue(baseIdx) || missingValue(typeIdx),
        files,
    };
}

function runFile(file, opts = {}) {
    const structural = validateFile(file, opts);
    if (!opts.preDone) return { code: structural.code, results: structural.results, preDone: null };
    if (!structural.doc) return { code: structural.code, results: structural.results, preDone: null };
    const preDone = checkPreDone(structural.doc, {
        baseDir: opts.baseDir || path.dirname(path.resolve(file)),
        handoffPath: path.resolve(file),
        taskType: opts.taskType,
        homeDir: opts.homeDir,
    });
    return {
        code: combineExit(structural.code, preDone.exitCode),
        results: structural.results,
        preDone,
    };
}

module.exports = { validate, validateFile, extractYaml, parseArgs, runFile, combineExit, checkPreDone, PROCESS_LEVELS };

if (require.main === module) {
    const parsed = parseArgs(process.argv.slice(2));
    if (parsed.missingFlagValue || !parsed.files.length) {
        console.error('Uso: node scripts/validate-handoff.js <handoff.yaml|handoff.md> [...] [--check-paths] [--base <dir>] [--pre-done] [--task-type <tipo da tabela>]');
        process.exit(2);
    }
    let worst = 0;
    for (const f of parsed.files) {
        const { code, results, preDone } = runFile(f, parsed);
        const structuralError = results.some((r) => r.level === 'ERROR');
        let label = structuralError ? 'INVÁLIDO' : 'VÁLIDO';
        if (parsed.preDone && preDone && !structuralError) {
            if (preDone.outcome === 'evidence_present') label = 'VÁLIDO; pré-Done com citações presentes';
            else if (preDone.outcome === 'human') label = 'VÁLIDO; pré-Done aguarda critério humano';
            else label = 'VÁLIDO; pré-Done recusado';
        }
        console.log(`${f}: ${label}`);
        for (const r of results) console.log(`  [${r.level}] ${r.code}: ${r.msg}`);
        if (preDone) {
            const outcome = preDone.outcome === 'evidence_present'
                ? 'citações presentes'
                : (preDone.outcome === 'human' ? 'aguarda critério humano' : 'recusado');
            console.log(`  pré-Done: ${outcome}`);
            console.log(`  nível de processo: ${preDone.nivelProcesso.label}`);
            for (const r of preDone.results) console.log(`  [${r.level}] ${r.code}: ${r.msg}`);
            console.log(`  regras fixas (todo nível): ${preDone.fixedRules.join('; ')}`);
            console.log('  confirmação do Richard: obrigatória');
            console.log('  Done no Linear: não registrado');
            if (preDone.outcome === 'evidence_present') {
                for (const limit of preDone.limits) console.log(`  [LIMITE] ${limit}`);
            }
        }
        worst = rankExit(code) > rankExit(worst) ? code : worst;
    }
    process.exit(worst);
}
