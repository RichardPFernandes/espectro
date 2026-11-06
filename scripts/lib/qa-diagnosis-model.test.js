'use strict';
// PRI-181 c2b-1-model (SPEC-c2b-1-model r3.1): AC-03 (cabeçalho §6.7), AC-05 (bloco diagnosis)
// e gramática de chave/token (premissas 3, 4 e 7). Chaves sintéticas 900001…; nada de consumidor.
const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const model = require('./qa-diagnosis-model');

const KEY = 'redmine:900001:j900002';
function header(over = {}) {
    return model.buildVersion({
        rejection_key: KEY, version: 1, parent_version: 0, job_token: 'job-900001-a',
        produced_by: 'deterministic', created_at: '2026-11-06T12:00:00.000Z',
        bindings: { task_id: '900001-synthetic' }, analyzer: { kind: 'deterministic', runtime: 'node' },
        ...over,
    });
}

test('chave: EXACT e DEGRADED da SDD; qa-rej:v1 e variantes fora da gramática recusadas', () => {
    for (const k of [KEY, 'redmine:900001:t2026-11-06T12:00:00Z', 'redmine:900001:t2026-11-06T12:00:00.123Z',
        'acme-qa:1:j1', 'redmine:900001:t2024-02-29T00:00:00Z']) assert.equal(model.isValidKey(k), true, k);
    for (const k of ['qa-rej:v1:t900001:j900002', 'Redmine:900001:j900002', 'redmine:0900001:j1',
        'redmine:900001:j0', 'redmine:900001:t2026-11-06t12:00:00z', 'redmine:900001:t2026-11-06T12:00:00+00:00',
        'redmine:900001:t2026-11-06T12:00:00.123456Z', 'redmine:900001:t2026-02-30T00:00:00Z',
        'redmine:900001:t2026-11-06T24:00:00Z', 'redmine:900001:t2026-11-06T12:00:60Z',
        'redmine:900001:t2026-99-99T99:99:99Z', 'redmine:900001', '', null, 42]) {
        assert.equal(model.isValidKey(k), false, String(k));
    }
});

test('token: só minúsculas, dígitos, _ e - (premissa 4)', () => {
    assert.equal(model.isValidToken('op_1-a'), true);
    for (const t of ['Op1', 'a.b', 'a:b', '', 'x'.repeat(129), '../x']) assert.equal(model.isValidToken(t), false, t);
});

test('AC-03: cabeçalho completo é válido; builder não inventa valor (null = UNKNOWN)', () => {
    const v = header();
    assert.deepEqual(model.validateVersion(v), { ok: true });
    assert.equal(v.schema, 'qa-diagnosis/0.1');
    assert.equal(v.prisma_revision, null);
    assert.equal(v.consumer_ref, null);
    assert.equal(v.inputs_digest, null);
    assert.deepEqual(v.bindings, { task_id: '900001-synthetic', execution_id: null, dom06_attempt_ids: null,
        spec_hash: null, spec_version: null, pr: null, commit: null });
    assert.deepEqual(v.cost, { usd: null, tokens: null, status: 'UNKNOWN' });
    assert.deepEqual(Object.keys(v), model.HEADER_KEYS);
});

test('AC-03: correção humana no modelo (produced_by human, vN+1 com parent N) é válida', () => {
    assert.equal(model.validateVersion(header({ produced_by: 'human', version: 3, parent_version: 2 })).ok, true);
});

