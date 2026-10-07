// Resultado estruturado do nó /review em duas dimensões independentes:
//
//   1. SPEC COMPLIANCE — cada AC ativo da spec (na versão do spec_hash) contra o diff
//      real, mais Restrições, escopo/arquivos, Decisões de Implementação e mudança de
//      comportamento não especificada. Avaliação ESTÁTICA do diff; a de execução é do
//      /test (acceptance-evidence.json). São complementares, não duplicatas.
//   2. ENGINEERING REVIEW — o checklist técnico fixo de 8 itens (CHECKLIST abaixo).
//
// Resultado geral = PASS somente quando as duas dimensões são PASS (N/A conta como
// PASS: task sem spec não tem WHAT a conferir). O agente faz o julgamento; este módulo
// é determinístico (sem LLM) e garante a forma: valida o JSON que o agente preenche,
// aplica as regras de classificação de divergência, calcula os veredictos e
// review_results.failure_origin, e grava state.json + review-result.md + o bloco de
// achados do handoff.md. Matriz da decisão: memory/decisions/2026-09-30-review-duas-dimensoes.md.
//
// Classificação de toda divergência código × spec:
//   IMPLEMENTATION_BUG            o código deveria seguir a spec e não seguiu → reprova.
//   DOCUMENTED_TECHNICAL_DECISION decisão técnica sem efeito funcional → não reprova, SE
//                                 registrada em state.technical_decisions[] (ou no
//                                 technical_decisions[] do spec gate,
//                                 memory/runs/<ticket>-spec-gate.json) com ac + rationale
//                                 + approved_at ISO-8601. Sem registro → reprova como
//                                 UNREGISTERED_TECHNICAL_DECISION. Com
//                                 alters_behavior=true → reprova, reclassificada como
//                                 SPEC_CHANGE_REQUIRED.
//   SPEC_CLARIFICATION            spec ambígua, decisão explicita comportamento
//                                 compatível → não reprova; vai para o Verify
//                                 (spec-authority.js verify avisa REVIEW_SPEC_CLARIFICATION).
//                                 Com alters_behavior=true → SPEC_CHANGE_REQUIRED.
//   (decisões do /implement)      cada TECHNICAL_DECISION / SPEC_CLARIFICATION que o
//                                 /implement gravou em state.technical_decisions[]
//                                 (scripts/lib/spec-change.js) precisa de uma entrada em
//                                 decision_reviews[] (index, alters_behavior, reduces_ac,
//                                 note). TECHNICAL_DECISION que altera comportamento, ou
//                                 SPEC_CLARIFICATION que altera comportamento/reduz AC →
//                                 reprova, reclassificada como SPEC_CHANGE_REQUIRED.
//                                 SPEC_CLARIFICATION confirmada vai para o Verify.
//   SPEC_CHANGE(_REQUIRED)        altera AC, regra de negócio ou restrição funcional →
//                                 sempre reprova no Review. O caminho é mudar a spec com
//                                 aprovação humana (spec_change_approved + spec_change_hash);
//                                 depois disso o código bate com a spec nova e não há
//                                 divergência a classificar.
//
// Uso como CLI (<run-dir> = memory/runs/<task-id>):
//   node scripts/lib/review-result.js spec <run-dir> [--template]
//       Spec conferida pelo spec_hash (ACs ativos, Restrições, escopo, Decisões,
//       technical_decisions registradas). --template imprime o esqueleto do JSON de
//       entrada do `record` com os ACs ativos e os 8 itens já listados.
//   node scripts/lib/review-result.js record <run-dir> --input=<review-input.json>
//       Valida, classifica, grava state.review_results (+ review_verdict, por
//       compatibilidade), review-result.md e o bloco de achados em handoff.md.
//       Não mexe em node/retries/status — a aresta continua sendo do /review.
// exit 0 = PASS, 1 = FAIL (gravado), 2 = uso/entrada inválida (nada gravado),
//      3 = spec drift não autorizado (nada gravado; o portão já pausa o pipeline).

const fs = require('fs');
const path = require('path');
const stateWriter = require('../state-writer');
const sa = require('./spec-authority');
const invalidate = require('../invalidate');
const specVersion = require('./spec-version');
const { isLegacyAcRun } = require('./spec-validator');

const RESULT_FILE = 'review-result.md';
const HANDOFF_START = '<!-- review-findings:inicio -->';
const HANDOFF_END = '<!-- review-findings:fim -->';

// Checklist técnico do Engineering Review — o mesmo de sempre (review.md), numeração
// estável: o bloco pré-montado do orquestrador cita "Item 1"/"Item 3"/"Item 8".
const CHECKLIST = [
    { n: 1, key: 'secrets', label: 'Token/chave exposta em diff? (BITBUCKET_API_TOKEN, REDMINE_API_KEY)' },
    { n: 2, key: 'escopo', label: 'Arquivo fora do escopo da task foi alterado?' },
    { n: 3, key: 'lint', label: 'Lint passa?' },
    { n: 4, key: 'testes_relacionados', label: 'Testes unitários relacionados existentes passam?' },
    { n: 5, key: 'validacao_input', label: 'Novo endpoint tem validação de input?' },
    { n: 6, key: 'logs_sensiveis', label: 'Log de erro expõe dados sensíveis?' },
    { n: 7, key: 'migration_rollback', label: 'Mudança é reversível ou precisa de migration/rollback?' },
    { n: 8, key: 'contrato_openapi', label: 'Endpoint bate com o contrato OpenAPI da task?' },
];

