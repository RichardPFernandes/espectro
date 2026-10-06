// Matriz de cobertura dos Critérios de Aceite (memory/runs/<task-id>/acceptance-evidence.json).
// Responde, sem LLM, "como sabemos que AC-03 foi implementado e validado?":
//
//   SPEC (AC-03) → PLAN (plan_steps) → IMPLEMENTATION (implementation) →
//   TEST (evidence[], com artifact) → VERIFY (verification.results)
//
// O /test escreve a matriz (uma chave por AC ativo da spec, evidências do mesmo AC
// agrupadas) e roda `finalize`, que carimba run_id/generated_at/spec_hash/spec_version
// (run versionado — scripts/lib/spec-version.js; legado: spec_version null)/summary e
// completa plan_steps/implementation a partir do plan.md. O /verify (spec-authority.js
// verify → checkMatrix) confere, nunca confiando só em `result`:
//   - todo AC ativo da spec está na matriz (AC criado depois do Test = AC_WITHOUT_EVIDENCE,
//     e spec_hash diferente do atual = EVIDENCE_SPEC_STALE; spec_version diferente da
//     versão vigente = EVIDENCE_SPEC_VERSION_MISMATCH);
//   - `artifact` existe no disco (relativo à raiz do checkout, ou ao run);
//   - teste alegado rodou de verdade: o testcase está no relatório surefire/failsafe
//     (XML) ou é citado no log; o resultado real (failure/error/skipped) bate com `result`;
//   - build com "BUILD FAILURE" no log não passa como PASS (e vice-versa);
//   - status do AC = agregado das evidências (FAIL > BLOCKED > PASS > NOT_AUTOMATED);
//   - NOT_AUTOMATED/BLOCKED/not-applicable chegam com justificativa.
// Veredito por AC: PASS ok; FAIL e BLOCKED reprovam; NOT_AUTOMATED com justificativa
// NÃO reprova — vira aviso AC_NOT_AUTOMATED (validação humana explícita no relatório);
// AC só com evidência not-applicable reprova (AC que não se aplica é SPEC_CHANGE).
//
// Uso como CLI (<run-dir> = memory/runs/<task-id>):
//   node scripts/lib/acceptance-evidence.js finalize <run-dir>        carimba + completa a cadeia
//   node scripts/lib/acceptance-evidence.js check <run-dir> [--json]  checagem completa (= parte do verify)
//   node scripts/lib/acceptance-evidence.js render <run-dir> [--write]  matriz em markdown (ac-evidence.md)
//   node scripts/lib/acceptance-evidence.js trace <run-dir> <AC-NN>   cadeia SPEC→PLAN→IMPL→TEST→VERIFY
//   node scripts/lib/acceptance-evidence.js scan <reports-dir|xml>... testcases executados e resultado
// exit 0 = ok, 1 = check FAIL / AC fora da matriz, 2 = uso incorreto/arquivo inexistente/JSON inválido.

const fs = require('fs');
const path = require('path');
const invalidate = require('../invalidate');

const FILE = 'acceptance-evidence.json';
const SCHEMA_VERSION = 1;
const SCHEMA_PATH = path.join(__dirname, '..', '..', '.graph', 'schemas', 'acceptance-evidence.schema.json');
const RESULTS = ['PASS', 'FAIL', 'NOT_AUTOMATED', 'BLOCKED'];
const TYPES = ['automated-test', 'regression-test', 'integration-test', 'build', 'static-analysis', 'manual', 'not-applicable'];
const TEST_TYPES = new Set(['automated-test', 'regression-test', 'integration-test']);
const ARTIFACT_REQUIRED = new Set([...TEST_TYPES, 'build', 'static-analysis']);
// Agregado: o pior resultado vence; NOT_AUTOMATED só quando nada foi executado.
const PRECEDENCE = ['FAIL', 'BLOCKED', 'PASS', 'NOT_AUTOMATED'];
const MIN_JUSTIFICATION = 10;
const AC_KEY = /^AC-\d{2,}$/;

let Ajv = null;
let addFormats = null;
try { Ajv = require('ajv'); } catch { /* validação estrutural manual abaixo cobre o essencial */ }
try { addFormats = require('ajv-formats'); } catch { /* formats ficam sem validar */ }

const defaultIo = {
    exists: p => fs.existsSync(p),
    isDir: p => { try { return fs.statSync(p).isDirectory(); } catch { return false; } },
    read: p => fs.readFileSync(p, 'utf8'),
    list: p => fs.readdirSync(p),
};

// ── Schema ───────────────────────────────────────────────────────────────────────

let compiled;
function schemaValidator() {
    if (compiled !== undefined) return compiled;
    compiled = null;
    if (!Ajv) return compiled;
    const ajv = new Ajv({ allErrors: true, strict: false });
    if (addFormats) addFormats(ajv);
    compiled = ajv.compile(JSON.parse(fs.readFileSync(SCHEMA_PATH, 'utf8')));
    return compiled;
}

