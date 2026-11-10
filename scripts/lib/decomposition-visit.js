// Visita ao Implement da Run decomposta (PRI-311 / PRI-287 S5.2b; SPEC tasks/pri-287-s5/SPEC.md
// v2.1 B2, B5, B6 e o adendo SPEC-s5.2.md v2.1). Decide; não grava o state.json nem despacha.
//
// - B2: `decomposition` da visita a partir do plano (subtask-decomposition.decomposePlan, S5.1),
//   gravado pelo watcher com writeTaskState (CAS). Replan = nova plan_version; as chaves antigas
//   vão para `superseded[]` e nada é herdado por posição.
// - B5: próxima ação da visita — subtarefa (uma por vez, na ordem do menor passo), integração,
//   agregação — a partir dos Attempts com papel gravados pelo DOM-06. Nenhum estado paralelo:
//   o que já rodou é o que o DOM-06 gravou.
// - B5.7: volta de gate → rework das chaves com achado mapeado por arquivo; achado sem
//   mapeamento inequívoco → rework do nó inteiro com a chave sintética `<pv12>/ALL` (C4).
// - B5.3/B5.8 (Q7 a): piso da linhagem (rework ≥ resolução inicial; scope_violation e ALL ≥ C4
//   com RISK_RECLASSIFIED). Override humano prevalece (aplicado em model-routing.resolveRoute).
// - B6: bloco de contexto (Context Record, hash no Attempt) e DoD derivado (insumo, nunca gate).
//
// Sem a S5.3: failure_class = null e sem proposta (B5.9).

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const planSignals = require('./plan-signals');
const subtaskDecomposition = require('./subtask-decomposition');
const dom06 = require('./dom06-attempt');
const manifest = require('./workspace-manifest');
const runtime = require('./decomposition-runtime');
const wouldRoute = require('./would-route');

const UNKNOWN = planSignals.UNKNOWN;
const CLASS_RANK = wouldRoute.CLASS_RANK;
const RISK = 'RISK_RECLASSIFIED';

const seqOf = a => (Number.isInteger(a && a.seq) ? a.seq : 0);
const last = list => (list.length ? list[list.length - 1] : null);

/** Snapshot da Run admitido com a decomposição ligada (só o harness monta "on" antes da liberação). */
function isDecomposedSnapshot(snapshot) {
    return Boolean(snapshot && snapshot.decomposition === 'on');
}

const planVisits = state => (Array.isArray(state && state.history) ? state.history.filter(n => n === 'plan').length : 0);

/**
 * B2: decomposição da visita. Mesma plan_version já gravada → nada muda. Nova (primeira visita
 * ou replan) → objeto novo, com as chaves da versão anterior em `superseded[]`. Versão nova sem
 * visita ao nó Plan depois da gravação anterior (plan.md editado fora do Plan) não é aceita:
 * `refused = PLAN_CHANGED_OUTSIDE_PLAN` (o histórico não é reinterpretado pelo "latest").
 * @returns {{ changed: boolean, decomposition: object, refused?: string }}
 */
function recordDecomposition(state, planContent, at = new Date().toISOString()) {
    const d = subtaskDecomposition.decomposePlan(planContent);
    const previous = state && state.decomposition ? state.decomposition : null;
    if (previous && previous.plan_version === d.plan_version && previous.status === d.status) {
        return { changed: false, decomposition: previous };
    }
    if (previous && Number.isInteger(previous.plan_visits) && planVisits(state) <= previous.plan_visits) {
        return { changed: false, decomposition: previous, refused: 'PLAN_CHANGED_OUTSIDE_PLAN' };
    }
    const acsByStep = new Map(planSignals.extractPlanSteps(String(planContent || '')).steps.map(s => [s.index, s.acs || []]));
    const decomposition = {
        plan_version: d.plan_version,
        status: d.status,
        cause: d.cause,
        groups: d.groups.map(g => ({
            subtask_key: g.subtask_key,
            steps: [...g.steps],
            paths_decl: g.paths_decl === UNKNOWN ? UNKNOWN : [...g.paths_decl],
            acs: [...new Set(g.steps.flatMap(n => acsByStep.get(n) || []))].sort(),
        })),
        // Visitas ao Plan na gravação: replan só é aceito depois de uma visita nova.
        plan_visits: planVisits(state),
        scope_paths: [...d.scope_paths],
        superseded: [
            ...(previous && Array.isArray(previous.superseded) ? previous.superseded : []),
            ...subtaskDecomposition.superseded(previous, d),
        ],
        rework: null,
        recorded_at: at,
    };
    return { changed: true, decomposition };
}

