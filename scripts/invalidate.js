// Dependency Invalidation dos artefatos derivados da Spec. Quando uma SPEC_CHANGE
// aprovada muda o contrato, tudo o que foi produzido antes deixa de comprovar o contrato
// atual: este módulo é o ÚNICO lugar que decide isso. Cadeia de dependência:
//
//   SPEC → PLAN → IMPLEMENTATION → REVIEW → EVIDENCE (acceptance-evidence.json) → VERIFY
//
// Estados de validade (bloco `validity`, igual em todo artefato derivado):
//   VALID    produzido contra a spec atual, por uma execução governada por ela, sem
//            transição de contrato pendente.
//   STALE    produzido contra outra versão, invalidado por SPEC_CHANGE, ou produzido por
//            execução que começou sob outro contrato. "Pegajoso": só um artefato NOVO
//            (stampProduced) volta a VALID — nunca uma reavaliação nem um replay.
//   UNKNOWN  artefato legado sem spec_hash (run histórico). UNKNOWN não é FAIL, mas
//            evidence UNKNOWN não comprova a spec atual: o Verify é fail-closed. Nada é
//            reescrito para ganhar hash retroativamente.
//   { status, stale_since_version, stale_acs: [] }  — stale_acs reservado para a
//   granularidade por AC-ID (sempre presente, vazio na v1 conservadora).
//
// INV-SPEC-CHANGE-REPLAN: uma SPEC_CHANGE aprovada SEMPRE exige reentrada pelo Plan e
// invalida os artefatos derivados. Hash igual (mudança fora do HASH_SCOPE) NÃO é prova de
// que replanejar é desnecessário: applyToSpec registra regra de negócio, restrição,
// escopo e exceção no "Histórico de Mudanças", que fica fora do hash, e as fases leem
// seções fora do hash. O hash só decide se a spec_version incrementa.
//
// Onde fica (state.json é a fonte que as fases leem — nenhuma fase recalcula hash):
//   state.artifact_validity.<fase>  { artifact, spec_hash, spec_version, produced_at,
//                                     execution_spec_hash, validity }   fase ∈ PHASES
//   espelhos: state.review_results.validity, state.spec_conformance.validity e o bloco
//   `validity` no topo de acceptance-evidence.json.
//   state.execution_spec            spec que governa a execução do nó atual, gravada no
//                                   despacho (lease) — execution_spec ≠ spec atual no fim.
//   state.invalidations[]           histórico das invalidações aplicadas (transition_id).
//   <run>/pending-invalidation.jsonl  transições de contrato registradas para o run e
//                                   ainda não aplicadas (append-only, um único tipo de
//                                   escritor; consumida por transition_id em
//                                   state.invalidations — nunca apagada nem reescrita).
//                                   Fica FORA do state.json de propósito: CLIs dentro do
//                                   nó fazem read-modify-write do state.json e uma
//                                   pendência gravada ali entre a leitura e a escrita
//                                   delas se perdia (corrida 1).
//   state.pending_invalidation      formato antigo: ainda lido, não é mais gravado.
//
// Casos de run em andamento (applySpecChange / propagateSpecChange):
//   A  nenhum nó rodando  → invalida já (state) + registra no journal; node = "plan".
//   B  nó avançado rodando → só registra no journal (o nó não é interrompido); o watcher
//      aplica (resolvePendingInvalidation) quando o nó termina, antes de qualquer outro
//      despacho. Enquanto pendente: Verify/Commit recusam (PENDING_SPEC_INVALIDATION) e
//      todo artefato carimbado sai STALE.
//   C  plan rodando       → idem B: o plano em produção sai STALE (pendência + execution_spec)
//      e a resolução volta node = "plan".
// A propagação registra a transição nos outros runs ANTES de gravar a spec nova no disco
// (corrida 2): um run que só "observou" o hash novo continua participante da transição.
//
// Uso como CLI (<run-dir> = memory/runs/<task-id>):
//   node scripts/invalidate.js status <run-dir> [--json]          validade por fase (dashboard)
//   node scripts/invalidate.js guard <run-dir> --phase=verify      exit 1 = evidence STALE/UNKNOWN ou transição pendente
//   node scripts/invalidate.js guard <run-dir> --phase=commit      exit 1 = transição de contrato pendente
//   node scripts/invalidate.js guard <run-dir> --phase=review      alerta (exit 0 sempre — não bloqueia)
//   node scripts/invalidate.js apply <run-dir> --new-hash=<h> [--new-version=N] [--old-hash=<h>] [--by=<quem>]
//   node scripts/invalidate.js resolve <run-dir>                   aplica a transição pendente se o nó terminou
//   node scripts/invalidate.js begin <run-dir> --node=<nó>          execution_spec no início de execução manual (/plan)
// exit 0 = ok, 1 = guard recusou, 2 = uso incorreto/state ilegível.
// Desenho completo: docs/dependency-invalidation.md.

const fs = require('fs');
const path = require('path');

const VALID = 'VALID';
const STALE = 'STALE';
const UNKNOWN = 'UNKNOWN';
const STATUSES = [VALID, STALE, UNKNOWN];

// Ordem da cadeia. implement não tem arquivo próprio (o diff vive no worktree): o
// registro é o spec_hash com que o nó foi despachado.
const PHASES = ['plan', 'implement', 'review', 'evidence', 'verify'];
const ARTIFACTS = {
    plan: 'plan.md',
    implement: 'implementação (diff do worktree)',
    review: 'review-result.md',
    evidence: 'acceptance-evidence.json',
    verify: 'spec-conformance.md',
};
// Nó do grafo que produz o artefato de cada fase (execution_spec é por nó).
const PRODUCER = { plan: 'plan', implement: 'implement', review: 'review', evidence: 'test', verify: 'verify' };
const EVIDENCE_FILE = 'acceptance-evidence.json';
const JOURNAL_FILE = 'pending-invalidation.jsonl';
// Arquivos do run que a invalidação marca em state.stale_artifacts (lista por arquivo
// que spec-change.staleGate e o Verify consomem). context.md é histórico e nunca entra.
const STALE_FILES = ['plan.md', 'handoff.md', EVIDENCE_FILE];
// Arquivo da lista stale → fase cujo artefato novo o regera (isRegenerated).
const FILE_PHASE = { 'plan.md': 'plan', 'handoff.md': 'plan', [EVIDENCE_FILE]: 'evidence' };
// Encerrados: o run não volta para o grafo; a invalidação só marca os dados.
const CLOSED_STATUSES = new Set(['committed', 'fully_merged', 'completed']);
const APPROVED = 'spec_change_approved';
const MIN_HASH_PREFIX = 6;

