// Governança de decisões descobertas durante a implementação. Uma decisão técnica do
// agente nunca altera silenciosamente um requisito funcional (SPEC = WHAT): toda decisão
// que o /implement toma e que toca a spec passa por aqui e recebe UMA classificação:
//
//   TECHNICAL_DECISION  escolha de método interno, query equivalente, helper existente,
//                       abordagem técnica sem mudar comportamento observável → segue
//                       sozinha; registrada em state.technical_decisions[] (vale como
//                       registro para o DOCUMENTED_TECHNICAL_DECISION do Review).
//   SPEC_CLARIFICATION  a spec era ambígua e a decisão só explicita comportamento já
//                       compatível, sem mudar o esperado nem reduzir AC → segue;
//                       registrada em technical_decisions[] e conferida pelo /review
//                       (scripts/lib/review-result.js, decision_reviews[]).
//   SPEC_CHANGE         remove/enfraquece AC, altera comportamento esperado, muda regra
//                       de negócio, adiciona exceção funcional, altera restrição
//                       funcional ou expande/reduz escopo funcional → o /implement NÃO
//                       aprova. A proposta vai para spec-change-audit.json (append-only),
//                       state.status = "spec-change-pending-approval" +
//                       state.spec_change_pending, bloco no handoff.md, e o pipeline para.
//
// A classificação declarada pelo agente não é a palavra final: qualquer flag de impacto
// (IMPACT_FLAGS) ou texto que remove/enfraquece AC ou muda regra de negócio
// (detectSpecChange) força SPEC_CHANGE — é o que impede um "TECHNICAL_DECISION: removi o
// AC-02" de seguir sozinho.
//
// Aprovação humana: a MESMA infraestrutura do spec-pending-approval — o watcher comenta a
// proposta no Redmine (runSpecChangeGate) e espera a resposta com SPEC_APPROVAL_KEYWORD
// ("aprovado"; o botão do dashboard posta essa palavra) ou SPEC_REJECTION_KEYWORD
// ("rejeitado"). Aprovada (approveSpecChange):
//   1. audit += {...proposta, event: "approved", approved_by: "human", approved_at};
//   2. spec atualizada de forma auditável: entrada em "## Histórico de Mudanças" (nada
//      apagado; AC removido/substituído ganha a marca "(removido em <data>: ...)" e o
//      substituto um ID novo — scripts/lib/ac-ids.js);
//   3. spec_hash recalculado: spec_change_approved=true, spec_change_hash=spec_hash=novo;
//      run versionado (state.spec): se o HASH_SCOPE mudou, spec_version+1 e entrada nova
//      em <spec>-changelog.json com approval_ref = a entrada "approved" deste audit
//      (scripts/lib/spec-version.js bump); hash contratual igual = versão mantida;
//   4. Dependency Invalidation (scripts/invalidate.js — o único que decide), sempre,
//      com HASH_SCOPE alterado ou não (INV-SPEC-CHANGE-REPLAN: hash igual não prova que
//      replanejar é desnecessário — applyToSpec grava regra/restrição/escopo/exceção só
//      no Histórico, fora do hash): artifact_validity de plan/implement/review/evidence/
//      verify STALE, stale_artifacts = plan.md, handoff.md, acceptance-evidence.json
//      (context.md é histórico e fica). Os outros runs ativos sobre a mesma spec recebem
//      a transição ANTES de a spec nova ser gravada (propagateSpecChange);
//   5. node="plan", status="in_progress" — volta para o Plan, nunca direto ao Review: o
//      HOW pode precisar mudar.
// Rejeitada (rejectSpecChange): audit += {event: "rejected"}, status
// "spec-change-rejected" — continua pausado até um humano decidir: mensagem pelo dashboard
// (o watcher interpreta e retoma o /implement) ou, na mão, node="implement",
// status="in_progress" para implementar a spec como está.
//
// Artefato stale sai da lista quando é regerado depois da aprovação (o artefato da fase
// voltou a VALID — refreshStale → invalidate.isRegenerated, chamado pelo watcher e pelo
// Verify). Enquanto plan.md/handoff.md estiverem
// stale, nó guardado volta para o Plan (staleGate); o Verify reprova com qualquer stale.
//
// Uso como CLI (<run-dir> = memory/runs/<task-id>):
//   node scripts/lib/spec-change.js record <run-dir> --input=<decision.json>
//       exit 0 = registrada e segue, 4 = SPEC_CHANGE pendente (pare), 2 = entrada inválida.
//   node scripts/lib/spec-change.js approve <run-dir> --by="<nome>" [--journal=<id da resposta no Redmine>]   (humano)
//   node scripts/lib/spec-change.js reject <run-dir> --by="<nome>" [--reason="..."]   (humano)
//   node scripts/lib/spec-change.js status <run-dir>
//   node scripts/lib/spec-change.js template
// Matriz da decisão: memory/decisions/2026-09-30-governanca-spec-change.md.

const fs = require('fs');
const path = require('path');
const sa = require('./spec-authority');
const specVersion = require('./spec-version');
const acIds = require('./ac-ids');
const { parseHeading, normalizeHeading } = require('./spec-validator');
const acProvenance = require('./ac-provenance');
const invalidate = require('../invalidate');
const cas = require('../cas');
const stateWriter = require('../state-writer');

const DECISION_TYPES = ['TECHNICAL_DECISION', 'SPEC_CLARIFICATION', 'SPEC_CHANGE'];
const PENDING_STATUS = 'spec-change-pending-approval';
const REJECTED_STATUS = 'spec-change-rejected';
const AUDIT_FILE = 'spec-change-audit.json';
// Mesma lista que scripts/invalidate.js marca (STALE_FILES) — exportada com o nome antigo.
const STALE_ON_APPROVAL = require('../invalidate').STALE_FILES;
// Artefatos que só o Plan regera: com eles stale, nó guardado volta para o Plan.
const PLAN_ARTIFACTS = new Set(['plan.md', 'handoff.md']);
const HISTORY_HEADING = /^historico de mudancas\b/;
const AC_HEADING = /^criterios? de aceit/;
const HANDOFF_START = '<!-- spec-change-pending:inicio -->';
const HANDOFF_END = '<!-- spec-change-pending:fim -->';
const AC_CHANGE_ACTIONS = new Set(['remove', 'replace', 'add']);

// Qualquer uma true = SPEC_CHANGE, seja qual for o type declarado.
const IMPACT_FLAGS = [
    'removes_ac',
    'weakens_ac',
    'changes_expected_behavior',
    'changes_business_rule',
    'adds_functional_exception',
    'changes_functional_constraint',
    'changes_functional_scope',
];

