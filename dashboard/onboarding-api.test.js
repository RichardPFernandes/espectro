// node --test onboarding-api.test.js
// Tela "Este computador" (dashboard/onboarding.js): ferramentas, gravação da configuração
// no .env/prefs do consumidor sem devolver segredo, e verificação só leitura. Repos git
// temporários; exec, fetch e sondagem do Claude são falsos.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { execFileSync } = require('node:child_process');
const express = require('express');
const { createOnboarding, readEnvFile, upsertEnvFile } = require('./onboarding');

const tmpBase = process.env.CLAUDE_JOB_DIR ? path.join(process.env.CLAUDE_JOB_DIR, 'tmp') : os.tmpdir();
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(tmpBase, 'onboarding-api-')));
const mkRepo = name => { const d = path.join(tmp, name); fs.mkdirSync(d, { recursive: true }); execFileSync('git', ['init', '-q', '-b', 'main', d]); return d; };
const active = mkRepo('active');
const other = mkRepo('other');
const prisma = mkRepo('prisma');
const notRepo = path.join(tmp, 'plain'); fs.mkdirSync(notRepo);
const KEY = 'chave-redmine-0123456789abcdef';

const accounts = [{ id: 'default', label: 'padrão', dir: path.join(tmp, '.claude') }, { id: '~/.claude-work', label: 'work', dir: path.join(tmp, '.claude-work') }];
const realExec = require('node:child_process').execFile;
function fakeExec(missing = []) {
    return (file, args, opts = {}) => new Promise(resolve => {
        if (missing.includes(file)) return resolve({ code: 1, stdout: '', stderr: '', missing: true });
        if (file !== 'git') return resolve({ code: 0, stdout: `${file} 9.9.9\n`, stderr: '' });
        realExec(file, args, opts, (err, stdout, stderr) => resolve({ code: err ? 1 : 0, stdout: String(stdout), stderr: String(stderr) }));
    });
}

function make({ envFile = path.join(tmp, `dash-${Math.random()}.env`), env = {}, locked = false, missing = [], fetchFn, probe, nodeVersion = 'v22.1.0' } = {}) {
    const saved = [];
    const probes = [];
    const ob = createOnboarding({
        repoRoot: active, prismaRoot: prisma, env, envFile, repoPathLocked: locked,
        redact: x => JSON.parse(JSON.stringify(x).split(KEY).join('***')),
        listAccounts: () => accounts,
        probeUsage: async args => { probes.push(args); return probe || { ok: true }; },
        validateConfig: async () => ({ exitCode: 0, results: [] }),
        onSaved: u => saved.push(u),
        exec: fakeExec(missing), fetchFn: fetchFn || (async () => ({ status: 200, json: async () => ({ user: { login: 'parceiro' } }) })),
        platform: 'darwin', nodeVersion,
    });
    return { ob, saved, probes, envFile };
}

