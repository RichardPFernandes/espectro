'use strict';
// Leitor por processo (fronteira G3): o dashboard não importa scripts/lib; roda o script com
// `--json` e lê `{ ok: true, <campo> }` do stdout. Falha, saída quebrada ou campo ausente viram
// null (a rota responde UNKNOWN, nunca zero). Usado pelo effort_miss (PRI-353) e pelas flags (PRI-399).
const { execFile } = require('node:child_process');

function runJsonReader({ script, field, label, cwd, env, redact, input, maxBuffer = 1024 * 1024 }) {
    return new Promise(resolve => {
        const child = execFile(process.execPath, [script, '--json'],
            { cwd, env, timeout: 20000, maxBuffer },
            (err, stdout) => {
                let out = null;
                try { out = JSON.parse(stdout); } catch { out = null; }
                if (err || !out || out.ok !== true || out[field] == null) {
                    console.error(`[dashboard] ${label}: ${redact(out?.error || err?.message || 'sem saída')}`);
                    return resolve(null);
                }
                resolve(out[field]);
            });
        child.on('error', () => resolve(null));
        child.stdin.on('error', () => {});
        child.stdin.end(input === undefined ? undefined : JSON.stringify(input));
    });
}

module.exports = { runJsonReader };
