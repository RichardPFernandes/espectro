// Efeito externo governado "db-effect": execução, autorizada por humano, de um artefato
// SQL (pending_authorization kind=db_migration) num banco compartilhado. Quem chama é
// scripts/lib/authorization.js, e só depois de um "Aprovar"/"Já apliquei manualmente"
// autenticado pelos endpoints do dashboard. Este módulo deliberadamente NÃO tem CLI de
// execução: nada que um agente rode no shell aplica SQL (ver docs/runbook.md,
// "Autorização humana").
//
// Garantias:
// - Alvo só por allowlist explícita do consumidor (arquivo JSON, gerido pela CLI
//   scripts/lib/db-targets.js; ou PRISMA_DB_TARGETS inline). O alvo NÃO vem do agente:
//   quem aprova escolhe o alias na tela. Alias fora da lista = erro, nada executa.
//   Entrada de produção (production: true ou env "prod*") exige allow_production: true.
// - Segredo: a entrada guarda só a REFERÊNCIA — Keychain do macOS (padrão,
//   "prisma-db-<alias>") ou, como fallback documentado, o nome de uma variável
//   PRISMA_DB_*_PASSWORD. Quem lê o segredo é o processo filho (db-exec-child.js), no
//   momento da execução; o dashboard nunca o tem em memória (no caso Keychain). Usuário,
//   host e senha vão ao psql por PGUSER/PGHOST/PGPASSWORD no env do filho — nunca em
//   argv, log, state.json, saída gravada ou resposta HTTP.
// - artifact_sha256 conferido antes; mudou = aborta antes de conectar.
// - verify_sql roda antes e depois, em transação READ ONLY.
// - O artefato roda em transação única: BEGIN; SET LOCAL lock_timeout='5s';
//   SET LOCAL statement_timeout='60s'; <sql>; COMMIT; com ON_ERROR_STOP. Artefato que
//   controla a própria transação ou usa meta-comando do psql é recusado.
// - Cada execução é um Attempt DOM06 (scripts/lib/dom06-attempt.js, node "db-effect"):
//   pré-verificação, aplicação e pós-verificação viram effects; a aplicação tem chave de
//   idempotência db-apply:<id>:<sha>:<alias> e, cumprida em qualquer Attempt do run, não
//   roda de novo. Desfecho incerto (conexão caiu, timeout) fica UNCERTAIN e nunca é
//   repetido sozinho.
//
// Executor: psql (PRISMA_PSQL_BIN ou PATH). O repo não depende de `pg` e este fluxo não
// adiciona dependência npm; sem psql, erro claro pedindo `brew install libpq`. Testes
// injetam um executor falso (nenhum teste conecta em banco).

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const dom06 = require('./dom06-attempt');

const ALIAS_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/i;
const PASSWORD_ENV_RE = /^PRISMA_DB_[A-Z0-9_]*PASSWORD$/;
const KEYCHAIN_SERVICE_RE = /^prisma-db-[a-z0-9._-]{1,64}$/i;
const LOCK_TIMEOUT = '5s';
const STATEMENT_TIMEOUT = '60s';
// Prazo do processo inteiro (conexão + verify + aplicação). Estourou = UNCERTAIN.
const PROCESS_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_CHARS = 200_000;
const PSQL_MISSING = 'psql não encontrado — instale libpq (brew install libpq) e aponte PRISMA_PSQL_BIN para o binário (ex.: /opt/homebrew/opt/libpq/bin/psql).';
// Saída do db-exec-child quando ELE falha antes de rodar o psql (nada executou).
const CHILD_NOT_RUN_EXIT = 64;
const CHILD_SCRIPT = path.join(__dirname, 'db-exec-child.js');

function sha256(text) {
    return crypto.createHash('sha256').update(text).digest('hex');
}

function isProductionEntry(entry) {
    return entry.production === true || /^prod/i.test(String(entry.env || ''));
}

function keychainService(alias) {
    return `prisma-db-${alias}`;
}

