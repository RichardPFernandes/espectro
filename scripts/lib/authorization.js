// Pedido de autorização humana para ação externa privilegiada (PRI-180). Caso que
// motivou: o /implement da Recusa QA do #42359 concluiu que o defeito era do banco (check
// constraint sem SERVICO_ADICIONAL, SQL já versionado) e só podia parar em "blocked" com
// o motivo em texto. Agora o agente registra um pedido ESTRUTURADO e um humano decide no
// dashboard.
//
//   state.status = "authorization-pending"
//   state.pending_authorization = { id, kind: "db_migration", summary, target_hint?:
//     { alias?, datasource?, env? } (só SUGESTÃO do agente), artifact (relativo ao repo
//     consumidor), artifact_sha256, verify_sql (só leitura), expected, expected_contains?,
//     then ("handback_qa" | "resume:<nó>"), requested_by, requested_at, phase,
//     target?: { alias } (gravado na APROVAÇÃO, escolhido pelo aprovador na allowlist) }
//   state.authorization_history[] = { id, event, by, via, at, ... } (append-only)
//
// phase: pending (esperando decisão) → executing (aprovado; db-effect rodando) →
// [sucesso: aplica `then`] | failed (falha certa: transação desfeita, ou recusado antes de
// conectar) | uncertain (pode ter commitado) | handback (SQL ok, devolvendo ao QA).
//
// Quem decide: SÓ os endpoints do dashboard (POST /api/runs/:id/authorization/*), com
// aprovador autenticado (scripts/lib/approvers.js), CAS (expected_state_version +
// operation_id) e quem/qual alvo/quando em authorization_history. O banco alvo é
// escolhido por quem aprova; trocar o alvo depois exige nova aprovação.
// A CLI abaixo só registra o pedido (agente) e lê o status: não há comando de aprovar,
// recusar ou executar. O intérprete de mensagem livre (watcher, human-input-intent) não
// roda em authorization-pending, e a execução não é disparada por nenhum estado gravado —
// só pela chamada HTTP de aprovação, no processo do dashboard. Editar state.json à mão
// não executa SQL.
//
// Uso como CLI (<run-dir> = memory/runs/<task-id>):
//   node scripts/lib/authorization.js request <run-dir> --input=<pedido.json>
//       exit 4 = pedido registrado (PARE o nó), 2 = entrada inválida, 3 = conflito CAS.
//   node scripts/lib/authorization.js status <run-dir>
//   node scripts/lib/authorization.js template

const fs = require('fs');
const path = require('path');
const cas = require('../cas');
const stateWriter = require('../state-writer');
const dbEffect = require('./db-effect');
const prismaConfig = require('./prisma-config');

const STATUS = 'authorization-pending';
const KINDS = new Set(['db_migration']);
const RESUME_NODES = ['plan', 'implement', 'review', 'test', 'verify', 'commit'];
const ALIAS_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/i;
const ID_RE = /^AUTH-\d{3,}$/;
// Fases em que um humano ainda pode decidir (aprovar só em pending).
const DECIDABLE = new Set(['pending', 'failed', 'uncertain']);
const HANDOFF_START = '<!-- authorization-pending:inicio -->';
const HANDOFF_END = '<!-- authorization-pending:fim -->';

class AuthorizationError extends Error {
    constructor(code, message) {
        super(message);
        this.name = 'AuthorizationError';
        this.code = code;
    }
}

function nonEmpty(v) {
    return typeof v === 'string' && v.trim().length > 0;
}

// Raiz do consumidor dona do run (<raiz>/memory/runs/<task>): worktree do ticket ou
// checkout principal. O artifact é procurado nela e, se não estiver, no principal.
function consumerRootOf(runDir) {
    return path.resolve(runDir, '..', '..', '..');
}

function rootsFor(runDir) {
    return [...new Set([consumerRootOf(runDir), cas.mainRootOf(runDir)])];
}

function parseThen(then, fallbackNode) {
    const v = then == null || then === '' ? `resume:${fallbackNode}` : String(then);
    if (v === 'handback_qa') return { then: v, kind: 'handback_qa', node: null };
    const m = /^resume:([a-z_]+)$/.exec(v);
    if (m && RESUME_NODES.includes(m[1])) return { then: v, kind: 'resume', node: m[1] };
    return null;
}