const short = h => (h ? String(h).slice(0, 12) : '—');

// ── Comparação (a única do fluxo) ────────────────────────────────────────────────

/**
 * Validade de um artefato pelo hash que ele registrou contra o hash atual da spec.
 * Aceita hash abreviado (≥ 6 hex) dos dois lados, como os artefatos gravam.
 */
function classify(artifactHash, currentHash) {
    const a = typeof artifactHash === 'string' ? artifactHash.trim().toLowerCase() : '';
    const c = typeof currentHash === 'string' ? currentHash.trim().toLowerCase() : '';
    if (a.length < MIN_HASH_PREFIX || c.length < MIN_HASH_PREFIX) return UNKNOWN;
    return a.startsWith(c) || c.startsWith(a) ? VALID : STALE;
}

function validityBlock(status, { staleSinceVersion = null } = {}) {
    return {
        status,
        stale_since_version: status === STALE && Number.isInteger(staleSinceVersion) ? staleSinceVersion : null,
        stale_acs: [],
    };
}

/** Spec atual do run, como o state.json registra (versionado: state.spec; legado: spec_hash). */
function specRef(state) {
    const s = state && typeof state.spec === 'object' && state.spec && !Array.isArray(state.spec) ? state.spec : null;
    if (s && typeof s.hash === 'string' && Number.isInteger(s.version)) return { hash: s.hash, version: s.version, versioned: true };
    return { hash: typeof state?.spec_hash === 'string' ? state.spec_hash : null, version: null, versioned: false };
}

function versionLabel(version, hash) {
    return Number.isInteger(version) ? `v${version}` : `de spec_hash ${short(hash)}`;
}

function pushEvent(state, event) {
    state.events = Array.isArray(state.events) ? state.events : [];
    state.events.push({ ts: event.at, ...event });
}

// ── Transições pendentes (journal append-only) ───────────────────────────────────

function journalPath(runDir) {
    return path.join(runDir, JOURNAL_FILE);
}

function consumedIds(state) {
    return new Set((Array.isArray(state?.invalidations) ? state.invalidations : []).map(i => i?.transition_id).filter(Boolean));
}

/** Entradas do journal (linhas inválidas são ignoradas, nunca reescritas). */
function readJournal(runDir) {
    if (!runDir) return [];
    let raw;
    try { raw = fs.readFileSync(journalPath(runDir), 'utf8'); } catch { return []; }
    const out = [];
    for (const line of raw.split('\n')) {
        if (!line.trim()) continue;
        try { const e = JSON.parse(line); if (e && typeof e === 'object' && e.transition_id) out.push(e); } catch { /* linha parcial */ }
    }
    return out;
}

/**
 * Registra uma transição de contrato para o run: um append de uma linha (O_APPEND, atômico
 * para o tamanho de uma linha) — nunca read-modify-write, então nenhum outro escritor do
 * run a apaga. Idempotente por transition_id.
 */
function registerTransition(runDir, entry) {
    if (readJournal(runDir).some(e => e.transition_id === entry.transition_id)) return false;
    fs.appendFileSync(journalPath(runDir), JSON.stringify(entry) + '\n');
    return true;
}

/**
 * Transições registradas para o run e ainda não aplicadas (journal menos as consumidas
 * em state.invalidations, mais o formato antigo state.pending_invalidation).
 */
function pendingTransitions(state, runDir = null) {
    const done = consumedIds(state);
    const out = readJournal(runDir).filter(e => !done.has(e.transition_id));
    const legacy = state?.pending_invalidation;
    if (legacy && typeof legacy === 'object' && legacy.new_spec_hash) {
        const id = legacy.transition_id || `legacy:${short(legacy.new_spec_hash)}`;
        if (!done.has(id) && !out.some(e => e.transition_id === id)) out.push({ ...legacy, transition_id: id });
    }
    return out;
}

// ── Execução do nó ───────────────────────────────────────────────────────────────

/**
 * Bloco execution_spec gravado no despacho do nó (lease do watcher): a spec que governa
 * esta execução. stampProduced compara o artefato com ela — não com o disco no fim.
 */
function executionSpec(node, { hash, version = null, at = new Date().toISOString() } = {}) {
    return { node, spec_hash: hash || null, spec_version: Number.isInteger(version) ? version : null, started_at: at };
}

/** Instante da última invalidação aplicada ao run (ms; -Infinity = nenhuma). */
function lastInvalidationAt(state) {
    const all = Array.isArray(state?.invalidations) ? state.invalidations : [];
    return all.reduce((m, i) => Math.max(m, Date.parse(i?.at || '') || -Infinity), -Infinity);
}

/**
 * Grava execution_spec no início de uma execução sem o lease do watcher (portão de drift
 * dentro do nó, `invalidate.js begin`). Mantém a de uma execução do mesmo nó em curso;
 * substitui a de outro nó ou a que começou antes da última invalidação (é execução nova).
 */
function beginExecution(state, node, spec, { at = new Date().toISOString() } = {}) {
    const cur = state?.execution_spec;
    if (cur?.node === node && !(Date.parse(cur.started_at || '') < lastInvalidationAt(state))) return false;
    state.execution_spec = executionSpec(node, { ...spec, at });
    return true;
}

// ── Registro por fase ────────────────────────────────────────────────────────────

function store(state) {
    if (!state.artifact_validity || typeof state.artifact_validity !== 'object' || Array.isArray(state.artifact_validity)) state.artifact_validity = {};
    return state.artifact_validity;
}

function mirror(state, phase, validity) {
    if (phase === 'review' && state.review_results && typeof state.review_results === 'object') state.review_results.validity = { ...validity };
    if (phase === 'verify' && state.spec_conformance && typeof state.spec_conformance === 'object') state.spec_conformance.validity = { ...validity };
}

/**
 * O nó acabou de produzir o artefato da fase contra `specHash`. VALID só se as três
 * coisas valem: o hash é o da spec atual do run; a execução que o produziu começou sob
 * esse mesmo contrato (state.execution_spec do nó produtor — execution_spec ≠ spec atual
 * no fim = STALE); e não há transição de contrato pendente para o run. É o único caminho
 * de STALE/UNKNOWN de volta a VALID. Depois reavalia as outras fases (refresh).
 * @param {{specHash, specVersion, at, runDir}} opts  runDir: para ler o journal de pendências
 * @returns {object} o registro gravado em state.artifact_validity[phase]
 */