// Validações da Spec Compliance além dos ACs.
const SPEC_CHECKS = [
    { key: 'restricoes', label: 'Restrições da spec respeitadas' },
    { key: 'escopo', label: 'Arquivos/escopo funcional da spec (quando aplicável)' },
    { key: 'decisoes', label: 'Decisões de Implementação coerentes com a spec' },
    { key: 'comportamento_nao_especificado', label: 'Sem alteração comportamental não especificada na spec' },
];

const CLASSIFICATIONS = ['IMPLEMENTATION_BUG', 'DOCUMENTED_TECHNICAL_DECISION', 'SPEC_CLARIFICATION', 'SPEC_CHANGE', 'SPEC_CHANGE_REQUIRED'];
// Categorias que reprovam (as duas últimas só surgem por reclassificação).
const FAILING = new Set(['IMPLEMENTATION_BUG', 'SPEC_CHANGE_REQUIRED', 'UNREGISTERED_TECHNICAL_DECISION']);
const AC_RESULTS = new Set(['PASS', 'FAIL', 'N/A']);
// Classificações do /implement que o Review confere (scripts/lib/spec-change.js).
const REVIEWED_DECISION_TYPES = new Set(['TECHNICAL_DECISION', 'SPEC_CLARIFICATION']);
const ITEM_RESULTS = new Set(['PASS', 'FAIL', 'N/A']);
// "Ação esperada" tem que dizer o quê e onde — nunca só "corrigir lógica".
const GENERIC_ACTION = /^(corrigir|ajustar|melhorar|revisar|arrumar|refatorar|verificar|consertar)\s*(a |o |os |as )?(logica|codigo|implementacao|problema|bug|erro|comportamento|teste|testes)?\.?$/;
const MIN_ACTION_CHARS = 20;

