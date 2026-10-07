// node --test scripts/lib/ac-provenance.test.js
// Provenance de AC: modelo (identidade ticket+AC, sources[] append-only, roles, UNKNOWN,
// idempotência, nada de texto), log como fonte de verdade e Registry como projeção
// (rebuild/corrupção não perdem provenance), compatibilidade (criteria[] legado,
// getRelatedACs, plan-scorer) e CLIs (declare, ac-ids number). Pontos de captura no
// watcher/spec-change/baseline: ac-provenance-capture.test.js. API: dashboard/provenance-api.test.js.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const prov = require('./ac-provenance');
const acRegistry = require('./ac-registry');
const { rebuild } = require('../rebuild-ac-registry');

const TMP_ROOT = process.env.CLAUDE_JOB_DIR ? path.join(process.env.CLAUDE_JOB_DIR, 'tmp') : os.tmpdir();
const sandbox = fs.mkdtempSync(path.join(TMP_ROOT, 'ac-provenance-'));
test.after(() => fs.rmSync(sandbox, { recursive: true, force: true }));
let seq = 0;
function freshRoot() {
    const root = path.join(sandbox, `repo-${++seq}`);
    fs.mkdirSync(path.join(root, 'memory', 'spec'), { recursive: true });
    fs.mkdirSync(path.join(root, '.graph'), { recursive: true });
    return root;
}
const readLogFile = (root, t) => JSON.parse(fs.readFileSync(prov.logPath(t, { root }), 'utf8'));

const AC_TEXT = 'Fretes com mais de 10 volumes recebem 5% de desconto';
const SPEC = `# Spec

## Problema
x

## Critérios de Aceite
- AC-01: ${AC_TEXT}.
- AC-02: O relatório exibe o desconto.
`;
const LEGACY_SPEC = '# Spec\n\n## Critérios de Aceite\n- Critério legado sem ID\n- Outro critério legado\n';

const descEv = (t, ac) => prov.descriptionOriginEvents(t, [ac], { specPath: `memory/spec/${t}-spec.md`, generatedAt: '2026-10-01T10:00:00.000Z' });

// ── Modelo ────────────────────────────────────────────────────────────────────

test('1/2. identidade é (ticket, ac_id): dois tickets com AC-01 têm logs e event_ids distintos', () => {
    const root = freshRoot();
    assert.ok(prov.appendEvents('43666', descEv('43666', 'AC-01'), { root }).ok);
    assert.ok(prov.appendEvents('43703', descEv('43703', 'AC-01'), { root }).ok);
    const a = readLogFile(root, '43666').events;
    const b = readLogFile(root, '43703').events;
    assert.strictEqual(a.length, 1);
    assert.strictEqual(b.length, 1);
    assert.notStrictEqual(a[0].event_id, b[0].event_id);
    assert.match(a[0].event_id, /^43666:AC-01:/);
    assert.match(b[0].event_id, /^43703:AC-01:/);
    assert.strictEqual(readLogFile(root, '43666').ticket_id, '43666');
});

test('3/4/5/8. sources[] guarda vários eventos, em ordem; CLARIFICATION e MODIFICATION não apagam ORIGIN', () => {
    const root = freshRoot();
    prov.appendEvents('43800', descEv('43800', 'AC-01'), { root, now: '2026-10-01T10:00:00.000Z' });
    const clar = prov.specChangeEvents('43800', [{ ac: 'AC-01', action: 'affected' }],
        { change_id: 'SC-001', approval_ref: 'spec-change-audit.json#entry-1', task_id: '43800-x' },
        [{ message_hash: 'abc123', at: '2026-10-01T09:00:00.000Z', node: 'implement' }]);
    prov.appendEvents('43800', clar, { root, now: '2026-10-01T11:00:00.000Z' });
    const sources = prov.sourcesFor(readLogFile(root, '43800'), 'AC-01');
    assert.deepStrictEqual(sources.map(s => [s.type, s.role]), [
        ['REDMINE_DESCRIPTION', 'ORIGIN'], ['HUMAN_CLARIFICATION', 'CLARIFICATION'], ['SPEC_CHANGE', 'MODIFICATION'],
    ]);
    assert.deepStrictEqual(sources.map(s => s.recorded_at), ['2026-10-01T10:00:00.000Z', '2026-10-01T11:00:00.000Z', '2026-10-01T11:00:00.000Z']);
    assert.strictEqual(sources[0].reference.ticket_id, '43800', 'ORIGIN preservado intacto');
});