test('AC-03: recusas do validador', () => {
    const bad = [
        ['schema', v => { v.schema = 'qa-diagnosis-record/v1'; }],
        ['rejection_key qa-rej', v => { v.rejection_key = 'qa-rej:v1:t900001:j900002'; }],
        ['version 0', v => { v.version = 0; v.parent_version = -1; }],
        ['parent incoerente', v => { v.parent_version = 5; }],
        ['token', v => { v.job_token = 'Op.1'; }],
        ['produced_by', v => { v.produced_by = 'llm'; }],
        ['created_at', v => { v.created_at = '2026-02-30T00:00:00Z'; }],
        ['cost zero', v => { v.cost = { usd: 0, tokens: 0, status: 'UNKNOWN' }; }],
        ['cost medido', v => { v.cost = { usd: 1, tokens: 10, status: 'MEASURED' }; }],
        ['task_id nulo', v => { v.bindings.task_id = null; }],
        ['bindings extra', v => { v.bindings.extra = 'x'; }],
        ['analyzer.kind nulo', v => { v.analyzer.kind = null; }],
        ['inputs_digest', v => { v.inputs_digest = 'abc'; }],
        ['dom06 não string', v => { v.bindings.dom06_attempt_ids = [1]; }],
        ['findings C2/C3', v => { v.findings = []; }],
        ['authority C2', v => { v.authority = true; }],
        ['status published', v => { v.status = 'published'; }],
        ['falta chave', v => { delete v.analyzer; }],
    ];
    for (const [name, mut] of bad) {
        const v = structuredClone(header());
        mut(v);
        assert.equal(model.validateVersion(v).ok, false, name);
    }
    assert.equal(model.validateVersion(null).ok, false);
    assert.equal(model.validateVersion([]).ok, false);
});

test('AC-03: seções de conteúdo §6.1–6.4 opcionais e não validadas até a c2b-4', () => {
    const v = model.buildVersion({ ...header() }, { context: { anything: 1 }, platform_signals: [] });
    assert.equal(model.validateVersion(v).ok, true);
    assert.deepEqual(Object.keys(v).slice(-2), ['context', 'platform_signals']);
});

test('AC-03: serialização determinística (mesma entrada, mesmos bytes; ordem de chaves fixa; LF final)', () => {
    const a = model.buildVersion(header(), { context: { b: 1, a: 2 } });
    const shuffled = {};
    for (const k of Object.keys(a).reverse()) shuffled[k] = a[k];
    shuffled.context = { a: 2, b: 1 };
    const x = model.serialize(a);
    const y = model.serialize(shuffled);
    assert.ok(Buffer.isBuffer(x));
    assert.equal(Buffer.compare(x, y), 0);
    assert.equal(x.at(-1), 0x0a);
    assert.equal(model.sha256(x), model.sha256(y));
    assert.match(model.sha256(x), /^[0-9a-f]{64}$/);
});

test('AC-03: validador funciona sem ajv (require bloqueado)', () => {
    const original = Module._load;
    Module._load = function (request, ...rest) {
        if (/^ajv/.test(request)) throw new Error('ajv bloqueado no teste');
        return original.call(this, request, ...rest);
    };
    try {
        const id = require.resolve('./qa-diagnosis-model');
        delete require.cache[id];
        const fresh = require('./qa-diagnosis-model');
        assert.equal(fresh.validateVersion(header()).ok, true);
        assert.equal(fresh.validateBlock(fresh.initialDiagnosisBlock()).ok, true);
    } finally {
        Module._load = original;
    }
});

test('AC-05: bloco inicial = premissas 7.1, 7.2 e 7.8, e é válido', () => {
    const b = model.initialDiagnosisBlock();
    assert.deepEqual(b, {
        rev: 0, status: 'pending', current_version: 0, current_sha256: null, versions: [], job: null,
        review: null, review_history: [],
        outcome: { status: 'PENDING', source: null, evidence_ref: null, at: null, confirmed_cause: null },
        applied_ops: [], cost: { usd: null, tokens: null, status: 'UNKNOWN' }, fenced_tokens: [], blocked: null,
    });
    assert.deepEqual(model.validateBlock(b), { ok: true });
});

const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);
function withVersions() {
    return { ...model.initialDiagnosisBlock(), rev: 3, status: 'proposed', current_version: 2, current_sha256: SHA_B,
        versions: [{ v: 1, sha256: SHA_A, produced_by: 'deterministic', at: '2026-11-06T12:00:00Z' },
            { v: 2, sha256: SHA_B, produced_by: 'human', at: '2026-11-06T13:00:00.000Z' }] };
}