// Texto que remove/enfraquece AC ou muda regra de negócio. O objeto do verbo é o próprio
// AC ("remover o AC-02", "AC-02 fica fora do escopo") — "removi o helper usado pelo
// AC-01" não casa. Match precedido de negação ("sem alterar a regra de negócio") não
// conta (affirmative), exceto onde a negação É o sinal ("não atender o AC-02").
const AC = String.raw`AC[-\s]?\d+`;
const ART = String.raw`(?:(?:o|a|os|as|do|da|ao|um|uma)\s+)?(?:(?:criterio|criterios|requisito)\s+(?:de aceite\s+)?)?`;
const REMOVES_AC = [
    new RegExp(String.raw`\b(remov\w*|elimin\w*|exclu\w*|retir\w*|descart\w*|dispens\w*|ignor\w*|suprim\w*|abandon\w*|cancel\w*)\s+${ART}${AC}\b`, 'gi'),
    new RegExp(String.raw`\b${AC}\b\s*(?:\([^)]*\)\s*)?(?:(?:foi|sera|vai ser|fica|ficara|esta|e|passa a ser|deixa de ser)\s+)?(removid\w*|eliminad\w*|excluid\w*|retirad\w*|descartad\w*|dispensad\w*|ignorad\w*|cancelad\w*|fora do escopo|opcional|desnecessari\w*|nao (?:sera|vai ser|e mais|precisa ser) (?:atendid\w*|implementad\w*|necessari\w*|cumprid\w*))`, 'gi'),
];
const NEGATED_AC = new RegExp(String.raw`\b(nao|sem)\s+(atender|implementar|cumprir|cobrir)\s+${ART}${AC}\b`, 'i');
const WEAKENS_AC = [
    new RegExp(String.raw`\b(enfraquec\w*|relax\w*|flexibiliz\w*|afroux\w*|simplific\w*)\s+${ART}${AC}\b`, 'gi'),
    new RegExp(String.raw`\b${AC}\b\s*(?:(?:foi|sera|fica|e)\s+)?(enfraquecid\w*|relaxad\w*|flexibilizad\w*|parcialmente atendid\w*|atendid\w* (?:so )?(?:em parte|parcialmente))`, 'gi'),
];
const BUSINESS_RULE = [
    /\b(alter\w*|mud\w*|troc\w*|substitu\w*|invert\w*|relax\w*|flexibiliz\w*)\s+(?:(?:a|as|uma)\s+)?regras? de negocio\b/gi,
    /\bregras? de negocio\s+(?:foi\s+|sera\s+|fica\s+)?(alterad\w*|mudad\w*|trocad\w*|substituid\w*|invertid\w*|relaxad\w*|flexibilizad\w*|nova)\b/gi,
    /\bnova regra de negocio\b/gi,
];
const FUNCTIONAL_EXCEPTION = [
    /\b(adicion\w*|inclu\w*|abr\w*|cri\w*)\s+(?:(?:uma|a|nova)\s+)*excec(ao|oes)\b/gi,
    /\bexcec(ao|oes)\s+(funcional|de negocio|a regra)\b/gi,
];
const NEGATION_BEFORE = /\b(nao|sem|nenhum\w*|nunca|nem)\b(?:\s+\S+){0,2}\s*$/i;

function affirmative(regexes, text) {
    for (const re of regexes) {
        re.lastIndex = 0;
        let m;
        while ((m = re.exec(text))) {
            if (!NEGATION_BEFORE.test(text.slice(Math.max(0, m.index - 30), m.index))) return true;
        }
    }
    return false;
}

function fold(text) {
    return String(text ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '');
}

function nonEmpty(v) {
    return typeof v === 'string' && v.trim().length > 0;
}

function isIso(v) {
    return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(v) && Number.isFinite(Date.parse(v));
}

function canonAc(id) {
    const m = /^AC[-\s]?(\d+)$/i.exec(String(id || '').trim());
    return m ? acIds.canonicalId(Number(m[1])) : null;
}

function refsIn(text) {
    return [...new Set(acIds.findAcRefs(String(text || '')).map(acIds.canonicalId))];
}

/**
 * Sinais de SPEC_CHANGE no texto da decisão (description/proposed_behavior/rationale).
 * @returns {string[]} flags de IMPACT_FLAGS detectadas.
 */
function detectSpecChange(input) {
    const text = fold([input?.description, input?.proposed_behavior, input?.rationale].filter(nonEmpty).join('\n'));
    const found = [];
    if (affirmative(REMOVES_AC, text) || NEGATED_AC.test(text)) found.push('removes_ac');
    if (affirmative(WEAKENS_AC, text)) found.push('weakens_ac');
    if (affirmative(BUSINESS_RULE, text)) found.push('changes_business_rule');
    if (affirmative(FUNCTIONAL_EXCEPTION, text)) found.push('adds_functional_exception');
    return found;
}

/**
 * Classifica a decisão do agente. Puro.
 * @param {object} input {type, description, rationale, agent?, ac?, ac_affected?,
 *   impact?: {<IMPACT_FLAGS>: bool}, previous_behavior?, proposed_behavior?, ac_changes?}
 * @param {{knownAcs?: string[], activeAcs?: string[], acText?: Map<string,string>, now?: string}} ctx
 * @returns {{errors: string[], decision: object|null}}
 */