test('6/7. UNKNOWN é aceito; legacy-numbering vira UNKNOWN/ORIGIN com reference "legacy-numbering"', () => {
    const root = freshRoot();
    const out = prov.appendEvents('43801', prov.legacyNumberingEvents('43801', ['AC-01', 'AC-02']), { root });
    assert.ok(out.ok, out.errors.join());
    const ev = readLogFile(root, '43801').events;
    assert.deepStrictEqual(ev.map(e => [e.ac_id, e.type, e.role, e.reference]), [
        ['AC-01', 'UNKNOWN', 'ORIGIN', 'legacy-numbering'], ['AC-02', 'UNKNOWN', 'ORIGIN', 'legacy-numbering'],
    ]);
});

test('8. AGENT_DRAFT_APPROVED não é HUMAN_AUTHORED: autoria AGENT, autoridade HUMAN_APPROVED', () => {
    const [ev] = prov.agentDraftEvents('43585', ['AC-01'], {
        via: 'spec-repairer', draftCommentId: 45000, approvalJournalId: 45010,
        approvedBy: 'Fulano (Redmine, 2026-09-24T18:16:50Z)', approvedAt: '2026-09-24T18:16:50Z', mergedSections: ['criterios_aceite'],
    });
    assert.strictEqual(ev.type, 'AGENT_DRAFT_APPROVED');
    assert.notStrictEqual(ev.type, 'HUMAN_AUTHORED');
    assert.strictEqual(ev.role, 'ORIGIN');
    assert.strictEqual(ev.reference.authorship, 'AGENT');
    assert.strictEqual(ev.reference.authority, 'HUMAN_APPROVED');
    assert.strictEqual(ev.reference.draft_comment_id, 45000);
    assert.strictEqual(ev.reference.approval_journal_id, 45010);
});

test('9. REDMINE_COMMENT declarado preserva journal_id (e vira a chave natural)', () => {
    const root = freshRoot();
    const ev = prov.declaredEvent('AC-02', { type: 'REDMINE_COMMENT', role: 'ORIGIN', reference: { ticket_id: '43584', journal_id: 123 } });
    assert.ok(prov.appendEvents('43584', [ev], { root }).ok);
    const [stored] = readLogFile(root, '43584').events;
    assert.strictEqual(stored.reference.journal_id, 123);
    assert.strictEqual(stored.event_id, '43584:AC-02:REDMINE_COMMENT:ORIGIN:123');
});

test('10. SPEC_CHANGE preserva change_id, approval_ref, proposal_comment_id ≠ approval_journal_id, versões', () => {
    const [ev] = prov.specChangeEvents('43666', [{ ac: 'AC-01', action: 'add' }], {
        change_id: 'SC-001', approval_ref: 'spec-change-audit.json#entry-1', proposal_comment_id: 45411, approval_journal_id: 45412,
        spec_hash_before: 'a'.repeat(64), spec_hash_after: 'b'.repeat(64), previous_version: 1, new_version: 2, task_id: '43666-x',
    });
    assert.deepStrictEqual(ev.reference, {
        change_id: 'SC-001', approval_ref: 'spec-change-audit.json#entry-1', proposal_comment_id: 45411, approval_journal_id: 45412,
        spec_hash_before: 'a'.repeat(64), spec_hash_after: 'b'.repeat(64), previous_version: 1, new_version: 2, action: 'add', task_id: '43666-x',
    });
    // Histórico sem o journal da aprovação: fica null, nunca reconstruído.
    const [old] = prov.specChangeEvents('43666', [{ ac: 'AC-01', action: 'add' }], { change_id: 'SC-001', approval_ref: 'x#entry-1', proposal_comment_id: 45411 });
    assert.strictEqual(old.reference.approval_journal_id, null);
    assert.strictEqual(old.reference.proposal_comment_id, 45411);
});

test('11. append idempotente: o mesmo event_id não duplica e o evento original não muda', () => {
    const root = freshRoot();
    const first = prov.appendEvents('43802', descEv('43802', 'AC-01'), { root, now: '2026-10-01T10:00:00.000Z' });
    const again = prov.appendEvents('43802', descEv('43802', 'AC-01'), { root, now: '2026-10-02T10:00:00.000Z' });
    assert.strictEqual(first.added.length, 1);
    assert.deepStrictEqual(again.added, []);
    assert.deepStrictEqual(again.skipped, first.added);
    const ev = readLogFile(root, '43802').events;
    assert.strictEqual(ev.length, 1);
    assert.strictEqual(ev[0].recorded_at, '2026-10-01T10:00:00.000Z');
});

