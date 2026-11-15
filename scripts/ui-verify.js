#!/usr/bin/env node
'use strict';
// Apoio da verificação de UI (PRI-355). Quem navega é o agente, pelo Playwright MCP; este CLI faz o
// que precisa ser determinístico e fail-closed:
//   server ensure                 sobe um servidor PRÓPRIO (fixture, somente leitura) e espera HTTP
//   server stop                   encerra só o que ele subiu (valida PID, grupo, início e token de posse)
//   touches <base>                0 = toca frontend, 1 = não toca, 2 = erro (UNKNOWN)
//   verdict <findings.json> --base <base> --acs AC-1,AC-2|none
// Exit: 0 ok (PASSOU/N/A/SKIPPED) · 1 FALHOU · 2 erro/UNKNOWN. Nunca converte erro em PASSOU.
// Estado do CLI fica em .prisma/ui-state/ (fora da área que o navegador pode escrever: .prisma/ui-verify/).
// Env: PRISMA_UI_VERIFY=on|off (padrão off) · PRISMA_UI_PORT (3399) · PRISMA_UI_FRONTEND_GLOBS
//      REPO_PATH (checkout onde o git roda; padrão cwd) · PRISMA_ROOT (plataforma; padrão este checkout)
//      Servidor customizado (nível Alto): PRISMA_UI_CUSTOM_SERVER=1 + PRISMA_UI_SERVER_CMD / PRISMA_UI_SERVER_CWD
//      Só para testes: PRISMA_UI_TERM_WAIT_MS, PRISMA_UI_LOCK_WAIT_MS
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { spawn, execFileSync } = require('node:child_process');
const { touchesFrontend, verdict, formatReport, DEFAULT_FRONTEND_GLOBS } = require('./lib/ui-verify-verdict');

const HOME_PREFIX = 'ui-verify-home-';
const FIXTURE_PREFIX = 'ui-verify-fixture-';
const OWNER_FILE = '.ui-verify-owner';
const LOCK_STALE_MS = 120000;
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
// Assets que o dashboard exige no REPO_PATH (mesma lista de harness/run-tests.js).
const FIXTURE_ASSETS = ['.claude/spec-hash-config.json', '.claude/config-contract.json', 'scripts/fixtures/ticket-example.json'];
const FINGERPRINT_SKIP = new Set(['node_modules', '.git', '.prisma', 'logs']);

class UsageError extends Error {}

function inside(parent, child) {
    const rel = path.relative(parent, child);
    return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}
const under = (parent, p) => p === parent || inside(parent, p);
const realOr = p => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };

function intEnv(env, key, dflt) {
    if (env[key] === undefined) return dflt;
    if (!/^\d{1,6}$/.test(env[key])) throw new UsageError(`${key} inválido: ${env[key]}`);
    return Number(env[key]);
}

function parseGlobs(raw) {
    const globs = raw.split(',').map(s => s.trim()).filter(Boolean);
    if (!globs.length) throw new UsageError('PRISMA_UI_FRONTEND_GLOBS sem nenhum glob');
    const bad = globs.find(g => /[{}[\]!]/.test(g));
    if (bad) throw new UsageError(`glob não suportado (só *, ** e ?): ${bad}`);
    return globs;
}

