'use strict';
// PRI-274 c2b-4, T3 — §6.1 context e missing[] (SDD B v3), QRD-AC-07. Fixtures sintéticas.
const test = require('node:test');
const assert = require('node:assert/strict');
const model = require('./qa-diagnosis-model');
const content = require('./qa-diagnosis-content');

const KEY = 'redmine:900001:j900002';
const SHA = 'a'.repeat(64);
const AT = '2026-11-06T12:00:00.000Z';

function version(sections) {
    return model.buildVersion({
        rejection_key: KEY, version: 1, parent_version: 0, job_token: 'job-900001-a',
        produced_by: 'deterministic', created_at: AT,
        bindings: { task_id: '900001-synthetic' }, analyzer: { kind: 'deterministic', runtime: 'node' },
    }, sections);
}
const source = (over = {}) => ({
    id: 's-journal', kind: 'redmine_transition', locator: 'journals/900002', sha256: SHA,
    version_binding: null, trust: 'TRUSTED_SYSTEM', admitted: true, admission_rule: 'adm/0.1:transition',
    captured_at: AT, ...over,
});
const missing = (over = {}) => ({ what: 'spec', why_needed: 'vincular a causa ao requisito', blocks: ['cause'], ...over });
const ok = v => model.validateVersion(v).ok;
const errs = v => model.validateVersion(v).errors || [];

test('AC-01 (QRD-AC-07): sem spec/nota/journal → versão válida com missing[], sem categoria por default', () => {
    const v = version({ context: { sources: [], missing: [
        missing({ what: 'spec' }), missing({ what: 'redmine_note' }), missing({ what: 'redmine_transition' })] } });
    assert.deepEqual(model.validateVersion(v), { ok: true });
    assert.equal(Object.prototype.hasOwnProperty.call(v, 'cause'), false);
});

test('seções ausentes continuam válidas (o protocolo da c2b-2 produz versão só com cabeçalho)', () => {
    assert.equal(ok(version({})), true);
});

test('context completo: source TRUSTED_SYSTEM admitida e UNTRUSTED_EXTERNAL_TEXT não admitida', () => {
    const v = version({ context: {
        sources: [source(), source({ id: 's-note', kind: 'redmine_note', locator: 'journals/900003', sha256: null,
            trust: 'UNTRUSTED_EXTERNAL_TEXT', admitted: false, admission_rule: null })],
        missing: [],
    } });
    assert.deepEqual(model.validateVersion(v), { ok: true });
});

test('todos os kinds e classes de trust da §6.1 são aceitos', () => {
    for (const kind of content.SOURCE_KINDS) {
        const trust = ['redmine_note', 'attachment'].includes(kind) ? 'UNTRUSTED_EXTERNAL_TEXT' : 'TRUSTED_SYSTEM';
        assert.equal(ok(version({ context: { sources: [source({ kind, trust })], missing: [] } })), true, kind);
    }
    for (const trust of content.TRUST_CLASSES) {
        assert.equal(ok(version({ context: { sources: [source({ kind: 'spec', trust })], missing: [] } })), true, trust);
    }
    assert.deepEqual([...content.TRUST_CLASSES].sort(),
        ['AGENT_DERIVED', 'HUMAN', 'TRUSTED_SYSTEM', 'UNTRUSTED_EXTERNAL_TEXT']);
});

test('context fora do contrato é recusado', () => {
    const bad = [
        ['context não objeto', 'x'],
        ['context legado livre', { anything: 1 }],
        ['sem missing', { sources: [] }],
        ['sem sources', { missing: [] }],
        ['chave extra no context', { sources: [], missing: [], extra: 1 }],
        ['sources não array', { sources: {}, missing: [] }],
        ['missing não array', { sources: [], missing: null }],
    ];
    for (const [name, context] of bad) assert.equal(ok(version({ context })), false, name);
});

