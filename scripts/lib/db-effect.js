// Efeito externo governado "db-effect": execução, autorizada por aprovador humano, de
// um artefato SQL (pending_authorization kind=db_migration) num banco compartilhado.
// Quem chama é scripts/lib/authorization.js, e só a partir da cópia CONGELADA na
// aprovação (dashboard, aprovador autenticado). Sem CLI de execução.
//
// Modelo de ameaça (revisão de segurança da PRI-180): agente malicioso/alucinado
// rodando como o MESMO usuário do SO, que escreve no worktree, no state.json e no .env
// do consumidor. Por isso:
// - Allowlist SÓ em ~/.config/prisma/db-targets.json (scripts/lib/prisma-config.js:
//   dono = usuário, sem escrita para grupo/outros, sem symlink). Nada de env/.env.
// - Segredo SÓ no Keychain, no serviço amarrado ao alias (prisma-db-<alias>, conta =
//   alias), criado com ACL vazia (-T ''): cada leitura pede confirmação do macOS.
//   Quem lê é o processo filho (db-exec-child.js), por /usr/bin/security (caminho
//   absoluto), no momento da execução. O dashboard nunca vê a senha.
// - Execução pelo driver `pg` no filho, NÃO pelo psql: sem meta-comandos (\! etc.),
//   um statement por mensagem do protocolo estendido (o servidor recusa mais de um),
//   transação aberta e fechada pelo Node. verify_sql numa conexão com
//   default_transaction_read_only=on + BEGIN READ ONLY + ROLLBACK. Timeouts fixos na
//   própria conexão (startup options), que valem mesmo se algo escapar das checagens.
// - Checagens pelo tokenizer (scripts/lib/sql-lexer.js), não por regex no texto:
//   artefato sem controle de transação, sem SET/RESET de *_timeout/role/sessão, sem
//   set_config, sem comandos fora de transação; verify com UM statement só leitura.
// - Saídas sem segredo, usuário, host nem nome do banco.
// - Attempt DOM06 por execução (node "db-effect"), chave de idempotência
//   db-apply:<id>:<sha>:<alias>; desfecho incerto (COMMIT enviado e conexão caiu) fica
//   UNCERTAIN e nunca é repetido sozinho.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const dom06 = require('./dom06-attempt');
const prismaConfig = require('./prisma-config');
const { tokenize, words, SqlLexError } = require('./sql-lexer');

const ALIAS_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/i;
const LOCK_TIMEOUT_MS = 5000;
const STATEMENT_TIMEOUT_MS = 60000;
const LOCK_TIMEOUT = '5s';
const STATEMENT_TIMEOUT = '60s';
// Orçamento do filho (conexão + verify + aplicação + verify) e prazo duro do pai.
const CHILD_BUDGET_MS = 150_000;
// Pai: até 120 s para o humano confirmar o diálogo do Keychain + o orçamento do filho.
const PARENT_TIMEOUT_MS = 300_000;
// Maior artefato aceito: a tela mostra o SQL INTEGRAL; acima disso bloqueia, não trunca.
const MAX_SQL_BYTES = 200_000;
const TARGETS_FILE = 'db-targets.json';
const DEFAULT_SECURITY_BIN = '/usr/bin/security';
const CHILD_SCRIPT = path.join(__dirname, 'db-exec-child.js');

function sha256(text) {
    return crypto.createHash('sha256').update(text).digest('hex');
}

// prod/prd/live em qualquer parte do env ("qa-prod", "live", "PRD") conta como produção.
function isProductionEntry(entry) {
    return entry.production === true || /(prod|prd|live)/i.test(String(entry.env || ''));
}

function keychainService(alias) {
    return `prisma-db-${alias}`;
}

// ── Allowlist (~/.config/prisma/db-targets.json) ─────────────────────────────────

