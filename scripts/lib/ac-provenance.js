// Provenance dos Critérios de Aceite: a história demonstrável de cada AC (de onde veio e
// o que aconteceu com ele depois), como referências estruturadas — nunca o texto do AC,
// que vive só na spec. Desenho e levantamento: docs/ac-provenance.md e
// docs/ac-provenance-sources.md (EC-1..EC-4).
//
// Fonte de verdade: memory/spec/<ticket>-ac-provenance.json no checkout principal, um log
// append-only por ticket (mesmo padrão do <ticket>-spec-changelog.json). O AC Registry
// (.graph/ac-registry.json) só guarda `ac_sources` como PROJEÇÃO reconstruível deste log
// (INV-AC-PROVENANCE-02): apagar/reconstruir o registro não perde nada.
//
// Identidade de um AC = (ticket_id, ac_id): todo ticket tem o seu AC-01.
//
// Formato do log:
//   { version: 1, ticket_id: "43666", events: [
//       { event_id, ac_id, type, role, recorded_at, reference } ] }
// `recorded_at` = quando ESTE sistema registrou o evento, não quando o AC nasceu.
// `event_id` = "<ticket>:<ac>:<type>:<role>:<chave natural da evidência>" — append de um
// event_id que já existe é no-op (idempotente), nunca sobrescreve.
//
// Nada aqui infere origem (INV-AC-PROVENANCE-01): quem chama passa só evidência que tem
// persistida; sem ela, o resultado correto é UNKNOWN. Evidência de ticket/spec/gate/human
// input não vira provenance de AC sem vínculo estruturado (INV-AC-PROVENANCE-03).
//
// Uso como CLI:
//   node scripts/lib/ac-provenance.js show <ticket> [AC-NN] [--root=<checkout>]
//   node scripts/lib/ac-provenance.js declare <ticket> <AC-NN> --type=<TYPE> --role=<ROLE>
//        --ref='<json>' [--key=<chave>] [--root=<checkout>]
//        Provenance declarada explicitamente por uma pessoa (único caminho de
//        HUMAN_AUTHORED, ATTACHMENT, REDMINE_CUSTOM_FIELD e REDMINE_COMMENT por AC).
//   exit 0 = ok, 1 = falha de validação/escrita, 2 = uso incorreto.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const LOG_VERSION = 1;
const SOURCE_TYPES = [
    'REDMINE_DESCRIPTION', 'REDMINE_COMMENT', 'REDMINE_CUSTOM_FIELD', 'ATTACHMENT',
    'HUMAN_CLARIFICATION', 'HUMAN_AUTHORED', 'AGENT_DRAFT_APPROVED', 'SPEC_CHANGE', 'UNKNOWN',
];
const SOURCE_ROLES = ['ORIGIN', 'CLARIFICATION', 'MODIFICATION', 'APPROVAL'];
const LEGACY_NUMBERING_REF = 'legacy-numbering';
const AC_ID_RE = /^AC-\d{2,}$/;
const TICKET_RE = /^\d+$/;

// Referência é só identificador: chave com cara de conteúdo/credencial é recusada (a
// não ser os sufixos de identificador, ex. message_hash, journal_id), e string longa
// também — é assim que texto de AC/comentário/anexo não entra por engano.
const FORBIDDEN_KEY_RE = /(^|_)(text|texts|description|notes?|content|criteria|criterion|body|message|rationale|behavior|token|api_?key|secret|password|authorization|headers?|cookie)($|_)/i;
const ID_SUFFIX_RE = /_(hash|id|ids|ref|path|at|type)$/i;
const MAX_REF_STRING = 200;
const LOCK_ATTEMPTS = 20;
const LOCK_WAIT_MS = 25;
const LOCK_STALE_MS = 10000;

// ── Caminhos ──────────────────────────────────────────────────────────────────

/**
 * Checkout principal a partir de qualquer worktree dele (o log é um só por ticket, no
 * principal). AC_PROVENANCE_ROOT força a raiz; fora de um repo git, o próprio dir.
 */
