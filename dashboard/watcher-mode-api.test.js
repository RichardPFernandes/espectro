// node --test watcher-mode-api.test.js
// GET /api/watcher/mode (banner DRY-RUN): lê memory/runs/.watcher-mode, gravado pelo
// watcher a cada tick (scripts/lib/dry-run.js), ou DRY_RUN=true no env do dashboard.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createDashboard } = require('./server');

const tmpBase = process.env.CLAUDE_JOB_DIR ? path.join(process.env.CLAUDE_JOB_DIR, 'tmp') : os.tmpdir();

async function start(env = {}) {
    const tmp = fs.mkdtempSync(path.join(tmpBase, 'watcher-mode-api-'));
    const runs = path.join(tmp, 'memory', 'runs');
    fs.mkdirSync(runs, { recursive: true });
    const dash = createDashboard({ memoryDir: runs, worktreesDir: path.join(tmp, 'wt'), prefsFile: path.join(tmp, 'prefs.json'), env });
    await new Promise(r => dash.server.listen(0, '127.0.0.1', r));
    await dash.ready;
    const base = `http://localhost:${dash.server.address().port}`;
    return {
        runs,
        get: async () => (await fetch(`${base}/api/watcher/mode`)).json(),
        close: async () => { await dash.close(); fs.rmSync(tmp, { recursive: true, force: true }); },
    };
}

const writeMode = (runs, data) => fs.writeFileSync(path.join(runs, '.watcher-mode'), JSON.stringify(data));

test('sem .watcher-mode: modo desconhecido, sem banner', async () => {
    const d = await start();
    try {
        assert.deepStrictEqual(await d.get(), { mode: 'unknown', dry_run: false, source: null, updated_at: null, fixture: null, tickets: [] });
    } finally { await d.close(); }
});

test('último tick em dry-run liga o banner com fixture e tickets; tick live desliga', async () => {
    const d = await start();
    try {
        writeMode(d.runs, { mode: 'dry-run', dry_run: true, fixture: 'scripts/fixtures/ticket-example.json', tickets: [99999], updated_at: '2026-09-29T12:00:00Z' });
        assert.deepStrictEqual(await d.get(), {
            mode: 'dry-run', dry_run: true, source: 'file', updated_at: '2026-09-29T12:00:00Z',
            fixture: 'scripts/fixtures/ticket-example.json', tickets: [99999],
        });
        writeMode(d.runs, { mode: 'live', dry_run: false, updated_at: '2026-09-29T12:05:00Z' });
        const m = await d.get();
        assert.deepStrictEqual([m.mode, m.dry_run, m.fixture, m.tickets], ['live', false, null, []]);
    } finally { await d.close(); }
});

test('dashboard com DRY_RUN=true no env: banner ligado mesmo antes do primeiro tick', async () => {
    const d = await start({ DRY_RUN: 'true' });
    try {
        writeMode(d.runs, { mode: 'live', dry_run: false });
        const m = await d.get();
        assert.deepStrictEqual([m.mode, m.dry_run, m.source], ['dry-run', true, 'env']);
    } finally { await d.close(); }
});

test('.watcher-mode corrompido não derruba o endpoint', async () => {
    const d = await start();
    try {
        fs.writeFileSync(path.join(d.runs, '.watcher-mode'), '{nao é json');
        assert.strictEqual((await d.get()).dry_run, false);
    } finally { await d.close(); }
});
