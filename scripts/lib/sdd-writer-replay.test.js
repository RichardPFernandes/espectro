'use strict';
// PRI-266 F3 — caminho R (C-19, C-20; RRC-SDD-002 §4.2; P1-b casos 3, 4, 11). WT-F3-01…07.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { recognize, disclose, replay } = require('./sdd-writer-replay');
const { loadMutant, fixtures: F } = require('./sdd-writer-testkit');

const editResolver = sha => ({ [F.H('a')]: { add: [{ kind: 'roadmap_card', value: 'task-76@v80' }], retire: [] } }[sha] || null);

function l3() {
    const s = F.scenario();
    s.commit(s.step('INC'));
    s.commit(s.step('ACTIVATE'));
    s.commit(s.step('EDIT_ALIASES_SOURCES', { editResolver }));
    return s;
}
const tipOf = s => s.tree();
const args = (s, e, over = {}) => ({ tree: tipOf(s), slug: s.slug, opId: e.op_id, commandSha256: e.command_sha256, auditState: 'OK', ...over });

describe('WT-F3-01 replay de op-2 com a geração em 3 (caso 3)', () => {
    it('resultado histórico (gen 2), nenhuma escrita', () => {
        const s = l3();
        const before = JSON.stringify(Object.keys(s.state.files));
        const r = recognize(args(s, s.state.entries[1]));
        assert.equal(r.kind, 'REPLAY');
        assert.equal(r.entry.result_generation, 2);
        assert.equal(r.entry.result, 'activated');
        assert.equal(JSON.stringify(Object.keys(s.state.files)), before);
    });
});

describe('WT-F3-02 mesmo op_id, payload diferente (caso 4)', () => {
    it('CONFLICT, nunca already_processed', () => {
        const s = l3();
        const r = recognize(args(s, s.state.entries[1], { commandSha256: F.H('9') }));
        assert.equal(r.kind, 'CONFLICT');
        assert.notEqual(r.kind, 'already_processed');
    });
});

describe('WT-F3-03 leitor sem direito ou U-002-4 aberto (caso 11)', () => {
    it('NOT_AVAILABLE uniforme, igual ao op_id inexistente', () => {
        const s = l3();
        const e = s.state.entries[1];
        const answers = [
            replay(args(s, e), { readerHasCurrentRight: true }),
            replay(args(s, e), { readerHasCurrentRight: false }),
            replay(args(s, e, { commandSha256: F.H('9') }), { readerHasCurrentRight: true }),
            replay(args(s, e, { opId: 'op:prisma:spec-change:ACTIVATE:nunca' }), { readerHasCurrentRight: true }),
        ];
        for (const a of answers) assert.deepEqual(a, { response: 'NOT_AVAILABLE' });
    });
});

describe('WT-F3-04 independe de Decision não consumida e da geração', () => {
    it('mesmo resultado em gerações diferentes, sem porta de Decision', () => {
        const s = l3();
        const e = s.state.entries[1];
        const r3 = recognize(args(s, e));
        s.commit(s.step('INC'));
        const r4 = recognize(args(s, e));
        assert.deepEqual(r3, r4);
        assert.equal(recognize.length, 1); // não recebe porta de Decision nem geração esperada
    });
});

describe('WT-F3-05 replay da entrada 1 depois de N operações', () => {
    it('reconhecido: retenção é o log inteiro, sem expurgo (RRC-DP-006; RN-07 da PRI-264 não se aplica)', () => {
        const s = l3();
        for (let i = 0; i < 6; i++) s.commit(s.step('INC'));
        const r = recognize(args(s, s.state.entries[0]));
        assert.equal(r.kind, 'REPLAY');
        assert.equal(r.entry.result_generation, 1);
    });
});

describe('WT-F3-06 sabotagem: reconhecer só por op_id', () => {
    it('WT-F3-02 deixa de detectar o conflito', () => {
        const m = loadMutant(['sdd-writer-replay.js', 'C20-HASH']);
        const s = l3();
        assert.equal(m.replay.recognize(args(s, s.state.entries[1], { commandSha256: F.H('9') })).kind, 'REPLAY');
    });
});

describe('WT-F3-07 capability UNKNOWN/VIOLATION (C-22) e UNVERIFIABLE (R4-03)', () => {
    it('NOT_AVAILABLE', () => {
        const s = l3();
        const e = s.state.entries[1];
        for (const st of ['UNKNOWN', 'VIOLATION', 'UNVERIFIABLE']) {
            const r = recognize(args(s, e, { auditState: st }));
            assert.notEqual(r.kind, 'REPLAY');
            assert.deepEqual(disclose(r, { readerHasCurrentRight: true }), { response: 'NOT_AVAILABLE' });
        }
    });
});
