'use strict';
// PRI-266 F4 — transição pura e porta de Decision (C-12 V-0, V-3…V-10; C-14; C-18; C-22 modo
// histórico; P-1; E-01/E-02; U-002-8). WT-F4-01…20, WT-266-04 (M-02), R4-02.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { decide } = require('./sdd-writer-decide');
const { createTestDecisionPort, createTreeDecisionPort } = require('./sdd-writer-decision');
const { canonicalBytes } = require('./sdd-writer-jcs');
const cmd = require('./sdd-writer-command');
const { loadMutant, fixtures: F } = require('./sdd-writer-testkit');

const editAdd = (value, retire = []) => ({ add: value ? [{ kind: 'roadmap_card', value }] : [], retire });
const TEST_ONLY = { u0028Decided: true }; // D-266-3 A: condição injetada só em teste

async function run(st, { records, port, over = {}, impl = decide } = {}) {
    const decisionPort = port || createTestDecisionPort(records || st.records);
    return impl({ ...st.ctx, decisionPort, ...over });
}
const decideOf = m => m.decide.decide;

/** Cenário com INC aplicada (geração 1). */
function afterInc(opts) {
    const s = F.scenario(opts);
    s.commit(s.step('INC'));
    return s;
}

describe('caso normal', () => {
    it('INC inicial válida → PASS', async () => {
        const s = F.scenario();
        const r = await run(s.step('INC'));
        assert.equal(r.ok, true, JSON.stringify(r));
        assert.equal(r.result, 'inc_version_created');
    });
});

describe('WT-F4-01 op_id no log antigo → FAIL(DUPLICATE_OP) (caso 6)', () => {
    it('recusa e sai pelo caminho R', async () => {
        const s = afterInc();
        const r = await run(s.step('INC', { opId: s.state.entries[0].op_id }));
        assert.deepEqual([r.ok, r.code], [false, 'DUPLICATE_OP']);
    });
});

describe('WT-F4-02 Decision inválida → FAIL(DECISION) em cada variante', () => {
    const variants = {
        EXPIRED: { state: 'EXPIRED' }, SUPERSEDED: { state: 'SUPERSEDED' }, UNKNOWN: { state: 'UNKNOWN' },
        'não aprobatória': { approving: false }, 'hash diferente': { command_sha256: F.H('9') },
        'op_id diferente': { authorized_op_id: 'op:prisma:spec-change:INC:outro' },
        'direito false': { approver_current_right: false }, 'direito UNKNOWN': { approver_current_right: 'UNKNOWN' },
    };
    for (const [name, rec] of Object.entries(variants)) {
        it(name, async () => {
            const r = await run(F.scenario().step('INC', { record: rec }));
            assert.deepEqual([r.ok, r.code], [false, 'DECISION'], JSON.stringify(r));
        });
    }
});

describe('WT-F4-02b Decision por request_id (RRC-SDD-002 §4.1 [r2], §4.3)', () => {
    it('derivação igual → PASS; diferente → FAIL(DECISION)', async () => {
        const s = F.scenario();
        const st = s.step('INC', { opId: cmd.deriveOpId('prisma', 'spec-change', 'INC', 'req-77') });
        const base = { ...st.records[st.entry.decision_ref] };
        delete base.authorized_op_id;
        const ok = await run(st, { records: { [st.entry.decision_ref]: { ...base, request_id: 'req-77' } } });
        assert.equal(ok.ok, true, JSON.stringify(ok));
        const bad = await run(st, { records: { [st.entry.decision_ref]: { ...base, request_id: 'req-78' } } });
        assert.deepEqual([bad.ok, bad.code], [false, 'DECISION']);
    });
});

describe('WT-F4-03 decision_ref já usado em outra entrada → FAIL(DECISION) (C-14)', () => {
    it('uso único registrado na própria entrada do log', async () => {
        const s = afterInc();
        const st = s.step('INC', { decisionRef: s.state.entries[0].decision_ref });
        const r = await run(st);
        assert.deepEqual([r.ok, r.code, r.reason], [false, 'DECISION', 'DECISION_CONSUMED']);
    });
});

