'use strict';
// Writer SDD (PRI-266) — W-P: preparação e proposta, SEM autoridade (contrato PRI-231 r4
// C-01, C-10, C-12 nota, C-21; EM §3 prop. 7, herdada da PRI-230).
// Antes de qualquer elegibilidade, faz o caminho R interno (busca do op_id em
// registry_branch). Só sem op_id roda N1 e abre o PR. Marcador em voo
// `refs/heads/sdd-op/<project>/<slug>` criado só se ausente (HP-3); ninguém toma posse por
// idade. Resultado incerto → UNCERTAIN, nada é repetido (at-most-once; AGENTS.md item 5).
// Monta commits por plumbing Git: nenhuma working tree é lida ou escrita (C-03, C-15).
// Ao operador: só o próximo passo de controle; `result` = NOT_AVAILABLE (U-002-4 aberta).

const cmd = require('./sdd-writer-command');
const { treeReader, UnverifiableError } = require('./sdd-writer-git');
const { parseLog, deriveState, applyCommand, appendBytes } = require('./sdd-writer-log');
const { decide, readAdmittedProject } = require('./sdd-writer-decide');
const { recognize } = require('./sdd-writer-replay');
const { generateCatalog } = require('./sdd-writer-catalog');
const { auditCapability, DEFAULT_IDENTITIES } = require('./sdd-writer-audit');

// C-21 [r3] N-14: só FAIL semântico e definitivo fecha o PR. UNVERIFIABLE → roda de novo.
const DEFINITIVE_FAILS = new Set(['SCOPE', 'LOG_BYTES', 'VIOLATION', 'COMMAND', 'DUPLICATE_OP', 'DECISION', 'P1',
    'E01', 'E02', 'U0028', 'STALE', 'DERIVED', 'ALIAS', 'IDENTITY', 'UNKNOWN']);

const out = (state, control, extra = {}) => ({ state, control, result: 'NOT_AVAILABLE', ...extra });

function markerInfo(git, sha) {
    const msg = git.commitMessage(sha);
    return {
        opId: (/^op_id: (.+)$/m.exec(msg) || [])[1] || null,
        commandSha256: (/^command_sha256: (.+)$/m.exec(msg) || [])[1] || null,
        author: git.commitAuthor(sha),
    };
}

/** Passo 1 da C-21: fetch + busca do op_id (caminho R interno, com C-17/C-22). */
async function locate(a) {
    const { git, host, registryBranch, project, slug, opId, commandSha256, decisionPort, identities } = a;
    const testOnly = a[cmd.TEST_HOOKS] || {};
    const tip = await host.getRef(`refs/heads/${registryBranch}`);
    if (!tip) return { verdict: out('UNCERTAIN', 'UNCERTAIN', { reason: 'REGISTRY_BRANCH_UNREADABLE' }) };
    // O-13 / C-04: registry_branch e projeto conferidos com a representação admitida (E-01), sem default.
    const admitted = readAdmittedProject(treeReader(git, tip));
    if (!admitted.ok || admitted.value.registry_branch !== registryBranch || admitted.value.project !== project) {
        return { verdict: out('REFUSED', 'NONE', { code: 'E01', reason: 'REGISTRY_CONFIG_MISMATCH' }) };
    }
    let audit;
    try {
        audit = await auditCapability({ git, host, tip, project, slug, decisionPort, mode: 'incremental', identities, [cmd.TEST_HOOKS]: testOnly });
    } catch {
        audit = { state: 'UNVERIFIABLE' };
    }
    const rec = recognize({ tree: treeReader(git, tip), slug, opId, commandSha256, auditState: audit.state });
    if (rec.kind === 'REPLAY') return { tip, audit, verdict: out('APPLIED', 'NONE') };
    if (rec.kind === 'CONFLICT') return { tip, audit, verdict: out('CONFLICT', 'NEW_COMMAND_REQUIRED') };
    if (rec.kind === 'BLOCKED') return { tip, audit, verdict: out('BLOCKED', 'NONE', { audit: rec.state }) };
    if (rec.kind === 'UNVERIFIABLE') return { tip, audit, verdict: out('UNCERTAIN', 'UNCERTAIN', { reason: 'AUDIT_UNVERIFIABLE' }) };
    return { tip, audit, verdict: null };
}

