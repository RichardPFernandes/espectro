'use strict';
// PRI-181 c2b-1-model (SPEC-c2b-1-model r3.1): AC-05 (schema do state sempre ligado), AC-06
// (preservação do bloco diagnosis pelos writers existentes e pelo archive) e Records v1 legados.
// Fixtures sintéticas do C0 (PR #50); nada de consumidor.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const fixture = require('../fixtures/qa-rejection/current.json');
const { validateState } = require('../validate-state');
const stateWriter = require('../state-writer');
const qaCycles = require('./qa-cycles');
const qaIngest = require('./qa-rejection-ingest');
const model = require('./qa-diagnosis-model');
const store = require('./qa-diagnosis-store');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pri181-c2b1-compat-'));
const repo = path.join(tmp, 'consumer');
fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
test.after(() => {
    const walk = d => { for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory() && !e.isSymbolicLink()) walk(p); else if (e.isFile()) { try { fs.chmodSync(p, 0o644); } catch { /* ok */ } }
    } };
    try { walk(tmp); } catch { /* ok */ }
    fs.rmSync(tmp, { recursive: true, force: true });
});

const KEY = 'redmine:900001:j900002';
const SHA = 'a'.repeat(64);
function block() {
    return { ...model.initialDiagnosisBlock(), rev: 4, status: 'proposed', current_version: 1, current_sha256: SHA,
        versions: [{ v: 1, sha256: SHA, produced_by: 'deterministic', at: '2026-11-06T12:00:00Z' }] };
}
function baseState(extra = {}) {
    return { ...fixture.base_state, task_id: '900001-synthetic', ticket_status: 'Recusa QA', ...structuredClone(extra) };
}

// ---------------------------------------------------------------- AC-05 (schema sempre ligado)
test('AC-05: diagnosis válido, malformado, null, array, string, número ou ausente — state continua válido', () => {
    const entry = { n: 1, note: null, rejected_at: '2026-01-02T11:00:00Z', journal_id: 102, retry_requested_at: null };
    for (const diagnosis of [block(), { rev: 'x' }, null, [], 'x', 7, undefined]) {
        const e = diagnosis === undefined ? entry : { ...entry, diagnosis };
        const r = validateState(baseState({ qa_rejections: [e] }));
        assert.equal(r.valid, true, `diagnosis=${JSON.stringify(diagnosis)}: ${JSON.stringify(r.errors)}`);
    }
    assert.equal(model.validateBlock({ rev: 'x' }).ok, false, 'só o validateBlock recusa o malformado');
});

test('AC-05: state legado com qa_diagnosis (ponteiro C2) continua válido', () => {
    const pointer = { rejection_key: 'qa-rej:v1:t900001:j90', identity_quality: 'OK', published_at: '2026-11-01T10:00:00.000Z',
        authority_path: 'memory/qa-diagnosis/records/x', schema_version: 'qa-diagnosis-record/v1', findings_status: 'UNKNOWN',
        taxonomy_version: null, findings_count: 0, is_context_record: false };
    assert.equal(validateState(baseState({ qa_diagnosis: pointer })).valid, true);
});

test('AC-05: o schema não dá type a diagnosis e marca qa_diagnosis como legado', () => {
    const schema = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../.graph/schemas/state.schema.json'), 'utf8'));
    const diag = schema.properties.qa_rejections.items.properties.diagnosis;
    assert.ok(diag && typeof diag.description === 'string');
    assert.deepEqual(Object.keys(diag), ['description']);
    assert.match(schema.properties.qa_diagnosis.description, /Legado/);
});

// ---------------------------------------------------------------- AC-06 (writers existentes)
test('AC-06: qaCycles.appendRejection (retry pelo dashboard) preserva diagnosis byte a byte', () => {
    const entry = { n: 1, note: 'n', rejected_at: '2026-01-02T11:00:00Z', journal_id: 102, detected_at: '2026-01-02T11:05:00Z',
        retry_requested_at: null, rejection_key: KEY, diagnosis: block() };
    const before = JSON.stringify(entry.diagnosis);
    const out = qaCycles.appendRejection(baseState({ qa_rejections: [entry] }), '', { note: 'n', rejected_at: entry.rejected_at, journal_id: 102, at: '2026-01-02T12:00:00.000Z' });
    assert.equal(out.length, 1);
    assert.equal(JSON.stringify(out[0].diagnosis), before);
    assert.equal(out[0].retry_requested_at, '2026-01-02T12:00:00.000Z');
});

test('AC-06: qaCycles.recordRejection preserva entradas com diagnosis', () => {
    const entry = { n: 1, note: null, rejected_at: '2026-01-02T11:00:00Z', journal_id: 102, detected_at: 'x',
        retry_requested_at: '2026-01-02T12:00:00Z', rejection_key: KEY, diagnosis: block() };
    const before = JSON.stringify(entry);
    const same = qaCycles.recordRejection(baseState({ qa_rejections: [entry] }), '', { rejection_key: KEY, at: 'y' });
    assert.equal(JSON.stringify(same[0]), before);
    const more = qaCycles.recordRejection(baseState({ qa_rejections: [entry] }), '', { rejected_at: '2026-01-03T11:00:00Z', at: 'z' });
    assert.equal(more.length, 2);
    assert.equal(JSON.stringify(more[0]), before);
});