function normalizeTarget(target) {
    if (typeof target === 'string') return { alias: target };
    if (target && typeof target === 'object' && !Array.isArray(target)) {
        const out = target.alias !== undefined ? { alias: target.alias } : {};
        for (const k of ['datasource', 'env']) if (nonEmpty(target[k])) out[k] = target[k].trim();
        return out;
    }
    return null;
}

function hasSecretKey(v) {
    if (!v || typeof v !== 'object') return false;
    return Object.entries(v).some(([k, x]) => /pass(word|wd)?$|secret|token/i.test(k) || hasSecretKey(x));
}

/** @returns {string[]} erros da entrada do agente */
function validateRequest(input, { node } = {}) {
    const errors = [];
    if (!input || typeof input !== 'object' || Array.isArray(input)) return ['pedido precisa ser um objeto JSON'];
    if (!KINDS.has(input.kind)) errors.push(`kind precisa ser um de: ${[...KINDS].join(', ')}`);
    if (!nonEmpty(input.summary)) errors.push('summary obrigatório (o que vai ser feito e por quê, em uma ou duas frases)');
    const hint = input.target_hint ?? input.target;
    if (hint !== undefined && hint !== null) {
        const t = normalizeTarget(hint);
        if (!t || (t.alias !== undefined && !ALIAS_RE.test(String(t.alias)))) errors.push('target_hint inválido (alias sugerido, ex.: "qa-app", e/ou { datasource, env })');
    }
    const rel = String(input.artifact || '');
    if (!rel || path.isAbsolute(rel) || rel.split(/[\\/]/).includes('..')) errors.push('artifact obrigatório: caminho do .sql relativo ao repo consumidor, sem ..');
    if (!nonEmpty(input.verify_sql)) errors.push('verify_sql obrigatório (consulta só leitura que mostra o antes/depois)');
    else errors.push(...dbEffect.checkVerifySql(input.verify_sql));
    if (!nonEmpty(input.expected)) errors.push('expected obrigatório (o que a verificação deve mostrar depois)');
    if (input.expected_contains !== undefined && !nonEmpty(input.expected_contains)) errors.push('expected_contains, se informado, precisa ser texto não vazio');
    const requestedBy = input.requested_by || node;
    if (input.requested_by !== undefined && !RESUME_NODES.includes(input.requested_by)) errors.push(`requested_by precisa ser um nó (${RESUME_NODES.join(', ')})`);
    if (!parseThen(input.then, RESUME_NODES.includes(requestedBy) ? requestedBy : 'implement')) errors.push('then precisa ser "handback_qa" ou "resume:<nó>"');
    if (hasSecretKey(input) || /password\s*=/i.test(JSON.stringify(input))) errors.push('pedido não carrega credencial — a senha fica só no ambiente do dashboard');
    return errors;
}

function nextId(state) {
    const nums = (Array.isArray(state?.authorization_history) ? state.authorization_history : [])
        .map(e => ID_RE.test(e?.id || '') ? Number(e.id.slice(5)) : 0);
    if (ID_RE.test(state?.pending_authorization?.id || '')) nums.push(Number(state.pending_authorization.id.slice(5)));
    return `AUTH-${String((nums.length ? Math.max(...nums) : 0) + 1).padStart(3, '0')}`;
}

function pushHistory(state, entry) {
    state.authorization_history = [...(Array.isArray(state.authorization_history) ? state.authorization_history : []), entry];
}

function pushEvent(state, { type, node = null, agent, detail, at }) {
    state.events = [...(Array.isArray(state.events) ? state.events : []), { ts: at, type, ...(node ? { node } : {}), agent, detail, at }];
}

function renderHandoffBlock(p) {
    return [
        HANDOFF_START,
        `## Autorização humana pendente (${p.id})`,
        '',
        `- **O quê:** ${p.summary}`,
        `- **Alvo sugerido:** ${p.target_hint ? `\`${p.target_hint.alias || '—'}\`${p.target_hint.datasource ? ` (datasource ${p.target_hint.datasource})` : ''}${p.target_hint.env ? ` · ${p.target_hint.env}` : ''}` : '—'} — quem aprova escolhe o banco na allowlist`,
        `- **Artefato:** \`${p.artifact}\` (sha256 \`${p.artifact_sha256.slice(0, 16)}…\`)`,
        `- **Verificação:** \`${p.verify_sql.replace(/\s+/g, ' ').trim()}\` — esperado: ${p.expected}`,
        `- **Depois:** ${p.then === 'handback_qa' ? 'devolver ao QA sem novo ciclo de código' : `retomar no nó ${p.then.slice(7)}`}`,
        '',
        'Decisão só pelo dashboard: **Aprovar** (o Prisma executa o SQL em transação única e confere antes/depois), **Recusar** ou **Já apliquei manualmente**. Mensagem livre não aprova.',
        HANDOFF_END,
    ].join('\n');
}