// ── Allowlist ────────────────────────────────────────────────────────────────────

/** Arquivo padrão da allowlist: fora de qualquer repo (não vai pro git por engano). */
function defaultTargetsFile(env = process.env) {
    return path.join(env.HOME || os.homedir(), '.config', 'prisma', 'db-targets.json');
}

function targetsFile(env = process.env, { consumerRoot = env.REPO_PATH || process.cwd() } = {}) {
    const raw = String(env.PRISMA_DB_TARGETS_FILE || '').trim();
    return raw ? path.resolve(consumerRoot, raw) : defaultTargetsFile(env);
}

/** Referência ao segredo da entrada: { kind: 'keychain', service } | { kind: 'env', name } | null. */
function secretRef(alias, entry) {
    const s = entry.secret;
    if (s && typeof s === 'object') {
        if (s.keychain) return { kind: 'keychain', service: String(s.keychain), account: s.account ? String(s.account) : null };
        if (s.env) return { kind: 'env', name: String(s.env) };
    }
    if (entry.password_env) return { kind: 'env', name: String(entry.password_env) }; // forma antiga
    return null;
}

function validateEntry(alias, entry) {
    const errors = [];
    if (!ALIAS_RE.test(alias)) errors.push(`alias "${alias}" inválido`);
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return [`${alias}: entrada precisa ser objeto`];
    for (const k of ['host', 'database', 'user', 'env']) {
        if (typeof entry[k] !== 'string' || !entry[k].trim()) errors.push(`${alias}: "${k}" obrigatório`);
    }
    if (entry.port !== undefined && !(Number.isInteger(entry.port) && entry.port > 0 && entry.port < 65536)) errors.push(`${alias}: "port" inválida`);
    if (Object.keys(entry).some(k => /^pass(word|wd)?$|^pwd$|connection|dsn|url$/i.test(k))) {
        errors.push(`${alias}: senha/connection string não vão na allowlist — use "secret": {"keychain": "prisma-db-${alias}"}`);
    }
    const ref = secretRef(alias, entry);
    if (!ref) errors.push(`${alias}: "secret" obrigatório ({"keychain": "prisma-db-${alias}"} ou {"env": "PRISMA_DB_..._PASSWORD"})`);
    else if (ref.kind === 'keychain' && !KEYCHAIN_SERVICE_RE.test(ref.service)) errors.push(`${alias}: secret.keychain precisa ser "prisma-db-<alias>"`);
    else if (ref.kind === 'env' && !PASSWORD_ENV_RE.test(ref.name)) errors.push(`${alias}: secret.env precisa ser o NOME de uma variável PRISMA_DB_..._PASSWORD (nunca a senha)`);
    if (entry.display !== undefined && !['masked', 'visible'].includes(entry.display)) errors.push(`${alias}: "display" é masked ou visible`);
    return errors;
}

/**
 * Allowlist do consumidor: { alias: { label?, host, port?, database, user, env, secret,
 * display?, production?, allow_production?, sslmode? } }. PRISMA_DB_TARGETS (JSON inline)
 * vence; senão o arquivo (PRISMA_DB_TARGETS_FILE, ou ~/.config/prisma/db-targets.json).
 * @returns {{ targets: object|null, error: string|null, source: string|null }}
 */
function loadTargets(env = process.env, opts = {}) {
    let raw = String(env.PRISMA_DB_TARGETS || '').trim();
    let source = raw ? 'PRISMA_DB_TARGETS' : null;
    if (!raw) {
        const file = targetsFile(env, opts);
        if (fs.existsSync(file)) {
            source = 'arquivo da allowlist';
            try { raw = fs.readFileSync(file, 'utf8'); } catch (e) {
                return { targets: null, source, error: `allowlist ilegível (${e.code || e.message})` };
            }
        }
    }
    if (!raw) return { targets: null, source: null, error: 'nenhuma allowlist de bancos configurada — cadastre com: node "$PRISMA_ROOT/scripts/lib/db-targets.js" add <alias> ...' };
    let parsed;
    try { parsed = JSON.parse(raw); } catch { return { targets: null, source, error: `${source} não é JSON válido` }; }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { targets: null, source, error: `${source} precisa ser um objeto alias → alvo` };
    const errors = Object.entries(parsed).flatMap(([alias, entry]) => validateEntry(alias, entry));
    if (errors.length) return { targets: null, source, error: `${source} inválida: ${errors.join('; ')}` };
    return { targets: parsed, source, error: null };
}

