'use strict';
// PRI-266 F6 — W-P, marcador em voo e resultado incerto (C-10, C-12 nota, C-21; EM §3 prop. 7).
// WT-F6-01…15.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const cmd = require('./sdd-writer-command');
const { appendBytes } = require('./sdd-writer-log');
const { UnverifiableError } = require('./sdd-writer-git');
const { makeEnv } = require('./sdd-writer-hostsim');
const { prepare, humanReleaseMarker } = require('./sdd-writer-prepare');
const { loadMutant, tmpDir, fixtures: F } = require('./sdd-writer-testkit');

const MARKER = cmd.markerRef('prisma', 'spec-change');
const CONTROLS = new Set(['NONE', 'NEW_COMMAND_REQUIRED', 'UNCERTAIN', 'WAIT', 'WAIT_OTHER_AUTHOR', 'WAIT_OTHER_OPERATION']);

function args(env, st, over = {}) {
    Object.assign(env.records, st.records);
    return {
        git: env.git, host: env.host, registryBranch: 'main', project: 'prisma', slug: 'spec-change',
        command: st.entry.command, opId: st.entry.op_id, decisionRef: st.entry.decision_ref, actor: st.entry.actor,
        preparerId: 'wp-1', at: F.AT, specBytes: st.files[cmd.specPath('spec-change')] || null, decisionPort: env.port, ...over,
    };
}
const prepOf = m => m.prepare.prepare;
const marker = env => env.git.resolveCommit(MARKER);

/** Prepara, roda o W-C e integra; devolve o resultado do W-P. */
async function fullCycle(env, st, over = {}, impl = prepare) {
    const r = await impl(args(env, st, over));
    assert.equal(r.state, 'PR_OPEN', JSON.stringify(r));
    const chk = await env.host.runCheck(r.pr, { decisionPort: env.port });
    assert.equal(chk.status, 'PASS', JSON.stringify(chk));
    const m = await env.host.merge(r.pr);
    assert.equal(m.merged, true);
    env.s.commit(st);
    return r;
}

describe('WT-F6-01 dois W-P para a mesma capability', () => {
    it('só um cria a ref; o outro entra na retomada', async () => {
        const env = makeEnv();
        const a = env.s.step('INC', { decisionRef: 'D-a' });
        const b = env.s.step('INC', { decisionRef: 'D-b', specText: F.specText('b') });
        const ra = await prepare(args(env, a));
        const rb = await prepare(args(env, b, { preparerId: 'wp-2' }));
        assert.equal(ra.state, 'PR_OPEN');
        assert.deepEqual([rb.state, rb.control], ['WAITING', 'WAIT_OTHER_OPERATION']); // espera o PR do outro op
        assert.equal(env.host.prs.length, 1);
        assert.equal(marker(env), ra.commit);
    });
});

describe('WT-F6-01b mesmo comando preparado por dois W-P ao mesmo tempo', () => {
    it('commits do marcador com SHAs distintos; o segundo falha na criação só-se-ausente', async () => {
        const env = makeEnv();
        const st = env.s.step('INC');
        const attempts = [];
        const orig = env.host.createRefIfAbsent;
        env.host.createRefIfAbsent = async (n, sha) => { const ok = await orig(n, sha); attempts.push({ sha, ok }); return ok; };
        await prepare(args(env, st, { preparerId: 'wp-1' }));
        // segundo W-P: ignora a retomada e tenta criar a ref com o seu próprio commit
        const c2 = env.git.commitTree(env.git.treeOf(marker(env)), [env.host.tip()], `sdd-op x\n\nop_id: ${st.entry.op_id}\npreparer: wp-2\nat: 2026-11-06T12:00:09Z\n`, 'richard');
        await env.host.createRefIfAbsent(MARKER, c2);
        assert.equal(attempts.length, 2);
        assert.notEqual(attempts[0].sha, attempts[1].sha);
        assert.deepEqual(attempts.map(a => a.ok), [true, false]);
    });
});

describe('WT-F6-14 sabotagem: adaptador de criação que aceita ref existente', () => {
    it('WT-F6-01/01b falham: os dois "adquirem"', async () => {
        const m = loadMutant(['sdd-writer-hostsim.js', 'HP-3'], 'sdd-writer-hostsim.js');
        const env = m.makeEnv({ hostImpl: m.createHost });
        const tip = env.host.tip();
        const c1 = env.git.commitTree(env.git.treeOf(tip), [tip], 'a\n\npreparer: wp-1\n', 'richard');
        const c2 = env.git.commitTree(env.git.treeOf(tip), [tip], 'b\n\npreparer: wp-2\n', 'richard');
        assert.deepEqual([await env.host.createRefIfAbsent(MARKER, c1), await env.host.createRefIfAbsent(MARKER, c2)], [true, true]);
    });
});

