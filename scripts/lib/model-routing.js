// Roteamento de modelo por Attempt (PRI-233 / PRI-205 S4), resolução do v9 §4.7.
//
// Funções puras: não leem disco, relógio nem rede. A ligação com o watcher (snapshot
// na admissão, despacho por nó) fica fora deste módulo.
//
// - buildRoutingSnapshot: fixa o snapshot `routing` da Run na admissão, a partir da
//   leitura validada do consumidor (model-routing-policy.readRoutingConfig). O
//   snapshot carrega a policy inteira: a resolução nunca relê a config corrente.
// - resolveRoute: roda no início de cada Attempt, nesta ordem:
//   (1) snapshot legível e íntegro → senão CONFIG_UNVERIFIABLE;
//   (2) provider elegível → senão PROVIDER_NOT_ELIGIBLE;
//   (3) override humano (subtarefa > nó > ticket, vigente a partir do limite do nó, D-4);
//   (4) classificadora R1–R8 da S3 (Implement = classe máxima dos grupos, A1;
//       demais nós = default_route fixo, A2/D6);
//   (5) candidatos do tier na ordem da policy, subindo de tier e nunca descendo;
//   depois, a precondição do despacho roteado: plugin de roteamento provado desligado
//   (SP-2) → senão CONFIG_UNVERIFIABLE. O esforço só vai no argv com mecanismo
//   verificado (SP-1 revista); sem ele, roteia só o modelo.
// - routedArgs: acrescenta --model, o esforço (se aplicado) e --settings ao argv, só a partir de
//   uma resolução ok.
//
// Recusa nunca troca modelo em silêncio e nunca cai para o modelo herdado (guarda 3).
// Subagente fica UNENFORCED (RC-1/DP-4b). O núcleo 2 (Jev, PRI-205 S3b) entra só como
// registro (input.nucleus2, coletado antes por classifier-shadow): nunca muda classe,
// candidatos, escolhido ou argv.

const crypto = require('crypto');
const wouldRoute = require('./would-route');
const policyLoader = require('./model-routing-policy');

// SP-1 revista (Richard, 2026-11-06: foco no modelo, esforço adiado): o mecanismo de
// esforço no `claude -p` não foi verificado (U1). Em produção ele é UNAVAILABLE, sem env
// nem flag que o ligue (AD-5), e o despacho roteado vai SÓ com --model; o esforço fica
// registrado como não aplicado (decision.effort_applied = false).
const PRODUCTION_EFFORT_MECHANISM = Object.freeze({ status: 'UNAVAILABLE', reason: 'U1_UNVERIFIED' });

const TIER_ORDER = ['T1', 'T2', 'T3'];
const CLASS_RANK = wouldRoute.CLASS_RANK;
const ROUTED_NODE = 'implement';
const PROVIDER = 'anthropic';

function canonical(value) {
    if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
    if (value && typeof value === 'object') {
        return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
    }
    return JSON.stringify(value === undefined ? null : value);
}

function sha256(value) {
    return crypto.createHash('sha256').update(canonical(value)).digest('hex');
}

function tierOf(policy, modelId) {
    return TIER_ORDER.find(t => policy.tiers[t].models.includes(modelId)) || null;
}

/**
 * @param {{ status: string, policy?: object, policy_ref?: object }} loaded saída de readRoutingConfig
 * @param {{ classifierEffective?: object|null, classifierSelection?: object|null }} [opts] núcleo 2
 *   efetivo decidido na admissão (classifier-authority.evaluateClassifier) e a seleção do
 *   classificador lida do registro (classifier-selection.effectiveClassifier), PRI-205 S3b.
 *   Ausentes, ou seleção vinda da policy (sem registro) = snapshot igual ao da S4.
 */