/**
 * Alvo que pode ser escolhido/executado. Sem segredo, sem usuário: o dashboard só
 * precisa saber que o alias existe e passa no guard de produção.
 * @returns {{ ok: true, target } | { ok: false, code, error }}
 */
function resolveTarget(alias, env = process.env, opts = {}) {
    const { targets, error } = loadTargets(env, opts);
    if (!targets) return { ok: false, code: 'NO_ALLOWLIST', error };
    if (typeof alias !== 'string' || !alias || !Object.prototype.hasOwnProperty.call(targets, alias)) {
        return { ok: false, code: 'TARGET_NOT_ALLOWED', error: `alvo "${alias || ''}" não está na allowlist — nada foi executado` };
    }
    const entry = targets[alias];
    if (isProductionEntry(entry) && entry.allow_production !== true) {
        return { ok: false, code: 'PRODUCTION_REFUSED', error: `alvo "${alias}" é de produção e a entrada da allowlist não tem allow_production: true — nada foi executado` };
    }
    const ref = secretRef(alias, entry);
    if (ref.kind === 'env' && !String(env[ref.name] || '')) {
        return { ok: false, code: 'SECRET_MISSING', error: `segredo do alvo "${alias}" (variável de ambiente de fallback) ausente no dashboard — nada foi executado` };
    }
    return { ok: true, target: { alias, label: entry.label || alias, env: entry.env, production: isProductionEntry(entry), secret_kind: ref.kind } };
}

function mask(v) {
    const s = String(v || '');
    return s.length <= 3 ? '***' : `${s.slice(0, 2)}…${s.slice(-1)}`;
}

/**
 * Lista para a tela de aprovação (só para aprovador autenticado): alias, rótulo, ambiente
 * e host/banco mascarados (display: "visible" mostra). Nunca usuário, senha ou
 * referência do segredo.
 */
function publicTargets(env = process.env, opts = {}) {
    const { targets, error } = loadTargets(env, opts);
    if (!targets) return { targets: [], error };
    return {
        error: null,
        targets: Object.entries(targets).map(([alias, entry]) => {
            const r = resolveTarget(alias, env, opts);
            const visible = entry.display === 'visible';
            return {
                alias, label: entry.label || alias, env: entry.env, production: isProductionEntry(entry),
                host: visible ? entry.host : mask(entry.host), database: visible ? entry.database : mask(entry.database),
                selectable: r.ok, reason: r.ok ? null : r.error,
            };
        }),
    };
}

// Descrição sem segredo nem usuário (vai pro result.json, notas, dashboard).
function describeTarget(t) {
    return t ? { alias: t.alias, label: t.label, env: t.env, production: !!t.production } : null;
}

// ── SQL ──────────────────────────────────────────────────────────────────────────

// Comentários e literais fora, só pra procurar palavra-chave (não altera o que executa).
function stripSql(sql) {
    return String(sql)
        .replace(/\/\*[\s\S]*?\*\//g, ' ')
        .replace(/--[^\n]*/g, ' ')
        .replace(/\$([A-Za-z_]*)\$[\s\S]*?\$\1\$/g, ' ')
        .replace(/'(?:[^']|'')*'/g, "''");
}

