#!/usr/bin/env node
// Tarefa 0 da PRI-311 (PRI-287 S5.2a): prova do mecanismo U10 — fixar o modelo do subagente
// por papel no despacho, sem depender do frontmatter que o LLM aciona. Adendo
// tasks/pri-287-s5/SPEC-s5.2.md v2.1, seção "Tarefa 0".
//
// STATUS: verificação pontual. Sem estado de Run, sem Attempt, sem RoutingDecision, fora do
// watcher e do DOM-06, e FORA do harness (loopback-only): faz chamadas reais ao provider.
// Não é canal de despacho. Só roda com o «sim» do Richard (Q10 a, 2026-11-09).
//
// Regras do protocolo (A-03, R2-A-02):
// - perfil próprio (--config-dir), fora do repositório, nunca ~/.claude nem ~/.claude-personal;
//   o login nesse perfil é feito pelo Richard; este script nunca lê, copia nem registra
//   credencial (só lê projects/ para os transcripts da própria sessão);
// - plugin jev-model-router desligado PROVADO (routedPluginProof) antes de qualquer chamada;
// - sem MCP (--strict-mcp-config vazio); perfil vazio = sem memória, CLAUDE.md ou hooks do usuário;
// - repositório git sintético, sem código nem dado de consumidor;
// - teto de 6 chamadas no total (ledger no perfil); execução falha ou incerta NUNCA é
//   repetida sem novo «sim» (o ledger recusa repetir candidato+execução);
// - evidência só agregada: papel, declarado, observado, contagem; sem transcript.
//
// Uso:
//   node scripts/probes/u10-subagent-model.js --config-dir <dir> --work-dir <dir> \
//     --candidate control|agents|env --run 1|2 --out <evidence.json> [--claude-bin <path>]

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync, spawnSync } = require('child_process');

const MAX_CALLS = 6;
const CANDIDATES = new Set(['control', 'agents', 'env']);
const ROLES = ['u10-role-a', 'u10-role-b'];
// Três famílias distintas: principal, frontmatter (o que o LLM acionaria) e o declarado na
// policy de fixture. Comparação por família no id observado.
const MAIN_MODEL = 'opus';
const FRONTMATTER_MODEL = 'haiku';
const DECLARED_MODEL = 'sonnet';
const PROMPT = `Use the Agent tool twice, in order: first with subagent_type "${ROLES[0]}" and prompt "Reply with the word ok.", ` +
    `then with subagent_type "${ROLES[1]}" and prompt "Reply with the word ok.". Do not use any other tool. Then reply DONE.`;

function family(modelId) {
    const m = String(modelId || '').toLowerCase();
    return ['opus', 'sonnet', 'haiku'].find(f => m.includes(f)) || 'UNKNOWN';
}

/**
 * Avaliação pura de uma execução. `attribution` = cost-tracking.subagentRoleAttribution.
 * Prova (candidato ≠ control): cada papel com ≥ 1 transcript atribuído sem conflito, e todos
 * os modelos observados desse papel na família declarada. Control: a observação tem de ver o
 * frontmatter (prova de que a medição detecta divergência).
 */
function evaluateRun({ candidate, attribution, exitCode }) {
    const expected = candidate === 'control' ? FRONTMATTER_MODEL : DECLARED_MODEL;
    const conflicted = attribution.filter(a => a.provenance !== 'META+TOOL_USE').length;
    const roles = ROLES.map(role => {
        // Só papel casado pelo tool_use conta como prova (C-O-03/C-A-06): META sozinho não.
        const mine = attribution.filter(a => a.role === role && a.provenance === 'META+TOOL_USE');
        const observed = [...new Set(mine.flatMap(a => a.models.map(family)))].sort();
        return { role, declared: candidate === 'control' ? null : DECLARED_MODEL, frontmatter: FRONTMATTER_MODEL, observed, transcripts: mine.length,
            match: mine.length > 0 && observed.length === 1 && observed[0] === expected };
    });
    const certain = exitCode === 0 && conflicted === 0;
    const allMatch = roles.every(r => r.match);
    return {
        candidate, exit_code: exitCode, roles, unattributed_transcripts: conflicted,
        result: !certain ? 'UNCERTAIN' : candidate === 'control'
            ? (allMatch ? 'CONTROL_DETECTS_FRONTMATTER' : 'CONTROL_FAILED')
            : (allMatch ? 'PROOF_OBTAINED' : 'PROOF_NOT_OBTAINED'),
    };
}