function validateEntry(alias, entry) {
    const errors = [];
    if (!ALIAS_RE.test(alias)) errors.push(`alias "${alias}" inválido`);
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return [`${alias}: entrada precisa ser objeto`];
    for (const k of ['host', 'database', 'user', 'env']) {
        if (typeof entry[k] !== 'string' || !entry[k].trim()) errors.push(`${alias}: "${k}" obrigatório`);
    }
    if (entry.port !== undefined && !(Number.isInteger(entry.port) && entry.port > 0 && entry.port < 65536)) errors.push(`${alias}: "port" inválida`);
    if (Object.keys(entry).some(k => /^pass(word|wd)?$|^pwd$|connection|dsn|url$|password_env/i.test(k))) {
        errors.push(`${alias}: senha/connection string/variável de senha não vão na allowlist — o segredo fica só no Keychain (prisma-db-${alias})`);
    }
    // O serviço do Keychain é derivado do alias: a entrada não escolhe de onde ler.
    const s = entry.secret;
    if (!s || typeof s !== 'object' || s.keychain !== keychainService(alias) || (s.account !== undefined && s.account !== alias) || Object.keys(s).some(k => !['keychain', 'account'].includes(k))) {
        errors.push(`${alias}: "secret" precisa ser {"keychain": "${keychainService(alias)}", "account": "${alias}"} (fallback por env foi removido)`);
    }
    if (entry.display !== undefined && !['masked', 'visible'].includes(entry.display)) errors.push(`${alias}: "display" é masked ou visible`);
    if (entry.sslmode !== undefined && !['disable', 'require', 'verify-full'].includes(entry.sslmode)) errors.push(`${alias}: "sslmode" é disable, require ou verify-full`);
    return errors;
}

/** @returns {{ targets: object|null, error: string|null, code: string|null }} */
function loadTargets({ configDir = null } = {}) {
    let parsed;
    try { parsed = prismaConfig.readSecureJson(TARGETS_FILE, { dir: configDir }); } catch (e) {
        return { targets: null, code: e.code || 'CONFIG_INVALID', error: `allowlist recusada: ${e.message}` };
    }
    if (parsed == null) return { targets: null, code: 'NO_ALLOWLIST', error: 'nenhuma allowlist de bancos em ~/.config/prisma/db-targets.json — cadastre com: node "$PRISMA_ROOT/scripts/lib/db-targets.js" add <alias> ...' };
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { targets: null, code: 'CONFIG_INVALID', error: 'allowlist precisa ser um objeto alias → alvo' };
    const errors = Object.entries(parsed).flatMap(([alias, entry]) => validateEntry(alias, entry));
    if (errors.length) return { targets: null, code: 'CONFIG_INVALID', error: `allowlist inválida: ${errors.join('; ')}` };
    return { targets: parsed, code: null, error: null };
}

/**
 * Alvo que pode ser escolhido/executado (sem segredo nem usuário).
 * @returns {{ ok: true, target, entry } | { ok: false, code, error }}
 */
function resolveTarget(alias, { configDir = null } = {}) {
    const { targets, error, code } = loadTargets({ configDir });
    if (!targets) return { ok: false, code, error };
    if (typeof alias !== 'string' || !alias || !Object.prototype.hasOwnProperty.call(targets, alias)) {
        return { ok: false, code: 'TARGET_NOT_ALLOWED', error: `alvo "${typeof alias === 'string' ? alias.slice(0, 64) : ''}" não está na allowlist — nada foi executado` };
    }
    const entry = targets[alias];
    if (isProductionEntry(entry) && entry.allow_production !== true) {
        return { ok: false, code: 'PRODUCTION_REFUSED', error: `alvo "${alias}" é de produção e a entrada da allowlist não tem allow_production: true — nada foi executado` };
    }
    return { ok: true, entry, target: { alias, label: entry.label || alias, env: entry.env, production: isProductionEntry(entry) } };
}

function mask(v) {
    const s = String(v || '');
    return s.length <= 3 ? '***' : `${s.slice(0, 2)}…${s.slice(-1)}`;
}

