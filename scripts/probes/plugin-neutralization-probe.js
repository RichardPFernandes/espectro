#!/usr/bin/env node
// PRI-366 (F2 da PRI-363, U-08): prova, numa versão exata da CLI, de que o --settings gerado
// por claude-account.routedPluginProof faz o CLI NÃO carregar o jev-model-router (SP-2).
// Mesma pergunta da prova manual da 2.1.319 (prisma-evidence/2026-11-06-pri-233/
// cli-plugin-proof.md), agora reproduzível por versão.
//
// STATUS: verificação pontual, FORA do watcher, do harness e de qualquer estado de Run. Roda o
// binário real da CLI, mas OFFLINE e sem credencial:
// - perfil (CLAUDE_CONFIG_DIR) e HOME novos, sintéticos, fora do repositório e dos perfis do
//   usuário; o probe recusa rodar se `claude auth status` disser que o perfil tem login;
// - nenhuma chave no ambiente (env montado do zero) e ANTHROPIC_BASE_URL num porto fechado do
//   loopback: o CLI emite o evento system/init (skills, plugins, slash_commands) e para em
//   "Not logged in", sem chamada ao provider. A evidência confere custo 0 e api_ms 0;
// - repositório e plugins sintéticos, sem código nem dado de consumidor.
//
// Cenários (cada um com controle sem --settings e teste com o --settings gerado):
// - project_skill: skill solta em <projeto>/.claude/skills/jev-model-router;
// - account_skills_dir_plugin: plugin em <perfil>/skills/jev-model-router (chave @skills-dir);
// - marketplace_plugin: plugin jev-model-router de um marketplace local, instalado e ligado em
//   enabledPlugins do perfil (`claude plugin marketplace add` + `install`, tudo local).
// Veredito por cenário: PROOF_OBTAINED (controle vê o router e o teste não o menciona),
// PROOF_NOT_OBTAINED, CONTROL_FAILED, INCONCLUSIVE (sem init ou offline não confirmado).
// Geral: PROOF_OBTAINED só com os três cenários PROOF_OBTAINED.
//
// Evidência só agregada (nomes/fontes do router, contagens, sha256); caminhos viram <WORK>.
//
// Uso:
//   node scripts/probes/plugin-neutralization-probe.js --work-dir <dir novo> --out <arquivo.json> [--claude-bin <path>]

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const ROUTER = 'jev-model-router';
const SCENARIOS = ['project_skill', 'account_skills_dir_plugin', 'marketplace_plugin'];
const MARKETPLACE = 'synth-mkt';
const OFFLINE_BASE_URL = 'http://127.0.0.1:9';
const PROMPT = 'Reply with the single word ok. Do not use any tool.';

const mentionsRouter = value => JSON.stringify(value === undefined ? null : value).includes(ROUTER);

/** Resumo agregado de uma execução a partir das linhas do stream-json. */
function summarizeRun({ exitCode, lines }) {
    const events = (Array.isArray(lines) ? lines : []).filter(e => e && typeof e === 'object');
    const init = events.find(e => e.type === 'system' && e.subtype === 'init') || null;
    const result = [...events].reverse().find(e => e.type === 'result') || null;
    const pick = list => (Array.isArray(list) ? list : []).filter(mentionsRouter)
        .map(x => (typeof x === 'string' ? x : { name: x.name ?? null, source: x.source ?? null }));
    return {
        exit_code: exitCode,
        init: init ? {
            counts: { skills: (init.skills || []).length, plugins: (init.plugins || []).length, slash_commands: (init.slash_commands || []).length },
            router: { skills: pick(init.skills), plugins: pick(init.plugins), slash_commands: pick(init.slash_commands) },
            api_key_source: init.apiKeySource ?? null,
            claude_code_version: init.claude_code_version ?? null,
        } : null,
        router_mentioned_anywhere: events.some(mentionsRouter),
        total_cost_usd: result ? result.total_cost_usd ?? null : null,
        duration_api_ms: result ? result.duration_api_ms ?? null : null,
    };
}

const offline = r => r.total_cost_usd === 0 && r.duration_api_ms === 0 && r.init && r.init.api_key_source === 'none';
const routerSeen = r => Boolean(r.init) && Object.values(r.init.router).some(list => list.length > 0);