function args(argv) {
    const out = {};
    for (let i = 0; i < argv.length; i += 2) out[argv[i].replace(/^--/, '')] = argv[i + 1];
    return out;
}

function assertOutside(dir, label) {
    const abs = path.resolve(dir);
    const repo = path.resolve(__dirname, '..', '..');
    const forbidden = [path.join(os.homedir(), '.claude'), path.join(os.homedir(), '.claude-personal')];
    if (!path.isAbsolute(dir)) throw new Error(`${label} precisa ser absoluto`);
    if (abs === repo || abs.startsWith(repo + path.sep)) throw new Error(`${label} não pode ficar dentro do repositório`);
    if (forbidden.some(f => abs === f || abs.startsWith(f + path.sep))) throw new Error(`${label} não pode ser um perfil do usuário`);
    return abs;
}

function syntheticRepo(workDir) {
    const repo = path.join(workDir, 'u10-repo');
    fs.rmSync(repo, { recursive: true, force: true });
    fs.mkdirSync(path.join(repo, '.claude', 'agents'), { recursive: true });
    for (const role of ROLES) {
        fs.writeFileSync(path.join(repo, '.claude', 'agents', `${role}.md`),
            `---\nname: ${role}\ndescription: Papel sintético da prova U10. Responde ok.\nmodel: ${FRONTMATTER_MODEL}\n---\nResponda apenas com a palavra ok.\n`);
    }
    fs.writeFileSync(path.join(repo, 'README.md'), 'Repositório sintético da prova U10 (PRI-311).\n');
    const env = { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_AUTHOR_NAME: 'u10', GIT_AUTHOR_EMAIL: 'u10@example.invalid', GIT_COMMITTER_NAME: 'u10', GIT_COMMITTER_EMAIL: 'u10@example.invalid' };
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo, env });
    execFileSync('git', ['add', '.'], { cwd: repo, env });
    execFileSync('git', ['commit', '-q', '-m', 'u10'], { cwd: repo, env });
    return repo;
}

function readLedger(file) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return { calls: [] }; }
}

function collectAttribution(configDir, sessionId) {
    const costTracking = require('../lib/cost-tracking');
    const projects = path.join(configDir, 'projects');
    const files = costTracking.findClaudeTranscripts(sessionId, projects);
    const main = files.find(f => !f.includes(`${path.sep}subagents${path.sep}`));
    const subagents = files.filter(f => f.includes(`${path.sep}subagents${path.sep}`)).map(f => {
        let meta = null;
        try { meta = JSON.parse(fs.readFileSync(f.replace(/\.jsonl$/, '.meta.json'), 'utf8')); } catch { meta = null; }
        return { file_ref: path.basename(f), content: fs.readFileSync(f, 'utf8'), meta };
    });
    return costTracking.subagentRoleAttribution({ main: main ? fs.readFileSync(main, 'utf8') : '', subagents });
}

