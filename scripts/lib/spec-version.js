// Versionamento formal da Spec: spec_version (inteiro, versão humana/semântica do
// contrato) + spec_hash (SHA-256 contratual do HASH_SCOPE — scripts/lib/spec-hash.js).
// Ciclo de vida completo: docs/spec-versioning.md. Decisão:
// memory/decisions/2026-09-30-spec-versioning.md.
//
//   state.json.spec           versão/hash da spec que o run usa (bloco abaixo). Ausente =
//                             run legado/unversioned: nada aqui falha, só degrada.
//   <spec>-changelog.json     histórico append-only por spec (não por run: a spec
//                             sobrevive a vários ciclos), ao lado da spec em memory/spec/.
//
// Quem escreve:
//   init     /fetch-ticket, logo depois de gravar o state.json da spec nova: version 1 (ou
//            a última do changelog), hash da spec recém-criada, status "draft".
//   seal     /plan (spec-authority.js baseline): a spec do template sai vazia e um humano
//            preenche Objetivo/Escopo/ACs antes do /plan — isso é autoria, não mudança.
//            O baseline sela a versão (status "active", hash = o que o Plan leu) e só
//            então a entrada "initial" entra no changelog.
//   bump     SPEC_CHANGE aprovada (spec-change.js approveSpecChange, ou aprovação manual
//            de drift em spec-authority.enforceSpecIntegrity) que ALTERA o HASH_SCOPE →
//            version+1, entrada nova no changelog. Hash igual → versão fica.
//   rebaseline  contrato mudou num ponto de baseline SEM SPEC_CHANGE aprovada (notas de
//            correção do /commit antes do retry de Recusa QA, revisão humana entre ciclos,
//            replanejamento depois de drift): a versão NÃO incrementa; o hash novo vai
//            para changelog.rebaselines[] (version = semântica, hash = identidade exata).
//
// Uso como CLI (<run-dir> = memory/runs/<task-id>; a raiz do repo é ../../.. dele):
//   node scripts/lib/spec-version.js init <run-dir> [--by=fetch_ticket]
//   node scripts/lib/spec-version.js show <run-dir> [--json]        dados do dashboard
//   node scripts/lib/spec-version.js commit-message <run-dir> "<mensagem>"
//   node scripts/lib/spec-version.js pr-line <run-dir>
//   node scripts/lib/spec-version.js changelog <run-dir|spec.md> [--json]
// exit 0 = ok, 1 = run legado/sem spec (init: spec inexistente), 2 = uso incorreto.

const fs = require('fs');
const path = require('path');
const specHash = require('./spec-hash');

const CHANGELOG_SCHEMA_VERSION = 1;
const HEX64 = /^[0-9a-f]{64}$/;

const short = h => (h ? String(h).slice(0, 12) : '—');

// ── Leitura tolerante (legado nunca lança) ───────────────────────────────────────

/** Bloco state.spec válido, ou null (run legado/unversioned, ou bloco corrompido). */
function readSpecBlock(state) {
    const s = state && typeof state === 'object' ? state.spec : null;
    if (!s || typeof s !== 'object' || Array.isArray(s)) return null;
    if (!Number.isInteger(s.version) || s.version < 1 || typeof s.hash_scope !== 'string') return null;
    return s;
}

function isVersioned(state) {
    return readSpecBlock(state) != null;
}

/** spec_version da spec do run (null = legado). */
function versionOf(state) {
    return readSpecBlock(state)?.version ?? null;
}

// ── Changelog (append-only) ──────────────────────────────────────────────────────

function changelogRelFor(specRel) {
    return String(specRel).replace(/\.md$/i, '') + '-changelog.json';
}

function specIdFor(state, taskId, specRel) {
    const ticket = state?.redmine_ticket?.id;
    if (ticket != null) return String(ticket);
    const m = /([^/]+?)-spec\.md$/.exec(String(specRel || ''));
    return m ? m[1] : String(state?.task_id || taskId || '');
}

/**
 * Changelog da spec: {data} (vazio = arquivo ausente) ou {error} (JSON ilegível — nunca
 * é sobrescrito: quem escreve recusa e avisa).
 */