function norm(text) {
    return String(text ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
}

function nonEmpty(v) {
    return typeof v === 'string' && v.trim().length > 0;
}

function canonAc(id) {
    const m = /^AC-?(\d+)$/i.exec(String(id || '').trim());
    return m ? `AC-${m[1].padStart(2, '0')}` : null;
}

function isIso(v) {
    return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(v) && Number.isFinite(Date.parse(v));
}

// ── Decisões técnicas registradas ────────────────────────────────────────────────

/**
 * technical_decisions válidas: state.technical_decisions[] + technical_decisions[] do
 * spec gate. Válida = ac canônico + rationale + approved_at ISO-8601.
 * @returns {{valid: object[], invalid: {source, index, reason}[]}}
 */
function registeredDecisions(state, gate) {
    const valid = [];
    const invalid = [];
    const scan = (list, source) => {
        if (!Array.isArray(list)) return;
        list.forEach((d, index) => {
            // Entradas tipadas do /implement (spec-change.js): só TECHNICAL_DECISION com ac
            // sustenta DOCUMENTED_TECHNICAL_DECISION; as demais são conferidas em
            // decision_reviews[] e não contam como registro inválido.
            if (d?.type && (d.type !== 'TECHNICAL_DECISION' || d.ac == null)) return;
            const ac = canonAc(d?.ac);
            if (!ac) invalid.push({ source, index, reason: `ac ausente/inválido (${JSON.stringify(d?.ac ?? null)})` });
            else if (!nonEmpty(d.rationale)) invalid.push({ source, index, reason: 'rationale vazio' });
            else if (!isIso(d.approved_at)) invalid.push({ source, index, reason: `approved_at não é ISO-8601 (${JSON.stringify(d.approved_at ?? null)})` });
            else valid.push({ ...d, ac, source });
        });
    };
    scan(state?.technical_decisions, 'state.json');
    scan(gate?.technical_decisions, 'spec-gate');
    return { valid, invalid };
}

/** Decisões tipadas do /implement a conferir: [{index, type, description, ac}]. */
function implementDecisions(state) {
    return (Array.isArray(state?.technical_decisions) ? state.technical_decisions : [])
        .map((d, index) => ({ index, type: d?.type, description: d?.description, ac: d?.ac || d?.ac_affected?.[0] || null, rationale: d?.rationale }))
        .filter(d => REVIEWED_DECISION_TYPES.has(d.type));
}

// ── Avaliação (pura) ─────────────────────────────────────────────────────────────

/**
 * Valida a entrada do agente e calcula o resultado. Sem I/O.
 * @param {object} input JSON preenchido pelo agente (formato: `spec --template`).
 * @param {{activeAcs: string[], knownAcs?: string[], specApplies: boolean,
 *   decisions: object[]}} ctx
 * @returns {{errors: string[], result: object|null}} errors = entrada inválida (nada
 *   deve ser gravado); result = review_results pronto pra gravar.
 */
function evaluate(input, ctx) {
    const errors = [];
    const err = m => errors.push(m);
    if (!input || typeof input !== 'object') return { errors: ['entrada não é um objeto JSON'], result: null };
    const activeAcs = ctx.activeAcs || [];
    const known = new Set(ctx.knownAcs || activeAcs);

    // ── Dimensão 1: Spec Compliance ──
    const sc = input.spec_compliance || {};
    const acs = {};
    const acList = Array.isArray(sc.acs) ? sc.acs : [];
    for (const [i, a] of acList.entries()) {
        const id = canonAc(a?.id);
        if (!id) { err(`spec_compliance.acs[${i}]: id inválido (${JSON.stringify(a?.id ?? null)})`); continue; }
        if (!known.has(id)) { err(`spec_compliance.acs[${i}]: ${id} não existe na spec`); continue; }
        if (!activeAcs.includes(id)) { err(`spec_compliance.acs[${i}]: ${id} foi removido da spec — não avalie AC removido`); continue; }
        if (acs[id]) { err(`spec_compliance.acs: ${id} avaliado mais de uma vez`); continue; }
        const result = String(a.result || '').toUpperCase();
        if (!AC_RESULTS.has(result)) { err(`${id}: result deve ser PASS, FAIL ou N/A (veio ${JSON.stringify(a.result ?? null)})`); continue; }
        if (result === 'PASS' && !nonEmpty(a.evidence)) err(`${id}: PASS sem evidência (arquivo:linha do diff que atende o AC)`);
        if (result !== 'PASS' && !nonEmpty(a.reason)) err(`${id}: ${result} sem motivo`);
        acs[id] = result === 'PASS' ? { result, evidence: a.evidence.trim() } : { result, reason: String(a.reason || '').trim() };
    }
    if (ctx.specApplies) {
        const missing = activeAcs.filter(id => !acs[id]);
        if (missing.length) err(`spec_compliance.acs: faltam ACs ativos da spec: ${missing.join(', ')} (avalie todos — N/A com motivo se não se aplica ao diff)`);
    }

    const checks = {};
    for (const c of SPEC_CHECKS) {
        const v = sc.checks?.[c.key];
        if (!ctx.specApplies && v == null) { checks[c.key] = { result: 'N/A', note: 'task sem spec' }; continue; }
        const result = String(v?.result || '').toUpperCase();
        if (!ITEM_RESULTS.has(result)) { err(`spec_compliance.checks.${c.key}: result deve ser PASS, FAIL ou N/A`); continue; }
        if (!nonEmpty(v.note)) err(`spec_compliance.checks.${c.key}: note vazio — diga o que foi conferido`);
        checks[c.key] = { result, note: String(v.note || '').trim() };
    }

    // ── Divergências código × spec ──
    const decisions = ctx.decisions || [];
    const divergences = [];
    for (const [i, d] of (Array.isArray(input.divergences) ? input.divergences : []).entries()) {
        const where = `divergences[${i}]`;
        const declared = String(d?.classification || '').toUpperCase();
        if (!CLASSIFICATIONS.includes(declared)) { err(`${where}: classification deve ser uma de ${CLASSIFICATIONS.join(' | ')}`); continue; }
        const ac = d.ac == null || d.ac === '' ? null : canonAc(d.ac);
        if (d.ac != null && d.ac !== '' && (!ac || !known.has(ac))) { err(`${where}: ac ${JSON.stringify(d.ac)} não existe na spec`); continue; }
        if (!nonEmpty(d.summary)) err(`${where}: summary vazio`);
        const out = {
            classification: declared === 'SPEC_CHANGE' ? 'SPEC_CHANGE_REQUIRED' : declared,
            declared_classification: declared,
            ac, summary: String(d.summary || '').trim(),
            file: nonEmpty(d.file) ? d.file.trim() : null,
            line: Number.isInteger(d.line) && d.line > 0 ? d.line : null,
            expected: String(d.expected || '').trim(), found: String(d.found || '').trim(),
            action: String(d.action || '').trim(),
            alters_behavior: d.alters_behavior === true,
        };
        if (d.line != null && out.line == null) err(`${where}: line deve ser inteiro positivo (ou omitido quando não identificável)`);
        if (out.alters_behavior && (out.classification === 'DOCUMENTED_TECHNICAL_DECISION' || out.classification === 'SPEC_CLARIFICATION')) {
            out.reclassified_reason = `classificada como ${declared}, mas altera comportamento funcional — toda mudança de AC, regra de negócio ou restrição é SPEC_CHANGE`;
            out.classification = 'SPEC_CHANGE_REQUIRED';
        } else if (out.classification === 'DOCUMENTED_TECHNICAL_DECISION') {
            const match = ac && decisions.find(x => x.ac === ac);
            if (!ac) err(`${where}: DOCUMENTED_TECHNICAL_DECISION precisa do ac (é por ele que a decisão registrada é localizada)`);
            else if (!match) {
                out.reclassified_reason = `nenhuma decisão registrada para ${ac} em state.technical_decisions[] (ou no spec gate) com rationale + approved_at`;
                out.classification = 'UNREGISTERED_TECHNICAL_DECISION';
            } else {
                out.decision = { ac: match.ac, rationale: match.rationale, approved_at: match.approved_at, source: match.source };
            }
        }
        if (FAILING.has(out.classification)) {
            for (const f of ['expected', 'found', 'action']) if (!out[f]) err(`${where}: ${f} vazio — obrigatório em divergência que reprova`);
            if (out.action && (out.action.length < MIN_ACTION_CHARS || GENERIC_ACTION.test(norm(out.action)))) {
                err(`${where}: action genérica ("${out.action}") — diga o que mudar e onde (método, condição, valor), nunca "corrigir lógica"`);
            }
            if (!ac && !out.file) err(`${where}: divergência que reprova precisa de ac ou file`);
        }
        divergences.push(out);
    }
    // ── Classificação das decisões do /implement ──
    const decisionReviews = [];
    const reviewed = Array.isArray(input.decision_reviews) ? input.decision_reviews : [];
    for (const dec of ctx.implementDecisions || []) {
        const where = `decision_reviews[index=${dec.index}]`;
        const r = reviewed.find(x => Number(x?.index) === dec.index);
        if (!r) { err(`decision_reviews: falta conferir a decisão ${dec.index} do /implement (${dec.type}: "${String(dec.description || '').slice(0, 80)}") — diga se altera comportamento (alters_behavior) e se reduz AC (reduces_ac)`); continue; }
        if (typeof r.alters_behavior !== 'boolean' || typeof r.reduces_ac !== 'boolean') { err(`${where}: alters_behavior e reduces_ac precisam ser true/false`); continue; }
        if (!nonEmpty(r.note)) { err(`${where}: note vazio — diga o que no diff confirma (ou desmente) a classificação`); continue; }
        const wrong = r.alters_behavior || r.reduces_ac;
        const out = {
            index: dec.index, type: dec.type, description: String(dec.description || ''), ac: dec.ac ? canonAc(dec.ac) : null,
            alters_behavior: r.alters_behavior, reduces_ac: r.reduces_ac, note: r.note.trim(),
            verdict: wrong ? 'SPEC_CHANGE_REQUIRED' : 'CONFIRMED',
        };
        decisionReviews.push(out);
        if (!wrong) continue;
        const why = [r.alters_behavior && 'altera comportamento funcional', r.reduces_ac && 'reduz AC'].filter(Boolean).join(' e ');
        out.reclassified_reason = `classificada pelo /implement como ${dec.type}, mas ${why} — isso é SPEC_CHANGE e exige aprovação humana`;
        divergences.push({
            classification: 'SPEC_CHANGE_REQUIRED', declared_classification: dec.type,
            ac: out.ac && known.has(out.ac) ? out.ac : null,
            summary: `Decisão do /implement "${out.description}" classificada como ${dec.type} indevidamente`,
            file: nonEmpty(r.file) ? r.file.trim() : null,
            line: Number.isInteger(r.line) && r.line > 0 ? r.line : null,
            expected: `${dec.type === 'SPEC_CLARIFICATION' ? 'Esclarecimento compatível com a spec, sem reduzir AC' : 'Decisão técnica sem efeito no comportamento observável'}${out.ac ? ` (${out.ac} como a spec diz)` : ''}`,
            found: out.note,
            action: `Implemente ${out.ac || 'o critério'} exatamente como a spec diz, ou registre a decisão como SPEC_CHANGE (node scripts/lib/spec-change.js record) para aprovação humana`,
            alters_behavior: true, reclassified_reason: out.reclassified_reason,
        });
    }

    const failingDivs = divergences.filter(d => FAILING.has(d.classification));
    // AC reprovado / check reprovado sem divergência estruturada = handoff sem o que corrigir.
    for (const [id, a] of Object.entries(acs)) {
        if (a.result === 'FAIL' && !failingDivs.some(d => d.ac === id)) {
            err(`${id}: FAIL sem divergência correspondente em divergences[] (IMPLEMENTATION_BUG ou SPEC_CHANGE com ac=${id}) — o handoff precisa de esperado/encontrado/ação`);
        }
    }
    const failedChecks = SPEC_CHECKS.filter(c => checks[c.key]?.result === 'FAIL').map(c => c.key);
    if (failedChecks.length && !failingDivs.length) {
        err(`spec_compliance.checks ${failedChecks.join(', ')} FAIL sem nenhuma divergência que reprova em divergences[]`);
    }

    const specFailed = Object.values(acs).some(a => a.result === 'FAIL') || failedChecks.length > 0 || failingDivs.length > 0;
    const specVerdict = !ctx.specApplies && !divergences.length ? 'N/A' : (specFailed ? 'FAIL' : 'PASS');

    // ── Dimensão 2: Engineering Review ──
    const eng = input.engineering || {};
    const items = {};
    const rawItems = Array.isArray(eng.items) ? eng.items : [];
    for (const c of CHECKLIST) {
        const v = rawItems.find(x => Number(x?.n) === c.n);
        if (!v) { err(`engineering.items: falta o item ${c.n} (${c.label})`); continue; }
        const result = String(v.result || '').toUpperCase();
        if (!ITEM_RESULTS.has(result)) { err(`engineering.items[${c.n}]: result deve ser PASS, FAIL ou N/A`); continue; }
        if (!nonEmpty(v.note)) err(`engineering.items[${c.n}]: note vazio — diga o que foi conferido (ou por que N/A)`);
        items[c.n] = { result, note: String(v.note || '').trim() };
    }
    const findings = [];
    for (const [i, f] of (Array.isArray(eng.findings) ? eng.findings : []).entries()) {
        const where = `engineering.findings[${i}]`;
        const n = Number(f?.item);
        if (!CHECKLIST.some(c => c.n === n)) { err(`${where}: item deve ser 1..8`); continue; }
        const out = {
            category: 'ENGINEERING', item: n,
            ac: f.ac ? canonAc(f.ac) : null,
            file: nonEmpty(f.file) ? f.file.trim() : null,
            line: Number.isInteger(f.line) && f.line > 0 ? f.line : null,
            expected: String(f.expected || '').trim(), found: String(f.found || '').trim(), action: String(f.action || '').trim(),
        };
        for (const k of ['expected', 'found', 'action']) if (!out[k]) err(`${where}: ${k} vazio`);
        if (!out.file) err(`${where}: file vazio — achado de engenharia aponta arquivo`);
        if (out.action && (out.action.length < MIN_ACTION_CHARS || GENERIC_ACTION.test(norm(out.action)))) {
            err(`${where}: action genérica ("${out.action}") — diga o que mudar e onde`);
        }
        if (items[n] && items[n].result !== 'FAIL') err(`${where}: achado no item ${n}, mas o item está ${items[n].result}`);
        findings.push(out);
    }
    for (const c of CHECKLIST) {
        if (items[c.n]?.result === 'FAIL' && !findings.some(f => f.item === c.n)) err(`engineering.items[${c.n}]: FAIL sem achado em engineering.findings[] (arquivo, esperado, encontrado, ação)`);
    }
    const engVerdict = Object.values(items).some(i => i.result === 'FAIL') ? 'FAIL' : 'PASS';

    if (errors.length) return { errors, result: null };

    const specFail = specVerdict === 'FAIL';
    const engFail = engVerdict === 'FAIL';
    const failureOrigin = specFail && engFail ? 'both' : specFail ? 'spec_compliance' : engFail ? 'engineering' : null;
    const handoffFindings = [
        ...failingDivs.map(d => ({
            category: d.classification, ac: d.ac, file: d.file, line: d.line,
            expected: d.expected, found: d.found, action: d.action,
            ...(d.reclassified_reason ? { note: d.reclassified_reason } : {}),
        })),
        ...findings,
    ];
    return {
        errors: [],
        result: {
            verdict: specFail || engFail ? 'FAIL' : 'PASS',
            failure_origin: failureOrigin,
            spec_compliance: { verdict: specVerdict, acs, checks },
            engineering: { verdict: engVerdict, items },
            divergences,
            findings: handoffFindings,
            spec_clarifications: [
                ...divergences.filter(d => d.classification === 'SPEC_CLARIFICATION')
                    .map(d => ({ ac: d.ac, summary: d.summary, file: d.file, line: d.line })),
                ...decisionReviews.filter(d => d.type === 'SPEC_CLARIFICATION' && d.verdict === 'CONFIRMED')
                    .map(d => ({ ac: d.ac, summary: `${d.description} (esclarecimento registrado pelo /implement, confirmado pelo Review: ${d.note})`, file: null, line: null, source: 'implement' })),
            ],
            decision_reviews: decisionReviews,
            technical_decisions_applied: divergences.filter(d => d.classification === 'DOCUMENTED_TECHNICAL_DECISION')
                .map(d => ({ ac: d.ac, summary: d.summary, approved_at: d.decision.approved_at, source: d.decision.source })),
            observations: (Array.isArray(input.observations) ? input.observations : []).filter(nonEmpty).map(s => s.trim()),
        },
    };
}

// ── Renderização ─────────────────────────────────────────────────────────────────

function loc(f) {
    return f.file ? `${f.file}${f.line ? `:${f.line}` : ''}` : 'não identificável';
}

function renderFinding(f, i) {
    const head = f.category === 'ENGINEERING'
        ? `ENGINEERING (item ${f.item} — ${CHECKLIST.find(c => c.n === f.item).label})`
        : f.category;
    return [
        `### ${i + 1}. ${head}`,
        `- Categoria: ${f.category === 'ENGINEERING' ? `ENGINEERING · item ${f.item}` : f.category}`,
        `- AC afetado: ${f.ac || '—'}`,
        `- Arquivo e linha: ${loc(f)}`,
        `- Comportamento esperado: ${f.expected}`,
        `- Comportamento encontrado: ${f.found}`,
        `- Ação esperada: ${f.action}`,
        ...(f.note ? [`- Nota do Review: ${f.note}`] : []),
    ].join('\n');
}

function renderResult(r, { taskId, specPath, specHash, specVersionNo = null, round }) {
    const L = [
        `# Review — ${taskId} (rodada ${round})`,
        '',
        `Spec: \`${specPath || '—'}\`${specVersionNo != null ? ` · spec_version ${specVersionNo}` : ''}${specHash ? ` · spec_hash \`${specHash.slice(0, 12)}\`` : ''}`,
        '',
        `- Spec Compliance: **${r.spec_compliance.verdict}**`,
        `- Engineering Review: **${r.engineering.verdict}**`,
        `- Resultado geral: **${r.verdict}**${r.failure_origin ? ` (failure_origin: ${r.failure_origin})` : ''}`,
        '',
        '## Spec Compliance',
        '',
    ];
    const acIds = Object.keys(r.spec_compliance.acs);
    if (!acIds.length) L.push('- (sem ACs a avaliar — task sem spec ou spec legada sem IDs)');
    for (const id of acIds) {
        const a = r.spec_compliance.acs[id];
        L.push(a.result === 'PASS' ? `- ${id} — PASS | Evidência: ${a.evidence}` : `- ${id} — ${a.result} | Motivo: ${a.reason}`);
    }
    L.push('');
    for (const c of SPEC_CHECKS) {
        const v = r.spec_compliance.checks[c.key];
        if (v) L.push(`- [${v.result}] ${c.label} — ${v.note}`);
    }
    L.push('', '### Divergências código × spec', '');
    if (!r.divergences.length) L.push('- nenhuma');
    for (const d of r.divergences) {
        const reclass = d.declared_classification !== d.classification && !(d.declared_classification === 'SPEC_CHANGE' && d.classification === 'SPEC_CHANGE_REQUIRED')
            ? ` (declarada ${d.declared_classification}: ${d.reclassified_reason})` : '';
        const dec = d.decision ? ` — decisão registrada (${d.decision.source}, ${d.decision.approved_at}): ${d.decision.rationale}` : '';
        L.push(`- **${d.classification}**${d.ac ? ` · ${d.ac}` : ''} · ${loc(d)} — ${d.summary}${reclass}${dec}`);
    }
    if (r.decision_reviews?.length) {
        L.push('', '### Decisões do /implement (classificação conferida)', '');
        for (const d of r.decision_reviews) {
            L.push(`- [${d.verdict}] ${d.type}${d.ac ? ` · ${d.ac}` : ''} — ${d.description} — ${d.note}${d.reclassified_reason ? ` (${d.reclassified_reason})` : ''}`);
        }
    }
    L.push('', '## Engineering Review', '');
    for (const c of CHECKLIST) {
        const v = r.engineering.items[c.n];
        L.push(`- [${v.result}] ${c.n}. ${c.label} — ${v.note}`);
    }
    if (r.findings.length) L.push('', '## Achados que reprovam', '', ...r.findings.map(renderFinding).join('\n\n').split('\n'));
    if (r.spec_clarifications.length) {
        L.push('', '## Esclarecimentos de spec (seguem para o Verify)', '',
            ...r.spec_clarifications.map(c => `- ${c.ac || '—'} · ${loc(c)} — ${c.summary}`));
    }
    if (r.observations.length) L.push('', '## Observações (não reprovam)', '', ...r.observations.map(o => `- ${o}`));
    return L.join('\n') + '\n';
}

/** Bloco de handoff: achados estruturados (reprovação) e esclarecimentos (sempre). */
function renderHandoffBlock(r) {
    const L = [HANDOFF_START];
    if (r.verdict === 'FAIL') {
        L.push(`## Achados do Review — REPROVADO (failure_origin: ${r.failure_origin})`, '',
            'Critério de aceite desta correção: cada item abaixo resolvido. Detalhe em review-result.md.', '',
            ...r.findings.map(renderFinding).join('\n\n').split('\n'));
    } else {
        L.push('## Review — APROVADO', '', `Spec Compliance ${r.spec_compliance.verdict} · Engineering Review ${r.engineering.verdict}.`);
    }
    if (r.spec_clarifications.length) {
        L.push('', '### Esclarecimentos de spec (para o Verify)', '',
            ...r.spec_clarifications.map(c => `- ${c.ac || '—'} · ${loc(c)} — ${c.summary}`));
    }
    L.push(HANDOFF_END);
    return L.join('\n');
}