function stampProduced(state, phase, { specHash = null, specVersion = null, at = new Date().toISOString(), runDir = null } = {}) {
    if (!PHASES.includes(phase)) throw new Error(`fase desconhecida: ${phase}`);
    const ref = specRef(state);
    let status = classify(specHash, ref.hash);
    let reason = null;
    const exec = state.execution_spec && state.execution_spec.node === PRODUCER[phase] ? state.execution_spec : null;
    if (status === VALID && exec && exec.spec_hash && classify(exec.spec_hash, specHash) !== VALID) {
        status = STALE;
        reason = `execução de ${exec.node} começou sob ${versionLabel(exec.spec_version, exec.spec_hash)} e terminou com a spec ${versionLabel(ref.version, specHash)}`;
    }
    // Execução iniciada antes da última invalidação do run (transição aplicada enquanto
    // ela rodava — nó manual tratado como ocioso, ou janela entre o despacho e o lease):
    // trabalhou sobre o contrato anterior, mesmo que carimbe o hash novo.
    if (status === VALID && exec && Date.parse(exec.started_at || '') < lastInvalidationAt(state)) {
        status = STALE;
        reason = `execução de ${exec.node} começou (${exec.started_at}) antes da última invalidação do run — produzida sob o contrato anterior`;
    }
    const pending = status === VALID ? pendingTransitions(state, runDir) : [];
    if (pending.length) {
        status = STALE;
        reason = `transição de contrato pendente (${pending.map(p => p.transition_id).join(', ')})`;
    }
    const entry = {
        artifact: ARTIFACTS[phase],
        spec_hash: specHash || null,
        spec_version: Number.isInteger(specVersion) ? specVersion : null,
        produced_at: at,
        ...(exec ? { execution_spec_hash: exec.spec_hash } : {}),
        validity: validityBlock(status, { staleSinceVersion: ref.version }),
        ...(reason ? { stale_reason: reason } : {}),
    };
    store(state)[phase] = entry;
    mirror(state, phase, entry.validity);
    refresh(state, { at });
    return entry;
}

/**
 * Reavalia os registros VALID contra a spec atual (VALID → STALE quando ela mudou).
 * Nunca promove STALE/UNKNOWN a VALID. Muta state. @returns {boolean} mudou.
 */
function refresh(state, { at = new Date().toISOString() } = {}) {
    const all = state?.artifact_validity;
    if (!all || typeof all !== 'object') return false;
    const ref = specRef(state);
    let changed = false;
    for (const phase of PHASES) {
        const e = all[phase];
        if (!e || e.validity?.status !== VALID) continue;
        if (classify(e.spec_hash, ref.hash) === VALID) continue;
        e.validity = validityBlock(STALE, { staleSinceVersion: ref.version });
        e.stale_at = at;
        mirror(state, phase, e.validity);
        changed = true;
    }
    return changed;
}

/**
 * Registro da fase, sem gravar nada. Run legado (sem artifact_validity) deriva do que
 * o artefato registrou (review_results.spec_hash, matriz.spec_hash, …); sem hash = UNKNOWN.
 */
function phaseEntry(state, phase, { evidenceData = null } = {}) {
    const stored = state?.artifact_validity?.[phase];
    if (stored && STATUSES.includes(stored.validity?.status)) return { ...stored, derived: false };
    const ref = specRef(state);
    const derive = (specHash, specVersion, extra = {}) => {
        const status = classify(specHash, ref.hash);
        return {
            artifact: ARTIFACTS[phase], spec_hash: specHash || null, spec_version: Number.isInteger(specVersion) ? specVersion : null,
            produced_at: null, validity: validityBlock(status, { staleSinceVersion: ref.version }), derived: true, ...extra,
        };
    };
    if (phase === 'plan') {
        if (state?.spec_hash && state.spec_hash_by !== 'spec-change-approval') return derive(state.spec_hash, state.spec_hash_version);
        return derive(null, null);
    }
    if (phase === 'implement') {
        const plan = phaseEntry(state, 'plan');
        return { ...plan, artifact: ARTIFACTS.implement, derived: true, derived_from: 'plan' };
    }
    if (phase === 'review') return state?.review_results ? derive(state.review_results.spec_hash, state.review_results.spec_version) : null;
    if (phase === 'evidence') return evidenceData && typeof evidenceData === 'object' ? derive(evidenceData.spec_hash, evidenceData.spec_version) : null;
    if (phase === 'verify') return state?.spec_conformance ? derive(state.spec_conformance.spec_hash, state.spec_conformance.spec_version) : null;
    return null;
}

/**
 * Validade efetiva de uma fase agora: o registro (STALE/UNKNOWN pegajosos), rebaixado
 * para STALE se o hash dele não é o `current` (ex.: hash recalculado do disco pelo Verify).
 * @returns {string|null} VALID | STALE | UNKNOWN | null (fase sem artefato)
 */
function effectiveStatus(state, phase, { current = null, evidenceData = null } = {}) {
    const e = phaseEntry(state, phase, { evidenceData });
    if (!e) return null;
    const status = e.validity.status;
    if (status !== VALID || !current) return status;
    return classify(e.spec_hash, current) === VALID ? VALID : STALE;
}

/**
 * Arquivo de state.stale_artifacts já regerado depois da invalidação? Decisão desta
 * fonte: o artefato da fase correspondente voltou a VALID depois de stale_since. Run sem
 * artifact_validity (anterior a este módulo) cai no critério antigo de mtime.
 */
function isRegenerated(state, file, runDir, { io = fs } = {}) {
    const since = Date.parse(state?.stale_since || '');
    if (!Number.isFinite(since)) return false;
    const phase = FILE_PHASE[file];
    const e = phase ? state?.artifact_validity?.[phase] : null;
    if (e) return e.validity?.status === VALID && Date.parse(e.produced_at || '') > since;
    try { return io.statSync(path.join(runDir, file)).mtimeMs > since; } catch { return false; }
}

// ── Resolver central ─────────────────────────────────────────────────────────────

/**
 * Run que recebe uma versão nova da spec sem ter aprovado a mudança ele mesmo (run irmão,
 * replay): state.spec acompanha a versão/hash vigente, senão o próximo baseline gravaria o
 * conteúdo da v2 com o rótulo da v1. Só avança (nunca rebaixa). Muta state.
 */
function syncSpecBlock(state, newSpec, { by, ref = null, fromVersion = null, at = new Date().toISOString() } = {}) {
    const s = state?.spec;
    if (!s || typeof s !== 'object' || !Number.isInteger(newSpec?.version) || newSpec.version < (s.version || 0)) return false;
    if (newSpec.version === s.version && classify(s.hash, newSpec.hash) === VALID) return false;
    Object.assign(s, {
        version: newSpec.version, hash: newSpec.hash, status: 'active', updated_at: at, updated_by: by,
        last_change: { spec_change_id: ref, approval_ref: ref, from_version: fromVersion ?? null, at },
    });
    return true;
}