async function request(ob, method, url, body) {
    const app = express(); app.use(express.json()); ob.mount(app);
    const server = http.createServer(app);
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    try {
        const res = await fetch(`http://127.0.0.1:${server.address().port}${url}`, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
        return { status: res.status, body: await res.json() };
    } finally { server.close(); }
}

test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

test('upsertEnvFile troca a chave, mantém o resto e cria arquivo 0600', () => {
    const f = path.join(tmp, 'x.env');
    upsertEnvFile(f, { A: '1' });
    assert.equal(fs.statSync(f).mode & 0o777, 0o600);
    fs.writeFileSync(f, '# comentário\nexport A=velho\nB=2\n');
    upsertEnvFile(f, { A: 'novo', C: '3' });
    assert.equal(fs.readFileSync(f, 'utf8'), '# comentário\nA=novo\nB=2\nC=3\n');
    assert.deepEqual(readEnvFile(f), { A: 'novo', B: '2', C: '3' });
});

test('ferramentas: obrigatória ausente pede você com comando; Codex ausente é opcional', async () => {
    const { ob } = make({ missing: ['claude', 'codex'] });
    const r = await ob.tools();
    const by = Object.fromEntries(r.items.map(i => [i.id, i]));
    assert.equal(by.git.state, 'done');
    assert.equal(by.node.state, 'done');
    assert.equal(by.claude.state, 'waiting');
    assert.match(by.claude.command, /claude-code/);
    assert.equal(by.codex.state, 'queued');
    assert.deepEqual(r.summary, { done: 2, optional: 1, waiting: 1 });
    const old = await make({ nodeVersion: 'v18.20.0' }).ob.tools();
    assert.equal(old.items.find(i => i.id === 'node').state, 'waiting');
});

test('repoInfo recusa pasta sem git, subpasta e o próprio Prisma', async () => {
    const { ob } = make();
    assert.equal((await ob.repoInfo(active)).ok, true);
    assert.equal((await ob.repoInfo(notRepo)).reason, 'Não é um repositório Git.');
    fs.mkdirSync(path.join(active, 'sub'), { recursive: true });
    assert.match((await ob.repoInfo(path.join(active, 'sub'))).reason, /raiz/);
    assert.match((await ob.repoInfo(prisma)).reason, /próprio Espectro/);
    assert.equal((await ob.repoInfo(path.join(tmp, 'nada'))).reason, 'Pasta não encontrada.');
});

test('config sem Redmine pede setup; salvar grava .env e prefs do consumidor e nunca devolve a chave', async () => {
    const { ob, saved } = make();
    assert.equal((await ob.readConfig()).needsSetup, true);
    const r = await request(ob, 'PUT', '/api/onboarding/config', {
        repoPath: active, claudeAccount: '~/.claude-work',
        redmineUrl: 'https://redmine.exemplo.com/', redmineApiKey: KEY,
        bitbucketWorkspace: 'ws', bitbucketRepoSlug: 'repo', bitbucketApiToken: '',
    });
    assert.equal(r.status, 200);
    assert.equal(r.body.needsSetup, false);
    assert.equal(r.body.redmine.apiKeySet, true);
    assert.equal(r.body.bitbucket.apiTokenSet, false);
    assert.equal(r.body.agent.account, '~/.claude-work');
    assert.ok(!JSON.stringify(r.body).includes(KEY));
    assert.deepEqual(readEnvFile(path.join(active, '.env')), { REDMINE_URL: 'https://redmine.exemplo.com', REDMINE_API_KEY: KEY, BITBUCKET_WORKSPACE: 'ws', BITBUCKET_REPO_SLUG: 'repo' });
    assert.equal(JSON.parse(fs.readFileSync(path.join(active, 'dashboard', 'dashboard-prefs.json'), 'utf8')).claude_config_dir, '~/.claude-work');
    assert.equal(saved.length, 1, 'repo em uso: processo recebe as chaves novas');
    // Segredo em branco mantém o salvo.
    await ob.saveConfig({ redmineApiKey: '' });
    assert.equal(readEnvFile(path.join(active, '.env')).REDMINE_API_KEY, KEY);
});

test('campos inválidos voltam 400 por campo, sem gravar nada', async () => {
    const { ob } = make();
    const before = fs.existsSync(path.join(other, '.env'));
    const r = await request(ob, 'PUT', '/api/onboarding/config', { repoPath: notRepo, claudeAccount: '/etc', redmineUrl: 'ftp://x', bitbucketWorkspace: 'a b', redmineApiKey: 'curta' });
    assert.equal(r.status, 400);
    assert.deepEqual(Object.keys(r.body.errors).sort(), ['bitbucketWorkspace', 'claudeAccount', 'redmineApiKey', 'redmineUrl', 'repoPath']);
    assert.equal(fs.existsSync(path.join(other, '.env')), before);
});

test('pasta nova vai para o .env do Prisma e pede reinício; travada pelo launcher recusa', async () => {
    const { ob, saved, envFile } = make();
    const r = await ob.saveConfig({ repoPath: other, redmineUrl: 'https://r.exemplo.com', redmineApiKey: KEY });
    assert.equal(r.status, 200);
    assert.equal(readEnvFile(envFile).REPO_PATH, other);
    assert.equal(r.body.repo.restartRequired, true);
    assert.equal(r.body.repo.path, other);
    assert.equal(readEnvFile(path.join(other, '.env')).REDMINE_URL, 'https://r.exemplo.com');
    assert.equal(saved.length, 0, 'repo ainda não está em uso: processo não muda');
    const chk = await ob.check();
    assert.equal(chk.restartRequired, true);
    assert.equal(chk.items.find(i => i.id === 'project').state, 'queued');

    const locked = make({ locked: true });
    const l = await locked.ob.saveConfig({ repoPath: other });
    assert.equal(l.status, 400);
    assert.match(l.body.errors.repoPath, /launcher/);
    assert.equal(fs.existsSync(locked.envFile), false);
});

test('chave salva não segue para um endereço novo do Redmine nem por redirect', async () => {
    const calls = [];
    const { ob } = make({ fetchFn: async (url, opts) => { calls.push({ url, opts }); return { status: 302, json: async () => ({}) }; } });
    await ob.saveConfig({ redmineUrl: 'https://r.exemplo.com', redmineApiKey: KEY });
    const moved = await ob.saveConfig({ redmineUrl: 'https://atacante.exemplo.net' });
    assert.equal(moved.status, 400);
    assert.match(moved.body.errors.redmineApiKey, /chave de API de novo/);
    assert.equal(readEnvFile(path.join(active, '.env')).REDMINE_URL, 'https://r.exemplo.com');
    // Mesma origem com outro caminho continua aceita sem redigitar.
    assert.equal((await ob.saveConfig({ redmineUrl: 'https://r.exemplo.com/redmine' })).status, 200);
    const chk = await ob.check();
    assert.equal(calls[0].opts.redirect, 'manual');
    assert.match(chk.items.find(i => i.id === 'redmine').detail, /redirecionou \(HTTP 302\)/);
    fs.rmSync(path.join(active, '.env'), { force: true });
});

test('verificação: só leitura, cada peça com estado; falha do Redmine não vaza a chave', async () => {
    const calls = [];
    const env = { REDMINE_URL: 'https://r.exemplo.com', REDMINE_API_KEY: KEY };
    const { ob, probes } = make({ env, fetchFn: async (url, opts) => { calls.push({ url, opts }); return { status: 200, json: async () => ({ user: { login: 'parceiro' } }) }; } });
    fs.rmSync(path.join(active, '.env'), { force: true });
    const ok = await ob.check();
    const by = Object.fromEntries(ok.items.map(i => [i.id, i]));
    assert.equal(by.repo.state, 'done');
    assert.match(by.repo.detail, /branch main/);
    assert.equal(by.agent.state, 'done');
    assert.equal(by.redmine.detail, 'conectado como parceiro');
    assert.equal(by.bitbucket.state, 'queued');
    assert.equal(by.project.state, 'done');
    assert.equal(ok.ready, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://r.exemplo.com/users/current.json');
    assert.ok(!calls[0].opts.method, 'GET');
    assert.equal(probes.length, 1);

    const bad = make({ env, fetchFn: async () => ({ status: 401, json: async () => ({}) }), probe: { ok: false, error: `sem login ${KEY}` } });
    const r = await request(bad.ob, 'POST', '/api/onboarding/check');
    const red = Object.fromEntries(r.body.items.map(i => [i.id, i]));
    assert.equal(red.redmine.state, 'failed');
    assert.match(red.redmine.detail, /recusada \(HTTP 401\)/);
    assert.equal(red.agent.state, 'failed');
    assert.equal(r.body.ready, false);
    assert.ok(!JSON.stringify(r.body).includes(KEY));
});
