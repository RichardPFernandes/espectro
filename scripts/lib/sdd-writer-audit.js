'use strict';
// Writer SDD (PRI-266) — W-A: auditoria pós-integração e estado de auditoria derivado
// (contrato PRI-231 r4 C-16, C-17, C-22, C-24; EM §3 prop. 6, herdada da PRI-230).
// Estado por capability recalculado do histórico de registry_branch + âncoras + status
// do W-C (HP-6). Nenhum arquivo, flag ou registro de "capability UNKNOWN" é gravado:
// o W-A só cria âncoras (tags, HP-4) e remove marcadores órfãos com desfecho certo.
// Precedência (R4-N1): VIOLATION > UNKNOWN > UNVERIFIABLE > OK. UNKNOWN/VIOLATION são
// permanentes (D-231-9 A); UNVERIFIABLE é transitório e recalcula na próxima execução.

const cmd = require('./sdd-writer-command');
const { treeReader, UnverifiableError } = require('./sdd-writer-git');
const { parseLog, splitAppend, deriveState, absenceVerdict, worst } = require('./sdd-writer-log');
const { decide, readAdmittedProject } = require('./sdd-writer-decide');
const { capabilitySlugs, projectCapabilities, ambiguousAliases, generateCatalog } = require('./sdd-writer-catalog');

const DEFAULT_IDENTITIES = Object.freeze({ wc: 'sdd-writer-check', wa: 'sdd-writer-audit' });

/** Avalia um commit da cadeia de primeiro pai que altera a capability (modo histórico). */
async function evalCommit(args) {
    try {
        return await evalCommitInner(args);
    } catch (e) {
        // Mesma política de check/decide (O-06): obtenção ou defeito do writer → transitório;
        // conteúdo inválido (ex.: não é arquivo regular) → append não validado.
        if (e && e.code === 'NOT_REGULAR_FILE') return { state: 'UNKNOWN', reason: 'NOT_REGULAR_FILE' };
        if (e instanceof UnverifiableError) return { state: 'UNVERIFIABLE', reason: e.reason };
        return { state: 'UNVERIFIABLE', reason: `INTERNAL:${e && e.message}` };
    }
}

async function evalCommitInner({ git, host, c, parent, slug, project, decisionPort, identities, tipTree, testOnly }) {
    const tree = git.treeOf(c);
    // Bytes antes do status: remoção ou reescrita do log é VIOLATION mesmo sem W-C (precedência R4-N1).
    const baseId = parent || git.emptyTree();
    const oldBytes = git.readBlob(baseId, cmd.logPath(slug));
    const newBytes = git.readBlob(c, cmd.logPath(slug));
    const sp = splitAppend(oldBytes, newBytes);
    // Log antes existente e agora removido ou com bytes diferentes que não são append → VIOLATION.
    // Bytes idênticos (commit que só mexe em outro arquivo) seguem para o status → UNKNOWN (R2-02).
    const logChanged = oldBytes !== null && (newBytes === null || !newBytes.equals(oldBytes));
    if (!sp.ok && sp.code === 'VIOLATION' && logChanged) return { state: 'VIOLATION', reason: sp.reason };
    let status;
    try {
        status = await host.getStatus(tree, parent);
    } catch {
        return { state: 'UNVERIFIABLE', reason: 'STATUS_UNOBTAINABLE' };
    }
    // C-16 (a) / C-22: exige W-C PASS para (árvore do commit, primeiro pai), da identidade confiável.
    // @guard WC-STATUS
    if (!status || status.state !== 'PASS' || status.identity !== identities.wc) return { state: 'UNKNOWN', reason: 'NO_WC_PASS' };
    // @end WC-STATUS
    if (!sp.ok) return { state: 'UNKNOWN', reason: sp.reason };
    const old = oldBytes === null ? { status: 'OK', entries: [] } : parseLog(oldBytes);
    const derived = deriveState(old.entries || [], { editResolver: testOnly.editResolver || null });
    if (!derived.ok) return { state: 'UNKNOWN', reason: 'OLD_STATE' };
    const resultTree = treeReader(git, c);
    // H3 R2-02: identidade/política da validation_basis daquela operação, nunca latest.
    // @guard HIST-SOURCES
    const sourcesTree = resultTree;
    // @else
    // const sourcesTree = tipTree;
    // @end HIST-SOURCES
    void tipTree;
    const r = await decide({
        mode: 'historical', project, slug, baseTree: treeReader(git, baseId), resultTree, sourcesTree,
        entry: sp.entry, oldEntries: old.entries || [], oldState: derived.state, decisionPort, atCommit: c,
        [cmd.TEST_HOOKS]: testOnly,
    });
    if (!r.ok) return { state: r.code === 'UNVERIFIABLE' ? 'UNVERIFIABLE' : 'UNKNOWN', reason: `${r.code}:${r.reason}` };
    return { state: 'OK', generation: sp.entry.result_generation };
}

