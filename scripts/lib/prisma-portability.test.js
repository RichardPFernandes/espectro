// PRI-60: isolated seam regressions. No listener, provider, real watcher tick or process.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { createRequire } = require('module');
const { EventEmitter } = require('events');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'prisma-portability-'));
const rootB = path.join(tmp, 'consumer-b');
fs.mkdirSync(path.join(rootB, 'memory', 'runs'), { recursive: true });
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

function isolated(file, overrides = {}, proc = process, append = '') {
    const realRequire = createRequire(file);
    const mod = { exports: {} };
    vm.runInNewContext('(function(require,module,exports,__dirname,__filename){' + fs.readFileSync(file, 'utf8') + '\n' + append + '\n})', {
        process: proc, console, Buffer, URL, AbortController, setTimeout, clearTimeout, setInterval, clearInterval,
        fetch: async () => { throw new Error('unexpected provider request'); },
    }, { filename: file })(id => Object.hasOwn(overrides, id) ? overrides[id] : realRequire(id), mod, mod.exports, path.dirname(file), file);
    return mod.exports;
}
const file = name => path.resolve(__dirname, '..', name);
function dispatcher(env = {}, cwd = rootB) {
    const proc = { env: { ...env }, argv: [], cwd: () => cwd };
    const singleton = {};
    const d = isolated(path.join(__dirname, 'node-dispatcher.js'), {
        '../readmine-watcher': new Proxy(singleton, { get: () => undefined }),
    }, proc);
    return { d, proc, singleton };
}

test('dispatcher: env-only root is normalized and loaded singleton rejects cross-consumer access', () => {
    const { d, proc } = dispatcher();
    const requested = path.join(rootB, 'child', '..');
    const first = d.loadWatcher({ env: { REPO_PATH: requested } });
    assert.equal(proc.env.REPO_PATH, rootB);
    assert.equal(d.loadWatcher({ repoPath: rootB }), first);
    assert.throws(() => d.loadWatcher({ env: { REPO_PATH: path.join(tmp, 'consumer-c') } }), /consumidor|outro consumidor/);
    assert.equal(proc.env.REPO_PATH, rootB);
});

test('dispatcher: cwd fallback and runtime context drift fail closed without leaking credential values', () => {
    const { d, proc } = dispatcher({ REDMINE_API_KEY: 'synthetic-key-A' });
    d.loadWatcher();
    assert.equal(proc.env.REPO_PATH, rootB);
    for (const [key, value] of [['REDMINE_API_KEY', 'synthetic-key-B'], ['PRE_BUILD_COMMAND', 'other-command'], ['NOTIFY_WEBHOOK_URL', 'https://notify.invalid/synthetic-secret']]) {
        const old = proc.env[key];
        proc.env[key] = value;
        assert.throws(() => d.loadWatcher(), e => /contexto.*mudou/.test(e.message) && !e.message.includes(value));
        if (old === undefined) delete proc.env[key]; else proc.env[key] = old;
    }
    assert.throws(() => d.loadWatcher({ env: { REDMINE_API_KEY: 'synthetic-key-C' } }), /contexto.*mudou/);
});

test('dispatcher: differing credential override is rejected before watcher require', () => {
    const { d, proc } = dispatcher({ REDMINE_API_KEY: 'synthetic-key-A' });
    assert.throws(() => d.loadWatcher({ env: { REPO_PATH: rootB, REDMINE_API_KEY: 'synthetic-key-B' } }), /ambiente.*difere/);
    assert.equal(proc.env.REPO_PATH, undefined);
});

test('watcher child env: resolved main root and identity override .env omission while worktree cwd stays separate', () => {
    fs.writeFileSync(path.join(rootB, '.env'), 'WATCHER_MAIN_REPO_NAME=consumer-b\n');
    const proc = { env: { PATH: '/fixture/bin', PRE_BUILD_COMMAND: 'fixture-build', CLAUDECODE: 'outer-session' },
        argv: [], cwd: () => rootB, pid: process.pid };
    const watcher = isolated(file('readmine-watcher.js'), {
        './lib/claude-account': { withClaudeAccount: () => {}, resolveClaudeAccount: () => ({ source: 'default', dir: null }), listClaudeAccounts: () => [] },
        child_process: { execSync: () => { throw new Error('no process at require'); }, execFileSync: () => { throw new Error('no process at require'); }, spawn: () => { throw new Error('no spawn'); } },
    }, proc, 'module.exports.testChildEnv = cleanAgentEnv;');
    const env = watcher.testChildEnv();
    assert.equal(env.REPO_PATH, rootB);
    assert.equal(env.WATCHER_MAIN_REPO_NAME, 'consumer-b');
    assert.equal(env.PRISMA_ROOT, path.resolve(__dirname, '../..'));
    assert.equal(env.CLAUDECODE, undefined);
    assert.notEqual(env.REPO_PATH, path.join(rootB, '.claude', 'worktrees', '123'));
});