/**
 * Decide e aplica a invalidação dos artefatos derivados (muta runState).
 * v1 conservadora — invalidação total (stale_acs vazio) quando:
 *   cause = "spec_change_approved" → SEMPRE (INV-SPEC-CHANGE-REPLAN), com hash igual ou não;
 *   outra causa (replay, manual)   → só se o hash mudou.
 * Idempotente por transition_id.
 * @param {{hash: string|null, version?: number|null}} oldSpec
 * @param {{hash: string|null, version?: number|null}} newSpec
 * @param {object} runState  state.json do run (mutado)
 * @param {{triggeredBy?: string, at?: string, case?: string, cause?: string, transitionId?: string, evidenceData?: object}} [opts]
 * @returns {{invalidated: boolean, reason: string, phases: string[]}}
 */
function invalidateDerivedArtifacts(oldSpec, newSpec, runState, opts = {}) {
    const at = opts.at || new Date().toISOString();
    const oldHash = oldSpec?.hash || null;
    const newHash = newSpec?.hash || null;
    const cause = opts.cause || 'hash_changed';
    if (!runState || typeof runState !== 'object') return { invalidated: false, reason: 'sem state', phases: [] };
    if (!newHash) return { invalidated: false, reason: 'sem hash da spec nova', phases: [] };
    const transitionId = opts.transitionId || `${cause}:${short(oldHash)}→${short(newHash)}`;
    if (consumedIds(runState).has(transitionId)) return { invalidated: false, reason: 'already_applied', phases: [] };
    const hashChanged = !(oldHash && classify(oldHash, newHash) === VALID);
    if (!hashChanged && cause !== APPROVED) return { invalidated: false, reason: 'hash_scope_unchanged', phases: [] };
    const newVersion = Number.isInteger(newSpec?.version) ? newSpec.version : null;
    const all = store(runState);
    for (const phase of PHASES) {
        const prev = all[phase] || phaseEntry(runState, phase, { evidenceData: opts.evidenceData }) || null;
        const { derived: _d, derived_from: _f, ...kept } = prev || {};
        all[phase] = {
            artifact: ARTIFACTS[phase],
            spec_hash: kept.spec_hash ?? null,
            spec_version: kept.spec_version ?? null,
            produced_at: kept.produced_at ?? null,
            validity: validityBlock(STALE, { staleSinceVersion: newVersion }),
            stale_at: at,
            invalidated_by: opts.triggeredBy || cause,
            stale_reason: hashChanged ? 'contrato (HASH_SCOPE) alterado' : 'SPEC_CHANGE aprovada fora do HASH_SCOPE — hash igual não prova validade (INV-SPEC-CHANGE-REPLAN)',
        };
        mirror(runState, phase, all[phase].validity);
    }
    runState.stale_artifacts = [...new Set([...(Array.isArray(runState.stale_artifacts) ? runState.stale_artifacts : []), ...STALE_FILES])];
    runState.stale_since = at;
    // execution_spec NÃO é apagada: um nó em execução manual (sem lease, visto como ocioso)
    // ainda vai carimbar, e é ela que mostra que ele começou antes desta invalidação.
    runState.invalidations = Array.isArray(runState.invalidations) ? runState.invalidations : [];
    runState.invalidations.push({
        at, transition_id: transitionId, triggered_by: opts.triggeredBy || cause, cause, case: opts.case || 'idle',
        hash_scope_changed: hashChanged,
        old_spec_hash: oldHash, new_spec_hash: newHash,
        old_spec_version: Number.isInteger(oldSpec?.version) ? oldSpec.version : null, new_spec_version: newVersion,
        phases: [...PHASES], stale_acs: [],
    });
    pushEvent(runState, {
        type: 'artifacts_invalidated', node: 'plan', at,
        detail: `Spec ${versionLabel(oldSpec?.version, oldHash)} → ${versionLabel(newVersion, newHash)} (${opts.triggeredBy || cause}` +
            `${hashChanged ? '' : ', HASH_SCOPE inalterado'}): ${PHASES.join(', ')} STALE — o ciclo recomeça no /plan`,
    });
    runState.updated_at = at;
    return { invalidated: true, reason: hashChanged ? 'hash_scope_changed' : 'spec_change_approved', phases: [...PHASES] };
}

/** O que o run está fazendo agora: nenhum nó, plan em execução, ou nó avançado em execução. */
function activity(state) {
    if (state?.status !== 'running') return 'idle';
    return state.node === 'plan' ? 'plan_phase' : 'active_phase';
}

function transitionEntry({ transitionId, cause, triggeredBy, oldSpec, newSpec, kase, phase, at }) {
    return {
        transition_id: transitionId, cause, triggered_by: triggeredBy,
        new_spec_version: Number.isInteger(newSpec?.version) ? newSpec.version : null, new_spec_hash: newSpec?.hash || null,
        old_spec_hash: oldSpec?.hash || null, old_spec_version: Number.isInteger(oldSpec?.version) ? oldSpec.version : null,
        case: kase, phase, registered_at: at,
    };
}

/**
 * Transição de contrato chegando a um run: checa se há nó rodando e aplica o caso certo.
 * Muta state (caso A); casos B/C só registram no journal de runDir (nunca no state.json,
 * que o nó em execução pode sobrescrever).
 * @param {object} state
 * @param {{oldSpec, newSpec, triggeredBy, transitionId, cause, runDir, at, evidenceData}} p
 * @returns {{case: string, invalidated: boolean, deferred: boolean}}
 */
function applySpecChange(state, { oldSpec, newSpec, triggeredBy = 'spec_change', transitionId = null, cause = APPROVED, runDir = null, at = new Date().toISOString(), evidenceData = null } = {}) {
    const ref = specRef(state);
    const old = { hash: oldSpec?.hash || ref.hash, version: Number.isInteger(oldSpec?.version) ? oldSpec.version : ref.version };
    if (!newSpec?.hash) return { case: 'unchanged', invalidated: false, deferred: false };
    const hashChanged = !(old.hash && classify(old.hash, newSpec.hash) === VALID);
    if (!hashChanged && cause !== APPROVED) return { case: 'unchanged', invalidated: false, deferred: false };
    const id = transitionId || `${cause}:${short(old.hash)}→${short(newSpec.hash)}`;
    if (consumedIds(state).has(id) || pendingTransitions(state, runDir).some(p => p.transition_id === id)) {
        return { case: 'already_applied', invalidated: false, deferred: false };
    }
    const act = activity(state);
    if (act !== 'idle' && !CLOSED_STATUSES.has(state.status)) {
        if (!runDir) throw new Error('applySpecChange: nó em execução exige runDir para registrar a transição pendente');
        registerTransition(runDir, transitionEntry({ transitionId: id, cause, triggeredBy, oldSpec: old, newSpec, kase: act, phase: state.node, at }));
        return { case: act, invalidated: false, deferred: true };
    }
    const kase = CLOSED_STATUSES.has(state.status) ? 'closed' : 'idle';
    const out = invalidateDerivedArtifacts(old, newSpec, state, { triggeredBy, at, case: kase, cause, transitionId: id, evidenceData });
    if (kase !== 'closed') state.node = 'plan';
    return { case: kase, invalidated: out.invalidated, deferred: false };
}

