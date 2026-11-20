// node --test dashboard/qa-retry-nao-interferencia.test.js
// PRI-181 c0b, AC-07 (não-interferência, QRD-AC-10/20 em regressão): nos dois modos de
// WATCHER_QA_DIAGNOSTICO, o retry pelo dashboard (POST /retry-qa-rejection e
// consumeQaRetrySignals) e os portões funcionam como hoje, e status, node e
// pending_authorization não mudam.
//
// A flag é lida no require do watcher, então cada modo roda o cenário num processo novo:
// este arquivo se executa de novo com QA_RETRY_AC07_SCENARIO=1 (sem node:test) e imprime
// uma linha JSON na stdout. O teste compara os dois modos entre si e contra o
// comportamento esperado. Uma guarda estática acusa se o dashboard ou o caminho de retry
// do watcher passarem a ler a flag.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

if (process.env.QA_RETRY_AC07_SCENARIO === '1') runScenario();
else defineTests();

// ---------------------------------------------------------------------------------------
// Cenário (processo filho). REPO_PATH sintético e Redmine falso em loopback, o mesmo para
// o dashboard e o watcher. Passos, cada um num run e ticket próprios:
//   gate_recusa_qa   syncQaRejection + dispatchTicket (ordem do tick) com o ticket em Recusa
//                    QA e run anterior arquivado: grava a recusa (a parte sob a flag) e
//                    espera o botão.
//   retry_dashboard  POST /api/runs/:taskId/retry-qa-rejection (botão "Corrigir recusa QA").
//   retry_consumo    consumeQaRetrySignals() consome o retry-signal.json deixado acima.
//   gate_autorizacao syncQaRejection + dispatchTicket com run em authorization-pending:
//                    não despacha.
function runScenario() {
    const http = require('http');
    const PRISMA_ROOT = path.resolve(__dirname, '..');
    const tmpBase = process.env.CLAUDE_JOB_DIR ? path.join(process.env.CLAUDE_JOB_DIR, 'tmp') : os.tmpdir();
    const tmp = fs.mkdtempSync(path.join(tmpBase, 'qa-retry-ac07-'));
    const repo = path.join(tmp, 'app-back');
    fs.mkdirSync(path.join(repo, '.claude'), { recursive: true });
    fs.copyFileSync(path.join(PRISMA_ROOT, '.claude/spec-hash-config.json'), path.join(repo, '.claude/spec-hash-config.json'));
    const worktrees = path.join(repo, '.claude', 'worktrees');
    // notifyBlocked chama osascript (notificação real do macOS) e nenhum passo deve
    // despachar o claude: os dois ficam falsos no PATH, como nos testes vizinhos.
    const bin = path.join(tmp, 'bin');
    fs.mkdirSync(bin);
    for (const name of ['osascript', 'claude']) {
        fs.writeFileSync(path.join(bin, name), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    }
    process.env.PATH = `${bin}${path.delimiter}${process.env.PATH || ''}`;

    const STATUS = { 2: 'Em Desenvolvimento', 13: 'Recusa QA' };
    const issues = new Map();
    const redmine = http.createServer((req, res) => {
        let body = '';
        req.on('data', c => { body += c; });
        req.on('end', () => {
            const m = req.url.match(/^\/issues\/(\d+)\.json(\?include=journals)?/);
            const id = m && Number(m[1]);
            const issue = m && issues.get(id);
            if (!issue) { res.writeHead(404); return res.end('{}'); }
            if (req.method === 'PUT') {
                const sid = (() => { try { return JSON.parse(body).issue?.status_id; } catch { return undefined; } })();
                if (sid) issue.status = sid;
                res.writeHead(204); return res.end();
            }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ issue: {
                id, subject: `Ticket ${id}`, description: '', tracker: { name: 'Melhoria' },
                status: { id: issue.status, name: STATUS[issue.status] },
                custom_fields: [{ name: 'Branch Liberação', value: 'Dev - Local' }],
                updated_on: new Date().toISOString(),
                ...(m[2] ? { journals: issue.journals || [] } : {}),
            } }));
        });
    });

    const JOURNALS = [
        { id: 70, created_on: '2026-09-24T09:00:00Z', notes: '', details: [{ property: 'attr', name: 'status_id', old_value: '9', new_value: '13' }] },
        { id: 71, created_on: '2026-09-24T09:05:00Z', notes: 'Botão salvar não grava UF', details: [] },
    ];
    const UPDATED = '2026-09-20T10:00:00.000Z';
    const HISTORY = ['fetch_ticket', 'plan', 'implement', 'review', 'test', 'verify', 'commit'];
    const PENDING_AUTH = {
        id: 'AUTH-701', kind: 'db_migration', summary: 'aplicar migration sintética',
        artifact: 'db/migration/V1__ac07.sql', artifact_sha256: 'a'.repeat(64), verify_sql: 'select 1',
        expected: '1 linha', then: 'handback_qa', requested_by: 'agent', requested_at: UPDATED, phase: 'pending',
    };

    function writeRun(dir, taskId, id, extra) {
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({
            task_id: taskId, node: 'commit', history: HISTORY, status: 'committed',
            started_at: UPDATED, updated_at: UPDATED, redmine_ticket: { id }, ...extra,
        }, null, 2));
        fs.writeFileSync(path.join(dir, 'context.md'), '# Contexto\n\nciclo anterior\n');
        return dir;
    }
    const archivedRun = (id, extra = {}) => writeRun(path.join(repo, 'memory', 'runs', '_archive', `${id}-entrega`), `${id}-entrega`, id, extra);
    const worktreeRun = (id, extra = {}) => writeRun(path.join(worktrees, String(id), 'memory', 'runs', `${id}-entrega`), `${id}-entrega`, id, extra);
    const readState = dir => JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'));
    const project = dir => {
        const s = readState(dir);
        return { status: s.status, node: s.node, pending_authorization: s.pending_authorization ?? null };
    };
    const ticketOf = async id => (await (await fetch(`${process.env.REDMINE_URL}/issues/${id}.json`)).json()).issue;
    // Mesma ordem do laço do tick(): syncQaRejection (a parte sob a flag) e depois o despacho.
    async function tickTicket(watcher, id) {
        const ticket = await ticketOf(id);
        await watcher.syncQaRejection(ticket);
        return watcher.dispatchTicket(ticket);
    }

    async function main() {
        await new Promise(r => redmine.listen(0, '127.0.0.1', r));
        process.env.REPO_PATH = repo;
        process.env.REDMINE_URL = `http://127.0.0.1:${redmine.address().port}`;
        process.env.REDMINE_API_KEY = 'chave-ac07-teste';
        process.env.REDMINE_MIN_INTERVAL_MS = '0';
        process.env.REDMINE_RETRY_BASE_DELAY_MS = '0';
        delete process.env.WATCHER_RECUSA_QA_NOVO_CICLO;

        // Logs dos dois lados vão pra stderr: a stdout fica só com a linha JSON do resultado.
        for (const k of ['log', 'info', 'warn']) console[k] = (...a) => process.stderr.write(`${a.join(' ')}\n`);

        const watcher = require('../scripts/readmine-watcher');
        const { createDashboard } = require('./server');
        const steps = {};

        // 1. Portão da Recusa QA (run anterior arquivado, ticket em Recusa QA).
        issues.set(93001, { status: 13, journals: JOURNALS });
        const gateDir = archivedRun(93001);
        const gateOut = await tickTicket(watcher, 93001);
        steps.gate_recusa_qa = { action: gateOut.action, reason: gateOut.reason, ...project(gateDir) };
        // Prova de que o modo pegou: só o caminho C1–C3 grava a identidade da recusa.
        const c1Marker = typeof readState(gateDir).qa_rejection?.rejection_key === 'string';

        // 2. Retry pelo dashboard sobre o state que o tick acabou de gravar: com a flag
        // ligada, os campos C1 da recusa estão no próprio run que o humano retenta.
        issues.set(93002, { status: 13, journals: JOURNALS });
        const retryDir = worktreeRun(93002);
        const retryTick = await tickTicket(watcher, 93002);
        steps.retry_tick_antes = { action: retryTick.action, reason: retryTick.reason, ...project(retryDir) };
        const retryC1Marker = typeof readState(retryDir).qa_rejection?.rejection_key === 'string';
        const dash = createDashboard({ memoryDir: path.join(repo, 'memory', 'runs'), worktreesDir: worktrees, prefsFile: path.join(tmp, 'prefs.json') });
        await new Promise(r => dash.server.listen(0, '127.0.0.1', r));
        await dash.ready;
        try {
            const res = await fetch(`http://localhost:${dash.server.address().port}/api/runs/93002-entrega/retry-qa-rejection`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
            });
            const body = await res.json();
            steps.retry_dashboard = {
                http: res.status, error: body.error ?? null, ticket_status: issues.get(93002).status,
                signal: fs.existsSync(path.join(retryDir, 'retry-signal.json')), ...project(retryDir),
            };
        } finally {
            await dash.close();
        }

        // 2b. Tick com o retry pedido e ainda não consumido.
        const pendingTick = await tickTicket(watcher, 93002);
        steps.retry_tick_pendente = { action: pendingTick.action, reason: pendingTick.reason, ...project(retryDir) };

        // 3. Consumo do sinal pelo watcher.
        const ids = await watcher.consumeQaRetrySignals();
        steps.retry_consumo = { ids, signal: fs.existsSync(path.join(retryDir, 'retry-signal.json')), ...project(retryDir) };

        // 4. Portão de autorização.
        issues.set(93003, { status: 2 });
        const authDir = worktreeRun(93003, { node: 'implement', status: 'authorization-pending', pending_authorization: PENDING_AUTH });
        const authOut = await tickTicket(watcher, 93003);
        steps.gate_autorizacao = { action: authOut.action, reason: authOut.reason, ...project(authDir) };

        process.stdout.write(`${JSON.stringify({ flag: watcher.QA_DIAGNOSTICO, c1Marker, retryC1Marker, pendingAuthSeed: PENDING_AUTH, steps })}\n`);
    }

    main()
        .catch(e => { process.stderr.write(`${e.stack || e}\n`); process.exitCode = 1; })
        .finally(() => { redmine.close(); fs.rmSync(tmp, { recursive: true, force: true }); });
}