function provenanceRoot(fromDir = process.cwd()) {
    if (process.env.AC_PROVENANCE_ROOT) return path.resolve(process.env.AC_PROVENANCE_ROOT);
    try {
        const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'],
            { cwd: fromDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
        return path.dirname(common);
    } catch {
        return path.resolve(fromDir);
    }
}

function specDirOf({ root, specDir } = {}) {
    if (specDir) return path.resolve(specDir);
    return path.join(path.resolve(root || provenanceRoot()), 'memory', 'spec');
}

function logPath(ticketId, opts = {}) {
    return path.join(specDirOf(opts), `${ticketId}-ac-provenance.json`);
}

// Ticket de um run: redmine_ticket.id / ticket_id do state, senão o prefixo numérico do task-id.
function ticketOf(taskId, state = null) {
    const id = state?.redmine_ticket?.id ?? state?.ticket_id ?? (/^(\d{4,6})-/.exec(String(taskId || '')) || [])[1];
    return id != null && TICKET_RE.test(String(id)) ? String(id) : null;
}

// ── Validação ─────────────────────────────────────────────────────────────────

function validRefValue(v) {
    if (v === null || typeof v === 'number' || typeof v === 'boolean') return true;
    if (typeof v === 'string') return v.length <= MAX_REF_STRING;
    if (Array.isArray(v)) return v.length <= 50 && v.every(x => x === null || typeof x === 'number' || (typeof x === 'string' && x.length <= MAX_REF_STRING));
    return false;
}

function validateReference(ref) {
    const errors = [];
    if (typeof ref === 'string') {
        if (!ref.trim() || ref.length > MAX_REF_STRING) errors.push('reference string vazia ou longa demais');
        return errors;
    }
    if (!ref || typeof ref !== 'object' || Array.isArray(ref)) return ['reference deve ser objeto (ou string curta)'];
    if (!Object.keys(ref).length) errors.push('reference vazia — sem identificador não há evidência');
    for (const [k, v] of Object.entries(ref)) {
        if (FORBIDDEN_KEY_RE.test(k) && !ID_SUFFIX_RE.test(k)) errors.push(`reference.${k}: campo de conteúdo/credencial não é permitido (só identificadores)`);
        else if (!validRefValue(v)) errors.push(`reference.${k}: valor deve ser identificador escalar curto (string <= ${MAX_REF_STRING}, número, booleano, null ou lista deles)`);
    }
    return errors;
}

function validateEvent(ev, ticketId) {
    const errors = [];
    if (!ev || typeof ev !== 'object') return ['evento não é objeto'];
    if (!AC_ID_RE.test(ev.ac_id || '')) errors.push(`ac_id inválido: ${JSON.stringify(ev.ac_id ?? null)}`);
    if (!SOURCE_TYPES.includes(ev.type)) errors.push(`type inválido: ${JSON.stringify(ev.type ?? null)} (use ${SOURCE_TYPES.join(' | ')})`);
    if (!SOURCE_ROLES.includes(ev.role)) errors.push(`role inválido: ${JSON.stringify(ev.role ?? null)} (use ${SOURCE_ROLES.join(' | ')})`);
    if (typeof ev.key !== 'string' || !ev.key.trim()) errors.push('key (identidade natural da evidência) vazia');
    errors.push(...validateReference(ev.reference));
    if (ev.ticket_id != null && String(ev.ticket_id) !== String(ticketId)) errors.push(`evento do ticket ${ev.ticket_id} no log do ticket ${ticketId}`);
    return errors;
}

function eventId(ticketId, acId, type, role, key) {
    return `${ticketId}:${acId}:${type}:${role}:${key}`;
}

// Chave determinística quando a evidência não tem um identificador natural único.
function digestKey(value) {
    return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 16);
}

// ── Leitura / escrita ─────────────────────────────────────────────────────────

function emptyLog(ticketId) {
    return { version: LOG_VERSION, ticket_id: String(ticketId), events: [] };
}

/** Log do ticket. Ausente = vazio. JSON inválido → {error} (nunca vira vazio: um append em cima apagaria a história). */
function readLog(ticketId, opts = {}) {
    const file = logPath(ticketId, opts);
    let raw;
    try { raw = fs.readFileSync(file, 'utf8'); } catch { return { data: emptyLog(ticketId), file, exists: false }; }
    try {
        const data = JSON.parse(raw);
        if (!data || typeof data !== 'object' || !Array.isArray(data.events)) return { error: `${file}: sem "events[]"`, file };
        return { data, file, exists: true };
    } catch (e) {
        return { error: `${file}: JSON inválido (${e.message})`, file };
    }
}