function buildRoutingSnapshot(loaded, { classifierEffective = null, classifierSelection = null } = {}) {
    if (!loaded || loaded.status !== 'ON' || !loaded.policy || !loaded.policy_ref) {
        throw new Error('ROUTING_SNAPSHOT_REQUIRES_ON');
    }
    const policy = loaded.policy;
    const models = [];
    for (const t of TIER_ORDER) for (const m of policy.tiers[t].models) if (!models.includes(m)) models.push(m);
    const eligible_set = { provider: PROVIDER, models };
    const body = {
        mode: 'ON',
        policy_ref: { ...loaded.policy_ref },
        policy: structuredClone(policy),
        default_route: { model_id: policy.default_route.model_id, effort: policy.default_route.effort },
        eligible_set,
        eligible_set_ref: sha256(eligible_set),
    };
    if (classifierSelection && classifierSelection.source !== 'POLICY') {
        const invalid = classifierSelection.source === 'INVALID';
        body.classifier_selection = {
            source: classifierSelection.source,
            version: classifierSelection.selection_ref?.version ?? null,
            sha256: classifierSelection.selection_ref?.sha256 ?? null,
            provider: invalid ? 'off' : (classifierSelection.classifier?.provider ?? 'off'),
            mode: invalid ? null : (classifierSelection.classifier?.mode ?? null),
            reason: classifierSelection.reason ?? null,
        };
    }
    if (classifierEffective) body.classifier_effective = structuredClone(classifierEffective);
    return { ...body, sha256: sha256(body) };
}

/** @returns {{ ok: true } | { ok: false, detail: string }} */
function snapshotIntegrity(snapshot) {
    if (snapshot == null) return { ok: false, detail: 'snapshot_missing' };
    if (typeof snapshot !== 'object' || Array.isArray(snapshot)) return { ok: false, detail: 'snapshot_not_object' };
    const { sha256: declared, ...body } = snapshot;
    if (typeof declared !== 'string' || sha256(body) !== declared) return { ok: false, detail: 'snapshot_hash_mismatch' };
    if (snapshot.mode !== 'ON') return { ok: false, detail: 'snapshot_mode_not_on' };
    if (!snapshot.policy || !snapshot.default_route || !snapshot.eligible_set) return { ok: false, detail: 'snapshot_incomplete' };
    // Hash coerente não basta: a policy embutida precisa ser roteável, senão a resolução
    // quebraria a cada tick sem deixar Attempt (revisão do Checkpoint B, MINOR-5).
    if (!policyLoader.validateRoutedPolicy(snapshot.policy).ok) return { ok: false, detail: 'snapshot_policy_invalid' };
    if (!Array.isArray(snapshot.eligible_set.models)) return { ok: false, detail: 'snapshot_incomplete' };
    return { ok: true };
}

function validInstant(v) {
    return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(v) && Number.isFinite(Date.parse(v));
}

// Override aplicável ao Attempt: escopo casa e foi gravado até o limite do nó (D-4).
// Mais específico vence; no mesmo escopo, o mais recente; empate pela ordem recebida.
function pickOverride(overrides, { node, subtaskKey, nodeBoundaryAt }) {
    const SCOPE_RANK = { subtask: 3, node: 2, ticket: 1 };
    const matches = (Array.isArray(overrides) ? overrides : []).filter(o => o && (
        (o.scope === 'subtask' && subtaskKey != null && o.subtask_key === subtaskKey)
        || (o.scope === 'node' && o.node === node)
        || o.scope === 'ticket'
    ));
    const boundary = validInstant(nodeBoundaryAt) ? Date.parse(nodeBoundaryAt) : null;
    const effective = [];
    const pending = [];
    for (const o of matches) {
        if (boundary != null && validInstant(o.recorded_at) && Date.parse(o.recorded_at) <= boundary) effective.push(o);
        else pending.push(o.ref ?? null);
    }
    let best = null;
    for (const o of effective) {
        if (!best
            || SCOPE_RANK[o.scope] > SCOPE_RANK[best.scope]
            || (SCOPE_RANK[o.scope] === SCOPE_RANK[best.scope] && Date.parse(o.recorded_at) > Date.parse(best.recorded_at))) {
            best = o;
        }
    }
    return { override: best, pending };
}