// ---------------------------------------------------------------------------------------
// Testes (processo do node --test).
function defineTests() {
    const test = require('node:test');
    const assert = require('node:assert');
    const { spawnSync } = require('child_process');
    const WATCHER = path.join(__dirname, '..', 'scripts', 'readmine-watcher.js');

    function scenario(flag) {
        const env = { ...process.env, QA_RETRY_AC07_SCENARIO: '1' };
        delete env.WATCHER_QA_DIAGNOSTICO;
        delete env.WATCHER_RECUSA_QA_NOVO_CICLO;
        if (flag !== undefined) env.WATCHER_QA_DIAGNOSTICO = flag;
        const out = spawnSync(process.execPath, [__filename], { env, encoding: 'utf8', timeout: 60000 });
        assert.strictEqual(out.status, 0, `cenário (flag=${flag ?? 'ausente'}) saiu com ${out.status}:\n${out.stderr}`);
        return JSON.parse(out.stdout.trim().split('\n').pop());
    }

    // Comportamento de hoje (C0, igual ao de antes da c0b) que os dois modos têm de reproduzir.
    const EXPECTED = {
        gate_recusa_qa: { action: 'skip', reason: 'recusa_qa_aguardando_retry', status: 'committed', node: 'commit', pending_authorization: null },
        // O run do retry fica direto no worktree (o ramo _archive → worktree exige git e
        // não é coberto aqui), por isso o portão é committed_nao_arquivada; o que importa é
        // o syncQaRejection ter gravado neste run antes do botão.
        retry_tick_antes: { action: 'skip', reason: 'committed_nao_arquivada', status: 'committed', node: 'commit', pending_authorization: null },
        retry_dashboard: { http: 200, error: null, ticket_status: 2, signal: true, status: 'in_progress', node: 'implement', pending_authorization: null },
        retry_tick_pendente: { action: 'skip', reason: 'qa_retry_pendente', status: 'in_progress', node: 'implement', pending_authorization: null },
        retry_consumo: { ids: [93002], signal: false, status: 'in_progress', node: 'implement', pending_authorization: null },
        gate_autorizacao: { action: 'skip', reason: 'status_authorization_pending', status: 'authorization-pending', node: 'implement' },
    };

    let off;
    let on;
    test.before(() => {
        off = scenario(undefined);
        on = scenario('1');
    });

    test('AC-07: os dois modos realmente diferem na parte sob a flag', () => {
        assert.strictEqual(off.flag, false);
        assert.strictEqual(on.flag, true);
        assert.strictEqual(off.c1Marker, false, 'C0 não grava rejection_key');
        assert.strictEqual(on.c1Marker, true, 'C1–C3 grava rejection_key');
        assert.strictEqual(off.retryC1Marker, false, 'run do retry sem campos C1 no modo C0');
        assert.strictEqual(on.retryC1Marker, true, 'run do retry chega ao botão com os campos C1');
    });

    test('AC-07: retry, portões, status, node e pending_authorization iguais nos dois modos', () => {
        assert.deepStrictEqual(on.steps, off.steps);
    });

    for (const [mode, label] of [['off', 'flag ausente'], ['on', 'flag=1']]) {
        test(`AC-07 (${label}): comportamento de hoje em cada passo`, () => {
            const run = mode === 'off' ? off : on;
            assert.deepStrictEqual(Object.keys(run.steps).sort(), Object.keys(EXPECTED).sort());
            for (const [step, expected] of Object.entries(EXPECTED)) {
                // No portão de autorização, o pedido tem de sair idêntico ao semeado.
                const want = step === 'gate_autorizacao' ? { ...expected, pending_authorization: run.pendingAuthSeed } : expected;
                assert.deepStrictEqual(run.steps[step], want, step);
            }
        });
    }

    // Alarme precoce e raso (só os .js do topo de dashboard/ e as duas funções de consumo):
    // a prova é a comparação comportamental acima, que pega leitura da flag em qualquer
    // ponto do caminho executado.
    test('AC-07 (guarda estática): dashboard e caminho de retry não leem a flag', () => {
        const offenders = fs.readdirSync(__dirname)
            .filter(f => f.endsWith('.js') && !f.endsWith('.test.js'))
            .filter(f => /QA_DIAGNOSTICO/.test(fs.readFileSync(path.join(__dirname, f), 'utf8')));
        assert.deepStrictEqual(offenders, [], 'dashboard passou a ler WATCHER_QA_DIAGNOSTICO');

        const src = fs.readFileSync(WATCHER, 'utf8');
        for (const fn of ['consumeQaRetrySignals', 'consumeQaRetrySignal']) {
            const start = src.indexOf(`async function ${fn}(`);
            assert.ok(start >= 0, `${fn} não encontrada em readmine-watcher.js`);
            const next = src.slice(start + 1).search(/\n(?:async )?function /);
            const body = next < 0 ? src.slice(start) : src.slice(start, start + 1 + next);
            assert.doesNotMatch(body, /QA_DIAGNOSTICO/, `${fn} passou a depender da flag`);
        }
    });
}