test('13. recorded_at é o momento do registro, não created_at do AC (nenhum campo created_at)', () => {
    const root = freshRoot();
    prov.appendEvents('43803', prov.legacyNumberingEvents('43803', ['AC-01']), { root, now: '2026-10-01T12:00:00.000Z' });
    const [ev] = readLogFile(root, '43803').events;
    assert.strictEqual(ev.recorded_at, '2026-10-01T12:00:00.000Z');
    assert.ok(!('created_at' in ev));
    assert.ok(!('created_at' in prov.sourcesFor(readLogFile(root, '43803'), 'AC-01')[0]));
});

test('nenhum texto: referência com campo de conteúdo/credencial ou string longa é recusada (nada gravado)', () => {
    const root = freshRoot();
    const bad = [
        { ac_id: 'AC-01', type: 'REDMINE_COMMENT', role: 'ORIGIN', key: '1', reference: { journal_id: 1, notes: 'texto do comentário' } },
        { ac_id: 'AC-01', type: 'ATTACHMENT', role: 'ORIGIN', key: '2', reference: { attachment_id: 2, content: 'bytes' } },
        { ac_id: 'AC-01', type: 'REDMINE_DESCRIPTION', role: 'ORIGIN', key: '3', reference: { ticket_id: '1', criteria: AC_TEXT } },
        { ac_id: 'AC-01', type: 'REDMINE_COMMENT', role: 'ORIGIN', key: '4', reference: { journal_id: 'x'.repeat(500) } },
        { ac_id: 'AC-01', type: 'REDMINE_COMMENT', role: 'ORIGIN', key: '5', reference: { journal_id: 1, api_key: 'segredo' } },
        { ac_id: 'AC-01', type: 'INVENTADO', role: 'ORIGIN', key: '6', reference: { x: 1 } },
        { ac_id: 'AC-01', type: 'UNKNOWN', role: 'DONO', key: '7', reference: { x: 1 } },
        { ac_id: 'AC1', type: 'UNKNOWN', role: 'ORIGIN', key: '8', reference: { x: 1 } },
    ];
    for (const ev of bad) {
        const out = prov.appendEvents('43804', [ev], { root });
        assert.strictEqual(out.ok, false, JSON.stringify(ev));
    }
    assert.ok(!fs.existsSync(prov.logPath('43804', { root })), 'nada gravado');
    // ATTACHMENT válido: só id/nome/tipo.
    const ok = prov.declaredEvent('AC-01', { type: 'ATTACHMENT', role: 'ORIGIN', reference: { attachment_id: 77, filename: 'print.png', content_type: 'image/png' } });
    assert.ok(prov.appendEvents('43804', [ok], { root }).ok);
    const raw = fs.readFileSync(prov.logPath('43804', { root }), 'utf8');
    assert.doesNotMatch(raw, /bytes|segredo/);
});

test('log ilegível nunca é sobrescrito por um append', () => {
    const root = freshRoot();
    fs.writeFileSync(prov.logPath('43805', { root }), '{quebrado');
    const out = prov.appendEvents('43805', descEv('43805', 'AC-01'), { root });
    assert.strictEqual(out.ok, false);
    assert.strictEqual(fs.readFileSync(prov.logPath('43805', { root }), 'utf8'), '{quebrado');
});

test('validateHumanInputRefs: só message_hash existente em human_input_interpretations vale', () => {
    const interp = [{ at: '2026-09-30T12:42:00.000Z', message_hash: 'aaa111', node: 'implement' }];
    const r = prov.validateHumanInputRefs([
        { message_hash: 'aaa111', at: '2026-09-30T12:42:00.000Z' },
        { message_hash: 'aaa111', at: '2026-01-01T00:00:00.000Z' }, // at não bate
        { message_hash: 'nao-existe' },
        'texto livre citando o human input',
    ], interp);
    assert.deepStrictEqual(r.valid, [{ message_hash: 'aaa111', at: '2026-09-30T12:42:00.000Z', node: 'implement' }]);
    assert.strictEqual(r.invalid.length, 3);
    assert.deepStrictEqual(prov.validateHumanInputRefs(undefined, interp), { valid: [], invalid: [] });
});

