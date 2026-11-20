// node --require ./harness/loopback-only.cjs --test scripts/lib/jev-calibration.test.js
// PRI-205 S3b T8: reprodutibilidade do Jev (U15, SPEC §B9, AC-13). Mesma entrada N
// vezes; cada repetição é um Attempt de efeito próprio (rep_index na EffectId).
// Dado faltante é UNKNOWN, nunca concordância. Cliente falso; nada sai da máquina.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const cal = require('./jev-calibration');
const dom06 = require('./dom06-attempt');

const tmpBase = process.env.CLAUDE_JOB_DIR ? path.join(process.env.CLAUDE_JOB_DIR, 'tmp') : os.tmpdir();
const dirs = [];
test.after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });
const KEY = 'chave-falsa-' + 'calibracao-01';

function canonical(v) {
    if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
    if (v && typeof v === 'object') return `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
    return JSON.stringify(v === undefined ? null : v);
}
const shaOf = env => crypto.createHash('sha256').update(canonical(env)).digest('hex');

function envelope(i) {
    return { step_text: `Passo sintético ${i} em src/m${i}.js`, ac_texts: [`AC-0${i}: algo visível`], declared_paths: [`src/m${i}.js`] };
}

// Runs sintéticas com envelopes gravados como o classifier-shadow grava (Q6).
function runsWith(envs) {
    const runs = fs.mkdtempSync(path.join(tmpBase, 'jev-cal-'));
    dirs.push(runs);
    envs.forEach((e, i) => {
        const d = path.join(runs, `task-${i}`, 'dom06', 'classifier', 'envelopes');
        fs.mkdirSync(d, { recursive: true });
        fs.writeFileSync(path.join(d, `${shaOf(e)}.json`), JSON.stringify(e));
    });
    return runs;
}

const EFF = {
    provider: 'jev', declared: 'jev', mode: 'shadow', reason: null, detail: null,
    authority_ref: { id: 'ref-1', sha256: 'd'.repeat(64), path: '.claude/classifier-authority.json' },
    credential: { keychain: 'prisma-jev-typesafe', account: 'typesafe' },
    model_id: 'jev-latest', timeout_ms: 3000, guard_version: 'classifier-guard@1',
};
const cred = async () => ({ ok: true, value: KEY });

// Cliente falso: `answer(call)` decide a classe de cada chamada (contador global).
function fakeClient(answer) {
    const calls = [];
    return {
        calls,
        classify: async input => {
            calls.push(input);
            const r = answer(calls.length, input);
            if (r && r.outcome) return { class: null, confidence: null, risky: null, model_reported: null, parse: null, http_status: null, auth_rejected: false, latency_ms: 1, detail: null, ...r };
            return { outcome: 'OK', certain: true, parse: 'OK', class: r, confidence: 0.9, risky: 0.1, model_reported: 'jev-x', http_status: 200, auth_rejected: false, latency_ms: 1, detail: null };
        },
    };
}

function go(runsDir, extra = {}) {
    return cal.calibrate({ runsDir, n: 5, effective: EFF, credentialProvider: cred, ...extra });
}

test('fake determinístico → 5/5 iguais em todas as entradas, taxa 1, PASS; 10 efeitos com rep_index 1..5', async () => {
    const runs = runsWith([envelope(1), envelope(2)]);
    const client = fakeClient(() => 'C3');
    const r = await go(runs, { maxCalls: 20, client });
    assert.strictEqual(r.status, 'OK');
    assert.strictEqual(r.report.calls_made, 10);
    assert.deepStrictEqual(r.report.envelopes.map(e => [e.answered, e.all_equal, e.agreement, e.mode_class]), [[5, true, 1, 'C3'], [5, true, 1, 'C3']]);
    assert.deepStrictEqual([r.report.summary.rate, r.report.summary.threshold, r.report.summary.verdict], [1, 0.95, 'PASS']);
    const attempts = dom06.listAttempts(r.report.out_dir).filter(a => a.node === 'classifier');
    assert.strictEqual(attempts.length, 10);
    assert.deepStrictEqual([...new Set(attempts.map(a => a.snapshot.rep_index))].sort(), [1, 2, 3, 4, 5]);
    assert.strictEqual(new Set(attempts.map(a => a.snapshot.effect_id)).size, 10);
    assert.ok(attempts.every(a => a.snapshot.purpose === 'U15'));
});

test('fake alternado → concordância da moda e taxa calculadas; abaixo de 0,95 = FAIL', async () => {
    const runs = runsWith([envelope(1), envelope(2)]);
    const client = fakeClient(n => (n % 2 ? 'C3' : 'C4'));
    const r = await go(runs, { maxCalls: 10, client });
    const [a] = r.report.envelopes;
    assert.deepStrictEqual([a.answered, a.all_equal, a.agreement, a.mode_class, a.answers], [5, false, 0.6, 'C3', { C3: 3, C4: 2 }]);
    assert.deepStrictEqual([r.report.summary.all_equal_count, r.report.summary.rate, r.report.summary.verdict], [0, 0, 'FAIL']);
});

test('--max-calls é respeitado; o que faltou é UNKNOWN, nunca concordância; rodar de novo completa sem refazer COMPLETE', async () => {
    const runs = runsWith([envelope(1), envelope(2)]);
    const client = fakeClient(() => 'C2');
    const first = await go(runs, { maxCalls: 7, client });
    assert.strictEqual(client.calls.length, 7);
    const second = first.report.envelopes[1];
    assert.deepStrictEqual([second.answered, second.missing, second.agreement, second.all_equal], [2, 3, 'UNKNOWN', 'UNKNOWN']);
    assert.deepStrictEqual([first.report.summary.rate, first.report.summary.verdict], ['UNKNOWN', 'UNKNOWN']);

    const again = await go(runs, { maxCalls: 10, client });
    assert.strictEqual(again.report.calls_made, 3, 'só as 3 que faltavam');
    assert.strictEqual(client.calls.length, 10);
    assert.strictEqual(again.report.summary.verdict, 'PASS');
});

test('resposta incerta conta como faltante e nunca é refeita', async () => {
    const runs = runsWith([envelope(1)]);
    const client = fakeClient(n => (n === 3 ? { outcome: 'UNCERTAIN', certain: false, detail: 'TIMEOUT' } : 'C3'));
    const r = await go(runs, { maxCalls: 5, client });
    assert.deepStrictEqual([r.report.envelopes[0].answered, r.report.envelopes[0].missing, r.report.summary.verdict], [4, 1, 'UNKNOWN']);
    const again = await go(runs, { maxCalls: 5, client });
    assert.strictEqual(again.report.calls_made, 0);
    assert.strictEqual(client.calls.length, 5);
    assert.strictEqual(again.report.summary.verdict, 'UNKNOWN');
});

test('uso: --max-calls ausente ou inválido, ou N fora de 2..20 → USAGE, nada é chamado', async () => {
    const runs = runsWith([envelope(1)]);
    const client = fakeClient(() => 'C3');
    for (const extra of [{ maxCalls: undefined }, { maxCalls: 0 }, { maxCalls: 2.5 }, { maxCalls: 5, n: 1 }, { maxCalls: 5, n: 21 }]) {
        const r = await go(runs, { client, ...extra });
        assert.strictEqual(r.status, 'USAGE', JSON.stringify(extra));
    }
    assert.strictEqual(client.calls.length, 0);
});

test('núcleo 2 efetivo off → OFF com o motivo, nada é chamado', async () => {
    const client = fakeClient(() => 'C3');
    const r = await go(runsWith([envelope(1)]), { maxCalls: 5, client, effective: { provider: 'off', reason: 'AUTHORITY_REF_ABSENT' } });
    assert.deepStrictEqual([r.status, r.reason], ['OFF', 'AUTHORITY_REF_ABSENT']);
    assert.strictEqual(client.calls.length, 0);
});

test('relatório sem texto de envelope nem chave; envelope adulterado é pulado e contado', async () => {
    const runs = runsWith([envelope(1)]);
    const bad = path.join(runs, 'task-x', 'dom06', 'classifier', 'envelopes');
    fs.mkdirSync(bad, { recursive: true });
    fs.writeFileSync(path.join(bad, `${'f'.repeat(64)}.json`), JSON.stringify(envelope(9)));
    const r = await go(runs, { maxCalls: 5, client: fakeClient(() => 'C3') });
    const out = JSON.stringify(r);
    assert.ok(!out.includes('Passo sintético') && !out.includes(KEY));
    assert.strictEqual(r.report.skipped_invalid, 1);
    assert.strictEqual(r.report.envelopes.length, 1);
    assert.match(r.report.envelopes[0].envelope, /^[0-9a-f]{12}$/);
});

test('--synthetic: um envelope sintético embutido, sem ler Runs (teste de fumaça P-3)', async () => {
    const client = fakeClient(() => 'C1');
    const out = fs.mkdtempSync(path.join(tmpBase, 'jev-cal-syn-'));
    dirs.push(out);
    const r = await cal.calibrate({ synthetic: true, outDir: out, n: 2, maxCalls: 1, effective: EFF, credentialProvider: cred, client });
    assert.strictEqual(client.calls.length, 1);
    assert.deepStrictEqual(client.calls[0].envelope, cal.SYNTHETIC_ENVELOPE);
    assert.deepStrictEqual([r.report.envelopes.length, r.report.envelopes[0].answered, r.report.summary.verdict], [1, 1, 'UNKNOWN']);
});

test('CLI: sem --max-calls sai com código 2 e a mensagem de uso, sem chamar nada', () => {
    const cli = path.join(__dirname, '..', 'jev-calibrate.js');
    let code = 0;
    let stderr = '';
    try {
        execFileSync(process.execPath, [cli, '--runs', os.tmpdir()], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
        code = e.status;
        stderr = String(e.stderr);
    }
    assert.strictEqual(code, 2);
    assert.match(stderr, /--max-calls/);
});

test('CLI --synthetic sem Authority Ref: sai com 3 e não envia (a seção da plataforma não dispensa a autoridade)', () => {
    const repo = fs.mkdtempSync(path.join(tmpBase, 'jev-cal-cli-'));
    dirs.push(repo);
    const cli = path.join(__dirname, '..', 'jev-calibrate.js');
    let code = 0;
    let stderr = '';
    try {
        execFileSync(process.execPath, [cli, '--synthetic', '--out', path.join(repo, 'out'), '--max-calls', '1'], {
            encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, REPO_PATH: repo },
        });
    } catch (e) {
        code = e.status;
        stderr = String(e.stderr);
    }
    assert.strictEqual(code, 3);
    assert.match(stderr, /Nada foi enviado/);
});

test('achado MINOR 4: duas execuções no mesmo --out ao mesmo tempo → a segunda recusa (BUSY), sem chamar', async () => {
    const runs = runsWith([envelope(1)]);
    const out = path.join(runs, '_jev-u15');
    fs.mkdirSync(out, { recursive: true });
    fs.writeFileSync(path.join(out, '.calibration.lock'), String(process.pid));
    const client = fakeClient(() => 'C3');
    const r = await go(runs, { maxCalls: 5, client });
    assert.deepStrictEqual([r.status, r.reason], ['BUSY', 'CALIBRATION_IN_PROGRESS']);
    assert.strictEqual(client.calls.length, 0);
});
