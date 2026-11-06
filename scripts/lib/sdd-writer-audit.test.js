'use strict';
// PRI-266 F7 — W-A: auditoria, âncoras e estado derivado (C-16, C-17, C-22, C-24; EM §3
// prop. 6 herdada da PRI-230; R4-01, R4-N1). WT-F7-01…17, WT-F4-19 (fontes latest),
// WT-266-03 (alias ambíguo herdado).

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const cmd = require('./sdd-writer-command');
const { canonicalBytes } = require('./sdd-writer-jcs');
const { appendBytes } = require('./sdd-writer-log');
const { memTree } = require('./sdd-writer-git');
const { decide } = require('./sdd-writer-decide');
const { createTestDecisionPort } = require('./sdd-writer-decision');
const { projectCapabilities, resolveAlias, ambiguousAliases, generateCatalog } = require('./sdd-writer-catalog');
const { auditCapability, runAudit } = require('./sdd-writer-audit');
const { makeEnv } = require('./sdd-writer-hostsim');
const { loadMutant, fixtures: F } = require('./sdd-writer-testkit');

const SLUG = 'spec-change';
const LOG = cmd.logPath(SLUG);
const WC = 'sdd-writer-check';
const WA = 'sdd-writer-audit';

const audit = (env, mode = 'full', impl = auditCapability, extra = {}) => impl({ git: env.git, host: env.host, tip: env.host.tip(), project: 'prisma', slug: SLUG, decisionPort: env.port, mode, ...extra });
const wa = (env, impl = runAudit) => impl({ git: env.git, host: env.host, registryBranch: 'main', project: 'prisma', decisionPort: env.port });

async function envWith(n = 1) {
    const env = makeEnv();
    for (let i = 0; i < n; i++) {
        const r = await env.integrate(env.s.step('INC', { specText: F.specText(`v${i}`) }));
        assert.equal(r.res.status, 'PASS', JSON.stringify(r.res));
    }
    return env;
}

/** Commit de admin (bypass) sobre o tip, com `files` completos. */
function adminCommit(env, files, { forgeStatus = false } = {}) {
    const tip = env.host.tip();
    const c = env.host.commitFiles(files, [tip], 'admin', 'admin');
    if (forgeStatus) env.host.statuses.set(`${env.git.treeOf(c)}|${tip}`, { state: 'PASS', identity: WC });
    env.host.adminPush(c);
    return c;
}
/** Append válido em bytes, feito por admin. */
function adminAppend(env, st, opts) {
    Object.assign(env.records, st.records);
    const c = adminCommit(env, st.files, opts);
    env.s.commit(st);
    return c;
}

describe('WT-F7-01 integração com W-C PASS e auditoria histórica OK', () => {
    it('tag g<N> criada no commit certo, com criador = W-A', async () => {
        const env = await envWith(1);
        const rep = await wa(env);
        assert.deepEqual(rep.anchorsCreated, ['sdd/prisma/spec-change/g1']);
        assert.equal(env.host.tags.get('sdd/prisma/spec-change/g1').commit, env.host.tip());
        assert.equal(env.host.tags.get('sdd/prisma/spec-change/g1').creator, WA);
        assert.equal(rep.capabilities[SLUG].state, 'OK');
    });
});

describe('WT-F7-01b commit sem status W-C PASS, mesmo com bytes válidos', () => {
    it('sem tag; capability UNKNOWN', async () => {
        const env = makeEnv();
        adminAppend(env, env.s.step('INC'));
        const rep = await wa(env);
        assert.deepEqual(rep.anchorsCreated, []);
        assert.equal(rep.capabilities[SLUG].state, 'UNKNOWN');
    });
});

describe('WT-F7-12 sabotagem: criar tag sem exigir status W-C', () => {
    it('WT-F7-01b falha: a tag aparece', async () => {
        const m = loadMutant(['sdd-writer-audit.js', 'WC-STATUS']);
        const env = makeEnv();
        adminAppend(env, env.s.step('INC'));
        const rep = await wa(env, m.audit.runAudit);
        assert.deepEqual(rep.anchorsCreated, ['sdd/prisma/spec-change/g1']);
    });
});

