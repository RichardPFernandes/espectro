'use strict';
// Writer SDD (PRI-266) — W-C: checagem de integração, o ÚNICO ponto de commit
// (contrato PRI-231 r4 C-01, C-02, C-04, C-11, C-12, C-13; EM §3 props. 1–4).
// Roda no CI do host sobre a árvore exata do novo tip, com código carregado de ref
// confiável (HP-7: o host materializa ESTE módulo da base, nunca do PR). Saída: só o status.
// Qualquer ilegibilidade → FAIL, nunca PASS (AGENTS.md item 7).
// Ganchos só de teste chegam pela chave Symbol cmd.TEST_HOOKS (D-266-3 A; O-07).

const cmd = require('./sdd-writer-command');
const { treeReader, UnverifiableError } = require('./sdd-writer-git');
const { parseLog, splitAppend, deriveState } = require('./sdd-writer-log');
const { decide, readAdmittedProject } = require('./sdd-writer-decide');
const { auditCapability, DEFAULT_IDENTITIES } = require('./sdd-writer-audit');

const PASS = extra => ({ status: 'PASS', ...extra });
const FAIL = (code, reason) => ({ status: 'FAIL', code, reason });

/**
 * @param {object} a
 * @param {object} a.git
 * @param {object} a.host   HP-6 (status, âncoras)
 * @param {string} a.baseSha   commit de registry_branch sobre o qual a árvore foi construída
 * @param {string} a.resultTree   tree id da árvore candidata
 * @param {object} a.pr   metadados do host (HP-8): {target, author, branch, number, verified, batchProtected}
 * @param {boolean} [a.hp3=true]   false = fallback D-231-2 B (sem criação só-se-ausente)
 */
async function checkIntegration(a) {
    try {
        return await checkInner(a);
    } catch (e) {
        if (e instanceof UnverifiableError) return FAIL('UNVERIFIABLE', e.reason);
        // O-06: conteúdo inválido (ex.: log.json trocado por symlink/diretório) é definitivo.
        if (e && e.code === 'NOT_REGULAR_FILE') return FAIL('LOG_BYTES', 'NOT_REGULAR_FILE');
        return FAIL('UNVERIFIABLE', `INTERNAL:${e && (e.code || e.message)}`);
    }
}

async function checkInner({ git, host, baseSha, resultTree, pr, decisionPort, hp3 = true, identities = DEFAULT_IDENTITIES, [cmd.TEST_HOOKS]: testOnly = {} }) {
    const base = treeReader(git, baseSha);
    const result = treeReader(git, resultTree);
    const changes = git.diff(baseSha, resultTree);
    const touched = changes.filter(c => cmd.protectedSlugOf(c.path));
    if (!touched.length) return PASS({ applicable: false });

    // C-04: registry_branch vem da representação admitida (E-01), sem default.
    const proj = readAdmittedProject(base);
    if (!proj.ok) return FAIL('E01', `REGISTRY_CONFIG_${proj.reason}`);
    // @guard C-04-TARGET
    if (pr.target !== proj.value.registry_branch) return FAIL('SCOPE', 'TARGET_NOT_REGISTRY_BRANCH');
    // @end C-04-TARGET
    const project = proj.value.project;

    // V-1: só caminhos protegidos, de um único PR e de uma única capability.
    // @guard V-1
    if (changes.some(c => !cmd.protectedSlugOf(c.path))) return FAIL('SCOPE', 'NON_PROTECTED_PATH_IN_DELTA');
    // @end V-1
    const slugs = [...new Set(touched.map(c => cmd.protectedSlugOf(c.path).slug).filter(Boolean))];
    // @guard V-1-ONE-CAP
    if (slugs.length !== 1) return FAIL('SCOPE', slugs.length ? 'MORE_THAN_ONE_CAPABILITY' : 'CATALOG_ONLY');
    // O-02: lote não informado não vale como "sem lote" (campo indeterminado → recusa).
    if (!Number.isInteger(pr.batchProtected) || pr.batchProtected < 1) return FAIL('SCOPE', 'BATCH_UNKNOWN');
    if (pr.batchProtected > 1) return FAIL('SCOPE', 'BATCH_WITH_OTHER_PROTECTED_PR');
    // @end V-1-ONE-CAP
    const slug = slugs[0];

    // V-0: estado de auditoria da capability na base (incremental desde âncora válida).
    let audit;
    try {
        audit = await auditCapability({ git, host, tip: baseSha, project, slug, decisionPort, mode: 'incremental', identities, [cmd.TEST_HOOKS]: testOnly });
    } catch {
        audit = { state: 'UNVERIFIABLE' };
    }

    // V-2: bytes do log.
    const oldBytes = base.read(cmd.logPath(slug));
    const newBytes = result.read(cmd.logPath(slug));
    const sp = splitAppend(oldBytes, newBytes);
    if (!sp.ok) return FAIL(sp.code, sp.reason);
    const old = oldBytes === null ? { status: 'OK', entries: [] } : parseLog(oldBytes);
    if (old.status !== 'OK') return FAIL('UNKNOWN', 'OLD_LOG');
    const derived = deriveState(old.entries, { editResolver: testOnly.editResolver || null });
    if (!derived.ok) return FAIL('UNKNOWN', 'OLD_STATE');

    // V-11: actor = autor do PR (HP-8); branch = ref de voo, salvo fallback D-231-2 B.
    // @guard V-11
    if (pr.verified !== true) return FAIL('IDENTITY', 'PR_METADATA_NOT_VERIFIABLE');
    if (sp.entry.actor !== pr.author) return FAIL('IDENTITY', 'ACTOR_NOT_PR_AUTHOR');
    if (hp3 && pr.branch !== cmd.markerBranch(project, slug)) return FAIL('IDENTITY', 'BRANCH_NOT_IN_FLIGHT_REF');
    // @end V-11

    const r = await decide({
        mode: 'new', project, slug, baseTree: base, resultTree: result, entry: sp.entry,
        oldEntries: old.entries, oldState: derived.state, auditState: audit.state,
        decisionPort, atCommit: baseSha, [cmd.TEST_HOOKS]: testOnly,
    });
    if (!r.ok) return FAIL(r.code, r.reason);
    return PASS({ applicable: true, slug, op_id: sp.entry.op_id, result_generation: sp.entry.result_generation });
}

module.exports = { checkIntegration };