/** Lista para o seletor do Aprovar (aprovador autenticado): sem usuário nem segredo. */
function publicTargets({ configDir = null } = {}) {
    const { targets, error } = loadTargets({ configDir });
    if (!targets) return { targets: [], error };
    return {
        error: null,
        targets: Object.entries(targets).map(([alias, entry]) => {
            const r = resolveTarget(alias, { configDir });
            const visible = entry.display === 'visible';
            return {
                alias, label: entry.label || alias, env: entry.env, production: isProductionEntry(entry),
                host: visible ? entry.host : mask(entry.host), database: visible ? entry.database : mask(entry.database),
                selectable: r.ok, reason: r.ok ? null : r.error,
            };
        }),
    };
}

function describeTarget(t) {
    return t ? { alias: t.alias, label: t.label, env: t.env, production: !!t.production } : null;
}

// ── Checagens de SQL (tokenizer) ─────────────────────────────────────────────────

const TX_CONTROL = new Set(['BEGIN', 'COMMIT', 'ROLLBACK', 'END', 'SAVEPOINT', 'RELEASE', 'ABORT', 'START']);
const NON_TX = /^(VACUUM|CHECKPOINT|REINDEX|CLUSTER|COPY|LISTEN|UNLISTEN|NOTIFY|DISCARD|LOAD|IMPORT)$/;
const FORBIDDEN_FUNCS = /^(SET_CONFIG|DBLINK\w*|PG_READ_\w+|PG_LS_DIR|PG_STAT_FILE|LO_IMPORT|LO_EXPORT|PG_TERMINATE_BACKEND|PG_CANCEL_BACKEND|PG_RELOAD_CONF)$/;
// Corpo de função/DO ($...$) é código: procura o proibido no texto todo (conservador).
const DOLLAR_BODY_FORBIDDEN = /\b(COMMIT|ROLLBACK|SAVEPOINT|SET_CONFIG|DBLINK\w*)\b|\b(SET|RESET)\s+(LOCAL\s+|SESSION\s+)?(ROLE|SESSION|ALL|AUTHORIZATION|[a-z_]*timeout|[a-z_]*read_only|standard_conforming_strings)\b/i;

function lex(sql) {
    try { return { ok: true, statements: tokenize(sql).statements }; } catch (e) {
        if (e instanceof SqlLexError) return { ok: false, error: e.message };
        throw e;
    }
}

function setTargetForbidden(w, i) {
    // w[i] é SET/RESET no início do statement; alvo depois de LOCAL/SESSION opcional.
    let j = i + 1;
    if (w[j] === 'LOCAL' || (w[j] === 'SESSION' && w[j + 1] !== 'AUTHORIZATION' && w[j + 1] !== 'CHARACTERISTICS')) j += 1;
    const t = w[j] || '';
    return /_TIMEOUT$|READ_ONLY$/.test(t) || ['ROLE', 'SESSION', 'ALL', 'AUTHORIZATION', 'TRANSACTION', 'STANDARD_CONFORMING_STRINGS', 'DEFAULT_TRANSACTION_ISOLATION'].includes(t);
}