/** Veredito puro de um cenário (controle × teste). */
function evaluateScenario({ control, test }) {
    if (!control || !test || !control.init || !test.init) return { result: 'INCONCLUSIVE', reason: 'SEM_EVENTO_INIT' };
    if (!offline(control) || !offline(test)) return { result: 'INCONCLUSIVE', reason: 'OFFLINE_NAO_CONFIRMADO' };
    if (!routerSeen(control)) return { result: 'CONTROL_FAILED', reason: 'CONTROLE_NAO_VE_O_ROUTER' };
    if (test.router_mentioned_anywhere) return { result: 'PROOF_NOT_OBTAINED', reason: 'ROUTER_CARREGADO_COM_SETTINGS' };
    return { result: 'PROOF_OBTAINED', reason: null };
}

function overall(scenarios) {
    const results = scenarios.map(s => s.result);
    if (results.length === SCENARIOS.length && results.every(r => r === 'PROOF_OBTAINED')) return 'PROOF_OBTAINED';
    if (results.includes('PROOF_NOT_OBTAINED')) return 'PROOF_NOT_OBTAINED';
    return 'INCONCLUSIVE';
}

function args(argv) {
    const out = {};
    for (let i = 0; i < argv.length; i += 2) out[argv[i].replace(/^--/, '')] = argv[i + 1];
    return out;
}

function assertOutside(dir, label) {
    if (!dir || !path.isAbsolute(dir)) throw new Error(`${label} precisa ser absoluto`);
    const abs = path.resolve(dir);
    const repo = path.resolve(__dirname, '..', '..');
    const forbidden = [path.join(os.homedir(), '.claude'), path.join(os.homedir(), '.claude-personal')];
    if (abs === repo || abs.startsWith(repo + path.sep)) throw new Error(`${label} não pode ficar dentro do repositório`);
    if (forbidden.some(f => abs === f || abs.startsWith(f + path.sep))) throw new Error(`${label} não pode ser um perfil do usuário`);
    return abs;
}

function write(file, text) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
}

const skillMd = (name, what) => `---\nname: ${name}\ndescription: ${what} sintética da prova PRI-366.\n---\nResponda ok.\n`;
const pluginJson = () => `${JSON.stringify({ name: ROUTER, version: '0.0.0-synthetic', description: 'Plugin sintético da prova PRI-366.' })}\n`;

