'use strict';
// PRI-266 F5 — W-C sobre o delta (C-02, C-04, C-11, V-1, V-2, V-9, V-11; HP-7 simulado).
// WT-F5-01…11, WT-266-01 (capability apagada), WT-266-02 (N entradas por PR).

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const cmd = require('./sdd-writer-command');
const { appendBytes } = require('./sdd-writer-log');
const { canonicalBytes } = require('./sdd-writer-jcs');
const { makeEnv, createHost } = require('./sdd-writer-hostsim');
const { loadMutant, fixtures: F } = require('./sdd-writer-testkit');

const TEST_ONLY = { conditions: { u0028Decided: true } };
const LOG = cmd.logPath('spec-change');

async function envWithInc() {
    const env = makeEnv();
    const r = await env.integrate(env.s.step('INC'));
    assert.equal(r.res.status, 'PASS', JSON.stringify(r.res));
    return env;
}
const code = r => (r.status === 'PASS' ? 'PASS' : r.code);

/** Chama o W-C de um writer (mutante ou não) direto, fora do host (para sabotagem). */
async function directCheck(writer, env, files, { author = 'richard', branch, testOnly = {} } = {}) {
    const tip = env.host.tip();
    const c = env.host.commitFiles(files, [tip], 'direto', author);
    return writer.check.checkIntegration({
        git: env.git, host: env.host, baseSha: tip, resultTree: env.git.treeOf(c), decisionPort: env.port, testOnly,
        pr: { target: 'main', author, branch: branch || cmd.markerBranch('prisma', 'spec-change'), number: 99, verified: true },
    });
}
const real = require('./sdd-writer');