function upsertHandoffBlock(content, block) {
    const base = content || '';
    const start = base.indexOf(HANDOFF_START);
    const end = base.indexOf(HANDOFF_END);
    if (start !== -1 && end > start) return base.slice(0, start) + block + base.slice(end + HANDOFF_END.length);
    return `${base.replace(/\s*$/, '')}${base.trim() ? '\n\n' : ''}${block}\n`;
}

// ── I/O ──────────────────────────────────────────────────────────────────────────

function readJson(file) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function writeState(runDir, state) {
    stateWriter.write(runDir, state, { operation: 'review_result', actor: 'agent' });
}

/** Spec gate do ticket: <raiz>/memory/runs/<ticket>-spec-gate.json (vizinho do run). */
function readGate(runDir, state) {
    const ticket = state?.redmine_ticket?.id;
    if (ticket == null) return null;
    return readJson(path.join(path.dirname(path.resolve(runDir)), `${ticket}-spec-gate.json`));
}

/** Contexto do review lido do run: spec na versão do spec_hash, ACs, decisões. */
function loadContext(runDir) {
    const state = readJson(path.join(runDir, 'state.json'));
    if (!state) return { error: `${runDir}: state.json ausente ou ilegível` };
    const root = sa.rootOfRunDir(path.resolve(runDir));
    const taskId = state.task_id || path.basename(path.resolve(runDir));
    const drift = sa.checkDrift(state, { root, taskId });
    const specContent = drift.status === 'no_spec' ? null : sa.readSpec(root, drift.specPath);
    const parsed = specContent ? sa.specAcs(specContent) : { hasSection: false, hasIds: false, acs: [] };
    const legacy = specContent && !parsed.hasIds && isLegacyAcRun(state);
    const decisions = registeredDecisions(state, readGate(runDir, state));
    return {
        state, root, taskId, drift, specContent, legacy, runDir: path.resolve(runDir),
        specApplies: !!specContent && parsed.hasIds,
        activeAcs: parsed.acs.filter(a => a.active).map(a => a.id),
        knownAcs: parsed.acs.map(a => a.id),
        acs: parsed.acs, decisions,
        implementDecisions: implementDecisions(state),
    };
}