describe('WT-F4-04 crash antes da integração e reapresentação com a geração válida (caso 7)', () => {
    it('PASS: a Decision não foi consumida', async () => {
        const s = afterInc();
        const st = s.step('INC'); // preparado, nunca integrado (crash)
        const again = await run(st);
        assert.equal(again.ok, true, JSON.stringify(again));
    });
});

describe('WT-F4-05 P-1 (i)–(iii), cada uma violada isoladamente → FAIL(P1)', () => {
    const cases = {
        '(i) digest da promoção': { mutate: c => { c.approved_payload.source_promotion.spec_sha256 = F.H('7'); } },
        '(i) observed_contract_hash': { mutate: c => { c.approved_payload.source_promotion.observed_contract_hash = F.H('7'); } },
        '(i) blob preservado ausente': { mutateFiles: f => { for (const k of Object.keys(f)) if (k.includes('/blobs/')) delete f[k]; } },
        '(i) campo da promoção ausente': { mutateFiles: f => { const k = 'docs/sdd/changes/PRI-900/promotions.json'; const a = JSON.parse(f[k]); delete a[0].sealed_contract_hash; f[k] = Buffer.from(JSON.stringify(a)); } },
        '(ii) quarentena sem saída (D-231-7 C)': { mutateFiles: f => { const k = 'docs/sdd/changes/PRI-900/promotions.json'; const a = JSON.parse(f[k]); a[0].post_verify_contract_change = true; f[k] = Buffer.from(JSON.stringify(a)); } },
        '(ii) LEGACY_UNVERSIONED': { mutateFiles: f => { const k = 'docs/sdd/changes/PRI-900/promotions.json'; const a = JSON.parse(f[k]); a[0].contract = 'LEGACY_UNVERSIONED'; f[k] = Buffer.from(JSON.stringify(a)); } },
        '(iii) validation_ref.promotion_id': { mutate: c => { c.approved_payload.validation_ref.promotion_id = 'PRI-900:exec-1:2'; } },
        '(iii) validation_ref.execution_id': { mutate: c => { c.approved_payload.validation_ref.execution_id = 'exec-2'; } },
        '(iv) tipo errado no Prisma (qa_approved)': { mutate: c => { c.approved_payload.validation_ref.kind = 'qa_approved'; } },
    };
    for (const [name, opts] of Object.entries(cases)) {
        it(name, async () => {
            const r = await run(F.scenario().step('INC', opts));
            assert.deepEqual([r.ok, r.code], [false, 'P1'], JSON.stringify(r));
        });
    }
    it('(iv) identidade: projeto admitido ≠ projeto do comando', async () => {
        const s = F.scenario({ extraFiles: F.admittedFiles('outro-projeto') });
        const r = await run(s.step('INC'));
        assert.deepEqual([r.ok, r.code, r.reason], [false, 'P1', 'IDENTITY_NOT_ADMITTED']);
    });
});

describe('WT-F4-06 consumidor com verify_pass; chave que tenta dispensar o QA → FAIL(P1)', () => {
    it('fora do Prisma só qa_approved', async () => {
        const s = F.scenario({ project: 'app-back' });
        const r = await run(s.step('INC', { mutate: c => { c.approved_payload.validation_ref.kind = 'verify_pass'; } }));
        assert.deepEqual([r.ok, r.code, r.reason], [false, 'P1', 'VALIDATION_KIND']);
        const ok = await run(F.scenario({ project: 'app-back' }).step('INC'));
        assert.equal(ok.ok, true, JSON.stringify(ok));
    });
    it('política admitida com chave extra de dispensa', async () => {
        const s = F.scenario({ extraFiles: F.admittedFiles('prisma', { extra: { incorporation_validation: 'none' } }) });
        const r = await run(s.step('INC'));
        assert.deepEqual([r.ok, r.code], [false, 'P1']);
    });
});