function sleepSync(ms) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function withLock(file, fn) {
    const lock = `${file}.lock`;
    for (let i = 0; i < LOCK_ATTEMPTS; i++) {
        try {
            fs.closeSync(fs.openSync(lock, 'wx'));
            try { return fn(); } finally { try { fs.unlinkSync(lock); } catch { /* já saiu */ } }
        } catch (e) {
            if (e.code !== 'EEXIST') throw e;
            try { if (Date.now() - fs.statSync(lock).mtimeMs > LOCK_STALE_MS) fs.unlinkSync(lock); } catch { /* sumiu */ }
            sleepSync(LOCK_WAIT_MS);
        }
    }
    throw new Error(`ac-provenance: lock ocupado (${lock})`);
}

function writeAtomic(file, data) {
    const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`);
    const fd = fs.openSync(tmp, 'w');
    try {
        fs.writeSync(fd, JSON.stringify(data, null, 2) + '\n');
        fs.fsyncSync(fd);
    } finally {
        fs.closeSync(fd);
    }
    fs.renameSync(tmp, file);
}

/**
 * Append de eventos ao log do ticket. Tudo ou nada: qualquer evento inválido → nada é
 * gravado. event_id já presente → pulado (idempotente). Eventos anteriores nunca mudam.
 * @param {Array<{ac_id, type, role, key, reference}>} events
 * @returns {{ok: boolean, added: string[], skipped: string[], errors: string[], file?: string}}
 */
function appendEvents(ticketId, events, { root, specDir, now = new Date().toISOString() } = {}) {
    const ticket = String(ticketId ?? '');
    if (!TICKET_RE.test(ticket)) return { ok: false, added: [], skipped: [], errors: [`ticket inválido: ${JSON.stringify(ticketId)}`] };
    const list = Array.isArray(events) ? events : [];
    const errors = list.flatMap((ev, i) => validateEvent(ev, ticket).map(m => `events[${i}]: ${m}`));
    if (errors.length) return { ok: false, added: [], skipped: [], errors };
    if (!list.length) return { ok: true, added: [], skipped: [], errors: [] };
    const file = logPath(ticket, { root, specDir });
    fs.mkdirSync(path.dirname(file), { recursive: true });
    return withLock(file, () => {
        const read = readLog(ticket, { root, specDir });
        if (read.error) return { ok: false, added: [], skipped: [], errors: [`${read.error} — log não reescrito`], file };
        const data = read.data;
        const seen = new Set(data.events.map(e => e.event_id));
        const added = [];
        const skipped = [];
        for (const ev of list) {
            const id = eventId(ticket, ev.ac_id, ev.type, ev.role, ev.key);
            if (seen.has(id)) { skipped.push(id); continue; }
            seen.add(id);
            data.events.push({ event_id: id, ac_id: ev.ac_id, type: ev.type, role: ev.role, recorded_at: now, reference: ev.reference });
            added.push(id);
        }
        if (added.length) writeAtomic(file, { version: data.version || LOG_VERSION, ticket_id: ticket, events: data.events });
        return { ok: true, added, skipped, errors: [], file };
    });
}

// Evento como sai para consumidores (sem ac_id, que é a chave de quem pergunta).
function sourceView(e) {
    return { event_id: e.event_id, type: e.type, role: e.role, recorded_at: e.recorded_at, reference: e.reference };
}

/** sources[] de um AC, na ordem em que foram registrados. */
function sourcesFor(data, acId) {
    return (data?.events || []).filter(e => e.ac_id === acId).map(sourceView);
}

/** Projeção { "AC-01": sources[] } — o que o Registry guarda em ac_sources. */
function projection(data) {
    const out = {};
    for (const e of data?.events || []) (out[e.ac_id] ||= []).push(sourceView(e));
    return out;
}

/** Projeção do log do ticket; log ilegível → {} com error (quem chama decide se avisa). */
function projectionFor(ticketId, opts = {}) {
    const read = readLog(ticketId, opts);
    if (read.error) return { sources: {}, error: read.error };
    return { sources: projection(read.data) };
}

/** Tickets com log no diretório de specs. */
function listTickets(opts = {}) {
    const dir = specDirOf(opts);
    try {
        return fs.readdirSync(dir).map(f => /^(\d+)-ac-provenance\.json$/.exec(f)).filter(Boolean).map(m => m[1]);
    } catch { return []; }
}

// ── Construtores de evento (um por ponto de captura) ─────────────────────────

const uniqAcs = ids => [...new Set((ids || []).filter(id => AC_ID_RE.test(id)))];
const compact = obj => Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined));

/** spec-generator: critérios da subseção "Critérios de Aceite" da descrição viraram AC-NN. */
function descriptionOriginEvents(ticketId, acIds, { specPath = null, generatedAt = null } = {}) {
    return uniqAcs(acIds).map(ac => ({
        ac_id: ac, type: 'REDMINE_DESCRIPTION', role: 'ORIGIN', key: 'spec-generator',
        reference: compact({ ticket_id: String(ticketId), via: 'spec-generator', spec_path: specPath, generated_at: generatedAt }),
    }));
}

/**
 * Critério gerado por agente e aprovado por humano. Autoria = AGENT, autoridade =
 * HUMAN_APPROVED: nunca HUMAN_AUTHORED. `via` diz qual mecanismo (spec-repairer no
 * portão de spec; spec-generator quando a IA preencheu lacuna do rascunho).
 */
function agentDraftEvents(ticketId, acIds, { via, draftCommentId = null, approvalJournalId = null, approvedBy = null, approvedAt = null, mergedSections, specPath = null, approval = null } = {}) {
    const key = draftCommentId != null ? `draft-${draftCommentId}` : `${via}-${approvedAt || 'sem-data'}`;
    return uniqAcs(acIds).map(ac => ({
        ac_id: ac, type: 'AGENT_DRAFT_APPROVED', role: 'ORIGIN', key,
        reference: compact({
            ticket_id: String(ticketId), via, authorship: 'AGENT', authority: 'HUMAN_APPROVED',
            draft_comment_id: draftCommentId, approval_journal_id: approvalJournalId,
            approved_by: approvedBy, approved_at: approvedAt, approval: approval || undefined,
            merged_sections: Array.isArray(mergedSections) ? mergedSections : undefined, spec_path: specPath,
        }),
    }));
}

/**
 * Confere human_input_refs[] da proposta contra state.human_input_interpretations[]:
 * válido = message_hash existe lá (e, se `at` veio, bate também). Texto livre nunca vale.
 */
function validateHumanInputRefs(refs, interpretations) {
    const entries = Array.isArray(interpretations) ? interpretations : [];
    const valid = [];
    const invalid = [];
    for (const ref of Array.isArray(refs) ? refs : []) {
        const hash = ref && typeof ref === 'object' ? ref.message_hash : null;
        const match = typeof hash === 'string' && hash
            ? entries.find(e => e && e.message_hash === hash && (ref.at == null || e.at === ref.at))
            : null;
        if (match) {
            if (!valid.some(v => v.message_hash === hash)) valid.push({ message_hash: hash, at: match.at ?? null, node: match.node ?? match.from_node ?? null });
        } else {
            invalid.push(ref);
        }
    }
    return { valid, invalid };
}

/**
 * SPEC_CHANGE aprovada: HUMAN_CLARIFICATION/CLARIFICATION (só com human_input_refs
 * válidos) e depois SPEC_CHANGE/MODIFICATION para cada AC tocado.
 * @param {Array<{ac: string, action: string, replaces?: string, replaced_by?: string}>} touched
 */
function specChangeEvents(ticketId, touched, ref, humanInputRefs = []) {
    const out = [];
    const acs = (touched || []).filter(t => AC_ID_RE.test(t?.ac || ''));
    for (const h of humanInputRefs) {
        for (const t of acs) {
            out.push({
                ac_id: t.ac, type: 'HUMAN_CLARIFICATION', role: 'CLARIFICATION', key: h.message_hash,
                reference: compact({ message_hash: h.message_hash, at: h.at, node: h.node, task_id: ref.task_id, change_id: ref.change_id }),
            });
        }
    }
    for (const t of acs) {
        out.push({
            ac_id: t.ac, type: 'SPEC_CHANGE', role: 'MODIFICATION', key: ref.change_id,
            reference: compact({
                change_id: ref.change_id, approval_ref: ref.approval_ref,
                proposal_comment_id: ref.proposal_comment_id ?? null, approval_journal_id: ref.approval_journal_id ?? null,
                spec_hash_before: ref.spec_hash_before ?? null, spec_hash_after: ref.spec_hash_after ?? null,
                previous_version: ref.previous_version ?? null, new_version: ref.new_version ?? null,
                action: t.action, replaces: t.replaces, replaced_by: t.replaced_by, task_id: ref.task_id,
            }),
        });
    }
    return out;
}

/** /plan baseline: AC da spec sem NENHUM evento → UNKNOWN/ORIGIN (nunca HUMAN_AUTHORED por ausência). */
function baselineUnknownEvents(ticketId, acIds, data, { specHash = null, specVersion = null, sealedAt = null, specPath = null } = {}) {
    const known = new Set((data?.events || []).map(e => e.ac_id));
    return uniqAcs(acIds).filter(ac => !known.has(ac)).map(ac => ({
        ac_id: ac, type: 'UNKNOWN', role: 'ORIGIN', key: `baseline-${String(specHash || 'sem-hash').slice(0, 16)}`,
        reference: compact({ reason: 'no-demonstrable-provenance', captured_by: 'plan-baseline', spec_hash: specHash, spec_version: specVersion, sealed_at: sealedAt, spec_path: specPath }),
    }));
}

/** ac-ids number --write: só atribuiu ID a texto legado — não é origem. */
function legacyNumberingEvents(ticketId, acIds) {
    return uniqAcs(acIds).map(ac => ({ ac_id: ac, type: 'UNKNOWN', role: 'ORIGIN', key: LEGACY_NUMBERING_REF, reference: LEGACY_NUMBERING_REF }));
}

/** Declaração explícita (CLI). Chave natural = --key, senão o identificador da referência, senão digest dela. */
function declaredEvent(acId, { type, role, reference, key = null }) {
    const ref = reference && typeof reference === 'object' && !Array.isArray(reference) ? { ...reference, declared: true } : reference;
    const natural = key || (ref && typeof ref === 'object'
        ? ['journal_id', 'attachment_id', 'field_id', 'message_hash', 'change_id'].map(k => ref[k]).find(v => v != null)
        : null);
    return { ac_id: acId, type, role, key: natural != null ? String(natural) : `declared-${digestKey(ref)}`, reference: ref };
}

module.exports = {
    SOURCE_TYPES, SOURCE_ROLES, LOG_VERSION, LEGACY_NUMBERING_REF,
    provenanceRoot, logPath, ticketOf, readLog, appendEvents, sourcesFor, projection, projectionFor, listTickets,
    validateReference, validateEvent, eventId,
    descriptionOriginEvents, agentDraftEvents, validateHumanInputRefs, specChangeEvents,
    baselineUnknownEvents, legacyNumberingEvents, declaredEvent,
};

if (require.main === module) {
    const args = process.argv.slice(2);
    const [cmd, ticket, acArg] = args.filter(a => !a.startsWith('--'));
    const flag = name => { const a = args.find(x => x.startsWith(`--${name}=`)); return a ? a.slice(name.length + 3) : null; };
    const opts = flag('root') ? { root: flag('root') } : {};
    const usage = () => {
        console.error('Uso: node scripts/lib/ac-provenance.js show <ticket> [AC-NN] [--root=<checkout>]\n' +
            "     node scripts/lib/ac-provenance.js declare <ticket> <AC-NN> --type=<TYPE> --role=<ROLE> --ref='<json>' [--key=<chave>] [--root=<checkout>]\n" +
            `     TYPE: ${SOURCE_TYPES.join(' | ')}\n     ROLE: ${SOURCE_ROLES.join(' | ')}`);
        process.exit(2);
    };
    if (!ticket || !TICKET_RE.test(ticket)) usage();
    if (cmd === 'show') {
        const read = readLog(ticket, opts);
        if (read.error) { console.error(read.error); process.exit(1); }
        const out = acArg ? { ticket_id: ticket, ac_id: acArg, sources: sourcesFor(read.data, acArg) } : { ticket_id: ticket, ac_sources: projection(read.data) };
        console.log(JSON.stringify(out, null, 2));
        process.exit(0);
    }
    if (cmd === 'declare') {
        if (!acArg) usage();
        let reference;
        try { reference = JSON.parse(flag('ref') || 'null'); } catch (e) { console.error(`--ref não é JSON: ${e.message}`); process.exit(2); }
        const ev = declaredEvent(acArg, { type: flag('type'), role: flag('role'), reference, key: flag('key') });
        const out = appendEvents(ticket, [ev], opts);
        if (!out.ok) { console.error(out.errors.join('\n')); process.exit(1); }
        console.log(out.added.length ? `registrado: ${out.added[0]} → ${out.file}` : `já registrado (no-op): ${out.skipped[0]}`);
        process.exit(0);
    }
    usage();
}