function template(ctx) {
    return {
        spec_compliance: {
            acs: ctx.activeAcs.map(id => ({ id, result: 'PASS | FAIL | N/A', evidence: '<arquivo:linha do diff> (PASS)', reason: '<motivo> (FAIL/N/A)' })),
            checks: Object.fromEntries(SPEC_CHECKS.map(c => [c.key, { result: 'PASS | FAIL | N/A', note: c.label }])),
        },
        divergences: [{
            classification: CLASSIFICATIONS.slice(0, 4).join(' | '),
            ac: 'AC-XX (ou omitir)', file: '<caminho>', line: 0, alters_behavior: false,
            summary: '<a divergência em uma frase>', expected: '<da spec>', found: '<no diff>', action: '<o que mudar e onde>',
        }],
        engineering: {
            items: CHECKLIST.map(c => ({ n: c.n, result: 'PASS | FAIL | N/A', note: c.label })),
            findings: [{ item: 0, file: '<caminho>', line: 0, expected: '...', found: '...', action: '...' }],
        },
        ...(ctx.implementDecisions?.length ? {
            decision_reviews: ctx.implementDecisions.map(d => ({
                index: d.index, type: d.type, description: d.description,
                alters_behavior: false, reduces_ac: false, note: '<o que no diff confirma (ou desmente) a classificação>',
            })),
        } : {}),
        observations: [],
    };
}