describe('WT-F6-02 crash entre o push da ref e o PR; retomada pelo mesmo principal', () => {
    it('abre o PR do commit da ref; nunca dois PRs', async () => {
        const env = makeEnv();
        const st = env.s.step('INC');
        const open = env.host.openPR;
        env.host.openPR = async () => { throw new UnverifiableError('HOST_API', 'crash'); };
        const r1 = await prepare(args(env, st));
        assert.equal(r1.state, 'UNCERTAIN');
        const ref = marker(env);
        assert.ok(ref);
        env.host.openPR = open;
        const r2 = await prepare(args(env, st));
        assert.equal(r2.state, 'PR_OPEN');
        assert.equal(env.host.prs.length, 1);
        assert.equal(env.host.prs[0].head, ref);
        const r3 = await prepare(args(env, st));
        assert.equal(r3.state, 'PR_OPEN');
        assert.equal(env.host.prs.length, 1);
    });
});

describe('WT-F6-02b retomada por outro principal', () => {
    it('sem preempção; com ação humana registrada, ref removida e nova preparação com o mesmo command_sha256', async () => {
        const env = makeEnv();
        const st = env.s.step('INC');
        const open = env.host.openPR;
        env.host.openPR = async () => { throw new UnverifiableError('HOST_API', 'crash'); };
        await prepare(args(env, st));
        env.host.openPR = open;
        const ref = marker(env);
        const other = await prepare(args(env, st, { actor: 'ana' }));
        assert.deepEqual([other.state, other.control], ['WAITING', 'WAIT_OTHER_AUTHOR']);
        assert.equal(marker(env), ref);
        const rel = await humanReleaseMarker({ git: env.git, host: env.host, registryBranch: 'main', project: 'prisma', slug: 'spec-change', operator: 'richard' });
        assert.equal(rel.released, true);
        assert.match(env.host.comments[0], /ação humana de richard/);
        const again = await prepare(args(env, st, { actor: 'ana' }));
        assert.equal(again.state, 'PR_OPEN');
        const head = env.host.prs[again.pr - 1].head;
        const log = JSON.parse(env.git.readBlob(head, cmd.logPath('spec-change')).toString());
        assert.equal(log[0].command_sha256, st.entry.command_sha256);
        assert.equal(log[0].actor, 'ana');
    });
});

describe('WT-F6-03 PR fechado sem merge (caso 7)', () => {
    it('reapresenta o mesmo comando se a geração vale; senão STALE', async () => {
        const env = makeEnv();
        const st = env.s.step('INC');
        const r = await prepare(args(env, st));
        await env.host.closePR(r.pr);
        const again = await prepare(args(env, st));
        assert.deepEqual([again.state, again.previous], ['PR_OPEN', 'CLOSED_UNMERGED']);
        assert.notEqual(again.pr, r.pr);
        // geração avançou por outra operação → STALE
        await env.host.closePR(again.pr);
        const other = env.s.step('INC', { decisionRef: 'D-outro', specText: F.specText('outro') });
        await env.host.deleteRef(MARKER);
        await fullCycle(env, other);
        // marcador do outro op, já integrado: este W-P espera, não toma posse
        const blocked = await prepare(args(env, st));
        assert.deepEqual([blocked.state, blocked.control], ['WAITING', 'WAIT_OTHER_OPERATION']);
        await env.host.deleteRef(MARKER); // W-A remove o órfão com desfecho certo
        const late = await prepare(args(env, st));
        assert.deepEqual([late.state, late.control], ['REFUSED', 'NEW_COMMAND_REQUIRED']);
        assert.equal(late.code, 'STALE');
    });
});

describe('WT-F6-03b PR aberto com W-C FAIL semântico', () => {
    it('o W-P fecha o PR e só então trata como CLOSED_UNMERGED', async () => {
        const env = makeEnv();
        const st = env.s.step('INC');
        const a = args(env, st);
        const r = await prepare(a);
        env.records[st.entry.decision_ref] = { ...env.records[st.entry.decision_ref], approving: false };
        const chk = await env.host.runCheck(r.pr, { decisionPort: env.port });
        assert.equal(chk.code, 'DECISION');
        const again = await prepare(a);
        assert.equal(env.host.prs[r.pr - 1].state, 'CLOSED');
        assert.equal(again.previous, 'CLOSED_UNMERGED');
        assert.deepEqual([again.state, again.code], ['REFUSED', 'DECISION']); // N1 recusa a reapresentação
    });
});

