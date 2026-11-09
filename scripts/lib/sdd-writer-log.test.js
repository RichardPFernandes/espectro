'use strict';
// PRI-266 F2 — codec do log e estado derivado (C-15, C-17; RRC-SDD-002 §4.5; PR §5.4). WT-F2-01…08.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const log = require('./sdd-writer-log');
const { canonicalBytes } = require('./sdd-writer-jcs');
const { loadMutant, fixtures: F } = require('./sdd-writer-testkit');

const editResolver = sha => ({ [F.H('a')]: { add: [{ kind: 'roadmap_card', value: 'task-76@v80' }], retire: [] } }[sha] || null);

/** L3 do P1-b: INC, ACTIVATE, EDIT (gerações 1–3). */
function l3() {
    const s = F.scenario();
    s.commit(s.step('INC'));
    s.commit(s.step('ACTIVATE'));
    s.commit(s.step('EDIT_ALIASES_SOURCES', { editResolver }));
    return s;
}

describe('WT-F2-01 ausência sem âncora e sem histórico = geração 0', () => {
    it('gen 0, active=null', () => {
        assert.deepEqual(log.parseLog(null), { status: 'ABSENT' });
        assert.equal(log.absenceVerdict({ hasAnchors: false, everInHistory: false }), 'OK');
        const d = log.deriveState([]);
        assert.equal(d.state.generation, 0);
        assert.equal(d.state.active, null);
    });
});

describe('WT-F2-02 `[]` → UNKNOWN', () => {
    it('log vazio explícito não é canônico', () => {
        assert.equal(log.parseLog(Buffer.from('[]')).status, 'UNKNOWN');
    });
});

describe('WT-F2-03 append e primeira operação (RRC-SDD-002 §4.5)', () => {
    it('"[" + JCS(e) + "]" e old[:-1] + "," + JCS(e) + "]"', () => {
        const s = l3();
        const [e1, e2] = s.state.entries;
        const b1 = log.appendBytes(null, e1);
        assert.equal(b1.toString(), `[${canonicalBytes(e1).toString()}]`);
        const b2 = log.appendBytes(b1, e2);
        assert.ok(b2.subarray(0, b1.length - 1).equals(b1.subarray(0, b1.length - 1)), 'prefixo byte a byte exceto o ]');
        assert.equal(log.splitAppend(null, b1).ok, true);
        assert.equal(log.splitAppend(null, log.appendBytes(b1, e2)).code, 'LOG_BYTES', 'primeira operação com duas entradas');
        const sp = log.splitAppend(b1, b2);
        assert.equal(sp.ok, true);
        assert.equal(sp.entry.op_id, e2.op_id);
        assert.equal(log.parseLog(b2).status, 'OK');
    });
});

describe('WT-F2-04 bytes truncados ou não canônicos (caso 9) → UNKNOWN, sem escrita corretiva', () => {
    it('append parcial', () => {
        const s = l3();
        const good = s.state.files['docs/sdd/capabilities/spec-change/log.json'];
        const truncated = Buffer.concat([good.subarray(0, good.length - 1), Buffer.from(',{"generation":4')]);
        assert.equal(log.parseLog(truncated).status, 'UNKNOWN');
    });
    it('bytes legíveis mas não canônicos (espaço, ordem de chaves)', () => {
        const s = l3();
        const pretty = Buffer.from(JSON.stringify(s.state.entries, null, 1));
        assert.equal(log.parseLog(pretty).status, 'UNKNOWN');
        assert.equal(log.parseLog(pretty).reason, 'LOG_NON_CANONICAL');
    });
    it('o codec é puro: parseLog não altera os bytes recebidos', () => {
        const b = Buffer.from('[{"a":1} ');
        const copy = Buffer.from(b);
        log.parseLog(b);
        assert.ok(b.equals(copy));
    });
});

