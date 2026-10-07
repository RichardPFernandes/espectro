'use strict';
// PRI-62: ensaio de retorno do consumo. O watcher da candidata (PRISMA_ROOT separado,
// REPO_PATH = consumidor) é trocado de volta pelo watcher da fonte anterior (bytes
// selecionados do app-back recuperados), sobre o MESMO consumidor descartável.
// Só DRY_RUN=true, diretórios temporários e fixtures sintéticas: nenhum Redmine, agente,
// Maven, Bitbucket, .env real ou execução ativa é tocado.
//
// Entradas (todas obrigatórias; ausência é FAIL, nunca skip):
//   PRI62_PREFLIGHT              candidate-source-preflight.json (230 fontes + 248 candidatas)
//   PRI62_SOURCE_SNAPSHOT        snapshot dos 230 selecionados da fonte atual, restaurado aqui em tmp
//   PRI62_SCRIPTS_NODE_MODULES   node_modules de scripts/ (lock idêntico nos dois lados)
//   PRI62_LIVE_CONSUMER_ROOT     checkout ativo do consumidor, lido só para hash
//   PRI62_CONFIG_EXAMPLES        opcional: exemplos não contratuais (separados por ':'), só listados
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const cp = require('node:child_process');

const CANDIDATE_REVISION = 'fbb597cb2ffe6053351a5d6ed2bff6e444bf3b6c';
const CANDIDATE_TREE = '4633d9fd5f5bdf30c6be9f990d84cb847a9cb3cc';
const SOURCE_SNAPSHOT_SHA256 = 'ee42191da8945055f37aca773ec8e585e0d0ae8eb3c23c9a105ff829c2159a03';
const FULL_HISTORY = ['fetch_ticket', 'plan', 'implement', 'review', 'test', 'verify', 'commit'];
// Config de consumo admitida (decisão do Richard na PRI-61/PRI-62), relativa à raiz do consumidor.
const ADMITTED_CONFIG = {
    'prisma-consumer.env': '767066520961af1bf36476ba52e217826d884220b4f82b61e95a575f0f69fa29',
    'config/consolidator-module-keywords.json': '423d01e6f829466671b32dfc6d43a4df6787b51cde4fed6782954f196e90876c',
};
const SECRET_KEY = /(TOKEN|API_KEY|SECRET|PASSWORD|WEBHOOK_URL)$/;

const env = process.env;
const missing = ['PRI62_PREFLIGHT', 'PRI62_SOURCE_SNAPSHOT', 'PRI62_SCRIPTS_NODE_MODULES', 'PRI62_LIVE_CONSUMER_ROOT'].filter(k => !env[k]);
if (missing.length) {
    test('pré-requisitos do ensaio PRI-62', () => assert.fail(`variáveis ausentes: ${missing.join(', ')}`));
    return;
}