function groupOf(decomposition, key) {
    return (decomposition.groups || []).find(g => g.subtask_key === key) || null;
}

/** Grupo sintético do rework do nó inteiro (B5.7): todos os passos, escopo = união. */
function allGroup(decomposition) {
    return {
        subtask_key: dom06.allKey(decomposition.plan_version),
        steps: [...new Set((decomposition.groups || []).flatMap(g => g.steps))].sort((a, b) => a - b),
        paths_decl: [...(decomposition.scope_paths || [])],
        acs: [...new Set((decomposition.groups || []).flatMap(g => g.acs || []))].sort(),
        synthetic: true,
    };
}

function keyGroup(decomposition, key) {
    return key === dom06.allKey(decomposition.plan_version) ? allGroup(decomposition) : groupOf(decomposition, key);
}

function normalizePath(p) {
    return String(p || '').trim().replace(/^\.\//, '').replace(/:\d+(?::\d+)?$/, '');
}

/**
 * B5.7: achados do gate → chaves de rework. Achado com arquivo declarado em `paths_decl` de
 * exatamente um grupo → essa chave. Achado sem arquivo, ou em zero ou em mais de um grupo →
 * rework do nó inteiro (`ALL`). Test e Verify não dão arquivo por achado → `ALL`.
 */
function mapFindings({ decomposition, gateNode, findings = [] }) {
    const keys = [];
    let unmapped = 0;
    const list = gateNode === 'review' && Array.isArray(findings) ? findings : [];
    if (!list.length) unmapped = 1;
    for (const f of list) {
        const file = f && f.file ? normalizePath(f.file) : '';
        const owners = file ? (decomposition.groups || []).filter(g => Array.isArray(g.paths_decl) && g.paths_decl.includes(file)) : [];
        if (owners.length === 1) {
            if (!keys.includes(owners[0].subtask_key)) keys.push(owners[0].subtask_key);
        } else {
            unmapped += 1;
        }
    }
    const order = new Map((decomposition.groups || []).map(g => [g.subtask_key, g.steps[0]]));
    keys.sort((a, b) => order.get(a) - order.get(b));
    return { keys: unmapped ? [...keys, dom06.allKey(decomposition.plan_version)] : keys, mapped: keys.length, unmapped };
}

/** Attempts com papel da versão vigente, por seq. */
function versionAttempts(runDir, planVersion) {
    return runtime.manifestedAttempts(runDir).filter(a => a.plan_version === planVersion);
}

/** Último gate (Review/Test/Verify) da versão vigente: limite da visita de rework. */
function lastGateOf(runDir, planVersion) {
    return last(versionAttempts(runDir, planVersion).filter(a => a.role === 'gate'));
}

/**
 * Rework a gravar na entrada de uma visita depois de gate (uma vez por gate). null quando não há
 * gate na versão vigente (primeira visita) ou quando o rework desse gate já foi gravado.
 */
function pendingRework({ runDir, state, decomposition, at = new Date().toISOString() }) {
    const gate = lastGateOf(runDir, decomposition.plan_version);
    if (!gate) return null;
    if (decomposition.rework && decomposition.rework.gate_attempt_id === gate.attempt_id) return null;
    const findings = gate.node === 'review' && state && state.review_results ? state.review_results.findings : [];
    const m = mapFindings({ decomposition, gateNode: gate.node, findings });
    return {
        gate_attempt_id: gate.attempt_id,
        gate_node: gate.node,
        after_seq: seqOf(gate),
        keys: m.keys,
        mapped: m.mapped,
        unmapped: m.unmapped,
        failure_class: null,
        recorded_at: at,
    };
}

// Ato humano registrado depois do instante dado (retomada de session_limit, aprovação, desbloqueio).
function humanActAfter(state, at) {
    const decided = String(at || '');
    const resume = runtime.humanResumeRecord(state || {});
    if (resume && resume.at > decided) return true;
    const u = state && state.unblocked;
    return Boolean(u && typeof u.at === 'string' && u.at > decided);
}

/**
 * Status do último Attempt de uma chave (ou da integração) para decidir o próximo passo.
 * accepted | wait (em voo ou órfão a fechar) | retry (falha sem mutação, dentro do teto) |
 * redispatch (depois de ato humano ou de status do comando já resolvido) | blocked
 */
function attemptStatus(attempt, state) {
    const acc = attempt.acceptance;
    if (!acc) return 'wait';
    if (acc.accepted === true) return 'accepted';
    // Ato humano posterior (HUMAN_RESUME/HUMAN_UNBLOCK) vem antes do retry: o Attempt seguinte
    // entra com causa `dispatch` e âncora humana, nunca `retry` (H2, AC-37).
    if (humanActAfter(state, acc.decided_at)) return 'redispatch';
    if (acc.retry_allowed === true && acc.block !== true) return 'retry';
    // STATUS_CHANGED: o comando gravou outro status; a Run só volta aqui depois do caminho
    // humano desse status → novo Attempt da chave, encadeado. Qualquer outro não aceito
    // (CLAIM_LOST, PLAN_SUPERSEDED sem mutação, bloqueio) para no caminho humano: sem
    // redespacho fora do teto.
    if (acc.reason === 'STATUS_CHANGED') return 'redispatch';
    return 'blocked';
}

function actionFor(status, base, attempt) {
    if (status === 'wait') return { kind: 'wait', attempt_id: attempt.attempt_id };
    if (status === 'blocked') return { kind: 'blocked', attempt_id: attempt.attempt_id, reason: attempt.acceptance.reason || 'UNKNOWN' };
    if (status === 'retry') return { ...base, cause: 'retry', parent_attempt_id: attempt.attempt_id };
    return { ...base, cause: 'dispatch', parent_attempt_id: attempt.attempt_id };
}

/**
 * B5: próxima ação da visita ao Implement da Run decomposta.
 * @returns {{ kind: 'subtask', key, rework, cause, parent_attempt_id } |
 *   { kind: 'integration', cause, parent_attempt_id } | { kind: 'aggregate', keys } |
 *   { kind: 'wait', attempt_id } | { kind: 'blocked', attempt_id, reason } |
 *   { kind: 'rework_pending' }}
 */
function nextAction({ runDir, state, decomposition }) {
    const pv = decomposition.plan_version;
    const mine = versionAttempts(runDir, pv);
    const gate = last(mine.filter(a => a.role === 'gate'));
    const visitStart = gate ? seqOf(gate) : 0;
    let targets;
    if (!gate) {
        targets = (decomposition.groups || []).map(g => g.subtask_key);
    } else {
        const rework = decomposition.rework;
        if (!rework || rework.gate_attempt_id !== gate.attempt_id) return { kind: 'rework_pending' };
        targets = rework.keys;
    }
    const subtasks = mine.filter(a => a.role === 'subtask');
    for (const key of targets) {
        const lineage = subtasks.filter(a => a.subtask_key === key);
        const inVisit = lineage.filter(a => seqOf(a) > visitStart);
        const base = { kind: 'subtask', key, rework: Boolean(gate) };
        const prev = last(inVisit);
        if (!prev) {
            const parent = last(lineage);
            return { ...base, cause: 'dispatch', parent_attempt_id: parent ? parent.attempt_id : null };
        }
        const status = attemptStatus(prev, state);
        if (status !== 'accepted') return actionFor(status, base, prev);
    }
    const maxKeySeq = subtasks.reduce((m, a) => Math.max(m, seqOf(a)), 0);
    const integrations = mine.filter(a => a.role === 'integration');
    const integ = last(integrations.filter(a => seqOf(a) > maxKeySeq));
    if (!integ) {
        const parent = last(integrations);
        return { kind: 'integration', cause: 'dispatch', parent_attempt_id: parent ? parent.attempt_id : null };
    }
    const status = attemptStatus(integ, state);
    if (status !== 'accepted') return actionFor(status, { kind: 'integration' }, integ);
    return { kind: 'aggregate', keys: (decomposition.groups || []).map(g => g.subtask_key) };
}

/**
 * B5.3 / B5.7–8 (Q7 a): piso de classe do próximo Attempt de uma chave. Sem Attempt anterior
 * na linhagem: sem piso (resolução inicial). Rework/retry: ≥ resolução inicial. scope_violation
 * na linhagem ou chave ALL: ≥ C4 com RISK_RECLASSIFIED (reclassificação de risco, não
 * escalation: nenhuma proposta, nenhum Attempt `escalation`, nenhuma authorization_ref).
 * @returns {{ class: string, selection_source: string }|null}
 */
function classFloor({ runDir, decomposition, key }) {
    // Rework do nó inteiro: "nó inteiro em C4" (v9 §3.4, Q7 a) — classe fixa, não piso.
    if (key === dom06.allKey(decomposition.plan_version)) return { class: 'C4', selection_source: RISK, exact: true };
    const lineage = versionAttempts(runDir, decomposition.plan_version).filter(a => a.role === 'subtask' && a.subtask_key === key);
    const group = groupOf(decomposition, key);
    let floor = null;
    const raise = (cls, source) => {
        if (CLASS_RANK[cls] && (!floor || CLASS_RANK[cls] > CLASS_RANK[floor.class] || (CLASS_RANK[cls] === CLASS_RANK[floor.class] && source === RISK))) {
            floor = { class: cls, selection_source: source };
        }
    };
    // Resolução inicial da linhagem = classe gravada pelo DOM-06 na RoutingDecision do primeiro
    // Attempt da chave (fonte única; sem cópia no state.json). Piso por classe (B5.3); um
    // override humano anterior não vira piso (declarado na evidência).
    const first = lineage[0];
    if (first && first.routing && CLASS_RANK[first.routing.class]) raise(first.routing.class, 'LINEAGE_FLOOR');
    if (group && group.paths_decl === UNKNOWN) raise('C4', 'CONSERVATIVE_DEFAULT');
    if (lineage.some(a => a.scope_violation === true)) raise('C4', RISK);
    return floor;
}

/** Sinais só do grupo (B5.3): a resolução da subtarefa não vê os demais grupos. */
function groupSignals(signals, key) {
    if (!signals || signals.status !== 'COMPLETE' || !Array.isArray(signals.groups)) return signals;
    const groups = signals.groups.filter(g => g.subtask_key === key);
    return groups.length ? { ...signals, groups } : { ...signals, status: 'INCOMPLETE', groups: [] };
}

/**
 * B5.8: arquivos fora de `paths_decl` entre o baseline e o post de uma subtarefa (manifestos
 * locais). Registros da plataforma em `memory/` não contam. Sem manifestos comparáveis ou com
 * `paths_decl` UNKNOWN → não comparável (nada a reclassificar; o grupo já é C4).
 */
function scopeCheck({ checkoutRoot, task, attempt, decomposition }) {
    const group = keyGroup(decomposition, attempt.subtask_key);
    if (!group || !Array.isArray(group.paths_decl)) return { comparable: false, count: null };
    const { manifestsDir } = runtime.manifestPaths(checkoutRoot);
    const base = manifest.readManifest(manifestsDir, task, attempt.attempt_id, 'baseline');
    const post = manifest.readManifest(manifestsDir, task, attempt.attempt_id, 'post');
    const cmp = manifest.compare(base, post);
    if (!cmp.comparable) return { comparable: false, count: null };
    const allowed = new Set(group.paths_decl);
    const outside = cmp.changed.filter(p => p && !allowed.has(p) && !p.startsWith('memory/'));
    return { comparable: true, count: outside.length };
}

/** Linhas "Verificação:" de um passo do plano. */
function verificationsOf(text) {
    const out = [];
    for (const line of String(text || '').split('\n')) {
        const m = /^\s*[-*]?\s*Verifica(?:ç|c)(?:ã|a)o:\s*(.+)$/i.exec(line);
        if (m) out.push(m[1].trim());
    }
    return out;
}

/**
 * B6 (DP-8): DoD por subtarefa, derivado e gravado como insumo. ACs do grupo, linhas de
 * verificação dos passos e a condição do manifesto. `self_reported_status` nasce null.
 */
function deriveDod({ group, planContent }) {
    const steps = planSignals.extractPlanSteps(String(planContent || '')).steps.filter(s => group.steps.includes(s.index));
    const items = [
        ...(group.acs || []).map(ac => ({ kind: 'ac', ref: ac })),
        ...steps.flatMap(s => verificationsOf(s.text).map(v => ({ kind: 'verification', step: s.index, text: v }))),
        { kind: 'manifest', text: 'manifesto post COMPLETE, sem arquivo fora de paths_decl' },
    ];
    return { items, source: 'derived', self_reported_status: null };
}

function sha256(text) {
    return crypto.createHash('sha256').update(text).digest('hex');
}

/**
 * B6: bloco de contexto do passo (montado pelo watcher, como nodeContextBlock). O hash vai no
 * Attempt como Context Record (`context_record_sha256`, DOM-06 dono).
 */
function stepContextBlock({ taskId, group, planContent, dod, rework = false }) {
    const steps = planSignals.extractPlanSteps(String(planContent || '')).steps.filter(s => group.steps.includes(s.index));
    const paths = Array.isArray(group.paths_decl) ? group.paths_decl : [];
    const lines = [
        '', '', `<!-- subtask-context:${group.subtask_key}:inicio -->`,
        `Subtarefa ${group.subtask_key} da task ${taskId}${rework ? ' (rework depois de gate)' : ''}.`,
        `Escopo de escrita (paths_decl): ${paths.length ? paths.join(', ') : 'UNKNOWN — não declarado no plano; restrinja-se aos passos abaixo'}.`,
        `ACs do grupo: ${(group.acs || []).join(', ') || 'nenhum citado nos passos'}.`,
        'Passos do grupo (texto do plano):',
        ...steps.map(s => `- Passo ${s.index}: ${s.text.replace(/\s+/g, ' ').trim()}`),
        'Definição de pronto (insumo, não é gate):',
        ...dod.items.map(i => `- ${i.kind === 'ac' ? `cobrir ${i.ref}` : i.text}`),
        `<!-- subtask-context:${group.subtask_key}:fim -->`,
    ];
    const block = lines.join('\n');
    return { block, sha256: sha256(block) };
}

/** B6: bloco de contexto da integração (chaves da versão e rework, se houve). */
function integrationContextBlock({ taskId, decomposition }) {
    const keys = (decomposition.groups || []).map(g => g.subtask_key);
    const lines = [
        '', '', `<!-- integration-context:${String(decomposition.plan_version).slice(0, 12)}:inicio -->`,
        `Integração da task ${taskId}, plan_version ${String(decomposition.plan_version).slice(0, 12)}.`,
        `Subtarefas aceitas desta versão: ${keys.join(', ')}.`,
        ...(decomposition.rework ? [`Rework desta visita: ${decomposition.rework.keys.join(', ')}.`] : []),
        `<!-- integration-context:${String(decomposition.plan_version).slice(0, 12)}:fim -->`,
    ];
    const block = lines.join('\n');
    return { block, sha256: sha256(block) };
}

/** AC-23: pré-build uma vez, antes da primeira subtarefa da Run. */
function preBuildDue(runDir) {
    return !dom06.listAttempts(runDir).some(a => a.role === 'subtask' && a.started);
}

/** AC-23: churn uma vez por visita, antes da primeira subtarefa da visita. */
function churnDue(runDir, decomposition, action) {
    if (!action || action.kind !== 'subtask') return false;
    const pv = decomposition.plan_version;
    const gate = lastGateOf(runDir, pv);
    const visitStart = gate ? seqOf(gate) : 0;
    return !versionAttempts(runDir, pv).some(a => a.role === 'subtask' && seqOf(a) > visitStart);
}

/**
 * Defesa da Review (B5.6, AC-22): na Run decomposta, a Review só é despachada com a agregação
 * `aggregate:<pv>` gravada depois da última subtarefa da versão vigente.
 */
function reviewAllowed(runDir, planVersion) {
    const mine = versionAttempts(runDir, planVersion);
    const lastKey = mine.filter(a => a.role === 'subtask').reduce((m, a) => Math.max(m, seqOf(a)), 0);
    if (!lastKey) return false;
    const prefix = `aggregate:${planVersion}:`;
    return mine.some(a => a.role === 'integration' && seqOf(a) > lastKey
        && (a.effects || []).some(e => typeof e.idempotency_key === 'string' && e.idempotency_key.startsWith(prefix) && e.status === 'fulfilled'));
}


// ---------------------------------------------------------------------------------
// Subagentes (B8): agentes do projeto (só leitura do worktree) e atribuição pós-saída

// Campos do frontmatter que a redefinição por `--agents` reproduz fielmente. `model` é o único
// trocado; `color` é só cosmético da interface e fica de fora. Qualquer outro campo (tools em
// lista YAML, disallowedTools, permissionMode, mcpServers, hooks, skills, bloco `|`/`>`…) torna
// o agente NÃO reproduzível: ele não é redefinido e o papel fica UNENFORCED (fail-closed), para
// a intervenção nunca mudar ferramentas, permissões ou prompt do consumidor.
const AGENT_KEYS = new Set(['name', 'description', 'tools', 'model', 'color']);

function parseAgent(text) {
    const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
    if (!m) return null;
    const fm = {};
    let reproducible = true;
    for (const line of m[1].split(/\r?\n/)) {
        if (!line.trim() || /^\s*#/.test(line)) continue;
        const kv = /^([A-Za-z_][\w-]*):[ \t]*(.*)$/.exec(line);
        if (!kv) { reproducible = false; continue; } // linha de continuação/lista
        const value = kv[2].trim();
        if (!AGENT_KEYS.has(kv[1]) || value === '' || /^[|>]/.test(value)) reproducible = false;
        fm[kv[1]] = value.replace(/^(["'])(.*)\1$/, '$2');
    }
    if (!fm.name) return null;
    let tools = null;
    if (fm.tools !== undefined) {
        tools = fm.tools.replace(/^\[|\]$/g, '').split(',').map(t => t.trim().replace(/^(["'])(.*)\1$/, '$2')).filter(Boolean);
        if (!tools.length) reproducible = false;
    }
    const definition = { description: fm.description || fm.name, prompt: m[2].trim(), ...(tools ? { tools } : {}) };
    return reproducible
        ? { name: fm.name, redefinable: true, definition }
        : { name: fm.name, redefinable: false, cause: 'AGENT_NOT_REPRODUCIBLE' };
}

/**
 * Agentes do projeto em `<worktree>/.claude/agents/*.md`. Só leitura. Limite declarado: o
 * worktree muda durante a Run (o `agents_sha256` na RoutingDecision permite auditar).
 */
function readProjectAgents(worktree) {
    const dir = path.join(String(worktree || ''), '.claude', 'agents');
    let files = [];
    try { files = fs.readdirSync(dir).filter(f => f.endsWith('.md')).sort(); } catch { return []; }
    const out = [];
    for (const f of files) {
        let text;
        try { text = fs.readFileSync(path.join(dir, f), 'utf8'); } catch { continue; }
        const a = parseAgent(text);
        if (a) out.push(a);
    }
    return out;
}

/** Atribuição por papel (S1, cost-tracking) a partir dos transcripts da sessão. */
function attributionFromTranscripts(files) {
    const costTracking = require('./cost-tracking');
    const isSub = f => f.includes(`${path.sep}subagents${path.sep}`);
    const main = files.find(f => !isSub(f));
    const subagents = files.filter(isSub).map(f => {
        let meta = null;
        try { meta = JSON.parse(fs.readFileSync(f.replace(/\.jsonl$/, '.meta.json'), 'utf8')); } catch { meta = null; }
        return { file_ref: path.basename(f), content: fs.readFileSync(f, 'utf8'), meta };
    });
    return costTracking.subagentRoleAttribution({ main: main ? fs.readFileSync(main, 'utf8') : '', subagents });
}

module.exports = {
    isDecomposedSnapshot, recordDecomposition, groupOf, allGroup, keyGroup,
    mapFindings, pendingRework, nextAction, attemptStatus, classFloor, groupSignals, scopeCheck,
    deriveDod, verificationsOf, stepContextBlock, integrationContextBlock, preBuildDue, churnDue,
    reviewAllowed, versionAttempts, lastGateOf, parseAgent, readProjectAgents, attributionFromTranscripts,
};
