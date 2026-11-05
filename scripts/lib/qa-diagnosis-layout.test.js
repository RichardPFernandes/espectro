'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const layout = require('./qa-diagnosis-layout');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pri181-c2-layout-'));
const repo = path.join(tmp, 'consumer');
fs.mkdirSync(repo, { recursive: true });

test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

test('C2 layout: staging/records/trash sob memory/qa-diagnosis', () => {
    const root = layout.ensureLayout(repo);
    assert.equal(root, path.join(repo, 'memory', 'qa-diagnosis'));
    for (const sub of ['staging', 'records', 'trash']) {
        assert.ok(fs.statSync(path.join(root, sub)).isDirectory());
    }
});

test('C2 layout: keySegment estável e paths distintos', () => {
    const key = 'qa-rej:v1:t990001:j102';
    const p = layout.pathsFor(repo, key);
    assert.match(p.keySegment, /^qa-rej_v1_t990001_j102$/);
    assert.notEqual(p.stagingDir, p.authorityDir);
    assert.ok(p.stagingDir.includes(`${path.sep}staging${path.sep}`));
    assert.ok(p.authorityDir.includes(`${path.sep}records${path.sep}`));
});

test('C2 R3-A: assertStagingNotAuthority falha se AUTHORITY vazar no staging', () => {
    const p = layout.pathsFor(repo, 'qa-rej:v1:t1:j1');
    fs.mkdirSync(p.stagingDir, { recursive: true });
    fs.writeFileSync(path.join(p.stagingDir, layout.AUTHORITY_MARKER), 'bad\n');
    assert.throws(() => layout.assertStagingNotAuthority(p.stagingDir), /STAGING_IS_AUTHORITY|INV-R3-01/);
});

test('C2 no-replace: RENAME_NOREPLACE permanece UNKNOWN neste runtime se ausente', () => {
    // Não inventar PASS: só registrar o fato do runtime.
    assert.equal(typeof layout.renameNoReplaceAvailable, 'boolean');
});