const preflight = JSON.parse(fs.readFileSync(env.PRI62_PREFLIGHT, 'utf8'));
const sourceSnapshot = fs.realpathSync(env.PRI62_SOURCE_SNAPSHOT);
const nodeModules = fs.realpathSync(env.PRI62_SCRIPTS_NODE_MODULES);
const liveConsumer = fs.realpathSync(env.PRI62_LIVE_CONSUMER_ROOT);
const configExamples = (env.PRI62_CONFIG_EXAMPLES || '').split(path.delimiter).filter(Boolean);
const repoRoot = cp.execFileSync('git', ['-C', __dirname, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
const work = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pri62-consumption-')));
const candidateRoot = path.join(work, 'candidate');
const sourceRoot = path.join(work, 'previous-source');
const logs = [];

const sha = buf => crypto.createHash('sha256').update(buf).digest('hex');
const hashFile = p => sha(fs.readFileSync(p));
const git = (dir, ...args) => cp.execFileSync('git', ['-C', dir, ...args], {
    encoding: 'utf8', env: { PATH: env.PATH, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
}).trim();

function hashTree(root, skip = new Set()) {
    const out = {};
    (function walk(dir) {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
            const abs = path.join(dir, e.name);
            const rel = path.relative(root, abs);
            if (skip.has(rel)) continue;
            if (e.isDirectory()) walk(abs);
            else if (e.isFile()) out[rel] = hashFile(abs);
            else out[rel] = `link:${fs.readlinkSync(abs)}`;
        }
    })(root);
    return out;
}

function checkEntries(root, entries) {
    for (const x of entries) {
        const p = path.join(root, x.path);
        assert.equal(hashFile(p), x.sha256, `hash divergente: ${x.path}`);
        const st = fs.statSync(p);
        assert.equal(st.size, x.bytes, `tamanho divergente: ${x.path}`);
        // Só o bit de execução: o resto do modo depende do umask de quem extraiu.
        if (x.mode) assert.equal((st.mode & 0o100) !== 0, (parseInt(x.mode.slice(2), 8) & 0o100) !== 0, `modo divergente: ${x.path}`);
    }
}

function pidAlive(pid) {
    try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

function setupConsumer(name) {
    const dir = path.join(work, name);
    fs.cpSync(sourceRoot, dir, { recursive: true, verbatimSymlinks: true });
    fs.symlinkSync(nodeModules, path.join(dir, 'scripts', 'node_modules'));
    // .env sintético: a credencial "revogada" já foi retirada; os dois watchers leem este arquivo.
    fs.writeFileSync(path.join(dir, '.env'), '# PRI-62 fixture: credencial revogada removida\nNOTIFY_WEBHOOK_URL=\n');
    git(dir, 'init', '-q', '-b', 'main');
    fs.appendFileSync(path.join(dir, '.git', 'info', 'exclude'), 'memory/\nscripts/node_modules\n.env\n');
    git(dir, 'add', '-A');
    git(dir, '-c', 'user.name=PRI62 fixture', '-c', 'user.email=pri62@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'previous consumer');
    return { dir, envHash: hashFile(path.join(dir, '.env')) };
}

function writeFixture(c, ticket) {
    const file = path.join(work, `${path.basename(c.dir)}-fixture.json`);
    fs.writeFileSync(file, JSON.stringify(ticket));
    return file;
}

function syntheticTicket(id, { complete = true, journals = [] } = {}) {
    const description = complete
        ? '## Problema\nTicket sintético do ensaio PRI-62.\n\n## Solução\nRegistrar uma marca sintética.\n\n' +
          '## Critérios de Aceite\n- AC-01: Marca sintética registrada no fluxo simulado\n- AC-02: Marca sintética preservada depois do retorno\n\n' +
          '## Restrições\n- Nenhum efeito externo\n\n## Arquivos Afetados\n- Fixture.java\n\n## Dependências\n- Nenhuma\n'
        : 'Ticket sintético sem critérios de aceite.';
    return {
        id, subject: `PRI-62 synthetic ${id}`, description, journals,
        // updated_on fixo: o ticket não muda depois do ciclo, como no Redmine real.
        updated_on: '2026-01-01T00:00:00Z',
        status: { id: 2, name: 'Aprovada' }, tracker: { id: 2, name: 'Funcionalidade' },
        assigned_to: { id: 1, name: 'Fixture' }, project: { id: 1, identifier: 'fixture' },
        custom_fields: [{ id: 1, name: 'Branch Liberação', value: 'Dev - Local' }],
    };
}

// side: 'candidate' (PRISMA_ROOT separado + config do consumidor) ou 'source' (scripts do consumidor).
function runWatcher(side, c, fixture, { delay = 0, stopWhen = null, timeoutMs = 90000 } = {}) {
    const script = side === 'candidate'
        ? path.join(candidateRoot, 'scripts', 'readmine-watcher.js')
        : path.join(c.dir, 'scripts', 'readmine-watcher.js');
    const childEnv = {
        PATH: env.PATH, HOME: path.join(work, 'home'), TMPDIR: path.join(work, 'tmp'),
        REPO_PATH: c.dir, DRY_RUN: 'true', DRY_RUN_DELAY_FACTOR: String(delay), DRY_RUN_FIXTURE: fixture,
        ...(side === 'candidate' ? { WATCHER_MAIN_REPO_NAME: 'app-back' } : {}),
    };
    fs.mkdirSync(childEnv.HOME, { recursive: true });
    fs.mkdirSync(childEnv.TMPDIR, { recursive: true });
    return new Promise((resolve, reject) => {
        const child = cp.spawn(process.execPath, [script], { cwd: c.dir, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] });
        let out = '';
        let stopped = false;
        child.stdout.on('data', d => { out += d; });
        child.stderr.on('data', d => { out += d; });
        const poll = stopWhen && setInterval(() => {
            if (!stopped && stopWhen()) { stopped = true; child.kill('SIGTERM'); }
        }, 50);
        const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`${side} watcher timeout\n${out}`)); }, timeoutMs);
        child.on('exit', code => {
            clearTimeout(timer);
            if (poll) clearInterval(poll);
            logs.push({ side, consumer: path.basename(c.dir), out });
            resolve({ code, out, pid: child.pid, stopped });
        });
    });
}

