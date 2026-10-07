// SPEC = WHAT | PLAN = HOW. A spec da task (memory/spec/<ticket>-spec.md) é a fonte
// autoritativa de Critérios de Aceite, restrições funcionais, comportamento esperado e
// escopo funcional. Plan, handoff e context referenciam — nunca redefinem. Matriz
// completa de autoridade: memory/decisions/2026-09-30-spec-what-plan-how.md.
//
// Este módulo faz, sem LLM (determinístico, barato, roda a cada tick):
//
// 1. Proteção contra drift (spec_hash). O /plan lê a spec e grava o SHA-256 da parte
//    normativa dela em state.json.spec_hash (`baseline`). Antes de implement/review/
//    test/verify, o hash atual é comparado com o salvo (`check`; o watcher faz o mesmo
//    em runSpecDriftGate antes de despachar):
//      igual                                             → segue
//      diferente + spec_change_approved === true
//                + spec_change_hash === hash atual       → segue (mudança aprovada)
//      qualquer outro caso                               → drift não autorizado:
//        status="spec-drift", state.spec_drift com o motivo, evento spec_drift. Pausa.
//    Qual hash: run VERSIONADO (state.spec — scripts/lib/spec-version.js) usa o hash
//    contratual do HASH_SCOPE (.claude/spec-hash-config.json, scripts/lib/spec-hash.js:
//    só ACs, Objetivo, Escopo, Regras, Solução, Restrições; contexto, comentário e
//    espaço não contam). Run LEGADO (sem state.spec) mantém o algoritmo antigo, para não
//    entrar em drift por troca de algoritmo: parte normativa = arquivo inteiro menos
//    "## Decisões de Implementação" e "## Contexto Histórico" (APPEND de ferramenta),
//    comentários HTML e espaço no fim da linha. specHashFor(state, conteúdo) escolhe.
//    O baseline também sela a spec_version (spec-version.js onBaseline) e a aprovação
//    manual de drift incrementa a versão (bump) quando o contrato mudou.
//
// 2. Conformidade do Verify (`verify`). Falha se: spec com drift não autorizado; AC
//    ativo da spec sem evidência conferida em acceptance-evidence.json (matriz do /test,
//    artefatos checados no disco — ver scripts/lib/acceptance-evidence.js; run anterior
//    a ACCEPTANCE_EVIDENCE_REQUIRED_SINCE só com o ac-evidence.md antigo tem evidence
//    UNKNOWN — sem identidade de spec: UNKNOWN não é FAIL de teste, mas não comprova a
//    spec atual, então o Verify reprova (EVIDENCE_SPEC_UNKNOWN, fail-closed —
//    scripts/invalidate.js); transição de contrato pendente também reprova
//    (PENDING_SPEC_INVALIDATION)); Plan (plan.md) omite AC ou
//    cita/redefine AC que a spec não tem; handoff diverge da spec (referência de spec
//    errada/ausente, lista de ACs diferente, texto de AC reescrito); decisão de
//    implementação desta task altera critério sem SPEC_CHANGE aprovado. Do último Review
//    (state.review_results, scripts/lib/review-result.js), os
//    SPEC_CLARIFICATION e as decisões técnicas aceitas pelo Review viram aviso
//    (REVIEW_SPEC_CLARIFICATION / REVIEW_TECHNICAL_DECISION) — chegam ao Verify —, assim
//    como Review reprovado/spec_hash defasado (REVIEW_NOT_PASSED / REVIEW_SPEC_HASH_STALE).
//    SPEC_CHANGE do /implement (scripts/lib/spec-change.js) pendente/rejeitada e
//    artefato ainda stale depois da aprovação reprovam (SPEC_CHANGE_PENDING /
//    SPEC_CHANGE_REJECTED / STALE_ARTIFACTS).
//
// AC "ativo" = critério da spec sem a marca "(removido em <data>: motivo)" (ver
// scripts/lib/ac-ids.js — ID removido nunca é apagado nem reaproveitado).
//
// Uso como CLI (<run-dir> = memory/runs/<task-id>; a raiz do repo é ../../.. dele):
//   node scripts/lib/spec-authority.js hash <spec.md> [--run=<run-dir>] [--legacy]
//       sem --run: hash contratual do escopo atual; --run: o algoritmo daquele run.
//   node scripts/lib/spec-authority.js baseline <run-dir> [--by=<nó>]
//   node scripts/lib/spec-authority.js check <run-dir> --node=<nó> [--write]
//   node scripts/lib/spec-authority.js verify <run-dir> [--write] [--json]
// exit 0 = ok/PASS, 1 = verify FAIL, 2 = uso incorreto/sem spec pra baseline,
//      3 = drift não autorizado (check).

const fs = require('fs');
const path = require('path');
const stateWriter = require('../state-writer');
const crypto = require('crypto');
const { parseSections, parseHeading, normalizeHeading, stripComments, isLegacyAcRun } = require('./spec-validator');
const acIds = require('./ac-ids');
const acceptance = require('./acceptance-evidence');
const contract = require('./spec-hash');
const specVersion = require('./spec-version');
const invalidate = require('../invalidate');

