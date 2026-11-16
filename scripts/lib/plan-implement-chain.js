'use strict';
// PRI-354 (resto do AC5 da PRI-353): segmento [plan, implement] numa sessão `claude -p`, atrás de
// WATCHER_PLAN_IMPLEMENT_CHAIN (desligada por padrão; flag e argv em subagent-block.js).
// SPEC: tasks/pri-354/SPEC.md.
//
// O segmento substitui o plan avulso só quando todas as condições de chainEligibility valem;
// fora delas o despacho é o de sempre. Portões entre plan e implement:
// - plan-scorer: roda DENTRO da sessão, pelo CLI que já existe, entre /plan e /implement (mesmo
//   padrão do spec-validator no segmento fetch_ticket+plan). Reprovado = o agente para sem
//   /implement e o próximo tick cai no runPlanGate do watcher (re-plan/escalada de sempre);
// - pré-build: o segmento só é elegível com SKIP_PRE_BUILD_VALIDATION=true;
// - churn: a âncora é gravada pelo watcher antes do segmento (o plan só escreve em memory/);
// - drift de spec: volta a ser conferido antes do review (GUARDED_NODES).
//
// Registro dos dois nós: o lease leva `nodes: [plan, implement]` e `chain` com o tamanho do
// histórico no despacho e o Attempt DOM06 do implement. Na saída, só os nós que de fato rodaram
// entram nos eventos; o Attempt do implement fecha pelo código de saída se o implement rodou e é
// revogado (CHAIN_STOPPED_AFTER_PLAN) se não rodou — nunca conta como PASS sem ter rodado.

const fs = require('fs');
const path = require('path');

const ELIGIBILITY_ORDER = [
    ['FLAG_OFF', c => !c.enabled],
    ['NOT_PLAN', c => c.node !== 'plan'],
    ['IMPLEMENT_IN_HISTORY', c => (Array.isArray(c.state?.history) ? c.state.history : []).includes('implement')],
    ['ROUTED', c => !!c.routed],
    ['DECOMPOSED', c => !!c.decomposed],
    ['PRE_BUILD_ACTIVE', c => !c.preBuildSkipped],
    ['SPEC_MISSING', c => !c.specExists],
];

function chainEligibility(ctx = {}) {
    for (const [reason, fails] of ELIGIBILITY_ORDER) if (fails(ctx)) return { eligible: false, reason };
    return { eligible: true, reason: null };
}

const planRel = taskId => `memory/runs/${taskId}/plan.md`;
const specRel = ticketId => `memory/spec/${ticketId}-spec.md`;
const scorerCommand = ({ taskId, ticketId, prismaRoot }) =>
    `node "${prismaRoot}/scripts/lib/plan-scorer.js" ${planRel(taskId)} ${specRel(ticketId)}`;

function chainCommands({ taskId, ticketId, prismaRoot }) {
    return [`/plan ${taskId}`, scorerCommand({ taskId, ticketId, prismaRoot }), `/implement ${taskId}`];
}

function chainNote({ taskId, ticketId, prismaRoot }) {
    return (
        'Plan e implement rodam nesta mesma sessão. Durante o /plan, trabalhe sem subagente (sem Agent/Task), ' +
        'como manda o template do /plan. Ao terminar o /plan (plan.md escrito e node="implement" gravado), ' +
        `rode \`${scorerCommand({ taskId, ticketId, prismaRoot })}\`: se sair com código diferente de 0, NÃO rode o ` +
        '/implement; pare aí, sem mexer no state.json por causa disso (o orquestrador reavalia o plano no próximo ' +
        'ciclo). Se sair 0, siga para o /implement.'
    );
}

// Detecção dos nós que rodaram. A elegibilidade garante que não havia `implement` no histórico no
// despacho, então qualquer `implement` no histórico é deste segmento (G3, MAJOR 1: no re-plan o
// histórico já termina em `plan` e o agente pode não duplicá-lo). O plan concluiu se o implement
// rodou ou se o próprio /plan avançou state.node (grava node="implement" no fim).
function implementRan(lease, state) {
    return Array.isArray(state?.history) && state.history.includes('implement');
}

function planDone(lease, state) {
    if (!state) return false;
    return implementRan(lease, state) || (typeof state.node === 'string' && state.node !== 'plan');
}

// Mantido por compatibilidade com quem lia "o plan rodou" (= concluiu).
const planRan = planDone;

// O state.json é deste despacho? Mesma regra do recordNodeExit (node_started_at do lease) mais o
// claim do release (G3, MAJOR 3: state de outro despacho nunca decide este segmento).
const LOST_CLAIMS = new Set(['LEASE_REPLACED', 'SESSION_CONFLICT', 'STATE_MISSING', 'CLAIM_UNKNOWN']);
function ownsState(lease, state, claim = null) {
    if (!state || (claim && LOST_CLAIMS.has(claim))) return false;
    return !(state.node_started_at && lease?.startedAt && state.node_started_at !== lease.startedAt);
}