function classifyDecision(input, ctx = {}) {
    const errors = [];
    const err = m => errors.push(m);
    if (!input || typeof input !== 'object') return { errors: ['entrada não é um objeto JSON'], decision: null };
    const declared = String(input.type || '').toUpperCase();
    if (!DECISION_TYPES.includes(declared)) err(`type deve ser uma de ${DECISION_TYPES.join(' | ')} (veio ${JSON.stringify(input.type ?? null)})`);
    if (!nonEmpty(input.description)) err('description vazio — diga o que foi decidido');
    if (!nonEmpty(input.rationale)) err('rationale vazio — diga por que (e, se técnica, por que não muda comportamento)');
    const known = ctx.knownAcs ? new Set(ctx.knownAcs) : null;
    const active = ctx.activeAcs ? new Set(ctx.activeAcs) : null;

    const listed = [...(Array.isArray(input.ac_affected) ? input.ac_affected : []), ...(input.ac ? [input.ac] : [])];
    const acAffected = [];
    for (const raw of listed) {
        const id = canonAc(raw);
        if (!id) { err(`ac_affected: ${JSON.stringify(raw)} não é um ID AC-XX`); continue; }
        if (known && !known.has(id)) { err(`ac_affected: ${id} não existe na spec`); continue; }
        if (!acAffected.includes(id)) acAffected.push(id);
    }

    const acChanges = [];
    for (const [i, c] of (Array.isArray(input.ac_changes) ? input.ac_changes : []).entries()) {
        const action = String(c?.action || '').toLowerCase();
        if (!AC_CHANGE_ACTIONS.has(action)) { err(`ac_changes[${i}]: action deve ser remove | replace | add`); continue; }
        const ac = action === 'add' ? null : canonAc(c.ac);
        if (action !== 'add' && !ac) { err(`ac_changes[${i}]: ${action} precisa do ac`); continue; }
        if (ac && active && !active.has(ac)) { err(`ac_changes[${i}]: ${ac} não é um AC ativo da spec`); continue; }
        if (action !== 'remove' && !nonEmpty(c.text)) { err(`ac_changes[${i}]: ${action} precisa do text do critério novo`); continue; }
        acChanges.push({ action, ...(ac ? { ac } : {}), ...(nonEmpty(c.text) ? { text: c.text.trim() } : {}) });
        if (ac && !acAffected.includes(ac)) acAffected.push(ac);
    }
    if (errors.length) return { errors, decision: null };

    const impact = input.impact && typeof input.impact === 'object' ? input.impact : {};
    const flagged = IMPACT_FLAGS.filter(f => impact[f] === true);
    const detected = detectSpecChange(input).filter(f => !flagged.includes(f));
    if (acChanges.some(c => c.action === 'remove' || c.action === 'replace') && !flagged.includes('removes_ac') && !detected.includes('removes_ac')) detected.push('removes_ac');
    if (acChanges.some(c => c.action === 'add') && !flagged.includes('changes_functional_scope')) detected.push('changes_functional_scope');
    const signals = [...flagged, ...detected];
    const type = signals.length ? 'SPEC_CHANGE' : declared;

    const decision = {
        type,
        description: input.description.trim(),
        rationale: input.rationale.trim(),
        agent: nonEmpty(input.agent) ? input.agent.trim() : 'implement',
        timestamp: isIso(input.timestamp) ? input.timestamp : (ctx.now || new Date().toISOString()),
        ...(acAffected.length ? { ac_affected: acAffected } : {}),
    };
    if (type !== declared) {
        decision.declared_type = declared;
        decision.reclassified_reason = `declarada ${declared}, mas ${signals.map(describeSignal).join('; ')} — isso é SPEC_CHANGE e exige aprovação humana`;
    }
    if (signals.length) decision.impact = signals;

    if (type === 'SPEC_CHANGE') {
        // Implement que "decidiu" remover um AC chamando de técnica não preenche o
        // antes/depois: derivado da spec e da própria descrição, para a proposta seguir.
        const refs = acAffected.length ? acAffected : refsIn(`${input.description}\n${input.proposed_behavior || ''}`).filter(id => !known || known.has(id));
        if (refs.length) decision.ac_affected = refs;
        decision.ac_affected = decision.ac_affected || [];
        decision.previous_behavior = nonEmpty(input.previous_behavior)
            ? input.previous_behavior.trim()
            : (refs.length && ctx.acText ? refs.map(id => `${id}: ${ctx.acText.get(id) || '(texto não encontrado na spec)'}`).join(' | ') : '(não informado pelo agente — ver a spec na versão do spec_hash)');
        decision.proposed_behavior = nonEmpty(input.proposed_behavior) ? input.proposed_behavior.trim() : decision.description;
        if (acChanges.length) decision.ac_changes = acChanges;
        // Vínculo ESTRUTURADO com o human input que motivou a proposta (opcional). Só
        // message_hash/at — conferidos contra state.human_input_interpretations na
        // aprovação; citar o human input no rationale não cria vínculo nenhum.
        const humanRefs = (Array.isArray(input.human_input_refs) ? input.human_input_refs : [])
            .filter(r => r && typeof r.message_hash === 'string' && /^[\w-]{1,128}$/.test(r.message_hash))
            .map(r => ({ message_hash: r.message_hash, ...(isIso(r.at) ? { at: r.at } : {}) }));
        if (humanRefs.length) decision.human_input_refs = humanRefs;
    } else {
        // TECHNICAL_DECISION segue automaticamente: o timestamp vale como approved_at (o
        // registro que o Review exige do DOCUMENTED_TECHNICAL_DECISION, por ac).
        if (acAffected.length) decision.ac = acAffected[0];
        if (type === 'TECHNICAL_DECISION') decision.approved_at = decision.timestamp;
    }
    return { errors: [], decision };
}

function describeSignal(flag) {
    return {
        removes_ac: 'remove AC (ou deixa de atendê-lo)',
        weakens_ac: 'enfraquece AC',
        changes_expected_behavior: 'altera comportamento esperado',
        changes_business_rule: 'muda regra de negócio',
        adds_functional_exception: 'adiciona exceção funcional',
        changes_functional_constraint: 'altera restrição funcional',
        changes_functional_scope: 'expande/reduz escopo funcional',
    }[flag] || flag;
}

// ── Auditoria (append-only) ──────────────────────────────────────────────────────

function readJson(file) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function writeJsonAtomic(file, data) {
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n');
    fs.renameSync(tmp, file);
}

function readAudit(runDir) {
    const data = readJson(path.join(runDir, AUDIT_FILE));
    return data && Array.isArray(data.entries) ? data : { entries: [] };
}

/** Acrescenta uma entrada. Nunca reescreve nem remove as anteriores. */
function appendAudit(runDir, taskId, entry) {
    const file = path.join(runDir, AUDIT_FILE);
    const audit = readAudit(runDir);
    const entries = [...audit.entries, entry];
    writeJsonAtomic(file, { task_id: audit.task_id || taskId, entries });
    return entries.length;
}

function nextProposalId(audit) {
    const nums = audit.entries.map(e => /^SC-(\d+)$/.exec(e.id || '')).filter(Boolean).map(m => Number(m[1]));
    return `SC-${String((nums.length ? Math.max(...nums) : 0) + 1).padStart(3, '0')}`;
}

// ── Contexto do run ──────────────────────────────────────────────────────────────

function readState(runDir) {
    return readJson(path.join(runDir, 'state.json'));
}

function writeState(runDir, state) {
    stateWriter.write(runDir, state, { operation: 'spec_change_record', actor: 'agent' });
}