test('AC-05: validateBlock aceita status do §5 e failed:<reason> (inclusive RUNNER_NOT_ADMITTED)', () => {
    assert.equal(model.validateBlock(withVersions()).ok, true);
    for (const s of [...model.STATUSES, 'failed:INTEGRITY', 'failed:RUNNER_NOT_ADMITTED', 'failed:FENCED']) {
        assert.equal(model.validateBlock({ ...withVersions(), status: s }).ok, true, s);
    }
    const blocked = { ...withVersions(), blocked: { reason: 'DUPLICATE_SUBJECT', clones: ['/a', '/b'], detected_at: '2026-11-06T12:00:00Z' },
        fenced_tokens: ['job-1', 'job-2'] };
    assert.equal(model.validateBlock(blocked).ok, true);
});

test('AC-05: validateBlock recusa blocos malformados', () => {
    const bad = [
        ['conflict não é status', b => { b.status = 'conflict'; }],
        ['failed sem reason válido', b => { b.status = 'failed:NOPE'; }],
        ['published', b => { b.status = 'published'; }],
        ['rev negativo', b => { b.rev = -1; }],
        ['v fora de ordem', b => { b.versions[1].v = 3; }],
        ['current_version != length', b => { b.current_version = 1; }],
        ['current_sha256 divergente', b => { b.current_sha256 = SHA_A; }],
        ['sha inválido', b => { b.versions[0].sha256 = 'xyz'; }],
        ['produced_by inválido', b => { b.versions[0].produced_by = 'llm'; }],
        ['at inválido', b => { b.versions[0].at = 'ontem'; }],
        ['outcome sem evidence_ref', b => { delete b.outcome.evidence_ref; }],
        ['outcome status', b => { b.outcome.status = 'DONE'; }],
        ['cost zero', b => { b.cost = { usd: 0, tokens: 0, status: 'UNKNOWN' }; }],
        ['fenced duplicado', b => { b.fenced_tokens = ['job-1', 'job-1']; }],
        ['fenced token inválido', b => { b.fenced_tokens = ['Job.1']; }],
        ['blocked reason', b => { b.blocked = { reason: 'X', clones: [], detected_at: '2026-11-06T12:00:00Z' }; }],
        ['job array', b => { b.job = []; }],
        ['falta campo', b => { delete b.applied_ops; }],
    ];
    for (const [name, mut] of bad) {
        const b = structuredClone(withVersions());
        mut(b);
        assert.equal(model.validateBlock(b).ok, false, name);
    }
    for (const v of [null, [], 'x', 1]) assert.equal(model.validateBlock(v).ok, false);
    const noVer = { ...model.initialDiagnosisBlock(), current_sha256: SHA_A };
    assert.equal(model.validateBlock(noVer).ok, false, 'sem versão, current_sha256 tem de ser null');
});