/**
 * Estado de auditoria de uma capability no commit `tip`.
 * mode 'full' (W-A periódico): desde a gênese. 'incremental' (W-C V-0, W-P, W-R): desde a maior
 * âncora válida (criada pelo W-A, ancestral do tip e com o próprio append validado).
 * → { state, reasons[], validated: [{commit, generation, cumulativeOk}] }
 */
async function auditCapability({ git, host, tip, project, slug, decisionPort, mode = 'full', identities = DEFAULT_IDENTITIES, [cmd.TEST_HOOKS]: testOnly = {} }) {
    const reasons = [];
    let state = 'OK';
    const mark = (s, why) => { state = worst(state, s); if (s !== 'OK') reasons.push(`${s}:${why}`); };
    if (!tip) return { state, reasons, validated: [] };
    const tipTree = treeReader(git, tip);

    let anchors = [];
    try {
        anchors = await host.listAnchors(project, slug);
    } catch {
        mark('UNVERIFIABLE', 'ANCHORS_UNOBTAINABLE');
    }
    // HP-4 (R3-N2): só conta a âncora cujo criador verificável é o W-A; tag leve/forjada não conta.
    const waAnchors = anchors.filter(a => a.creator === identities.wa).sort((a, b) => a.gen - b.gen);

    // C-16: em cada execução, por âncora: ancestralidade, log presente, prefixo de bytes.
    const tipLog = git.readBlob(tip, cmd.logPath(slug));
    for (const a of waAnchors) {
        // @guard ANCHOR-ANCESTRY
        if (!git.resolveCommit(a.commit) || !git.isAncestor(a.commit, tip)) { mark('VIOLATION', `ANCHOR_NOT_ANCESTOR:${a.name}`); continue; }
        // @end ANCHOR-ANCESTRY
        if (tipLog === null) { mark('VIOLATION', `LOG_ABSENT_WITH_ANCHOR:${a.name}`); continue; }
        const aLog = git.readBlob(a.commit, cmd.logPath(slug));
        // @guard ANCHOR-PREFIX
        if (aLog === null || !tipLog.subarray(0, aLog.length - 1).equals(aLog.subarray(0, aLog.length - 1))) mark('VIOLATION', `ANCHOR_PREFIX:${a.name}`);
        // @end ANCHOR-PREFIX
    }
    // C-17: ausência só é geração 0 sem âncora e sem histórico.
    if (tipLog === null) {
        const v = absenceVerdict({ hasAnchors: waAnchors.length > 0, everInHistory: git.everInHistory(tip, cmd.logPath(slug)) });
        if (v !== 'OK') mark('VIOLATION', 'LOG_ABSENT_WITH_HISTORY');
    }

    const chain = git.firstParentChain(tip);
    const parentOf = c => git.firstParent(c);
    const touches = (c) => {
        const p = parentOf(c);
        return git.diff(p || git.emptyTree(), c).some(d => d.path.startsWith(`${cmd.capDir(slug)}/`));
    };
    let start = 0;
    const validated = [];
    if (mode === 'incremental') {
        for (const a of [...waAnchors].reverse()) {
            const idx = chain.indexOf(a.commit);
            if (idx < 0) continue;
            // Âncora válida = o próprio append passa no modo histórico (C-22 R2-03).
            // @guard ANCHOR-SELF-EVAL
            const ev = await evalCommit({ git, host, c: a.commit, parent: parentOf(a.commit), slug, project, decisionPort, identities, tipTree, testOnly });
            // @else
            // const ev = { state: 'OK' };
            // @end ANCHOR-SELF-EVAL
            if (ev.state === 'OK') { start = idx + 1; break; }
        }
    }
    let cumulativeOk = true;
    for (let i = start; i < chain.length; i++) {
        const c = chain[i];
        if (!touches(c)) continue;
        const ev = await evalCommit({ git, host, c, parent: parentOf(c), slug, project, decisionPort, identities, tipTree, testOnly });
        if (ev.state === 'OK') {
            validated.push({ commit: c, generation: ev.generation, cumulativeOk });
        } else {
            cumulativeOk = false;
            mark(ev.state, `${c.slice(0, 12)}:${ev.reason}`);
        }
    }
    return { state, reasons, validated };
}

/** Slugs já vistos no histórico (inclui capability apagada). */
function historicalSlugs(git, tip) {
    const out = git.run(['log', '--format=', '--name-only', tip, '--', cmd.CAPABILITIES_DIR]).stdout.toString('utf8');
    const s = new Set();
    for (const line of out.split('\n')) {
        const m = /^docs\/sdd\/capabilities\/([^/]+)\//.exec(line.trim());
        if (m) s.add(m[1]);
    }
    return s;
}