function upsertHandoffBlock(content, block) {
    const base = content || '';
    const start = base.indexOf(HANDOFF_START);
    const end = base.indexOf(HANDOFF_END);
    if (start !== -1 && end > start) return base.slice(0, start) + block + base.slice(end + HANDOFF_END.length);
    if (!block) return base;
    return `${base.replace(/\s*$/, '')}${base.trim() ? '\n\n' : ''}${block}\n`;
}

function writeHandoffBlock(runDir, block) {
    const file = path.join(runDir, 'handoff.md');
    const current = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    const next = upsertHandoffBlock(current, block);
    if (next !== current) fs.writeFileSync(file, next);
}

// ── Pedido (agente) ──────────────────────────────────────────────────────────────

/**
 * Registra o pedido pelo state-writer. Recusa se já houver outro pedido em aberto
 * (pending/executing/handback). Pedido em failed/uncertain é substituído (vai pro histórico).
 * @param {object} [expect] expectativas CAS ({ expected_state_version, execution_id? })
 * @returns {{ errors: string[], pending: object|null }}
 */
function requestAuthorization(runDir, input, { now = new Date().toISOString(), expect = null, actor = 'agent' } = {}) {
    const fresh = stateWriter.read(runDir);
    if (!fresh) return { errors: [`${runDir}: state.json ausente ou ilegível`], pending: null };
    const errors = validateRequest(input, { node: fresh.node });
    if (errors.length) return { errors, pending: null };
    const artifact = dbEffect.readArtifact({ artifact: input.artifact }, { roots: rootsFor(runDir) });
    if (!artifact.ok) return { errors: [artifact.error], pending: null };
    const problems = dbEffect.checkArtifactSql(artifact.sql);
    if (problems.length) return { errors: problems.map(p => `artifact: ${p}`), pending: null };
    if (input.artifact_sha256 && input.artifact_sha256 !== artifact.sha) {
        return { errors: [`artifact_sha256 informado não bate com o conteúdo de ${input.artifact} (${artifact.sha})`], pending: null };
    }
    const requestedBy = RESUME_NODES.includes(input.requested_by) ? input.requested_by : (RESUME_NODES.includes(fresh.node) ? fresh.node : 'implement');
    let pending = null;
    const written = stateWriter.update(runDir, draft => {
        const open = draft.pending_authorization;
        // Em aberto = ainda esperando decisão ou em execução; failed/uncertain é substituído.
        if (open && (open.phase === 'pending' || !DECIDABLE.has(open.phase))) {
            throw new AuthorizationError('AUTHORIZATION_OPEN', `já existe o pedido ${open.id} (fase ${open.phase}) aguardando decisão — um pedido por vez`);
        }
        if (open) pushHistory(draft, { id: open.id, event: 'superseded', by: requestedBy, via: actor, at: now, phase: open.phase });
        pending = {
            id: nextId(draft), kind: input.kind, summary: input.summary.trim(),
            ...(input.target_hint ?? input.target ? { target_hint: normalizeTarget(input.target_hint ?? input.target) } : {}),
            artifact: input.artifact, artifact_sha256: artifact.sha, verify_sql: input.verify_sql.trim(), expected: input.expected.trim(),
            ...(nonEmpty(input.expected_contains) ? { expected_contains: input.expected_contains } : {}),
            then: parseThen(input.then, requestedBy).then, requested_by: requestedBy, requested_at: now, phase: 'pending',
        };
        draft.pending_authorization = pending;
        draft.status = STATUS;
        draft.blocked_reason = `Autorização ${pending.id} pendente: ${pending.summary}`;
        draft.updated_at = now;
        pushHistory(draft, { id: pending.id, event: 'requested', by: requestedBy, via: actor, at: now, artifact_sha256: artifact.sha, ...(pending.target_hint?.alias ? { target_hint: pending.target_hint.alias } : {}) });
        pushEvent(draft, { type: 'authorization_requested', node: requestedBy, agent: actor === 'agent' ? 'claude' : actor, at: now,
            detail: `${pending.id} (${pending.kind}): ${pending.summary}` });
    }, { operation: 'authorization_request', actor, expect });
    if (!written) return { errors: [`${runDir}: state.json ausente ou ilegível`], pending: null };
    writeHandoffBlock(runDir, renderHandoffBlock(pending));
    return { errors: [], pending };
}