function readChangelog(root, rel) {
    const file = path.resolve(root, rel);
    let raw;
    try { raw = fs.readFileSync(file, 'utf8'); } catch { return { data: null, file }; }
    try {
        const data = JSON.parse(raw);
        if (!data || typeof data !== 'object' || !Array.isArray(data.versions)) return { error: `${rel}: sem "versions[]"`, file };
        if (!Array.isArray(data.rebaselines)) data.rebaselines = [];
        return { data, file };
    } catch (e) {
        return { error: `${rel}: JSON inválido (${e.message})`, file };
    }
}

function writeJsonAtomic(file, data) {
    // A união de memory/spec pode ligar arquivo a arquivo. Rename sobre o link
    // o substituiria e deixaria o changelog durável só no worktree descartável.
    let stat;
    try { stat = fs.lstatSync(file); } catch (e) {
        if (e.code !== 'ENOENT') throw e; // arquivo novo é permitido
    }
    // realpath fica fora do catch: link quebrado falha sem ser substituído.
    if (stat?.isSymbolicLink()) file = fs.realpathSync(file);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n');
    fs.renameSync(tmp, file);
}

/** Entrada vigente: a última versão, ou o último rebaseline dela (hash/fingerprint atuais). */
function currentEntry(data) {
    if (!data || !data.versions.length) return null;
    const v = data.versions[data.versions.length - 1];
    const rb = data.rebaselines.filter(r => r.version === v.version);
    return rb.length ? { ...v, hash: rb[rb.length - 1].hash, fingerprint: rb[rb.length - 1].fingerprint || v.fingerprint } : v;
}

/**
 * Acrescenta uma versão. Relê o arquivo e só faz APPEND: entrada existente nunca é
 * reescrita; versão repetida ou fora de sequência é recusada.
 * @returns {{ok: boolean, error?: string, entry?: object, index?: number}}
 */
function appendVersion(root, rel, entry, meta = {}) {
    const read = readChangelog(root, rel);
    if (read.error) return { ok: false, error: `${read.error} — changelog não reescrito` };
    const data = read.data || {
        schema_version: CHANGELOG_SCHEMA_VERSION, spec_id: meta.spec_id ?? null, spec_path: meta.spec_path ?? null,
        hash_scope: entry.hash_scope, versions: [], rebaselines: [],
    };
    const last = data.versions[data.versions.length - 1];
    const expected = last ? last.version + 1 : entry.version;
    if (data.versions.some(v => v.version === entry.version)) return { ok: false, error: `${rel}: versão ${entry.version} já registrada — o changelog é append-only` };
    if (entry.version !== expected) return { ok: false, error: `${rel}: versão ${entry.version} fora de sequência (esperada ${expected})` };
    if (!HEX64.test(entry.hash || '')) return { ok: false, error: `hash inválido para a versão ${entry.version}` };
    data.versions = [...data.versions, entry];
    data.hash_scope = entry.hash_scope || data.hash_scope;
    data.updated_at = entry.created_at;
    writeJsonAtomic(read.file, data);
    return { ok: true, entry, index: data.versions.length };
}

function appendRebaseline(root, rel, entry) {
    const read = readChangelog(root, rel);
    if (read.error) return { ok: false, error: `${read.error} — changelog não reescrito` };
    if (!read.data || !read.data.versions.some(v => v.version === entry.version)) return { ok: false, error: `${rel}: rebaseline da versão ${entry.version}, que não está no changelog` };
    const data = read.data;
    // Retry com state antigo após falha no writer: a entrada já persistida é
    // suficiente. Só deduplica o hash vigente, preservando transições A → B → A.
    const latest = currentEntry(data);
    if (latest?.version === entry.version && latest.hash === entry.hash) return { ok: true, entry: latest };
    data.rebaselines = [...data.rebaselines, entry];
    data.updated_at = entry.at;
    writeJsonAtomic(read.file, data);
    return { ok: true, entry };
}

// ── Escrita no state (muta; quem chama grava o state.json) ───────────────────────

function pushEvent(state, event) {
    state.events = Array.isArray(state.events) ? state.events : [];
    state.events.push({ ts: event.at, ...event });
}

