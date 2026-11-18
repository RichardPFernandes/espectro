// node --test scripts/lib/cli-result-dispatch.test.js
// PRI-381 (F1.5, AC-04): argv do despacho com WATCHER_CLI_RESULT_JSON (buildClaudeArgs em
// scripts/readmine-watcher.js) e sinais de saída (lib/agent-exit-signals.js) lendo o texto que
// a CLI devolve dentro do JSON de `--output-format json`.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.REPO_PATH = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-result-dispatch-repo-'));
const { buildClaudeArgs } = require('../readmine-watcher');
const { looksUnavailable, looksLikeSessionLimit, operationalCause } = require('./agent-exit-signals');

const PRISMA_ROOT = path.resolve(__dirname, '..', '..');
const base = { prompt: 'PROMPT', sessionName: 'sessao', sessionId: 'sid-1', nodes: ['implement'], ticketId: '999999' };

// Golden: o argv de hoje (sem routing, sem esforço, sem irmãos), copiado do despacho.
const GOLDEN = [
    '-p', 'PROMPT',
    '--name', 'sessao',
    '--session-id', 'sid-1',
    '--permission-mode', 'acceptEdits',
    '--allowedTools', 'mcp__redmine__*,Read,Edit,Write,Bash,Grep,Glob',
    '--add-dir', PRISMA_ROOT,
];

test('buildClaudeArgs: flag ausente ou off devolve o argv de hoje, idêntico', () => {
    assert.deepStrictEqual(buildClaudeArgs({ ...base, env: {} }), GOLDEN);
    assert.deepStrictEqual(buildClaudeArgs({ ...base, env: { WATCHER_CLI_RESULT_JSON: 'off' } }), GOLDEN);
});

test('buildClaudeArgs: flag off preserva bloqueio de subagente e esforço como hoje', () => {
    const args = buildClaudeArgs({ ...base, nodes: ['plan'], effortArgs: ['--effort', 'high'], env: {} });
    assert.deepStrictEqual(args.slice(0, 10), GOLDEN.slice(0, 10));
    assert.ok(args.includes('--disallowedTools'));
    assert.deepStrictEqual(args.slice(-2), ['--effort', 'high']);
    assert.ok(!args.includes('--output-format'));
});

test('buildClaudeArgs: flag on acrescenta --output-format json ao fim do argv', () => {
    const args = buildClaudeArgs({ ...base, effortArgs: ['--effort', 'high'], env: { WATCHER_CLI_RESULT_JSON: 'on' } });
    assert.deepStrictEqual(args, [...GOLDEN, '--effort', 'high', '--output-format', 'json']);
});

test('buildClaudeArgs: valor inválido da flag é erro, não vira off', () => {
    assert.throws(() => buildClaudeArgs({ ...base, env: { WATCHER_CLI_RESULT_JSON: '1' } }), /WATCHER_CLI_RESULT_JSON/);
});

// Objeto `type: "result"` da CLI numa linha, como sai em stdout, e com o prefixo do log.
function cliJson(text, { isError = true, subtype = 'success' } = {}) {
    return JSON.stringify({ type: 'result', subtype, is_error: isError, result: text, session_id: 'sid-1', total_cost_usd: 0.12 });
}

const UNAVAILABLE_TEXTS = [
    'Claude AI usage limit reached|1760000000',
    'Session limit reached ∙ resets 5pm',
    'API Error: 429 Too Many Requests "rate limit exceeded"',
    'Failed to authenticate. API Error: 401 Unauthorized\n{"error":"missing bearer"}',
    'quota exceeded for this organization',
];
const SESSION_LIMIT_TEXTS = [
    'Prompt is too long: context window exceeded',
    'API Error: max_tokens reached',
    'token limit hit',
    'Session limit reached ∙ resets 5pm',
];

for (const prefix of ['', '[claude] ']) {
    const label = prefix ? 'com prefixo [claude]' : 'sem prefixo';

    test(`looksUnavailable detecta o mesmo texto dentro do JSON da CLI (${label})`, () => {
        for (const text of UNAVAILABLE_TEXTS) {
            assert.strictEqual(looksUnavailable(text), true, `texto puro: ${text}`);
            assert.strictEqual(looksUnavailable(`${prefix}${cliJson(text)}\n`), true, `JSON: ${text}`);
        }
        assert.strictEqual(looksUnavailable(`${prefix}${cliJson('tudo certo, 3 arquivos alterados', { isError: false })}\n`), false);
    });

    test(`looksLikeSessionLimit detecta o mesmo texto dentro do JSON da CLI (${label})`, () => {
        for (const text of SESSION_LIMIT_TEXTS) {
            assert.strictEqual(looksLikeSessionLimit(text), true, `texto puro: ${text}`);
            assert.strictEqual(looksLikeSessionLimit(`${prefix}${cliJson(text)}\n`), true, `JSON: ${text}`);
        }
        assert.strictEqual(looksLikeSessionLimit(`${prefix}${cliJson('ok', { isError: false })}\n`), false);
    });

    test(`operationalCause dá a mesma causa com o texto dentro do JSON da CLI (${label})`, () => {
        const cases = [
            { output: 'Claude AI usage limit reached', stderr: '' },
            { output: '', stderr: 'Prompt is too long: context window exceeded' },
            { output: 'falhou o build', stderr: 'erro qualquer' },
        ];
        for (const { output, stderr } of cases) {
            const plain = operationalCause({ code: 1, output, stderr });
            const wrapped = operationalCause({
                code: 1,
                output: output && `${prefix}${cliJson(output)}\n`,
                stderr: stderr && `${prefix}${cliJson(stderr)}\n`,
            });
            assert.strictEqual(wrapped, plain, `output=${output} stderr=${stderr}`);
        }
        assert.strictEqual(operationalCause({ code: 0, output: `${prefix}${cliJson('ok', { isError: false })}\n` }), null);
    });
}
