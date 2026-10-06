// node --test scripts/cleanup-transcripts.test.js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const tw = require('./lib/transcript-writer');
const { runTranscriptCleanup, retentionDaysFromEnv } = require('./cleanup-transcripts');

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-09-29T12:00:00.000Z');
const iso = daysAgo => new Date(NOW - daysAgo * DAY).toISOString();

function setup() {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'cleanup-transcripts-'));
    execFileSync('git', ['init', '-q', repo]);
    return repo;
}

function seed(repo, rel, status, finishedDaysAgo) {
    const dir = path.join(repo, rel);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ task_id: path.basename(dir), status }));
    for (const [i, d] of finishedDaysAgo.entries()) {
        tw.writeTranscriptSync(path.basename(dir), 'implement', i + 1, [{ role: 'assistant', content: 'x' }],
            { status: 'success', finishedAt: iso(d) }, { taskDir: dir });
    }
    return dir;
}

test('ciclo bem-sucedido: apaga só o que passou de 30 dias e reescreve índice/state', () => {
    const repo = setup();
    const dir = seed(repo, 'memory/runs/1-ok', 'committed', [45, 5]);
    const s = runTranscriptCleanup({ repoRoot: repo, now: NOW, log: () => {} });
    assert.deepStrictEqual(s.removed, ['memory/runs/1-ok/transcripts/implement-1.json']);
    assert.ok(!fs.existsSync(path.join(dir, 'transcripts', 'implement-1.json')));
    assert.ok(fs.existsSync(path.join(dir, 'transcripts', 'implement-2.json')));
    const state = JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'));
    assert.deepStrictEqual(state.transcripts.map(t => t.attempt), [2]);
    assert.strictEqual(state.transcripts_total, 1);
    assert.deepStrictEqual(tw.readIndex(dir).map(t => t.attempt), [2]);
    fs.rmSync(repo, { recursive: true, force: true });
});

test('ciclo com falha, em andamento ou sem state.json: retém indefinidamente', () => {
    const repo = setup();
    const failed = seed(repo, 'memory/runs/_archive/2-escalado', 'escalated', [400]);
    const running = seed(repo, 'memory/runs/3-rodando', 'in_progress', [400]);
    const orphan = path.join(repo, 'memory/runs/_transcripts-unattributed/4');
    fs.mkdirSync(orphan, { recursive: true });
    tw.writeTranscriptSync('unattributed-4', 'plan', 1, [], { status: 'failed', finishedAt: iso(400) }, { taskDir: orphan });
    const s = runTranscriptCleanup({ repoRoot: repo, now: NOW, log: () => {} });
    assert.deepStrictEqual(s.removed, []);
    assert.strictEqual(s.keptFailedCycles, 1);
    for (const d of [failed, running, orphan]) assert.strictEqual(tw.readIndex(d).length, 1);
    fs.rmSync(repo, { recursive: true, force: true });
});

test('memory/archive/<YYYY-MM>/ também é varrido; --dry-run não apaga', () => {
    const repo = setup();
    const dir = seed(repo, 'memory/archive/2026-07/5-antigo', 'fully_merged', [60]);
    fs.mkdirSync(path.join(repo, 'memory', 'runs'), { recursive: true });
    const dry = runTranscriptCleanup({ repoRoot: repo, now: NOW, dryRun: true, log: () => {} });
    assert.strictEqual(dry.removed.length, 1);
    assert.ok(fs.existsSync(path.join(dir, 'transcripts', 'implement-1.json')));
    runTranscriptCleanup({ repoRoot: repo, now: NOW, log: () => {} });
    assert.ok(!fs.existsSync(path.join(dir, 'transcripts', 'implement-1.json')));
    fs.rmSync(repo, { recursive: true, force: true });
});

test('retentionDaysFromEnv: padrão 30, valor inválido cai no padrão', () => {
    assert.strictEqual(retentionDaysFromEnv({}), 30);
    assert.strictEqual(retentionDaysFromEnv({ TRANSCRIPTS_RETENTION_DAYS: '7' }), 7);
    assert.strictEqual(retentionDaysFromEnv({ TRANSCRIPTS_RETENTION_DAYS: '-1' }), 30);
});