test('redactor: every same-name source value and webhook is removed, including extra and reset', () => {
    const { createRedactor } = require('../watcher-manager');
    const envFile = path.join(tmp, 'redactor.env');
    fs.writeFileSync(envFile, 'SAME_TOKEN=file-token-value\nNOTIFY_WEBHOOK_URL=https://file.invalid/hook-token\n');
    const env = { SAME_TOKEN: 'env-token-value', NOTIFY_WEBHOOK_URL: 'https://env.invalid/hook-token' };
    const extra = { SAME_TOKEN: 'extra-token-value', NOTIFY_WEBHOOK_URL: 'https://extra.invalid/hook-token' };
    const redact = createRedactor(envFile, () => extra, env);
    const values = ['file-token-value', 'env-token-value', 'extra-token-value', ...[env.NOTIFY_WEBHOOK_URL, extra.NOTIFY_WEBHOOK_URL, 'https://file.invalid/hook-token']];
    assert.equal(redact('safe ' + values.join(' ')), 'safe ' + values.map(() => '[REDACTED]').join(' '));
    fs.writeFileSync(envFile, 'SAME_TOKEN=changed-file-token\n');
    redact.reset();
    assert.equal(redact('changed-file-token env-token-value'), '[REDACTED] [REDACTED]');
});

test('neutral preview: construction/status/start do not discover Java or invoke Maven', async () => {
    let discoveries = 0, spawns = 0;
    const preview = isolated(file('preview-manager.js'), {
        './lib/build-validator': { resolveJavaHome: () => { discoveries++; throw new Error('unexpected Java discovery'); } },
        child_process: { ...require('child_process'), spawn: () => { spawns++; throw new Error('unexpected spawn'); } },
    });
    const m = preview.createPreviewManager({ env: { REPO_PATH: rootB }, envFile: null, checkPorts: false });
    assert.equal(m.worktreesDir, path.join(rootB, '.claude', 'worktrees'));
    m.status('123');
    assert.throws(() => m.start('123'), e => e.status === 400 && /não configurado/.test(e.message));
    assert.equal(discoveries, 0);
    assert.equal(spawns, 0);
    await m.stopAll();
});

function writeRun(taskId, patch = {}) {
    const dir = path.join(rootB, 'memory', 'runs', taskId);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ task_id: taskId, node: 'commit', status: 'committed',
        history: ['plan', 'implement', 'review', 'test', 'verify', 'commit'], ...patch }));
    fs.writeFileSync(path.join(dir, 'context.md'), '# Synthetic context\n');
    return dir;
}
async function route(dash, method, routePath, req = {}) {
    const layer = dash.app._router.stack.find(s => s.route?.path === routePath && s.route.methods[method]);
    assert.ok(layer, 'route exists: ' + routePath);
    let out;
    const res = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { out = { status: this.statusCode, body }; return this; } };
    await layer.route.stack[0].handle({ params: {}, query: {}, body: {}, ...req }, res);
    assert.ok(out, 'handler responded');
    return out;
}
function dashboardHarness(env, calls) {
    const manager = { status: () => ({}), stop: async () => {}, getLogBuffer: () => [], stopAll: async () => {}, killSync: () => {} };
    const watcher = new EventEmitter();
    watcher.add = watcher.unwatch = () => watcher;
    watcher.close = async () => {};
    const factory = kind => opts => { calls.push({ kind, opts }); return { ...manager, status: () => ({ consumer: opts.repoRoot }) }; };
    const ticketHelpers = Object.fromEntries(['fetchAssignedTickets', 'getTicketDetail', 'updateTicketStatus', 'addJournalNote', 'listIssueStatuses'].map(kind => [kind, async (...args) => {
        calls.push({ kind, args });
        if (kind === 'getTicketDetail') return { id: 123, journals: [] };
        return [];
    }]));
    const server = isolated(path.resolve(__dirname, '../../dashboard/server.js'), {
        chokidar: { watch: () => watcher },
        '../scripts/watcher-manager': { createWatcherManager: factory('watcher') },
        '../scripts/preview-manager': { createPreviewManager: factory('preview') },
        '../scripts/local-checkout': { createLocalCheckout: factory('checkout') },
        '../scripts/lib/redmine-ticket-list': ticketHelpers,
        '../scripts/lib/redmine-journal-fetcher': { ...require('./redmine-journal-fetcher'),
            fetchLastRejectionNote: async (...args) => { calls.push({ kind: 'qaNote', args }); return { note: 'Synthetic QA note' }; },
            setIssueStatus: async (...args) => { calls.push({ kind: 'qaStatus', args }); return { ok: true, status: { name: 'Em Desenvolvimento' } }; } },
        '../scripts/lib/bitbucket-pr': { listPRs: async opts => { calls.push({ kind: 'prs', opts }); return []; } },
        '../scripts/notify': { ...require('../notify'), sendNotification: async (payload, opts) => { calls.push({ kind: 'notify', opts }); return { sent: true, status: 200 }; } },
        child_process: { ...require('child_process'), execFile: (bin, args, opts, cb) => { calls.push({ kind: 'exec', bin, args, opts }); cb(null, JSON.stringify({ ok: false, code: 'fixture', error: 'synthetic no dispatch' }), ''); } },
    });
    return server.createDashboard({ env, prefsFile: path.join(rootB, 'fixture-prefs.json') });
}
function ambient() {
    const keys = { REPO_PATH: path.join(tmp, 'consumer-a'), REDMINE_URL: 'https://a.invalid', REDMINE_API_KEY: 'ambient-redmine-secret',
        BITBUCKET_API_TOKEN: 'ambient-bitbucket-secret', NOTIFY_WEBHOOK_URL: 'https://a.invalid/hook-secret', DRY_RUN: 'true' };
    const old = Object.fromEntries(Object.keys(keys).map(k => [k, process.env[k]]));
    Object.assign(process.env, keys);
    return { keys, restore: () => { for (const [k, v] of Object.entries(old)) if (v === undefined) delete process.env[k]; else process.env[k] = v; } };
}

