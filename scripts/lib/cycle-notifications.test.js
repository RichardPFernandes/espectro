// node --test lib/cycle-notifications.test.js
// Quando o watcher notifica: PR aberto / Draft HIGH-RISK (varredura) e escalação.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const cn = require('./cycle-notifications');

const tmpBase = process.env.CLAUDE_JOB_DIR ? path.join(process.env.CLAUDE_JOB_DIR, 'tmp') : os.tmpdir();
function runsDir() { return fs.mkdtempSync(path.join(tmpBase, 'cycle-notif-')); }
function task(base, taskId, state, { archived = false } = {}) {
    const dir = path.join(base, archived ? '_archive' : '', taskId);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ task_id: taskId, ...state }));
    return dir;
}
function recorder(result = { sent: true, status: 200 }) {
    const calls = [];
    const send = async p => { calls.push(p); return typeof result === 'function' ? result() : result; };
    return { calls, send };
}
const PR = { 'app-back': { url: 'https://bitbucket.org/ws/app-back/pull-requests/12' } };
const text = p => p.attachments[0].text;

test('PR aberto low-risk: notifica uma vez, com título do ticket e URL', async () => {
    const base = runsDir();
    const dir = task(base, '43670-x', { status: 'committed', pull_request: PR, redmine_ticket: { subject: 'Ajuste <tela>' } }, { archived: true });
    const { calls, send } = recorder();
    const r1 = await cn.sweepOpenedPrs({ runsDirs: [base], send, enabled: true });
    assert.strictEqual(r1.length, 1);
    const a = calls[0].attachments[0];
    assert.strictEqual(a.title, '✅ Task #43670-x — PR aberto');
    assert.strictEqual(a.color, 'good');
    assert.strictEqual(a.title_link, PR['app-back'].url);
    assert.match(a.text, /\*Ajuste &lt;tela&gt;\*/);
    assert.match(a.text, /PR: https:\/\/bitbucket\.org/);
    assert.ok(fs.existsSync(path.join(dir, cn.PR_MARKER)));
    assert.deepStrictEqual(await cn.sweepOpenedPrs({ runsDirs: [base], send, enabled: true }), []);
    assert.strictEqual(calls.length, 1);
});

test('HIGH-RISK vira Draft/warning com o risk_reason', async () => {
    const base = runsDir();
    task(base, '1-hr', { status: 'committed', pull_request: PR, risk_level: 'high', risk_reason: 'toca migration' });
    const { calls, send } = recorder();
    await cn.sweepOpenedPrs({ runsDirs: [base], send, enabled: true });
    const a = calls[0].attachments[0];
    assert.strictEqual(a.title, '⚠️ Task #1-hr — PR HIGH-RISK (Draft)');
    assert.strictEqual(a.color, 'warning');
    assert.match(a.text, /Motivo: toca migration/);
});

test('ignora: sem webhook, sem URL de PR, não committed, e state.json antigo', async () => {
    const base = runsDir();
    task(base, '2-nopr', { status: 'committed', pull_request: {} });
    task(base, '3-run', { status: 'in_progress', pull_request: PR });
    const old = task(base, '4-old', { status: 'committed', pull_request: PR });
    const past = new Date(Date.now() - 2 * cn.PR_NOTIFY_MAX_AGE_MS);
    fs.utimesSync(path.join(old, 'state.json'), past, past);
    const { calls, send } = recorder();
    assert.deepStrictEqual(await cn.sweepOpenedPrs({ runsDirs: [base], send, enabled: false }), []);
    assert.deepStrictEqual(await cn.sweepOpenedPrs({ runsDirs: [base], send, enabled: true }), []);
    assert.strictEqual(calls.length, 0);
    assert.ok(!fs.existsSync(path.join(old, cn.PR_MARKER)));
});

