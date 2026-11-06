'use strict';
// PRI-266 — regressões dos achados da revisão G3: revisor Opus (O-01…O-18, review-opus.md) e
// /code-review high (CR-1…CR-10). Cada proteção nova tem teste normal e sabotagem.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const cmd = require('./sdd-writer-command');
const { decide } = require('./sdd-writer-decide');
const { memTree } = require('./sdd-writer-git');
const { auditCapability, runAudit } = require('./sdd-writer-audit');
const { prepare, humanReleaseMarker } = require('./sdd-writer-prepare');
const { generateCatalog } = require('./sdd-writer-catalog');
const { makeEnv } = require('./sdd-writer-hostsim');
const { loadMutant, createTestDecisionPort, TEST_HOOKS, fixtures: F } = require('./sdd-writer-testkit');

const SLUG = 'spec-change';
const LOG = cmd.logPath(SLUG);
const MARKER = cmd.markerRef('prisma', SLUG);
const WC = 'sdd-writer-check';
const code = r => (r.status === 'PASS' ? 'PASS' : r.code);
const run = (st, over = {}, impl = decide) => impl({ ...st.ctx, decisionPort: createTestDecisionPort(st.records), ...over });
/** Árvore com o catálogo que o writer sabotado geraria (consistente com a regra dele). */
function mutantTree(m, files0) {
    const files = { ...files0 };
    const cat = m.catalog.generateCatalog(m.git.memTree(files));
    if (cat) files[cmd.CATALOG_PATH] = cat;
    return m.git.memTree(files, 'result');
}
const withCatalog = files => { const c = generateCatalog(memTree(files)); if (c) files[cmd.CATALOG_PATH] = c; return files; };

function wpArgs(env, st, over = {}) {
    Object.assign(env.records, st.records);
    return {
        git: env.git, host: env.host, registryBranch: 'main', project: 'prisma', slug: SLUG,
        command: st.entry.command, opId: st.entry.op_id, decisionRef: st.entry.decision_ref, actor: st.entry.actor,
        preparerId: 'wp-1', at: F.AT, specBytes: st.files[cmd.specPath(SLUG)] || null, decisionPort: env.port, ...over,
    };
}
const audit = (env, mode = 'full', impl = auditCapability) => impl({ git: env.git, host: env.host, tip: env.host.tip(), project: 'prisma', slug: SLUG, decisionPort: env.port, mode });

describe('O-01 delta fechado dentro de capabilities/<slug>/ (V-9-CLOSED)', () => {
    for (const [name, mutateFiles] of [
        ['arquivo novo (edits/evil.json)', f => { f[`${cmd.capDir(SLUG)}/edits/evil.json`] = Buffer.from('{}'); }],
        ['README novo', f => { f[`${cmd.capDir(SLUG)}/README.md`] = Buffer.from('x'); }],
    ]) {
        it(`${name} → FAIL(DERIVED); sem a proteção, passa`, async () => {
            const st = F.scenario().step('INC', { mutateFiles });
            const r = await run(st);
            assert.deepEqual([r.ok, r.code, r.reason], [false, 'DERIVED', 'CAPABILITY_DELTA_NOT_CLOSED']);
            const m = loadMutant(['sdd-writer-decide.js', 'V-9-CLOSED']);
            assert.equal((await run(st, {}, m.decide.decide)).ok, true);
        });
    }
    it('alterar ou apagar arquivo pré-existente fora do conjunto → FAIL(DERIVED)', async () => {
        const s = F.scenario({ extraFiles: { [`${cmd.capDir(SLUG)}/notas.md`]: Buffer.from('a') } });
        const alt = await run(s.step('INC', { mutateFiles: f => { f[`${cmd.capDir(SLUG)}/notas.md`] = Buffer.from('b'); } }));
        assert.equal(alt.reason, 'CAPABILITY_DELTA_NOT_CLOSED');
        const del = await run(s.step('INC', { mutateFiles: f => { delete f[`${cmd.capDir(SLUG)}/notas.md`]; } }));
        assert.equal(del.reason, 'CAPABILITY_DELTA_NOT_CLOSED');
    });
});

describe('O-02 lote não informado pelo host → FAIL(SCOPE)', () => {
    it('batchProtected ausente ou inválido', async () => {
        for (const v of [undefined, null, 0, '1', 1.5]) {
            const env = makeEnv();
            const pr = env.propose(env.s.step('INC'), { extra: { batchProtected: v } });
            const r = await env.check(pr);
            assert.deepEqual([r.status, r.code, r.reason], ['FAIL', 'SCOPE', 'BATCH_UNKNOWN'], String(v));
        }
    });
});

