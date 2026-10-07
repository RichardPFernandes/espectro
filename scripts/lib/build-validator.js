// Validação de build pré-implement: `mvn compile` no worktree do ticket ANTES do
// watcher despachar o nó implement. Sem isto o agente era despachado em cima de uma
// base que já não compilava — gastava a execução inteira tentando entender (ou
// "consertando" por engano) erros que não eram do ticket.
//
// Só compila (compile, nunca test): o objetivo é barato e determinístico — "a base
// compila?" — não validar comportamento. Quem integra no fluxo é o watcher
// (readmine-watcher.js > runPreBuildGate); este módulo só roda e interpreta o Maven.
//
// Uso manual: node scripts/lib/build-validator.js <worktree> [timeoutMs]
const { exec, execFileSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const DEFAULT_TIMEOUT_MS = 120 * 1000;
const MVN_COMMAND = 'mvn compile -q --no-transfer-progress';
const MAX_FALLBACK_ERRORS = 20;
const MAX_BUFFER = 64 * 1024 * 1024;

// PRE_BUILD_TIMEOUT_MS sobrescreve o padrão (120 s). Valor inválido cai no padrão.
function resolveTimeoutMs(env = process.env) {
    const n = Number(env.PRE_BUILD_TIMEOUT_MS);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_TIMEOUT_MS;
}

function skipRequested(env = process.env) {
    return String(env.SKIP_PRE_BUILD_VALIDATION || '').trim().toLowerCase() === 'true';
}

// JDK do build. O watcher herda o JAVA_HOME de quem o lançou — achado ao vivo no
// #43646: shell com JDK 17, pom com maven.compiler.release=25, e o portão acusou
// "release version 25 not supported" como se a base não compilasse. Ordem:
// PRE_BUILD_JAVA_HOME > PREVIEW_JAVA_HOME (o mesmo do preview do dashboard) > o
// herdado, se atende o release do pom > `/usr/libexec/java_home -v <release>` (macOS).
function requiredRelease(worktreePath) {
    let pom = '';
    try { pom = fs.readFileSync(path.join(worktreePath, 'pom.xml'), 'utf8'); } catch { return null; }
    const m = pom.match(/<maven\.compiler\.release>\s*(\d+)\s*</) || pom.match(/<release>\s*(\d+)\s*<\/release>/) ||
        pom.match(/<maven\.compiler\.target>\s*(?:1\.)?(\d+)\s*</);
    return m ? Number(m[1]) : null;
}

// Major do JDK pelo arquivo <JAVA_HOME>/release (JAVA_VERSION="25.0.2" / "1.8.0_482").
function javaMajor(javaHome) {
    try {
        const v = fs.readFileSync(path.join(javaHome, 'release'), 'utf8').match(/JAVA_VERSION="([^"]+)"/)[1];
        const [a, b] = v.split('.').map(Number);
        return a === 1 ? b : a;
    } catch {
        return null;
    }
}