/** operation_id da decisão humana sobre uma SPEC_CHANGE: o change_id (SC-NNN@task-id). */
function changeIdOf(proposal, taskId) {
    return proposal?.id ? `${proposal.id}@${taskId}` : null;
}

/**
 * Lock + idempotência + CAS da decisão humana (aprovar/rejeitar): o operation_id é o
 * change_id, as expectativas são o que o caller leu (`expect`) ou, sem isso, a leitura
 * de agora. Devolve { lock } ou { result } (already_processed / conflito / sem proposta).
 */
function lockDecision(runDir, expect, verb) {
    const pre = readState(runDir);
    if (!pre) return { result: { ok: false, error: `${runDir}: state.json ausente ou ilegível` } };
    const taskId = pre.task_id || path.basename(path.resolve(runDir));
    const operationId = expect?.operation_id ?? changeIdOf(pre.spec_change_pending, taskId);
    if (!operationId) return { result: { ok: false, error: `task não está em ${PENDING_STATUS} (status=${pre.status})` } };
    let lock;
    try {
        const { expected_state_version, expected_spec_hash } = cas.expectations(cas.snapshotOf(pre), expect);
        lock = cas.validateAndLock({
            runDir, operation: 'spec_change_approval', actor: `spec-change:${verb}`, operation_id: operationId,
            expected_state_version, expected_spec_hash,
        });
    } catch (e) {
        if (!cas.isConflict(e)) throw e;
        return { result: { ok: false, code: e.code, conflicts: e.conflicts, error: e.message } };
    }
    if (lock.status === 'already_processed') return { result: { ok: true, status: 'already_processed', operation_id: operationId } };
    return { lock };
}

function pushEvent(state, event) {
    state.events = Array.isArray(state.events) ? state.events : [];
    state.events.push({ ts: event.at, ...event });
}

function loadSpec(runDir, state) {
    const root = sa.rootOfRunDir(path.resolve(runDir));
    const taskId = state?.task_id || path.basename(path.resolve(runDir));
    const specPath = sa.specRelFor(state, taskId);
    const content = sa.readSpec(root, specPath);
    const parsed = content ? sa.specAcs(content) : { acs: [] };
    return {
        root, taskId, specPath, content,
        knownAcs: parsed.acs.map(a => a.id),
        activeAcs: parsed.acs.filter(a => a.active).map(a => a.id),
        acText: new Map(parsed.acs.map(a => [a.id, a.head])),
    };
}

// ── Handoff ──────────────────────────────────────────────────────────────────────

function renderPendingBlock(p, { approvalKeyword = 'aprovado', rejectionKeyword = 'rejeitado' } = {}) {
    return [
        HANDOFF_START,
        `## SPEC_CHANGE ${p.id} — aguardando aprovação humana (pipeline pausado)`,
        '',
        'O /implement encontrou uma mudança de requisito funcional e NÃO pode aprová-la. Nada segue até um humano decidir.',
        '',
        `- **ACs afetados:** ${p.ac_affected?.length ? p.ac_affected.join(', ') : '(nenhum AC específico — regra/restrição/escopo)'}`,
        `- **Comportamento atual (spec):** ${p.previous_behavior}`,
        `- **Comportamento proposto:** ${p.proposed_behavior}`,
        `- **Motivo:** ${p.rationale}`,
        `- **Proposto por:** ${p.agent} em ${p.timestamp}`,
        ...(p.reclassified_reason ? [`- **Reclassificação:** ${p.reclassified_reason}`] : []),
        ...(p.ac_changes?.length ? [`- **Edição da spec se aprovada:** ${p.ac_changes.map(c => c.action === 'add' ? `adicionar AC "${c.text}"` : c.action === 'remove' ? `remover ${c.ac}` : `substituir ${c.ac} por "${c.text}"`).join('; ')}`] : []),
        '',
        `Aprovar: responda no ticket com um comentário começando por "${approvalKeyword}" (ou botão no dashboard) — a spec ganha a entrada no "## Histórico de Mudanças", o spec_hash é recalculado e a task volta para o /plan.`,
        `Rejeitar: comentário começando por "${rejectionKeyword}" — a task fica pausada (spec-change-rejected) até alguém decidir implementar a spec como está (mensagem pelo dashboard dizendo como seguir).`,
        `Auditoria: memory/runs/<task-id>/${AUDIT_FILE}.`,
        HANDOFF_END,
    ].join('\n');
}

function upsertHandoffBlock(content, block) {
    const base = content || '';
    const start = base.indexOf(HANDOFF_START);
    const end = base.indexOf(HANDOFF_END);
    if (start !== -1 && end > start) return base.slice(0, start) + block + base.slice(end + HANDOFF_END.length);
    return `${base.replace(/\s*$/, '')}${base.trim() ? '\n\n' : ''}${block}\n`;
}

function writeHandoffBlock(runDir, block) {
    const file = path.join(runDir, 'handoff.md');
    const current = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    fs.writeFileSync(file, upsertHandoffBlock(current, block));
}

// ── Registro (nó /implement) ─────────────────────────────────────────────────────

/**
 * Registra a decisão. TECHNICAL_DECISION/SPEC_CLARIFICATION → technical_decisions[],
 * segue. SPEC_CHANGE → audit + pausa (status spec-change-pending-approval).
 * @returns {{errors: string[], decision: object|null, paused: boolean}}
 */
function recordDecision(runDir, input, { now = new Date().toISOString(), keywords } = {}) {
    const state = readState(runDir);
    if (!state) return { errors: [`${runDir}: state.json ausente ou ilegível`], decision: null, paused: false };
    const spec = loadSpec(runDir, state);
    const { errors, decision } = classifyDecision(input, {
        knownAcs: spec.content ? spec.knownAcs : null, activeAcs: spec.content ? spec.activeAcs : null, acText: spec.acText, now,
    });
    if (errors.length) return { errors, decision: null, paused: false };

    if (decision.type !== 'SPEC_CHANGE') {
        state.technical_decisions = Array.isArray(state.technical_decisions) ? state.technical_decisions : [];
        state.technical_decisions.push(decision);
        state.updated_at = now;
        writeState(runDir, state);
        return { errors: [], decision, paused: false };
    }

    if (state.spec_change_pending) {
        return {
            errors: [`já existe SPEC_CHANGE pendente (${state.spec_change_pending.id}) — junte as mudanças numa única proposta; o pipeline já está pausado`],
            decision: null, paused: true,
        };
    }
    const audit = readAudit(runDir);
    const proposal = {
        id: nextProposalId(audit),
        ...decision,
        task_id: spec.taskId,
        spec_path: spec.content ? spec.specPath : null,
        spec_hash: spec.content ? sa.specHashFor(state, spec.content) : null,
        spec_version: specVersion.versionOf(state),
        node: state.node || 'implement',
    };
    appendAudit(runDir, spec.taskId, { event: 'proposed', ...proposal });
    state.status = PENDING_STATUS;
    state.spec_change_pending = proposal;
    pushEvent(state, {
        type: 'spec_change_proposed', node: decision.agent, at: now,
        detail: `SPEC_CHANGE ${proposal.id} (${proposal.ac_affected.join(', ') || 'sem AC específico'}) aguardando aprovação humana — pipeline pausado`,
    });
    state.updated_at = now;
    writeState(runDir, state);
    writeHandoffBlock(runDir, renderPendingBlock(proposal, keywords));
    return { errors: [], decision: proposal, paused: true };
}