function cfg(env = process.env) {
    const repo = path.resolve(env.REPO_PATH || process.cwd());
    const platform = path.resolve(env.PRISMA_ROOT || path.join(__dirname, '..'));
    const port = String(env.PRISMA_UI_PORT || '3399');
    if (!/^\d{2,5}$/.test(port)) throw new UsageError(`PRISMA_UI_PORT inválida: ${port}`);
    const mode = (env.PRISMA_UI_VERIFY || 'off').toLowerCase();
    if (!['on', 'off'].includes(mode)) throw new UsageError(`PRISMA_UI_VERIFY deve ser on ou off (veio "${env.PRISMA_UI_VERIFY}")`);
    const custom = Boolean(env.PRISMA_UI_SERVER_CMD || env.PRISMA_UI_SERVER_CWD);
    const serverCwd = path.resolve(env.PRISMA_UI_SERVER_CWD || path.join(platform, 'dashboard'));
    if (!under(platform, serverCwd) && !under(repo, serverCwd)) throw new UsageError(`PRISMA_UI_SERVER_CWD fora da plataforma e do checkout: ${serverCwd}`);
    return {
        repo, platform, port, serverCwd, custom,
        allowCustom: env.PRISMA_UI_CUSTOM_SERVER === '1',
        dir: path.join(repo, '.prisma', 'ui-verify'),      // área do navegador (screenshots, findings)
        stateDir: path.join(repo, '.prisma', 'ui-state'),  // área do CLI (o hook nega escrita do navegador aqui)
        url: `http://127.0.0.1:${port}`,
        origins: [`http://localhost:${port}`, `http://127.0.0.1:${port}`],
        cmd: (env.PRISMA_UI_SERVER_CMD || 'npm start').trim(),
        globsConfigured: Boolean(env.PRISMA_UI_FRONTEND_GLOBS),
        globs: env.PRISMA_UI_FRONTEND_GLOBS ? parseGlobs(env.PRISMA_UI_FRONTEND_GLOBS) : DEFAULT_FRONTEND_GLOBS,
        enabled: mode === 'on',
        termWaitMs: intEnv(env, 'PRISMA_UI_TERM_WAIT_MS', 8000),
        lockWaitMs: intEnv(env, 'PRISMA_UI_LOCK_WAIT_MS', 90000),
    };
}

function probe(url, timeoutMs = 1500) {
    return new Promise(resolve => {
        const req = http.get(url, res => { res.resume(); resolve(res.statusCode >= 200 && res.statusCode < 400); });
        req.setTimeout(timeoutMs, () => { req.destroy(); resolve(false); });
        req.on('error', () => resolve(false));
    });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function waitUntil(fn, timeoutMs, stepMs = 200) {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) { if (await fn()) return true; await sleep(stepMs); }
    return false;
}

const infoFile = c => path.join(c.stateDir, 'server.json');
const sessionFile = c => path.join(c.stateDir, 'session.json');
const lockDir = c => path.join(c.stateDir, 'server.lock');
function readInfo(c) {
    let raw;
    try { raw = fs.readFileSync(infoFile(c), 'utf8'); } catch { return { missing: true }; }
    try { const v = JSON.parse(raw); return v && typeof v === 'object' && !Array.isArray(v) ? v : { unreadable: true }; } catch { return { unreadable: true }; }
}