async function releaseIfOurs(a, markerSha) {
    const { git, host, project, slug, opId } = a;
    if (!markerSha) return;
    const info = markerInfo(git, markerSha);
    // O-11: o marcador é "nosso" só com o mesmo op_id E o mesmo command_sha256 (C-20).
    if (info.opId === opId && info.commandSha256 === a.commandSha256) await host.deleteRef(cmd.markerRef(project, slug));
}

/** Monta a árvore candidata (N1) sobre `tip`. → {tree, entry} | {refused} */
async function buildCandidate(a, tip, audit) {
    const { git, project, slug, command, opId, decisionRef, actor, at, specBytes, decisionPort } = a;
    const testOnly = a[cmd.TEST_HOOKS] || {};
    const base = treeReader(git, tip);
    const oldBytes = base.read(cmd.logPath(slug));
    const old = oldBytes === null ? { status: 'OK', entries: [] } : parseLog(oldBytes);
    if (old.status !== 'OK') return { refused: { code: 'UNKNOWN', reason: 'OLD_LOG' } };
    const derived = deriveState(old.entries, { editResolver: testOnly.editResolver || null });
    if (!derived.ok) return { refused: { code: 'UNKNOWN', reason: 'OLD_STATE' } };
    const applied = applyCommand(derived.state, command, { editResolver: testOnly.editResolver || null, strictEdit: true });
    if (!applied.ok) return { refused: { code: applied.code, reason: applied.reason } };
    const entry = {
        op_id: opId, command, command_sha256: cmd.commandSha256(command), decision_ref: decisionRef,
        actor, at, result_generation: applied.next.generation, result: applied.result,
    };
    const changes = { [cmd.logPath(slug)]: appendBytes(oldBytes, entry) };
    if (command.op === 'INC') {
        if (!specBytes || cmd.sha256hex(specBytes) !== command.approved_payload.target_spec_sha256) {
            return { refused: { code: 'COMMAND', reason: 'SPEC_BYTES_NOT_TARGET' } };
        }
        changes[cmd.specPath(slug)] = specBytes;
        changes[cmd.versionPath(slug, command.approved_payload.target_spec_sha256)] = specBytes;
    }
    const tree0 = git.buildTree(tip, changes);
    const cat = generateCatalog(treeReader(git, tree0), { editResolver: testOnly.editResolver || null });
    const tree = git.buildTree(tree0, { [cmd.CATALOG_PATH]: cat });
    // N1: pré-checagem obrigatória antes de adquirir a posse (RRC-SDD-002 §4.2).
    const r = await decide({
        mode: 'new', project, slug, baseTree: base, resultTree: treeReader(git, tree), entry,
        oldEntries: old.entries, oldState: derived.state, auditState: audit.state, decisionPort, atCommit: tip,
        [cmd.TEST_HOOKS]: testOnly,
    });
    if (!r.ok) return { refused: { code: r.code, reason: r.reason } };
    return { tree, entry };
}