describe('O-03 V-10 com capability de estado indeterminado no projeto', () => {
    it('unicidade não demonstrável → FAIL(ALIAS)', async () => {
        const X = { kind: 'roadmap_card', value: 'task-76@v80' };
        const resolver = sha => ({ [F.H('b')]: { add: [X], retire: [] } }[sha] || null);
        const broken = { [cmd.logPath('alpha')]: Buffer.from('[{"quebrado":true} ') };
        const s = F.scenario({ extraFiles: broken });
        s.commit(s.step('INC', { editResolver: resolver }));
        const st = s.step('EDIT_ALIASES_SOURCES', { editResolver: resolver, editSha: F.H('b') });
        const r = await run(st, { [TEST_HOOKS]: { ...st.ctx[TEST_HOOKS], conditions: { u0028Decided: true } } });
        assert.deepEqual([r.ok, r.code, r.reason], [false, 'ALIAS', 'ALIAS_UNIQUENESS_UNDEMONSTRABLE']);
    });
});

describe('O-04 WT-266-03 refeito: a recusa vem da V-10, sobre a base com alias ambíguo', () => {
    it('capability sem X tenta X, que já é ambíguo em outras duas → ALIAS_NOT_UNIQUE_IN_PROJECT', async () => {
        const X = { kind: 'roadmap_card', value: 'task-76@v80' };
        const resolver = sha => (sha === F.H('a') ? { add: [X], retire: [] } : null);
        const capWithX = slug => {
            const c = F.scenario({ slug });
            c.commit(c.step('INC'));
            c.commit(c.step('EDIT_ALIASES_SOURCES', { editResolver: resolver, editSha: F.H('a') }));
            return Object.fromEntries(Object.entries(c.state.files).filter(([k]) => k.startsWith(`docs/sdd/capabilities/${slug}/`)));
        };
        const s = F.scenario({ extraFiles: { ...capWithX('alpha'), ...capWithX('gamma') } });
        s.commit(s.step('INC', { editResolver: resolver }));
        const st = s.step('EDIT_ALIASES_SOURCES', { editResolver: resolver, editSha: F.H('a') });
        const r = await run(st, { [TEST_HOOKS]: { ...st.ctx[TEST_HOOKS], conditions: { u0028Decided: true } } });
        assert.deepEqual([r.ok, r.code, r.reason], [false, 'ALIAS', 'ALIAS_NOT_UNIQUE_IN_PROJECT']);
    });
});

describe('O-05 W-A: PR integrado sem op_id no log é incerto', () => {
    it('a ref fica e é acusada; não é removida', async () => {
        const env = makeEnv();
        const r = await env.integrate(env.s.step('INC'));
        assert.equal(r.merge.merged, true);
        // marcador cujo PR integrou, mas cujo op_id não está no log (inconsistência)
        await env.host.deleteRef(MARKER);
        const fake = env.git.commitTree(env.git.treeOf(env.host.tip()), [env.host.tip()], 'x\n\nop_id: op:prisma:spec-change:INC:fantasma\n', 'richard');
        await env.host.createRefIfAbsent(MARKER, fake);
        env.host.prs.push({ number: 99, branch: cmd.markerBranch('prisma', SLUG), author: 'richard', head: fake, state: 'MERGED', base: 'main', verified: true, batchProtected: 1 });
        const rep = await runAudit({ git: env.git, host: env.host, registryBranch: 'main', project: 'prisma', decisionPort: env.port });
        assert.deepEqual([rep.markersRemoved, rep.markersUncertain], [[], [MARKER]]);
        assert.equal(env.git.resolveCommit(MARKER), fake);
    });
});

describe('O-06 conteúdo inválido é definitivo no W-C', () => {
    it('log.json trocado por diretório → FAIL(LOG_BYTES), não UNVERIFIABLE', async () => {
        const env = makeEnv();
        const st = env.s.step('INC');
        const files = { ...st.files };
        files[`${LOG}/x`] = files[LOG];
        delete files[LOG];
        const pr = env.propose(st, { files });
        const r = await env.check(pr);
        assert.deepEqual([r.status, r.code], ['FAIL', 'LOG_BYTES']);
    });
});