function overrideRef(o) {
    return {
        ref: o.ref ?? null, scope: o.scope, by: o.by ?? null, recorded_at: o.recorded_at ?? null,
        value: { model_id: o.value?.model_id ?? null, effort: o.value?.effort ?? null },
    };
}

// Implement: classe máxima dos grupos (A1). Sinais ausentes/incompletos → C4 conservador.
function classifyImplement(signals, planClasses) {
    const groups = signals && typeof signals === 'object' && signals.status === 'COMPLETE' && Array.isArray(signals.groups)
        ? signals.groups : [];
    if (!groups.length) return { class: 'C4', selection_source: 'CONSERVATIVE_DEFAULT', rule: null };
    let best = null;
    for (const g of groups) {
        const planClass = g.plan_class || (planClasses && planClasses[g.subtask_key]) || null;
        const hit = wouldRoute.classifySubtask(g.signals || {}, planClass);
        if (!best || CLASS_RANK[hit.class] > CLASS_RANK[best.class]) best = hit;
    }
    return { class: best.class, selection_source: best.selection_source, rule: best.rule };
}

// classifier_ref (V7-02, PRI-205 S3b T7): os 8 campos explícitos em toda decisão, mais
// declared/nucleus2_effective/reason (compatíveis com a S4). Derivado só do snapshot:
// igual em todos os Attempts da Run. model_version = UNKNOWN quando o modelo pedido é
// alias (`*latest*`); a versão reportada pelo servidor fica em cada opinião (Q10).
function classifierRef(snapshot, nucleus2) {
    // Com registro de seleção (B11) o declarado é o do registro; sem ele, o da policy.
    const sel = snapshot.classifier_selection || null;
    const declared = sel ? sel.provider : (snapshot.policy.classifier?.provider || 'off');
    const base = {
        provider: null, model_id: null, model_version: null, prompt_sha256: null, enum_version: null,
        mode: null, classifier_version: null, policy_sha256: snapshot.policy_ref?.sha256 ?? null,
        declared, nucleus2_effective: 'off', reason: null, selection_version: sel ? sel.version : null,
    };
    if (sel && sel.source === 'INVALID') return { ...base, provider: 'off', reason: sel.reason };
    if (declared !== 'jev') return { ...base, provider: declared, reason: declared === 'off' ? 'DECLARED_OFF' : 'NUCLEUS1_ONLY' };
    const eff = snapshot.classifier_effective;
    if (!eff) return { ...base, provider: 'off', reason: 'AUTHORITY_REF_ABSENT' };
    if (eff.provider !== 'jev') return { ...base, provider: 'off', reason: eff.reason ?? null };
    const jevClient = require('./jev-client');
    const on = Boolean(nucleus2 && nucleus2.status === 'ON');
    return {
        ...base,
        provider: 'jev',
        model_id: eff.model_id,
        model_version: /latest/i.test(String(eff.model_id)) ? 'UNKNOWN' : eff.model_id,
        prompt_sha256: jevClient.promptSha256(),
        enum_version: jevClient.ENUM_VERSION,
        mode: 'shadow',
        classifier_version: jevClient.CLIENT_VERSION,
        nucleus2_effective: on ? 'shadow' : 'off',
        reason: nucleus2 && !on ? (nucleus2.reason ?? null) : (eff.reason ?? null),
    };
}

// Núcleo 2 só no nó roteado. A classe de nó hipotética é o máximo, por grupo, do
// would_class da opinião (ou da classe do núcleo 1, sem opinião). Só registro.
function nucleus2Record(routed, nucleus2, signals, planClasses) {
    if (!routed || !nucleus2) return { record: null, wouldNode: null };
    const opinions = Array.isArray(nucleus2.opinions) ? nucleus2.opinions : [];
    const record = { status: nucleus2.status, reason: nucleus2.reason ?? null, groups: structuredClone(opinions) };
    if (nucleus2.status !== 'ON') return { record, wouldNode: null };
    const groups = signals && signals.status === 'COMPLETE' && Array.isArray(signals.groups) ? signals.groups : [];
    if (!groups.length) return { record, wouldNode: null };
    let wouldNode = null;
    for (const g of groups) {
        const planClass = g.plan_class || (planClasses && planClasses[g.subtask_key]) || null;
        const own = wouldRoute.classifySubtask(g.signals || {}, planClass).class;
        const op = opinions.find(o => o && o.subtask_key === g.subtask_key && CLASS_RANK[o.would_class]);
        const w = op ? op.would_class : own;
        if (!wouldNode || CLASS_RANK[w] > CLASS_RANK[wouldNode]) wouldNode = w;
    }
    return { record, wouldNode };
}