describe('WT-F2-05 PR §5.4 linhas 1–6 (e 3′, 7)', () => {
    it('estado derivado conforme a tabela', () => {
        const s = F.scenario();
        const r1 = s.commit(s.step('INC', { specText: F.specText('v1') }));
        assert.deepEqual([s.state.state.generation, s.state.state.active, Object.keys(s.state.state.versions)], [1, null, ['1']]);
        const v1 = { cap_version: 1, cap_hash: r1.entry.command.approved_payload.target_hash };
        s.commit(s.step('EDIT_ALIASES_SOURCES', { editResolver }));
        assert.equal(s.state.state.generation, 2);
        assert.deepEqual(s.state.state.version_head.cap_hash, v1.cap_hash);
        // 3′: ACTIVATE aprovado antes do passo 2 (expected_generation=1) → conflito.
        const stale = log.applyCommand(s.state.state, { ...s.step('ACTIVATE').entry.command, expected_generation: 1 });
        assert.equal(stale.code, 'STALE');
        s.state.seq--; // o passo acima foi só leitura
        s.commit(s.step('ACTIVATE'));
        assert.deepEqual([s.state.state.generation, s.state.state.active], [3, v1]);
        s.commit(s.step('INC', { specText: F.specText('v2') }));
        assert.deepEqual([s.state.state.generation, Object.keys(s.state.state.versions)], [4, ['1', '2']]);
        const v2 = { cap_version: 2, cap_hash: s.state.state.version_head.cap_hash };
        s.commit(s.step('ACTIVATE'));
        assert.deepEqual([s.state.state.generation, s.state.state.active], [5, v2]);
        s.commit(s.step('REACTIVATE', { target: { cap_version: 1, cap_hash: v1.cap_hash } }));
        assert.deepEqual([s.state.state.generation, s.state.state.active], [6, v1]);
        // 7: pedido antigo ACTIVATE v1 com expected_generation=2 → conflito (ABA resolvido).
        const old = { canon: 'sdd-cmd-v1', op: 'ACTIVATE', project: 'prisma', capability: s.capability, expected_generation: 2, approved_payload: { expected_active: null, target_version: 1, target_hash: v1.cap_hash } };
        assert.equal(log.applyCommand(s.state.state, old).code, 'STALE');
        // Base da próxima INC = última incorporada (v2), não a ativa (LR 003/3).
        assert.equal(s.state.state.version_head.cap_version, 2);
        // deriveState reconstrói o mesmo estado a partir do log.
        const d = log.deriveState(s.state.entries, { editResolver });
        assert.deepEqual(d.state, s.state.state);
    });
    it('INC sem mudança no HASH_SCOPE = inc_no_contract_change, sem versão nova', () => {
        const s = F.scenario();
        s.commit(s.step('INC', { specText: F.specText('v1') }));
        const noop = s.commit(s.step('INC', { specText: `${F.specText('v1')}\n## Referências\n- outra nota\n` }));
        assert.equal(noop.entry.result, 'inc_no_contract_change');
        assert.deepEqual(Object.keys(s.state.state.versions), ['1']);
        assert.equal(s.state.state.version_head.spec_sha256, noop.entry.command.approved_payload.target_spec_sha256);
    });
});

describe('WT-F2-06 ausência com âncora ou com o arquivo num commit ancestral → VIOLATION', () => {
    it('nunca geração 0 (caso 10)', () => {
        assert.equal(log.absenceVerdict({ hasAnchors: true, everInHistory: false }), 'VIOLATION');
        assert.equal(log.absenceVerdict({ hasAnchors: false, everInHistory: true }), 'VIOLATION');
    });
});

describe('WT-F2-07 sabotagem: ausência = gen 0 sem consultar âncora nem histórico', () => {
    it('WT-F2-06 deixa de detectar', () => {
        const m = loadMutant(['sdd-writer-log.js', 'ABSENCE']);
        assert.equal(m.log.absenceVerdict({ hasAnchors: true, everInHistory: true }), 'OK');
    });
});

describe('WT-F2-08 sabotagem: codec aceita bytes não canônicos', () => {
    it('WT-F2-04 deixa de detectar', () => {
        const m = loadMutant(['sdd-writer-log.js', 'LOG-CANON']);
        const s = l3();
        const pretty = Buffer.from(JSON.stringify(s.state.entries, null, 1));
        assert.equal(m.log.parseLog(pretty).status, 'OK');
    });
});
