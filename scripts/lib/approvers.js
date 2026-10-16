// Aprovadores das ações privilegiadas do dashboard (PRI-180): Aprovar/escolher o banco,
// "Já apliquei manualmente", Recusar e Devolver ao QA exigem nome + senha de um
// aprovador cadastrado. O dashboard não tem login (só escuta em localhost); sem isto,
// qualquer página/visitante que alcançasse a porta aprovaria SQL ou veria os alvos.
//
// Guarda só hash scrypt (sal por aprovador), nunca a senha, em
// ~/.config/prisma/approvers.json (scripts/lib/prisma-config.js: dono = usuário, modo
// 600, sem symlink). NÃO lê variável de ambiente nem o .env do consumidor (um agente
// que escreve no .env não se cadastra como aprovador). Sem aprovador o dashboard
// recusa (fail closed). Conferência assíncrona (crypto.scrypt), o mesmo custo para
// nome inexistente.
//
// Limite conhecido: o MESMO usuário do SO pode editar ~/.config/prisma. A proteção é
// contra visitante da página, aprovação por texto e escrita no repo/state/.env; a
// proteção definitiva é rodar o dashboard com outro usuário do SO (docs/runbook.md).
//
// CLI (pede a senha sem eco; nunca aceita a senha em argv):
//   node scripts/lib/approvers.js add <nome>      cadastra/troca a senha
//   node scripts/lib/approvers.js remove <nome>
//   node scripts/lib/approvers.js list

const crypto = require('crypto');
const prismaConfig = require('./prisma-config');

const NAME_RE = /^[\p{L}\w.@-]{1,64}$/u;
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32 };
const MIN_PASSWORD = 10;
const FILE = 'approvers.json';
const DUMMY = `scrypt$16384$8$1$${Buffer.alloc(16).toString('base64')}$${Buffer.alloc(32).toString('base64')}`;

function hashPassword(password, { salt = crypto.randomBytes(16) } = {}) {
    const key = crypto.scryptSync(String(password), salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
    return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${key.toString('base64')}`;
}

function parseHash(stored) {
    const m = /^scrypt\$(\d+)\$(\d+)\$(\d+)\$([A-Za-z0-9+/=]+)\$([A-Za-z0-9+/=]+)$/.exec(String(stored || ''));
    if (!m) return null;
    const N = Number(m[1]), r = Number(m[2]), p = Number(m[3]);
    // Parâmetros fora da faixa = recusado (evita hash plantado que custe minutos de CPU).
    if (N > 1 << 17 || r > 16 || p > 4) return null;
    return { N, r, p, salt: Buffer.from(m[4], 'base64'), hash: Buffer.from(m[5], 'base64') };
}

function checkHash(password, stored) {
    const h = parseHash(stored);
    return new Promise(resolve => {
        const use = h || parseHash(DUMMY);
        crypto.scrypt(String(password), use.salt, use.hash.length, { N: use.N, r: use.r, p: use.p, maxmem: 64 * 1024 * 1024 }, (err, got) => {
            if (err || !h) return resolve(false);
            resolve(got.length === h.hash.length && crypto.timingSafeEqual(got, h.hash));
        });
    });
}

/** @returns {{ approvers: object, error: string|null }} */
function loadApprovers({ configDir = null } = {}) {
    let parsed;
    try { parsed = prismaConfig.readSecureJson(FILE, { dir: configDir }); } catch (e) {
        return { approvers: {}, error: `aprovadores recusados: ${e.message}` };
    }
    if (parsed == null) return { approvers: {}, error: null };
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { approvers: {}, error: 'approvers.json inválido (esperado {"nome": "scrypt$..."})' };
    const approvers = {};
    for (const [name, h] of Object.entries(parsed)) if (NAME_RE.test(name) && parseHash(h)) approvers[name] = h;
    return { approvers, error: null };
}

/**
 * Confere nome + senha. code: NO_APPROVERS (nada cadastrado/config insegura), MISSING
 * (faltou nome/senha), DENIED (não confere).
 */
async function verify(name, password, { configDir = null } = {}) {
    const { approvers, error } = loadApprovers({ configDir });
    if (error) return { ok: false, code: 'NO_APPROVERS', error };
    if (!Object.keys(approvers).length) return { ok: false, code: 'NO_APPROVERS', error: 'nenhum aprovador cadastrado — rode: node "$PRISMA_ROOT/scripts/lib/approvers.js" add <nome>' };
    if (typeof name !== 'string' || !name.trim() || typeof password !== 'string' || !password) return { ok: false, code: 'MISSING', error: 'informe aprovador e senha de aprovação' };
    if (password.length > 1024) return { ok: false, code: 'DENIED', error: 'aprovador ou senha de aprovação não conferem' };
    const stored = Object.prototype.hasOwnProperty.call(approvers, name.trim()) ? approvers[name.trim()] : null;
    const ok = await checkHash(password, stored || DUMMY) && !!stored;
    return ok ? { ok: true, name: name.trim() } : { ok: false, code: 'DENIED', error: 'aprovador ou senha de aprovação não conferem' };
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

module.exports = { hashPassword, checkHash, loadApprovers, verify, promptHidden, NAME_RE, MIN_PASSWORD };

if (require.main === module) {
    const argv = process.argv.slice(2);
    const dirArg = (argv.find(a => a.startsWith('--config-dir=')) || '').slice('--config-dir='.length) || null;
    const [cmd, name] = argv.filter(a => !a.startsWith('--'));
    const usage = msg => {
        if (msg) console.error(`[approvers] ${msg}`);
        console.error('Uso: node scripts/lib/approvers.js add <nome> | remove <nome> | list  (a senha é pedida sem eco; grava em ~/.config/prisma/approvers.json)');
        process.exit(2);
    };
    (async () => {
        if (argv.some(a => /^--(password|senha)/.test(a))) usage('senha não vai em argv: ela é pedida no terminal');
        const current = () => { try { return prismaConfig.readSecureJson(FILE, { dir: dirArg }) || {}; } catch (e) { usage(e.message); return {}; } };
        if (cmd === 'list') {
            console.log(JSON.stringify(Object.keys(loadApprovers({ configDir: dirArg }).approvers), null, 2));
            return;
        }
        if (!name || !NAME_RE.test(name)) usage('nome inválido');
        if (cmd === 'add') {
            const data = current();
            data[name] = hashPassword(await askNewPassword());
            const file = prismaConfig.writeSecureJson(FILE, data, { dir: dirArg });
            console.error(`[approvers] "${name}" cadastrado em ${file} (hash scrypt, modo 600).`);
            return;
        }
        if (cmd === 'remove') {
            const data = current();
            delete data[name];
            prismaConfig.writeSecureJson(FILE, data, { dir: dirArg });
            console.error(`[approvers] "${name}" removido.`);
            return;
        }
        usage();
    })().catch(e => { console.error(`[approvers] ${e.message}`); process.exit(1); });
}