/** Artefato que pode ir dentro da transação única. @returns {string[]} problemas */
function checkArtifactSql(sql) {
    const text = String(sql ?? '');
    if (!text.trim()) return ['artefato vazio'];
    if (Buffer.byteLength(text) > MAX_SQL_BYTES) return [`artefato maior que ${MAX_SQL_BYTES} bytes — divida em pedidos menores (a tela mostra o SQL inteiro)`];
    const lexed = lex(text);
    if (!lexed.ok) return [lexed.error];
    if (!lexed.statements.length) return ['artefato sem nenhum comando'];
    const problems = [];
    lexed.statements.forEach((st, n) => {
        const w = words(st);
        const first = st.tokens[0]?.type === 'word' ? st.tokens[0].upper : null;
        const where = `comando ${n + 1}`;
        if (!first) { problems.push(`${where}: não começa com palavra-chave`); return; }
        if (TX_CONTROL.has(first) || (first === 'PREPARE' && w[1] === 'TRANSACTION')) problems.push(`${where}: controle de transação (${first}) — o Prisma já envolve tudo numa transação única`);
        if ((first === 'SET' || first === 'RESET') && setTargetForbidden(w, 0)) problems.push(`${where}: ${first} de timeout/role/sessão/transação não é permitido`);
        if (first === 'ALTER' && ['SYSTEM', 'ROLE', 'USER', 'DATABASE', 'GROUP'].includes(w[1])) problems.push(`${where}: ALTER ${w[1]} não é permitido`);
        if ((first === 'CREATE' || first === 'DROP') && ['DATABASE', 'TABLESPACE', 'ROLE', 'USER', 'SUBSCRIPTION'].includes(w[1])) problems.push(`${where}: ${first} ${w[1]} não é permitido`);
        if (NON_TX.test(first)) problems.push(`${where}: ${first} não é permitido no artefato`);
        if (w.includes('CONCURRENTLY')) problems.push(`${where}: CONCURRENTLY não roda dentro de transação`);
        if (w.includes('SESSION') && w.includes('AUTHORIZATION')) problems.push(`${where}: SESSION AUTHORIZATION não é permitido`);
        const fn = w.find(x => FORBIDDEN_FUNCS.test(x));
        if (fn) problems.push(`${where}: ${fn.toLowerCase()} não é permitido`);
        for (const t of st.tokens) if (t.type === 'dollar' && DOLLAR_BODY_FORBIDDEN.test(t.value)) problems.push(`${where}: corpo $...$ com controle de transação/SET de timeout/role/set_config — não é permitido`);
    });
    return [...new Set(problems)];
}

const VERIFY_FIRST = new Set(['SELECT', 'WITH', 'SHOW', 'TABLE', 'VALUES', 'EXPLAIN']);
const VERIFY_FORBIDDEN = new Set(['INSERT', 'UPDATE', 'DELETE', 'MERGE', 'TRUNCATE', 'ALTER', 'CREATE', 'DROP', 'GRANT', 'REVOKE', 'COMMENT', 'COPY',
    'CALL', 'DO', 'LOCK', 'SET', 'RESET', 'BEGIN', 'COMMIT', 'ROLLBACK', 'SAVEPOINT', 'RELEASE', 'ANALYZE', 'INTO', 'PREPARE', 'EXECUTE', 'LISTEN', 'NOTIFY', 'VACUUM']);

/** verify_sql: um statement só leitura. O banco reforça (read-only). @returns {string[]} */
function checkVerifySql(sql) {
    const text = String(sql ?? '');
    if (!text.trim()) return ['verify_sql vazio'];
    if (text.length > 10_000) return ['verify_sql grande demais'];
    const lexed = lex(text);
    if (!lexed.ok) return [lexed.error];
    if (lexed.statements.length !== 1) return [`verify_sql precisa ser UM comando (achei ${lexed.statements.length})`];
    const st = lexed.statements[0];
    const w = words(st);
    const problems = [];
    const first = st.tokens[0]?.type === 'word' ? st.tokens[0].upper : null;
    if (!VERIFY_FIRST.has(first)) problems.push('verify_sql precisa começar com SELECT/WITH/SHOW/TABLE/VALUES/EXPLAIN');
    const bad = w.find(x => VERIFY_FORBIDDEN.has(x) || FORBIDDEN_FUNCS.test(x));
    if (bad) problems.push(`verify_sql precisa ser só leitura (achei ${bad})`);
    if (st.tokens.some(t => t.type === 'dollar')) problems.push('verify_sql não aceita $...$');
    return problems;
}

/** Statements do artefato para execução, um por mensagem (sem o ; final). */
function splitStatements(sql) {
    const lexed = lex(sql);
    if (!lexed.ok) throw new SqlLexError(lexed.error);
    return lexed.statements.map(s => s.text.replace(/;\s*$/, ''));
}