/**
 * Fim do nó que estava rodando quando a transição chegou (casos B e C): aplica TODAS as
 * transições pendentes do run antes de qualquer próximo despacho. Invalidação total —
 * inclusive o que o nó carimbou durante a mudança. Muta state; o journal não muda (a
 * transição passa a constar como consumida em state.invalidations).
 * @returns {{resolved: boolean, case?: string, reason?: string, transitions?: string[]}}
 */
function resolvePendingInvalidation(state, { runDir = null, at = new Date().toISOString() } = {}) {
    const pending = pendingTransitions(state, runDir);
    if (!pending.length) return { resolved: false, reason: 'sem transição pendente' };
    if (state.status === 'running') return { resolved: false, reason: `nó ${state.node} ainda em execução` };
    const closed = CLOSED_STATUSES.has(state.status);
    for (const p of pending) {
        const oldSpec = { hash: p.old_spec_hash, version: p.old_spec_version };
        const newSpec = { hash: p.new_spec_hash, version: p.new_spec_version };
        invalidateDerivedArtifacts(oldSpec, newSpec, state, {
            triggeredBy: p.triggered_by, at, case: closed ? 'closed' : (p.case || 'active_phase'), cause: p.cause || APPROVED, transitionId: p.transition_id,
        });
        syncSpecBlock(state, newSpec, { by: 'spec-change-propagation', ref: p.triggered_by, fromVersion: p.old_spec_version, at });
        if ((p.cause || APPROVED) === APPROVED) {
            state.spec_change_approved = true;
            state.spec_change_hash = p.new_spec_hash;
        }
    }
    delete state.pending_invalidation;
    if (!closed) state.node = 'plan';
    pushEvent(state, {
        type: 'invalidation_resolved', node: closed ? state.node : 'plan', at,
        detail: `${pending.map(p => `${p.transition_id} (nó ${p.phase})`).join(', ')} — transição de contrato aplicada${closed ? '; run encerrado, só os dados marcados' : '; task volta para o /plan'}`,
    });
    state.updated_at = at;
    return { resolved: true, case: closed ? 'closed' : pending.at(-1).case, transitions: pending.map(p => p.transition_id) };
}

/**
 * SPEC_CHANGE aprovada num run: registra a transição nos OUTROS runs ativos do mesmo
 * checkout que usam a mesma spec (replay, ciclo paralelo) — chamada ANTES de a spec nova
 * ser gravada (corrida 2). Nenhum run é pulado por já ter o hash novo: ter observado v2 não
 * é ter participado da transição. Run sem nó rodando também é invalidado na hora (caso A).
 * Nunca lança.
 * @returns {{task: string, case: string, error?: string}[]}
 */
function propagateSpecChange({ runsDir, specPath, oldSpec, newSpec, triggeredBy, transitionId, excludeTaskId = null, at = new Date().toISOString(), specRelFor }) {
    const out = [];
    let names = [];
    try { names = fs.readdirSync(runsDir, { withFileTypes: true }); } catch { return out; }
    for (const d of names) {
        if (!d.isDirectory() || d.name.startsWith('_') || d.name.startsWith('.') || d.name === excludeTaskId) continue;
        const dir = path.join(runsDir, d.name);
        const state = readJson(path.join(dir, 'state.json'));
        if (!state || typeof state !== 'object' || CLOSED_STATUSES.has(state.status) || state.status === 'state_corrupted') continue;
        if ((specRelFor ? specRelFor(state, d.name) : state.spec_path) !== specPath) continue;
        try {
            const kase = activity(state);
            // Journal primeiro (fonte durável); o caso A ainda aplica no state na hora.
            registerTransition(dir, transitionEntry({ transitionId, cause: APPROVED, triggeredBy, oldSpec, newSpec, kase, phase: state.node, at }));
            if (kase === 'idle') {
                // Read-modify-write dentro do lock do run irmão (scripts/state-writer.js).
                const written = require('./state-writer').update(dir, fresh => (
                    resolvePendingInvalidation(fresh, { runDir: dir, at }).resolved ? fresh : require('./cas').SKIP
                ), { operation: 'spec_change_propagation', actor: 'spec-change' });
                if (written) syncEvidenceFile(dir, written);
            }
            out.push({ task: d.name, case: kase });
        } catch (e) {
            out.push({ task: d.name, case: 'error', error: e.message });
        }
    }
    return out;
}

// ── Guardas das fases (leem validity; não recalculam) ────────────────────────────

/**
 * Transição de contrato pendente para o run → fail-closed (Verify, Commit).
 * @returns {{code: string, message: string}|null}
 */
function guardPending(state, runDir = null) {
    const pending = pendingTransitions(state, runDir);
    if (!pending.length) return null;
    return {
        code: 'PENDING_SPEC_INVALIDATION',
        message: `Transição de contrato pendente (${pending.map(p => `${p.transition_id}: spec ${versionLabel(p.new_spec_version, p.new_spec_hash)}`).join('; ')}) — ` +
            'os artefatos deste run ainda não foram reavaliados contra a spec nova. Execute novo ciclo (o watcher aplica a invalidação e volta ao /plan).',
    };
}

/**
 * Verify: só aceita evidence VALID e sem transição pendente. Recusa evidence com
 * spec_hash ≠ spec atual (STALE), invalidada por SPEC_CHANGE (registro STALE), sem hash
 * (UNKNOWN), ou qualquer evidence enquanto houver transição pendente.
 * @param {object} state
 * @param {object|null} evidenceData  acceptance-evidence.json parseado (null = ausente)
 * @param {{legacyEvidence?: boolean, current?: {hash, version}, runDir?: string, checkPending?: boolean}} [opts]
 * @returns {{ok: boolean, status: string|null, code?: string, message?: string}}
 */