const DRIFT_STATUS = 'spec-drift';
// Nós que só podem rodar com a spec igual à que o Plan leu (ou mudança aprovada).
const GUARDED_NODES = new Set(['implement', 'review', 'test', 'verify']);
// Seções acrescentadas por ferramenta (APPEND) — fora do hash. Cabeçalho normalizado.
const NON_NORMATIVE_HEADINGS = [/^decisoes de implementacao\b/, /^contexto historico\b/];
const AC_HEADING = /^criterios? de aceit/;
const DECISIONS_HEADING = /^decisoes de implementacao\b/;
const PLAN_HEADING = /^(plano( de (execucao|implementacao|acao))?|passos|etapas( de execucao)?|steps)\b/;
// Mapeamento AC → HOW do Plan ("## Cobertura dos ACs"). Cobertura só conta aqui e nos
// passos — a linha de referência "ACs: AC-01, ..." não prova que o plano atende o AC.
const COVERAGE_HEADING = /^cobertura (dos |de )?(acs?|criterios)\b/;
const REMOVED_MARK = /\((removid[oa]|cancelad[oa]|descontinuad[oa])\s+em\b/i;
// Reescrita de critério: linha que começa com o ID seguido de ":" ou travessão
// ("AC-02: texto", "- **AC-02**: texto", "AC-02 — texto"). O mapeamento HOW do Plan
// usa seta ("AC-02 → passos 1 e 3: ...") e não conta como reescrita.
const RESTATEMENT = /^\s*(?:[-*+]|\d+[.)])?\s*(?:\[[ xX]\]\s*)?[*_`]*(AC-\d+)[*_`]*\s*(?::|—|–|\s-\s)[*_`]*\s*(.+?)\s*$/;
const SPEC_REF = /\bSpec[*_`]*\s*:\s*[*_`]*\s*`?([^\s`*]+\.md)`?/i;
const AC_LIST = /^\s*[-*]?\s*[*_`]*ACs?[*_`]*\s*:\s*(.+)$/im;
// Runs iniciados antes disso podem ter só o ac-evidence.md de linhas "AC-01 | PASS | ..."
// (sem artefato conferível) — aceito com aviso. Depois, acceptance-evidence.json é obrigatório.
const ACCEPTANCE_EVIDENCE_REQUIRED_SINCE = '2026-10-01T00:00:00Z';
const EVIDENCE_LINE = /^\s*[-*]\s*[*_`]*(AC-\d+)[*_`]*\s*\|\s*([A-Za-z/]+)\s*\|\s*(.*)$/;

// ── Hash ─────────────────────────────────────────────────────────────────────────

function normalizeText(content) {
    return String(content || '').replace(/^﻿/, '').replace(/\r\n?/g, '\n');
}

/** Parte normativa (WHAT) da spec: sem as seções de APPEND, comentários e ruído de espaço. */
function normativeContent(specContent) {
    const lines = stripComments(normalizeText(specContent)).split('\n');
    const drop = new Array(lines.length).fill(false);
    const headings = [];
    lines.forEach((line, idx) => { const h = parseHeading(line); if (h) headings.push({ ...h, idx }); });
    headings.forEach((h, i) => {
        if (!NON_NORMATIVE_HEADINGS.some(re => re.test(normalizeHeading(h.text)))) return;
        let end = lines.length;
        for (let j = i + 1; j < headings.length; j++) if (headings[j].level <= h.level) { end = headings[j].idx; break; }
        for (let k = h.idx; k < end; k++) drop[k] = true;
    });
    return lines.filter((_, i) => !drop[i]).map(l => l.replace(/\s+$/, '')).join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
}

/** Hash LEGADO (runs sem state.spec): parte normativa = arquivo menos as seções de APPEND. */
function specHash(specContent) {
    return crypto.createHash('sha256').update(normativeContent(specContent), 'utf8').digest('hex');
}

const LEGACY_SCOPE = 'legacy_normative';

/** Escopo do hash deste run: o do bloco state.spec (versionado) ou o legado. */
function hashScopeFor(state) {
    return specVersion.readSpecBlock(state)?.hash_scope || LEGACY_SCOPE;
}

/** spec_hash da spec para ESTE run — versionado: contratual (HASH_SCOPE); legado: normativo. */
function specHashFor(state, specContent) {
    const scope = hashScopeFor(state);
    return scope === LEGACY_SCOPE ? specHash(specContent) : contract.contractHash(specContent, { scope });
}

// ── Localização da spec ──────────────────────────────────────────────────────────

/** Raiz do checkout/worktree a partir de <raiz>/memory/runs/<task-id>. */
function rootOfRunDir(runDir) {
    return path.resolve(runDir, '..', '..', '..');
}

/**
 * Caminho relativo (à raiz) da spec da task: state.spec_path (gravado no baseline),
 * senão memory/spec/<redmine_ticket.id>-spec.md, senão memory/spec/<task-id>-spec.md.
 */
function specRelFor(state, taskId) {
    if (state?.spec_path) return state.spec_path;
    const ticket = state?.redmine_ticket?.id;
    return `memory/spec/${ticket != null ? ticket : (state?.task_id || taskId)}-spec.md`;
}

function readSpec(root, rel) {
    const abs = path.resolve(root, rel);
    try { return fs.readFileSync(abs, 'utf8'); } catch { return null; }
}

// ── Drift ────────────────────────────────────────────────────────────────────────

function shortHash(h) {
    return h ? String(h).slice(0, 12) : '—';
}

/**
 * Compara a spec atual com o spec_hash do Plan.
 * @returns {{status: 'match'|'approved'|'drift'|'no_baseline'|'no_spec',
 *   ok: boolean, specPath: string, currentHash: string|null, expectedHash: string|null,
 *   reason: string}}
 */
function checkDrift(state, { root, taskId } = {}) {
    const specPath = specRelFor(state, taskId);
    const content = readSpec(root, specPath);
    const expectedHash = state?.spec_hash || null;
    if (content == null) {
        if (!expectedHash) {
            return { status: 'no_spec', ok: true, specPath, currentHash: null, expectedHash, reason: `sem spec em ${specPath} — nada a proteger (task sem spec)` };
        }
        return {
            status: 'drift', ok: false, specPath, currentHash: null, expectedHash,
            reason: `a spec ${specPath} lida pelo Plan (spec_hash ${shortHash(expectedHash)}) não existe mais — spec removida ou movida durante a execução`,
        };
    }
    const currentHash = specHashFor(state, content);
    if (!expectedHash) {
        return { status: 'no_baseline', ok: true, specPath, currentHash, expectedHash, reason: `state.json sem spec_hash — o Plan não gravou o baseline de ${specPath}` };
    }
    if (currentHash === expectedHash) {
        return { status: 'match', ok: true, specPath, currentHash, expectedHash, reason: 'spec igual à lida pelo Plan' };
    }
    const approved = state.spec_change_approved;
    const approvedHash = state.spec_change_hash;
    if (approved === true && approvedHash === currentHash) {
        return { status: 'approved', ok: true, specPath, currentHash, expectedHash, reason: `spec mudou depois do Plan, com SPEC_CHANGE aprovado (spec_change_hash ${shortHash(currentHash)})` };
    }
    const base = `a spec ${specPath} mudou depois do Plan (spec_hash ${shortHash(expectedHash)} → atual ${shortHash(currentHash)})`;
    let why;
    if (approved === undefined && approvedHash === undefined) why = 'sem aprovação: state.json não tem spec_change_approved';
    else if (approved !== true) why = `sem aprovação: spec_change_approved=${JSON.stringify(approved ?? null)} (precisa ser true)`;
    else if (!approvedHash) why = 'spec_change_approved=true, mas spec_change_hash está vazio — a aprovação precisa citar o hash da versão aprovada';
    else why = `spec_change_approved=true, mas spec_change_hash (${shortHash(approvedHash)}) não é o hash atual (${shortHash(currentHash)}) — a aprovação foi de outra versão da spec`;
    return { status: 'drift', ok: false, specPath, currentHash, expectedHash, reason: `${base}; ${why}` };
}

function bumpOnManualApproval(state, { root, result, node, now }) {
    const spec = specVersion.readSpecBlock(state);
    if (!spec || spec.hash === result.currentHash) return false;
    const out = specVersion.bump(state, {
        root, newContent: readSpec(root, result.specPath),
        reason: 'SPEC_CHANGE aprovada manualmente (spec_change_approved + spec_change_hash no state.json)',
        approvalRef: `state.json#spec_change_hash=${shortHash(result.currentHash)}`,
        by: 'drift-approval', now, runId: state.task_id || null,
    });
    if (out.bumped) state.updated_at = now;
    return out.bumped || !!out.error;
}

/** Aprovação manual de drift → invalidação (uma vez por hash aprovado). @returns {string} caso aplicado ('unchanged' = nada) */
function invalidateOnManualApproval(state, { result, oldVersion, now, runDir }) {
    // Uma vez por hash aprovado: a idempotência é do resolver (transition_id).
    const out = invalidate.applySpecChange(state, {
        oldSpec: { hash: result.expectedHash, version: oldVersion },
        newSpec: { hash: result.currentHash, version: specVersion.versionOf(state) },
        triggeredBy: 'aprovação manual de drift (spec_change_hash)', transitionId: `manual-approval:${shortHash(result.currentHash)}`,
        cause: invalidate.APPROVED, runDir, at: now,
    });
    return out.case;
}

/** Diretório do run a partir da raiz do checkout (null se não existir). */
function runDirOf(root, taskId) {
    if (!root || !taskId) return null;
    const dir = path.join(root, 'memory', 'runs', String(taskId));
    return fs.existsSync(dir) ? dir : null;
}

function approvalHint(result) {
    return `Para seguir com a spec nova, confira a mudança e grave no state.json: ` +
        `"spec_change_approved": true, "spec_change_hash": "${result.currentHash || '<hash atual>'}" ` +
        `(hash atual: node scripts/lib/spec-authority.js hash ${result.specPath} --run=memory/runs/<task-id>). ` +
        `Alternativas: reverter a spec para a versão lida pelo Plan, ou voltar a task para node="plan" ` +
        `(status="in_progress") para replanejar sobre a spec nova.`;
}

/** Campos de baseline que o /plan grava no state.json (hash no algoritmo do run). */
function baselineFields(root, specPath, by = 'plan', now = new Date().toISOString(), state = null) {
    const content = readSpec(root, specPath);
    if (content == null) return null;
    return { spec_path: specPath, spec_hash: specHashFor(state, content), spec_hash_at: now, spec_hash_by: by, spec_hash_scope: hashScopeFor(state) };
}

/**
 * Baseline completo (muta state): campos do spec_hash + selagem/rebaseline da
 * spec_version (spec-version.js onBaseline) + spec_hash_version. Run legado: só os campos.
 * @returns {object|null} os campos gravados (null = sem spec).
 */
function applyBaseline(state, { root, specPath, by = 'plan', now = new Date().toISOString(), taskId = null, reason = null } = {}) {
    const fields = baselineFields(root, specPath, by, now, state);
    if (!fields) return null;
    Object.assign(state, fields);
    const content = readSpec(root, specPath);
    const sealed = specVersion.onBaseline(state, { root, content, hash: fields.spec_hash, by, now, runId: state.task_id || taskId, reason });
    const spec = specVersion.readSpecBlock(state);
    if (spec && spec.hash === fields.spec_hash) state.spec_hash_version = spec.version;
    else delete state.spec_hash_version;
    // O baseline é o carimbo do Plan: plan VALID contra a spec lida (scripts/invalidate.js);
    // o refresh envelhece review/evidence/verify de outra versão.
    invalidate.stampProduced(state, 'plan', { specHash: fields.spec_hash, specVersion: state.spec_hash_version ?? null, at: now, runDir: runDirOf(root, state.task_id || taskId) });
    return { ...fields, ...(state.spec_hash_version ? { spec_hash_version: state.spec_hash_version } : {}), version_action: sealed.action, ...(sealed.error ? { version_error: sealed.error } : {}) };
}

/**
 * Provenance no baseline do /plan: AC da spec que ainda não tem NENHUM evento no log
 * do ticket ganha UNKNOWN/ORIGIN. Nunca HUMAN_AUTHORED por ausência de outra fonte
 * (INV-AC-PROVENANCE-01); autoria humana só por declaração (ac-provenance.js declare).
 * @returns {null|{added: string[], skipped: string[]}|{error: string}}
 */
function recordBaselineProvenance(state, { root, taskId, specPath }) {
    if (state?.dry_run) return null;
    const acProvenance = require('./ac-provenance');
    const ticket = acProvenance.ticketOf(taskId, state);
    const content = readSpec(root, specPath);
    if (!ticket || content == null) return null;
    const acs = specAcs(content).acs.map(a => a.id);
    if (!acs.length) return { added: [], skipped: [] };
    try {
        const proot = acProvenance.provenanceRoot(root);
        const read = acProvenance.readLog(ticket, { root: proot });
        if (read.error) return { error: read.error };
        const events = acProvenance.baselineUnknownEvents(ticket, acs, read.data, {
            specHash: state.spec_hash ?? null, specVersion: state.spec_hash_version ?? null, sealedAt: state.spec_hash_at ?? null, specPath,
        });
        const out = acProvenance.appendEvents(ticket, events, { root: proot });
        return out.ok ? { added: out.added, skipped: out.skipped } : { error: out.errors.join('; ') };
    } catch (e) {
        return { error: e.message };
    }
}

function pushEvent(state, event) {
    state.events = Array.isArray(state.events) ? state.events : [];
    state.events.push({ ts: event.at, ...event });
}

/**
 * Aplica o portão de drift ao state (muta). Usado pelo watcher (antes de despachar) e
 * pelo CLI `check --write` (dentro do nó). Nunca escreve arquivo — quem chama grava.
 * @returns {{proceed: boolean, changed: boolean, result: object|null, message: string}}
 */
function enforceSpecIntegrity(state, { root, taskId, node, now = new Date().toISOString() } = {}) {
    if (!state || typeof state !== 'object') return { proceed: true, changed: false, result: null, message: '' };
    const paused = state.status === DRIFT_STATUS;

    // Humano escolheu replanejar: o /plan grava o baseline novo sobre a spec atual.
    if (node === 'plan') {
        if (!paused) return { proceed: true, changed: false, result: null, message: '' };
        state.status = 'in_progress';
        delete state.spec_drift;
        pushEvent(state, { type: 'spec_drift_replan', node: 'plan', at: now, detail: 'Spec alterada — task voltou pro /plan, que grava o spec_hash novo' });
        state.updated_at = now;
        return { proceed: true, changed: true, result: null, message: 'spec-drift resolvido por replanejamento' };
    }
    if (!GUARDED_NODES.has(node) && !paused) return { proceed: true, changed: false, result: null, message: '' };

    const result = checkDrift(state, { root, taskId });
    if (result.status === 'no_spec') return { proceed: true, changed: false, result, message: result.reason };

    if (result.status === 'no_baseline') {
        // Run anterior ao spec_hash (ou Plan que não gravou): baseline a partir de agora.
        applyBaseline(state, { root, specPath: result.specPath, by: 'watcher', now, taskId });
        const late = (state.history || []).at(-1) !== 'plan';
        pushEvent(state, {
            type: 'spec_baseline', node, at: now,
            detail: `spec_hash ${shortHash(state.spec_hash)} de ${result.specPath} gravado antes de ${node}` +
                (late ? ' (baseline tardio: mudança anterior a este ponto não é detectável)' : ' (o /plan não gravou)'),
        });
        state.updated_at = now;
        return { proceed: true, changed: true, result, message: `baseline gravado: ${result.reason}` };
    }

    if (result.ok) {
        // Aprovação manual de drift (spec_change_approved + spec_change_hash, gravados por
        // humano) é SPEC_CHANGE aprovada: incrementa a spec_version se o contrato mudou e
        // passa pela Dependency Invalidation (scripts/invalidate.js) — sem nó rodando, os
        // artefatos da versão anterior ficam STALE e a task volta para o /plan; com o nó
        // rodando (check dentro do nó), pending_invalidation até ele terminar.
        const oldVersion = specVersion.versionOf(state);
        const bumped = result.status === 'approved' && bumpOnManualApproval(state, { root, result, node, now });
        const runDir = runDirOf(root, state.task_id || taskId);
        const invCase = result.status === 'approved' ? invalidateOnManualApproval(state, { result, oldVersion, now, runDir }) : 'unchanged';
        const rerouted = invCase === 'idle';
        // Spec que governa esta execução (execução manual, sem o lease do watcher, que já
        // grava execution_spec no despacho).
        const began = !rerouted && invalidate.beginExecution(state, node, { hash: result.currentHash, version: specVersion.versionOf(state) }, { at: now });
        // implement liberado: registra contra que spec ele roda (o diff não tem arquivo
        // próprio para carimbar) — é o que o guard do /review confere.
        const stampImplement = node === 'implement' && !rerouted;
        if (stampImplement) invalidate.stampProduced(state, 'implement', { specHash: result.currentHash, specVersion: specVersion.versionOf(state), at: now, runDir });
        if (!paused) return { proceed: true, changed: bumped || invCase !== 'unchanged' || stampImplement || began, result, message: rerouted ? `${result.reason} — artefatos da versão anterior STALE, task volta para o /plan` : result.reason };
        state.status = 'in_progress';
        delete state.spec_drift;
        pushEvent(state, {
            type: result.status === 'approved' ? 'spec_change_accepted' : 'spec_drift_resolved', node, at: now,
            detail: result.status === 'approved'
                ? `SPEC_CHANGE aprovado (spec_change_hash ${shortHash(result.currentHash)}) — pipeline retomado em ${state.node}${rerouted ? ' (artefatos da versão anterior STALE)' : ''}`
                : `spec voltou ao hash lido pelo Plan (${shortHash(result.expectedHash)}) — pipeline retomado em ${node}`,
        });
        state.updated_at = now;
        return { proceed: true, changed: true, result, message: result.reason };
    }

    // Drift não autorizado: pausa (evento só na primeira detecção desta versão da spec).
    const same = paused && state.spec_drift?.current_hash === result.currentHash && state.spec_drift?.node === node;
    if (same) return { proceed: false, changed: false, result, message: result.reason };
    state.status = DRIFT_STATUS;
    state.spec_drift = {
        detected_at: now, node, spec_path: result.specPath,
        expected_hash: result.expectedHash, current_hash: result.currentHash, reason: result.reason,
    };
    pushEvent(state, { type: 'spec_drift', node, at: now, detail: `Pipeline pausado antes de ${node}: ${result.reason}` });
    state.updated_at = now;
    return { proceed: false, changed: true, result, message: result.reason };
}

// ── Leitura de ACs, plano, handoff, evidências ───────────────────────────────────

function norm(text) {
    return String(text || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
        .replace(/[*_`]/g, '').replace(/\s+/g, ' ').replace(/[\s.;:]+$/, '').trim();
}

function sectionsOf(content) {
    return parseSections(stripComments(normalizeText(content)).split('\n'));
}

// minLevel 2 nas seções de plano: o título "# Plano — <task-id>" casaria /^plano\b/ e,
// sendo nível 1, engoliria o arquivo inteiro (inclusive a linha "ACs:" de referência).
function sectionText(content, match, minLevel = 1) {
    const s = sectionsOf(content).find(x => x.level >= minLevel && match.test(x.normalized));
    return s ? s.body.join('\n') : null;
}

/**
 * ACs da spec: [{id, num, text, head, active}] na ordem, e se a seção usa IDs.
 * `head` = texto só da linha do item (sem sub-bullets); `text` = item inteiro.
 */
function specAcs(specContent) {
    const section = sectionsOf(specContent).find(s => AC_HEADING.test(s.normalized));
    if (!section) return { hasSection: false, hasIds: false, acs: [], errors: [] };
    const parsed = acIds.parseAcItems(section.body);
    const errors = parsed.hasIds ? acIds.validateAcItems(parsed.items) : [];
    const acs = parsed.items.filter(i => i.id).map(i => {
        const canon = /^[*_`]*AC-\d+[*_`]*\s*(?:[:—–-][*_`]*\s*)?/.exec(i.raw);
        const head = canon ? i.raw.slice(canon[0].length) : i.raw;
        return { id: i.id, num: i.num, text: i.text, head, active: !REMOVED_MARK.test(i.text) };
    });
    return { hasSection: true, hasIds: parsed.hasIds, acs, errors };
}

function idsIn(text) {
    return acIds.findAcRefs(text).map(acIds.canonicalId);
}

/** Linhas que reescrevem o texto de um AC: [{id, text, line}]. */
function restatements(content) {
    const out = [];
    stripComments(normalizeText(content)).split('\n').forEach((line, i) => {
        const m = RESTATEMENT.exec(line);
        if (m) out.push({ id: acIds.canonicalId(acIds.idNumber(m[1])), text: m[2], line: i + 1 });
    });
    return out;
}

/** Evidências por AC de ac-evidence.md: Map<id, {status, evidence, line}>. */
function parseEvidence(content) {
    const map = new Map();
    stripComments(normalizeText(content)).split('\n').forEach((line, i) => {
        const m = EVIDENCE_LINE.exec(line);
        if (!m) return;
        const id = acIds.canonicalId(acIds.idNumber(m[1]));
        map.set(id, { status: m[2].toUpperCase(), evidence: m[3].replace(/[\s|]+$/, '').trim(), line: i + 1 });
    });
    return map;
}

/** Entradas de "## Decisões de Implementação": [{header, taskId, impact}]. */
function decisionEntries(specContent) {
    const body = sectionText(specContent, DECISIONS_HEADING);
    if (body == null) return [];
    const entries = [];
    let cur = null;
    for (const line of body.split('\n')) {
        const h = parseHeading(line);
        if (h) {
            cur = { header: h.text.trim(), taskId: (h.text.split('·').map(x => x.trim())[2] || '').trim(), impacts: [] };
            entries.push(cur);
            continue;
        }
        const im = /^\s*[-*]\s*[*_]*Impacto no spec[*_]*\s*:?\s*[*_]*\s*:?\s*(.*)$/i.exec(line);
        if (cur && im) cur.impacts.push(im[1].trim());
    }
    return entries;
}

// Impacto que altera critério: cita AC-XX / "critério" e não começa por "nenhum".
function impactChangesAc(impact) {
    const n = norm(impact);
    if (!n || /^(nenhum|nenhuma|sem impacto|n\/a|na\b)/.test(n)) return false;
    return /\bac-\d+\b/.test(n) || /\bcriterio/.test(n);
}

// ── Verify ───────────────────────────────────────────────────────────────────────

/**
 * Conformidade Spec → Plan → Handoff → Evidência. Puro (sem I/O).
 * Puro exceto pela matriz (acceptanceContent): os artefatos citados nela são
 * conferidos no disco via `io` (default fs), relativos a `root`/`runDir`.
 * @param {{specContent: string|null, specPath: string, planContent: string|null,
 *   planFile?: string, handoffContent: string|null, evidenceContent: string|null,
 *   acceptanceContent?: string|null, root?: string, runDir?: string, io?: object,
 *   state: object, drift: object, taskId?: string}} input
 * @returns {{verdict: 'PASS'|'FAIL'|'N/A', failures: {code, message}[],
 *   warnings: {code, message}[], acs: string[], coverage: object[],
 *   acceptance: {results: object, summary: object|null}|null}}
 */
function verifyConformance(input) {
    const { specContent, specPath, planContent, handoffContent, evidenceContent, acceptanceContent, state = {}, drift, taskId } = input;
    const planFile = input.planFile || 'plan.md';
    const failures = [];
    const warnings = [];
    const fail = (code, message) => failures.push({ code, message });
    const warn = (code, message) => warnings.push({ code, message });

    if (specContent == null) {
        warn('NO_SPEC', `Sem spec em ${specPath} — task ad-hoc; conformidade de ACs não se aplica.`);
        return { verdict: 'N/A', failures, warnings, acs: [], coverage: [], acceptance: null };
    }

    // 1. Integridade da spec.
    if (drift && !drift.ok) fail('SPEC_DRIFT', `Drift não autorizado: ${drift.reason}.`);
    // SPEC_CHANGE do /implement (scripts/lib/spec-change.js): pendente/rejeitada nunca
    // chega ao commit; aprovada deixa artefatos stale até serem regerados sobre a spec nova.
    if (state.spec_change_pending) fail('SPEC_CHANGE_PENDING', `SPEC_CHANGE ${state.spec_change_pending.id || ''} aguardando aprovação humana (status ${state.status}) — nada segue até a decisão.`);
    // Transição de contrato pendente (scripts/invalidate.js): fail-closed antes de olhar
    // qualquer artefato — eles ainda não foram reavaliados contra a spec nova.
    const pendingTransition = invalidate.guardPending(state, input.runDir || null);
    if (pendingTransition) fail(pendingTransition.code, pendingTransition.message);
    if (state.status === 'spec-change-rejected') fail('SPEC_CHANGE_REJECTED', `SPEC_CHANGE ${state.spec_change_rejected?.id || ''} rejeitada — implemente a spec como está antes de verificar.`);
    if (Array.isArray(state.stale_artifacts) && state.stale_artifacts.length) {
        fail('STALE_ARTIFACTS', `Artefatos stale desde a SPEC_CHANGE aprovada (${state.stale_since || '?'}): ${state.stale_artifacts.join(', ')} — regere-os sobre a spec nova (plan.md/handoff.md pelo /plan, acceptance-evidence.json pelo /test).`);
    }
    else if (drift?.status === 'no_baseline') warn('NO_SPEC_BASELINE', `${drift.reason} — integridade da spec não verificável neste run.`);
    else if (drift?.status === 'approved') warn('SPEC_CHANGE_APPROVED', drift.reason);

    // 2. ACs da spec.
    const spec = specAcs(specContent);
    if (!spec.hasSection) {
        fail('SPEC_NO_ACS', `${specPath} sem seção "## Critérios de Aceite" — não há contrato funcional a verificar.`);
        return { verdict: 'FAIL', failures, warnings, acs: [], coverage: [], acceptance: null };
    }
    if (!spec.hasIds) {
        if (isLegacyAcRun(state)) {
            warn('LEGACY_NO_AC_IDS', `${specPath} sem IDs AC-XX (run anterior aos IDs) — rastreabilidade por AC indisponível; só a integridade da spec foi verificada.`);
            return { verdict: failures.length ? 'FAIL' : 'PASS', failures, warnings, acs: [], coverage: [], acceptance: null };
        }
        fail('SPEC_NO_AC_IDS', `${specPath} sem IDs AC-XX nos critérios — numere com node scripts/lib/ac-ids.js number ${specPath} --write (é uma SPEC_CHANGE: exige aprovação).`);
        return { verdict: 'FAIL', failures, warnings, acs: [], coverage: [], acceptance: null };
    }
    for (const e of spec.errors) fail('SPEC_AC_IDS_INVALID', `${specPath}: ${e.message}`);
    const byId = new Map(spec.acs.map(a => [a.id, a]));
    const active = spec.acs.filter(a => a.active).map(a => a.id);
    const known = new Set(spec.acs.map(a => a.id));

    const checkRestatements = (content, where, codePrefix) => {
        for (const r of restatements(content)) {
            const ac = byId.get(r.id);
            if (!ac) continue; // ID desconhecido já é apontado pela checagem de referências
            const t = norm(r.text);
            if (t === norm(ac.text) || t === norm(ac.head)) {
                warn(`${codePrefix}_AC_TEXT_DUPLICATED`, `${where}:${r.line} copia o texto de ${r.id} — referencie só o ID (a spec é a única fonte do texto).`);
            } else {
                fail(`${codePrefix}_AC_TEXT_DIVERGES`, `${where}:${r.line} reescreve ${r.id} com texto diferente da spec — spec: "${short(ac.head)}"; ${where}: "${short(r.text)}". A spec vence; SPEC_CHANGE só com aprovação.`);
            }
        }
    };

    // 3. Plan: cobre todos os ACs ativos, não inventa nem redefine AC.
    if (planContent == null) {
        fail('PLAN_MISSING', `Plano não encontrado (${planFile}) — o Verify não consegue ligar os ACs da spec ao plano.`);
    } else {
        const planBody = sectionText(planContent, PLAN_HEADING, 2);
        if (planBody == null) fail('PLAN_MISSING', `${planFile} sem a seção "## Plano de execução".`);
        const planRefs = new Set(idsIn(`${planBody || ''}\n${sectionText(planContent, COVERAGE_HEADING, 2) || ''}`));
        for (const id of active) {
            if (!planRefs.has(id)) fail('PLAN_OMITS_AC', `O Plan omitiu ${id} ("${short(byId.get(id).head)}") — nenhum passo nem a "## Cobertura dos ACs" de ${planFile} cita o ID.`);
        }
        for (const id of idsIn(planContent)) if (!known.has(id)) fail('PLAN_UNKNOWN_AC', `${planFile} cita ${id}, que não existe na spec — o Plan não cria critério (WHAT é da spec).`);
        checkRestatements(planContent, planFile, 'PLAN');
    }

    // 4. Handoff: referencia a spec certa e os mesmos ACs, sem reescrever texto.
    if (handoffContent == null) {
        fail('HANDOFF_MISSING', 'handoff.md não encontrado.');
    } else {
        const ref = SPEC_REF.exec(stripComments(normalizeText(handoffContent)));
        if (!ref) fail('HANDOFF_SPEC_REF_MISSING', `handoff.md não referencia a spec (esperado "Spec: ${specPath}").`);
        else if (path.posix.normalize(ref[1].replace(/^\.\//, '')) !== path.posix.normalize(specPath)) {
            fail('HANDOFF_SPEC_REF_DIVERGES', `handoff.md referencia "${ref[1]}", mas a spec da task é ${specPath}.`);
        }
        const list = AC_LIST.exec(stripComments(normalizeText(handoffContent)));
        if (!list) {
            fail('HANDOFF_AC_LIST_MISSING', `handoff.md sem a linha "ACs: ${active.join(', ')}" (só IDs).`);
        } else {
            const listed = new Set(idsIn(list[1]));
            const missing = active.filter(id => !listed.has(id));
            const extra = [...listed].filter(id => !active.includes(id));
            if (missing.length || extra.length) {
                fail('HANDOFF_AC_LIST_DIVERGES', `Handoff diverge da Spec: lista ACs ${[...listed].join(', ') || '(nenhum)'}, a spec tem ${active.join(', ')} ativos` +
                    (missing.length ? ` — faltam ${missing.join(', ')}` : '') + (extra.length ? ` — sobram ${extra.join(', ')}` : '') + '.');
            }
        }
        for (const id of idsIn(handoffContent)) if (!known.has(id)) fail('HANDOFF_UNKNOWN_AC', `handoff.md cita ${id}, que não existe na spec.`);
        checkRestatements(handoffContent, 'handoff.md', 'HANDOFF');
    }

    if (Array.isArray(state.ac_ids)) {
        const s = state.ac_ids.join(', ');
        if (s !== spec.acs.map(a => a.id).join(', ')) warn('STATE_AC_IDS_STALE', `state.ac_ids (${s || 'vazio'}) difere dos IDs da spec (${spec.acs.map(a => a.id).join(', ')}).`);
    }

    // 5. Evidência por AC ativo: matriz do /test (acceptance-evidence.json), conferida
    // contra os artefatos reais — nunca só o "result" relatado.
    let coverage = [];
    let acceptanceOut = null;
    const legacyEvidence = isLegacyEvidenceRun(state);
    if (acceptanceContent != null) {
        const m = acceptance.checkMatrix({
            raw: acceptanceContent, activeAcs: active, knownAcs: [...known],
            specHash: drift?.currentHash || specHashFor(state, specContent),
            specVersion: specVersion.readSpecBlock(state)?.version ?? null,
            root: input.root, runDir: input.runDir, io: input.io, state, checkPending: false,
        });
        failures.push(...m.failures);
        warnings.push(...m.warnings);
        coverage = m.coverage;
        acceptanceOut = { results: m.results, summary: m.summary };
    } else if (evidenceContent == null || !legacyEvidence) {
        fail('EVIDENCE_MISSING', `${acceptance.FILE} não encontrado — nenhum AC da spec tem evidência conferível (${active.join(', ')}). O /test grava a matriz de cobertura.`);
    } else {
        // ac-evidence.md não registra spec_hash: evidence UNKNOWN (legado sem versão).
        // UNKNOWN não é FAIL de teste, mas não comprova a spec atual — o Verify é
        // fail-closed (scripts/invalidate.js guardVerify).
        const g = invalidate.guardVerify(state, null, { legacyEvidence: true, checkPending: false });
        fail(g.code, g.message);
        warn('LEGACY_AC_EVIDENCE_MD', `Run anterior à matriz de cobertura: só ac-evidence.md (sem ${acceptance.FILE}) — artefatos das evidências não conferidos.`);
        const ev = parseEvidence(evidenceContent);
        for (const id of active) {
            const e = ev.get(id);
            coverage.push({ id, status: e?.status || 'AUSENTE', evidence: e?.evidence || '' });
            if (!e) fail('AC_WITHOUT_EVIDENCE', `${id} sem evidência em ac-evidence.md.`);
            else if (e.status !== 'PASS') fail('AC_EVIDENCE_NOT_PASS', `${id} com evidência ${e.status} em ac-evidence.md:${e.line}${e.evidence ? ` (${short(e.evidence)})` : ''}.`);
            else if (!e.evidence) fail('AC_WITHOUT_EVIDENCE', `${id} marcado PASS sem dizer qual teste/verificação comprova (ac-evidence.md:${e.line}).`);
        }
        for (const id of ev.keys()) if (!known.has(id)) warn('EVIDENCE_UNKNOWN_AC', `ac-evidence.md tem evidência de ${id}, que não existe na spec.`);
    }

    // 6. Decisões de implementação desta task que alteram critério.
    const approvedChange = drift?.status === 'approved';
    for (const d of decisionEntries(specContent)) {
        if (taskId && d.taskId && d.taskId !== taskId) continue;
        for (const impact of d.impacts.filter(impactChangesAc)) {
            if (approvedChange) warn('BEHAVIOR_CHANGE_APPROVED', `Decisão "${d.header}" altera critério ("${short(impact)}") — coberta pelo SPEC_CHANGE aprovado.`);
            else fail('BEHAVIOR_CHANGE_WITHOUT_APPROVAL', `Decisão "${d.header}" altera comportamento da spec ("${short(impact)}") sem SPEC_CHANGE aprovado — a spec vence: implemente o critério como está ou peça a mudança da spec (spec_change_approved + spec_change_hash).`);
        }
    }

    // 7. O que o Review deixou passar sem reprovar, mas que o Verify precisa ver
    // (scripts/lib/review-result.js): SPEC_CLARIFICATION e decisões técnicas aceitas.
    const review = state.review_results;
    if (review && typeof review === 'object') {
        const currentHash = drift?.currentHash || specHashFor(state, specContent);
        const reviewValidity = invalidate.effectiveStatus(state, 'review', { current: currentHash });
        if (reviewValidity === invalidate.STALE) {
            warn('REVIEW_SPEC_HASH_STALE', `O último Review avaliou outra versão da spec (spec_hash ${shortHash(review.spec_hash)} ≠ atual ${shortHash(currentHash)}) — a Spec Compliance dele não cobre a versão atual.`);
        } else if (reviewValidity === invalidate.UNKNOWN) {
            warn('REVIEW_SPEC_UNKNOWN', 'O último Review é legado sem versão (sem spec_hash) — a Spec Compliance dele não comprova a versão atual.');
        }
        if (review.compliance_valid === false) {
            warn('REVIEW_COMPLIANCE_NOT_VALID', `O Review avaliou um implement ${review.implement_validity?.status || 'sem versão'}: ${review.implement_validity?.alert || 'compliance não comprova a spec atual'}`);
        }
        if (review.verdict === 'FAIL') warn('REVIEW_NOT_PASSED', `O último Review (rodada ${review.round ?? '?'}) reprovou (failure_origin: ${review.failure_origin}) e a task chegou ao Verify mesmo assim (avanço manual?) — confira os achados em review-result.md.`);
        for (const c of Array.isArray(review.spec_clarifications) ? review.spec_clarifications : []) {
            warn('REVIEW_SPEC_CLARIFICATION', `${c.ac || 'sem AC'}${c.file ? ` (${c.file}${c.line ? `:${c.line}` : ''})` : ''}: ${short(c.summary, 160)} — esclarecimento de spec ambígua aceito pelo Review; confirme que o teste cobre o comportamento escolhido.`);
        }
        for (const d of Array.isArray(review.technical_decisions_applied) ? review.technical_decisions_applied : []) {
            warn('REVIEW_TECHNICAL_DECISION', `${d.ac}: ${short(d.summary, 160)} — decisão técnica documentada (${d.source}, ${d.approved_at}), aceita pelo Review sem efeito funcional.`);
        }
    }

    // 8. spec_version/spec_hash registrados por Plan/Review/Test contra a spec atual:
    // artefato de outra versão = SPEC_CHANGE mid-run (alerta, nunca silencia).
    const currentHash = drift?.currentHash || specHashFor(state, specContent);
    let acceptanceData = null;
    try { acceptanceData = acceptanceContent != null ? JSON.parse(acceptanceContent) : null; } catch { /* EVIDENCE_INVALID já reprovou */ }
    const versions = specVersion.checkArtifacts({ state, currentHash, planContent, acceptanceData });
    failures.push(...versions.failures);
    warnings.push(...versions.warnings);
    const stamp = specVersion.stampFor(state, currentHash);
    if (stamp.mismatch && drift?.ok) warn('SPEC_CHANGE_MID_RUN', stamp.message);

    return {
        verdict: failures.length ? 'FAIL' : 'PASS', failures, warnings, acs: active, coverage, acceptance: acceptanceOut,
        spec_version: stamp.spec_version, spec_hash: stamp.spec_hash, artifacts: versions.artifacts,
    };
}

function isLegacyEvidenceRun(state) {
    const started = Date.parse(state?.started_at || '');
    return Number.isFinite(started) && started < Date.parse(ACCEPTANCE_EVIDENCE_REQUIRED_SINCE);
}

function short(text, max = 80) {
    const t = String(text).replace(/\s+/g, ' ').trim();
    return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

function readIf(file) {
    try { return fs.readFileSync(file, 'utf8'); } catch { return null; }
}

/** Plano da task: plan.md (fonte do HOW); runs anteriores a ele têm o plano no handoff. */
function readPlan(runDir) {
    const plan = readIf(path.join(runDir, 'plan.md'));
    if (plan != null) return { planContent: plan, planFile: 'plan.md' };
    const handoff = readIf(path.join(runDir, 'handoff.md'));
    return handoff != null && sectionText(handoff, PLAN_HEADING, 2) != null
        ? { planContent: handoff, planFile: 'handoff.md' }
        : { planContent: null, planFile: 'plan.md' };
}

/** verifyConformance lendo os artefatos de um run. */
function verifyRun(runDir, state) {
    // Artefato regerado depois da SPEC_CHANGE aprovada sai de stale_artifacts (cópia:
    // quem grava o state é o CLI --write). Lazy: spec-change.js depende deste módulo.
    if (Array.isArray(state?.stale_artifacts) && state.stale_artifacts.length) {
        state = JSON.parse(JSON.stringify(state));
        require('./spec-change').refreshStale(state, runDir);
    }
    const root = rootOfRunDir(runDir);
    const taskId = state?.task_id || path.basename(runDir);
    const drift = checkDrift(state, { root, taskId });
    const { planContent, planFile } = readPlan(runDir);
    return verifyConformance({
        specContent: readSpec(root, drift.specPath), specPath: drift.specPath,
        planContent, planFile,
        handoffContent: readIf(path.join(runDir, 'handoff.md')),
        evidenceContent: readIf(path.join(runDir, 'ac-evidence.md')),
        acceptanceContent: readIf(path.join(runDir, acceptance.FILE)),
        root, runDir,
        state, drift, taskId,
    });
}

function formatReport(result, { taskId, specPath }) {
    const lines = [
        `# Conformidade com a Spec — ${taskId}`,
        '',
        `Spec (autoridade do WHAT): \`${specPath}\`${result.spec_version != null ? ` · spec_version=${result.spec_version}` : ''}${result.spec_hash ? ` · spec_hash=${shortHash(result.spec_hash)}` : ''}`,
        `Veredito: **${result.verdict}**`,
        '',
    ];
    if (result.coverage.length) {
        lines.push('## Evidência por AC', '');
        const verified = result.acceptance?.results || {};
        for (const c of result.coverage) {
            const v = verified[c.id];
            lines.push(`- ${c.id} | ${c.status} | ${c.evidence || '—'}${v ? ` | conferido: ${v.verdict}` : ''}`);
        }
        lines.push('');
        const manual = result.warnings.filter(w => w.code === 'AC_NOT_AUTOMATED');
        if (manual.length) lines.push('## Validação humana pendente (NOT_AUTOMATED)', '', ...manual.map(w => `- ${w.message}`), '');
    }
    const clarifications = result.warnings.filter(w => w.code === 'REVIEW_SPEC_CLARIFICATION');
    if (clarifications.length) lines.push('## Esclarecimentos de spec (Review)', '', ...clarifications.map(w => `- ${w.message}`), '');
    lines.push('## Falhas', '');
    lines.push(...(result.failures.length ? result.failures.map(f => `- [FAIL] ${f.code}: ${f.message}`) : ['- nenhuma']));
    if (result.warnings.length) lines.push('', '## Avisos', '', ...result.warnings.map(w => `- [WARN] ${w.code}: ${w.message}`));
    return lines.join('\n') + '\n';
}

/** Grava o bloco `verification` na matriz: o elo VERIFY da cadeia por AC (trace). */
function writeVerification(runDir, result, at, currentSpecHash, currentSpecVersion = null) {
    const file = path.join(runDir, acceptance.FILE);
    let data;
    try { data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return; }
    if (!data || typeof data !== 'object') return;
    data.verification = {
        verified_at: at, verdict: result.verdict === 'PASS' ? 'PASS' : 'FAIL',
        ...(currentSpecHash ? { spec_hash: currentSpecHash } : {}),
        ...(currentSpecVersion != null ? { spec_version: currentSpecVersion } : {}),
        results: result.acceptance.results,
    };
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n');
    fs.renameSync(tmp, file);
}

function readState(runDir) {
    return JSON.parse(fs.readFileSync(path.join(runDir, 'state.json'), 'utf8'));
}

function writeState(runDir, state) {
    stateWriter.write(runDir, state, { operation: 'spec_authority', actor: 'agent' });
}

module.exports = {
    specHash, specHashFor, hashScopeFor, normativeContent, specRelFor, rootOfRunDir, checkDrift, enforceSpecIntegrity,
    baselineFields, applyBaseline, approvalHint, verifyConformance, verifyRun, formatReport, specAcs,
    parseEvidence, restatements, decisionEntries, impactChangesAc, readPlan, isLegacyEvidenceRun,
    sectionText, readSpec, recordBaselineProvenance,
    DRIFT_STATUS, GUARDED_NODES, ACCEPTANCE_EVIDENCE_REQUIRED_SINCE, LEGACY_SCOPE,
};

if (require.main === module) {
    const args = process.argv.slice(2);
    const flag = name => { const a = args.find(x => x === `--${name}` || x.startsWith(`--${name}=`)); return a === undefined ? undefined : (a.includes('=') ? a.split('=').slice(1).join('=') : true); };
    const [cmd, target] = args.filter(a => !a.startsWith('--'));
    const usage = () => {
        console.error('Uso: node scripts/lib/spec-authority.js hash <spec.md> | baseline <run-dir> [--by=<nó>] | check <run-dir> --node=<nó> [--write] | verify <run-dir> [--write] [--json]');
        process.exit(2);
    };
    if (!cmd || !target) usage();

    if (cmd === 'hash') {
        if (!fs.existsSync(target)) usage();
        const content = fs.readFileSync(target, 'utf8');
        const run = flag('run');
        if (flag('legacy')) console.log(specHash(content));
        else if (typeof run === 'string') {
            const st = (() => { try { return readState(path.resolve(run)); } catch { return null; } })();
            if (!st) { console.error(`${run}: sem state.json legível.`); process.exit(2); }
            console.log(specHashFor(st, content));
        } else console.log(contract.contractHash(content));
        process.exit(0);
    }
    if (!fs.existsSync(path.join(target, 'state.json'))) {
        console.error(`${target}: sem state.json.`);
        process.exit(2);
    }
    const runDir = path.resolve(target);
    const root = rootOfRunDir(runDir);
    const taskId = path.basename(runDir);
    const state = readState(runDir);

    if (cmd === 'baseline') {
        const rel = specRelFor({ ...state, spec_path: undefined }, taskId);
        const fields = applyBaseline(state, { root, specPath: rel, by: typeof flag('by') === 'string' ? flag('by') : 'plan', taskId });
        if (!fields) {
            console.error(`${rel}: spec não encontrada — sem baseline (task sem spec não tem WHAT a proteger).`);
            process.exit(2);
        }
        state.updated_at = fields.spec_hash_at;
        delete state.spec_drift;
        if (state.status === DRIFT_STATUS) state.status = 'in_progress';
        writeState(runDir, state);
        console.log(`spec_hash de ${rel} gravado: ${fields.spec_hash} (${fields.spec_hash_scope})`);
        const prov = recordBaselineProvenance(state, { root, taskId, specPath: rel });
        if (prov?.error) console.error(`[ac-provenance] não registrada no baseline: ${prov.error}`);
        else if (prov?.added?.length) console.log(`[ac-provenance] ${prov.added.length} AC(s) sem provenance demonstrável registrados como UNKNOWN/ORIGIN.`);
        if (fields.version_error) console.error(`[spec-version] ${fields.version_error}`);
        const line = specVersion.prLine(state);
        if (line && fields.spec_hash_version) console.log(`spec v${fields.spec_hash_version} ${fields.version_action === 'sealed' ? 'selada' : 'vigente'} — declare no topo do plan.md: ${line}`);
        else console.log('run legado (sem state.spec): sem spec_version — plan.md não declara versão.');
        process.exit(0);
    }
    if (cmd === 'check') {
        const node = flag('node');
        if (typeof node !== 'string') usage();
        const outcome = enforceSpecIntegrity(state, { root, taskId, node });
        if (flag('write') && outcome.changed) writeState(runDir, state);
        if (outcome.proceed) {
            console.log(`[spec-authority] ${node}: ok — ${outcome.message || 'nó fora do portão de drift'}`);
            process.exit(0);
        }
        console.error(`[spec-authority] ${node}: SPEC DRIFT — pipeline pausado. ${outcome.message}`);
        console.error(`[spec-authority] ${approvalHint(outcome.result)}`);
        process.exit(3);
    }
    if (cmd === 'verify') {
        const result = verifyRun(runDir, state);
        const specPath = specRelFor(state, taskId);
        if (flag('write')) {
            fs.writeFileSync(path.join(runDir, 'spec-conformance.md'), formatReport(result, { taskId, specPath }));
            const checkedAt = new Date().toISOString();
            const fresh = readState(runDir);
            require('./spec-change').refreshStale(fresh, runDir);
            fresh.spec_conformance = {
                verdict: result.verdict, checked_at: checkedAt, spec_path: specPath,
                spec_version: result.spec_version ?? null, spec_hash: result.spec_hash ?? null,
                failures: result.failures.map(f => `${f.code}: ${f.message}`),
                warnings: result.warnings.map(w => `${w.code}: ${w.message}`),
            };
            invalidate.stampProduced(fresh, 'verify', { specHash: result.spec_hash ?? null, specVersion: result.spec_version ?? null, at: checkedAt, runDir });
            if (result.acceptance) {
                fresh.spec_conformance.acceptance = { ...result.acceptance.summary, verified: Object.fromEntries(Object.entries(result.acceptance.results).map(([id, r]) => [id, r.verdict])) };
                writeVerification(runDir, result, checkedAt, checkDrift(state, { root, taskId }).currentHash, result.spec_version);
            }
            writeState(runDir, fresh);
        }
        if (flag('json')) console.log(JSON.stringify(result, null, 2));
        else process.stdout.write(formatReport(result, { taskId, specPath }));
        process.exit(result.verdict === 'FAIL' ? 1 : 0);
    }
    usage();
}