describe('WT-F7-01c commit integrado com SHA diferente do avaliado', () => {
    it('merge commit com a mesma árvore e primeiro pai = base → validado; árvore diferente → não', async () => {
        const env = makeEnv();
        const r = await env.integrate(env.s.step('INC'), { mode: 'merge' });
        assert.equal(r.merge.merged, true);
        assert.notEqual(r.merge.commit, r.pr.head);
        assert.equal((await wa(env)).anchorsCreated.length, 1);
        // árvore diferente da avaliada (admin acrescenta arquivo no mesmo commit)
        const env2 = makeEnv();
        const st = env2.s.step('INC');
        const pr = env2.propose(st);
        const chk = await env2.check(pr);
        assert.equal(chk.status, 'PASS');
        adminCommit(env2, { ...st.files, 'docs/extra.md': Buffer.from('x') });
        assert.equal((await audit(env2)).state, 'UNKNOWN');
    });
});

describe('WT-F7-11 reescrita no meio do log preservando a ancestralidade do commit âncora', () => {
    it('VIOLATION pelo prefixo', async () => {
        const env = await envWith(2);
        await wa(env);
        const files = { ...env.s.state.files, [LOG]: Buffer.from(env.s.state.files[LOG].toString().replace('"at":"2026-11-06T12:00:00Z"', '"at":"2026-11-06T12:00:01Z"')) };
        adminCommit(env, files);
        assert.equal((await audit(env)).state, 'VIOLATION');
    });
});

describe('WT-F7-08 sabotagem: sem conferir o prefixo de bytes da âncora', () => {
    it('a reescrita no meio deixa de ser VIOLATION', async () => {
        const m = loadMutant(['sdd-writer-audit.js', 'ANCHOR-PREFIX']);
        const env = await envWith(2);
        await wa(env);
        const files = { ...env.s.state.files, [LOG]: Buffer.from(env.s.state.files[LOG].toString().replace('"at":"2026-11-06T12:00:00Z"', '"at":"2026-11-06T12:00:01Z"')) };
        adminCommit(env, files);
        assert.notEqual((await audit(env, 'full', m.audit.auditCapability)).state, 'VIOLATION');
    });
});

describe('WT-F7-13 capability UNKNOWN é permanente', () => {
    it('nenhum papel volta a OK sem artefato novo; o W-C segue recusando', async () => {
        const env = await envWith(1);
        adminAppend(env, env.s.step('INC', { specText: F.specText('admin') }));
        for (let i = 0; i < 2; i++) assert.equal((await audit(env)).state, 'UNKNOWN');
        const next = await env.integrate(env.s.step('INC', { specText: F.specText('depois') }));
        assert.deepEqual([next.res.status, next.res.code], ['FAIL', 'UNKNOWN']);
        assert.equal((await audit(env)).state, 'UNKNOWN');
    });
});

describe('WT-F7-15 auditoria com a API do host falhando de forma transitória (R3-01)', () => {
    it('UNVERIFIABLE; com a API restabelecida, volta a OK sem nenhum artefato', async () => {
        const env = await envWith(1);
        env.host.faults.api = true;
        assert.equal((await audit(env)).state, 'UNVERIFIABLE');
        env.host.faults.api = false;
        const tagsBefore = env.host.tags.size;
        assert.equal((await audit(env)).state, 'OK');
        assert.equal(env.host.tags.size, tagsBefore);
    });
    it('precedência R4-N1: VIOLATION > UNKNOWN > UNVERIFIABLE', () => {
        const { worst } = require('./sdd-writer-log');
        assert.equal(worst('UNVERIFIABLE', 'UNKNOWN'), 'UNKNOWN');
        assert.equal(worst('UNKNOWN', 'VIOLATION', 'UNVERIFIABLE'), 'VIOLATION');
        assert.equal(worst('OK', 'UNVERIFIABLE'), 'UNVERIFIABLE');
    });
});

describe('WT-F7-16 rebase/fast-forward com dois commits; push com vários commits (prop. 6)', () => {
    it('o host recusa a modalidade; se ocorrer por admin, UNKNOWN', async () => {
        const env = makeEnv();
        const st = env.s.step('INC');
        const pr = env.propose(st);
        assert.deepEqual(await env.host.merge(pr.number, 'rebase'), { merged: false, reason: 'MODE_NOT_ALLOWED' });
        // admin empurra dois commits de uma vez: o intermediário não tem status
        const tip = env.host.tip();
        const c1 = env.host.commitFiles(st.files, [tip], 'a1', 'admin');
        Object.assign(env.records, st.records);
        env.s.commit(st);
        const st2 = env.s.step('INC', { specText: F.specText('2') });
        Object.assign(env.records, st2.records);
        const c2 = env.host.commitFiles(st2.files, [c1], 'a2', 'admin');
        env.host.statuses.set(`${env.git.treeOf(c2)}|${c1}`, { state: 'PASS', identity: WC }); // só o último "avaliado"
        env.host.adminPush(c2);
        const a = await audit(env);
        assert.equal(a.state, 'UNKNOWN');
        assert.ok(a.reasons.some(r => r.includes(c1.slice(0, 12)) && r.includes('NO_WC_PASS')), a.reasons.join());
    });
});