describe('O-07 ganchos de teste fora da API de produção', () => {
    it('opção comum `conditions` é ignorada; só a chave Symbol liga; JSON não a transporta', async () => {
        const s = F.scenario();
        s.commit(s.step('INC'));
        const st = s.step('ACTIVATE');
        assert.equal((await run(st, { conditions: { u0028Decided: true } })).code, 'U0028');
        const viaJson = JSON.parse(JSON.stringify({ [TEST_HOOKS]: { conditions: { u0028Decided: true } } }));
        assert.equal((await run(st, viaJson)).code, 'U0028');
        assert.equal((await run(st, { [TEST_HOOKS]: { ...st.ctx[TEST_HOOKS], conditions: { u0028Decided: true } } })).ok, true);
    });
    it('o índice de produção não exporta adaptador de teste', () => {
        const idx = require('./sdd-writer');
        const names = Object.values(idx).flatMap(m => Object.keys(m));
        assert.deepEqual(names.filter(n => /createTest|TreeDecisionPort|testOnly/i.test(n)), []);
    });
});

describe('O-08 commit-tree determinístico com data fixada por `at`', () => {
    it('mesma entrada → mesmo SHA; preparador diferente → SHA diferente', () => {
        const env = makeEnv();
        const tip = env.host.tip();
        const t = env.git.treeOf(tip);
        const a = env.git.commitTree(t, [tip], 'm\n\npreparer: wp-1\n', 'richard', { date: F.AT });
        const b = env.git.commitTree(t, [tip], 'm\n\npreparer: wp-1\n', 'richard', { date: F.AT });
        const c = env.git.commitTree(t, [tip], 'm\n\npreparer: wp-2\n', 'richard', { date: F.AT });
        assert.equal(a, b);
        assert.notEqual(a, c);
    });
});

describe('O-09 HP-3: corrida real entre dois W-P (os dois veem a ref ausente)', () => {
    function racingHost(host) {
        // As duas primeiras leituras do marcador (uma por W-P) veem a ref ausente; depois, a real.
        let n = 0;
        return { ...host, getRef: async name => (name === MARKER && n++ < 2 ? null : host.getRef(name)) };
    }
    it('um PR; o outro cai na retomada (createRefIfAbsent → false)', async () => {
        const env = makeEnv();
        const a = env.s.step('INC', { decisionRef: 'D-a' });
        const b = env.s.step('INC', { decisionRef: 'D-b', specText: F.specText('b') });
        const h = racingHost(env.host);
        const ra = await prepare({ ...wpArgs(env, a), host: h });
        const rb = await prepare({ ...wpArgs(env, b, { preparerId: 'wp-2' }), host: h });
        assert.equal(ra.state, 'PR_OPEN');
        assert.deepEqual([rb.state, rb.control], ['WAITING', 'WAIT_OTHER_OPERATION']);
        assert.equal(env.host.prs.length, 1);
        assert.equal(env.git.resolveCommit(MARKER), ra.commit);
    });
    it('sabotagem HP-3: dois PRs e o marcador sobrescrito', async () => {
        const m = loadMutant(['sdd-writer-hostsim.js', 'HP-3'], 'sdd-writer-hostsim.js');
        const env = m.makeEnv({ hostImpl: m.createHost });
        const a = env.s.step('INC', { decisionRef: 'D-a' });
        const b = env.s.step('INC', { decisionRef: 'D-b', specText: F.specText('b') });
        const h = racingHost(env.host);
        const ra = await prepare({ ...wpArgs(env, a), host: h });
        const rb = await prepare({ ...wpArgs(env, b, { preparerId: 'wp-2' }), host: h });
        assert.deepEqual([ra.state, rb.state], ['PR_OPEN', 'PR_OPEN']);
        assert.equal(env.host.prs.length, 2);
        assert.notEqual(env.git.resolveCommit(MARKER), ra.commit);
    });
});

describe('O-10 catálogo forjado por admin é acusado pelo W-A', () => {
    it('report.catalog = DIVERGENT', async () => {
        const env = makeEnv();
        await env.integrate(env.s.step('INC'));
        const files = { ...env.s.state.files, [cmd.CATALOG_PATH]: Buffer.from('# forjado\n') };
        env.host.adminPush(env.host.commitFiles(files, [env.host.tip()], 'admin', 'admin'));
        const rep = await runAudit({ git: env.git, host: env.host, registryBranch: 'main', project: 'prisma', decisionPort: env.port });
        assert.equal(rep.catalog, 'DIVERGENT');
        const ok = makeEnv();
        await ok.integrate(ok.s.step('INC'));
        assert.equal((await runAudit({ git: ok.git, host: ok.host, registryBranch: 'main', project: 'prisma', decisionPort: ok.port })).catalog, 'OK');
    });
});