// ── Spec auditável ───────────────────────────────────────────────────────────────

function day(iso) {
    return String(iso).slice(0, 10);
}

/** Seção (por cabeçalho normalizado): {start, end, level} em índices de linha, ou null. */
function findSection(lines, re) {
    for (let i = 0; i < lines.length; i++) {
        const h = parseHeading(lines[i]);
        if (!h || !re.test(normalizeHeading(h.text))) continue;
        let end = lines.length;
        for (let j = i + 1; j < lines.length; j++) {
            const n = parseHeading(lines[j]);
            if (n && n.level <= h.level) { end = j; break; }
        }
        return { start: i, end, level: h.level };
    }
    return null;
}

function lastContentLine(lines, from, to) {
    for (let i = to - 1; i > from; i--) if (lines[i].trim()) return i;
    return from;
}

/**
 * Aplica a SPEC_CHANGE aprovada ao texto da spec sem apagar nada: ac_changes (marca de
 * remoção / AC novo com ID novo) + entrada em "## Histórico de Mudanças".
 * @returns {{content: string, added: string[]}}
 */
function applyToSpec(specContent, proposal, { approvedBy, approvedAt }) {
    const eol = specContent.includes('\r\n') ? '\r\n' : '\n';
    const lines = specContent.replace(/\r\n?/g, '\n').split('\n');
    const added = [];
    const changes = Array.isArray(proposal.ac_changes) ? proposal.ac_changes : [];
    if (changes.length) {
        const section = findSection(lines, AC_HEADING);
        if (section) {
            const nums = sa.specAcs(specContent).acs.map(a => a.num);
            let next = (nums.length ? Math.max(...nums) : 0) + 1;
            const newLines = [];
            for (const c of changes) {
                let replacement = null;
                if (c.action !== 'remove') {
                    replacement = acIds.canonicalId(next++);
                    added.push(replacement);
                    newLines.push(`- ${replacement}: ${c.text} (adicionado em ${day(approvedAt)}: SPEC_CHANGE ${proposal.id}${c.ac ? `, substitui ${c.ac}` : ''})`);
                }
                if (!c.ac) continue;
                const num = acIds.idNumber(c.ac);
                const item = new RegExp(String.raw`^\s*(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s*)?[*_\x60]*AC-0*${num}(?!\d)`);
                for (let i = section.start + 1; i < section.end; i++) {
                    if (!item.test(lines[i])) continue;
                    const why = replacement ? `substituído por ${replacement} — SPEC_CHANGE ${proposal.id}` : `SPEC_CHANGE ${proposal.id}`;
                    lines[i] = `${lines[i].replace(/\s+$/, '')} (removido em ${day(approvedAt)}: ${why})`;
                    break;
                }
            }
            if (newLines.length) lines.splice(lastContentLine(lines, section.start, section.end) + 1, 0, ...newLines);
        }
    }
    const entry = [
        `### ${proposal.id} · ${approvedAt} · aprovado por ${approvedBy}`,
        `- ACs afetados: ${proposal.ac_affected?.length ? proposal.ac_affected.join(', ') : '—'}${added.length ? ` (novos: ${added.join(', ')})` : ''}`,
        `- Antes: ${proposal.previous_behavior}`,
        `- Depois: ${proposal.proposed_behavior}`,
        `- Motivo: ${proposal.rationale}`,
        `- Proposto por: ${proposal.agent} em ${proposal.timestamp}`,
    ];
    const history = findSection(lines, HISTORY_HEADING);
    if (history) {
        lines.splice(lastContentLine(lines, history.start, history.end) + 1, 0, '', ...entry);
    } else {
        while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
        lines.push('', '## Histórico de Mudanças', '', '<!-- SPEC_CHANGE aprovadas (scripts/lib/spec-change.js). Só APPEND: nunca apague entradas. -->', '', ...entry);
    }
    return { content: lines.join('\n').replace(/\n*$/, '\n').replace(/\n/g, eol), added };
}

// ── Aprovação / rejeição (humano, via watcher ou CLI) ────────────────────────────

/**
 * SPEC_CHANGE aprovada: audit, spec, hash, artefatos stale e volta ao Plan.
 * @returns {{ok: boolean, error?: string, proposal?: object, specHash?: string}}
 */
// `expect` (scripts/cas.js): { expected_state_version, expected_spec_hash, operation_id }
// do que o caller leu antes de decidir. A 2ª aprovação do mesmo change_id devolve
// { ok: true, status: 'already_processed' } sem aplicar nada.
function approveSpecChange(runDir, { by, at = new Date().toISOString(), approvalJournalId = null, expect = null } = {}) {
    const { lock, result } = lockDecision(runDir, expect, 'approve');
    if (result) return result;
    try {
        return applyApproval(runDir, lock, { by, at, approvalJournalId });
    } finally {
        lock.release();
    }
}