describe('WT-F7-17 tag g<N> leve, sem criador verificável', () => {
    it('não conta como âncora válida', async () => {
        const env = await envWith(1);
        const old = env.git.firstParent(env.host.tip());
        env.host.forgeTag('sdd/prisma/spec-change/g9', old, null); // aponta commit sem o log
        assert.equal((await audit(env)).state, 'OK');
        env.host.forgeTag('sdd/prisma/spec-change/g8', old, WA);
        assert.equal((await audit(env)).state, 'VIOLATION');
    });
});

describe('WT-F7-14 tag g<N> forjada (C-24 R2-03)', () => {
    it('identidade ≠ W-A: ignorada; identidade W-A sobre append não validado: a reauditoria desde a gênese detecta', async () => {
        const env = await envWith(1);
        adminAppend(env, env.s.step('INC', { specText: F.specText('sem decisao') }), { forgeStatus: false });
        const c3 = adminAppend(env, env.s.step('INC', { specText: F.specText('3') }), { forgeStatus: true });
        env.host.forgeTag('sdd/prisma/spec-change/g3', c3, 'outra-identidade');
        assert.equal((await audit(env, 'incremental')).state, 'UNKNOWN', 'tag de outra identidade é ignorada');
        env.host.deleteTagAdmin('sdd/prisma/spec-change/g3');
        env.host.forgeTag('sdd/prisma/spec-change/g3', c3, WA);
        assert.equal((await audit(env, 'incremental')).state, 'OK', 'o W-C incremental confia na âncora (resíduo C-24)');
        assert.equal((await audit(env, 'full')).state, 'UNKNOWN', 'o W-A desde a gênese detecta');
    });
});

describe('WT-F7-02 append de admin canônico com status forjado, mas sem Decision válida ou base histórica', () => {
    const variants = {
        'Decision inexistente': (env, st) => { for (const r of [env.records, env.s.state.records]) delete r[st.entry.decision_ref]; },
        'Decision para outro hash': (env, st) => { for (const r of [env.records, env.s.state.records]) r[st.entry.decision_ref] = { ...r[st.entry.decision_ref], command_sha256: F.H('9') }; },
        'validation_basis que não confere': null,
    };
    for (const [name, spoil] of Object.entries(variants)) {
        it(`${name} → UNKNOWN; a operação seguinte cai em FAIL(UNKNOWN)`, async () => {
            const env = await envWith(1);
            const st = spoil ? env.s.step('INC', { specText: F.specText('x') })
                : env.s.step('INC', { specText: F.specText('x'), mutate: c => { c.approved_payload.validation_basis.policy_ref.sha256 = F.H('4'); } });
            adminAppend(env, st, { forgeStatus: true });
            if (spoil) spoil(env, st);
            assert.equal((await audit(env)).state, 'UNKNOWN');
            const next = await env.integrate(env.s.step('INC', { specText: F.specText('y') }));
            assert.equal(next.res.code, 'UNKNOWN');
        });
    }
});

/** Force-push de um histórico reescrito com os MESMOS bytes: só a ancestralidade denuncia. */
function rewriteSameBytes(env) {
    env.host.adminPush(env.host.commitFiles(env.s.state.files, [], 'reescrito', 'admin'));
}

describe('WT-F7-03 force-push que tira o commit ancorado da ancestralidade', () => {
    it('VIOLATION (voltar a estado anterior e reescrever com os mesmos bytes)', async () => {
        const env = await envWith(2);
        await wa(env);
        env.host.adminPush(env.git.firstParent(env.host.tip()));
        assert.equal((await audit(env)).state, 'VIOLATION');
        const env2 = await envWith(1);
        await wa(env2);
        rewriteSameBytes(env2);
        assert.equal((await audit(env2)).state, 'VIOLATION');
    });
});

describe('WT-F7-07 sabotagem: sem conferir a ancestralidade', () => {
    it('WT-F7-03 deixa de ser VIOLATION', async () => {
        const m = loadMutant(['sdd-writer-audit.js', 'ANCHOR-ANCESTRY']);
        const env = await envWith(1);
        await wa(env);
        rewriteSameBytes(env);
        assert.notEqual((await audit(env, 'full', m.audit.auditCapability)).state, 'VIOLATION');
    });
});

