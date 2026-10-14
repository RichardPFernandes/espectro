// Artefatos de spec que um worktree recriado não herda. memory/ é gitignored; quando
// memory/spec/ já existe como diretório real (specs commitadas à força no passado),
// linkLocalMemory não o troca por um symlink do checkout principal. O retry de Recusa
// QA preenche o que falta, sem sobrescrever. O portão de drift só restaura a spec
// cujo hash é o spec_hash do Plan.
const fs = require('fs');
const path = require('path');
const specAuthority = require('./spec-authority');
const specVersion = require('./spec-version');

const SPEC_PREFIX = 'memory/spec/';

function safeRel(rel) {
    if (typeof rel !== 'string' || rel.includes('\0')) return null;
    const norm = path.posix.normalize(rel.replace(/\\/g, '/')).replace(/^\.\//, '');
    if (!norm.startsWith(SPEC_PREFIX)) return null;
    const parts = norm.slice(SPEC_PREFIX.length).split('/');
    if (parts.some(p => !p || p === '.' || p === '..')) return null;
    return norm;
}

function singleFileRel(rel) {
    const safe = safeRel(rel);
    if (!safe || safe.slice(SPEC_PREFIX.length).includes('/')) return null;
    return safe;
}

function ticketKey(state, taskId) {
    const raw = state?.redmine_ticket?.id ?? state?.ticket_id;
    const fromState = raw != null ? String(raw) : '';
    if (/^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/.test(fromState)) return fromState;
    const fromTask = /^([A-Za-z0-9][A-Za-z0-9._-]{0,80})-/.exec(String(taskId || ''));
    return fromTask ? fromTask[1] : null;
}

function artifactPlan(state, taskId) {
    const explicit = state?.spec_path;
    const unsafeExplicit = explicit != null && explicit !== '' && !singleFileRel(explicit);
    const specRel = unsafeExplicit ? null : singleFileRel(specAuthority.specRelFor(state, taskId));
    const ticket = ticketKey(state, taskId);
    return {
        unsafe: unsafeExplicit || (!!state?.spec_hash && !specRel),
        specRel,
        changelogRel: specRel ? singleFileRel(specVersion.changelogRelFor(specRel)) : null,
        provenanceRel: ticket ? singleFileRel(`${SPEC_PREFIX}${ticket}-ac-provenance.json`) : null,
        attachmentsRel: ticket ? safeRel(`${SPEC_PREFIX}${ticket}-attachments`) : null,
    };
}

function ensureSpecDir(root) {
    fs.mkdirSync(path.join(root, 'memory', 'spec'), { recursive: true });
}

function livesInSpec(root, abs) {
    const specDir = path.join(root, 'memory', 'spec');
    if (!fs.existsSync(specDir)) return false;
    let realSpec;
    try { realSpec = fs.realpathSync(specDir); } catch { return false; }
    const parent = path.dirname(abs);
    let candidate;
    if (fs.existsSync(parent)) {
        try { candidate = path.join(fs.realpathSync(parent), path.basename(abs)); } catch { return false; }
    } else {
        const rel = path.relative(specDir, abs);
        return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
    }
    const rel = path.relative(realSpec, candidate);
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function isFile(abs) {
    try { return fs.statSync(abs).isFile(); } catch { return false; }
}

function copyFileIfMissing(srcRoot, dstRoot, rel) {
    const safe = singleFileRel(rel);
    if (!safe) return null;
    const src = path.resolve(srcRoot, safe);
    const dst = path.resolve(dstRoot, safe);
    let realSrc;
    try { realSrc = fs.realpathSync(src); } catch { return null; }
    if (!livesInSpec(srcRoot, realSrc) || !isFile(realSrc)) return null;
    if (fs.existsSync(dst)) return null;
    ensureSpecDir(dstRoot);
    if (!livesInSpec(dstRoot, dst)) return null;
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    if (!livesInSpec(dstRoot, dst)) return null;
    try {
        fs.copyFileSync(realSrc, dst, fs.constants.COPYFILE_EXCL);
    } catch {
        return null;
    }
    return safe;
}

function copyTreeIfMissing(srcRoot, dstRoot, rel) {
    const copied = [];
    const seen = new Set();
    function walk(relPath) {
        const safe = safeRel(relPath);
        if (!safe) return;
        const src = path.resolve(srcRoot, safe);
        let real;
        try { real = fs.realpathSync(src); } catch { return; }
        if (!livesInSpec(srcRoot, real) || seen.has(real)) return;
        seen.add(real);
        let st;
        try { st = fs.statSync(real); } catch { return; }
        const dst = path.resolve(dstRoot, safe);
        ensureSpecDir(dstRoot);
        if (!livesInSpec(dstRoot, dst)) return;
        if (fs.existsSync(dst)) {
            if (!st.isDirectory()) return;
            let dstDir = false;
            try { dstDir = fs.statSync(dst).isDirectory(); } catch { return; }
            if (!dstDir) return;
            for (const name of fs.readdirSync(real)) walk(`${safe}/${name}`);
            return;
        }
        if (st.isDirectory()) {
            fs.mkdirSync(dst, { recursive: true });
            for (const name of fs.readdirSync(real)) walk(`${safe}/${name}`);
            return;
        }
        if (!st.isFile()) return;
        fs.mkdirSync(path.dirname(dst), { recursive: true });
        if (!livesInSpec(dstRoot, dst)) return;
        try {
            fs.copyFileSync(real, dst, fs.constants.COPYFILE_EXCL);
            copied.push(safe);
        } catch { /* corrida: o destino apareceu; não sobrescreve */ }
    }
    if (safeRel(rel)) walk(rel);
    return copied;
}

function present(root, rel) {
    if (!root || !rel) return false;
    const abs = path.resolve(root, rel);
    let real;
    try { real = fs.realpathSync(abs); } catch { return false; }
    return livesInSpec(root, real) && isFile(real);
}

/**
 * Run com spec_hash e spec em lugar nenhum (ou spec_path fora de memory/spec/) não
 * pode abrir o implement. Run sem spec_hash segue como task sem spec.
 */
function assess({ mainRoot, workRoot, state, taskId }) {
    const plan = artifactPlan(state, taskId);
    if (!state?.spec_hash) return { blocked: false, plan, reason: null };
    if (plan.unsafe) {
        return { blocked: true, plan, reason: `spec_path inseguro (${state.spec_path || plan.specRel || '?'}) — cópia recusada` };
    }
    if (!present(workRoot, plan.specRel) && !present(mainRoot, plan.specRel)) {
        return { blocked: true, plan, reason: `spec ${plan.specRel} ausente no worktree e no checkout principal` };
    }
    return { blocked: false, plan, reason: null };
}

/** Copia spec, changelog, ac-provenance e attachments que ainda não existem no worktree. */
function importMissing({ mainRoot, workRoot, state, taskId }) {
    const check = assess({ mainRoot, workRoot, state, taskId });
    if (check.blocked) return { blocked: true, copied: [], reason: check.reason };
    if (!workRoot) return { blocked: false, copied: [], reason: null };
    const copied = [];
    for (const rel of [check.plan.specRel, check.plan.changelogRel, check.plan.provenanceRel]) {
        const one = rel && copyFileIfMissing(mainRoot, workRoot, rel);
        if (one) copied.push(one);
    }
    if (check.plan.attachmentsRel) copied.push(...copyTreeIfMissing(mainRoot, workRoot, check.plan.attachmentsRel));
    return { blocked: false, copied, reason: null };
}

/**
 * Restaura a spec ausente no root do run somente quando o checkout principal tem
 * o mesmo hash do Plan. Changelog só acompanha se a entrada vigente tiver esse hash.
 * Hash diferente ou spec ausente nos dois: não grava nada.
 */
function restoreMatchingSpec({ mainRoot, workRoot, state, taskId, dryRun = false } = {}) {
    const none = { restored: false, wouldRestore: false };
    if (!state?.spec_hash || !workRoot) return none;
    const plan = artifactPlan(state, taskId);
    if (plan.unsafe || !plan.specRel) return none;
    if (present(workRoot, plan.specRel) || !present(mainRoot, plan.specRel)) return none;
    let content;
    try { content = fs.readFileSync(path.resolve(mainRoot, plan.specRel), 'utf8'); } catch { return none; }
    const hash = specAuthority.specHashFor(state, content);
    if (hash !== state.spec_hash) return none;
    if (dryRun) return { restored: false, wouldRestore: true, specPath: plan.specRel, hash };
    if (!copyFileIfMissing(mainRoot, workRoot, plan.specRel)) return none;
    let changelog = false;
    if (plan.changelogRel && !present(workRoot, plan.changelogRel) && present(mainRoot, plan.changelogRel)) {
        const read = specVersion.readChangelog(mainRoot, plan.changelogRel);
        const current = specVersion.currentEntry(read.data);
        if (current && current.hash === state.spec_hash) changelog = !!copyFileIfMissing(mainRoot, workRoot, plan.changelogRel);
    }
    return { restored: true, wouldRestore: true, specPath: plan.specRel, hash, changelog };
}

module.exports = {
    assess, importMissing, restoreMatchingSpec, artifactPlan, safeRel,
};