function flakyPort(env) {
    return {
        failing: false,
        async resolveDecision(ref, at) { if (this.failing) throw new Error('timeout da porta'); return env.port.resolveDecision(ref, at); },
    };
}

describe('WT-F6-03c PR aberto com FAIL(UNVERIFIABLE) (R3-01)', () => {
    it('o PR não é fechado; o W-C roda de novo; a capability não fica UNKNOWN', async () => {
        const env = makeEnv();
        const st = env.s.step('INC');
        const port = flakyPort(env);
        const r = await prepare(args(env, st, { decisionPort: port }));
        port.failing = true;
        const chk = await env.host.runCheck(r.pr, { decisionPort: port });
        assert.equal(chk.code, 'UNVERIFIABLE');
        port.failing = false;
        const again = await prepare(args(env, st, { decisionPort: port }));
        assert.deepEqual([again.state, again.pr], ['PR_OPEN', r.pr]);
        assert.equal(env.host.prs[r.pr - 1].state, 'OPEN');
        assert.equal(env.host.prs[r.pr - 1].checkRuns, 1);
        const chk2 = await env.host.runCheck(r.pr, { decisionPort: port });
        assert.equal(chk2.status, 'PASS');
    });
});

describe('WT-F6-15 sabotagem: falha de obtenção tratada como FAIL definitivo', () => {
    it('WT-F6-03c falha: o PR é fechado', async () => {
        const m = loadMutant(['sdd-writer-prepare.js', 'R3-01']);
        const env = makeEnv();
        const st = env.s.step('INC');
        const port = flakyPort(env);
        const r = await prepOf(m)(args(env, st, { decisionPort: port }));
        port.failing = true;
        await env.host.runCheck(r.pr, { decisionPort: port });
        port.failing = false;
        await prepOf(m)(args(env, st, { decisionPort: port }));
        assert.equal(env.host.prs[r.pr - 1].state, 'CLOSED');
    });
});

describe('WT-F6-04 crash depois da integração (caso 8)', () => {
    it('APPLIED (replay); nenhum PR novo; marcador liberado', async () => {
        const env = makeEnv();
        const st = env.s.step('INC');
        await fullCycle(env, st);
        assert.ok(marker(env), 'o W-P caiu antes de liberar');
        const r = await prepare(args(env, st));
        assert.deepEqual([r.state, r.result], ['APPLIED', 'NOT_AVAILABLE']);
        assert.equal(env.host.prs.length, 1);
        assert.equal(marker(env), null);
    });
    it('marcador já removido pelo W-A: continua APPLIED', async () => {
        const env = makeEnv();
        const st = env.s.step('INC');
        await fullCycle(env, st);
        await env.host.deleteRef(MARKER);
        const r = await prepare(args(env, st));
        assert.equal(r.state, 'APPLIED');
    });
});

describe('WT-F6-08 / WT-F6-13 sabotagem: reapresentar sem buscar o op_id (N1 sem caminho R)', () => {
    it('WT-F6-04/WT-F6-10 falham: vira recusa, não replay', async () => {
        const m = loadMutant(['sdd-writer-prepare.js', 'C21-SEARCH']);
        const env = makeEnv();
        const st = env.s.step('INC');
        await fullCycle(env, st);
        await env.host.deleteRef(MARKER);
        const r = await prepOf(m)(args(env, st));
        assert.notEqual(r.state, 'APPLIED');
        assert.ok(['DUPLICATE_OP', 'STALE'].includes(r.code), r.code);
    });
});

describe('WT-F6-05 host ilegível ou ambíguo', () => {
    it('UNCERTAIN; zero tentativas novas', async () => {
        const env = makeEnv();
        const st = env.s.step('INC');
        env.host.faults.api = true;
        const r = await prepare(args(env, st));
        assert.deepEqual([r.state, r.control], ['UNCERTAIN', 'UNCERTAIN']);
        env.host.faults.api = false;
        assert.equal(env.host.prs.length, 0);
        assert.equal(marker(env), null);
    });
});