const noCode = code => code === null || code === undefined || code === '';

// Nós que entram nos eventos de saída. Plan concluído e saída com erro = o erro é do implement
// (G3, MAJOR 2), mesmo que ele não tenha chegado a gravar o histórico.
function exitNodes(lease, state, code = 0) {
    if (!lease?.chain) return lease?.nodes || (lease?.node ? [lease.node] : []);
    if (implementRan(lease, state)) return ['plan', 'implement'];
    return planDone(lease, state) && code !== 0 ? ['plan', 'implement'] : ['plan'];
}

function retriesBeforeFor(lease, nodes) {
    const byNode = lease?.chain?.retriesBefore;
    const last = nodes[nodes.length - 1];
    if (byNode && Object.hasOwn(byNode, last)) return Number(byNode[last]) || 0;
    return lease?.retriesBefore || 0;
}

// Código com que o Attempt do plan fecha: plan concluído conta como 0 mesmo se a sessão caiu depois
// (no implement). Sem posse do state, ou sem saída final, fica o código de sempre.
function planExitCode(lease, code, state, { claim = null, signalled = false } = {}) {
    if (!lease?.chain || code === 0) return code;
    if (noCode(code) && !signalled) return code;
    if (!ownsState(lease, state, claim)) return code;
    return planDone(lease, state) ? 0 : code;
}

// Desfecho do Attempt do implement. Nunca fica contado como PASS sem prova de que rodou neste
// despacho; sem saída final (destacado em voo) não decide nada.
// G3 (MINOR 5): o scorer roda dentro da sessão, aplicado pelo agente. Na saída, com o implement
// rodado, o watcher confere o mesmo plano com o mesmo scorer (puro, mesmo limiar). Sem plano ou
// spec legível = sem prova (null).
function planGateResult(lease) {
    const specPath = lease?.chain?.specPath;
    if (!lease?.dir || !specPath) return null;
    try {
        const plan = fs.readFileSync(path.join(lease.dir, 'plan.md'), 'utf8');
        const spec = fs.readFileSync(specPath, 'utf8');
        return require('./plan-scorer').scorePlan(plan, spec);
    } catch {
        return null;
    }
}

function closeImplementAttempt(lease, code, state, dom06, { claim = null, signalled = false, planGate = () => planGateResult(lease) } = {}) {
    const c = lease?.chain;
    if (!c || !c.implementAttemptFile || !c.implementAttemptId) return null;
    if (noCode(code) && !signalled) return 'PENDING';
    const revoke = reason => { dom06.revoke(c.implementAttemptFile, { reason }); return 'REVOKED'; };
    if (!state) return revoke('CHAIN_STATE_UNREADABLE');
    if (!ownsState(lease, state, claim)) return revoke('CHAIN_CLAIM_LOST');
    if (implementRan(lease, state)) {
        const gate = planGate();
        if (!gate) return revoke('CHAIN_PLAN_GATE_UNKNOWN');
        if (!gate.passed) return revoke('CHAIN_PLAN_GATE_FAILED');
        dom06.closeOnExit({ attemptFile: c.implementAttemptFile, attemptId: c.implementAttemptId, node: 'implement', code: noCode(code) ? 1 : code });
        return 'CLOSED';
    }
    if (!planDone(lease, state)) return revoke('CHAIN_PLAN_NOT_DONE');
    return revoke(code === 0 ? 'CHAIN_STOPPED_AFTER_PLAN' : 'CHAIN_IMPLEMENT_NOT_CONFIRMED');
}

function readLeaseState(lease) {
    try {
        return JSON.parse(fs.readFileSync(path.join(lease.dir, 'state.json'), 'utf8'));
    } catch {
        return null;
    }
}

// Saída única para os dois caminhos de release (watcher em --follow e node-lease.js CLI).
// Nunca lança: falha aqui é logada e o release segue.
function closeChainOnExit(lease, code, { dom06 = require('./dom06-attempt'), claim = null, signalled = false } = {}) {
    if (!lease?.chain) return null;
    try {
        return closeImplementAttempt(lease, code, lease.dir ? readLeaseState(lease) : null, dom06, { claim, signalled });
    } catch (e) {
        console.error(`[chain] falha fechando o Attempt do implement: ${e.message}`);
        return null;
    }
}

module.exports = {
    chainEligibility, chainCommands, chainNote, planRan, planDone, implementRan, ownsState, exitNodes, retriesBeforeFor,
    planExitCode, closeImplementAttempt, closeChainOnExit, readLeaseState, planGateResult,
};