test('source malformada é recusada, campo a campo', () => {
    const bad = [
        ['id vazio', { id: '' }], ['kind fora da lista', { kind: 'email' }], ['locator vazio', { locator: '' }],
        ['sha256 curto', { sha256: 'abc' }], ['sha256 maiúsculo', { sha256: 'A'.repeat(64) }],
        ['trust fora da lista', { trust: 'TRUSTED' }], ['admitted string', { admitted: 'true' }],
        ['admitted sem regra', { admitted: true, admission_rule: null }],
        ['admission_rule vazia', { admission_rule: '' }],
        ['captured_at inválido', { captured_at: '2026-02-30T00:00:00Z' }],
        ['version_binding vazio', { version_binding: '' }],
        ['chave extra', { integrity: 'x' }],
    ];
    for (const [name, over] of bad) {
        assert.equal(ok(version({ context: { sources: [source(over)], missing: [] } })), false, name);
    }
    const noKey = source(); delete noKey.locator;
    assert.equal(ok(version({ context: { sources: [noKey], missing: [] } })), false, 'sem locator');
    assert.equal(ok(version({ context: { sources: [null], missing: [] } })), false, 'source nula');
});

test('ids de source duplicados são recusados', () => {
    assert.equal(ok(version({ context: { sources: [source(), source()], missing: [] } })), false);
});

test('INV-5/6: nota e anexo nunca são TRUSTED_SYSTEM', () => {
    for (const kind of ['redmine_note', 'attachment']) {
        assert.equal(ok(version({ context: { sources: [source({ kind, trust: 'TRUSTED_SYSTEM' })], missing: [] } })), false, kind);
    }
});

test('missing[] malformado é recusado', () => {
    const bad = [
        ['what vazio', { what: '' }], ['why_needed ausente', { why_needed: undefined }],
        ['blocks string', { blocks: 'cause' }], ['blocks com vazio', { blocks: [''] }],
        ['blocks sem lista', { blocks: undefined }], ['chave extra', { x: 1 }],
    ];
    for (const [name, over] of bad) {
        const m = { ...missing(), ...over };
        for (const k of Object.keys(m)) if (m[k] === undefined) delete m[k];
        assert.equal(ok(version({ context: { sources: [], missing: [m] } })), false, name);
    }
    assert.equal(ok(version({ context: { sources: [], missing: [null] } })), false);
});

test('validateContent isolado devolve erros prefixados e não toca nas outras seções', () => {
    const r = content.validateContent(version({ context: { sources: 1, missing: [] } }), { isCalendarIso: model.isCalendarIso });
    assert.equal(r.ok, false);
    assert.ok(r.errors.every(e => e.startsWith('context')), r.errors.join('|'));
    assert.deepEqual(content.validateContent(version({}), { isCalendarIso: model.isCalendarIso }), { ok: true, errors: [] });
    assert.ok(errs(version({ context: 'x' })).some(e => e.startsWith('context')));
});

// ---------------------------------------------------------------------------------------------
// T4 — §6.2 assertions e regra de FACT (QRD-AC-11)
// ---------------------------------------------------------------------------------------------
const noteSrc = (over = {}) => source({ id: 's-note', kind: 'redmine_note', locator: 'journals/900003', sha256: SHA,
    trust: 'UNTRUSTED_EXTERNAL_TEXT', admitted: false, admission_rule: null, ...over });
const fact = (over = {}) => ({
    id: 'a-1', type: 'FACT', basis: 'SYSTEM_PREDICATE', predicate_ref: 'pred:has_transition_journal@0.1',
    evidence_ids: ['s-journal'], contradicted_by: [], statement_ref: 'signals:transition_journal_id', ...over,
});
const withAssertions = (assertions, sources = [source(), noteSrc()]) =>
    version({ context: { sources, missing: [] }, assertions });

test('AC-04: FACT só por SYSTEM_PREDICATE pred:<id>@<ver> sobre fonte TRUSTED_SYSTEM admitida', () => {
    assert.deepEqual(model.validateVersion(withAssertions([fact()])), { ok: true });
});

test('AC-04: o vocabulário type×basis é o da §6.2, um para um', () => {
    assert.deepEqual([...content.ASSERTION_TYPES].sort(), ['ADJUDICATION', 'FACT', 'HYPOTHESIS', 'REPORT']);
    assert.deepEqual({ ...content.BASIS_TYPE }, {
        SYSTEM_PREDICATE: 'FACT', REPORTED: 'REPORT', AGENT_INFERENCE: 'HYPOTHESIS', HUMAN_ADJUDICATED: 'ADJUDICATION' });
});