describe('WT-F4-07 handback sem promoção (U-H3-6; H3 R2-01) → FAIL(P1)', () => {
    it('sem promotions.json para o execution_id atestado', async () => {
        const r = await run(F.scenario().step('INC', { mutateFiles: f => { delete f['docs/sdd/changes/PRI-900/promotions.json']; } }));
        assert.deepEqual([r.ok, r.code, r.reason], [false, 'P1', 'NO_PROMOTION_HANDBACK']);
    });
    it('execution_id atestado de outro ciclo, sem promoção', async () => {
        const r = await run(F.scenario().step('INC', { mutate: c => {
            c.approved_payload.source_promotion.promotion_id = 'PRI-900:exec-9:1';
            c.approved_payload.validation_ref.promotion_id = 'PRI-900:exec-9:1';
            c.approved_payload.validation_ref.execution_id = 'exec-9';
        } }));
        assert.deepEqual([r.ok, r.code, r.reason], [false, 'P1', 'NO_PROMOTION_HANDBACK']);
    });
});

describe('WT-F4-08 E-02: digest atual ausente ou divergente → FAIL(E02)', () => {
    it('divergente', async () => {
        const r = await run(F.scenario().step('INC', { mutateFiles: f => { f[cmd.ADMITTED_POLICY] = canonicalBytes({ schema: 'sdd-admitted-policy-v1', incorporation_rule: 'DS-03c' }); } }));
        assert.deepEqual([r.ok, r.code], [false, 'E02']);
    });
    it('ausente', async () => {
        const r = await run(F.scenario().step('INC', { mutateFiles: f => { delete f[cmd.ADMITTED_PROJECT]; } }));
        assert.deepEqual([r.ok, r.code], [false, 'E02']);
    });
});

describe('WT-F4-09 E-02: commit independente que preserva os conteúdos → PASS (EM §3 prop. 4)', () => {
    it('base avançou por outro caminho; fontes iguais', async () => {
        const st = F.scenario().step('INC');
        const extra = { 'docs/outro/arquivo.md': Buffer.from('independente\n') };
        const r = await run(st, { over: {
            baseTree: require('./sdd-writer-git').memTree({ ...Object.fromEntries(Object.entries(st.files).filter(([k]) => !k.startsWith('docs/sdd/capabilities') && k !== cmd.CATALOG_PATH)), ...extra }),
            resultTree: require('./sdd-writer-git').memTree({ ...st.files, ...extra }),
        } });
        assert.equal(r.ok, true, JSON.stringify(r));
    });
});

describe('WT-F4-10 geração ou expected_active divergente → FAIL(STALE) (PR §5.4, 3′ e 7)', () => {
    it('expected_generation', async () => {
        const s = afterInc();
        const r = await run(s.step('INC', { mutate: c => { c.expected_generation = 0; } }));
        assert.deepEqual([r.ok, r.code], [false, 'STALE']);
    });
    it('expected_active (ACTIVATE, com U-002-8 injetada só em teste)', async () => {
        const s = afterInc();
        const r = await run(s.step('ACTIVATE', { mutate: c => { c.approved_payload.expected_active = { cap_version: 1, cap_hash: F.H('1') }; } }), { over: { conditions: TEST_ONLY } });
        assert.deepEqual([r.ok, r.code], [false, 'STALE']);
    });
});

describe('WT-F4-11 alias duplicado no projeto → FAIL(ALIAS) (V-10; R-RRC-01d A)', () => {
    it('outra capability já tem o valor vigente', async () => {
        const a = F.scenario({ slug: 'alpha' });
        a.commit(a.step('INC'));
        const resolver = sha => ({ [F.H('a')]: editAdd('task-76@v80'), [F.H('b')]: editAdd('task-76@v80') }[sha] || null);
        a.commit(a.step('EDIT_ALIASES_SOURCES', { editResolver: resolver, editSha: F.H('a') }));
        const capFiles = Object.fromEntries(Object.entries(a.state.files).filter(([k]) => k.startsWith('docs/sdd/capabilities/alpha/')));
        const b = F.scenario({ slug: 'beta', extraFiles: capFiles });
        b.commit(b.step('INC', { editResolver: resolver }));
        const st = b.step('EDIT_ALIASES_SOURCES', { editResolver: resolver, editSha: F.H('b') });
        const r = await run(st, { over: { conditions: TEST_ONLY } });
        assert.deepEqual([r.ok, r.code], [false, 'ALIAS'], JSON.stringify(r));
        const unique = b.step('EDIT_ALIASES_SOURCES', { editResolver: sha => (sha === F.H('c') ? editAdd('task-99@v80') : resolver(sha)), editSha: F.H('c') });
        const ok = await run(unique, { over: { conditions: TEST_ONLY } });
        assert.equal(ok.ok, true, JSON.stringify(ok));
    });
});