/**
 * Bloco state.spec inicial (/fetch-ticket). Idempotente: bloco já existente fica.
 * @returns {object|null} o bloco (null = sem spec).
 */
function init(state, { root, specRel, content, taskId, by = 'fetch_ticket', now = new Date().toISOString() }) {
    if (readSpecBlock(state)) return state.spec;
    if (content == null) return null;
    const scope = specHash.currentScope();
    const hash = specHash.contractHash(content, { scope });
    const changelogRel = changelogRelFor(specRel);
    const prior = currentEntry(readChangelog(root, changelogRel).data);
    state.spec = {
        id: specIdFor(state, taskId, specRel),
        path: specRel,
        version: prior ? prior.version : 1,
        hash,
        hash_scope: scope,
        status: 'draft',
        changelog_path: changelogRel,
        created_at: now,
        created_by: by,
        initial_hash: hash,
        sealed_at: null,
        sealed_by: null,
        updated_at: now,
        updated_by: by,
        last_change: null,
    };
    pushEvent(state, {
        type: 'spec_version_init', node: by, at: now,
        detail: `spec ${specRel} v${state.spec.version}${prior ? ' (do changelog de ciclo anterior)' : ''} · hash ${short(hash)} (${scope}) — rascunho até o /plan selar`,
    });
    return state.spec;
}

/**
 * Baseline (/plan, baseline tardio do watcher, retry de Recusa QA). Sela a versão em
 * rascunho; com a versão já selada e o contrato mudado sem SPEC_CHANGE, registra
 * rebaseline (versão NÃO incrementa). Run legado: nada.
 * @returns {{action: 'none'|'sealed'|'rebaselined'|'unchanged', version?: number, error?: string}}
 */
function onBaseline(state, { root, content, hash, by = 'plan', now = new Date().toISOString(), runId = null, reason = null }) {
    const spec = readSpecBlock(state);
    if (!spec || content == null) return { action: 'none' };
    const fp = specHash.fingerprint(content, { scope: spec.hash_scope });
    const read = readChangelog(root, spec.changelog_path);
    if (read.error) {
        pushEvent(state, { type: 'spec_version_error', node: by, at: now, detail: `${read.error} — versão não selada/registrada; corrija o arquivo` });
        return { action: 'none', error: read.error };
    }
    const latest = currentEntry(read.data);
    const meta = { spec_id: spec.id, spec_path: spec.path };

    if (spec.status !== 'active') {
        let version = spec.version;
        if (!latest) {
            const out = appendVersion(root, spec.changelog_path, {
                version, hash, hash_scope: spec.hash_scope, created_at: now, created_by: by, run_id: runId,
                reason: 'initial', approval_ref: null, spec_change_id: null, diff_summary: null, fingerprint: fp,
            }, meta);
            if (!out.ok) return { action: 'none', error: out.error };
        } else {
            version = latest.version;
            if (latest.hash !== hash) {
                const out = appendRebaseline(root, spec.changelog_path, {
                    version, hash, at: now, by, run_id: runId,
                    reason: reason || 'contrato alterado fora de SPEC_CHANGE desde o último ciclo (revisão da spec antes do /plan) — versão mantida',
                    diff_summary: specHash.diffSummary(latest.fingerprint, fp), fingerprint: fp,
                });
                if (!out.ok) return { action: 'none', error: out.error };
            }
        }
        Object.assign(spec, { version, hash, status: 'active', sealed_at: now, sealed_by: by, updated_at: now, updated_by: by });
        pushEvent(state, { type: 'spec_version_sealed', node: by, at: now, detail: `spec v${version} selada · hash ${short(hash)} (${spec.hash_scope})` });
        return { action: 'sealed', version };
    }

    if (spec.hash === hash) return { action: 'unchanged', version: spec.version };
    const prevFp = latest?.fingerprint || null;
    if (latest && latest.version === spec.version) {
        const out = appendRebaseline(root, spec.changelog_path, {
            version: spec.version, hash, at: now, by, run_id: runId,
            reason: reason || 'contrato alterado sem SPEC_CHANGE aprovada, num ponto de baseline — versão mantida',
            diff_summary: specHash.diffSummary(prevFp, fp), fingerprint: fp,
        });
        if (!out.ok) return { action: 'none', error: out.error };
    }
    Object.assign(spec, { hash, updated_at: now, updated_by: by });
    pushEvent(state, {
        type: 'spec_version_rebaseline', node: by, at: now,
        detail: `contrato da spec mudou sem SPEC_CHANGE aprovada (${by}) — v${spec.version} mantida, hash ${short(hash)} registrado em rebaselines[]`,
    });
    return { action: 'rebaselined', version: spec.version };
}