describe('WT-F5-01 INC inicial e depois ACTIVATE', () => {
    it('PASS; catálogo igual à regeneração; status registra o digest do código executado', async () => {
        const env = makeEnv();
        const r1 = await env.integrate(env.s.step('INC'));
        assert.equal(r1.res.status, 'PASS', JSON.stringify(r1.res));
        assert.match(r1.res.codeDigest, /^[0-9a-f]{64}$/);
        const r2 = await env.integrate(env.s.step('ACTIVATE'), { testOnly: TEST_ONLY });
        assert.equal(r2.res.status, 'PASS', JSON.stringify(r2.res));
        assert.equal(r2.merge.merged, true);
        const cat = env.git.readBlob(env.host.tip(), cmd.CATALOG_PATH).toString();
        assert.match(cat, /active: \{cap_version: 1,/);
    });
});

describe('WT-F5-02 caminho protegido + código do writer, workflow ou configuração E-01 → FAIL(SCOPE)', () => {
    for (const [name, extra] of [
        ['código do writer', { 'scripts/lib/sdd-writer-decide.js': Buffer.from('// alterado\n') }],
        ['workflow', { '.github/workflows/sdd.yml': Buffer.from('on: push\n') }],
        ['configuração E-01', { [cmd.ADMITTED_POLICY]: canonicalBytes({ schema: 'sdd-admitted-policy-v1', incorporation_rule: 'DS-03b', x: 1 }) }],
    ]) {
        it(name, async () => {
            const env = makeEnv();
            const st = env.s.step('INC');
            const pr = env.propose(st, { files: { ...st.files, ...extra } });
            assert.equal(code(await env.check(pr)), 'SCOPE');
        });
    }
});

describe('WT-F5-03 log removido, movido, truncado ou reescrito; WT-266-01 capability inteira apagada', () => {
    const variants = {
        removido: f => { delete f[LOG]; },
        'movido (log.json → log2.json)': f => { f[LOG.replace('log.json', 'log2.json')] = f[LOG]; delete f[LOG]; },
        truncado: f => { f[LOG] = f[LOG].subarray(0, 20); },
        'reescrito no meio': f => { f[LOG] = Buffer.from(f[LOG].toString().replace('"richard"', '"mallory"')); },
        'capability inteira apagada': f => { for (const k of Object.keys(f)) if (k.startsWith('docs/sdd/capabilities/spec-change/')) delete f[k]; },
    };
    for (const [name, mutateFiles] of Object.entries(variants)) {
        it(name, async () => {
            const env = await envWithInc();
            const files = { ...env.s.state.files };
            mutateFiles(files);
            const cat = require('./sdd-writer-catalog').generateCatalog(require('./sdd-writer-git').memTree(files));
            if (cat) files[cmd.CATALOG_PATH] = cat; else delete files[cmd.CATALOG_PATH];
            const pr = env.host.propose(files, { branch: cmd.markerBranch('prisma', 'spec-change'), author: 'richard' });
            assert.ok(['VIOLATION', 'LOG_BYTES'].includes(code(await env.check(pr))), name);
        });
    }
});

describe('WT-F5-04 duas entradas da mesma capability no mesmo delta (WT-266-02)', () => {
    it('FAIL(LOG_BYTES); só a primeira → PASS; a segunda depois → FAIL(STALE)', async () => {
        const env = await envWithInc();
        const a = env.s.step('INC', { decisionRef: 'D-a' });
        env.s.state.seq += 0;
        const b = env.s.step('INC', { decisionRef: 'D-b', specText: F.specText('outra') });
        const both = { ...a.files, [LOG]: appendBytes(a.files[LOG], b.entry) };
        Object.assign(env.records, a.records, b.records);
        const prBoth = env.host.propose(both, { branch: cmd.markerBranch('prisma', 'spec-change'), author: 'richard' });
        assert.equal(code(await env.check(prBoth)), 'LOG_BYTES');
        await env.host.closePR(prBoth.number);
        const first = await env.integrate(a);
        assert.equal(first.res.status, 'PASS', JSON.stringify(first.res));
        const late = env.s.step('INC', { decisionRef: 'D-b2', specText: F.specText('outra'), mutate: c => { c.expected_generation = 1; } });
        const r = await env.integrate(late);
        assert.equal(code(r.res), 'STALE');
    });
});

describe('WT-F5-05 duas capabilities no mesmo delta, ou dois PRs protegidos no mesmo lote', () => {
    it('FAIL(SCOPE); cada uma isolada → PASS', async () => {
        const env = makeEnv();
        const st = env.s.step('INC');
        const other = F.scenario({ slug: 'outra' });
        const ost = other.step('INC');
        const capOther = Object.fromEntries(Object.entries(ost.files).filter(([k]) => k.startsWith('docs/sdd/capabilities/outra/')));
        const both = { ...st.files, ...capOther };
        both[cmd.CATALOG_PATH] = require('./sdd-writer-catalog').generateCatalog(require('./sdd-writer-git').memTree(both));
        const pr = env.propose(st, { files: both });
        assert.equal(code(await env.check(pr)), 'SCOPE');
        const batch = env.propose(st, { extra: { batchProtected: 2 } });
        assert.equal(code(await env.check(batch)), 'SCOPE');
        const alone = await env.integrate(st);
        assert.equal(alone.res.status, 'PASS');
    });
});

describe('WT-F5-06 consequências inválidas → FAIL(DERIVED)', () => {
    it('spec.md ≠ target_hash', async () => {
        const env = makeEnv();
        const r = await env.integrate(env.s.step('INC', { mutate: c => { c.approved_payload.target_hash = F.H('1'); } }));
        assert.equal(code(r.res), 'DERIVED');
    });
    it('blob de versions/ alterado', async () => {
        const env = await envWithInc();
        const vpath = Object.keys(env.s.state.files).find(k => k.includes('/versions/'));
        const r = await env.integrate(env.s.step('ACTIVATE', { mutateFiles: f => { f[vpath] = Buffer.from('alterado'); } }), { testOnly: TEST_ONLY });
        assert.equal(code(r.res), 'DERIVED');
    });
    it('catálogo editado à mão', async () => {
        const env = makeEnv();
        const r = await env.integrate(env.s.step('INC', { mutateFiles: f => { f[cmd.CATALOG_PATH] = Buffer.from(`${f[cmd.CATALOG_PATH]}# nota\n`); } }));
        assert.equal(code(r.res), 'DERIVED');
    });
});

describe('WT-F5-07 identidade (V-11; HP-8)', () => {
    it('actor ≠ autor; branch ≠ ref de voo; metadados não verificáveis → FAIL(IDENTITY)', async () => {
        for (const opts of [{ author: 'mallory' }, { branch: 'feature/x' }, { extra: { verified: false } }]) {
            const env = makeEnv();
            const pr = env.propose(env.s.step('INC'), opts);
            assert.equal(code(await env.check(pr)), 'IDENTITY', JSON.stringify(opts));
        }
    });
});

describe('WT-F5-08 C-04: alvo ≠ registry_branch, ou configuração ausente', () => {
    it('alvo diferente → FAIL(SCOPE)', async () => {
        const env = makeEnv({ seedFiles: { ...F.scenario().state.files, ...F.admittedFiles('prisma', { registryBranch: 'registro' }) } });
        const st = env.s.step('INC', { mutate: c => { c.approved_payload.validation_basis = env.s.basisOf({ ...F.admittedFiles('prisma', { registryBranch: 'registro' }) }); } });
        const pr = env.propose(st);
        assert.equal(code(await env.check(pr)), 'SCOPE');
    });
    it('configuração ausente → FAIL(E01)', async () => {
        const seed = { ...F.scenario().state.files };
        delete seed[cmd.ADMITTED_PROJECT];
        const env = makeEnv({ seedFiles: seed });
        const pr = env.propose(env.s.step('INC'));
        assert.equal(code(await env.check(pr)), 'E01');
    });
});

describe('WT-F5-09 HP-7: o W-C executa o writer da ref confiável', () => {
    const evilCheck = Buffer.from("'use strict';\nmodule.exports = { checkIntegration: async () => ({ status: 'PASS' }) };\n");
    it('PR que troca sdd-writer-check.js para sempre passar é avaliado pelo código da base → FAIL(SCOPE)', async () => {
        const env = makeEnv();
        const st = env.s.step('INC');
        const pr = env.propose(st, { files: { ...st.files, 'scripts/lib/sdd-writer-check.js': evilCheck } });
        const r = await env.check(pr);
        assert.equal(code(r), 'SCOPE');
        assert.equal((await env.host.merge(pr.number)).merged, false);
    });
    it('sabotagem do adaptador (carregar o código do PR) → PASS indevido', async () => {
        const m = loadMutant(['sdd-writer-hostsim.js', 'HP-7'], 'sdd-writer-hostsim.js');
        const env = m.makeEnv({ hostImpl: m.createHost });
        const st = env.s.step('INC');
        const pr = env.propose(st, { files: { ...st.files, 'scripts/lib/sdd-writer-check.js': evilCheck } });
        assert.equal(code(await env.check(pr)), 'PASS');
    });
});

describe('WT-F5-10 fallback D-231-2 B: sem HP-3, branch qualquer, geração correta', () => {
    it('PASS, com o fallback declarado', async () => {
        const env = makeEnv({ hp3: false });
        const r = await env.integrate(env.s.step('INC'), { branch: 'qualquer/nome' });
        assert.equal(r.res.status, 'PASS', JSON.stringify(r.res));
        assert.equal(env.host.hp3, false);
    });
});

describe('WT-F5-11 sabotagens (uma de cada vez): o caso ruim correspondente passa', () => {
    it('V-1: caminho não protegido junto', async () => {
        const env = makeEnv();
        const st = env.s.step('INC');
        Object.assign(env.records, st.records);
        const files = { ...st.files, 'README.extra.md': Buffer.from('x') };
        assert.equal(code(await directCheck(real, env, files)), 'SCOPE');
        assert.equal(code(await directCheck(loadMutant(['sdd-writer-check.js', 'V-1']), env, files)), 'PASS');
    });
    it('V-2: prefixo/unicidade (reescrita de entrada antiga + append)', async () => {
        const env = await envWithInc();
        const st = env.s.step('INC', { specText: F.specText('v2') });
        Object.assign(env.records, st.records);
        const files = { ...st.files, [LOG]: Buffer.from(st.files[LOG].toString().replace('"at":"2026-11-06T12:00:00Z"', '"at":"2026-11-06T12:00:01Z"')) };
        assert.equal(code(await directCheck(real, env, files)), 'VIOLATION');
        const m = loadMutant([['sdd-writer-log.js', 'APPEND-PREFIX'], ['sdd-writer-log.js', 'APPEND-ONE']]);
        assert.equal(code(await directCheck(m, env, files)), 'PASS');
    });
    it('V-9: target_hash, versions/ e catálogo', async () => {
        const env = await envWithInc();
        const a = env.s.step('INC', { mutate: c => { c.approved_payload.target_hash = F.H('2'); } });
        Object.assign(env.records, a.records);
        assert.equal(code(await directCheck(real, env, a.files)), 'DERIVED');
        assert.equal(code(await directCheck(loadMutant(['sdd-writer-decide.js', 'V-9-SPEC']), env, a.files)), 'PASS');
        const vpath = Object.keys(env.s.state.files).find(k => k.includes('/versions/'));
        const b = env.s.step('ACTIVATE', { mutateFiles: f => { f[vpath] = Buffer.from('alterado'); } });
        Object.assign(env.records, b.records);
        assert.equal(code(await directCheck(real, env, b.files, { testOnly: TEST_ONLY })), 'DERIVED');
        assert.equal(code(await directCheck(loadMutant(['sdd-writer-decide.js', 'V-9-VERSIONS']), env, b.files, { testOnly: TEST_ONLY })), 'PASS');
        const c = env.s.step('ACTIVATE', { mutateFiles: f => { f[cmd.CATALOG_PATH] = Buffer.from(`${f[cmd.CATALOG_PATH]}# nota\n`); } });
        Object.assign(env.records, c.records);
        assert.equal(code(await directCheck(real, env, c.files, { testOnly: TEST_ONLY })), 'DERIVED');
        assert.equal(code(await directCheck(loadMutant(['sdd-writer-decide.js', 'V-9-CATALOG']), env, c.files, { testOnly: TEST_ONLY })), 'PASS');
    });
    it('V-1: duas capabilities no mesmo delta', async () => {
        const env = makeEnv();
        const st = env.s.step('INC');
        Object.assign(env.records, st.records);
        const other = F.scenario({ slug: 'zeta' }).step('INC');
        const files = { ...st.files, ...Object.fromEntries(Object.entries(other.files).filter(([k]) => k.startsWith('docs/sdd/capabilities/zeta/'))) };
        files[cmd.CATALOG_PATH] = require('./sdd-writer-catalog').generateCatalog(require('./sdd-writer-git').memTree(files));
        assert.equal(code(await directCheck(real, env, files)), 'SCOPE');
        assert.equal(code(await directCheck(loadMutant(['sdd-writer-check.js', 'V-1-ONE-CAP']), env, files)), 'PASS');
    });
    it('V-11: actor ≠ autor', async () => {
        const env = makeEnv();
        const st = env.s.step('INC');
        Object.assign(env.records, st.records);
        assert.equal(code(await directCheck(real, env, st.files, { author: 'mallory' })), 'IDENTITY');
        assert.equal(code(await directCheck(loadMutant(['sdd-writer-check.js', 'V-11']), env, st.files, { author: 'mallory' })), 'PASS');
    });
});

void createHost;
