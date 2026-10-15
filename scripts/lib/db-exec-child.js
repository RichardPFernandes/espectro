// Processo filho do db-effect (scripts/lib/db-effect.js createChildExecutor). Único
// ponto que lê o segredo de um alvo da allowlist, e só no momento da execução:
//   stdin  ← { alias, script }  (o dashboard não manda senha, usuário nem host)
//   1. resolve o alias na allowlist (mesmas regras: fora da lista / produção sem
//      allow_production → não executa);
//   2. lê o segredo — Keychain do macOS (`security find-generic-password -s
//      prisma-db-<alias> -w`) ou, no fallback, a variável PRISMA_DB_*_PASSWORD;
//   3. roda o psql com PGHOST/PGPORT/PGDATABASE/PGUSER/PGPASSWORD no env — argv só com
//      flags, sem nenhum dado de conexão —, com o script no stdin;
//   4. devolve stdout/stderr do psql com segredo e usuário trocados por *** e sai com o
//      código do psql. O segredo morre com este processo.
// Falha antes do psql (alvo, segredo, binário): mensagem no stderr e exit 64 — o pai
// trata como "não executou". Sem SQL, sem segredo: não é CLI para humano nem agente.

const { spawn, execFile } = require('child_process');
const dbEffect = require('./db-effect');

const NOT_RUN = dbEffect.CHILD_NOT_RUN_EXIT;

// exitCode (não process.exit): no macOS a escrita em pipe é assíncrona e um exit
// imediato cortaria a saída.
function fail(msg) {
    process.stderr.write(`[db-exec] ${msg}\n`);
    process.exitCode = NOT_RUN;
}

function readStdin() {
    return new Promise(resolve => {
        let raw = '';
        process.stdin.setEncoding('utf8');
        process.stdin.on('data', d => { raw += d; });
        process.stdin.on('end', () => resolve(raw));
    });
}

function readKeychain(ref) {
    const bin = dbEffect.findInPath('security', process.env) || '/usr/bin/security';
    const args = ['find-generic-password', '-s', ref.service, ...(ref.account ? ['-a', ref.account] : []), '-w'];
    return new Promise(resolve => {
        execFile(bin, args, { timeout: 15000, maxBuffer: 64 * 1024 }, (err, stdout) => {
            if (err) return resolve(null);
            resolve(String(stdout).replace(/\r?\n$/, ''));
        });
    });
}

async function main() {
    let req;
    try { req = JSON.parse(await readStdin()); } catch { return fail('entrada inválida'); }
    const r = dbEffect.resolveTarget(req.alias, process.env);
    if (!r.ok) return fail(r.error);
    const entry = dbEffect.loadTargets(process.env).targets[req.alias];
    const ref = dbEffect.secretRef(req.alias, entry);
    const secret = ref.kind === 'keychain' ? await readKeychain(ref) : String(process.env[ref.name] || '');
    if (!secret) {
        return fail(ref.kind === 'keychain'
            ? `segredo do alvo "${req.alias}" não encontrado no Keychain (serviço ${ref.service}) — cadastre com: node "$PRISMA_ROOT/scripts/lib/db-targets.js" secret ${req.alias}`
            : `segredo do alvo "${req.alias}" ausente (variável de fallback)`);
    }
    const psql = dbEffect.resolvePsql(process.env);
    if (!psql) return fail(dbEffect.PSQL_MISSING);
    const env = {
        PATH: process.env.PATH || '/usr/bin:/bin', HOME: process.env.HOME || '', LANG: 'C.UTF-8',
        PGHOST: entry.host, PGPORT: String(entry.port || 5432), PGDATABASE: entry.database, PGUSER: entry.user,
        PGPASSWORD: secret, PGAPPNAME: 'prisma-db-effect', PGCONNECT_TIMEOUT: '10',
        ...(entry.sslmode ? { PGSSLMODE: entry.sslmode } : {}),
    };
    const hide = [secret, entry.user].filter(v => v && v.length >= 2);
    const scrub = text => hide.reduce((out, v) => out.split(v).join('***'), String(text));
    const child = spawn(psql, ['-X', '-q', '-v', 'ON_ERROR_STOP=1', '--no-password', '-f', '-'], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', errOut = '';
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { errOut += d; });
    const stop = () => { try { child.kill('SIGKILL'); } catch { /* saiu */ } };
    process.on('SIGTERM', stop);
    process.on('SIGINT', stop);
    child.on('error', e => fail(`psql não iniciou: ${e.code || e.message}`));
    child.on('close', (code, signal) => {
        process.stdout.write(scrub(out));
        process.stderr.write(scrub(errOut));
        process.exitCode = code == null ? (signal ? 2 : 1) : code;
    });
    child.stdin.on('error', () => { /* psql saiu antes de ler */ });
    child.stdin.end(String(req.script || ''));
}

main().catch(e => fail(e.message));