describe('WT-F7-04 log apagado por admin (caso 10)', () => {
    it('VIOLATION, nunca geração 0', async () => {
        const env = await envWith(1);
        const files = { ...env.s.state.files };
        delete files[LOG];
        adminCommit(env, files);
        assert.equal((await audit(env)).state, 'VIOLATION');
        // mesmo sem âncora: o histórico basta (C-17)
        assert.equal(env.host.tags.size, 0);
    });
});

describe('WT-F7-05 bytes parciais por admin (caso 9)', () => {
    it('UNKNOWN; nenhuma correção', async () => {
        const env = await envWith(1);
        const partial = Buffer.concat([env.s.state.files[LOG].subarray(0, env.s.state.files[LOG].length - 1), Buffer.from(',{"generation":2')]);
        adminCommit(env, { ...env.s.state.files, [LOG]: partial });
        const tip = env.host.tip();
        const rep = await wa(env);
        assert.equal(rep.capabilities[SLUG].state, 'UNKNOWN');
        assert.equal(env.host.tip(), tip);
        assert.ok(env.git.readBlob(tip, LOG).equals(partial));
    });
});

describe('WT-F7-06 ref órfã com desfecho certo / sem desfecho', () => {
    it('removida / mantida', async () => {
        const env = await envWith(1); // integrate não libera o marcador: fica órfão já aplicado?
        const marker = cmd.markerRef('prisma', SLUG);
        // ref de voo apontando para o commit do PR integrado (desfecho certo: op_id no log)
        const head = env.host.prs[0].head;
        await env.host.deleteRef(marker); // branch do PR integrado (fora do W-P)
        const msgCommit = env.git.commitTree(env.git.treeOf(head), [env.git.firstParent(head)], `x\n\nop_id: ${env.s.state.entries[0].op_id}\n`, 'richard');
        await env.host.createRefIfAbsent(marker, msgCommit);
        let rep = await wa(env);
        assert.deepEqual(rep.markersRemoved, [marker]);
        // sem desfecho: op_id fora do log e PR aberto
        const st = env.s.step('INC', { specText: F.specText('em voo') });
        const c = env.git.commitTree(env.git.treeOf(env.host.tip()), [env.host.tip()], `y\n\nop_id: ${st.entry.op_id}\n`, 'richard');
        await env.host.createRefIfAbsent(marker, c);
        await env.host.openPR({ branch: cmd.markerBranch('prisma', SLUG), author: 'richard', head: c });
        rep = await wa(env);
        assert.deepEqual([rep.markersRemoved, rep.markersKept], [[], [marker]]);
    });
});

describe('WT-F7-09 resíduo C-24 (caracterização, não proteção)', () => {
    it('histórico reescrito + tags e log apagados é indistinguível de geração 0 dentro do host', async () => {
        const env = await envWith(1);
        await wa(env);
        const seedLike = Object.fromEntries(Object.entries(env.s.state.files).filter(([k]) => !k.startsWith('docs/sdd/capabilities/') && k !== cmd.CATALOG_PATH));
        env.host.adminPush(env.host.commitFiles(seedLike, [], 'reescrito', 'admin'));
        env.host.deleteTagAdmin('sdd/prisma/spec-change/g1');
        assert.equal((await audit(env)).state, 'OK');
    });
});