/** Artefato que pode ir dentro da transação única. @returns {string[]} problemas */
function checkArtifactSql(sql) {
    const problems = [];
    if (!String(sql || '').trim()) problems.push('artefato vazio');
    if (/^\s*\\/m.test(String(sql))) problems.push('meta-comando do psql (linha começando com \\) não é permitido');
    const bare = stripSql(sql);
    if (/(^|;)\s*(BEGIN|COMMIT|ROLLBACK|END|START\s+TRANSACTION|SAVEPOINT|RELEASE|ABORT)\b/i.test(bare)) {
        problems.push('o artefato controla a própria transação (BEGIN/COMMIT/ROLLBACK...) — o Prisma já envolve tudo numa transação única');
    }
    if (/\bCONCURRENTLY\b|\bVACUUM\b|\b(CREATE|DROP)\s+DATABASE\b|\bALTER\s+SYSTEM\b/i.test(bare)) {
        problems.push('comando que não roda dentro de transação (CONCURRENTLY, VACUUM, CREATE/DROP DATABASE, ALTER SYSTEM)');
    }
    return problems;
}

/** verify_sql: só leitura. O banco reforça (BEGIN READ ONLY). @returns {string[]} problemas */
function checkVerifySql(sql) {
    const problems = [];
    const bare = stripSql(sql).trim();
    if (!bare) return ['verify_sql vazio'];
    if (/^\s*\\/m.test(String(sql))) problems.push('meta-comando do psql não é permitido em verify_sql');
    if (!/^(SELECT|WITH|SHOW|TABLE|VALUES|EXPLAIN)\b/i.test(bare)) problems.push('verify_sql precisa começar com SELECT/WITH/SHOW/TABLE/VALUES/EXPLAIN');
    if (/\b(INSERT|UPDATE|DELETE|MERGE|TRUNCATE|ALTER|CREATE|DROP|GRANT|REVOKE|COMMENT|COPY|CALL|DO|LOCK|SET|RESET|BEGIN|COMMIT|ROLLBACK)\b/i.test(bare.replace(/^EXPLAIN\b/i, ''))) {
        problems.push('verify_sql precisa ser só leitura (sem DML/DDL/controle de transação)');
    }
    return problems;
}

function terminated(sql) {
    const t = String(sql).replace(/\s+$/, '');
    return /;\s*$/.test(stripSql(t)) ? t : `${t};`;
}

function composeApplyScript(sql) {
    return [
        '\\set ON_ERROR_STOP on',
        'BEGIN;',
        `SET LOCAL lock_timeout = '${LOCK_TIMEOUT}';`,
        `SET LOCAL statement_timeout = '${STATEMENT_TIMEOUT}';`,
        terminated(sql),
        'COMMIT;',
        '',
    ].join('\n');
}

function composeVerifyScript(sql) {
    return [
        '\\set ON_ERROR_STOP on',
        'BEGIN READ ONLY;',
        `SET LOCAL lock_timeout = '${LOCK_TIMEOUT}';`,
        `SET LOCAL statement_timeout = '${STATEMENT_TIMEOUT}';`,
        terminated(sql),
        'ROLLBACK;',
        '',
    ].join('\n');
}

// ── Executor ─────────────────────────────────────────────────────────────────────

function findInPath(name, env) {
    for (const dir of String(env.PATH || '').split(path.delimiter).filter(Boolean)) {
        const candidate = path.join(dir, name);
        try { fs.accessSync(candidate, fs.constants.X_OK); return candidate; } catch { /* próximo */ }
    }
    return null;
}

function resolvePsql(env = process.env) {
    const explicit = String(env.PRISMA_PSQL_BIN || '').trim();
    if (explicit) return fs.existsSync(explicit) ? explicit : null;
    return findInPath('psql', env);
}

/**
 * Executor real: um processo filho (db-exec-child.js) recebe só { alias, script } no
 * stdin, lê allowlist + segredo ele mesmo e roda o psql. O dashboard não passa senha,
 * usuário nem host. run({ script, alias }) → { exitCode, stdout, stderr, timedOut,
 * spawnError }. Ambiente do filho mínimo: nada de tokens do dashboard.
 */
