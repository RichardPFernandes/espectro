// Checagem pré-Done do maestro-guard (PRI-138 / GOV-4).
//
// Confere, no handoff, as evidências mínimas da linha de planejamento Prisma
// definidas em docs/handoff-contract.md. Não chama o Linear, não muda status
// e não registra Done. A confirmação do Richard continua obrigatória.
//
// Invocação: node scripts/validate-handoff.js <handoff> --pre-done
// A aceitação do handoff (sem --pre-done) não lê este módulo.
const fs = require('fs');
const os = require('os');
const path = require('path');

const TASK_TYPES = {
    PLANNING: 'Planejamento/documental — planejamento Prisma',
    DOCUMENTAL: 'Planejamento/documental — demais entregas documentais',
    IMPLEMENTATION: 'Implementação (feature/refactor)',
    BUG: 'Correção de bug',
    DISCOVERY: 'Investigação/discovery (só leitura)',
    REVIEW: 'Revisão/QA',
};

const UNDEFINED_TYPES = new Set([
    TASK_TYPES.DOCUMENTAL,
    TASK_TYPES.IMPLEMENTATION,
    TASK_TYPES.BUG,
    TASK_TYPES.DISCOVERY,
    TASK_TYPES.REVIEW,
]);

const LIMITS = [
    'A citação do Planning Ledger não prova que o ledger foi atualizado.',
    'Uma URL https://linear.app/ não é consultada; a existência do documento no Linear fica na conferência humana.',
    'Gates aplicáveis à baseline da tarefa ficam fora desta checagem.',
    'Esta checagem não registra Done no Linear. A confirmação do Richard continua obrigatória.',
    'execution.status não autoriza Done. A checagem lê as citações de closure.',
];

// Acordo de desenvolvimento v2 (AGENTS.md, «Níveis de processo»). As regras fixas
// valem em todo nível; a checagem não consulta o Linear para conferi-las.
const FIXED_RULES = [
    'evidência na seção Evidência do PR',
    'aceite dos ACs pelo Richard',
    'pai não fecha com filha aberta',
];

const LEVEL_TEXT = {
    leve: 'nível leve: sem SPEC; uma revisão',
    medio: 'nível médio: SPEC de até 1 página só se precisar; uma revisão G3',
    alto: 'nível alto: SPEC de 1 a 2 páginas, AUTORIZO próprio, uma rodada G3 com dois revisores e readback, conferido manualmente',
};

// O campo só existe a partir da 1.2 (mesma fronteira do validador). Sem nível
// válido, vale o maior: na dúvida, o maior.
function processLevel(doc) {
    const isMap = doc && typeof doc === 'object' && !Array.isArray(doc);
    const v12 = isMap && String(doc.handoff_version ?? '') === '1.2';
    const raw = v12 ? doc.nivel_processo : undefined;
    if (typeof raw === 'string' && Object.prototype.hasOwnProperty.call(LEVEL_TEXT, raw)) {
        return { nivel: raw, declared: true, label: raw, text: LEVEL_TEXT[raw] };
    }
    let label = 'não declarado (handoff anterior à 1.2; vale alto)';
    if (v12) label = raw === undefined || raw === null || raw === '' ? 'ausente (vale alto)' : 'inválido (vale alto)';
    return {
        nivel: 'alto',
        declared: false,
        label,
        text: `nível ${label}, vale o maior — ${LEVEL_TEXT.alto}`,
    };
}

const FIELDS = [
    ['approved_document', 'Approved Document'],
    ['evidence', 'Evidence'],
    ['handoff_final', 'Handoff FINAL'],
    ['planning_ledger', 'Planning Ledger'],
];

function isRealDate(iso) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
    if (!m) return false;
    const y = Number(m[1]);
    const mo = Number(m[2]);
    const d = Number(m[3]);
    const dt = new Date(Date.UTC(y, mo - 1, d));
    return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

function isEphemeral(abs) {
    const posix = abs.replace(/\\/g, '/');
    return posix === '/tmp' || posix.startsWith('/tmp/')
        || posix === '/private/tmp' || posix.startsWith('/private/tmp/');
}

function isUrl(text) {
    return /^[a-z][a-z0-9+.-]*:/i.test(text);
}

function isLinearUrl(text) {
    try {
        const u = new URL(text);
        return u.protocol === 'https:' && u.hostname === 'linear.app' && u.pathname.length > 1;
    } catch {
        return false;
    }
}