function main(argv) {
    const a = args(argv);
    const work = assertOutside(a['work-dir'], '--work-dir');
    const out = assertOutside(a.out, '--out');
    if (fs.existsSync(work) && fs.readdirSync(work).length) throw new Error('--work-dir precisa ser novo ou vazio');
    const bin = a['claude-bin'] || path.join(os.homedir(), '.local', 'bin', 'claude');
    const binReal = fs.realpathSync(bin);
    const binSha = crypto.createHash('sha256').update(fs.readFileSync(binReal)).digest('hex');
    const home = path.join(work, 'home');
    fs.mkdirSync(home, { recursive: true });
    const redact = s => String(s).split(work).join('<WORK>');
    const envFor = configDir => ({
        PATH: '/usr/bin:/bin', HOME: home, USER: os.userInfo().username, LOGNAME: os.userInfo().username,
        CLAUDE_CONFIG_DIR: configDir, ANTHROPIC_BASE_URL: OFFLINE_BASE_URL,
        DISABLE_AUTOUPDATER: '1', DISABLE_TELEMETRY: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    });
    const run = (cwd, configDir, argvClaude) => spawnSync(binReal, argvClaude, { cwd, env: envFor(configDir), encoding: 'utf8', timeout: 120000 });
    const { routedPluginProof } = require('../lib/claude-account');
    const versionRun = run(home, path.join(work, 'version-config'), ['--version']);
    const cliVersion = String(versionRun.stdout || '').trim();
    const scenarios = [];
    for (const scenario of SCENARIOS) {
        const configDir = path.join(work, scenario, 'config');
        const project = path.join(work, scenario, 'project');
        fs.mkdirSync(path.join(configDir), { recursive: true });
        fs.mkdirSync(path.join(project), { recursive: true });
        write(path.join(project, 'README.md'), 'Projeto sintético da prova PRI-366.\n');
        const setup = [];
        if (scenario === 'project_skill') write(path.join(project, '.claude', 'skills', ROUTER, 'SKILL.md'), skillMd(ROUTER, 'Skill solta'));
        if (scenario === 'account_skills_dir_plugin') {
            write(path.join(configDir, 'skills', ROUTER, '.claude-plugin', 'plugin.json'), pluginJson());
            write(path.join(configDir, 'skills', ROUTER, 'skills', 'route', 'SKILL.md'), skillMd('route', 'Skill'));
        }
        if (scenario === 'marketplace_plugin') {
            const mkt = path.join(work, scenario, 'marketplace');
            write(path.join(mkt, '.claude-plugin', 'marketplace.json'), `${JSON.stringify({ name: MARKETPLACE, owner: { name: 'synthetic' },
                plugins: [{ name: ROUTER, source: `./plugins/${ROUTER}`, description: 'Plugin sintético da prova PRI-366.' }] })}\n`);
            write(path.join(mkt, 'plugins', ROUTER, '.claude-plugin', 'plugin.json'), pluginJson());
            write(path.join(mkt, 'plugins', ROUTER, 'skills', 'route', 'SKILL.md'), skillMd('route', 'Skill'));
            for (const step of [['plugin', 'marketplace', 'add', mkt], ['plugin', 'install', `${ROUTER}@${MARKETPLACE}`]]) {
                const r = run(project, configDir, step);
                setup.push({ argv: step.map(redact), exit_code: r.status });
                if (r.status !== 0) throw new Error(`${scenario}: ${step.join(' ')} saiu ${r.status}: ${redact(r.stderr || r.stdout)}`);
            }
        }
        // Guarda de custo: perfil com login nunca roda (o probe só vale offline).
        const auth = run(project, configDir, ['auth', 'status']);
        let loggedIn = null;
        try { loggedIn = JSON.parse(auth.stdout).loggedIn; } catch { loggedIn = null; }
        if (loggedIn !== false) throw new Error(`${scenario}: perfil não está comprovadamente sem login (loggedIn=${loggedIn}); probe recusado`);
        const runDir = path.join(work, scenario, 'run');
        fs.mkdirSync(runDir, { recursive: true });
        const proof = routedPluginProof({ runDir, accountDir: configDir, projectDir: project });
        if (proof.status !== 'NOT_LOADED') throw new Error(`${scenario}: routedPluginProof = ${proof.status} (${proof.reason || '-'})`);
        const base = ['-p', PROMPT, '--output-format', 'stream-json', '--verbose', '--max-turns', '1', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}'];
        const exec = (argvClaude) => {
            const r = run(project, configDir, argvClaude);
            const lines = String(r.stdout || '').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } });
            return { argv: argvClaude.map(x => (x === PROMPT ? '<PROMPT>' : redact(x))), ...summarizeRun({ exitCode: r.status, lines }) };
        };
        const control = exec(base);
        const test = exec([...base, '--settings', proof.settings_path]);
        const generated = JSON.parse(fs.readFileSync(proof.settings_path, 'utf8'));
        scenarios.push({ scenario, setup, logged_in: loggedIn, settings: generated, settings_sha256: proof.settings_sha256,
            control, test, ...evaluateScenario({ control, test }) });
    }
    const record = {
        probe: 'U-08 plugin-neutralization PRI-366', at: new Date().toISOString(), cli_version: cliVersion,
        cli_binary: { path: redact(binReal).replace(os.homedir(), '~'), sha256: binSha },
        offline: { base_url: OFFLINE_BASE_URL, credentials: 'none',
            provider_calls: scenarios.every(s => offline(s.control) && offline(s.test)) ? 0 : 'UNKNOWN' },
        scenarios, result: overall(scenarios),
    };
    write(out, `${JSON.stringify(record, null, 2)}\n`);
    process.stdout.write(`${JSON.stringify({ cli_version: cliVersion, result: record.result, scenarios: scenarios.map(s => [s.scenario, s.result]) }, null, 2)}\n`);
}

module.exports = { summarizeRun, evaluateScenario, overall, SCENARIOS, ROUTER };

if (require.main === module) {
    try {
        main(process.argv.slice(2));
    } catch (e) {
        process.stderr.write(`ERRO: ${e.message}\n`);
        process.exit(2);
    }
}