/**
 * SPEC_CHANGE aprovada: incrementa a versão SÓ se o hash contratual mudou.
 * @param {object} state  muta state.spec
 * @param {{root, newContent, oldContent?, reason, approvalRef, specChangeId?, approvedBy?,
 *   by, now?, runId?}} p
 * @returns {{bumped: boolean, version?: number, reason: string, error?: string}}
 */
function bump(state, { root, newContent, oldContent = null, reason, approvalRef, specChangeId = null, approvedBy = null, by, now = new Date().toISOString(), runId = null }) {
    const spec = readSpecBlock(state);
    if (!spec) return { bumped: false, reason: 'unversioned' };
    if (newContent == null) return { bumped: false, reason: 'sem spec' };
    const hash = specHash.contractHash(newContent, { scope: spec.hash_scope });
    if (hash === spec.hash) {
        pushEvent(state, { type: 'spec_version_unchanged', node: by, at: now, detail: `${specChangeId || 'SPEC_CHANGE'} aprovada sem alterar o HASH_SCOPE — v${spec.version} mantida` });
        return { bumped: false, version: spec.version, reason: 'hash_scope_unchanged' };
    }
    const read = readChangelog(root, spec.changelog_path);
    if (read.error) {
        pushEvent(state, { type: 'spec_version_error', node: by, at: now, detail: `${read.error} — v${spec.version + 1} NÃO registrada; corrija o arquivo e reaprove` });
        return { bumped: false, reason: 'changelog_invalid', error: read.error };
    }
    const meta = { spec_id: spec.id, spec_path: spec.path };
    let latest = currentEntry(read.data);
    const oldFp = oldContent != null ? specHash.fingerprint(oldContent, { scope: spec.hash_scope }) : null;
    if (!latest) {
        // Changelog sumiu/nunca foi selado: registra a versão vigente antes da nova.
        const base = appendVersion(root, spec.changelog_path, {
            version: spec.version, hash: spec.hash, hash_scope: spec.hash_scope, created_at: now, created_by: 'reconstructed', run_id: runId,
            reason: 'initial (reconstruída na primeira SPEC_CHANGE: changelog ausente)', approval_ref: null, spec_change_id: null, diff_summary: null, fingerprint: oldFp,
        }, meta);
        if (!base.ok) return { bumped: false, reason: 'changelog_error', error: base.error };
        latest = base.entry;
    }
    const fp = specHash.fingerprint(newContent, { scope: spec.hash_scope });
    const version = Math.max(spec.version, latest.version) + 1;
    const out = appendVersion(root, spec.changelog_path, {
        version, hash, hash_scope: spec.hash_scope, created_at: now, created_by: by, run_id: runId,
        reason, approval_ref: approvalRef, spec_change_id: specChangeId, ...(approvedBy ? { approved_by: approvedBy } : {}),
        diff_summary: specHash.diffSummary(oldFp || latest.fingerprint, fp), fingerprint: fp,
    }, meta);
    if (!out.ok) {
        pushEvent(state, { type: 'spec_version_error', node: by, at: now, detail: out.error });
        return { bumped: false, reason: 'changelog_error', error: out.error };
    }
    const from = spec.version;
    Object.assign(spec, {
        version, hash, status: 'active', updated_at: now, updated_by: by,
        last_change: { spec_change_id: specChangeId, approval_ref: approvalRef, from_version: from, at: now },
    });
    pushEvent(state, {
        type: 'spec_version_bumped', node: by, at: now,
        detail: `spec v${from} → v${version} (${specChangeId || 'SPEC_CHANGE'} aprovada; ${out.entry.diff_summary || 'HASH_SCOPE alterado'}) · hash ${short(hash)}`,
    });
    return { bumped: true, version, reason: 'hash_scope_changed', entry: out.entry };
}