function evidenceRoot(homeDir) {
    return path.join(homeDir, 'Workspace', 'prisma-evidence');
}

function matchEvidenceDir(abs, homeDir) {
    const root = evidenceRoot(homeDir);
    if (path.dirname(abs) !== root) return null;
    const m = /^(\d{4}-\d{2}-\d{2})-([A-Za-z0-9][A-Za-z0-9._-]*)$/.exec(path.basename(abs));
    if (!m || !isRealDate(m[1])) return null;
    return { dir: abs, date: m[1], frente: m[2] };
}

function matchesCustody(abs, homeDir) {
    if (matchEvidenceDir(abs, homeDir)) return true;
    try {
        return Boolean(matchEvidenceDir(abs, fs.realpathSync(homeDir)));
    } catch {
        return false;
    }
}

function resolveLocal(text, baseDir, homeDir) {
    let p = text;
    if (p === '~') p = homeDir;
    else if (p.startsWith('~/')) p = path.join(homeDir, p.slice(2));
    return path.resolve(baseDir, p);
}

function isInsideDir(parent, child) {
    const rel = path.relative(parent, child);
    return rel !== '' && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}

function inspect(abs) {
    try {
        const st = fs.statSync(abs);
        return { exists: true, directory: st.isDirectory(), file: st.isFile(), real: fs.realpathSync(abs) };
    } catch (e) {
        return { exists: false, error: e.code || e.message };
    }
}