function refuse(cause, detail, decision = null) {
    return { ok: false, result: 'NOT_STARTED', cause, detail, decision };
}

/**
 * @param {{
 *   snapshot: object, node: string, signals?: any, planClasses?: Record<string,string>,
 *   overrides?: object[], subtaskKey?: string|null, nodeBoundaryAt?: string|null,
 *   provider?: { state?: string }, ineligibleModels?: string[],
 *   capabilities?: { effortMechanism?: { status?: string, flag?: string }, pluginProof?: { status?: string, settings_path?: string, settings_sha256?: string } },
 *   nucleus2?: { status: 'ON'|'OFF', reason: string|null, opinions: object[] } | null,
 * }} input
 */
function resolveRoute(input = {}) {
    const { snapshot, node, signals, planClasses, overrides, subtaskKey = null, nodeBoundaryAt = null } = input;

    // (1) Snapshot.
    const integrity = snapshotIntegrity(snapshot);
    if (!integrity.ok) return refuse('CONFIG_UNVERIFIABLE', integrity.detail);

    // (2) Provider (estado operacional, HD-AF-034). UNKNOWN nunca vale como elegível.
    const state = input.provider?.state || 'UNKNOWN';
    if (state !== 'ACTIVE') return refuse('PROVIDER_NOT_ELIGIBLE', `provider_${String(state).toLowerCase()}`);

    const policy = snapshot.policy;
    const ineligible = new Set(Array.isArray(input.ineligibleModels) ? input.ineligibleModels : []);
    const isEligible = m => snapshot.eligible_set.models.includes(m) && !ineligible.has(m);
    const routed = node === ROUTED_NODE;
    const classified = routed ? classifyImplement(signals, planClasses) : { class: null, selection_source: 'FIXED_NODE', rule: null };
    const { override, pending } = pickOverride(overrides, { node, subtaskKey, nodeBoundaryAt });
    const n2 = nucleus2Record(routed, input.nucleus2, signals, planClasses);

    const decision = {
        node,
        snapshot_sha256: snapshot.sha256,
        policy_ref: { ...snapshot.policy_ref },
        eligible_set_ref: snapshot.eligible_set_ref,
        class: classified.class,
        class_rule: classified.rule,
        signals_sha256: routed ? sha256(signals ?? null) : null,
        classifier_ref: classifierRef(snapshot, routed ? input.nucleus2 : null),
        nucleus2: n2.record,
        nucleus2_would_node_class: n2.wouldNode,
        candidates: [],
        chosen: null,
        selection_source: classified.selection_source,
        override_ref: override ? overrideRef(override) : null,
        overrides_pending: pending,
        subagent: 'UNENFORCED',
        effort_router_plugin: input.capabilities?.pluginProof?.status || 'UNKNOWN',
        plugin_proof: null,
        effort_mechanism: input.capabilities?.effortMechanism?.status === 'VERIFIED'
            ? { status: 'VERIFIED', flag: input.capabilities.effortMechanism.flag }
            : { status: 'UNAVAILABLE' },
    };
    // Gravado já aqui (NIT da revisão): toda decisão, inclusive recusada, diz se o esforço iria.
    decision.effort_applied = decision.effort_mechanism.status === 'VERIFIED' && typeof decision.effort_mechanism.flag === 'string';
    const choose = (model_id, effort, tier) => {
        decision.chosen = { model_id, effort, cli_effort: policy.effort_map[effort], tier };
    };

    // (3) Override humano: prevalece, mas nunca força despacho inelegível.
    if (override) {
        const value = override.value || {};
        const okModel = typeof value.model_id === 'string' && isEligible(value.model_id);
        const okEffort = typeof value.effort === 'string' && Object.prototype.hasOwnProperty.call(policy.effort_map, value.effort);
        if (!okModel || !okEffort) return refuse('PROVIDER_NOT_ELIGIBLE', 'override_ineligible', decision);
        const tier = tierOf(policy, value.model_id);
        decision.candidates = [{ tier, model_id: value.model_id, status: 'CHOSEN', reason: 'HUMAN_OVERRIDE' }];
        decision.selection_source = 'HUMAN_OVERRIDE';
        choose(value.model_id, value.effort, tier);
    } else if (!routed) {
        // (4, A2) Nó fixo: default_route explícito da policy.
        const dr = snapshot.default_route;
        const tier = tierOf(policy, dr.model_id);
        if (!isEligible(dr.model_id)) {
            decision.candidates = [{ tier, model_id: dr.model_id, status: 'DISCARDED', reason: 'INELIGIBLE' }];
            return refuse('PROVIDER_NOT_ELIGIBLE', 'default_route_ineligible', decision);
        }
        decision.candidates = [{ tier, model_id: dr.model_id, status: 'CHOSEN', reason: null }];
        choose(dr.model_id, dr.effort, tier);
    } else {
        // (5) Candidatos do tier da classe, subindo de tier, nunca descendo.
        const row = policy.class_to_tier[classified.class];
        for (const tier of TIER_ORDER.slice(TIER_ORDER.indexOf(row.tier))) {
            for (const model_id of policy.tiers[tier].models) {
                if (decision.chosen) break;
                if (!isEligible(model_id)) {
                    decision.candidates.push({ tier, model_id, status: 'DISCARDED', reason: 'INELIGIBLE' });
                    continue;
                }
                decision.candidates.push({ tier, model_id, status: 'CHOSEN', reason: null });
                choose(model_id, row.effort, tier);
            }
            if (decision.chosen) break;
        }
        if (!decision.chosen) return refuse('PROVIDER_NOT_ELIGIBLE', 'no_eligible_candidate', decision);
    }

    // Esforço (SP-1 revista pelo Richard em 2026-11-06: "o esforço pode ser adiado"): sem
    // mecanismo verificado o despacho roteia SÓ o modelo (effort_applied: false, acima);
    // nunca bloqueia por isso. Com mecanismo verificado, o par vai inteiro.
    // Precondição do despacho roteado (SP-2): plugin de roteamento provado desligado.
    const proof = input.capabilities?.pluginProof;
    if (!proof || proof.status !== 'NOT_LOADED' || typeof proof.settings_path !== 'string') {
        return refuse('CONFIG_UNVERIFIABLE', 'PLUGIN_NOT_PROVEN_OFF', decision);
    }
    decision.plugin_proof = { settings_path: proof.settings_path, settings_sha256: proof.settings_sha256 ?? null };
    return { ok: true, result: 'RESOLVED', cause: null, detail: null, decision };
}

function routedArgs(baseArgs, resolution) {
    if (!resolution || resolution.ok !== true || !resolution.decision?.chosen) {
        throw new Error('ROUTED_ARGS_REQUIRE_OK_DECISION');
    }
    const d = resolution.decision;
    return [
        ...baseArgs,
        '--model', d.chosen.model_id,
        ...(d.effort_applied ? [d.effort_mechanism.flag, d.chosen.cli_effort] : []),
        '--settings', d.plugin_proof.settings_path,
    ];
}

module.exports = {
    buildRoutingSnapshot,
    snapshotIntegrity,
    resolveRoute,
    routedArgs,
    canonicalSha256: sha256,
    ROUTED_NODE,
    PRODUCTION_EFFORT_MECHANISM,
    _classifySubtask: wouldRoute.classifySubtask,
};