function applyApproval(runDir, lock, { by, at, approvalJournalId }) {
    const state = lock.state;
    if (!state) return { ok: false, error: `${runDir}: state.json ausente ou ilegível` };
    const proposal = state.spec_change_pending;
    if (state.status !== PENDING_STATUS || !proposal) return { ok: false, error: `task não está em ${PENDING_STATUS} (status=${state.status})` };
    if (!nonEmpty(by)) return { ok: false, error: 'aprovação sem autor (--by)' };
    const spec = loadSpec(runDir, state);
    const taskId = spec.taskId;
    const oldRef = invalidate.specRef(state);
    const transitionId = `${proposal.id}@${taskId}`;

    let newHash = null;
    let added = [];
    let appliedContent = null;
    if (spec.content != null) {
        const applied = applyToSpec(spec.content, proposal, { approvedBy: by, approvedAt: at });
        added = applied.added;
        appliedContent = applied.content;
        newHash = sa.specHashFor(state, applied.content);
    }
    // Corrida 2: a transição é registrada nos outros runs ativos sobre a mesma spec ANTES
    // de a spec nova chegar ao disco — um run que só observar o hash novo depois disto já
    // é participante da transição (scripts/invalidate.js propagateSpecChange).
    const predictedVersion = predictVersion(spec, state, newHash);
    const propagated = newHash && !state.dry_run
        ? invalidate.propagateSpecChange({
            runsDir: path.dirname(path.resolve(runDir)), specPath: spec.specPath, specRelFor: sa.specRelFor,
            oldSpec: oldRef.hash ? oldRef : { hash: proposal.spec_hash || null, version: oldRef.version },
            newSpec: { hash: newHash, version: predictedVersion },
            triggeredBy: `SPEC_CHANGE ${proposal.id}`, transitionId, excludeTaskId: path.basename(path.resolve(runDir)), at,
        })
        : [];
    if (appliedContent != null) fs.writeFileSync(path.resolve(spec.root, spec.specPath), appliedContent);
    const { node: _node, ...rest } = proposal;
    const auditIndex = appendAudit(runDir, taskId, {
        event: 'approved', ...rest, approved_by: 'human', approver: by, approved_at: at,
        spec_hash_before: proposal.spec_hash, spec_hash_after: newHash, ...(added.length ? { ac_added: added } : {}),
        // comment_id é o journal que o watcher POSTOU com a proposta; a resposta humana
        // de aprovação é outro journal. Nunca um no lugar do outro (EC-4).
        proposal_comment_id: Number.isInteger(proposal.comment_id) ? proposal.comment_id : null,
        approval_journal_id: Number.isInteger(approvalJournalId) ? approvalJournalId : null,
    });

    // Releitura: o arquivo pode ter mudado entre o loadSpec e aqui só pela spec.
    const fresh = readState(runDir) || state;
    // spec_version: só incrementa se a SPEC_CHANGE aprovada alterou o HASH_SCOPE.
    const version = spec.content != null
        ? specVersion.bump(fresh, {
            root: spec.root, oldContent: spec.content, newContent: fs.readFileSync(path.resolve(spec.root, spec.specPath), 'utf8'),
            reason: `SPEC_CHANGE ${proposal.id}: ${proposal.proposed_behavior}`.slice(0, 300),
            approvalRef: `${AUDIT_FILE}#entry-${auditIndex}`, specChangeId: proposal.id, approvedBy: by,
            by: 'spec-change-approval', now: at, runId: taskId,
        })
        : { bumped: false, reason: 'sem spec' };
    if (newHash) {
        fresh.spec_change_approved = true;
        fresh.spec_change_hash = newHash;
        fresh.spec_hash = newHash;
        fresh.spec_hash_at = at;
        fresh.spec_hash_by = 'spec-change-approval';
        fresh.spec_path = spec.specPath;
        const block = specVersion.readSpecBlock(fresh);
        if (block && block.hash === newHash) fresh.spec_hash_version = block.version;
        const acs = sa.specAcs(fs.readFileSync(path.resolve(spec.root, spec.specPath), 'utf8')).acs;
        if (acs.length) fresh.ac_ids = acs.map(a => a.id);
    }
    if (Number.isInteger(predictedVersion) && Number.isInteger(version.version) && version.version !== predictedVersion) {
        pushEvent(fresh, { type: 'spec_version_error', node: 'plan', at, detail: `versão prevista para a propagação (v${predictedVersion}) ≠ versão gravada (v${version.version}) — os runs irmãos sincronizam pela versão prevista; confira o changelog` });
    }
    // INV-SPEC-CHANGE-REPLAN (scripts/invalidate.js — o único que decide o que fica STALE):
    // toda SPEC_CHANGE aprovada invalida os artefatos derivados e volta ao /plan, com hash
    // igual ou não. Hash igual (mudança fora do HASH_SCOPE) só mantém a spec_version.
    const inv = invalidate.applySpecChange(fresh, {
        oldSpec: oldRef.hash ? oldRef : { hash: proposal.spec_hash || null, version: oldRef.version },
        newSpec: { hash: newHash || oldRef.hash || proposal.spec_hash || null, version: Number.isInteger(version.version) ? version.version : oldRef.version },
        triggeredBy: `SPEC_CHANGE ${proposal.id}`, transitionId, cause: invalidate.APPROVED, runDir, at, evidenceData: invalidate.readEvidence(runDir),
    });
    fresh.node = 'plan';
    fresh.status = 'in_progress';
    delete fresh.spec_change_pending;
    delete fresh.spec_drift;
    pushEvent(fresh, {
        type: 'spec_change_approved', node: 'plan', at,
        detail: `SPEC_CHANGE ${proposal.id} aprovada por ${by} — spec atualizada (Histórico de Mudanças${added.length ? `, ${added.join(', ')} novos` : ''}), spec_hash ${String(newHash || '—').slice(0, 12)}` +
            `${version.bumped ? `, spec v${version.version}` : version.reason === 'hash_scope_unchanged' ? `, spec v${version.version} mantida (HASH_SCOPE inalterado)` : ''}; ` +
            `${STALE_ON_APPROVAL.join(', ')} stale; task volta para o /plan (INV-SPEC-CHANGE-REPLAN)`,
    });
    const provenance = recordSpecChangeProvenance(spec, fresh, proposal, {
        added, auditIndex, newHash, version, approvalJournalId, taskId,
    });
    if (provenance?.error) pushEvent(fresh, { type: 'ac_provenance_failed', node: 'plan', at, detail: provenance.error });
    fresh.updated_at = at;
    lock.commit(fresh);
    invalidate.syncEvidenceFile(runDir, fresh);
    writeHandoffBlock(runDir, [
        HANDOFF_START,
        `## SPEC_CHANGE ${proposal.id} — APROVADA por ${by} em ${at}`,
        '',
        `Spec atualizada (ver "## Histórico de Mudanças"). Este handoff está stale: o /plan regera plan.md e handoff.md sobre a spec nova; acceptance-evidence.json é regerado pelo /test.`,
        HANDOFF_END,
    ].join('\n'));
    return { ok: true, proposal, specHash: newHash, added, specVersion: version, provenance, invalidation: inv, propagated };
}