// ── Artefatos derivados ──────────────────────────────────────────────────────────

/**
 * O que um artefato gerado agora deve registrar. spec_version só quando o hash atual é o
 * da versão em state.spec — senão a versão do conteúdo é desconhecida (mid-run).
 * @returns {{spec_version: number|null, spec_hash: string|null, spec_hash_scope?: string,
 *   mismatch: boolean, message: string|null}}
 */
function stampFor(state, currentHash) {
    const spec = readSpecBlock(state);
    if (!spec) return { spec_version: null, spec_hash: currentHash || null, mismatch: false, message: null };
    if (!currentHash || currentHash === spec.hash) {
        return { spec_version: spec.version, spec_hash: currentHash || spec.hash, spec_hash_scope: spec.hash_scope, mismatch: false, message: null };
    }
    return {
        spec_version: null, spec_hash: currentHash, spec_hash_scope: spec.hash_scope, mismatch: true,
        message: `SPEC_CHANGE mid-run: a spec atual (hash ${short(currentHash)}) não é a v${spec.version} registrada em state.json (hash ${short(spec.hash)}) — mudança de contrato sem versão aprovada`,
    };
}

const PLAN_REF = /spec_version\s*[=:]\s*`?(\d+)`?[\s\S]{0,80}?spec_hash\s*[=:]\s*`?([0-9a-f]{12,64})/i;

/** spec_version/spec_hash declarados no plan.md (linha "Spec: … · spec_version=N · spec_hash=…"). */
function planRef(planContent) {
    const m = PLAN_REF.exec(String(planContent || ''));
    return m ? { spec_version: Number(m[1]), spec_hash: m[2] } : null;
}

/**
 * Versão/hash registrados por artefato, conferidos contra a spec atual (Verify).
 * Artefato em stale_artifacts não duplica alerta (STALE_ARTIFACTS já reprova).
 * @returns {{artifacts: object[], warnings: {code, message}[], failures: {code, message}[]}}
 */
function checkArtifacts({ state, currentHash, planContent = null, acceptanceData = null }) {
    const spec = readSpecBlock(state);
    const out = { artifacts: [], warnings: [], failures: [] };
    if (!spec) return out;
    const stale = new Set(Array.isArray(state.stale_artifacts) ? state.stale_artifacts : []);
    const plan = planRef(planContent);
    const items = [
        { artifact: 'plan', file: 'plan.md', spec_version: state.spec_hash_version ?? plan?.spec_version ?? null, spec_hash: state.spec_hash || null },
        ...(plan ? [{ artifact: 'plan.md', file: 'plan.md', spec_version: plan.spec_version, spec_hash: plan.spec_hash }] : []),
        ...(state.review_results ? [{ artifact: 'review', file: 'review-result.md', spec_version: state.review_results.spec_version ?? null, spec_hash: state.review_results.spec_hash || null }] : []),
        ...(acceptanceData ? [{ artifact: 'test', file: 'acceptance-evidence.json', spec_version: acceptanceData.spec_version ?? null, spec_hash: acceptanceData.spec_hash || null }] : []),
    ];
    if (planContent != null && !plan && spec.status === 'active') {
        out.warnings.push({ code: 'PLAN_SPEC_VERSION_MISSING', message: `plan.md não declara a versão da spec usada (linha "Spec: ${spec.path} · spec_version=${spec.version} · spec_hash=${short(spec.hash)}").` });
    }
    for (const it of items) {
        out.artifacts.push(it);
        if (!it.spec_hash || stale.has(it.file)) continue;
        const sameHash = require('../invalidate').classify(it.spec_hash, currentHash) === 'VALID';
        const sameVersion = it.spec_version == null || it.spec_version === spec.version;
        if (sameHash && sameVersion) continue;
        const what = `${it.artifact} (${it.file}) registrou spec v${it.spec_version ?? '?'} · hash ${short(it.spec_hash)}, mas a spec atual é v${spec.version} · hash ${short(currentHash)}`;
        if (sameHash && !sameVersion) {
            out.failures.push({ code: 'SPEC_VERSION_MISMATCH', message: `${what} — mesmo conteúdo com versão diferente: state.json.spec ou o artefato estão inconsistentes.` });
        } else {
            out.warnings.push({ code: 'SPEC_CHANGE_MID_RUN', message: `${what} — SPEC_CHANGE no meio do run: o artefato foi gerado sobre outra versão do contrato; regere-o sobre a v${spec.version}.` });
        }
    }
    return out;
}

// ── Commit / PR ──────────────────────────────────────────────────────────────────

const COMMIT_TAG = /\s*\[spec_version=[^\]]*\]\s*$/;

/** "<msg> [spec_version=N]" — run legado ou spec em rascunho: mensagem intacta. */
function commitMessage(state, message) {
    const spec = readSpecBlock(state);
    const base = String(message || '').replace(COMMIT_TAG, '');
    if (!spec || spec.status !== 'active') return base;
    return `${base} [spec_version=${spec.version}]`;
}

/** Linha de metadados para a descrição do PR (título do PR fica literal). */
function prLine(state) {
    const spec = readSpecBlock(state);
    if (!spec) return null;
    return `Spec: ${spec.path} · spec_version=${spec.version} · spec_hash=${short(spec.hash)}`;
}

/** Metadados de spec por PR (state.pull_request.<repo> e nó pr do knowledge graph). */
function prSpecRef(state) {
    const spec = readSpecBlock(state);
    return spec ? { spec_id: spec.id, spec_version: spec.version, spec_hash: spec.hash } : null;
}

// ── Dashboard ────────────────────────────────────────────────────────────────────

/**
 * Raiz do checkout de um run em qualquer profundidade (memory/runs/<id>,
 * memory/runs/_archive/<id>, memory/archive/<YYYY-MM>/<id>): o pai do diretório memory/.
 */
function rootOfAnyRunDir(runDir) {
    let dir = path.resolve(runDir);
    while (path.dirname(dir) !== dir) {
        if (path.basename(dir) === 'memory') return path.dirname(dir);
        dir = path.dirname(dir);
    }
    return path.resolve(runDir, '..', '..', '..');
}

/**
 * Tudo que o dashboard precisa para "SPEC v2 | hash: abc… | Status: ACTIVE" e
 * "Histórico: v1 → SPEC_CHANGE SC-001 → v2". Nunca lança.
 */
function describe(state, { root = null } = {}) {
    const spec = readSpecBlock(state);
    if (!spec) {
        return { versioned: false, status: 'UNVERSIONED', label: 'SPEC (legado — sem versão formal)', version: null, hash: state?.spec_hash || null, history: [], history_label: null };
    }
    let status = spec.status === 'active' ? 'ACTIVE' : 'DRAFT';
    if (state.status === 'spec-change-pending-approval') status = 'PENDING_CHANGE';
    else if (state.status === 'spec-drift') status = 'DRIFT';
    else if (state.status === 'spec-change-rejected') status = 'CHANGE_REJECTED';
    let changelog = null;
    let changelogError = null;
    if (root) {
        const read = readChangelog(root, spec.changelog_path);
        changelog = read.data;
        changelogError = read.error || null;
    }
    const versions = changelog?.versions || [];
    const history = versions.map(v => ({
        version: v.version, hash: v.hash, created_at: v.created_at, reason: v.reason,
        approval_ref: v.approval_ref, spec_change_id: v.spec_change_id || null, diff_summary: v.diff_summary,
        rebaselines: (changelog.rebaselines || []).filter(r => r.version === v.version).length,
    }));
    const steps = [];
    history.forEach((v, i) => {
        if (i > 0) steps.push(`SPEC_CHANGE${v.spec_change_id ? ` ${v.spec_change_id}` : ''}`);
        steps.push(`v${v.version}`);
    });
    return {
        versioned: true, spec_id: spec.id, path: spec.path, version: spec.version, hash: spec.hash, hash_short: short(spec.hash),
        hash_scope: spec.hash_scope, status, sealed_at: spec.sealed_at, last_change: spec.last_change || null,
        changelog_path: spec.changelog_path, changelog_error: changelogError,
        label: `SPEC v${spec.version} | hash: ${short(spec.hash)}… | Status: ${status}`,
        history, history_label: steps.length ? steps.join(' → ') : `v${spec.version} (ainda sem changelog — selado no /plan)`,
    };
}

module.exports = {
    CHANGELOG_SCHEMA_VERSION, readSpecBlock, isVersioned, versionOf, changelogRelFor, specIdFor,
    readChangelog, appendVersion, appendRebaseline, currentEntry, init, onBaseline, bump,
    stampFor, planRef, checkArtifacts, commitMessage, prLine, prSpecRef, describe, rootOfAnyRunDir,
};

// ── CLI ──────────────────────────────────────────────────────────────────────────

if (require.main === module) {
    const sa = require('./spec-authority');
    const args = process.argv.slice(2);
    const flag = name => { const a = args.find(x => x === `--${name}` || x.startsWith(`--${name}=`)); return a === undefined ? undefined : (a.includes('=') ? a.split('=').slice(1).join('=') : true); };
    const [cmd, target, extra] = args.filter(a => !a.startsWith('--'));
    const usage = () => {
        console.error('Uso: node scripts/lib/spec-version.js init <run-dir> [--by=fetch_ticket] | show <run-dir> [--json] | commit-message <run-dir> "<mensagem>" | pr-line <run-dir> | changelog <run-dir|spec.md> [--json]');
        process.exit(2);
    };
    if (!cmd || !target) usage();

    if (cmd === 'changelog' && /\.md$/i.test(target)) {
        const rel = path.relative(process.cwd(), path.resolve(target));
        const read = readChangelog(process.cwd(), changelogRelFor(rel));
        if (read.error) { console.error(read.error); process.exit(2); }
        console.log(JSON.stringify(read.data || { versions: [], rebaselines: [] }, null, 2));
        process.exit(read.data ? 0 : 1);
    }
    const runDir = path.resolve(target);
    const stateFile = path.join(runDir, 'state.json');
    if (!fs.existsSync(stateFile)) { console.error(`${target}: sem state.json.`); process.exit(2); }
    const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    const root = rootOfAnyRunDir(runDir);
    const taskId = state.task_id || path.basename(runDir);

    if (cmd === 'init') {
        const specRel = sa.specRelFor(state, taskId);
        const content = sa.readSpec(root, specRel);
        if (content == null) { console.error(`${specRel}: spec não encontrada — sem bloco spec (task sem spec).`); process.exit(1); }
        const existed = isVersioned(state);
        const block = init(state, { root, specRel, content, taskId, by: typeof flag('by') === 'string' ? flag('by') : 'fetch_ticket' });
        if (!existed) {
            state.updated_at = block.updated_at;
            require('../state-writer').write(runDir, state, { operation: 'spec_version_init', actor: 'agent' });
        }
        console.log(`[spec-version] ${existed ? 'já versionada' : 'bloco spec gravado'}: ${specRel} v${block.version} · hash ${block.hash} (${block.hash_scope}, ${block.status})`);
        process.exit(0);
    }
    if (cmd === 'show') {
        const d = describe(state, { root });
        if (flag('json')) console.log(JSON.stringify(d, null, 2));
        else {
            console.log(d.label);
            if (d.versioned) console.log(`Histórico: ${d.history_label}`);
            for (const v of d.history) console.log(`  v${v.version} ${v.created_at} — ${v.reason}${v.approval_ref ? ` (${v.approval_ref})` : ''}${v.diff_summary ? ` · ${v.diff_summary}` : ''}`);
        }
        process.exit(d.versioned ? 0 : 1);
    }
    if (cmd === 'commit-message') {
        if (extra == null) usage();
        console.log(commitMessage(state, extra));
        process.exit(0);
    }
    if (cmd === 'pr-line') {
        const line = prLine(state);
        if (line) console.log(line);
        process.exit(line ? 0 : 1);
    }
    if (cmd === 'changelog') {
        const spec = readSpecBlock(state);
        if (!spec) { console.error('run legado — sem changelog de versão.'); process.exit(1); }
        const read = readChangelog(root, spec.changelog_path);
        if (read.error) { console.error(read.error); process.exit(2); }
        console.log(JSON.stringify(read.data || { versions: [], rebaselines: [] }, null, 2));
        process.exit(0);
    }
    usage();
}