describe('WT-F4-12 porta com erro ou indeterminação → FAIL', () => {
    it('exceção/timeout → FAIL(UNVERIFIABLE) (transitório, R4-01)', async () => {
        const st = F.scenario().step('INC');
        const r = await run(st, { port: createTestDecisionPort(st.records, { fail: { '*': 'throw' } }) });
        assert.deepEqual([r.ok, r.code], [false, 'UNVERIFIABLE']);
    });
    it('campo indeterminado ou registro inexistente → FAIL(DECISION) (definitivo)', async () => {
        const st = F.scenario().step('INC');
        for (const rec of [undefined, { ...st.records[st.entry.decision_ref], approving: 'talvez' }, { ...st.records[st.entry.decision_ref], record_digest: undefined }]) {
            const r = await run(st, { records: rec === undefined ? {} : { [st.entry.decision_ref]: rec } });
            assert.deepEqual([r.ok, r.code], [false, 'DECISION']);
        }
    });
});

describe('WT-F4-14 E-01: fonte fora da representação admitida (mesmo com digest igual) → FAIL(E01)', () => {
    it('policy_ref aponta cópia idêntica fora de docs/sdd/admitted/', async () => {
        const copy = 'docs/sdd/project/policy.json';
        const s = F.scenario({ extraFiles: { [copy]: F.admittedFiles()[cmd.ADMITTED_POLICY] } });
        const r = await run(s.step('INC', { mutate: c => { c.approved_payload.validation_basis.policy_ref.path = copy; } }));
        assert.deepEqual([r.ok, r.code], [false, 'E01']);
    });
});

describe('WT-F4-15 operação não-INC sem decisão da U-002-8 → FAIL(U0028)', () => {
    it('ACTIVATE fica impedida em produção', async () => {
        const s = afterInc();
        const r = await run(s.step('ACTIVATE'));
        assert.deepEqual([r.ok, r.code], [false, 'U0028']);
        const injected = await run(s.step('ACTIVATE'), { over: { conditions: TEST_ONLY } });
        assert.equal(injected.ok, true, JSON.stringify(injected));
    });
});

describe('WT-F4-16 estado de auditoria da base ≠ OK (V-0; C-22; R4-02)', () => {
    for (const [st, code] of [['UNKNOWN', 'UNKNOWN'], ['VIOLATION', 'VIOLATION'], ['UNVERIFIABLE', 'UNVERIFIABLE'], [undefined, 'UNKNOWN']]) {
        it(`${st} → FAIL(${code})`, async () => {
            const r = await run(F.scenario().step('INC'), { over: { auditState: st } });
            assert.deepEqual([r.ok, r.code], [false, code]);
        });
    }
});

describe('WT-F4-17 modo histórico: fonte atual mudou, validation_basis histórica confere', () => {
    it('append validado com as fontes da própria operação; com fontes latest, não', async () => {
        const st = F.scenario().step('INC');
        const hist = { mode: 'historical', auditState: undefined, atCommit: 'append-sha' };
        const r = await run(st, { over: hist });
        assert.equal(r.ok, true, JSON.stringify(r));
        const latest = require('./sdd-writer-git').memTree({ ...st.files, [cmd.ADMITTED_POLICY]: canonicalBytes({ schema: 'sdd-admitted-policy-v1', incorporation_rule: 'DS-03c' }) });
        const wrong = await run(st, { over: { ...hist, sourcesTree: latest } });
        assert.deepEqual([wrong.ok, wrong.code], [false, 'E02']);
    });
});

