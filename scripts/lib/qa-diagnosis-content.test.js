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