function main(argv) {
    const a = args(argv);
    if (!CANDIDATES.has(a.candidate) || !['1', '2'].includes(a.run) || !a['config-dir'] || !a['work-dir'] || !a.out) {
        throw new Error('uso: --config-dir <dir> --work-dir <dir> --candidate control|agents|env --run 1|2 --out <arquivo>');
    }
    const configDir = assertOutside(a['config-dir'], '--config-dir');
    const workDir = assertOutside(a['work-dir'], '--work-dir');
    const out = assertOutside(a.out, '--out');
    const ledgerFile = path.join(configDir, 'u10-probe-ledger.json');
    const ledger = readLedger(ledgerFile);
    // O perfil é apagado ao fim: o teto e a recusa de repetição também contam os registros do
    // --out, que fica fora do perfil (C-A-07). Um perfil recriado não zera nada.
    const prior = fs.existsSync(out) ? (JSON.parse(fs.readFileSync(out, 'utf8')).records || []) : [];
    const done = [...ledger.calls.map(c => ({ candidate: c.candidate, run: String(c.run), result: c.result })),
        ...prior.map(r => ({ candidate: r.candidate, run: String(r.run), result: r.result }))];
    const keys = new Set(done.map(c => `${c.candidate}/${c.run}`));
    if (keys.size >= MAX_CALLS) throw new Error(`teto de ${MAX_CALLS} chamadas atingido`);
    if (keys.has(`${a.candidate}/${a.run}`)) {
        throw new Error(`${a.candidate}/${a.run} já executado (resultado ${done.find(c => `${c.candidate}/${c.run}` === `${a.candidate}/${a.run}`).result}); repetir exige novo «sim»`);
    }
    fs.mkdirSync(workDir, { recursive: true });
    const repo = syntheticRepo(workDir);
    const { routedPluginProof } = require('../lib/claude-account');
    const proof = routedPluginProof({ runDir: workDir, accountDir: configDir, projectDir: repo });
    if (proof.status !== 'NOT_LOADED') throw new Error(`plugin não provado desligado: ${proof.status} (${proof.reason || '-'})`);
    const bin = a['claude-bin'] || execFileSync('/usr/bin/which', ['claude'], { encoding: 'utf8' }).trim();
    const version = execFileSync(bin, ['--version'], { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: os.homedir(), CLAUDE_CONFIG_DIR: configDir } }).trim();
    const sessionId = crypto.randomUUID();
    const argvClaude = ['-p', PROMPT, '--model', MAIN_MODEL, '--session-id', sessionId, '--settings', proof.settings_path,
        '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--allowedTools', 'Agent,Task'];
    const env = { PATH: process.env.PATH, HOME: os.homedir(), CLAUDE_CONFIG_DIR: configDir };
    if (a.candidate === 'agents') {
        argvClaude.push('--agents', JSON.stringify(Object.fromEntries(ROLES.map(r => [r, {
            description: 'Papel sintético da prova U10. Responde ok.', prompt: 'Responda apenas com a palavra ok.', model: DECLARED_MODEL,
        }]))));
    }
    if (a.candidate === 'env') env.CLAUDE_CODE_SUBAGENT_MODEL = DECLARED_MODEL;
    // Reserva a chamada ANTES de executar: queda no meio conta no teto e não é repetida.
    ledger.calls.push({ candidate: a.candidate, run: a.run, session_id: sessionId, at: new Date().toISOString(), result: 'IN_FLIGHT' });
    fs.writeFileSync(ledgerFile, JSON.stringify(ledger, null, 2));
    const res = spawnSync(bin, argvClaude, { cwd: repo, env, encoding: 'utf8', timeout: 10 * 60 * 1000 });
    const exitCode = res.status === null ? null : res.status;
    const evaluation = evaluateRun({ candidate: a.candidate, attribution: collectAttribution(configDir, sessionId), exitCode });
    ledger.calls[ledger.calls.length - 1].result = evaluation.result;
    fs.writeFileSync(ledgerFile, JSON.stringify(ledger, null, 2));
    const record = {
        candidate: a.candidate, run: Number(a.run), at: new Date().toISOString(), cli_version: version,
        argv: argvClaude.map(x => (x === PROMPT ? '<PROMPT>' : x)), env_added: a.candidate === 'env' ? ['CLAUDE_CODE_SUBAGENT_MODEL'] : [],
        plugin_proof: { status: proof.status, settings_sha256: proof.settings_sha256 },
        models: { main: MAIN_MODEL, frontmatter: FRONTMATTER_MODEL, declared: DECLARED_MODEL },
        ...evaluation,
    };
    const prev = fs.existsSync(out) ? JSON.parse(fs.readFileSync(out, 'utf8')) : { probe: 'U10 PRI-311', records: [] };
    prev.records.push(record);
    fs.writeFileSync(out, `${JSON.stringify(prev, null, 2)}\n`);
    process.stdout.write(`${JSON.stringify({ candidate: record.candidate, run: record.run, result: record.result, roles: record.roles }, null, 2)}\n`);
}

module.exports = { evaluateRun, family, ROLES, DECLARED_MODEL, FRONTMATTER_MODEL, MAX_CALLS };

if (require.main === module) {
    try {
        main(process.argv.slice(2));
    } catch (e) {
        process.stderr.write(`ERRO: ${e.message}\n`);
        process.exit(2);
    }
}