function createChildExecutor({ env = process.env, consumerRoot = env.REPO_PATH || process.cwd(), spawnImpl = spawn, timeoutMs = PROCESS_TIMEOUT_MS } = {}) {
    return {
        name: 'psql',
        available() {
            return resolvePsql(env) ? { ok: true } : { ok: false, error: PSQL_MISSING };
        },
        run({ script, alias }) {
            const childEnv = {
                PATH: env.PATH || '/usr/bin:/bin', HOME: env.HOME || os.homedir(), LANG: 'C.UTF-8', REPO_PATH: consumerRoot,
                ...(env.PRISMA_PSQL_BIN ? { PRISMA_PSQL_BIN: env.PRISMA_PSQL_BIN } : {}),
                ...(env.PRISMA_DB_TARGETS ? { PRISMA_DB_TARGETS: env.PRISMA_DB_TARGETS } : {}),
                ...(env.PRISMA_DB_TARGETS_FILE ? { PRISMA_DB_TARGETS_FILE: env.PRISMA_DB_TARGETS_FILE } : {}),
            };
            // Fallback por env: só a variável do alvo escolhido segue para o filho.
            const loaded = loadTargets(env, { consumerRoot }).targets;
            const ref = loaded?.[alias] ? secretRef(alias, loaded[alias]) : null;
            if (ref?.kind === 'env' && env[ref.name]) childEnv[ref.name] = env[ref.name];
            return new Promise(resolve => {
                let stdout = '', stderr = '', done = false, timedOut = false;
                let child;
                try {
                    child = spawnImpl(process.execPath, [CHILD_SCRIPT], { env: childEnv, stdio: ['pipe', 'pipe', 'pipe'] });
                } catch (e) {
                    resolve({ exitCode: null, stdout: '', stderr: String(e.message || e), spawnError: e.code || 'SPAWN_FAILED', timedOut: false });
                    return;
                }
                const timer = setTimeout(() => { timedOut = true; try { child.kill('SIGTERM'); } catch { /* saiu */ } }, timeoutMs);
                const finish = res => { if (done) return; done = true; clearTimeout(timer); resolve(res); };
                child.stdout.on('data', d => { if (stdout.length < MAX_OUTPUT_CHARS) stdout += d; });
                child.stderr.on('data', d => { if (stderr.length < MAX_OUTPUT_CHARS) stderr += d; });
                child.on('error', e => finish({ exitCode: null, stdout, stderr: `${stderr}${e.message}`, spawnError: e.code || 'SPAWN_FAILED', timedOut }));
                child.on('close', code => finish(code === CHILD_NOT_RUN_EXIT
                    ? { exitCode: null, stdout, stderr, spawnError: 'NOT_RUN', timedOut }
                    : { exitCode: code, stdout, stderr, spawnError: null, timedOut }));
                child.stdin.on('error', () => { /* filho saiu antes de ler */ });
                child.stdin.end(JSON.stringify({ alias, script }));
            });
        },
    };
}

// ── Saídas ───────────────────────────────────────────────────────────────────────

function redact(text) {
    return String(text ?? '').replace(/(password\s*[=:]\s*)\S+/gi, '$1***').replace(/(PGPASSWORD\s*=\s*)\S+/g, '$1***');
}

function writeOut(dir, name, content) {
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, name);
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, content);
    fs.renameSync(tmp, file);
    return file;
}

function stepText(label, res) {
    return [
        `# ${label}`,
        `exit_code: ${res.exitCode ?? 'null'}${res.timedOut ? ' (timeout)' : ''}${res.spawnError ? ` (não executou: ${res.spawnError})` : ''}`,
        '',
        '## stdout',
        redact(res.stdout || ''),
        '',
        '## stderr',
        redact(res.stderr || ''),
        '',
    ].join('\n');
}