describe('O-11 marcador com o mesmo op_id e outro conteúdo', () => {
    it('CONFLICT, sem tocar a ref nem o PR alheio', async () => {
        const env = makeEnv();
        const st = env.s.step('INC');
        const r = await prepare(wpArgs(env, st));
        const other = { ...st.entry.command, approved_payload: { ...st.entry.command.approved_payload, delta_sha256: F.H('7') } };
        const r2 = await prepare(wpArgs(env, st, { command: other }));
        assert.deepEqual([r2.state, r2.control], ['CONFLICT', 'NEW_COMMAND_REQUIRED']);
        assert.equal(env.git.resolveCommit(MARKER), r.commit);
        assert.equal(env.host.prs[r.pr - 1].state, 'OPEN');
    });
});

describe('O-12 liberação humana exige conferir a ausência do op_id', () => {
    it('log ilegível ou marcador sem op_id → recusa', async () => {
        const env = makeEnv();
        await env.integrate(env.s.step('INC'));
        await env.host.deleteRef(MARKER);
        const bad = { ...env.s.state.files, [LOG]: Buffer.from(`${env.s.state.files[LOG]} `) };
        env.host.adminPush(env.host.commitFiles(bad, [env.host.tip()], 'admin', 'admin'));
        const c = env.git.commitTree(env.git.treeOf(env.host.tip()), [env.host.tip()], 'x\n\nop_id: op:prisma:spec-change:INC:z\n', 'ana');
        await env.host.createRefIfAbsent(MARKER, c);
        const args = { git: env.git, host: env.host, registryBranch: 'main', project: 'prisma', slug: SLUG, operator: 'richard' };
        assert.deepEqual(await humanReleaseMarker(args), { released: false, reason: 'LOG_UNREADABLE' });
        await env.host.deleteRef(MARKER);
        const noOp = env.git.commitTree(env.git.treeOf(env.host.tip()), [env.host.tip()], 'sem op\n', 'ana');
        await env.host.createRefIfAbsent(MARKER, noOp);
        assert.deepEqual(await humanReleaseMarker(args), { released: false, reason: 'MARKER_WITHOUT_OP_ID' });
    });
});

describe('O-13 W-P e W-A conferem registry_branch/projeto com a E-01', () => {
    it('valor divergente do chamador → recusa', async () => {
        const env = makeEnv();
        const st = env.s.step('INC');
        await env.host.createRefIfAbsent('refs/heads/outra', env.host.tip());
        const r = await prepare(wpArgs(env, st, { registryBranch: 'outra' }));
        assert.deepEqual([r.state, r.code], ['REFUSED', 'E01']);
        await assert.rejects(runAudit({ git: env.git, host: env.host, registryBranch: 'outra', project: 'prisma', decisionPort: env.port }));
        await assert.rejects(runAudit({ git: env.git, host: env.host, registryBranch: 'main', project: 'app-back', decisionPort: env.port }));
    });
});

describe('O-14 lacunas de sabotagem', () => {
    it('âncora do W-A sobre append NÃO validado não serve de ponto de partida; sem a reavaliação, serviria', async () => {
        const env = makeEnv();
        await env.integrate(env.s.step('INC'));
        const st = env.s.step('INC', { specText: F.specText('admin') });
        Object.assign(env.records, st.records);
        const c = env.host.commitFiles(st.files, [env.host.tip()], 'admin', 'admin');
        env.host.adminPush(c);
        env.s.commit(st);
        env.host.forgeTag('sdd/prisma/spec-change/g2', c, 'sdd-writer-audit');
        assert.equal((await audit(env, 'incremental')).state, 'UNKNOWN');
        const m = loadMutant(['sdd-writer-audit.js', 'ANCHOR-SELF-EVAL']);
        assert.equal((await audit(env, 'incremental', m.audit.auditCapability)).state, 'OK');
    });
    it('V-8 expected_active e base da INC', async () => {
        const s = F.scenario();
        s.commit(s.step('INC'));
        const act = s.step('ACTIVATE', { mutate: c => { c.approved_payload.expected_active = { cap_version: 1, cap_hash: c.approved_payload.target_hash }; }, mutateEntry: e => { e.result = 'activated'; } });
        const hooks = { [TEST_HOOKS]: { ...act.ctx[TEST_HOOKS], conditions: { u0028Decided: true } } };
        assert.equal((await run(act, hooks)).code, 'STALE');
        const ma = loadMutant(['sdd-writer-log.js', 'V-8-ACTIVE']);
        assert.equal((await run(act, { ...hooks, resultTree: mutantTree(ma, act.files) }, ma.decide.decide)).ok, true);
        const base = s.step('INC', { specText: F.specText('x'), mutate: c => { c.approved_payload.base_version = null; c.approved_payload.base_hash = null; c.approved_payload.target_version = 2; }, mutateEntry: e => { e.result = 'inc_version_created'; } });
        assert.equal((await run(base)).code, 'STALE');
        const mb = loadMutant(['sdd-writer-log.js', 'V-8-BASE']);
        assert.equal((await run(base, { resultTree: mutantTree(mb, base.files) }, mb.decide.decide)).ok, true);
    });
    it('C-04: alvo ≠ registry_branch', async () => {
        const env = makeEnv();
        const st = env.s.step('INC');
        Object.assign(env.records, st.records);
        const tip = env.host.tip();
        const c = env.host.commitFiles(st.files, [tip], 'direto', 'richard');
        const args = writer => writer.check.checkIntegration({
            git: env.git, host: env.host, baseSha: tip, resultTree: env.git.treeOf(c), decisionPort: env.port,
            pr: { target: 'outra', author: 'richard', branch: cmd.markerBranch('prisma', SLUG), number: 1, verified: true, batchProtected: 1 },
        });
        assert.equal(code(await args(require('./sdd-writer'))), 'SCOPE');
        assert.equal(code(await args(loadMutant(['sdd-writer-check.js', 'C-04-TARGET']))), 'PASS');
    });
});