const runDir = (c, task) => path.join(c.dir, 'memory', 'runs', task);
const archiveDir = (c, task) => path.join(c.dir, 'memory', 'runs', '_archive', task);
function readState(dir) {
    try { return JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8')); } catch { return null; }
}
function critical(s) {
    return {
        node: s.node, status: s.status, execution_id: s.execution_id, state_version: s.state_version,
        history: s.history, spec_hash: s.spec_hash, events: (s.events || []).length,
    };
}
const nodeStarts = (s, node) => (s.events || []).filter(e => e.type === 'node_start' && e.node === node).length;
const count = (text, re) => (text.match(re) || []).length;
const prLines = id => logs.reduce((n, l) => n + count(l.out, new RegExp(`PR que seria aberto[^\\n]*\\n[^\\n]*branch: ${id} `, 'g')), 0);
const sourceLogs = c => logs.filter(l => l.side === 'source' && l.consumer === path.basename(c.dir)).map(l => l.out).join('\n');

function assertCodeUntouched(c) {
    assert.equal(git(c.dir, 'status', '--porcelain'), '', 'código/config do consumidor não pode mudar');
    assert.equal(hashFile(path.join(c.dir, '.env')), c.envHash, '.env do consumidor não pode mudar');
    const envFiles = fs.readdirSync(c.dir).filter(f => f.startsWith('.env'));
    assert.deepEqual(envFiles, ['.env'], 'nenhum .env novo no consumidor');
}

let candidateTreeBefore;

test.before(() => {
    assert.equal(hashFile(sourceSnapshot), SOURCE_SNAPSHOT_SHA256, 'snapshot da fonte divergente');
    fs.mkdirSync(sourceRoot);
    cp.execFileSync('tar', ['-xzf', sourceSnapshot, '-C', sourceRoot]);
    fs.mkdirSync(candidateRoot);
    cp.execFileSync('sh', ['-c', 'git -C "$1" archive "$2" | tar -x -C "$3"', 'sh', repoRoot, CANDIDATE_REVISION, candidateRoot]);
    fs.symlinkSync(nodeModules, path.join(candidateRoot, 'scripts', 'node_modules'));
    candidateTreeBefore = hashTree(candidateRoot);
});

test.after(() => {
    const keep = env.PRI62_KEEP_WORK === '1';
    if (env.PRI62_LOG_DIR) {
        fs.mkdirSync(env.PRI62_LOG_DIR, { recursive: true });
        logs.forEach((l, i) => fs.writeFileSync(path.join(env.PRI62_LOG_DIR, `${String(i).padStart(2, '0')}-${l.consumer}-${l.side}.log`), l.out));
    }
    if (!keep) fs.rmSync(work, { recursive: true, force: true });
});

test('C0 identidades: fonte 230, candidata 248 e execução ativa igual à fonte recuperada', () => {
    assert.equal(preflight.candidate_revision, CANDIDATE_REVISION);
    assert.equal(git(repoRoot, 'rev-parse', `${CANDIDATE_REVISION}^{tree}`), CANDIDATE_TREE);
    assert.equal(preflight.source_entries.length, 230);
    assert.equal(preflight.candidate_entries.length, 248);
    checkEntries(sourceRoot, preflight.source_entries);
    checkEntries(candidateRoot, preflight.candidate_entries);
    assert.equal(Object.keys(hashTree(candidateRoot, new Set(['scripts/node_modules']))).length, 248);
    for (const f of ['scripts/package.json', 'scripts/package-lock.json']) {
        assert.equal(hashFile(path.join(sourceRoot, f)), hashFile(path.join(candidateRoot, f)), `${f} difere: node_modules não pode ser compartilhado`);
    }
    // Leitura do checkout ativo, sem escrita: o alvo do retorno é o que está rodando hoje.
    checkEntries(liveConsumer, preflight.source_entries);
});

test('C1 config admitida do consumidor: identidade por hash, só chaves sem segredo, fora do PRISMA_ROOT', t => {
    for (const [file, expected] of Object.entries(ADMITTED_CONFIG)) {
        const abs = fs.realpathSync(path.join(liveConsumer, file));
        assert.ok(!abs.startsWith(repoRoot + path.sep), `${file} não pode estar no repo Prisma`);
        assert.equal(hashFile(abs), expected, `${file} difere da config admitida`);
        const text = fs.readFileSync(abs, 'utf8');
        if (abs.endsWith('.json')) JSON.parse(text);
        else {
            const keys = text.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#')).map(l => l.split('=')[0]);
            assert.ok(keys.length > 0, `${file} sem chaves`);
            assert.deepEqual(keys.filter(k => SECRET_KEY.test(k)), [], `${file} declara chave de segredo`);
        }
        t.diagnostic(`admitida ${file} sha256=${expected}`);
    }
    // Exemplos não contratuais: só listados, fora da identidade e do PASS.
    for (const file of configExamples) {
        const abs = path.resolve(liveConsumer, file);
        t.diagnostic(`exemplo (não contratual) ${path.relative(liveConsumer, abs)} ${fs.existsSync(abs) ? `sha256=${hashFile(abs)}` : 'ausente'}`);
    }
});

test('C2 ciclo em voo na candidata: interrompido, retomado pela fonte só com decisão humana, sem refazer nó concluído nem duplicar PR', async () => {
    const c = setupConsumer('c2');
    const fixture = writeFixture(c, syntheticTicket(99999));
    const task = '99999-dry-run';

    const cand = await runWatcher('candidate', c, fixture, {
        delay: 1, stopWhen: () => { const s = readState(runDir(c, task)); return s?.node === 'implement' && s.status === 'running'; },
    });
    assert.equal(cand.stopped, true, 'candidata precisava estar em voo no implement');
    assert.equal(cand.code, 0);
    assert.match(cand.out, /Graceful shutdown concluído/);
    assert.equal(pidAlive(cand.pid), false, 'writer anterior ainda vivo');
    const interrupted = readState(runDir(c, task));
    assert.equal(interrupted.status, 'interrupted');
    assert.deepEqual(interrupted.history, ['fetch_ticket', 'plan']);
    assert.equal(prLines(99999), 0);

    // Retorno: watcher da fonte, sem PRISMA_ROOT nem config do consumidor da candidata.
    for (let i = 0; i < 2; i++) {
        const back = await runWatcher('source', c, fixture);
        assert.equal(back.code, 0);
        assert.match(back.out, /"reason":"status_interrupted"/);
        assert.doesNotMatch(back.out, /Simulando nó/);
        assert.deepEqual(critical(readState(runDir(c, task))), critical(interrupted), 'retorno sem decisão não pode mudar campo crítico');
    }
    assert.equal(count(sourceLogs(c), /PUT #99999/g), 0, 'retorno não reposta nota já feita');

    // Decisão humana registrada pelo CLI da fonte (o "retome manualmente" do contrato AS-IS).
    cp.execFileSync(process.execPath, [path.join(c.dir, 'scripts', 'state-writer.js'), 'set', runDir(c, task), '--set', 'status="in_progress"'], { cwd: c.dir, env: { PATH: env.PATH } });
    const resumed = await runWatcher('source', c, fixture);
    assert.equal(resumed.code, 0);
    const done = readState(archiveDir(c, task));
    assert.equal(done.status, 'committed');
    assert.deepEqual(done.history, FULL_HISTORY);
    assert.equal(done.execution_id, interrupted.execution_id, 'execução não pode ser reatribuída no retorno');
    assert.equal(nodeStarts(done, 'fetch_ticket'), 1);
    assert.equal(nodeStarts(done, 'plan'), 1);
    assert.equal(nodeStarts(done, 'commit'), 1);
    assert.equal(prLines(99999), 1);

    const after = await runWatcher('source', c, fixture);
    assert.doesNotMatch(after.out, /Simulando nó/);
    assert.equal(prLines(99999), 1, 'tick posterior não pode reabrir PR');
    assertCodeUntouched(c);
});

test('C3 gate humano pendente aberto pela candidata segue pendente na fonte e só avança com decisão', async () => {
    const c = setupConsumer('c3');
    const fixture = writeFixture(c, syntheticTicket(99998, { complete: false }));
    const cand = await runWatcher('candidate', c, fixture);
    assert.match(cand.out, /"status":"spec-pending-approval"/);
    assert.ok(count(cand.out, /PUT #99998 NÃO enviado/g) >= 1);
    const gateFile = path.join(c.dir, 'memory', 'runs', '99998-spec-gate.json');
    // checked_at é só o carimbo da última leitura do gate.
    const readGate = () => { const { checked_at, ...g } = JSON.parse(fs.readFileSync(gateFile, 'utf8')); return g; };
    const gate = readGate();
    assert.equal(gate.status, 'spec-pending-approval');

    for (let i = 0; i < 2; i++) {
        const back = await runWatcher('source', c, fixture);
        assert.equal(back.code, 0);
        assert.doesNotMatch(back.out, /Simulando nó/);
        assert.deepEqual(readGate(), gate, 'gate pendente não pode mudar sem decisão');
    }
    assert.equal(count(sourceLogs(c), /PUT #99998/g), 0, 'retorno não reposta pergunta do gate');
    assert.equal(fs.existsSync(runDir(c, '99998-dry-run')), false, 'nenhum ciclo sem decisão');

    // No Redmine real a pergunta postada pela candidata continua no journal; o fake do
    // dry-run só a guarda no processo, então o fixture a reproduz com o id gravado no gate.
    const question = /PUT #99998 NÃO enviado — nota que seria postada: "([^"]+)"/.exec(cand.out.split('\n').filter(l => l.includes('Spec incompleta')).join('\n'))[1];
    const asked = gate.spec_pending_approval;
    const decided = writeFixture(c, syntheticTicket(99998, {
        complete: false,
        journals: [
            { id: asked.comment_id, notes: question, created_on: asked.posted_at, user: { id: 0, name: 'watcher' } },
            { id: asked.comment_id + 1, notes: 'aprovado', created_on: new Date().toISOString(), user: { id: 7, name: 'Fixture Human' } },
        ],
    }));
    const approved = await runWatcher('source', c, decided);
    assert.match(approved.out, /aprovado por Fixture Human/);
    assert.equal(count(approved.out, /PUT #99998 NÃO enviado — nota que seria postada: "🤖 Spec incompleta/g), 0, 'pergunta do gate não é repetida');
    assertCodeUntouched(c);
});

test('C4 agente destacado da candidata vivo: fonte não redespacha nem recupera; morto, recupera o mesmo nó', async () => {
    const c = setupConsumer('c4');
    const fixture = writeFixture(c, syntheticTicket(99997));
    const task = '99997-dry-run';
    await runWatcher('candidate', c, fixture, {
        delay: 1, stopWhen: () => { const s = readState(runDir(c, task)); return s?.node === 'implement' && s.status === 'running'; },
    });
    // node-lease.agentAlive só aceita pid cujo comando contém "claude", como o wrapper sh real.
    const agent = cp.spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)', 'pri62-claude-agent-fixture'], { stdio: 'ignore' });
    const patch = path.join(work, 'c4-agent-patch.json');
    fs.writeFileSync(patch, JSON.stringify({ status: 'running', agent_pid: agent.pid }));
    // Lease do agente destacado gravado pelo CLI da candidata (o wrapper usa o node-lease dela).
    cp.execFileSync(process.execPath, [path.join(candidateRoot, 'scripts', 'state-writer.js'), 'set', runDir(c, task), `--input=${patch}`], { cwd: c.dir, env: { PATH: env.PATH } });
    const leased = readState(runDir(c, task));
    try {
        const back = await runWatcher('source', c, fixture);
        assert.equal(back.code, 0);
        assert.doesNotMatch(back.out, /Simulando nó/, 'fonte não pode despachar com agente da candidata vivo');
        const s = readState(runDir(c, task));
        assert.deepEqual(critical(s), critical(leased));
        assert.equal(s.agent_pid, agent.pid);
    } finally {
        agent.kill('SIGKILL');
    }
    await new Promise(r => agent.once('exit', r));
    assert.equal(pidAlive(agent.pid), false);

    const recovered = await runWatcher('source', c, fixture);
    assert.equal(recovered.code, 0);
    assert.match(recovered.out, /\[recovery\] Task 99997-dry-run: nó implement órfão/);
    const done = readState(archiveDir(c, task)) || readState(runDir(c, task));
    assert.equal(done.execution_id, leased.execution_id);
    assert.equal(nodeStarts(done, 'fetch_ticket'), 1);
    assert.equal(nodeStarts(done, 'plan'), 1);
    assert.ok(nodeStarts(done, 'commit') <= 1);
    assert.ok(prLines(99997) <= 1);
    assertCodeUntouched(c);
});

test('C5 candidata intacta: nenhuma escrita no PRISMA_ROOT durante os ensaios', () => {
    assert.deepEqual(hashTree(candidateRoot), candidateTreeBefore);
});