describe('WT-F6-06 working tree adulterada', () => {
    it('comando preparado inalterado: o W-P lê só objetos Git', async () => {
        const env = makeEnv();
        const st = env.s.step('INC');
        const wt = tmpDir('sdd-wt-');
        fs.mkdirSync(path.join(wt, 'docs/sdd/capabilities/spec-change'), { recursive: true });
        fs.writeFileSync(path.join(wt, cmd.logPath('spec-change')), '[{"forjado":true}]');
        const cwd = process.cwd();
        process.chdir(wt);
        try {
            const r = await prepare(args(env, st));
            assert.equal(r.state, 'PR_OPEN');
            const log = env.git.readBlob(r.commit, cmd.logPath('spec-change'));
            assert.ok(log.equals(appendBytes(null, st.entry)));
        } finally {
            process.chdir(cwd);
        }
    });
});

describe('WT-F6-07 N1 recusa uma Decision inválida', () => {
    it('nenhuma ref nem PR', async () => {
        const env = makeEnv();
        const st = env.s.step('INC', { record: { state: 'EXPIRED' } });
        const r = await prepare(args(env, st));
        assert.deepEqual([r.state, r.code], ['REFUSED', 'DECISION']);
        assert.equal(marker(env), null);
        assert.equal(env.host.prs.length, 0);
    });
});

describe('WT-F6-09 caso 6 de ponta a ponta: duas cópias do mesmo comando', () => {
    it('a segunda termina em APPLIED, sem segundo PR e sem segunda entrada', async () => {
        const env = makeEnv();
        const st = env.s.step('INC');
        await fullCycle(env, st);
        const second = await prepare(args(env, st, { preparerId: 'wp-2' }));
        assert.equal(second.state, 'APPLIED');
        assert.equal(env.host.prs.length, 1);
        const log = JSON.parse(env.git.readBlob(env.host.tip(), cmd.logPath('spec-change')).toString());
        assert.equal(log.length, 1);
    });
});

describe('WT-F6-10 invocação nova de comando já aplicado (Decision consumida)', () => {
    it('replay pelo caminho R interno, nunca FAIL(DECISION)', async () => {
        const env = makeEnv();
        const st = env.s.step('INC');
        await fullCycle(env, st);
        await env.host.deleteRef(MARKER);
        const r = await prepare(args(env, st, { preparerId: 'outra-maquina' }));
        assert.equal(r.state, 'APPLIED');
        assert.notEqual(r.code, 'DECISION');
    });
});

describe('WT-F6-11 PR MERGED entre o passo 1 e o 2', () => {
    async function staleFetchHost(env, staleTip, times) {
        const real = env.host.getRef.bind(env.host);
        let n = 0;
        return { ...env.host, getRef: async name => (name === 'refs/heads/main' && n++ < times ? staleTip : real(name)) };
    }
    it('novo fetch → APPLIED; merged sem op_id → UNCERTAIN', async () => {
        const env = makeEnv();
        const st = env.s.step('INC');
        const before = env.host.tip();
        await fullCycle(env, st);
        const once = await staleFetchHost(env, before, 1);
        const r = await prepare({ ...args(env, st), host: once });
        assert.equal(r.state, 'APPLIED');
        const env2 = makeEnv();
        const st2 = env2.s.step('INC');
        const before2 = env2.host.tip();
        await fullCycle(env2, st2);
        const always = await staleFetchHost(env2, before2, 1e9);
        const r2 = await prepare({ ...args(env2, st2), host: always });
        assert.deepEqual([r2.state, r2.reason], ['UNCERTAIN', 'MERGED_WITHOUT_OP_ID']);
    });
});

describe('WT-F6-12 saída ao operador com a U-002-4 aberta', () => {
    it('result = NOT_AVAILABLE; só o próximo passo de controle', async () => {
        const env = makeEnv();
        const st = env.s.step('INC');
        const outs = [await prepare(args(env, st))];
        outs.push(await prepare(args(env, st)));
        const chk = await env.host.runCheck(outs[0].pr, { decisionPort: env.port });
        assert.equal(chk.status, 'PASS');
        await env.host.merge(outs[0].pr);
        outs.push(await prepare(args(env, st)));
        outs.push(await prepare(args(env, st, { command: { ...st.entry.command, expected_generation: 9 } })));
        for (const o of outs) {
            assert.equal(o.result, 'NOT_AVAILABLE');
            assert.ok(CONTROLS.has(o.control), o.control);
            assert.equal(o.entry, undefined);
        }
    });
});
