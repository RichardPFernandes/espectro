// node --test scripts/lib/ac-provenance-capture.test.js
// Pontos de captura de provenance de AC (docs/ac-provenance.md), cada um exercitado pelo
// caminho real: watcher (runSpecDraftGate, runTicketSpecGate com withSpecReplies e
// auto-repair) com REPO_PATH sintético, Redmine falso com journals numerados e `claude`
// falso; spec-change.js (aprovação/rejeição, human_input_refs); spec-authority baseline (CLI).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const prov = require('./ac-provenance');
const sc = require('./spec-change');
const sa = require('./spec-authority');

const TMP_ROOT = process.env.CLAUDE_JOB_DIR ? path.join(process.env.CLAUDE_JOB_DIR, 'tmp') : os.tmpdir();
const tmp = fs.mkdtempSync(path.join(TMP_ROOT, 'ac-prov-capture-'));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const repo = path.join(tmp, 'app-back');
const binDir = path.join(tmp, 'bin');
fs.mkdirSync(path.join(repo, 'memory', 'spec'), { recursive: true });
fs.mkdirSync(path.join(repo, 'memory', 'runs'), { recursive: true });
fs.mkdirSync(binDir);
// Nenhum agente é despachado nestes testes: `claude` no PATH só registra a chamada.
fs.writeFileSync(path.join(binDir, 'claude'), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${path.join(tmp, 'claude-calls.log')}'\n`, { mode: 0o755 });
process.env.REPO_PATH = repo;
process.env.SKIP_PRE_BUILD_VALIDATION = 'true';
process.env.REDMINE_URL = 'http://redmine.test';
process.env.REDMINE_API_KEY = 'chave-redmine-que-nao-vaza';
process.env.PATH = `${binDir}:${process.env.PATH}`;
delete process.env.SPEC_DRAFT_AUTOGEN;
delete process.env.SPEC_AUTO_REPAIR;
delete process.env.SPEC_APPROVAL_KEYWORD;
delete process.env.AC_PROVENANCE_ROOT;

const FILLER = 'Texto descritivo suficiente para passar do limite mínimo de caracteres exigido pela validação. ';
const AC1 = 'Salvar a ordem não zera o frete da DT';
const AC2 = 'Recalcular a ordem mantém o frete da DT';

// Redmine falso: issues (campos do ticket) + journals numerados; PUT vira journal.
const issues = {};
const journals = {};
let nextJournalId = 5000;
function addJournal(id, notes, user = 'Richard', createdOn = new Date().toISOString()) {
    const j = { id: nextJournalId++, notes, user: { name: user }, created_on: createdOn };
    (journals[id] = journals[id] || []).push(j);
    return j;
}
global.fetch = async (url, opts = {}) => {
    const id = Number((/issues\/(\d+)\.json/.exec(url) || [])[1]);
    if (opts.method === 'PUT') {
        const body = JSON.parse(opts.body);
        if (body.issue?.notes) addJournal(id, body.issue.notes, 'Watcher');
        return { ok: true, status: 204, json: async () => ({}) };
    }
    return { ok: true, status: 200, json: async () => ({ issue: { id, ...(issues[id] || {}), journals: journals[id] || [] } }) };
};

const watcher = require('../readmine-watcher');

function ticket(issue) {
    issues[issue.id] = issue;
    return {
        ...issue, status: { name: 'Aprovada' }, tracker: { name: 'Melhoria' },
        custom_fields: [{ name: 'Branch Liberação', value: 'Dev - Local' }], updated_on: new Date().toISOString(),
    };
}
function fakeClaude(name, output) {
    const bin = path.join(binDir, name);
    fs.writeFileSync(bin, `#!/bin/sh\ncat > /dev/null\ncat <<'OUT'\n${output}\nOUT\n`, { mode: 0o755 });
    return bin;
}
async function withRepairBin(bin, fn) {
    const saved = process.env.SPEC_REPAIR_CLAUDE_BIN;
    process.env.SPEC_REPAIR_CLAUDE_BIN = bin;
    try { return await fn(); } finally {
        if (saved === undefined) delete process.env.SPEC_REPAIR_CLAUDE_BIN; else process.env.SPEC_REPAIR_CLAUDE_BIN = saved;
    }
}
const logOf = t => prov.readLog(String(t), { root: repo });
const logExists = t => fs.existsSync(prov.logPath(String(t), { root: repo }));
const sourcesOf = (t, ac) => prov.sourcesFor(logOf(t).data, ac);
const specFile = id => path.join(repo, 'memory', 'spec', `${id}-spec.md`);

// ── runSpecDraftGate / spec-generator ────────────────────────────────────────

test('runSpecDraftGate: critérios da descrição viram AC-NN → REDMINE_DESCRIPTION/ORIGIN, sem texto', async () => {
    const t = ticket({
        id: 94001, subject: 'Pedido não recalcula frete', estimated_hours: 4, assigned_to: { id: 1, name: 'Richard Fernandes' },
        description: `${FILLER}\n\n### Solução esperada\n${FILLER}\n\n### Critérios de aceite\n- ${AC1}\n- ${AC2}`,
    });
    assert.strictEqual((await watcher.runSpecDraftGate(t)).reason, 'spec_draft_gerado');
    assert.match(fs.readFileSync(specFile(94001), 'utf8'), /- AC-01: Salvar a ordem/);
    for (const ac of ['AC-01', 'AC-02']) {
        const [ev, ...rest] = sourcesOf(94001, ac);
        assert.strictEqual(rest.length, 0);
        assert.strictEqual(ev.type, 'REDMINE_DESCRIPTION');
        assert.strictEqual(ev.role, 'ORIGIN');
        assert.deepStrictEqual(Object.keys(ev.reference).sort(), ['generated_at', 'spec_path', 'ticket_id', 'via']);
        assert.strictEqual(ev.reference.ticket_id, '94001');
    }
    const raw = fs.readFileSync(prov.logPath('94001', { root: repo }), 'utf8');
    assert.doesNotMatch(raw, /Salvar a ordem|Recalcular a ordem/, 'texto do AC não vai pro log');
    assert.deepStrictEqual(watcher.readSpecGate(94001).spec_draft_ac_ids.description, ['AC-01', 'AC-02']);
    assert.deepStrictEqual(watcher.readSpecGate(94001).spec_draft_ac_ids.agent, []);
    // Tick seguinte não duplica.
    await watcher.runSpecDraftGate(t);
    assert.strictEqual(logOf(94001).data.events.length, 2);
});

test('runSpecDraftGate: AC sugerido pela IA no rascunho só ganha provenance na liberação — AGENT_DRAFT_APPROVED, nunca HUMAN_AUTHORED', async () => {
    const bin = fakeClaude('claude-sugere', `## Solução\n\n${FILLER}\n\n## Critérios de Aceite\n\n- AC-01: ${AC1}\n- AC-02: ${AC2}`);
    const t = ticket({ id: 94002, subject: 'Frete zerado', description: `${FILLER} Ao salvar a Ordem de Carga o frete da DT filha é zerado.` });
    assert.strictEqual((await withRepairBin(bin, () => watcher.runSpecDraftGate(t))).reason, 'spec_draft_gerado');
    assert.deepStrictEqual(watcher.readSpecGate(94002).spec_draft_ac_ids.agent, ['AC-01', 'AC-02']);
    assert.ok(!logExists(94002), 'gerado pela IA mas ainda não aprovado: nenhum evento');

    const draftNote = journals[94002].find(j => j.user.name === 'Watcher');
    assert.ok(draftNote, 'comentário do rascunho postado');
    const approval = addJournal(94002, 'aprovado', 'Richard Fernandes', '2026-10-01T12:00:00Z');
    assert.deepStrictEqual(await watcher.runSpecDraftGate(t), { block: false });
    for (const ac of ['AC-01', 'AC-02']) {
        const [ev] = sourcesOf(94002, ac);
        assert.strictEqual(ev.type, 'AGENT_DRAFT_APPROVED');
        assert.strictEqual(ev.role, 'ORIGIN');
        assert.strictEqual(ev.reference.authorship, 'AGENT');
        assert.strictEqual(ev.reference.authority, 'HUMAN_APPROVED');
        assert.strictEqual(ev.reference.approval, 'redmine');
        assert.strictEqual(ev.reference.approval_journal_id, approval.id);
        assert.match(ev.reference.approved_by, /^Richard Fernandes \(Redmine/);
    }
    assert.ok(logOf(94002).data.events.every(e => e.type !== 'HUMAN_AUTHORED'));
    await watcher.runSpecDraftGate(t);
    assert.strictEqual(logOf(94002).data.events.length, 2, 'idempotente');
});

test('runSpecDraftGate: rascunho liberado à mão (draft: false) → approval manual-draft-release, sem autor inventado', async () => {
    const bin = fakeClaude('claude-sugere-2', `## Solução\n\n${FILLER}\n\n## Critérios de Aceite\n\n- AC-01: ${AC1}`);
    const t = ticket({ id: 94003, subject: 'Frete zerado 2', description: `${FILLER} Frete da DT zerado ao salvar.` });
    await withRepairBin(bin, () => watcher.runSpecDraftGate(t));
    fs.writeFileSync(specFile(94003), fs.readFileSync(specFile(94003), 'utf8').replace('draft: true', 'draft: false'));
    assert.deepStrictEqual(await watcher.runSpecDraftGate(t), { block: false });
    const [ev] = sourcesOf(94003, 'AC-01');
    assert.strictEqual(ev.type, 'AGENT_DRAFT_APPROVED');
    assert.strictEqual(ev.reference.approval, 'manual-draft-release');
    assert.strictEqual(ev.reference.approved_by, null);
    assert.strictEqual(ev.reference.approval_journal_id, null);
});

// ── withSpecReplies (EC-2) ────────────────────────────────────────────────────

test('withSpecReplies: comentário que completa a spec → completed_by_journal_ids no gate e NENHUM evento por AC', async () => {
    const id = 94010;
    const t = ticket({ id, subject: 'Spec por comentário', description: 'curta demais' });
    addJournal(id, `${'[Watcher] Spec do ticket'} #${id} incompleta — complete a descrição.`, 'Watcher');
    const reply = addJournal(id, `## Problema\n${FILLER}\n\n## Solução\n${FILLER}\n\n## Critérios de Aceite\n- AC-01: ${AC1}\n- AC-02: ${AC2}\n`, 'QA');
    const r = await watcher.runTicketSpecGate(t);
    assert.strictEqual(r.proceed, true, JSON.stringify(r.result?.errors));
    assert.ok(r.completedBy);
    const gate = watcher.readSpecGate(id);
    assert.deepStrictEqual(gate.completed_by_journal_ids, [reply.id], 'evidência no nível do portão');
    assert.ok(!logExists(id), 'journal → AC não é demonstrável: nenhum REDMINE_COMMENT por AC');
});

// ── handleSpecRepair / spec-repairer ─────────────────────────────────────────

test('handleSpecRepair: ACs do draft aprovado → AGENT_DRAFT_APPROVED/ORIGIN com draft_comment_id e approval_journal_id', async () => {
    const id = 94020;
    const bin = fakeClaude('claude-repair', `## Critérios de Aceite\n\n- AC-01: ${AC1}\n- AC-02: ${AC2}`);
    const t = ticket({ id, subject: 'Sem critérios', description: `## Problema\n${FILLER}\n\n## Solução\n${FILLER}\n` });
    const first = await withRepairBin(bin, () => watcher.runTicketSpecGate(t));
    assert.strictEqual(first.proceed, false);
    const pending = watcher.readSpecGate(id).spec_pending_approval;
    assert.ok(Number.isInteger(pending.comment_id));
    assert.ok(!logExists(id), 'antes da aprovação, nada');

    const approval = addJournal(id, 'aprovado', 'Richard Fernandes', new Date(Date.now() + 1000).toISOString());
    const r = await withRepairBin(bin, () => watcher.runTicketSpecGate(t));
    assert.strictEqual(r.proceed, true);
    for (const ac of ['AC-01', 'AC-02']) {
        const [ev, ...rest] = sourcesOf(id, ac);
        assert.strictEqual(rest.length, 0);
        assert.strictEqual(ev.type, 'AGENT_DRAFT_APPROVED');
        assert.strictEqual(ev.role, 'ORIGIN');
        assert.strictEqual(ev.reference.via, 'spec-repairer');
        assert.strictEqual(ev.reference.draft_comment_id, pending.comment_id);
        assert.strictEqual(ev.reference.approval_journal_id, approval.id);
        assert.notStrictEqual(ev.reference.draft_comment_id, ev.reference.approval_journal_id);
        assert.ok(ev.reference.merged_sections.includes('criterios_aceite'));
    }
    const raw = fs.readFileSync(prov.logPath(String(id), { root: repo }), 'utf8');
    assert.doesNotMatch(raw, /Salvar a ordem|chave-redmine-que-nao-vaza/);
});

// ── approveSpecChange / rejectSpecChange (EC-3, EC-4) ───────────────────────

const SPEC = `# Spec 94100

## Problema
${FILLER}

## Solução
${FILLER}

## Critérios de Aceite
- AC-01: ${AC1}.
- AC-02: ${AC2}.
`;
const HASH_A = 'a1b2c3d4e5f60718';
const HASH_B = 'ffffeeee00001111';
let seq = 0;
function seedRun(stateOver = {}) {
    const root = path.join(tmp, `run-repo-${++seq}`);
    const taskId = `94100-frete-${seq}`;
    const dir = path.join(root, 'memory', 'runs', taskId);
    fs.mkdirSync(dir, { recursive: true });
    fs.mkdirSync(path.join(root, 'memory', 'spec'), { recursive: true });
    fs.writeFileSync(path.join(root, 'memory', 'spec', '94100-spec.md'), SPEC);
    fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({
        task_id: taskId, node: 'implement', history: ['fetch_ticket', 'plan'], status: 'in_progress',
        started_at: '2026-10-01T10:00:00.000Z', redmine_ticket: { id: 94100 },
        spec_path: 'memory/spec/94100-spec.md', spec_hash: sa.specHash(SPEC),
        human_input_interpretations: [
            { at: '2026-10-01T09:00:00.000Z', message_hash: HASH_A, from_node: 'implement', node: 'implement', intent: 'resume', action: 'resume' },
            { at: '2026-10-01T09:30:00.000Z', message_hash: HASH_B, from_node: 'implement', node: 'implement', intent: 'resume', action: 'resume' },
        ],
        ...stateOver,
    }, null, 2));
    fs.writeFileSync(path.join(dir, 'handoff.md'), '# Handoff\n');
    fs.writeFileSync(path.join(dir, 'plan.md'), '# Plano\n');
    return { root, taskId, dir };
}
const runLog = root => prov.readLog('94100', { root }).data;
function propose(dir, extra = {}) {
    const out = sc.recordDecision(dir, {
        type: 'SPEC_CHANGE', description: 'Validar produtos do JSON contra o XML',
        rationale: 'Pedido explícito do solicitante via human input (2026-10-01T09:00) — citado só em texto',
        ac_changes: [{ action: 'add', text: 'Produtos divergentes do XML retornam 400' }], ...extra,
    }, { now: '2026-10-01T11:00:00.000Z' });
    assert.deepStrictEqual(out.errors, []);
    // Watcher publica a proposta no Redmine: comment_id = journal da PROPOSTA.
    const state = JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'));
    state.spec_change_pending.comment_id = 45411;
    fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify(state, null, 2));
    return out.decision;
}