/** C-21 passo 2: existe ref de voo para a capability. */
async function resumeFromMarker(a, markerSha, depth) {
    const { git, host, project, slug, opId, actor, command, registryBranch } = a;
    const info = markerInfo(git, markerSha);
    const branch = cmd.markerBranch(project, slug);
    const prs = (await host.prsByBranch(branch)).filter(p => p.head === markerSha);
    // Marcador de OUTRA operação: este W-P não fecha PR alheio nem toma posse (C-10);
    // a liberação é do W-P dono ou do W-A, quando o desfecho for certo.
    if (info.opId !== opId) {
        const otherOpen = prs.find(p => p.state === 'OPEN');
        return out('WAITING', 'WAIT_OTHER_OPERATION', otherOpen ? { pr: otherOpen.number } : {});
    }
    // O-11: mesmo op_id com outro conteúdo é conflito, nunca "a mesma operação".
    if (info.commandSha256 !== a.commandSha256) return out('CONFLICT', 'NEW_COMMAND_REQUIRED', { reason: 'MARKER_OP_ID_OTHER_CONTENT' });
    const merged = prs.find(p => p.state === 'MERGED');
    if (merged) {
        // m-06: corrida entre os passos 1 e 2 → novo fetch e nova busca.
        const again = await locate(a);
        if (again.verdict && again.verdict.state === 'APPLIED') { await releaseIfOurs(a, markerSha); return again.verdict; }
        return out('UNCERTAIN', 'UNCERTAIN', { reason: 'MERGED_WITHOUT_OP_ID' });
    }
    const open = prs.find(p => p.state === 'OPEN');
    if (open) {
        const tree = git.treeOf(open.head);
        const st = await host.getStatus(tree, git.firstParent(open.head));
        // @guard R3-01
        const definitive = st && st.state === 'FAIL' && DEFINITIVE_FAILS.has(st.code);
        // @else
        // const definitive = st && st.state === 'FAIL';
        // @end R3-01
        // C-21: PR aberto ou na fila → aguardar. PR com base atrasada (HP-1 estrito) também aguarda:
        // resíduo de liveness declarado (R2-01), a atualizar pelo host/operador ou pela reconciliação.
        if (definitive) {
            await host.closePR(open.number);
            open.state = 'CLOSED';
        } else {
            if (st && st.state === 'FAIL') await host.rerunCheck(open.number); // UNVERIFIABLE ou infra: nova execução
            return out('PR_OPEN', 'WAIT', { pr: open.number });
        }
    }
    const closed = prs.find(p => p.state === 'CLOSED');
    if (closed) {
        // CLOSED_UNMERGED: Decision não consumida (C-14). Mesma geração → mesmo comando; senão STALE.
        const tip = await host.getRef(`refs/heads/${registryBranch}`);
        const parsed = parseLog(treeReader(git, tip).read(cmd.logPath(slug)));
        const gen = parsed.status === 'OK' ? parsed.entries.length : (parsed.status === 'ABSENT' ? 0 : -1);
        await host.deleteRef(cmd.markerRef(project, slug));
        if (gen === command.expected_generation && depth === 0) {
            const again = await prepare({ ...a }, depth + 1);
            return { ...again, previous: 'CLOSED_UNMERGED' };
        }
        return out('STALE', 'NEW_COMMAND_REQUIRED', { previous: 'CLOSED_UNMERGED' });
    }
    // Ref de voo sem PR (crash entre o push da ref e a abertura do PR).
    if (info.author === actor) {
        const pr = await host.openPR({ branch, author: actor, head: markerSha });
        return out('PR_OPEN', 'WAIT', { pr: pr.number });
    }
    return out('WAITING', 'WAIT_OTHER_AUTHOR', { reason: 'operação em voo de outro autor' });
}

/**
 * Prepara (ou retoma) a operação. Nunca integra nada.
 * @returns {Promise<{state, control, result:'NOT_AVAILABLE', ...}>}
 */
