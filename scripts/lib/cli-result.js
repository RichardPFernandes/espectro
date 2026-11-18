// PRI-381 (F1.5): custo do nó pelo JSON da CLI (`--output-format json`), atrás de
// WATCHER_CLI_RESULT_JSON (desligada por padrão; ver docs/flags.md). Funções puras, sem
// estado: ler o objeto `type: "result"` do log, achar a versão da CLI no transcript e o
// hash dos templates dos nós. Ausente ou ilegível vira null ou 'UNKNOWN', nunca zero.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

function cliResultJsonEnabled(env = process.env) {
    const mode = (env.WATCHER_CLI_RESULT_JSON || 'off').toLowerCase();
    if (!['on', 'off'].includes(mode)) {
        throw new Error(`WATCHER_CLI_RESULT_JSON deve ser on ou off (veio "${env.WATCHER_CLI_RESULT_JSON}")`);
    }
    return mode === 'on';
}

function parseJson(text) {
    try { return JSON.parse(text); } catch { return null; }
}

const orNull = v => (v === undefined ? null : v);

function parseCliResult(text, sessionId) {
    if (typeof text !== 'string' || !sessionId) return null;
    const lines = text.split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i].trim().replace(/^\[claude\] /, '');
        if (!line.startsWith('{')) continue;
        const obj = parseJson(line);
        if (!obj || obj.type !== 'result' || obj.session_id !== sessionId) continue;
        return {
            cost_usd: Number.isFinite(obj.total_cost_usd) ? obj.total_cost_usd : null,
            usage: orNull(obj.usage),
            model_usage: orNull(obj.modelUsage),
            num_turns: orNull(obj.num_turns),
        };
    }
    return null;
}

function cliVersionFromTranscript(contents) {
    if (typeof contents !== 'string') return null;
    const lines = contents.split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
        const obj = parseJson(lines[i]);
        if (obj && typeof obj.version === 'string' && obj.version !== '') return obj.version;
    }
    return null;
}

// Templates que a run lê: o primeiro token de cada comando do despacho, sem a `/` (na run
// decomposta o nó é implement, mas o comando é /implement-step ou /implement-integrate).
// Sem comandos, os nós.
function promptTemplates(commands, nodes) {
    const names = (Array.isArray(commands) ? commands : [])
        .map(c => String(c).trim().split(/\s+/)[0].replace(/^\//, '')).filter(Boolean);
    return names.length ? names : nodes;
}

// Nome fora do formato de template (ex.: com `/` ou `..`) vira UNKNOWN sem ler arquivo.
function promptHashes(root, names) {
    const out = {};
    for (const name of names) {
        const file = path.join(root, '.claude', 'commands', `${name === 'fetch_ticket' ? 'fetch-ticket' : name}.md`);
        try {
            if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(name)) throw new Error('nome de template inválido');
            out[name] = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
        } catch {
            out[name] = 'UNKNOWN';
        }
    }
    return out;
}

module.exports = { cliResultJsonEnabled, parseCliResult, cliVersionFromTranscript, promptHashes, promptTemplates };