test('AC-06: qaIngest.ingestFromJournals preserva diagnosis das entradas existentes', () => {
    const note = { note: 'n', journal_id: 102, rejected_at: '2026-01-02T11:00:00Z' };
    const first = qaIngest.ingestFromJournals({ ticketId: 900001, journals: fixture.journals.between_polls, state: { ticket_status: 'Recusa QA' },
        noteSource: note, repoPath: repo, at: '2026-01-02T14:00:00.000Z', ticketFallbackRejectedAt: '2026-01-02T14:00:00Z' });
    assert.ok(first.state.qa_rejections.length >= 2);
    const withDiag = structuredClone(first.state);
    withDiag.qa_rejections[0].diagnosis = block();
    const before = JSON.stringify(withDiag.qa_rejections[0]);
    const again = qaIngest.ingestFromJournals({ ticketId: 900001, journals: fixture.journals.between_polls, state: withDiag,
        noteSource: note, repoPath: repo, at: '2026-01-02T15:00:00.000Z', ticketFallbackRejectedAt: '2026-01-02T15:00:00Z' });
    const after = (again.state || withDiag).qa_rejections[0];
    assert.equal(JSON.stringify(after), before);
});

function makeRun(root, taskId, state) {
    const dir = path.join(root, taskId);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'state.json'), `${JSON.stringify(state, null, 2)}\n`);
    return dir;
}
function stagingFile(over = {}) {
    const dir = path.join(tmp, '.qa-diagnosis-staging');
    fs.mkdirSync(dir, { recursive: true });
    const f = path.join(dir, `stg-${Math.random().toString(36).slice(2)}.json`);
    fs.writeFileSync(f, model.serialize(model.buildVersion({ rejection_key: KEY, version: 1, parent_version: 0,
        job_token: 'job-900001-a', produced_by: 'deterministic', created_at: '2026-11-06T12:00:00.000Z',
        bindings: { task_id: '900001-synthetic' }, analyzer: { kind: 'deterministic', runtime: 'node' }, ...over })), { flag: 'wx' });
    return f;
}

test('AC-06: stateWriter.archive leva qa-diagnosis/<slug>/v001.json e quarantine/ com o run (sha e modo conferidos)', () => {
    const runs = path.join(repo, 'memory', 'runs');
    const dir = makeRun(runs, '900001-synthetic', baseState({ node: 'commit', status: 'committed' }));
    const v = store.createVersionExclusive(dir, KEY, 1, stagingFile());
    assert.equal(v.code, 'CREATED');
    const q = store.quarantineExclusive(dir, KEY, 'job-q', stagingFile({ job_token: 'job-900001-q' }));
    assert.equal(q.code, 'CREATED');
    const sha = v.sha256;
    const target = path.join(runs, '_archive', '900001-synthetic');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    stateWriter.archive(dir, target, { actor: 'test' });
    const slug = store.slug(KEY).slug;
    const moved = path.join(target, store.STORE_DIR, slug, 'v001.json');
    assert.equal(model.sha256(fs.readFileSync(moved)), sha);
    assert.equal(fs.lstatSync(moved).mode & 0o777, 0o444);
    assert.ok(fs.existsSync(path.join(target, store.STORE_DIR, slug, store.QUARANTINE_DIR, 'job-q.json')));
    const blk = { ...model.initialDiagnosisBlock(), status: 'proposed', rev: 1, current_version: 1, current_sha256: sha,
        versions: [{ v: 1, sha256: sha, produced_by: 'deterministic', at: '2026-11-06T12:00:00Z' }] };
    assert.deepEqual(store.verifyCurrentVersion(target, KEY, blk), { result: 'OK' });
});

// ---------------------------------------------------------------- Records v1 legados
test('Legado: Record v1 no store por repo e qa_diagnosis no state são ignorados e ficam byte a byte', () => {
    const legacyDir = path.join(repo, 'memory', 'qa-diagnosis', 'records', 'qa-rej_v1_t900001_j90');
    fs.mkdirSync(legacyDir, { recursive: true });
    const recFile = path.join(legacyDir, 'diagnosis-record.json');
    fs.writeFileSync(recFile, '{"schema_version":"qa-diagnosis-record/v1","authority":true}\n');
    const recBefore = fs.readFileSync(recFile);
    const pointer = { rejection_key: 'qa-rej:v1:t900001:j90', authority_path: legacyDir, schema_version: 'qa-diagnosis-record/v1' };
    const dir = makeRun(path.join(repo, 'memory', 'runs'), '900002-synthetic', baseState({ qa_diagnosis: pointer }));
    const stateBefore = fs.readFileSync(path.join(dir, 'state.json'));
    assert.deepEqual(store.listVersions(dir, KEY), { ok: true, versions: [], anomalies: [] });
    assert.deepEqual(store.verifyCurrentVersion(dir, KEY, model.initialDiagnosisBlock()), { result: 'NO_VERSION' });
    assert.equal(store.slug('qa-rej:v1:t900001:j90').code, 'INVALID_KEY');
    assert.equal(Buffer.compare(fs.readFileSync(recFile), recBefore), 0);
    assert.equal(Buffer.compare(fs.readFileSync(path.join(dir, 'state.json')), stateBefore), 0);
    assert.equal(validateState(JSON.parse(stateBefore)).valid, true);
});
