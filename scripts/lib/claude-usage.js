// Uso/limite da conta do Claude Code (painel Watcher do dashboard). O CLI não expõe
// isso por comando; o jeito estável é o evento `rate_limit_event` que todo
// `claude -p --output-format stream-json` emite: utilização (0-1) das janelas de 5h
// e 7 dias + horário de reset. A sondagem é uma chamada mínima (haiku, "ok", sem
// sessão salva) — gasta um pouco da própria cota, por isso só roda sob demanda e o
// resultado fica em cache (ver dashboard/server.js).
const os = require('os');
const { spawn: nodeSpawn } = require('child_process');

const DEFAULT_TIMEOUT_MS = 60000;
const PROBE_ARGS = ['-p', 'responda só ok', '--model', 'haiku', '--output-format', 'stream-json', '--verbose',
    '--no-session-persistence', '--strict-mcp-config'];

function probeEnv(configDir, env = process.env) {
    const out = {};
    for (const [k, v] of Object.entries(env)) if (!k.startsWith('CLAUDE') && k !== 'AI_AGENT') out[k] = v;
    if (configDir) out.CLAUDE_CONFIG_DIR = configDir;
    return out;
}

const toIso = sec => (Number.isFinite(sec) && sec > 0 ? new Date(sec * 1000).toISOString() : null);

// Linhas do stream-json → { ok, status, windows, ... } ou { ok: false, error }.
function parseProbeOutput(text) {
    let info = null, failure = null;
    for (const line of String(text).split('\n')) {
        if (!line.startsWith('{')) continue;
        let ev; try { ev = JSON.parse(line); } catch { continue; }
        if (ev.type === 'rate_limit_event' && ev.rate_limit_info) info = ev.rate_limit_info;
        if (ev.type === 'result' && ev.is_error) failure = String(ev.result || ev.subtype || 'erro').slice(0, 300);
    }
    if (!info) return { ok: false, error: failure || 'o CLI não devolveu rate_limit_event (conta sem login ou versão antiga do claude)' };
    const windows = {};
    for (const [name, w] of Object.entries(info.unifiedWindows || {})) {
        windows[name] = { utilization: typeof w.utilization === 'number' ? w.utilization : null, resets_at: toIso(w.resetsAt) };
    }
    if (!Object.keys(windows).length && info.rateLimitType) {
        windows[info.rateLimitType] = { utilization: info.utilization ?? null, resets_at: toIso(info.resetsAt) };
    }
    return {
        ok: true,
        status: info.status || null,               // allowed | allowed_warning | rejected
        limiting_window: info.rateLimitType || null,
        is_using_overage: !!info.isUsingOverage,
        windows,
        ...(failure ? { warning: failure } : {}),
    };
}

// Resolve sempre (nunca rejeita): { ok, ..., checked_at } ou { ok: false, error, checked_at }.
function probeUsage({ configDir = null, bin = 'claude', spawn = nodeSpawn, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    return new Promise(resolve => {
        const done = r => resolve({ ...r, checked_at: new Date().toISOString() });
        let child;
        try {
            child = spawn(bin, PROBE_ARGS, { cwd: os.tmpdir(), env: probeEnv(configDir), stdio: ['ignore', 'pipe', 'pipe'] });
        } catch (e) { return done({ ok: false, error: `não foi possível rodar ${bin}: ${e.message}` }); }
        let out = '', settled = false;
        const finish = r => { if (!settled) { settled = true; clearTimeout(timer); done(r); } };
        const timer = setTimeout(() => { try { child.kill('SIGTERM'); } catch {} finish({ ok: false, error: `timeout (${Math.round(timeoutMs / 1000)}s)` }); }, timeoutMs);
        child.stdout.on('data', d => { out += d; });
        child.stderr.on('data', () => {});
        child.on('error', e => finish({ ok: false, error: e.code === 'ENOENT' ? `${bin} não encontrado no PATH` : e.message }));
        child.on('close', () => finish(parseProbeOutput(out)));
    });
}

module.exports = { probeUsage, parseProbeOutput, probeEnv, PROBE_ARGS };