// ── Artefato ─────────────────────────────────────────────────────────────────────

/**
 * Lê o artefato do pedido. Raízes em ordem (worktree do ticket, checkout principal).
 * Caminho absoluto, com .., ou cujo realpath (symlink) sai da raiz é recusado.
 * @returns {{ ok, file?, sql?, sha?, error?, code? }}
 */
function readArtifact(pending, { roots }) {
    const rel = String(pending?.artifact || '');
    if (!rel || path.isAbsolute(rel) || rel.split(/[\\/]/).includes('..')) return { ok: false, code: 'ARTIFACT_INVALID', error: `artifact inválido: "${rel}" (caminho relativo ao repo consumidor, sem ..)` };
    for (const root of roots.filter(Boolean)) {
        let realRoot, real;
        try { realRoot = fs.realpathSync(root); } catch { continue; }
        try { real = fs.realpathSync(path.resolve(root, rel)); } catch { continue; }
        if (!real.startsWith(realRoot + path.sep)) return { ok: false, code: 'ARTIFACT_OUTSIDE_REPO', error: `artifact ${rel} aponta (symlink) para fora do repo — recusado` };
        let st;
        try { st = fs.statSync(real); } catch { continue; }
        if (!st.isFile()) continue;
        if (st.size > MAX_SQL_BYTES) return { ok: false, code: 'ARTIFACT_TOO_LARGE', error: `artifact ${rel} tem ${st.size} bytes (máximo ${MAX_SQL_BYTES}) — a aprovação mostra o SQL inteiro; divida o artefato` };
        const sql = fs.readFileSync(real, 'utf8');
        return { ok: true, file: real, root: realRoot, sql, sha: sha256(sql) };
    }
    return { ok: false, code: 'ARTIFACT_MISSING', error: `artifact ${rel} não encontrado (${roots.filter(Boolean).length} raiz(es) conferida(s))` };
}

// ── Executor (processo filho + pg) ───────────────────────────────────────────────

/**
 * Executor real. run({ mode: 'apply'|'verify', alias, sql, verify_sql }) → resultado do
 * filho: { fatal?: { code, message, certain }, pre?, apply?, post? } (cada passo
 * { ok, text, error, certain?, skipped? }). O pai não passa senha, usuário nem host; o
 * filho resolve tudo pela config segura. Prazo duro do pai: estourou = incerto.
 */
function createChildExecutor({ configDir = null, spawnImpl = spawn, timeoutMs = PARENT_TIMEOUT_MS } = {}) {
    return {
        name: 'pg',
        available() {
            try { require.resolve('pg'); return { ok: true }; } catch { return { ok: false, error: 'dependência `pg` ausente em scripts/ — rode npm ci em scripts/' }; }
        },
        run(job) {
            const childEnv = { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', HOME: prismaConfig.homeDir() };
            return new Promise(resolve => {
                let stdout = '', done = false, timedOut = false;
                let child;
                try {
                    child = spawnImpl(process.execPath, [CHILD_SCRIPT], { env: childEnv, stdio: ['pipe', 'pipe', 'ignore'] });
                } catch (e) {
                    resolve({ fatal: { code: 'SPAWN_FAILED', message: String(e.code || e.message), certain: true } });
                    return;
                }
                const timer = setTimeout(() => { timedOut = true; try { child.kill('SIGKILL'); } catch { /* saiu */ } }, timeoutMs);
                const finish = res => { if (done) return; done = true; clearTimeout(timer); resolve(res); };
                child.stdout.on('data', d => { if (stdout.length < 4 * MAX_SQL_BYTES) stdout += d; });
                child.on('error', e => finish({ fatal: { code: 'SPAWN_FAILED', message: String(e.code || e.message), certain: true } }));
                child.on('close', () => {
                    let out = null;
                    try { out = JSON.parse(stdout); } catch { /* sem JSON */ }
                    if (out && typeof out === 'object') return finish(out);
                    // Sem resposta legível do filho: se chegou a aplicar, não dá pra saber.
                    finish({ fatal: { code: timedOut ? 'CHILD_TIMEOUT' : 'CHILD_NO_RESULT', message: timedOut ? 'executor excedeu o prazo' : 'executor saiu sem resultado', certain: job.mode !== 'apply' } });
                });
                child.stdin.on('error', () => { /* filho saiu antes */ });
                child.stdin.end(JSON.stringify({ ...job, configDir, budget_ms: CHILD_BUDGET_MS }));
            });
        },
    };
}

// ── Saídas ───────────────────────────────────────────────────────────────────────

// Defesa em profundidade: o filho já esconde; o pai esconde de novo o que sabe da entrada.
function scrubber(entry) {
    const hide = [entry?.user, entry?.host, entry?.database].filter(v => typeof v === 'string' && v.length >= 3).sort((a, b) => b.length - a.length);
    return text => hide.reduce((out, v) => out.split(v).join('***'), String(text ?? ''))
        .replace(/(password\s*[=:]\s*)\S+/gi, '$1***');
}

function writeOut(dir, name, content) {
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, name);
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, content);
    fs.renameSync(tmp, file);
    return file;
}