/** Erros de schema como strings legíveis (ajv quando instalado + checagem estrutural mínima). */
function validateSchema(data) {
    const errors = [];
    if (!data || typeof data !== 'object' || Array.isArray(data)) return ['raiz não é um objeto JSON'];
    for (const k of ['run_id', 'generated_at', 'spec_hash', 'coverage']) if (data[k] == null) errors.push(`sem campo obrigatório "${k}"`);
    if (data.coverage && typeof data.coverage === 'object') {
        for (const [id, c] of Object.entries(data.coverage)) {
            if (!AC_KEY.test(id)) errors.push(`coverage: chave "${id}" não é um ID de AC (AC-NN)`);
            if (!c || typeof c !== 'object') { errors.push(`coverage.${id}: não é objeto`); continue; }
            if (!RESULTS.includes(c.status)) errors.push(`coverage.${id}.status: "${c.status}" fora de ${RESULTS.join('/')}`);
            if (!Array.isArray(c.evidence) || !c.evidence.length) errors.push(`coverage.${id}.evidence: precisa de ao menos uma evidência`);
            (Array.isArray(c.evidence) ? c.evidence : []).forEach((e, i) => {
                if (!e || typeof e !== 'object') { errors.push(`coverage.${id}.evidence[${i}]: não é objeto`); return; }
                if (!TYPES.includes(e.type)) errors.push(`coverage.${id}.evidence[${i}].type: "${e.type}" fora de ${TYPES.join('/')}`);
                if (!RESULTS.includes(e.result)) errors.push(`coverage.${id}.evidence[${i}].result: "${e.result}" fora de ${RESULTS.join('/')}`);
                if (!e.description) errors.push(`coverage.${id}.evidence[${i}]: sem description`);
            });
        }
    }
    const validate = schemaValidator();
    if (validate && !validate(data)) {
        for (const e of validate.errors) {
            // if/then do schema gera um erro "if" redundante com o erro real do "then".
            if (e.keyword === 'if') continue;
            const where = e.instancePath || '(raiz)';
            const what = e.keyword === 'required' ? `sem campo obrigatório "${e.params.missingProperty}"` : e.message;
            const msg = `${where}: ${what}`;
            if (!errors.includes(msg)) errors.push(msg);
        }
    }
    return errors;
}