function printSpec(ctx) {
    const { drift, specContent } = ctx;
    const out = [];
    out.push(`Spec: ${drift.specPath}`);
    out.push(`spec_hash: ${drift.currentHash || '—'} (${drift.reason})`);
    const stamp = specVersion.stampFor(ctx.state, drift.currentHash);
    if (stamp.spec_version != null) out.push(`spec_version: ${stamp.spec_version}`);
    if (stamp.mismatch) out.push(`ALERTA ${stamp.message}`);
    // Validade do implement (scripts/invalidate.js): alerta, nunca bloqueia.
    const impl = invalidate.guardReview(ctx.state, { runDir: ctx.runDir });
    if (impl.alert) out.push(`ALERTA ${impl.alert} (não bloqueia o Review; voltar ao Plan é decisão da governança de SPEC_CHANGE)`);
    if (!specContent) {
        out.push('Task sem spec: Spec Compliance = N/A (não há WHAT a conferir). Avalie só o Engineering Review.');
        return out.join('\n');
    }
    if (ctx.legacy) out.push('Spec legada sem IDs AC-XX (run anterior aos IDs): avalie os critérios pelo texto em divergences[]; spec_compliance.acs fica vazio.');
    out.push('', '## ACs ativos (avalie todos)');
    for (const a of ctx.acs) out.push(`- ${a.id}${a.active ? '' : ' (REMOVIDO — não avaliar)'}: ${a.head}`);
    for (const [title, re] of [['Restrições', /^restric/], ['Escopo', /^escopo\b/], ['Fora de escopo', /^fora de escopo\b/], ['Arquivos Afetados', /^arquivos afetados\b/], ['Decisões de Implementação', /^decisoes de implementacao\b/]]) {
        const body = sa.sectionText(specContent, re);
        if (body != null && body.trim()) out.push('', `## ${title}`, body.trim());
    }
    out.push('', '## Decisões técnicas registradas (state.technical_decisions[] / spec gate)');
    if (!ctx.decisions.valid.length) out.push('- nenhuma — DOCUMENTED_TECHNICAL_DECISION sem registro reprova como UNREGISTERED_TECHNICAL_DECISION');
    for (const d of ctx.decisions.valid) out.push(`- ${d.ac} (${d.source}, ${d.approved_at}): ${d.rationale}`);
    for (const d of ctx.decisions.invalid) out.push(`- [INVÁLIDA, ignorada] ${d.source}[${d.index}]: ${d.reason}`);
    if (ctx.implementDecisions?.length) {
        out.push('', '## Decisões classificadas pelo /implement (confira cada uma em decision_reviews[])');
        for (const d of ctx.implementDecisions) out.push(`- [${d.index}] ${d.type}${d.ac ? ` · ${d.ac}` : ''}: ${d.description} — motivo: ${d.rationale}`);
    }
    return out.join('\n');
}

