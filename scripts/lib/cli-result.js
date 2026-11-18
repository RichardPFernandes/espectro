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

function promptHashes(root, nodes) {
    const out = {};
    for (const node of nodes) {
        const file = path.join(root, '.claude', 'commands', `${node === 'fetch_ticket' ? 'fetch-ticket' : node}.md`);
        try {
            out[node] = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
        } catch {
            out[node] = 'UNKNOWN';
        }
    }
    return out;
}

module.exports = { cliResultJsonEnabled, parseCliResult, cliVersionFromTranscript, promptHashes };