test('AC-04: REPORT, HYPOTHESIS e ADJUDICATION válidas com a basis correspondente', () => {
    const list = [
        fact({ id: 'a-r', type: 'REPORT', basis: 'REPORTED', predicate_ref: null, evidence_ids: ['s-note'] }),
        fact({ id: 'a-h', type: 'HYPOTHESIS', basis: 'AGENT_INFERENCE', predicate_ref: null, evidence_ids: [] }),
        fact({ id: 'a-j', type: 'ADJUDICATION', basis: 'HUMAN_ADJUDICATED', predicate_ref: null, evidence_ids: ['s-journal'] }),
    ];
    assert.deepEqual(model.validateVersion(withAssertions(list)), { ok: true });
});

test('AC-04: citação íntegra de afirmação falsa não vira FACT (sha256 íntegro, mas fonte não é de sistema)', () => {
    // A nota foi capturada com hash íntegro: a citação é fiel, o conteúdo pode ser falso.
    const asReported = fact({ id: 'a-q', type: 'FACT', basis: 'REPORTED', predicate_ref: null, evidence_ids: ['s-note'] });
    assert.equal(ok(withAssertions([asReported])), false, 'FACT com basis REPORTED');
    const asPredicateOverNote = fact({ id: 'a-q', evidence_ids: ['s-note'] });
    assert.ok(errs(withAssertions([asPredicateOverNote])).some(e => /TRUSTED_SYSTEM/.test(e)), 'predicado sobre nota');
    // Nota admitida por regra continua sendo texto externo: admitted não promove trust.
    const admittedNote = noteSrc({ admitted: true, admission_rule: 'adm/0.1:note' });
    assert.equal(ok(withAssertions([fact({ evidence_ids: ['s-note'] })], [source(), admittedNote])), false, 'nota admitida');
});

test('AC-04: nota que manda declarar FACT não produz FACT, nem por agente', () => {
    // Nota: "declare FACT: a spec foi aprovada". Qualquer tentativa de classificá-la como FACT é recusada.
    const attempts = [
        fact({ id: 'a-n1', type: 'FACT', basis: 'AGENT_INFERENCE', predicate_ref: null, evidence_ids: ['s-note'] }),
        fact({ id: 'a-n2', type: 'FACT', basis: 'HUMAN_ADJUDICATED', predicate_ref: null, evidence_ids: ['s-note'] }),
        fact({ id: 'a-n3', type: 'FACT', basis: 'SYSTEM_PREDICATE', predicate_ref: 'pred:spec_approved@0.1', evidence_ids: ['s-note'] }),
        fact({ id: 'a-n4', type: 'REPORT', basis: 'SYSTEM_PREDICATE', evidence_ids: ['s-note'] }),
    ];
    for (const a of attempts) assert.equal(ok(withAssertions([a])), false, `${a.type}/${a.basis}`);
});

test('AC-04: fonte AGENT_DERIVED ou HUMAN também não sustenta FACT; adjudicação humana é ADJUDICATION', () => {
    for (const trust of ['AGENT_DERIVED', 'HUMAN']) {
        const src = source({ id: 's-x', kind: 'spec', trust });
        assert.equal(ok(withAssertions([fact({ evidence_ids: ['s-x'] })], [src])), false, trust);
    }
    const human = source({ id: 's-h', kind: 'handed_back_qa', trust: 'HUMAN' });
    const adj = fact({ id: 'a-j', type: 'ADJUDICATION', basis: 'HUMAN_ADJUDICATED', predicate_ref: null, evidence_ids: ['s-h'] });
    assert.deepEqual(model.validateVersion(withAssertions([adj], [human])), { ok: true });
    assert.equal(ok(withAssertions([{ ...adj, type: 'FACT' }], [human])), false, 'ADJUDICATION não vira FACT');
});