/** Chaves AC repetidas em coverage — JSON.parse ficaria só com a última, sem avisar. */
function duplicateAcKeys(raw) {
    const seen = new Map();
    for (const m of coverageText(String(raw || '')).matchAll(/"(AC-\d+)"\s*:\s*\{/g)) seen.set(m[1], (seen.get(m[1]) || 0) + 1);
    return [...seen].filter(([, n]) => n > 1).map(([id]) => id);
}

/** Só o objeto coverage — verification.results (gravado pelo próprio Verify) repete os IDs. */
function coverageText(s) {
    const k = /"coverage"\s*:\s*\{/.exec(s);
    if (!k) return s;
    const start = k.index + k[0].length - 1;
    let depth = 0, inStr = false;
    for (let i = start; i < s.length; i++) {
        const c = s[i];
        if (inStr) { if (c === '\\') i++; else if (c === '"') inStr = false; continue; }
        if (c === '"') inStr = true;
        else if (c === '{') depth++;
        else if (c === '}' && --depth === 0) return s.slice(start, i + 1);
    }
    return s.slice(start);
}

function parse(raw) {
    try { return { data: JSON.parse(raw), error: null }; } catch (e) { return { data: null, error: e.message }; }
}

// ── Relatórios de teste ──────────────────────────────────────────────────────────

function xmlUnescape(s) {
    return String(s).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}

function attr(tag, name) {
    const m = new RegExp(`\\s${name}="([^"]*)"`).exec(tag);
    return m ? xmlUnescape(m[1]) : null;
}

/** Testcases de um relatório surefire/failsafe: [{classname, name, outcome}] (PASS|FAIL|SKIPPED). */
function parseJUnitXml(xml) {
    const cases = [];
    const re = /<testcase\b([^>]*?)(\/>|>([\s\S]*?)<\/testcase>)/g;
    let m;
    while ((m = re.exec(xml))) {
        const body = m[3] || '';
        const outcome = /<(failure|error)\b/.test(body) ? 'FAIL' : /<skipped\b/.test(body) ? 'SKIPPED' : 'PASS';
        cases.push({ classname: attr(m[1], 'classname') || '', name: attr(m[1], 'name') || '', outcome });
    }
    return cases;
}

function isJUnitXml(content) {
    return /<testsuites?\b/.test(content);
}

/** Classe[#método] a procurar no relatório: campo `test`, senão "Classe#metodo" da descrição. */
function testTarget(ev) {
    const src = ev.test || (/([A-Za-z_$][\w$.]*)#([\w$]+)/.exec(ev.description || '') || [])[0];
    if (!src) return null;
    const [cls, ...rest] = src.split('#');
    const method = rest.join('#').replace(/\(.*$/, '').trim() || null;
    return { cls, method, label: method ? `${cls}#${method}` : cls };
}

function classMatches(classname, cls) {
    if (classname === cls) return true;
    const simple = classname.split('.').pop();
    // Nested do JUnit 5: "ResumoServiceTest$FiltroTests" casa "ResumoServiceTest" e o próprio aninhado.
    return classname.endsWith(`.${cls}`) || simple === cls || simple.startsWith(`${cls}$`) || simple.endsWith(`$${cls}`);
}

function nameMatches(name, method) {
    // Parametrizado: "metodo(String)[1]", "metodo[1]", "[1] metodo(...)" no display name.
    return name === method || name.startsWith(`${method}(`) || name.startsWith(`${method}[`);
}

function findCases(cases, target) {
    return cases.filter(c => classMatches(c.classname, target.cls) && (!target.method || nameMatches(c.name, target.method)));
}

function aggregateOutcome(cases) {
    if (cases.some(c => c.outcome === 'FAIL')) return 'FAIL';
    if (cases.every(c => c.outcome === 'SKIPPED')) return 'SKIPPED';
    return 'PASS';
}

// ── Artefatos ────────────────────────────────────────────────────────────────────

/** "build.log#L120" / "build.log:120" → {file, line}. */
function splitAnchor(artifact) {
    const m = /^(.*?)(?:#L(\d+)|:(\d+))$/.exec(artifact);
    return m ? { file: m[1], line: Number(m[2] || m[3]) } : { file: artifact, line: null };
}

function resolveArtifact(artifact, { root, runDir, io }) {
    const { file, line } = splitAnchor(String(artifact).trim());
    const candidates = path.isAbsolute(file) ? [file] : [root && path.resolve(root, file), runDir && path.resolve(runDir, file)].filter(Boolean);
    const found = candidates.find(p => io.exists(p));
    return { abs: found || null, file, line, tried: candidates };
}

function reportFilesIn(dir, io) {
    return io.list(dir).filter(f => /\.xml$/i.test(f)).map(f => path.join(dir, f));
}

/**
 * Confere uma evidência contra o artefato real.
 * @returns {{problems: {code, message}[], notes: {code, message}[], actual: string|null}}
 *   problems reprovam; notes viram aviso; actual = resultado observado no artefato.
 */
function checkEvidence(ev, where, ctx) {
    const io = ctx.io || defaultIo;
    const problems = [];
    const notes = [];
    const bad = (code, message) => problems.push({ code, message: `${where}: ${message}` });
    const note = (code, message) => notes.push({ code, message: `${where}: ${message}` });

    if ((ev.result === 'NOT_AUTOMATED' || ev.result === 'BLOCKED' || ev.type === 'not-applicable') &&
        String(ev.justification || '').trim().length < MIN_JUSTIFICATION) {
        bad('EVIDENCE_WITHOUT_JUSTIFICATION', `${ev.type}/${ev.result} sem "justification" explícita (mín. ${MIN_JUSTIFICATION} caracteres).`);
    }

    const hasArtifact = typeof ev.artifact === 'string' && ev.artifact.trim();
    if (!hasArtifact) {
        if (ARTIFACT_REQUIRED.has(ev.type) && ev.result !== 'BLOCKED') {
            bad('ARTIFACT_MISSING', `evidência ${ev.type} sem "artifact" — o Verify precisa do relatório/log que prova a execução.`);
        } else if (ev.type === 'manual' && ev.result === 'PASS') {
            note('MANUAL_EVIDENCE_UNVERIFIED', 'verificação manual PASS sem artefato (screenshot/log) — relato do agente, não conferível.');
        }
        return { problems, notes, actual: null };
    }

    const art = resolveArtifact(ev.artifact, ctx);
    if (!art.abs) {
        bad('ARTIFACT_NOT_FOUND', `artifact "${ev.artifact}" não existe (procurado em ${art.tried.join(', ')}).`);
        return { problems, notes, actual: null };
    }

    // Diretório de relatórios: procura o testcase em todos os XML dele.
    let files = [art.abs];
    if (io.isDir(art.abs)) {
        files = reportFilesIn(art.abs, io);
        if (!files.length) {
            bad('ARTIFACT_NOT_FOUND', `artifact "${ev.artifact}" é um diretório sem relatórios .xml.`);
            return { problems, notes, actual: null };
        }
    }
    const contents = files.map(f => ({ f, text: io.read(f) }));

    if (art.line != null) {
        const lines = contents[0].text.split('\n');
        if (art.line < 1 || art.line > lines.length) bad('ARTIFACT_NOT_FOUND', `artifact "${ev.artifact}" aponta a linha ${art.line}, mas o arquivo tem ${lines.length}.`);
    }

    // ── Testes: o testcase alegado tem de estar no relatório, com o resultado alegado.
    if (TEST_TYPES.has(ev.type) && ev.result !== 'BLOCKED') {
        const target = testTarget(ev);
        if (!target) {
            bad('TEST_NOT_IDENTIFIED', 'não dá pra saber qual teste conferir — use "Classe#metodo" em description ou o campo "test".');
            return { problems, notes, actual: null };
        }
        const xmls = contents.filter(c => isJUnitXml(c.text));
        if (xmls.length) {
            const cases = xmls.flatMap(c => parseJUnitXml(c.text));
            const hit = findCases(cases, target);
            if (!hit.length) {
                bad('TEST_NOT_EXECUTED', `${target.label} não aparece em ${ev.artifact} — o teste alegado não rodou (ou o relatório é de outra execução).`);
                return { problems, notes, actual: null };
            }
            const actual = aggregateOutcome(hit);
            if (actual === 'SKIPPED') {
                bad('TEST_SKIPPED', `${target.label} foi ignorado (skipped) em ${ev.artifact} — não executou, não prova o AC.`);
            } else if (ev.result !== 'NOT_AUTOMATED' && actual !== ev.result) {
                bad('RESULT_MISMATCH', `result "${ev.result}", mas ${ev.artifact} registra ${actual} para ${target.label}.`);
            }
            return { problems, notes, actual };
        }
        // Log de texto: o teste tem de ser citado; falha explícita do surefire contradiz PASS.
        const text = contents.map(c => c.text).join('\n');
        const key = target.method || target.cls;
        const lines = text.split('\n').filter(l => l.includes(key));
        if (!lines.length) {
            bad('TEST_NOT_EXECUTED', `${target.label} não é citado em ${ev.artifact}.`);
            return { problems, notes, actual: null };
        }
        const failed = lines.some(l => /<<<\s*(FAILURE|ERROR)!|\bFAILED\b/.test(l));
        const actual = failed ? 'FAIL' : null;
        if (failed && ev.result === 'PASS') bad('RESULT_MISMATCH', `result "PASS", mas ${ev.artifact} registra falha de ${target.label}.`);
        else if (!failed) note('RESULT_UNCONFIRMED', `${ev.artifact} cita ${target.label}, mas log de texto não confirma o resultado — prefira o XML do surefire.`);
        return { problems, notes, actual };
    }

    if (ev.type === 'build' && ev.result !== 'BLOCKED') {
        const text = contents.map(c => c.text).join('\n');
        const failure = /BUILD FAILURE|COMPILATION ERROR/.test(text);
        const success = /BUILD SUCCESS/.test(text);
        if (failure && ev.result === 'PASS') bad('RESULT_MISMATCH', `result "PASS", mas ${ev.artifact} registra BUILD FAILURE.`);
        if (success && !failure && ev.result === 'FAIL') bad('RESULT_MISMATCH', `result "FAIL", mas ${ev.artifact} registra BUILD SUCCESS.`);
        if (!failure && !success) note('RESULT_UNCONFIRMED', `${ev.artifact} não tem "BUILD SUCCESS"/"BUILD FAILURE" — resultado do build não confirmado.`);
        return { problems, notes, actual: failure ? 'FAIL' : success ? 'PASS' : null };
    }
    return { problems, notes, actual: null };
}

// ── Agregado por AC ──────────────────────────────────────────────────────────────

/** Status agregado das evidências (not-applicable não conta); null se só houver N/A. */
function aggregateStatus(evidence) {
    const results = (evidence || []).filter(e => e.type !== 'not-applicable').map(e => e.result);
    return PRECEDENCE.find(r => results.includes(r)) || null;
}

function isAutomated(e) {
    return TEST_TYPES.has(e.type) && e.result === 'PASS';
}

/** Métricas derivadas (summary) — base de % automatizado, NOT_AUTOMATED frequente, ACs que falham. */
function summarize(coverage) {
    const entries = Object.entries(coverage || {});
    const byStatus = {};
    const byType = {};
    for (const [, c] of entries) {
        byStatus[c.status] = (byStatus[c.status] || 0) + 1;
        for (const e of c.evidence || []) byType[e.type] = (byType[e.type] || 0) + 1;
    }
    const automated = entries.filter(([, c]) => (c.evidence || []).some(isAutomated)).length;
    const ids = s => entries.filter(([, c]) => c.status === s).map(([id]) => id);
    return {
        total: entries.length,
        by_status: byStatus,
        by_evidence_type: byType,
        automated,
        automated_pct: entries.length ? Math.round((automated / entries.length) * 1000) / 10 : 0,
        not_automated: ids('NOT_AUTOMATED'),
        failed: ids('FAIL'),
        blocked: ids('BLOCKED'),
    };
}

// ── Checagem da matriz (usada pelo Verify) ───────────────────────────────────────

/**
 * Confere a matriz contra os ACs ativos da spec e contra os artefatos no disco.
 * @param {{raw: string, activeAcs: string[], knownAcs?: string[], specHash?: string|null,
 *   specVersion?: number|null, root?: string, runDir?: string, io?: object}} input
 * @returns {{failures: {code, message}[], warnings: {code, message}[],
 *   coverage: {id, status, evidence}[], results: Object<string, {verdict, problems}>,
 *   summary: object|null, data: object|null}}
 */
function checkMatrix(input) {
    const { raw, activeAcs = [], specHash = null, root, runDir } = input;
    const io = input.io || defaultIo;
    const known = new Set(input.knownAcs || activeAcs);
    const failures = [];
    const warnings = [];
    const fail = (code, message) => failures.push({ code, message });
    const warn = (code, message) => warnings.push({ code, message });
    const results = {};
    const coverage = [];

    const { data, error } = parse(raw);
    if (error) {
        fail('EVIDENCE_INVALID', `${FILE} não é JSON válido: ${error}.`);
        for (const id of activeAcs) results[id] = { verdict: 'MISSING', problems: ['matriz ilegível'] };
        return { failures, warnings, coverage, results, summary: null, data: null };
    }
    for (const e of validateSchema(data)) fail('EVIDENCE_INVALID', `${FILE} ${e}`);
    for (const id of duplicateAcKeys(raw)) fail('EVIDENCE_DUPLICATE_AC', `${id} aparece mais de uma vez em ${FILE} — agrupe as evidências sob um único ${id}.`);

    // Validade da matriz contra a spec atual: decidida só em scripts/invalidate.js
    // (STALE = outra versão ou invalidada por SPEC_CHANGE; UNKNOWN = sem spec_hash).
    if (data && specHash) {
        const g = invalidate.guardVerify(input.state || {}, data, { current: { hash: specHash, version: input.specVersion ?? null }, runDir: runDir || null, checkPending: input.checkPending !== false });
        if (!g.ok) fail(g.code, g.message);
    }

    const cov = data && typeof data.coverage === 'object' && data.coverage ? data.coverage : {};
    for (const id of activeAcs) {
        const c = cov[id];
        const problems = [];
        if (!c) {
            fail('AC_WITHOUT_EVIDENCE', `${id} não está em ${FILE} — nenhuma evidência (AC criado depois do Test?).`);
            results[id] = { verdict: 'MISSING', problems: ['sem evidência na matriz'] };
            coverage.push({ id, status: 'AUSENTE', evidence: '' });
            continue;
        }
        const evidence = Array.isArray(c.evidence) ? c.evidence : [];
        evidence.forEach((ev, i) => {
            if (!ev || typeof ev !== 'object') return;
            const r = checkEvidence(ev, `${id} evidence[${i}] (${ev.description || ev.type})`, { root, runDir, io });
            for (const p of r.problems) { fail(p.code, p.message); problems.push(p.message); }
            for (const n of r.notes) warn(n.code, n.message);
        });

        const computed = aggregateStatus(evidence);
        if (computed == null && evidence.length) {
            fail('AC_ONLY_NOT_APPLICABLE', `${id} só tem evidência not-applicable — AC ativo que não se aplica é SPEC_CHANGE (remova/marque na spec com aprovação), não decisão do Test.`);
            problems.push('só not-applicable');
        } else if (computed && c.status !== computed) {
            fail('AC_STATUS_INCONSISTENT', `${id} declarado ${c.status}, mas as evidências agregam ${computed} (FAIL > BLOCKED > PASS > NOT_AUTOMATED).`);
            problems.push(`status ${c.status} ≠ agregado ${computed}`);
        }
        const status = computed || c.status;
        if (status === 'FAIL') {
            fail('AC_EVIDENCE_FAIL', `${id} FAIL: ${evidence.filter(e => e.result === 'FAIL').map(e => e.description).join('; ') || 'evidência reprovada'}.`);
        } else if (status === 'BLOCKED') {
            fail('AC_BLOCKED', `${id} BLOCKED — não avaliado (${short(c.justification || evidence.find(e => e.result === 'BLOCKED')?.justification || 'sem justificativa')}). Resolva a dependência ou escale.`);
        } else if (status === 'NOT_AUTOMATED') {
            const why = String(c.justification || '').trim();
            if (why.length < MIN_JUSTIFICATION) {
                fail('AC_NOT_AUTOMATED_WITHOUT_JUSTIFICATION', `${id} NOT_AUTOMATED sem "justification" no AC — o Verify só aceita não-automatizado com motivo explícito.`);
                problems.push('NOT_AUTOMATED sem justificativa');
            } else {
                warn('AC_NOT_AUTOMATED', `${id} NOT_AUTOMATED — requer validação humana: ${short(why, 160)}`);
            }
        }
        const verdict = problems.length || status === 'FAIL' ? 'FAIL' : status;
        results[id] = { verdict, problems };
        coverage.push({ id, status: verdict === 'FAIL' && status !== 'FAIL' ? `${status}→FAIL` : status, evidence: evidence.map(e => `${e.description} [${e.type}${e.artifact ? ` · ${e.artifact}` : ''}]`).join('; ') });
    }
    for (const id of Object.keys(cov)) {
        if (!activeAcs.includes(id)) warn('EVIDENCE_UNKNOWN_AC', `${FILE} tem ${id}, que ${known.has(id) ? 'foi removido da' : 'não existe na'} spec.`);
    }
    return { failures, warnings, coverage, results, summary: summarize(cov), data };
}

function short(text, max = 100) {
    const t = String(text).replace(/\s+/g, ' ').trim();
    return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

// ── Plano → passos/arquivos por AC ──────────────────────────────────────────────

/** Passos de "## Plano de execução" que citam o AC: [{n, title, files}]. */
function planStepsFor(planContent, acId) {
    if (!planContent) return [];
    const lines = String(planContent).replace(/\r\n?/g, '\n').split('\n');
    const start = lines.findIndex(l => /^##\s+(plano|passos|etapas|steps)\b/i.test(l.normalize('NFD').replace(/[̀-ͯ]/g, '')));
    if (start < 0) return [];
    const steps = [];
    let cur = null;
    for (const line of lines.slice(start + 1)) {
        if (/^#{1,2}\s/.test(line)) break;
        const m = /^(\d+)[.)]\s+(.*)$/.exec(line);
        if (m) { cur = { n: Number(m[1]), title: m[2].trim(), body: [] }; steps.push(cur); continue; }
        if (cur) cur.body.push(line);
    }
    const idRe = new RegExp(`\\b${acId}\\b`);
    return steps.filter(s => idRe.test(`${s.title}\n${s.body.join('\n')}`)).map(s => ({
        n: s.n,
        title: s.title,
        files: s.body.map(l => /Arquivos?\s*:\s*(.*)$/i.exec(l)).filter(Boolean)
            .flatMap(m => [...m[1].matchAll(/`([^`]+)`/g)].map(x => x[1])),
    }));
}

/**
 * Carimba run_id/generated_at/spec_hash/spec_version/summary e completa
 * plan_steps/implementation do plano. specVersion null = run legado (ou hash fora da
 * versão vigente: mid-run) — gravado como null, nunca inventado.
 */
function finalize(data, { runId, ticketId, specPath, specHash, specVersion = null, specHashScope = null, planContent, now = new Date().toISOString() }) {
    const out = { schema_version: SCHEMA_VERSION, run_id: runId, ...data };
    out.schema_version = SCHEMA_VERSION;
    out.run_id = runId;
    if (ticketId != null && out.ticket_id == null) out.ticket_id = String(ticketId);
    out.generated_at = now;
    out.generated_by = out.generated_by || 'test';
    if (specPath) out.spec_path = specPath;
    if (specHash) out.spec_hash = specHash;
    // A validade da matriz não é decidida aqui: o CLI carimba (invalidate.stampProduced) e
    // espelha no arquivo (syncEvidenceFile). Bloco antigo de outra rodada sai.
    delete out.validity;
    out.spec_version = Number.isInteger(specVersion) ? specVersion : null;
    if (specHashScope) out.spec_hash_scope = specHashScope;
    for (const [id, c] of Object.entries(out.coverage || {})) {
        const steps = planStepsFor(planContent, id);
        if (!Array.isArray(c.plan_steps) || !c.plan_steps.length) c.plan_steps = steps.map(s => s.n);
        if (!Array.isArray(c.implementation) || !c.implementation.length) c.implementation = [...new Set(steps.flatMap(s => s.files))];
    }
    out.summary = summarize(out.coverage);
    delete out.verification; // matriz nova invalida o veredito anterior
    // Ordem estável das chaves de topo (diff legível entre rodadas).
    const order = ['schema_version', 'run_id', 'ticket_id', 'generated_at', 'generated_by', 'spec_path', 'spec_version', 'spec_hash', 'spec_hash_scope', 'validity', 'module', 'coverage', 'summary'];
    return Object.fromEntries([...order.filter(k => k in out).map(k => [k, out[k]]), ...Object.entries(out).filter(([k]) => !order.includes(k))]);
}

/** Matriz em markdown (ac-evidence.md — leitura humana; a fonte é o JSON). */
function renderMarkdown(data, { taskId } = {}) {
    const lines = [
        `# Evidências dos Critérios de Aceite — ${taskId || data.run_id}`,
        `Spec: ${data.spec_path || '—'} (${data.spec_version != null ? `spec_version ${data.spec_version} · ` : ''}spec_hash ${String(data.spec_hash || '—').slice(0, 12)})`,
        `Fonte: ${FILE} (gerado em ${data.generated_at || '—'})`,
        '',
        '| AC | Evidência | Tipo | Resultado | Artefato |',
        '|----|-----------|------|-----------|----------|',
    ];
    const cell = s => String(s ?? '—').replace(/\|/g, '\\|').replace(/\s+/g, ' ');
    for (const [id, c] of Object.entries(data.coverage || {})) {
        (c.evidence || []).forEach((e, i) => {
            const desc = e.justification && e.result !== 'PASS' ? `${e.description} — ${e.justification}` : e.description;
            lines.push(`| ${i === 0 ? `**${id}** (${c.status})` : ''} | ${cell(desc)} | ${e.type} | ${e.result} | ${cell(e.artifact || '—')} |`);
        });
    }
    const s = data.summary || summarize(data.coverage);
    lines.push('', `Automatizados: ${s.automated}/${s.total} (${s.automated_pct}%)` +
        (s.not_automated.length ? ` · NOT_AUTOMATED: ${s.not_automated.join(', ')}` : '') +
        (s.failed.length ? ` · FAIL: ${s.failed.join(', ')}` : '') +
        (s.blocked.length ? ` · BLOCKED: ${s.blocked.join(', ')}` : ''));
    return lines.join('\n') + '\n';
}

/** Testcases executados em relatórios (ajuda o /test a montar `test`/`artifact` sem adivinhar). */
function scanReports(targets, io = defaultIo) {
    const out = [];
    for (const t of targets) {
        const files = io.isDir(t) ? reportFilesIn(t, io) : [t];
        for (const f of files) {
            const text = io.read(f);
            if (!isJUnitXml(text)) continue;
            for (const c of parseJUnitXml(text)) out.push({ test: `${c.classname.split('.').pop()}#${c.name}`, outcome: c.outcome, artifact: f });
        }
    }
    return out;
}

module.exports = {
    FILE, SCHEMA_PATH, SCHEMA_VERSION, RESULTS, TYPES,
    validateSchema, parseJUnitXml, testTarget, findCases, checkEvidence, aggregateStatus,
    summarize, checkMatrix, planStepsFor, finalize, renderMarkdown, scanReports, duplicateAcKeys,
};

// ── CLI ──────────────────────────────────────────────────────────────────────────

if (require.main === module) {
    const sa = require('./spec-authority');
    const args = process.argv.slice(2);
    const has = f => args.includes(`--${f}`);
    const [cmd, target, extra] = args.filter(a => !a.startsWith('--'));
    const usage = () => {
        console.error('Uso: node scripts/lib/acceptance-evidence.js finalize <run-dir> | check <run-dir> [--json] | render <run-dir> [--write] | trace <run-dir> <AC-NN> | scan <reports-dir|xml>...');
        process.exit(2);
    };
    if (!cmd || !target) usage();

    if (cmd === 'scan') {
        const targets = args.filter(a => !a.startsWith('--')).slice(1);
        if (targets.some(t => !fs.existsSync(t))) usage();
        for (const r of scanReports(targets)) console.log(`${r.outcome.padEnd(7)} ${r.test}  ${path.relative(process.cwd(), r.artifact)}`);
        process.exit(0);
    }

    const runDir = path.resolve(target);
    if (!fs.existsSync(path.join(runDir, 'state.json'))) { console.error(`${target}: sem state.json.`); process.exit(2); }
    const root = sa.rootOfRunDir(runDir);
    const taskId = path.basename(runDir);
    const state = JSON.parse(fs.readFileSync(path.join(runDir, 'state.json'), 'utf8'));
    const specPath = sa.specRelFor(state, taskId);
    const specContent = (() => { try { return fs.readFileSync(path.resolve(root, specPath), 'utf8'); } catch { return null; } })();
    const file = path.join(runDir, FILE);
    const raw = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
    const { planContent } = sa.readPlan(runDir);

    if (cmd === 'finalize') {
        if (raw == null) { console.error(`${file} não existe — o /test escreve a matriz antes do finalize.`); process.exit(2); }
        const { data, error } = parse(raw);
        if (error) { console.error(`${FILE} inválido: ${error}`); process.exit(2); }
        const currentHash = specContent == null ? null : sa.specHashFor(state, specContent);
        const stamp = require('./spec-version').stampFor(state, currentHash);
        if (stamp.mismatch) console.error(`[acceptance-evidence] ALERTA ${stamp.message} — spec_version gravada como null.`);
        const out = finalize(data, {
            runId: taskId, ticketId: state.redmine_ticket?.id, specPath,
            specHash: currentHash, specVersion: stamp.spec_version, specHashScope: specContent == null ? null : sa.hashScopeFor(state), planContent,
        });
        fs.writeFileSync(file, JSON.stringify(out, null, 2) + '\n');
        // Matriz nova substitui a STALE/UNKNOWN: state.artifact_validity.evidence VALID.
        if (currentHash) {
            invalidate.stampProduced(state, 'evidence', { specHash: currentHash, specVersion: stamp.spec_version, runDir });
            state.updated_at = new Date().toISOString();
            require('../state-writer').write(runDir, state, { operation: 'evidence_finalize', actor: 'agent' });
            invalidate.syncEvidenceFile(runDir, state); // VALID, ou STALE se a execução não é da spec atual
        }
        const errs = validateSchema(out);
        const spec = specContent == null ? null : sa.specAcs(specContent);
        const missing = spec ? spec.acs.filter(a => a.active && !out.coverage?.[a.id]).map(a => a.id) : [];
        console.log(`[acceptance-evidence] ${FILE} finalizado: ${out.summary.total} AC(s), ${out.summary.automated_pct}% automatizado(s)${out.spec_version != null ? `, spec v${out.spec_version}` : ''}.`);
        for (const e of errs) console.error(`[acceptance-evidence] schema: ${e}`);
        if (missing.length) console.error(`[acceptance-evidence] ACs ativos da spec fora da matriz: ${missing.join(', ')}`);
        process.exit(errs.length || missing.length ? 1 : 0);
    }
    if (cmd === 'render') {
        if (raw == null) { console.error(`${file} não existe.`); process.exit(2); }
        const { data, error } = parse(raw);
        if (error) { console.error(`${FILE} inválido: ${error}`); process.exit(2); }
        const md = renderMarkdown(data, { taskId });
        if (has('write')) fs.writeFileSync(path.join(runDir, 'ac-evidence.md'), md);
        process.stdout.write(md);
        process.exit(0);
    }
    if (cmd === 'check') {
        if (raw == null) { console.error(`${file} não existe.`); process.exit(1); }
        const spec = specContent == null ? { acs: [] } : sa.specAcs(specContent);
        const r = checkMatrix({
            raw, activeAcs: spec.acs.filter(a => a.active).map(a => a.id), knownAcs: spec.acs.map(a => a.id),
            specHash: specContent == null ? null : sa.specHashFor(state, specContent),
            specVersion: require('./spec-version').versionOf(state), root, runDir, state,
        });
        if (has('json')) console.log(JSON.stringify({ failures: r.failures, warnings: r.warnings, results: r.results, summary: r.summary }, null, 2));
        else {
            for (const [id, x] of Object.entries(r.results)) console.log(`${id}: ${x.verdict}${x.problems.length ? ` — ${x.problems.join(' | ')}` : ''}`);
            for (const f of r.failures) console.log(`[FAIL] ${f.code}: ${f.message}`);
            for (const w of r.warnings) console.log(`[WARN] ${w.code}: ${w.message}`);
        }
        process.exit(r.failures.length ? 1 : 0);
    }
    if (cmd === 'trace') {
        const id = String(extra || '').toUpperCase();
        if (!AC_KEY.test(id)) usage();
        const ac = specContent == null ? null : sa.specAcs(specContent).acs.find(a => a.id === id);
        const data = raw == null ? null : parse(raw).data;
        const c = data?.coverage?.[id];
        const steps = planStepsFor(planContent, id);
        const v = data?.verification?.results?.[id];
        const out = [
            `SPEC            ${specPath}: ${ac ? `${id} — ${ac.head}${ac.active ? '' : ' (removido)'}` : `${id} não existe na spec`}`,
            `PLAN            ${steps.length ? steps.map(s => `passo ${s.n}: ${s.title}`).join(' | ') : (c?.plan_steps?.length ? `passos ${c.plan_steps.join(', ')}` : 'nenhum passo cita o AC')}`,
            `IMPLEMENTATION  ${(c?.implementation?.length ? c.implementation : [...new Set(steps.flatMap(s => s.files))]).join(', ') || '—'}`,
            `TEST            ${c ? `${c.status} — ${c.evidence.map(e => `${e.description} [${e.type}] ${e.result}${e.artifact ? ` (${e.artifact})` : ''}`).join('; ')}` : 'sem evidência na matriz'}`,
            `VERIFY          ${v ? `${v.verdict}${v.problems?.length ? ` — ${v.problems.join(' | ')}` : ''} (${data.verification.verified_at})` : 'ainda não verificado'}`,
        ];
        console.log(out.join('\n'));
        process.exit(ac && c ? 0 : 1);
    }
    usage();
}