const DEFINITIVE_MARKER_OUTCOME = new Set(['MERGED_APPLIED', 'CLOSED']);

/**
 * W-A completo: audita todas as capabilities desde a gênese, cria âncoras g<N> só para
 * integração aceita e com estado cumulativo OK, remove marcador órfão com desfecho certo.
 * Devolve relatório (notificação, nunca fonte).
 */
async function runAudit({ git, host, registryBranch, project, decisionPort, identities = DEFAULT_IDENTITIES, [cmd.TEST_HOOKS]: testOnly = {} }) {
    const tip = await host.getRef(`refs/heads/${registryBranch}`);
    const report = { tip, capabilities: {}, anchorsCreated: [], markersRemoved: [], markersKept: [], markersUncertain: [], anomalies: [], ambiguousAliases: [], catalog: null };
    if (!tip) return report;
    // O-13 / C-04: registry_branch e projeto vêm da E-01 (sem default); valor divergente do chamador → recusa.
    const admitted = readAdmittedProject(treeReader(git, tip));
    if (!admitted.ok || admitted.value.registry_branch !== registryBranch || admitted.value.project !== project) {
        throw new Error(`runAudit: registry_branch/projeto não conferem com a representação admitida (${admitted.ok ? 'divergente' : admitted.reason})`);
    }
    const slugs = new Set([...capabilitySlugs(treeReader(git, tip)), ...historicalSlugs(git, tip)]);
    for (const slug of [...slugs].sort()) {
        const a = await auditCapability({ git, host, tip, project, slug, decisionPort, mode: 'full', identities, [cmd.TEST_HOOKS]: testOnly });
        report.capabilities[slug] = { state: a.state, reasons: a.reasons };
        const existing = new Set((await host.listAnchors(project, slug)).map(x => x.name));
        for (const v of a.validated) {
            if (!v.cumulativeOk) continue;
            const name = cmd.anchorTag(project, slug, v.generation);
            if (existing.has(name)) {
                // O-18: tag pré-existente com o nome da âncora (leve ou forjada) é anomalia reportada.
                const t = (await host.listAnchors(project, slug)).find(x => x.name === name);
                if (!t || t.creator !== identities.wa || t.commit !== v.commit) report.anomalies.push(`ANCHOR_NAME_TAKEN:${name}`);
                continue;
            }
            if (await host.createTag(name, v.commit, identities.wa)) report.anchorsCreated.push(name);
        }
    }
    // C-10: ref órfã com desfecho certo é removida; sem desfecho, mantida (ninguém toma posse por idade).
    const tipTree = treeReader(git, tip);
    for (const m of await host.listMarkers(project)) {
        const slug = m.name.split('/').pop();
        const opId = (/^op_id: (.+)$/m.exec(git.commitMessage(m.oid)) || [])[1];
        const parsed = parseLog(tipTree.read(cmd.logPath(slug)));
        const inLog = parsed.status === 'OK' && parsed.entries.some(e => e.op_id === opId);
        const prs = (await host.prsByBranch(cmd.markerBranch(project, slug))).filter(p => p.head === m.oid);
        // Desfecho certo: op_id no log, ou todos os PRs do marcador fechados sem merge.
        // PR integrado sem op_id no log é INCERTO (C-21 m-06): a ref fica e o W-A acusa (O-05).
        const merged = prs.some(p => p.state === 'MERGED');
        const outcome = inLog ? 'MERGED_APPLIED'
            : merged ? 'MERGED_WITHOUT_OP_ID'
                : (prs.length && prs.every(p => p.state === 'CLOSED') ? 'CLOSED' : 'OPEN_OR_NONE');
        if (outcome === 'MERGED_WITHOUT_OP_ID') {
            report.markersUncertain.push(m.name);
        } else if (DEFINITIVE_MARKER_OUTCOME.has(outcome)) {
            await host.deleteRef(m.name, identities.wa);
            report.markersRemoved.push(m.name);
        } else {
            report.markersKept.push(m.name);
        }
    }
    report.ambiguousAliases = ambiguousAliases(projectCapabilities(tipTree, { editResolver: testOnly.editResolver || null }));
    // O-10: catálogo em registry_branch tem de ser a projeção dos logs; divergência é acusada.
    const expectCat = generateCatalog(tipTree, { editResolver: testOnly.editResolver || null });
    const nowCat = tipTree.read(cmd.CATALOG_PATH);
    report.catalog = (expectCat === null ? nowCat === null : (nowCat !== null && nowCat.equals(expectCat))) ? 'OK' : 'DIVERGENT';
    return report;
}

module.exports = { auditCapability, runAudit, evalCommit, DEFAULT_IDENTITIES };