// ---------------------------------------------------------------- r2 (revisão G3 do código)
test('CI-02: nulidade e tipos campo a campo (premissa 7.7)', () => {
    const nullableStr = [['prisma_revision'], ['consumer_ref'], ['taxonomy_version'], ['predicates_version'], ['rules_version'],
        ['bindings', 'execution_id'], ['bindings', 'spec_hash'], ['bindings', 'pr'], ['bindings', 'commit'],
        ['analyzer', 'model'], ['analyzer', 'effort'], ['analyzer', 'rubric_version'], ['analyzer', 'rubric_sha256'],
        ['analyzer', 'context_pack_sha256'], ['analyzer', 'transcript_ref']];
    const set = (v, p, val) => { if (p.length === 1) v[p[0]] = val; else v[p[0]][p[1]] = val; };
    for (const p of nullableStr) {
        for (const ok of [null, 'x1']) { const v = structuredClone(header()); set(v, p, ok); assert.equal(model.validateVersion(v).ok, true, `${p.join('.')}=${ok}`); }
        for (const bad of ['', 1, true, {}, []]) { const v = structuredClone(header()); set(v, p, bad); assert.equal(model.validateVersion(v).ok, false, `${p.join('.')}=${JSON.stringify(bad)}`); }
    }
    for (const ok of [null, 'v3', 0, 3]) { const v = structuredClone(header()); v.bindings.spec_version = ok; assert.equal(model.validateVersion(v).ok, true, `spec_version=${ok}`); }
    for (const bad of ['', -1, 1.5, true, {}]) { const v = structuredClone(header()); v.bindings.spec_version = bad; assert.equal(model.validateVersion(v).ok, false, `spec_version=${bad}`); }
    for (const ok of [null, [], ['a1']]) { const v = structuredClone(header()); v.bindings.dom06_attempt_ids = ok; assert.equal(model.validateVersion(v).ok, true); }
    for (const bad of [[''], 'a1', {}]) { const v = structuredClone(header()); v.bindings.dom06_attempt_ids = bad; assert.equal(model.validateVersion(v).ok, false); }
    for (const p of [['analyzer', 'kind'], ['analyzer', 'runtime'], ['bindings', 'task_id']]) {
        for (const bad of [null, '', 1]) { const v = structuredClone(header()); set(v, p, bad); assert.equal(model.validateVersion(v).ok, false, `${p.join('.')}=${bad}`); }
    }
    const extraAnalyzer = structuredClone(header()); extraAnalyzer.analyzer.extra = null;
    assert.equal(model.validateVersion(extraAnalyzer).ok, false, 'analyzer fechado');
    const missingAnalyzer = structuredClone(header()); delete missingAnalyzer.analyzer.model;
    assert.equal(model.validateVersion(missingAnalyzer).ok, false, 'analyzer exige todas as chaves');
    const okDigest = structuredClone(header()); okDigest.inputs_digest = 'a'.repeat(64);
    assert.equal(model.validateVersion(okDigest).ok, true);
    const big = structuredClone(header()); big.version = 2 ** 53; big.parent_version = 2 ** 53 - 1;
    assert.equal(model.validateVersion(big).ok, false, 'version fora da faixa segura');
});

test('CI-02: blocked.clones/detected_at e outcome.source (premissa 7.8, §6.6)', () => {
    const base = model.initialDiagnosisBlock();
    const blocked = over => ({ ...base, blocked: { reason: 'DUPLICATE_SUBJECT', clones: ['/a'], detected_at: '2026-11-06T12:00:00Z', ...over } });
    assert.equal(model.validateBlock(blocked({})).ok, true);
    for (const over of [{ clones: [''] }, { clones: [1] }, { clones: '/a' }, { detected_at: 'ontem' }, { detected_at: null }]) {
        assert.equal(model.validateBlock(blocked(over)).ok, false, JSON.stringify(over));
    }
    for (const src of model.OUTCOME_SOURCES) assert.equal(model.validateBlock({ ...base, outcome: { ...base.outcome, source: src } }).ok, true, src);
    assert.equal(model.validateBlock({ ...base, outcome: { ...base.outcome, source: 'merge' } }).ok, false);
});

test('CI-03: chaves fora do contrato não somem no build nem na serialização', () => {
    const v = model.buildVersion({ ...header(), findings: [] }, { authority: true });
    assert.equal(model.validateVersion(v).ok, false);
    const bytes = model.serialize({ ...header(), findings: [] });
    assert.equal(model.validateVersion(JSON.parse(bytes.toString('utf8'))).ok, false, 'bytes de objeto inválido continuam inválidos');
    assert.equal(model.buildVersionHeader, model.buildVersion);
});

test('r2.1: chaves extras em bindings/analyzer não somem no build', () => {
    const v = model.buildVersion({ ...header(), bindings: { task_id: 't1', extra: 1 }, analyzer: { kind: 'deterministic', runtime: 'node', tool: 'x' } });
    assert.equal(v.bindings.extra, 1);
    assert.equal(v.analyzer.tool, 'x');
    assert.equal(model.validateVersion(v).ok, false);
});