function stepText(label, step, scrub) {
    return [`# ${label}`, `ok: ${!!step?.ok}${step?.skipped ? ' (não executado)' : ''}`, '', '## saída', scrub(step?.text || ''), '', '## erro', scrub(step?.error || ''), ''].join('\n');
}

function attemptsFulfilled(runDir, key) {
    return dom06.listAttempts(runDir).some(a => (a.effects || []).some(e => e.idempotency_key === key && e.status === 'fulfilled'));
}

/**
 * Execução a partir do job congelado na aprovação.
 * @param {object} p
 * @param {string} p.runDir
 * @param {object} p.job  { id, artifact, artifact_sha256, sql?, verify_sql, expected_contains?, target_alias }
 * @param {'apply'|'verify'} [p.mode]
 * @returns {Promise<object>} outcome: applied | verified | failed | uncertain | refused
 */
async function run({ runDir, job, executor = null, configDir = null, mode = 'apply', now = () => new Date().toISOString() }) {
    const outDir = path.join(runDir, 'authorization', String(job.id));
    const alias = job.target_alias;
    const result = {
        authorization_id: job.id, mode, started_at: now(), finished_at: null, ok: false, outcome: 'refused', code: null, error: null,
        artifact: job.artifact, artifact_sha256: job.artifact_sha256, target: null, steps: {}, attempt_id: null, verify_matched: null,
    };
    let scrub = scrubber(null);
    const finish = () => {
        result.finished_at = now();
        if (result.error) result.error = scrub(result.error);
        writeOut(outDir, mode === 'verify' ? 'manual-result.json' : 'result.json', `${JSON.stringify(result, null, 2)}\n`);
        return { ...result, outputs: path.relative(runDir, outDir) };
    };
    const refuse = (code, error) => { result.code = code; result.error = error; result.outcome = 'refused'; return finish(); };

    const resolved = resolveTarget(alias, { configDir });
    if (!resolved.ok) return refuse(resolved.code, resolved.error);
    scrub = scrubber(resolved.entry);
    result.target = describeTarget(resolved.target);

    const verifyProblems = checkVerifySql(job.verify_sql);
    if (verifyProblems.length) return refuse('VERIFY_SQL_INVALID', verifyProblems.join('; '));
    if (mode === 'apply') {
        if (typeof job.sql !== 'string' || sha256(job.sql) !== job.artifact_sha256) return refuse('ARTIFACT_CHANGED', 'o SQL congelado não confere com o sha256 aprovado — nada foi executado');
        const problems = checkArtifactSql(job.sql);
        if (problems.length) return refuse('ARTIFACT_SQL_REFUSED', problems.join('; '));
    }
    const applyKey = `db-apply:${job.id}:${job.artifact_sha256}:${alias}`;
    if (mode === 'apply' && attemptsFulfilled(runDir, applyKey)) {
        return refuse('ALREADY_APPLIED', `pedido ${job.id} já foi aplicado em "${alias}" por um Attempt anterior (mesma chave de idempotência) — não repito`);
    }
    const exec = executor || createChildExecutor({ configDir });
    if (typeof exec.available === 'function') {
        const avail = exec.available();
        if (!avail.ok) return refuse('EXECUTOR_UNAVAILABLE', avail.error);
    }

    const obligations = mode === 'apply' ? [{ id: 'db_pre_verify' }, { id: 'db_apply' }, { id: 'db_post_verify' }] : [{ id: 'db_post_verify' }];
    const decision = dom06.beginAttempt(runDir, {
        node: 'db-effect',
        admission: { status: 'ADMITTED', owner: 'dom06', snapshot: { task_id: path.basename(runDir), authorization_id: job.id, artifact_sha256: job.artifact_sha256, target: alias, mode } },
        obligations,
    });
    const attemptFile = decision.attemptFile;
    result.attempt_id = decision.attempt.attempt_id;
    const auth = dom06.authorizeEffect(dom06.readAttempt(attemptFile), { obligationId: 'db_apply', idempotencyKey: applyKey });
    if (!auth.ok) return refuse(auth.error, `Attempt sem autoridade (${auth.error})`);

    const out = await exec.run({ mode, alias, sql: mode === 'apply' ? job.sql : null, verify_sql: job.verify_sql });
    const matched = step => (job.expected_contains ? String(step?.text || '').includes(job.expected_contains) : null);
    const record = (obligation, key, step) => dom06.recordEffect(attemptFile, {
        obligation_id: obligation, idempotency_key: key, status: step?.ok ? 'fulfilled' : 'failed',
        detail: scrub(step?.ok ? 'ok' : (step?.error || (step?.skipped ? 'não executado' : 'falhou'))).slice(0, 300),
    });

    if (out.fatal) {
        const certain = out.fatal.certain !== false;
        result.outcome = certain ? 'failed' : 'uncertain';
        result.code = certain ? (out.fatal.code || 'EXECUTOR_FAILED') : 'APPLY_UNCERTAIN';
        result.error = certain
            ? `não executado em ${alias}: ${out.fatal.message}`
            : `resultado INCERTO em ${alias} (${out.fatal.message}) — pode ter commitado; confira e use "Já apliquei manualmente" se aplicou. Não repito sozinho.`;
        dom06.recordEffect(attemptFile, { obligation_id: mode === 'apply' ? 'db_apply' : 'db_post_verify', idempotency_key: mode === 'apply' ? applyKey : `db_post_verify:${job.id}:${result.attempt_id}`, status: 'failed', detail: scrub(out.fatal.message).slice(0, 300) });
        if (/^(28P01|28000|SECRET_\w+)$/.test(String(out.fatal.code))) dom06.revoke(attemptFile, { reason: 'db_auth' });
        dom06.closeAttempt(attemptFile, { result: certain ? 'FAILED' : 'UNCERTAIN', reason: result.code });
        return finish();
    }

    if (mode === 'verify') {
        writeOut(outDir, 'manual-post.txt', stepText(`db_post_verify (${alias}) — ${now()}`, out.post, scrub));
        record('db_post_verify', `db_post_verify:${job.id}:${result.attempt_id}`, out.post);
        result.steps.db_post_verify = { ok: !!out.post?.ok, file: 'manual-post.txt' };
        result.verify_matched = matched(out.post);
        if (!out.post?.ok) { result.outcome = 'failed'; result.code = 'VERIFY_FAILED'; result.error = `verify_sql falhou em ${alias}: ${out.post?.error || '?'}`; }
        else if (result.verify_matched === false) { result.outcome = 'failed'; result.code = 'VERIFY_MISMATCH'; result.error = `a verificação não mostrou o esperado ("${job.expected_contains}") — ver authorization/${job.id}/manual-post.txt`; }
        else { result.ok = true; result.outcome = 'verified'; }
        dom06.closeAttempt(attemptFile, { result: result.ok ? 'COMPLETE' : 'FAILED', reason: result.code });
        return finish();
    }

    writeOut(outDir, 'pre.txt', stepText(`db_pre_verify (${alias}) — ${now()}`, out.pre, scrub));
    writeOut(outDir, 'apply.txt', stepText(`db_apply ${job.artifact} (${alias}) — ${now()}`, out.apply, scrub));
    writeOut(outDir, 'post.txt', stepText(`db_post_verify (${alias}) — ${now()}`, out.post, scrub));
    record('db_pre_verify', `db_pre_verify:${job.id}:${result.attempt_id}`, out.pre);
    if (out.apply && !out.apply.skipped) record('db_apply', applyKey, out.apply);
    if (out.post && !out.post.skipped) record('db_post_verify', `db_post_verify:${job.id}:${result.attempt_id}`, out.post);
    result.steps = { db_pre_verify: { ok: !!out.pre?.ok }, db_apply: { ok: !!out.apply?.ok, skipped: !!out.apply?.skipped, certain: out.apply?.certain !== false }, db_post_verify: { ok: !!out.post?.ok } };

    if (!out.pre?.ok) {
        result.outcome = 'failed'; result.code = 'PRE_VERIFY_FAILED';
        result.error = `verify_sql (antes) falhou em ${alias} — SQL NÃO aplicado: ${out.pre?.error || '?'}`;
    } else if (!out.apply?.ok) {
        if (out.apply?.certain === false) {
            result.outcome = 'uncertain'; result.code = 'APPLY_UNCERTAIN';
            result.error = `resultado INCERTO aplicando ${job.artifact} em ${alias} (${out.apply?.error || '?'}) — o COMMIT saiu e a conexão caiu; confira e use "Já apliquei manualmente" se aplicou. Não repito sozinho.`;
        } else {
            result.outcome = 'failed'; result.code = 'APPLY_FAILED';
            result.error = `SQL falhou e a transação foi desfeita em ${alias}: ${out.apply?.error || '?'}`;
        }
        if (/28P01|28000|42501/.test(out.apply?.error || '')) dom06.revoke(attemptFile, { reason: 'db_auth' });
    } else if (!out.post?.ok) {
        result.outcome = 'failed'; result.code = 'POST_VERIFY_FAILED';
        result.error = `SQL aplicado (COMMIT ok), mas o verify_sql de depois falhou em ${alias} — confira à mão antes de seguir`;
    } else {
        result.verify_matched = matched(out.post);
        if (result.verify_matched === false) {
            result.outcome = 'failed'; result.code = 'VERIFY_MISMATCH';
            result.error = `SQL aplicado (COMMIT ok), mas a verificação de depois não mostrou o esperado ("${job.expected_contains}") — ver authorization/${job.id}/post.txt`;
        } else { result.ok = true; result.outcome = 'applied'; }
    }
    dom06.closeAttempt(attemptFile, { result: result.ok ? 'COMPLETE' : result.outcome === 'uncertain' ? 'UNCERTAIN' : 'FAILED', reason: result.code });
    return finish();
}

module.exports = {
    LOCK_TIMEOUT, STATEMENT_TIMEOUT, LOCK_TIMEOUT_MS, STATEMENT_TIMEOUT_MS, MAX_SQL_BYTES, ALIAS_RE, TARGETS_FILE, DEFAULT_SECURITY_BIN, CHILD_BUDGET_MS,
    sha256, keychainService, validateEntry, loadTargets, resolveTarget, publicTargets, describeTarget, isProductionEntry,
    checkArtifactSql, checkVerifySql, splitStatements, readArtifact, createChildExecutor, scrubber, run,
};