// ── Decisão (só dashboard) ───────────────────────────────────────────────────────

function lockDecision(runDir, { expectedStateVersion, operationId, authorizationId }) {
    const lock = cas.validateAndLock({
        runDir, operation: 'authorization_decision', actor: 'dashboard', operation_id: operationId,
        expected_state_version: expectedStateVersion,
    });
    if (lock.status === 'already_processed') return { lock: null, already: true };
    const s = lock.state;
    const p = s?.pending_authorization;
    const fail = (code, msg) => { lock.release(); throw new AuthorizationError(code, msg); };
    if (!p) fail('NO_PENDING', 'este run não tem pedido de autorização');
    if (authorizationId && p.id !== authorizationId) fail('AUTHORIZATION_MISMATCH', `o pedido em aberto é ${p.id}, não ${authorizationId} — atualize a tela`);
    return { lock, state: s, pending: p };
}

function humanEntry(event, p, { by, at, ...extra }) {
    return { id: p.id, event, by, via: 'dashboard', at, ...extra };
}

// ── Pedido canônico, hash e cópia congelada ──────────────────────────────────────
//
// O que o aprovador confere na tela vira um objeto canônico (ticket do task-id,
// artefato + sha256, verify_sql, expected_contains, then, alvo escolhido) e o seu
// sha256 — o request_hash. A tela mostra o hash e o devolve na aprovação; o servidor
// recalcula a partir do disco e recusa se mudou (REQUEST_CHANGED). Aprovado, o pedido
// (com o SQL) é congelado em ~/.config/prisma/approved/ e a execução usa ESSA cópia,
// passada em memória pelo dashboard — editar state.json/artefato depois não muda o que
// roda.

function ticketOfTask(taskId) {
    if (/^\d{4}-\d{2}-\d{2}-/.test(String(taskId))) return null;
    const m = /^(\d{4,6})-/.exec(String(taskId));
    return m ? Number(m[1]) : null;
}