test('baselineUnknownEvents: só AC sem nenhum evento; nunca HUMAN_AUTHORED', () => {
    const data = { events: [{ ac_id: 'AC-01', type: 'REDMINE_DESCRIPTION', role: 'ORIGIN' }] };
    const evs = prov.baselineUnknownEvents('43806', ['AC-01', 'AC-02'], data, { specHash: 'c'.repeat(64), specVersion: 1, sealedAt: '2026-10-01T10:00:00.000Z' });
    assert.deepStrictEqual(evs.map(e => [e.ac_id, e.type, e.role]), [['AC-02', 'UNKNOWN', 'ORIGIN']]);
    assert.strictEqual(evs[0].reference.reason, 'no-demonstrable-provenance');
    assert.ok(evs.every(e => e.type !== 'HUMAN_AUTHORED'));
});

// ── Registry = projeção do log ────────────────────────────────────────────────

function seedTicket(root, t, spec = SPEC) {
    fs.writeFileSync(path.join(root, 'memory', 'spec', `${t}-spec.md`), spec);
}

test('Registry: updateRegistry projeta ac_sources do log, sem texto do AC na projeção', () => {
    const root = freshRoot();
    seedTicket(root, '43810');
    prov.appendEvents('43810', descEv('43810', 'AC-01'), { root });
    const registryPath = path.join(root, '.graph', 'ac-registry.json');
    const { entry } = acRegistry.updateRegistry('43810', acRegistry.extractACs(SPEC, '43810'), { registryPath, specContent: SPEC });
    assert.deepStrictEqual(Object.keys(entry.ac_sources), ['AC-01']);
    assert.deepStrictEqual(entry.ac_sources, prov.projection(readLogFile(root, '43810')));
    assert.doesNotMatch(JSON.stringify(entry.ac_sources), new RegExp(AC_TEXT));
    // Evento novo no log → a próxima sincronização atualiza a projeção.
    prov.appendEvents('43810', prov.legacyNumberingEvents('43810', ['AC-02']), { root });
    const second = acRegistry.updateRegistry('43810', acRegistry.extractACs(SPEC, '43810'), { registryPath, specContent: SPEC });
    assert.strictEqual(second.changed, true);
    assert.deepStrictEqual(Object.keys(second.entry.ac_sources), ['AC-01', 'AC-02']);
});

test('T1/T2/T14. apagar, reconstruir ou corromper o Registry não perde provenance: ac_sources = projeção do log', () => {
    const root = freshRoot();
    const specsDir = path.join(root, 'memory', 'spec');
    const registryPath = path.join(root, '.graph', 'ac-registry.json');
    seedTicket(root, '43811');
    prov.appendEvents('43811', descEv('43811', 'AC-01'), { root });
    rebuild({ specsDir, registryPath });
    const expected = prov.projection(readLogFile(root, '43811'));
    assert.deepStrictEqual(acRegistry.readRegistry(registryPath).tasks['43811'].ac_sources, expected);

    fs.rmSync(registryPath);
    rebuild({ specsDir, registryPath });
    assert.deepStrictEqual(acRegistry.readRegistry(registryPath).tasks['43811'].ac_sources, expected, 'apagado + rebuild');

    fs.writeFileSync(registryPath, '{corrompido');
    const warn = console.warn; console.warn = () => {};
    try { rebuild({ specsDir, registryPath }); } finally { console.warn = warn; }
    assert.deepStrictEqual(acRegistry.readRegistry(registryPath).tasks['43811'].ac_sources, expected, 'corrompido + rebuild');
    assert.strictEqual(readLogFile(root, '43811').events.length, 1, 'log intacto');
});

test('12/13. criteria[] legado continua no registro; entrada v1 continua legível; sem provenance não há ac_sources', () => {
    const root = freshRoot();
    const registryPath = path.join(root, '.graph', 'ac-registry.json');
    fs.writeFileSync(registryPath, JSON.stringify({ version: 1, updatedAt: null, tasks: { '40000': { criteria: ['crit v1'], specHash: 'x' } } }));
    seedTicket(root, '43812', LEGACY_SPEC);
    const { entry } = acRegistry.updateRegistry('43812', acRegistry.extractACs(LEGACY_SPEC, '43812'), { registryPath, specContent: LEGACY_SPEC });
    assert.strictEqual(entry.legacy, true);
    assert.deepStrictEqual(entry.criteria, ['Critério legado sem ID', 'Outro critério legado']);
    assert.ok(!('ac_sources' in entry));
    const reg = acRegistry.readRegistry(registryPath);
    assert.deepStrictEqual(reg.tasks['40000'].criteria, ['crit v1']);
    assert.deepStrictEqual(acRegistry.entryView(reg.tasks['40000']).criteria, ['crit v1']);
});