describe('O-18 tag pré-existente com o nome da âncora é anomalia', () => {
    it('reportada, sem criar a âncora', async () => {
        const env = makeEnv();
        await env.integrate(env.s.step('INC'));
        env.host.forgeTag('sdd/prisma/spec-change/g1', env.host.tip(), null);
        const rep = await runAudit({ git: env.git, host: env.host, registryBranch: 'main', project: 'prisma', decisionPort: env.port });
        assert.deepEqual(rep.anchorsCreated, []);
        assert.deepEqual(rep.anomalies, ['ANCHOR_NAME_TAKEN:sdd/prisma/spec-change/g1']);
    });
});

describe('CR-1 / R2-01 PR cuja base ficou para trás: aguarda (C-21), resíduo de liveness declarado', () => {
    it('o W-P não fecha nem refaz o PR; responde PR_OPEN/WAIT', async () => {
        const env = makeEnv();
        const st = env.s.step('INC');
        const r = await prepare(wpArgs(env, st));
        const other = F.scenario({ slug: 'zeta' }).step('INC');
        const files = withCatalog({ ...env.s.state.files, ...Object.fromEntries(Object.entries(other.files).filter(([k]) => k.startsWith('docs/sdd/capabilities/zeta/'))) });
        env.host.adminPush(env.host.commitFiles(files, [env.host.tip()], 'outra', 'admin'));
        assert.equal((await env.host.runCheck(r.pr, { decisionPort: env.port })).code, 'BEHIND');
        const again = await prepare(wpArgs(env, st));
        assert.deepEqual([again.state, again.control, again.pr], ['PR_OPEN', 'WAIT', r.pr]);
        assert.equal(env.host.prs[r.pr - 1].state, 'OPEN');
    });
});

describe('CR-4 log apagado e recriado por admin, sem âncora', () => {
    it('VIOLATION (bytes antes do status)', async () => {
        const env = makeEnv();
        await env.integrate(env.s.step('INC'));
        const del = { ...env.s.state.files };
        delete del[LOG];
        env.host.adminPush(env.host.commitFiles(del, [env.host.tip()], 'apaga', 'admin'));
        const s2 = F.scenario();
        const fresh = s2.step('INC', { specText: F.specText('ressuscitada') });
        env.host.adminPush(env.host.commitFiles({ ...del, [LOG]: fresh.files[LOG] }, [env.host.tip()], 'recria', 'admin'));
        assert.equal(env.host.tags.size, 0);
        assert.equal((await audit(env)).state, 'VIOLATION');
    });
});

describe('R2-02 edição de admin só em spec.md, com log presente', () => {
    it('UNKNOWN (não validado), não VIOLATION', async () => {
        const env = makeEnv();
        await env.integrate(env.s.step('INC'));
        const files = { ...env.s.state.files, [cmd.specPath(SLUG)]: Buffer.from('editada por admin\n') };
        env.host.adminPush(env.host.commitFiles(files, [env.host.tip()], 'admin', 'admin'));
        assert.equal((await audit(env)).state, 'UNKNOWN');
    });
});

describe('CR-6 ausência confere o histórico do log.json, não do diretório', () => {
    it('diretório só com spec.md, por admin → UNKNOWN, não VIOLATION', async () => {
        const env = makeEnv();
        const files = { ...env.s.state.files, [cmd.specPath(SLUG)]: Buffer.from('spec sem log\n') };
        env.host.adminPush(env.host.commitFiles(files, [env.host.tip()], 'admin', 'admin'));
        assert.equal((await audit(env)).state, 'UNKNOWN');
    });
});

void WC;