function guardVerify(state, evidenceData, { legacyEvidence = false, current = null, runDir = null, checkPending = true } = {}) {
    if (checkPending) {
        const p = guardPending(state, runDir);
        if (p) return { ok: false, status: STALE, ...p };
    }
    const ref = current?.hash ? { hash: current.hash, version: current.version ?? specRef(state).version } : specRef(state);
    const atual = versionLabel(ref.version, ref.hash);
    if (legacyEvidence || (evidenceData && typeof evidenceData === 'object' && !evidenceData.spec_hash)) {
        return {
            ok: false, status: UNKNOWN, code: 'EVIDENCE_SPEC_UNKNOWN',
            message: `Evidence legada sem versão (${legacyEvidence ? 'ac-evidence.md' : EVIDENCE_FILE} sem spec_hash) — não comprova a Spec atual (${atual}). Execute novo ciclo.`,
        };
    }
    if (!evidenceData || typeof evidenceData !== 'object') return { ok: true, status: null };
    const byHash = classify(evidenceData.spec_hash, ref.hash);
    const stored = state?.artifact_validity?.evidence?.validity?.status || evidenceData.validity?.status || null;
    const status = byHash === VALID && stored === STALE ? STALE : byHash;
    if (status === VALID) {
        if (Number.isInteger(ref.version) && Number.isInteger(evidenceData.spec_version) && evidenceData.spec_version !== ref.version) {
            return {
                ok: false, status: STALE, code: 'EVIDENCE_SPEC_VERSION_MISMATCH',
                message: `Evidence registrou Spec v${evidenceData.spec_version} com o hash da Spec atual (v${ref.version}) — state.json.spec ou a matriz estão inconsistentes. Execute novo ciclo.`,
            };
        }
        return { ok: true, status: VALID };
    }
    if (status === UNKNOWN) {
        return { ok: false, status: UNKNOWN, code: 'EVIDENCE_SPEC_UNKNOWN', message: `Evidence sem Spec atual conhecida para comparar (state.json sem spec_hash) — não comprova a Spec atual. Execute novo ciclo.` };
    }
    const produced = Number.isInteger(evidenceData.spec_version) ? evidenceData.spec_version : (state?.artifact_validity?.evidence?.spec_version ?? null);
    const sameContract = classify(evidenceData.spec_hash, ref.hash) === VALID;
    return {
        ok: false, status: STALE, code: 'EVIDENCE_SPEC_STALE',
        message: sameContract
            ? `Evidence invalidada por SPEC_CHANGE aprovada (${state?.artifact_validity?.evidence?.stale_reason || 'registro STALE'}) — não comprova a Spec atual (${atual}). Execute novo ciclo.`
            : `Evidence produzida contra Spec ${versionLabel(produced, evidenceData.spec_hash)}, Spec atual é ${atual}. Execute novo ciclo.`,
    };
}

/**
 * Review: alerta quando o implement foi produzido contra outra versão (STALE), não tem
 * versão (UNKNOWN) ou há transição pendente. Nunca bloqueia — voltar ao Plan é decisão da
 * governança de SPEC_CHANGE. @returns {{status: string, compliance_valid: boolean, alert: string|null}}
 */
function guardReview(state, { runDir = null } = {}) {
    const pending = guardPending(state, runDir);
    if (pending) return { status: STALE, compliance_valid: false, alert: pending.message };
    const e = phaseEntry(state, 'implement');
    const ref = specRef(state);
    const status = e?.validity?.status || UNKNOWN;
    if (status === VALID) return { status, compliance_valid: true, alert: null };
    if (status === STALE) {
        return {
            status, compliance_valid: false,
            alert: `Implement produzido contra Spec ${versionLabel(e.spec_version, e.spec_hash)}. Compliance avaliada pode não refletir Spec ${versionLabel(ref.version, ref.hash)}.`,
        };
    }
    return {
        status, compliance_valid: false,
        alert: 'Implement é artefato legado sem versão (sem spec_hash) — a Compliance avaliada não é considerada válida para a Spec atual.',
    };
}

// ── Replay ───────────────────────────────────────────────────────────────────────

/**
 * Replay usa a Spec ATIVA (a do disco agora), não a do run original. Puro sobre os
 * dados: quem chama lê a spec e o JSON da matriz.
 *   spec mudou desde o run original → invalidação total, replay recomeça no plan;
 *   matriz de outra versão           → STALE, replay recomeça no test (evidence nova);
 *   matriz sem spec_hash (legado)    → UNKNOWN + aviso, replay recomeça no test.
 * @param {object} state  estado do replay (mutado)
 * @param {{activeHash: string|null, activeVersion?: number|null, evidenceData?: object|null, fromNode: string, at?: string}} p
 * @returns {{effectiveFrom: string, evidence: string|null, warnings: string[], invalidated: boolean}}
 */
function checkReplay(state, { activeHash, activeVersion = null, evidenceData = null, fromNode, at = new Date().toISOString() }) {
    const order = ['plan', 'implement', 'review', 'test', 'verify', 'commit'];
    const warnings = [];
    const before = (a, b) => order.indexOf(a) < order.indexOf(b);
    const runRef = specRef(state);
    if (!activeHash) return { effectiveFrom: fromNode, evidence: null, warnings, invalidated: false };
    if (runRef.hash && classify(runRef.hash, activeHash) !== VALID) {
        const newVersion = Number.isInteger(activeVersion) ? activeVersion : null;
        invalidateDerivedArtifacts(runRef, { hash: activeHash, version: newVersion }, state, { triggeredBy: 'replay', at, case: 'replay', cause: 'replay', transitionId: `replay:${short(runRef.hash)}→${short(activeHash)}`, evidenceData });
        syncSpecBlock(state, { hash: activeHash, version: newVersion }, { by: 'replay', ref: 'spec ativa no replay', fromVersion: runRef.version, at });
        warnings.push(`Spec ativa (${versionLabel(newVersion, activeHash)}) diferente da do run original (${versionLabel(runRef.version, runRef.hash)}) — artefatos do original STALE; o replay recomeça no plan contra a spec ativa.`);
        return { effectiveFrom: 'plan', evidence: STALE, warnings, invalidated: true };
    }
    const reusesEvidence = !before(fromNode, 'verify'); // verify/commit reaproveitam a matriz do test original
    if (!evidenceData || !reusesEvidence) return { effectiveFrom: fromNode, evidence: null, warnings, invalidated: false };
    const status = evidenceData.spec_hash ? classify(evidenceData.spec_hash, activeHash) : UNKNOWN;
    if (status === VALID) return { effectiveFrom: fromNode, evidence: VALID, warnings, invalidated: false };
    const e = store(state).evidence || {};
    store(state).evidence = {
        artifact: ARTIFACTS.evidence, spec_hash: evidenceData.spec_hash || null,
        spec_version: Number.isInteger(evidenceData.spec_version) ? evidenceData.spec_version : null,
        produced_at: e.produced_at ?? evidenceData.generated_at ?? null,
        validity: validityBlock(status, { staleSinceVersion: runRef.version }), stale_at: at, invalidated_by: 'replay',
    };
    warnings.push(status === UNKNOWN
        ? 'Evidence legada sem versão — não comprova Spec atual. O replay recomeça no test para produzir evidence nova.'
        : `Evidence produzida contra Spec ${versionLabel(evidenceData.spec_version, evidenceData.spec_hash)}, Spec ativa é ${versionLabel(runRef.version, activeHash)} — STALE; o replay recomeça no test.`);
    return { effectiveFrom: 'test', evidence: status, warnings, invalidated: false };
}