test('14/15. provenance no registro não quebra getRelatedACs nem plan-scorer', () => {
    const root = freshRoot();
    const registryPath = path.join(root, '.graph', 'ac-registry.json');
    const dep = `${SPEC}\n## Dependências\n- #43820\n`;
    seedTicket(root, '43820');
    seedTicket(root, '43821', dep);
    prov.appendEvents('43820', descEv('43820', 'AC-01'), { root });
    acRegistry.updateRegistry('43820', acRegistry.extractACs(SPEC, '43820'), { registryPath, specContent: SPEC });
    acRegistry.updateRegistry('43821', acRegistry.extractACs(dep, '43821'), { registryPath, specContent: dep, dependsOn: ['43820'] });
    const reg = acRegistry.readRegistry(registryPath);
    const related = acRegistry.getRelatedACs('43821', reg, { registry: reg });
    assert.deepStrictEqual(related, [{ taskId: '43820', depth: 1, indexed: true, ac_ids: ['AC-01', 'AC-02'], criteria: [] }]);

    const scorer = require('./plan-scorer');
    const scored = scorer.scorePlan('# Plano\n\n1. Implementar desconto (AC-01, AC-02) em `FreteService.java`\n', SPEC, {});
    assert.ok(scored && typeof scored === 'object', 'plan-scorer segue funcionando com o registro novo');
});

// ── CLIs ──────────────────────────────────────────────────────────────────────

const CLI = path.join(__dirname, 'ac-provenance.js');

test('12 (extra). CLI declare registra HUMAN_AUTHORED explícito; repetir é no-op', () => {
    const root = freshRoot();
    const args = [CLI, 'declare', '43830', 'AC-03', '--type=HUMAN_AUTHORED', '--role=ORIGIN', '--ref={"declared_by":"dev","spec_hash":"abc"}', `--root=${root}`];
    const r1 = spawnSync(process.execPath, args, { encoding: 'utf8' });
    assert.strictEqual(r1.status, 0, r1.stderr);
    const r2 = spawnSync(process.execPath, args, { encoding: 'utf8' });
    assert.strictEqual(r2.status, 0, r2.stderr);
    assert.match(r2.stdout, /no-op/);
    const [ev] = readLogFile(root, '43830').events;
    assert.strictEqual(ev.type, 'HUMAN_AUTHORED');
    assert.strictEqual(ev.reference.declared, true);
    const show = spawnSync(process.execPath, [CLI, 'show', '43830', 'AC-03', `--root=${root}`], { encoding: 'utf8' });
    assert.strictEqual(JSON.parse(show.stdout).sources.length, 1);
    const bad = spawnSync(process.execPath, [CLI, 'declare', '43830', 'AC-03', '--type=HUMAN_AUTHORED', '--role=ORIGIN', '--ref={"text":"o critério"}', `--root=${root}`], { encoding: 'utf8' });
    assert.strictEqual(bad.status, 1);
});

test('7 (CLI). ac-ids number --write numera legado e registra UNKNOWN/legacy-numbering, nada mais', () => {
    const root = freshRoot();
    const spec = path.join(root, 'memory', 'spec', '43831-spec.md');
    fs.writeFileSync(spec, LEGACY_SPEC);
    const r = spawnSync(process.execPath, [path.join(__dirname, 'ac-ids.js'), 'number', spec, '--write'], { encoding: 'utf8', env: { ...process.env, AC_PROVENANCE_ROOT: root } });
    assert.strictEqual(r.status, 0, r.stderr);
    assert.match(fs.readFileSync(spec, 'utf8'), /- AC-01: Critério legado sem ID/);
    const events = readLogFile(root, '43831').events;
    assert.deepStrictEqual(events.map(e => [e.ac_id, e.type, e.role, e.reference]), [
        ['AC-01', 'UNKNOWN', 'ORIGIN', 'legacy-numbering'], ['AC-02', 'UNKNOWN', 'ORIGIN', 'legacy-numbering'],
    ]);
    assert.ok(events.every(e => e.type !== 'HUMAN_AUTHORED' && e.type !== 'REDMINE_DESCRIPTION'));
});