describe('WT-F4-18 modo histórico: direito do aprovador revogado depois do append', () => {
    it('validado (direito atual não entra); no modo new, recusado', async () => {
        const st = F.scenario().step('INC', { record: { approver_current_right: false } });
        const h = await run(st, { over: { mode: 'historical', auditState: undefined, atCommit: 'append-sha' } });
        assert.equal(h.ok, true, JSON.stringify(h));
        const n = await run(st);
        assert.deepEqual([n.ok, n.code], [false, 'DECISION']);
    });
});

describe('WT-F4-20 modo histórico: append não validado em cada variante', () => {
    const hist = { mode: 'historical', auditState: undefined, atCommit: 'append-sha' };
    it('op_id repetido', async () => {
        const s = afterInc();
        assert.equal((await run(s.step('INC', { opId: s.state.entries[0].op_id }), { over: hist })).code, 'DUPLICATE_OP');
    });
    it('decision_ref reutilizado', async () => {
        const s = afterInc();
        assert.equal((await run(s.step('INC', { decisionRef: s.state.entries[0].decision_ref }), { over: hist })).code, 'DECISION');
    });
    it('P-1 histórica violada', async () => {
        const st = F.scenario().step('INC', { mutate: c => { c.approved_payload.validation_ref.execution_id = 'exec-2'; } });
        assert.equal((await run(st, { over: hist })).code, 'P1');
    });
    it('alias duplicado naquele commit', async () => {
        const a = F.scenario({ slug: 'alpha' });
        a.commit(a.step('INC'));
        const resolver = sha => ({ [F.H('a')]: editAdd('task-76@v80'), [F.H('b')]: editAdd('task-76@v80') }[sha] || null);
        a.commit(a.step('EDIT_ALIASES_SOURCES', { editResolver: resolver, editSha: F.H('a') }));
        const capFiles = Object.fromEntries(Object.entries(a.state.files).filter(([k]) => k.startsWith('docs/sdd/capabilities/alpha/')));
        const b = F.scenario({ slug: 'beta', extraFiles: capFiles });
        b.commit(b.step('INC', { editResolver: resolver }));
        const st = b.step('EDIT_ALIASES_SOURCES', { editResolver: resolver, editSha: F.H('b') });
        assert.equal((await run(st, { over: { ...hist, conditions: TEST_ONLY } })).code, 'ALIAS');
    });
});

describe('WT-266-04 Decision/revogação lida de árvore controlada pelo PR (M-02)', () => {
    it('a porta lê só at_commit = base; arquivo de Decision no PR é ignorado', async () => {
        const st = F.scenario().step('INC');
        const dir = 'docs/sdd/admitted/decisions';
        const recordFile = `${dir}/${st.entry.decision_ref}.json`;
        const withDecision = { ...st.files, [recordFile]: Buffer.from(JSON.stringify(st.records[st.entry.decision_ref])) };
        const trees = { 'base-sha': st.baseTree, 'result-tree': require('./sdd-writer-git').memTree(withDecision) };
        const fakeGit = { readBlob: (c, p) => trees[c].read(p) };
        const port = createTreeDecisionPort(fakeGit, dir);
        const r = await decide({ ...st.ctx, resultTree: trees['result-tree'], decisionPort: port });
        assert.deepEqual([r.ok, r.code], [false, 'DECISION']);
        assert.deepEqual(port.calls.map(c => c.atCommit), ['base-sha']);
    });
    it('revogação presente só na árvore do PR não reabilita; presente na base vale', async () => {
        const st = F.scenario().step('INC');
        const dir = 'docs/sdd/admitted/decisions';
        const recordFile = `${dir}/${st.entry.decision_ref}.json`;
        const rec = Buffer.from(JSON.stringify(st.records[st.entry.decision_ref]));
        const revoked = Buffer.from(JSON.stringify({ ...st.records[st.entry.decision_ref], approver_current_right: false }));
        const mem = require('./sdd-writer-git').memTree;
        const base = { ...Object.fromEntries(Object.entries(st.baseTree.list('').size ? [] : [])) };
        void base;
        const trees = { 'base-sha': mem({ ...st.files, [recordFile]: revoked }), 'result-tree': mem({ ...st.files, [recordFile]: rec }) };
        const port = createTreeDecisionPort({ readBlob: (c, p) => trees[c].read(p) }, dir);
        const r = await decide({ ...st.ctx, resultTree: trees['result-tree'], decisionPort: port });
        assert.deepEqual([r.ok, r.code, r.reason], [false, 'DECISION', 'APPROVER_RIGHT']);
    });
});