/** Versão que a aprovação vai gravar (a mesma conta de spec-version.bump), antes de gravar. */
function predictVersion(spec, state, newHash) {
    const block = specVersion.readSpecBlock(state);
    if (!block || !newHash) return null;
    if (invalidate.classify(block.hash, newHash) === invalidate.VALID) return block.version;
    const latest = specVersion.currentEntry(specVersion.readChangelog(spec.root, block.changelog_path).data);
    return Math.max(block.version, latest?.version ?? 0) + 1;
}

// ACs que a SPEC_CHANGE tocou, na ordem em que applyToSpec atribuiu os IDs novos.
function touchedAcs(proposal, added) {
    const out = [];
    let next = 0;
    for (const c of Array.isArray(proposal.ac_changes) ? proposal.ac_changes : []) {
        const created = c.action !== 'remove' ? added[next++] : null;
        if (created) out.push({ ac: created, action: c.action === 'replace' ? 'replace' : 'add', ...(c.ac ? { replaces: c.ac } : {}) });
        if (c.ac) out.push({ ac: c.ac, action: c.action === 'remove' ? 'remove' : 'replace', ...(created ? { replaced_by: created } : {}) });
    }
    for (const ac of Array.isArray(proposal.ac_affected) ? proposal.ac_affected : []) {
        if (!out.some(t => t.ac === ac)) out.push({ ac, action: 'affected' });
    }
    return out;
}

/**
 * Provenance da SPEC_CHANGE aprovada (scripts/lib/ac-provenance.js): append no log do
 * ticket, no checkout principal. HUMAN_CLARIFICATION só com human_input_refs válidos.
 * Falha não desfaz a aprovação — volta como {error} e vira evento no state.
 */
function recordSpecChangeProvenance(spec, state, proposal, { added, auditIndex, newHash, version, approvalJournalId, taskId }) {
    if (state.dry_run) return null;
    const ticket = acProvenance.ticketOf(taskId, state);
    if (!ticket) return { error: `provenance não registrada: ticket não identificado para ${taskId}` };
    const touched = touchedAcs(proposal, added);
    if (!touched.length) return { added: [], skipped: [], human_input_refs_invalid: [] };
    const refs = acProvenance.validateHumanInputRefs(proposal.human_input_refs, state.human_input_interpretations);
    const events = acProvenance.specChangeEvents(ticket, touched, {
        change_id: proposal.id, approval_ref: `${AUDIT_FILE}#entry-${auditIndex}`,
        proposal_comment_id: Number.isInteger(proposal.comment_id) ? proposal.comment_id : null,
        approval_journal_id: Number.isInteger(approvalJournalId) ? approvalJournalId : null,
        spec_hash_before: proposal.spec_hash ?? null, spec_hash_after: newHash,
        previous_version: Number.isInteger(proposal.spec_version) ? proposal.spec_version : null,
        new_version: Number.isInteger(version?.version) ? version.version : null,
        task_id: taskId,
    }, refs.valid);
    try {
        const out = acProvenance.appendEvents(ticket, events, { root: acProvenance.provenanceRoot(spec.root) });
        if (!out.ok) return { error: `provenance não registrada: ${out.errors.join('; ')}` };
        return { added: out.added, skipped: out.skipped, human_input_refs_invalid: refs.invalid };
    } catch (e) {
        return { error: `provenance não registrada: ${e.message}` };
    }
}

/** SPEC_CHANGE rejeitada: audit e pausa (spec-change-rejected). */
function rejectSpecChange(runDir, { by, at = new Date().toISOString(), reason, expect = null } = {}) {
    const { lock, result } = lockDecision(runDir, expect, 'reject');
    if (result) return result;
    try {
        return applyRejection(runDir, lock, { by, at, reason });
    } finally {
        lock.release();
    }
}

function applyRejection(runDir, lock, { by, at, reason }) {
    const state = lock.state;
    if (!state) return { ok: false, error: `${runDir}: state.json ausente ou ilegível` };
    const proposal = state.spec_change_pending;
    if (state.status !== PENDING_STATUS || !proposal) return { ok: false, error: `task não está em ${PENDING_STATUS} (status=${state.status})` };
    if (!nonEmpty(by)) return { ok: false, error: 'rejeição sem autor (--by)' };
    const taskId = state.task_id || path.basename(path.resolve(runDir));
    const { node: _node, ...rest } = proposal;
    appendAudit(runDir, taskId, {
        event: 'rejected', ...rest, rejected_by: 'human', rejector: by, rejected_at: at, ...(nonEmpty(reason) ? { rejection_reason: reason.trim() } : {}),
    });
    state.status = REJECTED_STATUS;
    state.spec_change_rejected = { ...proposal, rejected_by: 'human', rejector: by, rejected_at: at, ...(nonEmpty(reason) ? { rejection_reason: reason.trim() } : {}) };
    delete state.spec_change_pending;
    pushEvent(state, {
        type: 'spec_change_rejected', node: proposal.node || 'implement', at,
        detail: `SPEC_CHANGE ${proposal.id} rejeitada por ${by} — spec inalterada, pipeline pausado até decisão humana (implementar a spec como está: node="implement", status="in_progress")`,
    });
    state.updated_at = at;
    lock.commit(state);
    writeHandoffBlock(runDir, [
        HANDOFF_START,
        `## SPEC_CHANGE ${proposal.id} — REJEITADA por ${by} em ${at}`,
        '',
        `A spec NÃO muda: o comportamento proposto ("${proposal.proposed_behavior}") não foi aceito${nonEmpty(reason) ? ` (${reason.trim()})` : ''}. Implemente ${proposal.ac_affected?.length ? proposal.ac_affected.join(', ') : 'o critério'} como a spec diz.`,
        HANDOFF_END,
    ].join('\n'));
    return { ok: true, proposal };
}

// ── Artefatos stale ──────────────────────────────────────────────────────────────

/**
 * Tira de stale_artifacts o que foi regerado depois da invalidação. Quem decide se o
 * arquivo foi regerado é scripts/invalidate.js (isRegenerated: o artefato da fase voltou a
 * VALID depois de stale_since; run anterior ao artifact_validity cai no mtime).
 * Muta state. @returns {boolean} mudou.
 */
function refreshStale(state, runDir, { io = fs } = {}) {
    const list = Array.isArray(state?.stale_artifacts) ? state.stale_artifacts : null;
    if (!list || !list.length) return false;
    if (!Number.isFinite(Date.parse(state.stale_since || ''))) return false;
    const keep = list.filter(name => !invalidate.isRegenerated(state, name, runDir, { io }));
    if (keep.length === list.length) return false;
    if (keep.length) state.stale_artifacts = keep;
    else { delete state.stale_artifacts; delete state.stale_since; }
    return true;
}

