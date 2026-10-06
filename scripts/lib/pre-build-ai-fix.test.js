const test = require('node:test');
// Conta do Claude do dashboard real (dashboard-prefs.json) não vaza pro env esperado do filho.
process.env.DASHBOARD_PREFS_FILE = require('path').join(require('os').tmpdir(), 'sem-dashboard-prefs.json');
delete process.env.WATCHER_CLAUDE_CONFIG_DIR;
const assert = require('node:assert');
const { EventEmitter } = require('events');
const { PassThrough } = require('stream');
const fix = require('./pre-build-ai-fix');

function fakeSpawn(lines, { code = 0, hang = false } = {}) {
    const calls = [];
    const spawn = (bin, args, opts) => {
        const child = new EventEmitter();
        child.stdout = new PassThrough();
        child.stderr = new PassThrough();
        child.pid = 4242;
        child.kill = () => { child.stdout.end(); child.stderr.end(); setImmediate(() => child.emit('close', null)); };
        calls.push({ bin, args, opts, child });
        setImmediate(() => {
            // Linha partida no meio do chunk: o parser tem que juntar.
            const all = lines.map(l => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + '\n';
            child.stdout.write(all.slice(0, 7));
            child.stdout.write(all.slice(7));
            if (!hang) { child.stdout.end(); child.stderr.end(); setImmediate(() => child.emit('close', code)); }
        });
        return child;
    };
    return { spawn, calls };
}

test('parseStreamLine: init, texto, ferramenta, erro de ferramenta, result', () => {
    assert.deepStrictEqual(fix.parseStreamLine(JSON.stringify({ type: 'system', subtype: 'init', model: 'claude-x' })), [{ kind: 'start', text: 'Sessão iniciada (claude-x)' }]);
    const a = fix.parseStreamLine(JSON.stringify({ type: 'assistant', message: { content: [
        { type: 'text', text: ' Vou olhar. ' },
        { type: 'tool_use', name: 'Edit', input: { file_path: '/wt/src/A.java' } },
        { type: 'tool_use', name: 'Bash', input: { command: 'mvn compile -q' } },
    ] } }), { cwd: '/wt' });
    assert.deepStrictEqual(a.map(e => e.text), ['Vou olhar.', 'Editando src/A.java', '$ mvn compile -q']);
    assert.deepStrictEqual(fix.parseStreamLine(JSON.stringify({ type: 'user', message: { content: [
        { type: 'tool_result', content: 'ok' },
        { type: 'tool_result', is_error: true, content: [{ type: 'text', text: 'BUILD FAILURE' }] },
    ] } })), [{ kind: 'tool_error', text: 'BUILD FAILURE' }]);
    const [r] = fix.parseStreamLine(JSON.stringify({ type: 'result', subtype: 'success', result: 'Corrigido.', total_cost_usd: 0.31, num_turns: 9, duration_ms: 1000 }));
    assert.deepStrictEqual(r, { kind: 'result', error: false, text: 'Corrigido.', costUsd: 0.31, durationMs: 1000, turns: 9 });
    assert.deepStrictEqual(fix.parseStreamLine('não é json'), [{ kind: 'log', text: 'não é json' }]);
    assert.deepStrictEqual(fix.parseStreamLine(''), []);
});

test('buildPrompt / claudeArgs: erros no prompt, stream-json, sem subagente, add-dir dos irmãos', () => {
    const prompt = fix.buildPrompt({ ticketId: 123, errors: ['A.java:3 — x'], extra: 'olhe o app-core' });
    assert.match(prompt, /#123/);
    assert.match(prompt, /A\.java:3 — x/);
    assert.match(prompt, /Não faça commit/);
    assert.match(prompt, /olhe o app-core/);
    assert.match(prompt, /explique o que rodar/, 'sem worktree irmão: só explica');
    const withSib = fix.buildPrompt({ ticketId: 123, errors: ['x'], siblingDirs: ['/ws/mo-entity/.claude/worktrees/123'] });
    assert.match(withSib, /mvn install -DskipTests[\s\S]*\/ws\/mo-entity\/\.claude\/worktrees\/123/);
    assert.match(withSib, /Nunca rode install no checkout principal/);
    const args = fix.claudeArgs(prompt, { addDirs: ['/ws/app-core/.claude/worktrees/123'] });
    assert.deepStrictEqual(args.slice(0, 2), ['-p', prompt]);
    assert.ok(args.includes('stream-json') && args.includes('--verbose'));
    assert.strictEqual(args[args.indexOf('--disallowedTools') + 1], 'Agent,Task');
    assert.strictEqual(args[args.indexOf('--add-dir') + 1], '/ws/app-core/.claude/worktrees/123');
});

test('agentEnv: tira CLAUDE* e põe o JDK na frente do PATH', () => {
    const env = fix.agentEnv({ CLAUDECODE: '1', CLAUDE_CODE_ENTRYPOINT: 'x', AI_AGENT: 'y', PATH: '/usr/bin', HOME: '/h' }, '/jdk25');
    assert.deepStrictEqual(Object.keys(env).sort(), ['HOME', 'JAVA_HOME', 'PATH']);
    assert.strictEqual(env.PATH, '/jdk25/bin:/usr/bin');
});

test('resolveTimeoutMs: env válida sobrescreve, inválida cai no padrão', () => {
    assert.strictEqual(fix.resolveTimeoutMs({ PRE_BUILD_AI_FIX_TIMEOUT_MS: '5000' }), 5000);
    assert.strictEqual(fix.resolveTimeoutMs({ PRE_BUILD_AI_FIX_TIMEOUT_MS: 'x' }), fix.DEFAULT_TIMEOUT_MS);
});

test('startFix: emite eventos na ordem e devolve o result', async () => {
    const { spawn, calls } = fakeSpawn([
        { type: 'system', subtype: 'init' },
        { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: '/wt/B.java' } }] } },
        { type: 'result', subtype: 'success', result: 'pronto', total_cost_usd: 0.1 },
    ]);
    const events = [];
    const h = fix.startFix({ worktree: '/wt', args: ['-p', 'x'], env: {}, spawn, onEvent: e => events.push(e) });
    const out = await h.done;
    assert.strictEqual(calls[0].bin, 'claude');
    assert.strictEqual(calls[0].opts.cwd, '/wt');
    assert.deepStrictEqual(events.map(e => e.kind), ['start', 'tool', 'result']);
    assert.strictEqual(events[1].text, 'Lendo B.java');
    assert.deepStrictEqual({ code: out.code, cancelled: out.cancelled, timedOut: out.timedOut, text: out.result.text }, { code: 0, cancelled: false, timedOut: false, text: 'pronto' });
});

test('startFix: cancel e timeout encerram o agente', async () => {
    const a = fakeSpawn([{ type: 'system', subtype: 'init' }], { hang: true });
    const h = fix.startFix({ worktree: '/wt', args: [], env: {}, spawn: a.spawn });
    h.cancel();
    assert.strictEqual((await h.done).cancelled, true);
    const b = fakeSpawn([], { hang: true });
    const t = await fix.startFix({ worktree: '/wt', args: [], env: {}, spawn: b.spawn, timeoutMs: 20 }).done;
    assert.strictEqual(t.timedOut, true);
});
