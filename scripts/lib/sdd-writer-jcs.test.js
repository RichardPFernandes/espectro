'use strict';
// PRI-266 F1 — JCS (RFC 8785) e envelope sdd-cmd-v1 (RRC-SDD-002 §4.4). WT-F1-01…05.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { canonicalize, parseStrict, parseCanonical } = require('./sdd-writer-jcs');
const cmd = require('./sdd-writer-command');

const f64 = hex => { const b = Buffer.from(hex, 'hex'); return b.readDoubleBE(0); };
const H = c => c.repeat(64);

function incCommand(over = {}) {
    return {
        canon: 'sdd-cmd-v1', op: 'INC', project: 'prisma', capability: 'cap:prisma:spec-change',
        expected_generation: 0,
        approved_payload: {
            base_version: null, base_hash: null, delta_sha256: H('d'), target_version: 1, target_hash: H('1'),
            target_spec_sha256: H('5'),
            source_promotion: { promotion_id: 'PRI-1:exec-1:1', spec_sha256: H('a'), observed_contract_hash: H('1') },
            validation_ref: { kind: 'verify_pass', ref: 'verify:exec-1', promotion_id: 'PRI-1:exec-1:1', execution_id: 'exec-1' },
            validation_basis: {
                project_binding_ref: { path: 'docs/sdd/admitted/project.json', sha256: H('b') },
                policy_ref: { path: 'docs/sdd/admitted/policy.json', sha256: H('c') },
            },
        },
        ...over,
    };
}

describe('WT-F1-01 vetores da RFC 8785', () => {
    it('amostra do §3.2.2 (números, string com escapes, literais)', () => {
        const input = '{"numbers": [333333333.33333329, 1E30, 4.50, 2e-3, 0.000000000000000000000000001], '
            + '"string": "\\u20ac$\\u000F\\u000aA\'\\u0042\\u0022\\u005c\\\\\\"\\/", "literals": [null, true, false]}';
        const expected = '{"literals":[null,true,false],"numbers":[333333333.3333333,1e+30,4.5,0.002,1e-27],'
            + '"string":"€$\\u000f\\nA\'B\\"\\\\\\\\\\"/"}';
        assert.equal(canonicalize(parseStrict(input)), expected);
    });
    it('ordenação por unidades UTF-16 (§3.2.3)', () => {
        const input = '{"\\u20ac":"Euro Sign","\\r":"Carriage Return","\\ufb33":"Hebrew Letter Dalet With Dagesh",'
            + '"1":"One","\\ud83d\\ude00":"Emoji: Grinning Face","\\u0080":"Control","\\u00f6":"Latin Small Letter O With Diaeresis"}';
        // Object.keys reordenaria a chave inteira "1"; ler a ordem direto dos bytes canônicos.
        const out = canonicalize(parseStrict(input));
        const keys = [...out.matchAll(/(?:^\{|,)("(?:[^"\\]|\\.)*"):/g)].map(m => JSON.parse(m[1]));
        assert.deepEqual(keys, ['\r', '1', '\u0080', 'ö', '€', '😀', 'דּ']);
    });
    it('números IEEE-754 do Apêndice B', () => {
        const vectors = [
            ['0000000000000000', '0'], ['8000000000000000', '0'], ['0000000000000001', '5e-324'],
            ['8000000000000001', '-5e-324'], ['7fefffffffffffff', '1.7976931348623157e+308'],
            ['4340000000000000', '9007199254740992'], ['c340000000000000', '-9007199254740992'],
            ['4430000000000000', '295147905179352830000'], ['44b52d02c7e14af5', '9.999999999999997e+22'],
            ['44b52d02c7e14af6', '1e+23'], ['3eb0c6f7a0b5ed8d', '0.000001'],
            ['3eb0c6f7a0b5ed8c', '9.999999999999997e-7'], ['41b3de4355555555', '333333333.3333333'],
        ];
        for (const [bits, out] of vectors) assert.equal(canonicalize(f64(bits)), out, bits);
        assert.throws(() => canonicalize(NaN));
        assert.throws(() => canonicalize(Infinity));
    });
});

describe('WT-F1-02 restrições do schema sdd-cmd-v1 → FAIL(COMMAND)', () => {
    const asBytes = obj => Buffer.from(canonicalize(obj), 'utf8');
    const rejects = (bytes, reason) => assert.throws(() => cmd.parseCommandBytes(bytes), e => e instanceof cmd.CommandError && (!reason || e.reason === reason));
    it('comando válido passa', () => {
        assert.equal(cmd.parseCommandBytes(asBytes(incCommand())).op, 'INC');
    });
    it('inteiro ≥ 2^53', () => rejects(asBytes(incCommand({ expected_generation: 2 ** 53 })), 'INTEGER'));
    it('inteiro negativo', () => rejects(asBytes(incCommand({ expected_generation: -1 })), 'INTEGER'));
    it('número não inteiro', () => rejects(asBytes(incCommand({ expected_generation: 1.5 })), 'INTEGER'));
    it('chave duplicada', () => {
        const s = canonicalize(incCommand()).replace('"canon":"sdd-cmd-v1"', '"canon":"sdd-cmd-v1","canon":"sdd-cmd-v1"');
        rejects(Buffer.from(s), 'DUPLICATE_KEY');
    });
    it('surrogate isolado', () => {
        const s = canonicalize(incCommand()).replace('"op":"INC"', '"op":"INC\\ud800"');
        rejects(Buffer.from(s), 'LONE_SURROGATE');
    });
    it('string fora de NFC', () => {
        const c = incCommand();
        c.approved_payload.validation_ref.ref = 'verify:é'; // e + acento combinante (NFD)
        rejects(asBytes(c), 'NFC');
    });
    it('campo extra (inclusive tentativa de dispensar QA)', () => {
        const c = incCommand();
        c.approved_payload.skip_qa = true;
        rejects(asBytes(c), 'EXTRA_FIELD');
        rejects(asBytes(incCommand({ extra: 'x' })), 'EXTRA_FIELD');
    });
    it('campo ausente ≠ null', () => {
        const c = incCommand();
        delete c.approved_payload.base_version;
        rejects(asBytes(c), 'MISSING_FIELD');
        const ok = incCommand();
        assert.equal(ok.approved_payload.base_version, null);
        assert.ok(cmd.parseCommandBytes(asBytes(ok)));
    });
    it('UTF-8 inválido e BOM', () => {
        rejects(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), asBytes(incCommand())]), 'BOM');
        rejects(Buffer.from([0x7b, 0xff, 0x7d]), 'UTF8');
    });
});

