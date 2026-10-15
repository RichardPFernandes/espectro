// Aprovadores das ações privilegiadas do dashboard (PRI-180): Aprovar/escolher o banco,
// "Já apliquei manualmente", Recusar e Devolver ao QA exigem nome + senha de um
// aprovador cadastrado. O dashboard não tem login (só escuta em localhost); sem isto,
// qualquer página/visitante que alcançasse a porta aprovaria SQL ou veria os alvos.
//
// Guarda só hash scrypt (sal por aprovador), nunca a senha:
//   PRISMA_APPROVERS (JSON {"nome": "scrypt$..."}) vence; senão o arquivo
//   PRISMA_APPROVERS_FILE (padrão ~/.config/prisma/approvers.json, modo 600).
// Sem aprovador cadastrado o dashboard recusa (fail closed).
//
// Limite conhecido: um processo do MESMO usuário do SO com shell (ex.: agente sem
// sandbox) pode editar esse arquivo. A proteção é contra visitante da página, outro
// usuário da máquina e aprovação por texto; restrinja as permissões do agente para não
// escrever em ~/.config/prisma.
//
// CLI (pede a senha sem eco; nunca aceita a senha em argv):
//   node scripts/lib/approvers.js add <nome>      cadastra/troca a senha
//   node scripts/lib/approvers.js remove <nome>
//   node scripts/lib/approvers.js list
//   node scripts/lib/approvers.js hash <nome>     só imprime a entrada para PRISMA_APPROVERS

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const NAME_RE = /^[\p{L}\w.@-]{1,64}$/u;
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32 };
const MIN_PASSWORD = 10;

function defaultFile(env = process.env) {
    return path.join(env.HOME || os.homedir(), '.config', 'prisma', 'approvers.json');
}
function approversFile(env = process.env) {
    return String(env.PRISMA_APPROVERS_FILE || '').trim() || defaultFile(env);
}