test('T6/T5. rationale citando human input SEM human_input_refs → só SPEC_CHANGE/MODIFICATION; ORIGIN anterior preservado', () => {
    const { root, dir } = seedRun();
    prov.appendEvents('94100', prov.descriptionOriginEvents('94100', ['AC-01']), { root });
    propose(dir, { ac_affected: ['AC-01'] });
    const out = sc.approveSpecChange(dir, { by: 'Ana (Redmine, 2026-10-01T11:20:38Z)', at: '2026-10-01T11:21:49.000Z', approvalJournalId: 45412 });
    assert.ok(out.ok, out.error);
    assert.deepStrictEqual(out.added, ['AC-03']);
    const log = runLog(root);
    assert.ok(log.events.every(e => e.type !== 'HUMAN_CLARIFICATION'), 'texto livre não vira vínculo');
    assert.deepStrictEqual(prov.sourcesFor(log, 'AC-01').map(s => [s.type, s.role]), [['REDMINE_DESCRIPTION', 'ORIGIN'], ['SPEC_CHANGE', 'MODIFICATION']]);
    const [added] = prov.sourcesFor(log, 'AC-03');
    assert.strictEqual(added.type, 'SPEC_CHANGE');
    assert.strictEqual(added.reference.action, 'add');
    assert.strictEqual(added.reference.change_id, 'SC-001');
    assert.match(added.reference.approval_ref, /^spec-change-audit\.json#entry-\d+$/);
    // EC-4: separados, nunca um no lugar do outro.
    assert.strictEqual(added.reference.proposal_comment_id, 45411);
    assert.strictEqual(added.reference.approval_journal_id, 45412);
    const audit = sc.readAudit(dir).entries.find(e => e.event === 'approved');
    assert.strictEqual(audit.proposal_comment_id, 45411);
    assert.strictEqual(audit.approval_journal_id, 45412);
});

test('T7. human_input_refs válido → HUMAN_CLARIFICATION/CLARIFICATION antes de SPEC_CHANGE/MODIFICATION', () => {
    const { root, dir } = seedRun();
    const d = propose(dir, { human_input_refs: [{ message_hash: HASH_A, at: '2026-10-01T09:00:00.000Z' }] });
    assert.deepStrictEqual(d.human_input_refs, [{ message_hash: HASH_A, at: '2026-10-01T09:00:00.000Z' }]);
    assert.ok(sc.approveSpecChange(dir, { by: 'Ana', at: '2026-10-01T12:00:00.000Z', approvalJournalId: 50001 }).ok);
    const sources = prov.sourcesFor(runLog(root), 'AC-03');
    assert.deepStrictEqual(sources.map(s => [s.type, s.role]), [['HUMAN_CLARIFICATION', 'CLARIFICATION'], ['SPEC_CHANGE', 'MODIFICATION']]);
    assert.deepStrictEqual(sources[0].reference, { message_hash: HASH_A, at: '2026-10-01T09:00:00.000Z', node: 'implement', task_id: sources[1].reference.task_id, change_id: 'SC-001' });
    assert.strictEqual(sources[0].event_id, `94100:AC-03:HUMAN_CLARIFICATION:CLARIFICATION:${HASH_A}`);
});

test('T8. human_input_refs inexistente/inválido não cria provenance falsa (SPEC_CHANGE segue registrada)', () => {
    const { root, dir } = seedRun();
    propose(dir, { human_input_refs: [{ message_hash: 'naoexiste00000000' }, { message_hash: HASH_B, at: '2020-01-01T00:00:00.000Z' }, { message_hash: '<script>' }] });
    const out = sc.approveSpecChange(dir, { by: 'Ana', at: '2026-10-01T12:00:00.000Z' });
    assert.ok(out.ok);
    assert.strictEqual(out.provenance.human_input_refs_invalid.length, 2, '<script> nem entra na proposta');
    const log = runLog(root);
    assert.ok(log.events.every(e => e.type !== 'HUMAN_CLARIFICATION'));
    assert.deepStrictEqual(prov.sourcesFor(log, 'AC-03').map(s => s.type), ['SPEC_CHANGE']);
    // T10: sem journal da aprovação → null, não reconstruído.
    assert.strictEqual(prov.sourcesFor(log, 'AC-03')[0].reference.approval_journal_id, null);
});

test('T6 (rejeição). SPEC_CHANGE rejeitada não altera sources[]', () => {
    const { root, dir } = seedRun();
    prov.appendEvents('94100', prov.descriptionOriginEvents('94100', ['AC-01']), { root });
    const before = JSON.stringify(runLog(root));
    propose(dir, { ac_affected: ['AC-01'], human_input_refs: [{ message_hash: HASH_A }] });
    assert.ok(sc.rejectSpecChange(dir, { by: 'Ana', reason: 'não' }).ok);
    assert.strictEqual(JSON.stringify(runLog(root)), before);
});

test('replace: AC antigo e substituto recebem MODIFICATION com replaced_by/replaces', () => {
    const { root, dir } = seedRun();
    propose(dir, { ac_changes: [{ action: 'replace', ac: 'AC-02', text: 'Recalcular mantém o frete e loga a origem' }] });
    assert.ok(sc.approveSpecChange(dir, { by: 'Ana', at: '2026-10-01T12:00:00.000Z' }).ok);
    const log = runLog(root);
    assert.deepStrictEqual(prov.sourcesFor(log, 'AC-02')[0].reference.replaced_by, 'AC-03');
    assert.deepStrictEqual(prov.sourcesFor(log, 'AC-03')[0].reference.replaces, 'AC-02');
    assert.strictEqual(prov.sourcesFor(log, 'AC-03')[0].reference.action, 'replace');
});

test('human-input sem SPEC_CHANGE: interpretações no state não geram nenhum evento de provenance', () => {
    const { root, dir } = seedRun();
    // Decisão técnica (não SPEC_CHANGE) com o human input no state: nada de provenance.
    const out = sc.recordDecision(dir, { type: 'TECHNICAL_DECISION', description: 'Usar helper existente', rationale: 'mesmo comportamento observável; dev pediu via human input', ac_affected: ['AC-01'] });
    assert.deepStrictEqual(out.errors, []);
    assert.ok(!fs.existsSync(prov.logPath('94100', { root })), 'nenhum log criado');
});

// ── /plan baseline (spec-authority CLI) ──────────────────────────────────────

test('T11. baseline: AC sem provenance → UNKNOWN/ORIGIN (nunca HUMAN_AUTHORED); AC com ORIGIN não é tocado; rerun não duplica', () => {
    const { root, dir } = seedRun({ spec_hash: undefined, node: 'plan' });
    prov.appendEvents('94100', prov.descriptionOriginEvents('94100', ['AC-01']), { root });
    const cli = path.join(__dirname, 'spec-authority.js');
    const r1 = spawnSync(process.execPath, [cli, 'baseline', dir], { encoding: 'utf8', env: { ...process.env, AC_PROVENANCE_ROOT: '' } });
    assert.strictEqual(r1.status, 0, r1.stderr);
    assert.match(r1.stdout, /\[ac-provenance\] 1 AC/);
    const log = runLog(root);
    assert.deepStrictEqual(prov.sourcesFor(log, 'AC-01').map(s => s.type), ['REDMINE_DESCRIPTION']);
    const [unknown] = prov.sourcesFor(log, 'AC-02');
    assert.strictEqual(unknown.type, 'UNKNOWN');
    assert.strictEqual(unknown.role, 'ORIGIN');
    assert.strictEqual(unknown.reference.reason, 'no-demonstrable-provenance');
    assert.strictEqual(unknown.reference.spec_hash, JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8')).spec_hash);
    assert.ok(log.events.every(e => e.type !== 'HUMAN_AUTHORED'));
    const r2 = spawnSync(process.execPath, [cli, 'baseline', dir], { encoding: 'utf8', env: { ...process.env, AC_PROVENANCE_ROOT: '' } });
    assert.strictEqual(r2.status, 0, r2.stderr);
    assert.strictEqual(runLog(root).events.length, 2, 'rerun não duplica');
});

test('baseline em run dry-run não grava provenance', () => {
    const { root, dir } = seedRun({ dry_run: true, node: 'plan' });
    const state = JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'));
    assert.strictEqual(sa.recordBaselineProvenance(state, { root, taskId: state.task_id, specPath: 'memory/spec/94100-spec.md' }), null);
    assert.ok(!fs.existsSync(prov.logPath('94100', { root })));
});