/**
 * Spec ATIVA de um run no disco agora: hash no algoritmo do run (spec-authority
 * specHashFor) e a versão do changelog cujo hash bate (null = sem versão conhecida).
 * @returns {{hash: string|null, version: number|null, specPath: string|null}}
 */
function activeSpec(root, state, taskId = null) {
    const sa = require('./lib/spec-authority');
    const sv = require('./lib/spec-version');
    const specPath = sa.specRelFor(state, taskId || state?.task_id);
    const content = sa.readSpec(root, specPath);
    if (content == null) return { hash: null, version: null, specPath };
    const hash = sa.specHashFor(state, content);
    const block = sv.readSpecBlock(state);
    let version = null;
    if (block) {
        const log = sv.readChangelog(root, block.changelog_path).data;
        const cur = sv.currentEntry(log);
        if (cur && classify(cur.hash, hash) === VALID) version = cur.version;
        else if (classify(block.hash, hash) === VALID) version = block.version;
    }
    return { hash, version, specPath };
}

// ── Arquivos ─────────────────────────────────────────────────────────────────────

function readJson(file) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

// state.json só pelo scripts/state-writer.js (lock + escrita atômica + state_version).
function writeState(runDir, state, operation) {
    require('./state-writer').write(runDir, state, { operation, actor: 'invalidate' });
}

function writeJsonAtomic(file, data, { indent = 2 } = {}) {
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, indent) + '\n');
    fs.renameSync(tmp, file);
}

/**
 * Espelha state.artifact_validity.evidence no bloco `validity` de acceptance-evidence.json.
 * Matriz legada (sem spec_hash) nunca é tocada. Preserva o mtime (marcar não é regerar).
 * @returns {boolean} gravou
 */
function syncEvidenceFile(runDir, state) {
    const file = path.join(runDir, EVIDENCE_FILE);
    const data = readJson(file);
    const v = state?.artifact_validity?.evidence?.validity;
    if (!data || typeof data !== 'object' || !data.spec_hash || !v) return false;
    if (JSON.stringify(data.validity) === JSON.stringify(v)) return false;
    let stat = null;
    try { stat = fs.statSync(file); } catch { /* sem mtime a preservar */ }
    data.validity = { ...v };
    writeJsonAtomic(file, data);
    if (stat) { try { fs.utimesSync(file, stat.atimeMs / 1000, stat.mtimeMs / 1000); } catch { /* best effort */ } }
    return true;
}

function readEvidence(runDir) {
    return readJson(path.join(runDir, EVIDENCE_FILE));
}

// ── Prompt e dashboard ───────────────────────────────────────────────────────────

/** Nota para o prompt do /plan despachado depois de uma invalidação. */
function promptNote(state) {
    const last = Array.isArray(state?.invalidations) ? state.invalidations.at(-1) : null;
    const plan = state?.artifact_validity?.plan?.validity?.status;
    if (!last || plan !== STALE) return '';
    return ` A spec mudou (${versionLabel(last.old_spec_version, last.old_spec_hash)} → ${versionLabel(last.new_spec_version, last.new_spec_hash)}, ` +
        `${last.triggered_by}${last.hash_scope_changed === false ? '; HASH_SCOPE inalterado — leia o "## Histórico de Mudanças" da spec' : ''}) e todos os artefatos derivados (${PHASES.join(', ')}) estão STALE em state.json.artifact_validity: ` +
        'refaça plan.md e handoff.md do zero contra a spec atual — não reaproveite a cobertura de ACs do plano antigo.';
}

const LABELS = {
    [VALID]: { badge: '✓ VALID', label: 'válido para a spec atual' },
    [STALE]: { badge: '⚠ STALE', label: 'produzido contra outra versão da spec' },
    [UNKNOWN]: { badge: null, label: 'legado sem versão' },
};

/**
 * Dados para o dashboard (RunDetail e trilho de nós): validade por fase e por AC.
 * Com transição pendente, toda fase aparece STALE (fail-closed). Só leitura; nenhum
 * segredo (só hashes, versões e status).
 */
function describe(state, { evidenceData = null, runDir = null } = {}) {
    const ref = specRef(state);
    const pending = pendingTransitions(state, runDir);
    const phases = {};
    for (const phase of PHASES) {
        const e = phaseEntry(state, phase, { evidenceData });
        if (!e) { phases[phase] = null; continue; }
        const status = pending.length && e.validity.status === VALID ? STALE : e.validity.status;
        const name = phase === 'evidence' ? 'Evidence' : ARTIFACTS[phase];
        phases[phase] = {
            artifact: e.artifact, status, spec_version: e.spec_version, spec_hash: e.spec_hash ? short(e.spec_hash) : null,
            stale_since_version: e.validity.stale_since_version, stale_acs: e.validity.stale_acs, derived: !!e.derived,
            badge: LABELS[status].badge, label: LABELS[status].label,
            message: status !== STALE ? (status === UNKNOWN ? 'legado sem versão' : null)
                : pending.length && e.validity.status === VALID ? `${name}: transição de contrato pendente (spec ${versionLabel(pending.at(-1).new_spec_version, pending.at(-1).new_spec_hash)}).`
                    : classify(e.spec_hash, ref.hash) === VALID ? `${name} invalidada por SPEC_CHANGE aprovada (${e.stale_reason || 'replanejamento obrigatório'}). Spec atual: ${versionLabel(ref.version, ref.hash)}.`
                        : `${name} produzida contra Spec ${versionLabel(e.spec_version, e.spec_hash)}. Spec atual: ${versionLabel(ref.version, ref.hash)}.`,
        };
    }
    const ev = phases.evidence;
    const acs = evidenceData?.coverage && typeof evidenceData.coverage === 'object'
        ? Object.entries(evidenceData.coverage).map(([ac, c]) => ({
            ac, test_status: c?.status || null,
            validity: ev?.status || UNKNOWN,
            // v1: stale_acs vazio = invalidação total — todo AC herda a validade da matriz.
            message: ev?.status === STALE ? ev.message : ev?.status === UNKNOWN ? 'legado sem versão' : null,
        }))
        : [];
    // Trilho: nó do grafo → fase cujo artefato ele produz.
    const nodes = { plan: phases.plan?.status ?? null, implement: phases.implement?.status ?? null, review: phases.review?.status ?? null, test: ev?.status ?? null, verify: phases.verify?.status ?? null };
    return {
        spec: { version: ref.version, hash: ref.hash ? short(ref.hash) : null, versioned: ref.versioned },
        phases, nodes, acs,
        pending_invalidation: pending.length ? pending : null,
        execution_spec: state?.execution_spec || null,
        last_invalidation: Array.isArray(state?.invalidations) ? state.invalidations.at(-1) || null : null,
    };
}