/**
 * Antes de nó guardado: plan.md/handoff.md stale = o HOW é da spec antiga → volta pro Plan.
 * Muta state. @returns {{proceed: boolean, rerouted: boolean, stale: string[]}}
 */
function staleGate(state, node, { now = new Date().toISOString() } = {}) {
    const stale = Array.isArray(state?.stale_artifacts) ? state.stale_artifacts : [];
    if (node === 'plan' || !sa.GUARDED_NODES.has(node) || !stale.some(a => PLAN_ARTIFACTS.has(a))) return { proceed: true, rerouted: false, stale };
    state.node = 'plan';
    pushEvent(state, {
        type: 'stale_artifacts_replan', node: 'plan', at: now,
        detail: `${stale.filter(a => PLAN_ARTIFACTS.has(a)).join(', ')} stale (SPEC_CHANGE aprovada) — ${node} não roda sobre o HOW da spec antiga; task volta para o /plan`,
    });
    state.updated_at = now;
    return { proceed: false, rerouted: true, stale };
}

function template() {
    return {
        type: DECISION_TYPES.join(' | '),
        description: '<o que foi decidido, em uma frase>',
        rationale: '<por quê; se TECHNICAL_DECISION/SPEC_CLARIFICATION, por que não muda comportamento nem reduz AC>',
        agent: 'implement',
        ac_affected: ['AC-XX (ou [] quando não toca AC)'],
        impact: Object.fromEntries(IMPACT_FLAGS.map(f => [f, false])),
        previous_behavior: '<SPEC_CHANGE: o que a spec diz hoje>',
        proposed_behavior: '<SPEC_CHANGE: o que passaria a valer>',
        ac_changes: [{ action: 'remove | replace | add', ac: 'AC-XX (remove/replace)', text: '<critério novo (replace/add)>' }],
        human_input_refs: [{ message_hash: '<opcional: message_hash de state.human_input_interpretations[] que motivou a mudança>', at: '<at da mesma entrada>' }],
    };
}

module.exports = {
    classifyDecision, detectSpecChange, recordDecision, approveSpecChange, rejectSpecChange,
    applyToSpec, refreshStale, staleGate, readAudit, appendAudit, renderPendingBlock, upsertHandoffBlock, template,
    DECISION_TYPES, IMPACT_FLAGS, PENDING_STATUS, REJECTED_STATUS, AUDIT_FILE, STALE_ON_APPROVAL,
    HANDOFF_START, HANDOFF_END,
};

if (require.main === module) {
    const args = process.argv.slice(2);
    const flag = name => { const a = args.find(x => x === `--${name}` || x.startsWith(`--${name}=`)); return a === undefined ? undefined : (a.includes('=') ? a.split('=').slice(1).join('=') : true); };
    const [cmd, target] = args.filter(a => !a.startsWith('--'));
    const usage = () => {
        console.error('Uso: node scripts/lib/spec-change.js record <run-dir> --input=<decision.json> | approve <run-dir> --by=<nome> | reject <run-dir> --by=<nome> [--reason=...] | status <run-dir> | template');
        process.exit(2);
    };
    if (cmd === 'template') { console.log(JSON.stringify(template(), null, 2)); process.exit(0); }
    if (!cmd || !target || !fs.existsSync(path.join(target, 'state.json'))) usage();
    const { approvalKeyword, rejectionKeyword } = require('./spec-validator');
    const keywords = { approvalKeyword: approvalKeyword(), rejectionKeyword: rejectionKeyword() };

    if (cmd === 'record') {
        const file = flag('input');
        if (typeof file !== 'string') usage();
        const input = readJson(file);
        if (!input) { console.error(`${file}: JSON ausente ou inválido`); process.exit(2); }
        const out = recordDecision(target, input, { keywords });
        if (out.errors.length) {
            console.error('[spec-change] entrada inválida — nada gravado:');
            for (const e of out.errors) console.error(`- ${e}`);
            process.exit(out.paused ? 4 : 2);
        }
        const d = out.decision;
        if (!out.paused) {
            console.log(`[spec-change] ${d.type} registrada em state.json.technical_decisions[] — segue.${d.type === 'SPEC_CLARIFICATION' ? ' O /review confere esta classificação.' : ''}`);
            process.exit(0);
        }
        if (d.reclassified_reason) console.error(`[spec-change] RECLASSIFICADA: ${d.reclassified_reason}.`);
        console.error(`[spec-change] SPEC_CHANGE ${d.id} registrada em ${AUDIT_FILE}; status="${PENDING_STATUS}". PARE: o /implement não aprova mudança de requisito. O watcher publica a proposta no Redmine e espera a decisão humana.`);
        process.exit(4);
    }
    if (cmd === 'approve' || cmd === 'reject') {
        const by = flag('by');
        const out = cmd === 'approve'
            ? approveSpecChange(target, { by: typeof by === 'string' ? by : '', approvalJournalId: /^\d+$/.test(String(flag('journal') ?? '')) ? Number(flag('journal')) : null })
            : rejectSpecChange(target, { by: typeof by === 'string' ? by : '', reason: typeof flag('reason') === 'string' ? flag('reason') : undefined });
        if (!out.ok) { console.error(`[spec-change] ${out.error}`); process.exit(2); }
        console.log(cmd === 'approve'
            ? `[spec-change] ${out.proposal.id} aprovada — spec_hash ${out.specHash || '—'}${out.specVersion?.version != null ? `; spec v${out.specVersion.version}${out.specVersion.bumped ? ' (nova)' : ' (mantida)'}` : ''}; ` +
              `artefatos derivados STALE (scripts/invalidate.js, INV-SPEC-CHANGE-REPLAN); node="plan".${out.propagated?.length ? ` Transição registrada em: ${out.propagated.map(p => `${p.task} (${p.case})`).join(', ')}.` : ''}`
            : `[spec-change] ${out.proposal.id} rejeitada — status="${REJECTED_STATUS}" (pausado).`);
        process.exit(0);
    }
    if (cmd === 'status') {
        const state = readState(target);
        console.log(JSON.stringify({
            status: state.status, spec_change_pending: state.spec_change_pending || null,
            stale_artifacts: state.stale_artifacts || [], audit_entries: readAudit(target).entries.length,
        }, null, 2));
        process.exit(0);
    }
    usage();
}