function pidAlive(pid) { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } }
function groupAlive(pid) { try { process.kill(-pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } }
// {pgid, lstart} | null (processo não existe) | 'unavailable' (ps ausente ou falhou: não dá para afirmar nada).
function psInfo(pid) {
    try {
        const out = execFileSync('ps', ['-o', 'pgid=,lstart=', '-p', String(pid)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
        const m = out.match(/^(\d+)\s+(.*)$/);
        return m ? { pgid: Number(m[1]), lstart: m[2].replace(/\s+/g, ' ') } : null;
    } catch (e) { return e.status === 1 ? null : 'unavailable'; }
}

function listenerCwd(port) {
    try {
        const pid = execFileSync('lsof', ['-ti', `tcp:${port}`, '-sTCP:LISTEN'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).split('\n')[0];
        const out = execFileSync('lsof', ['-a', '-d', 'cwd', '-p', pid, '-Fn'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
        return out.split('\n').find(l => l.startsWith('n'))?.slice(1) || null;
    } catch { return null; }
}

// Posse por token gravado dentro do diretório (e no registro), não por caminho: independe de TMPDIR.
function tmpOwned(p, prefix, token) {
    if (typeof p !== 'string' || typeof token !== 'string' || !token) return false;
    try {
        const st = fs.lstatSync(p);
        return st.isDirectory() && !st.isSymbolicLink() && path.basename(p).startsWith(prefix)
            && fs.readFileSync(path.join(p, OWNER_FILE), 'utf8') === token;
    } catch { return false; }
}
function rmOwned(p, prefix, token) { if (tmpOwned(p, prefix, token)) fs.rmSync(p, { recursive: true, force: true }); }
function mkOwnedDir(prefix, token) {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    fs.writeFileSync(path.join(d, OWNER_FILE), token);
    return d;
}

async function withLock(c, fn, waitMs) {
    fs.mkdirSync(c.stateDir, { recursive: true });
    const end = Date.now() + waitMs;
    for (;;) {
        try { fs.mkdirSync(lockDir(c)); break; } catch (e) {
            if (e.code !== 'EEXIST') throw e;
            try { if (Date.now() - fs.statSync(lockDir(c)).mtimeMs > LOCK_STALE_MS) fs.rmdirSync(lockDir(c)); } catch { /* corrida */ }
            if (Date.now() > end) throw new Error('outro ensure/stop em andamento (server.lock)');
            await sleep(100);
        }
    }
    try { return await fn(); } finally { try { fs.rmdirSync(lockDir(c)); } catch { /* já saiu */ } }
}

// "n arquivos : maior mtime" do código que o servidor roda. Muda => servidor reaproveitado estaria velho.
function fingerprint(dir) {
    let n = 0; let max = 0;
    const walk = d => {
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
            if (e.isDirectory()) { if (!FINGERPRINT_SKIP.has(e.name)) walk(path.join(d, e.name)); } else if (e.isFile()) {
                n++; max = Math.max(max, fs.statSync(path.join(d, e.name)).mtimeMs);
            }
        }
    };
    try { walk(dir); } catch { /* diretório inexistente: spawn reporta */ }
    return `${n}:${Math.round(max)}`;
}

function makeFixture(c, token) {
    const fixture = mkOwnedDir(FIXTURE_PREFIX, token);
    for (const rel of FIXTURE_ASSETS) {
        const src = path.join(c.platform, rel);
        if (!fs.existsSync(src)) { rmOwned(fixture, FIXTURE_PREFIX, token); throw new Error(`asset do fixture ausente na plataforma: ${rel}`); }
        fs.mkdirSync(path.dirname(path.join(fixture, rel)), { recursive: true });
        fs.copyFileSync(src, path.join(fixture, rel));
    }
    return fixture;
}

function parseCmd(cmd) {
    if (cmd.startsWith('[')) {
        let a;
        try { a = JSON.parse(cmd); } catch { throw new UsageError('PRISMA_UI_SERVER_CMD (lista JSON) inválido'); }
        if (!Array.isArray(a) || !a.length || a.some(x => typeof x !== 'string' || !x)) throw new UsageError('PRISMA_UI_SERVER_CMD deve ser lista JSON de strings não vazias');
        return a;
    }
    const a = cmd.split(/\s+/).filter(Boolean);
    if (!a.length) throw new UsageError('PRISMA_UI_SERVER_CMD vazio');
    return a;
}

const markSession = c => fs.writeFileSync(sessionFile(c), JSON.stringify({ ensureAt: Date.now() }));
const validRecord = st => st && st.startedByUs === true && Number.isInteger(st.pid) && st.pid > 1
    && typeof st.token === 'string' && typeof st.lstart === 'string' && /^\d{2,5}$/.test(String(st.port));

async function serverEnsure(c, timeoutMs = 60000) {
    if (c.custom && !c.allowCustom) {
        throw new UsageError('servidor customizado (PRISMA_UI_SERVER_CMD/CWD) contorna fixture e somente leitura: exige PRISMA_UI_CUSTOM_SERVER=1 e AUTORIZO próprio (nível Alto)');
    }
    return withLock(c, async () => {
        const fp = fingerprint(c.serverCwd);
        const prev = readInfo(c);
        if (prev.startedByUs) {
            const ps = psInfo(prev.pid);
            const identical = validRecord(prev) && ps && ps !== 'unavailable' && ps.pgid === prev.pid && ps.lstart === prev.lstart;
            if (identical && prev.fingerprint === fp && await probe(c.url)) {
                markSession(c);
                return { url: c.url, startedByUs: true, pid: prev.pid, reused: true };
            }
            // Código mudou, processo diferente ou registro velho: encerra o que é nosso (com as mesmas validações do stop).
            const r = await stopLocked(c);
            if (!r.stopped && r.reason === 'processo não encerrou') throw new Error(`não consegui encerrar o servidor anterior (pid ${prev.pid})`);
        }
        if (await probe(c.url)) {
            const e = new Error(`porta ${c.port} ocupada por um servidor que não é nosso (cwd: ${listenerCwd(c.port) || 'desconhecido'}). `
                + 'Não o reaproveito: ele pode rodar código de outro checkout e aceitar escrita. Use outra porta (PRISMA_UI_PORT) e reabra a sessão do Claude Code.');
            e.code = 'PORT_IN_USE';
            throw e;
        }
        const [bin, ...args] = parseCmd(c.cmd);
        const token = crypto.randomBytes(16).toString('hex');
        const home = mkOwnedDir(HOME_PREFIX, token);
        let fixture;
        try { fixture = makeFixture(c, token); } catch (e) { rmOwned(home, HOME_PREFIX, token); throw e; }
        const cleanup = () => { rmOwned(home, HOME_PREFIX, token); rmOwned(fixture, FIXTURE_PREFIX, token); };
        // Env mínimo, fixture como REPO_PATH (sem .env do consumidor) e dashboard somente leitura.
        const env = {
            PATH: process.env.PATH, HOME: home, TMPDIR: home, LANG: process.env.LANG || 'C',
            PORT: c.port, HOST: '127.0.0.1', REPO_PATH: fixture, PRISMA_ROOT: c.platform, PRISMA_DASHBOARD_READONLY: '1',
        };
        let child; let spawnErr = null; let exited = false;
        const log = fs.openSync(path.join(c.stateDir, 'server.log'), 'w');
        try {
            child = spawn(bin, args, { cwd: c.serverCwd, env, detached: true, stdio: ['ignore', log, log] });
        } catch (e) { fs.closeSync(log); cleanup(); throw new Error(`não consegui iniciar "${c.cmd}": ${e.message}`); }
        fs.closeSync(log);
        child.on('error', e => { spawnErr = e; exited = true; });
        child.on('exit', () => { exited = true; });
        if (!child.pid) { cleanup(); await sleep(50); throw new Error(`não consegui iniciar "${c.cmd}": ${spawnErr?.message || 'spawn falhou'}`); }
        const ps = psInfo(child.pid);
        const fail = async msg => { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* já saiu */ } cleanup(); fs.rmSync(infoFile(c), { force: true }); throw new Error(msg); };
        if (!ps || ps === 'unavailable') await fail('não consegui ler pgid/horário de início do servidor (ps indisponível): sem identidade, não há como encerrá-lo com segurança');
        // PID gravado antes de esperar: um erro no meio não deixa processo órfão sem registro.
        fs.writeFileSync(infoFile(c), JSON.stringify({
            url: c.url, port: c.port, startedByUs: true, pid: child.pid, lstart: ps.lstart, token, home, fixture, fingerprint: fp,
        }));
        const up = await waitUntil(async () => exited || await probe(c.url), timeoutMs, 300);
        if (!up || exited || !(await probe(c.url))) {
            await stopLocked(c);
            throw new Error(spawnErr ? `não consegui iniciar "${c.cmd}": ${spawnErr.message}`
                : `servidor não respondeu em ${c.url} (ver ${path.join(c.stateDir, 'server.log')})`);
        }
        child.unref();
        markSession(c);
        return { url: c.url, startedByUs: true, pid: child.pid };
    }, c.lockWaitMs);
}

// Só apaga o registro e os diretórios com o processo confirmado morto (ou registro que não é nosso).
async function stopLocked(c) {
    const st = readInfo(c);
    if (st.missing) return { stopped: false, reason: 'sem estado' };
    if (st.unreadable) return { stopped: false, reason: 'estado ilegível; mantido para inspeção, nada foi encerrado' };
    const finish = () => {
        rmOwned(st.home, HOME_PREFIX, st.token); rmOwned(st.fixture, FIXTURE_PREFIX, st.token);
        fs.rmSync(infoFile(c), { force: true });
    };
    if (!st.startedByUs) { fs.rmSync(infoFile(c), { force: true }); return { stopped: false, reason: 'servidor não é nosso' }; }
    if (!validRecord(st) || !tmpOwned(st.home, HOME_PREFIX, st.token) || !tmpOwned(st.fixture, FIXTURE_PREFIX, st.token)) {
        return { stopped: false, reason: 'estado inválido ou adulterado; nada foi encerrado nem apagado' };
    }
    const ps = psInfo(st.pid);
    if (ps === 'unavailable') {
        // Sem ps não há como provar a identidade: só vale como "já saiu" se nada com esse PID/grupo existe.
        if (pidAlive(st.pid) || groupAlive(st.pid)) return { stopped: false, reason: 'não consegui verificar o processo (ps indisponível); nada foi encerrado' };
        finish();
        return { stopped: true, pid: st.pid, alreadyExited: true };
    }
    if (!ps && !groupAlive(st.pid)) { finish(); return { stopped: true, pid: st.pid, alreadyExited: true }; }
    if (ps && (ps.pgid !== st.pid || ps.lstart !== st.lstart)) {
        finish();
        return { stopped: false, reason: 'PID reaproveitado por outro processo; não foi encerrado' };
    }
    // Líder do grupo confere (ou saiu e restaram filhos do nosso grupo): encerra o grupo todo.
    try { process.kill(-st.pid, 'SIGTERM'); } catch { /* já saiu */ }
    const portUrl = `http://127.0.0.1:${st.port}`;
    let gone = await waitUntil(async () => !groupAlive(st.pid) && !(await probe(portUrl, 500)), c.termWaitMs);
    if (!gone) {
        try { process.kill(-st.pid, 'SIGKILL'); } catch { /* já saiu */ }
        gone = await waitUntil(() => !groupAlive(st.pid), 3000);
    }
    if (!gone) return { stopped: false, pid: st.pid, reason: 'processo não encerrou' };
    finish();
    return { stopped: true, pid: st.pid };
}

const serverStop = c => withLock(c, () => stopLocked(c), Math.max(c.lockWaitMs, 15000));

function git(c, args) {
    return execFileSync('git', args, { cwd: c.repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });
}

function resolveBase(c, base) {
    if (typeof base !== 'string' || !base || base.startsWith('-')) throw new UsageError(`base inválida: ${String(base).slice(0, 60)}`);
    try { return git(c, ['rev-parse', '--verify', '--end-of-options', `${base}^{commit}`]).trim(); } catch {
        throw new UsageError(`base não resolve para um commit: ${base}`);
    }
}

function changedFiles(c, base) {
    const sha = resolveBase(c, base);
    const z = out => out.split('\0').filter(Boolean);
    // --relative: caminhos sempre relativos a REPO_PATH, como o ls-files (que já é relativo ao cwd).
    return [...new Set([
        ...z(git(c, ['-c', 'core.quotepath=false', 'diff', '-z', '--name-only', '--no-renames', '--relative', `${sha}...HEAD`])),
        ...z(git(c, ['-c', 'core.quotepath=false', 'diff', '-z', '--name-only', '--no-renames', '--relative', 'HEAD'])),
        ...z(git(c, ['-c', 'core.quotepath=false', 'ls-files', '-z', '--others', '--exclude-standard'])),
    ])];
}

function requireGlobs(c) {
    if (!c.globsConfigured && realOr(c.repo) !== realOr(c.platform)) {
        throw new UsageError('REPO_PATH não é a plataforma: defina PRISMA_UI_FRONTEND_GLOBS (os globs padrão são do dashboard do Prisma e dariam "sem frontend" sempre)');
    }
}

function arg(rest, name) { const i = rest.indexOf(name); return i >= 0 ? rest[i + 1] : undefined; }

function parseAcs(acsArg) {
    if (acsArg === 'none') return [];
    const acs = String(acsArg).split(',').map(s => s.trim());
    if (!acs.length || acs.some(a => !/^[A-Za-z0-9._-]{1,40}$/.test(a) || a.toLowerCase() === 'none')) throw new UsageError(`--acs inválido: "${acsArg}" (use AC-1,AC-2 ou none)`);
    return acs;
}

function screenshotOk(c, ensureAt) {
    return p => {
        try {
            const abs = path.resolve(c.repo, p);
            if (!inside(c.dir, abs)) return false;
            const st = fs.lstatSync(abs);
            if (!st.isFile() || st.isSymbolicLink() || st.size === 0 || st.mtimeMs + 2000 < ensureAt) return false;
            if (/\.png$/i.test(abs)) { const fd = fs.openSync(abs, 'r'); const b = Buffer.alloc(8); fs.readSync(fd, b, 0, 8, 0); fs.closeSync(fd); return b.equals(PNG_MAGIC); }
            return true;
        } catch { return false; }
    };
}

async function main([cmd, sub, ...rest], env = process.env, out = console) {
    try {
        const c = cfg(env);
        if (cmd === 'server' && sub === 'ensure') { out.log(JSON.stringify(await serverEnsure(c))); return 0; }
        if (cmd === 'server' && sub === 'stop') { out.log(JSON.stringify(await serverStop(c))); return 0; }
        if (cmd === 'touches') {
            if (!sub) throw new UsageError('touches exige <base>');
            requireGlobs(c);
            const hit = touchesFrontend(changedFiles(c, sub), c.globs);
            out.log(hit ? 'frontend' : 'sem-frontend');
            return hit ? 0 : 1;
        }
        if (cmd === 'verdict') {
            if (!sub) throw new UsageError('verdict exige <findings.json>');
            const findingsPath = path.resolve(sub);
            if (!inside(c.dir, findingsPath)) throw new UsageError(`findings.json deve ficar dentro de ${c.dir}`);
            const verdictPath = path.join(path.dirname(findingsPath), 'verdict.json');
            fs.rmSync(verdictPath, { force: true }); // nunca deixa veredito antigo valer, nem em erro
            const write = r => {
                fs.mkdirSync(path.dirname(verdictPath), { recursive: true });
                fs.writeFileSync(verdictPath, JSON.stringify(r, null, 2));
                out.log(formatReport(r));
                return r.verdict === 'FALHOU' ? 1 : 0;
            };
            const fail = (code, detail) => write({ verdict: 'FALHOU', problems: [{ code, where: 'run', detail }] });
            if (!c.enabled) return write(verdict({ enabled: false }));
            const base = arg(rest, '--base');
            const acsArg = arg(rest, '--acs');
            if (!base) throw new UsageError('verdict exige --base <base> (para decidir se há frontend)');
            if (!acsArg) throw new UsageError('verdict exige --acs AC-1,AC-2 (ACs de UI da spec) ou --acs none');
            const acs = parseAcs(acsArg);
            requireGlobs(c);
            const touches = touchesFrontend(changedFiles(c, base), c.globs);
            if (!touches || !acs.length) return write(verdict({ enabled: true, touchesFrontend: touches, requiredAcs: acs }));
            let ensureAt;
            try { ensureAt = Number(JSON.parse(fs.readFileSync(sessionFile(c), 'utf8')).ensureAt); } catch { ensureAt = NaN; }
            if (!Number.isFinite(ensureAt)) return fail('INVALID_FINDINGS', 'sem sessão de verificação: rode `server ensure` antes de navegar');
            let findings;
            try {
                if (fs.statSync(findingsPath).mtimeMs + 2000 < ensureAt) return fail('STALE_EVIDENCE', 'findings.json é anterior ao último `server ensure` (evidência de rodada anterior)');
                findings = JSON.parse(fs.readFileSync(findingsPath, 'utf8'));
            } catch (e) { return fail('INVALID_FINDINGS', `findings.json ilegível: ${e.message}`); }
            return write(verdict({ enabled: true, touchesFrontend: true, requiredAcs: acs, findings, exists: screenshotOk(c, ensureAt), appOrigins: c.origins }));
        }
        out.error('uso: ui-verify.js server ensure|stop | touches <base> | verdict <findings.json> --base <base> --acs AC-1,AC-2|none');
        return 2;
    } catch (e) {
        out.error(e.message);
        return 2;
    }
}

module.exports = { cfg, probe, serverEnsure, serverStop, changedFiles, main, psInfo };
if (require.main === module) main(process.argv.slice(2)).then(code => { process.exitCode = code; });