describe('WT-F7-10 estado UNKNOWN derivado sem arquivo nem flag', () => {
    it('a auditoria não grava nada além de âncoras', async () => {
        const env = await envWith(1);
        adminAppend(env, env.s.step('INC', { specText: F.specText('admin') }));
        const refsBefore = env.git.listRefs('refs/').map(r => r.name).sort();
        const tip = env.host.tip();
        const ls = t => env.git.run(['ls-tree', '-r', '--name-only', t]).stdout.toString();
        const files = ls(tip);
        await wa(env);
        await wa(env);
        const refsAfter = env.git.listRefs('refs/').map(r => r.name).sort();
        assert.deepEqual(refsAfter.filter(r => !refsBefore.includes(r)).every(r => r.startsWith('refs/tags/sdd/')), true);
        assert.equal(env.host.tip(), tip);
        assert.equal(ls(env.host.tip()), files);
        const src = require('node:fs').readFileSync(require('node:path').join(__dirname, 'sdd-writer-audit.js'), 'utf8');
        assert.doesNotMatch(src, /require\(['"]node:fs['"]\)|writeFile/);
    });
});

describe('WT-F4-19 (fiação do W-A) sabotagem: auditar com fontes latest', () => {
    it('política mudou depois do append: normal valida; com latest, não', async () => {
        const env = await envWith(1);
        const files = { ...env.s.state.files, [cmd.ADMITTED_POLICY]: canonicalBytes({ schema: 'sdd-admitted-policy-v1', incorporation_rule: 'DS-03b', v: 2 }) };
        adminCommit(env, files); // mudança de código/config, fora dos caminhos protegidos
        assert.equal((await audit(env)).state, 'OK');
        const m = loadMutant(['sdd-writer-audit.js', 'HIST-SOURCES']);
        assert.equal((await audit(env, 'full', m.audit.auditCapability)).state, 'UNKNOWN');
    });
});

describe('WT-266-03 ambiguidade de alias herdada da base (R-RRC-01d A, fallback e tombstone)', () => {
    const X = { kind: 'roadmap_card', value: 'task-76@v80' };
    const edits = { [F.H('a')]: { add: [X], retire: [] }, [F.H('b')]: { add: [X], retire: [] }, [F.H('c')]: { add: [], retire: [X] }, [F.H('e')]: { add: [{ kind: 'roadmap_card', value: 'task-1@v80' }], retire: [] } };
    const resolver = sha => edits[sha] || null;
    const TEST_ONLY = { u0028Decided: true };
    function bypassBase() {
        // alpha e beta recebem o mesmo alias (bypass de admin): o estado herdado é ambíguo.
        const a = F.scenario({ slug: 'alpha' });
        a.commit(a.step('INC'));
        a.commit(a.step('EDIT_ALIASES_SOURCES', { editResolver: resolver, editSha: F.H('a') }));
        const b = F.scenario({ slug: 'beta' });
        b.commit(b.step('INC'));
        b.commit(b.step('EDIT_ALIASES_SOURCES', { editResolver: resolver, editSha: F.H('b') }));
        const alphaFiles = Object.fromEntries(Object.entries(a.state.files).filter(([k]) => k.startsWith('docs/sdd/capabilities/alpha/')));
        const s = F.scenario({ slug: 'beta', extraFiles: alphaFiles });
        for (const st of b.state.entries) void st;
        // reaplica a história de beta no cenário combinado
        s.commit(s.step('INC'));
        s.commit(s.step('EDIT_ALIASES_SOURCES', { editResolver: resolver, editSha: F.H('b') }));
        return s;
    }
    it('fallback: os dois ficam AMBIGUOUS_ALIAS, sem vencedor', () => {
        const s = bypassBase();
        const caps = projectCapabilities(s.tree(), { editResolver: resolver });
        assert.deepEqual(resolveAlias(caps, X.kind, X.value), { status: 'AMBIGUOUS_ALIAS', ids: ['cap:prisma:alpha', 'cap:prisma:beta'] });
        assert.equal(ambiguousAliases(caps).length, 1);
    });
    it('W-C recusa alias novo que repete o valor; alias novo único passa mesmo com a ambiguidade herdada', async () => {
        const s = bypassBase();
        const dup = s.step('EDIT_ALIASES_SOURCES', { editResolver: sha => (sha === F.H('d') ? { add: [{ kind: 'module_name', value: 'x' }, X], retire: [] } : resolver(sha)), editSha: F.H('d') });
        const r = await decide({ ...dup.ctx, decisionPort: createTestDecisionPort(dup.records), conditions: TEST_ONLY });
        assert.equal(r.ok, false);
        const ok = s.step('EDIT_ALIASES_SOURCES', { editResolver: resolver, editSha: F.H('e') });
        const r2 = await decide({ ...ok.ctx, decisionPort: createTestDecisionPort(ok.records), conditions: TEST_ONLY });
        assert.equal(r2.ok, true, JSON.stringify(r2));
    });
    it('tombstone por Decision encerra; o vínculo retirado nunca é reativado', async () => {
        const s = bypassBase();
        const tomb = s.step('EDIT_ALIASES_SOURCES', { editResolver: resolver, editSha: F.H('c') });
        const r = await decide({ ...tomb.ctx, decisionPort: createTestDecisionPort(tomb.records), conditions: TEST_ONLY });
        assert.equal(r.ok, true, JSON.stringify(r));
        s.commit(tomb);
        const caps = projectCapabilities(s.tree(), { editResolver: resolver });
        assert.deepEqual(resolveAlias(caps, X.kind, X.value), { status: 'RESOLVED', id: 'cap:prisma:alpha' });
        const again = s.step('EDIT_ALIASES_SOURCES', { editResolver: resolver, editSha: F.H('b') });
        const r2 = await decide({ ...again.ctx, decisionPort: createTestDecisionPort(again.records), conditions: TEST_ONLY });
        assert.deepEqual([r2.ok, r2.code], [false, 'ALIAS']);
    });
});

void appendBytes; void memTree; void generateCatalog;