function stableStringify(v) {
    if (v === null || typeof v !== 'object') return JSON.stringify(v ?? null);
    if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
    return `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${stableStringify(v[k])}`).join(',')}}`;
}

function canonicalRequest(taskId, p, targetAlias) {
    return {
        v: 1, task_id: taskId, ticket: ticketOfTask(taskId), authorization_id: p.id, kind: p.kind,
        artifact: p.artifact, artifact_sha256: p.artifact_sha256, verify_sql: p.verify_sql,
        expected_contains: p.expected_contains ?? null, then: p.then, target: targetAlias || null,
    };
}

function requestHashOf(canonical) {
    return dbEffect.sha256(stableStringify(canonical));
}

const CANON_KEYS = ['v', 'task_id', 'ticket', 'authorization_id', 'kind', 'artifact', 'artifact_sha256', 'verify_sql', 'expected_contains', 'then', 'target'];
function canonOfFrozen(f) {
    const out = {};
    for (const k of CANON_KEYS) out[k] = f[k] ?? null;
    return out;
}

/** Hash do pedido em aberto para o alvo `targetAlias` (o que a tela mostra). */
function describeRequest(runDir, { targetAlias = null } = {}) {
    const state = stateWriter.read(runDir);
    const p = state?.pending_authorization;
    if (!p) return null;
    const taskId = path.basename(runDir);
    const canonical = canonicalRequest(taskId, p, targetAlias);
    return { canonical, request_hash: requestHashOf(canonical) };
}

function checkTarget(targetAlias, configDir) {
    const t = dbEffect.resolveTarget(targetAlias, { configDir });
    if (!t.ok) throw new AuthorizationError(t.code, t.error);
    return t.target;
}

function freeze(runDir, p, { by, at, operationId, targetAlias, requestHash, configDir, mode }) {
    const taskId = path.basename(runDir);
    const canonical = canonicalRequest(taskId, p, targetAlias);
    const hash = requestHashOf(canonical);
    if (hash !== requestHash) {
        throw new AuthorizationError('REQUEST_CHANGED', 'o pedido mudou desde que a tela carregou (SQL, verificação, desfecho ou alvo) — atualize e confira de novo antes de aprovar');
    }
    let sql = null;
    if (mode === 'apply') {
        const a = dbEffect.readArtifact(p, { roots: rootsFor(runDir) });
        if (!a.ok) throw new AuthorizationError(a.code, a.error);
        if (a.sha !== p.artifact_sha256) throw new AuthorizationError('ARTIFACT_CHANGED', `o conteúdo de ${p.artifact} mudou depois do pedido — nada aprovado; peça um novo pedido`);
        const problems = dbEffect.checkArtifactSql(a.sql);
        if (problems.length) throw new AuthorizationError('ARTIFACT_SQL_REFUSED', problems.join('; '));
        sql = a.sql;
    }
    const vp = dbEffect.checkVerifySql(p.verify_sql);
    if (vp.length) throw new AuthorizationError('VERIFY_SQL_INVALID', vp.join('; '));
    const frozen = { ...canonical, request_hash: hash, mode, sql, summary: p.summary, expected: p.expected, approved_by: by, approved_at: at, operation_id: operationId };
    const name = `approved/${taskId}__${p.id}__${mode}__${hash.slice(0, 16)}.json`;
    try {
        prismaConfig.writeSecureJson(name, frozen, { dir: configDir });
    } catch (e) {
        throw new AuthorizationError('CONFIG_UNSAFE', `não foi possível congelar a aprovação em ~/.config/prisma: ${e.message}`);
    }
    return { frozen, file: name };
}

/**
 * Aprovação: CAS + operation_id + request_hash conferido + alvo da allowlist. Fase
 * pending → executing. Devolve a cópia congelada que execute() recebe em memória.
 */
function approve(runDir, { by, operationId, expectedStateVersion, authorizationId, requestHash, targetAlias, configDir = null, at = new Date().toISOString() }) {
    const { lock, already, state, pending: p } = lockDecision(runDir, { expectedStateVersion, operationId, authorizationId });
    if (already) return { status: 'already_processed' };
    try {
        if (state.status !== STATUS || p.phase !== 'pending') throw new AuthorizationError('NOT_APPROVABLE', `pedido ${p.id} não está aguardando aprovação (status ${state.status}, fase ${p.phase})`);
        if (!nonEmpty(targetAlias)) throw new AuthorizationError('TARGET_REQUIRED', 'escolha o banco alvo na allowlist');
        const target = checkTarget(targetAlias, configDir);
        if (!nonEmpty(requestHash)) throw new AuthorizationError('REQUEST_HASH_REQUIRED', 'a aprovação precisa do hash do pedido mostrado na tela');
        const { frozen, file } = freeze(runDir, p, { by, at, operationId, targetAlias: target.alias, requestHash, configDir, mode: 'apply' });
        p.phase = 'executing';
        p.target = { alias: target.alias };
        p.approved_by = by;
        p.approved_at = at;
        p.request_hash = frozen.request_hash;
        p.decision_operation_id = operationId;
        state.updated_at = at;
        pushHistory(state, humanEntry('approved', p, { by, at, target: target.alias, request_hash: frozen.request_hash, artifact_sha256: p.artifact_sha256, frozen: file, operation_id: operationId }));
        pushEvent(state, { type: 'authorization_approved', agent: 'human', at, detail: `${p.id} aprovado por ${by} (dashboard) para o alvo ${target.alias}` });
        return { status: 'applied', state: lock.commit(state), pending: p, frozen };
    } finally {
        lock.release();
    }
}

/** Recusa: volta para blocked com o motivo — "Responder ao agente" segue disponível. */
function reject(runDir, { by, reason, operationId, expectedStateVersion, authorizationId, at = new Date().toISOString() }) {
    const { lock, already, state, pending: p } = lockDecision(runDir, { expectedStateVersion, operationId, authorizationId });
    if (already) return { status: 'already_processed' };
    try {
        if (!DECIDABLE.has(p.phase)) throw new AuthorizationError('NOT_DECIDABLE', `pedido ${p.id} está em ${p.phase} — não dá pra recusar agora`);
        const why = nonEmpty(reason) ? reason.trim() : 'sem motivo informado';
        pushHistory(state, humanEntry('rejected', p, { by, at, reason: why, operation_id: operationId }));
        pushEvent(state, { type: 'authorization_rejected', agent: 'human', at, detail: `${p.id} recusado por ${by}: ${why}` });
        delete state.pending_authorization;
        state.status = 'blocked';
        state.blocked_reason = `Autorização ${p.id} recusada por ${by}: ${why}. Responda ao agente dizendo como seguir (ex.: outra abordagem), ou devolva ao QA.`;
        state.updated_at = at;
        const out = lock.commit(state);
        writeHandoffBlock(runDir, '');
        return { status: 'applied', state: out };
    } finally {
        lock.release();
    }
}

/** "Já apliquei manualmente": registra quem; com alvo, a verificação vem em execute(mode verify). */
function markManual(runDir, { by, note = null, operationId, expectedStateVersion, authorizationId, requestHash, targetAlias = null, configDir = null, at = new Date().toISOString() }) {
    const { lock, already, state, pending: p } = lockDecision(runDir, { expectedStateVersion, operationId, authorizationId });
    if (already) return { status: 'already_processed' };
    try {
        if (!DECIDABLE.has(p.phase)) throw new AuthorizationError('NOT_DECIDABLE', `pedido ${p.id} está em ${p.phase} — aguarde`);
        const alias = nonEmpty(targetAlias) ? checkTarget(targetAlias, configDir).alias : null;
        if (!nonEmpty(requestHash)) throw new AuthorizationError('REQUEST_HASH_REQUIRED', 'a decisão precisa do hash do pedido mostrado na tela');
        const { frozen, file } = freeze(runDir, p, { by, at, operationId, targetAlias: alias, requestHash, configDir, mode: 'verify' });
        if (alias) p.target = { alias }; else delete p.target;
        p.phase = 'executing';
        p.manual_by = by;
        p.manual_at = at;
        p.request_hash = frozen.request_hash;
        p.decision_operation_id = operationId;
        state.status = STATUS;
        state.updated_at = at;
        pushHistory(state, humanEntry('manual_applied', p, { by, at, ...(alias ? { target: alias } : {}), request_hash: frozen.request_hash, frozen: file, ...(nonEmpty(note) ? { note: note.trim() } : {}), operation_id: operationId }));
        pushEvent(state, { type: 'authorization_manual', agent: 'human', at, detail: `${p.id}: ${by} informou que aplicou manualmente` });
        return { status: 'applied', state: lock.commit(state), pending: p, frozen };
    } finally {
        lock.release();
    }
}

// Escrita de sistema depois da decisão (como cas.finishOperation): sem CAS de versão —
// a decisão já passou pelo CAS; só confere que o pedido ainda é o mesmo.
function updatePending(runDir, id, mutate, operation) {
    return stateWriter.update(runDir, s => {
        if (s.pending_authorization?.id !== id) return cas.SKIP;
        return mutate(s, s.pending_authorization);
    }, { operation, actor: 'dashboard' });
}

function lastHumanDecision(state, id) {
    return [...(state.authorization_history || [])].reverse().find(e => e.id === id && ['approved', 'manual_applied'].includes(e.event)) || null;
}

/**
 * Executa (mode apply) ou só verifica (mode verify, "Já apliquei manualmente") a cópia
 * CONGELADA na decisão (recebida em memória do dashboard) e aplica o desfecho no state.
 * Confere que ela é a que a decisão humana registrou (request_hash) e que o pedido em
 * aberto ainda é o mesmo; o conteúdo executado (SQL, verify, alvo, then) vem SÓ da cópia.
 */
async function execute(runDir, { frozen, mode = 'apply', executor = null, configDir = null, handback = null, now = () => new Date().toISOString() } = {}) {
    if (!frozen || typeof frozen !== 'object') throw new AuthorizationError('NO_FROZEN_APPROVAL', 'execução sem a cópia congelada da aprovação — nada executa');
    if (requestHashOf(canonOfFrozen(frozen)) !== frozen.request_hash || frozen.mode !== mode) throw new AuthorizationError('FROZEN_INVALID', 'cópia congelada da aprovação não confere — nada executa');
    const state = stateWriter.read(runDir);
    const p = state?.pending_authorization;
    if (!p || p.phase !== 'executing' || p.id !== frozen.authorization_id) throw new AuthorizationError('NOT_EXECUTING', 'pedido não está em execução (aprove ou informe a aplicação manual primeiro)');
    const decision = lastHumanDecision(state, p.id);
    const expected = mode === 'apply' ? 'approved' : 'manual_applied';
    if (!decision || decision.event !== expected || decision.via !== 'dashboard' || decision.request_hash !== frozen.request_hash) {
        throw new AuthorizationError('NO_HUMAN_DECISION', `pedido ${p.id} sem decisão humana "${expected}" do dashboard para esta cópia — nada executa`);
    }
    // O alvo executado é o aprovado. Mudou depois no state = nova aprovação.
    if ((p.target?.alias || null) !== (frozen.target || null)) {
        throw new AuthorizationError('TARGET_CHANGED', `o alvo de ${p.id} no state (${p.target?.alias || 'nenhum'}) não é o aprovado por ${decision.by} (${frozen.target || 'nenhum'}) — exige nova aprovação`);
    }
    const job = { id: frozen.authorization_id, artifact: frozen.artifact, artifact_sha256: frozen.artifact_sha256, sql: frozen.sql, verify_sql: frozen.verify_sql, expected_contains: frozen.expected_contains, target_alias: frozen.target };
    const verify = mode === 'apply' || !!frozen.target;
    let result = null;
    if (verify) result = await dbEffect.run({ runDir, job, executor, configDir, mode: mode === 'apply' ? 'apply' : 'verify', now });
    const at = now();
    const ok = !verify ? true : !!result?.ok;
    const summary = result ? { outcome: result.outcome, code: result.code, outputs: result.outputs, attempt_id: result.attempt_id, target: result.target?.alias || null, verify_matched: result.verify_matched } : { outcome: 'verify_not_requested' };

    if (!ok) {
        const uncertain = result.outcome === 'uncertain';
        updatePending(runDir, p.id, (s, cur) => {
            cur.phase = uncertain ? 'uncertain' : 'failed';
            cur.error = result.error;
            cur.last_result = summary;
            s.status = 'blocked';
            s.blocked_reason = `Autorização ${p.id}: ${result.error}`;
            s.updated_at = at;
            pushHistory(s, { id: p.id, event: uncertain ? 'uncertain' : 'failed', by: 'prisma', via: 'db-effect', at, ...summary, error: result.error });
            pushEvent(s, { type: 'authorization_failed', agent: 'prisma', at, detail: `${p.id}: ${result.error}` });
        }, 'authorization_result');
        return { ok: false, result, error: result.error, phase: uncertain ? 'uncertain' : 'failed' };
    }

    const then = parseThen(frozen.then, p.requested_by);
    const completed = s => {
        pushHistory(s, { id: p.id, event: mode === 'apply' ? 'applied' : 'manual_confirmed', by: 'prisma', via: 'db-effect', at, ...summary });
        pushEvent(s, { type: 'authorization_completed', agent: 'prisma', at, detail: `${p.id}: ${mode === 'apply' ? `aplicado em ${summary.target}` : 'aplicação manual registrada'}${summary.outputs ? ` (saídas em ${summary.outputs})` : ''}` });
    };
    const note = `\n\n---\n**Autorização ${p.id} concluída** (${at}): ${mode === 'apply' ? `o Prisma aplicou \`${frozen.artifact}\` em \`${frozen.target}\` após aprovação de ${frozen.approved_by}` : `${frozen.approved_by} informou que aplicou \`${frozen.artifact}\` manualmente${frozen.target ? ` (conferido em \`${frozen.target}\`)` : ''}`}` +
        `${summary.outputs ? `; saídas (sem senha) em memory/runs/${path.basename(runDir)}/${summary.outputs}/` : ''}. Esperado: ${frozen.expected}.\n---\n`;
    try { fs.appendFileSync(path.join(runDir, 'context.md'), note); } catch { /* sem context.md */ }
    writeHandoffBlock(runDir, '');

    if (then.kind === 'resume') {
        updatePending(runDir, p.id, s => {
            completed(s);
            delete s.pending_authorization;
            delete s.blocked_reason;
            s.unblocked = { at, by: 'authorization', from_status: STATUS, from_node: s.node, authorization_id: p.id };
            s.status = 'in_progress';
            s.node = then.node;
            s.updated_at = at;
        }, 'authorization_resume');
        try { fs.rmSync(path.join(runDir, '.watcher-notified.json'), { force: true }); } catch { /* best-effort */ }
        return { ok: true, result, then: frozen.then, node: then.node };
    }

    // handback_qa: fase handback enquanto o Redmine não confirma (crash aqui deixa o botão
    // "Devolver ao QA" disponível no dashboard).
    updatePending(runDir, p.id, (s, cur) => {
        completed(s);
        cur.phase = 'handback';
        cur.last_result = summary;
        s.updated_at = at;
    }, 'authorization_handback');
    if (typeof handback !== 'function') return { ok: true, result, then: frozen.then, handback: null };
    const hb = await handback(runDir, {
        authorization: { id: p.id, summary: frozen.summary, artifact: frozen.artifact, expected: frozen.expected, target: frozen.target ? { alias: frozen.target } : null, approved_by: mode === 'apply' ? frozen.approved_by : null, manual_by: mode === 'verify' ? frozen.approved_by : null, approved_at: frozen.approved_at, last_result: summary },
        ticket: frozen.ticket, at, operationId: `handback:${p.id}`,
    });
    return { ok: !!hb?.ok, result, then: frozen.then, handback: hb, error: hb?.ok ? null : hb?.error };
}

