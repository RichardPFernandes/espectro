// Redação de secrets na saída de processos filhos (agentes despachados pelo
// readmine-watcher.js). A proibição de logar BITBUCKET_API_TOKEN/REDMINE_API_KEY
// existia só em documentação (AGENTS.md, /commit) — nada impedia um agente de
// imprimir o token em stdout e ele ir parar em memory/runs/*.log ou no terminal.
//
// Escopo deliberado: só a saída capturada de processos filhos passa por aqui. Mensagens
// internas do watcher não têm secret e não pagam o custo de varrer a string.
//
// Dois modos de uso:
//   - biblioteca: buildSanitizer() / createSanitizingStream() (watcher em --follow);
//   - filtro CLI: `node sanitize-log.js` lê stdin, escreve stdout redigido (watcher
//     sem --follow, onde o agente sobrevive ao watcher e a redação precisa rodar
//     num processo próprio entre o agente e o arquivo de log).

const { Transform } = require('stream');
const { StringDecoder } = require('string_decoder');

const REDACTED = '[REDACTED]';
// Abaixo disto a substituição vira falso positivo em texto comum (e o valor quase
// certamente não é um token real) — o secret é ignorado, com aviso de configuração.
const MIN_SECRET_LENGTH = 8;

// Secrets conhecidos do orquestrador (ver .env.example).
// NOTIFY_WEBHOOK_URL: o token do Slack/Discord vai no caminho da URL.
const KNOWN_SECRET_VARS = ['BITBUCKET_API_TOKEN', 'REDMINE_API_KEY', 'NOTIFY_WEBHOOK_URL'];
// Rede de segurança pra secrets que chegam no env sem estarem na lista acima (ex: uma
// API key de outra ferramenta exportada na shell que lançou o watcher).
const SECRET_NAME_PATTERN = /(_TOKEN|_API_KEY|_SECRET|_PASSWORD)$/;

// Coleta os valores UMA vez (startup) — não relê o env em tempo de execução.
// Precisa rodar DEPOIS do loadDotEnv() do watcher, senão não enxerga o .env.
function buildSanitizer(env = process.env, { onWarning = msg => console.warn(msg) } = {}) {
    const names = new Set(KNOWN_SECRET_VARS);
    for (const key of Object.keys(env)) {
        if (SECRET_NAME_PATTERN.test(key)) names.add(key);
    }
    const values = new Set();
    for (const name of names) {
        const value = env[name];
        if (!value) continue;
        if (value.length < MIN_SECRET_LENGTH) {
            onWarning(`[config] ${name} muito curto (< ${MIN_SECRET_LENGTH} caracteres) — pode não ser detectado nos logs.`);
            continue;
        }
        values.add(value);
    }
    // Mais longo primeiro: se um secret contém outro, o maior é redigido inteiro.
    const secrets = [...values].sort((a, b) => b.length - a.length);

    function sanitize(str) {
        if (!str || secrets.length === 0) return str;
        let result = String(str);
        for (const secret of secrets) result = result.replaceAll(secret, REDACTED);
        return result;
    }
    sanitize.maxSecretLength = secrets.length ? secrets[0].length : 0;
    return sanitize;
}

// Transform que redige um fluxo de bytes. Um secret pode chegar partido entre dois
// chunks, então os últimos (maxSecretLength - 1) caracteres ficam retidos até o
// próximo chunk (ou o fim do fluxo): um prefixo incompleto de secret nunca é maior
// que isso, logo nunca sai pro destino sem redação.
function createSanitizingStream(sanitize) {
    const hold = Math.max(0, (sanitize.maxSecretLength || 0) - 1);
    const decoder = new StringDecoder('utf8');
    let pending = '';
    return new Transform({
        transform(chunk, _enc, cb) {
            pending = sanitize(pending + decoder.write(chunk));
            if (pending.length <= hold) return cb();
            const out = pending.slice(0, pending.length - hold);
            pending = pending.slice(pending.length - hold);
            cb(null, out);
        },
        flush(cb) {
            const rest = sanitize(pending + decoder.end());
            pending = '';
            cb(null, rest || undefined);
        },
    });
}

let defaultSanitizer = null;
// Atalho: sanitizer construído a partir de process.env na primeira chamada.
function sanitize(str) {
    if (!defaultSanitizer) defaultSanitizer = buildSanitizer();
    return defaultSanitizer(str);
}

// Prefixa cada linha completa com timestamp ISO + prefixo (ex: "[claude]"), pro
// dashboard (memory/runs/log em tempo real) distinguir saída do agente de eventos
// do próprio watcher. Só usado DEPOIS da redação de secrets acima — nunca antes,
// senão um secret partido na fronteira de um chunk poderia vazar parcialmente
// redigido ao cruzar uma quebra de linha formatada por este stream.
function createLinePrefixStream(prefix) {
    const decoder = new StringDecoder('utf8');
    let pending = '';
    const formatLine = line => `${new Date().toISOString()} ${prefix} ${line}\n`;
    return new Transform({
        transform(chunk, _enc, cb) {
            pending += decoder.write(chunk);
            const lines = pending.split('\n');
            pending = lines.pop();
            cb(null, lines.map(formatLine).join(''));
        },
        flush(cb) {
            pending += decoder.end();
            cb(null, pending ? formatLine(pending) : undefined);
        },
    });
}

module.exports = {
    REDACTED, MIN_SECRET_LENGTH, buildSanitizer, createSanitizingStream, sanitize, createLinePrefixStream,
};

if (require.main === module) {
    // Avisos de configuração já saem no startup do watcher — aqui iriam pro log do agente.
    // Filtro do modo detached de spawnAgent (readmine-watcher.js): o agente sobrevive
    // ao watcher, então redação + prefixo de linha rodam aqui, num processo à parte,
    // entre o agente e o arquivo de log (memory/runs/<ticketId>.log).
    const filter = createSanitizingStream(buildSanitizer(process.env, { onWarning: () => {} }));
    const prefixer = createLinePrefixStream('[claude]');
    process.stdin.pipe(filter).pipe(prefixer).pipe(process.stdout);
}