describe('WT-F1-03 bytes congelados: JCS(parse(b)) ≠ b → recusa', () => {
    it('espaço, ordem de chave e número reescrito', () => {
        const good = canonicalize(incCommand());
        for (const bad of [
            good.replace('{', '{ '),
            JSON.stringify(incCommand()), // ordem de inserção, não JCS
            good.replace('"expected_generation":0', '"expected_generation":0.0'),
        ]) {
            assert.throws(() => parseCanonical(Buffer.from(bad)), e => e.reason === 'NON_CANONICAL' || e.reason === 'SYNTAX', bad.slice(0, 40));
            assert.throws(() => cmd.parseCommandBytes(Buffer.from(bad)));
        }
    });
});

describe('WT-F1-04 op_id fora do hash; op diferente → hash diferente', () => {
    it('o comando não tem op_id e o hash cobre op', () => {
        const a = incCommand();
        assert.ok(!('op_id' in a));
        const b = { canon: 'sdd-cmd-v1', op: 'ACTIVATE', project: 'prisma', capability: 'cap:prisma:spec-change', expected_generation: 1, approved_payload: { expected_active: null, target_version: 1, target_hash: H('1') } };
        const c = { ...b, op: 'REACTIVATE' };
        assert.notEqual(cmd.commandSha256(b), cmd.commandSha256(c));
        assert.equal(cmd.commandSha256(b), cmd.commandSha256(JSON.parse(JSON.stringify(b))));
    });
    it('derivação op_id ← request_id (RRC-SDD-002 §4.3)', () => {
        assert.equal(cmd.deriveOpId('prisma', 'spec-change', 'INC', 'req-1'), 'op:prisma:spec-change:INC:req-1');
    });
});

describe('WT-F1-05 canon ≠ sdd-cmd-v1 → recusa', () => {
    it('sdd-cmd-v2 e ausente', () => {
        assert.throws(() => cmd.validateCommand(incCommand({ canon: 'sdd-cmd-v2' })), e => e.reason === 'CANON');
        const c = incCommand(); delete c.canon;
        assert.throws(() => cmd.validateCommand(c), e => e.reason === 'MISSING_FIELD');
    });
});