test('mesma task em duas cópias (worktree + archive principal) notifica uma vez só', async () => {
    const wt = runsDir(), main = runsDir();
    const d1 = task(wt, '5-dup', { status: 'committed', pull_request: PR }, { archived: true });
    const d2 = task(main, '5-dup', { status: 'committed', pull_request: PR }, { archived: true });
    const { calls, send } = recorder();
    await cn.sweepOpenedPrs({ runsDirs: [wt, main], send, enabled: true });
    assert.strictEqual(calls.length, 1);
    assert.ok(fs.existsSync(path.join(d1, cn.PR_MARKER)) && fs.existsSync(path.join(d2, cn.PR_MARKER)));
});

test('falha no envio (ou send que lança) não lança, não toca o state.json e não reenvia', async () => {
    const base = runsDir();
    const dir = task(base, '6-fail', { status: 'committed', pull_request: PR });
    const before = fs.readFileSync(path.join(dir, 'state.json'), 'utf8');
    const send = async () => { throw new Error('boom'); };
    const r = await cn.sweepOpenedPrs({ runsDirs: [base], send, enabled: true });
    assert.strictEqual(r[0].result.sent, false);
    assert.strictEqual(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'), before);
    assert.deepStrictEqual(await cn.sweepOpenedPrs({ runsDirs: [base], send, enabled: true }), []);
});

test('escalação max_retries: motivo do evento escalation, dedup por nó+status', async () => {
    const base = runsDir();
    const state = {
        status: 'escalated', node: 'review', redmine_ticket: { subject: 'Tela X' },
        events: [{ type: 'escalation', node: 'review', detail: 'max_retries atingido em review (3/3) — escalando para humano' }],
    };
    const dir = task(base, '7-esc', state);
    const { calls, send } = recorder();
    const r = await cn.notifyEscalation({ dir, taskId: '7-esc', state, node: 'review', status: 'escalated', send, enabled: true });
    assert.strictEqual(r.sent, true);
    const a = calls[0].attachments[0];
    assert.strictEqual(a.title, '🚨 Task #7-esc — Escalada para humano');
    assert.strictEqual(a.color, 'danger');
    assert.match(a.text, /Motivo: max_retries atingido em review \(3\/3\)/);
    assert.strictEqual(await cn.notifyEscalation({ dir, taskId: '7-esc', state, node: 'review', status: 'escalated', send, enabled: true }), null);
    // travou de novo em outro nó → notifica de novo
    await cn.notifyEscalation({ dir, taskId: '7-esc', state, node: 'commit', status: 'needs_human_review', send, enabled: true });
    assert.strictEqual(calls.length, 2);
});

test('escalação: blocked e webhook desligado não notificam; sem evento usa status/nó/tentativas', async () => {
    const base = runsDir();
    const state = { status: 'escalated', node: 'test', retries: { test: 3 } };
    const dir = task(base, '8-esc', state);
    const { calls, send } = recorder();
    assert.strictEqual(await cn.notifyEscalation({ dir, taskId: '8-esc', state, node: 'test', status: 'blocked', send, enabled: true }), null);
    assert.strictEqual(await cn.notifyEscalation({ dir, taskId: '8-esc', state, node: 'test', status: 'escalated', send, enabled: false }), null);
    assert.strictEqual(calls.length, 0);
    assert.strictEqual(cn.escalationReason(state, 'test', 'escalated'), 'status "escalated" no nó "test" após 3 tentativa(s)');
});

test('payload nunca carrega context.md/handoff.md', async () => {
    const base = runsDir();
    const dir = task(base, '9-sec', { status: 'committed', pull_request: PR });
    fs.writeFileSync(path.join(dir, 'context.md'), 'SEGREDO-DE-NEGOCIO');
    fs.writeFileSync(path.join(dir, 'handoff.md'), 'SEGREDO-DE-NEGOCIO');
    const { calls, send } = recorder();
    await cn.sweepOpenedPrs({ runsDirs: [base], send, enabled: true });
    assert.ok(!JSON.stringify(calls).includes('SEGREDO'));
});