describe('WT-F4-13 sabotagens (uma de cada vez): o caso ruim correspondente passa', () => {
    const cases = [
        ['V-4', 'sdd-writer-decide.js', 'V-4', s => s.step('INC', { opId: s.state.entries[0].op_id, decisionRef: 'D-new' })],
        ['V-5', 'sdd-writer-decide.js', 'V-5', s => s.step('INC', { record: { approving: false } })],
        ['C-14', 'sdd-writer-decide.js', 'C-14', s => s.step('INC', { decisionRef: s.state.entries[0].decision_ref })],
        ['V-6 P-1', 'sdd-writer-decide.js', 'P-1', s => s.step('INC', { mutate: c => { c.approved_payload.validation_ref.kind = 'qa_approved'; } })],
        ['V-7 E-01', 'sdd-writer-decide.js', 'E-01', null],
        ['V-7 E-02', 'sdd-writer-decide.js', 'E-02', s => s.step('INC', { mutate: c => { c.approved_payload.validation_basis.policy_ref.sha256 = F.H('3'); } })],
        ['V-8', 'sdd-writer-log.js', 'V-8-GEN', s => s.step('INC', { mutate: c => { c.expected_generation = 7; }, mutateEntry: e => { e.result = 'inc_version_created'; } })],
        ['V-0', 'sdd-writer-decide.js', 'V-0', s => ({ ...s.step('INC'), audit: 'UNKNOWN' })],
        ['R4-02 UNVERIFIABLE como OK', 'sdd-writer-decide.js', 'R4-02', s => ({ ...s.step('INC'), audit: 'UNVERIFIABLE' })],
        ['U-002-8', 'sdd-writer-decide.js', 'U0028', s => s.step('ACTIVATE')],
    ];
    for (const [name, file, guard, mk] of cases) {
        it(name, async () => {
            const s = afterInc();
            let st;
            if (guard === 'E-01') {
                const copy = 'docs/sdd/project/policy.json';
                const s2 = F.scenario({ extraFiles: { [copy]: F.admittedFiles()[cmd.ADMITTED_POLICY] } });
                s2.commit(s2.step('INC'));
                st = s2.step('INC', { mutate: c => { c.approved_payload.validation_basis.policy_ref.path = copy; } });
            } else {
                st = mk(s);
            }
            const over = st.audit ? { auditState: st.audit } : {};
            const normal = await run(st, { over });
            assert.equal(normal.ok, false, `proteção ${name} deveria recusar`);
            const m = loadMutant([file, guard]);
            // O writer sabotado gera o próprio catálogo (consistente com a sua regra).
            const files = { ...st.files };
            const cat = m.catalog.generateCatalog(m.git.memTree(files), { editResolver: st.ctx.editResolver });
            if (cat) files[cmd.CATALOG_PATH] = cat;
            const sabotaged = await run(st, { over: { ...over, resultTree: m.git.memTree(files, 'result') }, impl: decideOf(m) });
            assert.equal(sabotaged.ok, true, `sem ${name} o caso ruim deveria passar: ${JSON.stringify(sabotaged)}`);
        });
    }
});

describe('WT-F4-19 sabotagem do modo histórico: exigir direito atual', () => {
    it('WT-F4-18 falha', async () => {
        const st = F.scenario().step('INC', { record: { approver_current_right: false } });
        const m = loadMutant(['sdd-writer-decide.js', 'HIST-RIGHT']);
        const r = await run(st, { over: { mode: 'historical', auditState: undefined, atCommit: 'append-sha' }, impl: decideOf(m) });
        assert.deepEqual([r.ok, r.code], [false, 'DECISION']);
    });
});