/** Grava o resultado no run. Retorna o review_results gravado. */
function record(runDir, ctx, result, now = new Date().toISOString()) {
    const state = readJson(path.join(runDir, 'state.json')) || ctx.state;
    const round = (Number(state.retries?.review) || 0) + 1;
    // spec_version só quando o hash avaliado é o da versão vigente; senão é SPEC_CHANGE
    // mid-run: grava null e alerta (evento + stderr), nunca silencia.
    const stamp = specVersion.stampFor(state, ctx.drift.currentHash || null);
    if (stamp.mismatch) {
        console.error(`[review-result] ALERTA ${stamp.message}`);
        state.events = Array.isArray(state.events) ? state.events : [];
        state.events.push({ ts: now, at: now, type: 'spec_change_mid_run', node: 'review', detail: stamp.message });
    }
    const impl = invalidate.guardReview(state, { runDir });
    if (impl.alert) console.error(`[review-result] ALERTA ${impl.alert}`);
    const prevHistory = Array.isArray(state.review_results?.history) ? state.review_results.history : [];
    const review = {
        ...result,
        reviewed_at: now,
        round,
        spec_path: ctx.specContent ? ctx.drift.specPath : null,
        spec_hash: ctx.drift.currentHash || null,
        spec_version: ctx.specContent ? stamp.spec_version : null,
        // Implement de outra versão (STALE) ou sem versão (UNKNOWN): o Review segue, mas a
        // compliance não comprova a spec atual — chega ao Verify como aviso.
        implement_validity: { status: impl.status, alert: impl.alert },
        compliance_valid: impl.compliance_valid,
        // Uma linha por rodada: é daqui que o memory-consolidator lê a origem dos loops.
        history: [...prevHistory, { round, reviewed_at: now, verdict: result.verdict, failure_origin: result.failure_origin }],
    };
    state.review_results = review;
    if (review.spec_hash) invalidate.stampProduced(state, 'review', { specHash: review.spec_hash, specVersion: review.spec_version, at: now, runDir });
    state.review_verdict = result.verdict === 'PASS' ? 'aprovado' : `reprovado (${result.failure_origin})`;
    state.updated_at = now;
    writeState(runDir, state);
    fs.writeFileSync(path.join(runDir, RESULT_FILE), renderResult(review, { taskId: ctx.taskId, specPath: review.spec_path, specHash: review.spec_hash, specVersionNo: review.spec_version, round }));
    const handoffPath = path.join(runDir, 'handoff.md');
    const handoff = fs.existsSync(handoffPath) ? fs.readFileSync(handoffPath, 'utf8') : '';
    fs.writeFileSync(handoffPath, upsertHandoffBlock(handoff, renderHandoffBlock(review)));
    return review;
}