function macJavaHomeFor(version) {
    try {
        return execFileSync('/usr/libexec/java_home', ['-v', String(version)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null;
    } catch {
        return null;
    }
}

function resolveJavaHome(worktreePath, env = process.env, { javaHomeFor = macJavaHomeFor } = {}) {
    const explicit = env.PRE_BUILD_JAVA_HOME || env.PREVIEW_JAVA_HOME;
    if (explicit) return { javaHome: explicit, source: env.PRE_BUILD_JAVA_HOME ? 'PRE_BUILD_JAVA_HOME' : 'PREVIEW_JAVA_HOME' };
    const inherited = env.JAVA_HOME || null;
    const need = requiredRelease(worktreePath);
    if (!need) return { javaHome: inherited, source: 'herdado' };
    const current = inherited ? javaMajor(inherited) : null;
    if (current && current >= need) return { javaHome: inherited, source: 'herdado' };
    const found = javaHomeFor(need);
    if (found) return { javaHome: found, source: `java_home -v ${need}` };
    return { javaHome: inherited, source: 'herdado', warning: `pom exige release ${need} e nenhum JDK ${need} foi encontrado (defina PRE_BUILD_JAVA_HOME)` };
}

function envWithJava(env, javaHome) {
    if (!javaHome) return env;
    return { ...env, JAVA_HOME: javaHome, PATH: `${path.join(javaHome, 'bin')}${path.delimiter}${env.PATH || ''}` };
}

// JDK incompatível com o projeto: problema do AMBIENTE do watcher, nunca da base.
const JDK_MISMATCH_RE = /release version \d+ not supported|invalid (?:target|source) release|Unsupported class file major version|compiled by a more recent version of the Java Runtime/i;

// Formato do maven-compiler-plugin: "[ERROR] /abs/Foo.java:[12,34] mensagem" (coluna
// opcional). As linhas seguintes sem prefixo ("  symbol: ...", "  location: ...")
// detalham o erro — "cannot find symbol" sozinho não diz qual símbolo, então o
// symbol vai junto na mensagem. O Maven repete os mesmos erros no bloco final
// "Failed to execute goal ..." — deduplica por arquivo+linha+mensagem.
const JAVA_ERROR_RE = /^\[ERROR\]\s+(.+?\.java):\[(\d+)(?:,(\d+))?\]\s*(.*)$/;

// O build pode reportar o caminho físico do worktree (ex: /private/var no macOS, onde
// /var é link simbólico), diferente do caminho passado pelo watcher.
function relPath(file, worktreePath) {
    if (!worktreePath || !path.isAbsolute(file)) return file;
    const roots = [worktreePath];
    try { roots.push(fs.realpathSync(worktreePath)); } catch { /* worktree inexistente: só o literal */ }
    for (const root of roots) {
        const rel = path.relative(root, file);
        if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) return rel;
    }
    return file;
}

function parseCompileErrors(output, worktreePath = null) {
    const lines = String(output || '').split(/\r?\n/);
    const seen = new Set();
    const errors = [];
    for (let i = 0; i < lines.length; i++) {
        const m = lines[i].match(JAVA_ERROR_RE);
        if (!m) continue;
        let message = m[4].trim();
        for (let j = i + 1; j < lines.length && /^\s+\S/.test(lines[j]) && !lines[j].startsWith('['); j++) {
            const detail = lines[j].trim();
            if (/^symbol:/.test(detail)) message += ` (${detail.replace(/\s+/g, ' ')})`;
        }
        // Chave sem o detalhe do symbol: o bloco final do Maven repete o erro sem ele.
        const where = `${relPath(m[1], worktreePath)}:${m[2]}`;
        const key = `${where} — ${m[4].trim()}`;
        if (seen.has(key)) continue;
        seen.add(key);
        errors.push(`${where} — ${message}`);
    }
    return errors;
}

// Dependência local desatualizada: todo erro é "cannot find symbol (symbol: class X)" e
// X existe num repo irmão (app-core/mo-entity) — o código está certo, o jar do ~/.m2 é
// que é velho. Achado ao vivo no #43646: FRecalculoOrdemCargaLoteService já estava no
// app-core origin/master, mas o jar local não tinha. Devolve [{cls, repo, ref}] quando
// TODOS os erros se explicam assim; null caso contrário (aí é erro de verdade).
const SIBLING_REFS = ['HEAD', 'origin/master', 'origin/development'];

// -w, não \\b: o git grep -E do macOS ignora \\b (achado no #43646).
function findClassInRepo(repoPath, cls) {
    for (const ref of SIBLING_REFS) {
        try {
            execFileSync('git', ['-C', repoPath, 'grep', '-q', '-w', '-E', `(class|interface|enum|record) ${cls}`, ref, '--', '*.java'],
                { stdio: 'ignore', timeout: 15000 });
            return ref;
        } catch { /* não achou nesse ref (ou ref inexistente) */ }
    }
    return null;
}

function staleDependencies(errors, siblingRepos = [], { findClass = findClassInRepo } = {}) {
    if (!errors.length || !siblingRepos.length) return null;
    const found = [];
    for (const e of errors) {
        const m = e.match(/ — cannot find symbol \(symbol: class (\w+)\)$/);
        if (!m) return null;
        const hit = found.find(f => f.cls === m[1]) || siblingRepos.map(repo => ({ cls: m[1], repo, ref: findClass(repo, m[1]) })).find(h => h.ref);
        if (!hit) return null;
        if (!found.includes(hit)) found.push(hit);
    }
    return found;
}

// Build falhou sem erro de compilação Java reconhecível (dependência não resolvida,
// pom inválido, plugin...): devolve as linhas [ERROR] cruas, sem o ruído de ajuda do
// Maven, pra lista nunca sair vazia num build que falhou.
function fallbackErrors(output) {
    const out = [];
    for (const line of String(output || '').split(/\r?\n/)) {
        const m = line.match(/^\[ERROR\]\s*(.*)$/);
        if (!m) continue;
        const text = m[1].trim();
        if (!text || /^->\s*\[Help/.test(text) || /^(To see the full stack trace|Re-run Maven|For more information|\[Help)/.test(text)) continue;
        if (!out.includes(text)) out.push(text);
        if (out.length >= MAX_FALLBACK_ERRORS) break;
    }
    return out;
}

/**
 * Roda `mvn compile` no worktree e devolve {success, errors, duration}.
 * - errors: "caminho/relativo/Arquivo.java:linha — mensagem" (ou linhas [ERROR] cruas
 *   quando a falha não é de compilação Java). [] quando success.
 * - timedOut / infraError: presentes só quando aplicável. infraError = problema do
 *   ambiente (mvn_not_found, jdk_mismatch, stale_dependency) — não diz nada sobre o código.
 * - javaHome: JDK usado (ver resolveJavaHome).
 * options: { timeoutMs, env, siblingRepos, command, exec, java, findClass } —
 *   siblingRepos: caminhos dos repos irmãos (ver staleDependencies); o resto é pra teste.
 */
function validateBuild(worktreePath, options = {}) {
    const timeoutMs = options.timeoutMs > 0 ? options.timeoutMs : resolveTimeoutMs(options.env || process.env);
    const command = options.command || (options.env || process.env).PRE_BUILD_COMMAND;
    if (!command) {
        return Promise.resolve({
            success: false, configurationError: 'pre_build_unconfigured', duration: 0, javaHome: null,
            errors: ['PRE_BUILD_COMMAND não configurado pelo consumidor'],
        });
    }
    const run = options.exec || exec;
    const java = options.java || resolveJavaHome(worktreePath, options.env || process.env);
    const started = Date.now();
    return new Promise(resolve => {
        run(command, {
            cwd: worktreePath,
            env: envWithJava(options.env || process.env, java.javaHome),
            timeout: timeoutMs,
            killSignal: 'SIGKILL',
            maxBuffer: MAX_BUFFER,
        }, (err, stdout = '', stderr = '') => {
            const duration = Date.now() - started;
            const javaHome = java.javaHome || null;
            if (!err) return resolve({ success: true, errors: [], duration, javaHome });

            const output = `${stdout}\n${stderr}`;
            const jdk = output.split(/\r?\n/).find(l => JDK_MISMATCH_RE.test(l));
            if (jdk) {
                return resolve({
                    success: false, infraError: 'jdk_mismatch', duration, javaHome,
                    errors: [`JDK incompatível com o projeto (JAVA_HOME=${javaHome || 'não definido'}, via ${java.source}): ${jdk.replace(/^\[ERROR\]\s*/, '').trim()}` +
                        (java.warning ? ` — ${java.warning}` : ' — defina PRE_BUILD_JAVA_HOME')],
                });
            }
            if (err.killed || (err.signal && duration >= timeoutMs)) {
                const partial = parseCompileErrors(output, worktreePath);
                return resolve({
                    success: false, timedOut: true, duration, javaHome,
                    errors: [`Timeout: \`${command}\` não terminou em ${Math.round(timeoutMs / 1000)}s (PRE_BUILD_TIMEOUT_MS)`, ...partial],
                });
            }
            if (err.code === 127 || err.code === 'ENOENT' || /mvn: (command )?not found/.test(stderr)) {
                return resolve({ success: false, infraError: 'mvn_not_found', duration, javaHome, errors: [`Maven não encontrado no PATH (\`${command}\`)`] });
            }
            if (err.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
                return resolve({ success: false, duration, javaHome, errors: [...parseCompileErrors(output, worktreePath), 'Saída do Maven excedeu o buffer — lista truncada'] });
            }
            const errors = parseCompileErrors(output, worktreePath);
            const stale = staleDependencies(errors, options.siblingRepos, options);
            if (stale) {
                const repos = [...new Set(stale.map(h => path.basename(h.repo)))];
                return resolve({
                    success: false, infraError: 'stale_dependency', duration, javaHome,
                    errors: [`Dependência local desatualizada: ${stale.map(h => `${h.cls} existe em ${path.basename(h.repo)} (${h.ref})`).join(', ')}, ` +
                        `mas não no jar do ~/.m2 — rode \`mvn install -DskipTests\` em ${repos.join(', ')} e o portão volta a validar.`],
                });
            }
            const fallback = errors.length ? [] : fallbackErrors(output);
            resolve({
                success: false, duration, javaHome,
                errors: errors.length ? errors : fallback.length ? fallback : [`\`${command}\` saiu com código ${err.code ?? '?'} sem mensagem [ERROR]`],
            });
        });
    });
}

// Identidade do conteúdo do worktree: HEAD + diff contra HEAD + untracked, sem
// memory/ (state.json/context.md mudam a cada tick e não afetam a compilação).
// null se o git falhar — aí sempre recompila (nunca prende o ticket por erro de git).
function worktreeFingerprint(worktreePath) {
    try {
        const git = args => execFileSync('git', args, { cwd: worktreePath, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 256 * 1024 * 1024 });
        const scope = ['--', '.', ':(exclude)memory'];
        return crypto.createHash('sha1')
            .update(git(['rev-parse', 'HEAD']))
            .update(git(['diff', 'HEAD', ...scope]))
            .update(git(['ls-files', '--others', '--exclude-standard', ...scope]))
            .digest('hex');
    } catch {
        return null;
    }
}

/**
 * Grava o resultado de validateBuild no state (muta e devolve 'proceed' | 'failed').
 * Única regra de gravação — usada pelo watcher (runPreBuildGate) e pelo botão
 * "Tentar de novo" do dashboard (POST /api/runs/:taskId/pre-build/retry).
 * Ambiente (infraError) não é veredito sobre o código: vira skipped com o motivo.
 */
function applyResult(state, result, { fingerprint = null, now = new Date().toISOString(), source = null } = {}) {
    state.preBuildAt = now;
    state.preBuildDurationMs = result.duration;
    state.preBuildJavaHome = result.javaHome || null;
    state.updated_at = now;
    delete state.preBuildSkipReason;
    if (result.success || result.infraError) {
        state.preBuildStatus = result.success ? 'passed' : 'skipped';
        if (!result.success) state.preBuildSkipReason = result.errors.join('; ');
        delete state.preBuildErrors;
        delete state.preBuildFingerprint;
        if (state.status === 'pre-build-failed') state.status = 'in_progress';
        return 'proceed';
    }
    state.status = 'pre-build-failed';
    state.preBuildStatus = 'failed';
    state.preBuildErrors = result.errors;
    if (fingerprint) state.preBuildFingerprint = fingerprint;
    else delete state.preBuildFingerprint; // sem git: sempre recompila no próximo tick
    delete state.preBuildAccepted;
    state.events = [...(Array.isArray(state.events) ? state.events : []), {
        type: 'pre_build_failed', node: 'implement', at: now,
        detail: `${result.errors.length} erro(s) em ${Math.round(result.duration / 1000)}s${result.timedOut ? ' (timeout)' : ''}${source ? ` — ${source}` : ''}`,
    }];
    return 'failed';
}

module.exports = {
    worktreeFingerprint, applyResult,
    validateBuild, parseCompileErrors, fallbackErrors, resolveTimeoutMs, skipRequested,
    resolveJavaHome, requiredRelease, javaMajor, staleDependencies,
    DEFAULT_TIMEOUT_MS, MVN_COMMAND,
};

if (require.main === module) {
    const [worktree = process.cwd(), timeout] = process.argv.slice(2);
    validateBuild(path.resolve(worktree), { timeoutMs: Number(timeout) || undefined }).then(r => {
        console.log(JSON.stringify(r, null, 2));
        process.exit(r.success ? 0 : 1);
    });
}