// psql: 0 ok; 3 erro de script com ON_ERROR_STOP (antes do COMMIT, ou o próprio COMMIT
// falhou → rollback): certo que não aplicou; filho/spawn falhou: nada rodou. Conexão
// caída (2), código 1 ou timeout no meio: pode ter commitado — UNCERTAIN.
function classify(res, { applying }) {
    if (res.spawnError) return 'not_run';
    if (res.exitCode === 0 && !res.timedOut) return 'ok';
    if (!applying) return 'failed';
    if (res.exitCode === 3 && !res.timedOut) return 'failed';
    return 'uncertain';
}

// Falha de autenticação/permissão do banco = autoridade revogada no Attempt (como 401/403).
function httpLike(res) {
    if (/password authentication failed|permission denied|no pg_hba\.conf entry/i.test(res.stderr || '')) return 403;
    return res.exitCode === 0 && !res.timedOut ? 200 : 500;
}

function attemptsFulfilled(runDir, key) {
    return dom06.listAttempts(runDir).some(a => (a.effects || []).some(e => e.idempotency_key === key && e.status === 'fulfilled'));
}

function lastLine(res) {
    return redact(((res?.stderr || '').trim().split('\n').filter(Boolean).pop()) || (res?.timedOut ? 'timeout' : `exit ${res?.exitCode}`));
}

/**
 * Lê e confere o artefato do pedido. Raízes, em ordem: a do run (worktree do ticket ou
 * checkout principal) e a principal. Caminho absoluto ou com .. é recusado.
 * @returns {{ ok, file?, sql?, sha?, error?, code? }}
 */
function readArtifact(pending, { roots }) {
    const rel = String(pending?.artifact || '');
    if (!rel || path.isAbsolute(rel) || rel.split(/[\\/]/).includes('..')) return { ok: false, code: 'ARTIFACT_INVALID', error: `artifact inválido: "${rel}" (caminho relativo ao repo consumidor, sem ..)` };
    for (const root of roots.filter(Boolean)) {
        const file = path.resolve(root, rel);
        if (!file.startsWith(path.resolve(root) + path.sep)) continue;
        let sql;
        try { sql = fs.readFileSync(file, 'utf8'); } catch { continue; }
        return { ok: true, file, root, sql, sha: sha256(sql) };
    }
    return { ok: false, code: 'ARTIFACT_MISSING', error: `artifact ${rel} não encontrado (${roots.filter(Boolean).length} raiz(es) conferida(s))` };
}

/**
 * Execução completa (pré-verify → aplicação → pós-verify) de um pedido aprovado, no
 * alvo escolhido pelo aprovador (pending.target.alias).
 * @param {object} p
 * @param {string} p.runDir
 * @param {object} p.pending   state.pending_authorization (phase "executing")
 * @param {object} p.env       ambiente do dashboard (allowlist; segredo só no fallback env)
 * @param {object} p.executor  { run({script, alias}), available? } — filho+psql por padrão
 * @param {string[]} p.roots   raízes onde o artifact é procurado
 * @param {'apply'|'verify'} [p.mode]  verify = só a verificação ("Já apliquei manualmente")
 * @returns {Promise<object>} outcome: applied | verified | failed | uncertain | refused
 */