function checkPreDone(doc, opts = {}) {
    const baseDir = opts.baseDir || process.cwd();
    const homeDir = opts.homeDir || os.homedir();
    const handoffPath = opts.handoffPath ? path.resolve(opts.handoffPath) : null;
    const level = processLevel(doc);
    const fixed = `continuam obrigatórios: ${FIXED_RULES.join(', ')}`;
    const base = {
        humanConfirmation: 'required',
        linearDone: 'not_recorded',
        limits: LIMITS.slice(),
        nivelProcesso: { nivel: level.nivel, declared: level.declared, label: level.label },
        fixedRules: FIXED_RULES.slice(),
    };
    const results = [];
    const err = (code, msg) => results.push({ level: 'ERROR', code, msg: `[${level.label}] ${msg}` });
    const refused = () => ({ ...base, outcome: 'refused', exitCode: 1, results });
    const human = (code, msg) => ({
        ...base,
        outcome: 'human',
        exitCode: 3,
        results: [{ level: 'INFO', code, msg: `${msg}. ${level.text}; ${fixed}.` }],
    });

    if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
        err('PRE_DONE_INVALID', 'o handoff precisa ser um mapa para a checagem pré-Done');
        return refused();
    }

    const closure = doc.closure;
    const closureIsMap = closure && typeof closure === 'object' && !Array.isArray(closure);
    const fromDoc = closureIsMap && typeof closure.task_type === 'string' ? closure.task_type.trim() : '';
    const fromCli = typeof opts.taskType === 'string' ? opts.taskType.trim() : '';
    if (fromDoc && fromCli && fromDoc !== fromCli) {
        err('PRE_DONE_TYPE_CONFLICT', `closure.task_type "${fromDoc}" e --task-type "${fromCli}" divergem; a checagem não escolhe um deles`);
        return refused();
    }
    const taskType = fromDoc || fromCli;
    if (!taskType) {
        return human('PRE_DONE_TYPE_ABSENT', 'tipo de tarefa ausente; a checagem não infere o tipo e deixa Done com o Richard');
    }
    if (taskType !== TASK_TYPES.PLANNING) {
        if (!UNDEFINED_TYPES.has(taskType)) {
            return human('PRE_DONE_TYPE_UNKNOWN', `tipo "${taskType}" está fora da tabela de encerramento; a checagem não inventa critério`);
        }
        return human('PRE_DONE_CRITERIA_UNDEFINED', `tipo "${taskType}": os critérios adicionais de Done seguem a definir pelo Richard; a checagem automática cobre só o planejamento Prisma`);
    }
    if (!closureIsMap) {
        err('PRE_DONE_INVALID', 'planejamento Prisma exige o bloco closure com Approved Document, Evidence, Handoff FINAL e Planning Ledger');
        return refused();
    }

    const cited = {};
    for (const [key, label] of FIELDS) {
        const value = closure[key];
        if (typeof value !== 'string' || value.trim() === '') {
            err('PRE_DONE_MISSING', `${label} ausente em closure.${key}`);
            continue;
        }
        const text = value.trim();
        if (text === 'UNKNOWN') {
            err('PRE_DONE_UNKNOWN', `${label} está UNKNOWN; UNKNOWN não conta como prova desta checagem`);
            continue;
        }
        cited[key] = { label, text };
    }

    let evidenceReal = null;
    const evidence = cited.evidence;
    if (evidence) {
        if (isUrl(evidence.text)) {
            err('PRE_DONE_EVIDENCE_CUSTODY', 'Evidence precisa ser o diretório ~/Workspace/prisma-evidence/<data>-<frente>/, não uma URL');
        } else {
            const abs = resolveLocal(evidence.text, baseDir, homeDir);
            if (isEphemeral(abs)) {
                err('PRE_DONE_EPHEMERAL', `Evidence em caminho efêmero (${abs}); a custódia fica em ~/Workspace/prisma-evidence/<data>-<frente>/`);
            } else if (!matchesCustody(abs, homeDir)) {
                err('PRE_DONE_EVIDENCE_CUSTODY', `Evidence fora de ~/Workspace/prisma-evidence/<data>-<frente>/: ${evidence.text}`);
            } else {
                const seen = inspect(abs);
                if (!seen.exists || !seen.directory) {
                    err('PRE_DONE_NOT_FOUND', `Evidence não é um diretório persistido: ${abs}`);
                } else if (isEphemeral(seen.real)) {
                    err('PRE_DONE_EPHEMERAL', `Evidence resolve para caminho efêmero: ${seen.real}`);
                } else if (!matchesCustody(seen.real, homeDir)) {
                    err('PRE_DONE_EVIDENCE_CUSTODY', `Evidence resolve para fora de ~/Workspace/prisma-evidence/<data>-<frente>/: ${seen.real}`);
                } else {
                    evidenceReal = seen.real;
                }
            }
        }
    }

    for (const key of ['approved_document', 'handoff_final', 'planning_ledger']) {
        const item = cited[key];
        if (!item) continue;
        if (isUrl(item.text)) {
            if (!isLinearUrl(item.text)) {
                err('PRE_DONE_INVALID', `${item.label} em URL precisa ser https://linear.app/<caminho>`);
            }
            continue;
        }
        const abs = resolveLocal(item.text, baseDir, homeDir);
        if (isEphemeral(abs)) {
            err('PRE_DONE_EPHEMERAL', `${item.label} em caminho efêmero (${abs}); /tmp e /private/tmp não contam`);
            continue;
        }
        const seen = inspect(abs);
        if (!seen.exists || !seen.file) {
            err('PRE_DONE_NOT_FOUND', `${item.label} não é um arquivo persistido: ${abs}`);
            continue;
        }
        if (isEphemeral(seen.real)) {
            err('PRE_DONE_EPHEMERAL', `${item.label} resolve para caminho efêmero: ${seen.real}`);
            continue;
        }
        let transferReal = handoffPath;
        if (handoffPath) {
            try { transferReal = fs.realpathSync(handoffPath); } catch { /* o arquivo de transferência pode não estar no disco */ }
        }
        const sameTransfer = transferReal && seen.real === transferReal;
        const inside = evidenceReal ? isInsideDir(evidenceReal, seen.real) : false;
        if (key === 'handoff_final' && sameTransfer && !inside) {
            err('PRE_DONE_TEMP_HANDOFF', 'Handoff FINAL aponta para o handoff temporário de transferência; ele não substitui o Handoff FINAL persistido');
            continue;
        }
        if (!evidenceReal || !inside) {
            err('PRE_DONE_OUTSIDE_CUSTODY', `${item.label} local fica fora do diretório de Evidence citado`);
        }
    }

    if (results.length) return refused();
    return {
        ...base,
        outcome: 'evidence_present',
        exitCode: 0,
        results: [{
            level: 'INFO',
            code: 'PRE_DONE_EVIDENCE_PRESENT',
            msg: `Approved Document, Evidence, Handoff FINAL e Planning Ledger estão citados. ${level.text}; ${fixed}. A confirmação do Richard continua obrigatória. Done não foi registrado.`,
        }],
    };
}

module.exports = { checkPreDone, TASK_TYPES, LIMITS, FIXED_RULES, processLevel, evidenceRoot };