function template() {
    return {
        kind: 'db_migration',
        summary: 'Aplicar a check constraint com SERVICO_ADICIONAL no banco do QA (a Recusa QA é do banco, não do código).',
        target_hint: { alias: 'qa-app', datasource: 'app', env: 'qa' },
        artifact: 'docs/migrations/<arquivo>.sql',
        verify_sql: "SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = '<constraint>'",
        expected: 'a definição lista SERVICO_ADICIONAL',
        expected_contains: 'SERVICO_ADICIONAL',
        then: 'handback_qa',
    };
}

module.exports = {
    STATUS, KINDS, RESUME_NODES, HANDOFF_START, HANDOFF_END, AuthorizationError,
    validateRequest, requestAuthorization, approve, reject, markManual, execute, describeRequest, canonicalRequest, requestHashOf, ticketOfTask,
    parseThen, rootsFor, consumerRootOf, renderHandoffBlock, upsertHandoffBlock, template,
};

if (require.main === module) {
    const args = process.argv.slice(2);
    const flag = name => { const a = args.find(x => x === `--${name}` || x.startsWith(`--${name}=`)); return a === undefined ? undefined : (a.includes('=') ? a.split('=').slice(1).join('=') : true); };
    const [cmd, target] = args.filter(a => !a.startsWith('--'));
    const usage = msg => {
        if (msg) console.error(`[authorization] ${msg}`);
        console.error('Uso: node scripts/lib/authorization.js request <run-dir> --input=<pedido.json> | status <run-dir> | template\n' +
            'Aprovar, recusar e "já apliquei manualmente" são só pelo dashboard (decisão humana).');
        process.exit(2);
    };
    if (cmd === 'template') { console.log(JSON.stringify(template(), null, 2)); process.exit(0); }
    if (['approve', 'reject', 'manual', 'execute'].includes(cmd)) usage(`"${cmd}" não existe na CLI: a decisão é humana, pelos botões do dashboard.`);
    if (!cmd || !target || !fs.existsSync(path.join(target, 'state.json'))) usage();
    if (cmd === 'status') {
        const s = stateWriter.read(target) || {};
        console.log(JSON.stringify({ status: s.status, pending_authorization: s.pending_authorization || null, authorization_history: s.authorization_history || [] }, null, 2));
        process.exit(0);
    }
    if (cmd === 'request') {
        const file = flag('input');
        if (typeof file !== 'string') usage('request exige --input=<pedido.json>');
        let input;
        try { input = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { usage(`${file}: JSON ausente ou inválido`); }
        const fresh = stateWriter.read(target);
        const expect = {
            expected_state_version: flag('expected-version') !== undefined ? Number(flag('expected-version')) : cas.effectiveVersion(fresh),
            ...((flag('execution-id') || process.env.STATE_EXECUTION_ID) ? { execution_id: flag('execution-id') || process.env.STATE_EXECUTION_ID } : {}),
        };
        let out;
        try {
            out = requestAuthorization(target, input, { expect });
        } catch (e) {
            if (cas.isConflict(e)) { console.error(JSON.stringify({ code: e.code, error: e.message, conflicts: e.conflicts })); process.exit(3); }
            if (e instanceof AuthorizationError) usage(e.message);
            throw e;
        }
        if (out.errors.length) {
            console.error('[authorization] pedido inválido — nada gravado:');
            for (const e of out.errors) console.error(`- ${e}`);
            process.exit(2);
        }
        console.error(`[authorization] ${out.pending.id} registrado (status="${STATUS}", sha256 ${out.pending.artifact_sha256.slice(0, 12)}…). PARE o nó aqui: um humano decide no dashboard.`);
        process.exit(4);
    }
    usage();
}