async function run({ runDir, pending, env = process.env, executor = null, roots = [], mode = 'apply', now = () => new Date().toISOString() }) {
    const outDir = path.join(runDir, 'authorization', String(pending.id));
    const alias = pending.target?.alias;
    const result = {
        authorization_id: pending.id, mode, started_at: now(), finished_at: null, ok: false, outcome: 'refused', code: null, error: null,
        artifact: pending.artifact, artifact_sha256: pending.artifact_sha256, target: null, steps: {}, attempt_id: null, verify_matched: null,
    };
    const finish = () => {
        result.finished_at = now();
        writeOut(outDir, mode === 'verify' ? 'manual-result.json' : 'result.json', `${JSON.stringify(result, null, 2)}\n`);
        return { ...result, outputs: path.relative(runDir, outDir) };
    };
    const refuse = (code, error) => { result.code = code; result.error = error; result.outcome = 'refused'; return finish(); };

    const resolved = resolveTarget(alias, env, { consumerRoot: roots[0] });
    if (!resolved.ok) return refuse(resolved.code, resolved.error);
    result.target = describeTarget(resolved.target);

    const verifyProblems = checkVerifySql(pending.verify_sql);
    if (verifyProblems.length) return refuse('VERIFY_SQL_INVALID', verifyProblems.join('; '));
    let artifact = null;
    if (mode === 'apply') {
        artifact = readArtifact(pending, { roots });
        if (!artifact.ok) return refuse(artifact.code, artifact.error);
        if (artifact.sha !== pending.artifact_sha256) {
            return refuse('ARTIFACT_CHANGED', `o conteúdo de ${pending.artifact} mudou depois do pedido (sha256 ${artifact.sha.slice(0, 12)}… ≠ aprovado ${String(pending.artifact_sha256).slice(0, 12)}…) — nada foi executado; peça um novo pedido de autorização`);
        }
        const problems = checkArtifactSql(artifact.sql);
        if (problems.length) return refuse('ARTIFACT_SQL_REFUSED', problems.join('; '));
    }
    const applyKey = `db-apply:${pending.id}:${pending.artifact_sha256}:${alias}`;
    if (mode === 'apply' && attemptsFulfilled(runDir, applyKey)) {
        return refuse('ALREADY_APPLIED', `pedido ${pending.id} já foi aplicado em "${alias}" por um Attempt anterior (mesma chave de idempotência) — não repito`);
    }

    const exec = executor || createChildExecutor({ env, consumerRoot: roots[0] });
    if (typeof exec.available === 'function') {
        const avail = exec.available();
        if (!avail.ok) return refuse('EXECUTOR_UNAVAILABLE', avail.error);
    }

    const decision = dom06.beginAttempt(runDir, {
        node: 'db-effect',
        admission: {
            status: 'ADMITTED', owner: 'dom06',
            snapshot: { task_id: path.basename(runDir), authorization_id: pending.id, artifact_sha256: pending.artifact_sha256, target: alias, mode },
        },
        obligations: mode === 'apply'
            ? [{ id: 'db_pre_verify' }, { id: 'db_apply' }, { id: 'db_post_verify' }]
            : [{ id: 'db_post_verify' }],
    });
    const attemptFile = decision.attemptFile;
    result.attempt_id = decision.attempt.attempt_id;

    const verifyStep = async (name, file) => {
        const res = await exec.run({ script: composeVerifyScript(pending.verify_sql), alias, readOnly: true });
        writeOut(outDir, file, stepText(`${name} (${alias}) — ${now()}`, res));
        const status = classify(res, { applying: false });
        dom06.recordEffect(attemptFile, {
            obligation_id: name, idempotency_key: `${name}:${pending.id}:${result.attempt_id}`,
            status: status === 'ok' ? 'fulfilled' : 'failed', detail: status === 'ok' ? file : lastLine(res).slice(0, 300),
        });
        result.steps[name] = { exit_code: res.exitCode, status, file };
        return { res, status };
    };
    const matched = res => (pending.expected_contains ? String(res.stdout || '').includes(pending.expected_contains) : null);

    if (mode === 'verify') {
        const post = await verifyStep('db_post_verify', 'manual-post.txt');
        result.verify_matched = matched(post.res);
        if (post.status !== 'ok') {
            result.outcome = 'failed'; result.code = 'VERIFY_FAILED';
            result.error = `verify_sql falhou em ${alias}: ${lastLine(post.res)}`;
        } else if (result.verify_matched === false) {
            result.outcome = 'failed'; result.code = 'VERIFY_MISMATCH';
            result.error = `a verificação não mostrou o esperado ("${pending.expected_contains}") — ver authorization/${pending.id}/manual-post.txt`;
        } else {
            result.ok = true; result.outcome = 'verified';
        }
        dom06.closeAttempt(attemptFile, { result: result.ok ? 'COMPLETE' : 'FAILED', reason: result.code });
        return finish();
    }

    const pre = await verifyStep('db_pre_verify', 'pre.txt');
    if (pre.status !== 'ok') {
        result.outcome = 'failed'; result.code = 'PRE_VERIFY_FAILED';
        result.error = `verify_sql (antes) falhou em ${alias} — SQL NÃO aplicado: ${lastLine(pre.res)}`;
        dom06.closeAttempt(attemptFile, { result: 'FAILED', reason: result.code });
        return finish();
    }

    let applyRes = null;
    const effect = await dom06.applyExternalEffect(attemptFile, {
        obligationId: 'db_apply', idempotencyKey: applyKey,
        perform: async () => {
            applyRes = await exec.run({ script: composeApplyScript(artifact.sql), alias, readOnly: false });
            writeOut(outDir, 'apply.txt', stepText(`db_apply ${pending.artifact} (${alias}) — ${now()}`, applyRes));
            return { status: httpLike(applyRes), ok: classify(applyRes, { applying: true }) === 'ok', detail: classify(applyRes, { applying: true }) };
        },
    });
    const applyStatus = applyRes ? classify(applyRes, { applying: true }) : 'not_run';
    result.steps.db_apply = { exit_code: applyRes?.exitCode ?? null, status: applyStatus, file: 'apply.txt', effect: effect.error || 'ok' };
    if (applyStatus !== 'ok') {
        if (applyStatus === 'uncertain') {
            result.outcome = 'uncertain'; result.code = 'APPLY_UNCERTAIN';
            result.error = `resultado INCERTO aplicando ${pending.artifact} em ${alias} (${lastLine(applyRes)}) — pode ter commitado; confira com o verify_sql e use "Já apliquei manualmente" se aplicou. Não repito sozinho.`;
        } else {
            result.outcome = 'failed'; result.code = applyStatus === 'not_run' ? 'APPLY_NOT_RUN' : 'APPLY_FAILED';
            result.error = applyStatus === 'not_run'
                ? `SQL não executado em ${alias}: ${lastLine(applyRes)}`
                : `SQL falhou e a transação foi desfeita em ${alias}: ${lastLine(applyRes)}`;
        }
        if (applyStatus === 'failed') await verifyStep('db_post_verify', 'post.txt');
        dom06.closeAttempt(attemptFile, { result: applyStatus === 'uncertain' ? 'UNCERTAIN' : 'FAILED', reason: result.code });
        return finish();
    }

    const post = await verifyStep('db_post_verify', 'post.txt');
    result.verify_matched = matched(post.res);
    if (post.status !== 'ok') {
        result.outcome = 'failed'; result.code = 'POST_VERIFY_FAILED';
        result.error = `SQL aplicado (COMMIT ok), mas o verify_sql de depois falhou em ${alias} — confira à mão antes de seguir`;
    } else if (result.verify_matched === false) {
        result.outcome = 'failed'; result.code = 'VERIFY_MISMATCH';
        result.error = `SQL aplicado (COMMIT ok), mas a verificação de depois não mostrou o esperado ("${pending.expected_contains}") — ver authorization/${pending.id}/post.txt`;
    } else {
        result.ok = true; result.outcome = 'applied';
    }
    dom06.closeAttempt(attemptFile, { result: result.ok ? 'COMPLETE' : 'FAILED', reason: result.code });
    return finish();
}

module.exports = {
    LOCK_TIMEOUT, STATEMENT_TIMEOUT, PSQL_MISSING, PASSWORD_ENV_RE, CHILD_NOT_RUN_EXIT, ALIAS_RE,
    sha256, keychainService, defaultTargetsFile, targetsFile, secretRef, validateEntry, loadTargets, resolveTarget, publicTargets, describeTarget, isProductionEntry,
    checkArtifactSql, checkVerifySql, composeApplyScript, composeVerifyScript,
    resolvePsql, findInPath, createChildExecutor, readArtifact, redact, run,
};