test('dashboard factories and replay use consumer B roots/env when ambient is A', async () => {
    writeRun('synthetic-replay');
    const a = ambient(), calls = [];
    const env = { REPO_PATH: rootB, REDMINE_API_KEY: 'consumer-redmine-secret', PRE_BUILD_COMMAND: 'consumer-build' };
    const dash = dashboardHarness(env, calls);
    try {
        assert.equal(dash.memoryDir, path.join(rootB, 'memory', 'runs'));
        assert.equal(dash.worktreesDir, path.join(rootB, '.claude', 'worktrees'));
        await route(dash, 'get', '/api/preview/:ticketId/status', { params: { ticketId: '123' } });
        await route(dash, 'post', '/api/runs/:taskId/replay', { params: { taskId: 'synthetic-replay' }, body: { fromNode: 'implement' } });
        for (const kind of ['watcher', 'checkout', 'preview', 'exec']) {
            const c = calls.find(c => c.kind === kind);
            assert.ok(c, kind);
            assert.equal(c.opts.env.REPO_PATH, rootB);
            assert.equal(c.opts.env.REDMINE_API_KEY, env.REDMINE_API_KEY);
            assert.equal(c.opts.env.PRISMA_ROOT, path.resolve(__dirname, '../..'));
            assert.equal(c.opts.cwd || c.opts.repoRoot, rootB);
        }
        assert.equal((await route(dash, 'get', '/api/watcher/mode')).body.dry_run, false);
        assert.equal(process.env.REPO_PATH, a.keys.REPO_PATH, 'factory must not rewrite process');
    } finally { await dash.close(); a.restore(); }
});