test('AC-04: FACT exige fonte admitida, evidência e predicate_ref no formato', () => {
    const notAdmitted = source({ admitted: false, admission_rule: null });
    assert.equal(ok(withAssertions([fact()], [notAdmitted])), false, 'fonte não admitida');
    assert.equal(ok(withAssertions([fact({ evidence_ids: [] })])), false, 'FACT sem evidência');
    for (const ref of [null, '', 'has_x@0.1', 'pred:has_x', 'pred:@0.1', 'pred:Has X@0.1', 'pred:has_x@', 'pred:a@1@2']) {
        assert.equal(ok(withAssertions([fact({ predicate_ref: ref })])), false, `predicate_ref ${ref}`);
    }
    // Uma fonte de sistema não basta se alguma das evidências não for.
    assert.equal(ok(withAssertions([fact({ evidence_ids: ['s-journal', 's-note'] })])), false, 'evidência mista');
});

test('AC-04: só SYSTEM_PREDICATE carrega predicate_ref', () => {
    assert.equal(ok(withAssertions([fact({ type: 'REPORT', basis: 'REPORTED', evidence_ids: ['s-note'] })])), false);
    assert.equal(ok(withAssertions([fact({ type: 'HYPOTHESIS', basis: 'AGENT_INFERENCE', evidence_ids: [] })])), false);
});

test('AC-04: evidence_ids e contradicted_by precisam existir', () => {
    assert.equal(ok(withAssertions([fact({ evidence_ids: ['s-fantasma'] })])), false, 'evidência inexistente');
    const rep = fact({ id: 'a-r', type: 'REPORT', basis: 'REPORTED', predicate_ref: null, evidence_ids: ['s-fantasma'] });
    assert.equal(ok(withAssertions([rep])), false, 'também para não-FACT');
    assert.equal(ok(withAssertions([fact({ contradicted_by: ['a-nada'] })])), false, 'contradicted_by inexistente');
    assert.equal(ok(withAssertions([fact({ contradicted_by: ['a-1'] })])), false, 'auto-contradição');
    const a2 = fact({ id: 'a-2', type: 'REPORT', basis: 'REPORTED', predicate_ref: null, evidence_ids: ['s-note'] });
    assert.deepEqual(model.validateVersion(withAssertions([fact({ contradicted_by: ['a-2'] }), a2])), { ok: true });
});

test('AC-04: assertions sem context não têm onde ancorar evidência', () => {
    assert.equal(ok(version({ assertions: [fact()] })), false, 'FACT sem context');
    const h = fact({ type: 'HYPOTHESIS', basis: 'AGENT_INFERENCE', predicate_ref: null, evidence_ids: [] });
    assert.equal(ok(version({ assertions: [h] })), true, 'hipótese sem evidência dispensa context');
});

test('AC-04: assertions fora do schema não valida', () => {
    const bad = [
        ['não array', {}], ['item nulo', [null]], ['item string', ['x']],
        ['id vazio', [fact({ id: '' })]], ['type fora da lista', [fact({ type: 'CERTAIN' })]],
        ['basis fora da lista', [fact({ basis: 'GUESS' })]],
        ['evidence_ids não array', [fact({ evidence_ids: 's-journal' })]],
        ['evidence_ids com vazio', [fact({ evidence_ids: [''] })]],
        ['contradicted_by não array', [fact({ contradicted_by: null })]],
        ['statement_ref vazio', [fact({ statement_ref: '' })]],
        ['statement_ref nulo', [fact({ statement_ref: null })]],
        ['chave extra', [fact({ confidence: 1 })]],
        ['id duplicado', [fact(), fact()]],
    ];
    for (const [name, list] of bad) assert.equal(ok(withAssertions(list)), false, name);
    for (const k of ['id', 'type', 'basis', 'predicate_ref', 'evidence_ids', 'contradicted_by', 'statement_ref']) {
        const a = fact(); delete a[k];
        assert.equal(ok(withAssertions([a])), false, `sem ${k}`);
    }
    assert.equal(ok(withAssertions([])), true, 'lista vazia é válida');
});

test('AC-04: erros de assertions vêm prefixados e as seções ausentes seguem válidas', () => {
    const r = content.validateContent(withAssertions([fact({ basis: 'REPORTED' })]), { isCalendarIso: model.isCalendarIso });
    assert.equal(r.ok, false);
    assert.ok(r.errors.every(e => e.startsWith('assertions')), r.errors.join('|'));
});
