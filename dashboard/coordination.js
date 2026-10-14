// Read-only view of coordinator-owned status and subscription capacity.
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');
const chokidar = require('chokidar');
const STATES = ['Em andamento', 'Na fila', 'Aguardando você', 'Concluído', 'Bloqueado'];
const string = v => typeof v === 'string' && v.length <= 4000;
const timestamp = v => {
    if (!string(v) || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(v) || !Number.isFinite(Date.parse(v))) return false;
    const [, year, month, day] = v.match(/^(\d{4})-(\d\d)-(\d\d)T/);
    const y = Number(year), m = Number(month), d = Number(day);
    const leap = y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0);
    const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    return m >= 1 && m <= 12 && d >= 1 && d <= days[m - 1];
};
const link = v => {
    try { return string(v) && ['https:', 'http:'].includes(new URL(v).protocol); } catch { return false; }
};
function validate(source) {
    if (!source || source.schemaVersion !== 1 || !timestamp(source.updatedAt) ||
        !Array.isArray(source.frentes) || !Array.isArray(source.tarefas) ||
        source.frentes.length > 1000 || source.tarefas.length > 10000) throw new Error('schema');
    const fronts = new Map();
    const frentes = source.frentes.map(f => {
        if (!f || !string(f.id) || !f.id || !string(f.nome) || !f.nome || fronts.has(f.id) ||
            (f.restricted !== undefined && typeof f.restricted !== 'boolean')) throw new Error('frente');
        const front = { id: f.id, nome: f.nome, restricted: f.restricted ?? false };
        fronts.set(f.id, front);
        return front;
    });
    const ids = new Set();
    const counts = Object.fromEntries(STATES.map(s => [s, 0]));
    const tarefas = source.tarefas.map(t => {
        if (!t || !string(t.id) || !t.id || ids.has(t.id) || !fronts.has(t.frente) ||
            !string(t.tarefa) || !t.tarefa || !STATES.includes(t.estado)) throw new Error('tarefa');
        ids.add(t.id);
        counts[t.estado]++;
        // frente is only the grouping key; no other task metadata escapes this boundary.
        if (fronts.get(t.frente).restricted) return { frente: t.frente, tarefa: t.tarefa, estado: t.estado };
        if (!['agente', 'runtime', 'nota'].every(k => string(t[k])) || !timestamp(t.atualizado) ||
            (t.link !== undefined && !link(t.link))) throw new Error('tarefa');
        return { id: t.id, frente: t.frente, tarefa: t.tarefa, agente: t.agente, runtime: t.runtime,
            estado: t.estado, nota: t.nota, atualizado: t.atualizado, ...(t.link !== undefined ? { link: t.link } : {}) };
    });
    return { status: 'ok', updatedAt: source.updatedAt, counts, frentes, tarefas };
}
function normalizeCapacity(rows) {
    if (!Array.isArray(rows) || rows.length > 100) throw new Error('capacity');
    const window = w => {
        if (w == null) return null;
        if (typeof w.used !== 'number' || !Number.isFinite(w.used) || w.used < 0 || w.used > 100) throw new Error('window');
        return { used: w.used };
    };
    const runtimes = rows.flatMap(r => {
        if (!r || !string(r.runtime) || !/^(codex|claude)( \([^\r\n]{1,100}\))?$/.test(r.runtime)) return [];
        // The provider marks old snapshots UNKNOWN; they are not current capacity.
        const safeWindow = input => {
            if (r.level === 'UNKNOWN') return null;
            try { return window(input); } catch { return null; }
        };
        return [{ runtime: r.runtime, five_hour: safeWindow(r.reading?.five_hour),
            seven_day: safeWindow(r.reading?.seven_day) }];
    });
    if (runtimes.length === 0) return { status: 'unavailable' };
    return { status: 'ok', runtimes };
}
// Padrão do operador: só o entrypoint de `npm start` aplica isto, depois do .env.
// Sem COORD_STATUS_PATH, a instância não observa o arquivo real do usuário.
function userCoordinationStatusPath(home = os.homedir()) {
    return path.join(home, '.maestro-guard', 'coord-status.json');
}
function applyCoordinationDefault(env, home = os.homedir()) {
    if (!env.COORD_STATUS_PATH) env.COORD_STATUS_PATH = userCoordinationStatusPath(home);
    return env.COORD_STATUS_PATH;
}
function resolveStatusPath(env) {
    if (typeof env?.COORD_STATUS_PATH === 'string' && env.COORD_STATUS_PATH) {
        return { statusPath: path.resolve(env.COORD_STATUS_PATH), ownedDir: null };
    }
    const ownedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'coord-status-'));
    return { statusPath: path.join(ownedDir, 'coord-status.json'), ownedDir };
}
function createCoordination({ env, broadcast, redact = v => v }) {
    const { statusPath, ownedDir } = resolveStatusPath(env);
    // A script path, not a shell command: fixed executable and arguments.
    const capacityScript = path.resolve(env.COORD_CAPACITY_SCRIPT || path.join(os.homedir(), 'src', 'maestro-guard', 'capacity', 'capacity.mjs'));
    let cached, expires = 0, pending;
    function capacity() {
        if (cached && Date.now() < expires) return Promise.resolve(cached);
        if (pending) return pending;
        pending = new Promise(resolve => {
            execFile(process.execPath, [capacityScript, '--json'], { timeout: 5000, maxBuffer: 256 * 1024, env }, (error, stdout) => {
                let result = { status: 'unavailable' };
                if (!error) { try { result = normalizeCapacity(JSON.parse(stdout)); } catch { /* never expose raw output */ } }
                cached = result; expires = Date.now() + 30000; resolve(result);
            });
        }).finally(() => { pending = null; });
        return pending;
    }
    async function read() {
        const base = { updatedAt: null, counts: Object.fromEntries(STATES.map(s => [s, null])), frentes: [], tarefas: [] };
        let status;
        try {
            // Bound both parse work and response size. Invalid content is never echoed.
            const stat = await fs.promises.stat(statusPath);
            if (!stat.isFile() || stat.size > 1024 * 1024) throw new Error('file');
            status = validate(JSON.parse(await fs.promises.readFile(statusPath, 'utf8')));
        } catch (e) {
            status = e.code === 'ENOENT' ? { ...base, status: 'empty' } : { ...base, status: 'invalid', message: 'Arquivo de coordenação inválido ou ilegível.' };
        }
        return redact({ ...status, capacity: await capacity() });
    }
    // Poll only this file: native FSEvents misses an initially absent file on macOS.
    // Polling also survives the producer's atomic rename without watching unrelated data.
    const watcher = chokidar.watch(statusPath, { ignoreInitial: true, usePolling: true, interval: 250,
        awaitWriteFinish: { stabilityThreshold: 150, pollInterval: 50 } });
    const ready = new Promise(resolve => { watcher.once('ready', resolve); watcher.once('error', resolve); });
    watcher.on('all', event => { if (['add', 'change', 'unlink'].includes(event)) broadcast({ type: 'coordination_update' }); });
    watcher.on('error', () => broadcast({ type: 'coordination_update' }));
    return {
        read, ready, statusPath,
        close: async () => {
            await watcher.close();
            if (ownedDir) await fs.promises.rm(ownedDir, { recursive: true, force: true });
        },
    };
}
module.exports = { createCoordination, STATES, userCoordinationStatusPath, applyCoordinationDefault };