function hashPassword(password, { salt = crypto.randomBytes(16) } = {}) {
    const key = crypto.scryptSync(String(password), salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
    return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${key.toString('base64')}`;
}

function checkHash(password, stored) {
    const m = /^scrypt\$(\d+)\$(\d+)\$(\d+)\$([A-Za-z0-9+/=]+)\$([A-Za-z0-9+/=]+)$/.exec(String(stored || ''));
    if (!m) return false;
    const [, N, r, p, salt, hash] = m;
    const expected = Buffer.from(hash, 'base64');
    let got;
    try {
        got = crypto.scryptSync(String(password), Buffer.from(salt, 'base64'), expected.length, { N: Number(N), r: Number(r), p: Number(p), maxmem: 64 * 1024 * 1024 });
    } catch { return false; }
    return got.length === expected.length && crypto.timingSafeEqual(got, expected);
}

/** @returns {{ approvers: object, source: string|null, error: string|null }} */
function loadApprovers(env = process.env) {
    let raw = String(env.PRISMA_APPROVERS || '').trim();
    let source = raw ? 'PRISMA_APPROVERS' : null;
    if (!raw) {
        const file = approversFile(env);
        if (!fs.existsSync(file)) return { approvers: {}, source: null, error: null };
        source = 'arquivo de aprovadores';
        try { raw = fs.readFileSync(file, 'utf8'); } catch (e) { return { approvers: {}, source, error: `arquivo de aprovadores ilegível (${e.code})` }; }
    }
    try {
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('não é objeto');
        const approvers = {};
        for (const [name, h] of Object.entries(parsed)) if (NAME_RE.test(name) && typeof h === 'string' && h.startsWith('scrypt$')) approvers[name] = h;
        return { approvers, source, error: null };
    } catch {
        return { approvers: {}, source, error: `${source} inválido (esperado JSON {"nome": "scrypt$..."})` };
    }
}

/**
 * Confere nome + senha. code: NO_APPROVERS (nada cadastrado), MISSING (faltou nome/senha),
 * DENIED (não confere). O mesmo trabalho de scrypt para nome inexistente.
 */
function verify(name, password, env = process.env) {
    const { approvers, error } = loadApprovers(env);
    if (error) return { ok: false, code: 'NO_APPROVERS', error };
    if (!Object.keys(approvers).length) return { ok: false, code: 'NO_APPROVERS', error: 'nenhum aprovador cadastrado — rode: node "$PRISMA_ROOT/scripts/lib/approvers.js" add <nome>' };
    if (typeof name !== 'string' || !name.trim() || typeof password !== 'string' || !password) return { ok: false, code: 'MISSING', error: 'informe aprovador e senha de aprovação' };
    const stored = approvers[name.trim()];
    const ok = checkHash(password, stored || 'scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=') && !!stored;
    return ok ? { ok: true, name: name.trim() } : { ok: false, code: 'DENIED', error: 'aprovador ou senha de aprovação não conferem' };
}

function writeFileSecure(file, data) {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(tmp, file);
    fs.chmodSync(file, 0o600);
}

/** Lê uma senha do terminal sem eco (TTY); sem TTY, uma linha do stdin. */
function promptHidden(question, { input = process.stdin, output = process.stderr } = {}) {
    return new Promise((resolve, reject) => {
        output.write(question);
        if (!input.isTTY) {
            let buf = '';
            input.setEncoding('utf8');
            const onData = d => {
                buf += d;
                const i = buf.indexOf('\n');
                if (i !== -1) { input.removeListener('data', onData); input.pause(); output.write('\n'); resolve(buf.slice(0, i).replace(/\r$/, '')); }
            };
            input.on('data', onData);
            input.on('end', () => resolve(buf.replace(/\r?\n$/, '')));
            return;
        }
        let value = '';
        input.setRawMode(true);
        input.resume();
        input.setEncoding('utf8');
        const onData = ch => {
            for (const c of ch) {
                if (c === '\r' || c === '\n') { cleanup(); output.write('\n'); return resolve(value); }
                if (c === '\u0003') { cleanup(); output.write('\n'); return reject(new Error('cancelado')); }
                if (c === '\u007f' || c === '\b') value = value.slice(0, -1);
                else value += c;
            }
        };
        const cleanup = () => { input.setRawMode(false); input.pause(); input.removeListener('data', onData); };
        input.on('data', onData);
    });
}

async function askNewPassword() {
    const a = await promptHidden('Senha de aprovação (não aparece na tela): ');
    if (a.length < MIN_PASSWORD) throw new Error(`a senha precisa ter pelo menos ${MIN_PASSWORD} caracteres`);
    const b = await promptHidden('Repita a senha: ');
    if (a !== b) throw new Error('as senhas não conferem');
    return a;
}

module.exports = { hashPassword, checkHash, loadApprovers, verify, approversFile, promptHidden, writeFileSecure, NAME_RE, MIN_PASSWORD };

if (require.main === module) {
    const [cmd, name] = process.argv.slice(2).filter(a => !a.startsWith('--'));
    const usage = msg => {
        if (msg) console.error(`[approvers] ${msg}`);
        console.error('Uso: node scripts/lib/approvers.js add <nome> | remove <nome> | list | hash <nome>  (a senha é pedida sem eco)');
        process.exit(2);
    };
    (async () => {
        if (process.argv.some(a => /^--(password|senha)/.test(a))) usage('senha não vai em argv: ela é pedida no terminal');
        const file = approversFile();
        const current = () => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; } };
        if (cmd === 'list') {
            const { approvers, source } = loadApprovers();
            console.log(JSON.stringify({ source, approvers: Object.keys(approvers) }, null, 2));
            return;
        }
        if (!name || !NAME_RE.test(name)) usage('nome inválido');
        if (cmd === 'add') {
            const data = current();
            data[name] = hashPassword(await askNewPassword());
            writeFileSecure(file, data);
            console.error(`[approvers] "${name}" cadastrado em ${file} (hash scrypt, modo 600).`);
            return;
        }
        if (cmd === 'hash') {
            console.log(JSON.stringify({ [name]: hashPassword(await askNewPassword()) }));
            return;
        }
        if (cmd === 'remove') {
            const data = current();
            delete data[name];
            writeFileSecure(file, data);
            console.error(`[approvers] "${name}" removido.`);
            return;
        }
        usage();
    })().catch(e => { console.error(`[approvers] ${e.message}`); process.exit(1); });
}