async function prepare(a, depth = 0) {
    const args = { identities: DEFAULT_IDENTITIES, ...a, commandSha256: cmd.commandSha256(a.command) };
    try {
        const { git, host, project, slug, opId, actor, preparerId, at } = args;
        // O-17 / HP-3 N-07: preparador e instante identificam o commit do marcador.
        if (typeof preparerId !== 'string' || !cmd.RE_ID.test(preparerId) || typeof at !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(at)) {
            return out('REFUSED', 'NONE', { code: 'COMMAND', reason: 'PREPARER_OR_AT' });
        }
        // C-21 passo 1 / C-12 nota: caminho R interno antes de qualquer elegibilidade.
        // @guard C21-SEARCH
        const loc = await locate(args);
        if (loc.verdict) {
            if (loc.verdict.state === 'APPLIED') await releaseIfOurs(args, await host.getRef(cmd.markerRef(project, slug)));
            return loc.verdict;
        }
        // @else
        // const loc = { tip: await host.getRef(`refs/heads/${args.registryBranch}`), audit: { state: 'OK' } };
        // @end C21-SEARCH
        const marker = await host.getRef(cmd.markerRef(project, slug));
        if (marker) return await resumeFromMarker(args, marker, depth);
        const cand = await buildCandidate(args, loc.tip, loc.audit);
        if (cand.refused) return out('REFUSED', cand.refused.code === 'STALE' ? 'NEW_COMMAND_REQUIRED' : 'NONE', { code: cand.refused.code, reason: cand.refused.reason });
        // HP-3 [r3] N-07: preparador + at no commit → dois W-P nunca produzem o mesmo SHA.
        const message = `sdd-op ${opId}\n\nop_id: ${opId}\ncommand_sha256: ${args.commandSha256}\npreparer: ${preparerId}\nat: ${at}\n`;
        // O-08: datas fixadas por `at` → commit-tree determinístico (repetição idempotente).
        const commit = git.commitTree(cand.tree, [loc.tip], message, actor, { date: at });
        const acquired = await host.createRefIfAbsent(cmd.markerRef(project, slug), commit);
        if (!acquired) {
            const existing = await host.getRef(cmd.markerRef(project, slug));
            return await resumeFromMarker(args, existing, depth);
        }
        const pr = await host.openPR({ branch: cmd.markerBranch(project, slug), author: actor, head: commit });
        return out('PR_OPEN', 'WAIT', { pr: pr.number, commit });
    } catch (e) {
        // C-21 passo 3: host ilegível ou ambíguo → UNCERTAIN, sem repetição às cegas.
        if (e instanceof UnverifiableError) return out('UNCERTAIN', 'UNCERTAIN', { reason: e.reason });
        throw e;
    }
}

/**
 * C-21 [r3] N-06 / [r4] R3-N4: remoção humana explícita da ref de voo de outro autor, depois
 * de conferir que não há PR para a ref e que o op_id não está no log. Registro operacional
 * (comentário no host), sem autoridade e sem Decision.
 */
async function humanReleaseMarker({ git, host, registryBranch, project, slug, operator }) {
    const marker = await host.getRef(cmd.markerRef(project, slug));
    if (!marker) return { released: false, reason: 'NO_MARKER' };
    const info = markerInfo(git, marker);
    const prs = (await host.prsByBranch(cmd.markerBranch(project, slug))).filter(p => p.head === marker && p.state !== 'CLOSED');
    if (prs.length) return { released: false, reason: 'PR_EXISTS' };
    const tip = await host.getRef(`refs/heads/${registryBranch}`);
    const parsed = parseLog(treeReader(git, tip).read(cmd.logPath(slug)));
    // O-12: a ausência do op_id tem de ser CONFERIDA; log ilegível ou marcador sem op_id → recusa.
    if (!info.opId) return { released: false, reason: 'MARKER_WITHOUT_OP_ID' };
    if (parsed.status !== 'OK' && parsed.status !== 'ABSENT') return { released: false, reason: 'LOG_UNREADABLE' };
    if (parsed.status === 'OK' && parsed.entries.some(e => e.op_id === info.opId)) return { released: false, reason: 'OP_ID_IN_LOG' };
    await host.comment(`sdd-op: ref ${cmd.markerRef(project, slug)} (op_id ${info.opId}, autor ${info.author}) removida por ação humana de ${operator}`);
    await host.deleteRef(cmd.markerRef(project, slug));
    return { released: true };
}

module.exports = { prepare, humanReleaseMarker, DEFINITIVE_FAILS, markerInfo };