module.exports = {
    evaluate, registeredDecisions, implementDecisions, renderResult, renderHandoffBlock, upsertHandoffBlock,
    loadContext, record, template, CHECKLIST, SPEC_CHECKS, CLASSIFICATIONS, RESULT_FILE,
    HANDOFF_START, HANDOFF_END,
};

if (require.main === module) {
    const args = process.argv.slice(2);
    const flag = name => { const a = args.find(x => x === `--${name}` || x.startsWith(`--${name}=`)); return a === undefined ? undefined : (a.includes('=') ? a.split('=').slice(1).join('=') : true); };
    const [cmd, target] = args.filter(a => !a.startsWith('--'));
    const usage = () => {
        console.error('Uso: node scripts/lib/review-result.js spec <run-dir> [--template] | record <run-dir> --input=<review-input.json>');
        process.exit(2);
    };
    if (!cmd || !target || !['spec', 'record'].includes(cmd)) usage();
    const ctx = loadContext(target);
    if (ctx.error) { console.error(ctx.error); process.exit(2); }
    if (!ctx.drift.ok) {
        console.error(`[review-result] SPEC DRIFT — ${ctx.drift.reason}. Nada avaliado/gravado; rode o portão (spec-authority.js check --node=review --write).`);
        process.exit(3);
    }
    if (cmd === 'spec') {
        console.log(printSpec(ctx));
        if (flag('template')) console.log(`\n## Esqueleto de --input (preencha e grave em memory/runs/<task-id>/review-input.json)\n${JSON.stringify(template(ctx), null, 2)}`);
        process.exit(0);
    }
    const inputFile = flag('input');
    if (typeof inputFile !== 'string') usage();
    const input = readJson(inputFile);
    if (!input) { console.error(`${inputFile}: JSON ausente ou inválido`); process.exit(2); }
    const { errors, result } = evaluate(input, {
        activeAcs: ctx.activeAcs, knownAcs: ctx.knownAcs, specApplies: ctx.specApplies, decisions: ctx.decisions.valid,
        implementDecisions: ctx.implementDecisions,
    });
    if (errors.length) {
        console.error(`[review-result] entrada inválida — nada gravado. Corrija ${inputFile} e rode de novo:`);
        for (const e of errors) console.error(`- ${e}`);
        process.exit(2);
    }
    const review = record(target, ctx, result);
    console.log(`Spec Compliance: ${review.spec_compliance.verdict}`);
    console.log(`Engineering Review: ${review.engineering.verdict}`);
    console.log(`Resultado geral: ${review.verdict}${review.failure_origin ? ` (failure_origin: ${review.failure_origin})` : ''}`);
    console.log(`Gravado: state.json.review_results, ${RESULT_FILE}, bloco de achados em handoff.md.`);
    process.exit(review.verdict === 'PASS' ? 0 : 1);
}
