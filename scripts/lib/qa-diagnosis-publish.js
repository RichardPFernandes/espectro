'use strict';
// PRI-181 C2 — publicação atômica do Diagnosis Record (R3-A / P-R3-01).
//
// Protocolo:
// 1. Materializar SOMENTE em staging (nunca AUTHORITY no staging).
// 2. Recibo de cutover no staging.
// 3. Promover staging → records/ sob lock da rejection_key; destino existente →
//    fail-closed (no-replace por exists+lock; RENAME_NOREPLACE = UNKNOWN neste host).
// 4. Gravar AUTHORITY no destino; origem/staging não-gravável após promote.
 // 5. Autoridade anterior (se houver republicação) vai para trash/.
//
// Não bloqueia retry QA (DB-05). C3 pode passar findings/evidence_refs.
// enrich: se autoridade existe com findings_status UNKNOWN e há findings novos,
// move autoridade antiga para trash e promove novo record (imutabilidade → nova versão).
// Sem dados de consumidor.

const fs = require('fs');
const path = require('path');
const layout = require('./qa-diagnosis-layout');
const recordBuilder = require('./qa-diagnosis-record');
const ingest = require('./qa-rejection-ingest');

function writeJson(file, obj) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(obj, null, 2)}\n`, 'utf8');
    fs.renameSync(tmp, file);
}

function readJson(file) {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function rmTree(dir) {
    fs.rmSync(dir, { recursive: true, force: true });
}

function moveToTrash(repoPath, authorityDir, rejectionKey) {
    if (!fs.existsSync(authorityDir)) return null;
    const trashParent = path.join(layout.storeRoot(repoPath), layout.TRASH);
    fs.mkdirSync(trashParent, { recursive: true });
    const dest = path.join(
        trashParent,
        `${layout.keySegment(rejectionKey)}-${Date.now()}`
    );
    fs.renameSync(authorityDir, dest);
    // Trash não é autoridade
    try { fs.unlinkSync(path.join(dest, layout.AUTHORITY_MARKER)); } catch { /* ok */ }
    return dest;
}

/**
 * Publica Diagnosis Record para rejection_key.
 * @returns {{ ok: true, authority_path, record, promoted: boolean, n08, no_replace } | { ok: false, reason, ... }}
 */
function publishDiagnosisRecord({
    repoPath,
    identity,
    ticketId = null,
    at = new Date().toISOString(),
    acquireLock = ingest.acquireKeyLock,
    evidence_refs = [],
    findings = null,
    findings_status = null,
    taxonomy_version = null,
    findings_note = null,
    corporate_content_included = false,
    enrich = false,
} = {}) {
    const key = identity?.rejection_key;
    if (!key) {
        return { ok: false, reason: 'missing_rejection_key' };
    }
    if (!repoPath) {
        return { ok: false, reason: 'missing_repo_path' };
    }

    const held = acquireLock(key, { repoPath });
    if (!held.acquired) {
        return {
            ok: false,
            reason: 'n08_contention',
            message: held.message,
            n08: { demonstrated_path: true, global_pass: false },
        };
    }

    try {
        layout.ensureLayout(repoPath);
        const p = layout.pathsFor(repoPath, key);
        const hasFindings = Array.isArray(findings) && findings.length > 0;

        // Idempotente / enrich C3: autoridade existente
        if (layout.isAuthorityDir(p.authorityDir) && fs.existsSync(p.authorityRecord)) {
            const existing = readJson(p.authorityRecord);
            if (existing.rejection_key === key && existing.authority === true) {
                const needsEnrich = enrich && hasFindings
                    && (existing.findings_status === 'UNKNOWN'
                        || !Array.isArray(existing.findings)
                        || existing.findings.length === 0);
                if (!needsEnrich) {
                    return {
                        ok: true,
                        promoted: false,
                        idempotent: true,
                        enriched: false,
                        authority_path: p.authorityDir,
                        record: existing,
                        n08: { demonstrated_path: true, global_pass: false },
                        no_replace: {
                            demonstrated_path: true,
                            os_rename_noreplace: layout.renameNoReplaceAvailable,
                            global_pass: false,
                            note: 'Destino já autoridade; republicação no-op (fail-closed se force replace).',
                        },
                    };
                }
                // Nova versão imutável: lixeira a autoridade antiga, depois promote
                moveToTrash(repoPath, p.authorityDir, key);
            } else {
                return {
                    ok: false,
                    reason: 'no_replace_destination_exists',
                    authority_path: p.authorityDir,
                    n08: { demonstrated_path: true, global_pass: false },
                    no_replace: {
                        demonstrated_path: true,
                        os_rename_noreplace: layout.renameNoReplaceAvailable,
                        global_pass: false,
                    },
                };
            }
        }

        // 1) Staging only
        if (fs.existsSync(p.stagingDir)) rmTree(p.stagingDir);
        fs.mkdirSync(p.stagingDir, { recursive: true });
        layout.assertStagingNotAuthority(p.stagingDir);

        let staged = recordBuilder.buildDiagnosisRecord(identity, {
            ticket_id: ticketId,
            at,
            status: 'staged',
            evidence_refs,
            findings: hasFindings ? findings : [],
            findings_status: findings_status
                || (hasFindings ? 'EVALUATED' : 'UNKNOWN'),
            taxonomy_version,
            findings_note,
            corporate_content_included,
        });
        staged = recordBuilder.markStaged(staged);
        writeJson(p.stagingRecord, staged);
        writeJson(p.stagingReceipt, {
            intent: 'promote_diagnosis_record',
            rejection_key: key,
            staged_at: at,
            staging_dir: p.stagingDir,
            target_dir: p.authorityDir,
            inv_r3_01: 'staging_never_authority',
        });
        layout.assertStagingNotAuthority(p.stagingDir);

        // 2) no-replace: se alguém criou authority entre staging e promote
        if (fs.existsSync(p.authorityDir)) {
            return {
                ok: false,
                reason: 'no_replace_destination_exists',
                staging_path: p.stagingDir,
                n08: { demonstrated_path: true, global_pass: false },
                no_replace: {
                    demonstrated_path: true,
                    os_rename_noreplace: layout.renameNoReplaceAvailable,
                    global_pass: false,
                    note: 'Destino apareceu antes do rename; staging preservado (não é autoridade).',
                },
            };
        }

        // 3) Promote atômico (rename dir). Staging deixa de existir; destino ainda sem AUTHORITY.
        fs.mkdirSync(path.dirname(p.authorityDir), { recursive: true });
        try {
            fs.renameSync(p.stagingDir, p.authorityDir);
        } catch (e) {
            if (e.code === 'ENOTEMPTY' || e.code === 'EEXIST') {
                return {
                    ok: false,
                    reason: 'no_replace_destination_exists',
                    error: e.code,
                    n08: { demonstrated_path: true, global_pass: false },
                    no_replace: {
                        demonstrated_path: true,
                        os_rename_noreplace: layout.renameNoReplaceAvailable,
                        global_pass: false,
                    },
                };
            }
            throw e;
        }

        // 4) Marcar autoridade + record publicado (R3-A: só agora é autoridade gravável)
        const published = recordBuilder.markPublished(staged, {
            published_at: at,
            authority_path: p.authorityDir,
        });
        writeJson(p.authorityRecord, published);
        fs.writeFileSync(p.authorityMarker, `${JSON.stringify({
            rejection_key: key,
            promoted_at: at,
            inv_r3_01: true,
        })}\n`, 'utf8');

        return {
            ok: true,
            promoted: true,
            idempotent: false,
            enriched: enrich === true && hasFindings,
            authority_path: p.authorityDir,
            record: published,
            n08: { demonstrated_path: true, global_pass: false },
            no_replace: {
                demonstrated_path: true,
                os_rename_noreplace: layout.renameNoReplaceAvailable,
                global_pass: false,
                note: layout.renameNoReplaceAvailable
                    ? 'RENAME_NOREPLACE disponível'
                    : 'RENAME_NOREPLACE ausente neste runtime; exclusão via exists+lock+rename fail-closed.',
            },
            p_r3_01: {
                staging: true,
                trash: true,
                demonstrated_path: true,
                global_pass: false,
                note: 'Layout staging/records/trash sob memory/qa-diagnosis; st_dev/cross-fs do consumidor = UNKNOWN.',
            },
        };
    } finally {
        try { held.release(); } catch { /* best-effort */ }
    }
}

/**
 * Ref para gravação no state do run (ponteiro; record vive no store).
 */
function statePointer(publishResult) {
    if (!publishResult?.ok || !publishResult.record) return null;
    return {
        rejection_key: publishResult.record.rejection_key,
        identity_quality: publishResult.record.identity_quality ?? null,
        published_at: publishResult.record.published_at,
        authority_path: publishResult.authority_path,
        schema_version: publishResult.record.schema_version,
        findings_status: publishResult.record.findings_status,
        taxonomy_version: publishResult.record.taxonomy_version ?? null,
        findings_count: Array.isArray(publishResult.record.findings)
            ? publishResult.record.findings.length
            : 0,
        is_context_record: false,
    };
}

module.exports = {
    publishDiagnosisRecord,
    statePointer,
    moveToTrash,
    writeJson,
    readJson,
};