test('dashboard provider wrappers, QA status and secret union are scoped to consumer B', async () => {
    writeRun('50001-qa', { ticket_status: 'Recusa QA', redmine_ticket: { id: 50001 } });
    const a = ambient(), calls = [];
    const env = { REPO_PATH: rootB, REDMINE_URL: 'https://b.invalid', REDMINE_API_KEY: 'consumer-redmine-secret',
        BITBUCKET_WORKSPACE: 'workspace-b', BITBUCKET_REPO_SLUG: 'consumer-b', BITBUCKET_ACCOUNT_ID: 'account-b', BITBUCKET_API_TOKEN: 'consumer-bitbucket-secret',
        NOTIFY_WEBHOOK_URL: 'https://b.invalid/hook-secret', REDMINE_STATUS_EM_DESENVOLVIMENTO_ID: '29' };
    const leakText = [...Object.values(a.keys), env.REDMINE_API_KEY, env.BITBUCKET_API_TOKEN, env.NOTIFY_WEBHOOK_URL].join(' ');
    const dir = writeRun('synthetic-redact', { note: leakText });
    fs.writeFileSync(path.join(dir, 'context.md'), leakText);
    const dash = dashboardHarness(env, calls);
    try {
        await route(dash, 'get', '/api/tickets/mine');
        await route(dash, 'get', '/api/tickets/:id', { params: { id: '123' } });
        await route(dash, 'get', '/api/tickets/statuses');
        await route(dash, 'put', '/api/tickets/:id/status', { params: { id: '123' }, body: { statusId: 29 } });
        await route(dash, 'post', '/api/tickets/:id/note', { params: { id: '123' }, body: { note: 'fixture note' } });
        await route(dash, 'get', '/api/prs');
        await route(dash, 'post', '/api/notify/test');
        const qa = await route(dash, 'post', '/api/runs/:taskId/retry-qa-rejection', { params: { taskId: '50001-qa' }, body: { operation_id: 'synthetic-operation-123' } });
        assert.equal(qa.status, 200);
        for (const c of calls.filter(c => c.args)) assert.deepEqual(JSON.parse(JSON.stringify(c.args.at(-1))), { redmineUrl: env.REDMINE_URL, apiKey: env.REDMINE_API_KEY });
        assert.equal(calls.find(c => c.kind === 'qaStatus').args[1], 29);
        for (const c of calls.filter(c => c.kind === 'prs')) {
            assert.equal(c.opts.token, env.BITBUCKET_API_TOKEN); assert.equal(c.opts.workspace, 'workspace-b'); assert.equal(c.opts.repo, 'consumer-b');
        }
        assert.equal(calls.find(c => c.kind === 'notify').opts.webhookUrl, env.NOTIFY_WEBHOOK_URL);
        const redacted = await route(dash, 'get', '/api/runs/:taskId', { params: { taskId: 'synthetic-redact' } });
        for (const secret of [a.keys.REDMINE_API_KEY, a.keys.BITBUCKET_API_TOKEN, a.keys.NOTIFY_WEBHOOK_URL, env.REDMINE_API_KEY, env.BITBUCKET_API_TOKEN, env.NOTIFY_WEBHOOK_URL]) {
            assert.ok(!JSON.stringify(redacted.body).includes(secret));
        }
        assert.equal(process.env.REDMINE_API_KEY, a.keys.REDMINE_API_KEY);
    } finally { await dash.close(); a.restore(); }
});

test('ResponseFactory map is explicit per consumer; platform has no business factory defaults', () => {
    const validator = require('./openapi-validator');
    // 442 e 501 são a expectativa já escrita neste teste. O arquivo do consumidor
    // não está no repo e o runner descarta OPENAPI_*; a contagem 15 daquele arquivo
    // não é reproduzível aqui.
    const factory = { entityRelationship: 442, notImplemented: 501 };
    const factoryFile = path.join(tmp, 'response-factory.json');
    fs.writeFileSync(factoryFile, JSON.stringify(factory));
    const old = process.env.OPENAPI_RESPONSE_FACTORY_FILE;
    try {
        delete process.env.OPENAPI_RESPONSE_FACTORY_FILE;
        assert.equal(validator.javaStatuses('return ResponseFactory.entityRelationship();', 1).codes.size, 0);
        process.env.OPENAPI_RESPONSE_FACTORY_FILE = factoryFile;
        const statuses = validator.javaStatuses('return ResponseFactory.entityRelationship(); return ResponseFactory.notImplemented();', 1);
        assert.deepEqual([...statuses.codes.keys()], [442, 501]);
        assert.deepEqual(JSON.parse(fs.readFileSync(factoryFile, 'utf8')), factory);
    } finally { if (old === undefined) delete process.env.OPENAPI_RESPONSE_FACTORY_FILE; else process.env.OPENAPI_RESPONSE_FACTORY_FILE = old; }
});

test('package-rule matching is enabled only by explicit consumer prefix', () => {
    const { matchesRegra } = require('./spec-enricher');
    const old = process.env.SPEC_RULE_PACKAGE_PREFIX;
    const source = 'src/main/java/br/com/mosistemas/app/track/calculofrete/GrupoDTO.java';
    const rule = 'br.com.mosistemas.app.track.calculofrete é crítico';
    try {
        delete process.env.SPEC_RULE_PACKAGE_PREFIX;
        assert.equal(matchesRegra(source, rule), false);
        process.env.SPEC_RULE_PACKAGE_PREFIX = 'br.com.mosistemas.app';
        assert.equal(matchesRegra(source, rule), true);
        process.env.SPEC_RULE_PACKAGE_PREFIX = 'br.com.other.app';
        assert.equal(matchesRegra(source, rule), false);
    } finally { if (old === undefined) delete process.env.SPEC_RULE_PACKAGE_PREFIX; else process.env.SPEC_RULE_PACKAGE_PREFIX = old; }
});