module.exports = {
    VALID, STALE, UNKNOWN, STATUSES, PHASES, ARTIFACTS, EVIDENCE_FILE, JOURNAL_FILE, STALE_FILES, APPROVED,
    classify, validityBlock, specRef, stampProduced, refresh, phaseEntry, effectiveStatus, isRegenerated, syncSpecBlock,
    invalidateDerivedArtifacts, applySpecChange, resolvePendingInvalidation, activity,
    registerTransition, pendingTransitions, readJournal, executionSpec, beginExecution, lastInvalidationAt,
    guardPending, guardVerify, guardReview, checkReplay, activeSpec, syncEvidenceFile, readEvidence, propagateSpecChange,
    promptNote, describe,
};

// ── CLI ──────────────────────────────────────────────────────────────────────────

if (require.main === module) {
    const args = process.argv.slice(2);
    const flag = name => { const a = args.find(x => x === `--${name}` || x.startsWith(`--${name}=`)); return a === undefined ? undefined : (a.includes('=') ? a.split('=').slice(1).join('=') : true); };
    const [cmd, target] = args.filter(a => !a.startsWith('--'));
    const usage = () => {
        console.error('Uso: node scripts/invalidate.js status <run-dir> [--json] | guard <run-dir> --phase=verify|commit|review | apply <run-dir> --new-hash=<h> [--new-version=N] [--old-hash=<h>] [--by=<quem>] | resolve <run-dir> | begin <run-dir> --node=<nó>');
        process.exit(2);
    };
    if (!cmd || !target) usage();
    const runDir = path.resolve(target);
    const stateFile = path.join(runDir, 'state.json');
    const state = readJson(stateFile);
    if (!state) { console.error(`${target}: state.json ausente ou ilegível.`); process.exit(2); }
    const evidenceData = readEvidence(runDir);

    if (cmd === 'status') {
        const d = describe(state, { evidenceData, runDir });
        if (flag('json')) { console.log(JSON.stringify(d, null, 2)); process.exit(0); }
        console.log(`Spec atual: ${versionLabel(d.spec.version, d.spec.hash)}${d.spec.versioned ? '' : ' (run legado)'}`);
        for (const phase of PHASES) {
            const p = d.phases[phase];
            console.log(`${phase.padEnd(10)} ${p ? `${p.status}${p.message ? ` — ${p.message}` : ''}${p.derived ? ' (derivado)' : ''}` : '— (ainda não produzido)'}`);
        }
        for (const p of d.pending_invalidation || []) console.log(`pendente: ${p.transition_id} (${p.case}, nó ${p.phase}, spec ${versionLabel(p.new_spec_version, p.new_spec_hash)})`);
        process.exit(0);
    }
    if (cmd === 'guard') {
        const phase = flag('phase');
        if (phase === 'verify') {
            const legacy = !evidenceData && fs.existsSync(path.join(runDir, 'ac-evidence.md'));
            const g = guardVerify(state, evidenceData, { legacyEvidence: legacy, runDir });
            if (g.ok) { console.log(`[invalidate] verify: evidence ${g.status || 'ausente (o verify reprova por EVIDENCE_MISSING)'}`); process.exit(0); }
            console.error(`[invalidate] RECUSADA ${g.code}: ${g.message}`);
            process.exit(1);
        }
        if (phase === 'commit') {
            const g = guardPending(state, runDir);
            if (!g) { console.log('[invalidate] commit: nenhuma transição de contrato pendente.'); process.exit(0); }
            console.error(`[invalidate] RECUSADA ${g.code}: ${g.message}`);
            process.exit(1);
        }
        if (phase === 'review') {
            const g = guardReview(state, { runDir });
            console.log(g.alert ? `[invalidate] ALERTA (${g.status}): ${g.alert}` : '[invalidate] review: implement VALID para a spec atual.');
            process.exit(0);
        }
        usage();
    }
    if (cmd === 'apply') {
        const newHash = flag('new-hash');
        if (typeof newHash !== 'string') usage();
        const nv = Number(flag('new-version'));
        const oh = flag('old-hash');
        const by = typeof flag('by') === 'string' ? flag('by') : 'manual';
        const res = applySpecChange(state, {
            oldSpec: typeof oh === 'string' ? { hash: oh, version: specRef(state).version } : undefined,
            newSpec: { hash: newHash, version: Number.isInteger(nv) && nv > 0 ? nv : null },
            triggeredBy: by, transitionId: `manual:${by}:${short(newHash)}`, cause: 'manual', runDir, evidenceData,
        });
        if (res.invalidated) { writeState(runDir, state, 'invalidate_apply'); syncEvidenceFile(runDir, state); }
        console.log(`[invalidate] caso ${res.case}${res.deferred ? ' — transição registrada (pending-invalidation.jsonl)' : res.invalidated ? ` — artefatos STALE, node=${state.node}` : ' — nada invalidado'}`);
        process.exit(0);
    }
    if (cmd === 'begin') {
        const node = flag('node');
        if (typeof node !== 'string') usage();
        const active = activeSpec(path.resolve(runDir, '..', '..', '..'), state, path.basename(runDir));
        if (!active.hash) { console.log('[invalidate] begin: sem spec — nada a registrar.'); process.exit(0); }
        if (beginExecution(state, node, active)) writeState(runDir, state, 'invalidate_begin');
        console.log(`[invalidate] execution_spec de ${node}: ${versionLabel(state.execution_spec.spec_version, state.execution_spec.spec_hash)} (desde ${state.execution_spec.started_at})`);
        process.exit(0);
    }
    if (cmd === 'resolve') {
        const res = resolvePendingInvalidation(state, { runDir });
        if (res.resolved) { writeState(runDir, state, 'invalidate_resolve'); syncEvidenceFile(runDir, state); }
        console.log(`[invalidate] ${res.resolved ? `transição aplicada (${res.case}); node=${state.node}` : res.reason}`);
        process.exit(0);
    }
    usage();
}
